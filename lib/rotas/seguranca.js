// ─── lib/rotas/seguranca.js — Ocorrências de Segurança ──────────────────────
// Fase 1 do plano do One Page Report (ver README, "Nova página: One Page
// Report (planejamento)"). Mesmo padrão factory + tentar(req, res, urlPath,
// queryParams) do resto de lib/rotas/ — estilo enxuto de lib/rotas/tracos-
// descartados.js e lib/rotas/paradas.js. Rotas cobertas: GET
// /db/seguranca_ocorrencias.json, GET /seguranca/dias-sem-acidentes, POST
// /registrar-ocorrencia-seguranca, POST /excluir-ocorrencia-seguranca.
//
// `db.listarOcorrenciasSeguranca`/`db.inserirOcorrenciaSeguranca`/
// `db.excluirOcorrenciaSeguranca`/`db.diasSemAcidentes` vêm de
// lib/db/seguranca-ocorrencias.js (já concluído). `db.GRAVIDADES_VALIDAS_
// SEGURANCA` idem, pra validar o campo antes de gravar.
//
// PERMISSÃO DE ESCRITA — decisão desta fase: 'seguranca' AINDA NÃO é uma
// área cadastrada em AREAS_DE_EDICAO (lib/perfis.js) nem no catálogo
// granular (lib/itens-permissao.js) — decidir quais perfis registram
// ocorrências de Segurança é uma escolha de produto que cabe à Fase 5
// (frontend/menu), não a esta fase (só backend). Até lá, seguindo o
// princípio de "falhar fechado" já usado no projeto (ver README, rotas que
// exigem sessão mesmo sem ainda ter um perfil dedicado), as duas rotas de
// ESCRITA exigem `sessaoOuAdmin` (mesmo padrão de lib/rotas/importacao.js)
// em vez de ficarem abertas a qualquer sessão de usuário cadastrado. A
// LEITURA (GET) continua livre, mesmo modelo de visualização aberta do
// resto do sistema (ver lib/perfis.js).

module.exports = function criarRotasSeguranca({ db, todayBrasiliaServer, sessao }) {

  function semSessao(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
  }

  return function tentar(req, res, urlPath) {

    // ── GET /db/seguranca_ocorrencias.json: leitura livre, todas as
    // ocorrências (mais recente primeiro) — mesma estratégia de GET
    // /db/tracos_descartados.json (domínio nasceu já em SQL, este "arquivo"
    // nunca existiu de verdade em disco).
    if (req.method === 'GET' && urlPath === '/db/seguranca_ocorrencias.json') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.listarOcorrenciasSeguranca()));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── GET /seguranca/dias-sem-acidentes: leitura livre — calcula em cima
    // da tabela (ver diasSemAcidentes, lib/db/seguranca-ocorrencias.js).
    // `dias: null` quando ainda não há nenhuma ocorrência registrada — o
    // frontend (Fase 5) mostra "Dado indisponível" nesse caso, nunca "0"
    // (ver regra combinada do One Page Report, README).
    if (req.method === 'GET' && urlPath === '/seguranca/dias-sem-acidentes') {
      try {
        const resultado = db.diasSemAcidentes(todayBrasiliaServer());
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, ...resultado }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── POST /registrar-ocorrencia-seguranca: grava 1 ocorrência (data,
    // descrição, gravidade) — ver comentário de PERMISSÃO DE ESCRITA, topo
    // do arquivo.
    if (req.method === 'POST' && urlPath === '/registrar-ocorrencia-seguranca') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const ocorrencia = JSON.parse(body);
          if (!ocorrencia || typeof ocorrencia !== 'object') {
            throw new Error('Payload inválido.');
          }
          // `data` e `gravidade` são os únicos campos obrigatórios (ver
          // README, Fase 1) — validados aqui pra devolver uma mensagem
          // amigável em vez do erro cru de constraint NOT NULL do SQLite.
          // `descricao` fica de fora de propósito: pode ser preenchida
          // depois, na própria tela (mesmo espírito de texto livre editável
          // do Módulo de Comentários, Fase 3).
          const data = typeof ocorrencia.data === 'string' ? ocorrencia.data.trim() : '';
          if (!data) throw new Error('Data é obrigatória.');
          const gravidade = typeof ocorrencia.gravidade === 'string' ? ocorrencia.gravidade.trim().toLowerCase() : '';
          if (!db.GRAVIDADES_VALIDAS_SEGURANCA.includes(gravidade)) {
            throw new Error(`Gravidade inválida — use um destes valores: ${db.GRAVIDADES_VALIDAS_SEGURANCA.join(', ')}.`);
          }
          // `id`/`registrado_em` nascem no servidor — nunca confiamos no
          // cliente pra essas duas colunas (mesmo raciocínio de
          // registrado_em em paradas.js/tracos-descartados.js). Sufixo
          // aleatório (não só Date.now()) pelo mesmo motivo de
          // tracos-descartados.js: 1 request HTTP isolado, sem índice de
          // loop pra desempatar colisões no mesmo milissegundo.
          const crypto = require('crypto');
          const id = 'ocorrencia_seguranca_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
          db.inserirOcorrenciaSeguranca({
            ...ocorrencia,
            id,
            data,
            gravidade,
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

    // ── POST /excluir-ocorrencia-seguranca: exclui pelo id — ver comentário
    // de PERMISSÃO DE ESCRITA, topo do arquivo.
    if (req.method === 'POST' && urlPath === '/excluir-ocorrencia-seguranca') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          if (!id || typeof id !== 'string') throw new Error('ID inválido.');
          const excluiu = db.excluirOcorrenciaSeguranca(id);
          if (!excluiu) throw new Error('Ocorrência não encontrada (id: ' + id + ').');
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
