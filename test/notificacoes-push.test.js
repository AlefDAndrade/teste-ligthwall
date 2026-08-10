// ─── test/notificacoes-push.test.js ─────────────────────────────────────────
// Testa o sistema de notificação push de chamados de manutenção — abertura
// de chamado, aceite de chamado, pedido de peça e peça recebida (ver
// conversa que motivou isso: "toda vez que um chamado for aberto/aceito/
// tiver um pedido de peça/tiver a peça recebida, quem tem a permissão de
// notificação marcada no perfil é notificado", PC e celular via Web
// Push/PWA).
//
// Cobre: os itens de catálogo 'manutencao-notificacao-abertura',
// 'manutencao-notificacao-aceite', 'manutencao-notificacao-pedido-peca' e
// 'manutencao-notificacao-peca-recebida' (ver lib/itens-permissao.js), os
// padrões calculados pros 6 perfis fixos (ver lib/perfis.js,
// permissoesPadraoDoPerfilFixo), a cascata override/perfil-customizado (ver
// lib/notificacoes-push.js), as rotas GET /push/config, POST
// /push/inscrever, POST /push/desinscrever, e que salvar um chamado NUNCA
// falha/atrasa por causa do envio da notificação (mesmo com uma inscrição
// de push "morta"/inalcançável cadastrada).

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

// ═══════════════════════════════════════════════════════════════════════
// Notificação de ACEITE DE CHAMADO (POST /manutencao/aceitar-corretiva)
// ═══════════════════════════════════════════════════════════════════════
// Ver conversa que motivou isso: "hoje a notificação só existe quando a
// manutenção é solicitada, mas não existe uma notificação de quando a
// manutenção é aceita" — mesma infraestrutura da notificação de abertura,
// item de catálogo e grupo de destinatários próprios (padrão: Supervisão,
// Encarregado ou Administrador — ver lib/notificacoes-push.js,
// lib/itens-permissao.js, lib/perfis.js, lib/rotas/manutencao.js).

test('catálogo de permissões inclui o item de notificação de aceite de chamado', async () => {
  const resp = await fetch(`${servidor.baseUrl}/catalogo-permissoes`);
  const data = await resp.json();
  assert.equal(data.ok, true);
  const item = data.catalogo.find(i => i.id === 'manutencao-notificacao-aceite');
  assert.ok(item, 'item de notificação de aceite deveria estar no catálogo');
  assert.equal(item.pai, 'manutencao-corretiva');
  assert.equal(item.area, undefined, 'não deve conceder nenhuma área de edição');
});

