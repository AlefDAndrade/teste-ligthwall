// ─── test/operacao-registro-final-respeita-override-bercos.test.js ─────────
// BUG CORRIGIDO (relatado pelo usuário): o override de berços definido ao
// editar a Dimensão (ver test/operacao-dimensao-altera-bercos.test.js)
// atualizava corretamente o PREVIEW em tela (Capacidade + cards de
// Painéis, via recalcPaineis) — mas o registro FINAL, salvo de verdade no
// banco ao clicar "Registrar Operação", recalculava tudo de novo em cima
// de `bateria.bercos` (o número CADASTRADO da bateria), direto, sem
// nenhuma noção do override. Resultado: a pessoa via 8 berços/16 painéis
// na tela inteira a operação, mas o que ia pro histórico era 20
// berços/40 painéis — desfazendo o override bem na hora que mais
// importava.
//
// Causa raiz: _registrarOperacaoInterna (operacao.js) tinha sua PRÓPRIA
// leitura de `bateria?.bercos || 0`, independente de recalcPaineis() —
// corrigido pra usar o mesmo _capacidadeAtual() usado em todo o resto.
//
// Sobe a SPA de verdade (jsdom) e clica em "Registrar Operação" ponta a
// ponta — só assim se pega esse tipo de bug (recalcPaineis e
// _registrarOperacaoInterna são funções DIFERENTES, cada teste unitário
// anterior testava uma ou outra isoladamente, nunca as duas juntas).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-registro-final-override-bercos-828';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

test('registro final (histórico + banco) usa a capacidade do OVERRIDE, não o número cadastrado da bateria', async () => {
  const servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
  });

  let dom;
  try {
    // POST /registrar-operacao exige sessão real (podeControlarOperacao,
    // ver lib/permissoes-area.js) — o flag lw_admin_authenticated do
    // localStorage não basta sozinho, precisa do cookie de
    // /verificar-senha anexado em TODA chamada (jsdom não tem cookie jar
    // de navegador de verdade aqui, é o fetch do próprio Node por baixo).
    const respLogin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: SENHA_ADMIN }),
    });
    const cookieAdmin = (respLogin.headers.get('set-cookie') || '').split(';')[0];

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
    const window = dom.window;
    window.sessionStorage.setItem('lw_role', 'Administrador');
    window.localStorage.setItem('lw_admin_authenticated', 'true');
    window.localStorage.setItem('lw_device_id', DEVICE_ID_TESTE_PADRAO);
    await new Promise(r => setTimeout(r, 2500));

    window.showPage('operacao');
    await new Promise(r => setTimeout(r, 300));
    const doc = window.document;

    // Bateria B7 (public/db/config.json — 20 berços, "9 cm") + montagem
    // S/P (2 painéis/berço).
    doc.getElementById('op-montagem').value = 'S/P';
    doc.getElementById('op-montagem').dispatchEvent(new window.Event('change', { bubbles: true }));
    doc.getElementById('op-id-bateria').value = 'B7';
    doc.getElementById('op-id-bateria').dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    assert.equal(doc.getElementById('op-capacidade').value, '20 berços');

    // Edita a Dimensão -> "sim, mudou berços" -> 8 — mesmo fluxo de
    // test/operacao-dimensao-altera-bercos.test.js.
    window.LW.mostrarConfirmacao = async () => true;
    window.LW.mostrarPrompt = async () => '8';
    window.LWOp.editarDimensao();
    doc.getElementById('op-dimensao').value = '7,5';
    doc.getElementById('op-dimensao').dispatchEvent(new window.Event('input', { bubbles: true }));
    window.LWOp.editarDimensao();
    await new Promise(r => setTimeout(r, 200));

    assert.equal(doc.getElementById('op-capacidade').value, '8 berços (customizado)');
    assert.equal(doc.getElementById('op-paineis-total').textContent, '16'); // preview já OK antes da correção

    window.LWOp.iniciarInjecao();
    await new Promise(r => setTimeout(r, 100));

    window.LWOp.addTraco();
    await new Promise(r => setTimeout(r, 200));
    // Berço fim (5) dentro da capacidade OVERRIDADA (8) — se o bug
    // persistisse (validando contra os 20 originais), isto passaria batido
    // de qualquer forma; o que importa aqui é o valor GRAVADO no final.
    window.LWOp.updateTraco(0, 'berco_ini', '1');
    window.LWOp.updateTraco(0, 'berco_fim', '5');
    window.LWOp.updateTraco(0, 'silo', 'Silo 2');
    window.LWOp.updateTraco(0, 'expansao', '1ª expansão');
    window.LWOp.updateTraco(0, 'densidadeEPS', '5');
    window.LWOp.updateInsumoOriginal(0, 'cimento_real', '3');
    window.LWOp.updateInsumoOriginal(0, 'agua_real', '3');
    window.LWOp.updateInsumoOriginal(0, 'eps_real', '3');
    window.LWOp.updateInsumoOriginal(0, 'superplast_real', '3');
    window.LWOp.updateInsumoOriginal(0, 'incorporador_real', '3');
    window.LWOp.updateInsumoOriginal(0, 'tempo_batida', '180');
    window.LWOp.updateInsumoOriginal(0, 'densidade_insumo', '8');
    window.LWOp.updateInsumoOriginal(0, 'flow_insumo', '5');
    await new Promise(r => setTimeout(r, 100));

    await window.LWOp.finalizarInjecao();
    await new Promise(r => setTimeout(r, 200));

    const btnReg = doc.getElementById('btn-registrar');
    assert.equal(btnReg.disabled, false, 'botão Registrar Operação deveria estar habilitado');
    btnReg.click();
    await new Promise(r => setTimeout(r, 600));

    const historico = await fetch(`${servidor.baseUrl}/db/historico.json`).then(r => r.json());
    // A mais recente é a que acabamos de registrar (id começa com "op_").
    const registrada = historico.find(o => String(o.id).startsWith('op_'));
    assert.ok(registrada, 'a operação deveria ter sido registrada e aparecer no histórico');

    // O CERNE do bug: sem a correção, isto viria 20/40 (bateria.bercos
    // direto), não 8/16 (o override).
    assert.equal(registrada.capacidade, 8, 'capacidade salva deveria ser o override (8), não o cadastro da bateria (20)');
    assert.equal(registrada.total_paineis, 16, 'total de painéis salvo deveria refletir os 8 berços do override (8*2), não 40');
  } finally {
    if (dom && dom.window) dom.window.close();
    await servidor.parar();
  }
});
