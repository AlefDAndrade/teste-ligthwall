// ─── test/configuracoes-checkbox-pode-iniciar.test.js ───────────────────────
// Regressão de um bug real relatado pelo usuário: em Configurações → Usuários
// → "Adicionar Usuário", o checkbox "Pode iniciar/encerrar operações" (ver
// #cfg-usuario-pode-iniciar-wrap, modal-config.html) só aparecia DEPOIS de
// cadastrar um usuário — nunca no primeiro carregamento da tela.
//
// Causa raiz (ver cfgRenderUsuarios, app-core.js): a função que decide se o
// checkbox aparece (cfgAtualizarCampoPodeIniciarOperacao, que lê
// document.getElementById('cfg-usuario-perfil').value) rodava ANTES de
// _cfgPopularSelectPerfil() preencher o <select> com as <option>. Nesse
// momento o <select> ainda estava vazio, então .value vinha '' e a checagem
// `perfisComControleDeOperacao.includes('')` sempre dava falso — o checkbox
// ficava escondido até o usuário trocar manualmente o <select> (dispara
// onchange) ou até a tela ser re-renderizada depois de cadastrar alguém
// (quando o <select> já estava populado de antes).
//
// Fix: popular o <select> primeiro, só depois decidir a visibilidade do
// checkbox com base no valor já selecionado.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-teste-checkbox-pode-iniciar-741';
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

async function abrirSpaComoAdminMaster() {
  const cookieAdmin = await logarComoAdminMaster();
  const dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        const headers = { ...(opts && opts.headers), Cookie: cookieAdmin };
        return fetch(absoluta, { ...opts, headers });
      };
    },
  });
  dom.window.sessionStorage.setItem('lw_role', 'Administrador');
  await new Promise(r => setTimeout(r, 2500));
  return dom;
}

test('checkbox "Pode iniciar/encerrar operações" já aparece no PRIMEIRO carregamento da aba Usuários (bug: só aparecia depois de cadastrar alguém)', async () => {
  const dom = await abrirSpaComoAdminMaster();
  const { window } = dom;
  const document = window.document;

  try {
    window.abrirConfig();
    await new Promise(r => setTimeout(r, 200));

    // Primeira vez entrando na aba "Usuários" — o <select> de Perfil ainda
    // não tinha sido tocado por ninguém até aqui.
    window.cfgMostrarSecao('usuarios');
    await new Promise(r => setTimeout(r, 400));

    const selectPerfil = document.getElementById('cfg-usuario-perfil');
    const wrap = document.getElementById('cfg-usuario-pode-iniciar-wrap');

    assert.ok(selectPerfil.options.length > 0, 'o <select> de Perfil já deveria estar populado');
    // O primeiro perfil cadastrável (lib/perfis.js, PERFIS_CADASTRAVEIS) é
    // "OperadorInjetora", que TEM controle de operação — então, com o bug
    // corrigido, o checkbox já deveria estar visível sem precisar trocar o
    // <select> manualmente.
    assert.equal(selectPerfil.value, 'OperadorInjetora', 'perfil selecionado por padrão deveria ser o primeiro cadastrável');
    assert.notEqual(wrap.style.display, 'none', 'checkbox deveria já aparecer no primeiro carregamento, sem precisar cadastrar ninguém antes');
  } finally {
    window.close();
  }
});

test('checkbox continua reagindo à troca manual do <select> de Perfil (some pra perfil sem controle de operação, ex: Administrador)', async () => {
  const dom = await abrirSpaComoAdminMaster();
  const { window } = dom;
  const document = window.document;

  try {
    window.abrirConfig();
    await new Promise(r => setTimeout(r, 200));
    window.cfgMostrarSecao('usuarios');
    await new Promise(r => setTimeout(r, 400));

    const selectPerfil = document.getElementById('cfg-usuario-perfil');
    const wrap = document.getElementById('cfg-usuario-pode-iniciar-wrap');

    selectPerfil.value = 'Administrativo'; // perfil "Administrador" — sempre irrestrito, checkbox não faz sentido
    selectPerfil.dispatchEvent(new window.Event('change'));
    await new Promise(r => setTimeout(r, 200));

    assert.equal(wrap.style.display, 'none', 'perfil Administrador não tem controle de operação — checkbox deveria sumir');

    selectPerfil.value = 'OperadorInjetora';
    selectPerfil.dispatchEvent(new window.Event('change'));
    await new Promise(r => setTimeout(r, 200));

    assert.notEqual(wrap.style.display, 'none', 'voltando pra Operador de Injetora, checkbox deveria reaparecer');
  } finally {
    window.close();
  }
});

// (O fluxo de salvar de fato — POST /salvar-usuarios com
// podeIniciarOperacao — já é coberto ponta a ponta por
// test/usuarios-perfil.test.js; aqui o foco é só a VISIBILIDADE do
// checkbox, que é onde o bug relatado estava.)