test('Supervisão, Encarregado e Administrador recebem "total" por padrão; Manutenção e demais, "ocultar"', async () => {
  const respSupervisao = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Supervisao`);
  assert.equal((await respSupervisao.json()).permissoes['manutencao-notificacao-aceite'], 'total');

  const respEncarregado = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Encarregado`);
  assert.equal((await respEncarregado.json()).permissoes['manutencao-notificacao-aceite'], 'total');

  const respAdmin = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Administrativo`);
  assert.equal((await respAdmin.json()).permissoes['manutencao-notificacao-aceite'], 'total');

  const respManutencao = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Manutencao`);
  assert.equal((await respManutencao.json()).permissoes['manutencao-notificacao-aceite'], 'ocultar');

  const respOperador = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=OperadorInjetora`);
  assert.equal((await respOperador.json()).permissoes['manutencao-notificacao-aceite'], 'ocultar');
});

test('chamado aceito notifica quem tem a permissão, exceto quem aceitou', async () => {
  const cookieAbre = await cadastrarELogar('aceite.abre.chamado', 'Encarregado');
  const cookieTecnico = await cadastrarELogar('aceite.tecnico.aceita', 'Manutencao');
  const cookieSupervisorRecebe = await cadastrarELogar('aceite.supervisor.recebe', 'Supervisao');
  const cookieEncarregadoRecebe = await cadastrarELogar('aceite.encarregado.recebe', 'Encarregado');

  const id = 'MAN-push-aceite-1-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAbre },
    body: JSON.stringify(payloadChamado(id)),
  });

  // Inscrições feitas ANTES do aceite (é o evento sob teste aqui) — o
  // técnico que vai aceitar também se inscreve, pra provar que ele
  // mesmo é excluído da própria notificação.
  const subTecnico = subscriptionReal('aceite-tecnico-aceita');
  const subSupervisor = subscriptionReal('aceite-supervisor-recebe');
  const subEncarregado = subscriptionReal('aceite-encarregado-recebe');
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify({ subscription: subTecnico }),
  });
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisorRecebe },
    body: JSON.stringify({ subscription: subSupervisor }),
  });
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregadoRecebe },
    body: JSON.stringify({ subscription: subEncarregado }),
  });

  const respAceitar = await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify({ id }),
  });
  assert.equal(respAceitar.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.ok(pushesRecebidos.some(p => p.caminho === '/aceite-supervisor-recebe'), 'Supervisão deveria ter recebido a notificação de aceite');
  assert.ok(pushesRecebidos.some(p => p.caminho === '/aceite-encarregado-recebe'), 'Encarregado deveria ter recebido a notificação de aceite');
  assert.ok(!pushesRecebidos.some(p => p.caminho === '/aceite-tecnico-aceita'), 'quem aceitou o chamado não deveria receber a própria notificação');
});

test('aceitar de novo um chamado já aceito não notifica de novo (só na transição)', async () => {
  const cookieAbre = await cadastrarELogar('aceite.repeticao.abre', 'Encarregado');
  const cookieTecnico = await cadastrarELogar('aceite.repeticao.tecnico', 'Manutencao');
  const cookieSupervisor = await cadastrarELogar('aceite.repeticao.supervisor', 'Supervisao');

  const id = 'MAN-push-aceite-2-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAbre },
    body: JSON.stringify(payloadChamado(id)),
  });

  const subSupervisor = subscriptionReal('aceite-repeticao-supervisor');
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisor },
    body: JSON.stringify({ subscription: subSupervisor }),
  });

  await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify({ id }),
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const totalAposPrimeiroAceite = pushesRecebidos.filter(p => p.caminho === '/aceite-repeticao-supervisor').length;
  assert.equal(totalAposPrimeiroAceite, 1, 'deveria ter notificado uma vez no aceite');

  // "Aceita" de novo o mesmo chamado (já aceito — a rota é idempotente,
  // ver /manutencao/aceitar-corretiva) — não deveria notificar de novo.
  await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify({ id }),
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const totalDepois = pushesRecebidos.filter(p => p.caminho === '/aceite-repeticao-supervisor').length;
  assert.equal(totalDepois, 1, 'não deveria notificar de novo pro mesmo chamado já aceito');
});

// ═══════════════════════════════════════════════════════════════════════
// Notificação de PEDIDO DE PEÇA (chamado em execução + aguardandoPecas=Sim)
// ═══════════════════════════════════════════════════════════════════════
// Ver conversa que motivou isso: avisar quando um chamado JÁ EM EXECUÇÃO

// (situacao='Em Manutencao') for salvo com "Aguardando peças? = Sim" —
// mesma infraestrutura da notificação de abertura, item de catálogo e
// grupo de destinatários próprios (ver lib/notificacoes-push.js,
// lib/itens-permissao.js, lib/rotas/manutencao.js).

test('catálogo de permissões inclui o item de notificação de pedido de peça', async () => {
  const resp = await fetch(`${servidor.baseUrl}/catalogo-permissoes`);
  const data = await resp.json();
  assert.equal(data.ok, true);
  const item = data.catalogo.find(i => i.id === 'manutencao-notificacao-pedido-peca');
  assert.ok(item, 'item de notificação de pedido de peça deveria estar no catálogo');
  assert.equal(item.pai, 'manutencao-corretiva');
  assert.equal(item.area, undefined, 'não deve conceder nenhuma área de edição');
});

test('padrão do item de pedido de peça: Supervisão/Encarregado/Administrador recebem; Manutenção e os demais não', async () => {
  const respSupervisao = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Supervisao`);
  assert.equal((await respSupervisao.json()).permissoes['manutencao-notificacao-pedido-peca'], 'total');

  const respEncarregado = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Encarregado`);
  assert.equal((await respEncarregado.json()).permissoes['manutencao-notificacao-pedido-peca'], 'total');

  const respAdmin = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Administrativo`);
  assert.equal((await respAdmin.json()).permissoes['manutencao-notificacao-pedido-peca'], 'total');

  // Manutenção é quem ABRE o pedido de peça, não quem recebe o aviso —
  // padrão 'ocultar', diferente do item de abertura de chamado (esse sim
  // 'total' pra Manutenção).
  const respManutencao = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Manutencao`);
  assert.equal((await respManutencao.json()).permissoes['manutencao-notificacao-pedido-peca'], 'ocultar');

  const respOperador = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=OperadorInjetora`);
  assert.equal((await respOperador.json()).permissoes['manutencao-notificacao-pedido-peca'], 'ocultar');
});

