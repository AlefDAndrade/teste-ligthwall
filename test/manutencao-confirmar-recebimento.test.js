// ─── test/manutencao-confirmar-recebimento.test.js ──────────────────────────
// Testa o 3º portão do fluxo de peça (ver conversa que motivou isso):
// depois que a Supervisão marca "Status da Compra = Peça recebida", o
// formulário de Execução NÃO reabre direto — a Manutenção (ou
// Supervisão/Encarregado/Admin) precisa confirmar, via POST
// /manutencao/confirmar-recebimento-peca, que a peça chegou de verdade
// nas mãos, antes de dar prosseguimento. Cobre: permissão, validação de
// estado (só dá pra confirmar depois de "Peça recebida"), idempotência,
// reset da confirmação quando um NOVO pedido de peça nasce, e que o
// upsert geral nunca deixa o cliente se autoconfirmar.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-confirma-recebimento-741';
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
    id, data: '2026-07-26', setor: 'Injetora', maquina: 'M-confirma', turno: '1º TURNO',
    observador: 'joao.observador', prioridade: 'Alta', anomalia: 'Anomalia de teste',
    tipoManutencao: 'Mecânica',
    ...overrides,
  };
}

async function confirmarRecebimento(cookie, id) {
  return fetch(`${servidor.baseUrl}/manutencao/confirmar-recebimento-peca`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id }),
  });
}

// Monta um chamado até o ponto "peça recebida, aguardando confirmação":
// abre → Manutenção aceita → Manutenção pede peça → Supervisão aceita o
// pedido → Supervisão marca "Peça recebida". Retorna { id, cookieTecnico,
// cookieSupervisao }.
async function prepararChamadoComPecaRecebida(sufixo) {
  const cookieEncarregado = await cadastrarELogar('abre.confirma.' + sufixo, 'Encarregado');
  const id = 'MAN-confirma-' + sufixo + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregado },
    body: JSON.stringify(payloadBase(id)),
  });

  const cookieTecnico = await cadastrarELogar('tecnico.confirma.' + sufixo, 'Manutencao');
  await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify({ id }),
  });
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify(payloadBase(id, { aguardandoPecas: 'Sim', pecasComprar: 'Rolamento X' })),
  });

  const cookieSupervisao = await cadastrarELogar('supervisor.confirma.' + sufixo, 'Supervisao');
  await fetch(`${servidor.baseUrl}/manutencao/aceitar-pedido-peca`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisao },
    body: JSON.stringify({ id }),
  });
  const respStatus = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisao },
    body: JSON.stringify(payloadBase(id, {
      aguardandoPecas: 'Sim', pecasComprar: 'Rolamento X', statusCompra: 'Peça recebida',
      supDataFim: '2026-07-26',
    })),
  });
  assert.equal(respStatus.status, 200, 'setup: marcar "Peça recebida" deveria funcionar');
  const chamado = (await respStatus.json()).chamado;
  assert.equal(chamado.statusCompra, 'Peça recebida');
  assert.equal(chamado.recebimentoPecaConfirmado, 'Nao', 'não deveria nascer já confirmado');

  return { id, cookieTecnico, cookieSupervisao };
}

test('marcar "Peça recebida" sem Data Fim do Acompanhamento (Supervisão) é rejeitado com 400', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.confirma.semdata', 'Encarregado');
  const id = 'MAN-confirma-semdata-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregado },
    body: JSON.stringify(payloadBase(id)),
  });

  const cookieTecnico = await cadastrarELogar('tecnico.confirma.semdata', 'Manutencao');
  await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify({ id }),
  });
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify(payloadBase(id, { aguardandoPecas: 'Sim', pecasComprar: 'Rolamento X' })),
  });

  const cookieSupervisao = await cadastrarELogar('supervisor.confirma.semdata', 'Supervisao');
  await fetch(`${servidor.baseUrl}/manutencao/aceitar-pedido-peca`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisao },
    body: JSON.stringify({ id }),
  });

  // Marca "Peça recebida" SEM informar supDataFim — deveria ser rejeitado.
  const respSemData = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisao },
    body: JSON.stringify(payloadBase(id, {
      aguardandoPecas: 'Sim', pecasComprar: 'Rolamento X', statusCompra: 'Peça recebida',
    })),
  });
  assert.equal(respSemData.status, 400);
  assert.match((await respSemData.json()).erro, /Data Fim do Acompanhamento/i);

  // Com supDataFim preenchida, deveria funcionar normalmente.
  const respComData = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisao },
    body: JSON.stringify(payloadBase(id, {
      aguardandoPecas: 'Sim', pecasComprar: 'Rolamento X', statusCompra: 'Peça recebida',
      supDataFim: '2026-07-26',
    })),
  });
  assert.equal(respComData.status, 200);
  assert.equal((await respComData.json()).chamado.statusCompra, 'Peça recebida');
});

test('confirmar recebimento: Manutenção consegue confirmar, e o estado reflete quem/quando', async () => {
  const { id, cookieTecnico } = await prepararChamadoComPecaRecebida('1');

  const resp = await confirmarRecebimento(cookieTecnico, id);
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.chamado.recebimentoPecaConfirmado, 'Sim');
  assert.equal(data.chamado.recebimentoPecaConfirmadoPor, 'tecnico.confirma.1');
  assert.ok(data.chamado.recebimentoPecaConfirmadoEm);
});

