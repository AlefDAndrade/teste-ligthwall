// ─── lib/rotas/operacao-offline.js — Registro de Operação Offline (PWA) ────
// Ver README, "Registro de Operação Offline (PWA) — plano", itens 5, 6 e 7.
//
// POST /operacao-offline/enviar (item 5) — recebe o payload que
// public/js/offline-operacao.js já monta e envia (`{ idTemp, formRecord,
// tracos, pausas }`, fetch com timeout de 8s, ver `registrar()` naquele
// arquivo) e só ENFILEIRA — nunca grava em "operacoes"/"tracos" direto.
// Sem sessão nem `podeControlarOperacao` — não tem como exigir login numa
// rota que existe justamente pra quando não há rede pra logar. Duas
// proteções mínimas, já que fica exposta sem autenticação nenhuma:
//   1) Rate limiting por IP (lib/rate-limit-ip.js).
//   2) Validação estrutural do payload (tipos/formato, não regra de
//      negócio — isso só é conferido na aprovação, abaixo).
//
// GET /operacao-offline/pendentes, POST /operacao-offline/corrigir,
// POST /operacao-offline/validar, POST /operacao-offline/recusar (itens 6
// e 7) — a "página do Master": listar, corrigir campos antes de aprovar
// (o relógio do dispositivo offline pode estar errado — ver README, item
// 8), aprovar (vira uma operação de verdade) ou recusar (descarta). TODAS
// exigem sessão de admin válida (master OU perfil Administrativo — mesmo
// padrão de dispositivos-autorizados.js/backup.js: `sessao: sessaoOuAdmin`
// no wiring, server.js).
//
// ── POR QUE "VALIDAR" NÃO CHAMA POST /registrar-operacao POR HTTP ────────
// O pipeline de aprovação PRECISA acabar gravando exatamente o que
// /registrar-operacao + /registrar-relatorio-injecao + /confirmar-tracos-
// hoje gravariam — mas fazer isso via loopback HTTP (fetch de dentro do
// próprio processo pra si mesmo) traria de volta `podeControlarOperacao`,
// que exige o DEVICE também estar na lista de autorizados
// (dispositivo-autorizado.js, "sem exceção pra nenhum perfil") — uma
// checagem que não faz sentido aqui: quem está aprovando já provou quem é
// (sessão de admin), e o dispositivo ORIGINAL (o que registrou offline)
// nunca teve chance de ser autorizado (é exatamente o cenário sem rede
// que motivou esta funcionalidade inteira). Por isso a aprovação chama
// DIRETO as mesmas funções de baixo nível que aquelas rotas chamam por
// baixo dos panos (db.SQL_INSERIR_OPERACAO/db.operacaoParaRow/
// db.criarBercosVisuaisIniciais/db.SQL_INSERIR_TRACO, mesma transformação
// de traços que LW.registrarRelatorioInjecao faz no navegador, ver
// public/js/data.js) — resultado idêntico, sem duplicar a checagem de
// device numa situação em que ela não se aplica.
//
// ── POR QUE NÃO TOCA NO SNAPSHOT AO VIVO DE BERÇOS (bercos-andamento) ────
// O registro ao vivo (/registrar-operacao) lê o snapshot de marcações
// feitas EM TEMPO REAL (baixou/vazou, via WebSocket) durante ESSA MESMA
// operação, e reseta o snapshot logo depois (a operação virou histórico,
// não faz mais sentido continuar acumulando pra ela). Uma aprovação
// offline pode acontecer minutos, horas ou dias depois, com a fábrica no
// meio de uma operação AO VIVO completamente diferente — ler ou (pior)
// resetar o snapshot aqui vazaria/apagaria marcações de uma operação que
// não tem nada a ver com esta aprovação. Por isso os berços visuais desta
// operação sempre nascem no estado padrão ('okay'), sem tentar reconciliar
// com nada que esteja acontecendo ao vivo agora.

