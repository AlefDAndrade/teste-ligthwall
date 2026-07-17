// ─── test/manutencao-fluxo-aceite.test.js ───────────────────────────────────
// Testa o novo fluxo de aceite de chamado corretivo (ver conversa que
// motivou isso): editar Abertura/Detalhes de um chamado já existente
// agora é restrito a quem abriu, Admin, Supervisão ou Encarregado; os
// campos de Execução só ficam disponíveis depois que ALGUM dos 4 perfis
// (Manutenção/Admin/Supervisão/Encarregado) aceitar o chamado (POST
// /manutencao/aceitar-corretiva); e os campos de Acompanhamento da
// Supervisão só ficam disponíveis depois que Supervisão/Encarregado/Admin
// aceitarem o pedido de peça (POST /manutencao/aceitar-pedido-peca).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-fluxo-aceite-333';
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
    id, data: '2026-07-16', setor: 'Injetora', maquina: 'M-fluxo', turno: '1º TURNO',
    observador: 'joao.observador', prioridade: 'Alta', anomalia: 'Anomalia de teste',
    tipoManutencao: 'Mecânica',
    ...overrides,
  };
}

test('perfil Manutenção NÃO consegue editar Abertura/Detalhes de um chamado que não abriu', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.chamado.fluxo1', 'Encarregado');
  const id = 'MAN-fluxo-1-' + Date.now();
  const respAbrir = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregado },
    body: JSON.stringify(payloadBase(id)),
  });
  assert.equal(respAbrir.status, 200);

  const cookieManutencao = await cadastrarELogar('tecnico.fluxo1', 'Manutencao');
  const respEditar = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify(payloadBase(id, { setor: 'Setor Alterado Indevidamente' })),
  });
  assert.equal(respEditar.status, 403, 'Manutenção não deveria conseguir editar abertura de chamado alheio');
});

test('perfil Manutenção consegue aceitar o chamado, e só depois consegue salvar a Execução', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.chamado.fluxo2', 'Encarregado');
  const id = 'MAN-fluxo-2-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregado },
    body: JSON.stringify(payloadBase(id)),
  });

  const cookieManutencao = await cadastrarELogar('tecnico.fluxo2', 'Manutencao');

  // Antes de aceitar, nem tenta editar (o front nem mostraria os campos),
  // mas confirmamos que o servidor também recusaria mudanças de Execução.
  const respAntes = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify(payloadBase(id, { situacao: 'Em Manutencao' })),
  });
  assert.equal(respAntes.status, 403, 'não deveria conseguir mexer na Execução antes de aceitar');

  const respAceitar = await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id }),
  });
  assert.equal(respAceitar.status, 200);
  const dataAceitar = await respAceitar.json();
  assert.equal(dataAceitar.chamado.aceito, 'Sim');
  assert.equal(dataAceitar.chamado.aceitoPor, 'tecnico.fluxo2');
  assert.ok(dataAceitar.chamado.aceitoEm);

  // Agora sim, consegue salvar a Execução.
  const respDepois = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify(payloadBase(id, { situacao: 'Em Manutencao', responsavel: 'Técnico X' })),
  });
  assert.equal(respDepois.status, 200);
  const dataDepois = await respDepois.json();
  assert.equal(dataDepois.chamado.situacao, 'Em Manutencao');
  assert.equal(dataDepois.chamado.responsavel, 'Técnico X');
  // A abertura não deveria ter sido alterada por essa gravação (o técnico
  // continua sem poder editar Abertura/Detalhes).
  assert.equal(dataDepois.chamado.setor, 'Injetora');
});

test('perfil não elegível (Operador de Injetora) não consegue aceitar chamado nem pedido de peça', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.chamado.fluxo3', 'Encarregado');
  const id = 'MAN-fluxo-3-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregado },
    body: JSON.stringify(payloadBase(id)),
  });

  const cookieOperador = await cadastrarELogar('operador.fluxo3', 'OperadorInjetora');
  const respAceitar = await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieOperador },
    body: JSON.stringify({ id }),
  });
  assert.equal(respAceitar.status, 403);

  const respAceitarPeca = await fetch(`${servidor.baseUrl}/manutencao/aceitar-pedido-peca`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieOperador },
    body: JSON.stringify({ id }),
  });
  assert.equal(respAceitarPeca.status, 403);
});

test('pedido de peça: perfil Manutenção NÃO pode aceitar; Supervisão pode, e libera o Acompanhamento', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.chamado.fluxo4', 'Encarregado');
  const id = 'MAN-fluxo-4-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregado },
    body: JSON.stringify(payloadBase(id)),
  });

  const cookieManutencao = await cadastrarELogar('tecnico.fluxo4', 'Manutencao');
  await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id }),
  });
  // Técnico marca que está aguardando peça.
  const respMarcaPeca = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify(payloadBase(id, { aguardandoPecas: 'Sim', pecasComprar: 'Rolamento X' })),
  });
  assert.equal(respMarcaPeca.status, 200);
  assert.equal((await respMarcaPeca.json()).chamado.pedidoPecaAceito, 'Nao', 'pedido de peça não deveria nascer já aceito');

  // Manutenção tenta aceitar o próprio pedido de peça — recusado.
  const respTecnicoAceita = await fetch(`${servidor.baseUrl}/manutencao/aceitar-pedido-peca`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id }),
  });
  assert.equal(respTecnicoAceita.status, 403);

  // Supervisão aceita.
  const cookieSupervisao = await cadastrarELogar('supervisor.fluxo4', 'Supervisao');
  const respSupervisaoAceita = await fetch(`${servidor.baseUrl}/manutencao/aceitar-pedido-peca`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisao },
    body: JSON.stringify({ id }),
  });
  assert.equal(respSupervisaoAceita.status, 200);
  const dataSupervisao = await respSupervisaoAceita.json();
  assert.equal(dataSupervisao.chamado.pedidoPecaAceito, 'Sim');
  assert.equal(dataSupervisao.chamado.pedidoPecaAceitoPor, 'supervisor.fluxo4');

  // Agora sim, Supervisão consegue salvar o Acompanhamento.
  const respAcompanhamento = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisao },
    body: JSON.stringify(payloadBase(id, {
      aguardandoPecas: 'Sim', pecasComprar: 'Rolamento X',
      statusCompra: 'Em Análise', respSupervisor: 'Supervisor Y',
    })),
  });
  assert.equal(respAcompanhamento.status, 200);
  const dataAcompanhamento = await respAcompanhamento.json();
  assert.equal(dataAcompanhamento.chamado.statusCompra, 'Em Análise');
});

test('upsert geral ignora "aceito"/"pedidoPecaAceito" mandados no payload — só as rotas dedicadas mudam esse estado', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.chamado.fluxo5', 'Encarregado');
  const id = 'MAN-fluxo-5-' + Date.now();
  const respCriar = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregado },
    // Tenta se autoaceitar direto no payload de criação — deve ser ignorado.
    body: JSON.stringify(payloadBase(id, { aceito: 'Sim', aceitoPor: 'Ninguém', pedidoPecaAceito: 'Sim' })),
  });
  assert.equal(respCriar.status, 200);
  const dataCriar = await respCriar.json();
  assert.equal(dataCriar.chamado.aceito, 'Nao', 'campo "aceito" enviado no payload não deveria ser respeitado');
  assert.equal(dataCriar.chamado.pedidoPecaAceito, 'Nao');
});
