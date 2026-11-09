// ─── test/ajuste-traco.test.js ──────────────────────────────────────────────
// Ajuste de traço (popover "🎯 Ajuste de Traço" em Registrar Operação) —
// public/js/ajuste-traco.js.
//   1) funções puras (planejamento das doses, avisos, calibração, CSV);
//   2) ligação com o DOM, usando o markup REAL de partials/page-operacao.html
//      (se um id mudar lá sem mudar no JS, o teste quebra).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ajuste = require('../public/js/ajuste-traco.js');

const RAIZ = path.join(__dirname, '..', 'public');
const CODIGO = fs.readFileSync(path.join(RAIZ, 'js', 'ajuste-traco.js'), 'utf8');
const PARTIAL = fs.readFileSync(path.join(RAIZ, 'partials', 'page-operacao.html'), 'utf8');
const TEMPLATE = fs.readFileSync(path.join(RAIZ, 'index.template.html'), 'utf8');
const CSS = fs.readFileSync(path.join(RAIZ, 'css', 'styles.css'), 'utf8');

const P = ajuste.PARAMS_PADRAO;

// ── 1) Funções puras ────────────────────────────────────────────────────────

test('planejar: leitura dentro da tolerância não pede nenhum ajuste', () => {
  const { a } = ajuste.planejar(38, 450, 38, 450, 1050, P);
  assert.deepEqual(a, { c: 0, w: 0, s: 0, e: 0 });
});

test('planejar: flow alto → só cimento, e a previsão cai dentro da tolerância', () => {
  const { a, fin } = ajuste.planejar(45, 440, 38, 450, 1050, P);
  assert.equal(a.c, 44);
  assert.equal(a.w + a.s + a.e, 0);
  assert.ok(Math.abs(fin.f - 38) <= P.tolF);
  assert.ok(Math.abs(fin.d - 450) <= P.tolD);
});

test('planejar: flow baixo → água + superplastificante', () => {
  const { a, fin } = ajuste.planejar(30, 430, 38, 450, 1050, P);
  assert.equal(a.c, 0);
  assert.ok(a.w > 0 && a.s > 0);
  assert.ok(Math.abs(fin.f - 38) <= P.tolF);
});

test('planejar: densidade alta → EPS, em passos de 0,5 kg', () => {
  const { a } = ajuste.planejar(40, 500, 38, 450, 1050, P);
  assert.ok(a.e > 0);
  assert.equal(a.e * 2, Math.round(a.e * 2));
});

test('planejar: densidade baixa → cimento', () => {
  const { a, fin } = ajuste.planejar(38, 380, 38, 450, 1050, P);
  assert.ok(a.c > 0);
  assert.ok(fin.d > 380);
});

test('planejar: traço com menos cimento escala as doses (metade do cimento → ~metade da dose)', () => {
  const cheio = ajuste.planejar(45, 440, 38, 450, 1050, P);
  const metade = ajuste.planejar(45, 440, 38, 450, 525, P);
  assert.equal(metade.k, 2);
  assert.ok(Math.abs(metade.a.c - cheio.a.c / 2) <= 1);
});

test('planejar: sem coeficientes informados usa PARAMS_PADRAO', () => {
  assert.deepEqual(ajuste.planejar(45, 440, 38, 450, 1050), ajuste.planejar(45, 440, 38, 450, 1050, P));
});

test('preverEstado: sem doses a previsão é a própria leitura', () => {
  assert.deepEqual(ajuste.preverEstado(40, 450, 1, { c: 0, w: 0, s: 0, e: 0 }, P), { f: 40, d: 450 });
});

test('validarLeitura: aceita a faixa esperada e recusa o que parece erro de digitação', () => {
  assert.equal(ajuste.validarLeitura(45, 440), null);
  assert.match(ajuste.validarLeitura(450, 440), /flow entre 20 e 70/);
  assert.match(ajuste.validarLeitura(45, 44), /densidade entre 350 e 600/);
  assert.equal(ajuste.validarLeitura(20, 350), null);
  assert.equal(ajuste.validarLeitura(70, 600), null);
  assert.ok(ajuste.validarLeitura(19.9, 440));
  assert.ok(ajuste.validarLeitura(45, 600.1));
});

test('formatar / formatarComSinal: pt-BR, com sinal explícito', () => {
  assert.equal(ajuste.formatar(1050.5, 1), '1.050,5');
  assert.equal(ajuste.formatar(44), '44');
  assert.equal(ajuste.formatarComSinal(1.5), '+1,5');
  assert.equal(ajuste.formatarComSinal(-1.5), '−1,5');
  assert.equal(ajuste.formatarComSinal(0), '0,0');
  assert.equal(ajuste.formatarComSinal(15.4, 0), '+15');
});

