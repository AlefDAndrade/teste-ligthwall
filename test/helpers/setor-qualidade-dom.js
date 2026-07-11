// ─── test/helpers/setor-qualidade-dom.js ────────────────────────────────────
// Harness compartilhado pra testar public/js/setor-qualidade.js "de fora",
// como um navegador faria — ver o comentário de topo de
// test/setor-qualidade-trava.test.js pra explicação completa do porquê
// (script de front-end, sem module.exports, precisa de DOM real pra rodar).
//
// Fica em test/helpers/ pelo mesmo motivo de servidor-teste.js: infra de
// teste compartilhada entre mais de um arquivo *.test.js.

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const RAIZ = path.join(__dirname, '..', '..');
const HTML_TELA = fs.readFileSync(path.join(RAIZ, 'public/partials/page-setor-qualidade.html'), 'utf8');
const JS_TELA = fs.readFileSync(path.join(RAIZ, 'public/js/setor-qualidade.js'), 'utf8');

// Uma operação "real" de exemplo, no mesmo formato devolvido por
// GET /operacoes-nao-avaliadas (server.js) — é a partir dela que
// _prefillFromOperacao preenche os 5 campos automáticos.
const OPERACAO_FILA = {
  id: 'op-1',
  id_bateria: 'B3',
  turno: '2º TURNO',
  tipo_montagem: 'SP',
  data: '2026-07-01',
  fim: '2026-07-01T14:30:00.000Z',
  dimensao: 9,
  bercos_reais: 20,
  capacidade: 20,
};

// Uma avaliação JÁ REGISTRADA, no mesmo formato de GET /avaliacoes-qualidade
// — usada nos testes de correção (editarAvaliacaoDoEspelho) e reconstrução
// de pallets extras a partir dos painéis persistidos.
const AVALIACAO_REGISTRADA = {
  id: 'av-1',
  batteryId: 'B7',
  turno: '1° TURNO',
  tempInput: '38°C',
  dtMontagem: '2026-07-01T10:00:00.000Z',
  dtEnchimento: '2026-07-01T10:30:00.000Z',
  dtDesmoldagem: '2026-07-01T12:00:00.000Z',
  observations: 'registro de teste',
  montagem: { pallet1: 'SP', pallet2: 'SP', pallet3: 'SP', pallet4: 'SP' },
  totalSlabs: 40,
  dimensaoOperacao: 9,
  registeredAt: '2026-07-01T12:05:00.000Z',
  linkedOperacaoId: 'op-1',
  paineis: [],
};

// Sobe um DOM novo (com o HTML real da tela + o script real carregado) —
// chamar de novo em cada teste garante que nenhum teste herda estado
// (localStorage, filaOperacoes, formulário) do anterior.
//
// opcoes.operacoesFila       — o que GET /operacoes-nao-avaliadas devolve (default: [OPERACAO_FILA])
// opcoes.avaliacoesRegistradas — o que GET /avaliacoes-qualidade devolve (default: [AVALIACAO_REGISTRADA])
function montarTela(opcoes = {}) {
  const operacoesFila = opcoes.operacoesFila || [OPERACAO_FILA];
  const avaliacoesRegistradas = opcoes.avaliacoesRegistradas || [AVALIACAO_REGISTRADA];

  const novoDom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  novoDom.window.document.body.innerHTML = HTML_TELA;

  // Stub mínimo de LW — global real do app (ver public/js/data.js),
  // carregado ANTES de setor-qualidade.js em produção (index.template.html).
  // Só o suficiente pra não quebrar: BATERIA_IDS (usado em
  // _espessuraDaBateria pra "adivinhar" a espessura por ID de bateria —
  // aqui devolvemos lista vazia de propósito, os testes usam operações
  // com `dimensao` real, que tem prioridade sobre o palpite, ver
  // _definirEspessuraReal/_prefillFromOperacao).
  novoDom.window.LW = { BATERIA_IDS: [] };

  // Stub de fetch: só as rotas que os fluxos testados realmente chamam.
  novoDom.window.fetch = async (url) => {
    if (String(url).includes('/operacoes-nao-avaliadas')) {
      return { ok: true, json: async () => operacoesFila };
    }
    if (String(url).includes('/avaliacoes-qualidade')) {
      return { ok: true, json: async () => avaliacoesRegistradas };
    }
    return { ok: true, json: async () => [] };
  };

  novoDom.window.eval(JS_TELA);
  return novoDom;
}

// Espera os microtasks das Promises internas (fetch mock → filaOperacoes)
// assentarem antes de seguir com o teste.
function tick(n = 5) {
  return new Promise(resolve => {
    let restantes = n;
    (function proximo() {
      if (restantes-- <= 0) return resolve();
      setTimeout(proximo, 0);
    })();
  });
}

// Simula soltar a placa `origemId` (ex: "stack1-3") na coluna do pallet
// `destStackId` (ex: "stack5") — dispara o mesmo evento "drop" que o
// navegador dispara de verdade ao arrastar (ver _ativarDropZone,
// setor-qualidade.js). jsdom não implementa a classe DataTransfer (ver
// https://github.com/jsdom/jsdom/issues/2913), então simulamos só o que o
// handler realmente lê dela: dataTransfer.getData('text/plain').
function soltarPlacaNoPallet(window, origemId, destStackId) {
  const alvo = window.document.getElementById(destStackId);
  if (!alvo) throw new Error(`Pallet "${destStackId}" não existe no DOM — crie antes de soltar.`);
  const evento = new window.Event('drop', { bubbles: true, cancelable: true });
  evento.dataTransfer = { getData: () => origemId };
  alvo.dispatchEvent(evento);
}

module.exports = { montarTela, tick, soltarPlacaNoPallet, OPERACAO_FILA, AVALIACAO_REGISTRADA };
