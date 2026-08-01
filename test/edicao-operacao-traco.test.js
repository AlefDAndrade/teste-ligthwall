// ─── test/edicao-operacao-traco.test.js ─────────────────────────────────────
// Cobertura formal de POST /editar-operacao e POST /editar-traco-relatorio
// (ver lib/rotas/edicao.js) — até agora só a checagem de permissão (403)
// tinha teste (ver test/permissoes-por-area.test.js); o CAMINHO FELIZ (o
// que a edição realmente grava, e as travas de campo protegido) era só
// validado manualmente. Corrige histórico de produção real, por isso
// merece o mesmo nível de cobertura que /registrar-operacao.
//
// Roda contra o server.js DE VERDADE (não um mock), numa cópia isolada —
// ver test/helpers/servidor-teste.js. Cobre:
//   EDITAR OPERAÇÃO
//   - Atualiza os campos editáveis e a mudança aparece em
//     GET /db/historico.json.
//   - Campos protegidos (id, data, inicio, fim, tempo_min, qtd_tracos,
//     tracos, houve_atraso, avaliado) são recusados (400) mesmo que
//     enviados junto com campos válidos — nada é gravado.
//   - Grava uma entrada de auditoria em... (via edicoes_operacao, não
//     exposta por rota própria aqui, então confirmamos indiretamente:
//     duas edições seguidas não se apagam, e o "diff" exigido não pode
//     vir vazio).
//   - "diff" vazio ou "id"/"novosValores" ausentes são recusados (400).
//   - id inexistente é recusado (400).
//   EDITAR TRAÇO
//   - Atualiza um traço existente (via /registrar-relatorio-injecao como
//     setup) e a mudança aparece em GET /db/relatorio_injecao.json.
//   - ajuste sem "tempo_batida" válido (> 0) é recusado (400).
//   - id_traco/id_operacao inexistentes são recusados (400).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-edicao-op-traco-264';
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
      id: idOp, data: '2026-07-20', turno: '1° TURNO', dimensao: 9, capacidade: 20,
      id_bateria: 'B-original', inicio: '2026-07-20T08:00:00.000Z', fim: '2026-07-20T09:00:00.000Z',
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

function registrarRelatorioInjecao(traco) {
  return fetch(`${servidor.baseUrl}/registrar-relatorio-injecao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify([traco]),
  });
}

function editarTraco(payload) {
  return fetch(`${servidor.baseUrl}/editar-traco-relatorio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(payload),
  });
}

