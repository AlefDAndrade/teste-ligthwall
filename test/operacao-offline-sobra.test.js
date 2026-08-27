// ─── test/operacao-offline-sobra.test.js ────────────────────────────────────
// Cobertura da marcação "Este traço é uma sobra" (offline-operacao.js) e do
// vínculo que o Administrador aponta na revisão (POST /operacao-offline/
// corrigir, chamado pela tela "Operações a Validar" quando clica em
// "🔗 Salvar vínculo" — ver _cfgSobraSectionOperacaoOffline/cfgSalvarLinkSobra,
// public/js/app-core.js). Roda contra o server.js DE VERDADE, mesma base de
// test/operacao-offline-validar.test.js.
//
// Cobre:
//   - Um traço enviado com eh_sobra:true e nota_sobra permanece assim na
//     fila (GET /operacao-offline/pendentes) até ser validado.
//   - POST /operacao-offline/corrigir consegue atualizar só o
//     link_sobra_original de um traço específico, preservando os demais
//     campos do traço e os demais traços da operação.
//   - Ao VALIDAR, o traço marcado como sobra grava em relatorio_injecao.json
//     um `obs` que inclui a nota do operador e o vínculo — tanto no campo
//     top-level `obs` quanto no `ultilizado.operacao[0].obs` (o realmente
//     exibido, ver comentário em LW.registrarRelatorioInjecao).
//   - Um traço SEM eh_sobra continua gravando o `obs` exatamente como
//     antes (sem nenhum marcador), não afeta o comportamento existente.
//   - Sem vínculo preenchido, o `obs` final ainda assim deixa claro que é
//     uma sobra AINDA SEM vínculo (não fica ambíguo/silencioso).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-operacao-offline-sobra-244';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let cookieAdmin;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  cookieAdmin = (resp.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookieAdmin, 'login de admin deveria emitir cookie de sessão');
});

after(async () => {
  await servidor.parar();
});

function comAdmin(extraHeaders) {
  return { Cookie: cookieAdmin, ...(extraHeaders || {}) };
}

function tracoBase(idTemp, overrides) {
  return {
    id: 'traco_off_' + idTemp, num: 1, berco_ini: '1', berco_fim: '4',
    cimento_real: { original: 100, ajustes: [] }, agua_real: { original: 50, ajustes: [] },
    eps_real: { original: 2, ajustes: [] }, superplast_real: { original: 1, ajustes: [] },
    incorporador_real: { original: 0.5, ajustes: [] }, tempo_batida: { original: 5, ajustes: [] },
    densidade_insumo: { original: 300, ajustes: [] }, flow_insumo: { original: 200, ajustes: [] },
    obs: '', silo: 'Silo 1', expansao: '1ª expansão', densidadeEPS: 16,
    ...overrides,
  };
}

function payloadValido(idTemp, tracos) {
  return {
    idTemp,
    formRecord: {
      turno: '1° TURNO', dimensao: 'padrão', capacidade: 4, id_bateria: 'B-sobra-teste',
      tipo_montagem: 'SIMPLES', inicio: '2026-08-19T08:00:00.000Z', fim: '2026-08-19T09:00:00.000Z',
      desemplaque: 'NAO', tempo_min: 60, houve_atraso: 'NAO', motivo_atraso: '', qtd_tracos: tracos.length,
      total_paineis: 10, m2_total: 5, paineis_por_tipo: { '2P': 10 }, m2_por_tipo: { '2P': 5 },
      paineis_2p: 10, paineis_sp: 0, m2_2p: 5, m2_sp: 0,
      numero_inicial_traco: 1,
    },
    tracos,
    pausas: [],
  };
}

async function enviarOffline(payload) {
  return fetch(`${servidor.baseUrl}/operacao-offline/enviar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
}

async function tracosDoDia(idTemp) {
  const resp = await fetch(`${servidor.baseUrl}/operacao-offline/tracos-do-dia?idTemp=${encodeURIComponent(idTemp)}`, { headers: comAdmin() });
  const corpo = await resp.json();
  assert.equal(corpo.ok, true, corpo.erro);
  return corpo;
}

function renumeracaoAutomatica(existentes, pendentes) {
  const usados = new Set(existentes.map(t => t.num_traco));
  let proximo = existentes.reduce((max, t) => Math.max(max, t.num_traco || 0), 0) + 1;
  const renumeracao = existentes.map(t => ({ id_traco: t.id_traco, num_traco: t.num_traco }));
  pendentes.forEach(t => {
    while (usados.has(proximo)) proximo++;
    renumeracao.push({ id_traco: t.id_traco, num_traco: proximo });
    usados.add(proximo);
    proximo++;
  });
  return renumeracao;
}

async function validar(idTemp) {
  const { existentes, pendentes } = await tracosDoDia(idTemp);
  const renumeracao = renumeracaoAutomatica(existentes, pendentes);
  return fetch(`${servidor.baseUrl}/operacao-offline/validar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...comAdmin() },
    body: JSON.stringify({ idTemp, renumeracao }),
  });
}

