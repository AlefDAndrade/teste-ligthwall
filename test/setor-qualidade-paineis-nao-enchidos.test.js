// ─── test/setor-qualidade-paineis-nao-enchidos.test.js ──────────────────────
// Testa a funcionalidade "🚫 Marcar Não Enchido" (Bateria Atual, ver
// public/js/bateria-atual.js): um lado de berço marcado como 'nao_enchido'
// ANTES do registro da operação vira, aqui no Setor de Qualidade, 1 painel A
// MENOS pra avaliar no pallet correspondente (ver _paleteDoBerco/
// _aplicarPaineisNaoEnchidos, setor-qualidade.js) — o painel nunca chegou a
// existir de verdade, não faz sentido pedir avaliação dele.
//
// A informação chega pelo campo "bercos_visuais" de cada item de
// GET /operacoes-nao-avaliadas (ver bercosVisuaisPorOperacoes, db.js, e
// lib/rotas/qualidade.js) — este teste simula esse formato direto no mock
// de fetch (ver helpers/setor-qualidade-dom.js).
//
// Mesmo harness de test/setor-qualidade-trava.test.js — ver
// test/helpers/setor-qualidade-dom.js pro porquê (script de front-end sem
// module.exports, precisa de DOM real pra rodar).

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick } = require('./helpers/setor-qualidade-dom.js');

// Operação com capacidade 20 (metade = 10) — mesma convenção de
// OPERACAO_FILA (helpers), mas com bercos_visuais anexado. Direcionamento
// esperado (ver _paleteDoBerco, setor-qualidade.js):
//   Berço 3,  esquerda -> stack3, posição 3  (1ª metade, esquerdo)
//   Berço 3,  direita  -> stack4, posição 3  (1ª metade, direito)
//   Berço 15, esquerda -> stack1, posição 5  (2ª metade = 15-10, esquerdo)
const OPERACAO_COM_NAO_ENCHIDOS = {
  id: 'op-ne-1',
  id_bateria: 'B3',
  turno: '2º TURNO',
  tipo_montagem: 'SP',
  data: '2026-07-01',
  fim: '2026-07-01T14:30:00.000Z',
  dimensao: 9,
  bercos_reais: 20,
  capacidade: 20,
  bercos_visuais: [
    { berco: 'B3', ordem: 3, estado_esquerda: 'nao_enchido', estado_direita: 'okay' },
    { berco: 'B7', ordem: 7, estado_esquerda: 'okay', estado_direita: 'baixou' }, // 'baixou' não remove nada — só 'nao_enchido' remove
    { berco: 'B15', ordem: 15, estado_esquerda: 'nao_enchido', estado_direita: 'nao_enchido' },
  ],
};

async function iniciarAvaliacaoComTipoFixo(window, operacaoId) {
  window.SQ.startNew();
  await tick();
  window.SQ.iniciarAvaliacaoDaFila(operacaoId);
  await tick();
  // Mesmo truque de setor-qualidade-pallets-extras.test.js: fixa o Tipo de
  // Montagem via changeMountType direto pelo código, sem depender de
  // config.json (não carregado neste harness — ver SQ.init()).
  const mountTypeSel = window.document.getElementById('sq-mountType');
  if (!mountTypeSel.querySelector('option[value="SP"]')) {
    mountTypeSel.insertAdjacentHTML('beforeend', '<option value="SP">Simples (SP)</option>');
  }
  mountTypeSel.value = 'SP';
  window.SQ.changeMountType();
}

let dom;

beforeEach(() => {
  dom = montarTela({ operacoesFila: [OPERACAO_COM_NAO_ENCHIDOS] });
});

after(() => {
  dom = null;
});

test('berço marcado "não enchido" remove 1 painel do pallet correspondente (não aparece mais na grade)', async () => {
  const { window } = dom;
  await iniciarAvaliacaoComTipoFixo(window, OPERACAO_COM_NAO_ENCHIDOS.id);

  // Capacidade 20 -> cada pallet-base nasceria com "espessura" (10) placas
  // (sq-thickness = capacidade/2, ver autoSetThickness/_definirThicknessReal).
  // Berço 3 esquerda removeu 1 de stack3 (1ª metade, esquerdo) -> 9 placas.
  // Berço 3 direita ficou 'okay' -> stack4 continua com 10.
  // Berço 15 esquerda E direita removeram 1 cada de stack1/stack2 (2ª
  // metade) -> 9 placas em cada.
  const contarPlacas = sid => window.document.querySelectorAll(`#${sid} .sq-slab`).length;

  assert.equal(contarPlacas('stack3'), 9, 'stack3 (berço 3, esquerdo) deveria ter 1 painel a menos');
  assert.equal(contarPlacas('stack4'), 10, 'stack4 (berço 3, direito) não deveria perder painel — só a esquerda foi marcada');
  assert.equal(contarPlacas('stack1'), 9, 'stack1 (berço 15, esquerdo) deveria ter 1 painel a menos');
  assert.equal(contarPlacas('stack2'), 9, 'stack2 (berço 15, direito) deveria ter 1 painel a menos');
});

