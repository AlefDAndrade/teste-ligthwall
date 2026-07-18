// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  analise-focada.js — Análise Focada de uma Operação (Rastreabilidade)
// ============================================================
// Acessada de duas formas:
//   1) Clicando numa linha do Registro de Baterias com o "modo de foco"
//      ligado (ver LWDash.toggleModoFocoRegistro/onClickLinhaRegistro,
//      dashboard.js) — chega já com uma operação escolhida.
//   2) Pelo item "Rastreabilidade" da sidebar — chega sem operação
//      nenhuma, com uma busca por ID de Bateria/Operação/Traço (ver
//      abrirBusca/buscar, abaixo).
// Junta tudo que se liga por id_operacao — o elo comum entre histórico,
// relatório de injeção e berços visuais — numa página só: identificação
// da operação, o desenho da bateria (berços visuais), a receita usada
// (com ajustes, se algum), de ONDE cada traço veio e se sobrou pra ser
// reaproveitado depois (ver _anotarOrigemEReaproveitamento, abaixo — usa
// db.detalheOperacao() pro grosso dos dados, mas a cadeia de
// reaproveitamento não está lá: é resolvida aqui, cruzando com
// relatorio_injecao.json, mesma técnica já usada em debriefing.js), as
// paradas que caíram dentro da janela dela, e a avaliação de qualidade
// vinculada.
'use strict';

