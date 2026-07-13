// ─── lib/rotas/paradas.js — Registro de Paradas ─────────────────────────────
// Segunda fatia extraída de server.js (ver lib/rotas/operadores.js pro
// padrão completo — mesma estrutura aqui). Rotas cobertas: GET
// /db/paradas.json, POST /salvar-parada, POST /excluir-parada.
//
// A LEITURA (GET /db/paradas.json) continua livre — modelo novo (ver
// lib/perfis.js): toda página é aberta pra visualização. Já as rotas de
// ESCRITA (/salvar-parada, /excluir-parada) exigem um perfil com a área
// 'paradas' de edição — que hoje é TODO perfil cadastrável (registrar
// paradas é permitido a todos), então na prática a exigência real aqui é
// "estar logado com uma sessão válida" (podeEditarArea devolve false sem
// sessão nenhuma).

module.exports = function criarRotasParadas({ db, podeEditarArea, negarEdicao }) {

  return function tentar(req, res, urlPath) {

    // ── GET /db/paradas.json: mesma estratégia de historico.json — desde a
    // Fase 3, paradas.json não existe mais como arquivo; reconstrói o
    // mesmo formato a partir da tabela "paradas", pra paradas.js e oee.js
    // (que já fazem fetch('db/paradas.json') direto) continuarem sem
    // nenhuma mudança.
    if (req.method === 'GET' && urlPath === '/db/paradas.json') {
      try {
        const rows = db.prepare('SELECT * FROM paradas ORDER BY inicio ASC').all();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows.map(db.rowParaParada)));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── PARADAS: salvar (inserir ou atualizar) uma parada ────────────────────
    if (req.method === 'POST' && urlPath === '/salvar-parada') {
      if (!podeEditarArea(req, 'paradas')) { negarEdicao(res, 'o Registro de Paradas'); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const parada = JSON.parse(body);
          if (!parada || typeof parada !== 'object' || !parada.id) {
            throw new Error('Payload inválido: "id" obrigatório.');
          }
          const atual = db.prepare('SELECT * FROM paradas WHERE id = ?').get(parada.id);
          const mesclado = atual ? { ...db.rowParaParada(atual), ...parada } : parada;

          db.prepare(`
            INSERT INTO paradas (id, inicio, fim, duracao_min, motivo, equipamento, classificacao, obs, registrado_em, operador_nome)
            VALUES (@id, @inicio, @fim, @duracao_min, @motivo, @equipamento, @classificacao, @obs, @registrado_em, @operador_nome)
            ON CONFLICT(id) DO UPDATE SET
              inicio = @inicio, fim = @fim, duracao_min = @duracao_min, motivo = @motivo,
              equipamento = @equipamento, classificacao = @classificacao, obs = @obs,
              registrado_em = @registrado_em, operador_nome = @operador_nome
          `).run(db.paradaParaRow(mesclado));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── PARADAS: excluir uma parada pelo id ───────────────────────────────────
    if (req.method === 'POST' && urlPath === '/excluir-parada') {
      if (!podeEditarArea(req, 'paradas')) { negarEdicao(res, 'o Registro de Paradas'); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          if (!id || typeof id !== 'string') throw new Error('ID inválido.');
          const resultado = db.prepare('DELETE FROM paradas WHERE id = ?').run(id);
          if (resultado.changes === 0) throw new Error('Parada não encontrada (id: ' + id + ').');
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
