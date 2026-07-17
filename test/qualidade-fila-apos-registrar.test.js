// ─── test/qualidade-fila-apos-registrar.test.js ─────────────────────────────
// Testa um bug real encontrado (ver conversa que motivou isso — usuário
// mandou um backup de produção com 2 avaliações já registradas cujas
// operações vinculadas continuavam na fila "não avaliada" pra sempre):
//
// Antes, marcar a operação como avaliada acontecia numa 2ª requisição
// SEPARADA do front (POST /marcar-operacao-avaliada), depois da resposta
// de /registrar-avaliacao-qualidade — se essa 2ª chamada falhasse por
// qualquer motivo (rede, navegação embora antes dela completar, etc.), a
// avaliação ficava salva com sucesso, mas a operação nunca saía da fila.
//
// Agora POST /registrar-avaliacao-qualidade marca a operação vinculada
// como avaliada NA MESMA REQUISIÇÃO — sem 2º request, sem essa janela de
// falha silenciosa.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-fila-avaliacao-741';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
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

function painelBasico(pallet, posicao) {
  return {
    pallet, posicao, tipoEsperado: 'SP', tipoObtido: 'SP', resultado: 'aprovado', linha: '1ª',
    marcas: [{ shape: 'dash', color: 'verde' }], motivo: null, motivoDescricao: null,
  };
}

test('registrar uma avaliação vinculada a uma operação da fila REMOVE essa operação da fila na mesma requisição (sem precisar de uma 2ª chamada)', async () => {
  const cookie = await logarComoAdminMaster();
  const idOp = 'op-fila-' + Date.now();

  await fetch(`${servidor.baseUrl}/registrar-operacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: idOp, data: '2026-07-16', turno: '1° TURNO', dimensao: 9, capacidade: 20, id_bateria: 'B5' }),
  });

  // Confirma a premissa: a operação está na fila ANTES de avaliar.
  const respFilaAntes = await fetch(`${servidor.baseUrl}/operacoes-nao-avaliadas`);
  const filaAntes = await respFilaAntes.json();
  assert.ok(filaAntes.some(o => o.id === idOp), 'premissa do teste: a operação deveria estar na fila antes de avaliar');

  const idAvaliacao = 'ev-fila-' + Date.now();
  const paineis = [1, 2, 3, 4].map(p => painelBasico(p, 1));
  const respAvaliacao = await fetch(`${servidor.baseUrl}/registrar-avaliacao-qualidade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: idAvaliacao, batteryId: 'B5', linkedOperacaoId: idOp, turno: '1° TURNO',
      montagem: { pallet1: 'SP', pallet2: 'SP', pallet3: 'SP', pallet4: 'SP' },
      totalSlabs: 4, paineis,
    }),
  });
  assert.equal(respAvaliacao.status, 200);

  // SEM chamar /marcar-operacao-avaliada — a operação já deveria ter
  // saído da fila sozinha, como parte da requisição acima.
  const respFilaDepois = await fetch(`${servidor.baseUrl}/operacoes-nao-avaliadas`);
  const filaDepois = await respFilaDepois.json();
  assert.ok(!filaDepois.some(o => o.id === idOp), 'a operação deveria ter saído da fila só de registrar a avaliação, sem precisar de uma 2ª chamada');
});

test('a mesma correção também marca "avaliada" numa CORREÇÃO (id já existente) — idempotente, não dá erro', async () => {
  const cookie = await logarComoAdminMaster();
  const idOp = 'op-fila-correcao-' + Date.now();

  await fetch(`${servidor.baseUrl}/registrar-operacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: idOp, data: '2026-07-16', turno: '1° TURNO', dimensao: 9, capacidade: 20, id_bateria: 'B6' }),
  });

  const idAvaliacao = 'ev-fila-correcao-' + Date.now();
  const paineis = [1, 2, 3, 4].map(p => painelBasico(p, 1));
  const payload = {
    id: idAvaliacao, batteryId: 'B6', linkedOperacaoId: idOp, turno: '1° TURNO',
    montagem: { pallet1: 'SP', pallet2: 'SP', pallet3: 'SP', pallet4: 'SP' },
    totalSlabs: 4, paineis,
  };
  await fetch(`${servidor.baseUrl}/registrar-avaliacao-qualidade`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(payload),
  });

  // Corrige (mesmo id) — não deveria dar erro nem duplicar nada.
  const respCorrecao = await fetch(`${servidor.baseUrl}/registrar-avaliacao-qualidade`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ ...payload, observations: 'corrigido' }),
  });
  assert.equal(respCorrecao.status, 200);

  const respFila = await fetch(`${servidor.baseUrl}/operacoes-nao-avaliadas`);
  const fila = await respFila.json();
  assert.ok(!fila.some(o => o.id === idOp));
});
