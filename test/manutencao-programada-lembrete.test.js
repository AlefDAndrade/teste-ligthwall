// ─── test/manutencao-programada-lembrete.test.js ────────────────────────────
// Testa o LEMBRETE DO DIA de manutenção programada (ver conversa que
// motivou isso: "tenho uma programada pro dia 12, quero um lembrete no
// dia 12 às 09h da manhã") — diferente da notificação já existente de
// "agendamento criado" (disparada na hora em que alguém cria o
// agendamento, dias antes; ver test/notificacoes-push.test.js), esta é
// baseada em RELÓGIO, não em ação de usuário nenhuma.
//
// Cobre: o item de catálogo 'manutencao-notificacao-programada-lembrete'
// (ver lib/itens-permissao.js), o padrão 'total' pra todo perfil fixo
// (ver lib/perfis.js), que o job (executarLembreteManutencaoProgramadaSeNecessario,
// lib/notificacoes-push.js) só dispara depois das 09h — nunca antes —,
// que só agendamentos com status='Aprovado' e data=hoje são elegíveis, e
// que um agendamento já lembrado nunca é notificado de novo (mesmo
// rodando o job várias vezes).
//
// Pra testar isto deterministicamente (sem depender da hora real do dia
// bater 09h), o servidor de teste sobe com o relógio CONGELADO (env
// LW_TEST_RELOGIO_ISO, ver _agoraServer() em server.js) e uma rota
// interna só-de-teste (POST /__test__/executar-lembrete-programada, só
// registrada quando essa env existe) dispara o job sob demanda em vez de
// esperar o setInterval de 60s de verdade.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-lembrete-programada-333';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

function extrairCookie(resposta) {
  const setCookie = resposta.headers.get('set-cookie') || '';
  return setCookie.split(';')[0] || null;
}

