// ─── test/backup-metas-opcional.test.js ─────────────────────────────────────
// Testa que metas.json NÃO é mais obrigatório ao restaurar um Backup de
// Dados (nem Backup Geral) — pedido do usuário: "metas está como arquivo
// obrigatório no backup? Se sim, ela não precisa ser." Antes desta
// correção, um backup sem metas.json (ex: gerado antes dessa funcionalidade
// existir, ou de uma instalação sem metas configuradas ainda) era recusado
// inteiro com "Backup incompleto — faltam: metas.json".

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-metas-opcional-321';
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

// Mesmo conjunto mínimo de test/backup-dados-vs-geral.test.js, MENOS
// metas.json — de propósito, é o que este teste quer provar que não faz
// mais falta.
const ARQUIVOS_SEM_METAS = {
  'config.json': JSON.stringify({ baterias: { ids: [] }, tipos_montagem: { opcoes: [] } }),
  'historico.json': '[]',
  'historico_edicoes.json': '[]',
  'relatorio_edicoes.json': '[]',
  'relatorio_injecao.json': '[]',
  'contador_tracos.json': '{}',
  'sobra.json': '{}',
  'paradas.json': '[]',
  'ajustes_tracos.json': '[]',
  'bercos_visuais.json': '[]',
  'avaliacoes_qualidade.json': '[]',
  'operacoes_avaliadas.json': '[]',
  'operacoes_nao_avaliadas.json': '[]',
};

async function logarComoAdminMaster() {
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  return (resp.headers.get('set-cookie') || '').split(';')[0] || null;
}

test('restaurar Backup de Dados SEM metas.json não é mais recusado como incompleto', async () => {
  const resp = await fetch(`${servidor.baseUrl}/restaurar-backup-dados`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN, arquivos: ARQUIVOS_SEM_METAS }),
  });
  const data = await resp.json();
  assert.equal(resp.status, 200, `esperava 200, veio ${resp.status} — ${JSON.stringify(data)}`);
  assert.equal(data.ok, true);
  assert.ok(data.backupSeguranca);
});

test('restaurar Backup Geral SEM metas.json também não é mais recusado como incompleto', async () => {
  const arquivosGeral = {
    ...ARQUIVOS_SEM_METAS,
    'security.json': JSON.stringify({ passwordHash: HASH_ADMIN, recoveryKeyHash: null }),
    'usuarios.json': '[]',
  };
  const resp = await fetch(`${servidor.baseUrl}/restaurar-backup-geral`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN, confirmacao: 'RESTAURAR TUDO', arquivos: arquivosGeral }),
  });
  const data = await resp.json();
  assert.equal(resp.status, 200, `esperava 200, veio ${resp.status} — ${JSON.stringify(data)}`);
  assert.equal(data.ok, true);
});
