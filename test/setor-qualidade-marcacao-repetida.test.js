// ─── test/setor-qualidade-marcacao-repetida.test.js ─────────────────────────
// Testa a mudança no modelo de marcação de placas (ver conversa que
// motivou): antes, clicar de novo na MESMA cor+forma apagava a marca — isso
// impedia repetir a mesma combinação na mesma placa. Agora:
//   1. Clique normal SEMPRE adiciona uma marca (permite repetir).
//   2. Clique direito (mouse) apaga UMA ocorrência da cor+forma atualmente
//      selecionada.
//   3. Ferramenta "Borracha" (selecionável, igual cor/forma) — clique ou
//      toque normal numa placa limpa TODAS as marcas dela de uma vez.
//      Substituiu o gesto de toque longo, que foi removido (ver último
//      teste deste arquivo).
//   4. Limite de 6 marcas por placa.
//   5. X continua exclusivo (substitui tudo, e é substituído por
//      qualquer marca real).
//   6. Botão "🧹 Limpar" por pallet (substituiu o dropdown de cores, que
//      era redundante com "⚡ Todas" + a paleta principal).
//
// Mesmo harness de test/setor-qualidade-trava.test.js — ver
// test/helpers/setor-qualidade-dom.js.

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick, OPERACAO_FILA } = require('./helpers/setor-qualidade-dom.js');

let dom;

beforeEach(() => {
  dom = montarTela();
});

after(() => {
  dom = null;
});

async function abrirFormulario(window) {
  window.SQ.startNew();
  await tick();
  window.SQ.iniciarAvaliacaoDaFila(OPERACAO_FILA.id);
  await tick();
}

function criarTouchEvent(window, tipo, x, y) {
  const ev = new window.Event(tipo, { bubbles: true, cancelable: true });
  ev.touches = [{ clientX: x, clientY: y }];
  return ev;
}

test('clicar 3x na mesma placa com a mesma cor+forma adiciona 3 marcas (repetição permitida)', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.verde').click();
  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  slab.click(); slab.click(); slab.click();

  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-1"] .sq-mark-circle').length, 3);
});

test('clique direito (contextmenu) remove UMA ocorrência da cor+forma selecionada', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.verde').click();
  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  slab.click(); slab.click();

  slab.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-1"] .sq-mark-circle').length, 1, 'deveria sobrar 1 marca depois de remover 1 das 2');
});

test('clique direito sem nenhuma marca correspondente não quebra nada (placa continua vazia)', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.vermelho').click();
  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  slab.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-1"] .sq-mark-circle').length, 0);
});

test('Borracha selecionada + clique numa placa: limpa TODAS as marcas dela de uma vez', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.verde').click();
  const slab = window.document.querySelector('.sq-slab[data-id="stack1-2"]');
  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.document.querySelector('.sq-btn-shape.dash').click();
  slab.click(); // marca vermelho+traço
  window.document.querySelector('.sq-btn-color.verde').click();
  window.document.querySelector('.sq-btn-shape.circle').click();
  slab.click(); slab.click(); // + 2 marcas verde+círculo
  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-2"] .sq-mark-circle, .sq-slab[data-id="stack1-2"] .sq-mark-dash').length, 3, 'pré-condição: placa deveria ter 3 marcas');

  window.document.querySelector('.sq-btn-shape.eraser').click();
  slab.click();

  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-2"] .sq-mark-circle, .sq-slab[data-id="stack1-2"] .sq-mark-dash').length, 0, 'a Borracha deveria ter apagado TODAS as marcas da placa, não só uma');
});

test('Borracha selecionada + clique direito: mesmo efeito do clique normal (limpa tudo)', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.verde').click();
  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  slab.click(); slab.click();

  window.document.querySelector('.sq-btn-shape.eraser').click();
  slab.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));

  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-1"] .sq-mark-circle').length, 0, 'clique direito com a Borracha selecionada também deveria limpar a placa inteira');
});

test('o gesto de toque longo foi removido — segurar o dedo numa placa não apaga mais nada', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.verde').click();
  const slab = window.document.querySelector('.sq-slab[data-id="stack1-2"]');
  slab.click();
  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-2"] .sq-mark-circle').length, 1);

  slab.dispatchEvent(criarTouchEvent(window, 'touchstart', 100, 100));
  await new Promise(r => setTimeout(r, 600));
  slab.dispatchEvent(criarTouchEvent(window, 'touchend', 100, 100));
  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-2"] .sq-mark-circle').length, 1, 'segurar o toque não deveria apagar nada — o gesto foi removido, ver Borracha');
});

test('limite de 6 marcas por placa é respeitado, com aviso', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.verde').click();
  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  for (let i = 0; i < 10; i++) slab.click();

  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-1"] .sq-mark-circle').length, 6, 'não deveria passar de 6 marcas');
  const toasts = Array.from(window.document.querySelectorAll('.sq-toast')).map(t => t.textContent);
  assert.ok(toasts.some(t => t.includes('Limite de 6 marcas')), 'deveria ter avisado sobre o limite');
});

test('marcar X substitui qualquer marca real existente, e vice-versa', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.verde').click();
  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  slab.click(); slab.click();
  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-1"] .sq-mark-circle').length, 2);

  window.document.querySelector('.sq-btn-shape.x').click();
  slab.click();
  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-1"] .sq-mark-circle').length, 0, 'X deveria substituir as marcas reais');
  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-1"] .sq-mark-x').length, 1);

  // Clicar numa forma real (círculo) sai do modo "×" — só depois disso
  // um clique na placa volta a marcar validação normal.
  window.document.querySelector('.sq-btn-shape.circle').click();
  slab.click();
  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-1"] .sq-mark-x').length, 0, 'marcar uma marca real deveria remover o X');
  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-1"] .sq-mark-circle').length, 1);
});

test('botão Limpar do pallet apaga só as marcações daquele pallet, com confirmação', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.verde').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();
  window.document.querySelector('.sq-slab[data-id="stack2-1"]').click();

  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-1"] .sq-mark-circle').length, 1);
  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack2-1"] .sq-mark-circle').length, 1);

  window.SQ.clearPallet('stack1');
  await tick();
  const okBtn = window.document.getElementById('sq-modal-ok');
  assert.ok(okBtn, 'deveria pedir confirmação antes de limpar o pallet');
  okBtn.click();
  await tick();

  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack1-1"] .sq-mark-circle').length, 0, 'stack1 deveria ter sido limpo');
  assert.equal(window.document.querySelectorAll('.sq-slab[data-id="stack2-1"] .sq-mark-circle').length, 1, 'stack2 não deveria ter sido afetado');
});

test('a seleção de cor redundante por pallet (dropdown 🎨) foi removida da tela', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  assert.equal(window.document.querySelector('.sq-color-dropdown'), null, 'o dropdown de cor por pallet não deveria mais existir');
  assert.equal(window.document.querySelector('.sq-btn-dropdown'), null);
  assert.ok(window.document.querySelector('.sq-btn-clear-pallet'), 'o botão de Limpar por pallet deveria existir no lugar');
});
