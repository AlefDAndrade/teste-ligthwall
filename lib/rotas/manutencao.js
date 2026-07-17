// ─── lib/rotas/manutencao.js — Setor de Manutenção (backend real) ──────────
// Fase 2 do Setor de Manutenção (ver conversa que motivou isso): a Fase 1
// só dividiu o protótipo em HTML/CSS/JS separados, mas os dados
// continuavam em localStorage do navegador — sem sincronizar entre
// computadores, sem entrar em backup. Aqui é o backend de verdade —
// mesmo padrão de tabelas SQL do resto do sistema (ver CREATE TABLE em
// db.js, "SETOR DE MANUTENÇÃO — Fase 2").
//
// Rotas cobertas: GET /manutencao/corretiva, POST /manutencao/corretiva,
// POST /manutencao/visualizar-corretiva, POST /manutencao/aceitar-corretiva,
// POST /manutencao/solicitar-recusa-corretiva,
// POST /manutencao/responder-recusa-corretiva, POST /manutencao/aceitar-pedido-peca,
// POST /manutencao/excluir-corretiva, GET /manutencao/programada,
// POST /manutencao/programada, POST /manutencao/excluir-programada.
//
// Só GET/POST, de propósito — mesmo padrão de todo o resto do sistema
// (nunca usa DELETE/PUT, mesmo pra exclusão/edição — ver
// /excluir-parada, /salvar-usuarios). DELETE/PUT ficariam sem a
// proteção de tamanho máximo de corpo que existe em server.js (só
// aplicada a req.method === 'POST'), então excluir/editar aqui também
// são POST, com o "o quê fazer" no path, não no verbo HTTP.
//
// Sem exigir sessão de admin nem permissão de controlar operação — mesmo
// nível de fricção baixa do resto das rotas de registro do dia a dia
// (ver /marcar-berco-andamento, /registrar-avaliacao-qualidade): qualquer
// perfil com acesso à página Manutenção (ver lib/perfis.js) pode
// ler/escrever, sem trava adicional aqui.

