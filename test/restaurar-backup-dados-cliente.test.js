// ─── test/restaurar-backup-dados-cliente.test.js ────────────────────────────
// Testa a validação CLIENT-SIDE (handleRestaurarArquivo, app-core.js) do
// .zip de Backup de Dados antes de mandar pro servidor — existe uma lista
// separada da do servidor (RESTAURAR_VALIDACOES/OPCIONAIS) que tinha ficado
// desatualizada: faltava metas.json na lista de OPCIONAIS (o navegador
// recusava o arquivo como "incompleto" mesmo depois do servidor já ter
// parado de exigir esse arquivo), e faltavam os validadores inteiros de
// operacoes_nao_avaliadas.json/manutencao_corretiva.json/
// manutencao_programada.json (esses 3 nunca eram lidos do .zip nem
// mandados pro servidor).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const JSZip = require('jszip');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-restaurar-cliente-654';
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
      // A CDN externa (cdnjs) não carrega neste sandbox de teste — injeta
      // o mesmo JSZip usado no restante da suíte diretamente no window,
      // pra handleRestaurarArquivo (app-core.js) conseguir chamar
      // JSZip.loadAsync(...) de verdade.
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

// Mesmo conjunto obrigatório de sempre — sem metas.json, sem os 3
// opcionais de qualidade/manutenção, de propósito.
async function gerarZipMinimo(extras = {}) {
  const zip = new JSZip();
  const arquivos = {
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
  return buffer;
}

test('handleRestaurarArquivo aceita um .zip de Backup de Dados SEM metas.json (não recusa mais como incompleto)', async () => {
  const buffer = await gerarZipMinimo();
  buffer.name = 'backup.zip';
  window.document.getElementById('restaurar-erro').style.display = 'none';
  await window.handleRestaurarArquivo(buffer);
  await new Promise(r => setTimeout(r, 100));

  const erro = window.document.getElementById('restaurar-erro');
  assert.equal(erro.style.display, 'none', `não deveria ter erro, mas apareceu: "${erro.textContent}"`);
  // Deveria ter avançado pro passo de confirmação (preview preenchido).
  assert.equal(window.document.getElementById('restaurar-step-1').style.display, 'block');
});

test('handleRestaurarArquivo lê e envia manutencao_corretiva.json/manutencao_programada.json quando presentes no .zip', async () => {
  const buffer = await gerarZipMinimo({
    'manutencao_corretiva.json': '[{"id":"MAN-1"}]',
    'manutencao_programada.json': '[]',
  });
  buffer.name = 'backup.zip';
  await window.handleRestaurarArquivo(buffer);
  await new Promise(r => setTimeout(r, 100));

  const preview = window.document.getElementById('restaurar-preview').textContent;
  assert.match(preview, /manutencao_corretiva\.json/, 'manutencao_corretiva.json deveria aparecer no preview (lido do zip)');
  assert.match(preview, /manutencao_programada\.json/, 'manutencao_programada.json deveria aparecer no preview (lido do zip)');
});

test('handleRestaurarArquivo com metas.json presente também funciona (lido e enviado)', async () => {
  const buffer = await gerarZipMinimo({ 'metas.json': '{}' });
  buffer.name = 'backup.zip';
  await window.handleRestaurarArquivo(buffer);
  await new Promise(r => setTimeout(r, 100));

  const erro = window.document.getElementById('restaurar-erro');
  assert.equal(erro.style.display, 'none');
  const preview = window.document.getElementById('restaurar-preview').textContent;
  assert.match(preview, /metas\.json/);
});
