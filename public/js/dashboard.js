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

  // ---- Desempenho por Turnos ----

  function initTurnos() {
    const today = todayBrasilia();
    const d30 = new Date(nowBrasilia().getTime() - 30 * 86400000).toISOString().split('T')[0];
    document.getElementById('turnos-data-inicio').value = d30;
    document.getElementById('turnos-data-fim').value = today;

    document.getElementById('btn-turnos-filtrar').addEventListener('click', renderTurnos);
    renderTurnos();
  }

  async function renderTurnos() {
    const inicio = document.getElementById('turnos-data-inicio').value;
    const fim = document.getElementById('turnos-data-fim').value;
    const s = await LW.getStats({ dataInicio: inicio, dataFim: fim });

    const turnos = ['1º TURNO', '2º TURNO', '3º TURNO'];
    const ids = ['t1', 't2', 't3'];

    turnos.forEach((t, i) => {
      const td = s.por_turno[t];
      const id = ids[i];
      document.getElementById(`${id}-baterias`).textContent = td.total;
      document.getElementById(`${id}-paineis`).textContent = td.paineis.toLocaleString('pt-BR');
      document.getElementById(`${id}-m2`).textContent = td.m2.toFixed(0) + ' m²';
      document.getElementById(`${id}-atraso`).textContent = td.total ? Math.round(td.atraso / td.total * 100) + '%' : '—';
      document.getElementById(`${id}-tempo`).textContent = LW.formatDuration(td.tempo_medio);
      document.getElementById(`${id}-2p`).textContent = td.paineis_2p.toLocaleString('pt-BR');
      document.getElementById(`${id}-sp`).textContent = td.paineis_sp.toLocaleString('pt-BR');
    });

    // Turno mais/menos eficiente (por m²)
    const byM2 = turnos.map(t => ({ t, m2: s.por_turno[t].m2 })).filter(x => x.m2 > 0);
    if (byM2.length) {
      byM2.sort((a, b) => b.m2 - a.m2);
      document.getElementById('melhor-turno').textContent = byM2[0].t;
      document.getElementById('pior-turno').textContent = byM2[byM2.length - 1].t;
    }

    // Bar charts por turno
    requestAnimationFrame(() => {
      drawBarChart('chart-turnos-m2', turnos.map(t => t.replace('º TURNO', '')), turnos.map(t => s.por_turno[t].m2), '#3b82f6');
      drawBarChart('chart-turnos-atraso', turnos.map(t => t.replace('º TURNO', '')), turnos.map(t => s.por_turno[t].atraso), '#ef4444');
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
        items.push({ icon: '⚠️', text: `${t}: alta taxa de atraso (${Math.round(td.atraso / td.total * 100)}%)` });
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

  // ================================================================
  //  ENGINE DE FILTROS HIERÁRQUICOS
  //  Compartilhada entre Registro de Baterias e Relatório de Injeção
  // ================================================================

  // ---- Estado dos filtros (Sets para multi-seleção) ----
  const _filtrosRegistro = {
    data_inicio: null, data_fim: null,
    id_bateria: new Set(), turno: new Set(),
    dimensao: new Set(), tipo_montagem: new Set(), atraso: new Set(),
  };

  // Modo de edição do Registro de Baterias — enquanto ativo, clicar numa
  // linha abre a edição da operação em vez de navegar pro Relatório de
  // Injeção (ver onClickLinhaRegistro()).
  let _modoEdicaoRegistro = false;

  const _filtrosRelatorio = {
    data_inicio: null, data_fim: null,
    id_bateria: new Set(), num_traco: new Set(),
    dimensao: new Set(), turno: new Set(),
    silo: new Set(), expansao: new Set(),
    id_traco: new Set(), // filtro de navegação via Registro de Baterias
    id_bateria_traco: new Set(), // só para exibição do chip "🔗 Bateria: X"
    op_navegacao: null, // id_operacao exato da bateria clicada — usado para filtrar (id_bateria pode repetir entre operações, id_operacao não)
    apenas_com_ajuste: false, // filtro rápido: mostra só traços que tiveram algum reajuste de receita
  };

  // Data de corte: produções anteriores a esta data não possuem vínculo de traço
  const TRACO_CUTOFF_DATE = '2026-06-05';

  // ---- Extrai valores únicos não-vazios de uma lista de objetos ----
  function _unicos(lista, campo) {
    return [...new Set(
      lista.map(r => r[campo]).filter(v => v !== null && v !== undefined && v !== '')
    )].sort((a, b) => String(a).localeCompare(String(b), 'pt-BR', { numeric: true }));
  }

  // ---- Gera categorias de filtro para Registro de Baterias ----
  function gerarCategoriasRegistro(dados) {
    return [
      { key: 'id_bateria', label: 'ID da Bateria', opcoes: _unicos(dados, 'id_bateria') },
      { key: 'dimensao', label: 'Dimensão', opcoes: _unicos(dados, 'dimensao') },
      { key: 'turno', label: 'Turno', opcoes: _unicos(dados, 'turno') },
      { key: 'tipo_montagem', label: 'Tipo de Montagem', opcoes: _unicos(dados, 'tipo_montagem') },
      { key: 'atraso', label: 'Atraso', opcoes: _unicos(dados, 'houve_atraso') },
    ].filter(c => c.opcoes.length > 0);
  }

  // ---- Gera categorias de filtro para Relatório de Injeção ----
  function gerarCategoriasRelatorio(linhas) {
    return [
      { key: 'id_bateria', label: 'ID da Bateria', opcoes: _unicos(linhas, 'id_bateria') },
      { key: 'num_traco', label: 'Nº Traço', opcoes: _unicos(linhas, 'num_traco').map(String) },
      { key: 'dimensao', label: 'Dimensão', opcoes: _unicos(linhas, 'dimensao') },
      { key: 'turno', label: 'Turno', opcoes: _unicos(linhas, 'turno') },
      { key: 'silo', label: 'Silo', opcoes: _unicos(linhas, 'silo') },
      { key: 'expansao', label: 'Expansão', opcoes: _unicos(linhas, 'expansao') },
    ].filter(c => c.opcoes.length > 0);
  }

  // ---- Constrói a UI de filtros hierárquicos ----
  // containerEl: id do div onde renderizar
  // cats: array de { key, label, opcoes[] }
  // filtrosObj: objeto de estado (_filtrosRegistro ou _filtrosRelatorio)
  // onChangeCb: função a chamar após cada alteração
  function buildFiltrosUI(containerId, cats, filtrosObj, onChangeCb) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    cats.forEach(cat => {
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'position:relative;display:inline-block';

      // Botão da categoria
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost btn-sm';
      btn.style.cssText = 'gap:5px;border-color:var(--border-2)';
      const ativos = filtrosObj[cat.key]?.size || 0;
      btn.innerHTML = `${cat.label}${ativos ? ` <span style="background:var(--accent);color:#000;border-radius:10px;padding:1px 6px;font-size:.65rem;font-weight:700">${ativos}</span>` : ''} <span style="opacity:.5;font-size:.7rem">▾</span>`;

      // Dropdown
      const dropdown = document.createElement('div');
      dropdown.style.cssText = [
        'position:absolute;top:calc(100% + 4px);left:0;z-index:200',
        'background:var(--bg-card);border:1px solid var(--border-2);border-radius:var(--radius-lg)',
        'min-width:180px;max-height:280px;overflow-y:auto;display:none',
        'box-shadow:0 8px 32px rgba(0,0,0,.5)',
      ].join(';');

      cat.opcoes.forEach(op => {
        const item = document.createElement('label');
        item.style.cssText = [
          'display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer',
          'font-size:.84rem;color:var(--text-2);transition:background .1s',
        ].join(';');
        item.onmouseover = () => item.style.background = 'var(--bg-3)';
        item.onmouseout = () => item.style.background = '';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = String(op);
        cb.checked = filtrosObj[cat.key]?.has(String(op)) || false;
        cb.style.cssText = 'accent-color:var(--accent);width:14px;height:14px;cursor:pointer';

        cb.addEventListener('change', () => {
          if (cb.checked) filtrosObj[cat.key].add(String(op));
          else filtrosObj[cat.key].delete(String(op));
          // Atualiza badge no botão
          const n = filtrosObj[cat.key].size;
          btn.innerHTML = `${cat.label}${n ? ` <span style="background:var(--accent);color:#000;border-radius:10px;padding:1px 6px;font-size:.65rem;font-weight:700">${n}</span>` : ''} <span style="opacity:.5;font-size:.7rem">▾</span>`;
          atualizarChips(containerId, filtrosObj, cats, onChangeCb);
          onChangeCb();
        });

        item.appendChild(cb);
        item.appendChild(document.createTextNode(String(op)));
        dropdown.appendChild(item);
      });

      // Toggle dropdown ao clicar no botão
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const aberto = dropdown.style.display === 'block';
        // Fecha todos os outros dropdowns
        document.querySelectorAll('.lw-filter-dropdown').forEach(d => d.style.display = 'none');
        dropdown.style.display = aberto ? 'none' : 'block';
      });

      // Fecha ao clicar fora
      document.addEventListener('click', () => { dropdown.style.display = 'none'; }, { passive: true });

      dropdown.classList.add('lw-filter-dropdown');
      wrapper.appendChild(btn);
      wrapper.appendChild(dropdown);
      container.appendChild(wrapper);
    });
  }

  // ---- Atualiza área de chips de filtros ativos ----
  function atualizarChips(containerId, filtrosObj, cats, onChangeCb) {
    const chipsId = 'chips-' + containerId;
    const limparId = 'btn-limpar-' + containerId;
    const chipsEl = document.getElementById(chipsId);
    const limparEl = document.getElementById(limparId);
    if (!chipsEl) return;

    // Coleta todos os filtros ativos
    const chips = [];
    cats.forEach(cat => {
      filtrosObj[cat.key]?.forEach(val => {
        chips.push({ key: cat.key, val, label: `${cat.label}: ${val}`, tipo: 'normal' });
      });
    });

    // Chips especiais de navegação por traço (id_traco)
    if (containerId === 'filtros-relatorio' && filtrosObj.id_traco && filtrosObj.id_traco.size) {
      filtrosObj.id_traco.forEach(val => {
        chips.push({ key: 'id_traco', val, label: `🔗 Traço: ${val}`, tipo: 'traco' });
      });
    }

    // Chip especial de navegação por bateria — restringe a exibição de
    // traços reaproveitados apenas ao uso feito nesta bateria. Removível,
    // assim o usuário pode ver os demais reaproveitamentos se quiser.
    if (containerId === 'filtros-relatorio' && filtrosObj.id_bateria_traco && filtrosObj.id_bateria_traco.size) {
      filtrosObj.id_bateria_traco.forEach(val => {
        chips.push({ key: 'id_bateria_traco', val, label: `🔗 Bateria: ${val}`, tipo: 'traco' });
      });
    }

    if (!chips.length) {
      chipsEl.innerHTML = '<span style="color:var(--text-3);font-size:.78rem">Nenhum filtro ativo</span>';
      if (limparEl) limparEl.style.display = 'none';
      return;
    }

    if (limparEl) limparEl.style.display = 'inline-flex';

    chipsEl.innerHTML = chips.map(c => {
      const isTraco = c.tipo === 'traco';
      const bg = isTraco ? 'rgba(59,130,246,.12)' : 'rgba(245,158,11,.12)';
      const border = isTraco ? 'rgba(59,130,246,.35)' : 'rgba(245,158,11,.3)';
      const color = isTraco ? 'var(--blue,#3b82f6)' : 'var(--accent)';
      return `
      <span style="
        display:inline-flex;align-items:center;gap:5px;
        background:${bg};border:1px solid ${border};
        border-radius:20px;padding:3px 10px;font-size:.76rem;color:${color};
      ">
        ${c.label}
        <button onclick="removerFiltro('${containerId}','${c.key}','${c.val}')"
          style="background:none;border:none;cursor:pointer;color:${color};font-size:.8rem;padding:0;line-height:1;opacity:.7"
          title="Remover">✕</button>
      </span>`;
    }).join('');
  }

  // ---- Remove um filtro individual via chip ----
  window.removerFiltro = function (containerId, key, val) {
    const filtrosObj = containerId === 'filtros-registro' ? _filtrosRegistro : _filtrosRelatorio;
    filtrosObj[key]?.delete(val);
    // Rebuild UI para refletir estado
    const rebuildFn = containerId === 'filtros-registro' ? initRegistro : initRelatorio;
    rebuildFn();
  };

  // ---- Limpa todos os filtros de um container ----
  window.limparTodosFiltros = function (containerId) {
    const filtrosObj = containerId === 'filtros-registro' ? _filtrosRegistro : _filtrosRelatorio;
    Object.keys(filtrosObj).forEach(k => {
      if (filtrosObj[k] instanceof Set) filtrosObj[k].clear();
      else filtrosObj[k] = null;
    });
    // Reseta inputs de data
    const prefix = containerId === 'filtros-registro' ? 'reg' : 'rel';
    const ini = document.getElementById(`${prefix}-data-inicio`);
    const fim = document.getElementById(`${prefix}-data-fim`);
    if (ini) ini.value = '';
    if (fim) fim.value = '';
    const rebuildFn = containerId === 'filtros-registro' ? initRegistro : initRelatorio;
    rebuildFn();
  };

  // ================================================================
  //  REGISTRO DE BATERIAS
  // ================================================================

  async function initRegistro() {
    const s = await LW.getStats();
    const cats = gerarCategoriasRegistro(s.data);
    buildFiltrosUI('filtros-registro', cats, _filtrosRegistro, renderRegistro);
    atualizarChips('filtros-registro', _filtrosRegistro, cats, renderRegistro);

    ['reg-data-inicio', 'reg-data-fim'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.removeEventListener('change', _onDataRegistro);
      el.addEventListener('change', _onDataRegistro);
    });

    // Detecta tipos de placa extras (ex: 3p) antes de montar o menu de colunas,
    // para que eles já apareçam na lista de checkboxes na primeira renderização.
    _garantirColunasDinamicasTipo(s.data);
    initColMenuRegistro();
    await renderRegistro();
  }

  function _onDataRegistro(e) {
    _filtrosRegistro[e.target.id === 'reg-data-inicio' ? 'data_inicio' : 'data_fim'] = e.target.value || null;
    renderRegistro();
  }

  // Cor do badge "Tipo de Montagem" — busca a cor de verdade vinculada ao
  // tipo SIMPLES (gerada automaticamente na tela de admin, "largest-gap hue
  // allocation" — ver data.js). Cai num cinza neutro pra tipos híbridos ou
  // sem cor própria ainda; cor de híbrido fica pra depois.
  function _corBadgeMontagem(label) {
    return LW.corMontagemPorLabel(label);
  }

  async function renderRegistro() {
    const s = await LW.getStats();
    let data = [...s.data];

    const f = _filtrosRegistro;
    if (f.data_inicio) data = data.filter(b => b.data >= f.data_inicio);
    if (f.data_fim) data = data.filter(b => b.data <= f.data_fim);
    if (f.id_bateria.size) data = data.filter(b => f.id_bateria.has(b.id_bateria));
    if (f.turno.size) data = data.filter(b => f.turno.has(b.turno));
    if (f.dimensao.size) data = data.filter(b => f.dimensao.has(b.dimensao));
    if (f.tipo_montagem.size) data = data.filter(b => f.tipo_montagem.has(b.tipo_montagem));
    if (f.atraso.size) data = data.filter(b => f.atraso.has(b.houve_atraso));

    data = [...data].sort((a, b) => b.data.localeCompare(a.data) || (b.inicio || '').localeCompare(a.inicio || ''));

    // Antes de montar as linhas, garante que colunas de tipos extras (ex: 3p) existam no thead
    _garantirColunasDinamicasTipo(data);
    // Tipos de placa que não são 2p/sp e já têm coluna injetada (na ordem em que foram injetados)
    const tiposExtras = COLUNAS_REGISTRO
      .filter(c => c.dinamica && c.key.startsWith('paineis_'))
      .map(c => c.key.replace('paineis_', ''));

    const tbody = document.getElementById('registro-tbody');
    document.getElementById('reg-count').textContent = data.length + ' registros';

    const colspanTotal = COLUNAS_REGISTRO.length;

    if (!data.length) {
      tbody.innerHTML = `<tr><td colspan="${colspanTotal}" style="text-align:center;color:var(--text-3);padding:30px">Nenhum registro encontrado</td></tr>`;
      return;
    }

    // Mapa temporário para lookup por índice (evita serializar JSON em atributos HTML)
    window._lwRegistroMapTemp = {};
    tbody.innerHTML = data.map((b, idx) => {
      window._lwRegistroMapTemp[idx] = b;
      const ppt = b.paineis_por_tipo || {};
      const m2pt = b.m2_por_tipo || {};
      // <td> extras para tipos de placa alem de 2p/sp (ex: 3p), na mesma ordem das colunas injetadas
      const tdsExtras = tiposExtras.map(tipo => `
        <td data-col="paineis_${tipo}">${ppt[tipo] || 0}</td>
        <td data-col="m2_${tipo}">${(m2pt[tipo] || 0).toFixed(2)}</td>
      `).join('');
      const corMont = _corBadgeMontagem(b.tipo_montagem);
      const corTextoMont = corMont.hibrida ? 'var(--text)' : corMont.cor;
      const tituloLinha = _modoEdicaoRegistro
        ? 'Clique para editar esta operação'
        : 'Clique para ver os traços desta bateria no Relatório de Injeção';
      return `
      <tr style="cursor:pointer" title="${tituloLinha}"
        onclick="LWDash.onClickLinhaRegistro(window._lwRegistroMapTemp[${idx}])">
        <td data-col="data" class="mono">${b.data ? b.data.split('-').reverse().join('/') : '—'}</td>
        <td data-col="turno"><span class="badge badge-gray">${b.turno || '—'}</span></td>
        <td data-col="dimensao">${b.dimensao || '—'}</td>
        <td data-col="capacidade">${b.capacidade || '—'}</td>
        <td data-col="id_bateria">${b.id_bateria || '—'}</td>
        <td data-col="inicio" class="mono">${b.inicio ? LW.formatTime(b.inicio) : '—'}</td>
        <td data-col="fim" class="mono">${b.fim ? LW.formatTime(b.fim) : '—'}</td>
        <td data-col="desemplaque" class="mono">${LW.formatDateTime(b.desemplaque || LW.calcularDesemplaque(b.fim))}</td>
        <td data-col="duracao" class="mono">${LW.formatDuration(b.tempo_min)}</td>
        <td data-col="tracos">${b.qtd_tracos || 0}</td>
        <td data-col="atraso">${b.houve_atraso === 'SIM'
          ? `<span class="badge badge-red" title="${b.motivo_atraso || ''}">⚠ SIM</span>`
          : '<span class="badge badge-green">✓ NÃO</span>'}</td>
        <td data-col="motivo_atraso">${b.motivo_atraso || '—'}</td>
        <td data-col="montagem"><span class="badge" style="background:${corMont.bg};color:${corTextoMont};border:1px solid ${corMont.borda}">${b.tipo_montagem || '—'}</span></td>
        <td data-col="paineis_2psp">${b.total_paineis || 0}</td>
        <td data-col="paineis_2p">${b.paineis_2p || 0}</td>
        <td data-col="paineis_sp">${b.paineis_sp || 0}</td>
        <td data-col="m2_2psp">${(b.m2_total || 0).toFixed(2)}</td>
        <td data-col="m2_2p">${(b.m2_2p || 0).toFixed(2)}</td>
        <td data-col="m2_sp">${(b.m2_sp || 0).toFixed(2)}</td>
        ${tdsExtras}
        <td data-col="bercos_reais">${b.bercos_reais || '—'}</td>
        <td data-col="placas_cimenticia">${b.placas_cimenticia || 0}</td>
      </tr>`;
    }).join('');

    _aplicarVisibilidadeColunasRegistro();
  }

  // ================================================================
  //  REGISTRO DE BATERIAS — Exibir/Ocultar Colunas
  // ================================================================

  const COL_REGISTRO_STORAGE_KEY = 'lw_cols_registro_baterias';

  // Definição das colunas fixas da tabela (mesma ordem do <thead> em index.html).
  // Tipos de placa alem de '2p'/'sp' (ex: '3p') geram colunas extras inseridas
  // dinamicamente em runtime por _garantirColunasDinamicasTipo() — ver abaixo.
  const COLUNAS_REGISTRO_BASE = [
    { key: 'data', label: 'Data' },
    { key: 'turno', label: 'Turno' },
    { key: 'dimensao', label: 'Dimensão' },
    { key: 'capacidade', label: 'Cap. Berços' },
    { key: 'id_bateria', label: 'ID Bateria' },
    { key: 'inicio', label: 'Início' },
    { key: 'fim', label: 'Fim' },
    { key: 'desemplaque', label: 'Desemplaque' },
    { key: 'duracao', label: 'Duração' },
    { key: 'tracos', label: 'Traços' },
    { key: 'atraso', label: 'Atraso' },
    { key: 'motivo_atraso', label: 'Motivo Atraso' },
    { key: 'montagem', label: 'Montagem' },
    { key: 'paineis_2psp', label: 'Painéis (Total)' },
    { key: 'paineis_2p', label: 'Painéis 2/P', tipoPlaca: true },
    { key: 'paineis_sp', label: 'Painéis S/P', tipoPlaca: true },
    { key: 'm2_2psp', label: 'm² (Total)' },
    { key: 'm2_2p', label: 'm² 2/P', tipoPlaca: true },
    { key: 'm2_sp', label: 'm² S/P', tipoPlaca: true },
    { key: 'bercos_reais', label: 'Berços Reais' },
    { key: 'placas_cimenticia', label: 'Placas Cimenticia' },
  ];

  // Cópia mutável: ganha entradas extras quando tipos de placa novos (3p, 4p, ...)
  // aparecem nos dados. Mantida em ordem de inserção.
  let COLUNAS_REGISTRO = [...COLUNAS_REGISTRO_BASE];

  // Tipos conhecidos de fábrica (já cobertos pelas colunas fixas do HTML)
  const TIPOS_PLACA_NATIVOS = new Set(['2p', 'sp']);

  function _labelTipoPlaca(tipo) {
    const m = String(tipo).match(/^(\d+)p$/i);
    if (m) return `${m[1]}/P`;
    return String(tipo).toUpperCase();
  }

  /**
   * Verifica os dados carregados por tipos de placa que não existem nas colunas
   * fixas (ex: '3p') e, se encontrar, injeta dinamicamente:
   *  - <th> de Painéis e m² para esse tipo, no <thead> (antes de "Berços Reais")
   *  - entradas correspondentes em COLUNAS_REGISTRO (para entrar no menu de toggle)
   * Idempotente: não duplica colunas já injetadas.
   */
  function _garantirColunasDinamicasTipo(dados) {
    const tiposEncontrados = new Set();
    dados.forEach(b => {
      const obj = b.paineis_por_tipo;
      if (!obj) return;
      Object.keys(obj).forEach(t => { if (!TIPOS_PLACA_NATIVOS.has(t)) tiposEncontrados.add(t); });
    });
    if (!tiposEncontrados.size) return;

    const thead = document.querySelector('#registro-table thead tr');
    const thBercosReais = thead?.querySelector('th[data-col="bercos_reais"]');
    if (!thead || !thBercosReais) return;

    tiposEncontrados.forEach(tipo => {
      const keyPaineis = `paineis_${tipo}`;
      const keyM2 = `m2_${tipo}`;
      if (COLUNAS_REGISTRO.some(c => c.key === keyPaineis)) return; // já injetada

      const label = _labelTipoPlaca(tipo);
      const thPaineis = document.createElement('th');
      thPaineis.setAttribute('data-col', keyPaineis);
      thPaineis.textContent = `Painéis ${label}`;
      const thM2 = document.createElement('th');
      thM2.setAttribute('data-col', keyM2);
      thM2.textContent = `m² ${label}`;
      thead.insertBefore(thPaineis, thBercosReais);
      thead.insertBefore(thM2, thBercosReais);

      // Insere antes de 'bercos_reais' na lista de colunas (mesma posição visual)
      const idx = COLUNAS_REGISTRO.findIndex(c => c.key === 'bercos_reais');
      COLUNAS_REGISTRO.splice(idx, 0,
        { key: keyPaineis, label: `Painéis ${label}`, tipoPlaca: true, dinamica: true },
        { key: keyM2, label: `m² ${label}`, tipoPlaca: true, dinamica: true },
      );
    });

    // Atualiza colspan da mensagem "Carregando/Nenhum registro" e o menu de colunas
    COLS_TIPOS_PLACA.length = 0;
    COLUNAS_REGISTRO.filter(c => c.tipoPlaca).forEach(c => COLS_TIPOS_PLACA.push(c.key));
  }

  // Chaves do grupo "Tipos de Placas" (mutável: cresce se houver colunas dinâmicas)
  const COLS_TIPOS_PLACA = COLUNAS_REGISTRO.filter(c => c.tipoPlaca).map(c => c.key);

  let _colsOcultasRegistro = new Set();

  function _carregarColsOcultasRegistro() {
    try {
      const saved = localStorage.getItem(COL_REGISTRO_STORAGE_KEY);
      if (saved) {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch (e) { console.warn('Preferência de colunas inválida, usando padrão.', e); }
    return new Set();
  }

  function _salvarColsOcultasRegistro() {
    try {
      localStorage.setItem(COL_REGISTRO_STORAGE_KEY, JSON.stringify([..._colsOcultasRegistro]));
    } catch (e) { console.warn('Não foi possível salvar preferência de colunas.', e); }
  }

  function initColMenuRegistro() {
    _colsOcultasRegistro = _carregarColsOcultasRegistro();

    const lista = document.getElementById('col-menu-list');
    if (!lista) return; // página ainda não renderizada

    lista.innerHTML = COLUNAS_REGISTRO.map(c => `
      <div class="col-menu-item">
        <label>
          <input type="checkbox" data-col-key="${c.key}"
            ${_colsOcultasRegistro.has(c.key) ? '' : 'checked'}
            onchange="LWDash.toggleColunaRegistro('${c.key}', this.checked)">
          <span>${c.label}</span>
        </label>
      </div>
    `).join('');

    _sincronizarCheckboxGrupoTiposPlaca();
    _aplicarVisibilidadeColunasRegistro();

    // Fecha o menu ao clicar fora dele
    document.removeEventListener('click', _onClickForaColMenuRegistro);
    document.addEventListener('click', _onClickForaColMenuRegistro);
  }

  function _onClickForaColMenuRegistro(e) {
    const menu = document.getElementById('col-menu-registro');
    const btn = document.getElementById('btn-col-toggle-registro');
    if (!menu || menu.style.display === 'none') return;
    if (menu.contains(e.target) || (btn && btn.contains(e.target))) return;
    menu.style.display = 'none';
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function toggleColMenu(e) {
    e.stopPropagation();
    const menu = document.getElementById('col-menu-registro');
    const btn = document.getElementById('btn-col-toggle-registro');
    if (!menu || !btn) return;
    const abrir = menu.style.display === 'none';
    if (abrir) {
      const rect = btn.getBoundingClientRect();
      menu.style.top = (rect.bottom + 8) + 'px';
      menu.style.left = rect.left + 'px';
    }
    menu.style.display = abrir ? 'block' : 'none';
    btn.setAttribute('aria-expanded', String(abrir));
  }

  function toggleColunaRegistro(key, visivel) {
    if (visivel) _colsOcultasRegistro.delete(key);
    else _colsOcultasRegistro.add(key);
    _salvarColsOcultasRegistro();
    _sincronizarCheckboxGrupoTiposPlaca();
    _aplicarVisibilidadeColunasRegistro();
  }

  function toggleGrupoTiposPlaca(ocultar) {
    COLS_TIPOS_PLACA.forEach(key => {
      if (ocultar) _colsOcultasRegistro.add(key);
      else _colsOcultasRegistro.delete(key);
      const cb = document.querySelector(`#col-menu-list input[data-col-key="${key}"]`);
      if (cb) cb.checked = !ocultar;
    });
    _salvarColsOcultasRegistro();
    _aplicarVisibilidadeColunasRegistro();
  }

  // Marca o checkbox do grupo automaticamente quando todas as colunas do grupo já estão ocultas
  function _sincronizarCheckboxGrupoTiposPlaca() {
    const grupoCb = document.getElementById('col-toggle-tipos-placa');
    if (!grupoCb) return;
    grupoCb.checked = COLS_TIPOS_PLACA.every(key => _colsOcultasRegistro.has(key));
  }

  function _aplicarVisibilidadeColunasRegistro() {
    const table = document.getElementById('registro-table');
    if (!table) return;

    COLUNAS_REGISTRO.forEach(c => {
      const oculta = _colsOcultasRegistro.has(c.key);
      table.querySelectorAll(`[data-col="${c.key}"]`).forEach(cell => {
        cell.style.display = oculta ? 'none' : '';
      });
    });
  }



  async function initRelatorio() {
    const linhas = await LW.getRelatorioInjecao();
    const cats = gerarCategoriasRelatorio(linhas);
    buildFiltrosUI('filtros-relatorio', cats, _filtrosRelatorio, renderRelatorio);
    atualizarChips('filtros-relatorio', _filtrosRelatorio, cats, renderRelatorio);

    ['rel-data-inicio', 'rel-data-fim'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.removeEventListener('change', _onDataRelatorio);
      el.addEventListener('change', _onDataRelatorio);
    });

    const cbAjuste = document.getElementById('rel-apenas-ajuste');
    if (cbAjuste) {
      cbAjuste.checked = !!_filtrosRelatorio.apenas_com_ajuste;
      cbAjuste.removeEventListener('change', _onApenasAjusteRelatorio);
      cbAjuste.addEventListener('change', _onApenasAjusteRelatorio);
    }
    _sincronizarVisualApenasAjuste();

    renderRelatorio();
  }

  // Helper para extrair o valor final de campos que podem ser objetos de ajuste {original, ajustes}
  function _valRel(val, fieldKey) {
    if (val === null || val === undefined || val === '') return '—';
    if (typeof val === 'object' && 'ajustes' in val) {
      const isResultado = fieldKey && (fieldKey.includes('densidade') || fieldKey.includes('flow'));
      const original = parseFloat(val.original) || 0;
      const ajustes = Array.isArray(val.ajustes) ? val.ajustes : [];

      if (isResultado) {
        // Para resultados, o último ajuste sobrescreve o valor
        if (ajustes.length > 0) return ajustes[ajustes.length - 1];
        return val.original || '—';
      }

      // Para insumos, soma-se tudo
      const total = ajustes.reduce((s, a) => s + (parseFloat(a) || 0), original);
      if (val.original === '' && ajustes.length === 0) return '—';
      return total;
    }
    return val;
  }

  function _onDataRelatorio(e) {
    _filtrosRelatorio[e.target.id === 'rel-data-inicio' ? 'data_inicio' : 'data_fim'] = e.target.value || null;
    renderRelatorio();
  }

  // Filtro rápido "Apenas com reajustes"
  function _onApenasAjusteRelatorio(e) {
    _filtrosRelatorio.apenas_com_ajuste = e.target.checked;
    _sincronizarVisualApenasAjuste();
    renderRelatorio();
  }

  // Destaca visualmente o chip do checkbox quando o filtro está ativo
  function _sincronizarVisualApenasAjuste() {
    const label = document.getElementById('rel-apenas-ajuste-label');
    if (!label) return;
    const ativo = !!_filtrosRelatorio.apenas_com_ajuste;
    label.style.background = ativo ? 'rgba(245,158,11,.12)' : 'transparent';
    label.style.borderColor = ativo ? 'var(--accent)' : 'var(--border)';
    label.style.color = ativo ? 'var(--accent)' : 'var(--text-2)';
  }

  // ── DETALHAMENTO DE AJUSTES (linha expansível do Relatório de Injeção) ──
  // Campos que podem vir como objeto { original, ajustes[], total }.
  // resultado:true  → cada ajuste é uma NOVA LEITURA que substitui a anterior
  //                    (ex: densidade, flow — o último valor é o que vale).
  // resultado:false → cada ajuste é um ACRÉSCIMO somado ao original
  //                    (ex: cimento, água — insumos da receita).
  const _CAMPOS_DETALHE_RELATORIO = [
    { campo: 'cimento_real',      label: 'Cimento',            unidade: 'kg', resultado: false },
    { campo: 'agua_real',         label: 'Água',                unidade: 'L',  resultado: false },
    { campo: 'eps_real',          label: 'EPS',                 unidade: 'kg', resultado: false },
    { campo: 'superplast_real',   label: 'Superplastificante',  unidade: 'kg', resultado: false },
    { campo: 'incorporador_real', label: 'Incorporador de Ar',  unidade: 'kg', resultado: false },
    {
      campo: 'tempo_batida', label: 'Tempo de Batida', resultado: false,
      // tempo_batida é guardado em segundos — formata como H:MM:SS, igual à coluna da tabela
      formatador: v => (v === null || v === undefined || v === '' || isNaN(v)) ? '—' : LW.formatDuration(parseFloat(v) / 60),
    },
    { campo: 'densidade',         label: 'Densidade',           unidade: '',   resultado: true },
    { campo: 'flow',              label: 'Flow',                unidade: '',   resultado: true },
  ];

  // Corta zeros à direita inúteis (320.0 → 320; 12.50 → 12.5)
  function _fmtNumDetalhe(v) {
    if (v === null || v === undefined || v === '' || isNaN(v)) return '—';
    const n = Math.round(parseFloat(v) * 100) / 100;
    return String(n);
  }

  // Formata um valor de acordo com a definição do campo (usa formatador
  // customizado, se houver — ex: tempo_batida em H:MM:SS — senão número + unidade)
  function _fmtValorDetalhe(def, v) {
    if (def.formatador) return def.formatador(v);
    return _fmtNumDetalhe(v) + (def.unidade || '');
  }

  // Monta o cartão de UM insumo/resultado dentro do painel de detalhamento.
  // Retorna null se esse campo não teve nenhum ajuste — não há reajuste pra
  // mostrar, então ele simplesmente não aparece no painel.
  function _linhaDetalheCampo(def, valorBruto) {
    if (!valorBruto || typeof valorBruto !== 'object' || !('ajustes' in valorBruto)) return null;

    const ajustes = Array.isArray(valorBruto.ajustes) ? valorBruto.ajustes : [];
    if (!ajustes.length) return null; // formato de objeto, mas nunca foi reajustado

    const original = parseFloat(valorBruto.original);
    const final = def.resultado
      ? parseFloat(ajustes[ajustes.length - 1])
      : ajustes.reduce((s, a) => s + (parseFloat(a) || 0), isNaN(original) ? 0 : original);

    const chips = ajustes.map((a, i) => {
      const num = parseFloat(a);
      if (def.resultado) {
        const ehFinal = i === ajustes.length - 1;
        return `<span class="badge ${ehFinal ? 'badge-blue' : 'badge-gray'}" title="${ehFinal ? 'Leitura final' : 'Leitura intermediária'}">${_fmtValorDetalhe(def, num)}</span>`;
      }
      const sinal = num >= 0 ? '+' : '';
      const textoExibido = def.formatador ? `${sinal}${_fmtValorDetalhe(def, num)}` : `${sinal}${_fmtNumDetalhe(num)}${def.unidade}`;
      return `<span class="badge ${num >= 0 ? 'badge-green' : 'badge-red'}" title="Reajuste aplicado">${textoExibido}</span>`;
    }).join('<span class="relatorio-ajuste-seta">→</span>');

    return `
      <div class="relatorio-ajuste-item">
        <div class="relatorio-ajuste-label">${def.label}</div>
        <div class="relatorio-ajuste-valores">
          <span class="relatorio-ajuste-original" title="Valor planejado (receita original)">${_fmtValorDetalhe(def, original)}</span>
          <span class="relatorio-ajuste-seta">→</span>
          ${chips}
          <span class="relatorio-ajuste-seta">→</span>
          <span class="relatorio-ajuste-final" title="Valor final aplicado na injeção">${_fmtValorDetalhe(def, final)}</span>
        </div>
      </div>`;
  }

  // Monta o painel completo de detalhamento de reajustes pra um traço `l`.
  function _construirDetalheRelatorio(l) {
    const itens = _CAMPOS_DETALHE_RELATORIO
      .map(def => _linhaDetalheCampo(def, l[def.campo]))
      .filter(Boolean);

    if (!itens.length) {
      return `<div class="relatorio-ajuste-vazio">Nenhum reajuste de receita foi registrado para este traço — os valores aplicados na injeção foram exatamente os planejados.</div>`;
    }
    return `<div class="relatorio-ajuste-grid">${itens.join('')}</div>`;
  }

  // Verifica se o traço teve QUALQUER reajuste em qualquer campo — usado
  // pelo filtro rápido "Apenas com reajustes". Usa a mesma lista de campos
  // do painel de detalhamento, então sempre fica em sincronia com ele.
  function _tracoTemAjuste(l) {
    return _CAMPOS_DETALHE_RELATORIO.some(def => {
      const v = l[def.campo];
      return v && typeof v === 'object' && Array.isArray(v.ajustes) && v.ajustes.length > 0;
    });
  }

  // Abre/fecha a linha de detalhe associada a uma linha do Relatório de
  // Injeção. rowId é o mesmo usado em data-traco-row-id / id="detalhe-...".
  function toggleDetalheRelatorio(rowId) {
    const detalhe = document.getElementById('detalhe-' + rowId);
    const icone = document.getElementById('icone-' + rowId);
    if (!detalhe) return;
    const estavaAberta = detalhe.style.display !== 'none';
    detalhe.style.display = estavaAberta ? 'none' : '';
    if (icone) icone.textContent = estavaAberta ? '▸' : '▾';
  }

  async function renderRelatorio() {
    const tbody = document.getElementById('relatorio-tbody');
    if (!tbody) return;

    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--text-3);padding:20px">Carregando...</td></tr>`;

    let linhas = await LW.getRelatorioInjecao();

    const f = _filtrosRelatorio;
    if (f.data_inicio) linhas = linhas.filter(l => l.data >= f.data_inicio);
    if (f.data_fim) linhas = linhas.filter(l => l.data <= f.data_fim);
    if (f.id_bateria.size) linhas = linhas.filter(l => f.id_bateria.has(l.id_bateria));
    if (f.num_traco.size) linhas = linhas.filter(l => f.num_traco.has(String(l.num_traco)));
    if (f.id_traco && f.id_traco.size) linhas = linhas.filter(l => l.id_traco && f.id_traco.has(l.id_traco));
    if (f.dimensao.size) linhas = linhas.filter(l => f.dimensao.has(l.dimensao));
    if (f.turno.size) linhas = linhas.filter(l => f.turno.has(l.turno));
    if (f.silo.size) linhas = linhas.filter(l => f.silo.has(l.silo));
    if (f.expansao.size) linhas = linhas.filter(l => f.expansao.has(l.expansao));
    if (f.apenas_com_ajuste) linhas = linhas.filter(l => _tracoTemAjuste(l));
    document.getElementById('rel-count').textContent = linhas.length + ' registros';

    if (!linhas.length) {
      tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--text-3);padding:30px">Nenhum registro encontrado</td></tr>`;
      return;
    }

    const sorted = [...linhas].sort((a, b) => {
      // Ordena por data decrescente
      if (b.data !== a.data) return b.data.localeCompare(a.data);

      // Como id_operacao agora está dentro de ultilizado, pegamos a primeira ou a última
      const opA = a.ultilizado?.operacao?.[0]?.id_operacao || '';
      const opB = b.ultilizado?.operacao?.[0]?.id_operacao || '';
      return opB.localeCompare(opA);
    });
    tbody.innerHTML = sorted.map((l, lIdx) => {
      // Um traço pode ter sido reaproveitado em mais de uma bateria — cada uso
      // fica registrado em l.ultilizado.operacao. Aqui geramos UMA LINHA VISUAL
      // por uso (bateria/berço inicial/berço final mudam a cada reaproveitamento),
      // mas os insumos (cimento, água, eps, densidade, flow, tempo de batida etc.)
      // são lidos sempre de `l` — ou seja, são os MESMOS em todas as linhas, nunca
      // duplicados. Isso é só uma exibição: não cria registros novos nem altera
      // nada que entra em dashboards/análises, que continuam consumindo `l` (o
      // traço único) normalmente.
      const operacoesDoTraco = (l.ultilizado?.operacao && l.ultilizado.operacao.length)
        ? l.ultilizado.operacao
        : [{}];

      // Se a navegação veio de uma operação específica (clique numa bateria
      // no Registro de Baterias), mostra só o uso daquela operação — mesmo
      // que esse mesmo traço tenha sido reaproveitado na mesma bateria (em
      // outra operação) ou em baterias diferentes. id_operacao é único por
      // operação, então não tem o problema de id_bateria poder repetir.
      const operacoes = (f.id_bateria_traco && f.id_bateria_traco.size && f.op_navegacao)
        ? operacoesDoTraco.filter(op => op.id_operacao === f.op_navegacao)
        : operacoesDoTraco;

      if (!operacoes.length) return ''; // este traço não pertence à bateria filtrada

      return operacoes.map((op, idx) => {
        const rowId = `rel-${lIdx}-${(l.id_traco || '')}-${idx}`.replace(/[^a-zA-Z0-9_-]/g, '');

        return `
      <tr${idx > 0 ? ' class="linha-traco-reaproveitado linha-relatorio-clicavel"' : ' class="linha-relatorio-clicavel"'}
        data-traco-row-id="${rowId}" title="Clique para ver os reajustes de receita deste traço"
        onclick="LWDash.toggleDetalheRelatorio('${rowId}')">
        <td class="mono"><span class="relatorio-expand-icon" id="icone-${rowId}">▸</span>${l.data ? l.data.split('-').reverse().join('/') : '—'}</td>
        <td>${op.id_bateria || '—'}${idx > 0 ? ' <span class="badge badge-gray" title="Traço reaproveitado nesta bateria">♻</span>' : ''}</td>
        <td>${l.num_traco || '—'}</td>
        <td class="mono">${op.berco_inicio || '—'}</td>
        <td class="mono">${op.berco_finalizacao || '—'}</td>
        <td>${_valRel(l.densidade, 'densidade')}</td>
        <td>${_valRel(l.flow, 'flow')}</td>
        <td>${l.densidade_eps || '—'}</td>
        <td><span class="badge badge-blue">${l.expansao || '—'}</span></td>
        <td><span class="badge badge-gray">${l.silo || '—'}</span></td>
        <td>${_valRel(l.cimento_real)}</td>
        <td>${_valRel(l.agua_real)}</td>
        <td>${_valRel(l.eps_real)}</td>
        <td>${_valRel(l.superplast_real)}</td>
        <td>${_valRel(l.incorporador_real)}</td>
        <td>${(() => {
        let v = _valRel(l.tempo_batida, 'tempo_batida');
        if (v === '—') return '—';
        return (typeof v === 'number' || !isNaN(parseFloat(v))) ? LW.formatDuration(parseFloat(v) / 60) : v;
      })()}</td>
        <td>${(op.obs !== undefined ? op.obs : l.obs) || '—'}</td>
      </tr>
      <tr class="relatorio-detalhe-row" id="detalhe-${rowId}" style="display:none">
        <td colspan="17">${_construirDetalheRelatorio(l)}</td>
      </tr>
    `;
      }).join('');
    }).join('');
  }


  // ---- Export CSV ----

  const EXPORT_COLUNAS_BASE = [
    { campo: 'data', header: 'Data', padrao: true, fmt: v => v ? v.split('-').reverse().join('/') : '' },
    { campo: 'turno', header: 'Turno', padrao: true },
    { campo: 'id_bateria', header: 'ID Bateria', padrao: true },
    { campo: 'dimensao', header: 'Dimensão', padrao: true },
    { campo: 'capacidade', header: 'Cap. Berços', padrao: true },
    { campo: 'tipo_montagem', header: 'Tipo Montagem', padrao: true },
    { campo: 'inicio', header: 'Hora Início', padrao: true, fmt: v => { if (!v) return ''; const d = new Date(v); return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }); } },
    { campo: 'fim', header: 'Hora Fim', padrao: true, fmt: v => { if (!v) return ''; const d = new Date(v); return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }); } },
    { campo: 'desemplaque', header: 'Desemplaque', padrao: true, fmt: v => LW.formatDateTime(v) },
    {
      campo: 'tempo_min', header: 'Duração', padrao: true, fmt: v => {
        if (!v || typeof v !== 'number') return '—';
        const totalSegundos = Math.round(v * 60);
        const m = Math.floor(totalSegundos / 60);
        const s = totalSegundos % 60;
        return `${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
      }
    },
    { campo: 'qtd_tracos', header: 'Qtd Traços', padrao: true },
    { campo: 'houve_atraso', header: 'Houve Atraso', padrao: true },
    { campo: 'motivo_atraso', header: 'Motivo Atraso', padrao: true },
    { campo: 'bercos_reais', header: 'Berços Reais', padrao: true },
    { campo: 'placas_cimenticia', header: 'Placas Cimenticia', padrao: true, fmt: v => v || '—' },
    { campo: 'total_paineis', header: 'Total Painéis', padrao: true },
    { campo: 'paineis_2p', header: 'Painéis 2/P', padrao: true },
    { campo: 'paineis_sp', header: 'Painéis S/P', padrao: true },
    { campo: 'm2_total', header: 'm² Total', padrao: true, fmt: v => typeof v === 'number' ? v.toFixed(2).replace('.', ',') : '0,00' },
    { campo: 'm2_2p', header: 'm² 2/P', padrao: false, fmt: v => typeof v === 'number' ? v.toFixed(2).replace('.', ',') : '0,00' },
    { campo: 'm2_sp', header: 'm² S/P', padrao: false, fmt: v => typeof v === 'number' ? v.toFixed(2).replace('.', ',') : '0,00' },
  ];

  // Tipos nativos já cobertos pela lista acima (paineis_2p/sp, m2_2p/sp)
  const _EXPORT_TIPOS_NATIVOS = new Set(['2p', 'sp']);

  /**
   * Monta a lista de colunas de export, incluindo (se existirem nos dados)
   * colunas extras para tipos de placa não nativos (ex: 3p), inseridas
   * imediatamente após as colunas nativas de painéis/m².
   */
  function _gerarExportColunas(dados) {
    const tiposExtras = new Set();
    (dados || []).forEach(b => {
      const obj = b.paineis_por_tipo;
      if (!obj) return;
      Object.keys(obj).forEach(t => { if (!_EXPORT_TIPOS_NATIVOS.has(t)) tiposExtras.add(t); });
    });
    if (!tiposExtras.size) return [...EXPORT_COLUNAS_BASE];

    const colunas = [...EXPORT_COLUNAS_BASE];
    const idxPaineisSp = colunas.findIndex(c => c.campo === 'paineis_sp');
    const idxM2Sp = colunas.findIndex(c => c.campo === 'm2_sp');

    const fmtNum = v => typeof v === 'number' ? v.toFixed(2).replace('.', ',') : '0,00';
    let offset = 0;
    tiposExtras.forEach(tipo => {
      const label = (() => {
        const m = String(tipo).match(/^(\d+)p$/i);
        return m ? `${m[1]}/P` : String(tipo).toUpperCase();
      })();
      colunas.splice(idxPaineisSp + 1 + offset, 0, { campo: `paineis_${tipo}`, header: `Painéis ${label}`, padrao: true });
      offset++;
    });
    // m2_sp pode ter mudado de posição por causa das inserções acima
    const idxM2SpAjustado = colunas.findIndex(c => c.campo === 'm2_sp');
    offset = 0;
    tiposExtras.forEach(tipo => {
      const label = (() => {
        const m = String(tipo).match(/^(\d+)p$/i);
        return m ? `${m[1]}/P` : String(tipo).toUpperCase();
      })();
      colunas.splice(idxM2SpAjustado + 1 + offset, 0, { campo: `m2_${tipo}`, header: `m² ${label}`, padrao: false, fmt: fmtNum });
      offset++;
    });
    return colunas;
  }

  // Lista efetiva usada pela UI de export — recalculada em abrirExportModal()
  let EXPORT_COLUNAS = [...EXPORT_COLUNAS_BASE];

  function gerarDownloadXLSX(dados, colsSel, sufixo) {
    // _gerarExportColunas() cria colunas dinâmicas como "paineis_3t"/"m2_3t" pra
    // tipos não nativos, mas o registro só guarda esses valores DENTRO de
    // paineis_por_tipo/m2_por_tipo (ex: item.paineis_por_tipo['3t']), nunca como
    // propriedade plana item.paineis_3t. Sem isso, a coluna saía em branco pra
    // qualquer tipo de montagem novo. Aqui "achatamos" os dois objetos em
    // propriedades planas pra TODOS os tipos (não só 2p/sp), pra que a leitura
    // genérica item[col.campo] mais abaixo funcione pra qualquer tipo, atual ou
    // futuro.
    dados = dados.map(item => {
      const extra = {};
      if (item.paineis_por_tipo) {
        Object.keys(item.paineis_por_tipo).forEach(tipo => { extra['paineis_' + tipo] = item.paineis_por_tipo[tipo]; });
      }
      if (item.m2_por_tipo) {
        Object.keys(item.m2_por_tipo).forEach(tipo => { extra['m2_' + tipo] = item.m2_por_tipo[tipo]; });
      }
      return { ...item, ...extra };
    });

    // 1. Prepara os dados para o Excel
    const dadosExcel = dados.map(item => {
      const linha = {};
      colsSel.forEach(col => {
        const v = item[col.campo];
        linha[col.header] = col.fmt ? col.fmt(v) : (v !== undefined && v !== null ? v : '');
      });
      return linha;
    });

    // 2. Cria uma Planilha (Worksheet)
    const ws = XLSX.utils.json_to_sheet(dadosExcel);

    // 3. Ajuste Automático de Largura das Colunas
    const colWidths = colsSel.map(col => {
      const headerLen = col.header.length;
      const maxDataLen = dadosExcel.reduce((max, row) => {
        const val = String(row[col.header] || '');
        return Math.max(max, val.length);
      }, headerLen);
      return { wch: maxDataLen + 4 }; // Adiciona uma folga
    });
    ws['!cols'] = colWidths;

    // 4. Congelar Cabeçalho (Primeira Linha)
    // Usamos split e activePane para garantir compatibilidade máxima
    ws['!views'] = [
      {
        state: 'frozen',
        xSplit: 0,
        ySplit: 1, // Congela 1 linha
        topLeftCell: 'A2',
        activePane: 'bottomLeft'
      }
    ];

    // 5. Cria um Livro (Workbook) e adiciona a planilha
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Produção");

    // 6. Gera o arquivo e inicia o download
    const nomeArquivo = 'lightwall_baterias_' + sufixo + '.xlsx';
    XLSX.writeFile(wb, nomeArquivo);
  }

  // Compatibilidade — exporta tudo com colunas padrão
  async function exportXLSX() {
    const s = await LW.getStats();
    EXPORT_COLUNAS = _gerarExportColunas(s.data);
    gerarDownloadXLSX(s.data, EXPORT_COLUNAS.filter(c => c.padrao), todayBrasilia());
  }

  async function abrirExportModal() {
    const s = await LW.getStats();
    EXPORT_COLUNAS = _gerarExportColunas(s.data);

    const grid = document.getElementById('exp-colunas-grid');
    grid.innerHTML = EXPORT_COLUNAS.map((c, i) =>
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 10px;' +
      'border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-2)">' +
      '<input type="checkbox" id="exp-col-' + i + '" ' + (c.padrao ? 'checked' : '') +
      ' style="accent-color:var(--accent);width:15px;height:15px" onchange="LWDash.atualizarPreviewCount()">' +
      '<span style="font-size:.85rem">' + c.header + '</span></label>'
    ).join('');
    document.getElementById('exp-radio-tudo').checked = true;
    document.getElementById('exp-periodo-inputs').style.display = 'none';
    document.getElementById('exp-data-inicio').value = '';
    document.getElementById('exp-data-fim').value = '';
    await atualizarPreviewCount();
    document.getElementById('export-modal').style.display = 'flex';
  }

  function fecharExportModal() {
    document.getElementById('export-modal').style.display = 'none';
  }

  function onExportPeriodoChange(valor) {
    document.getElementById('exp-periodo-inputs').style.display = valor === 'periodo' ? 'flex' : 'none';
    atualizarPreviewCount();
  }

  function selecionarTodasColunas(marcar) {
    EXPORT_COLUNAS.forEach((_, i) => {
      const el = document.getElementById('exp-col-' + i);
      if (el) el.checked = marcar;
    });
    atualizarPreviewCount();
  }

  async function atualizarPreviewCount() {
    const s = await LW.getStats();
    let dados = s.data;
    const radio = document.querySelector('input[name="export-periodo"]:checked');
    if (radio && radio.value === 'periodo') {
      const ini = document.getElementById('exp-data-inicio').value;
      const fim = document.getElementById('exp-data-fim').value;
      if (ini) dados = dados.filter(b => b.data >= ini);
      if (fim) dados = dados.filter(b => b.data <= fim);
    }
    const qtdCols = EXPORT_COLUNAS.filter((_, i) => {
      const el = document.getElementById('exp-col-' + i);
      return el && el.checked;
    }).length;
    const el = document.getElementById('exp-preview-count');
    if (el) el.textContent = dados.length + ' registros · ' + qtdCols + ' colunas selecionadas';
  }

  async function confirmarExport() {
    const s = await LW.getStats();
    let dados = s.data;
    let sufixo = 'completo';
    const radio = document.querySelector('input[name="export-periodo"]:checked');
    if (radio && radio.value === 'periodo') {
      const ini = document.getElementById('exp-data-inicio').value;
      const fim = document.getElementById('exp-data-fim').value;
      if (ini) dados = dados.filter(b => b.data >= ini);
      if (fim) dados = dados.filter(b => b.data <= fim);
      if (ini || fim) sufixo = (ini || 'inicio') + '_a_' + (fim || 'fim');
    }
    const colsSel = EXPORT_COLUNAS.filter((_, i) => {
      const el = document.getElementById('exp-col-' + i);
      return el && el.checked;
    });
    if (!colsSel.length) { LW.mostrarAlerta('Selecione ao menos uma coluna.', { tipo: 'aviso' }); return; }
    gerarDownloadXLSX(dados, colsSel, sufixo);
    fecharExportModal();
  }

  // ================================================================
  //  MODO DE EDIÇÃO do Registro de Baterias (admin)
  // ================================================================

  // Liga/desliga o modo de edição — enquanto ativo, clicar numa linha abre
  // a tela de edição daquela operação em vez de navegar pro Relatório de
  // Injeção. A função de abrir a edição (abrirEdicaoOperacao) vive no
  // index.html, junto com o resto do modal.
  function toggleModoEdicaoRegistro() {
    _modoEdicaoRegistro = !_modoEdicaoRegistro;
    const btn = document.getElementById('btn-editar-registro');
    if (btn) btn.classList.toggle('btn-primary', _modoEdicaoRegistro);
    const aviso = document.getElementById('registro-aviso-edicao');
    if (aviso) aviso.style.display = _modoEdicaoRegistro ? 'flex' : 'none';
    renderRegistro();
  }

  function onClickLinhaRegistro(bateria) {
    if (_modoEdicaoRegistro) {
      if (typeof window.abrirEdicaoOperacao === 'function') window.abrirEdicaoOperacao(bateria);
      return;
    }
    navegarParaTracosDoRegistro(bateria);
  }

  // ================================================================
  //  NAVEGAÇÃO: Registro de Baterias → Relatório de Injeção por Traços
  // ================================================================

  /**
   * Navega do Registro de Baterias para o Relatório de Injeção,
   * aplicando automaticamente filtros pelos traços vinculados à bateria.
   * @param {object} bateria - Registro completo da bateria (historico.json)
   */
  async function navegarParaTracosDoRegistro(bateria) {
    // Verifica se a produção é anterior ao corte de rastreamento de traços
    if (!bateria.data || bateria.data < TRACO_CUTOFF_DATE) {
      _mostrarAvisoSemTraco(bateria);
      return;
    }

    // Verifica se o registro possui traços vinculados
    const tracos = bateria.tracos;
    if (!tracos || !Array.isArray(tracos) || tracos.length === 0) {
      _mostrarAvisoSemTraco(bateria);
      return;
    }

    // Extrai os IDs de traço
    const idsTraco = tracos.map(t => t.id).filter(Boolean);
    if (!idsTraco.length) {
      _mostrarAvisoSemTraco(bateria);
      return;
    }

    // Limpa filtros anteriores do Relatório de Injeção
    Object.keys(_filtrosRelatorio).forEach(k => {
      if (_filtrosRelatorio[k] instanceof Set) _filtrosRelatorio[k].clear();
      else _filtrosRelatorio[k] = null;
    });

    // Aplica os IDs de traço como filtro de navegação
    idsTraco.forEach(id => _filtrosRelatorio.id_traco.add(id));

    // Restringe a exibição apenas ao uso feito NESTA operação específica —
    // usamos id_operacao (único por operação) em vez de id_bateria, pois a
    // mesma bateria pode rodar mais de uma operação e reaproveitar o mesmo
    // traço nelas, o que faria id_bateria sozinho mostrar as duas juntas.
    if (bateria.id_bateria) {
      _filtrosRelatorio.id_bateria_traco.add(bateria.id_bateria); // só exibição (chip)
    }
    _filtrosRelatorio.op_navegacao = bateria.id || null; // filtro real

    // Reseta inputs de data do relatório
    const ini = document.getElementById('rel-data-inicio');
    const fim = document.getElementById('rel-data-fim');
    if (ini) ini.value = '';
    if (fim) fim.value = '';

    // Navega para a página do Relatório de Injeção
    if (typeof showPage === 'function') {
      showPage('relatorio');
    } else {
      window.LWDash.initRelatorio();
    }
  }

  /**
   * Exibe um aviso visual informando que o registro não possui vínculo de traço.
   */
  function _mostrarAvisoSemTraco(bateria) {
    const dataFormatada = bateria.data
      ? bateria.data.split('-').reverse().join('/')
      : '(data desconhecida)';
    const msg = `Esta produção (${bateria.id_bateria || ''} — ${dataFormatada}) foi registrada antes da implantação do sistema de rastreamento de traços e não possui vínculo de traço disponível.`;

    // Usa o modal de mensagem existente se disponível, senão alert simples
    if (typeof LWOp !== 'undefined' && LWOp.showToast) {
      LWOp.showToast(msg, 'warn');
    } else {
      // Exibe um toast não-bloqueante inline
      _mostrarToastAviso(msg);
    }
  }

  /**
   * Toast não-bloqueante para avisos de sem-traço.
   */
  function _mostrarToastAviso(msg) {
    const existing = document.getElementById('lw-traco-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'lw-traco-toast';
    toast.style.cssText = [
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999',
      'background:var(--surface-2,#1e293b);border:1px solid rgba(245,158,11,.4)',
      'color:var(--accent,#f59e0b);border-radius:10px;padding:14px 20px',
      'font-size:.85rem;max-width:520px;text-align:center',
      'box-shadow:0 8px 32px rgba(0,0,0,.4);line-height:1.5',
      'display:flex;align-items:flex-start;gap:10px',
    ].join(';');
    toast.innerHTML = `
      <span style="font-size:1.2rem;flex-shrink:0">⚠️</span>
      <span>${msg}</span>
      <button onclick="document.getElementById('lw-traco-toast').remove()"
        style="background:none;border:none;cursor:pointer;color:var(--accent);font-size:1rem;padding:0;margin-left:8px;flex-shrink:0;opacity:.7">✕</button>
    `;
    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 7000);
  }


  // ---- Public ----
  window.LWDash = {
    initTurnos, initRegistro, initRelatorio, renderRelatorio,
    navegarParaTracosDoRegistro,
    toggleModoEdicaoRegistro,
    onClickLinhaRegistro,
    toggleDetalheRelatorio,
    exportCSV: exportXLSX, abrirExportModal, fecharExportModal, onExportPeriodoChange,
    selecionarTodasColunas, atualizarPreviewCount, confirmarExport,
    toggleColMenu, toggleColunaRegistro, toggleGrupoTiposPlaca,
  };
})();