// ─── test/bateria-atual-nao-enchido.test.js ─────────────────────────────────
// Testa ponta-a-ponta (servidor HTTP real, ver test/helpers/servidor-teste.js)
// o novo estado "🚫 Não Enchido" do card Bateria Atual:
//   1. POST /marcar-berco-andamento com estado:'nao_enchido' marca o lado.
//   2. GET /bercos-andamento reflete essa marcação enquanto a operação está
//      em andamento.
//   3. Clicar de novo no mesmo indicador desmarca (volta a 'okay'),
//      independente de qual "estado" for mandado no 2º clique.
//   4. Ao registrar a operação (POST /registrar-operacao), o estado
//      'nao_enchido' é persistido em bercos_visuais.
//   5. GET /operacoes-nao-avaliadas devolve "bercos_visuais" (usado pelo
//      Setor de Qualidade — ver _aplicarPaineisNaoEnchidos/
//      _removerPaineisNaoEnchidosDaGrade, setor-qualidade.js) com o estado
//      correto.
//
// Diferente de test/setor-qualidade-*.test.js (que testam só o SCRIPT DE
// FRONT-END num DOM headless) — aqui é o servidor de verdade respondendo
// por HTTP, mesmo padrão de test/auth.test.js.
//
// As rotas de controle de operação (salvar-operacao-andamento,
// marcar-berco-andamento, registrar-operacao) exigem uma sessão de
// USUÁRIO logado com permissão de controlar operações E um dispositivo
// autorizado (voltou — ver conversa que motivou a mudança — ver
// podeControlarOperacao(), server.js). Este teste cadastra um usuário
// Administrativo (sempre pode controlar, ver lib/perfis.js) e usa o
// cookie de sessão emitido no login em todas as chamadas, além de um
// deviceId pré-autorizado (DEVICE_ID_TESTE_PADRAO, ver
// dispositivosAutorizados no before()).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

let servidor;
let cookieUsuario;

const SENHA_ADMIN = 'senha-admin-nao-enchido-789';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

function extrairCookie(resposta) {
  const setCookie = resposta.headers.get('set-cookie') || '';
  return setCookie.split(';')[0] || null;
}

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
  });

  const respAdmin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  const cookieAdmin = extrairCookie(respAdmin);

  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([
      { nomeUsuario: 'operador.teste.ne', senha: 'senhateste123', perfil: 'Administrativo' },
    ]),
  });

  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'operador.teste.ne', senha: 'senhateste123' }),
  });
  cookieUsuario = extrairCookie(respLogin);
});

after(async () => {
  await servidor.parar();
});

// Operação mínima em andamento — mesmo formato que operacao.js manda pra
// POST /salvar-operacao-andamento (persist()). Só os campos que as rotas
// testadas realmente leem precisam de valor real.
const OPERACAO_ANDAMENTO = {
  id_bateria: 'B5',
  tipo_montagem: 'SP',
  status: 'ativa',
};

async function iniciarOperacaoEmAndamento() {
  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify({ dados: OPERACAO_ANDAMENTO, clientId: 'teste' }),
  });
  assert.equal(resp.status, 200, 'deveria conseguir iniciar a operação em andamento');
}

test('POST /marcar-berco-andamento com estado "nao_enchido" marca o lado, e GET /bercos-andamento reflete', async () => {
  await iniciarOperacaoEmAndamento();

  const respMarcar = await fetch(`${servidor.baseUrl}/marcar-berco-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify({ berco: 'B3', lado: 'esquerda', estado: 'nao_enchido' }),
  });
  assert.equal(respMarcar.status, 200);
  const corpoMarcar = await respMarcar.json();
  assert.equal(corpoMarcar.ok, true);
  assert.equal(corpoMarcar.estado, 'nao_enchido', 'a resposta deveria confirmar o estado aplicado');

  const bercos = await fetch(`${servidor.baseUrl}/bercos-andamento`).then(r => r.json());
  assert.equal(bercos.B3?.esquerda, 'nao_enchido');
  assert.equal(bercos.B3?.direita, undefined, 'o lado direito não foi tocado, deveria continuar ausente (okay)');
});

test('clicar de novo no mesmo lado desmarca (volta a "okay"), mesmo mandando um "estado" diferente no 2º clique', async () => {
  await iniciarOperacaoEmAndamento();

  await fetch(`${servidor.baseUrl}/marcar-berco-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify({ berco: 'B9', lado: 'direita', estado: 'nao_enchido' }),
  });
  let bercos = await fetch(`${servidor.baseUrl}/bercos-andamento`).then(r => r.json());
  assert.equal(bercos.B9?.direita, 'nao_enchido');

  // 2º clique manda estado:'baixou' (simula o botão "Marcar Não Enchido"
  // tendo sido desligado entre os dois cliques) — mesmo assim, como o lado
  // já estava marcado, deve DESMARCAR, nunca trocar nao_enchido por baixou
  // num clique só (ver comentário em POST /marcar-berco-andamento).
  const respDesmarcar = await fetch(`${servidor.baseUrl}/marcar-berco-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify({ berco: 'B9', lado: 'direita', estado: 'baixou' }),
  });
  const corpoDesmarcar = await respDesmarcar.json();
  assert.equal(corpoDesmarcar.estado, 'okay');

  bercos = await fetch(`${servidor.baseUrl}/bercos-andamento`).then(r => r.json());
  assert.equal(bercos.B9?.direita, undefined, 'deveria ter voltado a okay (chave ausente), não trocado pra baixou');
});

test('POST /marcar-berco-andamento rejeita um "estado" desconhecido', async () => {
  await iniciarOperacaoEmAndamento();
  const resp = await fetch(`${servidor.baseUrl}/marcar-berco-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify({ berco: 'B1', lado: 'esquerda', estado: 'xyz' }),
  });
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);
});

test('registrar a operação persiste "nao_enchido" em bercos_visuais, e GET /operacoes-nao-avaliadas devolve isso pro Setor de Qualidade', async () => {
  await iniciarOperacaoEmAndamento();

  await fetch(`${servidor.baseUrl}/marcar-berco-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify({ berco: 'B4', lado: 'esquerda', estado: 'nao_enchido' }),
  });

  const idOperacao = 'op-teste-nao-enchido-' + Date.now();
  const respRegistrar = await fetch(`${servidor.baseUrl}/registrar-operacao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify({
      id: idOperacao,
      data: '2026-07-01',
      turno: '1° TURNO',
      dimensao: 9,
      capacidade: 20,
      id_bateria: 'B5',
      inicio: '2026-07-01T10:00:00.000Z',
      fim: '2026-07-01T14:00:00.000Z',
      tipo_montagem: 'SP',
      bercos_reais: 20,
    }),
  });
  assert.equal(respRegistrar.status, 200, await respRegistrar.text());

  const fila = await fetch(`${servidor.baseUrl}/operacoes-nao-avaliadas`).then(r => r.json());
  const item = fila.find(op => op.id === idOperacao);
  assert.ok(item, 'a operação recém-registrada deveria estar na fila de não avaliadas');
  assert.ok(Array.isArray(item.bercos_visuais), 'bercos_visuais deveria vir como array');

  const berco4 = item.bercos_visuais.find(b => b.berco === 'B4' || b.ordem === 4);
  assert.ok(berco4, 'berço B4 deveria estar presente em bercos_visuais');
  assert.equal(berco4.estado_esquerda, 'nao_enchido');
  assert.equal(berco4.estado_direita, 'okay');
});
