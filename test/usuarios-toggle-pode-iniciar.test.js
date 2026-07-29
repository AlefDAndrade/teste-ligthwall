// ─── test/usuarios-toggle-pode-iniciar.test.js ──────────────────────────────
// Cobre o novo toggle switch de "Pode iniciar/encerrar operações em
// Registrar Operação" que aparece embaixo de cada usuário JÁ CADASTRADO na
// lista de Configurações → Usuários (cfgRenderUsuarios/
// cfgToggleIniciarOperacao, app-core.js) — antes, essa marcação só existia
// no formulário de "Adicionar Usuário", sem jeito de mudar depois de criado
// sem remover e recadastrar.
//
// Mesmo padrão de test/perfis-customizados-modal.test.js: servidor HTTP
// real + Admin Master autenticado de verdade + AdminAuth.abrirModal()
// stubado pra não esperar clique humano nenhum.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-teste-toggle-pode-iniciar-951';
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

  // Semeia dois usuários direto via /salvar-usuarios: um com perfil que TEM
  // controle de operação (OperadorInjetora) e outro sem (Administrativo) —
  // pra confirmar que o toggle só aparece pro primeiro.
  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([
      { nomeUsuario: 'joao.operador', senha: 'senha1234', perfil: 'OperadorInjetora', podeIniciarOperacao: false },
      { nomeUsuario: 'maria.admin', senha: 'senha1234', perfil: 'Administrativo', podeIniciarOperacao: false },
    ]),
  });

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
  window.eval('AdminAuth.abrirModal = function(onSuccess) { if (onSuccess) onSuccess(); };');

  window.abrirConfig();
  await new Promise(r => setTimeout(r, 200));
  window.cfgMostrarSecao('usuarios');
  await new Promise(r => setTimeout(r, 400));
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

function linhaDoUsuario(nomeUsuario) {
  const spans = Array.from(window.document.querySelectorAll('#cfg-usuarios-lista > div'));
  return spans.find(div => div.textContent.includes(nomeUsuario));
}

test('usuário com perfil com controle de operação mostra o toggle switch na lista; perfil sem controle não mostra', () => {
  const linhaOperador = linhaDoUsuario('joao.operador');
  const linhaAdmin = linhaDoUsuario('maria.admin');

  assert.ok(linhaOperador, 'linha do joao.operador deveria existir na lista');
  assert.ok(linhaAdmin, 'linha da maria.admin deveria existir na lista');

  const toggleOperador = linhaOperador.querySelector('input[type="checkbox"]');
  const toggleAdmin = linhaAdmin.querySelector('input[type="checkbox"]');

  assert.ok(toggleOperador, 'OperadorInjetora tem controle de operação — toggle deveria aparecer');
  assert.equal(toggleAdmin, null, 'Administrativo não tem controle de operação — toggle não deveria aparecer');
  assert.equal(toggleOperador.checked, false, 'começa desmarcado (seedado como podeIniciarOperacao: false)');
});

test('clicar no toggle liga "Pode iniciar/encerrar operações", persiste no backend e sobrevive a um novo carregamento da lista', async () => {
  let linha = linhaDoUsuario('joao.operador');
  let toggle = linha.querySelector('input[type="checkbox"]');

  toggle.checked = true;
  toggle.dispatchEvent(new window.Event('change'));
  await new Promise(r => setTimeout(r, 400));

  // cfgToggleIniciarOperacao chama cfgRenderUsuarios() no final, que
  // recarrega a lista inteira do servidor (GET /usuarios) — então
  // reconsultamos o DOM (a linha antiga pode ter sido substituída).
  linha = linhaDoUsuario('joao.operador');
  toggle = linha.querySelector('input[type="checkbox"]');
  assert.equal(toggle.checked, true, 'toggle deveria continuar marcado após o re-render');

  const resp = await window.fetch('/usuarios');
  const json = await resp.json();
  const usuario = json.usuarios.find(u => u.nomeUsuario === 'joao.operador');
  assert.equal(usuario.podeIniciarOperacao, true, 'backend deveria ter persistido podeIniciarOperacao: true');
});

test('desligar o toggle desativa "Pode iniciar/encerrar operações" de novo', async () => {
  let linha = linhaDoUsuario('joao.operador');
  let toggle = linha.querySelector('input[type="checkbox"]');
  assert.equal(toggle.checked, true, 'pré-condição: deveria continuar ligado do teste anterior');

  toggle.checked = false;
  toggle.dispatchEvent(new window.Event('change'));
  await new Promise(r => setTimeout(r, 400));

  const resp = await window.fetch('/usuarios');
  const json = await resp.json();
  const usuario = json.usuarios.find(u => u.nomeUsuario === 'joao.operador');
  assert.equal(usuario.podeIniciarOperacao, false, 'backend deveria ter persistido podeIniciarOperacao: false depois de desligar');
});
