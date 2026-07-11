// ─── test/setor-qualidade-motivo-obrigatorio.test.js ────────────────────────
// Testa que marcar uma placa de vermelho (reprovado) ou azul (2ª linha)
// abre o seletor de motivo e OBRIGA escolher um antes de continuar — pedido
// do usuário: "quero que o programa me force a selecionar um motivo, caso
// não selecione ele não me deixa sair ou fechar a tela" (ver
// _abrirSeletorMotivo, public/js/setor-qualidade.js).
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

test('marcar uma placa de VERMELHO abre o seletor de motivo, com overlay bloqueando o resto da tela', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();

  assert.ok(window.document.querySelector('.sq-motivo-popover'), 'o seletor de motivo deveria abrir');
  assert.ok(window.document.querySelector('.sq-motivo-modal-overlay'), 'o overlay de bloqueio deveria estar presente');
});

test('marcar uma placa de AZUL (2ª linha) também abre o seletor de motivo', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.azul').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();

  assert.ok(window.document.querySelector('.sq-motivo-popover'), 'o seletor de motivo deveria abrir pra azul também');
});

test('não existe mais botão de fechar sem escolher', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();

  assert.equal(window.document.querySelector('.sq-motivo-popover-fechar'), null, 'não deveria existir mais um "✕" pra fechar sem escolher');
});

test('clicar no overlay (fora do popover) não fecha o seletor', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();

  window.document.querySelector('.sq-motivo-modal-overlay').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  window.document.querySelector('.sq-motivo-modal-overlay').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.ok(window.document.querySelector('.sq-motivo-popover'), 'o seletor deveria continuar aberto — clicar fora não fecha mais');
});

test('escolher um código de motivo fecha o seletor e grava o motivo na placa', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();

  const primeiroCodigo = window.document.querySelector('.sq-motivo-popover-item');
  const codigoEscolhido = primeiroCodigo.dataset.codigo;
  primeiroCodigo.click();

  assert.equal(window.document.querySelector('.sq-motivo-popover'), null, 'o seletor deveria fechar depois de escolher');
  assert.equal(window.document.querySelector('.sq-motivo-modal-overlay'), null, 'o overlay deveria sumir junto');
  const badge = window.document.querySelector('.sq-slab[data-id="stack1-1"]').parentElement.querySelector('.sq-slab-motivo');
  assert.equal(badge.textContent, codigoEscolhido, 'o badge da placa deveria mostrar o código escolhido');
});

test('cancelar (ou deixar em branco) a descrição de "Outros" REABRE o seletor, não descarta', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();

  const botaoOutros = window.document.querySelector('.sq-motivo-popover-item[data-codigo="OT"]');
  assert.ok(botaoOutros, 'deveria existir a opção "Outros" (OT)');
  botaoOutros.click();

  // Agora o modal genérico de texto (showPrompt) deveria estar aberto.
  assert.equal(window.document.getElementById('sq-modal').classList.contains('open'), true);
  // Cancela sem digitar nada.
  window.document.getElementById('sq-modal-cancel').onclick();

  // Em vez de ficar sem nada (placa "?" esquecida), o seletor de motivo
  // reabre sozinho — continua obrigatório.
  assert.ok(window.document.querySelector('.sq-motivo-popover'), 'o seletor de motivo deveria reabrir depois de cancelar a descrição');
});

test('o badge de motivo fica AO LADO da placa (irmão), não mais sobreposto dentro dela', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  const badge = slab.parentElement.querySelector('.sq-slab-motivo');
  assert.ok(badge, 'deveria existir um badge de motivo irmão do slab');
  assert.equal(slab.querySelector('.sq-slab-motivo'), null, 'o badge não deveria mais estar DENTRO do slab');
  assert.equal(slab.parentElement.className, 'sq-slab-linha', 'o pai comum deveria ser o wrapper .sq-slab-linha');
});

test('a visibilidade do badge é explícita (flex/none), não depende de limpar o style inline', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  const badge = window.document.querySelector('.sq-slab[data-id="stack1-1"]').parentElement.querySelector('.sq-slab-motivo');
  assert.equal(badge.style.display, 'none', 'sem marca nenhuma, o badge começa escondido');

  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();
  assert.equal(badge.style.display, 'flex', 'com marca vermelha pendente de motivo, o badge (com "?") deveria ficar visível');

  window.document.querySelector('.sq-motivo-popover-item').click();
  assert.equal(badge.style.display, 'flex', 'depois de escolher o código, o badge continua visível');
});