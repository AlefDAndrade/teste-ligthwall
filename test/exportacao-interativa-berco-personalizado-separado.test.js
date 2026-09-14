// ─── test/exportacao-interativa-berco-personalizado-separado.test.js ─────
// Bug relatado: depois da correção de cor dos berços "🔀 Berços Separados"
// na tela ao vivo (_corPorTipoBerco passou a chamar
// LW.corDoBercoPersonalizado em vez de LW.corPorTipoSimples — ver
// analise-focada-berco-personalizado-separado.test.js), a Exportação
// Interativa (e o PDF, que reaproveita o MESMO HTML autossuficiente, ver
// exportarPDF em analise-focada.js) quebrou por completo: só as seções
// (títulos dos .chart-box) apareciam, sem berços, sem receita, sem nada.
//
// Causa: _gerarHtmlAfStandalone embute, dentro do <script> do HTML
// exportado, uma cópia "fake" do objeto global `LW` (o arquivo exportado é
// offline e não carrega data.js) — mas essa cópia só tinha
// corPorTipoSimples/corMontagemPorLabel, SEM corDoBercoPersonalizado.
// Assim que _renderBercos (reembutido via toString()) chamava
// LW.corDoBercoPersonalizado(tipo) pra colorir um berço de Montagem
// Personalizada, estourava TypeError ("LW.corDoBercoPersonalizado is not
// a function") — e como a chamada final não está em try/catch, a exceção
// interrompia o <script> inteiro NO MEIO da execução: tudo que ainda não
// tinha rodado (_renderReceita, _renderAvaliacao, _renderParadas, e até o
// resto de _renderBercos) nunca executava, deixando as divs #af-bercos,
// #af-receita etc. vazias — só o HTML estático (títulos das seções) sobrava.
//
// Corrigido adicionando _afCorDoBercoPersonalizado (mesma lógica de
// corDoBercoPersonalizado, data.js, reimplementada com o prefixo "_af"
// como as outras funções de cor desta seção) ao objeto `LW` fake do
// export.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const CODIGO_FOCADA = fs.readFileSync(path.join(__dirname, '..', 'public/js/analise-focada.js'), 'utf8');

// Mesmo padrão de test/exportacao-interativa-receita-vazia.test.js: monta
// a janela "autora" (onde LWFocada.gerarHtmlStandalone roda) com um stub
// mínimo de LW.
function montarJanelaAutora() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
  const { window } = dom;
  window.LW = {
    escaparHtml: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    gerarCssExportPadrao: () => '',
    MONTAGEM_OPCOES: [
      { modo: 'simples', tipo: 'sp', label: 'S/P', cor: '#e57373' },
      { modo: 'simples', tipo: '2p', label: '2/P', cor: '#64b5f6' },
    ],
    BATERIA_IDS: [],
    PALETES_CONFIG: {},
    PALETES_CONFIG_DEFAULT: {},
  };
  window.eval(CODIGO_FOCADA);
  return window;
}

// Operação com Montagem Personalizada, berço 1 "🔀 Berços Separados"
// (objeto {direita,esquerda} com tipos DIFERENTES — o caso que travava a
// exportação) e um traço/receita, pra confirmar que a execução do
// <script> continua ATÉ O FIM depois de desenhar os berços.
function detalheComBercoDividido() {
  return {
    operacao: {
      id: 77,
      inicio: '2026-01-10T10:00:00.000Z',
      fim: '2026-01-10T11:00:00.000Z',
      tipo_montagem: 'PERSONALIZADA',
      bercos_personalizados: JSON.stringify([{ direita: 'sp', esquerda: '2p' }, 'sp']),
    },
    bercosVisuais: [
      { ordem: 1, estado_direita: null, estado_esquerda: null },
      { ordem: 2, estado_direita: null, estado_esquerda: null },
    ],
    tracos: [
      {
        id_traco: 1,
        num_traco: 1,
        berco_inicio: 1,
        berco_finalizacao: 2,
        original: { cimento: 100, agua: 40 },
        ajustes: [],
        densidade_leituras: [],
        flow_leituras: [],
      },
    ],
    avaliacao: null,
  };
}

test('HTML exportado (Interativo/PDF) NÃO trava mais com berço "🔀 Berços Separados" — berços E receita continuam sendo renderizados', () => {
  const janelaAutora = montarJanelaAutora();
  const html = janelaAutora.LWFocada.gerarHtmlStandalone(detalheComBercoDividido(), []);

  // Executa o HTML gerado numa janela NOVA, do zero — simula abrir o
  // arquivo exportado num navegador (sem LW/data.js disponível).
  const domExportado = new JSDOM(html, { runScripts: 'dangerously' });
  const docExportado = domExportado.window.document;

  const bercosHtml = docExportado.getElementById('af-bercos').innerHTML;
  const receitaHtml = docExportado.getElementById('af-receita').innerHTML;

  // Regressão principal: antes do fix, AMBAS as divs ficavam vazias
  // (o TypeError acontecia dentro de _renderBercos, antes de chegar em
  // _renderReceita).
  assert.notEqual(bercosHtml.trim(), '', 'a seção "Berços" não pode ficar vazia no HTML exportado');
  assert.notEqual(receitaHtml.trim(), '', 'a seção "Receita Utilizada" não pode ficar vazia — prova que o <script> não travou no meio');

  const celulas = docExportado.querySelectorAll('.ba-celula');
  assert.equal(celulas.length, 2);

  // Berço 1 (dividido sp/2p) — gradiente 50/50, nunca o cinza neutro.
  const styleBerco1 = celulas[0].getAttribute('style');
  assert.match(styleBerco1, /linear-gradient\(180deg/, 'berço dividido deve montar gradiente 50/50');
  assert.doesNotMatch(styleBerco1, /rgba\(156,\s?163,\s?175,\s?\.1\)/, 'berço dividido não pode cair no cinza neutro');
});
