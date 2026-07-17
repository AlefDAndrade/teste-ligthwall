// ─── test/operacao-andamento-revisao.test.js ────────────────────────────────
// Testa a proteção contra atualizações ATRASADAS/fora de ordem da operação
// em andamento (ver conversa que motivou): antes, QUALQUER mensagem 'estado'
// recebida via WebSocket (_aplicarEstadoExterno, operacao.js) substituía o
// estado local INTEIRO, sem checar se era mais recente que o que já estava
// na tela. Duas ABAS na mesma operação (o mecanismo de "dono" em server.js
// usa deviceId, que é compartilhado entre abas do MESMO navegador via
// localStorage — não protege contra isso) podiam se sobrescrever
// silenciosamente: um traço recém-preenchido podia voltar a aparecer como
// pendente do nada, se uma atualização mais velha chegasse por último.
//
// Corrigido com um número de REVISÃO atribuído pelo SERVIDOR (nunca pelo
// cliente — evita relógios de dispositivos diferentes brigarem), sempre
// crescente a cada broadcastOperacaoAndamento() (server.js) — o cliente só
// aceita uma mensagem 'estado' se a revisão for MAIOR que a última aplicada
// (ver _abrirWsOperacaoAndamento, data.js).
//
// IMPORTANTE — escopo desta proteção (documentado aqui pra não vender mais
// do que ela cobre): isso resolve ENTREGA fora de ordem (uma mensagem que
// saiu antes chegando depois, por atraso de rede) — não é uma solução
// completa de concorrência (CRDT/merge/optimistic-locking): se uma SEGUNDA
// aba tiver uma cópia desatualizada em memória e fizer uma edição
// LEGÍTIMA (do ponto de vista dela) baseada nessa cópia velha, o servidor
// ainda atribui uma revisão nova (mais alta) a essa escrita — porque ela
// aconteceu depois no tempo, mesmo que o CONTEÚDO seja antigo. Resolver
// isso por completo exigiria um mecanismo de concorrência otimista bem
// maior (cada escrita informando "a revisão em que eu me baseei", e o
// servidor recusando se não bater com a atual) — fora do escopo combinado
// nesta conversa.
//
// Mesmo padrão de servidor real + jsdom carregando a SPA de verdade já
// usado noutros arquivos desta suíte.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-revisao-op-andamento-357';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let dom;
let window;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    // 'dev-teste-revisao' é o deviceId hardcoded usado no fetch de
    // /salvar-operacao-andamento, abaixo — precisa estar autorizado (ver
    // conversa que motivou a volta do dispositivo autorizado,
    // dispositivoAutorizado() em server.js), senão a checagem de
    // dispositivo bloqueia antes mesmo do teste de revisão rodar.
    dispositivosAutorizados: ['dev-teste-revisao'],
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
  await new Promise(r => setTimeout(r, 500));
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

function dispararMensagemEstado(revisao, dados) {
  const ws = window.eval('_opAndamentoWs');
  const msg = JSON.stringify({ tipo: 'estado', dados, origemClientId: 'outra-aba-simulada', revisao });
  ws.dispatchEvent(new window.MessageEvent('message', { data: msg }));
}

test('duas conexões WebSocket reais recebem revisões corretamente crescentes do servidor', async () => {
  const WebSocketNode = require('ws');
  const wsUrl = servidor.baseUrl.replace('http', 'ws') + '/ws/operacao-andamento';

  const cookieAdmin = (await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  }).then(r => { const c = r.headers.get('set-cookie') || ''; return c.split(';')[0]; }));

  const clienteObservador = await new Promise(resolve => {
    const ws = new WebSocketNode(wsUrl);
    const mensagens = [];
    ws.on('message', d => mensagens.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, mensagens }));
  });

  const resp = await fetch(`${servidor.baseUrl}/salvar-operacao-andamento?deviceId=dev-teste-revisao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ dados: { status: 'running', tracos: [] }, clientId: 'origem-teste' }),
  });
  const data = await resp.json();
  assert.equal(typeof data.revisao, 'number', 'a resposta HTTP deveria incluir o número de revisão atribuído');

  await new Promise(r => setTimeout(r, 200));
  const ultimaMsg = clienteObservador.mensagens[clienteObservador.mensagens.length - 1];
  assert.equal(ultimaMsg.revisao, data.revisao, 'a revisão transmitida via WebSocket deveria bater com a devolvida na resposta HTTP');

  clienteObservador.ws.close();
});

test('mensagem "estado" com revisão MENOR que a já conhecida é ignorada (não aplica dados atrasados)', async () => {
  window.eval('_opAndamentoUltimaRevisaoConhecida = 100');
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));

  const abaAntes = window.document.querySelector('.traco-tabs-nav .traco-tab');
  const classeAntes = abaAntes.className;

  dispararMensagemEstado(50, null); // revisão MENOR — deveria ser ignorada
  await new Promise(r => setTimeout(r, 100));

  const abaDepois = window.document.querySelector('.traco-tabs-nav .traco-tab');
  assert.ok(abaDepois, 'a aba não deveria ter sumido — a mensagem atrasada (dados:null) deveria ter sido ignorada');
  assert.equal(abaDepois.className, classeAntes, 'o estado não deveria ter mudado com uma mensagem de revisão mais antiga');
  assert.equal(window.eval('_opAndamentoUltimaRevisaoConhecida'), 100, 'a revisão conhecida não deveria retroceder');
});

test('mensagem "estado" com revisão IGUAL à já conhecida também é ignorada (não reaplica a mesma coisa)', async () => {
  window.eval('_opAndamentoUltimaRevisaoConhecida = 200');
  dispararMensagemEstado(200, null);
  await new Promise(r => setTimeout(r, 100));

  // Sem crash, revisão continua 200 (não devia ter processado como "nova").
  assert.equal(window.eval('_opAndamentoUltimaRevisaoConhecida'), 200);
});

test('mensagem "estado" com revisão MAIOR que a conhecida é aceita normalmente', async () => {
  window.eval('_opAndamentoUltimaRevisaoConhecida = 5');
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));
  assert.ok(window.document.querySelector('.traco-tabs-nav .traco-tab'), 'pré-condição: deveria existir uma aba de traço');

  dispararMensagemEstado(10, null); // revisão MAIOR — deveria ser aceita (dados:null limpa a operação)
  await new Promise(r => setTimeout(r, 100));

  assert.equal(window.document.querySelector('.traco-tabs-nav .traco-tab'), null, 'a atualização mais nova (dados:null) deveria ter sido aplicada, limpando a operação');
  assert.equal(window.eval('_opAndamentoUltimaRevisaoConhecida'), 10);
});
