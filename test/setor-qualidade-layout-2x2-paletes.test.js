// ─── test/setor-qualidade-layout-2x2-paletes.test.js ────────────────────────
// Pedido do usuário: os 4 paletes (Setor de Qualidade, Análise Focada,
// Espelho Visual) passam de uma linha (Pallet 1 2 3 4) pra um layout 2x2:
//
//   Pallet 2   Pallet 1
//   Pallet 3   Pallet 4
//
// E no Setor de Qualidade (única tela onde faz sentido — Análise Focada e
// Espelho são só leitura de histórico, sem onde persistir uma troca de
// posição, confirmado com o usuário), os pallets ficam "móveis": segurar o
// rótulo "PALLET N" e arrastar pra cima de outro troca a posição VISUAL dos
// dois — nunca os dados/placas (isso já existe à parte, arrastando uma
// placa individual).
//
// Implementação: a ordem/posição é controlada por CSS `order`
// (.sq-pallet-col[data-pallet-id], setor-qualidade.css) — os ids
// (stack1/stack2/...) nunca mudam de lugar no DOM/HTML, só a posição
// visual. Isso é importante porque o NÚMERO do pallet tem significado
// (mapeamento berço→pallet, ver "Definir Paletes", Configurações) — trocar
// a posição na tela não pode, de jeito nenhum, mexer em qual pallet recebe
// qual berço.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-layout-paletes-374';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let dom;
let window;
let document;

function fakeDataTransfer() {
  const store = {};
  return {
    setData(tipo, valor) { store[tipo] = valor; },
    getData(tipo) { return store[tipo] || ''; },
    get types() { return Object.keys(store); },
    effectAllowed: null,
  };
}

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
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
  await new Promise(r => setTimeout(r, 2500));
  window.showPage('setor-qualidade');
  await new Promise(r => setTimeout(r, 500));
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

function ordensAtuais() {
  const cols = document.querySelectorAll('.sq-pallet-col[data-pallet-id]');
  const mapa = {};
  cols.forEach(el => { mapa[el.dataset.palletId] = window.getComputedStyle(el).order; });
  return mapa;
}

test('ordem visual padrão dos 4 pallets é 2-1 / 3-4 (layout 2x2)', () => {
  const ordens = ordensAtuais();
  assert.equal(ordens.stack2, '1', 'Pallet 2 deveria ser o 1º (canto superior esquerdo)');
  assert.equal(ordens.stack1, '2', 'Pallet 1 deveria ser o 2º (canto superior direito)');
  assert.equal(ordens.stack3, '3', 'Pallet 3 deveria ser o 3º (canto inferior esquerdo)');
  assert.equal(ordens.stack4, '4', 'Pallet 4 deveria ser o 4º (canto inferior direito)');
});

test('arrastar o rótulo "PALLET 1" pra cima do Pallet 3 troca só a posição visual dos dois', () => {
  const dt = fakeDataTransfer();
  const colStack3 = document.querySelector('.sq-pallet-col[data-pallet-id="stack3"]');

  window.SQ.iniciarArrastarPallet({ dataTransfer: dt, preventDefault() {} }, 'stack1');
  window.SQ.soltarPallet({ dataTransfer: dt, preventDefault() {}, currentTarget: colStack3 }, 'stack3');

  const ordens = ordensAtuais();
  assert.equal(ordens.stack1, '3', 'Pallet 1 deveria assumir a posição que era do Pallet 3');
  assert.equal(ordens.stack3, '2', 'Pallet 3 deveria assumir a posição que era do Pallet 1');
  assert.equal(ordens.stack2, '1', 'Pallet 2 não deveria ser afetado pela troca entre 1 e 3');
  assert.equal(ordens.stack4, '4', 'Pallet 4 não deveria ser afetado pela troca entre 1 e 3');
});

test('trocar a posição visual NÃO move nenhuma placa/dado entre os pallets', () => {
  // Depois da troca do teste anterior — as placas continuam fisicamente
  // dentro do MESMO #stackN de sempre, mesmo com a posição na tela trocada.
  const placa1 = document.querySelector('.sq-slab[data-id="stack1-1"]');
  const placa3 = document.querySelector('.sq-slab[data-id="stack3-1"]');
  assert.ok(document.getElementById('stack1').contains(placa1), 'placa stack1-1 deveria continuar dentro de #stack1');
  assert.ok(document.getElementById('stack3').contains(placa3), 'placa stack3-1 deveria continuar dentro de #stack3');
});

test('soltar um pallet em cima de si mesmo não faz nada (sem efeito colateral)', () => {
  const antes = ordensAtuais();
  const dt = fakeDataTransfer();
  const colStack2 = document.querySelector('.sq-pallet-col[data-pallet-id="stack2"]');

  window.SQ.iniciarArrastarPallet({ dataTransfer: dt, preventDefault() {} }, 'stack2');
  window.SQ.soltarPallet({ dataTransfer: dt, preventDefault() {}, currentTarget: colStack2 }, 'stack2');

  assert.deepEqual(ordensAtuais(), antes, 'soltar em cima de si mesmo não deveria mudar nada');
});

test('permitirDropPallet só libera o drop pra um arrastar-de-pallet de verdade (não uma placa individual)', () => {
  let preventDefaultChamado = false;
  const dtPlaca = { types: ['text/plain'] }; // drag de PLACA individual usa text/plain, não application/x-lw-pallet
  window.SQ.permitirDropPallet({ dataTransfer: dtPlaca, preventDefault: () => { preventDefaultChamado = true; } });
  assert.equal(preventDefaultChamado, false, 'não deveria liberar o drop pra um drag de placa individual');

  const dtPallet = { types: ['application/x-lw-pallet'] };
  window.SQ.permitirDropPallet({ dataTransfer: dtPallet, preventDefault: () => { preventDefaultChamado = true; } });
  assert.equal(preventDefaultChamado, true, 'deveria liberar o drop pra um drag de pallet de verdade');
});

test('Análise Focada e Espelho Visual reordenam a EXIBIÇÃO pra 2-1/3-4, sem mudar de onde vem o dado de cada pallet', () => {
  const codigoFocada = fs.readFileSync(path.join(__dirname, '..', 'public/js/analise-focada.js'), 'utf8');
  assert.match(codigoFocada, /\[2, 1, 3, 4\]\.forEach\(p =>/, 'Análise Focada deveria iterar os pallets na ordem 2,1,3,4');
  assert.match(codigoFocada, /grid-template-columns:repeat\(2,1fr\)/, 'Análise Focada deveria forçar 2 colunas (layout 2x2)');

  const codigoSQ = fs.readFileSync(path.join(__dirname, '..', 'public/js/setor-qualidade.js'), 'utf8');
  assert.match(codigoSQ, /\[2, 1, 3, 4\]\.forEach\(p => \{\s*html \+= `<div class="sq-mini-pallet">/, 'Espelho Visual deveria iterar os pallets na ordem 2,1,3,4');

  const codigoCSS = fs.readFileSync(path.join(__dirname, '..', 'public/css/setor-qualidade.css'), 'utf8');
  assert.match(codigoCSS, /\.sq-mini-stacks \{ display: grid; grid-template-columns: repeat\(2, 1fr\)/, 'Espelho Visual deveria forçar 2 colunas (layout 2x2)');
});
