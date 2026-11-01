// ─── test/operacao-botao-pausar-posicao.test.js ─────────────────────────────
// O botão ⏸ Pausar / ▶ Retomar fica AO LADO do status da operação ("Aguardando
// início", "Injeção em andamento", "Injeção pausada"), e não mais junto dos
// botões Pendências/Referências (onde, ao aparecer, alargava a linha e
// empurrava o timer).
//
// Ele precisa ser IRMÃO de #status-banner, nunca filho: updateStatusBanner()
// (operacao.js) reescreve o innerHTML do banner a cada mudança de estado, o que
// apagaria o botão.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PARTIAL = fs.readFileSync(path.join(__dirname, '..', 'public', 'partials', 'page-operacao.html'), 'utf8');

let dom;
let doc;
beforeEach(() => {
  dom = new JSDOM('<!DOCTYPE html><html><body>' + PARTIAL + '</body></html>');
  doc = dom.window.document;
});
afterEach(() => dom.window.close());

test('existe um único botão de pausar, e ele começa escondido', () => {
  const botoes = doc.querySelectorAll('#btn-pausar-operacao');
  assert.equal(botoes.length, 1);
  assert.equal(botoes[0].style.display, 'none');
});

test('o botão de pausar é irmão do status, dentro da mesma linha', () => {
  const botao = doc.getElementById('btn-pausar-operacao');
  const banner = doc.getElementById('status-banner');
  assert.equal(botao.parentElement, banner.parentElement);
  assert.ok(botao.parentElement.classList.contains('op-status-banner-row'));
  assert.equal(banner.nextElementSibling, botao);
});

test('o botão de pausar NÃO está dentro do status nem dos botões Pendências/Referências', () => {
  const botao = doc.getElementById('btn-pausar-operacao');
  assert.equal(botao.closest('#status-banner'), null, 'dentro do banner seria apagado pelo innerHTML');
  assert.equal(botao.closest('.op-status-triggers'), null, 'dentro dos triggers voltaria a empurrar o timer');
});

test('reescrever o banner (como updateStatusBanner faz) não apaga o botão', () => {
  const banner = doc.getElementById('status-banner');
  banner.innerHTML = '<span class="badge badge-amber">⏸ Injeção pausada</span>';
  assert.ok(doc.getElementById('btn-pausar-operacao'));
});

test('o timer continua fora do lado esquerdo (status + botões)', () => {
  const botao = doc.getElementById('btn-pausar-operacao');
  const timers = doc.querySelector('.op-status-timers');
  assert.equal(timers.closest('.op-status-left'), null);
  assert.equal(botao.closest('.op-status-timers'), null);
});
