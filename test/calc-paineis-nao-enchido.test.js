// ─── test/calc-paineis-nao-enchido.test.js ──────────────────────────────────
// Testa aplicarNaoEnchidosNoCalc() (public/js/data.js): cada lado de berço
// marcado "🚫 Não Enchido" (Bateria Atual) precisa sair do TOTAL de painéis,
// do total POR TIPO, do m² total e do m² POR TIPO — não só do total geral
// (ver conversa que motivou isso: "cada pontinho é um painel"). Também cobre
// a convenção de qual lado é qual tipo numa montagem HÍBRIDA (1º tipo da
// lista = lado direito, 2º = lado esquerdo — ver _tipoDoLadoMontagem).
//
// Diferente de test/setor-qualidade-*.test.js (que stubam LW inteiro, ver
// helpers/setor-qualidade-dom.js) — aqui CARREGA data.js de verdade num DOM
// headless, porque é justamente as funções REAIS dele que este teste cobre
// (script de front-end sem module.exports, precisa de DOM real pra rodar,
// mesmo motivo de sempre — ver topo de test/setor-qualidade-trava.test.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const DATA_JS = fs.readFileSync(path.join(__dirname, '..', 'public/js/data.js'), 'utf8');

// Mesmos 4 tipos de public/db/config.json (ver README) — 3 simples (2/P,
// S/P, 3T, todos 2 painéis/berço) + 1 híbrida (2p/sp, 1 painel de cada/berço).
const MONTAGEM_OPCOES_TESTE = [
  { label: '2/P', modo: 'simples', tipo: '2p', paineis_2p_por_berco: 2, cimenticia: { leva: true, quantidade: 2 } },
  { label: 'S/P', modo: 'simples', tipo: 'sp', paineis_sp_por_berco: 2, cimenticia: { leva: false, quantidade: 0 } },
  { label: '3T', modo: 'simples', tipo: '3t', paineis_3t_por_berco: 2, cimenticia: { leva: false, quantidade: 0 } },
  { label: 'HÍBRIDA 2p/sp', modo: 'hibrida', tipos: ['2p', 'sp'], paineis_2p_por_berco: 1, paineis_sp_por_berco: 1 },
];

// Carrega data.js DE VERDADE num window jsdom, e popula MONTAGEM_MAP/
// MONTAGEM_OPCOES/CIMENTICIA_POR_TIPO pelo MESMO caminho que loadConfig()
// usa em produção (LW.aplicarTiposMontagemEmMemoria) — evita reatribuir
// globais `let` do topo do arquivo via eval avulso, que não enxerga as
// mesmas bindings que os closures de data.js fecham por cima (script em
// 'use strict': cada eval indireto tem seu próprio escopo de topo).
function criarWindowComData() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'dangerously',
  });
  dom.window.eval(DATA_JS);
  dom.window.LW.aplicarTiposMontagemEmMemoria(MONTAGEM_OPCOES_TESTE);
  return dom.window;
}

test('sem marcações, aplicarNaoEnchidosNoCalc devolve o calc original sem alterar nada', () => {
  const win = criarWindowComData();
  const base = win.LW.calcPaineis('S/P', 10); // 10 berços -> 20 painéis sp
  const r = win.LW.aplicarNaoEnchidosNoCalc(base, 'S/P', null, {});
  assert.equal(r.total_paineis, 20);
  assert.equal(r.paineis_por_tipo.sp, 20);
  assert.equal(r.m2_total, base.m2_total);
});

test('montagem simples: 1 lado marcado nao_enchido tira 1 painel do total e do tipo único', () => {
  const win = criarWindowComData();
  const base = win.LW.calcPaineis('S/P', 10); // 20 painéis sp
  const marcacoes = { B2: { esquerda: 'nao_enchido' } };
  const r = win.LW.aplicarNaoEnchidosNoCalc(base, 'S/P', null, marcacoes);
  assert.equal(r.total_paineis, 19, 'total geral desce de 20 pra 19');
  assert.equal(r.paineis_por_tipo.sp, 19, 'total por tipo (sp) também desce');
  assert.equal(r.paineis_sp, 19, 'alias de compatibilidade também reflete');
  assert.ok(Math.abs(r.m2_total - base.m2_total) > 0.001, 'm² total também desce');
  assert.ok(Math.abs(r.m2_por_tipo.sp - base.m2_por_tipo.sp) > 0.001, 'm² por tipo também desce');
});

test('montagem simples: os 2 lados do mesmo berço marcados tiram 2 painéis (nunca mais que os 2 dots existentes)', () => {
  const win = criarWindowComData();
  const base = win.LW.calcPaineis('2/P', 5); // 10 painéis 2p
  const marcacoes = { B1: { esquerda: 'nao_enchido', direita: 'nao_enchido' } };
  const r = win.LW.aplicarNaoEnchidosNoCalc(base, '2/P', null, marcacoes);
  assert.equal(r.total_paineis, 8);
  assert.equal(r.paineis_por_tipo['2p'], 8);
});