test('lerNumero: aceita vírgula; vazio e texto viram NaN', () => {
  assert.equal(ajuste.lerNumero('38,5'), 38.5);
  assert.equal(ajuste.lerNumero(' 7 '), 7);
  assert.ok(isNaN(ajuste.lerNumero('')));
  assert.ok(isNaN(ajuste.lerNumero(undefined)));
  assert.ok(isNaN(ajuste.lerNumero('abc')));
});

test('descreverDoses: só entram os insumos com dose; a observação do SP muda se houver água', () => {
  const so = ajuste.descreverDoses({ c: 44, w: 0, s: 0, e: 0 }, 1, P);
  assert.deepEqual(so.map(l => l.id), ['cimento']);
  assert.equal(so[0].valor, 44);

  const todos = ajuste.descreverDoses({ c: 10, w: 20, s: 0.3, e: 2 }, 1, P);
  assert.deepEqual(todos.map(l => l.id), ['cimento', 'agua', 'sp', 'eps']);
  assert.match(todos.find(l => l.id === 'sp').ref, /com água/);

  const spSozinho = ajuste.descreverDoses({ c: 0, w: 0, s: 0.2, e: 0 }, 1, P);
  assert.match(spSozinho[0].ref, /só com SP/);

  assert.deepEqual(ajuste.descreverDoses({ c: 0, w: 0, s: 0, e: 0 }, 1, P), []);
});

test('avisosDoPlano: sem aviso quando a previsão fica dentro da tolerância', () => {
  const plano = ajuste.planejar(45, 440, 38, 450, 1050, P);
  assert.deepEqual(ajuste.avisosDoPlano(plano, 38, 450, P), []);
});

test('avisosDoPlano: previsão fora da tolerância, dose alta e cimento acima do já visto', () => {
  const fora = { a: { c: 10, w: 0, s: 0, e: 0 }, k: 1, fin: { f: 50, d: 450 } };
  assert.match(ajuste.avisosDoPlano(fora, 38, 450, P).join(' '), /fora da tolerância/);

  const alta = { a: { c: 71, w: 0, s: 0, e: 0 }, k: 1, fin: { f: 38, d: 450 } };
  const textoAlta = ajuste.avisosDoPlano(alta, 38, 450, P).join(' ');
  assert.match(textoAlta, /Dose alta/);
  assert.doesNotMatch(textoAlta, /maior cimento/);

  const enorme = { a: { c: 107, w: 0, s: 0, e: 0 }, k: 1, fin: { f: 38, d: 450 } };
  assert.match(ajuste.avisosDoPlano(enorme, 38, 450, P).join(' '), /maior cimento/);
});

function registroSoCimento(n, deltaFlow) {
  return Array.from({ length: n }, () => ({ f0: 45, d0: 440, f1: 45 + deltaFlow, d1: 455, base: 1050, c: 20, w: 0, s: 0, e: 0 }));
}

test('calibrar: com menos de 5 registros de um insumo só, nada muda', () => {
  const r = ajuste.calibrar(registroSoCimento(4, -3), P);
  assert.deepEqual(r.params, { ...P });
  assert.deepEqual(r.atualizados, []);
  assert.equal(r.contagem.cimento, 4);
});

test('calibrar: com 5 registros só de cimento, usa a mediana do efeito por kg', () => {
  const r = ajuste.calibrar(registroSoCimento(5, -3), P);
  assert.equal(r.params.cimF, -0.15); // -3 / (20 kg * 1)
  assert.match(r.atualizados[0], /cimento -0.15 cm\/kg \(5\)/);
  assert.equal(r.params.spF, P.spF); // o resto continua igual
});

test('calibrar: registro que mistura insumos não entra (não isola o efeito)', () => {
  const misturado = registroSoCimento(5, -3).map(e => ({ ...e, w: 10 }));
  assert.equal(ajuste.calibrar(misturado, P).contagem.cimento, 0);
});

test('calibrar: escala pelo cimento real do traço e não altera o objeto original', () => {
  const reg = registroSoCimento(5, -3).map(e => ({ ...e, base: 525 })); // k = 2
  const antes = { ...P };
  const r = ajuste.calibrar(reg, P);
  assert.equal(r.params.cimF, -0.075); // -3 / (20 * 2)
  assert.deepEqual({ ...P }, antes);
});

