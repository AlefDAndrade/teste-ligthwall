// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  metas.js — Metas de Produção (traços/m²/OEE do mês)
// ============================================================
// Compara 3 indicadores do mês corrente (1º dia do mês até hoje) contra
// metas definidas pelo Administrador: nº de traços, m² produzidos e OEE
// (%). As metas em si são só 3 números — guardados em db/metas.json (ver
// POST /salvar-metas, server.js), separado de config.json de propósito
// (ver comentário lá pro porquê).
//
// O cálculo de OEE aqui é uma cópia autocontida do mesmo algoritmo de
// oee.js (Disponibilidade × Performance × Qualidade — ver README, "OEE"),
// só que escopado ao mês corrente em vez de um período livre escolhido
// pelo usuário — mesmo espírito de já ter cópias próprias em tv.js e no
// HTML exportado de analise-focada.js: cada tela com uma janela de tempo
// diferente reaproveita o MESMO algoritmo, mas não a mesma função
// (evita acoplar telas que não precisam saber uma da outra).
'use strict';

(function () {

  const MINUTOS_TURNO_PLANEJADO = 7 * 60; // ver README, "OEE"
  const CICLO_IDEAL_MIN = 59;
  const CAMPOS_INSUMO = ['cimento_real', 'agua_real', 'eps_real', 'superplast_real', 'incorporador_real'];

  let _metasAtuais = { tracosMes: null, m2Mes: null, oeePercentMes: null };

  // ── Cálculo de OEE (réplica de oee.js, ver cabeçalho do arquivo) ──────
  function _normalizarInsumo(val) {
    if (val === null || val === undefined || val === '') return { ajustes: [] };
    if (typeof val === 'object' && 'ajustes' in val) {
      return { ajustes: Array.isArray(val.ajustes) ? val.ajustes : [] };
    }
    return { ajustes: [] };
  }
  function _tracoTemAjuste(t) {
    return CAMPOS_INSUMO.some(campo => _normalizarInsumo(t[campo]).ajustes.length > 0);
  }
  function _tempoMin(rec) {
    if (rec.tempo_min && rec.tempo_min > 0) return rec.tempo_min;
    if (rec.inicio && rec.fim) {
      const diff = (new Date(rec.fim) - new Date(rec.inicio)) / 60000;
      if (diff > 0) return diff;
    }
    return 0;
  }
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
      const overlapIni = Math.max(ini, pIni);
      const overlapFim = Math.min(fim, pFim);
      if (overlapFim > overlapIni) totalMs += (overlapFim - overlapIni);
    });
    return totalMs / 60000;
  }
  function _tempoProduzindoReal(rec, paradas) {
    return Math.max(0, _tempoMin(rec) - _minutosParadaNaoPlanejadaNaJanela(rec.inicio, rec.fim, paradas));
  }

  // Disponibilidade × Performance × Qualidade, agregados pro mês inteiro
  // (soma todos os turnos-instância que já rodaram no período) — devolve
  // null se ainda não houve nenhuma operação no mês (evita "OEE 0%"
  // enganoso logo no início do mês, sem nenhum dado ainda).
  function _calcularOeeMes(historicoMes, tracosMes, paradas) {
    if (!historicoMes.length) return null;

    const tempoProduzindo = historicoMes.reduce((s, r) => s + _tempoProduzindoReal(r, paradas), 0);
    const nTurnos = new Set(historicoMes.map(r => `${r.data}__${r.turno}`)).size;
    const tempoPlanejado = Math.max(1, nTurnos) * MINUTOS_TURNO_PLANEJADO;
    const dispPct = Math.min(100, (tempoProduzindo / tempoPlanejado) * 100);

    const tempoRealBruto = historicoMes.reduce((s, r) => s + _tempoMin(r), 0);
    const tempoIdeal = historicoMes.length * CICLO_IDEAL_MIN;
    const perfPct = tempoRealBruto > 0 ? Math.min(100, (tempoIdeal / tempoRealBruto) * 100) : 0;

    if (!tracosMes.length) return { pct: null, dispPct, perfPct, qualPct: null };
    const comAjuste = tracosMes.filter(_tracoTemAjuste).length;
    const qualPct = ((tracosMes.length - comAjuste) / tracosMes.length) * 100;

    const pct = (dispPct / 100) * (perfPct / 100) * (qualPct / 100) * 100;
    return { pct, dispPct, perfPct, qualPct };
  }

  // ── Formatação ──────────────────────────────────────────────
  function _fmtNum(n) {
    return Math.round(n).toLocaleString('pt-BR');
  }

  // ── Um card de progresso genérico: valor atual vs meta ────────────────
  // `meta` null/undefined = "meta não definida" (mostra só o valor atual,
  // sem barra de progresso nem comparação — não força um alvo que o
  // Administrador ainda não escolheu).
  function _renderCardMeta(titulo, icone, valorAtual, meta, sufixo) {
    if (meta === null || meta === undefined) {
      return `
        <div class="card-title" style="margin-bottom:10px">${icone} ${titulo}</div>
        <div style="font-family:var(--font-mono);font-size:2rem;font-weight:700;color:var(--text)">${_fmtNum(valorAtual)}${sufixo}</div>
        <div style="margin-top:8px;font-size:.82rem;color:var(--text-3)">Meta não definida ainda.</div>
      `;
    }

    const pct = meta > 0 ? (valorAtual / meta) * 100 : 0;
    const pctBarra = Math.min(100, pct);
    const atingiu = pct >= 100;
    const cor = atingiu ? 'var(--green)' : 'var(--accent)';

    return `
      <div class="card-title" style="margin-bottom:10px">${icone} ${titulo}</div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px">
        <span style="font-family:var(--font-mono);font-size:1.9rem;font-weight:700;color:var(--text)">${_fmtNum(valorAtual)}${sufixo}</span>
        <span style="color:var(--text-3);font-size:.9rem">de ${_fmtNum(meta)}${sufixo}</span>
      </div>
      <div style="height:10px;background:var(--bg-2);border-radius:999px;overflow:hidden;margin:10px 0 8px">
        <div style="height:100%;width:${pctBarra}%;background:${cor};border-radius:999px;transition:width .3s"></div>
      </div>
      <div style="font-size:.85rem;color:${atingiu ? 'var(--green)' : 'var(--text-2)'};font-weight:${atingiu ? '700' : '400'}">
        ${atingiu ? `✅ Meta batida! +${_fmtNum(valorAtual - meta)}${sufixo} acima do alvo.` : `${pct.toFixed(0)}% da meta — faltam ${_fmtNum(meta - valorAtual)}${sufixo}.`}
      </div>
    `;
  }

  // ── Carrega metas.json (defaults quando ainda não existe/404) ────────
  async function _carregarMetas() {
    try {
      const res = await fetch('db/metas.json?_=' + Date.now());
      if (!res.ok) return { tracosMes: null, m2Mes: null, oeePercentMes: null };
      const json = await res.json();
      return {
        tracosMes: json.tracosMes ?? null,
        m2Mes: json.m2Mes ?? null,
        oeePercentMes: json.oeePercentMes ?? null,
      };
    } catch (_) {
      return { tracosMes: null, m2Mes: null, oeePercentMes: null };
    }
  }

  async function render() {
    const loading = document.getElementById('metas-loading');
    const content = document.getElementById('metas-content');
    if (loading) loading.style.display = '';
    if (content) content.style.display = 'none';

    const { ini, fim } = LW.calcularPeriodoPreset('mes');

    const [metas, stats, tracosTodos, paradasTodas] = await Promise.all([
      _carregarMetas(),
      LW.getStats({ dataInicio: ini, dataFim: fim }),
      fetch('db/relatorio_injecao.json').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('db/paradas.json').then(r => r.ok ? r.json() : []).catch(() => []),
    ]);

    _metasAtuais = metas;

    const tracosMes = (Array.isArray(tracosTodos) ? tracosTodos : []).filter(t => t.data >= ini && t.data <= fim);
    const m2Mes = stats.total_m2 || 0;
    const oee = _calcularOeeMes(stats.data || [], tracosMes, Array.isArray(paradasTodas) ? paradasTodas : []);

    if (loading) loading.style.display = 'none';
    if (content) content.style.display = '';

    document.getElementById('metas-card-tracos').innerHTML =
      _renderCardMeta('Traços do Mês', '🧪', tracosMes.length, metas.tracosMes, '');
    document.getElementById('metas-card-m2').innerHTML =
      _renderCardMeta('m² do Mês', '📐', m2Mes, metas.m2Mes, ' m²');
    document.getElementById('metas-card-oee').innerHTML = (oee === null || oee.pct === null)
      ? `<div class="card-title" style="margin-bottom:10px">🎯 OEE do Mês</div>
         <div style="color:var(--text-3);font-size:.9rem;padding:10px 0">Ainda sem dado suficiente este mês (nenhuma operação/traço registrado).</div>`
      : _renderCardMeta('OEE do Mês', '🎯', oee.pct, metas.oeePercentMes, '%');
  }

  // ── Edição (admin) ────────────────────────────────────────────
  function abrirEdicao() {
    const form = document.getElementById('metas-form-card');
    if (!form) return;
    document.getElementById('metas-input-tracos').value = _metasAtuais.tracosMes ?? '';
    document.getElementById('metas-input-m2').value = _metasAtuais.m2Mes ?? '';
    document.getElementById('metas-input-oee').value = _metasAtuais.oeePercentMes ?? '';
    form.style.display = '';
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function cancelarEdicao() {
    const form = document.getElementById('metas-form-card');
    if (form) form.style.display = 'none';
  }

  // POST /salvar-metas agora exige sessão de Administrador (ver
  // lib/sessao.js, server.js) — pede a senha aqui se ainda não houver
  // sessão válida (mesmo padrão de cfgSalvar, app-core.js).
  async function salvar() {
    const btn = document.getElementById('btn-metas-salvar');
    const payload = {
      tracosMes: document.getElementById('metas-input-tracos').value,
      m2Mes: document.getElementById('metas-input-m2').value,
      oeePercentMes: document.getElementById('metas-input-oee').value,
    };
    if (typeof AdminAuth === 'undefined') {
      if (LW.mostrarAlerta) LW.mostrarAlerta('Não foi possível confirmar a senha de administrador nesta tela.', { tipo: 'erro' });
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }
    AdminAuth.abrirModal(async function onSuccess() {
      try {
        const res = await fetch('/salvar-metas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.erro || 'Erro ao salvar.');
        cancelarEdicao();
        await render();
        if (LW.mostrarAlerta) LW.mostrarAlerta('Metas atualizadas com sucesso.', { tipo: 'sucesso' });
      } catch (err) {
        console.error('Falha ao salvar metas:', err);
        if (LW.mostrarAlerta) LW.mostrarAlerta('Não consegui salvar as metas agora: ' + err.message, { tipo: 'erro' });
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Salvar Metas'; }
      }
    }, function onCancel() {
      if (btn) { btn.disabled = false; btn.textContent = 'Salvar Metas'; }
    });
  }

  function init() {
    render();
  }

  window.LWMetas = { init, render, abrirEdicao, cancelarEdicao, salvar };

})();
