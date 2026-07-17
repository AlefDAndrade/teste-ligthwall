// ─── test/operacao-validacao-faixa-bercos.test.js ───────────────────────────
// Testa a validação da faixa de Berço Início/Fim de cada traço em
// Registrar Operação (ver _erroBercos, public/js/operacao.js), a pedido do
// usuário:
//   1. Berço início/fim precisam ser MAIORES QUE ZERO (não aceita 0 nem
//      negativo).
//   2. Berço fim não pode ser MENOR que berço início (pode ser IGUAL — um
//      traço pode cobrir só 1 berço).
//   3. O berço início de um traço não pode ser MENOR que o berço fim do
//      traço ANTERIOR — mas pode ser IGUAL, de propósito (um berço pode
//      ter ficado pela metade, dividido entre os dois traços).
//
// Cobre também o feedback visual em TEMPO REAL (borda vermelha + mensagem
// de erro inline, ver _atualizarErroBercos) — sem isso, o feedback só
// aparecia no próximo re-render completo da tela (trocar de aba, adicionar
// traço...), mesmo que o painel de pendências já soubesse do erro na hora
// (mesmo padrão de bug já visto com o ícone da aba, numa conversa
// anterior).
//
// Mesmo padrão de servidor real + jsdom carregando a SPA de verdade já
// usado nos outros arquivos de teste de operacao.js.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-validacao-bercos-628';
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
});

// Lê o estado visual (borda vermelha + mensagem) da linha de um traço.
function estadoBerco(i) {
  const linha = document.querySelectorAll('.traco-row')[i];
  const inputIni = linha.querySelector('[data-campo="berco_ini"]');
  const inputFim = linha.querySelector('[data-campo="berco_fim"]');
  const erroDiv = linha.querySelector('.traco-erro-bercos');
  return {
    iniInvalido: inputIni.classList.contains('campo-invalido'),
    fimInvalido: inputFim.classList.contains('campo-invalido'),
    mensagem: erroDiv ? erroDiv.textContent : null,
  };
}

function pendenciaFaixaBercos() {
  return Array.from(document.querySelectorAll('.pendency-item'))
    .find(el => el.textContent.includes('Faixa de berços'));
}

test('berço início = 0 é inválido, com feedback visual imediato (sem precisar de outro re-render)', async () => {
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));

  window.LWOp.updateTraco(0, 'berco_ini', '0');
  await new Promise(r => setTimeout(r, 50));

  const estado = estadoBerco(0);
  assert.equal(estado.iniInvalido, true);
  assert.match(estado.mensagem, /maior que zero/);
  assert.equal(pendenciaFaixaBercos().className.includes('ok'), false, 'a pendência deveria acusar o erro na hora');
});

test('berço início negativo é inválido', async () => {
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));

  window.LWOp.updateTraco(0, 'berco_ini', '-3');
  await new Promise(r => setTimeout(r, 50));

  assert.equal(estadoBerco(0).iniInvalido, true);
});

test('berço fim = 0 ou negativo também é inválido', async () => {
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));

  window.LWOp.updateTraco(0, 'berco_ini', '1');
  window.LWOp.updateTraco(0, 'berco_fim', '0');
  await new Promise(r => setTimeout(r, 50));

  const estado = estadoBerco(0);
  assert.equal(estado.fimInvalido, true);
  assert.match(estado.mensagem, /Berço fim precisa ser maior que zero/);
});

test('berço fim MENOR que berço início é inválido', async () => {
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));

  window.LWOp.updateTraco(0, 'berco_ini', '10');
  window.LWOp.updateTraco(0, 'berco_fim', '5');
  await new Promise(r => setTimeout(r, 50));

  const estado = estadoBerco(0);
  assert.equal(estado.iniInvalido, true);
  assert.match(estado.mensagem, /não pode ser menor que o berço início/);
});

test('berço fim IGUAL ao berço início é válido — traço cobrindo 1 berço só', async () => {
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));

  window.LWOp.updateTraco(0, 'berco_ini', '7');
  window.LWOp.updateTraco(0, 'berco_fim', '7');
  await new Promise(r => setTimeout(r, 50));

  const estado = estadoBerco(0);
  assert.equal(estado.iniInvalido, false);
  assert.equal(estado.mensagem, null);
});

