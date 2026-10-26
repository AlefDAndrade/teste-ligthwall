// ============================================================
//  placas-8mm.js — regra das placas cimentícias de 8 mm
//
//  Módulo UMD, sem dependências: no navegador vira window.LWPlacas8mm
//  (usado por offline.html, que é standalone e não carrega data.js);
//  no servidor, `require('.../placas-8mm.js')` (usado ao validar uma
//  operação offline, lib/rotas/operacao-offline.js, que recalcula o valor
//  em vez de confiar no que o aparelho mandou).
//
//  Painéis de 9,5 cm usam placa de 8 mm; qualquer outra dimensão usa 6 mm.
//  Uma bateria pode misturar dimensões berço a berço (bercos_dimensoes).
//  A mesma regra existe em data.js (LW.calcPlacas8mm), que o app online
//  usa; test/placas-8mm-offline.test.js garante que as duas dão o mesmo
//  resultado. Se uma espessura nova passar a usar 8 mm, altere as DUAS.
// ============================================================
(function (raiz, fabrica) {
  'use strict';
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.LWPlacas8mm = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ESPESSURAS_PLACA_8MM_CM = [9.5];
  const TIPO_MONTAGEM_PERSONALIZADA = 'PERSONALIZADA';

  function dimensaoParaNumero(dim) {
    if (dim == null) return null;
    const n = parseFloat(String(dim).replace(/cm/i, '').trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }

  function dimensaoUsaPlaca8mm(dim) {
    const n = dimensaoParaNumero(dim);
    return n !== null && ESPESSURAS_PLACA_8MM_CM.some(e => Math.abs(e - n) < 0.001);
  }

  function dimensoesPorLadoDoBerco(item, dimensaoGeral) {
    const geral = dimensaoGeral || '';
    if (item && typeof item === 'object') {
      return { direita: item.direita || geral, esquerda: item.esquerda || geral };
    }
    const d = item || geral;
    return { direita: d, esquerda: d };
  }

  function dimensoesEfetivasPorLado(capacidade, dimensaoGeral, bercosDimensoes) {
    const over = Array.isArray(bercosDimensoes) ? bercosDimensoes : [];
    return Array.from({ length: Number(capacidade) || 0 }, (_, i) => dimensoesPorLadoDoBerco(over[i], dimensaoGeral));
  }

  function dimensoesDistintas(capacidade, dimensaoGeral, bercosDimensoes) {
    const vistas = [];
    dimensoesEfetivasPorLado(capacidade, dimensaoGeral, bercosDimensoes).forEach(l => {
      [l.direita, l.esquerda].forEach(d => { if (d && !vistas.includes(d)) vistas.push(d); });
    });
    return vistas;
  }

  function rotuloDimensoesMistas(capacidade, dimensaoGeral, bercosDimensoes) {
    const dims = dimensoesDistintas(capacidade, dimensaoGeral, bercosDimensoes);
    return dims.length > 1 ? 'Personalizada / ' + dims.join(' + ') : null;
  }

  function textoDimensaoBerco(item, dimensaoGeral) {
    const l = dimensoesPorLadoDoBerco(item, dimensaoGeral);
    if (l.direita === l.esquerda) return l.direita;
    return 'Dir. ' + (l.direita || '—') + ' · Esq. ' + (l.esquerda || '—');
  }

  function compactarBercosDimensoes(porLado, dimensaoGeral) {
    const itens = (porLado || []).map(l => {
      if (l.direita === dimensaoGeral && l.esquerda === dimensaoGeral) return null;
      if (l.direita === l.esquerda) return l.direita;
      return { direita: l.direita === dimensaoGeral ? null : l.direita, esquerda: l.esquerda === dimensaoGeral ? null : l.esquerda };
    });
    return itens.some(Boolean) ? itens : null;
  }

  // paineis_<tipo>_por_berco → { tipo: qtd } (mesma leitura de data.js)
  function porBercoDaOpcao(opcao) {
    const porBerco = {};
    Object.keys(opcao || {}).forEach(chave => {
      const m = chave.match(/^paineis_(.+)_por_berco$/);
      if (m) porBerco[m[1]] = Number(opcao[chave]) || 0;
    });
    return porBerco;
  }

  /**
   * Placas de 8 mm consumidas. `montagemOpcoes` = tipos_montagem.opcoes do
   * config.json (de onde saem painéis/berço e placas cimentícia por painel).
   * `marcacoes` = { B1: { direita, esquerda, tipos } } (Não Enchido desconta).
   */
  function calcPlacas8mm({ tipoMontagem, bercosPersonalizados, capacidade, dimensaoGeral, bercosDimensoes, marcacoes, montagemOpcoes }) {
    const dims = dimensoesEfetivasPorLado(capacidade, dimensaoGeral, bercosDimensoes);
    if (!dims.some(l => dimensaoUsaPlaca8mm(l.direita) || dimensaoUsaPlaca8mm(l.esquerda))) return 0;

    const opcoes = Array.isArray(montagemOpcoes) ? montagemOpcoes : [];
    const cimenticia = {};
    opcoes.forEach(o => {
      if (o.modo === 'simples' && o.tipo) {
        cimenticia[o.tipo] = (o.cimenticia && o.cimenticia.leva) ? (Number(o.cimenticia.quantidade) || 0) : 0;
      }
    });
    const placasDoTipo = tipo => cimenticia[tipo] || 0;

    const tipoDoLado = (bercoNum, lado) => {
      if (tipoMontagem === TIPO_MONTAGEM_PERSONALIZADA) {
        const valor = Array.isArray(bercosPersonalizados) ? bercosPersonalizados[bercoNum - 1] : null;
        if (!valor) return null;
        return typeof valor === 'object' ? (valor[lado] || null) : valor;
      }
      const opcao = opcoes.find(o => o.label === tipoMontagem);
      if (!opcao) return null;
      if (opcao.modo === 'simples') return opcao.tipo || null;
      if (opcao.modo === 'hibrida' && Array.isArray(opcao.tipos)) return lado === 'direita' ? (opcao.tipos[0] || null) : (opcao.tipos[1] || null);
      return null;
    };

    let total = 0;
    dims.forEach((lados, i) => {
      const d8 = dimensaoUsaPlaca8mm(lados.direita);
      const e8 = dimensaoUsaPlaca8mm(lados.esquerda);
      if (!d8 && !e8) return;
      const bercoNum = i + 1;
      let porBerco = {};
      if (tipoMontagem === TIPO_MONTAGEM_PERSONALIZADA) {
        const valor = Array.isArray(bercosPersonalizados) ? bercosPersonalizados[i] : null;
        if (!valor) return;
        if (typeof valor === 'object') {
          ['direita', 'esquerda'].forEach(lado => { if (valor[lado]) porBerco[valor[lado]] = (porBerco[valor[lado]] || 0) + 1; });
        } else {
          const opcao = opcoes.find(o => o.modo === 'simples' && o.tipo === valor);
          if (opcao) porBerco = porBercoDaOpcao(opcao);
        }
      } else {
        const opcao = opcoes.find(o => o.label === tipoMontagem);
        porBerco = opcao ? porBercoDaOpcao(opcao) : { sp: 2 };
      }
      if (d8 && e8) {
        Object.keys(porBerco).forEach(tipo => { total += (porBerco[tipo] || 0) * placasDoTipo(tipo); });
      } else {
        const tipo = tipoDoLado(bercoNum, d8 ? 'direita' : 'esquerda');
        if (tipo) total += placasDoTipo(tipo);
      }

      const doBerco = (marcacoes && (marcacoes['B' + bercoNum] || marcacoes[bercoNum])) || {};
      [['direita', d8], ['esquerda', e8]].forEach(([lado, is8]) => {
        if (!is8 || doBerco[lado] !== 'nao_enchido') return;
        const tipo = (doBerco.tipos && doBerco.tipos[lado]) || tipoDoLado(bercoNum, lado);
        if (tipo) total -= placasDoTipo(tipo);
      });
    });
    return Math.max(0, total);
  }

  return {
    ESPESSURAS_PLACA_8MM_CM,
    dimensaoUsaPlaca8mm,
    dimensoesPorLadoDoBerco,
    dimensoesEfetivasPorLado,
    textoDimensaoBerco,
    compactarBercosDimensoes,
    dimensoesDistintas,
    rotuloDimensoesMistas,
    calcPlacas8mm,
  };
});
