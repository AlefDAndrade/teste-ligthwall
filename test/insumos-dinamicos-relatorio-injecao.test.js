// ─── test/insumos-dinamicos-relatorio-injecao.test.js ───────────────────────
// Insumos de Receitas dinâmicos (ver PLANO-insumos-dinamicos-receitas.md) no
// painel de detalhe do Relatório de Injeção (dashboard.js) — pedido feito
// numa conversa depois da Fase 6 ("vamos para o relatório de traço"): a
// tabela principal (colunas fixas) continua só com os 5 Padrão, de
// propósito (decisão registrada no plano — é papel da Consulta de Insumos
// por Traço mostrar Custom numa tabela). O que MUDA aqui é o painel
// expansível de detalhe de cada linha (colspan, sem colunas fixas), que
// ganha os insumos Custom:
//   1. _construirTabelaAjustesPorEvento: coluna dinâmica por nome de
//      insumo Custom usado em QUALQUER ajuste deste traço (união).
//   2. _tracoTemAjuste (filtro "Apenas com reajustes"): também considera
//      ajustes em insumos Custom, não só os 5 Padrão.
//   3. _construirDetalheRelatorio (fallback, dado anterior à migração de
//      eventos): itera l.insumos_custom igual aos 5 Padrão.
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

test('a tabela principal (colunas fixas do <tr>) continua só com os 5 Padrão — decisão de escopo do plano', () => {
  // Não deveria ter nenhuma referência a insumos_custom na parte que
  // monta as células FIXAS da linha principal (<td>${_valRel(l.cimento_real)}</td>
  // etc.) — só no painel de detalhe (colspan), que é o que os testes
  // acima cobrem. Ver PLANO-insumos-dinamicos-receitas.md, decisão de
  // manter a tabela principal com colunas fixas.
  const inicioLinhaFixa = DASHBOARD_JS.indexOf('<td>${_valRel(l.cimento_real)}</td>');
  const fimLinhaFixa = DASHBOARD_JS.indexOf('</tr>', inicioLinhaFixa);
  assert.ok(inicioLinhaFixa >= 0 && fimLinhaFixa > inicioLinhaFixa);
  const trechoLinhaFixa = DASHBOARD_JS.slice(inicioLinhaFixa, fimLinhaFixa);
  assert.ok(!trechoLinhaFixa.includes('insumos_custom'), 'a linha principal (colunas fixas) não deveria ganhar colunas de Custom');
});