async function logarComoAdminMaster(baseUrl) {
  const resp = await fetch(`${baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  return extrairCookie(resp);
}

async function cadastrarELogar(baseUrl, nomeUsuario, perfil) {
  const cookieAdmin = await logarComoAdminMaster(baseUrl);
  const respAtuais = await fetch(`${baseUrl}/usuarios`);
  const { usuarios: atuais } = await respAtuais.json();
  const listaParaEnviar = [
    ...atuais.map(u => ({ id: u.id, nomeUsuario: u.nomeUsuario, perfil: u.perfil, podeIniciarOperacao: u.podeIniciarOperacao })),
    { nomeUsuario, senha: 'senhateste1234', perfil },
  ];
  await fetch(`${baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify(listaParaEnviar),
  });
  const respLogin = await fetch(`${baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario, senha: 'senhateste1234' }),
  });
  return extrairCookie(respLogin);
}

function gerarCertificadoAutoassinado() {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-cert-lembrete-'));
  const chave = path.join(pasta, 'key.pem');
  const cert = path.join(pasta, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', chave, '-out', cert,
    '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
  ]);
  return { key: fs.readFileSync(chave), cert: fs.readFileSync(cert) };
}

// Sobe um servidor de captura HTTPS local (finge ser o serviço de push do
// navegador) — mesmo raciocínio de test/notificacoes-push.test.js.
async function subirCapturaPush() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const pushesRecebidos = [];
  const certificado = gerarCertificadoAutoassinado();
  const capturaPush = https.createServer(certificado, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      pushesRecebidos.push({ caminho: req.url });
      res.writeHead(201, { 'Content-Type': 'text/plain' });
      res.end();
    });
  });
  await new Promise((resolve) => capturaPush.listen(0, '127.0.0.1', resolve));
  const capturaPushUrl = `https://127.0.0.1:${capturaPush.address().port}`;
  return {
    pushesRecebidos,
    url: capturaPushUrl,
    fechar: () => new Promise((resolve) => capturaPush.close(resolve)),
  };
}

function subscriptionReal(capturaPushUrl, caminho) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `${capturaPushUrl}/${caminho}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
}

async function inscreverPush(baseUrl, cookie, subscription) {
  await fetch(`${baseUrl}/push/inscrever`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ subscription }),
  });
}

async function dispararJobDeLembrete(baseUrl) {
  await fetch(`${baseUrl}/__test__/executar-lembrete-programada`, { method: 'POST' });
  // Fire-and-forget dentro do servidor (mesmo raciocínio de todo o resto
  // das notificações push deste projeto) — espera um pouco pro POST
  // assíncrono do web-push chegar no servidor de captura local.
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

// Cria um agendamento já 'Pendente' e, se o status final pedido for
// diferente, faz um SEGUNDO POST (update) pra chegar nele — de propósito
// em DUAS chamadas, nunca criando já com status='Aprovado' na hora: a
// rota real (lib/rotas/manutencao.js, `!existente`) dispara a
// notificação JÁ EXISTENTE de "agendamento criado" só na CRIAÇÃO (não em
// updates de status seguintes). Se criássemos direto com
// status='Aprovado' e só DEPOIS inscrevêssemos o push, tudo bem — mas os
// testes daqui inscrevem o push e então esperam ZERO notificação (casos
// "não deveria lembrar"), e a notificação de "criado" usa a MESMA
// permissão padrão ('total' pra todo perfil) e o MESMO destinatário,
// contaminando o teste. Criar em duas etapas ANTES de inscrever o push
// evita esse falso positivo, isolando de verdade o comportamento do
// LEMBRETE (o que estes testes querem verificar), não o da notificação
// de criação (já coberta em test/notificacoes-push.test.js).
async function criarAgendamento(baseUrl, cookieAdmin, { id, data, statusFinal }) {
  const base = { id, data, setor: 'Producao', maquina: 'Injetora 3', solicitante: 'Maria' };
  await fetch(`${baseUrl}/manutencao/programada`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify(base),
  });
  if (statusFinal && statusFinal !== 'Pendente') {
    await fetch(`${baseUrl}/manutencao/programada`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
      body: JSON.stringify({ ...base, status: statusFinal }),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Catálogo e padrão de permissão
// ═══════════════════════════════════════════════════════════════════════

test('catálogo de permissões inclui o item de notificação de lembrete de manutenção programada', async () => {
  const servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
  try {
    const resp = await fetch(`${servidor.baseUrl}/catalogo-permissoes`);
    const data = await resp.json();
    assert.equal(data.ok, true);
    const item = data.catalogo.find(i => i.id === 'manutencao-notificacao-programada-lembrete');
    assert.ok(item, 'item de notificação de lembrete deveria estar no catálogo');
    assert.equal(item.pai, 'manutencao-corretiva');
    assert.equal(item.area, undefined, 'não deve conceder nenhuma área de edição');
  } finally {
    await servidor.parar();
  }
});

test('padrão do item de lembrete é "total" pra todos os perfis fixos', async () => {
  const servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
  try {
    for (const perfilId of ['Manutencao', 'Supervisao', 'Encarregado', 'AssistenteQualidade', 'OperadorInjetora', 'Administrativo']) {
      const resp = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=${perfilId}`);
      const data = await resp.json();
      assert.equal(
        data.permissoes['manutencao-notificacao-programada-lembrete'], 'total',
        `perfil ${perfilId} deveria receber o lembrete por padrão`
      );
    }
  } finally {
    await servidor.parar();
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Job do lembrete — comportamento baseado em relógio
// ═══════════════════════════════════════════════════════════════════════

test('agendamento "Aprovado" pro dia de hoje NÃO é lembrado antes das 09h', async () => {
  const servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    env: { LW_TEST_RELOGIO_ISO: '2026-07-12T08:30:00-03:00' },
  });
  const captura = await subirCapturaPush();
  try {
    const cookieAdmin = await logarComoAdminMaster(servidor.baseUrl);
    const cookieDestino = await cadastrarELogar(servidor.baseUrl, 'lembrete.antes.09h', 'Manutencao');

    const id = 'PRG-lembrete-antes-' + Date.now();
    await criarAgendamento(servidor.baseUrl, cookieAdmin, { id, data: '2026-07-12', statusFinal: 'Aprovado' });

    await inscreverPush(servidor.baseUrl, cookieDestino, subscriptionReal(captura.url, 'antes-09h'));
    await dispararJobDeLembrete(servidor.baseUrl);

    assert.ok(!captura.pushesRecebidos.some(p => p.caminho === '/antes-09h'), 'não deveria lembrar antes das 09h');
  } finally {
    await servidor.parar();
    await captura.fechar();
  }
});

