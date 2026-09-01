// ─── test/expedicao-crud.test.js ────────────────────────────────────────────
// Cobertura do backend de Cargas de Expedição — Fase 2 do plano do One Page
// Report (ver README, "Nova página: One Page Report (planejamento)").
//
// Roda contra o server.js DE VERDADE (não um mock), numa cópia isolada —
// ver test/helpers/servidor-teste.js. Cobre:
//   - POST /registrar-carga-expedicao sem sessão é recusado (403), nada é
//     gravado (ver comentário de PERMISSÃO DE ESCRITA, lib/rotas/
//     expedicao.js — exige sessaoOuAdmin, não uma área de perfil).
//   - `data`/`cliente` ausentes e `m2` inválido (<=0 ou não-numérico) são
//     recusados (400).
//   - Caminho feliz: grava a carga e ela aparece em GET
//     /db/expedicao_cargas.json, com `id`/`registrado_em` gerados no
//     servidor.
//   - GET /db/expedicao_cargas.json?mes=YYYY-MM filtra por mês.
//   - POST /excluir-carga-expedicao remove pelo id; id inexistente dá 400.
//   - GET /expedicao/agregacao-semanal: `agregacao: null` sem nenhuma carga
//     no mês (nunca semanas zeradas — ver regra do README); depois de
//     registrar, agrega corretamente em S1-S4, soma o acumulado do mês e
//     calcula o forecast (relógio congelado via LW_TEST_RELOGIO_ISO) —
//     mês corrente projeta, mês passado fecha com forecast = acumulado.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-expedicao-cargas-733';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
    // Congela "hoje" (Brasília) em 2026-08-31 — mesmo mecanismo de
    // test/seguranca-ocorrencias-crud.test.js (ver lib/tempo.js,
    // _agoraServer). Mês corrente pro forecast = 2026-08.
    env: { LW_TEST_RELOGIO_ISO: '2026-08-31T12:00:00-03:00' },
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

function registrarCarga(payload, cookie) {
  return fetch(`${servidor.baseUrl}/registrar-carga-expedicao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
}

function excluirCarga(id, cookie) {
  return fetch(`${servidor.baseUrl}/excluir-carga-expedicao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ id }),
  });
}

function buscarCargas(mes) {
  const qs = mes ? `?mes=${mes}` : '';
  return fetch(`${servidor.baseUrl}/db/expedicao_cargas.json${qs}`);
}

function buscarAgregacaoSemanal(mes) {
  const qs = mes ? `?mes=${mes}` : '';
  return fetch(`${servidor.baseUrl}/expedicao/agregacao-semanal${qs}`);
}

test('POST /registrar-carga-expedicao sem sessão é recusado (403), nada é gravado', async () => {
  const resp = await registrarCarga({ data: '2026-08-20', cliente: 'Cliente Teste', m2: 120 }, null);
  assert.equal(resp.status, 403);

  const lista = await (await buscarCargas()).json();
  assert.equal(lista.length, 0);
});

test('data ausente é recusada (400), sem gravar nada', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await registrarCarga({ cliente: 'Cliente Teste', m2: 120 }, cookie);
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);
  assert.match(corpo.erro, /data/i);

  const lista = await (await buscarCargas()).json();
  assert.equal(lista.length, 0);
});

test('cliente ausente é recusado (400), sem gravar nada', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await registrarCarga({ data: '2026-08-20', m2: 120 }, cookie);
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);
  assert.match(corpo.erro, /cliente/i);

  const lista = await (await buscarCargas()).json();
  assert.equal(lista.length, 0);
});

test('m2 inválido (zero, negativo ou não-numérico) é recusado (400), sem gravar nada', async () => {
  const cookie = await logarComoAdminMaster();

  for (const m2invalido of [0, -10, 'muito', null]) {
    const resp = await registrarCarga({ data: '2026-08-20', cliente: 'Cliente Teste', m2: m2invalido }, cookie);
    assert.equal(resp.status, 400);
    const corpo = await resp.json();
    assert.equal(corpo.ok, false);
    assert.match(corpo.erro, /m²/i);
  }

  const lista = await (await buscarCargas()).json();
  assert.equal(lista.length, 0);
});

test('GET /expedicao/agregacao-semanal devolve agregacao null sem nenhuma carga no mês', async () => {
  const resp = await buscarAgregacaoSemanal('2026-08');
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);
  assert.equal(corpo.agregacao, null);
});

