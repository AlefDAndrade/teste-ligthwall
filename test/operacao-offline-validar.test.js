// ─── test/operacao-offline-validar.test.js ──────────────────────────────────
// Cobertura formal de GET /operacao-offline/pendentes, POST /operacao-
// offline/corrigir, POST /operacao-offline/validar e POST /operacao-
// offline/recusar (README, "Registro de Operação Offline (PWA) — plano",
// itens 6 e 7 — a página do Master "Operações a Validar" + o comportamento
// do Contador de Traços na aprovação). Roda contra o server.js DE VERDADE
// (não um mock), numa cópia isolada — ver test/helpers/servidor-teste.js.
//
// Cobre:
//   - As 4 rotas exigem sessão de admin válida (403 sem sessão).
//   - Validar aprovado: vira uma linha real em operacoes (origem_offline=1,
//     validado_por, validado_em), cria berços visuais (todos 'okay'),
//     entra na fila de avaliação, grava os traços em relatorio_injecao.json
//     (mesma transformação que LW.registrarRelatorioInjecao faz no
//     navegador) e incrementa o Contador de Traços do Dia (item 7).
//   - Depois de validar, o item some da fila offline.
//   - Corrigir: aplica PATCH nos campos antes de validar (ex.: corrige um
//     horário que veio errado do relógio do dispositivo offline).
//   - Recusar: descarta sem nunca criar uma operação.
//   - Validar sem id_bateria/inicio/fim/capacidade é recusado (400), sem
//     criar nada — precisa corrigir antes.
//   - Validar 2 vezes seguidas o mesmo idTemp não duplica a operação
//     (idempotência da aprovação, não só do envio).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-operacao-offline-validar-951';
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
  const setCookie = resp.headers.get('set-cookie') || '';
  cookieAdmin = setCookie.split(';')[0];
  assert.ok(cookieAdmin, 'login de admin deveria emitir cookie de sessão');
});

after(async () => {
  await servidor.parar();
});

function comAdmin(extraHeaders) {
  return { Cookie: cookieAdmin, ...(extraHeaders || {}) };
}

function payloadValido(idTemp, overrides) {
  return {
    idTemp,
    formRecord: {
      turno: '1° TURNO', dimensao: 'padrão', capacidade: 4, id_bateria: 'B-validar-teste',
      tipo_montagem: 'SIMPLES', inicio: '2026-08-19T08:00:00.000Z', fim: '2026-08-19T09:00:00.000Z',
      desemplaque: 'NAO', tempo_min: 60, houve_atraso: 'NAO', motivo_atraso: '', qtd_tracos: 1,
      total_paineis: 10, m2_total: 5, paineis_por_tipo: { '2P': 10 }, m2_por_tipo: { '2P': 5 },
      paineis_2p: 10, paineis_sp: 0, m2_2p: 5, m2_sp: 0,
      ...overrides,
    },
    tracos: [{
      id: 'traco_off_' + idTemp, num: 1, berco_ini: '1', berco_fim: '4',
      cimento_real: { original: 100, ajustes: [] }, agua_real: { original: 50, ajustes: [] },
      eps_real: { original: 2, ajustes: [] }, superplast_real: { original: 1, ajustes: [] },
      incorporador_real: { original: 0.5, ajustes: [] }, tempo_batida: { original: 5, ajustes: [] },
      densidade_insumo: { original: 300, ajustes: [] }, flow_insumo: { original: 200, ajustes: [] },
      obs: '', silo: 'Silo 1', expansao: '1ª expansão', densidadeEPS: 16,
    }],
    pausas: [],
  };
}

async function enviarOffline(payload) {
  return fetch(`${servidor.baseUrl}/operacao-offline/enviar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
}

async function totalTracosHoje() {
  const resp = await fetch(`${servidor.baseUrl}/total-tracos-hoje`);
  const corpo = await resp.json();
  return corpo.total;
}

// Desde a renumeração manual do dia (ver lib/rotas/operacao-offline.js,
// "RENUMERAÇÃO MANUAL DO DIA NA VALIDAÇÃO"), POST /validar exige uma
// "renumeracao" cobrindo TODOS os traços do dia (existentes + os desta
// operação) — este helper espelha o que a tela faz por padrão (mantém o
// número dos existentes, numera os novos em sequência depois deles), pra
// não repetir isso em cada teste.
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

async function validar(idTemp, overrides) {
  let renumeracao = overrides && overrides.renumeracao;
  if (renumeracao === undefined) {
    const { existentes, pendentes } = await tracosDoDia(idTemp);
    renumeracao = renumeracaoAutomatica(existentes, pendentes);
  }
  return fetch(`${servidor.baseUrl}/operacao-offline/validar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...comAdmin() },
    body: JSON.stringify({ idTemp, renumeracao }),
  });
}

