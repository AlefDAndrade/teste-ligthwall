// ─── test/manutencao-preenchimento-automatico.test.js ───────────────────────
// Testa os preenchimentos automáticos pedidos na conversa (formulário do
// Chamado Corretivo):
//   1. Observador — nome de quem está logado, ao abrir um chamado NOVO.
//   2. Responsável Técnico — nome de quem ACEITOU o chamado
//      (m.aceitoPor, gravado no servidor no momento do aceite).
//   3. Responsável pela Análise — nome de quem ACEITOU o pedido de peça
//      (m.pedidoPecaAceitoPor, idem).
// Nos 3 casos, é só um PONTO DE PARTIDA — se a pessoa já tiver digitado e
// salvo um nome diferente, o campo passa a carregar esse valor salvo, sem
// nunca sobrescrever o que já foi editado manualmente.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-preenchimento-auto-741';
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

async function carregarSpaComo(nomeUsuario, perfil) {
  const cookieAdmin = await logarComoAdminMaster();
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario, senha: 'senhateste1234', perfil }]),
  });
  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario, senha: 'senhateste1234' }),
  });
  const cookieUsuario = extrairCookie(respLogin);

  const dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        const headers = { ...(opts && opts.headers), Cookie: cookieUsuario };
        return fetch(absoluta, { ...opts, headers });
      };
    },
  });
  dom.window.sessionStorage.setItem('lw_role', perfil);
  // O login de verdade (feito pela própria SPA) grava isso — como aqui a
  // sessão é montada por fora (cookie injetado manualmente), precisa
  // simular esse mesmo passo, senão LW.nomeDeQuemEstaLogado() não tem de
  // onde ler o nome.
  dom.window.sessionStorage.setItem('lw_nome_usuario', nomeUsuario);
  await new Promise(r => setTimeout(r, 2500));
  return dom;
}

async function criarChamado(sufixo) {
  const cookieAdmin = await logarComoAdminMaster();
  const id = 'MAN-auto-' + sufixo + '-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({
      id, data: '2026-07-20', setor: 'Injetora Teste', maquina: 'M-auto-' + sufixo, turno: '1º TURNO',
      observador: 'Quem Abriu', prioridade: 'ALTA', anomalia: 'Anomalia de teste', tipoManutencao: 'Mecânica',
    }),
  });
  return id;
}

test('Observador vem preenchido com o nome de quem está logado, ao abrir um chamado NOVO', async () => {
  const dom = await carregarSpaComo('joao.observador.teste', 'Encarregado');
  const { window } = dom;
  try {
    window.showPage('manutencao');
    await new Promise(r => setTimeout(r, 200));
    window.novoChamado();
    await new Promise(r => setTimeout(r, 50));

    assert.equal(window.document.getElementById('man-manObservador').value, 'joao.observador.teste');
  } finally {
    window.close();
  }
});

test('Responsável Técnico vem preenchido com quem ACEITOU o chamado, logo depois do aceite', async () => {
  const id = await criarChamado('tecnico');
  const dom = await carregarSpaComo('carlos.tecnico.teste', 'Manutencao');
  const { window } = dom;
  try {
    window.showPage('manutencao');
    await new Promise(r => setTimeout(r, 200));
    window.editarManutencao(id);
    await new Promise(r => setTimeout(r, 100));

    await window.aceitarChamado();
    await new Promise(r => setTimeout(r, 300));

    assert.equal(window.document.getElementById('man-manResponsavel').value, 'carlos.tecnico.teste');
  } finally {
    window.close();
  }
});

test('Responsável pela Análise vem preenchido com quem ACEITOU o pedido de peça, logo depois do aceite', async () => {
  const id = await criarChamado('analise');
  const dom = await carregarSpaComo('marina.supervisao.teste', 'Supervisao');
  const { window } = dom;
  try {
    window.showPage('manutencao');
    await new Promise(r => setTimeout(r, 200));
    window.editarManutencao(id);
    await new Promise(r => setTimeout(r, 100));
    await window.aceitarChamado(); // Supervisão também pode aceitar o chamado em si
    await new Promise(r => setTimeout(r, 300));

    window.document.getElementById('man-manAguardandoPecas').value = 'Sim';
    window.toggleSupervisorSection();
    await window.salvarManutencao(); // precisa estar SALVO — o servidor confere chamado.aguardandoPecas antes de aceitar o pedido
    await new Promise(r => setTimeout(r, 300));
    window.editarManutencao(id);
    await new Promise(r => setTimeout(r, 100));
    await window.aceitarPedidoPeca();
    await new Promise(r => setTimeout(r, 300));

    assert.equal(window.document.getElementById('man-manRespSupervisor').value, 'marina.supervisao.teste');
  } finally {
    window.close();
  }
});

test('nome digitado manualmente e SALVO não é sobrescrito ao reabrir o chamado depois', async () => {
  const id = await criarChamado('manual');
  const dom = await carregarSpaComo('pedro.encarregado.teste', 'Encarregado');
  const { window } = dom;
  try {
    window.showPage('manutencao');
    await new Promise(r => setTimeout(r, 200));
    window.editarManutencao(id);
    await new Promise(r => setTimeout(r, 100));
    await window.aceitarChamado();
    await new Promise(r => setTimeout(r, 300));

    // Confirma o ponto de partida (nome de quem aceitou)...
    assert.equal(window.document.getElementById('man-manResponsavel').value, 'pedro.encarregado.teste');

    // ...troca por outra pessoa (quem aceitou nem sempre é quem executa
    // o serviço de verdade) e salva.
    window.document.getElementById('man-manResponsavel').value = 'Técnico Terceirizado XYZ';
    await window.salvarManutencao();
    await new Promise(r => setTimeout(r, 300));

    // Reabre do zero — precisa continuar mostrando o nome SALVO, não
    // voltar a sugerir quem aceitou.
    window.editarManutencao(id);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(window.document.getElementById('man-manResponsavel').value, 'Técnico Terceirizado XYZ');
  } finally {
    window.close();
  }
});
