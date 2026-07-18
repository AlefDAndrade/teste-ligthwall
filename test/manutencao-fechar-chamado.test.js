// ─── test/manutencao-fechar-chamado.test.js ─────────────────────────────────
// Regressão de um bug real: o botão de fechar chamado já era escondido
// corretamente pra perfis sem a área 'manutencao' completa (ver
// data-manut-area="manutencao", lib/perfis.js) em vários pontos — mas a
// função aoMudarSituacao() (disparada quando o campo "Situação" muda pra
// "Concluído") reexibia o botão sem checar permissão nenhuma. Resultado:
// alguém sem a área 'manutencao' completa via o botão reaparecer ao marcar
// Situação como Concluído, clicava, e só descobria que não tinha permissão
// depois de tomar um erro do servidor.
//
// Desde a reestruturação em assistente por etapas (ver conversa que
// motivou a mudança: fluxo pouco claro), o botão de fechar não é mais um
// elemento fixo — vive dentro da 4ª etapa do assistente ("Fechamento"),
// montada dinamicamente por _manRenderizarFechamento() (manutencao.js)
// toda vez que essa etapa fica visível. Este teste cobre a MESMA garantia
// de permissão, agora nesse novo lugar: aoMudarSituacao() não faz a etapa
// de Fechamento oferecer o botão pra quem não pode fechar
// (AssistenteQualidade — hoje o único perfil cadastrável sem NENHUMA área
// de manutenção, ver PERFIS em lib/perfis.js), mas continua oferecendo
// normalmente pra quem pode (Manutencao) — e a segunda camada de proteção
// em abrirModalFechamento() bloqueia a abertura do modal mesmo se o botão
// for acionado de outro jeito.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-fechar-chamado-963';
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
  await new Promise(r => setTimeout(r, 2500));
  return dom;
}

// Cria um chamado de verdade direto pela rota (como Admin, que sempre
// pode) — não dá pra criar pela SPA logado como AssistenteQualidade, que
// nem tem a área 'manutencao-chamado' pra abrir chamado nenhum (é
// justamente o perfil usado no primeiro teste, abaixo). Any perfil pode
// LER (rotas GET são livres), então dá pra reabrir esse chamado depois
// login como qualquer perfil, só pra checar a etapa de Fechamento.
async function criarChamado(sufixo) {
  const cookieAdmin = await logarComoAdminMaster();
  const id = 'MAN-fechar-' + sufixo + '-' + Date.now();
  await fetch(`${servidor.baseUrl}/manutencao/corretiva`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({
      id, data: '2026-07-18', setor: 'Injetora Teste', maquina: 'M-fechar-' + sufixo, turno: '1º TURNO',
      observador: 'Teste Automatizado', prioridade: 'ALTA', anomalia: 'Anomalia de teste', tipoManutencao: 'Mecânica',
    }),
  });
  return id;
}

test('AssistenteQualidade (sem nenhuma área de manutenção): etapa Fechamento NÃO oferece o botão de fechar ao marcar Situação como Concluído', async () => {
  const id = await criarChamado('q');
  const dom = await carregarSpaComo('qualidade.fechar.teste', 'AssistenteQualidade');
  const { window } = dom;

  try {
    window.showPage('manutencao');
    await new Promise(r => setTimeout(r, 200));
    window.editarManutencao(id);
    await new Promise(r => setTimeout(r, 100));

    const situacaoSelect = window.document.getElementById('man-manSituacao');
    situacaoSelect.value = 'Concluido';
    window.aoMudarSituacao();
    window._manIrParaStep('fechamento');

    const conteudo = window.document.getElementById('man-fechamentoConteudo');
    assert.ok(!conteudo.innerHTML.includes('man-btn-warning'), 'a etapa Fechamento não deveria oferecer o botão de fechar pra quem não tem área manutencao');
    assert.ok(conteudo.innerHTML.toLowerCase().includes('não pode fechar'), 'deveria explicar que o perfil não pode fechar chamados de manutenção');

    // Segunda camada: mesmo chamando abrirModalFechamento() diretamente
    // (simula alguém forçando o clique de outro jeito), o modal não abre.
    window.abrirModalFechamento();
    assert.equal(window.document.getElementById('man-modalFechamento').style.display, 'none', 'modal de fechamento não deveria abrir pra quem não tem permissão');
  } finally {
    window.close();
  }
});

