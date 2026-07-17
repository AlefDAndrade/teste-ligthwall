// ─── test/paletes-combinacoes.test.js ───────────────────────────────────────
// Testa "Combinações de Avaliação" (Configurações → Paletes — ver
// public/js/paletes-combinacoes.js): lista de tipos "sem combinação" (chips)
// → clicar abre um painel único de marcação visual (cor + forma, clicando
// no painel pra empilhar marcas) + botão "i" pra marcar qual marca é o
// indicador de qualidade → ao salvar, sai de "sem combinação" e entra em
// "Combinações definidas", com botão de editar do lado.
//
// Mesmo padrão de test/paletes-config.test.js: servidor HTTP real + Admin
// Master autenticado de verdade + AdminAuth.abrirModal() stubado.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-paletes-combinacoes-888';
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
  window.eval('AdminAuth.abrirModal = function(onSuccess) { if (onSuccess) onSuccess(); };');
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

async function salvarConfigEsperandoAlerta() {
  const promessaSalvar = window.cfgSalvar();
  await new Promise(r => setTimeout(r, 400));
  const btnOk = window.document.getElementById('btn-alerta-ok');
  if (btnOk) btnOk.click();
  await promessaSalvar;
  await new Promise(r => setTimeout(r, 300));
}

test('abrir Configurações mostra os tipos simples como chips em "Sem combinação"', async () => {
  window.abrirConfig();
  await new Promise(r => setTimeout(r, 200));

  const semCombo = window.document.getElementById('pca-sem-combinacao');
  assert.ok(semCombo, '#pca-sem-combinacao deveria existir');
  assert.match(semCombo.textContent, /2\/P/);
  assert.match(semCombo.textContent, /S\/P/);
  assert.match(semCombo.textContent, /3T/);

  const definidas = window.document.getElementById('pca-definidas-lista');
  assert.match(definidas.textContent, /Nenhuma combinação definida/i);

  // Painel de edição começa fechado.
  const editor = window.document.getElementById('pca-editor');
  assert.equal(editor.style.display, 'none');
});

test('clicar num chip abre o painel de edição vazio, pronto pra montar a combinação', async () => {
  const chip = [...window.document.querySelectorAll('#pca-sem-combinacao button')].find(b => b.textContent.includes('2/P'));
  assert.ok(chip, 'deveria existir um chip pro tipo 2/P');
  chip.click();
  await new Promise(r => setTimeout(r, 50));

  const editor = window.document.getElementById('pca-editor');
  assert.equal(editor.style.display, 'block');
  assert.match(window.document.getElementById('pca-editor-titulo').textContent, /2\/P/);
  assert.match(window.document.getElementById('pca-painel').textContent, /adicionar uma marca/i);
});

test('clicar no painel adiciona uma marca com a cor e forma selecionadas; com só 1 marca, ela já é o indicador implícito', async () => {
  window.pcaSelecionarCor('verde');
  window.pcaSelecionarForma('circle');
  window.document.getElementById('pca-painel').click();
  await new Promise(r => setTimeout(r, 50));

  const painel = window.document.getElementById('pca-painel');
  assert.equal(painel.querySelectorAll('.sq-shape-circle').length, 1, 'deveria ter 1 círculo no painel');

  // Salva com só 1 marca — não deveria pedir pra marcar o indicador (é
  // implícito quando só existe 1 marca).
  window.pcaSalvarCombinacao();
  await new Promise(r => setTimeout(r, 50));

  const editor = window.document.getElementById('pca-editor');
  assert.equal(editor.style.display, 'none', 'painel deveria fechar depois de salvar com sucesso');

  const semCombo = window.document.getElementById('pca-sem-combinacao');
  assert.ok(!semCombo.textContent.includes('2/P'), '2/P não deveria mais aparecer em "Sem combinação"');

  const definidas = window.document.getElementById('pca-definidas-lista');
  assert.match(definidas.textContent, /2\/P/);
});

test('combinação com 2 marcas exige marcar o indicador (botão "i") antes de salvar', async () => {
  const chip = [...window.document.querySelectorAll('#pca-sem-combinacao button')].find(b => b.textContent.includes('S/P'));
  chip.click();
  await new Promise(r => setTimeout(r, 50));

  window.pcaSelecionarCor('amarelo');
  window.pcaSelecionarForma('dash');
  window.document.getElementById('pca-painel').click(); // marca 1: traço amarelo
  window.pcaSelecionarCor('verde');
  window.pcaSelecionarForma('circle');
  window.document.getElementById('pca-painel').click(); // marca 2: círculo verde
  await new Promise(r => setTimeout(r, 50));

  assert.equal(window.document.getElementById('pca-painel').children.length, 2, 'deveria ter 2 marcas no painel');

  // Tenta salvar sem marcar indicador — LW.mostrarAlerta deveria disparar,
  // o editor continua aberto (não fechou/salvou).
  let avisoChamado = false;
  const original = window.eval('LW.mostrarAlerta');
  window.LW.mostrarAlerta = (msg) => { avisoChamado = true; };
  window.pcaSalvarCombinacao();
  assert.ok(avisoChamado, 'deveria avisar que falta marcar o indicador');
  assert.equal(window.document.getElementById('pca-editor').style.display, 'block', 'painel não deveria fechar sem indicador marcado');
  window.LW.mostrarAlerta = original;
});

