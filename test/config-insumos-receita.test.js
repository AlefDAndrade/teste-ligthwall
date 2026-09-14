// ─── test/config-insumos-receita.test.js ────────────────────────────────
// Nova aba Configurações → "Insumos de Receitas" (catálogo de insumos —
// Cimento, Água, Superplastificante etc — adicionar/remover, mesmo padrão
// de "Motivos de Parada"/"Tipos de Manutenção", ver public/js/data.js:
// INSUMO_RECEITA_OPTS, e app-core.js: cfgAdicionarInsumo/cfgRemoverInsumo).
//
// Cobre, de ponta a ponta:
//   1. Sem "insumos_receita" no config.json (instalação de antes desta
//      mudança), LW.INSUMO_RECEITA_OPTS cai no fallback dos 5 insumos que
//      sempre existiram como colunas fixas de tracos/ajustes (cimento,
//      água, EPS, superplastificante, incorporador de ar).
//   2. POST /salvar-config com uma lista CUSTOMIZADA de insumos round-tripa
//      corretamente em GET /db/config.json (mesmo teste de fumaça que
//      test/paletes-ordem-round-trip.test.js já faz pra paletesOrdem).
//   3. Uma carga de página NOVA (equivalente a F5) depois de salvar reflete
//      a lista customizada em LW.INSUMO_RECEITA_OPTS.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-insumos-receita-284';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

const INSUMOS_CUSTOM = ['Cimento', 'Água', 'Superplastificante', 'Fibra de Vidro'];

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


test('sem "insumos_receita" no config.json, GET /db/config.json não trava e o front cai no fallback padrão', async () => {
  const resp = await fetch(`${servidor.baseUrl}/db/config.json`, { cache: 'no-store' });
  assert.equal(resp.status, 200);
  const cfg = await resp.json();
  // Instalação nova (seed deste teste) ainda não tem a chave — é
  // exatamente o cenário que dispara o fallback em loadConfig (data.js).
  assert.equal(cfg.insumos_receita, undefined);
});

