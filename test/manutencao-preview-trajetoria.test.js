// ─── test/manutencao-preview-trajetoria.test.js ─────────────────────────────
// Testa o preview flutuante da trajetória do chamado, que aparece ao
// segurar Ctrl e passar o mouse em cima da linha na tabela de Chamados
// Corretivos (ver conversa que motivou isso) — sem Ctrl, nada aparece; e
// sair da linha (mouseleave) esconde o preview.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-preview-traj-666';
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
      win.Chart = function (ctx, cfg) { this.destroy = () => {}; this._cfg = cfg; };
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

  // Cria um chamado pela interface (mesmo padrão de
  // manutencao-pagina.test.js) — garante que ele já esteja no array em
  // memória (manutencoes) que renderCorretiva() usa pra desenhar a
  // tabela, sem precisar expor funções internas extras só pro teste.
  window.MAN.navegar('manutencao');
  window.novoChamado();
  await new Promise(r => setTimeout(r, 50));
  window.document.getElementById('man-manSetor').value = 'Injetora Preview';
  window.document.getElementById('man-manMaquina').value = 'M-preview';
  window.document.getElementById('man-manObservador').value = 'joao.preview';
  window.document.getElementById('man-manAnomalia').value = 'Anomalia de teste';
  window.document.getElementById('man-manTipoManutencao').value = 'Mecânica';
  window.setPrioridade('ALTA');
  await window.salvarManutencao();
  await new Promise(r => setTimeout(r, 300));

  // Cartões do acordeão só existem no DOM quando a fase está aberta (ver
  // conversa: "cada card do kanban vira tipo um select") — chamado novo
  // (ainda não aceito) cai na fase "Aguardando Aceite".
  window._manToggleFase('aceite');
});

after(async () => {
  if (window) window.close();
  if (servidor) await servidor.parar();
});

function dispararMouseEvent(el, tipo, opts = {}) {
  const evt = new window.MouseEvent(tipo, { bubbles: true, cancelable: true, clientX: 100, clientY: 100, ctrlKey: !!opts.ctrlKey });
  el.dispatchEvent(evt);
}

test('sem Ctrl, passar o mouse na linha NÃO mostra o preview da trajetória', async () => {
  const acc = window.document.getElementById('man-corretivaAccordion');
  const linha = acc.querySelector('.man-kanban-card');
  assert.ok(linha, 'deveria ter pelo menos um cartão na fase aberta do acordeão');

  dispararMouseEvent(linha, 'mouseenter', { ctrlKey: false });
  dispararMouseEvent(linha, 'mousemove', { ctrlKey: false });

  const preview = window.document.getElementById('man-trajetoriaPreview');
  assert.ok(!preview || preview.style.display === 'none', 'preview não deveria aparecer sem Ctrl');
});

test('segurando Ctrl e passando o mouse na linha, o preview aparece com o stepper', async () => {
  const acc = window.document.getElementById('man-corretivaAccordion');
  const linha = acc.querySelector('.man-kanban-card');

  dispararMouseEvent(linha, 'mouseenter', { ctrlKey: true });
  dispararMouseEvent(linha, 'mousemove', { ctrlKey: true });

  const preview = window.document.getElementById('man-trajetoriaPreview');
  assert.ok(preview, 'preview deveria ter sido criado no DOM');
  assert.equal(preview.style.display, 'block');
  assert.ok(preview.querySelector('.man-trajetoria-passos'), 'preview deveria conter o stepper de trajetória');
  assert.ok(preview.querySelector('.man-trajetoria-passo'), 'preview deveria conter pontos da trajetória');
});

test('mouseleave esconde o preview', async () => {
  const acc = window.document.getElementById('man-corretivaAccordion');
  const linha = acc.querySelector('.man-kanban-card');

  dispararMouseEvent(linha, 'mouseenter', { ctrlKey: true });
  dispararMouseEvent(linha, 'mousemove', { ctrlKey: true });
  let preview = window.document.getElementById('man-trajetoriaPreview');
  assert.equal(preview.style.display, 'block');

  dispararMouseEvent(linha, 'mouseleave', { ctrlKey: true });
  preview = window.document.getElementById('man-trajetoriaPreview');
  assert.equal(preview.style.display, 'none');
});
