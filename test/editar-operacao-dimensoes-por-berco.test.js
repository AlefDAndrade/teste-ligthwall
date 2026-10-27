// ─── test/editar-operacao-dimensoes-por-berco.test.js ───────────────────────
// Editar Operação (⚙️): corrigir a dimensão de operações ANTIGAS berço a
// berço / painel a painel — recalcula as placas de 8 mm (painéis de 9,5 cm),
// grava bercos_dimensoes e registra o diff na auditoria (edicoes_operacao).
// Cenário: bateria B7 (20 berços, "9 cm"), montagem 2/P (2 painéis por berço,
// 2 placas cimentícia por painel), registrada SEM bercos_dimensoes (como as
// operações anteriores a esta funcionalidade).

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-eo-dimensoes-por-berco-619';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let cookie; // sessão de Administrador — POST /registrar-operacao exige (ver podeEditarArea/perfis.js)
let dom;
let window;
let document;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
    dispositivosAutorizados: [DEVICE_ID_TESTE_PADRAO],
  });
  const resp = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  cookie = (resp.headers.get('set-cookie') || '').split(';')[0];
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

beforeEach(async () => {
  if (dom && dom.window) dom.window.close();
  dom = await JSDOM.fromURL(`${servidor.baseUrl}/index.html`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.HTMLElement.prototype.scrollIntoView = function () {};
      // jsdom não gerencia cookie jar sozinho pra esse fetch (é o fetch do
      // PRÓPRIO Node por baixo) — anexa o cookie de sessão manualmente em
      // toda chamada, mesmo padrão de insumos-dinamicos-payload-
      // registro.test.js (rotas protegidas, como /editar-operacao e
      // /bercos-visuais-operacao/:id, exigem sessão real).
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        const headers = { ...(opts && opts.headers), Cookie: cookie };
        return fetch(absoluta, { ...opts, headers });
      };
    },
  });
  window = dom.window;
  document = window.document;
  window.sessionStorage.setItem('lw_role', 'Administrador');
  window.localStorage.setItem('lw_admin_authenticated', 'true');
  window.localStorage.setItem('lw_device_id', DEVICE_ID_TESTE_PADRAO);
  await new Promise(r => setTimeout(r, 2500));
});