async function abrirEAceitarChamado(id, cookieAbre, cookieAceita) {
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAbre },
    body: JSON.stringify(payloadChamado(id)),
  });
  await fetch(`${servidor.baseUrl}/manutencao/aceitar-corretiva`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAceita },
    body: JSON.stringify({ id }),
  });
}

test('chamado em execução salvo com aguardandoPecas=Sim notifica quem tem a permissão, exceto quem salvou', async () => {
  const cookieAbre = await cadastrarELogar('peca.abre.chamado', 'Encarregado');
  const cookieTecnico = await cadastrarELogar('peca.tecnico.aceita', 'Manutencao');
  const cookieSupervisorMarca = await cadastrarELogar('peca.supervisor.marca', 'Supervisao');
  const cookieEncarregadoRecebe = await cadastrarELogar('peca.encarregado.recebe', 'Encarregado');

  const id = 'MAN-push-peca-1-' + Date.now();
  await abrirEAceitarChamado(id, cookieAbre, cookieTecnico);

  // Técnico coloca o chamado em execução — ANTES das inscrições abaixo,
  // de propósito: este salvamento não dispara nenhuma notificação
  // específica (só muda "situacao"), mas agora DISPARA a notificação
  // GENÉRICA de "Atualização de Etiqueta" (ver bloco de testes dedicado,
  // mais abaixo) — inscrever DEPOIS dele garante que este teste segue
  // isolado, testando só a transição de pedido de peça em si.
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify(payloadChamado(id, { situacao: 'Em Manutencao' })),
  });

  // Inscrições feitas só DEPOIS do chamado já em execução — de
  // propósito, pra não confundir com a notificação de ABERTURA (outro
  // evento, já testado acima) nem com a genérica de atualização
  // disparada pelo passo acima.
  const subSupervisorMarca = subscriptionReal('peca-supervisor-marca');
  const subEncarregadoRecebe = subscriptionReal('peca-encarregado-recebe');
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisorMarca },
    body: JSON.stringify({ subscription: subSupervisorMarca }),
  });
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregadoRecebe },
    body: JSON.stringify({ subscription: subEncarregadoRecebe }),
  });

  // Supervisão marca "Aguardando peças? = Sim" — é isso que deve
  // disparar (perfil elegível pra tanto editar quanto receber, então
  // prova de verdade a exclusão de quem salvou, não só a permissão).
  const respPedido = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisorMarca },
    body: JSON.stringify(payloadChamado(id, { situacao: 'Em Manutencao', aguardandoPecas: 'Sim', pecasComprar: 'Rolamento push' })),
  });
  assert.equal(respPedido.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.ok(pushesRecebidos.some(p => p.caminho === '/peca-encarregado-recebe'), 'Encarregado deveria ter recebido a notificação de pedido de peça');
  assert.ok(!pushesRecebidos.some(p => p.caminho === '/peca-supervisor-marca'), 'quem marcou o pedido não deveria receber a própria notificação');
});

