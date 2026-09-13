// ─── test/analise-focada-berco-personalizado-separado.test.js ────────────
// Bug relatado: na Análise Focada, berços de Montagem Personalizada
// apareciam CINZA na grade visual (.ba-grid/.ba-celula) — mesmo pintados
// certo no card "Bateria Atual" — e o problema piorava com "🔀 Berços
// Separados" (um tipo de montagem por lado do berço).
//
// Causa: bercos_personalizados[i] guarda, pra cada berço, o CÓDIGO de um
// tipo simples (ex: 'sp') OU, com "🔀 Berços Separados", um OBJETO
// {direita, esquerda} com um código por lado (ver corDoBercoPersonalizado,
// data.js). analise-focada.js (_corPorTipoBerco) resolvia a cor chamando
// LW.corPorTipoSimples(tipo) direto — que só entende STRING: quando
// recebia o objeto de um berço dividido, _hexDoTipoSimples (data.js) não
// achava opção nenhuma e caía no cinza neutro. bateria-atual.js já tinha
// sido corrigido pra usar LW.corDoBercoPersonalizado (que sabe montar o
// gradiente 50/50 por lado), mas analise-focada.js ficou pra trás com a
// versão antiga — corrigido aqui usando a mesma função.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');

const CODIGO_FOCADA = fs.readFileSync(path.join(__dirname, '..', 'public/js/analise-focada.js'), 'utf8');

// Cores de exemplo pros tipos simples usados nos testes — mesmo formato
// devolvido por corCssDoHex (data.js): {cor, bg, borda}.
const COR_SP = { hibrida: false, cor: '#e57373', bg: 'rgba(229,115,115,.15)', borda: '#e57373' };
const COR_2P = { hibrida: false, cor: '#64b5f6', bg: 'rgba(100,181,246,.15)', borda: '#64b5f6' };
const COR_NEUTRA = { hibrida: false, cor: '#5c6475', bg: 'rgba(156,163,175,.1)', borda: '#2a2f3a' };

// Stub mínimo de LW — só o necessário pra _corPorTipoBerco/_renderBercos,
// reproduzindo o comportamento real de corPorTipoSimples/
// corDoBercoPersonalizado (data.js) pros tipos 'sp' e '2p' usados aqui.
function montarJanela() {
  const dom = new JSDOM('<!doctype html><html><body><div id="af-bercos"></div></body></html>', { runScripts: 'dangerously' });
  const { window } = dom;

  const corPorTipoSimplesStub = (tipo) => {
    if (tipo === 'sp') return COR_SP;
    if (tipo === '2p') return COR_2P;
    return COR_NEUTRA;
  };

  window.LW = {
    TIPO_MONTAGEM_PERSONALIZADA: 'PERSONALIZADA',
    corPorTipoSimples: corPorTipoSimplesStub,
    corMontagemPorLabel: () => COR_NEUTRA,
    // Mesma lógica de data.js/corDoBercoPersonalizado, só que em cima do
    // stub acima — testa que _corPorTipoBerco DELEGA pra esta função (em
    // vez de corPorTipoSimples direto) pra berços divididos funcionarem.
    corDoBercoPersonalizado: (valor) => {
      if (!valor) return COR_NEUTRA;
      if (typeof valor !== 'object') return corPorTipoSimplesStub(valor);
      const corDir = valor.direita ? corPorTipoSimplesStub(valor.direita) : null;
      const corEsq = valor.esquerda ? corPorTipoSimplesStub(valor.esquerda) : null;
      if (corDir && !corEsq) return corDir;
      if (corEsq && !corDir) return corEsq;
      if (!corDir && !corEsq) return COR_NEUTRA;
      if (valor.direita === valor.esquerda) return corDir;
      return {
        hibrida: true,
        cor1: corDir.cor, cor2: corEsq.cor,
        cor: corDir.cor,
        bg: `linear-gradient(180deg, ${corDir.bg} 50%, ${corEsq.bg} 50%)`,
        borda: corDir.borda,
      };
    },
    escaparHtml: (s) => String(s),
  };
  window.eval(CODIGO_FOCADA);
  return window;
}

test('berço personalizado com tipo único (string) continua com cor sólida do tipo', () => {
  const window = montarJanela();
  const cor = window.LWFocada.corPorTipoBerco(true, 'sp');
  assert.equal(cor.hibrida, false);
  assert.equal(cor.cor, COR_SP.cor);
});

test('berço personalizado "🔀 Berços Separados" (objeto {direita,esquerda} com tipos DIFERENTES) NÃO cai mais em cinza — monta gradiente 50/50', () => {
  const window = montarJanela();
  const cor = window.LWFocada.corPorTipoBerco(true, { direita: 'sp', esquerda: '2p' });
  assert.notEqual(cor.cor, COR_NEUTRA.cor); // regressão: antes caía sempre no cinza neutro
  assert.equal(cor.hibrida, true);
  assert.equal(cor.cor1, COR_SP.cor);
  assert.equal(cor.cor2, COR_2P.cor);
  assert.match(cor.bg, /linear-gradient\(180deg/);
});

test('berço personalizado dividido com os 2 lados IGUAIS vira cor sólida (como um berço unificado)', () => {
  const window = montarJanela();
  const cor = window.LWFocada.corPorTipoBerco(true, { direita: 'sp', esquerda: 'sp' });
  assert.equal(cor.hibrida, false);
  assert.equal(cor.cor, COR_SP.cor);
});

test('_renderBercos pinta cada célula da grade com a cor do tipo, inclusive berço dividido — nunca fundo cinza neutro', () => {
  const window = montarJanela();
  const el = window.document.getElementById('af-bercos');

  const op = {
    tipo_montagem: 'PERSONALIZADA',
    bercos_personalizados: JSON.stringify(['sp', { direita: 'sp', esquerda: '2p' }, '2p']),
  };
  const bercosVisuais = [
    { ordem: 1, estado_direita: null, estado_esquerda: null },
    { ordem: 2, estado_direita: null, estado_esquerda: null },
    { ordem: 3, estado_direita: null, estado_esquerda: null },
  ];

  window.LWFocada.renderBercos(bercosVisuais, op, el);

  const celulas = el.querySelectorAll('.ba-celula');
  assert.equal(celulas.length, 3);

  // Berço 1 (tipo único 'sp') — cor sólida do tipo.
  assert.match(celulas[0].getAttribute('style'), /background:rgba\(229,115,115,\.15\)/);

  // Berço 2 (dividido sp/2p) — gradiente 50/50, NUNCA o cinza neutro.
  const styleBerco2 = celulas[1].getAttribute('style');
  assert.match(styleBerco2, /linear-gradient\(180deg/);
  assert.doesNotMatch(styleBerco2, /rgba\(156,163,175,\.1\)/);

  // Berço 3 (tipo único '2p') — cor sólida do tipo.
  assert.match(celulas[2].getAttribute('style'), /background:rgba\(100,181,246,\.15\)/);
});
