// ─── lib/rotas/notificacoes.js — Notificações Push (inscrição/config) ─────
// Rotas: GET /push/config, POST /push/inscrever, POST /push/desinscrever.
// O ENVIO em si (webpush.sendNotification) mora em lib/notificacoes-push.js
// e é disparado de dentro de lib/rotas/manutencao.js quando um chamado
// corretivo NOVO é aberto — aqui é só o lado do navegador se cadastrar
// (ou descadastrar) pra receber.
//
// Exige estar logado (usuário cadastrado OU Admin Master — mesma função
// `nomeDeQuemAceita` já usada pra autoria de aceite/recusa em
// lib/rotas/manutencao.js) pra saber DE QUEM é aquela inscrição — sem
// isso não haveria como decidir depois, na hora de notificar, se o
// PERFIL de quem está atrás daquele navegador tem a permissão marcada.

module.exports = function criarRotasNotificacoes({ db, notificacoesPush, nomeDeQuemAceita }) {

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

    // Chave pública VAPID (pra PushManager.subscribe no navegador) + se o
    // PERFIL de quem está logado agora tem a permissão de notificação
    // marcada — o front usa isso pra decidir se mostra o botão "Ativar
    // notificações" (sem sentido oferecer a um perfil que nunca vai
    // receber nada, mesmo que o navegador aceite a inscrição).
    if (req.method === 'GET' && urlPath === '/push/config') {
      try {
        const nome = nomeDeQuemAceita(req);
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
      const nome = nomeDeQuemAceita(req);
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
          // sucesso (idempotente, mesmo espírito do resto do sistema —
          // ver excluirManutencaoCorretiva).
          const existente = db.obterPushSubscriptionPorEndpoint(endpoint);
          const nome = nomeDeQuemAceita(req);
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
