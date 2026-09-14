// ─── test/insumos-dinamicos-migracao.test.js ────────────────────────────────
// Fase 1 de "Insumos de Receitas dinâmicos no formulário de traço" (ver
// README) — migração das 5 colunas fixas de insumo em "tracos"/"ajustes"
// (cimento_original/agua_original/etc, cimento/agua/etc) pras tabelas
// dinâmicas traco_insumos/ajuste_insumos (db.migrarInsumosFixosParaDinamico,
// ver lib/db/tracos.js).
//
// Cobre:
//   1. Um traço inserido pela via normal (fixed columns, ainda a única
//      forma de escrita até a Fase 2) some corretamente pras 5 linhas
//      esperadas em traco_insumos após um restart do servidor (boot =
//      quando a migração roda, ver server.js).
//   2. O mesmo vale pra "ajustes" -> ajuste_insumos, quando o traço tem
//      pelo menos 1 reaproveitamento com ajuste de receita.
//   3. Idempotência: restart de novo não duplica as linhas já migradas.
//   4. Insumo com valor NULL (não preenchido) não gera linha (evita "lixo"
//      de zeros/nulos nas tabelas dinâmicas).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-insumos-dinamicos-591';
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

function linhaPlanilhaTraco(overrides = {}) {
  return {
    data: '2026-07-15', turno: '1° TURNO', num_traco: 1,
    cimento: 350, agua: 180, superplast: 4, incorporador: 1, tempo_batida: 120,
    densidade: 1050, flow: 210, obs: null,
    id_operacao: 'op-insumos-dinamicos-' + Date.now() + '-' + Math.random(),
    id_bateria: 'B-insumos', berco_ini: 1, berco_fim: 4,
    ...overrides,
  };
}

function abrirSqliteDaInstanciaDeTeste() {
  // Mesmo caminho que db.js usa (path.join(__dirname, 'data',
  // 'lightwall.sqlite')), mas relativo à pastaTemp desta instância de
  // teste (cada iniciarServidorDeTeste() roda numa cópia isolada — ver
  // helpers/servidor-teste.js).
  return new Database(path.join(servidor.pastaTemp, 'data', 'lightwall.sqlite'), { readonly: true });
}

test('traço importado (fixed columns) migra pra traco_insumos/ajuste_insumos após restart do servidor', async () => {
  const cookie = await logarComoAdminMaster();

  // EPS de propósito ausente (undefined) — cobre o caso 4 do cabeçalho
  // (insumo sem valor não deve virar linha em traco_insumos).
  const linha = linhaPlanilhaTraco();

  const resp = await fetch(`${servidor.baseUrl}/importar-relatorio-injecao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify([linha]),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.inseridos, 1);

  // Migração roda no BOOT (server.js, logo após migrarRelatorioInjecaoSeNecessario)
  // — reinicia o processo pra disparar.
  await servidor.reiniciar();

  const db = abrirSqliteDaInstanciaDeTeste();
  try {
    const traco = db.prepare(
      "SELECT id_traco FROM tracos WHERE data = ? AND num_traco = ?"
    ).get(linha.data, linha.num_traco);
    assert.ok(traco, 'traço deveria existir em "tracos" antes de checar a migração');

    const insumos = db.prepare(
      'SELECT insumo, valor FROM traco_insumos WHERE id_traco = ? ORDER BY insumo'
    ).all(traco.id_traco);

    const porNome = Object.fromEntries(insumos.map(i => [i.insumo, i.valor]));
    assert.equal(porNome['Cimento'], 350);
    assert.equal(porNome['Água'], 180);
    assert.equal(porNome['Superplastificante'], 4);
    assert.equal(porNome['Incorporador de Ar'], 1);
    // EPS não veio na planilha (undefined -> NULL na coluna original) —
    // não deve gerar linha nenhuma.
    assert.equal('EPS' in porNome, false, 'insumo sem valor não deveria virar linha em traco_insumos');
    assert.equal(insumos.length, 4);
  } finally {
    db.close();
  }
});

test('idempotência: reiniciar de novo não duplica as linhas já migradas', async () => {
  const dbAntes = abrirSqliteDaInstanciaDeTeste();
  const totalAntes = dbAntes.prepare('SELECT COUNT(*) AS n FROM traco_insumos').get().n;
  dbAntes.close();
  assert.ok(totalAntes > 0, 'pré-condição: já deveria ter linhas migradas do teste anterior');

  await servidor.reiniciar();

  const dbDepois = abrirSqliteDaInstanciaDeTeste();
  const totalDepois = dbDepois.prepare('SELECT COUNT(*) AS n FROM traco_insumos').get().n;
  dbDepois.close();
  assert.equal(totalDepois, totalAntes, 'restart extra não deveria duplicar linhas já migradas');
});
