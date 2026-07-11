// ─── lib/rotas/importacao.js — Importação em massa (planilhas) ─────────────
// Décima terceira fatia extraída de server.js (ver lib/rotas/operadores.js
// pro padrão completo). Rotas cobertas: POST /importar-relatorio-injecao,
// POST /importar-historico.
//
// `numOuNulo` é injetada via ctx — usada em vários outros pontos de
// server.js (registrar-operacao, registrar-relatorio-injecao, etc.), então
// a DEFINIÇÃO continua lá.

module.exports = function criarRotasImportacao({ db, sessao, numOuNulo }) {

  function semSessao(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
  }

  return function tentar(req, res, urlPath) {

    // Importar lote de relatório de injeção — cada linha da planilha não tem
    // id_traco nem id_operacao reais (não vem de uma operação de verdade),
    // então gera um id_traco sintético por linha e cria um traco_usos com o
    // id_operacao sintético que o navegador já mandou (sem FK pra
    // "operacoes" de propósito — ver schema em db.js).
    // Antes desta mudança, importar dados em massa não exigia NADA (nem
    // senha, nem sessão) — só a UI escondia o botão pra quem não fosse
    // Administrador. Agora exige a mesma sessão das demais rotas
    // administrativas (ver lib/sessao.js).
    if (req.method === 'POST' && urlPath === '/importar-relatorio-injecao') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const novos = JSON.parse(body);
          if (!Array.isArray(novos)) throw new Error('Payload deve ser um array');

          // Mesma checagem de duplicata de sempre (id_operacao+num_traco) —
          // na prática quase nunca encontra nada, já que id_operacao é
          // gerado novo a cada importação (era assim também antes desta
          // migração; não é uma regressão introduzida agora).
          const existentes = new Set(
            db.prepare(`
              SELECT tu.id_operacao || '|' || t.num_traco AS chave
              FROM traco_usos tu JOIN tracos t ON t.id_traco = tu.id_traco
            `).all().map(r => r.chave)
          );

          const inserirTraco = db.prepare(db.SQL_INSERIR_TRACO);
          const inserirUso = db.prepare(db.SQL_INSERIR_USO);
          let inseridos = 0, duplicatas = 0;

          const importarTudo = db.transaction((lista) => {
            lista.forEach((r, i) => {
              const chave = r.id_operacao + '|' + r.num_traco;
              if (existentes.has(chave)) { duplicatas++; return; }

              const idTraco = 'imp_traco_' + Date.now() + '_' + i;
              inserirTraco.run({
                id_traco: idTraco, data: r.data, turno: r.turno ?? null, num_traco: r.num_traco ?? null,
                cimento_original: numOuNulo(r.cimento), agua_original: numOuNulo(r.agua),
                eps_original: null, // planilha de importação nunca teve coluna de EPS — lacuna pré-existente
                superplast_original: numOuNulo(r.superplast), incorporador_original: numOuNulo(r.incorporador),
                tempo_batida_original: numOuNulo(r.tempo_batida), // já em segundos, igual ao registro ao vivo
                densidade_original: numOuNulo(r.densidade), flow_original: numOuNulo(r.flow),
                obs: r.obs ?? null, silo: r.silo ?? null, expansao: r.expansao ?? null,
                densidade_eps: r.densidade_eps ?? null,
              });
              inserirUso.run({
                id_traco: idTraco, id_operacao: r.id_operacao ?? '', id_bateria: r.id_bateria ?? null,
                berco_inicio: r.berco_ini ?? null, berco_finalizacao: r.berco_fim ?? null, obs: r.obs ?? null,
              });
              existentes.add(chave);
              inseridos++;
            });
          });
          importarTudo(novos);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, inseridos, duplicatas }));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // Importar lote de registros — insere na tabela operacoes, com a mesma
    // deduplicação de sempre (por id, ou por data+bateria+turno pra
    // registros antigos sem id).
    // Mesma exigência de /importar-relatorio-injecao, acima.
    if (req.method === 'POST' && urlPath === '/importar-historico') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const novos = JSON.parse(body);
          if (!Array.isArray(novos)) throw new Error('Payload deve ser um array');

          const existentesRows = db.prepare('SELECT id, data, id_bateria, turno FROM operacoes').all();
          const existentes = new Set(existentesRows.map(r => r.id || (r.data + '|' + r.id_bateria + '|' + r.turno)));

          const inserirOperacao = db.prepare(db.SQL_INSERIR_OPERACAO);
          let inseridos = 0, duplicatas = 0;

          const importarTudo = db.transaction((lista) => {
            for (const r of lista) {
              const chave = r.id || (r.data + '|' + r.id_bateria + '|' + r.turno);
              if (existentes.has(chave)) { duplicatas++; continue; }
              inserirOperacao.run({
                ...db.operacaoParaRow(r),
                modo_teste: 0,
                criado_em: new Date().toISOString(),
              });
              existentes.add(chave);
              inseridos++;
            }
          });
          importarTudo(novos);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, inseridos, duplicatas }));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    return false;
  };
};
