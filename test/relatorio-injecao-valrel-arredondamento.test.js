// ─── test/relatorio-injecao-valrel-arredondamento.test.js ───────────────────
// _valRel (dashboard.js) soma original + ajustes de um insumo pra exibir no
// Relatório de Injeção. Sem arredondar, o ponto flutuante vazava pra tela
// (430.6 + 0.6 = 431.20000000000005). Mesmo padrão de extração por vm dos
// outros testes de dashboard.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DASHBOARD_JS = fs.readFileSync(path.join(__dirname, '..', 'public/js/dashboard.js'), 'utf8');

function carregarValRel() {
  const m = DASHBOARD_JS.match(/  function _valRel\([\s\S]*?\n  \}\n/);
  assert.ok(m, 'não encontrei _valRel');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${m[0]}\nthis._valRel = _valRel;`, ctx);
  return ctx._valRel;
}

test('soma com ruído de ponto flutuante sai limpa (430.6 + 0.6 → 431.2)', () => {
  const _valRel = carregarValRel();
  assert.equal(_valRel({ original: 430.6, ajustes: [0.6] }), 431.2);
  assert.equal(String(_valRel({ original: 430.6, ajustes: [0.6] })), '431.2');
});

test('vários ajustes e negativos continuam somando certo', () => {
  const _valRel = carregarValRel();
  assert.equal(_valRel({ original: 425.3, ajustes: [5.9, -0.2] }), 431);
  assert.equal(_valRel({ original: 1047, ajustes: [] }), 1047);
});

test('densidade/flow continuam sendo a última leitura (sem soma)', () => {
  const _valRel = carregarValRel();
  assert.equal(_valRel({ original: 33, ajustes: [40, 38] }, 'flow'), 38);
});

test('vazio continua "—" e valor simples passa direto', () => {
  const _valRel = carregarValRel();
  assert.equal(_valRel({ original: '', ajustes: [] }), '—');
  assert.equal(_valRel(null), '—');
  assert.equal(_valRel(50), 50);
});
