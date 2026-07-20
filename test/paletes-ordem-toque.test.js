// ─── test/paletes-ordem-toque.test.js ───────────────────────────────────────
// Regressão de um bug real: "Ordem dos Paletes" (Configurações → Paletes)
// só respondia a Drag and Drop NATIVO do HTML5 (ondragstart/ondrop) — essa
// API é baseada em mouse e a maioria dos navegadores de celular (Safari iOS
// em particular) não dispara esses eventos em resposta a toque. Resultado:
// arrastar um palete no celular não fazia NADA, nem visualmente (nenhum
// evento chegava a disparar) — ver conversa que motivou isso.
//
// _poTouchStart/_poTouchMove/_poTouchEnd (paletes-ordem.js) cobrem o mesmo
// caminho por toque, terminando na MESMA _poTrocarPosicoes de sempre (já
// coberta por test/paletes-ordem-drag.test.js, pelo lado do mouse).
//
// jsdom não implementa layout de verdade — document.elementFromPoint(x,y)
// não reflete a posição real de nada na tela (sempre retornaria algo
// incorreto). Os testes abaixo mockam elementFromPoint pra devolver o
// elemento esperado, e verificam que _poTouchStart/Move/End reagem
// corretamente a ele — a parte de geometria em si (jsdom não faz) não é o
// que está sendo testado; a LÓGICA de arrastar-e-soltar por toque é.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-paletes-ordem-toque-951';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let dom;
let window;
let document;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
  const respAdmin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  const cookieAdmin = (respAdmin.headers.get('set-cookie') || '').split(';')[0];

  dom = await JSDOM.fromURL(servidor.baseUrl + '/index.html', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.Element.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        const headers = { ...(opts && opts.headers), Cookie: cookieAdmin };
        return fetch(absoluta, { ...opts, headers });
      };
    },
  });
  window = dom.window;
  document = window.document;
  window.sessionStorage.setItem('lw_role', 'Administrador');
  await new Promise(r => setTimeout(r, 2500));
  window.eval('AdminAuth.abrirModal = function(onSuccess) { if (onSuccess) onSuccess(); };');
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

// Simula elementFromPoint devolvendo sempre o elemento indicado — jsdom não
// faz layout de verdade, então x/y não têm significado real aqui; só a
// LÓGICA de _poTouchMove/_poTouchEnd (o que eles fazem com o que
// elementFromPoint devolve) está sendo exercitada.
function mockarElementoNoPonto(el) {
  window.document.elementFromPoint = () => el;
}

// _poRascunho vive no realm do jsdom; comparar o objeto INTEIRO via
// deepEqual contra um objeto criado aqui no realm do Node acusaria
// diferença só por causa do protótipo, mesmo com os mesmos valores (mesmo
// cuidado de test/paletes-ordem-drag.test.js) — por isso sempre extrai só
// os 4 valores primitivos antes de comparar.
function copiarRascunho() {
  const r = window.eval('_poRascunho');
  return { stack1: r.stack1, stack2: r.stack2, stack3: r.stack3, stack4: r.stack4 };
}

function toqueFake(x, y) {
  return { clientX: x, clientY: y };
}

test('abrir Configurações renderiza a grade com os handlers de toque (ontouchstart/move/end) prontos, além dos de mouse', () => {
  window.abrirConfig();
  window.cfgMostrarSecao('paletes');

  const labels = document.querySelectorAll('.po-pallet-label');
  assert.equal(labels.length, 4);
  labels.forEach(label => {
    assert.ok(label.getAttribute('ontouchstart'), 'label deveria ter ontouchstart além de ondragstart');
    assert.ok(label.getAttribute('ontouchmove'));
    assert.ok(label.getAttribute('ontouchend'));
  });
});

