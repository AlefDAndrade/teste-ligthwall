// ─── test/insumos-dinamicos-payload-registro.test.js ────────────────────────
// BUG CORRIGIDO (relatado com prints de tela): registrando um traço com 2
// insumos Custom (original 1 em cada) + 1 ajuste ao vivo somando +3 em cada
// — o valor final devia ser 4 (1+3), mas dashboards/tabela/CEP mostravam
// só 3 (o ajuste sozinho).
//
// Causa raiz: LW.registrarRelatorioInjecao (public/js/data.js) reconstrói
// cada linha do payload campo por campo, na mão — e nunca incluía
// insumos_custom nessa lista. A função de achatar insumos_custom em
// operacao.js (Fase 5) ficava correta no objeto `fullRecord.tracos[i]`,
// mas era descartada silenciosamente aqui, antes do POST sair pro
// servidor. Os ajustes ao vivo (rota separada, /registrar-ajuste-traco)
// sempre chegavam certos — só o valor ORIGINAL nunca ia junto, por isso o
// total salvo acabava sendo só o ajuste (original tratado como 0).
//
// Este teste sobe a SPA de verdade (jsdom) e clica em "Registrar Operação"
// ponta a ponta — é o único jeito de pegar esse tipo de bug, já que a
// lógica de achatamento (operacao.js) e a montagem do payload real
// (data.js) são funções DIFERENTES, e todo teste anterior dessa feature
// testava uma ou outra isoladamente, nunca as duas juntas.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-payload-registro-609';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

test('registrar traço com 2 insumos Custom + 1 ajuste ao vivo: total salvo é original+ajuste (4), não só o ajuste (3)', async () => {
  const servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
  });

  try {
    const respLogin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha: SENHA_ADMIN }),
    });
    const cookieAdmin = (respLogin.headers.get('set-cookie') || '').split(';')[0];
    const cfgAtual = await (await fetch(`${servidor.baseUrl}/db/config.json`)).json();
    await fetch(`${servidor.baseUrl}/salvar-config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
      body: JSON.stringify({ ...cfgAtual, insumos_receita: { opcoes: [{ nome: 'Fibra', categoria: 'custom' }, { nome: 'Cerragem', categoria: 'custom' }] } }),
    });

    let payloadCapturado = null;
    let respostaCapturada = null;
    const dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
      beforeParse(win) {
        win.Chart = function () { this.destroy = () => {}; };
        win.HTMLElement.prototype.scrollIntoView = function () {};
        // jsdom não gerencia cookie jar sozinho pra esse fetch (é o fetch
        // do PRÓPRIO Node por baixo, não um fetch "de navegador de
        // verdade") — anexa o cookie de sessão manualmente em toda
        // chamada, mesmo padrão já usado noutros testes de UI desta
        // suíte (ver config-insumos-receita.test.js).
        win.fetch = async (url, opts) => {
          const absUrl = new URL(url, win.location.href).toString();
          const headers = { ...(opts && opts.headers), Cookie: cookieAdmin };
          const resp = await fetch(absUrl, { ...opts, headers });
          if (absUrl.includes('/registrar-relatorio-injecao') && opts && opts.body) {
            payloadCapturado = JSON.parse(opts.body);
            respostaCapturada = await resp.clone().text();
          }
          return resp;
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

    const selMontagem = doc.getElementById('op-montagem');
    selMontagem.value = 'S/P';
    selMontagem.dispatchEvent(new window.Event('change', { bubbles: true }));
    const selBateria = doc.getElementById('op-id-bateria');
    selBateria.value = 'B7';
    selBateria.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    window.LWOp.iniciarInjecao();
    await new Promise(r => setTimeout(r, 100));

    window.LWOp.addTraco();
    await new Promise(r => setTimeout(r, 200));
    window.LWOp.updateTraco(0, 'berco_ini', '1');
    window.LWOp.updateTraco(0, 'berco_fim', '10');
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

    // 2 insumos Custom, original = 1 em cada (exatamente o cenário relatado).
    for (const nome of ['Fibra', 'Cerragem']) {
      window.LWOp.toggleInsumoCustomPicker(0);
      await new Promise(r => setTimeout(r, 100));
      doc.getElementById('insumo-custom-select-0').value = nome;
      window.LWOp.confirmarAdicionarInsumoCustom(0);
      window.LWOp.updateInsumoCustomOriginal(0, nome, '1');
      await new Promise(r => setTimeout(r, 100));
    }

    // 1 ajuste, +3 em cada um dos 2 insumos custom.
    window.LWOp.abrirAjusteReceita(0);
    await new Promise(r => setTimeout(r, 150));
    doc.getElementById('ar-m-up').click();
    [...doc.querySelectorAll('#modal-ajuste-receita input')]
      .filter(el => el.id.startsWith('ar-custom-'))
      .forEach(input => { input.value = '3'; });
    doc.getElementById('ar-btn-salvar').click();
    await new Promise(r => setTimeout(r, 300));

    const idTraco = JSON.parse(window.localStorage.getItem('lw_op_current')).tracos[0].id;

    window.LW.mostrarConfirmacao = async () => true;
    await window.LWOp.finalizarInjecao();
    await new Promise(r => setTimeout(r, 200));

    const btnReg = doc.getElementById('btn-registrar');
    assert.equal(btnReg.disabled, false, 'botão Registrar Operação deveria estar habilitado (todas as pendências resolvidas)');
    btnReg.click();
    await new Promise(r => setTimeout(r, 600));

    // 1) O PAYLOAD que saiu pro servidor precisa ter insumos_custom com os
    // ORIGINAIS — é exatamente isso que a correção garante.
    assert.ok(payloadCapturado, 'deveria ter capturado o POST pra /registrar-relatorio-injecao');
    assert.equal(JSON.parse(respostaCapturada).ok, true, 'servidor deveria ter aceitado o registro');
    assert.deepEqual(payloadCapturado[0].insumos_custom, { 'Fibra': 1, 'Cerragem': 1 });

    // 2) O que fica salvo no servidor (e é isso que dashboards/tabela/CEP
    // leem) precisa refletir original(1) + ajuste(3) = 4, não só o
    // ajuste (3, o bug relatado).
    const tracos = await (await fetch(`${servidor.baseUrl}/db/relatorio_injecao.json`)).json();
    const salvo = tracos.find(t => t.id_traco === idTraco);
    assert.ok(salvo, 'traço deveria ter sido salvo no servidor');
    assert.deepEqual(salvo.insumos_custom.Fibra, { original: 1, ajustes: [3] });
    assert.deepEqual(salvo.insumos_custom.Cerragem, { original: 1, ajustes: [3] });
  } finally {
    await servidor.parar();
  }
});
