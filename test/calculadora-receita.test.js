// ─── test/calculadora-receita.test.js ───────────────────────────────────────
// Calculadora de receita dimensionada (popover "🧮 Calc. Receita" em Registrar
// Operação) — public/js/calculadora-receita.js.
//   1) funções puras (regra de três, relação A/C, formatação);
//   2) ligação com o DOM, usando o markup REAL de partials/page-operacao.html
//      (se um id mudar lá sem mudar no JS, o teste quebra).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const calc = require('../public/js/calculadora-receita.js');

const CODIGO = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'calculadora-receita.js'), 'utf8');
const PARTIAL = fs.readFileSync(path.join(__dirname, '..', 'public', 'partials', 'page-operacao.html'), 'utf8');

const BASE_PADRAO = Object.fromEntries(calc.COMPONENTES.map(c => [c.id, c.base]));

// ── 1) Funções puras ────────────────────────────────────────────────────────

test('calcularReceita: regra de três sobre a receita base (9 → 4 berços)', () => {
  const r = calc.calcularReceita(BASE_PADRAO, 9, 4);
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.fator - 4 / 9) < 1e-12);
  assert.ok(Math.abs(r.itens.cimento - 1050 * 4 / 9) < 1e-9);
  assert.ok(Math.abs(r.itens.agua - 425 * 4 / 9) < 1e-9);
  assert.ok(Math.abs(r.itens.ar - 4.6 * 4 / 9) < 1e-9);
});

test('calcularReceita: mesma quantidade de berços devolve a receita base; zero berços zera tudo', () => {
  assert.deepEqual(calc.calcularReceita(BASE_PADRAO, 9, 9).itens, BASE_PADRAO);
  const zero = calc.calcularReceita(BASE_PADRAO, 9, 0);
  assert.equal(zero.ok, true);
  assert.ok(Object.values(zero.itens).every(v => v === 0));
});

test('calcularReceita: insumo vazio/inválido conta como 0 (não vira NaN)', () => {
  const r = calc.calcularReceita({ ...BASE_PADRAO, eps: NaN }, 9, 4);
  assert.equal(r.itens.eps, 0);
});

test('validarBercos: recusa receita que enche 0/vazio e alvo negativo/vazio', () => {
  assert.match(calc.validarBercos(0, 4), /receita atual enche/);
  assert.match(calc.validarBercos(NaN, 4), /receita atual enche/);
  assert.match(calc.validarBercos(-1, 4), /receita atual enche/);
  assert.match(calc.validarBercos(9, -1), /quantidade de berços válida/);
  assert.match(calc.validarBercos(9, NaN), /quantidade de berços válida/);
  assert.equal(calc.validarBercos(9, 0), null);
  assert.equal(calc.calcularReceita(BASE_PADRAO, 0, 4).ok, false);
});

test('avaliarAC: faixa ideal 0,35–0,40 (limites incluídos)', () => {
  assert.equal(calc.avaliarAC(1000, 350).situacao, 'ideal');
  assert.equal(calc.avaliarAC(1000, 375).situacao, 'ideal');
  assert.equal(calc.avaliarAC(1000, 400).situacao, 'ideal');
  assert.equal(calc.avaliarAC(1000, 349).situacao, 'abaixo');
  assert.equal(calc.avaliarAC(1000, 401).situacao, 'acima');
});

test('avaliarAC: sem cimento (ou água negativa/vazia) não calcula', () => {
  assert.equal(calc.avaliarAC(0, 400).valido, false);
  assert.equal(calc.avaliarAC(NaN, 400).valido, false);
  assert.equal(calc.avaliarAC(1000, NaN).valido, false);
  assert.equal(calc.avaliarAC(1000, -1).valido, false);
  assert.equal(calc.avaliarAC(1000, 0).valido, true); // água 0 é válido (A/C = 0 → "abaixo")
});

