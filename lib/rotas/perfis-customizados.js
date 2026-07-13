// ─── lib/rotas/perfis-customizados.js — CRUD de "Novo Tipo de Perfil" ─────
// Rotas cobertas: GET /catalogo-permissoes, GET /perfis-customizados,
// POST /criar-perfil-customizado, POST /editar-perfil-customizado,
// POST /excluir-perfil-customizado.
//
// GET /catalogo-permissoes é público (mesmo raciocínio de GET /perfis —
// só descreve "quais itens existem", não é segredo nenhum, e o front
// precisa dele pra montar o modal de criação de perfil). As 4 rotas de
// escrita/leitura completa exigem poderes de administrador (master ou
// perfil cadastrado "Administrador" — mesma checagem de sempre, `sessao`
// aqui já vem como o wrapper `sessaoOuAdmin` de server.js).

module.exports = function criarRotasPerfisCustomizados({ fs, path, PRIVATE_DIR, sessao, perfisCustomizados, itensPermissao }) {

  const USUARIOS_PATH = path.join(PRIVATE_DIR, 'usuarios.json');

  function semSessaoAdmin(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de Administrador necessária ou expirada.' }));
  }

  function lerCorpoJSON(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('JSON inválido no corpo da requisição.')); }
      });
    });
  }

  // Conta quantos usuários cadastrados usam um determinado perfil
  // customizado — usado por POST /excluir-perfil-customizado pra bloquear
  // a exclusão de um perfil ainda em uso (evita usuário órfão com um
  // "perfil" que não existe mais em lugar nenhum).
  function contarUsuariosDoPerfil(perfilId) {
    try {
      const usuarios = JSON.parse(fs.readFileSync(USUARIOS_PATH, 'utf8'));
      if (!Array.isArray(usuarios)) return 0;
      return usuarios.filter(u => u.perfil === perfilId).length;
    } catch (_) {
      return 0;
    }
  }

  return function tentar(req, res, urlPath) {

    if (req.method === 'GET' && urlPath === '/catalogo-permissoes') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, catalogo: itensPermissao.CATALOGO, niveis: itensPermissao.NIVEIS }));
      return true;
    }

    // Leitura pública (mesmo raciocínio de GET /usuarios e GET /perfis —
    // não é segredo nenhum, só descreve o que cada perfil customizado
    // pode fazer; front precisa disso sem exigir senha de Admin de novo
    // toda vez que só for exibir a lista ou abrir um perfil pra editar).
    if (req.method === 'GET' && urlPath === '/perfis-customizados') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, perfis: perfisCustomizados.listar() }));
      return true;
    }

    if (req.method === 'POST' && urlPath === '/criar-perfil-customizado') {
      if (!sessao.requestTemSessaoValida(req)) { semSessaoAdmin(res); return true; }
      lerCorpoJSON(req).then(payload => {
        try {
          const criado = perfisCustomizados.criar(payload || {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, perfil: criado }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      }).catch(e => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      });
      return true;
    }

    if (req.method === 'POST' && urlPath === '/editar-perfil-customizado') {
      if (!sessao.requestTemSessaoValida(req)) { semSessaoAdmin(res); return true; }
      lerCorpoJSON(req).then(payload => {
        try {
          if (!payload || typeof payload.id !== 'string' || !payload.id) {
            throw new Error('Campo "id" obrigatório.');
          }
          const atualizado = perfisCustomizados.editar(payload.id, payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, perfil: atualizado }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      }).catch(e => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      });
      return true;
    }

    if (req.method === 'POST' && urlPath === '/excluir-perfil-customizado') {
      if (!sessao.requestTemSessaoValida(req)) { semSessaoAdmin(res); return true; }
      lerCorpoJSON(req).then(payload => {
        try {
          if (!payload || typeof payload.id !== 'string' || !payload.id) {
            throw new Error('Campo "id" obrigatório.');
          }
          perfisCustomizados.excluir(payload.id, contarUsuariosDoPerfil);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      }).catch(e => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      });
      return true;
    }

    return false;
  };
};
