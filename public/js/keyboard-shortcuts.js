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

  /** Atalhos de navegação: Alt + Dígito → página */
  const NAV_CONFIG = [
    { key: '1', page: 'operacao', label: 'Operação', icon: '⚙' },
    { key: '2', page: 'registro', label: 'Relatorio de Baterias', icon: '📋' },
    { key: '3', page: 'relatorio', label: 'Relatório de Injeção', icon: '🧾' },
    { key: '4', page: 'qualidade-tracos', label: 'Qualidade dos Traços', icon: '📐' },
    { key: '5', page: 'analise-operacional', label: 'Análise Operacional', icon: '📊' },
    { key: '6', page: 'turnos', label: 'Turnos', icon: '⏳' },
    { key: '7', page: 'menu', label: 'Menu Principal', icon: '⬡' },
    { key: '8', page: 'oee', label: 'OEE', icon: '🎯' },
  ];

  /**
   * Atalhos de ação genérica.
   * `handler` é o nome da função global ou uma função inline.
   * `description` aparece no modal de ajuda.
   */
  const ACTION_CONFIG = [
    {
      combo: 'Ctrl+Shift+F',
      description: 'Abrir painel de filtros',
      icon: '🔍',
      handler: () => _openFilterPanel(),
    },
    {
      combo: 'Ctrl+Shift+R',
      description: 'Atualizar dados',
      icon: '↺',
      handler: () => _refreshData(),
    },
    {
      combo: 'Ctrl+Shift+E',
      description: 'Exportar relatório',
      icon: '⬇',
      handler: () => _exportReport(),
    },
    {
      combo: 'Ctrl+Shift+A',
      description: 'Adicionar novo traço',
      icon: '➕',
      handler: () => _addNewTraco(),
    },
    {
      combo: 'Ctrl+Shift+D',
      description: 'Abrir Debriefing do Dia',
      icon: '📓',
      handler: () => _toggleDebriefing(),
    },
    {
      combo: 'Ctrl+Space',
      description: 'Iniciar/Finalizar cronômetro',
      icon: '▶',
      handler: () => _startInjectionTimer(),
    },
    {
      combo: 'Ctrl+R',
      description: 'Resetar operação',
      icon: '↺',
      handler: () => _resetOperation(),
    },
    {
      combo: 'Ctrl+Enter',
      description: 'Registrar operação',
      icon: '✓',
      handler: () => _registerOperation(),
    },
  ];

  /* ──────────────────────────────────────────────────────────
   * 2. ESTADO INTERNO
   * ────────────────────────────────────────────────────────── */

  /** Índice da página atual dentro de NAV_CONFIG */
  let _currentNavIndex = 0;

  /* ──────────────────────────────────────────────────────────
   * 3. UTILITÁRIOS
   * ────────────────────────────────────────────────────────── */

  /** Retorna true se o foco está em um campo de texto */
  function _isFocusedOnInput() {
    const tag = document.activeElement?.tagName?.toLowerCase();
    const type = (document.activeElement?.type || '').toLowerCase();
    const editable = document.activeElement?.isContentEditable;
    if (editable) return true;
    if (['textarea', 'select'].includes(tag)) return true;
    if (tag === 'input' && !['button', 'checkbox', 'radio', 'submit', 'reset'].includes(type)) return true;
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

  function _refreshData() {
    // Chama o init da página ativa, se disponível
    const active = document.querySelector('.main.active');
    const pageId = active?.id?.replace('page-', '');

    const refreshMap = {
      menu: () => null,
      operacao: () => typeof LWOp !== 'undefined' && LWOp.init?.(),
      turnos: () => typeof LWDash !== 'undefined' && LWDash.initTurnos?.(),
      registro: () => typeof LWDash !== 'undefined' && LWDash.initRegistro?.(),
      relatorio: () => typeof LWDash !== 'undefined' && LWDash.initRelatorio?.(),
      'analise-operacional': () => typeof AOp !== 'undefined' && AOp.render?.(),
      'qualidade-tracos': () => typeof LWQualidade !== 'undefined' && LWQualidade.render?.(),
    };

    const fn = refreshMap[pageId];
    if (fn) { fn(); _showToast('↺', 'Dados atualizados'); }
    else { _showToast('↺', 'Atualização não disponível'); }
  }

  function _exportReport() {
    // Tenta abrir o modal de exportação via LWDash
    if (typeof LWDash !== 'undefined' && typeof LWDash.abrirExportModal === 'function') {
      LWDash.abrirExportModal();
      _showToast('⬇', 'Exportar relatório');
    } else {
      _showToast('⬇', 'Exportação não disponível nesta tela');
    }
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

  function _startInjectionTimer() {
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

    // Se o botão de finalizar estiver habilitado (injeção em curso), finaliza
    if (btnFinalizar && !btnFinalizar.disabled) {
      btnFinalizar.click();
      _showToast('⏹', 'Injeção finalizada');
      return;
    }

    _showToast('⏹', 'Operação já finalizada ou indisponível');
  }

  /**
   * Reseta a operação atual na página de operação.
   * Funciona apenas se o usuário estiver na página 'operacao'.
   */
  function _resetOperation() {
    const active = document.querySelector('.main.active');
    const pageId = active?.id?.replace('page-', '');

    // O atalho funciona apenas se o usuário já estiver na página de operação
    if (pageId !== 'operacao') {
      _showToast('↺', 'Atalho disponível apenas na página de Operação');
      return;
    }

    const btnResetar = document.getElementById('btn-resetar');
    if (btnResetar && !btnResetar.disabled) {
      btnResetar.click();
      _showToast('↺', 'Operação resetada');
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
    if (document.getElementById('kb-help-modal')) return;

    const navRows = NAV_CONFIG.map(n =>
      `<tr>
        <td><kbd>Alt</kbd> + <kbd>${n.key}</kbd></td>
        <td class="kb-help-desc">${n.icon} ${n.label}</td>
      </tr>`
    ).join('');

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
      const parts = a.combo.split('+');
      const kbds = parts.map(p => `<kbd>${p}</kbd>`).join(' + ');
      return `<tr>
        <td>${kbds}</td>
        <td class="kb-help-desc">${a.icon} ${a.description}</td>
      </tr>`;
    }).join('');

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

    // ── Navegação Alt + Dígito ─────────────────────────────
    if (e.altKey && !e.ctrlKey && !e.shiftKey) {
      const nav = NAV_CONFIG.find(n => n.key === e.key);
      if (nav) {
        e.preventDefault();
        _navigateTo(nav);
        return;
      }

      // Alt + ← / Alt + →
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

    // ── Ações Genéricas (Combos dinâmicos) ──────────────────
    const action = ACTION_CONFIG.find(a => a.combo === combo);
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
     * @param {string} combo  ex.: 'Ctrl+Shift+P'
     * @param {string} description
     * @param {string} icon
     * @param {Function} handler
     */
    registerAction(combo, description, icon, handler) {
      ACTION_CONFIG.push({ combo, description, icon, handler });
    },
  };

  console.log('[LWKeyboard] Atalhos globais carregados. Pressione F1 ou ? para ajuda.');
})();