test('aguardandoPecas=Sim em chamado que NÃO está em execução não dispara a notificação ESPECÍFICA de pedido de peça (mas dispara a genérica de atualização)', async () => {
  const cookieAbre = await cadastrarELogar('peca.sem.execucao.abre', 'Encarregado');
  const cookieTecnico = await cadastrarELogar('peca.sem.execucao.tecnico', 'Manutencao');
  const cookieSupervisor = await cadastrarELogar('peca.sem.execucao.supervisor', 'Supervisao');

  const id = 'MAN-push-peca-2-' + Date.now();
  await abrirEAceitarChamado(id, cookieAbre, cookieTecnico);

  // Inscrição só depois de aberto/aceito — mesmo motivo do teste acima.
  const subSupervisor = subscriptionReal('peca-sem-execucao-supervisor');
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisor },
    body: JSON.stringify({ subscription: subSupervisor }),
  });

  // Marca aguardandoPecas=Sim SEM nunca ter passado a situacao pra "Em
  // Manutencao" (fica no padrão "Aguardando") — chamado já aceito
  // (Execução liberada), mas ainda não "em execução" de fato.
  const respMarca = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify(payloadChamado(id, { aguardandoPecas: 'Sim' })),
  });
  assert.equal(respMarca.status, 200);
  assert.equal((await respMarca.json()).chamado.situacao, 'Aguardando');

  await new Promise((resolve) => setTimeout(resolve, 1500));

  // A notificação ESPECÍFICA de "pedido de peça" continua não disparando
  // fora do estado "em execução" (regra de negócio inalterada) — mas,
  // como este salvamento é um UPDATE de um chamado já existente e
  // NENHUMA notificação específica disparou pra ele, a notificação
  // GENÉRICA de "Atualização de Etiqueta" (pedido do usuário: "notificar
  // todas as atualizações") cobre esse caso — Supervisão recebe 'total'
  // por padrão pra esse item (ver permissoesPadraoDoPerfilFixo,
  // lib/perfis.js), então o push chega mesmo assim, só que por esse
  // canal genérico, não o específico de pedido de peça.
  assert.ok(pushesRecebidos.some(p => p.caminho === '/peca-sem-execucao-supervisor'), 'a notificação genérica de atualização deveria ter disparado, já que nenhuma específica disparou pra este update');
});

test('salvar de novo um chamado que já estava com aguardandoPecas=Sim não notifica de novo (só na transição)', async () => {
  const cookieAbre = await cadastrarELogar('peca.repeticao.abre', 'Encarregado');
  const cookieTecnico = await cadastrarELogar('peca.repeticao.tecnico', 'Manutencao');
  const cookieSupervisor = await cadastrarELogar('peca.repeticao.supervisor', 'Supervisao');

  const id = 'MAN-push-peca-3-' + Date.now();
  await abrirEAceitarChamado(id, cookieAbre, cookieTecnico);

  const subSupervisor = subscriptionReal('peca-repeticao-supervisor');
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisor },
    body: JSON.stringify({ subscription: subSupervisor }),
  });

  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify(payloadChamado(id, { situacao: 'Em Manutencao', aguardandoPecas: 'Sim' })),
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const totalAposPrimeiroPedido = pushesRecebidos.filter(p => p.caminho === '/peca-repeticao-supervisor').length;
  assert.equal(totalAposPrimeiroPedido, 1, 'deveria ter notificado uma vez na abertura do pedido');

  // Supervisão aceita o pedido e depois salva o Acompanhamento — chamado
  // continua com aguardandoPecas='Sim' (sem transição nova), não deveria
  // notificar de novo.
  await fetch(`${servidor.baseUrl}/manutencao/aceitar-pedido-peca`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisor },
    body: JSON.stringify({ id }),
  });
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisor },
    body: JSON.stringify(payloadChamado(id, { situacao: 'Em Manutencao', aguardandoPecas: 'Sim', statusCompra: 'Em Análise' })),
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const totalDepois = pushesRecebidos.filter(p => p.caminho === '/peca-repeticao-supervisor').length;
  assert.equal(totalDepois, 1, 'não deveria notificar de novo pro mesmo pedido já em aberto');
});

