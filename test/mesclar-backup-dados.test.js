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
//   - Filtro por data (opcional, `filtroDataInicio`/`filtroDataFim`):
//     traz só um período do backup (ex: 1 dia), ignora o resto — cada
//     domínio filtrado pelo seu próprio campo de data ("data" pra
//     operações/traços; "inicio" pra paradas); datas inválidas/invertidas
//     são recusadas; sem filtro, comportamento idêntico a sempre.
//   - 6 domínios "satélite" adicionados numa conversa posterior ("não
//     abarca alguns dados, como berço visual"): bercos_visuais.json,
//     avaliacoes_qualidade.json, operacoes_avaliadas.json,
//     relatorio_edicoes.json (edições de traço), manutencao_corretiva.json
//     e manutencao_programada.json — todos amarrados a uma operação/traço
//     já existente (no destino OU trazida na mesma mesclagem), nunca
//     criam um registro órfão; dedup por id (ou pela chave natural
//     traço+data, no caso de edições de traço — "id" é autoincrement,
//     não confiável entre instalações diferentes).

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

// ═══════════════════════════════════════════════════════════════════════
// Filtro por data (pedido — "quero subir apenas os dados de um dia
// específico"): opcional, `filtroDataInicio`/`filtroDataFim` no payload.
// Sem eles, comportamento IDÊNTICO a sempre (já coberto pelos testes
// acima). Com eles, só entra no merge o que cai dentro do intervalo —
// mesmo que o resto do backup fosse tudo registro novo/não-duplicata.
// ═══════════════════════════════════════════════════════════════════════

test('filtroDataInicio+filtroDataFim iguais (um único dia): só traz operações daquele dia, ignora o resto do backup', async () => {
  const idDentro = 'op-filtro-dentro-' + Date.now();
  const idFora = 'op-filtro-fora-' + Date.now();
  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: {
      'historico.json': JSON.stringify([
        operacaoDoBackup(idDentro, { data: '2026-09-04' }),
        operacaoDoBackup(idFora, { data: '2026-09-03' }),
      ]),
    },
    filtroDataInicio: '2026-09-04',
    filtroDataFim: '2026-09-04',
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.resultado.operacoes.inseridos, 1);
  assert.deepEqual(data.resultado.filtroData, { inicio: '2026-09-04', fim: '2026-09-04', ignorados: 1 });

  assert.ok(await buscarOperacao(idDentro), 'operação do dia filtrado deveria ter entrado');
  assert.equal(await buscarOperacao(idFora), undefined, 'operação de outro dia NÃO deveria ter entrado');
});

test('filtro de data se aplica também a traços e paradas, cada um pelo seu próprio campo de data (traço: "data"; parada: "inicio")', async () => {
  const idOpDentro = 'op-filtro2-dentro-' + Date.now();
  const idTracoDentro = 'traco-filtro-dentro-' + Date.now();
  const idTracoFora = 'traco-filtro-fora-' + Date.now();
  const idParadaDentro = 'parada-filtro-dentro-' + Date.now();
  const idParadaFora = 'parada-filtro-fora-' + Date.now();

  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: {
      'relatorio_injecao.json': JSON.stringify([
        { ...tracoDoBackup(idTracoDentro, idOpDentro), data: '2026-09-04' },
        { ...tracoDoBackup(idTracoFora, idOpDentro, 2), data: '2026-09-03' },
      ]),
      'paradas.json': JSON.stringify([
        { ...paradaDoBackup(idParadaDentro), inicio: '2026-09-04T10:00:00.000Z', fim: '2026-09-04T10:10:00.000Z' },
        { ...paradaDoBackup(idParadaFora), inicio: '2026-09-03T10:00:00.000Z', fim: '2026-09-03T10:10:00.000Z' },
      ]),
    },
    filtroDataInicio: '2026-09-04',
    filtroDataFim: '2026-09-04',
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.resultado.tracos.inseridos, 1);
  assert.equal(data.resultado.paradas.inseridos, 1);
  assert.equal(data.resultado.filtroData.ignorados, 2); // 1 traço + 1 parada fora do período
});

test('filtro só com "de" (sem "até"): traz tudo A PARTIR daquela data em diante', async () => {
  const idAntes = 'op-filtro-so-inicio-antes-' + Date.now();
  const idDepois = 'op-filtro-so-inicio-depois-' + Date.now();
  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: {
      'historico.json': JSON.stringify([
        operacaoDoBackup(idAntes, { data: '2026-09-01' }),
        operacaoDoBackup(idDepois, { data: '2026-09-04' }),
      ]),
    },
    filtroDataInicio: '2026-09-04',
  });
  const data = await resp.json();
  assert.equal(data.resultado.operacoes.inseridos, 1);
  assert.ok(await buscarOperacao(idDepois));
  assert.equal(await buscarOperacao(idAntes), undefined);
});

