// ─── test/insumos-fixos.test.js ─────────────────────────────────────────────
// Toggle "Fixo" em Configurações → Insumos de Receitas.
//   1. Config: todo insumo tem o toggle; Padrão vem ligado e travado;
//      Custom liga/desliga (cfgToggleInsumoFixo) e o estado é salvo.
//   2. Registrar Operação: Custom fixo aparece DIRETO no traço novo (sem "+"),
//      é obrigatório e não tem "✕"; Custom não fixo continua só no "+".
//   3. Config antigo (Custom sem a chave `fixo`) = não fixo.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-insumos-fixos-518';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor, dom, window, document;
const espera = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
  const respLogin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  const cookieAdmin = respLogin.headers.get('set-cookie').split(';')[0];
  const cfgAtual = await (await fetch(`${servidor.baseUrl}/db/config.json`)).json();
  await fetch(`${servidor.baseUrl}/salvar-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({
      ...cfgAtual,
      insumos_receita: { opcoes: [
        { nome: 'Fibra', categoria: 'custom', fixo: true },
        { nome: 'Cerragem', categoria: 'custom', fixo: false },
        { nome: 'Antigo', categoria: 'custom' }, // config antigo, sem `fixo`
      ] },
    }),
  });

  dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => fetch(new URL(url, win.location.href).toString(), opts);
    },
  });
  window = dom.window;
  document = window.document;
  window.sessionStorage.setItem('lw_role', 'Administrador');
  window.localStorage.setItem('lw_admin_authenticated', 'true');
  await espera(2500);
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

test('catálogo normalizado: Padrão fixo, Custom só é fixo se marcado (config antigo = não fixo)', () => {
  const opts = JSON.parse(JSON.stringify(window.LW.INSUMO_RECEITA_OPTS));
  const porNome = Object.fromEntries(opts.map(o => [o.nome, o]));
  ['Cimento', 'Água', 'EPS', 'Superplastificante', 'Incorporador de Ar'].forEach(n => assert.equal(porNome[n].fixo, true, n));
  assert.equal(porNome.Fibra.fixo, true);
  assert.equal(porNome.Cerragem.fixo, false);
  assert.equal(porNome.Antigo.fixo, false);
});

test('Configurações: todo insumo tem toggle; Padrão travado, Custom liga/desliga', async () => {
  window.abrirConfig();
  await espera(200);
  window.cfgMostrarSecao('insumos');
  await espera(200);
  const lista = document.getElementById('cfg-insumos-lista');
  const toggles = [...lista.querySelectorAll('input[type=checkbox]')];
  assert.equal(toggles.length, 8, '5 Padrão + 3 Custom');
  assert.ok(toggles.slice(0, 5).every(t => t.checked && t.disabled), 'Padrão: ligado e desabilitado');
  assert.deepEqual(toggles.slice(5).map(t => t.checked), [true, false, false]);

  window.cfgToggleInsumoFixo(6, true); // Cerragem
  await espera(50);
  assert.equal(lista.querySelectorAll('input[type=checkbox]')[6].checked, true);
  window.cfgToggleInsumoFixo(0, false); // Padrão: no-op
  await espera(50);
  assert.equal(lista.querySelectorAll('input[type=checkbox]')[0].checked, true);
  window.cfgToggleInsumoFixo(6, false); // volta ao original
  window.fecharConfig && window.fecharConfig();
});

test('Registrar Operação: Custom fixo já aparece no traço novo, obrigatório e sem ✕; não fixo fica só no "+"', async () => {
  window.showPage('operacao');
  await espera(300);
  window.LWOp.addTraco();
  await espera(300);

  const raw = JSON.parse(window.localStorage.getItem('lw_op_current'));
  assert.deepEqual(Object.keys(raw.tracos[0].insumos_custom), ['Fibra']);

  const html = document.body.innerHTML;
  assert.ok(html.includes('Fibra (kg)'), 'campo Fibra deveria estar visível sem usar o "+"');
  assert.ok(!html.includes('Cerragem (kg)'), 'Cerragem (não fixo) não deveria aparecer');
  assert.ok(!html.includes("removerInsumoCustom(0,'Fibra')"), 'fixo não pode ter o ✕');

  // Não fixo continua disponível no picker; fixo (já no traço) não.
  window.LWOp.toggleInsumoCustomPicker(0);
  await espera(100);
  const opcoes = [...document.getElementById('insumo-custom-select-0').options].map(o => o.value);
  assert.deepEqual(opcoes, ['Cerragem', 'Antigo']);
});
