// ─── test/manutencao-trajetoria-cores.test.js ───────────────────────────────
// Testa o esquema de cores da trajetória visual (ver conversa que motivou
// isso): AMARELO enquanto o chamado está em andamento, VERDE quando a
// trajetória inteira está concluída (último passo, "Finalizado", já
// alcançado) — controlado pela classe .concluido no <ul>, adicionada por
// _renderizarTrajetoria (manutencao.js) e lida pelo CSS
// (.man-trajetoria-passos.concluido ...).
//
// Testa direto as funções puras (_construirPassosTrajetoria/
// _renderizarTrajetoria, expostas em window.MAN só pra isso) — avaliando
// manutencao.js isolado num JSDOM mínimo, sem precisar subir servidor
// nem a SPA inteira (são funções puras: chamado in, HTML string out).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const CODIGO = fs.readFileSync(path.join(__dirname, '..', 'public/js/manutencao.js'), 'utf8');

function montarJanela() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
  const { window } = dom;
  window.LW = {};
  window.eval(CODIGO);
  return window;
}

function chamadoBase(overrides = {}) {
  return {
    id: 'MAN-teste', observador: 'Fulano', dataCriacao: '2026-07-16T10:00:00.000Z',
    visualizadoPor: null, visualizadoEm: null,
    aceito: 'Nao', aceitoPor: null, aceitoEm: null,
    aguardandoPecas: 'Nao', pedidoPecaAceito: 'Nao', statusCompra: null,
    situacao: 'Aguardando', dataInicio: null, dataFim: null,
    etiquetaFechada: false, recusaResultado: null,
    ...overrides,
  };
}

test('chamado recém-aberto (nada feito ainda): trajetória NÃO tem a classe "concluido"', () => {
  const window = montarJanela();
  const passos = window.MAN._construirPassosTrajetoria(chamadoBase());
  const html = window.MAN._renderizarTrajetoria(passos);
  assert.doesNotMatch(html, /class="man-trajetoria-passos concluido"/, 'chamado em aberto não deveria estar marcado como concluído');
});

test('chamado EM ANDAMENTO (aceito, ainda não fechado): continua sem "concluido" (fica amarelo, via CSS)', () => {
  const window = montarJanela();
  const chamado = chamadoBase({
    aceito: 'Sim', aceitoPor: 'Fulano', aceitoEm: '2026-07-16T11:00:00.000Z',
    situacao: 'Em Manutencao', dataInicio: '2026-07-16',
  });
  const passos = window.MAN._construirPassosTrajetoria(chamado);
  const html = window.MAN._renderizarTrajetoria(passos);
  assert.doesNotMatch(html, /concluido/, 'chamado ainda em andamento (não fechado) não deveria virar verde');
});

test('chamado FINALIZADO (situacao Concluido + etiquetaFechada): trajetória ganha a classe "concluido" (vira verde)', () => {
  const window = montarJanela();
  const chamado = chamadoBase({
    aceito: 'Sim', aceitoPor: 'Fulano', aceitoEm: '2026-07-16T11:00:00.000Z',
    situacao: 'Concluido', dataInicio: '2026-07-16', dataFim: '2026-07-16',
    etiquetaFechada: true,
  });
  const passos = window.MAN._construirPassosTrajetoria(chamado);
  const html = window.MAN._renderizarTrajetoria(passos);
  assert.match(html, /class="man-trajetoria-passos concluido"/, 'chamado finalizado deveria estar marcado como concluído (fica verde)');
});

test('chamado RECUSADO e encerrado: NÃO ganha a classe "concluido" mesmo tendo chegado ao fim (continua vermelho, não verde)', () => {
  const window = montarJanela();
  const chamado = chamadoBase({
    recusaResultado: 'Aceita', recusaRevisadoPor: 'Supervisor', recusaRevisadoEm: '2026-07-16T12:00:00.000Z',
    recusaMotivo: 'Duplicado', etiquetaFechada: true, situacao: 'Recusado',
  });
  const passos = window.MAN._construirPassosTrajetoria(chamado);
  const html = window.MAN._renderizarTrajetoria(passos);
  assert.doesNotMatch(html, /class="man-trajetoria-passos concluido"/, 'recusa não deveria acionar a cor de "concluído" (verde) — o vermelho de recusado tem prioridade');
  assert.match(html, /class="man-trajetoria-passo recusado"/, 'deveria ter um passo marcado como recusado');
});
