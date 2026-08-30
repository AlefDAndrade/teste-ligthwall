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
