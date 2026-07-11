// ─── test/setor-qualidade-trava.test.js ─────────────────────────────────────
// Testa o bloqueio de ID da Bateria, Tipo de Montagem, Turno, Data/Hora de
// Enchimento e Espessura (Medição) no Setor de Qualidade — esses 5 campos
// vêm PRONTOS da operação real escolhida na fila (ver _prefillFromOperacao
// em public/js/setor-qualidade.js) e não podem mais ser editados à mão, nem
// numa avaliação nova nem numa correção (editarAvaliacaoDoEspelho).
//
// Diferente de test/auth.test.js (que sobe o server.js de verdade e bate
// nas rotas por HTTP), este arquivo testa o SCRIPT DE FRONT-END sozinho:
// setor-qualidade.js é uma IIFE de navegador (usa document/window/
// localStorage, não exporta nada via module.exports) — por isso o teste
// carrega o HTML real da tela e o JS real dentro de um DOM headless
// (jsdom), e interage com ele exatamente como um navegador faria, através
// da API pública window.SQ. O harness (montarTela/tick) fica em
// test/helpers/setor-qualidade-dom.js — compartilhado com
// test/setor-qualidade-pallets-extras.test.js.
//
// Como rodar: node --test (jsdom é devDependency — já entra com npm install)

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { montarTela, tick, OPERACAO_FILA } = require('./helpers/setor-qualidade-dom.js');

let dom;

beforeEach(() => {
  dom = montarTela();
});

after(() => {
  dom = null;
});

test('ao abrir o formulário em branco (sem bateria escolhida ainda), os 5 campos já vêm travados', async () => {
  const { window } = dom;
  window.SQ.startNew();
  await tick();

  // Travado DESDE O INÍCIO, não só depois de escolher a bateria — como
  // avulsa não é mais permitida, não faz sentido digitar nesses campos
  // antes de vincular a uma operação real (ver _bloquearCamposAutoPreenchidos).
  assert.equal(window.document.getElementById('sq-batteryId').disabled, true);
  assert.equal(window.document.getElementById('sq-mountType').disabled, true);
  assert.equal(window.document.getElementById('sq-turno').disabled, true);
  assert.equal(window.document.getElementById('sq-dtEnchimento').disabled, true);
  window.document.querySelectorAll('.sq-info-edit[data-field="espessura"]').forEach(btn => {
    assert.equal(btn.classList.contains('sq-info-edit-locked'), true);
  });

  // Os que não são auto-preenchidos continuam livres mesmo em branco.
  assert.equal(window.document.getElementById('sq-temp').disabled, false);
  assert.equal(window.document.getElementById('sq-obs').disabled, false);
});

test('ao escolher uma bateria da fila, os 5 campos auto-preenchidos ficam travados', async () => {
  const { window } = dom;
  window.SQ.startNew();
  await tick();

  window.SQ.iniciarAvaliacaoDaFila(OPERACAO_FILA.id);
  await tick();

  assert.equal(window.document.getElementById('sq-batteryId').value, 'B3');
  assert.equal(window.document.getElementById('sq-batteryId').disabled, true, 'ID da Bateria deveria estar travado');
  assert.equal(window.document.getElementById('sq-mountType').disabled, true, 'Tipo de Montagem deveria estar travado');
  assert.equal(window.document.getElementById('sq-turno').disabled, true, 'Turno deveria estar travado');
  assert.equal(window.document.getElementById('sq-dtEnchimento').disabled, true, 'Data/Hora de Enchimento deveria estar travada');

  const lapisEspessura = window.document.querySelectorAll('.sq-info-edit[data-field="espessura"]');
  assert.ok(lapisEspessura.length > 0, 'deveria existir ao menos um lápis de Espessura na tela');
  lapisEspessura.forEach(btn => {
    assert.equal(btn.classList.contains('sq-info-edit-locked'), true, 'lápis de Espessura deveria estar travado');
  });

  // Campos que NÃO são preenchidos automaticamente continuam livres —
  // exatamente o requisito original ("os únicos editáveis são os que não
  // são preenchidos automaticamente").
  assert.equal(window.document.getElementById('sq-temp').disabled, false);
  assert.equal(window.document.getElementById('sq-dtMontagem').disabled, false);
  assert.equal(window.document.getElementById('sq-dtDesmoldagem').disabled, false);
  assert.equal(window.document.getElementById('sq-obs').disabled, false);
  const lapisComprimento = window.document.querySelectorAll('.sq-info-edit[data-field="comprimento"]');
  assert.ok(lapisComprimento.length > 0);
  lapisComprimento.forEach(btn => {
    assert.equal(btn.classList.contains('sq-info-edit-locked'), false);
  });
});

test('clicar no lápis travado da Espessura não abre a edição', async () => {
  const { window } = dom;
  window.SQ.startNew();
  await tick();
  window.SQ.iniciarAvaliacaoDaFila(OPERACAO_FILA.id);
  await tick();

  const valorAntes = window.document.getElementById('sq-p1-espessura').innerText;
  const btn = window.document.querySelector('.sq-info-edit[data-pallet="1"][data-field="espessura"]');
  window.SQ.editField(btn);
  await tick();

  // showPrompt (chamado por editField) precisaria do modal #sq-modal —
  // se editField tivesse passado da trava, o modal abriria (classe
  // "open"); como está travado, editField retorna antes de chegar lá.
  assert.equal(window.document.getElementById('sq-modal').classList.contains('open'), false);
  assert.equal(window.document.getElementById('sq-p1-espessura').innerText, valorAntes);
});

