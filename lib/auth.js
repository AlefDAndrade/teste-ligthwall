// ─── lib/auth.js — Autenticação do Administrador ───────────────────────────
// Extraído de server.js (1ª fatia da refatoração — ver README/conversa que
// motivou isso: server.js estava virando um arquivo único grande demais).
// É o MESMO código de antes, só movido pra um módulo próprio — nenhuma
// lógica foi alterada nesta extração. Cobre: hash de senha (scrypt, com
// compatibilidade pro formato legado SHA-256) e rate limiting de tentativas
// de senha/chave de recuperação por IP.
//
// Uso em server.js:
//   const auth = require('./lib/auth.js')(SECURITY_PATH);
//   auth.validarSegredo(senha, hashEsperado, 'passwordHash');
//
// É uma factory function (recebe o CAMINHO COMPLETO do arquivo security.json
// uma vez) em vez de um módulo com funções soltas, porque lerSecurity()/
// promoverHashSeNecessario() precisam saber onde esse arquivo vive — fechar
// isso aqui dentro evita ter que passar o caminho em toda chamada. Esse
// arquivo mora fora de public/ (ver server.js, SECURITY_PATH) — não é mais
// servido como estático comum; security.json não tinha proteção própria
// nenhuma antes desta mudança (ver README, "Limitações conhecidas").

const fs = require('fs');
const crypto = require('crypto');