test('traço com eh_sobra:true chega e permanece assim na fila (GET /pendentes)', async () => {
  const idTemp = 'OFF-sobra-' + crypto.randomUUID();
  const resp = await enviarOffline(payloadValido(idTemp, [
    tracoBase(idTemp, { eh_sobra: true, nota_sobra: 'sobra do traço 3 de ontem, bateria B-12' }),
  ]));
  assert.equal(resp.status, 200);

  const pendentes = await (await fetch(`${servidor.baseUrl}/operacao-offline/pendentes`, { headers: comAdmin() })).json();
  const item = pendentes.lista.find(i => i.idTemp === idTemp);
  assert.ok(item, 'item deveria estar na fila');
  assert.equal(item.tracos[0].eh_sobra, true);
  assert.equal(item.tracos[0].nota_sobra, 'sobra do traço 3 de ontem, bateria B-12');
  assert.equal(item.tracos[0].link_sobra_original, undefined, 'sem vínculo ainda — só o operador marcou, admin não mexeu');
});

test('POST /operacao-offline/corrigir grava o vínculo (link_sobra_original) sem afetar os outros campos/traços', async () => {
  const idTemp = 'OFF-sobra-' + crypto.randomUUID();
  await enviarOffline(payloadValido(idTemp, [
    tracoBase(idTemp, { eh_sobra: true, nota_sobra: 'sobra de ontem' }),
    tracoBase(idTemp + '-b', { id: 'traco_off_' + idTemp + '-b', num: 2, eh_sobra: false }),
  ]));

  const pendentesAntes = await (await fetch(`${servidor.baseUrl}/operacao-offline/pendentes`, { headers: comAdmin() })).json();
  const itemAntes = pendentesAntes.lista.find(i => i.idTemp === idTemp);
  const tracosComVinculo = itemAntes.tracos.map((t, idx) => idx === 0 ? { ...t, link_sobra_original: 'operação #123, traço 4' } : t);

  const respCorrigir = await fetch(`${servidor.baseUrl}/operacao-offline/corrigir`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...comAdmin() },
    body: JSON.stringify({ idTemp, tracos: tracosComVinculo }),
  });
  assert.equal(respCorrigir.status, 200);

  const pendentesDepois = await (await fetch(`${servidor.baseUrl}/operacao-offline/pendentes`, { headers: comAdmin() })).json();
  const itemDepois = pendentesDepois.lista.find(i => i.idTemp === idTemp);
  assert.equal(itemDepois.tracos[0].link_sobra_original, 'operação #123, traço 4');
  assert.equal(itemDepois.tracos[0].nota_sobra, 'sobra de ontem', 'nota original preservada');
  assert.equal(itemDepois.tracos[1].eh_sobra, false, 'segundo traço não deveria ter sido afetado');
});

test('ao validar, traço marcado como sobra grava obs com nota + vínculo (nos dois campos obs)', async () => {
  const idTemp = 'OFF-sobra-' + crypto.randomUUID();
  await enviarOffline(payloadValido(idTemp, [
    tracoBase(idTemp, { eh_sobra: true, nota_sobra: 'sobra do traço 3 de ontem', link_sobra_original: 'operação #123, traço 4' }),
  ]));

  const respValidar = await validar(idTemp);
  assert.equal(respValidar.status, 200, JSON.stringify(await respValidar.json().catch(() => ({}))));

  const relatorio = await (await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`)).json();
  const traco = relatorio.find(t => t.id_traco === 'traco_off_' + idTemp);
  assert.ok(traco, 'traço deveria estar em relatorio_injecao.json');

  for (const obs of [traco.obs, traco.ultilizado.operacao[0].obs]) {
    assert.match(obs, /SOBRA/);
    assert.match(obs, /sobra do traço 3 de ontem/);
    assert.match(obs, /operação #123, traço 4/);
  }
});

test('ao validar, traço marcado como sobra SEM vínculo ainda deixa isso explícito no obs', async () => {
  const idTemp = 'OFF-sobra-' + crypto.randomUUID();
  await enviarOffline(payloadValido(idTemp, [
    tracoBase(idTemp, { eh_sobra: true, nota_sobra: 'sobra sem vínculo' }),
  ]));

  await validar(idTemp);

  const relatorio = await (await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`)).json();
  const traco = relatorio.find(t => t.id_traco === 'traco_off_' + idTemp);
  assert.match(traco.obs, /SOBRA/);
  assert.match(traco.obs, /sem vínculo/i);
});

test('traço SEM eh_sobra continua gravando obs normalmente, sem nenhum marcador', async () => {
  const idTemp = 'OFF-sobra-' + crypto.randomUUID();
  await enviarOffline(payloadValido(idTemp, [
    tracoBase(idTemp, { eh_sobra: false, obs: 'observação normal do traço' }),
  ]));

  await validar(idTemp);

  const relatorio = await (await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`)).json();
  const traco = relatorio.find(t => t.id_traco === 'traco_off_' + idTemp);
  assert.equal(traco.obs, 'observação normal do traço');
  assert.doesNotMatch(traco.obs, /SOBRA/);
});
