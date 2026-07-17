// ─── lib/rotas/registro-operacao.js — Registrar Operação + Relatório ───────
// Décima sexta fatia extraída de server.js (ver lib/rotas/operadores.js pro
// padrão completo) — as DUAS rotas mais centrais do sistema: é aqui que uma
// operação de verdade nasce (POST /registrar-operacao) e onde os traços
// dela são gravados (POST /registrar-relatorio-injecao). Tratadas com o
// máximo de cuidado: conteúdo idêntico ao que estava em server.js, nenhuma
// linha de lógica reescrita — só movida, com as dependências compartilhadas
// (usadas por outros domínios ainda em server.js, ou pelo WebSocket)
// injetadas via ctx.
//
// `podeControlarOperacao`/`negarControleDeOperacao`/
// `dirParaModoTeste`/`lerBercosAndamento`/`salvarBercosAndamentoNoDisco`/
// `adicionarNaFilaNaoAvaliadas` são compartilhadas com outros domínios.
// `broadcastOperacaoFinalizada` é hoisted, definida perto do WebSocket.
//
// `podeControlarOperacao`/`negarControleDeOperacao` checam a sessão de
// USUÁRIO logado (ver lib/sessao-usuario.js, lib/perfis.js) E, de novo
// (voltou — ver conversa que motivou a mudança), se `deviceId` está na
// lista de dispositivos autorizados (ver dispositivoAutorizado(),
// server.js) — as duas juntas.
//
// `modoTeste` é derivado aqui dentro a partir de queryParams (mesma
// expressão usada em server.js).

