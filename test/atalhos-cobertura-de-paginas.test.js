// ─── test/atalhos-cobertura-de-paginas.test.js ──────────────────────────────
// Auditoria feita numa conversa — "quais pages ainda não têm teclas de
// atalho e não estão na lista de teclas de atalho": de 17 páginas do app,
// 5 não tinham NENHUMA presença em keyboard-shortcuts.js (nem NAV_CONFIG
// nem REFERENCIA_CONFIG) — One Page Report, Traços Descartados, Análise
// Focada, Consulta de Insumos por Traço e Manutenção (esta última removida
// do produto depois, junto com o Setor de Manutenção inteiro — ver
// histórico do git se precisar resgatar os testes específicos dela).
//
// Resolvido: One Page Report e Traços Descartados ganharam Alt+dígito de
// navegação de verdade (Alt+R/Alt+T). Análise Focada e Consulta de Insumos
// por Traço também ganharam o delas (Alt+F/Alt+I) — decisão revista numa
// conversa seguinte: percebeu-se que as 2 têm botão próprio no dropdown
// "Traços" da nav-tabbar (não são só destino de Ctrl+clique, que continua
// funcionando do mesmo jeito como atalho secundário a partir de Registro
// de Baterias/Relatório de Injeção), então por consistência com as
// demais páginas do mesmo dropdown ganharam navegação direta também.
//
// Este teste é estrutural (extrai NAV_CONFIG/REFERENCIA_CONFIG do arquivo
// real e confere as chaves) — mesmo padrão leve já usado em
// test/mesclar-backup-front-lista-completa.test.js, evita precisar do boot
// pesado da SPA inteira via jsdom só pra conferir um array estático.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CODIGO = fs.readFileSync(path.join(__dirname, '..', 'public/js/keyboard-shortcuts.js'), 'utf8');

function extrairBloco(nomeConst) {
  const inicio = CODIGO.indexOf(`const ${nomeConst} = [`);
  assert.ok(inicio >= 0, `não encontrei "const ${nomeConst} = ["`);
  const fim = CODIGO.indexOf('\n  ];', inicio);
  assert.ok(fim > inicio, `não encontrei o fechamento de ${nomeConst}`);
  return CODIGO.slice(inicio, fim);
}

function extrairPaginas(bloco) {
  return [...bloco.matchAll(/page: '([a-z-]+)'/g)].map(m => m[1]);
}

function extrairCombos(bloco) {
  return [...bloco.matchAll(/comboPadrao: '([^']+)'/g)].map(m => m[1]);
}

test('NAV_CONFIG ganhou navegação pra One Page Report e Traços Descartados', () => {
  const navConfig = extrairBloco('NAV_CONFIG');
  const paginas = extrairPaginas(navConfig);
  assert.ok(paginas.includes('one-page-report'), 'esperava "one-page-report" em NAV_CONFIG');
  assert.ok(paginas.includes('tracos-descartados'), 'esperava "tracos-descartados" em NAV_CONFIG');
});

// Bug achado numa conversa seguinte ("o setor de manutenção ficou sem
// atalho"): a auditoria original só checava "a página tem ALGUMA entrada
// em keyboard-shortcuts.js" — Manutenção passava nesse critério (tinha a
// entrada do Ctrl+hover em REFERENCIA_CONFIG), mas isso documenta uma
// AÇÃO dentro da página, não dá a NAVEGAÇÃO até ela. Este teste é mais
// rigoroso: toda página com botão PRÓPRIO na barra de navegação
// (nav-item OU nav-dropdown-item, nav-tabbar.html — nunca alcançada só
// por drill-down/Ctrl+clique) precisa ter Alt+dígito de verdade.
test('toda página com botão de navegação em nav-tabbar.html tem um Alt+dígito em NAV_CONFIG', () => {
  const NAV_TABBAR = fs.readFileSync(path.join(__dirname, '..', 'public/partials/nav-tabbar.html'), 'utf8');
  const paginasDaNavbar = [...NAV_TABBAR.matchAll(/class="nav-(?:item|dropdown-item)"[^>]*data-page="([a-z-]+)"/g)].map(m => m[1]);
  assert.ok(paginasDaNavbar.length >= 14, `esperava pelo menos 14 botões de navegação, achei ${paginasDaNavbar.length}`);

  const navConfig = extrairBloco('NAV_CONFIG');
  const paginasComAtalho = new Set(extrairPaginas(navConfig));

  const semAtalho = paginasDaNavbar.filter(p => !paginasComAtalho.has(p));
  assert.deepEqual(semAtalho, [], `página(s) com botão na navbar mas sem Alt+dígito: ${semAtalho.join(', ')}`);
});

test('nenhum combo Alt+ colide entre si (nav + ações) — cada tecla usada só uma vez', () => {
  const navConfig = extrairBloco('NAV_CONFIG');
  const actionConfig = extrairBloco('ACTION_CONFIG');
  const todosOsCombos = [...extrairCombos(navConfig), ...extrairCombos(actionConfig)].filter(c => c.startsWith('Alt+'));

  const vistos = new Set();
  const duplicados = [];
  for (const combo of todosOsCombos) {
    if (vistos.has(combo)) duplicados.push(combo);
    vistos.add(combo);
  }
  assert.deepEqual(duplicados, [], `combo(s) Alt+ duplicado(s), colidindo entre páginas/ações: ${duplicados.join(', ')}`);
});

test('as 5 páginas identificadas na auditoria estão contempladas de algum jeito: nav direta (novo) ou drill-down documentado (já existia)', () => {
  const navConfig = extrairBloco('NAV_CONFIG');
  const referenciaConfig = extrairBloco('REFERENCIA_CONFIG');
  const paginasComNav = new Set(extrairPaginas(navConfig));

  assert.ok(paginasComNav.has('one-page-report'), 'One Page Report deveria ter ganhado Alt+dígito');
  assert.ok(paginasComNav.has('tracos-descartados'), 'Traços Descartados deveria ter ganhado Alt+dígito');
  // Análise Focada/Consulta de Insumos por Traço: decisão consciente de
  // NÃO ganhar Alt+dígito (são destino de drill-down) — só confirma que
  // o Ctrl+clique que leva até elas continua documentado.
  assert.match(referenciaConfig, /Abre a Análise Focada da opera[cç][aã]o clicada/);
  assert.match(referenciaConfig, /Abre a Consulta de Insumos daquele traço espec[ií]fico/);
});