module.exports = function criarAuth(SECURITY_PATH) {

  // ─── Utilitário: hash SHA-256 no servidor (Node.js crypto nativo) ──────────
  // Mantido só pela COMPATIBILIDADE com hashes antigos já salvos em
  // security.json (ver senhaCombinaComHash, abaixo) — nenhum hash NOVO é
  // gerado mais com SHA-256 puro (sem salt, rápido demais pra senha).
  function sha256(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  }

  // ─── Hash de senha: scrypt com salt (Node.js crypto nativo) ────────────────
  // Troca do SHA-256 puro (rápido, sem salt — vulnerável a rainbow table e a
  // força bruta por GPU) pelo scrypt nativo do Node: lento de propósito, e
  // com um salt aleatório por hash, então duas senhas iguais nunca geram o
  // mesmo hash salvo. Sem dependência nova — só `crypto`, que o projeto já
  // usa (evita repetir, pra isto, o problema de compilação nativa que
  // `better-sqlite3` já tem documentado no README).
  // Formato salvo: "scrypt:<salt em hex>:<hash em hex>".
  const SCRYPT_SALT_BYTES = 16;
  const SCRYPT_KEYLEN = 64;

  function gerarHashSenha(senha) {
    const salt = crypto.randomBytes(SCRYPT_SALT_BYTES).toString('hex');
    const hash = crypto.scryptSync(senha, salt, SCRYPT_KEYLEN).toString('hex');
    return `scrypt:${salt}:${hash}`;
  }

  // Compara `valor` (senha ou chave de recuperação) com um hash salvo,
  // aceitando tanto o formato novo ("scrypt:salt:hash") quanto hashes
  // ANTIGOS (SHA-256 puro, 64 caracteres hex, sem ":") já existentes em
  // instalações de antes desta mudança. Comparação em tempo constante
  // (timingSafeEqual), pra não dar pra inferir nada pelo tempo de resposta.
  function senhaCombinaComHash(valor, hashArmazenado) {
    if (typeof valor !== 'string' || typeof hashArmazenado !== 'string') return false;

    if (hashArmazenado.startsWith('scrypt:')) {
      const partes = hashArmazenado.split(':');
      if (partes.length !== 3) return false;
      const [, salt, hashEsperadoHex] = partes;
      const hashCalculadoHex = crypto.scryptSync(valor, salt, SCRYPT_KEYLEN).toString('hex');
      const bufCalculado = Buffer.from(hashCalculadoHex, 'hex');
      const bufEsperado = Buffer.from(hashEsperadoHex, 'hex');
      return bufCalculado.length === bufEsperado.length && crypto.timingSafeEqual(bufCalculado, bufEsperado);
    }

    // Formato legado (SHA-256 puro) — só pra aceitar hashes já salvos antes
    // desta mudança; nenhum hash novo é gerado neste formato (ver
    // promoverHashSeNecessario, que substitui pelo formato novo no 1º acerto).
    const bufCalculado = Buffer.from(sha256(valor), 'hex');
    let bufEsperado;
    try { bufEsperado = Buffer.from(hashArmazenado, 'hex'); } catch (_) { return false; }
    return bufCalculado.length === bufEsperado.length && crypto.timingSafeEqual(bufCalculado, bufEsperado);
  }

  // Se `hashArmazenado` ainda está no formato legado, regrava security.json
  // já com o hash novo (scrypt) pro campo indicado — migração transparente:
  // o Administrador não precisa trocar a senha manualmente pra ganhar o hash
  // mais forte, ela é promovida sozinha no primeiro acerto depois desta
  // mudança.
  function promoverHashSeNecessario(campo, hashArmazenado, valorTextoPlano) {
    if (typeof hashArmazenado === 'string' && hashArmazenado.startsWith('scrypt:')) return;
    try {
      const security = lerSecurity();
      security[campo] = gerarHashSenha(valorTextoPlano);
      fs.writeFileSync(SECURITY_PATH, JSON.stringify(security, null, 2), 'utf8');
    } catch (_) {
      // Não impede o login atual — só tenta promover de novo no próximo acerto.
    }
  }

  // Confere `valor` contra o hash salvo e, se bater via formato legado,
  // promove o campo automaticamente. Usado por toda rota que verifica senha
  // de administrador ou chave de recuperação.
  function validarSegredo(valor, hashArmazenado, campoParaPromover) {
    const ok = senhaCombinaComHash(valor, hashArmazenado);
    if (ok) promoverHashSeNecessario(campoParaPromover, hashArmazenado, valor);
    return ok;
  }

  // ─── Rate limiting de tentativas de senha/chave de recuperação (em memória) ─
  // Protege /verificar-senha, /verificar-recovery, /mesclar-backup-dados,
  // /restaurar-backup-dados e /restaurar-backup-geral (todas pedem a senha do
  // Administrador) contra força bruta: depois de muitas tentativas erradas do
  // mesmo IP numa janela de tempo, bloqueia temporariamente. As 5 rotas
  // compartilham o MESMO contador por IP — trocar de rota não reseta a
  // contagem. É em memória (zera se o servidor reiniciar) e por IP, não por
  // usuário (não há login de usuário aqui) — uma barreira prática contra
  // script de força bruta, não uma defesa de nível bancário (ver README,
  // limitações conhecidas, sobre não haver sessão real no servidor).
  const RATE_LIMIT_MAX_TENTATIVAS = 5;
  const RATE_LIMIT_JANELA_MS = 5 * 60 * 1000;   // janela em que as tentativas se acumulam
  const RATE_LIMIT_BLOQUEIO_MS = 5 * 60 * 1000; // bloqueio aplicado ao exceder o limite

  const _tentativasSenhaPorIp = new Map(); // ip -> { tentativas, primeiraEm, bloqueadoAte }

  function _ipDoRequest(req) {
    return (req.socket.remoteAddress || 'desconhecido').replace(/^::ffff:/, '');
  }

  function rateLimitEstaBloqueado(req) {
    const estado = _tentativasSenhaPorIp.get(_ipDoRequest(req));
    return !!(estado && estado.bloqueadoAte && Date.now() < estado.bloqueadoAte);
  }

  function rateLimitSegundosRestantes(req) {
    const estado = _tentativasSenhaPorIp.get(_ipDoRequest(req));
    if (!estado || !estado.bloqueadoAte) return 0;
    return Math.max(0, Math.ceil((estado.bloqueadoAte - Date.now()) / 1000));
  }

  function rateLimitRegistrarFalha(req) {
    const ip = _ipDoRequest(req);
    const agora = Date.now();
    let estado = _tentativasSenhaPorIp.get(ip);
    if (!estado || (agora - estado.primeiraEm) > RATE_LIMIT_JANELA_MS) {
      estado = { tentativas: 0, primeiraEm: agora, bloqueadoAte: null };
    }
    estado.tentativas += 1;
    if (estado.tentativas >= RATE_LIMIT_MAX_TENTATIVAS) {
      estado.bloqueadoAte = agora + RATE_LIMIT_BLOQUEIO_MS;
    }
    _tentativasSenhaPorIp.set(ip, estado);
  }

  function rateLimitRegistrarSucesso(req) {
    _tentativasSenhaPorIp.delete(_ipDoRequest(req));
  }

  // Limpeza periódica — evita a Map crescer sem limite num servidor que fica
  // meses no ar (mesmo espírito do README sobre backups-seguranca/ e logs/).
  setInterval(() => {
    const agora = Date.now();
    for (const [ip, estado] of _tentativasSenhaPorIp) {
      const semBloqueioAtivo = !estado.bloqueadoAte || estado.bloqueadoAte < agora;
      const janelaExpirada = (agora - estado.primeiraEm) > RATE_LIMIT_JANELA_MS;
      if (semBloqueioAtivo && janelaExpirada) _tentativasSenhaPorIp.delete(ip);
    }
  }, 10 * 60 * 1000).unref();

  // ─── Lê security.json do disco ────────────────────────────────────────────
  const HASH_FALLBACK = 'c415e920e0281339d3633ab0c19d3b11c5a70a52ad2e17e405ef66723c51294c';

  function lerSecurity() {
    try {
      return JSON.parse(fs.readFileSync(SECURITY_PATH, 'utf8'));
    } catch (_) {
      return { passwordHash: HASH_FALLBACK, recoveryKeyHash: null };
    }
  }

  // ─── Validação de formato de hash ──────────────────────────────────────────
  // Usada por /salvar-security (server.js) pra aceitar tanto o formato novo
  // quanto hashes legados (SHA-256 puro) já salvos antes desta mudança.
  const HEX_RE = /^[0-9a-f]{64}$/;
  const SCRYPT_RE = /^scrypt:[0-9a-f]+:[0-9a-f]+$/;
  function formatoDeHashValido(v) {
    return typeof v === 'string' && (HEX_RE.test(v) || SCRYPT_RE.test(v));
  }

  return {
    HASH_FALLBACK,
    lerSecurity,
    gerarHashSenha,
    validarSegredo,
    // Exportada à parte de validarSegredo — é a comparação PURA (sem o
    // efeito colateral de promover hash legado em security.json, que só
    // faz sentido pra senha do Administrador). Reaproveitada por
    // POST /login-usuario (ver lib/rotas/usuarios.js) pra verificar a
    // senha de um usuário cadastrado sem nenhuma ligação com security.json.
    senhaCombinaComHash,
    formatoDeHashValido,
    rateLimitEstaBloqueado,
    rateLimitSegundosRestantes,
    rateLimitRegistrarFalha,
    rateLimitRegistrarSucesso,
  };
};
