/* global Response */
// ─── test/fetch-compartilhado.test.js ───────────────────────────────────────
// public/js/fetch-compartilhado.js: leituras repetidas reaproveitadas,
// escritas sempre invalidam, rotas fora da lista passam direto.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { criarFetchCompartilhado, JANELA_MS } = require('../public/js/fetch-compartilhado.js');

const ORIGEM = 'http://lw.local/index.html';
function fakeFetch() {
  const chamadas = [];
  let n = 0;
  const f = (input, init) => {
    chamadas.push({ url: String(input), metodo: (init && init.method) || 'GET' });
    const corpo = JSON.stringify({ versao: ++n });
    return new Promise(ok => setTimeout(() => ok(new Response(corpo, { status: 200 })), 5));
  };
  return { f, chamadas };
}
const esperar = ms => new Promise(r => setTimeout(r, ms));

test('pedidos simultâneos à mesma rota viram 1 download, todos leem o corpo', async () => {
  const { f, chamadas } = fakeFetch();
  const { fetchCompartilhado } = criarFetchCompartilhado(f, ORIGEM);
  const rs = await Promise.all([1, 2, 3].map(() => fetchCompartilhado('db/historico.json')));
  const corpos = await Promise.all(rs.map(r => r.json()));
  assert.equal(chamadas.length, 1);
  assert.deepEqual(corpos, [{ versao: 1 }, { versao: 1 }, { versao: 1 }]);
});

test('pedido logo em seguida (dentro da janela) reaproveita; depois da janela busca de novo', async () => {
  const { f, chamadas } = fakeFetch();
  const { fetchCompartilhado } = criarFetchCompartilhado(f, ORIGEM);
  await (await fetchCompartilhado('/db/relatorio_injecao.json')).json();
  await (await fetchCompartilhado('/db/relatorio_injecao.json')).json();
  assert.equal(chamadas.length, 1);
  await esperar(JANELA_MS + 100);
  assert.deepEqual(await (await fetchCompartilhado('/db/relatorio_injecao.json')).json(), { versao: 2 });
  assert.equal(chamadas.length, 2);
});

test('um POST invalida: a leitura seguinte vai ao servidor', async () => {
  const { f, chamadas } = fakeFetch();
  const { fetchCompartilhado } = criarFetchCompartilhado(f, ORIGEM);
  await fetchCompartilhado('db/historico.json');
  await fetchCompartilhado('/editar-operacao', { method: 'POST', body: '{}' });
  const r = await fetchCompartilhado('db/historico.json');
  assert.deepEqual(await r.json(), { versao: 3 });
  assert.equal(chamadas.filter(c => c.url.includes('historico')).length, 2);
});

test('leitura iniciada ANTES de um POST terminar não fica em cache', async () => {
  const { f, chamadas } = fakeFetch();
  const { fetchCompartilhado } = criarFetchCompartilhado(f, ORIGEM);
  const post = fetchCompartilhado('/salvar', { method: 'POST' });
  const leitura = fetchCompartilhado('db/historico.json');
  await Promise.all([post, leitura]);
  await fetchCompartilhado('db/historico.json');
  assert.equal(chamadas.filter(c => c.url.includes('historico')).length, 2);
});

test('rotas fora da lista, query diferente e pedidos com AbortSignal passam direto', async () => {
  const { f, chamadas } = fakeFetch();
  const { fetchCompartilhado } = criarFetchCompartilhado(f, ORIGEM);
  await Promise.all([fetchCompartilhado('db/operacao_andamento.json'), fetchCompartilhado('db/operacao_andamento.json')]);
  assert.equal(chamadas.length, 2);
  await Promise.all([fetchCompartilhado('db/historico.json?a=1'), fetchCompartilhado('db/historico.json?a=2')]);
  assert.equal(chamadas.length, 4);
  const ctrl = new AbortController();
  await Promise.all([fetchCompartilhado('db/paradas.json', { signal: ctrl.signal }), fetchCompartilhado('db/paradas.json', { signal: ctrl.signal })]);
  assert.equal(chamadas.length, 6);
});

test('resposta de erro não é reaproveitada', async () => {
  let n = 0;
  const f = () => Promise.resolve(new Response('x', { status: ++n === 1 ? 500 : 200 }));
  const { fetchCompartilhado } = criarFetchCompartilhado(f, ORIGEM);
  assert.equal((await fetchCompartilhado('db/historico.json')).status, 500);
  assert.equal((await fetchCompartilhado('db/historico.json')).status, 200);
});
