// ─── test/backup-drive.test.js ──────────────────────────────────────────────
// Cobertura de POST/GET /backup-drive/* (ver lib/rotas/backup-drive.js) e do
// gancho de upload automático em lib/rotas/backup.js (Passos 5 e 7 do plano
// "Backup Automático no Google Drive", ver README).
//
// Roda contra o server.js DE VERDADE (não um mock), numa cópia isolada — ver
// test/helpers/servidor-teste.js. DE PROPÓSITO não faz nenhuma chamada real
// ao Google (nem em /autorizar, nem em /callback com token de verdade) —
// isso exigiria credenciais reais e uma conta de teste, fora do escopo de
// uma suíte automatizada. O que dá pra testar sem tocar o Google:
//
//   - Todas as rotas exigem sessão de administrador.
//   - /status reflete corretamente o que está (ou não) em
//     private/backup-drive.json, sem nunca expor refreshToken.
//   - /autorizar exige senha correta ANTES de qualquer coisa, e recusa com
//     503 quando as credenciais do Google (Passo 1 do plano) não estão
//     configuradas no ambiente — que é o estado padrão de qualquer instalação
//     nova, incluindo esta suíte de teste.
//   - /toggle recusa se não há conta conectada, e liga/desliga
//     corretamente quando há (seedado direto no arquivo, sem OAuth real).
//   - /desconectar exige senha e limpa o arquivo mesmo com o Google
//     inalcançável (fail-safe do revogarToken, ver lib/google-drive.js).
//   - O job de backup automático (lib/rotas/backup.js) não quebra nem quando
//     `ativo: true` está seedado — sem GOOGLE_CLIENT_ID/SECRET configurados,
//     o upload falha internamente e é só logado (não propagado), o backup
//     LOCAL continua sendo criado normalmente.
//   - Backup Geral não inclui backup-drive.json.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-backup-drive-518';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let cookie;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
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

function caminhoBackupDriveJson() {
  return path.join(servidor.pastaTemp, 'private', 'backup-drive.json');
}

function seedarConexao(estadoParcial) {
  fs.mkdirSync(path.join(servidor.pastaTemp, 'private'), { recursive: true });
  const estado = {
    conectado: true,
    email: 'fabrica-teste@gmail.com',
    refreshToken: 'refresh-token-de-teste-fake',
    pastaId: null,
    ativo: true,
    conectadoEm: new Date().toISOString(),
    ...estadoParcial,
  };
  fs.writeFileSync(caminhoBackupDriveJson(), JSON.stringify(estado, null, 2), 'utf8');
  return estado;
}

function limparConexaoSeedada() {
  try { fs.unlinkSync(caminhoBackupDriveJson()); } catch (_) { /* já não existia */ }
}

function status(headers = {}) {
  return fetch(`${servidor.baseUrl}/backup-drive/status`, { headers });
}

