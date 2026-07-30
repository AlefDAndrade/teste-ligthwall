// ─── test/logger.test.js ─────────────────────────────────────────────────
// Cobre lib/logger.js: formato da linha, roteamento por nível
// (log/warn/error) e o filtro por LOG_LEVEL.

const { test } = require('node:test');
const assert = require('node:assert/strict');

function comConsoleCapturado(fn) {
  const chamadas = { log: [], warn: [], error: [] };
  const originais = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => chamadas.log.push(a.join(' '));
  console.warn = (...a) => chamadas.warn.push(a.join(' '));
  console.error = (...a) => chamadas.error.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = originais.log;
    console.warn = originais.warn;
    console.error = originais.error;
  }
  return chamadas;
}

test('logger.info formata timestamp ISO + nível + contexto + mensagem, e sai em console.log', () => {
  delete require.cache[require.resolve('../lib/logger.js')];
  const logger = require('../lib/logger.js');
  const chamadas = comConsoleCapturado(() => {
    logger.info('backup', 'backup automático criado');
  });
  assert.equal(chamadas.log.length, 1);
  assert.equal(chamadas.warn.length, 0);
  assert.equal(chamadas.error.length, 0);
  const linha = chamadas.log[0];
  assert.match(linha, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] \[backup\] backup automático criado$/);
});

test('logger.error sai em console.error, e dados extra (objeto) vira JSON no final da linha', () => {
  delete require.cache[require.resolve('../lib/logger.js')];
  const logger = require('../lib/logger.js');
  const chamadas = comConsoleCapturado(() => {
    logger.error('auth', 'security.json indisponível', { erro: 'JSON inválido' });
  });
  assert.equal(chamadas.error.length, 1);
  assert.equal(chamadas.log.length, 0);
  assert.match(chamadas.error[0], /\[ERROR\] \[auth\] security\.json indisponível \{"erro":"JSON inválido"\}$/);
});

test('logger.warn sai em console.warn', () => {
  delete require.cache[require.resolve('../lib/logger.js')];
  const logger = require('../lib/logger.js');
  const chamadas = comConsoleCapturado(() => {
    logger.warn('push', 'Falha ao enviar');
  });
  assert.equal(chamadas.warn.length, 1);
});

test('dados do tipo Error mostram só a .message, não o objeto Error inteiro', () => {
  delete require.cache[require.resolve('../lib/logger.js')];
  const logger = require('../lib/logger.js');
  const chamadas = comConsoleCapturado(() => {
    logger.error('push', 'Falha ao enviar', new Error('endpoint expirado'));
  });
  assert.match(chamadas.error[0], /— endpoint expirado$/);
});

test('LOG_LEVEL=warn silencia logger.info e logger.debug, mas deixa warn/error passarem', () => {
  const anterior = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'warn';
  delete require.cache[require.resolve('../lib/logger.js')];
  const logger = require('../lib/logger.js');
  const chamadas = comConsoleCapturado(() => {
    logger.debug('x', 'não deveria aparecer');
    logger.info('x', 'não deveria aparecer');
    logger.warn('x', 'deveria aparecer');
    logger.error('x', 'deveria aparecer');
  });
  assert.equal(chamadas.log.length, 0);
  assert.equal(chamadas.warn.length, 1);
  assert.equal(chamadas.error.length, 1);
  if (anterior === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = anterior;
  delete require.cache[require.resolve('../lib/logger.js')];
});

test('logger.raw imprime o texto puro, sem timestamp/nível, via console.log', () => {
  delete require.cache[require.resolve('../lib/logger.js')];
  const logger = require('../lib/logger.js');
  const chamadas = comConsoleCapturado(() => {
    logger.raw('Senha inicial do Administrador: abc123');
  });
  assert.deepEqual(chamadas.log, ['Senha inicial do Administrador: abc123']);
});
