// ─── lib/db/expedicao.js — Cargas de Expedição ─────────────────────────────
// Fase 2 do plano do One Page Report (ver README, "Nova página: One Page
// Report (planejamento)"). Mesmo padrão factory do resto de lib/db/: recebe
// a conexão já aberta (`db`, better-sqlite3) e devolve as funções do
// domínio, penduradas de volta em module.exports (= db, em db.js) via
// Object.assign — os consumidores (lib/rotas/expedicao.js, e futuramente o
// endpoint de agregação da Fase 4) chamam db.listarCargasExpedicao(),
// db.agregacaoSemanalExpedicao() etc., no mesmo estilo do resto do sistema.
//
// Domínio novo (nunca existiu como arquivo/JSON antes da tabela) — sem
// nenhuma migração de legado, mesmo espírito de lib/db/seguranca-
// ocorrencias.js (Fase 1). Sem noção de "uso"/ajuste/remedição: uma carga
// expedida é sempre 1 linha fechada.

module.exports = function criarDbExpedicao(db) {

  /** Converte uma carga recebida em POST /registrar-carga-expedicao (lib/rotas/expedicao.js) pros parâmetros nomeados do INSERT. */
  function cargaParaRow(c) {
    return {
      id: c.id,
      data: c.data,
      cliente: c.cliente,
      m2: c.m2,
      numero_carga: c.numero_carga ?? null,
      // Mesmo raciocínio de operacoes.operador_nome (ver README, "Autoria
      // automática de registro") — rótulo de auditoria, não controle de
      // acesso.
      operador_nome: c.operador_nome || null,
      registrado_em: c.registrado_em || new Date().toISOString(),
    };
  }

  /** Caminho inverso: 1 linha da tabela "expedicao_cargas" -> objeto pro front/backup. */
  function rowParaCarga(row) {
    return {
      id: row.id,
      data: row.data,
      cliente: row.cliente,
      m2: row.m2,
      numero_carga: row.numero_carga,
      operador_nome: row.operador_nome,
      registrado_em: row.registrado_em,
    };
  }

  const SQL_INSERIR_CARGA = `
    INSERT INTO expedicao_cargas (id, data, cliente, m2, numero_carga, operador_nome, registrado_em)
    VALUES (@id, @data, @cliente, @m2, @numero_carga, @operador_nome, @registrado_em)
  `;

  /**
   * Todas as cargas, mais recente primeiro (mesmo critério de leitura já
   * usado em seguranca_ocorrencias/paradas/manutenção) — usada por GET
   * /db/expedicao_cargas.json (lib/rotas/expedicao.js) e, futuramente,
   * pelo endpoint de agregação do One Page Report (Fase 4).
   *
   * `mesISO` opcional (YYYY-MM) filtra só as cargas daquele mês — usado
   * pela agregação semanal (agregacaoSemanalExpedicao, abaixo) e disponível
   * também via querystring da rota (?mes=YYYY-MM), pra telas que já sabem
   * de antemão qual mês querem sem precisar filtrar a lista inteira no
   * frontend.
   */
  function listarCargasExpedicao(mesISO) {
    if (mesISO) {
      return db.prepare('SELECT * FROM expedicao_cargas WHERE SUBSTR(data, 1, 7) = ? ORDER BY data DESC, registrado_em DESC')
        .all(mesISO)
        .map(rowParaCarga);
    }
    return db.prepare('SELECT * FROM expedicao_cargas ORDER BY data DESC, registrado_em DESC')
      .all()
      .map(rowParaCarga);
  }

  /**
   * Grava 1 carga expedida. Usada por POST /registrar-carga-expedicao
   * (lib/rotas/expedicao.js) — `id`/`registrado_em` nascem no servidor
   * (mesmo raciocínio de lib/rotas/seguranca.js), a rota só valida
   * `data`/`cliente`/`m2` antes de chamar isto.
   */
  function inserirCargaExpedicao(c) {
    db.prepare(SQL_INSERIR_CARGA).run(cargaParaRow(c));
  }

  /**
   * Exclui 1 carga pelo id. Devolve `true` se algo foi de fato apagado
   * (mesmo contrato usado por excluirOcorrenciaSeguranca/excluir-parada,
   * que checam `resultado.changes === 0` pra devolver "não encontrada").
   */
  function excluirCargaExpedicao(id) {
    const resultado = db.prepare('DELETE FROM expedicao_cargas WHERE id = ?').run(id);
    return resultado.changes > 0;
  }

  /**
   * Divide os dias de um mês (1 a `totalDias`) em até 4 semanas fixas
   * (S1-S4, ver README, Fase 2) — dias 1-7, 8-14, 15-21 e 22-fim do mês
   * (a S4 absorve os dias extras de meses com 29-31 dias, em vez de nascer
   * uma S5 solta). Função pura, sem SQL, só pra não duplicar o corte de
   * faixas entre a agregação e (futuramente) os testes.
   */
  function faixasSemanais(totalDias) {
    const faixas = [
      { semana: 'S1', inicioDia: 1, fimDia: 7 },
      { semana: 'S2', inicioDia: 8, fimDia: 14 },
      { semana: 'S3', inicioDia: 15, fimDia: 21 },
      { semana: 'S4', inicioDia: 22, fimDia: totalDias },
    ];
    // Meses com só 28 dias (fevereiro comum): a S4 ficaria vazia
    // (inicioDia 22 > fimDia 28 nunca acontece, mas se totalDias < 22 por
    // algum motivo, evita uma faixa invertida) — não é o caso real do
    // calendário gregoriano, mas a guarda custa nada e deixa a função
    // segura por construção.
    return faixas.filter(f => f.inicioDia <= f.fimDia);
  }

  /**
   * Agregação semanal (S1-S4) + acumulado do mês + forecast (ver README,
   * Fase 2) pra um mês (`mesISO`, formato YYYY-MM).
   *
   * `hojeISO` (YYYY-MM-DD, sempre calculado por quem chama via
   * todayBrasiliaServer — este módulo não conhece fuso horário nenhum,
   * mesmo espírito de diasSemAcidentes em lib/db/seguranca-ocorrencias.js)
   * só importa quando `mesISO` é o mês CORRENTE: é o que decide quantos
   * dias já se passaram, pra calcular o forecast (projeção linear:
   * acumulado / dias já passados * dias totais do mês).
   *
   * Meses PASSADOS (mesISO !== mês de hojeISO) ou FUTUROS não têm
   * forecast projetado — o mês passado já fechou (forecast = o próprio
   * acumulado, não uma projeção) e o mês futuro ainda não tem nenhum dia
   * "já passado" pra projetar em cima (forecast = null, mesmo raciocínio
   * de "nunca inventar dado" das ocorrências de Segurança).
   *
   * Devolve `null` pro mês inteiro quando NÃO HÁ NENHUMA carga registrada
   * ainda naquele mês — nunca semanas com m2 zerado disfarçado de dado
   * real (ver regra combinada do One Page Report, README: "onde não
   * houver dado real ainda, a tela deve mostrar Dado indisponível" —
   * quem decide exibir esse aviso é o endpoint de agregação da Fase 4/o
   * frontend da Fase 5, este módulo só devolve `null` pra sinalizar).
   */
  function agregacaoSemanalExpedicao(mesISO, hojeISO) {
    const cargasDoMes = listarCargasExpedicao(mesISO);
    if (cargasDoMes.length === 0) return null;

    const [ano, mes] = mesISO.split('-').map(Number);
    const totalDias = new Date(Date.UTC(ano, mes, 0)).getUTCDate(); // dia 0 do mês seguinte = último dia deste mês

    const semanas = faixasSemanais(totalDias).map(f => ({ semana: f.semana, inicioDia: f.inicioDia, fimDia: f.fimDia, m2: 0 }));

    let acumuladoMes = 0;
    for (const carga of cargasDoMes) {
      const dia = Number(carga.data.split('-')[2]);
      const faixa = semanas.find(s => dia >= s.inicioDia && dia <= s.fimDia);
      if (faixa) faixa.m2 += carga.m2;
      acumuladoMes += carga.m2;
    }

    // Forecast só faz sentido pro mês CORRENTE (ver comentário acima) —
    // hojeISO vem sempre no formato YYYY-MM-DD.
    const mesCorrenteISO = hojeISO.slice(0, 7);
    let forecast = null;
    if (mesISO === mesCorrenteISO) {
      const diaHoje = Number(hojeISO.split('-')[2]);
      const diasPassados = Math.max(1, Math.min(diaHoje, totalDias)); // nunca divide por 0
      forecast = Math.round((acumuladoMes / diasPassados) * totalDias * 100) / 100;
    } else if (mesISO < mesCorrenteISO) {
      // Mês já fechado: o "forecast" final é o próprio acumulado (não há
      // mais nenhum dia restante pra projetar).
      forecast = acumuladoMes;
    }
    // Mês futuro (mesISO > mesCorrenteISO): fica null (ainda sem nenhum
    // dia "já passado" pra basear a projeção).

    return { mes: mesISO, semanas, acumuladoMes: Math.round(acumuladoMes * 100) / 100, forecast };
  }

  return {
    cargaParaRow,
    rowParaCarga,
    SQL_INSERIR_CARGA,
    listarCargasExpedicao,
    inserirCargaExpedicao,
    excluirCargaExpedicao,
    agregacaoSemanalExpedicao,
  };
};
