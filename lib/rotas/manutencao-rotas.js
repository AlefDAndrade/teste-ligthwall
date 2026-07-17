// ─── lib/rotas/manutencao.js — Setor de Manutenção (backend real) ──────────
// Fase 2 do Setor de Manutenção (ver conversa que motivou isso): a Fase 1
// só dividiu o protótipo em HTML/CSS/JS separados, mas os dados
// continuavam em localStorage do navegador — sem sincronizar entre
// computadores, sem entrar em backup. Aqui é o backend de verdade —
// mesmo padrão de tabelas SQL do resto do sistema (ver CREATE TABLE em
// db.js, "SETOR DE MANUTENÇÃO — Fase 2").
//
// Rotas cobertas: GET /manutencao/corretiva, POST /manutencao/corretiva,
// POST /manutencao/excluir-corretiva, GET /manutencao/programada,
// POST /manutencao/programada, POST /manutencao/excluir-programada,
// GET /manutencao/estoque, POST /manutencao/estoque,
// POST /manutencao/editar-estoque, POST /manutencao/excluir-estoque,
// GET /manutencao/movimentacoes, POST /manutencao/movimentacoes.
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

// ESCRITA protegida por área (modelo novo, ver lib/perfis.js): abrir um
// chamado corretivo exige 'manutencao-chamado' (Encarregado tem só isso);
// todo o resto da escrita (excluir chamado, programada, almoxarifado,
// movimentações) exige 'manutencao' completa (perfil Manutenção,
// Supervisão, Administrador). A LEITURA continua livre.
module.exports = function criarRotasManutencao({ db, podeEditarArea, negarEdicao, podeExcluirChamado }) {

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

    // Upsert (cria se "id" não existir ainda, atualiza se existir) —
    // mesmo objeto que o front já monta (ver salvarManutencao(),
    // manutencao.js), só repassado quase sem alteração pro banco (ver
    // db.salvarManutencaoCorretiva, que faz a conversão de campos).
    if (req.method === 'POST' && urlPath === '/manutencao/corretiva') {
      lerCorpoJSON(req).then(chamado => {
        try {
          // 'manutencao-chamado' (Encarregado) cobre ABRIR e atualizar os
          // dados de um chamado em aberto — mas FECHAR o chamado
          // (etiquetaFechada / situação "Concluido", ver
          // confirmarFechamento(), manutencao.js) é uma conclusão do
          // serviço técnico, exige a área 'manutencao' completa (perfil
          // Manutenção, Supervisão, Administrador) — mesma rota, payload
          // diferente, checagem por conteúdo.
          const estaFechando = chamado && (chamado.etiquetaFechada === true || chamado.situacao === 'Concluido');
          const areaExigida = estaFechando ? 'manutencao' : 'manutencao-chamado';
          if (!podeEditarArea(req, areaExigida)) {
            negarEdicao(res, estaFechando ? 'o fechamento de chamados de manutenção' : 'a Manutenção');
            return;
          }
          if (!chamado.id) throw new Error('Campo "id" obrigatório.');
          if (!chamado.setor || !chamado.maquina || !chamado.observador || !chamado.anomalia || !chamado.prioridade || !chamado.tipoManutencao) {
            throw new Error('Campos obrigatórios ausentes: setor, maquina, observador, anomalia, prioridade, tipoManutencao.');
          }
          db.salvarManutencaoCorretiva(chamado);
          responderOk(res, { chamado: db.listarManutencaoCorretiva().find(c => c.id === chamado.id) });
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
          // Trava extra, além de podeEditarArea (acima) — ter permissão pra
          // editar a ÁREA "Manutenção" não basta mais pra excluir QUALQUER
          // chamado: só o Administrador ou quem abriu ESTE chamado
          // específico pode (ver podeExcluirChamado, server.js — pedido do
          // usuário).
          const chamado = db.listarManutencaoCorretiva().find(c => c.id === id);
          if (!chamado) throw new Error('Chamado não encontrado.');
          if (!podeExcluirChamado(req, chamado)) {
            responderErro(res, 403, 'Só o Administrador ou quem abriu este chamado pode excluí-lo.');
            return;
          }
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

    // ═══════════════════════════════════════════════════════════════
    // ALMOXARIFADO — Estoque de peças
    // ═══════════════════════════════════════════════════════════════

    if (req.method === 'GET' && urlPath === '/manutencao/estoque') {
      try {
        responderOk(res, { itens: db.listarManutencaoEstoque() });
      } catch (e) {
        responderErro(res, 500, e.message);
      }
      return true;
    }

    // Cadastro de peça NOVA — diferente de /manutencao/editar-estoque
    // (abaixo, que só edita os dados cadastrais de uma peça já
    // existente). Se vier com "quantidade" > 0, também registra uma
    // movimentação de "Estoque inicial" NO HISTÓRICO (mesmo
    // comportamento do protótipo original, ver salvarItemEstoque()) —
    // mas SEM passar pelo ajuste de saldo de
    // db.registrarManutencaoMovimentacao (essa é só pra Entrada/Saída
    // DEPOIS que a peça já existe, com um saldo anterior pra somar/
    // subtrair) — aqui o saldo inicial já nasce certo dentro do próprio
    // db.criarManutencaoEstoque(peca), a "movimentação de estoque
    // inicial" é só o REGISTRO no histórico, pra manter rastreável de
    // onde veio a quantidade inicial. Somar as duas coisas duplicaria o
    // saldo (bug real encontrado e corrigido durante os testes desta
    // implementação).
    if (req.method === 'POST' && urlPath === '/manutencao/estoque') {
      if (!podeEditarArea(req, 'manutencao')) { negarEdicao(res, 'a Manutenção'); return true; }
      lerCorpoJSON(req).then(peca => {
        try {
          if (!peca.id) throw new Error('Campo "id" obrigatório.');
          if (!peca.codigo || !peca.nome) throw new Error('Código e Nome são obrigatórios.');
          db.criarManutencaoEstoque(peca);
          if (peca.quantidade > 0) {
            db.registrarManutencaoMovimentacaoHistorico({
              id: (peca.id.replace(/^PEC-/, 'MOV-')) + '-inicial-' + Date.now(),
              pecaId: peca.id,
              tipo: 'Entrada',
              quantidade: peca.quantidade,
              motivo: 'Estoque inicial',
              autorNome: peca.autorNome || null,
            });
          }
          responderOk(res, { item: db.listarManutencaoEstoque().find(p => p.id === peca.id) });
        } catch (e) {
          responderErro(res, 400, e.message);
        }
      }).catch(e => responderErro(res, 400, e.message));
      return true;
    }

    // Edita só os dados CADASTRAIS de uma peça já existente (código,
    // nome, categoria, localização, fornecedor, preço, estoque mínimo) —
    // nunca "quantidade" (isso é sempre via POST /manutencao/movimentacoes,
    // ver db.atualizarManutencaoEstoque).
    if (req.method === 'POST' && urlPath === '/manutencao/editar-estoque') {
      if (!podeEditarArea(req, 'manutencao')) { negarEdicao(res, 'a Manutenção'); return true; }
      lerCorpoJSON(req).then(({ id, ...dados }) => {
        try {
          if (!id) throw new Error('Campo "id" obrigatório.');
          if (!dados.codigo || !dados.nome) throw new Error('Código e Nome são obrigatórios.');
          db.atualizarManutencaoEstoque(id, dados);
          responderOk(res, { item: db.listarManutencaoEstoque().find(p => p.id === id) });
        } catch (e) {
          responderErro(res, 400, e.message);
        }
      }).catch(e => responderErro(res, 400, e.message));
      return true;
    }

    if (req.method === 'POST' && urlPath === '/manutencao/excluir-estoque') {
      if (!podeEditarArea(req, 'manutencao')) { negarEdicao(res, 'a Manutenção'); return true; }
      lerCorpoJSON(req).then(({ id }) => {
        try {
          if (!id) throw new Error('Campo "id" obrigatório.');
          db.excluirManutencaoEstoque(id);
          responderOk(res, {});
        } catch (e) {
          responderErro(res, 400, e.message);
        }
      }).catch(e => responderErro(res, 400, e.message));
      return true;
    }

    // ═══════════════════════════════════════════════════════════════
    // MOVIMENTAÇÕES DE ESTOQUE (Entrada/Saída)
    // ═══════════════════════════════════════════════════════════════

    if (req.method === 'GET' && urlPath === '/manutencao/movimentacoes') {
      try {
        responderOk(res, { movimentacoes: db.listarManutencaoMovimentacoes() });
      } catch (e) {
        responderErro(res, 500, e.message);
      }
      return true;
    }

    if (req.method === 'POST' && urlPath === '/manutencao/movimentacoes') {
      if (!podeEditarArea(req, 'manutencao')) { negarEdicao(res, 'a Manutenção'); return true; }
      lerCorpoJSON(req).then(mov => {
        try {
          if (!mov.id || !mov.pecaId || !mov.tipo) throw new Error('Campos obrigatórios: id, pecaId, tipo.');
          if (mov.tipo !== 'Entrada' && mov.tipo !== 'Saída') throw new Error('"tipo" precisa ser "Entrada" ou "Saída".');
          if (!Number.isInteger(mov.quantidade) || mov.quantidade <= 0) throw new Error('Quantidade inválida.');
          const novoSaldo = db.registrarManutencaoMovimentacao(mov);
          responderOk(res, { novoSaldo });
        } catch (e) {
          responderErro(res, 400, e.message);
        }
      }).catch(e => responderErro(res, 400, e.message));
      return true;
    }

    return false;
  };
};
