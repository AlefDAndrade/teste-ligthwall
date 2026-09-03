// ─── test/tracos-descartados-crud.test.js ───────────────────────────────────
// Cobertura do backend do Registro de Traço Descartado (Perda) — ver
// README, "Registro de Traço Descartado (Perda) — plano", passo 2.
//
// Roda contra o server.js DE VERDADE (não um mock), numa cópia isolada —
// ver test/helpers/servidor-teste.js. Cobre:
//   - POST /registrar-traco-descartado exige permissão de área 'injetora'
//     (mesma checagem de /salvar-sobra) — sem sessão, recusa com 403.
//   - Motivo vazio/ausente é recusado (400), sem gravar nada.
//   - Caminho feliz: grava o traço perdido e ele aparece em
//     GET /db/tracos_descartados.json, com `id`/`registrado_em` gerados
//     no servidor (nunca confiando no que o cliente mandou pra esses 2
//     campos).
//   - Vários descartes acumulam (não é um singleton como sobra.json).
//   - Editar (README, item 8a): exige sessão, id inexistente → 400,
//     motivo vazio recusado sem alterar nada, caminho feliz atualiza os
//     campos SEM nunca mexer em id/registrado_em.
//   - Excluir (README, item 8a): exige sessão, id inexistente → 400,
//     caminho feliz remove só o registro pedido, sem afetar os demais.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-tracos-descartados-372';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
  });
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

