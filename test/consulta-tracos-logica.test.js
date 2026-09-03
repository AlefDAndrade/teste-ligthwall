// ─── test/consulta-tracos-logica.test.js ────────────────────────────────────
// Nova tela auxiliar do Dashboard de Traço (public/js/consulta-tracos.js) —
// pedido registrado numa conversa: lista de traços por período + detalhe de
// insumos por traço + exportação Excel (período inteiro e traço único).
//
// "Ordem no Dia" no lugar de "Hora de Produção" — decisão tomada na mesma
// conversa (o sistema nunca gravou horário por traço individual, só da
// operação inteira). Estes testes cobrem a lógica pura que sustenta essa
// decisão (_comOrdemDoDia/_ordenarParaExibicao) e os cálculos de insumo
// (_totalInsumos/_linhaExportPeriodo) — tudo sem DOM/rede, extraindo as
// funções do arquivo real e avaliando isoladamente (mesmo padrão de
// test/operacao-offline-fila-aviso-idade.test.js: evita precisar simular
// as dezenas de dependências de DOM/showPage/XLSX só pra testar contas).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CODIGO = fs.readFileSync(path.join(__dirname, '..', 'public/js/consulta-tracos.js'), 'utf8');

function extrairFuncao(nome, ehAsync = false) {
  const marcador = (ehAsync ? 'async function ' : 'function ') + nome + '(';
  const inicio = CODIGO.indexOf(marcador);
  assert.ok(inicio >= 0, `não encontrei a função ${nome} em consulta-tracos.js`);
  const fim = CODIGO.indexOf('\n  }', inicio);
  assert.ok(fim > inicio, `não encontrei o fechamento da função ${nome}`);
  return CODIGO.slice(inicio, fim + 4);
}

function montarHelpers() {
  // eslint-disable-next-line no-eval
  const _numOuZero = eval(`(${extrairFuncao('_numOuZero')})`);
  // As funções abaixo chamam _numOuZero/CAMPOS_INSUMO como closures do
  // arquivo real — reconstituídas aqui no mesmo escopo de avaliação pra
  // isso funcionar isolado, sem precisar carregar o arquivo inteiro.
  const CAMPOS_INSUMO = [
    { campo: 'cimento_real', rotulo: 'Cimento' },
    { campo: 'agua_real', rotulo: 'Água' },
    { campo: 'eps_real', rotulo: 'EPS' },
    { campo: 'superplast_real', rotulo: 'Superplastificante' },
    { campo: 'incorporador_real', rotulo: 'Incorporador de Ar' },
  ];
  // eslint-disable-next-line no-eval
  const _totalInsumos = eval(`(${extrairFuncao('_totalInsumos')})`);
  // eslint-disable-next-line no-eval
  const _comOrdemDoDia = eval(`(${extrairFuncao('_comOrdemDoDia')})`);
  // eslint-disable-next-line no-eval
  const _ordenarParaExibicao = eval(`(${extrairFuncao('_ordenarParaExibicao')})`);
  // eslint-disable-next-line no-eval
  const _linhaExportPeriodo = eval(`(${extrairFuncao('_linhaExportPeriodo')})`);
  return { _numOuZero, _totalInsumos, _comOrdemDoDia, _ordenarParaExibicao, _linhaExportPeriodo, CAMPOS_INSUMO };
}

test('_numOuZero: converte string numérica, mas nunca quebra com vazio/undefined/texto', () => {
  const { _numOuZero } = montarHelpers();
  assert.equal(_numOuZero('12.5'), 12.5);
  assert.equal(_numOuZero(''), 0);
  assert.equal(_numOuZero(undefined), 0);
  assert.equal(_numOuZero(null), 0);
  assert.equal(_numOuZero('abc'), 0);
  assert.equal(_numOuZero(0), 0);
});

test('_totalInsumos: soma os 5 campos de insumo, tratando ausentes como zero', () => {
  const { _totalInsumos } = montarHelpers();
  const traco = { cimento_real: 300, agua_real: 120, eps_real: '', superplast_real: 3.5, incorporador_real: 1.2 };
  assert.equal(_totalInsumos(traco), 300 + 120 + 0 + 3.5 + 1.2);
});

test('_comOrdemDoDia: numera 1,2,3... por dia, reiniciando a cada data — não é um contador global', () => {
  const { _comOrdemDoDia } = montarHelpers();
  const tracos = [
    { id_traco: 'a', data: '2026-09-03' },
    { id_traco: 'b', data: '2026-09-03' },
    { id_traco: 'c', data: '2026-09-04' }, // dia novo — reinicia em 1
    { id_traco: 'd', data: '2026-09-03' },
    { id_traco: 'e', data: '2026-09-04' },
  ];
  const resultado = _comOrdemDoDia(tracos);
  assert.deepEqual(resultado.map(t => t._ordemDoDia), [1, 2, 1, 3, 2]);
  // Não muta o array/objetos originais.
  assert.equal(tracos[0]._ordemDoDia, undefined);
});

test('_ordenarParaExibicao: dia mais recente primeiro; dentro do mesmo dia, ordem de produção crescente', () => {
  const { _ordenarParaExibicao } = montarHelpers();
  const tracos = [
    { id_traco: 'velho-2', data: '2026-09-01', _ordemDoDia: 2 },
    { id_traco: 'novo-1', data: '2026-09-05', _ordemDoDia: 1 },
    { id_traco: 'velho-1', data: '2026-09-01', _ordemDoDia: 1 },
    { id_traco: 'novo-2', data: '2026-09-05', _ordemDoDia: 2 },
  ];
  const ordenado = _ordenarParaExibicao(tracos).map(t => t.id_traco);
  assert.deepEqual(ordenado, ['novo-1', 'novo-2', 'velho-1', 'velho-2']);
});

test('_linhaExportPeriodo: monta a linha da planilha com as colunas pedidas, "Ordem no Dia" no lugar de "Hora"', () => {
  const { _linhaExportPeriodo } = montarHelpers();
  const traco = {
    data: '2026-09-04', turno: '1º TURNO', num_traco: 125, _ordemDoDia: 3,
    cimento_real: 300, agua_real: 120, eps_real: 8, superplast_real: 3.5, incorporador_real: 1.2,
  };
  const linha = _linhaExportPeriodo(traco);
  assert.deepEqual(Object.keys(linha), [
    'Data', 'Ordem no Dia', 'Turno', 'Nº do Traço',
    'Cimento (kg)', 'Água (kg)', 'EPS (kg)', 'Superplastificante (kg)', 'Incorporador de Ar (kg)',
    'Total de Insumos (kg)',
  ]);
  assert.equal(linha['Data'], '2026-09-04');
  assert.equal(linha['Ordem no Dia'], 3);
  assert.equal(linha['Nº do Traço'], 125);
  assert.equal(linha['Cimento (kg)'], 300);
  assert.equal(linha['Total de Insumos (kg)'], 300 + 120 + 8 + 3.5 + 1.2);
  // Nunca deveria existir uma coluna de hora/horário — decisão registrada.
  assert.ok(!Object.keys(linha).some(k => /hora|hor[aá]rio/i.test(k)));
});

test('item de permissão consulta-tracos existe no catálogo, tipo dashboard, próprio (não reaproveita id de qualidade-tracos)', () => {
  const itensPermissao = require('../lib/itens-permissao.js');
  const item = itensPermissao.CATALOGO.find(i => i.id === 'consulta-tracos');
  assert.ok(item, 'esperava um item "consulta-tracos" no catálogo de permissões');
  assert.equal(item.tipo, 'dashboard');
});
