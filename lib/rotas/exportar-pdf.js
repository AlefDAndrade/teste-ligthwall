// ─── lib/rotas/exportar-pdf.js — Exportar PDF (a partir do HTML interativo) ─
// Rota: POST /exportar-pdf  { html: string, filename?: string }
//
// A IDEIA: em vez de reimplementar cada dashboard/relatório em outro motor de
// renderização (ex.: capturar a tela com html2canvas — ver
// public/js/setor-qualidade.js/exportDashboardPDF, que já faz isso e sofre
// com blur em telas HiDPI, arquivo pesado e texto não-selecionável), o
// CLIENTE já sabe montar o "Dashboard Interativo" HTML autossuficiente
// (dados + CSS + gráficos SVG embutidos — ver _gerarHtmlAfStandalone/
// _gerarHtmlAfDoDia/_gerarHtmlAfPersonalizado em analise-focada.js, e o
// equivalente em analise-bercos.js/analise-operacional.js/oee.js/
// qualidade-tracos.js). Esta rota só recebe ESSE MESMO HTML pronto e pede pra
// um Chromium headless (via Puppeteer) "imprimir" ele em PDF de verdade —
// texto selecionável, sem perda de nitidez, com paginação real. Zero lógica
// de negócio aqui: é pura conversão HTML → PDF, reaproveitada por QUALQUER
// tela que já gera o HTML interativo (basta apontar pro mesmo endpoint).
//
// Não exige sessão — mesmo critério já usado pelas rotas de leitura em
// lib/rotas/consultas.js ("nenhuma exige sessão/senha": o HTML enviado é
// escolhido pelo próprio navegador que já está logado e carregou os dados
// da tela; esta rota não lê nada do banco, só recebe e converte).
//
// DEPENDÊNCIA DE INFRAESTRUTURA: usa `puppeteer-core` (sem Chromium
// embutido — o pacote completo baixaria ~300MB de storage.googleapis.com no
// npm install, o que trava em ambientes com rede restrita/VM enxuta). Por
// isso o Chromium precisa estar instalado no SISTEMA operacional do
// servidor — ver deploy/instalar-chromium-pdf.sh (mesmo padrão do
// deploy/instalar-https.sh: `sudo bash deploy/instalar-chromium-pdf.sh`).
// Se não encontrar um executável do Chromium, a rota responde 500 com uma
// mensagem explicando o que instalar, em vez de travar o processo inteiro.

const fs = require('fs');

// Reaproveita uma única instância do Chromium entre requisições (abrir o
// processo do zero a cada PDF custaria ~1-2s de overhead toda vez) — só
// abre UMA PÁGINA nova por requisição, e sempre fecha essa página no
// `finally` (ver rota, abaixo). Se o browser cair por qualquer motivo,
// `_obterBrowser()` detecta (`.connected === false`) e relança sozinho, sem
// precisar reiniciar o servidor inteiro.
let _browserPromise = null;

// Caminhos comuns de instalação do Chromium/Chrome em distros Linux — usados
// como fallback quando a variável de ambiente PUPPETEER_EXECUTABLE_PATH não
// está definida. Cobre tanto `apt-get install chromium` (Debian/Ubuntu
// recentes, binário "chromium") quanto `chromium-browser` (Ubuntu mais
// antigo) e Google Chrome, caso a pessoa já tenha um instalado.
const CAMINHOS_CHROMIUM_CANDIDATOS = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/snap/bin/chromium',
];

function _encontrarExecutavelChromium() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  for (const caminho of CAMINHOS_CHROMIUM_CANDIDATOS) {
    try {
      if (fs.existsSync(caminho)) return caminho;
    } catch (_) { /* ignora e tenta o próximo */ }
  }
  return null;
}

