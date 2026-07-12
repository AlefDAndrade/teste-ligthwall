// ─── test/backup-dados-vs-geral.test.js ─────────────────────────────────────
// Testa a reformulação de Backup de Dados vs Backup Geral (ver conversa
// que motivou isso):
//   - Backup de Dados: só dados de produção da fábrica (operações,
//     traços, paradas, qualidade etc) — sem config.json nem identidade.
//   - Backup Geral: dados de produção + config.json + identidade/acesso
//     (security.json, usuarios.json) — sem código-fonte (isso saiu; tem
//     controle de versão próprio, ver Git).
//   - Restaurar um Backup Geral de uma instalação MAIS ANTIGA (sem
//     security.json/usuarios.json, que não existiam antes da Fase A)
//     preserva o cadastro de usuários/senha do Administrador Master já
//     existentes, em vez de apagar ou dar erro.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-backup-categorias-987';
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

const ARQUIVOS_DADOS_MINIMOS = {
  'config.json': JSON.stringify({ baterias: { ids: [] }, tipos_montagem: { opcoes: [] } }),
  'historico.json': '[]',
  'historico_edicoes.json': '[]',
  'relatorio_edicoes.json': '[]',
  'relatorio_injecao.json': '[]',
  'contador_tracos.json': '{}',
  'sobra.json': '{}',
  'paradas.json': '[]',
  'ajustes_tracos.json': '[]',
  'metas.json': '{}',
  'bercos_visuais.json': '[]',
  'avaliacoes_qualidade.json': '[]',
  'operacoes_avaliadas.json': '[]',
  'operacoes_nao_avaliadas.json': '[]',
};

test('GET /backup-dados exige sessao de administrador', async () => {
  const resp = await fetch(`${servidor.baseUrl}/backup-dados`);
  assert.equal(resp.status, 403);
});

test('GET /backup-geral exige sessao de administrador', async () => {
  const resp = await fetch(`${servidor.baseUrl}/backup-geral`);
  assert.equal(resp.status, 403);
});

