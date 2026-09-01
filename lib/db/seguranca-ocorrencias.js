// ─── lib/db/seguranca-ocorrencias.js — Ocorrências de Segurança ───────────
// Fase 1 do plano do One Page Report (ver README, "Nova página: One Page
// Report (planejamento)"). Mesmo padrão factory do resto de lib/db/: recebe
// a conexão já aberta (`db`, better-sqlite3) e devolve as funções do
// domínio, penduradas de volta em module.exports (= db, em db.js) via
// Object.assign — os consumidores (lib/rotas/seguranca.js, e futuramente o
// endpoint de agregação da Fase 4) chamam db.listarOcorrenciasSeguranca(),
// db.diasSemAcidentes() etc., no mesmo estilo do resto do sistema.
//
// Domínio novo (nunca existiu como arquivo/JSON antes da tabela) — sem
// nenhuma migração de legado, mesmo espírito de lib/db/tracos-
// descartados.js. Sem noção de "uso"/ajuste/remedição: uma ocorrência é
// sempre 1 linha fechada.

// Enum fechado (ver comentário na CREATE TABLE, db.js, sobre por que não é
// texto livre) — os 3 níveis já usados informalmente pelo time no relatório
// executivo mensal que serviu de modelo pro One Page Report.
const GRAVIDADES_VALIDAS = ['leve', 'moderada', 'grave'];

module.exports = function criarDbSegurancaOcorrencias(db) {

  /** Converte uma ocorrência recebida em POST /registrar-ocorrencia-seguranca (lib/rotas/seguranca.js) pros parâmetros nomeados do INSERT. */
  function ocorrenciaParaRow(o) {
    return {
      id: o.id,
      data: o.data,
      descricao: o.descricao ?? null,
      gravidade: o.gravidade,
      // Mesmo raciocínio de operacoes.operador_nome (ver README, "Autoria
      // automática de registro") — rótulo de auditoria, não controle de
      // acesso.
      operador_nome: o.operador_nome || null,
      registrado_em: o.registrado_em || new Date().toISOString(),
    };
  }

  /** Caminho inverso: 1 linha da tabela "seguranca_ocorrencias" -> objeto pro front/backup. */
  function rowParaOcorrencia(row) {
    return {
      id: row.id,
      data: row.data,
      descricao: row.descricao,
      gravidade: row.gravidade,
      operador_nome: row.operador_nome,
      registrado_em: row.registrado_em,
    };
  }

  const SQL_INSERIR_OCORRENCIA = `
    INSERT INTO seguranca_ocorrencias (id, data, descricao, gravidade, operador_nome, registrado_em)
    VALUES (@id, @data, @descricao, @gravidade, @operador_nome, @registrado_em)
  `;

  /**
   * Todas as ocorrências, mais recente primeiro (mesmo critério de leitura
   * já usado em paradas/manutenção/traços descartados) — usada por
   * GET /db/seguranca_ocorrencias.json (lib/rotas/seguranca.js) e,
   * futuramente, pelo endpoint de agregação do One Page Report (Fase 4).
   */
  function listarOcorrenciasSeguranca() {
    return db.prepare('SELECT * FROM seguranca_ocorrencias ORDER BY data DESC, registrado_em DESC')
      .all()
      .map(rowParaOcorrencia);
  }

  /**
   * Grava 1 ocorrência. Usada por POST /registrar-ocorrencia-seguranca
   * (lib/rotas/seguranca.js) — `id`/`registrado_em` nascem no servidor
   * (mesmo raciocínio de lib/rotas/tracos-descartados.js), a rota só
   * valida `data`/`gravidade` antes de chamar isto.
   */
  function inserirOcorrenciaSeguranca(o) {
    db.prepare(SQL_INSERIR_OCORRENCIA).run(ocorrenciaParaRow(o));
  }

  /**
   * Exclui 1 ocorrência pelo id. Devolve `true` se algo foi de fato
   * apagado (mesmo contrato usado pela rota de excluir-parada, que checa
   * `resultado.changes === 0` pra devolver "não encontrada").
   */
  function excluirOcorrenciaSeguranca(id) {
    const resultado = db.prepare('DELETE FROM seguranca_ocorrencias WHERE id = ?').run(id);
    return resultado.changes > 0;
  }

  /**
   * "Dias sem acidentes" (ver README, Fase 1) — dias corridos entre HOJE
   * (recebido como YYYY-MM-DD, sempre calculado por quem chama via
   * todayBrasiliaServer — este módulo não conhece fuso horário nenhum,
   * mesmo espírito de lib/tempo.js só viver fora de lib/db/) e a data da
   * ocorrência MAIS RECENTE já registrada.
   *
   * Devolve `{ dias: null, ultimaOcorrencia: null }` quando não há
   * NENHUMA ocorrência ainda — nunca "0" ou qualquer outro número
   * inventado (ver regra combinada do One Page Report, README: "onde não
   * houver dado real ainda, a tela deve mostrar Dado indisponível").
   *
   * Datas comparadas via Date.UTC (não `new Date('YYYY-MM-DD')` direto)
   * pra nunca sofrer de fuso horário na subtração — ambas as pontas já
   * chegam como YYYY-MM-DD (Brasília), a diferença em dias corridos é
   * só aritmética de calendário, não de instante.
   */
  function diasSemAcidentes(hojeISO) {
    const row = db.prepare('SELECT MAX(data) AS ultima FROM seguranca_ocorrencias').get();
    const ultimaOcorrencia = row && row.ultima ? row.ultima : null;
    if (!ultimaOcorrencia) return { dias: null, ultimaOcorrencia: null };

    const [anoU, mesU, diaU] = ultimaOcorrencia.split('-').map(Number);
    const [anoH, mesH, diaH] = hojeISO.split('-').map(Number);
    const msUltima = Date.UTC(anoU, mesU - 1, diaU);
    const msHoje = Date.UTC(anoH, mesH - 1, diaH);
    const dias = Math.max(0, Math.round((msHoje - msUltima) / 86400000));

    return { dias, ultimaOcorrencia };
  }

  return {
    ocorrenciaParaRow,
    rowParaOcorrencia,
    SQL_INSERIR_OCORRENCIA,
    listarOcorrenciasSeguranca,
    inserirOcorrenciaSeguranca,
    excluirOcorrenciaSeguranca,
    diasSemAcidentes,
  };
};

module.exports.GRAVIDADES_VALIDAS = GRAVIDADES_VALIDAS;
