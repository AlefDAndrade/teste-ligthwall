// ─── test/relatorio-bercos-filtros.test.js ──────────────────────────────────
// Testa os filtros novos do Relatório de Berços (voltou — ver conversa
// que motivou a mudança): Tipo de Montagem, Tipo de Bateria, Vazamento
// (com/sem) e busca por ID da Operação — além do filtro de período por
// data que já existia. Todos client-side, sobre o mesmo _cache já
// carregado (ver carregar()/aplicarFiltros(), relatorio-bercos.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-relatorio-bercos-753';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor, dom, window, document;

// A tela abre com os últimos 30 dias (ver _aplicarPeriodoPadrao em
// relatorio-bercos.js) — as operações "atuais" do teste são registradas
// 3 dias atrás, e uma operação ANTIGA (60 dias atrás) serve pra conferir
// que o período padrão a esconde e o "✕ Limpar" a traz de volta.
function diasAtras(n) {
  return new Date(Date.now() - 3 * 3600 * 1000 - n * 86400 * 1000).toISOString().split('T')[0];
}
const DATA_RECENTE = diasAtras(3);
const DATA_ANTIGA = diasAtras(60);

function extrairCookie(resposta) {
  const setCookie = resposta.headers.get('set-cookie') || '';
  return setCookie.split(';')[0] || null;
}

async function iniciarOperacaoEmAndamento(cookie, idBateria, tipoMontagem) {
  await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dados: { id_bateria: idBateria, tipo_montagem: tipoMontagem, status: 'ativa' }, clientId: 'teste' }),
  });
}

