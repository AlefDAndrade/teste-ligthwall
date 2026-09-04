// ─── test/atalhos-cobertura-de-paginas.test.js ──────────────────────────────
// Auditoria feita numa conversa — "quais pages ainda não têm teclas de
// atalho e não estão na lista de teclas de atalho": de 17 páginas do app,
// 5 não tinham NENHUMA presença em keyboard-shortcuts.js (nem NAV_CONFIG
// nem REFERENCIA_CONFIG) — One Page Report, Traços Descartados, Análise
// Focada, Consulta de Insumos por Traço e Manutenção. Desta última, a
// auditoria também achou um atalho REAL já em produção (Ctrl + hover na
// tabela, mostra preview de trajetória) que nunca tinha sido catalogado —
// documentado agora sem mudar o comportamento em si.
//
// Resolvido: One Page Report e Traços Descartados ganharam Alt+dígito de
// navegação de verdade (Alt+R/Alt+T); Manutenção ganhou a entrada de
// referência do Ctrl+hover. Análise Focada e Consulta de Insumos por Traço
// ficaram de fora de propósito — são páginas de "detalhe" chegadas por
// drill-down (Ctrl+clique, já catalogado nos testes de
// test/atalho-ctrl-clique-consulta-tracos.test.js), não faz sentido um
// Alt+dígito de navegação direta pra elas.
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

test('Manutenção ganhou entrada em REFERENCIA_CONFIG documentando o Ctrl+hover que já existia (achado da auditoria)', () => {
  const referenciaConfig = extrairBloco('REFERENCIA_CONFIG');
  assert.match(referenciaConfig, /contexto: 'Manutenção'/);
  const inicioEntrada = referenciaConfig.indexOf("contexto: 'Manutenção'");
  const trechoEntrada = referenciaConfig.slice(inicioEntrada - 100, inicioEntrada + 300);
  assert.match(trechoEntrada, /page: 'manutencao'/);
  assert.match(trechoEntrada, /trajet[oó]ria/i);
});

test('o Ctrl+hover documentado bate com o comportamento real em manutencao.js (nunca documentar algo que não existe)', () => {
  const MANUTENCAO_JS = fs.readFileSync(path.join(__dirname, '..', 'public/js/manutencao.js'), 'utf8');
  assert.match(MANUTENCAO_JS, /if \(!evt\.ctrlKey\) \{ _esconderPreviewTrajetoria\(\); return; \}/);
});

test('as 5 páginas identificadas na auditoria estão contempladas de algum jeito: nav direta (novo) ou drill-down documentado (já existia)', () => {
  const navConfig = extrairBloco('NAV_CONFIG');
  const referenciaConfig = extrairBloco('REFERENCIA_CONFIG');
  const paginasComNav = new Set(extrairPaginas(navConfig));

  assert.ok(paginasComNav.has('one-page-report'), 'One Page Report deveria ter ganhado Alt+dígito');
  assert.ok(paginasComNav.has('tracos-descartados'), 'Traços Descartados deveria ter ganhado Alt+dígito');
  assert.match(referenciaConfig, /contexto: 'Manutenção'/, 'Manutenção deveria ter o Ctrl+hover documentado');
  // Análise Focada/Consulta de Insumos por Traço: decisão consciente de
  // NÃO ganhar Alt+dígito (são destino de drill-down) — só confirma que
  // o Ctrl+clique que leva até elas continua documentado.
  assert.match(referenciaConfig, /Abre a Análise Focada da opera[cç][aã]o clicada/);
  assert.match(referenciaConfig, /Abre a Consulta de Insumos daquele traço espec[ií]fico/);
});