test('data inicial depois da data final é recusada (400), nada é mesclado', async () => {
  const idOp = 'op-filtro-datas-invertidas-' + Date.now();
  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'historico.json': JSON.stringify([operacaoDoBackup(idOp, { data: '2026-09-04' })]) },
    filtroDataInicio: '2026-09-10',
    filtroDataFim: '2026-09-04',
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /data inicial/i);
  assert.equal(await buscarOperacao(idOp), undefined);
});

test('formato de data inválido no filtro é recusado (400)', async () => {
  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'historico.json': JSON.stringify([operacaoDoBackup('op-filtro-formato-invalido')]) },
    filtroDataInicio: '04/09/2026', // formato errado de propósito (esperado: AAAA-MM-DD)
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.match(data.erro, /formato/i);
});

test('sem filtro nenhum (comportamento de sempre): resultado.filtroData vem null', async () => {
  const idOp = 'op-sem-filtro-' + Date.now();
  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'historico.json': JSON.stringify([operacaoDoBackup(idOp)]) },
  });
  const data = await resp.json();
  assert.equal(data.resultado.filtroData, null);
  assert.ok(await buscarOperacao(idOp));
});

// ═══════════════════════════════════════════════════════════════════════
// 6 domínios "satélite" adicionados nesta mudança (conversa que motivou:
// "não abarca alguns dados, como berço visual"). Todos amarrados a uma
// operação/traço já existente — helpers/asserções abaixo.
// ═══════════════════════════════════════════════════════════════════════

function bercoVisualDoBackup(idOp, extras = {}) {
  return {
    id_operacao: idOp,
    bercos: [{ berco: 1, ordem: 1, estado_esquerda: 'ok', estado_direita: 'ok' }],
    atualizado_em: new Date().toISOString(),
    ...extras,
  };
}

function avaliacaoDoBackup(id, idOp, extras = {}) {
  return {
    id, linkedOperacaoId: idOp, batteryId: 'B-backup', turno: '1° TURNO',
    registeredAt: '2026-07-20T10:00:00.000Z', avaliadorNome: 'Backup', paineis: [],
    ...extras,
  };
}

function edicaoTracoDoBackup(idTraco, idOp, dataEdicao) {
  return { id_traco: idTraco, id_operacao: idOp, data_edicao: dataEdicao, campos_alterados: [{ campo: 'cimento_real', de: 300, para: 310 }] };
}

function manutencaoCorretivaDoBackup(id, extras = {}) {
  return {
    id, data: '2026-07-20', setor: 'Injetora', maquina: 'Injetora 1', turno: '1° TURNO',
    observador: 'Backup', prioridade: 'Media', anomalia: 'Ruído estranho', tipoManutencao: 'Mecânica',
    ...extras,
  };
}

function manutencaoProgramadaDoBackup(id, extras = {}) {
  return {
    id, data: '2026-07-20', setor: 'Injetora', maquina: 'Injetora 1', solicitante: 'Backup',
    ...extras,
  };
}

async function contarLinhas(nomeArquivo) {
  const resp = await fetch(`${servidor.baseUrl}/db/${nomeArquivo}`);
  return (await resp.json()).length;
}

test('bercos_visuais: só entra se a operação "dona" também existir (no destino ou neste mesmo backup) — nunca cria um órfão', async () => {
  // Mesclando (não via /registrar-operacao, que já cria um berço visual
  // inicial sozinho — usaríamos o caminho errado pra este teste, ver
  // criarBercosVisuaisIniciais) a operação "dona" primeiro, sem berço
  // visual nenhum.
  const idOpExiste = 'op-bv-existe-' + Date.now();
  await mesclar({ senha: SENHA_ADMIN, arquivos: { 'historico.json': JSON.stringify([operacaoDoBackup(idOpExiste)]) } });
  const idOpNaoExiste = 'op-bv-nao-existe-' + Date.now();

  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'bercos_visuais.json': JSON.stringify([bercoVisualDoBackup(idOpExiste), bercoVisualDoBackup(idOpNaoExiste)]) },
  });
  const data = await resp.json();
  assert.equal(data.resultado.bercos_visuais.inseridos, 1);
  assert.equal(data.resultado.bercos_visuais.sem_operacao, 1);
});

