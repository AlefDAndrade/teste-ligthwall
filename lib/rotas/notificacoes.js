// ─── lib/rotas/notificacoes.js — Notificações Push (inscrição/config) ─────
// Rotas: GET /push/config, POST /push/inscrever, POST /push/desinscrever.
// O ENVIO em si (webpush.sendNotification) mora em lib/notificacoes-push.js
// e hoje só existe pra UMA coisa: avisar quem pediu uma exportação de PDF
// (Análise Focada) quando ela termina de ser gerada (ver notificarPdfPronto,
// lib/notificacoes-push.js, disparado de dentro de lib/rotas/exportar-pdf.js)
// — aqui é só o lado do navegador se cadastrar (ou descadastrar) pra
// receber.
//
// Histórico: este arquivo já existia pra um sistema bem maior de
// notificações do Setor de Manutenção (abertura de chamado corretivo,
// pedido/recebimento de peça, lembrete de manutenção programada — ver
// lib/notificacoes-push.js) — removido junto com a descontinuação do
// Setor de Manutenção (lib/rotas/manutencao.js nem existe mais). Sobrou
// só a infraestrutura de inscrição/config abaixo, hoje usada só pelo PDF.
//
// Exige estar logado (usuário cadastrado OU Admin Master — mesma função
// `nomeDeQuemEstaLogado`, lib/permissoes-area.js) pra saber DE QUEM é
// aquela inscrição — sem isso não haveria como mandar o PDF pronto pra
// pessoa certa. NÃO checa permissão nenhuma: diferente da época da
// Manutenção (onde só quem tinha a permissão marcada no perfil recebia),
// o PDF pronto é sempre só pra quem pediu, então basta estar logado.

module.exports = function criarRotasNotificacoes({ db, notificacoesPush, nomeDeQuemEstaLogado }) {

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

    // Chave pública VAPID (pra PushManager.subscribe no navegador) + se
    // tem alguém logado agora — o front usa isso pra decidir se mostra o
    // botão "Ativar notificações" (sem sentido oferecer se não há como
    // saber de quem seria a inscrição, ver comentário no topo do
    // arquivo — não é mais uma checagem de permissão, só de login).
    if (req.method === 'GET' && urlPath === '/push/config') {
      try {
        const nome = nomeDeQuemEstaLogado(req);
        responderOk(res, {
          chavePublica: notificacoesPush.chavePublica(),
          logado: !!nome,
        });
      } catch (e) {
        responderErro(res, 500, e.message);
      }
      return true;
    }

    if (req.method === 'POST' && urlPath === '/push/inscrever') {
      const nome = nomeDeQuemEstaLogado(req);
      if (!nome) { responderErro(res, 401, 'Faça login pra ativar notificações.'); return true; }
      lerCorpoJSON(req).then(({ subscription }) => {
        try {
          db.salvarPushSubscription(nome, subscription, req.headers['user-agent'] || null);
          responderOk(res, {});
        } catch (e) {
          responderErro(res, 400, e.message);
        }
      }).catch(e => responderErro(res, 400, e.message));
      return true;
    }

    if (req.method === 'POST' && urlPath === '/push/desinscrever') {
      lerCorpoJSON(req).then(({ endpoint }) => {
        try {
          if (!endpoint) throw new Error('Campo "endpoint" obrigatório.');
          // Checagem de posse — só quem criou a inscrição (mesmo nome de
          // cadastro) pode removê-la; se já não existir, trata como
          // sucesso (idempotente — desativar um dispositivo que já nem
          // tinha inscrição não é um erro).
          const existente = db.obterPushSubscriptionPorEndpoint(endpoint);
          const nome = nomeDeQuemEstaLogado(req);
          if (existente && (!nome || existente.usuario_nome !== nome)) {
            throw new Error('Esta inscrição de notificação não pertence a você.');
          }
          db.removerPushSubscription(endpoint);
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
