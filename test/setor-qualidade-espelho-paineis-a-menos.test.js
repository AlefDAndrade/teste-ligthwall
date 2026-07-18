// ─── test/setor-qualidade-espelho-paineis-a-menos.test.js ───────────────────
// Regressão de um bug real: nem o Espelho Visual (Setor de Qualidade →
// Dashboard) nem a Análise Focada mostravam corretamente um palete com
// painel a menos (berço "não enchido", ou lado só parcialmente cheio — ver
// test/setor-qualidade-paineis-nao-enchidos.test.js, onde a GRADE DE
// AVALIAÇÃO em si já tratava isso certinho).
//
// - Espelho Visual usava getSlabCount(bid) — função MOCADA, devolvia um
//   número FIXO (11/8/10) direto do ID da bateria, sem olhar pra avaliação
//   salva nenhuma. Todo palete sempre aparecia com a MESMA contagem.
// - Análise Focada usava totalPorPallet = Math.round(avaliacao.totalSlabs/4)
//   — dividia o TOTAL (soma dos 4 paletes) igualmente por 4, também sem
//   saber que um palete específico tinha 1 painel a menos que os outros.
//
// Os dados salvos (evalObj.paineis, ver registerEvaluation) sempre tiveram a
// contagem certa por palete — só faltava as duas telas de LEITURA usarem
// isso em vez de uma conta fixa/uniforme.

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick } = require('./helpers/setor-qualidade-dom.js');

// Pallet 1 com 9 painéis (1 a menos — simula um berço "não enchido" removido
// dali); pallets 2, 3 e 4 com 10 painéis cada, normal.
function _gerarPaineis(avaliacaoId) {
  const paineis = [];
  [1, 2, 3, 4].forEach(pallet => {
    const total = pallet === 1 ? 9 : 10;
    for (let posicao = 1; posicao <= total; posicao++) {
      paineis.push({ avaliacaoId, pallet, posicao, tipoEsperado: 'SP', tipoObtido: 'SP', resultado: '1a', linha: '1ª', marcas: [], motivo: null, motivoDescricao: null });
    }
  });
  return paineis;
}

const AVALIACAO_ASSIMETRICA = {
  id: 'av-assimetrica-1',
  batteryId: 'B7',
  turno: '1° TURNO',
  tempInput: '38°C',
  dtMontagem: '2026-07-01T10:00:00.000Z',
  dtEnchimento: '2026-07-01T10:30:00.000Z',
  dtDesmoldagem: '2026-07-01T12:00:00.000Z',
  observations: 'avaliação com pallet 1 tendo 1 painel a menos (berço não enchido)',
  montagem: { pallet1: 'SP', pallet2: 'SP', pallet3: 'SP', pallet4: 'SP' },
  totalSlabs: 39, // 9 + 10 + 10 + 10
  dimensaoOperacao: 9,
  registeredAt: '2026-07-01T12:05:00.000Z',
  linkedOperacaoId: 'op-assimetrica-1',
  paineis: _gerarPaineis('av-assimetrica-1'),
};

let dom;

beforeEach(() => {
  dom = montarTela({ avaliacoesRegistradas: [AVALIACAO_ASSIMETRICA] });
});

after(() => {
  dom = null;
});

function _paletesDoEspelho(window) {
  const container = window.document.getElementById('sq-mirror-container');
  const mapa = {};
  container.querySelectorAll('.sq-mini-pallet').forEach(col => {
    const numero = col.querySelector('.sq-mini-pallet-header').textContent.replace('P', '');
    mapa[numero] = col.querySelectorAll('.sq-mini-slab').length;
  });
  return mapa;
}

test('Espelho Visual: o pallet com 1 painel a menos aparece com 9 placas, os outros continuam com 10', async () => {
  const { window } = dom;
  window.sessionStorage.setItem('lw_role', 'Administrador');
  window.SQ.navigateTo('dashboard');
  await tick(10);

  const contagem = _paletesDoEspelho(window);
  assert.equal(contagem['1'], 9, 'Pallet 1 deveria aparecer com 9 placas (1 a menos), não 10');
  assert.equal(contagem['2'], 10, 'Pallet 2 não deveria ser afetado pela redução do Pallet 1');
  assert.equal(contagem['3'], 10, 'Pallet 3 não deveria ser afetado pela redução do Pallet 1');
  assert.equal(contagem['4'], 10, 'Pallet 4 não deveria ser afetado pela redução do Pallet 1');
});
