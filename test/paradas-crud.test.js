// ─── test/paradas-crud.test.js ──────────────────────────────────────────────
// Cobertura formal do comportamento de POST /salvar-parada e POST
// /excluir-parada — até agora só a checagem de permissão (403) tinha teste
// (ver test/permissoes-por-area.test.js, test/perfis-customizados.test.js);
// o CAMINHO FELIZ (o que a rota realmente grava/apaga) era só validado
// manualmente.
//
// Roda contra o server.js DE VERDADE (não um mock), numa cópia isolada —
// ver test/helpers/servidor-teste.js. Cobre:
//   - Criar uma parada nova via /salvar-parada e ela aparece em
//     GET /db/paradas.json com os campos certos.
//   - /salvar-parada faz UPSERT (mesmo id salvo de novo atualiza a linha
//     existente, não duplica) — mesma lógica de db.prepare(...ON CONFLICT).
//   - /salvar-parada sem "id" no payload é recusado (400), sem derrubar o
//     servidor.
//   - /excluir-parada remove a parada — some de GET /db/paradas.json.
//   - /excluir-parada com id inexistente é recusado (400): "changes === 0"
//     vira erro, não um 200 silencioso.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-paradas-crud-951';
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

function salvarParada(parada, cookie) {
  return fetch(`${servidor.baseUrl}/salvar-parada`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(parada),
  });
}

function excluirParada(id, cookie) {
  return fetch(`${servidor.baseUrl}/excluir-parada`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ id }),
  });
}

async function buscarParada(id) {
  const resp = await fetch(`${servidor.baseUrl}/db/paradas.json`);
  const todas = await resp.json();
  return todas.find(p => p.id === id);
}

test('cria uma parada nova e ela aparece em GET /db/paradas.json', async () => {
  const cookie = await logarComoAdminMaster();
  const id = 'parada-nova-' + Date.now();

  const resp = await salvarParada({
    id, inicio: '2026-07-20T08:00:00.000Z', fim: '2026-07-20T08:15:00.000Z',
    duracao_min: 15, motivo: 'Falta de material', equipamento: 'Injetora 1',
    classificacao: 'Planejada', obs: 'teste automatizado', registrado_em: new Date().toISOString(),
    operador_nome: 'Operador Teste',
  }, cookie);
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);

  const salva = await buscarParada(id);
  assert.ok(salva, 'a parada deveria estar em GET /db/paradas.json depois de salva');
  assert.equal(salva.motivo, 'Falta de material');
  assert.equal(salva.duracao_min, 15);
  assert.equal(salva.equipamento, 'Injetora 1');
});

test('salvar de novo o MESMO id atualiza a parada existente (UPSERT), não duplica', async () => {
  const cookie = await logarComoAdminMaster();
  const id = 'parada-upsert-' + Date.now();

  await salvarParada({
    id, inicio: '2026-07-20T09:00:00.000Z', fim: '2026-07-20T09:10:00.000Z',
    duracao_min: 10, motivo: 'Motivo original', equipamento: 'Injetora 2', classificacao: 'Não planejada',
  }, cookie);

  const resp = await salvarParada({
    id, inicio: '2026-07-20T09:00:00.000Z', fim: '2026-07-20T09:20:00.000Z',
    duracao_min: 20, motivo: 'Motivo corrigido', equipamento: 'Injetora 2', classificacao: 'Não planejada',
  }, cookie);
  assert.equal(resp.status, 200);

  const respTodas = await fetch(`${servidor.baseUrl}/db/paradas.json`);
  const todas = await respTodas.json();
  const comEsseId = todas.filter(p => p.id === id);
  assert.equal(comEsseId.length, 1, 'deveria existir só UMA linha com esse id, não duas');
  assert.equal(comEsseId[0].motivo, 'Motivo corrigido');
  assert.equal(comEsseId[0].duracao_min, 20);
});

test('/salvar-parada sem "id" no payload é recusado (400), sem derrubar o servidor', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await salvarParada({ inicio: '2026-07-20T10:00:00.000Z', motivo: 'sem id' }, cookie);
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);

  const respSaude = await fetch(`${servidor.baseUrl}/login.html`);
  assert.equal(respSaude.status, 200);
});

test('/excluir-parada remove a parada — some de GET /db/paradas.json', async () => {
  const cookie = await logarComoAdminMaster();
  const id = 'parada-pra-excluir-' + Date.now();

  await salvarParada({
    id, inicio: '2026-07-20T11:00:00.000Z', fim: '2026-07-20T11:05:00.000Z',
    duracao_min: 5, motivo: 'vai ser excluída', equipamento: 'Injetora 1', classificacao: 'Planejada',
  }, cookie);
  assert.ok(await buscarParada(id), 'a parada deveria existir antes de excluir');

  const resp = await excluirParada(id, cookie);
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);

  assert.equal(await buscarParada(id), undefined, 'a parada não deveria mais existir depois de excluída');
});

test('/excluir-parada com id inexistente é recusado (400) — não retorna 200 silenciosamente', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await excluirParada('id-que-nunca-existiu-' + Date.now(), cookie);
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);
});