test('ao voltar pro formulário em branco (nova avaliação), os campos continuam travados', async () => {
  const { window } = dom;
  window.SQ.startNew();
  await tick();
  window.SQ.iniciarAvaliacaoDaFila(OPERACAO_FILA.id);
  await tick();

  window.SQ.startNew(); // limpa tudo pra uma avaliação nova, sem bateria escolhida ainda
  await tick();

  assert.equal(window.document.getElementById('sq-batteryId').value, 'B1', 'clearForm deveria resetar o valor pro padrão');
  assert.equal(window.document.getElementById('sq-batteryId').disabled, true, 'continua travado, mesmo em branco');
  window.document.querySelectorAll('.sq-info-edit[data-field="espessura"]').forEach(btn => {
    assert.equal(btn.classList.contains('sq-info-edit-locked'), true);
  });
});

test('ao corrigir uma avaliação já registrada (espelho), os 5 campos também ficam travados', async () => {
  const { window } = dom;
  window.sessionStorage.setItem('lw_role', 'Administrador');

  window.SQ.navigateTo('dashboard');
  await tick(10); // espera carregarAvaliacoesQualidade() (fetch mockado) popular dashboardEvals

  window.SQ.editarAvaliacaoDoEspelho(); // abre o modal de confirmação ("Isso abre a avaliação... Continuar?")
  const modalOk = window.document.getElementById('sq-modal-ok');
  assert.ok(modalOk.onclick, 'o modal de confirmação deveria estar aberto com o botão OK pronto');
  modalOk.onclick(); // simula o clique em "Confirmar"
  await tick();

  assert.equal(window.document.getElementById('sq-batteryId').value, 'B7');
  assert.equal(window.document.getElementById('sq-batteryId').disabled, true, 'ID da Bateria deveria estar travado na correção');
  assert.equal(window.document.getElementById('sq-mountType').disabled, true, 'Tipo de Montagem deveria estar travado na correção');
  assert.equal(window.document.getElementById('sq-turno').disabled, true, 'Turno deveria estar travado na correção');
  assert.equal(window.document.getElementById('sq-dtEnchimento').disabled, true, 'Data/Hora de Enchimento deveria estar travada na correção');
  window.document.querySelectorAll('.sq-info-edit[data-field="espessura"]').forEach(btn => {
    assert.equal(btn.classList.contains('sq-info-edit-locked'), true, 'lápis de Espessura deveria estar travado na correção');
  });

  // Observações continuam editáveis mesmo na correção — não é preenchido
  // automaticamente pela operação real.
  assert.equal(window.document.getElementById('sq-obs').disabled, false);
});

test('ao retomar um rascunho salvo vinculado à fila ("Em Andamento"), os 5 campos continuam travados', async () => {
  const { window } = dom;

  // Fluxo real: escolhe a bateria da fila (trava os campos), salva como
  // rascunho (não registra ainda) — saveDraft() persiste linkedOperacaoId
  // junto (ver public/js/setor-qualidade.js) — e SÓ DEPOIS retoma esse
  // rascunho pela lista "Em Andamento" (loadDraft), que é o caminho que
  // não estava travando.
  window.SQ.startNew();
  await tick();
  window.SQ.iniciarAvaliacaoDaFila(OPERACAO_FILA.id);
  await tick();
  window.SQ.saveDraft();

  // Some pro modal de "Salvo" não travar o teste — showAlert usa o mesmo
  // _modal, sem callback obrigatório aqui.
  const draftId = window.localStorage.key(
    Array.from({ length: window.localStorage.length }, (_, i) => i)
      .find(i => window.localStorage.key(i).startsWith('sq_draft_'))
  ).replace('sq_draft_', '');

  // Simula reabrir a tela do zero (outro acesso) e retomar o rascunho.
  window.SQ.startNew();
  await tick();
  window.SQ.loadDraft(draftId);
  await tick();

  assert.equal(window.document.getElementById('sq-batteryId').value, 'B3');
  assert.equal(window.document.getElementById('sq-batteryId').disabled, true, 'ID da Bateria deveria continuar travado ao retomar o rascunho');
  assert.equal(window.document.getElementById('sq-mountType').disabled, true, 'Tipo de Montagem deveria continuar travado ao retomar o rascunho');
  assert.equal(window.document.getElementById('sq-turno').disabled, true, 'Turno deveria continuar travado ao retomar o rascunho');
  assert.equal(window.document.getElementById('sq-dtEnchimento').disabled, true, 'Data/Hora de Enchimento deveria continuar travada ao retomar o rascunho');
  window.document.querySelectorAll('.sq-info-edit[data-field="espessura"]').forEach(btn => {
    assert.equal(btn.classList.contains('sq-info-edit-locked'), true, 'lápis de Espessura deveria continuar travado ao retomar o rascunho');
  });
});