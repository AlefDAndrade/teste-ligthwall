// ─── lib/auth.js — Autenticação do Administrador ───────────────────────────
// Extraído de server.js (1ª fatia da refatoração — ver README/conversa que
// motivou isso: server.js estava virando um arquivo único grande demais).
// É o MESMO código de antes, só movido pra um módulo próprio — nenhuma
// lógica foi alterada nesta extração. Cobre: hash de senha (scrypt, com
// compatibilidade pro formato legado SHA-256) e rate limiting de tentativas
// de senha/chave de recuperação por IP.
//
// Uso em server.js:
//   const auth = require('./lib/auth.js')(SECURITY_PATH, db);
//   auth.validarSegredo(senha, hashEsperado, 'passwordHash');
//
// `db` (conexão já aberta do better-sqlite3, ver db.js) é usada só pelo
// rate limiting de tentativas (ver "Rate limiting de tentativas...",
// abaixo) — persistido em SQLite (tabela tentativas_senha_ip, db.js) em
// vez de um Map em memória, pra sobreviver a um restart do processo.
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
const logger = require('./logger');

// Erro dedicado pra "security.json existe mas não pôde ser lido/entendido"
// (permissão, disco, JSON corrompido) — DIFERENTE de "arquivo nunca
// existiu" (1ª instalação, ver criarSecurityInicial). As rotas que chamam
// lerSecurity() usam `instanceof ErroSecurityIndisponivel` pra responder
// 503 (autenticação indisponível) em vez de tratar como senha errada ou,
// pior, aceitar um hash conhecido/previsível — ver "Limitações
// conhecidas" no README e a conversa que motivou esta mudança: antes,
// QUALQUER falha de leitura (arquivo sumiu, corrompeu, ficou sem
// permissão) fazia o sistema aceitar um hash SHA-256 fixo, hardcoded no
// código-fonte — ou seja, uma senha previsível por qualquer um que visse
// o repositório. Isso viola "fail-safe defaults": uma falha num controle
// de segurança deve NEGAR acesso, nunca abrir uma porta lateral.
class ErroSecurityIndisponivel extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroSecurityIndisponivel';
  }
}

