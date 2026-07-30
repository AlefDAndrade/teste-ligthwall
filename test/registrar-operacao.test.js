// ─── test/registrar-operacao.test.js ────────────────────────────────────────
// Cobertura formal de POST /registrar-operacao — a rota mais central do
// sistema (é aqui que uma operação de verdade nasce), até agora só validada
// manualmente (via chamadas HTTP reais a cada mudança — ver README,
// "Limitações conhecidas").
//
// Roda contra o server.js DE VERDADE (não um mock), numa cópia isolada —
// ver test/helpers/servidor-teste.js. Cobre:
//   - Caminho real (SQL): grava em "operacoes", cria os berços visuais
//     iniciais, entra na fila de avaliação do Setor de Qualidade.
//   - avaliado é sempre forçado a false na criação, mesmo que o payload
//     tente mandar true (ver comentário em lib/rotas/registro-operacao.js).
//   - Berços reais (parciais) têm prioridade sobre a capacidade nominal na
//     hora de decidir quantos berços visuais criar.
//   - Caminho de Modo de Teste: grava em public/db/teste/historico.json
//     isolado, nunca toca na tabela SQL nem no histórico real.
//   - JSON malformado no corpo do request retorna 400 (sem derrubar o
//     servidor).
//   - Sem permissão de controlar operação, é recusado com 403 (a fundo em
//     test/permissao-controlar-operacao.test.js — aqui só a checagem básica).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-registrar-operacao-753';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
  });
});

after(async () => {
  await servidor.parar();
});

function extrairCookie(resposta) {
  const setCookie = resposta.headers.get('set-cookie') || '';
  return setCookie.split(';')[0] || null;
}

async function logarComoAdminMaster() {
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  return extrairCookie(resp);
}

