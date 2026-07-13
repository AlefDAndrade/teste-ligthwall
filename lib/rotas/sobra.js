// ─── lib/rotas/sobra.js — Sobra de material ─────────────────────────────────
// Sexta fatia extraída de server.js (ver lib/rotas/operadores.js pro padrão
// completo). Rotas cobertas: POST /salvar-sobra, GET /db/sobra.json.
//
// `dirParaModoTeste` é injetada via ctx — é usada por vários outros domínios
// ainda em server.js (registrar-operacao, registrar-relatorio-injecao,
// registrar-ajuste-traco), então a DEFINIÇÃO continua lá.
//
// `modoTeste` é derivado aqui dentro a partir de queryParams (mesma
// expressão usada em server.js: queryParams.get('modoTeste') === 'true')
// em vez de virar mais um argumento posicional no tentar() — só esta rota,
// neste módulo, precisa dele.

module.exports = function criarRotasSobra({ db, fs, path, dirParaModoTeste, podeEditarArea, negarEdicao }) {

  return function tentar(req, res, urlPath, queryParams) {

    // ── SOBRA: salvar sobra (real -> tabela sobra; Modo de Teste -> JSON isolado) ──
    if (req.method === 'POST' && urlPath === '/salvar-sobra') {
      const modoTeste = queryParams.get('modoTeste') === 'true';
      // Sobra faz parte das ferramentas de registro de operação (área
      // 'injetora' — ver lib/perfis.js); Modo de Teste continua livre, é um
      // sandbox isolado que não toca dado de produção.
      if (!modoTeste && !podeEditarArea(req, 'injetora')) { negarEdicao(res, 'o registro de operação (sobra)'); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const sobra = JSON.parse(body);
          if (modoTeste) {
            const sobraPath = path.join(dirParaModoTeste(true), 'sobra.json');
            fs.writeFileSync(sobraPath, JSON.stringify(sobra, null, 2), 'utf8');
          } else {
            db.prepare(db.SQL_UPSERT_SOBRA).run(db.sobraParaRow(sobra));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── GET /db/sobra.json: mesma estratégia das outras — desde a Fase 4,
    // sobra.json não existe mais como arquivo (caminho real); reconstrói o
    // mesmo objeto de sempre (camelCase) a partir da tabela "sobra". Modo de
    // Teste continua sendo arquivo estático de verdade (não intercepta aqui).
    if (req.method === 'GET' && urlPath === '/db/sobra.json') {
      try {
        const row = db.prepare('SELECT * FROM sobra WHERE id = 1').get();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.rowParaSobra(row)));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    return false;
  };
};
