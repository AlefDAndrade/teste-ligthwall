// ─── test/setor-qualidade-registro-tipo-montagem.test.js ────────────────────
// Testa 2 correções relacionadas (ver conversa que motivou isso): a tela
// "Registros" (renderHistory) só mostrava um traço "—" pra qualquer tipo de
// montagem além de 2P/SP, porque o valor salvo em avaliacao.montagem.palletN
// vinha só de palletTypes[idx] (preset uniforme do dropdown principal) — que
// fica vazio sempre que o modo "Personalizada" é usado, mesmo quando as
// placas TÊM um tipo de verdade.
//
// 1. _montagemDoRegistro (exposta como SQ.calcularMontagemDoRegistro) agora
//    calcula a partir do tipoEsperado de CADA painel — funciona pra
//    qualquer tipo cadastrado, e junta tipos DIFERENTES no mesmo palete
//    com "/" (ex: "3T/5T").
// 2. O modal "Personalizada" só tinha 4 botões de tipo hardcoded (SP/2P/
//    3T/1T) — qualquer tipo cadastrado além desses simplesmente não
//    aparecia pra ser escolhido. Agora os botões são gerados
//    dinamicamente a partir de tipos_montagem.opcoes (mesma fonte que o
//    dropdown principal já usa).

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick, OPERACAO_FILA } = require('./helpers/setor-qualidade-dom.js');

let dom;

beforeEach(() => { dom = null; });
after(() => { dom = null; });

test('calcularMontagemDoRegistro: palete com 1 tipo só devolve esse tipo', () => {
  dom = montarTela();
  const { window } = dom;
  const paineis = [
    { pallet: 1, tipoEsperado: 'SP' },
    { pallet: 1, tipoEsperado: 'SP' },
    { pallet: 2, tipoEsperado: '2P' },
  ];
  const montagem = window.SQ.calcularMontagemDoRegistro(paineis);
  assert.equal(montagem.pallet1, 'SP');
  assert.equal(montagem.pallet2, '2P');
  assert.equal(montagem.pallet3, '');
  assert.equal(montagem.pallet4, '');
});

test('calcularMontagemDoRegistro: palete com tipos DIFERENTES junta com "/" (ex: 3T/5T)', () => {
  dom = montarTela();
  const { window } = dom;
  const paineis = [
    { pallet: 1, tipoEsperado: '3T' },
    { pallet: 1, tipoEsperado: '3T' },
    { pallet: 1, tipoEsperado: '5T' },
    { pallet: 1, tipoEsperado: '5T' },
  ];
  const montagem = window.SQ.calcularMontagemDoRegistro(paineis);
  assert.equal(montagem.pallet1, '3T/5T', 'tipos diferentes no mesmo palete deveriam aparecer lado a lado, separados por "/"');
});

test('calcularMontagemDoRegistro: não duplica o mesmo tipo repetido no mesmo palete', () => {
  dom = montarTela();
  const { window } = dom;
  const paineis = [
    { pallet: 3, tipoEsperado: '1T' },
    { pallet: 3, tipoEsperado: '1T' },
    { pallet: 3, tipoEsperado: '1T' },
  ];
  const montagem = window.SQ.calcularMontagemDoRegistro(paineis);
  assert.equal(montagem.pallet3, '1T');
});

test('calcularMontagemDoRegistro: painéis sem tipoEsperado (não preenchidos) não geram lixo no resultado', () => {
  dom = montarTela();
  const { window } = dom;
  const paineis = [
    { pallet: 4, tipoEsperado: '' },
    { pallet: 4, tipoEsperado: null },
    { pallet: 4, tipoEsperado: 'SP' },
  ];
  const montagem = window.SQ.calcularMontagemDoRegistro(paineis);
  assert.equal(montagem.pallet4, 'SP');
});

test('modal "Personalizada" mostra um botão pra QUALQUER tipo simples cadastrado, não só SP/2P/3T/1T', async () => {
  dom = montarTela({
    configJson: {
      tipos_montagem: {
        opcoes: [
          { label: 'S/P', modo: 'simples', tipo: 'sp', paineis_sp_por_berco: 2 },
          { label: '2/P', modo: 'simples', tipo: '2p', paineis_2p_por_berco: 2 },
          { label: '3T', modo: 'simples', tipo: '3t', paineis_3t_por_berco: 2 },
          { label: '5T (tipo novo, cadastrado depois)', modo: 'simples', tipo: '5t', paineis_5t_por_berco: 2 },
        ],
      },
    },
  });
  const { window } = dom;
  window.SQ.init();
  await tick(10);
  window.SQ.iniciarAvaliacaoDaFila(OPERACAO_FILA.id);
  await tick();

  window.SQ.openPalletModal();
  await tick();

  const botoes = [...window.document.querySelectorAll('#sq-modal-tipos-botoes .sq-btn-tipo')].map(b => b.dataset.tipo);
  assert.ok(botoes.includes('5T'), `o tipo novo "5T" deveria ter um botão no modal Personalizada — botões encontrados: ${botoes.join(', ')}`);
  assert.ok(botoes.includes('SP') && botoes.includes('2P') && botoes.includes('3T'), 'os tipos de sempre continuam disponíveis');
});

test('clicar num tipo dinâmico ("5T") no modal Personalizada e numa placa aplica esse tipo à placa (getExpectedType)', async () => {
  dom = montarTela({
    configJson: {
      tipos_montagem: {
        opcoes: [
          { label: 'S/P', modo: 'simples', tipo: 'sp', paineis_sp_por_berco: 2 },
          { label: '5T', modo: 'simples', tipo: '5t', paineis_5t_por_berco: 2 },
        ],
      },
    },
  });
  const { window } = dom;
  window.SQ.init();
  await tick(10);
  window.SQ.iniciarAvaliacaoDaFila(OPERACAO_FILA.id);
  await tick();

  window.SQ.openPalletModal();
  await tick();
  window.SQ.setModalTipo('5T');
  const slab = window.document.querySelector('.sq-modal-slab[data-id="stack1-1"]');
  assert.ok(slab, 'deveria existir a placa 1 do pallet 1 no modal');
  slab.click();
  window.SQ.confirmPalletModal();
  await tick();

  // O tipo "5T" (dinâmico, fora dos 4 hardcoded de antes) deveria ter sido
  // aplicado de verdade à placa — mesmo raciocínio que alimenta
  // calcularMontagemDoRegistro na hora de registrar.
  assert.equal(window.SQ.getExpectedType('stack1-1'), '5T', 'a placa deveria ter ficado marcada com o tipo dinâmico "5T" depois de confirmar o modal Personalizada');
});
