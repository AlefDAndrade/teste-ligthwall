// ─── test/manutencao-pagina.test.js ──────────────────────────────────────────
// Fase 1 da migração de Manutenção: HTML/CSS/JS extraídos do protótipo
// standalone "Etiqueta - Manutenção.html" e transformados em mais uma page
// da SPA (public/partials/page-manutencao.html), sem <iframe> — mesmo
// padrão já usado pelo Setor de Qualidade (ver page-setor-qualidade.html).
// Este teste garante que a migração não quebrou nada: a página carrega, a
// navegação entre as 5 abas internas funciona, e os dois fluxos principais
// (criar chamado corretivo, cadastrar peça no almoxarifado) funcionam ponta
// a ponta — tudo isso rodando o servidor HTTP REAL (ver
// test/helpers/servidor-teste.js), não um mock.
//
// Persistência desde a Fase 2 (ver conversa que motivou a migração) é
// backend real (SQLite via HTTP, ver lib/rotas/manutencao.js), não mais
// localStorage — os testes abaixo confirmam persistência batendo direto
// nas rotas do servidor (GET /manutencao/corretiva, GET /manutencao/estoque),
// não mais lendo localStorage do navegador.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

// Rotas de ESCRITA de Manutenção agora exigem poderes de admin ou a área
// 'manutencao'/'manutencao-chamado' de edição (modelo novo, ver
// lib/perfis.js) — sessionStorage.lw_role='Administrador' sozinho não
// basta mais (nunca bastou de verdade pro resto do sistema, ver
// app-core.js/AdminAuth), então este teste autentica uma sessão REAL de
// Admin Master no servidor e injeta o cookie em todo fetch feito de
// dentro da página, do mesmo jeito que o app de verdade faz via
// AdminAuth.abrirModal().
const SENHA_ADMIN = 'senha-admin-manutencao-pagina-000';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let dom;
let window;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
  const respAdmin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  const cookieAdmin = (respAdmin.headers.get('set-cookie') || '').split(';')[0];

  dom = await JSDOM.fromURL(servidor.baseUrl + '/index.html', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      // Chart.js vem de CDN externo — indisponível no ambiente de teste
      // (sem acesso à internet externa). Stub mínimo só pra validar o
      // resto do fluxo (renderDashboard) sem exigir o gráfico real.
      win.Chart = function (ctx, cfg) { this.destroy = () => {}; this._cfg = cfg; };
      // scrollIntoView não é implementado pelo jsdom (API puramente
      // visual) — stub vazio; roda normalmente num navegador real.
      win.Element.prototype.scrollIntoView = function () {};
      // window.fetch não é implementado pelo jsdom (só o fetch global do
      // Node, fora do window, funciona) — necessário desde a Fase 2
      // (backend real de Manutenção, ver lib/rotas/manutencao.js), que
      // faz fetch() de dentro da página pra persistir os dados. Anexa o
      // cookie da sessão real de Admin Master (autenticada acima) —
      // mesmo cookie que o navegador de verdade carrega depois de passar
      // pelo modal do AdminAuth.
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        const headers = { ...(opts && opts.headers), Cookie: cookieAdmin };
        return fetch(absoluta, { ...opts, headers });
      };
    },
  });
  window = dom.window;
  window.sessionStorage.setItem('lw_role', 'Administrador');
  // Espera o boot completo da SPA (scripts locais carregam via HTTP real
  // do servidor de teste; os externos via CDN falham nesse ambiente
  // isolado, mas não impedem o resto do boot).
  await new Promise(r => setTimeout(r, 2500));
});

