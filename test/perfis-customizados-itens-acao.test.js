// ─── test/perfis-customizados-itens-acao.test.js ────────────────────────────
// README, pendências — "Perfis customizados: só front-end por enquanto":
// marcar um item de "Outros" (Importar Documentos, Exportações, Edição dos
// Dados, Backup e Restauração) num perfil customizado não concedia acesso
// real nenhum no backend — só o front escondia/mostrava.
//
// Resolvido nesta tarefa em 3 frentes bem diferentes (ver comentário de
// PERMISSÃO em lib/rotas/importacao.js e lib/rotas/backup.js):
//   1) 'export-interativo'/'export-excel' — nunca dependeram de
//      temPoderesDeAdmin pra valer (exportação roda no cliente ou usa rota
//      já aberta a qualquer sessão de usuário) — nada a testar aqui.
//   2) 'edicao-dados' — já valia de verdade via podeEditarArea('injetora'),
//      coberto por test/permissoes-por-area.test.js (histórico de
//      operações/traços) — não duplicado aqui.
//   3) 'importar-documentos'/'backup-restauracao' — GENUINAMENTE exigiam
//      sessaoOuAdmin antes; agora usam `podeUsarItem` (lib/permissoes-
//      area.js), testado abaixo.
//
// Cobre: sem sessão → 403; perfil customizado SEM o item → 403; perfil
// customizado COM o item "total" → passa; Admin Master e perfil fixo
// "Administrador" continuam irrestritos (comportamento de sempre); as
// rotas de RESTAURAR/MESCLAR backup (destrutivas) continuam exigindo a
// senha do Admin Master mesmo pra quem tem o item — `podeUsarItem` nunca
// substitui essa camada.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-itens-acao-753';
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

async function criarPerfilComPermissoes(nome, permissoes) {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome, permissoes }),
  });
  const { perfil } = await resp.json();
  return perfil;
}

async function cadastrarELogar(nomeUsuario, perfilId) {
  const cookieAdmin = await logarComoAdminMaster();
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario, senha: 'senhateste1234', perfil: perfilId }]),
  });
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario, senha: 'senhateste1234' }),
  });
  return extrairCookie(respLogin);
}

// ═══════════════════════════════════════════════════════════════════════
// Sem sessão nenhuma
// ═══════════════════════════════════════════════════════════════════════

test('sem sessão nenhuma, POST /importar-historico é recusado (403)', async () => {
  const resp = await fetch(`${servidor.baseUrl}/importar-historico`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([]),
  });
  assert.equal(resp.status, 403);
});

test('sem sessão nenhuma, GET /backup-dados é recusado (403)', async () => {
  const resp = await fetch(`${servidor.baseUrl}/backup-dados`);
  assert.equal(resp.status, 403);
});

// ═══════════════════════════════════════════════════════════════════════
// 'importar-documentos'
// ═══════════════════════════════════════════════════════════════════════

test('perfil customizado SEM "importar-documentos" total é recusado em POST /importar-historico', async () => {
  const perfil = await criarPerfilComPermissoes('Sem Importar', { paradas: 'total' });
  const cookieUsuario = await cadastrarELogar('sem.importar.custom', perfil.id);

  const resp = await fetch(`${servidor.baseUrl}/importar-historico`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify([]),
  });
  assert.equal(resp.status, 403);
});

test('perfil customizado COM "importar-documentos" total consegue de fato importar (ponte funciona)', async () => {
  const perfil = await criarPerfilComPermissoes('Pode Importar', { 'importar-documentos': 'total' });
  const cookieUsuario = await cadastrarELogar('pode.importar.custom', perfil.id);

  const resp = await fetch(`${servidor.baseUrl}/importar-historico`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify([]), // lista vazia é payload válido — só confirma que passou do gate de permissão
  });
  assert.equal(resp.status, 200);
});

// ═══════════════════════════════════════════════════════════════════════
// 'backup-restauracao'
// ═══════════════════════════════════════════════════════════════════════

test('perfil customizado SEM "backup-restauracao" total é recusado em GET /backup-dados', async () => {
  const perfil = await criarPerfilComPermissoes('Sem Backup', { paradas: 'total' });
  const cookieUsuario = await cadastrarELogar('sem.backup.custom', perfil.id);

  const resp = await fetch(`${servidor.baseUrl}/backup-dados`, { headers: { Cookie: cookieUsuario } });
  assert.equal(resp.status, 403);
});

