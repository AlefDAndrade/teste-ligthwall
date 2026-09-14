// ─── test/insumos-dinamicos-fase3.test.js ───────────────────────────────────
// Fase 3 de "Insumos de Receitas dinâmicos no formulário de traço" (ver
// PLANO-insumos-dinamicos-receitas.md) — rotas gravando/lendo insumos
// CUSTOM (`insumos_custom` no payload), além do que a Fase 2 já cobriu
// via restaurar/mesclar backup.
//
// Cobre:
//   1. POST /registrar-relatorio-injecao: um traço novo com insumos_custom
//      grava em traco_insumos e aparece em GET /db/relatorio_injecao.json.
//   2. POST /registrar-ajuste-traco: um ajuste ao vivo com insumos_custom
//      grava em ajuste_insumos e aparece tanto no traço final quanto em
//      GET /db/ajustes_tracos.json.
//   3. POST /editar-traco-relatorio: substitui os insumos_custom
//      "originais" e os de cada ajuste (apaga + regrava, mesmo padrão dos
//      5 Padrão) — inclusive REMOVER um insumo custom que existia antes.
//   4. Reaproveitar um traço existente (2º uso) NUNCA reescreve os
//      insumos_custom já gravados (mesma regra dos 5 Padrão).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-insumos-fase3-406';
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

function traco(idTraco, uso, extras = {}) {
  return {
    id_traco: idTraco, data: '2026-08-10', turno: '1° TURNO', num_traco: 1,
    cimento_real: 350, agua_real: 180, eps_real: 2.5, superplast_real: 4, incorporador_real: 1,
    tempo_batida: 120, densidade: 1050, flow: 210,
    obs: null, silo: 'S1', expansao: null, densidade_eps: null,
    ultilizado: { operacao: [uso] },
    ...extras,
  };
}

function registrarTracos(lista) {
  return fetch(`${servidor.baseUrl}/registrar-relatorio-injecao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(lista),
  });
}

function registrarAjuste(idTraco, ajuste) {
  return fetch(`${servidor.baseUrl}/registrar-ajuste-traco`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id_traco: idTraco, ajuste }),
  });
}

function editarTraco(payload) {
  return fetch(`${servidor.baseUrl}/editar-traco-relatorio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(payload),
  });
}

async function buscarTraco(idTraco) {
  const resp = await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`);
  const todos = await resp.json();
  return todos.find(t => t.id_traco === idTraco);
}

async function buscarEntradaAjustes(idTraco) {
  const resp = await fetch(`${servidor.baseUrl}/db/ajustes_tracos.json`);
  const todos = await resp.json();
  return todos.find(a => a.id_traco === idTraco);
}

test('registrar traço novo com insumos_custom grava e aparece na leitura', async () => {
  const idTraco = 'traco-fase3-registro-' + Date.now();
  const resp = await registrarTracos([
    traco(idTraco, { id_operacao: 'op-fase3-1', id_bateria: 'B1', berco_inicio: '1', berco_finalizacao: '4' }, {
      insumos_custom: { 'Fibra': 3.2 },
    }),
  ]);
  assert.equal(resp.status, 200);

  const salvo = await buscarTraco(idTraco);
  assert.deepEqual(salvo.insumos_custom, { 'Fibra': 3.2 });
  assert.equal(salvo.cimento_real, 350, 'Padrão continua intocado');
});

test('registrar ajuste ao vivo com insumos_custom grava em ajuste_insumos e aparece no traço + ajustes_tracos.json', async () => {
  const idTraco = 'traco-fase3-ajuste-' + Date.now();

  const respAjuste = await registrarAjuste(idTraco, {
    tempo_batida: 5, cimento: 10, insumos_custom: { 'Fibra': 0.8 },
  });
  assert.equal(respAjuste.status, 200);

  // Traço só é gravado em "tracos" na finalização (mesma ordem de sempre:
  // ajuste ao vivo acontece ANTES do traço existir — ver comentário na rota).
  const resp = await registrarTracos([
    traco(idTraco, { id_operacao: 'op-fase3-2', id_bateria: 'B2', berco_inicio: '1', berco_finalizacao: '4' }, {
      insumos_custom: { 'Fibra': 3.2 },
    }),
  ]);
  assert.equal(resp.status, 200);

  const salvo = await buscarTraco(idTraco);
  assert.deepEqual(salvo.insumos_custom, { 'Fibra': { original: 3.2, ajustes: [0.8] } });

  const entradaAjustes = await buscarEntradaAjustes(idTraco);
  assert.deepEqual(entradaAjustes.ajuste_1.insumos_custom, { 'Fibra': 0.8 });
});

test('reaproveitar um traço existente NUNCA reescreve os insumos_custom já gravados', async () => {
  const idTraco = 'traco-fase3-reaproveitado-' + Date.now();

  await registrarTracos([
    traco(idTraco, { id_operacao: 'op-fase3-3a', id_bateria: 'B3', berco_inicio: '1', berco_finalizacao: '4' }, {
      insumos_custom: { 'Fibra': 1 },
    }),
  ]);

  // 2º uso do MESMO id_traco, tentando mandar um insumos_custom diferente
  // — não deveria substituir o que já foi gravado (mesma regra dos 5 Padrão).
  await registrarTracos([
    traco(idTraco, { id_operacao: 'op-fase3-3b', id_bateria: 'B4', berco_inicio: '5', berco_finalizacao: '8' }, {
      insumos_custom: { 'Fibra': 999 },
    }),
  ]);

  const salvo = await buscarTraco(idTraco);
  assert.deepEqual(salvo.insumos_custom, { 'Fibra': 1 }, 'receita original não deveria ter sido reescrita no reaproveitamento');
  assert.equal(salvo.ultilizado.operacao.length, 2, 'os 2 usos deveriam estar registrados');
});

test('editar-traco-relatorio substitui insumos_custom (original e por ajuste), inclusive removendo um que existia', async () => {
  const idTraco = 'traco-fase3-editar-' + Date.now();
  const idOp = 'op-fase3-editar-' + Date.now();

  await registrarTracos([
    traco(idTraco, { id_operacao: idOp, id_bateria: 'B-original', berco_inicio: 1, berco_finalizacao: 5 }, {
      insumos_custom: { 'Fibra': 1, 'Aditivo Y': 2 },
    }),
  ]);

  // Edita: remove "Aditivo Y", muda "Fibra", e adiciona um ajuste com
  // insumo custom próprio.
  const resp = await editarTraco({
    id_traco: idTraco, id_operacao: idOp,
    novosValores: {
      uso: { id_bateria: 'B-original', berco_inicio: 1, berco_finalizacao: 5, obs: '' },
      originais: {
        cimento_real: 10, agua_real: 4, eps_real: 2, superplast_real: 0.5, incorporador_real: 0.2,
        tempo_batida_min: 2, insumos_custom: { 'Fibra': 5 },
      },
    },
    ajustes: [{ tempo_batida: 3, cimento: 1, insumos_custom: { 'Fibra': 0.3 } }],
    diff: [{ campo: 'insumos_custom.Fibra', de: 1, para: 5 }],
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);

  const salvo = await buscarTraco(idTraco);
  assert.deepEqual(salvo.insumos_custom, { 'Fibra': { original: 5, ajustes: [0.3] } });
});
