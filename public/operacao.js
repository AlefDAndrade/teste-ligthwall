// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  operacao.js — Tela de Operação logic
// ============================================================

'use strict';

(function () {

  // ---- State ----
  let state = {
    turno: '1º TURNO',
    dimensao: '',
    tipo_montagem: '',
    id_bateria: '',
    bercos_reais: '',
    inicio: null,
    fim: null,
    status: 'idle',      // idle | running | finished
    tracos: [],
  };

  let timerInterval = null;

  // ---- DOM refs ----
  const $ = id => document.getElementById(id);

  function init() {
    // Carrega config.json e só depois inicializa a tela
    LW.loadConfig().then(() => {
      populateSelects();

      const saved = LW.getOperacaoAtual();
      if (saved) {
        state = saved;
        renderAll();
        if (state.status === 'running') startTimerUI();
      }

      wireEvents();
      setInterval(updateClock, 1000);
      updateClock();
      renderAll();
    });
  }

  // Preenche os <select> com dados do config.json
  function populateSelects() {
    // ID da bateria
    const selBateria = document.getElementById('op-id-bateria');
    selBateria.innerHTML = '<option value="">— Selecione —</option>';
    LW.BATERIA_IDS.forEach(id => {
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = id;
      selBateria.appendChild(opt);
    });

    // Dimensão
    const selDim = document.getElementById('op-dimensao');
    selDim.innerHTML = '<option value="">— Selecione —</option>';
    LW.DIMENSAO_OPTS.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.label;
      opt.textContent = d.label;
      selDim.appendChild(opt);
    });

    // Tipo de montagem
    const selMont = document.getElementById('op-montagem');
    selMont.innerHTML = '<option value="">— Selecione —</option>';
    LW.MONTAGEM_OPTS.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m;
      selMont.appendChild(opt);
    });

    // Atualiza referência rápida
    renderReferencia();
  }

  function renderReferencia() {
    const el = document.getElementById('ref-rapida');
    if (!el) return;
    el.innerHTML = LW.DIMENSAO_OPTS.map(d =>
      '<div style="display:flex;justify-content:space-between">' +
      '<span>' + d.label + '</span>' +
      '<span style="color:var(--text-3)">' + d.bercos + ' berços → ' + (d.bercos * 2) + ' painéis</span>' +
      '</div>'
    ).join('');
  }

  function wireEvents() {
    $('op-turno').addEventListener('change', e => {
      state.turno = e.target.value; persist();
    });
    $('op-dimensao').addEventListener('change', e => {
      state.dimensao = e.target.value;
      updateCapacidade();
      recalcPaineis();
      persist();
    });
    $('op-montagem').addEventListener('change', e => {
      state.tipo_montagem = e.target.value;
      recalcPaineis();
      persist();
    });
    $('op-id-bateria').addEventListener('change', e => {
      state.id_bateria = e.target.value; persist(); updatePendencias();
    });
    $('op-bercos-reais').addEventListener('input', e => {
      state.bercos_reais = e.target.value;
      recalcPaineis();
      persist();
    });
    $('op-motivo').addEventListener('input', e => {
      state.motivo_atraso = e.target.value; persist();
    });
    $('btn-iniciar').addEventListener('click', iniciarInjecao);
    $('btn-finalizar').addEventListener('click', finalizarInjecao);
    $('btn-registrar').addEventListener('click', registrarOperacao);
    $('btn-resetar').addEventListener('click', resetarOperacao);
    $('btn-add-traco').addEventListener('click', addTraco);
  }

  function updateClock() {
    const el = document.getElementById('topbar-clock');
    if (el) el.textContent = new Date().toLocaleTimeString('pt-BR');
  }

  function updateCapacidade() {
    const d = LW.DIMENSAO_OPTS.find(o => o.label === state.dimensao);
    $('op-capacidade').value = d ? d.bercos + ' berços' : '';
  }

  function recalcPaineis() {
    const bercos = parseInt(state.bercos_reais) ||
      (LW.DIMENSAO_OPTS.find(o => o.label === state.dimensao)?.bercos || 0);
    if (!bercos || !state.tipo_montagem) {
      $('op-paineis-total').textContent = '—';
      $('op-paineis-2p').textContent = '—';
      $('op-paineis-sp').textContent = '—';
      $('op-m2-total').textContent = '—';
      $('op-m2-2p').textContent = '—';
      $('op-m2-sp').textContent = '—';
      return;
    }
    const r = LW.calcPaineis(state.tipo_montagem, bercos);
    $('op-paineis-total').textContent = r.total_paineis;
    $('op-paineis-2p').textContent = r.paineis_2p;
    $('op-paineis-sp').textContent = r.paineis_sp;
    $('op-m2-total').textContent = r.m2_total.toFixed(2) + ' m²';
    $('op-m2-2p').textContent = r.m2_2p.toFixed(2) + ' m²';
    $('op-m2-sp').textContent = r.m2_sp.toFixed(2) + ' m²';
  }

  function iniciarInjecao() {
    if (state.status !== 'idle') return;
    state.inicio = new Date().toISOString();
    state.status = 'running';
    $('op-inicio').value = LW.formatTime(state.inicio);
    $('btn-iniciar').disabled = true;
    $('btn-finalizar').disabled = false;
    startTimerUI();
    persist();
    updateStatusBanner();
    updatePendencias();
  }

  function finalizarInjecao() {
    if (state.status !== 'running') return;
    state.fim = new Date().toISOString();
    state.status = 'finished';
    clearInterval(timerInterval);
    $('op-fim').value = LW.formatTime(state.fim);
    $('btn-finalizar').disabled = true;

    const minutos = LW.diffMinutes(state.inicio, state.fim);
    state.tempo_min = minutos;

    const atraso = minutos > LW.LIMITE_INJECAO_MIN;
    state.houve_atraso = atraso ? 'SIM' : 'NÃO';
    $('op-atraso').innerHTML = atraso
      ? '<span class="badge badge-red">⚠ SIM — ' + Math.round(minutos) + 'min</span>'
      : '<span class="badge badge-green">✓ NÃO — ' + Math.round(minutos) + 'min</span>';

    $('op-motivo-row').style.display = atraso ? 'flex' : 'none';
    $('op-tempo-total').textContent = LW.formatDuration(minutos);

    persist();
    updateStatusBanner();
    updatePendencias();
  }

  function startTimerUI() {
    timerInterval = setInterval(() => {
      if (!state.inicio) return;
      const elapsed = LW.diffMinutes(state.inicio, new Date().toISOString());
      const el = $('timer-display');
      if (!el) return;
      const m = Math.floor(elapsed);
      const s = Math.floor((elapsed - m) * 60);
      el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      el.className = 'timer-display' + (m >= LW.LIMITE_INJECAO_MIN ? ' danger' : m >= 50 ? ' warning' : '');
    }, 1000);
  }

  function updateStatusBanner() {
    const banner = $('status-banner');
    if (state.status === 'idle') {
      banner.innerHTML = '<span class="badge badge-gray">⬤ Aguardando início</span>';
    } else if (state.status === 'running') {
      banner.innerHTML = '<span class="badge badge-amber">◉ Injeção em andamento</span>';
    } else {
      banner.innerHTML = '<span class="badge badge-green">✓ Finalizado</span>';
    }
  }

  function addTraco() {
    const num = state.tracos.length + 1;
    state.tracos.push({ num, berco_ini: '', berco_fim: '', densidade: '', flow: '', obs: '' });
    renderTracos();
    persist();
  }

  function removeTraco(i) {
    state.tracos.splice(i, 1);
    state.tracos.forEach((t, idx) => t.num = idx + 1);
    renderTracos();
    persist();
  }

  function renderTracos() {
    const container = $('tracos-container');
    container.innerHTML = '';
    state.tracos.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'traco-row';
      row.innerHTML = `
        <div class="form-group">
          <label class="form-label">Nº</label>
          <div class="traco-num">${t.num}</div>
        </div>
        <div class="form-group">
          <label class="form-label">Berço Início <span class="required">*</span></label>
          <input class="form-input" type="number" min="1" max="22" value="${t.berco_ini}"
            oninput="LWOp.updateTraco(${i},'berco_ini',this.value)" placeholder="1">
        </div>
        <div class="form-group">
          <label class="form-label">Berço Fim <span class="required">*</span></label>
          <input class="form-input" type="number" min="1" max="22" value="${t.berco_fim}"
            oninput="LWOp.updateTraco(${i},'berco_fim',this.value)" placeholder="22">
        </div>
        <div class="form-group">
          <label class="form-label">Densidade</label>
          <input class="form-input" type="number" step="0.01" value="${t.densidade}"
            oninput="LWOp.updateTraco(${i},'densidade',this.value)" placeholder="kg/m³">
        </div>
        <div class="form-group">
          <label class="form-label">Flow</label>
          <input class="form-input" type="number" value="${t.flow}"
            oninput="LWOp.updateTraco(${i},'flow',this.value)" placeholder="mm">
        </div>
        <div class="form-group" style="grid-column:span 1">
          <label class="form-label">Observações</label>
          <input class="form-input" type="text" value="${t.obs}"
            oninput="LWOp.updateTraco(${i},'obs',this.value)" placeholder="Ajustes, falhas...">
        </div>
        <div style="display:flex;align-items:flex-end;padding-bottom:2px">
          <button class="btn btn-ghost btn-sm" onclick="LWOp.removeTraco(${i})" title="Remover traço"
            style="padding:8px;color:var(--red);border-color:var(--red-dim)">✕</button>
        </div>
      `;
      container.appendChild(row);
    });
  }

  function updatePendencias() {
    const checks = [
      { label: 'Turno definido', ok: !!state.turno },
      { label: 'Dimensão da bateria', ok: !!state.dimensao },
      { label: 'Tipo de montagem', ok: !!state.tipo_montagem },
      { label: 'ID da bateria', ok: !!state.id_bateria },
      { label: 'Injeção iniciada', ok: !!state.inicio },
      { label: 'Injeção finalizada', ok: !!state.fim },
      { label: 'Motivo do atraso', ok: state.houve_atraso === 'NÃO' || !!state.motivo_atraso },
      { label: 'Ao menos 1 traço', ok: state.tracos.length > 0 },
    ];

    const allOk = checks.every(c => c.ok);
    const list = $('pendencia-list');
    list.innerHTML = checks.map(c => `
      <div class="pendency-item ${c.ok ? 'ok' : 'err'}">
        <div class="dot"></div>
        <span>${c.label}</span>
      </div>
    `).join('');

    $('btn-registrar').disabled = !allOk;

    const badge = $('pendencia-badge');
    const pending = checks.filter(c => !c.ok).length;
    if (pending === 0) {
      badge.innerHTML = '<span class="badge badge-green">✓ Tudo preenchido</span>';
    } else {
      badge.innerHTML = `<span class="badge badge-red">${pending} pendência${pending > 1 ? 's' : ''}</span>`;
    }
  }

  function registrarOperacao() {
    const bercos = parseInt(state.bercos_reais) ||
      (LW.DIMENSAO_OPTS.find(o => o.label === state.dimensao)?.bercos || 0);

    const calc = LW.calcPaineis(state.tipo_montagem, bercos);

    const data = new Date(state.inicio);

    const dataLocal =
      `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')
      }-${String(data.getDate()).padStart(2, '0')
      }`;

    const record = {
      id: 'op_' + Date.now(),
      data: dataLocal,
      turno: state.turno,
      dimensao: state.dimensao,
      capacidade: LW.DIMENSAO_OPTS.find(o => o.label === state.dimensao)?.bercos || 0,
      id_bateria: state.id_bateria,
      inicio: state.inicio,
      fim: state.fim,
      tempo_min: state.tempo_min,
      qtd_tracos: state.tracos.length,
      houve_atraso: state.houve_atraso,
      motivo_atraso: state.motivo_atraso || '',
      tipo_montagem: state.tipo_montagem,
      bercos_reais: bercos,
      ...calc,
      tracos: state.tracos,
    };

    const db = LW.loadDB(LW.DB_KEY_BATERIAS);
    db.push(record);
    LW.saveDB(LW.DB_KEY_BATERIAS, db);

    LW.clearOperacaoAtual();
    clearInterval(timerInterval);

    showSuccessModal(record);
    resetState();
    renderAll();
  }

  function showSuccessModal(record) {
    const modal = $('success-modal');
    $('modal-bateria').textContent = record.id_bateria;
    $('modal-tempo').textContent = LW.formatDuration(record.tempo_min);
    $('modal-paineis').textContent = record.total_paineis;
    $('modal-m2').textContent = record.m2_total.toFixed(2) + ' m²';
    $('modal-atraso').innerHTML = record.houve_atraso === 'SIM'
      ? '<span class="badge badge-red">SIM</span>'
      : '<span class="badge badge-green">NÃO</span>';
    modal.style.display = 'flex';
  }

  function resetarOperacao() {
    if (!confirm('Limpar todos os dados da operação atual?')) return;
    clearInterval(timerInterval);
    LW.clearOperacaoAtual();
    resetState();
    renderAll();
  }

  function resetState() {
    state = {
      turno: '1º TURNO',
      dimensao: '',
      tipo_montagem: '',
      id_bateria: '',
      bercos_reais: '',
      inicio: null,
      fim: null,
      status: 'idle',
      tracos: [],
    };
  }

  function renderAll() {
    // Set form values
    $('op-turno').value = state.turno || '1º TURNO';
    $('op-dimensao').value = state.dimensao || '';
    $('op-montagem').value = state.tipo_montagem || '';
    $('op-id-bateria').value = state.id_bateria || '';
    $('op-bercos-reais').value = state.bercos_reais || '';
    $('op-motivo').value = state.motivo_atraso || '';

    updateCapacidade();

    $('op-inicio').value = state.inicio ? LW.formatTime(state.inicio) : '';
    $('op-fim').value = state.fim ? LW.formatTime(state.fim) : '';
    $('op-tempo-total').textContent = state.tempo_min ? LW.formatDuration(state.tempo_min) : '—';

    if (state.houve_atraso) {
      const minutos = state.tempo_min || 0;
      $('op-atraso').innerHTML = state.houve_atraso === 'SIM'
        ? `<span class="badge badge-red">⚠ SIM — ${Math.round(minutos)}min</span>`
        : `<span class="badge badge-green">✓ NÃO — ${Math.round(minutos)}min</span>`;
    } else {
      $('op-atraso').textContent = '—';
    }

    $('op-motivo-row').style.display = state.houve_atraso === 'SIM' ? 'flex' : 'none';

    $('btn-iniciar').disabled = state.status !== 'idle';
    $('btn-finalizar').disabled = state.status !== 'running';

    $('op-data').textContent = new Date().toLocaleDateString('pt-BR', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
    });

    renderTracos();
    recalcPaineis();
    updateStatusBanner();
    updatePendencias();
  }

  function persist() {
    LW.saveOperacaoAtual(state);
    updatePendencias();
  }

  // ---- Public API ----
  window.LWOp = {
    init,
    updateTraco(i, field, value) {
      state.tracos[i][field] = value;
      persist();
    },
    removeTraco,
    closeModal() {
      $('success-modal').style.display = 'none';
    }, _repopulate() {
      populateSelects();
    }
  };

})();