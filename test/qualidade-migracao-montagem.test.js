// ─── test/qualidade-migracao-montagem.test.js ───────────────────────────────
// Testa a migração que recalcula avaliacao.montagem (colunas Pallet 1..4 da
// tela "Registros") a partir dos painéis DE VERDADE de avaliações JÁ
// REGISTRADAS (ver conversa que motivou isso — usuário mandou um backup de
// produção com um registro em modo Personalizada, tipos 3T/1T, mostrando
// só "—" nas colunas de pallet, mesmo já tendo a correção que calcula isso
// certo para registros NOVOS).
//
// _migrarMontagemDasAvaliacoesExistentes (db.js) roda: (a) uma vez na
// subida do servidor, e (b) logo depois de um restore de backup
// (substituirAvaliacoesQualidade) — sem precisar esperar o próximo
// reinício pra já corrigir os registros de um backup restaurado.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-migracao-montagem-852';
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

async function logarComoAdminMaster() {
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  return (resp.headers.get('set-cookie') || '').split(';')[0] || null;
}

function painel(pallet, posicao, tipoEsperado) {
  return {
    pallet, posicao, tipoEsperado, tipoObtido: tipoEsperado, resultado: 'aprovado', linha: '1ª',
    marcas: [{ shape: 'dash', color: 'verde' }], motivo: null, motivoDescricao: null,
  };
}

test('restaurar um backup com uma avaliação "Personalizada" (montagem vazia, tipos mistos nos painéis) corrige montagem.palletN sozinho', async () => {
  const cookie = await logarComoAdminMaster();

  // Simula exatamente o defeito real: uma avaliação já registrada, com
  // montagem.palletN vazio (como ficava salvo em modo Personalizada,
  // antes da correção), mas com os painéis já carregando o tipo de
  // verdade — pallet 1 todo 3T, pallet 2 todo 1T.
  const avaliacaoComDefeito = {
    id: 'ev-migracao-1', schemaVersion: 2, batteryId: 'B4-migracao',
    linkedOperacaoId: null,
    montagem: { pallet1: '', pallet2: '', pallet3: '', pallet4: '' },
    turno: '1° TURNO', tempInput: 39,
    dtMontagem: '2026-07-01T10:00:00.000Z', dtEnchimento: '2026-07-01T10:30:00.000Z', dtDesmoldagem: '2026-07-01T12:00:00.000Z',
    registeredAt: '2026-07-01T12:05:00.000Z',
    totalSlabs: 8, observations: '',
    paineis: [
      painel(1, 1, '3T'), painel(1, 2, '3T'),
      painel(2, 1, '1T'), painel(2, 2, '1T'),
    ],
  };

  const arquivos = {
    'config.json': JSON.stringify({ baterias: { ids: [] }, tipos_montagem: { opcoes: [] } }),
    'historico.json': '[]',
    'historico_edicoes.json': '[]',
    'relatorio_edicoes.json': '[]',
    'relatorio_injecao.json': '[]',
    'contador_tracos.json': '{}',
    'sobra.json': '{}',
    'paradas.json': '[]',
    'ajustes_tracos.json': '[]',
    'avaliacoes_qualidade.json': JSON.stringify([avaliacaoComDefeito]),
  };

  const respRestaurar = await fetch(`${servidor.baseUrl}/restaurar-backup-dados`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN, arquivos }),
  });
  assert.equal(respRestaurar.status, 200, await respRestaurar.text());

  // Sem precisar reiniciar o servidor — a migração já deveria ter
  // corrigido isso como parte do próprio restore.
  const respAvals = await fetch(`${servidor.baseUrl}/avaliacoes-qualidade`);
  const avals = await respAvals.json();
  const corrigida = avals.find(a => a.id === 'ev-migracao-1');
  assert.ok(corrigida, 'avaliação deveria continuar existindo depois do restore');
  assert.equal(corrigida.montagem.pallet1, '3T', 'pallet1 deveria ter sido corrigido pra "3T" (calculado a partir dos painéis)');
  assert.equal(corrigida.montagem.pallet2, '1T', 'pallet2 deveria ter sido corrigido pra "1T"');
  assert.equal(corrigida.montagem.pallet3, '', 'pallet3 sem painéis continua vazio (não tem o que calcular)');
});

test('avaliação já com montagem correta (tipo uniforme) não é alterada pela migração', async () => {
  const avaliacaoOk = {
    id: 'ev-migracao-2', schemaVersion: 2, batteryId: 'B7-migracao',
    linkedOperacaoId: null,
    montagem: { pallet1: 'SP', pallet2: 'SP', pallet3: 'SP', pallet4: 'SP' },
    turno: '1° TURNO', tempInput: 39,
    dtMontagem: '2026-07-01T10:00:00.000Z', dtEnchimento: '2026-07-01T10:30:00.000Z', dtDesmoldagem: '2026-07-01T12:00:00.000Z',
    registeredAt: '2026-07-01T12:05:00.000Z',
    totalSlabs: 4, observations: '',
    paineis: [painel(1, 1, 'SP'), painel(2, 1, 'SP'), painel(3, 1, 'SP'), painel(4, 1, 'SP')],
  };

  const arquivos = {
    'config.json': JSON.stringify({ baterias: { ids: [] }, tipos_montagem: { opcoes: [] } }),
    'historico.json': '[]',
    'historico_edicoes.json': '[]',
    'relatorio_edicoes.json': '[]',
    'relatorio_injecao.json': '[]',
    'contador_tracos.json': '{}',
    'sobra.json': '{}',
    'paradas.json': '[]',
    'ajustes_tracos.json': '[]',
    'avaliacoes_qualidade.json': JSON.stringify([avaliacaoOk]),
  };

  const resp = await fetch(`${servidor.baseUrl}/restaurar-backup-dados`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN, arquivos }),
  });
  assert.equal(resp.status, 200);

  const respAvals = await fetch(`${servidor.baseUrl}/avaliacoes-qualidade`);
  const avals = await respAvals.json();
  const av = avals.find(a => a.id === 'ev-migracao-2');
  assert.deepEqual(av.montagem, { pallet1: 'SP', pallet2: 'SP', pallet3: 'SP', pallet4: 'SP' });
});
