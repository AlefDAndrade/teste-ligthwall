// ─── lib/rotas/tracos-descartados.js — Traço Descartado (perda) ────────────
// Ver README, "Registro de Traço Descartado (Perda) — plano", passo 2
// (backend). Mesmo padrão factory + tentar(req, res, urlPath) do resto de
// lib/rotas/ — estilo enxuto de lib/rotas/sobra.js e lib/rotas/paradas.js.
//
// Sem `modoTeste` aqui (diferente de sobra.js/registro-operacao.js): um
// traço descartado é sempre um registro real de perda de insumo — não faz
// sentido existir uma versão "de teste" dele.
//
// `db.inserirTracoDescartado`/`db.todosOsTracosDescartados`/
// `db.editarTracoDescartado`/`db.excluirTracoDescartado` vêm de
// lib/db/tracos-descartados.js.
//
// EDITAR/EXCLUIR (README, item 8a das pendências — reverte a decisão
// original de "só existe pra criação", ver "5. Fora de escopo" daquela
// seção): mesma área de permissão do registro ('injetora' — quem pode
// descartar um traço também pode corrigir/apagar o próprio registro
// depois, sem distinção de "dono" — mesmo modelo já usado por
// paradas.js/sobra.js, que também não amarram edição a quem criou).

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

    // ── POST /editar-traco-descartado: corrige um registro já existente ──
    // (README, item 8a) — SUBSTITUI os campos editáveis por completo
    // (mesmo padrão de /salvar-parada), nunca mexe em `id`/`registrado_em`
    // (ver comentário em db.editarTracoDescartado). `motivo` continua
    // obrigatório aqui, mesma validação amigável do registro original.
    if (req.method === 'POST' && urlPath === '/editar-traco-descartado') {
      if (!podeEditarArea(req, 'injetora')) { negarEdicao(res, 'a edição de traço descartado'); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string' || !payload.id) {
            throw new Error('Payload inválido: "id" obrigatório.');
          }
          const motivo = typeof payload.motivo === 'string' ? payload.motivo.trim() : '';
          if (!motivo) {
            throw new Error('Motivo é obrigatório.');
          }
          const { id, ...campos } = payload;
          const encontrado = db.editarTracoDescartado(id, { ...campos, motivo });
          if (!encontrado) throw new Error('Traço descartado não encontrado (id: ' + id + ').');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── POST /excluir-traco-descartado: apaga um registro pelo id ────────
    // (README, item 8a) — mesmo padrão de POST /excluir-parada
    // (lib/rotas/paradas.js): 400 com mensagem amigável se o id não
    // existir, nunca um 200 silencioso pra algo que não foi encontrado.
    if (req.method === 'POST' && urlPath === '/excluir-traco-descartado') {
      if (!podeEditarArea(req, 'injetora')) { negarEdicao(res, 'a exclusão de traço descartado'); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          if (!id || typeof id !== 'string') throw new Error('ID inválido.');
          const apagou = db.excluirTracoDescartado(id);
          if (!apagou) throw new Error('Traço descartado não encontrado (id: ' + id + ').');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
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
    // checagem de permissão (mesmo modelo de GET /db/paradas.json).
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
