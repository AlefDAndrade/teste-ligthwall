// ─── lib/logger.js — Logger estruturado mínimo ─────────────────────────────
// Substitui os console.log/console.error espalhados pelo código por
// chamadas com NÍVEL (debug/info/warn/error) e CONTEXTO (uma tag curta
// indicando de onde vem a mensagem, ex: 'auth', 'backup', 'push') — sem
// adicionar nenhuma dependência nova.
//
// Cada linha sai formatada como:
//   2026-07-30T14:32:10.123Z [INFO] [backup] backup automático criado {"arquivo":"..."}
//
// O nível mínimo é configurável via variável de ambiente LOG_LEVEL
// (debug|info|warn|error, default 'info') — dá pra silenciar debug em
// produção, ou pedir tudo numa investigação, sem editar uma linha de
// código, só reiniciando o processo com LOG_LEVEL=debug.
//
// Uso típico:
//   const logger = require('../logger'); // ou './logger' dentro de lib/
//   logger.info('backup', 'backup automático criado', { arquivo: nome });
//   logger.error('auth', 'security.json indisponível', { erro: e.message });
//
// `logger.raw(texto)` existe só pro caso raro de mensagem que é pra ser
// lida diretamente por um humano no terminal (ex: o aviso de senha inicial
// em lib/auth.js) — não é um "evento" de sistema, não ganha timestamp/nível.

const NIVEIS = { debug: 10, info: 20, warn: 30, error: 40 };
const nivelConfigurado = (process.env.LOG_LEVEL || 'info').toLowerCase();
const nivelMinimo = NIVEIS[nivelConfigurado] != null ? NIVEIS[nivelConfigurado] : NIVEIS.info;

function formatarDados(dados) {
  if (dados === undefined) return '';
  if (dados instanceof Error) return ` — ${dados.message}`;
  if (typeof dados === 'object' && dados !== null) {
    try { return ' ' + JSON.stringify(dados); } catch (_) { return ''; }
  }
  return ' ' + String(dados);
}

function log(nivel, contexto, mensagem, dados) {
  if (NIVEIS[nivel] < nivelMinimo) return;
  const linha = `${new Date().toISOString()} [${nivel.toUpperCase()}] [${contexto}] ${mensagem}${formatarDados(dados)}`;
  if (nivel === 'error') console.error(linha);
  else if (nivel === 'warn') console.warn(linha);
  else console.log(linha);
}

module.exports = {
  debug: (contexto, mensagem, dados) => log('debug', contexto, mensagem, dados),
  info: (contexto, mensagem, dados) => log('info', contexto, mensagem, dados),
  warn: (contexto, mensagem, dados) => log('warn', contexto, mensagem, dados),
  error: (contexto, mensagem, dados) => log('error', contexto, mensagem, dados),
  raw: (texto) => console.log(texto),
};