test('Manutencao (com área manutencao completa): etapa Fechamento oferece o botão normalmente ao marcar Situação como Concluído', async () => {
  const id = await criarChamado('m');
  const dom = await carregarSpaComo('manutencao.fechar.teste', 'Manutencao');
  const { window } = dom;

  try {
    window.showPage('manutencao');
    await new Promise(r => setTimeout(r, 200));
    window.editarManutencao(id);
    await new Promise(r => setTimeout(r, 100));

    const situacaoSelect = window.document.getElementById('man-manSituacao');
    situacaoSelect.value = 'Concluido';
    window.aoMudarSituacao();
    window._manIrParaStep('fechamento');

    const conteudo = window.document.getElementById('man-fechamentoConteudo');
    assert.ok(conteudo.innerHTML.includes('man-btn-warning'), 'a etapa Fechamento deveria oferecer o botão de fechar pra quem tem a área manutencao completa');

    // A segunda camada de proteção não deveria bloquear quem TEM permissão.
    assert.equal(window.eval("_perfilPodeEditar('manutencao')"), true);
  } finally {
    window.close();
  }
});

// ─── Botão "Salvar Chamado" — visibilidade por etapa ────────────────────────
// Regressão de outro bug real: a visibilidade do botão era calculada 1x só,
// quando o chamado era aberto ("tem algo editável em QUALQUER seção do
// formulário?") — nunca recalculada ao trocar de etapa no assistente. Quem
// podia editar Abertura via o botão SEMPRE visível, em toda etapa (inclusive
// "Fechamento", que já tem seu próprio botão dedicado) — dando a impressão
// de "o botão fica aparecendo o tempo todo" (ver conversa que motivou isso).
// Agora _manPodeSalvarNaEtapaAtual() (manutencao.js) é recalculada toda vez
// que a etapa muda (_manAplicarStepAtual()), olhando só pra etapa ATUAL.
test('botão "Salvar Chamado" só aparece na etapa onde há algo editável — some em "Fechamento", reaparece ao voltar pra "Abertura"', async () => {
  const id = await criarChamado('wizard-btn');
  const dom = await carregarSpaComo('encarregado.wizardbtn.teste', 'Encarregado');
  const { window } = dom;

  try {
    window.showPage('manutencao');
    await new Promise(r => setTimeout(r, 200));
    window.editarManutencao(id);
    await new Promise(r => setTimeout(r, 100));

    const btnSalvar = window.document.getElementById('man-btnSalvarManutencao');
    // offsetParent/offsetWidth não são confiáveis no JSDOM (não faz layout
    // de verdade — sempre null/0 independente do CSS real); o que reflete
    // o que o navegador realmente decidiria é o display computado.
    const visivel = () => window.getComputedStyle(btnSalvar).display !== 'none';

    window._manIrParaStep('abertura');
    assert.equal(visivel(), true, 'Encarregado pode editar Abertura — botão deveria aparecer');

    window.document.getElementById('man-manSituacao').value = 'Concluido';
    window._manIrParaStep('execucao');
    window.aoMudarSituacao();
    window._manIrParaStep('fechamento');
    assert.equal(visivel(), false, 'etapa Fechamento tem botão próprio — "Salvar Chamado" não deveria aparecer aqui');

    window._manIrParaStep('abertura');
    assert.equal(visivel(), true, 'voltando pra Abertura, o botão deveria reaparecer');
  } finally {
    window.close();
  }
});
