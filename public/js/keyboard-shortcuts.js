/**
 * ============================================================
 *  LIGHTWALL SC — ATALHOS DE TECLADO GLOBAIS
 *  keyboard-shortcuts.js
 *
 *  Módulo independente. Para adicionar novos atalhos, basta
 *  inserir entradas em SHORTCUTS_CONFIG ou NAV_CONFIG abaixo.
 * ============================================================
 */

; (function () {
  'use strict';

  /* ──────────────────────────────────────────────────────────
   * 1. CONFIGURAÇÃO CENTRALIZADA
   * ────────────────────────────────────────────────────────── */

  /** Atalhos de navegação: Alt + Dígito → página (combo customizável) */
  const NAV_CONFIG = [
    { id: 'nav_operacao', comboPadrao: 'Alt+1', page: 'operacao', label: 'Operação', icon: '⚙' },
    { id: 'nav_registro', comboPadrao: 'Alt+2', page: 'registro', label: 'Relatorio de Baterias', icon: '📋' },
    { id: 'nav_relatorio', comboPadrao: 'Alt+3', page: 'relatorio', label: 'Relatório de Injeção', icon: '🧾' },
    { id: 'nav_qualidade', comboPadrao: 'Alt+4', page: 'qualidade-tracos', label: 'Qualidade dos Traços', icon: '📐' },
    { id: 'nav_analise', comboPadrao: 'Alt+5', page: 'analise-operacional', label: 'Análise Operacional', icon: '📊' },
    { id: 'nav_turnos', comboPadrao: 'Alt+6', page: 'turnos', label: 'Turnos', icon: '⏳' },
    { id: 'nav_menu', comboPadrao: 'Alt+7', page: 'menu', label: 'Menu Principal', icon: '⬡' },
    { id: 'nav_oee', comboPadrao: 'Alt+8', page: 'oee', label: 'OEE', icon: '🎯' },
    // ─── Adicionados: estas 4 páginas existiam no menu (nav-sidebar.html)
    // mas ainda não tinham atalho de navegação. Dígitos 1-8 já estavam
    // todos ocupados; 9 e 0 fecham a sequência numérica, e as 2 últimas
    // (letras já sem dígito livre) usam mnemônico da inicial da página.
    { id: 'nav_relatorio_bercos', comboPadrao: 'Alt+9', page: 'relatorio-bercos', label: 'Relatório de Berços', icon: '📑' },
    { id: 'nav_analise_bercos', comboPadrao: 'Alt+0', page: 'analise-bercos', label: 'Análise de Berços', icon: '💧' },
    { id: 'nav_paradas', comboPadrao: 'Alt+P', page: 'paradas', label: 'Registro de Paradas', icon: '⏸' },
    { id: 'nav_setor_qualidade', comboPadrao: 'Alt+Q', page: 'setor-qualidade', label: 'Setor de Qualidade', icon: '🛡' },
  ];

  /**
   * Atalhos de ação genérica.
   * `handler` é o nome da função global ou uma função inline.
   * `description` aparece no modal de ajuda. `comboPadrao` é o combo de
   * fábrica — o combo em uso de fato (que pode ter sido personalizado pelo
   * usuário) é calculado em tempo real por _comboEfetivo(id, comboPadrao).
   */
  const ACTION_CONFIG = [
    {
      id: 'acao_filtro',
      comboPadrao: 'Ctrl+Shift+F',
      description: 'Abrir painel de filtros',
      icon: '🔍',
      handler: () => _openFilterPanel(),
    },
    {
      id: 'acao_atualizar',
      comboPadrao: 'Ctrl+Shift+R',
      description: 'Atualizar dados',
      icon: '↺',
      handler: () => _refreshData(),
    },
    {
      id: 'acao_exportar',
      comboPadrao: 'Ctrl+Shift+E',
      description: 'Exportar relatório',
      icon: '⬇',
      handler: () => _exportReport(),
    },
    {
      id: 'acao_novo_traco',
      comboPadrao: 'Ctrl+Shift+A',
      description: 'Adicionar novo traço',
      icon: '➕',
      handler: () => _addNewTraco(),
    },
    {
      id: 'acao_debriefing',
      comboPadrao: 'Alt+D',
      description: 'Abrir Debriefing do Dia',
      icon: '📓',
      handler: () => _toggleDebriefing(),
    },
    {
      id: 'acao_cronometro',
      comboPadrao: 'Ctrl+Space',
      description: 'Iniciar/Finalizar cronômetro',
      icon: '▶',
      handler: () => _startInjectionTimer(),
    },
    {
      id: 'acao_resetar',
      comboPadrao: 'Ctrl+R',
      description: 'Resetar operação',
      icon: '↺',
      handler: () => _resetOperation(),
    },
    {
      id: 'acao_registrar',
      comboPadrao: 'Ctrl+Enter',
      description: 'Registrar operação',
      icon: '✓',
      handler: () => _registerOperation(),
    },
    {
      id: 'acao_config',
      comboPadrao: 'Alt+C',
      description: 'Abrir Configurações',
      icon: '⚙',
      handler: () => _openConfig(),
    },
    {
      id: 'acao_modo_visual_bercos',
      comboPadrao: 'Alt+V',
      description: 'Alternar Berços: Tabela ↔ Modo Visual',
      icon: '🎨',
      handler: () => _toggleModoVisualBercos(),
    },
    {
      id: 'acao_sair',
      comboPadrao: 'Alt+E',
      description: 'Sair (logout)',
      icon: '🚪',
      handler: () => _logout(),
    },
    {
      id: 'acao_sq_registrar',
      comboPadrao: '', // sem atalho de fábrica de propósito — ver _sqRegistrarAvaliacao
      description: 'Setor de Qualidade: Registrar Avaliação',
      icon: '✓',
      handler: () => _sqRegistrarAvaliacao(),
    },
    {
      id: 'acao_sq_desfazer',
      comboPadrao: '', // sem atalho de fábrica de propósito — ver _sqDesfazerMarca
      description: 'Setor de Qualidade: Desfazer Última Marca',
      icon: '↺',
      handler: () => _sqDesfazerMarca(),
    },
  ];

  /**
   * Atalhos que EXISTEM no sistema mas não fazem parte deste módulo —
   * cada um é tratado localmente por outra tela (Setor de Qualidade,
   * Registro de Baterias, Registro de Operação, Relatório de Berços...),
   * então não são remapeáveis nem disparados por aqui. Ficam catalogados
   * SÓ como referência/guia — pra quem consulta Configurações → Atalhos
   * de Teclado (ou o modal de ajuda, F1) enxergar TODOS os atalhos do
   * sistema num único lugar, editáveis ou não. Pra registrar um atalho
   * não-editável novo no futuro, basta uma entrada aqui — nenhuma outra
   * mudança neste arquivo é necessária (ver cfgRenderAtalhos, app-core.js,
   * e _buildHelpModal, mais abaixo, que já leem esta lista).
   */
  const REFERENCIA_CONFIG = [
    {
      icon: '🔎',
      combo: 'Ctrl + clique',
      contexto: 'Registro de Baterias',
      descricao: 'Abre a Análise Focada da operação clicada — funciona em qualquer modo (normal, foco ou edição).',
    },
    {
      icon: '🖱',
      combo: 'Segurar Ctrl',
      contexto: 'Relatório de Berços',
      descricao: 'Com o mouse sobre uma linha, mostra o popover de detalhes daquela operação (só em dispositivos com mouse/ponteiro fino).',
    },
    {
      icon: '🎨',
      combo: '1, 2, 3...',
      contexto: 'Setor de Qualidade → Avaliação',
      descricao: 'Seleciona a cor de marcação, na ordem em que as cores aparecem na tela.',
    },
    {
      icon: '◆',
      combo: 'Ctrl + 1, 2, 3...',
      contexto: 'Setor de Qualidade → Avaliação',
      descricao: 'Seleciona a forma de marcação (círculo, traço...), na ordem em que aparecem na tela.',
    },
    {
      icon: '🔲',
      combo: '1-9, 0, Ctrl+1-9, Ctrl+0',
      contexto: 'Registro de Operação → Grade de Montagem Personalizada',
      descricao: 'Seleciona o tipo de montagem simples cadastrado (até 20 tipos), na ordem em que aparecem nas abas.',
    },
  ];

  /* ──────────────────────────────────────────────────────────
   * 2. ESTADO INTERNO
   * ────────────────────────────────────────────────────────── */

  /** Índice da página atual dentro de NAV_CONFIG */
  let _currentNavIndex = 0;

  /**
   * Atalhos personalizados pelo usuário — { [id]: 'Ctrl+Shift+X', ... }.
   * Fica salvo no localStorage (preferência pessoal deste navegador, não do
   * servidor — cada pessoa pode ter o seu próprio jeito mais confortável).
   * Vazio = todo mundo usa o padrão de fábrica.
   */
  const LS_KEY_ATALHOS = 'lw_atalhos_customizados';
  let _overrides = {};

  function _carregarOverrides() {
    try {
      const raw = localStorage.getItem(LS_KEY_ATALHOS);
      _overrides = raw ? JSON.parse(raw) : {};
    } catch (_) {
      _overrides = {};
    }
  }

  function _salvarOverrides() {
    try {
      localStorage.setItem(LS_KEY_ATALHOS, JSON.stringify(_overrides));
    } catch (_) { /* localStorage indisponível — segue só em memória */ }
  }

  /** Combo em uso de fato pra um atalho — o personalizado, se houver, senão
   * o padrão. Usa `in` (não truthiness) pra diferenciar "nunca personalizado"
   * (cai no padrão) de "personalizado pra vazio" (string '' = sem atalho,
   * de propósito — ver _definirAtalho ao substituir um conflito). */
  function _comboEfetivo(id, comboPadrao) {
    return (id in _overrides) ? _overrides[id] : comboPadrao;
  }

  /** Lista plana de todos os atalhos remapeáveis (navegação + ações), cada
   * um já com seu combo efetivo calculado — usada pela tela de Configurações. */
  function _todosAtalhos() {
    const nav = NAV_CONFIG.map(n => ({
      id: n.id, grupo: 'navegacao', label: n.label, icon: n.icon,
      comboPadrao: n.comboPadrao, comboAtual: _comboEfetivo(n.id, n.comboPadrao),
    }));
    const acoes = ACTION_CONFIG.map(a => ({
      id: a.id, grupo: 'acao', label: a.description, icon: a.icon,
      comboPadrao: a.comboPadrao, comboAtual: _comboEfetivo(a.id, a.comboPadrao),
    }));
    return [...nav, ...acoes];
  }

  /**
   * Define um novo combo pra um atalho (por id).
   *
   * Se o combo já estiver em uso por OUTRO atalho (compara contra o combo
   * EFETIVO de todos os outros, não só os padrões de fábrica) e
   * `opts.substituirConflito` não foi passado como `true`, a troca é
   * recusada e o conflito é devolvido pra quem chamou decidir (normalmente:
   * perguntar pro usuário se quer substituir mesmo assim).
   *
   * Quando `opts.substituirConflito` é `true`, a troca segue mesmo com
   * conflito — e o atalho que antes usava esse combo fica SEM atalho
   * nenhum (string vazia), nunca herda o combo antigo de `id`.
   *
   * @returns {{ok:true, substituiu?:{id,label}} | {ok:false, erro?:string, conflito?:{id,label,icon}}}
   */
  function _definirAtalho(id, novoCombo, opts = {}) {
    const todos = _todosAtalhos();
    const alvo = todos.find(a => a.id === id);
    if (!alvo) return { ok: false, erro: 'Atalho não encontrado.' };

    const conflito = todos.find(a => a.id !== id && a.comboAtual === novoCombo);
    if (conflito && !opts.substituirConflito) {
      return { ok: false, conflito: { id: conflito.id, label: conflito.label, icon: conflito.icon } };
    }

    _overrides[id] = novoCombo;
    // Substituição confirmada: o antigo titular do combo fica sem atalho —
    // nunca "troca" pro combo anterior de `id` (ele pode nem ter um).
    if (conflito) _overrides[conflito.id] = '';
    _salvarOverrides();
    return { ok: true, substituiu: conflito ? { id: conflito.id, label: conflito.label } : null };
  }

  /** Restaura TODOS os atalhos pro padrão de fábrica, de uma vez. */
  function _resetarAtalhos() {
    _overrides = {};
    _salvarOverrides();
  }

  /**
   * Callback pendente de captura de tecla — enquanto não-nulo, o listener
   * principal desvia o PRÓXIMO keydown pra cá em vez de tratar como atalho
   * normal. Usado pela tela de Configurações ao remapear um atalho.
   */
  let _capturarCallback = null;

  /**
   * Liga o "modo de escuta": a próxima tecla (ou combinação) pressionada é
   * capturada e passada pra `callback`, em vez de disparar normalmente.
   * `callback` recebe: null (cancelado com Esc), { erro } (combo inválido,
   * sem nenhuma tecla modificadora) ou { combo } (capturado com sucesso).
   */
  function _capturarProximoCombo(callback) {
    _capturarCallback = callback;
  }

  function _cancelarCaptura() {
    _capturarCallback = null;
  }

  /* ──────────────────────────────────────────────────────────
   * 3. UTILITÁRIOS
   * ────────────────────────────────────────────────────────── */

  /**
   * Retorna true se o foco está num campo onde os atalhos devem ficar
   * desligados — de propósito, só campos de TEXTO livre (onde digitar uma
   * letra comum poderia disparar um atalho sem querer): input[type=text],
   * textarea (mesmo raciocínio — texto livre, só que multi-linha, ex.:
   * "Observações") e qualquer elemento contentEditable.
   *
   * Antes, QUALQUER <input> (exceto button/checkbox/radio/submit/reset) e
   * qualquer <select> bloqueavam os atalhos — isso incluía date, number,
   * color, file, password, o que fazia os atalhos de navegação (mudar de
   * página) pararem de funcionar o tempo todo que o operador estivesse
   * preenchendo uma data ou uma quantidade, por exemplo, mesmo sem estar
   * digitando texto nenhum. Pedido explícito: exceção é só type="text".
   *
   * Tipos de input "texto livre por natureza" mas que não são
   * type="text" (search/email/tel/url/password) não existem hoje neste
   * app (ver grep em todos os partials) — se algum for adicionado no
   * futuro e também precisar bloquear atalhos, incluir aqui.
   */
  function _isFocusedOnInput() {
    const el = document.activeElement;
    const tag = el?.tagName?.toLowerCase();
    const type = (el?.type || '').toLowerCase();
    const editable = el?.isContentEditable;
    if (editable) return true;
    if (tag === 'textarea') return true;
    if (tag === 'input' && type === 'text') return true;
    return false;
  }

  /** Traduz o evento para uma string de combo legível */
  function _comboFromEvent(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    const k = e.key;
    // Normaliza teclas especiais
    const MAP = {
      ArrowLeft: '←',
      ArrowRight: '→',
      F1: 'F1',
      '?': '?',
      Enter: 'Enter',
      ' ': 'Space',
    };
    parts.push(MAP[k] ?? k.toUpperCase());
    return parts.join('+');
  }

  /* ──────────────────────────────────────────────────────────
   * 4. DESTAQUE VISUAL NO MENU
   * ────────────────────────────────────────────────────────── */

  function _highlightNavItem(pageId) {
    // Remove destaque de teclado de todos os itens
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.remove('kb-active');
    });
    const target = document.querySelector(`.nav-item[data-page="${pageId}"]`);
    if (!target) return;
    target.classList.add('kb-active');
    // Remove o destaque após 1,5 s (é apenas um flash visual)
    setTimeout(() => target.classList.remove('kb-active'), 1500);
  }

  /* ──────────────────────────────────────────────────────────
   * 5. NOTIFICAÇÃO TOAST
   * ────────────────────────────────────────────────────────── */

  let _toastTimer = null;

  function _showToast(icon, message) {
    let toast = document.getElementById('kb-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'kb-toast';
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span class="kb-toast-icon">${icon}</span><span>${message}</span>`;
    toast.classList.add('kb-toast-visible');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => toast.classList.remove('kb-toast-visible'), 2200);
  }

  /* ──────────────────────────────────────────────────────────
   * 6. NAVEGAÇÃO
   * ────────────────────────────────────────────────────────── */

  function _navigateTo(navEntry) {
    if (typeof showPage !== 'function') return;
    showPage(navEntry.page);
    _highlightNavItem(navEntry.page);
    _showToast(navEntry.icon, navEntry.label);
    _currentNavIndex = NAV_CONFIG.findIndex(n => n.page === navEntry.page);
  }

  function _navigatePrev() {
    const prev = _currentNavIndex - 1;
    const idx = prev < 0 ? NAV_CONFIG.length - 1 : prev;
    _navigateTo(NAV_CONFIG[idx]);
  }

  function _navigateNext() {
    const next = _currentNavIndex + 1;
    const idx = next >= NAV_CONFIG.length ? 0 : next;
    _navigateTo(NAV_CONFIG[idx]);
  }

  /* ──────────────────────────────────────────────────────────
   * 7. HANDLERS DE AÇÃO
   * ────────────────────────────────────────────────────────── */

  function _openFilterPanel() {
    // Detecta qual página está ativa e clica no primeiro input de data/filtro
    const active = document.querySelector('.main.active');
    if (!active) { _showToast('🔍', 'Filtros não disponíveis'); return; }

    const firstDate = active.querySelector('input[type="date"]');
    if (firstDate) {
      firstDate.focus();
      firstDate.select?.();
      _showToast('🔍', 'Painel de filtros aberto');
    } else {
      _showToast('🔍', 'Filtros não disponíveis nesta tela');
    }
  }

  /**
   * Checa se a sub-aba "Dashboard" do Setor de Qualidade está ativa —
   * essa tela tem 3 sub-abas internas (Avaliação/Dashboard/Registros,
   * ver .sq-section.active) DENTRO da mesma página; "Atualizar"/
   * "Exportar" só fazem sentido na do Dashboard, não nas outras 2.
   */
  function _sqDashboardAtivo() {
    return !!document.getElementById('sq-dashboard')?.classList.contains('active');
  }

  function _refreshData() {
    // Chama o init/render da página ativa, se disponível — cobre TODA
    // página que tem algum tipo de "recarregar dados" (a maioria dos
    // relatórios/dashboards do sistema).
    const active = document.querySelector('.main.active');
    const pageId = active?.id?.replace('page-', '');

    const refreshMap = {
      menu: () => null,
      operacao: () => typeof LWOp !== 'undefined' && LWOp.init?.(),
      turnos: () => typeof LWDash !== 'undefined' && LWDash.initTurnos?.(),
      registro: () => typeof LWDash !== 'undefined' && LWDash.initRegistro?.(),
      relatorio: () => typeof LWDash !== 'undefined' && LWDash.initRelatorio?.(),
      'relatorio-bercos': () => typeof LWBercos !== 'undefined' && LWBercos.render?.(),
      'analise-bercos': () => typeof ABercos !== 'undefined' && ABercos.render?.(),
      'analise-focada': () => typeof LWFocada !== 'undefined' && LWFocada.render?.(),
      'analise-operacional': () => typeof AOp !== 'undefined' && AOp.render?.(),
      'qualidade-tracos': () => typeof LWQualidade !== 'undefined' && LWQualidade.render?.(),
      oee: () => typeof LWOee !== 'undefined' && LWOee.render?.(),
      paradas: () => typeof LWParadas !== 'undefined' && LWParadas.aplicarFiltros?.(),
      'setor-qualidade': () => {
        if (!_sqDashboardAtivo() || typeof SQ === 'undefined' || typeof SQ.renderDashboard !== 'function') return false;
        SQ.renderDashboard();
      },
    };

    const fn = refreshMap[pageId];
    const resultado = fn ? fn() : false;
    if (fn && resultado !== false) { _showToast('↺', 'Dados atualizados'); }
    else { _showToast('↺', 'Atualização não disponível nesta tela'); }
  }

  function _exportReport() {
    // Cada página exporta de um jeito diferente (modal de Excel, HTML
    // interativo standalone, ou nem tem exportação) — mapeia pra função
    // certa de cada uma. Cobre tanto os "⬇ Exportar Excel (.xlsx)"
    // (Registro/Relatório de Injeção) quanto os "🌐 Exportar Interativo"
    // espalhados pelos dashboards (Turnos, Berços, Focada, Traços, OEE,
    // Operacional, Setor de Qualidade).
    const active = document.querySelector('.main.active');
    const pageId = active?.id?.replace('page-', '');

    const exportMap = {
      registro: () => typeof LWDash !== 'undefined' && LWDash.abrirExportModal?.(),
      relatorio: () => typeof LWDash !== 'undefined' && LWDash.abrirExportModalRelatorio?.(),
      turnos: () => typeof LWDash !== 'undefined' && LWDash.exportarTurnosInterativo?.(),
      'analise-bercos': () => typeof ABercos !== 'undefined' && ABercos.exportarInterativo?.(),
      'analise-focada': () => typeof LWFocada !== 'undefined' && LWFocada.exportarInterativo?.(),
      'qualidade-tracos': () => typeof LWQualidade !== 'undefined' && LWQualidade.exportarInterativo?.(),
      oee: () => typeof LWOee !== 'undefined' && LWOee.exportarInterativo?.(),
      'analise-operacional': () => typeof AOp !== 'undefined' && AOp.exportarInterativo?.(),
      'setor-qualidade': () => {
        if (!_sqDashboardAtivo() || typeof SQ === 'undefined' || typeof SQ.exportDashboardHTML !== 'function') return false;
        SQ.exportDashboardHTML();
      },
      // Relatório de Berços e Registro de Paradas não têm exportação
      // nenhuma hoje — de propósito fora deste mapa, cai no "não
      // disponível" abaixo.
    };

    const fn = exportMap[pageId];
    const resultado = fn ? fn() : false;
    if (fn && resultado !== false) { _showToast('⬇', 'Exportar relatório'); }
    else { _showToast('⬇', 'Exportação não disponível nesta tela'); }
  }

  function _addNewTraco() {
    // Verifica se o módulo de operação está carregado
    if (typeof LWOp !== 'undefined' && typeof LWOp.addTraco === 'function') {
      // Se não estiver na página de operação, navega até ela primeiro
      const active = document.querySelector('.main.active');
      const pageId = active?.id?.replace('page-', '');

      if (pageId !== 'operacao' && typeof showPage === 'function') {
        showPage('operacao');
      }

      LWOp.addTraco();
      _showToast('➕', 'Novo traço adicionado');
    } else {
      _showToast('➕', 'Ação não disponível no momento');
    }
  }


  /**
   * Abre/fecha o Debriefing do Dia. Diferente da maioria dos outros atalhos
   * de ação, este funciona em QUALQUER página — o Debriefing vive na topbar,
   * que é compartilhada por todas as telas.
   */
  function _toggleDebriefing() {
    if (typeof LWDebriefing !== 'undefined' && typeof LWDebriefing.toggle === 'function') {
      LWDebriefing.toggle();
      _showToast('📓', 'Debriefing do Dia');
    } else {
      _showToast('📓', 'Debriefing não disponível');
    }
  }

  /**
   * Abre a tela de Configurações — funciona em QUALQUER página (o botão
   * vive na topbar, compartilhada por todas as telas). abrirConfig() já
   * checa sozinha se a pessoa é Administrador (só ela pode abrir, ver
   * app-core.js) — o atalho não precisa duplicar essa checagem, só não
   * faz nada se a pessoa não for admin (mesmo comportamento do botão).
   */
  function _openConfig() {
    if (typeof abrirConfig === 'function') {
      abrirConfig();
    } else {
      _showToast('⚙', 'Configurações não disponível');
    }
  }

  /**
   * Alterna entre Tabela e Modo Visual no Relatório de Berços — mesmo
   * padrão de _resetOperation/_registerOperation: só funciona se a pessoa
   * já estiver na página certa (o botão #btn-rb-modo-visual só existe
   * dentro dela).
   */
  function _toggleModoVisualBercos() {
    const active = document.querySelector('.main.active');
    const pageId = active?.id?.replace('page-', '');

    if (pageId !== 'relatorio-bercos') {
      _showToast('🎨', 'Atalho disponível apenas na página de Relatório de Berços');
      return;
    }

    const btn = document.getElementById('btn-rb-modo-visual');
    if (btn) {
      btn.click();
      _showToast('🎨', 'Modo Visual alternado');
    } else {
      _showToast('🎨', 'Alternância não disponível');
    }
  }

  /**
   * Sai da sessão de Administrador — funciona em QUALQUER página (o
   * botão "Sair" vive na topbar). AdminAuth.logout() já redireciona pra
   * login.html sozinho, então não precisa de toast (a página muda antes
   * de qualquer aviso aparecer).
   */
  function _logout() {
    if (typeof AdminAuth !== 'undefined' && typeof AdminAuth.logout === 'function') {
      AdminAuth.logout();
    } else {
      _showToast('🚪', 'Sair não disponível');
    }
  }

  /**
   * Checa se o Setor de Qualidade está na sub-aba "Avaliação" (formulário
   * de marcação) — só lá "Registrar" e "Desfazer" fazem sentido, não nas
   * sub-abas Dashboard/Registros.
   */
  function _sqFormularioAtivo() {
    const active = document.querySelector('.main.active');
    const pageId = active?.id?.replace('page-', '');
    return pageId === 'setor-qualidade' && !!document.getElementById('sq-form')?.classList.contains('active');
  }

  /**
   * "Registrar avaliação" (Setor de Qualidade → Avaliação). Sem combo
   * padrão de fábrica (ver ACTION_CONFIG, comboPadrao: '') — fica "Sem
   * atalho" até a própria pessoa definir um em Configurações → Atalhos
   * de Teclado, já que é uma ação DESTRUTIVA/definitiva (mesmo que passe
   * por confirmação) demais pra vir pré-ligada a uma tecla de fábrica.
   * SQ.registerEvaluation() já abre seu próprio modal de confirmação —
   * o atalho só dispara o mesmo fluxo que o botão "✓ Registrar" dispara,
   * nenhum toast de sucesso aqui (o modal já é o feedback).
   */
  function _sqRegistrarAvaliacao() {
    if (!_sqFormularioAtivo() || typeof SQ === 'undefined' || typeof SQ.registerEvaluation !== 'function') {
      _showToast('✓', 'Atalho disponível apenas no formulário de Avaliação do Setor de Qualidade');
      return;
    }
    SQ.registerEvaluation();
  }

  /**
   * "Desfazer última marca" (Setor de Qualidade → Avaliação). Mesmo
   * motivo do atalho acima: sem combo padrão de fábrica.
   */
  function _sqDesfazerMarca() {
    if (!_sqFormularioAtivo() || typeof SQ === 'undefined' || typeof SQ.undoLastAction !== 'function') {
      _showToast('↺', 'Atalho disponível apenas no formulário de Avaliação do Setor de Qualidade');
      return;
    }
    SQ.undoLastAction();
    _showToast('↺', 'Última marca desfeita');
  }

  async function _startInjectionTimer() {
    const active = document.querySelector('.main.active');
    const pageId = active?.id?.replace('page-', '');

    // O atalho funciona apenas se o usuário já estiver na página de operação
    if (pageId !== 'operacao') return;

    const btnIniciar = document.getElementById('btn-iniciar');
    const btnFinalizar = document.getElementById('btn-finalizar');

    // Se o botão de iniciar estiver habilitado, inicia a injeção
    if (btnIniciar && !btnIniciar.disabled) {
      btnIniciar.click();
      _showToast('▶', 'Injeção iniciada');
      return;
    }

    // Se o botão de finalizar estiver habilitado (injeção em curso), finaliza.
    // finalizarInjecao() pede confirmação num modal (assíncrono) — por isso
    // chamamos a função direto via LWOp (em vez de simular clique no botão)
    // e aguardamos o resultado, só mostrando o toast se foi mesmo confirmado.
    if (btnFinalizar && !btnFinalizar.disabled && typeof LWOp !== 'undefined' && LWOp.finalizarInjecao) {
      const finalizou = await LWOp.finalizarInjecao();
      if (finalizou) {
        _showToast('⏹', 'Injeção finalizada');
      }
      return;
    }

    _showToast('⏹', 'Operação já finalizada ou indisponível');
  }

  /**
   * Reseta a operação atual na página de operação.
   * Funciona apenas se o usuário estiver na página 'operacao'.
   */
  async function _resetOperation() {
    const active = document.querySelector('.main.active');
    const pageId = active?.id?.replace('page-', '');

    // O atalho funciona apenas se o usuário já estiver na página de operação
    if (pageId !== 'operacao') {
      _showToast('↺', 'Atalho disponível apenas na página de Operação');
      return;
    }

    const btnResetar = document.getElementById('btn-resetar');
    if (btnResetar && !btnResetar.disabled && typeof LWOp !== 'undefined' && LWOp.resetarOperacao) {
      const resetou = await LWOp.resetarOperacao();
      if (resetou) {
        _showToast('↺', 'Operação resetada');
      }
    } else {
      _showToast('↺', 'Resetar não disponível');
    }
  }

  /**
   * Registra a operação atual na página de operação.
   * Funciona apenas se o usuário estiver na página 'operacao'.
   */
  function _registerOperation() {
    const active = document.querySelector('.main.active');
    const pageId = active?.id?.replace('page-', '');

    if (pageId !== 'operacao') {
      _showToast('✓', 'Atalho disponível apenas na página de Operação');
      return;
    }

    const btnRegistrar = document.getElementById('btn-registrar');
    if (btnRegistrar && !btnRegistrar.disabled) {
      btnRegistrar.click();
      _showToast('✓', 'Operação registrada');
    } else {
      _showToast('✓', 'Registrar não disponível');
    }
  }

  /* ──────────────────────────────────────────────────────────
   * 8. MODAL DE AJUDA
   * ────────────────────────────────────────────────────────── */

  function _buildHelpModal() {
    // Sempre reconstrói — os combos podem ter sido personalizados desde a
    // última vez que esse modal foi aberto (tela de Configurações).
    document.getElementById('kb-help-modal')?.remove();

    const navRows = NAV_CONFIG.map(n => {
      const combo = _comboEfetivo(n.id, n.comboPadrao);
      const kbds = combo === ''
        ? '<span class="kb-help-sem-atalho">Sem atalho</span>'
        : combo.split('+').map(p => `<kbd>${p}</kbd>`).join(' + ');
      return `<tr>
        <td>${kbds}</td>
        <td class="kb-help-desc">${n.icon} ${n.label}</td>
      </tr>`;
    }).join('');

    const navArrowRows = `
      <tr>
        <td><kbd>Alt</kbd> + <kbd>←</kbd></td>
        <td class="kb-help-desc">↩ Página anterior</td>
      </tr>
      <tr>
        <td><kbd>Alt</kbd> + <kbd>→</kbd></td>
        <td class="kb-help-desc">↪ Próxima página</td>
      </tr>`;

    const actionRows = ACTION_CONFIG.map(a => {
      const combo = _comboEfetivo(a.id, a.comboPadrao);
      const kbds = combo === ''
        ? '<span class="kb-help-sem-atalho">Sem atalho</span>'
        : combo.split('+').map(p => `<kbd>${p}</kbd>`).join(' + ');
      return `<tr>
        <td>${kbds}</td>
        <td class="kb-help-desc">${a.icon} ${a.description}</td>
      </tr>`;
    }).join('');

    // Atalhos não-editáveis (ver REFERENCIA_CONFIG) — cada linha aqui é só
    // documentação; quem trata a tecla de verdade é a tela indicada em
    // "contexto", não este módulo.
    const refRows = REFERENCIA_CONFIG.map(r => `
      <tr>
        <td><kbd>${r.combo}</kbd></td>
        <td class="kb-help-desc"><strong>${r.icon} ${r.contexto}</strong><br>${r.descricao}</td>
      </tr>`).join('');

    const modal = document.createElement('div');
    modal.id = 'kb-help-modal';
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('role', 'dialog');
    modal.innerHTML = `
      <div class="kb-help-backdrop" id="kb-help-backdrop"></div>
      <div class="kb-help-box">
        <div class="kb-help-header">
          <span class="kb-help-title">⌨ Atalhos de Teclado</span>
          <button class="kb-help-close" id="kb-help-close" title="Fechar (Esc)">✕</button>
        </div>
        <div class="kb-help-body">
          <div>
            <div class="kb-help-section-label">Navegação rápida</div>
            <table class="kb-help-table">
              <tbody>${navRows}${navArrowRows}</tbody>
            </table>
          </div>
          <div>
            <div class="kb-help-section-label" style="margin-top:18px">Ações</div>
              <table class="kb-help-table">
                <tbody>${actionRows}</tbody>
              </table>
            <div class="kb-help-section-label" style="margin-top:18px">Ajuda</div>
            <table class="kb-help-table">
              <tbody>
                <tr>
                  <td><kbd>F1</kbd> ou <kbd>?</kbd></td>
                  <td class="kb-help-desc">📖 Exibir esta janela de atalhos</td>
                </tr>
                <tr>
                  <td><kbd>Esc</kbd></td>
                  <td class="kb-help-desc">✕ Fechar esta janela</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="kb-help-referencia-wrap">
          <div class="kb-help-section-label">Outros atalhos do sistema (referência — não editáveis por aqui)</div>
          <table class="kb-help-table">
            <tbody>${refRows}</tbody>
          </table>
        </div>
        <div class="kb-help-footer">
          Atalhos não disparam quando você está digitando em campos de texto.
        </div>
      </div>`;

    document.body.appendChild(modal);

    document.getElementById('kb-help-close')
      .addEventListener('click', _closeHelpModal);
    document.getElementById('kb-help-backdrop')
      .addEventListener('click', _closeHelpModal);
  }

  function _openHelpModal() {
    _buildHelpModal();
    const modal = document.getElementById('kb-help-modal');
    modal.classList.add('kb-help-visible');
    document.getElementById('kb-help-close')?.focus();
  }

  function _closeHelpModal() {
    document.getElementById('kb-help-modal')?.classList.remove('kb-help-visible');
  }

  function _isHelpModalOpen() {
    return document.getElementById('kb-help-modal')?.classList.contains('kb-help-visible');
  }

  /* ──────────────────────────────────────────────────────────
   * 9. LISTENER PRINCIPAL
   * ────────────────────────────────────────────────────────── */

  document.addEventListener('keydown', function (e) {
    // ── Captura de novo combo (tela de Configurações remapeando um atalho) ──
    // Tem prioridade sobre tudo o mais — enquanto este modo estiver ativo,
    // nenhum atalho de verdade deve disparar.
    if (_capturarCallback) {
      e.preventDefault();
      e.stopPropagation();
      const teclasPuras = ['Control', 'Alt', 'Shift', 'Meta'];
      if (teclasPuras.includes(e.key)) return; // só modificador ainda — espera a tecla final
      const cb = _capturarCallback;
      _capturarCallback = null;

      if (e.key === 'Escape') { cb(null); return; } // cancelou a captura

      const ehTeclaFuncao = /^F\d{1,2}$/.test(e.key); // F1-F12 podem ser usadas sozinhas
      const temModificador = e.ctrlKey || e.altKey || e.shiftKey;
      if (!temModificador && !ehTeclaFuncao) {
        cb({ erro: 'Use ao menos uma tecla modificadora (Ctrl, Alt ou Shift) — só uma tecla normal sozinha conflitaria com digitação.' });
        return;
      }
      cb({ combo: _comboFromEvent(e) });
      return;
    }

    // Fecha o modal de ajuda com Esc
    if (e.key === 'Escape' && _isHelpModalOpen()) {
      e.preventDefault();
      _closeHelpModal();
      return;
    }

    const combo = _comboFromEvent(e);

    // Não dispara em campos de texto, a menos que seja o comando de registrar (Ctrl+Enter)
    if (_isFocusedOnInput() && combo !== 'Ctrl+Enter') return;

    // ── Ajuda ──────────────────────────────────────────────
    if (e.key === 'F1' || (e.key === '?' && !e.ctrlKey && !e.altKey)) {
      e.preventDefault();
      _isHelpModalOpen() ? _closeHelpModal() : _openHelpModal();
      return;
    }

    // ── Navegação (combo customizável, padrão Alt + Dígito) ─
    const nav = NAV_CONFIG.find(n => _comboEfetivo(n.id, n.comboPadrao) === combo);
    if (nav) {
      e.preventDefault();
      _navigateTo(nav);
      return;
    }

    // Alt + ← / Alt + → — fixos, não remapeáveis (atalho de "anterior/próximo")
    if (e.altKey && !e.ctrlKey && !e.shiftKey) {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        _navigatePrev();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        _navigateNext();
        return;
      }
    }

    // ── Ações Genéricas (combo customizável) ────────────────
    const action = ACTION_CONFIG.find(a => _comboEfetivo(a.id, a.comboPadrao) === combo);
    if (action) {
      e.preventDefault();
      action.handler();
      return;
    }
  });

  /* ──────────────────────────────────────────────────────────
   * 10. ESTILOS INJETADOS
   * ────────────────────────────────────────────────────────── */

  const CSS = `
    /* ── Toast ───────────────────────────────────────────── */
    #kb-toast {
      position: fixed;
      bottom: 28px;
      left: 50%;
      transform: translateX(-50%) translateY(12px);
      background: var(--bg-card, #1e2229);
      border: 1px solid var(--border-2, #353c4a);
      border-radius: 8px;
      padding: 10px 20px;
      display: flex;
      align-items: center;
      gap: 10px;
      font-family: var(--font-body, 'Barlow', sans-serif);
      font-size: .88rem;
      color: var(--text, #e8eaf0);
      box-shadow: 0 8px 32px rgba(0,0,0,.55);
      z-index: 10000;
      opacity: 0;
      pointer-events: none;
      transition: opacity .18s ease, transform .18s ease;
      white-space: nowrap;
    }
    #kb-toast.kb-toast-visible {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .kb-toast-icon {
      font-size: 1.1rem;
    }

    /* ── Flash de destaque no menu ───────────────────────── */
    .nav-item.kb-active {
      background: rgba(245, 158, 11, 0.18) !important;
      border-left: 3px solid var(--accent, #f59e0b);
      transition: background .15s ease;
    }

    /* ── Modal de ajuda ──────────────────────────────────── */
    #kb-help-modal {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 10001;
      align-items: center;
      justify-content: center;
    }
    #kb-help-modal.kb-help-visible {
      display: flex;
    }
    .kb-help-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,.72);
    }
    .kb-help-box {
      position: relative;
      background: var(--bg-card, #1e2229);
      border: 1px solid var(--border-2, #353c4a);
      border-radius: 12px;
      width: 60%;
      max-width: 95vw;
      max-height: 88vh;
      overflow-y: auto;
      box-shadow: 0 24px 80px rgba(0,0,0,.65);
      display: flex;
      flex-direction: column;
    }
    .kb-help-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 24px 16px;
      border-bottom: 1px solid var(--border, #2a2f3a);
    }
    .kb-help-title {
      font-family: var(--font-display, 'Barlow Condensed', sans-serif);
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: .06em;
      text-transform: uppercase;
      color: var(--accent, #f59e0b);
    }
    .kb-help-close {
      background: none;
      border: none;
      color: var(--text-3, #5c6475);
      font-size: 1.2rem;
      cursor: pointer;
      line-height: 1;
      padding: 4px 6px;
      border-radius: 4px;
      transition: color .15s, background .15s;
    }
    .kb-help-close:hover {
      color: var(--text, #e8eaf0);
      background: var(--bg-3, #1a1e25);
    }
    .kb-help-body {
      padding: 20px 24px;
      flex: 1;
      display: flex;
      justify-content: space-around;
    }
    /* Bloco de referência (atalhos não-editáveis) — largura total, abaixo
       das 2 colunas de kb-help-body, mesmo respiro horizontal delas. */
    .kb-help-referencia-wrap {
      padding: 0 24px 4px;
      border-top: 1px solid var(--border, #2a2f3a);
      padding-top: 16px;
    }
    .kb-help-referencia-wrap .kb-help-table td:first-child {
      width: 30%;
      white-space: normal;
    }
    .kb-help-section-label {
      font-size: .68rem;
      text-transform: uppercase;
      letter-spacing: .1em;
      color: var(--text-3, #5c6475);
      margin-bottom: 10px;
      font-weight: 600;
    }
    .kb-help-table {
      width: 100%;
      border-collapse: collapse;
      font-family: var(--font-body, 'Barlow', sans-serif);
      font-size: .84rem;
    }
    .kb-help-table tr + tr td {
      border-top: 1px solid var(--border, #2a2f3a);
    }
    .kb-help-table td {
      padding: 9px 0;
      vertical-align: middle;
    }
    .kb-help-table td:first-child {
      width: 48%;
      white-space: nowrap;
    }
    .kb-help-desc {
      color: var(--text-2, #9aa3b2);
    }
    .kb-help-sem-atalho {
      color: var(--text-3, #5c6475);
      font-size: .74rem;
      font-style: italic;
    }
    .kb-help-footer {
      border-top: 1px solid var(--border, #2a2f3a);
      padding: 12px 24px;
      font-size: .76rem;
      color: var(--text-3, #5c6475);
      text-align: center;
    }

    /* ── Teclas <kbd> ────────────────────────────────────── */
    #kb-help-modal kbd {
      display: inline-block;
      padding: 2px 7px;
      font-family: var(--font-mono, 'JetBrains Mono', monospace);
      font-size: .74rem;
      font-weight: 500;
      color: var(--text, #e8eaf0);
      background: var(--bg-3, #1a1e25);
      border: 1px solid var(--border-2, #353c4a);
      border-radius: 4px;
      box-shadow: 0 2px 0 var(--bg, #0d0f12);
      line-height: 1.5;
    }
  `;

  const style = document.createElement('style');
  style.id = 'kb-shortcuts-styles';
  style.textContent = CSS;
  document.head.appendChild(style);

  /* ──────────────────────────────────────────────────────────
   * 11. API PÚBLICA (opcional, para integração futura)
   * ────────────────────────────────────────────────────────── */

  window.LWKeyboard = {
    /** Abre o modal de ajuda programaticamente */
    openHelp: _openHelpModal,
    /** Fecha o modal de ajuda */
    closeHelp: _closeHelpModal,
    /**
     * Registra um novo atalho de ação dinamicamente.
     * @param {string} comboPadrao  ex.: 'Ctrl+Shift+P'
     * @param {string} description
     * @param {string} icon
     * @param {Function} handler
     */
    registerAction(comboPadrao, description, icon, handler) {
      const id = 'acao_custom_' + description.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      ACTION_CONFIG.push({ id, comboPadrao, description, icon, handler });
    },

    // ---- API usada pela tela de Configurações → Atalhos de Teclado ----

    /** Lista todos os atalhos remapeáveis, já com o combo efetivo calculado. */
    listarAtalhos: _todosAtalhos,
    /** Lista os atalhos NÃO-editáveis catalogados só como referência/guia
     * (ver REFERENCIA_CONFIG, acima) — cada um vive de verdade em outra
     * tela; aqui é só a documentação central deles. */
    listarReferencia: () => REFERENCIA_CONFIG.slice(),
    /** Define um novo combo pra um atalho (por id). Se houver conflito,
     * devolve { ok:false, conflito } em vez de aplicar — passe
     * { substituirConflito: true } pra confirmar e liberar o atalho antigo. */
    definirAtalho: _definirAtalho,
    /** Restaura todos os atalhos pro padrão de fábrica. */
    resetarAtalhos: _resetarAtalhos,
    /** Liga o "modo de escuta" da próxima tecla — ver _capturarProximoCombo. */
    capturarProximoCombo: _capturarProximoCombo,
    /** Cancela uma captura em andamento (ex: ao fechar a tela sem terminar). */
    cancelarCaptura: _cancelarCaptura,
  };

  _carregarOverrides();
  console.log('[LWKeyboard] Atalhos globais carregados. Pressione F1 ou ? para ajuda.');
})();