(function () {
  let _idAtual = null;

  // ── Cache dos dados usados pela BUSCA e pela cadeia de reaproveitamento
  // — carregados uma vez só (lazy, na 1ª busca ou no 1º render de uma
  // operação) e reaproveitados nas chamadas seguintes dentro da mesma
  // sessão de página. Não há invalidação automática de propósito: é
  // dado histórico que não muda com o tempo que alguém passa olhando
  // esta tela, e um F5 já recarrega tudo do zero se precisar.
  let _cacheHistorico = null;   // db/historico.json — pra achar por ID de Bateria/Operação e resolver nomes na cadeia
  let _cacheTracos = null;      // db/relatorio_injecao.json — pra achar por ID de Traço e resolver a cadeia de reaproveitamento
  let _cacheParadas = null;     // db/paradas.json

  async function _carregarCaches() {
    const precisa = !_cacheHistorico || !_cacheTracos || !_cacheParadas;
    if (!precisa) return;
    const [historico, tracos, paradas] = await Promise.all([
      fetch('db/historico.json').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('db/relatorio_injecao.json').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('db/paradas.json').then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    _cacheHistorico = Array.isArray(historico) ? historico : [];
    _cacheTracos = Array.isArray(tracos) ? tracos : [];
    _cacheParadas = Array.isArray(paradas) ? paradas : [];
  }

  // ── Abre a página focada numa operação específica — chamado de fora
  // (dashboard.js) quando o usuário clica numa linha com o modo de foco
  // ligado. showPage() é global (app-core.js). ──
  function abrir(idOperacao) {
    _idAtual = idOperacao;
    showPage('analise-focada');
  }

  // ── Entrada pela sidebar ("Rastreabilidade") — sem operação
  // pré-escolhida: limpa a seleção atual pra render() mostrar a busca em
  // vez de reabrir a última operação vista. Chamado ANTES de showPage()
  // no onclick do nav-item (ver nav-sidebar.html) — showPage() já chama
  // LWFocada.init()/render() em seguida, então só precisa zerar aqui.
  function abrirBusca() {
    _idAtual = null;
  }

  function voltar() {
    showPage('registro');
  }

  // ============================================================
  //  BUSCA — ID de Bateria, Operação ou Traço
  // ============================================================

  // Acha operações candidatas pra uma query de texto — 3 formas de bater,
  // checadas nesta ordem (a mais específica primeiro, pra não ambiguar
  // um ID de operação/traço com um pedaço solto de texto):
  //   1) ID de Operação exato — sempre 1 resultado só.
  //   2) ID de Traço (id_traco OU num_traco) — resolve pra a operação
  //      ONDE ELE FOI USADO PELA PRIMEIRA VEZ (usos[0] — ver
  //      _anotarOrigemEReaproveitamento, mais abaixo, pro raciocínio
  //      completo da cadeia); se o traço foi reaproveitado depois, dá
  //      pra navegar pras operações seguintes a partir de lá.
  //   3) ID de Bateria (parcial, sem diferenciar maiúsc./minúsc.) — pode
  //      bater em VÁRIAS operações (a mesma bateria física roda muitas
  //      vezes ao longo do tempo) — mais recente primeiro.
  function _buscarCandidatos(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const qLower = q.toLocaleLowerCase();

    const porId = _cacheHistorico.find(op => op.id === q);
    if (porId) return [porId];

    const tracoAchado = _cacheTracos.find(t => t.id_traco === q || String(t.num_traco) === q);
    if (tracoAchado) {
      const usos = tracoAchado.ultilizado?.operacao || [];
      if (usos.length) {
        const opOrigem = _cacheHistorico.find(op => op.id === usos[0].id_operacao);
        if (opOrigem) return [opOrigem];
      }
    }

    return _cacheHistorico
      .filter(op => (op.id_bateria || '').toLocaleLowerCase().includes(qLower))
      .sort((a, b) => (b.data + (b.fim || '')).localeCompare(a.data + (a.fim || '')))
      .slice(0, 15);
  }

  // Entrada pública (botão "Buscar"/Enter no campo, ver
  // page-analise-focada.html). 1 resultado → abre direto; vários → lista
  // pra escolher; nenhum → avisa.
  async function buscar(query) {
    const q = String(query || '').trim();
    const resultadosEl = document.getElementById('af-busca-resultados');
    if (!q) { if (resultadosEl) resultadosEl.style.display = 'none'; return; }

    if (resultadosEl) {
      resultadosEl.style.display = '';
      resultadosEl.innerHTML = `<div style="color:var(--text-3);font-size:.85rem">Buscando…</div>`;
    }

    await _carregarCaches();
    const candidatos = _buscarCandidatos(q);

    if (candidatos.length === 1) {
      if (resultadosEl) resultadosEl.style.display = 'none';
      abrir(candidatos[0].id);
      return;
    }
    if (!candidatos.length) {
      if (resultadosEl) {
        resultadosEl.innerHTML = `<div style="color:var(--text-3);font-size:.85rem">Nenhuma operação encontrada pra "${LW.escaparHtml(q)}".</div>`;
      }
      return;
    }
    _renderResultadosBusca(candidatos);
  }

  function _renderResultadosBusca(candidatos) {
    const el = document.getElementById('af-busca-resultados');
    if (!el) return;
    el.innerHTML = `
      <div style="font-size:.8rem;color:var(--text-2);margin-bottom:6px">${candidatos.length} operações encontradas — escolha uma:</div>
      <div style="display:flex;flex-direction:column;gap:4px;max-height:260px;overflow-y:auto">
        ${candidatos.map(op => `
          <button class="btn btn-ghost btn-sm" style="justify-content:flex-start;text-align:left"
            onclick="LWFocada.abrir('${op.id}')">
            <strong style="margin-right:8px">${LW.escaparHtml(op.id_bateria || '—')}</strong>
            <span style="color:var(--text-3)">${_fmtData(op.data)} · ${LW.escaparHtml(op.turno || '—')} · ${LW.escaparHtml(op.tipo_montagem || '—')}</span>
          </button>
        `).join('')}
      </div>
    `;
  }

  // ── Formatação ────────────────────────────────────────────
  function _fmtData(iso) {
    if (!iso) return '—';
    return iso.split('-').reverse().join('/');
  }
  function _fmtHora(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    // timeZone:'UTC' de propósito — op.inicio/op.fim (de uma Operação, ver
    // Registrar Operação) são gravados via nowBrasilia().toISOString()
    // (data.js), que guarda o valor UTC do Date já AJUSTADO pra
    // representar o horário de Brasília (ver comentário de nowBrasilia())
    // — não é um instante UTC de verdade. Sem timeZone:'UTC' aqui, o
    // navegador aplicava a conversão de fuso REAL em cima desse valor já
    // ajustado, deslocando o horário mostrado (bug real relatado pelo
    // usuário: bateria feita às 14h aparecia como feita às 11h — exatos
    // os 3h do fuso de Brasília, um deslocamento em dobro). Mesma
    // correção já aplicada em dashboard.js ("Hora Início"/"Hora Fim") e
    // em qualquer outro lugar que formate esses mesmos campos.
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  }
  // tempo_batida ORIGINAL do traço é gravado em SEGUNDOS (ver CREATE
  // TABLE tracos, db.js) — os ajustes ("Tempo de Batida Adicionado" em
  // Registrar Operação) são em MINUTOS. Unidades diferentes de
  // propósito no schema original — só formato cada um do jeito certo,
  // não tento converter um pro outro.
  function _fmtTempoBatidaOriginal(segundos) {
    if (segundos === null || segundos === undefined || segundos === '') return '—';
    const s = Math.round(Number(segundos));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s` : `${m}m${String(sec).padStart(2, '0')}s`;
  }
  function _fmtKg(v, casas = 2) {
    return (v === null || v === undefined || v === '') ? null : Number(v).toFixed(casas);
  }

  // ── Cabeçalho: identificação da operação ─────────────────────
  function _renderCabecalho(op) {
    const el = document.getElementById('af-cabecalho');
    if (!el) return;
    const atrasoHtml = op.houve_atraso === 'SIM'
      ? `<span style="color:var(--red)">⚠ Sim${op.motivo_atraso ? ' — ' + LW.escaparHtml(op.motivo_atraso) : ''}</span>`
      : 'Não';
    el.innerHTML = `
      <div class="af-campo"><div class="af-label">ID da Operação</div><div class="af-valor mono">${LW.escaparHtml(op.id)}</div></div>
      <div class="af-campo"><div class="af-label">Tipo de Bateria</div><div class="af-valor">${LW.escaparHtml(op.id_bateria || '—')}</div></div>
      <div class="af-campo"><div class="af-label">Tipo de Montagem</div><div class="af-valor">${LW.escaparHtml(op.tipo_montagem || '—')}</div></div>
      <div class="af-campo"><div class="af-label">Data da Operação</div><div class="af-valor">${_fmtData(op.data)}</div></div>
      <div class="af-campo"><div class="af-label">Início — Fim</div><div class="af-valor mono">${_fmtHora(op.inicio)} — ${_fmtHora(op.fim)}</div></div>
      <div class="af-campo"><div class="af-label">Turno</div><div class="af-valor">${LW.escaparHtml(op.turno || '—')}</div></div>
      <div class="af-campo"><div class="af-label">Dimensão</div><div class="af-valor">${LW.escaparHtml(op.dimensao || '—')}</div></div>
      <div class="af-campo"><div class="af-label">Berços Reais</div><div class="af-valor">${op.bercos_reais ?? '—'}</div></div>
      <div class="af-campo"><div class="af-label">Atraso</div><div class="af-valor">${atrasoHtml}</div></div>
    `;
  }

  // Cor por tipo de montagem de UM berço — mesma regra de bateria-atual.js
  // (_baCorPorTipo): Montagem Personalizada guarda o CÓDIGO do tipo por
  // berço (resolvido por corPorTipoSimples); qualquer outro tipo (simples
  // ou híbrido) é uniforme — todo berço usa o mesmo LABEL da operação
  // (resolvido por corMontagemPorLabel, que também monta o gradiente 50/50
  // de tipos híbridos).
  function _corPorTipoBerco(ehPersonalizada, tipo) {
    if (!tipo) return null;
    return ehPersonalizada ? LW.corPorTipoSimples(tipo) : LW.corMontagemPorLabel(tipo);
  }

  // ── Desenho da bateria (berços visuais) ──────────────────────
  // Mesma grade visual usada no popover de hover do Relatório de Berços
  // e no card "Bateria Atual" (.ba-grid/.ba-celula/.ba-dot, ver
  // css/styles.css) — aqui só leitura, sem clique nenhum.
  function _renderBercos(bercosVisuais, op) {
    const el = document.getElementById('af-bercos');
    if (!el) return;
    if (!bercosVisuais || !bercosVisuais.length) {
      el.innerHTML = `<div class="sq-empty-af"><i class="fas fa-inbox"></i> Berços visuais ainda não registrados para esta operação.</div>`;
      return;
    }
    const ordenados = bercosVisuais.slice().sort((a, b) => a.ordem - b.ordem);

    const ehPersonalizada = !!op && op.tipo_montagem === LW.TIPO_MONTAGEM_PERSONALIZADA;
    // O endpoint de detalhe da operação devolve a linha crua da tabela —
    // bercos_personalizados chega como STRING JSON, não como array (ao
    // contrário de outras telas, que já usam a linha pré-formatada com o
    // JSON.parse feito). Precisa normalizar aqui antes de indexar por berço.
    let gradePersonalizada = [];
    if (ehPersonalizada && op.bercos_personalizados) {
      gradePersonalizada = typeof op.bercos_personalizados === 'string'
        ? (() => { try { return JSON.parse(op.bercos_personalizados); } catch (_) { return []; } })()
        : op.bercos_personalizados;
    }

    el.innerHTML = `<div class="ba-grid">${ordenados.map(b => {
      // "✕" (não enchido) é um estado À PARTE de "baixou" (vazamento) —
      // mesma distinção de bateria-atual.js: o painel nunca existiu pra
      // avaliar, diferente de um vazamento observado. Sem checar os dois
      // estados, um lado marcado como não enchido aparecia como se
      // estivesse tudo normal (bug relatado).
      const dirNaoEnchido = b.estado_direita === 'nao_enchido';
      const esqNaoEnchido = b.estado_esquerda === 'nao_enchido';
      const dirMarcado = b.estado_direita === 'baixou' || dirNaoEnchido;
      const esqMarcado = b.estado_esquerda === 'baixou' || esqNaoEnchido;
      const numero = String(b.ordem).padStart(2, '0');
      const tipoBerco = ehPersonalizada ? (gradePersonalizada[b.ordem - 1] || null) : (op ? op.tipo_montagem : null);
      const cor = _corPorTipoBerco(ehPersonalizada, tipoBerco);
      return `
        <div class="ba-celula" style="background:${cor ? cor.bg : 'var(--bg-2)'};color:${cor ? cor.cor : 'var(--text-2)'};border:1px solid ${cor ? cor.borda : 'var(--border)'}">
          <span class="ba-dot ba-dot-topo${dirMarcado ? ' ba-dot-marcado' : ''}${dirNaoEnchido ? ' ba-dot-nao-enchido' : ''}" title="${dirNaoEnchido ? 'Direito — Não enchido' : 'Direito'}">${dirNaoEnchido ? '✕' : '•'}</span>
          <span class="ba-numero">B${numero}</span>
          <span class="ba-dot ba-dot-base${esqMarcado ? ' ba-dot-marcado' : ''}${esqNaoEnchido ? ' ba-dot-nao-enchido' : ''}" title="${esqNaoEnchido ? 'Esquerdo — Não enchido' : 'Esquerdo'}">${esqNaoEnchido ? '✕' : '•'}</span>
        </div>`;
    }).join('')}</div>`;
  }

  // ── Cadeia de reaproveitamento de cada traço ──────────────────
  // Mesma técnica de detecção de debriefing.js (usoIdx > 0 = reaproveitado
  // — ver _reaproveitado/origem_bateria/origem_operacao lá), só que olhando
  // pras DUAS direções: de onde este traço veio (se não foi a 1ª vez que
  // foi usado) E pra onde ele foi depois (se a sobra dele foi reaproveitada
  // em uma ou mais operações futuras). t.ultilizado.operacao é a lista
  // completa de usos de um traço, na ordem em que aconteceram — ver
  // rowParaTraco()/todosOsTracos() (db.js).
  //
  // Anota cada traço de `tracosDetalhe` (o array vindo de
  // db.detalheOperacao(), já escopado a ESTA operação) com `_origem` e
  // `_reaproveitadoDepois`, resolvidos a partir de _cacheTracos/
  // _cacheHistorico (ver _carregarCaches) — sem alterar nenhum campo que
  // já existia.
  function _anotarOrigemEReaproveitamento(tracosDetalhe, idOperacaoAtual) {
    const mapaOperacoes = new Map(_cacheHistorico.map(op => [op.id, op]));

    tracosDetalhe.forEach(t => {
      t._origem = null;
      t._reaproveitadoDepois = [];

      const tracoCompleto = _cacheTracos.find(tc => tc.id_traco === t.id_traco);
      const usos = tracoCompleto?.ultilizado?.operacao || [];
      if (usos.length < 2) return; // nunca reaproveitado — nada a anotar

      const idxAtual = usos.findIndex(u => u.id_operacao === idOperacaoAtual);
      if (idxAtual === -1) return; // não deveria acontecer, mas não quebra a tela se acontecer

      if (idxAtual > 0) {
        t._origem = mapaOperacoes.get(usos[0].id_operacao) || null;
      }
      if (idxAtual < usos.length - 1) {
        t._reaproveitadoDepois = usos.slice(idxAtual + 1)
          .map(u => mapaOperacoes.get(u.id_operacao))
          .filter(Boolean);
      }
    });
  }

  // Um badge levando pra outra operação — clicável na tela ao vivo
  // (chama LWFocada.abrir, definida neste mesmo módulo); no HTML
  // exportado standalone (ver _gerarHtmlAfStandalone, mais abaixo), esta
  // mesma função é reembutida via toString() num documento que NÃO tem
  // LWFocada (é um retrato estático, sem navegação) — por isso checa a
  // existência antes de gerar o onclick, e cai pra um badge só de texto
  // nesse caso, em vez de deixar um botão morto no arquivo exportado.
  // IDs de operação são gerados pelo próprio sistema ('op_' + timestamp
  // — ver operacao.js), nunca texto digitado por usuário, então entram
  // direto no onclick sem precisar escapar (mesmo padrão já usado em
  // setor-qualidade.js/dashboard.js pra este mesmo tipo de ID).
  function _badgeOperacao(op) {
    const rotulo = `${LW.escaparHtml(op.id_bateria || op.id)} · ${_fmtData(op.data)}`;
    if (typeof LWFocada === 'undefined') {
      return `<span class="af-pallet-tipo" style="padding:2px 10px">${rotulo}</span>`;
    }
    return `<button class="btn btn-ghost btn-sm" style="padding:2px 10px;font-size:.78rem"
      onclick="LWFocada.abrir('${op.id}')">${rotulo}</button>`;
  }

  // ── Receita utilizada (traços + ajustes) ─────────────────────
  function _renderReceita(tracos) {
    const el = document.getElementById('af-receita');
    if (!el) return;
    if (!tracos || !tracos.length) {
      el.innerHTML = `<div class="sq-empty-af"><i class="fas fa-inbox"></i> Nenhum traço vinculado a esta operação.</div>`;
      return;
    }
    el.innerHTML = tracos.map(t => {
      const semAjuste = !t.ajustes.length;
      const camposReceita = [
        ['Cimento', _fmtKg(t.original.cimento), 'kg'],
        ['Água', _fmtKg(t.original.agua), 'kg'],
        ['EPS', _fmtKg(t.original.eps), 'kg'],
        ['Superplast.', _fmtKg(t.original.superplast), 'kg'],
        ['Incorp. de Ar', _fmtKg(t.original.incorporador), 'kg'],
        ['Tempo de Batida', _fmtTempoBatidaOriginal(t.original.tempo_batida), ''],
        ['Densidade', t.densidade ?? null, 'kg/m³'],
        ['Flow', t.flow ?? null, ''],
      ];
      const receitaHtml = camposReceita.map(([label, valor, unidade]) =>
        `<div>${label}: <strong>${valor === null || valor === undefined ? '—' : valor + (unidade ? ' ' + unidade : '')}</strong></div>`
      ).join('');

      const ajustesHtml = semAjuste
        ? `<div class="af-sem-ajuste">Receita sem ajuste.</div>`
        : `<div class="af-ajustes-wrap">
             <div class="af-ajustes-titulo">${t.ajustes.length} ajuste${t.ajustes.length > 1 ? 's' : ''} de receita</div>
             ${t.ajustes.map(a => `
               <div class="af-ajuste-linha">
                 <strong>Ajuste ${a.ordem}</strong>
                 <span>⏱ +${a.tempo_batida}min</span>
                 ${a.cimento ? `<span>Cimento +${_fmtKg(a.cimento)}kg</span>` : ''}
                 ${a.agua ? `<span>Água +${_fmtKg(a.agua)}kg</span>` : ''}
                 ${a.eps ? `<span>EPS +${_fmtKg(a.eps)}kg</span>` : ''}
                 ${a.superplast ? `<span>Superplast. +${_fmtKg(a.superplast)}kg</span>` : ''}
                 ${a.incorporador ? `<span>Incorp. +${_fmtKg(a.incorporador)}kg</span>` : ''}
               </div>`).join('')}
           </div>`;

      const origemHtml = t._origem
        ? `<div class="af-traco-origem-linha">🔗 Origem: ${_badgeOperacao(t._origem)}</div>`
        : '';
      const reaproveitadoHtml = (t._reaproveitadoDepois && t._reaproveitadoDepois.length)
        ? `<div class="af-traco-origem-linha">➡️ Reaproveitado depois em: ${t._reaproveitadoDepois.map(_badgeOperacao).join(' ')}</div>`
        : '';

      return `
        <div class="af-traco-card">
          <div class="af-traco-header">
            <strong>Traço ${LW.escaparHtml(String(t.num_traco ?? t.id_traco))}</strong>
            <span class="af-traco-bercos">Berços B${t.berco_inicio}–B${t.berco_finalizacao}</span>
          </div>
          <div class="af-receita-grid">${receitaHtml}</div>
          ${t.obs ? `<div class="af-traco-obs">📝 ${LW.escaparHtml(t.obs)}</div>` : ''}
          ${ajustesHtml}
          ${origemHtml}
          ${reaproveitadoHtml}
        </div>`;
    }).join('');
  }

  // ── Paradas que caíram dentro da janela [início,fim] da operação ──
  // Mesma técnica de sobreposição de _minutosParadaNaoPlanejadaNaJanela
  // (oee.js), mas devolvendo a LISTA inteira de paradas sobrepostas (não
  // só o total de minutos) e sem filtrar por classificação — aqui é pra
  // mostrar contexto ("o que aconteceu durante esta operação"), não pra
  // descontar tempo de Disponibilidade.
  function _paradasNaJanela(paradas, inicioISO, fimISO) {
    if (!inicioISO || !fimISO || !paradas || !paradas.length) return [];
    const ini = new Date(inicioISO).getTime();
    const fim = new Date(fimISO).getTime();
    if (isNaN(ini) || isNaN(fim) || fim <= ini) return [];

    return paradas.filter(p => {
      if (!p.inicio || !p.fim) return false;
      const pIni = new Date(p.inicio).getTime();
      const pFim = new Date(p.fim).getTime();
      if (isNaN(pIni) || isNaN(pFim)) return false;
      return pFim > ini && pIni < fim; // qualquer sobreposição, mesmo parcial
    }).sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
  }

  function _renderParadas(paradas) {
    const el = document.getElementById('af-paradas');
    if (!el) return;
    if (!paradas.length) {
      el.innerHTML = `<div class="sq-empty-af"><i class="fas fa-inbox"></i> Nenhuma parada registrada durante esta operação.</div>`;
      return;
    }
    el.innerHTML = paradas.map(p => {
      const planejada = p.classificacao === 'Planejada';
      const duracaoMin = p.duracao_min != null
        ? p.duracao_min
        : (p.inicio && p.fim ? (new Date(p.fim) - new Date(p.inicio)) / 60000 : null);
      return `
        <div class="af-traco-card" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          <span class="badge ${planejada ? 'badge-blue' : 'badge-red'}">${planejada ? 'Planejada' : 'Não Planejada'}</span>
          <strong>${LW.escaparHtml(p.equipamento || p.motivo || '—')}</strong>
          <span style="color:var(--text-3)">${duracaoMin != null ? Math.round(duracaoMin) + ' min' : '—'}</span>
          ${p.obs ? `<span style="color:var(--text-2);font-size:.82rem">📝 ${LW.escaparHtml(p.obs)}</span>` : ''}
        </div>`;
    }).join('');
  }

  // ── Avaliação de qualidade (painéis em texto, não em marca) ──────
  function _labelPainel(p) {
    if (!p) return '— Sem marcação';
    if (p.resultado === 'aprovado') return p.linha === '2ª' ? 'Aprovado / 2ª linha' : 'Aprovado / 1ª linha';
    if (p.resultado === 'reprovado') return 'Reprovado';
    // Bateria excluída da fila do Setor de Qualidade antes de ser avaliada
    // de verdade (ver SQ.excluirDaFila, setor-qualidade.js) — TODOS os
    // painéis dela nascem com este resultado, tipoObtido sempre null.
    // Sem este caso, caía no "— Sem marcação"/"—" abaixo, indistinguível
    // de uma placa que nunca teve marca nenhuma numa avaliação normal.
    if (p.resultado === 'nao_avaliado_no_sistema') return 'Não avaliado no sistema';
    return p.tipoObtido || '—'; // caso raro: 'Outros'/'Múltiplas' (ver classifyMarks, setor-qualidade.js)
  }
  function _corPainel(p) {
    if (!p) return 'var(--border-2)';
    if (p.resultado === 'aprovado') return p.linha === '2ª' ? 'var(--blue)' : 'var(--green)';
    if (p.resultado === 'reprovado') return 'var(--red)';
    if (p.resultado === 'nao_avaliado_no_sistema') return 'var(--text-3)';
    return 'var(--text-3)';
  }

  // Quantas placas o PALETE `pallet` teve de verdade nesta avaliação —
  // olha os painéis salvos de verdade em vez de dividir o total igual
  // pra todo mundo (ver conversa que motivou: "o espelho e a análise
  // focada não estão refletindo paletes com painéis a menos" — antes,
  // totalPorPallet = totalSlabs/4 assumia os 4 paletes sempre do mesmo
  // tamanho, mas um berço "não enchido" ou um lado só parcialmente cheio
  // tira painel de UM palete só, não dos 4 igualmente — ver
  // _removerPaineisNaoEnchidosDaGrade, setor-qualidade.js).
  function _totalPorPallet(paineis, pallet) {
    const posicoes = paineis.filter(p => p.pallet === pallet).map(p => p.posicao);
    return posicoes.length ? Math.max(...posicoes) : 0;
  }

  function _renderAvaliacao(avaliacao) {
    const el = document.getElementById('af-avaliacao');
    if (!el) return;
    if (!avaliacao) {
      el.innerHTML = `<div class="sq-empty-af"><i class="fas fa-inbox"></i> Bateria sem avaliação.</div>`;
      return;
    }
    const montagem = avaliacao.montagem || {};
    const paineis = avaliacao.paineis || [];

    let html = '<div class="af-paineis-grid">';
    // Ordem visual pedida: Pallet 2/Pallet 1 na 1ª linha, Pallet 3/Pallet 4
    // na 2ª (layout 2x2) — só a ORDEM DE EXIBIÇÃO muda; os dados de cada
    // pallet continuam vindo do mesmo número de sempre (avaliacao.paineis,
    // montagem['palletN']), sem nenhuma outra mudança.
    [2, 1, 3, 4].forEach(p => {
      // Tipo de montagem daquele pallet — "no cantinho", cabeçalho do
      // próprio card do pallet, não em cada painel individual.
      const tipoMontPallet = montagem['pallet' + p] || '—';
      const totalPorPallet = _totalPorPallet(paineis, p); // cada palete com a contagem DELE, não uma média/fixo compartilhado
      html += `<div class="af-pallet"><div class="af-pallet-header"><span>Pallet ${p}</span><span class="af-pallet-tipo">${LW.escaparHtml(tipoMontPallet)}</span></div><div class="af-pallet-slabs">`;
      for (let i = 1; i <= totalPorPallet; i++) {
        const painel = paineis.find(pp => pp.pallet === p && pp.posicao === i);
        const cor = _corPainel(painel);
        html += `<div class="af-slab" style="border-left-color:${cor}">
          <span class="af-slab-num">${i}</span>
          <span class="af-slab-resultado" style="color:${cor}">${_labelPainel(painel)}</span>
        </div>`;
      }
      html += '</div></div>';
    });
    html += '</div>';
    el.innerHTML = html;
  }

  // ── Render principal ─────────────────────────────────────────
  async function render() {
    const loading = document.getElementById('af-loading');
    const erro = document.getElementById('af-erro');
    const vazio = document.getElementById('af-vazio');
    const content = document.getElementById('af-content');

    if (!_idAtual) {
      if (loading) loading.style.display = 'none';
      if (content) content.style.display = 'none';
      if (erro) erro.style.display = 'none';
      if (vazio) vazio.style.display = '';
      return;
    }

    if (vazio) vazio.style.display = 'none';
    if (loading) loading.style.display = '';
    if (content) content.style.display = 'none';
    if (erro) erro.style.display = 'none';

    const [detalhe] = await Promise.all([
      LW.getDetalheOperacao(_idAtual),
      _carregarCaches(), // pra cadeia de reaproveitamento e paradas, abaixo
    ]);

    if (loading) loading.style.display = 'none';

    if (!detalhe) {
      if (erro) { erro.style.display = ''; erro.textContent = 'Não foi possível carregar os dados desta operação — ela pode ter sido excluída.'; }
      return;
    }

    if (content) content.style.display = '';
    _anotarOrigemEReaproveitamento(detalhe.tracos, _idAtual);
    const paradasDaJanela = _paradasNaJanela(_cacheParadas, detalhe.operacao?.inicio, detalhe.operacao?.fim);

    _renderCabecalho(detalhe.operacao);
    _renderBercos(detalhe.bercosVisuais, detalhe.operacao);
    _renderReceita(detalhe.tracos);
    _renderParadas(paradasDaJanela);
    _renderAvaliacao(detalhe.avaliacao);
  }

  // ── Exportar Dashboard Interativo (HTML standalone) ───────────────────────
  // Diferente dos outros dashboards (sem período/filtro aqui — é sobre UMA
  // operação só): embute o detalhe já carregado (LW.getDetalheOperacao) e
  // as mesmas funções de render via toString(), virando um retrato
  // autossuficiente dessa operação específica — sem filtro pra aplicar,
  // "interativo" aqui significa só "abre em qualquer navegador, offline,
  // com a mesma formatação".
  async function exportarInterativo() {
    if (!_idAtual) return;
    const btn = document.getElementById('btn-af-exportar');
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando…'; }
    try {
      const [detalhe] = await Promise.all([LW.getDetalheOperacao(_idAtual), _carregarCaches()]);
      if (!detalhe) { if (LW.mostrarAlerta) LW.mostrarAlerta('Não consegui carregar os dados desta operação.', { tipo: 'erro' }); return; }
      _anotarOrigemEReaproveitamento(detalhe.tracos, _idAtual);
      const paradasDaJanela = _paradasNaJanela(_cacheParadas, detalhe.operacao?.inicio, detalhe.operacao?.fim);
      const html = _gerarHtmlAfStandalone(detalhe, paradasDaJanela);
      LW.baixarArquivoTexto(
        `analise_focada_${LW.escaparHtml(String(detalhe.operacao?.id || _idAtual)).replace(/[^a-zA-Z0-9_-]/g, '_')}.html`,
        html
      );
    } catch (err) {
      console.error('Falha ao exportar Análise Focada:', err);
      if (LW.mostrarAlerta) LW.mostrarAlerta('Não consegui gerar o arquivo agora.', { tipo: 'erro' });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🌐 Exportar Interativo'; }
    }
  }

  // Cor determinística (hash simples) por tipo de montagem — simplificação
  // assumida aqui: sem a cor REAL configurada em Configurações → Montagem
  // embutida (exigiria embutir MONTAGEM_OPCOES inteiro), cada tipo distinto
  // ganha uma cor fixa e consistente dentro do próprio arquivo exportado
  // (mesmo tipo = mesma cor sempre, só não é a mesma cor da tela ao vivo).
  const _PALETA_TIPO = ['#4d8dff', '#2ecc71', '#8b5cf6', '#f5821f', '#06b6d4', '#e5484d', '#f1c40f'];
  function _corPorTipoSimplificada(tipo) {
    if (!tipo) return null;
    let hash = 0;
    for (let i = 0; i < tipo.length; i++) hash = (hash * 31 + tipo.charCodeAt(i)) >>> 0;
    const cor = _PALETA_TIPO[hash % _PALETA_TIPO.length];
    return { cor: '#fff', bg: cor, borda: cor };
  }

  function _gerarHtmlAfStandalone(detalhe, paradasDaJanela = []) {
    const detalheJson = JSON.stringify(detalhe).replace(/<\/script/gi, '<\\/script');
    const paradasJson = JSON.stringify(paradasDaJanela).replace(/<\/script/gi, '<\\/script');

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Análise Focada — ${LW.escaparHtml(String(detalhe.operacao?.id || ''))} — Exportado</title>
<style>${LW.gerarCssExportPadrao()}
  .af-cabecalho-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:14px; }
  .af-label { font-size:.68rem; text-transform:uppercase; letter-spacing:.06em; color:var(--text-3); margin-bottom:4px; }
  .af-valor { font-size:.95rem; color:var(--text); font-weight:600; }
  .sq-empty-af { text-align:center; padding:30px 10px; color:var(--text-3); font-size:.85rem; }
  .af-traco-card { background:var(--bg-1); border:1px solid var(--border); border-radius:var(--radius-lg); padding:14px 16px; margin-bottom:12px; }
  .af-traco-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
  .af-traco-bercos { font-size:.78rem; color:var(--text-3); }
  .af-receita-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:8px; font-size:.82rem; }
  .af-traco-obs { margin-top:10px; font-size:.8rem; color:var(--text-2); }
  .af-sem-ajuste { margin-top:10px; font-size:.8rem; color:var(--text-3); font-style:italic; }
  .af-ajustes-wrap { margin-top:12px; }
  .af-ajustes-titulo { font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; color:var(--text-3); margin-bottom:6px; }
  .af-ajuste-linha { display:flex; flex-wrap:wrap; gap:12px; font-size:.8rem; padding:6px 10px; background:var(--bg-card); border-radius:var(--radius); margin-bottom:4px; }
  .af-traco-origem-linha { margin-top:10px; font-size:.8rem; color:var(--text-2); display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .af-paineis-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; }
  .af-pallet { border:1px solid var(--border); border-radius:var(--radius-lg); padding:10px 12px; background:var(--bg-1); }
  .af-pallet-header { display:flex; justify-content:space-between; align-items:center; font-weight:700; font-size:.85rem; margin-bottom:8px; }
  .af-pallet-tipo { font-size:.66rem; font-weight:600; background:var(--border); color:var(--text-3); padding:2px 8px; border-radius:999px; }
  .af-pallet-slabs { display:flex; flex-direction:column; gap:4px; }
  .af-slab { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:5px 8px; border:1px solid var(--border); border-left-width:3px; border-radius:4px; font-size:.78rem; background:var(--bg-card); }
  .af-slab-num { color:var(--text-3); font-family:var(--font-mono); }
  .af-slab-resultado { font-weight:700; text-align:right; }
  .ba-grid { display:flex; flex-direction:row-reverse; flex-wrap:nowrap; justify-content:center; gap:4px; }
  .ba-celula { display:flex; flex-direction:column; align-items:center; justify-content:space-between; flex:1 1 0; min-width:0; padding:6px 2px; border-radius:var(--radius); }
  .ba-numero { text-align:center; white-space:nowrap; font-size:.72rem; }
  .ba-dot { font-size:.95rem; line-height:1; padding:3px 5px; opacity:.55; border-radius:50%; }
  .ba-dot.ba-dot-marcado { opacity:1; color:var(--red); background:rgba(229,72,77,.15); }
  .badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:.72rem; font-weight:700; }
  .badge-blue { background:rgba(59,130,246,.15); color:#93c5fd; }
  .badge-red { background:rgba(239,68,68,.15); color:#fecaca; }
  .mono { font-family:var(--font-mono); }
</style>
</head>
<body>
  <h1>🔎 Análise Focada — Operação ${LW.escaparHtml(String(detalhe.operacao?.id || ''))}</h1>
  <div class="sub" id="exp-sub">Gerado em ${new Date().toLocaleString('pt-BR')}</div>

  <div class="chart-box" style="margin-bottom:14px"><h4>Identificação</h4><div id="af-cabecalho" class="af-cabecalho-grid"></div></div>
  <div class="chart-box" style="margin-bottom:14px"><h4>📍 Berços</h4><div id="af-bercos"></div></div>
  <div class="chart-box" style="margin-bottom:14px"><h4>🧪 Receita Utilizada</h4><div id="af-receita"></div></div>
  <div class="chart-box" style="margin-bottom:14px"><h4>🛑 Paradas Nesta Janela</h4><div id="af-paradas"></div></div>
  <div class="chart-box"><h4>✅ Avaliação de Qualidade</h4><div id="af-avaliacao"></div></div>

  <div class="rodape">Exportado da Análise Focada — Lightwall SC · dados embutidos neste arquivo, funciona offline. Cores de tipo de montagem são aproximadas (não refletem necessariamente a cor configurada na tela ao vivo). Os badges de "Origem"/"Reaproveitado depois em" são só informativos aqui — abrir a outra operação exige a tela ao vivo.</div>

<script>
(function () {
  'use strict';
  const DETALHE = ${detalheJson};
  const PARADAS = ${paradasJson};
  const LW = {
    escaparHtml: s => { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; },
    TIPO_MONTAGEM_PERSONALIZADA: 'PERSONALIZADA',
    corPorTipoSimples: ${_corPorTipoSimplificada},
    corMontagemPorLabel: ${_corPorTipoSimplificada},
  };
  const _PALETA_TIPO = ${JSON.stringify(_PALETA_TIPO)};

  ${_fmtData}
  ${_fmtHora}
  ${_fmtTempoBatidaOriginal}
  ${_fmtKg}
  ${_renderCabecalho}
  ${_corPorTipoBerco}
  ${_renderBercos}
  ${_badgeOperacao}
  ${_renderReceita}
  ${_renderParadas}
  ${_labelPainel}
  ${_corPainel}
  ${_renderAvaliacao}

  _renderCabecalho(DETALHE.operacao || {});
  _renderBercos(DETALHE.bercosVisuais, DETALHE.operacao);
  _renderReceita(DETALHE.tracos);
  _renderParadas(PARADAS);
  _renderAvaliacao(DETALHE.avaliacao);
})();
</script>
</body>
</html>`;
  }

  function init() {
    render();
  }

  window.LWFocada = { abrir, abrirBusca, buscar, voltar, init, render, exportarInterativo, fmtHora: _fmtHora, totalPorPallet: _totalPorPallet };
})();