// ─── test/setor-qualidade-pallets-extras.test.js ────────────────────────────
// Testa o botão "+" de novo pallet (vazio) e o arrastar-e-soltar de placas
// entre pallets no Setor de Qualidade (ver SQ.adicionarPalletExtra/
// _moverPainel em public/js/setor-qualidade.js) — pedido do usuário:
//   1. "+" discreto ao lado do último pallet cria um pallet NOVO, VAZIO.
//   2. Segurar-e-arrastar uma placa move ela pro pallet de destino.
//   3. O pallet de origem RENUMERA pra fechar o buraco deixado.
//   4. O tipo esperado (SP/2P/3T) viaja COM a placa — não fica preso ao
//      pallet de destino (o pallet novo não tem tipo próprio).
//   5. Permite vários pallets extras (5º, 6º, 7º…), sem limite.
//
// Mesmo harness de test/setor-qualidade-trava.test.js — ver
// test/helpers/setor-qualidade-dom.js pro porquê (script de front-end sem
// module.exports, precisa de DOM real pra rodar).

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick, soltarPlacaNoPallet, OPERACAO_FILA, AVALIACAO_REGISTRADA } = require('./helpers/setor-qualidade-dom.js');

let dom;

beforeEach(() => {
  dom = montarTela();
});

after(() => {
  dom = null;
});

// Abre uma avaliação nova, vinculada à fila, e marca as placas `ids` como
// aprovadas (círculo verde) — usado pra dar às placas movidas um conteúdo
// real (marca) pra verificar que ele viaja junto no arraste.
//
// Fixa o Tipo de Montagem em 'SP' via changeMountType (direto pelo código)
// em vez de confiar na resolução automática por label de
// _prefillFromOperacao/_codigoMontagemPorLabel — essa resolução depende de
// config.json (tipos_montagem.opcoes), carregado só em SQ.init(), que o
// harness de teste não chama; sem isso os 4 pallets ficariam sem tipo
// (palletTypes em branco) por causa do ambiente de teste, não por causa
// do recurso sendo testado aqui.
async function iniciarAvaliacaoEMarcar(window, ids) {
  window.SQ.startNew();
  await tick();
  window.SQ.iniciarAvaliacaoDaFila(OPERACAO_FILA.id);
  await tick();
  const mountTypeSel = window.document.getElementById('sq-mountType');
  if (!mountTypeSel.querySelector('option[value="SP"]')) {
    mountTypeSel.insertAdjacentHTML('beforeend', '<option value="SP">Simples (SP)</option>');
  }
  mountTypeSel.value = 'SP';
  window.SQ.changeMountType();
  ids.forEach(id => {
    const slab = window.document.querySelector(`.sq-slab[data-id="${id}"]`);
    slab.click(); // 1º clique = marca verde (aprovado), ver toggleMark/selectedColor
  });
}

test('o botão "+" existe e cria um pallet novo, vazio', async () => {
  const { window } = dom;
  await iniciarAvaliacaoEMarcar(window, []);

  const btn = window.document.getElementById('sq-btn-add-pallet');
  assert.ok(btn, 'botão de novo pallet deveria existir no DOM');

  window.SQ.adicionarPalletExtra();

  const coluna = window.document.getElementById('stack5');
  assert.ok(coluna, 'coluna do pallet 5 deveria existir depois de clicar em "+"');
  assert.equal(coluna.children.length, 0, 'pallet novo deve nascer SEM nenhuma placa');
  assert.ok(window.document.getElementById('sq-p5-comprimento'), 'coluna de Medição do pallet 5 também deveria existir');
});

test('permite criar vários pallets extras (5º, 6º, 7º…)', async () => {
  const { window } = dom;
  await iniciarAvaliacaoEMarcar(window, []);

  window.SQ.adicionarPalletExtra();
  window.SQ.adicionarPalletExtra();
  window.SQ.adicionarPalletExtra();

  ['stack5', 'stack6', 'stack7'].forEach(sid => {
    assert.ok(window.document.getElementById(sid), `${sid} deveria existir`);
  });
  // O "+" continua por último, depois do 7º pallet.
  const stacksWrap = window.document.querySelector('.sq-stacks');
  assert.equal(stacksWrap.lastElementChild.id, 'sq-btn-add-pallet');
});

