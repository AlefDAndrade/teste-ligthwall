// ─── test/exportar-pdf-reconexao-sse.test.js ────────────────────────────────
// Cobre o bug relatado: exportações "Personalizada" (mais operações/páginas
// = mais TEMPO com a conexão SSE aberta = mais chance de pegar uma
// instabilidade de rede no meio do caminho) mostravam "Conexão com o
// servidor caiu" mesmo quando era só uma queda PASSAGEIRA que o próprio
// `EventSource` já reconectaria sozinho (comportamento padrão da spec) —
// "Do Dia" quase nunca demorava o bastante pra dar chance disso acontecer,
// então parecia um problema exclusivo do Personalizada, mas era o MESMO
// código (`baixarPdfApartirDeHtml`, public/js/data.js) nos dois casos.
//
// `LW.baixarPdfApartirDeHtml` roda 100% no navegador (fetch + EventSource +
// download via <a>/Blob) — carregamos data.js DE VERDADE num DOM jsdom
// (mesmo padrão de test/calc-paineis-nao-enchido.test.js) com um
// `EventSource` FALSO que a gente controla na mão, pra simular os dois
// cenários sem precisar de rede de verdade nem de um servidor rodando.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const DATA_JS = fs.readFileSync(path.join(__dirname, '..', 'public/js/data.js'), 'utf8');

// EventSource FALSO — só o suficiente pra `baixarPdfApartirDeHtml` (ver
// data.js) funcionar: addEventListener/close/onerror, e os métodos
// `_emit`/`_error` (só do lado do teste, não existem na spec de verdade)
// pra disparar os eventos na hora que a gente quiser.
function instalarEventSourceFalso(window) {
  class EventSourceFalso {
    constructor(url) {
      this.url = url;
      this.readyState = EventSourceFalso.CONNECTING;
      this.onerror = null;
      this._listeners = {};
      EventSourceFalso.instancias.push(this);
    }
    addEventListener(tipo, cb) {
      (this._listeners[tipo] = this._listeners[tipo] || []).push(cb);
    }
    close() {
      this.readyState = EventSourceFalso.CLOSED;
    }
    // Só do lado do teste — dispara um evento nomeado (ex.: 'progresso',
    // 'concluido') igual o servidor mandaria por SSE.
    _emit(tipo, dados) {
      const ev = { data: JSON.stringify(dados) };
      (this._listeners[tipo] || []).forEach((cb) => cb(ev));
    }
    // Só do lado do teste — dispara o `onerror`, exatamente como o
    // navegador faria ao perder a conexão (`readyState` já deve estar
    // ajustado pra CONNECTING ou CLOSED ANTES de chamar isto, igual o
    // navegador de verdade faz).
    _error() {
      if (this.onerror) this.onerror();
    }
  }
  EventSourceFalso.CONNECTING = 0;
  EventSourceFalso.OPEN = 1;
  EventSourceFalso.CLOSED = 2;
  EventSourceFalso.instancias = [];
  window.EventSource = EventSourceFalso;
  return EventSourceFalso;
}

function criarWindow() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'dangerously',
  });
  const window = dom.window;
  const EventSourceFalso = instalarEventSourceFalso(window);

  // fetch falso — só a 1 chamada que baixarPdfApartirDeHtml ainda faz via
  // fetch: POST /exportar-pdf/iniciar (devolve um jobId). O download do
  // PDF em si NÃO usa mais fetch/blob (ver comentário grande em
  // baixarPdfApartirDeHtml, data.js, sobre o bug corrigido: PDFs grandes
  // estourando memória do renderer ao montar um Blob) — agora é só um
  // `<a download>` clicado, capturado abaixo em `cliquesDeDownload`.
  window.fetch = async (url) => {
    if (url === '/exportar-pdf/iniciar') {
      return { ok: true, json: async () => ({ jobId: 'job-teste-reconexao' }) };
    }
    throw new Error('fetch inesperado neste teste: ' + url);
  };

  // jsdom NÃO entende o atributo `download` de um <a> — ele tenta navegar
  // de VERDADE pro href (`Not implemented: navigation to another
  // Document`), o que trava esperando uma resposta de rede que nunca
  // chega (diferente de um navegador de verdade, que reconhece `download`
  // e dispara um download em vez de navegar). Sobrescreve
  // `HTMLAnchorElement.prototype.click` ANTES de `data.js` rodar, só pra
  // este teste — captura o clique (href/download) em vez de deixar o
  // jsdom tentar navegar, e serve de bônus pra confirmar que o link
  // aponta pro jobId certo.
  const cliquesDeDownload = [];
  window.HTMLAnchorElement.prototype.click = function () {
    cliquesDeDownload.push({ href: this.getAttribute('href'), download: this.download });
  };

  window.eval(DATA_JS);
  return { window, EventSourceFalso, cliquesDeDownload };
}

