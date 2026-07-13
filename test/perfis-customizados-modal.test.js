// ─── test/perfis-customizados-modal.test.js ─────────────────────────────────
// Testa a PARTE VISUAL do "Criar Novo Tipo de Perfil" (ver
// public/js/perfis-customizados.js, public/partials/modal-criar-perfil.html)
// rodando a SPA de verdade num jsdom — mesmo padrão de
// test/manutencao-pagina.test.js: servidor HTTP real + Admin Master
// autenticado de verdade (as rotas de escrita exigem sessão de admin).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-modal-perfil-customizado-753';
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
      win.Chart = function () { this.destroy = () => {}; };
      win.Element.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        const headers = { ...(opts && opts.headers), Cookie: cookieAdmin };
        return fetch(absoluta, { ...opts, headers });
      };
    },
  });
  window = dom.window;
  window.sessionStorage.setItem('lw_role', 'Administrador');
  await new Promise(r => setTimeout(r, 2500));

  // AdminAuth.abrirModal() normalmente abre um modal de verdade esperando
  // a senha ser digitada por um humano — aqui já autenticamos a sessão
  // real via /verificar-senha (cookieAdmin acima, injetado em todo
  // fetch), então só precisamos que o fluxo do front chame onSuccess()
  // direto, sem esperar clique nenhum (mesmo espírito de "sessão já
  // confirmada" que a tela de verdade teria depois de logar como
  // Administrador uma vez). `AdminAuth` é `const` no topo de um script
  // clássico — não vira propriedade de `window` (só funções declaradas
  // viram), por isso o stub precisa rodar via window.eval(), no mesmo
  // escopo global da página, em vez de window.AdminAuth.abrirModal=...
  window.eval('AdminAuth.abrirModal = function(onSuccess) { if (onSuccess) onSuccess(); };');
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

test('o modal de criar perfil existe no DOM e as funções globais estão disponíveis', () => {
  assert.ok(window.document.getElementById('criar-perfil-modal'), 'modal deveria existir no DOM');
  assert.equal(typeof window.abrirCriarPerfil, 'function');
  assert.equal(typeof window.fecharCriarPerfil, 'function');
  assert.equal(typeof window.salvarPerfilCustomizado, 'function');
});

test('abrirCriarPerfil() abre o modal e renderiza o catálogo com radios "total/visualizar/ocultar"', async () => {
  await window.abrirCriarPerfil();
  const modal = window.document.getElementById('criar-perfil-modal');
  assert.equal(modal.style.display, 'flex');

  const radiosOperacao = window.document.querySelectorAll('input[name="cp-item-operacao"]');
  assert.equal(radiosOperacao.length, 3, 'deveria ter 3 opções (total/visualizar/ocultar) pro item "operacao"');
  const valores = Array.from(radiosOperacao).map(r => r.value).sort();
  assert.deepEqual(valores, ['ocultar', 'total', 'visualizar']);

  // Item sem marcação nenhuma começa em "ocultar" (padrão restritivo pra
  // perfil novo, ver lib/perfis-customizados.js).
  const ocultarMarcado = window.document.querySelector('input[name="cp-item-operacao"][value="ocultar"]');
  assert.equal(ocultarMarcado.checked, true);

  window.fecharCriarPerfil();
  assert.equal(modal.style.display, 'none');
});

test('criar um perfil pelo modal reflete no <select> de perfil e na lista de perfis customizados', async () => {
  await window.abrirCriarPerfil();

  window.document.getElementById('cp-nome').value = 'Perfil Via Modal';
  const radioOperacaoTotal = window.document.querySelector('input[name="cp-item-operacao"][value="total"]');
  radioOperacaoTotal.checked = true;

  await window.salvarPerfilCustomizado();
  await new Promise(r => setTimeout(r, 300));

  // Modal deveria ter fechado sozinho após salvar com sucesso.
  assert.equal(window.document.getElementById('criar-perfil-modal').style.display, 'none');

  // Reflete na lista de Configurações → Usuários.
  const lista = window.document.getElementById('cfg-perfis-customizados-lista');
  assert.ok(lista.innerHTML.includes('Perfil Via Modal'), 'perfil criado deveria aparecer na lista');

  // Reflete no <select> de cadastro de usuário.
  const select = window.document.getElementById('cfg-usuario-perfil');
  const opcoes = Array.from(select.options).map(o => o.textContent);
  assert.ok(opcoes.includes('Perfil Via Modal'), 'perfil criado deveria aparecer como opção no <select>');
});

test('abrirEditarPerfil() pré-preenche nome e permissões do perfil existente', async () => {
  await window.cfgRenderPerfisCustomizados();
  // _cpPerfisCustomizadosCache é `let` no topo de um script clássico —
  // não vira propriedade de `window` (diferente de função declarada),
  // então window.eval(...) é o jeito de ler essa binding de fora, no
  // mesmo escopo global da página.
  const perfilCriado = window.eval('_cpPerfisCustomizadosCache').find(p => p.nome === 'Perfil Via Modal');
  assert.ok(perfilCriado, 'perfil deveria estar no cache depois de recarregar a lista');

  await window.abrirEditarPerfil(perfilCriado.id);
  assert.equal(window.document.getElementById('cp-nome').value, 'Perfil Via Modal');
  const radioOperacaoTotal = window.document.querySelector('input[name="cp-item-operacao"][value="total"]');
  assert.equal(radioOperacaoTotal.checked, true, 'deveria vir marcado "total" pra operacao, igual foi criado');
  window.fecharCriarPerfil();
});