test('Backup de Dados nao inclui config.json, security.json ou usuarios.json', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/backup-dados`, { headers: { Cookie: cookieAdmin } });
  assert.equal(resp.status, 200);

  const buffer = Buffer.from(await resp.arrayBuffer());
  const zip = await JSZip.loadAsync(buffer);
  const arquivos = Object.keys(zip.files);

  assert.ok(arquivos.includes('historico.json'), 'deveria incluir dados de producao');
  assert.ok(arquivos.includes('paradas.json'), 'deveria incluir dados de producao');
  assert.ok(!arquivos.includes('config.json'), 'config.json e exclusivo do Backup Geral');
  assert.ok(!arquivos.includes('security.json'), 'security.json e exclusivo do Backup Geral');
  assert.ok(!arquivos.includes('usuarios.json'), 'usuarios.json e exclusivo do Backup Geral');
});

test('Backup Geral inclui dados de producao + config.json + identidade/acesso, sem codigo-fonte', async () => {
  const cookieAdmin = await logarComoAdminMaster();

  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'no.zip.geral', senha: 'senhateste1234', perfil: 'Operador', podeIniciarOperacao: true }]),
  });

  const resp = await fetch(`${servidor.baseUrl}/backup-geral`, { headers: { Cookie: cookieAdmin } });
  assert.equal(resp.status, 200);

  const buffer = Buffer.from(await resp.arrayBuffer());
  const zip = await JSZip.loadAsync(buffer);
  const arquivos = Object.keys(zip.files);

  assert.ok(arquivos.includes('historico.json'));
  assert.ok(arquivos.includes('config.json'));
  assert.ok(arquivos.includes('security.json'));
  assert.ok(arquivos.includes('usuarios.json'));
  assert.ok(!arquivos.includes('server.js'), 'codigo-fonte nao deveria mais entrar no Backup Geral');
  assert.ok(!arquivos.includes('package.json'), 'codigo-fonte nao deveria mais entrar no Backup Geral');

  const usuariosZip = JSON.parse(await zip.file('usuarios.json').async('string'));
  assert.ok(usuariosZip.some(u => u.nomeUsuario === 'no.zip.geral'));
});

test('restaurar um Backup Geral de instalacao ANTIGA (sem usuarios/security) preserva o cadastro atual', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'preservado.migracao', senha: 'senhamigracao1', perfil: 'Operador', podeIniciarOperacao: true }]),
  });

  const resp = await fetch(`${servidor.baseUrl}/restaurar-backup-geral`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN, confirmacao: 'RESTAURAR TUDO', arquivos: ARQUIVOS_DADOS_MINIMOS }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);

  const respUsuarios = await fetch(`${servidor.baseUrl}/usuarios`);
  const { usuarios } = await respUsuarios.json();
  assert.ok(usuarios.some(u => u.nomeUsuario === 'preservado.migracao'), 'usuario cadastrado antes deveria ter sido preservado');

  const respLoginPreservado = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'preservado.migracao', senha: 'senhamigracao1' }),
  });
  assert.equal(respLoginPreservado.status, 200, 'a senha do usuario preservado deveria continuar funcionando');

  const respSenhaAdmin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  const dataSenhaAdmin = await respSenhaAdmin.json();
  assert.equal(dataSenhaAdmin.ok, true, 'a senha do Admin Master deveria continuar a mesma');
});

test('restaurar um Backup Geral com usuarios.json presente SUBSTITUI o cadastro normalmente', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'sera.substituido', senha: 'senhasub1234', perfil: 'Operador', podeIniciarOperacao: true }]),
  });

  const usuariosDoBackup = [
    {
      id: 'id-restaurado-999',
      nomeUsuario: 'veio.do.backup',
      senhaHash: crypto.createHash('sha256').update('qualquer-coisa', 'utf8').digest('hex'),
      perfil: 'Analista',
      podeIniciarOperacao: false,
      atalhos: {},
    },
  ];

  const resp = await fetch(`${servidor.baseUrl}/restaurar-backup-geral`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      senha: SENHA_ADMIN,
      confirmacao: 'RESTAURAR TUDO',
      arquivos: { ...ARQUIVOS_DADOS_MINIMOS, 'usuarios.json': JSON.stringify(usuariosDoBackup) },
    }),
  });
  assert.equal(resp.status, 200);

  const respUsuarios = await fetch(`${servidor.baseUrl}/usuarios`);
  const { usuarios } = await respUsuarios.json();
  assert.equal(usuarios.length, 1);
  assert.equal(usuarios[0].nomeUsuario, 'veio.do.backup');
  assert.ok(!usuarios.some(u => u.nomeUsuario === 'sera.substituido'), 'cadastro anterior deveria ter sido substituido');
});

test('restaurar Backup Geral sem config.json (obrigatorio) e recusado', async () => {
  const { 'config.json': _omitido, ...semConfig } = ARQUIVOS_DADOS_MINIMOS;
  const resp = await fetch(`${servidor.baseUrl}/restaurar-backup-geral`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN, confirmacao: 'RESTAURAR TUDO', arquivos: semConfig }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);
  assert.match(data.erro, /config\.json/);
});

test('restaurar Backup Geral com frase de confirmacao errada e recusado', async () => {
  const resp = await fetch(`${servidor.baseUrl}/restaurar-backup-geral`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN, confirmacao: 'frase errada', arquivos: ARQUIVOS_DADOS_MINIMOS }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /confirmação/i);
});

test('restaurar Backup de Dados continua funcionando (sem regressao)', async () => {
  const resp = await fetch(`${servidor.baseUrl}/restaurar-backup-dados`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN, arquivos: ARQUIVOS_DADOS_MINIMOS }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
  assert.ok(data.backupSeguranca);
});
