// ─── test/ip-real-atras-proxy.test.js ───────────────────────────────────────
// Cobre lib/ip-cliente.js — criado depois de um bug relatado em produção:
// atrás do Caddy (reverse_proxy, ver deploy/instalar-https.sh),
// `req.socket.remoteAddress` é SEMPRE o próprio Caddy (localhost), nunca o
// dispositivo real. Isso é usado por vários consumidores — rate limit por
// IP (lib/rate-limit-ip.js), log de acesso (lib/rotas/log-acesso.js),
// fila offline (lib/rotas/operacao-offline.js), histórico de tentativa de
// senha (lib/auth.js) — que quebrariam do mesmo jeito (todo mundo
// aparecendo com o IP do Caddy) sem ipRealDoRequest().
//
// Testa lib/ip-cliente.js isolado (unitário, sem subir servidor).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ipRealDoRequest } = require('../lib/ip-cliente.js');

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
