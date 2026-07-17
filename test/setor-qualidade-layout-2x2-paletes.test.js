// ─── test/setor-qualidade-layout-2x2-paletes.test.js ────────────────────────
// Os 4 paletes (Setor de Qualidade) usam um layout 2x2 (ver .sq-pallet-col,
// setor-qualidade.css):
//
//   Pallet 2   Pallet 1
//   Pallet 3   Pallet 4
//
// A ordem/posição é controlada por CSS `order` (.sq-pallet-col[data-pallet-id])
// — os ids (stack1/stack2/...) nunca mudam de lugar no DOM/HTML, só a posição
// visual. Isso é importante porque o NÚMERO do pallet tem significado
// (mapeamento berço→pallet, ver "Definir Paletes", Configurações).
//
// Removido daqui (ver conversa que motivou): testes de um recurso de
// ARRASTAR o rótulo "PALLET N" pra trocar a posição visual de dois paletes
// (iniciarArrastarPallet/soltarPallet/permitirDropPallet) e de um layout 2x2
// equivalente em Análise Focada/Espelho Visual — nenhum dos dois chegou a
// ser implementado (as funções nunca existiram em setor-qualidade.js); os
// testes ficaram descrevendo um recurso que não existe. Se esse recurso for
// implementado no futuro, os testes precisam ser escritos do zero.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-layout-paletes-374';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let dom;
let window;
let document;

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
