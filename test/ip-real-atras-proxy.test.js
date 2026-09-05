// ─── test/ip-real-atras-proxy.test.js ───────────────────────────────────────
// Cobre lib/ip-cliente.js — criado depois de um bug relatado em produção:
// atrás do Caddy (reverse_proxy, ver deploy/instalar-https.sh),
// `req.socket.remoteAddress` é SEMPRE o próprio Caddy (localhost), nunca o
// dispositivo real. Isso quebrava a "religa por IP" de
// dispositivoAutorizado() (lib/dispositivo-autorizado.js) de um jeito ATIVO,
// não só "não funciona": como todo dispositivo aparecia com o MESMO IP
// (o do Caddy), um segundo dispositivo perdendo o cookie/deviceId conseguia
// "roubar" a autorização de outro já autorizado, religando por cima o
// deviceId dele — o sintoma relatado foi "o deviceId muda, temos que ficar
// reautorizando de vez em quando" (não era o deviceId em si mudando, era a
// entrada de outro dispositivo sendo sobrescrita).
//
// Parte 1: testa lib/ip-cliente.js isolado (unitário, sem subir servidor).
// Parte 2: reproduz o cenário completo end-to-end via HTTP, simulando o
// header X-Forwarded-For que o Caddy acrescenta (o helper de teste sobe o
// server.js direto, sem proxy nenhum na frente — por isso comparamos o
// comportamento COM e SEM o header, no lugar de precisar de um Caddy de
// verdade no ambiente de teste).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ipRealDoRequest } = require('../lib/ip-cliente.js');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

// ─── Parte 1: unitário ──────────────────────────────────────────────────────

test('sem X-Forwarded-For, usa o IP do socket (comportamento de sempre, sem proxy)', () => {
  const req = { headers: {}, socket: { remoteAddress: '203.0.113.10' } };
  assert.equal(ipRealDoRequest(req), '203.0.113.10');
});

test('remove o prefixo IPv4-mapeado-em-IPv6 ("::ffff:") do IP do socket', () => {
  const req = { headers: {}, socket: { remoteAddress: '::ffff:192.168.1.10' } };
  assert.equal(ipRealDoRequest(req), '192.168.1.10');
});

test('com X-Forwarded-For de um único IP (Caddy na frente), usa esse IP — não o socket (que seria o do próprio Caddy)', () => {
  const req = {
    headers: { 'x-forwarded-for': '198.51.100.7' },
    socket: { remoteAddress: '127.0.0.1' }, // o Caddy, se não fosse pelo header
  };
  assert.equal(ipRealDoRequest(req), '198.51.100.7');
});

test('com múltiplos IPs em X-Forwarded-For (vários proxies encadeados), usa o ÚLTIMO — o mais próximo do proxy confiável', () => {
  // Um cliente malicioso pode mandar seu próprio X-Forwarded-For (com um IP
  // falso na FRENTE da lista), mas não consegue impedir o proxy confiável
  // de ACRESCENTAR o IP real dele no FIM da lista — por isso o último valor
  // é o único em que dá pra confiar, nunca o primeiro.
  const req = {
    headers: { 'x-forwarded-for': '1.2.3.4 (forjado-pelo-cliente), 198.51.100.7' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  assert.equal(ipRealDoRequest(req), '198.51.100.7');
});

test('X-Forwarded-For vazio ("") cai no IP do socket, sem quebrar', () => {
  const req = { headers: { 'x-forwarded-for': '' }, socket: { remoteAddress: '203.0.113.10' } };
  assert.equal(ipRealDoRequest(req), '203.0.113.10');
});

// ─── Parte 2: end-to-end, o cenário real que motivou a correção ────────────

const SENHA_ADMIN = 'senha-admin-ip-proxy-741';
let servidor;

before(async () => {
  const crypto = require('node:crypto');
  const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
});

after(async () => {
  await servidor.parar();
});

async function logarComoAdminMaster() {
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  const setCookie = resp.headers.get('set-cookie') || '';
  return setCookie.split(';')[0] || null;
}

test('dois dispositivos com IPs REAIS diferentes (via X-Forwarded-For) não roubam a autorização um do outro ao perder o deviceId', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const deviceA = 'dev_proxy_A_' + Date.now();
  const deviceB = 'dev_proxy_B_' + Date.now();
  const ipA = '198.51.100.11';
  const ipB = '198.51.100.22';

  // Autoriza o Dispositivo A, simulando que ele está atrás do Caddy com IP
  // real ipA (X-Forwarded-For — sem isso, o teste registraria 127.0.0.1
  // pra ambos, exatamente o bug que estamos cobrindo).
  const respA = await fetch(`${servidor.baseUrl}/autorizar-dispositivo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin, 'X-Forwarded-For': ipA },
    body: JSON.stringify({ deviceId: deviceA, nome: 'Dispositivo A' }),
  });
  assert.equal(respA.status, 200);

  // Autoriza o Dispositivo B, com um IP real DIFERENTE (ipB).
  const respB = await fetch(`${servidor.baseUrl}/autorizar-dispositivo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin, 'X-Forwarded-For': ipB },
    body: JSON.stringify({ deviceId: deviceB, nome: 'Dispositivo B' }),
  });
  assert.equal(respB.status, 200);

  const listaAntes = await (await fetch(`${servidor.baseUrl}/dispositivos-autorizados`, {
    headers: { Cookie: cookieAdmin },
  })).json();
  const entradaA = listaAntes.lista.find(d => d.deviceId === deviceA);
  const entradaB = listaAntes.lista.find(d => d.deviceId === deviceB);
  assert.equal(entradaA.ip, ipA);
  assert.equal(entradaB.ip, ipB);
  assert.notEqual(entradaA.ip, entradaB.ip); // a prova de que não colidiram no mesmo IP de proxy

  // Dispositivo A perde o cookie/deviceId (ex: limpou dados do navegador) e
  // reconecta com um deviceId NOVO, mas do MESMO ip real (ipA) — deve
  // religar a própria entrada dele (autocura), sem tocar na entrada de B.
  const deviceANovo = 'dev_proxy_A_novo_' + Date.now();
  const respControlarComoA = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${deviceANovo}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin, 'X-Forwarded-For': ipA },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(respControlarComoA.status, 200); // autocura funcionou pra A

  const listaDepois = await (await fetch(`${servidor.baseUrl}/dispositivos-autorizados`, {
    headers: { Cookie: cookieAdmin },
  })).json();
  const entradaARenovada = listaDepois.lista.find(d => d.deviceId === deviceANovo);
  const entradaBIntacta = listaDepois.lista.find(d => d.deviceId === deviceB);

  assert.ok(entradaARenovada, 'a entrada de A deveria ter religado pro deviceId novo');
  // O PONTO CENTRAL do teste: a entrada de B continua exatamente como
  // estava — não foi sobrescrita pelo religamento de A (o bug faria B
  // desaparecer/virar deviceANovo se os dois tivessem o mesmo IP de proxy).
  assert.ok(entradaBIntacta, 'a entrada de B nao deveria ter sido roubada pelo religamento de A');
  assert.equal(entradaBIntacta.ip, ipB);

  // E o Dispositivo B (deviceId original, nunca trocou) continua conseguindo
  // controlar operação normalmente, do IP dele.
  const respControlarComoB = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${deviceB}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin, 'X-Forwarded-For': ipB },
    body: JSON.stringify({ dados: { id_bateria: 'B1', tipo_montagem: 'SP', status: 'ativa' }, clientId: 'x' }),
  });
  assert.equal(respControlarComoB.status, 200);
});
