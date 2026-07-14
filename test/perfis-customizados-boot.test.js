// ─── test/perfis-customizados-boot.test.js ──────────────────────────────────
// Regressão de um bug real: ao logar com um usuário de perfil CUSTOMIZADO
// (Configurações → Usuários → "+ Criar novo tipo de perfil"), o boot da SPA
// (app-core.js, DOMContentLoaded) tratava o perfil como inválido — o id
// gerado (ex: "custom_lider-de-turno_...") nunca batia com a lista fixa de
// "perfis válidos" hardcoded ali — e mandava a pessoa de volta pro login,
// mesmo com uma sessão real e válida no servidor.
//
// Cobre também dois efeitos colaterais do mesmo bug/pedido: (1) 'menu'
// precisa estar SEMPRE entre as páginas permitidas de qualquer perfil
// customizado, já que é a página de pouso padrão depois do login; e (2) os
// cards do Menu Principal precisam refletir a visibilidade por perfil (só
// tinham "data-page" os itens do menu lateral — os cards do Menu Principal
// ficavam sempre visíveis pra todo mundo, sem filtro nenhum).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-boot-perfil-customizado-852';
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

test('GET /perfis inclui "menu" nas páginas permitidas de um perfil customizado, mesmo sem marcar nada explicitamente', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respCriar = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Perfil Sem Menu Explicito', permissoes: { paradas: 'total' } }),
  });
  const { perfil } = await respCriar.json();

  const respPerfis = await fetch(`${servidor.baseUrl}/perfis`);
  const dataPerfis = await respPerfis.json();
  assert.ok(dataPerfis.paginasPorPerfil[perfil.id].includes('menu'), '"menu" deveria estar sempre presente, mesmo sem ser marcado no catálogo');
});

test('usuário com perfil customizado consegue logar e o boot NÃO manda de volta pro login', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respCriar = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({
      nome: 'Lider de Turno',
      permissoes: { operacao: 'total', paradas: 'total' }, // resto fica 'ocultar' por padrão
    }),
  });
  const { perfil } = await respCriar.json();

  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'lider.turno.boot', senha: 'senhateste1234', perfil: perfil.id }]),
  });

  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'lider.turno.boot', senha: 'senhateste1234' }),
  });
  const dataLogin = await respLogin.json();
  assert.equal(respLogin.status, 200);
  const cookieUsuario = extrairCookie(respLogin);

  const dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        const headers = { ...(opts && opts.headers), Cookie: cookieUsuario };
        return fetch(absoluta, { ...opts, headers });
      };
    },
  });
  const { window } = dom;
  window.sessionStorage.setItem('lw_role', dataLogin.perfil);
  await new Promise(r => setTimeout(r, 2500));

  try {
    // Bug real: o boot antigo dava sessionStorage.clear() + redirecionava
    // pro login.html assim que via um role fora da lista fixa hardcoded —
    // um perfil customizado nunca estaria nessa lista (id gerado).
    assert.equal(window.sessionStorage.getItem('lw_role'), dataLogin.perfil, 'sessão não deveria ter sido limpa — o perfil customizado é válido');

    const paginaAtiva = window.document.querySelector('.main.active');
    assert.equal(paginaAtiva?.id, 'page-menu', 'perfil customizado (não é Operador de Injetora) deveria pousar no Menu Principal');
  } finally {
    window.close();
  }
});

