// ─── test/operacao-status-aba-traco.test.js ─────────────────────────────────
// Regressão de um bug real: em Registrar Operação, a aba de cada traço
// mostra um ícone de status (✅ completo / ⚠️ pendente / ⚪ vazio — ver
// _statusDoTraco, public/js/operacao.js). Esse ícone era calculado só
// dentro de renderTracos() — que só roda em eventos "grandes" (adicionar
// traço, trocar de aba...), não a cada campo preenchido. Já
// updatePendencias() (que atualiza o PAINEL-RESUMO de pendências) roda a
// cada persist(), ou seja, a cada campo — só que sem tocar no ícone da
// aba. Resultado: o painel-resumo já mostrava "tudo ok", mas a aba do
// traço continuava travada em ⚠️ até algo maior disparar um render
// completo — o operador via "pendência" numa tela que já estava 100%
// preenchida.
//
// Corrigido fazendo updatePendencias() também chamar
// _atualizarStatusAbasTracos() (atualização cirúrgica, só ícone/classe —
// não re-renderiza o formulário, que apagaria o foco de quem está
// digitando).
//
// Mesmo padrão de test/manutencao-pagina.test.js / test/perfis-
// customizados-boot.test.js: servidor real + jsdom carregando a SPA de
// verdade, evitando ter que simular as dezenas de dependências de
// data.js que operacao.js usa.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-status-aba-traco-741';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let dom;
let window;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
  dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        return fetch(absoluta, opts);
      };
    },
  });
  window = dom.window;
  window.sessionStorage.setItem('lw_role', 'Administrador');
  window.localStorage.setItem('lw_admin_authenticated', 'true');
  await new Promise(r => setTimeout(r, 2500));
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

function preencherCamposObrigatorios(exceto) {
  const campos = {
    berco_ini: '1', berco_fim: '10', silo: 'S1', expansao: '30', densidadeEPS: '15',
  };
  const insumos = {
    cimento_real: '12.00', agua_real: '5.00', eps_real: '0.50',
    superplast_real: '0.12', incorporador_real: '0.05',
    tempo_batida: '180', densidade_insumo: '1200', flow_insumo: '650',
  };
  Object.entries(campos).forEach(([campo, valor]) => {
    if (campo === exceto) return;
    window.LWOp.updateTraco(0, campo, valor);
  });
  Object.entries(insumos).forEach(([campo, valor]) => {
    if (campo === exceto) return;
    window.LWOp.updateInsumoOriginal(0, campo, valor);
  });
}

test('aba do traço mostra ⚠️ (pendente) recém-criada — berço inicial já vem sugerido, mas o resto ainda falta', async () => {
  window.showPage('operacao');
  await new Promise(r => setTimeout(r, 300));
  window.LWOp.addTraco();
  await new Promise(r => setTimeout(r, 100));

  // _adicionarTracoNovo já sugere berco_ini (próximo berço livre) — por
  // isso o traço nasce "pending" (tem 1 campo preenchido), não "empty".
  const aba = window.document.querySelector('.traco-tabs-nav .traco-tab');
  assert.ok(aba.className.includes('pending'), 'traço recém-criado (berço inicial já sugerido) deveria estar "pending"');
  assert.equal(aba.querySelector('.status-icon').textContent, '⚠️');
});

test('preencher TODOS os campos obrigatórios atualiza a aba pra ✅ na hora, sem precisar de outro evento', () => {
  preencherCamposObrigatorios(null);

  const aba = window.document.querySelector('.traco-tabs-nav .traco-tab');
  assert.ok(aba.className.includes('complete'), 'depois de preencher tudo, a aba deveria virar "complete" imediatamente');
  assert.equal(aba.querySelector('.status-icon').textContent, '✅');
});

test('faltando 1 campo obrigatório, a aba continua ⚠️ (pendente) — nunca marca completo por engano', async () => {
  // Reseta preenchendo tudo de novo, deixando UM campo de fora desta vez.
  window.LWOp.updateInsumoOriginal(0, 'incorporador_real', '');
  await new Promise(r => setTimeout(r, 50));

  const aba = window.document.querySelector('.traco-tabs-nav .traco-tab');
  assert.ok(aba.className.includes('pending'), 'com 1 campo obrigatório vazio, a aba deveria voltar a "pending"');
  assert.equal(aba.querySelector('.status-icon').textContent, '⚠️');
});

test('o painel-resumo de pendências e o ícone da aba nunca ficam dessincronizados', async () => {
  // Preenche o campo que faltou — os dois indicadores (painel-resumo E
  // aba) devem virar "ok"/"✅" juntos, no mesmo instante.
  window.LWOp.updateInsumoOriginal(0, 'incorporador_real', '0.05');
  await new Promise(r => setTimeout(r, 50));

  const aba = window.document.querySelector('.traco-tabs-nav .traco-tab');
  assert.equal(aba.querySelector('.status-icon').textContent, '✅');

  const itemPendenciaTraco = Array.from(window.document.querySelectorAll('.pendency-item'))
    .find(el => el.textContent.includes('Informações do traço'));
  assert.ok(itemPendenciaTraco, 'deveria existir o item de pendência "Informações do traço" no painel-resumo');
  assert.ok(itemPendenciaTraco.className.includes('ok'), 'o painel-resumo deveria concordar com a aba: tudo ok');
});
