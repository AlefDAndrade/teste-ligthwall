// ─── test/setor-qualidade-indicador-generico.test.js ────────────────────────
// Testa o modelo GENÉRICO de combinacaoAvaliacao (ver conversa que motivou a
// reformulação: "marcas: [{shape,color}, ...], indicadorIndex" — o indicador
// de qualidade pode ser QUALQUER marca do painel, círculo OU traço, não
// mais sempre o círculo) — a ordem real das marcas na grade de avaliação
// (toggleMark/applyMarksToPallet, setor-qualidade.js) segue a posição de
// `indicadorIndex` dentro de `marcas`, e classifyMarks reconhece o tipo e o
// status corretamente independente de qual shape é o indicador.
//
// Mesmo harness de setor-qualidade-identificacao-automatica.test.js, com
// config.json real (via opcoes.configJson) pra ter controle total sobre
// combinacaoAvaliacao.

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick, OPERACAO_FILA } = require('./helpers/setor-qualidade-dom.js');

let dom;

function configComCombo(combinacaoAvaliacao) {
  return {
    tipos_montagem: {
      opcoes: [
        { label: '2/P', modo: 'simples', tipo: '2p', paineis_2p_por_berco: 2 },
        { label: 'S/P', modo: 'simples', tipo: 'sp', paineis_sp_por_berco: 2 },
        { label: '3T', modo: 'simples', tipo: '3t', paineis_3t_por_berco: 2, combinacaoAvaliacao },
      ],
    },
  };
}

beforeEach(() => { dom = null; });
after(() => { dom = null; });

async function abrirComTipo3T(window) {
  // SQ.init() (não SQ.startNew() sozinho) dispara _carregarOpcoesMontagem()
  // — só assim o config.json injetado via opcoes.configJson é lido de
  // verdade e popula o select com as opções reais (2P/SP/3T), com
  // combinacaoAvaliacao incluída.
  window.SQ.init();
  await tick(10);
  window.SQ.iniciarAvaliacaoDaFila(OPERACAO_FILA.id);
  await tick();
  const sel = window.document.getElementById('sq-mountType');
  sel.value = '3T';
  window.SQ.changeMountType();
  await tick();
}

test('indicador = círculo (posição 1, depois do traço): traço vem primeiro no DOM, indicador depois', async () => {
  dom = montarTela({
    configJson: configComCombo({
      marcas: [{ shape: 'dash', color: 'amarelo' }, { shape: 'circle', color: null }],
      indicadorIndex: 1,
    }),
  });
  const { window } = dom;
  await abrirComTipo3T(window);

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  window.document.querySelector('.sq-btn-color.verde').click();
  slab.click();

  const marksContainer = slab.querySelector('.sq-slab-marks');
  assert.equal(marksContainer.children[0].className, 'sq-mark-dash', 'traço (identidade) deveria vir primeiro no DOM');
  assert.equal(marksContainer.children[1].className, 'sq-mark-circle', 'círculo (indicador) deveria vir depois');
});

test('indicador = círculo (posição 0, antes do traço): indicador vem primeiro no DOM', async () => {
  dom = montarTela({
    configJson: configComCombo({
      marcas: [{ shape: 'circle', color: null }, { shape: 'dash', color: 'amarelo' }],
      indicadorIndex: 0,
    }),
  });
  const { window } = dom;
  await abrirComTipo3T(window);

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  window.document.querySelector('.sq-btn-color.verde').click();
  slab.click();

  const marksContainer = slab.querySelector('.sq-slab-marks');
  assert.equal(marksContainer.children[0].className, 'sq-mark-circle', 'círculo (indicador) deveria vir primeiro no DOM');
  assert.equal(marksContainer.children[1].className, 'sq-mark-dash', 'traço (identidade) deveria vir depois');
});

test('indicador = TRAÇO (não o círculo!): a marca de identidade fixa agora é o círculo, e o operador marca o traço', async () => {
  // Combinação onde o CÍRCULO é a identidade fixa (amarelo) e o TRAÇO é
  // o indicador de qualidade — inverso do que sempre foi hardcoded antes
  // desta mudança (círculo sempre indicador). Confirma que o sistema
  // agora aceita qualquer shape como indicador.
  dom = montarTela({
    configJson: configComCombo({
      marcas: [{ shape: 'circle', color: 'amarelo' }, { shape: 'dash', color: null }],
      indicadorIndex: 1,
    }),
  });
  const { window } = dom;
  await abrirComTipo3T(window);

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  // O operador marca a cor de status usando a forma "traço" (selectedShape
  // por padrão é 'circle' — precisa trocar pro traço primeiro).
  window.document.querySelector('.sq-btn-shape.dash').click();
  window.document.querySelector('.sq-btn-color.verde').click();
  slab.click();

  assert.equal(slab.querySelectorAll('.sq-mark-circle').length, 1, 'identidade fixa (círculo amarelo) deveria ter sido pré-preenchida sozinha');
  assert.equal(slab.querySelectorAll('.sq-mark-dash').length, 1, 'o traço (indicador, marcado pelo operador) deveria estar lá');

  const marksContainer = slab.querySelector('.sq-slab-marks');
  assert.equal(marksContainer.children[0].className, 'sq-mark-circle', 'identidade (círculo amarelo) primeiro, já que indicadorIndex=1 (depois)');
  assert.equal(marksContainer.children[1].className, 'sq-mark-dash', 'indicador (traço) depois');

  const erro = window.document.getElementById('sq-erro-validacao');
  if (erro) assert.equal(erro.style.display, 'none', 'a marca (traço verde) deveria ser reconhecida como 3T aprovado mesmo com o indicador sendo o traço');
});

test('posição "depois" também vale pra marcação em lote (palete inteiro)', async () => {
  dom = montarTela({
    configJson: configComCombo({
      marcas: [{ shape: 'dash', color: 'amarelo' }, { shape: 'circle', color: null }],
      indicadorIndex: 1,
    }),
  });
  const { window } = dom;
  await abrirComTipo3T(window);

  window.document.querySelector('.sq-btn-color.verde').click();
  window.SQ.selectAllPallet('stack1');
  await tick();

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  const marksContainer = slab.querySelector('.sq-slab-marks');
  assert.equal(marksContainer.children[0].className, 'sq-mark-dash', 'marcação em lote também deveria respeitar a posição — traço primeiro');
  assert.equal(marksContainer.children[1].className, 'sq-mark-circle');
});

test('formato ANTIGO (forma/corModificadora, sem marcas[]) continua funcionando via normalização automática', async () => {
  // Combinação salva por uma versão anterior desta funcionalidade —
  // _normalizarCombinacao (setor-qualidade.js) converte na leitura, sem
  // precisar migrar o config.json.
  dom = montarTela({
    configJson: configComCombo({ forma: 'circle+dash', corModificadora: 'amarelo', posicaoIndicador: 'antes' }),
  });
  const { window } = dom;
  await abrirComTipo3T(window);

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  window.document.querySelector('.sq-btn-color.verde').click();
  slab.click();

  const marksContainer = slab.querySelector('.sq-slab-marks');
  assert.equal(marksContainer.children[0].className, 'sq-mark-circle', 'formato antigo circle+dash "antes": círculo (indicador) primeiro, como sempre foi');
  assert.equal(marksContainer.children[1].className, 'sq-mark-dash');
});
