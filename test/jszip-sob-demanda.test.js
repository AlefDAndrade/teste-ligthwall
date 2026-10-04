// Regressão: JSZip é carregado sob demanda (LW.carregarJszip). Cada handler
// que lê um .zip precisa carregá-lo ANTES do primeiro JSZip.loadAsync, senão
// aparece "Não foi possível ler o .zip: JSZip is not defined" (os testes de
// restaurar/mesclar injetam win.JSZip e por isso não pegavam isso).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const codigo = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-core.js'), 'utf8');

for (const nome of ['handleRestaurarArquivo', 'handleMesclarArquivo', 'handleRestaurarGeralArquivo']) {
  test(`${nome} carrega o JSZip antes de usá-lo`, () => {
    const ini = codigo.indexOf(`async function ${nome}(`);
    assert.ok(ini >= 0, `${nome} não encontrada`);
    const fim = codigo.indexOf('\n    async function ', ini + 10);
    const corpo = codigo.slice(ini, fim < 0 ? undefined : fim);
    const iCarrega = corpo.indexOf('LW.carregarJszip()');
    const iUsa = corpo.indexOf('JSZip.loadAsync');
    assert.ok(iCarrega >= 0, 'deveria chamar LW.carregarJszip()');
    assert.ok(iUsa >= 0 && iCarrega < iUsa, 'carregarJszip deve vir antes de JSZip.loadAsync');
  });
}
