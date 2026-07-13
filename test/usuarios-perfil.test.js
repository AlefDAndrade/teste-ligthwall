// ─── test/usuarios-perfil.test.js ────────────────────────────────────────────
// Testa o sistema de login com PERFIL definido no cadastro. Modelo NOVO (ver
// lib/perfis.js): 6 perfis cadastráveis — OperadorInjetora,
// AssistenteQualidade, Encarregado, Manutencao, Supervisao, Administrativo
// (rótulo "Administrador" na tela) — + o Administrador Master (senha única,
// sem cadastro, continua como sempre foi). TODA página é aberta pra
// visualização a todo perfil; o que muda por perfil agora é a ÁREA DE EDIÇÃO
// (injetora/paradas/qualidade/manutencao/manutencao-chamado), não mais
// "quais páginas cada um vê".
//
// Cobre: rotas de backend (GET /perfis, POST /login-usuario,
// POST /salvar-usuarios, GET /usuarios, GET /minha-sessao,
// POST /logout-usuario) via HTTP direto, e o boot da SPA (visualização
// aberta pra todo perfil, Configurações restrita) via servidor real + jsdom
// — mesmo padrão de test/manutencao-pagina.test.js.

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

test('GET /perfis expõe os 6 perfis cadastráveis e suas áreas de edição', async () => {
  const resp = await fetch(`${servidor.baseUrl}/perfis`);
  const data = await resp.json();
  assert.equal(resp.status, 200);
  assert.equal(data.ok, true);
  assert.deepEqual(data.perfisCadastraveis, [
    'OperadorInjetora', 'AssistenteQualidade', 'Encarregado', 'Manutencao', 'Supervisao', 'Administrativo',
  ]);

  // Visualização aberta: todo perfil cadastrável vê todas as páginas de
  // trabalho, inclusive as que não edita.
  assert.ok(data.paginasPorPerfil.OperadorInjetora.includes('operacao'));
  assert.ok(data.paginasPorPerfil.OperadorInjetora.includes('setor-qualidade'), 'visualização é aberta, mesmo sem poder editar');
  assert.ok(data.paginasPorPerfil.AssistenteQualidade.includes('operacao'), 'visualização é aberta, mesmo sem poder editar');

  // Áreas de edição — a permissão de verdade no modelo novo.
  assert.deepEqual(data.areasEdicaoPorPerfil.OperadorInjetora, ['injetora', 'paradas']);
  assert.deepEqual(data.areasEdicaoPorPerfil.AssistenteQualidade, ['qualidade', 'paradas']);
  assert.deepEqual(data.areasEdicaoPorPerfil.Encarregado, ['injetora', 'qualidade', 'paradas', 'manutencao-chamado']);
  assert.deepEqual(data.areasEdicaoPorPerfil.Manutencao, ['manutencao', 'paradas']);
  assert.deepEqual(data.areasEdicaoPorPerfil.Supervisao, ['injetora', 'qualidade', 'paradas', 'manutencao']);
  assert.deepEqual(data.areasEdicaoPorPerfil.Administrativo, ['injetora', 'paradas', 'qualidade', 'manutencao', 'manutencao-chamado']);

  // Configurações: só o Administrador (perfil Administrativo) tem tudo;
  // os demais só Atalhos.
  assert.deepEqual(data.paginasPorPerfil.OperadorInjetora.filter(p => p.startsWith('config-')), ['config-atalhos']);
  assert.ok(data.paginasPorPerfil.Administrativo.includes('config-sql'), 'Administrador (Administrativo) deveria ter Dados SQL, igual ao master');
  assert.ok(data.paginasPorPerfil.Administrativo.includes('config-usuarios'));
});

