// ─── public/js/offline-operacao.js ─────────────────────────────────────
// Registro de Operação Offline (PWA) — plano, ver README:
//   item 2 — esta página/arquivo (formulário standalone, fora da SPA)
//   item 3 — armazenamento local (uma operação pendente por vez)
//   item 4 — aviso quando a conexão volta no meio do preenchimento
//
// Deliberadamente SEM: WebSocket de operação ao vivo, sessão de
// usuário/perfil, conceito de "dono" da operação, sincronização entre
// abas — nada disso faz sentido sem rede nem sem login (ver README,
// item 2). O cronômetro roda 100% local (Date.now()/new Date()), sem
// depender de nenhum broadcast do servidor.
//
// Simplificações conscientes em relação ao formulário online
// (public/js/operacao.js) — mesmos CAMPOS de dado, UI mais simples:
//   - Sem "Ajustar Receita" (histórico de remedição em tempo real):
//     cada insumo é um valor único, direto (ainda guardado no formato
//     {original, ajustes:[]} pra bater com o que /registrar-relatorio-
//     injecao espera, só que `ajustes` sempre vazio aqui).
//   - Sem reaproveitamento de Sobra de Traço (depende do servidor saber
//     se existe sobra ativa — não dá pra checar isso offline).
//   - Montagem Personalizada: grade de <select> simples por berço, em
//     vez do editor visual (canvas, clique a clique) da tela online.
//   - Sem confirmação/prompt customizados (LW.mostrarConfirmacao/
//     mostrarPrompt, que vivem em data.js/operacao.js) — usa
//     confirm()/prompt() nativos do navegador.
// ─────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const DB_KEY = 'lw_operacao_offline_pendente';
  const M2_POR_PAINEL = 1.83;
  const LIMITE_INJECAO_MIN = 59;
  const TEMPO_CURA_HORAS = 8;
  const TIPO_MONTAGEM_PERSONALIZADA = 'PERSONALIZADA';

  const $ = (id) => document.getElementById(id);

  // ---- Config carregada de db/config.json (item 8 do plano: pré-
  // cacheada pelo Service Worker, então funciona mesmo sem rede DESDE
  // QUE o app já tenha sido instalado/aberto online pelo menos 1 vez
  // neste aparelho — ver PRECACHE_URLS em service-worker.js) ----
  let BATERIA_IDS = [];
  let MONTAGEM_OPCOES = [];
  let MONTAGEM_MAP = {};
  let CIMENTICIA_POR_TIPO = {};

  // ---- Estado da operação sendo preenchida ----
  let state = criarStateVazio();
  let idTemp = null;
  let iniciadoEm = null;
  let timerInterval = null;
  let expandedTracoIndex = 0;

  function criarStateVazio() {
    return {
      turno: '1º TURNO',
      dimensao: '',
      capacidade: 0,
      tipo_montagem: '',
      id_bateria: '',
      bercos_personalizados: null,
      inicio: null,
      fim: null,
      desemplaque: null,
      tempo_min: null,
      tempo_pausado_min: 0,
      houve_atraso: '',
      motivo_atraso: '',
      status: 'idle', // idle | running | finished
      pausas: [],
      tracos: [],
    };
  }

  function escaparHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function gerarIdTemp() {
    const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    return 'OFF-' + uuid; // prefixo deixa óbvio, em qualquer tela/log, que essa origem é offline
  }

  // ============================================================
  //  ARMAZENAMENTO LOCAL — item 3 do plano
  // ============================================================

  function persist(status) {
    const pendente = {
      idTemp,
      iniciadoEm,
      atualizadoEm: new Date().toISOString(),
      formRecord: montarFormRecord(),
      tracos: state.tracos,
      pausas: state.pausas,
      status: status || 'preenchendo',
    };
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(pendente));
    } catch (e) {
      console.warn('[LWOff] Falha ao salvar localmente:', e.message);
    }
    return pendente;
  }

  function montarFormRecord() {
    return {
      turno: state.turno,
      dimensao: state.dimensao,
      capacidade: state.capacidade,
      id_bateria: state.id_bateria,
      tipo_montagem: state.tipo_montagem,
      ...(state.tipo_montagem === TIPO_MONTAGEM_PERSONALIZADA ? { bercos_personalizados: state.bercos_personalizados } : {}),
      inicio: state.inicio,
      fim: state.fim,
      desemplaque: state.desemplaque,
      tempo_min: state.tempo_min,
      tempo_pausado_min: state.tempo_pausado_min,
      houve_atraso: state.houve_atraso,
      motivo_atraso: state.motivo_atraso || '',
      qtd_tracos: state.tracos.length,
    };
  }

  function carregarPendenteExistente() {
    let raw;
    try { raw = localStorage.getItem(DB_KEY); } catch (_) { return false; }
    if (!raw) return false;
    let pendente;
    try { pendente = JSON.parse(raw); } catch (_) { return false; }
    if (!pendente || pendente.status === 'sincronizado') return false;

    idTemp = pendente.idTemp;
    iniciadoEm = pendente.iniciadoEm;
    const fr = pendente.formRecord || {};
    state = {
      ...criarStateVazio(),
      turno: fr.turno || '1º TURNO',
      dimensao: fr.dimensao || '',
      capacidade: fr.capacidade || 0,
      tipo_montagem: fr.tipo_montagem || '',
      id_bateria: fr.id_bateria || '',
      bercos_personalizados: fr.bercos_personalizados || null,
      inicio: fr.inicio || null,
      fim: fr.fim || null,
      desemplaque: fr.desemplaque || null,
      tempo_min: fr.tempo_min ?? null,
      tempo_pausado_min: fr.tempo_pausado_min || 0,
      houve_atraso: fr.houve_atraso || '',
      motivo_atraso: fr.motivo_atraso || '',
      status: fr.fim ? 'finished' : (fr.inicio ? 'running' : 'idle'),
      pausas: pendente.pausas || [],
      tracos: pendente.tracos || [],
    };
    return true;
  }

  // ============================================================
  //  CONFIG (db/config.json) — item 8: pré-cacheada pelo Service Worker
  // ============================================================

  function extrairComponentesMontagem(opcao) {
    const porBerco = {};
    Object.keys(opcao || {}).forEach((chave) => {
      const m = chave.match(/^paineis_(.+)_por_berco$/);
      if (m) porBerco[m[1]] = Number(opcao[chave]) || 0;
    });
    return { porBerco };
  }

  function montarCimenticiaPorTipo(opcoes) {
    const mapa = {};
    (opcoes || []).forEach((o) => {
      if (o.modo === 'simples' && o.tipo) {
        mapa[o.tipo] = (o.cimenticia && typeof o.cimenticia === 'object')
          ? { leva: !!o.cimenticia.leva, quantidade: Number(o.cimenticia.quantidade) || 0 }
          : { leva: false, quantidade: 0 };
      }
    });
    return mapa;
  }

  async function loadConfig() {
    try {
      // Mesmo caminho relativo usado por data.js (loadConfig) — se o
      // Service Worker já tiver feito o precache (item 8), o browser
      // recebe a resposta cacheada mesmo 100% sem rede.
      const res = await fetch('db/config.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('config.json não encontrado');
      const cfg = await res.json();

      BATERIA_IDS = Array.isArray(cfg.baterias?.ids) ? cfg.baterias.ids : [];
      const opcoesMontagem = Array.isArray(cfg.tipos_montagem?.opcoes) ? cfg.tipos_montagem.opcoes : [];
      MONTAGEM_OPCOES = opcoesMontagem;
      MONTAGEM_MAP = {};
      opcoesMontagem.forEach((t) => { MONTAGEM_MAP[t.label] = extrairComponentesMontagem(t); });
      CIMENTICIA_POR_TIPO = montarCimenticiaPorTipo(opcoesMontagem);
      return true;
    } catch (e) {
      console.warn('[LWOff] Não foi possível carregar db/config.json (nem do cache do Service Worker):', e.message);
      $('off-aviso-primeira-vez').style.display = 'block';
      return false;
    }
  }

  function popularSelects() {
    const selBateria = $('off-bateria');
    selBateria.innerHTML = '<option value="">Selecione…</option>' + BATERIA_IDS.map((b) =>
      `<option value="${escaparHtml(b.id)}" ${state.id_bateria === b.id ? 'selected' : ''}>${escaparHtml(b.id)} — ${escaparHtml(b.label)}</option>`
    ).join('');

    const selMontagem = $('off-tipo-montagem');
    const opcoesHtml = MONTAGEM_OPCOES.map((o) =>
      `<option value="${escaparHtml(o.label)}" ${state.tipo_montagem === o.label ? 'selected' : ''}>${escaparHtml(o.label)}</option>`
    ).join('');
    selMontagem.innerHTML = '<option value="">Selecione…</option>' + opcoesHtml
      + `<option value="${TIPO_MONTAGEM_PERSONALIZADA}" ${state.tipo_montagem === TIPO_MONTAGEM_PERSONALIZADA ? 'selected' : ''}>Personalizada (por berço)</option>`;

    atualizarDimensaoAutoFill();
    atualizarGradePersonalizada();
  }

  function atualizarDimensaoAutoFill() {
    const bateria = BATERIA_IDS.find((b) => b.id === state.id_bateria);
    state.dimensao = bateria?.label || '';
    state.capacidade = bateria?.bercos || 0;
    $('off-dimensao').value = bateria ? `${bateria.label} (${bateria.bercos} berços)` : '';
  }

  // ============================================================
  //  MONTAGEM PERSONALIZADA — grade simplificada por berço
  // ============================================================

  function atualizarGradePersonalizada() {
    const wrap = $('off-grade-personalizada-wrap');
    const grade = $('off-grade-personalizada');
    if (state.tipo_montagem !== TIPO_MONTAGEM_PERSONALIZADA) {
      wrap.style.display = 'none';
      return;
    }
    wrap.style.display = 'block';
    const capacidade = state.capacidade || 0;
    if (!Array.isArray(state.bercos_personalizados) || state.bercos_personalizados.length !== capacidade) {
      const anterior = Array.isArray(state.bercos_personalizados) ? state.bercos_personalizados : [];
      state.bercos_personalizados = Array.from({ length: capacidade }, (_, i) => anterior[i] || null);
    }
    const tiposSimples = MONTAGEM_OPCOES.filter((o) => o.modo === 'simples');
    grade.innerHTML = Array.from({ length: capacidade }, (_, i) => {
      const atual = state.bercos_personalizados[i] || '';
      return `
        <div class="off-grade-celula">
          <label>Berço ${i + 1}</label>
          <select class="form-select" onchange="LWOff.updateBercoPersonalizado(${i}, this.value)">
            <option value="">—</option>
            ${tiposSimples.map((t) => `<option value="${escaparHtml(t.tipo)}" ${atual === t.tipo ? 'selected' : ''}>${escaparHtml(t.label)}</option>`).join('')}
          </select>
        </div>`;
    }).join('');
  }

  function updateBercoPersonalizado(i, valor) {
    if (!Array.isArray(state.bercos_personalizados)) return;
    state.bercos_personalizados[i] = valor || null;
    persist();
  }

  // ============================================================
  //  CÁLCULO DE PAINÉIS/M² — portado de public/js/data.js (funções
  //  puras, sem dependência de rede/sessão — calcPaineis/
  //  calcPaineisPersonalizado)
  // ============================================================

  function calcPaineis(tipoMontagem, bercos) {
    const map = MONTAGEM_MAP[tipoMontagem];
    const porBerco = (map && map.porBerco) ? map.porBerco : { sp: 2 };
    const paineis_por_tipo = {};
    let paineis_total = 0;
    Object.keys(porBerco).forEach((tipo) => {
      const qtd = bercos * (porBerco[tipo] || 0);
      paineis_por_tipo[tipo] = qtd;
      paineis_total += qtd;
    });
    const m2_por_tipo = {};
    Object.keys(paineis_por_tipo).forEach((tipo) => { m2_por_tipo[tipo] = paineis_por_tipo[tipo] * M2_POR_PAINEL; });
    let placas_cimenticia = 0;
    Object.keys(paineis_por_tipo).forEach((tipo) => {
      const c = CIMENTICIA_POR_TIPO[tipo];
      if (c && c.leva) placas_cimenticia += paineis_por_tipo[tipo] * (c.quantidade || 0);
    });
    return { total_paineis: paineis_total, m2_total: paineis_total * M2_POR_PAINEL, placas_cimenticia, paineis_por_tipo, m2_por_tipo };
  }

  function calcPaineisPersonalizado(bercosPersonalizados) {
    const paineis_por_tipo = {};
    let paineis_total = 0;
    (bercosPersonalizados || []).forEach((tipo) => {
      if (!tipo) return;
      const opcao = MONTAGEM_OPCOES.find((o) => o.modo === 'simples' && o.tipo === tipo);
      const porBerco = opcao ? (Number(opcao['paineis_' + tipo + '_por_berco']) || 0) : 0;
      paineis_por_tipo[tipo] = (paineis_por_tipo[tipo] || 0) + porBerco;
      paineis_total += porBerco;
    });
    const m2_por_tipo = {};
    Object.keys(paineis_por_tipo).forEach((tipo) => { m2_por_tipo[tipo] = paineis_por_tipo[tipo] * M2_POR_PAINEL; });
    let placas_cimenticia = 0;
    Object.keys(paineis_por_tipo).forEach((tipo) => {
      const c = CIMENTICIA_POR_TIPO[tipo];
      if (c && c.leva) placas_cimenticia += paineis_por_tipo[tipo] * (c.quantidade || 0);
    });
    return { total_paineis: paineis_total, m2_total: paineis_total * M2_POR_PAINEL, placas_cimenticia, paineis_por_tipo, m2_por_tipo };
  }

  // ============================================================
  //  CRONÔMETRO — 100% local (Date.now()), sem WebSocket/broadcast
  // ============================================================

  function estaPausada() {
    if (!state.pausas.length) return false;
    return !state.pausas[state.pausas.length - 1].retomado_em;
  }

  function diffMinutes(a, b) { return (new Date(b) - new Date(a)) / 60000; }

  function tempoPausadoMin(refISO) {
    return state.pausas.reduce((acc, p) => acc + diffMinutes(p.pausado_em, p.retomado_em || refISO), 0);
  }

  function formatDuration(minutes) {
    if (!minutes || isNaN(minutes)) return '—';
    const totalSeg = Math.round(minutes * 60);
    const h = Math.floor(totalSeg / 3600), m = Math.floor((totalSeg % 3600) / 60), s = totalSeg % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function formatTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function calcularDesemplaque(fimISO) {
    const fim = new Date(fimISO);
    if (isNaN(fim.getTime())) return null;
    return new Date(fim.getTime() + TEMPO_CURA_HORAS * 3600000).toISOString();
  }

  function iniciarInjecao() {
    if (state.status !== 'idle') return;
    state.inicio = new Date().toISOString();
    state.status = 'running';
    $('off-inicio').value = formatTime(state.inicio);
    $('off-btn-iniciar').disabled = true;
    $('off-btn-finalizar').disabled = false;
    startTimerUI();
    atualizarBtnPausar();
    persist();
    updatePendencias();
  }

  function togglePausa() {
    if (state.status !== 'running') return;
    if (!estaPausada()) {
      const confirmou = confirm('O cronômetro desta injeção vai congelar até você retomar. Use isso só em situações extraordinárias.');
      if (!confirmou) return;
      const motivo = prompt('Explique rapidamente por que esta operação está sendo pausada:');
      if (!motivo) return;
      state.pausas.push({ pausado_em: new Date().toISOString(), retomado_em: null, motivo });
    } else {
      state.pausas[state.pausas.length - 1].retomado_em = new Date().toISOString();
    }
    persist();
    atualizarBtnPausar();
  }

  function atualizarBtnPausar() {
    const btn = $('off-btn-pausar');
    btn.style.display = state.status === 'running' ? 'inline-flex' : 'none';
    btn.innerHTML = estaPausada() ? '▶ Retomar' : '⏸ Pausar';
    $('off-btn-finalizar').disabled = estaPausada() || state.status !== 'running';
  }

  function finalizarInjecao() {
    if (state.status !== 'running') return;
    if (estaPausada()) return;
    const confirmou = confirm('Isso vai parar o cronômetro e travar os campos de tempo desta operação. Encerrar a injeção agora?');
    if (!confirmou) return;

    state.fim = new Date().toISOString();
    state.status = 'finished';
    clearInterval(timerInterval);
    $('off-fim').value = formatTime(state.fim);
    $('off-btn-finalizar').disabled = true;
    atualizarBtnPausar();

    state.desemplaque = calcularDesemplaque(state.fim);
    $('off-desemplaque').textContent = formatDateTime(state.desemplaque);
    $('off-desemplaque-row').style.display = 'block';

    const minutosBruto = diffMinutes(state.inicio, state.fim);
    const minutosPausados = tempoPausadoMin(state.fim);
    const minutos = minutosBruto - minutosPausados;
    state.tempo_min = minutos;
    state.tempo_pausado_min = minutosPausados;

    const atraso = minutos > LIMITE_INJECAO_MIN;
    state.houve_atraso = atraso ? 'SIM' : 'NÃO';
    $('off-atraso').innerHTML = atraso
      ? `<span class="badge badge-red">⚠ SIM — ${Math.round(minutos)}min</span>`
      : `<span class="badge badge-green">✓ NÃO — ${Math.round(minutos)}min</span>`;
    $('off-motivo-row').style.display = atraso ? 'flex' : 'none';

    persist();
    updatePendencias();
  }

  function startTimerUI() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (!state.inicio) return;
      const agora = new Date().toISOString();
      const elapsed = diffMinutes(state.inicio, agora) - tempoPausadoMin(agora);
      const el = $('off-timer-display');
      el.textContent = formatDuration(elapsed);
      const m = Math.floor(elapsed);
      el.className = 'timer-display' + (m >= LIMITE_INJECAO_MIN ? ' danger' : m >= 50 ? ' warning' : '') + (estaPausada() ? ' timer-pausado' : '');
    }, 1000);
  }

  // ============================================================
  //  TRAÇOS
  // ============================================================

  function criarEstruturaTraco(num, sugeridoIni) {
    return {
      id: 'traco_off_' + Date.now() + '_' + num,
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
      obs: '',
      silo: '',
      expansao: '',
      densidadeEPS: '',
      operacoes: [],
    };
  }

  function addTraco() {
    const prev = state.tracos[state.tracos.length - 1];
    const sugeridoIni = prev?.berco_fim ? String(Number(prev.berco_fim) + 1) : '1';
    state.tracos.push(criarEstruturaTraco(state.tracos.length + 1, sugeridoIni));
    expandedTracoIndex = state.tracos.length - 1;
    renderTracos();
    persist();
    updatePendencias();
  }

  function removeTraco(i) {
    if (!confirm('Remover este traço?')) return;
    state.tracos.splice(i, 1);
    state.tracos.forEach((t, idx) => { t.num = idx + 1; });
    if (expandedTracoIndex >= state.tracos.length) expandedTracoIndex = Math.max(0, state.tracos.length - 1);
    renderTracos();
    persist();
    updatePendencias();
  }

  function updateTraco(i, campo, valor) {
    if (!state.tracos[i]) return;
    state.tracos[i][campo] = valor;
    persist();
    updatePendencias();
  }

  function updateInsumo(i, campo, valor) {
    if (!state.tracos[i]) return;
    state.tracos[i][campo].original = valor;
    persist();
    updatePendencias();
  }

  function updateTempoBatida(i, h, m, s) {
    const seg = (parseInt(h) || 0) * 3600 + (parseInt(m) || 0) * 60 + (parseInt(s) || 0);
    state.tracos[i].tempo_batida.original = seg;
    persist();
    updatePendencias();
  }

  function expandirTraco(i) {
    expandedTracoIndex = i;
    renderTracos();
  }

  function erroBercos(tracos, i) {
    const t = tracos[i];
    if (!t) return null;
    const num = (v) => (v === '' || v === null || v === undefined) ? null : Number(v);
    const ini = num(t.berco_ini), fim = num(t.berco_fim);
    if (ini !== null && (isNaN(ini) || ini <= 0)) return 'Berço início precisa ser maior que zero.';
    if (fim !== null && (isNaN(fim) || fim <= 0)) return 'Berço fim precisa ser maior que zero.';
    if (ini !== null && fim !== null && fim < ini) return 'Berço fim não pode ser menor que o berço início.';
    if (ini !== null && i > 0) {
      const fimAnt = num(tracos[i - 1]?.berco_fim);
      if (fimAnt !== null && ini < fimAnt) return `Berço início não pode ser menor que o berço fim do traço anterior (${fimAnt}).`;
    }
    return null;
  }

  function insumoPreenchido(insumo) {
    if (!insumo) return false;
    return (insumo.original !== '' && insumo.original !== null && insumo.original !== undefined);
  }

  function tracoCompleto(t, i, tracos) {
    return !!t.berco_ini && !!t.berco_fim && !!t.silo && !!t.expansao && !!t.densidadeEPS
      && !erroBercos(tracos, i)
      && insumoPreenchido(t.cimento_real) && insumoPreenchido(t.agua_real) && insumoPreenchido(t.eps_real)
      && insumoPreenchido(t.superplast_real) && insumoPreenchido(t.incorporador_real)
      && insumoPreenchido(t.tempo_batida) && insumoPreenchido(t.densidade_insumo) && insumoPreenchido(t.flow_insumo);
  }

  function statusDoTraco(t, i, tracos) {
    const completo = tracoCompleto(t, i, tracos);
    const temDado = t.berco_ini || t.berco_fim || t.silo || t.expansao || t.densidadeEPS || t.obs
      || insumoPreenchido(t.cimento_real) || insumoPreenchido(t.agua_real) || insumoPreenchido(t.eps_real)
      || insumoPreenchido(t.superplast_real) || insumoPreenchido(t.incorporador_real)
      || insumoPreenchido(t.tempo_batida) || insumoPreenchido(t.densidade_insumo) || insumoPreenchido(t.flow_insumo);
    return completo ? { icon: '✅', cls: 'complete' } : (temDado ? { icon: '⚠️', cls: 'pending' } : { icon: '⚪', cls: 'empty' });
  }

  function renderCampoInsumo(t, i, campo, label, step, decimais, placeholder) {
    const insumo = t[campo];
    const valor = insumo.original !== '' ? parseFloat(insumo.original).toFixed(decimais) : '';
    return `
      <div class="form-group insumo-group">
        <label class="form-label">${label} <span class="required">*</span></label>
        <div class="insumo-input-row">
          <input class="form-input" type="number" step="${step}" value="${valor}"
            oninput="LWOff.updateInsumo(${i},'${campo}',this.value)" placeholder="${placeholder}">
        </div>
      </div>`;
  }

  function segParaHMS(seg) {
    seg = Math.max(0, parseInt(seg) || 0);
    return { h: Math.floor(seg / 3600), m: Math.floor((seg % 3600) / 60), s: seg % 60 };
  }

  function renderCampoTempoBatida(t, i) {
    const insumo = t.tempo_batida;
    const temValor = insumo.original !== '';
    const { h, m, s } = segParaHMS(insumo.original || 0);
    return `
      <div class="form-group insumo-group tempo-batida-group">
        <label class="form-label">⏱ Tempo de Batida <span class="required">*</span></label>
        <div class="duration-picker">
          <div class="duration-col">
            <input class="dur-input" type="number" min="0" max="23" value="${temValor ? h : ''}" placeholder="0"
              onchange="LWOff.updateTempoBatida(${i}, this.value, document.getElementById('off-dur-m-${i}').value, document.getElementById('off-dur-s-${i}').value)"
              id="off-dur-h-${i}"><span class="dur-label">h</span>
          </div>
          <span class="dur-sep">:</span>
          <div class="duration-col">
            <input class="dur-input" type="number" min="0" max="59" value="${temValor ? m : ''}" placeholder="0"
              onchange="LWOff.updateTempoBatida(${i}, document.getElementById('off-dur-h-${i}').value, this.value, document.getElementById('off-dur-s-${i}').value)"
              id="off-dur-m-${i}"><span class="dur-label">min</span>
          </div>
          <span class="dur-sep">:</span>
          <div class="duration-col">
            <input class="dur-input" type="number" min="0" max="59" value="${temValor ? s : ''}" placeholder="0"
              onchange="LWOff.updateTempoBatida(${i}, document.getElementById('off-dur-h-${i}').value, document.getElementById('off-dur-m-${i}').value, this.value)"
              id="off-dur-s-${i}"><span class="dur-label">seg</span>
          </div>
        </div>
      </div>`;
  }

  function renderTracos() {
    const tabsEl = $('off-traco-tabs');
    const bodyEl = $('off-traco-body');
    if (!state.tracos.length) {
      tabsEl.innerHTML = '';
      bodyEl.innerHTML = '<div style="color:var(--text-3);padding:12px 0">Nenhum traço ainda — clique em "Adicionar Traço".</div>';
      return;
    }
    tabsEl.innerHTML = state.tracos.map((t, i) => {
      const { icon, cls } = statusDoTraco(t, i, state.tracos);
      return `<button type="button" class="traco-tab ${cls} ${i === expandedTracoIndex ? 'active' : ''}" onclick="LWOff.expandirTraco(${i})">
        <span class="status-icon">${icon}</span> Traço ${t.num}
      </button>`;
    }).join('');

    const t = state.tracos[expandedTracoIndex];
    if (!t) { bodyEl.innerHTML = ''; return; }
    const i = expandedTracoIndex;
    const erroBerco = erroBercos(state.tracos, i);

    bodyEl.innerHTML = `
      <div class="traco-row">
        <div class="traco-header-fields">
          <div class="form-group traco-header-field">
            <label class="form-label">Berço Início <span class="required">*</span></label>
            <input class="form-input ${erroBerco ? 'campo-invalido' : ''}" type="number" min="1" value="${t.berco_ini}"
              oninput="LWOff.updateTraco(${i},'berco_ini',this.value)" placeholder="—">
          </div>
          <div class="form-group traco-header-field">
            <label class="form-label">Berço Fim <span class="required">*</span></label>
            <input class="form-input ${erroBerco ? 'campo-invalido' : ''}" type="number" min="1" value="${t.berco_fim}"
              oninput="LWOff.updateTraco(${i},'berco_fim',this.value)" placeholder="—">
          </div>
          ${erroBerco ? `<div class="traco-erro-bercos">⚠ ${escaparHtml(erroBerco)}</div>` : ''}
          <div class="form-group traco-header-field">
            <label class="form-label">Silo do EPS <span class="required">*</span></label>
            <select class="form-select" onchange="LWOff.updateTraco(${i},'silo',this.value)">
              <option value=""></option>
              ${['Silo 1', 'Silo 2', 'Silo 3', 'Silo 4'].map((s) => `<option value="${s}" ${t.silo === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <div class="form-group traco-header-field">
            <label class="form-label">Expansão do EPS <span class="required">*</span></label>
            <select class="form-select" onchange="LWOff.updateTraco(${i},'expansao',this.value)">
              <option value=""></option>
              ${['1ª expansão', '2ª expansão'].map((s) => `<option value="${s}" ${t.expansao === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
        </div>
        <button class="traco-remove-btn" onclick="LWOff.removeTraco(${i})" title="Remover traço">✕</button>

        <div class="traco-card-body">
          <div class="traco-section-label">⚖ Receita Real Pesada</div>
          <div class="traco-fields-grid traco-fields-grid--6">
            ${renderCampoInsumo(t, i, 'cimento_real', 'Cimento (kg)', '0.01', 2, 'kg')}
            ${renderCampoInsumo(t, i, 'eps_real', 'EPS (kg)', '0.01', 2, 'kg')}
            ${renderCampoInsumo(t, i, 'agua_real', 'Água (kg)', '0.01', 2, 'kg')}
            ${renderCampoInsumo(t, i, 'superplast_real', 'Superplast. (kg)', '0.001', 2, 'kg')}
            ${renderCampoInsumo(t, i, 'incorporador_real', 'Incorp. de Ar (kg)', '0.001', 2, 'kg')}
            ${renderCampoTempoBatida(t, i)}
          </div>

          <div class="traco-section-label">📊 Resultado Obtido</div>
          <div class="traco-fields-grid traco-fields-grid--4">
            <div class="form-group">
              <label class="form-label">Densidade EPS <span class="required">*</span></label>
              <input class="form-input" type="number" step="0.01" value="${t.densidadeEPS}"
                oninput="LWOff.updateTraco(${i},'densidadeEPS',this.value)" placeholder="kg/m³">
            </div>
            ${renderCampoInsumo(t, i, 'densidade_insumo', 'Densidade do traço', '0.01', 2, 'kg/m³')}
            ${renderCampoInsumo(t, i, 'flow_insumo', 'Flow (mm)', '1', 0, 'mm')}
            <div class="form-group traco-obs-field">
              <label class="form-label">Observações</label>
              <input class="form-input" type="text" value="${escaparHtml(t.obs || '')}"
                oninput="LWOff.updateTraco(${i},'obs',this.value)" placeholder="Ajustes, correções, falhas...">
            </div>
          </div>
        </div>
      </div>`;
  }

  // ============================================================
  //  PENDÊNCIAS / VALIDAÇÃO
  // ============================================================

  function updatePendencias() {
    const tracosCompletos = state.tracos.length > 0 && state.tracos.every((t, i) => tracoCompleto(t, i, state.tracos));
    const tracosComErroBerco = state.tracos.filter((t, i) => !!erroBercos(state.tracos, i));
    const montagemOk = state.tipo_montagem === TIPO_MONTAGEM_PERSONALIZADA
      ? Array.isArray(state.bercos_personalizados) && state.bercos_personalizados.every(Boolean)
      : !!state.tipo_montagem;

    const checks = [
      { label: 'ID da bateria', ok: !!state.id_bateria },
      { label: 'Tipo de montagem (todos os berços definidos, se Personalizada)', ok: montagemOk },
      { label: 'Injeção iniciada', ok: !!state.inicio },
      { label: 'Injeção finalizada', ok: !!state.fim },
      { label: 'Operação não pode estar pausada', ok: !estaPausada() },
      { label: 'Motivo do atraso', ok: state.houve_atraso === 'NÃO' || !!state.motivo_atraso },
      { label: 'Ao menos 1 traço', ok: state.tracos.length > 0 },
      { label: 'Informações do traço (todos os campos obrigatórios)', ok: tracosCompletos },
      { label: 'Faixa de berços válida em todos os traços', ok: tracosComErroBerco.length === 0 },
    ];
    const allOk = checks.every((c) => c.ok);
    $('off-pendencia-list').innerHTML = checks.map((c) => `
      <div class="pendency-item ${c.ok ? 'ok' : 'err'}"><div class="dot"></div><span>${c.label}</span></div>
    `).join('');
    $('off-btn-registrar').disabled = !allOk;
    const pending = checks.filter((c) => !c.ok).length;
    $('off-pendencia-badge-count').innerHTML = pending > 0
      ? `<span style="background:var(--red); color:#fff; border-radius:10px; padding:0 6px; font-size:.65rem; margin-left:4px">${pending}</span>`
      : ' ✅';
  }

  // ============================================================
  //  REGISTRAR — tenta sincronizar (item 5, rota ainda não existe);
  //  se falhar, fica salvo localmente como "aguardando_conexao".
  // ============================================================

  async function registrar() {
    if ($('off-btn-registrar').disabled) return;
    state.motivo_atraso = $('off-motivo').value || state.motivo_atraso;

    const bateria = BATERIA_IDS.find((b) => b.id === state.id_bateria);
    const bercos = bateria?.bercos || 0;
    const calc = state.tipo_montagem === TIPO_MONTAGEM_PERSONALIZADA
      ? calcPaineisPersonalizado(state.bercos_personalizados)
      : calcPaineis(state.tipo_montagem, bercos);

    const pendente = persist('preenchendo');
    pendente.formRecord = { ...pendente.formRecord, ...calc };

    $('off-btn-registrar').disabled = true;
    $('off-btn-registrar').textContent = 'Enviando…';

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch('/operacao-offline/enviar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idTemp, formRecord: pendente.formRecord, tracos: state.tracos, pausas: state.pausas }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error('Servidor recusou o envio (HTTP ' + res.status + ')');

      // Sucesso — sincronizado de verdade, remove o pendente local.
      localStorage.removeItem(DB_KEY);
      mostrarTelaSucesso();
    } catch (e) {
      // Sem rota de sincronização disponível ainda, ou sem conexão —
      // mantém salvo localmente (status aguardando_conexao) e avisa.
      persist('aguardando_conexao');
      $('off-btn-registrar').disabled = false;
      $('off-btn-registrar').textContent = '✅ Registrar';
      mostrarBanner(
        `📡 Não foi possível enviar agora. Seu registro está salvo NESTE APARELHO ` +
        `(código ${idTemp}) e não será perdido — tente novamente quando a conexão ` +
        `com o servidor estiver disponível.`,
        'aviso'
      );
    }
  }

  function mostrarTelaSucesso() {
    document.querySelector('.off-wrap').innerHTML = `
      <div class="card" style="text-align:center;padding:40px 24px">
        <div style="font-size:2.4rem;margin-bottom:12px">✅</div>
        <div class="card-title" style="justify-content:center">Enviado para validação</div>
        <p style="color:var(--text-2);margin-top:10px;line-height:1.5">
          Peça a alguém com perfil Administrador para revisar e validar este
          registro em "Operações a Validar".
        </p>
        <a href="login.html" class="btn-primary" style="text-decoration:none;display:inline-block;margin-top:20px">← Voltar ao login</a>
      </div>`;
    document.querySelector('.off-actions-bar').style.display = 'none';
  }

  function descartarPendente() {
    if (!confirm('Tem certeza? Isso apaga TODOS os dados preenchidos neste rascunho offline — não tem como desfazer.')) return;
    localStorage.removeItem(DB_KEY);
    location.reload();
  }

  // ============================================================
  //  AVISO DE CONEXÃO — banner não-bloqueante (itens 1 e 4)
  // ============================================================

  function mostrarBanner(mensagem, tipo) {
    const el = $('off-status-banner');
    const cores = {
      aviso: 'background:rgba(245,158,11,.12);border:1px solid #f59e0b55;color:#fbbf24',
      sucesso: 'background:rgba(16,185,129,.12);border:1px solid #10b98155;color:#34d399',
    };
    el.innerHTML = `<div style="padding:12px 16px;border-radius:8px;font-size:.85rem;line-height:1.5;${cores[tipo] || cores.aviso}">${mensagem}</div>`;
  }

  // item 4 do plano: conexão volta NO MEIO do preenchimento (antes de
  // clicar Registrar) — mesma checagem ativa por fetch usada no item 1
  // (login.html) e no item 9 (operacao.js), já que o evento 'online' do
  // navegador sozinho não é confiável.
  let _avisouReconexao = false;
  async function checarReconexao() {
    if (state.status === 'finished' && _avisouReconexao) return; // já avisou, nada novo a dizer
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    try {
      await fetch('/minha-sessao', { method: 'GET', cache: 'no-store', signal: controller.signal });
      if (!_avisouReconexao) {
        _avisouReconexao = true;
        mostrarBanner(
          '🌐 Conexão restabelecida. Termine este registro; depois disso, o modo offline ficará bloqueado até alguém entrar com um perfil.',
          'sucesso'
        );
      }
    } catch (_) {
      _avisouReconexao = false;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ============================================================
  //  INICIALIZAÇÃO
  // ============================================================

  async function init() {
    const retomando = carregarPendenteExistente();
    if (!retomando) {
      idTemp = gerarIdTemp();
      iniciadoEm = new Date().toISOString();
    }

    await loadConfig();
    popularSelects();

    $('off-turno').value = state.turno;
    $('off-turno').addEventListener('change', (e) => { state.turno = e.target.value; persist(); });
    $('off-bateria').addEventListener('change', (e) => {
      state.id_bateria = e.target.value;
      atualizarDimensaoAutoFill();
      atualizarGradePersonalizada();
      persist();
      updatePendencias();
    });
    $('off-tipo-montagem').addEventListener('change', (e) => {
      state.tipo_montagem = e.target.value;
      if (state.tipo_montagem !== TIPO_MONTAGEM_PERSONALIZADA) state.bercos_personalizados = null;
      atualizarGradePersonalizada();
      persist();
      updatePendencias();
    });
    $('off-motivo').addEventListener('input', (e) => { state.motivo_atraso = e.target.value; persist(); });

    // Restaura campos visuais se estava retomando um pendente
    if (state.inicio) { $('off-inicio').value = formatTime(state.inicio); $('off-btn-iniciar').disabled = true; }
    if (state.fim) {
      $('off-fim').value = formatTime(state.fim);
      $('off-btn-finalizar').disabled = true;
      $('off-desemplaque').textContent = formatDateTime(state.desemplaque);
      $('off-desemplaque-row').style.display = 'block';
      const atraso = state.houve_atraso === 'SIM';
      $('off-atraso').innerHTML = atraso
        ? `<span class="badge badge-red">⚠ SIM — ${Math.round(state.tempo_min)}min</span>`
        : `<span class="badge badge-green">✓ NÃO — ${Math.round(state.tempo_min)}min</span>`;
      $('off-motivo-row').style.display = atraso ? 'flex' : 'none';
      $('off-motivo').value = state.motivo_atraso || '';
    } else if (state.status === 'running') {
      startTimerUI();
    }
    atualizarBtnPausar();
    renderTracos();
    updatePendencias();

    if (retomando) {
      mostrarBanner('↩️ Retomando um registro offline salvo neste aparelho, ainda não enviado.', 'aviso');
    }

    window.addEventListener('offline', () => { _avisouReconexao = false; });
    window.addEventListener('online', checarReconexao);
    setInterval(checarReconexao, 15000);
  }

  document.addEventListener('DOMContentLoaded', init);

  window.LWOff = {
    iniciarInjecao, togglePausa, finalizarInjecao,
    addTraco, removeTraco, updateTraco, updateInsumo, updateTempoBatida, expandirTraco,
    updateBercoPersonalizado, registrar, descartarPendente,
  };
})();
