// ─── test/backup-sincronizar-automatico.test.js ─────────────────────────────
// Pendência revisada (conversa que motivou a mudança): antes, "Backup de
// Dados"/"Backup Geral" manuais e o job automático diário eram 100%
// independentes — fazer um backup manual nunca afetava
// backups-automaticos/. Agora existe POST /sincronizar-backup-automatico
// (lib/rotas/backup.js), chamado OPCIONALMENTE pelo front depois de um
// backup manual bem-sucedido (a pessoa escolhe, nunca automático — ver
// _perguntarSincronizarBackupAutomatico, app-core.js): sobrescreve
// backups-automaticos/backup-dados_<hoje>.zip com o MESMO conteúdo do
// manual (tipo 'dados' ou 'geral') e reinicia a retenção de 3 dias.
//
// Cobre: exige permissão; cria o arquivo de hoje quando ainda não existe;
// SOBRESCREVE (conteúdo muda) quando já existe; 'geral' inclui
// config.json/usuarios.json que 'dados' não inclui; o job agendado não
// reescreve por cima de um dia já sincronizado manualmente (mesma checagem
// de "já existe" de sempre).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-sincronizar-auto-357';
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

function caminhoBackupAutoDeHoje() {
  const hoje = new Date().toISOString().slice(0, 10); // aproximação suficiente pro teste (não cruza fuso)
  return path.join(servidor.pastaTemp, 'backups-automaticos', `backup-dados_${hoje}.zip`);
}

async function sincronizar(cookie, tipo) {
  return fetch(`${servidor.baseUrl}/sincronizar-backup-automatico`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ tipo }),
  });
}

test('sem sessão nenhuma, POST /sincronizar-backup-automatico é recusado (403), nenhum arquivo é criado', async () => {
  const resp = await sincronizar(null, 'dados');
  assert.equal(resp.status, 403);
  assert.equal(fs.existsSync(caminhoBackupAutoDeHoje()), false);
});

test('tipo "dados": cria o arquivo automático de hoje do zero (ainda não existia)', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await sincronizar(cookie, 'dados');
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
  assert.equal(data.tipo, 'dados');

  const caminho = caminhoBackupAutoDeHoje();
  assert.equal(fs.existsSync(caminho), true, 'esperava o arquivo criado em backups-automaticos/');

  const zip = await JSZip.loadAsync(fs.readFileSync(caminho));
  assert.ok(zip.file('historico.json'), 'backup "dados" deveria conter historico.json');
  assert.equal(zip.file('config.json'), null, 'backup "dados" NÃO deveria conter config.json (isso é só do Geral)');
});

test('tipo "geral": SOBRESCREVE o arquivo de hoje (mesmo nome), agora incluindo config/usuarios', async () => {
  const cookie = await logarComoAdminMaster();
  const caminho = caminhoBackupAutoDeHoje();
  const mtimeAntes = fs.statSync(caminho).mtimeMs;

  // Pequena espera pra garantir mtime diferente de forma confiável em
  // qualquer sistema de arquivos (alguns têm resolução de 1s).
  await new Promise(r => setTimeout(r, 1100));

  const resp = await sincronizar(cookie, 'geral');
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.tipo, 'geral');

  assert.equal(fs.existsSync(caminho), true, 'continua sendo o MESMO arquivo/nome — não cria um segundo');
  const mtimeDepois = fs.statSync(caminho).mtimeMs;
  assert.ok(mtimeDepois > mtimeAntes, 'o arquivo deveria ter sido reescrito (mtime mais novo)');

  const zip = await JSZip.loadAsync(fs.readFileSync(caminho));
  assert.ok(zip.file('historico.json'), 'backup "geral" também contém os dados de produção');
  assert.ok(zip.file('config.json'), 'backup "geral" deveria incluir config.json');
  assert.ok(zip.file('security.json'), 'backup "geral" deveria incluir security.json (identidade/acesso)');
});

test('perfil customizado COM "backup-restauracao" total também consegue sincronizar (ponte de permissão funciona)', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respCriar = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Pode Sincronizar Backup', permissoes: { 'backup-restauracao': 'total' } }),
  });
  const { perfil } = await respCriar.json();
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'sincroniza.backup.custom', senha: 'senhateste1234', perfil: perfil.id }]),
  });
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'sincroniza.backup.custom', senha: 'senhateste1234' }),
  });
  const cookieUsuario = extrairCookie(respLogin);

  const resp = await sincronizar(cookieUsuario, 'dados');
  assert.equal(resp.status, 200);
});

test('tipo ausente/inválido no payload cai no padrão "dados" (nunca quebra, nunca vira "geral" por acidente)', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/sincronizar-backup-automatico`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ tipo: 'qualquer-coisa-invalida' }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.tipo, 'dados');
});
