// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  oee.js — Análise de OEE (Disponibilidade × Performance × Qualidade)
//
//  Definições combinadas com o usuário:
//  - Disponibilidade: cada turno tem 9h, das quais 1h é descanso e ~1h é
//    lavagem programada (2x 30min) → restam 7h (420 min) de produção
//    planejada por turno. Disponibilidade = tempo real produzindo (soma de
//    tempo_min das operações daquele turno) ÷ 420 min.
//    Tempo real produzindo desconta a parte de cada parada NÃO PLANEJADA
//    (registrada em "Paradas") que cair dentro da janela [início,fim] da
//    operação — o cronômetro continua contando durante uma parada não
//    planejada, mas esse tempo não é produção de fato. Atraso (tempo_min,
//    houve_atraso) continua intocado por esse desconto — são coisas
//    independentes, pode ter atraso sem ter tido parada.
//  - Performance: ciclo ideal de 59 min por operação/bateria. Performance =
//    (59 × nº de operações) ÷ tempo real produzindo, limitado a 100%.
//  - Qualidade: % de traços que NÃO precisaram de nenhum ajuste de insumo
//    (mesmo critério usado em "Qualidade dos Traços" — cimento, água, EPS,
//    superplastificante, incorporador de ar).
//  - OEE = Disponibilidade × Performance × Qualidade
//
//  Fontes de dados: historico.json (via LW.getStats) e relatorio_injecao.json
// ============================================================

'use strict';

