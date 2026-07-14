// ─── test/setor-qualidade-identificacao-automatica.test.js ──────────────────
// Testa o preenchimento automático das marcas de IDENTIFICAÇÃO por tipo de
// montagem (ver conversa que motivou): o operador só adiciona a marca de
// VALIDAÇÃO (verde/azul/vermelho — aprovado/2ª linha/reprovado), que entra
// sempre NA FRENTE da(s) marca(s) de identificação. A FORMA da marca de
// validação não é mais escolhida manualmente — é decidida sozinha conforme
// o tipo da placa (ver _formaDeStatusParaSlab).
//
// Regras finais (confirmadas na conversa):
//   - Tipos de forma COMBINADA (círculo+traço, ex: 3T/1T): só o traço
//     (identificação, corModificadora) nasce automático — o círculo é
//     sempre a marca de validação do operador.
//   - Tipos de forma ÚNICA (círculo só = 2P, traço só = SP): NÃO recebem
//     nada automático — uma marca só já identifica tipo E status ao
//     mesmo tempo, então não tem o que pré-preencher.
//   - Ainda em fase de teste da ideia: não há proteção contra apagar as
//     marcas automáticas — mas, como a paleta do operador só oferece
//     verde/azul/vermelho (nunca as cores usadas pelas identificações,
//     ex: amarelo/laranja), o gesto de apagar normal não CONSEGUE mais
//     construir a combinação certa pra alcançá-las na prática. Trocar o
//     Tipo de Montagem (que regenera a identificação do zero) é hoje o
//     jeito de corrigir uma identificação errada.
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

async function abrirComTipo(window, tipo) {
  window.SQ.startNew();
  await tick();
  window.SQ.iniciarAvaliacaoDaFila(OPERACAO_FILA.id);
  await tick();
  const sel = window.document.getElementById('sq-mountType');
  if (!sel.querySelector(`option[value="${tipo}"]`)) {
    sel.insertAdjacentHTML('beforeend', `<option value="${tipo}">${tipo}</option>`);
  }
  sel.value = tipo;
  window.SQ.changeMountType();
  await tick();
}

test('tipo de forma única (SP, "traço só") NÃO recebe preenchimento automático', async () => {
  const { window } = dom;
  await abrirComTipo(window, 'SP');

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  assert.equal(slab.querySelectorAll('.sq-mark-dash').length, 0, 'SP é forma única — uma marca só já identifica tipo+status, não tem o que pré-preencher');
  assert.equal(slab.querySelectorAll('.sq-mark-circle').length, 0);
});

test('tipo de forma única (2P, "círculo só") também NÃO recebe preenchimento automático', async () => {
  const { window } = dom;
  await abrirComTipo(window, '2P');

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  assert.equal(slab.querySelectorAll('.sq-mark-circle').length, 0);
  assert.equal(slab.querySelectorAll('.sq-mark-dash').length, 0);
});

test('tipo de forma combinada (3T, corModificadora amarelo) nasce só com o traço automático — círculo fica pro operador', async () => {
  const { window } = dom;
  await abrirComTipo(window, '3T');

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  assert.equal(slab.querySelectorAll('.sq-mark-dash').length, 1, '3T: o traço (identificação) já nasce automático');
  assert.equal(slab.querySelectorAll('.sq-mark-circle').length, 0, '3T: o círculo (validação) começa vazio — só o operador adiciona');
});

test('marca de validação do operador (tipo combinado) entra NA FRENTE da marca de identificação', async () => {
  const { window } = dom;
  await abrirComTipo(window, '3T');

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  // Só clica na cor — a forma (círculo, já que o traço está ocupado pela
  // identificação) é decidida sozinha por _formaDeStatusParaSlab.
  window.document.querySelector('.sq-btn-color.verde').click();
  slab.click();

  assert.equal(slab.querySelectorAll('.sq-mark-circle').length, 1, 'a validação do operador deveria ser um círculo (3T)');
  assert.equal(slab.querySelectorAll('.sq-mark-dash').length, 1, 'a identificação automática (traço) continua lá');

  // .sq-slab-marks renderiza na ordem do array — o 1º elemento do DOM é
  // o 1º da lista (a marca do operador, por causa do unshift em
  // toggleMark).
  const marksContainer = slab.querySelector('.sq-slab-marks');
  const circulo = slab.querySelector('.sq-mark-circle');
  assert.equal(marksContainer.children[0], circulo, 'a marca do operador (círculo) deveria ser a primeira renderizada (mais à frente)');
});

