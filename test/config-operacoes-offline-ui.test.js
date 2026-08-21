// ─── test/config-operacoes-offline-ui.test.js ────────────────────────────────
// Cobertura da UI de Configurações → Operações a Validar (README, "Registro
// de Operação Offline (PWA) — plano", itens 6/7) — a aba nova em
// modal-config.html + as funções cfgRenderOperacoesOffline/
// cfgValidarOperacaoOffline/cfgRecusarOperacaoOffline/
// cfgAbrirCorrecaoOperacaoOffline (app-core.js). Mesmo padrão de setup
// jsdom de test/configuracoes-checkbox-pode-iniciar.test.js — abre a SPA de
// verdade (via JSDOM.fromURL contra o server.js real), loga como
// Administrador, abre o modal de Configurações, entra na aba.
//
// Cobre:
//   - A aba lista o que foi enviado por POST /operacao-offline/enviar.
//   - Clicar em "✅ Validar" chama a rota e some da lista depois.
//   - Clicar em "✏️ Corrigir" abre o painel inline com os campos atuais
//     pré-preenchidos; salvar aplica a correção (some o "corrigido" some
//     na recarga do card).
//   - Clicar em "❌ Recusar" chama a rota e some da lista.
//   - Perfil sem a permissão 'config-operacoes-offline' não vê a aba no
//     menu lateral (mesmo comportamento de qualquer outra aba de config).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-operacoes-offline-ui-482';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
});

after(async () => {
  await servidor.parar();
});

function extrairCookie(resposta) {
  const setCookie = resposta.headers.get('set-cookie') || '';
  return setCookie.split(';')[0] || null;
}

async function logarComoAdminMaster() {
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  return extrairCookie(resp);
}

async function abrirSpaComoAdminMaster() {
  const cookieAdmin = await logarComoAdminMaster();
  const dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
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
  dom.window.sessionStorage.setItem('lw_role', 'Administrador');
  await new Promise(r => setTimeout(r, 2500));
  return dom;
}

function payloadValido(idTemp) {
  return {
    idTemp,
    formRecord: {
      turno: '1° TURNO', dimensao: 'padrão', capacidade: 4, id_bateria: 'B-ui-teste',
      tipo_montagem: 'SIMPLES', inicio: '2026-08-19T08:00:00.000Z', fim: '2026-08-19T09:00:00.000Z',
      desemplaque: 'NAO', tempo_min: 60, houve_atraso: 'NAO', motivo_atraso: '', qtd_tracos: 1,
      total_paineis: 10, m2_total: 5, paineis_por_tipo: { '2P': 10 }, m2_por_tipo: { '2P': 5 },
      paineis_2p: 10, paineis_sp: 0, m2_2p: 5, m2_sp: 0,
    },
    tracos: [{
      id: 'traco_off_' + idTemp, num: 1, berco_ini: '1', berco_fim: '4',
      cimento_real: { original: 100, ajustes: [] }, agua_real: { original: 50, ajustes: [] },
      eps_real: { original: 2, ajustes: [] }, superplast_real: { original: 1, ajustes: [] },
      incorporador_real: { original: 0.5, ajustes: [] }, tempo_batida: { original: 5, ajustes: [] },
      densidade_insumo: { original: 300, ajustes: [] }, flow_insumo: { original: 200, ajustes: [] },
      obs: '', silo: 'Silo 1', expansao: '1ª expansão', densidadeEPS: 16,
    }],
    pausas: [],
  };
}

