// ─── lib/db/sobra-contador-tracos.js — Fase 6 do fatiamento de db.js ──────
// Extraído de db.js (ver "Fatiamento de db.js (plano)" no README) seguindo
// o mesmo padrão usado em lib/rotas/ e já validado na Fase 3
// (lib/db/manutencao-corretiva.js): uma factory que recebe só a
// dependência que este domínio usa — a conexão já aberta do
// better-sqlite3 (não abre a própria; só existe uma conexão no processo
// inteiro, ver README) — e devolve as funções do domínio "Sobra de
// material" + "Contador de traços do dia". Nenhuma lógica mudou nesta
// fase, só onde o código mora: o schema (CREATE TABLE sobra / CREATE
// TABLE contador_tracos) continua em db.js (Fase 1 — infraestrutura, sem
// lógica de domínio; contador_tracos já tinha tabela desde a Fase 1 da
// migração SQLite, ver README).
//
// Consumido por lib/rotas/sobra.js (ler/gravar a sobra ativa) e por
// lib/rotas/backup.js (exportar/restaurar a sobra no backup) através de
// db.js, que re-exporta estas funções e a constante SQL_UPSERT_SOBRA
// penduradas no objeto de conexão — nenhum consumidor precisa mudar
// (`db.sobraParaRow(...)`, `db.prepare(db.SQL_UPSERT_SOBRA)` etc.
// continuam funcionando iguais). migrarSobraSeNecessario e
// migrarContadorTracosSeNecessario também continuam chamadas direto de
// server.js na subida do servidor.
module.exports = function criarSobraContadorTracos(db) {

  /** Converte o objeto sobra.json (camelCase) pros parâmetros nomeados do upsert. */
  function sobraParaRow(s) {
    return {
      ativa: s.ativa ? 1 : 0,
      traco_id: s.tracoId ?? null,
      num_traco: s.numTraco ?? null,
      operacao_origem: s.operacaoOrigem ?? null,
      flow: (s.flow === '' || s.flow === undefined) ? null : s.flow,
      densidade: (s.densidade === '' || s.densidade === undefined) ? null : s.densidade,
      receita: s.receita ? JSON.stringify(s.receita) : null,
      data: s.data ?? null,
      status: s.status ?? null,
      data_encerramento: s.dataEncerramento ?? null,
    };
  }

  /** Caminho inverso: a linha da tabela "sobra" -> objeto no formato sobra.json (camelCase). */
  function rowParaSobra(row) {
    if (!row) return {}; // nunca houve nenhuma sobra ainda — mesmo default de DEFAULT_SE_VAZIO_BACKUP_DADOS
    return {
      ativa: !!row.ativa,
      tracoId: row.traco_id,
      numTraco: row.num_traco,
      operacaoOrigem: row.operacao_origem,
      flow: row.flow,
      densidade: row.densidade,
      receita: row.receita ? JSON.parse(row.receita) : {},
      data: row.data,
      status: row.status,
      dataEncerramento: row.data_encerramento,
    };
  }

  const SQL_UPSERT_SOBRA = `
    INSERT INTO sobra (id, ativa, traco_id, num_traco, operacao_origem, flow, densidade, receita, data, status, data_encerramento)
    VALUES (1, @ativa, @traco_id, @num_traco, @operacao_origem, @flow, @densidade, @receita, @data, @status, @data_encerramento)
    ON CONFLICT(id) DO UPDATE SET
      ativa = @ativa, traco_id = @traco_id, num_traco = @num_traco, operacao_origem = @operacao_origem,
      flow = @flow, densidade = @densidade, receita = @receita, data = @data, status = @status,
      data_encerramento = @data_encerramento
  `;

  function migrarSobraSeNecessario(dbDir) {
    const path = require('path');
    const fs = require('fs');

    const jaTemDados = db.prepare('SELECT COUNT(*) AS n FROM sobra').get().n > 0;
    if (jaTemDados) return;

    const sobraPath = path.join(dbDir, 'sobra.json');
    if (!fs.existsSync(sobraPath)) return;

    let sobra = null;
    try {
      const texto = fs.readFileSync(sobraPath, 'utf8').trim();
      sobra = texto ? JSON.parse(texto) : null;
    } catch (e) {
      console.error('[migração] Não consegui ler sobra.json — abortando migração:', e.message);
      return;
    }
    if (!sobra || typeof sobra !== 'object' || !Object.keys(sobra).length) {
      // Renomeia só pra não tentar reprocessar este arquivo no próximo boot.
      // Se falhar (ex.: sem permissão de escrita no diretório), não é
      // crítico — o objeto já estava vazio, então não havia nada a migrar.
      try { fs.renameSync(sobraPath, sobraPath + '.migrado-' + Date.now()); } catch (_) {}
      return;
    }

    db.prepare(SQL_UPSERT_SOBRA).run(sobraParaRow(sobra));
    console.log('[migração] sobra migrada de sobra.json pra SQLite.');

    try {
      fs.renameSync(sobraPath, sobraPath + '.migrado-' + Date.now());
    } catch (e) {
      console.error('[migração] Migrei a sobra, mas não consegui renomear sobra.json:', e.message);
    }
  }

  /**
   * Migração automática do contador_tracos.json -> tabela contador_tracos.
   * Diferente das outras, a tabela aceita várias linhas (1 por dia) — mas o
   * arquivo de origem só guardava o dia mais recente, então é só 1 linha pra
   * importar mesmo (ver "Banco de Dados (SQLite)" no README).
   */
  function migrarContadorTracosSeNecessario(dbDir) {
    const path = require('path');
    const fs = require('fs');

    const jaTemDados = db.prepare('SELECT COUNT(*) AS n FROM contador_tracos').get().n > 0;
    if (jaTemDados) return;

    const contadorPath = path.join(dbDir, 'contador_tracos.json');
    if (!fs.existsSync(contadorPath)) return;

    let contador = null;
    try {
      const texto = fs.readFileSync(contadorPath, 'utf8').trim();
      contador = texto ? JSON.parse(texto) : null;
    } catch (e) {
      console.error('[migração] Não consegui ler contador_tracos.json — abortando migração:', e.message);
      return;
    }
    if (!contador || !contador.data) {
      // Renomeia só pra não tentar reprocessar este arquivo no próximo boot.
      // Se falhar (ex.: sem permissão de escrita no diretório), não é
      // crítico — o arquivo não tinha "data", então não havia nada a migrar.
      try { fs.renameSync(contadorPath, contadorPath + '.migrado-' + Date.now()); } catch (_) {}
      return;
    }

    db.prepare('INSERT INTO contador_tracos (data, total) VALUES (?, ?)').run(contador.data, contador.total || 0);
    console.log('[migração] contador de traços migrado de contador_tracos.json pra SQLite.');

    try {
      fs.renameSync(contadorPath, contadorPath + '.migrado-' + Date.now());
    } catch (e) {
      console.error('[migração] Migrei o contador, mas não consegui renomear contador_tracos.json:', e.message);
    }
  }

  return {
    sobraParaRow,
    rowParaSobra,
    SQL_UPSERT_SOBRA,
    migrarSobraSeNecessario,
    migrarContadorTracosSeNecessario,
  };
};
