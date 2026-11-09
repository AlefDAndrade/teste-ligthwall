// ============================================================
//  ajuste-traco.js — "🎯 Ajuste de Traço" (Registrar Operação)
//
//  Calculadora de ajuste de traço: dado o flow e a densidade MEDIDOS, o
//  alvo de cada um e o cimento do traço, sugere quanto cimento, água,
//  superplastificante e EPS adicionar, e prevê o flow/densidade depois do
//  ajuste. Também guarda um registro dos ajustes feitos (leitura antes →
//  depois + o que foi usado) e recalibra os coeficientes com esse registro.
//
//  Markup: popover #popover-ajuste-traco em partials/page-operacao.html, no
//  cabeçalho do card "Traços de Injeção" (abre pelo mesmo
//  LWOp.togglePopover de Pendências/Referências/Calc. Receita). Aqui só entram
//  o resultado, a tabela do registro e os campos de calibração (#ajt-*).
//
//  Módulo UMD, sem dependências: no navegador vira window.LWAjusteTraco e liga
//  a ferramenta sozinho quando a página carrega; no Node, `require` devolve
//  só as funções puras (test/ajuste-traco.test.js).
//
//  Flow e densidade MEDIDOS vêm sozinhos do traço aberto: operacao.js chama
//  LWAjusteTraco.preencherLeitura() ao abrir o popover, ao digitar flow/
//  densidade no traço, ao trocar de traço e depois de um Ajuste de Receita
//  (ver _sincronizarAjusteTraco). A ferramenta só LÊ o traço — nada que se
//  digite aqui altera a operação em andamento. O registro e os coeficientes
//  ficam só neste navegador (localStorage) — ver CHAVE_PARAMS/CHAVE_REGISTRO.
//
//  Unidades: flow em cm, densidade em kg/m³, insumos em kg (e água em kg ≈ L).
//  O campo "Flow (mm)" do traço é em milímetros → convertido (MM_POR_CM).
//  Os coeficientes valem por kg de insumo para um traço com 1050 kg de
//  cimento (BASE_CIMENTO) e são escalados pelo cimento real do traço.
// ============================================================
(function (raiz, fabrica) {
  'use strict';
  const api = fabrica();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    raiz.LWAjusteTraco = api;
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

  // Cimento (kg) do traço de referência em que os coeficientes foram medidos.
  const BASE_CIMENTO = 1050;

  // Coeficientes iniciais, medidos em 198 ajustes (jun–nov/2026), por kg de
  // insumo num traço de 1050 kg de cimento. São indicativos.
  const PARAMS_PADRAO = Object.freeze({
    cimF: -0.158, // cimento → flow (cm/kg)
    cimD: 0.35,   // cimento → densidade (kg/m³ por kg)
    spF: 3.1,     // superplastificante → flow (cm/kg)
    aguaF: 0.28,  // água → flow (cm/kg)
    epsD: -17,    // EPS → densidade (kg/m³ por kg)
    epsF: -1.0,   // EPS → flow (cm/kg)
    spA: 0.1,     // SP mínimo ao subir flow (kg)
    spB: 0.03,    // SP a mais por cm de flow (kg)
    aimD: 0.4,    // corrigir densidade até esta fração da tolerância
    tolF: 2.5,    // tolerância de flow (± cm)
    tolD: 35,     // tolerância de densidade (± kg/m³)
  });

  const ROTULOS = Object.freeze({
    cimF: 'Cimento: flow (cm/kg)',
    cimD: 'Cimento: densidade (kg/m³ por kg)',
    spF: 'SP: flow (cm/kg)',
    aguaF: 'Água: flow (cm/kg)',
    epsD: 'EPS: densidade (kg/m³ por kg)',
    tolF: 'Tolerância flow (±cm)',
    tolD: 'Tolerância densidade (±kg/m³)',
    epsF: 'EPS: flow (cm/kg)',
    spA: 'SP mínimo ao subir flow (kg)',
    spB: 'SP a mais por cm de flow (kg)',
    aimD: 'Corrigir densidade até (fração da tolerância)',
  });

  // Leituras fora destas faixas quase sempre são erro de digitação.
  const LIMITES_LEITURA = Object.freeze({ flowMin: 20, flowMax: 70, densMin: 350, densMax: 600 });

  // Mínimo de registros "de um insumo só" para calibrar cada coeficiente.
  const MIN_REGISTROS_CALIBRACAO = 5;

  // Máximo de linhas do registro mostradas na tela (o CSV leva todas).
  const LINHAS_REGISTRO_VISIVEIS = 8;

  const CHAVE_PARAMS = 'lw_ajuste_traco_params';
  const CHAVE_REGISTRO = 'lw_ajuste_traco_registro';

  // ── Funções puras (sem DOM) ─────────────────────────────────

  /** Número em pt-BR com `casas` casas fixas (ex.: 1.050,5). */
  function formatar(x, casas) {
    const d = casas === undefined ? 0 : casas;
    return x.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  /** Número com sinal explícito (+1,5 / −1,5), usando o "−" tipográfico. */
  function formatarComSinal(x, casas) {
    const d = casas === undefined ? 1 : casas;
    return (x > 0 ? '+' : x < 0 ? '−' : '') + formatar(Math.abs(x), d);
  }

  /** Texto digitado (aceita vírgula) → número; vazio/ruim → NaN. */
  function lerNumero(texto) {
    return parseFloat(String(texto === undefined || texto === null ? '' : texto).replace(',', '.'));
  }

  /** Flow e densidade previstos depois de aplicar as doses `a` (c, w, s, e) em kg. */
  function preverEstado(flow, dens, k, a, P) {
    return {
      f: flow + P.cimF * k * a.c + P.aguaF * k * a.w + P.spF * k * a.s + P.epsF * k * a.e,
      d: dens + P.cimD * k * a.c + P.epsD * k * a.e,
    };
  }

  /**
   * Mensagem (string) se a leitura estiver fora da faixa esperada; senão null.
   * Só vale para números já válidos (os vazios são tratados à parte).
   */
  function validarLeitura(flow, dens) {
    const L = LIMITES_LEITURA;
    if (flow < L.flowMin || flow > L.flowMax || dens < L.densMin || dens > L.densMax) {
      return 'Confira os valores: flow entre ' + L.flowMin + ' e ' + L.flowMax +
        ' cm e densidade entre ' + L.densMin + ' e ' + L.densMax + ' kg/m³.';
    }
    return null;
  }

  /**
   * Calcula as doses a adicionar.
   * @param {number} flow       flow medido (cm)
   * @param {number} dens       densidade medida (kg/m³)
   * @param {number} alvoFlow   flow alvo (cm)
   * @param {number} alvoDens   densidade alvo (kg/m³)
   * @param {number} cimento    cimento do traço (kg) — escala os coeficientes
   * @param {object} [P]        coeficientes (padrão: PARAMS_PADRAO)
   * @returns {{a:{c:number,w:number,s:number,e:number}, k:number, fin:{f:number,d:number}}}
   *   a = doses (cimento, água, SP, EPS em kg); k = fator de escala; fin = previsão
   */
  function planejar(flow, dens, alvoFlow, alvoDens, cimento, P) {
    const p = P || PARAMS_PADRAO;
    const k = BASE_CIMENTO / cimento;
    const a = { c: 0, w: 0, s: 0, e: 0 };
    const margemD = p.aimD * p.tolD;

    // Corrige densidade (EPS se alta, cimento se baixa) e, a cada volta, o
    // cimento que sobe a densidade também baixa o flow — por isso itera.
    for (let i = 0; i < 8; i++) {
      let mudou = false;
      let x = preverEstado(flow, dens, k, a, p);
      if (x.d > alvoDens + p.tolD) {
        a.e += (x.d - (alvoDens + margemD)) / (-p.epsD * k);
        mudou = true;
      } else if (x.d < alvoDens - p.tolD) {
        a.c += ((alvoDens - margemD) - x.d) / (p.cimD * k);
        mudou = true;
      }
      x = preverEstado(flow, dens, k, a, p);
      if (x.f > alvoFlow + p.tolF) {
        a.c += (x.f - alvoFlow) / (-p.cimF * k);
        mudou = true;
      }
      if (!mudou) break;
    }
    a.c = Math.round(a.c);
    a.e = Math.round(a.e * 2) / 2;

    // Flow ainda baixo: sobe com SP (pouco) e, se faltar muito, com água.
    const x = preverEstado(flow, dens, k, a, p);
    if (x.f < alvoFlow - p.tolF) {
      const falta = alvoFlow - x.f;
      const ks = cimento / BASE_CIMENTO;
      const passoSp = cimento < 700 ? 0.05 : 0.1;
      if (falta <= 1.5) {
        a.s = Math.round(falta / (p.spF * k) * 20) / 20;
      } else {
        a.s = Math.min(0.5 * ks, Math.max(passoSp, Math.round((p.spA + p.spB * falta) * ks / passoSp) * passoSp));
        a.s = Math.round(a.s * 20) / 20;
        a.w = Math.max(0, Math.round((falta - p.spF * k * a.s) / (p.aguaF * k)));
      }
    }
    return { a, k, fin: preverEstado(flow, dens, k, a, p) };
  }

  /**
   * Linhas "Adicione" do resultado: uma por insumo com dose > 0.
   * `ref` é a observação da base de dados que originou o coeficiente.
   * @returns {Array<{id:string, nome:string, valor:number, casas:number, unidade:string, efeito:string, ref:string}>}
   */
  function descreverDoses(a, k, P) {
    const linhas = [];
    if (a.c) {
      linhas.push({
        id: 'cimento', nome: 'Cimento', valor: a.c, casas: 0, unidade: 'kg',
        efeito: 'flow ' + formatarComSinal(P.cimF * k * a.c) + ' cm · densidade ' + formatarComSinal(P.cimD * k * a.c, 0),
        ref: '64 ajustes só com cimento',
      });
    }
    if (a.w) {
      linhas.push({
        id: 'agua', nome: 'Água', valor: a.w, casas: 0, unidade: 'kg',
        efeito: 'flow ' + formatarComSinal(P.aguaF * k * a.w) + ' cm',
        ref: '21 ajustes água+SP, em geral 15 a 22 kg',
      });
    }
    if (a.s) {
      linhas.push({
        id: 'sp', nome: 'Superplastificante', valor: a.s, casas: 2, unidade: 'kg',
        efeito: 'flow ' + formatarComSinal(P.spF * k * a.s) + ' cm',
        ref: a.w
          ? 'com água, a faixa usada foi 0,1 a 0,8 kg (maioria 0,3 a 0,5). Cada 0,1 kg ≈ +0,3 cm'
          : '19 ajustes só com SP; tende a corrigir menos que o previsto',
      });
    }
    if (a.e) {
      linhas.push({
        id: 'eps', nome: 'EPS', valor: a.e, casas: 1, unidade: 'kg',
        efeito: 'densidade ' + formatarComSinal(P.epsD * k * a.e, 0) + ' · flow ' + formatarComSinal(P.epsF * k * a.e) + ' cm',
        ref: '15 ajustes; o efeito no flow vem de ajuste de campo (menos firme)',
      });
    }
    return linhas;
  }

  /**
   * Avisos mostrados abaixo do resultado (lista de textos).
   * @param {object} plano   retorno de planejar()
   * @param {number} alvoFlow
   * @param {number} alvoDens
   */
  function avisosDoPlano(plano, alvoFlow, alvoDens, P) {
    const { a, fin } = plano;
    const avisos = [];
    const any = a.c || a.w || a.s || a.e;
    const dentroFlow = Math.abs(fin.f - alvoFlow) <= P.tolF;
    const dentroDens = Math.abs(fin.d - alvoDens) <= P.tolD;
    if (any && (!dentroFlow || !dentroDens)) {
      avisos.push('Com essa dose a previsão ainda fica fora da tolerância. Meça e repita o ajuste.');
    }
    if (a.c > 70 || a.w > 35 || a.e > 6) {
      avisos.push('Dose alta. Aplique cerca de 70% primeiro, meça e complete.');
    }
    if (a.c > 106) {
      avisos.push('Acima do maior cimento visto nos dados (106 kg). Previsão pouco confiável.');
    }
    return avisos;
  }

  /**
   * Recalibra os coeficientes com o registro, usando a mediana do efeito
   * observado nos ajustes de UM insumo só (os que misturam insumos não
   * isolam o efeito). Cada coeficiente só muda com >= MIN_REGISTROS_CALIBRACAO.
   * @returns {{params:object, atualizados:string[], contagem:{cimento:number, sp:number, eps:number}}}
   */
  function calibrar(registro, P) {
    const params = { ...(P || PARAMS_PADRAO) };
    const mediana = arr => { const s = arr.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const efeitos = (filtro, fn) => registro.filter(filtro).map(fn);
    const k = e => BASE_CIMENTO / e.base;

    const cimF = efeitos(e => e.c > 0 && !e.w && !e.s && !e.e, e => (e.f1 - e.f0) / (e.c * k(e)));
    const spF = efeitos(e => e.s > 0 && !e.c && !e.w && !e.e, e => (e.f1 - e.f0) / (e.s * k(e)));
    const epsD = efeitos(e => e.e > 0 && !e.c && !e.w && !e.s, e => (e.d1 - e.d0) / (e.e * k(e)));
    const epsF = efeitos(e => e.e > 0 && !e.c && !e.w && !e.s, e => (e.f1 - e.f0) / (e.e * k(e)));

    const atualizados = [];
    if (cimF.length >= MIN_REGISTROS_CALIBRACAO) {
      params.cimF = +mediana(cimF).toFixed(3);
      atualizados.push('cimento ' + params.cimF + ' cm/kg (' + cimF.length + ')');
    }
    if (spF.length >= MIN_REGISTROS_CALIBRACAO) {
      params.spF = +mediana(spF).toFixed(2);
      atualizados.push('SP ' + params.spF + ' cm/kg (' + spF.length + ')');
    }
    if (epsF.length >= MIN_REGISTROS_CALIBRACAO) {
      params.epsF = +mediana(epsF).toFixed(2);
      atualizados.push('EPS no flow ' + params.epsF + ' cm/kg (' + epsF.length + ')');
    }
    if (epsD.length >= MIN_REGISTROS_CALIBRACAO) {
      params.epsD = +mediana(epsD).toFixed(1);
      atualizados.push('EPS ' + params.epsD + ' kg/m³ por kg (' + epsD.length + ')');
    }
    return { params, atualizados, contagem: { cimento: cimF.length, sp: spF.length, eps: epsD.length } };
  }

  /** Registro → texto CSV (separador ";", cabeçalho na 1ª linha). */
  function registroParaCsv(registro) {
    const cab = 'data;flow_ini;dens_ini;flow_fim;dens_fim;cimento_base;cimento;agua;sp;eps';
    const linhas = registro.map(e => [e.t, e.f0, e.d0, e.f1, e.d1, e.base, e.c, e.w, e.s, e.e].join(';'));
    return [cab].concat(linhas).join('\n');
  }

  /** Texto "cim 20, água 10…" dos insumos de uma linha do registro. */
  function resumirInsumos(e) {
    const partes = [e.c && 'cim ' + e.c, e.w && 'água ' + e.w, e.s && 'SP ' + e.s, e.e && 'EPS ' + e.e].filter(Boolean);
    return partes.join(', ') || 'só tempo';
  }

  // O campo "Flow (mm)" do traço (Registrar Operação) é em milímetros; a
  // ferramenta trabalha em centímetros (alvo 38, faixa 20–70).
  const MM_POR_CM = 10;

  /**
   * Leitura do traço → texto pros campos do popover ('' quando vazia ou
   * inválida; zero também conta como vazio — não existe flow/densidade 0).
   * @param {{flowMm?: (number|string), densidade?: (number|string)}} leitura
   * @returns {{flow: string, dens: string}}  flow em cm, densidade em kg/m³,
   *   com vírgula decimal (como a pessoa digitaria)
   */
  function converterLeitura(leitura) {
    const texto = (valor, divisor) => {
      const n = lerNumero(valor);
      if (!(n > 0)) return '';
      return String(+(n / divisor).toFixed(2)).replace('.', ',');
    };
    return {
      flow: texto(leitura && leitura.flowMm, MM_POR_CM),
      dens: texto(leitura && leitura.densidade, 1),
    };
  }

  /** Frase de "de onde vieram os valores" mostrada no topo do popover. */
  function descreverOrigem(rotulo, flow, dens) {
    if (!rotulo) return '';
    if (!flow && !dens) return rotulo + ' ainda sem flow e densidade medidos. Preencha no traço ou digite aqui.';
    const falta = !flow ? ' Falta o flow.' : !dens ? ' Falta a densidade.' : '';
    return 'Leitura do ' + rotulo + ', preenchida automaticamente (flow convertido de mm para cm).' + falta;
  }

  // Escapa texto que vira HTML (o registro vem do localStorage — pode ter sido editado).
  function escapar(t) {
    return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** Régua do flow/densidade: faixa-alvo, leitura atual e previsão. */
  function htmlMedidor(nome, atual, previsto, min, max, escalaMin, escalaMax, unidade, casas) {
    const pct = x => Math.max(0, Math.min(100, (x - escalaMin) / (escalaMax - escalaMin) * 100));
    return '<div class="ajt-medidor">' +
      '<div class="ajt-medidor-trilho">' +
      '<div class="ajt-medidor-faixa" style="left:' + pct(min) + '%;width:' + (pct(max) - pct(min)) + '%"></div>' +
      '<div class="ajt-medidor-atual" style="left:' + pct(atual) + '%"></div>' +
      '<div class="ajt-medidor-previsto" style="left:' + pct(previsto) + '%"></div>' +
      '</div>' +
      '<p class="ajt-medidor-legenda"><span>' + nome + ': ' + formatar(atual, casas) + ' ' + unidade + ' agora</span>' +
      '<b>previsto ' + formatar(previsto, casas) + '</b></p></div>';
  }

  // ── Armazenamento (localStorage com try/catch: pode estar bloqueado) ──

  function lerJson(storage, chave, padrao) {
    try {
      const bruto = storage && storage.getItem(chave);
      return bruto ? JSON.parse(bruto) : padrao;
    } catch (_) {
      return padrao;
    }
  }

  function gravarJson(storage, chave, valor) {
    try { if (storage) storage.setItem(chave, JSON.stringify(valor)); } catch (_) { /* sem persistência, sem quebrar a ferramenta */ }
  }

  function storagePadrao(doc) {
    try { return doc.defaultView && doc.defaultView.localStorage; } catch (_) { return null; }
  }

  // ── DOM ─────────────────────────────────────────────────────

  /**
   * Liga a ferramenta em #ajt. Idempotente (2ª chamada não faz nada).
   * @param {Document} doc
   * @param {{storage?: Storage}} [opcoes]  storage alternativo (testes)
   */
  function montar(doc, opcoes) {
    const caixa = doc.getElementById('ajt');
    if (!caixa || caixa.dataset.pronto === '1') return null;
    caixa.dataset.pronto = '1';

    const el = id => doc.getElementById(id);
    const storage = (opcoes && opcoes.storage) || storagePadrao(doc);
    const num = id => lerNumero(el(id).value);

    let P = { ...PARAMS_PADRAO, ...lerJson(storage, CHAVE_PARAMS, {}) };
    let registro = lerJson(storage, CHAVE_REGISTRO, []);
    if (!Array.isArray(registro)) registro = [];
    const salvar = () => {
      gravarJson(storage, CHAVE_PARAMS, P);
      gravarJson(storage, CHAVE_REGISTRO, registro);
    };

    const resultado = el('ajt-resultado');

    function renderResultado() {
      const f = num('ajt-flow'), d = num('ajt-dens');
      const tf = num('ajt-alvo-flow'), td = num('ajt-alvo-dens');
      const base = num('ajt-cimento-base');

      if ([f, d, tf, td, base].some(isNaN) || base <= 0) {
        resultado.innerHTML = '<p class="ajt-nota">Digite flow e densidade medidos para ver o ajuste.</p>';
        return;
      }
      const erroLeitura = validarLeitura(f, d);
      if (erroLeitura) {
        resultado.innerHTML = '<p class="ajt-status ajt-ruim">Leitura fora do esperado</p><p class="ajt-nota">' + erroLeitura + '</p>';
        return;
      }

      const plano = planejar(f, d, tf, td, base, P);
      const { a, k, fin } = plano;
      const algumaDose = a.c || a.w || a.s || a.e;
      let h = '';
      if (!algumaDose) {
        h += '<p class="ajt-status ajt-ok">Dentro da tolerância. Não precisa ajustar.</p>' +
          '<p class="ajt-nota">Nos dados, só 5 a 7% dos traços com flow entre 35 e 40 foram ajustados.</p>';
      } else {
        const linhas = descreverDoses(a, k, P).map(r =>
          '<tr><th>' + r.nome + '<div class="ajt-nota">' + r.ref + '</div></th>' +
          '<td><span class="ajt-dose">' + formatar(r.valor, r.casas) + ' <small>' + r.unidade + '</small></span>' +
          '<div class="ajt-nota">' + r.efeito + '</div></td></tr>').join('');
        h += '<p class="ajt-status">Adicione</p><table class="ajt-tabela ajt-doses">' + linhas + '</table>' +
          '<p class="ajt-nota">Batida extra: +' + (a.c >= 50 ? 2 : 1) + ' min. Meça de novo depois de misturar.</p>';
      }
      h += htmlMedidor('Flow', f, fin.f, tf - P.tolF, tf + P.tolF, 25, 55, 'cm', 1) +
        htmlMedidor('Densidade', d, fin.d, td - P.tolD, td + P.tolD, 380, 540, 'kg/m³', 0);
      avisosDoPlano(plano, tf, td, P).forEach(t => { h += '<p class="ajt-aviso">' + t + '</p>'; });
      resultado.innerHTML = h;

      // Pré-preenche "o que foi usado" com a sugestão (a pessoa corrige se usou outra dose).
      el('ajt-uso-cimento').value = a.c;
      el('ajt-uso-agua').value = a.w;
      el('ajt-uso-sp').value = a.s;
      el('ajt-uso-eps').value = a.e;
    }

    function renderRegistro() {
      const ult = registro.slice(-LINHAS_REGISTRO_VISIVEIS).reverse();
      el('ajt-registro').innerHTML = ult.length
        ? '<thead><tr><th>Data</th><th>Flow</th><th>Dens.</th><th>Insumos</th></tr></thead><tbody>' +
          ult.map(e => '<tr><td>' + escapar(String(e.t).slice(5)) + '</td>' +
            '<td>' + formatar(e.f0, 0) + '→' + formatar(e.f1, 0) + '</td>' +
            '<td>' + formatar(e.d0) + '→' + formatar(e.d1) + '</td>' +
            '<td>' + escapar(resumirInsumos(e)) + '</td></tr>').join('') + '</tbody>'
        : '<tbody><tr><td class="ajt-nota">Nenhum registro ainda.</td></tr></tbody>';
    }

    function renderParametros() {
      el('ajt-params').innerHTML = Object.keys(PARAMS_PADRAO).map(chave =>
        '<label class="form-label">' + ROTULOS[chave] +
        '<input class="form-input" data-param="' + chave + '" inputmode="decimal" value="' + P[chave] + '"></label>').join('');
    }

    function salvarRegistro() {
      const e = {
        t: new Date().toISOString().slice(0, 16).replace('T', ' '),
        f0: num('ajt-flow'), d0: num('ajt-dens'), f1: num('ajt-depois-flow'), d1: num('ajt-depois-dens'),
        base: num('ajt-cimento-base'), tf: num('ajt-alvo-flow'), td: num('ajt-alvo-dens'),
        c: num('ajt-uso-cimento') || 0, w: num('ajt-uso-agua') || 0, s: num('ajt-uso-sp') || 0, e: num('ajt-uso-eps') || 0,
      };
      if ([e.f0, e.d0, e.f1, e.d1, e.base].some(isNaN)) {
        el('ajt-msg').textContent = 'Preencha a leitura inicial, a leitura depois e o cimento do traço.';
        return;
      }
      registro.push(e);
      salvar();
      renderRegistro();
      el('ajt-msg').textContent = 'Registro salvo.';
      el('ajt-depois-flow').value = '';
      el('ajt-depois-dens').value = '';
    }

    function gerarCsv() {
      const t = el('ajt-csv');
      t.hidden = false;
      t.value = registroParaCsv(registro);
      t.select();
    }

    function limparRegistro() {
      const win = doc.defaultView;
      if (registro.length && win.confirm('Apagar todo o registro?')) {
        registro = [];
        salvar();
        renderRegistro();
      }
    }

    function calibrarComRegistro() {
      const r = calibrar(registro, P);
      P = r.params;
      el('ajt-msg-calibracao').textContent = r.atualizados.length
        ? 'Atualizado: ' + r.atualizados.join('; ') + '.'
        : 'Precisa de pelo menos ' + MIN_REGISTROS_CALIBRACAO + ' registros com um só insumo (cimento, SP ou EPS) para calibrar. Agora: cimento ' +
          r.contagem.cimento + ', SP ' + r.contagem.sp + ', EPS ' + r.contagem.eps + '.';
      salvar();
      renderParametros();
      renderResultado();
    }

    function restaurarPadrao() {
      P = { ...PARAMS_PADRAO };
      salvar();
      renderParametros();
      renderResultado();
      el('ajt-msg-calibracao').textContent = 'Valores padrão restaurados.';
    }

    // Leitura que veio do traço (ver preencherLeitura). null = nada preenchido
    // automaticamente ainda — a ferramenta serve também como calculadora solta.
    let ultimaLeitura = null;
    const origem = el('ajt-origem');

    /**
     * Preenche flow e densidade medidos com os do traço aberto em Registrar
     * Operação (operacao.js chama ao abrir o popover, ao digitar no traço,
     * ao trocar de traço e depois de um Ajuste de Receita).
     * Sem `forcar`, só mexe nos campos se a leitura mudou desde a última vez
     * — assim um "e se…" digitado aqui não é apagado a cada re-render do traço.
     * @param {{rotulo?: string, flowMm?: (number|string), densidade?: (number|string)}} leitura
     * @param {boolean} [forcar]  preenche mesmo que a leitura seja a mesma
     * @returns {boolean} true se preencheu
     */
    function preencherLeitura(leitura, forcar) {
      const { flow, dens } = converterLeitura(leitura);
      const rotulo = (leitura && leitura.rotulo) || '';
      const chave = [rotulo, flow, dens].join('|');
      if (!forcar && chave === ultimaLeitura) return false;
      ultimaLeitura = chave;
      el('ajt-flow').value = flow;
      el('ajt-dens').value = dens;
      if (origem) origem.textContent = descreverOrigem(rotulo, flow, dens);
      renderResultado();
      return true;
    }

    // Os campos de leitura/alvo recalculam o resultado; os de calibração gravam o coeficiente.
    caixa.addEventListener('input', e => {
      const alvo = e.target;
      if (alvo.dataset && alvo.dataset.param) {
        const v = lerNumero(alvo.value);
        if (!isNaN(v)) { P[alvo.dataset.param] = v; salvar(); renderResultado(); }
      } else if (alvo.dataset && alvo.dataset.calc === '1') {
        // Mexeu na leitura aqui → deixa claro que não é mais o valor do traço (e que o traço não muda).
        if (origem && ultimaLeitura !== null && (alvo.id === 'ajt-flow' || alvo.id === 'ajt-dens')) {
          origem.textContent = 'Valores alterados aqui — o traço não é modificado.';
        }
        renderResultado();
      }
    });
    el('ajt-btn-salvar').addEventListener('click', salvarRegistro);
    el('ajt-btn-csv').addEventListener('click', gerarCsv);
    el('ajt-btn-limpar').addEventListener('click', limparRegistro);
    el('ajt-btn-calibrar').addEventListener('click', calibrarComRegistro);
    el('ajt-btn-restaurar').addEventListener('click', restaurarPadrao);

    renderParametros();
    renderRegistro();
    renderResultado();
    instancia = { render: renderResultado, restaurarPadrao, preencherLeitura };
    return instancia;
  }

  // Ferramenta montada na página (a última chamada de montar com sucesso).
  let instancia = null;

  /** Atalho pra quem só tem o módulo (operacao.js): false se a ferramenta não está na página. */
  function preencherLeitura(leitura, forcar) {
    return instancia ? instancia.preencherLeitura(leitura, forcar) : false;
  }

  return {
    BASE_CIMENTO, MM_POR_CM, PARAMS_PADRAO, ROTULOS, LIMITES_LEITURA, CHAVE_PARAMS, CHAVE_REGISTRO,
    formatar, formatarComSinal, lerNumero, preverEstado, validarLeitura, planejar,
    descreverDoses, avisosDoPlano, calibrar, registroParaCsv, resumirInsumos,
    converterLeitura, descreverOrigem, preencherLeitura, montar,
  };
});
