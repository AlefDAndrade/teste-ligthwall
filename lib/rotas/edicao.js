// ─── lib/rotas/edicao.js — Editar Operação / Editar Traço ──────────────────
// Décima quinta fatia extraída de server.js (ver lib/rotas/operadores.js
// pro padrão completo). Rotas cobertas: POST /editar-operacao,
// POST /editar-traco-relatorio.
//
// As duas fazem parte das ferramentas da INJETORA (modelo novo, ver
// lib/perfis.js): editar o histórico (operação/traço já salvos) é
// permitido a quem tem a área 'injetora' de edição — Operador de
// Injetora, Encarregado, Supervisão, Administrador (e o Administrador
// Master, como sempre). Antes exigia exclusivamente a sessão mestra.
// `numOuNulo` é injetada via ctx — compartilhada com outros domínios
// ainda em server.js.

module.exports = function criarRotasEdicao({ db, podeEditarArea, negarEdicao, numOuNulo }) {

  // Espelha LIMITE_INJECAO_MIN/diffMinutes (public/js/data.js) — só usado
  // aqui em POST /editar-operacao-avancado, pra recalcular tempo_min/
  // houve_atraso no SERVIDOR (nunca confiar só no navegador pra isso,
  // diferente de POST /registrar-operacao, que já confia no valor vindo do
  // cliente — mas aqui é edição administrativa de histórico, vale a pena
  // ser mais rígido). Duplicado (não importado de data.js) porque
  // data.js roda no navegador (usa `window`/DOM em outros pontos do
  // arquivo) — não dá pra `require()` ele aqui sem trazer esse contexto
  // junto. Se o limite mudar em Configurações no futuro, lembrar de mudar
  // os dois lugares.
  const LIMITE_INJECAO_MIN = 59;
  function _diffMinutos(inicioIso, fimIso) {
    return (new Date(fimIso) - new Date(inicioIso)) / 60000;
  }

  return function tentar(req, res, urlPath) {

    // ── EDITAR OPERAÇÃO: corrige um registro da tabela operacoes já existente
    // (UPDATE em cima dele, não cria um novo) e grava um log de auditoria em
    // edicoes_operacao — base pra futuro controle de eficiência de
    // preenchimento das operações ───────────────────────────────────────────
    if (req.method === 'POST' && urlPath === '/editar-operacao') {
      // Antes, a trava de "só Administrador" era só visual (tela) — qualquer
      // um que soubesse a URL podia editar uma operação sem senha nenhuma
      // (ver README, "Limitações conhecidas"). Agora exige a MESMA sessão
      // emitida por POST /verificar-senha (ver lib/sessao.js) — como o
      // perfil Administrador sempre pede senha no login (README, "Perfis de
      // usuário"), a sessão já existe nesse ponto pra quem entrou como
      // Administrador; não é fricção nova pro fluxo normal.
      if (!podeEditarArea(req, 'injetora')) { negarEdicao(res, 'o histórico de operações e traços'); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const { id, novosValores, diff } = payload;

          if (!id || typeof id !== 'string') throw new Error('ID da operação ausente.');
          if (!novosValores || typeof novosValores !== 'object' || Array.isArray(novosValores)) {
            throw new Error('Payload inválido: "novosValores" ausente.');
          }
          if (!Array.isArray(diff) || !diff.length) {
            throw new Error('Nenhuma alteração informada.');
          }

          // Campos que NUNCA podem ser alterados por aqui — são capturados
          // automaticamente pelo sistema ou são a própria identidade do
          // registro. Checagem no servidor, não só na tela — nunca confiamos
          // só na validação do navegador.
          // houve_atraso é calculado (tempo_min > limite de injeção), não uma
          // escolha manual do operador — nunca editável diretamente.
          // avaliado é controlado pelo Setor de Qualidade, não pelo
          // formulário de edição de operação — mesma lógica.
          const CAMPOS_PROTEGIDOS = new Set(['id', 'data', 'inicio', 'fim', 'tempo_min', 'qtd_tracos', 'tracos', 'houve_atraso', 'avaliado']);
          const tentouAlterarProtegido = Object.keys(novosValores).filter(c => CAMPOS_PROTEGIDOS.has(c));
          if (tentouAlterarProtegido.length) {
            throw new Error('Campo(s) não editável(eis): ' + tentouAlterarProtegido.join(', '));
          }

          const atual = db.prepare('SELECT * FROM operacoes WHERE id = ?').get(id);
          if (!atual) throw new Error('Operação não encontrada (id: ' + id + ').');

          // Mescla em cima do que já está no banco — igual ao spread
          // {...historico[idx], ...novosValores} de antes, só que primeiro
          // convertendo a linha SQL pro formato historico.json (onde
          // novosValores já está, vindo do navegador), e na volta convertendo
          // o resultado mesclado de volta pra parâmetros de coluna.
          const mesclado = { ...db.rowParaOperacao(atual), ...novosValores };

          db.prepare(`
            UPDATE operacoes SET
              dimensao = @dimensao, capacidade = @capacidade, id_bateria = @id_bateria,
              tipo_montagem = @tipo_montagem, turno = @turno,
              motivo_atraso = @motivo_atraso, bercos_personalizados = @bercos_personalizados,
              bercos_dimensoes = @bercos_dimensoes,
              total_paineis = @total_paineis, m2_total = @m2_total, placas_cimenticia = @placas_cimenticia,
              paineis_por_tipo = @paineis_por_tipo, m2_por_tipo = @m2_por_tipo,
              paineis_2p = @paineis_2p, paineis_sp = @paineis_sp, m2_2p = @m2_2p, m2_sp = @m2_sp
            WHERE id = @id
          `).run(db.operacaoParaRow(mesclado));

          // Log de auditoria — append-only, nunca apaga/sobrescreve entradas
          // antigas. Cada edição (mesmo que no mesmo id) gera uma entrada nova.
          db.prepare(`
            INSERT INTO edicoes_operacao (id_operacao, data_edicao, campos_alterados)
            VALUES (?, ?, ?)
          `).run(id, new Date().toISOString(), JSON.stringify(diff));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── EDITAR TRAÇO (Relatório de Injeção): corrige um traço já registrado
    // em relatorio_injecao.json (id_bateria/berços/obs do USO específico
    // clicado, dados de identificação do traço, e os 5 insumos + tempo de
    // batida) e, ao mesmo tempo, REGRAVA ajustes_tracos.json pra esse
    // id_traco a partir da mesma lista de ajustes editada — esse arquivo é
    // a fonte de verdade dos ajustes a partir de agora; os campos
    // "*_real"/tempo_batida de relatorio_injecao.json (.ajustes[]) são
    // sempre DERIVADOS dele aqui, nunca editados soltos, pra nunca mais
    // ficarem fora de sincronia. Densidade/Flow não passam por
    // ajustes_tracos.json (são remedições, não ajustes de receita — ver
    // README), então continuam com sua própria lista de leituras.
    // Auditoria em relatorio_edicoes.json (mesmo padrão de
    // historico_edicoes.json, indexado por id_traco).
    if (req.method === 'POST' && urlPath === '/editar-traco-relatorio') {
      // Mesma checagem aplicada a /editar-operacao, acima — ver comentário lá.
      if (!podeEditarArea(req, 'injetora')) { negarEdicao(res, 'o histórico de operações e traços'); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const { id_traco, id_operacao, novosValores, ajustes, diff } = payload;

          if (!id_traco || typeof id_traco !== 'string') throw new Error('ID do traço ausente.');
          if (!id_operacao || typeof id_operacao !== 'string') throw new Error('ID da operação (uso) ausente.');
          if (!novosValores || typeof novosValores !== 'object' || Array.isArray(novosValores)) {
            throw new Error('Payload inválido: "novosValores" ausente.');
          }
          if (!Array.isArray(ajustes)) throw new Error('Payload inválido: "ajustes" precisa ser uma lista.');
          if (!Array.isArray(diff) || !diff.length) throw new Error('Nenhuma alteração informada.');

          // Cada ajuste precisa de tempo_batida (minutos, > 0) — mesma regra
          // do Ajuste de Receita ao vivo, em Registrar Operação.
          ajustes.forEach((a, i) => {
            if (!a || typeof a !== 'object' || typeof a.tempo_batida !== 'number' || a.tempo_batida <= 0) {
              throw new Error(`Ajuste #${i + 1}: "tempo_batida" obrigatório (minutos, > 0).`);
            }
          });

          const traco = db.prepare('SELECT * FROM tracos WHERE id_traco = ?').get(id_traco);
          if (!traco) throw new Error('Traço não encontrado (id_traco: ' + id_traco + ').');

          const uso = db.prepare('SELECT * FROM traco_usos WHERE id_traco = ? AND id_operacao = ?').get(id_traco, id_operacao);
          if (!uso) throw new Error('Uso/operação não encontrado pra esse traço (id_operacao: ' + id_operacao + ').');

          db.transaction(() => {
            // Dados do USO específico clicado (id_bateria/berços/obs) — só
            // essa linha de traco_usos, nunca as outras (mesmo traço pode
            // ter sido reaproveitado em mais de uma bateria).
            if (novosValores.uso) {
              db.prepare(`
                UPDATE traco_usos SET id_bateria = @id_bateria, berco_inicio = @berco_inicio,
                  berco_finalizacao = @berco_finalizacao, obs = @obs
                WHERE id_traco = @id_traco AND id_operacao = @id_operacao
              `).run({
                id_traco, id_operacao,
                id_bateria: novosValores.uso.id_bateria ?? uso.id_bateria,
                berco_inicio: novosValores.uso.berco_inicio ?? uso.berco_inicio,
                berco_finalizacao: novosValores.uso.berco_finalizacao ?? uso.berco_finalizacao,
                obs: novosValores.uso.obs ?? uso.obs,
              });
            }

            // Identificação do traço (compartilhada entre todos os usos) +
            // os "originais" dos insumos/tempo de batida, que vêm prontos do
            // formulário (sem colapso — diferente da migração/registro ao
            // vivo, aqui o original já é exatamente o que a pessoa digitou).
            const originais = novosValores.originais || {};
            db.prepare(`
              UPDATE tracos SET
                num_traco = @num_traco, densidade_eps = @densidade_eps, silo = @silo, expansao = @expansao,
                cimento_original = @cimento_original, agua_original = @agua_original, eps_original = @eps_original,
                superplast_original = @superplast_original, incorporador_original = @incorporador_original,
                tempo_batida_original = @tempo_batida_original,
                densidade_original = @densidade_original, flow_original = @flow_original
              WHERE id_traco = @id_traco
            `).run({
              id_traco,
              num_traco: ('num_traco' in novosValores) ? novosValores.num_traco : traco.num_traco,
              densidade_eps: ('densidade_eps' in novosValores) ? novosValores.densidade_eps : traco.densidade_eps,
              silo: ('silo' in novosValores) ? novosValores.silo : traco.silo,
              expansao: ('expansao' in novosValores) ? novosValores.expansao : traco.expansao,
              cimento_original: numOuNulo(originais.cimento_real),
              agua_original: numOuNulo(originais.agua_real),
              eps_original: numOuNulo(originais.eps_real),
              superplast_original: numOuNulo(originais.superplast_real),
              incorporador_original: numOuNulo(originais.incorporador_real),
              // tempo_batida_min (formulário, minutos) -> segundos (mesma unidade de sempre em "tracos")
              tempo_batida_original: (originais.tempo_batida_min !== '' && originais.tempo_batida_min != null)
                ? Number(originais.tempo_batida_min) * 60 : null,
              densidade_original: novosValores.densidade ? numOuNulo(novosValores.densidade.original) : traco.densidade_original,
              flow_original: novosValores.flow ? numOuNulo(novosValores.flow.original) : traco.flow_original,
            });

            // Ajustes: substitui TODOS de uma vez (apaga + reinsere
            // renumerado 1..N) — mais simples e seguro que tentar calcular um
            // diff linha a linha, e o volume por traço é sempre pequeno.
            db.prepare('DELETE FROM ajustes WHERE id_traco = ?').run(id_traco);
            const inserirAjuste = db.prepare(db.SQL_INSERIR_AJUSTE);
            ajustes.forEach((a, i) => {
              inserirAjuste.run({
                id_traco, ordem: i + 1, tempo_batida: a.tempo_batida,
                cimento: numOuNulo(a.cimento), agua: numOuNulo(a.agua), eps: numOuNulo(a.eps),
                superplast: numOuNulo(a.superplast), incorporador: numOuNulo(a.incorporador),
                registrado_em: a.registrado_em || new Date().toISOString(),
              });
            });

            // Densidade/Flow: mesma ideia — substitui as leituras inteiras.
            const inserirLeitura = db.prepare(db.SQL_INSERIR_LEITURA);
            ['densidade', 'flow'].forEach(campo => {
              if (!novosValores[campo]) return;
              db.prepare('DELETE FROM leituras_resultado WHERE id_traco = ? AND campo = ?').run(id_traco, campo);
              const leituras = Array.isArray(novosValores[campo].leituras) ? novosValores[campo].leituras : [];
              leituras.forEach((valor, i) => {
                inserirLeitura.run({ id_traco, campo, valor: Number(valor), ordem: i + 1 });
              });
            });

            // Log de auditoria — append-only, mesmo padrão de edicoes_operacao.
            db.prepare(`
              INSERT INTO edicoes_traco (id_traco, id_operacao, data_edicao, campos_alterados)
              VALUES (?, ?, ?, ?)
            `).run(id_traco, id_operacao, new Date().toISOString(), JSON.stringify(diff));
          })();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── EDIÇÕES AVANÇADAS DO TRAÇO (corrige a DATA de um traço já salvo):
    // separado de /editar-traco-relatorio pelo mesmo motivo de
    // /editar-operacao-avancado estar separado de /editar-operacao — "data"
    // é um campo normalmente capturado automaticamente (dia em que o traço
    // foi registrado, ver registro-operacao.js/operacao-offline.js), não
    // uma escolha do dia a dia; corrigi-la é uma exceção administrativa
    // pontual (ex.: traço lançado no dia seguinte por engano), daí um botão
    // à parte, mais escondido, igual ao das operações.
    //
    // Atenção: "data" aqui é só o campo tracos.data (usado pra agrupar o
    // traço em relatórios/telas por dia — Relatório de Injeção, Setor de
    // Qualidade, Debriefing, exportação em PDF). Não mexe em num_traco (a
    // numeração do dia em que o traço foi de fato CONTADO, contador_tracos,
    // não é recalculada aqui) nem em nenhum dado de traco_usos/operações —
    // só a própria linha de tracos.
    if (req.method === 'POST' && urlPath === '/editar-traco-avancado') {
      // Mesma checagem aplicada a /editar-traco-relatorio — ver comentário lá.
      if (!podeEditarArea(req, 'injetora')) { negarEdicao(res, 'o histórico de operações e traços'); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const { id_traco, id_operacao, data, diff } = payload;

          if (!id_traco || typeof id_traco !== 'string') throw new Error('ID do traço ausente.');
          if (!data || typeof data !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
            throw new Error('Data inválida (formato esperado: AAAA-MM-DD).');
          }
          // Valida se é uma data de calendário real (não só o formato) —
          // ex.: "2026-02-30" bate o regex acima mas não existe.
          const [ano, mes, dia] = data.split('-').map(Number);
          const dtChecagem = new Date(Date.UTC(ano, mes - 1, dia));
          if (dtChecagem.getUTCFullYear() !== ano || dtChecagem.getUTCMonth() !== mes - 1 || dtChecagem.getUTCDate() !== dia) {
            throw new Error('Data inválida.');
          }
          if (!Array.isArray(diff) || !diff.length) throw new Error('Nenhuma alteração informada.');

          const traco = db.prepare('SELECT * FROM tracos WHERE id_traco = ?').get(id_traco);
          if (!traco) throw new Error('Traço não encontrado (id_traco: ' + id_traco + ').');

          db.transaction(() => {
            db.prepare('UPDATE tracos SET data = @data WHERE id_traco = @id_traco').run({ id_traco, data });

            // Mesmo log de auditoria de /editar-traco-relatorio.
            db.prepare(`
              INSERT INTO edicoes_traco (id_traco, id_operacao, data_edicao, campos_alterados)
              VALUES (?, ?, ?, ?)
            `).run(id_traco, id_operacao || null, new Date().toISOString(), JSON.stringify(diff));
          })();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, data }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── PAUSAS DE UMA OPERAÇÃO (Edições Avançadas): busca as pausas já
    // gravadas em pausas_operacao pra esse id, pra pré-preencher a tela ao
    // abrir "Edições avançadas" em cima de uma edição anterior. Mesma
    // trava de permissão das rotas de edição, acima — só quem pode editar
    // o histórico pode ver o motivo de cada pausa.
    if (req.method === 'GET' && urlPath.startsWith('/pausas-operacao/')) {
      if (!podeEditarArea(req, 'injetora')) { negarEdicao(res, 'os horários e pausas da operação'); return true; }
      const idOperacao = decodeURIComponent(urlPath.slice('/pausas-operacao/'.length));
      const pausas = db.prepare(
        'SELECT pausado_em, retomado_em, motivo FROM pausas_operacao WHERE id_operacao = ? ORDER BY pausado_em ASC'
      ).all(idOperacao);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pausas }));
      return true;
    }

    // ── EDIÇÕES AVANÇADAS (Registro de Bateria → Editar → "Edições
    // avançadas"): corrige início/fim de uma operação já registrada e a
    // lista de pausas que ela teve (pausado_em/retomado_em/motivo cada
    // uma) — SEPARADA de POST /editar-operacao, acima, porque
    // início/fim/tempo_min/houve_atraso são justamente os campos que
    // aquela rota PROTEGE (CAMPOS_PROTEGIDOS) por serem, no fluxo normal,
    // capturados automaticamente pelo cronômetro ao vivo, não escolhidos
    // à mão. Aqui é a exceção deliberada: uma correção administrativa
    // pontual (ex.: operador esqueceu de apertar "Iniciar" na hora certa),
    // não o fluxo do dia a dia — por isso um botão à parte, mais escondido,
    // em vez de campos soltos no formulário principal.
    //
    // tempo_min/houve_atraso são RECALCULADOS aqui, no servidor, a partir
    // de início/fim/pausas — nunca aceitos prontos do navegador (mesma
    // fórmula do cronômetro ao vivo: ver LW.LIMITE_INJECAO_MIN/
    // tempoPausadoMin, operacao.js/data.js — duplicada acima em
    // _diffMinutos/LIMITE_INJECAO_MIN, com o motivo de não dar pra
    // importar direto explicado lá).
    //
    // pausas_operacao é reescrita por completo pra este id_operacao a
    // cada salvamento (apaga tudo + reinsere) — mesmo padrão já usado em
    // /editar-traco-relatorio pros "ajustes" (acima): mais simples e
    // seguro que tentar computar um diff linha a linha, e o volume por
    // operação é sempre pequeno (poucas pausas, no máximo).
    if (req.method === 'POST' && urlPath === '/editar-operacao-avancado') {
      // Mesma checagem aplicada a /editar-operacao — ver comentário lá.
      if (!podeEditarArea(req, 'injetora')) { negarEdicao(res, 'os horários e pausas da operação'); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const { id, inicio, fim, pausas, diff } = payload;

          if (!id || typeof id !== 'string') throw new Error('ID da operação ausente.');
          if (!inicio || !fim) throw new Error('Início e fim são obrigatórios.');
          const dtInicio = new Date(inicio);
          const dtFim = new Date(fim);
          if (isNaN(dtInicio.getTime())) throw new Error('Início inválido.');
          if (isNaN(dtFim.getTime())) throw new Error('Fim inválido.');
          if (dtFim <= dtInicio) throw new Error('O fim precisa ser depois do início.');
          if (!Array.isArray(pausas)) throw new Error('Payload inválido: "pausas" precisa ser uma lista.');
          if (!Array.isArray(diff) || !diff.length) throw new Error('Nenhuma alteração informada.');

          // Cada pausa: horários válidos, retorno depois da pausa, dentro
          // da janela [início, fim] da própria operação, e justificativa
          // obrigatória (mesma exigência do registro ao vivo — ver
          // togglePausaOperacao, operacao.js).
          const pausasValidadas = pausas.map((p, i) => {
            if (!p || typeof p !== 'object') throw new Error(`Pausa #${i + 1}: inválida.`);
            const dtPausado = new Date(p.pausado_em);
            const dtRetomado = new Date(p.retomado_em);
            if (isNaN(dtPausado.getTime()) || isNaN(dtRetomado.getTime())) {
              throw new Error(`Pausa #${i + 1}: horário de início/retorno inválido.`);
            }
            if (dtRetomado <= dtPausado) throw new Error(`Pausa #${i + 1}: o retorno precisa ser depois da pausa.`);
            if (dtPausado < dtInicio || dtRetomado > dtFim) {
              throw new Error(`Pausa #${i + 1}: precisa estar dentro da janela de início/fim da operação.`);
            }
            if (!p.motivo || typeof p.motivo !== 'string' || !p.motivo.trim()) {
              throw new Error(`Pausa #${i + 1}: justificativa obrigatória.`);
            }
            return { pausado_em: dtPausado.toISOString(), retomado_em: dtRetomado.toISOString(), motivo: p.motivo.trim() };
          });

          // Pausas não podem se sobrepor entre si — ordena por início e
          // compara cada uma com a anterior.
          const pausasOrdenadas = [...pausasValidadas].sort((a, b) => new Date(a.pausado_em) - new Date(b.pausado_em));
          for (let i = 1; i < pausasOrdenadas.length; i++) {
            if (new Date(pausasOrdenadas[i].pausado_em) < new Date(pausasOrdenadas[i - 1].retomado_em)) {
              throw new Error('As pausas não podem se sobrepor.');
            }
          }

          const atual = db.prepare('SELECT * FROM operacoes WHERE id = ?').get(id);
          if (!atual) throw new Error('Operação não encontrada (id: ' + id + ').');

          const minutosBruto = _diffMinutos(dtInicio.toISOString(), dtFim.toISOString());
          const minutosPausados = pausasOrdenadas.reduce(
            (acc, p) => acc + _diffMinutos(p.pausado_em, p.retomado_em), 0
          );
          const tempoMin = minutosBruto - minutosPausados;
          const houveAtraso = tempoMin > LIMITE_INJECAO_MIN ? 'SIM' : 'NÃO';

          // "data" da operação = data do FIM (mesmo critério do registro,
          // ao vivo ou offline — ver dataLocal em registro-operacao.js/
          // operacao-offline.js): se o Master corrige o fim pra outro dia
          // (ex.: operação retomada de madrugada), a operação precisa
          // "migrar" de dia no Debriefing e em qualquer relatório por data
          // junto com essa correção — nunca fica presa à data antiga do
          // início.
          const novaData = dtFim.toISOString().split('T')[0];

          db.transaction(() => {
            db.prepare(`
              UPDATE operacoes SET data = @data, inicio = @inicio, fim = @fim, tempo_min = @tempo_min, houve_atraso = @houve_atraso
              WHERE id = @id
            `).run({
              id, data: novaData, inicio: dtInicio.toISOString(), fim: dtFim.toISOString(),
              tempo_min: tempoMin, houve_atraso: houveAtraso,
            });

            db.prepare('DELETE FROM pausas_operacao WHERE id_operacao = ?').run(id);
            const inserirPausa = db.prepare(`
              INSERT INTO pausas_operacao (id_operacao, pausado_em, retomado_em, motivo)
              VALUES (@id_operacao, @pausado_em, @retomado_em, @motivo)
            `);
            pausasOrdenadas.forEach(p => inserirPausa.run({ id_operacao: id, ...p }));

            // Mesmo log de auditoria de /editar-operacao — o "diff" que o
            // navegador manda já descreve início/fim/pausas em texto
            // legível (ver salvarEdicoesAvancadas, app-core.js), não os
            // valores calculados de tempo_min/houve_atraso (esses são
            // consequência, não uma escolha em si).
            db.prepare(`
              INSERT INTO edicoes_operacao (id_operacao, data_edicao, campos_alterados)
              VALUES (?, ?, ?)
            `).run(id, new Date().toISOString(), JSON.stringify(diff));
          })();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, tempo_min: tempoMin, houve_atraso: houveAtraso }));
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
