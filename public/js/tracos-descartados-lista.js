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
// original ("não deve entrar em dashboard") continua satisfeito: aqui não
// tem nenhum cálculo de CEP/OEE/Taxa de Acerto em cima desses dados.
//
// Editar/excluir (README, item 8a das pendências) — reverte a decisão
// original de "só tem criação" (ver comentário antigo removido daqui):
// na prática, corrigir um valor digitado errado ou apagar um descarte
// lançado por engano é um caso real que apareceu depois — mesmo padrão
// de CRUD já usado por paradas.js (editar/excluir com o mesmo id).

// Editar/excluir (README, item 8a das pendências) — mesma área de
// permissão do registro ('injetora', ver lib/rotas/tracos-descartados.js);
// botões só aparecem pra quem tem essa área liberada (_perfilPodeEditar,
// app-core.js — mesmo padrão já usado em paradas.js/setor-qualidade.js/
// manutencao.js), mas o servidor sempre confere de novo em
// /editar-traco-descartado e /excluir-traco-descartado — isto aqui é só
// a parte visual.

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
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--text-3)">Nenhum traço descartado no período/filtro selecionado.</td></tr>';
      return;
    }

    // Mesmo padrão de paradas.js/setor-qualidade.js/manutencao.js: botões
    // só aparecem pra quem tem a área 'injetora' de edição liberada — o
    // servidor confere de novo em /editar-traco-descartado e
    // /excluir-traco-descartado, isto aqui é só a parte visual.
    const podeEditar = typeof _perfilPodeEditar === 'function' ? _perfilPodeEditar('injetora') : true;

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
        <td style="padding:10px 14px;text-align:right;white-space:nowrap">
          ${podeEditar ? `
            <button class="btn btn-ghost btn-sm" title="Editar" onclick="LWTracosDescartados.abrirEdicao('${t.id}')">✏</button>
            <button class="btn btn-ghost btn-sm" style="color:var(--red)" title="Excluir" onclick="LWTracosDescartados.confirmarExclusao('${t.id}')">✕</button>
          ` : ''}
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

  // ── Edição/Exclusão (README, item 8a) ────────────────────────────────────

  async function persistirEdicaoTracoDescartado(payload) {
    const r = await fetch('/editar-traco-descartado', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.erro || 'Erro ao editar traço descartado.');
    return data;
  }

  async function excluirTracoDescartadoServidor(id) {
    const r = await fetch('/excluir-traco-descartado', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.erro || 'Erro ao excluir traço descartado.');
    return data;
  }

  function abrirEdicao(id) {
    const traco = _tracosDescartados.find(t => t.id === id);
    if (!traco) return;
    document.getElementById('tde-id').value            = traco.id;
    document.getElementById('tde-data').value           = traco.data || '';
    document.getElementById('tde-turno').value          = traco.turno || '';
    document.getElementById('tde-cimento').value        = traco.cimento ?? '';
    document.getElementById('tde-agua').value           = traco.agua ?? '';
    document.getElementById('tde-eps').value            = traco.eps ?? '';
    document.getElementById('tde-superplast').value     = traco.superplast ?? '';
    document.getElementById('tde-incorporador').value   = traco.incorporador ?? '';
    document.getElementById('tde-tempo-batida').value   = traco.tempo_batida ?? '';
    document.getElementById('tde-motivo').value         = traco.motivo || '';
    const erroEl = document.getElementById('tde-erro');
    erroEl.style.display = 'none';
    erroEl.textContent = '';
    document.getElementById('editar-traco-descartado-modal').style.display = 'flex';
  }

  function fecharModalEdicao() {
    document.getElementById('editar-traco-descartado-modal').style.display = 'none';
  }

  async function salvarEdicao() {
    const erroEl = document.getElementById('tde-erro');
    erroEl.style.display = 'none';
    erroEl.textContent = '';

    const motivo = document.getElementById('tde-motivo').value.trim();
    if (!motivo) {
      erroEl.textContent = 'Motivo é obrigatório.';
      erroEl.style.display = 'block';
      return;
    }

    const numOuNull = (id) => {
      const v = document.getElementById(id).value;
      return v === '' ? null : Number(v);
    };

    const payload = {
      id: document.getElementById('tde-id').value,
      data: document.getElementById('tde-data').value || null,
      turno: document.getElementById('tde-turno').value.trim() || null,
      cimento: numOuNull('tde-cimento'),
      agua: numOuNull('tde-agua'),
      eps: numOuNull('tde-eps'),
      superplast: numOuNull('tde-superplast'),
      incorporador: numOuNull('tde-incorporador'),
      tempo_batida: numOuNull('tde-tempo-batida'),
      motivo,
    };

    const btn = document.getElementById('tde-btn-salvar');
    btn.disabled = true;
    btn.textContent = 'Salvando…';
    try {
      await persistirEdicaoTracoDescartado(payload);
      fecharModalEdicao();
      await render();
      LW.mostrarAlerta('Traço descartado atualizado com sucesso.', { tipo: 'sucesso' });
    } catch (e) {
      erroEl.textContent = e.message;
      erroEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = '💾 Salvar';
    }
  }

  async function confirmarExclusao(id) {
    const confirmou = await LW.mostrarConfirmacao(
      'Excluir este traço descartado? Essa ação não pode ser desfeita.',
      { tipo: 'perigo', textoConfirmar: 'Excluir' }
    );
    if (!confirmou) return;
    try {
      await excluirTracoDescartadoServidor(id);
      await render();
      LW.mostrarAlerta('Traço descartado excluído.', { tipo: 'sucesso' });
    } catch (e) {
      LW.mostrarAlerta(e.message || 'Erro ao excluir traço descartado.', { tipo: 'erro' });
    }
  }

  // ── API pública ─────────────────────────────────────────────────────────

  window.LWTracosDescartados = {
    init,
    render,
    aplicarFiltros,
    limparFiltros,
    abrirEdicao,
    fecharModalEdicao,
    salvarEdicao,
    confirmarExclusao,
  };

})();
