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
// operação (ver lib/perfis.js, paginaPermitida).
//
// Persistido em SQLite (tabela sessoes_usuario, ver db.js) — ANTES vivia
// só num Map em memória, mesmo espírito de lib/sessao.js. Aqui o impacto
// era maior ainda: a duração é de 12h (um turno inteiro), então um
// restart/deploy do servidor no MEIO do turno derrubava todo mundo
// logado no chão de fábrica ao mesmo tempo, sem aviso, obrigando login
// de novo em cada estação. Trocar pra SQLite (mesmo banco que já existe
// pros dados de produção, sem dependência nova) resolve isso: a sessão
// sobrevive a um restart do processo, só expira no horário normal dela.

const crypto = require('crypto');

module.exports = function criarSessaoUsuario(db) {
  // Turno de trabalho, não uma sessão administrativa pontual — 12h cobre
  // um turno inteiro (inclusive hora extra) sem precisar logar nunca no
  // meio do expediente; comparar com os 30min de lib/sessao.js (Admin
  // Master), que é uma ação rápida e sensível, não "ficar logado o dia
  // todo".
  const DURACAO_MS = 12 * 60 * 60 * 1000;
  const NOME_COOKIE = 'lw_usuario_sessao';

  function criarToken(dados) {
    const token = crypto.randomBytes(32).toString('hex');
    db.criarSessaoUsuario(token, dados, Date.now() + DURACAO_MS);
    return token;
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
  // PERFIS_COM_CONTROLE_DE_OPERACAO, e o campo podeIniciarOperacao de cada
  // usuário cadastrado).
  function dadosDaSessao(req) {
    return db.dadosSessaoUsuario(tokenDoRequest(req));
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
    db.destruirSessaoUsuario(tokenDoRequest(req));
  }

  // Limpeza periódica — mesmo padrão de lib/sessao.js e lib/auth.js.
  setInterval(() => db.limparSessoesUsuarioExpiradas(), 10 * 60 * 1000).unref();

  return {
    dadosDaSessao,
    requestTemSessaoValida,
    criarCookieSessao,
    cookieDeLogout,
    logout,
  };
};
