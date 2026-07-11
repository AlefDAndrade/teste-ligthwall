// ─── lib/rotas/consultas.js — Views derivadas (somente leitura) ────────────
// Quinta fatia extraída de server.js (ver lib/rotas/operadores.js pro
// padrão completo). Rotas cobertas: GET /db/historico_edicoes.json,
// /db/relatorio_edicoes.json, /db/relatorio_injecao.json,
// /db/ajustes_tracos.json, /db/bercos_visuais.json,
// /db/detalhe_operacao.json, /db/correlacao_traco_berco.json,
// /db/relatorio_bercos.json, /db/historico.json.
//
// Domínio de MENOR risco possível pra fatiar: todas as 9 rotas são leitura
// pura (nenhuma escreve nada), nenhuma exige sessão/senha, e a única
// dependência é `db` (+ `queryParams`, só em detalhe_operacao.json, pra
// ler ?id=...). Cada uma já existia só pra reconstruir, a partir do
// SQLite, o mesmo formato que os arquivos .json de antes da migração
// tinham — ver comentários originais em cada rota, preservados abaixo.

module.exports = function criarRotasConsultas({ db }) {

  return function tentar(req, res, urlPath, queryParams) {

    // ── GET /db/historico_edicoes.json ────────────────────────────────────
    if (req.method === 'GET' && urlPath === '/db/historico_edicoes.json') {
      try {
        const rows = db.prepare('SELECT id_operacao, data_edicao, campos_alterados FROM edicoes_operacao ORDER BY id ASC').all();
        const edicoes = rows.map(r => ({ ...r, campos_alterados: JSON.parse(r.campos_alterados) }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(edicoes));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── GET /db/relatorio_edicoes.json: mesma ideia, pra auditoria de edição
    // de TRAÇO (edicoes_traco) — essa rota estava faltando (as outras 7
    // existem desde a migração pra SQLite, esta nunca foi criada). Sem ela,
    // fetch('db/relatorio_edicoes.json') em gerarBackupDados() caía direto
    // no servidor de arquivo estático, que dá 404 (o arquivo não existe mais
    // em disco) — o erro era engolido em silêncio ali, e o arquivo nunca
    // entrava no .zip do "Backup de Dados". Era exatamente esse o motivo do
    // restore acusar "está faltando": ele nunca chegou a ser incluído.
    if (req.method === 'GET' && urlPath === '/db/relatorio_edicoes.json') {
      try {
        const rows = db.prepare('SELECT id_traco, id_operacao, data_edicao, campos_alterados FROM edicoes_traco ORDER BY id ASC').all();
        const edicoes = rows.map(r => ({ ...r, campos_alterados: JSON.parse(r.campos_alterados) }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(edicoes));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── GET /db/relatorio_injecao.json: mesma estratégia das outras — desde
    // a Fase 5, não existe mais como arquivo (caminho real); reconstrói o
    // mesmo formato de sempre a partir de tracos+traco_usos+ajustes+
    // leituras_resultado. Cobre LW.getRelatorioInjecao (dashboard.js), o
    // modal de Editar Traço, e a tela de Backup de Dados — todos já fazem
    // fetch direto, sem mudança nenhuma necessária.
    if (req.method === 'GET' && urlPath === '/db/relatorio_injecao.json') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.todosOsTracos()));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── GET /db/ajustes_tracos.json: idem — usado por LW.getAjustesTracos()
    // (o modal de Editar Traço carrega a lista de ajustes editável a partir
    // daqui) e pela tela de Backup de Dados.
    if (req.method === 'GET' && urlPath === '/db/ajustes_tracos.json') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.todosOsAjustesTracosJSON()));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── GET /db/bercos_visuais.json: mesma estratégia das outras tabelas —
    // não existe mais como arquivo, reconstrói a partir da tabela SQL
    // "bercos_visuais". Usado por gerarBackupDados() (data.js), que faz
    // fetch('db/'+nome) genérico pra cada arquivo da lista (Backup de Dados).
    if (req.method === 'GET' && urlPath === '/db/bercos_visuais.json') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.todosOsBercosVisuais()));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── GET /db/detalhe_operacao.json?id=...: tudo que se liga por
    // id_operacao — operação, berços visuais, receita de cada traço usado
    // (com ajustes) e a avaliação de qualidade vinculada. Usado pela
    // "Análise Focada" (ver public/js/analise-focada.js). Não é arquivo de
    // backup — view derivada, sempre recalculada do banco.
    if (req.method === 'GET' && urlPath === '/db/detalhe_operacao.json') {
      try {
        const idOperacao = queryParams.get('id') || '';
        const detalhe = idOperacao ? db.detalheOperacao(idOperacao) : null;
        res.writeHead(detalhe ? 200 : 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(detalhe || { ok: false, erro: 'Operação não encontrada.' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── GET /db/correlacao_traco_berco.json: 1 linha por USO de traço, já
    // com nº de ajustes (instabilidade) e taxa de vazamento dos berços que
    // aquele traço encheu — usado pelo gráfico de dispersão "Traço Instável
    // × Vazamento" na Análise de Berços (ver public/js/analise-bercos.js).
    // Não é arquivo de backup — view derivada, sempre recalculada do banco.
    if (req.method === 'GET' && urlPath === '/db/correlacao_traco_berco.json') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.correlacaoTracoBerco()));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── GET /db/relatorio_bercos.json: junta bercos_visuais + operacoes
    // (ID da bateria, tipo de montagem) — usado pela página "Relatório de
    // Berços" (ver public/js/relatorio-bercos.js). Não é um arquivo de
    // backup (não está em VALIDADORES_BACKUP_DADOS) — é só uma view
    // derivada, sempre reconstruída na hora a partir do banco.
    if (req.method === 'GET' && urlPath === '/db/relatorio_bercos.json') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.relatorioBercos()));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── GET /db/historico.json: intercepta ANTES do fallback de arquivo
    // estático (mais abaixo, em server.js) — desde a Fase 2,
    // historico.json não existe mais como arquivo de verdade; isso
    // reconstrói o mesmo formato/conteúdo a partir da tabela "operacoes",
    // pra ZERO mudança no navegador (toda tela que já fazia
    // fetch('db/historico.json') continua funcionando sem nenhuma
    // alteração — LW.getStats, Análise Operacional, Debriefing, a tela de
    // Backup de Dados).
    if (req.method === 'GET' && urlPath === '/db/historico.json') {
      try {
        const rows = db.prepare('SELECT * FROM operacoes ORDER BY data ASC, criado_em ASC').all();
        const historico = rows.map(db.rowParaOperacao);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(historico));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    return false;
  };
};
