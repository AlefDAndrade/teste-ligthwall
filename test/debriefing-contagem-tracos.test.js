// ─── test/debriefing-contagem-tracos.test.js ────────────────────────────────
// Bug: o cabeçalho "Traços" do Debriefing deduplicava traços pelo
// num_traco — que NÃO é único no dia (base de numeração lida no início da
// operação, contador só avança ao finalizar; operações sobrepostas ou
// virando o dia repetem números). Dois traços diferentes com o mesmo Nº
// viravam um só (ex.: 17 batidos aparecendo como 15).
//
// calcularCabecalho() é privada na IIFE de debriefing.js — mesmo esquema de
// test/debriefing-valor-final.test.js: cópia da lógica de contagem, MANTER
// EM SINCRONIA com a função real.

const { test } = require('node:test');
const assert = require('node:assert/strict');

function contarTracos(estrutura) {
  const tracosUnicos = new Set();
  estrutura.forEach(({ tracos }) => {
    tracos.forEach(t => {
      if (!t.reaproveitado) {
        const chave = t.id_traco != null
          ? 'id:' + t.id_traco
          : (t.num_traco != null ? 'num:' + t.num_traco : '_' + Math.random());
        tracosUnicos.add(chave);
      }
    });
  });
  return tracosUnicos.size;
}

test('traços diferentes com o mesmo num_traco contam separado', () => {
  const estrutura = [
    { bateria: { id: 'op_1' }, tracos: [
      { id_traco: 'a', num_traco: 1 }, { id_traco: 'b', num_traco: 2 },
    ] },
    // 2ª operação pegou a mesma base (1ª ainda não tinha finalizado)
    { bateria: { id: 'op_2' }, tracos: [
      { id_traco: 'c', num_traco: 1 }, { id_traco: 'd', num_traco: 2 },
    ] },
  ];
  assert.equal(contarTracos(estrutura), 4);
});

test('reaproveitado (sobra) continua não sendo contado de novo', () => {
  const estrutura = [
    { bateria: { id: 'op_1' }, tracos: [{ id_traco: 'a', num_traco: 1 }, { id_traco: 'b', num_traco: 2 }] },
    { bateria: { id: 'op_2' }, tracos: [{ id_traco: 'b', num_traco: 2, reaproveitado: true }, { id_traco: 'c', num_traco: 3 }] },
  ];
  assert.equal(contarTracos(estrutura), 3);
});

test('mesmo traço (mesmo id) em 2 baterias sem flag conta 1 vez', () => {
  const estrutura = [
    { bateria: { id: 'op_1' }, tracos: [{ id_traco: 'a', num_traco: 1 }] },
    { bateria: { id: 'op_2' }, tracos: [{ id_traco: 'a', num_traco: 1 }] },
  ];
  assert.equal(contarTracos(estrutura), 1);
});
