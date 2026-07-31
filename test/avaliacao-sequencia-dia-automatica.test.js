// ─── test/avaliacao-sequencia-dia-automatica.test.js ────────────────────────
// Testa a automação da "Sequência do Dia" (Setor de Qualidade → Avaliação):
// antes era um <select> manual (1 a 13) que o avaliador escolhia à mão —
// gerava erros reais (número repetido, fora de ordem, esquecido). Agora é
// calculada no SERVIDOR na hora de registrar (ver db.salvarAvaliacaoQualidade,
// lib/db/operacoes-qualidade.js): conta quantas avaliações já existem no
// mesmo dia (Brasília) e soma 1.
//
// Cobre, via HTTP direto contra o servidor real (mesmo padrão de
// autoria-automatica.test.js):
//   1. Primeira avaliação do dia recebe dailySeq = 1, incrementa a cada nova.
//   2. A contagem usa o DIA EM BRASÍLIA, não o dia em UTC — um horário perto
//      da meia-noite (ex: 23h30 Brasília, já virado pra UTC do dia seguinte)
//      continua contando pro dia de Brasília certo (mesma classe de bug já
//      documentada em test/analise-focada-fuso-horario.test.js).
//   3. Um novo dia (Brasília) reinicia a contagem em 1, sozinho.
//   4. Corrigir uma avaliação (reenviar o mesmo id) PRESERVA o dailySeq
//      original quando ele vem no payload — corrigir um erro de digitação
//      não deveria mudar a posição da avaliação na sequência do dia em que
//      ela realmente aconteceu.
//   5. Sem dailySeq no payload (ex: cliente antigo), o servidor calcula um
//      novo — documenta o fallback pra quem não manda o campo de volta.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-seq-dia-999';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let cookie;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
  });
  cookie = await logarComoAdminMaster();
});

after(async () => {
  await servidor.parar();
});

function extrairCookie(resposta) {
  const setCookie = resposta.headers.get('set-cookie') || '';
  return setCookie.split(';')[0] || null;
}

async function logarComoAdminMaster() {
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  return extrairCookie(resp);
}

let _contadorId = 0;
function proximoId(prefixo) {
  _contadorId += 1;
  return `${prefixo}-${Date.now()}-${_contadorId}`;
}

// Cria uma operação real na fila (pré-requisito pra "linkedOperacaoId" —
// avaliação avulsa não é mais permitida, ver comentário em
// POST /registrar-avaliacao-qualidade, lib/rotas/qualidade.js) e devolve o
// id dela.
async function criarOperacao() {
  const idOp = proximoId('op-seq-dia');
  const resp = await fetch(`${servidor.baseUrl}/registrar-operacao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: idOp, data: '2026-07-15', turno: '1° TURNO', dimensao: 9, capacidade: 20,
      id_bateria: 'B5', operador_nome: 'teste.sequencia',
    }),
  });
  assert.equal(resp.status, 200, 'setup: operação deveria ser criada com sucesso');
  return idOp;
}

// Registra uma avaliação nova (POST /registrar-avaliacao-qualidade),
// vinculada a uma operação real recém-criada. `extra` permite sobrescrever
// campos do payload (ex: registeredAt, dailySeq, id — pra simular correção).
async function registrarAvaliacao(extra = {}) {
  const idOp = extra.linkedOperacaoId || await criarOperacao();
  const id = extra.id || proximoId('ev-seq-dia');
  const payload = {
    id,
    batteryId: 'B5',
    linkedOperacaoId: idOp,
    turno: '1° TURNO',
    paineis: [],
    ...extra,
  };
  const resp = await fetch(`${servidor.baseUrl}/registrar-avaliacao-qualidade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(payload),
  });
  assert.equal(resp.status, 200, `registrar-avaliacao-qualidade deveria aceitar (id=${id})`);
  return id;
}

async function buscarAvaliacao(id) {
  const resp = await fetch(`${servidor.baseUrl}/avaliacoes-qualidade`);
  const lista = await resp.json();
  const item = lista.find(a => a.id === id);
  assert.ok(item, `avaliação ${id} deveria estar na lista`);
  return item;
}

test('primeira avaliação de um dia novo recebe dailySeq = 1', async () => {
  const id = await registrarAvaliacao({ registeredAt: '2026-08-01T13:00:00.000Z' }); // 10h Brasília
  const item = await buscarAvaliacao(id);
  assert.equal(item.dailySeq, 1);
});

test('avaliações seguintes no mesmo dia incrementam a sequência (2, 3, ...)', async () => {
  const dia = '2026-08-02';
  const id1 = await registrarAvaliacao({ registeredAt: `${dia}T13:00:00.000Z` }); // 10h Brasília
  const id2 = await registrarAvaliacao({ registeredAt: `${dia}T15:30:00.000Z` }); // 12h30 Brasília
  const id3 = await registrarAvaliacao({ registeredAt: `${dia}T18:00:00.000Z` }); // 15h Brasília

  assert.equal((await buscarAvaliacao(id1)).dailySeq, 1);
  assert.equal((await buscarAvaliacao(id2)).dailySeq, 2);
  assert.equal((await buscarAvaliacao(id3)).dailySeq, 3);
});

