// ─── test/debriefing-mesma-fonte-avaliacao.test.js ──────────────────────────
// Testa a correção de um bug real: o Debriefing (public/js/debriefing.js)
// buscava avaliações em 'db/avaliacoes_qualidade.json', enquanto o Dashboard
// de Avaliação (setor-qualidade.js, carregarAvaliacoesQualidade) busca em
// '/avaliacoes-qualidade' — mesma função no servidor por trás
// (db.listarAvaliacoesQualidade) mas rotas diferentes, então qualquer
// diferença de comportamento entre as duas (cache de proxy, header, etc.)
// podia fazer uma editar e a outra não refletir. Ver conversa que motivou
// esta mudança: "quero que a avaliação pegue os dados da mesma fonte que os
// dashboard de avaliação".
//
// Este teste cobre 2 coisas:
//   1. debriefing.js literalmente usa a MESMA URL do Dashboard agora
//      (checagem estática do código-fonte — mais direta e à prova de
//      regressão do que tentar montar um DOM inteiro pra isso).
//   2. As duas rotas (/avaliacoes-qualidade e /db/avaliacoes_qualidade.json)
//      continuam idênticas — ANTES e DEPOIS de uma edição — servidor real.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-debriefing-fonte-321';
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

async function logarComoAdmin() {
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  return extrairCookie(resp);
}

test('debriefing.js busca avaliações na MESMA rota que o Dashboard de Avaliação (/avaliacoes-qualidade)', () => {
  const codigo = fs.readFileSync(path.join(__dirname, '..', 'public/js/debriefing.js'), 'utf8');
  assert.ok(
    codigo.includes("fetch('/avaliacoes-qualidade')"),
    'debriefing.js precisa buscar avaliações em /avaliacoes-qualidade, igual ao Dashboard (setor-qualidade.js)'
  );
  assert.ok(
    !codigo.includes("fetch('db/avaliacoes_qualidade.json')") && !codigo.includes('fetch("db/avaliacoes_qualidade.json")'),
    'debriefing.js não deveria mais BUSCAR avaliações em db/avaliacoes_qualidade.json (rota pensada pro Backup de Dados, não pra tela) — só pode citar o nome em comentário explicando o histórico'
  );
});

test('/avaliacoes-qualidade e /db/avaliacoes_qualidade.json ficam idênticas antes E depois de uma edição', async () => {
  const cookie = await logarComoAdmin();
  const idOp = 'op-fonte-unica-' + Date.now();

  await fetch(`${servidor.baseUrl}/registrar-operacao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: idOp, data: '2026-07-12', turno: '1° TURNO', dimensao: 9, capacidade: 20, id_bateria: 'B5' }),
  });

  const idAvaliacao = 'ev-fonte-unica-' + Date.now();
  await fetch(`${servidor.baseUrl}/registrar-avaliacao-qualidade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: idAvaliacao, batteryId: 'B5', linkedOperacaoId: idOp, turno: '1° TURNO',
      dtDesmoldagem: '2026-07-12T10:00:00.000Z', paineis: [],
    }),
  });

  async function buscarAsDuas() {
    const [respDashboard, respDb] = await Promise.all([
      fetch(`${servidor.baseUrl}/avaliacoes-qualidade`),
      fetch(`${servidor.baseUrl}/db/avaliacoes_qualidade.json`),
    ]);
    const [dashboard, db] = await Promise.all([respDashboard.json(), respDb.json()]);
    return {
      dashboard: dashboard.find(a => a.id === idAvaliacao),
      db: db.find(a => a.id === idAvaliacao),
    };
  }

  const antes = await buscarAsDuas();
  assert.ok(antes.dashboard, 'avaliação deveria aparecer em /avaliacoes-qualidade');
  assert.ok(antes.db, 'avaliação deveria aparecer em /db/avaliacoes_qualidade.json');
  assert.deepEqual(antes.dashboard, antes.db, 'as duas rotas devem devolver exatamente o mesmo registro');
  assert.equal(antes.dashboard.dtDesmoldagem, '2026-07-12T10:00:00.000Z');

  // Edita a data de desmoldagem (mesmo campo citado no bug original) —
  // reenvia a avaliação inteira com o mesmo id (upsert, ver
  // db.salvarAvaliacaoQualidade).
  await fetch(`${servidor.baseUrl}/registrar-avaliacao-qualidade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: idAvaliacao, batteryId: 'B5', linkedOperacaoId: idOp, turno: '1° TURNO',
      dtDesmoldagem: '2026-07-13T10:00:00.000Z', paineis: [],
    }),
  });

  const depois = await buscarAsDuas();
  assert.equal(depois.dashboard.dtDesmoldagem, '2026-07-13T10:00:00.000Z', '/avaliacoes-qualidade reflete a edição');
  assert.equal(depois.db.dtDesmoldagem, '2026-07-13T10:00:00.000Z', '/db/avaliacoes_qualidade.json também reflete a edição');
  assert.deepEqual(depois.dashboard, depois.db, 'as duas rotas continuam idênticas depois da edição');
});