test('registroParaCsv: cabeçalho + uma linha por registro, separados por ";"', () => {
  assert.equal(ajuste.registroParaCsv([]), 'data;flow_ini;dens_ini;flow_fim;dens_fim;cimento_base;cimento;agua;sp;eps');
  const csv = ajuste.registroParaCsv([{ t: '2026-11-08 12:00', f0: 45, d0: 440, f1: 38, d1: 450, base: 1050, c: 44, w: 0, s: 0, e: 0 }]);
  assert.equal(csv.split('\n')[1], '2026-11-08 12:00;45;440;38;450;1050;44;0;0;0');
});

test('resumirInsumos: lista só o que foi usado; vazio vira "só tempo"', () => {
  assert.equal(ajuste.resumirInsumos({ c: 20, w: 0, s: 0.3, e: 0 }), 'cim 20, SP 0.3');
  assert.equal(ajuste.resumirInsumos({ c: 0, w: 0, s: 0, e: 0 }), 'só tempo');
});

test('todo coeficiente tem rótulo, e os coeficientes padrão não podem ser alterados por fora', () => {
  assert.deepEqual(Object.keys(ajuste.ROTULOS).sort(), Object.keys(P).sort());
  assert.throws(() => { 'use strict'; P.cimF = 1; }, TypeError);
});

// ── 2) Ligação com o DOM ────────────────────────────────────────────────────

let dom;
let doc;
let storage;

function criarStorage(inicial) {
  const m = new Map(Object.entries(inicial || {}));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), mapa: m };
}

function montarDom(storageInicial) {
  dom = new JSDOM('<!DOCTYPE html><html><body>' + PARTIAL + '</body></html>');
  dom.window.confirm = () => true;
  doc = dom.window.document;
  storage = criarStorage(storageInicial);
  return ajuste.montar(doc, { storage });
}

beforeEach(() => montarDom());
afterEach(() => dom.window.close());

const $ = id => doc.getElementById(id);
function digitar(id, valor) {
  const inp = $(id);
  inp.value = String(valor);
  inp.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}
function clicar(id) { $(id).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); }

test('montar: é idempotente (a 2ª chamada não faz nada)', () => {
  assert.equal(ajuste.montar(doc, { storage }), null);
});

test('montar: sem a ferramenta na página não faz nada nem quebra', () => {
  const vazio = new JSDOM('<!DOCTYPE html><body></body>').window.document;
  assert.equal(ajuste.montar(vazio), null);
});

test('botão no cabeçalho do card "Traços de Injeção" abre o popover pelo togglePopover', () => {
  const btn = $('btn-ajuste-traco');
  assert.ok(btn);
  assert.match(btn.getAttribute('onclick'), /LWOp\.togglePopover\('popover-ajuste-traco', event\)/);
  const cabecalho = btn.closest('.card-title');
  assert.ok(cabecalho, 'o botão deve estar no .card-title');
  assert.match(cabecalho.textContent, /Traços de Injeção/);
  const popover = $('popover-ajuste-traco');
  assert.ok(popover.classList.contains('ao-popover'));
  assert.ok(cabecalho.contains(popover));
});

test('popover fica fechado ao carregar (só abre pelo botão)', () => {
  assert.equal($('popover-ajuste-traco').classList.contains('active'), false);
});

test('sem leitura: pede para digitar flow e densidade', () => {
  assert.match($('ajt-resultado').textContent, /Digite flow e densidade medidos/);
});

test('flow alto: sugere cimento e pré-preenche o "o que foi usado" com a sugestão', () => {
  digitar('ajt-flow', 45);
  digitar('ajt-dens', 440);
  const txt = $('ajt-resultado').textContent;
  assert.match(txt, /Adicione/);
  assert.match(txt, /Cimento/);
  assert.match(txt, /44/);
  assert.match(txt, /Batida extra: \+1 min/);
  assert.equal($('ajt-uso-cimento').value, '44');
  assert.equal($('ajt-uso-agua').value, '0');
  assert.equal(doc.querySelectorAll('#ajt-resultado .ajt-medidor').length, 2);
});

test('aceita vírgula decimal nos campos', () => {
  digitar('ajt-flow', '45,0');
  digitar('ajt-dens', '440');
  assert.match($('ajt-resultado').textContent, /Cimento/);
});

