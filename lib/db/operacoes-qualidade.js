// ─── lib/db/operacoes-qualidade.js — Fase 9 do fatiamento de db.js ─────────
// Extraído de db.js (ver "Fatiamento de db.js (plano)" no README) seguindo
// o mesmo padrão usado nas fases anteriores (lib/db/manutencao-corretiva.js,
// lib/db/paradas.js etc.): uma factory que recebe só a dependência que este
// domínio usa — a conexão já aberta do better-sqlite3 (não abre a própria;
// só existe uma conexão no processo inteiro, ver README) — e devolve as
// funções do domínio "Operações / Berços / Avaliação de Qualidade". Nenhuma
// lógica mudou nesta fase, só onde o código mora: o schema (CREATE TABLE
// operacoes/bercos_visuais/avaliacoes_qualidade/avaliacao_paineis/
// operacoes_avaliadas) continua em db.js (Fase 1 — infraestrutura, sem
// lógica de domínio).
//
// Era a fase de maior risco do plano (núcleo do sistema, tela mais usada
// no dia a dia, bastante entrelaçamento entre operação e avaliação de
// qualidade — ver README) — por isso extraída por último, depois do
// padrão já validado nas Fases 2 a 7.
//
// Inclui, além do range 1003-1798 citado na tabela do README, as duas
// migrações únicas que ficavam logo ANTES dele (linhas ~904-976 na
// numeração antiga de db.js): populam/corrigem operacoes_avaliadas e
// avaliacoes_qualidade, e uma delas chama _vincularAvaliacaoAOperacao —
// função privada deste mesmo domínio, definida mais abaixo (hoisting
// de function declaration cobre isso, igual cobria dentro de db.js).
// Ficaram de fora da tabela do README por estarem tecnicamente antes do
// range listado ali, mas são deste domínio (mexem nas mesmas tabelas) —
// não fazia sentido deixá-las pra trás em db.js.
//
// Todas as migrações deste módulo (as duas daqui + as duas mais abaixo,
// _migrarPaineisAvaliacaoExistentes e _migrarMontagemDasAvaliacoesExistentes)
// continuam rodando na hora em que este módulo é carregado — mesmo
// comportamento de antes (eram código solto no meio de db.js, na mesma
// posição em que o require() desta factory acontece agora).
//
// Consumido por lib/rotas/consultas.js, lib/rotas/qualidade.js,
// lib/rotas/registro-operacao.js, lib/rotas/backup.js e lib/rotas/
// sql-admin.js através de db.js, que re-exporta estas funções penduradas
// no objeto de conexão — nenhum consumidor precisa mudar
// (`db.detalheOperacao(...)`, `db.salvarAvaliacaoQualidade(...)` etc.
// continuam funcionando iguais). Dentro do próprio db.js,
// migrarHistoricoSeNecessario (Fase 10, ainda não extraída) usa
// db.operacaoParaRow/db.SQL_INSERIR_OPERACAO em vez das variáveis locais
// que usava antes — mesmo ajuste já feito nas fases anteriores quando um
// domínio extraído era referenciado por outro trecho de db.js.
module.exports = function criarOperacoesQualidade(db) {

  // ------------------------------------------------------------
  //  Migração única: popula "operacoes_avaliadas" a partir da coluna
  //  legada "operacoes.avaliado" — sem isso, toda operação que já tivesse
  //  sido marcada avaliado=1 ANTES desta tabela existir voltaria a
  //  aparecer na fila de "não avaliadas" (que passa a consultar só esta
  //  tabela, nunca mais a coluna). INSERT OR IGNORE — idempotente, roda
  //  toda subida do servidor sem duplicar nem sobrescrever o
  //  "avaliado_em" de quem já foi migrado numa subida anterior.
  // ------------------------------------------------------------
  const _operacoesAvaliadoLegado = db.prepare(
    'SELECT id FROM operacoes WHERE avaliado = 1'
  ).all();
  if (_operacoesAvaliadoLegado.length) {
    const _inserirLegado = db.prepare(
      'INSERT OR IGNORE INTO operacoes_avaliadas (id_operacao) VALUES (?)'
    );
    const _migrarLegado = db.transaction((linhas) => {
      for (const r of linhas) _inserirLegado.run(r.id);
    });
    _migrarLegado(_operacoesAvaliadoLegado);
    console.log(`[migração] ${_operacoesAvaliadoLegado.length} operação(ões) com "avaliado=1" (coluna legada) migrada(s) para "operacoes_avaliadas".`);
  }

  // ------------------------------------------------------------
  //  Migração única: corrige avaliações AVULSAS registradas ANTES da
  //  correção do bug em marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada
  //  (ver comentário lá) — essas avaliações já tiraram a operação certa
  //  da fila (existe uma linha em "operacoes_avaliadas"), mas nunca
  //  ganharam id_operacao em "avaliacoes_qualidade" (ficou NULL pra
  //  sempre), o que fazia a Análise Focada nunca encontrar o resultado
  //  pra essas operações.
  //
  //  Conservador de propósito: só liga os pontos quando a resposta é
  //  INEQUÍVOCA — 1 avaliação avulsa (id_operacao NULL) e 1 operação
  //  daquela mesma bateria já marcada como avaliada mas ainda sem
  //  NENHUMA avaliação vinculada (nem desta nem de nenhuma outra). Se
  //  houver mais de uma avaliação avulsa OU mais de uma operação
  //  candidata pra mesma bateria, pula (ambíguo demais pra adivinhar) —
  //  melhor deixar sem vincular do que vincular errado.
  // ------------------------------------------------------------
  (function _migrarAvaliacoesAvulsasOrfas() {
    const avulsas = db.prepare(`
      SELECT id, id_bateria FROM avaliacoes_qualidade
      WHERE id_operacao IS NULL AND id_bateria IS NOT NULL
    `).all();
    if (!avulsas.length) return;

    const porBateria = new Map();
    for (const a of avulsas) {
      if (!porBateria.has(a.id_bateria)) porBateria.set(a.id_bateria, []);
      porBateria.get(a.id_bateria).push(a.id);
    }

    let vinculadas = 0;
    const executar = db.transaction(() => {
      for (const [idBateria, idsAvaliacao] of porBateria) {
        if (idsAvaliacao.length !== 1) continue; // mais de uma avulsa pra mesma bateria — ambíguo, pula

        const candidatas = db.prepare(`
          SELECT o.id FROM operacoes o
          JOIN operacoes_avaliadas oa ON oa.id_operacao = o.id
          WHERE o.id_bateria = ?
            AND o.id NOT IN (SELECT id_operacao FROM avaliacoes_qualidade WHERE id_operacao IS NOT NULL)
        `).all(idBateria);
        if (candidatas.length !== 1) continue; // 0 ou >1 operação candidata — ambíguo, pula

        _vincularAvaliacaoAOperacao(idsAvaliacao[0], candidatas[0].id);
        vinculadas++;
      }
    });
    executar();
    if (vinculadas) console.log(`[migração] ${vinculadas} avaliação(ões) avulsa(s) retro-vinculada(s) à operação correta (bug da Análise Focada corrigido para dados já existentes).`);
  })();

  /**
   * Cria a linha inicial de bercos_visuais pra uma operação recém-
   * registrada — 1 linha pra bateria INTEIRA, com todos os berços
   * (B1..B<quantidade>) e seus 2 estados dentro da lista JSON da coluna
   * "bercos". Chamada por POST /registrar-operacao (server.js), logo
   * depois de inserir a operação em si.
   *
   * @param {string} idOperacao
   * @param {number} quantidade
   * @param {Object<string,{esquerda?:string,direita?:string}>} [estadosMarcados] -
   *   mapa esparso vindo do snapshot ao vivo de "Bateria Atual" (ver
   *   GET/POST /bercos-andamento, server.js) — lado ausente do mapa =
   *   'okay'. Se quem estava acompanhando a operação marcou algum lado de
   *   algum berço como 'baixou' ANTES do registro, esse estado entra aqui
   *   já na criação, em vez de nascer 'okay' e precisar de uma segunda
   *   chamada pra corrigir.
   *
   * INSERT OR IGNORE (via PRIMARY KEY id_operacao): se por algum motivo já
   * existir uma linha pra essa operação, não duplica nem sobrescreve
   * estados que porventura já tenham mudado — idempotente.
   */
  const SQL_INSERIR_BERCOS_VISUAIS = `
    INSERT OR IGNORE INTO bercos_visuais (id_operacao, bercos, atualizado_em)
    VALUES (@id_operacao, @bercos, @atualizado_em)
  `;
  function criarBercosVisuaisIniciais(idOperacao, quantidade, estadosMarcados) {
    const mapa = (estadosMarcados && typeof estadosMarcados === 'object') ? estadosMarcados : {};
    const n = Math.max(0, parseInt(quantidade) || 0);
    const bercos = [];
    for (let i = 1; i <= n; i++) {
      const berco = 'B' + i;
      const marcadoBerco = mapa[berco] || {};
      bercos.push({
        berco, ordem: i,
        estado_esquerda: marcadoBerco.esquerda || 'okay',
        estado_direita: marcadoBerco.direita || 'okay',
      });
    }
    db.prepare(SQL_INSERIR_BERCOS_VISUAIS).run({
      id_operacao: idOperacao,
      bercos: JSON.stringify(bercos),
      atualizado_em: new Date().toISOString(),
    });
  }

  /**
   * Converte um registro no formato histórico (historico.json) pros
   * parâmetros nomeados do INSERT/UPDATE de "operacoes" — usado tanto pela
   * migração automática quanto pelas rotas /registrar-operacao e
   * /editar-operacao, pra nunca ter 2 versões da mesma conversão.
   */
  function operacaoParaRow(r) {
    return {
      id: r.id,
      data: r.data,
      turno: r.turno ?? null,
      dimensao: r.dimensao ?? null,
      capacidade: r.capacidade ?? null,
      id_bateria: r.id_bateria ?? null,
      inicio: r.inicio ?? null,
      fim: r.fim ?? null,
      desemplaque: r.desemplaque ?? null,
      tempo_min: r.tempo_min ?? null,
      qtd_tracos: r.qtd_tracos ?? null,
      houve_atraso: r.houve_atraso ?? null,
      motivo_atraso: r.motivo_atraso ?? null,
      tipo_montagem: r.tipo_montagem ?? null,
      bercos_reais: r.bercos_reais ?? null,
      bercos_personalizados: r.bercos_personalizados ? JSON.stringify(r.bercos_personalizados) : null,
      bercos_dimensoes: r.bercos_dimensoes ? JSON.stringify(r.bercos_dimensoes) : null,
      total_paineis: r.total_paineis ?? null,
      m2_total: r.m2_total ?? null,
      placas_cimenticia: r.placas_cimenticia ?? null,
      paineis_por_tipo: r.paineis_por_tipo ? JSON.stringify(r.paineis_por_tipo) : null,
      m2_por_tipo: r.m2_por_tipo ? JSON.stringify(r.m2_por_tipo) : null,
      paineis_2p: r.paineis_2p ?? 0,
      paineis_sp: r.paineis_sp ?? 0,
      m2_2p: r.m2_2p ?? 0,
      m2_sp: r.m2_sp ?? 0,
      tracos_json: r.tracos ? JSON.stringify(r.tracos) : null,
      // !! só vira 1 quando explicitamente true (migração de registro já
      // avaliado, por ex.) — nunca por acidente de um campo truthy qualquer
      // vindo do JSON antigo.
      avaliado: r.avaliado === true || r.avaliado === 1 ? 1 : 0,
      // Ver comentário em operacoes.operador_nome (CREATE TABLE, acima) —
      // nunca obrigatório, fica NULL se não vier.
      operador_nome: r.operador_nome || null,
    };
  }

  /** Caminho inverso: 1 linha da tabela "operacoes" -> objeto no formato historico.json. */
  function rowParaOperacao(row) {
    return {
      id: row.id,
      data: row.data,
      turno: row.turno,
      dimensao: row.dimensao,
      capacidade: row.capacidade,
      id_bateria: row.id_bateria,
      inicio: row.inicio,
      fim: row.fim,
      desemplaque: row.desemplaque,
      tempo_min: row.tempo_min,
      qtd_tracos: row.qtd_tracos,
      houve_atraso: row.houve_atraso,
      motivo_atraso: row.motivo_atraso,
      tipo_montagem: row.tipo_montagem,
      bercos_reais: row.bercos_reais,
      ...(row.bercos_personalizados ? { bercos_personalizados: JSON.parse(row.bercos_personalizados) } : {}),
      ...(row.bercos_dimensoes ? { bercos_dimensoes: JSON.parse(row.bercos_dimensoes) } : {}),
      total_paineis: row.total_paineis,
      m2_total: row.m2_total,
      placas_cimenticia: row.placas_cimenticia,
      paineis_por_tipo: row.paineis_por_tipo ? JSON.parse(row.paineis_por_tipo) : {},
      m2_por_tipo: row.m2_por_tipo ? JSON.parse(row.m2_por_tipo) : {},
      paineis_2p: row.paineis_2p,
      paineis_sp: row.paineis_sp,
      m2_2p: row.m2_2p,
      m2_sp: row.m2_sp,
      tracos: row.tracos_json ? JSON.parse(row.tracos_json) : [],
      avaliado: !!row.avaliado,
      operador_nome: row.operador_nome || null,
    };
  }

  const SQL_INSERIR_OPERACAO = `
    INSERT INTO operacoes (
      id, data, turno, dimensao, capacidade, id_bateria, inicio, fim, desemplaque,
      tempo_min, qtd_tracos, houve_atraso, motivo_atraso, tipo_montagem, bercos_reais,
      bercos_personalizados, bercos_dimensoes, total_paineis, m2_total, placas_cimenticia,
      paineis_por_tipo, m2_por_tipo, paineis_2p, paineis_sp, m2_2p, m2_sp,
      tracos_json, avaliado, modo_teste, operador_nome, criado_em
    ) VALUES (
      @id, @data, @turno, @dimensao, @capacidade, @id_bateria, @inicio, @fim, @desemplaque,
      @tempo_min, @qtd_tracos, @houve_atraso, @motivo_atraso, @tipo_montagem, @bercos_reais,
      @bercos_personalizados, @bercos_dimensoes, @total_paineis, @m2_total, @placas_cimenticia,
      @paineis_por_tipo, @m2_por_tipo, @paineis_2p, @paineis_sp, @m2_2p, @m2_sp,
      @tracos_json, @avaliado, @modo_teste, @operador_nome, @criado_em
    )
  `;

  /**
   * Lista todas as linhas de bercos_visuais (1 por operação), com "bercos"
   * já desserializado — usado pelo Backup de Dados (manual/automático), que
   * antes desta mudança não cobria esta tabela (berços visuais e avaliações
   * de qualidade ficavam de fora dos dois backups baseados em public/db/,
   * só entravam no Backup Geral por este zipar o .sqlite inteiro).
   */
  function todosOsBercosVisuais() {
    const rows = db.prepare('SELECT id_operacao, bercos, atualizado_em FROM bercos_visuais ORDER BY id_operacao ASC').all();
    return rows.map(r => ({ id_operacao: r.id_operacao, bercos: JSON.parse(r.bercos), atualizado_em: r.atualizado_em }));
  }

  /**
   * Substitui TODO o conteúdo de bercos_visuais pelo array informado (mesmo
   * formato de todosOsBercosVisuais) — usado por /restaurar-backup-dados,
   * mesmo padrão "apaga tudo e reinsere dentro de 1 transação" já usado por
   * operações/paradas. Quem chama é responsável por envolver numa
   * db.transaction(), igual às outras rotas de restore.
   */
  const SQL_INSERIR_BERCO_VISUAL_BACKUP = `
    INSERT INTO bercos_visuais (id_operacao, bercos, atualizado_em)
    VALUES (@id_operacao, @bercos, @atualizado_em)
  `;
  function substituirBercosVisuais(lista) {
    db.prepare('DELETE FROM bercos_visuais').run();
    const inserir = db.prepare(SQL_INSERIR_BERCO_VISUAL_BACKUP);
    for (const item of (lista || [])) {
      inserir.run({
        id_operacao: item.id_operacao,
        bercos: JSON.stringify(item.bercos || []),
        atualizado_em: item.atualizado_em || new Date().toISOString(),
      });
    }
  }

  /**
   * Relatório de Berços — 1 linha por operação, juntando bercos_visuais com
   * os dados da bateria (operacoes) que a tela precisa pra identificar cada
   * linha (ID da bateria, tipo de montagem) — usado pela página "Relatório
   * de Berços" (ver public/js/relatorio-bercos.js). Cada berço mantém seu
   * "ordem" (1-based); a página usa isso pra montar as colunas B1..B22,
   * deixando em branco os berços que aquela bateria específica não teve
   * (nem toda bateria usa as 22 posições).
   */
  function relatorioBercos() {
    const rows = db.prepare(`
      SELECT o.id AS id_operacao, o.data, o.turno, o.id_bateria, o.tipo_montagem,
             o.capacidade, o.bercos_reais, o.houve_atraso, o.motivo_atraso,
             o.bercos_personalizados, bv.bercos
      FROM bercos_visuais bv
      JOIN operacoes o ON o.id = bv.id_operacao
      ORDER BY o.data ASC, o.turno ASC, o.criado_em ASC
    `).all();
    return rows.map(r => ({
      id_operacao: r.id_operacao,
      data: r.data,
      turno: r.turno,
      id_bateria: r.id_bateria,
      tipo_montagem: r.tipo_montagem,
      capacidade: r.capacidade,
      bercos_reais: r.bercos_reais,
      // Só preenchido quando tipo_montagem === 'PERSONALIZADA' (ver
      // coluna operacoes.bercos_personalizados) — usado pelo Modo Visual do
      // Relatório de Berços (relatorio-bercos.js) pra colorir CADA berço
      // pelo seu próprio tipo, em vez de um tipo único pra bateria inteira.
      bercos_personalizados: r.bercos_personalizados ? JSON.parse(r.bercos_personalizados) : null,
      // Adicionados pra cruzar com a tabela de Pontos de Atenção (Análise
      // de Berços): confirma se o vazamento marcado no berço bate com um
      // atraso já registrado com esse motivo (ver _mapaAtrasoVazamento, em
      // analise-bercos.js, e normalizarMotivo em analise-operacional.js —
      // mesmos termos de busca, "vazamento/vasamento/reinjeção").
      houve_atraso: r.houve_atraso,
      motivo_atraso: r.motivo_atraso,
      bercos: JSON.parse(r.bercos), // [{berco, ordem, estado_esquerda, estado_direita}, ...]
    }));
  }


  /**
   * Berços visuais de um CONJUNTO específico de operações — usado por
   * GET /operacoes-nao-avaliadas (ver lib/rotas/qualidade.js) pra saber
   * quais berços foram marcados "não enchido" (estado_esquerda/
   * estado_direita === 'nao_enchido', ver POST /marcar-berco-andamento)
   * ANTES da operação ser registrada, e refletir isso na grade do Setor de
   * Qualidade (painel correspondente nem entra na contagem — ver
   * _paineisNaoEnchidosDaOperacao, setor-qualidade.js). Diferente de
   * todosOsBercosVisuais (backup, traz a tabela inteira): aqui só as
   * operações pedidas, e devolve um MAPA por id_operacao (mais direto pro
   * front cruzar com a lista da fila) em vez de array.
   */
  function bercosVisuaisPorOperacoes(ids) {
    const lista = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!lista.length) return {};
    const placeholders = lista.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id_operacao, bercos FROM bercos_visuais WHERE id_operacao IN (${placeholders})`).all(...lista);
    const mapa = {};
    rows.forEach(r => { mapa[r.id_operacao] = JSON.parse(r.bercos); });
    return mapa;
  }

  /**
   * Correlação Traço × Berço — para cada USO de traço com berço_inicio/fim
   * preenchidos (ver traco_usos: berco_inicio/berco_finalizacao — o range
   * de berços que aquele traço específico encheu), calcula a taxa de
   * vazamento (bercos_visuais) SÓ dos berços daquele range, e junta com o
   * nº de ajustes de receita daquele traço (indicador de instabilidade) e
   * a densidade/flow FINAIS dele (mesma regra de "original + última
   * remedição" usada em rowParaTraco/todosOsTracos — ver acima). Usado
   * pelo gráfico de dispersão e pela tabela "Traço × Berço" (piores casos
   * + receita, pra comparar com os traços sem vazamento) na Análise de
   * Berços (ver public/js/analise-bercos.js).
   *
   * Cada linha devolvida é 1 USO (traço + operação específicos), não 1
   * traço só — o mesmo traço pode ser reaproveitado em baterias diferentes
   * (ver traco_usos), e cada reaproveitamento encheu berços diferentes,
   * com resultado de vazamento diferente. INNER JOIN com operacoes e
   * bercos_visuais already exclui usos de traços importados em lote (id_
   * operacao sintético, sem operação/berços visuais reais por trás — ver
   * comentário em CREATE TABLE traco_usos, acima).
   */
  function correlacaoTracoBerco() {
    const rows = db.prepare(`
      SELECT tu.id_traco, tu.id_operacao, tu.berco_inicio, tu.berco_finalizacao,
             o.data, o.turno, o.id_bateria, o.tipo_montagem, bv.bercos,
             t.densidade_original, t.flow_original,
             (SELECT COUNT(*) FROM ajustes a WHERE a.id_traco = tu.id_traco) AS num_ajustes,
             (SELECT valor FROM leituras_resultado lr WHERE lr.id_traco = tu.id_traco
                AND lr.campo = 'densidade' ORDER BY lr.ordem DESC LIMIT 1) AS densidade_remedida,
             (SELECT valor FROM leituras_resultado lr WHERE lr.id_traco = tu.id_traco
                AND lr.campo = 'flow' ORDER BY lr.ordem DESC LIMIT 1) AS flow_remedido
      FROM traco_usos tu
      JOIN operacoes o ON o.id = tu.id_operacao
      JOIN bercos_visuais bv ON bv.id_operacao = tu.id_operacao
      JOIN tracos t ON t.id_traco = tu.id_traco
      WHERE tu.berco_inicio IS NOT NULL AND tu.berco_inicio != ''
        AND tu.berco_finalizacao IS NOT NULL AND tu.berco_finalizacao != ''
      ORDER BY o.data ASC
    `).all();

    return rows.map(r => {
      // Math.min/max: cobre o caso raro de alguém digitar início > fim.
      const ini = Math.min(parseInt(r.berco_inicio, 10), parseInt(r.berco_finalizacao, 10));
      const fim = Math.max(parseInt(r.berco_inicio, 10), parseInt(r.berco_finalizacao, 10));
      const todos = JSON.parse(r.bercos);
      // ini/fim viram NaN se berco_inicio/fim não for numérico (digitação
      // inválida) — b.ordem >= NaN é sempre false, então "doTraco" fica
      // vazio e a linha é descartada no .filter() abaixo, sem lançar erro.
      const doTraco = todos.filter(b => b.ordem >= ini && b.ordem <= fim);
      let total = 0, vazamentos = 0;
      doTraco.forEach(b => {
        total += 2; // 2 lados por berço (esquerda + direita)
        if (b.estado_esquerda === 'baixou') vazamentos++;
        if (b.estado_direita === 'baixou') vazamentos++;
      });
      return {
        id_traco: r.id_traco, id_operacao: r.id_operacao,
        data: r.data, turno: r.turno, id_bateria: r.id_bateria, tipo_montagem: r.tipo_montagem,
        berco_inicio: ini, berco_finalizacao: fim,
        num_ajustes: r.num_ajustes,
        // Final = última remedição (leituras_resultado), se houve alguma;
        // senão o valor original do traço. Mesma regra de "original +
        // ajustes/leituras" usada no resto do sistema (ver rowParaTraco).
        densidade: r.densidade_remedida ?? r.densidade_original ?? null,
        flow: r.flow_remedido ?? r.flow_original ?? null,
        bercos_avaliados: doTraco.length,
        total_lados: total, vazamentos,
        taxa_vazamento: total ? (vazamentos / total) * 100 : null,
      };
    }).filter(r => r.bercos_avaliados > 0);
  }


  /**
   * Detalhe completo de UMA operação — junta tudo que se liga por
   * id_operacao (o elo comum entre histórico, relatório de injeção e
   * berços visuais): a operação em si, os berços visuais (se já tiverem
   * sido registrados), a receita de cada traço usado (com os ajustes que
   * teve, se algum) e a avaliação de qualidade vinculada (se já tiver
   * sido feita). Usado pela "Análise Focada" (ver public/js/
   * analise-focada.js), acessada clicando numa linha do Registro de
   * Baterias com o modo de foco ligado.
   *
   * Devolve null se a operação não existir.
   */
  function detalheOperacao(idOperacao) {
    const operacao = db.prepare('SELECT * FROM operacoes WHERE id = ?').get(idOperacao);
    if (!operacao) return null;

    const bvRow = db.prepare('SELECT bercos FROM bercos_visuais WHERE id_operacao = ?').get(idOperacao);
    const bercosVisuais = bvRow ? JSON.parse(bvRow.bercos) : null;

    // Traços usados nesta operação, cada um com a receita ORIGINAL, os
    // ajustes (se algum) e a densidade/flow FINAIS (última remedição, ou
    // o original se nunca foi remedido — mesma regra usada em
    // rowParaTraco/correlacaoTracoBerco). Ordenado pelo berço inicial —
    // mesma ordem em que os traços foram usados na bateria.
    const usos = db.prepare(`
      SELECT tu.id_traco, tu.berco_inicio, tu.berco_finalizacao, tu.obs,
             t.num_traco, t.cimento_original, t.agua_original, t.eps_original,
             t.superplast_original, t.incorporador_original, t.tempo_batida_original,
             t.densidade_original, t.flow_original, t.silo, t.expansao, t.densidade_eps
      FROM traco_usos tu
      JOIN tracos t ON t.id_traco = tu.id_traco
      WHERE tu.id_operacao = ?
    `).all(idOperacao).sort((a, b) => parseInt(a.berco_inicio, 10) - parseInt(b.berco_inicio, 10));

    const tracos = usos.map(u => {
      const ajustes = db.prepare(
        'SELECT ordem, tempo_batida, cimento, agua, eps, superplast, incorporador, registrado_em FROM ajustes WHERE id_traco = ? ORDER BY ordem ASC'
      ).all(u.id_traco);
      const densidadeRemedida = db.prepare(
        "SELECT valor FROM leituras_resultado WHERE id_traco=? AND campo='densidade' ORDER BY ordem DESC LIMIT 1"
      ).get(u.id_traco);
      const flowRemedido = db.prepare(
        "SELECT valor FROM leituras_resultado WHERE id_traco=? AND campo='flow' ORDER BY ordem DESC LIMIT 1"
      ).get(u.id_traco);
      return {
        id_traco: u.id_traco,
        num_traco: u.num_traco,
        berco_inicio: u.berco_inicio,
        berco_finalizacao: u.berco_finalizacao,
        obs: u.obs,
        original: {
          cimento: u.cimento_original, agua: u.agua_original, eps: u.eps_original,
          superplast: u.superplast_original, incorporador: u.incorporador_original,
          tempo_batida: u.tempo_batida_original,
        },
        densidade: densidadeRemedida ? densidadeRemedida.valor : u.densidade_original,
        flow: flowRemedido ? flowRemedido.valor : u.flow_original,
        silo: u.silo, expansao: u.expansao, densidade_eps: u.densidade_eps,
        ajustes,
        num_ajustes: ajustes.length,
      };
    });

    // Avaliação de qualidade vinculada — se uma bateria (raro, mas
    // possível) tiver mais de uma avaliação registrada pra mesma operação,
    // pega a mais recente. "dados" já traz os painéis embutidos.
    const avRow = db.prepare(
      'SELECT dados FROM avaliacoes_qualidade WHERE id_operacao = ? ORDER BY registrado_em DESC LIMIT 1'
    ).get(idOperacao);
    const avaliacao = avRow ? JSON.parse(avRow.dados) : null;

    return { operacao, bercosVisuais, tracos, avaliacao };
  }

  /**
   * Grava uma avaliação de qualidade JÁ REGISTRADA (definitiva, não
   * rascunho) — 1 linha, com a avaliação inteira (painéis inclusos) em
   * JSON na coluna "dados". Chamada por POST /registrar-avaliacao-qualidade
   * (server.js). INSERT OR REPLACE: se o id já existir (reenvio depois de
   * uma falha de rede, por exemplo), sobrescreve em vez de duplicar ou
   * rejeitar — idempotente, mesmo espírito das outras rotas de baixa
   * fricção do sistema.
   *
   * Grava TAMBÉM em avaliacao_paineis, na mesma transação — mesmos dados,
   * só que extraídos numa tabela própria pra dar pra consultar em SQL
   * direto (ver comentário na CREATE TABLE, acima). "dados" continua
   * sendo a fonte de verdade (é o que o front lê de volta); avaliacao_
   * paineis é só uma cópia derivada, pra consulta — se um dia os dois
   * ficarem inconsistentes por qualquer motivo, dados é quem manda.
   * @param {object} avaliacao - objeto inteiro vindo do front (evalObj + paineis)
   */
  const SQL_SALVAR_AVALIACAO_QUALIDADE = `
    INSERT OR REPLACE INTO avaliacoes_qualidade (id, id_operacao, id_bateria, turno, registrado_em, avaliador_nome, dados)
    VALUES (@id, @id_operacao, @id_bateria, @turno, @registrado_em, @avaliador_nome, @dados)
  `;
  const SQL_SALVAR_PAINEIS_AVALIACAO = `
    INSERT OR REPLACE INTO avaliacao_paineis (id_avaliacao, id_operacao, id_bateria, registrado_em, paineis)
    VALUES (@id_avaliacao, @id_operacao, @id_bateria, @registrado_em, @paineis)
  `;
  // Deixa cada painel só com os campos que interessam pra consulta — evita
  // carregar "avaliacaoId" repetido em cada item (já é a chave da linha
  // toda, ver id_avaliacao) e qualquer campo extra que apareça no futuro
  // sem que aqui saiba o que fazer com ele.
  function _normalizarPaineisParaSql(paineis) {
    return (paineis || []).map(p => ({
      pallet: p.pallet, posicao: p.posicao,
      tipoEsperado: p.tipoEsperado || null, tipoObtido: p.tipoObtido || null,
      resultado: p.resultado || null, linha: p.linha || null,
      marcas: p.marcas || [],
      // Código do motivo do defeito (ver MOTIVOS_DEFEITO, setor-qualidade.js)
      // — só existe (não-null) em painéis 2ª linha ou reprovados.
      motivo: p.motivo || null,
      // Descrição livre — só existe quando motivo === 'OT' ("Outros").
      motivoDescricao: p.motivoDescricao || null,
    }));
  }
  // ── Sequência do Dia (automática) ───────────────────────────────────
  // Era um <select> manual (1 a 13) no front — o avaliador escolhia o
  // número à mão, e errava (repetido, fora de ordem, esquecido). Agora é
  // calculada AQUI, no servidor, na hora de registrar: conta quantas
  // avaliações já existem com registrado_em caindo no mesmo dia em
  // Brasília e soma 1. Fica no servidor (não só no front) pra ser a
  // fonte de verdade única mesmo com duas avaliações registradas quase
  // ao mesmo tempo por operadores diferentes (o front só mostra uma
  // PRÉVIA — ver _calcularProximaSequenciaHoje, setor-qualidade.js).
  //
  // Duplicado de propósito (não importado de server.js) — mesmo
  // raciocínio de todayBrasiliaServer() (server.js) e dataBrasiliaDeISO()
  // (data.js, frontend): cada camada tem sua própria cópia da conversão
  // de fuso, sem import cruzado entre elas. Brasília é sempre UTC-3 (sem
  // horário de verão desde 2019 — mesma premissa já usada em
  // todayBrasiliaServer), então o dia "hoje" (00h-23h59 em Brasília)
  // corresponde, em UTC, ao intervalo [hoje 03:00, amanhã 03:00).
  function _dataBrasiliaDeISO(iso) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso));
  }
  function _limitesDoDiaBrasiliaUTC(diaBrasilia) {
    const inicio = new Date(diaBrasilia + 'T03:00:00.000Z');
    const fim = new Date(inicio.getTime() + 24 * 60 * 60 * 1000);
    return { inicio: inicio.toISOString(), fim: fim.toISOString() };
  }
  // Conta avaliações já registradas no dia (Brasília) de "registradoEm",
  // excluindo a própria avaliação sendo salva agora (importante numa
  // CORREÇÃO — ver chamada abaixo — pra ela não se contar a si mesma).
  const SQL_TOTAL_AVALIACOES_NO_DIA = `
    SELECT COUNT(*) as total FROM avaliacoes_qualidade
    WHERE registrado_em >= @inicio AND registrado_em < @fim AND id != @excluirId
  `;
  function _totalAvaliacoesNoDia(registradoEm, excluirId) {
    const { inicio, fim } = _limitesDoDiaBrasiliaUTC(_dataBrasiliaDeISO(registradoEm));
    const row = db.prepare(SQL_TOTAL_AVALIACOES_NO_DIA).get({ inicio, fim, excluirId: excluirId || '' });
    return row.total;
  }
  function salvarAvaliacaoQualidade(avaliacao) {
    const registradoEm = avaliacao.registeredAt || new Date().toISOString();
    // Só calcula um número NOVO se nenhum já veio no objeto — cobre os 3
    // casos de quem chama esta função:
    //   1. Avaliação NOVA (setor-qualidade.js, registerEvaluation): front
    //      não manda dailySeq → undefined aqui → calcula do zero.
    //   2. CORREÇÃO de avaliação existente: front manda de volta o
    //      dailySeq ORIGINAL (_editandoDailySeq) → preservado, não
    //      recalculado (corrigir um erro de digitação não deveria mudar
    //      a posição da avaliação na sequência do dia em que ela
    //      realmente aconteceu).
    //   3. Restauração de backup (substituirAvaliacoesQualidade, abaixo):
    //      cada avaliação do backup já traz seu dailySeq original
    //      (gravado dentro de "dados" da vez em que foi calculado) →
    //      preservado também, mesmo a tabela tendo sido zerada antes.
    if (avaliacao.dailySeq === undefined || avaliacao.dailySeq === null) {
      avaliacao.dailySeq = _totalAvaliacoesNoDia(registradoEm, avaliacao.id) + 1;
    }
    const params = {
      id: avaliacao.id,
      id_operacao: avaliacao.linkedOperacaoId || null,
      id_bateria: avaliacao.batteryId || null,
      turno: avaliacao.turno || null,
      registrado_em: registradoEm,
      // Ver comentário em avaliacoes_qualidade.avaliador_nome (CREATE
      // TABLE, acima) — nunca obrigatório, fica NULL se não vier.
      avaliador_nome: avaliacao.avaliadorNome || null,
      dados: JSON.stringify(avaliacao),
    };
    const gravarTudo = db.transaction(() => {
      db.prepare(SQL_SALVAR_AVALIACAO_QUALIDADE).run(params);
      db.prepare(SQL_SALVAR_PAINEIS_AVALIACAO).run({
        id_avaliacao: params.id,
        id_operacao: params.id_operacao,
        id_bateria: params.id_bateria,
        registrado_em: params.registrado_em,
        paineis: JSON.stringify(_normalizarPaineisParaSql(avaliacao.paineis)),
      });
    });
    gravarTudo();
  }

  /**
   * Lista os painéis já normalizados (avaliacao_paineis), 1 item por
   * avaliação — usado por futuras telas de análise/cruzamento (mesmo
   * padrão de relatorioBercos()/correlacaoTracoBerco()), sem precisar
   * carregar avaliacoes_qualidade.dados inteiro (que tem também
   * observações, datas de montagem/enchimento/desmoldagem etc. — dados
   * que quem só quer os painéis não precisa processar).
   */
  function listarPaineisAvaliacao() {
    const rows = db.prepare(
      'SELECT id_avaliacao, id_operacao, id_bateria, registrado_em, paineis FROM avaliacao_paineis ORDER BY registrado_em DESC'
    ).all();
    return rows.map(r => ({
      id_avaliacao: r.id_avaliacao,
      id_operacao: r.id_operacao,
      id_bateria: r.id_bateria,
      registrado_em: r.registrado_em,
      paineis: JSON.parse(r.paineis),
    }));
  }

  /**
   * Migração única: preenche avaliacao_paineis a partir de avaliações que
   * já estavam em avaliacoes_qualidade ANTES desta tabela existir — sem
   * isso, só avaliações registradas DAQUI PRA FRENTE apareceriam nela; as
   * já registradas ficariam de fora até alguém reabrir/regravar cada uma
   * manualmente. Roda 1 vez (INSERT OR IGNORE — não sobrescreve linhas que
   * já existirem, então rodar de novo em outra subida do servidor não faz
   * nada além de reconferir).
   */
  function _migrarPaineisAvaliacaoExistentes() {
    const jaExistem = new Set(
      db.prepare('SELECT id_avaliacao FROM avaliacao_paineis').all().map(r => r.id_avaliacao)
    );
    const pendentes = db.prepare('SELECT id, id_operacao, id_bateria, registrado_em, dados FROM avaliacoes_qualidade').all()
      .filter(r => !jaExistem.has(r.id));
    if (!pendentes.length) return;

    const migrarTudo = db.transaction((linhas) => {
      const inserir = db.prepare(SQL_SALVAR_PAINEIS_AVALIACAO);
      for (const r of linhas) {
        let avaliacao;
        try { avaliacao = JSON.parse(r.dados); } catch (e) { continue; } // linha corrompida — pula, não trava a migração inteira
        inserir.run({
          id_avaliacao: r.id,
          id_operacao: r.id_operacao,
          id_bateria: r.id_bateria,
          registrado_em: r.registrado_em,
          paineis: JSON.stringify(_normalizarPaineisParaSql(avaliacao.paineis)),
        });
      }
    });
    migrarTudo(pendentes);
    console.log(`[avaliacao_paineis] Migração: ${pendentes.length} avaliação(ões) já registrada(s) antes desta tabela existir foram preenchidas agora.`);
  }
  _migrarPaineisAvaliacaoExistentes();

  /**
   * Mesmo cálculo de _montagemDoRegistro (setor-qualidade.js, frontend) —
   * duplicado aqui de propósito, pra rodar como migração server-side sem
   * depender de JS de front-end. Junta tipos DIFERENTES no mesmo palete com
   * "/" (ex: "3T/5T"), em vez de mostrar só um ou nenhum.
   */
  function _montagemDeAvaliacaoPaineis(paineis) {
    const montagem = {};
    for (let n = 1; n <= 4; n++) {
      const tipos = [];
      (paineis || []).filter(p => p.pallet === n).forEach(p => {
        const t = (p.tipoEsperado || '').toString().toUpperCase();
        if (t && !tipos.includes(t)) tipos.push(t);
      });
      montagem[`pallet${n}`] = tipos.join('/');
    }
    return montagem;
  }

  /**
   * Migração única: recalcula avaliacao.montagem (o que aparece nas colunas
   * Pallet 1..4 da tela "Registros", Setor de Qualidade) a partir dos
   * painéis DE VERDADE de cada avaliação já registrada — sem isso, um
   * registro salvo ANTES da correção que passou a calcular isso no ato do
   * registro (ver conversa que motivou: "Registros" mostrando só "—" pra
   * qualquer tipo de montagem em modo Personalizada) continuaria mostrando
   * "—" pra sempre, mesmo depois da correção valer pra registros novos.
   * Só REESCREVE quando o valor calculado é diferente do que já estava
   * salvo — idempotente, roda de novo em toda subida do servidor sem custo
   * real (registro já corrigido não muda de novo).
   */
  function _migrarMontagemDasAvaliacoesExistentes() {
    const rows = db.prepare('SELECT id, dados FROM avaliacoes_qualidade').all();
    const atualizarUma = db.prepare('UPDATE avaliacoes_qualidade SET dados = @dados WHERE id = @id');
    let atualizadas = 0;
    const migrarTudo = db.transaction(() => {
      for (const r of rows) {
        let avaliacao;
        try { avaliacao = JSON.parse(r.dados); } catch (e) { continue; } // linha corrompida — pula, não trava a migração inteira
        if (!Array.isArray(avaliacao.paineis) || !avaliacao.paineis.length) continue;
        const montagemCalculada = _montagemDeAvaliacaoPaineis(avaliacao.paineis);
        const montagemAtual = avaliacao.montagem || {};
        const mudou = [1, 2, 3, 4].some(n => (montagemAtual[`pallet${n}`] || '') !== (montagemCalculada[`pallet${n}`] || ''));
        if (!mudou) continue;
        avaliacao.montagem = montagemCalculada;
        atualizarUma.run({ id: r.id, dados: JSON.stringify(avaliacao) });
        atualizadas++;
      }
    });
    migrarTudo();
    if (atualizadas) {
      console.log(`[avaliacoes_qualidade] Migração: recalculado o tipo de montagem (montagem.palletN) de ${atualizadas} avaliação(ões) já registrada(s), a partir dos painéis de verdade.`);
    }
  }
  _migrarMontagemDasAvaliacoesExistentes();

  /**
   * Lista todas as avaliações de qualidade já registradas, mais recentes
   * primeiro — cada item já vem desserializado (JSON.parse de "dados"),
   * pronto pro front usar direto, painéis inclusos. Usado por GET
   * /avaliacoes-qualidade (Dashboard e Registros do Setor de Qualidade).
   */
  function listarAvaliacoesQualidade() {
    const rows = db.prepare(
      'SELECT avaliador_nome, dados FROM avaliacoes_qualidade ORDER BY registrado_em DESC'
    ).all();
    return rows.map(r => {
      const avaliacao = JSON.parse(r.dados);
      // Coluna SQL prevalece sobre o que estiver dentro do JSON — cobre o
      // caso de uma avaliação salva ANTES da coluna avaliador_nome existir
      // (nesse caso, r.avaliador_nome é null, então avaliacao.avaliadorNome,
      // se já tiver algo, continua valendo).
      if (r.avaliador_nome) avaliacao.avaliadorNome = r.avaliador_nome;
      return avaliacao;
    });
  }
  /**
   * Substitui TODO o conteúdo de avaliacoes_qualidade pelo array informado
   * (mesmo formato de listarAvaliacoesQualidade — cada item é a avaliação
   * inteira, painéis inclusos) — usado por /restaurar-backup-dados, mesmo
   * padrão "apaga tudo e reinsere" das outras tabelas. Quem chama é
   * responsável por envolver numa db.transaction().
   */
  function substituirAvaliacoesQualidade(lista) {
    db.prepare('DELETE FROM avaliacoes_qualidade').run();
    // avaliacao_paineis não é apagada em cascata automaticamente (SQLite
    // só reforça FK se PRAGMA foreign_keys estiver ligado, e mesmo assim
    // isso é REFERENCES, não "ON DELETE CASCADE") — sem esta linha, uma
    // restauração com MENOS avaliações do que existia antes deixaria
    // painéis órfãos de avaliações que não voltaram no backup.
    db.prepare('DELETE FROM avaliacao_paineis').run();
    for (const avaliacao of (lista || [])) {
      salvarAvaliacaoQualidade(avaliacao); // já grava nas 2 tabelas, ver acima
    }
    // Roda a migração de montagem (ver _migrarMontagemDasAvaliacoesExistentes,
    // acima) IMEDIATAMENTE após restaurar — sem isso, um backup ANTIGO
    // (com registros salvos antes da correção que calcula montagem a
    // partir dos painéis) só ficaria corrigido no PRÓXIMO reinício do
    // servidor, deixando "Registros" mostrando "—" logo depois de uma
    // restauração, até alguém reiniciar por outro motivo.
    _migrarMontagemDasAvaliacoesExistentes();
  }

  /**
   * Marca uma operação como avaliada — INSERT (idempotente) em
   * "operacoes_avaliadas", nunca mais um UPDATE na própria linha de
   * "operacoes" (ver comentário na CREATE TABLE, acima). Usada por
   * POST /marcar-operacao-avaliada (server.js) quando a avaliação vem
   * vinculada a uma operação da fila (linkedOperacaoId presente).
   *
   * FK (operacoes_avaliadas.id_operacao REFERENCES operacoes(id), com
   * PRAGMA foreign_keys=ON) faz o SQLite recusar silenciosamente um id que
   * não exista em "operacoes" — por isso quem chama (a rota) confere a
   * existência ANTES de chamar esta função, se precisar de um erro
   * explícito pro front (ver server.js).
   *
   * @param {string} idOperacao
   * @returns {boolean} true se inseriu (1ª vez); false se já estava
   *   marcada (chamada repetida, idempotente) ou se o id não existe.
   */
  function marcarOperacaoAvaliada(idOperacao) {
    if (!idOperacao) return false;
    const info = db.prepare(
      'INSERT OR IGNORE INTO operacoes_avaliadas (id_operacao) VALUES (?)'
    ).run(idOperacao);
    return info.changes > 0;
  }

  /**
   * Desfaz COMPLETAMENTE a avaliação de qualidade de uma operação — usada
   * por POST /admin/sql-excluir-linha (Configurações → Dados SQL) quando a
   * linha excluída é de "operacoes_avaliadas": em vez de só tirar a
   * operação da lista de avaliadas (o que deixaria avaliacoes_qualidade e
   * avaliacao_paineis "órfãs" — a avaliação continuaria existindo, só que
   * de uma operação que voltou a aparecer como pendente), remove os 3
   * rastros da avaliação de uma vez, numa transação só:
   *
   *   1) avaliacao_paineis   (referencia avaliacoes_qualidade via FK — por
   *                            isso sai PRIMEIRO, senão o DELETE de
   *                            avaliacoes_qualidade seria bloqueado)
   *   2) avaliacoes_qualidade (a avaliação em si, com o JSON completo)
   *   3) operacoes_avaliadas  (a marcação "esta operação já foi avaliada")
   *
   * Depois disso, a operação passa a aparecer de novo em
   * GET /operacoes-nao-avaliadas (a fila do Setor de Qualidade) — não por
   * nenhuma ação extra aqui, mas porque essa fila já é definida como "toda
   * operação cujo id NÃO esteja em operacoes_avaliadas" (ver comentário na
   * CREATE TABLE operacoes_avaliadas, acima).
   *
   * @returns {{avaliacaoPaineis:number, avaliacoesQualidade:number, operacoesAvaliadas:number}}
   *   nº de linhas removidas em cada tabela (todos 0 se o id_operacao não
   *   tinha avaliação nenhuma).
   */
  function desfazerAvaliacaoOperacao(idOperacao) {
    const excluirTudo = db.transaction(() => {
      const r1 = db.prepare('DELETE FROM avaliacao_paineis WHERE id_operacao = ?').run(idOperacao);
      const r2 = db.prepare('DELETE FROM avaliacoes_qualidade WHERE id_operacao = ?').run(idOperacao);
      const r3 = db.prepare('DELETE FROM operacoes_avaliadas WHERE id_operacao = ?').run(idOperacao);
      return {
        avaliacaoPaineis: r1.changes,
        avaliacoesQualidade: r2.changes,
        operacoesAvaliadas: r3.changes,
      };
    });
    return excluirTudo();
  }

  /**
   * Marca como avaliada a operação PENDENTE mais antiga de uma bateria —
   * usada quando uma avaliação de qualidade é registrada SEM vir vinculada
   * a uma operação da fila (linkedOperacaoId ausente, ver
   * /registrar-avaliacao-qualidade, server.js).
   *
   * Por quê isso existe: uma avaliação AVULSA (o operador digita/seleciona
   * só o ID da bateria, sem escolher da fila) não tinha como marcar
   * nenhuma operação como avaliada — a operação real daquela bateria, se
   * houvesse alguma pendente, ficava "não avaliada" pra sempre, mesmo já
   * avaliada de verdade. Isso classificava a bateria errado (continuava
   * aparecendo na fila do Setor de Qualidade, sujeita a ser avaliada de
   * novo) e podia gerar avaliação duplicada pra mesma operação.
   *
   * Mesmo critério FIFO de GET /operacoes-nao-avaliadas (mais antiga
   * primeiro: "data ASC, fim ASC") — se a bateria tiver mais de uma
   * operação pendente, marca só a mais antiga (a que, na prática, é a
   * próxima da fila) e nunca mexe numa avaliação que já veio vinculada
   * (essa continua só pelo marcarOperacaoAvaliada explícito, acima,
   * chamado pelo front com o id_operacao exato).
   *
   * Nunca considera operações de Modo de Teste (modo_teste=0) — mesmo
   * motivo de /operacoes-nao-avaliadas: o Setor de Qualidade não tem
   * noção de Modo de Teste.
   *
   * BUG CORRIGIDO: esta função só tirava a operação da FILA (INSERT em
   * "operacoes_avaliadas"), mas nunca vinculava a própria avaliação
   * avulsa a essa operação (avaliacoes_qualidade.id_operacao continuava
   * NULL). Resultado: a bateria sumia da fila (parecia "avaliada"), mas
   * a Análise Focada — que busca a avaliação estritamente por
   * id_operacao (ver db.detalheOperacao) — nunca encontrava nada pra
   * essa operação, mesmo a avaliação certa já existindo. Agora, quando
   * o FIFO identifica qual operação pendente é essa (`pendente.id`),
   * também retro-vincula a avaliação avulsa a ela (ver
   * _vincularAvaliacaoAOperacao), na mesma transação.
   *
   * @param {string} idBateria
   * @param {string} [idAvaliacao] - id da avaliação avulsa que disparou
   *   esta chamada (ver POST /registrar-avaliacao-qualidade, server.js) —
   *   usado só pra retro-vincular essa avaliação à operação encontrada.
   *   Sem isso (chamada legada, sem o 2º argumento), o comportamento
   *   volta a ser só o antigo (tira da fila, sem vincular).
   * @returns {string|false} o id da operação marcada, ou false se não havia
   *   nenhuma pendente pra essa bateria. Quem chama (server.js) usa esse id
   *   pra também tirar a operação da fila em arquivo (ver
   *   removerDaFilaNaoAvaliadas, server.js) — CONTINUA truthy como antes
   *   (era `true`), então nenhuma chamada existente que só faz `if (...)`
   *   com o retorno precisa mudar.
   */
  function marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada(idBateria, idAvaliacao) {
    if (!idBateria) return false;
    const pendente = db.prepare(`
      SELECT id FROM operacoes
      WHERE id_bateria = ? AND modo_teste = 0
        AND id NOT IN (SELECT id_operacao FROM operacoes_avaliadas)
      ORDER BY data ASC, fim ASC
      LIMIT 1
    `).get(idBateria);
    if (!pendente) return false;

    const executar = db.transaction(() => {
      marcarOperacaoAvaliada(pendente.id);
      if (idAvaliacao) _vincularAvaliacaoAOperacao(idAvaliacao, pendente.id);
    });
    executar();
    return pendente.id;
  }

  /**
   * Vincula, DEPOIS de já registrada, uma avaliação de qualidade a uma
   * operação — usado só por marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada
   * (acima), pra fechar a lacuna de uma avaliação AVULSA cuja operação
   * correspondente só é descoberta depois (pelo FIFO de bateria), não no
   * momento do registro.
   *
   * Atualiza id_operacao em avaliacoes_qualidade E avaliacao_paineis
   * (mesma coluna nas duas tabelas — ver CREATE TABLE), e também
   * "linkedOperacaoId" DENTRO do JSON "dados" — "dados" é quem o front
   * lê de volta (ver listarAvaliacoesQualidade/editarAvaliacaoDoEspelho),
   * então precisa continuar consistente com a coluna, senão a avaliação
   * passaria a ser encontrada pela Análise Focada mas ainda apareceria
   * como "avulsa" (sem vínculo) em qualquer tela que leia o JSON direto.
   */
  function _vincularAvaliacaoAOperacao(idAvaliacao, idOperacao) {
    const row = db.prepare('SELECT dados FROM avaliacoes_qualidade WHERE id = ?').get(idAvaliacao);
    if (!row) return; // avaliação não existe (não deveria acontecer, mas não quebra a marcação da fila por causa disso)
    const dados = JSON.parse(row.dados);
    if (dados.linkedOperacaoId === idOperacao) return; // já vinculada a esta mesma operação — nada a fazer
    dados.linkedOperacaoId = idOperacao;
    db.prepare('UPDATE avaliacoes_qualidade SET id_operacao = ?, dados = ? WHERE id = ?')
      .run(idOperacao, JSON.stringify(dados), idAvaliacao);
    db.prepare('UPDATE avaliacao_paineis SET id_operacao = ? WHERE id_avaliacao = ?')
      .run(idOperacao, idAvaliacao);
  }

  /**
   * Lista todo o conteúdo de "operacoes_avaliadas" — usado por GET
   * /db/operacoes_avaliadas.json (Backup de Dados) e pelo backup automático
   * do servidor (gerarZipDadosServidor, server.js). Formato simples:
   * [{ id_operacao, avaliado_em }, ...].
   */
  function todosOsOperacoesAvaliadas() {
    return db.prepare('SELECT id_operacao, avaliado_em FROM operacoes_avaliadas ORDER BY avaliado_em ASC').all();
  }

  /**
   * Substitui TODO o conteúdo de "operacoes_avaliadas" pelo array informado
   * — usado por /restaurar-backup-dados, mesmo padrão "apaga tudo e
   * reinsere" das outras tabelas (ver substituirBercosVisuais/
   * substituirAvaliacoesQualidade). Quem chama é responsável por já ter
   * limpado esta tabela ANTES de mexer em "operacoes" (ver comentário em
   * /restaurar-backup-dados, server.js, sobre a ordem por causa da FK) —
   * aqui só limpa de novo (idempotente, não custa nada) e reinsere.
   */
  function substituirOperacoesAvaliadas(lista) {
    const inserir = db.prepare('INSERT OR IGNORE INTO operacoes_avaliadas (id_operacao, avaliado_em) VALUES (?, ?)');
    db.prepare('DELETE FROM operacoes_avaliadas').run();
    for (const item of (lista || [])) {
      if (item && item.id_operacao) inserir.run(item.id_operacao, item.avaliado_em || new Date().toISOString());
    }
  }



  return {
    criarBercosVisuaisIniciais,
    operacaoParaRow,
    rowParaOperacao,
    SQL_INSERIR_OPERACAO,
    todosOsBercosVisuais,
    substituirBercosVisuais,
    bercosVisuaisPorOperacoes,
    relatorioBercos,
    correlacaoTracoBerco,
    detalheOperacao,
    salvarAvaliacaoQualidade,
    listarAvaliacoesQualidade,
    listarPaineisAvaliacao,
    substituirAvaliacoesQualidade,
    marcarOperacaoAvaliada,
    marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada,
    desfazerAvaliacaoOperacao,
    todosOsOperacoesAvaliadas,
    substituirOperacoesAvaliadas,
  };
};
