// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  oee.js — Análise de OEE (Disponibilidade × Performance × Qualidade)
//
//  Definições combinadas com o usuário:
//  - Disponibilidade: cada turno tem 9h, das quais 1h é descanso e ~1h é
//    lavagem programada (2x 30min) → restam 7h (420 min) de produção
//    planejada por turno. Disponibilidade = tempo real produzindo (soma de
//    tempo_min das operações daquele turno) ÷ 420 min.
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

  function calcularDisponibilidade(historico) {
    const turnos = _agruparPorTurnoInstancia(historico);
    if (!turnos.length) return { pct: 0, turnos: [], tempoTotalProduzindo: 0, tempoPlanejadoTotal: 0, nTurnos: 0 };

    let tempoTotalProduzindo = 0;
    const detalhe = turnos.map(g => {
      const tempoProduzindo = g.ops.reduce((s, r) => s + _tempoMin(r), 0);
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
  function calcularPorTurnoInstancia(historico, tracos) {
    const turnos = _agruparPorTurnoInstancia(historico);
    return turnos.map(g => {
      const perf = calcularPerformance(g.ops);
      const tracosDoTurno = tracos.filter(t => t.data === g.data && t.turno === g.turno);
      const qual = calcularQualidade(tracosDoTurno);
      const tempoProduzindo = g.ops.reduce((s, r) => s + _tempoMin(r), 0);
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
  function calcularPorGrupo(historico, tracos, campo) {
    const grupos = {};
    historico.forEach(r => {
      const chave = r[campo] || '—';
      if (!grupos[chave]) grupos[chave] = { historico: [], tracos: [] };
      grupos[chave].historico.push(r);
    });
    tracos.forEach(t => {
      const chave = t[campo] || '—';
      if (!grupos[chave]) grupos[chave] = { historico: [], tracos: [] };
      grupos[chave].tracos.push(t);
    });

    return Object.entries(grupos).map(([chave, g]) => {
      const perf = calcularPerformance(g.historico);
      const qual = calcularQualidade(g.tracos);
      return {
        chave,
        nOps: g.historico.length,
        nTracos: g.tracos.length,
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

    let tracos = await fetch('db/relatorio_injecao.json').then(r => r.json()).catch(() => []);
    tracos = tracos.filter(t => {
      if (filtros.dataInicio && t.data < filtros.dataInicio) return false;
      if (filtros.dataFim && t.data > filtros.dataFim) return false;
      if (filtros.turno && t.turno !== filtros.turno) return false;
      if (filtros.bateria && t.id_bateria !== filtros.bateria) return false;
      return true;
    });

    // Paradas não têm turno/bateria associados (só início/fim) — filtramos
    // só por data. Usadas apenas pra DETALHAR de onde vem o tempo perdido;
    // não entram na conta de Disponibilidade (ver _resumoParadas).
    let paradas = await fetch('db/paradas.json').then(r => r.ok ? r.json() : []).catch(() => []);
    if (!Array.isArray(paradas)) paradas = [];
    paradas = paradas.filter(p => {
      const data = (p.inicio || '').slice(0, 10);
      if (filtros.dataInicio && data < filtros.dataInicio) return false;
      if (filtros.dataFim && data > filtros.dataFim) return false;
      return true;
    });

    return { historico, tracos, paradas };
  }

  // Soma o tempo de paradas registradas no período, separado por
  // classificação — usado só pra EXIBIR de onde vem o tempo sem produção,
  // sem alterar o cálculo de Disponibilidade (que continua sendo só tempo
  // produzindo ÷ tempo planejado, igual sempre foi).
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

  // ── Render: gráfico de barras (canvas) — OEE por turno-instância ────────
  function _px(canvas) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = (canvas.height || 160) * dpr;
    ctx.scale(dpr, dpr);
    return { ctx, w: rect.width, h: canvas.height / dpr };
  }

  function _drawBarChart(id, labels, values, cor) {
    const canvas = document.getElementById(id);
    if (!canvas) return;
    const { ctx, w, h } = _px(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!labels.length) return;

    const padTop = 14, padBottom = 28, padLeft = 6, padRight = 6;
    const areaH = h - padTop - padBottom;
    const barGap = 6;
    const barW = Math.max(4, (w - padLeft - padRight) / labels.length - barGap);

    labels.forEach((lab, i) => {
      const bruto = values[i];
      const x = padLeft + i * (barW + barGap);

      if (bruto === null || bruto === undefined) {
        // Sem dado (ex: turno sem traço registrado) — barra cinza fina, não
        // "0%" (que pareceria falha total em vez de ausência de dado).
        ctx.fillStyle = C.border;
        ctx.fillRect(x, padTop + areaH - 3, barW, 3);
      } else {
        const v = Math.max(0, Math.min(100, bruto));
        const barH = (v / 100) * areaH;
        const y = padTop + (areaH - barH);
        ctx.fillStyle = v >= 85 ? C.green : v >= 60 ? C.accent : C.red;
        ctx.fillRect(x, y, barW, barH);
      }

      ctx.fillStyle = C.text3;
      ctx.font = '9px sans-serif';
      ctx.textAlign = 'center';
      if (labels.length <= 20) {
        ctx.save();
        ctx.translate(x + barW / 2, h - padBottom + 10);
        ctx.rotate(-Math.PI / 5);
        ctx.textAlign = 'right';
        ctx.fillText(lab, 0, 0);
        ctx.restore();
      }
    });

    // Linha de referência em 85% (meta comum de OEE "classe mundial" é ~85%)
    const yRef = padTop + (areaH - (85 / 100) * areaH);
    ctx.strokeStyle = C.border;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padLeft, yRef);
    ctx.lineTo(w - padRight, yRef);
    ctx.stroke();
    ctx.setLineDash([]);
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
        <td>${l.chave}</td>
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
      return `<div style="height:100%;width:${pct}%;background:${s.cor}" title="${s.label}: ${_fmtMin(s.min)} (${_fmtPct(pct)})"></div>`;
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

    const disp = calcularDisponibilidade(historico);
    const perf = calcularPerformance(historico);
    const qual = calcularQualidade(tracos);

    _renderKPIs(disp, perf, qual);
    _renderWaterfall(disp, perf, qual);
    _renderParadasBreakdown(disp, _resumoParadas(paradas));

    const porTurno = calcularPorTurnoInstancia(historico, tracos);
    const labels = porTurno.map(t => `${t.data.slice(5).split('-').reverse().join('/')} ${t.turno.replace(' TURNO', 'ºT').replace('º TURNO', 'ºT')}`);
    requestAnimationFrame(() => _drawBarChart('oee-chart-turnos', labels, porTurno.map(t => t.oeePct), C.accent));
    _renderTabelaTurnos(porTurno);

    _renderTabelaGrupo('oee-tabela-bateria', calcularPorGrupo(historico, tracos, 'id_bateria'), 'Bateria');
    _renderTabelaGrupo('oee-tabela-montagem', calcularPorGrupo(historico, tracos, 'tipo_montagem'), 'Tipo de Montagem');
  }

  function init() {
    const today = (typeof todayBrasilia === 'function') ? todayBrasilia() : new Date().toISOString().split('T')[0];
    const d30 = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    const ini = document.getElementById('oee-data-inicio');
    const fim = document.getElementById('oee-data-fim');
    if (ini && !ini.value) ini.value = d30;
    if (fim && !fim.value) fim.value = today;

    document.getElementById('btn-oee-filtrar')?.addEventListener('click', render);

    _popularFiltroBateria().then(() => render());
  }

  // Exposto também pra fins de teste/depuração.
  window.LWOee = {
    init, render,
    _calcularDisponibilidade: calcularDisponibilidade,
    _calcularPerformance: calcularPerformance,
    _calcularQualidade: calcularQualidade,
    _calcularPorTurnoInstancia: calcularPorTurnoInstancia,
    _calcularPorGrupo: calcularPorGrupo,
    _resumoParadas,
  };

})();