test('leitura fora da faixa: avisa em vez de sugerir', () => {
  digitar('ajt-flow', 450);
  digitar('ajt-dens', 440);
  assert.match($('ajt-resultado').textContent, /Leitura fora do esperado/);
  assert.doesNotMatch($('ajt-resultado').textContent, /Adicione/);
});

test('dentro da tolerância: diz que não precisa ajustar', () => {
  digitar('ajt-flow', 38);
  digitar('ajt-dens', 450);
  assert.match($('ajt-resultado').textContent, /Dentro da tolerância/);
});

test('mudar o cimento do traço recalcula a dose', () => {
  digitar('ajt-flow', 45);
  digitar('ajt-dens', 440);
  const cheio = $('ajt-uso-cimento').value;
  digitar('ajt-cimento-base', 525);
  assert.notEqual($('ajt-uso-cimento').value, cheio);
});

test('salvar registro: exige as leituras, grava no storage e aparece na tabela', () => {
  digitar('ajt-flow', 45);
  digitar('ajt-dens', 440);
  clicar('ajt-btn-salvar');
  assert.match($('ajt-msg').textContent, /Preencha a leitura inicial/);
  assert.equal(storage.mapa.has(ajuste.CHAVE_REGISTRO), false);

  digitar('ajt-depois-flow', 38);
  digitar('ajt-depois-dens', 450);
  clicar('ajt-btn-salvar');
  assert.match($('ajt-msg').textContent, /Registro salvo/);
  assert.equal($('ajt-depois-flow').value, '');
  const salvo = JSON.parse(storage.mapa.get(ajuste.CHAVE_REGISTRO));
  assert.equal(salvo.length, 1);
  assert.equal(salvo[0].f0, 45);
  assert.equal(salvo[0].f1, 38);
  assert.equal(salvo[0].c, 44);
  assert.match($('ajt-registro').textContent, /45→38/);
  assert.match($('ajt-registro').textContent, /cim 44/);
});

test('registro salvo volta ao reabrir a página (mesmo storage)', () => {
  digitar('ajt-flow', 45);
  digitar('ajt-dens', 440);
  digitar('ajt-depois-flow', 38);
  digitar('ajt-depois-dens', 450);
  clicar('ajt-btn-salvar');
  const guardado = Object.fromEntries(storage.mapa);
  dom.window.close();
  montarDom(guardado);
  assert.match($('ajt-registro').textContent, /45→38/);
});

test('registro com texto malicioso no storage não vira HTML', () => {
  dom.window.close();
  const lixo = [{ t: '2026-11-08 <img src=x onerror=alert(1)>', f0: 45, d0: 440, f1: 38, d1: 450, base: 1050, c: 1, w: 0, s: 0, e: 0 }];
  montarDom({ [ajuste.CHAVE_REGISTRO]: JSON.stringify(lixo) });
  assert.equal($('ajt-registro').querySelector('img'), null);
});

test('storage corrompido não quebra a ferramenta (cai nos valores padrão)', () => {
  dom.window.close();
  montarDom({ [ajuste.CHAVE_PARAMS]: '{quebrado', [ajuste.CHAVE_REGISTRO]: '[[[' });
  digitar('ajt-flow', 45);
  digitar('ajt-dens', 440);
  assert.match($('ajt-resultado').textContent, /Cimento/);
  assert.match($('ajt-registro').textContent, /Nenhum registro ainda/);
});

test('CSV e limpar registro', () => {
  digitar('ajt-flow', 45);
  digitar('ajt-dens', 440);
  digitar('ajt-depois-flow', 38);
  digitar('ajt-depois-dens', 450);
  clicar('ajt-btn-salvar');

  assert.equal($('ajt-csv').hidden, true);
  clicar('ajt-btn-csv');
  assert.equal($('ajt-csv').hidden, false);
  assert.match($('ajt-csv').value, /^data;flow_ini;/);
  assert.match($('ajt-csv').value, /;45;440;38;450;1050;44;0;0;0$/);

  clicar('ajt-btn-limpar');
  assert.match($('ajt-registro').textContent, /Nenhum registro ainda/);
  assert.equal(JSON.parse(storage.mapa.get(ajuste.CHAVE_REGISTRO)).length, 0);
});

