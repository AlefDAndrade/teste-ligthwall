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

  const DB_KEY = 'lw_operacao_offline_pendente'; // rascunho ÚNICO em preenchimento (autosave)
  const FILA_KEY = 'lw_operacao_offline_fila'; // ARRAY de operações já "Registradas", aguardando sincronizar (permite mais de 1)
  const M2_POR_PAINEL = 1.83;
  const LIMITE_INJECAO_MIN = 59;
  const TEMPO_CURA_HORAS = 8;
  const TIPO_MONTAGEM_PERSONALIZADA = 'PERSONALIZADA';

  const $ = (id) => document.getElementById(id);

  // ---- Fuso horário: MESMA convenção "UTC falso = hora de Brasília" já
  // usada no resto do app (ver nowBrasilia() em public/js/data.js) —
  // devolve um Date cujos dígitos UTC representam a hora de Brasília
  // agora, não uma conversão de fuso real. Duplicada aqui (em vez de
  // reaproveitada de data.js) porque esta página (offline.html) é
  // deliberadamente standalone/pré-cacheada pro Service Worker funcionar
  // sem rede (ver comentário no topo do arquivo) e não carrega data.js.
  // Sem isso, `new Date().toISOString()` grava o instante em UTC de
  // verdade — que, quando aprovado e exibido pelas telas que SEGUEM a
  // convenção "UTC falso = Brasília" (ex.: formatTime() com
  // timeZone:'UTC' em data.js), aparece com +3h de diferença da hora que
  // o operador efetivamente digitou/apertou (bug: "registrei 6h, na
  // tabela apareceu 9h").
  function nowBrasilia() {
    const now = new Date();
    const brFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = brFormatter.formatToParts(now);
    const get = type => parts.find(p => p.type === type).value;
    const brStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
    return new Date(brStr + 'Z');
  }

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
      // Número a partir do qual os traços DESTA operação são numerados —
      // decidido no modal "Quantos traços já foram feitos hoje?"
      // (mostrarModalNumeroInicial, mais abaixo), perguntado 1x ao entrar
      // num rascunho NOVO (nunca ao retomar um já em andamento — ver
      // init()). `null` = ainda não perguntado (só acontece no instante
      // entre o boot e a resposta do modal); numeroDoTraco() trata esse
      // caso caindo pra 1, então nada quebra se algo tentar adicionar um
      // traço antes da resposta.
      numeroInicialTraco: null,
      // "🚫 Não Enchido" / vazamento (ver card Bateria Atual, abaixo) —
      // mesmo formato usado no online (bateria-atual.js/GET
      // /bercos-andamento): mapa esparso { 'B1': { esquerda:'baixou',
      // direita:'nao_enchido', tipos:{esquerda:'sp',direita:'2p'} } }.
      // Lado ausente (ou berço ausente por inteiro) = 'okay'. Só LOCAL —
      // não existe "outro dispositivo" pra sincronizar offline.
      bercos_marcados: {},
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

  // Autosave do rascunho ATUAL em preenchimento (1 por vez — faz sentido,
  // já que só existe 1 formulário na tela). Operações já "Registradas"
  // não passam mais por aqui: vão direto pra fila (ver adicionarNaFila),
  // que aceita várias.
  function persist() {
    const pendente = {
      idTemp,
      iniciadoEm,
      atualizadoEm: new Date().toISOString(),
      formRecord: montarFormRecord(),
      tracos: state.tracos,
      pausas: state.pausas,
      status: 'preenchendo',
    };
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(pendente));
    } catch (e) {
      console.warn('[LWOff] Falha ao salvar localmente:', e.message);
    }
    return pendente;
  }

  // ---- Fila de operações Registradas, aguardando sincronizar ----
  // (permite salvar mais de uma operação offline, uma atrás da outra)

  function lerFila() {
    let raw;
    try { raw = localStorage.getItem(FILA_KEY); } catch (_) { return []; }
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function salvarFila(fila) {
    try {
      localStorage.setItem(FILA_KEY, JSON.stringify(fila));
    } catch (e) {
      console.warn('[LWOff] Falha ao salvar fila localmente:', e.message);
    }
  }

  function adicionarNaFila(pendente) {
    const fila = lerFila();
    fila.push(pendente);
    salvarFila(fila);
    return fila;
  }

  function removerDaFila(idTempAlvo) {
    const fila = lerFila().filter((p) => p.idTemp !== idTempAlvo);
    salvarFila(fila);
    return fila;
  }

  // Compatibilidade com dados salvos ANTES desta mudança: no formato
  // antigo, uma operação já "Registrada" ficava sozinha em DB_KEY com
  // status "aguardando_conexao" (só existia 1 de cada vez). Se o
  // aparelho tiver algo assim, migra pra fila na entrada, sem perder o
  // registro.
  function migrarPendenteAntigoSeExistir() {
    let raw;
    try { raw = localStorage.getItem(DB_KEY); } catch (_) { return; }
    if (!raw) return;
    let pendenteAntigo;
    try { pendenteAntigo = JSON.parse(raw); } catch (_) { return; }
    if (pendenteAntigo && pendenteAntigo.status === 'aguardando_conexao') {
      adicionarNaFila(pendenteAntigo);
      try { localStorage.removeItem(DB_KEY); } catch (_) { /* ignore */ }
    }
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
      // Ver numeroDoTraco/mostrarModalNumeroInicial, acima — precisa
      // sobreviver a um F5 no meio do preenchimento (senão o modal
      // reapareceria e resetaria a numeração visual toda vez).
      numero_inicial_traco: state.numeroInicialTraco || 1,
      // Marcações de "baixou/vazou" e "🚫 Não Enchido" feitas no card
      // Bateria Atual (ver seção BATERIA ATUAL, abaixo) — só entra no
      // formRecord quando houver alguma, pra não poluir registros sem
      // nenhuma marcação. Aplicadas de verdade nos totais de painéis só
      // na hora de registrar() (ver ali) — aqui é só o rascunho salvo.
      ...(Object.keys(state.bercos_marcados || {}).length ? { bercos_marcados: state.bercos_marcados } : {}),
    };
  }

  function carregarPendenteExistente() {
    let raw;
    try { raw = localStorage.getItem(DB_KEY); } catch (_) { return false; }
    if (!raw) return false;
    let pendente;
    try { pendente = JSON.parse(raw); } catch (_) { return false; }
    if (!pendente) return false;

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
      bercos_marcados: fr.bercos_marcados || {},
      // fallback 1 cobre rascunhos salvos ANTES desta funcionalidade
      // existir (nunca tiveram esse campo) — comportamento idêntico ao
      // de sempre pra eles, sem quebrar nada.
      numeroInicialTraco: fr.numero_inicial_traco || 1,
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
    renderBateriaAtual(); // cor/tipo do berço na grade de Bateria Atual acompanha a Personalizada
    renderCalculoPaineis(); // total/por tipo mudam a cada berço definido na grade
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
    return {
      total_paineis: paineis_total,
      m2_total: paineis_total * M2_POR_PAINEL,
      placas_cimenticia,
      paineis_por_tipo,
      m2_por_tipo,
      // Aliases de compatibilidade (mesmo formato de LW.calcPaineis, data.js)
      // — usados pelas colunas fixas "Painéis 2/P"/"S/P" e "m² 2/P"/"S/P" da
      // tabela Registro de Baterias e pelos dashboards. Sem isso aqui, a
      // operação offline salvava total_paineis/m2_total certos mas 0 nessas
      // colunas por tipo (ver _derivarAliasesTipo, lib/rotas/operacao-offline.js,
      // que também cobre esse caso na validação, como segunda camada).
      paineis_2p: paineis_por_tipo['2p'] || 0,
      paineis_sp: paineis_por_tipo['sp'] || 0,
      m2_2p: m2_por_tipo['2p'] || 0,
      m2_sp: m2_por_tipo['sp'] || 0,
    };
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
    return {
      total_paineis: paineis_total,
      m2_total: paineis_total * M2_POR_PAINEL,
      placas_cimenticia,
      paineis_por_tipo,
      m2_por_tipo,
      // Ver comentário em calcPaineis, acima.
      paineis_2p: paineis_por_tipo['2p'] || 0,
      paineis_sp: paineis_por_tipo['sp'] || 0,
      m2_2p: m2_por_tipo['2p'] || 0,
      m2_sp: m2_por_tipo['sp'] || 0,
    };
  }

  // Desconta cada lado marcado "🚫 Não Enchido" (nunca "baixou/vazou" — só
  // vazamento não tira painel nenhum, é só um alerta visual) do resultado
  // de calcPaineis()/calcPaineisPersonalizado() — portado de
  // aplicarNaoEnchidosNoCalc (data.js) pra funcionar 100% offline. Chamado
  // só na hora de registrar() (ver abaixo), não a cada clique — o card
  // Bateria Atual em si não mostra totais, só a grade de berços.
  function aplicarNaoEnchidosNoCalc(calc, tipoMontagem, bercosPersonalizados, marcacoes) {
    if (!marcacoes || !Object.keys(marcacoes).length) return calc;

    const paineis_por_tipo = { ...(calc.paineis_por_tipo || {}) };

    Object.keys(marcacoes).forEach((berco) => {
      const bercoNum = parseInt(String(berco).replace(/^B/i, ''), 10);
      if (!bercoNum) return;
      const doBerco = marcacoes[berco] || {};
      ['direita', 'esquerda'].forEach((lado) => {
        if (doBerco[lado] !== 'nao_enchido') return;
        // Prioriza o tipo FIXADO no instante da marcação (ver
        // _offBaCliqueDot, abaixo) — mesma regra do online.
        const tipoFixado = (doBerco.tipos && doBerco.tipos[lado]) || null;
        const tipo = tipoFixado || tipoDoLadoMontagem(tipoMontagem, bercosPersonalizados, bercoNum, lado);
        if (tipo && paineis_por_tipo[tipo] > 0) paineis_por_tipo[tipo] -= 1;
      });
    });

    let paineis_total = 0;
    Object.keys(paineis_por_tipo).forEach((tipo) => { paineis_total += paineis_por_tipo[tipo]; });

    const m2_por_tipo = {};
    Object.keys(paineis_por_tipo).forEach((tipo) => { m2_por_tipo[tipo] = paineis_por_tipo[tipo] * M2_POR_PAINEL; });

    let placas_cimenticia = 0;
    Object.keys(paineis_por_tipo).forEach((tipo) => {
      const c = CIMENTICIA_POR_TIPO[tipo];
      if (c && c.leva) placas_cimenticia += paineis_por_tipo[tipo] * (c.quantidade || 0);
    });

    return {
      total_paineis: paineis_total,
      m2_total: paineis_total * M2_POR_PAINEL,
      placas_cimenticia,
      paineis_por_tipo,
      m2_por_tipo,
      // Ver comentário em calcPaineis, acima.
      paineis_2p: paineis_por_tipo['2p'] || 0,
      paineis_sp: paineis_por_tipo['sp'] || 0,
      m2_2p: m2_por_tipo['2p'] || 0,
      m2_sp: m2_por_tipo['sp'] || 0,
    };
  }

  // Mesma convenção do online (ver _tipoDoLadoMontagem, data.js): qual
  // TIPO de placa ('2p'/'sp'/...) um LADO específico de um berço produz —
  // usado só pra saber de qual tipo descontar quando o lado é marcado
  // "🚫 Não Enchido". Personalizada: tipo do berço inteiro (os 2 lados
  // sempre batem). Simples: único tipo possível. Híbrida: 1º tipo da
  // lista = direito, 2º = esquerdo (mesma convenção fixa do online).
  function tipoDoLadoMontagem(tipoMontagem, bercosPersonalizados, bercoNum, lado) {
    if (tipoMontagem === TIPO_MONTAGEM_PERSONALIZADA) {
      const grade = Array.isArray(bercosPersonalizados) ? bercosPersonalizados : [];
      return grade[bercoNum - 1] || null;
    }
    const opcao = (MONTAGEM_OPCOES || []).find((o) => o.label === tipoMontagem);
    if (!opcao) return null;
    if (opcao.modo === 'simples') return opcao.tipo || null;
    if (opcao.modo === 'hibrida' && Array.isArray(opcao.tipos)) {
      return lado === 'direita' ? (opcao.tipos[0] || null) : (opcao.tipos[1] || null);
    }
    return null;
  }

  // ============================================================
  //  CORES POR TIPO — portado de data.js (hslParaHex/hexParaRgba/
  //  corPorTipoSimples/corMontagemPorLabel), duplicado aqui (mesmo
  //  padrão já usado pra calcPaineis, acima) pra não depender de data.js
  //  nesta página standalone/offline.
  // ============================================================

  const COR_SATURACAO_SUGESTAO = 60;
  const COR_LUMINOSIDADE_SUGESTAO = 52;

  function hslParaHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const paraHex = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
    return `#${paraHex(f(0))}${paraHex(f(8))}${paraHex(f(4))}`;
  }

  function hexParaRgb(hex) {
    let h = String(hex || '').replace('#', '').trim();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const num = parseInt(h, 16) || 0;
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  function hexParaRgba(hex, alpha) {
    const { r, g, b } = hexParaRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function corCssDoHex(hex) {
    return { cor: hex, bg: hexParaRgba(hex, .15), borda: hexParaRgba(hex, .3) };
  }

  function corMontagemNeutra() {
    return { cor: '#5c6475', bg: 'rgba(156, 163, 175, .1)', borda: '#2a2f3a' };
  }

  function hexDoTipoSimples(tipoOuOpcao) {
    const op = typeof tipoOuOpcao === 'string'
      ? (MONTAGEM_OPCOES || []).find((o) => o.modo === 'simples' && o.tipo === tipoOuOpcao)
      : tipoOuOpcao;
    if (!op) return null;
    if (typeof op.cor === 'string' && op.cor) return op.cor;
    if (typeof op.corHue === 'number') return hslParaHex(op.corHue, COR_SATURACAO_SUGESTAO, COR_LUMINOSIDADE_SUGESTAO);
    return null;
  }

  // Cor de um tipo SIMPLES pelo código (ex: 'sp') — usado na grade de
  // Montagem Personalizada.
  function corPorTipoSimples(tipo) {
    const hex = hexDoTipoSimples(tipo);
    return hex ? corCssDoHex(hex) : corMontagemNeutra();
  }

  // Cor de um tipo de montagem pelo LABEL (ex: '2/P', 'HÍBRIDA 2p/sp') —
  // usado pra bateria uniforme (todo berço com o mesmo tipo).
  function corMontagemPorLabel(label) {
    const opcao = (MONTAGEM_OPCOES || []).find((o) => o.label === label);
    if (!opcao) return corMontagemNeutra();
    if (opcao.modo === 'simples') {
      const hex = hexDoTipoSimples(opcao);
      if (hex) return corCssDoHex(hex);
    }
    if (opcao.modo === 'hibrida' && Array.isArray(opcao.tipos) && opcao.tipos.length === 2) {
      const [op1, op2] = opcao.tipos.map((t) => (MONTAGEM_OPCOES || []).find((o) => o.modo === 'simples' && o.tipo === t));
      const hex1 = hexDoTipoSimples(op1);
      const hex2 = hexDoTipoSimples(op2);
      if (hex1 && hex2) {
        const c1 = corCssDoHex(hex1);
        const c2 = corCssDoHex(hex2);
        return { cor: c1.cor, bg: `linear-gradient(90deg, ${c1.bg} 50%, ${c2.bg} 50%)`, borda: c1.borda };
      }
    }
    return corMontagemNeutra();
  }

  function corPorTipoBerco(ehPersonalizada, tipo) {
    if (!tipo) return null;
    return ehPersonalizada ? corPorTipoSimples(tipo) : corMontagemPorLabel(tipo);
  }

  // Mesmas 5 cores de fallback do online (_CORES_TIPO_FALLBACK,
  // operacao.js) — usadas só quando o tipo não tem cor cadastrada em
  // Configurações → Bateria e Montagem.
  const CORES_TIPO_FALLBACK = ['var(--blue)', 'var(--green)', 'var(--accent)', 'var(--purple)', 'var(--yellow)'];

  // Cor de UM tipo (código, ex: '2p'/'sp') pros cards de Painéis/m² por
  // tipo — igual _corTipoCard (operacao.js): sempre corPorTipoSimples
  // (as chaves de paineis_por_tipo são sempre CÓDIGOS de tipo simples,
  // mesmo numa montagem híbrida ou personalizada), com fallback cíclico
  // só quando o tipo não tem cor cadastrada (cai no cinza neutro).
  function corTipoCard(tipo, i) {
    const cor = corPorTipoSimples(tipo);
    const ehNeutra = !cor || cor.cor === '#5c6475';
    return ehNeutra ? CORES_TIPO_FALLBACK[i % CORES_TIPO_FALLBACK.length] : cor.cor;
  }

  // Labels amigáveis pra tipos conhecidos — igual _labelTipo (operacao.js).
  function labelTipo(tipo) {
    const conhecidos = { '2p': '2/P', 'sp': 'S/P', '3p': '3/P' };
    if (conhecidos[tipo]) return conhecidos[tipo];
    const m = tipo.match(/^(\d+)p$/i);
    if (m) return `${m[1]}/P`;
    return tipo.toUpperCase();
  }

  // ============================================================
  //  CÁLCULO DE PAINÉIS (preview ao vivo) — mesmo cartão/grid do online
  //  (ver recalcPaineis, operacao.js): Total Painéis + cards por tipo
  //  (2/P, S/P, ...), m² Total + cards por tipo, Placas Cimentícia. Já
  //  aplica o desconto de "🚫 Não Enchido" marcado em Bateria Atual (ver
  //  state.bercos_marcados) — só o preview em tela; o total que de fato
  //  é REGISTRADO é recalculado do zero em registrar() (mesma fórmula).
  // ============================================================

  function renderCalculoPaineis() {
    const elTotal = $('off-paineis-total');
    if (!elTotal) return; // card só existe nesta tela

    const elM2Total = $('off-m2-total');
    const elCimenticia = $('off-placas-cimenticia');
    const elPaineisTipo = $('off-cards-paineis-tipo');
    const elM2Tipo = $('off-cards-m2-tipo');

    const bercos = state.capacidade || 0;
    if (!bercos || !state.tipo_montagem) {
      elTotal.textContent = '—';
      elM2Total.textContent = '—';
      elCimenticia.textContent = '—';
      if (elPaineisTipo) elPaineisTipo.innerHTML = '';
      if (elM2Tipo) elM2Tipo.innerHTML = '';
      return;
    }

    const base = state.tipo_montagem === TIPO_MONTAGEM_PERSONALIZADA
      ? calcPaineisPersonalizado(state.bercos_personalizados)
      : calcPaineis(state.tipo_montagem, bercos);
    const r = aplicarNaoEnchidosNoCalc(base, state.tipo_montagem, state.bercos_personalizados, state.bercos_marcados);

    elTotal.textContent = r.total_paineis;
    elM2Total.textContent = r.m2_total.toFixed(2) + ' m²';
    elCimenticia.textContent = r.placas_cimenticia;

    const tipos = Object.keys(r.paineis_por_tipo);
    if (elPaineisTipo) {
      elPaineisTipo.innerHTML = tipos.map((tipo, i) => `
        <div>
          <div style="font-size:.6rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px">
            Painéis ${labelTipo(tipo)}</div>
          <div style="font-family:var(--font-display);font-size:1.4rem;font-weight:800;color:${corTipoCard(tipo, i)}">
            ${r.paineis_por_tipo[tipo]}</div>
        </div>
      `).join('');
    }
    if (elM2Tipo) {
      elM2Tipo.innerHTML = tipos.map((tipo, i) => `
        <div>
          <div style="font-size:.6rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:2px">
            m² ${labelTipo(tipo)}</div>
          <div style="font-family:var(--font-display);font-size:1.1rem;font-weight:800;color:${corTipoCard(tipo, i)}">
            ${r.m2_por_tipo[tipo].toFixed(2)} m²</div>
        </div>
      `).join('');
    }
  }

  // ============================================================
  //  BATERIA ATUAL — versão offline do card sempre visível de
  //  bateria-atual.js, reaproveitando as MESMAS classes CSS (.ba-*,
  //  ver styles.css) pra ficar visualmente idêntico ao online. Duas
  //  diferenças de propósito em relação ao online:
  //   1) Sem trava de "dono da operação" nem sincronização entre
  //      dispositivos — offline não tem nenhum dos dois conceitos, os
  //      indicadores ficam sempre clicáveis.
  //   2) Sem o modo "📋 Detalhes do Berço" (modal com traço/receita/
  //      posição no palete) — não pedido aqui, e boa parte dos dados que
  //      ele mostra (traço já lançado, posição no palete configurado)
  //      não faz tanto sentido reaproveitar nesta tela mais simples.
  // ============================================================

  // Modo "🚫 Marcar Não Enchido" — enquanto ATIVO, clicar num indicador
  // marca aquele lado como 'nao_enchido' (✕) em vez de 'baixou' (● o
  // vazamento de sempre). Só estado local da tela (não precisa
  // persistir sozinho — o que importa é o que já foi marcado, guardado
  // em state.bercos_marcados).
  let _offModoNaoEnchido = false;

  // Lista de tipos por berço — igual _baTiposPorBerco (bateria-atual.js).
  function tiposPorBerco(capacidade) {
    if (state.tipo_montagem === TIPO_MONTAGEM_PERSONALIZADA) {
      const grade = Array.isArray(state.bercos_personalizados) ? state.bercos_personalizados : [];
      return Array.from({ length: capacidade }, (_, i) => grade[i] || null);
    }
    return Array.from({ length: capacidade }, () => state.tipo_montagem || null);
  }

  function tituloDot(estado, lado, tipo) {
    const ladoTxt = lado === 'direita' ? 'Direito' : 'Esquerdo';
    const tipoTxt = tipo ? ` (${escaparHtml(String(tipo).toUpperCase())})` : '';
    if (estado === 'nao_enchido') return `${ladoTxt}${tipoTxt} — Não enchido`;
    if (estado === 'baixou') return `${ladoTxt}${tipoTxt} — Baixou/Vazou`;
    return `${ladoTxt}${tipoTxt}`;
  }

  function renderBateriaAtual() {
    const el = $('off-bateria-atual-content');
    if (!el) return;

    if (!state.id_bateria || !state.tipo_montagem) {
      el.innerHTML = '<span class="ba-vazio">Defina a bateria e o tipo de montagem para ver a prévia aqui.</span>';
      return;
    }

    const capacidade = state.capacidade || 0;
    const tipos = tiposPorBerco(capacidade);
    const ehPersonalizada = state.tipo_montagem === TIPO_MONTAGEM_PERSONALIZADA;
    const marcacoes = state.bercos_marcados || {};

    const resumo = `
      <div class="ba-resumo">
        <strong>Bateria ${escaparHtml(state.id_bateria || '—')}</strong> — ${escaparHtml(state.tipo_montagem || '—')}
        ${capacidade ? ` — ${capacidade} berços` : ''}
      </div>`;

    const botaoModo = `<button type="button" id="off-ba-btn-nao-enchido" class="btn btn-sm ${_offModoNaoEnchido ? 'btn-danger' : 'btn-ghost'}">
        ${_offModoNaoEnchido ? '✕ Marcando Não Enchido — clique p/ desligar' : '🚫 Marcar Não Enchido'}
      </button>`;

    const dica = _offModoNaoEnchido
      ? `<div class="ba-dica ba-dica-nao-enchido">✕ Clique num indicador para marcar aquele lado como <strong>não enchido</strong> — o painel correspondente sai da grade de avaliação da Qualidade.</div>`
      : `<div class="ba-dica">🖱️ Clique num indicador (•) para marcar que aquele lado do berço baixou ou vazou</div>`;

    const grid = `<div class="ba-grid">${tipos.map((tipo, i) => {
      const cor = corPorTipoBerco(ehPersonalizada, tipo);
      const numero = String(i + 1).padStart(2, '0');
      const berco = 'B' + (i + 1);
      const bercoNum = i + 1;
      const marcadoBerco = marcacoes[berco] || {};
      const estadoDir = marcadoBerco.direita || null;
      const estadoEsq = marcadoBerco.esquerda || null;
      const dirMarcado = !!estadoDir;
      const esqMarcado = !!estadoEsq;
      const dirNaoEnchido = estadoDir === 'nao_enchido';
      const esqNaoEnchido = estadoEsq === 'nao_enchido';
      const tipoDir = (marcadoBerco.tipos && marcadoBerco.tipos.direita) || tipoDoLadoMontagem(state.tipo_montagem, state.bercos_personalizados, bercoNum, 'direita');
      const tipoEsq = (marcadoBerco.tipos && marcadoBerco.tipos.esquerda) || tipoDoLadoMontagem(state.tipo_montagem, state.bercos_personalizados, bercoNum, 'esquerda');

      return `
        <div class="ba-celula" data-berco="${berco}"
          style="background:${cor ? cor.bg : 'var(--bg-2)'};color:${cor ? cor.cor : 'var(--text-3)'};border:1px solid ${cor ? cor.borda : 'var(--border)'}">
          <span class="ba-dot ba-dot-topo${dirMarcado ? ' ba-dot-marcado' : ''}${dirNaoEnchido ? ' ba-dot-nao-enchido' : ''}" data-berco="${berco}" data-lado="direita"
            data-tooltip="${tituloDot(estadoDir, 'direita', tipoDir)}">${dirNaoEnchido ? '✕' : '•'}</span>
          <span class="ba-numero">B${numero}</span>
          <span class="ba-dot ba-dot-base${esqMarcado ? ' ba-dot-marcado' : ''}${esqNaoEnchido ? ' ba-dot-nao-enchido' : ''}" data-berco="${berco}" data-lado="esquerda"
            data-tooltip="${tituloDot(estadoEsq, 'esquerda', tipoEsq)}">${esqNaoEnchido ? '✕' : '•'}</span>
        </div>`;
    }).join('')}</div>`;

    el.innerHTML = resumo + `<div class="ba-botoes">${botaoModo}</div>` + dica + grid;

    const btnModo = $('off-ba-btn-nao-enchido');
    if (btnModo) {
      btnModo.addEventListener('click', () => {
        _offModoNaoEnchido = !_offModoNaoEnchido;
        renderBateriaAtual(); // redesenha na hora (botão, dica e cursor dos indicadores mudam com o modo)
      });
    }

    el.querySelectorAll('.ba-dot').forEach((dot) => {
      dot.addEventListener('click', () => {
        cliqueDotBateriaAtual(dot.getAttribute('data-berco'), dot.getAttribute('data-lado'), _offModoNaoEnchido ? 'nao_enchido' : 'baixou');
      });
    });
  }

  // Alterna (toggle) o estado de UM lado de UM berço — 100% local (sem
  // rede, sem otimismo/desfazer, diferente do online): grava direto em
  // state.bercos_marcados e persiste. Clique de novo no mesmo indicador
  // (já marcado, seja como 'baixou' ou 'nao_enchido') sempre desmarca —
  // nunca troca uma marcação por outra sem antes desmarcar, mesma regra
  // do online.
  function cliqueDotBateriaAtual(berco, lado, estadoDesejado) {
    if (!berco || !lado) return;
    const marcacoes = state.bercos_marcados || (state.bercos_marcados = {});
    const marcadoBerco = marcacoes[berco] || {};
    const estadoAtual = marcadoBerco[lado] || null;
    const estavaMarcado = estadoAtual === 'baixou' || estadoAtual === 'nao_enchido';
    const novoEstado = estavaMarcado ? null : estadoDesejado;

    const bercoNum = parseInt(String(berco).replace(/^B/i, ''), 10);
    const tipoFixado = (novoEstado === 'nao_enchido' && bercoNum)
      ? tipoDoLadoMontagem(state.tipo_montagem, state.bercos_personalizados, bercoNum, lado)
      : null;

    const novoBerco = { ...marcadoBerco };
    if (novoEstado) {
      novoBerco[lado] = novoEstado;
      if (tipoFixado) novoBerco.tipos = { ...(novoBerco.tipos || {}), [lado]: tipoFixado };
    } else {
      delete novoBerco[lado];
      if (novoBerco.tipos) {
        const { [lado]: _descartado, ...restoTipos } = novoBerco.tipos;
        if (Object.keys(restoTipos).length) novoBerco.tipos = restoTipos; else delete novoBerco.tipos;
      }
    }
    if (Object.keys(novoBerco).length) marcacoes[berco] = novoBerco;
    else delete marcacoes[berco];

    persist();
    renderBateriaAtual();
    renderCalculoPaineis(); // "🚫 Não Enchido" desconta painéis do preview na hora (ver aplicarNaoEnchidosNoCalc)
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

  // timeZone:'UTC' forçado — os ISO aqui usam a convenção "UTC falso =
  // hora de Brasília" (ver nowBrasilia(), acima), então os dígitos JÁ SÃO
  // a hora de Brasília; sem forçar UTC, toLocaleTimeString converteria de
  // novo pro fuso do navegador e desalinharia a exibição (mesmo raciocínio
  // de LW.formatTime em data.js).
  function formatTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' });
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  }

  function calcularDesemplaque(fimISO) {
    const fim = new Date(fimISO);
    if (isNaN(fim.getTime())) return null;
    return new Date(fim.getTime() + TEMPO_CURA_HORAS * 3600000).toISOString();
  }

  function iniciarInjecao() {
    if (state.status !== 'idle') return;
    state.inicio = nowBrasilia().toISOString();
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
      state.pausas.push({ pausado_em: nowBrasilia().toISOString(), retomado_em: null, motivo });
    } else {
      state.pausas[state.pausas.length - 1].retomado_em = nowBrasilia().toISOString();
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

    state.fim = nowBrasilia().toISOString();
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
      const agora = nowBrasilia().toISOString();
      const elapsed = diffMinutes(state.inicio, agora) - tempoPausadoMin(agora);
      const el = $('off-timer-display');
      el.textContent = formatDuration(elapsed);
      const m = Math.floor(elapsed);
      el.className = 'timer-display' + (m >= LIMITE_INJECAO_MIN ? ' danger' : m >= 50 ? ' warning' : '') + (estaPausada() ? ' timer-pausado' : '');
    }, 1000);
  }

  // ============================================================
  //  NÚMERO INICIAL DO CONTADOR DE TRAÇOS
  //
  //  Ao entrar num rascunho NOVO (nunca ao retomar um já em andamento —
  //  ver init()), pergunta quantos traços já foram feitos hoje (outras
  //  baterias, outros aparelhos) — os traços desta operação passam a ser
  //  numerados a partir daí, em vez de sempre começar do 1. Puramente
  //  cosmético/ajuda de memória pro operador: a numeração que de fato
  //  entra no sistema é decidida de novo pelo Administrador na validação
  //  ("renumeração manual do dia", ver lib/rotas/operacao-offline.js),
  //  que sempre prevalece sobre este número — inclusive quando o
  //  operador chuta errado ou simplesmente não sabe (ver naoSeiNumero
  //  Inicial, abaixo).
  // ============================================================

  function mostrarModalNumeroInicial() {
    const modal = $('off-modal-num-inicial');
    if (!modal) return;
    $('off-num-inicial-input').value = '';
    modal.style.display = 'flex';
    setTimeout(() => $('off-num-inicial-input').focus(), 50);
  }

  function confirmarNumeroInicial() {
    const bruto = $('off-num-inicial-input').value.trim();
    const n = parseInt(bruto, 10);
    state.numeroInicialTraco = (bruto !== '' && Number.isFinite(n) && n >= 0) ? n + 1 : 1;
    $('off-modal-num-inicial').style.display = 'none';
    persist();
    renderTracos(); // reflete o novo offset nos tabs, se já houver traço(s) de um rascunho recuperado por engano
  }

  function naoSeiNumeroInicial() {
    state.numeroInicialTraco = 1;
    $('off-modal-num-inicial').style.display = 'none';
    persist();
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
      // Marcador "Este traço é uma sobra" — a nota é só uma AJUDA DE
      // MEMÓRIA pro próprio operador (offline não tem como consultar o
      // sistema pra saber se existe sobra ativa de verdade, ver
      // comentário no topo do arquivo). `link_sobra_original` fica de
      // fora daqui de propósito: só é preenchido depois, pelo
      // Administrador, na revisão (ver README/lib/rotas/operacao-
      // offline.js, POST /operacao-offline/corrigir) — o operador nunca
      // escreve nesse campo.
      eh_sobra: false,
      nota_sobra: '',
    };
  }

  // Número de exibição do traço no índice `indice` (0-based) — soma o
  // offset escolhido pela pessoa no modal "Quantos traços já foram feitos
  // hoje?" (mostrarModalNumeroInicial, mais abaixo) ao índice dentro
  // desta operação. Puramente uma AJUDA VISUAL pro operador não se
  // perder no dia — o número que efetivamente entra no sistema é
  // decidido de novo pelo Administrador na validação ("renumeração
  // manual do dia", ver comentário grande no topo de lib/rotas/operacao-
  // offline.js), que não tem como saber, só olhando o aparelho, quantos
  // traços outras baterias já fizeram hoje.
  function numeroDoTraco(indice) {
    return (state.numeroInicialTraco || 1) + indice;
  }

  function addTraco() {
    const prev = state.tracos[state.tracos.length - 1];
    const sugeridoIni = prev?.berco_fim ? String(Number(prev.berco_fim) + 1) : '1';
    state.tracos.push(criarEstruturaTraco(numeroDoTraco(state.tracos.length), sugeridoIni));
    expandedTracoIndex = state.tracos.length - 1;
    renderTracos();
    persist();
    updatePendencias();
  }

  function removeTraco(i) {
    if (!confirm('Remover este traço?')) return;
    state.tracos.splice(i, 1);
    state.tracos.forEach((t, idx) => { t.num = numeroDoTraco(idx); });
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
        <span class="status-icon">${icon}</span> Traço ${t.num}${t.eh_sobra ? ' ♻️' : ''}
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

        <div class="traco-sobra-box${t.eh_sobra ? ' traco-sobra-box--ativo' : ''}">
          <label class="traco-sobra-toggle">
            <input type="checkbox" ${t.eh_sobra ? 'checked' : ''} onchange="LWOff.updateTraco(${i},'eh_sobra',this.checked)">
            ♻️ Este traço é uma sobra (reaproveitamento de um traço anterior)
          </label>
          ${t.eh_sobra ? `
            <div class="form-group" style="margin-top:8px;margin-bottom:0">
              <label class="form-label">Nota pra você mesmo(a) não se perder de qual sobra é essa</label>
              <textarea class="form-input" rows="2" oninput="LWOff.updateTraco(${i},'nota_sobra',this.value)"
                placeholder="Ex: sobra do traço 3 de ontem, bateria B-12...">${escaparHtml(t.nota_sobra || '')}</textarea>
              <div style="font-size:.72rem;color:var(--text-3);margin-top:4px">
                Essa nota é só pra te ajudar a lembrar — quem for validar este registro poderá
                vincular este traço ao original.
              </div>
            </div>` : ''}
        </div>

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
  //  REGISTRAR — SALVA localmente na hora (item 3) e tenta sincronizar
  //  em segundo plano (item 5). O usuário nunca precisa "reenviar" na
  //  mão: enquanto houver um registro aguardando_conexao no aparelho,
  //  checarReconexao() (evento 'online' + polling a cada 15s, mais
  //  abaixo) tenta de novo sozinho até dar certo.
  // ============================================================

  let _sincronizando = false;

  // Faz de fato a chamada de rede pra um pendente já salvo (objeto no
  // formato { idTemp, formRecord, tracos, pausas, ... }). Lança erro
  // se não conseguir — quem chama decide o que fazer com isso.
  async function enviarPendenteParaServidor(pendente) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch('/operacao-offline/enviar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idTemp: pendente.idTemp,
          formRecord: pendente.formRecord,
          tracos: pendente.tracos,
          pausas: pendente.pausas,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('Servidor recusou o envio (HTTP ' + res.status + ')');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Percorre a FILA (0, 1 ou várias operações já "Registradas" neste
  // aparelho) tentando enviar uma a uma, na ordem em que foram salvas.
  // Vai removendo da fila cada uma que o servidor confirmar. Para no
  // primeiro erro (sinal de que a rede ainda está fora) — o que já
  // sincronizou fica sincronizado, o resto tenta de novo no próximo
  // ciclo (evento 'online' ou polling de 15s). Devolve true só quando
  // pelo menos 1 item foi enviado com sucesso agora.
  async function tentarSincronizarAgora() {
    if (_sincronizando) return false;
    const fila = lerFila();
    if (!fila.length) return false;

    _sincronizando = true;
    let algumSincronizou = false;
    try {
      for (const pendente of fila) {
        try {
          await enviarPendenteParaServidor(pendente);
          removerDaFila(pendente.idTemp);
          algumSincronizou = true;
        } catch (e) {
          break; // sem servidor disponível — o restante da fila tenta depois
        }
      }
    } finally {
      _sincronizando = false;
    }

    if (algumSincronizou) {
      const restantes = lerFila().length;
      mostrarBanner(
        restantes > 0
          ? `🌐 Conexão restabelecida — registro(s) enviado(s) para validação! Ainda restam ` +
            `${restantes} salvo(s) neste aparelho, tentando enviar os demais...`
          : `🌐 Conexão restabelecida — todos os registros salvos neste aparelho foram enviados ` +
            `para validação!`,
        'sucesso'
      );
      renderFila();
    }
    return algumSincronizou;
  }

  async function registrar() {
    if ($('off-btn-registrar').disabled) return;
    state.motivo_atraso = $('off-motivo').value || state.motivo_atraso;

    const bateria = BATERIA_IDS.find((b) => b.id === state.id_bateria);
    const bercos = bateria?.bercos || 0;
    const calcBruto = state.tipo_montagem === TIPO_MONTAGEM_PERSONALIZADA
      ? calcPaineisPersonalizado(state.bercos_personalizados)
      : calcPaineis(state.tipo_montagem, bercos);
    // Desconta cada lado marcado "🚫 Não Enchido" em Bateria Atual (ver
    // seção BATERIA ATUAL, acima) — mesma regra do online: só entra na
    // conta final aqui, no Registrar, não durante o preenchimento.
    const calc = aplicarNaoEnchidosNoCalc(calcBruto, state.tipo_montagem, state.bercos_personalizados, state.bercos_marcados);

    // Salva JÁ, no aparelho — isso é o "Registrar": não depende de rede
    // nem de servidor responder. calc (painéis/m²) entra direto no
    // formRecord salvo, então uma sincronização automática horas depois
    // manda os dados completos, sem precisar do state em memória.
    const pendente = {
      idTemp,
      iniciadoEm,
      atualizadoEm: new Date().toISOString(),
      formRecord: { ...montarFormRecord(), ...calc },
      tracos: state.tracos,
      pausas: state.pausas,
      status: 'aguardando_conexao',
    };
    adicionarNaFila(pendente);
    try { localStorage.removeItem(DB_KEY); } catch (_) { /* ignore */ } // o rascunho virou item definitivo da fila

    const idRegistrado = idTemp;

    // Libera a tela NA HORA — não espera confirmação do servidor — pra
    // dar pra registrar outra operação em seguida, ainda offline.
    limparFormularioNovoRegistro();
    mostrarBanner(
      `💾 Registro salvo neste aparelho (código ${idRegistrado}). Você já pode preencher outra ` +
      `operação — assim que a conexão com o servidor voltar, tudo que estiver salvo é enviado sozinho.`,
      'aviso'
    );
    renderFila();

    // Tenta sincronizar JÁ, em segundo plano — se a conexão já estiver
    // de volta, o aviso acima é rapidamente substituído pelo de sucesso.
    await tentarSincronizarAgora();
  }

  // Reseta todo o estado/formulário depois de um registro enviado com
  // sucesso, pra abrir espaço pra registrar outra operação sem sair
  // desta tela (o slot local — DB_KEY — já foi liberado antes de
  // chamar esta função, ver registrar()).
  function limparFormularioNovoRegistro() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;

    $('off-fieldset-trava').disabled = false;
    idTemp = gerarIdTemp();
    iniciadoEm = new Date().toISOString();
    expandedTracoIndex = 0;
    state = criarStateVazio();

    // Identificação
    $('off-turno').value = state.turno;
    popularSelects(); // repopula ID da Bateria / Tipo de Montagem já sem seleção (state está vazio)

    // Controle de Injeção
    $('off-inicio').value = '';
    $('off-btn-iniciar').disabled = false;
    $('off-fim').value = '';
    $('off-btn-finalizar').disabled = true;
    $('off-atraso').innerHTML = '—';
    $('off-motivo-row').style.display = 'none';
    $('off-motivo').value = '';
    $('off-desemplaque-row').style.display = 'none';
    $('off-desemplaque').textContent = '—';
    const timerEl = $('off-timer-display');
    timerEl.textContent = '0:00:00';
    timerEl.className = 'timer-display';
    atualizarBtnPausar();

    // Traços e pendências
    renderTracos();
    updatePendencias();
    _offModoNaoEnchido = false; // volta pro modo padrão (vazamento) no próximo registro
    renderBateriaAtual();
    renderCalculoPaineis(); // volta pro placeholder '—' (state novo, sem bateria/tipo definidos)

    $('off-btn-registrar').textContent = '✅ Registrar';
  }

  function descartarPendente() {
    if (!confirm('Tem certeza? Isso apaga TODOS os dados preenchidos neste rascunho offline — não tem como desfazer.')) return;
    localStorage.removeItem(DB_KEY);
    location.reload();
  }

  // ============================================================
  //  FILA — lista visual das operações já Registradas neste aparelho,
  //  aguardando conexão pra sincronizar (permite mais de uma)
  // ============================================================

  function renderFila() {
    const el = $('off-fila-lista');
    if (!el) return;
    const fila = lerFila();
    if (!fila.length) { el.innerHTML = ''; return; }

    // Item mais antigo primeiro — se algo está preso há muito tempo, é o
    // primeiro que a pessoa vai ver, não escondido no fim da lista.
    const ordenada = [...fila].sort((a, b) => new Date(a.atualizadoEm) - new Date(b.atualizadoEm));

    el.innerHTML = `
      <div class="card" style="padding:14px 16px">
        <div style="font-size:.72rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">
          📥 Salvos neste aparelho, aguardando envio (${fila.length})
        </div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${ordenada.map((p) => {
            const fr = p.formRecord || {};
            const antigo = p.atualizadoEm && idadeEmHoras(p.atualizadoEm) >= LIMIAR_AVISO_HORAS;
            const idadeTexto = p.atualizadoEm ? formatarIdade(p.atualizadoEm) : '';
            return `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:.82rem;flex-wrap:wrap;${antigo ? 'padding:8px 10px;border-radius:6px;background:rgba(245,158,11,.1);border:1px solid #f59e0b40' : ''}">
              <span>
                🆔 ${escaparHtml(p.idTemp)} — Bateria ${escaparHtml(fr.id_bateria || '—')} ·
                ${escaparHtml(String(fr.qtd_tracos ?? 0))} traço(s)
                ${idadeTexto ? `<span style="color:${antigo ? '#fbbf24' : 'var(--text-3)'}"> · ${idadeTexto}</span>` : ''}
                ${antigo ? `<br><span style="color:#fbbf24;font-size:.76rem">⚠️ Aguardando envio há muito tempo — confira a conexão deste aparelho, ou avise um Administrador se ele já foi trocado/não vai mais sincronizar.</span>` : ''}
              </span>
              <button type="button" class="btn btn-ghost btn-sm" onclick="LWOff.descartarDaFila('${p.idTemp}')" title="Descartar este registro">✕ Descartar</button>
            </div>`;
          }).join('')}
        </div>
      </div>`;
  }

  function descartarDaFila(idTempAlvo) {
    if (!confirm('Tem certeza? Isso apaga esse registro salvo neste aparelho — não tem como desfazer.')) return;
    removerDaFila(idTempAlvo);
    renderFila();
  }

  // ---- Aviso de item "preso" há muito tempo (README, item 4b das
  // pendências — "Expiração"): decisão tomada — NUNCA apagar nada
  // sozinho (um pendente é um registro real de operação, apagar à toa
  // seria perder trabalho de verdade), só tornar visível quando algo
  // está esperando envio há tempo demais, pra quem usa o aparelho notar
  // e agir (checar a conexão, avisar o Administrador, ou descartar de
  // propósito se for mesmo lixo). Puramente informativo — a fila em si
  // (lerFila/tentarSincronizarAgora) não muda nada.

  const LIMIAR_AVISO_HORAS = 24; // acima disso, destaca como "há muito tempo"

  /** "há 5 minutos"/"há 3 horas"/"há 2 dias" a partir de um ISO — só as
   * unidades que interessam pra um pendente offline (nunca segundos). */
  function formatarIdade(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const minutos = Math.floor(ms / 60000);
    if (minutos < 60) return minutos <= 1 ? 'há 1 minuto' : `há ${minutos} minutos`;
    const horas = Math.floor(minutos / 60);
    if (horas < 24) return horas === 1 ? 'há 1 hora' : `há ${horas} horas`;
    const dias = Math.floor(horas / 24);
    return dias === 1 ? 'há 1 dia' : `há ${dias} dias`;
  }

  function idadeEmHoras(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    return Number.isFinite(ms) ? ms / 3600000 : 0;
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

  // item 4 do plano: conexão volta a qualquer momento (durante o
  // preenchimento OU depois de já ter clicado Registrar) — mesma
  // checagem ativa por fetch usada no item 1 (login.html) e no item 9
  // (operacao.js), já que o evento 'online' do navegador sozinho não é
  // confiável. Ao detectar conexão, tenta sincronizar sozinho qualquer
  // registro já salvo como "aguardando_conexao" (ver
  // tentarSincronizarAgora) — só cai no aviso genérico abaixo quando
  // NÃO havia nada pra sincronizar (ex: ainda em preenchimento).
  let _avisouReconexao = false;
  async function checarReconexao() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);
    try {
      await fetch('/minha-sessao', { method: 'GET', cache: 'no-store', signal: controller.signal });
      const primeiraVezOnline = !_avisouReconexao;
      _avisouReconexao = true;
      const sincronizou = await tentarSincronizarAgora();
      if (primeiraVezOnline && !sincronizou) {
        mostrarBanner(
          '🌐 Conexão restabelecida. Pode continuar preenchendo — quando clicar em "Registrar", o envio é automático.',
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
    migrarPendenteAntigoSeExistir();

    const retomando = carregarPendenteExistente();
    if (!retomando) {
      idTemp = gerarIdTemp();
      iniciadoEm = new Date().toISOString();
      mostrarModalNumeroInicial();
    }

    await loadConfig();
    popularSelects();

    $('off-turno').value = state.turno;
    $('off-turno').addEventListener('change', (e) => { state.turno = e.target.value; persist(); });
    $('off-bateria').addEventListener('change', (e) => {
      state.id_bateria = e.target.value;
      atualizarDimensaoAutoFill();
      atualizarGradePersonalizada();
      // Troca de bateria muda a quantidade/numeração dos berços — as
      // marcações antigas de vazamento/não enchido não fazem mais
      // sentido pro novo tamanho, então zera (mesmo espírito de
      // `bercos_personalizados` ser reconstruído em atualizarGradePersonalizada).
      state.bercos_marcados = {};
      persist();
      updatePendencias();
      renderBateriaAtual();
      renderCalculoPaineis();
    });
    $('off-tipo-montagem').addEventListener('change', (e) => {
      state.tipo_montagem = e.target.value;
      if (state.tipo_montagem !== TIPO_MONTAGEM_PERSONALIZADA) state.bercos_personalizados = null;
      // Mudar o tipo de montagem muda de qual TIPO cada lado desconta —
      // zera as marcações antigas pelo mesmo motivo da troca de bateria.
      state.bercos_marcados = {};
      atualizarGradePersonalizada();
      persist();
      updatePendencias();
      renderBateriaAtual();
      renderCalculoPaineis();
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
    renderFila();
    renderBateriaAtual(); // mostra a grade já com as marcações restauradas, se estava retomando um rascunho
    renderCalculoPaineis(); // idem — totais já batendo com o rascunho restaurado

    if (retomando) {
      mostrarBanner('↩️ Retomando um rascunho salvo neste aparelho, ainda não registrado.', 'aviso');
    }

    window.addEventListener('offline', () => { _avisouReconexao = false; });
    window.addEventListener('online', checarReconexao);
    setInterval(checarReconexao, 15000);
    checarReconexao(); // tenta sincronizar já de cara, sem esperar o primeiro polling de 15s
  }

  document.addEventListener('DOMContentLoaded', init);

  window.LWOff = {
    iniciarInjecao, togglePausa, finalizarInjecao,
    addTraco, removeTraco, updateTraco, updateInsumo, updateTempoBatida, expandirTraco,
    updateBercoPersonalizado, registrar, descartarPendente, descartarDaFila,
    confirmarNumeroInicial, naoSeiNumeroInicial,
  };
})();
