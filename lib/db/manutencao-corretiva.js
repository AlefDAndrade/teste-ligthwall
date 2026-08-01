// ─── lib/db/manutencao-corretiva.js — Fase 3 do fatiamento de db.js ────────
// Extraído de db.js (ver "Fatiamento de db.js (plano)" no README) seguindo
// o mesmo padrão usado em lib/rotas/: uma factory que recebe só a
// dependência que este domínio usa — aqui, a conexão já aberta do
// better-sqlite3 (não abre a própria; só existe uma conexão no processo
// inteiro, ver README) — e devolve as funções do domínio "Manutenção
// Corretiva". Nenhuma lógica mudou nesta fase, só onde o código mora: o
// schema (CREATE TABLE manutencao_corretiva) continua em db.js (Fase 1 —
// infraestrutura, sem lógica de domínio).
//
// Consumido por lib/rotas/manutencao.js (listar/obter/salvar/aceitar/
// recusar/excluir chamado) e por lib/rotas/backup.js (substituir, na
// restauração de backup) através de db.js, que re-exporta estas funções
// penduradas no objeto de conexão — nenhum consumidor precisa mudar
// (`db.aceitarManutencaoCorretiva(...)` etc. continuam funcionando iguais).
module.exports = function criarManutencaoCorretiva(db) {

  // ─── Manutenção Corretiva ──────────────────────────────────────────────
  
  function _rowParaManutencaoCorretiva(row) {
    return {
      id: row.id,
      data: row.data,
      setor: row.setor,
      maquina: row.maquina,
      turno: row.turno,
      observador: row.observador,
      prioridade: row.prioridade,
      anomalia: row.anomalia,
      local: row.local,
      tipos: row.tipos ? JSON.parse(row.tipos) : [],
      tipoManutencao: row.tipo_manutencao,
      tipoEtiqueta: row.tipo_etiqueta,
      tipoExecucao: row.tipo_execucao,
      empresaExterna: row.empresa_externa,
      responsavel: row.responsavel,
      fotoOperador: row.foto_operador,
      fotoTecnico: row.foto_tecnico,
      dataInicio: row.data_inicio,
      horaInicio: row.hora_inicio,
      dataFim: row.data_fim,
      horaFim: row.hora_fim,
      tempoGasto: row.tempo_gasto,
      situacao: row.situacao,
      emManutencao: row.em_manutencao,
      aguardandoPecas: row.aguardando_pecas,
      pecasAvariadas: row.pecas_avariadas,
      pecasComprar: row.pecas_comprar,
      rotina: row.rotina,
      supDataInicio: row.sup_data_inicio,
      supHoraInicio: row.sup_hora_inicio,
      supDataFim: row.sup_data_fim,
      supHoraFim: row.sup_hora_fim,
      supTempoGasto: row.sup_tempo_gasto,
      statusCompra: row.status_compra,
      previsaoChegada: row.previsao_chegada,
      fornecedor: row.fornecedor,
      respSupervisor: row.resp_supervisor,
      obsSupervisor: row.obs_supervisor,
      custoPecas: row.custo_pecas,
      custoMaoObra: row.custo_mao_obra,
      etiquetaFechada: !!row.etiqueta_fechada,
      aceito: row.aceito || 'Nao',
      aceitoPor: row.aceito_por,
      aceitoEm: row.aceito_em,
      pedidoPecaAceito: row.pedido_peca_aceito || 'Nao',
      pedidoPecaAceitoPor: row.pedido_peca_aceito_por,
      pedidoPecaAceitoEm: row.pedido_peca_aceito_em,
      recebimentoPecaConfirmado: row.recebimento_peca_confirmado || 'Nao',
      recebimentoPecaConfirmadoPor: row.recebimento_peca_confirmado_por,
      recebimentoPecaConfirmadoEm: row.recebimento_peca_confirmado_em,
      recusaPendente: row.recusa_pendente || 'Nao',
      recusaMotivo: row.recusa_motivo,
      recusaSolicitadoPor: row.recusa_solicitado_por,
      recusaSolicitadoEm: row.recusa_solicitado_em,
      recusaResultado: row.recusa_resultado,
      recusaRevisadoPor: row.recusa_revisado_por,
      recusaRevisadoEm: row.recusa_revisado_em,
      visualizadoPor: row.visualizado_por,
      visualizadoEm: row.visualizado_em,
      autorNome: row.autor_nome,
      dataCriacao: row.data_criacao,
      dataModificacao: row.data_modificacao,
    };
  }
  
  const SQL_UPSERT_MANUTENCAO_CORRETIVA = `
    INSERT INTO manutencao_corretiva (
      id, data, setor, maquina, turno, observador, prioridade, anomalia, local,
      tipos, tipo_manutencao, tipo_etiqueta, tipo_execucao, empresa_externa,
      responsavel, foto_operador, foto_tecnico, data_inicio, hora_inicio,
      data_fim, hora_fim, tempo_gasto, situacao, em_manutencao,
      aguardando_pecas, pecas_avariadas, pecas_comprar, rotina,
      sup_data_inicio, sup_hora_inicio, sup_data_fim, sup_hora_fim,
      sup_tempo_gasto, status_compra, previsao_chegada, fornecedor,
      resp_supervisor, obs_supervisor, custo_pecas, custo_mao_obra,
      etiqueta_fechada, aceito, aceito_por, aceito_em,
      pedido_peca_aceito, pedido_peca_aceito_por, pedido_peca_aceito_em,
      recebimento_peca_confirmado, recebimento_peca_confirmado_por, recebimento_peca_confirmado_em,
      recusa_pendente, recusa_motivo, recusa_solicitado_por, recusa_solicitado_em,
      recusa_resultado, recusa_revisado_por, recusa_revisado_em,
      visualizado_por, visualizado_em,
      autor_nome, data_criacao, data_modificacao
    ) VALUES (
      @id, @data, @setor, @maquina, @turno, @observador, @prioridade, @anomalia, @local,
      @tipos, @tipo_manutencao, @tipo_etiqueta, @tipo_execucao, @empresa_externa,
      @responsavel, @foto_operador, @foto_tecnico, @data_inicio, @hora_inicio,
      @data_fim, @hora_fim, @tempo_gasto, @situacao, @em_manutencao,
      @aguardando_pecas, @pecas_avariadas, @pecas_comprar, @rotina,
      @sup_data_inicio, @sup_hora_inicio, @sup_data_fim, @sup_hora_fim,
      @sup_tempo_gasto, @status_compra, @previsao_chegada, @fornecedor,
      @resp_supervisor, @obs_supervisor, @custo_pecas, @custo_mao_obra,
      @etiqueta_fechada, @aceito, @aceito_por, @aceito_em,
      @pedido_peca_aceito, @pedido_peca_aceito_por, @pedido_peca_aceito_em,
      @recebimento_peca_confirmado, @recebimento_peca_confirmado_por, @recebimento_peca_confirmado_em,
      @recusa_pendente, @recusa_motivo, @recusa_solicitado_por, @recusa_solicitado_em,
      @recusa_resultado, @recusa_revisado_por, @recusa_revisado_em,
      @visualizado_por, @visualizado_em,
      @autor_nome, @data_criacao, @data_modificacao
    )
    ON CONFLICT(id) DO UPDATE SET
      data=@data, setor=@setor, maquina=@maquina, turno=@turno, observador=@observador,
      prioridade=@prioridade, anomalia=@anomalia, local=@local, tipos=@tipos,
      tipo_manutencao=@tipo_manutencao, tipo_etiqueta=@tipo_etiqueta, tipo_execucao=@tipo_execucao,
      empresa_externa=@empresa_externa, responsavel=@responsavel, foto_operador=@foto_operador,
      foto_tecnico=@foto_tecnico, data_inicio=@data_inicio, hora_inicio=@hora_inicio,
      data_fim=@data_fim, hora_fim=@hora_fim, tempo_gasto=@tempo_gasto, situacao=@situacao,
      em_manutencao=@em_manutencao, aguardando_pecas=@aguardando_pecas,
      pecas_avariadas=@pecas_avariadas, pecas_comprar=@pecas_comprar, rotina=@rotina,
      sup_data_inicio=@sup_data_inicio, sup_hora_inicio=@sup_hora_inicio,
      sup_data_fim=@sup_data_fim, sup_hora_fim=@sup_hora_fim, sup_tempo_gasto=@sup_tempo_gasto,
      status_compra=@status_compra, previsao_chegada=@previsao_chegada, fornecedor=@fornecedor,
      resp_supervisor=@resp_supervisor, obs_supervisor=@obs_supervisor, custo_pecas=@custo_pecas,
      custo_mao_obra=@custo_mao_obra, etiqueta_fechada=@etiqueta_fechada,
      aceito=@aceito, aceito_por=@aceito_por, aceito_em=@aceito_em,
      pedido_peca_aceito=@pedido_peca_aceito, pedido_peca_aceito_por=@pedido_peca_aceito_por,
      pedido_peca_aceito_em=@pedido_peca_aceito_em,
      recebimento_peca_confirmado=@recebimento_peca_confirmado,
      recebimento_peca_confirmado_por=@recebimento_peca_confirmado_por,
      recebimento_peca_confirmado_em=@recebimento_peca_confirmado_em,
      recusa_pendente=@recusa_pendente, recusa_motivo=@recusa_motivo,
      recusa_solicitado_por=@recusa_solicitado_por, recusa_solicitado_em=@recusa_solicitado_em,
      recusa_resultado=@recusa_resultado, recusa_revisado_por=@recusa_revisado_por,
      recusa_revisado_em=@recusa_revisado_em,
      visualizado_por=@visualizado_por, visualizado_em=@visualizado_em,
      autor_nome=@autor_nome, data_modificacao=@data_modificacao
  `;
  
  function listarManutencaoCorretiva() {
    // ROWID DESC como desempate (id TEXT PRIMARY KEY não desliga o rowid
    // implícito do SQLite — ver CREATE TABLE em db.js) — garante "mais
    // recente primeiro" mesmo se dois chamados caírem no mesmíssimo
    // data_criacao (timestamp idêntico ao milissegundo).
    const rows = db.prepare('SELECT * FROM manutencao_corretiva ORDER BY data_criacao DESC, ROWID DESC').all();
    return rows.map(_rowParaManutencaoCorretiva);
  }
  
  /** Busca 1 chamado por id — usado pelas rotas de aceite (ver
   * lib/rotas/manutencao.js), que precisam checar o estado atual (aceito,
   * aguardandoPecas etc.) antes de decidir se a ação é válida. */
  function obterManutencaoCorretiva(id) {
    const row = db.prepare('SELECT * FROM manutencao_corretiva WHERE id = ?').get(id);
    return row ? _rowParaManutencaoCorretiva(row) : null;
  }
  
  /**
   * Marca um chamado como aceito — libera os campos de Execução (Seção 3)
   * no front (ver aceitarChamado(), manutencao.js). Só mexe nas 3 colunas
   * de aceite; nunca chamada a partir do upsert geral (ver comentário na
   * CREATE TABLE, acima, e em salvarManutencaoCorretiva, abaixo).
   * Idempotente: chamar de novo depois de já aceito só atualiza
   * data_modificacao, não troca quem/quando aceitou primeiro.
   */
  function aceitarManutencaoCorretiva(id, nomeQuemAceitou) {
    const agora = new Date().toISOString();
    db.prepare(`
      UPDATE manutencao_corretiva
      SET aceito = 'Sim', aceito_por = @nome, aceito_em = @agora, data_modificacao = @agora
      WHERE id = @id AND aceito != 'Sim'
    `).run({ id, nome: nomeQuemAceitou, agora });
  }
  
  /**
   * Marca o PEDIDO DE PEÇA de um chamado como aceito — libera os campos de
   * Acompanhamento da Supervisão (Seção 4). Mesmo raciocínio de
   * aceitarManutencaoCorretiva(), acima, só que pra esse 2º portão.
   */
  function aceitarPedidoPecaManutencaoCorretiva(id, nomeQuemAceitou) {
    const agora = new Date().toISOString();
    db.prepare(`
      UPDATE manutencao_corretiva
      SET pedido_peca_aceito = 'Sim', pedido_peca_aceito_por = @nome, pedido_peca_aceito_em = @agora, data_modificacao = @agora
      WHERE id = @id AND pedido_peca_aceito != 'Sim'
    `).run({ id, nome: nomeQuemAceitou, agora });
  }
  
  /**
   * Marca a PEÇA como CONFIRMADA (recebida de verdade nas mãos da
   * Manutenção) — libera de novo os campos de Execução (Seção 3), que
   * ficam bloqueados desde que "Status da Compra" virou 'Peça recebida'
   * até essa confirmação (ver conversa que motivou isso). Mesmo raciocínio
   * de aceitarManutencaoCorretiva()/aceitarPedidoPecaManutencaoCorretiva(),
   * acima, só que pra esse 3º portão do fluxo de peça.
   */
  function confirmarRecebimentoPecaManutencaoCorretiva(id, nomeQuemConfirmou) {
    const agora = new Date().toISOString();
    db.prepare(`
      UPDATE manutencao_corretiva
      SET recebimento_peca_confirmado = 'Sim', recebimento_peca_confirmado_por = @nome,
          recebimento_peca_confirmado_em = @agora, data_modificacao = @agora
      WHERE id = @id AND recebimento_peca_confirmado != 'Sim'
    `).run({ id, nome: nomeQuemConfirmou, agora });
  }
  
  /**
   * Registra um PEDIDO DE RECUSA do chamado — em vez de aceitar, a
   * Manutenção (ou Admin/Supervisão/Encarregado) explica por que o chamado
   * deveria ser recusado. Fica pendente de revisão por Admin/Supervisão/
   * Encarregado (ver responderRecusaManutencaoCorretiva, abaixo). Só mexe
   * nas colunas de recusa; nunca chamada a partir do upsert geral.
   */
  function solicitarRecusaManutencaoCorretiva(id, motivo, nomeSolicitante) {
    const agora = new Date().toISOString();
    db.prepare(`
      UPDATE manutencao_corretiva
      SET recusa_pendente = 'Sim', recusa_motivo = @motivo,
          recusa_solicitado_por = @nome, recusa_solicitado_em = @agora,
          recusa_resultado = NULL, recusa_revisado_por = NULL, recusa_revisado_em = NULL,
          data_modificacao = @agora
      WHERE id = @id
    `).run({ id, motivo, nome: nomeSolicitante, agora });
  }
  
  /**
   * Revisa um pedido de recusa pendente — só Admin/Supervisão/Encarregado
   * (ver podeAceitarPedidoPeca, server.js, reaproveitada pra esse portão
   * também: mesmo grupo de 3). Dois caminhos:
   *  - aceitaRecusa=true: a recusa É ACEITA, o chamado é ENCERRADO
   *    (etiqueta_fechada=1, situacao='Recusado') — mesmo "fica trancado"
   *    de sempre pra chamado fechado (ver aoMudarSituacao()/editarManutencao,
   *    manutencao.js).
   *  - aceitaRecusa=false: a recusa é NEGADA — descartada
   *    (recusa_pendente volta pra 'Nao'), chamado continua aberto e ainda
   *    não aceito, esperando a Manutenção aceitar e dar prosseguimento de
   *    verdade (pedido do usuário).
   */
  function responderRecusaManutencaoCorretiva(id, aceitaRecusa, nomeRevisor) {
    const agora = new Date().toISOString();
    if (aceitaRecusa) {
      db.prepare(`
        UPDATE manutencao_corretiva
        SET recusa_pendente = 'Nao', recusa_resultado = 'Aceita',
            recusa_revisado_por = @nome, recusa_revisado_em = @agora,
            etiqueta_fechada = 1, situacao = 'Recusado', data_modificacao = @agora
        WHERE id = @id
      `).run({ id, nome: nomeRevisor, agora });
    } else {
      db.prepare(`
        UPDATE manutencao_corretiva
        SET recusa_pendente = 'Nao', recusa_resultado = 'Negada',
            recusa_revisado_por = @nome, recusa_revisado_em = @agora,
            data_modificacao = @agora
        WHERE id = @id
      `).run({ id, nome: nomeRevisor, agora });
    }
  }
  
  /**
   * Marca a 1ª visualização do chamado (ver abrirHistorico(),
   * manutencao.js) — vira um ponto na trajetória visual. Idempotente: só
   * grava na 1ª vez (WHERE visualizado_por IS NULL); visualizações
   * seguintes, de qualquer pessoa, não sobrescrevem quem viu primeiro.
   */
  function marcarVisualizadoManutencaoCorretiva(id, nomeOuAdmin) {
    const agora = new Date().toISOString();
    db.prepare(`
      UPDATE manutencao_corretiva
      SET visualizado_por = @nome, visualizado_em = @agora, data_modificacao = @agora
      WHERE id = @id AND visualizado_por IS NULL
    `).run({ id, nome: nomeOuAdmin, agora });
  }
  
  /**
   * Salva (cria ou atualiza) um chamado corretivo. IMPORTANTE: os campos de
   * aceite (aceito e pedido_peca_aceito, com seus "_por" e "_em"), o de
   * confirmação de recebimento de peça (recebimento_peca_confirmado, com
   * seus "_por" e "_em") e os de recusa (recusa_pendente, recusa_motivo, os
   * campos "recusa_solicitado_" e "recusa_revisado_", e recusa_resultado),
   * além de "visualizado_por"/"visualizado_em", NUNCA são lidos do
   * parâmetro `m` — ver comentário na CREATE TABLE, acima. Essa função
   * sempre preserva o que já estava salvo no banco (busca o registro atual
   * antes de gravar); só as rotas dedicadas (aceitarManutencaoCorretiva(),
   * aceitarPedidoPecaManutencaoCorretiva(),
   * confirmarRecebimentoPecaManutencaoCorretiva(),
   * solicitarRecusaManutencaoCorretiva(),
   * responderRecusaManutencaoCorretiva() — todas acima) podem mudar esses
   * valores. Isso impede que qualquer perfil "aceite"/"recuse"/"confirme"
   * um chamado só por mandar esses campos no payload do upsert geral — tem
   * que passar pela rota de verdade, que confere a permissão e grava
   * quem/quando agiu.
   *
   * Exceção: se "aguardandoPecas" deixar de ser 'Sim' nesta gravação, o
   * aceite do pedido de peça E a confirmação de recebimento são resetados
   * pra 'Nao' — não faz sentido ficar "aceito"/"confirmado" um pedido que
   * não existe mais (ex: técnico desmarcou por engano, ou resolveu sem
   * precisar de peça); um pedido futuro começa limpo, exigindo os 2
   * portões de novo.
   */
  function salvarManutencaoCorretiva(m) {
    const agora = new Date().toISOString();
    const existente = db.prepare(`
      SELECT aceito, aceito_por, aceito_em, pedido_peca_aceito, pedido_peca_aceito_por, pedido_peca_aceito_em,
             recebimento_peca_confirmado, recebimento_peca_confirmado_por, recebimento_peca_confirmado_em,
             recusa_pendente, recusa_motivo, recusa_solicitado_por, recusa_solicitado_em,
             recusa_resultado, recusa_revisado_por, recusa_revisado_em,
             visualizado_por, visualizado_em
      FROM manutencao_corretiva WHERE id = ?
    `).get(m.id);
    const aguardandoPecas = m.aguardandoPecas || 'Nao';
    const aceito = existente ? existente.aceito : 'Nao';
    const aceitoPor = existente ? existente.aceito_por : null;
    const aceitoEm = existente ? existente.aceito_em : null;
    const mantemPedidoPeca = existente && aguardandoPecas === 'Sim';
    const pedidoPecaAceito = mantemPedidoPeca ? existente.pedido_peca_aceito : 'Nao';
    const pedidoPecaAceitoPor = mantemPedidoPeca ? existente.pedido_peca_aceito_por : null;
    const pedidoPecaAceitoEm = mantemPedidoPeca ? existente.pedido_peca_aceito_em : null;
    const recebimentoPecaConfirmado = mantemPedidoPeca ? existente.recebimento_peca_confirmado : 'Nao';
    const recebimentoPecaConfirmadoPor = mantemPedidoPeca ? existente.recebimento_peca_confirmado_por : null;
    const recebimentoPecaConfirmadoEm = mantemPedidoPeca ? existente.recebimento_peca_confirmado_em : null;
    const recusaPendente = existente ? existente.recusa_pendente : 'Nao';
    const recusaMotivo = existente ? existente.recusa_motivo : null;
    const recusaSolicitadoPor = existente ? existente.recusa_solicitado_por : null;
    const recusaSolicitadoEm = existente ? existente.recusa_solicitado_em : null;
    const recusaResultado = existente ? existente.recusa_resultado : null;
    const recusaRevisadoPor = existente ? existente.recusa_revisado_por : null;
    const recusaRevisadoEm = existente ? existente.recusa_revisado_em : null;
    const visualizadoPor = existente ? existente.visualizado_por : null;
    const visualizadoEm = existente ? existente.visualizado_em : null;
    db.prepare(SQL_UPSERT_MANUTENCAO_CORRETIVA).run({
      id: m.id,
      data: m.data ?? null,
      setor: m.setor,
      maquina: m.maquina,
      turno: m.turno ?? null,
      observador: m.observador,
      prioridade: m.prioridade,
      anomalia: m.anomalia,
      local: m.local ?? null,
      tipos: m.tipos ? JSON.stringify(m.tipos) : '[]',
      tipo_manutencao: m.tipoManutencao,
      tipo_etiqueta: m.tipoEtiqueta || 'Azul',
      tipo_execucao: m.tipoExecucao || 'Interno',
      empresa_externa: m.empresaExterna ?? null,
      responsavel: m.responsavel ?? null,
      foto_operador: m.fotoOperador ?? null,
      foto_tecnico: m.fotoTecnico ?? null,
      data_inicio: m.dataInicio ?? null,
      hora_inicio: m.horaInicio ?? null,
      data_fim: m.dataFim ?? null,
      hora_fim: m.horaFim ?? null,
      tempo_gasto: m.tempoGasto ?? 0,
      situacao: m.situacao || 'Aguardando',
      em_manutencao: m.emManutencao || 'Nao',
      aguardando_pecas: aguardandoPecas,
      pecas_avariadas: m.pecasAvariadas ?? null,
      pecas_comprar: m.pecasComprar ?? null,
      rotina: m.rotina ?? null,
      sup_data_inicio: m.supDataInicio ?? null,
      sup_hora_inicio: m.supHoraInicio ?? null,
      sup_data_fim: m.supDataFim ?? null,
      sup_hora_fim: m.supHoraFim ?? null,
      sup_tempo_gasto: m.supTempoGasto ?? 0,
      status_compra: m.statusCompra ?? null,
      previsao_chegada: m.previsaoChegada ?? null,
      fornecedor: m.fornecedor ?? null,
      resp_supervisor: m.respSupervisor ?? null,
      obs_supervisor: m.obsSupervisor ?? null,
      custo_pecas: m.custoPecas ?? 0,
      custo_mao_obra: m.custoMaoObra ?? 0,
      etiqueta_fechada: m.etiquetaFechada ? 1 : 0,
      aceito, aceito_por: aceitoPor, aceito_em: aceitoEm,
      pedido_peca_aceito: pedidoPecaAceito, pedido_peca_aceito_por: pedidoPecaAceitoPor, pedido_peca_aceito_em: pedidoPecaAceitoEm,
      recebimento_peca_confirmado: recebimentoPecaConfirmado,
      recebimento_peca_confirmado_por: recebimentoPecaConfirmadoPor,
      recebimento_peca_confirmado_em: recebimentoPecaConfirmadoEm,
      recusa_pendente: recusaPendente, recusa_motivo: recusaMotivo,
      recusa_solicitado_por: recusaSolicitadoPor, recusa_solicitado_em: recusaSolicitadoEm,
      recusa_resultado: recusaResultado, recusa_revisado_por: recusaRevisadoPor, recusa_revisado_em: recusaRevisadoEm,
      visualizado_por: visualizadoPor, visualizado_em: visualizadoEm,
      autor_nome: m.autorNome ?? null,
      data_criacao: m.dataCriacao || agora,
      data_modificacao: agora,
    });
  }
  
  function excluirManutencaoCorretiva(id) {
    db.prepare('DELETE FROM manutencao_corretiva WHERE id = ?').run(id);
  }

  /**
   * Substitui TODOS os chamados de manutenção corretiva pelos da lista —
   * usada só por POST /restaurar-backup-dados e /restaurar-backup-geral
   * (ver lib/rotas/backup.js). Mesmo padrão de substituirAvaliacoesQualidade
   * (acima): apaga tudo, reinsere.
   */
  function substituirManutencaoCorretiva(lista) {
    db.prepare('DELETE FROM manutencao_corretiva').run();
    for (const m of (lista || [])) salvarManutencaoCorretiva(m);
  }


  return {
    listarManutencaoCorretiva,
    obterManutencaoCorretiva,
    salvarManutencaoCorretiva,
    aceitarManutencaoCorretiva,
    aceitarPedidoPecaManutencaoCorretiva,
    confirmarRecebimentoPecaManutencaoCorretiva,
    solicitarRecusaManutencaoCorretiva,
    responderRecusaManutencaoCorretiva,
    marcarVisualizadoManutencaoCorretiva,
    excluirManutencaoCorretiva,
    substituirManutencaoCorretiva,
  };
};
