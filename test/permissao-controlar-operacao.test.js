// ─── test/permissao-controlar-operacao.test.js ──────────────────────────────
// Testa quem pode CONTROLAR operações (iniciar/encerrar/registrar) —
// podeControlarOperacao() (server.js) — usada por POST /registrar-operacao,
// POST /registrar-relatorio-injecao, POST /salvar-operacao-andamento,
// POST /marcar-berco-andamento, POST /confirmar-tracos-hoje.
//
// Regras (modelo novo, ver lib/perfis.js, e a volta do dispositivo
// autorizado — ver conversa que motivou a mudança):
//   - As DUAS trava precisam passar ao mesmo tempo, SEM EXCEÇÃO nenhuma
//     pra nenhum perfil (nem Administrador master, nem Administrativo):
//     1) dispositivoAutorizado(deviceId) — o computador está na lista de
//        Configurações → Dispositivos Autorizados.
//     2) Permissão de PESSOA:
//        - Sem sessão de usuário nenhuma -> nunca pode controlar.
//        - Perfil de admin (Administrador master OU perfil cadastrado
//          "Administrativo") -> sempre pode, independente do campo
//          podeIniciarOperacao no cadastro (mas ainda precisa do
//          dispositivo autorizado).
//        - Qualquer outro perfil -> precisa das DUAS coisas: ter a área
//          'injetora' de edição (OperadorInjetora, Encarregado,
//          Supervisao — ver PERFIS_COM_CONTROLE_DE_OPERACAO) E
//          podeIniciarOperacao:true no cadastro.
//   - Perfil sem a área 'injetora' (AssistenteQualidade, Manutencao) nunca
//     ganha a marcação, mesmo que o payload tente forçar.
//
// A maioria dos testes abaixo usa DEVICE_ID_TESTE_PADRAO, pré-autorizado
// no before() (ver dispositivosAutorizados, servidor-teste.js) — assim
// cada teste isola a variável que quer testar (perfil) sem a trava de
// dispositivo interferir. Os testes dedicados de dispositivo (final do
// arquivo) usam um deviceId DIFERENTE, de propósito, pra provar que ele
// sozinho barra mesmo com perfil válido.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-permissao-operacao-321';
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
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 403);
  const data = await resp.json();
  assert.equal(data.ok, false);
  assert.match(data.erro, /autorizado/i);
});

test('OperadorInjetora SEM podeIniciarOperacao e recusado', async () => {
  const cookie = await cadastrarECriarSessao('joao.sem.permissao', 'OperadorInjetora', false);
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 403);
});

test('OperadorInjetora COM podeIniciarOperacao consegue controlar', async () => {
  const cookie = await cadastrarECriarSessao('maria.com.permissao', 'OperadorInjetora', true);
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
});

test('Encarregado COM podeIniciarOperacao consegue controlar (tem área injetora)', async () => {
  const cookie = await cadastrarECriarSessao('elton.encarregado', 'Encarregado', true);
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 200);
});

test('Supervisao COM podeIniciarOperacao consegue controlar (tem área injetora)', async () => {
  const cookie = await cadastrarECriarSessao('sonia.supervisao', 'Supervisao', true);
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 200);
});

test('AssistenteQualidade (sem área injetora) nunca ganha podeIniciarOperacao, mesmo tentando forcar', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respSalvar = await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'carla.qualidade', senha: 'senhateste1234', perfil: 'AssistenteQualidade', podeIniciarOperacao: true }]),
  });
  const dataSalvar = await respSalvar.json();
  const carla = dataSalvar.usuarios.find(u => u.nomeUsuario === 'carla.qualidade');
  assert.equal(carla.podeIniciarOperacao, false, 'AssistenteQualidade não tem área injetora, entao nunca deveria ganhar essa permissao');

  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'carla.qualidade', senha: 'senhateste1234' }),
  });
  const cookie = extrairCookie(respLogin);

  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 403);
});

