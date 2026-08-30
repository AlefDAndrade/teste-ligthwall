// ─── lib/db/tracos-descartados.js — Traços Descartados (perda) ────────────
// Ver README, "Registro de Traço Descartado (Perda) — plano" — passo 1
// (estrutura de dados). Mesmo padrão factory do resto de lib/db/: recebe a
// conexão já aberta (`db`, better-sqlite3) e devolve as funções do
// domínio, penduradas de volta em module.exports (= db, em db.js) via
// Object.assign — os consumidores (lib/rotas/tracos-descartados.js,
// lib/rotas/backup.js) chamam db.inserirTracoDescartado(...),
// db.todosOsTracosDescartados() etc., no mesmo estilo do resto do sistema.
//
// Diferente de lib/db/tracos.js (Fase 5/8), NÃO existe aqui nenhuma
// migração de JSON legado — este é um domínio novo, nunca existiu como
// arquivo antes da tabela. E diferente também: nenhuma noção de "uso"
// (id_operacao/berco_inicio/berco_finalizacao) nem de ajustes/remedição —
// um traço descartado é sempre 1 linha fechada, sem relação com nenhuma
// outra tabela (ver comentário grande na CREATE TABLE, db.js, sobre por
// que esse isolamento é físico/proposital).

module.exports = function criarDbTracosDescartados(db) {

  /**
   * Converte o payload recebido em POST /registrar-traco-descartado
   * (lib/rotas/tracos-descartados.js) pros parâmetros nomeados do INSERT.
   * `motivo` é o único campo que a rota valida como obrigatório antes de
   * chegar aqui (a coluna já é NOT NULL, mas a mensagem de erro amigável
   * — "motivo é obrigatório" — precisa nascer na rota, não como um erro
   * cru de constraint do SQLite).
   */
  function tracoDescartadoParaRow(t) {
    return {
      id: t.id,
      data: t.data ?? null,
      turno: t.turno ?? null,
      cimento: t.cimento === '' || t.cimento === undefined ? null : Number(t.cimento),
      agua: t.agua === '' || t.agua === undefined ? null : Number(t.agua),
      eps: t.eps === '' || t.eps === undefined ? null : Number(t.eps),
      superplast: t.superplast === '' || t.superplast === undefined ? null : Number(t.superplast),
      incorporador: t.incorporador === '' || t.incorporador === undefined ? null : Number(t.incorporador),
      tempo_batida: t.tempo_batida === '' || t.tempo_batida === undefined ? null : Number(t.tempo_batida),
      motivo: t.motivo,
      // Ver comentário em operacoes.operador_nome (README, "Autoria
      // automática de registro") — mesmo raciocínio: rótulo de auditoria,
      // não controle de acesso.
      operador_nome: t.operador_nome || null,
      registrado_em: t.registrado_em || new Date().toISOString(),
    };
  }

  /** Caminho inverso: 1 linha da tabela "tracos_descartados" -> objeto pro front/backup. */
  function rowParaTracoDescartado(row) {
    return {
      id: row.id,
      data: row.data,
      turno: row.turno,
      cimento: row.cimento,
      agua: row.agua,
      eps: row.eps,
      superplast: row.superplast,
      incorporador: row.incorporador,
      tempo_batida: row.tempo_batida,
      motivo: row.motivo,
      operador_nome: row.operador_nome,
      registrado_em: row.registrado_em,
    };
  }

  const SQL_INSERIR_TRACO_DESCARTADO = `
    INSERT INTO tracos_descartados (
      id, data, turno, cimento, agua, eps, superplast, incorporador,
      tempo_batida, motivo, operador_nome, registrado_em
    ) VALUES (
      @id, @data, @turno, @cimento, @agua, @eps, @superplast, @incorporador,
      @tempo_batida, @motivo, @operador_nome, @registrado_em
    )
  `;

  /**
   * Todos os traços descartados, no formato de rowParaTracoDescartado —
   * usado por GET /db/tracos_descartados.json (lib/rotas/tracos-
   * descartados.js) e pelo backup (lib/rotas/backup.js). Mais recente
   * primeiro, mesmo critério de leitura já usado em paradas/manutenção.
   */
  function todosOsTracosDescartados() {
    return db.prepare('SELECT * FROM tracos_descartados ORDER BY registrado_em DESC')
      .all()
      .map(rowParaTracoDescartado);
  }

  /**
   * Grava 1 traço descartado. Usada por POST /registrar-traco-descartado
   * (lib/rotas/tracos-descartados.js) e por substituirTracosDescartados/
   * mesclarTracosDescartados, abaixo, pro Restaurar/Mesclar Backup.
   */
  function inserirTracoDescartado(t) {
    db.prepare(SQL_INSERIR_TRACO_DESCARTADO).run(tracoDescartadoParaRow(t));
  }

  /**
   * Restauração total (POST /restaurar-backup-dados e /restaurar-backup-geral)
   * — apaga tudo e reinsere, mesmo padrão de substituirManutencaoCorretiva
   * (lib/db/manutencao-corretiva.js) e substituirAvaliacoesQualidade
   * (lib/db/operacoes-qualidade.js). Sem a complexidade de
   * substituirTracosEAjustes (lib/db/tracos.js) — não existe aqui noção
   * de "uso"/ajuste pra recalcular, é 1 linha fechada por traço descartado.
   */
  function substituirTracosDescartados(lista) {
    db.prepare('DELETE FROM tracos_descartados').run();
    for (const t of (lista || [])) inserirTracoDescartado(t);
  }

  /**
   * Mesclagem (POST /mesclar-backup-dados) — dedupe só por `id` (chave
   * primária da tabela), mesmo critério já usado pra paradas em
   * lib/rotas/backup.js (`existentesParadas`/`inserirParada`). Não há
   * conceito de "mesmo traço vindo de fontes diferentes" aqui como em
   * mesclarTracosEAjustes (chave por uso/data+num_traco) — cada descarte
   * já nasce com um id único (`descarte_<timestamp>`), então colidir só
   * acontece mesclando o MESMO backup duas vezes.
   */
  function mesclarTracosDescartados(lista) {
    const existentes = new Set(db.prepare('SELECT id FROM tracos_descartados').all().map(r => r.id));
    let inseridos = 0, duplicatas = 0;
    for (const t of (lista || [])) {
      if (existentes.has(t.id)) { duplicatas++; continue; }
      inserirTracoDescartado(t);
      existentes.add(t.id);
      inseridos++;
    }
    return { inseridos, duplicatas };
  }

  return {
    tracoDescartadoParaRow,
    rowParaTracoDescartado,
    SQL_INSERIR_TRACO_DESCARTADO,
    todosOsTracosDescartados,
    inserirTracoDescartado,
    substituirTracosDescartados,
    mesclarTracosDescartados,
  };
};
