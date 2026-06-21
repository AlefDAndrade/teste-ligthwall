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
  let expandedTracoIndex = 0; // Índice do traço aberto (acordeão exclusivo)

  // ---- DOM refs ----
  const $ = id => document.getElementById(id);

  function init() {
    // Carrega config.json e só depois inicializa a tela
    LW.loadConfig().then(() => {
      populateSelects();

      const saved = LW.getOperacaoAtual();
      if (saved) {
        state = saved;
        expandedTracoIndex = state.tracos.length - 1; // Expande o último ao retomar
        renderAll();
        if (state.status === 'running') startTimerUI();
      }

      wireEvents();
      setInterval(updateClock, 1000);
      updateClock();
      renderAll();

      // Fecha popovers ao clicar fora
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.ao-popover') && !e.target.closest('.btn-sm')) {
          document.querySelectorAll('.ao-popover').forEach(p => p.classList.remove('active'));
        }
      });
    });
  }

  // Preenche os <select> com dados do config.json
  function populateSelects() {
    // ID da bateria
    const selBateria = document.getElementById('op-id-bateria');
    selBateria.innerHTML = '<option selected disabled hidden></option>';
    LW.BATERIA_IDS.forEach(id => {
      const opt = document.createElement('option');
      // Como id agora é um objeto {id, label, bercos}
      opt.value = id.id; opt.textContent = id.id;
      selBateria.appendChild(opt);
    });

    // Tipo de montagem
    const selMont = document.getElementById('op-montagem');
    selMont.innerHTML = '<option selected disabled hidden></option>';
    LW.MONTAGEM_OPTS.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m;
      selMont.appendChild(opt);
    });

    // Atualiza referência rápida
    renderReferencia();
  }

  function renderReferencia() {
    const el = document.getElementById('ref-rapida-list');
    if (!el) return;
    el.innerHTML = LW.DIMENSAO_OPTS.map(d =>
      '<div style="display:flex;justify-content:space-between">' +
      '<span>' + d.label + '</span>' +
      '<span style="color:var(--text-3)">' + d.bercos + ' berços → ' + (d.bercos * 2) + ' painéis</span>' +
      '</div>'
    ).join('');
    el.innerHTML += '<hr style="margin:8px 0">';
    el.innerHTML += '<span style="color:var(--accent); text-align:center">VOLUME POR PLACAS</span>';
    el.innerHTML += LW.VOLUME_POR_PLACA.map(v =>
      '<div style="display:flex;justify-content:space-between">' +
      '<span>' + v.label + '</span>' +
      '<span style="color:var(--text-3)">' + v.volume.toFixed(4) + ' m³</span>' +
      '</div>'
    ).join('');
  }

  function wireEvents() {
    $('op-turno').addEventListener('change', e => {
      state.turno = e.target.value; persist();
    });
    $('op-montagem').addEventListener('change', e => {
      state.tipo_montagem = e.target.value;
      recalcPaineis();
      persist();
    });
    $('op-id-bateria').addEventListener('change', e => {
      state.id_bateria = e.target.value;
      updateCapacidade();
      recalcPaineis();
      persist();
      updatePendencias();
    });
    $('op-bercos-reais').addEventListener('input', e => {
      state.bercos_reais = e.target.value;
      recalcPaineis();
      persist();
    });
    if (document.getElementById('op-silo')) $('op-silo').addEventListener('change', e => {
      state.silo = e.target.value; persist();
    });
    if (document.getElementById('op-expansao')) $('op-expansao').addEventListener('change', e => {
      state.expansao = e.target.value; persist();
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
    if (el) el.textContent = LW.formatTime(nowBrasilia());
  }

  function updateCapacidade() {
    const bateria = LW.BATERIA_IDS.find(b => b.id === state.id_bateria);
    if (bateria) {
      state.dimensao = bateria.label; // Sincroniza a dimensão automaticamente
      $('op-capacidade').value = `${bateria.bercos} berços`;
      if ($('op-dimensao')) $('op-dimensao').value = state.dimensao;
    } else {
      state.dimensao = '';
      $('op-capacidade').value = '';
      if ($('op-dimensao')) $('op-dimensao').value = '';
    }
  }

  // Cores cíclicas para os cards de tipo (mesma paleta usada antes para 2P/SP)
  const _CORES_TIPO = ['var(--blue)', 'var(--green)', 'var(--accent)', 'var(--purple)', 'var(--yellow)'];

  // Labels amigáveis para tipos conhecidos; tipos novos caem no fallback (maiúsculas + "/").
  function _labelTipo(tipo) {
    const conhecidos = { '2p': '2/P', 'sp': 'S/P', '3p': '3/P' };
    if (conhecidos[tipo]) return conhecidos[tipo];
    // Ex: '4p' -> '4/P'
    const m = tipo.match(/^(\d+)p$/i);
    if (m) return `${m[1]}/P`;
    return tipo.toUpperCase();
  }

  function recalcPaineis() {
    const bateria = LW.BATERIA_IDS.find(b => b.id === state.id_bateria);
    const bercos = parseInt(state.bercos_reais) || (bateria?.bercos || 0);

    const elPaineisTipo = $('op-cards-paineis-tipo');
    const elM2Tipo = $('op-cards-m2-tipo');

    if (!bercos || !state.tipo_montagem) {
      $('op-paineis-total').textContent = '—';
      $('op-m2-total').textContent = '—';
      $('op-placas-cimenticia').textContent = '—';
      if (elPaineisTipo) elPaineisTipo.innerHTML = '';
      if (elM2Tipo) elM2Tipo.innerHTML = '';
      return;
    }
    const r = LW.calcPaineis(state.tipo_montagem, bercos);
    $('op-paineis-total').textContent = r.total_paineis;
    $('op-m2-total').textContent = r.m2_total.toFixed(2) + ' m²';
    $('op-placas-cimenticia').textContent = r.placas_cimenticia;

    // Gera os cards de Painéis por tipo (2/P, S/P, 3/P, ... — quantos a montagem tiver)
    const tipos = Object.keys(r.paineis_por_tipo);
    if (elPaineisTipo) {
      elPaineisTipo.innerHTML = tipos.map((tipo, i) => `
        <div>
          <div style="font-size:.6rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px">
            Painéis ${_labelTipo(tipo)}</div>
          <div style="font-family:var(--font-display);font-size:1.4rem;font-weight:800;color:${_CORES_TIPO[i % _CORES_TIPO.length]}">
            ${r.paineis_por_tipo[tipo]}</div>
        </div>
      `).join('');
    }
    if (elM2Tipo) {
      elM2Tipo.innerHTML = tipos.map((tipo, i) => `
        <div>
          <div style="font-size:.6rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px">
            m² ${_labelTipo(tipo)}</div>
          <div style="font-family:var(--font-display);font-size:1.1rem;font-weight:800;color:${_CORES_TIPO[i % _CORES_TIPO.length]}">
            ${r.m2_por_tipo[tipo].toFixed(2)} m²</div>
        </div>
      `).join('');
    }
  }

  function iniciarInjecao() {
    if (state.status !== 'idle') return;
    state.inicio = nowBrasilia().toISOString();
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
    state.fim = nowBrasilia().toISOString();
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
      const elapsed = LW.diffMinutes(state.inicio, nowBrasilia().toISOString());
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

  // Cria estrutura de insumo com suporte a ajustes
  function criarInsumo(valorOriginal) {
    const original = valorOriginal === '' ? '' : parseFloat(valorOriginal) || 0;
    return {
      original,
      ajustes: [],
      get total() {
        if (this.original === '') return '';
        return this.ajustes.reduce((s, a) => s + a, parseFloat(this.original) || 0);
      }
    };
  }

  // Retorna o total de um insumo (serializado, sem getter)
  function totalInsumo(insumo, fieldKey) {
    const temOriginal = insumo.original !== '' && insumo.original !== null;
    const temAjustes = insumo.ajustes && insumo.ajustes.length > 0;
    if (!temOriginal && !temAjustes) return '';

    // Para Densidade e Flow, o ajuste sobrescreve o valor anterior (não soma)
    const isResultado = fieldKey && (fieldKey.includes('densidade') || fieldKey.includes('flow'));
    if (isResultado) {
      if (temAjustes) return insumo.ajustes[insumo.ajustes.length - 1];
      return parseFloat(insumo.original) || 0;
    }

    return insumo.ajustes.reduce((s, a) => s + a, parseFloat(insumo.original) || 0);
  }

  // Migra traços antigos (campos _real simples) para nova estrutura com ajustes
  function migrarTraco(t) {
    const insumos = ['cimento', 'agua', 'eps', 'superplast', 'incorporador'];
    insumos.forEach(key => {
      const realKey = key + '_real';
      if (t[realKey] !== undefined && typeof t[realKey] !== 'object') {
        t[realKey] = { original: t[realKey], ajustes: [] };
      }
    });
    // Migrar densidade e flow se necessário
    ['densidade', 'flow'].forEach(key => {
      const targetKey = key + '_insumo';
      // Só migra se o campo legado tiver um valor preenchido E o destino ainda não for o novo formato (objeto)
      if (t[key] !== undefined && t[key] !== '' && typeof t[key] !== 'object' && typeof t[targetKey] !== 'object') {
        t[targetKey] = { original: t[key], ajustes: [] };
      }
    });
    // Migrar tempo_batida se necessário
    if (t.tempo_batida !== undefined && typeof t.tempo_batida !== 'object') {
      t.tempo_batida = { original: t.tempo_batida, ajustes: [] };
    }
    return t;
  }

  /**
   * Renumera os traços NOVOS (não reaproveitados) do state em sequência,
   * a partir de state.baseNumTraco. Chamada após qualquer criação/remoção de
   * traço, garantindo que a numeração de prévia exibida na tela esteja sempre
   * correta e sem buracos — ex: se o traço do meio for excluído, os seguintes
   * "sobem" um número.
   * Traços reaproveitados de sobra (t._reaproveitado) mantêm seu próprio
   * número fixo (o da operação de origem) e são ignorados nesta contagem.
   */
  function _renumerarTracos() {
    const base = state.baseNumTraco || 0;
    let proximo = base + 1;
    state.tracos.forEach(t => {
      if (t._reaproveitado) return; // número fixo, não participa da sequência local
      t.num = proximo;
      proximo++;
    });
  }

  /**
   * Garante que state.baseNumTraco esteja definido, buscando do servidor na
   * primeira vez que a operação atual precisa numerar um traço novo. Uma vez
   * definida, a base fica fixa durante toda a operação (mesmo com reload da
   * página) — apenas ao finalizar a operação o total real do servidor avança.
   */
  async function _garantirBaseNumTraco() {
    if (typeof state.baseNumTraco === 'number') return;
    try {
      state.baseNumTraco = await LW.getTotalTracosHoje();
    } catch (err) {
      console.warn('[LW] Falha ao obter total de traços do dia, usando 0 como base:', err.message);
      state.baseNumTraco = 0;
    }
  }

  /**
   * Cria a estrutura de um traço novo (sem sobra).
   */
  function _criarEstruturaTraco(num, sugeridoIni) {
    return {
      id: 'traco_' + nowBrasilia().getTime() + '_' + num,
      num,
      berco_ini: sugeridoIni,
      berco_fim: '',
      cimento_real: { original: '', ajustes: [] },
      agua_real: { original: '', ajustes: [] },
      eps_real: { original: '', ajustes: [] },
      superplast_real: { original: '', ajustes: [] },
      incorporador_real: { original: '', ajustes: [] },
      tempo_batida: { original: '', ajustes: [] },
      densidade_insumo: { original: '', ajustes: [] },
      flow_insumo: { original: '', ajustes: [] },
      densidade: '',
      flow: '',
      obs: '',
      silo: '',
      expansao: '',
      densidadeEPS: '',
      // Campo para rastrear múltiplas operações em que o traço foi usado
      operacoes: [],
    };
  }

  /**
   * Adiciona o traço ao state a partir de um objeto de sobra,
   * REUTILIZANDO o mesmo ID, número e receita — sem criar traço novo.
   * O número (num) é o mesmo do traço original — reaproveitar sobra NÃO
   * consome um número novo do contador progressivo diário, e não participa
   * da renumeração dos traços novos desta operação.
   */
  function _adicionarTracoDeSobra(sobra) {
    const prevTraco = state.tracos[state.tracos.length - 1];
    const sugeridoIni = prevTraco?.berco_fim ? String(Number(prevTraco.berco_fim) + 1) : '1';

    // Reconstrói o traço a partir dos dados persistidos na sobra
    const receita = sobra.receita || {};
    const traco = {
      // MANTÉM o ID e o número originais — não gera novos
      id: sobra.tracoId,
      num: sobra.numTraco,
      berco_ini: sugeridoIni,
      berco_fim: '',
      // Receita carregada da sobra
      cimento_real: receita.cimento_real || { original: '', ajustes: [] },
      agua_real: receita.agua_real || { original: '', ajustes: [] },
      eps_real: receita.eps_real || { original: '', ajustes: [] },
      superplast_real: receita.superplast_real || { original: '', ajustes: [] },
      incorporador_real: receita.incorporador_real || { original: '', ajustes: [] },
      tempo_batida: receita.tempo_batida || { original: '', ajustes: [] },
      // Flow e densidade carregados — o operador pode registrar o novo resultado medido
      densidade_insumo: (sobra.densidade !== undefined && sobra.densidade !== null)
        ? { original: String(sobra.densidade), ajustes: [] }
        : { original: '', ajustes: [] },
      flow_insumo: (sobra.flow !== undefined && sobra.flow !== null)
        ? { original: String(sobra.flow), ajustes: [] }
        : { original: '', ajustes: [] },
      densidade: (sobra.densidade !== undefined && sobra.densidade !== null) ? sobra.densidade : '',
      flow: (sobra.flow !== undefined && sobra.flow !== null) ? sobra.flow : '',
      obs: receita.obs || '',
      silo: receita.silo || '',
      expansao: receita.expansao || '',
      densidadeEPS: receita.densidadeEPS || '',
      // Rastreia todas as operações onde este traço foi usado
      operacoes: [
        { operacaoId: sobra.operacaoOrigem, tipo: 'origem' },
        { operacaoId: null, tipo: 'reaproveitamento' }, // preenchido ao registrar
      ],
      _reaproveitado: true, // flag interna para uso na UI
      _sobraOrigem: sobra.operacaoOrigem,
    };

    state.tracos.push(traco);
    expandedTracoIndex = state.tracos.length - 1;
    renderTracos();
    persist();
  }

  /**
   * Cria um traço novo diretamente, sem verificar sobra.
   * O número exibido (Nº) é uma PRÉVIA calculada localmente a partir do total
   * de traços já confirmados hoje no servidor (state.baseNumTraco) — ainda não
   * é um número reservado/definitivo. Só ao finalizar a operação o total real
   * do servidor avança (ver finalizarInjecao -> LW.confirmarTracosHoje).
   * Isso permite criar e excluir traços livremente sem "furar" a sequência.
   */
  async function _adicionarTracoNovo() {
    await _garantirBaseNumTraco();
    const prevTraco = state.tracos[state.tracos.length - 1];
    const sugeridoIni = prevTraco?.berco_fim ? String(Number(prevTraco.berco_fim) + 1) : '1';
    const traco = _criarEstruturaTraco(0, sugeridoIni); // num provisório, corrigido abaixo
    state.tracos.push(traco);
    _renumerarTracos();
    expandedTracoIndex = state.tracos.length - 1;
    renderTracos();
    persist();
  }

  /**
   * Ponto de entrada público ao clicar "Adicionar Traço".
   * Verifica sobra ativa e exibe modal de decisão se houver.
   */
  async function addTraco() {
    let sobra = null;
    try { sobra = await LW.getSobra(); } catch (_) { sobra = null; }

    if (!sobra) {
      // Fluxo normal — sem sobra ativa
      await _adicionarTracoNovo();
      return;
    }

    // Existe sobra ativa — exibe modal de decisão
    _mostrarModalSobra(sobra);
  }

  // ============================================================
  //  LÓGICA DE SOBRA
  // ============================================================

  /**
   * Exibe o modal de decisão quando há sobra ativa ao adicionar traço.
   */
  function _mostrarModalSobra(sobra) {
    // Remove modal anterior se existir
    const existente = document.getElementById('modal-sobra-decisao');
    if (existente) existente.remove();

    const modal = document.createElement('div');
    modal.id = 'modal-sobra-decisao';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;display:flex;align-items:center;justify-content:center';

    modal.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);
                  padding:32px;width:460px;max-width:92vw;box-shadow:0 24px 80px rgba(0,0,0,.6)">
        <div style="text-align:center;margin-bottom:20px">
          <div style="font-size:2.2rem;margin-bottom:8px">♻️</div>
          <h2 style="font-family:var(--font-display);font-size:1.3rem;color:var(--accent);margin:0">
            Sobra de Traço Encontrada
          </h2>
        </div>
        <p style="color:var(--text-2);text-align:center;margin-bottom:20px;line-height:1.5">
          Foi encontrada uma sobra do traço <strong style="color:var(--text)">${sobra.tracoId}</strong>
          da operação <strong style="color:var(--text)">${sobra.operacaoOrigem}</strong>.
          <br>Deseja utilizar este restante?
        </p>
        <div style="background:var(--bg-2);border-radius:var(--radius);padding:14px;margin-bottom:24px;font-size:.82rem;color:var(--text-2)">
          ${sobra.flow ? `<div>Flow: <strong style="color:var(--text)">${sobra.flow} mm</strong></div>` : ''}
          ${sobra.densidade ? `<div>Densidade: <strong style="color:var(--text)">${sobra.densidade} kg/m³</strong></div>` : ''}
          <div style="color:var(--text-3);font-size:.75rem;margin-top:4px">${new Date(sobra.data).toLocaleString('pt-BR')}</div>
        </div>
        <div style="display:flex;gap:12px">
          <button id="btn-utilizar-sobra"
            style="flex:1;padding:12px;background:var(--accent);color:#000;border:none;border-radius:var(--radius);
                   font-weight:700;font-size:.9rem;cursor:pointer">
            ♻️ Utilizar Sobra
          </button>
          <button id="btn-criar-novo-traco"
            style="flex:1;padding:12px;background:var(--bg-2);color:var(--text);border:1px solid var(--border);
                   border-radius:var(--radius);font-size:.9rem;cursor:pointer">
            + Criar Novo Traço
          </button>
        </div>
      </div>`;

    document.body.appendChild(modal);

    document.getElementById('btn-utilizar-sobra').addEventListener('click', async () => {
      modal.remove();
      // Garante que a base do contador diário esteja definida nesta operação,
      // mesmo que o primeiro traço adicionado seja um reaproveitado de sobra.
      await _garantirBaseNumTraco();
      // Adiciona o traço reaproveitado ao state
      _adicionarTracoDeSobra(sobra);
      // Marca sobra como utilizada (em segundo plano para não travar a UI)
      try { await LW.desativarSobra('utilizada'); } catch (_) { }
    });

    document.getElementById('btn-criar-novo-traco').addEventListener('click', () => {
      modal.remove();
      _mostrarModalDescarteSobra(sobra, () => _adicionarTracoNovo());
    });
  }

  /**
   * Exibe modal perguntando se o usuário quer descartar a sobra
   * antes de criar um novo traço.
   */
  function _mostrarModalDescarteSobra(sobra, callbackProsseguir) {
    const existente = document.getElementById('modal-descarte-sobra');
    if (existente) existente.remove();

    const modal = document.createElement('div');
    modal.id = 'modal-descarte-sobra';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1001;display:flex;align-items:center;justify-content:center';

    modal.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);
                  padding:32px;width:420px;max-width:92vw;box-shadow:0 24px 80px rgba(0,0,0,.6)">
        <div style="text-align:center;margin-bottom:16px">
          <div style="font-size:2rem;margin-bottom:8px">⚠️</div>
          <h2 style="font-family:var(--font-display);font-size:1.2rem;color:var(--amber);margin:0">
            Sobra Ativa Não Utilizada
          </h2>
        </div>
        <p style="color:var(--text-2);text-align:center;margin-bottom:24px;line-height:1.5">
          Existe uma sobra ativa do traço
          <strong style="color:var(--text)">${sobra.tracoId}</strong>
          da operação <strong style="color:var(--text)">${sobra.operacaoOrigem}</strong>.
          <br><br>Deseja descartá-la?
        </p>
        <div style="display:flex;gap:12px">
          <button id="btn-descartar-sobra"
            style="flex:1;padding:12px;background:var(--red);color:#fff;border:none;border-radius:var(--radius);
                   font-weight:700;font-size:.9rem;cursor:pointer">
            Descartar Sobra
          </button>
          <button id="btn-cancelar-descarte"
            style="flex:1;padding:12px;background:var(--bg-2);color:var(--text);border:1px solid var(--border);
                   border-radius:var(--radius);font-size:.9rem;cursor:pointer">
            Cancelar
          </button>
        </div>
      </div>`;

    document.body.appendChild(modal);

    document.getElementById('btn-descartar-sobra').addEventListener('click', async () => {
      modal.remove();
      try { await LW.desativarSobra('descartada'); } catch (_) { }
      await callbackProsseguir();
    });

    document.getElementById('btn-cancelar-descarte').addEventListener('click', () => {
      modal.remove();
      // Não faz nada — usuário cancelou
    });
  }

  /**
   * Exibe o modal de sobra ao finalizar uma operação.
   * Pergunta se houve sobra no ÚLTIMO traço e persiste sobra.json se sim.
   * @param {object} record — registro já salvo da operação
   */
  function _perguntarSobraAoFinalizar(record) {
    const tracos = record.tracos || [];
    if (tracos.length === 0) return;

    const ultimoTraco = tracos[tracos.length - 1];

    // Se o traço já é um reaproveitamento de sobra e ainda sobrou mais, também pergunta
    const existente = document.getElementById('modal-pergunta-sobra');
    if (existente) existente.remove();

    const modal = document.createElement('div');
    modal.id = 'modal-pergunta-sobra';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;display:flex;align-items:center;justify-content:center';

    const labelTraco = `Traço Nº ${ultimoTraco.num}` + (tracos.length > 1 ? ` (último traço)` : '');

    modal.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);
                  padding:32px;width:420px;max-width:92vw;box-shadow:0 24px 80px rgba(0,0,0,.6)">
        <div style="text-align:center;margin-bottom:16px">
          <div style="font-size:2rem;margin-bottom:8px">🪣</div>
          <h2 style="font-family:var(--font-display);font-size:1.2rem;color:var(--accent);margin:0">
            Sobra de Massa
          </h2>
        </div>
        <p style="color:var(--text-2);text-align:center;margin-bottom:24px;line-height:1.6">
          Houve sobra do <strong style="color:var(--text)">${labelTraco}</strong>
          ${tracos.length > 1 ? '<br><span style="font-size:.8rem;color:var(--text-3)">(Os demais traços já estão esgotados)</span>' : ''}
          ?
        </p>
        <div style="display:flex;gap:12px">
          <button id="btn-sobra-sim"
            style="flex:1;padding:14px;background:var(--accent);color:#000;border:none;border-radius:var(--radius);
                   font-weight:700;font-size:1rem;cursor:pointer">
            ✅ Sim
          </button>
          <button id="btn-sobra-nao"
            style="flex:1;padding:14px;background:var(--bg-2);color:var(--text);border:1px solid var(--border);
                   border-radius:var(--radius);font-size:1rem;cursor:pointer">
            ❌ Não
          </button>
        </div>
      </div>`;

    document.body.appendChild(modal);

    document.getElementById('btn-sobra-sim').addEventListener('click', async () => {
      modal.remove();
      // Persiste a sobra ativa
      const sobra = {
        ativa: true,
        tracoId: ultimoTraco.id,
        numTraco: ultimoTraco.num, // preserva o Nº original — reaproveitar não consome número novo
        operacaoOrigem: record.id,
        flow: totalInsumo(ultimoTraco.flow_insumo, 'flow') || ultimoTraco.flow || '',
        densidade: totalInsumo(ultimoTraco.densidade_insumo, 'densidade') || ultimoTraco.densidade || '',
        receita: {
          cimento_real: ultimoTraco.cimento_real,
          agua_real: ultimoTraco.agua_real,
          eps_real: ultimoTraco.eps_real,
          superplast_real: ultimoTraco.superplast_real,
          incorporador_real: ultimoTraco.incorporador_real,
          tempo_batida: ultimoTraco.tempo_batida,
          silo: ultimoTraco.silo,
          expansao: ultimoTraco.expansao,
          densidadeEPS: ultimoTraco.densidadeEPS,
          obs: ultimoTraco.obs,
        },
        data: new Date().toISOString(),
        status: 'ativa',
      };
      try {
        await LW.salvarSobra(sobra);
      } catch (err) {
        console.warn('[LW] Falha ao salvar sobra:', err.message);
      }
      showSuccessModal(record);
    });

    document.getElementById('btn-sobra-nao').addEventListener('click', async () => {
      modal.remove();
      // Garante que não há sobra ativa residual para o traço encerrado
      try { await LW.desativarSobra('descartada'); } catch (_) { }
      showSuccessModal(record);
    });
  }

  function removeTraco(i) {
    const traco = state.tracos[i];

    if (traco && traco._reaproveitado) {
      // Se for um traço reaproveitado, exibe modal de confirmação
      _mostrarModalConfirmacaoExclusao(i, () => {
        // Callback de confirmação: executa a remoção real e renumera os
        // traços novos restantes (o reaproveitado removido não afeta a
        // sequência, pois nunca participou dela).
        state.tracos.splice(i, 1);
        _renumerarTracos();
        expandedTracoIndex = Math.min(expandedTracoIndex, state.tracos.length - 1);
        renderTracos();
        persist();
      });
    } else {
      // Traço normal: remove e renumera os demais traços novos em sequência
      // a partir de baseNumTraco — ex: remover o 2º de 3 faz o 3º assumir o
      // número do 2º, sem buracos.
      state.tracos.splice(i, 1);
      _renumerarTracos();
      expandedTracoIndex = Math.min(expandedTracoIndex, state.tracos.length - 1);
      renderTracos();
      persist();
    }
  }

  // Formata a exibição dos ajustes: "9,5 + 0,5 + 0,3 = 10,3" ou "9,5 → 10,0 → 10,5"
  function formatAjustesDisplay(insumo, decimais, fieldKey) {
    if (!insumo || !insumo.ajustes || insumo.ajustes.length === 0) return '';
    const isResultado = fieldKey && (fieldKey.includes('densidade') || fieldKey.includes('flow'));
    const orig = parseFloat(insumo.original);
    const tot = totalInsumo(insumo, fieldKey);

    if (isResultado) {
      // Mostra evolução dos valores: original → ajuste1 → ajuste2
      const partes = [];
      if (!isNaN(orig)) partes.push(orig.toFixed(decimais));
      partes.push(...insumo.ajustes.map(a => parseFloat(a).toFixed(decimais)));
      return partes.join(' → ');
    }

    if (insumo.original === '') return '';
    const origStr = orig.toFixed(decimais);
    const partes = [origStr, ...insumo.ajustes.map(a => parseFloat(a).toFixed(decimais))];
    return partes.join(' + ') + ' = ' + (tot !== '' ? parseFloat(tot).toFixed(decimais) : '');
  }

  // ---- Duration Picker de Batida ----

  // Converte segundos totais → { h, m, s }
  function segParaHMS(seg) {
    const s = Math.max(0, Math.round(seg));
    return { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
  }

  // Converte { h, m, s } → segundos totais
  function hmsParaSeg(h, m, s) {
    return (parseInt(h) || 0) * 3600 + (parseInt(m) || 0) * 60 + (parseInt(s) || 0);
  }

  // Formata segundos como "Xh Ym Zs" ou "Ym Zs" ou "Zs"
  function formatDuracao(seg) {
    if (seg === '' || seg === null) return '—';
    const { h, m, s } = segParaHMS(parseInt(seg));
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
  }

  function renderCampoTempoBatida(t, i) {
    const insumo = t.tempo_batida || { original: '', ajustes: [] };
    const temAjustes = insumo.ajustes && insumo.ajustes.length > 0;
    const total = totalInsumo(insumo, 'tempo_batida');

    // Valor exibido no picker: se tem ajustes usa total, senão usa original
    const segAtual = total !== '' ? parseInt(total) : (insumo.original !== '' ? parseInt(insumo.original) : 0);
    const temValor = insumo.original !== '' || temAjustes;
    const { h, m, s } = segParaHMS(segAtual);

    const formula = temAjustes ? (() => {
      const partes = [parseFloat(insumo.original) || 0, ...insumo.ajustes].map(v => formatDuracao(v));
      return partes.join(' + ') + ' = ' + formatDuracao(parseInt(total));
    })() : '';

    return `
      <div class="form-group insumo-group tempo-batida-group" id="tempo-batida-group-${i}">
        <label class="form-label">⏱ Tempo de Batida</label>
        <div class="duration-picker">
          <div class="duration-col">
            <button class="dur-btn dur-up ${t._reutilizado ? 'readonly-reaproveitado' : ''}" onclick="LWOp.ajustarDuracao(${i},'h',1) ${t._reaproveitado ? 'disabled' : ''}">▲</button>
            <input class="dur-input" type="number" min="0" max="23"
              id="dur-h-${i}" value="${temValor ? h : ''}" placeholder="0"
              oninput="LWOp.onDuracaoInput(${i})">
            <button class="dur-btn dur-dn  ${t._reutilizado ? 'readonly-reaproveitado' : ''}" onclick="LWOp.ajustarDuracao(${i},'h',-1)  ${t._reaproveitado ? 'disabled' : ''}">▼</button>
            <span class="dur-label">h</span>
          </div>
          <span class="dur-sep">:</span>
          <div class="duration-col">
            <button class="dur-btn dur-up  ${t._reutilizado ? 'readonly-reaproveitado' : ''}" onclick="LWOp.ajustarDuracao(${i},'m',1)  ${t._reaproveitado ? 'disabled' : ''}">▲</button>
            <input class="dur-input" type="number" min="0" max="59"
              id="dur-m-${i}" value="${temValor ? m : ''}" placeholder="0"
              oninput="LWOp.onDuracaoInput(${i})">
            <button class="dur-btn dur-dn  ${t._reutilizado ? 'readonly-reaproveitado' : ''}" onclick="LWOp.ajustarDuracao(${i},'m',-1)  ${t._reaproveitado ? 'disabled' : ''}">▼</button>
            <span class="dur-label">min</span>
          </div>
          <span class="dur-sep">:</span>
          <div class="duration-col">
            <button class="dur-btn dur-up ${t._reutilizado ? 'readonly-reaproveitado' : ''}" onclick="LWOp.ajustarDuracao(${i},'s',1)  ${t._reaproveitado ? 'disabled' : ''}">▲</button>
            <input class="dur-input" type="number" min="0" max="59"
              id="dur-s-${i}" value="${temValor ? s : ''}" placeholder="0"
              oninput="LWOp.onDuracaoInput(${i})">
            <button class="dur-btn dur-dn ${t._reutilizado ? 'readonly-reaproveitado' : ''}" onclick="LWOp.ajustarDuracao(${i},'s',-1)  ${t._reaproveitado ? 'disabled' : ''}">▼</button>
            <span class="dur-label">seg</span>
          </div>
        </div>
        ${temValor ? `<div class="dur-total-display">${formatDuracao(segAtual)} <span class="dur-seg-raw">(${segAtual}s)</span></div>` : ''}
        ${temAjustes ? `
          <div class="insumo-ajustes-display">
            <span class="ajustes-formula">${formula}</span>
            <span class="ajustes-total-badge">Total: ${formatDuracao(parseInt(total))}</span>
          </div>` : ''}
        ${temValor ? `
          <div class="ajuste-painel dur-ajuste-painel" id="ajuste-painel-${i}-tempo_batida" style="display:none">
            <div class="ajuste-painel-titulo">Adicionar tempo extra</div>
            <div class="duration-picker duration-picker--sm">
              <div class="duration-col">
                <button class="dur-btn dur-up" onclick="LWOp.ajustarDuracaoAjuste(${i},'h',1)" ${t.isReutilizado ? 'readonly-reaproveitado' : ''}>▲</button>
                <input class="dur-input" type="number" min="0" max="23"
                  id="dur-aj-h-${i}" value="0" placeholder="0">
                <button class="dur-btn dur-dn" onclick="LWOp.ajustarDuracaoAjuste(${i},'h',-1)">▼</button>
                <span class="dur-label">h</span>
              </div>
              <span class="dur-sep">:</span>
              <div class="duration-col">
                <button class="dur-btn dur-up" onclick="LWOp.ajustarDuracaoAjuste(${i},'m',1)">▲</button>
                <input class="dur-input" type="number" min="0" max="59"
                  id="dur-aj-m-${i}" value="0" placeholder="0">
                <button class="dur-btn dur-dn" onclick="LWOp.ajustarDuracaoAjuste(${i},'m',-1)">▼</button>
                <span class="dur-label">min</span>
              </div>
              <span class="dur-sep">:</span>
              <div class="duration-col">
                <button class="dur-btn dur-up" onclick="LWOp.ajustarDuracaoAjuste(${i},'s',1)">▲</button>
                <input class="dur-input" type="number" min="0" max="59"
                  id="dur-aj-s-${i}" value="0" placeholder="0">
                <button class="dur-btn dur-dn" onclick="LWOp.ajustarDuracaoAjuste(${i},'s',-1)">▼</button>
                <span class="dur-label">seg</span>
              </div>
            </div>
            <div class="ajuste-painel-btns" style="margin-top:10px">
              <button class="btn btn-primary btn-sm" onclick="LWOp.salvarAjusteDuracao(${i})">Salvar</button>
              <button class="btn btn-ghost btn-sm" onclick="LWOp.fecharAjuste(${i},'tempo_batida')">Cancelar</button>
            </div>
          </div>
          <button class="btn-ajuste-tempo  ${t._reutilizado ? 'readonly-reaproveitado' : ''}" onclick="LWOp.abrirAjuste(${i},'tempo_batida',this) ${t._reaproveitado ? 'disabled' : ''}" title>+ tempo extra</button>
        ` : ''}
      </div>`;
  }

  // Renderiza campo de insumo com botão de ajuste
  function renderCampoInsumo(t, i, fieldKey, label, step, decimais, placeholder) {
    const insumo = t[fieldKey] || { original: '', ajustes: [] };
    const isResultado = fieldKey && (fieldKey.includes('densidade') || fieldKey.includes('flow'));
    const temAjustes = insumo.ajustes && insumo.ajustes.length > 0;
    const displayAjustes = temAjustes ? formatAjustesDisplay(insumo, decimais, fieldKey) : '';
    const total = totalInsumo(insumo, fieldKey);

    // Para resultado (densidade/flow): input mostra original (valor medido), badge mostra atual
    // Para insumos: input mostra original, badge mostra total somado
    const valorExibido = insumo.original;

    // Painel: "Novo valor" para overwrite (resultado), "Quantidade a adicionar" para soma (insumos)
    const painelTitulo = isResultado ? 'Registrar novo valor' : 'Adicionar ajuste';
    const painelLabel = isResultado ? 'Novo valor:' : 'Quantidade:';
    const painelPlaceholder = isResultado ? placeholder : '0';

    return `
      <div class="form-group insumo-group">
        <label class="form-label">${label}</label>
        <div class="insumo-input-row">
          <input class="form-input ${t._reaproveitado ? 'readonly-reaproveitado' : ''}" type="number" step="${step}"
            value="${valorExibido}"
            oninput="LWOp.updateInsumoOriginal(${i},'${fieldKey}',this.value)"
            ${t._reaproveitado ? 'readonly' : ''}
            placeholder="${placeholder}">
          <button class="btn-ajuste ${t._reaproveitado ? 'readonly-reaproveitado' : ''}" title="${painelTitulo}" onclick="LWOp.abrirAjuste(${i},'${fieldKey}',this) ${t._reaproveitado ? 'disabled' : ''}">+</button>
        </div>
        ${temAjustes ? `
          <div class="insumo-ajustes-display">
            <span class="ajustes-formula">${displayAjustes}</span>
            <span class="ajustes-total-badge">${isResultado ? 'Atual' : 'Total'}: ${total !== '' ? parseFloat(total).toFixed(decimais) : '—'}</span>
          </div>` : ''}
        <div class="ajuste-painel" id="ajuste-painel-${i}-${fieldKey}" style="display:none">
          <div class="ajuste-painel-titulo">${painelTitulo}</div>
          <label class="form-label">${painelLabel}</label>
          <input class="form-input ajuste-qty-input" type="number" step="${step}"
            id="ajuste-input-${i}-${fieldKey}" placeholder="${painelPlaceholder}" value="">
          <div class="ajuste-painel-btns">
            <button class="btn btn-primary btn-sm" onclick="LWOp.salvarAjuste(${i},'${fieldKey}')">Salvar</button>
            <button class="btn btn-ghost btn-sm" onclick="LWOp.fecharAjuste(${i},'${fieldKey}')">Cancelar</button>
          </div>
        </div>
      </div>`;
  }

  function renderTracos() {
    const container = $('tracos-container');
    if (!container) return;

    // Garante que o índice selecionado seja válido se houver traços
    if (state.tracos.length > 0 && (expandedTracoIndex < 0 || expandedTracoIndex >= state.tracos.length)) {
      expandedTracoIndex = state.tracos.length - 1;
    }

    let html = '';

    // 1. Renderiza a Barra de Navegação por Abas
    if (state.tracos.length > 0) {
      html += `<div class="traco-tabs-nav">`;
      state.tracos.forEach((t, i) => {
        const isExpanded = i === expandedTracoIndex;
        const isComplete = t.berco_ini && t.berco_fim && t.silo && t.expansao && t.densidadeEPS;
        const hasData = t.berco_ini || t.berco_fim || t.silo || t.expansao || t.densidadeEPS || t.obs;

        const statusIcon = isComplete ? '✅' : (hasData ? '⚠️' : '⚪');
        const statusClass = isComplete ? 'complete' : (hasData ? 'pending' : 'empty');

        html += `
          <div class="traco-tab ${isExpanded ? 'active' : ''} ${statusClass}" 
            onclick="LWOp.selectTraco(${i})" title="Traço ${t.num}">
            <span class="status-icon">${statusIcon}</span>
            <span>Traço ${t.num}</span>
          </div>`;
      });
      html += `<button class="btn-add-traco-tab" onclick="LWOp.addTraco()" title="Adicionar traço">+</button>`;
      html += `</div>`;
    }

    state.tracos.forEach((t, i) => {
      // Garante migração de traços antigos
      migrarTraco(t);
      const isExpanded = i === expandedTracoIndex;

      html += `
      <div class="traco-row ${isExpanded ? '' : ' collapsed'}">
        <!-- Cabeçalho do traço -->
        <div class="traco-card-header" onclick="LWOp.selectTraco(${i})">
          <span class="traco-num-label">Traço <strong>Nº ${t.num}</strong>
            ${t._reaproveitado ? `<div class="traco-reaproveitado-badge" title="Traço reaproveitado da operação ${t._sobraOrigem || ''}">
                ♻️ <span class="main-text">sobra</span>
                <span class="sub-text"></span>
              </div>
            ` : ''}
          </span>
          <div class="traco-header-fields" onclick="if(${isExpanded}) event.stopPropagation()">
            <div class="form-group traco-header-field">
              <label class="form-label">Berço Início <span class="required">*</span></label>
                <input class="form-input" type="number" min="1" max="22" value="${t.berco_ini}"
                oninput="LWOp.updateTraco(${i},\'berco_ini\',this.value)" placeholder="—">
            </div>
            <div class="form-group traco-header-field">
              <label class="form-label">Berço Fim <span class="required">*</span></label>
                <input class="form-input" type="number" min="1" max="22" value="${t.berco_fim}"
                oninput="LWOp.updateTraco(${i},\'berco_fim\',this.value)" placeholder="—"}>
            </div>
            <div class="form-group traco-header-field">
              <label class="form-label">Silo do EPS <span class="required">*</span></label>
                <select class="form-select ${t._reaproveitado ? 'readonly-reaproveitado' : ''}" 
                onchange="LWOp.updateTraco(${i}, 'silo', this.value)"
                ${t._reaproveitado ? 'disabled' : ''}>
                <option value=""></option>
                <option value="Silo 1" ${t.silo === 'Silo 1' ? 'selected' : ''}>Silo 1</option>
                <option value="Silo 2" ${t.silo === 'Silo 2' ? 'selected' : ''}>Silo 2</option>
                <option value="Silo 3" ${t.silo === 'Silo 3' ? 'selected' : ''}>Silo 3</option>
                <option value="Silo 4" ${t.silo === 'Silo 4' ? 'selected' : ''}>Silo 4</option>
              </select>
            </div>
            <div class="form-group traco-header-field">
              <label class="form-label">Expansão do EPS <span class="required">*</span></label>
              <select class="form-select ${t._reaproveitado ? 'readonly-reaproveitado' : ''}" 
                onchange="LWOp.updateTraco(${i}, 'expansao', this.value)"
                ${t._reaproveitado ? 'disabled' : ''}>
                <option value=""></option>
                <option value="1ª expansão" ${t.expansao === '1ª expansão' ? 'selected' : ''}>1ª expansão</option>
                <option value="2ª expansão" ${t.expansao === '2ª expansão' ? 'selected' : ''}>2ª expansão</option>
              </select>
            </div>
          </div>
          <button class="traco-remove-btn" onclick="event.stopPropagation(); LWOp.removeTraco(${i})" title="Remover traço">✕</button>
        </div>

        <div class="traco-card-body">
          <!-- Seção: Receita Real Pesada -->
          <div class="traco-section-label">⚖ Receita Real Pesada</div>
          <div class="traco-fields-grid traco-fields-grid--6">
            ${renderCampoInsumo(t, i, 'cimento_real', 'Cimento (kg)', '0.01', 2, 'kg', t._reaproveitado)}
            ${renderCampoInsumo(t, i, 'agua_real', 'Água (kg)', '0.01', 2, 'kg', t._reaproveitado)}
            ${renderCampoInsumo(t, i, 'eps_real', 'EPS (kg)', '0.01', 2, 'kg', t._reaproveitado)}
            ${renderCampoInsumo(t, i, 'superplast_real', 'Superplast. (kg)', '0.001', 3, 'kg', t._reaproveitado)}
            ${renderCampoInsumo(t, i, 'incorporador_real', 'Incorp. de Ar (kg)', '0.001', 3, 'kg', t._reaproveitado)}
            ${renderCampoTempoBatida(t, i, t._reaproveitado)}
          </div>

          <!-- Seção: Resultado -->
          <div class="traco-section-label">📊 Resultado Obtido</div>
          <div class="traco-fields-grid traco-fields-grid--4">
            <div class="form-group">
              <label class="form-label">Densidade EPS</label>
                <input class="form-input" type="number" step="0.01" value="${t.densidadeEPS}"
                oninput="LWOp.updateTraco(${i},\'densidadeEPS\',this.value)" placeholder="kg/m³"
                ${t._reaproveitado ? 'readonly class="readonly-reaproveitado"' : ''}>
            </div>
            ${renderCampoInsumo(t, i, 'densidade_insumo', 'Densidade do traço', '0.01', 2, 'kg/m³', t._reaproveitado)}
            ${renderCampoInsumo(t, i, 'flow_insumo', 'Flow (mm)', '1', 0, 'mm', t._reaproveitado)}
            <div class="form-group traco-obs-field">
              <label class="form-label">Observações</label>
                <input class="form-input" type="text" value="${t.obs}"
                oninput="LWOp.updateTraco(${i},\'obs\',this.value)" placeholder="Ajustes, correções, falhas...">
            </div>
          </div>
        </div>
      </div>`;
    });

    container.innerHTML = html;
  }

  function updatePendencias() {
    const tracosComSilo = state.tracos.length > 0 && state.tracos.every(t => !!t.silo);
    const tracosComExp = state.tracos.length > 0 && state.tracos.every(t => !!t.expansao);
    const tracosComDensidadeEPS = state.tracos.length > 0 && state.tracos.every(t => !!t.densidadeEPS);
    const checks = [
      { label: 'Turno definido', ok: !!state.turno },
      { label: 'Dimensão da bateria', ok: !!state.dimensao },
      { label: 'Tipo de montagem', ok: !!state.tipo_montagem },
      { label: 'ID da bateria', ok: !!state.id_bateria },
      { label: 'Injeção iniciada', ok: !!state.inicio },
      { label: 'Injeção finalizada', ok: !!state.fim },
      { label: 'Motivo do atraso', ok: state.houve_atraso === 'NÃO' || !!state.motivo_atraso },
      { label: 'Ao menos 1 traço', ok: state.tracos.length > 0 },
      { label: 'Silo em todos os traços', ok: tracosComSilo },
      { label: 'Expansão em todos os traços', ok: tracosComExp },
      { label: 'Densidade EPS em todos os traços', ok: tracosComDensidadeEPS }
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

    const badgeCount = $('pendencia-badge-count');
    const pending = checks.filter(c => !c.ok).length;
    if (badgeCount) {
      badgeCount.innerHTML = pending > 0
        ? `<span style="background:var(--red); color:#fff; border-radius:10px; padding:0 6px; font-size:.65rem; margin-left:4px">${pending}</span>`
        : ` ✅`;
    }
  }

  function registrarOperacao() {
    const bateria = LW.BATERIA_IDS.find(b => b.id === state.id_bateria);
    const bercos = parseInt(state.bercos_reais) || (bateria?.bercos || 0);

    const calc = LW.calcPaineis(state.tipo_montagem, bercos);

    const dataLocal = state.inicio.split('T')[0];

    const opId = 'op_' + nowBrasilia().getTime();
    const fullRecord = {
      id: opId,
      data: dataLocal,
      turno: state.turno,
      dimensao: state.dimensao,
      capacidade: bateria?.bercos || 0,
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
      tracos: state.tracos.map(t => {
        // Se o traço foi reaproveitado, completa a entrada de reaproveitamento com o ID real
        let operacoes = t.operacoes || [];
        if (t._reaproveitado) {
          operacoes = operacoes.map(op =>
            op.tipo === 'reaproveitamento' && op.operacaoId === null
              ? { ...op, operacaoId: opId }
              : op
          );
        }
        return {
          ...t,
          operacoes
        };
      }),
    };

    // Criamos uma versão simplificada para o historico.json (apenas IDs dos traços)
    const historyRecord = {
      ...fullRecord,
      tracos: fullRecord.tracos.map(t => ({ id: t.id }))
    };

    // Conta quantos traços NOVOS (não reaproveitados de sobra) sobraram nesta
    // operação — apenas esses consomem números do contador diário do servidor.
    const qtdTracosNovos = state.tracos.filter(t => !t._reaproveitado).length;

    Promise.all([
      LW.registrarOperacao(historyRecord),
      LW.registrarRelatorioInjecao(fullRecord),
      qtdTracosNovos > 0 ? LW.confirmarTracosHoje(qtdTracosNovos) : Promise.resolve(),
    ])
      .then(() => {
        LW.clearOperacaoAtual();
        clearInterval(timerInterval);
        resetState();
        renderAll();
        // Pergunta sobre sobra ANTES de mostrar o modal de sucesso
        _perguntarSobraAoFinalizar(fullRecord);
      })
      .catch(err => {
        alert('Erro ao salvar operação: ' + err.message);
      });
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

    const brNow = nowBrasilia();
    $('op-data').textContent = brNow.toLocaleDateString('pt-BR', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
      timeZone: 'UTC'
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
    selectTraco(i) {
      expandedTracoIndex = i; // Define o traço ativo e foca na visualização exclusiva
      renderTracos();
    },
    updateTraco(i, field, value) {
      state.tracos[i][field] = value;
      persist();
    },
    // Atualiza o valor original de um insumo com estrutura {original, ajustes}
    updateInsumoOriginal(i, field, value) {
      let insumo = state.tracos[i][field];
      if (!insumo || typeof insumo !== 'object' || !('ajustes' in insumo)) {
        insumo = { original: value, ajustes: [] };
        state.tracos[i][field] = insumo;
      } else {
        insumo.original = value;
      }
      persist();
    },
    // Abre o painel de ajuste para um insumo específico
    abrirAjuste(i, field, btn) {
      // Fecha qualquer painel aberto
      document.querySelectorAll('.ajuste-painel').forEach(p => {
        if (p.id !== `ajuste-painel-${i}-${field}`) p.style.display = 'none';
      });
      const painel = document.getElementById(`ajuste-painel-${i}-${field}`);
      if (!painel) return;
      const isOpen = painel.style.display !== 'none';
      painel.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) {
        const input = document.getElementById(`ajuste-input-${i}-${field}`);
        if (input) { input.value = ''; setTimeout(() => input.focus(), 50); }
      }
    },
    // Salva o ajuste e recalcula o total
    salvarAjuste(i, field) {
      const input = document.getElementById(`ajuste-input-${i}-${field}`);
      if (!input) return;
      const qty = parseFloat(input.value);
      if (isNaN(qty)) { input.focus(); return; }

      let insumo = state.tracos[i][field];
      if (!insumo || typeof insumo !== 'object' || !('ajustes' in insumo)) {
        insumo = { original: '', ajustes: [] };
        state.tracos[i][field] = insumo;
      }
      insumo.ajustes.push(qty);
      persist();
      renderTracos();
    },
    // Fecha o painel sem salvar
    fecharAjuste(i, field) {
      const painel = document.getElementById(`ajuste-painel-${i}-${field}`);
      if (painel) painel.style.display = 'none';
    },
    removeTraco,
    addTraco,

    // Lê os valores h/m/s do picker e retorna total em segundos
    _lerDuracaoPicker(prefixo, i) {
      const h = parseInt(document.getElementById(`${prefixo}-h-${i}`)?.value) || 0;
      const m = parseInt(document.getElementById(`${prefixo}-m-${i}`)?.value) || 0;
      const s = parseInt(document.getElementById(`${prefixo}-s-${i}`)?.value) || 0;
      return hmsParaSeg(h, m, s);
    },

    // Ajusta um campo (h/m/s) do picker principal com ▲▼, com wrap-around
    ajustarDuracao(i, campo, delta) {
      const id = `dur-${campo}-${i}`;
      const el = document.getElementById(id);
      if (!el) return;
      const max = campo === 'h' ? 23 : 59;
      let val = (parseInt(el.value) || 0) + delta;
      if (val < 0) val = max;
      if (val > max) val = 0;
      el.value = val;
      this.onDuracaoInput(i);
    },

    // Chamado quando o operador digita diretamente num campo do picker
    onDuracaoInput(i) {
      const seg = this._lerDuracaoPicker('dur', i);
      let insumo = state.tracos[i].tempo_batida;
      if (!insumo || typeof insumo !== 'object' || !('ajustes' in insumo)) {
        insumo = { original: String(seg), ajustes: [] };
        state.tracos[i].tempo_batida = insumo;
      } else {
        insumo.original = String(seg);
      }
      // Atualiza só o display de total sem re-renderizar tudo
      const dispEl = document.querySelector(`#tempo-batida-group-${i} .dur-total-display`);
      if (dispEl) dispEl.innerHTML = `${formatDuracao(seg)} <span class="dur-seg-raw">(${seg}s)</span>`;
      persist();
      renderTracos(); // Re-renderiza para atualizar a visibilidade do botão "+ tempo extra"
    },

    // Ajusta um campo do picker de ajuste (painel +tempo extra)
    ajustarDuracaoAjuste(i, campo, delta) {
      const id = `dur-aj-${campo}-${i}`;
      const el = document.getElementById(id);
      if (!el) return;
      const max = campo === 'h' ? 23 : 59;
      let val = (parseInt(el.value) || 0) + delta;
      if (val < 0) val = max;
      if (val > max) val = 0;
      el.value = val;
    },

    // Salva ajuste de duração (picker do painel +tempo extra)
    salvarAjusteDuracao(i) {
      const seg = this._lerDuracaoPicker('dur-aj', i);
      if (seg === 0) { document.getElementById(`dur-aj-s-${i}`)?.focus(); return; }
      let insumo = state.tracos[i].tempo_batida;
      if (!insumo || typeof insumo !== 'object' || !('ajustes' in insumo)) {
        insumo = { original: '', ajustes: [] };
        state.tracos[i].tempo_batida = insumo;
      }
      insumo.ajustes.push(seg);
      persist();
      renderTracos();
    },
    toggleCard(id) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('collapsed');
    },
    togglePopover(id, event) {
      if (event) event.stopPropagation();
      const el = document.getElementById(id);
      const wasActive = el.classList.contains('active');
      document.querySelectorAll('.ao-popover').forEach(p => p.classList.remove('active'));
      if (!wasActive) el.classList.add('active');
    },
    closeModal() {
      $('success-modal').style.display = 'none';
    }
  };

})();

