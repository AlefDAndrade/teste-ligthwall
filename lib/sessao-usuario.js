// ─── lib/sessao-usuario.js — Sessão de Usuário Cadastrado ──────────────────
// Sessão de quem faz login com usuário+senha (Operador, Analista,
// Qualidade, Manutenção, Administrativo — ver lib/perfis.js) — DIFERENTE
// de lib/sessao.js, que é só pro Administrador Master (senha única
// mestra, botão separado na tela de login). Os dois cookies coexistem:
// uma pessoa pode estar autenticada como usuário cadastrado (este
// módulo) e, na mesma aba, também abrir uma sessão de Admin Master pra
// alguma ação pontual (ex: mexer em Configurações) sem que uma
// derrube a outra.
//
// Guarda mais que só "válido ou não" (diferente de lib/sessao.js): cada
// token carrega {usuarioId, nomeUsuario, perfil, podeIniciarOperacao} —
// é o que permite ao servidor VALIDAR DE VERDADE (não só confiar no
// front) se aquela sessão pode acessar uma página ou iniciar uma
// operação (ver lib/perfis.js, paginaPermitida). Em memória (Map) — some
// se o servidor reiniciar, mesmo espírito de lib/sessao.js e do rate
// limiting em lib/auth.js.

const crypto = require('crypto');

module.exports = function criarSessaoUsuario() {
  // Turno de trabalho, não uma sessão administrativa pontual — 12h cobre
  // um turno inteiro (inclusive hora extra) sem precisar logar nunca no
  // meio do expediente; comparar com os 30min de lib/sessao.js (Admin
  // Master), que é uma ação rápida e sensível, não "ficar logado o dia
  // todo".
  const DURACAO_MS = 12 * 60 * 60 * 1000;
  const NOME_COOKIE = 'lw_usuario_sessao';

  const _sessoes = new Map(); // token -> { usuarioId, nomeUsuario, perfil, podeIniciarOperacao, expiraEm }

  function criarToken(dados) {
    const token = crypto.randomBytes(32).toString('hex');
    _sessoes.set(token, { ...dados, expiraEm: Date.now() + DURACAO_MS });
    return token;
  }

  function _sessaoValida(token) {
    if (!token) return null;
    const sessao = _sessoes.get(token);
    if (!sessao) return null;
    if (Date.now() > sessao.expiraEm) {
      _sessoes.delete(token);
      return null;
    }
    return sessao;
  }

  function tokenDoRequest(req) {
    const cabecalho = req.headers.cookie || '';
    const partes = cabecalho.split(';');
    for (const parte of partes) {
      const [chave, ...resto] = parte.trim().split('=');
      if (chave === NOME_COOKIE) return resto.join('=');
    }
    return null;
  }

  // Devolve os dados da sessão ({usuarioId, nomeUsuario, perfil,
  // podeIniciarOperacao}) se o request tiver um cookie válido, ou `null`
  // caso contrário — usado pelas rotas que precisam saber QUEM está
  // pedindo (não só "está autenticado ou não", ver lib/sessao.js), pra
  // decidir se aquele perfil específico pode fazer aquela ação
  // específica (ex: iniciar operação — ver lib/perfis.js,
  // PERFIS_COM_PAGINA_OPERACAO, e o campo podeIniciarOperacao de cada
  // usuário cadastrado).
  function dadosDaSessao(req) {
    return _sessaoValida(tokenDoRequest(req));
  }

  function requestTemSessaoValida(req) {
    return !!dadosDaSessao(req);
  }

  function criarCookieSessao(dados) {
    const token = criarToken(dados);
    return `${NOME_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(DURACAO_MS / 1000)}; SameSite=Strict`;
  }

  function cookieDeLogout() {
    return `${NOME_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict`;
  }

  function logout(req) {
    const token = tokenDoRequest(req);
    if (token) _sessoes.delete(token);
  }

  // Limpeza periódica — mesmo padrão de lib/sessao.js e lib/auth.js.
  setInterval(() => {
    const agora = Date.now();
    for (const [token, sessao] of _sessoes) {
      if (agora > sessao.expiraEm) _sessoes.delete(token);
    }
  }, 10 * 60 * 1000).unref();

  return {
    dadosDaSessao,
    requestTemSessaoValida,
    criarCookieSessao,
    cookieDeLogout,
    logout,
  };
};