test('agendamento "Aprovado" pro dia de hoje É lembrado depois das 09h, e não se repete numa segunda checagem', async () => {
  const servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    env: { LW_TEST_RELOGIO_ISO: '2026-07-12T09:05:00-03:00' },
  });
  const captura = await subirCapturaPush();
  try {
    const cookieAdmin = await logarComoAdminMaster(servidor.baseUrl);
    const cookieDestino = await cadastrarELogar(servidor.baseUrl, 'lembrete.depois.09h', 'Manutencao');

    const id = 'PRG-lembrete-depois-' + Date.now();
    await criarAgendamento(servidor.baseUrl, cookieAdmin, { id, data: '2026-07-12', statusFinal: 'Aprovado' });

    await inscreverPush(servidor.baseUrl, cookieDestino, subscriptionReal(captura.url, 'depois-09h'));

    await dispararJobDeLembrete(servidor.baseUrl);
    assert.ok(captura.pushesRecebidos.some(p => p.caminho === '/depois-09h'), 'deveria lembrar depois das 09h');

    const totalAposPrimeiraChecagem = captura.pushesRecebidos.filter(p => p.caminho === '/depois-09h').length;

    // Roda o job de novo (mesmo dia, mesmo agendamento) — não pode
    // reenviar: já foi marcado como lembrado (ver
    // db.marcarLembreteDiaEnviado/listarManutencaoProgramadaParaLembreteDoDia).
    await dispararJobDeLembrete(servidor.baseUrl);
    const totalDepois = captura.pushesRecebidos.filter(p => p.caminho === '/depois-09h').length;
    assert.equal(totalDepois, totalAposPrimeiraChecagem, 'não deveria lembrar de novo o mesmo agendamento');
  } finally {
    await servidor.parar();
    await captura.fechar();
  }
});

test('agendamento ainda "Pendente" (não aprovado) não é lembrado', async () => {
  const servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    env: { LW_TEST_RELOGIO_ISO: '2026-07-12T09:05:00-03:00' },
  });
  const captura = await subirCapturaPush();
  try {
    const cookieAdmin = await logarComoAdminMaster(servidor.baseUrl);
    const cookieDestino = await cadastrarELogar(servidor.baseUrl, 'lembrete.pendente', 'Manutencao');

    const id = 'PRG-lembrete-pendente-' + Date.now();
    // Sem statusFinal -> fica 'Pendente' (default, ver db.salvarManutencaoProgramada).
    await criarAgendamento(servidor.baseUrl, cookieAdmin, { id, data: '2026-07-12' });

    await inscreverPush(servidor.baseUrl, cookieDestino, subscriptionReal(captura.url, 'pendente'));
    await dispararJobDeLembrete(servidor.baseUrl);

    assert.ok(!captura.pushesRecebidos.some(p => p.caminho === '/pendente'), 'agendamento ainda pendente não deveria gerar lembrete');
  } finally {
    await servidor.parar();
    await captura.fechar();
  }
});

test('agendamento "Aprovado" pra OUTRO dia (não hoje) não é lembrado', async () => {
  const servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    env: { LW_TEST_RELOGIO_ISO: '2026-07-12T09:05:00-03:00' },
  });
  const captura = await subirCapturaPush();
  try {
    const cookieAdmin = await logarComoAdminMaster(servidor.baseUrl);
    const cookieDestino = await cadastrarELogar(servidor.baseUrl, 'lembrete.outro.dia', 'Manutencao');

    const id = 'PRG-lembrete-outro-dia-' + Date.now();
    await criarAgendamento(servidor.baseUrl, cookieAdmin, { id, data: '2026-07-20', statusFinal: 'Aprovado' });

    await inscreverPush(servidor.baseUrl, cookieDestino, subscriptionReal(captura.url, 'outro-dia'));
    await dispararJobDeLembrete(servidor.baseUrl);

    assert.ok(!captura.pushesRecebidos.some(p => p.caminho === '/outro-dia'), 'agendamento de outro dia não deveria gerar lembrete hoje');
  } finally {
    await servidor.parar();
    await captura.fechar();
  }
});

