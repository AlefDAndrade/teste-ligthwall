// ─── lib/rotas/expedicao.js — Cargas de Expedição ────────────────────────────
// Fase 2 do plano do One Page Report (ver README, "Nova página: One Page
// Report (planejamento)"). Mesmo padrão factory + tentar(req, res, urlPath,
// queryParams) do resto de lib/rotas/ — estilo enxuto de lib/rotas/
// seguranca.js (Fase 1). Rotas cobertas: GET /db/expedicao_cargas.json, GET
// /expedicao/agregacao-semanal, POST /registrar-carga-expedicao, POST
// /excluir-carga-expedicao.
//
// `db.listarCargasExpedicao`/`db.inserirCargaExpedicao`/
// `db.excluirCargaExpedicao`/`db.agregacaoSemanalExpedicao` vêm de
// lib/db/expedicao.js (já concluído).
//
// PERMISSÃO DE ESCRITA — mesma decisão da Fase 1 (ver comentário
// equivalente em lib/rotas/seguranca.js): 'expedicao' AINDA NÃO é uma área
// cadastrada em AREAS_DE_EDICAO (lib/perfis.js) nem no catálogo granular
// (lib/itens-permissao.js) — decidir quais perfis registram cargas de
// Expedição é uma escolha de produto que cabe à Fase 5 (frontend/menu), não
// a esta fase (só backend). Até lá, seguindo o princípio de "falhar
// fechado" já usado no projeto, as duas rotas de ESCRITA exigem
// `sessaoOuAdmin` em vez de ficarem abertas a qualquer sessão de usuário
// cadastrado. A LEITURA (GET) continua livre, mesmo modelo de visualização
// aberta do resto do sistema (ver lib/perfis.js).

module.exports = function criarRotasExpedicao({ db, todayBrasiliaServer, sessao }) {

  function semSessao(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
  }

  return function tentar(req, res, urlPath, queryParams) {

    // ── GET /db/expedicao_cargas.json: leitura livre, todas as cargas
    // (mais recente primeiro) — mesma estratégia de GET /db/seguranca_
    // ocorrencias.json (domínio nasceu já em SQL, este "arquivo" nunca
    // existiu de verdade em disco). Aceita ?mes=YYYY-MM opcional pra
    // filtrar sem precisar trazer o histórico inteiro (ver
    // listarCargasExpedicao, lib/db/expedicao.js).
    if (req.method === 'GET' && urlPath === '/db/expedicao_cargas.json') {
      try {
        const mes = queryParams && queryParams.get ? queryParams.get('mes') : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.listarCargasExpedicao(mes || undefined)));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── GET /expedicao/agregacao-semanal?mes=YYYY-MM: leitura livre —
    // calcula em cima da tabela (ver agregacaoSemanalExpedicao, lib/db/
    // expedicao.js). `mes` é obrigatório na querystring; sem nenhuma carga
    // registrada naquele mês, devolve `agregacao: null` — o frontend (Fase
    // 5) mostra "Dado indisponível" nesse caso, nunca semanas zeradas (ver
    // regra combinada do One Page Report, README). Sem `mes` na
    // querystring, usa o mês corrente (Brasília) como padrão.
    if (req.method === 'GET' && urlPath === '/expedicao/agregacao-semanal') {
      try {
        const hoje = todayBrasiliaServer();
        const mes = (queryParams && queryParams.get && queryParams.get('mes')) || hoje.slice(0, 7);
        if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error('Parâmetro "mes" inválido — use o formato YYYY-MM.');
        const agregacao = db.agregacaoSemanalExpedicao(mes, hoje);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, agregacao }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── POST /registrar-carga-expedicao: grava 1 carga (data, cliente, m2,
    // numero_carga opcional) — ver comentário de PERMISSÃO DE ESCRITA,
    // topo do arquivo.
    if (req.method === 'POST' && urlPath === '/registrar-carga-expedicao') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const carga = JSON.parse(body);
          if (!carga || typeof carga !== 'object') {
            throw new Error('Payload inválido.');
          }
          // `data`, `cliente` e `m2` são os únicos campos obrigatórios (ver
          // README, Fase 2) — validados aqui pra devolver uma mensagem
          // amigável em vez do erro cru de constraint NOT NULL do SQLite.
          // `numero_carga` fica de fora de propósito: identificador
          // informativo, nem toda expedição tem um número de carga
          // formalizado no momento do registro.
          const data = typeof carga.data === 'string' ? carga.data.trim() : '';
          if (!data) throw new Error('Data é obrigatória.');
          const cliente = typeof carga.cliente === 'string' ? carga.cliente.trim() : '';
          if (!cliente) throw new Error('Cliente é obrigatório.');
          const m2 = Number(carga.m2);
          if (!Number.isFinite(m2) || m2 <= 0) throw new Error('M² deve ser um número maior que zero.');
          const numeroCarga = typeof carga.numero_carga === 'string' ? carga.numero_carga.trim() || null : null;
          // `id`/`registrado_em` nascem no servidor — nunca confiamos no
          // cliente pra essas duas colunas (mesmo raciocínio de
          // registrado_em em seguranca.js/tracos-descartados.js). Sufixo
          // aleatório (não só Date.now()) pelo mesmo motivo: 1 request
          // HTTP isolado, sem índice de loop pra desempatar colisões no
          // mesmo milissegundo.
          const crypto = require('crypto');
          const id = 'carga_expedicao_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
          db.inserirCargaExpedicao({
            ...carga,
            id,
            data,
            cliente,
            m2,
            numero_carga: numeroCarga,
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

    // ── POST /excluir-carga-expedicao: exclui pelo id — ver comentário de
    // PERMISSÃO DE ESCRITA, topo do arquivo.
    if (req.method === 'POST' && urlPath === '/excluir-carga-expedicao') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          if (!id || typeof id !== 'string') throw new Error('ID inválido.');
          const excluiu = db.excluirCargaExpedicao(id);
          if (!excluiu) throw new Error('Carga não encontrada (id: ' + id + ').');
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