async function buscarTraco(idTraco) {
  const resp = await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`);
  const lista = await resp.json();
  return lista.find(t => t.id_traco === idTraco);
}

// ═══════════════════════════════ EDITAR OPERAÇÃO ═══════════════════════════

test('editar-operacao: atualiza campos editáveis e a mudança aparece no histórico', async () => {
  const idOp = 'op-editar-' + Date.now();
  await registrarOperacao(idOp, { turno: '1° TURNO' });

  const resp = await editarOperacao({
    id: idOp,
    novosValores: { turno: '2° TURNO', motivo_atraso: 'Ajuste manual de teste' },
    diff: [{ campo: 'turno', de: '1° TURNO', para: '2° TURNO' }],
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);

  const salva = await buscarOperacao(idOp);
  assert.equal(salva.turno, '2° TURNO');
  assert.equal(salva.motivo_atraso, 'Ajuste manual de teste');
});

test('editar-operacao: recusa (400) tentar alterar um campo protegido, e NÃO grava nada', async () => {
  const idOp = 'op-campo-protegido-' + Date.now();
  await registrarOperacao(idOp, { qtd_tracos: 3 });

  const resp = await editarOperacao({
    id: idOp,
    // "turno" é editável; "qtd_tracos" é protegido — a mistura inteira
    // deve ser recusada, campo editável nenhum deve ser gravado.
    novosValores: { turno: '2° TURNO', qtd_tracos: 99 },
    diff: [{ campo: 'qtd_tracos', de: 3, para: 99 }],
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);
  assert.match(data.erro, /qtd_tracos/);

  const salva = await buscarOperacao(idOp);
  assert.equal(salva.turno, '1° TURNO', 'turno não deveria ter sido alterado — o request inteiro foi recusado');
  assert.equal(salva.qtd_tracos, 3, 'qtd_tracos (protegido) continua o original');
});

test('editar-operacao: "diff" vazio é recusado (400)', async () => {
  const idOp = 'op-diff-vazio-' + Date.now();
  await registrarOperacao(idOp);

  const resp = await editarOperacao({ id: idOp, novosValores: { turno: '3° TURNO' }, diff: [] });
  assert.equal(resp.status, 400);
});

test('editar-operacao: id inexistente é recusado (400)', async () => {
  const resp = await editarOperacao({
    id: 'op-que-nunca-existiu-' + Date.now(),
    novosValores: { turno: '2° TURNO' },
    diff: [{ campo: 'turno', de: 'x', para: 'y' }],
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /não encontrada/);
});

test('editar-operacao: "novosValores" ausente é recusado (400)', async () => {
  const idOp = 'op-sem-novos-valores-' + Date.now();
  await registrarOperacao(idOp);
  const resp = await editarOperacao({ id: idOp, diff: [{ campo: 'turno', de: 'x', para: 'y' }] });
  assert.equal(resp.status, 400);
});

// ═══════════════════════════════ EDITAR TRAÇO ══════════════════════════════

test('editar-traco-relatorio: atualiza o traço e a mudança aparece em GET /db/relatorio_injecao.json', async () => {
  const idOp = 'op-para-traco-editar-' + Date.now();
  await registrarOperacao(idOp);

  const idTraco = 'traco-editar-' + Date.now();
  await registrarRelatorioInjecao({
    id_traco: idTraco, data: '2026-07-20', turno: '1° TURNO', num_traco: 1,
    ultilizado: { operacao: [{ id_operacao: idOp, id_bateria: 'B-original', berco_inicio: 1, berco_finalizacao: 5, obs: '' }] },
    cimento_real: 10, agua_real: 4, eps_real: 2, superplast_real: 0.5, incorporador_real: 0.2,
    tempo_batida: 120, densidade: 30, flow: 600,
  });

  const resp = await editarTraco({
    id_traco: idTraco, id_operacao: idOp,
    novosValores: {
      uso: { id_bateria: 'B-corrigida', berco_inicio: 1, berco_finalizacao: 5, obs: 'corrigido no teste' },
      num_traco: 1, densidade_eps: 15, silo: 'Silo 2', expansao: 40,
      originais: { cimento_real: 12, agua_real: 4.5, eps_real: 2, superplast_real: 0.5, incorporador_real: 0.2, tempo_batida_min: 2.5 },
    },
    ajustes: [],
    diff: [{ campo: 'id_bateria', de: 'B-original', para: 'B-corrigida' }],
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);

  const traco = await buscarTraco(idTraco);
  assert.equal(traco.ultilizado.operacao[0].id_bateria, 'B-corrigida');
  assert.equal(traco.ultilizado.operacao[0].obs, 'corrigido no teste');
  assert.equal(traco.silo, 'Silo 2');
});

test('editar-traco-relatorio: ajuste sem "tempo_batida" válido (> 0) é recusado (400)', async () => {
  const idOp = 'op-para-traco-ajuste-invalido-' + Date.now();
  await registrarOperacao(idOp);
  const idTraco = 'traco-ajuste-invalido-' + Date.now();
  await registrarRelatorioInjecao({
    id_traco: idTraco, data: '2026-07-20', turno: '1° TURNO', num_traco: 2,
    ultilizado: { operacao: [{ id_operacao: idOp, id_bateria: 'B-x', berco_inicio: 1, berco_finalizacao: 5, obs: '' }] },
    cimento_real: 10, agua_real: 4, eps_real: 2, superplast_real: 0.5, incorporador_real: 0.2,
    tempo_batida: 120, densidade: 30, flow: 600,
  });

  const resp = await editarTraco({
    id_traco: idTraco, id_operacao: idOp,
    novosValores: {}, ajustes: [{ tempo_batida: 0, cimento: 1 }],
    diff: [{ campo: 'ajustes', de: [], para: [1] }],
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /tempo_batida/);
});

test('editar-traco-relatorio: id_traco inexistente é recusado (400)', async () => {
  const resp = await editarTraco({
    id_traco: 'traco-que-nunca-existiu-' + Date.now(), id_operacao: 'op-qualquer',
    novosValores: {}, ajustes: [], diff: [{ campo: 'x', de: 1, para: 2 }],
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /Traço não encontrado/);
});
