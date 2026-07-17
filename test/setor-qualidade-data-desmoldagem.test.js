// ─── test/setor-qualidade-data-desmoldagem.test.js ──────────────────────────
// Testa a mudança pedida (ver conversa que motivou): a coluna "Data/Hora"
// em Registros (Setor de Qualidade) e os filtros de período (Registros e
// Dashboard) passam a usar a Data/Hora de DESMOLDAGEM
// (item.dtDesmoldagem) em vez da data de REGISTRO no sistema
// (item.registeredAt — "quando alguém preencheu o formulário", que pode
// ser bem depois da bateria já ter saído da forma). Registros sem
// dtDesmoldagem preenchida (campo opcional) caem de volta pra
// registeredAt, pra não sumir de listas ordenadas/filtradas por data —
// ver _dataReferenciaAvaliacao(), setor-qualidade.js.

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick } = require('./helpers/setor-qualidade-dom.js');

// 3 avaliações — desmoldagem e registro em datas BEM diferentes de
// propósito, pra qualquer confusão entre as duas datas ficar óbvia nos
// asserts abaixo.
const AV_A = {
  id: 'av-a', batteryId: 'B7', turno: '1° TURNO',
  dtDesmoldagem: '2026-06-10T08:00:00.000Z', // desmoldou dia 10
  registeredAt: '2026-06-15T20:00:00.000Z',  // só registrou no sistema dia 15
  montagem: { pallet1: 'SP', pallet2: 'SP', pallet3: 'SP', pallet4: 'SP' },
  totalSlabs: 40, paineis: [],
};
const AV_B = {
  id: 'av-b', batteryId: 'B3', turno: '2° TURNO',
  dtDesmoldagem: '2026-06-20T08:00:00.000Z', // desmoldou dia 20 (DEPOIS de A)
  registeredAt: '2026-06-12T09:00:00.000Z',  // mas registrou no sistema dia 12 (ANTES de A)
  montagem: { pallet1: 'SP', pallet2: 'SP', pallet3: 'SP', pallet4: 'SP' },
  totalSlabs: 40, paineis: [],
};
// Sem dtDesmoldagem — campo opcional, precisa cair de volta pra
// registeredAt (não pode sumir da lista nem virar "Invalid Date").
const AV_C_SEM_DESMOLDAGEM = {
  id: 'av-c', batteryId: 'B5', turno: '3° TURNO',
  registeredAt: '2026-06-25T11:00:00.000Z',
  montagem: { pallet1: 'SP', pallet2: 'SP', pallet3: 'SP', pallet4: 'SP' },
  totalSlabs: 40, paineis: [],
};

let dom;

beforeEach(() => {
  dom = montarTela({ avaliacoesRegistradas: [AV_A, AV_B, AV_C_SEM_DESMOLDAGEM] });
});

after(() => { dom = null; });

test('coluna "Desmoldagem" em Registros mostra dtDesmoldagem, não registeredAt', async () => {
  const { window } = dom;
  window.SQ.navigateTo('history');
  await tick(10);

  const linhas = Array.from(window.document.querySelectorAll('#sq-hist-tbody tr'));
  assert.equal(linhas.length, 3);

  const linhaA = linhas.find(tr => tr.textContent.includes('B7'));
  const dataExibidaA = linhaA.querySelector('td').textContent;
  // dtDesmoldagem de A é 10/jun; registeredAt é 15/jun — confere que é a
  // data de DESMOLDAGEM que aparece (dia 10), não a de registro (dia 15).
  assert.match(dataExibidaA, /10\/06\/2026/, `esperava a data de desmoldagem (10/06), veio: "${dataExibidaA}"`);
});

test('registro SEM dtDesmoldagem cai de volta pra registeredAt (não desaparece, não vira Invalid Date)', async () => {
  const { window } = dom;
  window.SQ.navigateTo('history');
  await tick(10);

  const linhas = Array.from(window.document.querySelectorAll('#sq-hist-tbody tr'));
  const linhaC = linhas.find(tr => tr.textContent.includes('B5'));
  assert.ok(linhaC, 'AV_C (sem dtDesmoldagem) deveria continuar aparecendo na lista');
  const dataExibidaC = linhaC.querySelector('td').textContent;
  assert.match(dataExibidaC, /25\/06\/2026/, `deveria cair pro registeredAt (25/06) na ausência de dtDesmoldagem, veio: "${dataExibidaC}"`);
  assert.doesNotMatch(dataExibidaC, /Invalid/i);
});

test('ordenação de Registros é por dtDesmoldagem (mais recente primeiro), não por registeredAt', async () => {
  const { window } = dom;
  window.SQ.navigateTo('history');
  await tick(10);

  const linhas = Array.from(window.document.querySelectorAll('#sq-hist-tbody tr'));
  const baterias = linhas.map(tr => tr.querySelector('td:nth-child(2)').textContent.trim());
  // Por dtDesmoldagem: B5 (25/jun, sem desmoldagem->cai pro registeredAt)
  // > B3 (20/jun) > B7 (10/jun). Se estivesse ordenando por registeredAt
  // seria B5 (25) > B7 (15) > B3 (12) — a ordem de B7 e B3 se inverte
  // entre os dois critérios, é isso que o teste prova.
  assert.deepEqual(baterias, ['B5', 'B3', 'B7']);
});

test('filtro de período em Registros ("Desmoldagem de/até") filtra por dtDesmoldagem, não por registeredAt', async () => {
  const { window } = dom;
  const document = window.document;
  window.SQ.navigateTo('history');
  await tick(10);

  // Período que cobre a DESMOLDAGEM de B7 (10/jun) mas NÃO a de B3
  // (20/jun) nem a de B5/registeredAt (25/jun) — se o filtro estivesse
  // usando registeredAt, B7 (registrado 15/jun) ficaria de FORA deste
  // range (fim em 12/jun), e B3 (registrado 12/jun) ficaria DENTRO —
  // exatamente o oposto do que os asserts abaixo conferem.
  document.getElementById('sq-hist-start').value = '2026-06-01';
  document.getElementById('sq-hist-end').value = '2026-06-12';
  window.SQ.renderHistory();

  const linhas = Array.from(document.querySelectorAll('#sq-hist-tbody tr'));
  const baterias = linhas.map(tr => tr.querySelector('td:nth-child(2)').textContent.trim());
  assert.deepEqual(baterias, ['B7'], 'só B7 (desmoldada em 10/06) deveria passar no filtro 01/06–12/06');
});

test('filtro de período no Dashboard ("Data Inicial/Final") também usa dtDesmoldagem', async () => {
  const { window } = dom;
  const document = window.document;
  window.SQ.navigateTo('dashboard');
  await tick(10);

  document.getElementById('sq-dash-start').value = '2026-06-15';
  document.getElementById('sq-dash-end').value = '2026-06-30';
  window.SQ.renderDashboard();

  // B7 desmoldou 10/jun (fora do range 15–30) — mesmo tendo sido
  // REGISTRADA em 15/jun (dentro do range, se o filtro fosse por
  // registeredAt). B3 (desmoldou 20/jun) e B5 (sem desmoldagem, registro
  // 25/jun) deveriam passar — 2 registros, não 3. (dashboardEvals é
  // interno à IIFE do módulo, não alcançável por eval — por isso confere
  // pelo texto do resumo, que expõe fe.length diretamente.)
  const resumo = document.getElementById('sq-dash-summary').innerHTML;
  assert.match(resumo, /em <b>2<\/b> registros/, `resumo deveria reportar 2 registros no período (B3 e B5), veio: "${resumo}"`);
});
