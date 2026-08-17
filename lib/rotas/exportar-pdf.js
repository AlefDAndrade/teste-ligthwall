// ─── lib/rotas/exportar-pdf.js — Exportar PDF (a partir do HTML interativo) ─
// Rotas:
//   POST /exportar-pdf/iniciar              { html: string, filename?: string } → { ok, jobId }
//   GET  /exportar-pdf/eventos/:jobId       Server-Sent Events — progresso do job
//   GET  /exportar-pdf/arquivo/:jobId       PDF pronto (só depois de "concluido")
//   POST /exportar-pdf/cancelar/:jobId      cancela um job em andamento
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
//
// ── Fase 3 do plano de "Exportação em PDF — Contagem, Progresso e
// Cancelamento" (ver README) ─────────────────────────────────────────────
// Antes desta fase, a rota era um único POST síncrono: o cliente esperava
// (às vezes minutos, num range grande) e só no fim recebia o PDF pronto OU
// um erro — sem noção de quanto faltava, e um "cancelar" do lado do
// cliente só abortava o FETCH (o Chromium no servidor continuava rodando
// sozinho, sem ninguém esperando). Agora a rota é STATEFUL: `iniciar`
// devolve um `jobId` na hora (sem esperar nada), o cliente acompanha o
// progresso REAL por Server-Sent Events (`eventos/:jobId`) — inclusive
// progresso DENTRO do próprio ajuste de escala do PDF (ver
// `__afReportarProgresso`, abaixo, e `_afScriptAjustePaginaUnica` em
// analise-focada.js) — baixa o arquivo só quando pronto
// (`arquivo/:jobId`), e pode cancelar de VERDADE a qualquer momento
// (`cancelar/:jobId`, que fecha a `page` do Puppeteer no meio do processo,
// não só o acompanhamento do lado do cliente).
//
// Isso também é o que permite tirar os timeouts fixos que existiam antes
// (`page.setContent(..., { timeout: 30000 })`, `waitForFunction(...,
// { timeout: 15000 })`) — eles só existiam pra evitar uma trava SEM
// feedback nenhum; com progresso real + cancelamento de verdade, "trava
// sem feedback" vira "acompanha o progresso, e cancela se quiser".

const fs = require('fs');
const crypto = require('crypto');

// Reaproveita uma única instância do Chromium entre requisições (abrir o
// processo do zero a cada PDF custaria ~1-2s de overhead toda vez) — só
// abre UMA PÁGINA nova por job, e sempre fecha essa página quando o job
// termina (sucesso, erro OU cancelamento — ver `_processarJob`, abaixo).
// Se o browser cair por qualquer motivo, `_obterBrowser()` detecta
// (`.connected === false`) e relança sozinho, sem precisar reiniciar o
// servidor inteiro.
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

// ─── Jobs em memória ────────────────────────────────────────────────────
// Cada exportação em andamento (ou já concluída, aguardando ser baixada)
// vira uma entrada aqui. Só em memória — mesmo critério já usado pelo rate
// limiting de `lib/auth.js`: reinicia o servidor, perde os jobs em
// andamento, mas um job só faz sentido enquanto a aba que pediu ele está
// aberta esperando, então não precisa (nem convém) persistir em disco.
//
// Formato de cada job:
//   { id, status: 'processando'|'concluido'|'erro'|'cancelado',
//     fase, feito, total, totalPaginasAjuste, segundosRestantes,
//     nomeArquivo, pdfBuffer, erro, page, criadoEm, concluidoEm,
//     clientesSse: Set<ServerResponse> }
const _jobs = new Map();