test('"baixou" (vazamento comum, não nao_enchido) NUNCA afeta os totais', () => {
  const win = criarWindowComData();
  const base = win.LW.calcPaineis('S/P', 10);
  const marcacoes = { B2: { esquerda: 'baixou', direita: 'baixou' } };
  const r = win.LW.aplicarNaoEnchidosNoCalc(base, 'S/P', null, marcacoes);
  assert.equal(r.total_paineis, 20, 'baixou/vazou é só observação de qualidade — o painel existe, só pode ter vazado');
});

test('montagem híbrida: lado DIREITO desconta do 1º tipo da lista (convenção adotada)', () => {
  const win = criarWindowComData();
  const base = win.LW.calcPaineis('HÍBRIDA 2p/sp', 10); // 10 de 2p + 10 de sp
  const marcacoes = { B4: { direita: 'nao_enchido' } };
  const r = win.LW.aplicarNaoEnchidosNoCalc(base, 'HÍBRIDA 2p/sp', null, marcacoes);
  assert.equal(r.paineis_por_tipo['2p'], 9, '1º tipo da híbrida (2p) = lado direito');
  assert.equal(r.paineis_por_tipo['sp'], 10, 'sp (2º tipo) não é afetado por uma marcação no lado direito');
  assert.equal(r.total_paineis, 19);
});

test('montagem híbrida: lado ESQUERDO desconta do 2º tipo da lista (convenção adotada)', () => {
  const win = criarWindowComData();
  const base = win.LW.calcPaineis('HÍBRIDA 2p/sp', 10);
  const marcacoes = { B4: { esquerda: 'nao_enchido' } };
  const r = win.LW.aplicarNaoEnchidosNoCalc(base, 'HÍBRIDA 2p/sp', null, marcacoes);
  assert.equal(r.paineis_por_tipo['2p'], 10);
  assert.equal(r.paineis_por_tipo['sp'], 9, '2º tipo da híbrida (sp) = lado esquerdo');
  assert.equal(r.total_paineis, 19);
});

test('montagem personalizada: os 2 lados do berço são sempre do MESMO tipo (o tipo daquele berço na grade)', () => {
  const win = criarWindowComData();
  const bercosPersonalizados = ['sp', '2p', null, 'sp']; // B1=sp, B2=2p, B3 vazio, B4=sp
  const base = win.LW.calcPaineisPersonalizado(bercosPersonalizados);
  const marcacoes = { B1: { esquerda: 'nao_enchido', direita: 'nao_enchido' } };
  const r = win.LW.aplicarNaoEnchidosNoCalc(base, 'PERSONALIZADA', bercosPersonalizados, marcacoes);
  assert.equal(r.paineis_por_tipo.sp, base.paineis_por_tipo.sp - 2, 'B1 é sp — os 2 lados descontam de sp, nunca de 2p');
  assert.equal(r.paineis_por_tipo['2p'], base.paineis_por_tipo['2p'], '2p (do B2) não é afetado por marcação no B1');
  assert.equal(r.total_paineis, base.total_paineis - 2);
});

test('placas cimentícia recalculam junto (tipo que leva cimentícia perde a contribuição do painel removido)', () => {
  const win = criarWindowComData();
  const base = win.LW.calcPaineis('2/P', 5); // 2p leva cimentícia, qtd 2 -> 10 painéis * 2 = 20
  assert.equal(base.placas_cimenticia, 20);
  const marcacoes = { B1: { esquerda: 'nao_enchido' } };
  const r = win.LW.aplicarNaoEnchidosNoCalc(base, '2/P', null, marcacoes);
  assert.equal(r.paineis_por_tipo['2p'], 9);
  assert.equal(r.placas_cimenticia, 18, '9 painéis * 2 placas cimentícia cada');
});

test('marcação num berço fora da capacidade contada (nunca deveria acontecer, mas não quebra nem vira negativo)', () => {
  const win = criarWindowComData();
  const base = win.LW.calcPaineis('S/P', 2); // só 4 painéis sp
  const marcacoes = { B99: { esquerda: 'nao_enchido' } }; // berço que não existe nesta bateria
  const r = win.LW.aplicarNaoEnchidosNoCalc(base, 'S/P', null, marcacoes);
  // B99 não tem tipo conhecido nesta montagem simples? Na verdade toda
  // montagem simples só tem 1 tipo, então B99 ainda "conta" como sp — o
  // que importa aqui é nunca ficar negativo mesmo se marcado mais vezes
  // do que painéis existem.
  assert.ok(r.paineis_por_tipo.sp >= 0, 'nunca fica negativo');
});
