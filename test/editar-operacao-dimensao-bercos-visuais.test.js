// ─── test/editar-operacao-dimensao-bercos-visuais.test.js ───────────────────
// Pedido do usuário: em Editar Operação (Registro de Bateria) passa a dar
// pra (1) editar a Dimensão manualmente — com override do número de
// berços quando isso muda a capacidade — e (2) editar retroativamente os
// berços marcados como Vazou/Não Enchido (bercos_visuais), antes só
// possível AO VIVO (ver bateria-atual.js). Ver lib/rotas/edicao.js:
//   - POST /editar-operacao passa a aceitar "capacidade"/"dimensao"
//     livres em novosValores (já não eram protegidos) e um campo opcional
//     "bercosVisuais" (grava em bercos_visuais, tabela à parte).
//   - GET /bercos-visuais-operacao/:id — lê o que já está marcado.
//
// Roda contra o server.js DE VERDADE, numa cópia isolada — mesmo padrão
// de editar-operacao-avancado.test.js. Checagem de permissão (403) já
// coberta em test/permissoes-por-area.test.js — aqui é só o caminho feliz
// e as validações específicas destes 2 pontos.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-eo-dimensao-bercos-visuais-364';
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

function registrarOperacao(idOp, extras = {}) {
  return fetch(`${servidor.baseUrl}/registrar-operacao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: idOp, data: '2026-07-20', turno: '1° TURNO', dimensao: '9 cm', capacidade: 20,
      id_bateria: 'B-original', tipo_montagem: 'S/P',
      inicio: '2026-07-20T08:00:00.000Z', fim: '2026-07-20T09:00:00.000Z',
      tempo_min: 60, qtd_tracos: 3, total_paineis: 40, m2_total: 88.8,
      ...extras,
    }),
  });
}

function editarOperacao(payload) {
  return fetch(`${servidor.baseUrl}/editar-operacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(payload),
  });
}

async function buscarOperacao(idOp) {
  const resp = await fetch(`${servidor.baseUrl}/db/historico.json`);
  const historico = await resp.json();
  return historico.find(o => o.id === idOp);
}

function buscarBercosVisuais(idOp) {
  return fetch(`${servidor.baseUrl}/bercos-visuais-operacao/${idOp}`, { headers: { Cookie: cookie } })
    .then(r => r.json());
}

// ═══════════════════════ DIMENSÃO / CAPACIDADE (override) ═══════════════════

test('editar-operacao: dimensão manual + capacidade (nº de berços) customizados são gravados', async () => {
  const idOp = 'op-eo-dim-bercos-' + Date.now();
  await registrarOperacao(idOp);

  const resp = await editarOperacao({
    id: idOp,
    novosValores: { dimensao: '7,5 cm', capacidade: 8, total_paineis: 16, m2_total: 29.28 },
    diff: [
      { campo: 'dimensao', de: '9 cm', para: '7,5 cm' },
      { campo: 'capacidade', de: 20, para: 8 },
    ],
  });
  assert.equal(resp.status, 200);
  const json = await resp.json();
  assert.equal(json.ok, true);

  const operacao = await buscarOperacao(idOp);
  assert.equal(operacao.dimensao, '7,5 cm');
  assert.equal(operacao.capacidade, 8);
  assert.equal(operacao.total_paineis, 16);
});

// ═══════════════════════════ BERÇOS VISUAIS ═════════════════════════════════

test('GET /bercos-visuais-operacao/:id: operação recém-registrada já nasce com todos os berços "okay" (ver criarBercosVisuaisIniciais, POST /registrar-operacao)', async () => {
  const idOp = 'op-eo-bv-vazio-' + Date.now();
  await registrarOperacao(idOp); // capacidade: 20, ver registrarOperacao acima

  const json = await buscarBercosVisuais(idOp);
  assert.equal(json.ok, true);
  assert.equal(json.bercos.length, 20);
  assert.ok(json.bercos.every(b => b.estado_esquerda === 'okay' && b.estado_direita === 'okay'));
});

test('GET /bercos-visuais-operacao/:id: id de operação inexistente retorna lista vazia (nunca teve linha em bercos_visuais)', async () => {
  const json = await buscarBercosVisuais('op-que-nunca-existiu-' + Date.now());
  assert.equal(json.ok, true);
  assert.deepEqual(json.bercos, []);
});

