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
    modo_teste: false,
    bercos_personalizados: null, // [tipo|null, ...] — só usado quando tipo_montagem === 'PERSONALIZADA'
  };

  let timerInterval = null;
  let expandedTracoIndex = 0; // Índice do traço aberto (acordeão exclusivo)

  // ---- DOM refs ----
  const $ = id => document.getElementById(id);

  function init() {
    // Carrega config.json e só depois inicializa a tela
    LW.loadConfig().then(async () => {
      populateSelects();

      // Só existe UMA operação em andamento por vez, na fábrica inteira —
      // a fonte de verdade passa a ser o servidor, não mais só o
      // localStorage deste navegador. Sem conexão, cai pro rascunho local
      // salvo aqui (mesmo comportamento de antes desta sincronização
      // existir).
      let estadoInicial;
      try {
        estadoInicial = await LW.getOperacaoAndamento();
      } catch (_) {
        estadoInicial = LW.getOperacaoAtual();
      }
      _aplicarEstadoExterno(estadoInicial);

      wireEvents();
      setInterval(updateClock, 1000);
      updateClock();
      renderAll(); // já reaplica a trava de autorização/dono no final

      // A partir daqui, qualquer mudança feita em OUTRA aba/computador
      // nesta mesma operação chega aqui ao vivo (cronômetro incluso).
      LW.conectarOperacaoAndamento(_aplicarEstadoExterno, _notificarOperacaoFinalizadaPorOutro);

      // Fecha popovers ao clicar fora
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.ao-popover') && !e.target.closest('.btn-sm')) {
          document.querySelectorAll('.ao-popover').forEach(p => p.classList.remove('active'));
        }
      });
    });
  }

  /**
   * Aplica um estado vindo de FORA desta aba — snapshot inicial do servidor
   * ao carregar a tela, ou atualização ao vivo via WebSocket (mudança feita
   * por outra aba/computador). Nunca reenvia pro servidor (usa
   * LW.saveOperacaoAtual, não persist()), senão criaria um eco infinito
   * entre as abas.
   */
  function _aplicarEstadoExterno(dados) {
    // Não deixa uma atualização de operação REAL sobrescrever um teste
    // local em andamento — só se sai do modo de teste de propósito
    // (toggle OFF com a operação parada, ou "🗑️ Limpar Tudo"). Sem isso,
    // alguém começando uma operação real em outro computador apagaria
    // sem aviso o teste em andamento aqui.
    if (state.modo_teste) return;
    clearInterval(timerInterval);
    if (dados) {
      state = dados;
    } else {
      resetState();
    }
    LW.saveOperacaoAtual(state); // mantém o cache local desta aba em dia
    expandedTracoIndex = state.tracos.length - 1;
    renderAll();
    if (state.status === 'running') startTimerUI();
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
    // "Personalizado" não é um tipo cadastrado em Configurações — é uma
    // opção fixa, sempre disponível, que abre a grade de berço a berço
    // (ver abrirGradeMontagemPersonalizada()).
    const optPersonalizada = document.createElement('option');
    optPersonalizada.value = LW.TIPO_MONTAGEM_PERSONALIZADA;
    optPersonalizada.textContent = 'Personalizada';
    selMont.appendChild(optPersonalizada);

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
    $('op-toggle-teste').addEventListener('change', e => {
      // Só pode trocar de modo com a operação parada — evita misturar
      // dados reais e de teste numa mesma operação em andamento.
      if (state.status !== 'idle') {
        e.target.checked = state.modo_teste; // desfaz visualmente
        LW.mostrarAlerta('Encerre ou limpe a operação atual antes de trocar de modo.', { tipo: 'aviso' });
        return;
      }
      state.modo_teste = e.target.checked;
      persist();
      _aplicarTravaDeAutorizacao();
    });
    $('op-turno').addEventListener('change', e => {
      state.turno = e.target.value; persist();
    });
    $('op-montagem').addEventListener('change', e => {
      state.tipo_montagem = e.target.value;
      _atualizarBtnConfigurarBercos();
      if (state.tipo_montagem === LW.TIPO_MONTAGEM_PERSONALIZADA) {
        abrirGradeMontagemPersonalizada();
      }
      recalcPaineis();
      persist();
    });
    $('op-id-bateria').addEventListener('change', e => {
      state.id_bateria = e.target.value;
      // Mudou de bateria — a grade (se já tinha alguma) não vale mais
      // (capacidade pode ser diferente); melhor recomeçar do zero do que
      // arriscar um tamanho errado.
      if (state.bercos_personalizados) state.bercos_personalizados = null;
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
    const r = state.tipo_montagem === LW.TIPO_MONTAGEM_PERSONALIZADA
      ? LW.calcPaineisPersonalizado(state.bercos_personalizados)
      : LW.calcPaineis(state.tipo_montagem, bercos);
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

  /**
   * Usado no topo de ações que controlam a operação (iniciar, encerrar,
   * registrar, resetar) — mostra um aviso e retorna true se este
   * dispositivo NÃO está autorizado (Configurações → Autorizados). A
   * trava de verdade é sempre no servidor; isto aqui só dá feedback
   * imediato (sem esperar a rede) e cobre atalhos de teclado, que não
   * passam pelos campos/botões desabilitados na tela.
   */
  /**
   * Usado no topo de ações que controlam a operação (iniciar, encerrar,
   * registrar, resetar) — mostra um aviso e retorna true se esta tela NÃO
   * pode agir agora: dispositivo fora da lista de Autorizados, OU a
   * operação já tem outro dono (outro dispositivo autorizado que a
   * iniciou — ver "dono da operação" em server.js). A trava de verdade é
   * sempre no servidor; isto aqui só dá feedback imediato (sem esperar a
   * rede) e cobre atalhos de teclado, que não passam pelos campos/botões
   * desabilitados na tela.
   * @param {object} opts
   * @param {boolean} opts.ignorarDono - usado só pelo "🗑️ Limpar Tudo",
   *   que pode forçar a limpeza mesmo sem ser o dono atual.
   */
  function _bloqueadoPorAutorizacao({ ignorarDono = false } = {}) {
    // Modo de teste é um sandbox local — nunca toca o servidor (ver
    // persist()), então a trava de Autorizados/dono não faz sentido aqui:
    // qualquer computador pode testar, autorizado ou não pra operações reais.
    if (state.modo_teste) return false;
    if (!LW.dispositivoEstaAutorizado()) {
      LW.mostrarAlerta(
        'Este computador não está autorizado a controlar operações. Peça ao Administrador pra autorizá-lo em Configurações → Autorizados.',
        { tipo: 'erro' }
      );
      return true;
    }
    if (!ignorarDono && state.donoDeviceId && state.donoDeviceId !== LW.getDeviceId()) {
      LW.mostrarAlerta(
        'Esta operação já está sendo controlada por outro computador autorizado. Espere ela terminar, ou use "🗑️ Limpar Tudo" pra assumir o controle.',
        { tipo: 'erro' }
      );
      return true;
    }
    return false;
  }

  /**
   * Desabilita todos os campos/botões da tela (via <fieldset disabled> —
   * cobre até os elementos de traço, renderizados dinamicamente) e mostra
   * o banner correspondente quando este dispositivo não pode controlar a
   * operação agora — seja por não estar na lista de Autorizados, seja por
   * outro dispositivo autorizado já ser o dono da operação atual. Chamada
   * sempre que o estado é re-renderizado (renderAll()) — o "dono" muda
   * dinamicamente, diferente da lista de Autorizados.
   */
  function _aplicarTravaDeAutorizacao() {
    const fieldset = $('op-fieldset-trava');
    const aviso = $('op-aviso-nao-autorizado');
    const avisoTeste = $('op-aviso-modo-teste');

    // "Tema de teste" na página inteira (não só o banner do topo) — ver
    // CSS de #page-operacao.modo-teste-ativo (styles.css): retinta os
    // botões/bordas/badges (que já usam var(--accent)) pra violeta e
    // adiciona uma textura de fundo, pra ficar claro à distância que esta
    // sessão é um teste, mesmo rolando a página pra baixo.
    const pagina = $('page-operacao');
    if (pagina) pagina.classList.toggle('modo-teste-ativo', !!state.modo_teste);

    // Modo de teste é um sandbox local — nunca trava a tela (ver
    // _bloqueadoPorAutorizacao) — só troca o banner padrão pelo de teste.
    if (state.modo_teste) {
      if (fieldset) fieldset.disabled = false;
      if (aviso) aviso.style.display = 'none';
      if (avisoTeste) avisoTeste.style.display = 'flex';
      return;
    }
    if (avisoTeste) avisoTeste.style.display = 'none';

    const autorizado = LW.dispositivoEstaAutorizado();
    const dono = state?.donoDeviceId || null;
    const ehODono = !dono || dono === LW.getDeviceId();
    const podeControlar = autorizado && ehODono;

    if (fieldset) fieldset.disabled = !podeControlar;

    if (!aviso) return;
    if (podeControlar) {
      aviso.style.display = 'none';
    } else if (!autorizado) {
      aviso.innerHTML = '🔒 <span>Você está só <strong>acompanhando</strong> esta operação — este computador não está autorizado a iniciar, encerrar ou registrar. Peça ao Administrador pra autorizá-lo em <strong>Configurações → Autorizados</strong>.</span>';
      aviso.style.display = 'flex';
    } else {
      aviso.innerHTML = '👀 <span>Outro computador autorizado está controlando esta operação agora — você está só <strong>acompanhando</strong> até ela terminar (ou alguém usar "🗑️ Limpar Tudo").</span>';
      aviso.style.display = 'flex';
    }
  }

  function iniciarInjecao() {
    if (state.status !== 'idle') return;
    if (_bloqueadoPorAutorizacao()) return;
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

  async function finalizarInjecao() {
    if (state.status !== 'running') return false;
    if (_bloqueadoPorAutorizacao()) return false;

    const confirmou = await LW.mostrarConfirmacao(
      'Isso vai parar o cronômetro e travar os campos de tempo desta operação.',
      { titulo: 'Encerrar a injeção agora?', textoConfirmar: 'Encerrar Injeção', icon: '⏹' }
    );
    if (!confirmou) return false;

    state.fim = nowBrasilia().toISOString();
    state.status = 'finished';
    clearInterval(timerInterval);
    $('op-fim').value = LW.formatTime(state.fim);
    $('btn-finalizar').disabled = true;

    // Horário do desemplaque = fim da injeção + tempo de cura (8h, regra
    // operacional fixa) — calculado a partir do FIM, nunca do início.
    state.desemplaque = LW.calcularDesemplaque(state.fim);
    $('op-desemplaque').textContent = LW.formatDateTime(state.desemplaque);
    $('op-desemplaque-row').style.display = 'block';

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
    return true;
  }

  function startTimerUI() {
    // Sempre limpa um intervalo anterior antes de criar outro — sem isso,
    // toda vez que startTimerUI() roda de novo enquanto uma operação já
    // está em andamento (ex: Ctrl+Shift+R, ou voltar pra esta página),
    // ficava empilhando um setInterval novo por cima do(s) anterior(es),
    // todos atualizando o mesmo relógio — daí o cronômetro "pular de X em X
    // segundos" (cada intervalo extra empilhado soma mais uma atualização
    // por segundo, todas escrevendo o mesmo valor correto, só que repetido).
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (!state.inicio) return;
      const elapsed = LW.diffMinutes(state.inicio, nowBrasilia().toISOString());
      const el = $('timer-display');
      if (!el) return;
      el.textContent = LW.formatDuration(elapsed);
      const m = Math.floor(elapsed);
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
    // Reforça a visibilidade do modo de teste bem ao lado do status — o
    // banner grande no topo da página pode passar despercebido se a
    // pessoa já tiver rolado a tela.
    if (state.modo_teste) {
      banner.innerHTML += ' <span class="badge" style="background:rgba(167,139,250,.18);color:#c4b5fd;border:1px solid rgba(167,139,250,.5)">🧪 TESTE</span>';
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

  // Retorna o total/atual de um insumo (serializado, sem getter).
  // Insumos reais (cimento, água, EPS, superplast., incorporador) somam
  // original + todos os ajustes. Densidade e Flow são remedição: cada
  // ajuste SOBRESCREVE o valor anterior — vale o último valor registrado.
  function totalInsumo(insumo, fieldKey) {
    const temOriginal = insumo.original !== '' && insumo.original !== null;
    const temAjustes = insumo.ajustes && insumo.ajustes.length > 0;
    if (!temOriginal && !temAjustes) return '';

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
   * Verifica se um traço tem TODOS os campos obrigatórios preenchidos.
   * Único campo opcional é "Observações" (obs) — não entra nesta checagem.
   */
  function tracoCompleto(t) {
    const insumoPreenchido = (key) => {
      const insumo = t[key];
      return !!(insumo && insumo.original !== '' && insumo.original !== null && insumo.original !== undefined);
    };
    return !!t.berco_ini && !!t.berco_fim && !!t.silo && !!t.expansao && !!t.densidadeEPS
      && insumoPreenchido('cimento_real')
      && insumoPreenchido('agua_real')
      && insumoPreenchido('eps_real')
      && insumoPreenchido('superplast_real')
      && insumoPreenchido('incorporador_real')
      && insumoPreenchido('tempo_batida')
      && insumoPreenchido('densidade_insumo')
      && insumoPreenchido('flow_insumo');
  }

  /**
   * Verifica se algum ajuste de insumo do traço ficou sem o tempo de batida
   * correspondente. Rede de segurança — o fluxo normal (modal "Ajuste de
   * Receita") sempre grava os dois juntos, mas isso cobre traços antigos
   * (de antes dessa regra existir) ou reaproveitados de uma sobra que já
   * estava nesse estado.
   */
  function tracoTemAjusteSemTempoBatida(t) {
    const camposInsumo = ['cimento_real', 'agua_real', 'eps_real', 'superplast_real', 'incorporador_real'];
    const maxAjustesInsumo = Math.max(0, ...camposInsumo.map(c => (t[c]?.ajustes?.length) || 0));
    const ajustesTempo = t.tempo_batida?.ajustes?.length || 0;
    return maxAjustesInsumo > ajustesTempo;
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
      state.baseNumTraco = await LW.getTotalTracosHoje(state.modo_teste);
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
      // Observações são específicas de cada bateria/operação — não devem
      // ser herdadas da operação de origem da sobra; começa sempre vazia.
      obs: '',
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
    try { sobra = await LW.getSobra(state.modo_teste); } catch (_) { sobra = null; }

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
      try { await LW.desativarSobra('utilizada', state.modo_teste); } catch (_) { }
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
      try { await LW.desativarSobra('descartada', state.modo_teste); } catch (_) { }
      await callbackProsseguir();
    });

    document.getElementById('btn-cancelar-descarte').addEventListener('click', () => {
      modal.remove();
      // Não faz nada — usuário cancelou
    });
  }

  // ── Ajuste de Receita (insumo + tempo de batida, juntos) ──────────────────
  // Substitui os antigos botões/painéis separados de cada campo. Regra:
  // toda vez que um insumo é adicionado, o tempo de batida extra necessário
  // pra misturar esse adicional tem que ser informado junto — então tudo
  // entra pela mesma tela: insumos (somam ao total), tempo de batida
  // (sempre obrigatório) e, opcionalmente, a remedição de Densidade/Flow
  // (essas duas sobrescrevem o valor anterior, não somam).
  const CAMPOS_INSUMO_AJUSTE = [
    { campo: 'cimento_real', nome: 'cimento', label: 'Cimento (kg)', step: '0.01' },
    { campo: 'eps_real', nome: 'eps', label: 'EPS (kg)', step: '0.01' },
    { campo: 'agua_real', nome: 'agua', label: 'Água (kg)', step: '0.01' },
    { campo: 'superplast_real', nome: 'superplast', label: 'Superplast. (kg)', step: '0.001' },
    { campo: 'incorporador_real', nome: 'incorporador', label: 'Incorp. de Ar (kg)', step: '0.001' },
  ];

  const CAMPOS_RESULTADO_AJUSTE = [
    { campo: 'densidade_insumo', nome: 'densidade', label: 'Densidade do traço (kg/m³)', step: '0.01' },
    { campo: 'flow_insumo', nome: 'flow', label: 'Flow (mm)', step: '1' },
  ];

  function _mostrarModalAjusteReceita(i) {
    const t = state.tracos[i];
    if (!t || t._reaproveitado) return;

    const existente = document.getElementById('modal-ajuste-receita');
    if (existente) existente.remove();

    const modal = document.createElement('div');
    modal.id = 'modal-ajuste-receita';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px';

    modal.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);
                  padding:32px;width:480px;max-width:92vw;max-height:90vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,.6)">
        <div style="text-align:center;margin-bottom:20px">
          <div style="font-size:2.2rem;margin-bottom:8px">⚖️</div>
          <h2 style="font-family:var(--font-display);font-size:1.3rem;color:var(--accent);margin:0">
            Ajuste de Receita — Traço Nº ${t.num}
          </h2>
          <p style="color:var(--text-2);font-size:.8rem;margin-top:8px;line-height:1.4">
            Toda vez que um insumo é adicionado, é preciso informar quanto tempo extra de batida foi necessário.
          </p>
        </div>

        <div class="form-group" style="margin-bottom:18px">
          <label class="form-label">⏱ Tempo de Batida Adicionado <span class="required">*</span></label>
          <div class="duration-picker">
            <div class="duration-col">
              <button type="button" class="dur-btn dur-up" id="ar-h-up">▲</button>
              <input class="dur-input" type="number" min="0" max="23" id="ar-dur-h" value="0" readonly>
              <button type="button" class="dur-btn dur-dn" id="ar-h-dn">▼</button>
              <span class="dur-label">h</span>
            </div>
            <span class="dur-sep">:</span>
            <div class="duration-col">
              <button type="button" class="dur-btn dur-up" id="ar-m-up">▲</button>
              <input class="dur-input" type="number" min="0" max="59" id="ar-dur-m" value="0" readonly>
              <button type="button" class="dur-btn dur-dn" id="ar-m-dn">▼</button>
              <span class="dur-label">min</span>
            </div>
            <span class="dur-sep">:</span>
            <div class="duration-col">
              <button type="button" class="dur-btn dur-up" id="ar-s-up">▲</button>
              <input class="dur-input" type="number" min="0" max="59" id="ar-dur-s" value="0" readonly>
              <button type="button" class="dur-btn dur-dn" id="ar-s-dn">▼</button>
              <span class="dur-label">seg</span>
            </div>
          </div>
        </div>

        <div class="form-group" style="margin-bottom:6px">
          <label class="form-label" style="margin-bottom:10px">Insumo Adicionado <span style="color:var(--text-3);font-weight:400;text-transform:none">(opcional — preencha só o que foi adicionado)</span></label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            ${CAMPOS_INSUMO_AJUSTE.map(c => `
              <div class="form-group">
                <label class="form-label">${c.label}</label>
                <input class="form-input" type="number" step="${c.step}" id="ar-insumo-${c.campo}" placeholder="0">
              </div>
            `).join('')}
          </div>
        </div>

        <div class="form-group" style="margin-bottom:6px;margin-top:14px">
          <label class="form-label" style="margin-bottom:10px">Remedição <span style="color:var(--text-3);font-weight:400;text-transform:none">(opcional — sobrescreve o valor anterior)</span></label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            ${CAMPOS_RESULTADO_AJUSTE.map(c => `
              <div class="form-group">
                <label class="form-label">${c.label}</label>
                <input class="form-input" type="number" step="${c.step}" id="ar-insumo-${c.campo}" placeholder="novo valor">
              </div>
            `).join('')}
          </div>
        </div>

        <div id="ar-erro" style="display:none;color:var(--red);font-size:.82rem;margin-bottom:8px;margin-top:8px"></div>

        <div style="display:flex;gap:12px;margin-top:8px">
          <button id="ar-btn-salvar" class="btn btn-primary" style="flex:1">Salvar Ajuste</button>
          <button id="ar-btn-cancelar" class="btn btn-ghost" style="flex:1">Cancelar</button>
        </div>
      </div>`;

    document.body.appendChild(modal);

    // Relógio h:m:s só muda pelas setas — sem digitação livre (readonly nos
    // inputs), pra manter o valor sempre dentro do range válido.
    const incDecAr = (id, max, delta) => {
      const el = document.getElementById(id);
      let val = (parseInt(el.value) || 0) + delta;
      if (val < 0) val = max;
      if (val > max) val = 0;
      el.value = val;
    };
    document.getElementById('ar-h-up').addEventListener('click', () => incDecAr('ar-dur-h', 23, 1));
    document.getElementById('ar-h-dn').addEventListener('click', () => incDecAr('ar-dur-h', 23, -1));
    document.getElementById('ar-m-up').addEventListener('click', () => incDecAr('ar-dur-m', 59, 1));
    document.getElementById('ar-m-dn').addEventListener('click', () => incDecAr('ar-dur-m', 59, -1));
    document.getElementById('ar-s-up').addEventListener('click', () => incDecAr('ar-dur-s', 59, 1));
    document.getElementById('ar-s-dn').addEventListener('click', () => incDecAr('ar-dur-s', 59, -1));

    document.getElementById('ar-btn-cancelar').addEventListener('click', () => modal.remove());
    document.getElementById('ar-btn-salvar').addEventListener('click', () => _salvarAjusteReceita(i, modal));
  }

  async function _salvarAjusteReceita(i, modal) {
    const t = state.tracos[i];
    if (!t) { modal.remove(); return; }

    const erroEl = document.getElementById('ar-erro');
    const mostrarErroModal = msg => { erroEl.textContent = msg; erroEl.style.display = 'block'; };
    erroEl.style.display = 'none';

    const h = parseInt(document.getElementById('ar-dur-h').value) || 0;
    const m = parseInt(document.getElementById('ar-dur-m').value) || 0;
    const s = parseInt(document.getElementById('ar-dur-s').value) || 0;
    const segundos = h * 3600 + m * 60 + s;
    if (segundos <= 0) {
      mostrarErroModal('Informe o tempo de batida adicionado, usando as setas do relógio.');
      return;
    }
    const minutos = Math.round((segundos / 60) * 100) / 100; // pro arquivo de auditoria (em minutos)

    const camposPreenchidos = {}; // { cimento_real: valor, ... } — pro state do traço
    const ajusteAudit = { tempo_batida: minutos }; // { tempo_batida, cimento, agua, densidade, flow, ... } — pro arquivo de auditoria

    // Insumos (somam ao total) — todos opcionais, preenche só o que entrou.
    CAMPOS_INSUMO_AJUSTE.forEach(c => {
      const input = document.getElementById(`ar-insumo-${c.campo}`);
      const val = parseFloat(input?.value);
      if (!isNaN(val) && val > 0) {
        camposPreenchidos[c.campo] = val;
        ajusteAudit[c.nome] = val;
      }
    });

    // Remedição (Densidade/Flow) — também opcional, mas sobrescreve em vez
    // de somar (ver totalInsumo: para esses dois campos vale só o último
    // valor da lista de ajustes, não a soma).
    CAMPOS_RESULTADO_AJUSTE.forEach(c => {
      const input = document.getElementById(`ar-insumo-${c.campo}`);
      const val = parseFloat(input?.value);
      if (!isNaN(val) && val > 0) {
        camposPreenchidos[c.campo] = val;
        ajusteAudit[c.nome] = val;
      }
    });

    // Aplica no state: tempo de batida (já em segundos, mesma unidade usada
    // internamente) + cada campo preenchido (insumo ou remedição).
    if (!t.tempo_batida || typeof t.tempo_batida !== 'object') t.tempo_batida = { original: '', ajustes: [] };
    t.tempo_batida.ajustes.push(segundos);

    Object.entries(camposPreenchidos).forEach(([campo, valor]) => {
      if (!t[campo] || typeof t[campo] !== 'object') t[campo] = { original: '', ajustes: [] };
      t[campo].ajustes.push(valor);
    });

    persist();
    renderTracos();
    modal.remove();

    // Registra no arquivo de auditoria de ajustes — não bloqueia o fluxo se
    // falhar (o dado principal já está salvo no traço; isso é só o
    // histórico de qual ajuste veio com qual tempo de batida).
    try {
      await LW.registrarAjusteTraco(t.id, ajusteAudit, state.modo_teste);
    } catch (err) {
      console.warn('[LW] Falha ao registrar auditoria do ajuste de receita:', err.message);
    }
  }

  // ── Montagem Personalizada (berço a berço) ─────────────────────────────
  // Diferente de Simples/Híbrida (uma proporção fixa aplicada igualmente em
  // todos os berços), aqui cada berço tem seu próprio tipo — pra baterias
  // que misturam tipos diferentes em quantidades quaisquer (ex: 3 berços de
  // 3T, o resto de S/P). Ver calcPaineisPersonalizado() em data.js.

  let _gradeTipoAtivo = null;  // tipo selecionado nas abas (string) — null = nenhum selecionado ainda
  let _gradeTrabalho = [];     // cópia de trabalho de state.bercos_personalizados — só vai pro state em "Confirmar"
  let _gradeSomenteRevisao = false;
  // Snapshot de _gradeTrabalho no instante em que a revisão foi aberta — só
  // usado em modo de revisão, pra "desfazer": um 2º clique no mesmo berço
  // volta ele pro tipo que tinha antes, em vez de ficar apagado pra sempre
  // por um clique sem querer. Ver _gradeClicarBerco().
  let _gradeOriginalRevisao = null;

  /**
   * Abre a grade de berços. Em modo normal (somenteRevisao: false), mostra
   * as abas de tipo + "De/Até — Aplicar" + a grade clicável. Em modo de
   * revisão (usado pela reconciliação ao registrar — ver
   * _reconciliarMontagemPersonalizada()), esconde as abas: todo clique ou
   * "Aplicar" só LIMPA o berço (pra marcar quais não foram usados).
   * @returns {Promise<boolean>} true se confirmado, false se cancelado
   */
  function abrirGradeMontagemPersonalizada({ somenteRevisao = false } = {}) {
    return new Promise((resolve) => {
      const bateria = LW.BATERIA_IDS.find(b => b.id === state.id_bateria);
      if (!bateria) {
        LW.mostrarAlerta('Selecione a bateria antes de configurar os berços.', { tipo: 'aviso' });
        resolve(false);
        return;
      }
      const capacidade = bateria.bercos || 0;

      const atual = Array.isArray(state.bercos_personalizados) ? state.bercos_personalizados : [];
      _gradeTrabalho = Array.from({ length: capacidade }, (_, i) => atual[i] || null);
      _gradeSomenteRevisao = somenteRevisao;
      _gradeTipoAtivo = somenteRevisao ? '' : null; // '' = ferramenta de limpar, em modo de revisão
      // Guarda o estado de entrada só em modo de revisão — é pra ele que um
      // berço volta se for clicado de novo (desfazer um clique sem querer).
      _gradeOriginalRevisao = somenteRevisao ? [..._gradeTrabalho] : null;

      const existente = document.getElementById('modal-grade-montagem');
      if (existente) existente.remove();

      const modal = document.createElement('div');
      modal.id = 'modal-grade-montagem';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px';

      modal.innerHTML = `
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);
                    padding:32px;width:560px;max-width:94vw;max-height:90vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,.6)">
          <div style="text-align:center;margin-bottom:18px">
            <div style="font-size:2.2rem;margin-bottom:8px">🔧</div>
            <h2 style="font-family:var(--font-display);font-size:1.25rem;color:var(--accent);margin:0">
              ${somenteRevisao ? 'Quais berços não foram preenchidos?' : 'Montagem Personalizada — Bateria ' + bateria.id}
            </h2>
            <p style="color:var(--text-2);font-size:.8rem;margin-top:8px;line-height:1.4">
              ${somenteRevisao
          ? 'Clique nos berços que ficaram vazios (não foram usados nesta operação).'
          : 'Selecione um tipo abaixo e clique nos berços (ou use "De/Até") pra aplicar.'}
            </p>
          </div>

          <div id="grade-erro" style="display:none;color:var(--red);font-size:.82rem;margin-bottom:10px"></div>

          <div id="grade-tabs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px"></div>

          <div style="display:flex;gap:10px;align-items:flex-end;margin-bottom:18px;flex-wrap:wrap">
            <div class="form-group" style="margin:0">
              <label class="form-label">De</label>
              <input type="number" id="grade-de" class="form-input" style="width:80px" min="1" max="${capacidade}">
            </div>
            <div class="form-group" style="margin:0">
              <label class="form-label">Até</label>
              <input type="number" id="grade-ate" class="form-input" style="width:80px" min="1" max="${capacidade}">
            </div>
            <button id="grade-btn-aplicar" class="btn btn-outline-accent btn-sm">Aplicar</button>
          </div>

          <div id="grade-bercos" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:20px"></div>

          <div style="display:flex;justify-content:flex-end;gap:12px">
            <button id="grade-btn-cancelar" class="btn btn-ghost">Cancelar</button>
            <button id="grade-btn-confirmar" class="btn btn-primary">Confirmar</button>
          </div>
        </div>`;

      document.body.appendChild(modal);

      _renderGradeMontagem();

      document.getElementById('grade-btn-aplicar').addEventListener('click', _gradeAplicarRange);
      document.getElementById('grade-btn-cancelar').addEventListener('click', () => {
        modal.remove();
        resolve(false);
      });
      document.getElementById('grade-btn-confirmar').addEventListener('click', () => {
        // Em modo normal, exige ao menos 1 berço preenchido — senão não tem
        // sentido nenhum ter escolhido "Personalizado".
        if (!somenteRevisao && _gradeTrabalho.every(t => !t)) {
          const erroEl = document.getElementById('grade-erro');
          erroEl.textContent = 'Defina o tipo de pelo menos um berço antes de confirmar.';
          erroEl.style.display = 'block';
          return;
        }
        state.bercos_personalizados = [..._gradeTrabalho];
        recalcPaineis();
        persist();
        modal.remove();
        resolve(true);
      });

      // Resolve modal._resolve pra fechamentos externos (ex: reconciliação
      // decide fechar sozinha depois de recalcular) — não usado por padrão.
      modal._resolve = resolve;
    });
  }

  function _renderGradeMontagem() {
    const tabsEl = document.getElementById('grade-tabs');
    if (tabsEl) {
      if (_gradeSomenteRevisao) {
        tabsEl.innerHTML = ''; // sem abas em modo de revisão — todo clique limpa
      } else {
        const tiposSimples = (LW.MONTAGEM_OPCOES || []).filter(o => o.modo === 'simples');
        tabsEl.innerHTML = tiposSimples.map(o => {
          const cor = LW.corPorTipoSimples(o.tipo);
          const ativo = _gradeTipoAtivo === o.tipo;
          return `<button type="button" class="btn btn-sm" data-tipo-tab="${o.tipo}"
            style="background:${ativo ? cor.cor : cor.bg};color:${ativo ? '#fff' : cor.cor};border:1px solid ${cor.borda}">${o.label}</button>`;
        }).join('') + `<button type="button" class="btn btn-sm" data-tipo-tab=""
            style="background:${_gradeTipoAtivo === '' ? 'var(--red)' : 'rgba(239,68,68,.08)'};color:${_gradeTipoAtivo === '' ? '#fff' : 'var(--red)'};border:1px solid var(--red-dim)">🗑️ Limpar</button>`;

        tabsEl.querySelectorAll('[data-tipo-tab]').forEach(btn => {
          btn.addEventListener('click', () => {
            _gradeTipoAtivo = btn.getAttribute('data-tipo-tab');
            _renderGradeMontagem();
          });
        });
      }
    }

    const gridEl = document.getElementById('grade-bercos');
    if (gridEl) {
      gridEl.innerHTML = _gradeTrabalho.map((tipo, i) => {
        const cor = tipo ? LW.corPorTipoSimples(tipo) : null;
        const numero = String(i + 1).padStart(2, '0');
        // Em modo de revisão, um berço que tinha tipo e foi apagado AGORA
        // (nesta sessão de revisão) ganha uma borda tracejada + "↺" — sinal
        // de que ainda dá pra clicar de novo e voltar a ser preenchido.
        // Berço que já estava vazio antes (nunca preenchido) fica neutro,
        // sem essa dica, porque não há nada pra desfazer ali.
        const apagadoNestaRevisao = _gradeSomenteRevisao && !tipo && !!_gradeOriginalRevisao?.[i];
        const titulo = apagadoNestaRevisao
          ? `title="Marcado como não usado — clique de novo para restaurar (${_gradeOriginalRevisao[i].toUpperCase()})"`
          : '';
        return `<button type="button" data-berco-idx="${i}" ${titulo}
          style="padding:8px 4px;border-radius:var(--radius);font-size:.74rem;text-align:center;cursor:pointer;
                 background:${cor ? cor.bg : 'var(--bg-2)'};color:${cor ? cor.cor : 'var(--text-3)'};
                 border:1px ${apagadoNestaRevisao ? 'dashed var(--red-dim)' : 'solid ' + (cor ? cor.borda : 'var(--border)')}">
          B${numero}${tipo ? '<br><strong>' + tipo.toUpperCase() + '</strong>' : (apagadoNestaRevisao ? '<br>↺' : '')}
        </button>`;
      }).join('');

      gridEl.querySelectorAll('[data-berco-idx]').forEach(btn => {
        btn.addEventListener('click', () => {
          const i = parseInt(btn.getAttribute('data-berco-idx'), 10);
          _gradeClicarBerco(i);
        });
      });
    }
  }

  function _gradeClicarBerco(i) {
    if (_gradeSomenteRevisao) {
      // Alterna: 1º clique apaga (marca como não usado); um 2º clique no
      // MESMO berço desfaz, voltando pro tipo que ele tinha quando a
      // revisão foi aberta — evita perder o preenchimento por um clique
      // sem querer (antes só dava pra apagar, sem volta).
      _gradeTrabalho[i] = _gradeTrabalho[i] === null
        ? (_gradeOriginalRevisao?.[i] || null)
        : null;
    } else {
      if (_gradeTipoAtivo === null) {
        LW.mostrarAlerta('Selecione um tipo de montagem nas abas acima primeiro.', { tipo: 'aviso' });
        return;
      }
      _gradeTrabalho[i] = _gradeTipoAtivo || null; // '' (Limpar) -> null
    }
    _renderGradeMontagem();
  }

  function _gradeAplicarRange() {
    const erroEl = document.getElementById('grade-erro');
    erroEl.style.display = 'none';

    const de = parseInt(document.getElementById('grade-de').value, 10);
    const ate = parseInt(document.getElementById('grade-ate').value, 10);
    if (!de || !ate || de < 1 || ate < de || ate > _gradeTrabalho.length) {
      erroEl.textContent = `Informe um intervalo válido (de 1 até ${_gradeTrabalho.length}).`;
      erroEl.style.display = 'block';
      return;
    }
    if (!_gradeSomenteRevisao && _gradeTipoAtivo === null) {
      erroEl.textContent = 'Selecione um tipo de montagem nas abas acima primeiro.';
      erroEl.style.display = 'block';
      return;
    }

    const valor = _gradeSomenteRevisao ? null : (_gradeTipoAtivo || null);
    for (let i = de - 1; i <= ate - 1; i++) _gradeTrabalho[i] = valor;
    _renderGradeMontagem();
  }

  /**
   * Confere se a quantidade de berços com tipo definido na grade bate com
   * "berços reais". Se bater, segue o registro normalmente. Se não:
   * - Preenchidos > berços reais: pergunta se houve berço não usado — se
   *   sim, reabre a grade só pra marcar quais (modo de revisão); se não,
   *   berços reais SOBE pra bater com o que está preenchido.
   * - Preenchidos < berços reais: faltam berços sem tipo — reabre a grade
   *   completa (com abas) pra terminar de preencher.
   * @returns {Promise<boolean>} true = pode prosseguir com o registro agora
   */
  async function _reconciliarMontagemPersonalizada() {
    const bateria = LW.BATERIA_IDS.find(b => b.id === state.id_bateria);
    const capacidade = bateria?.bercos || 0;
    const grade = Array.isArray(state.bercos_personalizados) ? state.bercos_personalizados : [];
    const preenchidos = grade.filter(t => !!t).length;
    const bercosDeclarados = parseInt(state.bercos_reais) || capacidade;

    if (preenchidos === bercosDeclarados) return true;

    if (preenchidos < bercosDeclarados) {
      LW.mostrarAlerta(
        `Faltam ${bercosDeclarados - preenchidos} berço(s) sem tipo de montagem definido na grade. Complete antes de registrar.`,
        { tipo: 'aviso' }
      );
      await abrirGradeMontagemPersonalizada();
      return false; // sempre pede pra clicar Registrar de novo, depois de completar
    }

    // preenchidos > bercosDeclarados
    const houveVazios = await LW.mostrarConfirmacao(
      `Você definiu o tipo de ${preenchidos} berços, mas "Berços Reais" está em ${bercosDeclarados}. Houve berço que não foi usado nesta operação?`,
      {
        titulo: 'Berços reais não coincidem com a grade', icon: '🔢',
        textoConfirmar: 'Sim, houve berços não usados', textoCancelar: 'Não, todos foram usados',
      }
    );

    if (houveVazios) {
      await abrirGradeMontagemPersonalizada({ somenteRevisao: true });
      return false; // pede pra clicar Registrar de novo, depois de revisar
    }

    // "Não" -> berços reais sobe pra bater com o que está preenchido na grade
    state.bercos_reais = String(preenchidos);
    if ($('op-bercos-reais')) $('op-bercos-reais').value = state.bercos_reais;
    recalcPaineis();
    persist();
    return true;
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
        await LW.salvarSobra(sobra, state.modo_teste);
      } catch (err) {
        console.warn('[LW] Falha ao salvar sobra:', err.message);
      }
      showSuccessModal(record);
    });

    document.getElementById('btn-sobra-nao').addEventListener('click', async () => {
      modal.remove();
      // Garante que não há sobra ativa residual para o traço encerrado
      try { await LW.desativarSobra('descartada', state.modo_teste); } catch (_) { }
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

  // Mesma regra de trava dos outros insumos (ver renderCampoInsumo): traço
  // reaproveitado, OU o campo já tem pelo menos 1 ajuste aplicado — daí só
  // editável de novo via "Ajuste de Receita". Usado tanto na renderização
  // do relógio quanto como defesa extra em ajustarDuracao/onDuracaoInput.
  function _tempoBatidaTravado(t) {
    const insumo = t?.tempo_batida;
    const temAjustes = !!(insumo && typeof insumo === 'object' && insumo.ajustes && insumo.ajustes.length > 0);
    return !!(t?._reaproveitado || temAjustes);
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

    // Trava igual aos outros insumos: traço reaproveitado OU este campo já
    // teve algum ajuste aplicado — só editável de novo via "Ajuste de
    // Receita". Antes só checava t._reaproveitado (faltava temAjustes), e
    // o "disabled" dos botões ▲▼ estava escrito DENTRO da string do
    // onclick (nunca virava atributo de verdade — por isso os botões
    // nunca ficavam de fato travados, mesmo quando deveriam).
    const travado = t._reaproveitado || temAjustes;

    return `
      <div class="form-group insumo-group tempo-batida-group" id="tempo-batida-group-${i}">
        <label class="form-label">⏱ Tempo de Batida <span class="required">*</span></label>
        <div class="duration-picker ${travado ? 'readonly-reaproveitado' : ''}">
          <div class="duration-col">
            <button class="dur-btn dur-up" onclick="LWOp.ajustarDuracao(${i},'h',1)" ${travado ? 'disabled' : ''}>▲</button>
            <input class="dur-input" type="number" min="0" max="23"
              id="dur-h-${i}" value="${temValor ? h : ''}" placeholder="0"
              ${travado ? 'readonly' : ''} oninput="LWOp.onDuracaoInput(${i})">
            <button class="dur-btn dur-dn" onclick="LWOp.ajustarDuracao(${i},'h',-1)" ${travado ? 'disabled' : ''}>▼</button>
            <span class="dur-label">h</span>
          </div>
          <span class="dur-sep">:</span>
          <div class="duration-col">
            <button class="dur-btn dur-up" onclick="LWOp.ajustarDuracao(${i},'m',1)" ${travado ? 'disabled' : ''}>▲</button>
            <input class="dur-input" type="number" min="0" max="59"
              id="dur-m-${i}" value="${temValor ? m : ''}" placeholder="0"
              ${travado ? 'readonly' : ''} oninput="LWOp.onDuracaoInput(${i})">
            <button class="dur-btn dur-dn" onclick="LWOp.ajustarDuracao(${i},'m',-1)" ${travado ? 'disabled' : ''}>▼</button>
            <span class="dur-label">min</span>
          </div>
          <span class="dur-sep">:</span>
          <div class="duration-col">
            <button class="dur-btn dur-up" onclick="LWOp.ajustarDuracao(${i},'s',1)" ${travado ? 'disabled' : ''}>▲</button>
            <input class="dur-input" type="number" min="0" max="59"
              id="dur-s-${i}" value="${temValor ? s : ''}" placeholder="0"
              ${travado ? 'readonly' : ''} oninput="LWOp.onDuracaoInput(${i})">
            <button class="dur-btn dur-dn" onclick="LWOp.ajustarDuracao(${i},'s',-1)" ${travado ? 'disabled' : ''}>▼</button>
            <span class="dur-label">seg</span>
          </div>
        </div>
        ${temValor ? `<div class="dur-total-display">${formatDuracao(segAtual)} <span class="dur-seg-raw">(${segAtual}s)</span></div>` : ''}
        ${temAjustes ? `
          <div class="insumo-ajustes-display">
            <span class="ajustes-formula">${formula}</span>
            <span class="ajustes-total-badge">Total: ${formatDuracao(parseInt(total))}</span>
          </div>` : ''}
      </div>`;
  }

  // Renderiza campo de insumo (entrada do valor original + badge de ajustes)
  function renderCampoInsumo(t, i, fieldKey, label, step, decimais, placeholder) {
    const insumo = t[fieldKey] || { original: '', ajustes: [] };
    const isResultado = fieldKey && (fieldKey.includes('densidade') || fieldKey.includes('flow'));
    const temAjustes = insumo.ajustes && insumo.ajustes.length > 0;
    const displayAjustes = temAjustes ? formatAjustesDisplay(insumo, decimais, fieldKey) : '';
    const total = totalInsumo(insumo, fieldKey);

    // Todo campo mostra o valor ATUAL no próprio campo, já considerando os
    // ajustes — soma pros insumos reais (cimento, água, EPS, superplast.,
    // incorporador), último valor registrado pra Densidade/Flow (que
    // sobrescrevem em vez de somar). Antes do primeiro ajuste, total ===
    // original, então o campo continua editável normalmente; depois do
    // primeiro ajuste, trava (readonly) — daí em diante, qualquer mudança
    // passa pelo botão único "⚖️ Ajustar Receita" do card do traço.
    const valorExibido = total !== '' ? parseFloat(total).toFixed(decimais) : '';

    return `
      <div class="form-group insumo-group">
        <label class="form-label">${label} <span class="required">*</span></label>
        <div class="insumo-input-row">
          <input class="form-input ${(t._reaproveitado || temAjustes) ? 'readonly-reaproveitado' : ''}" type="number" step="${step}"
            value="${valorExibido}"
            oninput="LWOp.updateInsumoOriginal(${i},'${fieldKey}',this.value)"
            ${t._reaproveitado || temAjustes ? 'readonly' : ''}
            placeholder="${placeholder}">
        </div>
        ${temAjustes ? `
          <div class="insumo-ajustes-display">
            <span class="ajustes-formula">${displayAjustes}</span>
            <span class="ajustes-total-badge">${isResultado ? 'Atual' : 'Total'}: ${total !== '' ? parseFloat(total).toFixed(decimais) : '—'}</span>
          </div>` : ''}
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
        const isComplete = tracoCompleto(t);
        const hasData = t.berco_ini || t.berco_fim || t.silo || t.expansao || t.densidadeEPS || t.obs
          || !!t.cimento_real?.original || !!t.agua_real?.original || !!t.eps_real?.original
          || !!t.superplast_real?.original || !!t.incorporador_real?.original
          || !!t.tempo_batida?.original || !!t.densidade_insumo?.original || !!t.flow_insumo?.original;

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
          <div class="traco-section-label-row">
            <div class="traco-section-label" style="padding:0">⚖ Receita Real Pesada</div>
            <button type="button" class="btn-ajustar-receita ${t._reaproveitado ? 'readonly-reaproveitado' : ''}"
              onclick="LWOp.abrirAjusteReceita(${i}) ${t._reaproveitado ? 'disabled' : ''}"
              title="Adicionar insumo e/ou tempo de batida">⚖️ Ajustar Receita</button>
          </div>
          <div class="traco-fields-grid traco-fields-grid--6">
            ${renderCampoInsumo(t, i, 'cimento_real', 'Cimento (kg)', '0.01', 2, 'kg', t._reaproveitado)}
            ${renderCampoInsumo(t, i, 'eps_real', 'EPS (kg)', '0.01', 2, 'kg', t._reaproveitado)}
            ${renderCampoInsumo(t, i, 'agua_real', 'Água (kg)', '0.01', 2, 'kg', t._reaproveitado)}
            ${renderCampoInsumo(t, i, 'superplast_real', 'Superplast. (kg)', '0.001', 3, 'kg', t._reaproveitado)}
            ${renderCampoInsumo(t, i, 'incorporador_real', 'Incorp. de Ar (kg)', '0.001', 3, 'kg', t._reaproveitado)}
            ${renderCampoTempoBatida(t, i, t._reaproveitado)}
          </div>

          <!-- Seção: Resultado -->
          <div class="traco-section-label">📊 Resultado Obtido</div>
          <div class="traco-fields-grid traco-fields-grid--4">
            <div class="form-group">
              <label class="form-label">Densidade EPS <span class="required">*</span></label>
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
    const tracosCompletos = state.tracos.length > 0 && state.tracos.every(tracoCompleto);
    const tracosComAjusteSemTempo = state.tracos.filter(tracoTemAjusteSemTempoBatida);
    const checks = [
      { label: 'Turno definido', ok: !!state.turno },
      { label: 'Dimensão da bateria', ok: !!state.dimensao },
      { label: 'Tipo de montagem', ok: !!state.tipo_montagem },
      { label: 'ID da bateria', ok: !!state.id_bateria },
      { label: 'Injeção iniciada', ok: !!state.inicio },
      { label: 'Injeção finalizada', ok: !!state.fim },
      { label: 'Motivo do atraso', ok: state.houve_atraso === 'NÃO' || !!state.motivo_atraso },
      { label: 'Ao menos 1 traço', ok: state.tracos.length > 0 },
      { label: 'Informações do traço (todos os campos obrigatórios)', ok: tracosCompletos },
      { label: 'Tempo de batida para todos os ajustes de insumo', ok: tracosComAjusteSemTempo.length === 0 }
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
    if (_bloqueadoPorAutorizacao()) return;
    // Montagem Personalizada precisa que "berços reais" bata com a
    // quantidade de berços com tipo definido na grade — confere (e resolve
    // com a pessoa, se precisar) ANTES de seguir com o registro de verdade.
    if (state.tipo_montagem === LW.TIPO_MONTAGEM_PERSONALIZADA) {
      _reconciliarMontagemPersonalizada().then(podeSeguir => {
        if (podeSeguir) _registrarOperacaoInterna();
      });
      return;
    }
    _registrarOperacaoInterna();
  }

  function _registrarOperacaoInterna() {
    const bateria = LW.BATERIA_IDS.find(b => b.id === state.id_bateria);
    const bercos = parseInt(state.bercos_reais) || (bateria?.bercos || 0);

    const calc = state.tipo_montagem === LW.TIPO_MONTAGEM_PERSONALIZADA
      ? LW.calcPaineisPersonalizado(state.bercos_personalizados)
      : LW.calcPaineis(state.tipo_montagem, bercos);

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
      desemplaque: state.desemplaque,
      tempo_min: state.tempo_min,
      qtd_tracos: state.tracos.length,
      houve_atraso: state.houve_atraso,
      motivo_atraso: state.motivo_atraso || '',
      tipo_montagem: state.tipo_montagem,
      bercos_reais: bercos,
      // Detalhe berço a berço — só presente em Montagem Personalizada; o
      // resto do sistema nunca precisa disso (já usa paineis_por_tipo/
      // m2_por_tipo, vindos de ...calc acima), é só pra exibir/auditar a
      // composição exata desta bateria depois.
      ...(state.tipo_montagem === LW.TIPO_MONTAGEM_PERSONALIZADA ? { bercos_personalizados: state.bercos_personalizados } : {}),
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

    // Sem conexão? Não tenta nem perder tempo — já enfileira direto.
    // navigator.onLine é só um indício (pode estar errado em alguns casos),
    // então mesmo quando ele diz "online" ainda tentamos enviar de verdade;
    // é só uma forma de pular a tentativa quando já se sabe que vai falhar.
    // Em modo de teste, NUNCA enfileira — essa fila é só pra operações
    // reais ("será registrada de verdade quando a conexão voltar"); um
    // teste teria a mesma chance de ser sincronizado como dado real depois.
    if (!state.modo_teste && typeof navigator !== 'undefined' && navigator.onLine === false) {
      _enfileirarEContinuar(historyRecord, fullRecord, qtdTracosNovos, fullRecord);
      return;
    }

    Promise.all([
      LW.registrarOperacao(historyRecord, state.modo_teste),
      LW.registrarRelatorioInjecao(fullRecord, state.modo_teste),
      qtdTracosNovos > 0 ? LW.confirmarTracosHoje(qtdTracosNovos, state.modo_teste) : Promise.resolve(),
    ])
      .then(() => {
        LW.clearOperacaoAtual();
        LW.enviarOperacaoAndamento(null, { imediato: true });
        clearInterval(timerInterval);
        resetState();
        renderAll();
        // Pergunta sobre sobra ANTES de mostrar o modal de sucesso
        _perguntarSobraAoFinalizar(fullRecord);
      })
      .catch(err => {
        // TypeError é o que o fetch() do navegador lança quando não
        // consegue NEM CHEGAR no servidor (sem internet, servidor fora do
        // ar) — diferente de um Error "normal", que é o que o próprio
        // código lança quando o servidor respondeu mas recusou o registro
        // por algum motivo de verdade (esse caso continua mostrando o erro
        // pra a pessoa corrigir, não faz sentido enfileirar algo que o
        // servidor já disse que não aceita).
        if (!state.modo_teste && err instanceof TypeError) {
          _enfileirarEContinuar(historyRecord, fullRecord, qtdTracosNovos, fullRecord);
          return;
        }
        LW.mostrarAlerta('Erro ao salvar operação' + (state.modo_teste ? ' de TESTE' : '') + ': ' + err.message, { tipo: 'erro' });
      });
  }

  /**
   * Guarda a operação na fila de pendentes (será enviada de verdade quando
   * a conexão voltar — ver LW.tentarSincronizarFilaPendentes em data.js) e
   * libera a tela na mesma hora, em vez de deixar travado esperando a
   * internet. Mostra um aviso bem claro de que isso ainda NÃO foi
   * confirmado pelo servidor.
   */
  function _enfileirarEContinuar(historyRecord, fullRecord, qtdTracosNovos) {
    LW.enfileirarOperacaoPendente(historyRecord, fullRecord, qtdTracosNovos);

    LW.clearOperacaoAtual();
    LW.enviarOperacaoAndamento(null, { imediato: true }); // melhor esforço — sem conexão, só não vai mesmo
    clearInterval(timerInterval);
    resetState();
    renderAll();

    _mostrarAvisoConexao(
      '📡 Sem conexão com a internet agora. Esta operação foi salva neste computador e será registrada de verdade automaticamente quando a conexão voltar — não precisa preencher de novo.',
      'aviso'
    );
  }

  /**
   * Banner não-bloqueante (diferente de alert()) — usado especificamente
   * pra avisos de conexão, porque um alert() bloqueante daria a impressão
   * de que o sistema "travou" esperando algo, exatamente o que queremos
   * evitar aqui.
   */
  function _mostrarAvisoConexao(mensagem, tipo) {
    let el = document.getElementById('op-aviso-conexao');
    if (!el) {
      el = document.createElement('div');
      el.id = 'op-aviso-conexao';
      el.style.cssText = 'position:fixed;top:70px;right:24px;max-width:380px;z-index:1200;padding:14px 18px;border-radius:8px;font-size:.85rem;line-height:1.45;box-shadow:0 12px 32px rgba(0,0,0,.4);transition:opacity .3s';
      document.body.appendChild(el);
    }
    const cores = {
      aviso: 'background:rgba(245,158,11,.15);border:1px solid var(--accent-dim);color:var(--accent)',
      sucesso: 'background:rgba(16,185,129,.15);border:1px solid var(--green-dim);color:var(--green)',
    };
    el.style.cssText += ';' + (cores[tipo] || cores.aviso);
    el.textContent = mensagem;
    el.style.opacity = '1';
    el.style.display = 'block';
    clearTimeout(el._timeoutOcultar);
    el._timeoutOcultar = setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => { el.style.display = 'none'; }, 350);
    }, 8000);
  }

  /**
   * @param {object} record - resumo da operação (mesmo formato usado no Registrar Operação local)
   * @param {object} [opts]
   * @param {boolean} [opts.remoto] - true quando é a notificação de uma operação finalizada em
   *   OUTRO dispositivo (ver _notificarOperacaoFinalizadaPorOutro) — só troca o título/subtítulo,
   *   o resto do modal (KPIs, botões) é exatamente o mesmo de sempre.
   */
  function showSuccessModal(record, opts = {}) {
    const modal = $('success-modal');
    const titulo = $('success-modal-titulo');
    const subtitulo = $('success-modal-subtitulo');
    if (opts.remoto) {
      titulo.textContent = '✅ Bateria Finalizada';
      subtitulo.textContent = 'Registrada agora por outro dispositivo — fim da dinâmica de dono desta operação.';
      subtitulo.style.display = 'block';
    } else {
      titulo.textContent = 'Operação Registrada!';
      subtitulo.style.display = 'none';
    }
    $('modal-bateria').textContent = record.id_bateria;
    $('modal-tempo').textContent = LW.formatDuration(record.tempo_min);
    $('modal-paineis').textContent = record.total_paineis;
    $('modal-m2').textContent = record.m2_total.toFixed(2) + ' m²';
    $('modal-desemplaque').textContent = LW.formatDateTime(record.desemplaque);
    $('modal-atraso').innerHTML = record.houve_atraso === 'SIM'
      ? '<span class="badge badge-red">SIM</span>'
      : '<span class="badge badge-green">NÃO</span>';
    modal.style.display = 'flex';
  }

  // Caminho do som da notificação — INTENCIONALMENTE sem o arquivo em si
  // (não dá pra gerar um áudio de verdade por aqui): coloque o arquivo de
  // som nesse caminho exato (public/sounds/operacao-finalizada.mp3) que ele
  // passa a tocar sozinho. Até lá, o play() abaixo só falha em silêncio
  // (404), sem quebrar nada nem mostrar erro pra quem está usando o sistema.
  const SOM_OPERACAO_FINALIZADA = '/sounds/operacao-finalizada.mp3';

  /**
   * Chamada quando OUTRO dispositivo (não este) finaliza/registra uma
   * operação — ver conectarOperacaoAndamento() em data.js, que dispara
   * isto via WebSocket pra todo mundo "ligado" no sistema na hora, exceto
   * quem de fato registrou (esse já vê o showSuccessModal local de sempre).
   * Mostra o MESMO modal de sucesso (texto levemente diferente — ver
   * showSuccessModal) e toca um som, já que é algo que pode acontecer sem
   * ninguém estar olhando ativamente pra essa aba.
   */
  function _notificarOperacaoFinalizadaPorOutro(resumo) {
    try {
      const som = new Audio(SOM_OPERACAO_FINALIZADA);
      som.volume = 1;
      som.play().catch(() => { /* navegador pode bloquear autoplay sem interação prévia — ignora */ });
    } catch (_) { /* Audio indisponível neste navegador — só não toca o som */ }
    showSuccessModal(resumo, { remoto: true });
  }

  async function resetarOperacao() {
    if (_bloqueadoPorAutorizacao({ ignorarDono: true })) return false;
    const confirmou = await LW.mostrarConfirmacao(
      'Isso apaga turno, traços, horários e tudo mais preenchido nesta tela.',
      { titulo: 'Limpar todos os dados da operação atual?', textoConfirmar: 'Limpar Tudo', tipo: 'perigo', icon: '🗑️' }
    );
    if (!confirmou) return false;
    clearInterval(timerInterval);
    LW.clearOperacaoAtual();
    LW.enviarOperacaoAndamento(null, { imediato: true, forcar: true });
    resetState();
    renderAll();
    return true;
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
      desemplaque: null,
      status: 'idle',
      tracos: [],
      // Sempre volta pra false — exige reativar o toggle a cada operação
      // nova, de propósito: evita o risco de "esquecer ligado" e uma
      // operação REAL acabar indo pros arquivos de teste sem querer.
      modo_teste: false,
      bercos_personalizados: null,
    };
  }

  // Mostra/escurece o botão "🔧 Configurar Berços" conforme o tipo de
  // montagem atual — chamada tanto no render completo (renderAll) quanto
  // direto no listener de change do select (ver wireEvents()), que antes
  // só recalculava painéis e persistia, sem atualizar este botão: ao
  // escolher "Personalizada" pela primeira vez, o botão pra reabrir a
  // grade depois nunca aparecia (só surgia num reload, via renderAll).
  function _atualizarBtnConfigurarBercos() {
    if (!$('btn-configurar-bercos')) return;
    $('btn-configurar-bercos').style.display = state.tipo_montagem === LW.TIPO_MONTAGEM_PERSONALIZADA ? 'inline-flex' : 'none';
  }

  function renderAll() {
    // Set form values
    $('op-toggle-teste').checked = !!state.modo_teste;
    $('op-toggle-teste').disabled = state.status !== 'idle';
    $('op-turno').value = state.turno || '1º TURNO';
    $('op-dimensao').value = state.dimensao || '';

    $('op-montagem').value = state.tipo_montagem || '';
    _atualizarBtnConfigurarBercos();
    $('op-id-bateria').value = state.id_bateria || '';
    $('op-bercos-reais').value = state.bercos_reais || '';
    $('op-motivo').value = state.motivo_atraso || '';

    updateCapacidade();

    $('op-inicio').value = state.inicio ? LW.formatTime(state.inicio) : '';
    $('op-fim').value = state.fim ? LW.formatTime(state.fim) : '';
    $('op-tempo-total').textContent = state.tempo_min ? LW.formatDuration(state.tempo_min) : '—';

    if (state.desemplaque) {
      $('op-desemplaque').textContent = LW.formatDateTime(state.desemplaque);
      $('op-desemplaque-row').style.display = 'block';
    } else {
      $('op-desemplaque-row').style.display = 'none';
    }

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

    // Cronômetro: reflete o estado atual sempre que a tela é renderizada.
    // Sem isso, depois de Resetar (ou Finalizar) o relógio ficava "congelado"
    // mostrando o último valor antes do reset, em vez de voltar pra 00:00 —
    // só era atualizado de novo quando uma nova operação era iniciada.
    // Enquanto uma operação está 'running', deixa o setInterval de
    // startTimerUI() ser o único responsável por atualizar o relógio.
    if (state.status !== 'running') {
      const elTimer = $('timer-display');
      if (elTimer) {
        elTimer.textContent = '00:00';
        elTimer.className = 'timer-display';
      }
    }

    const brNow = nowBrasilia();
    $('op-data').textContent = brNow.toLocaleDateString('pt-BR', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
      timeZone: 'UTC'
    });

    renderTracos();
    recalcPaineis();
    updateStatusBanner();
    updatePendencias();
    _aplicarTravaDeAutorizacao();
  }

  function persist() {
    LW.saveOperacaoAtual(state);
    // Operação de TESTE nunca é transmitida — fica só neste navegador, do
    // início ao fim. É assim que ela nunca aparece pra quem mais estiver
    // acompanhando a tela (que só vê operações reais) e nunca passa pela
    // trava de Autorizados/dono (que só faz sentido pra operações reais).
    if (!state.modo_teste) {
      // Só transmite a partir do momento em que a operação É iniciada
      // (status deixa de ser 'idle') — campos preenchidos ANTES de
      // "Iniciar Injeção" continuam sendo só um rascunho local, sem
      // aparecer pra quem mais estiver com a tela aberta.
      LW.enviarOperacaoAndamento(state.status === 'idle' ? null : state);
    }
    updatePendencias();
  }

  // ---- Public API ----
  window.LWOp = {
    init,
    iniciarInjecao,
    finalizarInjecao,
    resetarOperacao,
    atualizarTravaAutorizacao: _aplicarTravaDeAutorizacao,
    abrirGradeMontagem: abrirGradeMontagemPersonalizada,
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
      const t = state.tracos[i];
      if (!t || _tempoBatidaTravado(t)) return; // mesma trava do HTML (defesa extra)
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
      const t = state.tracos[i];
      if (!t || _tempoBatidaTravado(t)) { renderTracos(); return; } // desfaz qualquer digitação que tenha escapado do readonly
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
      renderTracos(); // Re-renderiza para atualizar a visibilidade do botão "+ Ajuste de Receita"
    },

    // Abre o modal unificado de Ajuste de Receita (insumo + tempo de
    // batida juntos) — ver _mostrarModalAjusteReceita.
    abrirAjusteReceita(i) {
      const t = state.tracos[i];
      if (!t || t._reaproveitado) return;
      _mostrarModalAjusteReceita(i);
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