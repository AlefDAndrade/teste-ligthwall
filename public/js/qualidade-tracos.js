// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  qualidade-tracos.js — CEP: Controle Estatístico de Processo
//
//  Fonte de dados: relatorio_injecao.json
//  (traços com campos _real que podem ser número simples
//   ou objeto { original, ajustes[], total })
// ============================================================

'use strict';

(function () {

  // ── MAPEAMENTO DE INSUMOS ────────────────────────────────
  const INSUMOS_LABELS = {
    cimento_real:      'Cimento',
    agua_real:         'Água',
    eps_real:          'EPS',
    superplast_real:   'Superplastificante',
    incorporador_real: 'Incorporador de Ar',
  };

  // Limite de desvio percentual para alertas (%)
  const LIMITE_DESVIO_PCT  = 10;
  // Limite de taxa de acerto abaixo do qual dispara alerta (%)
  const LIMITE_TAXA_ACERTO = 70;

  // ── NORMALIZA CAMPO INSUMO ───────────────────────────────
  // Suporta: número puro, string, ou { original, ajustes[], total }
  function normalizarInsumo(val) {
    if (val === null || val === undefined || val === '') {
      return { original: NaN, ajustes: [], total: NaN };
    }
    if (typeof val === 'object' && 'ajustes' in val) {
      const ajustes  = Array.isArray(val.ajustes) ? val.ajustes : [];
      const original = parseFloat(val.original);
      let total;
      if (val.total !== undefined && val.total !== '') {
        total = parseFloat(val.total);
      } else if (ajustes.length > 0) {
        total = ajustes.reduce((s, v) => s + (parseFloat(v) || 0), isNaN(original) ? 0 : original);
      } else {
        total = original;
      }
      return { original, ajustes, total };
    }
    // Formato simples
    const v = parseFloat(val);
    return { original: v, ajustes: [], total: v };
  }

  // ── ESTATÍSTICAS BÁSICAS ─────────────────────────────────
  function estatisticas(arr) {
    const nums = arr.filter(v => !isNaN(v) && isFinite(v));
    if (!nums.length) return { n: 0, media: NaN, mediana: NaN, dp: NaN, cv: NaN, min: NaN, max: NaN };
    const n      = nums.length;
    const media  = nums.reduce((s, v) => s + v, 0) / n;
    const sorted = [...nums].sort((a, b) => a - b);
    const mediana = n % 2 === 0
      ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
      : sorted[Math.floor(n / 2)];
    const dp  = Math.sqrt(nums.reduce((s, v) => s + (v - media) ** 2, 0) / n);
    const cv  = media !== 0 ? (dp / media) * 100 : NaN;
    return { n, media, mediana, dp, cv, min: sorted[0], max: sorted[n - 1] };
  }

  // ── TENDÊNCIA LINEAR ─────────────────────────────────────
  // Retorna slope (+ = crescendo, - = caindo)
  function tendencia(arr) {
    const n = arr.length;
    if (n < 2) return 0;
    const mx = (n - 1) / 2;
    const my = arr.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    arr.forEach((v, i) => { num += (i - mx) * (v - my); den += (i - mx) ** 2; });
    return den !== 0 ? num / den : 0;
  }

  // ── BUSCA TRAÇOS COM FILTROS ─────────────────────────────
  // Usa relatorio_injecao.json como fonte primária de dados de traços
  async function getTracosComFiltros(filtros) {
    const registros = await fetch('db/relatorio_injecao.json').then(r => r.json());

    const dataInicio   = filtros.dataInicio   || '';
    const dataFim      = filtros.dataFim      || '';
    const bateria      = filtros.bateria      || '';
    const turno        = filtros.turno        || '';
    const tipoMontagem = filtros.tipoMontagem || '';

    return registros.filter(t => {
      if (dataInicio && t.data < dataInicio) return false;
      if (dataFim    && t.data > dataFim)    return false;
      if (bateria    && t.id_bateria !== bateria) return false;
      if (turno      && t.turno !== turno)        return false;
      if (tipoMontagem && t.tipo_montagem !== tipoMontagem) return false;
      return true;
    });
  }

  // ── CALCULA TODOS OS INDICADORES CEP ────────────────────
  function calcularIndicadores(tracos) {
    const totalTracos = tracos.length;
    let tracosComAjuste   = 0;
    let totalAjustesGeral = 0;

    // Por insumo: contadores e arrays para estatística
    const ajustesPorInsumo  = {};  // label → count
    const valoresReaisPorInsumo = {};  // label → [nums]
    const valoresOrigPorInsumo  = {};  // label → [nums] (planejado)

    // Por tipo de montagem + mês
    const porTipo = {};   // tipo → { total, ajustados, porMes: { YYYY-MM: { total, ajustados } } }
    const evolucao = {};  // YYYY-MM → { total, ajustados }

    for (const t of tracos) {
      let tracoTemAjuste = false;

      const camposInsumo = Object.keys(INSUMOS_LABELS);

      for (const campo of camposInsumo) {
        const raw = t[campo];
        if (raw === undefined) continue;

        const insumo = normalizarInsumo(raw);
        const label  = INSUMOS_LABELS[campo];
        const nAj    = insumo.ajustes.length;

        // Contabiliza ajustes
        if (nAj > 0) {
          ajustesPorInsumo[label] = (ajustesPorInsumo[label] || 0) + nAj;
          totalAjustesGeral += nAj;
          tracoTemAjuste = true;
        }

        // Acumula valores para estatística
        if (!isNaN(insumo.total)) {
          if (!valoresReaisPorInsumo[label]) valoresReaisPorInsumo[label] = [];
          valoresReaisPorInsumo[label].push(insumo.total);
        }
        if (!isNaN(insumo.original)) {
          if (!valoresOrigPorInsumo[label]) valoresOrigPorInsumo[label] = [];
          valoresOrigPorInsumo[label].push(insumo.original);
        }
      }

      if (tracoTemAjuste) tracosComAjuste++;

      // Agrega por tipo de montagem
      const tipo = t.tipo_montagem || 'Desconhecido';
      if (!porTipo[tipo]) porTipo[tipo] = { total: 0, ajustados: 0, porMes: {} };
      porTipo[tipo].total++;
      if (tracoTemAjuste) porTipo[tipo].ajustados++;

      // Agrega evolução mensal
      if (t.data && t.data.length >= 7) {
        const mes = t.data.substring(0, 7);
        if (!evolucao[mes]) evolucao[mes] = { total: 0, ajustados: 0 };
        evolucao[mes].total++;
        if (tracoTemAjuste) evolucao[mes].ajustados++;

        if (!porTipo[tipo].porMes[mes]) porTipo[tipo].porMes[mes] = { total: 0, ajustados: 0 };
        porTipo[tipo].porMes[mes].total++;
        if (tracoTemAjuste) porTipo[tipo].porMes[mes].ajustados++;
      }
    }

    const tracosSemAjuste = totalTracos - tracosComAjuste;
    const taxaAcerto  = totalTracos > 0 ? Math.round((tracosSemAjuste / totalTracos) * 100) : 0;
    const mediaAjustes = totalTracos > 0 ? (totalAjustesGeral / totalTracos) : 0;

    // Ranking materiais (mais ajustados)
    const rankingMateriais = Object.entries(ajustesPorInsumo).sort((a, b) => b[1] - a[1]);

    // Estabilidade por tipo de montagem
    const rankingReceitas = Object.entries(porTipo)
      .map(([tipo, v]) => ({
        tipo,
        pct: v.total > 0 ? Math.round((v.ajustados / v.total) * 100) : 0,
        total: v.total,
        ajustados: v.ajustados,
        porMes: v.porMes,
      }))
      .sort((a, b) => a.pct - b.pct); // crescente: mais estável primeiro

    // Receita mais estável e mais instável
    const receitaMaisEstavel   = rankingReceitas[0] || null;
    const receitaMaisInstavel  = rankingReceitas[rankingReceitas.length - 1] || null;

    // Consumo planejado × real
    const consumoPorInsumo = {};
    for (const label of Object.keys(INSUMOS_LABELS).map(k => INSUMOS_LABELS[k])) {
      const reais = valoresReaisPorInsumo[label] || [];
      const origs = valoresOrigPorInsumo[label]  || [];
      if (!reais.length && !origs.length) continue;
      const planejado = origs.reduce((s, v) => s + v, 0);
      const real      = reais.reduce((s, v) => s + v, 0);
      consumoPorInsumo[label] = { planejado, real };
    }

    // Maior desvio percentual
    let maiorDesvioLabel = '—';
    let maiorDesvioPct   = 0;
    for (const [label, v] of Object.entries(consumoPorInsumo)) {
      if (v.planejado > 0) {
        const pct = Math.abs(((v.real - v.planejado) / v.planejado) * 100);
        if (pct > maiorDesvioPct) { maiorDesvioPct = pct; maiorDesvioLabel = label; }
      }
    }

    // Estatísticas CEP por insumo
    const cepPorInsumo = {};
    for (const [campo, label] of Object.entries(INSUMOS_LABELS)) {
      const reais = valoresReaisPorInsumo[label] || [];
      cepPorInsumo[label] = estatisticas(reais);
    }

    // Tendência da taxa de acerto (evolução mensal)
    const mesesOrdenados = Object.keys(evolucao).sort();
    const taxasMensais   = mesesOrdenados.map(m => {
      const v = evolucao[m];
      return v.total > 0 ? 100 - Math.round((v.ajustados / v.total) * 100) : 100;
    });
    const slopeTaxa = tendencia(taxasMensais);

    // Tendência por insumo (quantidade de ajustes por mês)
    const ajustesPorInsumoMes = {}; // label → { mes: count }
    for (const t of tracos) {
      if (!t.data || t.data.length < 7) continue;
      const mes = t.data.substring(0, 7);
      for (const [campo, label] of Object.entries(INSUMOS_LABELS)) {
        const raw = t[campo];
        if (raw === undefined) continue;
        const nAj = normalizarInsumo(raw).ajustes.length;
        if (nAj > 0) {
          if (!ajustesPorInsumoMes[label]) ajustesPorInsumoMes[label] = {};
          ajustesPorInsumoMes[label][mes] = (ajustesPorInsumoMes[label][mes] || 0) + nAj;
        }
      }
    }

    return {
      totalTracos, tracosSemAjuste, tracosComAjuste,
      taxaAcerto, totalAjustesGeral, mediaAjustes,
      rankingMateriais, rankingReceitas,
      receitaMaisEstavel, receitaMaisInstavel,
      maiorDesvioLabel, maiorDesvioPct,
      consumoPorInsumo, cepPorInsumo,
      evolucao, mesesOrdenados, taxasMensais, slopeTaxa,
      ajustesPorInsumoMes,
      porTipo,
    };
  }

  // ── HELPERS ──────────────────────────────────────────────
  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }
  function fmtN(n, dec = 1) {
    if (isNaN(n) || !isFinite(n)) return '—';
    return n.toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }
  function fmtI(n) { return isNaN(n) ? '—' : Math.round(n).toLocaleString('pt-BR'); }
  function nomeMes(yyyymm) {
    const [y, m] = yyyymm.split('-');
    const nomes = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    return nomes[parseInt(m) - 1] + (y !== nowBrasilia().toISOString().slice(0,4) ? `/${y.slice(2)}` : '');
  }

  // ── RENDER: KPIs PRINCIPAIS ──────────────────────────────
  function renderKPIs(ind) {
    setText('qt-total-tracos',        ind.totalTracos.toLocaleString('pt-BR'));
    setText('qt-sem-ajuste',          ind.tracosSemAjuste.toLocaleString('pt-BR'));
    setText('qt-com-ajuste',          ind.tracosComAjuste.toLocaleString('pt-BR'));
    setText('qt-taxa-acerto',         ind.taxaAcerto + '%');
    setText('qt-total-ajustes-num',   ind.totalAjustesGeral.toLocaleString('pt-BR'));
    setText('qt-media-ajustes',       ind.mediaAjustes.toFixed(2).replace('.', ','));
    setText('qt-donut-sem',           ind.tracosSemAjuste.toLocaleString('pt-BR'));
    setText('qt-donut-com',           ind.tracosComAjuste.toLocaleString('pt-BR'));

    const bar = document.getElementById('qt-taxa-bar');
    if (bar) {
      bar.style.width = ind.taxaAcerto + '%';
      bar.style.background = ind.taxaAcerto >= 80
        ? 'linear-gradient(90deg,#10b981,#34d399)'
        : ind.taxaAcerto >= 50
          ? 'linear-gradient(90deg,#f59e0b,#fbbf24)'
          : 'linear-gradient(90deg,#ef4444,#f87171)';
    }

    // Tendência da taxa
    const tendEl = document.getElementById('qt-tendencia-taxa');
    if (tendEl) {
      if (ind.slopeTaxa > 0.5) tendEl.textContent = '↗ Melhorando';
      else if (ind.slopeTaxa < -0.5) tendEl.textContent = '↘ Deteriorando';
      else tendEl.textContent = '→ Estável';
      tendEl.style.color = ind.slopeTaxa >= 0 ? '#10b981' : '#ef4444';
    }

    // Receita mais estável
    if (ind.receitaMaisEstavel) {
      setText('qt-receita-estavel', ind.receitaMaisEstavel.tipo);
      setText('qt-receita-estavel-pct', `${ind.receitaMaisEstavel.pct}% ajustados · ${ind.receitaMaisEstavel.total} traços`);
    }
    // Receita mais instável
    if (ind.receitaMaisInstavel && ind.receitaMaisInstavel !== ind.receitaMaisEstavel) {
      setText('qt-receita-instavel', ind.receitaMaisInstavel.tipo);
      setText('qt-receita-instavel-pct', `${ind.receitaMaisInstavel.pct}% ajustados · ${ind.receitaMaisInstavel.total} traços`);
    }

    // Insumo mais ajustado
    if (ind.rankingMateriais.length) {
      const [label, cnt] = ind.rankingMateriais[0];
      const pctTotal = ind.totalAjustesGeral > 0 ? Math.round((cnt / ind.totalAjustesGeral) * 100) : 0;
      setText('qt-insumo-mais-ajustado', label);
      setText('qt-insumo-mais-ajustado-cnt', `${cnt} ajuste${cnt !== 1 ? 's' : ''} (${pctTotal}% do total)`);
    }

    // Insumo maior desvio
    if (ind.maiorDesvioLabel !== '—') {
      const v = ind.consumoPorInsumo[ind.maiorDesvioLabel];
      const sinal = v && v.real > v.planejado ? '+' : '';
      setText('qt-insumo-maior-desvio', ind.maiorDesvioLabel);
      setText('qt-insumo-maior-desvio-val', `Desvio: ${sinal}${fmtN(ind.maiorDesvioPct)}% do planejado`);
    }
  }

  // ── RENDER: DONUT ─────────────────────────────────────────
  function renderDonut(ind) {
    const canvas = document.getElementById('qt-donut');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = 90; canvas.width = size; canvas.height = size;
    const cx = size / 2, cy = size / 2, r = 36, inner = 22;
    const segs   = [ind.tracosSemAjuste, ind.tracosComAjuste];
    const colors = ['#10b981', '#f59e0b'];
    const total  = segs.reduce((s, v) => s + v, 0);
    if (!total) {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#2a2f3a'; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, inner, 0, Math.PI * 2);
      ctx.fillStyle = '#1e2229'; ctx.fill(); return;
    }
    let angle = -Math.PI / 2;
    segs.forEach((v, i) => {
      const slice = (v / total) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angle, angle + slice); ctx.closePath();
      ctx.fillStyle = colors[i]; ctx.fill(); angle += slice;
    });
    ctx.beginPath(); ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx.fillStyle = '#1e2229'; ctx.fill();
  }

  // ── RENDER: RANKING MATERIAIS ─────────────────────────────
  function renderRankingMateriais(ind) {
    const el = document.getElementById('qt-ranking-materiais');
    if (!el) return;
    if (!ind.rankingMateriais.length) {
      el.innerHTML = '<div style="color:var(--text-3);font-size:.84rem;text-align:center;padding:20px 0">Nenhum ajuste registrado no período</div>';
      return;
    }
    const total  = ind.totalAjustesGeral;
    const maxVal = ind.rankingMateriais[0][1];
    const medals = ['🥇','🥈','🥉'];
    el.innerHTML = ind.rankingMateriais.map(([label, cnt], i) => {
      const bar     = maxVal > 0 ? Math.round((cnt / maxVal) * 100) : 0;
      const pctTot  = total > 0 ? ((cnt / total) * 100).toFixed(1) : '—';
      const medal   = medals[i] || `${i + 1}º`;
      // Tendência por insumo
      const meses   = Object.keys(ind.ajustesPorInsumoMes[label] || {}).sort();
      const vals    = meses.map(m => ind.ajustesPorInsumoMes[label][m]);
      const slope   = tendencia(vals);
      const trendTxt = slope > 0.1 ? ' ↗ crescendo' : slope < -0.1 ? ' ↘ caindo' : '';
      const trendClr = slope > 0.1 ? '#ef4444' : slope < -0.1 ? '#10b981' : 'var(--text-3)';
      return `
        <div style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <span style="font-size:.84rem;color:var(--text-2)">${medal} ${label}</span>
            <span style="font-family:var(--font-mono);font-size:.84rem;font-weight:700;color:var(--accent)">${cnt} aj. <span style="color:var(--text-3);font-size:.75rem">(${pctTot}%)</span></span>
          </div>
          <div style="background:var(--bg-3);border-radius:4px;height:5px;overflow:hidden;margin-bottom:3px">
            <div style="height:100%;width:${bar}%;background:var(--accent);border-radius:4px;transition:width .4s"></div>
          </div>
          ${trendTxt ? `<div style="font-size:.7rem;color:${trendClr};text-align:right">${trendTxt}</div>` : ''}
        </div>`;
    }).join('');
  }

  // ── RENDER: ESTABILIDADE RECEITAS ─────────────────────────
  function renderRankingReceitas(ind) {
    const el = document.getElementById('qt-ranking-receitas');
    if (!el) return;
    if (!ind.rankingReceitas.length) {
      el.innerHTML = '<div style="color:var(--text-3);font-size:.84rem;text-align:center;padding:20px 0">Sem dados no período</div>';
      return;
    }
    // Ordenado crescente (mais estável = menor % → topo)
    el.innerHTML = ind.rankingReceitas.map(r => {
      let cor = '#10b981';
      if      (r.pct > 40) cor = '#ef4444';
      else if (r.pct > 20) cor = '#f59e0b';

      // Tendência por montagem
      const meses = Object.keys(r.porMes).sort();
      const vals  = meses.map(m => {
        const v = r.porMes[m];
        return v.total > 0 ? (v.ajustados / v.total) * 100 : 0;
      });
      const slope = tendencia(vals);
      const trendTxt = slope > 0.5 ? '↗ Piora' : slope < -0.5 ? '↘ Melhora' : '→ Estável';
      const trendClr = slope > 0.5 ? '#ef4444' : slope < -0.5 ? '#10b981' : 'var(--text-3)';

      // Média e frequência de ajustes
      const mediaAj = r.total > 0 ? (r.ajustados / r.total * 100).toFixed(1) : '0';

      return `
        <div style="padding:10px 12px;border-radius:8px;background:var(--bg-2);margin-bottom:8px;border-left:3px solid ${cor}">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-size:.88rem;font-weight:600;color:var(--text)">${r.tipo}</div>
              <div style="font-size:.72rem;color:var(--text-3);margin-top:2px">${r.ajustados} de ${r.total} traços ajustados</div>
            </div>
            <div style="text-align:right">
              <div style="font-family:var(--font-mono);font-size:1.2rem;font-weight:800;color:${cor}">${r.pct}%</div>
              <div style="font-size:.68rem;color:${trendClr}">${trendTxt}</div>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  // ── RENDER: CEP TABELA ESTATÍSTICA ───────────────────────
  function renderCEP(ind) {
    const el = document.getElementById('qt-cep-tabela');
    if (!el) return;

    const linhas = Object.entries(ind.cepPorInsumo);
    if (!linhas.some(([, s]) => s.n > 0)) {
      el.innerHTML = '<div style="color:var(--text-3);font-size:.84rem">Sem dados de consumo real no período para calcular estatísticas.</div>';
      return;
    }

    const th = (t) => `<th style="padding:8px 12px;text-align:${isNaN(t[0]) ? 'left' : 'right'};font-size:.72rem;font-weight:600;color:var(--text-3);white-space:nowrap;border-bottom:1px solid var(--border)">${t}</th>`;
    const td = (v, color = '') => `<td style="padding:8px 12px;text-align:right;font-family:var(--font-mono);font-size:.78rem;color:${color || 'var(--text-2)'};white-space:nowrap">${v}</td>`;
    const tdL = (v) => `<td style="padding:8px 12px;font-size:.82rem;font-weight:600;color:var(--text)">${v}</td>`;

    const rows = linhas.map(([label, s]) => {
      if (s.n === 0) return `<tr><td colspan="8" style="padding:8px 12px;color:var(--text-3);font-size:.78rem">${label}: sem dados</td></tr>`;
      const cvColor = isNaN(s.cv) ? '' : s.cv > 25 ? '#ef4444' : s.cv > 15 ? '#f59e0b' : '#10b981';
      return `<tr style="border-bottom:1px solid var(--border)">
        ${tdL(label)}
        ${td(s.n, 'var(--text-3)')}
        ${td(fmtN(s.media))}
        ${td(fmtN(s.mediana))}
        ${td(fmtN(s.dp))}
        ${td(isNaN(s.cv) ? '—' : fmtN(s.cv) + '%', cvColor)}
        ${td(fmtN(s.min))}
        ${td(fmtN(s.max))}
      </tr>`;
    }).join('');

    el.innerHTML = `
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:var(--bg-3)">
          ${th('Insumo')}${th('N')}${th('Média')}${th('Mediana')}${th('Desvio Padrão')}${th('CV %')}${th('Mín')}${th('Máx')}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:8px;font-size:.7rem;color:var(--text-3)">CV = Coeficiente de Variação. Verde &lt;15% · Amarelo 15-25% · Vermelho &gt;25%</div>`;
  }

  // ── RENDER: CONSUMO PLANEJADO × REAL ─────────────────────
  function renderConsumo(ind) {
    const el = document.getElementById('qt-consumo-grid');
    if (!el) return;
    const insumos = Object.entries(ind.consumoPorInsumo).filter(([, v]) => v.planejado > 0 || v.real > 0);
    if (!insumos.length) {
      el.innerHTML = '<div style="color:var(--text-3);font-size:.84rem">Nenhum dado de consumo disponível no período</div>';
      return;
    }
    el.innerHTML = insumos.map(([label, v]) => {
      const diff = v.real - v.planejado;
      const pct  = v.planejado > 0 ? ((diff / v.planejado) * 100).toFixed(1) : null;
      const cor  = diff > 0 ? '#ef4444' : diff < 0 ? '#10b981' : 'var(--text-3)';
      const sinal = diff > 0 ? '+' : '';
      const alerta = pct !== null && Math.abs(parseFloat(pct)) > LIMITE_DESVIO_PCT
        ? `<div style="font-size:.68rem;color:#ef4444;margin-top:4px">⚠ Desvio acima do limite (${LIMITE_DESVIO_PCT}%)</div>` : '';
      return `
        <div style="background:var(--bg-2);border-radius:10px;padding:14px;border:1px solid var(--border)">
          <div style="font-size:.68rem;text-transform:uppercase;letter-spacing:.07em;color:var(--text-3);margin-bottom:8px">${label}</div>
          <div style="display:flex;flex-direction:column;gap:4px">
            <div style="display:flex;justify-content:space-between">
              <span style="font-size:.74rem;color:var(--text-3)">Planejado</span>
              <span style="font-family:var(--font-mono);font-size:.8rem;color:var(--text-2)">${fmtN(v.planejado)}</span>
            </div>
            <div style="display:flex;justify-content:space-between">
              <span style="font-size:.74rem;color:var(--text-3)">Real</span>
              <span style="font-family:var(--font-mono);font-size:.8rem;color:var(--text-2)">${fmtN(v.real)}</span>
            </div>
            <div style="border-top:1px solid var(--border);padding-top:5px;margin-top:2px;display:flex;justify-content:space-between;align-items:center">
              <span style="font-size:.74rem;color:var(--text-3)">Diferença</span>
              <span style="font-family:var(--font-mono);font-size:.88rem;font-weight:700;color:${cor}">${sinal}${fmtN(diff)}${pct !== null ? ` (${sinal}${pct}%)` : ''}</span>
            </div>
          </div>
          ${alerta}
        </div>`;
    }).join('');
  }

  // ── RENDER: GRÁFICO EVOLUÇÃO ──────────────────────────────
  function renderEvolucao(ind) {
    const canvas = document.getElementById('qt-evolucao-chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.offsetWidth || 500;
    const H = canvas.height = 155;
    ctx.clearRect(0, 0, W, H);
    const meses = ind.mesesOrdenados;
    const valores = ind.taxasMensais; // Taxa de ACERTO (100 - % ajustados)
    if (!meses.length) {
      ctx.fillStyle = 'var(--text-3)'; ctx.font = '12px Barlow,sans-serif';
      ctx.textAlign = 'center'; ctx.fillText('Sem dados para exibir', W / 2, H / 2); return;
    }
    const pad  = { top: 20, right: 14, bottom: 28, left: 40 };
    const cW   = W - pad.left - pad.right;
    const cH   = H - pad.top - pad.bottom;
    const maxV = 100;

    // Grid
    ctx.strokeStyle = '#2a2f3a'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + cH * (1 - i / 4);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
      ctx.fillStyle = '#5c6475'; ctx.font = '9px JetBrains Mono,monospace'; ctx.textAlign = 'right';
      ctx.fillText((maxV * i / 4).toFixed(0) + '%', pad.left - 4, y + 3);
    }

    if (meses.length === 1) {
      const bH = (valores[0] / maxV) * cH;
      ctx.fillStyle = valores[0] >= 80 ? '#10b981' : valores[0] >= 50 ? '#f59e0b' : '#ef4444';
      ctx.fillRect(pad.left + cW / 2 - 18, pad.top + cH - bH, 36, bH);
      ctx.fillStyle = '#5c6475'; ctx.font = '9px Barlow,sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(nomeMes(meses[0]), pad.left + cW / 2, H - 4); return;
    }

    const pts = meses.map((_, i) => ({
      x: pad.left + (i / (meses.length - 1)) * cW,
      y: pad.top + cH - (valores[i] / maxV) * cH,
    }));

    // Área
    ctx.beginPath(); ctx.moveTo(pts[0].x, pad.top + cH);
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length - 1].x, pad.top + cH); ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + cH);
    grad.addColorStop(0, 'rgba(16,185,129,0.25)'); grad.addColorStop(1, 'rgba(16,185,129,0.02)');
    ctx.fillStyle = grad; ctx.fill();

    // Linha
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    pts.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = '#10b981'; ctx.lineWidth = 2; ctx.stroke();

    // Pontos + labels
    pts.forEach((p, i) => {
      const clr = valores[i] >= 80 ? '#10b981' : valores[i] >= 50 ? '#f59e0b' : '#ef4444';
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = clr; ctx.fill();
      ctx.fillStyle = '#d1d5db'; ctx.font = '9px JetBrains Mono,monospace'; ctx.textAlign = 'center';
      ctx.fillText(valores[i] + '%', p.x, p.y - 8);
      ctx.fillStyle = '#5c6475'; ctx.font = '9px Barlow,sans-serif';
      const step = Math.max(1, Math.floor(meses.length / 8));
      if (i % step === 0) ctx.fillText(nomeMes(meses[i]), p.x, H - 4);
    });
  }

  // ── RENDER: GRÁFICO BARRAS INSUMOS ───────────────────────
  function renderBarrasInsumos(ind) {
    const canvas = document.getElementById('qt-barras-insumos');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.offsetWidth || 400;
    const H = canvas.height = 155;
    ctx.clearRect(0, 0, W, H);

    const dados = ind.rankingMateriais;
    if (!dados.length) {
      ctx.fillStyle = 'var(--text-3)'; ctx.font = '12px Barlow,sans-serif';
      ctx.textAlign = 'center'; ctx.fillText('Nenhum ajuste no período', W / 2, H / 2); return;
    }

    const pad  = { top: 16, right: 10, bottom: 40, left: 10 };
    const cW   = W - pad.left - pad.right;
    const cH   = H - pad.top - pad.bottom;
    const maxV = dados[0][1];
    const bW   = Math.floor(cW / dados.length * 0.6);
    const gap  = cW / dados.length;
    const colors = ['#f59e0b','#ef4444','#3b82f6','#8b5cf6','#10b981'];

    dados.forEach(([label, cnt], i) => {
      const bH  = maxV > 0 ? (cnt / maxV) * cH : 0;
      const x   = pad.left + gap * i + (gap - bW) / 2;
      const y   = pad.top + cH - bH;
      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, bW, bH, [4, 4, 0, 0]) : ctx.rect(x, y, bW, bH);
      ctx.fill();
      // Valor acima
      ctx.fillStyle = '#d1d5db'; ctx.font = '9px JetBrains Mono,monospace'; ctx.textAlign = 'center';
      ctx.fillText(cnt, x + bW / 2, y - 4);
      // Label abaixo
      ctx.fillStyle = '#5c6475'; ctx.font = '9px Barlow,sans-serif';
      const shortLabel = label.split(' ')[0];
      ctx.fillText(shortLabel, x + bW / 2, H - pad.bottom + 14);
      // 2ª linha label
      const resto = label.split(' ').slice(1).join(' ');
      if (resto) ctx.fillText(resto, x + bW / 2, H - pad.bottom + 24);
    });
  }

  // ── RENDER: TENDÊNCIA POR MONTAGEM ───────────────────────
  function renderTendenciaMontagem(ind) {
    const el = document.getElementById('qt-tendencia-montagem');
    if (!el) return;

    const tipos = Object.keys(ind.porTipo);
    if (!tipos.length) {
      el.innerHTML = '<div style="color:var(--text-3);font-size:.84rem">Sem dados no período</div>';
      return;
    }

    el.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px">` +
      tipos.map(tipo => {
        const v = ind.porTipo[tipo];
        const meses = Object.keys(v.porMes).sort();
        const vals  = meses.map(m => {
          const x = v.porMes[m];
          return x.total > 0 ? (x.ajustados / x.total) * 100 : 0;
        });
        const slope    = tendencia(vals);
        const pctAtual = v.total > 0 ? Math.round((v.ajustados / v.total) * 100) : 0;
        const cor      = pctAtual > 40 ? '#ef4444' : pctAtual > 20 ? '#f59e0b' : '#10b981';
        const slopeEmoji = slope > 0.5 ? '📈' : slope < -0.5 ? '📉' : '➡';
        const slopeTxt   = slope > 0.5 ? 'Frequência crescendo' : slope < -0.5 ? 'Frequência caindo' : 'Frequência estável';
        const nMeses     = meses.length;
        const mediaAj = vals.length ? (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1) : '—';
        return `
          <div style="background:var(--bg-2);border-radius:10px;padding:14px;border-left:3px solid ${cor}">
            <div style="font-size:.88rem;font-weight:600;color:var(--text);margin-bottom:6px">${tipo}</div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
              <span style="font-size:.72rem;color:var(--text-3)">Taxa ajuste</span>
              <span style="font-family:var(--font-mono);font-size:.82rem;font-weight:700;color:${cor}">${pctAtual}%</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
              <span style="font-size:.72rem;color:var(--text-3)">Média mensal</span>
              <span style="font-family:var(--font-mono);font-size:.78rem;color:var(--text-2)">${mediaAj}%</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
              <span style="font-size:.72rem;color:var(--text-3)">Traços</span>
              <span style="font-family:var(--font-mono);font-size:.78rem;color:var(--text-2)">${v.total}</span>
            </div>
            <div style="font-size:.72rem;color:${slope > 0.5 ? '#ef4444' : slope < -0.5 ? '#10b981' : 'var(--text-3)'};margin-top:6px">${slopeEmoji} ${slopeTxt}${nMeses > 1 ? ` (${nMeses} meses)` : ''}</div>
          </div>`;
      }).join('') + '</div>';
  }

  // ── RENDER: INSIGHTS AUTOMÁTICOS ─────────────────────────
  function renderInsights(ind) {
    const el = document.getElementById('qt-insights');
    if (!el) return;
    const insights = [];

    // Insumo dominante em ajustes
    if (ind.rankingMateriais.length && ind.totalAjustesGeral > 0) {
      const [label, cnt] = ind.rankingMateriais[0];
      const pct = Math.round((cnt / ind.totalAjustesGeral) * 100);
      if (pct > 30) {
        insights.push({ tipo: 'alerta', txt: `<strong>${label}</strong> representa ${pct}% de todos os ajustes realizados — insumo crítico para o processo.` });
      }
    }

    // Receita mais estável
    if (ind.receitaMaisEstavel && ind.receitaMaisEstavel.total >= 3) {
      insights.push({ tipo: 'ok', txt: `O tipo de montagem <strong>${ind.receitaMaisEstavel.tipo}</strong> apresenta a maior estabilidade (${ind.receitaMaisEstavel.pct}% de traços ajustados).` });
    }

    // Receita mais instável
    if (ind.receitaMaisInstavel && ind.receitaMaisInstavel.pct > 30 && ind.receitaMaisInstavel.total >= 3) {
      insights.push({ tipo: 'alerta', txt: `O tipo <strong>${ind.receitaMaisInstavel.tipo}</strong> é o mais instável: ${ind.receitaMaisInstavel.pct}% dos traços exigiram ajustes.` });
    }

    // Consumo excedido
    for (const [label, v] of Object.entries(ind.consumoPorInsumo)) {
      if (v.planejado > 0) {
        const pct = ((v.real - v.planejado) / v.planejado) * 100;
        if (pct > LIMITE_DESVIO_PCT) {
          insights.push({ tipo: 'alerta', txt: `O consumo real de <strong>${label}</strong> excedeu o planejado em ${pct.toFixed(1)}%, indicando potencial desperdício.` });
        } else if (pct < -LIMITE_DESVIO_PCT) {
          insights.push({ tipo: 'info', txt: `O consumo real de <strong>${label}</strong> ficou ${Math.abs(pct).toFixed(1)}% abaixo do planejado — verificar se houve sub-registro ou economia real.` });
        }
      }
    }

    // Tendência da taxa de acerto
    if (ind.slopeTaxa < -1 && ind.taxasMensais.length >= 3) {
      insights.push({ tipo: 'alerta', txt: `A taxa de acerto caiu continuamente nos últimos ${ind.mesesOrdenados.length} meses — processo em deterioração.` });
    } else if (ind.slopeTaxa > 1 && ind.taxasMensais.length >= 3) {
      insights.push({ tipo: 'ok', txt: `A taxa de acerto melhorou continuamente nos últimos ${ind.mesesOrdenados.length} meses.` });
    }

    // Taxa de acerto baixa
    if (ind.totalTracos >= 5 && ind.taxaAcerto < LIMITE_TAXA_ACERTO) {
      insights.push({ tipo: 'alerta', txt: `Taxa de acerto de ${ind.taxaAcerto}% está abaixo do limite mínimo configurado (${LIMITE_TAXA_ACERTO}%).` });
    }

    // Alta variabilidade (CV)
    for (const [label, s] of Object.entries(ind.cepPorInsumo)) {
      if (s.n >= 5 && !isNaN(s.cv) && s.cv > 30) {
        insights.push({ tipo: 'alerta', txt: `<strong>${label}</strong> apresenta CV de ${s.cv.toFixed(1)}% — alta variabilidade no consumo, processo fora de controle.` });
      }
    }

    // Tendência crescente de ajustes por insumo
    for (const [label, mesDados] of Object.entries(ind.ajustesPorInsumoMes)) {
      const meses = Object.keys(mesDados).sort();
      if (meses.length >= 3) {
        const vals = meses.map(m => mesDados[m]);
        const slope = tendencia(vals);
        if (slope > 0.5) {
          const variacao = ((vals[vals.length - 1] - vals[0]) / (vals[0] || 1) * 100).toFixed(0);
          insights.push({ tipo: 'alerta', txt: `A frequência de ajustes no <strong>${label}</strong> aumentou ${variacao > 0 ? variacao + '%' : 'significativamente'} nos últimos meses.` });
        }
      }
    }

    if (!insights.length) {
      insights.push({ tipo: 'ok', txt: 'Processo estável no período selecionado. Nenhum desvio crítico detectado.' });
    }

    const iconMap = { alerta: '⚠️', ok: '✅', info: 'ℹ️' };
    const clrMap  = { alerta: '#ef444422', ok: '#10b98122', info: '#3b82f622' };
    const brdMap  = { alerta: '#ef4444', ok: '#10b981', info: '#3b82f6' };

    el.innerHTML = insights.map(({ tipo, txt }) => `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-radius:8px;background:${clrMap[tipo]};border-left:3px solid ${brdMap[tipo]}">
        <span style="flex-shrink:0;font-size:.9rem">${iconMap[tipo]}</span>
        <span style="font-size:.83rem;color:var(--text-2);line-height:1.5">${txt}</span>
      </div>`).join('');
  }

  // ── RENDER: ALERTAS ───────────────────────────────────────
  function renderAlertas(ind) {
    const el = document.getElementById('qt-alertas');
    if (!el) return;
    const alertas = [];

    if (ind.totalTracos >= 5 && ind.taxaAcerto < LIMITE_TAXA_ACERTO) {
      alertas.push(`🚨 Taxa de acerto (${ind.taxaAcerto}%) abaixo do limite de ${LIMITE_TAXA_ACERTO}%. Verificar processo imediatamente.`);
    }

    for (const [label, v] of Object.entries(ind.consumoPorInsumo)) {
      if (v.planejado > 0) {
        const pct = Math.abs(((v.real - v.planejado) / v.planejado) * 100);
        if (pct > LIMITE_DESVIO_PCT) {
          alertas.push(`⚠️ ${label}: desvio de ${pct.toFixed(1)}% no consumo (limite: ${LIMITE_DESVIO_PCT}%).`);
        }
      }
    }

    if (ind.slopeTaxa < -2 && ind.taxasMensais.length >= 3) {
      alertas.push(`📉 Taxa de acerto em queda contínua nos últimos meses. Investigar causas.`);
    }

    el.innerHTML = alertas.map(txt => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:8px;background:#ef444418;border:1px solid #ef444455;font-size:.83rem;color:#fca5a5">
        ${txt}
      </div>`).join('');
  }

  // ── POPULA FILTROS ────────────────────────────────────────
  async function popularFiltros() {
    try {
      const registros = await fetch('db/relatorio_injecao.json').then(r => r.json());
      const ids   = [...new Set(registros.map(r => r.id_bateria).filter(Boolean))].sort();
      const tipos = [...new Set(registros.map(r => r.tipo_montagem).filter(Boolean))].sort();

      const selBat = document.getElementById('qt-bateria');
      if (selBat) {
        selBat.innerHTML = '<option value="">Todas</option>';
        ids.forEach(id => {
          const o = document.createElement('option');
          o.value = o.textContent = id;
          selBat.appendChild(o);
        });
      }

      const selTipo = document.getElementById('qt-tipo-montagem');
      if (selTipo) {
        selTipo.innerHTML = '<option value="">Todos</option>';
        tipos.forEach(t => {
          const o = document.createElement('option');
          o.value = o.textContent = t;
          selTipo.appendChild(o);
        });
      }
    } catch (_) {}
  }

  // ── LEITURA DOS FILTROS ───────────────────────────────────
  function lerFiltros() {
    return {
      dataInicio:    document.getElementById('qt-data-inicio')?.value   || '',
      dataFim:       document.getElementById('qt-data-fim')?.value      || '',
      bateria:       document.getElementById('qt-bateria')?.value       || '',
      turno:         document.getElementById('qt-turno')?.value         || '',
      tipoMontagem:  document.getElementById('qt-tipo-montagem')?.value || '',
    };
  }

  // ── RENDER PRINCIPAL ──────────────────────────────────────
  async function render() {
    const filtros = lerFiltros();
    const tracos  = await getTracosComFiltros(filtros);
    const ind     = calcularIndicadores(tracos);

    renderAlertas(ind);
    renderKPIs(ind);
    renderInsights(ind);
    requestAnimationFrame(() => {
      renderDonut(ind);
      renderEvolucao(ind);
      renderBarrasInsumos(ind);
    });
    renderRankingMateriais(ind);
    renderRankingReceitas(ind);
    renderCEP(ind);
    renderConsumo(ind);
    renderTendenciaMontagem(ind);
  }

  // ── INICIALIZAÇÃO ─────────────────────────────────────────
  function init() {
    const today = todayBrasilia();
    const d90   = new Date(nowBrasilia().getTime() - 90 * 86400000).toISOString().split('T')[0];
    const ini   = document.getElementById('qt-data-inicio');
    const fim   = document.getElementById('qt-data-fim');
    if (ini && !ini.value) ini.value = d90;
    if (fim && !fim.value) fim.value = today;

    document.getElementById('btn-qt-filtrar')?.addEventListener('click', render);

    popularFiltros().then(() => render());
  }

  window.LWQualidade = { init, render };

})();
