// ─── test/one-page-report.test.js ───────────────────────────────────────────
// Fase 6 do plano do One Page Report (ver README, "Nova página: One Page
// Report (planejamento)"): cobertura do endpoint de agregação da Fase 4
// (GET /db/one-page-report.json, lib/rotas/one-page-report.js).
//
// Roda contra o server.js DE VERDADE (não um mock), numa cópia isolada —
// ver test/helpers/servidor-teste.js. CRUD de ocorrências/cargas, cálculo
// de "dias sem acidentes" e agregação semanal de expedição já têm
// cobertura própria (test/seguranca-ocorrencias-crud.test.js,
// test/expedicao-crud.test.js) — este arquivo cobre só o que é NOVO na
// Fase 4: o endpoint que JUNTA tudo isso.
//
// Produção e Refugo não têm rota HTTP de escrita (nascem de Registrar
// Operação/Setor de Qualidade, fora do escopo deste teste) — por isso são
// SEMEADOS direto no SQLite do servidor de teste (mesmo padrão de
// test/exportar-pdf-etapa2.test.js: conexão própria e curta, abre/escreve/
// fecha na hora, `<pastaTemp>/data/lightwall.sqlite`).
//
// Cobre:
//   - Mês sem NENHUM dado: nenhum bloco quebra (sem 500), todos os blocos
//     de dado real vêm "disponivel: false", sem nenhum número inventado
//     (nenhum total/percentual/m² solto fingindo ser dado real).
//   - `mes` ausente ou inválido cai no mês corrente (relógio congelado).
//   - Um mês com dado não vaza pra outro mês sem dado (Segurança é a
//     exceção de propósito: "dias sem acidentes" é sempre GLOBAL).
//   - Caminho feliz de cada bloco (Segurança/Produção/Refugo/Expedição)
//     com números conferidos à mão.
//   - Comentários (Fase 3): texto livre salvo vira array de linhas na
//     agregação; Assuntos Gerais continua string.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-one-page-report-942';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
    // Congela "hoje" (Brasília) em 2026-08-31 — mesmo mecanismo de
    // test/seguranca-ocorrencias-crud.test.js/expedicao-crud.test.js. Mês
    // corrente = 2026-08 (usado quando `mes` está ausente/inválido).
    env: { LW_TEST_RELOGIO_ISO: '2026-08-31T12:00:00-03:00' },
  });
});

after(async () => {
  await servidor.parar();
});

function extrairCookie(resposta) {
  const setCookie = resposta.headers.get('set-cookie') || '';
  return setCookie.split(';')[0] || null;
}

async function logarComoAdminMaster() {
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  return extrairCookie(resp);
}

function buscarRelatorio(mes) {
  const qs = mes ? `?mes=${mes}` : '';
  return fetch(`${servidor.baseUrl}/db/one-page-report.json${qs}`);
}

/** Mesmo endpoint, mas pros modos "todos"/"range" (querystring própria — ver contextoDoPeriodo, lib/rotas/one-page-report.js). */
function buscarRelatorioPeriodo(qs) {
  return fetch(`${servidor.baseUrl}/db/one-page-report.json?${qs}`);
}

