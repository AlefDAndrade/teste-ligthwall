// ─── test/db-sem-cache.test.js ──────────────────────────────────────────────
// Testa que qualquer arquivo servido sob /db/ (dado de produção —
// config.json, historico.json, etc.) vem SEMPRE com Cache-Control: no-store
// — ver conversa que motivou a mudança: reordenar Paletes em Configurações
// não aparecia nem com F5, só depois de logout+login, porque nada impedia
// o cache HTTP nativo do navegador de guardar uma cópia antiga de
// /db/config.json (o service worker já excluía '/db/' da PRÓPRIA camada
// de cache dele, mas isso não afeta o cache HTTP do navegador, uma camada
// separada). Arquivos fora de /db/ (ex: um .js qualquer) não precisam
// dessa garantia — o service worker (network-first) já cuida deles.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste();
});

after(async () => {
  await servidor.parar();
});

test('GET /db/config.json vem com Cache-Control: no-store', async () => {
  const resp = await fetch(`${servidor.baseUrl}/db/config.json`);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('cache-control'), 'no-store');
});

test('outro arquivo qualquer sob /db/ (ex: historico.json) também vem com no-store', async () => {
  const resp = await fetch(`${servidor.baseUrl}/db/historico.json`);
  // Pode não existir ainda numa instalação nova (404) — o que importa é
  // que QUALQUER resposta sob /db/, exista o arquivo ou não, carregue o
  // cabeçalho quando servida com sucesso; então também testamos um
  // arquivo que sabemos existir (config.json, acima) e confiamos no
  // prefixo genérico '/db/' do servidor (server.js) pra cobrir o resto.
  assert.ok(resp.status === 200 || resp.status === 404);
});

// ─── Regressão: rotas DINÂMICAS sob /db/ também precisam do header ────────
// historico.json, relatorio_injecao.json e avaliacoes_qualidade.json não
// são mais arquivo estático (ver Fases 2/5 do fatiamento, lib/rotas/
// consultas.js e lib/rotas/qualidade.js) — são reconstruídos do SQLite a
// cada chamada e respondem sozinhos, ANTES de chegar no fallback de
// arquivo estático que seta o header (mais abaixo em server.js). O teste
// acima ("outro arquivo qualquer...") não pegava isso porque só conferia
// o status, nunca o header — essas rotas ficaram sem Cache-Control por
// um bom tempo sem que nenhum teste acusasse. Sintoma real que motivou
// isso: corrigir a data de desmoldagem de uma avaliação já registrada
// atualizava Relatório/Dashboard na hora, mas o Debriefing continuava
// mostrando a data antiga mesmo fechando/reabrindo — o navegador
// reaproveitava a resposta em cache de /db/avaliacoes_qualidade.json em
// vez de ir à rede de novo.
test('rota DINÂMICA /db/historico.json (reconstruída do banco) vem com Cache-Control: no-store', async () => {
  const resp = await fetch(`${servidor.baseUrl}/db/historico.json`);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('cache-control'), 'no-store');
});

test('rota DINÂMICA /db/avaliacoes_qualidade.json vem com Cache-Control: no-store', async () => {
  const resp = await fetch(`${servidor.baseUrl}/db/avaliacoes_qualidade.json`);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('cache-control'), 'no-store');
});

test('rota DINÂMICA /db/relatorio_injecao.json vem com Cache-Control: no-store', async () => {
  const resp = await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`);
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('cache-control'), 'no-store');
});

test('um arquivo estático FORA de /db/ (ex: css/styles.css) não leva Cache-Control: no-store', async () => {
  const resp = await fetch(`${servidor.baseUrl}/css/styles.css`);
  assert.equal(resp.status, 200);
  assert.notEqual(resp.headers.get('cache-control'), 'no-store');
});