test('arrastar uma placa pro pallet novo: sai de onde estava, chega vazia lá, carrega o tipo esperado', async () => {
  const { window } = dom;
  // OPERACAO_FILA tem tipo_montagem 'SP' — os 4 pallets originais nascem
  // todos SP (ver _codigoMontagemPorLabel/_prefillFromOperacao).
  await iniciarAvaliacaoEMarcar(window, ['stack1-3']);
  window.SQ.adicionarPalletExtra();

  soltarPlacaNoPallet(window, 'stack1-3', 'stack5');

  // Chegou no destino, na posição 1 (pallet nasceu vazio).
  const novaPlaca = window.document.querySelector('.sq-slab[data-id="stack5-1"]');
  assert.ok(novaPlaca, 'a placa deveria estar em stack5-1 depois do arraste');
  assert.ok(novaPlaca.querySelector('.sq-slab-marks').children.length > 0, 'a marca (aprovado) deveria ter viajado junto');

  // O tipo esperado (SP) viaja COM a placa — pedido do usuário: "o tipo já
  // é definido na placa", não no pallet de destino (que não tem tipo).
  const tipoNaPlacaNova = novaPlaca.querySelector('.sq-slab-type').textContent;
  assert.equal(tipoNaPlacaNova, 'SP');
});

test('o pallet de origem renumera pra fechar o buraco deixado', async () => {
  const { window } = dom;
  await iniciarAvaliacaoEMarcar(window, ['stack1-3']);
  window.SQ.adicionarPalletExtra();

  const totalAntes = window.document.getElementById('stack1').children.length;
  soltarPlacaNoPallet(window, 'stack1-3', 'stack5');

  const stack1 = window.document.getElementById('stack1');
  assert.equal(stack1.children.length, totalAntes - 1, 'o pallet 1 deveria ter uma placa a menos');
  // Nenhum buraco: os ids continuam sequenciais 1..N, sem pular número.
  const idsRestantes = Array.from(stack1.querySelectorAll('.sq-slab')).map(el => el.dataset.id);
  const esperados = Array.from({ length: totalAntes - 1 }, (_, i) => `stack1-${i + 1}`);
  assert.deepEqual(idsRestantes, esperados, 'as placas restantes deveriam renumerar sem buraco');
});

test('soltar no próprio pallet de origem não faz nada (no-op)', async () => {
  const { window } = dom;
  await iniciarAvaliacaoEMarcar(window, ['stack1-2']);
  const totalAntes = window.document.getElementById('stack1').children.length;

  soltarPlacaNoPallet(window, 'stack1-2', 'stack1');

  assert.equal(window.document.getElementById('stack1').children.length, totalAntes);
  assert.ok(window.document.querySelector('.sq-slab[data-id="stack1-2"]'), 'a placa deveria continuar exatamente onde estava');
});

test('dá pra arrastar de volta: pallet extra pra um pallet original', async () => {
  const { window } = dom;
  await iniciarAvaliacaoEMarcar(window, ['stack1-1']);
  window.SQ.adicionarPalletExtra();
  soltarPlacaNoPallet(window, 'stack1-1', 'stack5'); // vai pro extra

  soltarPlacaNoPallet(window, 'stack5-1', 'stack2'); // volta pra um original, no fim da fila dele

  assert.equal(window.document.getElementById('stack5').children.length, 0, 'pallet extra deveria ficar vazio de novo');
  const ultimaDoStack2 = Array.from(window.document.getElementById('stack2').children).pop();
  assert.ok(ultimaDoStack2, 'stack2 deveria ter recebido a placa no fim');
});

test('o total de placas somando todos os pallets não muda ao mover (só redistribui)', async () => {
  const { window } = dom;
  await iniciarAvaliacaoEMarcar(window, ['stack1-1']);
  const totalAntesDoArraste = ['stack1','stack2','stack3','stack4']
    .reduce((soma, sid) => soma + window.document.getElementById(sid).children.length, 0);

  window.SQ.adicionarPalletExtra();
  soltarPlacaNoPallet(window, 'stack1-1', 'stack5');

  // Total de placas não muda só de mover — continua o mesmo, agora
  // distribuído em 5 pallets em vez de 4 (é isso que registerEvaluation
  // usa pra totalSlabs — ver _stackIds().reduce(...) no código).
  const totalDepois = ['stack1','stack2','stack3','stack4','stack5']
    .reduce((soma, sid) => soma + window.document.getElementById(sid).children.length, 0);
  assert.equal(totalDepois, totalAntesDoArraste, 'mover placa entre pallets não deveria mudar o total');
});

