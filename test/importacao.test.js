// ─── test/importacao.test.js ─────────────────────────────────────────────────
// Cobertura formal da Importação em massa (planilhas) — POST
// /importar-relatorio-injecao e POST /importar-historico — até agora só
// validada manualmente (ver README, "Limitações conhecidas", e
// lib/rotas/importacao.js).
//
// Cobre:
//   - Antes desta mudança, importar em massa não exigia NADA (nem senha,
//     nem sessão) — só a UI escondia o botão pra quem não fosse
//     Administrador (ver comentário em lib/rotas/importacao.js). Agora as
//     duas rotas exigem a mesma sessão de Administrador das demais rotas
//     administrativas.
//   - Importação de traços: cada linha vira um id_traco SINTÉTICO (nunca
//     reaproveita um id_traco existente, diferente de
//     /registrar-relatorio-injecao) + um uso vinculado ao id_operacao que
//     a planilha trouxe.
//   - Deduplicação de traços por chave "id_operacao|num_traco".
//   - Importação de histórico: deduplicação por id (ou, pra registros
//     antigos sem id, por "data|id_bateria|turno").
//   - Payload que não é um array retorna 400.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-importacao-357';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
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

function importarTracos(lista, cookie) {
  return fetch(`${servidor.baseUrl}/importar-relatorio-injecao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(lista),
  });
}

function importarHistorico(lista, cookie) {
  return fetch(`${servidor.baseUrl}/importar-historico`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(lista),
  });
}

function linhaPlanilhaTraco(overrides = {}) {
  return {
    data: '2026-07-15', turno: '1° TURNO', num_traco: 1,
    cimento: 350, agua: 180, superplast: 4, incorporador: 1, tempo_batida: 120,
    densidade: 1050, flow: 210, obs: null,
    id_operacao: 'op-import-' + Date.now() + '-' + Math.random(),
    id_bateria: 'B-import', berco_ini: 1, berco_fim: 4,
    ...overrides,
  };
}

// ── Sessão obrigatória ──────────────────────────────────────────────────────

test('POST /importar-relatorio-injecao sem sessão é recusado (403)', async () => {
  const resp = await importarTracos([linhaPlanilhaTraco()]);
  assert.equal(resp.status, 403);
});

test('POST /importar-historico sem sessão é recusado (403)', async () => {
  const resp = await importarHistorico([{ id: 'op-sem-sessao', data: '2026-07-15', id_bateria: 'B1', turno: '1° TURNO' }]);
  assert.equal(resp.status, 403);
});

// ── Importação de traços ────────────────────────────────────────────────────

test('importa um lote de traços com sucesso — cada linha vira um id_traco sintético + 1 uso', async () => {
  const cookie = await logarComoAdminMaster();
  const idOperacao = 'op-import-lote-' + Date.now();
  const linhas = [1, 2, 3].map(n => linhaPlanilhaTraco({ num_traco: n, id_operacao: idOperacao }));

  const resp = await importarTracos(linhas, cookie);
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
  assert.equal(data.inseridos, 3);
  assert.equal(data.duplicatas, 0);

  const respRelatorio = await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`);
  const relatorio = await respRelatorio.json();
  const importados = relatorio.filter(t => t.ultilizado.operacao.some(u => u.id_operacao === idOperacao));
  assert.equal(importados.length, 3, 'as 3 linhas importadas deveriam existir no relatório');
  assert.ok(importados.every(t => t.id_traco.startsWith('imp_traco_')), 'id_traco importado deveria ser sintético');
  assert.equal(importados[0].cimento_real, 350);
});

test('importação de traços deduplica por "id_operacao|num_traco" — reimportar o mesmo lote não duplica', async () => {
  const cookie = await logarComoAdminMaster();
  const idOperacao = 'op-import-dedup-' + Date.now();
  const linhas = [linhaPlanilhaTraco({ num_traco: 1, id_operacao: idOperacao })];

  const respPrimeira = await importarTracos(linhas, cookie);
  const dataPrimeira = await respPrimeira.json();
  assert.equal(dataPrimeira.inseridos, 1);
  assert.equal(dataPrimeira.duplicatas, 0);

  const respSegunda = await importarTracos(linhas, cookie);
  const dataSegunda = await respSegunda.json();
  assert.equal(dataSegunda.inseridos, 0, 'reimportar a mesma linha (mesma operação+num_traco) não deveria inserir de novo');
  assert.equal(dataSegunda.duplicatas, 1);
});

test('POST /importar-relatorio-injecao com payload que não é array retorna 400', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/importar-relatorio-injecao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ isso: 'nao e um array' }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);
});

// ── Importação de histórico ─────────────────────────────────────────────────

test('importa um lote de histórico (operações) com sucesso', async () => {
  const cookie = await logarComoAdminMaster();
  const idOp = 'op-import-hist-' + Date.now();

  const resp = await importarHistorico([{
    id: idOp, data: '2026-07-10', turno: '2° TURNO', dimensao: 9, capacidade: 20,
    id_bateria: 'B-hist-import', total_paineis: 40, m2_total: 88.8,
  }], cookie);
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
  assert.equal(data.inseridos, 1);
  assert.equal(data.duplicatas, 0);

  const respHistorico = await fetch(`${servidor.baseUrl}/db/historico.json`);
  const historico = await respHistorico.json();
  const salva = historico.find(o => o.id === idOp);
  assert.ok(salva, 'a operação importada deveria estar no histórico');
  assert.equal(salva.id_bateria, 'B-hist-import');
});

test('importação de histórico deduplica por id — reimportar o mesmo registro não duplica', async () => {
  const cookie = await logarComoAdminMaster();
  const idOp = 'op-import-hist-dedup-' + Date.now();
  const registro = { id: idOp, data: '2026-07-11', turno: '1° TURNO', dimensao: 9, capacidade: 20, id_bateria: 'B-dedup' };

  const respPrimeira = await importarHistorico([registro], cookie);
  const dataPrimeira = await respPrimeira.json();
  assert.equal(dataPrimeira.inseridos, 1);

  const respSegunda = await importarHistorico([registro], cookie);
  const dataSegunda = await respSegunda.json();
  assert.equal(dataSegunda.inseridos, 0, 'reimportar o mesmo id não deveria inserir de novo');
  assert.equal(dataSegunda.duplicatas, 1);
});

test('importação de histórico deduplica registros ANTIGOS sem id, por "data|id_bateria|turno"', async () => {
  const cookie = await logarComoAdminMaster();
  // Registro "legado" — sem campo id, igual planilhas antigas de antes do
  // sistema gerar id automaticamente.
  const registroSemId = { data: '2026-07-12', turno: '3° TURNO', dimensao: 9, capacidade: 20, id_bateria: 'B-legado-sem-id' };

  const respPrimeira = await importarHistorico([registroSemId], cookie);
  const dataPrimeira = await respPrimeira.json();
  assert.equal(dataPrimeira.inseridos, 1);

  const respSegunda = await importarHistorico([registroSemId], cookie);
  const dataSegunda = await respSegunda.json();
  assert.equal(dataSegunda.inseridos, 0, 'mesma data+bateria+turno deveria ser reconhecida como duplicata mesmo sem id');
  assert.equal(dataSegunda.duplicatas, 1);
});

test('POST /importar-historico com payload que não é array retorna 400', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/importar-historico`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify('nao e um array'),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);
});
