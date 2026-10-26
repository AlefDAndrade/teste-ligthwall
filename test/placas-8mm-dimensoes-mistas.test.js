// ─── test/placas-8mm-dimensoes-mistas.test.js ───────────────────────────────
// Placas cimentícias de 8 mm (painéis de 9,5 cm) e baterias com espessuras
// mistas (ex: berços 1-10 = 9,5 cm, 11-20 = 9 cm). Cobre calcPlacas8mm,
// dimensaoUsaPlaca8mm, dimensoesDistintas e rotuloDimensoesMistas (data.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const DATA_JS = fs.readFileSync(path.join(__dirname, '..', 'public/js/data.js'), 'utf8');

const MONTAGEM_OPCOES_TESTE = [
  // cada painel leva 2 placas cimentícias → 2 painéis/berço = 4 placas/berço
  { label: '2/P', modo: 'simples', tipo: '2p', paineis_2p_por_berco: 2, cimenticia: { leva: true, quantidade: 2 } },
  { label: 'S/P', modo: 'simples', tipo: 'sp', paineis_sp_por_berco: 2, cimenticia: { leva: false, quantidade: 0 } },
  { label: 'HÍBRIDA 2p/sp', modo: 'hibrida', tipos: ['2p', 'sp'], paineis_2p_por_berco: 1, paineis_sp_por_berco: 1 },
];

function criarLW() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'dangerously' });
  dom.window.eval(DATA_JS);
  dom.window.LW.aplicarTiposMontagemEmMemoria(MONTAGEM_OPCOES_TESTE);
  return dom.window.LW;
}

test('dimensaoUsaPlaca8mm: só 9,5 cm usa placa de 8 mm', () => {
  const LW = criarLW();
  assert.equal(LW.dimensaoUsaPlaca8mm('9,5 cm'), true);
  assert.equal(LW.dimensaoUsaPlaca8mm('9.5'), true);
  assert.equal(LW.dimensaoUsaPlaca8mm('9 cm'), false);
  assert.equal(LW.dimensaoUsaPlaca8mm(''), false);
  assert.equal(LW.dimensaoUsaPlaca8mm(null), false);
});

test('calcPlacas8mm: bateria toda de 9 cm não consome placa de 8 mm', () => {
  const LW = criarLW();
  const n = LW.calcPlacas8mm({ tipoMontagem: '2/P', capacidade: 20, dimensaoGeral: '9 cm', bercosDimensoes: null, marcacoes: {} });
  assert.equal(n, 0);
});

test('calcPlacas8mm: bateria toda de 9,5 cm = todos os berços em 8 mm', () => {
  const LW = criarLW();
  const n = LW.calcPlacas8mm({ tipoMontagem: '2/P', capacidade: 20, dimensaoGeral: '9,5 cm', bercosDimensoes: null, marcacoes: {} });
  assert.equal(n, 20 * 4);
});

test('calcPlacas8mm: mista (berços 1-10 = 9,5 cm, 11-20 = 9 cm) conta só os 10 berços de 8 mm', () => {
  const LW = criarLW();
  const dims = Array.from({ length: 20 }, (_, i) => (i < 10 ? '9,5 cm' : null));
  const n = LW.calcPlacas8mm({ tipoMontagem: '2/P', capacidade: 20, dimensaoGeral: '9 cm', bercosDimensoes: dims, marcacoes: {} });
  assert.equal(n, 10 * 4);
});

test('calcPlacas8mm: lado "Não Enchido" em berço de 8 mm desconta as placas daquele painel', () => {
  const LW = criarLW();
  const dims = ['9,5 cm', null];
  const n = LW.calcPlacas8mm({
    tipoMontagem: '2/P', capacidade: 2, dimensaoGeral: '9 cm', bercosDimensoes: dims,
    marcacoes: { B1: { direita: 'nao_enchido' }, B2: { direita: 'nao_enchido' } }, // B2 é 9 cm: não afeta
  });
  assert.equal(n, 4 - 2);
});

test('calcPlacas8mm: Personalizada ignora berço vazio mesmo sendo 9,5 cm', () => {
  const LW = criarLW();
  const n = LW.calcPlacas8mm({
    tipoMontagem: LW.TIPO_MONTAGEM_PERSONALIZADA, bercosPersonalizados: ['2p', null, 'sp'],
    capacidade: 3, dimensaoGeral: '9,5 cm', bercosDimensoes: null, marcacoes: {},
  });
  assert.equal(n, 4); // só o berço 1 (2/P); berço 2 vazio; berço 3 S/P não leva placa
});

