// ─── table-scroll-indicador.js ──────────────────────────────────────────
// Indicador visual de "tem mais conteúdo pra esse lado" nas tabelas.
//
// As tabelas do sistema rolam na horizontal (.table-wrap / .man-table-wrap
// têm overflow-x: auto). Só .man-table-wrap ainda esconde a scrollbar
// nativa (ver .man-table-wrap::-webkit-scrollbar, manutencao.css) — por
// isso só ali esse indicador continua tendo efeito visual.
//
// .table-wrap (Registro de Baterias, Relatório de Injeção, Análise de
// Berços, Registros do Setor de Qualidade) passou a mostrar a scrollbar
// nativa de verdade (ver conversa que motivou esta mudança — a faixa de
// gradiente que este script controlava ali causava uma "linha estranha"
// que só sumia ao chegar no fim do scroll, exatamente o momento em que
// este script remove a classe). O CSS do fade pra .table-wrap foi
// REMOVIDO (ver styles.css) — este script continua rodando pra ele
// também (SELETOR_WRAPS não mudou, de propósito: não faz mal nenhum
// ficar alternando uma classe sem efeito visual, e evita duplicar/tornar
// esse arquivo condicional por wrapper), só não tem mais nada pra
// mostrar/esconder lá.
//
// Este script observa cada wrapper e liga/desliga duas classes:
//   .tem-scroll-esquerda  → ainda dá pra rolar pra esquerda
//   .tem-scroll-direita   → ainda dá pra rolar pra direita
// O CSS (manutencao.css, só pra .man-table-wrap agora) usa essas classes
// pra mostrar um "fade" nas bordas do wrapper. O fade some sozinho quando
// não há mais conteúdo naquele sentido — inclusive numa tabela que nunca
// teve overflow pra começo de conversa.

(function () {
  const SELETOR_WRAPS = '.table-wrap, .man-table-wrap';
  const TOLERANCIA_PX = 1; // arredondamento de subpixel em zoom/telas HiDPI

  function atualizarIndicador(wrap) {
    const podeRolar = wrap.scrollWidth - wrap.clientWidth > TOLERANCIA_PX;
    const noComeco = wrap.scrollLeft <= TOLERANCIA_PX;
    const noFim = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - TOLERANCIA_PX;

    wrap.classList.toggle('tem-scroll-esquerda', podeRolar && !noComeco);
    wrap.classList.toggle('tem-scroll-direita', podeRolar && !noFim);
  }

  function observarWrap(wrap) {
    if (wrap.dataset.scrollIndicadorPronto) return; // evita registrar 2x
    wrap.dataset.scrollIndicadorPronto = '1';

    atualizarIndicador(wrap);
    wrap.addEventListener('scroll', () => atualizarIndicador(wrap), { passive: true });

    // O conteúdo da tabela muda de tamanho depois do load (linhas
    // carregadas via fetch, filtros, colunas escondidas/mostradas etc.) —
    // ResizeObserver na <table> reage a essas mudanças sem precisar de
    // polling nem de reescutar cada função que popula a tabela.
    const tabela = wrap.querySelector('table');
    if (tabela && typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => atualizarIndicador(wrap)).observe(tabela);
    }
  }

  function iniciar() {
    document.querySelectorAll(SELETOR_WRAPS).forEach(observarWrap);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar);
  } else {
    iniciar();
  }

  // Tabelas que só aparecem depois (troca de aba, modal, etc.) — cobre com
  // um MutationObserver leve no body, só olhando nós adicionados.
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver((mutacoes) => {
      for (const mutacao of mutacoes) {
        mutacao.addedNodes.forEach((no) => {
          if (no.nodeType !== 1) return;
          if (no.matches && no.matches(SELETOR_WRAPS)) observarWrap(no);
          no.querySelectorAll && no.querySelectorAll(SELETOR_WRAPS).forEach(observarWrap);
        });
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // Redimensionar a janela (ou girar o celular) pode fazer uma tabela que
  // cabia inteira passar a precisar de scroll, ou vice-versa.
  window.addEventListener('resize', () => {
    document.querySelectorAll(SELETOR_WRAPS).forEach(atualizarIndicador);
  });
})();
