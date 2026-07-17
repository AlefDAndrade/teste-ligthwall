// ─── test/manutencao-fluxo-recusa.test.js ───────────────────────────────────
// Testa o fluxo de RECUSA de chamado corretivo (ver conversa que motivou
// isso): em vez de aceitar, quem estaria aceitando (Manutenção/Admin/
// Supervisão/Encarregado) pode recusar o chamado com um motivo (POST
// /manutencao/solicitar-recusa-corretiva). Vira uma pendência pra Admin/
// Supervisão/Encarregado revisarem (POST /manutencao/responder-recusa-corretiva):
// se aceitam a recusa, o chamado é encerrado; se negam, o chamado volta
// pra Manutenção dar prosseguimento (nem aceito nem recusado).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-fluxo-recusa-444';
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
    id, data: '2026-07-16', setor: 'Injetora', maquina: 'M-recusa', turno: '1º TURNO',
    observador: 'joao.observador.recusa', prioridade: 'Alta', anomalia: 'Anomalia de teste',
    tipoManutencao: 'Mecânica',
    ...overrides,
  };
}

async function abrirChamado(cookie, id) {
  return fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(payloadBase(id)),
  });
}

test('solicitar recusa exige motivo não vazio', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.recusa1', 'Encarregado');
  const id = 'MAN-recusa-1-' + Date.now();
  await abrirChamado(cookieEncarregado, id);

  const cookieManutencao = await cadastrarELogar('tecnico.recusa1', 'Manutencao');
  const resp = await fetch(`${servidor.baseUrl}/manutencao/solicitar-recusa-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id, motivo: '   ' }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /motivo/i);
});

test('perfil não elegível (Operador de Injetora) não pode solicitar nem responder recusa', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.recusa2', 'Encarregado');
  const id = 'MAN-recusa-2-' + Date.now();
  await abrirChamado(cookieEncarregado, id);

  const cookieOperador = await cadastrarELogar('operador.recusa2', 'OperadorInjetora');
  const respSolicitar = await fetch(`${servidor.baseUrl}/manutencao/solicitar-recusa-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieOperador },
    body: JSON.stringify({ id, motivo: 'Não é da minha área' }),
  });
  assert.equal(respSolicitar.status, 403);

  const respResponder = await fetch(`${servidor.baseUrl}/manutencao/responder-recusa-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieOperador },
    body: JSON.stringify({ id, aceitaRecusa: true }),
  });
  assert.equal(respResponder.status, 403);
});

test('Manutenção NÃO pode responder a própria recusa (só Supervisão/Encarregado/Admin)', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.recusa3', 'Encarregado');
  const id = 'MAN-recusa-3-' + Date.now();
  await abrirChamado(cookieEncarregado, id);

  const cookieManutencao = await cadastrarELogar('tecnico.recusa3', 'Manutencao');
  const respSolicitar = await fetch(`${servidor.baseUrl}/manutencao/solicitar-recusa-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id, motivo: 'Chamado duplicado' }),
  });
  assert.equal(respSolicitar.status, 200);
  const dataSolicitar = await respSolicitar.json();
  assert.equal(dataSolicitar.chamado.recusaPendente, 'Sim');
  assert.equal(dataSolicitar.chamado.recusaMotivo, 'Chamado duplicado');
  assert.equal(dataSolicitar.chamado.recusaSolicitadoPor, 'tecnico.recusa3');

  const respResponder = await fetch(`${servidor.baseUrl}/manutencao/responder-recusa-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id, aceitaRecusa: true }),
  });
  assert.equal(respResponder.status, 403);
});

test('não é possível solicitar recusa de um chamado já aceito, nem solicitar 2 recusas ao mesmo tempo', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.recusa4', 'Encarregado');
  const id = 'MAN-recusa-4-' + Date.now();
  await abrirChamado(cookieEncarregado, id);

  const cookieManutencao = await cadastrarELogar('tecnico.recusa4', 'Manutencao');
  await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id }),
  });
  const respRecusaPosAceite = await fetch(`${servidor.baseUrl}/manutencao/solicitar-recusa-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id, motivo: 'Mudei de ideia' }),
  });
  assert.equal(respRecusaPosAceite.status, 400);

  const id2 = 'MAN-recusa-4b-' + Date.now();
  await abrirChamado(cookieEncarregado, id2);
  await fetch(`${servidor.baseUrl}/manutencao/solicitar-recusa-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id: id2, motivo: 'Primeira recusa' }),
  });
  const respSegundaRecusa = await fetch(`${servidor.baseUrl}/manutencao/solicitar-recusa-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id: id2, motivo: 'Segunda recusa' }),
  });
  assert.equal(respSegundaRecusa.status, 400);
});

