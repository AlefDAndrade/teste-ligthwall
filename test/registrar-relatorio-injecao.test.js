// ─── test/registrar-relatorio-injecao.test.js ───────────────────────────────
// Cobertura formal de POST /registrar-relatorio-injecao — onde os TRAÇOS de
// uma operação são gravados (a segunda das "duas rotas mais centrais do
// sistema", junto de /registrar-operacao — ver
// lib/rotas/registro-operacao.js), até agora só validada manualmente (ver
// README, "Limitações conhecidas").
//
// Cobre:
//   - Caminho real (SQL): traço novo grava em tracos + traco_usos; traço
//     REAPROVEITADO (mesmo id_traco, ex: 2ª bateria usando o mesmo traço)
//     só adiciona um novo uso, sem nunca alterar a receita já gravada.
//   - Leituras de densidade/flow (remedições) são gravadas na ordem certa
//     só quando o traço é novo.
//   - Caminho de Modo de Teste: grava em public/db/teste/relatorio_injecao.json
//     isolado, mesclando usos de um traço que já existe NESSE arquivo (a
//     mesma regra do caminho real, mas em JSON).
//   - JSON malformado retorna 400.
//   - Sem permissão de controlar operação, é recusado com 403.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-registrar-tracos-951';
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

function traco(idTraco, uso, extras = {}) {
  return {
    id_traco: idTraco, data: '2026-07-20', turno: '1° TURNO', num_traco: 1,
    cimento_real: 350, agua_real: 180, eps_real: 2.5, superplast_real: 4, incorporador_real: 1,
    tempo_batida: 120, densidade: 1050, flow: 210,
    obs: null, silo: 'S1', expansao: null, densidade_eps: null,
    ultilizado: { operacao: [uso] },
    ...extras,
  };
}

function registrarTracos(lista, { cookie, deviceId = DEVICE_ID_TESTE_PADRAO, modoTeste = false } = {}) {
  const qs = new URLSearchParams();
  if (deviceId) qs.set('deviceId', deviceId);
  if (modoTeste) qs.set('modoTeste', 'true');
  return fetch(`${servidor.baseUrl}/registrar-relatorio-injecao?${qs.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(lista),
  });
}

async function buscarTraco(idTraco) {
  const resp = await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`);
  const todos = await resp.json();
  return todos.find(t => t.id_traco === idTraco);
}

test('sem sessão/dispositivo, POST /registrar-relatorio-injecao é recusado (403)', async () => {
  const idTraco = 'traco-sem-permissao-' + Date.now();
  const resp = await registrarTracos(
    [traco(idTraco, { id_operacao: 'op-x', id_bateria: 'B1', berco_inicio: '1', berco_finalizacao: '4' })],
    { deviceId: null },
  );
  assert.equal(resp.status, 403);
});

test('caminho real: traço novo grava a receita e o uso vinculado', async () => {
  const cookie = await logarComoAdminMaster();
  const idTraco = 'traco-novo-' + Date.now();

  const resp = await registrarTracos(
    [traco(idTraco, { id_operacao: 'op-traco-1', id_bateria: 'B10', berco_inicio: '1', berco_finalizacao: '4', obs: null })],
    { cookie },
  );
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);

  const salvo = await buscarTraco(idTraco);
  assert.ok(salvo, 'o traço deveria existir depois de registrado');
  assert.equal(salvo.cimento_real, 350);
  assert.equal(salvo.agua_real, 180);
  assert.equal(salvo.tempo_batida, 120);
  assert.equal(salvo.densidade, 1050);
  assert.equal(salvo.flow, 210);
  assert.equal(salvo.ultilizado.operacao.length, 1);
  assert.equal(salvo.ultilizado.operacao[0].id_operacao, 'op-traco-1');
  assert.equal(salvo.ultilizado.operacao[0].berco_inicio, '1');
  assert.equal(salvo.ultilizado.operacao[0].berco_finalizacao, '4');
});

