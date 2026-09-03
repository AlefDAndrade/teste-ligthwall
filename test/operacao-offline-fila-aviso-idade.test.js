// ─── test/operacao-offline-fila-aviso-idade.test.js ─────────────────────────
// README, item "8. Coisas a decidir/ter em mente...": "Expiração — um
// pendente que nunca sincroniza (dispositivo trocado, localStorage limpo)
// fica preso pra sempre nesse navegador — não implementado. Continua em
// aberto se cabe algum aviso/expiração automática, ou se fica como
// responsabilidade manual de quem usa o dispositivo."
//
// Decisão tomada (ver public/js/offline-operacao.js, seção "Aviso de item
// preso"): NUNCA apagar nada sozinho (um pendente é um registro real de
// operação — apagar à toa seria perder trabalho de verdade). Em vez disso,
// só tornar VISÍVEL quando algo está esperando envio há tempo demais
// (LIMIAR_AVISO_HORAS = 24h), pra quem usa o aparelho notar e agir. A
// decisão de descartar continua manual (botão "✕ Descartar", já existia).
//
// `formatarIdade`/`idadeEmHoras` são funções puras (só Date/Math, sem DOM)
// — extraídas do arquivo real via string e avaliadas isoladamente, mesmo
// espírito de test/analise-focada-pdf-pagina-unica.test.js (evita precisar
// simular as dezenas de dependências de DOM/config que o resto do arquivo
// tem só pra testar uma conta de datas).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CODIGO = fs.readFileSync(path.join(__dirname, '..', 'public/js/offline-operacao.js'), 'utf8');

function extrairFuncao(nome) {
  const inicio = CODIGO.indexOf(`function ${nome}(`);
  assert.ok(inicio >= 0, `não encontrei a função ${nome} em offline-operacao.js`);
  const fim = CODIGO.indexOf('\n  }', inicio);
  assert.ok(fim > inicio, `não encontrei o fechamento da função ${nome}`);
  return CODIGO.slice(inicio, fim + 4);
}

function montarHelpers() {
  // eslint-disable-next-line no-eval
  const formatarIdade = eval(`(${extrairFuncao('formatarIdade')})`);
  // eslint-disable-next-line no-eval
  const idadeEmHoras = eval(`(${extrairFuncao('idadeEmHoras')})`);
  return { formatarIdade, idadeEmHoras };
}

test('formatarIdade: minutos, horas e dias — sempre a unidade mais legível, nunca segundos', () => {
  const { formatarIdade } = montarHelpers();
  const agora = Date.now();

  assert.equal(formatarIdade(new Date(agora - 30 * 1000).toISOString()), 'há 1 minuto', 'menos de 1 minuto ainda arredonda pra "1 minuto", nunca "0 minutos"');
  assert.equal(formatarIdade(new Date(agora - 5 * 60000).toISOString()), 'há 5 minutos');
  assert.equal(formatarIdade(new Date(agora - 1 * 3600000).toISOString()), 'há 1 hora');
  assert.equal(formatarIdade(new Date(agora - 3 * 3600000).toISOString()), 'há 3 horas');
  assert.equal(formatarIdade(new Date(agora - 25 * 3600000).toISOString()), 'há 1 dia');
  assert.equal(formatarIdade(new Date(agora - 50 * 3600000).toISOString()), 'há 2 dias');
});

test('formatarIdade: data inválida/futura não quebra — devolve string vazia em vez de "NaN minutos"', () => {
  const { formatarIdade } = montarHelpers();
  assert.equal(formatarIdade('data-invalida'), '');
  assert.equal(formatarIdade(new Date(Date.now() + 60000).toISOString()), '', 'timestamp no futuro (relógio do aparelho dessincronizado) não deveria virar idade negativa');
});

test('idadeEmHoras: base pro limiar de aviso (24h) — confere a conta em horas exatas', () => {
  const { idadeEmHoras } = montarHelpers();
  const agora = Date.now();
  assert.ok(Math.abs(idadeEmHoras(new Date(agora - 12 * 3600000).toISOString()) - 12) < 0.01);
  assert.ok(Math.abs(idadeEmHoras(new Date(agora - 48 * 3600000).toISOString()) - 48) < 0.01);
});

test('LIMIAR_AVISO_HORAS existe e é usado pra decidir quando destacar um item da fila como "há muito tempo"', () => {
  assert.match(CODIGO, /const LIMIAR_AVISO_HORAS = 24;/);
  assert.match(CODIGO, /idadeEmHoras\(p\.atualizadoEm\) >= LIMIAR_AVISO_HORAS/);
});

test('renderFila avisa (mas nunca apaga) um item antigo — texto explica o que fazer, sem sumir sozinho', () => {
  const trechoRenderFila = CODIGO.slice(CODIGO.indexOf('function renderFila('), CODIGO.indexOf('function descartarDaFila('));
  assert.match(trechoRenderFila, /Aguardando envio há muito tempo/);
  assert.match(trechoRenderFila, /confira a conexão/);
  // Nunca deveria remover/filtrar a fila só por causa da idade — o único
  // jeito de sumir com um item continua sendo o botão "Descartar" (ação
  // manual e explícita).
  assert.doesNotMatch(trechoRenderFila, /removerDaFila/, 'renderFila é só leitura/exibição — remover é responsabilidade exclusiva de descartarDaFila');
});
