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

test('uma carga de página NOVA (equivalente a F5) aplica a lista de insumos customizada em LW.INSUMO_RECEITA_OPTS', async () => {
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

    assert.deepEqual(window.LW.INSUMO_RECEITA_OPTS, INSUMOS_CUSTOM);
  } finally {
    window.close();
  }
});
