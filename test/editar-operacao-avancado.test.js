// ─── test/editar-operacao-avancado.test.js ──────────────────────────────────
// Cobertura de POST /editar-operacao-avancado e GET /pausas-operacao/:id
// (ver lib/rotas/edicao.js) — "Edições avançadas" no modal de Editar
// Operação (Registro de Bateria): corrige início/fim/pausas de uma
// operação já registrada, campos que POST /editar-operacao (ver
// test/edicao-operacao-traco.test.js) propositalmente PROTEGE e recusa
// editar. Checagem de permissão (403) já coberta em
// test/permissoes-por-area.test.js — aqui é só o caminho feliz e as
// validações específicas desta rota.
//
// Roda contra o server.js DE VERDADE, numa cópia isolada — mesmo padrão de
// edicao-operacao-traco.test.js. Cobre:
//   - Recalcula tempo_min/houve_atraso corretamente (bruto - pausas),
//     inclusive cruzando o limite de atraso (59min) pra "SIM"/"NÃO".
//   - Grava as pausas em pausas_operacao — visíveis via
//     GET /pausas-operacao/:id, na ordem certa.
//   - Reescreve (não acumula) as pausas a cada chamada — 2ª chamada com
//     lista diferente substitui a 1ª por completo, não soma.
//   - fim <= início é recusado (400).
//   - Pausa fora da janela [início, fim] é recusada (400).
//   - Pausas sobrepostas são recusadas (400).
//   - Pausa sem justificativa é recusada (400).
//   - "diff" vazio e id inexistente são recusados (400), mesmo padrão de
//     /editar-operacao.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-edicao-avancada-829';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let cookie;

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
  cookie = (resp.headers.get('set-cookie') || '').split(';')[0];
});

after(async () => {
  await servidor.parar();
});

function registrarOperacao(idOp, extras = {}) {
  return fetch(`${servidor.baseUrl}/registrar-operacao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: idOp, data: '2026-07-20', turno: '1° TURNO', dimensao: 9, capacidade: 20,
      id_bateria: 'B-original', inicio: '2026-07-20T08:00:00.000Z', fim: '2026-07-20T09:00:00.000Z',
      tempo_min: 60, qtd_tracos: 3, total_paineis: 40, m2_total: 88.8,
      ...extras,
    }),
  });
}

function editarAvancado(payload) {
  return fetch(`${servidor.baseUrl}/editar-operacao-avancado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(payload),
  });
}

async function buscarOperacao(idOp) {
  const resp = await fetch(`${servidor.baseUrl}/db/historico.json`);
  const historico = await resp.json();
  return historico.find(o => o.id === idOp);
}

function buscarPausas(idOp) {
  return fetch(`${servidor.baseUrl}/pausas-operacao/${idOp}`, { headers: { Cookie: cookie } })
    .then(r => r.json());
}

// ═══════════════════════════════ CAMINHO FELIZ ══════════════════════════════

