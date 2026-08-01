// ─── lib/db/manutencao-programada.js — Manutenção Programada (agendamentos) ─
// Fase 2 do fatiamento de db.js (ver README, "Fatiamento de db.js (plano)").
// Extraído sem mudar nenhuma lógica — só de onde o código mora: as
// mesmas funções que viviam soltas em db.js (linhas ~3042–3204, antes
// desta extração), agora aqui, penduradas de volta no objeto `db`
// (module.exports = db, em db.js) pra quem já consome
// `db.listarManutencaoProgramada()` etc. (lib/rotas/manutencao.js,
// lib/rotas/backup.js, lib/notificacoes-push.js) continuar funcionando
// sem tocar em nenhum consumidor.
//
// Diferente de lib/rotas/* (que recebem `db` já pronto e só o usam),
// este módulo TAMBÉM segue o padrão de factory recebendo a conexão via
// parâmetro — mas aqui `db` é a conexão crua do better-sqlite3 (não um
// wrapper de rotas): só existe 1 conexão com o banco no processo
// inteiro, e este módulo não abre a própria (ver nota "Diferença
// importante" no README).

module.exports = function criarDbManutencaoProgramada(db) {

  function _rowParaManutencaoProgramada(row) {
    return {
      id: row.id,
      data: row.data,
      hora: row.hora,
      turno: row.turno,
      setor: row.setor,
      maquina: row.maquina,
      tipo: row.tipo,
      solicitante: row.solicitante,
      observacoes: row.observacoes,
      status: row.status,
      justificativa: row.justificativa,
      dataInicioEstimado: row.data_inicio_estimado,
      horaInicioEstimado: row.hora_inicio_estimado,
      dataFimEstimado: row.data_fim_estimado,
      horaFimEstimado: row.hora_fim_estimado,
      execucaoDataInicio: row.execucao_data_inicio,
      execucaoHoraInicio: row.execucao_hora_inicio,
      ...(row.execucao ? { execucao: JSON.parse(row.execucao) } : {}),
      autorNome: row.autor_nome,
      dataCriacao: row.data_criacao,
      lembreteDiaEnviado: !!row.lembrete_dia_enviado,
    };
  }

  const SQL_UPSERT_MANUTENCAO_PROGRAMADA = `
    INSERT INTO manutencao_programada (
      id, data, hora, turno, setor, maquina, tipo, solicitante, observacoes,
      status, justificativa, data_inicio_estimado, hora_inicio_estimado,
      data_fim_estimado, hora_fim_estimado, execucao_data_inicio, execucao_hora_inicio,
      execucao, autor_nome, data_criacao
    ) VALUES (
      @id, @data, @hora, @turno, @setor, @maquina, @tipo, @solicitante, @observacoes,
      @status, @justificativa, @data_inicio_estimado, @hora_inicio_estimado,
      @data_fim_estimado, @hora_fim_estimado, @execucao_data_inicio, @execucao_hora_inicio,
      @execucao, @autor_nome, @data_criacao
    )
    ON CONFLICT(id) DO UPDATE SET
      data=@data, hora=@hora, turno=@turno, setor=@setor, maquina=@maquina, tipo=@tipo,
      solicitante=@solicitante, observacoes=@observacoes, status=@status,
      justificativa=@justificativa, data_inicio_estimado=@data_inicio_estimado,
      hora_inicio_estimado=@hora_inicio_estimado, data_fim_estimado=@data_fim_estimado,
      hora_fim_estimado=@hora_fim_estimado, execucao_data_inicio=@execucao_data_inicio,
      execucao_hora_inicio=@execucao_hora_inicio, execucao=@execucao, autor_nome=@autor_nome,
      -- Se a DATA do agendamento mudou (reagendado pra outro dia), o
      -- lembrete "já enviado" desta ocorrência antiga não vale mais pro
      -- novo dia — reseta pra 0 (elegível de novo, ver
      -- listarManutencaoProgramadaParaLembreteDoDia). \`data\`, aqui (sem
      -- prefixo), se refere ao valor ANTIGO da linha (antes deste UPDATE) —
      -- semântica padrão de SQL: todas as expressões do SET são avaliadas
      -- contra a linha como estava antes do comando, mesmo já havendo
      -- \`data=@data\` mais acima na mesma lista. Se a data não mudou, mantém
      -- o valor que já estava (não desmarca um lembrete já enviado hoje à
      -- toa só por causa de um update em outro campo, tipo aprovar/reprovar).
      lembrete_dia_enviado = CASE WHEN data <> @data THEN 0 ELSE lembrete_dia_enviado END
  `;

  function listarManutencaoProgramada() {
    // Mesmo desempate por ROWID DESC da Corretiva, acima — some com o
    // resto de risco de empate mesmo depois do timestamp completo.
    const rows = db.prepare('SELECT * FROM manutencao_programada ORDER BY data_criacao DESC, ROWID DESC').all();
    return rows.map(_rowParaManutencaoProgramada);
  }

  // Busca 1 agendamento por id — usada pela rota (lib/rotas/manutencao.js)
  // pra saber, ANTES de salvar, se um POST /manutencao/programada é uma
  // criação nova ou só um update de status (aprovar/reprovar/executar), e
  // assim decidir se dispara a notificação de "agendamento novo" (ver
  // notificarManutencaoProgramada, lib/notificacoes-push.js) — mesmo
  // raciocínio de obterManutencaoCorretiva, já existente, só que pra esta
  // tabela.
  function obterManutencaoProgramada(id) {
    const row = db.prepare('SELECT * FROM manutencao_programada WHERE id = ?').get(id);
    return row ? _rowParaManutencaoProgramada(row) : null;
  }

  function salvarManutencaoProgramada(a) {
    db.prepare(SQL_UPSERT_MANUTENCAO_PROGRAMADA).run({
      id: a.id,
      data: a.data,
      hora: a.hora ?? null,
      turno: a.turno ?? null,
      setor: a.setor,
      maquina: a.maquina,
      tipo: a.tipo ?? null,
      solicitante: a.solicitante,
      observacoes: a.observacoes ?? null,
      status: a.status || 'Pendente',
      justificativa: a.justificativa ?? null,
      data_inicio_estimado: a.dataInicioEstimado ?? null,
      hora_inicio_estimado: a.horaInicioEstimado ?? null,
      data_fim_estimado: a.dataFimEstimado ?? null,
      hora_fim_estimado: a.horaFimEstimado ?? null,
      execucao_data_inicio: a.execucaoDataInicio ?? null,
      execucao_hora_inicio: a.execucaoHoraInicio ?? null,
      execucao: a.execucao ? JSON.stringify(a.execucao) : null,
      autor_nome: a.autorNome ?? null,
      // Timestamp COMPLETO (não só a data), mesmo padrão do
      // data_criacao da Corretiva (ver lib/db/manutencao-corretiva.js) —
      // antes disso era só a data (YYYY-MM-DD), e como o "mais recente
      // primeiro" da listagem depende deste campo (ORDER BY data_criacao
      // DESC, logo abaixo), dois agendamentos criados no mesmo dia
      // empatavam aqui e a ordem entre eles ficava por conta do SQLite
      // (não necessariamente o mais novo primeiro).
      data_criacao: a.dataCriacao || new Date().toISOString(),
    });
  }

  function excluirManutencaoProgramada(id) {
    db.prepare('DELETE FROM manutencao_programada WHERE id = ?').run(id);
  }

  // Agendamentos elegíveis pro LEMBRETE do dia (ver
  // executarLembreteManutencaoProgramadaSeNecessario,
  // lib/notificacoes-push.js): data = hoje (o dia do próprio agendamento),
  // status = 'Aprovado' (Pendente/Reprovado ainda não têm data confirmada;
  // Em Execucao/Concluido/Nao Executado já foram tratados, não faz sentido
  // lembrar) e o lembrete ainda não foi enviado (evita reenviar a cada
  // checagem do setInterval, que roda a cada minuto). Reagendar um
  // agendamento (mudar a `data`) reseta esse "já enviado" automaticamente
  // — ver o CASE em SQL_UPSERT_MANUTENCAO_PROGRAMADA, acima — então um
  // agendamento adiado pra depois e trazido de volta pro mesmo dia de
  // novo volta a ser elegível.
  function listarManutencaoProgramadaParaLembreteDoDia(hoje) {
    const rows = db.prepare(
      `SELECT * FROM manutencao_programada
       WHERE data = ? AND status = 'Aprovado' AND lembrete_dia_enviado = 0`
    ).all(hoje);
    return rows.map(_rowParaManutencaoProgramada);
  }

  // Marca que o lembrete do dia já foi disparado pra este agendamento —
  // chamado logo depois de notificarLembreteManutencaoProgramada ter sido
  // disparado com sucesso (ver notificacoes-push.js), pra nunca mais
  // reaparecer em listarManutencaoProgramadaParaLembreteDoDia.
  function marcarLembreteDiaEnviado(id) {
    db.prepare('UPDATE manutencao_programada SET lembrete_dia_enviado = 1 WHERE id = ?').run(id);
  }

  /** Substitui TODOS os agendamentos de manutenção programada pelos da lista. */
  function substituirManutencaoProgramada(lista) {
    db.prepare('DELETE FROM manutencao_programada').run();
    for (const a of (lista || [])) salvarManutencaoProgramada(a);
  }

  return {
    listarManutencaoProgramada,
    obterManutencaoProgramada,
    salvarManutencaoProgramada,
    excluirManutencaoProgramada,
    listarManutencaoProgramadaParaLembreteDoDia,
    marcarLembreteDiaEnviado,
    substituirManutencaoProgramada,
  };
};
