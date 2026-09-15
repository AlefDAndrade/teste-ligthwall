// ─── test/insumos-dinamicos-sobra-malformada.test.js ────────────────────────
// Bug relatado ("clico em Utilizar Sobra e nada acontece", sem erro visível)
// — não reproduzido com uma sobra "normal", mas a investigação achou uma
// causa raiz plausível e concreta: totalInsumo() (usada em TODO campo de
// receita, inclusive os herdados de uma sobra) acessava `insumo.ajustes`
// sem checar se era de fato um array — se um campo malformado (com
// `original` mas SEM `ajustes`) chegasse até lá, `.reduce` estourava
// "Cannot read properties of undefined", quebrando o render do traço
// inteiro no meio do caminho (sem alerta nenhum pro operador, o clique
// simplesmente "não fazia nada").
//
// Cenário mais provável de produzir um campo assim: sobra reaproveitada de
// OUTRA sobra (encadeamento) — ou qualquer dado mais antigo salvo antes de
// alguma dessas garantias existir.
//
// Corrigido em 2 camadas (defesa em profundidade):
//   1. totalInsumo(): trata `ajustes` ausente/não-array como [] em vez de
//      estourar.
//   2. _adicionarTracoDeSobra(): normaliza CADA campo de insumo (Padrão e
//      Custom) ao carregar da sobra, garantindo {original, ajustes:[]}
//      mesmo que o dado salvo esteja malformado.
//
// Este teste força exatamente o campo malformado (sem `ajustes`) que
// causava o crash, tanto num insumo Padrão quanto Custom, e confirma que
// "Utilizar Sobra" completa sem lançar erro, com o traço carregado
// corretamente (ajustes normalizado pra []).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-sobra-malformada-284';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

test('"Utilizar Sobra" não trava quando a receita salva tem um campo malformado (sem ajustes)', async () => {
  const servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });

  try {
    const respLogin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: SENHA_ADMIN }),
    });
    const cookieAdmin = (respLogin.headers.get('set-cookie') || '').split(';')[0];

    // Receita PROPOSITALMENTE malformada: cimento_real e Fibra sem
    // `ajustes` — só `original`, reproduzindo o formato que quebrava.
    const sobra = {
      ativa: true, tracoId: 'traco_sobra_malformada_1', numTraco: 9,
      operacaoOrigem: 'op-origem-malformada', flow: 5, densidade: 8,
      receita: {
        cimento_real: { original: 2 }, // sem ajustes — malformado de propósito
        agua_real: { original: 2, ajustes: [] },
        eps_real: { original: 2, ajustes: [] },
        superplast_real: { original: 2, ajustes: [] },
        incorporador_real: { original: 2, ajustes: [] },
        insumos_custom: { 'Fibra': { original: 3 } }, // também sem ajustes
        tempo_batida: { original: 60, ajustes: [] },
        silo: 'Silo 2', expansao: '2ª expansão', densidadeEPS: 3, obs: '',
      },
      data: new Date().toISOString(), status: 'ativa',
    };
    await fetch(`${servidor.baseUrl}/salvar-sobra`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
      body: JSON.stringify(sobra),
    });

    const dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
      beforeParse(win) {
        win.Chart = function () { this.destroy = () => {}; };
        win.HTMLElement.prototype.scrollIntoView = function () {};
        win.fetch = (url, opts) => {
          const absUrl = new URL(url, win.location.href).toString();
          const headers = { ...(opts && opts.headers), Cookie: cookieAdmin };
          return fetch(absUrl, { ...opts, headers });
        };
      },
    });
    const window = dom.window;
    window.sessionStorage.setItem('lw_role', 'Administrador');
    window.localStorage.setItem('lw_admin_authenticated', 'true');
    await new Promise(r => setTimeout(r, 2500));

    const errosCapturados = [];
    window.addEventListener('error', e => errosCapturados.push(e.error?.message || e.message));
    window.addEventListener('unhandledrejection', e => errosCapturados.push(e.reason?.message || String(e.reason)));

    window.showPage('operacao');
    await new Promise(r => setTimeout(r, 300));
    const doc = window.document;

    await window.LWOp.addTraco(); // deveria abrir o modal de sobra
    await new Promise(r => setTimeout(r, 300));
    const modal = doc.getElementById('modal-sobra-decisao');
    assert.ok(modal, 'modal de sobra deveria ter aparecido');

    doc.getElementById('btn-utilizar-sobra').click();
    await new Promise(r => setTimeout(r, 500));

    assert.deepEqual(errosCapturados, [], 'não deveria ter lançado nenhum erro/rejection não tratado');

    const raw = JSON.parse(window.localStorage.getItem('lw_op_current') || '{}');
    assert.equal(raw.tracos?.length, 1, 'o traço da sobra deveria ter sido adicionado ao state');
    assert.deepEqual(raw.tracos[0].cimento_real, { original: 2, ajustes: [] }, 'campo malformado deveria ter sido normalizado (ajustes: [])');
    assert.deepEqual(raw.tracos[0].insumos_custom['Fibra'], { original: 3, ajustes: [] }, 'Custom malformado também deveria ter sido normalizado');

    // O card do traço deveria ter renderizado de verdade (não travado no
    // meio do caminho) — confirma que Fibra aparece no DOM com o valor certo.
    const container = doc.getElementById('tracos-container');
    assert.ok(container.innerHTML.includes('Fibra'), 'campo de Fibra deveria ter renderizado no DOM');
    assert.ok(container.innerHTML.includes('value="2.00"'), 'cimento (malformado, normalizado) deveria renderizar com o valor certo');

    window.close();
  } finally {
    await servidor.parar();
  }
});
