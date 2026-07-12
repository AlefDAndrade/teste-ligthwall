// ─── lib/rotas/operadores.js — Identidade Leve de Operador ─────────────────
// Primeira fatia extraída de server.js (ver conversa/README sobre fatiar o
// arquivo — ele tinha crescido pra mais de 3.600 linhas, tudo dentro de UMA
// função de callback do http.createServer). Este é o padrão que as próximas
// fatias devem seguir:
//
//   1. O módulo exporta uma FACTORY — recebe um `ctx` com só as dependências
//      que ESTAS rotas realmente usam (não um ctx gigante genérico — se uma
//      rota nova precisar de algo, adiciona no ctx daquele domínio, não
//      aqui).
//   2. A factory devolve uma função `tentar(req, res, urlPath)` — tenta
//      casar cada rota deste domínio, na mesma ordem/estilo de antes
//      (if (req.method === X && urlPath === Y) {...; return true;}).
//      Devolve `true` se JÁ RESPONDEU (server.js para de tentar outros
//      módulos), ou `false`/undefined se nenhuma rota daqui bateu (server.js
//      segue tentando o próximo módulo, ou cai no fallback de arquivo
//      estático).
//   3. O CONTEÚDO de cada rota é idêntico ao que estava em server.js — só
//      movido, nunca reescrito nesta extração (risco mínimo: quem for
//      comparar visualmente vê que o comportamento não mudou).
//
// Rotas cobertas aqui: GET /operadores, POST /verificar-operador,
// POST /salvar-operadores, GET /db/operadores.json — ver "Identidade Leve
// de Operador" (db.js) pro raciocínio completo do recurso.

module.exports = function criarRotasOperadores({ fs, path, PRIVATE_DIR, auth, sessao }) {

  const OPERADORES_PATH = path.join(PRIVATE_DIR, 'operadores.json');

  // Cadastro de operadores — arquivo pequeno e próprio (mesmo raciocínio de
  // metas.json), mas em private/, não public/db/, por causa do pinHash (ver
  // comentário original em server.js, preservado aqui).
  function lerOperadores() {
    try {
      const lista = JSON.parse(fs.readFileSync(OPERADORES_PATH, 'utf8'));
      return Array.isArray(lista) ? lista : [];
    } catch (_) {
      return [];
    }
  }
  function salvarOperadores(lista) {
    fs.writeFileSync(OPERADORES_PATH, JSON.stringify(lista, null, 2), 'utf8');
  }

  return function tentar(req, res, urlPath) {

    // ── GET /operadores: só {id, nome} — nunca pinHash. Leitura pública
    // (mesmo raciocínio de GET /perfis, lib/rotas/usuarios.js) porque o
    // seletor de operador aparece pra QUALQUER pessoa operando o sistema,
    // não só Admin.
    if (req.method === 'GET' && urlPath === '/operadores') {
      const lista = lerOperadores().map(o => ({ id: o.id, nome: o.nome }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, operadores: lista }));
      return true;
    }

    // ── POST /verificar-operador: confirma o PIN de um operador específico
    // — não cria sessão nenhuma (é "leve" de propósito): o cliente guarda
    // {id, nome} em sessionStorage depois de um 200 daqui, e reenvia esse
    // nome em cada registro (ver operador.js) — puramente informativo,
    // nunca um controle de acesso de verdade. Usa o MESMO rate limiter (por
    // IP) da senha do Administrador — reaproveita em vez de duplicar; um
    // PIN de poucos dígitos merece a mesma barreira contra tentativa e erro
    // em sequência.
    if (req.method === 'POST' && urlPath === '/verificar-operador') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { operadorId, pin } = JSON.parse(body);
          if (typeof operadorId !== 'string' || typeof pin !== 'string' || !pin) {
            throw new Error('operadorId e pin são obrigatórios.');
          }
          if (auth.rateLimitEstaBloqueado(req)) {
            throw new Error(`Muitas tentativas erradas. Tente de novo em ${Math.ceil(auth.rateLimitSegundosRestantes(req) / 60)} min.`);
          }
          const operador = lerOperadores().find(o => o.id === operadorId);
          if (!operador || !auth.senhaCombinaComHash(pin, operador.pinHash)) {
            auth.rateLimitRegistrarFalha(req);
            throw new Error('PIN incorreto.');
          }
          auth.rateLimitRegistrarSucesso(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id: operador.id, nome: operador.nome }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── POST /salvar-operadores: Admin gerencia o cadastro inteiro (lista
    // completa, substitui tudo — mesmo padrão de /salvar-metas). Payload:
    // [{id?, nome, pin?}] — "pin" só é obrigatório pra operador NOVO (sem
    // id ainda); num operador já existente, "pin" vazio/ausente PRESERVA o
    // hash atual (não força trocar o PIN toda vez que o Admin só quer
    // corrigir o nome). Exige sessão de Administrador (ver lib/sessao.js).
    if (req.method === 'POST' && urlPath === '/salvar-operadores') {
      if (!sessao.requestTemSessaoValida(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
        return true;
      }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const entrada = JSON.parse(body);
          if (!Array.isArray(entrada)) throw new Error('Payload deve ser um array.');

          const atuais = lerOperadores();
          const porId = new Map(atuais.map(o => [o.id, o]));

          const nova = entrada.map((o, idx) => {
            if (typeof o.nome !== 'string' || !o.nome.trim()) {
              throw new Error(`Operador na posição ${idx + 1}: nome obrigatório.`);
            }
            const id = o.id || ('operador_' + Date.now() + '_' + idx);
            const existente = porId.get(id);
            let pinHash;
            if (typeof o.pin === 'string' && o.pin.trim()) {
              if (!/^\d{4,8}$/.test(o.pin.trim())) {
                throw new Error(`Operador "${o.nome}": PIN precisa ter de 4 a 8 dígitos numéricos.`);
              }
              pinHash = auth.gerarHashSenha(o.pin.trim());
            } else if (existente) {
              pinHash = existente.pinHash; // preserva o PIN atual
            } else {
              throw new Error(`Operador "${o.nome}" é novo — PIN obrigatório.`);
            }
            return { id, nome: o.nome.trim(), pinHash };
          });

          salvarOperadores(nova);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, operadores: nova.map(o => ({ id: o.id, nome: o.nome })) }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── GET /db/operadores.json: espelha GET /db/security.json (ainda em
    // server.js) — mesmo motivo (arquivo com hash sensível fora de
    // public/db/, exige sessão) e mesma única finalidade real:
    // LW.gerarBackupDados() (data.js), pro "Backup de Dados" incluir o
    // cadastro de operadores. (O seletor de operador em si usa GET
    // /operadores, acima — sem sessão, sem pinHash — não esta rota.)
    if (req.method === 'GET' && urlPath === '/db/operadores.json') {
      if (!sessao.requestTemSessaoValida(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(lerOperadores()));
      return true;
    }

    return false;
  };
};
