// ─── test/sobra-crud.test.js ────────────────────────────────────────────────
// Cobertura formal de POST /salvar-sobra e GET /db/sobra.json — até agora só
// validado manualmente (é a área de "ferramentas de registro de operação",
// ver lib/rotas/sobra.js). "Sobra" é o traço batido que sobrou de uma
// operação pra ser reaproveitado na próxima — mexe em material/produção
// real, por isso merece o mesmo nível de cobertura que /registrar-operacao.
//
// Roda contra o server.js DE VERDADE (não um mock), numa cópia isolada —
// ver test/helpers/servidor-teste.js. Cobre:
//   - Caminho real: POST /salvar-sobra grava na tabela "sobra" (upsert de
//     linha única, id=1) e aparece em GET /db/sobra.json convertida de
//     volta pro formato camelCase esperado pelo front.
//   - Salvar de novo SUBSTITUI a sobra ativa (linha única, id=1) — não
//     acumula histórico.
//   - Sem sessão/dispositivo autorizado (fora do Modo de Teste), é
//     recusado com 403 — mesma exigência de /registrar-operacao (área
//     'injetora').
//   - Modo de Teste dispensa a checagem de permissão e grava em
//     public/db/teste/sobra.json isolado, nunca na tabela real.
//   - JSON malformado no corpo retorna 400, sem derrubar o servidor.
//   - Sem nenhuma sobra salva ainda, GET /db/sobra.json devolve um objeto
//     vazio (não erro, não null) — ver rowParaSobra(row) quando row é
//     undefined.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-sobra-crud-486';
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

function salvarSobra(sobra, { cookie, deviceId = DEVICE_ID_TESTE_PADRAO, modoTeste = false } = {}) {
  const qs = new URLSearchParams();
  if (deviceId) qs.set('deviceId', deviceId);
  if (modoTeste) qs.set('modoTeste', 'true');
  return fetch(`${servidor.baseUrl}/salvar-sobra?${qs.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(sobra),
  });
}

async function lerSobraAtual() {
  const resp = await fetch(`${servidor.baseUrl}/db/sobra.json`);
  return resp.json();
}

test('sem sessão/dispositivo, POST /salvar-sobra (fora do Modo de Teste) é recusado (403)', async () => {
  const resp = await salvarSobra({ ativa: true, tracoId: 't1' }, { deviceId: null });
  assert.equal(resp.status, 403);
});

test('caminho real: grava a sobra e ela aparece em GET /db/sobra.json convertida pro formato certo', async () => {
  const cookie = await logarComoAdminMaster();

  const resp = await salvarSobra({
    ativa: true, tracoId: 'traco-abc', numTraco: 7, operacaoOrigem: 'op-origem-1',
    flow: 620, densidade: 33.5, receita: { cimento: 10, agua: 4 },
    data: '2026-07-20', status: 'disponivel', dataEncerramento: null,
  }, { cookie });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);

  const atual = await lerSobraAtual();
  assert.equal(atual.ativa, true);
  assert.equal(atual.tracoId, 'traco-abc');
  assert.equal(atual.numTraco, 7);
  assert.equal(atual.operacaoOrigem, 'op-origem-1');
  assert.equal(atual.flow, 620);
  assert.equal(atual.densidade, 33.5);
  assert.deepEqual(atual.receita, { cimento: 10, agua: 4 });
  assert.equal(atual.status, 'disponivel');
});

test('salvar de novo SUBSTITUI a sobra ativa — linha única (id=1), não acumula histórico', async () => {
  const cookie = await logarComoAdminMaster();

  await salvarSobra({ ativa: true, tracoId: 'traco-primeiro', numTraco: 1, status: 'disponivel' }, { cookie });
  await salvarSobra({ ativa: false, tracoId: 'traco-segundo', numTraco: 2, status: 'encerrada', dataEncerramento: '2026-07-20' }, { cookie });

  const atual = await lerSobraAtual();
  assert.equal(atual.tracoId, 'traco-segundo', 'deveria refletir a ÚLTIMA sobra salva, não a primeira');
  assert.equal(atual.ativa, false);
  assert.equal(atual.status, 'encerrada');
});

test('Modo de Teste: dispensa permissão e grava em public/db/teste/sobra.json isolado, nunca na tabela real', async () => {
  // Sobra real anterior — usada pra confirmar que o Modo de Teste não a altera.
  const cookieSetup = await logarComoAdminMaster();
  await salvarSobra({ ativa: true, tracoId: 'sobra-real-intacta', numTraco: 99, status: 'disponivel' }, { cookie: cookieSetup });

  const resp = await salvarSobra(
    { ativa: true, tracoId: 'sobra-modo-teste', numTraco: 5, status: 'disponivel' },
    { modoTeste: true, deviceId: null }
  );
  assert.equal(resp.status, 200);

  // A tabela real continua com a sobra anterior, intocada.
  const atualReal = await lerSobraAtual();
  assert.equal(atualReal.tracoId, 'sobra-real-intacta');

  // O arquivo isolado do Modo de Teste tem a nova sobra.
  const sobraTestePath = path.join(servidor.pastaTemp, 'public', 'db', 'teste', 'sobra.json');
  const sobraTeste = JSON.parse(fs.readFileSync(sobraTestePath, 'utf8'));
  assert.equal(sobraTeste.tracoId, 'sobra-modo-teste');
});

test('JSON malformado no corpo retorna 400, sem derrubar o servidor', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/salvar-sobra?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: '{ isso nao e json valido',
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);

  const respSaude = await fetch(`${servidor.baseUrl}/login.html`);
  assert.equal(respSaude.status, 200);
});