// ═══════════════════════════════════════════════════════════════════════
// Notificação de PEÇA RECEBIDA (statusCompra = 'Peça recebida')
// ═══════════════════════════════════════════════════════════════════════
// Pedido do usuário: avisar Manutenção, Administrador, Supervisão e
// Encarregado quando um chamado for salvo com "Status da Compra = Peça
// recebida" — mesma infraestrutura das notificações acima, item de
// catálogo e grupo de destinatários próprios (ver lib/notificacoes-push.js,
// lib/itens-permissao.js, lib/rotas/manutencao.js).

test('catálogo de permissões inclui o item de notificação de peça recebida', async () => {
  const resp = await fetch(`${servidor.baseUrl}/catalogo-permissoes`);
  const data = await resp.json();
  assert.equal(data.ok, true);
  const item = data.catalogo.find(i => i.id === 'manutencao-notificacao-peca-recebida');
  assert.ok(item, 'item de notificação de peça recebida deveria estar no catálogo');
  assert.equal(item.pai, 'manutencao-corretiva');
  assert.equal(item.area, undefined, 'não deve conceder nenhuma área de edição');
});

test('padrão do item de peça recebida: Manutenção/Supervisão/Encarregado/Administrador recebem; os demais não', async () => {
  const respManutencao = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Manutencao`);
  assert.equal((await respManutencao.json()).permissoes['manutencao-notificacao-peca-recebida'], 'total');

  const respSupervisao = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Supervisao`);
  assert.equal((await respSupervisao.json()).permissoes['manutencao-notificacao-peca-recebida'], 'total');

  const respEncarregado = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Encarregado`);
  assert.equal((await respEncarregado.json()).permissoes['manutencao-notificacao-peca-recebida'], 'total');

  const respAdmin = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Administrativo`);
  assert.equal((await respAdmin.json()).permissoes['manutencao-notificacao-peca-recebida'], 'total');

  const respOperador = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=OperadorInjetora`);
  assert.equal((await respOperador.json()).permissoes['manutencao-notificacao-peca-recebida'], 'ocultar');

  const respQualidade = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=AssistenteQualidade`);
  assert.equal((await respQualidade.json()).permissoes['manutencao-notificacao-peca-recebida'], 'ocultar');
});

test('chamado salvo com statusCompra="Peça recebida" notifica quem tem a permissão, exceto quem salvou', async () => {
  const cookieAbre = await cadastrarELogar('recebida.abre.chamado', 'Encarregado');
  const cookieTecnicoMarca = await cadastrarELogar('recebida.tecnico.marca', 'Manutencao');
  const cookieSupervisorRecebe = await cadastrarELogar('recebida.supervisor.recebe', 'Supervisao');
  const cookieEncarregadoRecebe = await cadastrarELogar('recebida.encarregado.recebe', 'Encarregado');

  const id = 'MAN-push-recebida-1-' + Date.now();
  await abrirEAceitarChamado(id, cookieAbre, cookieTecnicoMarca);

  // Inscrições feitas só DEPOIS do chamado já aberto/aceito — de
  // propósito, pra não confundir com as notificações de abertura/pedido
  // de peça (outros eventos, já testados acima).
  const subSupervisorRecebe = subscriptionReal('recebida-supervisor-recebe');
  const subEncarregadoRecebe = subscriptionReal('recebida-encarregado-recebe');
  const subTecnicoMarca = subscriptionReal('recebida-tecnico-marca');
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisorRecebe },
    body: JSON.stringify({ subscription: subSupervisorRecebe }),
  });
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregadoRecebe },
    body: JSON.stringify({ subscription: subEncarregadoRecebe }),
  });
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnicoMarca },
    body: JSON.stringify({ subscription: subTecnicoMarca }),
  });

  // Técnico marca o status da compra como "Peça recebida" — é isso que
  // deve disparar (perfil elegível pra tanto editar quanto receber, então
  // prova de verdade a exclusão de quem salvou, não só a permissão).
  const respRecebida = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnicoMarca },
    body: JSON.stringify(payloadChamado(id, { situacao: 'Em Manutencao', aguardandoPecas: 'Sim', statusCompra: 'Peça recebida', supDataFim: '2026-07-23' })),
  });
  assert.equal(respRecebida.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.ok(pushesRecebidos.some(p => p.caminho === '/recebida-supervisor-recebe'), 'Supervisão deveria ter recebido a notificação de peça recebida');
  assert.ok(pushesRecebidos.some(p => p.caminho === '/recebida-encarregado-recebe'), 'Encarregado deveria ter recebido a notificação de peça recebida');
  assert.ok(!pushesRecebidos.some(p => p.caminho === '/recebida-tecnico-marca'), 'quem marcou a peça como recebida não deveria receber a própria notificação');
});