test('caminho feliz: grava a carga e ela aparece em GET /db/expedicao_cargas.json', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await registrarCarga({
    data: '2026-08-03', // dia 3 -> S1
    cliente: 'Cliente Alfa',
    m2: 150.5,
    numero_carga: 'CG-001',
    operador_nome: 'Operador Teste',
    // Tentativa de forjar id/registrado_em — o servidor deve ignorar e
    // gerar os dois valores por conta própria.
    id: 'id-forjado-pelo-cliente',
    registrado_em: '2000-01-01T00:00:00.000Z',
  }, cookie);
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);

  const lista = await (await buscarCargas()).json();
  assert.equal(lista.length, 1);
  const [registro] = lista;
  assert.equal(registro.cliente, 'Cliente Alfa');
  assert.equal(registro.m2, 150.5);
  assert.equal(registro.numero_carga, 'CG-001');
  assert.equal(registro.operador_nome, 'Operador Teste');
  assert.notEqual(registro.id, 'id-forjado-pelo-cliente');
  assert.match(registro.id, /^carga_expedicao_\d+_[0-9a-f]{6}$/);
  assert.equal(corpo.id, registro.id);
  assert.notEqual(registro.registrado_em, '2000-01-01T00:00:00.000Z');
});

test('GET /db/expedicao_cargas.json?mes= filtra por mês', async () => {
  const cookie = await logarComoAdminMaster();
  // Carga de um mês diferente (julho) — não deve aparecer no filtro de agosto.
  await registrarCarga({ data: '2026-07-15', cliente: 'Cliente Julho', m2: 80 }, cookie);

  const doMesAgosto = await (await buscarCargas('2026-08')).json();
  assert.equal(doMesAgosto.length, 1);
  assert.equal(doMesAgosto[0].cliente, 'Cliente Alfa');

  const doMesJulho = await (await buscarCargas('2026-07')).json();
  assert.equal(doMesJulho.length, 1);
  assert.equal(doMesJulho[0].cliente, 'Cliente Julho');

  const semFiltro = await (await buscarCargas()).json();
  assert.equal(semFiltro.length, 2);
});

test('agregação semanal: soma cargas em S1-S4, acumulado do mês e forecast do mês corrente', async () => {
  const cookie = await logarComoAdminMaster();
  // 2026-08-03 (dia 3, S1, m2=150.5) já registrada acima. Adiciona mais:
  await registrarCarga({ data: '2026-08-10', cliente: 'Cliente Beta', m2: 100 }, cookie); // dia 10 -> S2
  await registrarCarga({ data: '2026-08-25', cliente: 'Cliente Gama', m2: 50 }, cookie);  // dia 25 -> S4

  const resp = await buscarAgregacaoSemanal('2026-08');
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);
  const agregacao = corpo.agregacao;
  assert.equal(agregacao.mes, '2026-08');

  const s1 = agregacao.semanas.find(s => s.semana === 'S1');
  const s2 = agregacao.semanas.find(s => s.semana === 'S2');
  const s3 = agregacao.semanas.find(s => s.semana === 'S3');
  const s4 = agregacao.semanas.find(s => s.semana === 'S4');
  assert.equal(s1.m2, 150.5);
  assert.equal(s2.m2, 100);
  assert.equal(s3.m2, 0);
  assert.equal(s4.m2, 50);

  assert.equal(agregacao.acumuladoMes, 300.5);

  // "Hoje" congelado em 2026-08-31 (relógio de teste) = último dia do mês,
  // então forecast = acumuladoMes / 31 * 31 = o próprio acumulado.
  assert.equal(agregacao.forecast, 300.5);
});

test('agregação semanal de mês passado fecha com forecast = acumulado (sem projeção)', async () => {
  // Julho de 2026 (mês anterior ao congelado) já tem 1 carga registrada no
  // teste de filtro por mês, acima (Cliente Julho, 2026-07-15, m2=80).
  const resp = await buscarAgregacaoSemanal('2026-07');
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);
  assert.equal(corpo.agregacao.acumuladoMes, 80);
  assert.equal(corpo.agregacao.forecast, 80);
});

test('agregação semanal de mês futuro devolve forecast null (nada ainda "já passou")', async () => {
  const cookie = await logarComoAdminMaster();
  await registrarCarga({ data: '2026-09-05', cliente: 'Cliente Setembro', m2: 40 }, cookie);

  const resp = await buscarAgregacaoSemanal('2026-09');
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);
  assert.equal(corpo.agregacao.acumuladoMes, 40);
  assert.equal(corpo.agregacao.forecast, null);
});

test('POST /excluir-carga-expedicao sem sessão é recusado (403)', async () => {
  const lista = await (await buscarCargas('2026-08')).json();
  const resp = await excluirCarga(lista[0].id, null);
  assert.equal(resp.status, 403);
});

test('POST /excluir-carga-expedicao com id inexistente devolve 400', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await excluirCarga('id-que-nao-existe', cookie);
  assert.equal(resp.status, 400);
});

test('POST /excluir-carga-expedicao remove a carga de verdade', async () => {
  const cookie = await logarComoAdminMaster();
  const antes = await (await buscarCargas('2026-08')).json();
  assert.ok(antes.length > 0);

  const resp = await excluirCarga(antes[0].id, cookie);
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);

  const depois = await (await buscarCargas('2026-08')).json();
  assert.equal(depois.length, antes.length - 1);
  assert.ok(!depois.some(c => c.id === antes[0].id));
});