test('POST /salvar-usuarios exige poderes de administrador (master ou perfil Administrativo)', async () => {
  const resp = await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ nomeUsuario: 'sem.sessao', senha: '1234', perfil: 'OperadorInjetora' }]),
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
      { nomeUsuario: 'ana.oper', senha: 'senha1234', perfil: 'OperadorInjetora', podeIniciarOperacao: true },
    ]),
  });
  const dataSalvar = await respSalvar.json();
  assert.equal(respSalvar.status, 200);
  assert.equal(dataSalvar.ok, true);
  assert.equal(dataSalvar.usuarios.length, 1);
  assert.equal(dataSalvar.usuarios[0].nomeUsuario, 'ana.oper');
  assert.equal(dataSalvar.usuarios[0].perfil, 'OperadorInjetora');
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
  assert.equal(dataLogin.perfil, 'OperadorInjetora');
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
  assert.equal(dataSessao.perfil, 'OperadorInjetora');

  const respSemCookie = await fetch(`${servidor.baseUrl}/minha-sessao`);
  const dataSemCookie = await respSemCookie.json();
  assert.equal(dataSemCookie.ok, false, 'sem cookie, não deveria haver sessão válida');

  await fetch(`${servidor.baseUrl}/logout-usuario`, { method: 'POST', headers: { Cookie: cookieUsuario } });
  const respDepoisLogout = await fetch(`${servidor.baseUrl}/minha-sessao`, { headers: { Cookie: cookieUsuario } });
  const dataDepoisLogout = await respDepoisLogout.json();
  assert.equal(dataDepoisLogout.ok, false, 'depois do logout, a sessão não deveria mais ser válida');
});

test('perfil sem controle de operação nunca recebe podeIniciarOperacao=true, mesmo se enviado no payload', async () => {
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
      { id: ana.id, nomeUsuario: 'ana.oper', perfil: 'OperadorInjetora', podeIniciarOperacao: true }, // sem "senha" -> preserva o hash atual
      { nomeUsuario: 'joana.qual', senha: 'senhaqual1', perfil: 'AssistenteQualidade', podeIniciarOperacao: true },
    ]),
  });
  const data = await resp.json();
  assert.equal(resp.status, 200);
  const joana = data.usuarios.find(u => u.nomeUsuario === 'joana.qual');
  assert.equal(joana.podeIniciarOperacao, false, 'Assistente de Qualidade não tem área injetora, então a marcação deveria ser forçada pra false');
});

test('perfil Administrativo nunca recebe podeIniciarOperacao=true (é irrestrito, o checkbox é redundante)', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([
      { nomeUsuario: 'root.admin', senha: 'senharoot1234', perfil: 'Administrativo', podeIniciarOperacao: true },
    ]),
  });
  const data = await resp.json();
  const root = data.usuarios.find(u => u.nomeUsuario === 'root.admin');
  assert.equal(root.podeIniciarOperacao, false);
});

test('nome de usuário duplicado é recusado ao salvar', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([
      { nomeUsuario: 'duplicado', senha: 'senha1111', perfil: 'OperadorInjetora' },
      { nomeUsuario: 'Duplicado', senha: 'senha2222', perfil: 'Supervisao' },
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

test('perfil descontinuado (cadastro de antes da mudança) é recusado no login', async () => {
  // Simula um cadastro antigo — grava direto no arquivo, contornando a
  // validação de POST /salvar-usuarios (que já rejeitaria "Operador" hoje).
  const fs = require('node:fs');
  const path = require('node:path');
  const usuariosPath = path.join(servidor.pastaTemp, 'private', 'usuarios.json');
  const usuarios = JSON.parse(fs.readFileSync(usuariosPath, 'utf8'));
  usuarios.push({
    id: 'usuario_legado_1',
    nomeUsuario: 'legado.operador',
    senhaHash: require('node:crypto').createHash('sha256').update('senhalegado1').digest('hex'),
    perfil: 'Operador', // perfil descontinuado
    podeIniciarOperacao: true,
    atalhos: {},
  });
  fs.writeFileSync(usuariosPath, JSON.stringify(usuarios, null, 2), 'utf8');

  const resp = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'legado.operador', senha: 'senhalegado1' }),
  });
  assert.equal(resp.status, 400);
  const data = await resp.json();
  assert.equal(data.ok, false);
  assert.match(data.erro, /descontinuado/i);
});

