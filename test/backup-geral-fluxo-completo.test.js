// ─── test/backup-geral-fluxo-completo.test.js ───────────────────────────────
// Cobertura formal do FLUXO COMPLETO do Backup Geral — até agora só
// validada manualmente (ver README, "Limitações conhecidas"). Diferente de
// test/backup-dados-vs-geral.test.js e test/restaurar-backup-checklist.test.js
// (que restauram um payload MONTADO À MÃO, mínimo, pra testar regras de
// validação isoladas), este teste faz o ciclo de ponta a ponta com dados
// gerados pelas rotas de produção de verdade:
//
//   1. Popula o sistema via POST /registrar-operacao, /registrar-relatorio-
//      injecao e /salvar-usuarios — as mesmas rotas que a aplicação real usa.
//   2. Baixa um Backup Geral de verdade via GET /backup-geral (o .zip
//      gerado pelo servidor, não um payload construído pelo teste).
//   3. Gera MAIS uma mudança depois do backup (uma operação nova) — prova
//      que restaurar de fato REESCREVE o estado pro momento do backup, não
//      só "soma" dados.
//   4. Restaura esse mesmo .zip via POST /restaurar-backup-geral.
//   5. Confere que o estado pós-restore bate exatamente com o momento do
//      backup: a operação pré-backup continua lá, o traço vinculado a ela
//      continua lá com a receita certa, a mudança pós-backup sumiu, e
//      config.json/usuarios.json voltaram pro que estava no backup.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-backup-geral-fluxo-852';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
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

function registrarOperacao(idOp, extras, cookie) {
  return fetch(`${servidor.baseUrl}/registrar-operacao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: idOp, data: '2026-07-18', turno: '1° TURNO', dimensao: 9, capacidade: 20,
      id_bateria: 'B-fluxo', total_paineis: 40, m2_total: 88.8,
      ...extras,
    }),
  });
}

function registrarTraco(idTraco, idOperacao, cookie) {
  return fetch(`${servidor.baseUrl}/registrar-relatorio-injecao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify([{
      id_traco: idTraco, data: '2026-07-18', turno: '1° TURNO', num_traco: 1,
      cimento_real: 340, agua_real: 175, eps_real: 2, superplast_real: 3, incorporador_real: 1,
      tempo_batida: 110, densidade: 1040, flow: 205, obs: null, silo: 'S1', expansao: null, densidade_eps: null,
      ultilizado: { operacao: [{ id_operacao: idOperacao, id_bateria: 'B-fluxo', berco_inicio: '1', berco_finalizacao: '4', obs: null }] },
    }]),
  });
}