test('a contagem usa o dia em Brasília, não em UTC (horário perto da meia-noite)', async () => {
  // 23h30 em Brasília, no dia 2026-08-03 — mas já é 2026-08-04T02:30 em
  // UTC. Se a contagem usasse o dia em UTC (bug), esta avaliação cairia
  // erradamente no "dia seguinte" (04/08) em vez de continuar o dia 03/08.
  const idManha  = await registrarAvaliacao({ registeredAt: '2026-08-03T13:00:00.000Z' }); // 10h Brasília, dia 03
  const idNoite  = await registrarAvaliacao({ registeredAt: '2026-08-04T02:30:00.000Z' }); // 23h30 Brasília, AINDA dia 03
  const idDiaSeguinteDeVerdade = await registrarAvaliacao({ registeredAt: '2026-08-04T13:00:00.000Z' }); // 10h Brasília, dia 04 de verdade

  assert.equal((await buscarAvaliacao(idManha)).dailySeq, 1, 'primeira avaliação do dia 03');
  assert.equal((await buscarAvaliacao(idNoite)).dailySeq, 2, '23h30 Brasília ainda é dia 03, deveria ser a 2ª');
  assert.equal((await buscarAvaliacao(idDiaSeguinteDeVerdade)).dailySeq, 1, 'dia 04 de verdade reinicia a contagem');
});

test('um novo dia reinicia a contagem em 1, sozinho (sem precisar zerar nada manualmente)', async () => {
  const idOntem = await registrarAvaliacao({ registeredAt: '2026-08-05T13:00:00.000Z' });
  const idOntem2 = await registrarAvaliacao({ registeredAt: '2026-08-05T14:00:00.000Z' });
  const idHoje = await registrarAvaliacao({ registeredAt: '2026-08-06T13:00:00.000Z' });

  assert.equal((await buscarAvaliacao(idOntem)).dailySeq, 1);
  assert.equal((await buscarAvaliacao(idOntem2)).dailySeq, 2);
  assert.equal((await buscarAvaliacao(idHoje)).dailySeq, 1, 'dia novo — contagem reiniciada');
});

test('corrigir uma avaliação (reenviando o mesmo id + dailySeq original) preserva o número, mesmo com avaliações novas registradas depois', async () => {
  const dia = '2026-08-07';
  const idOp = await criarOperacao();
  const idAlvo = proximoId('ev-correcao');

  await registrarAvaliacao({ registeredAt: `${dia}T13:00:00.000Z` }); // dailySeq 1, de outra operação
  const idOriginal = await registrarAvaliacao({ id: idAlvo, linkedOperacaoId: idOp, registeredAt: `${dia}T14:00:00.000Z` }); // dailySeq 2
  const original = await buscarAvaliacao(idOriginal);
  assert.equal(original.dailySeq, 2, 'sanity check: avaliação original deveria ser a 2ª do dia');

  // Mais avaliações registradas DEPOIS, no mesmo dia — a correção não deve
  // "pular" pra depois delas.
  await registrarAvaliacao({ registeredAt: `${dia}T15:00:00.000Z` }); // dailySeq 3
  await registrarAvaliacao({ registeredAt: `${dia}T16:00:00.000Z` }); // dailySeq 4

  // Correção: mesmo id, mesmo linkedOperacaoId, dailySeq original enviado
  // de volta (é o que registerEvaluation() faz de verdade — ver
  // setor-qualidade.js, _editandoDailySeq) — só muda observations, pra
  // simular uma correção de verdade.
  await registrarAvaliacao({
    id: idAlvo,
    linkedOperacaoId: idOp,
    registeredAt: `${dia}T14:00:00.000Z`,
    dailySeq: original.dailySeq,
    observations: 'correção de teste',
  });

  const corrigida = await buscarAvaliacao(idAlvo);
  assert.equal(corrigida.dailySeq, 2, 'correção deveria preservar o dailySeq original (2), não pular pra 5');
  assert.equal(corrigida.observations, 'correção de teste');
});

test('reenviar o mesmo id SEM mandar dailySeq (cliente que não preserva o campo) faz o servidor recalcular um novo', async () => {
  const dia = '2026-08-08';
  const idOp = await criarOperacao();
  const idAlvo = proximoId('ev-sem-preservar');

  const idOriginal = await registrarAvaliacao({ id: idAlvo, linkedOperacaoId: idOp, registeredAt: `${dia}T13:00:00.000Z` });
  assert.equal((await buscarAvaliacao(idOriginal)).dailySeq, 1);

  await registrarAvaliacao({ registeredAt: `${dia}T14:00:00.000Z` }); // outra avaliação nova, dailySeq 2

  // Reenvia o MESMO id, mas sem "dailySeq" no payload — comportamento
  // documentado: o servidor trata como se não soubesse o valor original e
  // recalcula (por isso o front real sempre manda de volta, ver teste
  // anterior).
  await registrarAvaliacao({
    id: idAlvo,
    linkedOperacaoId: idOp,
    registeredAt: `${dia}T13:00:00.000Z`,
    observations: 'reenviado sem dailySeq',
  });

  const resultado = await buscarAvaliacao(idAlvo);
  assert.equal(resultado.dailySeq, 2, 'sem dailySeq no payload, o servidor recalculou (não preservou o 1 original)');
});

test('avaliação nova (sem dailySeq no payload) nunca fica com o campo nulo/ausente', async () => {
  const id = await registrarAvaliacao({ registeredAt: '2026-08-09T13:00:00.000Z' });
  const item = await buscarAvaliacao(id);
  assert.ok(Number.isInteger(item.dailySeq) && item.dailySeq >= 1, 'dailySeq deveria ser um inteiro >= 1');
});