test('bercos_visuais: também entra se a operação "dona" foi trazida NESTA MESMA mesclagem (historico.json junto)', async () => {
  const idOp = 'op-bv-junto-' + Date.now();
  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: {
      'historico.json': JSON.stringify([operacaoDoBackup(idOp)]),
      'bercos_visuais.json': JSON.stringify([bercoVisualDoBackup(idOp)]),
    },
  });
  const data = await resp.json();
  assert.equal(data.resultado.operacoes.inseridos, 1);
  assert.equal(data.resultado.bercos_visuais.inseridos, 1);
});

test('bercos_visuais: id_operacao duplicado (já existe) é contado como duplicata, nunca sobrescreve', async () => {
  const idOp = 'op-bv-dup-' + Date.now();
  await registrarOperacao(idOp);
  await mesclar({ senha: SENHA_ADMIN, arquivos: { 'bercos_visuais.json': JSON.stringify([bercoVisualDoBackup(idOp)]) } });

  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'bercos_visuais.json': JSON.stringify([bercoVisualDoBackup(idOp, { bercos: [{ berco: 99, ordem: 1, estado_esquerda: 'diferente', estado_direita: 'diferente' }] })]) },
  });
  const data = await resp.json();
  assert.equal(data.resultado.bercos_visuais.inseridos, 0);
  assert.equal(data.resultado.bercos_visuais.duplicatas, 1);
});

test('avaliacoes_qualidade: entra pelo id (não depende de operação existir — linkedOperacaoId pode ser nulo)', async () => {
  const idAval = 'aval-' + Date.now();
  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'avaliacoes_qualidade.json': JSON.stringify([avaliacaoDoBackup(idAval, null)]) },
  });
  const data = await resp.json();
  assert.equal(data.resultado.avaliacoes_qualidade.inseridos, 1);
  assert.ok((await contarLinhas('avaliacoes_qualidade.json')) >= 1);
});

test('avaliacoes_qualidade: id duplicado é contado como duplicata, não reinserido/sobrescrito', async () => {
  const idAval = 'aval-dup-' + Date.now();
  await mesclar({ senha: SENHA_ADMIN, arquivos: { 'avaliacoes_qualidade.json': JSON.stringify([avaliacaoDoBackup(idAval, null)]) } });

  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'avaliacoes_qualidade.json': JSON.stringify([avaliacaoDoBackup(idAval, null, { avaliadorNome: 'Outro Nome' })]) },
  });
  const data = await resp.json();
  assert.equal(data.resultado.avaliacoes_qualidade.inseridos, 0);
  assert.equal(data.resultado.avaliacoes_qualidade.duplicatas, 1);
});

test('operacoes_avaliadas: só entra se a operação existir; duplicata por id_operacao é ignorada', async () => {
  const idOp = 'op-avaliada-' + Date.now();
  await registrarOperacao(idOp);
  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'operacoes_avaliadas.json': JSON.stringify([{ id_operacao: idOp, avaliado_em: new Date().toISOString() }]) },
  });
  const data = await resp.json();
  assert.equal(data.resultado.operacoes_avaliadas.inseridos, 1);

  const respDup = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'operacoes_avaliadas.json': JSON.stringify([{ id_operacao: idOp, avaliado_em: new Date().toISOString() }]) },
  });
  const dataDup = await respDup.json();
  assert.equal(dataDup.resultado.operacoes_avaliadas.inseridos, 0);
  assert.equal(dataDup.resultado.operacoes_avaliadas.duplicatas, 1);
});

test('relatorio_edicoes.json: precisa vir JUNTO de relatorio_injecao.json no mesmo backup — o id_traco de origem é traduzido pro novo id gerado na mesclagem', async () => {
  const idOp = 'op-edicao-traco-' + Date.now();
  const idTracoOrigem = 'traco-edicao-' + Date.now(); // id de origem, do backup — NUNCA sobrevive à mesclagem
  const dataEdicao = '2026-07-21T09:00:00.000Z';

  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: {
      'relatorio_injecao.json': JSON.stringify([tracoDoBackup(idTracoOrigem, idOp)]),
      'relatorio_edicoes.json': JSON.stringify([edicaoTracoDoBackup(idTracoOrigem, idOp, dataEdicao)]),
    },
  });
  const data = await resp.json();
  assert.equal(data.resultado.tracos.inseridos, 1);
  assert.equal(data.resultado.edicoes_traco.inseridos, 1);

  // A edição tem que ter caído no id_traco REAL do destino (sintético,
  // gerado pela mesclagem) — nunca no id_traco de origem, que não existe
  // em lugar nenhum do banco de destino.
  const respHistoricoEdicoes = await fetch(`${servidor.baseUrl}/db/relatorio_edicoes.json`);
  const edicoes = await respHistoricoEdicoes.json();
  const edicaoGravada = edicoes.find(e => e.data_edicao === dataEdicao);
  assert.ok(edicaoGravada, 'esperava a edição gravada em algum id_traco');
  assert.notEqual(edicaoGravada.id_traco, idTracoOrigem, 'não deveria ter usado o id_traco de origem — esse id não existe no destino');
});