test('rotuloDimensoesMistas: identifica baterias com espessuras diferentes', () => {
  const LW = criarLW();
  const dims = Array.from({ length: 20 }, (_, i) => (i < 10 ? '9,5 cm' : null));
  assert.equal(LW.rotuloDimensoesMistas(20, '9 cm', dims), 'Personalizada / 9,5 cm + 9 cm');
  assert.equal(LW.rotuloDimensoesMistas(20, '9 cm', null), null);
  assert.deepEqual(Array.from(LW.dimensoesDistintas(20, '9 cm', dims)), ['9,5 cm', '9 cm']);
});

// ─── Dimensão por LADO (painel) do berço ────────────────────────────────────

test('calcPlacas8mm: só a direita de 9,5 cm = 1 painel × 2 placas', () => {
  const LW = criarLW();
  const n = LW.calcPlacas8mm({
    tipoMontagem: '2/P', capacidade: 2, dimensaoGeral: '9 cm',
    bercosDimensoes: [{ direita: '9,5 cm', esquerda: null }, null], marcacoes: {},
  });
  assert.equal(n, 2);
});

test('calcPlacas8mm: lados diferentes, Não Enchido só desconta o lado que é de 8 mm', () => {
  const LW = criarLW();
  const base = { tipoMontagem: '2/P', capacidade: 1, dimensaoGeral: '9 cm', bercosDimensoes: [{ direita: '9,5 cm', esquerda: '9 cm' }] };
  assert.equal(LW.calcPlacas8mm({ ...base, marcacoes: {} }), 2);
  assert.equal(LW.calcPlacas8mm({ ...base, marcacoes: { B1: { direita: 'nao_enchido' } } }), 0);
  assert.equal(LW.calcPlacas8mm({ ...base, marcacoes: { B1: { esquerda: 'nao_enchido' } } }), 2); // lado de 9 cm: nada a descontar
});

test('calcPlacas8mm: Híbrida usa o tipo do lado de 8 mm (2p na direita leva placa, sp na esquerda não)', () => {
  const LW = criarLW();
  const base = { tipoMontagem: 'HÍBRIDA 2p/sp', capacidade: 1, dimensaoGeral: '9 cm', marcacoes: {} };
  assert.equal(LW.calcPlacas8mm({ ...base, bercosDimensoes: [{ direita: '9,5 cm', esquerda: null }] }), 2);
  assert.equal(LW.calcPlacas8mm({ ...base, bercosDimensoes: [{ direita: null, esquerda: '9,5 cm' }] }), 0);
});

test('lados: efetivas, texto do berço, distintas e rótulo', () => {
  const LW = criarLW();
  const dims = [{ direita: '9,5 cm', esquerda: null }, '9,5 cm', null];
  const lados = Array.from(LW.dimensoesEfetivasPorLado(3, '9 cm', dims), l => ({ ...l }));
  assert.deepEqual(lados, [{ direita: '9,5 cm', esquerda: '9 cm' }, { direita: '9,5 cm', esquerda: '9,5 cm' }, { direita: '9 cm', esquerda: '9 cm' }]);
  assert.equal(LW.textoDimensaoBerco(dims[0], '9 cm'), 'Dir. 9,5 cm · Esq. 9 cm');
  assert.equal(LW.textoDimensaoBerco(dims[1], '9 cm'), '9,5 cm');
  assert.equal(LW.textoDimensaoBerco(null, '9 cm'), '9 cm');
  assert.equal(LW.rotuloDimensoesMistas(1, '9 cm', [{ direita: '9,5 cm', esquerda: null }]), 'Personalizada / 9,5 cm + 9 cm');
});

test('compactarBercosDimensoes: ida e volta com dimensoesEfetivasPorLado', () => {
  const LW = criarLW();
  const original = [{ direita: '9,5 cm', esquerda: null }, '9,5 cm', null];
  const lados = Array.from(LW.dimensoesEfetivasPorLado(3, '9 cm', original), l => ({ ...l }));
  const compacto = JSON.parse(JSON.stringify(LW.compactarBercosDimensoes(lados, '9 cm')));
  assert.deepEqual(compacto, [{ direita: '9,5 cm', esquerda: null }, '9,5 cm', null]);
  assert.equal(LW.compactarBercosDimensoes([{ direita: '9 cm', esquerda: '9 cm' }], '9 cm'), null);
});