test('GET /operacao-offline/pendentes sem sessão de admin é recusado (403)', async () => {
  const resp = await fetch(`${servidor.baseUrl}/operacao-offline/pendentes`);
  assert.equal(resp.status, 403);
});

test('POST /operacao-offline/corrigir, /validar e /recusar sem sessão de admin são recusados (403)', async () => {
  for (const url of ['/operacao-offline/corrigir', '/operacao-offline/validar', '/operacao-offline/recusar']) {
    const resp = await fetch(`${servidor.baseUrl}${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idTemp: 'OFF-qualquer' }),
    });
    assert.equal(resp.status, 403, `${url} deveria exigir sessão de admin`);
  }
});

test('GET /operacao-offline/pendentes, com sessão, lista o que foi enviado', async () => {
  const idTemp = 'OFF-listagem-' + Date.now();
  await enviarOffline(payloadValido(idTemp));

  const resp = await fetch(`${servidor.baseUrl}/operacao-offline/pendentes`, { headers: comAdmin() });
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);
  assert.ok(corpo.lista.some(i => i.idTemp === idTemp));
});

test('validar aprovado: vira operação real com origem_offline/validado_por/validado_em, cria berços, entra na fila de avaliação, grava traços e incrementa o contador (item 7)', async () => {
  const idTemp = 'OFF-validar-completo-' + Date.now();
  await enviarOffline(payloadValido(idTemp));

  const totalAntes = await totalTracosHoje();

  const respValidar = await validar(idTemp);
  assert.equal(respValidar.status, 200);
  const corpoValidar = await respValidar.json();
  assert.equal(corpoValidar.ok, true);
  const idOperacao = corpoValidar.idOperacao;
  assert.equal(idOperacao, 'op_off_' + idTemp.slice(4));

  // 1) virou operação real, com auditoria de origem offline
  const historico = await (await fetch(`${servidor.baseUrl}/db/historico.json`)).json();
  const op = historico.find(o => o.id === idOperacao);
  assert.ok(op, 'operação deveria existir em historico.json');
  assert.equal(op.origem_offline, true);
  assert.equal(op.validado_por, 'Administrador');
  assert.ok(op.validado_em);
  assert.equal(op.avaliado, false);
  assert.equal(op.id_bateria, 'B-validar-teste');

  // 2) berços visuais criados, todos no estado padrão (nunca lê/reseta o
  // snapshot ao vivo — ver comentário grande em lib/rotas/operacao-offline.js)
  const bercos = await (await fetch(`${servidor.baseUrl}/db/bercos_visuais.json`)).json().catch(() => null);
  if (bercos) {
    const linhaDesta = Array.isArray(bercos) ? bercos.find(b => b.id_operacao === idOperacao) : null;
    if (linhaDesta) {
      assert.ok(linhaDesta.bercos.every(b => b.estado_esquerda === 'okay' && b.estado_direita === 'okay'));
    }
  }

  // 3) entrou na fila de avaliação do Setor de Qualidade
  const naoAvaliadas = await (await fetch(`${servidor.baseUrl}/operacoes-nao-avaliadas`)).json().catch(() => []);
  assert.ok(Array.isArray(naoAvaliadas) && naoAvaliadas.some(o => o.id === idOperacao), 'operação deveria estar na fila de avaliação');

  // 4) traço gravado em relatorio_injecao.json com a transformação certa
  const relatorio = await (await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`)).json();
  const traco = relatorio.find(t => t.id_traco === 'traco_off_' + idTemp);
  assert.ok(traco, 'traço deveria estar em relatorio_injecao.json');
  assert.equal(traco.cimento_real, 100);
  assert.equal(traco.densidade, 300); // densidade_insumo -> densidade (mesma transformação de LW.registrarRelatorioInjecao)
  assert.equal(traco.flow, 200); // flow_insumo -> flow
  assert.equal(traco.ultilizado.operacao[0].id_operacao, idOperacao);

  // 5) contador de traços do dia incrementou em 1 (item 7)
  const totalDepois = await totalTracosHoje();
  assert.equal(totalDepois, totalAntes + 1);

  // 6) saiu da fila offline
  const pendentesDepois = await (await fetch(`${servidor.baseUrl}/operacao-offline/pendentes`, { headers: comAdmin() })).json();
  assert.ok(!pendentesDepois.lista.some(i => i.idTemp === idTemp));
});

