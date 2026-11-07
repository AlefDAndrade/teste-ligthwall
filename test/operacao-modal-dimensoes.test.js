// ─── test/operacao-modal-dimensoes.test.js ──────────────────────────────────
// Modal ⚙️ (Registrar Operação): dimensão por berço E por lado (painel).
// Cenário: bateria B7 (20 berços, "9 cm"), montagem 2/P (2 painéis/berço,
// 2 placas cimentícia por painel). Painel de 9,5 cm = placa de 8 mm.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-modal-dimensoes-583';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let dom;
let window;
let document;

before(async () => {
  servidor = await iniciarServidorDeTeste({ seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null } });
});
after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

beforeEach(async () => {
  if (dom && dom.window) dom.window.close();
  dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => fetch(new URL(url, win.location.href).toString(), opts);
    },
  });
  window = dom.window;
  document = window.document;
  window.sessionStorage.setItem('lw_role', 'Administrador');
  window.localStorage.setItem('lw_admin_authenticated', 'true');
  await new Promise(r => setTimeout(r, 2500));
  window.showPage('operacao');
  await new Promise(r => setTimeout(r, 300));
  window.LW.mostrarConfirmacao = async () => false; // "o nº de berços não mudou"
  document.getElementById('op-montagem').value = '2/P';
  document.getElementById('op-montagem').dispatchEvent(new window.Event('change', { bubbles: true }));
  document.getElementById('op-id-bateria').value = 'B7';
  document.getElementById('op-id-bateria').dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));
});

const esperar = (ms = 150) => new Promise(r => setTimeout(r, ms));
const ligarSeparados = () => document.getElementById('dim-btn-modo-separado').click();
const celula = (berco, lado) => document.querySelector(`#dim-bercos button[data-berco="${berco}"][data-lado="${lado}"]`);

test('sem nenhum 9,5 cm: nenhuma linha de 8 mm no card de placas', async () => {
  assert.equal(document.getElementById('op-placas-espessura').style.display, 'none');
});

test('modal: desligado = 1 botão por berço; "Berços Separados" ligado = Direita + Esquerda por berço', async () => {
  window.LWOp.abrirModalDimensoes();
  assert.equal(document.getElementById('dim-btn-modo-separado').textContent.trim(), '🔀 Berços Separados: Desligado');
  assert.equal(document.querySelectorAll('#dim-bercos button[data-lado="ambos"]').length, 20);
  assert.equal(document.querySelectorAll('#dim-bercos button[data-lado="direita"]').length, 0);

  ligarSeparados();
  assert.equal(document.getElementById('dim-btn-modo-separado').textContent.trim(), '🔀 Berços Separados: Ligado');
  assert.equal(document.querySelectorAll('#dim-bercos button[data-lado="ambos"]').length, 0);
  assert.equal(document.querySelectorAll('#dim-bercos button[data-lado="direita"]').length, 20);
  assert.equal(document.querySelectorAll('#dim-bercos button[data-lado="esquerda"]').length, 20);

  ligarSeparados();
  assert.equal(document.querySelectorAll('#dim-bercos button[data-lado="ambos"]').length, 20);
});

test('o modal sempre abre com "Berços Separados" desligado, mesmo depois de usado ligado', async () => {
  window.LWOp.abrirModalDimensoes();
  ligarSeparados();
  document.getElementById('dim-btn-cancelar').click();
  window.LWOp.abrirModalDimensoes();
  assert.equal(document.getElementById('dim-btn-modo-separado').textContent.trim(), '🔀 Berços Separados: Desligado');
  assert.equal(document.querySelectorAll('#dim-bercos button[data-lado="ambos"]').length, 20);
});

test('só o painel DIREITO do berço 3 = 9,5 cm → 1 painel × 2 placas = 2 placas de 8 mm', async () => {
  window.LWOp.abrirModalDimensoes();
  ligarSeparados();
  document.getElementById('dim-valor').value = '9,5';
  celula(2, 'direita').click();
  assert.match(document.getElementById('dim-resumo').textContent, /Placas de 8 mm: 2/);
  document.getElementById('dim-btn-confirmar').click();
  await esperar();

  assert.equal(document.getElementById('op-dimensao').value, '9 cm + 9,5 cm');
  assert.equal(document.getElementById('op-placas-espessura').textContent, '8 mm: 2 · 6 mm: 78'); // 20 berços × 4 = 80 placas
});

test('berço inteiro (2 lados) + outro lado separado: 3 painéis de 9,5 cm = 6 placas', async () => {
  window.LWOp.abrirModalDimensoes();
  document.getElementById('dim-valor').value = '9,5';
  celula(0, 'ambos').click();       // 2 painéis (modo desligado = os 2 lados)
  ligarSeparados();
  celula(1, 'esquerda').click();    // +1 painel
  document.getElementById('dim-btn-confirmar').click();
  await esperar();
  assert.equal(document.getElementById('op-placas-espessura').textContent, '8 mm: 6 · 6 mm: 74');
});

test('De/Até aplica nos DOIS lados dos berços da faixa (não existe mais "Aplicar em")', async () => {
  window.LWOp.abrirModalDimensoes();
  assert.equal(document.getElementById('dim-lado'), null);
  document.getElementById('dim-valor').value = '9,5';
  document.getElementById('dim-de').value = '1';
  document.getElementById('dim-ate').value = '5';
  document.getElementById('dim-btn-aplicar').click();
  assert.match(document.getElementById('dim-resumo').textContent, /Placas de 8 mm: 20/); // 5 berços × 2 painéis × 2 placas
  ligarSeparados();
  assert.match(celula(4, 'esquerda').textContent, /9,5 cm/);
  assert.match(celula(4, 'direita').textContent, /9,5 cm/);
  assert.doesNotMatch(celula(5, 'direita').textContent, /9,5/);
});

test('De/Até inválido mostra erro no padrão da Montagem Personalizada', async () => {
  window.LWOp.abrirModalDimensoes();
  document.getElementById('dim-valor').value = '9,5';
  document.getElementById('dim-de').value = '5';
  document.getElementById('dim-ate').value = '2';
  document.getElementById('dim-btn-aplicar').click();
  assert.match(document.getElementById('dim-erro').textContent, /intervalo válido \(de 1 até 20\)/);
});

test('todos os painéis em 9,5 cm viram a dimensão padrão da bateria (campo mostra só "9,5 cm")', async () => {
  window.LWOp.abrirModalDimensoes();
  document.getElementById('dim-valor').value = '9,5';
  document.getElementById('dim-btn-todos').click();
  document.getElementById('dim-btn-confirmar').click();
  await esperar();
  assert.equal(document.getElementById('op-dimensao').value, '9,5 cm');
  assert.equal(document.getElementById('op-placas-espessura').textContent, '8 mm: 80 · 6 mm: 0');
});