test('relatorio_edicoes.json: mesma chave (traço traduzido + data) de novo não duplica, mesmo com "id" autoincrement diferente', async () => {
  const idOp = 'op-edicao-traco-dup-' + Date.now();
  const idTracoOrigem = 'traco-edicao-dup-' + Date.now();
  const dataEdicao = '2026-07-21T09:00:00.000Z';

  await mesclar({
    senha: SENHA_ADMIN,
    arquivos: {
      'relatorio_injecao.json': JSON.stringify([tracoDoBackup(idTracoOrigem, idOp)]),
      'relatorio_edicoes.json': JSON.stringify([edicaoTracoDoBackup(idTracoOrigem, idOp, dataEdicao)]),
    },
  });

  // Mesmo backup (mesmo traço de origem, mesma data de edição) mesclado
  // de novo — desta vez o traço já existe (vira duplicata), e a edição
  // precisa continuar resolvendo pro MESMO id_traco de destino (não um
  // novo, já que o traço não foi reinserido) e não duplicar.
  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: {
      'relatorio_injecao.json': JSON.stringify([tracoDoBackup(idTracoOrigem, idOp)]),
      'relatorio_edicoes.json': JSON.stringify([{ ...edicaoTracoDoBackup(idTracoOrigem, idOp, dataEdicao), id: 999999 }]),
    },
  });
  const data = await resp.json();
  assert.equal(data.resultado.tracos.duplicatas, 1);
  assert.equal(data.resultado.edicoes_traco.inseridos, 0, 'já tinha essa edição pro mesmo traço — não deveria duplicar');
});

test('relatorio_edicoes.json: SEM relatorio_injecao.json no mesmo backup, é ignorado silenciosamente (não dá pra saber a qual traço pertenceria)', async () => {
  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'relatorio_edicoes.json': JSON.stringify([edicaoTracoDoBackup('traco-orfao-' + Date.now(), 'op-x', '2026-07-21T09:00:00.000Z')]) },
  });
  const data = await resp.json();
  assert.equal(data.resultado.edicoes_traco.inseridos, 0);
});

test('manutencao_corretiva: insere por id novo, ignora duplicata, respeita filtro de data quando pedido', async () => {
  const idChamado = 'manut-corretiva-' + Date.now();
  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'manutencao_corretiva.json': JSON.stringify([manutencaoCorretivaDoBackup(idChamado)]) },
  });
  const data = await resp.json();
  assert.equal(data.resultado.manutencao_corretiva.inseridos, 1);

  const respDup = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'manutencao_corretiva.json': JSON.stringify([manutencaoCorretivaDoBackup(idChamado, { anomalia: 'Anomalia diferente' })]) },
  });
  const dataDup = await respDup.json();
  assert.equal(dataDup.resultado.manutencao_corretiva.inseridos, 0);
  assert.equal(dataDup.resultado.manutencao_corretiva.duplicatas, 1);

  // Filtro de data — chamado de outro dia fica de fora.
  const idFora = 'manut-corretiva-fora-' + Date.now();
  const respFiltro = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'manutencao_corretiva.json': JSON.stringify([manutencaoCorretivaDoBackup(idFora, { data: '2026-01-01' })]) },
    filtroDataInicio: '2026-07-20',
    filtroDataFim: '2026-07-20',
  });
  const dataFiltro = await respFiltro.json();
  assert.equal(dataFiltro.resultado.manutencao_corretiva.inseridos, 0);
  assert.equal(dataFiltro.resultado.filtroData.ignorados, 1);
});

test('manutencao_programada: insere por id novo, ignora duplicata', async () => {
  const idAgendamento = 'manut-programada-' + Date.now();
  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'manutencao_programada.json': JSON.stringify([manutencaoProgramadaDoBackup(idAgendamento)]) },
  });
  const data = await resp.json();
  assert.equal(data.resultado.manutencao_programada.inseridos, 1);

  const respDup = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'manutencao_programada.json': JSON.stringify([manutencaoProgramadaDoBackup(idAgendamento)]) },
  });
  const dataDup = await respDup.json();
  assert.equal(dataDup.resultado.manutencao_programada.inseridos, 0);
  assert.equal(dataDup.resultado.manutencao_programada.duplicatas, 1);
});

