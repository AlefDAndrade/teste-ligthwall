// ─── test/compressao-resposta.test.js ───────────────────────────────────────
// lib/compressao-resposta.js: comprime só o que deve, sem mudar o conteúdo,
// e não interfere em streaming (SSE) nem em cabeçalhos já definidos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const zlib = require('zlib');
const { aplicarCompressao } = require('../lib/compressao-resposta.js')({ zlib });

function subir(handler) {
  return new Promise((ok) => {
    const srv = http.createServer((req, res) => { aplicarCompressao(req, res); handler(req, res); });
    srv.listen(0, '127.0.0.1', () => ok(srv));
  });
}
function pedir(srv, gzip) {
  return new Promise((ok, erro) => {
    const { port } = srv.address();
    http.get({ host: '127.0.0.1', port, path: '/', headers: gzip ? { 'Accept-Encoding': 'gzip, br' } : {} }, (res) => {
      const partes = []; res.on('data', c => partes.push(c));
      res.on('end', () => ok({ res, corpo: Buffer.concat(partes) }));
    }).on('error', erro);
  });
}
const JSON_GRANDE = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, nome: 'traço ' + i })));

test('JSON grande sai comprimido, idêntico ao original, mantendo outros cabeçalhos', async () => {
  const srv = await subir((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON_GRANDE);
  });
  const { res, corpo } = await pedir(srv, true);
  srv.close();
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.headers.vary, /Accept-Encoding/);
  assert.equal(Number(res.headers['content-length']), corpo.length);
  assert.ok(corpo.length < JSON_GRANDE.length / 3);
  assert.equal(zlib.gunzipSync(corpo).toString('utf8'), JSON_GRANDE);
});

test('cliente sem gzip recebe sem compressão', async () => {
  const srv = await subir((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON_GRANDE); });
  const { res, corpo } = await pedir(srv, false);
  srv.close();
  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(corpo.toString('utf8'), JSON_GRANDE);
});

test('binário (PDF) e resposta pequena passam intocados', async () => {
  const pdf = Buffer.alloc(5000, 7);
  const srv = await subir((req, res) => { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length }); res.end(pdf); });
  const r1 = await pedir(srv, true); srv.close();
  assert.equal(r1.res.headers['content-encoding'], undefined);
  assert.deepEqual(r1.corpo, pdf);

  const srv2 = await subir((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  const r2 = await pedir(srv2, true); srv2.close();
  assert.equal(r2.res.headers['content-encoding'], undefined);
  assert.equal(r2.corpo.toString(), '{"ok":true}');
});

test('streaming com res.write (SSE) não é comprimido nem atrasado', async () => {
  const srv = await subir((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: a\ndata: {}\n\n'.repeat(100));
    res.end();
  });
  const { res, corpo } = await pedir(srv, true);
  srv.close();
  assert.equal(res.headers['content-encoding'], undefined);
  assert.equal(corpo.toString(), 'event: a\ndata: {}\n\n'.repeat(100));
});

test('callback do res.end continua sendo chamado (usado no 413 do server.js)', async () => {
  let chamou = false;
  const srv = await subir((req, res) => {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON_GRANDE, () => { chamou = true; });
  });
  const { res } = await pedir(srv, true);
  srv.close();
  assert.equal(res.statusCode, 413);
  assert.equal(chamou, true);
});
