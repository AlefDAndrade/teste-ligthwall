// ─── test/insumos-dinamicos-sobra-com-custom.test.js ────────────────────────
// BUG CORRIGIDO (relatado): depois do fix da trava ao "Utilizar Sobra", os
// valores dos insumos Custom vinham VAZIOS ao reaproveitar.
//
// Causa raiz: _perguntarSobraAoFinalizar(record) lia `record.tracos` — o
// fullRecord já ACHATADO pra envio ao servidor (ver finalizarInjecao, Fase
// 5), onde `insumos_custom` vira {nome: valorOriginal} (número simples —
// os ajustes já foram registrados ao vivo à parte, via
// /registrar-ajuste-traco). A sobra precisa do formato RICO
// {original, ajustes} de cada campo pra poder recarregar depois — mas
// recebia só um número simples, que `normalizarCampoInsumo`
// (_adicionarTracoDeSobra, correção anterior) corretamente reconhece como
// "não é o formato esperado" e substitui por vazio. Os 5 Padrão nunca
// tiveram esse problema porque não passam pelo achatamento (só
// insumos_custom é achatado, ver finalizarInjecao).
//
// Fix: _perguntarSobraAoFinalizar agora recebe também os traços ORIGINAIS
// (não achatados) — capturados ANTES de resetState() limpar `state` — e
// usa esses pra montar a receita salva na sobra.
//
// Este teste sobe a SPA de verdade e vai ATÉ O FIM: registra a operação,
// diz "Sim" pra guardar a sobra, confere o sobra.json salvo no servidor, e
// então reutiliza essa sobra numa operação nova, conferindo que o valor
// chega preenchido (não vazio).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-sobra-com-custom-745';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

test('sobra guardada com insumo Custom preserva {original,ajustes} e reaproveita preenchida (não vazia)', async () => {
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
      body: JSON.stringify({ ...cfgAtual, insumos_receita: { opcoes: [{ nome: 'Fibra', categoria: 'custom' }] } }),
    });

    const dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
      runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true,
      beforeParse(win) {
        win.Chart = function () { this.destroy = () => {}; };
        win.HTMLElement.prototype.scrollIntoView = function () {};
        win.fetch = async (url, opts) => {
          const absUrl = new URL(url, win.location.href).toString();
          const headers = { ...(opts && opts.headers), Cookie: cookieAdmin };
          return fetch(absUrl, { ...opts, headers });
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

    window.LWOp.toggleInsumoCustomPicker(0);
    await new Promise(r => setTimeout(r, 100));
    doc.getElementById('insumo-custom-select-0').value = 'Fibra';
    window.LWOp.confirmarAdicionarInsumoCustom(0);
    window.LWOp.updateInsumoCustomOriginal(0, 'Fibra', '2');
    await new Promise(r => setTimeout(r, 100));

    window.LW.mostrarConfirmacao = async () => true;
    await window.LWOp.finalizarInjecao();
    await new Promise(r => setTimeout(r, 200));

    const btnReg = doc.getElementById('btn-registrar');
    assert.equal(btnReg.disabled, false);
    btnReg.click();
    await new Promise(r => setTimeout(r, 700));

    // Modal "Sobra de Massa?" deveria ter aparecido (roda incondicionalmente
    // depois de qualquer registro bem-sucedido) — responde "Sim".
    const modalSobra = doc.getElementById('modal-pergunta-sobra');
    assert.ok(modalSobra, 'modal "Sobra de Massa?" deveria ter aparecido após registrar');
    doc.getElementById('btn-sobra-sim').click();
    await new Promise(r => setTimeout(r, 400));

    // Confere o sobra.json salvo no servidor — insumos_custom.Fibra
    // precisa estar no formato RICO {original, ajustes}, não um número solto.
    const sobraSalva = await (await fetch(`${servidor.baseUrl}/db/sobra.json`)).json();
    assert.ok(sobraSalva, 'sobra deveria ter sido salva');
    assert.deepEqual(
      sobraSalva.receita?.insumos_custom?.Fibra,
      { original: '2', ajustes: [] },
      'insumos_custom.Fibra na sobra precisa estar em {original,ajustes}, não achatado como número solto'
    );

    // Reaproveita a sobra — precisa vir PREENCHIDA (não vazia, o bug
    // relatado) na nova operação.
    window.LWOp.addTraco();
    await new Promise(r => setTimeout(r, 300));
    const modalUtilizar = doc.getElementById('modal-sobra-decisao');
    assert.ok(modalUtilizar, 'modal "Sobra de Traço Encontrada" deveria aparecer no próximo traço');
    doc.getElementById('btn-utilizar-sobra').click();
    await new Promise(r => setTimeout(r, 400));

    const opAtual = JSON.parse(window.localStorage.getItem('lw_op_current'));
    const tracoReaproveitado = opAtual.tracos[opAtual.tracos.length - 1];
    assert.equal(tracoReaproveitado.insumos_custom.Fibra.original, '2', 'Fibra deveria vir preenchida com o valor original (2), não vazia');

    const container = doc.getElementById('tracos-container');
    assert.ok(container.innerHTML.includes('value="2.00"'), 'campo de Fibra deveria renderizar com o valor 2.00, não vazio');
  } finally {
    await servidor.parar();
  }
});
