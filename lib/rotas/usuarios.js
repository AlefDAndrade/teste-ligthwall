// ─── lib/rotas/usuarios.js — Cadastro e Login de Usuários com Perfil ───────
// Sistema de login novo (ver conversa que motivou isso): a tela de login
// deixou de ser "escolha seu papel" (Operador/Analista, sem senha) e
// passou a ser usuário+senha de verdade — o PERFIL de cada pessoa (e,
// portanto, o que ela pode acessar) é definido no cadastro pelo
// Administrador Master, não escolhido por quem loga.
//
// Aqui é autenticação e AUTORIZAÇÃO de verdade — decide quais páginas a
// pessoa pode ver (ver lib/perfis.js) e se ela pode iniciar uma operação.
// Também é a fonte de autoria automática ("quem registrou isto" — ver
// LW.nomeDeQuemEstaLogado(), data.js) usada em Registrar Operação,
// Paradas e Avaliações do Setor de Qualidade — substituiu a antiga
// "Identidade Leve de Operador" (perguntava PIN à parte do login,
// removida).
//
// Rotas: GET /usuarios, POST /login-usuario, POST /salvar-usuarios,
// POST /logout-usuario, GET /db/usuarios.json.

module.exports = function criarRotasUsuarios({ fs, path, PRIVATE_DIR, auth, sessao, sessaoUsuario, perfis }) {

  const USUARIOS_PATH = path.join(PRIVATE_DIR, 'usuarios.json');

  // Cadastro de usuários — fica em private/ (fora de public/), mesmo
  // raciocínio de security.json: contém senhaHash, um arquivo dentro de
  // public/db/ seria servido cru pela rota estática genérica pra
  // qualquer um que soubesse a URL.
  function lerUsuarios() {
    try {
      const lista = JSON.parse(fs.readFileSync(USUARIOS_PATH, 'utf8'));
      return Array.isArray(lista) ? lista : [];
    } catch (_) {
      return [];
    }
  }
  function salvarUsuarios(lista) {
    fs.writeFileSync(USUARIOS_PATH, JSON.stringify(lista, null, 2), 'utf8');
  }

  function semSessaoAdmin(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de Administrador Master necessária ou expirada.' }));
  }

  function semSessaoUsuario(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de usuário necessária ou expirada. Faça login de novo.' }));
  }

  return function tentar(req, res, urlPath) {

    // ── GET /perfis: expõe PAGINAS_POR_PERFIL (ver lib/perfis.js) pro
    // front montar o menu lateral dinamicamente e travar abas de
    // Configurações — sem sessão nenhuma exigida (o próprio app-core.js
    // precisa disso logo depois do login, antes de qualquer outra
    // chamada autenticada; a lista em si não é sensível, só diz "quem
    // pode ver o quê", não guarda segredo nenhum).
    if (req.method === 'GET' && urlPath === '/perfis') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        paginasPorPerfil: perfis.PAGINAS_POR_PERFIL,
        perfisCadastraveis: perfis.PERFIS_CADASTRAVEIS,
        perfisComPaginaOperacao: perfis.PERFIS_COM_PAGINA_OPERACAO,
      }));
      return true;
    }

    // ── GET /minha-sessao: devolve os dados da sessão de usuário atual
    // (usuarioId, nomeUsuario, perfil, podeIniciarOperacao) se o cookie
    // for válido, ou {ok:false} caso contrário — chamado no boot da SPA
    // (ver app-core.js, DOMContentLoaded) pra confirmar que a sessão
    // ainda é real no servidor antes de aplicar qualquer permissão
    // baseada em sessionStorage.lw_role (que sozinho é só um valor no
    // navegador, editável por quem souber abrir o DevTools — a validação
    // que importa de verdade é sempre esta, e a que cada rota sensível já
    // faz por conta própria; isso aqui é só pra fechar o boot com uma
    // confirmação, evitando UI enganosa se a sessão tiver expirado ou
    // sido adulterada).
    if (req.method === 'GET' && urlPath === '/minha-sessao') {
      const dados = sessaoUsuario.dadosDaSessao(req);
      if (!dados) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        usuarioId: dados.usuarioId,
        nomeUsuario: dados.nomeUsuario,
        perfil: dados.perfil,
        podeIniciarOperacao: dados.podeIniciarOperacao,
      }));
      return true;
    }

    // ── GET /meus-atalhos: devolve os atalhos personalizados (overrides)
    // do usuário logado agora — mesmo formato usado até então só em
    // localStorage (ver keyboard-shortcuts.js, LS_KEY_ATALHOS): um objeto
    // { [id]: 'Ctrl+Shift+X', ... }. Diferente do resto do cadastro
    // (nomeUsuario, perfil, senha — só o Admin Master mexe): atalhos são
    // uma PREFERÊNCIA PESSOAL, então o próprio usuário logado lê/escreve
    // os seus, sem precisar de senha de Admin Master — só a sessão de
    // usuário normal (ver lib/sessao-usuario.js) já basta.
    if (req.method === 'GET' && urlPath === '/meus-atalhos') {
      const dados = sessaoUsuario.dadosDaSessao(req);
      if (!dados) { semSessaoUsuario(res); return true; }
      const usuario = lerUsuarios().find(u => u.id === dados.usuarioId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, atalhos: (usuario && usuario.atalhos) || {} }));
      return true;
    }

    // ── POST /salvar-meus-atalhos: { atalhos: { [id]: combo, ... } } —
    // substitui o objeto INTEIRO de overrides do usuário logado (mesmo
    // contrato de _salvarOverrides local, keyboard-shortcuts.js, só que
    // persistido no servidor agora). Não mexe em mais nenhum campo do
    // cadastro (nomeUsuario, senha, perfil, podeIniciarOperacao) —
    // regrava só a chave "atalhos" daquele usuário específico.
    if (req.method === 'POST' && urlPath === '/salvar-meus-atalhos') {
      const dados = sessaoUsuario.dadosDaSessao(req);
      if (!dados) { semSessaoUsuario(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const atalhos = payload && payload.atalhos;
          if (!atalhos || typeof atalhos !== 'object' || Array.isArray(atalhos)) {
            throw new Error('Payload inválido: "atalhos" precisa ser um objeto.');
          }
          // Validação leve — cada valor precisa ser string (combo, ex:
          // "Ctrl+Shift+X") ou string vazia (atalho removido, ver
          // _definirAtalho, keyboard-shortcuts.js). Não valida o FORMATO
          // do combo em si (ex: "Ctrl+Shift+"): a mesma tolerância que já
          // existe no localStorage — combos malformados simplesmente
          // nunca combinam com nenhum keydown real, não travam nada.
          for (const [id, combo] of Object.entries(atalhos)) {
            if (typeof combo !== 'string') {
              throw new Error(`Atalho "${id}": valor precisa ser uma string (combo de teclas).`);
            }
          }

          const todos = lerUsuarios();
          const idx = todos.findIndex(u => u.id === dados.usuarioId);
          if (idx === -1) throw new Error('Usuário não encontrado — sessão pode estar desatualizada, faça login de novo.');

          todos[idx] = { ...todos[idx], atalhos };
          salvarUsuarios(todos);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, atalhos }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── GET /usuarios: só {id, nomeUsuario, perfil} — nunca senhaHash.
    // Leitura pública (mesmo raciocínio de GET /operadores) porque a
    // tela de login precisa, no mínimo, aceitar o campo de usuário sem
    // exigir sessão nenhuma ainda (é o próprio meio de conseguir uma).
    // Na prática, a tela de login de hoje não lista usuários num
    // dropdown (é texto livre + senha, ver login.html) — mas expõe essa
    // lista básica pra eventuais telas administrativas que precisem
    // dela sem exigir login prévio.
    if (req.method === 'GET' && urlPath === '/usuarios') {
      const lista = lerUsuarios().map(u => ({ id: u.id, nomeUsuario: u.nomeUsuario, perfil: u.perfil }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, usuarios: lista }));
      return true;
    }

    // ── POST /login-usuario: { nomeUsuario, senha } → autentica e emite
    // sessão de usuário (ver lib/sessao-usuario.js) com {usuarioId,
    // nomeUsuario, perfil, podeIniciarOperacao} — é o que o front usa
    // pra montar sessionStorage.lw_role (mesma chave de sempre, só que
    // agora vem do cadastro, não de um clique em botão — ver
    // login.html). Mesmo rate limiter (por IP) da senha do Administrador
    // Master e do PIN de operador — reaproveitado, não duplicado.
    if (req.method === 'POST' && urlPath === '/login-usuario') {
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
          const { nomeUsuario, senha } = JSON.parse(body);
          if (typeof nomeUsuario !== 'string' || typeof senha !== 'string' || !nomeUsuario.trim() || !senha) {
            throw new Error('Usuário e senha são obrigatórios.');
          }
          // Comparação de nomeUsuario é case-insensitive (login não deve
          // depender de maiúscula/minúscula — ninguém espera precisar
          // digitar o nome exatamente como foi cadastrado), mas o valor
          // GRAVADO/devolvido preserva a grafia original do cadastro.
          const usuario = lerUsuarios().find(u => u.nomeUsuario.toLowerCase() === nomeUsuario.trim().toLowerCase());
          if (!usuario || !auth.senhaCombinaComHash(senha, usuario.senhaHash)) {
            auth.rateLimitRegistrarFalha(req);
            throw new Error('Usuário ou senha incorretos.');
          }
          auth.rateLimitRegistrarSucesso(req);
          const dadosSessao = {
            usuarioId: usuario.id,
            nomeUsuario: usuario.nomeUsuario,
            perfil: usuario.perfil,
            podeIniciarOperacao: !!usuario.podeIniciarOperacao,
          };
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': sessaoUsuario.criarCookieSessao(dadosSessao),
          });
          res.end(JSON.stringify({ ok: true, ...dadosSessao }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── POST /logout-usuario: destrói a sessão de usuário (diferente de
    // POST /logout-admin, que destrói a sessão de Admin Master — as duas
    // são independentes, ver lib/sessao-usuario.js).
    if (req.method === 'POST' && urlPath === '/logout-usuario') {
      sessaoUsuario.logout(req);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': sessaoUsuario.cookieDeLogout() });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    // ── POST /salvar-usuarios: Admin Master gerencia o cadastro inteiro
    // (lista completa, substitui tudo). Payload: [{id?, nomeUsuario, senha?, perfil,
    // podeIniciarOperacao}] — "senha" só é obrigatória pra usuário NOVO
    // (sem id ainda); num usuário já existente, "senha" vazia/ausente
    // PRESERVA o hash atual. Exige sessão de Admin Master (lib/sessao.js
    // — NÃO lib/sessao-usuario.js: só quem sabe a senha mestra gerencia
    // outros usuários, nenhum perfil cadastrado, nem Administrativo, tem
    // essa permissão).
    if (req.method === 'POST' && urlPath === '/salvar-usuarios') {
      if (!sessao.requestTemSessaoValida(req)) { semSessaoAdmin(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const entrada = JSON.parse(body);
          if (!Array.isArray(entrada)) throw new Error('Payload deve ser um array.');

          const atuais = lerUsuarios();
          const porId = new Map(atuais.map(u => [u.id, u]));
          const nomesVistos = new Set();

          const nova = entrada.map((u, idx) => {
            if (typeof u.nomeUsuario !== 'string' || !u.nomeUsuario.trim()) {
              throw new Error(`Usuário na posição ${idx + 1}: nome de usuário obrigatório.`);
            }
            const nomeUsuario = u.nomeUsuario.trim();
            const chaveNome = nomeUsuario.toLowerCase();
            if (nomesVistos.has(chaveNome)) {
              throw new Error(`Nome de usuário "${nomeUsuario}" duplicado — cada usuário precisa de um nome único.`);
            }
            nomesVistos.add(chaveNome);

            if (!perfis.PERFIS_CADASTRAVEIS.includes(u.perfil)) {
              throw new Error(`Usuário "${nomeUsuario}": perfil "${u.perfil}" inválido. Precisa ser um de: ${perfis.PERFIS_CADASTRAVEIS.join(', ')}.`);
            }

            const id = u.id || ('usuario_' + Date.now() + '_' + idx);
            const existente = porId.get(id);

            let senhaHash;
            if (typeof u.senha === 'string' && u.senha) {
              if (u.senha.length < 4) {
                throw new Error(`Usuário "${nomeUsuario}": senha precisa ter no mínimo 4 caracteres.`);
              }
              senhaHash = auth.gerarHashSenha(u.senha);
            } else if (existente) {
              senhaHash = existente.senhaHash; // preserva a senha atual
            } else {
              throw new Error(`Usuário "${nomeUsuario}" é novo — senha obrigatória.`);
            }

            // "podeIniciarOperacao" só é significativo pra perfis que
            // efetivamente têm a página "operacao" liberada (ver
            // lib/perfis.js) — pra qualquer outro perfil, força false
            // independente do que veio no payload, pra não deixar a
            // impressão de que a marcação "faz algo" quando na prática
            // não muda nada (o perfil nem chega perto do formulário).
            const podeIniciarOperacao = perfis.PERFIS_COM_PAGINA_OPERACAO.includes(u.perfil)
              ? !!u.podeIniciarOperacao
              : false;

            // Preserva os atalhos personalizados (ver GET/POST
            // /meus-atalhos, acima) — este payload (vindo da tela de
            // gerenciar usuários) nunca inclui esse campo, então sem
            // preservar explicitamente ele seria apagado toda vez que o
            // Admin Master salvasse QUALQUER mudança de cadastro (nome,
            // perfil, senha de outro usuário, etc.), mesmo sem ter nada
            // a ver com atalhos.
            const atalhos = (existente && existente.atalhos) || {};

            return { id, nomeUsuario, senhaHash, perfil: u.perfil, podeIniciarOperacao, atalhos };
          });

          salvarUsuarios(nova);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            usuarios: nova.map(u => ({ id: u.id, nomeUsuario: u.nomeUsuario, perfil: u.perfil, podeIniciarOperacao: u.podeIniciarOperacao })),
          }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── GET /db/usuarios.json: espelha GET /db/security.json — mesmo
    // motivo (arquivo com hash sensível fora de public/db/, exige
    // sessão de Admin Master) e mesma finalidade: gerarZipBackupGeral()
    // (lib/rotas/backup.js), pro "Backup Geral" incluir o cadastro de
    // usuários.
    if (req.method === 'GET' && urlPath === '/db/usuarios.json') {
      if (!sessao.requestTemSessaoValida(req)) { semSessaoAdmin(res); return true; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(lerUsuarios()));
      return true;
    }

    return false;
  };
};
