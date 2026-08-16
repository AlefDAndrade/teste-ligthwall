// ─── test/analise-focada-pdf-pagina-unica.test.js ───────────────────────────
// Cobre o pedido: "na exportação em PDF Do Dia/Personalizada da Análise
// Focada, cada operação deve caber INTEIRA em 1 página, mesmo que o
// conteúdo seja grande" (ver _afCssImpressaoPdf/_afScriptAjustePaginaUnica/
// _gerarHtmlAfMultiplasEstaticoPdf em public/js/analise-focada.js, e o
// `page.waitForFunction` correspondente em lib/rotas/exportar-pdf.js).
//
// Não dá pra testar isso de ponta a ponta (abrir o PDF de verdade e medir
// páginas) sem um Chromium real via Puppeteer — este ambiente de teste não
// tem um instalado (ver comentário de _encontrarExecutavelChromium em
// lib/rotas/exportar-pdf.js: precisa ser instalado no SISTEMA operacional,
// não é uma dependência npm baixável). Em vez disso, testamos as DUAS
// peças que, juntas, garantem o resultado:
//   1) A MATEMÁTICA do ajuste de escala (ajustarParaCaberNumaPagina, dentro
//      do script gerado por _afScriptAjustePaginaUnica) — simulando um DOM
//      com métricas de layout controladas (jsdom não calcula layout de
//      verdade, então fingimos clientHeight/scrollHeight/offsetTop via
//      Object.defineProperty, um padrão comum em testes com jsdom).
//   2) A ESTRUTURA do HTML final (_gerarHtmlAfMultiplasEstaticoPdf) — cada
//      operação dentro de .af-op-pagina > .af-op-conteudo-escala, a altura
//      de página em CSS batendo com a margem que o Puppeteer usa no
//      servidor, e o sinalizador de conclusão presente.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const CODIGO_FOCADA = fs.readFileSync(path.join(__dirname, '..', 'public/js/analise-focada.js'), 'utf8');
const CODIGO_EXPORTAR_PDF = fs.readFileSync(path.join(__dirname, '..', 'lib/rotas/exportar-pdf.js'), 'utf8');

function montarJanela() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
  const { window } = dom;
  window.LW = {
    escaparHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    gerarCssExportPadrao: () => '', // stub — não testamos a paleta de tema aqui
  };
  window.eval(CODIGO_FOCADA);
  return window;
}

function secoesFalsas(rotulo) {
  return {
    cabecalho: `<div>cabecalho-${rotulo}</div>`,
    bercos: `<div>bercos-${rotulo}</div>`,
    receita: `<div>receita-${rotulo}</div>`,
    paradas: `<div>paradas-${rotulo}</div>`,
    paradasContagem: '0',
    avaliacao: `<div>avaliacao-${rotulo}</div>`,
    fotosPaletes: '',
  };
}

// ── 1) Matemática do ajuste de escala ───────────────────────────────────