test('Administrativo sempre pode controlar, mesmo sem podeIniciarOperacao marcado', async () => {
  const cookie = await cadastrarECriarSessao('pedro.administrativo', 'Administrativo', false);
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
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

  const resp = await fetch(`${servidor.baseUrl}/registrar-operacao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
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

// ── DISPOSITIVO AUTORIZADO (voltou — ver conversa que motivou a mudança) ──
// A partir daqui, os testes usam um deviceId DIFERENTE de propósito
// (DEVICE_ID_NAO_AUTORIZADO nunca é adicionado a dispositivosAutorizados
// no before()) — pra provar que a trava de dispositivo funciona por si
// só, mesmo com um perfil que teria permissão de sobra.
const DEVICE_ID_NAO_AUTORIZADO = 'dev_nunca_autorizado';

test('Administrador Master COM perfil irrestrito ainda e recusado se o dispositivo nao estiver autorizado', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_ID_NAO_AUTORIZADO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 403);
  const data = await resp.json();
  assert.equal(data.motivo, 'dispositivo');
  assert.match(data.erro, /dispositivo/i);
});

test('Administrativo (perfil irrestrito) tambem e recusado com dispositivo nao autorizado', async () => {
  const cookie = await cadastrarECriarSessao('ana.administrativo.device', 'Administrativo', false);
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_ID_NAO_AUTORIZADO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 403);
  const data = await resp.json();
  assert.equal(data.motivo, 'dispositivo');
});

test('OperadorInjetora COM podeIniciarOperacao mas dispositivo nao autorizado e recusado', async () => {
  const cookie = await cadastrarECriarSessao('rita.device.nao.autorizado', 'OperadorInjetora', true);
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_ID_NAO_AUTORIZADO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 403);
});

test('sem deviceId nenhum na query, e recusado por dispositivo mesmo com sessao valida', async () => {
  const cookie = await cadastrarECriarSessao('bruno.sem.device.id', 'OperadorInjetora', true);
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(resp.status, 403);
  const data = await resp.json();
  assert.equal(data.motivo, 'dispositivo');
});

test('GET /dispositivos-autorizados exige sessao de admin', async () => {
  const resp = await fetch(`${servidor.baseUrl}/dispositivos-autorizados`);
  assert.equal(resp.status, 403);
});

test('POST /autorizar-dispositivo exige sessao de admin', async () => {
  const resp = await fetch(`${servidor.baseUrl}/autorizar-dispositivo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: DEVICE_ID_NAO_AUTORIZADO, nome: 'tentativa sem sessao' }),
  });
  assert.equal(resp.status, 403);
});

test('Administrador autoriza um dispositivo novo, e ele passa a conseguir controlar; removido, volta a ser barrado', async () => {
  const deviceId = 'dev_fluxo_completo_' + Date.now();
  const cookieAdmin = await logarComoAdminMaster();

  // Garante que não sobrou "dono" de um teste anterior (rota admin, sem
  // checagem de dispositivo — ver POST /admin/resetar-operacao).
  await fetch(`${servidor.baseUrl}/admin/resetar-operacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({}),
  });

  // Antes de autorizar: barrado.
  const respAntes = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${deviceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(respAntes.status, 403);

  // Autoriza via Configurações → Dispositivos Autorizados.
  const respAutorizar = await fetch(`${servidor.baseUrl}/autorizar-dispositivo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ deviceId, nome: 'PC do teste' }),
  });
  assert.equal(respAutorizar.status, 200);
  const dataAutorizar = await respAutorizar.json();
  assert.equal(dataAutorizar.ok, true);
  assert.ok(dataAutorizar.lista.some(d => d.deviceId === deviceId && d.nome === 'PC do teste'));

  // Depois de autorizado: passa.
  const respDepois = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${deviceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(respDepois.status, 200);

  // Remove — volta a ser barrado.
  const respRemover = await fetch(`${servidor.baseUrl}/remover-dispositivo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ deviceId }),
  });
  assert.equal(respRemover.status, 200);

  const respFinal = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${deviceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(respFinal.status, 403);
});

test('modoTeste=true tambem dispensa a checagem de dispositivo (registrar-operacao)', async () => {
  const resp = await fetch(`${servidor.baseUrl}/registrar-operacao?modoTeste=true&deviceId=${DEVICE_ID_NAO_AUTORIZADO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'op-modo-teste-device-' + Date.now(), data: '2026-07-01', turno: '1° TURNO', dimensao: 9, capacidade: 20, id_bateria: 'B5' }),
  });
  assert.notEqual(resp.status, 403);
});
