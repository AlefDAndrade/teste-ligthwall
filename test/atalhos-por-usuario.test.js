// ─── test/atalhos-por-usuario.test.js ───────────────────────────────────────
// Testa o sistema de atalhos de teclado por USUÁRIO (ver conversa que
// motivou isso): cada pessoa cadastrada (Operador/Analista/Qualidade/
// Manutencao/Administrativo) tem seus próprios atalhos persistidos no
// SERVIDOR, associados ao usuarioId — diferente de antes (localStorage,
// preso a "este navegador"). O Administrador Master (senha mestra, sem
// usuário próprio) continua em localStorage, sem mudança nenhuma.
//
// Cobre: rotas de backend (GET /meus-atalhos, POST /salvar-meus-atalhos)
// via HTTP direto, e o comportamento do front (keyboard-shortcuts.js)
// via servidor real + jsdom — mesmo padrão de test/usuarios-perfil.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-teste-atalhos-654';
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

async function cadastrarELogar(nomeUsuario, perfil) {
  const cookieAdmin = await logarComoAdminMaster();
  // POST /salvar-usuarios SUBSTITUI a lista inteira — busca quem já
  // existe primeiro, senão cada chamada apagaria os usuários cadastrados
  // em chamadas anteriores deste mesmo arquivo de teste.
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

// ═══════════════════════════════════════════════════════════════════════
// Backend — rotas puras via HTTP
// ═══════════════════════════════════════════════════════════════════════

test('GET /meus-atalhos exige sessao de usuario', async () => {
  const resp = await fetch(`${servidor.baseUrl}/meus-atalhos`);
  assert.equal(resp.status, 403);
});

test('POST /salvar-meus-atalhos exige sessao de usuario', async () => {
  const resp = await fetch(`${servidor.baseUrl}/salvar-meus-atalhos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ atalhos: { nav_operacao: 'Alt+9' } }),
  });
  assert.equal(resp.status, 403);
});

test('usuario novo comeca com atalhos vazios, salva, e GET reflete', async () => {
  const cookie = await cadastrarELogar('rita.atalhos', 'Operador');

  const respVazio = await fetch(`${servidor.baseUrl}/meus-atalhos`, { headers: { Cookie: cookie } });
  const dataVazio = await respVazio.json();
  assert.equal(dataVazio.ok, true);
  assert.deepEqual(dataVazio.atalhos, {});

  const respSalvar = await fetch(`${servidor.baseUrl}/salvar-meus-atalhos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ atalhos: { nav_operacao: 'Ctrl+Shift+9', acao_registrar: '' } }),
  });
  assert.equal(respSalvar.status, 200);
  const dataSalvar = await respSalvar.json();
  assert.equal(dataSalvar.ok, true);
  assert.deepEqual(dataSalvar.atalhos, { nav_operacao: 'Ctrl+Shift+9', acao_registrar: '' });

  const respDepois = await fetch(`${servidor.baseUrl}/meus-atalhos`, { headers: { Cookie: cookie } });
  const dataDepois = await respDepois.json();
  assert.deepEqual(dataDepois.atalhos, { nav_operacao: 'Ctrl+Shift+9', acao_registrar: '' });
});