/**
 * Exibe um modal de confirmação para exclusão de traços reaproveitados.
 * @param {number} i - Índice do traço a ser excluído.
 * @param {function} onConfirm - Callback a ser executado se o usuário confirmar a exclusão.
 */
function _mostrarModalConfirmacaoExclusao(i, onConfirm) {
  const existente = document.getElementById('modal-confirmacao-exclusao');
  if (existente) existente.remove();

  const modal = document.createElement('div');
  modal.id = 'modal-confirmacao-exclusao';
  modal.className = 'modal-confirmacao-exclusao'; // Usa a classe CSS definida

  modal.innerHTML = `
      <div>
        <div style="text-align:center;margin-bottom:16px">
          <div style="font-size:2.2rem;margin-bottom:8px">⚠️</div>
          <h2>Este traço é uma sobra reaproveitada.</h2>
        </div>
        <p>
          Ao excluir:
        </p>
        <ul>
          <li>o vínculo com o traço original será perdido;</li>
          <li>esta utilização deixará de ser registrada nesta operação.</li>
        </ul>
        <p>Deseja realmente excluir?</p>
        <div class="modal-btns">
          <button id="btn-cancelar-exclusao" class="btn-cancelar">Cancelar</button>
          <button id="btn-confirmar-exclusao" class="btn-excluir">Excluir</button>
        </div>
      </div>`;

  document.body.appendChild(modal);

  document.getElementById('btn-confirmar-exclusao').addEventListener('click', () => {
    modal.remove();
    onConfirm();
  });

  document.getElementById('btn-cancelar-exclusao').addEventListener('click', () => {
    modal.remove();
  });
}