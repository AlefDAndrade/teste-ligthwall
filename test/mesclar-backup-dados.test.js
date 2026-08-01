// ─── test/mesclar-backup-dados.test.js ──────────────────────────────────────
// Cobertura formal de POST /mesclar-backup-dados (ver lib/rotas/backup.js) —
// até agora só validado manualmente. Diferente de /restaurar-backup-dados
// (que SUBSTITUI tudo), mesclar só faz INSERT — soma o conteúdo de um
// backup de OUTRA instalação ao banco atual, sem apagar nada; por mexer em
// histórico de produção real (operações, traços, paradas), merece o mesmo
// nível de cobertura que /registrar-operacao.
//
// Roda contra o server.js DE VERDADE (não um mock), numa cópia isolada —
// ver test/helpers/servidor-teste.js. Cobre:
//   - Exige a senha de administrador — senha errada é recusada (400).
//   - Caminho real: operações, traços (com seus usos) e paradas do backup
//     aparecem no sistema depois de mesclado, SEM apagar o que já existia
//     antes (mescla soma, não substitui).
//   - Deduplicação de operação por id — uma operação cujo id já existe no
//     sistema é contada como duplicata e não é reinserida.
//   - Deduplicação de traço por (id_operacao + num_traco) — um traço cujo
//     uso já existe é contado como duplicata.
//   - Deduplicação de parada por id.
//   - Nenhum arquivo mesclável presente no payload é recusado (400).
//   - JSON inválido dentro de um dos arquivos mescláveis é recusado (400)
//     com o nome do arquivo na mensagem.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-mesclar-backup-729';
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

function mesclar(payload) {
  return fetch(`${servidor.baseUrl}/mesclar-backup-dados`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

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

async function buscarOperacao(idOp) {
  const resp = await fetch(`${servidor.baseUrl}/db/historico.json`);
  const historico = await resp.json();
  return historico.find(o => o.id === idOp);
}

async function contarParadas() {
  const resp = await fetch(`${servidor.baseUrl}/db/paradas.json`);
  return (await resp.json()).length;
}

function operacaoDoBackup(idOp, extras = {}) {
  return {
    id: idOp, data: '2026-07-20', turno: '1° TURNO', dimensao: 9, capacidade: 20,
    id_bateria: 'B-backup', inicio: '2026-07-20T08:00:00.000Z', fim: '2026-07-20T09:00:00.000Z',
    tempo_min: 60, qtd_tracos: 3, total_paineis: 40, m2_total: 88.8,
    ...extras,
  };
}

function tracoDoBackup(idTraco, idOp, numTraco = 1) {
  return {
    id_traco: idTraco, data: '2026-07-20', turno: '1° TURNO', num_traco: numTraco,
    ultilizado: { operacao: [{ id_operacao: idOp, id_bateria: 'B-backup', berco_inicio: 1, berco_finalizacao: 5, obs: '' }] },
    cimento_real: 10, agua_real: 4, eps_real: 2, superplast_real: 0.5, incorporador_real: 0.2,
    tempo_batida: 120, densidade: 30, flow: 600,
  };
}

function paradaDoBackup(id) {
  return {
    id, inicio: '2026-07-20T10:00:00.000Z', fim: '2026-07-20T10:10:00.000Z',
    duracao_min: 10, motivo: 'Falta de material', equipamento: 'Injetora 1',
    classificacao: 'Planejada', obs: '', registrado_em: new Date().toISOString(), operador_nome: 'Backup',
  };
}

test('senha errada é recusada (400), nada é mesclado', async () => {
  const idOp = 'op-mesclar-senha-errada-' + Date.now();
  const resp = await mesclar({
    senha: 'senha-totalmente-errada',
    arquivos: { 'historico.json': JSON.stringify([operacaoDoBackup(idOp)]) },
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);
  assert.equal(await buscarOperacao(idOp), undefined);
});

test('nenhum arquivo mesclável no payload é recusado (400)', async () => {
  const resp = await mesclar({ senha: SENHA_ADMIN, arquivos: { 'config.json': '{}' } });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /mesclável/);
});

test('JSON inválido em um arquivo mesclável é recusado (400), com o nome do arquivo na mensagem', async () => {
  const resp = await mesclar({ senha: SENHA_ADMIN, arquivos: { 'historico.json': '{ isso nao e json valido' } });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /historico\.json/);
});

test('caminho real: mescla operações, traços e paradas SEM apagar o que já existia', async () => {
  // Operação já existente ANTES da mesclagem — prova que mesclar não apaga nada.
  const idOpJaExistente = 'op-preexistente-' + Date.now();
  await registrarOperacao(idOpJaExistente);

  const idOpBackup = 'op-do-backup-' + Date.now();
  const idTracoBackup = 'traco-do-backup-' + Date.now();
  const idParadaBackup = 'parada-do-backup-' + Date.now();
  const paradasAntes = await contarParadas();

  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: {
      'historico.json': JSON.stringify([operacaoDoBackup(idOpBackup)]),
      'relatorio_injecao.json': JSON.stringify([tracoDoBackup(idTracoBackup, idOpBackup)]),
      'ajustes_tracos.json': '[]',
      'paradas.json': JSON.stringify([paradaDoBackup(idParadaBackup)]),
    },
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
  assert.equal(data.resultado.operacoes.inseridos, 1);
  assert.equal(data.resultado.tracos.inseridos, 1);
  assert.equal(data.resultado.paradas.inseridos, 1);

  // A operação preexistente continua lá — mesclar não apaga nada.
  assert.ok(await buscarOperacao(idOpJaExistente), 'operação que já existia antes não deveria sumir');

  // As novas entradas do backup entraram.
  const opBackup = await buscarOperacao(idOpBackup);
  assert.ok(opBackup, 'operação do backup deveria ter sido inserida');
  assert.equal(opBackup.id_bateria, 'B-backup');

  const respTracos = await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`);
  const tracos = await respTracos.json();
  assert.ok(tracos.some(t => t.ultilizado.operacao.some(u => u.id_operacao === idOpBackup)));

  assert.equal(await contarParadas(), paradasAntes + 1, 'deveria ter exatamente +1 parada depois da mesclagem');
});

test('deduplicação: uma operação cujo id já existe é contada como duplicata, não reinserida', async () => {
  const idOp = 'op-duplicata-' + Date.now();
  await registrarOperacao(idOp, { id_bateria: 'B-real-atual' });

  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'historico.json': JSON.stringify([operacaoDoBackup(idOp, { id_bateria: 'B-do-backup-duplicado' })]) },
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.resultado.operacoes.inseridos, 0);
  assert.equal(data.resultado.operacoes.duplicatas, 1);

  // A versão já existente no sistema não foi sobrescrita pela do backup.
  const atual = await buscarOperacao(idOp);
  assert.equal(atual.id_bateria, 'B-real-atual', 'mesclar nunca sobrescreve — só insere o que não existe');
});

test('deduplicação: parada cujo id já existe é contada como duplicata, não reinserida', async () => {
  const idParada = 'parada-duplicata-' + Date.now();
  await fetch(`${servidor.baseUrl}/salvar-parada`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(paradaDoBackup(idParada)),
  });
  const paradasAntes = await contarParadas();

  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'paradas.json': JSON.stringify([paradaDoBackup(idParada)]) },
  });
  const data = await resp.json();
  assert.equal(data.resultado.paradas.inseridos, 0);
  assert.equal(data.resultado.paradas.duplicatas, 1);
  assert.equal(await contarParadas(), paradasAntes, 'não deveria ter criado uma parada nova (mesmo id)');
});
