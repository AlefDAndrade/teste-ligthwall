// ─── test/ajustes-traco-fuso-horario.test.js ────────────────────────────────
// Bug relatado numa conversa: no painel de detalhe do Relatório de Injeção
// (dashboard.js), a coluna "Quando" da tabela de ajustes de um traço
// aparecia adiantada em 3h — mesma classe de bug já vista antes (ver
// test/analise-focada-fuso-horario.test.js, um caso relacionado mas
// inverso).
//
// Causa: `registrado_em` (o "quando" de um ajuste) era gravado no servidor
// via `new Date().toISOString()` — UTC de verdade. Mas o FRONT
// (LW.formatDateTime, data.js) assume a convenção "fake-UTC-como-Brasília"
// (mesma de nowBrasilia()/op.inicio/op.fim) e exibe os componentes
// numéricos da ISO string DIRETO, sem reconverter (timeZone:'UTC' na
// formatação). Brasília é UTC-3 (sem horário de verão desde 2019), então
// um UTC de verdade aparecia 3h ADIANTADO.
//
// Corrigido com agoraBrasiliaISOServer() (lib/tempo.js) — gera a mesma
// convenção fake-UTC, calculada a partir da hora real em
// America/Sao_Paulo (funciona certo mesmo se o SERVIDOR estiver rodando
// em outro fuso).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-fuso-ajuste-372';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

test('registrar-ajuste-traco: registrado_em reflete a hora de BRASÍLIA (fake-UTC), não a hora real em UTC', async () => {
  // Relógio do servidor congelado em 2026-07-12T14:00:00-03:00 (Brasília)
  // — não importa em qual fuso a MÁQUINA do servidor está rodando
  // de verdade, LW_TEST_RELOGIO_ISO fixa o instante real; o que este
  // teste verifica é que agoraBrasiliaISOServer() converte esse instante
  // pra hora de Brasília (14h) e NÃO deixa passar a hora UTC real
  // (17h, já que Brasília é UTC-3).
  const servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
    env: { LW_TEST_RELOGIO_ISO: '2026-07-12T14:00:00-03:00' },
  });
  try {
    const idTraco = 'traco-fuso-ajuste-' + Date.now();
    const resp = await fetch(`${servidor.baseUrl}/registrar-ajuste-traco`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_traco: idTraco, ajuste: { tempo_batida: 5, cimento: 2 } }),
    });
    assert.equal(resp.status, 200);

    const ajustesJSON = await (await fetch(`${servidor.baseUrl}/db/ajustes_tracos.json`)).json();
    const entrada = ajustesJSON.find(a => a.id_traco === idTraco);
    assert.ok(entrada, 'entrada de ajustes deveria existir');

    const registradoEm = entrada.ajuste_1.registrado_em;
    // "fake-UTC": os componentes numéricos da ISO string SÃO a hora de
    // Brasília (14h) — exatamente como nowBrasilia().toISOString() no
    // front. Se viesse de new Date().toISOString() puro, seria "17:00"
    // (14h Brasília + 3h = 17h UTC de verdade) — o bug relatado.
    assert.match(registradoEm, /^2026-07-12T14:00:00/,
      `registrado_em deveria ser "2026-07-12T14:00:00..." (hora de Brasília, fake-UTC), veio "${registradoEm}" — sinal do bug relatado (adiantamento de 3h)`);
  } finally {
    await servidor.parar();
  }
});

test('editar-traco-relatorio: registrado_em de um ajuste novo (sem vir no payload) também usa a convenção fake-UTC', async () => {
  const servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
    env: { LW_TEST_RELOGIO_ISO: '2026-07-12T09:15:00-03:00' },
  });
  try {
    const cookie = (await fetch(`${servidor.baseUrl}/verificar-senha`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: SENHA_ADMIN }),
    })).headers.get('set-cookie').split(';')[0];

    const idTraco = 'traco-fuso-editar-' + Date.now();
    const idOp = 'op-fuso-editar-' + Date.now();

    await fetch(`${servidor.baseUrl}/registrar-relatorio-injecao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify([{
        id_traco: idTraco, data: '2026-07-12', turno: '1° TURNO', num_traco: 1,
        cimento_real: 350, agua_real: 180, eps_real: 2.5, superplast_real: 4, incorporador_real: 1,
        tempo_batida: 120, densidade: 1050, flow: 210,
        ultilizado: { operacao: [{ id_operacao: idOp, id_bateria: 'B1', berco_inicio: '1', berco_finalizacao: '4' }] },
      }]),
    });

    const resp = await fetch(`${servidor.baseUrl}/editar-traco-relatorio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        id_traco: idTraco, id_operacao: idOp,
        novosValores: { uso: { id_bateria: 'B1', berco_inicio: 1, berco_finalizacao: 4, obs: '' }, originais: { cimento_real: 350 } },
        ajustes: [{ tempo_batida: 3, cimento: 1 }], // sem registrado_em — servidor gera
        diff: [{ campo: 'cimento_real', de: 350, para: 350 }],
      }),
    });
    assert.equal(resp.status, 200);

    const ajustesJSON = await (await fetch(`${servidor.baseUrl}/db/ajustes_tracos.json`)).json();
    const entrada = ajustesJSON.find(a => a.id_traco === idTraco);
    assert.match(entrada.ajuste_1.registrado_em, /^2026-07-12T09:15:00/,
      'registrado_em gerado pela edição também deveria seguir a convenção fake-UTC (hora de Brasília)');
  } finally {
    await servidor.parar();
  }
});
