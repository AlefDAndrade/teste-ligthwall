// ─── lib/db/exportacoes-pdf.js — Exportações de PDF (Etapa 3, ver README) ──
// CREATE TABLE exportacoes_pdf continua em db.js (schema fica junto com o
// resto da estrutura do banco) — aqui só as funções que leem/escrevem
// nessa tabela. Mesmo padrão de lib/db/sessoes.js: recebe a conexão `db`
// (better-sqlite3) já aberta, em vez de abrir a própria.
//
// Consultada por lib/rotas/exportar-pdf.js no lugar de confiar só no `Map`
// em memória (`_jobs`) pra saber se um PDF já concluído ainda está
// disponível pra download — o `Map` continua existindo (é o que alimenta
// o progresso ao vivo via SSE), mas o "job terminou, PDF esperando ser
// baixado" agora tem uma cópia aqui que sobrevive a um restart do
// processo e ao TTL de limpeza da memória.

module.exports = function criarDbExportacoesPdf(db) {

  function criarRegistroExportacaoPdf({ jobId, usuarioId, nomeArquivo, criadoEm }) {
    db.prepare(`
      INSERT INTO exportacoes_pdf (job_id, usuario_id, nome_arquivo, status, criado_em)
      VALUES (?, ?, ?, 'processando', ?)
    `).run(jobId, usuarioId, nomeArquivo, criadoEm);
  }

  /** Grava o caminho do arquivo em disco + tamanho e marca como 'concluido'. */
  function marcarExportacaoPdfConcluida(jobId, { caminhoArquivo, tamanhoBytes, concluidoEm }) {
    db.prepare(`
      UPDATE exportacoes_pdf
      SET status = 'concluido', caminho_arquivo = ?, tamanho_bytes = ?, concluido_em = ?
      WHERE job_id = ?
    `).run(caminhoArquivo, tamanhoBytes, concluidoEm, jobId);
  }

  function marcarExportacaoPdfErro(jobId, erro, concluidoEm) {
    db.prepare(`
      UPDATE exportacoes_pdf
      SET status = 'erro', erro = ?, concluido_em = ?
      WHERE job_id = ?
    `).run(String(erro || ''), concluidoEm, jobId);
  }

  function marcarExportacaoPdfCancelada(jobId, concluidoEm) {
    db.prepare(`
      UPDATE exportacoes_pdf
      SET status = 'cancelado', concluido_em = ?
      WHERE job_id = ?
    `).run(concluidoEm, jobId);
  }

  /** Devolve a linha inteira (ou undefined se o job_id não existir). */
  function obterExportacaoPdf(jobId) {
    return db.prepare('SELECT * FROM exportacoes_pdf WHERE job_id = ?').get(jobId);
  }

  /**
   * Devolve o job "ativo" mais recente de um usuário — 'processando' (tá
   * rodando, precisa esperar) OU 'concluido' (tá pronto, mas ninguém
   * ainda decidiu baixar/descartar) — ou `undefined` se não tiver
   * nenhum. 'erro'/'cancelado' NUNCA contam como ativo: são estados
   * terminais que não bloqueiam nada (ver POST /iniciar,
   * lib/rotas/exportar-pdf.js).
   *
   * Por que ler do BANCO em vez de só `_jobs` (memória): um job
   * 'concluido' pode ter saído da memória (TTL de 10min da limpeza em
   * RAM, ver JOB_TTL_MS) muito antes do usuário decidir o que fazer — o
   * bloqueio (e o aviso "PDF pronto") precisa continuar valendo mesmo
   * depois disso, e só o banco sobrevive esse tempo todo (ver
   * EXPORTACAO_PDF_TTL_DISCO_MS, bem mais generoso).
   */
  function obterExportacaoPdfAtivaDoUsuario(usuarioId) {
    return db.prepare(`
      SELECT * FROM exportacoes_pdf
      WHERE usuario_id = ? AND status IN ('processando', 'concluido')
      ORDER BY criado_em DESC
      LIMIT 1
    `).get(usuarioId);
  }

  function apagarExportacaoPdf(jobId) {
    db.prepare('DELETE FROM exportacoes_pdf WHERE job_id = ?').run(jobId);
  }

  /**
   * Rede de segurança contra crescimento indefinido de disco — apaga só
   * registros JÁ TERMINADOS (concluído/erro/cancelado) mais antigos que
   * `maxIdadeMs`, nunca um 'processando' (mesmo que pareça "velho": pode
   * só estar demorando muito num export grande de verdade). Quem chama
   * ainda precisa apagar o ARQUIVO em disco correspondente antes de
   * chamar isto (ver lib/rotas/exportar-pdf.js) — esta função só limpa a
   * linha do banco.
   * Devolve as linhas apagadas (pra quem chamou saber quais arquivos
   * precisa remover do disco).
   */
  function listarExportacoesPdfExpiradas(maxIdadeMs) {
    const limite = Date.now() - maxIdadeMs;
    return db.prepare(`
      SELECT * FROM exportacoes_pdf
      WHERE status != 'processando' AND COALESCE(concluido_em, criado_em) < ?
    `).all(limite);
  }

  /**
   * Todo registro que ainda está 'processando' no banco, mas o processo
   * atual acabou de subir agora — ou seja, o Puppeteer que estava
   * gerando aquele PDF morreu junto com o processo anterior (nenhum
   * job sobrevive a um restart, só o METADADO dele). Chamado uma vez na
   * subida do servidor (ver lib/rotas/exportar-pdf.js) pra não deixar
   * esses registros presos em 'processando' pra sempre.
   */
  function corrigirExportacoesPdfOrfasNaSubida() {
    db.prepare(`
      UPDATE exportacoes_pdf
      SET status = 'erro', erro = 'Geração interrompida (servidor reiniciado).', concluido_em = ?
      WHERE status = 'processando'
    `).run(Date.now());
  }

  return {
    criarRegistroExportacaoPdf,
    marcarExportacaoPdfConcluida,
    marcarExportacaoPdfErro,
    marcarExportacaoPdfCancelada,
    obterExportacaoPdf,
    obterExportacaoPdfAtivaDoUsuario,
    apagarExportacaoPdf,
    listarExportacoesPdfExpiradas,
    corrigirExportacoesPdfOrfasNaSubida,
  };
};
