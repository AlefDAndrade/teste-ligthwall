// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  abrir-nova-aba.js — Ctrl/Cmd+clique abre a página numa aba nova
// ============================================================
//
// A navegação do sistema é toda feita chamando showPage('id', el) direto
// no onclick de <button>/<div> (sidebar, cards do Menu, botões "Ver
// Tabela"/"Ver Registro" etc.) — nunca <a href="...">. Por isso o
// navegador não abre aba nova sozinho no Ctrl+clique como faria com um
// link de verdade; ele só executa o onclick normal, trocando a página na
// MESMA aba.
//
// Este arquivo intercepta o clique, na fase de captura (antes do onclick
// do próprio elemento rodar), e só quando Ctrl (Windows/Linux) ou Cmd
// (Mac) está pressionado: cancela a navegação normal e abre uma aba nova
// com a mesma URL da aplicação + "?abrirPagina=<id>". Não existe (nem
// precisa existir) uma URL/rota própria pra cada página — a aba nova
// carrega o app do zero (login, sessão etc. — sessionStorage é copiado
// automaticamente pro contexto de uma aba aberta via window.open) e,
// assim que o boot normal terminar, a gente lê esse parâmetro e chama
// showPage(id) por conta própria, então tira o parâmetro da URL.
//
// Continua funcionando normal, na mesma aba, pra clique sem Ctrl/Cmd —
// este script nunca interfere nesse caso.

'use strict';

(function () {

  const PARAM = 'abrirPagina';

  // Acha o pageId de um elemento de navegação: o atributo data-page
  // (itens do sidebar) ou, na falta dele, extraído do próprio
  // onclick="showPage('x', ...)" (cards do Menu e botões "Ver Tabela"/
  // "Ver Registro" espalhados pelas páginas).
  function pageIdDoElemento(el) {
    if (el.dataset && el.dataset.page) return el.dataset.page;
    const attr = el.getAttribute('onclick');
    if (!attr) return null;
    const m = attr.match(/showPage\(\s*['"]([\w-]+)['"]/);
    return m ? m[1] : null;
  }

  document.addEventListener('click', function (ev) {
    const ctrlOuCmd = ev.ctrlKey || ev.metaKey;
    if (!ctrlOuCmd) return;
    if (ev.button !== 0) return; // só botão principal do mouse

    // O clique pode cair num filho do botão/card (ícone, texto) — sobe
    // até achar o elemento de navegação de verdade.
    const el = ev.target.closest('[data-page], [onclick*="showPage("]');
    if (!el) return;

    const pageId = pageIdDoElemento(el);
    if (!pageId) return;

    // Cancela a navegação normal (troca de página nesta aba) e barra
    // outros listeners no mesmo elemento (ex: o que fecha o sidebar
    // mobile ao clicar) de disparar junto.
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();

    const url = new URL(window.location.href);
    url.searchParams.set(PARAM, pageId);
    // SEM 'noopener' de propósito: é a relação de auxiliary browsing
    // context com esta aba (o "opener") que faz o navegador copiar o
    // sessionStorage — onde fica a sessão de login (lw_role) — pra aba
    // nova. Com 'noopener' essa cópia não acontece e a aba nova sempre
    // nasce deslogada, caindo direto no login.html. Como as duas abas
    // são sempre da mesma origem (é o próprio app se abrindo de novo),
    // não existe o risco de "reverse tabnabbing" que o noopener evita
    // normalmente ao abrir links externos.
    window.open(url.toString(), '_blank');
  }, true); // fase de captura — chega antes do onclick inline do elemento

  // ── Na aba nova: se a URL veio com ?abrirPagina=x, mostra essa página
  // assim que o boot do app (DOMContentLoaded registrado em app-core.js,
  // que roda ANTES deste — este <script> vem depois dele no HTML)
  // terminar, inclusive depois de qualquer redirecionamento automático
  // de perfil (ex: showPage('operacao') forçado pro Operador).
  document.addEventListener('DOMContentLoaded', function () {
    const params = new URLSearchParams(window.location.search);
    const pageId = params.get(PARAM);
    if (!pageId) return;

    // Tira o parâmetro da URL sem recarregar — um F5 depois não fica
    // preso sempre reabrindo a mesma página, e a pessoa pode copiar a
    // URL da aba pra mandar pra alguém sem levar esse parâmetro junto.
    const url = new URL(window.location.href);
    url.searchParams.delete(PARAM);
    window.history.replaceState({}, '', url.toString());

    if (typeof showPage === 'function' && document.getElementById('page-' + pageId)) {
      showPage(pageId);
    }
  });

})();