test('reagendar (mudar a data) reseta o "já lembrado" — volta a ser elegível se cair de novo em hoje', async () => {
  const servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    env: { LW_TEST_RELOGIO_ISO: '2026-07-12T09:05:00-03:00' },
  });
  const captura = await subirCapturaPush();
  try {
    const cookieAdmin = await logarComoAdminMaster(servidor.baseUrl);
    // Perfil 'AssistenteQualidade' de propósito (não 'Manutencao'): não
    // edita a área 'manutencao', então por padrão NÃO recebe a
    // notificação GENÉRICA de "Atualização de Etiqueta" (ver
    // lib/perfis.js) — o reagendamento abaixo (POST /manutencao/programada
    // num agendamento já existente) dispara essa genérica pra quem tem a
    // permissão, o que duplicaria a contagem de pushes neste endpoint e
    // confundiria com o que este teste quer medir (só o job de LEMBRETE).
    // O item de lembrete em si continua 'total' por padrão pra QUALQUER
    // perfil fixo (ver permissoesPadraoDoPerfilFixo), então a cobertura
    // do job não é afetada pela troca de perfil.
    const cookieDestino = await cadastrarELogar(servidor.baseUrl, 'lembrete.reagendado', 'AssistenteQualidade');

    const id = 'PRG-lembrete-reagendado-' + Date.now();
    const base = { id, setor: 'Producao', maquina: 'Injetora 3', solicitante: 'Maria' };

    // Cria já Aprovado pra HOJE e deixa o job lembrar (mesmo fluxo do
    // teste "É lembrado depois das 09h", acima).
    await criarAgendamento(servidor.baseUrl, cookieAdmin, { ...base, data: '2026-07-12', statusFinal: 'Aprovado' });
    await inscreverPush(servidor.baseUrl, cookieDestino, subscriptionReal(captura.url, 'reagendado'));
    await dispararJobDeLembrete(servidor.baseUrl);
    assert.equal(
      captura.pushesRecebidos.filter(p => p.caminho === '/reagendado').length, 1,
      'deveria ter lembrado na primeira vez, hoje'
    );

    // Adia pra semana que vem (muda só a `data`) — não deveria lembrar
    // de novo (dia diferente de hoje).
    await fetch(`${servidor.baseUrl}/manutencao/programada`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
      body: JSON.stringify({ ...base, data: '2026-07-20', status: 'Aprovado' }),
    });
    await dispararJobDeLembrete(servidor.baseUrl);
    assert.equal(
      captura.pushesRecebidos.filter(p => p.caminho === '/reagendado').length, 1,
      'não deveria lembrar de novo — agora a data é outro dia'
    );

    // Traz de volta pra HOJE — o reagendamento resetou o "já enviado",
    // então deveria lembrar de novo (ver CASE em
    // SQL_UPSERT_MANUTENCAO_PROGRAMADA, db.js).
    await fetch(`${servidor.baseUrl}/manutencao/programada`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
      body: JSON.stringify({ ...base, data: '2026-07-12', status: 'Aprovado' }),
    });
    await dispararJobDeLembrete(servidor.baseUrl);
    assert.equal(
      captura.pushesRecebidos.filter(p => p.caminho === '/reagendado').length, 2,
      'voltando pro mesmo dia de hoje, deveria lembrar de novo'
    );
  } finally {
    await servidor.parar();
    await captura.fechar();
  }
});

test('perfil com o item de lembrete desativado (override) não recebe', async () => {
  const servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    env: { LW_TEST_RELOGIO_ISO: '2026-07-12T09:05:00-03:00' },
  });
  const captura = await subirCapturaPush();
  try {
    const cookieAdmin = await logarComoAdminMaster(servidor.baseUrl);

    // Desativa o item de lembrete pro perfil Manutencao via override
    // (mesma tela de Configurações → Notificações).
    const respAtual = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Manutencao`);
    const { permissoes: mapaAtual } = await respAtual.json();
    const mapaSemLembrete = { ...mapaAtual, 'manutencao-notificacao-programada-lembrete': 'ocultar' };
    await fetch(`${servidor.baseUrl}/salvar-permissoes-perfil-fixo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
      body: JSON.stringify({ perfil: 'Manutencao', permissoes: mapaSemLembrete }),
    });

    const cookieDestino = await cadastrarELogar(servidor.baseUrl, 'lembrete.perfil.sem.permissao', 'Manutencao');

    const id = 'PRG-lembrete-sem-permissao-' + Date.now();
    await criarAgendamento(servidor.baseUrl, cookieAdmin, { id, data: '2026-07-12', statusFinal: 'Aprovado' });

    await inscreverPush(servidor.baseUrl, cookieDestino, subscriptionReal(captura.url, 'sem-permissao'));
    await dispararJobDeLembrete(servidor.baseUrl);

    assert.ok(!captura.pushesRecebidos.some(p => p.caminho === '/sem-permissao'), 'perfil sem a permissão não deveria receber o lembrete');
  } finally {
    await servidor.parar();
    await captura.fechar();
  }
});
