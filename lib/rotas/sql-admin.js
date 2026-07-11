// ─── lib/rotas/sql-admin.js — Dados SQL (Configurações → 🗄️ Dados SQL) ─────
// Quarta fatia extraída de server.js (ver lib/rotas/operadores.js pro
// padrão completo). Rotas cobertas: GET /admin/sql-tabelas,
// GET /admin/sql-linhas, POST /admin/sql-excluir-linha,
// POST /admin/sql-limpar-tabela — todas exigem sessão de Administrador
// válida (dados de produção inteiros e exclusão permanente não podem
// ficar atrás só do "abrir Configurações" do lado do navegador).
//
// `adicionarNaFilaNaoAvaliadas`/`broadcastDadosSqlExcluidos` são
// injetadas via ctx em vez de viverem aqui — são compartilhadas com
// outros domínios (a 1ª também por /registrar-operacao e a Restauração
// de Backup de Dados, ainda em server.js; a 2ª é o helper de WebSocket,
// definido perto de wss).
//
// Primeiro módulo desta série que precisa de `queryParams` (valor por
// REQUISIÇÃO, não pode vir fixo no ctx da factory) — por isso `tentar`
// aqui recebe um 4º argumento. Os módulos anteriores (operadores.js,
// paradas.js, qualidade.js) continuam funcionando exatamente iguais: um
// argumento a mais que eles não declaram é só ignorado pelo JS.

