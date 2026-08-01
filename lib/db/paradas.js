// ─── lib/db/paradas.js — Paradas (paradas.json -> tabela paradas) ──────────
// Fase 7 do fatiamento de db.js (ver README, "Fatiamento de db.js (plano)").
// Extraído sem mudar nenhuma lógica — só de onde o código mora.
//
// Diferente de Manutenção Programada (Fase 2, ver lib/db/manutencao-
// programada.js), este domínio nunca teve funções tipo
// listarParadas/salvarParada/excluirParada em db.js: lib/rotas/paradas.js
// sempre chamou db.prepare(...) diretamente pra SELECT/INSERT/DELETE, só
// reaproveitando daqui os DOIS conversores de formato (paradaParaRow /
// rowParaParada — camelCase/snake_case pra lá e pra cá) e a query de
// INSERT usada tanto pela rota quanto pela migração/restauração de
// backup (ver lib/rotas/backup.js). Continuam como estavam: pendurados
// no objeto `db` (module.exports = db, em db.js), só que definidos aqui.
//
// migrarParadasSeNecessario (chamada 1x no boot, ver server.js) também
// mora aqui — é a única função "de verdade" deste domínio em db.js, e
// só faz sentido junto dos conversores que ela usa.

module.exports = function criarDbParadas(db) {

  /** Converte uma parada no formato paradas.json pros parâmetros nomeados do INSERT/UPDATE. */
  function paradaParaRow(p) {
    return {
      id: p.id,
      inicio: p.inicio,
      fim: p.fim,
      duracao_min: p.duracao_min ?? null,
      motivo: p.motivo ?? null,
      equipamento: p.equipamento ?? null,
      classificacao: p.classificacao ?? null,
      obs: p.obs ?? null,
      registrado_em: p.registrado_em ?? null,
      // Ver comentário em paradas.operador_nome (CREATE TABLE, db.js).
      operador_nome: p.operador_nome || null,
    };
  }

  /** Caminho inverso: 1 linha da tabela "paradas" -> objeto no formato paradas.json. */
  function rowParaParada(row) {
    return {
      id: row.id,
      inicio: row.inicio,
      fim: row.fim,
      duracao_min: row.duracao_min,
      motivo: row.motivo,
      equipamento: row.equipamento,
      classificacao: row.classificacao,
      obs: row.obs,
      registrado_em: row.registrado_em,
      operador_nome: row.operador_nome || null,
    };
  }

  const SQL_INSERIR_PARADA = `
    INSERT INTO paradas (id, inicio, fim, duracao_min, motivo, equipamento, classificacao, obs, registrado_em, operador_nome)
    VALUES (@id, @inicio, @fim, @duracao_min, @motivo, @equipamento, @classificacao, @obs, @registrado_em, @operador_nome)
  `;

  /**
   * Migração automática (Fase 3 de migração legado, ver comentário no
   * topo do arquivo) — mesmo critério/padrão de
   * migrarHistoricoSeNecessario(): só faz algo se a tabela "paradas"
   * estiver vazia E paradas.json ainda existir com esse nome; renomeia
   * pra ".migrado-<timestamp>" depois (nunca apaga).
   */
  function migrarParadasSeNecessario(dbDir) {
    const path = require('path');
    const fs = require('fs');

    const jaTemDados = db.prepare('SELECT COUNT(*) AS n FROM paradas').get().n > 0;
    if (jaTemDados) return;

    const paradasPath = path.join(dbDir, 'paradas.json');
    if (!fs.existsSync(paradasPath)) return;

    let paradas = [];
    try {
      const texto = fs.readFileSync(paradasPath, 'utf8').trim();
      paradas = texto ? JSON.parse(texto) : [];
    } catch (e) {
      console.error('[migração] Não consegui ler paradas.json — abortando migração:', e.message);
      return;
    }
    if (!Array.isArray(paradas) || !paradas.length) {
      // Renomeia só pra não tentar reprocessar este arquivo no próximo boot.
      // Se falhar (ex.: sem permissão de escrita no diretório), não é
      // crítico — o array já estava vazio, então não havia nada a migrar.
      try { fs.renameSync(paradasPath, paradasPath + '.migrado-' + Date.now()); } catch (_) {}
      return;
    }

    const inserirParada = db.prepare(SQL_INSERIR_PARADA);
    const migrarTudo = db.transaction((registros) => {
      for (const p of registros) inserirParada.run(paradaParaRow(p));
    });
    migrarTudo(paradas);
    console.log(`[migração] ${paradas.length} parada(s) migrada(s) de paradas.json pra SQLite.`);

    try {
      fs.renameSync(paradasPath, paradasPath + '.migrado-' + Date.now());
    } catch (e) {
      console.error('[migração] Migrei os dados, mas não consegui renomear paradas.json:', e.message);
    }
  }

  return {
    paradaParaRow,
    rowParaParada,
    SQL_INSERIR_PARADA,
    migrarParadasSeNecessario,
  };
};