module.exports = function criarRotasRegistroOperacao({
  db, fs, path, dirParaModoTeste,
  podeControlarOperacao, negarControleDeOperacao,
  lerBercosAndamento, salvarBercosAndamentoNoDisco,
  adicionarNaFilaNaoAvaliadas, broadcastOperacaoFinalizada,
}) {

  return function tentar(req, res, urlPath, queryParams) {
    const modoTeste = queryParams.get('modoTeste') === 'true';
    const deviceId = queryParams.get('deviceId') || '';

    // Registrar operação — grava na tabela operacoes (SQL); em Modo de
    // Teste, continua indo pro JSON isolado de sempre (ver dirParaModoTeste).
    if (req.method === 'POST' && urlPath === '/registrar-operacao') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        if (!modoTeste && !podeControlarOperacao(req, deviceId)) { negarControleDeOperacao(res, deviceId); return; }
        try {
          const record = JSON.parse(body);
          // Campo LEGADO (coluna "operacoes.avaliado" — ver db.js): mantido
          // só como default seguro (sempre 0/false na criação), mas quem
          // decide "esta operação já foi avaliada?" a partir de agora é a
          // tabela "operacoes_avaliadas" (ver db.marcarOperacaoAvaliada /
          // marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada). Ignora
          // qualquer valor vindo do front pra este campo. Vale pros dois
          // caminhos abaixo (Modo de Teste em JSON e SQLite).
          record.avaliado = false;

          if (modoTeste) {
            const historicoPath = path.join(dirParaModoTeste(modoTeste), 'historico.json');
            let historico = [];
            try { historico = JSON.parse(fs.readFileSync(historicoPath, 'utf8')); } catch (_) {}
            historico.push(record);
            fs.writeFileSync(historicoPath, JSON.stringify(historico, null, 2), 'utf8');
          } else {
            db.prepare(db.SQL_INSERIR_OPERACAO).run({
              ...db.operacaoParaRow(record),
              modo_teste: 0,
              criado_em: new Date().toISOString(),
            });

            // Berços Visuais — 1 linha por berço desta operação. Usa berços
            // REAIS se informado (pode ser menor que a capacidade nominal da
            // bateria — operação parcial), senão a capacidade nominal mesmo
            // (mesma prioridade já usada pelo popover "Bateria Atual" — ver
            // bateria-atual.js, _baCapacidade). Estados: parte do que já foi
            // marcado ao vivo (baixou/vazou — ver GET/POST /bercos-andamento)
            // em vez de nascer tudo 'okay' à toa; e reseta o snapshot ao vivo
            // logo em seguida — essa operação virou histórico agora, o
            // snapshot é só pra enquanto ela está em andamento.
            const qtdBercos = parseInt(record.bercos_reais) || parseInt(record.capacidade) || 0;
            db.criarBercosVisuaisIniciais(record.id, qtdBercos, lerBercosAndamento());
            salvarBercosAndamentoNoDisco({});

            // Entra na fila de avaliação do Setor de Qualidade — ver
            // comentário em OPERACOES_NAO_AVALIADAS_PATH, acima. Nunca em
            // Modo de Teste (esse ramo nem chega aqui — ver `if (modoTeste)`
            // logo acima; mesma regra de sempre pra essa fila).
            adicionarNaFilaNaoAvaliadas(record.id);

            // Avisa todo mundo conectado agora (exceto quem registrou) —
            // dinâmica de "dono" da operação chegou ao fim. Nunca em modo de
            // teste (esse ramo nem chega aqui — ver `if (modoTeste)` acima).
            broadcastOperacaoFinalizada({
              id_bateria: record.id_bateria,
              tempo_min: record.tempo_min,
              total_paineis: record.total_paineis,
              m2_total: record.m2_total,
              desemplaque: record.desemplaque,
              houve_atraso: record.houve_atraso,
            }, queryParams.get('wsClientId') || '');
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch(e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // Registrar linhas do relatório de injeção — grava nas tabelas tracos/
    // traco_usos/leituras_resultado (SQL); em Modo de Teste, continua indo
    // pro JSON isolado de sempre.
    if (req.method === 'POST' && urlPath === '/registrar-relatorio-injecao') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        if (!modoTeste && !podeControlarOperacao(req, deviceId)) { negarControleDeOperacao(res, deviceId); return; }
        try {
          const dadosRecebidos = JSON.parse(body);

          if (modoTeste) {
            const relatorioPath = path.join(dirParaModoTeste(true), 'relatorio_injecao.json');
            let relatorio = [];
            try { relatorio = JSON.parse(fs.readFileSync(relatorioPath, 'utf8')); } catch (_) { relatorio = []; }
            dadosRecebidos.forEach(novoTraco => {
              const registroExistente = relatorio.find(r => r.id_traco === novoTraco.id_traco);
              if (registroExistente) {
                if (!registroExistente.ultilizado) registroExistente.ultilizado = { operacao: [] };
                registroExistente.ultilizado.operacao.push(...novoTraco.ultilizado.operacao);
              } else {
                relatorio.push(novoTraco);
              }
            });
            fs.writeFileSync(relatorioPath, JSON.stringify(relatorio, null, 2), 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          // Caminho real (SQL):
          const inserirTraco = db.prepare(db.SQL_INSERIR_TRACO);
          const inserirUso = db.prepare(db.SQL_INSERIR_USO);
          const inserirLeitura = db.prepare(db.SQL_INSERIR_LEITURA);

          db.transaction(() => {
            dadosRecebidos.forEach(novoTraco => {
              const tracoExiste = db.prepare('SELECT 1 FROM tracos WHERE id_traco = ?').get(novoTraco.id_traco);

              if (!tracoExiste) {
                // Traço novo: os 5 insumos + tempo de batida confiam no
                // .original do payload SE já existir ajuste pra esse traço
                // na tabela "ajustes" (gravado ao vivo, durante a operação,
                // via /registrar-ajuste-traco) — senão colapsa original+
                // ajustes num único total (mesma regra da migração; ver
                // README, "Banco de Dados (SQLite)" -> Fase 5).
                const jaTemAjustes = !!db.prepare('SELECT 1 FROM ajustes WHERE id_traco = ? LIMIT 1').get(novoTraco.id_traco);

                const paramsTraco = {
                  id_traco: novoTraco.id_traco, data: novoTraco.data, turno: novoTraco.turno ?? null,
                  num_traco: novoTraco.num_traco ?? null,
                };
                const CAMPOS_SOMA_LOCAIS = [
                  ['cimento_real', 'cimento_original'], ['agua_real', 'agua_original'], ['eps_real', 'eps_original'],
                  ['superplast_real', 'superplast_original'], ['incorporador_real', 'incorporador_original'],
                ];
                CAMPOS_SOMA_LOCAIS.forEach(([campoJson, coluna]) => {
                  const original = db.extrairOriginal(novoTraco[campoJson]);
                  const ajustesDoCampo = db.extrairAjustesNumericos(novoTraco[campoJson]);
                  paramsTraco[coluna] = (jaTemAjustes || !ajustesDoCampo.length)
                    ? original
                    : (original || 0) + ajustesDoCampo.reduce((s, v) => s + v, 0);
                });
                {
                  const original = db.extrairOriginal(novoTraco.tempo_batida);
                  const ajustesDoCampo = db.extrairAjustesNumericos(novoTraco.tempo_batida);
                  paramsTraco.tempo_batida_original = (jaTemAjustes || !ajustesDoCampo.length)
                    ? original
                    : (original || 0) + ajustesDoCampo.reduce((s, v) => s + v, 0);
                }
                paramsTraco.densidade_original = db.extrairOriginal(novoTraco.densidade);
                paramsTraco.flow_original = db.extrairOriginal(novoTraco.flow);
                paramsTraco.obs = novoTraco.obs ?? null;
                paramsTraco.silo = novoTraco.silo ?? null;
                paramsTraco.expansao = novoTraco.expansao ?? null;
                paramsTraco.densidade_eps = novoTraco.densidade_eps ?? null;

                inserirTraco.run(paramsTraco);

                // Leituras de densidade/flow — traço é novo, nunca teve
                // nenhuma leitura registrada ainda.
                ['densidade', 'flow'].forEach(campo => {
                  db.extrairAjustesNumericos(novoTraco[campo]).forEach((valor, i) => {
                    inserirLeitura.run({ id_traco: novoTraco.id_traco, campo, valor, ordem: i + 1 });
                  });
                });
              }

              // Em qualquer caso (novo ou reaproveitado): adiciona o(s) uso(s)
              // — mesmo comportamento de sempre, nunca toca em outro campo do
              // traço quando ele já existe (nem densidade/flow, se mudou
              // nesse reaproveitamento — limitação que já existia antes
              // desta migração, replicada de propósito, não introduzida agora).
              (novoTraco.ultilizado?.operacao || []).forEach(uso => {
                inserirUso.run({
                  id_traco: novoTraco.id_traco,
                  id_operacao: uso.id_operacao ?? '',
                  id_bateria: uso.id_bateria ?? null,
                  berco_inicio: uso.berco_inicio ?? null,
                  berco_finalizacao: uso.berco_finalizacao ?? null,
                  obs: uso.obs ?? null,
                });
              });
            });
          })();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
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