// Registra uma operação "antiga" (sem bercos_dimensoes, 9 cm) e devolve o
// objeto no formato historico.json — o mesmo que abrirEdicaoOperacao recebe.
async function registrarOperacaoAntiga(idOp) {
  const resp = await fetch(`${servidor.baseUrl}/registrar-operacao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: idOp, data: '2026-07-20', turno: '1º TURNO', dimensao: '9 cm', capacidade: 20,
      id_bateria: 'B7', tipo_montagem: '2/P',
      inicio: '2026-07-20T08:00:00.000Z', fim: '2026-07-20T09:00:00.000Z',
      tempo_min: 60, qtd_tracos: 3, total_paineis: 40, m2_total: 73.2, placas_cimenticia: 80,
      houve_atraso: 'NÃO',
    }),
  });
  if (resp.status !== 200) throw new Error(`POST /registrar-operacao falhou (${resp.status}): ${await resp.text()}`);
  const historico = await fetch(`${servidor.baseUrl}/db/historico.json`).then(r => r.json());
  const operacao = historico.find(o => o.id === idOp);
  if (!operacao) throw new Error(`Operação ${idOp} não apareceu em /db/historico.json.`);
  return operacao;
}

const esperar = (ms = 200) => new Promise(r => setTimeout(r, ms));
const celula = (berco, lado) => document.querySelector(`#dim-bercos button[data-berco="${berco}"][data-lado="${lado}"]`);
const buscar = async (idOp) => (await fetch(`${servidor.baseUrl}/db/historico.json`).then(r => r.json())).find(o => o.id === idOp);

test('operação antiga (9 cm, sem bercos_dimensoes): botão ⚙️ no lugar do ✏️ e 0 placas de 8 mm', async () => {
  const operacao = await registrarOperacaoAntiga('op-eo-dim-antiga-' + Date.now());
  assert.ok(!operacao.placas_cimenticia_8mm, 'registro antigo = 0 placas de 8 mm');
  window.abrirEdicaoOperacao(operacao);
  await esperar(150);
  assert.equal(document.getElementById('eo-btn-editar-dimensao').textContent, '⚙️');
  assert.equal(document.getElementById('eo-dimensao').value, '9 cm');
});

test('corrigir operação antiga: berços 1-10 = 9,5 cm → campo mostra a mistura, preview e Salvar gravam 40 placas de 8 mm', async () => {
  const idOp = 'op-eo-dim-mista-' + Date.now();
  const operacao = await registrarOperacaoAntiga(idOp);
  window.abrirEdicaoOperacao(operacao);
  await esperar(150);

  await window._eoAbrirModalDimensoes();
  assert.equal(document.querySelectorAll('#dim-bercos button[data-lado="ambos"]').length, 20);
  document.getElementById('dim-valor').value = '9,5';
  document.getElementById('dim-de').value = '1';
  document.getElementById('dim-ate').value = '10';
  document.getElementById('dim-btn-aplicar').click();
  assert.match(document.getElementById('dim-resumo').textContent, /Placas de 8 mm: 40/); // 10 berços × 2 painéis × 2 placas
  document.getElementById('dim-btn-confirmar').click();
  await esperar();

  // ordem de aparição: os berços 1-10 (9,5 cm) vêm antes dos 11-20 (9 cm)
  assert.equal(document.getElementById('eo-dimensao').value, '9,5 cm + 9 cm');

  window.LW.mostrarConfirmacao = async () => true; // "Confirma a alteração de N campo(s)?"
  await window.salvarEdicaoOperacao();
  await esperar();

  const salvo = await buscar(idOp);
  assert.equal(salvo.dimensao, '9 cm');
  assert.equal(salvo.placas_cimenticia, 80);
  assert.equal(salvo.placas_cimenticia_8mm, 40);
  assert.equal(salvo.bercos_dimensoes.length, 20);
  assert.equal(salvo.bercos_dimensoes.slice(0, 10).every(d => d === '9,5 cm'), true);
  assert.equal(salvo.bercos_dimensoes.slice(10).every(d => d === null), true);

  // auditoria: o diff registra bercos_dimensoes (de null → array) e as placas de 8 mm
  const auditoria = await fetch(`${servidor.baseUrl}/db/historico_edicoes.json`).then(r => r.json());
  const lista = Array.isArray(auditoria) ? auditoria : Object.values(auditoria).flat();
  const edicoes = lista.filter(e => e.id_operacao === idOp || e.id === idOp);
  assert.ok(edicoes.length >= 1, 'a edição deveria estar na auditoria');
  const campos = JSON.stringify(edicoes);
  assert.match(campos, /bercos_dimensoes/);
  assert.match(campos, /placas_cimenticia_8mm/);
});

test('corrigir por PAINEL: só o lado direito do berço 1 e o esquerdo do berço 2 = 9,5 cm → 2 painéis = 4 placas de 8 mm', async () => {
  const idOp = 'op-eo-dim-painel-' + Date.now();
  const operacao = await registrarOperacaoAntiga(idOp);
  window.abrirEdicaoOperacao(operacao);
  await esperar(150);

  await window._eoAbrirModalDimensoes();
  document.getElementById('dim-valor').value = '9,5';
  celula(0, 'direita').click();
  celula(1, 'esquerda').click();
  document.getElementById('dim-btn-confirmar').click();
  await esperar();

  window.LW.mostrarConfirmacao = async () => true;
  await window.salvarEdicaoOperacao();
  await esperar();

  const salvo = await buscar(idOp);
  assert.equal(salvo.placas_cimenticia_8mm, 4);
  assert.deepEqual(salvo.bercos_dimensoes[0], { direita: '9,5 cm', esquerda: null });
  assert.deepEqual(salvo.bercos_dimensoes[1], { direita: null, esquerda: '9,5 cm' });
});

test('reabrir a edição de uma operação já corrigida: o modal traz as dimensões gravadas e dá pra voltar ao padrão', async () => {
  const idOp = 'op-eo-dim-reabrir-' + Date.now();
  const operacao = await registrarOperacaoAntiga(idOp);
  window.abrirEdicaoOperacao(operacao);
  await esperar(150);
  await window._eoAbrirModalDimensoes();
  document.getElementById('dim-valor').value = '9,5';
  celula(2, 'ambos').click();
  document.getElementById('dim-btn-confirmar').click();
  await esperar();
  window.LW.mostrarConfirmacao = async () => true;
  await window.salvarEdicaoOperacao();
  await esperar();

  // reabre com o registro atualizado
  const gravada = await buscar(idOp);
  window.abrirEdicaoOperacao(gravada);
  await esperar(150);
  assert.equal(document.getElementById('eo-dimensao').value, '9 cm + 9,5 cm');
  await window._eoAbrirModalDimensoes();
  assert.match(celula(2, 'direita').textContent, /9,5 cm/);
  assert.match(celula(2, 'esquerda').textContent, /9,5 cm/);
  document.getElementById('dim-btn-restaurar').click();
  document.getElementById('dim-btn-confirmar').click();
  await esperar();
  await window.salvarEdicaoOperacao();
  await esperar();

  const final = await buscar(idOp);
  assert.equal(final.placas_cimenticia_8mm, 0);
  assert.ok(!final.bercos_dimensoes, 'sem override = campo ausente/nulo');
});

test('salvar sem mexer nas dimensões não gera diff falso de bercos_dimensoes nem de placas de 8 mm', async () => {
  const idOp = 'op-eo-dim-sem-diff-' + Date.now();
  const operacao = await registrarOperacaoAntiga(idOp);
  window.abrirEdicaoOperacao(operacao);
  await esperar(150);
  document.getElementById('eo-turno').value = '2º TURNO';

  // captura o diff enviado ao servidor
  let diffEnviado = null;
  const fetchOriginal = window.fetch;
  window.fetch = (url, opts) => {
    if (String(url).includes('/editar-operacao') && opts && opts.body) diffEnviado = JSON.parse(opts.body).diff;
    return fetchOriginal(url, opts);
  };
  window.LW.mostrarConfirmacao = async () => true;
  await window.salvarEdicaoOperacao();
  await esperar();

  assert.ok(diffEnviado, 'deveria ter enviado a edição');
  const campos = diffEnviado.map(d => d.campo);
  assert.ok(campos.includes('turno'));
  assert.ok(!campos.includes('bercos_dimensoes'), `diff falso de bercos_dimensoes: ${campos}`);
  assert.ok(!campos.includes('placas_cimenticia_8mm'), `diff falso de placas_cimenticia_8mm: ${campos}`);
  assert.equal((await buscar(idOp)).turno, '2º TURNO');
});
