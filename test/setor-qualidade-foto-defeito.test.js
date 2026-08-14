// ─── test/setor-qualidade-foto-defeito.test.js ──────────────────────────────
// Testa o ícone de câmera (📷) que aparece na placa quando ela é marcada
// como 2ª linha (azul) ou reprovada (vermelho) — pedido do usuário: "toda
// vez que uma placa for avaliada e for marcada como segunda linha ou
// reprovada... quero que apareça um ícone de câmera no painel" (ver
// _renderIconeFoto/_abrirGerenciadorFoto, public/js/setor-qualidade.js).
//
// NÃO testa o pipeline de redimensionamento em si (_comprimirFotoDefeito):
// depende de <canvas>.getContext('2d') e de Image.onload disparando de
// verdade com os bytes da imagem — jsdom não implementa decodificação real
// de imagem/canvas sem o pacote nativo `canvas` (não instalado neste
// projeto). O que é testado aqui é tudo que RODA sem precisar decodificar
// pixel nenhum: quando o ícone aparece/some, o que o modal mostra, e que os
// <input type="file"> escondidos nascem com os atributos certos (câmera vs.
// galeria) — a composição final da imagem em si segue o mesmo padrão já
// usado (e não coberto por teste automatizado) em compressImage(),
// manutencao-front.js.
//
// Mesmo harness de test/setor-qualidade-trava.test.js — ver
// test/helpers/setor-qualidade-dom.js.

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick, OPERACAO_FILA } = require('./helpers/setor-qualidade-dom.js');

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

test('ícone de câmera fica escondido numa placa sem marcação nenhuma', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  const icone = window.document.querySelector('.sq-slab[data-id="stack1-1"]').querySelector('.sq-slab-foto');
  assert.ok(icone, 'o elemento do ícone deveria existir no DOM (mesmo escondido)');
  assert.equal(window.getComputedStyle(icone).display, 'none', 'sem marcação, o ícone não deveria aparecer');
});

test('marcar uma placa de VERMELHO (reprovado) mostra o ícone de câmera', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();
  // Escolhe o primeiro motivo pra fechar o seletor obrigatório e liberar a tela.
  window.document.querySelector('.sq-motivo-popover-item').click();

  const icone = window.document.querySelector('.sq-slab[data-id="stack1-1"]').querySelector('.sq-slab-foto');
  assert.equal(icone.style.display, 'block', 'placa reprovada deveria mostrar o ícone de câmera');
});

test('marcar uma placa de AZUL (2ª linha) também mostra o ícone de câmera', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.azul').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();
  window.document.querySelector('.sq-motivo-popover-item').click();

  const icone = window.document.querySelector('.sq-slab[data-id="stack1-1"]').querySelector('.sq-slab-foto');
  assert.equal(icone.style.display, 'block', 'placa de 2ª linha também deveria mostrar o ícone de câmera');
});

test('marcar uma placa de VERDE (1ª linha, sem defeito) não mostra o ícone', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.verde').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();

  const icone = window.document.querySelector('.sq-slab[data-id="stack1-1"]').querySelector('.sq-slab-foto');
  assert.equal(window.getComputedStyle(icone).display, 'none', 'placa aprovada 1ª linha não deveria mostrar o ícone');
});

test('clicar no ícone abre o modal de gerenciamento de fotos, vazio', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();
  window.document.querySelector('.sq-motivo-popover-item').click();

  window.document.querySelector('.sq-slab[data-id="stack1-1"]').querySelector('.sq-slab-foto').click();

  const modal = window.document.querySelector('.sq-foto-modal-overlay');
  assert.ok(modal, 'o modal de fotos deveria abrir');
  assert.ok(modal.textContent.includes('Nenhuma foto ainda'), 'deveria mostrar a mensagem de galeria vazia');
  const botoes = [...modal.querySelectorAll('.sq-foto-modal-acoes button')].map(b => b.textContent);
  assert.ok(botoes.some(t => t.includes('Câmera')), 'deveria ter um botão de Câmera');
  assert.ok(botoes.some(t => t.includes('Galeria')), 'deveria ter um botão de Galeria');
});

test('abrir o modal cria os 2 inputs de arquivo escondidos com os atributos certos (câmera vs. galeria)', async () => {
  const { window } = dom;
  await abrirFormulario(window);

  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').click();
  window.document.querySelector('.sq-motivo-popover-item').click();
  window.document.querySelector('.sq-slab[data-id="stack1-1"]').querySelector('.sq-slab-foto').click();

  const inputs = [...window.document.querySelectorAll('input[type="file"]')];
  assert.equal(inputs.length, 2, 'deveriam existir exatamente 2 inputs de arquivo (câmera + galeria)');

  const inputCamera = inputs.find(i => i.capture === 'environment');
  const inputGaleria = inputs.find(i => i.multiple);
  assert.ok(inputCamera, 'deveria existir um input com capture="environment" (abre a câmera direto)');
  assert.ok(inputGaleria, 'deveria existir um input com multiple (várias fotos da galeria de uma vez)');
  assert.equal(inputCamera.accept, 'image/*');
  assert.equal(inputGaleria.accept, 'image/*');
});

test('em modo visualização (avaliação já registrada com fotos), o modal mostra as fotos mas sem botões de Câmera/Galeria/remover', async () => {
  const { window } = dom;
  const { AVALIACAO_REGISTRADA } = require('./helpers/setor-qualidade-dom.js');

  const FOTO_FAKE = 'data:image/jpeg;base64,AAAA'; // conteúdo não importa aqui — só testando o encanamento de exibição
  const avaliacaoComFoto = {
    ...AVALIACAO_REGISTRADA,
    paineis: [{
      avaliacaoId: AVALIACAO_REGISTRADA.id, pallet: 1, posicao: 1,
      tipoEsperado: 'SP', tipoObtido: 'SP', resultado: 'reprovado', linha: null,
      marcas: [{ color: 'vermelho', shape: 'circle', role: 'indicador' }],
      motivo: 'BC', motivoDescricao: null,
      fotos: [FOTO_FAKE],
    }],
  };
  const domRegistrado = montarTela({ avaliacoesRegistradas: [avaliacaoComFoto] });
  const w = domRegistrado.window;
  w.SQ.navigateTo('dashboard');
  await tick(10); // espera carregarAvaliacoesQualidade() (fetch mockado) popular avaliacoesCache — mesmo padrão de setor-qualidade-espelho-bateria-dinamica.test.js

  w.SQ.viewHistoryRecord(AVALIACAO_REGISTRADA.id);
  await tick();

  const icone = w.document.querySelector('.sq-slab[data-id="stack1-1"]').querySelector('.sq-slab-foto');
  assert.equal(icone.style.display, 'block', 'placa reprovada com foto deveria mostrar o ícone, mesmo em modo visualização');
  assert.ok(icone.classList.contains('tem-foto'), 'ícone deveria indicar visualmente que já tem foto');

  icone.click();
  const modal = w.document.querySelector('.sq-foto-modal-overlay');
  assert.ok(modal, 'o modal deveria abrir em modo visualização também');
  assert.equal(modal.querySelectorAll('.sq-foto-modal-acoes').length, 0, 'em modo visualização não deveria ter botões de Câmera/Galeria');
  assert.equal(modal.querySelectorAll('.sq-foto-modal-item img').length, 1, 'deveria mostrar a foto já registrada');
  assert.equal(modal.querySelectorAll('.sq-foto-modal-item-remover').length, 0, 'em modo visualização não deveria dar pra remover foto');
});

