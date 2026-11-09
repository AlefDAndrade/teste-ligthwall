// ─── test/ajuste-traco-leitura-automatica.test.js ───────────────────────────
// Ajuste de Traço (popover em Registrar Operação, ajuste-traco.js): flow e
// densidade MEDIDOS vêm sozinhos do traço aberto — operacao.js
// (_sincronizarAjusteTraco) repassa o valor ATUAL de cada um (o último
// ajuste vence; sem ajuste, o original). O flow do traço é em mm; o popover
// trabalha em cm.
//
// Mesmo padrão de test/operacao-flow-densidade-so-ajuste.test.js: servidor
// real + jsdom carregando a SPA de verdade. Os testes rodam em sequência e
// dependem do estado deixado pelo anterior (como o traço 1 vai acumulando
// leituras e depois um Ajuste de Receita).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-ajuste-traco-leitura-538';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let dom;
let window;
let document;

const espera = ms => new Promise(r => setTimeout(r, ms));
const $ = id => document.getElementById(id);
function digitar(id, valor) {
  $(id).value = String(valor);
  $(id).dispatchEvent(new window.Event('input', { bubbles: true }));
}

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
  // index.html é GERADO (build-index.js; npm start/dev rodam sozinhos). Se estiver
  // desatualizado, o popover nem existe — melhor dizer isso do que falhar mudo.
  const html = await (await fetch(`${servidor.baseUrl}/index.html`)).text();
  assert.ok(html.includes('id="popover-ajuste-traco"') && html.includes('js/ajuste-traco.js'),
    'public/index.html está desatualizado — rode `npm run build` e tente de novo');

  dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
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
  window = dom.window;
  document = window.document;
  window.sessionStorage.setItem('lw_role', 'Administrador');
  window.localStorage.setItem('lw_admin_authenticated', 'true');
  await espera(2500);

  window.showPage('operacao');
  await espera(300);
  window.LWOp.addTraco();
  await espera(200);

  // Preenche o que o Ajuste de Receita exige (tudo, exceto flow/densidade,
  // que cada teste preenche na ordem).
  window.LWOp.updateTraco(0, 'berco_ini', '1');
  window.LWOp.updateTraco(0, 'berco_fim', '10');
  window.LWOp.updateTraco(0, 'silo', 'S1');
  window.LWOp.updateTraco(0, 'expansao', '30');
  window.LWOp.updateTraco(0, 'densidadeEPS', '15');
  window.LWOp.updateInsumoOriginal(0, 'cimento_real', '12.00');
  window.LWOp.updateInsumoOriginal(0, 'agua_real', '5.00');
  window.LWOp.updateInsumoOriginal(0, 'eps_real', '0.50');
  window.LWOp.updateInsumoOriginal(0, 'superplast_real', '0.12');
  window.LWOp.updateInsumoOriginal(0, 'incorporador_real', '0.05');
  window.LWOp.updateInsumoOriginal(0, 'tempo_batida', '180');
  await espera(100);
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

test('a ferramenta está montada na SPA; traço aberto ainda sem medição → campos vazios e aviso', () => {
  assert.ok(window.LWAjusteTraco, 'LWAjusteTraco deveria estar carregado');
  assert.equal($('ajt-flow').value, '');
  assert.equal($('ajt-dens').value, '');
  assert.match($('ajt-origem').textContent, /Traço \d+ ainda sem flow e densidade medidos/);
});

test('digitar flow (mm) e densidade no traço preenche o Ajuste de Traço, com flow em cm', async () => {
  window.LWOp.updateInsumoOriginal(0, 'flow_insumo', '450');
  window.LWOp.updateInsumoOriginal(0, 'densidade_insumo', '440');
  assert.equal($('ajt-flow').value, '45');
  assert.equal($('ajt-dens').value, '440');
  assert.match($('ajt-origem').textContent, /Leitura do Traço \d+, preenchida automaticamente \(flow convertido de mm para cm\)/);
  assert.match($('ajt-resultado').textContent, /Adicione/);
});

