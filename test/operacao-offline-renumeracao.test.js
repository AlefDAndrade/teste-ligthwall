// ─── test/operacao-offline-renumeracao.test.js ──────────────────────────────
// Cobertura formal da renumeração manual do dia na validação de operação
// offline (ver lib/rotas/operacao-offline.js, comentário "RENUMERAÇÃO MANUAL
// DO DIA NA VALIDAÇÃO" — mudança pós-fase 7: a fase 7 somava certo o TOTAL
// do Contador de Traços do Dia, mas não tratava a numeração individual
// (#1, #2...) de cada traço, o que duplicava números quando uma operação
// offline era aprovada num dia que já tinha outros traços).
//
// Cobre:
//   - GET /operacao-offline/tracos-do-dia lista os traços já existentes do
//     dia (de outra operação já validada) + os pendentes desta operação.
//   - Validar SEM renumeracao (havendo traços envolvidos) é recusado (400).
//   - Validar com renumeracao FALTANDO um traço do dia é recusado (400).
//   - Validar com renumeracao com NÚMERO REPETIDO é recusado (400).
//   - Validar com renumeracao referenciando um id_traco que não pertence ao
//     dia é recusado (400).
//   - Validar com renumeracao válida: os traços NOVOS entram com o número
//     escolhido, e os traços JÁ EXISTENTES do dia (de outra operação) têm o
//     num_traco ATUALIZADO de verdade no banco — com auditoria em
//     edicoes_traco.
//   - Nenhuma dessas checagens mexe no Contador de Traços do Dia além do
//     esperado (só soma a quantidade de traços NOVOS, nunca por causa de
//     renumerar um existente).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-operacao-offline-renum-372';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');
const DATA_TESTE = '2026-08-19'; // mesma data usada no formRecord.inicio de todo payload deste arquivo

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

