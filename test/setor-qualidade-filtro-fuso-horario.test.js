// ─── test/setor-qualidade-filtro-fuso-horario.test.js ───────────────────────
// Bug: filtrando o Espelho/Dashboard (ou o Relatório/Registros) por um
// único dia (ex: 07/08 até 07/08), o TOTAL DE REGISTROS batia diferente do
// que o Debriefing mostrava pro MESMO dia — o Espelho contava a mais (ver
// conversa que motivou esta mudança, com print real mostrando 2 no Espelho
// contra 1 no Debriefing, painéis avaliados 80 contra 40 — exatamente uma
// avaliação inteira de diferença, não arredondamento).
//
// Causa raiz: _dashboardFiltrado()/_historicoFiltrado() (setor-qualidade.js)
// montavam o intervalo de forma ASSIMÉTRICA:
//   dt >= new Date(sd)                    // início: "AAAA-MM-DD" sem hora
//   dt <= new Date(ed + 'T23:59:59')       // fim: com hora, SEM 'Z'
// `new Date('2026-08-07')` (só a data) é sempre interpretado em UTC.
// `new Date('2026-08-07T23:59:59')` (com hora, sem 'Z'/offset) é
// interpretado no FUSO LOCAL do navegador (Brasília, no chão de fábrica).
// O fim do intervalo respeitava Brasília; o início ficava 3h adiantado
// (UTC-3) — o filtro "abria a porta" cedo demais e contava avaliações
// feitas entre 21h e 23h59 (hora de Brasília) do dia ANTERIOR como se
// fossem do dia filtrado. O Debriefing (dataDoISO, debriefing.js) já
// convertia certinho pro fuso 'America/Sao_Paulo', por isso só ELE
// mostrava o número certo.
//
// process.env.TZ ajustado ANTES de qualquer uso de Date/Intl — mesmo
// raciocínio de test/setor-qualidade-fila-horario.test.js: em UTC (padrão
// do CI) o bug fica mascarado, porque UTC-3 vira "UTC-0" e as duas formas
// de interpretar a string coincidem por acidente.

process.env.TZ = 'America/Sao_Paulo';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick } = require('./helpers/setor-qualidade-dom.js');

// Feita às 23:35 de 06/08 em Brasília == 07/08 02:35 UTC — pertence ao
// dia 06, mas cai DEPOIS da meia-noite UTC de 07/08 (a fonte do bug).
const AV_NOITE_ANTERIOR = {
  id: 'av-noite-anterior', batteryId: 'B1', turno: '3° TURNO',
  dtDesmoldagem: '2026-08-07T02:35:00.000Z',
  registeredAt: '2026-08-07T02:40:00.000Z',
  montagem: { pallet1: 'SP', pallet2: 'SP', pallet3: 'SP', pallet4: 'SP' },
  totalSlabs: 40, paineis: [],
};
// Feita às 10:00 de 07/08 em Brasília — pertence ao dia 07 sem
// ambiguidade nenhuma (controle: tem que aparecer nos dois filtros).
const AV_DIA_CERTO = {
  id: 'av-dia-certo', batteryId: 'B2', turno: '1° TURNO',
  dtDesmoldagem: '2026-08-07T13:00:00.000Z',
  registeredAt: '2026-08-07T13:05:00.000Z',
  montagem: { pallet1: 'SP', pallet2: 'SP', pallet3: 'SP', pallet4: 'SP' },
  totalSlabs: 40, paineis: [],
};

let dom;

beforeEach(() => {
  dom = montarTela({ avaliacoesRegistradas: [AV_NOITE_ANTERIOR, AV_DIA_CERTO] });
});

after(() => { dom = null; });

test('Espelho/Dashboard filtrado por 07/08–07/08 NÃO inclui avaliação feita às 23:35 de 06/08 (Brasília)', async () => {
  const { window } = dom;
  const document = window.document;
  window.SQ.navigateTo('dashboard');
  await tick(10);

  document.getElementById('sq-dash-start').value = '2026-08-07';
  document.getElementById('sq-dash-end').value = '2026-08-07';
  window.SQ.renderDashboard();

  const resumo = document.getElementById('sq-dash-summary').innerHTML;
  assert.match(resumo, /em <b>1<\/b> registros/,
    `só AV_DIA_CERTO (07/08) deveria passar no filtro 07/08–07/08 — AV_NOITE_ANTERIOR é de 06/08. Resumo: "${resumo}"`);
});

test('Relatório/Registros filtrado por 07/08–07/08 também NÃO inclui a avaliação de 06/08 à noite', async () => {
  const { window } = dom;
  const document = window.document;
  window.SQ.navigateTo('history');
  await tick(10);

  document.getElementById('sq-hist-start').value = '2026-08-07';
  document.getElementById('sq-hist-end').value = '2026-08-07';
  window.SQ.renderHistory();

  const linhas = Array.from(document.querySelectorAll('#sq-hist-tbody tr'));
  const baterias = linhas.map(tr => tr.querySelector('td:nth-child(2)').textContent.trim());
  assert.deepEqual(baterias, ['B2'], 'só B2 (feita 07/08) deveria aparecer — B1 é de 06/08 (23:35 Brasília)');
});

test('mas o filtro 06/08–06/08 CONTINUA incluindo a avaliação da noite anterior (não desapareceu, só mudou de dia)', async () => {
  const { window } = dom;
  const document = window.document;
  window.SQ.navigateTo('dashboard');
  await tick(10);

  document.getElementById('sq-dash-start').value = '2026-08-06';
  document.getElementById('sq-dash-end').value = '2026-08-06';
  window.SQ.renderDashboard();

  const resumo = document.getElementById('sq-dash-summary').innerHTML;
  assert.match(resumo, /em <b>1<\/b> registros/,
    `AV_NOITE_ANTERIOR deveria aparecer no filtro 06/08–06/08 (é dela mesma que é o dia). Resumo: "${resumo}"`);
});

test('filtro 06/08–07/08 (dois dias) inclui as duas avaliações — nenhuma se perde na fronteira', async () => {
  const { window } = dom;
  const document = window.document;
  window.SQ.navigateTo('dashboard');
  await tick(10);

  document.getElementById('sq-dash-start').value = '2026-08-06';
  document.getElementById('sq-dash-end').value = '2026-08-07';
  window.SQ.renderDashboard();

  const resumo = document.getElementById('sq-dash-summary').innerHTML;
  assert.match(resumo, /em <b>2<\/b> registros/, `resumo: "${resumo}"`);
});
