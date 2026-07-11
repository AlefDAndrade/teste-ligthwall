// ─── lib/rotas/autenticacao.js — Autenticação, Sessão e Configurações ──────
// Décima segunda fatia extraída de server.js (ver lib/rotas/operadores.js
// pro padrão completo). Rotas cobertas: POST /verificar-senha,
// POST /verificar-recovery, POST /gerar-hash, POST /salvar-config,
// POST /salvar-metas, POST /config/modo-automatico, POST /salvar-security,
// GET /db/security.json, POST /logout-admin.
//
// Todas dependem de `auth` (lib/auth.js) e/ou `sessao` (lib/sessao.js) —
// os dois módulos já extraídos ANTES desta série (Fases 1 e 2). Este
// módulo é o que efetivamente USA os dois pra autenticar e emitir/checar
// sessão — antes ficava espalhado direto em server.js.

module.exports = function criarRotasAutenticacao({ fs, path, DB_DIR, SECURITY_PATH, auth, sessao }) {

  function semSessao(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
  }

  return function tentar(req, res, urlPath) {

    // ── Verificar senha admin no servidor ──────────────────────────────────
    // POST /verificar-senha  { senha: "texto plano" }
    // Retorna { ok: true } se correta, { ok: false } se incorreta.
    // A senha nunca é logada — apenas comparada com o hash em security.json.
    // Protegida por rate limiting (ver validarSegredo/rateLimit*, lib/auth.js):
    // depois de muitas tentativas erradas do mesmo IP, responde 429 em vez
    // de continuar testando a senha enviada.
    if (req.method === 'POST' && urlPath === '/verificar-senha') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          if (auth.rateLimitEstaBloqueado(req)) {
            const segundos = auth.rateLimitSegundosRestantes(req);
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(segundos) });
            res.end(JSON.stringify({ ok: false, erro: `Muitas tentativas erradas. Tente de novo em ${Math.ceil(segundos / 60)} min.` }));
            return;
          }
          const { senha } = JSON.parse(body);
          if (typeof senha !== 'string') throw new Error('Payload inválido.');
          const security = auth.lerSecurity();
          const hashEsperado = security.passwordHash || auth.HASH_FALLBACK;
          const ok = auth.validarSegredo(senha, hashEsperado, 'passwordHash');
          const headers = { 'Content-Type': 'application/json' };
          if (ok) {
            auth.rateLimitRegistrarSucesso(req);
            // Emite sessão (ver lib/sessao.js) — usada por GET /db/security.json
            // e POST /salvar-security, que não tinham proteção própria nenhuma
            // antes desta mudança.
            headers['Set-Cookie'] = sessao.criarCookieSessao();
          } else {
            auth.rateLimitRegistrarFalha(req);
          }
          res.writeHead(200, headers);
          res.end(JSON.stringify({ ok }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── Verificar arquivo de recuperação no servidor ───────────────────────
    // POST /verificar-recovery  { chave: "conteudo do .key" }
    // Retorna { ok: true } se válido. Mesmo rate limiting de /verificar-senha
    // (contador compartilhado por IP — ver rateLimit*, lib/auth.js).
    if (req.method === 'POST' && urlPath === '/verificar-recovery') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          if (auth.rateLimitEstaBloqueado(req)) {
            const segundos = auth.rateLimitSegundosRestantes(req);
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(segundos) });
            res.end(JSON.stringify({ ok: false, erro: `Muitas tentativas erradas. Tente de novo em ${Math.ceil(segundos / 60)} min.` }));
            return;
          }
          const { chave } = JSON.parse(body);
          if (typeof chave !== 'string') throw new Error('Payload inválido.');
          const security = auth.lerSecurity();
          if (!security.recoveryKeyHash) {
            auth.rateLimitRegistrarFalha(req);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false }));
            return;
          }
          const ok = auth.validarSegredo(chave.trim(), security.recoveryKeyHash, 'recoveryKeyHash');
          const headers = { 'Content-Type': 'application/json' };
          if (ok) {
            auth.rateLimitRegistrarSucesso(req);
            // Mesma sessão de /verificar-senha — é o que permite o fluxo de
            // recuperação chamar POST /salvar-security depois (ver
            // admin-auth.js, _salvarNovaSenha) sem precisar reenviar a chave.
            headers['Set-Cookie'] = sessao.criarCookieSessao();
          } else {
            auth.rateLimitRegistrarFalha(req);
          }
          res.writeHead(200, headers);
          res.end(JSON.stringify({ ok }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── Gerar hash de uma senha no servidor ────────────────────────────────
    // POST /gerar-hash  { senha: "texto plano" }
    // Retorna { hash: "scrypt:salt:hash" } — usado ao redefinir senha via
    // recuperação ou troca normal de senha (ver admin-auth.js). Antes gerava
    // SHA-256 puro; agora sempre gera no formato novo (scrypt com salt).
    if (req.method === 'POST' && urlPath === '/gerar-hash') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { senha } = JSON.parse(body);
          if (typeof senha !== 'string') throw new Error('Payload inválido.');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ hash: auth.gerarHashSenha(senha) }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // Salvar config.json via POST
    // ── Antes desta mudança, esta rota não exigia NADA — nem senha, nem
    // sessão (README, "Limitações conhecidas") — apesar de controlar
    // baterias, tipos de montagem e dispositivos autorizados. Agora exige
    // a mesma sessão de Administrador das demais rotas administrativas
    // (ver lib/sessao.js) — o front (app-core.js, cfgSalvar) já chama
    // AdminAuth.abrirModal antes de mandar pra cá.
    if (req.method === 'POST' && urlPath === '/salvar-config') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const cfg = JSON.parse(body);
          fs.writeFileSync(path.join(DB_DIR, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── POST /salvar-metas: metas de produção do mês (traços/m²/OEE) —
    // Página de Metas (ver public/js/metas.js). Arquivo PRÓPRIO
    // (metas.json), separado de config.json de propósito: /salvar-config
    // (acima) sobrescreve o arquivo INTEIRO — reaproveitar essa rota pra
    // metas exigiria montar o config.json completo no front toda vez que
    // salvasse uma meta, com risco real de apagar baterias/tipos de
    // montagem/dispositivos autorizados se o front esquecesse de incluir
    // algum bloco (já aconteceu antes com outros campos, ver comentário em
    // _configAtualBaseParaSalvar, app-core.js). Um arquivo pequeno e
    // isolado não tem esse risco.
    // Exige sessão de admin (ver lib/sessao.js), mesma exigência de
    // /salvar-config, acima — unificado junto com ele.
    if (req.method === 'POST' && urlPath === '/salvar-metas') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const metas = JSON.parse(body);
          if (!metas || typeof metas !== 'object' || Array.isArray(metas)) {
            throw new Error('Payload inválido.');
          }
          const CAMPOS_METAS = ['tracosMes', 'm2Mes', 'oeePercentMes'];
          const metasLimpas = {};
          CAMPOS_METAS.forEach(campo => {
            const v = metas[campo];
            if (v === null || v === undefined || v === '') { metasLimpas[campo] = null; return; }
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0) throw new Error(`Campo "${campo}" precisa ser um número positivo ou vazio.`);
            metasLimpas[campo] = n;
          });
          fs.writeFileSync(path.join(DB_DIR, 'metas.json'), JSON.stringify(metasLimpas, null, 2), 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, metas: metasLimpas }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── POST /config/modo-automatico: liga/desliga "🤖 Modo Automático"
    // (Configurações → Automação). DIFERENTE de /salvar-config (acima, que
    // não exige sessão): esta rota exige sessão de admin válida — a senha
    // é pedida de novo no front (ver app-core.js, cfgToggleModoAutomatico,
    // que sempre chama AdminAuth.abrirModal antes, tanto pra ligar quanto
    // pra desligar), e o servidor confirma que essa sessão existe de
    // verdade antes de aceitar a troca — proteção de verdade, não só de UI.
    if (req.method === 'POST' && urlPath === '/config/modo-automatico') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { ativo } = JSON.parse(body);
          if (typeof ativo !== 'boolean') throw new Error('Campo "ativo" precisa ser true ou false.');

          const configPath = path.join(DB_DIR, 'config.json');
          const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          cfg.modoAutomatico = ativo;
          fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ativo }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // Salvar security.json via POST
    // ── IMPORTANTE: antes desta mudança, esta rota não exigia senha NEM
    // sessão — bastava mandar um hash no formato certo pra sobrescrever a
    // senha do Administrador sem precisar saber a senha atual. Agora exige
    // uma sessão válida (ver lib/sessao.js), criada em /verificar-senha ou
    // /verificar-recovery — as duas formas de chegar até aqui legitimamente
    // (troca de senha via recuperação é o único fluxo que usa esta rota
    // hoje, ver admin-auth.js, _salvarNovaSenha).
    if (req.method === 'POST' && urlPath === '/salvar-security') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          // Aceita tanto o formato novo ("scrypt:salt:hash", gerado por
          // /gerar-hash a partir desta mudança) quanto o formato legado
          // (SHA-256 puro, 64 hex) — necessário porque, ao trocar só a
          // senha, o front reenvia o recoveryKeyHash ATUAL sem alterar (ver
          // admin-auth.js, _salvarNovaSenha), que pode ainda estar no
          // formato antigo se a chave de recuperação nunca foi regerada.
          // Validação centralizada em lib/auth.js (auth.formatoDeHashValido).
          if (!auth.formatoDeHashValido(payload.passwordHash) || !auth.formatoDeHashValido(payload.recoveryKeyHash)) {
            throw new Error('Payload inválido: hash de senha em formato inesperado.');
          }
          fs.writeFileSync(SECURITY_PATH, JSON.stringify({
            passwordHash:    payload.passwordHash,
            recoveryKeyHash: payload.recoveryKeyHash,
          }, null, 2), 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── GET /db/security.json: ANTES desta mudança, era servido como arquivo
    // estático comum (qualquer um podia acessar /db/security.json direto,
    // sem senha — ver README, "Limitações conhecidas"). O arquivo de verdade
    // já não vive mais em public/ (ver SECURITY_PATH) — então essa URL só
    // funciona se vier com sessão válida (ver lib/sessao.js). É a mesma URL
    // de sempre porque dois lugares no front ainda fazem fetch('db/security.json')
    // direto: admin-auth.js (pra preservar o recoveryKeyHash atual ao trocar
    // de senha) e data.js (LW.gerarBackupDados(), pro "Backup de Dados").
    // Os dois só rodam depois de uma senha/chave de recuperação confirmada,
    // então a sessão já existe nesse ponto — nenhuma mudança no front foi
    // necessária além disso.
    if (req.method === 'GET' && urlPath === '/db/security.json') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      try {
        const conteudo = fs.readFileSync(SECURITY_PATH, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(conteudo);
      } catch (_) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ passwordHash: auth.HASH_FALLBACK, recoveryKeyHash: null }));
      }
      return true;
    }

    // ── POST /logout-admin: destrói a sessão (ver lib/sessao.js) e expira o
    // cookie no navegador. Chamado por AdminAuth.logout() (admin-auth.js)
    // antes de limpar o localStorage e voltar pro login — sem isso, a sessão
    // no servidor continuaria válida até o tempo expirar por conta própria.
    if (req.method === 'POST' && urlPath === '/logout-admin') {
      sessao.logout(req);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': sessao.cookieDeLogout() });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    return false;
  };
};
