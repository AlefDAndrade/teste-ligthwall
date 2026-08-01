// ─── lib/security-json.js — security.json (fora de public/) ───────────────
// Fase 17 do fatiamento de server.js (ver README, "Fatiamento de server.js"
// → "Plano de continuidade"). Único consumidor direto de SECURITY_PATH hoje
// é lib/rotas/autenticacao.js (lê/grava o arquivo nas rotas de auth) — mas
// lib/auth.js e lib/rotas/backup.js também recebem o caminho (SECURITY_PATH)
// injetado por fora, sem depender de nada definido AQUI além do valor do
// caminho em si; por isso a extração ficou só neste pedaço (garantir que
// private/ existe + resolver o caminho + migração automática), sem tentar
// mover pra cá lógica de leitura/escrita que já mora em lib/auth.js.
//
// Antes, security.json vivia em public/db/ — e por isso era servido como
// arquivo estático comum (GET /db/security.json acessível por qualquer um,
// sem senha nenhuma; ver README, "Limitações conhecidas"). Agora mora em
// private/ (irmã de public/, nunca servida como estático — mesmo padrão já
// usado por backups-seguranca/ e logs/). O acesso por HTTP passa a exigir
// uma sessão de admin válida (ver GET /db/security.json em
// lib/rotas/autenticacao.js, e lib/sessao.js) — a URL que o navegador usa
// não muda, só fica protegida.
//
// PRIVATE_DIR é devolvido junto (não só SECURITY_PATH) porque server.js
// ainda precisa dele pra montar USUARIOS_PATH e PERFIS_CUSTOMIZADOS_PATH
// (usuarios.json, perfis-customizados.json — arquivos-irmãos de
// security.json, mesmo motivo de segurança, mas fora do escopo desta fase)
// e pra injetar em outras factories (perfis-customizados.js,
// perfis-fixos-overrides.js, notificacoes-push.js, lib/rotas/usuarios.js,
// lib/rotas/perfis-customizados.js) — sem isso, server.js precisaria
// recalcular path.join(ROOT_DIR, 'private') de novo por conta própria.

module.exports = function criarSecurityJson({ fs, path, ROOT_DIR, DB_DIR }) {

  const PRIVATE_DIR = path.join(ROOT_DIR, 'private');
  const SECURITY_PATH = path.join(PRIVATE_DIR, 'security.json');
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });

  // Migração automática, só na 1ª vez que sobe depois desta mudança: se o
  // arquivo antigo (public/db/security.json) ainda existir e o novo ainda
  // não, copia o conteúdo pro novo lugar e RENOMEIA o antigo (nunca apaga —
  // mesmo padrão das migrações de db.js, que preferem deixar um rastro
  // "<nome>.migrado-<timestamp>" a apagar dados).
  (function migrarSecurityJsonSeNecessario() {
    const caminhoAntigo = path.join(DB_DIR, 'security.json');
    if (fs.existsSync(SECURITY_PATH)) return; // já migrado
    if (!fs.existsSync(caminhoAntigo)) return; // instalação nova — nada pra migrar
    fs.copyFileSync(caminhoAntigo, SECURITY_PATH);
    fs.renameSync(caminhoAntigo, caminhoAntigo + `.migrado-${Date.now()}`);
  })();

  return { PRIVATE_DIR, SECURITY_PATH };
};
