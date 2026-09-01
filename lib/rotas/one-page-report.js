// ─── lib/rotas/one-page-report.js — One Page Report ─────────────────────────
// Fase 3 do plano do One Page Report (ver README, "Nova página: One Page
// Report (planejamento)"): rotas do Módulo de Comentários. Mesmo padrão
// factory + tentar(req, res, urlPath, queryParams) do resto de lib/rotas/.
// Rotas cobertas nesta fase: GET /db/one-page-comentarios.json, POST
// /salvar-comentarios-one-page-report.
//
// A Fase 4 do plano (endpoint único de agregação, GET /db/one-page-
// report.json) entra NESTE MESMO ARQUIVO quando implementada — é a
// localização que o próprio README já reserva pra ela ("lib/rotas/
// one-page-report.js"), pra não espalhar as rotas da tela em vários
// arquivos sem necessidade.
//
// `db.lerComentariosDoMes`/`db.salvarComentariosDoMes` vêm de lib/db/
// one-page-comentarios.js (já concluído) — note que este `db` é o wrapper
// de comentários (JSON simples), NÃO o `db` de SQLite (db.js) usado por
// seguranca.js/expedicao.js; foi nomeado igual só pra manter a mesma
// convenção de parâmetro do resto de lib/rotas/.
//
// PERMISSÃO DE ESCRITA — mesma decisão das Fases 1-2 (ver comentário
// equivalente em lib/rotas/seguranca.js/expedicao.js): 'one-page-report'
// AINDA NÃO é uma área cadastrada em AREAS_DE_EDICAO (lib/perfis.js) — até
// a Fase 5 (frontend/menu) decidir quais perfis editam a tela, a rota de
// ESCRITA exige `sessaoOuAdmin` (mesmo padrão de /salvar-metas,
// lib/rotas/autenticacao.js — outro "JSON simples" editável). A LEITURA
// (GET) continua livre, mesmo modelo do resto do sistema.

module.exports = function criarRotasOnePageReport({ comentarios, sessao }) {

  const BLOCOS_VALIDOS = require('../db/one-page-comentarios.js').BLOCOS_VALIDOS;

  function semSessao(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
  }

  function mesValido(mes) {
    return typeof mes === 'string' && /^\d{4}-\d{2}$/.test(mes);
  }

  return function tentar(req, res, urlPath, queryParams) {

    // ── GET /db/one-page-comentarios.json?mes=YYYY-MM: leitura livre —
    // devolve os comentários salvos daquele mês, ou um esqueleto com todos
    // os campos vazios se o mês nunca foi salvo (nunca `null` puro pro
    // frontend: ver comentário "NÃO tem noção de Dado indisponível", topo
    // de lib/db/one-page-comentarios.js — texto vazio é estado normal, o
    // frontend da Fase 5 só precisa dos campos existirem pra popular o
    // formulário). `mes` é obrigatório.
    if (req.method === 'GET' && urlPath === '/db/one-page-comentarios.json') {
      try {
        const mes = queryParams && queryParams.get ? queryParams.get('mes') : null;
        if (!mesValido(mes)) throw new Error('Parâmetro "mes" inválido — use o formato YYYY-MM.');
        const registro = comentarios.lerComentariosDoMes(mes) || {
          seguranca: { comentarios: '', proximosPassos: '' },
          producao: { comentarios: '', proximosPassos: '' },
          refugo: { comentarios: '', proximosPassos: '' },
          expedicao: { comentarios: '', proximosPassos: '' },
          assuntosGerais: '',
          atualizadoEm: null,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mes, ...registro }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── POST /salvar-comentarios-one-page-report: grava (substitui por
    // completo) os comentários de 1 mês — ver comentário de PERMISSÃO DE
    // ESCRITA, topo do arquivo.
    if (req.method === 'POST' && urlPath === '/salvar-comentarios-one-page-report') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (!payload || typeof payload !== 'object') throw new Error('Payload inválido.');
          const mes = payload.mes;
          if (!mesValido(mes)) throw new Error('Parâmetro "mes" inválido — use o formato YYYY-MM.');

          // Cada bloco (Segurança/Produção/Refugo/Expedição) é opcional no
          // payload (a tela pode salvar 1 bloco de cada vez, sem precisar
          // reenviar os outros 3) — mas se vier, precisa ser um objeto com
          // só string em comentarios/proximosPassos, nunca outro tipo
          // solto sendo gravado sem querer.
          const blocosValidados = {};
          for (const nomeBloco of BLOCOS_VALIDOS) {
            const bloco = payload[nomeBloco];
            if (bloco === undefined) continue;
            if (!bloco || typeof bloco !== 'object' || Array.isArray(bloco)) {
              throw new Error(`Bloco "${nomeBloco}" inválido — esperado um objeto com comentarios/proximosPassos.`);
            }
            blocosValidados[nomeBloco] = {
              comentarios: typeof bloco.comentarios === 'string' ? bloco.comentarios : '',
              proximosPassos: typeof bloco.proximosPassos === 'string' ? bloco.proximosPassos : '',
            };
          }
          const assuntosGerais = typeof payload.assuntosGerais === 'string' ? payload.assuntosGerais : undefined;

          // Mescla com o que já existia pro mês (salvar só Segurança não
          // deve apagar Produção/Refugo/Expedição/Assuntos Gerais já
          // salvos antes) — mesma preocupação de /salvar-metas não
          // sobrescrever o resto do config.json à toa.
          const existente = comentarios.lerComentariosDoMes(mes) || {};
          const registro = comentarios.salvarComentariosDoMes(mes, {
            ...existente,
            ...blocosValidados,
            assuntosGerais: assuntosGerais !== undefined ? assuntosGerais : existente.assuntosGerais,
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mes, ...registro }));
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
