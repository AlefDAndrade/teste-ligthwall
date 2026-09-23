// ─── test/editar-operacao-modal-dimensao-bercos-visuais.test.js ─────────────
// Cobertura de UI (jsdom, SPA real) do que test/editar-operacao-dimensao-
// bercos-visuais.test.js cobre no backend: editar a Dimensão no modal
// "Editar Operação" (✏️, pergunta se mudou o nº de berços) e o editor
// visual "🔲 Berços — Vazou/Não Enchido" (ver app-core.js:
// abrirEdicaoOperacao/_eoConfirmarDimensaoManual/_eoAbrirBercosVisuais).
//
// Cenário de referência: bateria B7 (public/db/config.json — 20 berços,
// dimensão "9 cm"), montagem "S/P".

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste, DEVICE_ID_TESTE_PADRAO } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-eo-modal-dimensao-bercos-552';
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

// Registra uma operação real no servidor (pra existir uma linha em
// bercos_visuais/operacoes pra editar de verdade) e devolve o objeto no
// formato historico.json (o mesmo que abrirEdicaoOperacao(bateria) recebe
// de LWDash, ver dashboard.js/onClickLinhaRegistro).
async function registrarOperacaoEBuscar(idOp) {
  const resp = await fetch(`${servidor.baseUrl}/registrar-operacao?deviceId=${DEVICE_ID_TESTE_PADRAO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: idOp, data: '2026-07-20', turno: '1º TURNO', dimensao: '9 cm', capacidade: 20,
      id_bateria: 'B7', tipo_montagem: 'S/P',
      inicio: '2026-07-20T08:00:00.000Z', fim: '2026-07-20T09:00:00.000Z',
      tempo_min: 60, qtd_tracos: 3, total_paineis: 40, m2_total: 73.2,
      houve_atraso: 'NÃO',
    }),
  });
  if (resp.status !== 200) throw new Error(`POST /registrar-operacao falhou (${resp.status}): ${await resp.text()}`);
  const historico = await fetch(`${servidor.baseUrl}/db/historico.json`).then(r => r.json());
  const operacao = historico.find(o => o.id === idOp);
  if (!operacao) throw new Error(`Operação ${idOp} não apareceu em /db/historico.json após registrar.`);
  return operacao;
}

test('abrirEdicaoOperacao: campo Dimensão nasce com o label automático da bateria (não-manual)', async () => {
  const idOp = 'op-eo-modal-abrir-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp);

  window.abrirEdicaoOperacao(operacao);
  // Espera a busca de berços visuais (_eoCarregarBercosVisuais, disparada
  // ao abrir o modal) terminar antes do teste acabar — senão o
  // beforeEach do próximo teste fecha esta janela com essa promise ainda
  // no ar, e o test runner reclama de "atividade assíncrona após o
  // teste terminar" (só ruído de ambiente de teste; não acontece de
  // verdade num navegador, onde a página só é fechada de propósito).
  await new Promise(r => setTimeout(r, 150));

  assert.equal(document.getElementById('editar-operacao-modal').style.display, 'flex');
  assert.equal(document.getElementById('eo-dimensao').value, '9 cm');
  assert.ok(document.getElementById('eo-dimensao').classList.contains('auto-filled'));
});

test('editar Dimensão + "sim, mudou berços" + novo número: preview mostra capacidade customizada', async () => {
  const idOp = 'op-eo-modal-dim-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp);
  window.abrirEdicaoOperacao(operacao);

  window.LW.mostrarConfirmacao = async () => true; // "sim, mudou"
  window.LW.mostrarPrompt = async () => '8';

  window.LWOp = window.LWOp || {}; // abrirGradeMontagem não é chamado aqui, só existe se Personalizada
  window._eoEditarDimensao(); // destrava
  const input = document.getElementById('eo-dimensao');
  input.value = '7,5';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  window._eoEditarDimensao(); // confirma
  await new Promise(r => setTimeout(r, 200));

  assert.equal(input.value, '7,5 cm');
  assert.equal(input.classList.contains('auto-filled'), false);
  const preview = document.getElementById('eo-preview').textContent;
  assert.match(preview, /8.*\(customizado\)/s);
  assert.match(preview, /16/); // 8 berços * 2 (S/P)
});

test('salvarEdicaoOperacao: envia a dimensão manual e a capacidade customizada pro servidor', async () => {
  const idOp = 'op-eo-modal-salvar-dim-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp);
  window.abrirEdicaoOperacao(operacao);

  window.LW.mostrarConfirmacao = async () => true;
  window.LW.mostrarPrompt = async () => '8';
  window._eoEditarDimensao();
  document.getElementById('eo-dimensao').value = '7,5';
  document.getElementById('eo-dimensao').dispatchEvent(new window.Event('input', { bubbles: true }));
  window._eoEditarDimensao();
  await new Promise(r => setTimeout(r, 200));

  await window.salvarEdicaoOperacao();
  await new Promise(r => setTimeout(r, 200));

  const historico = await window.fetch('/db/historico.json').then(r => r.json());
  const atualizado = historico.find(o => o.id === idOp);
  assert.equal(atualizado.dimensao, '7,5 cm');
  assert.equal(atualizado.capacidade, 8);
  assert.equal(atualizado.total_paineis, 16);
});

test('_eoAbrirBercosVisuais: abre a grade já carregada do servidor (todos "okay" por padrão)', async () => {
  const idOp = 'op-eo-modal-bv-abrir-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp);
  window.abrirEdicaoOperacao(operacao);

  await window._eoAbrirBercosVisuais();
  await new Promise(r => setTimeout(r, 100));

  const modal = document.getElementById('eo-bv-modal');
  assert.ok(modal, 'o sub-modal de berços visuais deveria ter aberto');
  const celulas = modal.querySelectorAll('.ba-celula');
  assert.equal(celulas.length, 20); // capacidade de B7
  const dots = modal.querySelectorAll('.ba-dot.ba-dot-marcado');
  assert.equal(dots.length, 0); // nada marcado ainda
});

test('marcar um berço como Vazou no editor visual + Salvar Alterações: grava em bercos_visuais', async () => {
  const idOp = 'op-eo-modal-bv-marcar-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp);
  window.abrirEdicaoOperacao(operacao);

  await window._eoAbrirBercosVisuais();
  await new Promise(r => setTimeout(r, 100));

  // Clica no indicador direito (topo) do berço B3 — modo padrão = "baixou".
  const dot = document.querySelector('#eo-bv-modal .ba-dot[data-berco="B3"][data-lado="direita"]');
  assert.ok(dot, 'indicador do B3 (direita) deveria existir na grade');
  dot.dispatchEvent(new window.Event('click', { bubbles: true }));
  document.getElementById('eo-bv-confirmar').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));

  window.LW.mostrarConfirmacao = async () => true; // "Confirma a alteração de N campo(s)?"
  await window.salvarEdicaoOperacao();
  await new Promise(r => setTimeout(r, 200));

  const bv = await window.fetch(`/bercos-visuais-operacao/${idOp}`).then(r => r.json());
  const b3 = bv.bercos.find(b => b.berco === 'B3');
  assert.equal(b3.estado_direita, 'baixou');
  assert.equal(b3.estado_esquerda, 'okay');
});

test('marcar um berço como Não Enchido (botão de modo ligado) + Salvar: grava "nao_enchido"', async () => {
  const idOp = 'op-eo-modal-bv-nao-enchido-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp);
  window.abrirEdicaoOperacao(operacao);

  await window._eoAbrirBercosVisuais();
  await new Promise(r => setTimeout(r, 100));

  document.getElementById('eo-bv-btn-modo').dispatchEvent(new window.Event('click', { bubbles: true }));
  const dot = document.querySelector('#eo-bv-modal .ba-dot[data-berco="B5"][data-lado="esquerda"]');
  dot.dispatchEvent(new window.Event('click', { bubbles: true }));
  document.getElementById('eo-bv-confirmar').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));

  window.LW.mostrarConfirmacao = async () => true;
  await window.salvarEdicaoOperacao();
  await new Promise(r => setTimeout(r, 200));

  const bv = await window.fetch(`/bercos-visuais-operacao/${idOp}`).then(r => r.json());
  const b5 = bv.bercos.find(b => b.berco === 'B5');
  assert.equal(b5.estado_esquerda, 'nao_enchido');
});

test('Cancelar no editor de berços visuais descarta o clique feito nesta sessão do sub-modal', async () => {
  const idOp = 'op-eo-modal-bv-cancelar-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp);
  window.abrirEdicaoOperacao(operacao);

  await window._eoAbrirBercosVisuais();
  await new Promise(r => setTimeout(r, 100));
  document.querySelector('#eo-bv-modal .ba-dot[data-berco="B1"][data-lado="direita"]')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  document.getElementById('eo-bv-cancelar').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));

  window.LW.mostrarConfirmacao = async () => true;
  await window.salvarEdicaoOperacao();
  await new Promise(r => setTimeout(r, 200));

  // Nada devia ter sido enviado (nenhuma mudança de fato) — o alerta de
  // "Nenhuma alteração foi feita" teria impedido o POST; confirmamos
  // olhando o servidor: berço continua 'okay'.
  const bv = await window.fetch(`/bercos-visuais-operacao/${idOp}`).then(r => r.json());
  const b1 = bv.bercos.find(b => b.berco === 'B1');
  assert.equal(b1.estado_direita, 'okay');
});

// BUG CORRIGIDO (relatado pelo usuário): o cálculo de Painéis em Editar
// Operação sempre usava a capacidade MÁXIMA da bateria, nunca descontava
// os berços já marcados como Vazou/Não Enchido — então salvar qualquer
// edição não relacionada (ex: só o turno) apagava silenciosamente esse
// desconto, sobrescrevendo total_paineis/m2_total pelo valor cheio.
// Corrigido: _eoCalcularPaineis agora aplica LW.aplicarNaoEnchidosNoCalc
// (mesma função usada no registro original em Registrar Operação) em
// cima dos berços já salvos em bercos_visuais (busca automática ao abrir
// o modal, ver _eoCarregarBercosVisuais).
test('salvar uma edição não relacionada (ex: só o turno) preserva o desconto de berços já marcados Não Enchido', async () => {
  const idOp = 'op-eo-modal-preserva-desconto-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp); // B7: 20 berços, S/P -> 40 painéis "cheios"

  // Pré-condição (setup direto no servidor, não é o que este teste
  // exercita): 2 berços já marcados como Não Enchido, como se tivessem
  // sido marcados desde o registro original — 40 - 2 = 38 painéis
  // esperados dali em diante.
  const bercosVisuais = Array.from({ length: 20 }, (_, i) => ({
    berco: 'B' + (i + 1), ordem: i + 1,
    estado_esquerda: i < 2 ? 'nao_enchido' : 'okay',
    estado_direita: 'okay',
  }));
  await fetch(`${servidor.baseUrl}/editar-operacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: idOp,
      novosValores: {},
      diff: [{ campo: 'bercos_visuais', de: [], para: bercosVisuais }],
      bercosVisuais,
    }),
  });

  // Abre a edição e muda só o turno — nada relacionado a berços/painéis.
  window.abrirEdicaoOperacao(operacao);
  await new Promise(r => setTimeout(r, 200)); // _eoCarregarBercosVisuais busca os 2 nao_enchido acima
  document.getElementById('eo-turno').value = '2º TURNO';
  document.getElementById('eo-turno').dispatchEvent(new window.Event('change', { bubbles: true }));

  window.LW.mostrarConfirmacao = async () => true;
  await window.salvarEdicaoOperacao();
  await new Promise(r => setTimeout(r, 200));

  const historico = await window.fetch('/db/historico.json').then(r => r.json());
  const atualizado = historico.find(o => o.id === idOp);
  assert.equal(atualizado.turno, '2º TURNO'); // a edição pedida foi aplicada
  assert.equal(atualizado.total_paineis, 38, 'deveria continuar descontando os 2 berços Não Enchido (40-2), não voltar pra 40');
});

