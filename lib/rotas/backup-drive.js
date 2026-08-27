// ─── lib/rotas/backup-drive.js — Backup Automático no Google Drive ────────
// Passo 5 do plano (ver README, "Backup Automático no Google Drive").
// Segue o mesmo padrão factory + tentar(req,res,urlPath) dos demais
// módulos de lib/rotas/ (ver lib/rotas/dispositivos-autorizados.js pro
// exemplo mais simples de referência).
//
// Rotas cobertas:
//   GET  /backup-drive/status       — { conectado, email, ativo }
//   POST /backup-drive/autorizar    — { senha } → { url } (front redireciona)
//   GET  /backup-drive/callback     — recebido do Google (code + state)
//   POST /backup-drive/toggle       — { ativo } — liga/desliga sem desconectar
//   POST /backup-drive/desconectar  — { senha } — revoga + apaga credencial
//
// `autorizar` é POST (não GET) de propósito: precisamos confirmar a senha
// do Administrador ANTES de gerar a URL de consentimento do Google (mesma
// exigência de /mesclar-backup-dados, lib/rotas/backup.js — conectar uma
// conta externa que vai RECEBER dados da fábrica é uma ação sensível o
// bastante pra justificar reverificar senha, não só ter sessão aberta).
// O front recebe { url } e faz o redirecionamento ele mesmo
// (window.location.href = url).
//
// `state`: token aleatório de curta duração guardado em memória (Map),
// gerado no momento de /autorizar e conferido no /callback — protege
// contra um /callback "solto" sendo chamado sem ter passado por
// /autorizar primeiro (CSRF do fluxo OAuth). Em memória mesmo (não
// SQLite/arquivo) porque é um artefato de poucos minutos, não um dado que
// precise sobreviver a um restart do processo.

const crypto = require('crypto');
const logger = require('../logger');

const VALIDADE_STATE_MS = 10 * 60 * 1000; // 10 min — tempo de sobra pra pessoa passar pela tela do Google

