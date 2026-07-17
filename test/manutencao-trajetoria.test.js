// ─── test/manutencao-trajetoria.test.js ─────────────────────────────────────
// Testa o registro de VISUALIZAÇÃO do chamado (ver conversa que motivou
// isso): POST /manutencao/visualizar-corretiva marca a 1ª pessoa que
// abriu o relatório (idempotente — só a 1ª conta), e generaliza pra
// "Administrador" quando quem visualizou tem poderes de admin (master ou
// perfil Administrativo), sem expor qual admin específico foi.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-trajetoria-555';
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

async function cadastrarELogar(nomeUsuario, perfil) {
  const cookieAdmin = await logarComoAdminMaster();
  const respAtuais = await fetch(`${servidor.baseUrl}/usuarios`);
  const { usuarios: atuais } = await respAtuais.json();
  const listaParaEnviar = [
    ...atuais.map(u => ({ id: u.id, nomeUsuario: u.nomeUsuario, perfil: u.perfil, podeIniciarOperacao: u.podeIniciarOperacao })),
    { nomeUsuario, senha: 'senhateste1234', perfil },
  ];
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify(listaParaEnviar),
  });
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario, senha: 'senhateste1234' }),
  });
  return extrairCookie(respLogin);
}

function payloadBase(id, overrides = {}) {
  return {
    id, data: '2026-07-16', setor: 'Injetora', maquina: 'M-traj', turno: '1º TURNO',
    observador: 'joao.observador.traj', prioridade: 'Alta', anomalia: 'Anomalia de teste',
    tipoManutencao: 'Mecânica',
    ...overrides,
  };
}

test('1ª visualização registra quem viu; visualizações seguintes não sobrescrevem', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.traj1', 'Encarregado');
  const id = 'MAN-traj-1-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregado },
    body: JSON.stringify(payloadBase(id)),
  });

  const cookieManutencao = await cadastrarELogar('tecnico.traj1', 'Manutencao');
  const resp1 = await fetch(`${servidor.baseUrl}/manutencao/visualizar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id }),
  });
  assert.equal(resp1.status, 200);
  const data1 = await resp1.json();
  assert.equal(data1.chamado.visualizadoPor, 'tecnico.traj1');
  assert.ok(data1.chamado.visualizadoEm);

  const cookieSupervisao = await cadastrarELogar('supervisor.traj1', 'Supervisao');
  const resp2 = await fetch(`${servidor.baseUrl}/manutencao/visualizar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisao },
    body: JSON.stringify({ id }),
  });
  assert.equal(resp2.status, 200);
  const data2 = await resp2.json();
  assert.equal(data2.chamado.visualizadoPor, 'tecnico.traj1', 'a 2ª visualização não deveria sobrescrever quem viu primeiro');
});

test('visualização por Admin (master) grava só "Administrador", sem expor qual admin', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.traj2', 'Encarregado');
  const id = 'MAN-traj-2-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregado },
    body: JSON.stringify(payloadBase(id)),
  });

  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/manutencao/visualizar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ id }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.chamado.visualizadoPor, 'Administrador');
});

test('visualização por perfil Administrativo (cadastrado) também grava só "Administrador"', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.traj3', 'Encarregado');
  const id = 'MAN-traj-3-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregado },
    body: JSON.stringify(payloadBase(id)),
  });

  const cookieAdministrativo = await cadastrarELogar('admcadastrado.traj3', 'Administrativo');
  const resp = await fetch(`${servidor.baseUrl}/manutencao/visualizar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdministrativo },
    body: JSON.stringify({ id }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.chamado.visualizadoPor, 'Administrador');
});

test('visualizadoPor/visualizadoEm sobrevivem a um salvamento normal do chamado (upsert geral preserva)', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.traj4', 'Encarregado');
  const id = 'MAN-traj-4-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregado },
    body: JSON.stringify(payloadBase(id)),
  });

  const cookieManutencao = await cadastrarELogar('tecnico.traj4', 'Manutencao');
  await fetch(`${servidor.baseUrl}/manutencao/visualizar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id }),
  });

  // Encarregado edita a abertura do chamado (tentando, no payload,
  // "limpar" visualizadoPor — deve ser ignorado, igual aos campos de
  // aceite/recusa).
  const respEditar = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregado },
    body: JSON.stringify(payloadBase(id, { anomalia: 'Anomalia atualizada', visualizadoPor: null })),
  });
  assert.equal(respEditar.status, 200);
  const dataEditar = await respEditar.json();
  assert.equal(dataEditar.chamado.visualizadoPor, 'tecnico.traj4', 'visualizadoPor não deveria ser apagável via upsert geral');
});
