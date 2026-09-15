// ─── test/insumos-dinamicos-fase5.test.js ───────────────────────────────────
// Fase 5 de "Insumos de Receitas dinâmicos no formulário de traço" (ver
// PLANO-insumos-dinamicos-receitas.md) — botão "+"/"x" no formulário de
// Registrar Operação (public/js/operacao.js), ligado ao catálogo
// Padrão/Custom da Fase 4.
//
// Cobre:
//   1. Traço novo nasce sem nenhum insumo Custom — não aparece nenhum
//      campo extra, só os 5 Padrão de sempre.
//   2. O picker do "+" só oferece insumos CUSTOM do catálogo (nunca um
//      Padrão) que este traço específico ainda não tem.
//   3. Adicionar um Custom via "+" torna o campo OBRIGATÓRIO — o traço,
//      que estava completo, volta a ficar pendente até o campo ser
//      preenchido.
//   4. O "x" remove um Custom recém-adicionado (antes de qualquer
//      ajuste) — o traço volta a ficar completo sem ele.
//   5. Depois de 1 ajuste registrado nesse insumo Custom, o "x" some do
//      render (não dá mais pra desfazer a adição).
//   6. O modal "Ajustar Receita" trata um insumo Custom do traço como
//      OPCIONAL (mesmo critério dos 5 Padrão ali) — só some se for
//      preenchido, não bloqueia salvar se ficar em branco.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-insumos-fase5-733';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let dom;
let window;
let document;