// Limpeza de jobs órfãos — cobre 2 cenários que, sem isso, vazariam
// memória (e páginas do Chromium) pra sempre: (1) o cliente iniciou um job
// e nunca mais voltou (fechou a aba antes de terminar de acompanhar) e (2)
// o job terminou (concluído/erro/cancelado) mas ninguém baixou o arquivo
// depois. 10 minutos é bem mais que suficiente pro maior export real (a
// rota inteira normalmente termina em segundos/poucos minutos) sem deixar
// PDFs prontos (que ocupam memória — o Buffer inteiro fica em `pdfBuffer`)
// acumulando indefinidamente.
const JOB_TTL_MS = 10 * 60 * 1000;
const JOB_LIMPEZA_INTERVALO_MS = 60 * 1000;

function _criarJob() {
  const id = crypto.randomBytes(16).toString('hex');
  const job = {
    id,
    status: 'processando',
    fase: 'preparando',
    feito: 0,
    total: 0,
    // Total de páginas relatado pelo ajuste de escala do cliente (ver
    // `window.__afReportarProgresso`/`page.exposeFunction`, mais abaixo)
    // — CAMPO SEPARADO de `total` (acima) de propósito: `total` é
    // reescrito por CADA fase pra fins de progresso genérico (inclusive
    // por fases que rodam DEPOIS do ajuste de escala reportar o valor
    // real), então reaproveitá-lo aqui perderia o total de páginas assim
    // que outra fase atualizasse `total` por cima. `null` = mecanismo de
    // página única não se aplica a este export (cai no caminho de
    // fallback de impressão).
    totalPaginasAjuste: null,
    segundosRestantes: null,
    nomeArquivo: null,
    pdfBuffer: null,
    erro: null,
    page: null,
    criadoEm: Date.now(),
    concluidoEm: null,
    clientesSse: new Set(),
  };
  _jobs.set(id, job);
  return job;
}

function _idJobValido(id) {
  return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
}

function _emitirEvento(job, tipo, dados) {
  const linha = `event: ${tipo}\ndata: ${JSON.stringify(dados || {})}\n\n`;
  for (const res of job.clientesSse) {
    try { res.write(linha); } catch (_) { /* cliente já desconectou — segue pros outros */ }
  }
}

function _encerrarClientesSse(job) {
  for (const res of job.clientesSse) {
    try { res.end(); } catch (_) { /* já pode ter caído sozinho */ }
  }
  job.clientesSse.clear();
}

// `progressoReal` (Fase 5, ver README): quando `true`, `feito`/`total`
// são uma CONTAGEM real de páginas já impressas (fase 'imprimindo' via
// `pageRanges`, ver `_processarJob`) — quando `false`/omitido (padrão),
// mantém o significado de sempre: contagem real nas fases
// 'carregando'/'ajustando', ou uma PORCENTAGEM estimada (0-95) na fase
// 'imprimindo' do caminho de fallback (dashboards sem o mecanismo de
// página única — ver `_iniciarTickerImpressao`). Sem esse flag explícito,
// o cliente não teria como distinguir com segurança os dois formatos
// (ambos mandam `feito`/`total` numéricos) — ver `_progressoServidor` em
// analise-focada.js.
function _atualizarProgresso(job, fase, feito, total, segundosRestantes, progressoReal) {
  if (job.status !== 'processando') return; // já cancelado/concluído/errado — ignora atualização tardia
  job.fase = fase;
  job.feito = feito;
  job.total = total;
  job.segundosRestantes = typeof segundosRestantes === 'number' ? segundosRestantes : null;
  _emitirEvento(job, 'progresso', {
    fase, feito, total,
    segundosRestantes: job.segundosRestantes,
    progressoReal: !!progressoReal,
  });
}