module.exports = function criarRotasSqlAdmin({ db, sessao, adicionarNaFilaNaoAvaliadas, broadcastDadosSqlExcluidos }) {

  // Whitelist de tabelas expostas nesta tela — ver comentário original
  // (preservado): nome de tabela/coluna usados nas queries SEMPRE vêm
  // daqui, nunca são montados a partir do que o cliente manda.
  const TABELAS_SQL_ADMIN = {
    operacoes:            { pk: 'id',           label: 'Operações (Registro de Baterias)' },
    edicoes_operacao:     { pk: 'id',           label: 'Auditoria de Edições — Operações' },
    tracos:                { pk: 'id_traco',     label: 'Traços (Relatório de Injeção)' },
    traco_usos:            { pk: 'id',           label: 'Usos de Traço' },
    ajustes:                { pk: 'id',           label: 'Ajustes de Receita' },
    leituras_resultado:     { pk: 'id',           label: 'Leituras de Densidade/Flow' },
    edicoes_traco:          { pk: 'id',           label: 'Auditoria de Edições — Traços' },
    contador_tracos:        { pk: 'data',         label: 'Contador de Traços do Dia' },
    paradas:                { pk: 'id',           label: 'Paradas' },
    sobra:                  { pk: 'id',           label: 'Sobra' },
    bercos_visuais:         { pk: 'id_operacao',  label: 'Berços Visuais' },
    avaliacoes_qualidade:   { pk: 'id',           label: 'Avaliações de Qualidade' },
    avaliacao_paineis:      { pk: 'id_avaliacao', label: 'Painéis de Avaliação' },
    operacoes_avaliadas:    { pk: 'id_operacao',  label: 'Operações Avaliadas (Setor de Qualidade)' },
  };

  // Teto de linhas devolvidas por GET /admin/sql-linhas — ver comentário
  // original: sistema de uso interno, volume baixo, só evita travar o
  // navegador se uma tabela crescer muito. Mais recentes primeiro.
  const SQL_ADMIN_LIMITE_LINHAS = 1000;

  function semSessao(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
  }

  return function tentar(req, res, urlPath, queryParams) {

    // ── GET /admin/sql-tabelas: lista as tabelas do whitelist com a
    // contagem atual de linhas — popula o <select> da aba.
    if (req.method === 'GET' && urlPath === '/admin/sql-tabelas') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      try {
        const tabelas = Object.entries(TABELAS_SQL_ADMIN).map(([tabela, info]) => {
          const { total } = db.prepare(`SELECT COUNT(*) AS total FROM "${tabela}"`).get();
          return { tabela, label: info.label, pk: info.pk, linhas: total };
        });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, tabelas }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── GET /admin/sql-linhas?tabela=xxx: colunas + linhas (mais recentes
    // primeiro) de UMA tabela do whitelist — nunca a tabela crua vinda do
    // cliente, sempre a chave já validada contra TABELAS_SQL_ADMIN.
    if (req.method === 'GET' && urlPath === '/admin/sql-linhas') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      try {
        const tabela = queryParams.get('tabela') || '';
        const info = TABELAS_SQL_ADMIN[tabela];
        if (!info) throw new Error('Tabela desconhecida ou não permitida: ' + tabela);

        const colunas = db.prepare(`PRAGMA table_info("${tabela}")`).all().map(c => c.name);
        const linhas = db.prepare(`SELECT * FROM "${tabela}" ORDER BY rowid DESC LIMIT ?`).all(SQL_ADMIN_LIMITE_LINHAS);

        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, tabela, pk: info.pk, colunas, linhas, limite: SQL_ADMIN_LIMITE_LINHAS }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── POST /admin/sql-excluir-linha: apaga UMA linha, pelo valor da PK
    // real da tabela (ver TABELAS_SQL_ADMIN) — nunca por índice/posição na
    // lista, que pode mudar a qualquer novo registro. Se a tabela tiver
    // FOREIGN KEY apontando pra ela (ex.: bercos_visuais → operacoes) e
    // ainda existir linha dependente, o SQLite recusa o DELETE sozinho
    // (foreign_keys = ON, ver topo de db.js) — devolvemos isso como erro
    // 400 de validação, não como falha de servidor.
    //
    // CASO ESPECIAL — "operacoes_avaliadas": excluir uma linha aqui não é
    // um DELETE avulso — significa "desfazer a avaliação desta operação
    // por completo". Por isso usa db.desfazerAvaliacaoOperacao(), que
    // também apaga avaliacao_paineis e avaliacoes_qualidade daquela
    // operação (senão ficariam órfãs: a avaliação continuaria existindo,
    // só que de uma operação marcada como pendente de novo) — e, como
    // consequência natural de tirar o id de operacoes_avaliadas, a
    // operação volta a aparecer em GET /operacoes-nao-avaliadas (a fila do
    // Setor de Qualidade), sem nenhum passo extra.
    if (req.method === 'POST' && urlPath === '/admin/sql-excluir-linha') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { tabela, valor } = JSON.parse(body);
          const info = TABELAS_SQL_ADMIN[tabela];
          if (!info) throw new Error('Tabela desconhecida ou não permitida: ' + tabela);
          if (valor === undefined || valor === null || valor === '') throw new Error('Valor da chave (' + info.pk + ') não informado.');

          // Mesmo padrão de /registrar-operacao: quem originou a ação manda
          // seu próprio OP_ANDAMENTO_CLIENT_ID via query string, só pra ELE
          // ser excluído do broadcast abaixo (essa aba já recarrega sozinha
          // depois do fetch — ver cfgSqlExcluirLinha, app-core.js).
          const wsClientId = queryParams.get('wsClientId') || '';

          if (tabela === 'operacoes_avaliadas') {
            const r = db.desfazerAvaliacaoOperacao(valor);
            if (!r.avaliacaoPaineis && !r.avaliacoesQualidade && !r.operacoesAvaliadas) {
              throw new Error('Linha não encontrada (nenhuma alteração feita).');
            }

            // A fila de "não avaliadas" do Setor de Qualidade NÃO é
            // recalculada do SQL a cada request — é um arquivo próprio
            // (operacoes_nao_avaliadas.json, ver "FILA DE AVALIAÇÃO" mais
            // acima) mantido em sincronia manualmente em cada ponto que
            // marca/desmarca uma operação como avaliada. Sem esta linha, a
            // operação sumiria de operacoes_avaliadas no SQL mas NUNCA
            // voltaria a aparecer na fila visível do Setor de Qualidade.
            // Mesma regra de sempre: nunca reinsere operação de Modo de
            // Teste (a fila não tem noção disso).
            const operacao = db.prepare('SELECT modo_teste FROM operacoes WHERE id = ?').get(valor);
            if (operacao && !operacao.modo_teste) {
              adicionarNaFilaNaoAvaliadas(valor);
            }

            // Avisa TODO MUNDO conectado (qualquer navegador/página — ver
            // broadcastDadosSqlExcluidos, perto do WebSocket, mais abaixo)
            // que esses dados mudaram, pra ninguém continuar vendo a
            // avaliação/painéis já excluídos até um F5 manual.
            broadcastDadosSqlExcluidos({ tabela, valor }, wsClientId);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              cascata: {
                avaliacao_paineis: r.avaliacaoPaineis,
                avaliacoes_qualidade: r.avaliacoesQualidade,
                operacoes_avaliadas: r.operacoesAvaliadas,
              },
            }));
            return;
          }

          const resultado = db.prepare(`DELETE FROM "${tabela}" WHERE "${info.pk}" = ?`).run(valor);
          if (resultado.changes === 0) throw new Error('Linha não encontrada (nenhuma alteração feita).');

          broadcastDadosSqlExcluidos({ tabela, valor }, wsClientId);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          const mensagemAmigavel = /FOREIGN KEY constraint failed/i.test(e.message)
            ? 'Não é possível excluir: existem outros registros que dependem desta linha (ex.: usos, avaliações ou berços vinculados a esta operação).'
            : e.message;
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: mensagemAmigavel }));
        }
      });
      return true;
    }

    // ── POST /admin/sql-limpar-tabela: apaga TODAS as linhas de uma tabela
    // do whitelist de uma vez (botão "🧹 Limpar Todas", ao lado do "↺
    // Atualizar" — ver cfgSqlLimparTabela, app-core.js). Mesma exigência de
    // sessão de administrador das rotas acima; a senha de Administrador é
    // pedida DE NOVO no cliente antes de chamar esta rota (mesmo padrão de
    // cfgSqlExcluirLinha).
    //
    // "operacoes_avaliadas" tem o MESMO caso especial de
    // /admin/sql-excluir-linha — só que em lote: cada id vira uma chamada de
    // db.desfazerAvaliacaoOperacao (apaga avaliacao_paineis +
    // avaliacoes_qualidade + a própria marcação, ver comentário na função,
    // db.js) e, se a operação não for de Modo de Teste, volta pra fila de
    // avaliação pendente — exatamente como excluir cada linha uma por uma
    // pelo botão "✕ Excluir", só que sem precisar clicar em cada uma.
    //
    // Mesmo tratamento de FOREIGN KEY constraint da rota de linha única (pra
    // qualquer OUTRA tabela do whitelist): se ainda houver linha dependente
    // em outra tabela, o SQLite recusa o DELETE inteiro (nada é apagado —
    // não é uma exclusão parcial) e devolve mensagem amigável, não erro de
    // servidor.
    if (req.method === 'POST' && urlPath === '/admin/sql-limpar-tabela') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { tabela } = JSON.parse(body);
          const info = TABELAS_SQL_ADMIN[tabela];
          if (!info) throw new Error('Tabela desconhecida ou não permitida: ' + tabela);

          const wsClientId = queryParams.get('wsClientId') || '';

          if (tabela === 'operacoes_avaliadas') {
            const ids = db.prepare('SELECT id_operacao FROM operacoes_avaliadas').all().map(r => r.id_operacao);
            const cascata = { avaliacao_paineis: 0, avaliacoes_qualidade: 0, operacoes_avaliadas: 0 };
            ids.forEach(id => {
              const r = db.desfazerAvaliacaoOperacao(id);
              cascata.avaliacao_paineis    += r.avaliacaoPaineis;
              cascata.avaliacoes_qualidade += r.avaliacoesQualidade;
              cascata.operacoes_avaliadas  += r.operacoesAvaliadas;

              // Mesma regra de sempre (ver POST /admin/sql-excluir-linha,
              // acima): nunca reinsere operação de Modo de Teste na fila —
              // ela não tem noção disso.
              const operacao = db.prepare('SELECT modo_teste FROM operacoes WHERE id = ?').get(id);
              if (operacao && !operacao.modo_teste) adicionarNaFilaNaoAvaliadas(id);
            });

            broadcastDadosSqlExcluidos({ tabela, limpezaTotal: true }, wsClientId);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, excluidas: cascata.operacoes_avaliadas, cascata }));
            return;
          }

          const resultado = db.prepare(`DELETE FROM "${tabela}"`).run();

          broadcastDadosSqlExcluidos({ tabela, limpezaTotal: true }, wsClientId);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, excluidas: resultado.changes }));
        } catch (e) {
          const mensagemAmigavel = /FOREIGN KEY constraint failed/i.test(e.message)
            ? 'Não é possível limpar: existem registros em outras tabelas que dependem de linhas desta (ex.: usos, avaliações ou berços vinculados). Limpe primeiro as tabelas dependentes.'
            : e.message;
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: mensagemAmigavel }));
        }
      });
      return true;
    }

    return false;
  };
};
