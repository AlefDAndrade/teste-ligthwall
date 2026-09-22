// ─── test/editar-operacao-modal-dimensao-bercos-visuais.test.js ─────────────
// Cobertura de UI (jsdom, SPA real) do que test/editar-operacao-dimensao-
// bercos-visuais.test.js cobre no backend: editar a Dimensão no modal
// "Editar Operação" (✏️, pergunta se mudou o nº de berços) e o editor
// visual "🔲 Berços — Vazou/Não Enchido" (ver app-core.js:
// abrirEdicaoOperacao/_eoConfirmarDimensaoManual/_eoAbrirBercosVisuais).
//
// Cenário de referência: bateria B7 (public/db/config.json — 20 berços,
// dimensão "9 cm"), montagem "S/P".

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-eo-modal-dimensao-bercos-552';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let cookie; // sessão de Administrador — POST /registrar-operacao exige (ver podeEditarArea/perfis.js)
let dom;
let window;
let document;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
  });
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  cookie = (resp.headers.get('set-cookie') || '').split(';')[0];
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

beforeEach(async () => {
  if (dom && dom.window) dom.window.close();
  dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      // jsdom não gerencia cookie jar sozinho pra esse fetch (é o fetch do
      // PRÓPRIO Node por baixo) — anexa o cookie de sessão manualmente em
      // toda chamada, mesmo padrão de insumos-dinamicos-payload-
      // registro.test.js (rotas protegidas, como /editar-operacao e
      // /bercos-visuais-operacao/:id, exigem sessão real).
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        const headers = { ...(opts && opts.headers), Cookie: cookie };
        return fetch(absoluta, { ...opts, headers });
      };
    },
  });
  window = dom.window;
  document = window.document;
  window.sessionStorage.setItem('lw_role', 'Administrador');
  window.localStorage.setItem('lw_admin_authenticated', 'true');
  window.localStorage.setItem('lw_device_id', DEVICE_ID_TESTE_PADRAO);
  await new Promise(r => setTimeout(r, 2500));
});

