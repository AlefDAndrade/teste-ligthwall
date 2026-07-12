// ─── test/usuarios-perfil.test.js ────────────────────────────────────────────
// Testa o sistema de login novo (Fase A — ver conversa que motivou isso):
// usuário+senha com PERFIL definido no cadastro (não mais "escolha seu
// papel" sem senha). 6 perfis: Operador, Analista, Qualidade, Manutencao,
// Administrativo (cadastráveis — ver lib/perfis.js) e Administrador
// (senha mestra única, sem cadastro, continua como sempre foi).
//
// Cobre: rotas de backend (GET /perfis, POST /login-usuario,
// POST /salvar-usuarios, GET /usuarios, GET /minha-sessao,
// POST /logout-usuario) via HTTP direto, e o boot da SPA (menu ajustado
// por perfil) via servidor real + jsdom — mesmo padrão de
// test/manutencao-pagina.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-teste-usuarios-456';
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

// ═══════════════════════════════════════════════════════════════════════
// Backend — rotas puras via HTTP
// ═══════════════════════════════════════════════════════════════════════

test('GET /perfis expõe os 5 perfis cadastráveis e suas páginas', async () => {
  const resp = await fetch(`${servidor.baseUrl}/perfis`);
  const data = await resp.json();
  assert.equal(resp.status, 200);
  assert.equal(data.ok, true);
  assert.deepEqual(data.perfisCadastraveis, ['Operador', 'Analista', 'Qualidade', 'Manutencao', 'Administrativo']);
  assert.ok(data.paginasPorPerfil.Operador.includes('operacao'));
  assert.ok(data.paginasPorPerfil.Operador.includes('manutencao'));
  assert.ok(!data.paginasPorPerfil.Analista.includes('operacao'), 'Analista não deveria ter acesso a Registrar Operação');
  assert.deepEqual(data.paginasPorPerfil.Qualidade, ['setor-qualidade', 'config-atalhos']);
  assert.deepEqual(data.paginasPorPerfil.Manutencao, ['manutencao', 'config-atalhos']);
  assert.ok(data.paginasPorPerfil.Administrativo.includes('setor-qualidade'));
  assert.ok(!data.paginasPorPerfil.Administrativo.includes('config-sql'), 'Administrativo não deveria ter Dados SQL');
});

test('POST /salvar-usuarios exige sessão de Administrador Master', async () => {
  const resp = await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ nomeUsuario: 'sem.sessao', senha: '1234', perfil: 'Operador' }]),
  });
  assert.equal(resp.status, 403);
  const data = await resp.json();
  assert.equal(data.ok, false);
});

test('cadastrar um usuário novo, listar, e fazer login com sucesso', async () => {
  const cookieAdmin = await logarComoAdminMaster();

  const respSalvar = await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([
      { nomeUsuario: 'ana.oper', senha: 'senha1234', perfil: 'Operador', podeIniciarOperacao: true },
    ]),
  });
  const dataSalvar = await respSalvar.json();
  assert.equal(respSalvar.status, 200);
  assert.equal(dataSalvar.ok, true);
  assert.equal(dataSalvar.usuarios.length, 1);
  assert.equal(dataSalvar.usuarios[0].nomeUsuario, 'ana.oper');
  assert.equal(dataSalvar.usuarios[0].perfil, 'Operador');
  assert.equal(dataSalvar.usuarios[0].podeIniciarOperacao, true);

  const respLista = await fetch(`${servidor.baseUrl}/usuarios`);
  const dataLista = await respLista.json();
  assert.equal(dataLista.usuarios.length, 1);
  assert.equal(dataLista.usuarios[0].nomeUsuario, 'ana.oper');
  assert.ok(!('senhaHash' in dataLista.usuarios[0]), 'GET /usuarios nunca deveria expor o hash da senha');

  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'ana.oper', senha: 'senha1234' }),
  });
  const dataLogin = await respLogin.json();
  assert.equal(respLogin.status, 200);
  assert.equal(dataLogin.ok, true);
  assert.equal(dataLogin.perfil, 'Operador');
  assert.equal(dataLogin.podeIniciarOperacao, true);
  assert.ok(extrairCookie(respLogin), 'login deveria emitir um cookie de sessão de usuário');
});

test('login recusa senha errada, sem revelar se o usuário existe', async () => {
  const resp = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'ana.oper', senha: 'senha-errada' }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);
  assert.match(data.erro, /incorretos/i);
});

test('login é case-insensitive no nome de usuário', async () => {
  const resp = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'ANA.OPER', senha: 'senha1234' }),
  });
  assert.equal(resp.status, 200);
  const data = await resp.json();
  assert.equal(data.ok, true);
  assert.equal(data.nomeUsuario, 'ana.oper', 'devolve a grafia original do cadastro, não a digitada');
});

test('GET /minha-sessao confirma a sessão de usuário real e POST /logout-usuario a destrói', async () => {
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'ana.oper', senha: 'senha1234' }),
  });
  const cookieUsuario = extrairCookie(respLogin);

  const respSessao = await fetch(`${servidor.baseUrl}/minha-sessao`, { headers: { Cookie: cookieUsuario } });
  const dataSessao = await respSessao.json();
  assert.equal(dataSessao.ok, true);
  assert.equal(dataSessao.perfil, 'Operador');

  const respSemCookie = await fetch(`${servidor.baseUrl}/minha-sessao`);
  const dataSemCookie = await respSemCookie.json();
  assert.equal(dataSemCookie.ok, false, 'sem cookie, não deveria haver sessão válida');

  await fetch(`${servidor.baseUrl}/logout-usuario`, { method: 'POST', headers: { Cookie: cookieUsuario } });
  const respDepoisLogout = await fetch(`${servidor.baseUrl}/minha-sessao`, { headers: { Cookie: cookieUsuario } });
  const dataDepoisLogout = await respDepoisLogout.json();
  assert.equal(dataDepoisLogout.ok, false, 'depois do logout, a sessão não deveria mais ser válida');
});

