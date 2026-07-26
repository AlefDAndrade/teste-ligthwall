// ─── test/manutencao-renotificar.test.js ────────────────────────────────────
// Testa o botão "Renotificar" (ver conversa que motivou isso): nas telas
// onde um chamado ou um pedido de peça está "Aguardando Aceite", só
// Encarregado, Supervisão, Administrativo ou Admin Master podem reenviar a
// notificação push de quem está pendente de aceitar (perfil Manutenção fica
// de fora — é quem executa, não quem cobra o aceite). Cobre a rota POST
// /manutencao/renotificar: checagem de perfil (403 pros não elegíveis),
// validação de que o aceite em questão AINDA está pendente (senão erro
// 400 — nada a renotificar), e que "tipo" escolhe corretamente entre
// renotificar o chamado (abertura) ou o pedido de peça.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-renotificar-951';
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
    id, data: '2026-07-26', setor: 'Injetora', maquina: 'M-renotificar', turno: '1º TURNO',
    observador: 'joao.observador', prioridade: 'Alta', anomalia: 'Anomalia de teste',
    tipoManutencao: 'Mecânica',
    ...overrides,
  };
}

async function abrirChamado(cookieAutor, idPrefixo) {
  const id = idPrefixo + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const resp = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAutor },
    body: JSON.stringify(payloadBase(id)),
  });
  assert.equal(resp.status, 200, 'setup: abertura do chamado deveria funcionar');
  return id;
}

