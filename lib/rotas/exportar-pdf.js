// ─── lib/rotas/exportar-pdf.js — Exportar PDF (a partir do HTML interativo) ─
// Rotas:
//   POST /exportar-pdf/iniciar              { html: string, filename?: string } → { ok, jobId }
//   GET  /exportar-pdf/eventos/:jobId       Server-Sent Events — progresso do job
//   GET  /exportar-pdf/arquivo/:jobId       PDF pronto (só depois de "concluido")
//   POST /exportar-pdf/cancelar/:jobId      cancela um job em andamento
//   GET  /exportar-pdf/meu-status           job ativo (processando/concluido) do usuário logado, ou null
//   POST /exportar-pdf/descartar/:jobId     descarta um job concluído/errado/cancelado, libera o usuário pra gerar outro
//
// ── Etapa 8 do plano "PDF sobrevive a fechar a aba" (ver README) ────────
// Admin Master (lib/sessao.js) também passa a conseguir exportar PDF —
// até aqui só sessão de usuário cadastrado (lib/sessao-usuario.js) era
// aceita (ver Etapa 1, logo abaixo), e o Admin Master não é isso: sem
// usuarioId próprio, ficava de fora e nem conseguia começar a gerar um
// PDF (403 direto). `_dadosSessaoParaPdf`, mais abaixo, tenta a sessão
// de usuário cadastrado primeiro e só cai pro Admin Master (com um
// usuarioId sentinela fixo, `ADMIN_MASTER_USUARIO_ID`) se aquela não
// existir — o Admin Master ganha sua própria fila de "um PDF por vez",
// sem se misturar com nenhum usuário cadastrado de verdade.
//
// ── Etapa 7 do plano "PDF sobrevive a fechar a aba" (ver README) ────────
// Reverte parte do que a Etapa 2 (comentário logo abaixo) decidiu:
// `GET /arquivo/:jobId` volta a "resolver" o job sozinho — mas só quando
// o download TERMINA de verdade (ver `_apagarPdfAposDownloadCompleto`,
// chamado a partir de `res.on('finish', ...)`, nunca de `res.on('close',
// ...)`). Motivo: PDF pronto e nunca baixado nem descartado ficava
// acumulando disco/memória até o TTL de 7 dias bater; baixar por
// completo já é sinal suficiente de que a pessoa pegou o arquivo. Uma
// queda de conexão NO MEIO do download não apaga nada — a pessoa ainda
// pode tentar baixar de novo (só uma queda DEPOIS do download completo,
// ex.: perdeu o arquivo salvo localmente, exige gerar tudo de novo).
// `POST /descartar/:jobId` continua existindo pra quem decide não baixar
// (ex.: gerou por engano).
//
// ── Etapa 6 do plano "PDF sobrevive a fechar a aba" (ver README) ────────
// Front-end: badge/popover na topbar (ver public/js/exportar-pdf-status.js
// e public/partials/nav-topbar.html) que checa `GET /meu-status` ao
// carregar a página, reconecta no SSE se o job ainda estiver
// 'processando', e mostra Baixar/Descartar quando 'concluido'. Também
// notificação push (`notificarPdfPronto`, lib/notificacoes-push.js,
// disparada por `_concluirJob` abaixo) pra avisar mesmo com a aba
// fechada — é justamente o cenário que motivou este recurso inteiro.
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
// ── Etapa 1 do plano "PDF sobrevive a fechar a aba" (ver README) ────────
// Até aqui a rota não exigia sessão (mesmo critério de lib/rotas/
// consultas.js: o HTML já vem pronto do navegador que fez login antes de
// carregar a tela; esta rota não lia nada do banco, só convertia). A
// partir desta etapa, `POST /iniciar` passa a exigir uma sessão de
// usuário cadastrado válida (lib/sessao-usuario.js) — não por causa do
// HTML em si (continua sem tocar no banco), mas porque o JOB agora
// precisa ter um DONO (`job.usuarioId`): é o que a Etapa 2, logo abaixo,
// e o aviso "PDF pronto" ao voltar no site vão usar pra saber de quem é
// cada job.
//
// ── Etapa 2 do plano "PDF sobrevive a fechar a aba" (ver README) ────────
// "Só pode gerar outro PDF depois de decidir o que fazer com esse" — três
// mudanças, juntas:
//   (1) `POST /iniciar` agora RECUSA (409) criar um job novo se o usuário
//       já tem um "ativo" (processando OU concluido-aguardando-decisão —
//       ver `db.obterExportacaoPdfAtivaDoUsuario`), devolvendo o job
//       existente pro front já poder mostrar o aviso certo.
//   (2) `GET /meu-status` — o front chama isso ao carregar a página pra
//       saber se tem algo pendente, mesmo depois de fechar/reabrir o
//       site (não dependeria de SSE, que só existe enquanto a aba tá
//       aberta olhando).
//   (3) `POST /descartar/:jobId` — a ÚNICA forma de "resolver" um job
//       concluído sem baixar (ou de limpar um que terminou em erro).
//       IMPORTANTE: a partir desta etapa, `GET /arquivo/:jobId` NÃO
//       apaga mais o job automaticamente ao servir o download — baixar
//       não é a mesma coisa que decidir (a pessoa pode querer baixar de
//       novo, ex.: fechou a caixa de "Salvar como" sem querer). Só
//       `descartar` (ou o TTL de 7 dias, como rede de segurança) libera
//       o usuário pra gerar outro PDF.
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
//
// ── Etapa 3 do plano "PDF sobrevive a fechar a aba" (ver README) ────────
// Até aqui, um job concluído só existia em memória: o Buffer do PDF
// ficava pendurado em `job.pdfBuffer` (ver `_jobs`, abaixo) até alguém
// baixar OU o `JOB_TTL_MS` (10 min) apagar o registro sozinho. Isso tinha
// dois problemas pra exports grandes (dezenas de páginas, minutos pra
// gerar): (1) se o servidor reiniciasse no meio — deploy, crash — o
// trabalho já feito ia pro lixo; (2) se a pessoa fechasse a aba e só
// voltasse mais de 10 min depois, o PDF pronto já tinha sido descartado
// sem ninguém decidir isso.
// Agora, todo job concluído tem uma CÓPIA fora da memória do processo:
// o PDF em si vai pro disco (PDFS_DIR, dentro de private/ — nunca em
// public/, mesmo motivo de security.json, ver lib/security-json.js) e o
// metadado (status/nomeArquivo/caminho) vai pra tabela SQLite
// `exportacoes_pdf` (ver lib/db/exportacoes-pdf.js e o CREATE TABLE em
// db.js). O `Map` em memória (`_jobs`) continua existindo do mesmo jeito
// — é o que alimenta o progresso ao vivo por SSE, que só faz sentido
// enquanto alguém está com a aba aberta olhando — mas deixa de ser a
// ÚNICA fonte de verdade sobre "este PDF existe e está pronto pra
// baixar": `GET /exportar-pdf/arquivo/:jobId` agora também sabe achar o
// arquivo pelo banco+disco quando o job já saiu da memória (TTL vencido,
// ou o processo reiniciou depois que o PDF ficou pronto).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Reaproveita uma única instância do Chromium entre requisições (abrir o
// processo do zero a cada PDF custaria ~1-2s de overhead toda vez) — só
// abre UMA PÁGINA nova por job, e sempre fecha essa página quando o job
// termina (sucesso, erro OU cancelamento — ver `_processarJob`, abaixo).
// Se o browser cair por qualquer motivo, `_obterBrowser()` detecta
// (`.connected === false`) e relança sozinho, sem precisar reiniciar o
// servidor inteiro.
let _browserPromise = null;

