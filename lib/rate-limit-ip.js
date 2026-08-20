// ─── lib/rate-limit-ip.js — Rate limiting genérico por IP, persistido ──────
// Extraído pro Registro de Operação Offline (README, "Registro de Operação
// Offline (PWA) — plano", item 5: "rate limiting por IP, mesmo padrão já
// usado em /verificar-senha") — mas escrito GENÉRICO (nenhuma menção a
// senha/segredo aqui dentro) pra poder ser reaproveitado por qualquer outra
// rota sem sessão que precise da mesma proteção básica no futuro, em vez de
// ficar amarrado a lib/auth.js (que é especificamente sobre validar
// segredo do Administrador, com sua própria tabela SQL — ver
// lib/auth.js, "Rate limiting de tentativas de senha/chave de recuperação").
//
// MESMO RACIOCÍNIO de persistência que motivou lib/auth.js usar SQLite em
// vez de um Map em memória: um contador que zerasse a cada restart do
// processo (deploy, reboot, crash) dava uma folga completa de novo pra
// quem estivesse abusando da rota. Aqui, em vez de SQLite (não é o mesmo
// domínio de tabelas persistidas dos outros contadores, e esta rota nem
// tem lock de escrita concorrente — poucas chamadas), persiste num arquivo
// JSON próprio, no mesmo espírito de lib/fila-avaliacao.js/
// lib/fila-offline.js: lê tudo, mexe em memória, escreve tudo de volta —
// funciona bem no volume baixo esperado (poucas dezenas de envios offline
// por dia, no máximo).
//
// Uso:
//   const rl = criarRateLimitIp({ fs, path, caminhoArquivo, logger,
//     dominioLog: 'operacao-offline', maxTentativas: 20, janelaMs: 15*60*1000,
//     bloqueioMs: 15*60*1000 });
//   if (rl.estaBloqueado(req)) { ... 429 ... ; return; }
//   rl.registrarEnvio(req);
//   ... segue processando a requisição ...

module.exports = function criarRateLimitIp({
  fs, caminhoArquivo, logger, dominioLog,
  maxTentativas, janelaMs, bloqueioMs,
}) {

  function _ipDoRequest(req) {
    return (req.socket.remoteAddress || 'desconhecido').replace(/^::ffff:/, '');
  }

  function _lerEstado() {
    try {
      const texto = fs.readFileSync(caminhoArquivo, 'utf8').trim();
      return texto ? JSON.parse(texto) : {};
    } catch (_) {
      return {}; // arquivo ainda não existe/corrompido — trata como "ninguém tem histórico ainda"
    }
  }

  function _salvarEstado(estado) {
    const tmp = caminhoArquivo + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(estado, null, 2), 'utf8');
    fs.renameSync(tmp, caminhoArquivo);
  }

  function segundosRestantes(req) {
    const estado = _lerEstado();
    const registro = estado[_ipDoRequest(req)];
    if (!registro || !registro.bloqueadoAte) return 0;
    return Math.max(0, Math.ceil((registro.bloqueadoAte - Date.now()) / 1000));
  }

  function estaBloqueado(req) {
    const estado = _lerEstado();
    const ip = _ipDoRequest(req);
    const registro = estado[ip];
    const bloqueado = !!(registro && registro.bloqueadoAte && Date.now() < registro.bloqueadoAte);
    if (bloqueado) {
      logger.warn(dominioLog, 'requisição recusada — IP em rate limit', {
        ip, segundosRestantes: segundosRestantes(req),
      });
    }
    return bloqueado;
  }

  // Registra uma tentativa/envio deste IP — chamar depois de confirmar que
  // NÃO está bloqueado (estaBloqueado), pra toda requisição que passou pelo
  // gate, com sucesso ou falha de validação (o limite é sobre VOLUME de
  // chamadas à rota, não sobre "errar o payload" especificamente).
  function registrarEnvio(req) {
    const ip = _ipDoRequest(req);
    const agora = Date.now();
    const estado = _lerEstado();
    let registro = estado[ip];
    if (!registro || (agora - registro.primeiraEm) > janelaMs) {
      registro = { tentativas: 0, primeiraEm: agora, bloqueadoAte: null };
    }
    registro.tentativas += 1;
    const acabouDeBloquear = registro.tentativas >= maxTentativas && !registro.bloqueadoAte;
    if (registro.tentativas >= maxTentativas) {
      registro.bloqueadoAte = agora + bloqueioMs;
    }
    estado[ip] = registro;
    _salvarEstado(estado);

    if (acabouDeBloquear) {
      logger.warn(dominioLog, 'IP bloqueado por excesso de chamadas', {
        ip, tentativas: registro.tentativas, bloqueadoPorMinutos: Math.round(bloqueioMs / 60000),
      });
    }
  }

  return { estaBloqueado, registrarEnvio, segundosRestantes };
};
