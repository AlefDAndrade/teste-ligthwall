// ─── test/insumos-dinamicos-cep.test.js ─────────────────────────────────────
// Pedido feito numa conversa: os insumos Custom (ver PLANO-insumos-
// dinamicos-receitas.md) precisam aparecer também no Dashboard de CEP
// (qualidade-tracos.js).
//
// Ao contrário do que se imaginava na Fase 6 original (decisão de deixar
// o CEP de fora, por depender de uma referência "ideal" que não existiria
// pra Custom): investigando o código, "desvio" aqui é ORIGINAL×TOTAL
// DENTRO do mesmo traço (planejado vs. realmente usado, depois dos
// ajustes) — não uma referência externa fixa. Generaliza pra Custom sem
// precisar inventar nenhuma baseline nova.
//
// calcularIndicadores(tracos) é uma função pura (sem DOM) — exposta em
// window.LWQualidade.calcularIndicadores só pra este teste chamar direto,
// mesmo padrão de outras funções internas já expostas noutros arquivos
// (LWFocada.fmtHora, LWOp.updateInsumoOriginal etc.).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const CODIGO_QUALIDADE = fs.readFileSync(path.join(__dirname, '..', 'public/js/qualidade-tracos.js'), 'utf8');

function montarJanela() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
  const { window } = dom;
  window.LW = {
    calcularRelacaoAC(cimento, agua) {
      const c = parseFloat(cimento), a = parseFloat(agua);
      if (isNaN(c) || c <= 0 || isNaN(a) || a < 0) return null;
      return a / c;
    },
    tooltip: { ligarHoverCanvas: () => {} }, // usado só no top-level do módulo (canvas hover) — não entra no cálculo
  };
  window.eval(CODIGO_QUALIDADE);
  return window;
}

function traco(overrides = {}) {
  return {
    data: '2026-08-01', tipo_montagem: 'S',
    cimento_real: { original: 350, ajustes: [] },
    agua_real: { original: 130, ajustes: [] },
    eps_real: { original: 2, ajustes: [] },
    superplast_real: { original: 4, ajustes: [] },
    incorporador_real: { original: 1, ajustes: [] },
    densidade: { original: 1050, ajustes: [] },
    flow: { original: 210, ajustes: [] },
    ...overrides,
  };
}

test('cepPorInsumo inclui um insumo Custom (estatística Média/Mediana/Desvio/CV), junto com os 5 Padrão', () => {
  const window = montarJanela();
  const ind = window.LWQualidade.calcularIndicadores([
    traco({ insumos_custom: { 'Fibra': { original: 2, ajustes: [] } } }),
    traco({ insumos_custom: { 'Fibra': { original: 3, ajustes: [] } } }),
  ]);

  assert.ok('Fibra' in ind.cepPorInsumo, 'Fibra deveria ter entrado na tabela de CEP');
  assert.equal(ind.cepPorInsumo['Fibra'].n, 2);
  assert.equal(ind.cepPorInsumo['Fibra'].media, 2.5);
  // Padrão continuam lá, sem nenhuma mudança.
  assert.ok('Cimento' in ind.cepPorInsumo);
  assert.equal(ind.cepPorInsumo['Cimento'].n, 2);
});

test('consumoPorInsumo (planejado×real) inclui Custom — mesmo critério "original×total dentro do traço" dos Padrão', () => {
  const window = montarJanela();
  const ind = window.LWQualidade.calcularIndicadores([
    traco({
      insumos_custom: { 'Fibra': { original: 2, ajustes: [0.5] } }, // planejado 2, real 2.5
    }),
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(ind.consumoPorInsumo['Fibra'])), { planejado: 2, real: 2.5 });
});

test('ajustesPorInsumo (ranking "insumo mais ajustado") conta ajustes em Custom também', () => {
  const window = montarJanela();
  const ind = window.LWQualidade.calcularIndicadores([
    traco({ insumos_custom: { 'Fibra': { original: 2, ajustes: [0.5, 0.3] } } }),
  ]);

  const [labelTop, countTop] = ind.rankingMateriais[0];
  assert.equal(labelTop, 'Fibra', 'Fibra (2 ajustes) deveria estar no topo do ranking, acima dos Padrão (0 ajustes)');
  assert.equal(countTop, 2);
});

test('ajustesPorInsumoMes (tendência mensal) inclui Custom, agrupado por mês', () => {
  const window = montarJanela();
  const ind = window.LWQualidade.calcularIndicadores([
    traco({ data: '2026-08-05', insumos_custom: { 'Fibra': { original: 1, ajustes: [0.2] } } }),
    traco({ data: '2026-09-10', insumos_custom: { 'Fibra': { original: 1, ajustes: [0.1, 0.1] } } }),
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(ind.ajustesPorInsumoMes['Fibra'])), { '2026-08': 1, '2026-09': 2 });
});

test('maior desvio (Planejado×Real) pode apontar pra um insumo Custom, se for o caso', () => {
  const window = montarJanela();
  // Fibra: planejado 1, real 3 (desvio de 200%) — bem maior que qualquer
  // desvio dos 5 Padrão (todos sem ajuste neste fixture).
  const ind = window.LWQualidade.calcularIndicadores([
    traco({ insumos_custom: { 'Fibra': { original: 1, ajustes: [2] } } }),
  ]);

  assert.equal(ind.maiorDesvioLabel, 'Fibra');
  assert.equal(ind.maiorDesvioPct, 200);
});

test('traço sem nenhum insumo Custom não quebra (comportamento de sempre, só com os 5 Padrão)', () => {
  const window = montarJanela();
  const ind = window.LWQualidade.calcularIndicadores([traco()]);
  assert.equal(Object.keys(ind.cepPorInsumo).filter(k => k !== 'Densidade' && k !== 'Flow').length, 5);
});