test('editar-operacao-avancado: recalcula tempo_min/houve_atraso descontando pausas, e grava as pausas', async () => {
  const idOp = 'op-avancado-feliz-' + Date.now();
  await registrarOperacao(idOp);

  // Janela de 08:00 às 09:30 (90min brutos), com 1 pausa de 20min no meio
  // -> líquido = 70min, acima do limite de 59min -> deveria dar atraso.
  const resp = await editarAvancado({
    id: idOp,
    inicio: '2026-07-20T08:00:00.000Z',
    fim: '2026-07-20T09:30:00.000Z',
    pausas: [
      { pausado_em: '2026-07-20T08:30:00.000Z', retomado_em: '2026-07-20T08:50:00.000Z', motivo: 'Falta de material' },
    ],
    diff: [{ campo: 'inicio', de: 'x', para: 'y' }],
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
  assert.equal(data.tempo_min, 70);
  assert.equal(data.houve_atraso, 'SIM');

  const salva = await buscarOperacao(idOp);
  assert.equal(salva.inicio, '2026-07-20T08:00:00.000Z');
  assert.equal(salva.fim, '2026-07-20T09:30:00.000Z');
  assert.equal(salva.tempo_min, 70);
  assert.equal(salva.houve_atraso, 'SIM');

  const pausas = await buscarPausas(idOp);
  assert.equal(pausas.ok, true);
  assert.equal(pausas.pausas.length, 1);
  assert.equal(pausas.pausas[0].motivo, 'Falta de material');
  assert.equal(pausas.pausas[0].pausado_em, '2026-07-20T08:30:00.000Z');
  assert.equal(pausas.pausas[0].retomado_em, '2026-07-20T08:50:00.000Z');
});

test('editar-operacao-avancado: sem pausas, tempo líquido = bruto, e "NÃO" quando abaixo do limite', async () => {
  const idOp = 'op-avancado-sem-pausa-' + Date.now();
  await registrarOperacao(idOp);

  const resp = await editarAvancado({
    id: idOp,
    inicio: '2026-07-20T08:00:00.000Z',
    fim: '2026-07-20T08:40:00.000Z', // 40min, abaixo do limite de 59
    pausas: [],
    diff: [{ campo: 'fim', de: 'x', para: 'y' }],
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.tempo_min, 40);
  assert.equal(data.houve_atraso, 'NÃO');

  const pausas = await buscarPausas(idOp);
  assert.equal(pausas.pausas.length, 0);
});

test('editar-operacao-avancado: uma 2ª chamada REESCREVE as pausas, não acumula', async () => {
  const idOp = 'op-avancado-reescreve-' + Date.now();
  await registrarOperacao(idOp);

  await editarAvancado({
    id: idOp,
    inicio: '2026-07-20T08:00:00.000Z',
    fim: '2026-07-20T09:00:00.000Z',
    pausas: [
      { pausado_em: '2026-07-20T08:10:00.000Z', retomado_em: '2026-07-20T08:20:00.000Z', motivo: 'Primeira pausa' },
    ],
    diff: [{ campo: 'inicio', de: 'x', para: 'y' }],
  });

  await editarAvancado({
    id: idOp,
    inicio: '2026-07-20T08:00:00.000Z',
    fim: '2026-07-20T09:00:00.000Z',
    pausas: [
      { pausado_em: '2026-07-20T08:30:00.000Z', retomado_em: '2026-07-20T08:40:00.000Z', motivo: 'Pausa substituta' },
    ],
    diff: [{ campo: 'inicio', de: 'x', para: 'y' }],
  });

  const pausas = await buscarPausas(idOp);
  assert.equal(pausas.pausas.length, 1, 'deveria ter substituído a lista inteira, não somado');
  assert.equal(pausas.pausas[0].motivo, 'Pausa substituta');
});

// ═══════════════════════════════ VALIDAÇÕES ═════════════════════════════════

test('editar-operacao-avancado: fim <= início é recusado (400)', async () => {
  const idOp = 'op-avancado-fim-antes-' + Date.now();
  await registrarOperacao(idOp);

  const resp = await editarAvancado({
    id: idOp,
    inicio: '2026-07-20T09:00:00.000Z',
    fim: '2026-07-20T08:00:00.000Z',
    pausas: [],
    diff: [{ campo: 'inicio', de: 'x', para: 'y' }],
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /fim.*depois.*início/i);
});

test('editar-operacao-avancado: pausa fora da janela [início, fim] é recusada (400)', async () => {
  const idOp = 'op-avancado-pausa-fora-' + Date.now();
  await registrarOperacao(idOp);

  const resp = await editarAvancado({
    id: idOp,
    inicio: '2026-07-20T08:00:00.000Z',
    fim: '2026-07-20T09:00:00.000Z',
    pausas: [
      // retomado_em (09:30) depois do fim da operação (09:00)
      { pausado_em: '2026-07-20T08:30:00.000Z', retomado_em: '2026-07-20T09:30:00.000Z', motivo: 'Fora da janela' },
    ],
    diff: [{ campo: 'inicio', de: 'x', para: 'y' }],
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /janela/i);
});

test('editar-operacao-avancado: pausas sobrepostas são recusadas (400)', async () => {
  const idOp = 'op-avancado-sobreposicao-' + Date.now();
  await registrarOperacao(idOp);

  const resp = await editarAvancado({
    id: idOp,
    inicio: '2026-07-20T08:00:00.000Z',
    fim: '2026-07-20T09:00:00.000Z',
    pausas: [
      { pausado_em: '2026-07-20T08:10:00.000Z', retomado_em: '2026-07-20T08:30:00.000Z', motivo: 'Primeira' },
      { pausado_em: '2026-07-20T08:20:00.000Z', retomado_em: '2026-07-20T08:40:00.000Z', motivo: 'Sobrepõe a primeira' },
    ],
    diff: [{ campo: 'inicio', de: 'x', para: 'y' }],
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /sobrepor/i);
});

test('editar-operacao-avancado: pausa sem justificativa é recusada (400)', async () => {
  const idOp = 'op-avancado-sem-motivo-' + Date.now();
  await registrarOperacao(idOp);

  const resp = await editarAvancado({
    id: idOp,
    inicio: '2026-07-20T08:00:00.000Z',
    fim: '2026-07-20T09:00:00.000Z',
    pausas: [
      { pausado_em: '2026-07-20T08:10:00.000Z', retomado_em: '2026-07-20T08:30:00.000Z', motivo: '   ' },
    ],
    diff: [{ campo: 'inicio', de: 'x', para: 'y' }],
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /justificativa/i);
});

test('editar-operacao-avancado: "diff" vazio é recusado (400)', async () => {
  const idOp = 'op-avancado-diff-vazio-' + Date.now();
  await registrarOperacao(idOp);

  const resp = await editarAvancado({
    id: idOp,
    inicio: '2026-07-20T08:00:00.000Z',
    fim: '2026-07-20T09:00:00.000Z',
    pausas: [],
    diff: [],
  });
  assert.equal(resp.status, 400);
});

test('editar-operacao-avancado: id inexistente é recusado (400)', async () => {
  const resp = await editarAvancado({
    id: 'op-avancado-nao-existe-' + Date.now(),
    inicio: '2026-07-20T08:00:00.000Z',
    fim: '2026-07-20T09:00:00.000Z',
    pausas: [],
    diff: [{ campo: 'inicio', de: 'x', para: 'y' }],
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /não encontrada/);
});
