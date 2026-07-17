// ─── lib/rotas/dispositivos-autorizados.js — Dispositivos Autorizados ──────
// Volta a existir (ver conversa que motivou a mudança) uma trava por
// DISPOSITIVO (computador/navegador), além da trava por PESSOA que já
// existia (perfil + podeIniciarOperacao — ver lib/rotas/usuarios.js,
// lib/perfis.js). Já existiu antes deste mesmo jeito (lista de deviceIds
// em config.json), foi removida quando o sistema de perfis entrou, e
// agora volta — a checagem de verdade (dispositivoAutorizado(), usada por
// podeControlarOperacao()) fica em server.js; este módulo é só a
// ADMINISTRAÇÃO da lista: quem pode ver, autorizar e remover um
// dispositivo.
//
// Rotas: GET /dispositivos-autorizados, POST /autorizar-dispositivo,
// POST /remover-dispositivo.
//
// Todas exigem sessão de admin válida (master OU perfil Administrativo —
// ver `sessao: sessaoOuAdmin` no wiring, server.js) — gerenciar a lista é
// uma ação administrativa, mesmo padrão de /salvar-config e afins. Note a
// diferença: ter sessão de admin aqui autoriza GERENCIAR a lista, não
// pula a checagem de dispositivo em podeControlarOperacao() — mesmo o
// Administrador Master precisa que O DISPOSITIVO DELE esteja na lista
// pra controlar operações (pedido explícito do usuário).

module.exports = function criarRotasDispositivosAutorizados({ fs, path, DB_DIR, sessao }) {

  const CONFIG_PATH = path.join(DB_DIR, 'config.json');

  function semSessao(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
  }

  function lerConfig() {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (_) {
      return {};
    }
  }

  function salvarConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  }

  function listaAtual(cfg) {
    return Array.isArray(cfg.dispositivosAutorizados) ? cfg.dispositivosAutorizados : [];
  }

  return function tentar(req, res, urlPath) {

    // GET /dispositivos-autorizados — lista completa (deviceId, nome,
    // autorizadoEm) pra tela de Configurações → Dispositivos Autorizados.
    if (req.method === 'GET' && urlPath === '/dispositivos-autorizados') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, lista: listaAtual(lerConfig()) }));
      return true;
    }

    // POST /autorizar-dispositivo  { deviceId, nome }
    // Adiciona (ou atualiza o nome de, se o deviceId já existir) um
    // dispositivo na lista. `nome` é só um rótulo livre pra identificar
    // de qual computador se trata (ex: "PC da Injetora 1") — puramente
    // informativo, a checagem de verdade é sempre pelo deviceId.
    if (req.method === 'POST' && urlPath === '/autorizar-dispositivo') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { deviceId, nome } = JSON.parse(body);
          if (typeof deviceId !== 'string' || !deviceId.trim()) {
            throw new Error('deviceId é obrigatório.');
          }
          const cfg = lerConfig();
          const lista = listaAtual(cfg);
          const existente = lista.find(d => d && d.deviceId === deviceId);
          if (existente) {
            existente.nome = typeof nome === 'string' && nome.trim() ? nome.trim() : existente.nome || '';
          } else {
            lista.push({
              deviceId,
              nome: typeof nome === 'string' ? nome.trim() : '',
              autorizadoEm: new Date().toISOString(),
            });
          }
          cfg.dispositivosAutorizados = lista;
          salvarConfig(cfg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, lista }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // POST /remover-dispositivo  { deviceId }
    // Remove um dispositivo da lista — a partir da resposta desta rota,
    // aquele computador volta a ser barrado por dispositivoAutorizado()
    // em server.js, mesmo que a pessoa logada nele tenha permissão de
    // perfil de sobra.
    if (req.method === 'POST' && urlPath === '/remover-dispositivo') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { deviceId } = JSON.parse(body);
          if (typeof deviceId !== 'string' || !deviceId.trim()) {
            throw new Error('deviceId é obrigatório.');
          }
          const cfg = lerConfig();
          const lista = listaAtual(cfg).filter(d => d && d.deviceId !== deviceId);
          cfg.dispositivosAutorizados = lista;
          salvarConfig(cfg);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, lista }));
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
