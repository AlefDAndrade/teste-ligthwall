// ─── test/manutencao-programada-sem-reaceitar.test.js ───────────────────────
// Regressão: "Retirar o botão de aceitar uma manutenção programada depois
// que ela já foi aceita. Hoje é possível aceitar novamente uma sugestão."
//
// _renderizarLinhaProgramada() (manutencao.js) mostrava o botão "Aceitar"
// (✓, onclick="aprovarAgendamento(id)") tanto pra status 'Pendente' quanto
// 'Aprovado'. Clicar nele de novo reabria o modal de aprovação — mas
// abrirModalAprovacao() pré-preenche com a.data/a.hora (a sugestão
// ORIGINAL), não com a.dataInicioEstimado/a.horaInicioEstimado (o período
// já aprovado); confirmar de novo sobrescrevia silenciosamente quem
// aprovou e quando, sem nenhum aviso de que aquele agendamento já tinha
// sido aceito.
//
// Fix: o botão "Aceitar" só aparece enquanto o status ainda é 'Pendente'.
// O botão "Reprovar" (✗) continua disponível também em 'Aprovado' — é a
// única forma, hoje, de recuar uma aprovação antes de iniciar a execução.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-prog-sem-reaceitar-777';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let dom;
let window;
let cookieAdmin;

function agendamentoBase(id, status) {
  const base = {
    id, status, data: '2026-08-10', hora: '08:00', setor: 'Injetora Teste',
    maquina: 'M-Teste-01', solicitante: 'Teste Automatizado', justificativa: '',
  };
  if (status === 'Aprovado') {
    base.dataInicioEstimado = '2026-08-10'; base.horaInicioEstimado = '08:00';
    base.dataFimEstimado = '2026-08-10'; base.horaFimEstimado = '09:00';
    base.justificativa = 'Aprovado por Encarregado Teste. Previsto: 2026-08-10 08:00 a 2026-08-10 09:00';
  }
  return base;
}

async function salvarAgendamento(agendamento) {
  const resp = await fetch(`${servidor.baseUrl}/manutencao/programada`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify(agendamento),
  });
  const json = await resp.json();
  assert.ok(json.ok, `deveria salvar o agendamento de teste (id=${agendamento.id}): ${json.erro || ''}`);
}

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
  const respAdmin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  cookieAdmin = (respAdmin.headers.get('set-cookie') || '').split(';')[0];

  // Um Pendente e um já Aprovado, criados direto via API — não importa
  // testar o fluxo de aprovar em si aqui (já coberto em outro lugar),
  // só como a LINHA é renderizada pra cada status.
  await salvarAgendamento(agendamentoBase('MAN-TESTE-PEND-001', 'Pendente'));
  await salvarAgendamento(agendamentoBase('MAN-TESTE-APR-001', 'Aprovado'));

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
});

after(async () => {
  if (window) window.close();
  if (servidor) await servidor.parar();
});

test('agendamento Pendente mostra o botão de Aceitar (✓) e o de Reprovar (✗)', async () => {
  window.showPage('manutencao');
  window.MAN.navegar('programada');
  await window.MAN.init();
  await new Promise(r => setTimeout(r, 100));

  const tbody = window.document.getElementById('man-programadaTableBody');
  const linha = [...tbody.querySelectorAll('tr')].find(tr => tr.innerHTML.includes('MAN-TESTE-PEND-001'));
  assert.ok(linha, 'a linha do agendamento Pendente deveria estar na tabela');
  assert.ok(linha.querySelector('button[onclick*="aprovarAgendamento"]'), 'deveria ter o botão de Aceitar enquanto Pendente');
  assert.ok(linha.querySelector('button[onclick*="abrirModalReprovacao"]'), 'deveria ter o botão de Reprovar enquanto Pendente');
});

test('agendamento já Aprovado NÃO mostra mais o botão de Aceitar (✓), mas continua com Reprovar (✗) e Iniciar', async () => {
  const tbody = window.document.getElementById('man-programadaTableBody');
  const linha = [...tbody.querySelectorAll('tr')].find(tr => tr.innerHTML.includes('MAN-TESTE-APR-001'));
  assert.ok(linha, 'a linha do agendamento Aprovado deveria estar na tabela (ainda não é status final)');

  assert.equal(
    linha.querySelector('button[onclick*="aprovarAgendamento"]'), null,
    'o botão de Aceitar NÃO deveria mais aparecer pra um agendamento já Aprovado'
  );
  assert.ok(linha.querySelector('button[onclick*="abrirModalReprovacao"]'), 'o botão de Reprovar deveria continuar disponível em Aprovado');
  assert.ok(linha.querySelector('button[onclick*="abrirModalInicio"]'), 'o botão de Iniciar deveria continuar disponível em Aprovado');
});

test('clicar em "Reprovar" num agendamento já Aprovado ainda funciona (não foi removido sem querer)', async () => {
  window.abrirModalReprovacao('MAN-TESTE-APR-001');
  window.document.getElementById('man-reprovacaoJustificativa').value = 'Cancelado no teste automatizado.';
  await window.confirmarReprovacao();
  await new Promise(r => setTimeout(r, 100));

  const resp = await fetch(`${servidor.baseUrl}/manutencao/programada`);
  const { agendamentos } = await resp.json();
  const salvo = agendamentos.find(a => a.id === 'MAN-TESTE-APR-001');
  assert.equal(salvo.status, 'Reprovado', 'o status deveria ter virado Reprovado no servidor');
});