// Dá um respiro pro event loop — usado depois de chamar
// LW.baixarPdfApartirDeHtml, pra deixar o `await fetch(...)`/`await
// respostaInicio.json()` internos resolverem antes da gente acessar a
// instância do EventSource que eles criam.
async function tick(vezes = 5) {
  for (let i = 0; i < vezes; i++) await new Promise((r) => setTimeout(r, 0));
}

test('instabilidade passageira (EventSource ainda tentando reconectar) NÃO derruba a exportação — só avisa e segue esperando', async () => {
  const { window, EventSourceFalso, cliquesDeDownload } = criarWindow();
  const fasesRecebidas = [];
  const promessa = window.LW.baixarPdfApartirDeHtml('teste.pdf', '<html></html>', {
    onProgresso: (fase) => fasesRecebidas.push(fase),
  });

  let resolvida = false;
  let rejeitada = false;
  promessa.then(() => { resolvida = true; }, () => { rejeitada = true; });

  await tick();
  assert.equal(EventSourceFalso.instancias.length, 1, 'deveria ter aberto uma conexão SSE');
  const sse = EventSourceFalso.instancias[0];

  // Cai a conexão, mas o EventSource (de verdade) já estaria tentando
  // reconectar sozinho nesse ponto — `readyState` continua CONNECTING.
  sse.readyState = EventSourceFalso.CONNECTING;
  sse._error();
  await tick();

  assert.equal(resolvida, false, 'não deveria ter resolvido ainda');
  assert.equal(rejeitada, false, 'uma instabilidade passageira NÃO deveria rejeitar a promise');
  assert.ok(fasesRecebidas.includes('reconectando'), 'deveria ter avisado visualmente que está reconectando');

  // Conexão volta sozinha (mesmo objeto EventSource, comportamento nativo
  // do navegador) — progresso normal continua chegando dali pra frente.
  sse._emit('progresso', { fase: 'imprimindo', feito: 1, total: 1, segundosRestantes: 0, progressoReal: true });
  sse._emit('concluido', {});

  await promessa; // não deve lançar
  assert.equal(resolvida, true);
  assert.equal(cliquesDeDownload.length, 1, 'deveria ter disparado exatamente 1 download nativo');
  assert.equal(cliquesDeDownload[0].href, '/exportar-pdf/arquivo/job-teste-reconexao', 'o link deveria apontar pro jobId certo');
  assert.equal(cliquesDeDownload[0].download, 'teste.pdf', 'o nome do arquivo baixado deveria ser o pedido');
});

test('quando o EventSource desiste de vez (readyState CLOSED), a exportação falha com a mensagem de conexão perdida', async () => {
  const { window, EventSourceFalso } = criarWindow();
  const promessa = window.LW.baixarPdfApartirDeHtml('teste.pdf', '<html></html>', {});

  await tick();
  const sse = EventSourceFalso.instancias[0];

  // Navegador esgotou as tentativas de reconexão (ou o servidor respondeu
  // algo fatal, ex.: job expirado da memória) — CLOSED de verdade.
  sse.readyState = EventSourceFalso.CLOSED;
  sse._error();

  await assert.rejects(promessa, /Conexão com o servidor caiu durante a geração do PDF\./);
});