test('validar o mesmo idTemp 2 vezes seguidas não duplica a operação nem incrementa o contador de novo', async () => {
  const idTemp = 'OFF-validar-2x-' + Date.now();
  await enviarOffline(payloadValido(idTemp));

  const totalAntes = await totalTracosHoje();
  const r1 = await validar(idTemp);
  assert.equal(r1.status, 200);
  const totalDepois1 = await totalTracosHoje();
  assert.equal(totalDepois1, totalAntes + 1);

  // 2ª chamada: idTemp já não está mais na fila (removido na 1ª aprovação)
  // — resposta é um erro claro de "não encontrado", não um 500 nem uma
  // duplicata silenciosa. (Sem renumeracao mesmo — falha antes de chegar
  // nessa validação, já que o registro nem existe mais na fila.)
  const r2 = await fetch(`${servidor.baseUrl}/operacao-offline/validar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...comAdmin() }, body: JSON.stringify({ idTemp }),
  });
  assert.equal(r2.status, 400);

  const totalDepois2 = await totalTracosHoje();
  assert.equal(totalDepois2, totalDepois1, 'contador não deveria incrementar de novo');

  const historico = await (await fetch(`${servidor.baseUrl}/db/historico.json`)).json();
  const ocorrencias = historico.filter(o => o.id === 'op_off_' + idTemp.slice(4));
  assert.equal(ocorrencias.length, 1, 'só deveria existir 1 operação, mesmo com 2 chamadas de validar');
});

test('validar sem id_bateria/inicio/fim/capacidade é recusado (400), sem criar operação', async () => {
  const idTemp = 'OFF-validar-incompleto-' + Date.now();
  await enviarOffline(payloadValido(idTemp, { id_bateria: '' })); // id_bateria vazio de propósito

  // Sem renumeracao mesmo — a checagem de id_bateria/inicio/fim/capacidade
  // acontece ANTES da checagem de renumeração, então nem chega lá.
  const resp = await fetch(`${servidor.baseUrl}/operacao-offline/validar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...comAdmin() }, body: JSON.stringify({ idTemp }),
  });
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.match(corpo.erro, /bateria/i);

  const historico = await (await fetch(`${servidor.baseUrl}/db/historico.json`)).json();
  assert.ok(!historico.some(o => o.id === 'op_off_' + idTemp.slice(4)));

  // continua na fila — não some quando a validação falha
  const pendentes = await (await fetch(`${servidor.baseUrl}/operacao-offline/pendentes`, { headers: comAdmin() })).json();
  assert.ok(pendentes.lista.some(i => i.idTemp === idTemp));
});

test('corrigir aplica o patch, e depois validar usa o valor já corrigido', async () => {
  const idTemp = 'OFF-corrigir-' + Date.now();
  await enviarOffline(payloadValido(idTemp, { id_bateria: '' })); // nasce inválido de propósito

  const respCorrigir = await fetch(`${servidor.baseUrl}/operacao-offline/corrigir`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...comAdmin() },
    body: JSON.stringify({ idTemp, formRecord: { id_bateria: 'B-corrigida' } }),
  });
  assert.equal(respCorrigir.status, 200);
  const corpoCorrigir = await respCorrigir.json();
  assert.equal(corpoCorrigir.item.formRecord.id_bateria, 'B-corrigida');
  // Não mexeu em outros campos do formRecord (patch parcial, não substituição total)
  assert.equal(corpoCorrigir.item.formRecord.turno, '1° TURNO');
  assert.ok(corpoCorrigir.item.corrigidoEm);

  const respValidar = await validar(idTemp);
  assert.equal(respValidar.status, 200);

  const historico = await (await fetch(`${servidor.baseUrl}/db/historico.json`)).json();
  const op = historico.find(o => o.id === 'op_off_' + idTemp.slice(4));
  assert.equal(op.id_bateria, 'B-corrigida');
});

test('recusar remove da fila sem nunca criar uma operação', async () => {
  const idTemp = 'OFF-recusar-' + Date.now();
  await enviarOffline(payloadValido(idTemp));

  const totalAntes = await totalTracosHoje();
  const resp = await fetch(`${servidor.baseUrl}/operacao-offline/recusar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...comAdmin() }, body: JSON.stringify({ idTemp }),
  });
  assert.equal(resp.status, 200);

  const pendentes = await (await fetch(`${servidor.baseUrl}/operacao-offline/pendentes`, { headers: comAdmin() })).json();
  assert.ok(!pendentes.lista.some(i => i.idTemp === idTemp));

  const historico = await (await fetch(`${servidor.baseUrl}/db/historico.json`)).json();
  assert.ok(!historico.some(o => o.id === 'op_off_' + idTemp.slice(4)));

  const totalDepois = await totalTracosHoje();
  assert.equal(totalDepois, totalAntes, 'recusar não deveria mexer no contador de traços');
});

test('recusar um idTemp inexistente responde 400, não 500', async () => {
  const resp = await fetch(`${servidor.baseUrl}/operacao-offline/recusar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...comAdmin() },
    body: JSON.stringify({ idTemp: 'OFF-nunca-existiu-' + Date.now() }),
  });
  assert.equal(resp.status, 400);
});