test('reabrir uma avaliação registrada com painel no pallet 5 reconstrói o pallet extra', async () => {
  const avaliacaoComExtra = {
    ...AVALIACAO_REGISTRADA,
    id: 'av-2',
    paineis: [
      { avaliacaoId: 'av-2', pallet: 1, posicao: 1, tipoEsperado: 'SP', tipoObtido: 'SP', resultado: 'aprovado', marcas: [{ shape: 'circle', color: 'verde' }] },
      { avaliacaoId: 'av-2', pallet: 5, posicao: 1, tipoEsperado: 'SP', tipoObtido: 'SP', resultado: 'aprovado', marcas: [{ shape: 'circle', color: 'verde' }] },
    ],
  };
  const domComExtra = montarTela({ avaliacoesRegistradas: [avaliacaoComExtra] });
  const { window } = domComExtra;

  window.sessionStorage.setItem('lw_role', 'Administrador');
  window.SQ.navigateTo('dashboard');
  await tick(10);

  window.SQ.editarAvaliacaoDoEspelho();
  window.document.getElementById('sq-modal-ok').onclick();
  await tick();

  const coluna = window.document.getElementById('stack5');
  assert.ok(coluna, 'a coluna do pallet 5 deveria ser recriada ao reabrir a avaliação');
  assert.equal(coluna.children.length, 1, 'deveria ter exatamente 1 placa reconstruída no pallet 5');
});

test('salvar como rascunho e retomar depois preserva o pallet extra e a placa que foi arrastada', async () => {
  const { window } = dom;
  await iniciarAvaliacaoEMarcar(window, ['stack1-1']);
  window.SQ.adicionarPalletExtra();
  soltarPlacaNoPallet(window, 'stack1-1', 'stack5');
  window.SQ.saveDraft();

  const chave = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i))
    .find(k => k.startsWith('sq_draft_'));
  const draftId = chave.replace('sq_draft_', '');

  // Simula fechar e reabrir a tela.
  window.SQ.startNew();
  await tick();
  window.SQ.loadDraft(draftId);
  await tick();

  const coluna = window.document.getElementById('stack5');
  assert.ok(coluna, 'o pallet extra deveria voltar ao retomar o rascunho');
  assert.equal(coluna.children.length, 1, 'a placa movida deveria continuar lá');
  const placa = window.document.querySelector('.sq-slab[data-id="stack5-1"]');
  assert.ok(placa.querySelector('.sq-slab-marks').children.length > 0, 'a marca deveria ter sido preservada também');
});

test('excluir um pallet extra VAZIO remove direto, sem confirmação', async () => {
  const { window } = dom;
  await iniciarAvaliacaoEMarcar(window, []);
  window.SQ.adicionarPalletExtra();
  assert.ok(window.document.getElementById('stack5'));

  window.SQ.removerPalletExtra(5);

  assert.equal(window.document.getElementById('stack5'), null, 'a coluna do pallet 5 deveria sumir');
  assert.equal(window.document.getElementById('sq-p5-comprimento'), null, 'a coluna de Medição do pallet 5 também deveria sumir');
});

test('excluir um pallet extra COM placas pede confirmação antes', async () => {
  const { window } = dom;
  await iniciarAvaliacaoEMarcar(window, ['stack1-1']);
  window.SQ.adicionarPalletExtra();
  soltarPlacaNoPallet(window, 'stack1-1', 'stack5');

  window.SQ.removerPalletExtra(5);
  // Ainda não excluiu — esperando confirmação.
  assert.ok(window.document.getElementById('stack5'), 'não deveria excluir sem confirmar, com placa dentro');
  assert.equal(window.document.getElementById('sq-modal').classList.contains('open'), true, 'o modal de confirmação deveria estar aberto');

  window.document.getElementById('sq-modal-ok').onclick(); // confirma
  assert.equal(window.document.getElementById('stack5'), null, 'agora sim deveria excluir, depois de confirmar');
});

test('excluir um pallet extra libera o número pro próximo "+" não reaproveitar', async () => {
  const { window } = dom;
  await iniciarAvaliacaoEMarcar(window, []);
  window.SQ.adicionarPalletExtra(); // stack5
  window.SQ.adicionarPalletExtra(); // stack6
  window.SQ.removerPalletExtra(6);
  window.SQ.adicionarPalletExtra(); // deveria ser stack7, não reaproveitar o 6

  assert.ok(window.document.getElementById('stack5'));
  assert.equal(window.document.getElementById('stack6'), null);
  assert.ok(window.document.getElementById('stack7'), 'o próximo "+" deveria pular pro 7, não reaproveitar o 6 excluído');
});