test('perfil customizado COM "backup-restauracao" total consegue de fato baixar um backup (ponte funciona)', async () => {
  const perfil = await criarPerfilComPermissoes('Pode Backup', { 'backup-restauracao': 'total' });
  const cookieUsuario = await cadastrarELogar('pode.backup.custom', perfil.id);

  const resp = await fetch(`${servidor.baseUrl}/backup-dados`, { headers: { Cookie: cookieUsuario } });
  assert.equal(resp.status, 200);
  assert.match(resp.headers.get('content-type') || '', /application\/zip|application\/octet-stream/);
});

test('perfil customizado COM "backup-restauracao" total consegue ver GET /backup-drive/status', async () => {
  const perfil = await criarPerfilComPermissoes('Pode Backup Drive', { 'backup-restauracao': 'total' });
  const cookieUsuario = await cadastrarELogar('pode.backupdrive.custom', perfil.id);

  const resp = await fetch(`${servidor.baseUrl}/backup-drive/status`, { headers: { Cookie: cookieUsuario } });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
});

test('mesmo COM "backup-restauracao" total, POST /restaurar-backup-dados continua exigindo a senha do Admin Master (não vira "livre")', async () => {
  const perfil = await criarPerfilComPermissoes('Pode Backup Mas Nao Restaura', { 'backup-restauracao': 'total' });
  const cookieUsuario = await cadastrarELogar('pode.backup.restaura.custom', perfil.id);

  const resp = await fetch(`${servidor.baseUrl}/restaurar-backup-dados`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify({ senha: 'senha-errada-de-proposito', arquivos: {} }),
  });
  // 400 (senha incorreta) — nunca 200: a rota nem checa sessão/perfil,
  // só a senha mestra, então o item concedido não muda nada aqui.
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /senha/i);
});

// ═══════════════════════════════════════════════════════════════════════
// Admin Master / perfil fixo "Administrador" continuam irrestritos
// ═══════════════════════════════════════════════════════════════════════

test('Admin Master continua irrestrito (sem precisar de nenhum item marcado)', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/backup-dados`, { headers: { Cookie: cookieAdmin } });
  assert.equal(resp.status, 200);
});

test('perfil fixo "Administrador" (Administrativo) continua irrestrito, sem override nenhum', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'admin.fixo.itens', senha: 'senhateste1234', perfil: 'Administrativo' }]),
  });
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'admin.fixo.itens', senha: 'senhateste1234' }),
  });
  const cookieUsuario = extrairCookie(respLogin);

  const respBackup = await fetch(`${servidor.baseUrl}/backup-dados`, { headers: { Cookie: cookieUsuario } });
  assert.equal(respBackup.status, 200);

  const respImportar = await fetch(`${servidor.baseUrl}/importar-historico`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify([]),
  });
  assert.equal(respImportar.status, 200);
});

// ═══════════════════════════════════════════════════════════════════════
// GET /perfis expõe itensAcaoPorPerfil pro front (ver app-core.js, _perfilTemAcao)
// ═══════════════════════════════════════════════════════════════════════

test('GET /perfis inclui itensAcaoPorPerfil, com "Administrativo" sempre tendo todos os itens de ação', async () => {
  const resp = await fetch(`${servidor.baseUrl}/perfis`);
  const data = await resp.json();
  assert.equal(data.ok, true);
  assert.ok(data.itensAcaoPorPerfil, 'esperava o campo itensAcaoPorPerfil na resposta');
  assert.ok(data.itensAcaoPorPerfil.Administrativo.includes('importar-documentos'));
  assert.ok(data.itensAcaoPorPerfil.Administrativo.includes('backup-restauracao'));
  assert.ok(data.itensAcaoPorPerfil.Administrativo.includes('edicao-dados'));
});

test('GET /perfis: perfil customizado só aparece com os itens de ação que de fato marcou', async () => {
  const perfil = await criarPerfilComPermissoes('Perfil Itens Parciais', {
    'importar-documentos': 'total',
    'backup-restauracao': 'visualizar', // "visualizar" não é "total" — não deveria contar
  });
  const resp = await fetch(`${servidor.baseUrl}/perfis`);
  const data = await resp.json();
  assert.deepEqual(data.itensAcaoPorPerfil[perfil.id], ['importar-documentos']);
});

test('GET /perfis: perfil fixo (não-Administrativo) sem override nunca tem itens de ação', async () => {
  const resp = await fetch(`${servidor.baseUrl}/perfis`);
  const data = await resp.json();
  assert.deepEqual(data.itensAcaoPorPerfil.OperadorInjetora, []);
});