// ESCRITA protegida por área (modelo novo, ver lib/perfis.js) E, pro
// chamado corretivo especificamente, também por um segundo nível de
// checagem POR REGISTRO (ver podeEditarAberturaChamado/podeAceitarChamado/
// podeAceitarPedidoPeca, server.js — mesmo raciocínio de
// podeExcluirChamado) — abrir um chamado corretivo exige
// 'manutencao-chamado' (Encarregado tem só isso); editar um chamado JÁ
// ABERTO exige ser quem abriu, Admin, Supervisão ou Encarregado (só
// esses editam Abertura/Detalhes), OU ser Manutenção/Supervisão/
// Encarregado/Admin NUM CHAMADO JÁ ACEITO (aí só mexe na Execução); e
// fechar (etiquetaFechada/Concluído) continua exigindo 'manutencao'
// completa. A LEITURA continua livre.
module.exports = function criarRotasManutencao({
  db, podeEditarArea, negarEdicao, podeExcluirChamado,
  podeEditarAberturaChamado, podeAceitarChamado, podeAceitarPedidoPeca, nomeDeQuemAceita,
  nomeParaVisualizacao,
}) {

  function lerCorpoJSON(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (e) {
          reject(new Error('JSON inválido no corpo da requisição.'));
        }
      });
      req.on('error', reject);
    });
  }

  function responderErro(res, status, mensagem) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: mensagem }));
  }

  function responderOk(res, dados) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...dados }));
  }

  return function tentar(req, res, urlPath) {

    // ═══════════════════════════════════════════════════════════════
    // MANUTENÇÃO CORRETIVA (chamados)
    // ═══════════════════════════════════════════════════════════════

    if (req.method === 'GET' && urlPath === '/manutencao/corretiva') {
      try {
        responderOk(res, { chamados: db.listarManutencaoCorretiva() });
      } catch (e) {
        responderErro(res, 500, e.message);
      }
      return true;
    }

    // Marca a 1ª visualização do chamado — vira um ponto na trajetória
    // visual (ver abrirHistorico(), manutencao.js, chamada sempre que
    // alguém abre o relatório). Sem trava de área/perfil de propósito
    // (mesmo espírito de "a LEITURA é livre" do resto do arquivo) — só
    // precisa estar logado (nomeParaVisualizacao devolve null se não);
    // sem sessão, a marcação simplesmente não acontece, sem erro (não é
    // crítico o suficiente pra bloquear a visualização em si).
    if (req.method === 'POST' && urlPath === '/manutencao/visualizar-corretiva') {
      lerCorpoJSON(req).then(({ id }) => {
        try {
          if (!id) throw new Error('Campo "id" obrigatório.');
          const chamado = db.obterManutencaoCorretiva(id);
          if (!chamado) throw new Error('Chamado não encontrado.');
          const nome = nomeParaVisualizacao(req);
          if (nome && !chamado.visualizadoPor) {
            db.marcarVisualizadoManutencaoCorretiva(id, nome);
          }
          responderOk(res, { chamado: db.obterManutencaoCorretiva(id) });
        } catch (e) {
          responderErro(res, 400, e.message);
        }
      }).catch(e => responderErro(res, 400, e.message));
      return true;
    }

    // Upsert (cria se "id" não existir ainda, atualiza se existir) —
    // mesmo objeto que o front já monta (ver salvarManutencao(),
    // manutencao.js), só repassado quase sem alteração pro banco (ver
    // db.salvarManutencaoCorretiva, que faz a conversão de campos — e
    // NUNCA aceita os campos de aceite vindos daqui, ver comentário lá).
    if (req.method === 'POST' && urlPath === '/manutencao/corretiva') {
      lerCorpoJSON(req).then(chamado => {
        try {
          if (!chamado.id) throw new Error('Campo "id" obrigatório.');
          const existente = db.obterManutencaoCorretiva(chamado.id);
          const estaFechando = chamado && (chamado.etiquetaFechada === true || chamado.situacao === 'Concluido');

          if (!existente) {
            // Chamado NOVO — abrir exige só 'manutencao-chamado' (acesso
            // amplo, mesmo comportamento de sempre).
            if (!podeEditarArea(req, 'manutencao-chamado')) {
              negarEdicao(res, 'a Manutenção');
              return;
            }
          } else if (estaFechando) {
            // Fechar (etiquetaFechada / situação "Concluído") continua
            // exigindo 'manutencao' completa — não faz parte do fluxo de
            // aceite pedido pelo usuário, mantido como sempre foi.
            if (!podeEditarArea(req, 'manutencao')) {
              negarEdicao(res, 'o fechamento de chamados de manutenção');
              return;
            }
          } else {
            // Chamado JÁ EXISTE e não está fechando — 2 caminhos válidos:
            // (a) quem abriu / Admin / Supervisão / Encarregado, editando
            //     Abertura+Detalhes (e o resto também, já que é o mesmo
            //     payload inteiro); ou
            // (b) Manutenção/Supervisão/Encarregado/Admin mexendo só na
            //     Execução, MAS SÓ SE o chamado já tiver sido aceito
            //     (ver POST /manutencao/aceitar-corretiva, abaixo) — sem
            //     isso, um perfil Manutenção nunca conseguiria salvar a
            //     Execução, mesmo depois de aceitar — é justamente essa
            //     exceção que o usuário pediu.
            const podeAbertura = podeEditarAberturaChamado(req, existente);
            const podeExecucao = existente.aceito === 'Sim' && podeAceitarChamado(req);
            if (!podeAbertura && !podeExecucao) {
              negarEdicao(res, 'este chamado de manutenção');
              return;
            }
          }

          if (!chamado.setor || !chamado.maquina || !chamado.observador || !chamado.anomalia || !chamado.prioridade || !chamado.tipoManutencao) {
            throw new Error('Campos obrigatórios ausentes: setor, maquina, observador, anomalia, prioridade, tipoManutencao.');
          }
          db.salvarManutencaoCorretiva(chamado);
          responderOk(res, { chamado: db.obterManutencaoCorretiva(chamado.id) });
        } catch (e) {
          responderErro(res, 400, e.message);
        }
      }).catch(e => responderErro(res, 400, e.message));
      return true;
    }

    // Aceitar um chamado — libera a Seção 3 (Execução) no front. Qualquer
    // um dos 4 (Manutenção, Admin, Supervisão, Encarregado) pode aceitar;
    // basta 1 aceitar pra ficar valendo pra todo mundo (pedido do
    // usuário). Idempotente: aceitar de novo um chamado já aceito não dá
    // erro, só não troca quem/quando aceitou primeiro (ver
    // db.aceitarManutencaoCorretiva).
    if (req.method === 'POST' && urlPath === '/manutencao/aceitar-corretiva') {
      if (!podeAceitarChamado(req)) { negarEdicao(res, 'aceitar chamados de manutenção'); return true; }
      lerCorpoJSON(req).then(({ id }) => {
        try {
          if (!id) throw new Error('Campo "id" obrigatório.');
          const chamado = db.obterManutencaoCorretiva(id);
          if (!chamado) throw new Error('Chamado não encontrado.');
          if (chamado.etiquetaFechada) throw new Error('Este chamado já está fechado.');
          if (chamado.recusaPendente === 'Sim') throw new Error('Este chamado tem uma solicitação de recusa pendente de revisão.');
          if (chamado.aceito !== 'Sim') {
            const nome = nomeDeQuemAceita(req);
            db.aceitarManutencaoCorretiva(id, nome);
          }
          responderOk(res, { chamado: db.obterManutencaoCorretiva(id) });
        } catch (e) {
          responderErro(res, 400, e.message);
        }
      }).catch(e => responderErro(res, 400, e.message));
      return true;
    }

    // Aceitar um PEDIDO DE PEÇA — libera a Seção 4 (Acompanhamento da
    // Supervisão). Só Supervisão, Encarregado ou Admin (perfil
    // Manutenção não aceita pedido de peça, só abre o pedido marcando
    // "Aguardando peças? = Sim" na Execução — pedido do usuário).
    if (req.method === 'POST' && urlPath === '/manutencao/aceitar-pedido-peca') {
      if (!podeAceitarPedidoPeca(req)) { negarEdicao(res, 'aceitar pedidos de peça de manutenção'); return true; }
      lerCorpoJSON(req).then(({ id }) => {
        try {
          if (!id) throw new Error('Campo "id" obrigatório.');
          const chamado = db.obterManutencaoCorretiva(id);
          if (!chamado) throw new Error('Chamado não encontrado.');
          if (chamado.aguardandoPecas !== 'Sim') throw new Error('Este chamado não tem pedido de peça pendente.');
          if (chamado.pedidoPecaAceito !== 'Sim') {
            const nome = nomeDeQuemAceita(req);
            db.aceitarPedidoPecaManutencaoCorretiva(id, nome);
          }
          responderOk(res, { chamado: db.obterManutencaoCorretiva(id) });
        } catch (e) {
          responderErro(res, 400, e.message);
        }
      }).catch(e => responderErro(res, 400, e.message));
      return true;
    }

    // Solicitar RECUSA do chamado — em vez de aceitar, explica um motivo
    // pra recusar. Mesmo grupo de quem pode aceitar (Manutenção, Admin,
    // Supervisão, Encarregado — pedido do usuário: o botão fica ao lado
    // de "Aceitar Chamado"). Só faz sentido ANTES do chamado ser aceito
    // (recusar é uma alternativa a aceitar, não algo que se faz depois) e
    // sem já ter uma recusa pendente de revisão.
    if (req.method === 'POST' && urlPath === '/manutencao/solicitar-recusa-corretiva') {
      if (!podeAceitarChamado(req)) { negarEdicao(res, 'recusar chamados de manutenção'); return true; }
      lerCorpoJSON(req).then(({ id, motivo }) => {
        try {
          if (!id) throw new Error('Campo "id" obrigatório.');
          const motivoLimpo = (motivo || '').trim();
          if (!motivoLimpo) throw new Error('Informe o motivo da recusa.');
          const chamado = db.obterManutencaoCorretiva(id);
          if (!chamado) throw new Error('Chamado não encontrado.');
          if (chamado.etiquetaFechada) throw new Error('Este chamado já está fechado.');
          if (chamado.aceito === 'Sim') throw new Error('Este chamado já foi aceito — não é mais possível recusar.');
          if (chamado.recusaPendente === 'Sim') throw new Error('Já existe uma solicitação de recusa pendente de revisão pra este chamado.');
          const nome = nomeDeQuemAceita(req);
          db.solicitarRecusaManutencaoCorretiva(id, motivoLimpo, nome);
          responderOk(res, { chamado: db.obterManutencaoCorretiva(id) });
        } catch (e) {
          responderErro(res, 400, e.message);
        }
      }).catch(e => responderErro(res, 400, e.message));
      return true;
    }

    // Responder um pedido de recusa pendente — só Admin/Supervisão/
    // Encarregado (mesmo grupo de podeAceitarPedidoPeca, reaproveitado
    // aqui: pedido do usuário, "eles leem o pedido de recusa e marca se
    // aceita a recusa ou não"). "aceitaRecusa: true" ENCERRA o chamado;
    // "aceitaRecusa: false" descarta a recusa e devolve o chamado pra
    // Manutenção dar prosseguimento (ver db.responderRecusaManutencaoCorretiva).
    if (req.method === 'POST' && urlPath === '/manutencao/responder-recusa-corretiva') {
      if (!podeAceitarPedidoPeca(req)) { negarEdicao(res, 'revisar recusas de chamados de manutenção'); return true; }
      lerCorpoJSON(req).then(({ id, aceitaRecusa }) => {
        try {
          if (!id) throw new Error('Campo "id" obrigatório.');
          const chamado = db.obterManutencaoCorretiva(id);
          if (!chamado) throw new Error('Chamado não encontrado.');
          if (chamado.recusaPendente !== 'Sim') throw new Error('Este chamado não tem nenhuma recusa pendente de revisão.');
          const nome = nomeDeQuemAceita(req);
          db.responderRecusaManutencaoCorretiva(id, !!aceitaRecusa, nome);
          responderOk(res, { chamado: db.obterManutencaoCorretiva(id) });
        } catch (e) {
          responderErro(res, 400, e.message);
        }
      }).catch(e => responderErro(res, 400, e.message));
      return true;
    }

    if (req.method === 'POST' && urlPath === '/manutencao/excluir-corretiva') {
      if (!podeEditarArea(req, 'manutencao')) { negarEdicao(res, 'a Manutenção'); return true; }
      lerCorpoJSON(req).then(({ id }) => {
        try {
          if (!id) throw new Error('Campo "id" obrigatório.');
          db.excluirManutencaoCorretiva(id);
          responderOk(res, {});
        } catch (e) {
          responderErro(res, 400, e.message);
        }
      }).catch(e => responderErro(res, 400, e.message));
      return true;
    }

    // ═══════════════════════════════════════════════════════════════
    // MANUTENÇÃO PROGRAMADA (agendamentos)
    // ═══════════════════════════════════════════════════════════════

    if (req.method === 'GET' && urlPath === '/manutencao/programada') {
      try {
        responderOk(res, { agendamentos: db.listarManutencaoProgramada() });
      } catch (e) {
        responderErro(res, 500, e.message);
      }
      return true;
    }

    // Upsert — cobre tanto criar um agendamento novo (verificarEAgendiar())
    // quanto os updates parciais de status (aprovar/reprovar/executar): o
    // front sempre manda o objeto completo mais recente (mesmo padrão de
    // "salva tudo de novo" que POST /salvar-usuarios já usa) — mais
    // simples que ter uma rota separada pra cada campo.
    if (req.method === 'POST' && urlPath === '/manutencao/programada') {
      if (!podeEditarArea(req, 'manutencao')) { negarEdicao(res, 'a Manutenção'); return true; }
      lerCorpoJSON(req).then(agendamento => {
        try {
          if (!agendamento.id) throw new Error('Campo "id" obrigatório.');
          if (!agendamento.data || !agendamento.setor || !agendamento.maquina || !agendamento.solicitante) {
            throw new Error('Campos obrigatórios ausentes: data, setor, maquina, solicitante.');
          }
          db.salvarManutencaoProgramada(agendamento);
          responderOk(res, { agendamento: db.listarManutencaoProgramada().find(a => a.id === agendamento.id) });
        } catch (e) {
          responderErro(res, 400, e.message);
        }
      }).catch(e => responderErro(res, 400, e.message));
      return true;
    }

    if (req.method === 'POST' && urlPath === '/manutencao/excluir-programada') {
      if (!podeEditarArea(req, 'manutencao')) { negarEdicao(res, 'a Manutenção'); return true; }
      lerCorpoJSON(req).then(({ id }) => {
        try {
          if (!id) throw new Error('Campo "id" obrigatório.');
          db.excluirManutencaoProgramada(id);
          responderOk(res, {});
        } catch (e) {
          responderErro(res, 400, e.message);
        }
      }).catch(e => responderErro(res, 400, e.message));
      return true;
    }

    return false;
  };
};
