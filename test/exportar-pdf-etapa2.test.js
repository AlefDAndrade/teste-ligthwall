// ─── test/exportar-pdf-etapa2.test.js ────────────────────────────────────
// Etapa 2 do plano "PDF sobrevive a fechar a aba" (ver README, e o
// comentário grande no topo de lib/rotas/exportar-pdf.js): "só pode gerar
// outro PDF depois de decidir o que fazer com esse".
//
// Cobre: POST /iniciar recusa (409) um segundo job enquanto o usuário já
// tem um "ativo" (processando OU concluido-aguardando-decisão);
// GET /meu-status devolve esse job ativo (ou null); POST /descartar/:jobId
// é a única forma de liberar o slot sem baixar; dono errado não consegue
// descartar job de outra pessoa; jobs de usuários diferentes nunca se
// bloqueiam entre si.
//
// Sem Chromium instalado na máquina de teste (ambiente de CI/sandbox
// comum, ver deploy/instalar-chromium-pdf.sh), POST /iniciar nunca chega a
// criar um job de verdade — por isso os testes que precisam de um job já
// 'processando'/'concluido' SEMEIAM a linha direto no SQLite (mesmo banco
// que o servidor de teste usa, `<pastaTemp>/data/lightwall.sqlite`), com
// uma conexão própria e curta (abre, escreve, fecha na hora — WAL mode,
// ver db.js, tolera isso bem) — sem depender da geração de PDF em si, que
// já é coberta por test/analise-focada-pdf-pagina-unica.test.js (a
// montagem do HTML) e pela suíte manual/deploy real (a conversão PDF de
// verdade, que exige Chromium).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-teste-exportar-pdf-etapa2-778';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let pastaScratch; // pra arquivos .pdf de mentira usados nas linhas semeadas

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
  pastaScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-exportar-pdf-etapa2-'));
});

after(async () => {
  await servidor.parar();
  fs.rmSync(pastaScratch, { recursive: true, force: true });
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

// Mesmo padrão de test/atalhos-por-usuario.test.js.
async function cadastrarELogar(nomeUsuario, perfil) {
  const cookieAdmin = await logarComoAdminMaster();
  const respAtuais = await fetch(`${servidor.baseUrl}/usuarios`);
  const { usuarios: atuais } = await respAtuais.json();
  const listaParaEnviar = [
    ...atuais.map(u => ({ id: u.id, nomeUsuario: u.nomeUsuario, perfil: u.perfil, podeIniciarOperacao: u.podeIniciarOperacao })),
    { nomeUsuario, senha: 'senhateste1234', perfil },
  ];
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify(listaParaEnviar),
  });
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario, senha: 'senhateste1234' }),
  });
  return extrairCookie(respLogin);
}

async function obterUsuarioId(cookie) {
  const resp = await fetch(`${servidor.baseUrl}/minha-sessao`, { headers: { Cookie: cookie } });
  const dados = await resp.json();
  assert.equal(dados.ok, true, 'cookie deveria corresponder a uma sessão de usuário válida');
  return dados.usuarioId;
}