test('formatar: pt-BR; sem milhar quando for pra copiar', () => {
  assert.equal(calc.formatar(1050, 2), '1.050');
  assert.equal(calc.formatar(1050, 2, false), '1050');
  assert.equal(calc.formatar(1050 * 4 / 9, 2), '466,67');
  assert.equal(calc.formatar(4 / 9, 4), '0,4444');
  assert.equal(calc.formatar(2333.333333, 2, false), '2333,33');
  assert.equal(calc.formatar(5, 2), '5');
});

test('ajustarValor: soma/tira um passo', () => {
  assert.equal(calc.ajustarValor(1050, 10, 1), 1060);
  assert.equal(calc.ajustarValor(1050, 10, -1), 1040);
  assert.equal(calc.ajustarValor(5.5, 0.1, -1), 5.4);
});

test('ajustarValor: sem erro de ponto flutuante (4,6 + 0,1 = 4,7, não 4,699999999999999)', () => {
  assert.equal(calc.ajustarValor(4.6, 0.1, 1), 4.7);
  assert.equal(calc.ajustarValor(0.1, 0.2, 1), 0.3);
  assert.equal(calc.ajustarValor(5.55, 0.1, 1), 5.65); // não perde a casa extra que a pessoa digitou
});

test('ajustarValor: nunca fica abaixo de 0; vazio/inválido conta como 0', () => {
  assert.equal(calc.ajustarValor(0.05, 0.1, -1), 0);
  assert.equal(calc.ajustarValor(0, 10, -1), 0);
  assert.equal(calc.ajustarValor(NaN, 10, 1), 10);
  assert.equal(calc.ajustarValor(NaN, 10, -1), 0);
});

test('todo insumo tem um passo positivo', () => {
  assert.ok(calc.COMPONENTES.every(c => c.passo > 0));
});

// ── 2) Ligação com o DOM ────────────────────────────────────────────────────

let dom;
let doc;

function montarDom() {
  dom = new JSDOM('<!DOCTYPE html><html><body>' + PARTIAL + '</body></html>', { runScripts: 'outside-only' });
  dom.window.eval(CODIGO); // navegador: expõe window.LWCalcReceita (e liga sozinho quando o DOM carrega)
  doc = dom.window.document;
  dom.window.LWCalcReceita.montar(doc); // idempotente — garante a montagem sem esperar o DOMContentLoaded
}

beforeEach(montarDom);
afterEach(() => dom.window.close());

