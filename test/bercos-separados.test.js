// ─── test/bercos-separados.test.js ──────────────────────────────────────────
// Testa "🔀 Berços Separados" (Montagem Personalizada, operacao.js/data.js):
// desde que passou a ser possível marcar os 2 lados de UM berço com tipos
// DIFERENTES (ex: um painel S/P e um 2/P no mesmo berço), cada posição de
// bercos_personalizados[] pode ser uma STRING (berço unificado, formato de
// sempre — os 2 lados são do mesmo tipo) OU um OBJETO {direita, esquerda}
// (berço separado — cada lado com seu próprio tipo). Cobre os 4 pontos que
// precisam entender os dois formatos: calcPaineisPersonalizado,
// tipoDoLadoMontagem, corDoBercoPersonalizado e resumoBercosPersonalizados.
//
// Mesmo padrão de test/calc-paineis-nao-enchido.test.js: carrega data.js DE
// VERDADE num DOM headless (script de front-end sem module.exports).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const DATA_JS = fs.readFileSync(path.join(__dirname, '..', 'public/js/data.js'), 'utf8');

const MONTAGEM_OPCOES_TESTE = [
  { label: '2/P', modo: 'simples', tipo: '2p', paineis_2p_por_berco: 2, cimenticia: { leva: true, quantidade: 2 } },
  { label: 'S/P', modo: 'simples', tipo: 'sp', paineis_sp_por_berco: 2, cimenticia: { leva: false, quantidade: 0 } },
  { label: '3T', modo: 'simples', tipo: '3t', paineis_3t_por_berco: 2, cimenticia: { leva: false, quantidade: 0 } },
  { label: 'HÍBRIDA 2p/sp', modo: 'hibrida', tipos: ['2p', 'sp'], paineis_2p_por_berco: 1, paineis_sp_por_berco: 1 },
];

function criarWindowComData() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'dangerously',
  });
  dom.window.eval(DATA_JS);
  dom.window.LW.aplicarTiposMontagemEmMemoria(MONTAGEM_OPCOES_TESTE);
  return dom.window;
}

test('calcPaineisPersonalizado: berço separado soma 1 painel de CADA tipo (não 2 do mesmo)', () => {
  const win = criarWindowComData();
  // B1 unificado (sp, 2 painéis) + B2 separado (1 painel 2p + 1 painel sp)
  const r = win.LW.calcPaineisPersonalizado(['sp', { direita: '2p', esquerda: 'sp' }]);
  assert.equal(r.paineis_por_tipo.sp, 3); // 2 (B1) + 1 (B2 esquerda)
  assert.equal(r.paineis_por_tipo['2p'], 1); // 1 (B2 direita)
  assert.equal(r.total_paineis, 4);
  assert.equal(r.m2_total, 4 * 1.83);
});

test('calcPaineisPersonalizado: berço separado com os 2 lados IGUAIS soma igual a um berço unificado', () => {
  const win = criarWindowComData();
  const separadoIgual = win.LW.calcPaineisPersonalizado([{ direita: 'sp', esquerda: 'sp' }]);
  const unificado = win.LW.calcPaineisPersonalizado(['sp']);
  assert.equal(separadoIgual.paineis_por_tipo.sp, 2);
  assert.deepEqual(separadoIgual.paineis_por_tipo, unificado.paineis_por_tipo);
});

test('calcPaineisPersonalizado: berço separado com só 1 lado definido soma só esse painel (o outro lado ainda em edição)', () => {
  const win = criarWindowComData();
  const r = win.LW.calcPaineisPersonalizado([{ direita: '3t', esquerda: null }]);
  assert.equal(r.paineis_por_tipo['3t'], 1);
  assert.equal(r.total_paineis, 1);
});

test('calcPaineisPersonalizado: cimentícia soma corretamente num berço separado (cada lado contribui pelo SEU tipo)', () => {
  const win = criarWindowComData();
  // 2/P leva 2 cimentícias por painel; S/P não leva nenhuma.
  const r = win.LW.calcPaineisPersonalizado([{ direita: '2p', esquerda: 'sp' }]);
  assert.equal(r.placas_cimenticia, 2); // 1 painel de 2p * 2 cimentícias
});

test('tipoDoLadoMontagem: berço unificado devolve o mesmo tipo pros 2 lados (comportamento de sempre)', () => {
  const win = criarWindowComData();
  const grade = ['sp'];
  assert.equal(win.LW.tipoDoLadoMontagem('PERSONALIZADA', grade, 1, 'direita'), 'sp');
  assert.equal(win.LW.tipoDoLadoMontagem('PERSONALIZADA', grade, 1, 'esquerda'), 'sp');
});

test('tipoDoLadoMontagem: berço separado devolve o tipo PRÓPRIO de cada lado, sem depender de convenção nenhuma', () => {
  const win = criarWindowComData();
  const grade = [{ direita: '2p', esquerda: '3t' }];
  assert.equal(win.LW.tipoDoLadoMontagem('PERSONALIZADA', grade, 1, 'direita'), '2p');
  assert.equal(win.LW.tipoDoLadoMontagem('PERSONALIZADA', grade, 1, 'esquerda'), '3t');
});

test('corDoBercoPersonalizado: berço unificado usa a cor sólida do tipo simples', () => {
  const win = criarWindowComData();
  const corSp = win.LW.corPorTipoSimples('sp');
  const cor = win.LW.corDoBercoPersonalizado('sp');
  assert.equal(cor.cor, corSp.cor);
  assert.equal(cor.hibrida, false);
});

test('corDoBercoPersonalizado: berço separado com os 2 lados DIFERENTES monta um gradiente 50/50 ad hoc', () => {
  const win = criarWindowComData();
  const cor = win.LW.corDoBercoPersonalizado({ direita: '2p', esquerda: '3t' });
  assert.equal(cor.hibrida, true);
  assert.ok(cor.bg.startsWith('linear-gradient('));
  assert.equal(cor.cor1, win.LW.corPorTipoSimples('2p').cor);
  assert.equal(cor.cor2, win.LW.corPorTipoSimples('3t').cor);
});

test('corDoBercoPersonalizado: berço separado com só 1 lado preenchido devolve a cor sólida desse lado (nunca gradiente com metade cinza)', () => {
  const win = criarWindowComData();
  const cor = win.LW.corDoBercoPersonalizado({ direita: '2p', esquerda: null });
  assert.equal(cor.hibrida, false);
  assert.equal(cor.cor, win.LW.corPorTipoSimples('2p').cor);
});

test('corDoBercoPersonalizado: berço separado com os 2 lados iguais devolve cor sólida (não gradiente)', () => {
  const win = criarWindowComData();
  const cor = win.LW.corDoBercoPersonalizado({ direita: 'sp', esquerda: 'sp' });
  assert.equal(cor.hibrida, false);
  assert.equal(cor.cor, win.LW.corPorTipoSimples('sp').cor);
});

test('resumoBercosPersonalizados: conta berços separados numa categoria própria, sem misturar com os unificados do mesmo tipo', () => {
  const win = criarWindowComData();
  const grade = ['sp', 'sp', { direita: '2p', esquerda: 'sp' }, null];
  const resumo = win.LW.resumoBercosPersonalizados(grade);
  assert.match(resumo, /S\/P: 2 berços/);
  assert.match(resumo, /2\/P \+ S\/P \(lados separados\): 1 berço/);
  assert.match(resumo, /Sem tipo: 1 berço/);
});