test('calibração: mostra todos os coeficientes; editar um muda o resultado e é guardado', () => {
  assert.equal(doc.querySelectorAll('#ajt-params input[data-param]').length, Object.keys(P).length);
  digitar('ajt-flow', 45);
  digitar('ajt-dens', 440);
  const antes = $('ajt-uso-cimento').value;

  const campo = doc.querySelector('#ajt-params input[data-param="cimF"]');
  campo.value = '-0,3';
  campo.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(JSON.parse(storage.mapa.get(ajuste.CHAVE_PARAMS)).cimF, -0.3);
  assert.notEqual($('ajt-uso-cimento').value, antes);

  clicar('ajt-btn-restaurar');
  assert.match($('ajt-msg-calibracao').textContent, /Valores padrão restaurados/);
  assert.equal($('ajt-uso-cimento').value, antes);
  assert.equal(doc.querySelector('#ajt-params input[data-param="cimF"]').value, String(P.cimF));
});

test('calibração: coeficiente inválido digitado é ignorado', () => {
  const campo = doc.querySelector('#ajt-params input[data-param="cimF"]');
  campo.value = 'abc';
  campo.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(storage.mapa.has(ajuste.CHAVE_PARAMS), false);
});

test('calibrar com o registro: avisa quando faltam registros', () => {
  clicar('ajt-btn-calibrar');
  assert.match($('ajt-msg-calibracao').textContent, /pelo menos 5 registros/);
  assert.match($('ajt-msg-calibracao').textContent, /cimento 0, SP 0, EPS 0/);
});

test('calibrar com o registro: com 5 ajustes só de cimento atualiza o coeficiente', () => {
  const reg = registroSoCimento(5, -3).map(e => ({ ...e, t: '2026-11-08 12:00' }));
  dom.window.close();
  montarDom({ [ajuste.CHAVE_REGISTRO]: JSON.stringify(reg) });
  clicar('ajt-btn-calibrar');
  assert.match($('ajt-msg-calibracao').textContent, /Atualizado: cimento -0.15 cm\/kg \(5\)/);
  assert.equal(JSON.parse(storage.mapa.get(ajuste.CHAVE_PARAMS)).cimF, -0.15);
});

// ── 2b) Leitura automática do traço ─────────────────────────────────────────

test('converterLeitura: flow do traço (mm) vira cm; densidade segue em kg/m³; vírgula decimal', () => {
  assert.deepEqual(ajuste.converterLeitura({ flowMm: 380, densidade: 450 }), { flow: '38', dens: '450' });
  assert.deepEqual(ajuste.converterLeitura({ flowMm: '385', densidade: '452.5' }), { flow: '38,5', dens: '452,5' });
  assert.deepEqual(ajuste.converterLeitura({ flowMm: '385,5', densidade: '450,25' }), { flow: '38,55', dens: '450,25' });
  assert.equal(ajuste.MM_POR_CM, 10);
});

test('converterLeitura: vazio, zero, texto e ausência viram campo vazio', () => {
  const vazio = { flow: '', dens: '' };
  assert.deepEqual(ajuste.converterLeitura({ flowMm: '', densidade: '' }), vazio);
  assert.deepEqual(ajuste.converterLeitura({ flowMm: 0, densidade: 0 }), vazio);
  assert.deepEqual(ajuste.converterLeitura({ flowMm: 'abc', densidade: null }), vazio);
  assert.deepEqual(ajuste.converterLeitura({}), vazio);
  assert.deepEqual(ajuste.converterLeitura(undefined), vazio);
  assert.deepEqual(ajuste.converterLeitura({ flowMm: 380, densidade: '' }), { flow: '38', dens: '' });
});

test('descreverOrigem: frase certa para cada caso (sem rótulo = sem frase)', () => {
  assert.equal(ajuste.descreverOrigem('', '38', '450'), '');
  assert.match(ajuste.descreverOrigem('Traço 2', '38', '450'), /Leitura do Traço 2, preenchida automaticamente \(flow convertido de mm para cm\)\.$/);
  assert.match(ajuste.descreverOrigem('Traço 2', '', '450'), /Falta o flow\.$/);
  assert.match(ajuste.descreverOrigem('Traço 2', '38', ''), /Falta a densidade\.$/);
  assert.match(ajuste.descreverOrigem('Traço 2', '', ''), /Traço 2 ainda sem flow e densidade medidos/);
});

test('preencherLeitura: preenche flow (mm→cm) e densidade, recalcula e diz de onde vieram', () => {
  assert.equal(ajuste.preencherLeitura({ rotulo: 'Traço 1', flowMm: 450, densidade: 440 }), true);
  assert.equal($('ajt-flow').value, '45');
  assert.equal($('ajt-dens').value, '440');
  assert.match($('ajt-origem').textContent, /Leitura do Traço 1, preenchida automaticamente/);
  assert.match($('ajt-resultado').textContent, /Cimento/); // 45 cm / 440 → sugere cimento, sem digitar nada
});

