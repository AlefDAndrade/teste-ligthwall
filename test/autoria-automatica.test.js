// ─── test/autoria-automatica.test.js ────────────────────────────────────────
// Testa a remoção da "Identidade Leve de Operador" (perguntava PIN à
// parte do login toda vez que registrava algo — ver conversa que
// motivou a remoção) em favor de autoria AUTOMÁTICA: quem está logado
// (usuário+senha) já tem nome próprio, não precisa perguntar de novo.
//
// Cobre: rotas antigas de operadores removidas, e as rotas que gravam
// operador_nome/avaliadorNome (registrar-operacao,
// registrar-avaliacao-qualidade) — via HTTP direto, servidor real.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-autoria-999';
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
    { nomeUsuario, senha: 'senhateste1234', perfil, podeIniciarOperacao: true },
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

test('rotas de operadores (Identidade Leve) nao existem mais', async () => {
  const respLista = await fetch(`${servidor.baseUrl}/operadores`);
  assert.equal(respLista.status, 404);

  const respVerificar = await fetch(`${servidor.baseUrl}/verificar-operador`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operadorId: 'x', pin: '1234' }),
  });
  assert.equal(respVerificar.status, 404);

  const respSalvar = await fetch(`${servidor.baseUrl}/salvar-operadores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([]),
  });
  assert.equal(respSalvar.status, 404);
});

test('operador_nome enviado no registro de operacao e persistido e devolvido em GET /db/historico.json', async () => {
  const cookie = await cadastrarELogar('ana.autoria', 'Operador');
  const idOp = 'op-autoria-' + Date.now();

  const respRegistrar = await fetch(`${servidor.baseUrl}/registrar-operacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: idOp, data: '2026-07-12', turno: '1° TURNO', dimensao: 9, capacidade: 20,
      id_bateria: 'B5', operador_nome: 'ana.autoria',
    }),
  });
  assert.equal(respRegistrar.status, 200);

  const respHistorico = await fetch(`${servidor.baseUrl}/db/historico.json`);
  const historico = await respHistorico.json();
  const opSalva = historico.find(o => o.id === idOp);
  assert.ok(opSalva, 'operacao deveria estar no historico');
  assert.equal(opSalva.operador_nome, 'ana.autoria');
});

test('registrar operacao sem operador_nome (ex: modoTeste) fica com o campo null, sem quebrar', async () => {
  const idOp = 'op-sem-autoria-' + Date.now();
  const resp = await fetch(`${servidor.baseUrl}/registrar-operacao?modoTeste=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: idOp, data: '2026-07-12', turno: '1° TURNO', dimensao: 9, capacidade: 20, id_bateria: 'B5' }),
  });
  assert.notEqual(resp.status, 500);
});

test('avaliadorNome enviado no registro de avaliacao de qualidade e persistido e devolvido em GET /avaliacoes-qualidade', async () => {
  const cookie = await cadastrarELogar('bruno.autoria', 'Administrativo');
  const idOp = 'op-para-avaliar-' + Date.now();

  await fetch(`${servidor.baseUrl}/registrar-operacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: idOp, data: '2026-07-12', turno: '1° TURNO', dimensao: 9, capacidade: 20, id_bateria: 'B5' }),
  });

  const idAvaliacao = 'ev-autoria-' + Date.now();
  const respAvaliacao = await fetch(`${servidor.baseUrl}/registrar-avaliacao-qualidade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: idAvaliacao,
      batteryId: 'B5',
      linkedOperacaoId: idOp,
      turno: '1° TURNO',
      avaliadorNome: 'bruno.autoria',
      paineis: [],
    }),
  });
  assert.equal(respAvaliacao.status, 200);

  const respAvaliacoes = await fetch(`${servidor.baseUrl}/avaliacoes-qualidade`);
  const avaliacoes = await respAvaliacoes.json();
  const avSalva = avaliacoes.find(a => a.id === idAvaliacao);
  assert.ok(avSalva, 'avaliacao deveria estar na lista');
  assert.equal(avSalva.avaliadorNome, 'bruno.autoria');
});

test('avaliacao sem avaliadorNome fica com o campo ausente/null, sem quebrar', async () => {
  const cookie = await cadastrarELogar('carla.autoria', 'Administrativo');
  const idOp = 'op-sem-avaliador-' + Date.now();

  await fetch(`${servidor.baseUrl}/registrar-operacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: idOp, data: '2026-07-12', turno: '1° TURNO', dimensao: 9, capacidade: 20, id_bateria: 'B5' }),
  });

  const idAvaliacao = 'ev-sem-avaliador-' + Date.now();
  const resp = await fetch(`${servidor.baseUrl}/registrar-avaliacao-qualidade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: idAvaliacao, batteryId: 'B5', linkedOperacaoId: idOp, turno: '1° TURNO', paineis: [] }),
  });
  assert.equal(resp.status, 200);

  const respAvaliacoes = await fetch(`${servidor.baseUrl}/avaliacoes-qualidade`);
  const avaliacoes = await respAvaliacoes.json();
  const avSalva = avaliacoes.find(a => a.id === idAvaliacao);
  assert.ok(avSalva);
  assert.ok(!avSalva.avaliadorNome, 'sem avaliadorNome enviado, deveria ficar ausente/falsy');
});
