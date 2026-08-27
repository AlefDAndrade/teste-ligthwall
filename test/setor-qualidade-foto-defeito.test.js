// ─── test/setor-qualidade-foto-defeito.test.js ──────────────────────────────
// Testa o ícone de câmera (📷) e o modal de fotos do defeito.
//
// ATENÇÃO — este arquivo já foi reescrito uma vez: a feature era testada
// como "1 ícone por PLACA, escondido até a placa ser marcada" (modelo
// antigo). Ela foi redesenhada pra "1 ícone por PALLET (cabeçalho, não por
// placa), sempre visível, independente de marcação" — ver comentário de
// `palletFotos` no topo de public/js/setor-qualidade.js e os commits
// "mudando a camera para ser r paletes e não por placas" e "fix(setor-
// qualidade): ícone de câmera do pallet sempre visível, independente do
// motivo". Os testes antigos (seletor `.sq-slab-foto`, que nunca existiu
// nesse modelo novo, e a expectativa de "escondido sem marcação") ficaram
// órfãos e sempre falhavam — não foram atualizados quando a feature mudou.
// Reescrito aqui pra cobrir o comportamento ATUAL.
//
// NÃO testa o pipeline de redimensionamento em si (_comprimirFotoDefeito):
// depende de <canvas>.getContext('2d') e de Image.onload disparando de
// verdade com os bytes da imagem — jsdom não implementa decodificação real
// de imagem/canvas sem o pacote nativo `canvas` (não instalado neste
// projeto). O que é testado aqui é tudo que RODA sem precisar decodificar
// pixel nenhum: se/quando o ícone aparece, o que o modal mostra, e que os
// <input type="file"> escondidos nascem com os atributos certos (câmera vs.
// galeria) — a composição final da imagem em si segue o mesmo padrão já
// usado (e não coberto por teste automatizado) em compressImage(),
// manutencao-front.js.
//
// Mesmo harness de test/setor-qualidade-trava.test.js — ver
// test/helpers/setor-qualidade-dom.js.

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick, OPERACAO_FILA, AVALIACAO_REGISTRADA } = require('./helpers/setor-qualidade-dom.js');

let dom;

beforeEach(() => {
  dom = montarTela();
});

after(() => {
  dom = null;
});

async function abrirFormulario(window) {
  window.SQ.startNew();
  await tick();
  window.SQ.iniciarAvaliacaoDaFila(OPERACAO_FILA.id);
  await tick();
}

function iconeDoPallet(window, sid) {
  return window.document.querySelector(`[data-pallet-id="${sid}"] .sq-pallet-foto`);
}

test('ícone de câmera aparece no CABEÇALHO de cada pallet assim que o formulário abre, mesmo sem nenhuma marcação', async () => {
  // Comportamento atual, por desenho: o ícone é do PALLET (1x no
  // cabeçalho), não de cada placa, e fica sempre visível — não precisa de
  // nenhuma marca pra aparecer (ver comentário de topo deste arquivo).
  const { window } = dom;
  await abrirFormulario(window);

  for (const sid of ['stack1', 'stack2', 'stack3', 'stack4']) {
    const icone = iconeDoPallet(window, sid);
    assert.ok(icone, `ícone do pallet ${sid} deveria existir no DOM`);
    assert.equal(window.getComputedStyle(icone).display, 'flex', `ícone do pallet ${sid} deveria estar visível`);
    assert.equal(icone.classList.contains('tem-foto'), false, 'sem fotos ainda, não deveria ter a classe tem-foto');
  }
});

test('clicar no ícone (pallet sem fotos ainda) abre o modal vazio, com botões de Câmera e Galeria', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  iconeDoPallet(window, 'stack1').click();

  const modal = window.document.querySelector('.sq-foto-modal-overlay');
  assert.ok(modal, 'o modal de fotos deveria abrir');
  assert.ok(modal.textContent.includes('Nenhuma foto ainda'), 'deveria mostrar a mensagem de galeria vazia');
  assert.ok(modal.textContent.includes('Pallet 1'), 'título deveria identificar de qual pallet é');

  const botoes = [...modal.querySelectorAll('.sq-foto-modal-acoes button')].map(b => b.textContent);
  assert.ok(botoes.some(t => t.includes('Câmera')), 'deveria ter um botão de Câmera');
  assert.ok(botoes.some(t => t.includes('Galeria')), 'deveria ter um botão de Galeria');
});

test('abrir o modal cria os 2 inputs de arquivo escondidos com os atributos certos (câmera vs. galeria)', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  iconeDoPallet(window, 'stack1').click();

  const inputs = [...window.document.querySelectorAll('input[type="file"]')];
  assert.equal(inputs.length, 2, 'deveriam existir exatamente 2 inputs de arquivo (câmera + galeria)');

  const inputCamera = inputs.find(i => i.capture === 'environment');
  const inputGaleria = inputs.find(i => i.multiple);
  assert.ok(inputCamera, 'deveria existir um input com capture="environment" (abre a câmera direto)');
  assert.ok(inputGaleria, 'deveria existir um input com multiple (várias fotos da galeria de uma vez)');
  assert.equal(inputCamera.accept, 'image/*');
  assert.equal(inputGaleria.accept, 'image/*');
});

