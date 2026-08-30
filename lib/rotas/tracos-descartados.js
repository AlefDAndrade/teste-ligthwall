// ─── lib/rotas/tracos-descartados.js — Traço Descartado (perda) ────────────
// Ver README, "Registro de Traço Descartado (Perda) — plano", passo 2
// (backend). Mesmo padrão factory + tentar(req, res, urlPath) do resto de
// lib/rotas/ — só duas rotas, mesmo estilo enxuto de lib/rotas/sobra.js e
// lib/rotas/paradas.js.
//
// Sem `modoTeste` aqui (diferente de sobra.js/registro-operacao.js): um
// traço descartado é sempre um registro real de perda de insumo — não faz
// sentido existir uma versão "de teste" dele.
//
// `db.inserirTracoDescartado`/`db.todosOsTracosDescartados` vêm de
// lib/db/tracos-descartados.js (passo 1 do plano, já concluído).

const crypto = require('crypto');

module.exports = function criarRotasTracosDescartados({ db, podeEditarArea, negarEdicao }) {

  return function tentar(req, res, urlPath) {

    // ── POST /registrar-traco-descartado: grava a perda (insumos + motivo) ──
    // Mesma área de permissão do registro de operação/sobra (ver README,
    // "Registro de Traço Descartado (Perda) — plano") — quem pode lançar
    // um traço também pode descartar um.
    if (req.method === 'POST' && urlPath === '/registrar-traco-descartado') {
      if (!podeEditarArea(req, 'injetora')) { negarEdicao(res, 'o registro de traço descartado'); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const traco = JSON.parse(body);
          if (!traco || typeof traco !== 'object') {
            throw new Error('Payload inválido.');
          }
          // `motivo` é texto livre e obrigatório (decisão registrada no
          // README) — validado aqui pra devolver uma mensagem amigável em
          // vez do erro cru de constraint NOT NULL do SQLite.
          const motivo = typeof traco.motivo === 'string' ? traco.motivo.trim() : '';
          if (!motivo) {
            throw new Error('Motivo é obrigatório.');
          }
          // `id`/`registrado_em` nascem no servidor — nunca confiamos no
          // cliente pra essas duas colunas (mesmo raciocínio de
          // registrado_em em paradas.js/sobra.js).
          //
          // Sufixo aleatório (não só Date.now()): diferente de import/
          // merge em lote (lib/rotas/importacao.js, lib/db/tracos.js), que
          // usam um índice de loop pra desempatar, aqui é 1 request HTTP
          // isolado — dois dispositivos descartando no mesmo milissegundo
          // colidiriam e o segundo tomaria um erro cru de UNIQUE constraint
          // em vez da mensagem amigável de validação.
          const id = 'descarte_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
          db.inserirTracoDescartado({
            ...traco,
            id,
            motivo,
            registrado_em: new Date().toISOString(),
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── GET /db/tracos_descartados.json: mesma estratégia de sobra/paradas —
    // esse arquivo nunca existiu de verdade em disco (domínio nasceu já em
    // SQL); reconstrói o mesmo formato a partir da tabela
    // "tracos_descartados", mais recente primeiro. Leitura livre, sem
    // checagem de permissão (mesmo modelo de GET /db/paradas.json) — hoje
    // nenhuma tela ainda faz esse fetch (ver passo 3 do plano, frontend).
    if (req.method === 'GET' && urlPath === '/db/tracos_descartados.json') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.todosOsTracosDescartados()));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    return false;
  };
};