function registrar(idOp, extras = {}, { cookie, deviceId = DEVICE_ID_TESTE_PADRAO, modoTeste = false } = {}) {
  const qs = new URLSearchParams();
  if (deviceId) qs.set('deviceId', deviceId);
  if (modoTeste) qs.set('modoTeste', 'true');
  return fetch(`${servidor.baseUrl}/registrar-operacao?${qs.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({
      id: idOp, data: '2026-07-20', turno: '1° TURNO', dimensao: 9, capacidade: 20,
      id_bateria: 'B-teste', inicio: '2026-07-20T08:00:00.000Z', fim: '2026-07-20T09:00:00.000Z',
      tempo_min: 60, qtd_tracos: 3, total_paineis: 40, m2_total: 88.8,
      ...extras,
    }),
  });
}

async function buscarOperacaoNoHistorico(idOp) {
  const resp = await fetch(`${servidor.baseUrl}/db/historico.json`);
  const historico = await resp.json();
  return historico.find(o => o.id === idOp);
}

test('sem sessão/dispositivo, POST /registrar-operacao é recusado (403)', async () => {
  const resp = await registrar('op-sem-permissao-' + Date.now(), {}, { deviceId: null });
  assert.equal(resp.status, 403);
});

test('caminho real: grava a operação e ela aparece em GET /db/historico.json', async () => {
  const cookie = await logarComoAdminMaster();
  const idOp = 'op-real-' + Date.now();

  const resp = await registrar(idOp, {}, { cookie });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);

  const salva = await buscarOperacaoNoHistorico(idOp);
  assert.ok(salva, 'a operação deveria estar no histórico depois de registrada');
  assert.equal(salva.id_bateria, 'B-teste');
  assert.equal(salva.qtd_tracos, 3);
  assert.equal(salva.total_paineis, 40);
});

test('avaliado é sempre forçado a false na criação, mesmo que o payload tente mandar true', async () => {
  const cookie = await logarComoAdminMaster();
  const idOp = 'op-avaliado-forcado-' + Date.now();

  await registrar(idOp, { avaliado: true }, { cookie });

  const salva = await buscarOperacaoNoHistorico(idOp);
  assert.equal(salva.avaliado, false, 'quem decide "avaliada" é a tabela operacoes_avaliadas, não o payload de criação');
});

test('cria berços visuais iniciais — usa bercos_reais (operação parcial) quando informado, não a capacidade nominal', async () => {
  const cookie = await logarComoAdminMaster();
  const idOp = 'op-bercos-parciais-' + Date.now();

  await registrar(idOp, { capacidade: 20, bercos_reais: 12 }, { cookie });

  const resp = await fetch(`${servidor.baseUrl}/db/bercos_visuais.json`);
  const todos = await resp.json();
  const doOperacao = todos.find(b => b.id_operacao === idOp);
  assert.ok(doOperacao, 'deveria existir 1 linha de bercos_visuais pra essa operação');
  assert.equal(doOperacao.bercos.length, 12, 'deveria usar bercos_reais (12), não a capacidade nominal (20)');
  assert.ok(doOperacao.bercos.every(b => b.estado_esquerda === 'okay' && b.estado_direita === 'okay'));
});

test('cai pra capacidade nominal quando bercos_reais não é informado', async () => {
  const cookie = await logarComoAdminMaster();
  const idOp = 'op-bercos-capacidade-' + Date.now();

  await registrar(idOp, { capacidade: 16, bercos_reais: undefined }, { cookie });

  const resp = await fetch(`${servidor.baseUrl}/db/bercos_visuais.json`);
  const todos = await resp.json();
  const doOperacao = todos.find(b => b.id_operacao === idOp);
  assert.equal(doOperacao.bercos.length, 16);
});

test('a nova operação entra na fila de avaliação do Setor de Qualidade (GET /operacoes-nao-avaliadas)', async () => {
  const cookie = await logarComoAdminMaster();
  const idOp = 'op-fila-qualidade-' + Date.now();

  await registrar(idOp, {}, { cookie });

  const resp = await fetch(`${servidor.baseUrl}/operacoes-nao-avaliadas`);
  const fila = await resp.json();
  assert.ok(fila.some(o => o.id === idOp), 'a operação recém-registrada deveria estar na fila de não avaliadas');
});

test('JSON malformado no corpo retorna 400, sem derrubar o servidor', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/registrar-operacao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: '{ isso nao e json valido',
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);

  // Prova que o servidor continua vivo e funcional depois do erro.
  const respSaude = await fetch(`${servidor.baseUrl}/login.html`);
  assert.equal(respSaude.status, 200);
});

test('Modo de Teste: grava em public/db/teste/historico.json isolado — nunca na tabela SQL real', async () => {
  const idOp = 'op-modo-teste-isolado-' + Date.now();

  const resp = await registrar(idOp, {}, { modoTeste: true, deviceId: null });
  assert.equal(resp.status, 200);

  // Não entra no histórico real (SQL).
  const salvaReal = await buscarOperacaoNoHistorico(idOp);
  assert.equal(salvaReal, undefined, 'operação de Modo de Teste não deveria aparecer no histórico real');

  // Entra no JSON isolado, em disco.
  const historicoTestePath = path.join(servidor.pastaTemp, 'public', 'db', 'teste', 'historico.json');
  const historicoTeste = JSON.parse(fs.readFileSync(historicoTestePath, 'utf8'));
  assert.ok(historicoTeste.some(o => o.id === idOp), 'operação de Modo de Teste deveria estar em public/db/teste/historico.json');

  // Também não deveria ter criado berços visuais reais nem entrado na
  // fila de avaliação real — Modo de Teste não toca em nada disso.
  const respBercos = await fetch(`${servidor.baseUrl}/db/bercos_visuais.json`);
  const bercos = await respBercos.json();
  assert.ok(!bercos.some(b => b.id_operacao === idOp));

  const respFila = await fetch(`${servidor.baseUrl}/operacoes-nao-avaliadas`);
  const fila = await respFila.json();
  assert.ok(!fila.some(o => o.id === idOp));
});

test('Modo de Teste dispensa a checagem de permissão (sem sessão, sem dispositivo)', async () => {
  const resp = await registrar('op-modo-teste-sem-permissao-' + Date.now(), {}, { modoTeste: true, deviceId: null });
  assert.notEqual(resp.status, 403);
});