test('editar-operacao: bercosVisuais grava em bercos_visuais e fica visível em GET /bercos-visuais-operacao', async () => {
  const idOp = 'op-eo-bv-grava-' + Date.now();
  await registrarOperacao(idOp);

  const bercosVisuais = [
    { berco: 'B1', ordem: 1, estado_esquerda: 'baixou', estado_direita: 'okay' },
    { berco: 'B2', ordem: 2, estado_esquerda: 'okay', estado_direita: 'nao_enchido' },
  ];
  const resp = await editarOperacao({
    id: idOp,
    novosValores: { motivo_atraso: '' },
    diff: [{ campo: 'bercos_visuais', de: [], para: bercosVisuais }],
    bercosVisuais,
  });
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).ok, true);

  const json = await buscarBercosVisuais(idOp);
  assert.equal(json.ok, true);
  assert.deepEqual(json.bercos, bercosVisuais);
});

test('editar-operacao: bercosVisuais é upsert — uma 2ª chamada SUBSTITUI (não acumula) a marcação anterior', async () => {
  const idOp = 'op-eo-bv-upsert-' + Date.now();
  await registrarOperacao(idOp);

  const primeira = [{ berco: 'B1', ordem: 1, estado_esquerda: 'baixou', estado_direita: 'okay' }];
  await editarOperacao({
    id: idOp,
    novosValores: { motivo_atraso: '' },
    diff: [{ campo: 'bercos_visuais', de: [], para: primeira }],
    bercosVisuais: primeira,
  });

  const segunda = [{ berco: 'B1', ordem: 1, estado_esquerda: 'okay', estado_direita: 'okay' }];
  await editarOperacao({
    id: idOp,
    novosValores: { motivo_atraso: '' },
    diff: [{ campo: 'bercos_visuais', de: primeira, para: segunda }],
    bercosVisuais: segunda,
  });

  const json = await buscarBercosVisuais(idOp);
  assert.deepEqual(json.bercos, segunda);
});

test('editar-operacao: bercosVisuais ausente do payload NÃO mexe no que já estava salvo', async () => {
  const idOp = 'op-eo-bv-preserva-' + Date.now();
  await registrarOperacao(idOp);

  const marcado = [{ berco: 'B1', ordem: 1, estado_esquerda: 'baixou', estado_direita: 'okay' }];
  await editarOperacao({
    id: idOp,
    novosValores: { motivo_atraso: '' },
    diff: [{ campo: 'bercos_visuais', de: [], para: marcado }],
    bercosVisuais: marcado,
  });

  // Edição comum, sem tocar em bercosVisuais (campo nem enviado) — ex:
  // só mudando o turno pela tela normal de Editar Operação.
  await editarOperacao({
    id: idOp,
    novosValores: { turno: '2° TURNO' },
    diff: [{ campo: 'turno', de: '1° TURNO', para: '2° TURNO' }],
  });

  const json = await buscarBercosVisuais(idOp);
  assert.deepEqual(json.bercos, marcado);
});

test('editar-operacao: estado inválido em bercosVisuais é recusado (400) e nada é gravado', async () => {
  const idOp = 'op-eo-bv-invalido-' + Date.now();
  await registrarOperacao(idOp); // já nasce com 20 berços 'okay' (ver teste acima)

  const resp = await editarOperacao({
    id: idOp,
    novosValores: { motivo_atraso: '' },
    diff: [{ campo: 'bercos_visuais', de: [], para: [] }],
    bercosVisuais: [{ berco: 'B1', ordem: 1, estado_esquerda: 'vazou-total', estado_direita: 'okay' }],
  });
  assert.equal(resp.status, 400);
  const json = await resp.json();
  assert.equal(json.ok, false);
  assert.match(json.erro, /inválido/i);

  // Nada foi gravado (nem a operação, nem os berços) — a transação
  // inteira falha junto; continua exatamente como o registro inicial
  // deixou (20 berços 'okay'), não some nem parcialmente escreve o B1
  // rejeitado.
  const bv = await buscarBercosVisuais(idOp);
  assert.equal(bv.bercos.length, 20);
  assert.ok(bv.bercos.every(b => b.estado_esquerda === 'okay' && b.estado_direita === 'okay'));
});

test('editar-operacao: berço com formato inválido em bercosVisuais é recusado (400)', async () => {
  const idOp = 'op-eo-bv-formato-' + Date.now();
  await registrarOperacao(idOp);

  const resp = await editarOperacao({
    id: idOp,
    novosValores: { motivo_atraso: '' },
    diff: [{ campo: 'bercos_visuais', de: [], para: [] }],
    bercosVisuais: [{ berco: 'berço-1', ordem: 1, estado_esquerda: 'okay', estado_direita: 'okay' }],
  });
  assert.equal(resp.status, 400);
  assert.equal((await resp.json()).ok, false);
});

test('GET /bercos-visuais-operacao/:id sem sessão é recusado', async () => {
  const idOp = 'op-eo-bv-sem-sessao-' + Date.now();
  await registrarOperacao(idOp);

  const resp = await fetch(`${servidor.baseUrl}/bercos-visuais-operacao/${idOp}`);
  assert.notEqual(resp.status, 200);
});