function extrairCookie(resposta) {
  const setCookie = resposta.headers.get('set-cookie') || '';
  return setCookie.split(';')[0] || null;
}

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });

  // Semeia o catálogo com 1 insumo Custom ("Fibra") ANTES de abrir a SPA
  // — mesmo fluxo real: Configurações → Insumos de Receitas → Adicionar.
  const respLogin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  const cookieAdmin = extrairCookie(respLogin);
  const cfgAtual = await (await fetch(`${servidor.baseUrl}/db/config.json`)).json();
  await fetch(`${servidor.baseUrl}/salvar-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ ...cfgAtual, insumos_receita: { opcoes: [{ nome: 'Fibra', categoria: 'custom' }] } }),
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

  // Preenche tudo, exceto qualquer insumo Custom (nenhum adicionado
  // ainda nesta altura) — traço fica 100% completo com só os 5 Padrão.
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
  window.LWOp.updateInsumoOriginal(0, 'densidade_insumo', '1050');
  window.LWOp.updateInsumoOriginal(0, 'flow_insumo', '210');
  await new Promise(r => setTimeout(r, 100));
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

function abaDoTraco() {
  return document.querySelector('.traco-tabs-nav .traco-tab');
}

// `state` (operacao.js) é module-scoped, não exposto em `window` — lê o
// snapshot mais recente do localStorage (persist() salva a cada mutação
// via LW.saveOperacaoAtual, ver data.js: DB_KEY_OP_CURRENT = 'lw_op_current').
function lerTracoAtual(idx = 0) {
  const raw = window.localStorage.getItem('lw_op_current');
  const op = raw ? JSON.parse(raw) : null;
  return op?.tracos?.[idx];
}

test('pré-condição: traço 100% preenchido, sem nenhum Custom, já fica "complete"', () => {
  assert.deepEqual(lerTracoAtual()?.insumos_custom ?? {}, {}, 'novo traço não deveria nascer com nenhum insumo custom');
  assert.ok(abaDoTraco().className.includes('complete'), 'traço com tudo preenchido e sem Custom deveria estar completo');
});

test('o picker do "+" só lista "Fibra" (Custom) — nunca um dos 5 Padrão', async () => {
  window.LWOp.toggleInsumoCustomPicker(0);
  await new Promise(r => setTimeout(r, 100));

  const select = document.getElementById('insumo-custom-select-0');
  assert.ok(select, 'o <select> do picker deveria existir depois de abrir');
  const opcoes = [...select.options].map(o => o.value);
  assert.deepEqual(opcoes, ['Fibra']);

  window.LWOp.toggleInsumoCustomPicker(0); // fecha de novo, sem confirmar nada
  await new Promise(r => setTimeout(r, 100));
});

test('adicionar "Fibra" via "+" torna o traço pendente até o campo ser preenchido', async () => {
  window.LWOp.toggleInsumoCustomPicker(0);
  await new Promise(r => setTimeout(r, 100));
  document.getElementById('insumo-custom-select-0').value = 'Fibra';
  window.LWOp.confirmarAdicionarInsumoCustom(0);
  await new Promise(r => setTimeout(r, 100));

  assert.ok('Fibra' in lerTracoAtual().insumos_custom, 'Fibra deveria ter entrado em insumos_custom');
  assert.ok(abaDoTraco().className.includes('pending'), 'Fibra vazia deveria tornar o traço pendente');

  window.LWOp.updateInsumoCustomOriginal(0, 'Fibra', '2.5');
  await new Promise(r => setTimeout(r, 100));
  // updateInsumoCustomOriginal não re-renderiza as abas sozinho (mesmo
  // padrão de updateInsumoOriginal) — dispara um re-render completo pra
  // conferir o status atualizado, igual o resto da suíte já faz.
  window.LWOp.selectTraco(0);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(abaDoTraco().className.includes('complete'), 'preenchido, o traço deveria voltar a "complete"');
});

test('o "x" remove "Fibra" (ainda sem ajuste) e o traço continua completo', async () => {
  const lista = document.getElementById('tracos-container').innerHTML;
  assert.ok(lista.includes('removerInsumoCustom'), 'deveria ter um botão de remover pra Fibra (sem ajuste ainda)');

  window.LWOp.removerInsumoCustom(0, 'Fibra');
  await new Promise(r => setTimeout(r, 100));

  assert.ok(!('Fibra' in (lerTracoAtual().insumos_custom || {})), 'Fibra deveria ter sido removida');
  assert.ok(abaDoTraco().className.includes('complete'), 'sem Fibra, o traço volta a ficar completo (só com os 5 Padrão)');
});

test('depois de 1 ajuste real (via modal "Ajustar Receita"), o botão de remover some', async () => {
  // Readiciona Fibra com um valor original.
  window.LWOp.toggleInsumoCustomPicker(0);
  await new Promise(r => setTimeout(r, 100));
  document.getElementById('insumo-custom-select-0').value = 'Fibra';
  window.LWOp.confirmarAdicionarInsumoCustom(0);
  window.LWOp.updateInsumoCustomOriginal(0, 'Fibra', '1');
  await new Promise(r => setTimeout(r, 100));

  // Registra um ajuste DE VERDADE (mesmo caminho de um operador real:
  // abre o modal, marca tempo de batida + preenche o campo obrigatório
  // de Fibra, salva).
  window.LWOp.abrirAjusteReceita(0);
  await new Promise(r => setTimeout(r, 150));
  document.getElementById('ar-m-up').click(); // 1 minuto de tempo de batida
  const inputsFibra = [...document.querySelectorAll('#modal-ajuste-receita input')].filter(el => el.id.startsWith('ar-custom-'));
  assert.equal(inputsFibra.length, 1, 'deveria ter exatamente 1 campo obrigatório (Fibra)');
  inputsFibra[0].value = '0.3';
  document.getElementById('ar-btn-salvar').click();
  await new Promise(r => setTimeout(r, 200));

  assert.equal(document.getElementById('modal-ajuste-receita'), null, 'modal deveria ter fechado após salvar com sucesso');
  assert.equal((lerTracoAtual().insumos_custom.Fibra.ajustes || []).length, 1, 'o ajuste deveria ter sido registrado no state');

  const lista = document.getElementById('tracos-container').innerHTML;
  assert.ok(lista.includes('Fibra'), 'o campo de Fibra deveria continuar aparecendo');
  assert.ok(!lista.includes('removerInsumoCustom'), 'com 1 ajuste já registrado, o botão de remover não deveria mais aparecer');
});

test('modal "Ajustar Receita" trata "Fibra" como opcional — salva mesmo em branco, só com tempo de batida', async () => {
  window.LWOp.abrirAjusteReceita(0);
  await new Promise(r => setTimeout(r, 150));

  const modal = document.getElementById('modal-ajuste-receita');
  assert.ok(modal, 'modal deveria ter aberto');
  assert.ok(modal.innerHTML.includes('Fibra'), 'modal deveria ter um campo pra Fibra');
  assert.ok(modal.innerHTML.includes('opcional'), 'a seção de insumos do traço deveria estar marcada como opcional, não obrigatória');
  assert.ok(!modal.innerHTML.includes('obrigatório — este traço'), 'não deveria mais existir o texto antigo de obrigatoriedade');

  // Preenche só o tempo de batida — deixa "Fibra" em branco de propósito;
  // diferente do comportamento antigo, isso NÃO deveria bloquear o salvar.
  document.getElementById('ar-m-up').click();
  document.getElementById('ar-btn-salvar').click();
  await new Promise(r => setTimeout(r, 150));

  assert.equal(document.getElementById('modal-ajuste-receita'), null, 'modal deveria ter fechado — Fibra em branco não bloqueia mais o salvar');
});