// ─── Estimativa de tempo pra impressão (page.pdf()) ──────────────────────
// Puppeteer não expõe NENHUM progresso durante `page.pdf()` — é uma
// chamada atômica que só resolve quando o PDF inteiro já está pronto
// (diferente do ajuste de escala, que já reporta progresso real via
// `__afReportarProgresso` — ver `_processarJob`, abaixo). Como esta é
// tipicamente a etapa mais demorada de um export grande (é aqui que o
// Chromium efetivamente PAGINA e renderiza tudo, não só mede/redimensiona
// como no ajuste de escala), deixar sem NENHUM feedback é justamente o
// pedido que motivou este ajuste — sem granularidade real disponível, a
// alternativa é ESTIMAR com base no histórico: quanto tempo, em média,
// cada operação levou pra imprimir nos últimos jobs, e projetar isso pro
// job atual conforme o tempo passa (ver `_tickerImpressao`, abaixo).
//
// Média móvel EXPONENCIAL (não uma média simples de todo o histórico) —
// reage mais rápido se o servidor ficar mais lento/rápido de uma hora pra
// outra (ex.: outro processo pesado concorrendo por CPU, troca de
// máquina), em vez de ficar "arrastando" uma média antiga por muito tempo.
let _msPorOperacaoImpressao = 1500; // chute inicial — corrigido pelo primeiro job real que terminar
const PESO_MEDIA_MOVEL_IMPRESSAO = 0.3; // quanto o job mais recente pesa em cima da média atual

function _registrarDuracaoImpressao(duracaoMs, totalOperacoes) {
  const base = Math.max(totalOperacoes, 1); // evita dividir por zero (export sem o mecanismo de ajuste de escala)
  const msPorOperacao = duracaoMs / base;
  _msPorOperacaoImpressao = _msPorOperacaoImpressao * (1 - PESO_MEDIA_MOVEL_IMPRESSAO)
    + msPorOperacao * PESO_MEDIA_MOVEL_IMPRESSAO;
}

// Chamado logo ANTES de `page.pdf()` — devolve uma função `pararTicker()`
// que precisa ser chamada assim que `page.pdf()` resolver (sucesso, erro
// OU cancelamento), pra não deixar um `setInterval` rodando pra sempre.
// A cada 500ms, projeta uma porcentagem (0-95 — nunca 100: só o evento
// 'concluido' de verdade fecha em 100%, pra não fingir que terminou antes
// da hora) e um "tempo restante estimado" a partir da média móvel acima.
function _iniciarTickerImpressao(job, totalOperacoes) {
  const totalParaEstimativa = Math.max(totalOperacoes, 1);
  const estimativaMs = _msPorOperacaoImpressao * totalParaEstimativa;
  const inicio = Date.now();
  const intervalo = setInterval(() => {
    const decorridoMs = Date.now() - inicio;
    const percentual = estimativaMs > 0 ? Math.min(95, Math.round((decorridoMs / estimativaMs) * 100)) : 0;
    const restanteMs = Math.max(estimativaMs - decorridoMs, 0);
    _atualizarProgresso(job, 'imprimindo', percentual, 100, Math.round(restanteMs / 1000));
  }, 500);
  return { pararTicker: () => clearInterval(intervalo), inicio };
}

function _concluirJob(job, pdfBuffer) {
  if (job.status !== 'processando') return; // ex.: cancelado no meio, o PDF terminou de gerar depois
  job.status = 'concluido';
  job.pdfBuffer = pdfBuffer;
  job.concluidoEm = Date.now();
  _emitirEvento(job, 'concluido', {});
  _encerrarClientesSse(job);
}

function _errarJob(job, mensagem) {
  if (job.status !== 'processando') return;
  job.status = 'erro';
  job.erro = mensagem;
  job.concluidoEm = Date.now();
  _emitirEvento(job, 'erro', { erro: mensagem });
  _encerrarClientesSse(job);
}

async function _cancelarJob(job) {
  if (job.status !== 'processando') return; // já terminou de um jeito ou de outro — não há o que cancelar
  job.status = 'cancelado';
  job.concluidoEm = Date.now();
  _emitirEvento(job, 'cancelado', {});
  _encerrarClientesSse(job);
  // Fecha a página no meio do processo — é isto que faz o cancelamento
  // ser de VERDADE (Fase 3), diferente da Fase 2 (que só abortava o fetch
  // do lado do cliente e deixava o Chromium terminando sozinho no
  // servidor). `_processarJob` também checa `job.status` entre as etapas
  // e para de seguir adiante assim que perceber o cancelamento, mas fechar
  // a `page` aqui garante que uma etapa já em andamento (ex.: `page.pdf()`
  // no meio da impressão) também é interrompida, não só a próxima.
  if (job.page) {
    try { await job.page.close(); } catch (_) { /* já pode estar fechando/caída sozinha */ }
  }
}

