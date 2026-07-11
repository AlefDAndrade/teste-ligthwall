// ─── lib/rotas/edicao.js — Editar Operação / Editar Traço ──────────────────
// Décima quinta fatia extraída de server.js (ver lib/rotas/operadores.js
// pro padrão completo). Rotas cobertas: POST /editar-operacao,
// POST /editar-traco-relatorio.
//
// As duas exigem sessão de Administrador — corrigir um registro já
// finalizado é uma ação administrativa, diferente do registro original
// (que qualquer operador autorizado faz). `numOuNulo` é injetada via ctx —
// compartilhada com outros domínios ainda em server.js.

module.exports = function criarRotasEdicao({ db, sessao, numOuNulo }) {

  function semSessao(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada. Volte ao login e entre novamente como Administrador.' }));
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
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
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
              bercos_reais = @bercos_reais, tipo_montagem = @tipo_montagem, turno = @turno,
              motivo_atraso = @motivo_atraso, bercos_personalizados = @bercos_personalizados,
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
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
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

    return false;
  };
};
