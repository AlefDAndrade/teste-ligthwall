// ─── test/boot-tela-carregamento.test.js ────────────────────────────────────
// Testa a tela de carregamento pós-login (div#boot-loading-overlay,
// index.template.html + _finalizarBootUI, app-core.js).
//
// Antes, a "tela de carregamento" só existia na página de LOGIN
// (login.html) e era puramente cosmética: uma barra que enchia sozinha em
// timers fixos (300ms/700ms/1000ms) e então navegava pra index.html, sem
// nenhuma relação com o estado real da página de destino — dava pra cair
// em index.html e encontrar a navegação/topbar ainda não prontas.
//
// Agora index.html tem sua PRÓPRIA tela de carregamento, visível desde a
// primeira pintura (antes de qualquer JS rodar), e ela só desaparece
// quando o boot confirma que a navegação (menu, com permissões já
// aplicadas) e as informações da topbar (nome, perfil) estão prontas de
// verdade (ver _finalizarBootUI, chamada no fim do boot em app-core.js).
// Tem também uma rede de segurança: se o boot travar (rede caiu no meio),
// a tela some sozinha depois de alguns segundos de qualquer jeito.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-boot-loading-741';
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

// Espera até `condicao()` retornar algo truthy, checando a cada 100ms, ou
// desiste depois de `timeoutMs`.
async function esperarAte(condicao, timeoutMs) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    if (condicao()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return condicao();
}

test('o HTML de index.html já nasce com a tela de carregamento visível (classe "active"), antes de qualquer JS rodar', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const resp = await fetch(`${servidor.baseUrl}/index.html`, { headers: { Cookie: cookieAdmin } });
  const html = await resp.text();
  const trecho = html.slice(
    html.indexOf('id="boot-loading-overlay"') - 60,
    html.indexOf('id="boot-loading-overlay"') + 60,
  );
  assert.ok(html.includes('id="boot-loading-overlay"'), 'a tela de carregamento precisa estar no HTML');
  assert.ok(trecho.includes('loading-overlay active'), 'precisa estar com a classe "active" já no HTML estático (sem depender de JS pra aparecer)');
});

test('a tela de carregamento só some depois que a navegação (menu) e a topbar (perfil/nome) já estão prontas', async () => {
  const cookieAdmin = await logarComoAdminMaster();
  const respCriar = await fetch(`${servidor.baseUrl}/criar-perfil-customizado`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ nome: 'Perfil Boot Loading', permissoes: { operacao: 'total', paradas: 'total' } }),
  });
  const { perfil } = await respCriar.json();

  await fetch(`${servidor.baseUrl}/salvar-usuarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify([{ nomeUsuario: 'usuario.boot.loading', senha: 'senhateste1234', perfil: perfil.id }]),
  });

  const respLogin = await fetch(`${servidor.baseUrl}/login-usuario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nomeUsuario: 'usuario.boot.loading', senha: 'senhateste1234' }),
  });
  const dataLogin = await respLogin.json();
  assert.equal(respLogin.status, 200);
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
  const { window } = dom;
  window.sessionStorage.setItem('lw_role', dataLogin.perfil);
  // login.html "de verdade" também seta isto antes de navegar pra
  // index.html (ver POST /login-usuario ali) — sem isso, o badge de nome
  // no topbar (LW.nomeDeQuemEstaLogado(), data.js) nunca teria o que
  // mostrar, e o teste ficaria esperando a topbar "ficar pronta" pra
  // sempre por um motivo que não tem nada a ver com a tela de
  // carregamento em si.
  window.sessionStorage.setItem('lw_nome_usuario', dataLogin.nomeUsuario);
  window.sessionStorage.setItem('lw_pode_iniciar_operacao', dataLogin.podeIniciarOperacao ? 'true' : 'false');

  try {
    // Logo depois de setar a sessão, ANTES do boot (DOMContentLoaded já
    // disparou no load do JSDOM, mas os fetches assíncronos de sessão/
    // permissões ainda não voltaram) — a tela de carregamento deveria
    // continuar visível. Checa bem cedo, sem esperar nada.
    const overlayLogoDepois = window.document.getElementById('boot-loading-overlay');
    assert.ok(overlayLogoDepois, 'overlay deveria existir logo no início');

    const ficouPronto = await esperarAte(() => {
      const overlay = window.document.getElementById('boot-loading-overlay');
      const escondida = !overlay || !overlay.classList.contains('active');
      const roleEl = window.document.getElementById('topbar-role');
      const nomeEl = window.document.getElementById('topbar-nome-usuario');
      const topbarPronta = !!(roleEl && roleEl.textContent && nomeEl && nomeEl.textContent.includes('usuario.boot.loading'));
      return escondida && topbarPronta;
    }, 6000);

    assert.ok(ficouPronto, 'depois do boot, a tela de carregamento deveria ter sumido E a topbar deveria estar preenchida — as duas coisas, juntas');

    // Navegação também precisa estar de fato pronta nesse momento: o
    // menu lateral reflete as permissões do perfil (só "Registrar
    // Operação" e "Paradas" liberados, o resto escondido).
    const itemOperacao = window.document.querySelector('.nav-item[data-page="operacao"]');
    assert.ok(itemOperacao && itemOperacao.style.display !== 'none', 'item de menu permitido deveria estar visível quando a tela de carregamento some');
  } finally {
    window.close();
  }
});

test('rede de segurança: se o boot travar (fetch de sessão nunca resolve), a tela de carregamento some sozinha depois de um tempo, sem prender a pessoa', async () => {
  const dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      // Simula uma rede travada bem no meio do boot: /minha-sessao nunca
      // resolve (nem sucesso, nem erro) — sem a rede de segurança, o
      // "await fetch('/minha-sessao')" dentro do boot (app-core.js)
      // ficaria pendurado pra sempre, e a tela de carregamento nunca
      // sumiria sozinha.
      win.fetch = (url) => {
        const absoluta = new URL(url, win.location.href).toString();
        if (absoluta.includes('/minha-sessao')) return new Promise(() => {}); // nunca resolve
        return Promise.reject(new Error('rede indisponível (simulada pelo teste)'));
      };
    },
  });
  const { window } = dom;
  // Um role QUALQUER que passe pela checagem inicial de "existe algo em
  // sessionStorage" — o boot então tenta confirmar com /minha-sessao, que
  // está travado (ver acima), e nunca completaria sozinho.
  window.sessionStorage.setItem('lw_role', 'Administrativo');

  try {
    const sumiuSozinha = await esperarAte(() => {
      const overlay = window.document.getElementById('boot-loading-overlay');
      return !overlay || !overlay.classList.contains('active');
    }, 10000); // rede de segurança é 8s — dá uma margem

    assert.ok(sumiuSozinha, 'mesmo com o boot travado, a tela de carregamento deveria sumir sozinha (rede de segurança) e não prender a pessoa pra sempre');
  } finally {
    window.close();
  }
});