(function () {

  const C = {
    accent: '#f59e0b', blue: '#3b82f6', green: '#10b981', red: '#ef4444',
    purple: '#8b5cf6', cyan: '#06b6d4', text2: '#8b93a5', text3: '#5c6475',
    border: '#353c4a', bg3: '#2e3441',
  };

  // ── Parâmetros do OEE, combinados com o usuário ──────────────────────────
  const MINUTOS_TURNO_PLANEJADO = 7 * 60; // 9h - 1h descanso - 1h lavagem (2x30min) = 7h
  const CICLO_IDEAL_MIN = 59;             // tempo de ciclo ideal por operação/bateria

  // Mesmos insumos e mesma lógica de detecção de ajuste usados em
  // qualidade-tracos.js — pra "Qualidade" do OEE bater exatamente com o que
  // aparece naquela tela, no mesmo período.
  const CAMPOS_INSUMO = ['cimento_real', 'agua_real', 'eps_real', 'superplast_real', 'incorporador_real'];

  function _normalizarInsumo(val) {
    if (val === null || val === undefined || val === '') return { ajustes: [] };
    if (typeof val === 'object' && 'ajustes' in val) {
      return { ajustes: Array.isArray(val.ajustes) ? val.ajustes : [] };
    }
    return { ajustes: [] }; // número/string simples — nunca teve ajuste
  }

  function _tracoTemAjuste(t) {
    return CAMPOS_INSUMO.some(campo => _normalizarInsumo(t[campo]).ajustes.length > 0);
  }

  // Mesma lógica de tempoMin usada em analise-operacional.js
  function _tempoMin(rec) {
    if (rec.tempo_min && rec.tempo_min > 0) return rec.tempo_min;
    if (rec.inicio && rec.fim) {
      const diff = (new Date(rec.fim) - new Date(rec.inicio)) / 60000;
      if (diff > 0) return diff;
    }
    return 0;
  }

  // ── Desconto de parada NÃO PLANEJADA no tempo produzindo ──────────────────
  // O cronômetro da operação continua contando mesmo durante uma parada não
  // planejada (ex: bico de injeção entupiu) — o operador não pausa a tela,
  // só registra a parada separadamente. Esse tempo NÃO é produção de fato,
  // então a parcela da parada que cair dentro da janela [início, fim] da
  // operação é descontada do tempo produzindo usado na Disponibilidade.
  // Importante: isso NÃO altera tempo_min, houve_atraso ou motivo_atraso —
  // o atraso continua sendo calculado do jeito que já era (pode ter
  // atrasado sem ter tido parada nenhuma, são coisas independentes). Só a
  // conta interna de Disponibilidade do OEE usa esse desconto.
  function _minutosParadaNaoPlanejadaNaJanela(inicioISO, fimISO, paradas) {
    if (!inicioISO || !fimISO || !paradas || !paradas.length) return 0;
    const ini = new Date(inicioISO).getTime();
    const fim = new Date(fimISO).getTime();
    if (isNaN(ini) || isNaN(fim) || fim <= ini) return 0;

    let totalMs = 0;
    paradas.forEach(p => {
      if (p.classificacao !== 'Não Planejada') return;
      if (!p.inicio || !p.fim) return;
      const pIni = new Date(p.inicio).getTime();
      const pFim = new Date(p.fim).getTime();
      if (isNaN(pIni) || isNaN(pFim)) return;
      // Sobreposição clipada à janela da operação — se a parada for maior
      // ou cair parcialmente fora da janela, só a parte que coincide com
      // esta operação entra na conta dela.
      const overlapIni = Math.max(ini, pIni);
      const overlapFim = Math.min(fim, pFim);
      if (overlapFim > overlapIni) totalMs += (overlapFim - overlapIni);
    });
    return totalMs / 60000;
  }

  // Tempo produzindo "real" de uma operação: tempo_min menos a parte de
  // paradas não planejadas que caiu dentro da janela dela. Nunca negativo.
  function _tempoProduzindoReal(rec, paradas) {
    const bruto = _tempoMin(rec);
    const descontar = _minutosParadaNaoPlanejadaNaJanela(rec.inicio, rec.fim, paradas);
    return Math.max(0, bruto - descontar);
  }

  // ── Agrupamento por turno-instância (data + turno) ───────────────────────
  // Cada combinação de data+turno tem seu próprio orçamento de 420 min,
  // independente de quantas baterias rodaram nela.
  function _agruparPorTurnoInstancia(historico) {
    const grupos = {};
    historico.forEach(r => {
      const chave = `${r.data}__${r.turno}`;
      if (!grupos[chave]) grupos[chave] = { data: r.data, turno: r.turno, ops: [] };
      grupos[chave].ops.push(r);
    });
    return Object.values(grupos).sort((a, b) => (a.data + a.turno).localeCompare(b.data + b.turno));
  }

  // ── Cálculo dos 3 componentes ─────────────────────────────────────────────

  // `paradas` é opcional — quando informado, paradas classificadas como
  // "Não Planejada" que coincidirem com a janela [início,fim] de uma
  // operação descontam do tempo produzindo dela (ver _tempoProduzindoReal).
  function calcularDisponibilidade(historico, paradas = []) {
    const turnos = _agruparPorTurnoInstancia(historico);
    if (!turnos.length) return { pct: 0, turnos: [], tempoTotalProduzindo: 0, tempoPlanejadoTotal: 0, nTurnos: 0 };

    let tempoTotalProduzindo = 0;
    const detalhe = turnos.map(g => {
      const tempoProduzindo = g.ops.reduce((s, r) => s + _tempoProduzindoReal(r, paradas), 0);
      tempoTotalProduzindo += tempoProduzindo;
      return {
        data: g.data,
        turno: g.turno,
        nOps: g.ops.length,
        tempoProduzindo,
        disponibilidadePct: (tempoProduzindo / MINUTOS_TURNO_PLANEJADO) * 100,
      };
    });

    const tempoPlanejadoTotal = turnos.length * MINUTOS_TURNO_PLANEJADO;
    const pct = tempoPlanejadoTotal > 0 ? Math.min(100, (tempoTotalProduzindo / tempoPlanejadoTotal) * 100) : 0;

    return { pct, turnos: detalhe, tempoTotalProduzindo, tempoPlanejadoTotal, nTurnos: turnos.length };
  }

  function calcularPerformance(historico) {
    const n = historico.length;
    if (!n) return { pct: 0, n: 0, tempoReal: 0, tempoIdeal: 0 };
    const tempoReal = historico.reduce((s, r) => s + _tempoMin(r), 0);
    const tempoIdeal = n * CICLO_IDEAL_MIN;
    const pct = tempoReal > 0 ? Math.min(100, (tempoIdeal / tempoReal) * 100) : 0;
    return { pct, n, tempoReal, tempoIdeal };
  }

  function calcularQualidade(tracos) {
    const total = tracos.length;
    if (!total) return { pct: 0, total: 0, comAjuste: 0, semAjuste: 0 };
    const comAjuste = tracos.filter(_tracoTemAjuste).length;
    const semAjuste = total - comAjuste;
    return { pct: (semAjuste / total) * 100, total, comAjuste, semAjuste };
  }

  // ── Quebra por turno-instância (Disponibilidade + Performance + Qualidade
  // + OEE de cada uma) ───────────────────────────────────────────────────────
  function calcularPorTurnoInstancia(historico, tracos, paradas = []) {
    const turnos = _agruparPorTurnoInstancia(historico);
    return turnos.map(g => {
      const perf = calcularPerformance(g.ops);
      const tracosDoTurno = tracos.filter(t => t.data === g.data && t.turno === g.turno);
      const qual = calcularQualidade(tracosDoTurno);
      const tempoProduzindo = g.ops.reduce((s, r) => s + _tempoProduzindoReal(r, paradas), 0);
      const dispPct = (tempoProduzindo / MINUTOS_TURNO_PLANEJADO) * 100;
      // Sem traço registrado nesse turno = qualidade indeterminada (null), não
      // "0% de qualidade" — são coisas diferentes (falta de dado x falha real).
      const qualPct = qual.total > 0 ? qual.pct : null;
      const oeePct = qualPct === null ? null
        : (Math.min(100, dispPct) / 100) * (perf.pct / 100) * (qualPct / 100) * 100;
      return {
        data: g.data, turno: g.turno, nOps: g.ops.length, nTracos: qual.total, tempoProduzindo,
        dispPct, perfPct: perf.pct, qualPct, oeePct,
      };
    });
  }

  // ── Quebra por um campo genérico (id_bateria ou tipo_montagem) — só
  // Performance e Qualidade fazem sentido aqui (Disponibilidade é uma
  // característica do TURNO como um todo, não de uma bateria/tipo isolado) ──
  //
  // Para os traços, id_bateria e tipo_montagem não existem como campos diretos
  // (ver _buscarDados, onde são resolvidos e anotados como _baterias e
  // _tipoMontagem). A lógica de agrupamento difere entre os dois campos:
  // - id_bateria: um traço pode ter sido reaproveitado em baterias diferentes,
  //   então entra no grupo de CADA bateria onde aparece (_baterias é um Set).
  // - tipo_montagem: usa o tipo da operação original (_tipoMontagem), sem
  //   duplicar pelas reutilizações.
  function calcularPorGrupo(historico, tracos, campo) {
    const grupos = {};

    historico.forEach(r => {
      const chave = r[campo] || '—';
      if (!grupos[chave]) grupos[chave] = { historico: [], tracos: new Set() };
      grupos[chave].historico.push(r);
    });

    tracos.forEach(t => {
      if (campo === 'id_bateria') {
        // Traço pode pertencer a várias baterias — conta em cada uma
        const baterias = t._baterias?.size ? t._baterias : new Set(['—']);
        baterias.forEach(bat => {
          if (!grupos[bat]) grupos[bat] = { historico: [], tracos: new Set() };
          grupos[bat].tracos.add(t);
        });
      } else {
        // tipo_montagem: usa o campo resolvido _tipoMontagem
        const chave = t._tipoMontagem || '—';
        if (!grupos[chave]) grupos[chave] = { historico: [], tracos: new Set() };
        grupos[chave].tracos.add(t);
      }
    });

    return Object.entries(grupos).map(([chave, g]) => {
      const tracosArr = [...g.tracos];
      const perf = calcularPerformance(g.historico);
      const qual = calcularQualidade(tracosArr);
      return {
        chave,
        nOps: g.historico.length,
        nTracos: tracosArr.length,
        perfPct: perf.pct,
        qualPct: qual.pct,
      };
    }).sort((a, b) => b.nOps - a.nOps);
  }

  // ── Dados ──────────────────────────────────────────────────────────────
  async function _buscarDados(filtros) {
    const stats = await LW.getStats({ dataInicio: filtros.dataInicio, dataFim: filtros.dataFim, turno: filtros.turno });
    let historico = stats.data || [];
    if (filtros.bateria) historico = historico.filter(r => r.id_bateria === filtros.bateria);

    // Mapa id_operacao → tipo_montagem, construído a partir do historico já
    // carregado — evita uma segunda requisição a historico.json só pra
    // resolver tipo_montagem nos traços (ver anotação abaixo).
    const mapaTipoMontagem = new Map();
    (stats.data || []).forEach(op => { if (op.id) mapaTipoMontagem.set(op.id, op.tipo_montagem || null); });

    let tracos = await fetch('db/relatorio_injecao.json').then(r => r.json()).catch(() => []);

    // Anota cada traço com dois campos resolvidos:
    // - _baterias (Set): ids das baterias onde esse traço foi usado, lidos
    //   de ultilizado.operacao[].id_bateria. O campo t.id_bateria não existe
    //   nesse nível (mesmo bug já corrigido no Relatório de Injeção e no CEP).
    // - _tipoMontagem: tipo de montagem da operação original onde esse traço
    //   foi registrado. t.tipo_montagem também não existe nesse nível — é um
    //   campo da operação (historico.json), não do traço.
    // Ambos são usados por calcularPorGrupo (quebra por Bateria / por Tipo
    // de Montagem) e pelo filtro de bateria abaixo.
    tracos.forEach(t => {
      const usos = t.ultilizado?.operacao || [];
      t._baterias = new Set(usos.map(u => u.id_bateria).filter(Boolean));
      let tipoMontagem = null;
      for (const uso of usos) {
        tipoMontagem = mapaTipoMontagem.get(uso.id_operacao) || null;
        if (tipoMontagem) break;
      }
      t._tipoMontagem = tipoMontagem;
    });

    tracos = tracos.filter(t => {
      if (filtros.dataInicio && t.data < filtros.dataInicio) return false;
      if (filtros.dataFim && t.data > filtros.dataFim) return false;
      if (filtros.turno && t.turno !== filtros.turno) return false;
      // Antes: t.id_bateria !== filtros.bateria — nunca batia (campo inexistente)
      if (filtros.bateria && !t._baterias.has(filtros.bateria)) return false;
      return true;
    });

    // Paradas não têm turno/bateria associados diretamente (só início/fim)
    // — filtramos só por data. A sobreposição entre uma parada NÃO
    // PLANEJADA e a janela [início,fim] de cada operação É usada para
    // descontar do tempo produzindo da Disponibilidade (ver
    // _tempoProduzindoReal) — paradas planejadas não afetam esse cálculo.
    let paradas = await fetch('db/paradas.json').then(r => r.ok ? r.json() : []).catch(() => []);
    if (!Array.isArray(paradas)) paradas = [];
    paradas = paradas.filter(p => {
      // p.inicio é ISO em UTC — slice(0,10) cru pegava a data em UTC, não
      // em Brasília, e fazia paradas registradas à noite sumirem do
      // relatório (ver dataBrasiliaDeISO em data.js).
      const data = typeof dataBrasiliaDeISO === 'function'
        ? dataBrasiliaDeISO(p.inicio)
        : (p.inicio || '').slice(0, 10);
      if (filtros.dataInicio && data < filtros.dataInicio) return false;
      if (filtros.dataFim && data > filtros.dataFim) return false;
      return true;
    });

    return { historico, tracos, paradas };
  }

  // Soma o tempo de paradas registradas no período, separado por
  // classificação — usado pra EXIBIR de onde vem o tempo sem produção na
  // barra de composição (_renderParadasBreakdown). É um total simples por
  // data, sem checar sobreposição com operação nenhuma — diferente do
  // desconto de Disponibilidade (_tempoProduzindoReal), que só conta a
  // parte de cada parada não planejada que de fato caiu dentro da janela
  // de uma operação.
  function _resumoParadas(paradas) {
    let planejada = 0, naoPlanejada = 0;
    paradas.forEach(p => {
      const min = parseFloat(p.duracao_min) || 0;
      if (p.classificacao === 'Planejada') planejada += min;
      else naoPlanejada += min;
    });
    return { planejada, naoPlanejada, n: paradas.length };
  }

  function _lerFiltros() {
    return {
      dataInicio: document.getElementById('oee-data-inicio')?.value || '',
      dataFim: document.getElementById('oee-data-fim')?.value || '',
      bateria: document.getElementById('oee-bateria')?.value || '',
      turno: document.getElementById('oee-turno')?.value || '',
    };
  }

  async function _popularFiltroBateria() {
    const sel = document.getElementById('oee-bateria');
    if (!sel) return;
    sel.innerHTML = '<option value="">Todas</option>';
    (LW.BATERIA_IDS || []).forEach(b => {
      const o = document.createElement('option');
      o.value = o.textContent = b.id;
      sel.appendChild(o);
    });
  }

  // ── Render: KPIs e composição visual ────────────────────────────────────
  function _setText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }
  function _fmtPct(v) { return isFinite(v) ? v.toFixed(1).replace('.', ',') + '%' : '—'; }
  function _fmtMin(v) {
    const h = Math.floor(v / 60), m = Math.round(v % 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`;
  }

  function _renderKPIs(disp, perf, qual) {
    const oee = (disp.pct / 100) * (perf.pct / 100) * (qual.pct / 100) * 100;
    _setText('oee-kpi-disp', _fmtPct(disp.pct));
    _setText('oee-kpi-perf', _fmtPct(perf.pct));
    _setText('oee-kpi-qual', _fmtPct(qual.pct));
    _setText('oee-kpi-geral', _fmtPct(oee));
  }

  function _renderWaterfall(disp, perf, qual) {
    const el = document.getElementById('oee-waterfall');
    if (!el) return;
    const oee = (disp.pct / 100) * (perf.pct / 100) * (qual.pct / 100) * 100;
    const linhas = [
      { label: 'Disponibilidade', pct: disp.pct, cor: C.blue,
        sub: `${_fmtMin(disp.tempoTotalProduzindo)} produzindo de ${_fmtMin(disp.tempoPlanejadoTotal)} planejados (${disp.nTurnos} turno${disp.nTurnos !== 1 ? 's' : ''})` },
      { label: 'Performance', pct: perf.pct, cor: C.green,
        sub: `${perf.n} operações · ciclo real médio ${perf.n ? _fmtMin(perf.tempoReal / perf.n) : '—'} (ideal: ${CICLO_IDEAL_MIN}min)` },
      { label: 'Qualidade', pct: qual.pct, cor: C.purple,
        sub: `${qual.semAjuste} de ${qual.total} traços sem nenhum ajuste de insumo` },
      { label: 'OEE', pct: oee, cor: C.accent, destaque: true,
        sub: 'Disponibilidade × Performance × Qualidade' },
    ];
    el.innerHTML = linhas.map(l => `
      <div>
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
          <span style="font-size:${l.destaque ? '.9rem' : '.84rem'};color:${l.destaque ? 'var(--text)' : 'var(--text-2)'};font-weight:${l.destaque ? '700' : '400'}">${l.label}</span>
          <span style="font-family:var(--font-mono);font-size:${l.destaque ? '1.1rem' : '.9rem'};font-weight:700;color:${l.cor}">${_fmtPct(l.pct)}</span>
        </div>
        <div style="height:${l.destaque ? '10px' : '7px'};background:var(--bg-3);border-radius:4px;overflow:hidden;margin-bottom:4px">
          <div style="height:100%;width:${Math.min(100, Math.max(0, l.pct))}%;background:${l.cor};border-radius:4px"></div>
        </div>
        <div style="font-size:.72rem;color:var(--text-3)">${l.sub}</div>
      </div>
    `).join('');
  }

  // ── Render: gráfico de barras (HTML/CSS) — OEE por turno-instância ──────
  //
  // Antes era desenhado num <canvas>, com o texto de cada legenda rotacionado
  // "na mão" via ctx.translate/ctx.rotate. Isso se mostrou frágil: um canvas
  // é só um bitmap com limites fixos, então qualquer erro de sinal no ângulo
  // ou de posição do pivô jogava parte do texto pra fora da área desenhável
  // e ele simplesmente sumia (sem erro, sem aviso) — foi o que causou o corte
  // do início de cada data ("23/06" virando "?306"). Também exigia lidar
  // manualmente com devicePixelRatio pra não borrar em tela retina, e
  // recalcular tudo a cada resize.
  //
  // Trocado por barras e legendas em HTML/CSS puro: quem cuida do layout,
  // da nitidez do texto e do comportamento em resize é o próprio navegador.
  // A rotação da legenda usa um truque de CSS bem conhecido (transform-origin
  // no canto + translateX(-100%)) que nunca corta texto, porque não há
  // "bitmap" nenhum com bordas — o texto pode extrapolar visualmente a
  // caixa sem ser cortado, já que o container não tem overflow:hidden.

  const ALTURA_CHART_TURNOS_PX = 160;
  const PAD_TOP_CHART_TURNOS_PX = 14;
  const PAD_BOTTOM_CHART_TURNOS_PX = 40; // espaço reservado pra legenda rotacionada

  function _renderBarChartHTML(id, labels, values) {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = '';
    if (!labels.length) return;

    const plotH = ALTURA_CHART_TURNOS_PX - PAD_TOP_CHART_TURNOS_PX - PAD_BOTTOM_CHART_TURNOS_PX;

    el.style.cssText = `
      position: relative; display: flex; align-items: flex-end; gap: 6px;
      height: ${ALTURA_CHART_TURNOS_PX}px;
      padding: ${PAD_TOP_CHART_TURNOS_PX}px 4px ${PAD_BOTTOM_CHART_TURNOS_PX}px;
      box-sizing: border-box;
      overflow-x: auto; overflow-y: hidden;
    `;

    // Cada barra soma flex:1 1 0 (some espaço igual, encolhe se
    // preciso) com um piso mínimo — com poucas barras, elas preenchem
    // a largura toda; com muitas (período longo = muitas datas/turnos),
    // encolher até sumir deixaria a barra ilegível, então a partir de
    // ~40 barras troca pra colunas de largura FIXA (28px, ainda dá pra
    // ver a barra de verdade) e deixa o container rolar na horizontal
    // (overflow-x:auto, acima) em vez de continuar espremendo.
    const muitasBarras = labels.length > 40;

    // Linha de referência em 85% (meta comum de OEE "classe mundial" é ~85%)
    const linhaRef = document.createElement('div');
    linhaRef.style.cssText = `
      position: absolute; left: 4px; right: 4px;
      top: ${PAD_TOP_CHART_TURNOS_PX + plotH * (1 - 0.85)}px;
      border-top: 1px dashed ${C.border};
    `;
    el.appendChild(linhaRef);

    labels.forEach((lab, i) => {
      const bruto = values[i];

      const col = document.createElement('div');
      col.style.cssText = muitasBarras
        ? `position: relative; flex: 0 0 28px; height: 100%; display: flex; align-items: flex-end;`
        : `position: relative; flex: 1 1 0; min-width: 4px; height: 100%; display: flex; align-items: flex-end;`;

      const bar = document.createElement('div');
      if (bruto === null || bruto === undefined) {
        // Sem dado (ex: turno sem traço registrado) — barra cinza fina, não
        // "0%" (que pareceria falha total em vez de ausência de dado).
        bar.title = `${lab}: sem dado`;
        bar.style.cssText = `width: 100%; height: 3px; background: ${C.border}; border-radius: 2px;`;
      } else {
        const v = Math.max(0, Math.min(100, bruto));
        const cor = v >= 85 ? C.green : v >= 60 ? C.accent : C.red;
        bar.title = `${lab}: ${_fmtPct(v)}`;
        bar.style.cssText = `
          width: 100%; height: ${(v / 100) * plotH}px; background: ${cor};
          border-radius: 2px 2px 0 0; transition: height .25s ease;
        `;
      }
      col.appendChild(bar);

      if (labels.length <= 20) {
        const label = document.createElement('div');
        label.textContent = lab;
        label.style.cssText = `
          position: absolute; top: 100%; left: 50%; margin-top: 6px;
          transform-origin: top right; transform: translateX(-100%) rotate(-40deg);
          white-space: nowrap; font-size: .66rem; color: ${C.text3};
        `;
        col.appendChild(label);
      }

      el.appendChild(col);
    });
  }

  // ── Render: tabelas ──────────────────────────────────────────────────────
  function _corPct(v) {
    return v >= 85 ? 'var(--green)' : v >= 60 ? 'var(--accent)' : 'var(--red)';
  }

  function _renderTabelaTurnos(linhas) {
    const tbody = document.getElementById('oee-tabela-turnos');
    if (!tbody) return;
    if (!linhas.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="color:var(--text-3)">Nenhum registro no período.</td></tr>';
      return;
    }
    tbody.innerHTML = linhas.slice().reverse().map(l => `
      <tr>
        <td class="mono">${l.data ? l.data.split('-').reverse().join('/') : '—'}</td>
        <td>${l.turno || '—'}</td>
        <td>${l.nOps}</td>
        <td class="mono">${_fmtMin(l.tempoProduzindo)}</td>
        <td style="color:${_corPct(l.dispPct)}">${_fmtPct(l.dispPct)}</td>
        <td style="color:${_corPct(l.perfPct)}">${_fmtPct(l.perfPct)}</td>
        <td style="color:${l.qualPct === null ? 'var(--text-3)' : _corPct(l.qualPct)}">${l.qualPct === null ? '— sem traço' : _fmtPct(l.qualPct)}</td>
        <td style="font-weight:700;color:${l.oeePct === null ? 'var(--text-3)' : _corPct(l.oeePct)}">${l.oeePct === null ? '—' : _fmtPct(l.oeePct)}</td>
      </tr>
    `).join('');
  }

  function _renderTabelaGrupo(idTbody, linhas, labelColuna) {
    const tbody = document.getElementById(idTbody);
    if (!tbody) return;
    if (!linhas.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="color:var(--text-3)">Nenhum registro no período.</td></tr>`;
      return;
    }
    tbody.innerHTML = linhas.map(l => `
      <tr>
        <td>${LW.escaparHtml(l.chave)}</td>
        <td>${l.nOps}</td>
        <td style="color:${_corPct(l.perfPct)}">${l.nOps ? _fmtPct(l.perfPct) : '—'}</td>
        <td>${l.nTracos}</td>
        <td style="color:${_corPct(l.qualPct)}">${l.nTracos ? _fmtPct(l.qualPct) : '—'}</td>
      </tr>
    `).join('');
  }

  // ── Render: barra de composição do tempo planejado (Produzindo / Parada
  // Planejada / Parada Não Planejada / Sem registro) — só ilustrativo, não
  // realimenta a fórmula de Disponibilidade. ─────────────────────────────────
  function _renderParadasBreakdown(disp, resumo) {
    const elBar = document.getElementById('oee-paradas-bar');
    const elLegenda = document.getElementById('oee-paradas-legenda');
    const elVazio = document.getElementById('oee-paradas-vazio');
    if (!elBar || !elLegenda) return;

    const planejadoTotal = disp.tempoPlanejadoTotal;
    if (!planejadoTotal) {
      elBar.innerHTML = '';
      elLegenda.innerHTML = '';
      if (elVazio) elVazio.style.display = 'block';
      return;
    }
    if (elVazio) elVazio.style.display = 'none';

    const produzindo = disp.tempoTotalProduzindo;
    const { planejada, naoPlanejada, n } = resumo;
    // "Sem registro": o que resta do orçamento do turno que não foi produção
    // nem parada lançada (pode ser atraso não registrado, etc.). Nunca
    // negativo — se as paradas registradas somarem mais que o próprio
    // orçamento (ex: parada lançada fora da janela das operações), zeramos
    // em vez de mostrar um número sem sentido.
    const semRegistro = Math.max(0, planejadoTotal - produzindo - planejada - naoPlanejada);

    const segs = [
      { label: 'Produzindo', min: produzindo, cor: C.green },
      { label: 'Parada Planejada', min: planejada, cor: C.blue },
      { label: 'Parada Não Planejada', min: naoPlanejada, cor: C.red },
      { label: 'Sem registro', min: semRegistro, cor: C.border },
    ];

    elBar.innerHTML = segs.map(s => {
      const pct = (s.min / planejadoTotal) * 100;
      if (pct <= 0) return '';
      return `<div style="height:100%;width:${pct}%;background:${s.cor}" data-tooltip="${s.label}: ${_fmtMin(s.min)} (${_fmtPct(pct)})"></div>`;
    }).join('');

    elLegenda.innerHTML = segs.map(s => {
      const pct = (s.min / planejadoTotal) * 100;
      return `
      <div style="display:flex;align-items:center;gap:7px;font-size:.78rem;color:var(--text-2)">
        <span style="width:10px;height:10px;border-radius:3px;background:${s.cor};display:inline-block;flex-shrink:0"></span>
        ${s.label}: <strong style="color:var(--text)">${_fmtMin(s.min)}</strong>
        <span style="color:var(--text-3)">(${_fmtPct(pct)})</span>
      </div>`;
    }).join('') + `
      <div style="font-size:.74rem;color:var(--text-3);width:100%;margin-top:2px">
        ${n} parada${n !== 1 ? 's' : ''} registrada${n !== 1 ? 's' : ''} no período.
      </div>`;
  }

  // ── Orquestração ─────────────────────────────────────────────────────────
  async function render() {
    const loading = document.getElementById('oee-loading');
    const empty = document.getElementById('oee-empty');
    const content = document.getElementById('oee-content');
    if (loading) loading.style.display = 'block';
    if (empty) empty.style.display = 'none';
    if (content) content.style.display = 'none';

    const filtros = _lerFiltros();
    const { historico, tracos, paradas } = await _buscarDados(filtros);

    if (loading) loading.style.display = 'none';

    if (!historico.length) {
      if (empty) empty.style.display = 'block';
      return;
    }
    if (content) content.style.display = 'block';

    const disp = calcularDisponibilidade(historico, paradas);
    const perf = calcularPerformance(historico);
    const qual = calcularQualidade(tracos);

    _renderKPIs(disp, perf, qual);
    _renderWaterfall(disp, perf, qual);
    _renderParadasBreakdown(disp, _resumoParadas(paradas));

    const porTurno = calcularPorTurnoInstancia(historico, tracos, paradas);
    const labels = porTurno.map(t => `${t.data.slice(5).split('-').reverse().join('/')} ${t.turno.replace(' TURNO', 'T')}`);
    // Mesmo padrão de _renderParadasBreakdown/oee-paradas-vazio, acima:
    // _renderBarChartHTML só limpa o container e sai quando não há turnos
    // no período — sem isso, o gráfico "OEE por Turno" ficava em branco,
    // sem nenhuma explicação, quando o período filtrado não tinha dados.
    const elTurnosVazio = document.getElementById('oee-turnos-vazio');
    if (elTurnosVazio) elTurnosVazio.style.display = porTurno.length ? 'none' : 'block';
    _renderBarChartHTML('oee-chart-turnos', labels, porTurno.map(t => t.oeePct));
    _renderTabelaTurnos(porTurno);

    _renderTabelaGrupo('oee-tabela-bateria', calcularPorGrupo(historico, tracos, 'id_bateria'), 'Bateria');
    _renderTabelaGrupo('oee-tabela-montagem', calcularPorGrupo(historico, tracos, 'tipo_montagem'), 'Tipo de Montagem');
  }

  // ── Exportar Dashboard Interativo (HTML standalone) ───────────────────────
  // Retrato FIXO do que está na tela no momento do clique — busca com os
  // MESMOS filtros ativos agora (_lerFiltros(): período, bateria, turno),
  // não mais o histórico inteiro com uma UI de filtro pra reaplicar
  // depois. Reaproveita as MESMAS funções de cálculo e de render deste
  // arquivo via toString() (cópia fiel do código-fonte, sem reescrever
  // nada à mão) — só a orquestração (render()) é reescrita pra ler do
  // objeto já filtrado embutido, sem precisar do servidor depois de gerado.
  async function exportarInterativo() {
    const btn = document.getElementById('btn-oee-exportar');
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando…'; }
    try {
      const filtros = _lerFiltros();
      const { historico, tracos, paradas } = await _buscarDados(filtros);
      // Set não é serializável em JSON — converte pra array; o script
      // exportado reconstrói o Set na hora de usar (ver calcularPorGrupo).
      const tracosSerializaveis = tracos.map(t => ({ ...t, _baterias: [...(t._baterias || [])] }));

      const descricaoFiltro = [
        (filtros.dataInicio || filtros.dataFim)
          ? (filtros.dataInicio ? new Date(filtros.dataInicio + 'T00:00:00').toLocaleDateString('pt-BR') : 'início') + ' até ' + (filtros.dataFim ? new Date(filtros.dataFim + 'T00:00:00').toLocaleDateString('pt-BR') : 'hoje')
          : 'Todos os períodos',
        filtros.bateria ? `Bateria ${filtros.bateria}` : null,
        filtros.turno || null,
      ].filter(Boolean).join(' · ');

      const html = _gerarHtmlOeeStandalone({ historico, tracos: tracosSerializaveis, paradas }, descricaoFiltro);
      LW.baixarArquivoTexto(
        `oee_${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}.html`,
        html
      );
    } catch (err) {
      console.error('Falha ao exportar dashboard interativo (OEE):', err);
      if (LW.mostrarAlerta) LW.mostrarAlerta('Não consegui gerar o dashboard interativo agora.', { tipo: 'erro' });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🌐 Exportar Interativo'; }
    }
  }

  function _gerarHtmlOeeStandalone(dados, descricaoFiltro) {
    const dadosJson = JSON.stringify(dados).replace(/<\/script/gi, '<\\/script');

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OEE — Exportado</title>
<style>${LW.gerarCssExportPadrao()}
  .waterfall-row { margin-bottom:14px; }
</style>
</head>
<body>
  <h1>⚙️ Análise de OEE</h1>
  <div class="sub" id="exp-sub">Gerado em ${new Date().toLocaleString('pt-BR')}</div>
  <div class="filtro-aplicado">📅 Filtro aplicado: <b>${LW.escaparHtml(descricaoFiltro)}</b></div>

  <div id="oee-empty" style="display:none;text-align:center;padding:40px;color:var(--text-3)">Nenhum registro no período selecionado.</div>

  <div id="oee-content">
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-label">Disponibilidade</div><div class="kpi-value" id="oee-kpi-disp">—</div></div>
      <div class="kpi-card"><div class="kpi-label">Performance</div><div class="kpi-value" id="oee-kpi-perf">—</div></div>
      <div class="kpi-card"><div class="kpi-label">Qualidade</div><div class="kpi-value" id="oee-kpi-qual">—</div></div>
      <div class="kpi-card" style="border-color:var(--accent)"><div class="kpi-label accent">OEE Geral</div><div class="kpi-value accent" id="oee-kpi-geral">—</div></div>
    </div>

    <div class="chart-box" style="margin-bottom:14px">
      <h4>Composição do OEE</h4>
      <div id="oee-waterfall"></div>
    </div>

    <div class="chart-box" style="margin-bottom:14px">
      <h4>🛑 De onde vem o tempo sem produção</h4>
      <div id="oee-paradas-bar" style="display:flex;height:18px;border-radius:6px;overflow:hidden;background:var(--border);margin-bottom:14px"></div>
      <div id="oee-paradas-legenda" style="display:flex;flex-wrap:wrap;gap:12px 22px"></div>
      <div id="oee-paradas-vazio" style="display:none;color:var(--text-3);font-size:.84rem;text-align:center;padding:10px 0">Sem tempo planejado no período pra detalhar.</div>
    </div>

    <div class="chart-box" style="margin-bottom:14px">
      <h4>📈 OEE por Turno</h4>
      <div id="oee-chart-turnos"></div>
      <div id="oee-turnos-vazio" style="display:none;color:var(--text-3);font-size:.84rem;text-align:center;padding:20px 0">Sem dados suficientes no período.</div>
    </div>

    <div class="chart-box" style="margin-bottom:14px;overflow-x:auto">
      <h4>Detalhe por Turno</h4>
      <table><thead><tr><th>Data</th><th>Turno</th><th>Operações</th><th>Tempo Produzindo</th><th>Disponibilidade</th><th>Performance</th><th>Qualidade</th><th>OEE</th></tr></thead><tbody id="oee-tabela-turnos"></tbody></table>
    </div>

    <div class="chart-box" style="margin-bottom:14px;overflow-x:auto">
      <h4>Performance e Qualidade por Bateria</h4>
      <table><thead><tr><th>Bateria</th><th>Operações</th><th>Performance</th><th>Traços</th><th>Qualidade</th></tr></thead><tbody id="oee-tabela-bateria"></tbody></table>
    </div>

    <div class="chart-box" style="overflow-x:auto">
      <h4>Performance e Qualidade por Tipo de Montagem</h4>
      <table><thead><tr><th>Tipo de Montagem</th><th>Operações</th><th>Performance</th><th>Traços</th><th>Qualidade</th></tr></thead><tbody id="oee-tabela-montagem"></tbody></table>
    </div>
  </div>
  <div class="rodape">Exportado da Análise de OEE — Lightwall SC · retrato do filtro aplicado no momento da exportação, dados embutidos neste arquivo, funciona offline.</div>

<script>
(function () {
  'use strict';
  const DADOS = ${dadosJson};
  const C = { accent:'#f59e0b', blue:'#3b82f6', green:'#10b981', red:'#ef4444', purple:'#8b5cf6', cyan:'#06b6d4', text2:'#8b93a5', text3:'#5c6475', border:'#353c4a', bg3:'#2e3441' };
  const MINUTOS_TURNO_PLANEJADO = ${MINUTOS_TURNO_PLANEJADO};
  const CICLO_IDEAL_MIN = ${CICLO_IDEAL_MIN};
  const CAMPOS_INSUMO = ${JSON.stringify(CAMPOS_INSUMO)};
  const LW = { escaparHtml: s => { const d=document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; } };

  ${_normalizarInsumo}
  ${_tracoTemAjuste}
  ${_tempoMin}
  ${_minutosParadaNaoPlanejadaNaJanela}
  ${_tempoProduzindoReal}
  ${_agruparPorTurnoInstancia}
  ${calcularDisponibilidade}
  ${calcularPerformance}
  ${calcularQualidade}
  ${calcularPorTurnoInstancia}
  ${calcularPorGrupo}
  ${_resumoParadas}
  ${_setText}
  ${_fmtPct}
  ${_fmtMin}
  ${_corPct}
  ${_renderKPIs}
  ${_renderWaterfall}
  ${_renderBarChartHTML}
  ${_renderTabelaTurnos}
  ${_renderTabelaGrupo}
  ${_renderParadasBreakdown}

  const ALTURA_CHART_TURNOS_PX = ${ALTURA_CHART_TURNOS_PX}, PAD_TOP_CHART_TURNOS_PX = ${PAD_TOP_CHART_TURNOS_PX}, PAD_BOTTOM_CHART_TURNOS_PX = ${PAD_BOTTOM_CHART_TURNOS_PX};

  function render() {
    const historico = DADOS.historico;
    const tracos = DADOS.tracos.map(t => ({ ...t, _baterias: new Set(t._baterias || []) }));
    const paradas = DADOS.paradas;
    const empty = document.getElementById('oee-empty');
    const content = document.getElementById('oee-content');

    if (!historico.length) {
      empty.style.display = 'block';
      content.style.display = 'none';
      return;
    }
    empty.style.display = 'none';
    content.style.display = 'block';

    const disp = calcularDisponibilidade(historico, paradas);
    const perf = calcularPerformance(historico);
    const qual = calcularQualidade(tracos);

    _renderKPIs(disp, perf, qual);
    _renderWaterfall(disp, perf, qual);
    _renderParadasBreakdown(disp, _resumoParadas(paradas));

    const porTurno = calcularPorTurnoInstancia(historico, tracos, paradas);
    const labels = porTurno.map(t => \`\${t.data.slice(5).split('-').reverse().join('/')} \${t.turno.replace(' TURNO', 'T')}\`);
    const elTurnosVazio = document.getElementById('oee-turnos-vazio');
    if (elTurnosVazio) elTurnosVazio.style.display = porTurno.length ? 'none' : 'block';
    _renderBarChartHTML('oee-chart-turnos', labels, porTurno.map(t => t.oeePct));
    _renderTabelaTurnos(porTurno);

    _renderTabelaGrupo('oee-tabela-bateria', calcularPorGrupo(historico, tracos, 'id_bateria'), 'Bateria');
    _renderTabelaGrupo('oee-tabela-montagem', calcularPorGrupo(historico, tracos, 'tipo_montagem'), 'Tipo de Montagem');
  }

  render();
})();
</script>
</body>
</html>`;
  }


  function init() {
    const today = (typeof todayBrasilia === 'function') ? todayBrasilia() : new Date().toISOString().split('T')[0];
    const d30 = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const ini = document.getElementById('oee-data-inicio');
    const fim = document.getElementById('oee-data-fim');
    if (ini && !ini.value) ini.value = d30;
    if (fim && !fim.value) fim.value = today;

    document.getElementById('btn-oee-filtrar')?.addEventListener('click', render);
    document.getElementById('btn-oee-exportar')?.addEventListener('click', exportarInterativo);

    _popularFiltroBateria().then(() => render());
  }

  // Exposto também pra fins de teste/depuração.
  window.LWOee = {
    init, render, exportarInterativo,
    _calcularDisponibilidade: calcularDisponibilidade,
    _calcularPerformance: calcularPerformance,
    _calcularQualidade: calcularQualidade,
    _calcularPorTurnoInstancia: calcularPorTurnoInstancia,
    _calcularPorGrupo: calcularPorGrupo,
    _resumoParadas,
    _tempoProduzindoReal,
    _minutosParadaNaoPlanejadaNaJanela,
  };

})();