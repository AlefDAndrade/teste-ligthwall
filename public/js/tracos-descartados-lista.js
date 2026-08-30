// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  tracos-descartados-lista.js — Histórico de Traços Descartados (Perda)
// ============================================================
//
// Ver README, "Registro de Traço Descartado (Perda) — plano". Esta tela é
// o que ficou marcado como "Fora de escopo" no plano original — decisão
// deliberada de deixar pra depois, exatamente pra não vazar sem querer
// pra dentro de um dashboard já existente (CEP do Setor de Qualidade,
// Análise Focada). Agora que é uma tela NOVA e dedicada, o próprio pedido
// original ("não deve entrar em dashboard") continua satisfeito: aqui é
// só leitura do histórico, sem nenhum cálculo de CEP/OEE/Taxa de Acerto
// em cima desses dados.
//
// Só LEITURA de propósito — não existe editar/excluir aqui (diferente de
// paradas.js): um traço descartado nasce e morre no ato do registro (ver
// lib/rotas/tracos-descartados.js, "este domínio só tem CRIAÇÃO"), então
// não faz sentido nenhum botão de ação na tabela.

'use strict';

(function () {

  // ── Estado local ────────────────────────────────────────────────────────

  let _tracosDescartados = [];  // cache de db/tracos_descartados.json
  let _filtros = {
    dataInicio: '',
    dataFim: '',
    busca: '',        // busca livre no motivo/operador
  };

  // ── Utilitários ─────────────────────────────────────────────────────────

  function formatarDataHora(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const pad2 = n => String(n).padStart(2, '0');
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function formatarKg(v) {
    return (v === null || v === undefined || v === '') ? '—' : Number(v).toFixed(2);
  }

  // ── Carregamento de dados ───────────────────────────────────────────────

  async function carregarTracosDescartados() {
    try {
      const r = await fetch('db/tracos_descartados.json?_=' + Date.now());
      if (!r.ok) { _tracosDescartados = []; return; }
      _tracosDescartados = await r.json();
      if (!Array.isArray(_tracosDescartados)) _tracosDescartados = [];
    } catch (_) {
      _tracosDescartados = [];
    }
  }

  // ── Filtros ─────────────────────────────────────────────────────────────

  function tracosFiltrados() {
    return _tracosDescartados.filter(t => {
      // t.data já vem no formato "AAAA-MM-DD" (preenchido automaticamente
      // pelo modal de descarte em operacao.js, a partir da data local da
      // operação) — comparação direta de string funciona sem conversão
      // de fuso, diferente de paradas (que compara sobre um instante ISO
      // em UTC — ver dataBrasiliaDeISO, data.js).
      if (_filtros.dataInicio && (t.data || '') < _filtros.dataInicio) return false;
      if (_filtros.dataFim && (t.data || '') > _filtros.dataFim) return false;
      if (_filtros.busca) {
        const alvo = `${t.motivo || ''} ${t.operador_nome || ''}`.toLowerCase();
        if (!alvo.includes(_filtros.busca.toLowerCase())) return false;
      }
      return true;
    });
  }

  function aplicarFiltros() {
    _filtros.dataInicio = document.getElementById('tracos-descartados-filtro-inicio')?.value || '';
    _filtros.dataFim    = document.getElementById('tracos-descartados-filtro-fim')?.value || '';
    _filtros.busca      = document.getElementById('tracos-descartados-filtro-busca')?.value || '';
    renderizarTabela();
    renderizarKPIs();
  }

  function limparFiltros() {
    ['tracos-descartados-filtro-inicio', 'tracos-descartados-filtro-fim', 'tracos-descartados-filtro-busca'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    _filtros = { dataInicio: '', dataFim: '', busca: '' };
    renderizarTabela();
    renderizarKPIs();
  }

  // ── KPIs ────────────────────────────────────────────────────────────────
  // Só contagem + soma de insumos perdidos — de propósito NÃO é um "CEP":
  // sem desvio-padrão, sem taxa de acerto, sem ranking de receita. Esta
  // tela é só visibilidade do que foi perdido, não controle estatístico.

  function renderizarKPIs() {
    const lista = tracosFiltrados();
    const somar = campo => lista.reduce((s, t) => s + (Number(t[campo]) || 0), 0);

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('tracos-descartados-kpi-total',        lista.length);
    set('tracos-descartados-kpi-cimento',      formatarKg(somar('cimento')) + ' kg');
    set('tracos-descartados-kpi-agua',         formatarKg(somar('agua')) + ' kg');
    set('tracos-descartados-kpi-eps',          formatarKg(somar('eps')) + ' kg');
  }

  // ── Tabela ──────────────────────────────────────────────────────────────

  function renderizarTabela() {
    const tbody = document.getElementById('tracos-descartados-tbody');
    if (!tbody) return;
    const lista = tracosFiltrados();

    if (!lista.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-3)">Nenhum traço descartado no período/filtro selecionado.</td></tr>';
      return;
    }

    tbody.innerHTML = lista.map(t => `
      <tr>
        <td style="padding:10px 14px;white-space:nowrap">${LW.escaparHtml(t.data || '—')}${t.turno ? ' · Turno ' + LW.escaparHtml(t.turno) : ''}</td>
        <td style="padding:10px 14px;text-align:right">${formatarKg(t.cimento)}</td>
        <td style="padding:10px 14px;text-align:right">${formatarKg(t.agua)}</td>
        <td style="padding:10px 14px;text-align:right">${formatarKg(t.eps)}</td>
        <td style="padding:10px 14px;text-align:right">${formatarKg(t.superplast)}</td>
        <td style="padding:10px 14px;text-align:right">${formatarKg(t.incorporador)}</td>
        <td style="padding:10px 14px;max-width:280px">${LW.escaparHtml(t.motivo || '—')}</td>
        <td style="padding:10px 14px;white-space:nowrap;color:var(--text-2)">
          ${LW.escaparHtml(t.operador_nome || '—')}<br>
          <span style="font-size:.72rem;color:var(--text-3)">${formatarDataHora(t.registrado_em)}</span>
        </td>
      </tr>
    `).join('');
  }

  // ── Inicialização ───────────────────────────────────────────────────────

  async function init() {
    await carregarTracosDescartados();
    renderizarTabela();
    renderizarKPIs();
  }

  // Chamado toda vez que a aba é reaberta (mesmo padrão de LWParadas —
  // ver showPage, app-core.js) — refaz o fetch pra sempre mostrar o
  // descarte mais recente, sem precisar de F5.
  async function render() {
    await carregarTracosDescartados();
    renderizarTabela();
    renderizarKPIs();
  }

  // ── API pública ─────────────────────────────────────────────────────────

  window.LWTracosDescartados = {
    init,
    render,
    aplicarFiltros,
    limparFiltros,
  };

})();
