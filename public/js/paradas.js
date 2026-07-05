// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  paradas.js — Módulo de Registro de Paradas
// ============================================================

'use strict';

(function () {

  // ── Constantes ────────────────────────────────────────────────────────────

  const CLASSIFICACAO_OPTS = ['Não Planejada', 'Planejada'];

  const MOTIVO_OPTS = [
    'Manutenção Corretiva',
    'Manutenção Preventiva',
    'Falta de Material',
    'Falta de Operador',
    'Setup / Troca de Produto',
    'Problema Elétrico',
    'Problema Mecânico',
    'Problema Hidráulico',
    'Limpeza / Organização',
    'Reunião / Treinamento',
    'Parada de Qualidade',
    'Aguardando Liberação',
    'Pausa de Descanso',
    'Outro',
  ];

  // ── Estado local ──────────────────────────────────────────────────────────

  let _paradas = [];           // cache do paradas.json
  let _modoEdicao = null;      // id da parada em edição, ou null
  let _filtros = {
    dataInicio: '',
    dataFim: '',
    classificacao: '',
    motivo: '',
    equipamento: '',
  };

  // ── Utilitários ───────────────────────────────────────────────────────────

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatarDuracao(minutos) {
    if (minutos == null || isNaN(minutos)) return '—';
    const h = Math.floor(minutos / 60);
    const m = minutos % 60;
    return h > 0 ? `${h}h ${pad2(m)}min` : `${m}min`;
  }

  function formatarDataHora(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function calcDuracao(inicio, fim) {
    if (!inicio || !fim) return null;
    const diffMs = new Date(fim) - new Date(inicio);
    if (diffMs < 0) return null;
    return Math.round(diffMs / 60000);
  }

  // Retorna datetime-local string (YYYY-MM-DDTHH:MM) do momento atual em Brasília
  function nowLocalString() {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const get = t => parts.find(p => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  }

  // ── Carregamento de dados ─────────────────────────────────────────────────

  async function carregarParadas() {
    try {
      const r = await fetch('db/paradas.json?_=' + Date.now());
      if (!r.ok) { _paradas = []; return; }
      _paradas = await r.json();
      if (!Array.isArray(_paradas)) _paradas = [];
    } catch (_) {
      _paradas = [];
    }
  }

  // ── Persistência ──────────────────────────────────────────────────────────

  async function salvarParada(parada) {
    const r = await fetch('/salvar-parada', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parada),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.erro || 'Erro ao salvar parada.');
    return data;
  }

  async function excluirParadaServidor(id) {
    const r = await fetch('/excluir-parada', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.erro || 'Erro ao excluir parada.');
    return data;
  }

  // ── Formulário de registro ────────────────────────────────────────────────

  function preencherSelects() {
    const selMotivo = document.getElementById('parada-motivo');
    const selClass  = document.getElementById('parada-classificacao');
    if (!selMotivo || !selClass) return;

    selMotivo.innerHTML = '<option value="">Selecione o motivo</option>' +
      MOTIVO_OPTS.map(m => `<option value="${m}">${m}</option>`).join('');

    selClass.innerHTML = '<option value="">Selecione</option>' +
      CLASSIFICACAO_OPTS.map(c => `<option value="${c}">${c}</option>`).join('');
  }

  function resetForm() {
    _modoEdicao = null;
    const ids = ['parada-inicio', 'parada-fim', 'parada-motivo',
                 'parada-equipamento', 'parada-classificacao', 'parada-obs'];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('parada-duracao-preview').textContent = '—';
    document.getElementById('parada-form-title').textContent = '＋ Nova Parada';
    document.getElementById('btn-cancelar-edicao-parada').style.display = 'none';
    atualizarDuracaoPreview();
  }

  function atualizarDuracaoPreview() {
    const inicio = document.getElementById('parada-inicio')?.value;
    const fim    = document.getElementById('parada-fim')?.value;
    const dur    = calcDuracao(inicio, fim);
    const el     = document.getElementById('parada-duracao-preview');
    if (!el) return;
    if (dur === null) {
      el.textContent = '—';
      el.style.color = 'var(--text-3)';
    } else if (dur <= 0) {
      el.textContent = 'Fim deve ser após o início';
      el.style.color = 'var(--red)';
    } else {
      el.textContent = formatarDuracao(dur);
      el.style.color = 'var(--green)';
    }
  }

  function preencherForm(parada) {
    _modoEdicao = parada.id;
    document.getElementById('parada-inicio').value        = parada.inicio?.slice(0, 16) || '';
    document.getElementById('parada-fim').value           = parada.fim?.slice(0, 16) || '';
    document.getElementById('parada-motivo').value        = parada.motivo || '';
    document.getElementById('parada-equipamento').value   = parada.equipamento || '';
    document.getElementById('parada-classificacao').value = parada.classificacao || '';
    document.getElementById('parada-obs').value           = parada.obs || '';
    document.getElementById('parada-form-title').textContent = '✏ Editar Parada';
    document.getElementById('btn-cancelar-edicao-parada').style.display = '';
    atualizarDuracaoPreview();
    document.getElementById('parada-form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function salvarFormParada() {
    const inicio         = document.getElementById('parada-inicio').value;
    const fim            = document.getElementById('parada-fim').value;
    const motivo         = document.getElementById('parada-motivo').value.trim();
    const equipamento    = document.getElementById('parada-equipamento').value.trim();
    const classificacao  = document.getElementById('parada-classificacao').value;
    const obs            = document.getElementById('parada-obs').value.trim();

    if (!inicio)        { mostrarToast('Informe o horário de início.', 'erro'); return; }
    if (!fim)           { mostrarToast('Informe o horário de término.', 'erro'); return; }
    if (!motivo)        { mostrarToast('Selecione o motivo da parada.', 'erro'); return; }
    if (!classificacao) { mostrarToast('Selecione a classificação.', 'erro'); return; }

    const duracao = calcDuracao(inicio, fim);
    if (duracao === null || duracao <= 0) {
      mostrarToast('O horário de término deve ser posterior ao início.', 'erro');
      return;
    }

    const parada = {
      id:             _modoEdicao || crypto.randomUUID(),
      inicio:         new Date(inicio).toISOString(),
      fim:            new Date(fim).toISOString(),
      duracao_min:    duracao,
      motivo,
      equipamento,
      classificacao,
      obs,
      registrado_em:  new Date().toISOString(),
    };

    const btn = document.getElementById('btn-salvar-parada');
    btn.disabled = true;
    btn.textContent = 'Salvando…';

    try {
      await salvarParada(parada);
      mostrarToast(_modoEdicao ? 'Parada atualizada com sucesso.' : 'Parada registrada com sucesso.', 'ok');
      resetForm();
      await carregarParadas();
      renderizarTabela();
      renderizarKPIs();
      renderizarGraficos();
    } catch (e) {
      mostrarToast('Erro: ' + e.message, 'erro');
    } finally {
      btn.disabled = false;
      btn.textContent = '✓ Salvar Parada';
    }
  }

  // ── Toast ─────────────────────────────────────────────────────────────────

  function mostrarToast(msg, tipo) {
    const el = document.getElementById('parada-toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'parada-toast parada-toast--' + (tipo === 'erro' ? 'erro' : 'ok');
    el.style.display = 'block';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.style.display = 'none'; }, 3500);
  }

  // ── KPIs ──────────────────────────────────────────────────────────────────

  function paradasFiltradas() {
    return _paradas.filter(p => {
      if (_filtros.dataInicio && p.inicio < _filtros.dataInicio) return false;
      if (_filtros.dataFim) {
        const fimDia = _filtros.dataFim + 'T23:59:59';
        if (p.inicio > fimDia) return false;
      }
      if (_filtros.classificacao && p.classificacao !== _filtros.classificacao) return false;
      if (_filtros.motivo && p.motivo !== _filtros.motivo) return false;
      if (_filtros.equipamento && !p.equipamento?.toLowerCase().includes(_filtros.equipamento.toLowerCase())) return false;
      return true;
    });
  }

  function renderizarKPIs() {
    const lista = paradasFiltradas();
    const totalMin = lista.reduce((s, p) => s + (p.duracao_min || 0), 0);
    const totalPlanejadas = lista.filter(p => p.classificacao === 'Planejada').length;
    const totalNaoPlanejadas = lista.filter(p => p.classificacao === 'Não Planejada').length;

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('parada-kpi-total',           lista.length);
    set('parada-kpi-tempo',           formatarDuracao(totalMin));
    set('parada-kpi-planejadas',      totalPlanejadas);
    set('parada-kpi-nao-planejadas',  totalNaoPlanejadas);
  }

  // ── Tabela de registros ───────────────────────────────────────────────────

  function renderizarTabela() {
    const tbody = document.getElementById('paradas-tbody');
    if (!tbody) return;
    const lista = paradasFiltradas();

    if (!lista.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--text-3)">Nenhuma parada registrada no período.</td></tr>`;
      return;
    }

    // Ordenar por início desc
    const sorted = [...lista].sort((a, b) => (b.inicio > a.inicio ? 1 : -1));

    tbody.innerHTML = sorted.map(p => {
      const badge = p.classificacao === 'Planejada'
        ? `<span class="badge badge-blue">Planejada</span>`
        : `<span class="badge badge-red">Não Planejada</span>`;
      // Registro de Paradas não é uma feature exclusiva de administrador —
      // qualquer perfil que acesse esta página pode editar/excluir registros.
      const canEdit = true;
      const btns = canEdit
        ? `<button class="btn btn-ghost btn-sm" onclick="LWParadas.editarParada('${p.id}')">✏</button>
           <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="LWParadas.confirmarExclusao('${p.id}')">✕</button>`
        : '';
      return `<tr>
        <td style="white-space:nowrap">${formatarDataHora(p.inicio)}</td>
        <td style="white-space:nowrap">${formatarDataHora(p.fim)}</td>
        <td>${formatarDuracao(p.duracao_min)}</td>
        <td>${p.motivo ? LW.escaparHtml(p.motivo) : '—'}</td>
        <td>${p.equipamento ? LW.escaparHtml(p.equipamento) : '—'}</td>
        <td>${badge}</td>
        <td style="white-space:nowrap">${btns}</td>
      </tr>`;
    }).join('');
  }

  // ── Gráficos ──────────────────────────────────────────────────────────────

  function renderizarGraficos() {
    renderizarGraficoPorMotivo();
    renderizarGraficoTendencia();
  }

  function renderizarGraficoPorMotivo() {
    const canvas = document.getElementById('paradas-chart-motivo');
    if (!canvas) return;
    const lista = paradasFiltradas();

    // Agrupa por motivo (tempo total)
    const map = {};
    lista.forEach(p => {
      map[p.motivo] = (map[p.motivo] || 0) + (p.duracao_min || 0);
    });

    const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!entries.length) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const labels = entries.map(e => e[0]);
    const values = entries.map(e => e[1]);
    drawHorizontalBar(canvas, labels, values, '#ef4444');
  }

  function renderizarGraficoTendencia() {
    const canvas = document.getElementById('paradas-chart-tendencia');
    if (!canvas) return;
    const lista = paradasFiltradas();

    // Agrupa por dia (quantidade de paradas)
    const map = {};
    lista.forEach(p => {
      const dia = p.inicio?.slice(0, 10);
      if (dia) map[dia] = (map[dia] || 0) + 1;
    });

    const keys = Object.keys(map).sort();
    if (!keys.length) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    drawBarChartParadas(canvas, keys.map(k => k.slice(5)), keys.map(k => map[k]), '#f59e0b');
  }

  function drawBarChartParadas(canvas, labels, values, color) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.offsetWidth || 600;
    const H = canvas.height = 180;
    ctx.clearRect(0, 0, W, H);

    const max = Math.max(...values, 1);
    const pad = { top: 16, right: 12, bottom: 28, left: 32 };
    const chartW = W - pad.left - pad.right;
    const chartH = H - pad.top - pad.bottom;
    const bw = Math.max(4, chartW / labels.length - 4);

    ctx.strokeStyle = '#2a2f3a';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + chartH * (1 - i / 4);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
      ctx.fillStyle = '#5c6475'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'right';
      ctx.fillText(Math.round(max * i / 4), pad.left - 4, y + 4);
    }

    labels.forEach((label, i) => {
      const x = pad.left + i * (chartW / labels.length) + (chartW / labels.length - bw) / 2;
      const barH = (values[i] / max) * chartH;
      const y = pad.top + chartH - barH;
      ctx.fillStyle = color; ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, bw, barH, [3, 3, 0, 0]) : ctx.rect(x, y, bw, barH);
      ctx.fill(); ctx.globalAlpha = 1;

      const step = Math.max(1, Math.floor(labels.length / 10));
      if (i % step === 0) {
        ctx.fillStyle = '#5c6475'; ctx.font = '9px Barlow, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(label, x + bw / 2, H - 6);
      }
    });
  }

  function drawHorizontalBar(canvas, labels, values, color) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.offsetWidth || 600;
    const rowH = 30;
    const H = canvas.height = Math.max(labels.length * rowH + 20, 80);
    ctx.clearRect(0, 0, W, H);

    const max = Math.max(...values, 1);
    const labelW = 180;
    const barAreaW = W - labelW - 60;

    labels.forEach((label, i) => {
      const y = i * rowH + 14;
      // Label
      ctx.fillStyle = '#9aa3b2'; ctx.font = '11px Barlow, sans-serif'; ctx.textAlign = 'right';
      const displayLabel = label.length > 22 ? label.slice(0, 20) + '…' : label;
      ctx.fillText(displayLabel, labelW - 8, y + 8);

      // Bar
      const bw = (values[i] / max) * barAreaW;
      ctx.fillStyle = color; ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(labelW, y, bw, 18, 3) : ctx.rect(labelW, y, bw, 18);
      ctx.fill(); ctx.globalAlpha = 1;

      // Value
      ctx.fillStyle = '#e8eaf0'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'left';
      ctx.fillText(formatarDuracao(values[i]), labelW + bw + 6, y + 12);
    });
  }

  // ── Filtros ───────────────────────────────────────────────────────────────

  function aplicarFiltros() {
    _filtros.dataInicio    = document.getElementById('paradas-filtro-inicio')?.value || '';
    _filtros.dataFim       = document.getElementById('paradas-filtro-fim')?.value || '';
    _filtros.classificacao = document.getElementById('paradas-filtro-class')?.value || '';
    _filtros.motivo        = document.getElementById('paradas-filtro-motivo')?.value || '';
    _filtros.equipamento   = document.getElementById('paradas-filtro-equip')?.value || '';
    renderizarTabela();
    renderizarKPIs();
    renderizarGraficos();
  }

  function limparFiltros() {
    ['paradas-filtro-inicio','paradas-filtro-fim','paradas-filtro-class',
     'paradas-filtro-motivo','paradas-filtro-equip'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    _filtros = { dataInicio:'', dataFim:'', classificacao:'', motivo:'', equipamento:'' };
    renderizarTabela();
    renderizarKPIs();
    renderizarGraficos();
  }

  function preencherFiltroMotivo() {
    const sel = document.getElementById('paradas-filtro-motivo');
    if (!sel) return;
    sel.innerHTML = '<option value="">Todos os motivos</option>' +
      MOTIVO_OPTS.map(m => `<option value="${m}">${m}</option>`).join('');
  }

  // ── Exclusão ──────────────────────────────────────────────────────────────

  async function confirmarExclusao(id) {
    const confirmou = await LW.mostrarConfirmacao(
      'A ação não pode ser desfeita.',
      { titulo: 'Excluir esta parada?', textoConfirmar: 'Excluir', tipo: 'perigo', icon: '🗑️' }
    );
    if (!confirmou) return;
    excluirParadaServidor(id).then(() => {
      mostrarToast('Parada excluída.', 'ok');
      _paradas = _paradas.filter(p => p.id !== id);
      renderizarTabela();
      renderizarKPIs();
      renderizarGraficos();
    }).catch(e => mostrarToast('Erro: ' + e.message, 'erro'));
  }

  function editarParada(id) {
    const p = _paradas.find(x => x.id === id);
    if (!p) return;
    preencherForm(p);
  }

  // ── Inicialização ─────────────────────────────────────────────────────────

  async function init() {
    preencherSelects();
    preencherFiltroMotivo();

    // Preenche início/fim padrão (últimos 30 dias)
    const hoje = typeof todayBrasilia === 'function' ? todayBrasilia() : new Date().toISOString().slice(0, 10);
    const d30  = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const fi   = document.getElementById('paradas-filtro-inicio');
    const ff   = document.getElementById('paradas-filtro-fim');
    if (fi) fi.value = d30;
    if (ff) ff.value = hoje;
    _filtros.dataInicio = d30;
    _filtros.dataFim    = hoje;

    // Preenche datetime de início com agora
    const ini = document.getElementById('parada-inicio');
    if (ini && !ini.value) ini.value = nowLocalString();

    await carregarParadas();
    renderizarTabela();
    renderizarKPIs();
    renderizarGraficos();

    // Eventos
    document.getElementById('parada-inicio')?.addEventListener('change', atualizarDuracaoPreview);
    document.getElementById('parada-fim')?.addEventListener('change', atualizarDuracaoPreview);
  }

  // ── API pública ───────────────────────────────────────────────────────────

  window.LWParadas = {
    init,
    salvarFormParada,
    aplicarFiltros,
    limparFiltros,
    editarParada,
    confirmarExclusao,
    cancelarEdicao() { resetForm(); },
  };

})();