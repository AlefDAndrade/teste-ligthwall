// ─── test/operacao-descarte-traco.test.js ───────────────────────────────────
// Cobertura do FRONTEND do Registro de Traço Descartado (Perda) — ver
// README, "Registro de Traço Descartado (Perda) — plano", passo 3.
//
// Roda o server.js DE VERDADE + a página real carregada num JSDOM (mesmo
// padrão de test/operacao-confirmar-remover-traco.test.js e
// test/manutencao-fechar-chamado.test.js) — não é um mock de UI. Cobre:
//   - O link "⚠️ Descartar este traço" aparece em cada card de traço.
//   - Clicar nele abre o modal dedicado, com Data/Turno pré-preenchidos e
//     os insumos já pesados pra aquele traço.
//   - Motivo vazio recusa o envio (mensagem de erro no próprio modal, sem
//     fechar) e NADA é gravado no servidor.
//   - Caminho feliz: confirma com motivo preenchido -> POST
//     /registrar-traco-descartado -> o traço some da lista de traços
//     pendentes da operação (não vira uma aba/linha) -> o registro
//     aparece em GET /db/tracos_descartados.json.
//   - Em Modo de Teste, o link fica desabilitado (visual + funcionalmente)
//     — evita gravar perda fantasma na tabela real.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-descarte-traco-284';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let dom;
let window;
let cookieAdmin;

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

function contarAbasTraco() {
  return window.document.querySelectorAll('.traco-tabs-nav .traco-tab').length;
}

// Helper de clique: `.click()` nativo do jsdom não dispara o evento de
// forma confiável em elementos <a href="#"> carregados via
// JSDOM.fromURL() (comportamento específico deste ambiente de teste, não
// do app) — dispatchEvent com um MouseEvent de verdade funciona igual e
// passa pelo mesmo caminho (bubbling, onclick inline, etc.).
function clicar(el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function buscarTracosDescartados() {
  return fetch(`${servidor.baseUrl}/db/tracos_descartados.json`).then(r => r.json());
}

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
  cookieAdmin = await logarComoAdminMaster();

  dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
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

test('o link "Descartar este traço" aparece no card do traço', async () => {
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(contarAbasTraco(), 1, 'premissa: deveria ter 1 traço antes do teste');

  const link = window.document.querySelector('.link-descartar-traco');
  assert.ok(link, 'o link de descarte deveria estar no card do traço');
  assert.match(link.textContent, /descartar este traço/i);
});

test('clicar no link abre o modal com Data/Turno preenchidos automaticamente', async () => {
  clicar(window.document.querySelector('.link-descartar-traco'));
  await new Promise(r => setTimeout(r, 50));

  const modal = window.document.getElementById('modal-descarte-traco');
  assert.ok(modal, 'o modal de descarte deveria ter aberto');
  assert.match(modal.querySelector('h2').textContent, /descartar traço/i);

  const inputs = modal.querySelectorAll('input[readonly]');
  assert.equal(inputs.length, 2, 'Data e Turno devem vir preenchidos e travados');
  assert.ok(inputs[0].value, 'Data deveria vir preenchida automaticamente');
});

test('motivo vazio recusa o envio, sem fechar o modal e sem gravar nada', async () => {
  clicar(window.document.getElementById('btn-confirmar-descarte-traco'));
  await new Promise(r => setTimeout(r, 100));

  const modal = window.document.getElementById('modal-descarte-traco');
  assert.ok(modal, 'o modal deveria continuar aberto (motivo obrigatório)');
  const erro = window.document.getElementById('descarte-traco-erro');
  assert.equal(erro.style.display, 'block');
  assert.match(erro.textContent, /motivo/i);

  const lista = await buscarTracosDescartados();
  assert.equal(lista.length, 0, 'nada deveria ter sido gravado ainda');
});

test('caminho feliz: preencher motivo e confirmar grava o descarte e remove o traço da lista', async () => {
  window.document.getElementById('descarte-cimento').value = '350';
  window.document.getElementById('descarte-motivo').value = 'Contaminação identificada antes de encher berço';

  clicar(window.document.getElementById('btn-confirmar-descarte-traco'));
  await new Promise(r => setTimeout(r, 150));

  assert.equal(window.document.getElementById('modal-descarte-traco'), null, 'o modal deveria ter fechado');
  assert.equal(contarAbasTraco(), 0, 'o traço descartado não deveria virar uma aba/linha pendente');

  const lista = await buscarTracosDescartados();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].motivo, 'Contaminação identificada antes de encher berço');
  assert.equal(lista[0].cimento, 350);
});

test('em Modo de Teste, o link fica desabilitado e não abre o modal', async () => {
  window.LWOp.resetarOperacao();
  await new Promise(r => setTimeout(r, 50));

  const toggleTeste = window.document.getElementById('op-toggle-teste');
  toggleTeste.checked = true;
  toggleTeste.dispatchEvent(new window.Event('change'));
  await new Promise(r => setTimeout(r, 50));

  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));

  const link = window.document.querySelector('.link-descartar-traco');
  assert.ok(link, 'o link ainda deveria estar visível (só desabilitado)');
  assert.match(link.getAttribute('style'), /not-allowed/);

  clicar(link);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(window.document.getElementById('modal-descarte-traco'), null, 'o modal NÃO deveria abrir em Modo de Teste');

  const lista = await buscarTracosDescartados();
  assert.equal(lista.length, 1, 'ainda deveria ser só o descarte do teste anterior — nada novo gravado');
});