test('perfil sem página "operacao" liberada nunca recebe podeIniciarOperacao=true, mesmo se enviado no payload', async () => {
  const cookieAdmin = await logarComoAdminMaster();

  // Busca o id real de "ana.oper" (já cadastrada num teste anterior) —
  // sem mandar o id, o servidor trataria como usuário NOVO, que exige
  // senha obrigatória (ver POST /salvar-usuarios) — não é isso que este
  // teste quer verificar.
  const respLista = await fetch(`${servidor.baseUrl}/usuarios`);
  const { usuarios: existentes } = await respLista.json();
  const ana = existentes.find(u => u.nomeUsuario === 'ana.oper');

  const resp = await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([
      { id: ana.id, nomeUsuario: 'ana.oper', perfil: 'Operador', podeIniciarOperacao: true }, // sem "senha" -> preserva o hash atual
      { nomeUsuario: 'joana.qual', senha: 'senhaqual1', perfil: 'Qualidade', podeIniciarOperacao: true },
    ]),
  });
  const data = await resp.json();
  assert.equal(resp.status, 200);
  const joana = data.usuarios.find(u => u.nomeUsuario === 'joana.qual');
  assert.equal(joana.podeIniciarOperacao, false, 'Qualidade não tem a página operacao, então a marcação deveria ser forçada pra false');
});

test('nome de usuário duplicado é recusado ao salvar', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([
      { nomeUsuario: 'duplicado', senha: 'senha1111', perfil: 'Operador' },
      { nomeUsuario: 'Duplicado', senha: 'senha2222', perfil: 'Analista' },
    ]),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);
  assert.match(data.erro, /duplicado/i);
});

test('perfil inválido é recusado ao salvar', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'fulano', senha: 'senha1234', perfil: 'AdminMaster' }]),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);
  assert.match(data.erro, /perfil/i);
});

// ═══════════════════════════════════════════════════════════════════════
// Front-end — boot da SPA respeitando o perfil (servidor real + jsdom)
// ═══════════════════════════════════════════════════════════════════════

async function carregarSpaComo(perfil, nomeUsuario, senha) {
  const cookieAdmin = await logarComoAdminMaster();
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([
      { nomeUsuario, senha, perfil, podeIniciarOperacao: perfil === 'Operador' },
    ]),
  }).catch(() => {});

  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario, senha }),
  });
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
  dom.window.sessionStorage.setItem('lw_role', perfil);
  await new Promise(r => setTimeout(r, 2500));
  return dom;
}

test('boot da SPA como Qualidade: só vê Setor de Qualidade, esconde Operação/OEE', async () => {
  const dom = await carregarSpaComo('Qualidade', 'joana.boot', 'senhaboot1');
  const { window } = dom;
  const document = window.document;

  try {
    const itemQualidade = document.querySelector('[data-page="setor-qualidade"]');
    const itemOperacao = document.querySelector('[data-page="operacao"]');
    const itemOee = document.querySelector('[data-page="oee"]');

    assert.notEqual(itemQualidade.style.display, 'none');
    assert.equal(itemOperacao.style.display, 'none');
    assert.equal(itemOee.style.display, 'none');
  } finally {
    window.close();
  }
});

test('boot da SPA como Operador: entra direto em Registrar Operação, vê Manutenção', async () => {
  const dom = await carregarSpaComo('Operador', 'carlos.boot', 'senhaboot2');
  const { window } = dom;
  const document = window.document;

  try {
    const paginaAtiva = document.querySelector('.main.active');
    assert.equal(paginaAtiva?.id, 'page-operacao');

    const itemManutencao = document.querySelector('[data-page="manutencao"]');
    const itemQualidade = document.querySelector('[data-page="setor-qualidade"]');
    assert.notEqual(itemManutencao.style.display, 'none');
    assert.equal(itemQualidade.style.display, 'none');
  } finally {
    window.close();
  }
});

test('boot da SPA como Manutencao: só vê Manutenção, botão de Configurações aparece (tem config-atalhos)', async () => {
  const dom = await carregarSpaComo('Manutencao', 'pedro.boot', 'senhaboot3');
  const { window } = dom;
  const document = window.document;

  try {
    const itemManutencao = document.querySelector('[data-page="manutencao"]');
    const itemOperacao = document.querySelector('[data-page="operacao"]');
    assert.notEqual(itemManutencao.style.display, 'none');
    assert.equal(itemOperacao.style.display, 'none');

    const btnConfig = document.getElementById('btn-config');
    assert.notEqual(btnConfig.style.display, 'none', 'Manutencao tem config-atalhos, então o botão deveria aparecer');
  } finally {
    window.close();
  }
});

test('sessionStorage.lw_role adulterado sem sessão real no servidor é rejeitado no boot (volta pro login)', async () => {
  const dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        return fetch(absoluta, opts);
      };
    },
  });
  const { window } = dom;
  window.sessionStorage.setItem('lw_role', 'Administrativo');

  await new Promise(r => setTimeout(r, 2500));

  try {
    assert.equal(window.sessionStorage.getItem('lw_role'), null, 'sessão inválida deveria ter limpado o sessionStorage');
  } finally {
    window.close();
  }
});
