// ─── test/notificacoes-push.test.js ─────────────────────────────────────────
// Testa o sistema de notificação push de abertura de chamado de manutenção
// (ver conversa que motivou isso: "toda vez que um chamado for aberto, quem
// tem a permissão de notificação marcada no perfil é notificado", PC e
// celular via Web Push/PWA).
//
// Cobre: o novo item de catálogo 'manutencao-notificacao-abertura' (ver
// lib/itens-permissao.js), os padrões calculados pros 6 perfis fixos (ver
// lib/perfis.js, permissoesPadraoDoPerfilFixo), a cascata override/perfil-
// customizado (ver lib/notificacoes-push.js), as rotas GET /push/config,
// POST /push/inscrever, POST /push/desinscrever, e que abrir um chamado
// NOVO nunca falha/atrasa por causa do envio da notificação (mesmo com uma
// inscrição de push "morta"/inalcançável cadastrada).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-notificacoes-push-777';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;

// Servidor HTTPS local que finge ser o "serviço de push" — captura os
// POSTs que o web-push (rodando dentro do processo do servidor testado,
// ver lib/notificacoes-push.js) manda de verdade, sem precisar de rede
// externa nenhuma. Usado só no teste de exclusão do autor, abaixo: prova
// que o ENVIO de verdade (não só "não quebra") respeita quem deve ou não
// receber. Precisa ser HTTPS (não HTTP) porque o web-push sempre fala
// TLS com o endpoint, mesmo em testes — certificado autoassinado gerado
// na hora com o `openssl` do próprio container.
let capturaPush;
let capturaPushUrl;
const pushesRecebidos = [];

function gerarCertificadoAutoassinado() {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-cert-'));
  const chave = path.join(pasta, 'key.pem');
  const cert = path.join(pasta, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', chave, '-out', cert,
    '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
  ]);
  return { key: fs.readFileSync(chave), cert: fs.readFileSync(cert) };
}

before(async () => {
  // O processo do servidor testado precisa confiar no certificado
  // autoassinado do servidor de captura acima — só afeta ESTE arquivo de
  // teste (cada arquivo de teste roda em processo próprio do test
  // runner) e só a saída HTTPS que o web-push faz de dentro do processo
  // filho spawnado por iniciarServidorDeTeste, nunca produção.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });

  const certificado = gerarCertificadoAutoassinado();
  capturaPush = https.createServer(certificado, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      pushesRecebidos.push({ caminho: req.url });
      res.writeHead(201, { 'Content-Type': 'text/plain' });
      res.end();
    });
  });
  await new Promise((resolve) => capturaPush.listen(0, '127.0.0.1', resolve));
  capturaPushUrl = `https://127.0.0.1:${capturaPush.address().port}`;
});

