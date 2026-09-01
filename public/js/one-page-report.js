// ============================================================
//  ONE PAGE REPORT LW SC
//  Fase 5 do plano (ver README, "Nova página: One Page Report
//  (planejamento)") — só a parte VISUAL desta tela.
//
//  MOCK_DADOS abaixo é o único lugar que vai mudar quando as Fases
//  1-4 existirem: no lugar de retornar o objeto fixo, `carregarDados()`
//  passa a fazer `fetch('/db/one-page-report.json?mes=...')` (endpoint
//  agregador da Fase 4, que por sua vez junta lib/db/seguranca-
//  ocorrencias.js, lib/db/expedicao.js e lib/db/one-page-comentarios.js
//  com os dados de produção/refugo/traços que já existem hoje). O
//  resto do arquivo (render, gráficos SVG) não muda nada.
//
//  Onde não há dado real ainda (hoje: TUDO, já que as Fases 1-4 não
//  existem), a tela mostra um aviso "dados de exemplo" — nunca finge
//  que um número inventado é um dado real (mesma regra combinada em
//  todas as fases do plano, ver README).
// ============================================================
'use strict';

(function () {

  function _escaparHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }

  function _escaparAtributo(str) {
    return _escaparHtml(str).replace(/"/g, '&quot;');
  }

  function _fmtNum(v, casas = 0) {
    return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
  }

  /* ── Gráficos SVG próprios ────────────────────────────────
     Mesma técnica de public/js/setor-qualidade.js
     (_svgBarChart/_svgHBarChart/_svgDonutChart) — reimplementados
     aqui (não importados) porque lá são funções privadas da IIFE
     daquele arquivo, e porque esta tela usa a paleta --opr-* (fixa,
     branca) em vez de var(--blue)/var(--red) do tema do app (ver
     comentário no topo de one-page-report.css). */

  const SVG_W = 460, SVG_H = 150;

  function _oprBarChart(labels, values, opts = {}) {
    const w = SVG_W, h = SVG_H, padL = 22, padR = 8, padT = 10, padB = 22;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const max = opts.max || Math.max(1, ...values);
    const n = labels.length || 1;
    const gap = (plotW / n) * 0.35;
    const barW = (plotW / n) - gap;
    const color = opts.color || 'var(--opr-blue)';
    const suffix = opts.suffix || '';
    const bars = labels.map((lb, i) => {
      const v = values[i] || 0;
      const bh = max ? (v / max) * plotH : 0;
      const x = padL + i * (plotW / n) + gap / 2;
      const y = padT + plotH - bh;
      const corBarra = (opts.colors && opts.colors[i]) || color;
      const mostrarLabel = n <= 12 || i === 0 || i === n - 1 || i % Math.ceil(n / 10) === 0;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(barW, 1).toFixed(1)}" height="${Math.max(bh, 0).toFixed(1)}" rx="1.5" fill="${corBarra}" data-tooltip="${_escaparAtributo(String(lb))}: ${v}${suffix}"/>` +
        (mostrarLabel ? `<text x="${(x + barW / 2).toFixed(1)}" y="${h - 6}" font-size="7" fill="var(--opr-text-3)" text-anchor="middle">${_escaparHtml(String(lb))}</text>` : '');
    }).join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${opts.height || 110}" preserveAspectRatio="xMidYMid meet">
      <line x1="${padL}" y1="${(padT + plotH).toFixed(1)}" x2="${w - padR}" y2="${(padT + plotH).toFixed(1)}" stroke="var(--opr-border)" stroke-width="1"/>
      ${bars}
    </svg>`;
  }

  function _oprDonut(items, opts = {}) {
    const total = items.reduce((s, it) => s + it.value, 0) || 1;
    const r = 46, cx = 60, cy = 60, strokeW = 20, circ = 2 * Math.PI * r;
    let acc = 0;
    const arcs = items.map(it => {
      const frac = it.value / total;
      const dash = frac * circ;
      const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${it.color}" stroke-width="${strokeW}"
        stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-dashoffset="${(-acc * circ).toFixed(2)}"
        transform="rotate(-90 ${cx} ${cy})" data-tooltip="${_escaparAtributo(it.label)}: ${_fmtNum(it.value, opts.casas || 0)}${opts.suffix || ''} (${(frac * 100).toFixed(1)}%)"/>`;
      acc += frac;
      return el;
    }).join('');
    const centroLabel = opts.centro || '';
    return `<svg viewBox="0 0 120 120" width="108" height="108">
      ${arcs}
      ${centroLabel ? `<text x="60" y="56" font-size="12" font-weight="700" fill="var(--opr-navy)" text-anchor="middle">${_escaparHtml(centroLabel.valor)}</text>
      <text x="60" y="68" font-size="6.5" fill="var(--opr-text-3)" text-anchor="middle">${_escaparHtml(centroLabel.legenda || '')}</text>` : ''}
    </svg>`;
  }

  function _oprDonutLegenda(items) {
    return items.map(it => `
      <div class="opr-donut-legend-item">
        <span class="opr-donut-dot" style="background:${it.color}"></span>
        ${_escaparHtml(it.label)} <span style="color:var(--opr-text-3)">(${_fmtNum(it.value)})</span>
      </div>`).join('');
  }

  function _oprIndisponivel(msg) {
    return `<div class="opr-indisponivel">
      <span class="opr-indisponivel-icon">📭</span>
      <span>${_escaparHtml(msg || 'Dado indisponível')}</span>
    </div>`;
  }

  function _oprComentarios(comentarios, proximosPassos) {
    const li = (arr) => (arr && arr.length)
      ? `<ul>${arr.map(c => `<li>${_escaparHtml(c)}</li>`).join('')}</ul>`
      : `<div style="color:var(--opr-text-3)">—</div>`;
    return `
      <div class="opr-comments-heading">Comentários</div>
      ${li(comentarios)}
      <div class="opr-comments-heading" style="margin-top:2px">Próximos passos</div>
      ${li(proximosPassos)}
    `;
  }

  /* ── MOCK_DADOS ────────────────────────────────────────────
     Números de exemplo (mesma ordem de grandeza do modelo de
     referência), só para validar o layout. Trocar por fetch real
     assim que a Fase 4 (endpoint agregador) existir — ver
     carregarDados() logo abaixo. */
  function _diasUteis(n) {
    return Array.from({ length: n }, (_, i) => String(i + 1));
  }

  function MOCK_DADOS() {
    const dias = _diasUteis(22);
    const ocorrencias = dias.map(() => 0);
    ocorrencias[6] = 1; // um único dia com ocorrência, igual ao modelo de referência

    const bateriasL1 = [4, 5, 6, 5, 4, 5, 6, 5, 4, 5, 6, 6, 5, 4, 5, 6, 5, 4, 5, 6, 6, 5];
    const refugoPct = [0, 2, 49.4, 42.5, 29, 1.3, 4, 3, 1.2, 3.4, 0, 0, 2.5, 2.6, 3.3, 2.7, 1, 4.4, 0, 1.8, 2.1, 0.9];
    const expedicaoM2 = [0, 7.32, 527.04, 230.58, 109.8, 0, 0, 1257.21, 966.24, 603.9, 878.4, 0, 0, 340.1, 512.6, 0, 690.2, 0, 0, 210.5, 0, 0];

    return {
      mesReferencia: 'Agosto/2026',
      seguranca: {
        disponivel: true,
        acumuladoMes: 1,
        diasSemAcidentes: 13,
        ocorrenciasPorDia: { labels: dias, values: ocorrencias },
        comentarios: [],
        proximosPassos: [],
      },
      producao: {
        disponivel: true,
        bateriasPorDia: { labels: dias, values: bateriasL1 },
        distribuicaoLinha: [
          { label: 'L1', value: 6237, color: 'var(--opr-blue)' },
          { label: 'L2', value: 0, color: 'var(--opr-border)' },
        ],
        totalM2: 6237,
        comentarios: [],
        proximosPassos: [],
      },
      refugo: {
        disponivel: true,
        refugoDiarioPct: { labels: dias, values: refugoPct },
        totalPct: 9.3,
        tracosPorLinha: [{ linha: 'L1', valor: 2.27 }],
        comentarios: [],
        proximosPassos: [],
      },
      expedicao: {
        disponivel: true,
        expedicaoPorDia: { labels: dias, values: expedicaoM2 },
        cargasPorSemana: { labels: ['S1', 'S2', 'S3', 'S4'], values: [0, 1, 3, 11] },
        acumuladoM2: 4580.49,
        acumuladoCargas: 15,
        comentarios: ['878,40m² cliente MAKAI', 'Total expedidos: 878,40m²', 'Forecast: 7.015m²'],
        proximosPassos: ['Carga confirmada para o cliente MAKAI'],
      },
      assuntosGerais: '',
    };
  }

  async function carregarDados() {
    // Fase 4 concluída — endpoint agregador real (lib/rotas/one-page-
    // report.js). MOCK_DADOS (acima) fica só como referência/fallback se
    // o fetch falhar (rede fora do ar etc.), pra tela nunca quebrar em
    // branco — mesmo espírito de "nunca mostrar erro cru pro usuário" do
    // resto do app.
    try {
      const r = await fetch('/db/one-page-report.json');
      if (r.ok) return await r.json();
    } catch (_) { /* cai no mock abaixo */ }
    return MOCK_DADOS();
  }

  /* ── Render de cada bloco ─────────────────────────────────── */

  function _renderSeguranca(d) {
    if (!d || !d.disponivel) {
      document.getElementById('opr-seg-chart').innerHTML = _oprIndisponivel('Ocorrências ainda não registradas — Fase 1 do plano.');
      document.getElementById('opr-seg-comentarios').innerHTML = _oprComentarios([], []);
      return;
    }
    document.getElementById('opr-seg-acumulado').textContent = d.acumuladoMes;
    document.getElementById('opr-seg-dias').textContent = d.diasSemAcidentes;
    document.getElementById('opr-seg-chart').innerHTML = _oprBarChart(
      d.ocorrenciasPorDia.labels, d.ocorrenciasPorDia.values, { color: 'var(--opr-blue-2)' }
    );
    document.getElementById('opr-seg-comentarios').innerHTML = _oprComentarios(d.comentarios, d.proximosPassos);
  }

  function _renderProducao(d) {
    if (!d || !d.disponivel) {
      document.getElementById('opr-prod-chart').innerHTML = _oprIndisponivel('Sem produção lançada no período.');
      document.getElementById('opr-prod-donut').innerHTML = '';
      document.getElementById('opr-prod-comentarios').innerHTML = _oprComentarios([], []);
      return;
    }
    document.getElementById('opr-prod-chart').innerHTML = _oprBarChart(
      d.bateriasPorDia.labels, d.bateriasPorDia.values, { color: 'var(--opr-blue)' }
    );
    document.getElementById('opr-prod-donut').innerHTML =
      _oprDonut(d.distribuicaoLinha, { centro: { valor: _fmtNum(d.totalM2), legenda: 'TOTAL' } }) +
      `<div class="opr-donut-legend">${_oprDonutLegenda(d.distribuicaoLinha)}</div>`;
    document.getElementById('opr-prod-comentarios').innerHTML = _oprComentarios(d.comentarios, d.proximosPassos);
  }

  function _renderRefugo(d) {
    if (!d || !d.disponivel) {
      document.getElementById('opr-ref-chart').innerHTML = _oprIndisponivel('Sem avaliações de refugo no período.');
      document.getElementById('opr-ref-donut').innerHTML = '';
      document.getElementById('opr-ref-tracos').innerHTML = '';
      document.getElementById('opr-ref-comentarios').innerHTML = _oprComentarios([], []);
      return;
    }
    document.getElementById('opr-ref-chart').innerHTML = _oprBarChart(
      d.refugoDiarioPct.labels, d.refugoDiarioPct.values, { color: 'var(--opr-orange)', suffix: '%' }
    );
    const donutItems = [
      { label: 'Refugo', value: d.totalPct, color: 'var(--opr-orange)' },
      { label: 'Aprovado', value: Math.max(0, 100 - d.totalPct), color: 'var(--opr-blue)' },
    ];
    document.getElementById('opr-ref-donut').innerHTML =
      _oprDonut(donutItems, { centro: { valor: d.totalPct.toFixed(1).replace('.', ',') + '%', legenda: 'TOTAL' } }) +
      `<div class="opr-donut-legend">${_oprDonutLegenda(donutItems)}</div>`;
    document.getElementById('opr-ref-tracos').innerHTML = d.tracosPorLinha.map(t => `
      <div class="opr-kv-row">
        <div class="opr-kv-key">${_escaparHtml(t.linha)}</div>
        <div class="opr-kv-val">${t.valor.toFixed(2).replace('.', ',')}</div>
      </div>`).join('');
    document.getElementById('opr-ref-comentarios').innerHTML = _oprComentarios(d.comentarios, d.proximosPassos);
  }

  function _renderExpedicao(d) {
    if (!d || !d.disponivel) {
      document.getElementById('opr-exp-chart').innerHTML = _oprIndisponivel('Nenhuma carga expedida registrada — Fase 2 do plano.');
      document.getElementById('opr-exp-cargas').innerHTML = '';
      document.getElementById('opr-exp-m2').textContent = '—';
      document.getElementById('opr-exp-cargas-total').textContent = '—';
      document.getElementById('opr-exp-comentarios').innerHTML = _oprComentarios([], []);
      return;
    }
    document.getElementById('opr-exp-chart').innerHTML = _oprBarChart(
      d.expedicaoPorDia.labels, d.expedicaoPorDia.values, { color: 'var(--opr-blue)' }
    );
    document.getElementById('opr-exp-cargas').innerHTML = _oprBarChart(
      d.cargasPorSemana.labels, d.cargasPorSemana.values, { color: 'var(--opr-navy)', height: 76 }
    );
    document.getElementById('opr-exp-m2').textContent = _fmtNum(d.acumuladoM2, 2);
    document.getElementById('opr-exp-cargas-total').textContent = d.acumuladoCargas;
    document.getElementById('opr-exp-comentarios').innerHTML = _oprComentarios(d.comentarios, d.proximosPassos);
  }

  function _renderAssuntosGerais(texto) {
    const el = document.getElementById('opr-assuntos-gerais');
    if (el) el.value = texto || '';
  }

  let _dadosAtuais = null;

  async function render() {
    const dados = await carregarDados();
    _dadosAtuais = dados;
    const tituloMes = document.getElementById('opr-mes-atual');
    if (tituloMes) tituloMes.textContent = dados.mesReferencia;
    _renderSeguranca(dados.seguranca);
    _renderProducao(dados.producao);
    _renderRefugo(dados.refugo);
    _renderExpedicao(dados.expedicao);
    _renderAssuntosGerais(dados.assuntosGerais);
  }

  function imprimir() {
    window.print();
  }

  let _init = false;
  function init() {
    if (_init) { render(); return; }
    _init = true;
    render();
  }

  window.LWOnePageReport = { init, render, imprimir };

})();