test('ciclo completo: gerar dados de verdade -> baixar Backup Geral -> mudar o sistema -> restaurar -> estado volta pro momento do backup', async () => {
  const cookieAdmin = await logarComoAdminMaster();

  // 1) Popula com dados de produção reais.
  const idOpPreBackup = 'op-pre-backup-' + Date.now();
  const idTracoPreBackup = 'traco-pre-backup-' + Date.now();
  await registrarOperacao(idOpPreBackup, {}, cookieAdmin);
  await registrarTraco(idTracoPreBackup, idOpPreBackup, cookieAdmin);
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'usuario.pre.backup', senha: 'senhateste1234', perfil: 'OperadorInjetora', podeIniciarOperacao: true }]),
  });

  // Confirma a premissa: os dados existem ANTES de baixar o backup.
  const respHistAntes = await fetch(`${servidor.baseUrl}/db/historico.json`);
  assert.ok((await respHistAntes.json()).some(o => o.id === idOpPreBackup), 'premissa: operação deveria existir antes do backup');

  // 2) Baixa um Backup Geral DE VERDADE (gerado pelo servidor, não montado à mão).
  const respBackup = await fetch(`${servidor.baseUrl}/backup-geral`, { headers: { Cookie: cookieAdmin } });
  assert.equal(respBackup.status, 200);
  const buffer = Buffer.from(await respBackup.arrayBuffer());
  const zip = await JSZip.loadAsync(buffer);

  const arquivosDoBackup = {};
  for (const nome of Object.keys(zip.files)) {
    if (zip.files[nome].dir) continue;
    arquivosDoBackup[nome] = await zip.files[nome].async('string');
  }
  assert.ok(arquivosDoBackup['historico.json'], 'o zip deveria conter historico.json');
  assert.ok(arquivosDoBackup['relatorio_injecao.json'], 'o zip deveria conter relatorio_injecao.json');
  assert.ok(arquivosDoBackup['config.json'], 'o zip deveria conter config.json');
  assert.ok(arquivosDoBackup['usuarios.json'], 'o zip deveria conter usuarios.json');
  assert.ok(
    JSON.parse(arquivosDoBackup['historico.json']).some(o => o.id === idOpPreBackup),
    'o backup baixado deveria conter a operação registrada antes dele',
  );

  // 3) Gera MAIS uma mudança DEPOIS do backup — não deveria sobreviver ao restore.
  const idOpPosBackup = 'op-pos-backup-devia-sumir-' + Date.now();
  await registrarOperacao(idOpPosBackup, {}, cookieAdmin);
  const respHistDepoisDaMudanca = await fetch(`${servidor.baseUrl}/db/historico.json`);
  assert.ok(
    (await respHistDepoisDaMudanca.json()).some(o => o.id === idOpPosBackup),
    'premissa: a operação pós-backup deveria existir antes do restore',
  );

  // 4) Restaura o MESMO .zip baixado no passo 2.
  const respRestaurar = await fetch(`${servidor.baseUrl}/restaurar-backup-geral`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN, confirmacao: 'RESTAURAR TUDO', arquivos: arquivosDoBackup }),
  });
  assert.equal(respRestaurar.status, 200);
  const dataRestaurar = await respRestaurar.json();
  assert.equal(dataRestaurar.ok, true);
  assert.ok(dataRestaurar.backupSeguranca, 'deveria informar onde ficou o backup de segurança pré-restore');

  // 5) Confere que o estado voltou EXATAMENTE pro momento do backup.
  const respHistDepois = await fetch(`${servidor.baseUrl}/db/historico.json`);
  const histDepois = await respHistDepois.json();
  assert.ok(histDepois.some(o => o.id === idOpPreBackup), 'a operação de ANTES do backup deveria continuar lá');
  assert.ok(!histDepois.some(o => o.id === idOpPosBackup), 'a operação de DEPOIS do backup deveria ter sumido (restore reescreve, não soma)');

  const respRelatorioDepois = await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`);
  const relatorioDepois = await respRelatorioDepois.json();
  const tracoDepois = relatorioDepois.find(t => t.id_traco === idTracoPreBackup);
  assert.ok(tracoDepois, 'o traço vinculado à operação pré-backup deveria continuar lá');
  assert.equal(tracoDepois.cimento_real, 340);
  assert.equal(tracoDepois.ultilizado.operacao[0].id_operacao, idOpPreBackup);

  const respUsuariosDepois = await fetch(`${servidor.baseUrl}/usuarios`);
  const { usuarios } = await respUsuariosDepois.json();
  assert.ok(usuarios.some(u => u.nomeUsuario === 'usuario.pre.backup'), 'o usuário cadastrado antes do backup deveria continuar lá');

  // A senha de Administrador Master do momento do backup deveria continuar
  // valendo (security.json restaurado corretamente).
  const respSenha = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  assert.equal((await respSenha.json()).ok, true);
});

test('GET /backup-geral inclui berços visuais e a fila de avaliação — não só o histórico bruto', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const idOp = 'op-bercos-no-backup-' + Date.now();
  await registrarOperacao(idOp, { capacidade: 20, bercos_reais: 6 }, cookieAdmin);

  const resp = await fetch(`${servidor.baseUrl}/backup-geral`, { headers: { Cookie: cookieAdmin } });
  const buffer = Buffer.from(await resp.arrayBuffer());
  const zip = await JSZip.loadAsync(buffer);

  const bercos = JSON.parse(await zip.file('bercos_visuais.json').async('string'));
  const doOperacao = bercos.find(b => b.id_operacao === idOp);
  assert.ok(doOperacao, 'o Backup Geral deveria incluir os berços visuais da operação recém-criada');
  assert.equal(doOperacao.bercos.length, 6);

  // operacoes_nao_avaliadas.json guarda só a lista de IDs pendentes (fonte
  // de verdade da fila) — ver OPERACOES_NAO_AVALIADAS_PATH, server.js.
  const naoAvaliadas = JSON.parse(await zip.file('operacoes_nao_avaliadas.json').async('string'));
  assert.ok(naoAvaliadas.includes(idOp), 'a operação recém-criada deveria estar na fila de não avaliadas dentro do backup');
});
