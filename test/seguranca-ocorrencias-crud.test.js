// ─── test/seguranca-ocorrencias-crud.test.js ────────────────────────────────
// Cobertura do backend de Ocorrências de Segurança — Fase 1 do plano do One
// Page Report (ver README, "Nova página: One Page Report (planejamento)").
//
// Roda contra o server.js DE VERDADE (não um mock), numa cópia isolada —
// ver test/helpers/servidor-teste.js. Cobre:
//   - POST /registrar-ocorrencia-seguranca sem sessão é recusado (403), nada
//     é gravado (ver comentário de PERMISSÃO DE ESCRITA, lib/rotas/
//     seguranca.js — exige sessaoOuAdmin, não uma área de perfil).
//   - `data` ausente/vazia e `gravidade` inválida são recusadas (400).
//   - Caminho feliz: grava a ocorrência e ela aparece em GET
//     /db/seguranca_ocorrencias.json, com `id`/`registrado_em` gerados no
//     servidor.
//   - POST /excluir-ocorrencia-seguranca remove pelo id; id inexistente dá 400.
//   - GET /seguranca/dias-sem-acidentes: `dias: null` sem nenhuma ocorrência
//     (nunca "0" — ver regra do README); depois de registrar, calcula
//     corretamente os dias corridos até "hoje" (relógio congelado via
//     LW_TEST_RELOGIO_ISO); só a ocorrência MAIS RECENTE conta.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-seguranca-ocorrencias-511';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
    // Congela "hoje" (Brasília) pra dias-sem-acidentes ser determinístico —
    // mesmo mecanismo de test/manutencao-programada-lembrete.test.js (ver
    // lib/tempo.js, _agoraServer).
    env: { LW_TEST_RELOGIO_ISO: '2026-08-31T12:00:00-03:00' },
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

function registrarOcorrencia(payload, cookie) {
  return fetch(`${servidor.baseUrl}/registrar-ocorrencia-seguranca`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
}

function excluirOcorrencia(id, cookie) {
  return fetch(`${servidor.baseUrl}/excluir-ocorrencia-seguranca`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ id }),
  });
}

function buscarOcorrencias() {
  return fetch(`${servidor.baseUrl}/db/seguranca_ocorrencias.json`);
}

function buscarDiasSemAcidentes() {
  return fetch(`${servidor.baseUrl}/seguranca/dias-sem-acidentes`);
}

test('POST /registrar-ocorrencia-seguranca sem sessão é recusado (403), nada é gravado', async () => {
  const resp = await registrarOcorrencia({ data: '2026-08-20', descricao: 'Quase-acidente na doca', gravidade: 'leve' }, null);
  assert.equal(resp.status, 403);

  const lista = await (await buscarOcorrencias()).json();
  assert.equal(lista.length, 0);
});

test('data ausente é recusada (400), sem gravar nada', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await registrarOcorrencia({ descricao: 'Sem data', gravidade: 'leve' }, cookie);
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);
  assert.match(corpo.erro, /data/i);

  const lista = await (await buscarOcorrencias()).json();
  assert.equal(lista.length, 0);
});

test('gravidade inválida é recusada (400), sem gravar nada', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await registrarOcorrencia({ data: '2026-08-20', descricao: 'Gravidade inventada', gravidade: 'catastrofica' }, cookie);
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);
  assert.match(corpo.erro, /gravidade/i);

  const lista = await (await buscarOcorrencias()).json();
  assert.equal(lista.length, 0);
});

test('GET /seguranca/dias-sem-acidentes devolve null sem nenhuma ocorrência (nunca 0)', async () => {
  const resp = await buscarDiasSemAcidentes();
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);
  assert.equal(corpo.dias, null);
  assert.equal(corpo.ultimaOcorrencia, null);
});

test('caminho feliz: grava a ocorrência e ela aparece em GET /db/seguranca_ocorrencias.json', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await registrarOcorrencia({
    data: '2026-08-20',
    descricao: 'Piso molhado próximo à injetora — sinalizado e corrigido',
    gravidade: 'MODERADA', // maiúsculo de propósito — servidor normaliza pra minúsculo
    operador_nome: 'Operador Teste',
    // Tentativa de forjar id/registrado_em — o servidor deve ignorar e
    // gerar os dois valores por conta própria.
    id: 'id-forjado-pelo-cliente',
    registrado_em: '2000-01-01T00:00:00.000Z',
  }, cookie);
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);

  const lista = await (await buscarOcorrencias()).json();
  assert.equal(lista.length, 1);
  const [registro] = lista;
  assert.equal(registro.descricao, 'Piso molhado próximo à injetora — sinalizado e corrigido');
  assert.equal(registro.gravidade, 'moderada');
  assert.equal(registro.operador_nome, 'Operador Teste');
  assert.notEqual(registro.id, 'id-forjado-pelo-cliente');
  assert.match(registro.id, /^ocorrencia_seguranca_\d+_[0-9a-f]{6}$/);
  assert.equal(corpo.id, registro.id);
  assert.notEqual(registro.registrado_em, '2000-01-01T00:00:00.000Z');
});

test('GET /seguranca/dias-sem-acidentes calcula os dias corridos até "hoje" (relógio congelado)', async () => {
  // "Hoje" congelado em 2026-08-31 (ver LW_TEST_RELOGIO_ISO, before()); a
  // única ocorrência até aqui é de 2026-08-20 -> 11 dias corridos.
  const resp = await buscarDiasSemAcidentes();
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);
  assert.equal(corpo.ultimaOcorrencia, '2026-08-20');
  assert.equal(corpo.dias, 11);
});

test('uma ocorrência mais recente reduz os dias sem acidentes (só a última data conta)', async () => {
  const cookie = await logarComoAdminMaster();
  await registrarOcorrencia({ data: '2026-08-29', descricao: 'Ocorrência mais recente', gravidade: 'grave' }, cookie);

  const lista = await (await buscarOcorrencias()).json();
  assert.equal(lista.length, 2); // acumula, não substitui (mesmo espírito de tracos_descartados)

  const corpo = await (await buscarDiasSemAcidentes()).json();
  assert.equal(corpo.ultimaOcorrencia, '2026-08-29');
  assert.equal(corpo.dias, 2);
});

test('POST /excluir-ocorrencia-seguranca sem sessão é recusado (403)', async () => {
  const lista = await (await buscarOcorrencias()).json();
  const resp = await excluirOcorrencia(lista[0].id, null);
  assert.equal(resp.status, 403);
});

test('POST /excluir-ocorrencia-seguranca com id inexistente devolve 400', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await excluirOcorrencia('id-que-nao-existe', cookie);
  assert.equal(resp.status, 400);
});

test('POST /excluir-ocorrencia-seguranca remove a ocorrência de verdade', async () => {
  const cookie = await logarComoAdminMaster();
  const antes = await (await buscarOcorrencias()).json();
  assert.equal(antes.length, 2);

  const resp = await excluirOcorrencia(antes[0].id, cookie);
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);

  const depois = await (await buscarOcorrencias()).json();
  assert.equal(depois.length, 1);
  assert.ok(!depois.some(o => o.id === antes[0].id));
});