test('arrastar por TOQUE (não mouse) PALETE 1 pra cima de PALETE 2 troca os dois — mesmo resultado do drag por mouse', () => {
  const def = window.eval('LW.PALETES_ORDEM_DEFAULT');
  const colDestino = document.querySelector('.po-pallet-col[data-pallet-id="stack2"]');
  const labelOrigem = document.querySelector('.po-pallet-col[data-pallet-id="stack1"] .po-pallet-label');

  mockarElementoNoPonto(colDestino);

  window._poTouchStart({ currentTarget: labelOrigem, touches: [toqueFake(10, 10)] }, 'stack1');
  assert.ok(labelOrigem.classList.contains('po-pallet-label-arrastando'), 'deveria marcar visualmente que está sendo arrastado');

  window._poTouchMove({ preventDefault: () => {}, touches: [toqueFake(50, 50)] });
  assert.ok(colDestino.classList.contains('po-pallet-col-dragover'), 'palete embaixo do dedo deveria ficar destacado');

  window._poTouchEnd({ changedTouches: [toqueFake(50, 50)] });

  assert.ok(!labelOrigem.classList.contains('po-pallet-label-arrastando'), 'destaque de "arrastando" deveria sumir ao soltar');
  assert.ok(!colDestino.classList.contains('po-pallet-col-dragover'), 'destaque do alvo deveria sumir ao soltar');

  const rascunho = window.eval('_poRascunho');
  assert.equal(rascunho.stack1, def.stack2, 'stack1 deveria ter assumido a posição que era do stack2');
  assert.equal(rascunho.stack2, def.stack1, 'stack2 deveria ter assumido a posição que era do stack1');
  assert.equal(colDestino.style.order, String(def.stack1));
});

test('soltar o dedo fora de qualquer palete (elementFromPoint sem .po-pallet-col) não troca nada, só limpa o estado', () => {
  const rascunhoAntes = copiarRascunho();
  const labelOrigem = document.querySelector('.po-pallet-col[data-pallet-id="stack3"] .po-pallet-label');

  mockarElementoNoPonto(document.body); // body não tem .closest('.po-pallet-col')

  window._poTouchStart({ currentTarget: labelOrigem, touches: [toqueFake(10, 10)] }, 'stack3');
  window._poTouchEnd({ changedTouches: [toqueFake(9999, 9999)] });

  assert.deepEqual(copiarRascunho(), rascunhoAntes, 'sem um palete de verdade embaixo do dedo, nada deveria mudar');
  assert.ok(!labelOrigem.classList.contains('po-pallet-label-arrastando'));
});

test('touchcancel (ex: o sistema interrompeu o gesto) limpa o estado sem trocar nada', () => {
  const rascunhoAntes = copiarRascunho();
  const colDestino = document.querySelector('.po-pallet-col[data-pallet-id="stack4"]');
  const labelOrigem = document.querySelector('.po-pallet-col[data-pallet-id="stack1"] .po-pallet-label');

  mockarElementoNoPonto(colDestino);
  window._poTouchStart({ currentTarget: labelOrigem, touches: [toqueFake(10, 10)] }, 'stack1');
  window._poTouchMove({ preventDefault: () => {}, touches: [toqueFake(50, 50)] });
  assert.ok(colDestino.classList.contains('po-pallet-col-dragover'));

  window._poTouchCancel();

  assert.ok(!labelOrigem.classList.contains('po-pallet-label-arrastando'));
  assert.ok(!colDestino.classList.contains('po-pallet-col-dragover'));
  assert.deepEqual(copiarRascunho(), rascunhoAntes, 'touchcancel não deveria efetivar nenhuma troca');
});

test('um segundo dedo tocando ao mesmo tempo (gesto de pinça/zoom) não inicia um arraste', () => {
  const rascunhoAntes = copiarRascunho();
  const labelOrigem = document.querySelector('.po-pallet-col[data-pallet-id="stack2"] .po-pallet-label');

  window._poTouchStart({ currentTarget: labelOrigem, touches: [toqueFake(10, 10), toqueFake(200, 200)] }, 'stack2');
  assert.ok(!labelOrigem.classList.contains('po-pallet-label-arrastando'), 'com 2 dedos, não deveria iniciar o arraste');

  const colOutro = document.querySelector('.po-pallet-col[data-pallet-id="stack1"]');
  mockarElementoNoPonto(colOutro);
  window._poTouchEnd({ changedTouches: [toqueFake(50, 50)] });

  assert.deepEqual(copiarRascunho(), rascunhoAntes, 'nada deveria ter mudado — o arraste nunca começou de verdade');
});