// Fechamento automático do Chromium por INATIVIDADE (diagnosticado numa VM
// pequena — ~955MB de RAM total, sem swap configurado: o Chromium ocioso
// sozinho já ocupa ~250-300MB entre os processos principal/renderer/gpu/
// utility, mesmo sem ninguém exportando nada — ver `_verificarBrowserOcioso`,
// abaixo). Atualizado no `finally` de `_processarJob` (todo job que termina,
// não importa como) — representa "a última vez que o browser TERMINOU de
// imprimir algo", não "a última vez que foi aberto", pra não fechar no meio
// de um job longo só porque ele já está aberto há muito tempo.
let _browserUltimoUso = null;
const BROWSER_OCIOSO_TIMEOUT_MS = 5 * 60 * 1000; // 5min sem nenhum job usando o browser
const BROWSER_OCIOSO_CHECK_INTERVAL_MS = 60 * 1000;

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

function _criarJob(usuarioId, usuarioNome) {
  const id = crypto.randomBytes(16).toString('hex');
  const job = {
    id,
    usuarioId, // Etapa 1: dono do job (sessão de usuário cadastrado, ver POST /iniciar)
    // Etapa 6 (ver README/PLANO): guardado à parte de `usuarioId` só pra
    // não precisar de outra consulta ao banco na hora de notificar (ver
    // `_concluirJob`, abaixo, e `notificarPdfPronto`,
    // lib/notificacoes-push.js, que espera o NOME de cadastro, não o id).
    usuarioNome,
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

// `db`/`pdfsDir` (Etapa 3, ver README): opcionais de propósito — quando
// injetados, o job concluído ganha uma cópia em disco/SQLite que
// sobrevive à memória do processo (ver comentário grande no topo do
// arquivo); quando ausentes (ex.: chamada antiga da factory sem esses
// argumentos), o comportamento fica idêntico ao de antes desta etapa.
function _concluirJob(job, pdfBuffer, db, pdfsDir, notificarPdfPronto) {
  if (job.status !== 'processando') return; // ex.: cancelado no meio, o PDF terminou de gerar depois
  job.status = 'concluido';
  job.pdfBuffer = pdfBuffer;
  job.concluidoEm = Date.now();

  // Etapa 6 (ver README/PLANO): avisa quem pediu, mesmo se a aba já foi
  // fechada — é justamente o cenário que este recurso existe pra cobrir.
  // Isolado num try/catch: uma falha aqui (ex: web-push fora do ar) não
  // pode derrubar a conclusão do job, que já está com o PDF pronto de
  // verdade. `notificarPdfPronto` é opcional (injetado pela factory) —
  // ausente, esta etapa simplesmente não dispara nada.
  if (notificarPdfPronto) {
    try { notificarPdfPronto(job.usuarioNome, job.nomeArquivo, job.id); } catch (_) { /* não derruba o job por causa disto */ }
  }

  if (db && pdfsDir) {
    // Escrever em disco + gravar no banco NÃO deve derrubar o job se
    // falhar (ex.: disco cheio) — nesse caso o download ainda funciona
    // pela via de memória de sempre (job.pdfBuffer), só perde a garantia
    // de sobreviver a um restart/TTL; melhor isso do que fazer a pessoa
    // perder um PDF que já terminou de gerar por causa da persistência.
    try {
      const caminhoArquivo = path.join(pdfsDir, job.id + '.pdf');
      fs.writeFileSync(caminhoArquivo, pdfBuffer);
      db.marcarExportacaoPdfConcluida(job.id, {
        caminhoArquivo,
        tamanhoBytes: pdfBuffer.length,
        concluidoEm: job.concluidoEm,
      });
    } catch (_) { /* ver comentário acima — segue com o job concluído mesmo assim */ }
  }

  _emitirEvento(job, 'concluido', {});
  _encerrarClientesSse(job);
}

function _errarJob(job, mensagem, db) {
  if (job.status !== 'processando') return;
  job.status = 'erro';
  job.erro = mensagem;
  job.concluidoEm = Date.now();
  if (db) {
    try { db.marcarExportacaoPdfErro(job.id, mensagem, job.concluidoEm); } catch (_) { /* não derruba o job por causa disto */ }
  }
  _emitirEvento(job, 'erro', { erro: mensagem });
  _encerrarClientesSse(job);
}

async function _cancelarJob(job, db) {
  if (job.status !== 'processando') return; // já terminou de um jeito ou de outro — não há o que cancelar
  job.status = 'cancelado';
  job.concluidoEm = Date.now();
  if (db) {
    try { db.marcarExportacaoPdfCancelada(job.id, job.concluidoEm); } catch (_) { /* não derruba o cancelamento por causa disto */ }
  }
  _emitirEvento(job, 'cancelado', {});
  _encerrarClientesSse(job);
  // Fecha a página no meio do processo — é isto que faz o cancelamento
  // ser de VERDADE (Fase 3), diferente da Fase 2 (que só abortava o fetch
  // do lado do cliente e deixava o Chromium terminando sozinho no
  // servidor). `_processarJob` também checa `job.status` entre as etapas
  // e para de seguir adiante assim que perceber o cancelamento, mas fechar
  // a `page` aqui garante que uma etapa já em andamento (ex.: `page.pdf()`
  // no meio da impressão) também é interrompida, não só a próxima.
  //
  // BUG CORRIGIDO (relatado em produção: "cancelar parece não matar de
  // verdade, continua rodando por trás"): em VM com pouca memória/sem
  // swap, sob pressão de memória o Chromium pode ficar tão lento pra
  // responder que `page.close()` demora MUITO (não trava pra sempre, mas
  // o bastante pra parecer que não fez nada — e o POST /cancelar ficava
  // esperando essa Promise indefinidamente, sem nenhum teto de tempo, já
  // que era só um `await` puro). Agora: se `page.close()` não responder
  // dentro de `TIMEOUT_FECHAR_PAGINA_MS`, desiste de esperar por ela e
  // mata o BROWSER INTEIRO à força (`process().kill()`), garantindo que a
  // renderização realmente para de consumir CPU/memória, mesmo que isso
  // afete outra exportação concorrente que porventura estivesse usando o
  // mesmo browser (raro, e melhor que deixar um Chromium preso comendo
  // recursos indefinidamente numa VM já apertada). `_browserPromise` é
  // zerado nesse caminho pra a próxima exportação relançar um Chromium
  // limpo, sem precisar reiniciar o servidor inteiro.
  if (job.page) {
    const TIMEOUT_FECHAR_PAGINA_MS = 8000;
    let fechouATempo = false;
    try {
      await Promise.race([
        job.page.close().then(() => { fechouATempo = true; }),
        new Promise((resolve) => setTimeout(resolve, TIMEOUT_FECHAR_PAGINA_MS)),
      ]);
    } catch (_) { /* já pode estar fechando/caída sozinha */ }
    if (!fechouATempo) {
      console.warn(
        `[exportar-pdf] Página do job ${job.id} não fechou em ${TIMEOUT_FECHAR_PAGINA_MS}ms ao cancelar ` +
        '(Chromium sobrecarregado?) — matando o browser inteiro à força pra liberar os recursos.'
      );
      if (_browserPromise) {
        const browserPromiseParaMatar = _browserPromise;
        _browserPromise = null; // próxima exportação relança um Chromium limpo
        browserPromiseParaMatar
          .then((browser) => {
            if (browser && browser.process()) browser.process().kill('SIGKILL');
          })
          .catch(() => { /* já pode ter caído sozinho */ });
      }
    }
  }
}

// Etapa 8 do plano "PDF sobrevive a fechar a aba" (ver README): Admin
// Master (lib/sessao.js, cookie `lw_admin_sessao`) também precisa
// conseguir exportar PDF, mas ele NÃO é um "usuário cadastrado"
// (lib/sessao-usuario.js) — não tem usuarioId, nomeUsuario, nada disso,
// só um "válido ou não" (ver comentário no topo de lib/sessao.js). Como
// o job SEMPRE precisa de um dono pra fila de "um PDF por vez" (Etapa
// 1/2), o Admin Master ganha aqui um dono FIXO só pra este recurso —
// funciona como qualquer outro usuarioId (usuario_id na tabela
// exportacoes_pdf é TEXT solto, sem FK — ver db.js), com sua própria
// fila de 1 job por vez, sem se misturar com nenhum usuário cadastrado
// de verdade.
const ADMIN_MASTER_USUARIO_ID = '__admin_master__';
const ADMIN_MASTER_NOME = 'Administrador Master';

// Sessão de usuário cadastrado tem prioridade (é o caso comum); só cai
// pro sentinel de Admin Master se aquela primeira não existir E houver
// uma sessão de Admin Master válida no request.
function _dadosSessaoParaPdf(req, sessaoUsuario, sessao) {
  const dadosUsuario = sessaoUsuario ? sessaoUsuario.dadosDaSessao(req) : null;
  if (dadosUsuario) return dadosUsuario;
  if (sessao && sessao.requestTemSessaoValida(req)) {
    return { usuarioId: ADMIN_MASTER_USUARIO_ID, nomeUsuario: ADMIN_MASTER_NOME };
  }
  return null;
}

// Etapa 7: baixar volta a "resolver" o job — mas só quando o download
// TERMINA de verdade. Chamada a partir do listener `res.on('finish', ...)`
// das duas rotas de GET /arquivo/:jobId (job em memória e fallback via
// disco/banco), nunca de `res.on('close', ...)`: 'finish' só dispara
// depois que TODOS os bytes da resposta já foram entregues ao socket; se
// a conexão cair no meio (rede ruim, aba fechada durante o download),
// 'close' dispara sozinho, sem 'finish', e este helper não é chamado —
// o PDF continua disponível pra tentar baixar de novo, em vez de a
// pessoa ter que gerar tudo de novo por causa de uma queda de conexão.
function _apagarPdfAposDownloadCompleto(jobId, db) {
  if (db) {
    const registro = db.obterExportacaoPdf(jobId);
    if (registro) {
      if (registro.caminho_arquivo) {
        try { fs.unlinkSync(registro.caminho_arquivo); } catch (_) { /* já pode ter sido apagado */ }
      }
      db.apagarExportacaoPdf(jobId);
    }
  }
  const jobEmMemoria = _jobs.get(jobId);
  if (jobEmMemoria) {
    jobEmMemoria.pdfBuffer = null;
    _jobs.delete(jobId);
  }
}

// Só limpa o registro EM MEMÓRIA (`_jobs`) — o metadado no banco e o
// arquivo em disco (se o job terminou com sucesso) NÃO são apagados
// aqui: aquilo é responsabilidade de `_limparExportacoesPdfAntigasDisco`,
// abaixo, com um teto BEM mais generoso (dias, não minutos), porque
// "sumiu da memória" não deveria significar "o PDF pronto que a pessoa
// ainda não decidiu o que fazer desapareceu".
//
// BUG CORRIGIDO: este loop apagava (e fechava a `page` do Puppeteer de)
// QUALQUER job com mais de JOB_TTL_MS (10min), inclusive um que ainda
// estava 'processando' — a referência usada era `job.concluidoEm ||
// job.criadoEm`, e um job em andamento tem `concluidoEm === null`, então
// caía sempre em `criadoEm`. Na prática: um export grande o bastante pra
// levar mais de 10 minutos gerando (o cenário que "PDF sobrevive a
// fechar a aba" existe justamente pra suportar) tinha o Chromium fechado
// à força NO MEIO do trabalho, mesmo com alguém esperando. Agora só
// limpa jobs já TERMINADOS (concluído/erro/cancelado — todos têm
// `concluidoEm` preenchido) que ninguém buscou depois de JOB_TTL_MS; um
// job 'processando' nunca é tocado aqui, não importa a idade — só
// termina por sucesso, erro de verdade ou cancelamento explícito (ver
// `_concluirJob`/`_errarJob`/`_cancelarJob`, acima).
setInterval(() => {
  const agora = Date.now();
  for (const [id, job] of _jobs) {
    if (job.status === 'processando') continue; // nunca mata um job em andamento por timeout
    if (agora - job.concluidoEm <= JOB_TTL_MS) continue;
    _encerrarClientesSse(job);
    _jobs.delete(id);
  }
}, JOB_LIMPEZA_INTERVALO_MS).unref(); // .unref(): não impede o processo de encerrar (ex.: testes, Ctrl+C)

// Fecha o Chromium sozinho depois de `BROWSER_OCIOSO_TIMEOUT_MS` sem
// NENHUM job usando ele — ver comentário em `_browserUltimoUso`, acima,
// sobre o motivo (VM pequena, Chromium ocioso pesa ~250-300MB à toa).
// Reabre automaticamente na próxima exportação (`_obterBrowser` relança
// sozinho quando `_browserPromise` é `null` ou o browser antigo não está
// mais `.connected`) — custo: a PRIMEIRA exportação depois de um período
// ocioso fica ~1-2s mais lenta (tempo de abrir o Chromium do zero), igual
// já acontecia logo após um deploy/restart do servidor.
// NUNCA fecha com um job 'processando' (checagem via `_existeJobProcessando`,
// abaixo) — mesmo que o browser já esteja "ocioso" há mais de
// `BROWSER_OCIOSO_TIMEOUT_MS` (ex.: job muito lento pra atualizar
// `_browserUltimoUso`, que só muda quando um job TERMINA — ver
// `_processarJob`), nunca derruba um Chromium com impressão em andamento.
function _existeJobProcessando() {
  for (const job of _jobs.values()) {
    if (job.status === 'processando') return true;
  }
  return false;
}

setInterval(() => {
  if (!_browserPromise) return; // já fechado, ou nunca foi aberto — nada a fazer
  if (_existeJobProcessando()) return; // tem exportação rodando agora — nunca mexe
  if (!_browserUltimoUso || Date.now() - _browserUltimoUso < BROWSER_OCIOSO_TIMEOUT_MS) return;

  // Solta a referência JÁ, antes mesmo do `.close()` resolver — assim, se
  // uma exportação nova chegar bem nesse instante, `_obterBrowser` já vê
  // `_browserPromise === null` e abre um Chromium novo, em vez de tentar
  // reaproveitar um que está no meio do processo de fechar.
  const browserPromiseParaFechar = _browserPromise;
  _browserPromise = null;
  browserPromiseParaFechar
    .then((browser) => { if (browser && browser.connected) return browser.close(); })
    .catch(() => { /* já pode ter caído sozinho — não há o que fazer */ });
}, BROWSER_OCIOSO_CHECK_INTERVAL_MS).unref();

// Teto de segurança pra registros TERMINADOS (concluído/erro/cancelado)
// que ninguém nunca baixou nem descartou — evita crescimento indefinido
// de disco em caso de uso esquecido. Bem mais generoso que o JOB_TTL_MS
// da memória (dias, não minutos) de propósito: a Etapa 6/7 do plano (ver
// README) é quem vai trazer o fluxo de "baixar ou descartar" de verdade
// pela tela; até lá, isto aqui é só uma rede de segurança, não o
// mecanismo principal de limpeza.
const EXPORTACAO_PDF_TTL_DISCO_MS = 7 * 24 * 60 * 60 * 1000;
const EXPORTACAO_PDF_LIMPEZA_DISCO_INTERVALO_MS = 60 * 60 * 1000;

module.exports = function criarRotasExportarPdf({ db, PRIVATE_DIR, sessaoUsuario, sessao, notificarPdfPronto } = {}) {

  // Onde os PDFs concluídos ficam guardados até serem baixados —
  // dentro de private/ (irmã de public/, nunca servida como estático),
  // mesmo padrão de private/backups-seguranca/ e private/security.json
  // (ver lib/security-json.js). Se `db`/`PRIVATE_DIR` não forem
  // injetados (ex.: algum teste antigo que ainda chama a factory sem
  // argumentos), a persistência em disco/SQLite fica desligada e a rota
  // volta a se comportar como antes (só em memória) — evita quebrar
  // quem ainda não atualizou a chamada.
  const PDFS_DIR = PRIVATE_DIR ? path.join(PRIVATE_DIR, 'pdfs-pendentes') : null;
  if (PDFS_DIR) fs.mkdirSync(PDFS_DIR, { recursive: true });

  // Na subida do processo: qualquer registro que ficou 'processando' no
  // banco pertence a um Puppeteer que morreu junto com o processo
  // ANTERIOR — nenhum job sobrevive a um restart (só o metadado dele).
  // Sem isto, esses registros ficariam presos em 'processando' pra
  // sempre, e a Etapa 2 (um job ativo por usuário, ver README) nunca
  // mais deixaria a pessoa gerar outro PDF.
  if (db && db.corrigirExportacoesPdfOrfasNaSubida) {
    db.corrigirExportacoesPdfOrfasNaSubida();
  }

  // Limpeza periódica dos registros terminados e não reclamados há mais
  // de EXPORTACAO_PDF_TTL_DISCO_MS — apaga o arquivo em disco antes de
  // apagar a linha do banco (ordem importa: se cair no meio, sobra no
  // pior caso um arquivo órfão em disco, nunca uma linha no banco
  // apontando pra um arquivo que não existe mais).
  if (db && PDFS_DIR) {
    setInterval(() => {
      const expiradas = db.listarExportacoesPdfExpiradas(EXPORTACAO_PDF_TTL_DISCO_MS);
      for (const registro of expiradas) {
        if (registro.caminho_arquivo) {
          try { fs.unlinkSync(registro.caminho_arquivo); } catch (_) { /* já pode ter sido apagado */ }
        }
        db.apagarExportacaoPdf(registro.job_id);
      }
    }, EXPORTACAO_PDF_LIMPEZA_DISCO_INTERVALO_MS).unref();
  }

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
  // `_mesclarBlocosPdf`, logo abaixo.
  function _obterPdfLib() {
    try {
      return require('pdf-lib');
    } catch (_) {
      return null;
    }
  }

  // Mescla N PDFs "de bloco" (gerados via `pageRanges` — ver
  // `_processarJob`, mais abaixo) num único Buffer final, na MESMA ordem
  // em que os buffers foram passados. Cada `bufferBloco` já é um PDF
  // válido e completo por si só (não um fragmento) — `PDFDocument.load` +
  // `copyPages` simplesmente reaproveita TODAS as páginas de cada um deles
  // (1 ou mais, dependendo do tamanho do bloco impresso) dentro de um
  // documento novo, sem re-renderizar nada. Generalização de
  // `_mesclarPdfsDePaginaUnica` (nome antigo): buffers de 1 página cada
  // continuam funcionando aqui do mesmo jeito, já que "bloco de 1" é só um
  // caso particular — ver `_tamanhoBlocoImpressao`, logo abaixo.
  async function _mesclarBlocosPdf(buffersBlocos) {
    const pdfLib = _obterPdfLib();
    if (!pdfLib) {
      throw new Error(
        'pdf-lib não está instalado. Rode "npm install" no diretório do projeto.'
      );
    }
    const { PDFDocument } = pdfLib;
    const pdfFinal = await PDFDocument.create();
    for (const bufferBloco of buffersBlocos) {
      const pdfOrigem = await PDFDocument.load(bufferBloco);
      const paginas = await pdfFinal.copyPages(pdfOrigem, pdfOrigem.getPageIndices());
      for (const pagina of paginas) pdfFinal.addPage(pagina);
    }
    return Buffer.from(await pdfFinal.save());
  }

  // Quantas páginas imprimir por chamada de `page.pdf({ pageRanges })` de
  // cada vez, em vez de 1 por 1. MOTIVO: cada chamada a `page.pdf()` paga
  // um overhead FIXO de IPC com o Chromium (protocolo CDP), independente
  // do tamanho do range impresso — imprimir "1-10" de uma vez paga esse
  // overhead 1x; imprimir 1 a 1 paga 10x pro mesmo tanto de páginas.
  // Medido em produção: a fase de impressão (`page.pdf()`) é o gargalo
  // real do export de página única (Análise Focada Do Dia/Personalizada),
  // não o merge (`_mesclarBlocosPdf`, acima) — daí valer a pena batizar
  // aqui.
  // TROCA ENVOLVIDA: bloco maior = menos overhead repetido, mas progresso
  // mais "em degraus" (a barra só anda a cada bloco concluído, não a cada
  // página) e cancelamento menos responsivo (`job.status` só é checado
  // ENTRE blocos — ver `_processarJob` — então cancelar no meio de um
  // bloco de 10 espera essas ~10 páginas terminarem de imprimir antes de
  // parar de verdade). ADAPTATIVO por isso: jobs pequenos usam bloco
  // pequeno (perda de responsividade não compensa, já são rápidos por
  // natureza); jobs grandes usam bloco maior (o overhead acumulado de
  // imprimir 1 a 1 pesa mais, e uns segundos a mais de cancelamento não
  // fazem tanta diferença numa exportação que já leva minutos).
  function _tamanhoBlocoImpressao(totalPaginas) {
    if (totalPaginas <= 10) return 1;  // poucas páginas: mantém granularidade máxima
    if (totalPaginas <= 30) return 5;
    return 10;
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
  async function _processarJob(job, html, puppeteer, executavel, notificarPdfPronto) {
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
        const buffersBlocos = [];
        const tamanhoBloco = _tamanhoBlocoImpressao(totalPaginasConhecido);
        // Base do ETA desta fase: diferente do caminho de fallback (que usa
        // uma média móvel entre JOBS passados, possivelmente bem diferentes
        // em complexidade), aqui a estimativa vem do tempo médio por página
        // JÁ OBSERVADO dentro deste MESMO job — reflete a complexidade real
        // do que está sendo impresso agora, não uma média genérica antiga.
        // Continua em base "por página" (não "por bloco") mesmo com a
        // impressão em blocos, abaixo — assim o ETA não fica granulado
        // demais nem some quando o bloco é grande.
        const inicioImpressao = Date.now();
        for (let inicioBloco = 1; inicioBloco <= totalPaginasConhecido; inicioBloco += tamanhoBloco) {
          // Cancelado entre um bloco e outro — não precisa esperar os
          // blocos restantes serem impressos à toa (diferente da versão
          // atômica de antes, que só conseguia checar isto DEPOIS da
          // impressão inteira terminar). Igual à versão página-a-página de
          // antes, só que agora a checagem é ENTRE BLOCOS, não entre
          // páginas — ver `_tamanhoBlocoImpressao`, acima, sobre essa troca.
          if (job.status !== 'processando') return;
          const fimBloco = Math.min(inicioBloco + tamanhoBloco - 1, totalPaginasConhecido);
          // `pageRanges: 'A-B'`, 1-indexado (igual ao Ctrl+P de qualquer
          // navegador) — imprime as páginas de A até B NUMA SÓ chamada a
          // `page.pdf()`, reaproveitando a paginação que o Chromium já
          // calculou uma vez em `page` (mesma `page`, sem recarregar HTML
          // nem re-rodar o ajuste de escala). Quando `tamanhoBloco` é 1,
          // `fimBloco === inicioBloco` e o range vira só "A" — mesmo
          // comportamento de antes, sem regressão pra jobs pequenos.
          const rangeBloco = inicioBloco === fimBloco ? String(inicioBloco) : `${inicioBloco}-${fimBloco}`;
          const bufferBloco = await page.pdf({ ...opcoesImpressao, pageRanges: rangeBloco });
          buffersBlocos.push(bufferBloco);
          if (job.status !== 'processando') return; // cancelado logo após imprimir este bloco — não mescla nem reporta mais nada
          const paginasRestantes = totalPaginasConhecido - fimBloco;
          const msPorPaginaObservado = (Date.now() - inicioImpressao) / fimBloco;
          const segundosRestantes = paginasRestantes > 0
            ? Math.round((msPorPaginaObservado * paginasRestantes) / 1000)
            : 0;
          _atualizarProgresso(job, 'imprimindo', fimBloco, totalPaginasConhecido, segundosRestantes, true);
        }
        pdfBuffer = await _mesclarBlocosPdf(buffersBlocos);
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

      _concluirJob(job, pdfBuffer, db, PDFS_DIR, notificarPdfPronto);
    } catch (err) {
      // Cancelamento fecha a `page`, o que faz as chamadas do Puppeteer em
      // andamento rejeitarem com erro — não é uma FALHA de verdade, então
      // não sobrescreve o status 'cancelado' com 'erro'.
      if (job.status === 'processando') _errarJob(job, 'Falha ao gerar o PDF: ' + err.message, db);
    } finally {
      if (page) { try { await page.close(); } catch (_) { /* já pode ter caído junto com o browser */ } }
      job.page = null;
      // Marca "acabou de usar o browser agora" — é a partir DAQUI que a
      // contagem de inatividade (`BROWSER_OCIOSO_TIMEOUT_MS`, acima) começa
      // a valer, não da hora que o browser foi aberto.
      _browserUltimoUso = Date.now();
    }
  }

  return function tentar(req, res, urlPath) {

    // POST /exportar-pdf/iniciar — cria o job e devolve o jobId NA HORA,
    // sem esperar o PDF terminar (isso é o que muda de síncrono pra
    // assíncrono nesta fase). O trabalho de verdade roda em
    // `_processarJob`, chamada sem `await` de propósito.
    if (req.method === 'POST' && urlPath === '/exportar-pdf/iniciar') {
      // Etapa 1: precisa saber QUEM está pedindo, pra o job ter dono
      // (ver comentário no topo do arquivo). Checado antes de ler o
      // corpo do request — não faz sentido nem começar a parsear um
      // PDF potencialmente grande sem sessão válida.
      const dadosSessao = _dadosSessaoParaPdf(req, sessaoUsuario, sessao);
      if (!dadosSessao) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Sessão de usuário necessária ou expirada. Faça login de novo.' }));
        return true;
      }

      // Etapa 2(1): "só pode gerar outro depois de decidir o que fazer
      // com esse" — checado ANTES de ler o corpo do request, pelo mesmo
      // motivo da checagem de sessão acima: não faz sentido nem começar
      // a parsear um HTML potencialmente grande se a resposta já vai ser
      // uma recusa. Devolve o `jobId` existente pro front já poder abrir
      // o aviso certo ("baixe ou descarte antes") em vez de só um erro
      // genérico.
      if (db) {
        const ativo = db.obterExportacaoPdfAtivaDoUsuario(dadosSessao.usuarioId);
        if (ativo) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            erro: ativo.status === 'processando'
              ? 'Você já tem um PDF sendo gerado. Espere terminar (ou cancele) antes de gerar outro.'
              : 'Você já tem um PDF pronto esperando decisão. Baixe ou descarte antes de gerar outro.',
            jobId: ativo.job_id,
            status: ativo.status,
          }));
          return true;
        }
      }

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

        const job = _criarJob(dadosSessao.usuarioId, dadosSessao.nomeUsuario);
        job.nomeArquivo = nomeArquivo;
        if (db) {
          db.criarRegistroExportacaoPdf({ jobId: job.id, usuarioId: dadosSessao.usuarioId, nomeArquivo, criadoEm: job.criadoEm });
        }
        _processarJob(job, html, puppeteer, executavel, notificarPdfPronto); // sem await — roda em segundo plano

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
    // 'concluido'. Etapa 3 (ver README): antes só existia o caminho pela
    // memória (`_jobs`) — se o job já tinha saído dali (TTL de 10 min
    // vencido, ou o processo reiniciou depois do PDF ficar pronto), o
    // download parava de funcionar mesmo com o arquivo ainda existindo.
    // Agora, quando o job não está mais em memória, cai no caminho de
    // FALLBACK: consulta o banco (`exportacoes_pdf`) e serve direto do
    // disco (PDFS_DIR) se o registro ainda existir lá.
    //
    // Etapa 7 (ver comentário no topo do arquivo): esta rota volta a
    // apagar o job/arquivo automaticamente — mas só depois que o
    // download termina de VERDADE (`res.on('finish', ...)`, mais abaixo
    // em cada um dos dois caminhos). `POST /descartar/:jobId`, logo
    // abaixo, continua existindo pra quem decide não baixar; o TTL de 7
    // dias em disco segue como rede de segurança pra quem nunca decide
    // nada.
    if (req.method === 'GET' && urlPath.startsWith('/exportar-pdf/arquivo/')) {
      const jobId = urlPath.slice('/exportar-pdf/arquivo/'.length);
      if (!_idJobValido(jobId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Job de exportação não encontrado (pode já ter expirado).' }));
        return true;
      }

      const job = _jobs.get(jobId);

      // Caminho normal: job ainda vivo em memória com o Buffer pronto —
      // mesmo comportamento de sempre, sem tocar em disco/banco.
      if (job) {
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
        // 'finish': só depois que a resposta INTEIRA foi entregue ao
        // socket — ver comentário grande em _apagarPdfAposDownloadCompleto.
        res.on('finish', () => { _apagarPdfAposDownloadCompleto(jobId, db); });
        res.end(job.pdfBuffer);
        return true;
      }

      // Caminho de fallback: não está mais em memória — só existe se
      // tiver sido persistido (Etapa 3). Sem `db`/`PDFS_DIR` injetados
      // (factory antiga), não há pra onde cair: 404 direto, mesmo
      // comportamento de antes desta etapa.
      const registro = db ? db.obterExportacaoPdf(jobId) : null;
      if (!registro) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Job de exportação não encontrado (pode já ter expirado).' }));
        return true;
      }
      if (registro.status !== 'concluido' || !registro.caminho_arquivo) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Este job ainda não tem um PDF pronto para baixar.' }));
        return true;
      }

      let pdfBuffer;
      try {
        pdfBuffer = fs.readFileSync(registro.caminho_arquivo);
      } catch (_) {
        // Arquivo sumiu do disco por fora (ex.: limpeza manual) mas o
        // registro do banco ainda existia — trata como "não encontrado"
        // em vez de estourar um 500 sem explicação.
        db.apagarExportacaoPdf(jobId);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Job de exportação não encontrado (pode já ter expirado).' }));
        return true;
      }

      const nomeArquivo = registro.nome_arquivo || 'exportacao.pdf';
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${nomeArquivo}"`,
        'Content-Length': pdfBuffer.length,
        'Cache-Control': 'no-store',
      });
      // 'finish': só depois que a resposta INTEIRA foi entregue ao
      // socket — ver comentário grande em _apagarPdfAposDownloadCompleto.
      res.on('finish', () => { _apagarPdfAposDownloadCompleto(jobId, db); });
      res.end(pdfBuffer);
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
      _cancelarJob(_jobs.get(jobId), db).finally(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return true;
    }

    // GET /exportar-pdf/meu-status — Etapa 2(2): o front chama isso ao
    // carregar a página pra saber se o usuário logado tem um job ativo
    // (processando ou concluido-aguardando-decisão), mesmo depois de
    // fechar/reabrir o site — diferente do SSE (`eventos/:jobId`), que só
    // existe enquanto uma aba está com a conexão aberta olhando.
    // Devolve `{ ok:true, job:null }` se não houver nada pendente.
    if (req.method === 'GET' && urlPath === '/exportar-pdf/meu-status') {
      const dadosSessao = _dadosSessaoParaPdf(req, sessaoUsuario, sessao);
      if (!dadosSessao) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Sessão de usuário necessária ou expirada. Faça login de novo.' }));
        return true;
      }
      if (!db) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, job: null }));
        return true;
      }

      const ativo = db.obterExportacaoPdfAtivaDoUsuario(dadosSessao.usuarioId);
      if (!ativo) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, job: null }));
        return true;
      }

      // Se o banco diz 'processando', o job necessariamente ainda está
      // vivo em `_jobs` NESTE processo — qualquer 'processando' órfão de
      // um processo anterior já foi convertido pra 'erro' na subida (ver
      // `corrigirExportacoesPdfOrfasNaSubida`, chamada acima). Isso deixa
      // usar o job em memória pra devolver progresso AO VIVO
      // (fase/feito/total), não só o status estático do banco.
      const jobEmMemoria = ativo.status === 'processando' ? _jobs.get(ativo.job_id) : null;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        job: {
          jobId: ativo.job_id,
          status: ativo.status,
          nomeArquivo: ativo.nome_arquivo,
          criadoEm: ativo.criado_em,
          fase: jobEmMemoria ? jobEmMemoria.fase : null,
          feito: jobEmMemoria ? jobEmMemoria.feito : null,
          total: jobEmMemoria ? jobEmMemoria.total : null,
          segundosRestantes: jobEmMemoria ? jobEmMemoria.segundosRestantes : null,
        },
      }));
      return true;
    }

    // POST /exportar-pdf/descartar/:jobId — Etapa 2(3): a ÚNICA forma de
    // "resolver" um job concluído sem baixar (ou de limpar um que
    // terminou em erro/foi cancelado). Desde esta etapa, baixar não
    // conta mais como decisão (ver GET /arquivo/:jobId, acima) — só
    // descartar (ou o TTL de 7 dias, como rede de segurança) libera o
    // usuário pra iniciar outro job.
    if (req.method === 'POST' && urlPath.startsWith('/exportar-pdf/descartar/')) {
      const jobId = urlPath.slice('/exportar-pdf/descartar/'.length);
      if (!_idJobValido(jobId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Job de exportação não encontrado.' }));
        return true;
      }

      const dadosSessao = _dadosSessaoParaPdf(req, sessaoUsuario, sessao);
      if (!dadosSessao) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Sessão de usuário necessária ou expirada. Faça login de novo.' }));
        return true;
      }
      if (!db) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Persistência de exportações indisponível neste servidor.' }));
        return true;
      }

      const registro = db.obterExportacaoPdf(jobId);
      if (!registro) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Job de exportação não encontrado (pode já ter expirado).' }));
        return true;
      }
      // Dono errado: nunca deixa uma pessoa descartar o job de outra —
      // mesmo raciocínio de qualquer rota que opera em dado de um
      // usuário específico (ver lib/rotas/usuarios.js).
      if (registro.usuario_id !== dadosSessao.usuarioId) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Este job de exportação pertence a outro usuário.' }));
        return true;
      }
      // Não faz sentido "descartar" algo que ainda está rodando — pra
      // isso já existe POST /cancelar/:jobId, que interrompe de verdade
      // o Chromium no meio (ver _cancelarJob). Descartar é só pra estado
      // TERMINAL (concluido/erro/cancelado).
      if (registro.status === 'processando') {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Este job ainda está sendo gerado — cancele em vez de descartar.' }));
        return true;
      }

      if (registro.caminho_arquivo) {
        try { fs.unlinkSync(registro.caminho_arquivo); } catch (_) { /* já pode ter sido apagado */ }
      }
      db.apagarExportacaoPdf(jobId);

      // Limpa também o resquício em memória, se ainda existir (job
      // recém-terminado, dentro da janela do JOB_TTL_MS de 10min).
      const jobEmMemoria = _jobs.get(jobId);
      if (jobEmMemoria) {
        jobEmMemoria.pdfBuffer = null;
        _jobs.delete(jobId);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    return false;
  };
};