after(async () => {
  // dom.window.close() é essencial aqui: a SPA carregada tem vários
  // setInterval/setTimeout de vida longa (sincronização de Bateria Atual,
  // atalhos de teclado, tour guiado, etc.) que continuam rodando dentro do
  // window do jsdom mesmo depois do teste acabar — sem fechar
  // explicitamente, esses timers mantêm o event loop do processo de teste
  // vivo, e o Node nunca sai sozinho (trava o `node --test` indefinidamente
  // até o timeout do runner). auth.test.js não tem esse problema porque
  // usa só fetch() direto nas rotas, sem carregar a SPA inteira num jsdom.
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

test('a página de Manutenção existe e MAN.init está disponível', () => {
  assert.equal(typeof window.showPage, 'function');
  assert.equal(typeof window.MAN, 'object');
  assert.equal(typeof window.MAN.init, 'function');
  assert.ok(window.document.getElementById('page-manutencao'), 'page-manutencao deveria existir no DOM');
});

test('showPage("manutencao") ativa a página sem lançar exceção', () => {
  assert.doesNotThrow(() => window.showPage('manutencao'));
  const pagina = window.document.getElementById('page-manutencao');
  assert.equal(pagina.classList.contains('active'), true);
  const abaCorretiva = window.document.getElementById('man-manutencao');
  assert.equal(abaCorretiva.classList.contains('active'), true, 'aba Corretiva deveria abrir ativa por padrão');
});

test('navegar por todas as 5 abas internas não lança exceção e cada uma ativa corretamente', async () => {
  const abas = ['programada', 'dashboard', 'pecas', 'almoxarifado', 'manutencao'];
  for (const aba of abas) {
    assert.doesNotThrow(() => window.MAN.navegar(aba), `navegar('${aba}') não deveria lançar exceção`);
    await new Promise(r => setTimeout(r, 50));
    const el = window.document.getElementById('man-' + aba);
    assert.ok(el, `elemento man-${aba} deveria existir`);
    assert.equal(el.classList.contains('active'), true, `aba ${aba} deveria estar ativa depois de navegar até ela`);
  }
});

test('criar um chamado corretivo: preencher o formulário e salvar reflete na tabela e no servidor', async () => {
  window.MAN.navegar('manutencao');
  window.novoChamado();
  await new Promise(r => setTimeout(r, 50));

  window.document.getElementById('man-manSetor').value = 'Injetora Teste';
  window.document.getElementById('man-manMaquina').value = 'M99';
  window.document.getElementById('man-manObservador').value = 'Teste Automatizado';
  window.document.getElementById('man-manAnomalia').value = 'Vazamento de óleo hidráulico';
  window.document.getElementById('man-manTipoManutencao').value = 'Mecânica';
  window.setPrioridade('ALTA');

  await window.salvarManutencao();
  await new Promise(r => setTimeout(r, 300));

  const tbody = window.document.getElementById('man-corretivaTableBody');
  assert.ok(tbody.innerHTML.includes('Injetora Teste'), 'o chamado deveria aparecer na tabela de Corretiva');
  assert.ok(tbody.innerHTML.includes('M99'), 'a máquina do chamado deveria aparecer na tabela');

  const resp = await fetch(`${servidor.baseUrl}/manutencao/corretiva`);
  const data = await resp.json();
  assert.ok(data.chamados.some(c => c.setor === 'Injetora Teste'), 'o chamado deveria persistir no servidor (GET /manutencao/corretiva)');
});

test('salvarManutencao recusa salvar sem os campos obrigatórios preenchidos', async () => {
  window.MAN.navegar('manutencao');
  window.novoChamado();
  await new Promise(r => setTimeout(r, 50));
  // Deixa tudo em branco de propósito — sem setor/máquina/observador/
  // anomalia/prioridade/tipo, a validação (ver salvarManutencao,
  // manutencao.js) deve recusar salvar ANTES de sequer chamar o servidor.
  const respAntes = await fetch(`${servidor.baseUrl}/manutencao/corretiva`);
  const totalAntes = (await respAntes.json()).chamados.length;

  await window.salvarManutencao();
  await new Promise(r => setTimeout(r, 100));

  const respDepois = await fetch(`${servidor.baseUrl}/manutencao/corretiva`);
  const totalDepois = (await respDepois.json()).chamados.length;
  assert.equal(totalDepois, totalAntes, 'não deveria adicionar nenhum registro sem os campos obrigatórios');
});

test('cadastrar uma peça no Almoxarifado reflete na tabela e no servidor', async () => {
  window.MAN.navegar('almoxarifado');
  window.abrirModalCadastroEstoque();
  await new Promise(r => setTimeout(r, 50));

  window.document.getElementById('man-estoqueCodigo').value = 'PEC-TEST-01';
  window.document.getElementById('man-estoqueNome').value = 'Rolamento de Teste';
  window.document.getElementById('man-estoqueCategoria').value = 'Mecânica';
  window.document.getElementById('man-estoqueQtdInicial').value = '10';
  window.document.getElementById('man-estoqueMinimo').value = '2';

  await window.salvarItemEstoque();
  await new Promise(r => setTimeout(r, 300));

  const almoxBody = window.document.getElementById('man-almoxarifadoBody');
  assert.ok(almoxBody.innerHTML.includes('PEC-TEST-01'), 'a peça deveria aparecer na tabela do Almoxarifado');
  assert.ok(almoxBody.innerHTML.includes('Rolamento de Teste'));

  const resp = await fetch(`${servidor.baseUrl}/manutencao/estoque`);
  const data = await resp.json();
  const peca = data.itens.find(p => p.codigo === 'PEC-TEST-01');
  assert.ok(peca, 'a peça deveria persistir no servidor (GET /manutencao/estoque)');
  assert.equal(peca.quantidade, 10, 'a quantidade inicial deveria ser exatamente 10, sem duplicar');
});

test('o menu lateral e o menu principal têm um item/card pra Manutenção', () => {
  const navItem = window.document.querySelector('.sidebar [data-page="manutencao"]');
  assert.ok(navItem, 'deveria existir um botão de navegação pra "manutencao" no sidebar');

  const menuCard = window.document.querySelector('#page-menu .menu-card[onclick*="manutencao"]');
  assert.ok(menuCard, 'deveria existir um card de atalho pra Manutenção no Menu Principal');
});