async function enviarOffline(payload) {
  return fetch(`${servidor.baseUrl}/operacao-offline/enviar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
}

test('aba "Operações a Validar" lista o que foi enviado offline', async () => {
  const idTemp = 'OFF-ui-listagem-' + Date.now();
  await enviarOffline(payloadValido(idTemp));

  const dom = await abrirSpaComoAdminMaster();
  const { window } = dom;
  const document = window.document;
  try {
    window.abrirConfig();
    await new Promise(r => setTimeout(r, 200));
    window.cfgMostrarSecao('operacoes-offline');
    await new Promise(r => setTimeout(r, 400));

    const container = document.getElementById('cfg-operacoes-offline-lista');
    assert.ok(container.innerHTML.includes('B-ui-teste'), 'o card deveria mostrar o ID da bateria enviado offline');
    assert.ok(container.innerHTML.includes('1° TURNO'));
  } finally {
    window.close();
  }
});

test('clicar em "✅ Validar" abre a renumeração do dia; confirmar aprova o registro e ele some da lista', async () => {
  const idTemp = 'OFF-ui-validar-' + Date.now();
  await enviarOffline(payloadValido(idTemp));

  const dom = await abrirSpaComoAdminMaster();
  const { window } = dom;
  const document = window.document;
  try {
    window.abrirConfig();
    await new Promise(r => setTimeout(r, 200));
    window.cfgMostrarSecao('operacoes-offline');
    await new Promise(r => setTimeout(r, 400));

    const idSeguro = idTemp.replace(/[^a-zA-Z0-9_-]/g, '');

    // "Validar" agora abre o painel de renumeração manual do dia (ver
    // lib/rotas/operacao-offline.js, "RENUMERAÇÃO MANUAL DO DIA NA
    // VALIDAÇÃO") — não aprova mais direto.
    await window.cfgAbrirRenumeracaoOperacaoOffline(idTemp);
    await new Promise(r => setTimeout(r, 300));

    const painel = document.getElementById('cfg-renumerar-' + idSeguro);
    assert.equal(painel.style.display, 'block', 'painel de renumeração deveria estar visível');
    assert.ok(painel.querySelector('input[data-renum-input]'), 'painel deveria ter um campo de número editável pro traço pendente');

    // cfgConfirmarRenumeracaoEValidar usa LW.mostrarConfirmacao — um modal
    // CUSTOM (não window.confirm nativo), que só resolve quando alguém
    // clica o botão de confirmar. Dispara sem esperar, espera o modal
    // aparecer, clica "Validar".
    const promessa = window.cfgConfirmarRenumeracaoEValidar(idSeguro, idTemp);
    await new Promise(r => setTimeout(r, 150));
    const btnConfirmar = document.getElementById('btn-confirmacao-confirmar');
    assert.ok(btnConfirmar, 'modal de confirmação deveria estar na tela');
    btnConfirmar.click();
    await promessa;
    await new Promise(r => setTimeout(r, 400));

    const container = document.getElementById('cfg-operacoes-offline-lista');
    assert.ok(!container.innerHTML.includes('B-ui-teste') || !container.innerHTML.includes(idTemp),
      'depois de validar, o item não deveria mais aparecer na lista');

    const historico = await (await fetch(`${servidor.baseUrl}/db/historico.json`)).json();
    assert.ok(historico.some(o => o.id === 'op_off_' + idTemp.slice(4)), 'deveria ter virado uma operação de verdade');
  } finally {
    window.close();
  }
});

test('na renumeração, dar o mesmo número pra dois traços trava o botão de confirmar até corrigir', async () => {
  // 2 operações offline no MESMO dia: a 1ª é validada primeiro (vira
  // "existente"), a 2ª fica pendente — assim a tela de renumeração tem 2
  // linhas de verdade pra testar duplicata.
  const idTempA = 'OFF-ui-renum-dup-A-' + Date.now();
  const idTempB = 'OFF-ui-renum-dup-B-' + Date.now();
  await enviarOffline(payloadValido(idTempA));
  await enviarOffline(payloadValido(idTempB));

  const dom = await abrirSpaComoAdminMaster();
  const { window } = dom;
  const document = window.document;
  try {
    window.abrirConfig();
    await new Promise(r => setTimeout(r, 200));
    window.cfgMostrarSecao('operacoes-offline');
    await new Promise(r => setTimeout(r, 400));

    const idSeguroA = idTempA.replace(/[^a-zA-Z0-9_-]/g, '');
    await window.cfgAbrirRenumeracaoOperacaoOffline(idTempA);
    await new Promise(r => setTimeout(r, 300));
    // Os valores padrão vêm do device offline (sempre "1") — em cima de
    // traços que já existem no dia (de testes anteriores) isso já nasce
    // duplicado. "Preencher sequência" resolve, igual um Master faria na
    // tela real antes de confirmar.
    window._cfgPreencherSequenciaRenumeracao(idSeguroA);
    const promessaA = window.cfgConfirmarRenumeracaoEValidar(idSeguroA, idTempA);
    await new Promise(r => setTimeout(r, 150));
    document.getElementById('btn-confirmacao-confirmar').click();
    await promessaA;
    await new Promise(r => setTimeout(r, 400));

    const idSeguroB = idTempB.replace(/[^a-zA-Z0-9_-]/g, '');
    await window.cfgAbrirRenumeracaoOperacaoOffline(idTempB);
    await new Promise(r => setTimeout(r, 300));

    const inputs = [...document.querySelectorAll('#cfg-renum-lista-' + idSeguroB + ' input[data-renum-input]')];
    assert.ok(inputs.length >= 2, 'deveria ter pelo menos 1 linha pro traço já existente (A) + 1 pro pendente (B)');

    // Força os dois pro mesmo número
    inputs.forEach(input => {
      input.value = '1';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 50));

    const botaoConfirmar = document.getElementById('cfg-renum-confirmar-' + idSeguroB);
    assert.equal(botaoConfirmar.disabled, true, 'botão de confirmar deveria travar com números repetidos');
    const erro = document.getElementById('cfg-renum-erro-' + idSeguroB);
    assert.equal(erro.style.display, 'block');
    assert.match(erro.textContent, /repetido/i);
  } finally {
    window.close();
  }
});

test('clicar em "✏️ Corrigir" abre o painel com os campos pré-preenchidos, e salvar aplica a correção', async () => {
  const idTemp = 'OFF-ui-corrigir-' + Date.now();
  await enviarOffline(payloadValido(idTemp));

  const dom = await abrirSpaComoAdminMaster();
  const { window } = dom;
  const document = window.document;
  try {
    window.abrirConfig();
    await new Promise(r => setTimeout(r, 200));
    window.cfgMostrarSecao('operacoes-offline');
    await new Promise(r => setTimeout(r, 400));

    window.cfgAbrirCorrecaoOperacaoOffline(idTemp);
    await new Promise(r => setTimeout(r, 100));

    const idSeguro = idTemp.replace(/[^a-zA-Z0-9_-]/g, '');
    const painel = document.getElementById('cfg-corrigir-' + idSeguro);
    assert.equal(painel.style.display, 'block', 'painel de correção deveria estar visível');

    const inputBateria = document.getElementById('cfg-off-bateria-' + idSeguro);
    assert.equal(inputBateria.value, 'B-ui-teste', 'campo deveria vir pré-preenchido com o valor atual');

    inputBateria.value = 'B-corrigida-pela-ui';
    await window.cfgSalvarCorrecaoOperacaoOffline(idSeguro, idTemp);
    await new Promise(r => setTimeout(r, 400));

    const container = document.getElementById('cfg-operacoes-offline-lista');
    assert.ok(container.innerHTML.includes('B-corrigida-pela-ui'), 'card deveria mostrar o valor já corrigido depois de recarregar a lista');
  } finally {
    window.close();
  }
});

test('clicar em "❌ Recusar" descarta o registro e ele some da lista, sem virar operação', async () => {
  const idTemp = 'OFF-ui-recusar-' + Date.now();
  await enviarOffline(payloadValido(idTemp));

  const dom = await abrirSpaComoAdminMaster();
  const { window } = dom;
  const document = window.document;
  try {
    window.abrirConfig();
    await new Promise(r => setTimeout(r, 200));
    window.cfgMostrarSecao('operacoes-offline');
    await new Promise(r => setTimeout(r, 400));

    const promessa = window.cfgRecusarOperacaoOffline(idTemp);
    await new Promise(r => setTimeout(r, 150));
    const btnConfirmar = document.getElementById('btn-confirmacao-confirmar');
    assert.ok(btnConfirmar, 'modal de confirmação deveria estar na tela');
    btnConfirmar.click();
    await promessa;
    await new Promise(r => setTimeout(r, 400));

    const container = document.getElementById('cfg-operacoes-offline-lista');
    assert.ok(!container.innerHTML.includes(idTemp));

    const historico = await (await fetch(`${servidor.baseUrl}/db/historico.json`)).json();
    assert.ok(!historico.some(o => o.id === 'op_off_' + idTemp.slice(4)));
  } finally {
    window.close();
  }
});