test('o campo do traço continua em mm (a conversão é só do popover) e o traço não é alterado', async () => {
  const campoFlow = () => Array.from(document.querySelectorAll('.insumo-group'))
    .find(g => /Flow \(mm\)/.test(g.textContent)).querySelector('input');
  window.LWOp.selectTraco(0); // re-renderiza o traço a partir do estado
  await espera(50);
  assert.equal(campoFlow().value, '450');

  digitar('ajt-flow', 20); // "e se…" dentro do popover
  window.LWOp.selectTraco(0);
  await espera(50);
  assert.equal(campoFlow().value, '450', 'mexer no popover não pode alterar o traço');
  assert.equal($('ajt-flow').value, '20', 'e o "e se…" continua no popover');
});

test('a leitura acompanha o que a pessoa digita no traço, tecla a tecla', () => {
  window.LWOp.updateInsumoOriginal(0, 'flow_insumo', '4');
  assert.equal($('ajt-flow').value, '0,4');
  window.LWOp.updateInsumoOriginal(0, 'flow_insumo', '42');
  window.LWOp.updateInsumoOriginal(0, 'flow_insumo', '420');
  assert.equal($('ajt-flow').value, '42');
});

test('apagar o flow no traço limpa o campo do popover', () => {
  window.LWOp.updateInsumoOriginal(0, 'flow_insumo', '');
  assert.equal($('ajt-flow').value, '');
  assert.match($('ajt-origem').textContent, /Falta o flow\./);
  window.LWOp.updateInsumoOriginal(0, 'flow_insumo', '420');
  assert.equal($('ajt-flow').value, '42');
});

test('um "e se…" digitado no popover sobrevive a re-render do traço, e reabrir o popover volta à leitura do traço', async () => {
  digitar('ajt-flow', 30);
  window.LWOp.selectTraco(0); // re-renderiza os traços
  await espera(50);
  assert.equal($('ajt-flow').value, '30', 're-render não pode apagar o que a pessoa digitou');

  window.LWOp.togglePopover('popover-ajuste-traco'); // abre
  assert.ok($('popover-ajuste-traco').classList.contains('active'));
  assert.equal($('ajt-flow').value, '42', 'ao abrir, parte da leitura atual do traço');
  assert.match($('ajt-origem').textContent, /preenchida automaticamente/);

  window.LWOp.togglePopover('popover-ajuste-traco'); // fecha — não mexe nos campos
  assert.equal($('popover-ajuste-traco').classList.contains('active'), false);
  assert.equal($('ajt-flow').value, '42');
});

test('depois de um Ajuste de Receita com remedição, o popover passa a usar o valor ATUAL (o último vence)', async () => {
  window.LWOp.abrirAjusteReceita(0);
  await espera(50);
  document.getElementById('ar-m-up').click();
  document.getElementById('ar-insumo-densidade_insumo').value = '460';
  document.getElementById('ar-insumo-densidade_insumo').dispatchEvent(new window.Event('input', { bubbles: true }));
  document.getElementById('ar-insumo-flow_insumo').value = '400';
  document.getElementById('ar-insumo-flow_insumo').dispatchEvent(new window.Event('input', { bubbles: true }));
  document.getElementById('ar-btn-salvar').click();
  await espera(150);

  assert.equal($('ajt-flow').value, '40');
  assert.equal($('ajt-dens').value, '460');
});

test('traço novo, sem medição, limpa o popover; voltar ao traço 1 traz a leitura dele de volta', async () => {
  window.LWOp.addTraco();
  await espera(150);
  assert.equal($('ajt-flow').value, '');
  assert.equal($('ajt-dens').value, '');
  assert.match($('ajt-origem').textContent, /ainda sem flow e densidade medidos/);

  window.LWOp.selectTraco(0);
  await espera(50);
  assert.equal($('ajt-flow').value, '40');
  assert.equal($('ajt-dens').value, '460');
  assert.match($('ajt-origem').textContent, /Traço 1/);
});
