// ─── test/relatorio-injecao-export-com-ajustes.test.js ──────────────────────
// Exportação Excel do Relatório de Injeção com 2 botões no modal:
//   "Sem os ajustes" (comportamento antigo: só o valor final de cada campo)
//   "Com os ajustes" (anexa colunas de histórico: Densidade, Flow e Insumos).
//
// Teste ESTRUTURAL + funcional: extrai as funções puras do código-fonte e
// executa num sandbox (mesmo padrão dos outros testes de dashboard.js, sem
// boot da SPA via jsdom).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DASHBOARD_JS = fs.readFileSync(path.join(__dirname, '..', 'public/js/dashboard.js'), 'utf8');
const MODAL_HTML = fs.readFileSync(path.join(__dirname, '..', 'public/partials/modal-export-relatorio.html'), 'utf8');

function extrairFuncao(nome) {
  const inicio = DASHBOARD_JS.indexOf(`  function ${nome}(`);
  assert.ok(inicio >= 0, `não encontrei a função ${nome}`);
  let profundidade = 0, i = DASHBOARD_JS.indexOf('{', inicio);
  for (; i < DASHBOARD_JS.length; i++) {
    if (DASHBOARD_JS[i] === '{') profundidade++;
    else if (DASHBOARD_JS[i] === '}' && --profundidade === 0) break;
  }
  return DASHBOARD_JS.slice(inicio, i + 1);
}

function extrairConst(nome) {
  const m = DASHBOARD_JS.match(new RegExp(`  const ${nome} = \\[[\\s\\S]*?\\n  \\];\\n`));
  assert.ok(m, `não encontrei a const ${nome}`);
  return m[0];
}

function carregar() {
  const codigo = [
    extrairConst('_CAMPOS_DETALHE_RELATORIO'),
    extrairConst('EXPORT_COLUNAS_INJECAO_AJUSTES'),
    ...['_fmtNumDetalhe', '_fmtValorDetalhe', '_numOuNull', '_valRel',
      '_historicoResultadoExport', '_historicoInsumosExport', '_gerarLinhasExportRelatorio']
      .map(extrairFuncao),
    'this.api = { _gerarLinhasExportRelatorio, EXPORT_COLUNAS_INJECAO_AJUSTES };',
  ].join('\n');
  const ctx = { LW: { formatDuration: v => `T${v}` } };
  vm.createContext(ctx);
  vm.runInContext(codigo, ctx);
  return ctx.api;
}

const TRACO = {
  data: '2026-11-01', num_traco: 1,
  flow: { original: 33, ajustes: [40, 38] },
  densidade: { original: '', ajustes: [] },
  cimento_real: { original: 100, ajustes: [5, -2] },
  agua_real: 50,
  insumos_custom: { Fibra: { original: 1, ajustes: [0.5] } },
  ultilizado: { operacao: [{ id_bateria: 'A' }, { id_bateria: 'B' }] },
};

test('modal tem os 2 botões: Sem os ajustes (false) e Com os ajustes (true)', () => {
  assert.match(MODAL_HTML, /confirmarExportRelatorio\(false\)[^>]*>[^<]*Sem os ajustes/);
  assert.match(MODAL_HTML, /confirmarExportRelatorio\(true\)[^>]*>[^<]*Com os ajustes/);
});

test('sem ajustes: linhas NÃO ganham colunas de histórico (comportamento antigo)', () => {
  const { _gerarLinhasExportRelatorio } = carregar();
  const [linha] = _gerarLinhasExportRelatorio([TRACO]);
  assert.equal(linha.flow, 38);
  assert.equal('hist_flow' in linha, false);
  assert.equal('hist_insumos' in linha, false);
});

test('com ajustes: histórico de flow mostra original → leituras', () => {
  const { _gerarLinhasExportRelatorio } = carregar();
  const [linha] = _gerarLinhasExportRelatorio([TRACO], true);
  assert.equal(linha.flow, 38, 'coluna normal continua com o valor final');
  assert.equal(linha.hist_flow, '33 → 40 → 38');
  assert.equal(linha.hist_densidade, '', 'densidade sem ajuste fica vazia');
});

test('com ajustes: histórico de insumos (padrão e custom) mostra original → ajustes → total', () => {
  const { _gerarLinhasExportRelatorio } = carregar();
  const [linha] = _gerarLinhasExportRelatorio([TRACO], true);
  assert.match(linha.hist_insumos, /Cimento: 100kg → \+5kg → -2kg → 103kg/);
  assert.match(linha.hist_insumos, /Fibra: 1kg → \+0\.5kg → 1\.5kg/);
  assert.doesNotMatch(linha.hist_insumos, /Água/, 'insumo sem ajuste não entra');
});

test('com ajustes: traço reaproveitado repete o histórico (texto), insumo segue "Reciclado"', () => {
  const { _gerarLinhasExportRelatorio } = carregar();
  const linhas = _gerarLinhasExportRelatorio([TRACO], true);
  assert.equal(linhas.length, 2);
  assert.equal(linhas[1].cimento, 'Reciclado');
  assert.equal(linhas[1].hist_flow, '33 → 40 → 38');
});

test('com ajustes: sem original informado, histórico começa na primeira leitura', () => {
  const { _gerarLinhasExportRelatorio } = carregar();
  const [linha] = _gerarLinhasExportRelatorio([{ ...TRACO, flow: { original: '', ajustes: [40, 38] } }], true);
  assert.equal(linha.hist_flow, '40 → 38');
});

test('confirmarExportRelatorio: só anexa colunas/sufixo quando comAjustes === true', () => {
  const inicio = DASHBOARD_JS.indexOf('async function confirmarExportRelatorio(');
  const corpo = DASHBOARD_JS.slice(inicio, DASHBOARD_JS.indexOf('fecharExportModalRelatorio();', inicio));
  assert.match(corpo, /comAjustes = comAjustes === true/);
  assert.match(corpo, /colsSel\.push\(\.\.\.EXPORT_COLUNAS_INJECAO_AJUSTES\)/);
  assert.match(corpo, /_gerarLinhasExportRelatorio\(dados, comAjustes\)/);
});
