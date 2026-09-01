// ─── test/analise-focada-relacao-ac.test.js ──────────────────────────────
// Testa um bug real relatado pelo usuário: ao registrar uma receita, a
// Relação A/C aparecia certa (ex: 0,41); depois de um ajuste de água que
// deveria fazer a relação cair (ex: para 0,36), a Análise Focada — e a
// exportação dela — continuava mostrando o valor de ANTES do ajuste.
//
// Causa: detalheOperacao() (lib/db/operacoes-qualidade.js) devolve, pra
// cada traço, a receita ORIGINAL (traco.original) separada do histórico
// de ajustes (traco.ajustes) — mesmo formato que o resto do app já sabia
// somar (ver totalInsumo/operacao.js, _valRel/dashboard.js, valorFinal/
// debriefing.js). Só a Análise Focada (analise-focada.js) calculava a
// Relação A/C direto em cima de `traco.original`, ignorando `traco.
// ajustes` por completo — o valor ficava "preso" no momento em que o
// traço foi criado, mesmo depois de um ajuste real na receita.
//
// Corrigido com o helper _afTotalInsumo (exposto aqui como
// LWFocada.totalInsumo só pra este teste), usado nos dois lugares que
// calculavam a Relação A/C: o bloco "Receita Utilizada" (_renderReceita)
// e o modal "Detalhes do Berço" — ambos entram também na exportação
// (Simples, Interativa e PDF), já que reaproveitam as mesmas funções.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const CODIGO_FOCADA = fs.readFileSync(path.join(__dirname, '..', 'public/js/analise-focada.js'), 'utf8');

function montarJanela() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
  const { window } = dom;
  window.LW = {}; // stub mínimo — totalInsumo não depende de LW
  window.eval(CODIGO_FOCADA);
  return window;
}

test('totalInsumo soma original + todos os ajustes (cenário exato relatado: 100kg cimento, água 41→36)', () => {
  const window = montarJanela();
  const traco = {
    original: { cimento: 100, agua: 41 },
    ajustes: [{ ordem: 1, agua: -5, cimento: 0 }],
  };
  assert.equal(window.LWFocada.totalInsumo(traco, 'cimento'), 100);
  assert.equal(window.LWFocada.totalInsumo(traco, 'agua'), 36);
});

test('totalInsumo soma VÁRIOS ajustes em sequência (não só o último)', () => {
  const window = montarJanela();
  const traco = {
    original: { cimento: 100, agua: 40 },
    ajustes: [
      { ordem: 1, agua: -2 },
      { ordem: 2, agua: -2 },
      { ordem: 3, cimento: 5 },
    ],
  };
  assert.equal(window.LWFocada.totalInsumo(traco, 'agua'), 36);
  assert.equal(window.LWFocada.totalInsumo(traco, 'cimento'), 105);
});

test('totalInsumo sem nenhum ajuste devolve só o valor original (traço nunca ajustado)', () => {
  const window = montarJanela();
  const traco = { original: { cimento: 100, agua: 41 }, ajustes: [] };
  assert.equal(window.LWFocada.totalInsumo(traco, 'cimento'), 100);
  assert.equal(window.LWFocada.totalInsumo(traco, 'agua'), 41);
});

test('totalInsumo tolera ajuste sem o campo (ex: ajuste só de tempo de batida, sem mexer em água/cimento)', () => {
  const window = montarJanela();
  const traco = {
    original: { cimento: 100, agua: 40 },
    ajustes: [{ ordem: 1, tempo_batida: 2 }], // sem `agua`/`cimento`
  };
  assert.equal(window.LWFocada.totalInsumo(traco, 'agua'), 40);
  assert.equal(window.LWFocada.totalInsumo(traco, 'cimento'), 100);
});

test('regressão: Relação A/C calculada com o total bate 0,36 no cenário relatado, não 0,41 (bug)', () => {
  const window = montarJanela();
  window.LW.calcularRelacaoAC = function (cimento, agua) {
    const c = parseFloat(cimento), a = parseFloat(agua);
    if (isNaN(c) || c <= 0 || isNaN(a) || a < 0) return null;
    return a / c;
  };
  const traco = {
    original: { cimento: 100, agua: 41 },
    ajustes: [{ ordem: 1, agua: -5 }],
  };
  const cimentoTotal = window.LWFocada.totalInsumo(traco, 'cimento');
  const aguaTotal = window.LWFocada.totalInsumo(traco, 'agua');
  const relacao = window.LW.calcularRelacaoAC(cimentoTotal, aguaTotal);
  assert.equal(relacao.toFixed(2), '0.36', `esperava 0.36 (após o ajuste), veio ${relacao} — sinal do bug relatado (A/C preso no valor original 0.41)`);
  assert.notEqual(relacao.toFixed(2), '0.41', 'não deveria mais mostrar o valor de ANTES do ajuste');
});
