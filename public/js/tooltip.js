// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  tooltip.js — Tooltip compartilhado (hover no desktop, toque no
//  celular/tablet) — usado por todos os dashboards.
//
//  Por que não usar o atributo title="..." nativo do navegador (como boa
//  parte do app fazia até aqui)?
//   - Não funciona em toque: a maioria dos navegadores mobile não mostra
//     title nenhum com um toque simples (alguns mostram com toque
//     PROLONGADO, inconsistente entre aparelhos) — e este app claramente
//     roda em tablet/celular de fábrica (LWDebriefing, LWBateriaAtual já
//     são pensados pra qualquer tela).
//   - Sem estilo nenhum: fonte do sistema operacional, sem contraste
//     garantido com o tema, sem controle de posição/tamanho.
//   - Delay fixo e inconsistente entre navegadores.
//
//  Uso:
//   1) Elemento estático/re-renderizado via innerHTML: só adicionar o
//      atributo `data-tooltip="texto aqui"` — funciona sozinho, não
//      precisa registrar nada (delegação de evento no documento inteiro,
//      sobrevive a qualquer re-render/innerHTML novo). Quebra de linha:
//      usar \n dentro da string (white-space: pre-line no CSS).
//   2) Canvas (pontos/fatias/barras sem elemento DOM próprio): chamar
//      LW.tooltip.mostrarTexto(texto, clientX, clientY) e
//      LW.tooltip.esconder() diretamente — ver _ligarHoverCanvas em
//      qualidade-tracos.js.
// ============================================================

'use strict';

(function () {

  let tooltipEl = null;
  let alvoAtivo = null;     // elemento [data-tooltip] mostrando agora (hover/toque), ou null
  let ultimoToque = 0;      // Date.now() do último touchstart — evita o "mouseover fantasma"
                             // que o navegador dispara logo depois de um toque em telas touch

  function _el() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'lw-tooltip';
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function _posicionar(x, y) {
    const tt = _el();
    const margem = 12;
    // Precisa estar visível pra medir o tamanho real (offsetWidth/Height
    // dão 0 em elemento com display:none).
    let left = x + margem;
    let top  = y + margem;
    const w = tt.offsetWidth, h = tt.offsetHeight;
    if (left + w > window.innerWidth - 8)  left = x - margem - w;
    if (top  + h > window.innerHeight - 8) top  = y - margem - h;
    if (left < 8) left = 8;
    if (top  < 8) top  = 8;
    tt.style.left = left + 'px';
    tt.style.top  = top + 'px';
  }

  /** Mostra um texto livre na posição (x,y) da tela — usado por gráficos em canvas. */
  function mostrarTexto(texto, x, y) {
    if (!texto) { esconder(); return; }
    const tt = _el();
    tt.textContent = texto;
    tt.style.display = 'block';
    _posicionar(x, y);
  }

  /** Mostra o tooltip de um elemento [data-tooltip] na posição (x,y). */
  function _mostrarDoElemento(alvo, x, y) {
    const texto = alvo.getAttribute('data-tooltip');
    if (!texto) return;
    mostrarTexto(texto, x, y);
    alvoAtivo = alvo;
  }

  function esconder() {
    if (tooltipEl) tooltipEl.style.display = 'none';
    alvoAtivo = null;
  }

  // ── Hover/toque genérico pra gráficos em canvas ──────────────────────────
  // Canvas não tem DOM por ponto/barra/fatia — não dá pra usar data-tooltip.
  // Liga (uma única vez por canvas, controlado por canvas._hoverLigado)
  // hover (mouse) E toque (mobile) num canvas qualquer. `acharTexto(x, y)`
  // recebe a posição do cursor/toque relativa ao canvas (0,0 = canto
  // superior esquerdo do canvas) e decide se há algo perto o bastante pra
  // mostrar tooltip ali — cada gráfico implementa sua própria lógica de
  // proximidade (normalmente guardando as posições desenhadas em
  // canvas._algumaCoisa a cada render). Usado por qualidade-tracos.js
  // (donut/evolução/barras) e analise-operacional.js (drawBar/drawDualLine)
  // — compartilhado aqui pra não duplicar em cada dashboard.
  //
  // No toque, cada toque ALTERNA: tocar de novo perto do mesmo texto
  // esconde, tocar em outro lugar mostra o novo. stopPropagation evita que
  // o listener global de toque (acima) feche isso na mesma hora só por o
  // canvas não ser um elemento [data-tooltip] — o canvas cuida do próprio
  // show/hide sozinho.
  function ligarHoverCanvas(canvas, acharTexto) {
    if (canvas._hoverLigado) return;
    canvas._hoverLigado = true;

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const texto = acharTexto(e.clientX - rect.left, e.clientY - rect.top);
      if (texto) { canvas.style.cursor = 'pointer'; mostrarTexto(texto, e.clientX, e.clientY); }
      else { canvas.style.cursor = 'default'; esconder(); }
    });
    canvas.addEventListener('mouseleave', () => { esconder(); canvas.style.cursor = 'default'; });

    let _ultimoTexto = null;
    canvas.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      const rect = canvas.getBoundingClientRect();
      const texto = acharTexto(t.clientX - rect.left, t.clientY - rect.top);
      if (texto && texto === _ultimoTexto) { esconder(); _ultimoTexto = null; }
      else if (texto) { mostrarTexto(texto, t.clientX, t.clientY); _ultimoTexto = texto; }
      else { esconder(); _ultimoTexto = null; }
      e.stopPropagation();
    }, { passive: true });
  }

  // ── Desktop: hover (mouseover/mousemove/mouseout, delegado no document) ──
  document.addEventListener('mouseover', (e) => {
    if (Date.now() - ultimoToque < 700) return; // ignora o mouseover fantasma pós-toque
    const alvo = e.target.closest('[data-tooltip]');
    if (alvo) _mostrarDoElemento(alvo, e.clientX, e.clientY);
  });
  document.addEventListener('mousemove', (e) => {
    if (!alvoAtivo) return;
    if (e.target.closest('[data-tooltip]') === alvoAtivo) _posicionar(e.clientX, e.clientY);
  });
  document.addEventListener('mouseout', (e) => {
    if (alvoAtivo && e.target.closest('[data-tooltip]') === alvoAtivo) esconder();
  });

  // ── Mobile: toque alterna (toca mostra, toca de novo no mesmo esconde;
  // toca em outro lugar qualquer também esconde) ──────────────────────────
  document.addEventListener('touchstart', (e) => {
    ultimoToque = Date.now();
    const alvo = e.target.closest('[data-tooltip]');
    if (!alvo) { esconder(); return; }
    if (alvoAtivo === alvo) { esconder(); return; }
    const t = e.touches[0];
    _mostrarDoElemento(alvo, t.clientX, t.clientY);
  }, { passive: true });

  // Fecha ao tocar/clicar fora de qualquer [data-tooltip] (desktop também,
  // de forma defensiva — ex: clicar rápido sem passar por mouseout antes).
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-tooltip]')) esconder();
  });
  window.addEventListener('scroll', esconder, true);
  window.addEventListener('resize', esconder);

  // Anexa em cima do window.LW que já existe (ver data.js) — NUNCA antes:
  // data.js faz `window.LW = { ...tudo }` (substituição completa do
  // objeto), então se este script rodasse antes dele, LW.tooltip seria
  // apagado. tooltip.js precisa carregar DEPOIS de data.js no HTML.
  window.LW = window.LW || {};
  window.LW.tooltip = { mostrarTexto, esconder, ligarHoverCanvas };

})();