test('berço marcado só "baixou" (vazamento comum) não remove nenhum painel da grade', async () => {
  const { window } = dom;
  await iniciarAvaliacaoComTipoFixo(window, OPERACAO_COM_NAO_ENCHIDOS.id);

  // Berço 7 (direita='baixou') mapeia pra stack4 (1ª metade, direito, ver
  // comentário no topo) — 'baixou' é só uma observação de vazamento, bem
  // diferente de 'nao_enchido': o painel dele CONTINUA existindo e
  // precisando de avaliação normal.
  const contarPlacas = sid => window.document.querySelectorAll(`#${sid} .sq-slab`).length;
  assert.equal(contarPlacas('stack4'), 10, 'vazamento ("baixou") não deveria remover nenhum painel da grade');
});

test('trocar o Tipo de Montagem DEPOIS do prefill não devolve os painéis "não enchidos" pra grade', async () => {
  const { window } = dom;
  await iniciarAvaliacaoComTipoFixo(window, OPERACAO_COM_NAO_ENCHIDOS.id);

  const contarPlacas = sid => window.document.querySelectorAll(`#${sid} .sq-slab`).length;
  assert.equal(contarPlacas('stack3'), 9, 'pré-condição: stack3 já deveria ter 1 painel a menos antes da troca');

  // Troca o Tipo de Montagem de novo — changeMountType() chama
  // _resetStacksParaPadrao() internamente (mesma função que o prefill
  // inicial usa), que agora precisa REAPLICAR a remoção, não só ter
  // aplicado uma vez no prefill (bug real, pego por este teste antes da
  // correção: a troca "enchia" a grade de novo, devolvendo o painel que
  // o operador já tinha marcado como não enchido em Bateria Atual).
  const mountTypeSel = window.document.getElementById('sq-mountType');
  mountTypeSel.value = 'SP'; // mesmo valor, só pra disparar o handler de novo
  window.SQ.changeMountType();

  assert.equal(contarPlacas('stack3'), 9, 'stack3 deveria continuar com 1 painel a menos depois de trocar o Tipo de Montagem');
  assert.equal(contarPlacas('stack1'), 9, 'stack1 deveria continuar com 1 painel a menos depois de trocar o Tipo de Montagem');
  assert.equal(contarPlacas('stack2'), 9, 'stack2 deveria continuar com 1 painel a menos depois de trocar o Tipo de Montagem');
});

test('sem berços marcados "não enchido" (bercos_visuais ausente ou vazio), grade nasce completa — comportamento de antes desta funcionalidade', async () => {
  const { montarTela: montar2 } = require('./helpers/setor-qualidade-dom.js');
  const domSemBercos = montar2(); // usa OPERACAO_FILA padrão do helper, sem bercos_visuais
  const { window } = domSemBercos;

  await iniciarAvaliacaoComTipoFixo(window, 'op-1'); // id de OPERACAO_FILA (helper)

  const contarPlacas = sid => window.document.querySelectorAll(`#${sid} .sq-slab`).length;
  // OPERACAO_FILA (helper) também tem capacidade 20 -> 10 placas por pallet-base.
  ['stack1', 'stack2', 'stack3', 'stack4'].forEach(sid => {
    assert.equal(contarPlacas(sid), 10, `${sid} deveria nascer com todas as placas, sem bercos_visuais`);
  });
});

test('o berço que falta é PULADO na numeração (não é só um índice deslocado) — quem vinha depois mantém o número verdadeiro', async () => {
  const { window } = dom;
  await iniciarAvaliacaoComTipoFixo(window, OPERACAO_COM_NAO_ENCHIDOS.id);

  const rotulo = (sid, posicao) => window.document.querySelector(`[data-id="${sid}-${posicao}"] .sq-slab-number`)?.textContent;

  // stack3 = 1ª metade, esquerdo (berços 1-10) — berço 3 removido (esquerda).
  // Antes da correção, a posição 3 (que agora guarda os dados do berço 4,
  // deslocados pra preencher o buraco) ficava rotulada "B3" por engano —
  // devia mostrar o berço 4 de verdade.
  assert.equal(rotulo('stack3', 1), 'B1');
  assert.equal(rotulo('stack3', 2), 'B2');
  assert.equal(rotulo('stack3', 3), 'B4', 'berço 3 sumiu — a posição 3 agora é o berço 4, não pode continuar rotulada B3');
  assert.equal(rotulo('stack3', 9), 'B10', 'último painel deveria ser o berço 10 (o maior berço desta metade), não B9');

  // stack1 = 2ª metade, esquerdo (berços 11-20) — berço 15 removido (esquerda e direita).
  assert.equal(rotulo('stack1', 4), 'B14');
  assert.equal(rotulo('stack1', 5), 'B16', 'berço 15 sumiu — a posição 5 agora é o berço 16');
  assert.equal(rotulo('stack1', 9), 'B20', 'último painel deveria ser o berço 20, não B19');

  // stack2 = 2ª metade, direito (berços 11-20) — berço 15 também removido aqui.
  assert.equal(rotulo('stack2', 5), 'B16', 'mesmo raciocínio do lado direito');

  // stack4 = 1ª metade, direito (berços 1-10) — nada removido deste lado
  // (berço 3 só foi marcado do lado esquerdo) — numeração direta, sem pulos.
  for (let i = 1; i <= 10; i++) assert.equal(rotulo('stack4', i), 'B' + i);
});