test('traço seguinte: berço início MENOR que o berço fim do traço anterior é inválido', async () => {
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));
  window.LWOp.updateTraco(0, 'berco_ini', '1');
  window.LWOp.updateTraco(0, 'berco_fim', '10');
  await new Promise(r => setTimeout(r, 50));

  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));
  window.LWOp.updateTraco(1, 'berco_ini', '9'); // menor que 10 — inválido
  window.LWOp.updateTraco(1, 'berco_fim', '20');
  await new Promise(r => setTimeout(r, 50));

  const estado = estadoBerco(1);
  assert.equal(estado.iniInvalido, true);
  assert.match(estado.mensagem, /berço fim do traço anterior \(10\)/);
});

test('traço seguinte: berço início IGUAL ao berço fim do traço anterior é válido (berço dividido entre os dois)', async () => {
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));
  window.LWOp.updateTraco(0, 'berco_ini', '1');
  window.LWOp.updateTraco(0, 'berco_fim', '10');
  await new Promise(r => setTimeout(r, 50));

  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));
  window.LWOp.updateTraco(1, 'berco_ini', '10'); // igual ao fim do traço anterior — válido
  window.LWOp.updateTraco(1, 'berco_fim', '20');
  await new Promise(r => setTimeout(r, 50));

  const estado = estadoBerco(1);
  assert.equal(estado.iniInvalido, false);
  assert.equal(estado.mensagem, null);
});

test('traço seguinte: berço início MAIOR que o berço fim do traço anterior é válido (sem sobreposição)', async () => {
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));
  window.LWOp.updateTraco(0, 'berco_ini', '1');
  window.LWOp.updateTraco(0, 'berco_fim', '10');
  await new Promise(r => setTimeout(r, 50));

  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));
  window.LWOp.updateTraco(1, 'berco_ini', '11');
  window.LWOp.updateTraco(1, 'berco_fim', '20');
  await new Promise(r => setTimeout(r, 50));

  const estado = estadoBerco(1);
  assert.equal(estado.iniInvalido, false);
  assert.equal(estado.mensagem, null);
});

test('corrigir o erro faz a borda/mensagem sumirem na hora, sem precisar de outro re-render', async () => {
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));

  window.LWOp.updateTraco(0, 'berco_ini', '0');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(estadoBerco(0).iniInvalido, true, 'pré-condição: começa inválido');

  window.LWOp.updateTraco(0, 'berco_ini', '1');
  await new Promise(r => setTimeout(r, 50));

  const estado = estadoBerco(0);
  assert.equal(estado.iniInvalido, false, 'corrigido, a borda vermelha deveria sumir imediatamente');
  assert.equal(estado.mensagem, null, 'a mensagem de erro deveria sumir do DOM, não só ficar escondida');
});

test('erro de faixa de berços bloqueia "Registrar" mesmo com o resto do traço preenchido', async () => {
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));

  window.LWOp.updateTraco(0, 'berco_ini', '10');
  window.LWOp.updateTraco(0, 'berco_fim', '5'); // fim < início — inválido
  window.LWOp.updateTraco(0, 'silo', 'S1');
  window.LWOp.updateTraco(0, 'expansao', '30');
  window.LWOp.updateTraco(0, 'densidadeEPS', '15');
  window.LWOp.updateInsumoOriginal(0, 'cimento_real', '12.00');
  window.LWOp.updateInsumoOriginal(0, 'agua_real', '5.00');
  window.LWOp.updateInsumoOriginal(0, 'eps_real', '0.50');
  window.LWOp.updateInsumoOriginal(0, 'superplast_real', '0.12');
  window.LWOp.updateInsumoOriginal(0, 'incorporador_real', '0.05');
  window.LWOp.updateInsumoOriginal(0, 'tempo_batida', '180');
  window.LWOp.updateInsumoOriginal(0, 'densidade_insumo', '1200');
  window.LWOp.updateInsumoOriginal(0, 'flow_insumo', '650');
  await new Promise(r => setTimeout(r, 100));

  assert.equal(pendenciaFaixaBercos().className.includes('ok'), false, 'deveria continuar bloqueado por causa só do erro de berços');
  const abaTraco = document.querySelector('.traco-tabs-nav .traco-tab');
  assert.ok(!abaTraco.className.includes('complete'), 'o traço não deveria contar como completo com a faixa de berços inválida');
});
