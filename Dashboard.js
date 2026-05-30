// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  dashboard.js — Dashboard Geral + Desempenho por Turnos
// ============================================================

'use strict';

(function () {

  // ---- Simple bar chart (pure canvas) ----
  function drawBarChart(canvasId, labels, values, color = '#f59e0b') {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.offsetWidth;
    const H = canvas.height = 200;

    ctx.clearRect(0, 0, W, H);

    const max = Math.max(...values, 1);
    const pad = { top: 20, right: 16, bottom: 30, left: 36 };
    const bw = Math.max(4, (W - pad.left - pad.right) / labels.length - 4);
    const chartW = W - pad.left - pad.right;
    const chartH = H - pad.top - pad.bottom;

    // Grid lines
    ctx.strokeStyle = '#2a2f3a';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + chartH * (1 - i / 4);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(W - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = '#5c6475';
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(max * i / 4), pad.left - 4, y + 4);
    }

    labels.forEach((label, i) => {
      const x = pad.left + i * (chartW / labels.length) + (chartW / labels.length - bw) / 2;
      const barH = (values[i] / max) * chartH;
      const y = pad.top + chartH - barH;

      // Bar
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      const radius = 3;
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + bw - radius, y);
      ctx.quadraticCurveTo(x + bw, y, x + bw, y + radius);
      ctx.lineTo(x + bw, y + barH);
      ctx.lineTo(x, y + barH);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;

      // Label
      ctx.fillStyle = '#5c6475';
      ctx.font = '9px Barlow, sans-serif';
      ctx.textAlign = 'center';
      const lx = x + bw / 2;
      // Show only every Nth label to avoid crowding
      const step = Math.max(1, Math.floor(labels.length / 10));
      if (i % step === 0) ctx.fillText(label, lx, H - 6);
    });
  }

  function drawDonutChart(canvasId, segments, colors) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = 120;
    canvas.width = size;
    canvas.height = size;
    const cx = size / 2, cy = size / 2, r = 46, inner = 28;

    const total = segments.reduce((s, v) => s + v, 0);
    if (!total) return;

    let angle = -Math.PI / 2;
    segments.forEach((v, i) => {
      const slice = (v / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angle, angle + slice);
      ctx.closePath();
      ctx.fillStyle = colors[i];
      ctx.fill();
      angle += slice;
    });

    // Center hole
    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx.fillStyle = '#1e2229';
    ctx.fill();
  }

  // ---- Dashboard Geral ----

  function initDashboard() {
    const today = new Date().toISOString().split('T')[0];
    const d30 = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    document.getElementById('dash-data-inicio').value = d30;
    document.getElementById('dash-data-fim').value    = today;

    document.getElementById('btn-dash-filtrar').addEventListener('click', renderDashboard);
    renderDashboard();
  }

  function renderDashboard() {
    const inicio = document.getElementById('dash-data-inicio').value;
    const fim    = document.getElementById('dash-data-fim').value;
    const s      = LW.getStats({ dataInicio: inicio, dataFim: fim });

    // KPIs
    document.getElementById('kpi-total-baterias').textContent = s.total_baterias;
    document.getElementById('kpi-total-paineis').textContent  = s.total_paineis.toLocaleString('pt-BR');
    document.getElementById('kpi-total-m2').textContent       = s.total_m2.toFixed(0) + ' m²';
    document.getElementById('kpi-pct-atraso').textContent     = s.pct_atraso + '%';
    document.getElementById('kpi-tempo-medio').textContent    = LW.formatDuration(s.media_tempo);
    document.getElementById('kpi-media-tracos').textContent   = s.media_tracos.toFixed(1);
    document.getElementById('kpi-dias-prod').textContent      = s.dias_producao;
    document.getElementById('kpi-paineis-2p').textContent     = s.total_paineis_2p.toLocaleString('pt-BR');
    document.getElementById('kpi-paineis-sp').textContent     = s.total_paineis_sp.toLocaleString('pt-BR');

    // Chart — baterias por dia (last 30 entries of por_data)
    const sortedDates = Object.keys(s.por_data).sort();
    const chartLabels = sortedDates.map(d => {
      const [y, m, dy] = d.split('-');
      return `${dy}/${m}`;
    });
    const chartVals   = sortedDates.map(d => s.por_data[d].qtd);
    const chartAtraso = sortedDates.map(d => s.por_data[d].atraso);

    requestAnimationFrame(() => {
      drawBarChart('chart-baterias', chartLabels, chartVals, '#f59e0b');
      drawBarChart('chart-atrasos',  chartLabels, chartAtraso, '#ef4444');

      // Donut tipos
      const total_h = s.data.filter(b => b.tipo_montagem === 'HÍBRIDA').length;
      const total_2p= s.data.filter(b => b.tipo_montagem === '2/P').length;
      const total_sp= s.data.filter(b => b.tipo_montagem === 'S/P').length;
      drawDonutChart('chart-tipos', [total_h, total_2p, total_sp], ['#f59e0b', '#3b82f6', '#10b981']);
      document.getElementById('donut-hibrida').textContent = total_h;
      document.getElementById('donut-2p').textContent      = total_2p;
      document.getElementById('donut-sp').textContent      = total_sp;
    });

    // Insights
    const insightEl = document.getElementById('dash-insights');
    const insights = generateInsights(s, sortedDates);
    insightEl.innerHTML = insights.map(i =>
      `<div class="insight-item"><span>${i.icon}</span><span>${i.text}</span></div>`
    ).join('');
  }

  function generateInsights(s, sortedDates) {
    const insights = [];

    if (!s.total_baterias) {
      return [{ icon: '📭', text: 'Nenhum dado no período selecionado.' }];
    }

    // Pico de produção
    const maxDia = sortedDates.reduce((best, d) =>
      (s.por_data[d].qtd > (s.por_data[best]?.qtd||0)) ? d : best, sortedDates[0]);
    if (maxDia) {
      const [y,m,dy] = maxDia.split('-');
      insights.push({ icon: '📈', text: `Pico de produção em ${dy}/${m} com ${s.por_data[maxDia].qtd} baterias` });
    }

    // Maior concentração de atrasos
    const maxAtraso = sortedDates.reduce((best, d) =>
      (s.por_data[d].atraso > (s.por_data[best]?.atraso||0)) ? d : best, sortedDates[0]);
    if (maxAtraso && s.por_data[maxAtraso].atraso > 0) {
      const [y,m,dy] = maxAtraso.split('-');
      insights.push({ icon: '🚨', text: `Maior concentração de atrasos em ${dy}/${m} (${s.por_data[maxAtraso].atraso} ocorrências)` });
    }

    // % atraso
    if (s.pct_atraso > 30) {
      insights.push({ icon: '⚠️', text: `Taxa de atraso elevada: ${s.pct_atraso}% das baterias atrasaram` });
    } else {
      insights.push({ icon: '🟢', text: `Atrasos controlados: apenas ${s.pct_atraso}% das baterias` });
    }

    // Produção média por dia
    const mediaDia = s.dias_producao ? (s.total_baterias / s.dias_producao).toFixed(1) : 0;
    insights.push({ icon: '📊', text: `Média de ${mediaDia} baterias por dia de produção` });

    // Tempo médio
    insights.push({ icon: '⏱', text: `Tempo médio de injeção: ${LW.formatDuration(s.media_tempo)}` });

    // Motivo mais frequente
    const motivos = Object.entries(s.motivos).sort((a,b) => b[1]-a[1]);
    if (motivos.length) {
      insights.push({ icon: '🔧', text: `Motivo de atraso mais frequente: "${motivos[0][0]}" (${motivos[0][1]}x)` });
    }

    return insights;
  }

  // ---- Desempenho por Turnos ----

  function initTurnos() {
    const today = new Date().toISOString().split('T')[0];
    const d30 = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
    document.getElementById('turnos-data-inicio').value = d30;
    document.getElementById('turnos-data-fim').value    = today;

    document.getElementById('btn-turnos-filtrar').addEventListener('click', renderTurnos);
    renderTurnos();
  }

  function renderTurnos() {
    const inicio = document.getElementById('turnos-data-inicio').value;
    const fim    = document.getElementById('turnos-data-fim').value;
    const s      = LW.getStats({ dataInicio: inicio, dataFim: fim });

    const turnos = ['1º TURNO', '2º TURNO', '3º TURNO'];
    const ids    = ['t1', 't2', 't3'];

    turnos.forEach((t, i) => {
      const td = s.por_turno[t];
      const id = ids[i];
      document.getElementById(`${id}-baterias`).textContent  = td.total;
      document.getElementById(`${id}-paineis`).textContent   = td.paineis.toLocaleString('pt-BR');
      document.getElementById(`${id}-m2`).textContent        = td.m2.toFixed(0) + ' m²';
      document.getElementById(`${id}-atraso`).textContent    = td.total ? Math.round(td.atraso/td.total*100) + '%' : '—';
      document.getElementById(`${id}-tempo`).textContent     = LW.formatDuration(td.tempo_medio);
      document.getElementById(`${id}-2p`).textContent        = td.paineis_2p.toLocaleString('pt-BR');
      document.getElementById(`${id}-sp`).textContent        = td.paineis_sp.toLocaleString('pt-BR');
    });

    // Turno mais/menos eficiente (por m²)
    const byM2 = turnos.map(t => ({ t, m2: s.por_turno[t].m2 })).filter(x => x.m2 > 0);
    if (byM2.length) {
      byM2.sort((a,b) => b.m2 - a.m2);
      document.getElementById('melhor-turno').textContent = byM2[0].t;
      document.getElementById('pior-turno').textContent   = byM2[byM2.length - 1].t;
    }

    // Bar charts por turno
    requestAnimationFrame(() => {
      drawBarChart('chart-turnos-m2', turnos.map(t => t.replace('º TURNO','')), turnos.map(t => s.por_turno[t].m2), '#3b82f6');
      drawBarChart('chart-turnos-atraso', turnos.map(t => t.replace('º TURNO','')), turnos.map(t => s.por_turno[t].atraso), '#ef4444');
    });

    // Insights turnos
    const el = document.getElementById('turnos-insights');
    const items = [];
    if (byM2.length) {
      items.push({ icon: '🏆', text: `Turno mais produtivo: ${byM2[0].t} com ${byM2[0].m2.toFixed(0)} m²` });
    }
    turnos.forEach(t => {
      const td = s.por_turno[t];
      if (td.total > 0 && td.atraso / td.total > 0.3) {
        items.push({ icon: '⚠️', text: `${t}: alta taxa de atraso (${Math.round(td.atraso/td.total*100)}%)` });
      }
    });
    if (!items.length) {
      items.push({ icon: '✅', text: 'Desempenho equilibrado entre os turnos no período.' });
    }
    el.innerHTML = items.map(i =>
      `<div class="insight-item"><span>${i.icon}</span><span>${i.text}</span></div>`
    ).join('');
  }

  // ---- Registro de Baterias (table) ----

  function initRegistro() {
    document.getElementById('btn-registro-filtrar').addEventListener('click', renderRegistro);
    document.getElementById('reg-busca').addEventListener('input', renderRegistro);
    renderRegistro();
  }

  function renderRegistro() {
    const busca  = document.getElementById('reg-busca').value.toLowerCase();
    const turno  = document.getElementById('reg-turno').value;
    const s      = LW.getStats();
    let data     = s.data;

    if (busca)  data = data.filter(b =>
      b.id_bateria.toLowerCase().includes(busca) ||
      b.data.includes(busca) ||
      (b.motivo_atraso||'').toLowerCase().includes(busca)
    );
    if (turno)  data = data.filter(b => b.turno === turno);

    // Sort by date desc
    data = [...data].sort((a,b) => b.data.localeCompare(a.data) || b.inicio?.localeCompare(a.inicio||''));

    const tbody = document.getElementById('registro-tbody');
    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;color:var(--text-3);padding:30px">Nenhum registro encontrado</td></tr>`;
      return;
    }

    tbody.innerHTML = data.map(b => `
      <tr>
        <td class="mono">${b.data ? b.data.split('-').reverse().join('/') : '—'}</td>
        <td><span class="badge badge-gray">${b.turno||'—'}</span></td>
        <td>${b.id_bateria||'—'}</td>
        <td>${b.dimensao||'—'}</td>
        <td><span class="badge ${b.tipo_montagem==='2/P'?'badge-blue':b.tipo_montagem==='S/P'?'badge-green':'badge-amber'}">${b.tipo_montagem||'—'}</span></td>
        <td class="mono">${b.inicio ? LW.formatTime(b.inicio) : '—'}</td>
        <td class="mono">${b.fim    ? LW.formatTime(b.fim)    : '—'}</td>
        <td class="mono">${LW.formatDuration(b.tempo_min)}</td>
        <td>${b.total_paineis||0}</td>
        <td>${(b.m2_total||0).toFixed(2)}</td>
        <td>${b.qtd_tracos||0}</td>
        <td>
          ${b.houve_atraso === 'SIM'
            ? `<span class="badge badge-red" title="${b.motivo_atraso||''}">⚠ SIM</span>`
            : '<span class="badge badge-green">✓ NÃO</span>'}
        </td>
      </tr>
    `).join('');

    document.getElementById('reg-count').textContent = data.length + ' registros';
  }

  // ---- Export CSV ----

  function exportCSV() {
    const s = LW.getStats();
    const cols = ['data','turno','id_bateria','dimensao','tipo_montagem','inicio','fim',
      'tempo_min','qtd_tracos','houve_atraso','motivo_atraso',
      'total_paineis','paineis_2p','paineis_sp','m2_total','m2_2p','m2_sp'];
    const header = cols.join(';');
    const rows = s.data.map(b =>
      cols.map(c => {
        const v = b[c];
        if (c === 'inicio' || c === 'fim') return v ? LW.formatTime(v) : '';
        return v !== undefined && v !== null ? String(v).replace(/;/g, ',') : '';
      }).join(';')
    );
    const csv = '\uFEFF' + [header, ...rows].join('\n'); // BOM for Excel
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = 'lightwall_injecao_' + new Date().toISOString().split('T')[0] + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Public ----
  window.LWDash = { initDashboard, initTurnos, initRegistro, exportCSV };

})();