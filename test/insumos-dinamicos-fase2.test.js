// ─── test/insumos-dinamicos-fase2.test.js ───────────────────────────────────
// Fase 2 de "Insumos de Receitas dinâmicos no formulário de traço" (ver
// PLANO-insumos-dinamicos-receitas.md) — leitura/escrita de insumos CUSTOM
// via traco_insumos/ajuste_insumos (lib/db/tracos.js:
// salvarInsumosCustomDoTraco/salvarInsumosCustomDoAjuste/rowParaTraco).
//
// Escopo re-definido antes desta fase: os 5 insumos Padrão continuam só
// nas colunas fixas de sempre (cimento_real/agua_real/etc), sem nenhuma
// mudança — cobertos à exaustão pelos testes já existentes
// (registrar-relatorio-injecao.test.js, mesclar-backup-dados.test.js,
// backup-dados-vs-geral.test.js). Este arquivo cobre só o caminho NOVO:
// o campo opcional `insumos_custom` no JSON de um traço/ajuste.
//
// Cobre:
//   1. POST /restaurar-backup-dados com um traço trazendo insumos_custom
//      (original) + ajustes_tracos.json com um ajuste também trazendo
//      insumos_custom -> GET /db/relatorio_injecao.json devolve o mesmo
//      formato original/ajustes de sempre (colapsarOriginalEAjustes), só
//      que dentro de insumos_custom.
//   2. O mesmo dado aparece em GET /db/ajustes_tracos.json, no ajuste
//      correspondente.
//   3. Um traço SEM nenhum insumo custom não ganha a chave insumos_custom
//      no JSON (não polui o formato de quem não usa a feature).
//   4. POST /mesclar-backup-dados com insumos_custom soma corretamente,
//      preservando o dado no id_traco sintético gerado pela mesclagem.
//   5. Um nome de insumo que colide com um dos 5 Padrão (payload malformado
//      ou de origem inconsistente) é ignorado na gravação de insumos_custom
//      — Padrão nunca é lido/gravado por este caminho.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-insumos-fase2-812';
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

const ARQUIVOS_DADOS_MINIMOS = {
  'config.json': JSON.stringify({ baterias: { ids: [] }, tipos_montagem: { opcoes: [] } }),
  'historico.json': '[]',
  'historico_edicoes.json': '[]',
  'relatorio_edicoes.json': '[]',
  'contador_tracos.json': '{}',
  'sobra.json': '{}',
  'paradas.json': '[]',
  'metas.json': '{}',
  'bercos_visuais.json': '[]',
  'avaliacoes_qualidade.json': '[]',
  'operacoes_avaliadas.json': '[]',
  'operacoes_nao_avaliadas.json': '[]',
};

async function restaurarBackupDados(relatorioInjecao, ajustesTracos) {
  return fetch(`${servidor.baseUrl}/restaurar-backup-dados`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      senha: SENHA_ADMIN,
      arquivos: {
        ...ARQUIVOS_DADOS_MINIMOS,
        'relatorio_injecao.json': JSON.stringify(relatorioInjecao),
        'ajustes_tracos.json': JSON.stringify(ajustesTracos),
      },
    }),
  });
}