async function renotificar(cookie, id, tipo) {
  return fetch(`${servidor.baseUrl}/manutencao/renotificar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id, tipo }),
  });
}

// ── Permissão: quem pode renotificar o CHAMADO (abertura, aguardando
// aceite da Manutenção) ─────────────────────────────────────────────────

test('renotificar chamado: Encarregado, Supervisão e Admin Master (via sessão mestra) conseguem; Manutenção e Operador não', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.renotif.1', 'Encarregado');
  const id = await abrirChamado(cookieEncarregado, 'MAN-renotif-1');

  const cookieManutencao = await cadastrarELogar('tecnico.renotif.1', 'Manutencao');
  const respManutencao = await renotificar(cookieManutencao, id, 'chamado');
  assert.equal(respManutencao.status, 403, 'perfil Manutenção não deveria poder renotificar');

  const cookieOperador = await cadastrarELogar('operador.renotif.1', 'OperadorInjetora');
  const respOperador = await renotificar(cookieOperador, id, 'chamado');
  assert.equal(respOperador.status, 403, 'Operador de Injetora não deveria poder renotificar');

  const cookieSupervisao = await cadastrarELogar('supervisor.renotif.1', 'Supervisao');
  const respSupervisao = await renotificar(cookieSupervisao, id, 'chamado');
  assert.equal(respSupervisao.status, 200, 'Supervisão deveria poder renotificar');

  const respEncarregado = await renotificar(cookieEncarregado, id, 'chamado');
  assert.equal(respEncarregado.status, 200, 'Encarregado deveria poder renotificar');

  const cookieAdminMaster = await logarComoAdminMaster();
  const respAdminMaster = await renotificar(cookieAdminMaster, id, 'chamado');
  assert.equal(respAdminMaster.status, 200, 'Admin Master deveria poder renotificar');
});

test('renotificar chamado: perfil Administrativo (Admin cadastrado) também consegue', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.renotif.2', 'Encarregado');
  const id = await abrirChamado(cookieEncarregado, 'MAN-renotif-2');

  const cookieAdministrativo = await cadastrarELogar('admin.renotif.2', 'Administrativo');
  const resp = await renotificar(cookieAdministrativo, id, 'chamado');
  assert.equal(resp.status, 200, 'perfil Administrativo deveria poder renotificar');
});

test('renotificar chamado: erro 400 se o chamado já foi aceito (nada a renotificar)', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.renotif.3', 'Encarregado');
  const id = await abrirChamado(cookieEncarregado, 'MAN-renotif-3');

  const cookieManutencao = await cadastrarELogar('tecnico.renotif.3', 'Manutencao');
  const respAceitar = await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id }),
  });
  assert.equal(respAceitar.status, 200);

  const respRenotificar = await renotificar(cookieEncarregado, id, 'chamado');
  assert.equal(respRenotificar.status, 400);
  const dataRenotificar = await respRenotificar.json();
  assert.equal(dataRenotificar.ok, false);
  assert.match(dataRenotificar.erro, /já foi aceito/i);
});

test('renotificar chamado: erro 400 se o chamado não existe', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.renotif.4', 'Encarregado');
  const resp = await renotificar(cookieEncarregado, 'MAN-nao-existe-renotif', 'chamado');
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);
  assert.match(data.erro, /não encontrado/i);
});

// ── Permissão: quem pode renotificar o PEDIDO DE PEÇA (aguardando aceite
// da Supervisão) ─────────────────────────────────────────────────────────

test('renotificar pedido de peça: Supervisão consegue; Manutenção (quem abriu o pedido) não', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.renotif.5', 'Encarregado');
  const id = await abrirChamado(cookieEncarregado, 'MAN-renotif-5');

  const cookieManutencao = await cadastrarELogar('tecnico.renotif.5', 'Manutencao');
  await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id }),
  });
  const respPedido = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify(payloadBase(id, { situacao: 'Em Manutencao', aguardandoPecas: 'Sim', pecasComprar: 'Rolamento X' })),
  });
  assert.equal(respPedido.status, 200);
  assert.equal((await respPedido.json()).chamado.pedidoPecaAceito, 'Nao');

  const respTecnico = await renotificar(cookieManutencao, id, 'pedidoPeca');
  assert.equal(respTecnico.status, 403, 'Manutenção não deveria poder renotificar o próprio pedido de peça');

  const cookieSupervisao = await cadastrarELogar('supervisor.renotif.5', 'Supervisao');
  const respSupervisao = await renotificar(cookieSupervisao, id, 'pedidoPeca');
  assert.equal(respSupervisao.status, 200, 'Supervisão deveria poder renotificar o pedido de peça');
});

test('renotificar pedido de peça: erro 400 se não há pedido de peça pendente', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.renotif.6', 'Encarregado');
  const id = await abrirChamado(cookieEncarregado, 'MAN-renotif-6');

  // Nenhum pedido de peça foi aberto ainda.
  const respSemPedido = await renotificar(cookieEncarregado, id, 'pedidoPeca');
  assert.equal(respSemPedido.status, 400);
  const dataSemPedido = await respSemPedido.json();
  assert.match(dataSemPedido.erro, /não tem pedido de peça/i);
});

test('renotificar pedido de peça: erro 400 se o pedido já foi aceito', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.renotif.7', 'Encarregado');
  const id = await abrirChamado(cookieEncarregado, 'MAN-renotif-7');

  const cookieManutencao = await cadastrarELogar('tecnico.renotif.7', 'Manutencao');
  await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id }),
  });
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify(payloadBase(id, { situacao: 'Em Manutencao', aguardandoPecas: 'Sim', pecasComprar: 'Rolamento X' })),
  });

  const cookieSupervisao = await cadastrarELogar('supervisor.renotif.7', 'Supervisao');
  const respAceitarPeca = await fetch(`${servidor.baseUrl}/manutencao/aceitar-pedido-peca`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisao },
    body: JSON.stringify({ id }),
  });
  assert.equal(respAceitarPeca.status, 200);

  const respRenotificar = await renotificar(cookieSupervisao, id, 'pedidoPeca');
  assert.equal(respRenotificar.status, 400);
  const dataRenotificar = await respRenotificar.json();
  assert.match(dataRenotificar.erro, /não tem pedido de peça/i);
});

test('renotificar: sem sessão nenhuma, resposta é 403 (não autenticado não é perfil elegível)', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.renotif.8', 'Encarregado');
  const id = await abrirChamado(cookieEncarregado, 'MAN-renotif-8');

  const resp = await fetch(`${servidor.baseUrl}/manutencao/renotificar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, tipo: 'chamado' }),
  });
  assert.equal(resp.status, 403);
});