test('os inputs de arquivo são reaproveitados entre pallets diferentes, não duplicam a cada clique', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  iconeDoPallet(window, 'stack1').click();
  window.document.querySelector('.sq-foto-modal-overlay')?.remove();
  iconeDoPallet(window, 'stack2').click();

  const inputs = [...window.document.querySelectorAll('input[type="file"]')];
  assert.equal(inputs.length, 2, 'não deveria criar um novo par de inputs a cada pallet aberto');
});

test('em modo visualização (avaliação já registrada com fotos), o ícone do pallet com foto vem marcado (tem-foto) e o modal mostra as fotos sem botões de Câmera/Galeria/remover', async () => {
  const { window } = dom;

  const FOTO_FAKE = 'data:image/jpeg;base64,AAAA'; // conteúdo não importa aqui — só testando o encanamento de exibição
  const avaliacaoComFoto = {
    ...AVALIACAO_REGISTRADA,
    // "palletFotos" mora no TOPO da avaliação, por pallet (sid) — não mais
    // por painel/placa (ver comentário de palletFotos, topo de
    // setor-qualidade.js, e evalObj.palletFotos em registerEvaluation).
    palletFotos: { stack1: [FOTO_FAKE] },
    paineis: [{
      avaliacaoId: AVALIACAO_REGISTRADA.id, pallet: 1, posicao: 1,
      tipoEsperado: 'SP', tipoObtido: 'SP', resultado: 'reprovado', linha: null,
      marcas: [{ color: 'vermelho', shape: 'circle', role: 'indicador' }],
      motivo: 'BC', motivoDescricao: null,
    }],
  };
  const domRegistrado = montarTela({ avaliacoesRegistradas: [avaliacaoComFoto] });
  const w = domRegistrado.window;
  w.SQ.navigateTo('dashboard');
  await tick(10); // espera carregarAvaliacoesQualidade() (fetch mockado) popular avaliacoesCache — mesmo padrão de setor-qualidade-espelho-bateria-dinamica.test.js

  w.SQ.viewHistoryRecord(AVALIACAO_REGISTRADA.id);
  await tick();

  const icone = iconeDoPallet(w, 'stack1');
  assert.ok(icone, 'ícone do pallet 1 deveria existir mesmo em modo visualização');
  assert.equal(w.getComputedStyle(icone).display, 'flex', 'pallet com foto deveria mostrar o ícone, mesmo em modo visualização');
  assert.ok(icone.classList.contains('tem-foto'), 'ícone deveria indicar visualmente que o pallet já tem foto');

  // Pallet 2 não tem entrada em palletFotos — ícone continua existindo
  // (sempre visível), mas sem a marcação de "tem foto".
  const iconeSemFoto = iconeDoPallet(w, 'stack2');
  assert.equal(iconeSemFoto.classList.contains('tem-foto'), false, 'pallet sem fotos não deveria ter a classe tem-foto');

  icone.click();
  const modal = w.document.querySelector('.sq-foto-modal-overlay');
  assert.ok(modal, 'o modal deveria abrir em modo visualização também');
  assert.equal(modal.querySelectorAll('.sq-foto-modal-acoes').length, 0, 'em modo visualização não deveria ter botões de Câmera/Galeria');
  assert.equal(modal.querySelectorAll('.sq-foto-modal-item img').length, 1, 'deveria mostrar a foto já registrada');
  assert.equal(modal.querySelectorAll('.sq-foto-modal-item-remover').length, 0, 'em modo visualização não deveria dar pra remover foto');
});

test('mais de 1 foto no mesmo pallet mostra o contador ao lado do ícone', async () => {
  const { window } = dom;

  const FOTO_1 = 'data:image/jpeg;base64,AAAA';
  const FOTO_2 = 'data:image/jpeg;base64,BBBB';
  const avaliacaoComFotos = {
    ...AVALIACAO_REGISTRADA,
    palletFotos: { stack1: [FOTO_1, FOTO_2] },
    paineis: [{
      avaliacaoId: AVALIACAO_REGISTRADA.id, pallet: 1, posicao: 1,
      tipoEsperado: 'SP', tipoObtido: 'SP', resultado: 'reprovado', linha: null,
      marcas: [{ color: 'vermelho', shape: 'circle', role: 'indicador' }],
      motivo: 'BC', motivoDescricao: null,
    }],
  };
  const domRegistrado = montarTela({ avaliacoesRegistradas: [avaliacaoComFotos] });
  const w = domRegistrado.window;
  w.SQ.navigateTo('dashboard');
  await tick(10);
  w.SQ.viewHistoryRecord(AVALIACAO_REGISTRADA.id);
  await tick();

  const icone = iconeDoPallet(w, 'stack1');
  const contagem = icone.querySelector('.sq-pallet-foto-contagem');
  assert.ok(contagem, 'com mais de 1 foto, deveria mostrar o contador');
  assert.equal(contagem.textContent, '2');

  assert.equal(w.document.querySelectorAll('.sq-foto-modal-item img').length, 0, 'modal não deveria estar aberto sozinho, sem clicar no ícone');
  icone.click();
  const modal = w.document.querySelector('.sq-foto-modal-overlay');
  assert.equal(modal.querySelectorAll('.sq-foto-modal-item img').length, 2, 'deveria mostrar as 2 fotos já registradas');
});