async function registrarOperacao(cookie, { id, idBateria, tipoMontagem, comVazamento, data = DATA_RECENTE }) {
  await iniciarOperacaoEmAndamento(cookie, idBateria, tipoMontagem);
  if (comVazamento) {
    await fetch(`${servidor.baseUrl}/marcar-berco-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ berco: 'B1', lado: 'esquerda', estado: 'baixou' }),
    });
  }
  const resp = await fetch(`${servidor.baseUrl}/registrar-operacao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id, data, turno: '1° TURNO', dimensao: 9, capacidade: 20,
      id_bateria: idBateria, tipo_montagem: tipoMontagem,
      inicio: `${data}T10:00:00.000Z`, fim: `${data}T14:00:00.000Z`,
    }),
  });
  assert.equal(resp.status, 200, await resp.text());
}

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
  });

  const respLogin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  const cookieAdmin = extrairCookie(respLogin);

  // 3 operações — combinações diferentes de propósito, pra cada filtro
  // isolar exatamente 1 delas.
  await registrarOperacao(cookieAdmin, { id: 'op-filtro-sp-b5', idBateria: 'B5', tipoMontagem: 'SP', comVazamento: false });
  await registrarOperacao(cookieAdmin, { id: 'op-filtro-2p-b6-vazou', idBateria: 'B6', tipoMontagem: '2P', comVazamento: true });
  await registrarOperacao(cookieAdmin, { id: 'op-filtro-2p-b5', idBateria: 'B5', tipoMontagem: '2P', comVazamento: false });
  // Mesma combinação da op-filtro-sp-b5 (SP/B5, sem vazamento), de
  // propósito: não muda as opções dos dropdowns nem o resultado dos
  // filtros abaixo — só o período padrão decide se ela aparece.
  await registrarOperacao(cookieAdmin, { id: 'op-filtro-antiga', idBateria: 'B5', tipoMontagem: 'SP', comVazamento: false, data: DATA_ANTIGA });

  // Garante que não sobrou "operação em andamento" nenhuma antes de abrir
  // a página — sem isso, o WebSocket de sincronização ao vivo (ver
  // operacao.js, _aplicarEstadoExterno) pode receber um snapshot num
  // formato inesperado logo ao conectar e gerar um erro assíncrono sem
  // relação nenhuma com os filtros testados aqui.
  await fetch(`${servidor.baseUrl}/admin/resetar-operacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({}),
  });

  dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        const headers = { ...(opts && opts.headers), Cookie: cookieAdmin };
        return fetch(absoluta, { ...opts, headers });
      };
    },
  });
  window = dom.window;
  document = window.document;
  window.sessionStorage.setItem('lw_role', 'Administrador');
  await new Promise(r => setTimeout(r, 2500));
  window.showPage('relatorio-bercos');
  await new Promise(r => setTimeout(r, 500));
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

function idsVisiveis() {
  return Array.from(document.querySelectorAll('#relatorio-bercos-tbody tr[data-id-operacao]'))
    .map(tr => tr.getAttribute('data-id-operacao'));
}

function limparFiltros() {
  ['rb-tipo-montagem', 'rb-tipo-bateria', 'rb-vazamento'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('rb-id-operacao').value = '';
}

test('ao abrir, só os últimos 30 dias: as 3 operações recentes aparecem, a antiga não', () => {
  assert.equal(idsVisiveis().length, 3);
  assert.ok(!idsVisiveis().includes('op-filtro-antiga'));
  assert.equal(document.getElementById('rb-data-inicio').value, diasAtras(30));
  assert.equal(document.getElementById('rb-data-fim').value, diasAtras(0));
});

test('Modo Visual só é montado quando ligado, com as mesmas linhas da tabela', () => {
  const cards = () => document.querySelectorAll('#relatorio-bercos-visual .card').length;
  assert.equal(cards(), 0);
  document.getElementById('btn-rb-modo-visual').click();
  assert.equal(cards(), 3);
  document.getElementById('btn-rb-modo-visual').click();
});

test('dropdown "Tipo de Montagem" foi populado com os valores presentes (SP, 2P)', () => {
  const opcoes = Array.from(document.getElementById('rb-tipo-montagem').options).map(o => o.value).filter(Boolean);
  assert.deepEqual(opcoes.sort(), ['2P', 'SP']);
});

test('dropdown "Tipo de Bateria" foi populado com os valores presentes (B5, B6)', () => {
  const opcoes = Array.from(document.getElementById('rb-tipo-bateria').options).map(o => o.value).filter(Boolean);
  assert.deepEqual(opcoes.sort(), ['B5', 'B6']);
});

test('filtro por Tipo de Montagem (SP) mostra só a operação SP', () => {
  limparFiltros();
  const sel = document.getElementById('rb-tipo-montagem');
  sel.value = 'SP';
  sel.dispatchEvent(new window.Event('change'));
  assert.deepEqual(idsVisiveis(), ['op-filtro-sp-b5']);
});

test('filtro por Tipo de Bateria (B6) mostra só a operação da B6', () => {
  limparFiltros();
  const sel = document.getElementById('rb-tipo-bateria');
  sel.value = 'B6';
  sel.dispatchEvent(new window.Event('change'));
  assert.deepEqual(idsVisiveis(), ['op-filtro-2p-b6-vazou']);
});

test('filtro "Com vazamento" mostra só a operação que vazou', () => {
  limparFiltros();
  const sel = document.getElementById('rb-vazamento');
  sel.value = 'com';
  sel.dispatchEvent(new window.Event('change'));
  assert.deepEqual(idsVisiveis(), ['op-filtro-2p-b6-vazou']);
});

test('filtro "Sem vazamento" mostra as outras 2 operações', () => {
  limparFiltros();
  const sel = document.getElementById('rb-vazamento');
  sel.value = 'sem';
  sel.dispatchEvent(new window.Event('change'));
  assert.deepEqual(idsVisiveis().sort(), ['op-filtro-2p-b5', 'op-filtro-sp-b5'].sort());
});

test('busca por ID da Operação filtra em tempo real (evento "input"), por trecho do id', () => {
  limparFiltros();
  const input = document.getElementById('rb-id-operacao');
  input.value = 'b6-vazou';
  input.dispatchEvent(new window.Event('input'));
  assert.deepEqual(idsVisiveis(), ['op-filtro-2p-b6-vazou']);
});

test('combinando filtros (Bateria B5 + Montagem 2P) mostra só a operação que bate com os dois', () => {
  limparFiltros();
  document.getElementById('rb-tipo-bateria').value = 'B5';
  document.getElementById('rb-tipo-bateria').dispatchEvent(new window.Event('change'));
  document.getElementById('rb-tipo-montagem').value = '2P';
  document.getElementById('rb-tipo-montagem').dispatchEvent(new window.Event('change'));
  assert.deepEqual(idsVisiveis(), ['op-filtro-2p-b5']);
});

test('botão "✕ Limpar" reseta todos os filtros, inclusive o período — aparecem as 4, com a antiga', () => {
  document.getElementById('rb-tipo-bateria').value = 'B5';
  document.getElementById('rb-tipo-bateria').dispatchEvent(new window.Event('change'));
  document.getElementById('btn-rb-limpar').click();
  assert.equal(idsVisiveis().length, 4);
  assert.ok(idsVisiveis().includes('op-filtro-antiga'));
  assert.equal(document.getElementById('rb-data-inicio').value, '');
  assert.equal(document.getElementById('rb-tipo-montagem').value, '');
  assert.equal(document.getElementById('rb-tipo-bateria').value, '');
  assert.equal(document.getElementById('rb-vazamento').value, '');
  assert.equal(document.getElementById('rb-id-operacao').value, '');
});
