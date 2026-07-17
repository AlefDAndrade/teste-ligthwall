// ─── test/paletes-ordem-multiplos-arrastes.test.js ──────────────────────────
// Reproduz EXATAMENTE o cenário relatado: reorganizar os 4 paletes por
// completo (não só trocar 2), o que precisa de MAIS DE UM arraste
// sequencial antes de salvar — ver conversa que motivou a mudança.
// test/paletes-ordem-drag.test.js já cobria um único arraste (troca de 2
// paletes) de ponta a ponta com sucesso; este arquivo testa o caso de
// vários arrastes em sequência, na mesma sessão do modal, antes de clicar
// "Salvar".

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-paletes-multi-357';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor, dom, window, document;

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
  window.abrirConfig();
  window.cfgMostrarSecao('paletes');
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

function fakeDataTransfer() {
  const dados = {};
  return { setData: (tipo, valor) => { dados[tipo] = valor; }, getData: (tipo) => dados[tipo] };
}

function arrastarESoltar(sidOrigem, sidDestino) {
  const dt = fakeDataTransfer();
  window.poIniciarArrastar({ dataTransfer: dt }, sidOrigem);
  const colDestino = document.querySelector(`.po-pallet-col[data-pallet-id="${sidDestino}"]`);
  window.poSoltar({ preventDefault: () => {}, currentTarget: colDestino, dataTransfer: dt }, sidDestino);
}

// Reproduz "1 2 / 3 4" -> "4 3 / 2 1" (inverte tudo) — precisa de 2
// arrastes: stack1<->stack4 (extremos) e stack2<->stack3 (miolo).
test('2 arrastes sequenciais (sem salvar entre eles) resultam no rascunho final correto', () => {
  const antesRaw = window.eval('_poRascunho');
  const antes = { stack1: antesRaw.stack1, stack2: antesRaw.stack2, stack3: antesRaw.stack3, stack4: antesRaw.stack4 };

  arrastarESoltar('stack1', 'stack4');
  const depoisDoPrimeiroRaw = window.eval('_poRascunho');
  const depoisDoPrimeiro = { stack1: depoisDoPrimeiroRaw.stack1, stack2: depoisDoPrimeiroRaw.stack2, stack3: depoisDoPrimeiroRaw.stack3, stack4: depoisDoPrimeiroRaw.stack4 };
  // Confere o 1º arraste isoladamente antes de continuar.
  assert.equal(depoisDoPrimeiro.stack1, antes.stack4, '1º arraste: stack1 deveria ter a posição antiga de stack4');
  assert.equal(depoisDoPrimeiro.stack4, antes.stack1, '1º arraste: stack4 deveria ter a posição antiga de stack1');

  arrastarESoltar('stack2', 'stack3');
  const depoisDoSegundoRaw = window.eval('_poRascunho');
  const depoisDoSegundo = { stack1: depoisDoSegundoRaw.stack1, stack2: depoisDoSegundoRaw.stack2, stack3: depoisDoSegundoRaw.stack3, stack4: depoisDoSegundoRaw.stack4 };
  assert.equal(depoisDoSegundo.stack2, antes.stack3, '2º arraste: stack2 deveria ter a posição antiga de stack3');
  assert.equal(depoisDoSegundo.stack3, antes.stack2, '2º arraste: stack3 deveria ter a posição antiga de stack2');
  // O 1º arraste não pode ter sido desfeito pelo 2º.
  assert.equal(depoisDoSegundo.stack1, antes.stack4, '1º arraste não deveria ter sido perdido pelo 2º');
  assert.equal(depoisDoSegundo.stack4, antes.stack1, '1º arraste não deveria ter sido perdido pelo 2º');

  const coletado = window.poColetarValores();
  assert.deepEqual(
    { stack1: coletado.stack1, stack2: coletado.stack2, stack3: coletado.stack3, stack4: coletado.stack4 },
    depoisDoSegundo,
  );
});

test('salvar depois de 2 arrastes sequenciais persiste o resultado FINAL (não o default, não o intermediário)', async () => {
  const rascunhoFinal = window.eval('_poRascunho');
  const esperado = {
    stack1: rascunhoFinal.stack1, stack2: rascunhoFinal.stack2,
    stack3: rascunhoFinal.stack3, stack4: rascunhoFinal.stack4,
  };

  const promessaSalvar = window.cfgSalvar();
  await new Promise(r => setTimeout(r, 400));
  const btnOk = document.getElementById('btn-alerta-ok');
  if (btnOk) btnOk.click();
  await promessaSalvar;
  await new Promise(r => setTimeout(r, 300));

  const resp = await fetch(`${servidor.baseUrl}/db/config.json`, { cache: 'no-store' });
  const cfgSalvo = await resp.json();
  assert.deepEqual(cfgSalvo.paletesOrdem, esperado);
});