test('atalhos de um usuario nao vazam pra outro', async () => {
  const cookieCarlos = await cadastrarELogar('carlos.atalhos', 'Analista');
  const cookieMaria = await cadastrarELogar('maria.atalhos', 'Analista');

  await fetch(`${servidor.baseUrl}/salvar-meus-atalhos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieCarlos },
    body: JSON.stringify({ atalhos: { acao_filtro: 'Alt+F' } }),
  });

  const respMaria = await fetch(`${servidor.baseUrl}/meus-atalhos`, { headers: { Cookie: cookieMaria } });
  const dataMaria = await respMaria.json();
  assert.deepEqual(dataMaria.atalhos, {}, 'maria nao deveria ver o atalho personalizado do carlos');

  const respCarlos = await fetch(`${servidor.baseUrl}/meus-atalhos`, { headers: { Cookie: cookieCarlos } });
  const dataCarlos = await respCarlos.json();
  assert.deepEqual(dataCarlos.atalhos, { acao_filtro: 'Alt+F' });
});

test('POST /salvar-usuarios (Admin Master editando cadastro) preserva os atalhos existentes', async () => {
  const cookie = await cadastrarELogar('joao.preserva', 'Manutencao');
  await fetch(`${servidor.baseUrl}/salvar-meus-atalhos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ atalhos: { acao_config: 'Alt+K' } }),
  });

  const cookieAdmin = await logarComoAdminMaster();
  const respUsuarios = await fetch(`${servidor.baseUrl}/usuarios`);
  const { usuarios } = await respUsuarios.json();
  const joao = usuarios.find(u => u.nomeUsuario === 'joao.preserva');

  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ id: joao.id, nomeUsuario: 'joao.renomeado', perfil: 'Manutencao', podeIniciarOperacao: false }]),
  });

  const respDepois = await fetch(`${servidor.baseUrl}/meus-atalhos`, { headers: { Cookie: cookie } });
  const dataDepois = await respDepois.json();
  assert.deepEqual(dataDepois.atalhos, { acao_config: 'Alt+K' }, 'atalhos deveriam ter sido preservados mesmo sem o admin mandar esse campo');
});

test('valor nao-string em algum atalho e recusado', async () => {
  const cookie = await cadastrarELogar('paulo.invalido', 'Qualidade');
  const resp = await fetch(`${servidor.baseUrl}/salvar-meus-atalhos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ atalhos: { acao_config: 123 } }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);
});

// ═══════════════════════════════════════════════════════════════════════
// Front-end — keyboard-shortcuts.js usando servidor vs localStorage
// ═══════════════════════════════════════════════════════════════════════

async function carregarSpaComo(cookieUsuario, perfil) {
  const dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        const headers = { ...(opts && opts.headers) };
        if (cookieUsuario) headers.Cookie = cookieUsuario;
        return fetch(absoluta, { ...opts, headers });
      };
    },
  });
  dom.window.sessionStorage.setItem('lw_role', perfil);
  await new Promise(r => setTimeout(r, 2500));
  return dom;
}

test('atalho personalizado por um usuario aparece numa sessao nova do mesmo usuario (persistiu no servidor)', async () => {
  const cookie = await cadastrarELogar('fernanda.persistencia', 'Operador');

  const dom1 = await carregarSpaComo(cookie, 'Operador');
  try {
    const resultado = dom1.window.LWKeyboard.definirAtalho('nav_operacao', 'Ctrl+Shift+7');
    assert.equal(resultado.ok, true);
    await new Promise(r => setTimeout(r, 500));
  } finally {
    dom1.window.close();
  }

  const dom2 = await carregarSpaComo(cookie, 'Operador');
  try {
    await new Promise(r => setTimeout(r, 500));
    const lista = dom2.window.LWKeyboard.listarAtalhos();
    const item = lista.find(a => a.id === 'nav_operacao');
    assert.equal(item.comboAtual, 'Ctrl+Shift+7');
  } finally {
    dom2.window.close();
  }
});

test('Administrador Master nunca chama /meus-atalhos — continua em localStorage', async () => {
  let chamouMeusAtalhos = false;
  const dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        if (absoluta.includes('/meus-atalhos')) chamouMeusAtalhos = true;
        return fetch(absoluta, opts);
      };
    },
  });
  const { window } = dom;
  try {
    window.localStorage.setItem('lw_admin_authenticated', 'true');
    window.sessionStorage.setItem('lw_role', 'Administrador');
    await new Promise(r => setTimeout(r, 2500));

    assert.equal(chamouMeusAtalhos, false);

    const resultado = window.LWKeyboard.definirAtalho('nav_operacao', 'Ctrl+Shift+6');
    assert.equal(resultado.ok, true);
    await new Promise(r => setTimeout(r, 300));

    assert.equal(chamouMeusAtalhos, false, 'salvar nao deveria ter chamado o servidor');
    const salvo = window.localStorage.getItem('lw_atalhos_customizados');
    assert.ok(salvo && salvo.includes('Ctrl+Shift+6'));
  } finally {
    window.close();
  }
});
