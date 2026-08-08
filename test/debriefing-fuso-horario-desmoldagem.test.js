// ─── test/debriefing-fuso-horario-desmoldagem.test.js ───────────────────────
// Testa a correção de um bug real, encontrado analisando um backup do
// usuário: no popover de Debriefing (public/js/debriefing.js), avaliações
// desmoldadas à NOITE em Brasília — mas que em UTC já viram madrugada do
// dia SEGUINTE — eram contadas no dia ERRADO (o dia seguinte), enquanto o
// Espelho/Dashboard de Avaliação (setor-qualidade.js) contava certo.
//
// Caso real (dia 08/07/2026, mesma data no filtro dos dois lugares):
//   Espelho:     TOTAL REGISTROS: 2   PAINÉIS AVALIADOS: 80
//   Debriefing:  TOTAL DE REGISTROS: 1   PAINÉIS AVALIADOS: 40
//
// Causa: dataDoISO() extraía o dia direto dos dígitos UTC do timestamp
// (timeZone:'UTC'), copiando a convenção de horaBrasilia() — que é CERTA
// pra historico.inicio/fim (aba Operação, gravados "disfarçados" de UTC,
// sem conversão real) mas ERRADA pra dtDesmoldagem/registeredAt (aba
// Avaliação), que são UTC de verdade: registeredAt é literalmente
// `new Date().toISOString()`, e dtDesmoldagem passa por
// `new Date(val).toISOString()` (toISO(), setor-qualidade.js) — ambos com
// conversão real de fuso. Uma avaliação desmoldada às 21:06 de Brasília
// (dia 08) vira 00:06 UTC do dia 09 — dataDoISO() com timeZone:'UTC' jogava
// essa avaliação pro dia 09; o Espelho, que compara por INTERVALO de tempo
// real (não por string de data), não erra.
//
// dataDoISO() é função PRIVADA dentro da IIFE de debriefing.js (não exposta
// em window.LWDebriefing) — mesmo raciocínio de
// test/debriefing-valor-final.test.js: replica a MESMA lógica da função
// corrigida (copiada literalmente) e testa isolada. Mudança na função real
// precisa vir acompanhada da mesma mudança aqui.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Cópia literal de dataDoISO() em public/js/debriefing.js — MANTER EM
// SINCRONIA se a função de lá mudar.
function dataDoISO(isoString) {
  if (!isoString) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(isoString));
  } catch (_) { return null; }
}

test('avaliação desmoldada de madrugada em Brasília, mas ainda no MESMO dia em UTC — continua no dia certo', () => {
  // 00:10 UTC = 21:10 Brasília do dia ANTERIOR, mas 03:10 UTC = 00:10
  // Brasília do MESMO dia UTC. Caso real do backup: bateria B1,
  // dtDesmoldagem 2026-07-08T03:10:00.000Z → 00:10 Brasília, dia 08/07.
  assert.equal(dataDoISO('2026-07-08T03:10:00.000Z'), '2026-07-08');
});

test('BUG REAL: avaliação desmoldada à noite em Brasília (dia D), mas já madrugada do dia D+1 em UTC — conta no dia D (Brasília), não D+1 (UTC)', () => {
  // Caso real do backup: bateria B9, dtDesmoldagem
  // 2026-07-09T00:06:00.000Z → 21:06 Brasília do dia 08/07 (dia ANTERIOR
  // ao UTC). Antes da correção, dataDoISO() com timeZone:'UTC' devolvia
  // '2026-07-09' (errado) — a avaliação sumia do dia 08 no Debriefing,
  // mesmo aparecendo certo no Espelho/Dashboard.
  assert.equal(dataDoISO('2026-07-09T00:06:00.000Z'), '2026-07-08');
});

test('meia-noite exata em Brasília (03:00 UTC) já conta no dia novo', () => {
  assert.equal(dataDoISO('2026-07-08T03:00:00.000Z'), '2026-07-08');
  // 1 segundo antes da meia-noite de Brasília ainda é o dia anterior.
  assert.equal(dataDoISO('2026-07-08T02:59:59.000Z'), '2026-07-07');
});

test('registeredAt (sem dtDesmoldagem) segue a mesma conversão', () => {
  assert.equal(dataDoISO('2026-07-09T00:06:00.000Z'), '2026-07-08');
});

test('timestamp vazio/nulo devolve null', () => {
  assert.equal(dataDoISO(null), null);
  assert.equal(dataDoISO(''), null);
  assert.equal(dataDoISO(undefined), null);
});

test('ISO inválida devolve null, não lança exceção', () => {
  assert.equal(dataDoISO('nao-e-uma-data'), null);
});

test('calcularEstatisticasAvaliacao (via dataDoISO corrigida) conta os 2 registros reais do dia 08/07 — cenário exato do backup do usuário', () => {
  // Reproduz calcularEstatisticasAvaliacao() de debriefing.js com os dois
  // registros reais do backup (bateria B1 e B9), mesmo formato mínimo.
  function calcularEstatisticasAvaliacao(avaliacoes, data) {
    const doDia = avaliacoes.filter(a =>
      !a.excluidaDaFila && dataDoISO(a.dtDesmoldagem || a.registeredAt) === data
    );
    const paineis = doDia.flatMap(a => Array.isArray(a.paineis) ? a.paineis : []);
    return { totalRegistros: doDia.length, paineisAvaliados: paineis.length };
  }

  const avaliacoesDoBackup = [
    { id: 'ev_1786155038447', batteryId: 'B1', dtDesmoldagem: '2026-07-08T03:10:00.000Z', paineis: Array(40).fill({ resultado: 'aprovado' }) },
    { id: 'ev_1786154849601', batteryId: 'B9', dtDesmoldagem: '2026-07-09T00:06:00.000Z', paineis: Array(40).fill({ resultado: 'aprovado' }) },
  ];

  const stats = calcularEstatisticasAvaliacao(avaliacoesDoBackup, '2026-07-08');
  assert.equal(stats.totalRegistros, 2, 'deveria contar as DUAS avaliações do dia 08/07 (Brasília), igual ao Espelho');
  assert.equal(stats.paineisAvaliados, 80);
});
