// ─── test/operacao-andamento-finalizar-retry.test.js ────────────────────────
// Cobre o lado CLIENTE do mesmo cenário de test/operacao-andamento-limpeza-
// condicional.test.js (rede cai bem na hora de encerrar a operação): o
// aviso "melhor esforço" de LW.finalizarOperacaoAndamento(idAndamento) (ver
// public/js/data.js) falha por falta de rede, mas não pode ficar esquecido
// pra sempre — precisa entrar numa fila própria de retry (localStorage) e
// ser tentado de novo automaticamente na próxima vez que
// LW.tentarSincronizarFilaPendentes() rodar (evento 'online', checagem
// periódica, ou ao carregar a página — ver o final de data.js).
//
// Não depende de o dispositivo estar autorizado a controlar operação de
// verdade: _tentarFinalizarOperacaoAndamento só distingue "falha de REDE"
// (fetch lança, ex: TypeError, sem internet) de "o pedido chegou no
// servidor" (200, 403, o que for) — só o primeiro caso deve continuar na
// fila de retry. Por isso simulamos a queda de rede sobrescrevendo
// window.fetch pra lançar seletivamente, em vez de precisar montar sessão
// de admin + dispositivo autorizado.
//
// Mesmo padrão de servidor real + jsdom carregando a SPA de verdade
// (ver test/operacao-andamento-revisao.test.js).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const CHAVE_FILA_FINALIZAR = 'lw_operacoes_andamento_a_finalizar';

let servidor;
let dom;
let window;
let redeCaida = false;

before(async () => {
  servidor = await iniciarServidorDeTeste();
  dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      // Deixa passar tudo por padrão (bootstrap do deviceId, etc.), mas
      // derruba especificamente /salvar-operacao-andamento quando
      // `redeCaida` estiver true — é o "caiu a rede bem na hora de
      // encerrar" do cenário real.
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        if (redeCaida && absoluta.includes('/salvar-operacao-andamento')) {
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return fetch(absoluta, opts);
      };
    },
  });
  window = dom.window;
  await new Promise(r => setTimeout(r, 1500));
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

function lerFilaFinalizarNoLocalStorage() {
  const raw = window.localStorage.getItem(CHAVE_FILA_FINALIZAR);
  return raw ? JSON.parse(raw) : [];
}

test('finalizarOperacaoAndamento, sem rede, guarda o idAndamento numa fila de retry (não perde a informação)', async () => {
  window.localStorage.removeItem(CHAVE_FILA_FINALIZAR);
  redeCaida = true;

  await window.eval("LW.finalizarOperacaoAndamento('and_offline_teste_1')");
  await new Promise(r => setTimeout(r, 100));

  const fila = lerFilaFinalizarNoLocalStorage();
  assert.deepEqual(fila, ['and_offline_teste_1'], 'o idAndamento deveria ter sido guardado pra tentar de novo depois');
});

test('finalizarOperacaoAndamento não duplica o mesmo idAndamento na fila em tentativas repetidas', async () => {
  window.localStorage.setItem(CHAVE_FILA_FINALIZAR, JSON.stringify(['and_ja_pendente']));
  redeCaida = true;

  await window.eval("LW.finalizarOperacaoAndamento('and_ja_pendente')");
  await new Promise(r => setTimeout(r, 100));

  assert.deepEqual(lerFilaFinalizarNoLocalStorage(), ['and_ja_pendente']);
});

test('tentarSincronizarFilaPendentes(), quando a rede volta, esvazia a fila de avisos de encerramento pendentes', async () => {
  window.localStorage.setItem(CHAVE_FILA_FINALIZAR, JSON.stringify(['and_offline_teste_1', 'and_offline_teste_2']));
  redeCaida = false; // rede "voltou"

  await window.eval('LW.tentarSincronizarFilaPendentes()');
  await new Promise(r => setTimeout(r, 200));

  assert.deepEqual(lerFilaFinalizarNoLocalStorage(), [], 'com a rede de volta, os dois avisos pendentes deveriam ter sido enviados e removidos da fila');
});

test('tentarSincronizarFilaPendentes(), ainda sem rede, mantém os itens na fila (não perde nem trava)', async () => {
  window.localStorage.setItem(CHAVE_FILA_FINALIZAR, JSON.stringify(['and_continua_offline']));
  redeCaida = true;

  await window.eval('LW.tentarSincronizarFilaPendentes()');
  await new Promise(r => setTimeout(r, 200));

  assert.deepEqual(lerFilaFinalizarNoLocalStorage(), ['and_continua_offline'], 'sem rede ainda, o item deveria continuar na fila pra tentar depois');
  redeCaida = false;
});

test('finalizarOperacaoAndamento SEM idAndamento (compatibilidade) não mexe na fila de retry', async () => {
  window.localStorage.removeItem(CHAVE_FILA_FINALIZAR);
  redeCaida = false;

  await window.eval('LW.finalizarOperacaoAndamento(null)');
  await new Promise(r => setTimeout(r, 100));

  assert.deepEqual(lerFilaFinalizarNoLocalStorage(), [], 'sem idAndamento, não há o que colocar na fila de retry — cai no comportamento antigo');
});
