// ─── app-core.js ────────────────────────────────────────────────────────
// Extraído do <script> inline que ficava solto no meio do index.html
// (era o maior bloco de código do arquivo, ~2500 linhas, sem nome próprio).
// MESMO código de antes, só movido pra um arquivo externo — um <script
// src="..."> executa na mesma ordem/contexto que um <script> inline (sem
// defer/async em nenhum dos dois), então isso não muda nenhum
// comportamento, só organiza. Cobre: reautenticação ao voltar do bfcache,
// navegação entre páginas, modais (editar operação/traço, importação,
// backup/restauração, configurações), tema, e outras funções globais
// chamadas via onclick="..." no HTML.


    // ─── Re-exige a senha de admin se a página voltar do cache do navegador
    // (bfcache) já como Administrador — ex: deu F5/saiu, voltou pro login,
    // e alguém aperta "Avançar" no navegador depois. Sem isso, o navegador
    // restaura a tela exatamente como estava (ainda como Administrador),
    // sem passar pela senha de novo. Só entra em ação no caso de restauração
    // do cache (event.persisted) — um F5 normal como Administrador continua
    // sem pedir senha de novo, como já era de propósito (ver login.html).
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      if (sessionStorage.getItem('lw_role') !== 'Administrador') return;

      document.documentElement.style.visibility = 'hidden'; // esconde tudo até confirmar a senha
      if (typeof AdminAuth === 'undefined') { window.location.href = 'login.html'; return; }

      AdminAuth.abrirModal(
        function onSuccess() { document.documentElement.style.visibility = 'visible'; },
        function onCancel() {
          sessionStorage.removeItem('lw_role'); // não deixa 'Administrador' parado na sessão enquanto está no login
          window.location.href = 'login.html';
        }
      );
      // O modal herdaria visibility:hidden do <html> (ele não define a
      // própria visibility) e ficaria escondido junto com o resto da
      // página — força visible só nele, por cima da herança.
      const overlayAuth = document.getElementById('admin-auth-modal');
      if (overlayAuth) overlayAuth.style.visibility = 'visible';
    });

    // ---- Navigation ----
    // Páginas bloqueadas por perfil — Analista não acessa Registrar Operação,
    // mesmo navegando direto (atalho de teclado, URL, etc.), não só pela UI.
    const PAGINAS_BLOQUEADAS_POR_PERFIL = {
      'Analista': ['operacao'],
    };

    // Restaura, depois de um F5, a última página que a pessoa estava
    // vendo nesta aba (ver showPage, que grava sessionStorage a cada
    // navegação) — sem isso, todo refresh jogava de volta pro Menu,
    // mesmo no meio de um relatório/dashboard. Só chamada pros perfis que
    // não têm uma tela fixa de boot (Analista/Administrador — Operador
    // sempre volta pra Operação de propósito, ver comentário mais abaixo).
    function _restaurarUltimaPagina() {
      let pagina = null;
      try { pagina = sessionStorage.getItem('lw_ultima_pagina'); } catch (e) { /* sessionStorage indisponível — sem restauração, sem quebrar o boot */ }
      if (!pagina || pagina === 'menu') return; // já é o padrão (nenhum showPage() extra necessário)
      const bloqueadas = PAGINAS_BLOQUEADAS_POR_PERFIL[sessionStorage.getItem('lw_role')] || [];
      if (bloqueadas.includes(pagina)) return;
      if (!document.getElementById('page-' + pagina)) return; // versão salva antiga/página que não existe mais
      showPage(pagina);
    }

    // ---- Indicador global de operações pendentes (registro offline) ----
    function _atualizarIndicadorFilaPendentes(n) {
      const el = document.getElementById('topbar-fila-pendentes');
      const num = document.getElementById('topbar-fila-pendentes-num');
      if (!el || !num) return;
      num.textContent = n;
      el.style.display = n > 0 ? 'inline-flex' : 'none';
    }

    // Toast simples (não-bloqueante) avisando que operações pendentes
    // acabaram de ser sincronizadas com sucesso — pode acontecer em
    // qualquer página, não só na de Operação.
    function _mostrarToastSincronizacao(n) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;top:70px;right:24px;max-width:380px;z-index:1200;padding:14px 18px;border-radius:8px;font-size:.85rem;line-height:1.45;box-shadow:0 12px 32px rgba(0,0,0,.4);background:rgba(16,185,129,.15);border:1px solid var(--green-dim);color:var(--green);transition:opacity .3s';
      el.textContent = `✅ Conexão recuperada — ${n} operação${n > 1 ? 'ões' : ''} pendente${n > 1 ? 's' : ''} ${n > 1 ? 'foram' : 'foi'} registrada${n > 1 ? 's' : ''} com sucesso.`;
      document.body.appendChild(el);
      setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 350);
      }, 8000);
    }

    function showPage(pageId, navEl) {
      const role = sessionStorage.getItem('lw_role');
      const bloqueadas = PAGINAS_BLOQUEADAS_POR_PERFIL[role] || [];
      if (bloqueadas.includes(pageId)) return;

      // Lembra a página atual pra restaurar depois de um F5 (ver
      // _restaurarUltimaPagina, chamada no boot) — sessionStorage, não
      // localStorage: é só "continuar de onde parei nesta aba", não uma
      // preferência que deveria seguir pra outras abas/sessões futuras.
      try { sessionStorage.setItem('lw_ultima_pagina', pageId); } catch (e) { /* sessionStorage indisponível (modo privado etc.) — sem persistência, sem quebrar a navegação */ }

      // Log de acesso: registra só "Registrar Operação" por enquanto — é a
      // base pra, no futuro, restringir essa tela a um único computador.
      if (pageId === 'operacao') {
        LW.registrarAcesso('/operacao');
        // A lista de Configurações → Autorizados pode ter mudado desde o
        // boot da página (ex: admin acabou de autorizar este computador)
        // — reaplica a trava na hora de abrir a aba, sem precisar de F5.
        if (typeof LWOp !== 'undefined' && LWOp.atualizarTravaAutorizacao) LWOp.atualizarTravaAutorizacao();
      }

      document.querySelectorAll('.main').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

      document.getElementById('page-' + pageId).classList.add('active');

      if (navEl) {
        navEl.classList.add('active');
      } else {
        const btn = document.querySelector(`[data-page="${pageId}"]`);
        if (btn) btn.classList.add('active');
      }

      // Init page if needed
      if (pageId === 'dashboard' && !window._dashInit) {
        window._dashInit = true;
        LWDash.initDashboard();
      }
      if (pageId === 'turnos' && !window._turnosInit) {
        window._turnosInit = true;
        LWDash.initTurnos();
      }
      if (pageId === 'registro') {
        LWDash.initRegistro();
      }
      if (pageId === 'relatorio') {
        LWDash.initRelatorio();
      }
      if (pageId === 'dashboard') {
        // redraw charts on tab switch (canvas needs layout)
        setTimeout(() => LWDash.initDashboard(), 50);
      }
      if (pageId === 'analise-operacional' && !window._aoInit) {
        window._aoInit = true;
        AOp.init();
      } else if (pageId === 'analise-operacional') {
        AOp.render();
      }
      if (pageId === 'qualidade-tracos' && !window._qualidadeInit) {
        window._qualidadeInit = true;
        LWQualidade.init();
      }
      if (pageId === 'qualidade-tracos') {
        LWQualidade.render();
      }
      if (pageId === 'oee' && !window._oeeInit) {
        window._oeeInit = true;
        LWOee.init();
      }
      if (pageId === 'oee') {
        LWOee.render();
      }
      if (pageId === 'paradas' && !window._paradasInit) {
        window._paradasInit = true;
        LWParadas.init();
      } else if (pageId === 'paradas') {
        setTimeout(() => {
          LWParadas.aplicarFiltros();
        }, 50);
      }
      if (pageId === 'relatorio' && !window._relatorioInit) {
        window._relatorioInit = true;
        LWDash.initRelatorio();
      }
      if (pageId === 'relatorio-bercos' && !window._relatorioBercosInit) {
        window._relatorioBercosInit = true;
        LWBercos.init();
      } else if (pageId === 'relatorio-bercos') {
        LWBercos.render();
      }
      if (pageId === 'analise-bercos' && !window._analiseBercosInit) {
        window._analiseBercosInit = true;
        ABercos.init();
      } else if (pageId === 'analise-bercos') {
        ABercos.render();
      }
      // Análise Focada sempre re-renderiza (não só na 1ª vez) — cada
      // entrada é uma operação DIFERENTE (ver LWFocada.abrir, chamado
      // pelo modo de foco no Registro de Baterias), diferente das outras
      // páginas aqui que mostram sempre a mesma visão geral.
      if (pageId === 'analise-focada') {
        LWFocada.init();
      }
      // Setor de Qualidade — até pouco tempo rodava num <iframe> à parte
      // (setor-qualidade-app.html), que carregava e chamava SQ.init()
      // sozinho assim que o app subia, independente de qual página
      // estivesse ativa (o iframe nunca saía do DOM, só ficava escondido
      // por trás de .main{display:none}). Agora que é uma página normal
      // (ver public/partials/page-setor-qualidade.html), reproduz o
      // mesmo timing "só uma vez, na 1ª vez que abre" — mesmo padrão de
      // guarda usado por todas as outras páginas aqui.
      if (pageId === 'setor-qualidade' && !window._sqInit) {
        window._sqInit = true;
        SQ.init();
      }

      // Tour guiado automático no 1º acesso a cada página (ver tour.js) —
      // não faz nada se essa página não tem tour, ou se já foi visto antes
      // (guardado em localStorage). Roda por último, depois dos inits
      // acima, pra já achar a tabela/conteúdo carregado na hora de medir
      // a posição dos elementos.
      if (typeof LWTour !== 'undefined') LWTour.aoMudarPagina(pageId);
    }

    // ---- Tema ----
    (function () {
      const TEMA_KEY = 'lw_tema';

      // ── Catálogo de temas — adicione novos aqui no futuro ──────────────────
      const TEMAS = [
        { id: 'dark',     label: '🌙 Escuro',    attr: null },
        { id: 'light',    label: '☀️ Claro',     attr: 'light' },
        { id: 'lightwall',label: '🟧 Lightwall', attr: 'lightwall' },
      ];

      let _temaAtual = 'lightwall';
      let _dropdownAberto = false;

      // ── Aplica um tema ao <html> e atualiza o botão ─────────────────────────
      function _aplicarTema(id) {
        const tema = TEMAS.find(t => t.id === id) || TEMAS[0];
        _temaAtual = tema.id;

        if (tema.attr) {
          document.documentElement.setAttribute('data-theme', tema.attr);
        } else {
          document.documentElement.removeAttribute('data-theme');
        }

        const labelEl = document.getElementById('btn-tema-label');
        if (labelEl) labelEl.textContent = tema.label;

        // Marca o item ativo no dropdown
        document.querySelectorAll('.theme-option').forEach(el => {
          el.classList.toggle('theme-option--active', el.dataset.id === tema.id);
        });

        localStorage.setItem(TEMA_KEY, tema.id);
      }

      // ── Constrói os itens do dropdown dinamicamente ─────────────────────────
      function _buildDropdown() {
        const dropdown = document.getElementById('theme-dropdown');
        if (!dropdown) return;

        // Remove opções antigas (mantém o título)
        dropdown.querySelectorAll('.theme-option').forEach(el => el.remove());

        TEMAS.forEach(tema => {
          const btn = document.createElement('button');
          btn.className = 'theme-option';
          btn.dataset.id = tema.id;
          btn.textContent = tema.label;
          if (tema.id === _temaAtual) btn.classList.add('theme-option--active');
          btn.addEventListener('click', () => {
            _aplicarTema(tema.id);
            _fecharDropdown();
          });
          dropdown.appendChild(btn);
        });
      }

      // ── Abre / fecha o dropdown ─────────────────────────────────────────────
      function _abrirDropdown() {
        _buildDropdown();
        const dropdown = document.getElementById('theme-dropdown');
        const arrow    = document.getElementById('theme-arrow');
        if (dropdown) dropdown.classList.add('theme-dropdown--open');
        if (arrow)    arrow.style.transform = 'rotate(180deg)';
        _dropdownAberto = true;
      }

      function _fecharDropdown() {
        const dropdown = document.getElementById('theme-dropdown');
        const arrow    = document.getElementById('theme-arrow');
        if (dropdown) dropdown.classList.remove('theme-dropdown--open');
        if (arrow)    arrow.style.transform = '';
        _dropdownAberto = false;
      }

      window.toggleTemaDropdown = function () {
        _dropdownAberto ? _fecharDropdown() : _abrirDropdown();
      };

      // Fecha ao clicar fora
      document.addEventListener('click', (e) => {
        const picker = document.getElementById('theme-picker');
        if (picker && !picker.contains(e.target)) _fecharDropdown();
      });

      // Fecha com ESC
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') _fecharDropdown();
      });

      // ── Inicializa com o tema salvo ─────────────────────────────────────────
      const temaSalvo = localStorage.getItem(TEMA_KEY) || 'lightwall';
      _aplicarTema(TEMAS.find(t => t.id === temaSalvo) ? temaSalvo : 'lightwall');
    })();

    // ── "Dados SQL foram excluídos em outro dispositivo/aba" ────────────
    // Registrada em LW.aoReceberDadosSqlExcluidos (ver DOMContentLoaded,
    // abaixo) — dispara em QUALQUER página do app, não só quem está com
    // Configurações → Dados SQL aberta, porque a exclusão pode ter
    // afetado dados que aparecem em dashboards/relatórios que essa pessoa
    // esteja vendo agora.
    //
    // EXCEÇÃO: se houver uma operação REALMENTE em andamento (cronômetro
    // rodando — ver LWOp.operacaoEmAndamento, operacao.js) nesta aba, um
    // modal travando a tela + reload forçado atrapalharia quem está no
    // meio de registrar os traços — a exclusão quase sempre não tem nada
    // a ver com a operação dela. Nesse caso, só um toast discreto (não
    // bloqueia nada) avisa que existe uma atualização pendente; o reload
    // de verdade só acontece depois que a operação parar de estar
    // "running" (ver _agendarVerificacaoPosOperacao, abaixo) — os dados
    // da própria operação não se perdem nesse meio-tempo: são
    // sincronizados com o servidor (LW.getOperacaoAndamento), não só
    // locais, então o reload adiado continua de onde parou normalmente.
    let _sqlExcluidoPendente = null; // guarda a última msg recebida enquanto uma operação está rodando
    let _sqlExcluidoVerificandoPendencia = false; // evita empilhar vários setInterval concorrentes

    async function _aoReceberDadosSqlExcluidosDeOutroDispositivo(msg) {
      const emAndamento = (typeof LWOp !== 'undefined' && typeof LWOp.operacaoEmAndamento === 'function')
        ? LWOp.operacaoEmAndamento()
        : false;

      if (emAndamento) {
        _sqlExcluidoPendente = msg;
        _mostrarToastDadosSqlPendente(msg);
        _agendarVerificacaoPosOperacao();
        return;
      }

      await _confirmarEReceberDadosSqlExcluidos(msg);
    }

    // Modal de verdade (bloqueia até o OK) + reload — usado quando é
    // seguro interromper na hora (nenhuma operação rodando nesta aba).
    async function _confirmarEReceberDadosSqlExcluidos(msg) {
      const nomeTabela = (msg && msg.tabela) || 'dados do sistema';
      await LW.mostrarAlerta(
        `Um administrador excluiu dados de "${nomeTabela}" nesta instalação (em outro dispositivo/aba). A página será recarregada agora para atualizar as informações.`,
        { tipo: 'info', titulo: 'Dados atualizados' }
      );
      window.location.reload();
    }

    // Toast discreto (não-bloqueante, mesmo padrão de
    // _mostrarToastSincronizacao acima) — só avisa, não interrompe quem
    // está no meio de registrar uma operação.
    function _mostrarToastDadosSqlPendente(msg) {
      const nomeTabela = (msg && msg.tabela) || 'dados do sistema';
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;top:70px;right:24px;max-width:380px;z-index:1200;padding:14px 18px;border-radius:8px;font-size:.85rem;line-height:1.45;box-shadow:0 12px 32px rgba(0,0,0,.4);background:rgba(245,158,11,.15);border:1px solid var(--accent-dim);color:var(--accent);transition:opacity .3s';
      el.textContent = `ℹ️ Um administrador excluiu dados de "${nomeTabela}" em outro dispositivo. A página será atualizada automaticamente assim que esta operação for finalizada.`;
      document.body.appendChild(el);
      setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 350);
      }, 8000);
    }

    // Fica checando (a cada 3s) se a operação desta aba já deixou de
    // estar "running" — assim que isso acontecer, mostra o modal de
    // verdade e recarrega. Só existe 1 verificação ativa por vez
    // (_sqlExcluidoVerificandoPendencia evita duplicar o setInterval se
    // chegar mais de um broadcast enquanto ainda está rodando).
    function _agendarVerificacaoPosOperacao() {
      if (_sqlExcluidoVerificandoPendencia) return;
      _sqlExcluidoVerificandoPendencia = true;
      const intervalo = setInterval(() => {
        const aindaRodando = (typeof LWOp !== 'undefined' && typeof LWOp.operacaoEmAndamento === 'function')
          ? LWOp.operacaoEmAndamento()
          : false;
        if (aindaRodando) return;

        clearInterval(intervalo);
        _sqlExcluidoVerificandoPendencia = false;
        const msg = _sqlExcluidoPendente;
        _sqlExcluidoPendente = null;
        if (msg) _confirmarEReceberDadosSqlExcluidos(msg);
      }, 3000);
    }

    // ---- Boot ----
    document.addEventListener('DOMContentLoaded', async () => {
      // Set date in topbar and op form
      const now = nowBrasilia();
      document.getElementById('topbar-date').textContent = now.toLocaleDateString('pt-BR', {
        weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC'
      });
      const opDataVal = document.getElementById('op-data-val');
      if (opDataVal) opDataVal.value = now.toLocaleDateString('pt-BR', { timeZone: 'UTC' });

      // Init operation page
      LWOp.init();

      // ---- "Dados SQL foram excluídos em outro dispositivo" ────────────
      // Reusa o MESMO canal WebSocket que LWOp.init() acabou de abrir
      // (aberto uma vez só, aqui no boot, independente de qual página
      // está visível — ver conectarOperacaoAndamento, data.js) — só
      // registra o callback à parte, porque esse evento não é específico
      // da tela de Registrar Operação (ver aoReceberDadosSqlExcluidos,
      // data.js). Dispara em QUALQUER página/aba/computador que esteja
      // com o site aberto (exceto quem originou a exclusão, que já
      // recarrega sozinho — ver cfgSqlExcluirLinha, mais abaixo).
      LW.aoReceberDadosSqlExcluidos(_aoReceberDadosSqlExcluidosDeOutroDispositivo);

      // ---- Indicador global de operações pendentes (registro offline) ----
      // Fica visível em qualquer página, já que a sincronização pode
      // acontecer enquanto a pessoa navegou pra outra tela.
      _atualizarIndicadorFilaPendentes(LW.tamanhoFilaPendentes());
      LW.aoMudarFilaPendentes(_atualizarIndicadorFilaPendentes);
      LW.aoSincronizarPendentes(n => {
        _atualizarIndicadorFilaPendentes(LW.tamanhoFilaPendentes());
        _mostrarToastSincronizacao(n);
      });

      // ---- Controle de acesso por perfil ----
      const role = sessionStorage.getItem('lw_role');

      // Perfil ausente ou inválido (ex: sessionStorage adulterada) — volta
      // pro login em vez de deixar a tela sem nenhuma restrição aplicada.
      const PERFIS_VALIDOS = ['Operador', 'Analista', 'Administrador'];
      if (!PERFIS_VALIDOS.includes(role)) {
        sessionStorage.clear();
        window.location.href = 'login.html';
        return;
      }

      if (role === 'Operador') {
        // Esconde itens exclusivos do administrador (config, backup, import)
        document.querySelectorAll('[data-admin-only]').forEach(el => el.style.display = 'none');

        // Bloqueia acesso direto via showPage para páginas admin
        // Vai direto para a tela de operação
        showPage('operacao');

      } else if (role === 'Analista') {
        // Mesmas restrições do Operador (sem config/backup/import), e
        // também sem acesso à Operação — só dashboards e relatórios.
        document.querySelectorAll('[data-admin-only]').forEach(el => el.style.display = 'none');
        document.querySelectorAll('[data-hide-analista]').forEach(el => el.style.display = 'none');
        _restaurarUltimaPagina();

      } else if (role === 'Administrador') {
        // Verifica se a autenticação admin foi concluída corretamente
        if (!AdminAuth.isAutenticado()) {
          // Acesso indevido sem autenticação — retorna ao login
          sessionStorage.clear();
          window.location.href = 'login.html';
          return;
        }
        // Administrador: acesso total
        document.getElementById('btn-config').style.display = 'inline-flex';
        // Garante que itens admin e de operação estejam visíveis
        document.querySelectorAll('[data-admin-only]').forEach(el => el.style.display = '');
        document.querySelectorAll('[data-hide-analista]').forEach(el => el.style.display = '');
        _restaurarUltimaPagina();
      }

      const roleEl = document.getElementById('topbar-role');
      if (roleEl) roleEl.textContent = role || '';

      // Lógica do botão Sidebar
      const sidebar = document.querySelector('.sidebar');
      const backdrop = document.getElementById('sidebar-backdrop');
      const toggleBtn = document.getElementById('sidebar-toggle');

      const toggleSidebar = () => {
        const isExpanded = sidebar.classList.toggle('expanded');
        backdrop.classList.toggle('active', isExpanded);
      };

      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSidebar();
      });

      backdrop.addEventListener('click', () => {
        sidebar.classList.remove('expanded');
        backdrop.classList.remove('active');
      });

      // Fechar sidebar ao clicar em um item de navegação (melhor UX em mobile/overlay)
      document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
          sidebar.classList.remove('expanded');
          backdrop.classList.remove('active');
        });
      });
    });


    // ---- Importação de Histórico ----

    let _activeImportFields = [];
    const IMPORT_FIELDS = [
      { key: 'data', label: 'Data', required: true },
      { key: 'turno', label: 'Turno', required: true },
      { key: 'id_bateria', label: 'ID Bateria', required: true },
      { key: 'dimensao', label: 'Dimensão', required: true },
      { key: 'tipo_montagem', label: 'Tipo Montagem', required: true },
      { key: 'inicio', label: 'Hora Início', required: false },
      { key: 'fim', label: 'Hora Fim', required: false },
      { key: 'qtd_tracos', label: 'Qtd Traços', required: false },
      { key: 'houve_atraso', label: 'Houve Atraso', required: false },
      { key: 'motivo_atraso', label: 'Motivo Atraso', required: false },
      { key: 'total_paineis', label: 'Total Painéis', required: false },
      { key: 'paineis_2p', label: 'Painéis 2P', required: false },
      { key: 'paineis_sp', label: 'Painéis S/P', required: false },
      { key: 'm2_total', label: 'm² Total', required: false },
      { key: 'm2_2p', label: 'm² 2/P', required: false },
      { key: 'm2_sp', label: 'm² S/P', required: false },
      { key: 'bercos_reais', label: 'Berços Reais', required: false },
      { key: 'tempo_min', label: 'Tempo (min)', required: false },
      { key: 'placas_cimenticia', label: 'Placas Cimentícia', required: false },
    ];

    let _importSheetHeaders = [];
    let _importSheetRows = [];
    let _importRegistros = [];
    let _importDestino = null; // 'historico' | 'relatorio_injecao'

    function abrirImportacao() {
      if (sessionStorage.getItem('lw_role') !== 'Administrador') return;
      document.getElementById('import-modal').style.display = 'flex';
      resetImportModal();
    }

    function fecharImportacao() {
      document.getElementById('import-modal').style.display = 'none';
    }

    // ---- Painel "Backup e Restauração" (admin) ----
    function abrirBackupHub() {
      if (sessionStorage.getItem('lw_role') !== 'Administrador') return;
      const status = document.getElementById('backup-hub-status');
      if (status) status.style.display = 'none';
      document.getElementById('backup-hub-modal').style.display = 'flex';
      _carregarBackupsAutomaticos();
    }

    function fecharBackupHub() {
      document.getElementById('backup-hub-modal').style.display = 'none';
    }

    function _statusBackupHub(msg) {
      const status = document.getElementById('backup-hub-status');
      if (!status) return;
      if (msg) { status.textContent = msg; status.style.display = 'block'; }
      else { status.style.display = 'none'; }
    }

    // Lista os backups automáticos diários (gerados pelo próprio servidor,
    // todo fim de dia — ver server.js). Só leitura/download aqui; a criação
    // e a rotação (manter só os últimos 3) são feitas no servidor, sem
    // depender de ninguém com essa tela aberta.
    async function _carregarBackupsAutomaticos() {
      const el = document.getElementById('backup-hub-automaticos');
      if (!el) return;
      el.innerHTML = '<span style="color:var(--text-3);font-size:.82rem">Carregando...</span>';
      try {
        const res = await fetch('/backups-automaticos');
        const json = await res.json();
        if (!json.ok) throw new Error(json.erro || 'Erro ao listar backups automáticos.');

        if (!json.backups.length) {
          el.innerHTML = '<span style="color:var(--text-3);font-size:.82rem">Nenhum backup automático ainda — o primeiro é gerado no fim do dia de hoje.</span>';
          return;
        }

        el.innerHTML = json.backups.map(b => `
          <div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);padding:9px 14px">
            <span style="font-size:.84rem;color:var(--text-2)">📅 ${b.data.split('-').reverse().join('/')}
              <span style="color:var(--text-3);font-size:.74rem">(${(b.tamanho / 1024).toFixed(0)} KB)</span></span>
            <a href="/backups-automaticos/${encodeURIComponent(b.nome)}" style="color:var(--accent);font-size:.82rem;text-decoration:none">⬇ Baixar</a>
          </div>
        `).join('');
      } catch (e) {
        el.innerHTML = `<span style="color:var(--red);font-size:.82rem">Erro ao carregar: ${e.message}</span>`;
      }
    }

    // ---- Backup de Dados (admin) ----
    // A lógica de buscar os arquivos de public/db/ e montar o .zip vive em
    // LW.gerarBackupDados() (data.js) — aqui só cuidamos do feedback na tela.
    // O painel fica aberto durante a geração (pra mostrar o status) e só se
    // fecha depois que o download foi disparado com sucesso.
    async function fazerBackupDados() {
      if (sessionStorage.getItem('lw_role') !== 'Administrador') return;

      const card = document.getElementById('backup-hub-card-dados');

      try {
        if (card) card.style.pointerEvents = 'none';
        _statusBackupHub('Gerando backup de dados...');

        await LW.gerarBackupDados();
        fecharBackupHub();
      } catch (e) {
        LW.mostrarAlerta('Erro ao gerar backup: ' + e.message, { tipo: 'erro' });
      } finally {
        if (card) card.style.pointerEvents = '';
        _statusBackupHub(null);
      }
    }

    // ---- Backup Geral (admin) ----
    // Diferente do Backup de Dados, este .zip é montado no PRÓPRIO SERVIDOR
    // (rota GET /backup-geral) — ele varre o projeto inteiro (código + dados),
    // então não precisa que o front-end conheça cada arquivo de antemão.
    async function fazerBackupGeral() {
      if (sessionStorage.getItem('lw_role') !== 'Administrador') return;

      const card = document.getElementById('backup-hub-card-geral');

      try {
        if (card) card.style.pointerEvents = 'none';
        _statusBackupHub('Gerando backup geral... pode levar alguns segundos.');

        const res = await fetch('/backup-geral');
        if (!res.ok) throw new Error('HTTP ' + res.status);

        // Tenta usar o nome de arquivo sugerido pelo servidor; se não vier,
        // usa um nome padrão como fallback.
        const cd = res.headers.get('Content-Disposition') || '';
        const match = cd.match(/filename="(.+?)"/);
        const nomeArquivo = match ? match[1] : `lightwall_backup_geral_${todayBrasilia()}.zip`;

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = nomeArquivo;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        fecharBackupHub();
      } catch (e) {
        LW.mostrarAlerta('Erro ao gerar backup geral: ' + e.message, { tipo: 'erro' });
      } finally {
        if (card) card.style.pointerEvents = '';
        _statusBackupHub(null);
      }
    }

    // ---- Restaurar Backup de Dados (admin) ----
    // Mesma lista de arquivos do "Backup de Dados", com uma checagem mínima
    // de formato pra recusar arquivo errado/corrompido antes de mandar pro
    // servidor (que faz a MESMA validação de novo — nunca confiamos só no
    // que foi checado aqui no navegador).
    const RESTAURAR_VALIDACOES = {
      'config.json':            v => v && typeof v === 'object' && !Array.isArray(v),
      'contador_tracos.json':   v => v && typeof v === 'object' && !Array.isArray(v),
      'historico.json':          v => Array.isArray(v),
      'historico_edicoes.json': v => Array.isArray(v),
      'relatorio_injecao.json': v => Array.isArray(v),
      'relatorio_edicoes.json': v => Array.isArray(v),
      'security.json':           v => v && typeof v === 'object' && typeof v.passwordHash === 'string',
      'sobra.json':              v => v && typeof v === 'object',
      'paradas.json':            v => Array.isArray(v),
      'ajustes_tracos.json':    v => Array.isArray(v),
      // Adicionados junto com Berços Visuais e Avaliações do Setor de
      // Qualidade no Backup de Dados — mesma lista do servidor
      // (VALIDADORES_BACKUP_DADOS, em server.js).
      'bercos_visuais.json':       v => Array.isArray(v),
      'avaliacoes_qualidade.json': v => Array.isArray(v),
      // Adicionado: sem isso, esta cópia (client-side) ficava desatualizada
      // em relação a VALIDADORES_BACKUP_DADOS (server.js) — o navegador
      // nunca lia "operacoes_avaliadas.json" de dentro do .zip nem mandava
      // no payload pro servidor, que então recusava a restauração INTEIRA
      // com "Backup incompleto — faltam: operacoes_avaliadas.json" (o
      // servidor sempre exige todos os arquivos que ele mesmo valida,
      // ver esperados/faltando em /restaurar-backup-dados).
      'operacoes_avaliadas.json':  v => Array.isArray(v),
    };

    // Alguns desses arquivos legitimamente ficam vazios (0 bytes) até o app
    // inicializá-los — não tratamos isso como JSON inválido. config.json e
    // security.json ficam de fora de propósito (vazio ali é sempre um problema).
    const DEFAULT_SE_VAZIO_RESTAURAR = {
      'contador_tracos.json': {},
      'historico.json': [],
      'historico_edicoes.json': [],
      'relatorio_injecao.json': [],
      'relatorio_edicoes.json': [],
      'sobra.json': {},
      'paradas.json': [],
      'ajustes_tracos.json': [],
      'bercos_visuais.json': [],
      'avaliacoes_qualidade.json': [],
      'operacoes_avaliadas.json': [],
    };

    function parseArquivoRestaurar(nome, texto) {
      if (texto.trim() === '' && DEFAULT_SE_VAZIO_RESTAURAR.hasOwnProperty(nome)) {
        return DEFAULT_SE_VAZIO_RESTAURAR[nome];
      }
      return JSON.parse(texto);
    }

    let _restaurarArquivos = null; // { 'config.json': '<texto original>', ... } já validados

    function abrirRestaurarBackup() {
      if (sessionStorage.getItem('lw_role') !== 'Administrador') return;
      document.getElementById('restaurar-backup-modal').style.display = 'flex';
      resetRestaurarBackupModal();
    }

    function fecharRestaurarBackup() {
      document.getElementById('restaurar-backup-modal').style.display = 'none';
    }

    function resetRestaurarBackupModal() {
      _restaurarArquivos = null;
      document.getElementById('restaurar-step-0').style.display = 'block';
      document.getElementById('restaurar-step-1').style.display = 'none';
      document.getElementById('restaurar-erro').style.display = 'none';
      document.getElementById('restaurar-file-input').value = '';
      document.getElementById('restaurar-senha').value = '';
    }

    function voltarRestaurarStep0() {
      document.getElementById('restaurar-step-0').style.display = 'block';
      document.getElementById('restaurar-step-1').style.display = 'none';
    }

    function mostrarErroRestaurar(msg) {
      const el = document.getElementById('restaurar-erro');
      el.textContent = msg;
      el.style.display = 'block';
    }

    function handleRestaurarDrop(e) {
      e.preventDefault();
      e.currentTarget.style.borderColor = 'var(--border)';
      e.currentTarget.style.background = 'var(--bg-2)';
      const file = e.dataTransfer.files[0];
      if (file) handleRestaurarArquivo(file);
    }

    async function handleRestaurarArquivo(file) {
      document.getElementById('restaurar-erro').style.display = 'none';
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.zip')) {
        mostrarErroRestaurar('Selecione um arquivo .zip — o gerado pelo botão "Backup de Dados".');
        return;
      }

      try {
        const zip = await JSZip.loadAsync(file);
        const esperados = Object.keys(RESTAURAR_VALIDACOES);
        // Mesma lista de opcionais do servidor (ver OPCIONAIS_BACKUP_DADOS,
        // server.js) — um backup ANTIGO, de antes desses 3 arquivos
        // existirem, é válido mesmo sem eles; sem esta lista, o próprio
        // navegador já recusava o arquivo antes de chegar a enviar
        // qualquer coisa pro servidor.
        const OPCIONAIS = ['bercos_visuais.json', 'avaliacoes_qualidade.json', 'operacoes_avaliadas.json'];
        const obrigatorios = esperados.filter(n => !OPCIONAIS.includes(n));
        const faltando = obrigatorios.filter(nome => !zip.file(nome));
        if (faltando.length) {
          mostrarErroRestaurar('Arquivo de backup incompleto — faltam: ' + faltando.join(', '));
          return;
        }
        // Só os que realmente existem dentro deste .zip — um opcional
        // ausente simplesmente não é lido nem mandado pro servidor (que
        // por sua vez sabe que, faltando, é pra deixar aquela tabela como
        // já está, sem mexer nela).
        const presentes = esperados.filter(nome => !!zip.file(nome));

        const conteudos = {};
        const resumo = [];
        for (const nome of presentes) {
          const texto = await zip.file(nome).async('string');
          let valor;
          try {
            valor = parseArquivoRestaurar(nome, texto);
          } catch (e) {
            mostrarErroRestaurar(`"${nome}" não é um JSON válido.`);
            return;
          }
          if (!RESTAURAR_VALIDACOES[nome](valor)) {
            mostrarErroRestaurar(`"${nome}" não tem o formato esperado.`);
            return;
          }
          conteudos[nome] = texto;
          resumo.push(`• ${nome}: ${Array.isArray(valor) ? valor.length + ' registro(s)' : 'ok'}`);
        }
        // Avisa quais opcionais faltaram (backup mais antigo) — não bloqueia,
        // só deixa claro que essas tabelas não vão ser tocadas pela restauração.
        const opcionaisFaltando = OPCIONAIS.filter(n => !presentes.includes(n));
        if (opcionaisFaltando.length) {
          resumo.push(`<div style="margin-top:6px;color:var(--text-3)">⚠ Backup mais antigo — não tinha ainda: ${opcionaisFaltando.join(', ')} (essas tabelas não serão alteradas).</div>`);
        }

        _restaurarArquivos = conteudos;
        document.getElementById('restaurar-preview').innerHTML = resumo.map(l => `<div>${l}</div>`).join('');
        document.getElementById('restaurar-step-0').style.display = 'none';
        document.getElementById('restaurar-step-1').style.display = 'block';
      } catch (e) {
        mostrarErroRestaurar('Não foi possível ler o .zip: ' + e.message);
      }
    }

    async function confirmarRestaurarBackup() {
      if (!_restaurarArquivos) return;
      document.getElementById('restaurar-erro').style.display = 'none';

      const senha = document.getElementById('restaurar-senha').value;
      if (!senha) { mostrarErroRestaurar('Digite sua senha de administrador.'); return; }

      const confirmou = await LW.mostrarConfirmacao(
        'Isso vai substituir os dados atuais pelos deste backup. Uma cópia de segurança do estado atual será salva automaticamente antes.',
        { titulo: 'Restaurar backup de dados?', textoConfirmar: 'Restaurar', tipo: 'perigo', icon: '♻️' }
      );
      if (!confirmou) return;

      const btn = document.getElementById('restaurar-btn-confirmar');
      const textoOriginal = btn.textContent;
      try {
        btn.disabled = true;
        btn.textContent = 'Restaurando...';

        const res = await fetch('/restaurar-backup-dados', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ senha, arquivos: _restaurarArquivos }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.erro || 'Erro ao restaurar backup.');

        await LW.mostrarAlerta('Backup restaurado com sucesso! A página será recarregada.', { tipo: 'sucesso' });
        window.location.reload();
      } catch (e) {
        mostrarErroRestaurar(e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = textoOriginal;
      }
    }

    // ---- Mesclar Backup de Dados (admin) — de OUTRA instalação ----
    // Mesmo mecanismo de leitura/validação de .zip do Restaurar Backup de
    // Dados, mas só com os arquivos que fazem sentido SOMAR de outra
    // instalação (nunca config/security/sobra/contador — isso é estado
    // DESTA instalação). O servidor (/mesclar-backup-dados) é quem
    // garante, de fato, que nada existente é apagado — aqui é só
    // leitura/validação do arquivo antes de enviar.
    const MESCLAR_VALIDACOES = {
      'historico.json':         v => Array.isArray(v),
      'historico_edicoes.json': v => Array.isArray(v),
      'relatorio_injecao.json': v => Array.isArray(v),
      'ajustes_tracos.json':    v => Array.isArray(v),
      'paradas.json':           v => Array.isArray(v),
    };
    const MESCLAR_DEFAULT_SE_VAZIO = {
      'historico.json': [], 'historico_edicoes.json': [], 'relatorio_injecao.json': [],
      'ajustes_tracos.json': [], 'paradas.json': [],
    };
    const MESCLAR_LABELS = {
      'historico.json': 'Operações (Registro de Baterias)',
      'historico_edicoes.json': 'Histórico de edição de operações',
      'relatorio_injecao.json': 'Traços (Relatório de Injeção)',
      'ajustes_tracos.json': 'Ajustes de receita',
      'paradas.json': 'Paradas',
    };

    function parseArquivoMesclar(nome, texto) {
      if (texto.trim() === '' && MESCLAR_DEFAULT_SE_VAZIO.hasOwnProperty(nome)) {
        return MESCLAR_DEFAULT_SE_VAZIO[nome];
      }
      return JSON.parse(texto);
    }

    let _mesclarArquivos = null; // { 'historico.json': '<texto original>', ... } já validados

    function abrirMesclarBackup() {
      if (sessionStorage.getItem('lw_role') !== 'Administrador') return;
      document.getElementById('mesclar-backup-modal').style.display = 'flex';
      resetMesclarBackupModal();
    }

    function fecharMesclarBackup() {
      document.getElementById('mesclar-backup-modal').style.display = 'none';
    }

    function resetMesclarBackupModal() {
      _mesclarArquivos = null;
      document.getElementById('mesclar-step-0').style.display = 'block';
      document.getElementById('mesclar-step-1').style.display = 'none';
      document.getElementById('mesclar-step-2').style.display = 'none';
      document.getElementById('mesclar-erro').style.display = 'none';
      document.getElementById('mesclar-file-input').value = '';
      document.getElementById('mesclar-senha').value = '';
    }

    function voltarMesclarStep0() {
      document.getElementById('mesclar-step-0').style.display = 'block';
      document.getElementById('mesclar-step-1').style.display = 'none';
    }

    function mostrarErroMesclar(msg) {
      const el = document.getElementById('mesclar-erro');
      el.textContent = msg;
      el.style.display = 'block';
    }

    function handleMesclarDrop(e) {
      e.preventDefault();
      e.currentTarget.style.borderColor = 'var(--border)';
      e.currentTarget.style.background = 'var(--bg-2)';
      const file = e.dataTransfer.files[0];
      if (file) handleMesclarArquivo(file);
    }

    async function handleMesclarArquivo(file) {
      document.getElementById('mesclar-erro').style.display = 'none';
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.zip')) {
        mostrarErroMesclar('Selecione um arquivo .zip — o gerado pelo botão "Backup de Dados", na OUTRA instalação.');
        return;
      }

      try {
        const zip = await JSZip.loadAsync(file);
        // Diferente do Restaurar (que exige TODOS os 9 arquivos), aqui só
        // processa os que existirem dentre os mescláveis — um backup só com
        // relatório de injeção, por exemplo, ainda é válido pra mesclar.
        const presentes = Object.keys(MESCLAR_VALIDACOES).filter(nome => !!zip.file(nome));
        if (!presentes.length) {
          mostrarErroMesclar('Nenhum arquivo mesclável encontrado neste .zip (historico.json, relatorio_injecao.json, ajustes_tracos.json ou paradas.json).');
          return;
        }

        const conteudos = {};
        const resumo = [];
        for (const nome of presentes) {
          const texto = await zip.file(nome).async('string');
          let valor;
          try {
            valor = parseArquivoMesclar(nome, texto);
          } catch (e) {
            mostrarErroMesclar(`"${nome}" não é um JSON válido.`);
            return;
          }
          if (!MESCLAR_VALIDACOES[nome](valor)) {
            mostrarErroMesclar(`"${nome}" não tem o formato esperado.`);
            return;
          }
          conteudos[nome] = texto;
          resumo.push(`• ${MESCLAR_LABELS[nome]}: ${valor.length} registro(s)`);
        }

        _mesclarArquivos = conteudos;
        document.getElementById('mesclar-preview').innerHTML = resumo.map(l => `<div>${l}</div>`).join('');
        document.getElementById('mesclar-step-0').style.display = 'none';
        document.getElementById('mesclar-step-1').style.display = 'block';
      } catch (e) {
        mostrarErroMesclar('Não foi possível ler o .zip: ' + e.message);
      }
    }

    async function confirmarMesclarBackup() {
      if (!_mesclarArquivos) return;
      document.getElementById('mesclar-erro').style.display = 'none';

      const senha = document.getElementById('mesclar-senha').value;
      if (!senha) { mostrarErroMesclar('Digite sua senha de administrador.'); return; }

      const confirmou = await LW.mostrarConfirmacao(
        'Isso vai ADICIONAR os registros deste backup aos dados atuais. Nada do que já existe aqui será apagado ou alterado.',
        { titulo: 'Mesclar backup de dados?', textoConfirmar: 'Mesclar', icon: '🔗' }
      );
      if (!confirmou) return;

      const btn = document.getElementById('mesclar-btn-confirmar');
      const textoOriginal = btn.textContent;
      try {
        btn.disabled = true;
        btn.textContent = 'Mesclando...';

        const res = await fetch('/mesclar-backup-dados', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ senha, arquivos: _mesclarArquivos }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.erro || 'Erro ao mesclar backup.');

        const r = json.resultado;
        const linhas = [];
        if (r.operacoes.inseridos || r.operacoes.duplicatas) {
          linhas.push(`Operações: <strong>${r.operacoes.inseridos} adicionadas</strong>, ${r.operacoes.duplicatas} já existiam aqui`);
        }
        if (r.tracos.inseridos || r.tracos.duplicatas) {
          linhas.push(`Traços: <strong>${r.tracos.inseridos} adicionados</strong>, ${r.tracos.duplicatas} já existiam aqui`);
        }
        if (r.paradas.inseridos || r.paradas.duplicatas) {
          linhas.push(`Paradas: <strong>${r.paradas.inseridos} adicionadas</strong>, ${r.paradas.duplicatas} já existiam aqui`);
        }
        if (r.edicoes_operacao.inseridos) {
          linhas.push(`Histórico de edição: <strong>${r.edicoes_operacao.inseridos}</strong> registro(s)`);
        }
        if (!linhas.length) linhas.push('Nenhum registro novo encontrado — tudo neste backup já existia aqui.');

        document.getElementById('mesclar-step-1').style.display = 'none';
        document.getElementById('mesclar-step-2').style.display = 'block';
        document.getElementById('mesclar-resultado').innerHTML = linhas.map(l => `<div>${l}</div>`).join('');
      } catch (e) {
        mostrarErroMesclar(e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = textoOriginal;
      }
    }

    // ---- Restaurar Backup Geral (admin) ----
    // Mesmas ideias do Restaurar Backup de Dados, com camadas extras dado o
    // risco maior: frase de confirmação explícita, e o backup pode conter
    // QUALQUER arquivo do projeto (não uma lista fixa como o de dados).
    const ESSENCIAIS_BACKUP_GERAL = ['server.js', 'package.json', 'public/index.html'];

    let _restaurarGeralArquivos = null; // { 'server.js': '<conteúdo>', ... } já lidos do .zip

    function abrirRestaurarGeral() {
      if (sessionStorage.getItem('lw_role') !== 'Administrador') return;
      document.getElementById('restaurar-geral-modal').style.display = 'flex';
      resetRestaurarGeralModal();
    }

    function fecharRestaurarGeral() {
      document.getElementById('restaurar-geral-modal').style.display = 'none';
    }

    function resetRestaurarGeralModal() {
      _restaurarGeralArquivos = null;
      document.getElementById('restaurar-geral-step-0').style.display = 'block';
      document.getElementById('restaurar-geral-step-1').style.display = 'none';
      document.getElementById('restaurar-geral-erro').style.display = 'none';
      document.getElementById('restaurar-geral-file-input').value = '';
      document.getElementById('restaurar-geral-frase').value = '';
      document.getElementById('restaurar-geral-senha').value = '';
      document.getElementById('restaurar-geral-btn-confirmar').disabled = true;
    }

    function voltarRestaurarGeralStep0() {
      document.getElementById('restaurar-geral-step-0').style.display = 'block';
      document.getElementById('restaurar-geral-step-1').style.display = 'none';
    }

    function mostrarErroRestaurarGeral(msg) {
      const el = document.getElementById('restaurar-geral-erro');
      el.textContent = msg;
      el.style.display = 'block';
    }

    function handleRestaurarGeralDrop(e) {
      e.preventDefault();
      e.currentTarget.style.borderColor = 'var(--border)';
      e.currentTarget.style.background = 'var(--bg-2)';
      const file = e.dataTransfer.files[0];
      if (file) handleRestaurarGeralArquivo(file);
    }

    // O botão só fica liberado quando a frase E a senha estão preenchidas —
    // mais um obstáculo deliberado antes de uma ação tão destrutiva.
    function validarBotaoRestaurarGeral() {
      const frase = document.getElementById('restaurar-geral-frase').value;
      const senha = document.getElementById('restaurar-geral-senha').value;
      document.getElementById('restaurar-geral-btn-confirmar').disabled = !(frase === 'RESTAURAR TUDO' && senha);
    }

    async function handleRestaurarGeralArquivo(file) {
      document.getElementById('restaurar-geral-erro').style.display = 'none';
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.zip')) {
        mostrarErroRestaurarGeral('Selecione um arquivo .zip — o gerado pelo botão "Backup Geral".');
        return;
      }

      try {
        const zip = await JSZip.loadAsync(file);

        const faltando = ESSENCIAIS_BACKUP_GERAL.filter(nome => !zip.file(nome));
        if (faltando.length) {
          mostrarErroRestaurarGeral('Isso não parece ser um Backup Geral — faltam: ' + faltando.join(', ') +
            '. Você selecionou um Backup de Dados por engano?');
          return;
        }

        const conteudos = {};
        let tamanhoTotal = 0;
        const caminhos = [];
        for (const [nome, entry] of Object.entries(zip.files)) {
          if (entry.dir) continue;
          const texto = await entry.async('string');
          conteudos[nome] = texto;
          tamanhoTotal += texto.length;
          caminhos.push(nome);
        }
        caminhos.sort();

        if (caminhos.length > 500) {
          mostrarErroRestaurarGeral('Backup com número de arquivos suspeito (>500) — recusado por segurança.');
          return;
        }

        _restaurarGeralArquivos = conteudos;
        document.getElementById('restaurar-geral-resumo').textContent =
          `${caminhos.length} arquivo(s) — ${(tamanhoTotal / 1024).toFixed(0)} KB`;
        document.getElementById('restaurar-geral-preview').innerHTML =
          caminhos.map(c => `<div>${c}</div>`).join('');

        document.getElementById('restaurar-geral-step-0').style.display = 'none';
        document.getElementById('restaurar-geral-step-1').style.display = 'block';
        validarBotaoRestaurarGeral();
      } catch (e) {
        mostrarErroRestaurarGeral('Não foi possível ler o .zip: ' + e.message);
      }
    }

    async function confirmarRestaurarGeral() {
      if (!_restaurarGeralArquivos) return;
      document.getElementById('restaurar-geral-erro').style.display = 'none';

      const frase = document.getElementById('restaurar-geral-frase').value;
      const senha = document.getElementById('restaurar-geral-senha').value;
      if (frase !== 'RESTAURAR TUDO' || !senha) return;

      const confirmouGeral = await LW.mostrarConfirmacao(
        'Isso vai substituir TODO o código e os dados do sistema pelos deste backup, e vai exigir reiniciar o ' +
        'servidor manualmente depois. Uma cópia de segurança completa do estado atual será salva automaticamente antes.',
        { titulo: 'ÚLTIMA CONFIRMAÇÃO', textoConfirmar: 'Restaurar Tudo', tipo: 'perigo', icon: '⚠️' }
      );
      if (!confirmouGeral) return;

      const btn = document.getElementById('restaurar-geral-btn-confirmar');
      const textoOriginal = btn.textContent;
      try {
        btn.disabled = true;
        btn.textContent = 'Restaurando...';

        const res = await fetch('/restaurar-backup-geral', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ senha, confirmacao: frase, arquivos: _restaurarGeralArquivos }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.erro || 'Erro ao restaurar backup geral.');

        await LW.mostrarAlerta(
          `Backup geral restaurado com sucesso (${json.arquivosRestaurados} arquivos)!\n\n` +
          `IMPORTANTE: reinicie o servidor agora manualmente (Ctrl+C e "npm start", ou "pm2 restart") para que ` +
          `mudanças no código do servidor tenham efeito.\n\n` +
          `Cópia de segurança do estado anterior salva em: ${json.backupSeguranca}`,
          { tipo: 'sucesso' }
        );
        window.location.reload();
      } catch (e) {
        mostrarErroRestaurarGeral(e.message);
        btn.disabled = false;
        btn.textContent = textoOriginal;
      }
    }

    function escolherDestino(destino) {
      _importDestino = destino;
      // Ajusta o título e os campos de mapeamento conforme o destino
      const titulo = destino === 'historico'
        ? '📥 IMPORTAR — Relatorio de Baterias'
        : '📥 IMPORTAR — RELATÓRIO DE INJEÇÃO';
      document.getElementById('import-modal-titulo').textContent = titulo;

      // Redefine IMPORT_FIELDS dinamicamente conforme destino
      if (destino === 'relatorio_injecao') {
        _activeImportFields = [
          { key: 'data', label: 'Data', required: true },
          { key: 'id_bateria', label: 'ID Bateria', required: true },
          { key: 'num_traco', label: 'Nº Traço', required: false },
          { key: 'berco_ini', label: 'Berço Início', required: false },
          { key: 'berco_fim', label: 'Berço Fim', required: false },
          { key: 'densidade', label: 'Densidade', required: false },
          { key: 'flow', label: 'Flow', required: false },
          { key: 'densidade_eps', label: 'Densidade EPS', required: false },
          { key: 'obs', label: 'Observação', required: false },
          { key: 'silo', label: 'Silo EPS', required: false },
          { key: 'expansao', label: 'Expansão', required: false },
        ];
      } else {
        // Campos fixos + campos dinâmicos para qualquer tipo de montagem que
        // não seja 2p/sp (ex: 3t, 4t) — assim, se a planilha tiver colunas
        // específicas pra esses tipos, dá pra mapeá-las; senão, ficam apenas
        // como campos opcionais não preenchidos.
        const NATIVOS_IMPORT = new Set(['2p', 'sp']);
        const tiposExtrasImport = new Set();
        Object.values(LW.MONTAGEM_MAP || {}).forEach(m => {
          Object.keys(m.porBerco || {}).forEach(t => { if (!NATIVOS_IMPORT.has(t)) tiposExtrasImport.add(t); });
        });
        const camposExtrasImport = [];
        tiposExtrasImport.forEach(tipo => {
          const label = tipo.toUpperCase();
          camposExtrasImport.push({ key: `paineis_${tipo}`, label: `Painéis ${label}`, required: false });
          camposExtrasImport.push({ key: `m2_${tipo}`, label: `m² ${label}`, required: false });
        });
        _activeImportFields = [...IMPORT_FIELDS, ...camposExtrasImport]; // campos originais do historico + dinâmicos
      }

      // Atualiza label de destino visível no step-1
      const labelEl = document.getElementById('import-destino-label');
      if (labelEl) {
        labelEl.textContent = destino === 'historico'
          ? 'Destino: Relatorio de Baterias (db/historico.json)'
          : 'Destino: Relatório de Injeção (db/relatorio_injecao.json)';
        labelEl.style.color = destino === 'historico' ? 'var(--accent)' : 'var(--blue)';
      }
      document.getElementById('import-step-0').style.display = 'none';
      document.getElementById('import-step-1').style.display = 'block';
    }

    function resetImportModal() {
      _importDestino = null;
      _importSheetHeaders = [];
      _importSheetRows = [];
      _importRegistros = [];
      document.getElementById('import-step-0').style.display = 'block';
      document.getElementById('import-step-1').style.display = 'none';
      document.getElementById('import-step-2').style.display = 'none';
      document.getElementById('import-step-3').style.display = 'none';
      document.getElementById('import-mapping-area').style.display = 'none';
      document.getElementById('import-file-input').value = '';
      _importSheetHeaders = [];
      _importSheetRows = [];
      _importRegistros = [];
    }

    function voltarParaStep1() {
      document.getElementById('import-step-1').style.display = 'block';
      document.getElementById('import-step-2').style.display = 'none';
    }

    function handleImportDrop(e) {
      e.preventDefault();
      const dz = document.getElementById('import-dropzone');
      dz.style.borderColor = 'var(--border)';
      dz.style.background = 'var(--bg-2)';
      const file = e.dataTransfer.files[0];
      if (file) handleImportFile(file);
    }

    function handleImportFile(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function (e) {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array', cellDates: true });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
          if (!rows.length) { LW.mostrarAlerta('Planilha vazia ou sem dados reconhecíveis.', { tipo: 'aviso' }); return; }

          _importSheetHeaders = Object.keys(rows[0]);
          _importSheetRows = rows;

          document.getElementById('import-dropzone').innerHTML =
            '<div style="font-size:2rem;margin-bottom:8px">📄</div>' +
            '<div style="color:var(--accent);font-weight:600">' + file.name + '</div>' +
            '<div style="color:var(--text-3);font-size:.82rem;margin-top:4px">' + rows.length + ' linhas encontradas — clique para trocar o arquivo</div>';

          renderMappingGrid();
          document.getElementById('import-mapping-area').style.display = 'block';
        } catch (err) {
          LW.mostrarAlerta('Erro ao ler o arquivo: ' + err.message, { tipo: 'erro' });
        }
      };
      reader.readAsArrayBuffer(file);
    }

    function renderMappingGrid() {
      const grid = document.getElementById('import-mapping-grid');
      const opts = ['— ignorar —', ..._importSheetHeaders];

      grid.innerHTML = _activeImportFields.map(f => {
        const guess = _importSheetHeaders.find(h =>
          h.toLowerCase().replace(/[\s_\-]/g, '').includes(f.key.replace(/_/g, '')) ||
          h.toLowerCase().includes(f.label.toLowerCase().split(' ')[0])
        ) || '';

        const optsHtml = opts.map(o => '<option value="' + o + '"' + (o === guess ? ' selected' : '') + '>' + o + '</option>').join('');
        return '<div style="display:flex;flex-direction:column;gap:4px">' +
          '<label style="font-size:.78rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">' +
          f.label + (f.required ? ' <span style="color:var(--accent)">*</span>' : '') + '</label>' +
          '<select class="form-select" style="font-size:.82rem;padding:6px 10px" data-field="' + f.key + '">' +
          optsHtml + '</select></div>';
      }).join('');
    }

    function excelSerialToISO(val) {
      if (val instanceof Date) return val.toISOString();
      if (typeof val === 'number') {
        const ms = (val - 25569) * 86400 * 1000;
        return new Date(ms).toISOString();
      }
      if (typeof val === 'string' && val.trim()) {
        const d = new Date(val.trim());
        if (!isNaN(d)) return d.toISOString();
      }
      return null;
    }

    function gerarPreview() {
      const mapa = {};
      document.querySelectorAll('#import-mapping-grid select[data-field]').forEach(sel => {
        const field = sel.getAttribute('data-field');
        const col = sel.value;
        if (col && col !== '— ignorar —') mapa[field] = col;
      });

      const faltando = _activeImportFields.filter(f => f.required && !mapa[f.key]).map(f => f.label);
      if (faltando.length) { LW.mostrarAlerta('Mapeie os campos obrigatórios: ' + faltando.join(', '), { tipo: 'aviso' }); return; }

      const erros = [];
      if (_importDestino === 'relatorio_injecao') {
        // Monta linhas no formato do relatorio_injecao.json
        _importRegistros = _importSheetRows.map((row, i) => {
          const dataISO = excelSerialToISO(row[mapa['data']]);
          if (!dataISO) erros.push('Linha ' + (i + 2) + ': data inválida');
          return {
            id_operacao: 'imp_' + nowBrasilia().getTime() + '_' + i,
            data: dataISO ? dataISO.split('T')[0] : '',
            id_bateria: mapa['id_bateria'] ? String(row[mapa['id_bateria']]).trim() : '',
            turno: mapa['turno'] ? String(row[mapa['turno']]).trim() : '',
            num_traco: mapa['num_traco'] ? parseInt(row[mapa['num_traco']]) || 1 : 1,
            berco_ini: mapa['berco_ini'] ? String(row[mapa['berco_ini']]).trim() : '',
            berco_fim: mapa['berco_fim'] ? String(row[mapa['berco_fim']]).trim() : '',
            densidade: mapa['densidade'] ? String(row[mapa['densidade']]).trim() : '',
            flow: mapa['flow'] ? String(row[mapa['flow']]).trim() : '',
            densidade_eps: mapa['densidade_eps'] ? String(row[mapa['densidade_eps']]).trim() : '',
            obs: mapa['obs'] ? String(row[mapa['obs']]).trim() : '',
            silo: mapa['silo'] ? String(row[mapa['silo']]).trim() : '',
            expansao: mapa['expansao'] ? String(row[mapa['expansao']]).trim() : '',
            cimento: mapa['cimento'] ? String(row[mapa['cimento']]).trim() : '',
            agua: mapa['agua_real'] ? String(row[mapa['agua_real']]).trim() : '',
            superplast: mapa['superplast_real'] ? String(row[mapa['superplast_real']]).trim() : '',
            incorporador: mapa['incorporador_real'] ? String(row[mapa['incorporador_real']]).trim() : '',
            tempo_batida: mapa['tempo_batida'] ? parseFloat(row[mapa['tempo_batida']]) || 0 : 0
          };
        });
      } else {
        _importRegistros = _importSheetRows.map((row, i) => {
          const dataISO = excelSerialToISO(row[mapa['data']]);
          if (!dataISO) erros.push('Linha ' + (i + 2) + ': data inválida ("' + row[mapa['data']] + '")');
          const inicioISO = mapa['inicio'] ? excelSerialToISO(row[mapa['inicio']]) : null;
          const fimISO = mapa['fim'] ? excelSerialToISO(row[mapa['fim']]) : null;
          let tempoMin = 0;
          if (mapa['tempo_min'] && row[mapa['tempo_min']]) {
            tempoMin = parseFloat(row[mapa['tempo_min']]) || 0;
          } else if (inicioISO && fimISO) {
            tempoMin = (new Date(fimISO) - new Date(inicioISO)) / 60000;
          }
          const dimensao = mapa['dimensao'] ? String(row[mapa['dimensao']]) : '';
          const idBateria = mapa['id_bateria'] ? String(row[mapa['id_bateria']]).trim() : '';
          // Busca berços primeiro pela bateria (nova estrutura), depois pela dimensão (retrocompat)
          const bateriaObj = LW.BATERIA_IDS.find(b => b.id === idBateria);
          const dimObj = LW.DIMENSAO_OPTS.find(d => d.label === dimensao.trim());
          const capacidade = (bateriaObj?.bercos) || (dimObj?.bercos) || 0;
          const houve = mapa['houve_atraso'] ? String(row[mapa['houve_atraso']]).trim().toUpperCase() : 'NAO';

          // Monta paineis_por_tipo/m2_por_tipo genericamente a partir de QUALQUER
          // campo mapeado no formato paineis_<tipo> / m2_<tipo> — cobre 2p/sp
          // nativos e qualquer tipo extra (3t, 4t, ...) que tenha sido mapeado,
          // em vez de só olhar pra paineis_2p/paineis_sp.
          const paineis_por_tipo = {};
          const m2_por_tipo = {};
          Object.keys(mapa).forEach(campo => {
            if (campo === 'total_paineis' || campo === 'm2_total') return; // são o total geral, não por tipo
            let m = campo.match(/^paineis_(.+)$/);
            if (m) { paineis_por_tipo[m[1]] = parseInt(row[mapa[campo]]) || 0; return; }
            m = campo.match(/^m2_(.+)$/);
            if (m) { m2_por_tipo[m[1]] = parseFloat(row[mapa[campo]]) || 0; }
          });

          // Total: usa a coluna explícita de total se ela foi mapeada; senão,
          // deriva somando os tipos que FORAM mapeados — assim uma planilha só
          // com colunas por tipo (sem uma coluna de "Total") não fica com o
          // total zerado.
          const somaPaineisTipos = Object.values(paineis_por_tipo).reduce((s, v) => s + v, 0);
          const somaM2Tipos = Object.values(m2_por_tipo).reduce((s, v) => s + v, 0);
          const total_paineis = mapa['total_paineis'] ? (parseInt(row[mapa['total_paineis']]) || 0) : somaPaineisTipos;
          const m2_total = mapa['m2_total'] ? (parseFloat(row[mapa['m2_total']]) || 0) : somaM2Tipos;

          return {
            id: 'imp_' + nowBrasilia().getTime() + '_' + i,
            data: dataISO ? dataISO.split('T')[0] : '',
            turno: mapa['turno'] ? String(row[mapa['turno']]).trim() : '',
            dimensao: dimensao.trim(),
            capacidade,
            id_bateria: idBateria,
            inicio: inicioISO || '',
            fim: fimISO || '',
            qtd_tracos: mapa['qtd_tracos'] ? parseInt(row[mapa['qtd_tracos']]) || 0 : 0,
            houve_atraso: houve === 'SIM' ? 'SIM' : 'NÃO',
            motivo_atraso: mapa['motivo_atraso'] ? String(row[mapa['motivo_atraso']]).trim() : '',
            tipo_montagem: mapa['tipo_montagem'] ? String(row[mapa['tipo_montagem']]).trim() : '',
            total_paineis,
            paineis_por_tipo,
            m2_total,
            m2_por_tipo,
            // Aliases de compatibilidade (sempre presentes, mesmo que 0):
            paineis_2p: paineis_por_tipo['2p'] || 0,
            paineis_sp: paineis_por_tipo['sp'] || 0,
            m2_2p: m2_por_tipo['2p'] || 0,
            m2_sp: m2_por_tipo['sp'] || 0,
            bercos_reais: mapa['bercos_reais'] ? parseInt(row[mapa['bercos_reais']]) || capacidade : capacidade,
            tempo_min: tempoMin,
            // Cimentícia: usa a coluna explícita se mapeada; senão, deriva
            // pela MESMA regra configurável usada em calcPaineis() (data.js) —
            // soma, por tipo, painéis × cimentícia configurada pra aquele tipo.
            // Antes era fixo em paineis_2p*2; agora respeita o que foi
            // cadastrado na tela de admin pra cada tipo (2p, sp, 3t, 4t, ...).
            placas_cimenticia: mapa['placas_cimenticia']
              ? (parseInt(row[mapa['placas_cimenticia']]) || 0)
              : Object.keys(paineis_por_tipo).reduce((soma, tipo) => {
                  const c = (LW.CIMENTICIA_POR_TIPO || {})[tipo];
                  return soma + (c && c.leva ? paineis_por_tipo[tipo] * (c.quantidade || 0) : 0);
                }, 0),
          };
        });
      }

      const cols = _importDestino === 'relatorio_injecao'
        ? ['data', 'id_bateria', 'num_traco', 'berco_ini', 'berco_fim', 'densidade', 'flow', 'densidade_eps', 'obs']
        : ['data', 'turno', 'id_bateria', 'dimensao', 'tipo_montagem', 'total_paineis', 'm2_total', 'houve_atraso'];
      const labels = _importDestino === 'relatorio_injecao'
        ? { data: 'Data', id_bateria: 'Bateria', num_traco: 'Traço', berco_ini: 'B.Início', berco_fim: 'B.Fim', densidade: 'Densidade', flow: 'Flow', densidade_eps: 'D. EPS', obs: 'Obs' }
        : { data: 'Data', turno: 'Turno', id_bateria: 'Bateria', dimensao: 'Dimensão', tipo_montagem: 'Montagem', total_paineis: 'Painéis', m2_total: 'm²', houve_atraso: 'Atraso' };
      const preview = _importRegistros.slice(0, 8);

      const thStyle = 'padding:8px 12px;text-align:left;font-size:.75rem;color:var(--text-3);font-weight:600;white-space:nowrap;border-bottom:1px solid var(--border)';
      document.getElementById('import-preview-head').innerHTML =
        '<tr>' + cols.map(c => '<th style="' + thStyle + '">' + labels[c] + '</th>').join('') + '</tr>';

      document.getElementById('import-preview-body').innerHTML = preview.map(r =>
        '<tr style="border-bottom:1px solid var(--border)">' +
        cols.map(c => {
          const v = r[c];
          const bad = (c === 'data' && !v);
          return '<td style="padding:7px 12px;font-size:.8rem;color:' + (bad ? 'var(--red)' : 'var(--text)') + ';white-space:nowrap">' + (v || '—') + '</td>';
        }).join('') + '</tr>'
      ).join('');

      document.getElementById('import-preview-info').textContent =
        _importRegistros.length + ' registros serão importados' +
        (_importRegistros.length > 8 ? ' (mostrando primeiros 8)' : '');

      const errosDiv = document.getElementById('import-erros');
      if (erros.length) {
        errosDiv.style.display = 'block';
        errosDiv.innerHTML = '<strong>Avisos:</strong> ' + erros.slice(0, 5).join(' · ') + (erros.length > 5 ? ' ...' : '');
      } else {
        errosDiv.style.display = 'none';
      }

      document.getElementById('import-step-1').style.display = 'none';
      document.getElementById('import-step-2').style.display = 'block';
    }

    async function confirmarImportacao() {
      const btn = document.getElementById('btn-confirmar-import');
      btn.disabled = true;
      btn.textContent = 'Importando...';
      try {
        const rota = _importDestino === 'relatorio_injecao'
          ? '/importar-relatorio-injecao'
          : '/importar-historico';
        const res = await fetch(rota, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(_importRegistros),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.erro || 'Erro desconhecido');

        document.getElementById('import-step-2').style.display = 'none';
        document.getElementById('import-step-3').style.display = 'block';
        document.getElementById('import-result-icon').textContent = '✅';
        const destLabel = _importDestino === 'relatorio_injecao' ? 'Relatório de Injeção' : 'Relatorio de Baterias';
        document.getElementById('import-result-msg').textContent = json.inseridos + ' registros importados para ' + destLabel + '!';
        document.getElementById('import-result-sub').textContent = json.duplicatas
          ? json.duplicatas + ' duplicatas ignoradas.'
          : 'Nenhuma duplicata encontrada.';
      } catch (err) {
        document.getElementById('import-step-2').style.display = 'none';
        document.getElementById('import-step-3').style.display = 'block';
        document.getElementById('import-result-icon').textContent = '❌';
        document.getElementById('import-result-msg').textContent = 'Erro ao importar';
        document.getElementById('import-result-sub').textContent = err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = '✓ Importar Registros';
      }
    }

    // ---- Config Modal ----

    let _cfgDados = null; // cópia local enquanto edita
    // Snapshot (JSON) de _cfgDados no instante em que o modal abriu — usado
    // só pra saber se algo mudou, na hora de fechar (ver
    // fecharConfigComConfirmacao()). Comparação simples por string: o
    // volume de dados aqui é pequeno (baterias + tipos de montagem), então
    // JSON.stringify a cada fechamento não é um problema de performance.
    let _cfgSnapshotInicial = null;

    // Converte uma opção bruta de tipos_montagem.opcoes (do config.json) pra
    // a forma usada na tela de admin.
    function _montagemDoConfigParaUI(opcao) {
      if (opcao.modo === 'hibrida') {
        const tipos = Array.isArray(opcao.tipos) ? [...opcao.tipos] : Object.keys(opcao)
          .map(k => k.match(/^paineis_(.+)_por_berco$/))
          .filter(Boolean).map(m => m[1]);
        return { label: opcao.label, modo: 'hibrida', tipos };
      }
      // Simples (ou registro legado sem "modo" definido, com 1 único componente)
      let tipo = opcao.tipo;
      if (!tipo) {
        const chave = Object.keys(opcao).find(k => /^paineis_(.+)_por_berco$/.test(k));
        tipo = chave ? chave.match(/^paineis_(.+)_por_berco$/)[1] : '';
      }
      const paineisPorBerco = tipo ? (opcao[`paineis_${tipo}_por_berco`] ?? 2) : 2;
      // cor (hex) é o formato atual; corHue (número, antigo) é convertido na
      // hora se ainda não tiver sido migrado — nunca os dois juntos.
      const cor = typeof opcao.cor === 'string' && opcao.cor
        ? opcao.cor
        : (typeof opcao.corHue === 'number' ? LW.hslParaHex(opcao.corHue, 60, 52) : null);
      return {
        label: opcao.label,
        modo: 'simples',
        tipo,
        paineisPorBerco,
        cor,
        cimenticia: (opcao.cimenticia && typeof opcao.cimenticia === 'object')
          ? { leva: !!opcao.cimenticia.leva, quantidade: Number(opcao.cimenticia.quantidade) || 0 }
          : { leva: false, quantidade: 0 },
        // Combinação de avaliação (Setor de Qualidade → Referência) —
        // SÓ é lida aqui, nunca editada nesta tela (ver cfgRenderTudo:
        // mostra um aviso quando vazia, mas não tem campo pra
        // preencher). Precisa ser copiada pra UI e devolvida intacta em
        // _montagemDaUIParaConfig (abaixo) — sem isso, abrir e salvar
        // Configurações (por qualquer motivo, nem precisa mexer em
        // Montagem) apagava silenciosamente toda combinação já definida.
        combinacaoAvaliacao: (opcao.combinacaoAvaliacao && typeof opcao.combinacaoAvaliacao === 'object')
          ? { forma: opcao.combinacaoAvaliacao.forma, corModificadora: opcao.combinacaoAvaliacao.corModificadora }
          : null,
      };
    }

    // Converte de volta a forma da tela de admin pro formato salvo no
    // config.json (mantém as chaves paineis_<tipo>_por_berco, lidas
    // dinamicamente por extrairComponentesMontagem() em data.js).
    function _montagemDaUIParaConfig(m) {
      if (m.modo === 'hibrida') {
        const opcao = { label: m.label, modo: 'hibrida', tipos: [...m.tipos] };
        m.tipos.forEach(t => { opcao[`paineis_${t}_por_berco`] = 1; });
        return opcao;
      }
      const opcao = {
        label: m.label,
        modo: 'simples',
        tipo: m.tipo,
        cor: typeof m.cor === 'string' ? m.cor : null,
        cimenticia: {
          leva: !!m.cimenticia?.leva,
          quantidade: m.cimenticia?.leva ? (m.cimenticia.quantidade || 0) : 0,
        },
        // Ver comentário em _montagemDoConfigParaUI, acima — preserva o
        // que já estava definido (ou null, se ainda não tiver sido).
        combinacaoAvaliacao: (m.combinacaoAvaliacao && typeof m.combinacaoAvaliacao === 'object')
          ? { forma: m.combinacaoAvaliacao.forma, corModificadora: m.combinacaoAvaliacao.corModificadora }
          : null,
      };
      opcao[`paineis_${m.tipo}_por_berco`] = m.paineisPorBerco;
      return opcao;
    }

    function abrirConfig() {
      if (sessionStorage.getItem('lw_role') !== 'Administrador') return;
      // Lê o estado atual das variáveis já carregadas pelo data.js
      // BATERIA_IDS agora é array de objetos {id, label, bercos}
      _cfgDados = {
        baterias: LW.BATERIA_IDS.map(b => ({ id: b.id, label: b.label || '', bercos: b.bercos || 20 })),
        montagens: LW.MONTAGEM_OPCOES.map(_montagemDoConfigParaUI),
      };
      _cfgSnapshotInicial = JSON.stringify(_cfgDados);
      cfgEscolherModoMontagem('simples');
      cfgRenderTudo();
      cfgMostrarSecao('dados');
      document.getElementById('config-modal').style.display = 'flex';
      if (typeof LWTour !== 'undefined') LWTour.aoAbrirModal('config');
    }

    function fecharConfig() {
      document.getElementById('config-modal').style.display = 'none';
      _cfgDados = null;
      _cfgSnapshotInicial = null;
      // Se tinha alguma captura de tecla pendente (remapeando um atalho),
      // cancela — não faz sentido continuar escutando com o modal fechado.
      if (_cfgAtalhoCapturando && typeof LWKeyboard !== 'undefined') {
        LWKeyboard.cancelarCaptura();
        _cfgAtalhoCapturando = null;
      }
    }

    // ── Fecha o modal de Configurações, perguntando antes se há alterações
    // não salvas em "Baterias e Montagem" (a única seção com um rascunho
    // pra confirmar/cancelar — "Atalhos" e "Autorizados" salvam cada ação
    // na hora, então não têm o que descartar). Usado pelo ✕ e por
    // "Cancelar" no lugar de fecharConfig() direto.
    async function fecharConfigComConfirmacao() {
      const houveAlteracoes = _cfgDados && JSON.stringify(_cfgDados) !== _cfgSnapshotInicial;
      if (!houveAlteracoes) {
        fecharConfig();
        return;
      }

      const salvar = await LW.mostrarConfirmacao(
        'Você tem alterações não salvas em Baterias e Montagem. O que deseja fazer?',
        {
          titulo: 'Alterações não salvas', icon: '💾',
          textoConfirmar: '💾 Salvar e Fechar', textoCancelar: '🗑️ Descartar Alterações',
        }
      );

      if (salvar) {
        await cfgSalvar(); // já fecha o modal (e recarrega a página) se salvar com sucesso
      } else {
        fecharConfig();
      }
    }

    // ---- Menu lateral das Configurações ----
    function cfgMostrarSecao(secao) {
      const elDados = document.getElementById('cfg-secao-dados');
      const elAtalhos = document.getElementById('cfg-secao-atalhos');
      const elAutorizados = document.getElementById('cfg-secao-autorizados');
      const elAutomacao = document.getElementById('cfg-secao-automacao');
      const elSql = document.getElementById('cfg-secao-sql');
      if (elDados) elDados.style.display = secao === 'dados' ? 'block' : 'none';
      if (elAtalhos) elAtalhos.style.display = secao === 'atalhos' ? 'block' : 'none';
      if (elAutorizados) elAutorizados.style.display = secao === 'autorizados' ? 'block' : 'none';
      if (elAutomacao) elAutomacao.style.display = secao === 'automacao' ? 'block' : 'none';
      if (elSql) elSql.style.display = secao === 'sql' ? 'block' : 'none';

      const ESTILO_ATIVO = 'text-align:left;background:var(--bg-2);border:1px solid var(--accent-dim);color:var(--accent);border-radius:var(--radius);padding:10px 14px;font-size:.85rem;cursor:pointer;font-weight:600';
      const ESTILO_INATIVO = 'text-align:left;background:none;border:1px solid transparent;color:var(--text-2);border-radius:var(--radius);padding:10px 14px;font-size:.85rem;cursor:pointer';
      const navDados = document.getElementById('cfg-nav-dados');
      const navAtalhos = document.getElementById('cfg-nav-atalhos');
      const navAutorizados = document.getElementById('cfg-nav-autorizados');
      const navAutomacao = document.getElementById('cfg-nav-automacao');
      const navSql = document.getElementById('cfg-nav-sql');
      if (navDados) navDados.style.cssText = secao === 'dados' ? ESTILO_ATIVO : ESTILO_INATIVO;
      if (navAtalhos) navAtalhos.style.cssText = secao === 'atalhos' ? ESTILO_ATIVO : ESTILO_INATIVO;
      if (navAutorizados) navAutorizados.style.cssText = secao === 'autorizados' ? ESTILO_ATIVO : ESTILO_INATIVO;
      if (navAutomacao) navAutomacao.style.cssText = secao === 'automacao' ? ESTILO_ATIVO : ESTILO_INATIVO;
      if (navSql) navSql.style.cssText = secao === 'sql' ? ESTILO_ATIVO : ESTILO_INATIVO;

      if (secao === 'atalhos') cfgRenderAtalhos();
      if (secao === 'autorizados') cfgRenderAutorizados();
      if (secao === 'automacao') cfgRenderAutomacao();
      if (secao === 'sql') cfgSqlAoAbrirSecao();
    }

    // ---- Automação (Configurações → Automação) ────────────────────────
    // Reflete o estado GLOBAL já carregado pelo data.js (LW.MODO_AUTOMATICO_ATIVO)
    // no checkbox — chamado toda vez que a seção é mostrada (ver
    // cfgMostrarSecao, acima), pra nunca ficar dessincronizado se alguém
    // mais mudou isso enquanto o modal estava fechado.
    function cfgRenderAutomacao() {
      const chk = document.getElementById('cfg-toggle-automatico');
      if (chk) chk.checked = !!LW.MODO_AUTOMATICO_ATIVO;
    }

    /**
     * Liga/desliga "🤖 Modo Automático" — SEMPRE pede a senha de
     * Administrador de novo antes de aplicar, nos dois sentidos (ligar E
     * desligar), de propósito: evita que alguém desligue sem querer
     * enquanto passa perto do computador, e evita ligar sem intenção
     * clara (a leitura automática passa a sobrescrever campos de insumo
     * sozinha — ver operacao.js, _aplicarLeituraAutomatica).
     *
     * Reverte o checkbox visualmente ANTES de pedir a senha (otimista ao
     * contrário: assume que vai ser cancelado, só aplica de verdade no
     * onSuccess) — se a pessoa cancelar o modal de senha, não sobra
     * nenhum estado("meio aplicado") pra desfazer.
     */
    function cfgToggleModoAutomatico(checkboxEl) {
      const novoValor = checkboxEl.checked;
      checkboxEl.checked = !novoValor; // desfaz na hora — só aplica de verdade após a senha

      if (typeof AdminAuth === 'undefined') {
        LW.mostrarAlerta('Não foi possível confirmar a senha de administrador nesta tela.', { tipo: 'erro' });
        return;
      }

      AdminAuth.abrirModal(async function onSuccess() {
        try {
          const res = await fetch('/config/modo-automatico', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ativo: novoValor }),
          });
          const json = await res.json().catch(() => null);
          if (!res.ok) {
            LW.mostrarAlerta(json?.erro || 'Não foi possível salvar. Tente novamente.', { tipo: 'erro' });
            return;
          }
          LW.atualizarModoAutomatico(novoValor);
          checkboxEl.checked = novoValor;
          LW.mostrarAlerta(
            novoValor ? 'Modo Automático ativado.' : 'Modo Automático desativado.',
            { tipo: 'sucesso' }
          );
        } catch (_) {
          LW.mostrarAlerta('Erro de conexão ao salvar. Verifique a rede e tente novamente.', { tipo: 'erro' });
        }
      });
      // Se cancelar o modal de senha, o checkbox já foi revertido acima —
      // nada mais precisa acontecer.
    }

    // ---- Dados SQL (Configurações → Dados SQL) ─────────────────────────
    // Consulta/exclusão manual de linha do SQLite, direto da tela de
    // administração — ver TABELAS_SQL_ADMIN e as 3 rotas /admin/sql-*
    // em server.js (a lista de tabelas permitidas vive SÓ lá; aqui é
    // só exibição/interação com o que o servidor devolve).
    let _cfgSqlTabelas = [];       // [{tabela, label, pk, linhas}, ...] — vem de GET /admin/sql-tabelas
    let _cfgSqlDadosAtuais = null; // {tabela, pk, colunas, linhas} da tabela selecionada agora

    // Chamado toda vez que a seção é mostrada (ver cfgMostrarSecao) — só
    // busca a LISTA de tabelas (rápido); as linhas de uma tabela só são
    // buscadas quando o usuário escolhe uma no <select> (cfgSqlCarregarLinhas).
    async function cfgSqlAoAbrirSecao() {
      const select = document.getElementById('cfg-sql-tabela');
      const status = document.getElementById('cfg-sql-status');
      if (!select) return;
      const selecaoAnterior = select.value;
      try {
        const res = await fetch('/admin/sql-tabelas', { cache: 'no-store' });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.ok) throw new Error(json?.erro || 'Não foi possível carregar a lista de tabelas.');
        _cfgSqlTabelas = json.tabelas;
        select.innerHTML = '<option value="">Selecione uma tabela…</option>' +
          _cfgSqlTabelas.map(t => `<option value="${t.tabela}">${t.label} (${t.linhas} linha${t.linhas === 1 ? '' : 's'})</option>`).join('');
        if (selecaoAnterior && _cfgSqlTabelas.some(t => t.tabela === selecaoAnterior)) {
          select.value = selecaoAnterior;
          cfgSqlCarregarLinhas();
        } else {
          if (status) status.textContent = '';
          document.getElementById('cfg-sql-thead').innerHTML = '';
          document.getElementById('cfg-sql-tbody').innerHTML = '';
          const btnLimpar = document.getElementById('cfg-sql-btn-limpar');
          if (btnLimpar) btnLimpar.disabled = true;
          _cfgSqlDadosAtuais = null;
        }
      } catch (e) {
        if (status) status.textContent = '⚠ ' + e.message;
      }
    }

    // Busca colunas + linhas da tabela escolhida no <select> e desenha a
    // tabela HTML (via cfgSqlRenderLinhas, que também cuida do filtro de busca).
    async function cfgSqlCarregarLinhas() {
      const select = document.getElementById('cfg-sql-tabela');
      const status = document.getElementById('cfg-sql-status');
      const thead = document.getElementById('cfg-sql-thead');
      const tbody = document.getElementById('cfg-sql-tbody');
      const btnLimpar = document.getElementById('cfg-sql-btn-limpar');
      const tabela = select?.value || '';

      _cfgSqlDadosAtuais = null;
      thead.innerHTML = '';
      tbody.innerHTML = '';
      if (btnLimpar) btnLimpar.disabled = !tabela;

      if (!tabela) { if (status) status.textContent = ''; return; }

      if (status) status.textContent = 'Carregando…';
      try {
        const res = await fetch('/admin/sql-linhas?tabela=' + encodeURIComponent(tabela), { cache: 'no-store' });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.ok) throw new Error(json?.erro || 'Não foi possível carregar as linhas desta tabela.');
        _cfgSqlDadosAtuais = json;
        cfgSqlRenderLinhas();
      } catch (e) {
        if (status) status.textContent = '⚠ ' + e.message;
      }
    }

    // Redesenha a tabela HTML a partir de _cfgSqlDadosAtuais, aplicando o
    // filtro de texto (busca simples: alguma coluna contém o termo,
    // sem diferenciar maiúsculas/minúsculas) — chamado a cada tecla
    // digitada em "Buscar nas linhas carregadas", sem ir ao servidor de
    // novo (as linhas já estão carregadas no navegador).
    function cfgSqlRenderLinhas() {
      const status = document.getElementById('cfg-sql-status');
      const thead = document.getElementById('cfg-sql-thead');
      const tbody = document.getElementById('cfg-sql-tbody');
      if (!_cfgSqlDadosAtuais) return;

      const { tabela, pk, colunas, linhas, limite } = _cfgSqlDadosAtuais;
      const termo = (document.getElementById('cfg-sql-busca')?.value || '').trim().toLowerCase();
      const linhasFiltradas = termo
        ? linhas.filter(linha => colunas.some(c => String(linha[c] ?? '').toLowerCase().includes(termo)))
        : linhas;

      thead.innerHTML = `<tr>${colunas.map(c => `<th style="text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);color:var(--text-3);font-weight:600;white-space:nowrap">${c}${c === pk ? ' 🔑' : ''}</th>`).join('')}<th style="padding:8px 10px;border-bottom:1px solid var(--border)"></th></tr>`;

      tbody.innerHTML = linhasFiltradas.map(linha => `
        <tr style="border-bottom:1px solid var(--border)">
          ${colunas.map(c => {
            let valor = linha[c];
            if (valor === null || valor === undefined) valor = '';
            valor = String(valor);
            const truncado = valor.length > 80 ? valor.slice(0, 80) + '…' : valor;
            return `<td style="padding:6px 10px;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;color:var(--text-2)" title="${valor.replace(/"/g, '&quot;')}">${truncado || '<span style="color:var(--text-3)">—</span>'}</td>`;
          }).join('')}
          <td style="padding:6px 10px;white-space:nowrap">
            <button onclick='cfgSqlExcluirLinha(${JSON.stringify(tabela)}, ${JSON.stringify(String(linha[pk]))})'
              style="background:none;border:none;color:var(--red);cursor:pointer;font-size:.8rem">✕ Excluir</button>
          </td>
        </tr>
      `).join('') || `<tr><td colspan="${colunas.length + 1}" style="padding:14px;text-align:center;color:var(--text-3)">Nenhuma linha encontrada.</td></tr>`;

      if (status) {
        status.textContent = termo
          ? `${linhasFiltradas.length} de ${linhas.length} linha(s) carregada(s)${linhas.length >= limite ? ' (mostrando só as ' + limite + ' mais recentes)' : ''}.`
          : `${linhas.length} linha(s) carregada(s)${linhas.length >= limite ? ' — mostrando só as ' + limite + ' mais recentes' : ''}.`;
      }
    }

    // Exclui UMA linha pelo valor da PK (coluna real, ver TABELAS_SQL_ADMIN
    // no servidor) — pede confirmação normal e, por ser uma exclusão
    // permanente e fora do fluxo comum de edição, pede a senha de
    // Administrador DE NOVO (mesmo padrão de cfgToggleModoAutomatico, acima).
    //
    // "operacoes_avaliadas" é um caso especial: excluir uma linha aqui
    // desfaz a avaliação de qualidade inteira daquela operação (apaga
    // também avaliacoes_qualidade e avaliacao_paineis, no servidor — ver
    // db.desfazerAvaliacaoOperacao) e a operação volta a aparecer na fila
    // de avaliação pendente do Setor de Qualidade. O aviso de confirmação
    // deixa isso explícito ANTES de excluir, pra não ser uma surpresa.
    async function cfgSqlExcluirLinha(tabela, valorPk) {
      const ehDesfazerAvaliacao = tabela === 'operacoes_avaliadas';
      const mensagemConfirmacao = ehDesfazerAvaliacao
        ? `Isto vai desfazer TODA a avaliação de qualidade da operação "${valorPk}" — a avaliação e os painéis vinculados também serão apagados, e a operação volta a aparecer como pendente na fila do Setor de Qualidade. Esta ação não pode ser desfeita. Continuar?`
        : `Excluir permanentemente esta linha de "${tabela}"? Esta ação não pode ser desfeita.`;

      const confirmou = await LW.mostrarConfirmacao(
        mensagemConfirmacao,
        { titulo: ehDesfazerAvaliacao ? 'Desfazer avaliação de qualidade' : 'Excluir linha do banco', textoConfirmar: 'Excluir', tipo: 'perigo', icon: '🗑️' }
      );
      if (!confirmou) return;

      if (typeof AdminAuth === 'undefined') {
        LW.mostrarAlerta('Não foi possível confirmar a senha de administrador nesta tela.', { tipo: 'erro' });
        return;
      }

      AdminAuth.abrirModal(async function onSuccess() {
        try {
          const res = await fetch('/admin/sql-excluir-linha?wsClientId=' + encodeURIComponent(LW.OP_ANDAMENTO_CLIENT_ID), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tabela, valor: valorPk }),
          });
          const json = await res.json().catch(() => null);
          if (!res.ok || !json?.ok) throw new Error(json?.erro || 'Não foi possível excluir. Tente novamente.');

          const mensagemSucesso = (ehDesfazerAvaliacao && json.cascata)
            ? `Avaliação desfeita: ${json.cascata.avaliacoes_qualidade} avaliação(ões), ${json.cascata.avaliacao_paineis} registro(s) de painéis e ${json.cascata.operacoes_avaliadas} marcação(ões) removidos. A operação volta pra fila de avaliação pendente. A página será recarregada.`
            : 'Linha excluída com sucesso. A página será recarregada para atualizar todas as telas.';

          // Recarrega a página inteira depois de excluir — mesmo motivo de
          // cfgSalvar(), acima: várias telas (dashboards, relatórios,
          // Registrar Operação etc.) carregam os dados UMA VEZ, na
          // inicialização, e guardam em variáveis JS (ver data.js) — sem
          // recarregar, o navegador continuaria mostrando a linha já
          // apagada do banco até um F5 manual. Um reload garante que TODO
          // o site passe a refletir a exclusão, não só a própria aba.
          await LW.mostrarAlerta(mensagemSucesso, { tipo: 'sucesso' });
          window.location.reload();
        } catch (e) {
          LW.mostrarAlerta(e.message, { tipo: 'erro' });
        }
      });
    }

    // Apaga TODAS as linhas da tabela selecionada de uma vez (botão "🧹
    // Limpar Todas") — mesmo padrão de segurança de cfgSqlExcluirLinha
    // (confirmação + senha de Administrador de novo), só que em lote.
    // "operacoes_avaliadas" tem o MESMO tratamento especial de
    // cfgSqlExcluirLinha: o servidor desfaz cada avaliação em cascata (ver
    // POST /admin/sql-limpar-tabela, server.js) e devolve json.cascata —
    // tratado abaixo pra montar a mensagem de sucesso certa.
    async function cfgSqlLimparTabela() {
      const select = document.getElementById('cfg-sql-tabela');
      const tabela = select?.value || '';
      if (!tabela) return;
      const labelTabela = select.options[select.selectedIndex]?.textContent || tabela;
      const ehDesfazerAvaliacao = tabela === 'operacoes_avaliadas';
      const mensagemConfirmacao = ehDesfazerAvaliacao
        ? 'Isto vai desfazer TODAS as avaliações de qualidade registradas — as avaliações e os painéis vinculados também serão apagados, e todas as operações voltam a aparecer como pendentes na fila do Setor de Qualidade. Esta ação não pode ser desfeita. Continuar?'
        : `Excluir permanentemente TODAS as linhas de "${labelTabela}"? Esta ação não pode ser desfeita.`;

      const confirmou = await LW.mostrarConfirmacao(
        mensagemConfirmacao,
        { titulo: ehDesfazerAvaliacao ? 'Desfazer todas as avaliações de qualidade' : 'Limpar tabela inteira', textoConfirmar: 'Limpar Todas', tipo: 'perigo', icon: '🧹' }
      );
      if (!confirmou) return;

      if (typeof AdminAuth === 'undefined') {
        LW.mostrarAlerta('Não foi possível confirmar a senha de administrador nesta tela.', { tipo: 'erro' });
        return;
      }

      AdminAuth.abrirModal(async function onSuccess() {
        try {
          const res = await fetch('/admin/sql-limpar-tabela?wsClientId=' + encodeURIComponent(LW.OP_ANDAMENTO_CLIENT_ID), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tabela }),
          });
          const json = await res.json().catch(() => null);
          if (!res.ok || !json?.ok) throw new Error(json?.erro || 'Não foi possível limpar a tabela. Tente novamente.');

          // "operacoes_avaliadas" limpa em cascata (mesmo caso especial de
          // cfgSqlExcluirLinha, só que em lote — ver POST
          // /admin/sql-limpar-tabela, server.js): o servidor devolve
          // json.cascata com o total de cada tabela afetada, e todas essas
          // operações voltam pra fila de avaliação pendente.
          const mensagemSucesso = json.cascata
            ? `Limpeza desfez ${json.cascata.avaliacoes_qualidade} avaliação(ões): ${json.cascata.avaliacao_paineis} registro(s) de painéis e ${json.cascata.operacoes_avaliadas} marcação(ões) removidos. Todas essas operações voltam pra fila de avaliação pendente. A página será recarregada.`
            : `${json.excluidas} linha(s) excluída(s) de "${labelTabela}". A página será recarregada para atualizar todas as telas.`;

          await LW.mostrarAlerta(mensagemSucesso, { tipo: 'sucesso' });
          window.location.reload();
        } catch (e) {
          LW.mostrarAlerta(e.message, { tipo: 'erro' });
        }
      });
    }

    // ---- Atalhos de Teclado (Configurações → Atalhos) ----
    // id do atalho que está "escutando" a próxima tecla agora, ou null.
    let _cfgAtalhoCapturando = null;

    function cfgRenderAtalhos() {
      if (typeof LWKeyboard === 'undefined') return;
      const todos = LWKeyboard.listarAtalhos();
      const elNav = document.getElementById('cfg-atalhos-navegacao');
      const elAcoes = document.getElementById('cfg-atalhos-acoes');
      const elRef = document.getElementById('cfg-atalhos-referencia');
      if (elNav) elNav.innerHTML = todos.filter(a => a.grupo === 'navegacao').map(_cfgLinhaAtalho).join('');
      if (elAcoes) elAcoes.innerHTML = todos.filter(a => a.grupo === 'acao').map(_cfgLinhaAtalho).join('');
      // Atalhos NÃO-editáveis (ver REFERENCIA_CONFIG, keyboard-shortcuts.js)
      // — cada um vive de verdade em outra tela (Setor de Qualidade,
      // Registro de Baterias etc.); aqui é só a documentação central
      // deles, por isso sem botão "Alterar" (ver _cfgLinhaReferencia).
      if (elRef && typeof LWKeyboard.listarReferencia === 'function') {
        elRef.innerHTML = LWKeyboard.listarReferencia().map(_cfgLinhaReferencia).join('');
      }
    }

    function _cfgLinhaReferencia(r) {
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius);padding:9px 14px;flex-wrap:wrap">
          <span style="font-size:.84rem;color:var(--text-2)">${r.icon} <strong>${r.contexto}</strong><br><span style="font-size:.76rem;color:var(--text-3)">${r.descricao}</span></span>
          <kbd style="display:inline-block;padding:2px 9px;font-family:var(--font-mono);font-size:.74rem;color:var(--text);background:var(--bg-2);border:1px solid var(--border-2);border-radius:4px;white-space:nowrap">${r.combo}</kbd>
        </div>
      `;
    }

    function _cfgLinhaAtalho(a) {
      const capturando = _cfgAtalhoCapturando === a.id;
      const outroCapturando = _cfgAtalhoCapturando && !capturando;
      const comboHtml = capturando
        ? '<span style="color:var(--accent);font-size:.78rem">Pressione a nova combinação... (Esc cancela)</span>'
        : (a.comboAtual === ''
          ? '<span style="color:var(--text-3);font-size:.78rem;font-style:italic">Sem atalho</span>'
          : a.comboAtual.split('+').map(p =>
            `<kbd style="display:inline-block;padding:2px 7px;font-family:var(--font-mono);font-size:.74rem;color:var(--text);background:var(--bg-3);border:1px solid var(--border-2);border-radius:4px">${p}</kbd>`
          ).join(' + '));
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--bg-3);border:1px solid ${capturando ? 'var(--accent)' : 'var(--border)'};border-radius:var(--radius);padding:9px 14px;flex-wrap:wrap">
          <span style="font-size:.84rem;color:var(--text-2)">${a.icon} ${a.label}</span>
          <div style="display:flex;align-items:center;gap:10px">
            <span style="display:flex;align-items:center;gap:4px">${comboHtml}</span>
            <button class="btn btn-ghost btn-sm" onclick="cfgAlterarAtalho('${a.id}')" ${outroCapturando ? 'disabled' : ''}>${capturando ? '✕ Cancelar' : '✏️ Alterar'}</button>
          </div>
        </div>
      `;
    }

    function cfgAlterarAtalho(id) {
      if (typeof LWKeyboard === 'undefined') return;

      // Já está capturando ESTE atalho — o clique foi em "✕ Cancelar"
      if (_cfgAtalhoCapturando === id) {
        LWKeyboard.cancelarCaptura();
        _cfgAtalhoCapturando = null;
        cfgRenderAtalhos();
        return;
      }

      _cfgAtalhoCapturando = id;
      cfgRenderAtalhos();

      LWKeyboard.capturarProximoCombo(resultado => {
        _cfgAtalhoCapturando = null;
        if (!resultado) { cfgRenderAtalhos(); return; } // cancelado com Esc
        if (resultado.erro) {
          LW.mostrarAlerta(resultado.erro, { tipo: 'erro' });
          cfgRenderAtalhos();
          return;
        }
        _cfgAplicarNovoCombo(id, resultado.combo);
      });
    }

    // Tenta aplicar o novo combo; se já estiver em uso por outro atalho,
    // pergunta antes de substituir — confirmado, o antigo titular do combo
    // fica sem atalho (não herda o combo anterior de `id`).
    async function _cfgAplicarNovoCombo(id, combo) {
      const r = LWKeyboard.definirAtalho(id, combo);
      if (r.ok) { cfgRenderAtalhos(); return; }

      if (r.conflito) {
        const confirmou = await LW.mostrarConfirmacao(
          `"${combo}" já está em uso por "${r.conflito.icon ? r.conflito.icon + ' ' : ''}${r.conflito.label}". Substituir mesmo assim? "${r.conflito.label}" ficará sem atalho.`,
          { titulo: 'Atalho já em uso', textoConfirmar: 'Substituir', icon: '⌨️' }
        );
        if (confirmou) {
          const r2 = LWKeyboard.definirAtalho(id, combo, { substituirConflito: true });
          if (!r2.ok) LW.mostrarAlerta(r2.erro || 'Não foi possível definir o atalho.', { tipo: 'erro' });
        }
        cfgRenderAtalhos();
        return;
      }

      LW.mostrarAlerta(r.erro || 'Não foi possível definir o atalho.', { tipo: 'erro' });
      cfgRenderAtalhos();
    }

    async function cfgResetarAtalhos() {
      if (typeof LWKeyboard === 'undefined') return;
      const confirmou = await LW.mostrarConfirmacao(
        'Isso desfaz qualquer personalização feita neste navegador.',
        { titulo: 'Restaurar atalhos para o padrão de fábrica?', textoConfirmar: 'Restaurar Padrões', icon: '↺' }
      );
      if (!confirmou) return;
      LWKeyboard.resetarAtalhos();
      cfgRenderAtalhos();
    }

    function cfgRenderTudo() {
      // Baterias (agora com dimensão e berços integrados)
      const lb = document.getElementById('cfg-baterias-lista');
      lb.innerHTML = _cfgDados.baterias.map((b, i) => `
    <div style="display:flex;align-items:center;gap:12px;background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px">
      <span style="font-family:var(--font-mono);font-size:.9rem;font-weight:700;color:var(--accent);min-width:80px">${b.id}</span>
      <span style="font-size:.82rem;color:var(--text-2);min-width:60px">${b.label || '—'}</span>
      <span style="font-size:.82rem;color:var(--text-2)">${b.bercos} berços</span>
      <span style="font-size:.75rem;color:var(--text-3);margin-left:4px">→ ${b.bercos * 2} painéis máx.</span>
      <button onclick="cfgRemoverBateria(${i})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:.85rem;margin-left:auto">✕ Remover</button>
    </div>
  `).join('') || '<span style="color:var(--text-3);font-size:.82rem">Nenhuma bateria cadastrada.</span>';

      // Montagens — mostra modo (Simples/Híbrida), composição e cimentícia
      const lm = document.getElementById('cfg-montagem-lista');
      lm.innerHTML = _cfgDados.montagens.map((m, i) => {
        const corBadge = m.modo === 'hibrida' ? 'var(--accent)' : 'var(--blue)';
        const detalhe = m.modo === 'hibrida'
          ? `${m.tipos.map(t => t.toUpperCase()).join(' + ')} — 1 painel de cada (2/berço)`
          : `${(m.tipo || '—').toUpperCase()} — ${m.paineisPorBerco}/berço`;
        const cimenticiaTxt = m.modo === 'hibrida'
          ? 'cimentícia herdada dos tipos simples'
          : (m.cimenticia?.leva ? `${m.cimenticia.quantidade} ciment./painel` : 'sem cimentícia');
        const swatch = (m.modo === 'simples' && typeof m.cor === 'string')
          ? `<span title="Cor deste tipo" style="display:inline-block;width:13px;height:13px;border-radius:50%;background:${m.cor};flex:0 0 auto"></span>`
          : '';
        // Combinação de avaliação (cor+forma da marcação, Setor de
        // Qualidade → Referência) nasce vazia (null) num tipo simples
        // recém-cadastrado (ver cfgAdicionarMontagemSimples) — só quem
        // define é o Setor de Qualidade, nunca aqui. Sinaliza o estado
        // "ainda vazio" pra quem cadastra saber que falta esse passo,
        // sem precisar ir até lá conferir.
        const avisoSemCombinacao = (m.modo === 'simples' && !m.combinacaoAvaliacao)
          ? `<span style="font-size:.7rem;color:var(--accent)" title="Definida em Setor de Qualidade → 📖 Referência">⚠ sem marcação definida</span>`
          : '';
        return `
    <div style="display:flex;align-items:center;gap:12px;background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;flex-wrap:wrap">
      ${swatch}
      <span style="font-family:var(--font-display);font-size:.9rem;font-weight:700;color:var(--text);min-width:90px">${m.label}</span>
      <span style="font-size:.66rem;font-weight:700;color:${corBadge};text-transform:uppercase;letter-spacing:.06em;border:1px solid ${corBadge};border-radius:4px;padding:2px 6px">${m.modo === 'hibrida' ? 'Híbrida' : 'Simples'}</span>
      <span style="font-size:.78rem;color:var(--text-3)">${detalhe}</span>
      <span style="font-size:.78rem;color:var(--text-3)">${cimenticiaTxt}</span>
      ${avisoSemCombinacao}
      <button onclick="cfgRemoverMontagem(${i})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:.85rem;margin-left:auto">✕ Remover</button>
    </div>
  `;
      }).join('') || '<span style="color:var(--text-3);font-size:.82rem">Nenhum tipo cadastrado.</span>';

      cfgPopularSelectsHibrida();
    }

    function cfgAdicionarBateria() {
      const inputId = document.getElementById('cfg-bateria-novo');
      const inputLabel = document.getElementById('cfg-bateria-label');
      const inputBercos = document.getElementById('cfg-bateria-bercos');

      const id = inputId.value.trim().toUpperCase();
      const dimRaw = inputLabel.value.trim();
      const bercos = parseInt(inputBercos.value);

      if (!id) { LW.mostrarAlerta('Digite o ID da bateria (ex: B14).', { tipo: 'aviso' }); return; }
      if (!dimRaw) { LW.mostrarAlerta('Digite a dimensão da bateria, em cm (ex: 15).', { tipo: 'aviso' }); return; }
      // Só número — quem digita não precisa (e não deve) escrever "cm" aqui;
      // o "cm" é adicionado automaticamente ao montar o label exibido.
      if (!/^\d+([.,]\d+)?$/.test(dimRaw)) {
        LW.mostrarAlerta('Digite só o número da dimensão, em cm (ex: 15) — sem "cm" ou outro texto.', { tipo: 'aviso' });
        return;
      }
      const label = dimRaw + 'cm';
      if (!bercos || bercos < 1) { LW.mostrarAlerta('Digite a quantidade de berços válida.', { tipo: 'aviso' }); return; }
      if (_cfgDados.baterias.find(b => b.id === id)) { LW.mostrarAlerta('Este ID de bateria já existe.', { tipo: 'aviso' }); return; }

      _cfgDados.baterias.push({ id, label, bercos });
      inputId.value = '';
      inputLabel.value = '';
      inputBercos.value = '';
      cfgRenderTudo();
    }

    async function cfgRemoverBateria(i) {
      const confirmou = await LW.mostrarConfirmacao(
        `Remover a bateria "${_cfgDados.baterias[i].id}"?`,
        { titulo: 'Remover bateria', textoConfirmar: 'Remover', tipo: 'perigo', icon: '🗑️' }
      );
      if (!confirmou) return;
      _cfgDados.baterias.splice(i, 1);
      cfgRenderTudo();
    }

    // cfgAdicionarDimensao e cfgRemoverDimensao removidos — dimensão agora pertence à bateria

    // ---- Tipos de Montagem: escolha de modo (Simples / Híbrida) ----

    function cfgEscolherModoMontagem(modo) {
      const elSimples = document.getElementById('cfg-mont-form-simples');
      const elHibrida = document.getElementById('cfg-mont-form-hibrida');
      if (elSimples) elSimples.style.display = modo === 'simples' ? 'block' : 'none';
      if (elHibrida) elHibrida.style.display = modo === 'hibrida' ? 'block' : 'none';
      const btnSimples = document.getElementById('cfg-mont-modo-simples');
      const btnHibrida = document.getElementById('cfg-mont-modo-hibrida');
      if (btnSimples) btnSimples.className = modo === 'simples' ? 'btn btn-outline-accent btn-sm' : 'btn btn-ghost btn-sm';
      if (btnHibrida) btnHibrida.className = modo === 'hibrida' ? 'btn btn-outline-accent btn-sm' : 'btn btn-ghost btn-sm';
      if (modo === 'hibrida') cfgPopularSelectsHibrida();
      if (modo === 'simples') _cfgSugerirCorMontagem();
    }

    // Sugere automaticamente uma cor nova pro próximo tipo simples
    // ("largest-gap hue allocation" — ver data.js), distante das já usadas
    // pelos outros tipos. É só uma SUGESTÃO: o campo é um seletor de cor de
    // verdade, então quem estiver cadastrando pode aceitar ou trocar por
    // qualquer outra antes de salvar. Também usada pelo botão "🎲 Sortear
    // outra", pra pedir uma sugestão nova sem precisar escolher manualmente.
    function _cfgSugerirCorMontagem() {
      const input = document.getElementById('cfg-mont-simples-cor');
      if (!input || !_cfgDados) return;
      const coresExistentes = _cfgDados.montagens
        .filter(m => m.modo === 'simples' && typeof m.cor === 'string')
        .map(m => m.cor);
      input.value = LW.gerarProximaCorDisponivel(coresExistentes);
    }

    function cfgToggleCimenticiaQtd() {
      const checked = document.getElementById('cfg-mont-simples-leva-cimenticia').checked;
      document.getElementById('cfg-mont-simples-cimenticia-qtd-wrap').style.display = checked ? 'flex' : 'none';
    }

    // Popula os dois <select> do formulário Híbrida com os tipos SIMPLES já
    // cadastrados — só dá pra combinar tipos que já existem como simples.
    function cfgPopularSelectsHibrida() {
      if (!_cfgDados) return;
      const sel1 = document.getElementById('cfg-mont-hibrida-tipo1');
      const sel2 = document.getElementById('cfg-mont-hibrida-tipo2');
      if (!sel1 || !sel2) return;
      const simples = _cfgDados.montagens.filter(m => m.modo === 'simples');
      const opts = simples.map(m => `<option value="${m.tipo}">${m.label} (${m.tipo.toUpperCase()})</option>`).join('');
      const valor1 = sel1.value, valor2 = sel2.value;
      sel1.innerHTML = '<option value="">— selecione —</option>' + opts;
      sel2.innerHTML = '<option value="">— selecione —</option>' + opts;
      sel1.value = valor1; sel2.value = valor2;
      _cfgAtualizarLabelHibrida();
    }

    // Monta o label do tipo Híbrida automaticamente a partir dos 2 tipos
    // simples escolhidos — sempre "HÍBRIDA <tipo1>/<tipo2>" (ex: escolher
    // 2p e 4t gera "HÍBRIDA 2P/4T"). Quem cadastra não digita o label dessa
    // combinação — só escolhe os tipos; o campo de label é só exibição
    // (readonly), recalculado aqui a cada troca de 1º/2º Tipo.
    function _cfgAtualizarLabelHibrida() {
      const elLabel = document.getElementById('cfg-mont-hibrida-label');
      if (!elLabel) return;
      const tipo1 = document.getElementById('cfg-mont-hibrida-tipo1')?.value;
      const tipo2 = document.getElementById('cfg-mont-hibrida-tipo2')?.value;
      if (!tipo1 || !tipo2) { elLabel.value = ''; return; }
      elLabel.value = tipo1 === tipo2
        ? '⚠ escolha dois tipos diferentes'
        : `HÍBRIDA ${tipo1.toUpperCase()}/${tipo2.toUpperCase()}`;
    }

    // Cria um novo tipo de montagem SIMPLES: 1 tipo de placa, painéis/berço
    // (máx. 2, limitação física da operação), se leva placas cimentícias, e
    // a cor (sugerida automaticamente ao abrir o formulário, mas o campo é
    // um seletor de cor de verdade — quem estiver cadastrando pode trocar
    // por qualquer outra antes de salvar).
    function cfgAdicionarMontagemSimples() {
      const label = document.getElementById('cfg-mont-simples-label').value.trim().toUpperCase();
      const tipo = document.getElementById('cfg-mont-simples-tipo').value.trim().toLowerCase().replace(/\s+/g, '');
      const paineisPorBerco = parseInt(document.getElementById('cfg-mont-simples-paineis').value);
      const levaCimenticia = document.getElementById('cfg-mont-simples-leva-cimenticia').checked;
      const qtdCimenticia = parseInt(document.getElementById('cfg-mont-simples-cimenticia-qtd').value);
      const cor = document.getElementById('cfg-mont-simples-cor').value || LW.gerarProximaCorDisponivel([]);

      if (!label) { LW.mostrarAlerta('Digite um label para o tipo de montagem.', { tipo: 'aviso' }); return; }
      if (!tipo) { LW.mostrarAlerta('Digite o tipo de montagem (ex: 2p, sp, 3t).', { tipo: 'aviso' }); return; }
      if (!/^[a-z0-9]+$/.test(tipo)) { LW.mostrarAlerta('Use apenas letras e números no tipo (ex: 2p, sp, 3t).', { tipo: 'aviso' }); return; }
      if (![1, 2].includes(paineisPorBerco)) { LW.mostrarAlerta('Painéis/berço deve ser 1 ou 2 — limitação física da operação.', { tipo: 'aviso' }); return; }
      if (levaCimenticia && (!Number.isFinite(qtdCimenticia) || qtdCimenticia < 1)) {
        LW.mostrarAlerta('Digite a quantidade de cimentícias por painel.', { tipo: 'aviso' });
        return;
      }
      if (_cfgDados.montagens.find(m => m.label === label)) { LW.mostrarAlerta('Este label já existe.', { tipo: 'aviso' }); return; }
      if (_cfgDados.montagens.find(m => m.modo === 'simples' && m.tipo === tipo)) {
        LW.mostrarAlerta('Já existe um tipo simples com esse código de tipo.', { tipo: 'aviso' });
        return;
      }

      _cfgDados.montagens.push({
        label, modo: 'simples', tipo, paineisPorBerco, cor,
        cimenticia: { leva: levaCimenticia, quantidade: levaCimenticia ? qtdCimenticia : 0 },
        // Combinação cor+forma da Referência de Marcação (Setor de
        // Qualidade) — nasce vazia de propósito. Só é preenchida de lá
        // (ver salvarCombinacaoTipo, setor-qualidade.js), nunca aqui no
        // cadastro: cadastrar o tipo e decidir sua marcação visual são
        // passos distintos, e nem sempre feitos pela mesma pessoa.
        combinacaoAvaliacao: null,
      });

      document.getElementById('cfg-mont-simples-label').value = '';
      document.getElementById('cfg-mont-simples-tipo').value = '';
      document.getElementById('cfg-mont-simples-leva-cimenticia').checked = false;
      document.getElementById('cfg-mont-simples-cimenticia-qtd').value = '';
      cfgToggleCimenticiaQtd();
      cfgRenderTudo();
      _cfgSugerirCorMontagem(); // já deixa pronta uma sugestão pro próximo tipo
    }

    // Cria um novo tipo de montagem HÍBRIDA: combina dois tipos simples já
    // cadastrados, sempre 1 painel de cada (2 painéis/berço no total). A
    // cimentícia não é perguntada aqui — é herdada de cada tipo simples na
    // hora do cálculo (calcPaineis(), em data.js).
    function cfgAdicionarMontagemHibrida() {
      const tipo1 = document.getElementById('cfg-mont-hibrida-tipo1').value;
      const tipo2 = document.getElementById('cfg-mont-hibrida-tipo2').value;

      if (!tipo1 || !tipo2) { LW.mostrarAlerta('Escolha os dois tipos que compõem a montagem híbrida.', { tipo: 'aviso' }); return; }
      if (tipo1 === tipo2) { LW.mostrarAlerta('Escolha dois tipos diferentes.', { tipo: 'aviso' }); return; }

      // Label sempre derivado dos 2 tipos escolhidos — nunca digitado (ver
      // _cfgAtualizarLabelHibrida) — recalculado aqui de novo, direto dos
      // selects, em vez de confiar no campo readonly (só exibição).
      const label = `HÍBRIDA ${tipo1.toUpperCase()}/${tipo2.toUpperCase()}`;
      if (_cfgDados.montagens.find(m => m.label === label)) { LW.mostrarAlerta('Este label já existe.', { tipo: 'aviso' }); return; }

      _cfgDados.montagens.push({ label, modo: 'hibrida', tipos: [tipo1, tipo2] });

      document.getElementById('cfg-mont-hibrida-tipo1').value = '';
      document.getElementById('cfg-mont-hibrida-tipo2').value = '';
      _cfgAtualizarLabelHibrida();
      cfgRenderTudo();
    }

    async function cfgRemoverMontagem(i) {
      const m = _cfgDados.montagens[i];
      // Impede remover um tipo simples que está em uso por uma híbrida — ela
      // ficaria referenciando um tipo que não existe mais.
      if (m.modo === 'simples') {
        const usadoEm = _cfgDados.montagens.filter(o => o.modo === 'hibrida' && o.tipos.includes(m.tipo));
        if (usadoEm.length) {
          LW.mostrarAlerta(`Não é possível remover "${m.label}" — está em uso pela(s) montagem(ns) híbrida(s): ${usadoEm.map(o => o.label).join(', ')}.`, { tipo: 'aviso' });
          return;
        }
      }
      const confirmou = await LW.mostrarConfirmacao(
        `Remover o tipo "${m.label}"?`,
        { titulo: 'Remover tipo de montagem', textoConfirmar: 'Remover', tipo: 'perigo', icon: '🗑️' }
      );
      if (!confirmou) return;
      _cfgDados.montagens.splice(i, 1);
      cfgRenderTudo();
    }

    async function cfgSalvar() {
      if (!_cfgDados.baterias.length) { LW.mostrarAlerta('Adicione ao menos uma bateria.', { tipo: 'aviso' }); return; }
      if (!_cfgDados.montagens.length) { LW.mostrarAlerta('Adicione ao menos um tipo de montagem.', { tipo: 'aviso' }); return; }

      // Nova estrutura: dimensão e berços ficam dentro de cada bateria
      // Reconstruímos DIMENSAO_OPTS a partir das baterias (para retrocompatibilidade)
      const dimensoesOpcoes = _derivarDimensoesDeBaterias(_cfgDados.baterias);

      const novasOpcoesMontagem = _cfgDados.montagens.map(_montagemDaUIParaConfig);

      try {
        // IMPORTANTE: busca o config.json de verdade do servidor ANTES de
        // salvar, em vez de reconstruir do zero só com o que esta tela
        // conhece. /salvar-config SUBSTITUI o arquivo inteiro (não faz
        // merge) — então campos que este modal nunca edita (ex:
        // dispositivosAutorizados; modoAutomatico) eram APAGADOS
        // silenciosamente toda vez que alguém salvava Baterias e Tipos de
        // Montagem aqui, mesmo sem mexer neles. Usar `...cfgAtual` como
        // base preserva tudo que já existe; só os campos abaixo são de
        // fato sobrescritos por esta tela. (`tipos_montagem.opcoes` é UM
        // desses campos sobrescritos — por isso `combinacaoAvaliacao` de
        // cada tipo, definida pelo Setor de Qualidade em "📖 Referência"
        // → "Definir combinação", precisa ser preservada no ROUND-TRIP
        // config→UI→config, ver _montagemDoConfigParaUI/
        // _montagemDaUIParaConfig acima — não dá pra confiar só no
        // `...cfgAtual` pra isto, porque tipos_montagem não é herdado
        // dele, é reconstruído do zero a partir de _cfgDados.montagens.)
        const resAtual = await fetch('/db/config.json');
        const cfgAtual = resAtual.ok ? await resAtual.json() : {};

        const cfg = {
          ...cfgAtual,
          baterias: { ids: _cfgDados.baterias },
          dimensoes: { opcoes: dimensoesOpcoes }, // mantido para compatibilidade com registros antigos
          tipos_montagem: { opcoes: novasOpcoesMontagem },
          // Preserva volume_por_placa e dispositivosAutorizados — usa o que
          // acabou de vir do servidor; LW.* só como rede de segurança caso
          // o fetch acima falhe e cfgAtual fique vazio.
          volume_por_placa: cfgAtual.volume_por_placa || LW.VOLUME_POR_PLACA,
          dispositivosAutorizados: cfgAtual.dispositivosAutorizados || LW.DISPOSITIVOS_AUTORIZADOS,
        };

        const res = await fetch('/salvar-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cfg)
        });
        const result = await res.json();
        if (!result.ok) throw new Error(result.erro);
      } catch (e) {
        LW.mostrarAlerta('Erro ao salvar: ' + e.message, { tipo: 'erro' });
        return;
      }

      // Recarrega a página depois de salvar — assim os selects de bateria e
      // tipo de montagem na tela de Registrar Operação (preenchidos só na
      // inicialização) já aparecem atualizados, sem precisar de F5 manual.
      fecharConfig();
      await LW.mostrarAlerta(
        'Configurações salvas com sucesso! A página será recarregada para aplicar as mudanças.',
        { tipo: 'sucesso' }
      );
      window.location.reload();
    }

    // Deriva dimensoes.opcoes a partir de uma lista de baterias — usado por
    // cfgSalvar() (com o rascunho em edição) e _configAtualBaseParaSalvar()
    // (com o que já está carregado), pra manter o campo de compatibilidade
    // "dimensoes" sempre em sincronia com as baterias, sem duplicar lógica.
    function _derivarDimensoesDeBaterias(baterias) {
      const uniqueDims = new Map();
      baterias.forEach(b => {
        if (b.label && b.bercos) uniqueDims.set(b.label, b.bercos);
      });
      return Array.from(uniqueDims.entries()).map(([label, bercos]) => ({ label, bercos }));
    }

    // ---- Dispositivos Autorizados (Configurações → Autorizados) ----
    // Diferente da seção "Baterias e Montagem" (que só salva tudo de uma vez
    // no botão "✓ Salvar Configurações"), aqui cada autorizar/remover salva
    // na hora — não tem o que "cancelar" depois de uma ação tão simples.
    // Por isso monta o config.json inteiro a partir do que já está
    // carregado em memória (igual cfgSalvar() faz com volume_por_placa),
    // só trocando a lista de autorizados.
    function _configAtualBaseParaSalvar() {
      return {
        baterias: { ids: LW.BATERIA_IDS },
        dimensoes: { opcoes: _derivarDimensoesDeBaterias(LW.BATERIA_IDS) },
        tipos_montagem: { opcoes: LW.MONTAGEM_OPCOES },
        volume_por_placa: LW.VOLUME_POR_PLACA,
        dispositivosAutorizados: LW.DISPOSITIVOS_AUTORIZADOS,
      };
    }

    async function _cfgSalvarAutorizados(novaLista) {
      const cfg = _configAtualBaseParaSalvar();
      cfg.dispositivosAutorizados = novaLista;
      const res = await fetch('/salvar-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.erro || 'Erro ao salvar.');
      LW.atualizarDispositivosAutorizados(novaLista);
    }

    async function cfgRenderAutorizados() {
      const meuId = LW.getDeviceId();
      const lista = LW.DISPOSITIVOS_AUTORIZADOS;

      // Dono atual da operação em andamento (se houver uma rodando agora) —
      // usado só pra marcar, na lista de autorizados, qual deles está com o
      // controle nesse momento. Falha de rede aqui não deve travar a tela
      // de Configurações; nesse caso, simplesmente ninguém é marcado.
      let donoDeviceId = null;
      try {
        const operacaoAtual = await LW.getOperacaoAndamento();
        if (operacaoAtual && operacaoAtual.status && operacaoAtual.status !== 'idle') {
          donoDeviceId = operacaoAtual.donoDeviceId || null;
        }
      } catch (_) {
        // sem conexão ou erro ao consultar — segue sem indicar dono
      }

      // Status de "este computador" — feedback imediato de se quem está
      // olhando essa tela agora consegue (ou não) controlar a operação.
      const elStatus = document.getElementById('cfg-autorizados-status');
      let statusHtml;
      if (!lista.length) {
        statusHtml = `<span class="badge badge-gray">⬤ Sem restrição — qualquer computador pode controlar</span>`;
      } else if (lista.some(d => d.deviceId === meuId)) {
        statusHtml = `<span class="badge badge-green">✓ Este computador ESTÁ autorizado</span>`;
      } else {
        statusHtml = `<span class="badge badge-red">⚠ Este computador NÃO está autorizado</span>`;
      }
      elStatus.innerHTML = statusHtml +
        `<div style="font-size:.74rem;color:var(--text-3);margin-top:8px">Device ID deste computador: <span style="font-family:var(--font-mono)">${meuId}</span></div>`;

      // Lista de autorizados
      const elLista = document.getElementById('cfg-autorizados-lista');
      elLista.innerHTML = lista.map(d => `
    <div style="display:flex;align-items:center;gap:12px;background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;flex-wrap:wrap">
      <span style="font-size:.85rem;font-weight:700;color:var(--text);min-width:120px">${d.nome ? _escaparHtmlLocal(d.nome) : '(sem nome)'}</span>
      <span style="font-family:var(--font-mono);font-size:.75rem;color:var(--text-2)">${_escaparHtmlLocal(d.deviceId)}</span>
      ${d.deviceId === meuId ? '<span style="font-size:.7rem;color:var(--green)">← este computador</span>' : ''}
      ${d.deviceId === donoDeviceId ? `<span class="badge badge-green" style="font-size:.7rem;cursor:pointer;text-decoration:underline" onclick="cfgCancelarOperacaoDono('${_escaparHtmlLocal(d.deviceId)}')" title="Clique para cancelar a operação em andamento">🟢 Operando agora${d.nome ? '' : ' — ' + _escaparHtmlLocal(d.deviceId)}</span>` : ''}
      <button onclick="cfgRemoverAutorizado('${_escaparHtmlLocal(d.deviceId)}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:.85rem;margin-left:auto">✕ Remover</button>
    </div>
  `).join('') || '<span style="color:var(--text-3);font-size:.82rem">Nenhum dispositivo autorizado ainda.</span>';

      // Convenience: pré-preenche o campo de Device ID com o deste
      // computador — é o caso mais comum (autorizar a própria máquina).
      const inputDeviceId = document.getElementById('cfg-autorizado-deviceid');
      if (inputDeviceId && !inputDeviceId.value) inputDeviceId.value = meuId;
    }

    /**
     * Clique no badge "🟢 Operando agora" (Configurações → Autorizados):
     * cancela a operação em andamento — equivalente ao "🗑️ Limpar Tudo" de
     * Registrar Operação, só que disparado daqui, pelo Administrador, sem
     * precisar estar com aquela tela aberta. Nada do que foi preenchido na
     * operação é salvo; ela simplesmente é descartada.
     *
     * Dupla confirmação, de propósito: primeiro a pergunta "tem certeza?"
     * (LW.mostrarConfirmacao, mesmo padrão usado em todo o resto do app),
     * depois a senha do Administrador (AdminAuth.abrirModal — mesmo modal
     * usado no login, sempre pede a senha de novo, mesmo já autenticado).
     * Só depois das duas a operação é de fato cancelada.
     */
    async function cfgCancelarOperacaoDono(deviceId) {
      const dispositivo = LW.DISPOSITIVOS_AUTORIZADOS.find(d => d.deviceId === deviceId);
      const identificacao = dispositivo?.nome || deviceId;

      const confirmou = await LW.mostrarConfirmacao(
        `A operação em andamento foi iniciada por "${identificacao}". Cancelar agora descarta tudo o que já foi preenchido nela — turno, traços, horários — sem salvar nada. A operação ficará liberada para qualquer dispositivo autorizado iniciar uma nova.`,
        { titulo: 'Cancelar a operação em andamento?', textoConfirmar: 'Cancelar Operação', tipo: 'perigo', icon: '🛑' }
      );
      if (!confirmou) return;

      if (typeof AdminAuth === 'undefined') {
        LW.mostrarAlerta('Não foi possível confirmar a senha de administrador nesta tela.', { tipo: 'erro' });
        return;
      }

      AdminAuth.abrirModal(async function onSuccess() {
        try {
          const res = await fetch('/admin/resetar-operacao', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // corpo vazio — a sessão já está no cookie (HttpOnly, SameSite=Strict),
            // o servidor lê direto do request sem precisar de nada no body
            body: JSON.stringify({}),
          });
          const json = await res.json().catch(() => null);
          if (!res.ok) {
            LW.mostrarAlerta(json?.erro || 'Não foi possível cancelar a operação. Tente novamente.', { tipo: 'erro' });
            return;
          }
          LW.mostrarAlerta('Operação cancelada. A operação está liberada para ser iniciada por qualquer dispositivo autorizado.', { tipo: 'sucesso' });
          cfgRenderAutorizados();
        } catch (_) {
          LW.mostrarAlerta('Erro de conexão ao cancelar a operação. Verifique a rede e tente novamente.', { tipo: 'erro' });
        }
      });
    }

    // existente no escopo global, então replica a mesma lógica usada em
    // data.js (_escaparHtml) só pra estes dois campos de texto livre.
    function _escaparHtmlLocal(texto) {
      const div = document.createElement('div');
      div.textContent = String(texto ?? '');
      return div.innerHTML;
    }

    async function cfgAdicionarAutorizado() {
      const inputNome = document.getElementById('cfg-autorizado-nome');
      const inputDeviceId = document.getElementById('cfg-autorizado-deviceid');

      const nome = inputNome.value.trim();
      const deviceId = inputDeviceId.value.trim();

      if (!deviceId) { LW.mostrarAlerta('Cole o Device ID do computador a autorizar.', { tipo: 'aviso' }); return; }
      if (LW.DISPOSITIVOS_AUTORIZADOS.some(d => d.deviceId === deviceId)) {
        LW.mostrarAlerta('Este Device ID já está autorizado.', { tipo: 'aviso' });
        return;
      }

      const novaLista = [
        ...LW.DISPOSITIVOS_AUTORIZADOS,
        { deviceId, nome, autorizadoEm: new Date().toISOString() },
      ];

      try {
        await _cfgSalvarAutorizados(novaLista);
      } catch (e) {
        LW.mostrarAlerta('Erro ao autorizar: ' + e.message, { tipo: 'erro' });
        return;
      }

      inputNome.value = '';
      inputDeviceId.value = '';
      cfgRenderAutorizados();
    }

    async function cfgRemoverAutorizado(deviceId) {
      const dispositivo = LW.DISPOSITIVOS_AUTORIZADOS.find(d => d.deviceId === deviceId);
      const confirmou = await LW.mostrarConfirmacao(
        `Remover a autorização de "${dispositivo?.nome || deviceId}"? Se a lista ficar vazia, qualquer computador volta a poder controlar operações.`,
        { titulo: 'Remover dispositivo autorizado', textoConfirmar: 'Remover', tipo: 'perigo', icon: '🗑️' }
      );
      if (!confirmou) return;

      const novaLista = LW.DISPOSITIVOS_AUTORIZADOS.filter(d => d.deviceId !== deviceId);

      try {
        await _cfgSalvarAutorizados(novaLista);
      } catch (e) {
        LW.mostrarAlerta('Erro ao remover: ' + e.message, { tipo: 'erro' });
        return;
      }

      cfgRenderAutorizados();
    }



    // ---- Editar Operação (admin) — Registro de Baterias ----
    // Só os campos preenchidos manualmente podem ser corrigidos aqui (ID
    // Bateria, Berços Reais, Tipo de Montagem, Turno, Motivo do Atraso).
    // Data, início, fim, duração, houve_atraso (calculado a partir do tempo)
    // e tudo que é calculado (painéis, m², cimentícia) NUNCA são editados
    // diretamente — recalculados automaticamente quando bateria/berços/tipo
    // de montagem mudam (ver _eoAtualizarPreview).
    let _eoRegistroOriginal = null;
    // true assim que o admin digitar manualmente em Berços Reais — a partir
    // daí, trocar de bateria não sobrescreve mais o valor (ver
    // _eoAoMudarBateria). Evita o bug de "troquei a bateria, voltei pra
    // original, mas o berço ficou com o valor da bateria errada".
    let _eoBercosTocadoManualmente = false;
    // Cópia de trabalho da grade berço-a-berço (Montagem Personalizada) —
    // igual à _gradeTrabalho de operacao.js, mas separada dela de
    // propósito: aqui é a edição de uma operação JÁ SALVA, não o rascunho
    // de uma operação em andamento, então nunca deve tocar em
    // state/persist() de operacao.js. Só vai pro servidor se o admin
    // clicar "Salvar Alterações" (ver salvarEdicaoOperacao).
    let _eoBercosPersonalizados = [];

    function abrirEdicaoOperacao(bateria) {
      if (sessionStorage.getItem('lw_role') !== 'Administrador') return;
      _eoRegistroOriginal = JSON.parse(JSON.stringify(bateria));
      _eoBercosTocadoManualmente = false;
      _eoBercosPersonalizados = Array.isArray(bateria.bercos_personalizados)
        ? [...bateria.bercos_personalizados]
        : [];

      document.getElementById('eo-erro').style.display = 'none';

      document.getElementById('eo-ro-data').textContent = bateria.data ? bateria.data.split('-').reverse().join('/') : '—';
      document.getElementById('eo-ro-inicio').textContent = bateria.inicio ? LW.formatTime(bateria.inicio) : '—';
      document.getElementById('eo-ro-fim').textContent = bateria.fim ? LW.formatTime(bateria.fim) : '—';
      document.getElementById('eo-ro-desemplaque').textContent =
        LW.formatDateTime(bateria.desemplaque || LW.calcularDesemplaque(bateria.fim));
      document.getElementById('eo-ro-duracao').textContent = LW.formatDuration(bateria.tempo_min);
      document.getElementById('eo-ro-tracos').textContent = bateria.qtd_tracos || 0;
      document.getElementById('eo-ro-atraso').textContent = bateria.houve_atraso === 'SIM' ? '⚠ SIM' : '✓ NÃO';

      const selBateria = document.getElementById('eo-id-bateria');
      selBateria.innerHTML = LW.BATERIA_IDS.map(b =>
        `<option value="${b.id}">${b.id} — ${b.label || ''} (${b.bercos} berços)</option>`).join('');
      selBateria.value = bateria.id_bateria;

      const selTipo = document.getElementById('eo-tipo-montagem');
      // "Personalizada" NUNCA vem em LW.MONTAGEM_OPTS (não é um tipo
      // cadastrado em Configurações — é um modo à parte, ver
      // operacao.js/_aplicarTiposMontagem). Sem essa opção aqui, editar
      // uma operação Personalizada deixava o select sem nenhum valor
      // correspondente (bateria.tipo_montagem === 'PERSONALIZADA' não
      // batia com nenhuma <option>) — o que travava até EDITAR OUTROS
      // CAMPOS dessa operação: "Selecione o tipo de montagem" barrava o
      // salvamento porque o select ficava vazio.
      selTipo.innerHTML = LW.MONTAGEM_OPTS.map(t => `<option value="${t}">${t}</option>`).join('') +
        `<option value="${LW.TIPO_MONTAGEM_PERSONALIZADA}">Personalizada</option>`;
      selTipo.value = bateria.tipo_montagem;

      document.getElementById('eo-bercos-reais').value = bateria.bercos_reais || bateria.capacidade || '';
      document.getElementById('eo-turno').value = bateria.turno || '1º TURNO';
      document.getElementById('eo-motivo-atraso').value = bateria.motivo_atraso || '';
      // Motivo do atraso só faz sentido editar se ESTA operação teve atraso
      // (o fato em si — houve_atraso — não é editável, é calculado).
      document.getElementById('eo-motivo-atraso-wrap').style.display = bateria.houve_atraso === 'SIM' ? 'block' : 'none';
      _eoAtualizarPreview();

      document.getElementById('editar-operacao-modal').style.display = 'flex';
    }

    function fecharEdicaoOperacao() {
      document.getElementById('editar-operacao-modal').style.display = 'none';
      _eoRegistroOriginal = null;
    }

    // Disparado ao DIGITAR manualmente em Berços Reais — marca que o admin
    // assumiu o controle desse campo, então trocar de bateria depois não
    // deve mais sobrescrever o que ele digitou.
    function _eoAoEditarBercosManualmente() {
      _eoBercosTocadoManualmente = true;
      _eoAtualizarPreview();
    }

    // Ao trocar a bateria, sugere os berços da bateria nova selecionada —
    // cobre o caso "registrei B1 mas era B6": berços e dimensão seguem a
    // bateria certa automaticamente. Sempre que a bateria muda (inclusive
    // voltando pra original), os berços acompanham — a não ser que o admin
    // já tenha digitado um valor manual nessa mesma edição.
    function _eoAoMudarBateria() {
      const idBateria = document.getElementById('eo-id-bateria').value;
      const bateriaObj = LW.BATERIA_IDS.find(b => b.id === idBateria);
      if (bateriaObj && !_eoBercosTocadoManualmente) {
        document.getElementById('eo-bercos-reais').value = bateriaObj.bercos;
      }
      _eoAtualizarPreview();
    }

    // Recalcula painéis/m²/cimentícia em tempo real (mesma fórmula de
    // sempre, LW.calcPaineis) e mostra o resultado — só pra visualização,
    // quem efetivamente grava esses valores é salvarEdicaoOperacao().
    //
    // Personalizada é um caso à parte: LW.calcPaineis() espera UM tipo
    // só pra bateria inteira (map[tipoMontagem]) — pra 'PERSONALIZADA'
    // isso não existe em MONTAGEM_MAP, então caía no fallback histórico
    // "trata como S/P puro" (ver calcPaineis, data.js), recalculando tudo
    // errado mesmo sem essa tela ter como editar a grade berço a berço.
    // Usa _eoBercosPersonalizados (cópia de trabalho, editável pelo botão
    // "Configurar Berços" — ver _eoAbrirGradeMontagem), não mais o array
    // congelado de _eoRegistroOriginal: antes a grade em si não era
    // editável por aqui, então usar a grade ORIGINAL como fonte de
    // verdade dos totais era a única opção; agora que dá pra editar,
    // precisa refletir o que está sendo editado nesta tela.
    function _eoCalcularPaineis(tipoMontagem, bercos) {
      if (tipoMontagem === LW.TIPO_MONTAGEM_PERSONALIZADA) {
        return LW.calcPaineisPersonalizado(_eoBercosPersonalizados);
      }
      return LW.calcPaineis(tipoMontagem, bercos);
    }

    // Mostra/esconde o botão "Configurar Berços" (grade da Montagem
    // Personalizada) de acordo com o tipo de montagem selecionado — mesmo
    // padrão do botão equivalente em Registrar Operação (ver
    // _atualizarVisibilidadeConfigurarBercos em operacao.js).
    function _eoAtualizarBotaoBercos() {
      const tipoMontagem = document.getElementById('eo-tipo-montagem').value;
      const btn = document.getElementById('eo-btn-configurar-bercos');
      if (btn) btn.style.display = tipoMontagem === LW.TIPO_MONTAGEM_PERSONALIZADA ? 'inline-flex' : 'none';
    }

    // Abre a mesma grade berço-a-berço de Registrar Operação (ver
    // LWOp.abrirGradeMontagem em operacao.js), mas em modo genérico: não
    // toca em state/persist() de operacao.js — só recebe o array
    // resultante e guarda em _eoBercosPersonalizados, atualizando o
    // preview de painéis/m² em seguida.
    async function _eoAbrirGradeMontagem() {
      const idBateria = document.getElementById('eo-id-bateria').value;
      const bateriaObj = LW.BATERIA_IDS.find(b => b.id === idBateria);
      if (!bateriaObj) {
        LW.mostrarAlerta('Selecione a bateria antes de configurar os berços.', { tipo: 'aviso' });
        return;
      }
      await LWOp.abrirGradeMontagem({
        capacidade: bateriaObj.bercos || 0,
        valoresIniciais: _eoBercosPersonalizados,
        tituloBateria: bateriaObj.id,
        onConfirmar(resultado) {
          _eoBercosPersonalizados = resultado;
          _eoAtualizarPreview();
        },
      });
    }

    function _eoAtualizarPreview() {
      const idBateria = document.getElementById('eo-id-bateria').value;
      const tipoMontagem = document.getElementById('eo-tipo-montagem').value;
      const bercos = parseInt(document.getElementById('eo-bercos-reais').value) || 0;
      const bateriaObj = LW.BATERIA_IDS.find(b => b.id === idBateria);

      _eoAtualizarBotaoBercos();

      const calc = _eoCalcularPaineis(tipoMontagem, bercos);
      document.getElementById('eo-preview').innerHTML = `
        <div>Dimensão: <strong style="color:var(--text)">${bateriaObj?.label || '—'}</strong></div>
        <div>Painéis Total: <strong style="color:var(--text)">${calc.total_paineis}</strong></div>
        <div>m² Total: <strong style="color:var(--text)">${calc.m2_total.toFixed(2)}</strong></div>
        <div>Placas Cimentícia: <strong style="color:var(--text)">${calc.placas_cimenticia}</strong></div>
      `;
    }

    async function salvarEdicaoOperacao() {
      if (!_eoRegistroOriginal) return;
      document.getElementById('eo-erro').style.display = 'none';

      const idBateria = document.getElementById('eo-id-bateria').value;
      const tipoMontagem = document.getElementById('eo-tipo-montagem').value;
      const bercos = parseInt(document.getElementById('eo-bercos-reais').value) || 0;
      const turno = document.getElementById('eo-turno').value;
      // houve_atraso NÃO é editável (calculado a partir do tempo da
      // operação) — o motivo só é salvo se a operação JÁ tinha atraso.
      const motivoAtraso = _eoRegistroOriginal.houve_atraso === 'SIM'
        ? document.getElementById('eo-motivo-atraso').value.trim()
        : (_eoRegistroOriginal.motivo_atraso || '');

      if (!idBateria) { LW.mostrarAlerta('Selecione a bateria.', { tipo: 'aviso' }); return; }
      if (!tipoMontagem) { LW.mostrarAlerta('Selecione o tipo de montagem.', { tipo: 'aviso' }); return; }
      if (!bercos || bercos < 1) { LW.mostrarAlerta('Informe a quantidade de berços reais.', { tipo: 'aviso' }); return; }
      if (tipoMontagem === LW.TIPO_MONTAGEM_PERSONALIZADA && (!_eoBercosPersonalizados.length || _eoBercosPersonalizados.every(t => !t))) {
        LW.mostrarAlerta('Configure os berços da Montagem Personalizada antes de salvar (botão 🔧 Configurar Berços).', { tipo: 'aviso' });
        return;
      }

      const bateriaObj = LW.BATERIA_IDS.find(b => b.id === idBateria);
      const calc = _eoCalcularPaineis(tipoMontagem, bercos);

      const novosValores = {
        id_bateria: idBateria,
        dimensao: bateriaObj?.label || _eoRegistroOriginal.dimensao,
        capacidade: bateriaObj?.bercos || _eoRegistroOriginal.capacidade,
        bercos_reais: bercos,
        tipo_montagem: tipoMontagem,
        turno,
        motivo_atraso: motivoAtraso,
        ...(tipoMontagem === LW.TIPO_MONTAGEM_PERSONALIZADA ? { bercos_personalizados: _eoBercosPersonalizados } : {}),
        ...calc,
      };

      // Monta o diff (só os campos que de fato mudaram) — vai pro log de
      // auditoria em historico_edicoes.json.
      const diff = [];
      Object.keys(novosValores).forEach(campo => {
        const de = _eoRegistroOriginal[campo];
        const para = novosValores[campo];
        const mudou = (typeof de === 'object' || typeof para === 'object')
          ? JSON.stringify(de) !== JSON.stringify(para)
          : de !== para;
        if (mudou) diff.push({ campo, de: de ?? null, para: para ?? null });
      });

      if (!diff.length) {
        LW.mostrarAlerta('Nenhuma alteração foi feita.', { tipo: 'aviso' });
        return;
      }
      const confirmouEdicao = await LW.mostrarConfirmacao(
        `Confirma a alteração de ${diff.length} campo(s) nesta operação?`,
        { titulo: 'Confirmar edição', textoConfirmar: 'Salvar Alteração', icon: '✏️' }
      );
      if (!confirmouEdicao) return;

      const btn = document.getElementById('eo-btn-salvar');
      const textoOriginal = btn.textContent;
      try {
        btn.disabled = true;
        btn.textContent = 'Salvando...';

        const res = await fetch('/editar-operacao', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: _eoRegistroOriginal.id, novosValores, diff }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.erro || 'Erro ao salvar edição.');

        fecharEdicaoOperacao();
        await LWDash.initRegistro();
        LW.mostrarAlerta('Operação atualizada com sucesso!', { tipo: 'sucesso' });
      } catch (e) {
        const erroEl = document.getElementById('eo-erro');
        erroEl.textContent = e.message;
        erroEl.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.textContent = textoOriginal;
      }
    }

    // ================================================================
    //  EDITAR TRAÇO (Relatório de Injeção, admin)
    // ================================================================
    // Diferente da Edição de Operação (campo a campo, diff simples), aqui
    // a parte mais delicada são os "ajustes": ajustes_tracos.json passa a
    // ser a FONTE DE VERDADE da lista (cada item = uma ação real, com
    // tempo de batida + insumos que vieram juntos) — os campos
    // "*_real"/tempo_batida de relatorio_injecao.json são DERIVADOS dela
    // no servidor ao salvar (ver /editar-traco-relatorio). Esta tela só
    // edita a lista; nunca monta os arrays ".ajustes[]" na mão.

    let _etTracoOriginal = null;  // cópia profunda do traço (l) ao abrir
    let _etUsoOriginal = null;    // cópia profunda do uso (op) ao abrir
    let _etAjustesOriginaisCarregados = []; // cópia da lista de ajustes tal como veio de ajustes_tracos.json, só pra diff
    let _etAjustesAtuais = [];    // [{tempo_batida(min), cimento?, agua?, eps?, superplast?, incorporador?, registrado_em?}]
    let _etLeiturasDensidade = []; // [number, ...] — remedições de densidade
    let _etLeiturasFlow = [];      // [number, ...] — remedições de flow

    // Extrai o valor "original" de um campo que pode ser número simples OU
    // {original, ajustes}. Mesma lógica usada na exibição (dashboard.js
    // _valRel), só que pegando o original em vez do total.
    function _etExtrairOriginal(v) {
      if (v && typeof v === 'object' && 'original' in v) return (v.original === '' ? '' : v.original);
      return (v === undefined || v === null) ? '' : v;
    }
    function _etExtrairAjustesNumericos(v) {
      return (v && typeof v === 'object' && Array.isArray(v.ajustes)) ? [...v.ajustes] : [];
    }

    // ---- Relógio (h:m:s) de Tempo de Batida — mesma lógica de conversão
    // usada no picker de Registrar Operação (operacao.js: segParaHMS/hmsParaSeg) ----
    function _etSegParaHMS(seg) {
      const s = Math.max(0, Math.round(seg || 0));
      return { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 };
    }
    function _etHmsParaSeg(h, m, s) {
      return (parseInt(h) || 0) * 3600 + (parseInt(m) || 0) * 60 + (parseInt(s) || 0);
    }
    // tempo_batida.original (relatorio_injecao.json) está em SEGUNDOS; o
    // formulário envia tempo_batida_min (minutos) — mesma conversão que
    // já era feita no número simples, só que agora a partir do relógio.
    function _etSegParaMin(seg) {
      return Math.round((seg / 60) * 100) / 100;
    }
    // ajustes_tracos.json guarda tempo_batida em MINUTOS — converte pra
    // h:m:s (via segundos) só pra exibir no relógio.
    function _etMinParaHMS(min) {
      return _etSegParaHMS(Math.round((min || 0) * 60));
    }

    async function abrirEdicaoTraco(traco, uso) {
      if (sessionStorage.getItem('lw_role') !== 'Administrador') return;
      _etTracoOriginal = JSON.parse(JSON.stringify(traco));
      _etUsoOriginal = JSON.parse(JSON.stringify(uso || {}));

      document.getElementById('et-erro').style.display = 'none';

      document.getElementById('et-ro-data').textContent = traco.data ? traco.data.split('-').reverse().join('/') : '—';
      document.getElementById('et-ro-turno').textContent = traco.turno || '—';
      document.getElementById('et-ro-id-traco').textContent = traco.id_traco || '—';
      document.getElementById('et-ro-id-operacao').textContent = uso?.id_operacao || '—';

      document.getElementById('et-num-traco').value = traco.num_traco ?? '';
      document.getElementById('et-densidade-eps').value = traco.densidade_eps ?? '';
      document.getElementById('et-silo').value = traco.silo ?? '';
      document.getElementById('et-expansao').value = traco.expansao ?? '';

      const selBateria = document.getElementById('et-id-bateria');
      selBateria.innerHTML = LW.BATERIA_IDS.map(b =>
        `<option value="${b.id}">${b.id} — ${b.label || ''} (${b.bercos} berços)</option>`).join('');
      selBateria.value = uso?.id_bateria || '';
      document.getElementById('et-berco-inicio').value = uso?.berco_inicio ?? '';
      document.getElementById('et-berco-fim').value = uso?.berco_finalizacao ?? '';
      document.getElementById('et-obs').value = (uso?.obs !== undefined ? uso.obs : traco.obs) || '';

      document.getElementById('et-original-cimento').value = _etExtrairOriginal(traco.cimento_real);
      document.getElementById('et-original-agua').value = _etExtrairOriginal(traco.agua_real);
      document.getElementById('et-original-eps').value = _etExtrairOriginal(traco.eps_real);
      document.getElementById('et-original-superplast').value = _etExtrairOriginal(traco.superplast_real);
      document.getElementById('et-original-incorporador').value = _etExtrairOriginal(traco.incorporador_real);
      // tempo_batida.original está em SEGUNDOS em relatorio_injecao.json — mostra no relógio h:m:s
      const origTempoSeg = _etExtrairOriginal(traco.tempo_batida);
      const hmsOriginal = _etSegParaHMS(origTempoSeg === '' ? 0 : origTempoSeg);
      document.getElementById('et-original-tempo-h').value = hmsOriginal.h;
      document.getElementById('et-original-tempo-m').value = hmsOriginal.m;
      document.getElementById('et-original-tempo-s').value = hmsOriginal.s;

      document.getElementById('et-original-densidade').value = _etExtrairOriginal(traco.densidade);
      document.getElementById('et-original-flow').value = _etExtrairOriginal(traco.flow);
      _etLeiturasDensidade = _etExtrairAjustesNumericos(traco.densidade);
      _etLeiturasFlow = _etExtrairAjustesNumericos(traco.flow);
      _etRenderLeituras();

      // ajustes_tracos.json é a fonte de verdade da lista de ajustes —
      // carrega direto dele, não dos arrays soltos de relatorio_injecao.json
      // (que podem nem estar correlacionados entre si — ver decisão no chat).
      let entradaAjustes = null;
      try {
        const todosAjustes = await LW.getAjustesTracos();
        entradaAjustes = todosAjustes.find(a => a.id_traco === traco.id_traco) || null;
      } catch (_) { /* segue com lista vazia */ }

      _etAjustesAtuais = [];
      if (entradaAjustes) {
        Object.keys(entradaAjustes)
          .filter(k => /^ajuste_\d+$/.test(k))
          .sort((a, b) => parseInt(a.split('_')[1], 10) - parseInt(b.split('_')[1], 10))
          .forEach(k => _etAjustesAtuais.push({ ...entradaAjustes[k] }));
      }
      _etAjustesOriginaisCarregados = JSON.parse(JSON.stringify(_etAjustesAtuais));
      _etRenderAjustes();

      document.getElementById('editar-traco-modal').style.display = 'flex';
    }

    // Ajusta um campo (h/m/s) do relógio do tempo de batida original com
    // ▲▼ — mesmo padrão de wrap-around do picker de Registrar Operação.
    function _etAjustarDuracaoOriginal(campo, delta) {
      const el = document.getElementById(`et-original-tempo-${campo}`);
      if (!el) return;
      const max = campo === 'h' ? 23 : 59;
      let val = (parseInt(el.value) || 0) + delta;
      if (val < 0) val = max;
      if (val > max) val = 0;
      el.value = val;
    }
    // Só pra normalizar o campo se o admin digitar direto (sem setas).
    function _etOnDuracaoOriginalInput() { /* leitura é feita ao salvar — ver _etLerDuracaoOriginalMin() */ }

    // Lê o relógio h:m:s do tempo de batida original e devolve em MINUTOS
    // (formato que o servidor espera em originais.tempo_batida_min).
    function _etLerDuracaoOriginalMin() {
      const h = document.getElementById('et-original-tempo-h').value;
      const m = document.getElementById('et-original-tempo-m').value;
      const s = document.getElementById('et-original-tempo-s').value;
      const seg = _etHmsParaSeg(h, m, s);
      return seg === 0 ? '' : _etSegParaMin(seg);
    }

    function fecharEdicaoTraco() {
      document.getElementById('editar-traco-modal').style.display = 'none';
      _etTracoOriginal = null;
      _etUsoOriginal = null;
    }

    function _etRenderAjustes() {
      const cont = document.getElementById('et-lista-ajustes');
      if (!_etAjustesAtuais.length) {
        cont.innerHTML = '<div style="color:var(--text-3);font-size:.82rem;padding:8px 0">Nenhum ajuste registrado pra este traço.</div>';
        return;
      }
      const CAMPOS = [
        { nome: 'cimento', label: 'Cimento' }, { nome: 'agua', label: 'Água' },
        { nome: 'eps', label: 'EPS' }, { nome: 'superplast', label: 'Superplast.' },
        { nome: 'incorporador', label: 'Incorp. Ar' },
      ];
      cont.innerHTML = _etAjustesAtuais.map((a, i) => {
        const hms = _etMinParaHMS(a.tempo_batida);
        return `
        <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);padding:10px;margin-bottom:8px">
          <div style="font-size:.7rem;color:var(--text-3);width:100%;margin-bottom:-2px">Ajuste #${i + 1}${a.registrado_em ? ' — ' + LW.formatDateTime(a.registrado_em) : ' (novo)'}</div>
          <div class="form-group" style="margin:0;width:190px">
            <label class="form-label" style="font-size:.68rem">⏱ Batida *</label>
            <div class="duration-picker duration-picker--sm">
              <div class="duration-col">
                <button type="button" class="dur-btn dur-up" onclick="_etAjustarDuracaoAjuste(${i},'h',1)">▲</button>
                <input class="dur-input" type="number" min="0" max="23" id="et-aj-${i}-h" value="${hms.h}" readonly>
                <button type="button" class="dur-btn dur-dn" onclick="_etAjustarDuracaoAjuste(${i},'h',-1)">▼</button>
                <span class="dur-label">h</span>
              </div>
              <span class="dur-sep">:</span>
              <div class="duration-col">
                <button type="button" class="dur-btn dur-up" onclick="_etAjustarDuracaoAjuste(${i},'m',1)">▲</button>
                <input class="dur-input" type="number" min="0" max="59" id="et-aj-${i}-m" value="${hms.m}" readonly>
                <button type="button" class="dur-btn dur-dn" onclick="_etAjustarDuracaoAjuste(${i},'m',-1)">▼</button>
                <span class="dur-label">min</span>
              </div>
              <span class="dur-sep">:</span>
              <div class="duration-col">
                <button type="button" class="dur-btn dur-up" onclick="_etAjustarDuracaoAjuste(${i},'s',1)">▲</button>
                <input class="dur-input" type="number" min="0" max="59" id="et-aj-${i}-s" value="${hms.s}" readonly>
                <button type="button" class="dur-btn dur-dn" onclick="_etAjustarDuracaoAjuste(${i},'s',-1)">▼</button>
                <span class="dur-label">seg</span>
              </div>
            </div>
          </div>
          ${CAMPOS.map(c => `
          <div class="form-group" style="margin:0;width:95px">
            <label class="form-label" style="font-size:.68rem">${c.label}</label>
            <input class="form-input" type="number" step="0.01" value="${a[c.nome] ?? ''}" placeholder="—"
              oninput="_etAtualizarAjuste(${i},'${c.nome}',this.value)">
          </div>`).join('')}
          <button type="button" onclick="_etRemoverAjuste(${i})" title="Remover este ajuste"
            style="background:none;border:none;color:var(--red);cursor:pointer;font-size:1rem;margin-left:auto">✕</button>
        </div>
      `;
      }).join('');
    }

    // Ajusta um campo (h/m/s) do relógio de um ajuste específico (i) com
    // ▲▼ — readonly/só-setas, igual ao modal de Ajuste de Receita ao vivo
    // (operacao.js) — e já recalcula o total em minutos pro state.
    function _etAjustarDuracaoAjuste(i, campo, delta) {
      const el = document.getElementById(`et-aj-${i}-${campo}`);
      if (!el) return;
      const max = campo === 'h' ? 23 : 59;
      let val = (parseInt(el.value) || 0) + delta;
      if (val < 0) val = max;
      if (val > max) val = 0;
      el.value = val;

      const h = document.getElementById(`et-aj-${i}-h`).value;
      const m = document.getElementById(`et-aj-${i}-m`).value;
      const s = document.getElementById(`et-aj-${i}-s`).value;
      const seg = _etHmsParaSeg(h, m, s);
      _etAtualizarAjuste(i, 'tempo_batida', seg === 0 ? '' : _etSegParaMin(seg));
    }

    function _etAtualizarAjuste(i, campo, valor) {
      if (!_etAjustesAtuais[i]) return;
      if (valor === '') { delete _etAjustesAtuais[i][campo]; return; }
      _etAjustesAtuais[i][campo] = parseFloat(valor);
    }

    function _etRemoverAjuste(i) {
      _etAjustesAtuais.splice(i, 1);
      _etRenderAjustes();
    }

    function _etAdicionarAjuste() {
      _etAjustesAtuais.push({}); // registrado_em ausente = será estampado agora, no servidor
      _etRenderAjustes();
    }

    function _etRenderLeituras() {
      const fmt = (campo, lista) => lista.map((v, i) => `
        <span style="display:inline-flex;align-items:center;gap:6px;background:var(--bg-2);border:1px solid var(--border);border-radius:20px;padding:4px 6px 4px 12px;margin:0 6px 6px 0;font-size:.82rem">
          <input type="number" step="0.01" value="${v}" style="width:64px;background:none;border:none;color:var(--text);font-family:var(--font-mono)"
            oninput="_etAtualizarLeitura('${campo}',${i},this.value)">
          <button type="button" onclick="_etRemoverLeitura('${campo}',${i})" title="Remover esta leitura"
            style="background:none;border:none;color:var(--red);cursor:pointer;padding:2px">✕</button>
        </span>
      `).join('') || '<span style="color:var(--text-3);font-size:.8rem">Nenhuma remedição.</span>';

      document.getElementById('et-leituras-densidade').innerHTML = fmt('densidade', _etLeiturasDensidade);
      document.getElementById('et-leituras-flow').innerHTML = fmt('flow', _etLeiturasFlow);
    }

    function _etAtualizarLeitura(campo, i, valor) {
      const lista = campo === 'densidade' ? _etLeiturasDensidade : _etLeiturasFlow;
      lista[i] = parseFloat(valor) || 0;
    }
    function _etRemoverLeitura(campo, i) {
      const lista = campo === 'densidade' ? _etLeiturasDensidade : _etLeiturasFlow;
      lista.splice(i, 1);
      _etRenderLeituras();
    }
    function _etAdicionarLeitura(campo) {
      const lista = campo === 'densidade' ? _etLeiturasDensidade : _etLeiturasFlow;
      lista.push(0);
      _etRenderLeituras();
    }

    async function salvarEdicaoTraco() {
      if (!_etTracoOriginal) return;
      const erroEl = document.getElementById('et-erro');
      erroEl.style.display = 'none';

      // Cada ajuste precisa de tempo de batida > 0 — mesma regra do Ajuste
      // de Receita ao vivo. Valida ANTES de montar o payload.
      for (let i = 0; i < _etAjustesAtuais.length; i++) {
        const tb = _etAjustesAtuais[i].tempo_batida;
        if (typeof tb !== 'number' || isNaN(tb) || tb <= 0) {
          LW.mostrarAlerta(`Ajuste #${i + 1}: informe o tempo de batida (minutos, maior que zero).`, { tipo: 'aviso' });
          return;
        }
      }

      const lerNum = id => { const v = document.getElementById(id).value; return v === '' ? '' : parseFloat(v); };
      const lerTxt = id => document.getElementById(id).value.trim();

      const novosValores = {
        num_traco: document.getElementById('et-num-traco').value === '' ? '' : parseInt(document.getElementById('et-num-traco').value, 10),
        densidade_eps: lerTxt('et-densidade-eps'),
        silo: lerTxt('et-silo'),
        expansao: lerTxt('et-expansao'),
        uso: {
          id_bateria: document.getElementById('et-id-bateria').value,
          berco_inicio: lerTxt('et-berco-inicio'),
          berco_finalizacao: lerTxt('et-berco-fim'),
          obs: document.getElementById('et-obs').value,
        },
        originais: {
          cimento_real: lerNum('et-original-cimento'),
          agua_real: lerNum('et-original-agua'),
          eps_real: lerNum('et-original-eps'),
          superplast_real: lerNum('et-original-superplast'),
          incorporador_real: lerNum('et-original-incorporador'),
          tempo_batida_min: _etLerDuracaoOriginalMin(),
        },
        densidade: { original: lerNum('et-original-densidade'), leituras: _etLeiturasDensidade },
        flow: { original: lerNum('et-original-flow'), leituras: _etLeiturasFlow },
      };

      // Diff por BLOCO (não campo a campo, diferente da Edição de Operação)
      // — comparar o valor final calculado de cada insumo exigiria
      // replicar no navegador a mesma lógica de derivação que o servidor
      // já faz; mais simples e igualmente útil pra auditoria comparar os
      // blocos de entrada inteiros.
      const blocosOriginais = {
        identificacao: {
          num_traco: _etTracoOriginal.num_traco, densidade_eps: _etTracoOriginal.densidade_eps,
          silo: _etTracoOriginal.silo, expansao: _etTracoOriginal.expansao,
        },
        uso: {
          id_bateria: _etUsoOriginal.id_bateria, berco_inicio: _etUsoOriginal.berco_inicio,
          berco_finalizacao: _etUsoOriginal.berco_finalizacao, obs: _etUsoOriginal.obs,
        },
        originais_insumos: {
          cimento_real: _etExtrairOriginal(_etTracoOriginal.cimento_real),
          agua_real: _etExtrairOriginal(_etTracoOriginal.agua_real),
          eps_real: _etExtrairOriginal(_etTracoOriginal.eps_real),
          superplast_real: _etExtrairOriginal(_etTracoOriginal.superplast_real),
          incorporador_real: _etExtrairOriginal(_etTracoOriginal.incorporador_real),
          tempo_batida_min: (() => { const s = _etExtrairOriginal(_etTracoOriginal.tempo_batida); return s === '' ? '' : Math.round((s / 60) * 100) / 100; })(),
        },
        ajustes: _etAjustesOriginaisCarregados,
        densidade: { original: _etExtrairOriginal(_etTracoOriginal.densidade), leituras: _etExtrairAjustesNumericos(_etTracoOriginal.densidade) },
        flow: { original: _etExtrairOriginal(_etTracoOriginal.flow), leituras: _etExtrairAjustesNumericos(_etTracoOriginal.flow) },
      };
      const blocosNovos = {
        identificacao: { num_traco: novosValores.num_traco, densidade_eps: novosValores.densidade_eps, silo: novosValores.silo, expansao: novosValores.expansao },
        uso: novosValores.uso,
        originais_insumos: novosValores.originais,
        ajustes: _etAjustesAtuais,
        densidade: novosValores.densidade,
        flow: novosValores.flow,
      };

      const diff = [];
      Object.keys(blocosNovos).forEach(bloco => {
        const de = blocosOriginais[bloco];
        const para = blocosNovos[bloco];
        if (JSON.stringify(de) !== JSON.stringify(para)) diff.push({ campo: bloco, de: de ?? null, para: para ?? null });
      });

      if (!diff.length) {
        LW.mostrarAlerta('Nenhuma alteração foi feita.', { tipo: 'aviso' });
        return;
      }
      const confirmouEdicao = await LW.mostrarConfirmacao(
        `Confirma a alteração de ${diff.length} bloco(s) de dados deste traço?`,
        { titulo: 'Confirmar edição', textoConfirmar: 'Salvar Alteração', icon: '✏️' }
      );
      if (!confirmouEdicao) return;

      const btn = document.getElementById('et-btn-salvar');
      const textoOriginal = btn.textContent;
      try {
        btn.disabled = true;
        btn.textContent = 'Salvando...';

        await LW.editarTracoRelatorio({
          id_traco: _etTracoOriginal.id_traco,
          id_operacao: _etUsoOriginal.id_operacao,
          novosValores,
          ajustes: _etAjustesAtuais,
          diff,
        });

        fecharEdicaoTraco();
        await LWDash.initRelatorio();
        LW.mostrarAlerta('Traço atualizado com sucesso!', { tipo: 'sucesso' });
      } catch (e) {
        erroEl.textContent = e.message;
        erroEl.style.display = 'block';
      } finally {
        btn.disabled = false;
        btn.textContent = textoOriginal;
      }
    }