after(async () => {
  await servidor.parar();
  await new Promise((resolve) => capturaPush.close(resolve));
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

// Inscrição de push FALSA — endpoint aponta pra um domínio que não existe,
// de propósito: qualquer tentativa real de enviar (webpush.sendNotification)
// vai falhar com erro de rede (não 404/410 do serviço de push de verdade),
// exercitando o caminho "falha ao enviar não pode quebrar nada" sem
// depender de rede real nenhuma.
function subscriptionFalsa(sufixo) {
  return {
    endpoint: `https://push.exemplo-invalido.test/envio/${sufixo}`,
    keys: {
      p256dh: 'BNJxw7YucFhSCPGdd5b8wxaqbXf6yv0zHOrM5T7VLYbBcgTHiehcS72xE0AGYAy_9BM_9sbgIN7wq3ceJ0OKTOQ',
      auth: 'k8JV6sAWQ2Q1_o8_pNjNzQ',
    },
  };
}

// Inscrição com uma chave EC (P-256) de verdade — diferente de
// subscriptionFalsa() (endpoint inválido, só pra testar "não quebra"),
// esta é usada quando o teste precisa que o web-push CONSIGA criptografar
// e mandar de verdade pro servidor de captura local (capturaPushUrl).
function subscriptionReal(caminho) {
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

function payloadChamado(id, overrides = {}) {
  return {
    id, data: '2026-07-23', setor: 'Injetora', maquina: 'M-push',
    observador: 'joao.observador', prioridade: 'Alta', anomalia: 'Anomalia de teste push',
    tipoManutencao: 'Mecânica',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Catálogo e padrões por perfil
// ═══════════════════════════════════════════════════════════════════════

test('catálogo de permissões inclui o item de notificação de abertura de chamado', async () => {
  const resp = await fetch(`${servidor.baseUrl}/catalogo-permissoes`);
  const data = await resp.json();
  assert.equal(data.ok, true);
  const item = data.catalogo.find(i => i.id === 'manutencao-notificacao-abertura');
  assert.ok(item, 'item de notificação deveria estar no catálogo');
  assert.equal(item.pai, 'manutencao-corretiva');
  assert.equal(item.area, undefined, 'não deve conceder nenhuma área de edição');
});

test('perfis que editam Manutenção recebem "total" por padrão; quem não edita, "ocultar"', async () => {
  const respManutencao = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Manutencao`);
  const dadosManutencao = await respManutencao.json();
  assert.equal(dadosManutencao.permissoes['manutencao-notificacao-abertura'], 'total');

  const respSupervisao = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Supervisao`);
  const dadosSupervisao = await respSupervisao.json();
  assert.equal(dadosSupervisao.permissoes['manutencao-notificacao-abertura'], 'total');

  const respQualidade = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=AssistenteQualidade`);
  const dadosQualidade = await respQualidade.json();
  assert.equal(dadosQualidade.permissoes['manutencao-notificacao-abertura'], 'ocultar');
});

test('Administrador pode dar/tirar a permissão de notificação de um perfil fixo via override', async () => {
  const cookieAdmin = await logarComoAdminMaster();

  // Parte do mapa padrão atual (mesmo padrão que o front já faz: busca o
  // mapa vigente, muda só o item desejado, manda o mapa inteiro de volta).
  const respAtual = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=AssistenteQualidade`);
  const { permissoes: mapaAtual } = await respAtual.json();
  const mapaComNotificacao = { ...mapaAtual, 'manutencao-notificacao-abertura': 'total' };

  const respSalvar = await fetch(`${servidor.baseUrl}/salvar-permissoes-perfil-fixo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ perfil: 'AssistenteQualidade', permissoes: mapaComNotificacao }),
  });
  assert.equal(respSalvar.status, 200);

  const respDepois = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=AssistenteQualidade`);
  const dadosDepois = await respDepois.json();
  assert.equal(dadosDepois.permissoes['manutencao-notificacao-abertura'], 'total');
  assert.equal(dadosDepois.temOverride, true);

  // Restaura o padrão — não deixa efeito colateral pros próximos testes
  // deste arquivo (ex: teste de perfil customizado, abaixo).
  await fetch(`${servidor.baseUrl}/restaurar-permissoes-perfil-fixo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ perfil: 'AssistenteQualidade' }),
  });
});

// ═══════════════════════════════════════════════════════════════════════
// GET /push/config
// ═══════════════════════════════════════════════════════════════════════

test('GET /push/config devolve a chave pública VAPID e "logado" conforme a sessão', async () => {
  const respSemLogin = await fetch(`${servidor.baseUrl}/push/config`);
  const semLogin = await respSemLogin.json();
  assert.equal(semLogin.ok, true);
  assert.equal(typeof semLogin.chavePublica, 'string');
  assert.ok(semLogin.chavePublica.length > 20, 'chave pública deveria ser uma string b64url não-trivial');
  assert.equal(semLogin.logado, false);

  const cookie = await cadastrarELogar('push.config.usuario', 'Manutencao');
  const respLogado = await fetch(`${servidor.baseUrl}/push/config`, { headers: { Cookie: cookie } });
  const logado = await respLogado.json();
  assert.equal(logado.logado, true);
  assert.equal(logado.chavePublica, semLogin.chavePublica, 'chave pública é fixa pro servidor inteiro, não muda por sessão');
});

// ═══════════════════════════════════════════════════════════════════════
// POST /push/inscrever e /push/desinscrever
// ═══════════════════════════════════════════════════════════════════════

test('POST /push/inscrever exige login', async () => {
  const resp = await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: subscriptionFalsa('sem-login') }),
  });
  assert.equal(resp.status, 401);
});

test('POST /push/inscrever recusa uma inscrição sem endpoint/keys', async () => {
  const cookie = await cadastrarELogar('push.invalida.usuario', 'Manutencao');
  const resp = await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ subscription: { endpoint: 'https://x.test' } }), // sem "keys"
  });
  assert.equal(resp.status, 400);
});

test('usuário logado consegue se inscrever, e só o dono consegue se desinscrever', async () => {
  const cookieA = await cadastrarELogar('push.dono.usuario', 'Manutencao');
  const cookieB = await cadastrarELogar('push.outro.usuario', 'Encarregado');
  const sub = subscriptionFalsa('dono-vs-outro');

  const respInscrever = await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieA },
    body: JSON.stringify({ subscription: sub }),
  });
  assert.equal(respInscrever.status, 200);

  const respOutroTentaRemover = await fetch(`${servidor.baseUrl}/push/desinscrever`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieB },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  assert.equal(respOutroTentaRemover.status, 400);

  const respDonoRemove = await fetch(`${servidor.baseUrl}/push/desinscrever`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieA },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  assert.equal(respDonoRemove.status, 200);

  // Idempotente — remover de novo (já não existe mais) não deveria falhar.
  const respRemoverDeNovo = await fetch(`${servidor.baseUrl}/push/desinscrever`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieA },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  assert.equal(respRemoverDeNovo.status, 200);
});

// ═══════════════════════════════════════════════════════════════════════
// Abrir um chamado NOVO nunca falha por causa do envio da notificação
// ═══════════════════════════════════════════════════════════════════════

test('abrir um chamado corretivo novo continua respondendo 200 mesmo com inscrições de push inalcançáveis cadastradas', async () => {
  // Alguém com a permissão de notificação (Manutencao, padrão 'total') se
  // inscreve com um endpoint que não existe de verdade — o envio (fire-
  // and-forget, ver lib/notificacoes-push.js) vai falhar por trás, mas
  // isso NUNCA pode aparecer pra quem está abrindo o chamado.
  const cookieNotificado = await cadastrarELogar('push.recebe.notificacao', 'Manutencao');
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieNotificado },
    body: JSON.stringify({ subscription: subscriptionFalsa('recebe-notificacao') }),
  });

  const cookieAbre = await cadastrarELogar('abre.chamado.push', 'Encarregado');
  const id = 'MAN-push-1-' + Date.now();
  const respAbrir = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAbre },
    body: JSON.stringify(payloadChamado(id)),
  });
  assert.equal(respAbrir.status, 200);
  const dados = await respAbrir.json();
  assert.equal(dados.ok, true);
  assert.equal(dados.chamado.id, id);
});

test('perfil customizado com a permissão de notificação marcada não quebra a abertura de chamado', async () => {
  const cookieAdmin = await logarComoAdminMaster();

  const respCatalogo = await fetch(`${servidor.baseUrl}/catalogo-permissoes`);
  const { catalogo } = await respCatalogo.json();
  const permissoes = {};
  for (const item of catalogo) permissoes[item.id] = 'ocultar';
  permissoes['manutencao-abertura'] = 'total';        // pra conseguir abrir chamado (concede a área 'manutencao-chamado')
  permissoes['manutencao-notificacao-abertura'] = 'total'; // recebe notificação

  const respCriar = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Notificado Custom Push', permissoes }),
  });
  assert.equal(respCriar.status, 200);
  const { perfil: customizado } = await respCriar.json();

  const cookieCustom = await cadastrarELogar('push.custom.usuario', customizado.id);
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieCustom },
    body: JSON.stringify({ subscription: subscriptionFalsa('custom-perfil') }),
  });

  const id = 'MAN-push-custom-1-' + Date.now();
  const respAbrir = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieCustom },
    body: JSON.stringify(payloadChamado(id, { observador: 'push.custom.usuario' })),
  });
  assert.equal(respAbrir.status, 200);
});

test('quem abre o chamado NÃO recebe a própria notificação, mas outros com a permissão recebem', async () => {
  // Dois usuários com perfil que recebe notificação por padrão
  // (Manutencao/Encarregado); um deles é quem vai abrir o chamado.
  const cookieAutor = await cadastrarELogar('push.autor.nao.notificado', 'Manutencao');
  const cookieOutro = await cadastrarELogar('push.outro.recebe', 'Encarregado');

  const subAutor = subscriptionReal('autor');
  const subOutro = subscriptionReal('outro');
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAutor },
    body: JSON.stringify({ subscription: subAutor }),
  });
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieOutro },
    body: JSON.stringify({ subscription: subOutro }),
  });

  const id = 'MAN-push-exclusao-autor-' + Date.now();
  const respAbrir = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAutor },
    // "observador" é só quem relatou o problema (campo de tela) — de
    // propósito diferente de quem está logado, pra provar que a exclusão
    // usa a SESSÃO (quem realmente abriu), não este campo.
    body: JSON.stringify(payloadChamado(id, { observador: 'Outro Operador Qualquer' })),
  });
  assert.equal(respAbrir.status, 200);

  // O envio é fire-and-forget — espera um pouco pro POST assíncrono do
  // web-push (dentro do processo do servidor testado) chegar no servidor
  // de captura local antes de conferir.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.ok(pushesRecebidos.some(p => p.caminho === '/outro'), 'quem NÃO abriu deveria ter recebido a notificação');
  assert.ok(!pushesRecebidos.some(p => p.caminho === '/autor'), 'quem abriu o chamado não deveria receber a própria notificação');
});