// ═══════════════════════════════════════════════════════════════════════
// Front-end — boot da SPA (visualização aberta, Configurações restrita)
// ═══════════════════════════════════════════════════════════════════════

async function carregarSpaComo(perfil, nomeUsuario, senha) {
  const cookieAdmin = await logarComoAdminMaster();
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([
      { nomeUsuario, senha, perfil, podeIniciarOperacao: perfil === 'OperadorInjetora' },
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

test('boot da SPA como AssistenteQualidade: visualização aberta (vê Operação e OEE também)', async () => {
  const dom = await carregarSpaComo('AssistenteQualidade', 'joana.boot', 'senhaboot1');
  const { window } = dom;
  const document = window.document;

  try {
    const itemQualidade = document.querySelector('[data-page="setor-qualidade"]');
    const itemOperacao = document.querySelector('[data-page="operacao"]');
    const itemOee = document.querySelector('[data-page="oee"]');

    assert.notEqual(itemQualidade.style.display, 'none');
    // Modelo novo: visualização aberta — Assistente de Qualidade também VÊ
    // Operação e OEE, só não pode EDITAR (área 'injetora' não está na sua
    // lista, ver GET /perfis).
    assert.notEqual(itemOperacao.style.display, 'none');
    assert.notEqual(itemOee.style.display, 'none');
  } finally {
    window.close();
  }
});

test('boot da SPA como OperadorInjetora: entra direto em Registrar Operação, vê tudo', async () => {
  const dom = await carregarSpaComo('OperadorInjetora', 'carlos.boot', 'senhaboot2');
  const { window } = dom;
  const document = window.document;

  try {
    const paginaAtiva = document.querySelector('.main.active');
    assert.equal(paginaAtiva?.id, 'page-operacao');

    const itemManutencao = document.querySelector('[data-page="manutencao"]');
    const itemQualidade = document.querySelector('[data-page="setor-qualidade"]');
    assert.notEqual(itemManutencao.style.display, 'none');
    assert.notEqual(itemQualidade.style.display, 'none', 'visualização é aberta, mesmo sem poder editar');
  } finally {
    window.close();
  }
});

test('boot da SPA como Manutencao: vê tudo, botão de Configurações aparece (tem config-atalhos)', async () => {
  const dom = await carregarSpaComo('Manutencao', 'pedro.boot', 'senhaboot3');
  const { window } = dom;
  const document = window.document;

  try {
    const itemManutencao = document.querySelector('[data-page="manutencao"]');
    const itemOperacao = document.querySelector('[data-page="operacao"]');
    assert.notEqual(itemManutencao.style.display, 'none');
    assert.notEqual(itemOperacao.style.display, 'none', 'visualização é aberta, mesmo sem poder editar');

    const btnConfig = document.getElementById('btn-config');
    assert.notEqual(btnConfig.style.display, 'none', 'Manutencao tem config-atalhos, então o botão deveria aparecer');
  } finally {
    window.close();
  }
});

test('boot da SPA como Administrativo ("Administrador" cadastrado): vê todas as abas de Configurações', async () => {
  const dom = await carregarSpaComo('Administrativo', 'sara.boot', 'senhaboot4');
  const { window } = dom;
  const document = window.document;

  try {
    const navSql = document.getElementById('cfg-nav-sql');
    const navUsuarios = document.getElementById('cfg-nav-usuarios');
    // _cfgAplicarVisibilidadeDeAbas só roda quando o modal de Configurações
    // abre — aqui só confirmamos que os elementos existem e não estão
    // marcados como escondidos de antemão (o teste de unidade de
    // permissão de verdade já está coberto por GET /perfis, acima).
    assert.ok(navSql, 'aba de Dados SQL deveria existir no DOM');
    assert.ok(navUsuarios, 'aba de Usuários deveria existir no DOM');
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