// BUG CORRIGIDO (relatado pelo usuário): desmarcar um "Não Enchido" já
// existente (ex: marcado por engano na hora do registro) não tinha
// efeito — clicar no indicador ✕ no MODO PADRÃO (🚫 Marcar Não Enchido
// desligado, ou seja, modo "Vazou") sobrescrevia o berço pra 'baixou' em
// vez de limpar pra 'okay', porque o clique só desmarcava se o modo
// atual coincidisse com o estado já marcado. Corrigido: um lado já
// marcado com QUALQUER estado sempre desmarca ao ser clicado de novo,
// independente do modo (mesmo comportamento de _baCliqueDot,
// bateria-atual.js).
test('desmarcar um berço já "Não Enchido" (clicando no modo padrão "Vazou", sem trocar de modo) limpa pra okay e devolve o painel ao total', async () => {
  const idOp = 'op-eo-modal-desmarcar-nao-enchido-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp); // 20 berços, S/P -> 40 painéis "cheios"

  // Pré-condição: B3 (lado esquerdo) já marcado como Não Enchido, como
  // se tivesse sido um engano no registro original.
  const bercosVisuais = Array.from({ length: 20 }, (_, i) => ({
    berco: 'B' + (i + 1), ordem: i + 1,
    estado_esquerda: i === 2 ? 'nao_enchido' : 'okay',
    estado_direita: 'okay',
  }));
  await fetch(`${servidor.baseUrl}/editar-operacao`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      id: idOp,
      novosValores: {},
      diff: [{ campo: 'bercos_visuais', de: [], para: bercosVisuais }],
      bercosVisuais,
    }),
  });

  window.abrirEdicaoOperacao(operacao);
  await window._eoAbrirBercosVisuais();
  await new Promise(r => setTimeout(r, 100));

  // NÃO troca de modo — o editor abre sempre no modo padrão ("Vazou",
  // _eoBercosVisuaisModoNaoEnchido === false). Clica direto no indicador
  // ✕ do B3 (esquerda), que já está "Não Enchido", pra desmarcar.
  const dotB3 = document.querySelector('#eo-bv-modal .ba-dot[data-berco="B3"][data-lado="esquerda"]');
  assert.equal(dotB3.textContent, '✕', 'B3 deveria abrir já mostrando a marcação Não Enchido existente');
  dotB3.dispatchEvent(new window.Event('click', { bubbles: true }));
  document.getElementById('eo-bv-confirmar').dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));

  window.LW.mostrarConfirmacao = async () => true;
  await window.salvarEdicaoOperacao();
  await new Promise(r => setTimeout(r, 200));

  const bv = await window.fetch(`/bercos-visuais-operacao/${idOp}`).then(r => r.json());
  const b3 = bv.bercos.find(b => b.berco === 'B3');
  assert.equal(b3.estado_esquerda, 'okay', 'deveria ter voltado a "okay", não virado "baixou"');

  const historico = await window.fetch('/db/historico.json').then(r => r.json());
  const atualizado = historico.find(o => o.id === idOp);
  assert.equal(atualizado.total_paineis, 40, 'o painel do B3 desmarcado deveria voltar a contar no total (40, não mais 39)');
});

