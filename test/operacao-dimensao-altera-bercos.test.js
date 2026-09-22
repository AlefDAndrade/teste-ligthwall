// ─── test/operacao-dimensao-altera-bercos.test.js ───────────────────────────
// Pedido do usuário: ao editar a Dimensão (✏️, Registrar Operação), o
// sistema deve perguntar se isso muda o número de berços da bateria — se
// sim, pedir o novo número e aplicar como OVERRIDE só desta operação
// (state.bercos_override, operacao.js), sem nunca mexer no cadastro fixo
// da bateria em Configurações. A "Capacidade (Berços)" visível na tela e
// os cards de Painéis (recalcPaineis) precisam refletir o novo número na
// hora.
//
// Cenário de referência: bateria B7 (public/db/config.json — 20 berços,
// dimensão "9 cm"), montagem "S/P" (2 painéis por berço, ver
// LW.calcPaineis/MONTAGEM_MAP) — capacidade automática = 20 berços = 40
// painéis.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-dimensao-altera-bercos-741';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let dom;
let window;
let document;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

beforeEach(async () => {
  if (dom && dom.window) dom.window.close();
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

  // Bateria B7 (20 berços) + montagem S/P (2 painéis/berço) — mesmo setup
  // pra todos os testes deste arquivo.
  document.getElementById('op-montagem').value = 'S/P';
  document.getElementById('op-montagem').dispatchEvent(new window.Event('change', { bubbles: true }));
  document.getElementById('op-id-bateria').value = 'B7';
  document.getElementById('op-id-bateria').dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));
});

// Digita um novo valor no campo Dimensão e confirma (✏️ destrava, digita,
// ✏️/✓ confirma) — mesmo fluxo de um clique real na tela.
async function editarDimensaoPara(valor) {
  window.LWOp.editarDimensao(); // destrava o campo
  const input = document.getElementById('op-dimensao');
  input.value = valor;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.LWOp.editarDimensao(); // clique de novo = confirma (_confirmarDimensaoManual)
  await new Promise(r => setTimeout(r, 200));
}

test('capacidade automática (sem editar Dimensão): 20 berços da bateria B7, 40 painéis (S/P)', async () => {
  assert.equal(document.getElementById('op-capacidade').value, '20 berços');
  assert.equal(document.getElementById('op-paineis-total').textContent, '40');
});

test('editar Dimensão + responder "sim, mudou berços" + novo número: capacidade e painéis atualizam', async () => {
  window.LW.mostrarConfirmacao = async () => true; // "sim, mudou"
  window.LW.mostrarPrompt = async () => '8';

  await editarDimensaoPara('7,5');

  assert.equal(document.getElementById('op-capacidade').value, '8 berços (customizado)');
  assert.equal(document.getElementById('op-paineis-total').textContent, '16'); // 8 * 2 (S/P)
});

test('editar Dimensão + responder "não mudou": capacidade continua com o valor da bateria', async () => {
  window.LW.mostrarConfirmacao = async () => false; // "não, continua igual"
  let promptChamado = false;
  window.LW.mostrarPrompt = async () => { promptChamado = true; return '8'; };

  await editarDimensaoPara('7,5');

  assert.equal(promptChamado, false, 'não deveria nem perguntar o novo número se a resposta foi "não mudou"');
  assert.equal(document.getElementById('op-capacidade').value, '20 berços');
  assert.equal(document.getElementById('op-paineis-total').textContent, '40');
});

test('número de berços inválido (texto, zero, negativo) é rejeitado — pergunta de novo até vir um valor válido', async () => {
  window.LW.mostrarConfirmacao = async () => true;
  let avisos = 0;
  window.LW.mostrarAlerta = async () => { avisos++; };
  const respostas = ['abc', '0', '-3', '12'];
  let i = 0;
  window.LW.mostrarPrompt = async () => respostas[i++];

  await editarDimensaoPara('7,5');

  assert.equal(avisos, 3, 'deveria ter avisado 3 vezes (abc, 0 e -3 são inválidos)');
  assert.equal(document.getElementById('op-capacidade').value, '12 berços (customizado)');
  assert.equal(document.getElementById('op-paineis-total').textContent, '24'); // 12 * 2
});

test('cancelar o prompt do novo número mantém a capacidade original (sem override)', async () => {
  window.LW.mostrarConfirmacao = async () => true;
  window.LW.mostrarPrompt = async () => null; // cancelou

  await editarDimensaoPara('7,5');

  assert.equal(document.getElementById('op-capacidade').value, '20 berços');
  assert.equal(document.getElementById('op-paineis-total').textContent, '40');
});

test('trocar de bateria depois de um override limpa o override (volta pra capacidade da bateria nova)', async () => {
  window.LW.mostrarConfirmacao = async () => true;
  window.LW.mostrarPrompt = async () => '8';
  await editarDimensaoPara('7,5');
  assert.equal(document.getElementById('op-capacidade').value, '8 berços (customizado)');

  // B5-7,5cm tem 22 berços (public/db/config.json).
  document.getElementById('op-id-bateria').value = 'B5-7,5cm';
  document.getElementById('op-id-bateria').dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));

  assert.equal(document.getElementById('op-capacidade').value, '22 berços');
  assert.equal(document.getElementById('op-paineis-total').textContent, '44'); // 22 * 2
});

test('voltar a Dimensão pro automático (campo em branco) limpa o override também', async () => {
  window.LW.mostrarConfirmacao = async () => true;
  window.LW.mostrarPrompt = async () => '8';
  await editarDimensaoPara('7,5');
  assert.equal(document.getElementById('op-capacidade').value, '8 berços (customizado)');

  await editarDimensaoPara(''); // limpa o campo — sem bateria trocando, não deveria nem perguntar de novo
  await new Promise(r => setTimeout(r, 100));

  assert.equal(document.getElementById('op-capacidade').value, '20 berços');
  assert.equal(document.getElementById('op-paineis-total').textContent, '40');
});

test('override sobrevive a um render completo da tela (persiste no rascunho local)', async () => {
  window.LW.mostrarConfirmacao = async () => true;
  window.LW.mostrarPrompt = async () => '8';
  await editarDimensaoPara('7,5');

  const salvo = JSON.parse(window.localStorage.getItem('lw_op_current'));
  assert.equal(salvo.bercos_override, 8);
});

// BUG CORRIGIDO (relatado pelo usuário): a "bateria visual" (card Bateria
// Atual, bateria-atual.js) continuava desenhando os 20 berços cadastrados
// da B7, ignorando o override — _baCapacidadeConfigurada lia só
// `bateria.bercos`, nunca `dados.bercos_override`. O preview de painéis
// (acima) já estava certo; só o desenho da grade em si tinha ficado pra
// trás.
test('grid visual da Bateria Atual (#bateria-atual-content) redesenha com o novo número de berços', async () => {
  // Antes do override: 20 células (capacidade cadastrada de B7).
  assert.equal(
    document.querySelectorAll('#bateria-atual-content .ba-celula').length,
    20
  );

  window.LW.mostrarConfirmacao = async () => true;
  window.LW.mostrarPrompt = async () => '8';
  await editarDimensaoPara('7,5');
  await new Promise(r => setTimeout(r, 100));

  assert.equal(
    document.querySelectorAll('#bateria-atual-content .ba-celula').length,
    8,
    'a grade visual deveria ter redesenhado com 8 células, não continuar com as 20 da bateria cadastrada'
  );
});
