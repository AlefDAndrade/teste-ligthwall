// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  analise-operacional.js — Análise Operacional Avançada
// ============================================================
'use strict';

(function () {

  // ── Paleta interna ──────────────────────────────────────────
  const C = {
    accent:  '#f59e0b',
    blue:    '#3b82f6',
    green:   '#10b981',
    red:     '#ef4444',
    purple:  '#8b5cf6',
    cyan:    '#06b6d4',
    orange:  '#f97316',
    bg:      '#1e2229',
    bg2:     '#272c35',
    bg3:     '#2e3441',
    border:  '#353c4a',
    text:    '#e8eaf0',
    text2:   '#8b93a5',
    text3:   '#5c6475',
  };

  // ── Normalização de motivos de atraso ─────────────────────
  function normalizarMotivo(m) {
    if (!m) return null;
    const s = m.toLowerCase().trim();
    if (s.includes('entupimento') || s.includes('bico') || s.includes('mangueira')) return 'Entupimento';
    if (s.includes('lavagem')) return 'Lavagem';
    if (s.includes('reinjeção') || s.includes('reinjec') || s.includes('vazamento') || s.includes('vasamento')) return 'Vazamento / Reinjeção';
    if (s.includes('hidraulico') || s.includes('hidráulico')) return 'Problema Hidráulico';
    if (s.includes('traço') || s.includes('traco') || s.includes('ajuste')) return 'Ajuste de Traço';
    if (s.includes('eps') || s.includes('expansão') || s.includes('expansao') || s.includes('pessagem')) return 'Problema EPS';
    if (s.includes('erro') || s.includes('operacion')) return 'Erro Operacional';
    return m.length > 30 ? m.slice(0, 30) + '…' : m;
  }

  // ── Cálculo de tempo em minutos ───────────────────────────
  function tempoMin(rec) {
    if (rec.tempo_min && rec.tempo_min > 0) return rec.tempo_min;
    if (rec.inicio && rec.fim) {
      const t = (new Date(rec.fim) - new Date(rec.inicio)) / 60000;
      return t > 0 ? t : 0;
    }
    return 0;
  }

  // ── Filtro de dados ───────────────────────────────────────
  function filtrar(dados, ini, fim) {
    return dados.filter(r => {
      if (!r.data) return false;
      if (ini && r.data < ini) return false;
      if (fim && r.data > fim) return false;
      return true;
    });
  }

  // ── Motor principal de KPIs ───────────────────────────────
  function calcularKPIs(dados) {
    const n = dados.length;
    // Sem early-return em dataset vazio: mesmo padrão do CEP, que sempre
    // renderiza o dashboard (zerado) em vez de escondê-lo quando o período
    // selecionado não tem registros. Todas as contas abaixo já são seguras
    // com arrays vazios — só a divisão por `n` precisa de guarda explícita.

    const totalM2     = dados.reduce((s,r) => s + (r.m2_total||0), 0);
    // total_paineis já soma TODOS os tipos de placa (2p, sp, 3t, 4t, ...) — não
    // usar paineis_2p+paineis_sp aqui, ou tipos novos ficam de fora da conta.
    const totalPaineis= dados.reduce((s,r) => s + (r.total_paineis||0), 0);
    const comAtraso   = dados.filter(r => r.houve_atraso === 'SIM');
    const taxaAtraso  = n ? (comAtraso.length / n) * 100 : 0;

    // Tempo médio geral
    const tempos = dados.map(tempoMin).filter(t => t > 0);
    const tempoMedio = tempos.length ? tempos.reduce((a,b)=>a+b,0)/tempos.length : 0;

    // Horas perdidas: tempo excedente acima de 59min
    const LIMITE = 59;
    const horasPerdidas = comAtraso.reduce((s,r) => {
      const t = tempoMin(r);
      return s + Math.max(0, t - LIMITE);
    }, 0) / 60;

    // Eficiência: (ops sem atraso / total) * ajuste por tempo médio
    // Referência: operação ideal = 45 min
    const tempoIdeal = 45;
    const eficienciaTempo = tempos.length ? Math.min(100, (tempoIdeal / tempoMedio) * 100) : 100;
    const eficienciaAtraso = 100 - taxaAtraso;
    const eficienciaGeral = (eficienciaAtraso * 0.6 + eficienciaTempo * 0.4);

    // Por bateria
    const porBateria = {};
    dados.forEach(r => {
      if (!porBateria[r.id_bateria]) porBateria[r.id_bateria] = [];
      porBateria[r.id_bateria].push(r);
    });

    const rankBaterias = Object.entries(porBateria).map(([bat, ops]) => {
      const atrasos = ops.filter(o => o.houve_atraso === 'SIM');
      const ts = ops.map(tempoMin).filter(t => t > 0);
      const tm = ts.length ? ts.reduce((a,b)=>a+b,0)/ts.length : 0;
      const hp = atrasos.reduce((s,r) => s + Math.max(0, tempoMin(r) - LIMITE), 0) / 60;
      return {
        bat,
        ops: ops.length,
        atrasos: atrasos.length,
        pctAtraso: (atrasos.length / ops.length) * 100,
        tempoMedio: tm,
        horasPerdidas: hp,
        m2: ops.reduce((s,r)=>s+(r.m2_total||0),0),
        eficiencia: Math.max(0, 100 - (atrasos.length/ops.length)*100 - Math.max(0,tm-tempoIdeal)/tempoIdeal*30),
      };
    }).sort((a,b) => b.eficiencia - a.eficiencia);

    const melhorBateria = rankBaterias[0];
    const piorBateria   = rankBaterias[rankBaterias.length - 1];

    // Por motivo
    const porMotivo = {};
    comAtraso.forEach(r => {
      const m = normalizarMotivo(r.motivo_atraso) || 'Outros';
      if (!porMotivo[m]) porMotivo[m] = [];
      porMotivo[m].push(r);
    });
    const rankMotivos = Object.entries(porMotivo).map(([mot, ops]) => ({
      motivo: mot,
      qtd: ops.length,
      pct: (ops.length / comAtraso.length) * 100,
    })).sort((a,b) => b.qtd - a.qtd);

    // Correlações
    const corMontagem = {};
    dados.forEach(r => {
      const m = r.tipo_montagem;
      if (!corMontagem[m]) corMontagem[m] = {total:0, atrasos:0};
      corMontagem[m].total++;
      if (r.houve_atraso === 'SIM') corMontagem[m].atrasos++;
    });

    const corDimensao = {};
    dados.forEach(r => {
      const d = r.dimensao;
      if (!corDimensao[d]) corDimensao[d] = {tempos:[], atrasos:0, total:0};
      const t = tempoMin(r);
      if (t > 0) corDimensao[d].tempos.push(t);
      if (r.houve_atraso === 'SIM') corDimensao[d].atrasos++;
      corDimensao[d].total++;
    });

    // Tendência semanal
    const porSemana = {};
    dados.forEach(r => {
      const w = r.data.slice(0,7); // mes-semana proxy → use mês
      if (!porSemana[w]) porSemana[w] = {total:0,atrasos:0,tempos:[]};
      porSemana[w].total++;
      if (r.houve_atraso === 'SIM') porSemana[w].atrasos++;
      const t = tempoMin(r);
      if (t > 0) porSemana[w].tempos.push(t);
    });
    const semanas = Object.entries(porSemana).sort((a,b)=>a[0]<b[0]?-1:1);
    const trendLabels = semanas.map(([k]) => {
      const d = new Date(k + '-01T12:00:00Z');
      return d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit', timeZone: 'UTC' });
    });
    const trendAtraso  = semanas.map(([,v]) => v.total ? (v.atrasos/v.total)*100 : 0);
    const trendTempo   = semanas.map(([,v]) => v.tempos.length ? v.tempos.reduce((a,b)=>a+b,0)/v.tempos.length : 0);

    // Detecção de tendência (últimas 3 semanas vs anteriores)
    const half = Math.floor(trendAtraso.length / 2);
    const mediaAnterior = trendAtraso.slice(0, half).reduce((a,b)=>a+b,0)/(half||1);
    const mediaRecente  = trendAtraso.slice(half).reduce((a,b)=>a+b,0)/(trendAtraso.length-half||1);
    const tendenciaAtraso = mediaRecente - mediaAnterior; // positivo = piora

    // Baterias com tendência de piora (compara 1a metade vs 2a metade de ops por data)
    const bateriasPiora = rankBaterias.filter(bat => {
      const ops = porBateria[bat.bat].sort((a,b)=>a.data<b.data?-1:1);
      const h = Math.floor(ops.length/2);
      if (h < 1) return false;
      const p1 = ops.slice(0,h).filter(o=>o.houve_atraso==='SIM').length/h;
      const p2 = ops.slice(h).filter(o=>o.houve_atraso==='SIM').length/(ops.length-h);
      return p2 > p1 + 0.1;
    });

    return {
      n, totalM2, totalPaineis,
      comAtraso: comAtraso.length,
      taxaAtraso, tempoMedio, horasPerdidas,
      eficienciaGeral,
      melhorBateria, piorBateria,
      rankBaterias, rankMotivos,
      corMontagem, corDimensao,
      trendLabels, trendAtraso, trendTempo,
      tendenciaAtraso, bateriasPiora,
      porBateria,
    };
  }

  // ── Geração de insights automáticos ───────────────────────
  function gerarInsights(kpi, dados) {
    const insights = [];
    const {rankBaterias, rankMotivos, taxaAtraso, tempoMedio,
           melhorBateria, piorBateria, tendenciaAtraso,
           bateriasPiora, eficienciaGeral, horasPerdidas,
           corMontagem, corDimensao, n} = kpi;

    // Sem registros no período: não há base para nenhum insight (evita, por
    // exemplo, acusar "excelente eficiência" de um período sem nenhuma
    // operação). A UI já mostra a mensagem padrão de "nenhum insight" nesse caso.
    if (!n) return insights;

    const mediaAtraso = taxaAtraso;

    // 1. Baterias com atraso acima da média
    rankBaterias.filter(b => b.pctAtraso > mediaAtraso * 1.5 && b.atrasos > 0).slice(0,3).forEach(b => {
      const mult = mediaAtraso > 0 ? (b.pctAtraso/mediaAtraso).toFixed(1) : '∞';
      insights.push({
        tipo: 'danger',
        icon: '🔴',
        texto: `A bateria <strong>${LW.escaparHtml(b.bat)}</strong> tem ${mult}× mais atrasos que a média (${b.pctAtraso.toFixed(0)}% vs ${mediaAtraso.toFixed(0)}% geral).`
      });
    });

    // 2. Motivo dominante
    if (rankMotivos.length > 0) {
      const top = rankMotivos[0];
      insights.push({
        tipo: top.pct > 40 ? 'danger' : 'warning',
        icon: '⚠️',
        texto: `O motivo <strong>${LW.escaparHtml(top.motivo)}</strong> representa <strong>${top.pct.toFixed(0)}%</strong> de todos os atrasos (${top.qtd} ocorrências).`
      });
    }

    // 3. Tendência de atraso
    if (tendenciaAtraso > 5) {
      insights.push({
        tipo: 'danger',
        icon: '📈',
        texto: `Taxa de atrasos aumentou <strong>${tendenciaAtraso.toFixed(1)} p.p.</strong> no período mais recente — tendência de piora.`
      });
    } else if (tendenciaAtraso < -5) {
      insights.push({
        tipo: 'success',
        icon: '📉',
        texto: `Taxa de atrasos reduziu <strong>${Math.abs(tendenciaAtraso).toFixed(1)} p.p.</strong> no período mais recente — tendência de melhora.`
      });
    }

    // 4. Baterias com tendência de piora
    bateriasPiora.slice(0,2).forEach(b => {
      insights.push({
        tipo: 'warning',
        icon: '⚡',
        texto: `Bateria <strong>${LW.escaparHtml(b.bat)}</strong> apresenta tendência de piora — atrasos crescendo nas operações mais recentes.`
      });
    });

    // 5. Eficiência geral
    if (eficienciaGeral < 70) {
      insights.push({
        tipo: 'danger',
        icon: '📊',
        texto: `Eficiência operacional em <strong>${eficienciaGeral.toFixed(0)}%</strong> — abaixo do patamar ideal (≥85%).`
      });
    } else if (eficienciaGeral >= 90) {
      insights.push({
        tipo: 'success',
        icon: '🏆',
        texto: `Excelente eficiência operacional: <strong>${eficienciaGeral.toFixed(0)}%</strong> — acima da meta de 90%.`
      });
    }

    // 6. Horas perdidas
    if (horasPerdidas > 5) {
      insights.push({
        tipo: 'warning',
        icon: '⏱',
        texto: `Período acumulou <strong>${horasPerdidas.toFixed(1)} horas perdidas</strong> por atrasos — impacto direto na capacidade produtiva.`
      });
    }

    // 7. Correlação montagem x atraso
    const montagensArr = Object.entries(corMontagem).map(([m,v]) => ({
      m, pct: v.total ? (v.atrasos/v.total)*100 : 0, total: v.total
    })).filter(x => x.total >= 3).sort((a,b) => b.pct - a.pct);
    if (montagensArr.length >= 2) {
      const worst = montagensArr[0];
      const best  = montagensArr[montagensArr.length-1];
      if (worst.pct > best.pct + 10) {
        insights.push({
          tipo: 'info',
          icon: '🔩',
          texto: `Montagem <strong>${LW.escaparHtml(worst.m)}</strong> tem ${worst.pct.toFixed(0)}% de atrasos vs ${best.pct.toFixed(0)}% em <strong>${LW.escaparHtml(best.m)}</strong> — diferença expressiva.`
        });
      }
    }

    // 8. Dimensão com maior tempo médio
    const dimsArr = Object.entries(corDimensao).map(([d,v]) => ({
      d,
      tm: v.tempos.length ? v.tempos.reduce((a,b)=>a+b,0)/v.tempos.length : 0,
      pct: v.total ? (v.atrasos/v.total)*100 : 0
    })).filter(x => x.tm > 0).sort((a,b) => b.tm - a.tm);
    if (dimsArr.length >= 2) {
      const td = dimsArr[0];
      insights.push({
        tipo: 'info',
        icon: '📐',
        texto: `Painéis de <strong>${LW.escaparHtml(td.d)}</strong> têm o maior tempo médio de ciclo: <strong>${td.tm.toFixed(0)} min</strong> por operação.`
      });
    }

    // 9. Melhor/pior bateria
    if (melhorBateria && piorBateria && melhorBateria.bat !== piorBateria.bat) {
      insights.push({
        tipo: 'success',
        icon: '🥇',
        texto: `<strong>${LW.escaparHtml(melhorBateria.bat)}</strong> é a bateria mais eficiente do período (${melhorBateria.eficiencia.toFixed(0)}% eficiência, ${melhorBateria.pctAtraso.toFixed(0)}% atrasos).`
      });
    }

    return insights.slice(0, 10);
  }

  // ── Canvas helpers ─────────────────────────────────────────
  function px(canvas) {
    return window.devicePixelRatio || 1;
  }

  function setupCanvas(id, h) {
    const el = document.getElementById(id);
    if (!el) return null;
    const ctx = el.getContext('2d');
    const ratio = px();
    el.style.width  = '100%';
    el.style.height = h + 'px';
    el.width  = el.offsetWidth * ratio;
    el.height = h * ratio;
    ctx.scale(ratio, ratio);
    return {ctx, w: el.offsetWidth, h};
  }

  // Gráfico de barras coloridas
  // formatarTooltip(valor, label, idx) -> texto do hover/toque; se omitido,
  // usa "label: valor" genérico. Ver LW.tooltip.ligarHoverCanvas (js/tooltip.js).
  function drawBar(id, labels, values, colors, h = 180, showValues = true, formatarTooltip = null) {
    const c = setupCanvas(id, h);
    if (!c) return;
    const {ctx, w} = c;
    const canvasEl = document.getElementById(id);
    const pad = {top:24, right:12, bottom:32, left:42};
    const cw = w - pad.left - pad.right;
    const ch = c.h - pad.top - pad.bottom;
    const max = Math.max(...values, 1);
    const areas = []; // hover/toque — 1 retângulo de detecção por barra (coluna inteira, não só a parte preenchida)

    // grid
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + ch*(1-i/4);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w-pad.right, y); ctx.stroke();
      ctx.fillStyle = C.text3; ctx.font = '10px JetBrains Mono,monospace';
      ctx.textAlign = 'right';
      const v = max*i/4;
      ctx.fillText(v >= 100 ? Math.round(v) : v.toFixed(1), pad.left-4, y+3);
    }

    const bw = Math.max(8, cw/labels.length - 5);
    labels.forEach((lbl, i) => {
      const x = pad.left + i*(cw/labels.length) + (cw/labels.length - bw)/2;
      const bh = (values[i]/max)*ch;
      const y  = pad.top + ch - bh;
      const colDescritor = Array.isArray(colors) ? colors[i] : colors;

      // Tipo híbrido: metade de cada cor componente, lado a lado — canvas não
      // entende a string CSS linear-gradient(), então monta o gradiente real
      // aqui mesmo, já com os limites (x, x+bw) desta barra específica.
      let col;
      if (colDescritor && typeof colDescritor === 'object' && colDescritor.hibrida) {
        const grad = ctx.createLinearGradient(x, 0, x + bw, 0);
        grad.addColorStop(0, colDescritor.cor1);
        grad.addColorStop(0.5, colDescritor.cor1);
        grad.addColorStop(0.5, colDescritor.cor2);
        grad.addColorStop(1, colDescritor.cor2);
        col = grad;
      } else {
        col = colDescritor;
      }

      // barra
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.9;
      const r = 3;
      ctx.beginPath();
      ctx.moveTo(x+r, y); ctx.lineTo(x+bw-r, y);
      ctx.quadraticCurveTo(x+bw, y, x+bw, y+r);
      ctx.lineTo(x+bw, y+bh); ctx.lineTo(x, y+bh);
      ctx.lineTo(x, y+r); ctx.quadraticCurveTo(x, y, x+r, y);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;

      // valor no topo
      if (showValues && values[i] > 0) {
        ctx.fillStyle = C.text2; ctx.font = 'bold 10px JetBrains Mono,monospace';
        ctx.textAlign = 'center';
        ctx.fillText(values[i] >= 100 ? Math.round(values[i]) : values[i].toFixed(1), x+bw/2, y-4);
      }

      // label
      const step = Math.max(1, Math.floor(labels.length/8));
      if (i % step === 0) {
        ctx.fillStyle = C.text3; ctx.font = '9px Barlow,sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(lbl, x+bw/2, c.h-8);
      }

      // Área de detecção do hover/toque: a coluna inteira (topo do gráfico
      // até a base), não só o retângulo preenchido — mais fácil de acertar
      // em barras pequenas/valor baixo, e cobre também o texto do label que
      // por vezes é omitido (step acima) — o hover sempre revela qual é.
      areas.push({
        x, w: bw, y: pad.top, yBase: pad.top + ch,
        texto: formatarTooltip ? formatarTooltip(values[i], lbl, i) : `${lbl}: ${values[i] >= 100 ? Math.round(values[i]) : values[i].toFixed(1)}`,
      });
    });

    canvasEl._areasHoverAO = areas;
    LW.tooltip.ligarHoverCanvas(canvasEl, (x, y) => {
      const a = (canvasEl._areasHoverAO || []).find(a => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.yBase);
      return a ? a.texto : null;
    });
  }

  // Gráfico de linha dupla
  // montarTooltip(idx, label) -> texto do hover/toque; recebe o ÍNDICE (não
  // o valor já escalado pra caber no mesmo gráfico — ver renderTendencias,
  // que passa trendTempo/2 só pra desenho, mas quer mostrar o valor real
  // no hover). Se omitido, usa os valores de data1/data2 direto.
  function drawDualLine(id, labels, data1, data2, col1, col2, label1, label2, h = 180, montarTooltip = null) {
    const c = setupCanvas(id, h);
    if (!c) return;
    const {ctx, w} = c;
    const canvasEl = document.getElementById(id);
    const pad = {top:30, right:12, bottom:32, left:42};
    const cw = w - pad.left - pad.right;
    const ch = c.h - pad.top - pad.bottom;
    const maxV = Math.max(...data1, ...data2, 1);

    // grid
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + ch*(1-i/4);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w-pad.right, y); ctx.stroke();
      ctx.fillStyle = C.text3; ctx.font = '10px JetBrains Mono,monospace';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(maxV*i/4), pad.left-4, y+3);
    }

    function drawLine(data, col) {
      if (!data.length) return;
      const step = cw/(data.length-1||1);
      ctx.strokeStyle = col; ctx.lineWidth = 2.5;
      ctx.shadowColor = col; ctx.shadowBlur = 6;
      ctx.beginPath();
      data.forEach((v,i) => {
        const x = pad.left + i*step;
        const y = pad.top + ch*(1-v/maxV);
        i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;

      // dots
      data.forEach((v,i) => {
        const x = pad.left + i*step;
        const y = pad.top + ch*(1-v/maxV);
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fill();
      });
    }

    drawLine(data1, col1);
    drawLine(data2, col2);

    // legend
    ctx.shadowBlur = 0;
    [[col1, label1],[col2, label2]].forEach(([col, lbl], i) => {
      const lx = pad.left + i*130;
      ctx.fillStyle = col;
      ctx.fillRect(lx, 8, 14, 3);
      ctx.fillStyle = C.text2; ctx.font = '10px Barlow,sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(lbl, lx+18, 13);
    });

    // x labels
    const step2 = Math.max(1, Math.floor(labels.length/6));
    labels.forEach((lbl, i) => {
      if (i % step2 !== 0) return;
      const x = pad.left + i*(cw/(labels.length-1||1));
      ctx.fillStyle = C.text3; ctx.font = '9px Barlow,sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(lbl, x, c.h-6);
    });

    // Pontos de hover/toque — 1 por posição no eixo X (cobre os meses cujo
    // label foi omitido acima por falta de espaço — o hover sempre revela
    // qual é), texto com os 2 valores daquele mês.
    const stepX = cw/(labels.length-1||1);
    const pontos = labels.map((lbl, i) => ({
      x: pad.left + i*stepX,
      texto: montarTooltip ? montarTooltip(i, lbl) : `${lbl}\n${label1}: ${data1[i]}\n${label2}: ${data2[i]}`,
    }));
    canvasEl._pontosHoverAO = pontos;
    LW.tooltip.ligarHoverCanvas(canvasEl, (x) => {
      let melhor = null, melhorDist = 22; // raio de detecção em px, só no eixo X
      (canvasEl._pontosHoverAO || []).forEach(p => {
        const d = Math.abs(x - p.x);
        if (d < melhorDist) { melhorDist = d; melhor = p; }
      });
      return melhor ? melhor.texto : null;
    });
  }

  // Gráfico de barras horizontais
  function drawHorizBar(containerId, items, maxVal) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = items.map(item => {
      const pct = maxVal > 0 ? (item.value/maxVal)*100 : 0;
      const barColor = item.color || C.accent;
      return `
        <div style="margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:.82rem;color:${C.text};font-weight:600">${LW.escaparHtml(item.label)}</span>
            <span style="font-size:.82rem;color:${barColor};font-family:'JetBrains Mono',monospace;font-weight:700">${item.display}</span>
          </div>
          <div style="background:${C.bg3};border-radius:4px;height:8px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:${barColor};border-radius:4px;transition:width .6s cubic-bezier(.4,0,.2,1)"></div>
          </div>
          ${item.sub ? `<div style="font-size:.74rem;color:${C.text3};margin-top:2px">${LW.escaparHtml(item.sub)}</div>` : ''}
        </div>`;
    }).join('');
  }

  // ── Renderização principal ─────────────────────────────────
  async function render() {
    // Busca historico.json sempre fresco — diferente de uma versão anterior
    // deste código, que guardava o resultado em LW.historico e nunca
    // buscava de novo na mesma sessão (mesmo trocando os filtros de data ou
    // saindo/voltando pra esta tela). Isso fazia a página continuar
    // mostrando dados desatualizados depois de qualquer operação registrada
    // ou editada após a primeira visita. Todas as outras telas (Registro de
    // Baterias, Relatório de Injeção, CEP) já buscavam fresco a cada visita
    // — este módulo só foi alinhado ao mesmo padrão.
    let dados = [];
    try {
      const res = await fetch('db/historico.json');
      if (res.ok) dados = await res.json();
    } catch (err) {
      console.error("Erro ao carregar historico.json:", err);
    }

    if (!dados.length) {
      document.getElementById('ao-loading').style.display = 'block';
      return;
    }
    document.getElementById('ao-loading').style.display = 'none';

    const ini = document.getElementById('ao-data-inicio')?.value || '';
    const fim = document.getElementById('ao-data-fim')?.value || '';
    const filtrado = filtrar(dados, ini, fim);

    // Mesmo padrão do CEP: sempre mostra o dashboard, mesmo sem nenhum
    // registro no período selecionado (nesse caso, tudo aparece zerado em
    // vez do dashboard inteiro ser escondido).
    document.getElementById('ao-empty').style.display = 'none';
    document.getElementById('ao-content').style.display = 'block';

    const kpi = calcularKPIs(filtrado);

    renderKPIs(kpi, filtrado);
    renderInsights(kpi, filtrado);
    renderRankBaterias(kpi);
    renderRankMotivos(kpi);
    renderCorrelacoes(kpi, filtrado);
    renderTendencias(kpi);
    renderProdutividade(kpi, filtrado);
  }

  function fmt(n, dec=1) { return n.toLocaleString('pt-BR',{minimumFractionDigits:dec,maximumFractionDigits:dec}); }
  function fmtMin(m) {
    const h = Math.floor(m/60);
    const min = Math.round(m%60);
    return h > 0 ? `${h}h ${min}min` : `${min}min`;
  }

  // ── KPIs ──────────────────────────────────────────────────
  function renderKPIs(kpi, dados) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.innerHTML = val; };

    set('ao-kpi-m2',         fmt(kpi.totalM2, 0) + '<span style="font-size:.9rem"> m²</span>');
    set('ao-kpi-paineis',    kpi.totalPaineis.toLocaleString('pt-BR'));
    set('ao-kpi-baterias',   kpi.n.toLocaleString('pt-BR'));
    set('ao-kpi-ciclo',      fmtMin(kpi.tempoMedio));
    set('ao-kpi-atraso-pct', fmt(kpi.taxaAtraso, 1) + '<span style="font-size:.9rem">%</span>');
    set('ao-kpi-horas-perd', fmt(kpi.horasPerdidas, 1) + '<span style="font-size:.9rem"> h</span>');
    set('ao-kpi-eficiencia', fmt(kpi.eficienciaGeral, 0) + '<span style="font-size:.9rem">%</span>');
    set('ao-kpi-melhor-bat', kpi.melhorBateria ? kpi.melhorBateria.bat : '—');
    set('ao-kpi-pior-bat',   kpi.piorBateria   ? kpi.piorBateria.bat   : '—');

    // Tempo médio por bateria: mostra a média ponderada
    const tmBat = kpi.rankBaterias.length
      ? kpi.rankBaterias.reduce((s,b)=>s+b.tempoMedio*b.ops,0) / kpi.rankBaterias.reduce((s,b)=>s+b.ops,0)
      : 0;
    set('ao-kpi-tempo-bat', fmtMin(tmBat));

    // Barra de eficiência
    const ef = document.getElementById('ao-eficiencia-bar');
    if (ef) {
      const pct = Math.min(100, kpi.eficienciaGeral);
      const col = pct >= 85 ? C.green : pct >= 70 ? C.accent : C.red;
      ef.style.width = pct + '%';
      ef.style.background = `linear-gradient(90deg, ${col}, ${col}cc)`;
    }
  }

  // ── Insights ──────────────────────────────────────────────
  function renderInsights(kpi, dados) {
    const insights = gerarInsights(kpi, dados);
    const el = document.getElementById('ao-insights');
    if (!el) return;

    const colorMap = { danger:'rgba(239,68,68,.1)', warning:'rgba(245,158,11,.1)', success:'rgba(16,185,129,.1)', info:'rgba(59,130,246,.1)' };
    const borderMap = { danger:C.red, warning:C.accent, success:C.green, info:C.blue };

    el.innerHTML = insights.length ? insights.map(ins => `
      <div style="
        background:${colorMap[ins.tipo]||colorMap.info};
        border-left:3px solid ${borderMap[ins.tipo]||C.blue};
        border-radius:0 8px 8px 0;
        padding:10px 14px;
        margin-bottom:8px;
        font-size:.84rem;
        color:${C.text};
        line-height:1.5;
      ">
        <span style="margin-right:6px">${ins.icon}</span>${ins.texto}
      </div>`).join('')
    : `<div style="color:${C.text3};font-size:.85rem;padding:16px 0;text-align:center">Nenhum insight gerado para o período selecionado.</div>`;
  }

  // ── Ranking Baterias ──────────────────────────────────────
  function renderRankBaterias(kpi) {
    const el = document.getElementById('ao-rank-baterias');
    if (!el) return;

    const maxOps = Math.max(...kpi.rankBaterias.map(b=>b.ops), 1);

    el.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:.82rem">
        <thead>
          <tr style="border-bottom:2px solid ${C.border}">
            <th style="text-align:left;padding:8px 10px;color:${C.text3};font-weight:600;font-size:.74rem;text-transform:uppercase;letter-spacing:.08em">Bateria</th>
            <th style="text-align:center;padding:8px 10px;color:${C.text3};font-weight:600;font-size:.74rem;text-transform:uppercase;letter-spacing:.08em">Ops.</th>
            <th style="text-align:center;padding:8px 10px;color:${C.text3};font-weight:600;font-size:.74rem;text-transform:uppercase;letter-spacing:.08em">T. Médio</th>
            <th style="text-align:center;padding:8px 10px;color:${C.text3};font-weight:600;font-size:.74rem;text-transform:uppercase;letter-spacing:.08em">% Atrasos</th>
            <th style="text-align:center;padding:8px 10px;color:${C.text3};font-weight:600;font-size:.74rem;text-transform:uppercase;letter-spacing:.08em">H. Perdidas</th>
            <th style="text-align:center;padding:8px 10px;color:${C.text3};font-weight:600;font-size:.74rem;text-transform:uppercase;letter-spacing:.08em">m²</th>
            <th style="text-align:center;padding:8px 10px;color:${C.text3};font-weight:600;font-size:.74rem;text-transform:uppercase;letter-spacing:.08em">Eficiência</th>
          </tr>
        </thead>
        <tbody>
          ${kpi.rankBaterias.map((b, i) => {
            const efCol = b.eficiencia >= 80 ? C.green : b.eficiencia >= 60 ? C.accent : C.red;
            const atCol = b.pctAtraso === 0 ? C.green : b.pctAtraso <= 20 ? C.accent : C.red;
            const isFirst = i === 0;
            const isLast  = i === kpi.rankBaterias.length - 1;
            return `
              <tr style="border-bottom:1px solid ${C.border};${isFirst?'background:rgba(16,185,129,.04)':''}${isLast?'background:rgba(239,68,68,.04)':''}">
                <td style="padding:10px 10px;font-weight:700;color:${C.text}">
                  ${isFirst ? '🥇 ' : isLast ? '⚠️ ' : ''}${LW.escaparHtml(b.bat)}
                </td>
                <td style="text-align:center;padding:10px;color:${C.text2};font-family:'JetBrains Mono',monospace">${b.ops}</td>
                <td style="text-align:center;padding:10px;color:${C.text2};font-family:'JetBrains Mono',monospace">${fmtMin(b.tempoMedio)}</td>
                <td style="text-align:center;padding:10px">
                  <span style="
                    background:${atCol}22;color:${atCol};
                    border-radius:20px;padding:3px 10px;
                    font-family:'JetBrains Mono',monospace;font-weight:700;font-size:.8rem
                  ">${b.pctAtraso.toFixed(0)}%</span>
                </td>
                <td style="text-align:center;padding:10px;color:${b.horasPerdidas>1?C.red:C.text3};font-family:'JetBrains Mono',monospace">${b.horasPerdidas.toFixed(1)}h</td>
                <td style="text-align:center;padding:10px;color:${C.text2};font-family:'JetBrains Mono',monospace">${fmt(b.m2,0)}</td>
                <td style="text-align:center;padding:10px">
                  <div style="display:flex;align-items:center;justify-content:center;gap:8px">
                    <div style="flex:1;max-width:60px;background:${C.bg3};border-radius:4px;height:6px;overflow:hidden">
                      <div style="width:${b.eficiencia}%;height:100%;background:${efCol};border-radius:4px"></div>
                    </div>
                    <span style="font-family:'JetBrains Mono',monospace;font-weight:700;color:${efCol};font-size:.8rem">${b.eficiencia.toFixed(0)}%</span>
                  </div>
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    // Mini chart de ops por bateria
    const labels = kpi.rankBaterias.map(b=>b.bat);
    const vals   = kpi.rankBaterias.map(b=>b.ops);
    const cols   = kpi.rankBaterias.map(b=> b.eficiencia >= 80 ? C.green : b.eficiencia >= 60 ? C.accent : C.red);
    setTimeout(() => drawBar('ao-chart-bat-ops', labels, vals, cols, 180, true,
      (valor, lbl) => `${lbl}: ${valor} operaç${valor === 1 ? 'ão' : 'ões'}`), 50);
  }

  // ── Ranking Motivos ───────────────────────────────────────
  function renderRankMotivos(kpi) {
    const el = document.getElementById('ao-rank-motivos');
    if (!el) return;

    const maxQtd = kpi.rankMotivos.length ? kpi.rankMotivos[0].qtd : 1;
    const motCols = [C.red, C.orange, C.accent, C.yellow, C.blue, C.cyan, C.purple];

    drawHorizBar('ao-rank-motivos', kpi.rankMotivos.map((m,i) => ({
      label: m.motivo,
      value: m.qtd,
      display: `${m.qtd} (${m.pct.toFixed(0)}%)`,
      color: motCols[i % motCols.length],
      sub: null,
    })), maxQtd);
  }

  // ── Correlações ───────────────────────────────────────────
  function renderCorrelacoes(kpi, dados) {
    // Montagem x Atrasos — cor real vinculada a cada tipo simples (gerada
    // automaticamente na tela de admin), igual ao badge do Registro de
    // Baterias. Tipo híbrido/sem cor própria cai num cinza neutro.
    const mountLabels = Object.keys(kpi.corMontagem);
    const mountAtraso = mountLabels.map(m => kpi.corMontagem[m].total
      ? (kpi.corMontagem[m].atrasos/kpi.corMontagem[m].total)*100 : 0);
    const mountCols   = mountLabels.map(m => {
      const c = LW.corMontagemPorLabel(m);
      return c.hibrida ? { hibrida: true, cor1: c.cor1, cor2: c.cor2 } : c.cor;
    });
    setTimeout(() => drawBar('ao-cor-montagem', mountLabels, mountAtraso, mountCols, 160, true,
      (valor, lbl) => `${lbl}: ${valor.toFixed(0)}% de atraso`), 50);

    // Dimensão x Tempo
    const dimEntries = Object.entries(kpi.corDimensao);
    const dimLabels  = dimEntries.map(([d])=>d);
    const dimTempo   = dimEntries.map(([,v]) => v.tempos.length ? v.tempos.reduce((a,b)=>a+b,0)/v.tempos.length : 0);
    setTimeout(() => drawBar('ao-cor-dimensao', dimLabels, dimTempo, C.blue, 160, true,
      (valor, lbl) => `${lbl}: ${valor.toFixed(0)} min em média`), 50);

    // Bateria x Tempo médio
    const batLabels = kpi.rankBaterias.map(b=>b.bat);
    const batTempo  = kpi.rankBaterias.map(b=>b.tempoMedio);
    const batCols   = kpi.rankBaterias.map(b => b.tempoMedio > 59 ? C.red : b.tempoMedio > 50 ? C.accent : C.green);
    setTimeout(() => drawBar('ao-cor-bat-tempo', batLabels, batTempo, batCols, 180, true,
      (valor, lbl) => `${lbl}: ${valor.toFixed(0)} min em média`), 50);
  }

  // ── Tendências ────────────────────────────────────────────
  function renderTendencias(kpi) {
    setTimeout(() => {
      drawDualLine(
        'ao-trend-chart',
        kpi.trendLabels,
        kpi.trendAtraso,
        kpi.trendTempo.map(t => t/2), // escalar tempo para sobrepor no mesmo gráfico
        C.red, C.blue,
        '% Atrasos', 'Tempo Médio (÷2)',
        220,
        (i, lbl) => `${lbl}\n% Atrasos: ${kpi.trendAtraso[i].toFixed(0)}%\nTempo Médio: ${kpi.trendTempo[i].toFixed(0)} min`
      );
    }, 50);

    // Painel de baterias em deterioração
    const el = document.getElementById('ao-baterias-piora');
    if (!el) return;
    if (!kpi.bateriasPiora.length) {
      el.innerHTML = `<span style="color:${C.green};font-size:.84rem">✅ Nenhuma bateria com tendência de deterioração detectada.</span>`;
    } else {
      el.innerHTML = kpi.bateriasPiora.map(b => `
        <div style="
          display:inline-flex;align-items:center;gap:8px;
          background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);
          border-radius:20px;padding:5px 14px;margin:4px;
        ">
          <span style="font-size:.75rem">⚠️</span>
          <span style="font-weight:700;color:${C.red};font-size:.84rem">${LW.escaparHtml(b.bat)}</span>
          <span style="color:${C.text3};font-size:.78rem">${b.pctAtraso.toFixed(0)}% atrasos</span>
        </div>`).join('');
    }
  }

  // ── Produtividade ─────────────────────────────────────────
  function renderProdutividade(kpi, dados) {
    // m² por bateria (top 8)
    const top8 = [...kpi.rankBaterias].sort((a,b)=>b.m2-a.m2).slice(0,8);
    const m2Labels = top8.map(b=>b.bat);
    const m2Vals   = top8.map(b=>b.m2);
    const m2Cols   = top8.map(() => C.cyan);
    setTimeout(() => drawBar('ao-prod-m2', m2Labels, m2Vals, m2Cols, 160, true,
      (valor, lbl) => `${lbl}: ${fmt(valor, 1)} m²`), 50);

    // Produção por dimensão (donut textual)
    const el = document.getElementById('ao-prod-dimensao');
    if (!el) return;
    const porDim = {};
    dados.forEach(r => {
      if (!porDim[r.dimensao]) porDim[r.dimensao] = {m2:0,paineis:0,ops:0};
      porDim[r.dimensao].m2      += r.m2_total||0;
      porDim[r.dimensao].paineis += r.total_paineis||0;
      porDim[r.dimensao].ops++;
    });
    const totalM2 = Object.values(porDim).reduce((s,v)=>s+v.m2,0);
    const dimCols  = [C.accent, C.blue, C.green, C.purple];
    el.innerHTML = Object.entries(porDim).map(([d,v],i) => {
      const pct = totalM2 ? (v.m2/totalM2)*100 : 0;
      return `
        <div style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;margin-bottom:4px">
            <span style="font-weight:700;color:${C.text};font-size:.85rem">${LW.escaparHtml(d)}</span>
            <span style="color:${dimCols[i%dimCols.length]};font-family:'JetBrains Mono',monospace;font-size:.82rem;font-weight:700">${fmt(v.m2,0)} m²</span>
          </div>
          <div style="background:${C.bg3};border-radius:4px;height:10px;overflow:hidden;margin-bottom:3px">
            <div style="width:${pct}%;height:100%;background:${dimCols[i%dimCols.length]};border-radius:4px"></div>
          </div>
          <div style="display:flex;justify-content:space-between">
            <span style="color:${C.text3};font-size:.74rem">${v.ops} operações · ${v.paineis} painéis</span>
            <span style="color:${C.text3};font-size:.74rem">${pct.toFixed(0)}% do total</span>
          </div>
        </div>`;
    }).join('');
  }

  // ── Init / boot ───────────────────────────────────────────
  async function init() {
    // Ativa o estado de carregamento visual
    document.getElementById('ao-loading').style.display = 'block';

    // Busca só pra pré-preencher os filtros de data com o intervalo real
    // dos dados (1º registro → mais recente) — render(), chamado no final,
    // busca os dados de novo (sempre fresco, ver comentário lá); não dá pra
    // reaproveitar esta busca porque render() já filtra pelo que for
    // digitado nos campos de data, que ainda não existe neste ponto.
    let all = [];
    try {
      const res = await fetch('db/historico.json');
      if (res.ok) all = await res.json();
    } catch (e) { /* render(), abaixo, trata a falha de novo e mostra o estado vazio */ }

    // Prefill datas
    if (all.length) {
      const dates = all.map(r=>r.data).filter(Boolean).sort();
      const ini = document.getElementById('ao-data-inicio');
      const fim = document.getElementById('ao-data-fim');
      if (ini && !ini.value) ini.value = dates[0];
      if (fim && !fim.value) fim.value = dates[dates.length-1];
    }

    const btn = document.getElementById('btn-ao-filtrar');
    if (btn) btn.addEventListener('click', render);

    const periodo = document.getElementById('ao-periodo');
    if (periodo) {
      periodo.addEventListener('change', () => {
        const { ini, fim } = calcularPeriodoPreset(periodo.value);
        const iniEl = document.getElementById('ao-data-inicio');
        const fimEl = document.getElementById('ao-data-fim');
        if (iniEl) iniEl.value = ini;
        if (fimEl) fimEl.value = fim;
        render();
      });
    }

    await render();
  }

  // ── Public ─────────────────────────────────────────────────
  window.AOp = { init, render };

})();