test('tipo de forma única (SP): o operador marca a única forma daquele tipo, com a cor de status', async () => {
  const { window } = dom;
  await abrirComTipo(window, 'SP');

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  window.document.querySelector('.sq-btn-color.vermelho').click();
  window.document.querySelector('.sq-btn-shape.dash').click();
  slab.click();

  assert.equal(slab.querySelectorAll('.sq-mark-dash').length, 1, 'SP usa traço — a própria marca de validação já é o traço, sem automática por baixo');
  assert.equal(slab.querySelectorAll('.sq-mark-circle').length, 0);
});

test('trocar o Tipo de Montagem entre dois tipos combinados atualiza a identificação, sem apagar a validação já dada', async () => {
  const { window } = dom;
  await abrirComTipo(window, '3T'); // corModificadora amarelo

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  window.document.querySelector('.sq-btn-color.vermelho').click();
  slab.click();
  await new Promise(r => setTimeout(r, 20));
  // vermelho exige motivo — escolhe o primeiro código pra não travar o teste
  const primeiroCodigo = window.document.querySelector('.sq-motivo-popover-item');
  if (primeiroCodigo) primeiroCodigo.click();

  assert.equal(slab.querySelectorAll('.sq-mark-circle').length, 1, 'pré-condição: círculo vermelho (validação do operador)');
  assert.equal(slab.querySelectorAll('.sq-mark-dash').length, 1, 'pré-condição: traço amarelo (identificação automática de 3T)');

  // Muda o tipo pra 1T (também combinado, mas corModificadora laranja) —
  // deveria trocar SÓ a identificação (o traço), preservando a marca de
  // validação (círculo vermelho) que o operador já tinha dado.
  const sel = window.document.getElementById('sq-mountType');
  if (!sel.querySelector('option[value="1T"]')) sel.insertAdjacentHTML('beforeend', '<option value="1T">1T</option>');
  sel.value = '1T';
  window.SQ.changeMountType();
  await tick();

  const slabDepois = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  assert.equal(slabDepois.querySelectorAll('.sq-mark-circle').length, 1, 'a marca de validação (círculo vermelho) do operador deveria ter sido preservada');
  assert.equal(slabDepois.querySelectorAll('.sq-mark-dash').length, 1, 'a identificação deveria continuar existindo (1 traço), só que trocada pra laranja (1T)');
});

test('varMap (renderMarks) mapeia "cinza" pra uma variável CSS própria, não cai no fallback verde', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const codigo = fs.readFileSync(path.join(__dirname, '..', 'public/js/setor-qualidade.js'), 'utf8');
  const ocorrencias = codigo.match(/const varMap = \{[^}]+\}/g) || [];
  assert.ok(ocorrencias.length >= 2, 'deveria haver pelo menos 2 varMap (grade principal + espelho/mini-mark)');
  ocorrencias.forEach(linha => {
    assert.ok(linha.includes("cinza:'--sq-cor-identificacao-auto'") || linha.includes('cinza:"--sq-cor-identificacao-auto"'), `varMap deveria mapear 'cinza' explicitamente: ${linha}`);
  });
});

test('marcar X continua exclusivo mesmo quando já existe uma marca de identificação automática', async () => {
  const { window } = dom;
  await abrirComTipo(window, '3T');

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  assert.equal(slab.querySelectorAll('.sq-mark-dash').length, 1);

  window.document.querySelector('.sq-btn-shape.x').click();
  slab.click();

  assert.equal(slab.querySelectorAll('.sq-mark-dash').length, 0, 'X deveria ter substituído a marca automática também');
  assert.equal(slab.querySelectorAll('.sq-mark-x').length, 1);
});

test('a classificação (validateAllSlabs) reconhece corretamente o tipo mesmo com a marca do operador na frente', async () => {
  const { window } = dom;
  await abrirComTipo(window, '3T');

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  window.document.querySelector('.sq-btn-color.verde').click();
  slab.click();

  assert.equal(slab.classList.contains('invalid'), false, 'a placa não deveria ser sinalizada como inconsistente com o tipo esperado (3T)');
});
