// ─── test/setor-qualidade-indicador-toggle.test.js ──────────────────────────
// Testa o botão "I" (toggleIndicadorAtivo, setor-qualidade.js) — ver
// conversa que motivou: a classificação antiga reconstruía por eliminação
// quem era "identidade" e quem era "indicador" comparando o CONJUNTO
// inteiro de marcas contra a combinação cadastrada, o que ficava frágil
// com combinações de 3+ marcas (só 2 formas disponíveis, cor sobrando
// vira ambíguo). Agora cada marca já nasce sabendo o próprio papel
// (`role`), gravado na hora do clique — o botão "I" decide qual papel.
//
// Mesmo harness de setor-qualidade-motivo-obrigatorio.test.js /
// setor-qualidade-indicador-generico.test.js — ver
// test/helpers/setor-qualidade-dom.js.

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick, OPERACAO_FILA } = require('./helpers/setor-qualidade-dom.js');

let dom;
beforeEach(() => { dom = null; });
after(() => { dom = null; });

// 3T com 3 marcas: 2 de identidade (círculo amarelo, traço laranja) + 1
// indicador (círculo, índice 2) — mesmo tipo de cenário relatado pelo
// usuário (tipo PADRÃO, combinação com 3+ marcas), só que agora
// resolvido por `role`, não mais por comparação de conjunto.
const CONFIG_3T_3_MARCAS = {
  tipos_montagem: {
    opcoes: [
      { label: '2/P', modo: 'simples', tipo: '2p', paineis_2p_por_berco: 2 },
      { label: 'S/P', modo: 'simples', tipo: 'sp', paineis_sp_por_berco: 2 },
      {
        label: '3T', modo: 'simples', tipo: '3t', paineis_3t_por_berco: 2,
        combinacaoAvaliacao: {
          marcas: [
            { shape: 'circle', color: 'amarelo' },
            { shape: 'dash',   color: 'laranja' },
            { shape: 'circle', color: 'verde' }, // indicador — cor "sobrando" do editor, não usada na classificação
          ],
          indicadorIndex: 2,
        },
      },
      { label: '1T', modo: 'simples', tipo: '1t', paineis_1t_por_berco: 2 },
    ],
  },
};

async function abrirComTipo3T(window) {
  window.SQ.init();
  await tick(10);
  window.SQ.iniciarAvaliacaoDaFila(OPERACAO_FILA.id);
  await tick();
  const sel = window.document.getElementById('sq-mountType');
  sel.value = '3T';
  window.SQ.changeMountType();
  await tick();
}

test('o botão "I" nasce ATIVADO na tela de avaliação', async () => {
  dom = montarTela();
  const { window } = dom;
  window.SQ.startNew();
  await tick();
  const btn = window.document.querySelector('.sq-btn-indicador');
  assert.ok(btn, 'botão "I" deveria existir na tela');
  assert.ok(btn.classList.contains('active'), 'botão "I" deveria nascer ativado');
});

test('3T com 3 marcas: marcar o indicador (com "I" ativado, padrão) classifica certo e não fica vermelho', async () => {
  dom = montarTela({ configJson: CONFIG_3T_3_MARCAS });
  const { window } = dom;
  await abrirComTipo3T(window);

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  const marksAntes = slab.querySelectorAll('.sq-slab-marks > *');
  assert.equal(marksAntes.length, 2, 'as 2 marcas de identidade deveriam ter sido pré-preenchidas automaticamente');

  window.document.querySelector('.sq-btn-shape.circle').click();
  window.document.querySelector('.sq-btn-color.verde').click();
  slab.click();
  await tick();

  assert.ok(!slab.classList.contains('invalid'), 'placa não deveria ficar vermelha ao marcar o indicador');
});

test('desativar o "I" faz a marca nascer com role "identidade" (não conta como avaliação de status)', async () => {
  dom = montarTela({ configJson: CONFIG_3T_3_MARCAS });
  const { window } = dom;
  await abrirComTipo3T(window);

  // Desativa o "I" antes de clicar.
  const btnI = window.document.querySelector('.sq-btn-indicador');
  btnI.click();
  assert.ok(!btnI.classList.contains('active'), 'botão "I" deveria estar desativado após o clique');

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  window.document.querySelector('.sq-btn-color.vermelho').click(); // cor que normalmente exige motivo
  slab.click();
  await tick();

  // Mesmo marcando vermelho, como é uma marca de IDENTIDADE (não
  // indicador), não deveria abrir o seletor de motivo.
  assert.equal(window.document.querySelector('.sq-motivo-popover'), null, 'marca de identidade não deveria exigir motivo, mesmo sendo vermelha');

  // Reativa o "I" — clique de novo no botão.
  btnI.click();
  assert.ok(btnI.classList.contains('active'), 'botão "I" deveria voltar a ficar ativado');
});

test('marcar o indicador de vermelho (com "I" ativado) continua exigindo motivo normalmente', async () => {
  dom = montarTela({ configJson: CONFIG_3T_3_MARCAS });
  const { window } = dom;
  await abrirComTipo3T(window);

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  window.document.querySelector('.sq-btn-shape.circle').click();
  window.document.querySelector('.sq-btn-color.vermelho').click();
  slab.click();
  await tick();

  assert.ok(window.document.querySelector('.sq-motivo-popover'), 'marca de indicador vermelha deveria continuar exigindo motivo');
});

test('2 cliques de indicador com cores DIFERENTES na mesma placa vira "Múltiplas" (ambíguo), não trava silenciosamente', async () => {
  dom = montarTela({ configJson: CONFIG_3T_3_MARCAS });
  const { window } = dom;
  await abrirComTipo3T(window);

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  window.document.querySelector('.sq-btn-shape.circle').click();
  window.document.querySelector('.sq-btn-color.verde').click();
  slab.click();
  await tick();
  window.document.querySelector('.sq-btn-color.azul').click();
  slab.click();
  await tick();

  assert.ok(slab.classList.contains('invalid'), 'duas cores de indicador diferentes na mesma placa deveriam ficar inválidas (ambíguo)');
});
