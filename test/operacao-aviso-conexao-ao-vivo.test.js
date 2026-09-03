// ─── test/operacao-aviso-conexao-ao-vivo.test.js ────────────────────────────
// README, "Registro de Operação Offline (PWA) — plano", item 9: "Conexão
// cai NO MEIO de uma operação normal (logada) — aviso ao vivo".
//
// Não dá pra simular de ponta a ponta sem levar a tela de Registrar
// Operação inteira a um estado "running" (bateria selecionada, montagem
// escolhida, etc. — muita infraestrutura de DOM/config só pra chegar lá) —
// as funções em si (`_conexaoLive_marcarCaiu`/`_marcarVoltou`) também são
// privadas do módulo (não expostas em `window.LWOp`, mesmo padrão de
// funções internas do resto do app). Em vez disso, confirmamos
// ESTRUTURALMENTE (inspeção do código-fonte) as peças que, juntas,
// garantem o comportamento descrito no README:
//   1) Os dois monitores (evento do navegador + checagem ativa por fetch)
//      existem e estão registrados.
//   2) Os dois só agem com uma operação em andamento (`state.status ===
//      'idle'` → não faz nada).
//   3) O aviso de queda usa o banner PERSISTENTE (não os 8s padrão).
//   4) Os textos batem com o que o README promete.
//
// Status real (verificado nesta tarefa): o mecanismo já existia no código
// — este teste só FORMALIZA o item 9 como concluído (README estava com o
// status desatualizado, "plano ainda não implementado").

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CODIGO = fs.readFileSync(path.join(__dirname, '..', 'public/js/operacao.js'), 'utf8');

function corpoDaFuncao(nome) {
  const inicio = CODIGO.indexOf(`function ${nome}(`);
  assert.ok(inicio >= 0, `não encontrei a função ${nome} em operacao.js`);
  // Fecha no próximo "\n  }" (fechamento no mesmo nível de indentação de
  // "  function ...") — suficiente pra estas funções pequenas e sem chaves
  // aninhadas complexas no meio.
  const fim = CODIGO.indexOf('\n  }', inicio);
  assert.ok(fim > inicio, `não encontrei o fechamento da função ${nome}`);
  return CODIGO.slice(inicio, fim);
}

test('monitores de conexão ao vivo estão registrados: evento do navegador + checagem ativa por fetch', () => {
  assert.match(CODIGO, /window\.addEventListener\('offline',\s*_conexaoLive_marcarCaiu\)/);
  assert.match(CODIGO, /window\.addEventListener\('online',\s*_conexaoLive_marcarVoltou\)/);
  assert.match(CODIGO, /setInterval\(_checarConexaoAoVivo,\s*15000\)/, 'checagem ativa por fetch deveria rodar periodicamente (reforço pros eventos do navegador, que sozinhos não são 100% confiáveis)');
});

test('_conexaoLive_marcarCaiu só age com uma operação em andamento, e usa o banner PERSISTENTE', () => {
  const corpo = corpoDaFuncao('_conexaoLive_marcarCaiu');
  assert.match(corpo, /state\.status === 'idle'/, 'sem operação em andamento não há o que avisar — deveria checar isso e sair cedo');
  assert.match(corpo, /persistente:\s*true/, 'o aviso de queda precisa ficar na tela até a conexão voltar (persistente), não sumir sozinho em 8s como o banner padrão');
  assert.match(corpo, /Sem conexão\. Seus dados estão salvos neste computador/, 'texto do aviso de queda deveria bater com o prometido no README');
});

test('_conexaoLive_marcarVoltou só anuncia se este monitor tinha marcado a queda antes (não avisa "voltou" à toa)', () => {
  const corpo = corpoDaFuncao('_conexaoLive_marcarVoltou');
  assert.match(corpo, /if \(!_conexaoCaidaAoVivo\) return;/);
  assert.match(corpo, /Conexão restabelecida\. Pode finalizar normalmente\./, 'texto do aviso de retorno deveria bater com o prometido no README');
});

test('_checarConexaoAoVivo (rede de segurança por fetch) também só roda com uma operação em andamento', () => {
  const corpo = corpoDaFuncao('_checarConexaoAoVivo');
  assert.match(corpo, /state\.status === 'idle'/, 'sem operação em andamento, não há por que gastar um fetch a cada 15s');
});

test('README: item 9 do plano de Registro Offline está marcado como concluído (código já existia, só não estava formalizado)', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const secao = readme.slice(readme.indexOf('### 9. Conexão cai NO MEIO'));
  const statusLinha = secao.match(/\*\*Status:\*\*.*$/m);
  assert.ok(statusLinha, 'não encontrei a linha de Status do item 9 no README');
  assert.doesNotMatch(statusLinha[0], /ainda não implementado/, 'README ainda diz que o plano não foi implementado — atualizar depois de confirmar o mecanismo');
});