test('salvar de novo um chamado que já estava com statusCompra="Peça recebida" não notifica de novo (só na transição)', async () => {
  const cookieAbre = await cadastrarELogar('recebida.repeticao.abre', 'Encarregado');
  const cookieTecnico = await cadastrarELogar('recebida.repeticao.tecnico', 'Manutencao');
  const cookieSupervisor = await cadastrarELogar('recebida.repeticao.supervisor', 'Supervisao');

  const id = 'MAN-push-recebida-2-' + Date.now();
  await abrirEAceitarChamado(id, cookieAbre, cookieTecnico);

  const subSupervisor = subscriptionReal('recebida-repeticao-supervisor');
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisor },
    body: JSON.stringify({ subscription: subSupervisor }),
  });

  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify(payloadChamado(id, { situacao: 'Em Manutencao', statusCompra: 'Peça recebida', supDataFim: '2026-07-23' })),
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const totalAposPrimeiraMarcacao = pushesRecebidos.filter(p => p.caminho === '/recebida-repeticao-supervisor').length;
  assert.equal(totalAposPrimeiraMarcacao, 1, 'deveria ter notificado uma vez quando a peça foi marcada como recebida');

  // Salva de novo o mesmo chamado, já com a peça recebida (sem transição
  // nova) — não deveria notificar de novo.
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisor },
    body: JSON.stringify(payloadChamado(id, { situacao: 'Em Manutencao', statusCompra: 'Peça recebida', supDataFim: '2026-07-23', fornecedor: 'Fornecedor Teste' })),
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const totalDepois = pushesRecebidos.filter(p => p.caminho === '/recebida-repeticao-supervisor').length;
  assert.equal(totalDepois, 1, 'não deveria notificar de novo pro mesmo chamado já com a peça recebida');
});

// ═══════════════════════════════════════════════════════════════════════
// Notificação GENÉRICA de "Atualização de Etiqueta" (corretiva e
// programada) — pedido do usuário: "notificar todas as atualizações que
// forem feitas em uma etiqueta, tanto corretiva como programada". Cobre
// updates de um registro JÁ EXISTENTE que não disparam nenhuma das
// notificações específicas de cima (ver lib/notificacoes-push.js,
// lib/itens-permissao.js, lib/rotas/manutencao.js). NÃO cobre criação
// (já tem "abertura"/"agendamento criado") nem exclusão (fora do escopo
// pedido).
// ═══════════════════════════════════════════════════════════════════════

test('catálogo de permissões inclui o item de notificação genérica de atualização de etiqueta', async () => {
  const resp = await fetch(`${servidor.baseUrl}/catalogo-permissoes`);
  const data = await resp.json();
  assert.equal(data.ok, true);
  const item = data.catalogo.find(i => i.id === 'manutencao-notificacao-atualizacao');
  assert.ok(item, 'item de notificação de atualização de etiqueta deveria estar no catálogo');
  assert.equal(item.pai, 'manutencao-corretiva');
  assert.equal(item.area, undefined, 'não deve conceder nenhuma área de edição');
});

