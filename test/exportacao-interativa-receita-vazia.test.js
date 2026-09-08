// ─── test/exportacao-interativa-receita-vazia.test.js ────────────────────
// Cobre um bug real relatado pelo usuário: na Análise Focada, ao usar o
// "🌐 Exportar Interativo" (e, por consequência, também o "📕 Exportar
// PDF" — ambos geram o MESMO HTML autossuficiente, ver comentário de
// exportarPDF em analise-focada.js), a seção "🧪 Receita Utilizada" saía
// completamente VAZIA, mesmo com traços/receita presentes nos dados.
//
// Causa: _gerarHtmlAfStandalone embute, dentro do <script> do HTML
// exportado, uma cópia "fake" do objeto global `LW` (já que o arquivo
// exportado é offline e não carrega data.js) com só uma parte das funções
// que o resto do código embutido usa (escaparHtml, corPorTipoSimples,
// formatDateTime, ...). Faltava `formatarRelacaoAC` — chamada por
// _renderReceita (reembutida via toString() logo abaixo) pra calcular a
// Relação A/C de cada traço. Sem ela, `LW.formatarRelacaoAC(...)` lançava
// TypeError DENTRO do .map() de _renderReceita, antes da linha que
// escreve `el.innerHTML = ...` — a exceção não era pega em lugar nenhum
// (a chamada final `_renderReceita(DETALHE.tracos, ...)` não está em
// try/catch), então a div #af-receita nunca era preenchida.
//
// Corrigido duplicando localmente a lógica de calcularRelacaoAC +
// classificarRelacaoAC + formatarRelacaoAC (mesmo padrão já usado por
// _afFormatDateTime pra formatDateTime) numa função _afFormatarRelacaoAC,
// e adicionando ela ao objeto `LW` fake do HTML exportado.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const CODIGO_FOCADA = fs.readFileSync(path.join(__dirname, '..', 'public/js/analise-focada.js'), 'utf8');

// Monta a janela "autora" (onde LWFocada.gerarHtmlStandalone roda) — só
// precisa dos poucos membros de LW usados FORA de _renderReceita nesta
// função específica (LW.MONTAGEM_OPCOES/BATERIA_IDS/PALETES_CONFIG e as
// funções _af* que ela embute via toString()).
function montarJanelaAutora() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
  const { window } = dom;
  window.LW = {
    escaparHtml: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    gerarCssExportPadrao: () => '',
    MONTAGEM_OPCOES: [],
    BATERIA_IDS: [],
    PALETES_CONFIG: {},
    PALETES_CONFIG_DEFAULT: {},
  };
  window.eval(CODIGO_FOCADA);
  return window;
}

// Detalhe mínimo de uma operação COM traço/receita — mesmo shape que
// detalheOperacao() (lib/db/operacoes-qualidade.js) devolve.
function detalheComReceita() {
  return {
    operacao: { id: 42, inicio: '2026-01-10T10:00:00.000Z', fim: '2026-01-10T11:00:00.000Z' },
    bercosVisuais: [],
    tracos: [
      {
        id_traco: 1,
        num_traco: 1,
        berco_inicio: 1,
        berco_finalizacao: 4,
        original: { cimento: 100, agua: 41 },
        ajustes: [],
        densidade_leituras: [],
        flow_leituras: [],
      },
    ],
    avaliacao: null,
  };
}

test('HTML exportado (Interativo/PDF) da Análise Focada NÃO fica com a Receita vazia', () => {
  const janelaAutora = montarJanelaAutora();
  const html = janelaAutora.LWFocada.gerarHtmlStandalone(detalheComReceita(), []);

  // Executa o HTML gerado numa janela NOVA, do zero — simula exatamente
  // abrir o arquivo exportado num navegador (sem LW/data.js disponível,
  // só o que está embutido no próprio arquivo).
  const domExportado = new JSDOM(html, { runScripts: 'dangerously' });
  const docExportado = domExportado.window.document;

  const receitaHtml = docExportado.getElementById('af-receita').innerHTML;
  assert.notEqual(receitaHtml.trim(), '', 'a seção "Receita Utilizada" não pode ficar vazia no HTML exportado');
  assert.match(receitaHtml, /Traço 1/, 'deve mostrar o card do traço');
  assert.match(receitaHtml, /Cimento/, 'deve mostrar o campo Cimento');
  // Relação A/C = 41/100 = 0,41 — é exatamente o cálculo que dependia de
  // LW.formatarRelacaoAC (ausente no objeto LW fake antes da correção).
  assert.match(receitaHtml, /0,41/, 'deve calcular e mostrar a Relação A/C (dependia de LW.formatarRelacaoAC)');
});

test('HTML exportado calcula a Relação A/C considerando ajustes (mesmo bug-fonte de analise-focada-relacao-ac.test.js)', () => {
  const janelaAutora = montarJanelaAutora();
  const detalhe = detalheComReceita();
  // Água ajustada de 41 -> 36 (ajuste de -5) — a Relação A/C exibida deve
  // refletir o ajuste (0,36), não a receita original (0,41).
  detalhe.tracos[0].ajustes = [{ ordem: 1, agua: -5, cimento: 0, tempo_batida: 2 }];
  const html = janelaAutora.LWFocada.gerarHtmlStandalone(detalhe, []);

  const domExportado = new JSDOM(html, { runScripts: 'dangerously' });
  const receitaHtml = domExportado.window.document.getElementById('af-receita').innerHTML;

  assert.notEqual(receitaHtml.trim(), '');
  assert.match(receitaHtml, /0,36/, 'Relação A/C deve refletir o ajuste (100 cimento / 36 água)');
});
