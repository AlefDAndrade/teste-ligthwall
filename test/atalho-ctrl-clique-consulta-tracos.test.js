// ─── test/atalho-ctrl-clique-consulta-tracos.test.js ────────────────────────
// Pedido registrado numa conversa: "atalho no Ctrl pra jogar pra [Consulta
// de Insumos por Traço], assim como a operação joga pra Análise Focada" —
// mesmo padrão de Ctrl/⌘+clique já usado em onClickLinhaRegistro (Registro
// de Baterias → Análise Focada, dashboard.js), agora espelhado em
// onClickLinhaRelatorio (Relatório de Injeção → Consulta de Insumos por
// Traço).
//
// Cobre estruturalmente (sem precisar do boot pesado da SPA inteira via
// jsdom — mesmo raciocínio de test/operacao-offline-fila-aviso-idade.test.js):
//   - onClickLinhaRelatorio recebe `event` e checa ctrlKey/metaKey ANTES de
//     qualquer outro modo (edição/detalhe) — igual onClickLinhaRegistro já
//     fazia.
//   - o onclick inline da linha da tabela passa `event` pra função.
//   - LWConsultaTracos.abrirTracoEspecifico existe e é chamada com o
//     id_traco certo.
//   - o atalho está catalogado em REFERENCIA_CONFIG (keyboard-shortcuts.js)
//     — aparece em Configurações → Atalhos de Teclado e no modal de ajuda.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DASHBOARD_JS = fs.readFileSync(path.join(__dirname, '..', 'public/js/dashboard.js'), 'utf8');
const KEYBOARD_JS = fs.readFileSync(path.join(__dirname, '..', 'public/js/keyboard-shortcuts.js'), 'utf8');

function corpoDaFuncao(codigo, nome) {
  const inicio = codigo.indexOf(`function ${nome}(`);
  assert.ok(inicio >= 0, `não encontrei a função ${nome}`);
  const fim = codigo.indexOf('\n  }', inicio);
  assert.ok(fim > inicio, `não encontrei o fechamento da função ${nome}`);
  return codigo.slice(inicio, fim + 4);
}

test('onclick da linha do Relatório de Injeção passa o "event" pra onClickLinhaRelatorio (senão não dá pra checar ctrlKey)', () => {
  assert.match(DASHBOARD_JS, /onclick="LWDash\.onClickLinhaRelatorio\('\$\{rowId\}', event\)"/);
});

test('onClickLinhaRelatorio: Ctrl/⌘+clique abre a Consulta de Insumos por Traço, ANTES de checar o modo de edição', () => {
  const corpo = corpoDaFuncao(DASHBOARD_JS, 'onClickLinhaRelatorio');

  const posCtrl = corpo.indexOf('event.ctrlKey || event.metaKey');
  const posAbrirConsulta = corpo.indexOf('LWConsultaTracos.abrirTracoEspecifico');
  const posModoEdicao = corpo.indexOf('_modoEdicaoRelatorio');

  assert.ok(posCtrl >= 0, 'esperava a checagem de ctrlKey/metaKey');
  assert.ok(posAbrirConsulta > posCtrl, 'abrirTracoEspecifico deveria vir dentro do bloco de ctrlKey/metaKey');
  assert.ok(posModoEdicao > posAbrirConsulta, 'a checagem de ctrlKey/metaKey precisa vir ANTES da checagem de modo de edição — Ctrl+clique funciona em qualquer modo');
});

test('onClickLinhaRelatorio usa o id_traco do traço clicado (não da operação/uso)', () => {
  const corpo = corpoDaFuncao(DASHBOARD_JS, 'onClickLinhaRelatorio');
  assert.match(corpo, /dados\.traco\.id_traco/);
});

test('consulta-tracos.js expõe abrirTracoEspecifico publicamente (é isso que dashboard.js chama)', () => {
  const CONSULTA_JS = fs.readFileSync(path.join(__dirname, '..', 'public/js/consulta-tracos.js'), 'utf8');
  assert.match(CONSULTA_JS, /function abrirTracoEspecifico\(idTraco\)/);
  assert.match(CONSULTA_JS, /window\.LWConsultaTracos = \{[\s\S]*abrirTracoEspecifico[\s\S]*\};/);
});

test('atalho catalogado em REFERENCIA_CONFIG (keyboard-shortcuts.js) — aparece em Configurações → Atalhos de Teclado', () => {
  const inicio = KEYBOARD_JS.indexOf('const REFERENCIA_CONFIG = [');
  const fim = KEYBOARD_JS.indexOf('\n  ];', inicio);
  const bloco = KEYBOARD_JS.slice(inicio, fim);

  assert.match(bloco, /contexto: 'Relatório de Injeção'/);
  // O bloco inteiro da entrada (não só o texto solto) precisa citar a
  // página certa e a Consulta de Insumos — senão o item de referência
  // aponta pro lugar errado.
  const inicioEntrada = bloco.indexOf("contexto: 'Relatório de Injeção'");
  const trechoEntrada = bloco.slice(inicioEntrada - 100, inicioEntrada + 250);
  assert.match(trechoEntrada, /page: 'relatorio'/);
  assert.match(trechoEntrada, /Consulta de Insumos/);
});
