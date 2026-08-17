// ─── test/exportar-pdf-sessao.test.js ───────────────────────────────────────
// Etapa 1 do plano "PDF sobrevive a fechar a aba" (ver README): o job
// precisa ter um DONO (job.usuarioId) pra permitir, nas próximas etapas, o
// bloqueio de "um job pendente por usuário" e o aviso de "PDF pronto" ao
// voltar no site. Isso exige que POST /exportar-pdf/iniciar passe a recusar
// requests sem sessão de usuário válida (lib/sessao-usuario.js) — antes
// desta etapa a rota era aberta de propósito.
//
// Não testamos aqui a geração do PDF em si (precisaria de um Chromium de
// verdade instalado na máquina de teste, ver deploy/instalar-chromium-pdf.sh
// — fora do escopo de CI) — só o portão de sessão: sem cookie → 403 ANTES
// de tocar em qualquer outra validação; com cookie válido → passa direto
// pelo portão e cai nas validações seguintes (corpo/HTML, depois
// Chromium), nunca mais no 403. Isso já cobre o que muda nesta etapa sem
// depender de infraestrutura externa.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-teste-exportar-pdf-901';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
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

// Mesmo padrão de test/atalhos-por-usuario.test.js — POST /salvar-usuarios
// substitui a lista inteira, então busca quem já existe antes de acrescentar.
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

test('POST /exportar-pdf/iniciar sem sessão de usuário → 403, sem chegar a criar job nenhum', async () => {
  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/iniciar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html: '<html><body>oi</body></html>', filename: 'teste.pdf' }),
  });
  assert.equal(resp.status, 403);
  const corpo = await resp.json();
  assert.equal(corpo.ok, false);
  assert.match(corpo.erro, /sessão/i);
});

test('POST /exportar-pdf/iniciar com cookie de Admin Master (sessão de OUTRO tipo) continua recusando — só sessão de usuário cadastrado vale', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/iniciar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ html: '<html><body>oi</body></html>', filename: 'teste.pdf' }),
  });
  // lib/sessao.js (Admin Master) e lib/sessao-usuario.js (usuário
  // cadastrado) são cookies DIFERENTES e não intercambiáveis (ver
  // comentário no topo de sessao-usuario.js) — mandar só o cookie de
  // Admin Master não deve satisfazer sessaoUsuario.dadosDaSessao().
  assert.equal(resp.status, 403);
});

test('POST /exportar-pdf/iniciar com sessão de usuário cadastrado válida passa do portão de sessão (para de dar 403)', async () => {
  const cookieUsuario = await cadastrarELogar('usuario-teste-pdf', 'Supervisao');
  assert.ok(cookieUsuario, 'login deveria ter devolvido um cookie de sessão de usuário');

  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/iniciar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieUsuario },
    body: JSON.stringify({ html: '<html><body>oi</body></html>', filename: 'teste.pdf' }),
  });

  // Não afirmamos sucesso (200) aqui de propósito: a máquina de teste pode
  // não ter Chromium instalado (ver deploy/instalar-chromium-pdf.sh), e
  // nesse caso a rota responde 500 com uma mensagem explicando o que
  // instalar — isso é esperado e não tem relação com sessão. O que
  // importa pra Etapa 1 é que NUNCA MAIS seja 403 depois de autenticado.
  assert.notEqual(resp.status, 403);
});

test('POST /exportar-pdf/iniciar sem sessão continua sendo 403 mesmo com HTML vazio — checagem de sessão vem antes de qualquer outra validação', async () => {
  const resp = await fetch(`${servidor.baseUrl}/exportar-pdf/iniciar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}), // corpo inválido (sem html) — mesmo assim, sessão é checada PRIMEIRO
  });
  assert.equal(resp.status, 403);
});
