// ─── test/offline-dimensoes-modal.test.js ───────────────────────────────────
// Fumaça do formulário offline (offline.html + offline-operacao.js) com o
// modal ⚙️ de dimensão por berço: abre, aplica faixa, confirma, mostra a
// mistura no campo, calcula as placas de 8 mm, salva no rascunho e restaura
// o rascunho sem perder a dimensão personalizada.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const RAIZ = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(RAIZ, 'public/offline.html'), 'utf8').replace(/<script[^>]*src=[^>]*><\/script>/g, '');
const PLACAS_JS = fs.readFileSync(path.join(RAIZ, 'public/js/placas-8mm.js'), 'utf8');
const OFFLINE_JS = fs.readFileSync(path.join(RAIZ, 'public/js/offline-operacao.js'), 'utf8');
const CONFIG = {
  baterias: { ids: [{ id: 'B9', label: '9 cm', bercos: 8 }] },
  tipos_montagem: { opcoes: JSON.parse(fs.readFileSync(path.join(RAIZ, 'public/db/config.json'), 'utf8')).tipos_montagem.opcoes },
};

async function abrirPagina(localStorageInicial) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/offline.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  for (const [k, v] of Object.entries(localStorageInicial || {})) w.localStorage.setItem(k, v);
  w.fetch = async (url) => (String(url).includes('config.json')
    ? { ok: true, json: async () => CONFIG }
    : { ok: false, status: 503, json: async () => ({}) });
  w.eval(PLACAS_JS);
  w.eval(OFFLINE_JS);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 50)); // init() é assíncrono (loadConfig)
  return w;
}

function escolher(w, id, valor) {
  const el = w.document.getElementById(id);
  el.value = valor;
  el.dispatchEvent(new w.Event('change'));
}

test('modal ⚙️ offline: 4 berços de 9,5 cm + 4 de 9 cm → campo mostra a mistura, 8 mm calculado e rascunho salvo', async () => {
  const w = await abrirPagina();
  w.document.getElementById('off-modal-num-inicial').style.display = 'none';
  escolher(w, 'off-bateria', 'B9');
  escolher(w, 'off-tipo-montagem', '2/P');

  w.LWOff.abrirModalDimensoes();
  assert.equal(w.document.getElementById('off-modal-dimensoes').style.display, 'flex');
  assert.equal(w.document.querySelectorAll('#off-dim-bercos button').length, 8);

  w.document.getElementById('off-dim-valor').value = '9.5';
  w.document.getElementById('off-dim-de').value = '1';
  w.document.getElementById('off-dim-ate').value = '4';
  w.LWOff.aplicarFaixaDimensoes();
  assert.match(w.document.getElementById('off-dim-resumo').textContent, /Placas de 8 mm: 16/);
  w.LWOff.confirmarModalDimensoes();

  assert.equal(w.document.getElementById('off-modal-dimensoes').style.display, 'none');
  assert.match(w.document.getElementById('off-dimensao').value, /^9,5 cm \+ 9 cm \(8 berços\)$/);
  assert.match(w.document.getElementById('off-placas-espessura').textContent, /8 mm: 16 · 6 mm: 16/);

  const rascunho = JSON.parse(w.localStorage.getItem('lw_operacao_offline_pendente'));
  assert.deepEqual(Array.from(rascunho.formRecord.bercos_dimensoes), ['9,5 cm', '9,5 cm', '9,5 cm', '9,5 cm', null, null, null, null]);
});

test('retomar rascunho: dimensão padrão personalizada e overrides por berço sobrevivem ao recarregar', async () => {
  const rascunho = {
    idTemp: 'OFF-x', iniciadoEm: new Date().toISOString(), tracos: [], pausas: [],
    formRecord: {
      turno: '1º TURNO', dimensao: '9,5 cm', dimensao_manual: true, capacidade: 8, id_bateria: 'B9', tipo_montagem: '2/P',
      bercos_dimensoes: [null, null, null, null, '9 cm', '9 cm', '9 cm', '9 cm'],
    },
  };
  const w = await abrirPagina({ lw_operacao_offline_pendente: JSON.stringify(rascunho) });
  assert.match(w.document.getElementById('off-dimensao').value, /^9,5 cm \+ 9 cm \(8 berços\)$/);
  assert.match(w.document.getElementById('off-placas-espessura').textContent, /8 mm: 16 · 6 mm: 16/);
});

test('trocar de bateria descarta as dimensões por berço (outros berços)', async () => {
  const w = await abrirPagina();
  w.document.getElementById('off-modal-num-inicial').style.display = 'none';
  escolher(w, 'off-bateria', 'B9');
  escolher(w, 'off-tipo-montagem', '2/P');
  w.LWOff.abrirModalDimensoes();
  w.document.getElementById('off-dim-valor').value = '9,5';
  w.LWOff.aplicarDimensaoTodos();
  w.LWOff.confirmarModalDimensoes();
  assert.match(w.document.getElementById('off-dimensao').value, /^9,5 cm \(8 berços\)$/);
  escolher(w, 'off-bateria', '');
  escolher(w, 'off-bateria', 'B9');
  assert.match(w.document.getElementById('off-dimensao').value, /^9 cm \(8 berços\)$/);
});