module.exports = function criarRotasExportarPdf() {

  // `puppeteer-core` só é exigido na hora de usar (lazy require) — assim,
  // se o pacote não estiver instalado (ex.: alguém rodando um checkout
  // antigo sem `npm install` de novo), o resto do servidor sobe normalmente
  // e só ESTA rota falha com uma mensagem clara, em vez do processo inteiro
  // recusar a subir por um `require` no topo do arquivo.
  function _obterPuppeteer() {
    try {
      return require('puppeteer-core');
    } catch (_) {
      return null;
    }
  }

  async function _obterBrowser(puppeteer, executavel) {
    if (_browserPromise) {
      const browserExistente = await _browserPromise;
      if (browserExistente && browserExistente.connected) return browserExistente;
      _browserPromise = null; // caiu — relança abaixo
    }
    _browserPromise = puppeteer.launch({
      executablePath: executavel,
      headless: true,
      // --no-sandbox: necessário na maioria das VMs Linux rodando como
      // root/sem user namespace configurado (mesmo padrão recomendado pela
      // própria doc do Puppeteer pra ambientes de servidor/CI).
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    return _browserPromise;
  }

  return function tentar(req, res, urlPath) {

    if (req.method !== 'POST' || urlPath !== '/exportar-pdf') return false;

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Corpo inválido (esperado JSON com { html }).' }));
        return;
      }

      const html = typeof payload.html === 'string' ? payload.html : '';
      const nomeArquivo = (typeof payload.filename === 'string' && payload.filename.trim())
        ? payload.filename.trim().replace(/[^a-zA-Z0-9_.-]/g, '_')
        : 'exportacao.pdf';

      if (!html) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Nenhum HTML recebido para converter.' }));
        return;
      }

      const puppeteer = _obterPuppeteer();
      if (!puppeteer) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Exportação em PDF indisponível: dependência "puppeteer-core" não está instalada no servidor (rode "npm install" novamente).' }));
        return;
      }

      const executavel = _encontrarExecutavelChromium();
      if (!executavel) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          erro: 'Exportação em PDF indisponível: nenhum Chromium encontrado no servidor. Rode "sudo bash deploy/instalar-chromium-pdf.sh" na VM (ou defina a variável de ambiente PUPPETEER_EXECUTABLE_PATH apontando pro executável do Chrome/Chromium).',
        }));
        return;
      }

      let page = null;
      try {
        const browser = await _obterBrowser(puppeteer, executavel);
        page = await browser.newPage();

        // 'screen' (não 'print') — o HTML interativo não tem regras
        // especiais de @media print, e o navegador headless por padrão
        // usaria 'print', que em alguns casos oculta cores/backgrounds
        // mesmo com printBackground:true dependendo do CSS. Forçar
        // 'screen' garante que o PDF sai EXATAMENTE com a mesma aparência
        // (cores do tema, cards etc.) que o "Exportar Interativo" mostra
        // ao abrir no navegador.
        await page.emulateMediaType('screen');
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

        // Alguns HTMLs exportados (hoje: Análise Focada "Do Dia"/
        // "Personalizada" em PDF, ver _gerarHtmlAfMultiplasEstaticoPdf/
        // _afScriptAjustePaginaUnica em public/js/analise-focada.js) fazem
        // um ajuste de ESCALA via JS depois de carregar (encolhendo cada
        // operação pra caber inteira numa página só) e sinalizam quando
        // terminam via `window.__afAjustePaginaConcluido = true`. Esperar
        // só por 'networkidle0' acima NÃO garante que esse ajuste já
        // rodou: como esses HTMLs não fazem nenhuma requisição de rede
        // (fotos são data: URI embutidas), "rede ociosa" pode virar
        // verdade antes mesmo do evento `load` disparar. Por isso: se a
        // flag existir no documento (`typeof !== 'undefined'`), espera
        // ela virar `true` antes de imprimir; se não existir (qualquer
        // outro export que não usa esse mecanismo), a condição já é
        // verdadeira de cara e não atrasa nada. Timeout curto e com
        // catch: se por algum motivo travar, prefere imprimir do jeito
        // que estiver a devolver erro 500 pra quem só queria o PDF.
        await page.waitForFunction(
          "typeof window.__afAjustePaginaConcluido === 'undefined' || window.__afAjustePaginaConcluido === true",
          { timeout: 5000 }
        ).catch(() => { /* não é um HTML com esse mecanismo, ou demorou demais — segue o fluxo normal */ });

        const pdfBuffer = await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: { top: '5mm', bottom: '5mm', left: '5mm', right: '5mm' },
        });

        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${nomeArquivo}"`,
          'Content-Length': pdfBuffer.length,
          'Cache-Control': 'no-store',
        });
        res.end(pdfBuffer);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Falha ao gerar o PDF: ' + err.message }));
      } finally {
        if (page) { try { await page.close(); } catch (_) { /* já pode ter caído junto com o browser */ } }
      }
    });

    return true;
  };
};
