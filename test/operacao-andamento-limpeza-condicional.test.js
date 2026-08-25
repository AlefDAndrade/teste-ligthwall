// ─── test/operacao-andamento-limpeza-condicional.test.js ────────────────────
// Testa o cenário: rede caiu bem na hora de encerrar a operação. O aviso
// "melhor esforço" de que operacao_andamento.json podia ser limpo nunca saiu
// do dispositivo (sem conexão), mas a operação em si foi registrada
// normalmente quando a conexão voltou (via fila offline — ver
// LW.enfileirarOperacaoPendente/tentarSincronizarFilaPendentes, data.js).
// Sem uma correção, operacao_andamento.json ficava com o snapshot ANTIGO
// pra sempre, mesmo já registrada — outras telas/TV continuavam mostrando a
// operação como em andamento.
//
// Correção: toda operação em andamento carrega um `idAndamento` próprio
// (gerado no cliente ao iniciar — ver iniciarInjecao(), operacao.js), que
// viaja em todo POST /salvar-operacao-andamento enquanto ela roda. Ao
// reenviar tardiamente o aviso de "acabou" (LW.finalizarOperacaoAndamento,
// data.js), o cliente manda esse mesmo idAndamento junto do dados:null. O
// servidor só limpa de verdade se o que estiver em operacao_andamento.json
// AGORA ainda for essa mesma operação — protege contra apagar por engano
// uma operação NOVA e legítima que tenha começado no lugar nesse meio-tempo
// (inclusive do mesmo dispositivo).
//
// Mesmo padrão HTTP puro (sem jsdom) de test/permissao-controlar-operacao.test.js.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-limpeza-cond-andamento-951';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let cookieAdmin;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
  });
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  const setCookie = resp.headers.get('set-cookie') || '';
  cookieAdmin = setCookie.split(';')[0];
});

after(async () => {
  await servidor.parar();
});

async function salvarAndamento(dados, extra = {}) {
  return fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ dados, clientId: 'cli-teste', ...extra }),
  });
}

async function lerAndamentoAtual() {
  const resp = await fetch(`${servidor.baseUrl}/db/operacao_andamento.json?_=${Date.now()}`);
  if (resp.status === 404) return null;
  return resp.json();
}

// Cada teste começa do zero — limpa qualquer operação deixada pelo teste anterior.
beforeEach(async () => {
  await salvarAndamento(null, { forcar: true });
});

test('limpeza (dados:null) SEM idAndamento continua funcionando como antes (compatibilidade)', async () => {
  await salvarAndamento({ status: 'running', id_bateria: 'B1' });
  assert.ok(await lerAndamentoAtual(), 'pré-condição: deveria ter uma operação em andamento');

  const resp = await salvarAndamento(null);
  assert.equal(resp.status, 200);
  assert.equal(await lerAndamentoAtual(), null, 'sem idAndamento, dados:null deveria limpar do jeito antigo, sem restrição');
});

test('limpeza com idAndamento que BATE com o que está em andamento limpa normalmente', async () => {
  await salvarAndamento({ status: 'running', id_bateria: 'B2', idAndamento: 'and_123' });
  const atual = await lerAndamentoAtual();
  assert.equal(atual.idAndamento, 'and_123', 'pré-condição: idAndamento deveria ter sido salvo junto do resto dos dados');

  const resp = await salvarAndamento(null, { idAndamento: 'and_123' });
  const json = await resp.json();
  assert.equal(resp.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.ignorado, undefined, 'deveria ter limpado de verdade, não ignorado');
  assert.equal(await lerAndamentoAtual(), null, 'a operação deveria ter sido limpa — idAndamento bateu');
});

test('limpeza com idAndamento DIFERENTE do que está em andamento NÃO mexe em nada (protege operação nova)', async () => {
  // Operação NOVA e legítima já em andamento (id diferente da que está
  // tentando avisar tardiamente que terminou).
  await salvarAndamento({ status: 'running', id_bateria: 'B3-NOVA', idAndamento: 'and_novo' });

  // Aviso tardio de uma operação ANTIGA (já registrada em outro lugar,
  // ver cenário do bug) tentando limpar — não deveria afetar a nova.
  const resp = await salvarAndamento(null, { idAndamento: 'and_velho' });
  const json = await resp.json();
  assert.equal(resp.status, 200, 'não deveria dar erro/403 — só devia ser ignorado silenciosamente');
  assert.equal(json.ok, true);
  assert.equal(json.ignorado, true, 'deveria ter sido explicitamente ignorado, por não bater o idAndamento');

  const atual = await lerAndamentoAtual();
  assert.ok(atual, 'a operação NOVA não deveria ter sido apagada');
  assert.equal(atual.idAndamento, 'and_novo', 'a operação em andamento deveria continuar sendo a nova, intacta');
  assert.equal(atual.id_bateria, 'B3-NOVA');
});

test('limpeza com idAndamento quando já não há nenhuma operação em andamento é um no-op silencioso (ok)', async () => {
  assert.equal(await lerAndamentoAtual(), null, 'pré-condição: nada em andamento');

  const resp = await salvarAndamento(null, { idAndamento: 'and_qualquer' });
  const json = await resp.json();
  assert.equal(resp.status, 200);
  assert.equal(json.ok, true);
  assert.equal(await lerAndamentoAtual(), null);
});

test('idAndamento não interfere na revisão nem no fluxo normal de update (não-limpeza)', async () => {
  const resp = await salvarAndamento({ status: 'running', id_bateria: 'B4', idAndamento: 'and_456' });
  assert.equal(resp.status, 200);
  const json = await resp.json();
  assert.equal(typeof json.revisao, 'number');

  const atual = await lerAndamentoAtual();
  assert.equal(atual.id_bateria, 'B4');
  assert.equal(atual.idAndamento, 'and_456', 'idAndamento deveria ter sido persistido junto com o resto do estado');
});