const $ = id => doc.getElementById(id);
function digitar(id, valor) {
  const inp = $(id);
  inp.value = String(valor);
  inp.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

test('DOM: monta 1 linha por insumo (base + resultado), com o cálculo padrão já feito', () => {
  assert.equal($('calc-rec-body').querySelectorAll('tr').length, 5);
  assert.equal(doc.querySelectorAll('#calc-rec-body input').length, 5);
  assert.equal(doc.querySelectorAll('#calc-rec-body .calc-rec-copy').length, 5);
  assert.equal($('calc-rec-fator').textContent, '0,4444');
  assert.equal($('calc-rec-alvo-txt').textContent, '4');
  assert.equal($('calc-rec-ex-cimento').textContent, '466,67');
  assert.equal($('calc-rec-ex-eps').textContent, '11,11');
  assert.equal($('calc-rec-aviso').hidden, true);
});

test('DOM: montar é idempotente (2ª chamada não duplica linhas nem eventos)', () => {
  assert.equal(dom.window.LWCalcReceita.montar(doc), null);
  assert.equal($('calc-rec-body').querySelectorAll('tr').length, 5);
});

test('DOM: mudar o alvo recalcula; milhar aparece na tela mas NÃO no texto copiado', () => {
  digitar('calc-rec-bercos-alvo', 9);
  assert.equal($('calc-rec-fator').textContent, '1');
  assert.equal($('calc-rec-ex-cimento').textContent, '1.050');
  assert.equal($('calc-rec-ex-cimento').dataset.copiar, '1050');
  assert.equal($('calc-rec-ex-agua').dataset.copiar, '425');
});

test('DOM: editar a receita base recalcula o resultado', () => {
  digitar('calc-rec-base-cimento', 900);
  assert.equal($('calc-rec-ex-cimento').textContent, '400'); // 900 * 4/9
});

test('DOM: berços da receita inválido mostra o aviso e limpa o resultado', () => {
  digitar('calc-rec-bercos-base', 0);
  assert.equal($('calc-rec-aviso').hidden, false);
  assert.match($('calc-rec-aviso').textContent, /receita atual enche/);
  assert.equal($('calc-rec-fator').textContent, '–');
  assert.equal($('calc-rec-ex-cimento').textContent, '–');
  assert.equal($('calc-rec-ex-cimento').dataset.copiar, '');

  digitar('calc-rec-bercos-base', 9); // corrigiu → volta ao normal
  assert.equal($('calc-rec-aviso').hidden, true);
  assert.equal($('calc-rec-ex-cimento').textContent, '466,67');
});

test('DOM: indicador A/C — ideal (verde), fora (vermelho) e sem cimento', () => {
  const box = $('calc-rec-ac-box');

  digitar('calc-rec-base-cimento', 1000);
  digitar('calc-rec-base-agua', 375);
  assert.ok(box.classList.contains('ok'));
  assert.equal($('calc-rec-ac-val').textContent, '0,38');
  assert.equal($('calc-rec-ac-msg').textContent, 'Ideal (0,35 a 0,40)');

  digitar('calc-rec-base-agua', 300);
  assert.ok(box.classList.contains('fora') && !box.classList.contains('ok'));
  assert.equal($('calc-rec-ac-msg').textContent, 'Abaixo do ideal (0,35 a 0,40)');

  digitar('calc-rec-base-agua', 500);
  assert.equal($('calc-rec-ac-msg').textContent, 'Acima do ideal (0,35 a 0,40)');

  digitar('calc-rec-base-cimento', 0);
  assert.ok(!box.classList.contains('ok') && !box.classList.contains('fora'));
  assert.equal($('calc-rec-ac-val').textContent, '–');
  assert.equal($('calc-rec-ac-msg').textContent, 'informe água e cimento');
});

test('DOM: "Restaurar padrão" devolve receita base, berços e resultado', () => {
  digitar('calc-rec-bercos-alvo', 12);
  digitar('calc-rec-base-cimento', 777);
  $('calc-rec-resetar').click();
  assert.equal($('calc-rec-bercos-base').value, '9');
  assert.equal($('calc-rec-bercos-alvo').value, '4');
  assert.equal($('calc-rec-base-cimento').value, '1050');
  assert.equal($('calc-rec-ex-cimento').textContent, '466,67');
});

test('DOM: botão de copiar manda o valor SEM milhar pra área de transferência e dá feedback sem trocar o SVG', async () => {
  const copiados = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: { writeText: async t => { copiados.push(t); } },
    configurable: true,
  });
  digitar('calc-rec-bercos-alvo', 9);

  const btn = doc.querySelector('.calc-rec-copy[data-alvo="calc-rec-ex-cimento"]');
  const svg = btn.querySelector('svg');
  btn.click();
  await new Promise(r => setTimeout(r, 0));

  assert.deepEqual(copiados, ['1050']);
  assert.ok(btn.classList.contains('ok'));
  assert.ok(btn.contains(svg), 'o ícone não pode ser recriado (senão o clique-fora fecharia o popover)');
});

test('DOM: copiar não faz nada quando não há resultado válido', async () => {
  const copiados = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: { writeText: async t => { copiados.push(t); } },
    configurable: true,
  });
  digitar('calc-rec-bercos-base', 0);
  doc.querySelector('.calc-rec-copy').click();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(copiados, []);
});