test('confirmar recebimento: Supervisão e Encarregado também conseguem; Operador de Injetora não', async () => {
  const { id: id1, cookieSupervisao } = await prepararChamadoComPecaRecebida('2a');
  const respSupervisao = await confirmarRecebimento(cookieSupervisao, id1);
  assert.equal(respSupervisao.status, 200, 'Supervisão deveria poder confirmar');

  const { id: id2 } = await prepararChamadoComPecaRecebida('2b');
  const cookieEncarregado = await cadastrarELogar('encarregado.confirma.2', 'Encarregado');
  const respEncarregado = await confirmarRecebimento(cookieEncarregado, id2);
  assert.equal(respEncarregado.status, 200, 'Encarregado deveria poder confirmar');

  const { id: id3 } = await prepararChamadoComPecaRecebida('2c');
  const cookieOperador = await cadastrarELogar('operador.confirma.2', 'OperadorInjetora');
  const respOperador = await confirmarRecebimento(cookieOperador, id3);
  assert.equal(respOperador.status, 403, 'Operador de Injetora não deveria poder confirmar');
});

test('confirmar recebimento: erro 400 se a peça ainda não foi marcada como recebida', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.confirma.3', 'Encarregado');
  const id = 'MAN-confirma-3-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregado },
    body: JSON.stringify(payloadBase(id)),
  });

  const cookieTecnico = await cadastrarELogar('tecnico.confirma.3', 'Manutencao');
  await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify({ id }),
  });
  // Nenhum pedido de peça foi aberto ainda.
  const respSemPedido = await confirmarRecebimento(cookieTecnico, id);
  assert.equal(respSemPedido.status, 400);
  assert.match((await respSemPedido.json()).erro, /não tem peça marcada como recebida/i);

  // Pedido de peça aberto, mas ainda não marcado como "Peça recebida".
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify(payloadBase(id, { aguardandoPecas: 'Sim', pecasComprar: 'Rolamento X' })),
  });
  const respPendente = await confirmarRecebimento(cookieTecnico, id);
  assert.equal(respPendente.status, 400);
});

test('confirmar recebimento: idempotente — confirmar de novo não dá erro nem troca quem/quando confirmou primeiro', async () => {
  const { id, cookieTecnico, cookieSupervisao } = await prepararChamadoComPecaRecebida('4');

  const resp1 = await confirmarRecebimento(cookieTecnico, id);
  assert.equal(resp1.status, 200);
  const dataPrimeiro = (await resp1.json()).chamado;

  const resp2 = await confirmarRecebimento(cookieSupervisao, id);
  assert.equal(resp2.status, 200);
  const dataSegundo = (await resp2.json()).chamado;
  assert.equal(dataSegundo.recebimentoPecaConfirmadoPor, dataPrimeiro.recebimentoPecaConfirmadoPor, 'não deveria trocar quem confirmou primeiro');
  assert.equal(dataSegundo.recebimentoPecaConfirmadoEm, dataPrimeiro.recebimentoPecaConfirmadoEm);
});

test('confirmar recebimento: reseta pra "Nao" quando um NOVO pedido de peça nasce depois', async () => {
  const { id, cookieTecnico } = await prepararChamadoComPecaRecebida('5');
  await confirmarRecebimento(cookieTecnico, id);

  // Técnico desmarca "aguardando peças" (resolveu sem precisar mais).
  const respDesmarca = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify(payloadBase(id, { aguardandoPecas: 'Nao' })),
  });
  assert.equal((await respDesmarca.json()).chamado.recebimentoPecaConfirmado, 'Nao');

  // Um NOVO pedido de peça nasce — não deveria nascer já confirmado.
  const respNovoPedido = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify(payloadBase(id, { aguardandoPecas: 'Sim', pecasComprar: 'Outra peça' })),
  });
  const dataNovoPedido = await respNovoPedido.json();
  assert.equal(dataNovoPedido.chamado.recebimentoPecaConfirmado, 'Nao');
  assert.equal(dataNovoPedido.chamado.pedidoPecaAceito, 'Nao');
});

test('upsert geral ignora "recebimentoPecaConfirmado" mandado no payload — só a rota dedicada muda esse estado', async () => {
  const cookieEncarregado = await cadastrarELogar('abre.confirma.6', 'Encarregado');
  const id = 'MAN-confirma-6-' + Date.now();
  const respCriar = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregado },
    body: JSON.stringify(payloadBase(id, {
      recebimentoPecaConfirmado: 'Sim', recebimentoPecaConfirmadoPor: 'Ninguém',
    })),
  });
  assert.equal(respCriar.status, 200);
  const dataCriar = await respCriar.json();
  assert.equal(dataCriar.chamado.recebimentoPecaConfirmado, 'Nao', 'campo enviado no payload não deveria ser respeitado');
});

test('confirmar recebimento: erro 400 se o chamado não existe ou já está fechado', async () => {
  const cookieTecnico = await cadastrarELogar('tecnico.confirma.7', 'Manutencao');
  const respNaoExiste = await confirmarRecebimento(cookieTecnico, 'MAN-nao-existe-confirma');
  assert.equal(respNaoExiste.status, 400);
  assert.match((await respNaoExiste.json()).erro, /não encontrado/i);
});

test('confirmar recebimento: sem sessão, resposta é 403', async () => {
  const { id } = await prepararChamadoComPecaRecebida('8');
  const resp = await fetch(`${servidor.baseUrl}/manutencao/confirmar-recebimento-peca`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  assert.equal(resp.status, 403);
});
