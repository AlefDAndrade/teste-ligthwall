// ─── test/insumos-dinamicos-analise-focada-total.test.js ────────────────────
// Bug relatado com print de tela: Traço 6 teve um ajuste em "Fibra" e
// "Cerragem" (+3.00kg em cada), mas a "Receita Utilizada" continuava
// mostrando só o valor sem somar o ajuste — dando a impressão de que o
// ajuste "não tinha efeito" ali (mesmo aparecendo certo na lista de
// ajustes, logo abaixo).
//
// Mesma classe de bug já corrigida antes pra Relação A/C (ver
// test/analise-focada-relacao-ac.test.js): a Análise Focada usava
// traco.insumos_custom[nome] direto (só o ORIGINAL, nunca somado com
// traco.ajustes[i].insumos_custom[nome]).
//
// Diferente dos 5 Padrão (que a grade mostra só o ORIGINAL, de propósito,
// com os ajustes listados à parte) — decisão tomada nesta correção: pro
// Custom, a grade mostra o TOTAL (original+ajustes), pra bater com o que
// dashboards/tabela/CEP já mostram desde a correção anterior (payload de
// registro). Corrigido com _afTotalInsumoCustom (exposto aqui como
// LWFocada.totalInsumoCustom só pra este teste), usado nos 2 lugares que
// montam a grade "Receita Utilizada" (modal de berço e listagem de
// traços) — ambos entram também na exportação (mesmas funções).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const CODIGO_FOCADA = fs.readFileSync(path.join(__dirname, '..', 'public/js/analise-focada.js'), 'utf8');

function montarJanela() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
  const { window } = dom;
  window.LW = {};
  window.eval(CODIGO_FOCADA);
  return window;
}

test('totalInsumoCustom soma original + todos os ajustes (cenário exato relatado: Fibra 2 + ajuste +3 = 5)', () => {
  const window = montarJanela();
  const traco = {
    insumos_custom: { 'Fibra': 2, 'Cerragem': 2 },
    ajustes: [{ ordem: 1, insumos_custom: { 'Fibra': 3, 'Cerragem': 3 } }],
  };
  assert.equal(window.LWFocada.totalInsumoCustom(traco, 'Fibra'), 5);
  assert.equal(window.LWFocada.totalInsumoCustom(traco, 'Cerragem'), 5);
});

test('totalInsumoCustom soma vários ajustes, não só o último', () => {
  const window = montarJanela();
  const traco = {
    insumos_custom: { 'Fibra': 1 },
    ajustes: [
      { ordem: 1, insumos_custom: { 'Fibra': 0.5 } },
      { ordem: 2, insumos_custom: { 'Fibra': 0.3 } },
    ],
  };
  assert.equal(window.LWFocada.totalInsumoCustom(traco, 'Fibra'), 1.8);
});

test('totalInsumoCustom: original null (insumo só apareceu via ajuste) trata como 0, não NaN', () => {
  const window = montarJanela();
  const traco = {
    insumos_custom: { 'Fibra': null },
    ajustes: [{ ordem: 1, insumos_custom: { 'Fibra': 0.6 } }],
  };
  assert.equal(window.LWFocada.totalInsumoCustom(traco, 'Fibra'), 0.6);
});

test('totalInsumoCustom: ajuste que não mexeu neste insumo específico não soma nada extra', () => {
  const window = montarJanela();
  const traco = {
    insumos_custom: { 'Fibra': 2, 'Cerragem': 2 },
    // Ajuste só de Fibra — Cerragem não deveria ganhar nada desse ajuste.
    ajustes: [{ ordem: 1, insumos_custom: { 'Fibra': 3 } }],
  };
  assert.equal(window.LWFocada.totalInsumoCustom(traco, 'Fibra'), 5);
  assert.equal(window.LWFocada.totalInsumoCustom(traco, 'Cerragem'), 2);
});