module.exports = function criarAuth(SECURITY_PATH, db) {

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

  // ─── Rate limiting de tentativas de senha/chave de recuperação (SQLite) ────
  // Protege /verificar-senha, /verificar-recovery, /mesclar-backup-dados,
  // /restaurar-backup-dados e /restaurar-backup-geral (todas pedem a senha do
  // Administrador) contra força bruta: depois de muitas tentativas erradas do
  // mesmo IP numa janela de tempo, bloqueia temporariamente. As 5 rotas
  // compartilham o MESMO contador por IP — trocar de rota não reseta a
  // contagem. Persistido na tabela tentativas_senha_ip (ver db.js) — POR
  // DESIGN diferente de um Map em memória: essas 3 primeiras rotas mexem em
  // restaurar/mesclar produção inteira usando uma senha ÚNICA e
  // COMPARTILHADA (não há conta por usuário aqui), então o rate limit é
  // praticamente a única barreira contra força bruta nelas — um contador que
  // zerasse a cada restart do processo (deploy, reboot, crash) dava uma
  // folga completa de novo pra quem estivesse testando senhas, sem precisar
  // de mais do que conseguir derrubar/esperar o servidor reiniciar. Por IP,
  // não por usuário (não há login de usuário nessas rotas) — uma barreira
  // prática contra script de força bruta, não uma defesa de nível bancário
  // (ver README, limitações conhecidas, sobre não haver sessão real no
  // servidor).
  const RATE_LIMIT_MAX_TENTATIVAS = 5;
  const RATE_LIMIT_JANELA_MS = 5 * 60 * 1000;   // janela em que as tentativas se acumulam
  const RATE_LIMIT_BLOQUEIO_MS = 5 * 60 * 1000; // bloqueio aplicado ao exceder o limite

  const _selecionarTentativas = db.prepare('SELECT tentativas, primeira_em, bloqueado_ate FROM tentativas_senha_ip WHERE ip = ?');
  const _upsertTentativas = db.prepare(`
    INSERT INTO tentativas_senha_ip (ip, tentativas, primeira_em, bloqueado_ate)
    VALUES (@ip, @tentativas, @primeira_em, @bloqueado_ate)
    ON CONFLICT(ip) DO UPDATE SET
      tentativas = @tentativas, primeira_em = @primeira_em, bloqueado_ate = @bloqueado_ate
  `);
  const _apagarTentativas = db.prepare('DELETE FROM tentativas_senha_ip WHERE ip = ?');

  function _ipDoRequest(req) {
    return (req.socket.remoteAddress || 'desconhecido').replace(/^::ffff:/, '');
  }

  function rateLimitEstaBloqueado(req) {
    const ip = _ipDoRequest(req);
    const estado = _selecionarTentativas.get(ip);
    const bloqueado = !!(estado && estado.bloqueado_ate && Date.now() < estado.bloqueado_ate);
    if (bloqueado) {
      // Cada request de um IP já bloqueado é um evento de segurança que
      // vale monitorar/alertar — quem está aqui já passou do limite de
      // tentativas e continua insistindo mesmo bloqueado.
      logger.warn('auth', 'requisição recusada — IP em rate limit (tentativas de senha)', {
        ip, segundosRestantes: rateLimitSegundosRestantes(req),
      });
    }
    return bloqueado;
  }

  function rateLimitSegundosRestantes(req) {
    const estado = _selecionarTentativas.get(_ipDoRequest(req));
    if (!estado || !estado.bloqueado_ate) return 0;
    return Math.max(0, Math.ceil((estado.bloqueado_ate - Date.now()) / 1000));
  }

  function rateLimitRegistrarFalha(req) {
    const ip = _ipDoRequest(req);
    const agora = Date.now();
    let estado = _selecionarTentativas.get(ip);
    if (!estado || (agora - estado.primeira_em) > RATE_LIMIT_JANELA_MS) {
      estado = { tentativas: 0, primeira_em: agora, bloqueado_ate: null };
    }
    estado.tentativas += 1;
    const acabouDeBloquear = estado.tentativas >= RATE_LIMIT_MAX_TENTATIVAS && !estado.bloqueado_ate;
    if (estado.tentativas >= RATE_LIMIT_MAX_TENTATIVAS) {
      estado.bloqueado_ate = agora + RATE_LIMIT_BLOQUEIO_MS;
    }
    _upsertTentativas.run({ ip, tentativas: estado.tentativas, primeira_em: estado.primeira_em, bloqueado_ate: estado.bloqueado_ate });

    if (acabouDeBloquear) {
      // Log no momento exato em que o bloqueio COMEÇA (não a cada falha) —
      // um único evento por bloqueio, fácil de alertar em cima sem virar
      // ruído a cada tentativa errada normal (senha digitada errado 1-2x
      // não é, por si só, um sinal de força bruta).
      logger.warn('auth', 'IP bloqueado por excesso de tentativas de senha erradas', {
        ip, tentativas: estado.tentativas, bloqueadoPorMinutos: Math.round(RATE_LIMIT_BLOQUEIO_MS / 60000),
      });
    }
  }

  function rateLimitRegistrarSucesso(req) {
    _apagarTentativas.run(_ipDoRequest(req));
  }

  // Limpeza periódica — evita a tabela crescer sem limite num servidor que
  // fica meses no ar (mesmo espírito do README sobre backups-seguranca/ e
  // logs/). Só apaga IP que não está bloqueado agora E cuja janela de
  // acúmulo já expirou — mesma regra de antes, só que contra a tabela.
  setInterval(() => {
    const agora = Date.now();
    db.prepare(`
      DELETE FROM tentativas_senha_ip
      WHERE (bloqueado_ate IS NULL OR bloqueado_ate < @agora)
        AND (@agora - primeira_em) > @janela
    `).run({ agora, janela: RATE_LIMIT_JANELA_MS });
  }, 10 * 60 * 1000).unref();

  // ─── Lê security.json do disco ────────────────────────────────────────────
  // Antes, QUALQUER erro aqui (arquivo ausente, corrompido, sem permissão)
  // caía pro mesmo hash fixo (HASH_FALLBACK, removido nesta mudança) —
  // uma senha previsível, hardcoded no código-fonte, que qualquer um com
  // acesso ao repositório conhecia. Agora os dois cenários são tratados
  // de forma bem diferente:
  //
  //   1. ENOENT (arquivo NUNCA existiu) → 1ª execução de verdade, nunca
  //      houve configuração nenhuma. Único caso em que é seguro criar uma
  //      credencial nova — mas em vez de um hash fixo igual pra todo
  //      mundo, gera uma senha ALEATÓRIA por instalação e mostra ela UMA
  //      vez no log do servidor (ver criarSecurityInicial), pedindo pra
  //      trocar assim que possível.
  //   2. Qualquer outro erro (permissão, disco, JSON corrompido) →
  //      arquivo EXISTE mas algo deu errado — isso não é "instalação
  //      nova", é uma instalação já configurada com um problema. Falha
  //      FECHADA: lança ErroSecurityIndisponivel, que as rotas
  //      (lib/rotas/autenticacao.js, lib/rotas/backup.js) tratam como
  //      "autenticação temporariamente indisponível" (503) — NUNCA como
  //      senha aceita.
  function criarSecurityInicial() {
    // 12 bytes = 16 caracteres em base64url — só letras/números/-/_,
    // fácil de copiar do terminal sem confundir maiúscula/minúscula.
    const senhaInicial = crypto.randomBytes(12).toString('base64url');
    const security = { passwordHash: gerarHashSenha(senhaInicial), recoveryKeyHash: null };
    fs.mkdirSync(require('path').dirname(SECURITY_PATH), { recursive: true });
    fs.writeFileSync(SECURITY_PATH, JSON.stringify(security, null, 2), 'utf8');
    // Só sai no log do servidor (nunca por HTTP) — mesmo espírito de uma
    // senha de root gerada na instalação de um sistema operacional.
    logger.raw('\n' + '='.repeat(72));
    logger.raw('security.json não existia — 1ª execução deste servidor.');
    logger.raw('Senha inicial do Administrador (só aparece agora, anote):');
    logger.raw('  ' + senhaInicial);
    logger.raw('Troque assim que possível (Configurações → Segurança do Administrador).');
    logger.raw('='.repeat(72) + '\n');
    return security;
  }

  function lerSecurity() {
    let bruto;
    try {
      bruto = fs.readFileSync(SECURITY_PATH, 'utf8');
    } catch (erroLeitura) {
      if (erroLeitura.code === 'ENOENT') return criarSecurityInicial();
      throw new ErroSecurityIndisponivel(
        `Não foi possível ler o arquivo de segurança (${erroLeitura.code || erroLeitura.message}).`
      );
    }
    try {
      return JSON.parse(bruto);
    } catch (_) {
      throw new ErroSecurityIndisponivel('Arquivo de segurança corrompido (JSON inválido).');
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
    ErroSecurityIndisponivel,
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
