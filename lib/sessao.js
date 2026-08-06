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
// Persistido em SQLite (tabela sessoes_admin, ver db.js) — ANTES vivia só
// num Map em memória, e um restart/deploy do servidor (ou o processo
// caindo por qualquer motivo) derrubava toda sessão de admin aberta na
// hora, sem aviso nenhum pra quem estava logado. Trocar pra SQLite reusa o
// mesmo banco que já existe pros dados de produção (nenhuma dependência
// nova) e resolve isso: um restart não desloga mais ninguém, a sessão só
// expira no horário normal dela. Não é um JWT nem nada assinado: continua
// sendo só um token aleatório grande o bastante pra não dar pra adivinhar,
// associado a uma validade — só que agora guardado no banco em vez da
// memória do processo.

const crypto = require('crypto');

module.exports = function criarSessao(db) {
  // ~10 anos — na prática "nunca expira" (mesmo padrão/motivo de
  // lib/dispositivo-cookie.js: DURACAO_MS = 10 * 365 dias). Era 30 minutos
  // (ação administrativa pontual); trocado a pedido, pra não pedir senha
  // de novo sempre que a sessão de Admin Master ficasse ociosa.
  //
  // Ressalva técnica: navegadores modernos (Chrome/Firefox/Safari, desde a
  // adoção do RFC 6265bis) IGNORAM um Max-Age de cookie maior que ~400
  // dias e limitam a esse teto sozinhos — ou seja, o cookie em si ainda
  // vai expirar (por decisão do navegador, não do servidor) depois de
  // ~13 meses sem reautenticar, mesmo com DURACAO_MS bem maior aqui. Não
  // tem como o servidor contornar esse teto — é aplicado pelo navegador.
  const DURACAO_MS = 10 * 365 * 24 * 60 * 60 * 1000;
  const NOME_COOKIE = 'lw_admin_sessao';

  function criarToken() {
    const token = crypto.randomBytes(32).toString('hex');
    db.criarSessaoAdmin(token, Date.now() + DURACAO_MS);
    return token;
  }

  function tokenValido(token) {
    return db.sessaoAdminValida(token);
  }

  function destruirToken(token) {
    db.destruirSessaoAdmin(token);
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

  // Limpeza periódica — evita a tabela crescer sem limite num servidor que
  // fica meses no ar (mesmo padrão do rate limiting em lib/auth.js).
  // `.unref()` pra este timer não impedir o processo de encerrar sozinho
  // (ex: nos testes, que matam o processo do servidor de teste direto).
  setInterval(() => db.limparSessoesAdminExpiradas(), 10 * 60 * 1000).unref();

  return {
    requestTemSessaoValida,
    criarCookieSessao,
    cookieDeLogout,
    logout,
  };
};