module.exports = function criarRotasBackupDrive({ sessao, auth, googleDrive, backupDriveJson }) {

  const estadosPendentes = new Map(); // state -> timestamp de criação

  function limparEstadosExpirados() {
    const agora = Date.now();
    for (const [state, criadoEm] of estadosPendentes) {
      if (agora - criadoEm > VALIDADE_STATE_MS) estadosPendentes.delete(state);
    }
  }

  function semSessao(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
  }

  function responderErro(res, codigo, mensagem) {
    res.writeHead(codigo, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: mensagem }));
  }

  // Reverificação de senha do Administrador — mesmo fluxo de
  // /mesclar-backup-dados (lib/rotas/backup.js): rate limit por IP,
  // 503 dedicado se security.json estiver indisponível, senha errada
  // registra falha no rate limit. Devolve `true` se pôde seguir (já
  // respondeu o erro e retornou `false` caso contrário).
  function senhaAdminConfere(req, res, senha) {
    if (typeof senha !== 'string' || !senha) {
      responderErro(res, 400, 'Senha de administrador obrigatória.');
      return false;
    }
    if (auth.rateLimitEstaBloqueado(req)) {
      responderErro(res, 400, `Muitas tentativas erradas. Tente de novo em ${Math.ceil(auth.rateLimitSegundosRestantes(req) / 60)} min.`);
      return false;
    }
    let security;
    try {
      security = auth.lerSecurity();
    } catch (erroSecurity) {
      if (erroSecurity instanceof auth.ErroSecurityIndisponivel) {
        logger.error('auth', '/backup-drive: security.json indisponível', { erro: erroSecurity.message });
        responderErro(res, 503, 'Autenticação temporariamente indisponível. Contate o suporte técnico.');
        return false;
      }
      throw erroSecurity;
    }
    if (!auth.validarSegredo(senha, security.passwordHash, 'passwordHash')) {
      auth.rateLimitRegistrarFalha(req);
      responderErro(res, 400, 'Senha incorreta.');
      return false;
    }
    auth.rateLimitRegistrarSucesso(req);
    return true;
  }

  function lerCorpoJson(req, onOk, onErro) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        onOk(body ? JSON.parse(body) : {});
      } catch (e) {
        onErro(e);
      }
    });
  }

  function tentar(req, res, urlPath) {

    // GET /backup-drive/status — pra tela de Configurações renderizar o
    // card "Backup na Nuvem (Google Drive)". Não expõe refreshToken nem
    // pastaId, só o que a UI precisa mostrar.
    if (req.method === 'GET' && urlPath === '/backup-drive/status') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      const estado = backupDriveJson.ler();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        conectado: estado.conectado,
        email: estado.email,
        ativo: estado.ativo,
        credenciaisConfiguradas: googleDrive.credenciaisConfiguradas(),
      }));
      return true;
    }

    // POST /backup-drive/autorizar  { senha }
    // Confirma a senha, gera um `state` de uso único e devolve a URL de
    // consentimento do Google — o front é quem redireciona
    // (window.location.href), não o servidor.
    if (req.method === 'POST' && urlPath === '/backup-drive/autorizar') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      lerCorpoJson(req, (payload) => {
        try {
          if (!senhaAdminConfere(req, res, payload.senha)) return;

          if (!googleDrive.credenciaisConfiguradas()) {
            responderErro(res, 503, 'Integração com Google Drive ainda não configurada neste servidor (falta o Passo 1 do plano — GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI). Contate o suporte técnico.');
            return;
          }

          limparEstadosExpirados();
          const state = crypto.randomBytes(24).toString('hex');
          estadosPendentes.set(state, Date.now());

          const url = googleDrive.gerarUrlAutorizacao(state);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, url }));
        } catch (e) {
          logger.error('backup-drive', '/autorizar falhou', { erro: e.message });
          responderErro(res, 500, e.message);
        }
      }, () => responderErro(res, 400, 'JSON inválido.'));
      return true;
    }

    // GET /backup-drive/callback?code=...&state=...
    // Chamado pelo PRÓPRIO GOOGLE depois da pessoa autorizar (ou recusar)
    // na tela de consentimento — por isso não dá pra exigir sessão nem
    // senha aqui, a garantia de legitimidade é o `state` de uso único
    // gerado em /autorizar. Sempre redireciona de volta pra Configurações
    // com uma mensagem, nunca devolve JSON cru (a pessoa está vendo isso
    // no navegador, não é uma chamada de API do front).
    if (req.method === 'GET' && urlPath === '/backup-drive/callback') {
      (async () => {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const redirecionarPara = (msg, ok) => {
          const destino = `/?config=backup-drive&ok=${ok ? '1' : '0'}&msg=${encodeURIComponent(msg)}`;
          res.writeHead(302, { Location: destino });
          res.end();
        };

        try {
          const erroGoogle = params.get('error');
          if (erroGoogle) {
            redirecionarPara(`Autorização cancelada (${erroGoogle}).`, false);
            return;
          }

          const state = params.get('state');
          const code = params.get('code');
          limparEstadosExpirados();
          if (!state || !estadosPendentes.has(state)) {
            redirecionarPara('Link de autorização expirado ou inválido — tente conectar de novo.', false);
            return;
          }
          estadosPendentes.delete(state); // uso único

          if (!code) {
            redirecionarPara('Google não devolveu código de autorização.', false);
            return;
          }

          const { accessToken, refreshToken } = await googleDrive.trocarCodigoPorTokens(code);
          const email = await googleDrive.obterEmailDaConta(accessToken);
          backupDriveJson.salvarConexao({ email, refreshToken });

          logger.info('backup-drive', `conta conectada: ${email || '(e-mail não obtido)'}`);
          redirecionarPara(`Google Drive conectado${email ? ' (' + email + ')' : ''}.`, true);
        } catch (e) {
          logger.error('backup-drive', '/callback falhou', { erro: e.message });
          redirecionarPara('Falha ao conectar com o Google: ' + e.message, false);
        }
      })();
      return true;
    }

    // POST /backup-drive/toggle  { ativo: boolean }
    // Liga/desliga o envio automático sem desconectar a conta.
    if (req.method === 'POST' && urlPath === '/backup-drive/toggle') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      lerCorpoJson(req, (payload) => {
        const estadoAtual = backupDriveJson.ler();
        if (!estadoAtual.conectado) {
          responderErro(res, 400, 'Nenhuma conta Google conectada ainda.');
          return;
        }
        const novoEstado = backupDriveJson.definirAtivo(!!payload.ativo);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ativo: novoEstado.ativo }));
      }, () => responderErro(res, 400, 'JSON inválido.'));
      return true;
    }

    // POST /backup-drive/desconectar  { senha }
    // Revoga o token junto ao Google (best-effort) e apaga a credencial
    // local — a partir daqui o envio automático simplesmente para (job
    // em lib/rotas/backup.js checa `conectado`/`ativo` antes de tentar).
    if (req.method === 'POST' && urlPath === '/backup-drive/desconectar') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      lerCorpoJson(req, async (payload) => {
        try {
          if (!senhaAdminConfere(req, res, payload.senha)) return;

          const estado = backupDriveJson.ler();
          if (estado.conectado && estado.refreshToken) {
            await googleDrive.revogarToken(estado.refreshToken);
          }
          backupDriveJson.desconectar();
          logger.info('backup-drive', 'conta desconectada');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          logger.error('backup-drive', '/desconectar falhou', { erro: e.message });
          responderErro(res, 500, e.message);
        }
      }, () => responderErro(res, 400, 'JSON inválido.'));
      return true;
    }

    return false;
  }

  return { tentar };
};
