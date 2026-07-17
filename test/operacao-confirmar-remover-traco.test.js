// ─── test/operacao-confirmar-remover-traco.test.js ──────────────────────────
// Pedido do usuário: uma confirmação antes de remover ("fechar") um traço
// em Registrar Operação, pra impedir remoção acidental (clique errado no
// "✕" apagava o traço na hora, sem chance de desfazer). Antes, só traços
// de sobra REAPROVEITADA pediam confirmação; traço normal era removido
// direto. Agora os dois pedem, com textos diferentes pra cada caso.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-confirmar-remover-traco-963';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let dom;
let window;

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
  window.sessionStorage.setItem('lw_role', 'Administrador');
  window.localStorage.setItem('lw_admin_authenticated', 'true');
  await new Promise(r => setTimeout(r, 2500));
  window.showPage('operacao');
  await new Promise(r => setTimeout(r, 300));
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

function contarAbasTraco() {
  return window.document.querySelectorAll('.traco-tabs-nav .traco-tab').length;
}

test('remover um traço NORMAL agora abre o modal de confirmação, em vez de remover na hora', async () => {
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(contarAbasTraco(), 1, 'premissa: deveria ter 1 traço antes do teste');

  window.LWOp.removeTraco(0);
  await new Promise(r => setTimeout(r, 50));

  assert.equal(contarAbasTraco(), 1, 'o traço NÃO deveria ter sido removido ainda — só depois de confirmar');
  const modal = window.document.getElementById('modal-confirmacao-exclusao');
  assert.ok(modal, 'o modal de confirmação deveria ter aparecido');
  assert.match(modal.querySelector('h2').textContent, /remover este traço/i);
});

test('clicar "Cancelar" no modal mantém o traço', async () => {
  window.document.getElementById('btn-cancelar-exclusao').click();
  await new Promise(r => setTimeout(r, 50));

  assert.equal(contarAbasTraco(), 1, 'o traço deveria continuar lá depois de cancelar');
  assert.equal(window.document.getElementById('modal-confirmacao-exclusao'), null, 'o modal deveria ter fechado');
});

test('clicar "Excluir" no modal remove o traço de verdade', async () => {
  window.LWOp.removeTraco(0);
  await new Promise(r => setTimeout(r, 50));
  window.document.getElementById('btn-confirmar-exclusao').click();
  await new Promise(r => setTimeout(r, 50));

  assert.equal(contarAbasTraco(), 0, 'o traço deveria ter sido removido depois de confirmar');
  assert.equal(window.document.getElementById('modal-confirmacao-exclusao'), null, 'o modal deveria ter fechado');
});

test('traço de sobra reaproveitada continua com o texto de confirmação específico de sempre (verificação de código)', () => {
  // Dirigir o fluxo real de "reaproveitar sobra" (escolher uma sobra
  // disponível de outra operação) é complexo demais pra simular aqui —
  // confirma direto no código-fonte que o branch _reaproveitado de
  // removeTraco() continua passando o texto de aviso específico (perde o
  // vínculo com o traço original), sem ter virado o texto genérico novo.
  const fs = require('node:fs');
  const path = require('node:path');
  const codigo = fs.readFileSync(path.join(__dirname, '..', 'public/js/operacao.js'), 'utf8');
  const inicioRemoveTraco = codigo.indexOf('function removeTraco(i) {');
  assert.ok(inicioRemoveTraco > -1, 'removeTraco deveria existir no arquivo');
  const trechoReaproveitado = codigo.slice(inicioRemoveTraco, inicioRemoveTraco + 2500);
  assert.match(trechoReaproveitado, /titulo:\s*'Este traço é uma sobra reaproveitada\.'/);
  assert.match(trechoReaproveitado, /vínculo com o traço original será perdido/);
  assert.match(trechoReaproveitado, /titulo:\s*'Remover este traço\?'/, 'traço normal deveria ter o novo texto genérico de confirmação');
});
