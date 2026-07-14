// ─── test/manutencao-fechar-chamado.test.js ─────────────────────────────────
// Regressão de um bug real: o botão "Fechar Chamado" (man-btnFecharEtiqueta)
// já era escondido corretamente pra perfis sem a área 'manutencao' completa
// (ver data-manut-area="manutencao", lib/perfis.js) em dois pontos — ao
// carregar um chamado existente (editarManutencao) e ao resetar o
// formulário — mas a função aoMudarSituacao() (disparada quando o campo
// "Situação" muda pra "Concluído") REEXIBIA o botão sem checar permissão
// nenhuma. Resultado: um Encarregado (só tem 'manutencao-chamado', não
// 'manutencao' completa — não pode FECHAR chamados, só abrir) via o botão
// reaparecer ao marcar Situação como Concluído, clicava, e só descobria que
// não tinha permissão depois de tomar um erro do servidor.
//
// Cobre: aoMudarSituacao() não reexibe o botão pra quem não pode fechar
// (Encarregado), mas continua reexibindo normalmente pra quem pode
// (Manutencao) — e a segunda camada de proteção em abrirModalFechamento()
// bloqueia a abertura do modal mesmo se o botão for acionado de outro jeito.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-fechar-chamado-963';
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

async function carregarSpaComo(nomeUsuario, perfil) {
  const cookieAdmin = await logarComoAdminMaster();
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario, senha: 'senhateste1234', perfil }]),
  });
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario, senha: 'senhateste1234' }),
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

test('Encarregado (sem área manutencao completa): botão Fechar Chamado NÃO reaparece ao marcar Situação como Concluído', async () => {
  const dom = await carregarSpaComo('encarregado.fechar.teste', 'Encarregado');
  const { window } = dom;

  try {
    window.showPage('manutencao');
    await new Promise(r => setTimeout(r, 200));
    window.novoChamado();
    await new Promise(r => setTimeout(r, 100));

    const situacaoSelect = window.document.getElementById('man-manSituacao');
    situacaoSelect.value = 'Concluido';
    window.aoMudarSituacao();

    const btn = window.document.getElementById('man-btnFecharEtiqueta');
    assert.equal(btn.style.display, 'none', 'botão Fechar Chamado não deveria reaparecer pra Encarregado, mesmo com Situação=Concluído');

    // Segunda camada: mesmo chamando abrirModalFechamento() diretamente
    // (simula alguém forçando o clique de outro jeito), o modal não abre.
    window.abrirModalFechamento();
    assert.equal(window.document.getElementById('man-modalFechamento').style.display, 'none', 'modal de fechamento não deveria abrir pra quem não tem permissão');
  } finally {
    window.close();
  }
});

test('Manutencao (com área manutencao completa): botão Fechar Chamado aparece normalmente ao marcar Situação como Concluído', async () => {
  const dom = await carregarSpaComo('manutencao.fechar.teste', 'Manutencao');
  const { window } = dom;

  try {
    window.showPage('manutencao');
    await new Promise(r => setTimeout(r, 200));
    window.novoChamado();
    await new Promise(r => setTimeout(r, 100));

    const situacaoSelect = window.document.getElementById('man-manSituacao');
    situacaoSelect.value = 'Concluido';
    window.aoMudarSituacao();

    const btn = window.document.getElementById('man-btnFecharEtiqueta');
    assert.equal(btn.style.display, 'inline-block', 'botão Fechar Chamado deveria aparecer normalmente pra quem tem a área manutencao completa');

    // A segunda camada de proteção não deveria bloquear quem TEM permissão.
    assert.equal(window.eval("_perfilPodeEditar('manutencao')"), true);
  } finally {
    window.close();
  }
});
