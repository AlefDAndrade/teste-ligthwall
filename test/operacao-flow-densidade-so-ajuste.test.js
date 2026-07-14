// ─── test/operacao-flow-densidade-so-ajuste.test.js ─────────────────────────
// Regressão de um bug real, relatado numa conversa: em Registrar Operação,
// um traço tinha TODOS os campos preenchidos, exceto Flow e Densidade do
// traço — que nunca receberam um valor ORIGINAL. O operador então usou
// "Ajustar Receita" (Remedição) pra preencher Flow e Densidade ali. A TELA
// mostrava os dois campos preenchidos normalmente (totalInsumo já
// considera o último ajuste pra exibição, mesmo sem original) — mas a
// checagem de completude (tracoCompleto, _statusDoTraco) só olhava
// `insumo.original`, nunca `insumo.ajustes` — então o traço continuava
// marcado como PENDENTE mesmo com os dois campos visivelmente preenchidos,
// bloqueando "Registrar".
//
// Corrigido: tracoCompleto()/_statusDoTraco() agora consideram um insumo
// preenchido se tiver valor original OU pelo menos 1 ajuste — mesmo
// conceito que totalInsumo() já usava pra decidir o que MOSTRAR na tela,
// só que agora também vale pra decidir o que conta como "preenchido" pra
// fins de pendência.
//
// Mesmo padrão de test/operacao-status-aba-traco.test.js: servidor real +
// jsdom carregando a SPA de verdade.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-flow-densidade-ajuste-951';
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

  window.showPage('operacao');
  await new Promise(r => setTimeout(r, 300));
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 200));

  // Preenche TUDO, EXCETO Flow e Densidade (deixados vazios de propósito
  // — nunca recebem um valor ORIGINAL nesta operação).
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
  await new Promise(r => setTimeout(r, 100));
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

test('traço sem Flow/Densidade original fica "pending" — pré-condição', () => {
  const aba = document.querySelector('.traco-tabs-nav .traco-tab');
  assert.ok(aba.className.includes('pending'), 'faltando Flow/Densidade, o traço deveria estar pendente');
});

test('preencher Flow e Densidade só via "Ajustar Receita" (Remedição, sem nunca ter original) marca o traço como completo', async () => {
  window.LWOp.abrirAjusteReceita(0);
  await new Promise(r => setTimeout(r, 50));

  // Tempo de batida adicionado é obrigatório no modal — 1 clique na seta
  // de minutos já satisfaz.
  document.getElementById('ar-m-up').click();

  document.getElementById('ar-insumo-densidade_insumo').value = '1200';
  document.getElementById('ar-insumo-densidade_insumo').dispatchEvent(new window.Event('input', { bubbles: true }));
  document.getElementById('ar-insumo-flow_insumo').value = '650';
  document.getElementById('ar-insumo-flow_insumo').dispatchEvent(new window.Event('input', { bubbles: true }));

  document.getElementById('ar-btn-salvar').click();
  await new Promise(r => setTimeout(r, 100));

  const aba = document.querySelector('.traco-tabs-nav .traco-tab');
  assert.ok(aba.className.includes('complete'), 'com Flow/Densidade preenchidos via ajuste, o traço deveria virar "complete"');
  assert.equal(aba.querySelector('.status-icon').textContent, '✅');

  const itemTraco = Array.from(document.querySelectorAll('.pendency-item'))
    .find(el => el.textContent.includes('Informações do traço'));
  assert.ok(itemTraco.className.includes('ok'), 'a pendência "Informações do traço" deveria estar ok, sem bloquear o Registrar');
});
