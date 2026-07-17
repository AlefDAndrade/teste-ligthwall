// ─── test/setor-qualidade-motivo-so-indicador.test.js ───────────────────────
// Testa que SÓ a marca de INDICADOR (role: 'indicador') exige motivo de
// defeito — uma marca de IDENTIDADE (role: 'identidade') azul/vermelha
// "por acaso" NUNCA deve:
//   1. mostrar o badge "?"/código no painel;
//   2. abrir o seletor de motivo ao clicar no badge;
//   3. receber um motivo gravado numa marcação em lote ("⚡ Todas" do
//      pallet) quando a cor em lote é aplicada como identidade (botão "I"
//      desativado).
//
// setor-qualidade-indicador-toggle.test.js já cobre que toggleMark (clique
// direto na placa) não ABRE o seletor pra marca de identidade vermelha —
// este arquivo cobre os pontos que ainda checavam só a COR, sem checar o
// `role` (_renderBadgeMotivo, clique no badge, _atualizarMotivoAposDesmarcar,
// aplicar() em lote) — ver _marcaExigeMotivo, setor-qualidade.js.
//
// Mesmo harness de setor-qualidade-motivo-obrigatorio.test.js — ver
// test/helpers/setor-qualidade-dom.js.

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick, OPERACAO_FILA } = require('./helpers/setor-qualidade-dom.js');

let dom;
beforeEach(() => { dom = null; });
after(() => { dom = null; });

async function abrirFormulario(window) {
  window.SQ.startNew();
  await tick();
  window.SQ.iniciarAvaliacaoDaFila(OPERACAO_FILA.id);
  await tick();
}

test('marca de IDENTIDADE vermelha ("I" desativado) não mostra badge "?" nem código no painel', async () => {
  dom = montarTela();
  const { window } = dom;
  await abrirFormulario(window);

  // Desativa o "I" -> próxima marca nasce role: 'identidade'.
  window.document.querySelector('.sq-btn-indicador').click();

  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();
  await tick();

  const badge = window.document.querySelector('.sq-slab[data-id="stack1-1"]').parentElement.querySelector('.sq-slab-motivo');
  assert.equal(badge.style.display, 'none', 'badge não deveria aparecer pra marca de identidade, mesmo vermelha');
  assert.equal(badge.textContent, '', 'badge não deveria ter nenhum texto/código');
});

test('clicar no badge de uma placa só com marca de identidade vermelha não abre o seletor de motivo', async () => {
  dom = montarTela();
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-indicador').click(); // desativa "I"
  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();
  await tick();

  const badge = window.document.querySelector('.sq-slab[data-id="stack1-1"]').parentElement.querySelector('.sq-slab-motivo');
  badge.click();
  await tick();

  assert.equal(window.document.querySelector('.sq-motivo-popover'), null, 'seletor de motivo não deveria abrir pra marca de identidade');
});

test('marcar TODO o pallet ("⚡ Todas") com "I" desativado (identidade) não abre o seletor de motivo, mesmo em vermelho', async () => {
  dom = montarTela();
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-indicador').click(); // desativa "I"
  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.SQ.selectAllPallet('stack1');
  await tick();

  assert.equal(window.document.querySelector('.sq-motivo-popover'), null, 'marcação em lote de identidade não deveria exigir motivo');
  const badge = window.document.querySelector('.sq-slab[data-id="stack1-1"]').parentElement.querySelector('.sq-slab-motivo');
  assert.equal(badge.style.display, 'none', 'badge não deveria aparecer em nenhuma placa do pallet marcado como identidade');
});

test('marcar o INDICADOR de vermelho continua exigindo motivo e mostrando o badge normalmente (comportamento preservado)', async () => {
  dom = montarTela();
  const { window } = dom;
  await abrirFormulario(window);

  // "I" nasce ativado por padrão — não precisa mexer.
  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();
  await tick();

  assert.ok(window.document.querySelector('.sq-motivo-popover'), 'marca de indicador vermelha deveria continuar exigindo motivo');
  const primeiroCodigo = window.document.querySelector('.sq-motivo-popover-item');
  primeiroCodigo.click();

  const badge = window.document.querySelector('.sq-slab[data-id="stack1-1"]').parentElement.querySelector('.sq-slab-motivo');
  assert.equal(badge.style.display, 'flex', 'badge deveria continuar aparecendo normalmente pro indicador');
});

test('desmarcar a única marca de indicador que exigia motivo limpa o motivo salvo, mesmo sobrando marca de identidade vermelha', async () => {
  dom = montarTela();
  const { window } = dom;
  await abrirFormulario(window);

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');

  // 1) Marca de identidade vermelha primeiro ("I" desativado) — nunca exige motivo.
  window.document.querySelector('.sq-btn-indicador').click(); // desativa
  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.document.querySelector('.sq-btn-shape.dash').click();
  slab.click();
  await tick();

  // 2) Marca de indicador vermelha ("I" reativado) — exige motivo.
  window.document.querySelector('.sq-btn-indicador').click(); // reativa
  window.document.querySelector('.sq-btn-shape.circle').click();
  slab.click();
  await tick();
  window.document.querySelector('.sq-motivo-popover-item').click();

  const badge = slab.parentElement.querySelector('.sq-slab-motivo');
  assert.equal(badge.style.display, 'flex', 'motivo deveria estar salvo após escolher o código');

  // 3) Apaga só a marca de INDICADOR (círculo vermelho) com o gesto de apagar.
  window.document.querySelector('.sq-btn-shape.circle').click();
  window.document.querySelector('.sq-btn-color.vermelho').click();
  slab.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await tick();

  // Sobra só a marca de identidade (traço vermelho) — não deveria mais exigir motivo/badge.
  assert.equal(badge.style.display, 'none', 'sem marca de indicador restante, o badge deveria sumir mesmo com marca de identidade vermelha sobrando');
});
