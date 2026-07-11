// ─── lib/rotas/qualidade.js — Setor de Qualidade / Avaliações ──────────────
// Terceira fatia extraída de server.js (ver lib/rotas/operadores.js pro
// padrão completo). Rotas cobertas: GET /db/avaliacoes_qualidade.json,
// GET /db/operacoes_avaliadas.json, GET /db/avaliacao_paineis.json,
// GET /operacoes-nao-avaliadas, POST /marcar-operacao-avaliada,
// POST /registrar-avaliacao-qualidade, GET /avaliacoes-qualidade.
//
// `lerOperacoesNaoAvaliadas`/`removerDaFilaNaoAvaliadas` são injetadas via
// ctx em vez de vivendo aqui: /registrar-operacao e a Restauração de Backup
// de Dados (ainda em server.js) TAMBÉM chamam essas mesmas funções — mover
// a DEFINIÇÃO pra cá criaria uma dependência de volta de server.js pra este
// módulo, o que quebraria o sentido da extração (depender de código "mais
// abaixo" na cadeia). Nenhuma rota aqui exige sessão/senha de propósito
// (ver comentários originais, preservados abaixo) — mesmo nível de fricção
// baixa do resto do registro operacional do dia a dia.

module.exports = function criarRotasQualidade({ db, lerOperacoesNaoAvaliadas, removerDaFilaNaoAvaliadas }) {

  return function tentar(req, res, urlPath) {

    // ── GET /db/avaliacoes_qualidade.json: idem, reconstrói a partir da
    // tabela "avaliacoes_qualidade" (avaliações já registradas do Setor de
    // Qualidade) — usado pelo Backup de Dados.
    if (req.method === 'GET' && urlPath === '/db/avaliacoes_qualidade.json') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.listarAvaliacoesQualidade()));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── GET /db/operacoes_avaliadas.json: idem, reconstrói a partir da
    // tabela "operacoes_avaliadas" (lista de ids de operação já avaliados
    // pelo Setor de Qualidade — ver CREATE TABLE, db.js) — usado pelo
    // Backup de Dados.
    if (req.method === 'GET' && urlPath === '/db/operacoes_avaliadas.json') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.todosOsOperacoesAvaliadas()));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── GET /db/avaliacao_paineis.json: painéis da Avaliação de Qualidade
    // já normalizados numa tabela própria (avaliacao_paineis) — pronta pra
    // cruzar em SQL com bercos_visuais/tracos/operacoes no futuro (mesmo
    // padrão de relatorio_bercos.json/correlacao_traco_berco.json). Não é
    // arquivo de backup — view derivada, sempre reconstruída do banco.
    if (req.method === 'GET' && urlPath === '/db/avaliacao_paineis.json') {
      try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.listarPaineisAvaliacao()));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // ── FILA DE BATERIAS NÃO AVALIADAS (Setor de Qualidade): lista enxuta
    // (só os campos necessários pra identificar a bateria na fila E
    // preencher automaticamente a tela de avaliação — ver "Nova Avaliação"
    // em setor-qualidade.js) das operações QUE AINDA NÃO TÊM linha em
    // operacoes_avaliadas (ver CREATE TABLE, db.js — substitui a antiga
    // consulta por "avaliado=0" na própria tabela operacoes).
    // Nunca inclui operações de Modo de Teste (modo_teste=0) — o Setor de
    // Qualidade ainda não tem noção de Modo de Teste, então misturar geraria
    // uma bateria "fantasma" na fila de uma instalação de testes.
    // Ordenada da mais antiga pra mais nova (fim ASC) — fila FIFO: quem
    // esperou mais tempo por avaliação aparece primeiro.
    if (req.method === 'GET' && urlPath === '/operacoes-nao-avaliadas') {
      try {
        const ids = lerOperacoesNaoAvaliadas();
        if (!ids.length) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('[]');
          return true;
        }
        // A LISTA de quem está pendente vem do arquivo (fonte de verdade,
        // ver comentário em OPERACOES_NAO_AVALIADAS_PATH) — o SQL aqui é só
        // pra buscar os DETALHES de cada uma pra exibir na tela, nunca pra
        // decidir quem entra ou sai da fila. Um id que porventura não exista
        // mais em "operacoes" (não deveria acontecer — nada aqui deleta
        // operação) simplesmente não aparece no resultado, sem erro.
        const placeholders = ids.map(() => '?').join(',');
        const rows = db.prepare(`
          SELECT id, id_bateria, tipo_montagem, data, fim, turno, capacidade,
                 dimensao, bercos_reais, bercos_personalizados
          FROM operacoes
          WHERE id IN (${placeholders})
          ORDER BY data ASC, fim ASC
        `).all(...ids);
        // bercos_personalizados vem serializado (TEXT) — desserializa aqui
        // pra já entregar um array pronto (ou null) pro front, em vez de
        // cada consumidor ter que fazer o próprio JSON.parse.
        const lista = rows.map(r => ({
          ...r,
          bercos_personalizados: r.bercos_personalizados ? JSON.parse(r.bercos_personalizados) : null,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(lista));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // front assim que uma avaliação iniciada a partir da fila (ver GET
    // /operacoes-nao-avaliadas, acima) é registrada — tira a bateria da
    // fila. Ação do Setor de Qualidade, não do Administrador: de propósito
    // sem exigir sessão de admin (diferente de /editar-operacao), mesmo
    // nível de fricção das outras rotas internas do dia a dia.
    // Grava em "operacoes_avaliadas" (INSERT), não mais um UPDATE na
    // própria linha de "operacoes" — ver db.marcarOperacaoAvaliada e a
    // CREATE TABLE correspondente em db.js.
    if (req.method === 'POST' && urlPath === '/marcar-operacao-avaliada') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          if (!id || typeof id !== 'string') throw new Error('ID da operação ausente.');

          const existe = db.prepare('SELECT 1 FROM operacoes WHERE id = ?').get(id);
          if (!existe) throw new Error('Operação não encontrada (id: ' + id + ').');
          db.marcarOperacaoAvaliada(id); // idempotente — repetir a chamada não faz nada além de confirmar
          removerDaFilaNaoAvaliadas(id); // idempotente também — id que já não está na lista, não faz nada

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── REGISTRAR AVALIAÇÃO DE QUALIDADE (Setor de Qualidade): grava a
    // avaliação DEFINITIVA (não rascunho — rascunhos continuam só no
    // localStorage do navegador, ver setor-qualidade.js) — 1 linha em
    // avaliacoes_qualidade, painéis inclusos como JSON (ver
    // db.salvarAvaliacaoQualidade). Sem exigir sessão de admin nem
    // dispositivo autorizado, de propósito — mesmo nível de fricção baixa
    // de /marcar-berco-andamento e outras rotas internas do dia a dia.
    if (req.method === 'POST' && urlPath === '/registrar-avaliacao-qualidade') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const avaliacao = JSON.parse(body);
          if (!avaliacao || typeof avaliacao !== 'object' || !avaliacao.id) {
            throw new Error('Avaliação inválida — falta o id.');
          }

          // ── BLOQUEIO DE AVALIAÇÃO AVULSA (2ª camada de prevenção) ──
          // Avaliação avulsa (sem vir da fila, linkedOperacaoId ausente)
          // era o que causava a Análise Focada não encontrar o resultado
          // (ver correção em db.marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada,
          // que resolve os casos que já existiam) — daqui pra frente, uma
          // avaliação NOVA só é aceita se já vier vinculada a uma operação
          // real da fila. O front (setor-qualidade.js) já trava isso na
          // tela (botão "Registrar" desabilitado sem selecionar da fila),
          // mas a validação de verdade é aqui — quem manda direto pra rota
          // (sem passar pela tela) não consegue burlar.
          //
          // "jaExistiaAntes" distingue registro NOVO de CORREÇÃO (mesmo id
          // já existente): uma correção de um registro legado que ainda
          // não tenha vínculo (de antes desta trava existir) continua
          // podendo ser salva — não trava quem só está editando algo que
          // já estava assim.
          const jaExistiaAntes = !!db.prepare('SELECT 1 FROM avaliacoes_qualidade WHERE id = ?').get(avaliacao.id);
          if (!jaExistiaAntes) {
            if (!avaliacao.linkedOperacaoId || typeof avaliacao.linkedOperacaoId !== 'string') {
              throw new Error('Avaliação avulsa não é mais permitida — selecione uma bateria da fila (Ordem de Previsão de Desemplaque) antes de avaliar.');
            }
            const operacaoExiste = db.prepare('SELECT 1 FROM operacoes WHERE id = ?').get(avaliacao.linkedOperacaoId);
            if (!operacaoExiste) {
              throw new Error('Operação vinculada não encontrada — atualize a fila e tente novamente.');
            }
          }

          db.salvarAvaliacaoQualidade(avaliacao);

          // Classificação da operação como avaliada/não avaliada (ver
          // db.marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada, db.js):
          // avaliação vinda da fila já é marcada por uma chamada separada do
          // front a /marcar-operacao-avaliada (com o id_operacao exato).
          // O bloqueio acima impede QUALQUER avaliação nova sem
          // linkedOperacaoId — este branch só continua existindo pra
          // permitir salvar uma CORREÇÃO de um registro legado (de antes
          // desta trava) que ainda não tinha vínculo, casando pela bateria
          // + mais antiga pendente (FIFO). Nunca mexe numa avaliação que já
          // veio vinculada.
          if (!avaliacao.linkedOperacaoId && avaliacao.batteryId) {
            // Passa o id da própria avaliação (avaliacao.id) pra também
            // retro-vincular id_operacao nela, não só tirar a operação da
            // fila — ver comentário de marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada
            // (db.js) sobre o bug que isso corrige (Análise Focada não
            // encontrava avaliações avulsas).
            try {
              const idMarcado = db.marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada(avaliacao.batteryId, avaliacao.id);
              if (idMarcado) removerDaFilaNaoAvaliadas(idMarcado); // idem: tira da fila em arquivo também (ver OPERACOES_NAO_AVALIADAS_PATH)
            }
            catch (e) { console.error('Falha ao classificar operação (avaliação avulsa) como avaliada:', e); }
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

    // ── LISTAR AVALIAÇÕES DE QUALIDADE: alimenta o Dashboard e os
    // Registros do Setor de Qualidade — cada item já vem com os painéis
    // embutidos (ver db.listarAvaliacoesQualidade), mais recente primeiro.
    if (req.method === 'GET' && urlPath === '/avaliacoes-qualidade') {
      try {
        const lista = db.listarAvaliacoesQualidade();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(lista));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    return false;
  };
};