async function buscarTracos() {
  return (await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`)).json();
}

async function buscarAjustesTracosJSON() {
  return (await fetch(`${servidor.baseUrl}/db/ajustes_tracos.json`)).json();
}

test('traço restaurado com insumos_custom (original + ajuste) round-tripa corretamente', async () => {
  const idTraco = 'traco-fase2-' + Date.now();

  const resp = await restaurarBackupDados(
    [{
      id_traco: idTraco, data: '2026-08-01', turno: '1° TURNO', num_traco: 1,
      cimento_real: 350, agua_real: 180, eps_real: 1, superplast_real: 4, incorporador_real: 1,
      tempo_batida: 120, densidade: 1050, flow: 210, obs: null,
      ultilizado: { operacao: [] },
      insumos_custom: { 'Fibra': 2.5 },
    }],
    [{
      id_traco: idTraco,
      ajuste_1: {
        tempo_batida: 5, cimento: 10, registrado_em: new Date().toISOString(),
        insumos_custom: { 'Fibra': 0.5 },
      },
    }],
  );
  assert.equal(resp.status, 200);

  const tracos = await buscarTracos();
  const traco = tracos.find(t => t.id_traco === idTraco);
  assert.ok(traco, 'traço deveria existir após restaurar');
  assert.deepEqual(traco.insumos_custom, { 'Fibra': { original: 2.5, ajustes: [0.5] } });
  // Padrão continua exatamente no formato de sempre, sem nenhuma mudança.
  assert.equal(traco.cimento_real.original, 350);
  assert.deepEqual(traco.cimento_real.ajustes, [10]);

  const ajustesJSON = await buscarAjustesTracosJSON();
  const entradaAjuste = ajustesJSON.find(a => a.id_traco === idTraco);
  assert.ok(entradaAjuste, 'entrada de ajustes deveria existir');
  assert.deepEqual(entradaAjuste.ajuste_1.insumos_custom, { 'Fibra': 0.5 });
});

test('traço sem nenhum insumo custom não ganha a chave insumos_custom no JSON', async () => {
  const idTraco = 'traco-fase2-sem-custom-' + Date.now();

  const resp = await restaurarBackupDados(
    [{
      id_traco: idTraco, data: '2026-08-01', turno: '1° TURNO', num_traco: 2,
      cimento_real: 350, agua_real: 180, eps_real: 1, superplast_real: 4, incorporador_real: 1,
      tempo_batida: 120, densidade: 1050, flow: 210, obs: null,
      ultilizado: { operacao: [] },
    }],
    [],
  );
  assert.equal(resp.status, 200);

  const tracos = await buscarTracos();
  const traco = tracos.find(t => t.id_traco === idTraco);
  assert.ok(traco);
  assert.equal('insumos_custom' in traco, false);
});

test('insumo custom com nome igual a um Padrão (payload malformado) é ignorado na gravação', async () => {
  const idTraco = 'traco-fase2-colisao-padrao-' + Date.now();

  const resp = await restaurarBackupDados(
    [{
      id_traco: idTraco, data: '2026-08-01', turno: '1° TURNO', num_traco: 3,
      cimento_real: 350, agua_real: 180, eps_real: 1, superplast_real: 4, incorporador_real: 1,
      tempo_batida: 120, densidade: 1050, flow: 210, obs: null,
      ultilizado: { operacao: [] },
      insumos_custom: { 'Cimento': 999, 'Fibra': 3 }, // "Cimento" é Padrão — não deveria gravar aqui
    }],
    [],
  );
  assert.equal(resp.status, 200);

  const tracos = await buscarTracos();
  const traco = tracos.find(t => t.id_traco === idTraco);
  // "Cimento" custom foi ignorado — só "Fibra" aparece em insumos_custom.
  // Sem ajuste pra "Fibra", colapsarOriginalEAjustes devolve o número puro
  // (mesmo comportamento dos 5 Padrão sem ajuste — ver cimento_real abaixo).
  assert.deepEqual(traco.insumos_custom, { 'Fibra': 3 });
  // E o Cimento Padrão de verdade continua vindo só da coluna fixa (350),
  // nunca sobrescrito pelo 999 do insumos_custom malformado.
  assert.equal(traco.cimento_real, 350);
});

test('mesclar backup com insumos_custom soma corretamente, preservando o dado no id_traco sintético', async () => {
  const idTracoOrigem = 'traco-origem-mesclar-fase2-' + Date.now();

  const resp = await fetch(`${servidor.baseUrl}/mesclar-backup-dados`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      senha: SENHA_ADMIN,
      arquivos: {
        'relatorio_injecao.json': JSON.stringify([{
          id_traco: idTracoOrigem, data: '2026-08-02', turno: '2° TURNO', num_traco: 9,
          cimento_real: 10, agua_real: 4, eps_real: 2, superplast_real: 0.5, incorporador_real: 0.2,
          tempo_batida: 120, densidade: 30, flow: 600,
          ultilizado: { operacao: [] },
          insumos_custom: { 'Aditivo X': 1.2 },
        }]),
        'ajustes_tracos.json': '[]',
      },
    }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);

  const tracos = await buscarTracos();
  // O id_traco no destino é SINTÉTICO (merge_traco_...), não o de origem —
  // acha pela chave natural (data+num_traco), mesmo padrão do resto da
  // suíte de mesclagem.
  const traco = tracos.find(t => t.data === '2026-08-02' && t.num_traco === 9);
  assert.ok(traco, 'traço mesclado deveria existir no destino');
  // Sem ajuste, número puro — mesmo comportamento do teste anterior.
  assert.deepEqual(traco.insumos_custom, { 'Aditivo X': 1.2 });
});