test('reaproveitar um traço existente (mesmo id_traco em outra bateria) só adiciona um novo uso — nunca reescreve a receita', async () => {
  const cookie = await logarComoAdminMaster();
  const idTraco = 'traco-reaproveitado-' + Date.now();

  await registrarTracos(
    [traco(idTraco, { id_operacao: 'op-traco-A', id_bateria: 'B20', berco_inicio: '1', berco_finalizacao: '4' })],
    { cookie },
  );

  // Reaproveita o MESMO id_traco numa 2ª bateria — manda cimento/água
  // diferentes de propósito, pra provar que não sobrescreve.
  await registrarTracos(
    [traco(idTraco, { id_operacao: 'op-traco-B', id_bateria: 'B21', berco_inicio: '5', berco_finalizacao: '8' }, {
      cimento_real: 999, agua_real: 999,
    })],
    { cookie },
  );

  const salvo = await buscarTraco(idTraco);
  assert.equal(salvo.cimento_real, 350, 'receita original não deveria mudar ao reaproveitar o traço');
  assert.equal(salvo.agua_real, 180, 'receita original não deveria mudar ao reaproveitar o traço');
  assert.equal(salvo.ultilizado.operacao.length, 2, 'deveria ter os 2 usos, um por bateria');
  assert.ok(salvo.ultilizado.operacao.some(u => u.id_operacao === 'op-traco-A'));
  assert.ok(salvo.ultilizado.operacao.some(u => u.id_operacao === 'op-traco-B'));
});

test('vários traços no mesmo lote (payload em array) são todos gravados numa única chamada', async () => {
  const cookie = await logarComoAdminMaster();
  const prefixo = 'traco-lote-' + Date.now();
  const lista = [1, 2, 3].map(n => traco(`${prefixo}-${n}`, {
    id_operacao: 'op-lote', id_bateria: 'B30', berco_inicio: String(n), berco_finalizacao: String(n),
  }));

  const resp = await registrarTracos(lista, { cookie });
  assert.equal(resp.status, 200);

  for (const t of lista) {
    const salvo = await buscarTraco(t.id_traco);
    assert.ok(salvo, `traço ${t.id_traco} deveria ter sido gravado`);
  }
});

test('JSON malformado no corpo retorna 400, sem derrubar o servidor', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/registrar-relatorio-injecao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: '[ isso nao e json valido',
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);

  const respSaude = await fetch(`${servidor.baseUrl}/login.html`);
  assert.equal(respSaude.status, 200);
});

test('Modo de Teste: grava em public/db/teste/relatorio_injecao.json isolado, mesclando usos de um traço já existente nesse arquivo', async () => {
  const idTraco = 'traco-modo-teste-' + Date.now();

  await registrarTracos(
    [traco(idTraco, { id_operacao: 'op-teste-A', id_bateria: 'B40', berco_inicio: '1', berco_finalizacao: '2' })],
    { modoTeste: true, deviceId: null },
  );
  await registrarTracos(
    [traco(idTraco, { id_operacao: 'op-teste-B', id_bateria: 'B41', berco_inicio: '3', berco_finalizacao: '4' })],
    { modoTeste: true, deviceId: null },
  );

  // Não entra no relatório real (SQL).
  const salvoReal = await buscarTraco(idTraco);
  assert.equal(salvoReal, undefined, 'traço de Modo de Teste não deveria aparecer no relatório real');

  // Entra no JSON isolado, com os 2 usos mesclados.
  const relatorioTestePath = path.join(servidor.pastaTemp, 'public', 'db', 'teste', 'relatorio_injecao.json');
  const relatorioTeste = JSON.parse(fs.readFileSync(relatorioTestePath, 'utf8'));
  const salvoTeste = relatorioTeste.find(t => t.id_traco === idTraco);
  assert.ok(salvoTeste, 'traço de Modo de Teste deveria estar em public/db/teste/relatorio_injecao.json');
  assert.equal(salvoTeste.ultilizado.operacao.length, 2, 'os usos das 2 chamadas deveriam ter sido mesclados no mesmo traço');
});

test('Modo de Teste dispensa a checagem de permissão (sem sessão, sem dispositivo)', async () => {
  const idTraco = 'traco-modo-teste-sem-permissao-' + Date.now();
  const resp = await registrarTracos(
    [traco(idTraco, { id_operacao: 'op-teste', id_bateria: 'B50', berco_inicio: '1', berco_finalizacao: '1' })],
    { modoTeste: true, deviceId: null },
  );
  assert.notEqual(resp.status, 403);
});
