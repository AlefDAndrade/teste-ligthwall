// ─── test/setor-qualidade-fila-horario.test.js ──────────────────────────────
// Testa a hora/data exibida nos cartões da fila ("Ordem de Previsão de
// Desemplaque") — bug: _filaData/_filaHora usavam toLocaleDateString/
// toLocaleTimeString, que aplicam o FUSO HORÁRIO DO NAVEGADOR por cima.
// Neste sistema, op.data/op.fim já são a hora de parede (Brasília)
// "disfarçada" de UTC (mesma convenção usada em fmtDTL e em toda leitura de
// datetime-local do arquivo — ver comentário em _prefillFromOperacao) — ler
// esses valores com toLocaleDateString/toLocaleTimeString deslocava o
// horário exibido na fila pelo fuso configurado no navegador/dispositivo,
// mesmo a hora certa já estando ali dentro do próprio valor (ver
// _filaData/_filaHora, setor-qualidade.js).
//
// process.env.TZ É AJUSTADO DE PROPÓSITO logo abaixo, ANTES de qualquer uso
// de Date/Intl — pra reproduzir o bug de verdade é preciso rodar num fuso
// diferente de UTC (o ambiente de CI/contêiner roda em UTC por padrão, onde
// o bug fica mascarado — toLocaleTimeString e toISOString coincidem só
// porque o fuso local "por acaso" é UTC também).

process.env.TZ = 'America/Sao_Paulo';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick } = require('./helpers/setor-qualidade-dom.js');

let dom;

beforeEach(() => {
  dom = montarTela({
    operacoesFila: [{
      id: 'op-horario',
      id_bateria: 'B4',
      turno: '1° TURNO',
      tipo_montagem: 'SP',
      data: '2026-07-01',
      // 14:30 "de parede" (Brasília), guardado com sufixo Z por convenção
      // do sistema — ver comentário de topo.
      fim: '2026-07-01T14:30:00.000Z',
      dimensao: 9,
      bercos_reais: 20,
      capacidade: 20,
    }],
  });
});

after(() => {
  dom = null;
});

test('o horário mostrado no cartão da fila é a hora de parede do valor, não deslocado pelo fuso do ambiente', async () => {
  const { window } = dom;
  window.SQ.startNew();
  await tick();

  const textoCard = window.document.querySelector('.sq-fila-item-principal .sq-fila-item-info span:not(:first-child)').textContent;
  assert.ok(textoCard.includes('14:30'), `esperava "14:30" no cartão, veio: "${textoCard}"`);
  assert.ok(!textoCard.includes('11:30'), 'não deveria mostrar a hora deslocada pelo fuso (America/Sao_Paulo = UTC-3)');
});

test('a data mostrada no cartão da fila também usa a data de parede, não deslocada pelo fuso', async () => {
  const { window } = dom;
  window.SQ.startNew();
  await tick();

  const textoCard = window.document.querySelector('.sq-fila-item-principal .sq-fila-item-info span:not(:first-child)').textContent;
  assert.ok(textoCard.includes('01/07'), `esperava a data "01/07" no cartão, veio: "${textoCard}"`);
});
