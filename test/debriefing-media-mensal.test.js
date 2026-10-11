// Testa a regra da Média Mensal do Debriefing (public/js/debriefing.js):
// MM = traços totais no mês (TT) / dias do mês (DM). Ex.: 60 / 30 = 2.
// Cópia da lógica de dias do mês — MANTER EM SINCRONIA com calcularMediaMensal.
const { test } = require('node:test');
const assert = require('node:assert/strict');

function mediaMensal(tracosMes, data) {
  const [ano, mes] = data.split('-').map(Number);
  const diasMes = new Date(ano, mes, 0).getDate();
  return tracosMes / diasMes;
}

test('exemplo do enunciado: 60 traços em mês de 30 dias = 2', () => {
  assert.equal(mediaMensal(60, '2026-06-15'), 2);
});

test('usa os dias corridos do mês (31, 28 e 29 em bissexto)', () => {
  assert.equal(mediaMensal(62, '2026-07-08'), 2);
  assert.equal(mediaMensal(56, '2026-02-10'), 2);
  assert.equal(mediaMensal(58, '2028-02-10'), 2);
});

// Cópia do filtro acumulado de calcularMediaMensal (dia 1 até o dia selecionado).
function filtrarAteODia(historico, data) {
  const mesRef = data.slice(0, 7);
  return historico.filter(b => {
    const d = b.data || '';
    return d.startsWith(mesRef) && d <= data;
  });
}

test('TT é acumulado do dia 1 até o dia selecionado, só do mês dele', () => {
  const hist = [
    { data: '2026-05-31' }, { data: '2026-06-01' }, { data: '2026-06-05' },
    { data: '2026-06-06' }, { data: '2026-07-01' }
  ];
  assert.deepEqual(filtrarAteODia(hist, '2026-06-05').map(b => b.data),
    ['2026-06-01', '2026-06-05']);
});

// ── Análise Operacional: período filtrado (analise-operacional.js) ──────────
// Cópia de diasNoPeriodo() — MANTER EM SINCRONIA. DM = dias corridos, De e
// Até inclusos.
function diasNoPeriodo(ini, fim) {
  if (!ini || !fim) return 0;
  const [ya, ma, da] = ini.split('-').map(Number);
  const [yb, mb, db] = fim.split('-').map(Number);
  const dias = Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000) + 1;
  return dias > 0 ? dias : 0;
}

test('Análise Operacional: 360 traços em 40 dias = 9', () => {
  const dm = diasNoPeriodo('2026-06-01', '2026-07-10');
  assert.equal(dm, 40);
  assert.equal(360 / dm, 9);
});

test('diasNoPeriodo: mesmo dia = 1; invertido ou vazio = 0', () => {
  assert.equal(diasNoPeriodo('2026-06-05', '2026-06-05'), 1);
  assert.equal(diasNoPeriodo('2026-06-10', '2026-06-05'), 0);
  assert.equal(diasNoPeriodo('', '2026-06-05'), 0);
});