test('botão "i" + clique numa marca marca ela como indicador; salvar então funciona', async () => {
  window.pcaAtivarModoIndicador();
  const marcas = window.document.querySelectorAll('#pca-painel > span');
  assert.equal(marcas.length, 2);
  marcas[1].click(); // marca o círculo verde (2ª marca) como indicador
  await new Promise(r => setTimeout(r, 50));

  // A marca indicadora aparece cinza (identificacao-auto), não mais verde.
  const marcaIndicador = window.document.querySelectorAll('#pca-painel > span')[1];
  assert.match(marcaIndicador.innerHTML, /identificacao-auto/);

  window.pcaSalvarCombinacao();
  await new Promise(r => setTimeout(r, 50));

  assert.equal(window.document.getElementById('pca-editor').style.display, 'none', 'deveria ter salvo e fechado o painel');
  const definidas = window.document.getElementById('pca-definidas-lista');
  assert.match(definidas.textContent, /S\/P/);
});

test('clicar "editar" numa combinação definida reabre o painel com as marcas e o indicador certos', async () => {
  const btnEditar = [...window.document.querySelectorAll('#pca-definidas-lista button')].find(b => {
    const linha = b.closest('div');
    return linha && linha.textContent.includes('S/P');
  });
  assert.ok(btnEditar, 'deveria ter um botão de editar na linha do S/P');
  btnEditar.click();
  await new Promise(r => setTimeout(r, 50));

  assert.equal(window.document.getElementById('pca-editor').style.display, 'block');
  const marcas = window.document.querySelectorAll('#pca-painel > span');
  assert.equal(marcas.length, 2, 'deveria reabrir com as 2 marcas salvas');
  window.pcaFecharEditor();
});

test('salvar Configurações persiste marcas[]/indicadorIndex no config.json de verdade', async () => {
  await salvarConfigEsperandoAlerta();

  const resp = await fetch(`${servidor.baseUrl}/db/config.json`);
  const cfg = await resp.json();
  const opcoes = cfg.tipos_montagem.opcoes;

  const tipo2p = opcoes.find(o => o.modo === 'simples' && o.tipo === '2p');
  assert.ok(tipo2p.combinacaoAvaliacao, 'combinação de 2p deveria ter sido salva');
  assert.deepEqual(tipo2p.combinacaoAvaliacao.marcas, [{ shape: 'circle', color: 'verde' }]);
  assert.equal(tipo2p.combinacaoAvaliacao.indicadorIndex, 0);

  const tipoSp = opcoes.find(o => o.modo === 'simples' && o.tipo === 'sp');
  assert.ok(tipoSp.combinacaoAvaliacao, 'combinação de sp deveria ter sido salva');
  assert.equal(tipoSp.combinacaoAvaliacao.marcas.length, 2);
  assert.equal(tipoSp.combinacaoAvaliacao.indicadorIndex, 1);
  assert.equal(tipoSp.combinacaoAvaliacao.marcas[0].shape, 'dash');
  assert.equal(tipoSp.combinacaoAvaliacao.marcas[0].color, 'amarelo');
  assert.equal(tipoSp.combinacaoAvaliacao.marcas[1].shape, 'circle');
});

test('cadastrar um tipo de montagem simples NOVO faz ele aparecer em "Sem combinação" automaticamente', async () => {
  // cfgSalvar() (teste anterior) fecha o modal (_cfgDados volta a null) —
  // reabre igual a um Administrador reabrindo Configurações.
  window.abrirConfig();
  await new Promise(r => setTimeout(r, 200));

  window.document.getElementById('cfg-mont-simples-label').value = 'TESTE-PCA';
  window.document.getElementById('cfg-mont-simples-tipo').value = 'testepca';
  window.document.getElementById('cfg-mont-simples-paineis').value = '2';
  window.cfgAdicionarMontagemSimples();
  await new Promise(r => setTimeout(r, 100));

  const semCombo = window.document.getElementById('pca-sem-combinacao');
  assert.match(semCombo.textContent, /TESTE-PCA/i, 'o tipo recém-cadastrado deveria aparecer em "Sem combinação"');
});
