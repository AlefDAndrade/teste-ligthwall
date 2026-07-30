// ─── lib/db/sessoes.js — Sessões (Fase 5 do fatiamento de db.js) ───
// Extraído de db.js sem mudar nenhuma lógica — só onde o código mora.
// Ver README.md, seção "Fatiamento de db.js (plano)".
//
// CREATE TABLE sessoes_admin/sessoes_usuario continua em db.js (schema
// fica na Fase 1, junto com o resto da estrutura do banco) — aqui só
// as funções que leem/escrevem nessas tabelas.
//
// Consultadas por lib/sessao.js (Admin Master) e lib/sessao-usuario.js
// (Usuário Cadastrado) no lugar do Map em memória de antes — mesmo
// contrato (token -> válido/dados), só que sobrevive a um restart do
// processo. Cada módulo continua sozinho responsável por gerar o
// token, montar o cookie e decidir a duração; aqui só persiste/lê/apaga.
//
// Recebe a conexão `db` (better-sqlite3) já aberta, em vez de abrir a
// própria — só existe uma conexão com o banco no processo inteiro.

module.exports = function criarDbSessoes(db) {

  function criarSessaoAdmin(token, expiraEm) {
    db.prepare('INSERT INTO sessoes_admin (token, expira_em) VALUES (?, ?)').run(token, expiraEm);
  }

  /** Devolve `true`/`false` — já apaga a linha sozinho se tiver expirado (evita acumular lixo até a limpeza periódica passar). */
  function sessaoAdminValida(token) {
    if (!token) return false;
    const linha = db.prepare('SELECT expira_em FROM sessoes_admin WHERE token = ?').get(token);
    if (!linha) return false;
    if (Date.now() > linha.expira_em) {
      db.prepare('DELETE FROM sessoes_admin WHERE token = ?').run(token);
      return false;
    }
    return true;
  }

  function destruirSessaoAdmin(token) {
    if (token) db.prepare('DELETE FROM sessoes_admin WHERE token = ?').run(token);
  }

  /** Apaga todas as sessões de admin já expiradas — chamado periodicamente por lib/sessao.js. */
  function limparSessoesAdminExpiradas() {
    db.prepare('DELETE FROM sessoes_admin WHERE expira_em < ?').run(Date.now());
  }

  function criarSessaoUsuario(token, dados, expiraEm) {
    db.prepare('INSERT INTO sessoes_usuario (token, dados_json, expira_em) VALUES (?, ?, ?)')
      .run(token, JSON.stringify(dados), expiraEm);
  }

  /** Devolve os dados salvos ({usuarioId, nomeUsuario, perfil, podeIniciarOperacao}) ou `null` se não houver sessão válida — já apaga sozinho se expirada, mesmo raciocínio de sessaoAdminValida. */
  function dadosSessaoUsuario(token) {
    if (!token) return null;
    const linha = db.prepare('SELECT dados_json, expira_em FROM sessoes_usuario WHERE token = ?').get(token);
    if (!linha) return null;
    if (Date.now() > linha.expira_em) {
      db.prepare('DELETE FROM sessoes_usuario WHERE token = ?').run(token);
      return null;
    }
    return JSON.parse(linha.dados_json);
  }

  function destruirSessaoUsuario(token) {
    if (token) db.prepare('DELETE FROM sessoes_usuario WHERE token = ?').run(token);
  }

  /** Apaga todas as sessões de usuário já expiradas — chamado periodicamente por lib/sessao-usuario.js. */
  function limparSessoesUsuarioExpiradas() {
    db.prepare('DELETE FROM sessoes_usuario WHERE expira_em < ?').run(Date.now());
  }

  return {
    criarSessaoAdmin,
    sessaoAdminValida,
    destruirSessaoAdmin,
    limparSessoesAdminExpiradas,
    criarSessaoUsuario,
    dadosSessaoUsuario,
    destruirSessaoUsuario,
    limparSessoesUsuarioExpiradas,
  };
};