module.exports = function criarRotasOperacaoOffline({
  adicionarNaFilaOffline, buscarPorIdTemp, atualizarNaFilaOffline, removerDaFilaOffline, lerFilaOffline,
  rateLimitOffline, logger, sessao, db,
  adicionarNaFilaNaoAvaliadas, incrementarContadorTracosHoje,
}) {

  function _erro(res, status, mensagem) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: mensagem }));
  }

  function _semSessao(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
  }

  // Validação estrutural mínima — só o suficiente pra garantir que o que
  // for gravado na fila tem o formato que a tela do Master e o pipeline de
  // aprovação vão esperar encontrar depois. Não valida REGRA de negócio
  // (bateria cadastrada existe, traços dentro da faixa de berços, etc.) —
  // isso é papel do pipeline de aprovação, não desta rota.
  function _validarPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return 'payload ausente ou em formato inválido';
    }
    const { idTemp, formRecord, tracos, pausas } = payload;

    if (typeof idTemp !== 'string' || !idTemp.startsWith('OFF-') || idTemp.length < 5 || idTemp.length > 100) {
      return 'idTemp ausente ou em formato inválido (esperado "OFF-<uuid>")';
    }
    if (!formRecord || typeof formRecord !== 'object' || Array.isArray(formRecord)) {
      return 'formRecord ausente ou em formato inválido';
    }
    if (!Array.isArray(tracos)) {
      return 'tracos ausente ou não é uma lista';
    }
    if (pausas !== undefined && !Array.isArray(pausas)) {
      return 'pausas, quando enviado, precisa ser uma lista';
    }
    return null; // válido
  }

  // Checagem mínima ANTES de aprovar (item 6/7) — não é a validação
  // completa que o formulário ao vivo faz (updatePendencias(),
  // offline-operacao.js), só o suficiente pra não gravar uma operação
  // claramente incompleta em `operacoes`. Devolve string do problema, ou
  // null se pode seguir.
  function _validarAntesDeAprovar(formRecord) {
    if (!formRecord.id_bateria) return 'ID da bateria ausente — corrija antes de validar.';
    if (!formRecord.inicio || !formRecord.fim) return 'Início/Fim da injeção ausente — corrija antes de validar.';
    if (!formRecord.capacidade || Number(formRecord.capacidade) <= 0) return 'Capacidade da bateria ausente/inválida — corrija antes de validar.';
    return null;
  }

  // Mesma transformação de LW.registrarRelatorioInjecao (public/js/data.js)
  // — ver comentário grande no topo do arquivo sobre por quê ela é
  // replicada aqui em vez de reaproveitada via HTTP. `resumo` é um recorte
  // pequeno da operação (id, id_bateria, data, turno) — não a operação
  // inteira, mesma assinatura enxuta que a função original recebia.
  function _tracosParaLinhasRelatorio(resumo, tracos) {
    return (tracos || []).map(t => ({
      id_traco: t.id || (resumo.id + '_t' + t.num),
      ultilizado: {
        operacao: [{
          id_operacao: resumo.id,
          id_bateria: resumo.id_bateria,
          berco_inicio: t.berco_ini || '',
          berco_finalizacao: t.berco_fim || '',
          obs: t.obs || '',
        }],
      },
      data: resumo.data,
      turno: resumo.turno,
      num_traco: t.num,
      cimento_real: t.cimento_real || '',
      agua_real: t.agua_real || '',
      eps_real: t.eps_real || '',
      superplast_real: t.superplast_real || '',
      incorporador_real: t.incorporador_real || '',
      tempo_batida: t.tempo_batida || '',
      densidade: t.densidade_insumo || '',
      flow: t.flow_insumo || '',
      obs: t.obs || '',
      silo: t.silo || '',
      expansao: t.expansao || '',
      densidade_eps: t.densidadeEPS || '',
    }));
  }

  // Grava os traços (mesma lógica de POST /registrar-relatorio-injecao,
  // lib/rotas/registro-operacao.js, caminho SQL — replicada aqui pelo
  // mesmo motivo do comentário grande no topo do arquivo: não dá pra
  // reaproveitar por loopback HTTP sem reintroduzir a checagem de device).
  function _gravarTracos(linhasTracos) {
    if (!linhasTracos.length) return;
    const inserirTraco = db.prepare(db.SQL_INSERIR_TRACO);
    const inserirUso = db.prepare(db.SQL_INSERIR_USO);
    const inserirLeitura = db.prepare(db.SQL_INSERIR_LEITURA);

    db.transaction(() => {
      linhasTracos.forEach(novoTraco => {
        const tracoExiste = db.prepare('SELECT 1 FROM tracos WHERE id_traco = ?').get(novoTraco.id_traco);

        if (!tracoExiste) {
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

          ['densidade', 'flow'].forEach(campo => {
            db.extrairAjustesNumericos(novoTraco[campo]).forEach((valor, i) => {
              inserirLeitura.run({ id_traco: novoTraco.id_traco, campo, valor, ordem: i + 1 });
            });
          });
        }

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
  }

  // ─── O CORAÇÃO DO ITEM 6/7: aprova 1 item pendente ───────────────────────
  // Grava a operação de verdade (com origem_offline=1, validado_por,
  // validado_em — auditoria, ver db.js), os traços (mesma transformação de
  // LW.registrarRelatorioInjecao) e incrementa o Contador de Traços do Dia
  // (item 7 — com a quantidade JÁ REVISADA pelo Master, se ele corrigiu
  // via POST /operacao-offline/corrigir antes de validar) — nessa ordem,
  // espelhando o pipeline de uma operação ao vivo (registrar-operacao →
  // registrar-relatorio-injecao → confirmar-tracos-hoje), só que direto
  // contra o banco (ver comentário grande no topo do arquivo). Não está
  // dentro de 1 única transação SQL cobrindo os 3 passos de propósito: o
  // contador de traços mora num arquivo/tabela à parte
  // (lerContadorTracosHoje/incrementarContadorTracosHoje), fora do escopo
  // de uma transação do banco de operações — mesma limitação que o
  // pipeline ao vivo já tem (3 chamadas HTTP separadas, não atômicas).
  function _aprovar(item, validadoPor) {
    const idOperacao = 'op_off_' + item.idTemp.slice(4); // sem o prefixo "OFF-" — determinístico, rastreável até a origem
    const formRecord = item.formRecord;
    const dataLocal = (formRecord.inicio || '').split('T')[0] || new Date().toISOString().split('T')[0];

    const record = {
      ...formRecord,
      id: idOperacao,
      data: dataLocal,
      avaliado: false, // nunca confia em nada vindo do cliente pra este campo — mesma regra do registro ao vivo
      origem_offline: true,
      validado_por: validadoPor,
      validado_em: new Date().toISOString(),
      // Simplificado — só os ids (mesmo formato de historico.json/coluna tracos_json, ver operacaoParaRow)
      tracos: (item.tracos || []).map(t => ({ id: t.id })),
    };

    db.prepare(db.SQL_INSERIR_OPERACAO).run({
      ...db.operacaoParaRow(record),
      modo_teste: 0,
      criado_em: new Date().toISOString(),
    });

    // Berços Visuais — sempre 'okay' (nunca lê/reseta o snapshot ao vivo,
    // ver comentário grande no topo do arquivo).
    const qtdBercos = parseInt(record.capacidade) || 0;
    db.criarBercosVisuaisIniciais(record.id, qtdBercos, {});

    // Entra na fila de avaliação do Setor de Qualidade — igual a qualquer
    // outra operação nova.
    adicionarNaFilaNaoAvaliadas(record.id);

    // Traços — mesma transformação de LW.registrarRelatorioInjecao (data.js)
    const linhasTracos = _tracosParaLinhasRelatorio(
      { id: idOperacao, id_bateria: record.id_bateria, data: dataLocal, turno: record.turno },
      item.tracos,
    );
    _gravarTracos(linhasTracos);

    // Contador de Traços do Dia (item 7) — todo traço enviado offline é
    // NOVO (o conceito de "reaproveitar sobra de outra operação" depende
    // de consultar o servidor em tempo real pra saber o que sobrou, o que
    // não existe no fluxo offline — ver README, item 8, "Coisas a
    // decidir"), então soma sempre o total de traços da operação.
    const qtdTracosNovos = (item.tracos || []).length;
    if (qtdTracosNovos > 0) incrementarContadorTracosHoje(qtdTracosNovos, false);

    return record;
  }

  return function tentar(req, res, urlPath /* , queryParams */) {

    // ── POST /operacao-offline/enviar (item 5) ──────────────────────────
    if (req.method === 'POST' && urlPath === '/operacao-offline/enviar') {
      if (rateLimitOffline.estaBloqueado(req)) {
        const segundos = rateLimitOffline.segundosRestantes(req);
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(segundos) });
        res.end(JSON.stringify({ ok: false, erro: 'Muitas tentativas — tente novamente mais tarde.', segundosRestantes: segundos }));
        return true;
      }

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        // Conta como um envio pro rate limit assim que o corpo chega,
        // independente do resultado da validação abaixo (o limite é sobre
        // VOLUME de chamadas à rota, não só sobre payload malformado).
        rateLimitOffline.registrarEnvio(req);

        let payload;
        try {
          payload = JSON.parse(body);
        } catch (_) {
          _erro(res, 400, 'JSON malformado no corpo da requisição');
          return;
        }

        const problema = _validarPayload(payload);
        if (problema) {
          _erro(res, 400, problema);
          return;
        }

        try {
          const ip = (req.socket.remoteAddress || 'desconhecido').replace(/^::ffff:/, '');
          const { novo } = adicionarNaFilaOffline({
            idTemp: payload.idTemp,
            formRecord: payload.formRecord,
            tracos: payload.tracos,
            pausas: payload.pausas || [],
            recebidoEm: new Date().toISOString(),
            ip,
          });

          if (novo) {
            logger.info('operacao-offline', 'registro offline recebido e enfileirado para validação', { idTemp: payload.idTemp, ip });
          } // reenvio idempotente do mesmo idTemp — sem log novo, não é um evento novo

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, idTemp: payload.idTemp }));
        } catch (e) {
          logger.error('operacao-offline', 'falha ao gravar registro offline na fila', { erro: e.message });
          _erro(res, 500, 'Falha ao gravar o registro — tente novamente.');
        }
      });
      return true;
    }

    // ── GET /operacao-offline/pendentes (item 6) — lista completa pra
    // Configurações → Operações a Validar. Admin only. ───────────────────
    if (req.method === 'GET' && urlPath === '/operacao-offline/pendentes') {
      if (!sessao.requestTemSessaoValida(req)) { _semSessao(res); return true; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, lista: lerFilaOffline() }));
      return true;
    }

    // ── POST /operacao-offline/corrigir  { idTemp, formRecord?, tracos?, pausas? }
    // "Corrigir antes de aprovar" (item 6) — PATCH em cima do item
    // pendente (ver lib/fila-offline.js, atualizarNaFilaOffline). Admin only.
    if (req.method === 'POST' && urlPath === '/operacao-offline/corrigir') {
      if (!sessao.requestTemSessaoValida(req)) { _semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const { idTemp } = payload;
          if (typeof idTemp !== 'string' || !idTemp) throw new Error('idTemp é obrigatório.');
          if (payload.formRecord !== undefined && (typeof payload.formRecord !== 'object' || Array.isArray(payload.formRecord))) {
            throw new Error('formRecord, quando enviado, precisa ser um objeto.');
          }
          if (payload.tracos !== undefined && !Array.isArray(payload.tracos)) throw new Error('tracos, quando enviado, precisa ser uma lista.');
          if (payload.pausas !== undefined && !Array.isArray(payload.pausas)) throw new Error('pausas, quando enviado, precisa ser uma lista.');

          const atualizado = atualizarNaFilaOffline(idTemp, {
            formRecord: payload.formRecord, tracos: payload.tracos, pausas: payload.pausas,
          }, 'Administrador'); // ver nomeParaVisualizacao (lib/permissoes-area.js) — mesmo raciocínio: não expõe QUAL admin, só que foi um admin
          if (!atualizado) throw new Error('Registro pendente não encontrado (idTemp: ' + idTemp + ').');

          logger.info('operacao-offline', 'registro pendente corrigido antes da validação', { idTemp });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, item: atualizado }));
        } catch (e) {
          _erro(res, 400, e.message);
        }
      });
      return true;
    }

    // ── POST /operacao-offline/validar  { idTemp } — vira uma operação de
    // verdade (item 6/7). Admin only. ────────────────────────────────────
    if (req.method === 'POST' && urlPath === '/operacao-offline/validar') {
      if (!sessao.requestTemSessaoValida(req)) { _semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { idTemp } = JSON.parse(body);
          if (typeof idTemp !== 'string' || !idTemp) throw new Error('idTemp é obrigatório.');

          const item = buscarPorIdTemp(idTemp);
          if (!item) throw new Error('Registro pendente não encontrado (idTemp: ' + idTemp + ').');

          const problema = _validarAntesDeAprovar(item.formRecord);
          if (problema) throw new Error(problema);

          const jaExiste = db.prepare('SELECT 1 FROM operacoes WHERE id = ?').get('op_off_' + idTemp.slice(4));
          if (jaExiste) {
            // Já foi aprovado antes (ex.: 2 cliques rápidos no botão
            // Validar) — trata como sucesso idempotente, só limpa a fila
            // se ainda estiver lá, sem tentar inserir de novo (violaria a
            // PRIMARY KEY de "operacoes").
            removerDaFilaOffline(idTemp);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, idOperacao: 'op_off_' + idTemp.slice(4), jaEstavaValidado: true }));
            return;
          }

          const record = _aprovar(item, 'Administrador'); // ver nomeParaVisualizacao, mesmo raciocínio de /corrigir acima
          removerDaFilaOffline(idTemp);

          logger.info('operacao-offline', 'registro offline validado e virou operação', { idTemp, idOperacao: record.id });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, idOperacao: record.id }));
        } catch (e) {
          logger.error('operacao-offline', 'falha ao validar registro offline', { erro: e.message });
          _erro(res, 400, e.message);
        }
      });
      return true;
    }

    // ── POST /operacao-offline/recusar  { idTemp, motivo? } — descarta sem
    // nunca virar operação. Admin only. ──────────────────────────────────
    if (req.method === 'POST' && urlPath === '/operacao-offline/recusar') {
      if (!sessao.requestTemSessaoValida(req)) { _semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { idTemp } = JSON.parse(body);
          if (typeof idTemp !== 'string' || !idTemp) throw new Error('idTemp é obrigatório.');
          const removeu = removerDaFilaOffline(idTemp);
          if (!removeu) throw new Error('Registro pendente não encontrado (idTemp: ' + idTemp + ').');

          logger.info('operacao-offline', 'registro offline recusado', { idTemp });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          _erro(res, 400, e.message);
        }
      });
      return true;
    }

    return false;
  };
};