function registrarTracoDescartado(payload, cookie) {
  return fetch(`${servidor.baseUrl}/registrar-traco-descartado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
}

function editarTracoDescartado(payload, cookie) {
  return fetch(`${servidor.baseUrl}/editar-traco-descartado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
}

function excluirTracoDescartado(payload, cookie) {
  return fetch(`${servidor.baseUrl}/excluir-traco-descartado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
}

function buscarTracosDescartados() {
  return fetch(`${servidor.baseUrl}/db/tracos_descartados.json`);
}

test('POST /registrar-traco-descartado sem sessão é recusado (403), nada é gravado', async () => {
  const resp = await registrarTracoDescartado({ data: '2026-08-29', turno: '1º Turno', motivo: 'Falha de equipamento' }, null);
  assert.equal(resp.status, 403);

  const lista = await (await buscarTracosDescartados()).json();
  assert.equal(lista.length, 0);
});

test('motivo vazio é recusado (400), sem gravar nada', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await registrarTracoDescartado({ data: '2026-08-29', turno: '1º Turno', motivo: '' }, cookie);
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);
  assert.match(corpo.erro, /motivo/i);

  const lista = await (await buscarTracosDescartados()).json();
  assert.equal(lista.length, 0);
});

test('motivo ausente (nem a chave existe) também é recusado (400)', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await registrarTracoDescartado({ data: '2026-08-29', cimento: 350 }, cookie);
  assert.equal(resp.status, 400);
});

test('caminho feliz: grava o traço perdido e ele aparece em GET /db/tracos_descartados.json', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await registrarTracoDescartado({
    data: '2026-08-29',
    turno: '1º Turno',
    cimento: 350,
    agua: 120,
    eps: 5,
    superplast: 2.5,
    incorporador: 1,
    tempo_batida: 90,
    motivo: 'Contaminação do lote — descartado antes de encher berço',
    operador_nome: 'Operador Teste',
    // Tentativa de forjar id/registrado_em — o servidor deve ignorar e
    // gerar os dois valores por conta própria.
    id: 'id-forjado-pelo-cliente',
    registrado_em: '2000-01-01T00:00:00.000Z',
  }, cookie);
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);

  const lista = await (await buscarTracosDescartados()).json();
  assert.equal(lista.length, 1);
  const [registro] = lista;
  assert.equal(registro.motivo, 'Contaminação do lote — descartado antes de encher berço');
  assert.equal(registro.cimento, 350);
  assert.equal(registro.operador_nome, 'Operador Teste');
  assert.notEqual(registro.id, 'id-forjado-pelo-cliente');
  // Sufixo hexadecimal aleatório (não só timestamp) — evita colisão de
  // id entre dois dispositivos descartando no mesmo milissegundo (ver
  // comentário em lib/rotas/tracos-descartados.js).
  assert.match(registro.id, /^descarte_\d+_[0-9a-f]{6}$/);
  // A resposta HTTP também devolve o id gerado (útil pro front, e prova
  // que o id retornado é exatamente o que foi persistido).
  assert.equal(corpo.id, registro.id);
  assert.notEqual(registro.registrado_em, '2000-01-01T00:00:00.000Z');
});

test('vários descartes acumulam — não é substituído como um singleton', async () => {
  const cookie = await logarComoAdminMaster();
  await registrarTracoDescartado({ data: '2026-08-29', motivo: 'Erro de dosagem' }, cookie);

  const lista = await (await buscarTracosDescartados()).json();
  assert.equal(lista.length, 2);
});

// ── Editar/excluir (README, item 8a das pendências) ────────────────────────

test('POST /editar-traco-descartado sem sessão é recusado (403), nada muda', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await registrarTracoDescartado({ data: '2026-08-30', motivo: 'Falha de equipamento' }, cookie);
  const { id } = await resp.json();

  const respEdicao = await editarTracoDescartado({ id, motivo: 'Tentativa sem sessão' }, null);
  assert.equal(respEdicao.status, 403);

  const lista = await (await buscarTracosDescartados()).json();
  const registro = lista.find(t => t.id === id);
  assert.equal(registro.motivo, 'Falha de equipamento');
});

test('POST /editar-traco-descartado com id inexistente devolve 400', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await editarTracoDescartado({ id: 'id-que-nao-existe', motivo: 'Qualquer coisa' }, cookie);
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.match(corpo.erro, /não encontrado/i);
});

test('POST /editar-traco-descartado com motivo vazio é recusado (400), sem alterar o registro', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await registrarTracoDescartado({ data: '2026-08-30', motivo: 'Motivo original' }, cookie);
  const { id } = await resp.json();

  const respEdicao = await editarTracoDescartado({ id, motivo: '' }, cookie);
  assert.equal(respEdicao.status, 400);

  const lista = await (await buscarTracosDescartados()).json();
  assert.equal(lista.find(t => t.id === id).motivo, 'Motivo original');
});

test('POST /editar-traco-descartado: caminho feliz atualiza os campos, mas NUNCA id/registrado_em', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await registrarTracoDescartado({
    data: '2026-08-30', turno: '1º Turno', cimento: 350, motivo: 'Motivo original',
  }, cookie);
  const { id } = await resp.json();
  const antes = (await (await buscarTracosDescartados()).json()).find(t => t.id === id);

  const respEdicao = await editarTracoDescartado({
    id,
    data: '2026-08-31',
    turno: '2º Turno',
    cimento: 400,
    agua: 130,
    motivo: 'Motivo corrigido',
    // Tentativa de forjar id/registrado_em na edição — servidor deve ignorar.
    registrado_em: '2000-01-01T00:00:00.000Z',
  }, cookie);
  assert.equal(respEdicao.status, 200);
  const corpo = await respEdicao.json();
  assert.equal(corpo.ok, true);

  const depois = (await (await buscarTracosDescartados()).json()).find(t => t.id === id);
  assert.equal(depois.data, '2026-08-31');
  assert.equal(depois.turno, '2º Turno');
  assert.equal(depois.cimento, 400);
  assert.equal(depois.agua, 130);
  assert.equal(depois.motivo, 'Motivo corrigido');
  // id/registrado_em intocados — mesmos valores de antes da edição.
  assert.equal(depois.id, antes.id);
  assert.equal(depois.registrado_em, antes.registrado_em);
});

test('POST /excluir-traco-descartado sem sessão é recusado (403), nada é apagado', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await registrarTracoDescartado({ data: '2026-08-30', motivo: 'Pra excluir' }, cookie);
  const { id } = await resp.json();

  const respExclusao = await excluirTracoDescartado({ id }, null);
  assert.equal(respExclusao.status, 403);

  const lista = await (await buscarTracosDescartados()).json();
  assert.ok(lista.some(t => t.id === id));
});

test('POST /excluir-traco-descartado com id inexistente devolve 400', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await excluirTracoDescartado({ id: 'id-que-nao-existe' }, cookie);
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.match(corpo.erro, /não encontrado/i);
});

test('POST /excluir-traco-descartado: caminho feliz remove o registro de verdade, sem afetar os outros', async () => {
  const cookie = await logarComoAdminMaster();
  const r1 = await registrarTracoDescartado({ data: '2026-08-30', motivo: 'Descarte A' }, cookie);
  const { id: idA } = await r1.json();
  const r2 = await registrarTracoDescartado({ data: '2026-08-30', motivo: 'Descarte B' }, cookie);
  const { id: idB } = await r2.json();

  const totalAntes = (await (await buscarTracosDescartados()).json()).length;

  const respExclusao = await excluirTracoDescartado({ id: idA }, cookie);
  assert.equal(respExclusao.status, 200);
  const corpo = await respExclusao.json();
  assert.equal(corpo.ok, true);

  const lista = await (await buscarTracosDescartados()).json();
  assert.equal(lista.length, totalAntes - 1);
  assert.ok(!lista.some(t => t.id === idA));
  assert.ok(lista.some(t => t.id === idB)); // o outro registro continua intacto
});
