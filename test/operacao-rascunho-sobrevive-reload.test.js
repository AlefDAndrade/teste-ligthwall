// ─── test/operacao-rascunho-sobrevive-reload.test.js ────────────────────────
// Pedido do usuário: nunca perder o que foi preenchido em Registrar
// Operação se a página fechar sem querer ou for atualizada.
//
// O rascunho (state inteiro) já era salvo em localStorage a cada mudança
// (ver persist(), operacao.js) — mas ao recarregar, um bug apagava esse
// rascunho de volta: o boot consulta o servidor primeiro (GET operação em
// andamento) e, quando o servidor diz "nada em andamento" (null — resposta
// normal antes de "Iniciar Injeção", não erro), o código tratava isso como
// "nada a restaurar" e chamava resetState(), jogando fora bateria, tipo de
// montagem, dimensão, turno e traços já digitados. O mesmo acontecia de
// novo poucos segundos depois, no handshake do WebSocket (o servidor
// sempre manda o estado atual ao conectar, e ele também pode vir null).
//
// Corrigido em _aplicarEstadoExterno (operacao.js): quando o servidor diz
// "nada em andamento", só usa isso pra apagar um rascunho local se ele já
// tiver sido "iniciado" (status !== 'idle') — um rascunho ainda 'idle'
// (pré-"Iniciar Injeção", nunca chegou a ser transmitido pro servidor) é
// preservado.
//
// Simula "fechar e reabrir a aba" criando uma 2ª instância jsdom com o
// localStorage da 1ª pré-populado ANTES do boot dos scripts (beforeParse) —
// só assim o localStorage já está lá quando LWOp.init() roda, igual um
// navegador real preservando dados entre reloads.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-rascunho-sobrevive-217';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
  });
});

after(async () => {
  await servidor.parar();
});

function beforeParseBase(win) {
  win.Chart = function () { this.destroy = () => {}; };
  win.HTMLElement.prototype.scrollIntoView = function () {};
  win.fetch = (url, opts) => fetch(new URL(url, win.location.href).toString(), opts);
}

// Abre a SPA com um localStorage/sessionStorage JÁ PRONTO antes de
// qualquer script rodar (beforeParse) — é o que faz esta simulação valer
// como um "fechar e reabrir a aba" de verdade, e não só reaproveitar a
// mesma instância de window.
async function abrirPagina({ opCurrent } = {}) {
  const dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      beforeParseBase(win);
      win.sessionStorage.setItem('lw_role', 'Administrador');
      win.localStorage.setItem('lw_admin_authenticated', 'true');
      if (opCurrent) win.localStorage.setItem('lw_op_current', JSON.stringify(opCurrent));
    },
  });
  const window = dom.window;
  // Espera tempo suficiente pro boot completar E o handshake do
  // WebSocket também já ter chegado (é aí que o bug original reaparecia,
  // alguns segundos DEPOIS do primeiro render correto) — ver comentário
  // grande no topo do arquivo.
  await new Promise(r => setTimeout(r, 4000));
  window.showPage('operacao');
  await new Promise(r => setTimeout(r, 300));
  return dom;
}

test('rascunho idle (pré-"Iniciar Injeção") sobrevive a fechar e reabrir a aba', async () => {
  // 1ª "aba": preenche o formulário sem iniciar a injeção.
  let dom = await abrirPagina();
  let window = dom.window;
  const doc = window.document;

  doc.getElementById('op-montagem').value = 'S/P';
  doc.getElementById('op-montagem').dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.getElementById('op-id-bateria').value = 'B7';
  doc.getElementById('op-id-bateria').dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.getElementById('op-turno').value = '2º TURNO';
  doc.getElementById('op-turno').dispatchEvent(new window.Event('change', { bubbles: true }));
  doc.getElementById('op-motivo').value = 'rascunho de teste';
  doc.getElementById('op-motivo').dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));

  const draftSalvo = window.localStorage.getItem('lw_op_current');
  assert.ok(draftSalvo, 'o rascunho deveria ter sido salvo em localStorage');
  const draftObj = JSON.parse(draftSalvo);
  assert.equal(draftObj.status, 'idle'); // nunca chegou a "Iniciar Injeção"
  assert.equal(draftObj.id_bateria, 'B7');
  window.close();

  // "Fecha e reabre a aba" — mesmo localStorage repassado.
  dom = await abrirPagina({ opCurrent: draftObj });
  window = dom.window;
  const doc2 = window.document;

  assert.equal(doc2.getElementById('op-id-bateria').value, 'B7');
  assert.equal(doc2.getElementById('op-montagem').value, 'S/P');
  assert.equal(doc2.getElementById('op-turno').value, '2º TURNO');
  assert.equal(doc2.getElementById('op-motivo').value, 'rascunho de teste');
  window.close();
});

test('um rascunho local já "running" desatualizado NÃO é ressuscitado quando o servidor diz que não há nada em andamento', async () => {
  // Simula uma aba que tinha iniciado a injeção mas cujo rascunho local
  // ficou pra trás (ex: a operação foi finalizada/assumida por OUTRO
  // dispositivo nesse meio tempo) — o servidor, fonte de verdade a
  // partir de "Iniciar Injeção", diz que não há nada em andamento agora.
  const dom = await abrirPagina({
    opCurrent: { status: 'running', id_bateria: 'B7', tipo_montagem: 'S/P', tracos: [], pausas: [] },
  });
  const window = dom.window;

  // Servidor não tem nada — a tela deveria estar em branco, não mostrando
  // a operação "running" desatualizada do localStorage.
  assert.equal(window.document.getElementById('op-id-bateria').value, '');
  assert.equal(window.document.getElementById('op-montagem').value, '');
  window.close();
});

test('quando o servidor TEM uma operação em andamento de verdade, ele vence o rascunho local (mesmo idle)', async () => {
  const respLogin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  const cookie = (respLogin.headers.get('set-cookie') || '').split(';')[0];

  // Operação de verdade "em andamento" no servidor (bateria B5-7,5cm) —
  // POST /salvar-operacao-andamento espera { dados, clientId, forcar },
  // não o state cru direto (ver LW._postOperacaoAndamento, data.js).
  const respSalvar = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      dados: {
        status: 'running', id_bateria: 'B5-7,5cm', tipo_montagem: '2/P', tracos: [], pausas: [],
        idAndamento: 'andamento-teste-' + Date.now(),
      },
      clientId: 'client-teste-rascunho',
    }),
  });
  if (respSalvar.status !== 200) throw new Error(`POST /salvar-operacao-andamento falhou (${respSalvar.status}): ${await respSalvar.text()}`);

  // Rascunho LOCAL idle, de uma bateria totalmente diferente — deveria
  // perder pro servidor, que tem prioridade a partir de "Iniciar Injeção".
  const dom = await abrirPagina({
    opCurrent: { status: 'idle', id_bateria: 'B7', tipo_montagem: 'S/P', tracos: [], pausas: [] },
  });
  const window = dom.window;

  assert.equal(window.document.getElementById('op-id-bateria').value, 'B5-7,5cm');
  window.close();

  // Limpa a operação em andamento pra não vazar pro próximo teste do arquivo.
  await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ dados: null, clientId: 'client-teste-rascunho', forcar: true }),
  });
});