function autorizar(payload, headers = {}) {
  return fetch(`${servidor.baseUrl}/backup-drive/autorizar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

function toggle(payload, headers = {}) {
  return fetch(`${servidor.baseUrl}/backup-drive/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

function desconectar(payload, headers = {}) {
  return fetch(`${servidor.baseUrl}/backup-drive/desconectar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

test('todas as rotas exigem sessao de administrador', async () => {
  assert.equal((await status()).status, 403);
  assert.equal((await autorizar({ senha: SENHA_ADMIN })).status, 403);
  assert.equal((await toggle({ ativo: true })).status, 403);
  assert.equal((await desconectar({ senha: SENHA_ADMIN })).status, 403);
});

test('GET /backup-drive/status sem conexao nenhuma', async () => {
  limparConexaoSeedada();
  const resp = await status({ Cookie: cookie });
  const dados = await resp.json();
  assert.equal(resp.status, 200);
  assert.equal(dados.ok, true);
  assert.equal(dados.conectado, false);
  assert.equal(dados.email, null);
  assert.equal(dados.ativo, false);
  // sem GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI no ambiente (estado padrão
  // desta suite, e de qualquer instalação antes do Passo 1 do plano):
  assert.equal(dados.credenciaisConfiguradas, false);
  // nunca deve vazar refreshToken nem pastaId por essa rota:
  assert.equal(dados.refreshToken, undefined);
  assert.equal(dados.pastaId, undefined);
});

test('GET /backup-drive/status reflete uma conexao ja seedada', async () => {
  const estado = seedarConexao({ email: 'outra-conta@gmail.com', ativo: false });
  const resp = await status({ Cookie: cookie });
  const dados = await resp.json();
  assert.equal(dados.conectado, true);
  assert.equal(dados.email, estado.email);
  assert.equal(dados.ativo, false);
  limparConexaoSeedada();
});

test('POST /backup-drive/autorizar recusa senha errada (400)', async () => {
  const resp = await autorizar({ senha: 'senha-errada' }, { Cookie: cookie });
  const dados = await resp.json();
  assert.equal(resp.status, 400);
  assert.equal(dados.ok, false);
});

test('POST /backup-drive/autorizar recusa payload sem senha (400)', async () => {
  const resp = await autorizar({}, { Cookie: cookie });
  assert.equal(resp.status, 400);
});

test('POST /backup-drive/autorizar com senha certa mas sem credenciais do Google configuradas (503)', async () => {
  const resp = await autorizar({ senha: SENHA_ADMIN }, { Cookie: cookie });
  const dados = await resp.json();
  assert.equal(resp.status, 503);
  assert.equal(dados.ok, false);
  assert.match(dados.erro, /Passo 1|configurada/i);
});

test('POST /backup-drive/toggle recusa se nao ha conta conectada', async () => {
  limparConexaoSeedada();
  const resp = await toggle({ ativo: true }, { Cookie: cookie });
  assert.equal(resp.status, 400);
});

test('POST /backup-drive/toggle liga/desliga uma conexao existente', async () => {
  seedarConexao({ ativo: true });
  const respDesligar = await toggle({ ativo: false }, { Cookie: cookie });
  const dadosDesligar = await respDesligar.json();
  assert.equal(respDesligar.status, 200);
  assert.equal(dadosDesligar.ativo, false);

  const conteudoEmDisco = JSON.parse(fs.readFileSync(caminhoBackupDriveJson(), 'utf8'));
  assert.equal(conteudoEmDisco.ativo, false);
  // liga de novo, sem mexer no resto da credencial (email, refreshToken):
  const respLigar = await toggle({ ativo: true }, { Cookie: cookie });
  assert.equal((await respLigar.json()).ativo, true);

  limparConexaoSeedada();
});

test('POST /backup-drive/desconectar exige senha correta e limpa a credencial local mesmo com o Google inalcancavel', async () => {
  seedarConexao({});

  const respSenhaErrada = await desconectar({ senha: 'errada' }, { Cookie: cookie });
  assert.equal(respSenhaErrada.status, 400);
  // ainda conectado — senha errada não desconecta nada:
  assert.equal(JSON.parse(fs.readFileSync(caminhoBackupDriveJson(), 'utf8')).conectado, true);

  const respOk = await desconectar({ senha: SENHA_ADMIN }, { Cookie: cookie });
  const dadosOk = await respOk.json();
  assert.equal(respOk.status, 200);
  assert.equal(dadosOk.ok, true);

  const estadoFinal = JSON.parse(fs.readFileSync(caminhoBackupDriveJson(), 'utf8'));
  assert.equal(estadoFinal.conectado, false);
  assert.equal(estadoFinal.refreshToken, null);
});

test('Backup Geral nao inclui backup-drive.json', async () => {
  seedarConexao({});
  const resp = await fetch(`${servidor.baseUrl}/backup-geral`, { headers: { Cookie: cookie } });
  assert.equal(resp.status, 200);

  const JSZip = require('jszip');
  const buffer = Buffer.from(await resp.arrayBuffer());
  const zip = await JSZip.loadAsync(buffer);
  assert.equal(Object.keys(zip.files).includes('backup-drive.json'), false);

  limparConexaoSeedada();
});
