// ─── test/permissao-controlar-operacao.test.js ──────────────────────────────
// Testa a substituição do sistema de "dispositivo autorizado" (deviceId
// numa lista em config.json, editável em Configurações → Autorizados —
// removido) pela permissão de PERFIL (podeIniciarOperacao no cadastro de
// usuário, ver Configurações → Usuários / lib/perfis.js), aplicada em
// podeControlarOperacao() (server.js) — usada por POST /registrar-operacao,
// POST /registrar-relatorio-injecao, POST /salvar-operacao-andamento,
// POST /marcar-berco-andamento, POST /confirmar-tracos-hoje.
//
// Regras:
//   - Sem sessão de usuário nenhuma -> nunca pode controlar.
//   - "Administrativo" -> sempre pode, independente do campo
//     podeIniciarOperacao no cadastro.
//   - Qualquer outro perfil -> só pode se podeIniciarOperacao:true no
//     cadastro (e só perfis com a página "operacao" liberada podem ter
//     essa marcação — ver lib/perfis.js, PERFIS_COM_PAGINA_OPERACAO).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-permissao-operacao-321';
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

async function cadastrarECriarSessao(nomeUsuario, perfil, podeIniciarOperacao) {
  const cookieAdmin = await logarComoAdminMaster();
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario, senha: 'senhateste1234', perfil, podeIniciarOperacao }]),
  });
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario, senha: 'senhateste1234' }),
  });
  return extrairCookie(respLogin);
}

test('sem nenhuma sessao, POST /salvar-operacao-andamento e recusado (403)', async () => {
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 403);
  const data = await resp.json();
  assert.equal(data.ok, false);
  assert.match(data.erro, /autorizado/i);
});

test('Operador SEM podeIniciarOperacao e recusado', async () => {
  const cookie = await cadastrarECriarSessao('joao.sem.permissao', 'Operador', false);
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 403);
});

test('Operador COM podeIniciarOperacao consegue controlar', async () => {
  const cookie = await cadastrarECriarSessao('maria.com.permissao', 'Operador', true);
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
});

test('Analista (perfil sem pagina operacao) nunca ganha podeIniciarOperacao, mesmo tentando forcar', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respSalvar = await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'carla.analista', senha: 'senhateste1234', perfil: 'Analista', podeIniciarOperacao: true }]),
  });
  const dataSalvar = await respSalvar.json();
  const carla = dataSalvar.usuarios.find(u => u.nomeUsuario === 'carla.analista');
  assert.equal(carla.podeIniciarOperacao, false, 'Analista nao tem a pagina operacao, entao nunca deveria ganhar essa permissao');

  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'carla.analista', senha: 'senhateste1234' }),
  });
  const cookie = extrairCookie(respLogin);

  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 403);
});

test('Administrativo sempre pode controlar, mesmo sem podeIniciarOperacao marcado', async () => {
  const cookie = await cadastrarECriarSessao('pedro.administrativo', 'Administrativo', false);
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 200);
});

test('Manutencao (sem podeIniciarOperacao, mesmo se marcado) nao consegue controlar', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respSalvar = await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'lucas.manut', senha: 'senhateste1234', perfil: 'Manutencao', podeIniciarOperacao: true }]),
  });
  const dataSalvar = await respSalvar.json();
  const lucas = dataSalvar.usuarios.find(u => u.nomeUsuario === 'lucas.manut');
  assert.equal(lucas.podeIniciarOperacao, false);

  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'lucas.manut', senha: 'senhateste1234' }),
  });
  const cookie = extrairCookie(respLogin);

  const resp = await fetch(`${servidor.baseUrl}/registrar-operacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: 'op-teste-lucas', data: '2026-07-01', turno: '1° TURNO', dimensao: 9, capacidade: 20, id_bateria: 'B5' }),
  });
  assert.equal(resp.status, 403);
});

test('modoTeste=true dispensa a checagem de permissao (registrar-operacao)', async () => {
  const resp = await fetch(`${servidor.baseUrl}/registrar-operacao?modoTeste=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'op-modo-teste-' + Date.now(), data: '2026-07-01', turno: '1° TURNO', dimensao: 9, capacidade: 20, id_bateria: 'B5' }),
  });
  // Sem sessao nenhuma, mas modoTeste=true — nao deveria dar 403 por
  // causa de permissao (pode ate falhar por outro motivo de validacao,
  // mas nao por falta de autorizacao).
  assert.notEqual(resp.status, 403);
});
