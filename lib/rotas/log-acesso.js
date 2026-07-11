// ─── lib/rotas/log-acesso.js — Log de Acesso ────────────────────────────────
// Oitava fatia extraída de server.js (ver lib/rotas/operadores.js pro padrão
// completo). Rota coberta: POST /registrar-acesso.
//
// Domínio de 1 rota só, totalmente autocontido — nenhuma dependência
// compartilhada com outros domínios (ACESSOS_PATH/DIR_LOGS só são usados
// aqui, então a definição delas vem junto pra este módulo, diferente dos
// outros casos onde o helper precisou ficar em server.js).

module.exports = function criarRotasLogAcesso({ fs, path, ROOT_DIR }) {

  const DIR_LOGS = path.join(ROOT_DIR, 'logs');
  const ACESSOS_PATH = path.join(DIR_LOGS, 'acessos.json');

  return function tentar(req, res, urlPath) {

    // ── LOG DE ACESSO: registra ip + user-agent (do próprio request,
    // confiáveis) + deviceId (mandado pelo navegador) toda vez que a rota
    // informada é acessada. "rota" é livre (ex: '/operacao'), mas por
    // enquanto só a tela "Registrar Operação" chama isso (ver showPage() em
    // index.html) — é o primeiro passo pra, no futuro, restringir essa tela
    // a um único computador.
    if (req.method === 'POST' && urlPath === '/registrar-acesso') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error('Payload inválido.');
          }
          const rota = typeof payload.rota === 'string' ? payload.rota : '';
          if (!rota) throw new Error('Payload inválido: "rota" obrigatória.');
          const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : '';

          // IPv4 mapeado em IPv6 (ex: "::ffff:192.168.1.10") vem assim por
          // padrão do Node — remove o prefixo pra guardar só o IP "puro".
          const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
          const userAgent = req.headers['user-agent'] || '';

          const entrada = {
            ip,
            deviceId,
            data: new Date().toISOString(),
            rota,
            userAgent,
          };

          let acessos = [];
          try { acessos = JSON.parse(fs.readFileSync(ACESSOS_PATH, 'utf8') || '[]'); } catch (_) {}
          if (!Array.isArray(acessos)) acessos = [];
          acessos.push(entrada);

          fs.mkdirSync(DIR_LOGS, { recursive: true });
          const tmp = ACESSOS_PATH + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(acessos, null, 2), 'utf8');
          fs.renameSync(tmp, ACESSOS_PATH);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    return false;
  };
};
