// ─── test/insumos-dinamicos-relatorio-injecao.test.js ───────────────────────
// Insumos de Receitas dinâmicos (ver PLANO-insumos-dinamicos-receitas.md) no
// Relatório de Injeção (dashboard.js). Cobre 2 pedidos feitos em conversas
// separadas, depois da Fase 6:
//   1º pedido — painel expansível de detalhe de cada linha (colspan, sem
//      colunas fixas):
//      - _construirTabelaAjustesPorEvento: coluna dinâmica por nome de
//        insumo Custom usado em QUALQUER ajuste deste traço (união).
//      - _tracoTemAjuste (filtro "Apenas com reajustes"): também considera
//        ajustes em insumos Custom, não só os 5 Padrão.
//      - _construirDetalheRelatorio: itera l.insumos_custom igual aos
//        5 Padrão.
//   2º pedido — revendo a decisão original de manter a TABELA principal
//      (colunas fixas) só com os 5 Padrão: agora ela também ganha 1
//      coluna por insumo Custom usado por QUALQUER traço atualmente
//      visível (já filtrado) — _garantirColunasCustomRelatorio injeta/
//      remove os <th> dinamicamente a cada render, e renderRelatorio monta
//      a célula correspondente + ajusta o colspan do painel de detalhe.
//
// Teste ESTRUTURAL (lê o código-fonte, sem boot da SPA inteira via jsdom)
// — mesmo padrão já usado em
// test/atalho-ctrl-clique-consulta-tracos.test.js para este mesmo arquivo:
// a lógica de dado (insumos_custom vindo certo do backend) já está coberta
// à exaustão pelas Fases 2/3/6; o risco novo aqui é só a integração no
// render, que essas funções puras fazem de forma direta o bastante pra um
// teste estrutural pegar erro de "esqueci de somar ao array" ou "esqueci
// de checar".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DASHBOARD_JS = fs.readFileSync(path.join(__dirname, '..', 'public/js/dashboard.js'), 'utf8');

function corpoDaFuncao(codigo, nome) {
  const inicio = codigo.indexOf(`function ${nome}(`);
  assert.ok(inicio >= 0, `não encontrei a função ${nome}`);
  // Acha o fechamento por contagem de chaves (mais robusto que procurar
  // '\n  }' — essa função tem blocos aninhados com a mesma indentação).
  let profundidade = 0, i = inicio;
  for (; i < codigo.length; i++) {
    if (codigo[i] === '{') profundidade++;
    else if (codigo[i] === '}') {
      profundidade--;
      if (profundidade === 0) break;
    }
  }
  assert.ok(i > inicio, `não encontrei o fechamento da função ${nome}`);
  return codigo.slice(inicio, i + 1);
}

test('_construirTabelaAjustesPorEvento: monta nomesCustom a partir da união de todos os eventos', () => {
  const corpo = corpoDaFuncao(DASHBOARD_JS, '_construirTabelaAjustesPorEvento');
  assert.match(corpo, /nomesCustom\s*=\s*\[\.\.\.new Set\(\s*eventos\.flatMap\(aj => Object\.keys\(aj\?\.insumos_custom \|\| \{\}\)\)/,
    'deveria unir os nomes de insumos_custom de todos os eventos deste traço');
});

test('_construirTabelaAjustesPorEvento: gera 1 célula por nome custom, lendo aj.insumos_custom[nome]', () => {
  const corpo = corpoDaFuncao(DASHBOARD_JS, '_construirTabelaAjustesPorEvento');
  assert.match(corpo, /celulasCustom\s*=\s*nomesCustom\.map\(nome => \{/);
  assert.match(corpo, /aj\?\.insumos_custom\?\.\[nome\]/);
});

test('_construirTabelaAjustesPorEvento: celulasCustom entra na linha da tabela E no cabeçalho (<th>)', () => {
  const corpo = corpoDaFuncao(DASHBOARD_JS, '_construirTabelaAjustesPorEvento');
  assert.match(corpo, /\$\{celulasInsumo\}\s*\$\{celulasCustom\}/, 'célula deveria entrar na linha, logo após as colunas fixas');
  assert.match(corpo, /nomesCustom\.map\(nome => `<th>\$\{LW\.escaparHtml\(nome\)\}<\/th>`\)/, 'cabeçalho deveria ter 1 <th> por nome custom, escapado');
});

test('_tracoTemAjuste (filtro "Apenas com reajustes"): considera ajustes em insumos_custom também', () => {
  const corpo = corpoDaFuncao(DASHBOARD_JS, '_tracoTemAjuste');
  assert.match(corpo, /Object\.values\(l\.insumos_custom \|\| \{\}\)\.some\(/,
    'deveria checar l.insumos_custom além dos 5 campos fixos (_CAMPOS_DETALHE_RELATORIO)');
});

test('_construirDetalheRelatorio (fallback pré-migração): itera l.insumos_custom com _linhaDetalheCampo', () => {
  const corpo = corpoDaFuncao(DASHBOARD_JS, '_construirDetalheRelatorio');
  assert.match(corpo, /Object\.entries\(l\.insumos_custom \|\| \{\}\)\.forEach\(/);
  assert.match(corpo, /_linhaDetalheCampo\(\{ campo: nome, label: nome, unidade: 'kg', resultado: false \}, valorBruto\)/);
});

test('_garantirColunasCustomRelatorio: injeta 1 <th data-custom-col> por nome, antes de "Tempo de Batida"', () => {
  const corpo = corpoDaFuncao(DASHBOARD_JS, '_garantirColunasCustomRelatorio');
  assert.match(corpo, /th\.setAttribute\('data-custom-col', '1'\)/);
  assert.match(corpo, /th\[data-col="tempo_batida"\]/, 'âncora deveria ser a coluna Tempo de Batida (posição das <td> na linha)');
  assert.match(corpo, /querySelectorAll\('th\[data-custom-col\]'\)\.forEach\(th => th\.remove\(\)\)/, 'precisa limpar as colunas do render anterior antes de reinjetar (lista pode mudar com o filtro)');
});

test('renderRelatorio: monta nomesCustomTabela (união dos traços filtrados) e usa nas células e no colspan do detalhe', () => {
  const corpo = corpoDaFuncao(DASHBOARD_JS, 'renderRelatorio');
  assert.match(corpo, /nomesCustomTabela\s*=\s*\[\.\.\.new Set\(\s*linhas\.flatMap\(l => Object\.keys\(l\.insumos_custom \|\| \{\}\)\)/);
  assert.match(corpo, /_garantirColunasCustomRelatorio\(nomesCustomTabela\)/);
  assert.match(corpo, /colspanTotal\s*=\s*17 \+ nomesCustomTabela\.length/);
  assert.match(corpo, /nomesCustomTabela\.map\(nome => `<td>\$\{_valRel\(l\.insumos_custom\?\.\[nome\]\)\}<\/td>`\)/,
    'célula da tabela principal deveria reaproveitar _valRel, igual os 5 Padrão');
  assert.match(corpo, /colspan="\$\{colspanTotal\}"/, 'colspan do painel de detalhe precisa crescer junto com as colunas custom');
});