// Escreve a linha direto no banco do servidor de teste (ver comentário no
// topo do arquivo) — abre, escreve, fecha na mesma chamada.
function semearExportacaoPdf({ jobId, usuarioId, nomeArquivo = 'teste.pdf', status, caminhoArquivo = null, criadoEm = Date.now(), concluidoEm = null }) {
  const dbPath = path.join(servidor.pastaTemp, 'data', 'lightwall.sqlite');
  const conexao = new Database(dbPath);
  try {
    conexao.prepare(`
      INSERT INTO exportacoes_pdf (job_id, usuario_id, nome_arquivo, status, caminho_arquivo, criado_em, concluido_em)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, usuarioId, nomeArquivo, status, caminhoArquivo, criadoEm, concluidoEm);
  } finally {
    conexao.close();
  }
}

function lerExportacaoPdf(jobId) {
  const dbPath = path.join(servidor.pastaTemp, 'data', 'lightwall.sqlite');
  const conexao = new Database(dbPath);
  try {
    return conexao.prepare('SELECT * FROM exportacoes_pdf WHERE job_id = ?').get(jobId);
  } finally {
    conexao.close();
  }
}

function novoJobIdFalso() {
  return crypto.randomBytes(16).toString('hex'); // mesmo formato de _idJobValido (32 hex)
}

// Atualiza só o `status` de uma linha já semeada — usado pra "limpar" um
// job de teste que não deve mais contar como ativo (evita vazar entre
// testes que reusam o MESMO usuarioId, ex.: ADMIN_MASTER_USUARIO_ID, fixo
// e compartilhado pelo mesmo servidor/banco em todo o arquivo).
function marcarStatusExportacaoPdf(jobId, status) {
  const dbPath = path.join(servidor.pastaTemp, 'data', 'lightwall.sqlite');
  const conexao = new Database(dbPath);
  try {
    conexao.prepare('UPDATE exportacoes_pdf SET status = ?, concluido_em = ? WHERE job_id = ?').run(status, Date.now(), jobId);
  } finally {
    conexao.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Bloqueio: "um job ativo por usuário"
// ═══════════════════════════════════════════════════════════════════════

test('POST /iniciar recusa (409) um segundo job enquanto o usuário tem um "processando"', async () => {
  const cookie = await cadastrarELogar('usuario-etapa2-processando', 'Supervisao');
  const usuarioId = await obterUsuarioId(cookie);
  const jobIdExistente = novoJobIdFalso();
  semearExportacaoPdf({ jobId: jobIdExistente, usuarioId, status: 'processando' });

  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/iniciar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ html: '<html><body>oi</body></html>', filename: 'novo.pdf' }),
  });
  assert.equal(resp.status, 409);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);
  assert.equal(corpo.jobId, jobIdExistente);
  assert.equal(corpo.status, 'processando');
});

test('POST /iniciar recusa (409) um segundo job enquanto o usuário tem um "concluido" (aguardando decisão)', async () => {
  const cookie = await cadastrarELogar('usuario-etapa2-concluido', 'Supervisao');
  const usuarioId = await obterUsuarioId(cookie);
  const jobIdExistente = novoJobIdFalso();
  const caminhoArquivo = path.join(pastaScratch, jobIdExistente + '.pdf');
  fs.writeFileSync(caminhoArquivo, '%PDF-fake-conteudo-de-teste%');
  semearExportacaoPdf({ jobId: jobIdExistente, usuarioId, status: 'concluido', caminhoArquivo, concluidoEm: Date.now() });

  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/iniciar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ html: '<html><body>oi</body></html>', filename: 'novo.pdf' }),
  });
  assert.equal(resp.status, 409);
  const corpo = await resp.json();
  assert.equal(corpo.jobId, jobIdExistente);
  assert.equal(corpo.status, 'concluido');
});

test('POST /iniciar NÃO bloqueia por causa do job de OUTRO usuário', async () => {
  const cookieA = await cadastrarELogar('usuario-etapa2-isolamento-a', 'Supervisao');
  const usuarioIdA = await obterUsuarioId(cookieA);
  const cookieB = await cadastrarELogar('usuario-etapa2-isolamento-b', 'Supervisao');

  semearExportacaoPdf({ jobId: novoJobIdFalso(), usuarioId: usuarioIdA, status: 'processando' });

  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/iniciar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieB },
    body: JSON.stringify({ html: '<html><body>oi</body></html>', filename: 'novo.pdf' }),
  });
  // Usuário B não tem job próprio pendente — não deveria ser 409 (pode
  // ser 500 se a máquina de teste não tiver Chromium, o que não tem
  // relação com o bloqueio por usuário).
  assert.notEqual(resp.status, 409);
});

test('POST /iniciar NÃO bloqueia por causa de job "erro"/"cancelado" do mesmo usuário — só processando/concluido contam', async () => {
  const cookie = await cadastrarELogar('usuario-etapa2-terminal', 'Supervisao');
  const usuarioId = await obterUsuarioId(cookie);
  semearExportacaoPdf({ jobId: novoJobIdFalso(), usuarioId, status: 'erro', concluidoEm: Date.now() });
  semearExportacaoPdf({ jobId: novoJobIdFalso(), usuarioId, status: 'cancelado', concluidoEm: Date.now() });

  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/iniciar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ html: '<html><body>oi</body></html>', filename: 'novo.pdf' }),
  });
  assert.notEqual(resp.status, 409);
});

// Etapa 8 (ver README/lib/rotas/exportar-pdf.js): Admin Master ganhou um
// usuarioId sentinela fixo (mesmo valor de ADMIN_MASTER_USUARIO_ID em
// lib/rotas/exportar-pdf.js) só pra este recurso — tem sua PRÓPRIA fila
// de "um job por vez", igual qualquer usuário cadastrado.
const ADMIN_MASTER_USUARIO_ID = '__admin_master__';

test('POST /iniciar recusa (409) um segundo job enquanto o ADMIN MASTER tem um "processando" (Etapa 8)', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const jobIdExistente = novoJobIdFalso();
  semearExportacaoPdf({ jobId: jobIdExistente, usuarioId: ADMIN_MASTER_USUARIO_ID, status: 'processando' });

  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/iniciar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ html: '<html><body>oi</body></html>', filename: 'novo.pdf' }),
  });
  assert.equal(resp.status, 409);
  const corpo = await resp.json();
  assert.equal(corpo.jobId, jobIdExistente);

  // Limpa: ADMIN_MASTER_USUARIO_ID é um valor FIXO, compartilhado pelo
  // resto deste arquivo (mesmo servidor/banco) — sem isto, este job
  // "processando" vazaria pros próximos testes que usam o Admin Master.
  marcarStatusExportacaoPdf(jobIdExistente, 'cancelado');
});

test('POST /iniciar do ADMIN MASTER NÃO é bloqueado por job pendente de um usuário cadastrado (Etapa 8)', async () => {
  const cookieUsuario = await cadastrarELogar('usuario-etapa8-isolamento-a', 'Supervisao');
  const usuarioId = await obterUsuarioId(cookieUsuario);
  const cookieAdmin = await logarComoAdminMaster();

  semearExportacaoPdf({ jobId: novoJobIdFalso(), usuarioId, status: 'processando' });

  const respAdmin = await fetch(`${servidor.baseUrl}/exportar-pdf/iniciar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ html: '<html><body>oi</body></html>', filename: 'novo.pdf' }),
  });
  assert.notEqual(respAdmin.status, 409, 'job pendente de um usuário cadastrado não deveria bloquear o Admin Master');
});

