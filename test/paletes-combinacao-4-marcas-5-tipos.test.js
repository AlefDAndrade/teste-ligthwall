// ─── test/paletes-combinacao-4-marcas-5-tipos.test.js ───────────────────────
// Reprodução do cenário relatado: 5 tipos de montagem simples cadastrados,
// e uma combinação NOVA de 4 marcas definida (via Configurações → Paletes →
// "Combinações de Avaliação") pra um deles — depois de salvar e recarregar
// a página, marcar a placa com essa combinação não pode deixar o painel
// vermelho (inválido).
//
// O formato salvo por pcaSalvarCombinacao (paletes-combinacoes.js) NÃO zera
// a cor do indicador (fica com a última cor selecionada ao montar o painel
// em Configurações, ex: 'verde') — diferente de COMBINACOES_PADRAO, que usa
// color:null pro indicador. Este teste usa esse formato REAL (confirmado em
// test/paletes-combinacoes.test.js, linha ~193: combinacaoAvaliacao.marcas
// do indicador vem com color:'verde', não null) — não o formato idealizado.

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick, OPERACAO_FILA } = require('./helpers/setor-qualidade-dom.js');

let dom;
beforeEach(() => { dom = null; });
after(() => { dom = null; });

// 5 tipos cadastrados: 4 legados (2P/SP/3T/1T) sem combinação própria — devem
// continuar caindo no padrão fixo — e um 5º tipo NOVO ("5T") com uma
// combinação de 4 marcas, no formato REAL salvo pelo editor visual (o
// indicador guarda a última cor escolhida ao montar, não null).
const CONFIG_5_TIPOS = {
  tipos_montagem: {
    opcoes: [
      { label: '2/P', modo: 'simples', tipo: '2p', paineis_2p_por_berco: 2 },
      { label: 'S/P', modo: 'simples', tipo: 'sp', paineis_sp_por_berco: 2 },
      { label: '3T', modo: 'simples', tipo: '3t', paineis_3t_por_berco: 2 },
      { label: '1T', modo: 'simples', tipo: '1t', paineis_1t_por_berco: 2 },
      {
        label: '5T', modo: 'simples', tipo: '5t', paineis_5t_por_berco: 2,
        combinacaoAvaliacao: {
          marcas: [
            { shape: 'circle', color: 'amarelo' }, // identidade 1
            { shape: 'circle', color: 'laranja' },  // identidade 2
            { shape: 'dash',   color: 'azul' },     // identidade 3
            { shape: 'dash',   color: 'verde' },    // indicador (índice 3) — cor real salva pelo editor, não null
          ],
          indicadorIndex: 3,
        },
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

test('tipo NOVO (5T) com combinação de 4 marcas: identidade auto-preenchida + indicador manual não fica vermelho', async () => {
  dom = montarTela({ configJson: CONFIG_5_TIPOS });
  const { window } = dom;
  await abrirComTipo(window, '5T');

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  assert.ok(slab, 'placa stack1-1 deveria existir com tipo 5T selecionado');

  // As 3 marcas de identidade (2 círculos + 1 traço) deveriam ter sido
  // pré-preenchidas automaticamente ao entrar na tela.
  const marksAntes = slab.querySelectorAll('.sq-slab-marks > *');
  assert.equal(marksAntes.length, 3, 'as 3 marcas de identidade deveriam ter sido pré-preenchidas automaticamente');

  // Operador marca o indicador: forma TRAÇO (dash), cor verde (aprovado).
  window.document.querySelector('.sq-btn-shape.dash').click();
  window.document.querySelector('.sq-btn-color.verde').click();
  slab.click();
  await tick();

  assert.equal(
    slab.classList.contains('invalid'), false,
    'placa 5T marcada com a combinação NOVA (4 marcas) definida em Configurações não deveria ficar vermelha/inválida'
  );
  assert.equal(window.document.querySelectorAll('.sq-slab.invalid').length, 0);
});

test('registrar avaliação: painel com só as marcas automáticas (sem indicador do operador) continua contando como "faltando", não deixa passar batido', async () => {
  dom = montarTela({ configJson: CONFIG_5_TIPOS });
  const { window } = dom;
  await abrirComTipo(window, '5T');

  // Marca só o indicador da 1ª placa — todas as outras do tipo 5T ficam só
  // com as 3 marcas de identidade automáticas (nenhuma marcação de verdade
  // do operador ainda).
  const slab1 = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  window.document.querySelector('.sq-btn-shape.dash').click();
  window.document.querySelector('.sq-btn-color.verde').click();
  slab1.click();
  await tick();

  window.SQ.registerEvaluation();
  await tick(10);

  // stack1-1 está completa (identidade + indicador) — não deveria ser
  // destacada como faltando.
  assert.equal(slab1.classList.contains('invalid'), false, 'placa já avaliada de verdade não deveria ser destacada como faltando');

  // Alguma outra placa do mesmo tipo, só com as marcas automáticas, DEVE
  // continuar sendo tratada como pendente (destacada), impedindo o
  // registro de passar batido com painéis nunca olhados pelo operador.
  const outraSlab = window.document.querySelector('.sq-slab[data-id="stack1-2"]');
  assert.ok(outraSlab, 'stack1-2 deveria existir');
  assert.equal(outraSlab.classList.contains('invalid'), true, 'placa só com marcas automáticas (sem indicador do operador) deveria continuar sendo cobrada como pendente no registro');
});
test('tipos legados (2P/SP/3T/1T), ainda sem combinação própria, continuam funcionando com o padrão de sempre', async () => {
  dom = montarTela({ configJson: CONFIG_5_TIPOS });
  const { window } = dom;
  await abrirComTipo(window, '2P');

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  window.document.querySelector('.sq-btn-shape.circle').click();
  window.document.querySelector('.sq-btn-color.verde').click();
  slab.click();
  await tick();

  assert.equal(
    slab.classList.contains('invalid'), false,
    'tipo 2P (sem combinação própria) deveria continuar validando pelo padrão fixo, mesmo com outro tipo (5T) já configurado'
  );
});

test('reprovado (vermelho no INDICADOR, marcado pelo operador) é uma classificação válida, não um "inválido" — não deve ganhar a borda vermelha de tipo incompatível', async () => {
  dom = montarTela({ configJson: CONFIG_5_TIPOS });
  const { window } = dom;
  await abrirComTipo(window, '5T');

  const slab = window.document.querySelector('.sq-slab[data-id="stack1-1"]');
  window.document.querySelector('.sq-btn-shape.dash').click();
  window.document.querySelector('.sq-btn-color.vermelho').click();
  slab.click();
  await tick();

  // Reprovado é um resultado normal de negócio (classifyMarks -> "5T
  // reprovado"), não deveria acionar a borda vermelha de INCONSISTÊNCIA de
  // tipo (.invalid) — essa é só pra quando a marcação não bate com NENHUMA
  // combinação cadastrada pro tipo esperado.
  assert.equal(
    slab.classList.contains('invalid'), false,
    '5T reprovado (marcação de status normal) não deveria acionar a borda vermelha de tipo incompatível'
  );
});
