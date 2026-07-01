// ─── lib/sessao.js — Sessão de Administrador ────────────────────────────────
// Antes desta mudança, NÃO havia sessão real no servidor (ver README,
// "Limitações conhecidas"): cada rota sensível reverificava a senha a cada
// chamada, e rotas "só de leitura" como GET /db/security.json eram
// servidas como arquivo estático comum — sem checagem nenhuma. Este módulo
// cobre o caso que faltava: depois de uma senha (ou chave de recuperação)
// confirmada com sucesso, o servidor emite um token de sessão (cookie
// HttpOnly) que algumas rotas sensíveis passam a exigir.
//
// Propositalmente NÃO substitui a re-verificação de senha das rotas mais
// destrutivas (restaurar-backup-dados, restaurar-backup-geral, etc.) — elas
// continuam pedindo a senha de novo a cada chamada, por design (defesa em
// profundidade, documentado já antes desta mudança). A sessão aqui cobre
// especificamente as rotas que não tinham NENHUMA proteção própria:
// GET /db/security.json e POST /salvar-security.
//
// Em memória (Map) — some se o servidor reiniciar, mesmo espírito do rate
// limiting em lib/auth.js. Não é um JWT nem nada assinado: é só um token
// aleatório grande o bastante pra não dar pra adivinhar, associado a uma
// validade, guardado no servidor.

const crypto = require('crypto');

module.exports = function criarSessao() {
  const DURACAO_MS = 30 * 60 * 1000; // 30 minutos
  const NOME_COOKIE = 'lw_admin_sessao';

  const _sessoes = new Map(); // token -> expiraEm (timestamp)

  function criarToken() {
    const token = crypto.randomBytes(32).toString('hex');
    _sessoes.set(token, Date.now() + DURACAO_MS);
    return token;
  }

  function tokenValido(token) {
    if (!token) return false;
    const expiraEm = _sessoes.get(token);
    if (!expiraEm) return false;
    if (Date.now() > expiraEm) {
      _sessoes.delete(token);
      return false;
    }
    return true;
  }

  function destruirToken(token) {
    if (token) _sessoes.delete(token);
  }

  // Extrai o token do cabeçalho Cookie do request, se houver.
  function tokenDoRequest(req) {
    const cabecalho = req.headers.cookie || '';
    const partes = cabecalho.split(';');
    for (const parte of partes) {
      const [chave, ...resto] = parte.trim().split('=');
      if (chave === NOME_COOKIE) return resto.join('=');
    }
    return null;
  }

  function requestTemSessaoValida(req) {
    return tokenValido(tokenDoRequest(req));
  }

  // Monta o cabeçalho Set-Cookie pra um novo token — HttpOnly (JS do
  // navegador não lê/escreve), SameSite=Strict (não vai em request de
  // outro site), sem `Secure` porque o README já documenta instalações
  // HTTP simples (VM sem HTTPS) — mesma realidade que motivou mandar a
  // senha em texto puro via POST em vez de usar crypto.subtle no front.
  function criarCookieSessao() {
    const token = criarToken();
    return `${NOME_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(DURACAO_MS / 1000)}; SameSite=Strict`;
  }

  // Cabeçalho Set-Cookie que IMEDIATAMENTE expira o cookie (logout).
  function cookieDeLogout() {
    return `${NOME_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`;
  }

  function logout(req) {
    destruirToken(tokenDoRequest(req));
  }

  // Limpeza periódica — evita a Map crescer sem limite num servidor que
  // fica meses no ar (mesmo padrão do rate limiting em lib/auth.js).
  setInterval(() => {
    const agora = Date.now();
    for (const [token, expiraEm] of _sessoes) {
      if (agora > expiraEm) _sessoes.delete(token);
    }
  }, 10 * 60 * 1000).unref();

  return {
    requestTemSessaoValida,
    criarCookieSessao,
    cookieDeLogout,
    logout,
  };
};