test('POST /iniciar de um usuário cadastrado NÃO é bloqueado por job pendente do ADMIN MASTER (Etapa 8)', async () => {
  const cookieUsuario = await cadastrarELogar('usuario-etapa8-isolamento-b', 'Supervisao');
  semearExportacaoPdf({ jobId: novoJobIdFalso(), usuarioId: ADMIN_MASTER_USUARIO_ID, status: 'processando' });

  const respUsuario = await fetch(`${servidor.baseUrl}/exportar-pdf/iniciar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify({ html: '<html><body>oi</body></html>', filename: 'novo.pdf' }),
  });
  assert.notEqual(respUsuario.status, 409, 'job pendente do Admin Master não deveria bloquear um usuário cadastrado');
});

// ═══════════════════════════════════════════════════════════════════════
// GET /meu-status
// ═══════════════════════════════════════════════════════════════════════

test('GET /meu-status exige sessão de usuário', async () => {
  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/meu-status`);
  assert.equal(resp.status, 403);
});

test('GET /meu-status devolve job:null quando não há nada pendente', async () => {
  const cookie = await cadastrarELogar('usuario-etapa2-status-vazio', 'Supervisao');
  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/meu-status`, { headers: { Cookie: cookie } });
  assert.equal(resp.status, 200);
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);
  assert.equal(corpo.job, null);
});

test('GET /meu-status devolve o job "concluido" pendente do usuário', async () => {
  const cookie = await cadastrarELogar('usuario-etapa2-status-concluido', 'Supervisao');
  const usuarioId = await obterUsuarioId(cookie);
  const jobId = novoJobIdFalso();
  semearExportacaoPdf({ jobId, usuarioId, nomeArquivo: 'relatorio-turno.pdf', status: 'concluido', concluidoEm: Date.now() });

  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/meu-status`, { headers: { Cookie: cookie } });
  const corpo = await resp.json();
  assert.equal(corpo.ok, true);
  assert.ok(corpo.job);
  assert.equal(corpo.job.jobId, jobId);
  assert.equal(corpo.job.status, 'concluido');
  assert.equal(corpo.job.nomeArquivo, 'relatorio-turno.pdf');
});

// ═══════════════════════════════════════════════════════════════════════
// POST /descartar/:jobId
// ═══════════════════════════════════════════════════════════════════════

test('POST /descartar/:jobId exige sessão de usuário', async () => {
  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/descartar/${novoJobIdFalso()}`, { method: 'POST' });
  assert.equal(resp.status, 403);
});

test('POST /descartar/:jobId em job inexistente → 404', async () => {
  const cookie = await cadastrarELogar('usuario-etapa2-descartar-404', 'Supervisao');
  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/descartar/${novoJobIdFalso()}`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(resp.status, 404);
});