// ═══════════════════════════════════════════════════════════════════════
// Bug real (conversa que motivou): "clico numa operação mesclada e joga
// pra traço, nenhum filtro funciona — filtro por id do traço não
// funciona, e pelo id da bateria só mostra a data mesclada". Causa:
// operacoes.tracos_json é uma FOTOGRAFIA gravada no INSERT
// (operacaoParaRow) — pro registro ao vivo, os ids nascem juntos e nunca
// mudam; mas mesclarTracosEAjustes sempre troca o id_traco por um novo
// sintético, deixando a fotografia da operação apontando pros ids
// ANTIGOS do backup de origem, que não existem no destino.
// ═══════════════════════════════════════════════════════════════════════

test('operacoes.tracos_json de uma operação mesclada aponta pros id_traco REAIS do destino, nunca pros ids de origem do backup', async () => {
  const idOp = 'op-tracosjson-' + Date.now();
  const idTracoOrigem1 = 'traco-origem-1-' + Date.now();
  const idTracoOrigem2 = 'traco-origem-2-' + Date.now();

  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: {
      'historico.json': JSON.stringify([operacaoDoBackup(idOp, {
        tracos: [{ id: idTracoOrigem1 }, { id: idTracoOrigem2 }],
      })]),
      'relatorio_injecao.json': JSON.stringify([
        tracoDoBackup(idTracoOrigem1, idOp, 1),
        tracoDoBackup(idTracoOrigem2, idOp, 2),
      ]),
    },
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.resultado.operacoes.inseridos, 1);
  assert.equal(data.resultado.tracos.inseridos, 2);

  const operacao = await buscarOperacao(idOp);
  assert.ok(operacao, 'esperava a operação mesclada em db/historico.json');
  assert.ok(Array.isArray(operacao.tracos) && operacao.tracos.length === 2, 'esperava 2 traços em operacao.tracos');

  const idsEmTracosJson = operacao.tracos.map(t => t.id);
  // NUNCA os ids de origem — eles não existem em lugar nenhum do destino.
  assert.ok(!idsEmTracosJson.includes(idTracoOrigem1), 'tracos_json não deveria referenciar o id_traco de ORIGEM (não existe no destino)');
  assert.ok(!idsEmTracosJson.includes(idTracoOrigem2), 'tracos_json não deveria referenciar o id_traco de ORIGEM (não existe no destino)');

  // Cada id em tracos_json precisa ser um id_traco de verdade, existente
  // no relatorio_injecao.json do destino — é isso que
  // navegarParaTracosDoRegistro (dashboard.js) usa pra montar o filtro.
  const todosOsTracos = await (await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`)).json();
  const idsRealDeVerdade = new Set(todosOsTracos.map(t => t.id_traco));
  for (const id of idsEmTracosJson) {
    assert.ok(idsRealDeVerdade.has(id), `tracos_json referencia "${id}", que não existe em relatorio_injecao.json`);
  }
});

test('self-healing: mesclando relatorio_injecao.json DEPOIS (operação já existia sem esses traços), tracos_json da operação é corrigido mesmo assim', async () => {
  const idOp = 'op-tracosjson-tardio-' + Date.now();
  const idTracoOrigem = 'traco-origem-tardio-' + Date.now();

  // 1ª mesclagem: só a operação, sem traço nenhum (tracos_json fica vazio).
  await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'historico.json': JSON.stringify([operacaoDoBackup(idOp, { tracos: [] })]) },
  });
  const antes = await buscarOperacao(idOp);
  assert.deepEqual(antes.tracos, []);

  // 2ª mesclagem, depois: só o traço, referenciando a MESMA operação (já
  // existente no destino) — tracos_json da operação deveria se atualizar
  // mesmo sem historico.json vir de novo.
  const resp = await mesclar({
    senha: SENHA_ADMIN,
    arquivos: { 'relatorio_injecao.json': JSON.stringify([tracoDoBackup(idTracoOrigem, idOp, 1)]) },
  });
  assert.equal(resp.status, 200);

  const depois = await buscarOperacao(idOp);
  assert.equal(depois.tracos.length, 1, 'tracos_json deveria ter sido atualizado mesmo a operação não fazendo parte desta 2ª mesclagem');
  assert.notEqual(depois.tracos[0].id, idTracoOrigem, 'não deveria ser o id de origem — deveria ser o id real gerado na mesclagem');

  const todosOsTracos = await (await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`)).json();
  assert.ok(todosOsTracos.some(t => t.id_traco === depois.tracos[0].id), 'o id em tracos_json precisa existir de verdade em relatorio_injecao.json');
});