function registrarCarga(payload, cookie) {
  return fetch(`${servidor.baseUrl}/registrar-carga-expedicao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
}

function salvarComentarios(payload, cookie) {
  return fetch(`${servidor.baseUrl}/salvar-comentarios-one-page-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
}

// ── Sementes diretas no SQLite (ver comentário no topo do arquivo) ────────

function _conexao() {
  return new Database(path.join(servidor.pastaTemp, 'data', 'lightwall.sqlite'));
}

function semearOperacao({ id, data, m2Total, qtdTracos = 0 }) {
  const c = _conexao();
  try {
    c.prepare(`
      INSERT INTO operacoes (id, data, id_bateria, total_paineis, m2_total, qtd_tracos)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, data, 'BAT-' + id, 20, m2Total, qtdTracos);
  } finally { c.close(); }
}

function semearTraco(idTraco, data) {
  const c = _conexao();
  try {
    c.prepare('INSERT OR IGNORE INTO tracos (id_traco, data) VALUES (?, ?)').run(idTraco, data);
  } finally { c.close(); }
}

function semearUsoTraco(idTraco, idOperacao) {
  const c = _conexao();
  try {
    c.prepare('INSERT INTO traco_usos (id_traco, id_operacao) VALUES (?, ?)').run(idTraco, idOperacao);
  } finally { c.close(); }
}

/** Semeia 1 avaliação de qualidade + seus painéis já normalizados (avaliacao_paineis) — mesma dupla gravação de db.salvarAvaliacaoQualidade. */
function semearAvaliacaoComPaineis({ idAvaliacao, idOperacao, registradoEm, paineis }) {
  const c = _conexao();
  try {
    c.prepare(`
      INSERT INTO avaliacoes_qualidade (id, id_operacao, id_bateria, turno, registrado_em, dados)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(idAvaliacao, idOperacao, 'BAT-' + idOperacao, 'manha', registradoEm, '{}');
    c.prepare(`
      INSERT INTO avaliacao_paineis (id_avaliacao, id_operacao, id_bateria, registrado_em, paineis)
      VALUES (?, ?, ?, ?, ?)
    `).run(idAvaliacao, idOperacao, 'BAT-' + idOperacao, registradoEm, JSON.stringify(paineis));
  } finally { c.close(); }
}

function semearOcorrenciaSeguranca(data) {
  const c = _conexao();
  try {
    c.prepare(`
      INSERT INTO seguranca_ocorrencias (id, data, descricao, gravidade, registrado_em)
      VALUES (?, ?, 'Ocorrência de teste', 'leve', ?)
    `).run('ocorrencia_teste_' + data, data, new Date().toISOString());
  } finally { c.close(); }
}

// ── Mês totalmente vazio ("2026-01" — nunca usado por nenhum outro teste
// deste arquivo) ────────────────────────────────────────────────────────

test('mês sem nenhum dado: 200, nenhum bloco quebra, tudo "indisponível" — nunca dado inventado', async () => {
  const resp = await buscarRelatorio('2026-01');
  assert.equal(resp.status, 200);
  const corpo = await resp.json();

  assert.equal(corpo.mes, '2026-01');
  assert.equal(corpo.mesReferencia, 'Janeiro/2026');

  // Segurança: "disponivel" aqui é GLOBAL (nenhuma ocorrência jamais
  // registrada em NENHUM mês ainda, neste ponto da suíte) — acumuladoMes
  // do mês pedido é 0 (não inventado, é a contagem real de um mês vazio).
  assert.equal(corpo.seguranca.disponivel, false);
  assert.equal(corpo.seguranca.acumuladoMes, 0);
  assert.equal(corpo.seguranca.diasSemAcidentes, null);
  assert.equal(corpo.seguranca.ocorrenciasPorDia.values.every(v => v === 0), true);

  // Produção/Refugo/Expedição: SEM dado real, o bloco não deve trazer
  // nenhum campo numérico "de mentira" (totalM2, totalPct, acumuladoM2...)
  // — só o indicador de indisponibilidade.
  for (const bloco of ['producao', 'refugo', 'expedicao']) {
    assert.equal(corpo[bloco].disponivel, false, `${bloco}.disponivel deveria ser false`);
    assert.deepEqual(Object.keys(corpo[bloco]).sort(), ['comentarios', 'disponivel', 'proximosPassos'].sort(),
      `${bloco} não deveria ter nenhum campo numérico inventado`);
  }

  assert.deepEqual(corpo.assuntosGerais, { texto: '', fotos: [] });
});

test('mes ausente cai no mês corrente (relógio congelado = 2026-08)', async () => {
  const corpo = await (await buscarRelatorio()).json();
  assert.equal(corpo.mes, '2026-08');
  assert.equal(corpo.mesReferencia, 'Agosto/2026');
});

test('mes em formato inválido cai no mês corrente (não quebra, não usa o valor bruto)', async () => {
  const corpo = await (await buscarRelatorio('data-invalida')).json();
  assert.equal(corpo.mes, '2026-08');
});

// ── Segurança (dado semeado em Fevereiro/2026, mês isolado do resto) ──────

test('Segurança: ocorrência aparece no mês certo, "dias sem acidentes" é global (não zera o mês vazio de Janeiro)', async () => {
  semearOcorrenciaSeguranca('2026-02-10');

  const fev = await (await buscarRelatorio('2026-02')).json();
  assert.equal(fev.seguranca.disponivel, true);
  assert.equal(fev.seguranca.acumuladoMes, 1);
  const dia10 = fev.seguranca.ocorrenciasPorDia.labels.indexOf('10');
  assert.equal(fev.seguranca.ocorrenciasPorDia.values[dia10], 1);
  // 2026-02-10 -> 2026-08-31 (relógio congelado) = 202 dias corridos.
  assert.equal(fev.seguranca.diasSemAcidentes, 202);

  // Janeiro continua sem NENHUMA ocorrência SUA (acumuladoMes: 0), mas
  // "disponivel" agora é true (existe ocorrência em algum mês) e
  // "diasSemAcidentes" é o MESMO valor global — mesmo raciocínio de
  // db.diasSemAcidentes (lib/db/seguranca-ocorrencias.js): não é por mês.
  const jan = await (await buscarRelatorio('2026-01')).json();
  assert.equal(jan.seguranca.disponivel, true);
  assert.equal(jan.seguranca.acumuladoMes, 0);
  assert.equal(jan.seguranca.diasSemAcidentes, 202);
});

// ── Produção + Refugo (dados semeados em Março/2026) ──────────────────────

test('Produção: baterias/dia e m² total batem com o que foi semeado; sem conceito real de "linha", tudo em L1', async () => {
  semearOperacao({ id: 'op-mar-1', data: '2026-03-05', m2Total: 36.6, qtdTracos: 2 });
  semearOperacao({ id: 'op-mar-2', data: '2026-03-05', m2Total: 18.3, qtdTracos: 1 });
  semearOperacao({ id: 'op-mar-3', data: '2026-03-12', m2Total: 40, qtdTracos: 1 });

  const mar = await (await buscarRelatorio('2026-03')).json();
  assert.equal(mar.producao.disponivel, true);

  const dia5 = mar.producao.bateriasPorDia.labels.indexOf('5');
  const dia12 = mar.producao.bateriasPorDia.labels.indexOf('12');
  assert.equal(mar.producao.bateriasPorDia.values[dia5], 2); // 2 operações no dia 5
  assert.equal(mar.producao.bateriasPorDia.values[dia12], 1);

  assert.equal(mar.producao.totalM2, 94.9); // 36.6 + 18.3 + 40
  const l1 = mar.producao.distribuicaoLinha.find(l => l.label === 'L1');
  const l2 = mar.producao.distribuicaoLinha.find(l => l.label === 'L2');
  assert.equal(l1.value, 94.9);
  assert.equal(l2.value, 0); // linha real ainda não existe no domínio — ver comentário no topo de lib/rotas/one-page-report.js
});

test('Refugo: % diário e total batem com os painéis semeados; "tracosPorLinha" = refugos ÷ traços distintos usados', async () => {
  // 2 traços usados pelas 2 operações avaliadas de março (op-mar-1 e op-mar-2).
  semearTraco('T-mar-1', '2026-03-05');
  semearTraco('T-mar-2', '2026-03-05');
  semearUsoTraco('T-mar-1', 'op-mar-1');
  semearUsoTraco('T-mar-2', 'op-mar-2');

  // Dia 5: 3 painéis (1 reprovado). Dia 12: 1 painel (0 reprovado).
  semearAvaliacaoComPaineis({
    idAvaliacao: 'av-mar-1', idOperacao: 'op-mar-1', registradoEm: '2026-03-05T10:00:00.000Z',
    paineis: [{ resultado: 'aprovado' }, { resultado: 'reprovado' }, { resultado: 'aprovado' }],
  });
  semearAvaliacaoComPaineis({
    idAvaliacao: 'av-mar-2', idOperacao: 'op-mar-3', registradoEm: '2026-03-12T10:00:00.000Z',
    paineis: [{ resultado: 'aprovado' }],
  });

  const mar = await (await buscarRelatorio('2026-03')).json();
  assert.equal(mar.refugo.disponivel, true);

  const dia5 = mar.refugo.refugoDiarioPct.labels.indexOf('5');
  const dia12 = mar.refugo.refugoDiarioPct.labels.indexOf('12');
  assert.equal(mar.refugo.refugoDiarioPct.values[dia5], 33.3); // 1/3
  assert.equal(mar.refugo.refugoDiarioPct.values[dia12], 0);   // 0/1

  assert.equal(mar.refugo.totalPct, 25); // 1 reprovado / 4 painéis totais

  // op-mar-1 (traço T-mar-1) e op-mar-3 (nenhum traço semeado) foram
  // avaliadas -> só T-mar-1 entra no "distinto" (op-mar-3 não tem uso de
  // traço semeado) -> 1 reprovado / 1 traço distinto = 1.
  const l1 = mar.refugo.tracosPorLinha.find(t => t.linha === 'L1');
  assert.equal(l1.valor, 1);
});

// ── Expedição (dado registrado via HTTP, rota já existente da Fase 2) ─────

test('Expedição: m²/dia, contagem de cargas por semana (S1-S4) e acumulado batem com o registrado', async () => {
  const cookie = await logarComoAdminMaster();
  await registrarCarga({ data: '2026-04-03', cliente: 'Cliente Alfa', m2: 100 }, cookie);   // dia 3 -> S1
  await registrarCarga({ data: '2026-04-10', cliente: 'Cliente Beta', m2: 50.5 }, cookie);  // dia 10 -> S2
  await registrarCarga({ data: '2026-04-25', cliente: 'Cliente Gama', m2: 20 }, cookie);    // dia 25 -> S4

  const abr = await (await buscarRelatorio('2026-04')).json();
  assert.equal(abr.expedicao.disponivel, true);

  const dia3 = abr.expedicao.expedicaoPorDia.labels.indexOf('3');
  const dia10 = abr.expedicao.expedicaoPorDia.labels.indexOf('10');
  assert.equal(abr.expedicao.expedicaoPorDia.values[dia3], 100);
  assert.equal(abr.expedicao.expedicaoPorDia.values[dia10], 50.5);

  // Contagem de CARGAS por semana (não m²) — 1 em S1, 1 em S2, 0 em S3, 1 em S4.
  assert.deepEqual(abr.expedicao.cargasPorSemana, { labels: ['S1', 'S2', 'S3', 'S4'], values: [1, 1, 0, 1] });

  assert.equal(abr.expedicao.acumuladoM2, 170.5);
  assert.equal(abr.expedicao.acumuladoCargas, 3);
});

// ── Comentários (Fase 3): string -> array na agregação ─────────────────────

test('Comentários: texto livre salvo (Fase 3) vira array de linhas na agregação; Assuntos Gerais vira {texto, fotos}', async () => {
  const cookie = await logarComoAdminMaster();
  const resp = await salvarComentarios({
    mes: '2026-04',
    producao: { comentarios: 'Linha 1\nLinha 2\n\n', proximosPassos: 'Ajustar traço da bateria X' },
    assuntosGerais: 'Reunião mensal marcada para o dia 30.',
  }, cookie);
  assert.equal(resp.status, 200);

  const abr = await (await buscarRelatorio('2026-04')).json();
  assert.deepEqual(abr.producao.comentarios, ['Linha 1', 'Linha 2']); // linha em branco descartada
  assert.deepEqual(abr.producao.proximosPassos, ['Ajustar traço da bateria X']);
  assert.deepEqual(abr.assuntosGerais, { texto: 'Reunião mensal marcada para o dia 30.', fotos: [] });

  // Bloco que não recebeu comentário nenhum continua com arrays vazios,
  // nunca `undefined`/`null` (a tela usa `.map` direto em cima disso).
  assert.deepEqual(abr.expedicao.comentarios, []);
  assert.deepEqual(abr.expedicao.proximosPassos, []);
});

// ── "Todos os períodos"/"Personalizado" (reaproveita o que já foi semeado
// pelos testes acima: ocorrência em Fev/26, produção+refugo em Mar/26,
// expedição em Abr/26) — cada bloco agrupado por MÊS, não por dia. ────────

test('periodo=todos: cada bloco agregado por mês, sem Módulo de Comentários/Assuntos Gerais (não têm "1 mês" pra amarrar)', async () => {
  const corpo = await (await buscarRelatorioPeriodo('periodo=todos')).json();

  assert.deepEqual(corpo.periodo, { tipo: 'todos' });
  assert.equal(corpo.mes, null);
  assert.equal(corpo.mesReferencia, 'Todos os períodos');
  assert.deepEqual(corpo.assuntosGerais, { texto: '', fotos: [] });

  // Segurança: única ocorrência semeada em todo o arquivo (2026-02-10) —
  // "diasSemAcidentes" continua o mesmo cálculo global de sempre.
  assert.equal(corpo.seguranca.disponivel, true);
  assert.equal(corpo.seguranca.acumuladoMes, 1);
  assert.deepEqual(corpo.seguranca.ocorrenciasPorDia, { labels: ['Fev/26'], values: [1] });
  assert.deepEqual(corpo.seguranca.comentarios, []);
  assert.deepEqual(corpo.seguranca.proximosPassos, []);

  // Produção: as 3 operações de março, todas no mesmo mês -> 1 barra só.
  assert.equal(corpo.producao.disponivel, true);
  assert.deepEqual(corpo.producao.bateriasPorDia, { labels: ['Mar/26'], values: [3] });
  assert.equal(corpo.producao.totalM2, 94.9);

  // Refugo: 1 reprovado / 4 painéis (mesmos números do teste de março, só
  // que agora num bucket "Mar/26" em vez de "dia 5"/"dia 12" separados).
  assert.equal(corpo.refugo.disponivel, true);
  assert.deepEqual(corpo.refugo.refugoDiarioPct, { labels: ['Mar/26'], values: [25] });
  assert.equal(corpo.refugo.totalPct, 25);

  // Expedição: as 3 cargas de abril, mesmo acumulado de sempre, agora
  // bucketado por mês (não por semana S1-S4).
  assert.equal(corpo.expedicao.disponivel, true);
  assert.deepEqual(corpo.expedicao.expedicaoPorDia, { labels: ['Abr/26'], values: [170.5] });
  assert.deepEqual(corpo.expedicao.cargasPorSemana, { labels: ['Abr/26'], values: [3] });
  assert.equal(corpo.expedicao.acumuladoM2, 170.5);
  assert.equal(corpo.expedicao.acumuladoCargas, 3);
});

test('periodo=range: filtra só o intervalo pedido; meses sem dado aparecem zerados (contínuo, não só os com dado)', async () => {
  // Fevereiro a Março inteiros: pega a ocorrência de segurança E a
  // produção/refugo de março, mas FICA DE FORA a expedição de abril.
  const corpo = await (await buscarRelatorioPeriodo('periodo=range&inicio=2026-02-01&fim=2026-03-31')).json();

  assert.deepEqual(corpo.periodo, { tipo: 'range', inicio: '2026-02-01', fim: '2026-03-31' });
  assert.equal(corpo.mesReferencia, '01/02/2026 a 31/03/2026');

  // Contínuo: Fev/26 E Mar/26 aparecem, mesmo que um bloco só tenha dado
  // num dos dois (mesmo espírito de "todo dia do mês aparece, mesmo
  // zerado" do modo mensal).
  assert.equal(corpo.seguranca.disponivel, true);
  assert.deepEqual(corpo.seguranca.ocorrenciasPorDia, { labels: ['Fev/26', 'Mar/26'], values: [1, 0] });

  assert.equal(corpo.producao.disponivel, true);
  assert.deepEqual(corpo.producao.bateriasPorDia, { labels: ['Fev/26', 'Mar/26'], values: [0, 3] });
  assert.equal(corpo.producao.totalM2, 94.9);

  // Expedição não tem NENHUMA carga no intervalo pedido -> indisponível,
  // sem número inventado (mesma regra do modo mensal).
  assert.equal(corpo.expedicao.disponivel, false);
  assert.deepEqual(Object.keys(corpo.expedicao).sort(), ['comentarios', 'disponivel', 'proximosPassos'].sort());
});

test('periodo=range: início/fim inválidos ou fora de ordem devolvem 500 com mensagem, nunca um relatório com dado errado', async () => {
  const semDatas = await buscarRelatorioPeriodo('periodo=range');
  assert.equal(semDatas.status, 500);

  const foraDeOrdem = await buscarRelatorioPeriodo('periodo=range&inicio=2026-05-01&fim=2026-01-01');
  assert.equal(foraDeOrdem.status, 500);

  const formatoInvalido = await buscarRelatorioPeriodo('periodo=range&inicio=01-05-2026&fim=2026-05-31');
  assert.equal(formatoInvalido.status, 500);
});