test('ajuste de escala encolhe o conteúdo que não cabe, proporcional ao espaço realmente disponível — convergindo em múltiplas passadas se precisar', () => {
  const window = montarJanela();
  const doc = window.document;

  doc.body.innerHTML = `
    <div class="af-op-pagina">
      <div class="af-op-titulo">Operação 1 de 2</div>
      <div class="af-op-conteudo-escala">conteúdo grande</div>
    </div>`;
  const pagina = doc.querySelector('.af-op-pagina');
  const conteudo = doc.querySelector('.af-op-conteudo-escala');

  // Página "cabe" 600px de altura útil; o título consome 20px antes do
  // conteúdo começar (offsetTop) — logo, sobra 580px pro conteúdo (menos
  // o FATOR_SEGURANCA de 3%, ver abaixo).
  Object.defineProperty(pagina, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(conteudo, 'offsetTop', { value: 20, configurable: true });

  // scrollHeight simula TRÊS leituras diferentes — pedido que motivou
  // trocar as antigas "2 passadas fixas" por um LOOP convergente (ver
  // MAX_PASSADAS/comentário grande em _afScriptAjustePaginaUnica):
  // "cortando mais ainda" numa operação com bastante conteúdo, onde 2
  // passadas não eram suficientes pra o grid (.af-paineis-grid, auto-fit)
  // terminar de se reorganizar. Aqui: 1ª leitura no tamanho normal
  // (900px, bem maior que o disponível), 2ª depois da 1ª correção (850px
  // — grid ainda reorganizando, ainda maior que o disponível, precisa de
  // MAIS uma correção — isto é o que a versão de 2 passadas fixas NÃO
  // cobria), 3ª depois da 2ª correção (500px — layout finalmente
  // estabilizou e já cabe, loop converge e para).
  let leituras = 0;
  const alturasSimuladas = [900, 850, 500];
  Object.defineProperty(conteudo, 'scrollHeight', {
    configurable: true,
    get() { const v = alturasSimuladas[Math.min(leituras, alturasSimuladas.length - 1)]; leituras += 1; return v; },
  });

  // Mesma ordem do documento real: flag inicial (no <head>) primeiro,
  // script de ajuste (fim do <body>) depois.
  window.eval(window.LWFocada.scriptFlagInicial().replace(/^<script>/, '').replace(/<\/script>$/, ''));
  const scriptHtml = window.LWFocada.scriptAjustePaginaUnica();
  const corpoScript = scriptHtml.replace(/^<script>/, '').replace(/<\/script>$/, '');
  window.eval(corpoScript);

  assert.equal(window.__afAjustePaginaConcluido, false, 'antes do load, a flag deve estar false (servidor ainda não pode imprimir)');

  window.dispatchEvent(new window.Event('load'));

  assert.equal(window.__afAjustePaginaConcluido, true, 'depois do load, a flag deve virar true (libera o Puppeteer pra imprimir)');
  assert.equal(leituras, 3, 'deveria medir a altura 3 vezes (2 correções + 1 leitura final confirmando que já cabe)');

  // Escala final = disponível/altura da ÚLTIMA passada que ainda
  // precisou de correção (850, a 2ª leitura) — recalculada do zero, NÃO
  // é o produto acumulado das correções anteriores. Isto é o próprio bug
  // que motivou esta reescrita: uma versão intermediária deste loop
  // multiplicava a escala nova em cima da escala já aplicada
  // (escalaAtual = escalaAtual * fatorCorretivo), o que compõe o
  // encolhimento exponencialmente a cada passada — sintoma visto na
  // prática: conteúdo minúsculo e página quase toda vazia embaixo. O
  // "disponível" já sai com o FATOR_SEGURANCA de 3% aplicado
  // (580 * 0.97 = 562.6).
  const disponivelComFolga = 580 * 0.97;
  const escalaEsperada = disponivelComFolga / 850;
  const match = conteudo.style.transform.match(/scale\(([\d.]+)\)/);
  assert.ok(match, `esperava um transform:scale(...), veio "${conteudo.style.transform}"`);
  assert.ok(Math.abs(parseFloat(match[1]) - escalaEsperada) < 0.0005, `escala aplicada (${match[1]}) deveria ser ~${escalaEsperada.toFixed(5)}`);

  // width também precisa ter sido alargado na mesma proporção inversa da
  // escala final, senão o conteúdo fica com uma faixa vazia à direita.
  const larguraEsperada = 100 / escalaEsperada;
  const matchLargura = conteudo.style.width.match(/([\d.]+)%/);
  assert.ok(matchLargura, `esperava uma largura em %, veio "${conteudo.style.width}"`);
  assert.ok(Math.abs(parseFloat(matchLargura[1]) - larguraEsperada) < 0.05, `largura aplicada (${matchLargura[1]}%) deveria ser ~${larguraEsperada.toFixed(2)}%`);
});

test('ajuste de escala tem um teto de passadas — nunca trava o Puppeteer mesmo se o layout nunca convergir', () => {
  const window = montarJanela();
  const doc = window.document;

  doc.body.innerHTML = `
    <div class="af-op-pagina">
      <div class="af-op-titulo">Operação 1 de 1</div>
      <div class="af-op-conteudo-escala">conteúdo teimoso</div>
    </div>`;
  const pagina = doc.querySelector('.af-op-pagina');
  const conteudo = doc.querySelector('.af-op-conteudo-escala');

  Object.defineProperty(pagina, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(conteudo, 'offsetTop', { value: 20, configurable: true });

  // scrollHeight SEMPRE retorna um valor bem maior que o disponível,
  // simulando um layout patológico que nunca estabiliza (ex.: algum
  // conteúdo com altura mínima fixa que o scale não consegue reduzir o
  // bastante) — sem um teto de passadas, isto faria o loop de
  // ajustarParaCaberNumaPagina rodar pra sempre, travando o handler de
  // 'load' e, por consequência, o __afAjustePaginaConcluido nunca viraria
  // true (o Puppeteer ficaria preso esperando até o timeout do servidor).
  let leituras = 0;
  Object.defineProperty(conteudo, 'scrollHeight', {
    configurable: true,
    get() { leituras += 1; return 5000; },
  });

  window.eval(window.LWFocada.scriptFlagInicial().replace(/^<script>/, '').replace(/<\/script>$/, ''));
  const scriptHtml = window.LWFocada.scriptAjustePaginaUnica();
  const corpoScript = scriptHtml.replace(/^<script>/, '').replace(/<\/script>$/, '');
  window.eval(corpoScript);
  window.dispatchEvent(new window.Event('load'));

  // O importante: mesmo sem NUNCA convergir, o handler de 'load' precisa
  // terminar (não travar) e liberar a flag pro Puppeteer imprimir com o
  // melhor esforço que conseguiu, em vez de ficar preso.
  assert.equal(window.__afAjustePaginaConcluido, true, 'a flag precisa virar true mesmo se o layout nunca convergir — nunca pode travar o Puppeteer');
  assert.ok(leituras <= 6, `deveria ter parado depois de no máximo 6 passadas, mas fez ${leituras} leituras`);
  assert.match(conteudo.style.transform, /scale\(/, 'ainda assim deveria ter aplicado ALGUMA escala (melhor esforço), em vez de deixar o conteúdo em tamanho normal e sujeito a corte seco');
});

test('ajuste de escala NÃO mexe em nada quando o conteúdo já cabe na página', () => {
  const window = montarJanela();
  const doc = window.document;

  doc.body.innerHTML = `
    <div class="af-op-pagina">
      <div class="af-op-titulo">Operação 1 de 1</div>
      <div class="af-op-conteudo-escala">conteúdo pequeno</div>
    </div>`;
  const pagina = doc.querySelector('.af-op-pagina');
  const conteudo = doc.querySelector('.af-op-conteudo-escala');

  Object.defineProperty(pagina, 'clientHeight', { value: 600, configurable: true });
  Object.defineProperty(conteudo, 'offsetTop', { value: 20, configurable: true });
  Object.defineProperty(conteudo, 'scrollHeight', { value: 300, configurable: true }); // cabe fácil nos 580 disponíveis

  window.eval(window.LWFocada.scriptFlagInicial().replace(/^<script>/, '').replace(/<\/script>$/, ''));
  const scriptHtml = window.LWFocada.scriptAjustePaginaUnica();
  const corpoScript = scriptHtml.replace(/^<script>/, '').replace(/<\/script>$/, '');
  window.eval(corpoScript);
  window.dispatchEvent(new window.Event('load'));

  assert.equal(window.__afAjustePaginaConcluido, true);
  assert.equal(conteudo.style.transform, 'none', 'não deveria aplicar nenhum scale quando já cabe');
  assert.equal(conteudo.style.width, '100%', 'largura deveria continuar 100% quando já cabe');
});

// ── 2) Estrutura do HTML gerado (múltiplas operações) ───────────────────

test('PDF "Do Dia"/"Personalizada": cada operação vira um .af-op-pagina com .af-op-conteudo-escala próprio', () => {
  const window = montarJanela();
  const itens = [
    { id: 1, label: 'Operação A', secoes: secoesFalsas('A') },
    { id: 2, label: 'Operação B', secoes: secoesFalsas('B') },
    { id: 3, label: 'Operação C', secoes: secoesFalsas('C') },
  ];

  const html = window.LWFocada.gerarHtmlMultiplasPdf('Título da Página', 'Título H1', 'sub-label', itens);

  const qtdPaginas = (html.match(/class="af-op-pagina"/g) || []).length;
  assert.equal(qtdPaginas, 3, 'deveria criar um .af-op-pagina por operação');

  const qtdConteudos = (html.match(/class="af-op-conteudo-escala"/g) || []).length;
  assert.equal(qtdConteudos, 3, 'cada .af-op-pagina precisa do wrapper .af-op-conteudo-escala (é o que o script escala)');

  // A ordem importa: cada .af-op-conteudo-escala precisa estar DENTRO do
  // .af-op-pagina correspondente (não soltos fora da estrutura).
  const blocos = html.split('class="af-op-pagina"').slice(1);
  assert.equal(blocos.length, 3);
  blocos.forEach((bloco, i) => {
    assert.match(bloco.slice(0, 400), /af-op-conteudo-escala/, `bloco ${i + 1} deveria conter o wrapper de escala logo no início`);
  });

  // O sinalizador de conclusão precisa existir nos dois pontos: iniciado
  // como false cedo no <head> (pro Puppeteer não achar que já terminou
  // por padrão) e marcado como true dentro do handler de 'load'.
  assert.match(html, /window\.__afAjustePaginaConcluido = false;/);
  assert.match(html, /window\.__afAjustePaginaConcluido = true;/);

  // A flag "false" tem que vir ANTES do script de ajuste no documento —
  // senão o script de ajuste rodaria e o flag inicial reapareceria por
  // cima, deixando a flag presa em `false` pra sempre.
  const posFlagFalse = html.indexOf('window.__afAjustePaginaConcluido = false;');
  const posFlagTrue = html.indexOf('window.__afAjustePaginaConcluido = true;');
  assert.ok(posFlagFalse >= 0 && posFlagTrue > posFlagFalse, 'a flag "false" precisa vir antes da "true" no documento');
});

test('altura de página em CSS (287mm) bate com as margens que o Puppeteer usa no servidor (A4 = 297mm - 5mm - 5mm)', () => {
  const window = montarJanela();
  const html = window.LWFocada.gerarHtmlMultiplasPdf('t', 'h1', 'sub', [{ id: 1, label: 'x', secoes: secoesFalsas('x') }]);

  assert.match(html, /\.af-op-pagina\s*\{[^}]*height:287mm/, 'a altura de .af-op-pagina no CSS deveria ser 287mm');

  // Confirma que 287mm realmente corresponde às margens configuradas em
  // lib/rotas/exportar-pdf.js — se algum dia alguém mudar as margens lá
  // sem lembrar de atualizar aqui, este teste quebra e avisa.
  const margemTop = CODIGO_EXPORTAR_PDF.match(/top:\s*'(\d+)mm'/);
  const margemBottom = CODIGO_EXPORTAR_PDF.match(/bottom:\s*'(\d+)mm'/);
  assert.ok(margemTop && margemBottom, 'não encontrei as margens configuradas em exportar-pdf.js');
  const alturaUtilEsperada = 297 - Number(margemTop[1]) - Number(margemBottom[1]);
  assert.equal(alturaUtilEsperada, 287, 'a conta 297 - margens deveria bater com os 287mm usados em .af-op-pagina');
});

test('lib/rotas/exportar-pdf.js espera window.__afAjustePaginaConcluido antes de chamar page.pdf()', () => {
  // Regressão estrutural: garante que ninguém remova o waitForFunction que
  // evita imprimir o PDF antes do JS de ajuste de escala terminar (ver
  // comentário no topo deste arquivo de teste).
  assert.match(CODIGO_EXPORTAR_PDF, /waitForFunction/);
  assert.match(CODIGO_EXPORTAR_PDF, /__afAjustePaginaConcluido/);
  // A chamada de waitForFunction precisa vir ANTES de page.pdf(), senão
  // não adianta nada.
  const posWait = CODIGO_EXPORTAR_PDF.indexOf('waitForFunction');
  const posPdf = CODIGO_EXPORTAR_PDF.indexOf('page.pdf(');
  assert.ok(posWait > 0 && posPdf > posWait, 'waitForFunction precisa vir antes de page.pdf()');
});
