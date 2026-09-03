// ─── test/consulta-tracos-ordem-insercao.test.js ────────────────────────────
// Consulta de Insumos por Traço (public/js/consulta-tracos.js) calcula
// "Ordem no Dia" (_comOrdemDoDia) assumindo que db/relatorio_injecao.json
// devolve os traços na ORDEM DE INSERÇÃO — a tabela "tracos" não tem
// nenhum ORDER BY na query que gera esse JSON (ver todosOsTracos(),
// lib/db/tracos.js), então volta na ordem natural do SQLite (rowid), que
// é a ordem em que os traços foram registrados de verdade. Este teste
// trava essa premissa no nível do backend/API: registra 3 traços em
// sequência conhecida e confere que GET /db/relatorio_injecao.json
// devolve na mesma ordem.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-consulta-tracos-ordem-753';
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

function traco(idTraco, numTraco, idOperacao) {
  return {
    id_traco: idTraco, data: '2026-09-04', turno: '1° TURNO', num_traco: numTraco,
    cimento_real: 300, agua_real: 120, eps_real: 8, superplast_real: 3.5, incorporador_real: 1.2,
    tempo_batida: 120, densidade: 1050, flow: 210,
    obs: null, silo: 'S1', expansao: null, densidade_eps: null,
    ultilizado: { operacao: [{ id_operacao: idOperacao, id_bateria: 'B-consulta', berco_inicio: '1', berco_finalizacao: '4' }] },
  };
}

async function registrarTraco(t, cookie) {
  const qs = new URLSearchParams({ deviceId: DEVICE_ID_TESTE_PADRAO });
  const resp = await fetch(`${servidor.baseUrl}/registrar-relatorio-injecao?${qs.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify([t]),
  });
  assert.equal(resp.status, 200, `falha ao registrar ${t.id_traco}: ${await resp.text()}`);
}

test('GET /db/relatorio_injecao.json devolve os traços na ordem em que foram registrados (premissa da "Ordem no Dia")', async () => {
  const cookie = await logarComoAdminMaster();
  const sufixo = Date.now();
  const idOp = 'op-consulta-tracos-' + sufixo;

  // Registrados em sequência conhecida, um de cada vez (não em lote) —
  // simula 3 traços produzidos um após o outro no mesmo dia.
  const idA = 'consulta-traco-A-' + sufixo;
  const idB = 'consulta-traco-B-' + sufixo;
  const idC = 'consulta-traco-C-' + sufixo;
  await registrarTraco(traco(idA, 1, idOp), cookie);
  await registrarTraco(traco(idB, 2, idOp), cookie);
  await registrarTraco(traco(idC, 3, idOp), cookie);

  const resp = await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`);
  const todos = await resp.json();

  const indiceA = todos.findIndex(t => t.id_traco === idA);
  const indiceB = todos.findIndex(t => t.id_traco === idB);
  const indiceC = todos.findIndex(t => t.id_traco === idC);

  assert.ok(indiceA >= 0 && indiceB >= 0 && indiceC >= 0, 'esperava os 3 traços registrados na resposta');
  assert.ok(indiceA < indiceB, 'traço A (registrado 1º) deveria vir antes do B (2º)');
  assert.ok(indiceB < indiceC, 'traço B (registrado 2º) deveria vir antes do C (3º)');
});

test('traços do mesmo dia, de operações diferentes, também respeitam a ordem de registro (não só dentro da mesma operação)', async () => {
  const cookie = await logarComoAdminMaster();
  const sufixo = Date.now() + '-b';
  const idOp1 = 'op-consulta-tracos-1-' + sufixo;
  const idOp2 = 'op-consulta-tracos-2-' + sufixo;

  const idX = 'consulta-traco-X-' + sufixo;
  const idY = 'consulta-traco-Y-' + sufixo;
  await registrarTraco(traco(idX, 1, idOp1), cookie);
  await registrarTraco(traco(idY, 1, idOp2), cookie); // outra operação, mesmo dia, registrada depois

  const resp = await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`);
  const todos = await resp.json();
  const indiceX = todos.findIndex(t => t.id_traco === idX);
  const indiceY = todos.findIndex(t => t.id_traco === idY);
  assert.ok(indiceX < indiceY, 'traço X (registrado 1º, outra operação) deveria vir antes do Y (2º)');
});
