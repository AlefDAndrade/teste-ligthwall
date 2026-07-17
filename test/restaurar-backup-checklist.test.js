// ─── test/restaurar-backup-checklist.test.js ────────────────────────────────
// Testa o checklist visual de restauração de backup (ver conversa que
// motivou isso): "quero que apareça uma lista de todos os arquivos de
// dados, um visto (✅) ao lado das que sofreram [restauração] e um x (❌)
// ao lado das que não receberam nenhuma mudança" — POST
// /restaurar-backup-dados e /restaurar-backup-geral agora devolvem
// `arquivos: [{ nome, restaurado }, ...]` com TODOS os arquivos esperados,
// não só os que vieram no payload.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-checklist-restauracao-456';
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

// Só os OBRIGATÓRIOS do Backup de Dados — de propósito SEM metas.json,
// avaliacoes_qualidade.json, manutencao_corretiva.json etc. (todos
// opcionais), pra confirmar que eles aparecem no checklist como
// "restaurado: false", em vez de travar a restauração ou simplesmente
// não aparecerem na lista.
const ARQUIVOS_SO_OBRIGATORIOS = {
  'config.json': JSON.stringify({ baterias: { ids: [] }, tipos_montagem: { opcoes: [] } }),
  'historico.json': '[]',
  'historico_edicoes.json': '[]',
  'relatorio_edicoes.json': '[]',
  'relatorio_injecao.json': '[]',
  'contador_tracos.json': '{}',
  'sobra.json': '{}',
  'paradas.json': '[]',
  'ajustes_tracos.json': '[]',
};

test('POST /restaurar-backup-dados devolve checklist com TODOS os arquivos esperados, marcando os ausentes como restaurado:false', async () => {
  const resp = await fetch(`${servidor.baseUrl}/restaurar-backup-dados`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN, arquivos: ARQUIVOS_SO_OBRIGATORIOS }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.ok(Array.isArray(data.arquivos), 'resposta deveria ter um array "arquivos"');

  const porNome = Object.fromEntries(data.arquivos.map(a => [a.nome, a.restaurado]));

  // Enviados no payload — deveriam vir marcados como restaurado.
  assert.equal(porNome['historico.json'], true);
  assert.equal(porNome['paradas.json'], true);
  assert.equal(porNome['ajustes_tracos.json'], true);

  // NÃO enviados (opcionais) — deveriam aparecer na lista mesmo assim,
  // marcados como NÃO restaurados.
  assert.equal(porNome['metas.json'], false, 'metas.json não foi enviado — deveria aparecer como restaurado:false, não sumir da lista');
  assert.equal(porNome['avaliacoes_qualidade.json'], false);
  assert.equal(porNome['operacoes_avaliadas.json'], false);
  assert.equal(porNome['operacoes_nao_avaliadas.json'], false);
  assert.equal(porNome['manutencao_corretiva.json'], false);
  assert.equal(porNome['manutencao_programada.json'], false);
  assert.equal(porNome['bercos_visuais.json'], false);
});

test('POST /restaurar-backup-dados: enviando metas.json de verdade, ele aparece como restaurado:true', async () => {
  const arquivos = { ...ARQUIVOS_SO_OBRIGATORIOS, 'metas.json': '{}' };
  const resp = await fetch(`${servidor.baseUrl}/restaurar-backup-dados`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN, arquivos }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  const porNome = Object.fromEntries(data.arquivos.map(a => [a.nome, a.restaurado]));
  assert.equal(porNome['metas.json'], true);
});

test('POST /restaurar-backup-geral devolve checklist incluindo os 3 arquivos extra (config/security/usuarios)', async () => {
  const arquivos = {
    ...ARQUIVOS_SO_OBRIGATORIOS,
    'security.json': JSON.stringify({ passwordHash: HASH_ADMIN, recoveryKeyHash: null }),
    'usuarios.json': '[]',
  };
  const resp = await fetch(`${servidor.baseUrl}/restaurar-backup-geral`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN, confirmacao: 'RESTAURAR TUDO', arquivos }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.ok(Array.isArray(data.arquivos));

  const porNome = Object.fromEntries(data.arquivos.map(a => [a.nome, a.restaurado]));
  assert.equal(porNome['config.json'], true);
  assert.equal(porNome['security.json'], true);
  assert.equal(porNome['usuarios.json'], true);
  assert.equal(porNome['metas.json'], false, 'metas.json não enviado, deveria aparecer como restaurado:false também no Backup Geral');
});