test('POST /salvar-config com insumos_receita customizado round-tripa corretamente em GET /db/config.json', async () => {
  const respLogin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  const cookieAdmin = extrairCookie(respLogin);
  assert.ok(cookieAdmin, 'login de admin deveria ter funcionado');

  // Mesmo padrão de cfgSalvar() (app-core.js): busca o config.json ATUAL
  // primeiro — /salvar-config substitui o arquivo INTEIRO.
  const respAtual = await fetch(`${servidor.baseUrl}/db/config.json`);
  const cfgAtual = await respAtual.json();

  const respSalvar = await fetch(`${servidor.baseUrl}/salvar-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ ...cfgAtual, insumos_receita: { opcoes: INSUMOS_CUSTOM } }),
  });
  assert.equal(respSalvar.status, 200);

  const respDepois = await fetch(`${servidor.baseUrl}/db/config.json`, { cache: 'no-store' });
  const cfgDepois = await respDepois.json();
  assert.deepEqual(cfgDepois.insumos_receita, { opcoes: INSUMOS_CUSTOM });
});

test('uma carga de página NOVA (equivalente a F5) aplica a lista de insumos customizada em LW.INSUMO_RECEITA_OPTS, com Padrão/Custom corretos', async () => {
  // A esta altura, config.json já tem INSUMOS_CUSTOM salvo (teste anterior)
  // — abrir a página do zero é exatamente o que um F5 de verdade faz:
  // reexecuta loadConfig() do zero, sem nenhum estado herdado.
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
  const window = dom.window;
  try {
    window.sessionStorage.setItem('lw_role', 'Administrador');
    window.localStorage.setItem('lw_admin_authenticated', 'true');
    await new Promise(r => setTimeout(r, 2500));

    // Formato normalizado (Fase 4, ver PLANO-insumos-dinamicos-receitas.md):
    // Padrão sempre primeiro (ordem canônica, mesmo sem estarem listados
    // de novo no config.json salvo — 3 dos 4 nomes salvos eram Padrão,
    // "Fibra de Vidro" é o único Custom de verdade), Custom depois.
    assert.deepEqual(JSON.parse(JSON.stringify(window.LW.INSUMO_RECEITA_OPTS)), [
      { nome: 'Cimento', categoria: 'padrao' },
      { nome: 'Água', categoria: 'padrao' },
      { nome: 'EPS', categoria: 'padrao' },
      { nome: 'Superplastificante', categoria: 'padrao' },
      { nome: 'Incorporador de Ar', categoria: 'padrao' },
      { nome: 'Fibra de Vidro', categoria: 'custom' },
    ]);
  } finally {
    window.close();
  }
});

test('fallback (sem config.json customizado): os 5 Padrão vêm com categoria "padrao", nenhum Custom', async () => {
  const servidorLimpo = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
  try {
    const dom = await JSDOM.fromURL(`${servidorLimpo.baseUrl}/index.html`, {
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
    const window = dom.window;
    try {
      await new Promise(r => setTimeout(r, 2500));
      const opcoes = JSON.parse(JSON.stringify(window.LW.INSUMO_RECEITA_OPTS));
      assert.deepEqual(opcoes, [
        { nome: 'Cimento', categoria: 'padrao' },
        { nome: 'Água', categoria: 'padrao' },
        { nome: 'EPS', categoria: 'padrao' },
        { nome: 'Superplastificante', categoria: 'padrao' },
        { nome: 'Incorporador de Ar', categoria: 'padrao' },
      ]);
      assert.deepEqual(JSON.parse(JSON.stringify(window.LW.NOMES_INSUMOS_PADRAO)), ['Cimento', 'Água', 'EPS', 'Superplastificante', 'Incorporador de Ar']);
    } finally {
      window.close();
    }
  } finally {
    await servidorLimpo.parar();
  }
});

test('UI (Configurações → Insumos de Receitas): Padrão sem botão de remover + badge; Custom pode ser adicionado e removido', async () => {
  // Servidor ISOLADO (não o `servidor` compartilhado do resto do arquivo,
  // que a esta altura já tem "Fibra de Vidro" salva pelos testes
  // anteriores) — precisa de estado limpo pra contar botões com precisão.
  const servidorLimpo = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
  const cookieAdmin = (await fetch(`${servidorLimpo.baseUrl}/verificar-senha`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  })).headers.get('set-cookie').split(';')[0];

  const dom = await JSDOM.fromURL(`${servidorLimpo.baseUrl}/index.html`, {
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

  const { window } = dom;
  const document = window.document;
  try {
    window.abrirConfig();
    await new Promise(r => setTimeout(r, 200));
    window.cfgMostrarSecao('insumos');
    await new Promise(r => setTimeout(r, 200));

    const lista = document.getElementById('cfg-insumos-lista');
    // Os 5 Padrão aparecem com o badge "Padrão", sem botão de remover.
    assert.ok(lista.innerHTML.includes('Padrão'), 'badge "Padrão" deveria aparecer na lista');
    assert.equal((lista.innerHTML.match(/cfgRemoverInsumo/g) || []).length, 0, 'nenhum Padrão deveria ter botão de remover ainda (nenhum Custom cadastrado)');

    // Adiciona um Custom.
    document.getElementById('cfg-insumo-novo').value = 'Fibra de Teste';
    window.cfgAdicionarInsumo();
    await new Promise(r => setTimeout(r, 100));

    assert.ok(lista.innerHTML.includes('Fibra de Teste'), 'Custom recém-adicionado deveria aparecer na lista');
    assert.equal((lista.innerHTML.match(/cfgRemoverInsumo/g) || []).length, 1, 'só o Custom deveria ter botão de remover');

    // cfgRemoverInsumo num índice de Padrão (0 = Cimento, sempre o
    // primeiro da lista normalizada) não deve remover nada — defesa
    // mesmo sem o botão estar visível pra ele.
    window.LW.mostrarConfirmacao = async () => true; // auto-confirma, se chegar a perguntar
    await window.cfgRemoverInsumo(0);
    await new Promise(r => setTimeout(r, 100));
    assert.ok(lista.innerHTML.includes('Cimento'), 'Padrão não deveria ter sido removido');

    // Remove o Custom de verdade (índice 5 = depois dos 5 Padrão).
    await window.cfgRemoverInsumo(5);
    await new Promise(r => setTimeout(r, 100));
    assert.ok(!lista.innerHTML.includes('Fibra de Teste'), 'Custom deveria ter sido removido');
  } finally {
    window.close();
    await servidorLimpo.parar();
  }
});