test('padrão do item de atualização de etiqueta: quem edita Manutenção recebe "total"; Assistente de Qualidade recebe "ocultar"', async () => {
  const respManutencao = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Manutencao`);
  assert.equal((await respManutencao.json()).permissoes['manutencao-notificacao-atualizacao'], 'total');

  const respSupervisao = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Supervisao`);
  assert.equal((await respSupervisao.json()).permissoes['manutencao-notificacao-atualizacao'], 'total');

  const respEncarregado = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Encarregado`);
  assert.equal((await respEncarregado.json()).permissoes['manutencao-notificacao-atualizacao'], 'total');

  const respAdmin = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=Administrativo`);
  assert.equal((await respAdmin.json()).permissoes['manutencao-notificacao-atualizacao'], 'total');

  const respOperador = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=OperadorInjetora`);
  assert.equal((await respOperador.json()).permissoes['manutencao-notificacao-atualizacao'], 'total');

  const respQualidade = await fetch(`${servidor.baseUrl}/permissoes-perfil-fixo?perfil=AssistenteQualidade`);
  assert.equal((await respQualidade.json()).permissoes['manutencao-notificacao-atualizacao'], 'ocultar');
});

test('editar um chamado corretivo já existente (sem disparar nenhuma notificação específica) notifica quem tem a permissão de atualização, exceto quem salvou', async () => {
  const cookieAbre = await cadastrarELogar('atualizacao.abre.chamado', 'Encarregado');
  const cookieTecnico = await cadastrarELogar('atualizacao.tecnico.edita', 'Manutencao');
  const cookieSupervisorRecebe = await cadastrarELogar('atualizacao.supervisor.recebe', 'Supervisao');

  const id = 'MAN-push-atualizacao-1-' + Date.now();
  await abrirEAceitarChamado(id, cookieAbre, cookieTecnico);

  // Inscrição só depois de aberto/aceito — mesmo motivo dos testes acima.
  const subSupervisorRecebe = subscriptionReal('atualizacao-supervisor-recebe');
  const subTecnicoEdita = subscriptionReal('atualizacao-tecnico-edita');
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieSupervisorRecebe },
    body: JSON.stringify({ subscription: subSupervisorRecebe }),
  });
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify({ subscription: subTecnicoEdita }),
  });

  // Técnico só edita a Execução (sem mexer em aguardandoPecas/statusCompra)
  // — não é abertura, não é pedido de peça, não é peça recebida: nenhuma
  // notificação específica se aplica aqui.
  const respEdita = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify(payloadChamado(id, { situacao: 'Em Manutencao', diagnostico: 'Rolamento gasto — troca em andamento' })),
  });
  assert.equal(respEdita.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.ok(pushesRecebidos.some(p => p.caminho === '/atualizacao-supervisor-recebe'), 'Supervisão deveria ter recebido a notificação genérica de atualização');
  assert.ok(!pushesRecebidos.some(p => p.caminho === '/atualizacao-tecnico-edita'), 'quem editou não deveria receber a própria notificação');
});

test('fechar a etiqueta de um chamado corretivo (etiquetaFechada=true) notifica pela atualização genérica', async () => {
  const cookieAbre = await cadastrarELogar('atualizacao.fecha.abre', 'Encarregado');
  const cookieTecnico = await cadastrarELogar('atualizacao.fecha.tecnico', 'Manutencao');
  const cookieEncarregadoRecebe = await cadastrarELogar('atualizacao.fecha.encarregado', 'Encarregado');

  const id = 'MAN-push-atualizacao-fecha-' + Date.now();
  await abrirEAceitarChamado(id, cookieAbre, cookieTecnico);

  const subEncarregadoRecebe = subscriptionReal('atualizacao-fecha-encarregado');
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregadoRecebe },
    body: JSON.stringify({ subscription: subEncarregadoRecebe }),
  });

  // Encarregado fecha a etiqueta — exige 'manutencao' completa (grupo
  // certo pra isso, ver lib/rotas/manutencao.js).
  const respFecha = await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAbre },
    body: JSON.stringify(payloadChamado(id, { situacao: 'Concluido', etiquetaFechada: true, dataFim: '2026-07-23' })),
  });
  assert.equal(respFecha.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.ok(pushesRecebidos.some(p => p.caminho === '/atualizacao-fecha-encarregado'), 'deveria notificar o fechamento da etiqueta pela atualização genérica');
});

test('abrir um chamado corretivo novo NÃO dispara a notificação genérica de atualização (só a de abertura)', async () => {
  const cookieAbre = await cadastrarELogar('atualizacao.criacao.abre', 'Encarregado');
  const cookieOutro = await cadastrarELogar('atualizacao.criacao.outro', 'Supervisao');

  const subOutro = subscriptionReal('atualizacao-criacao-outro');
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieOutro },
    body: JSON.stringify({ subscription: subOutro }),
  });

  const id = 'MAN-push-atualizacao-criacao-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAbre },
    body: JSON.stringify(payloadChamado(id)),
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Recebe (via notificação de ABERTURA — já testado em outro bloco),
  // mas só uma vez — a genérica não duplica o aviso na criação.
  const total = pushesRecebidos.filter(p => p.caminho === '/atualizacao-criacao-outro').length;
  assert.equal(total, 1, 'criação de chamado deveria notificar só uma vez (abertura), sem duplicar pela genérica');
});

test('salvar um pedido de peça (transição específica) NÃO duplica com a notificação genérica de atualização', async () => {
  const cookieAbre = await cadastrarELogar('atualizacao.dup.abre', 'Encarregado');
  const cookieTecnico = await cadastrarELogar('atualizacao.dup.tecnico', 'Manutencao');
  const cookieEncarregadoRecebe = await cadastrarELogar('atualizacao.dup.encarregado', 'Encarregado');

  const id = 'MAN-push-atualizacao-dup-' + Date.now();
  await abrirEAceitarChamado(id, cookieAbre, cookieTecnico);

  const subEncarregadoRecebe = subscriptionReal('atualizacao-dup-encarregado');
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieEncarregadoRecebe },
    body: JSON.stringify({ subscription: subEncarregadoRecebe }),
  });

  // Técnico abre um pedido de peça de verdade (transição) — dispara a
  // notificação ESPECÍFICA de pedido de peça; a genérica de atualização
  // NÃO deveria disparar também pra este mesmo salvamento (evitar
  // duplicar aviso pro mesmo evento).
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieTecnico },
    body: JSON.stringify(payloadChamado(id, { situacao: 'Em Manutencao', aguardandoPecas: 'Sim', pecasComprar: 'Correia push' })),
  });

  await new Promise((resolve) => setTimeout(resolve, 1500));

  const total = pushesRecebidos.filter(p => p.caminho === '/atualizacao-dup-encarregado').length;
  assert.equal(total, 1, 'não deveria duplicar: só a notificação específica de pedido de peça, não a genérica também');
});

test('atualizar um agendamento de manutenção programada já existente (aprovar) notifica pela atualização genérica', async () => {
  const cookieCria = await cadastrarELogar('atualizacao.prog.cria', 'Encarregado');
  const cookieAprova = await cadastrarELogar('atualizacao.prog.aprova', 'Encarregado');
  const cookieOutroRecebe = await cadastrarELogar('atualizacao.prog.outro', 'Supervisao');

  const id = 'MAN-PROG-push-atualizacao-1-' + Date.now();
  const agendamentoBase = {
    id, data: '2026-08-20', hora: '09:00', setor: 'Injetora', maquina: 'M-prog-push',
    tipo: 'Preventiva', solicitante: 'joao.solicitante', status: 'Pendente',
  };

  await fetch(`${servidor.baseUrl}/manutencao/programada`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieCria },
    body: JSON.stringify(agendamentoBase),
  });

  // Inscrição só DEPOIS da criação — de propósito, pra não confundir com
  // a notificação de "agendamento criado" (outro evento, já testado
  // noutro bloco).
  const subOutroRecebe = subscriptionReal('atualizacao-prog-outro');
  await fetch(`${servidor.baseUrl}/push/inscrever`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieOutroRecebe },
    body: JSON.stringify({ subscription: subOutroRecebe }),
  });

  // Aprova o agendamento (update de um registro já existente) — dispara
  // a notificação genérica de atualização.
  const respAprova = await fetch(`${servidor.baseUrl}/manutencao/programada`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAprova },
    body: JSON.stringify({ ...agendamentoBase, status: 'Aprovado' }),
  });
  assert.equal(respAprova.status, 200);

  await new Promise((resolve) => setTimeout(resolve, 1500));

  assert.ok(pushesRecebidos.some(p => p.caminho === '/atualizacao-prog-outro'), 'deveria notificar a aprovação do agendamento pela atualização genérica');
});