// Pedido do usuário (usabilidade): ver o efeito de marcar/desmarcar um
// berço no preview de Painéis Total ANTES de clicar "Salvar Alterações"
// — antes, "Aplicar" só fechava o sub-modal sem atualizar o preview
// principal, dando a impressão de que o clique "não fazia efeito" até
// salvar de verdade.
test('marcar um berço como Não Enchido e clicar "Aplicar" atualiza o preview de Painéis ANTES de salvar', async () => {
  const idOp = 'op-eo-modal-preview-ao-vivo-' + Date.now();
  const operacao = await registrarOperacaoEBuscar(idOp); // 20 berços, S/P -> 40 painéis
  window.abrirEdicaoOperacao(operacao);
  await new Promise(r => setTimeout(r, 200));

  assert.match(document.getElementById('eo-preview').textContent, /40/, 'preview deveria começar em 40 (nada marcado ainda)');

  await window._eoAbrirBercosVisuais();
  await new Promise(r => setTimeout(r, 100));
  document.getElementById('eo-bv-btn-modo').dispatchEvent(new window.Event('click', { bubbles: true })); // liga modo "Não Enchido"
  document.querySelector('#eo-bv-modal .ba-dot[data-berco="B1"][data-lado="direita"]')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  document.getElementById('eo-bv-confirmar').dispatchEvent(new window.Event('click', { bubbles: true })); // "Aplicar" — SEM salvar
  await new Promise(r => setTimeout(r, 100));

  // Preview já reflete os 39 painéis (40-1) mesmo sem ter clicado
  // "Salvar Alterações" ainda — é o ponto central deste teste.
  assert.match(document.getElementById('eo-preview').textContent, /39/, 'preview deveria já mostrar 39 painéis antes de salvar');

  // E o servidor ainda não sabe de nada (nada foi salvo de verdade).
  const bvAntesDeSalvar = await window.fetch(`/bercos-visuais-operacao/${idOp}`).then(r => r.json());
  assert.equal(bvAntesDeSalvar.bercos.find(b => b.berco === 'B1').estado_direita, 'okay');
});