// Registra uma operação real no servidor (pra existir uma linha em
// bercos_visuais/operacoes pra editar de verdade) e devolve o objeto no
// formato historico.json (o mesmo que abrirEdicaoOperacao(bateria) recebe
// de LWDash, ver dashboard.js/onClickLinhaRegistro).
async function registrarOperacaoEBuscar(idOp) {
  const resp = await fetch(`${servidor.baseUrl}/registrar-operacao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: idOp, data: '2026-07-20', turno: '1º TURNO', dimensao: '9 cm', capacidade: 20,
      id_bateria: 'B7', tipo_montagem: 'S/P',
      inicio: '2026-07-20T08:00:00.000Z', fim: '2026-07-20T09:00:00.000Z',
      tempo_min: 60, qtd_tracos: 3, total_paineis: 40, m2_total: 73.2,
      houve_atraso: 'NÃO',
    }),
  });
  if (resp.status !== 200) throw new Error(`POST /registrar-operacao falhou (${resp.status}): ${await resp.text()}`);
  const historico = await fetch(`${servidor.baseUrl}/db/historico.json`).then(r => r.json());
  const operacao = historico.find(o => o.id === idOp);
  if (!operacao) throw new Error(`Operação ${idOp} não apareceu em /db/historico.json após registrar.`);
  return operacao;
}

test('abrirEdicaoOperacao: campo Dimensão nasce com o label automático da bateria (não-manual)', async () => {
  const idOp = 'op-eo-modal-abrir-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp);

  window.abrirEdicaoOperacao(operacao);

  assert.equal(document.getElementById('editar-operacao-modal').style.display, 'flex');
  assert.equal(document.getElementById('eo-dimensao').value, '9 cm');
  assert.ok(document.getElementById('eo-dimensao').classList.contains('auto-filled'));
});

test('editar Dimensão + "sim, mudou berços" + novo número: preview mostra capacidade customizada', async () => {
  const idOp = 'op-eo-modal-dim-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp);
  window.abrirEdicaoOperacao(operacao);

  window.LW.mostrarConfirmacao = async () => true; // "sim, mudou"
  window.LW.mostrarPrompt = async () => '8';

  window.LWOp = window.LWOp || {}; // abrirGradeMontagem não é chamado aqui, só existe se Personalizada
  window._eoEditarDimensao(); // destrava
  const input = document.getElementById('eo-dimensao');
  input.value = '7,5';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  window._eoEditarDimensao(); // confirma
  await new Promise(r => setTimeout(r, 200));

  assert.equal(input.value, '7,5 cm');
  assert.equal(input.classList.contains('auto-filled'), false);
  const preview = document.getElementById('eo-preview').textContent;
  assert.match(preview, /8.*\(customizado\)/s);
  assert.match(preview, /16/); // 8 berços * 2 (S/P)
});

test('salvarEdicaoOperacao: envia a dimensão manual e a capacidade customizada pro servidor', async () => {
  const idOp = 'op-eo-modal-salvar-dim-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp);
  window.abrirEdicaoOperacao(operacao);

  window.LW.mostrarConfirmacao = async () => true;
  window.LW.mostrarPrompt = async () => '8';
  window._eoEditarDimensao();
  document.getElementById('eo-dimensao').value = '7,5';
  document.getElementById('eo-dimensao').dispatchEvent(new window.Event('input', { bubbles: true }));
  window._eoEditarDimensao();
  await new Promise(r => setTimeout(r, 200));

  await window.salvarEdicaoOperacao();
  await new Promise(r => setTimeout(r, 200));

  const historico = await window.fetch('/db/historico.json').then(r => r.json());
  const atualizado = historico.find(o => o.id === idOp);
  assert.equal(atualizado.dimensao, '7,5 cm');
  assert.equal(atualizado.capacidade, 8);
  assert.equal(atualizado.total_paineis, 16);
});

test('_eoAbrirBercosVisuais: abre a grade já carregada do servidor (todos "okay" por padrão)', async () => {
  const idOp = 'op-eo-modal-bv-abrir-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp);
  window.abrirEdicaoOperacao(operacao);

  await window._eoAbrirBercosVisuais();
  await new Promise(r => setTimeout(r, 100));

  const modal = document.getElementById('eo-bv-modal');
  assert.ok(modal, 'o sub-modal de berços visuais deveria ter aberto');
  const celulas = modal.querySelectorAll('.ba-celula');
  assert.equal(celulas.length, 20); // capacidade de B7
  const dots = modal.querySelectorAll('.ba-dot.ba-dot-marcado');
  assert.equal(dots.length, 0); // nada marcado ainda
});

test('marcar um berço como Vazou no editor visual + Salvar Alterações: grava em bercos_visuais', async () => {
  const idOp = 'op-eo-modal-bv-marcar-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp);
  window.abrirEdicaoOperacao(operacao);

  await window._eoAbrirBercosVisuais();
  await new Promise(r => setTimeout(r, 100));

  // Clica no indicador direito (topo) do berço B3 — modo padrão = "baixou".
  const dot = document.querySelector('#eo-bv-modal .ba-dot[data-berco="B3"][data-lado="direita"]');
  assert.ok(dot, 'indicador do B3 (direita) deveria existir na grade');
  dot.dispatchEvent(new window.Event('click', { bubbles: true }));
  document.getElementById('eo-bv-confirmar').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));

  window.LW.mostrarConfirmacao = async () => true; // "Confirma a alteração de N campo(s)?"
  await window.salvarEdicaoOperacao();
  await new Promise(r => setTimeout(r, 200));

  const bv = await window.fetch(`/bercos-visuais-operacao/${idOp}`).then(r => r.json());
  const b3 = bv.bercos.find(b => b.berco === 'B3');
  assert.equal(b3.estado_direita, 'baixou');
  assert.equal(b3.estado_esquerda, 'okay');
});

test('marcar um berço como Não Enchido (botão de modo ligado) + Salvar: grava "nao_enchido"', async () => {
  const idOp = 'op-eo-modal-bv-nao-enchido-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp);
  window.abrirEdicaoOperacao(operacao);

  await window._eoAbrirBercosVisuais();
  await new Promise(r => setTimeout(r, 100));

  document.getElementById('eo-bv-btn-modo').dispatchEvent(new window.Event('click', { bubbles: true }));
  const dot = document.querySelector('#eo-bv-modal .ba-dot[data-berco="B5"][data-lado="esquerda"]');
  dot.dispatchEvent(new window.Event('click', { bubbles: true }));
  document.getElementById('eo-bv-confirmar').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));

  window.LW.mostrarConfirmacao = async () => true;
  await window.salvarEdicaoOperacao();
  await new Promise(r => setTimeout(r, 200));

  const bv = await window.fetch(`/bercos-visuais-operacao/${idOp}`).then(r => r.json());
  const b5 = bv.bercos.find(b => b.berco === 'B5');
  assert.equal(b5.estado_esquerda, 'nao_enchido');
});

test('Cancelar no editor de berços visuais descarta o clique feito nesta sessão do sub-modal', async () => {
  const idOp = 'op-eo-modal-bv-cancelar-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp);
  window.abrirEdicaoOperacao(operacao);

  await window._eoAbrirBercosVisuais();
  await new Promise(r => setTimeout(r, 100));
  document.querySelector('#eo-bv-modal .ba-dot[data-berco="B1"][data-lado="direita"]')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  document.getElementById('eo-bv-cancelar').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));

  window.LW.mostrarConfirmacao = async () => true;
  await window.salvarEdicaoOperacao();
  await new Promise(r => setTimeout(r, 200));

  // Nada devia ter sido enviado (nenhuma mudança de fato) — o alerta de
  // "Nenhuma alteração foi feita" teria impedido o POST; confirmamos
  // olhando o servidor: berço continua 'okay'.
  const bv = await window.fetch(`/bercos-visuais-operacao/${idOp}`).then(r => r.json());
  const b1 = bv.bercos.find(b => b.berco === 'B1');
  assert.equal(b1.estado_direita, 'okay');
});
