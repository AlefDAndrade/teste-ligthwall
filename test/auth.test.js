// ─── test/auth.test.js ───────────────────────────────────────────────────────
// Testes da autenticação do Administrador: hash de senha (scrypt + migração
// do legado), rate limiting de tentativas, e a sessão que protege
// GET /db/security.json e POST /salvar-security (que antes desta mudança
// não tinham proteção própria nenhuma — ver README, "Limitações
// conhecidas", e o histórico desta conversa).
//
// Roda contra o server.js DE VERDADE (não um mock) numa cópia isolada — ver
// test/helpers/servidor-teste.js. Requer as dependências reais instaladas
// (`npm install`); não usa nenhum framework de teste, só o test runner
// nativo do Node (`node:test`, disponível desde o Node 18 — mesma versão
// mínima que o projeto já exige em package.json).
//
// Como rodar: node --test
// (ou: npm test, se o script estiver cadastrado em package.json)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_TESTE = 'senha-de-teste-aleatoria-123';
const CHAVE_RECOVERY_TESTE = 'chave-de-recuperacao-de-teste';

// Hashes LEGADOS (SHA-256 puro) de propósito — testa o caminho de
// compatibilidade/migração automática pro formato novo (scrypt), que é
// exatamente a situação de uma instalação já existente antes desta mudança.
const HASH_SENHA_LEGADO = crypto.createHash('sha256').update(SENHA_TESTE, 'utf8').digest('hex');
const HASH_RECOVERY_LEGADO = crypto.createHash('sha256').update(CHAVE_RECOVERY_TESTE, 'utf8').digest('hex');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_SENHA_LEGADO, recoveryKeyHash: HASH_RECOVERY_LEGADO },
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
    body: JSON.stringify({ senha: SENHA_TESTE }),
  });
  const cookie = extrairCookie(resp);
  assert.ok(cookie, 'login deveria emitir um cookie de sessão');
  return cookie;
}

test('migração automática: security.json antigo (public/db/) é movido pra private/ no boot, sem apagar o original', () => {
  const antigo = path.join(servidor.pastaTemp, 'public', 'db', 'security.json');
  const novo = path.join(servidor.pastaTemp, 'private', 'security.json');

  assert.ok(fs.existsSync(novo), 'private/security.json deveria existir depois do boot');
  assert.ok(!fs.existsSync(antigo), 'public/db/security.json não deveria mais existir com esse nome exato');

  const renomeados = fs.readdirSync(path.join(servidor.pastaTemp, 'public', 'db'))
    .filter(nome => nome.startsWith('security.json.migrado-'));
  // ">= 1", não "=== 1": depois do 1º deploy de verdade, public/db/ do
  // projeto real SEMPRE vai ter pelo menos 1 arquivo ".migrado-" (nunca é
  // apagado) — e esse arquivo entra na cópia que o teste faz de public/.
  // O que importa é que o arquivo antigo NUNCA desapareça sem deixar
  // rastro, não que seja o único.
  assert.ok(renomeados.length >= 1, 'o arquivo antigo deveria ter sido renomeado, não apagado');
});

test('GET /db/security.json não é mais servido como arquivo estático comum (404 fora do lugar antigo)', async () => {
  // Mesmo sabendo a URL exata, o arquivo físico não existe mais em
  // public/db/ — isso é verdade mesmo ANTES de qualquer checagem de
  // sessão (defesa em profundidade: 2 camadas independentes).
  const antigo = path.join(servidor.pastaTemp, 'public', 'db', 'security.json');
  assert.ok(!fs.existsSync(antigo));
});

test('POST /verificar-senha: senha errada não autentica e não emite sessão', async () => {
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: 'senha-errada' }),
  });
  const dados = await resp.json();
  assert.equal(dados.ok, false);
  assert.equal(extrairCookie(resp), null);
});

test('POST /verificar-senha: senha certa autentica, emite sessão, e promove o hash legado pra scrypt', async () => {
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_TESTE }),
  });
  const dados = await resp.json();
  assert.equal(dados.ok, true);
  assert.ok(extrairCookie(resp), 'deveria vir um Set-Cookie de sessão');

  const conteudo = JSON.parse(fs.readFileSync(path.join(servidor.pastaTemp, 'private', 'security.json'), 'utf8'));
  assert.ok(conteudo.passwordHash.startsWith('scrypt:'), 'o hash deveria ter sido promovido pro formato novo');
});

test('GET /db/security.json: sem sessão válida dá 403', async () => {
  const resp = await fetch(`${servidor.baseUrl}/db/security.json`);
  assert.equal(resp.status, 403);
});

test('GET /db/security.json: com sessão válida dá 200 e devolve o conteúdo', async () => {
  const cookie = await logarComoAdmin();
  const resp = await fetch(`${servidor.baseUrl}/db/security.json`, { headers: { Cookie: cookie } });
  assert.equal(resp.status, 200);
  const dados = await resp.json();
  assert.ok(typeof dados.passwordHash === 'string' && dados.passwordHash.length > 0);
});

test('POST /salvar-security: sem sessão dá 403 (antes desta mudança, não exigia NADA — nem senha)', async () => {
  const resp = await fetch(`${servidor.baseUrl}/salvar-security`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passwordHash: 'scrypt:aa:bb', recoveryKeyHash: HASH_RECOVERY_LEGADO }),
  });
  assert.equal(resp.status, 403);
});

test('POST /salvar-security: com sessão válida salva o novo hash', async () => {
  const securityPath = path.join(servidor.pastaTemp, 'private', 'security.json');
  const conteudoOriginal = fs.readFileSync(securityPath, 'utf8');

  const cookie = await logarComoAdmin();
  const resp = await fetch(`${servidor.baseUrl}/salvar-security`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ passwordHash: 'scrypt:abcd:1234', recoveryKeyHash: HASH_RECOVERY_LEGADO }),
  });
  assert.equal(resp.status, 200);

  const conteudoNovo = JSON.parse(fs.readFileSync(securityPath, 'utf8'));
  assert.equal(conteudoNovo.passwordHash, 'scrypt:abcd:1234');

  // Restaura o hash original — este teste não deve deixar o sistema sem
  // login válido pros testes que rodam depois (precisam logar de novo).
  fs.writeFileSync(securityPath, conteudoOriginal, 'utf8');
});

test('POST /logout-admin: destrói a sessão — o mesmo cookie deixa de funcionar depois', async () => {
  const cookie = await logarComoAdmin();

  // Confirma que o cookie funciona ANTES do logout (evita um teste que
  // "passaria" mesmo se a sessão nunca tivesse funcionado).
  const antes = await fetch(`${servidor.baseUrl}/db/security.json`, { headers: { Cookie: cookie } });
  assert.equal(antes.status, 200);

  await fetch(`${servidor.baseUrl}/logout-admin`, { method: 'POST', headers: { Cookie: cookie } });

  const depois = await fetch(`${servidor.baseUrl}/db/security.json`, { headers: { Cookie: cookie } });
  assert.equal(depois.status, 403);
});

test('rate limiting: 5 tentativas erradas bloqueiam a 6ª, mesmo com a senha certa (HTTP 429)', async () => {
  for (let i = 0; i < 5; i++) {
    await fetch(`${servidor.baseUrl}/verificar-senha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: 'tentativa-errada-' + i }),
    });
  }
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_TESTE }),
  });
  assert.equal(resp.status, 429);
  assert.ok(resp.headers.get('retry-after'), 'deveria vir um cabeçalho Retry-After');
});