test('abas de Configurações não permitidas ficam realmente escondidas (bug: cfgMostrarSecao sobrescrevia o display:none)', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respCriar = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'So Atalhos Config', permissoes: { 'config-atalhos': 'total' } }),
  });
  const { perfil } = await respCriar.json();

  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'so.atalhos.config', senha: 'senhateste1234', perfil: perfil.id }]),
  });
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'so.atalhos.config', senha: 'senhateste1234' }),
  });
  const dataLogin = await respLogin.json();
  const cookieUsuario = extrairCookie(respLogin);

  const dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        const headers = { ...(opts && opts.headers), Cookie: cookieUsuario };
        return fetch(absoluta, { ...opts, headers });
      };
    },
  });
  const { window } = dom;
  window.sessionStorage.setItem('lw_role', dataLogin.perfil);
  await new Promise(r => setTimeout(r, 2500));

  try {
    window.abrirConfig();
    await new Promise(r => setTimeout(r, 300));
    const document = window.document;

    // Bug real: _cfgAplicarVisibilidadeDeAbas() escondia tudo certinho,
    // mas cfgMostrarSecao() (chamada logo em seguida, dentro do próprio
    // abrirConfig) usava navX.style.cssText = ... pra destacar a aba
    // ativa — isso SUBSTITUI o style inteiro do botão, apagando o
    // display:none que tinha acabado de ser aplicado, reexibindo TODAS
    // as abas pra qualquer perfil não-admin.
    assert.equal(document.getElementById('cfg-nav-dados').style.display, 'none', 'Bateria e Montagem deveria estar escondida');
    assert.equal(document.getElementById('cfg-nav-usuarios').style.display, 'none', 'Usuários deveria estar escondida');
    assert.equal(document.getElementById('cfg-nav-autorizados').style.display, 'none', 'Operação em Andamento deveria estar escondida');
    assert.equal(document.getElementById('cfg-nav-automacao').style.display, 'none', 'Automação deveria estar escondida');
    assert.equal(document.getElementById('cfg-nav-sql').style.display, 'none', 'Dados SQL deveria estar escondida');
    assert.notEqual(document.getElementById('cfg-nav-atalhos').style.display, 'none', 'Atalhos de Teclado é a única liberada — deveria continuar visível');

    // Trocar de aba (cfgMostrarSecao chamada de novo, fora do fluxo de
    // abrirConfig) não pode reabrir as escondidas — mesma causa raiz,
    // testada num segundo ponto de entrada.
    window.cfgMostrarSecao('atalhos');
    await new Promise(r => setTimeout(r, 100));
    assert.equal(document.getElementById('cfg-nav-dados').style.display, 'none', 'trocar de aba não deveria reabrir Bateria e Montagem');
    assert.equal(document.getElementById('cfg-nav-sql').style.display, 'none', 'trocar de aba não deveria reabrir Dados SQL');
  } finally {
    window.close();
  }
});

test('cards do Menu Principal respeitam a visibilidade por perfil customizado', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respCriar = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({
      nome: 'Perfil So Paradas',
      // Só 'paradas' visível — todo o resto (operacao, manutencao,
      // setor-qualidade, etc.) fica 'ocultar' por padrão.
      permissoes: { paradas: 'visualizar' },
    }),
  });
  const { perfil } = await respCriar.json();

  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'so.paradas.boot', senha: 'senhateste1234', perfil: perfil.id }]),
  });
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'so.paradas.boot', senha: 'senhateste1234' }),
  });
  const dataLogin = await respLogin.json();
  const cookieUsuario = extrairCookie(respLogin);

  const dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        const headers = { ...(opts && opts.headers), Cookie: cookieUsuario };
        return fetch(absoluta, { ...opts, headers });
      };
    },
  });
  const { window } = dom;
  window.sessionStorage.setItem('lw_role', dataLogin.perfil);
  await new Promise(r => setTimeout(r, 2500));

  try {
    const document = window.document;
    const cardParadas = document.querySelector('.menu-card[data-page="paradas"]');
    const cardOperacao = document.querySelector('.menu-card[data-page="operacao"]');
    const cardManutencao = document.querySelector('.menu-card[data-page="manutencao"]');

    assert.notEqual(cardParadas.style.display, 'none', 'card de Paradas deveria aparecer — perfil tem esse item visível');
    assert.equal(cardOperacao.style.display, 'none', 'card de Registrar Operação deveria estar oculto — não foi marcado no perfil');
    assert.equal(cardManutencao.style.display, 'none', 'card de Manutenção deveria estar oculto — não foi marcado no perfil');
  } finally {
    window.close();
  }
});
