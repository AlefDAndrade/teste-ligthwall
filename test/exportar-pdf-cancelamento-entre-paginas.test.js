// ─── test/exportar-pdf-cancelamento-entre-paginas.test.js ───────────────────
// README, "Exportação em PDF (Análise Focada) — Contagem, Progresso e
// Cancelamento", passo 5.6: "Cancelamento entre páginas — como agora são N
// chamadas sequenciais (não 1 atômica), `_cancelarJob` fecha a `page` entre
// uma impressão e outra, então cancelar fica ainda mais responsivo".
//
// Não dá pra testar isso de ponta a ponta (cancelar no MEIO de um export
// grande de verdade) sem um Chromium real via Puppeteer — este ambiente não
// tem um instalado (mesma limitação documentada em
// test/analise-focada-pdf-pagina-unica.test.js). Em vez disso, confirmamos
// ESTRUTURALMENTE (inspeção do código-fonte) as duas peças que, juntas,
// garantem o comportamento:
//   1) O loop de impressão em blocos (`pageRanges`) checa `job.status` tanto
//      ANTES de cada `page.pdf()` (não começa um bloco novo se já foi
//      cancelado) quanto DEPOIS (não mescla/reporta progresso de um bloco
//      impresso depois do cancelamento).
//   2) `_cancelarJob` fecha a `page` (`job.page.close()`) — é isso que
//      interrompe de verdade uma chamada a `page.pdf()` já em andamento,
//      não só impede a PRÓXIMA de começar.
//
// Status real (verificado nesta tarefa): o mecanismo já existia no código
// desde a Fase 5.2 — este teste só FORMALIZA o passo 5.6 como concluído
// (README estava com o status desatualizado, "falta só a 5.6").

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CODIGO = fs.readFileSync(path.join(__dirname, '..', 'lib/rotas/exportar-pdf.js'), 'utf8');

function trechoDoLoopDeBlocos() {
  // Isola só o corpo do `for` que imprime em blocos (pageRanges) — do
  // início do `for (let inicioBloco...` até o fechamento do bloco `if
  // (totalPaginasConhecido) { ... }` (marcado pelo `pdfBuffer =
  // await _mesclarBlocosPdf`, que só existe uma vez, logo depois do loop).
  const inicio = CODIGO.indexOf('for (let inicioBloco = 1;');
  const fim = CODIGO.indexOf('pdfBuffer = await _mesclarBlocosPdf');
  assert.ok(inicio > 0, 'não encontrei o loop de impressão em blocos (pageRanges) — mudou de nome/lugar?');
  assert.ok(fim > inicio, 'não encontrei o fim do loop (_mesclarBlocosPdf) depois do início');
  return CODIGO.slice(inicio, fim);
}

test('loop de impressão em blocos checa job.status ANTES de cada page.pdf() — não começa um bloco novo se já foi cancelado', () => {
  const trecho = trechoDoLoopDeBlocos();
  const posPrimeiraChecagem = trecho.indexOf("if (job.status !== 'processando') return;");
  const posPdf = trecho.indexOf('await page.pdf(');
  assert.ok(posPrimeiraChecagem >= 0, 'esperava um checagem de job.status logo no início do loop');
  assert.ok(posPdf > posPrimeiraChecagem, 'a checagem de status precisa vir ANTES do page.pdf() dentro do loop');
});

test('loop de impressão em blocos checa job.status DEPOIS de cada page.pdf() — não mescla/reporta um bloco impresso depois do cancelamento', () => {
  const trecho = trechoDoLoopDeBlocos();
  const posPdf = trecho.indexOf('await page.pdf(');
  const posSegundaChecagem = trecho.indexOf("if (job.status !== 'processando') return;", posPdf);
  assert.ok(posPdf >= 0, 'esperava um page.pdf() dentro do loop');
  assert.ok(posSegundaChecagem > posPdf, 'esperava uma segunda checagem de job.status DEPOIS do page.pdf(), antes de continuar o loop');
});

test('_cancelarJob fecha job.page de verdade — é isso que interrompe um page.pdf() já em andamento, não só a próxima iteração', () => {
  const inicioFuncao = CODIGO.indexOf('async function _cancelarJob(');
  assert.ok(inicioFuncao >= 0, 'não encontrei _cancelarJob');
  const trechoCancelar = CODIGO.slice(inicioFuncao, inicioFuncao + 3000);

  // job.status muda ANTES de tentar fechar a page — garante que, mesmo se
  // o fechamento demorar (ver TIMEOUT_FECHAR_PAGINA_MS), qualquer checagem
  // de job.status que rode em paralelo (ex.: entre um bloco e outro do
  // loop, testado acima) já vê o cancelamento.
  const posStatus = trechoCancelar.indexOf("job.status = 'cancelado';");
  const posClose = trechoCancelar.indexOf('job.page.close()');
  assert.ok(posStatus >= 0, 'esperava job.status ser marcado como "cancelado"');
  assert.ok(posClose > posStatus, 'job.page.close() precisa vir depois de marcar job.status = "cancelado"');
});

test('README: passo 5.6 do plano de Exportação em PDF está marcado como concluído (código já existia, só não estava formalizado)', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const secao = readme.slice(readme.indexOf('## Exportação em PDF (Análise Focada)'));
  const statusLinha = secao.match(/\*\*Status:\*\*.*$/m);
  assert.ok(statusLinha, 'não encontrei a linha de Status da seção de Exportação em PDF no README');
  assert.doesNotMatch(statusLinha[0], /falta só a 5\.6/, 'README ainda diz que falta a 5.6 — atualizar depois de confirmar o mecanismo');
});
