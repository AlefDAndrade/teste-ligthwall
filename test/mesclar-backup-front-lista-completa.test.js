// ─── test/mesclar-backup-front-lista-completa.test.js ───────────────────────
// Bug real (conversa que motivou): "os dados mesclados não mostram os
// berços visuais em Análise Focada, fica aparecendo que não tem berço
// visual" — a causa não era o backend (que já suportava mesclar
// bercos_visuais.json e os outros 5 domínios "satélite"), era o FRONT:
// `MESCLAR_VALIDACOES` (public/js/app-core.js) tem sua PRÓPRIA lista de
// quais arquivos ler do .zip antes de mandar pro servidor — essa lista
// nunca tinha sido atualizada (nem quando os 6 domínios satélite foram
// adicionados, nem antes disso: tracos_descartados.json também estava
// faltando). O arquivo simplesmente nunca saía do .zip.
//
// Este teste trava as DUAS pontas ficarem sincronizadas — extrai as
// chaves de MESCLAR_VALIDACOES/MESCLAR_DEFAULT_SE_VAZIO/MESCLAR_LABELS
// (app-core.js) e de MESCLAVEIS (lib/rotas/backup.js) e confere que são
// exatamente o mesmo conjunto, nos dois sentidos — pra este bug nunca
// mais acontecer silenciosamente (um dos dois lados ganhar um domínio
// novo sem o outro acompanhar).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_CORE = fs.readFileSync(path.join(__dirname, '..', 'public/js/app-core.js'), 'utf8');
const BACKUP_JS = fs.readFileSync(path.join(__dirname, '..', 'lib/rotas/backup.js'), 'utf8');

/** Extrai as chaves "'nome.json':" de dentro de um objeto JS, dado o
 * texto entre `const NOME = {` e o `}` de fechamento — evita precisar de
 * um parser JS de verdade só pra ler uma lista de chaves conhecida. */
function extrairChavesDoObjeto(codigo, nomeConst) {
  const inicio = codigo.indexOf(`const ${nomeConst} = {`);
  assert.ok(inicio >= 0, `não encontrei "const ${nomeConst} = {" `);
  const fim = codigo.indexOf('\n    };', inicio);
  const bloco = codigo.slice(inicio, fim >= 0 ? fim : codigo.indexOf('\n  };', inicio));
  const chaves = [...bloco.matchAll(/'([a-z_]+\.json)':/g)].map(m => m[1]);
  assert.ok(chaves.length > 0, `não encontrei nenhuma chave dentro de ${nomeConst}`);
  return new Set(chaves);
}

/** MESCLAVEIS (backend) é um array, não um objeto — formato diferente. */
function extrairArrayMesclaveis(codigo) {
  const inicio = codigo.indexOf('const MESCLAVEIS = [');
  assert.ok(inicio >= 0, 'não encontrei "const MESCLAVEIS = [" em lib/rotas/backup.js');
  const fim = codigo.indexOf('];', inicio);
  const bloco = codigo.slice(inicio, fim);
  const chaves = [...bloco.matchAll(/'([a-z_]+\.json)'/g)].map(m => m[1]);
  assert.ok(chaves.length > 0, 'não encontrei nenhum item dentro de MESCLAVEIS');
  return new Set(chaves);
}

test('MESCLAR_VALIDACOES (front) e MESCLAVEIS (backend) cobrem exatamente o mesmo conjunto de arquivos', () => {
  const doFront = extrairChavesDoObjeto(APP_CORE, 'MESCLAR_VALIDACOES');
  const doBackend = extrairArrayMesclaveis(BACKUP_JS);

  const soNoFront = [...doFront].filter(k => !doBackend.has(k));
  const soNoBackend = [...doBackend].filter(k => !doFront.has(k));

  assert.deepEqual(soNoFront, [], 'MESCLAR_VALIDACOES (front) tem arquivo(s) que o backend não aceita mesclar');
  assert.deepEqual(soNoBackend, [], 'o backend aceita mesclar arquivo(s) que o front nunca lê do .zip — MESMO BUG desta conversa (berços visuais)');
});

test('MESCLAR_DEFAULT_SE_VAZIO e MESCLAR_LABELS têm entrada pra TODO arquivo de MESCLAR_VALIDACOES (nenhum esquecido pela metade)', () => {
  const validacoes = extrairChavesDoObjeto(APP_CORE, 'MESCLAR_VALIDACOES');
  const defaults = extrairChavesDoObjeto(APP_CORE, 'MESCLAR_DEFAULT_SE_VAZIO');
  const labels = extrairChavesDoObjeto(APP_CORE, 'MESCLAR_LABELS');

  for (const chave of validacoes) {
    assert.ok(defaults.has(chave), `MESCLAR_DEFAULT_SE_VAZIO não tem "${chave}"`);
    assert.ok(labels.has(chave), `MESCLAR_LABELS não tem "${chave}"`);
  }
});

test('os 7 arquivos que estavam faltando nesta conversa (berços visuais e companhia) agora aparecem nas 3 listas do front', () => {
  const chavesEsperadas = [
    'tracos_descartados.json', 'bercos_visuais.json', 'avaliacoes_qualidade.json',
    'operacoes_avaliadas.json', 'relatorio_edicoes.json', 'manutencao_corretiva.json', 'manutencao_programada.json',
  ];
  const validacoes = extrairChavesDoObjeto(APP_CORE, 'MESCLAR_VALIDACOES');
  for (const chave of chavesEsperadas) {
    assert.ok(validacoes.has(chave), `esperava "${chave}" em MESCLAR_VALIDACOES (front) — sem isso o arquivo nunca sai do .zip`);
  }
});