test('DOM: o botão do partial abre o popover certo pelo togglePopover do app', () => {
  const botao = doc.querySelector('.calc-rec-wrap > button');
  assert.match(botao.getAttribute('onclick'), /togglePopover\('popover-calc-receita'/);
  const pop = $('popover-calc-receita');
  assert.ok(pop.classList.contains('ao-popover'));
  assert.ok(pop.contains($('calc-rec')));
});

// ── Botões − / + ────────────────────────────────────────────────────────────
const botaoCampo = (idInput, dir) =>
  doc.querySelector('.calc-rec-btn-passo[data-alvo="' + idInput + '"][data-dir="' + dir + '"]');
const botaoPasso = (insumo, dir) => botaoCampo('calc-rec-base-' + insumo, dir);

test('DOM: cada insumo tem um botão − e um + ao lado da quantidade base', () => {
  assert.equal(doc.querySelectorAll('#calc-rec-body .calc-rec-btn-passo').length, 10);
  calc.COMPONENTES.forEach(c => {
    assert.ok(botaoPasso(c.id, -1) && botaoPasso(c.id, 1), c.id);
  });
});

test('DOM: + aumenta o insumo pelo passo e o resultado recalcula na hora', () => {
  botaoPasso('cimento', 1).click();
  assert.equal($('calc-rec-base-cimento').value, '1060');
  assert.equal($('calc-rec-ex-cimento').textContent, '471,11'); // 1060 * 4/9
  botaoPasso('cimento', -1).click();
  botaoPasso('cimento', -1).click();
  assert.equal($('calc-rec-base-cimento').value, '1040');
});

test('DOM: passo decimal não suja o campo (4,6 + 0,1 → 4.7)', () => {
  botaoPasso('ar', 1).click();
  assert.equal($('calc-rec-base-ar').value, '4.7');
  botaoPasso('super', -1).click();
  assert.equal($('calc-rec-base-super').value, '5.4');
});

test('DOM: − para em 0 e campo vazio vira 1 passo ao clicar em +', () => {
  digitar('calc-rec-base-eps', 0);
  botaoPasso('eps', -1).click();
  assert.equal($('calc-rec-base-eps').value, '0');
  digitar('calc-rec-base-eps', '');
  botaoPasso('eps', 1).click();
  assert.equal($('calc-rec-base-eps').value, '1');
});

test('DOM: mexer na água pelos botões atualiza o indicador A/C', () => {
  digitar('calc-rec-base-cimento', 1000);
  digitar('calc-rec-base-agua', 395);
  assert.ok($('calc-rec-ac-box').classList.contains('ok'));
  botaoPasso('agua', 1).click(); // 400 → ainda ideal
  botaoPasso('agua', 1).click(); // 405 → 0,405 acima
  assert.ok($('calc-rec-ac-box').classList.contains('fora'));
  assert.equal($('calc-rec-ac-msg').textContent, 'Acima do ideal (0,35 a 0,40)');
});

test('DOM: botões − / + não disparam o copiar nem mexem nos berços', () => {
  botaoPasso('cimento', 1).click();
  assert.equal($('calc-rec-bercos-base').value, '9');
  assert.equal($('calc-rec-bercos-alvo').value, '4');
  assert.equal(doc.querySelectorAll('.calc-rec-copy.ok').length, 0);
});

test('DOM: "Restaurar padrão" desfaz o que os botões mudaram', () => {
  botaoPasso('cimento', 1).click();
  botaoPasso('ar', 1).click();
  $('calc-rec-resetar').click();
  assert.equal($('calc-rec-base-cimento').value, '1050');
  assert.equal($('calc-rec-base-ar').value, '4.6');
});

// ── Botões − / + dos campos de berços ───────────────────────────────────────

test('DOM: todo botão − / + aponta pra um input que existe e tem passo positivo', () => {
  const botoes = doc.querySelectorAll('.calc-rec-btn-passo');
  assert.equal(botoes.length, 14); // 10 dos insumos + 4 dos berços
  botoes.forEach(b => {
    const inp = $(b.dataset.alvo);
    assert.ok(inp && inp.type === 'number', 'alvo inexistente: ' + b.dataset.alvo);
    assert.ok(parseFloat(b.dataset.passo) > 0, 'passo inválido em ' + b.dataset.alvo);
    assert.ok(b.dataset.dir === '-1' || b.dataset.dir === '1');
    assert.ok(b.getAttribute('aria-label'), 'falta aria-label em ' + b.dataset.alvo);
  });
});

test('DOM: os dois campos de berços têm − e +', () => {
  ['calc-rec-bercos-base', 'calc-rec-bercos-alvo'].forEach(id => {
    assert.ok(botaoCampo(id, -1) && botaoCampo(id, 1), id);
  });
});

test('DOM: + em "Quero encher" sobe 1 berço e o resultado recalcula', () => {
  botaoCampo('calc-rec-bercos-alvo', 1).click();
  assert.equal($('calc-rec-bercos-alvo').value, '5');
  assert.equal($('calc-rec-alvo-txt').textContent, '5');
  assert.equal($('calc-rec-ex-cimento').textContent, '583,33'); // 1050 * 5/9
  botaoCampo('calc-rec-bercos-alvo', -1).click();
  botaoCampo('calc-rec-bercos-alvo', -1).click();
  assert.equal($('calc-rec-bercos-alvo').value, '3');
  assert.equal($('calc-rec-ex-cimento').textContent, '350'); // 1050 * 3/9
});

test('DOM: − em "Esta receita enche" muda o fator (9 → 8 berços: 4/8 = 0,5)', () => {
  botaoCampo('calc-rec-bercos-base', -1).click();
  assert.equal($('calc-rec-bercos-base').value, '8');
  assert.equal($('calc-rec-fator').textContent, '0,5');
  assert.equal($('calc-rec-ex-cimento').textContent, '525'); // 1050 * 0,5
});

test('DOM: "Quero encher" para em 0 (receita zerada, sem erro); "Esta receita" em 0 mostra o aviso e volta com +', () => {
  digitar('calc-rec-bercos-alvo', 1);
  botaoCampo('calc-rec-bercos-alvo', -1).click();
  botaoCampo('calc-rec-bercos-alvo', -1).click(); // já em 0: continua 0
  assert.equal($('calc-rec-bercos-alvo').value, '0');
  assert.equal($('calc-rec-aviso').hidden, true);
  assert.equal($('calc-rec-ex-cimento').textContent, '0');

  digitar('calc-rec-bercos-base', 1);
  botaoCampo('calc-rec-bercos-base', -1).click();
  assert.equal($('calc-rec-bercos-base').value, '0');
  assert.equal($('calc-rec-aviso').hidden, false);
  botaoCampo('calc-rec-bercos-base', 1).click();
  assert.equal($('calc-rec-bercos-base').value, '1');
  assert.equal($('calc-rec-aviso').hidden, true);
});

test('DOM: berço fracionado digitado continua fracionado (4,5 + 1 = 5,5) e campo vazio vira 1', () => {
  digitar('calc-rec-bercos-alvo', 4.5);
  botaoCampo('calc-rec-bercos-alvo', 1).click();
  assert.equal($('calc-rec-bercos-alvo').value, '5.5');
  digitar('calc-rec-bercos-alvo', '');
  botaoCampo('calc-rec-bercos-alvo', 1).click();
  assert.equal($('calc-rec-bercos-alvo').value, '1');
});

test('DOM: "Restaurar padrão" desfaz o que os botões de berços mudaram', () => {
  botaoCampo('calc-rec-bercos-base', 1).click();
  botaoCampo('calc-rec-bercos-alvo', 1).click();
  $('calc-rec-resetar').click();
  assert.equal($('calc-rec-bercos-base').value, '9');
  assert.equal($('calc-rec-bercos-alvo').value, '4');
});
