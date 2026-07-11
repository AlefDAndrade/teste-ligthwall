// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  pwa-register.js — registra o service worker (ver service-worker.js)
// ============================================================
// Script pequeno e autocontido de propósito (mesmo espírito de
// tooltip.js/tour.js) — incluído tanto em login.html quanto em
// index.html, já que os dois são pontos de entrada válidos do app.
'use strict';

(function () {
  if (!('serviceWorker' in navigator)) return; // navegador antigo/sem suporte — segue sem PWA, sem quebrar nada

  // 'load' em vez de rodar direto: registrar o SW não deve competir por
  // rede/CPU com o carregamento da própria página.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js')
      .catch((err) => {
        // Falha em registrar o SW nunca deve impedir o app de funcionar
        // normalmente — é só uma melhoria de carregamento/instalação,
        // não uma dependência.
        console.warn('[PWA] Não consegui registrar o service worker:', err);
      });
  });
})();
