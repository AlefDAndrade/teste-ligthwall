// ─── test/placas-8mm-offline.test.js ────────────────────────────────────────
// public/js/placas-8mm.js (módulo compartilhado: offline.html + servidor) tem
// que dar EXATAMENTE o mesmo resultado que LW.calcPlacas8mm (data.js, usado
// pelo app online) — são 2 implementações da mesma regra (ver comentário no
// topo de placas-8mm.js). Usa os tipos de montagem REAIS de public/db/config.json.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const DATA_JS = fs.readFileSync(path.join(__dirname, '..', 'public/js/data.js'), 'utf8');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/db/config.json'), 'utf8'));
const OPCOES = CONFIG.tipos_montagem.opcoes;
const placas = require('../public/js/placas-8mm.js');

function criarLW() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'dangerously' });
  dom.window.eval(DATA_JS);
  dom.window.LW.aplicarTiposMontagemEmMemoria(OPCOES);
  return dom.window.LW;
}

const dimsMista = Array.from({ length: 20 }, (_, i) => (i < 10 ? '9,5 cm' : null));

const CENARIOS = [
  { nome: 'Simples 2/P, bateria toda 9,5 cm', tipoMontagem: '2/P', capacidade: 20, dimensaoGeral: '9,5 cm' },
  { nome: 'Simples 2/P, mista 9,5 + 9', tipoMontagem: '2/P', capacidade: 20, dimensaoGeral: '9 cm', bercosDimensoes: dimsMista },
  { nome: 'Simples S/P (não leva placa), mista', tipoMontagem: 'S/P', capacidade: 20, dimensaoGeral: '9 cm', bercosDimensoes: dimsMista },
  { nome: 'Híbrida 2p/sp, mista', tipoMontagem: 'HÍBRIDA 2p/sp', capacidade: 20, dimensaoGeral: '9 cm', bercosDimensoes: dimsMista },
  { nome: 'Híbrida com Não Enchido nos dois lados', tipoMontagem: 'HÍBRIDA 2p/sp', capacidade: 4, dimensaoGeral: '9,5 cm',
    marcacoes: { B1: { direita: 'nao_enchido', esquerda: 'nao_enchido' }, B3: { esquerda: 'nao_enchido' } } },
  { nome: 'Personalizada com berço separado e vazio, mista', tipoMontagem: 'PERSONALIZADA', capacidade: 4, dimensaoGeral: '9 cm',
    bercosPersonalizados: ['2p', { direita: '2p', esquerda: 'sp' }, null, 'sp'], bercosDimensoes: ['9,5 cm', '9,5 cm', '9,5 cm', null],
    marcacoes: { B1: { direita: 'nao_enchido', tipos: { direita: '2p' } } } },
  { nome: 'Sem nenhum berço de 9,5 cm', tipoMontagem: '2/P', capacidade: 20, dimensaoGeral: '9 cm' },
];

for (const c of CENARIOS) {
  test(`paridade data.js × placas-8mm.js: ${c.nome}`, () => {
    const LW = criarLW();
    const esperado = LW.calcPlacas8mm(c);
    const obtido = placas.calcPlacas8mm({ ...c, montagemOpcoes: OPCOES });
    assert.equal(obtido, esperado);
  });
}

test('placas-8mm.js: valores conhecidos (2/P mista 10 berços de 9,5 cm = 10 × 2 painéis × 2 placas)', () => {
  const n = placas.calcPlacas8mm({ tipoMontagem: '2/P', capacidade: 20, dimensaoGeral: '9 cm', bercosDimensoes: dimsMista, montagemOpcoes: OPCOES });
  assert.equal(n, 40);
});

test('placas-8mm.js: rotulo e dimensões distintas', () => {
  assert.equal(placas.rotuloDimensoesMistas(20, '9 cm', dimsMista), 'Personalizada / 9,5 cm + 9 cm');
  assert.equal(placas.rotuloDimensoesMistas(20, '9 cm', null), null);
});
