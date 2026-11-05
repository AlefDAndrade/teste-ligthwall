// ============================================================
//  calculadora-receita.js — "🧮 Calc. Receita" (Registrar Operação)
//
//  Calculadora de receita dimensionada: dado quantos berços uma receita
//  base enche, escala cada insumo (regra de três) para a quantidade de
//  berços que se quer encher, e mostra a relação A/C (água/cimento).
//
//  Markup: popover #popover-calc-receita em partials/page-operacao.html
//  (abre pelo mesmo LWOp.togglePopover de Pendências/Referências). Aqui
//  só entram as linhas da tabela (#calc-rec-body) e os eventos de #calc-rec.
//
//  Módulo UMD, sem dependências: no navegador vira window.LWCalcReceita e
//  liga a calculadora sozinho quando a página carrega; no Node, `require`
//  devolve só as funções puras (test/calculadora-receita.test.js).
//
//  É uma ferramenta de apoio: não lê nem grava nada da operação em
//  andamento — os valores digitados valem só enquanto a página está aberta.
// ============================================================
(function (raiz, fabrica) {
  'use strict';
  const api = fabrica();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    raiz.LWCalcReceita = api;
    if (raiz.document) {
      if (raiz.document.readyState === 'loading') {
        raiz.document.addEventListener('DOMContentLoaded', () => api.montar(raiz.document));
      } else {
        api.montar(raiz.document);
      }
    }
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Receita base padrão. `dec` = casas decimais mostradas no resultado;
  // `passo` = quanto os botões − / + somam ou tiram da quantidade base.
  const COMPONENTES = [
    { id: 'cimento', nome: 'Cimento',            base: 1050, dec: 2, passo: 10  },
    { id: 'agua',    nome: 'Água',               base: 425,  dec: 2, passo: 5   },
    { id: 'eps',     nome: 'EPS',                base: 25,   dec: 2, passo: 1   },
    { id: 'super',   nome: 'Superplastificante', base: 5.5,  dec: 2, passo: 0.1 },
    { id: 'ar',      nome: 'Incorporador de ar', base: 4.6,  dec: 2, passo: 0.1 },
  ];

  // Quantos berços a receita base enche / quantos se quer encher (valores iniciais).
  const PADRAO = { bercosBase: 9, bercosAlvo: 4 };

  // Faixa ideal da relação água/cimento.
  const AC_MIN = 0.35;
  const AC_MAX = 0.40;

  const ICONE_COPIAR = '<svg class="calc-rec-ico-copiar" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const ICONE_OK = '<svg class="calc-rec-ico-ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

  // ── Funções puras (sem DOM) ─────────────────────────────────

  /**
   * Número com ponto como separador decimal e SEM separador de milhar
   * (ex.: 1050.5). Sem milhar, "1.050" não se confunde com 1,05 — e o mesmo
   * texto serve para exibir e para copiar/colar num campo numérico.
   */
  function formatar(valor, casas) {
    return valor.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: casas,
      useGrouping: false,
    });
  }

  const duasCasas = v => v.toFixed(2);

  /** Casas decimais de um número (pela sua representação em texto). */
  function decimaisDe(n) {
    const t = String(n);
    if (/e/i.test(t)) return 6; // notação científica (valor minúsculo/enorme)
    const frac = t.split('.')[1];
    return frac ? frac.length : 0;
  }

  /**
   * Soma (direcao > 0) ou tira (direcao < 0) um passo de uma quantidade.
   * Arredonda nas casas do valor/passo — sem isso, 4,6 + 0,1 daria
   * 4,699999999999999 — e nunca passa de 0. Vazio/inválido conta como 0.
   */
  function ajustarValor(valor, passo, direcao) {
    const atual = isFinite(valor) ? valor : 0;
    const casas = Math.min(Math.max(decimaisDe(atual), decimaisDe(passo)), 6);
    const novo = Number((atual + Math.sign(direcao) * passo).toFixed(casas));
    return Math.max(0, novo);
  }

  /** Mensagem de erro (string) se os nº de berços forem inválidos; senão null. */
  function validarBercos(bercosBase, bercosAlvo) {
    if (!isFinite(bercosBase) || bercosBase <= 0) {
      return 'Informe quantos berços a receita atual enche (valor maior que zero).';
    }
    if (!isFinite(bercosAlvo) || bercosAlvo < 0) {
      return 'Informe uma quantidade de berços válida (zero ou mais).';
    }
    return null;
  }

  /**
   * Escala a receita base.
   * @param {Object<string, number>} base  quantidade base por id de insumo
   * @returns {{ok:true, fator:number, itens:Object<string, number>} | {ok:false, erro:string}}
   */
  function calcularReceita(base, bercosBase, bercosAlvo) {
    const erro = validarBercos(bercosBase, bercosAlvo);
    if (erro) return { ok: false, erro };
    const fator = bercosAlvo / bercosBase;
    const itens = {};
    COMPONENTES.forEach(c => {
      const v = Number(base[c.id]);
      itens[c.id] = (isFinite(v) ? v : 0) * fator;
    });
    return { ok: true, fator, itens };
  }

  /**
   * Avalia a relação A/C da receita base (a proporção não muda ao escalar).
   * @returns {{valido:false} | {valido:true, ac:number, situacao:'ideal'|'abaixo'|'acima'}}
   */
  function avaliarAC(cimento, agua) {
    if (!isFinite(cimento) || cimento <= 0 || !isFinite(agua) || agua < 0) return { valido: false };
    const ac = agua / cimento;
    const situacao = ac < AC_MIN ? 'abaixo' : (ac > AC_MAX ? 'acima' : 'ideal');
    return { valido: true, ac, situacao };
  }

  // ── DOM ─────────────────────────────────────────────────────

  /** Liga a calculadora em #calc-rec. Idempotente (2ª chamada não faz nada). */
  function montar(doc) {
    const caixa = doc.getElementById('calc-rec');
    if (!caixa || caixa.dataset.pronto === '1') return null;
    caixa.dataset.pronto = '1';

    const el = id => doc.getElementById(id);
    const corpo = el('calc-rec-body');
    const aviso = el('calc-rec-aviso');
    const fatorEl = el('calc-rec-fator');
    const alvoTxt = el('calc-rec-alvo-txt');
    const inpBase = el('calc-rec-bercos-base');
    const inpAlvo = el('calc-rec-bercos-alvo');
    const acBox = el('calc-rec-ac-box');
    const acVal = el('calc-rec-ac-val');
    const acMsg = el('calc-rec-ac-msg');

    // Botão − / + de um insumo (dir = -1 ou 1). Aponta pro input por id (data-alvo) e
    // leva o passo em data-passo — o mesmo formato dos botões de berços no partial.
    // Texto vem de COMPONENTES (constante do código).
    function botaoPasso(c, dir) {
      const acao = dir < 0 ? 'Diminuir' : 'Aumentar';
      return '<button class="calc-rec-btn-passo" type="button" data-alvo="calc-rec-base-' + c.id + '"' +
        ' data-passo="' + c.passo + '" data-dir="' + dir + '"' +
        ' title="' + acao + ' ' + formatar(c.passo, 3) + '" aria-label="' + acao + ' ' + c.nome + '">' +
        (dir < 0 ? '\u2212' : '+') + '</button>';
    }

    // Nomes/ids vêm de COMPONENTES (constante do código) — sem texto do usuário aqui.
    COMPONENTES.forEach(c => {
      corpo.insertAdjacentHTML('beforeend',
        '<tr><td>' + c.nome + '</td>' +
        '<td class="num"><div class="calc-rec-step">' +
        botaoPasso(c, -1) +
        '<input class="form-input" type="number" step="any" min="0" inputmode="decimal"' +
        ' id="calc-rec-base-' + c.id + '" value="' + c.base + '">' +
        botaoPasso(c, 1) + '</div></td>' +
        '<td class="num calc-rec-col-res"><div class="calc-rec-copy-cell">' +
        '<span id="calc-rec-ex-' + c.id + '" data-copiar="">–</span>' +
        '<button class="calc-rec-copy" type="button" data-alvo="calc-rec-ex-' + c.id + '"' +
        ' title="Copiar valor exato de ' + c.nome + '" aria-label="Copiar valor exato de ' + c.nome + '">' +
        ICONE_COPIAR + ICONE_OK + '</button></div></td></tr>');
    });

    const lerBase = () => {
      const base = {};
      COMPONENTES.forEach(c => { base[c.id] = parseFloat(el('calc-rec-base-' + c.id).value); });
      return base;
    };

    function limparResultado() {
      fatorEl.textContent = '–';
      COMPONENTES.forEach(c => {
        const s = el('calc-rec-ex-' + c.id);
        s.textContent = '–';
        s.dataset.copiar = '';
      });
    }

    function atualizarAC(base) {
      acBox.classList.remove('ok', 'fora');
      const r = avaliarAC(base.cimento, base.agua);
      if (!r.valido) {
        acVal.textContent = '–';
        acMsg.textContent = 'informe água e cimento';
        return;
      }
      const faixa = '(' + duasCasas(AC_MIN) + ' a ' + duasCasas(AC_MAX) + ')';
      acVal.textContent = duasCasas(r.ac);
      if (r.situacao === 'ideal') {
        acBox.classList.add('ok');
        acMsg.textContent = 'Ideal ' + faixa;
      } else {
        acBox.classList.add('fora');
        acMsg.textContent = (r.situacao === 'abaixo' ? 'Abaixo do ideal ' : 'Acima do ideal ') + faixa;
      }
    }

    function calcular() {
      const base = lerBase();
      atualizarAC(base);

      const nb = parseFloat(inpBase.value);
      const na = parseFloat(inpAlvo.value);
      const r = calcularReceita(base, nb, na);
      if (!r.ok) {
        aviso.hidden = false;
        aviso.textContent = r.erro;
        limparResultado();
        return;
      }
      aviso.hidden = true;
      fatorEl.textContent = formatar(r.fator, 4);
      alvoTxt.textContent = formatar(na, 2);
      COMPONENTES.forEach(c => {
        const s = el('calc-rec-ex-' + c.id);
        s.textContent = formatar(r.itens[c.id], c.dec);
        s.dataset.copiar = formatar(r.itens[c.id], c.dec);
      });
    }

    function restaurarPadrao() {
      inpBase.value = PADRAO.bercosBase;
      inpAlvo.value = PADRAO.bercosAlvo;
      COMPONENTES.forEach(c => { el('calc-rec-base-' + c.id).value = c.base; });
      calcular();
    }

    // Feedback do botão só troca uma classe (CSS alterna os 2 ícones) em vez de
    // recriar o SVG: o clique de fora fecha os popovers testando e.target.closest,
    // e um alvo removido do DOM faria o popover fechar na hora de copiar.
    function feedback(btn) {
      btn.classList.add('ok');
      setTimeout(() => btn.classList.remove('ok'), 1200);
    }

    function avisarFalha(texto) {
      const msg = 'Não foi possível copiar: ' + texto;
      const win = doc.defaultView;
      if (win && win.LW && typeof win.LW.mostrarAlerta === 'function') win.LW.mostrarAlerta(msg, { tipo: 'aviso' });
      else if (win && typeof win.alert === 'function') win.alert(msg);
    }

    async function copiar(btn) {
      const span = el(btn.dataset.alvo);
      const texto = span ? (span.dataset.copiar || '').trim() : '';
      if (!texto) return;

      const win = doc.defaultView;
      try {
        await win.navigator.clipboard.writeText(texto);
        feedback(btn);
      } catch (e) {
        // Sem Clipboard API (ex.: http fora de localhost) — cai no método antigo.
        const ta = doc.createElement('textarea');
        ta.value = texto;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        doc.body.appendChild(ta);
        ta.select();
        try {
          if (doc.execCommand('copy')) feedback(btn);
          else avisarFalha(texto);
        } catch (_) {
          avisarFalha(texto);
        }
        doc.body.removeChild(ta);
      }
    }

    caixa.addEventListener('input', calcular);
    // Serve aos botões dos insumos e aos de berços: o botão diz qual input mexer e o passo.
    function ajustarCampo(btn) {
      const inp = el(btn.dataset.alvo);
      const passo = parseFloat(btn.dataset.passo);
      if (!inp || !(passo > 0)) return;
      inp.value = String(ajustarValor(parseFloat(inp.value), passo, Number(btn.dataset.dir)));
      calcular();
    }

    caixa.addEventListener('click', e => {
      const passo = e.target.closest('.calc-rec-btn-passo');
      if (passo && caixa.contains(passo)) { ajustarCampo(passo); return; }
      const btn = e.target.closest('.calc-rec-copy');
      if (btn && caixa.contains(btn)) copiar(btn);
    });
    el('calc-rec-resetar').addEventListener('click', restaurarPadrao);

    calcular();
    return { calcular, restaurarPadrao };
  }

  return {
    COMPONENTES, PADRAO, AC_MIN, AC_MAX,
    formatar, validarBercos, calcularReceita, avaliarAC, ajustarValor, montar,
  };
});
