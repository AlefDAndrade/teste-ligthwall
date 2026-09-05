// ─── test/backup-automatico-escopo-geral.test.js ────────────────────────────
// Pedido registrado numa conversa: "eu quero que seja um backup geral" — o
// job diário automático (executarBackupAutomaticoSeNecessario,
// lib/rotas/backup.js — roda sozinho por horário/intervalo, setInterval em
// server.js, nunca por uma rota HTTP chamável) passou a gerar sempre o
// escopo GERAL (dados de produção + config.json/security.json/
// usuarios.json/operadores.json), não mais só "Dados". Decisão sem opção
// de escolha, de propósito (perguntado e confirmado na mesma conversa).
//
// Não dá pra testar isto via requisição HTTP (a função só roda por
// agendamento, não tem rota própria) — mesmo raciocínio de outros testes
// estruturais desta suíte (ex: test/exportar-pdf-cancelamento-entre-
// paginas.test.js): inspeciona o código-fonte real pra confirmar QUAL
// função geradora de zip está sendo chamada, e usa
// test/backup-dados-vs-geral.test.js (já existente) como garantia
// independente de que "Geral" de fato inclui config/segurança/usuários —
// não duplicado aqui.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CODIGO = fs.readFileSync(path.join(__dirname, '..', 'lib/rotas/backup.js'), 'utf8');

function corpoDaFuncao(nome, ehAsync = true) {
  const marcador = (ehAsync ? 'async function ' : 'function ') + nome + '(';
  const inicio = CODIGO.indexOf(marcador);
  assert.ok(inicio >= 0, `não encontrei a função ${nome}`);
  const fim = CODIGO.indexOf('\n  }', inicio);
  assert.ok(fim > inicio, `não encontrei o fechamento da função ${nome}`);
  return CODIGO.slice(inicio, fim + 4);
}

test('executarBackupAutomaticoSeNecessario gera o backup GERAL, não mais só "Dados"', () => {
  const corpo = corpoDaFuncao('executarBackupAutomaticoSeNecessario');
  assert.match(corpo, /await gerarZipBackupGeral\(\)/, 'esperava que o job automático chamasse gerarZipBackupGeral()');
  assert.doesNotMatch(corpo, /await gerarZipDadosServidor\(\)/, 'o job automático não deveria mais chamar gerarZipDadosServidor() (escopo antigo, só produção)');
});

test('a sincronização manual (POST /sincronizar-backup-automatico) continua podendo escolher o tipo — não afetada pela mudança do job agendado', () => {
  // Continua existindo a opção 'dados'|'geral' pro botão manual — a
  // mudança desta conversa foi só no job AGENDADO, não nessa rota (ver
  // README, "Sincronizar com um backup manual").
  const inicio = CODIGO.indexOf("urlPath === '/sincronizar-backup-automatico'");
  assert.ok(inicio >= 0, 'esperava a rota /sincronizar-backup-automatico continuar existindo');
  const trecho = CODIGO.slice(inicio, inicio + 2500);
  assert.match(trecho, /await \(tipo === 'geral' \? gerarZipBackupGeral\(\) : gerarZipDadosServidor\(\)\)/);
});

test('gerarZipDadosServidor() continua existindo no código (não foi removida, só parou de ser usada pelo job agendado)', () => {
  assert.match(CODIGO, /function gerarZipDadosServidor\(\)/);
});