test('POST /descartar/:jobId no job de OUTRO usuário → 403, job permanece intacto', async () => {
  const cookieDono = await cadastrarELogar('usuario-etapa2-descartar-dono', 'Supervisao');
  const usuarioIdDono = await obterUsuarioId(cookieDono);
  const cookieIntruso = await cadastrarELogar('usuario-etapa2-descartar-intruso', 'Supervisao');

  const jobId = novoJobIdFalso();
  semearExportacaoPdf({ jobId, usuarioId: usuarioIdDono, status: 'concluido', concluidoEm: Date.now() });

  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/descartar/${jobId}`, {
    method: 'POST',
    headers: { Cookie: cookieIntruso },
  });
  assert.equal(resp.status, 403);
  assert.ok(lerExportacaoPdf(jobId), 'o registro não deveria ter sido apagado por um usuário sem permissão');
});

test('POST /descartar/:jobId num job "processando" → 409 (precisa cancelar, não descartar)', async () => {
  const cookie = await cadastrarELogar('usuario-etapa2-descartar-processando', 'Supervisao');
  const usuarioId = await obterUsuarioId(cookie);
  const jobId = novoJobIdFalso();
  semearExportacaoPdf({ jobId, usuarioId, status: 'processando' });

  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/descartar/${jobId}`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(resp.status, 409);
  assert.ok(lerExportacaoPdf(jobId), 'job processando não deveria ter sido apagado por descartar');
});

test('POST /descartar/:jobId apaga o registro + arquivo em disco, e libera o usuário pra iniciar outro job', async () => {
  const cookie = await cadastrarELogar('usuario-etapa2-descartar-sucesso', 'Supervisao');
  const usuarioId = await obterUsuarioId(cookie);
  const jobId = novoJobIdFalso();
  const caminhoArquivo = path.join(pastaScratch, jobId + '-descarte.pdf');
  fs.writeFileSync(caminhoArquivo, '%PDF-fake%');
  semearExportacaoPdf({ jobId, usuarioId, status: 'concluido', caminhoArquivo, concluidoEm: Date.now() });

  // Antes de descartar: bloqueado.
  const respBloqueado = await fetch(`${servidor.baseUrl}/exportar-pdf/iniciar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ html: '<html><body>oi</body></html>', filename: 'novo.pdf' }),
  });
  assert.equal(respBloqueado.status, 409);

  const respDescarte = await fetch(`${servidor.baseUrl}/exportar-pdf/descartar/${jobId}`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(respDescarte.status, 200);
  const corpoDescarte = await respDescarte.json();
  assert.equal(corpoDescarte.ok, true);

  assert.equal(lerExportacaoPdf(jobId), undefined, 'registro deveria ter sido apagado do banco');
  assert.equal(fs.existsSync(caminhoArquivo), false, 'arquivo em disco deveria ter sido apagado');

  // Depois de descartar: livre pra tentar de novo (pode dar 500 se a
  // máquina de teste não tiver Chromium — o que importa é NUNCA MAIS 409).
  const respLivre = await fetch(`${servidor.baseUrl}/exportar-pdf/iniciar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ html: '<html><body>oi</body></html>', filename: 'novo.pdf' }),
  });
  assert.notEqual(respLivre.status, 409);
});

test('GET /exportar-pdf/arquivo/:jobId apaga o job automaticamente depois que o download termina por completo (Etapa 7)', async () => {
  const cookie = await cadastrarELogar('usuario-etapa7-baixar-apaga', 'Supervisao');
  const usuarioId = await obterUsuarioId(cookie);
  const jobId = novoJobIdFalso();
  const caminhoArquivo = path.join(pastaScratch, jobId + '-baixar.pdf');
  fs.writeFileSync(caminhoArquivo, '%PDF-fake-conteudo%');
  semearExportacaoPdf({ jobId, usuarioId, status: 'concluido', caminhoArquivo, concluidoEm: Date.now() });

  const respBaixar = await fetch(`${servidor.baseUrl}/exportar-pdf/arquivo/${jobId}`);
  assert.equal(respBaixar.status, 200);
  await respBaixar.arrayBuffer(); // garante que o corpo inteiro chegou (download "completo")

  // A limpeza roda no listener `res.on('finish', ...)` do servidor —
  // dá uma volta de I/O pra deixar esse handler terminar antes de checar.
  await new Promise((r) => setTimeout(r, 100));

  // Baixar por completo agora RESOLVE o job sozinho: registro, arquivo
  // em disco e o bloqueio pro usuário somem, sem precisar descartar.
  assert.equal(lerExportacaoPdf(jobId), undefined, 'registro deveria ter sido apagado depois do download completo');
  assert.equal(fs.existsSync(caminhoArquivo), false, 'arquivo em disco deveria ter sido apagado depois do download completo');

  const respIniciar = await fetch(`${servidor.baseUrl}/exportar-pdf/iniciar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ html: '<html><body>oi</body></html>', filename: 'novo.pdf' }),
  });
  assert.notEqual(respIniciar.status, 409, 'baixar por completo deveria ter liberado o slot, sem precisar descartar');

  // Não dá mais pra baixar de novo — o job já foi resolvido.
  const respBaixarDeNovo = await fetch(`${servidor.baseUrl}/exportar-pdf/arquivo/${jobId}`);
  assert.equal(respBaixarDeNovo.status, 404);
});