test('Encarregado NEGA a recusa: chamado volta pra Manutenção dar prosseguimento (nem aceito, nem fechado)', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.recusa5', 'Encarregado');
  const id = 'MAN-recusa-5-' + Date.now();
  await abrirChamado(cookieEncarregado, id);

  const cookieManutencao = await cadastrarELogar('tecnico.recusa5', 'Manutencao');
  await fetch(`${servidor.baseUrl}/manutencao/solicitar-recusa-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id, motivo: 'Achei que não era da Manutenção' }),
  });

  const cookieEncarregadoRevisor = await cadastrarELogar('revisor.recusa5', 'Encarregado');
  const respNegar = await fetch(`${servidor.baseUrl}/manutencao/responder-recusa-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregadoRevisor },
    body: JSON.stringify({ id, aceitaRecusa: false }),
  });
  assert.equal(respNegar.status, 200);
  const dataNegar = await respNegar.json();
  assert.equal(dataNegar.chamado.recusaPendente, 'Nao');
  assert.equal(dataNegar.chamado.recusaResultado, 'Negada');
  assert.equal(dataNegar.chamado.aceito, 'Nao');
  assert.equal(dataNegar.chamado.etiquetaFechada, false);

  // Manutenção agora consegue aceitar normalmente e dar prosseguimento.
  const respAceitarDepois = await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id }),
  });
  assert.equal(respAceitarDepois.status, 200);
  assert.equal((await respAceitarDepois.json()).chamado.aceito, 'Sim');
});

test('Admin ACEITA a recusa: chamado é encerrado (situação "Recusado", etiqueta fechada)', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.recusa6', 'Encarregado');
  const id = 'MAN-recusa-6-' + Date.now();
  await abrirChamado(cookieEncarregado, id);

  const cookieManutencao = await cadastrarELogar('tecnico.recusa6', 'Manutencao');
  await fetch(`${servidor.baseUrl}/manutencao/solicitar-recusa-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id, motivo: 'Chamado de teste, não é real' }),
  });

  const cookieAdmin = await logarComoAdminMaster();
  const respAceitarRecusa = await fetch(`${servidor.baseUrl}/manutencao/responder-recusa-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ id, aceitaRecusa: true }),
  });
  assert.equal(respAceitarRecusa.status, 200);
  const dataAceitarRecusa = await respAceitarRecusa.json();
  assert.equal(dataAceitarRecusa.chamado.recusaPendente, 'Nao');
  assert.equal(dataAceitarRecusa.chamado.recusaResultado, 'Aceita');
  assert.equal(dataAceitarRecusa.chamado.etiquetaFechada, true);
  assert.equal(dataAceitarRecusa.chamado.situacao, 'Recusado');

  // Não é mais possível aceitar/excluir um chamado já encerrado por recusa.
  const respAceitarDepois = await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id }),
  });
  assert.equal(respAceitarDepois.status, 400);
});

test('não é possível aceitar um chamado que tem recusa pendente de revisão', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.recusa7', 'Encarregado');
  const id = 'MAN-recusa-7-' + Date.now();
  await abrirChamado(cookieEncarregado, id);

  const cookieManutencao = await cadastrarELogar('tecnico.recusa7', 'Manutencao');
  await fetch(`${servidor.baseUrl}/manutencao/solicitar-recusa-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieManutencao },
    body: JSON.stringify({ id, motivo: 'Teste' }),
  });

  const cookieOutroTecnico = await cadastrarELogar('tecnico2.recusa7', 'Manutencao');
  const respAceitar = await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieOutroTecnico },
    body: JSON.stringify({ id }),
  });
  assert.equal(respAceitar.status, 400);
  const data = await respAceitar.json();
  assert.match(data.erro, /pendente/i);
});
