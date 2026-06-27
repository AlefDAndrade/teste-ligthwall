// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  tour.js — Product Tour guiado (motor genérico + conteúdo)
//
//  Como funciona:
//  - Cada tour é uma lista de "passos": { selector, titulo, texto, aoEntrar? }
//  - Passo a passo, escurece a tela e abre um "recorte" (spotlight) em volta
//    do elemento de `selector`, com um balão de texto explicando ele.
//  - Roda automaticamente na 1ª vez que a pessoa abre cada página/modal
//    coberto (ver aoMudarPagina/aoAbrirModal, chamados de dentro de
//    showPage()/abrirConfig() no index.html) — depois disso, só reabre se
//    a pessoa clicar no botão "❔ Tour" daquela tela (passando forcado:true).
//  - "Já visto" fica salvo no localStorage (lw_tour_visto_<id>) — sobrevive
//    a fechar o navegador, mas é só uma preferência deste navegador/perfil,
//    não algo sincronizado entre computadores.
// ============================================================
'use strict';

(function () {
  const LS_PREFIXO = 'lw_tour_visto_';

  // ── Conteúdo dos tours ───────────────────────────────────────────────────
  // selector: precisa achar exatamente 1 elemento na tela (senão o passo é
  // pulado, sem travar o tour — ex: botão "Editar" que só aparece pra admin).
  // aoEntrar: roda ANTES de medir a posição do elemento — usado pra trocar
  // de aba/seção quando o alvo do passo está escondido até esse momento
  // (ex: seções da tela de Configurações).
  const TOURS = {
    operacao: [
      {
        selector: '#status-banner',
        titulo: 'Status da operação',
        texto: 'Aqui você acompanha o status: aguardando início, em andamento ou finalizada.',
      },
      {
        selector: 'label[for="op-toggle-teste"]',
        titulo: '🧪 Modo de Teste',
        texto: 'Ative pra treinar ou testar o sistema sem afetar dados reais — nada registrado em modo de teste entra no histórico de produção.',
      },
      {
        selector: '#op-montagem',
        titulo: 'Tipo de Montagem',
        texto: 'Escolha o tipo de montagem da bateria. Se escolher "Personalizada", aparece um botão 🔧 ao lado pra configurar o tipo de cada berço individualmente.',
      },
      {
        selector: '#op-id-bateria',
        titulo: 'ID da Bateria',
        texto: 'Informe qual bateria física vai rodar esta operação.',
      },
      {
        selector: '#btn-iniciar',
        titulo: 'Iniciar Injeção',
        texto: 'Com os campos acima preenchidos, clique aqui pra iniciar o cronômetro da operação.',
      },
      {
        selector: '#tracos-container',
        titulo: 'Traços',
        texto: 'Aqui você registra cada traço: insumos (cimento, água...), o relógio ⏱ de tempo de batida, e os resultados de densidade/flow.',
      },
      {
        selector: '#btn-finalizar',
        titulo: 'Finalizar Injeção',
        texto: 'Quando a bateria terminar, finalize a operação aqui. Isso trava os campos e calcula a Previsão de Desemplaque.',
      },
      {
        selector: '#btn-registrar',
        titulo: 'Registrar Operação',
        texto: 'Por fim, registre a operação aqui — ela é arquivada no histórico (e some da tela pra todo mundo), liberando pra uma próxima. Todo mundo online recebe um aviso com o resumo, com som.',
      },
    ],

    relatorio: [
      {
        selector: '#filtros-relatorio',
        titulo: 'Filtros',
        texto: 'Filtre os traços por data, bateria, turno e outros critérios.',
      },
      {
        selector: '#btn-exportar-relatorio',
        titulo: 'Exportar Excel',
        texto: 'Baixe os traços filtrados em .xlsx — você escolhe o período e quais colunas exportar.',
      },
      {
        selector: '#relatorio-table',
        titulo: 'Tabela de traços',
        texto: 'Clique em qualquer linha para expandir e ver, ajuste por ajuste, tudo que foi alterado na receita daquele traço.',
      },
      {
        selector: '#btn-editar-relatorio',
        titulo: 'Editar (Administrador)',
        texto: 'Administradores podem corrigir aqui os dados de um traço já registrado, inclusive seus ajustes.',
      },
    ],

    registro: [
      {
        selector: '#filtros-registro',
        titulo: 'Filtros',
        texto: 'Filtre as operações por data, dimensão, tipo de montagem e outros critérios.',
      },
      {
        selector: '#btn-exportar-registro',
        titulo: 'Exportar Excel',
        texto: 'Baixe as operações filtradas em .xlsx — você escolhe o período e quais colunas exportar.',
      },
      {
        selector: '#registro-table',
        titulo: 'Tabela de operações',
        texto: 'Clique em qualquer linha pra ver os traços vinculados àquela bateria no Relatório de Injeção.',
      },
      {
        selector: '#btn-editar-registro',
        titulo: 'Editar (Administrador)',
        texto: 'Administradores podem corrigir aqui os dados de uma operação já registrada.',
      },
    ],

    config: [
      {
        selector: '#cfg-nav-dados',
        titulo: 'Baterias e Montagem',
        texto: 'Cadastre as baterias físicas (ID, dimensão em cm, quantidade de berços) e os tipos de montagem disponíveis.',
        aoEntrar: () => { if (typeof cfgMostrarSecao === 'function') cfgMostrarSecao('dados'); },
      },
      {
        selector: '#cfg-bateria-novo',
        titulo: 'Nova Bateria',
        texto: 'Pra cadastrar uma bateria nova: ID, a dimensão (só o número, em cm) e a quantidade de berços.',
        aoEntrar: () => { if (typeof cfgMostrarSecao === 'function') cfgMostrarSecao('dados'); },
      },
      {
        selector: '#cfg-nav-atalhos',
        titulo: 'Atalhos de Teclado',
        texto: 'Personalize as teclas de atalho do sistema — se escolher uma já usada por outro atalho, o sistema avisa antes de trocar.',
        aoEntrar: () => { if (typeof cfgMostrarSecao === 'function') cfgMostrarSecao('atalhos'); },
      },
      {
        selector: '#cfg-nav-autorizados',
        titulo: 'Dispositivos Autorizados',
        texto: 'Controle quais computadores podem efetivamente operar a tela de Registrar Operação — os demais continuam podendo acompanhar ao vivo.',
        aoEntrar: () => { if (typeof cfgMostrarSecao === 'function') cfgMostrarSecao('autorizados'); },
      },
    ],
  };

  // Mapeia pageId (de showPage) -> id do tour, só pras páginas cobertas.
  const PAGINA_PARA_TOUR = { operacao: 'operacao', relatorio: 'relatorio', registro: 'registro' };

  // ── Estado do tour ativo ─────────────────────────────────────────────────
  let _tourId = null;
  let _passos = [];
  let _indice = 0;
  let _onResize = null;

  function _jaViu(tourId) {
    try { return localStorage.getItem(LS_PREFIXO + tourId) === 'true'; } catch (_) { return false; }
  }
  function _marcarVisto(tourId) {
    try { localStorage.setItem(LS_PREFIXO + tourId, 'true'); } catch (_) { /* localStorage indisponível */ }
  }

  function _garantirDOM() {
    if (document.getElementById('tour-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'tour-overlay';
    overlay.innerHTML = `
      <div id="tour-spotlight"></div>
      <div id="tour-balao">
        <div class="tour-balao-passo" id="tour-balao-passo"></div>
        <div class="tour-balao-titulo" id="tour-balao-titulo"></div>
        <div class="tour-balao-texto" id="tour-balao-texto"></div>
        <div class="tour-balao-botoes">
          <button class="btn btn-ghost btn-sm" id="tour-btn-pular">Pular tour</button>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost btn-sm" id="tour-btn-anterior">← Anterior</button>
            <button class="btn btn-primary btn-sm" id="tour-btn-proximo">Próximo →</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('tour-btn-pular').onclick = parar;
    document.getElementById('tour-btn-anterior').onclick = _anterior;
    document.getElementById('tour-btn-proximo').onclick = _proximo;
    document.addEventListener('keydown', _onKeydown);
  }

  function _onKeydown(e) {
    if (!_tourId) return;
    if (e.key === 'Escape') parar();
    if (e.key === 'ArrowRight') _proximo();
    if (e.key === 'ArrowLeft') _anterior();
  }

  /** Inicia um tour. opts.forcado=true ignora o "já visto" (replay manual). */
  function iniciar(tourId, opts = {}) {
    const passos = TOURS[tourId];
    if (!passos || !passos.length) return;
    if (!opts.forcado && _jaViu(tourId)) return;

    _tourId = tourId;
    _passos = passos;
    _indice = 0;
    _garantirDOM();
    document.getElementById('tour-overlay').classList.add('active');
    _mostrarPasso(0);
  }

  function parar() {
    if (!_tourId) return;
    _marcarVisto(_tourId);
    const overlay = document.getElementById('tour-overlay');
    if (overlay) overlay.classList.remove('active');
    if (_onResize) { window.removeEventListener('resize', _onResize); _onResize = null; }
    _tourId = null;
    _passos = [];
    _indice = 0;
  }

  function _proximo() {
    if (_indice >= _passos.length - 1) { parar(); return; }
    _mostrarPasso(_indice + 1);
  }

  function _anterior() {
    if (_indice <= 0) return;
    _mostrarPasso(_indice - 1);
  }

  /** Mostra o passo `i` — pula pra frente sozinho se o elemento não existir na tela agora (ex: botão só-admin). */
  function _mostrarPasso(i) {
    if (i < 0 || i >= _passos.length) { parar(); return; }
    const passo = _passos[i];
    if (typeof passo.aoEntrar === 'function') {
      try { passo.aoEntrar(); } catch (_) { /* não deixa um erro no aoEntrar travar o tour */ }
    }

    // Dá um tick pra qualquer troca de seção/aba do aoEntrar terminar de
    // renderizar antes de procurar o elemento e medir a posição dele.
    setTimeout(() => {
      const el = document.querySelector(passo.selector);
      if (!el) { // alvo não existe agora (ex: card só-admin) — pula pro próximo, sem travar
        if (i < _passos.length - 1) _mostrarPasso(i + 1); else parar();
        return;
      }
      _indice = i;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => _posicionar(el, passo), 280); // espera o scroll suave terminar antes de medir
    }, 30);
  }

  function _posicionar(el, passo) {
    if (!_tourId) return; // tour foi parado enquanto esperava o scroll
    const PAD = 10;
    const rect = el.getBoundingClientRect();

    const spot = document.getElementById('tour-spotlight');
    spot.style.top = (rect.top - PAD) + 'px';
    spot.style.left = (rect.left - PAD) + 'px';
    spot.style.width = (rect.width + PAD * 2) + 'px';
    spot.style.height = (rect.height + PAD * 2) + 'px';

    document.getElementById('tour-balao-passo').textContent = `Passo ${_indice + 1} de ${_passos.length}`;
    document.getElementById('tour-balao-titulo').textContent = passo.titulo;
    document.getElementById('tour-balao-texto').textContent = passo.texto;
    document.getElementById('tour-btn-anterior').style.visibility = _indice === 0 ? 'hidden' : 'visible';
    document.getElementById('tour-btn-proximo').textContent = _indice === _passos.length - 1 ? 'Concluir ✓' : 'Próximo →';

    const balao = document.getElementById('tour-balao');
    balao.style.visibility = 'hidden'; // mede o tamanho real antes de posicionar, sem "pular" visualmente
    balao.style.top = '0px';
    balao.style.left = '0px';
    const tamanho = balao.getBoundingClientRect();
    const margem = 16;
    const vw = window.innerWidth, vh = window.innerHeight;

    let top, left;
    const espacoBaixo = vh - rect.bottom, espacoCima = rect.top, espacoDireita = vw - rect.right;
    if (espacoBaixo >= tamanho.height + margem) {
      top = rect.bottom + margem;
      left = Math.min(Math.max(rect.left, margem), vw - tamanho.width - margem);
    } else if (espacoCima >= tamanho.height + margem) {
      top = rect.top - tamanho.height - margem;
      left = Math.min(Math.max(rect.left, margem), vw - tamanho.width - margem);
    } else if (espacoDireita >= tamanho.width + margem) {
      left = rect.right + margem;
      top = Math.min(Math.max(rect.top, margem), vh - tamanho.height - margem);
    } else {
      // Sem espaço em nenhum lado (elemento gigante/tela pequena) — centraliza.
      top = Math.max(margem, (vh - tamanho.height) / 2);
      left = Math.max(margem, (vw - tamanho.width) / 2);
    }
    balao.style.top = top + 'px';
    balao.style.left = left + 'px';
    balao.style.visibility = 'visible';

    if (_onResize) window.removeEventListener('resize', _onResize);
    _onResize = () => _posicionar(el, passo);
    window.addEventListener('resize', _onResize);
  }

  // ── Gatilhos automáticos (chamados de dentro de showPage()/abrirConfig()) ──
  function aoMudarPagina(pageId) {
    const tourId = PAGINA_PARA_TOUR[pageId];
    if (!tourId || _jaViu(tourId)) return;
    setTimeout(() => iniciar(tourId), 250); // espera a página assentar (init/render da tela)
  }

  function aoAbrirModal(tourId) {
    if (!TOURS[tourId] || _jaViu(tourId)) return;
    setTimeout(() => iniciar(tourId), 250);
  }

  window.LWTour = { iniciar, parar, aoMudarPagina, aoAbrirModal };
})();
