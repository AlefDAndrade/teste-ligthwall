// ─── test/debriefing-valor-final.test.js ────────────────────────────────────
// Testa a correção de um bug real, encontrado analisando um backup do
// usuário: no popover de Debriefing (public/js/debriefing.js), os campos
// Flow e Densidade de um traço remedido apareciam SOMANDO o valor
// original com todas as remedições, em vez de mostrar só a mais
// recente — ex: Traço 9 com original=406, remedições=[389, 413]
// aparecia "Densidade 1.208" (406+389+413) em vez de "413" (última
// remedição, que é o valor de verdade).
//
// Causa: densidade/flow são RESULTADOS/medições — cada remedição
// SUBSTITUI a anterior, não se soma a ela (diferente de insumos como
// cimento/água, que são cumulativos de verdade: cada ajuste É material
// adicionado na batelada). O resto do sistema já tratava isso certo
// (ver db.js, "Final = última remedição" em rowParaTraco; e
// dashboard.js, _valRel/isResultado) — só faltava em debriefing.js.
//
// valorFinal() é uma função PRIVADA dentro da IIFE de debriefing.js (não
// exposta em window.LWDebriefing) — em vez de expor só pra viabilizar
// teste, este arquivo replica a MESMA lógica da função corrigida (copiada
// literalmente) e testa ela isolada. Mudança na função real precisa vir
// acompanhada da mesma mudança aqui, ou este teste passa a testar uma
// versão desatualizada — risco aceito em troca de não poluir a API
// pública só para teste.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Cópia literal de valorFinal() em public/js/debriefing.js — MANTER EM
// SINCRONIA se a função de lá mudar.
function valorFinal(v, ehResultado) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') {
    if (v.total !== undefined && v.total !== '') return parseFloat(v.total);
    const ajustes = Array.isArray(v.ajustes) ? v.ajustes : [];
    const base = parseFloat(v.original);
    if (ajustes.length) {
      if (ehResultado) {
        const ultimo = parseFloat(ajustes[ajustes.length - 1]);
        return isNaN(ultimo) ? (isNaN(base) ? null : base) : ultimo;
      }
      return ajustes.reduce((s, a) => s + (parseFloat(a) || 0), isNaN(base) ? 0 : base);
    }
    return isNaN(base) ? null : base;
  }
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

test('densidade/flow (resultado) usa a ultima remedicao, nunca soma - caso real do Traco 9', () => {
  const densidade = { original: 406, ajustes: [389, 413] };
  assert.equal(valorFinal(densidade, true), 413, 'deveria usar a ultima remedicao, nao somar 406+389+413=1208');

  const flow = { original: 42, ajustes: [41, 40] };
  assert.equal(valorFinal(flow, true), 40, 'deveria usar a ultima remedicao, nao somar 42+41+40=123');
});

test('resultado com uma unica remedicao usa ela, nao soma com o original', () => {
  assert.equal(valorFinal({ original: 400, ajustes: [420] }, true), 420);
});

test('resultado sem nenhuma remedicao usa o original', () => {
  assert.equal(valorFinal({ original: 405, ajustes: [] }, true), 405);
});

test('insumo (cimento/agua/etc - ehResultado=false) continua somando original+ajustes, comportamento correto e inalterado', () => {
  assert.equal(valorFinal({ original: 1000, ajustes: [20, 15] }, false), 1035);
});

test('valor numerico simples (sem ajustes) funciona igual para resultado e insumo', () => {
  assert.equal(valorFinal(405, true), 405);
  assert.equal(valorFinal(1000, false), 1000);
});

test('valor nulo/vazio retorna null', () => {
  assert.equal(valorFinal(null, true), null);
  assert.equal(valorFinal(undefined, true), null);
  assert.equal(valorFinal('', true), null);
});

test('campo "total" (formato legado/colapsado) tem prioridade sobre original+ajustes', () => {
  assert.equal(valorFinal({ total: 999, original: 100, ajustes: [50] }, true), 999);
});