setInterval(() => {
  const agora = Date.now();
  for (const [id, job] of _jobs) {
    const referencia = job.concluidoEm || job.criadoEm;
    if (agora - referencia <= JOB_TTL_MS) continue;
    if (job.page) { try { job.page.close(); } catch (_) { /* ignora */ } }
    _encerrarClientesSse(job);
    _jobs.delete(id);
  }
}, JOB_LIMPEZA_INTERVALO_MS).unref(); // .unref(): não impede o processo de encerrar (ex.: testes, Ctrl+C)

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

  // `pdf-lib` — mesmo padrão de lazy require do puppeteer-core, acima —
  // só é exigido quando a Fase 5 (progresso real na impressão, ver README)
  // realmente precisa mesclar páginas impressas separadamente. Usado por
  // `_mesclarPdfsDePaginaUnica`, logo abaixo.
  function _obterPdfLib() {
    try {
      return require('pdf-lib');
    } catch (_) {
      return null;
    }
  }

  // Mescla N PDFs de 1 página cada (gerados um por vez, via `pageRanges` —
  // ver `_processarJob`, mais abaixo) num único Buffer final, na MESMA
  // ordem em que os buffers foram passados. Cada `bufferPagina` já é um
  // PDF válido e completo por si só (não um fragmento) — `PDFDocument.load`
  // + `copyPages` simplesmente reaproveita a página 1 de cada um deles
  // dentro de um documento novo, sem re-renderizar nada.
  async function _mesclarPdfsDePaginaUnica(buffersPaginas) {
    const pdfLib = _obterPdfLib();
    if (!pdfLib) {
      throw new Error(
        'pdf-lib não está instalado. Rode "npm install" no diretório do projeto.'
      );
    }
    const { PDFDocument } = pdfLib;
    const pdfFinal = await PDFDocument.create();
    for (const bufferPagina of buffersPaginas) {
      const pdfOrigem = await PDFDocument.load(bufferPagina);
      const [pagina] = await pdfFinal.copyPages(pdfOrigem, [0]);
      pdfFinal.addPage(pagina);
    }
    return Buffer.from(await pdfFinal.save());
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

  // Faz todo o trabalho de verdade (equivalente ao corpo da rota síncrona
  // de antes da Fase 3), mas reportando progresso pro `job` em vez de
  // escrever direto numa `res` — quem lê esse progresso é
  // `GET /exportar-pdf/eventos/:jobId`, não esta função. Roda "solta"
  // (chamada sem `await` por quem inicia o job — ver rota `/iniciar`,
  // abaixo): a resposta HTTP do POST já foi devolvida com o `jobId` antes
  // mesmo desta função terminar.
  async function _processarJob(job, html, puppeteer, executavel) {
    let page = null;
    try {
      const browser = await _obterBrowser(puppeteer, executavel);
      if (job.status !== 'processando') return; // cancelado enquanto o browser subia
      page = await browser.newPage();
      job.page = page;

      // Desliga o timeout PADRÃO do Puppeteer (30000ms, aplicado
      // automaticamente a `setContent`/`waitForFunction`/etc. quando
      // nenhum `timeout` explícito é passado) — sem isto, remover o
      // `{ timeout: 30000 }`/`{ timeout: 15000 }` explícitos de cada
      // chamada (ver comentários abaixo) NÃO tinha efeito nenhum na
      // prática: o Puppeteer aplicava o próprio padrão por baixo dos
      // panos e estourava do mesmo jeito ("Timed out after waiting
      // 30000ms"). Mesmo raciocínio de antes continua valendo — com
      // progresso real + Cancelar de verdade, não faz sentido nenhum
      // timeout artificial aqui, nem o explícito nem o padrão.
      page.setDefaultTimeout(0);

      // Ponte Chromium → Node: o script injetado no HTML (ver
      // `_afScriptAjustePaginaUnica`, analise-focada.js) chama
      // `window.__afReportarProgresso(feito, total)` a cada operação que
      // termina de ajustar de escala — isto vira progresso REAL na barra
      // do cliente (fase 'ajustando'), não só um "enviando…" indeterminado
      // como na Fase 2. Só existe em HTMLs que usam esse mecanismo (Do
      // Dia/Personalizada em PDF); os demais nunca chamam esta função.
      // BUG CORRIGIDO: `job.total` é reaproveitado por TODAS
      // as fases pra reportar progresso genérico (`_atualizarProgresso`) —
      // inclusive a atualização de "carregando concluído" logo depois de
      // `page.setContent()`, mais abaixo. Só que o `load` da página (e,
      // com ele, TODAS as chamadas de `__afReportarProgresso`, que também
      // escrevem em `job.total`) já acontece DURANTE `page.setContent()`,
      // antes dela resolver. Ou seja: a atualização de "carregando
      // concluído" rodava DEPOIS das chamadas de progresso do ajuste de
      // escala e sobrescrevia `job.total` de volta pra `1` — o total de
      // páginas real (ex.: 5) era descartado antes mesmo do loop de
      // impressão (mais abaixo) ler `job.total` pra saber quantas páginas
      // imprimir, fazendo o PDF final sair com 1 página só, mesmo com
      // várias operações. Correção: o total de páginas relatado pelo
      // ajuste de escala vive em CAMPO PRÓPRIO (`job.totalPaginasAjuste`),
      // que nenhuma outra fase mexe — só assim ele sobrevive até o loop
      // de impressão, não importa a ordem em que as fases anteriores
      // reportam progresso.
      await page.exposeFunction('__afReportarProgresso', (feito, total) => {
        job.totalPaginasAjuste = total;
        _atualizarProgresso(job, 'ajustando', feito, total);
      });

      // 'screen' (não 'print') — o HTML interativo não tem regras
      // especiais de @media print, e o navegador headless por padrão
      // usaria 'print', que em alguns casos oculta cores/backgrounds
      // mesmo com printBackground:true dependendo do CSS. Forçar
      // 'screen' garante que o PDF sai EXATAMENTE com a mesma aparência
      // (cores do tema, cards etc.) que o "Exportar Interativo" mostra
      // ao abrir no navegador.
      await page.emulateMediaType('screen');

      _atualizarProgresso(job, 'carregando', 0, 1);
      // timeout: 0 EXPLÍCITO (antes: 30000ms implícito — ver nota abaixo)
      // — como agora dá pra cancelar de verdade a qualquer momento
      // (`_cancelarJob` fecha esta `page`, o que rejeita a Promise de
      // `setContent` sozinha), um timeout artificial só serviria pra
      // interromper exports legítimos porém grandes/lentos sem que o
      // usuário tenha pedido — "trava sem feedback" (o problema que o
      // timeout evitava) já não existe mais, porque agora há progresso
      // visível E um botão Cancelar que funciona de verdade.
      // IMPORTANTE: precisa ser `{ timeout: 0 }` EXPLÍCITO — o Puppeteer
      // aplica um timeout PADRÃO de 30000ms a esta chamada sempre que
      // nenhum `timeout` é passado; só tirar o `{ timeout: 30000 }` da
      // chamada (como a Fase 3 fez originalmente) não desliga nada, volta
      // pro padrão e estoura do mesmo jeito ("Timed out after waiting
      // 30000ms" — foi exatamente isto que apareceu em produção).
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 0 });
      if (job.status !== 'processando') return;
      _atualizarProgresso(job, 'carregando', 1, 1);

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
      // verdadeira de cara e não atrasa nada.
      // TIMEOUT DE 60000ms MANTIDO DE PROPÓSITO (diferente do `setContent`,
      // acima, que desliga o timeout) — esta espera é uma REDE DE
      // SEGURANÇA, não um passo que deveria legitimamente demorar muito: o
      // script injetado (`_afScriptAjustePaginaUnica`) roda 100% síncrono
      // dentro do handler de `load`, então a flag normalmente vira `true`
      // em bem menos de 1s mesmo em exports grandes. Se ela nunca chegar
      // (ex.: página fechada por cancelamento, ou algum caso extremo em
      // que o sinal se perde), o `.catch()` abaixo deixa o fluxo seguir e
      // o check de `job.status` logo depois decide o que fazer —
      // sem este limite, um caso desses trava o job PARA SEMPRE (visto em
      // produção: barra travada em "Ajustando o layout do PDF (44 de
      // 44)…" depois que um `page.setDefaultTimeout(0)` global chegou a
      // ser testado aqui e foi revertido por causa disto).
      await page.waitForFunction(
        "typeof window.__afAjustePaginaConcluido === 'undefined' || window.__afAjustePaginaConcluido === true",
        { timeout: 60000 }
      ).catch(() => { /* a página pode ter sido fechada por um cancelamento, ou o sinal nunca chegou — segue e deixa o check de status abaixo decidir */ });
      if (job.status !== 'processando') return;

      // Captura ANTES de `_atualizarProgresso('imprimindo', ...)` sobrescrever
      // `job.total` — é o total de PÁGINAS que o ajuste de escala reportou
      // (`window.__afReportarProgresso`, ver `_afScriptAjustePaginaUnica`,
      // analise-focada.js) — só existe em HTMLs "Simples"/"Do Dia"/
      // "Personalizada" da Análise Focada, que garantem via CSS
      // (`.af-op-pagina { height:287mm; overflow:hidden }` +
      // `break-before:page`) que CADA operação vira EXATAMENTE 1 página
      // física do PDF, nem mais nem menos — é essa garantia que permite
      // saber de antemão quantas páginas o Chromium vai produzir, SEM
      // precisar imprimir nada ainda.
      //
      // Fase 5 (ver README, "Progresso REAL na fase imprimindo"): quando
      // esse total é conhecido (> 0), a impressão vira N chamadas — uma
      // por página, via `pageRanges` — em vez de 1 chamada atômica, dando
      // progresso REAL (página impressa/total), não mais estimado. Quando
      // NÃO é conhecido (outros dashboards — OEE, Setor de Qualidade,
      // Análise de Berços, etc. — que não usam o mecanismo de página
      // única e podem gerar qualquer número de páginas via quebra natural
      // de conteúdo), mantém o caminho de HOJE: 1 chamada atômica +
      // estimativa por média móvel entre jobs (`_msPorOperacaoImpressao`)
      // — não dá pra fatiar por `pageRanges` sem saber o total real de
      // páginas de antemão, sob risco de CORTAR conteúdo.
      // `job.totalPaginasAjuste` (não `job.total`, ver comentário em
      // `page.exposeFunction('__afReportarProgresso', ...)`, acima) —
      // continua `null` pra qualquer export que não usa o mecanismo de
      // página única (cai no caminho de fallback abaixo).
      const totalPaginasConhecido = job.totalPaginasAjuste > 0 ? job.totalPaginasAjuste : null;
      const opcoesImpressao = {
        format: 'A4',
        printBackground: true,
        margin: { top: '5mm', bottom: '5mm', left: '5mm', right: '5mm' },
      };

      let pdfBuffer;
      if (totalPaginasConhecido) {
        _atualizarProgresso(job, 'imprimindo', 0, totalPaginasConhecido, null, true);
        const buffersPaginas = [];
        // Base do ETA desta fase: diferente do caminho de fallback (que usa
        // uma média móvel entre JOBS passados, possivelmente bem diferentes
        // em complexidade), aqui a estimativa vem do tempo médio por página
        // JÁ OBSERVADO dentro deste MESMO job — reflete a complexidade real
        // do que está sendo impresso agora, não uma média genérica antiga.
        const inicioImpressao = Date.now();
        for (let n = 1; n <= totalPaginasConhecido; n++) {
          // Cancelado entre uma página e outra — não precisa esperar as
          // páginas restantes serem impressas à toa (diferente da versão
          // atômica de antes, que só conseguia checar isto DEPOIS da
          // impressão inteira terminar).
          if (job.status !== 'processando') return;
          // `pageRanges: '1'`-based (1-indexado, igual ao Ctrl+P de
          // qualquer navegador) — imprime SÓ a página N, reaproveitando a
          // paginação que o Chromium já calculou uma vez em `page`
          // (mesma `page`, sem recarregar HTML nem re-rodar o ajuste de
          // escala).
          const bufferPagina = await page.pdf({ ...opcoesImpressao, pageRanges: String(n) });
          buffersPaginas.push(bufferPagina);
          if (job.status !== 'processando') return; // cancelado logo após imprimir esta página — não mescla nem reporta mais nada
          const paginasRestantes = totalPaginasConhecido - n;
          const msPorPaginaObservado = (Date.now() - inicioImpressao) / n;
          const segundosRestantes = paginasRestantes > 0
            ? Math.round((msPorPaginaObservado * paginasRestantes) / 1000)
            : 0;
          _atualizarProgresso(job, 'imprimindo', n, totalPaginasConhecido, segundosRestantes, true);
        }
        pdfBuffer = await _mesclarPdfsDePaginaUnica(buffersPaginas);
      } else {
        const totalOperacoesParaEstimativa = 1; // sem mecanismo de página única — sempre tratado como 1 "operação" pra estimativa
        _atualizarProgresso(job, 'imprimindo', 0, 100, Math.round((_msPorOperacaoImpressao * totalOperacoesParaEstimativa) / 1000));
        const { pararTicker, inicio: inicioImpressao } = _iniciarTickerImpressao(job, totalOperacoesParaEstimativa);
        try {
          pdfBuffer = await page.pdf(opcoesImpressao);
        } finally {
          pararTicker();
        }
        if (job.status !== 'processando') return; // cancelado bem no fim — descarta o resultado

        // Só registra a duração pra média móvel em cima de um job que
        // TERMINOU DE VERDADE (chegou até aqui) — um job cancelado no meio
        // não tem uma duração real de impressão pra medir.
        _registrarDuracaoImpressao(Date.now() - inicioImpressao, totalOperacoesParaEstimativa);
      }
      if (job.status !== 'processando') return; // cancelado bem no fim (ex.: durante o merge) — descarta o resultado

      _concluirJob(job, pdfBuffer);
    } catch (err) {
      // Cancelamento fecha a `page`, o que faz as chamadas do Puppeteer em
      // andamento rejeitarem com erro — não é uma FALHA de verdade, então
      // não sobrescreve o status 'cancelado' com 'erro'.
      if (job.status === 'processando') _errarJob(job, 'Falha ao gerar o PDF: ' + err.message);
    } finally {
      if (page) { try { await page.close(); } catch (_) { /* já pode ter caído junto com o browser */ } }
      job.page = null;
    }
  }

  return function tentar(req, res, urlPath) {

    // POST /exportar-pdf/iniciar — cria o job e devolve o jobId NA HORA,
    // sem esperar o PDF terminar (isso é o que muda de síncrono pra
    // assíncrono nesta fase). O trabalho de verdade roda em
    // `_processarJob`, chamada sem `await` de propósito.
    if (req.method === 'POST' && urlPath === '/exportar-pdf/iniciar') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
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

        const job = _criarJob();
        job.nomeArquivo = nomeArquivo;
        _processarJob(job, html, puppeteer, executavel); // sem await — roda em segundo plano

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, jobId: job.id }));
      });
      return true;
    }

    // GET /exportar-pdf/eventos/:jobId — Server-Sent Events. Manda um
    // evento 'progresso' a cada atualização e termina a conexão sozinho
    // com um evento terminal ('concluido'/'erro'/'cancelado').
    if (req.method === 'GET' && urlPath.startsWith('/exportar-pdf/eventos/')) {
      const jobId = urlPath.slice('/exportar-pdf/eventos/'.length);
      if (!_idJobValido(jobId) || !_jobs.has(jobId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Job de exportação não encontrado (pode já ter expirado).' }));
        return true;
      }
      const job = _jobs.get(jobId);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // evita que um proxy (ex.: nginx) segure os eventos em buffer
      });

      if (job.status !== 'processando') {
        // O job já terminou antes de este cliente conectar (ex.: conexão
        // SSE reaberta depois de uma queda de rede) — manda o evento
        // terminal na hora, em vez de deixar a conexão pendurada esperando
        // um evento que já aconteceu e nunca vai se repetir.
        const tipo = job.status === 'concluido' ? 'concluido' : job.status;
        res.write(`event: ${tipo}\ndata: ${JSON.stringify(job.status === 'erro' ? { erro: job.erro } : {})}\n\n`);
        res.end();
        return true;
      }

      // Estado atual na hora de conectar — sem isso, um cliente que
      // conecta no meio de uma fase só veria a PRÓXIMA atualização,
      // deixando a barra parada em 0% até ela chegar.
      res.write(`event: progresso\ndata: ${JSON.stringify({ fase: job.fase, feito: job.feito, total: job.total, segundosRestantes: job.segundosRestantes })}\n\n`);

      job.clientesSse.add(res);
      req.on('close', () => { job.clientesSse.delete(res); });
      return true;
    }

    // GET /exportar-pdf/arquivo/:jobId — só serve o PDF depois do job
    // 'concluido'. Some com o Buffer da memória depois de servido (não faz
    // sentido guardar o PDF gerado além do próprio download).
    if (req.method === 'GET' && urlPath.startsWith('/exportar-pdf/arquivo/')) {
      const jobId = urlPath.slice('/exportar-pdf/arquivo/'.length);
      if (!_idJobValido(jobId) || !_jobs.has(jobId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Job de exportação não encontrado (pode já ter expirado).' }));
        return true;
      }
      const job = _jobs.get(jobId);
      if (job.status !== 'concluido' || !job.pdfBuffer) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Este job ainda não tem um PDF pronto para baixar.' }));
        return true;
      }

      const nomeArquivo = (typeof job.nomeArquivo === 'string' && job.nomeArquivo) || 'exportacao.pdf';
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${nomeArquivo}"`,
        'Content-Length': job.pdfBuffer.length,
        'Cache-Control': 'no-store',
      });
      res.end(job.pdfBuffer);

      job.pdfBuffer = null; // já foi entregue — libera a memória
      _jobs.delete(jobId);
      return true;
    }

    // POST /exportar-pdf/cancelar/:jobId — cancelamento de VERDADE (Fase
    // 3): fecha a `page` do Puppeteer no meio do processo, não só o
    // acompanhamento do lado do cliente (diferença-chave em relação à
    // Fase 2, onde só o fetch era abortado).
    if (req.method === 'POST' && urlPath.startsWith('/exportar-pdf/cancelar/')) {
      const jobId = urlPath.slice('/exportar-pdf/cancelar/'.length);
      if (!_idJobValido(jobId) || !_jobs.has(jobId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Job de exportação não encontrado (pode já ter expirado).' }));
        return true;
      }
      _cancelarJob(_jobs.get(jobId)).finally(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return true;
    }

    return false;
  };
};
