// ─── test/paletes-combinacao-isolada-por-tipo.test.js ───────────────────────
// Regressão: "quando eu definir a combinação de avaliação de um tipo em
// Configurações, o sistema deve aceitar ela como a válida pra ESSE tipo (a
// antiga deixa de valer só pra ele) — sem deixar o painel de OUTRO tipo,
// ainda sem combinação própria definida, virar vermelho (inválido)."
//
// Bug corrigido em _combinacoesEfetivas() (public/js/setor-qualidade.js):
// a função era tudo-ou-nada pro array inteiro de combinações — assim que
// QUALQUER tipo simples ganhava combinacaoAvaliacao própria, TODOS os
// outros tipos (ainda sem combinação própria) perdiam o fallback
// COMBINACOES_PADRAO de uma vez, mesmo sem ter sido tocados. Resultado: o
// painel do tipo não-configurado deixava de bater com qualquer combinação
// reconhecida (virava "Outros") e ficava marcado como inválido (vermelho),
// mesmo marcado do jeito de sempre.
//
// Mesmo harness de test/setor-qualidade-indicador-generico.test.js
// (config.json real via opcoes.configJson, pra controlar combinacaoAvaliacao
// tipo a tipo).

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick, OPERACAO_FILA } = require('./helpers/setor-qualidade-dom.js');

let dom;

beforeEach(() => { dom = null; });
after(() => { dom = null; });

// 2P fica SEM combinacaoAvaliacao própria (deveria continuar caindo no
// padrão fixo, COMBINACOES_PADRAO: círculo verde = aprovado) — só 3T ganha
// uma combinação nova, recém-definida em Configurações.
const CONFIG_3T_CONFIGURADO = {
  tipos_montagem: {
    opcoes: [
      { label: '2/P', modo: 'simples', tipo: '2p', paineis_2p_por_berco: 2 },
      { label: 'S/P', modo: 'simples', tipo: 'sp', paineis_sp_por_berco: 2 },
      {
        label: '3T', modo: 'simples', tipo: '3t', paineis_3t_por_berco: 2,
        combinacaoAvaliacao: { marcas: [{ shape: 'circle', color: null }, { shape: 'dash', color: 'laranja' }], indicadorIndex: 0 },
      },
    ],
  },
};

async function abrirComTipo(window, tipo) {
  window.SQ.init();
  await tick(10);
  window.SQ.iniciarAvaliacaoDaFila(OPERACAO_FILA.id);
  await tick();
  const sel = window.document.getElementById('sq-mountType');
  sel.value = tipo;
  window.SQ.changeMountType();
  await tick();
}

test('definir combinação nova de 3T não invalida o painel de 2P, que continua sem combinação própria (padrão)', async () => {
  dom = montarTela({ configJson: CONFIG_3T_CONFIGURADO });
  const { window } = dom;
  await abrirComTipo(window, '2P');

  // 2P nunca teve combinacaoAvaliacao própria definida — continua no
  // padrão de sempre: 1 círculo verde = aprovado.
  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  assert.ok(slab, 'placa stack1-1 deveria existir com tipo 2P selecionado');
  window.document.querySelector('.sq-btn-color.verde').click();
  slab.click();
  await tick();

  assert.equal(
    slab.classList.contains('invalid'), false,
    'placa 2P marcada com círculo verde (padrão) não deveria ficar vermelha/inválida só porque 3T ganhou combinação própria'
  );
  assert.equal(
    window.document.querySelectorAll('.sq-slab.invalid').length, 0,
    'nenhuma placa deveria estar marcada como inválida nesse cenário'
  );
});

test('a combinação nova de 3T é a única válida pra 3T — marcas do padrão antigo (círculo+traço amarelo) não batem mais', async () => {
  dom = montarTela({ configJson: CONFIG_3T_CONFIGURADO });
  const { window } = dom;
  await abrirComTipo(window, '3T');

  // Marca a combinação NOVA definida em config (círculo verde = indicador,
  // traço laranja = identidade fixa) — deve ser aceita como válida.
  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  window.document.querySelector('.sq-btn-color.verde').click();
  slab.click();
  await tick();

  assert.equal(
    slab.classList.contains('invalid'), false,
    'placa marcada com a combinação NOVA definida em Configurações deveria ser aceita como válida (não vermelha)'
  );

  const marksContainer = slab.querySelector('.sq-slab-marks');
  assert.equal(marksContainer.querySelectorAll('.sq-mark-dash').length, 1, 'identidade fixa (traço laranja) deveria ter sido pré-preenchida automaticamente');
});