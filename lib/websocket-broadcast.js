// ─── lib/websocket-broadcast.js — WebSocket Broadcast ──────────────────────
// Fase 13 do fatiamento de server.js (ver README, "Fatiamento de server.js"
// → "Plano de continuidade") — transmite em tempo real qualquer mudança da
// operação em andamento (tela "Registrar Operação") pra quem mais estiver
// com a tela aberta, e alguns outros avisos pontuais (operação finalizada,
// leitura automática, linha de Dados SQL excluída). Chamado por praticamente
// todo módulo que mexe em operação em andamento ao mesmo tempo:
// lib/rotas/registro-operacao.js, lib/rotas/operacao-andamento.js,
// lib/rotas/leitura-e-ajustes.js e lib/rotas/sql-admin.js.
//
// A conexão WebSocket em si (`new WebSocket.Server(...)`, `wss.on(
// 'connection', ...)`) continua em server.js — depende do `server` HTTP, que
// só existe lá — mas a LISTA de clientes conectados e o envio pra todos eles
// vivem aqui, encapsulados atrás de adicionarCliente()/removerCliente(), pra
// server.js não precisar saber como o broadcast decide pra quem mandar.

module.exports = function criarWebSocketBroadcast({ WebSocket }) {

  const clientesOperacaoAndamento = new Set();

  // Número de revisão da operação em andamento — só em memória (reseta com
  // o servidor, junto de clientesOperacaoAndamento; não precisa sobreviver
  // a um restart, já que todo cliente reconecta e recebe um snapshot novo
  // de qualquer forma). Incrementado a cada broadcastOperacaoAndamento(),
  // nunca decrementado — é o jeito do CLIENTE (ver _aplicarEstadoExterno,
  // operacao.js) saber "essa atualização que chegou é mais nova que a que
  // eu já tenho, ou é uma atualização atrasada/velha que devo ignorar".
  //
  // Motivação (ver conversa que motivou): antes, qualquer atualização
  // recebida por WebSocket SUBSTITUÍA o estado local inteiro, sem checar
  // se era mais recente — duas ABAS (não só dois computadores; abas do
  // MESMO navegador compartilham deviceId via localStorage, então o
  // mecanismo de "dono" já existente, baseado em deviceId, não protege
  // contra isso) editando a mesma operação podiam se sobrescrever uma à
  // outra silenciosamente, apagando dados recém-preenchidos sem aviso
  // nenhum — um traço "cheio" podia voltar a aparecer como pendente do
  // nada, se uma aba mais atrasada mandasse a própria versão por cima.
  let _revisaoOperacaoAndamento = 0;

  // Chamado por server.js dentro de wss.on('connection', ...) — mantém a
  // lista de clientes conectados encapsulada aqui, onde o broadcast já usa.
  function adicionarCliente(ws) {
    clientesOperacaoAndamento.add(ws);
  }

  function removerCliente(ws) {
    clientesOperacaoAndamento.delete(ws);
  }

  // Pro snapshot inicial que server.js manda assim que um cliente conecta
  // (ver wss.on('connection', ...)) — a aba recém-aberta precisa nascer
  // sabendo a revisão ATUAL (não 0), pra futuras atualizações contarem
  // corretamente como "mais novas" ou não.
  function getRevisaoAtual() {
    return _revisaoOperacaoAndamento;
  }

  function _enviarWsParaTodos(msg) {
    const texto = JSON.stringify(msg);
    for (const ws of clientesOperacaoAndamento) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(texto); } catch (_) { /* cliente pode ter caído nesse exato instante */ }
      }
    }
  }

  // Devolve o novo número de revisão pra quem chamou (ver POST
  // /salvar-operacao-andamento, lib/rotas/operacao-andamento.js) poder
  // incluir na RESPOSTA HTTP também — o próprio autor da mudança nunca vê
  // o eco do seu WebSocket (filtrado por origemClientId, ver data.js),
  // então é só pela resposta HTTP que ele fica sabendo sua própria
  // revisão mais recente.
  function broadcastOperacaoAndamento(dados, origemClientId) {
    _revisaoOperacaoAndamento++;
    _enviarWsParaTodos({ tipo: 'estado', dados, origemClientId, revisao: _revisaoOperacaoAndamento });
    return _revisaoOperacaoAndamento;
  }

  // Avisa todo mundo "ligado" no sistema (exceto quem registrou — esse já
  // vê o resumo localmente) que uma operação foi finalizada/registrada —
  // fim da dinâmica de dono. Disparado por POST /registrar-operacao, nunca
  // em modo de teste. `resumo` é o mesmo formato que showSuccessModal()
  // (operacao.js) já usa pra exibir o modal de sucesso.
  function broadcastOperacaoFinalizada(resumo, origemClientId) {
    _enviarWsParaTodos({ tipo: 'operacao_finalizada', resumo, origemClientId });
  }

  // Avisa quem estiver com "Modo Automático" ativo (ver operacao.js,
  // _aplicarLeituraAutomatica) que uma leitura chegou de fora — hoje
  // disparado só por POST /leitura-automatica, que por enquanto é chamado
  // manualmente/por teste; a fonte real (coletor Modbus TCP lendo o CLP
  // WAGO) ainda não existe — ver README, "Modo Automático".
  function broadcastLeituraAutomatica(leitura) {
    _enviarWsParaTodos({ tipo: 'leitura_automatica', leitura });
  }

  // Avisa TODO MUNDO conectado (qualquer página, não só quem tem "Registrar
  // Operação" aberta — ver conectarOperacaoAndamento() em data.js, chamada
  // uma vez só no boot do app, independente da tela visível) que uma linha
  // foi excluída em Configurações → Dados SQL. Quem originou a exclusão já
  // recarrega a própria página sozinho (ver cfgSqlExcluirLinha, app-core.js)
  // — por isso `origemClientId` (mesmo padrão de broadcastOperacaoFinalizada,
  // via wsClientId na query string) evita mandar essa mesma pessoa recarregar
  // 2 vezes.
  function broadcastDadosSqlExcluidos(info, origemClientId) {
    _enviarWsParaTodos({ tipo: 'dados_sql_excluidos', ...info, origemClientId });
  }

  return {
    adicionarCliente,
    removerCliente,
    getRevisaoAtual,
    broadcastOperacaoAndamento,
    broadcastOperacaoFinalizada,
    broadcastLeituraAutomatica,
    broadcastDadosSqlExcluidos,
  };
};