test('preencherLeitura: leitura dentro do alvo diz que não precisa ajustar', () => {
  ajuste.preencherLeitura({ rotulo: 'Traço 1', flowMm: 380, densidade: 450 });
  assert.match($('ajt-resultado').textContent, /Dentro da tolerância/);
});

test('preencherLeitura: mesma leitura de novo não apaga o que a pessoa digitou aqui; forçar apaga', () => {
  const leitura = { rotulo: 'Traço 1', flowMm: 450, densidade: 440 };
  ajuste.preencherLeitura(leitura);
  digitar('ajt-flow', 30);
  assert.match($('ajt-origem').textContent, /Valores alterados aqui — o traço não é modificado/);

  assert.equal(ajuste.preencherLeitura(leitura), false);
  assert.equal($('ajt-flow').value, '30');

  assert.equal(ajuste.preencherLeitura(leitura, true), true);
  assert.equal($('ajt-flow').value, '45');
  assert.match($('ajt-origem').textContent, /preenchida automaticamente/);
});

test('preencherLeitura: leitura nova (ou outro traço, mesmo com valores iguais) sobrescreve', () => {
  ajuste.preencherLeitura({ rotulo: 'Traço 1', flowMm: 450, densidade: 440 });
  assert.equal(ajuste.preencherLeitura({ rotulo: 'Traço 1', flowMm: 420, densidade: 440 }), true);
  assert.equal($('ajt-flow').value, '42');
  assert.equal(ajuste.preencherLeitura({ rotulo: 'Traço 2', flowMm: 420, densidade: 440 }), true);
  assert.match($('ajt-origem').textContent, /Traço 2/);
});

test('preencherLeitura: traço sem medição limpa os campos (não deixa a leitura de outro traço) e avisa', () => {
  ajuste.preencherLeitura({ rotulo: 'Traço 1', flowMm: 450, densidade: 440 });
  ajuste.preencherLeitura({ rotulo: 'Traço 2', flowMm: '', densidade: '' });
  assert.equal($('ajt-flow').value, '');
  assert.equal($('ajt-dens').value, '');
  assert.match($('ajt-origem').textContent, /Traço 2 ainda sem flow e densidade medidos/);
  assert.match($('ajt-resultado').textContent, /Digite flow e densidade medidos/);
});

test('sem leitura automática a nota de origem fica vazia (e escondida pelo CSS :empty)', () => {
  assert.equal($('ajt-origem').textContent, '');
  assert.match(CSS, /\.ajt-origem:empty\s*\{\s*display:\s*none/);
});

test('preencherLeitura do módulo devolve false quando a ferramenta não está montada na página', () => {
  const caminho = require.resolve('../public/js/ajuste-traco.js');
  delete require.cache[caminho];
  const novo = require('../public/js/ajuste-traco.js');
  assert.equal(novo.preencherLeitura({ rotulo: 'Traço 1', flowMm: 450, densidade: 440 }), false);
});

// ── 3) Consistência markup × código × estilos ───────────────────────────────

test('todo id #ajt-* que o código usa existe no partial', () => {
  const usados = new Set([...CODIGO.matchAll(/'(ajt-[a-z-]+)'/g)].map(m => m[1]));
  assert.ok(usados.size >= 15);
  for (const id of usados) assert.ok($(id), 'falta #' + id + ' em page-operacao.html');
});

test('o partial de Operação não tem ids repetidos', () => {
  const ids = [...doc.querySelectorAll('[id]')].map(e => e.id);
  const repetidos = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(repetidos)], []);
});

test('o script entra no index.template.html, depois do operacao.js (que define o LWOp)', () => {
  const posAjuste = TEMPLATE.indexOf('js/ajuste-traco.js');
  assert.ok(posAjuste > 0);
  assert.ok(TEMPLATE.indexOf('js/operacao.js') < posAjuste);
});

test('todas as classes .ajt-* do markup e do código têm estilo no styles.css', () => {
  const classes = new Set();
  for (const texto of [PARTIAL, CODIGO]) {
    for (const m of texto.matchAll(/class="([^"]*)"/g)) {
      m[1].split(/\s+/).filter(c => c.startsWith('ajt')).forEach(c => classes.add(c));
    }
  }
  assert.ok(classes.size > 10);
  for (const c of classes) assert.ok(CSS.includes('.' + c), 'falta estilo para .' + c);
});
