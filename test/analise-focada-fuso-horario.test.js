// ─── test/analise-focada-fuso-horario.test.js ───────────────────────────────
// Testa um bug real relatado pelo usuário: na Análise Focada, uma operação
// feita às 14h aparecia como feita às 11h — exatos os 3h do fuso de
// Brasília, deslocados em dobro.
//
// Causa: op.inicio/op.fim (de uma Operação) são gravados via
// nowBrasilia().toISOString() (data.js) — que guarda no valor UTC do Date
// o horário JÁ AJUSTADO pra representar Brasília (não é um instante UTC de
// verdade; ver comentário de nowBrasilia()). Por isso, formatar esse valor
// com toLocaleTimeString SEM timeZone:'UTC' aplica a conversão de fuso REAL
// em cima de um valor que já É a hora certa, deslocando-o de novo (bug).
// Todo o resto do app que mostra esses mesmos campos (dashboard.js "Hora
// Início"/"Hora Fim", por exemplo) já usa timeZone:'UTC' corretamente —
// só a Análise Focada (_fmtHora, analise-focada.js) tinha ficado de fora.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const CODIGO_FOCADA = fs.readFileSync(path.join(__dirname, '..', 'public/js/analise-focada.js'), 'utf8');

function montarJanela() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
  const { window } = dom;
  window.LW = {}; // stub mínimo — _fmtHora não depende de LW
  window.eval(CODIGO_FOCADA);
  return window;
}

test('_fmtHora mostra o horário de Brasília certo a partir de op.inicio/op.fim (convenção nowBrasilia)', () => {
  const window = montarJanela();
  // "2026-07-16T14:00:00.000Z" É a string que nowBrasilia().toISOString()
  // produz quando o momento real, em Brasília, é 14:00 — o "Z" aqui NÃO
  // significa UTC de verdade (ver comentário de nowBrasilia(), data.js).
  const resultado = window.LWFocada.fmtHora('2026-07-16T14:00:00.000Z');
  assert.equal(resultado, '14:00', `esperava "14:00" (o horário real de Brasília), veio "${resultado}" — sinal do bug relatado (deslocamento de 3h)`);
});

test('_fmtHora não deveria mostrar 3h a menos (o bug relatado: 14h virava 11h)', () => {
  const window = montarJanela();
  const resultado = window.LWFocada.fmtHora('2026-07-16T14:00:00.000Z');
  assert.notEqual(resultado, '11:00', 'o bug relatado fazia 14h aparecer como 11h — não deveria mais acontecer');
});

test('_fmtHora continua tratando valor ausente/inválido como antes ("—")', () => {
  const window = montarJanela();
  assert.equal(window.LWFocada.fmtHora(null), '—');
  assert.equal(window.LWFocada.fmtHora(''), '—');
  assert.equal(window.LWFocada.fmtHora('not-a-date'), '—');
});

test('_fmtHora em outro horário (23:45) também bate certo, sem "virar o dia" por engano', () => {
  const window = montarJanela();
  const resultado = window.LWFocada.fmtHora('2026-07-16T23:45:00.000Z');
  assert.equal(resultado, '23:45');
});