function payloadValido(idTemp, { idBateria, numTraco, idTraco } = {}) {
  return {
    idTemp,
    formRecord: {
      turno: '1° TURNO', dimensao: 'padrão', capacidade: 4, id_bateria: idBateria || ('B-' + idTemp),
      tipo_montagem: 'SIMPLES', inicio: `${DATA_TESTE}T08:00:00.000Z`, fim: `${DATA_TESTE}T09:00:00.000Z`,
      desemplaque: 'NAO', tempo_min: 60, houve_atraso: 'NAO', motivo_atraso: '', qtd_tracos: 1,
      total_paineis: 10, m2_total: 5, paineis_por_tipo: { '2P': 10 }, m2_por_tipo: { '2P': 5 },
      paineis_2p: 10, paineis_sp: 0, m2_2p: 5, m2_sp: 0,
    },
    tracos: [{
      id: idTraco || ('traco_' + idTemp), num: numTraco ?? 1, berco_ini: '1', berco_fim: '4',
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

async function tracosDoDia(idTemp) {
  const resp = await fetch(`${servidor.baseUrl}/operacao-offline/tracos-do-dia?idTemp=${encodeURIComponent(idTemp)}`, { headers: comAdmin() });
  const corpo = await resp.json();
  return { status: resp.status, corpo };
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

async function validarBruto(idTemp, renumeracao) {
  const body = renumeracao === undefined ? { idTemp } : { idTemp, renumeracao };
  return fetch(`${servidor.baseUrl}/operacao-offline/validar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...comAdmin() }, body: JSON.stringify(body),
  });
}

async function relatorioInjecao() {
  return (await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`)).json();
}

test('GET /operacao-offline/tracos-do-dia lista os existentes (de outra operação já validada) + os pendentes desta', async () => {
  const idTempA = 'OFF-renum-existente-' + Date.now();
  await enviarOffline(payloadValido(idTempA, { numTraco: 1 }));
  const { existentes: exA, pendentes: penA } = (await tracosDoDia(idTempA)).corpo;
  const rA = await validarBruto(idTempA, renumeracaoAutomatica(exA, penA));
  assert.equal(rA.status, 200, JSON.stringify(await rA.json()));

  const idTempB = 'OFF-renum-pendente-' + Date.now();
  await enviarOffline(payloadValido(idTempB, { numTraco: 1 }));
  const { status, corpo } = await tracosDoDia(idTempB);
  assert.equal(status, 200);
  assert.equal(corpo.ok, true);
  assert.ok(corpo.existentes.some(t => t.id_traco === 'traco_' + idTempA), 'traço da operação A (já validada) deveria aparecer como existente');
  assert.ok(corpo.pendentes.some(t => t.id_traco === 'traco_' + idTempB), 'traço da própria operação B (pendente) deveria aparecer como pendente');
  assert.equal(corpo.pendentes.find(t => t.id_traco === 'traco_' + idTempB).origem, 'pendente');
  assert.equal(corpo.existentes.find(t => t.id_traco === 'traco_' + idTempA).origem, 'existente');
});

test('validar SEM renumeracao (havendo traço envolvido) é recusado (400)', async () => {
  const idTemp = 'OFF-renum-sem-payload-' + Date.now();
  await enviarOffline(payloadValido(idTemp));

  const resp = await validarBruto(idTemp, undefined);
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.match(corpo.erro, /renumerar/i);

  // continua pendente — não aprovou nada
  const pendentes = await (await fetch(`${servidor.baseUrl}/operacao-offline/pendentes`, { headers: comAdmin() })).json();
  assert.ok(pendentes.lista.some(i => i.idTemp === idTemp));
});

test('validar com renumeracao FALTANDO um traço do dia é recusado (400)', async () => {
  const idTemp = 'OFF-renum-faltando-' + Date.now();
  await enviarOffline(payloadValido(idTemp));

  // Renumeração vazia — não cobre nem o próprio traço pendente
  const resp = await validarBruto(idTemp, []);
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.match(corpo.erro, /renumerar/i);
});

test('validar com NÚMERO REPETIDO na renumeracao é recusado (400)', async () => {
  const idTempA = 'OFF-renum-dup-A-' + Date.now();
  await enviarOffline(payloadValido(idTempA, { numTraco: 1 }));
  const { existentes: exA, pendentes: penA } = (await tracosDoDia(idTempA)).corpo;
  await validarBruto(idTempA, renumeracaoAutomatica(exA, penA));

  const idTempB = 'OFF-renum-dup-B-' + Date.now();
  await enviarOffline(payloadValido(idTempB, { numTraco: 1 }));
  const { existentes, pendentes } = (await tracosDoDia(idTempB)).corpo;

  // Propositalmente dá o MESMO número pro existente e pro pendente
  const renumeracaoComDuplicata = [
    ...existentes.map(t => ({ id_traco: t.id_traco, num_traco: 1 })),
    ...pendentes.map(t => ({ id_traco: t.id_traco, num_traco: 1 })),
  ];
  const resp = await validarBruto(idTempB, renumeracaoComDuplicata);
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.match(corpo.erro, /repetido/i);
});

test('validar com renumeracao referenciando id_traco de fora do dia é recusado (400)', async () => {
  const idTemp = 'OFF-renum-fora-' + Date.now();
  await enviarOffline(payloadValido(idTemp));
  const { existentes, pendentes } = (await tracosDoDia(idTemp)).corpo;
  const renumeracaoComIntruso = [
    ...renumeracaoAutomatica(existentes, pendentes),
    { id_traco: 'traco_que_nao_existe_neste_dia', num_traco: 999 },
  ];
  const resp = await validarBruto(idTemp, renumeracaoComIntruso);
  assert.equal(resp.status, 400);
  const corpo = await resp.json();
  assert.match(corpo.erro, /não pertence/i);
});

test('validar com renumeracao válida: novo entra com o número escolhido, e o existente de OUTRA operação é renumerado de verdade no banco (com auditoria)', async () => {
  // A: validada primeiro, nasce com num_traco = 1
  const idTempA = 'OFF-renum-efeito-A-' + Date.now();
  await enviarOffline(payloadValido(idTempA, { numTraco: 1 }));
  const { existentes: exA, pendentes: penA } = (await tracosDoDia(idTempA)).corpo;
  await validarBruto(idTempA, renumeracaoAutomatica(exA, penA));

  const relatorioAntes = await relatorioInjecao();
  const tracoAAntes = relatorioAntes.find(t => t.id_traco === 'traco_' + idTempA);
  const numeroInicialDeA = tracoAAntes.num_traco; // outros testes já rodaram no mesmo dia — não assume que é #1

  // B: chega depois, dispositivo offline também numerou como 1 (sem saber
  // do A) — o Master decide manualmente: A vira #1, B vira #2 (mantém a
  // ordem cronológica de validação desta vez).
  const idTempB = 'OFF-renum-efeito-B-' + Date.now();
  await enviarOffline(payloadValido(idTempB, { numTraco: 1 }));
  const { existentes, pendentes } = (await tracosDoDia(idTempB)).corpo;
  // Este arquivo de teste roda vários cenários no MESMO dia (DATA_TESTE) —
  // "existentes" pode ter traços de outros testes também, não só do A.
  // Mantém o número de todos os outros como está, só decide A (#5) e o
  // novo de B (#6) — os únicos que este teste realmente confere.
  assert.ok(existentes.some(t => t.id_traco === 'traco_' + idTempA));
  assert.equal(pendentes.length, 1);

  const outrosExistentes = existentes.filter(t => t.id_traco !== 'traco_' + idTempA);
  const maiorNumeroDoDia = existentes.reduce((max, t) => Math.max(max, t.num_traco || 0), 0);
  // Sempre bem acima de qualquer número já em uso nesse dia (incluindo o
  // próprio A) — garante que A REALMENTE muda de número neste teste,
  // mesmo que por coincidência já fosse o próximo disponível.
  const numeroParaA = maiorNumeroDoDia + 10;
  const numeroParaNovoDeB = maiorNumeroDoDia + 11;

  const renumeracaoManual = [
    ...outrosExistentes.map(t => ({ id_traco: t.id_traco, num_traco: t.num_traco })), // mantém os de outros testes como estão
    { id_traco: 'traco_' + idTempA, num_traco: numeroParaA }, // Master decide renumerar A
    { id_traco: pendentes[0].id_traco, num_traco: numeroParaNovoDeB },
  ];
  const resp = await validarBruto(idTempB, renumeracaoManual);
  assert.equal(resp.status, 200, JSON.stringify(await resp.json().catch(() => null)));

  const relatorioDepois = await relatorioInjecao();
  const tracoADepois = relatorioDepois.find(t => t.id_traco === 'traco_' + idTempA);
  const tracoBDepois = relatorioDepois.find(t => t.id_traco === 'traco_' + idTempB);
  assert.equal(tracoADepois.num_traco, numeroParaA, 'traço da operação A (existente) deveria ter sido renumerado no banco');
  assert.equal(tracoBDepois.num_traco, numeroParaNovoDeB, 'traço novo da operação B deveria entrar com o número escolhido');

  // Auditoria da renumeração do existente
  const auditoria = await (await fetch(`${servidor.baseUrl}/db/relatorio_edicoes.json`)).json().catch(() => []);
  const edicaoDoA = (auditoria || []).find(e => e.id_traco === 'traco_' + idTempA);
  assert.ok(edicaoDoA, 'deveria existir um registro de auditoria pra renumeração do traço A');
  const campoNum = (edicaoDoA.campos_alterados || []).find(c => c.campo === 'num_traco');
  assert.ok(campoNum, 'auditoria deveria registrar a mudança do campo num_traco');
  assert.equal(campoNum.de, numeroInicialDeA);
  assert.equal(campoNum.para, numeroParaA);
});

test('renumerar um existente sem mudar o número dele não incrementa o Contador de Traços do Dia além do esperado', async () => {
  const totalAntes = (await (await fetch(`${servidor.baseUrl}/total-tracos-hoje`)).json()).total;

  const idTempA = 'OFF-renum-contador-A-' + Date.now();
  await enviarOffline(payloadValido(idTempA, { numTraco: 1 }));
  const { existentes: exA, pendentes: penA } = (await tracosDoDia(idTempA)).corpo;
  await validarBruto(idTempA, renumeracaoAutomatica(exA, penA));

  const totalDepoisA = (await (await fetch(`${servidor.baseUrl}/total-tracos-hoje`)).json()).total;
  assert.equal(totalDepoisA, totalAntes + 1);

  const idTempB = 'OFF-renum-contador-B-' + Date.now();
  await enviarOffline(payloadValido(idTempB, { numTraco: 1 }));
  const { existentes, pendentes } = (await tracosDoDia(idTempB)).corpo;
  // Mantém o número do existente como está, só numera o novo em sequência
  const resp = await validarBruto(idTempB, renumeracaoAutomatica(existentes, pendentes));
  assert.equal(resp.status, 200);

  const totalDepoisB = (await (await fetch(`${servidor.baseUrl}/total-tracos-hoje`)).json()).total;
  assert.equal(totalDepoisB, totalDepoisA + 1, 'contador deveria subir só pelo traço NOVO, nunca por renumerar um existente');
});
