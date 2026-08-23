// ─── test/operacao-andamento-master-driblados-dono.test.js ─────────────────
// Testa que o Administrador Master (sessão de senha mestra OU usuário
// logado com perfil Administrativo) NUNCA fica travado pela disputa de
// "dono da operação" (ver donoDeviceId, lib/rotas/operacao-andamento.js) —
// pedido explícito do usuário: quem operou o dispositivo A começou a
// operação (virou "dono"), mas o Master, NUM DISPOSITIVO B TAMBÉM
// AUTORIZADO, ainda precisa poder pausar/trocar traço/marcar berço
// livremente, sem precisar "🗑️ Limpar Tudo" (que reseta tudo e tira o
// controle de quem estava operando).
//
// Continua exigindo dispositivo autorizado (sem exceção nenhuma pra
// nenhum perfil, ver dispositivoAutorizado()/podeControlarOperacao() em
// lib/dispositivo-autorizado.js) — só a disputa de DONO entre dois
// dispositivos JÁ autorizados é que o Master dribla.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-master-dribla-dono-999';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

// Dois deviceIds distintos, os DOIS pré-autorizados — simula o
// computador de quem iniciou a operação (DEVICE_OPERADOR) e o computador
// onde o Master está logado agora (DEVICE_MASTER).
const DEVICE_OPERADOR = 'device-operador-inicia-a-operacao';
const DEVICE_MASTER = 'device-master-dribla-dono';
const DEVICE_OUTRO_NAO_MASTER = 'device-outro-nao-master';

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_OPERADOR, DEVICE_MASTER, DEVICE_OUTRO_NAO_MASTER],
  });
});

after(async () => {
  await servidor.parar();
});

// Limpa a operação em andamento antes de cada teste, pra nenhum teste
// herdar o "dono" de um teste anterior.
beforeEach(async () => {
  const cookieAdmin = await logarComoAdminMaster();
  await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_MASTER}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ dados: null, clientId: 'setup' }),
  });
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

test('OperadorInjetora inicia a operação (vira dono) no DEVICE_OPERADOR', async () => {
  const cookieOperador = await cadastrarECriarSessao('joana.opera', 'OperadorInjetora', true);
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_OPERADOR}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOperador },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 200);
});

test('outro OperadorInjetora, em OUTRO dispositivo autorizado, é barrado (409) — comportamento de sempre', async () => {
  const cookieOperador = await cadastrarECriarSessao('joana.opera2', 'OperadorInjetora', true);
  await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_OPERADOR}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOperador },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });

  const cookieOutro = await cadastrarECriarSessao('carlos.outro', 'Encarregado', true);
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_OUTRO_NAO_MASTER}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOutro },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'pausada' }, clientId: 'y' }),
  });
  assert.equal(resp.status, 409);
  const data = await resp.json();
  assert.equal(data.ok, false);
  assert.match(data.erro, /controlada por outra pessoa/i);
});

test('Master (sessão de senha mestra) DRIBLA a trava de dono em POST /salvar-operacao-andamento', async () => {
  // joana inicia a operação no dispositivo dela — vira dona.
  const cookieOperador = await cadastrarECriarSessao('joana.opera3', 'OperadorInjetora', true);
  await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_OPERADOR}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOperador },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });

  // Master, em outro dispositivo (também autorizado), tenta pausar —
  // não é o dono, mas deve conseguir mesmo assim.
  const cookieMaster = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_MASTER}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieMaster },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'pausada' }, clientId: 'master' }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
});

test('Master (usuário logado com perfil Administrativo) TAMBÉM dribla a trava de dono', async () => {
  const cookieOperador = await cadastrarECriarSessao('joana.opera4', 'OperadorInjetora', true);
  await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_OPERADOR}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOperador },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });

  const cookieAdministrativo = await cadastrarECriarSessao('marcos.admin', 'Administrativo', false);
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_MASTER}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdministrativo },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'pausada' }, clientId: 'admin' }),
  });
  assert.equal(resp.status, 200);
});

test('depois do Master mexer, o dono ORIGINAL continua sendo o dono (Master não "rouba" a posse)', async () => {
  const cookieOperador = await cadastrarECriarSessao('joana.opera5', 'OperadorInjetora', true);
  await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_OPERADOR}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOperador },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });

  const cookieMaster = await logarComoAdminMaster();
  await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_MASTER}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieMaster },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'pausada' }, clientId: 'master' }),
  });

  // O operador original (mesmo device de antes) continua conseguindo
  // mandar dados normalmente — a posse nunca saiu dele.
  const respOperador = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_OPERADOR}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOperador },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(respOperador.status, 200);

  // ...e outro dispositivo qualquer (não Master, não o dono original)
  // continua sendo barrado normalmente.
  const cookieOutro = await cadastrarECriarSessao('carlos.outro2', 'Encarregado', true);
  const respOutro = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_OUTRO_NAO_MASTER}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOutro },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'y' }),
  });
  assert.equal(respOutro.status, 409);
});

test('Master, MAS num dispositivo NÃO autorizado, continua barrado (403) — dispositivo não tem exceção pra ninguém', async () => {
  const cookieMaster = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=device-nunca-autorizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieMaster },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'master' }),
  });
  assert.equal(resp.status, 403);
});

test('Master dribla a trava de dono em POST /marcar-berco-andamento também', async () => {
  const cookieOperador = await cadastrarECriarSessao('joana.opera6', 'OperadorInjetora', true);
  await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_OPERADOR}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOperador },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });

  const cookieMaster = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/marcar-berco-andamento?deviceId=${DEVICE_MASTER}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieMaster },
    body: JSON.stringify({ berco: 'B1', lado: 'esquerda', estado: 'baixou' }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
});

test('sem ser Master, outro dispositivo continua barrado (409) em POST /marcar-berco-andamento', async () => {
  const cookieOperador = await cadastrarECriarSessao('joana.opera7', 'OperadorInjetora', true);
  await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_OPERADOR}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOperador },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });

  const cookieOutro = await cadastrarECriarSessao('carlos.outro3', 'Encarregado', true);
  const resp = await fetch(`${servidor.baseUrl}/marcar-berco-andamento?deviceId=${DEVICE_OUTRO_NAO_MASTER}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOutro },
    body: JSON.stringify({ berco: 'B1', lado: 'esquerda', estado: 'baixou' }),
  });
  assert.equal(resp.status, 409);
});
