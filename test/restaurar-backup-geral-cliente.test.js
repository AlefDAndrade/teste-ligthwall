// ─── test/restaurar-backup-geral-cliente.test.js ────────────────────────────
// Pedido do usuário: "não consigo fazer o backup geral pelo mesmo problema
// de backup de dados, quero trazer o backup do sistema antigo, mas tem
// algumas coisas novas que não tem no backup antigo (...) podemos fazer
// igual em backup de dados, avisar que é um backup de um sistema antigo e
// informar quais arquivos estão faltando e deixar a opção da pessoa de
// prosseguir".
//
// handleRestaurarGeralArquivo (app-core.js) agora usa a MESMA lógica que
// handleRestaurarArquivo (Backup de Dados) já tinha: lê e valida os
// arquivos conhecidos, avisa (sem bloquear) quais opcionais estão faltando
// — e continua aceitando arquivos desconhecidos do zip sem travar nada.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-restaurar-geral-cliente-159';
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
      win.JSZip = JSZip;
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
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

// Um "backup de sistema antigo": só o que já existia desde sempre — nada
// de metas/manutenção/qualidade/usuários — de propósito.
async function gerarZipAntigo(extras = {}) {
  const zip = new JSZip();
  const arquivos = {
    'config.json': JSON.stringify({ baterias: { ids: [] }, tipos_montagem: { opcoes: [] } }),
    'historico.json': '[]',
    'historico_edicoes.json': '[]',
    'relatorio_edicoes.json': '[]',
    'relatorio_injecao.json': '[]',
    'contador_tracos.json': '{}',
    'sobra.json': '{}',
    'paradas.json': '[]',
    'ajustes_tracos.json': '[]',
    ...extras,
  };
  Object.entries(arquivos).forEach(([nome, conteudo]) => zip.file(nome, conteudo));
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  buffer.name = 'backup-geral.zip';
  return buffer;
}

test('handleRestaurarGeralArquivo aceita um backup de sistema antigo (sem metas/manutenção/qualidade/usuários)', async () => {
  const buffer = await gerarZipAntigo();
  await window.handleRestaurarGeralArquivo(buffer);
  await new Promise(r => setTimeout(r, 100));

  const erro = window.document.getElementById('restaurar-geral-erro');
  assert.equal(erro.style.display, 'none', `não deveria recusar o backup antigo, mas apareceu erro: "${erro.textContent}"`);
  assert.equal(window.document.getElementById('restaurar-geral-step-1').style.display, 'block', 'deveria ter avançado pro passo de confirmação mesmo faltando arquivos novos');
});

test('avisa quais arquivos novos estão faltando, sem bloquear a restauração', async () => {
  const buffer = await gerarZipAntigo();
  await window.handleRestaurarGeralArquivo(buffer);
  await new Promise(r => setTimeout(r, 100));

  const preview = window.document.getElementById('restaurar-geral-preview').innerHTML;
  assert.match(preview, /sistema mais antigo/i, 'deveria avisar que é um backup de sistema mais antigo');
  assert.match(preview, /metas\.json/, 'deveria listar metas.json entre os que faltam');
  assert.match(preview, /manutencao_corretiva\.json/, 'deveria listar manutencao_corretiva.json entre os que faltam');
  assert.match(preview, /usuarios\.json/, 'deveria listar usuarios.json entre os que faltam');

  // O botão de avançar/confirmar continua disponível — não travou nada.
  const btnConfirmar = window.document.getElementById('restaurar-geral-btn-confirmar');
  assert.ok(btnConfirmar, 'o botão de confirmar deveria existir e estar acessível');
});

test('sem config.json, recusa claramente (não é um Backup Geral de verdade)', async () => {
  const zip = new JSZip();
  zip.file('historico.json', '[]');
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  buffer.name = 'nao-e-backup-geral.zip';

  await window.handleRestaurarGeralArquivo(buffer);
  await new Promise(r => setTimeout(r, 100));

  const erro = window.document.getElementById('restaurar-geral-erro');
  assert.notEqual(erro.style.display, 'none');
  assert.match(erro.textContent, /config\.json/);
});

test('com todos os arquivos presentes (backup atual, completo), não mostra aviso de "sistema antigo"', async () => {
  const buffer = await gerarZipAntigo({
    'metas.json': '{}',
    'bercos_visuais.json': '[]',
    'avaliacoes_qualidade.json': '[]',
    'operacoes_avaliadas.json': '[]',
    'operacoes_nao_avaliadas.json': '[]',
    'manutencao_corretiva.json': '[]',
    'manutencao_programada.json': '[]',
    'security.json': JSON.stringify({ passwordHash: HASH_ADMIN, recoveryKeyHash: null }),
    'usuarios.json': '[]',
  });
  await window.handleRestaurarGeralArquivo(buffer);
  await new Promise(r => setTimeout(r, 100));

  const erro = window.document.getElementById('restaurar-geral-erro');
  assert.equal(erro.style.display, 'none');
  const preview = window.document.getElementById('restaurar-geral-preview').innerHTML;
  assert.doesNotMatch(preview, /sistema mais antigo/i, 'backup completo não deveria mostrar o aviso de sistema antigo');
});
