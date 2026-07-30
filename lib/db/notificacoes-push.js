// ─── lib/db/notificacoes-push.js — Notificações Push (Fase 4 do fatiamento de db.js) ───
// Extraído de db.js sem mudar nenhuma lógica — só onde o código mora.
// Ver README.md, seção "Fatiamento de db.js (plano)".
//
// CREATE TABLE push_subscriptions continua em db.js (schema fica na
// Fase 1, junto com o resto da estrutura do banco) — aqui só as
// funções que leem/escrevem nessa tabela.
//
// Recebe a conexão `db` (better-sqlite3) já aberta, em vez de abrir a
// própria — só existe uma conexão com o banco no processo inteiro.

module.exports = function criarDbNotificacoesPush(db) {

  const SQL_UPSERT_PUSH_SUBSCRIPTION = `
    INSERT INTO push_subscriptions (endpoint, usuario_nome, p256dh, auth, user_agent, criado_em)
    VALUES (@endpoint, @usuario_nome, @p256dh, @auth, @user_agent, datetime('now'))
    ON CONFLICT(endpoint) DO UPDATE SET
      usuario_nome = @usuario_nome, p256dh = @p256dh, auth = @auth, user_agent = @user_agent
  `;

  /**
   * Salva (ou atualiza, se o endpoint já existir — ex: o navegador renovou
   * a inscrição) uma inscrição de notificação push pra um usuário
   * cadastrado. `subscription` é o objeto devolvido por
   * PushManager.subscribe() no navegador: { endpoint, keys: { p256dh, auth } }.
   */
  function salvarPushSubscription(usuarioNome, subscription, userAgent) {
    if (!usuarioNome) throw new Error('usuarioNome é obrigatório.');
    if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
      throw new Error('Inscrição de notificação inválida — faltam endpoint/keys.');
    }
    db.prepare(SQL_UPSERT_PUSH_SUBSCRIPTION).run({
      endpoint: subscription.endpoint,
      usuario_nome: usuarioNome,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      user_agent: userAgent || null,
    });
  }

  /** Remove 1 inscrição específica (usuário desativou pelo próprio dispositivo). */
  function removerPushSubscription(endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  /**
   * Remove uma inscrição que o próprio serviço de push informou como morta
   * (HTTP 404/410 — navegador desinstalado, permissão revogada no SO,
   * etc.) — ver lib/notificacoes-push.js, enviarParaTodos(). Mesmo efeito
   * de removerPushSubscription, nome separado só pra deixar claro QUEM
   * chama (o sistema, não o próprio usuário) nos logs/leitura do código.
   */
  function removerPushSubscriptionMorta(endpoint) {
    removerPushSubscription(endpoint);
  }

  /** 1 inscrição específica, ou undefined — usado só pra checar posse antes de remover (ver POST /push/desinscrever, lib/rotas/notificacoes.js). */
  function obterPushSubscriptionPorEndpoint(endpoint) {
    return db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
  }

  /** Todas as inscrições de 1 usuário (nome de cadastro, mesmo valor de nomeUsuario). */
  function listarPushSubscriptionsDoUsuario(usuarioNome) {
    return db.prepare('SELECT * FROM push_subscriptions WHERE usuario_nome = ?').all(usuarioNome);
  }

  /**
   * Todas as inscrições de uma LISTA de usuários — usada na hora de notificar
   * (ver lib/notificacoes-push.js): já resolvida a lista de quem deve
   * receber (perfil com a permissão marcada), busca de uma vez só as
   * inscrições de todos eles.
   */
  function listarPushSubscriptionsDosUsuarios(usuarioNomes) {
    if (!Array.isArray(usuarioNomes) || usuarioNomes.length === 0) return [];
    const placeholders = usuarioNomes.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM push_subscriptions WHERE usuario_nome IN (${placeholders})`).all(...usuarioNomes);
  }

  return {
    salvarPushSubscription,
    removerPushSubscription,
    removerPushSubscriptionMorta,
    obterPushSubscriptionPorEndpoint,
    listarPushSubscriptionsDoUsuario,
    listarPushSubscriptionsDosUsuarios,
  };
};
