// ─── test/insumos-dinamicos-fase6.test.js ───────────────────────────────────
// Fase 6 de "Insumos de Receitas dinâmicos no formulário de traço" (ver
// PLANO-insumos-dinamicos-receitas.md) — consumidores derivados. Este
// arquivo cobre o backend (`detalheOperacao`, lib/db/operacoes-qualidade.js
// — usado pela Análise Focada, público em GET /db/detalhe_operacao.json):
// os 5 Padrão continuam vindo em `traco.original` como sempre (colunas
// fixas, inalteradas); insumos Custom aparecem em `traco.insumos_custom`
// (originais) e `ajuste.insumos_custom` (por ajuste).
//
// Os consumidores puramente de RENDER (bateria-atual.js, consulta-
// tracos.js, analise-focada.js) só espalham esses mesmos campos num grid
// já existente (mesmo padrão testado à exaustão nas Fases 2/3/5 — sem
// lógica nova de cálculo) — o risco real está no SQL novo deste arquivo,
// por isso o foco do teste é aqui.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-insumos-fase6-951';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let cookie;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
  });
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  cookie = (resp.headers.get('set-cookie') || '').split(';')[0];
});

after(async () => {
  await servidor.parar();
});

function traco(idTraco, idOperacao, extras = {}) {
  return {
    id_traco: idTraco, data: '2026-08-20', turno: '1° TURNO', num_traco: 1,
    cimento_real: 350, agua_real: 180, eps_real: 2.5, superplast_real: 4, incorporador_real: 1,
    tempo_batida: 120, densidade: 1050, flow: 210,
    obs: null, silo: 'S1', expansao: null, densidade_eps: null,
    ultilizado: { operacao: [{ id_operacao: idOperacao, id_bateria: 'B-fase6', berco_inicio: '1', berco_finalizacao: '4' }] },
    ...extras,
  };
}

function registrarTraco(t) {
  return fetch(`${servidor.baseUrl}/registrar-relatorio-injecao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify([t]),
  });
}

function registrarAjuste(idTraco, ajuste) {
  return fetch(`${servidor.baseUrl}/registrar-ajuste-traco`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id_traco: idTraco, ajuste }),
  });
}

async function buscarDetalheOperacao(idOperacao) {
  const resp = await fetch(`${servidor.baseUrl}/db/detalhe_operacao.json?id=${idOperacao}`);
  assert.equal(resp.status, 200);
  return resp.json();
}

// detalheOperacao() (lib/db/operacoes-qualidade.js) parte da tabela
// "operacoes" — /registrar-relatorio-injecao só grava "tracos"/
// "traco_usos" (a operação em si é criada por outra rota, do fluxo de
// Registrar Operação completo, fora do escopo deste teste). Insere a
// linha mínima direto no SQLite da instância de teste, mesmo padrão de
// test/insumos-dinamicos-migracao.test.js.
function criarOperacaoMinima(idOperacao) {
  const db = new Database(path.join(servidor.pastaTemp, 'data', 'lightwall.sqlite'));
  try {
    db.prepare('INSERT INTO operacoes (id, data) VALUES (?, ?)').run(idOperacao, '2026-08-20');
  } finally {
    db.close();
  }
}

test('detalheOperacao: traço com insumo Custom (original + 1 ajuste) — Padrão intocado, Custom nas duas pontas', async () => {
  const idTraco = 'traco-fase6-' + Date.now();
  const idOperacao = 'op-fase6-' + Date.now();
  criarOperacaoMinima(idOperacao);

  await registrarAjuste(idTraco, { tempo_batida: 5, cimento: 10, insumos_custom: { 'Fibra': 0.7 } });
  const resp = await registrarTraco(traco(idTraco, idOperacao, { insumos_custom: { 'Fibra': 3.2 } }));
  assert.equal(resp.status, 200);

  const detalhe = await buscarDetalheOperacao(idOperacao);
  assert.equal(detalhe.tracos.length, 1);
  const t = detalhe.tracos[0];

  // 5 Padrão continuam exatamente como sempre — colunas fixas, sem
  // nenhuma mudança de formato.
  assert.equal(t.original.cimento, 350);
  assert.equal(t.original.agua, 180);

  // Custom "original" do traço.
  assert.deepEqual(t.insumos_custom, { 'Fibra': 3.2 });

  // Custom do ajuste ao vivo.
  assert.equal(t.ajustes.length, 1);
  assert.equal(t.ajustes[0].cimento, 10, 'ajuste de Padrão continua no formato de sempre');
  assert.deepEqual(t.ajustes[0].insumos_custom, { 'Fibra': 0.7 });
  assert.equal('id' in t.ajustes[0], false, 'campo interno "id" (usado só pra achar ajuste_insumos) não deveria vazar na saída');
});

test('detalheOperacao: traço SEM nenhum insumo Custom não ganha a chave insumos_custom (nem no traço, nem nos ajustes)', async () => {
  const idTraco = 'traco-fase6-sem-custom-' + Date.now();
  const idOperacao = 'op-fase6-sem-custom-' + Date.now();
  criarOperacaoMinima(idOperacao);

  await registrarAjuste(idTraco, { tempo_batida: 5, agua: 2 }); // ajuste normal, sem custom
  await registrarTraco(traco(idTraco, idOperacao));

  const detalhe = await buscarDetalheOperacao(idOperacao);
  const t = detalhe.tracos[0];
  assert.equal('insumos_custom' in t, false, 'traço sem Custom não deveria ganhar a chave');
  assert.equal(t.ajustes.length, 1);
  assert.equal('insumos_custom' in t.ajustes[0], false, 'ajuste sem Custom não deveria ganhar a chave');
});

test('detalheOperacao: 2 insumos Custom diferentes no mesmo traço, cada um em seu próprio ajuste', async () => {
  const idTraco = 'traco-fase6-dois-custom-' + Date.now();
  const idOperacao = 'op-fase6-dois-custom-' + Date.now();
  criarOperacaoMinima(idOperacao);

  await registrarAjuste(idTraco, { tempo_batida: 3, insumos_custom: { 'Fibra': 0.4 } });
  await registrarAjuste(idTraco, { tempo_batida: 2, insumos_custom: { 'Aditivo Y': 0.1 } });
  await registrarTraco(traco(idTraco, idOperacao, { insumos_custom: { 'Fibra': 1, 'Aditivo Y': 2 } }));

  const detalhe = await buscarDetalheOperacao(idOperacao);
  const t = detalhe.tracos[0];
  assert.deepEqual(t.insumos_custom, { 'Fibra': 1, 'Aditivo Y': 2 });
  assert.equal(t.ajustes.length, 2);
  assert.deepEqual(t.ajustes[0].insumos_custom, { 'Fibra': 0.4 });
  assert.deepEqual(t.ajustes[1].insumos_custom, { 'Aditivo Y': 0.1 });
});
