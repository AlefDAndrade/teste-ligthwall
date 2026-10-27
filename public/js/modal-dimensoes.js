// ============================================================
//  modal-dimensoes.js — modal ⚙️ "Dimensões da Bateria"
//
//  Define a dimensão padrão da bateria e a dimensão de CADA berço — e de
//  cada LADO (painel) do berço, como no Tipo de Montagem. Usado por:
//    • Registrar Operação (operacao.js, abrirModalDimensoes)
//    • Editar Operação   (app-core.js, _eoAbrirModalDimensoes) — corrige
//      operações antigas
//  O modal só edita uma cópia de trabalho e devolve o resultado em
//  onConfirmar; quem chama decide o que fazer com ele (state, preview,
//  pergunta de nº de berços, salvar...). A página offline (offline.html) é
//  standalone e tem a própria versão (offline-operacao.js).
//
//  Berço de 9,5 cm usa placa cimentícia de 8 mm (LW.dimensaoUsaPlaca8mm).
// ============================================================
(function () {
  'use strict';

  let trabalho = [];   // dimensão EFETIVA de cada lado de cada berço: [{ direita, esquerda }]
  let baseTrab = '';   // dimensão geral (padrão da bateria) de trabalho
  let opcoes = null;   // opções da abertura atual (ver abrir)

  const el = id => document.getElementById(id);

  function placas8mmPrevistas() {
    if (!opcoes.calcularPlacas8mm) return null;
    return opcoes.calcularPlacas8mm({
      capacidade: trabalho.length,
      dimensaoGeral: baseTrab,
      bercosDimensoes: LW.compactarBercosDimensoes(trabalho, baseTrab),
    });
  }

  function renderizar() {
    const grade = el('dim-bercos');
    if (!grade) return;
    const meia = (i, lado, rotulo) => {
      const dim = trabalho[i][lado];
      const is8 = LW.dimensaoUsaPlaca8mm(dim);
      return `<button type="button" class="btn btn-outline-accent btn-sm" data-berco="${i}" data-lado="${lado}"
        title="${rotulo} do berço ${i + 1}"
        style="flex:1;display:flex;flex-direction:column;align-items:center;gap:1px;padding:5px 2px;min-width:0;border-color:${is8 ? 'var(--accent)' : 'var(--border)'};color:${is8 ? 'var(--accent)' : 'var(--text-2)'}">
        <span style="font-size:.58rem;opacity:.8">${rotulo.charAt(0)}</span>
        <strong style="font-size:.74rem;white-space:nowrap">${LW.escaparHtml(dim || '—')}</strong>
      </button>`;
    };
    grade.innerHTML = trabalho.map((_l, i) => `
      <div style="border:1px solid var(--border);border-radius:var(--radius);padding:5px;display:flex;flex-direction:column;gap:4px">
        <button type="button" class="btn btn-ghost btn-sm" data-berco="${i}" data-lado="ambos" title="Aplicar nos dois lados do berço ${i + 1}"
          style="padding:2px 4px;font-size:.7rem">Berço ${i + 1}</button>
        <div style="display:flex;gap:4px">${meia(i, 'direita', 'Direita')}${meia(i, 'esquerda', 'Esquerda')}</div>
      </div>`).join('');
    grade.querySelectorAll('button[data-berco]').forEach(b => {
      b.addEventListener('click', () => {
        const i = Number(b.dataset.berco);
        aplicar(i, i, b.dataset.lado);
      });
    });

    const compacto = LW.compactarBercosDimensoes(trabalho, baseTrab);
    const todos = trabalho.flatMap(l => [l.direita, l.esquerda]);
    const resumo = LW.dimensoesDistintas(trabalho.length, baseTrab, compacto)
      .map(d => `${d}: ${todos.filter(x => x === d).length} painel(is)`).join(' · ');
    const n8 = placas8mmPrevistas();
    const r = el('dim-resumo');
    if (r) r.innerHTML = `${LW.escaparHtml(resumo || '—')}${n8 === null ? '' : `<br>Placas de 8 mm: <strong>${n8}</strong>`}`;
  }

  function mostrarErro(msg) {
    const e = el('dim-erro');
    e.textContent = msg || '';
    e.style.display = msg ? 'block' : 'none';
  }

  // Aplica a dimensão digitada em "Dimensão a aplicar" aos berços de..até
  // (índices 0-based), no lado indicado: 'ambos' | 'direita' | 'esquerda'.
  function aplicar(de, ate, lado) {
    const valor = LW.formatarDimensaoLive(el('dim-valor').value.trim(), true);
    if (!valor) {
      mostrarErro('Digite a dimensão a aplicar (ex: 9,5) antes de clicar nos berços.');
      return;
    }
    mostrarErro('');
    for (let i = Math.max(0, de); i <= Math.min(trabalho.length - 1, ate); i++) {
      if (lado !== 'esquerda') trabalho[i].direita = valor;
      if (lado !== 'direita') trabalho[i].esquerda = valor;
    }
    renderizar();
  }

  /**
   * Abre o modal. Só devolve algo ao confirmar, via onConfirmar.
   * opcoes = {
   *   titulo:            'B7'                      (mostrado em "Dimensões — Bateria B7"),
   *   capacidade:        nº de berços,
   *   dimensaoBase:      dimensão padrão atual (ex: "9 cm"),
   *   bercosDimensoes:   bercos_dimensoes atual (null | array, ver LW.dimensoesPorLadoDoBerco),
   *   calcularPlacas8mm: ({capacidade, dimensaoGeral, bercosDimensoes}) => nº  (opcional —
   *                      quem chama conhece tipo de montagem/marcações),
   *   onConfirmar:       async ({ dimensao, bercosDimensoes }) => {}
   *                      dimensao = nova dimensão padrão (se TODOS os painéis ficaram
   *                      iguais, é essa dimensão — senão o registro gravaria `dimensao`
   *                      diferente de todos os painéis); bercosDimensoes já no formato
   *                      compacto de gravação (null se nenhum berço difere da padrão).
   * }
   */
  function abrir(o) {
    opcoes = o;
    baseTrab = o.dimensaoBase || '';
    trabalho = LW.dimensoesEfetivasPorLado(o.capacidade, o.dimensaoBase, o.bercosDimensoes).map(l => ({ ...l }));

    const existente = el('modal-dimensoes');
    if (existente) existente.remove();
    const modal = document.createElement('div');
    modal.id = 'modal-dimensoes';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);
                  padding:28px;width:680px;max-width:94vw;max-height:90vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,.6)">
        <div style="text-align:center;margin-bottom:16px">
          <div style="font-size:2rem;margin-bottom:6px">⚙️</div>
          <h2 style="font-family:var(--font-display);font-size:1.2rem;color:var(--accent);margin:0">Dimensões — Bateria ${LW.escaparHtml(o.titulo || '')}</h2>
          <p style="color:var(--text-2);font-size:.8rem;margin-top:8px;line-height:1.4">
            Digite uma dimensão em "Dimensão a aplicar" e clique no berço (os dois lados) ou em Direita/Esquerda (só aquele painel). Painéis de 9,5 cm usam placa de 8 mm.
          </p>
        </div>
        <div id="dim-erro" style="display:none;color:var(--red);font-size:.82rem;margin-bottom:10px"></div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Dimensão padrão da bateria</label>
            <input type="text" id="dim-base" class="form-input" style="width:130px" inputmode="decimal" value="${LW.escaparHtml(baseTrab)}">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Dimensão a aplicar</label>
            <input type="text" id="dim-valor" class="form-input" style="width:130px" inputmode="decimal" placeholder="Ex: 9,5">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">De</label>
            <input type="number" id="dim-de" class="form-input" style="width:70px" min="1" max="${o.capacidade}">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Até</label>
            <input type="number" id="dim-ate" class="form-input" style="width:70px" min="1" max="${o.capacidade}">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Aplicar em</label>
            <select id="dim-lado" class="form-input" style="width:110px">
              <option value="ambos">Ambos</option>
              <option value="direita">Direita</option>
              <option value="esquerda">Esquerda</option>
            </select>
          </div>
          <button type="button" id="dim-btn-aplicar" class="btn btn-outline-accent btn-sm">Aplicar</button>
          <button type="button" id="dim-btn-todos" class="btn btn-outline-accent btn-sm">Todos</button>
        </div>
        <div id="dim-resumo" style="font-size:.78rem;color:var(--text-2);margin-bottom:12px;line-height:1.5"></div>
        <div id="dim-bercos" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:20px"></div>
        <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <button type="button" id="dim-btn-restaurar" class="btn btn-ghost btn-sm" title="Todos os painéis voltam à dimensão padrão da bateria">↺ Restaurar padrão</button>
          <div style="display:flex;gap:12px">
            <button type="button" id="dim-btn-cancelar" class="btn btn-ghost">Cancelar</button>
            <button type="button" id="dim-btn-confirmar" class="btn btn-primary">Confirmar</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    renderizar();

    const formatarAoDigitar = e => {
      const input = e.target;
      const pos = input.selectionStart;
      const f = LW.formatarDimensaoLive(input.value);
      if (f !== input.value) { input.value = f; input.setSelectionRange(Math.min(pos, f.length), Math.min(pos, f.length)); }
    };
    el('dim-base').addEventListener('input', formatarAoDigitar);
    el('dim-valor').addEventListener('input', formatarAoDigitar);
    el('dim-btn-aplicar').addEventListener('click', () => {
      const de = parseInt(el('dim-de').value, 10);
      const ate = parseInt(el('dim-ate').value, 10);
      if (!de || !ate || de > ate || de < 1 || ate > trabalho.length) {
        mostrarErro(`Informe uma faixa válida de berços (1 a ${trabalho.length}).`);
        return;
      }
      aplicar(de - 1, ate - 1, el('dim-lado').value);
    });
    el('dim-btn-todos').addEventListener('click', () => aplicar(0, trabalho.length - 1, el('dim-lado').value));
    el('dim-btn-restaurar').addEventListener('click', () => {
      const base = LW.formatarDimensaoLive(el('dim-base').value.trim(), true) || baseTrab;
      trabalho = trabalho.map(() => ({ direita: base, esquerda: base }));
      renderizar();
    });
    el('dim-btn-cancelar').addEventListener('click', () => modal.remove());
    el('dim-btn-confirmar').addEventListener('click', async () => {
      const novaBase = LW.formatarDimensaoLive(el('dim-base').value.trim(), true);
      if (!novaBase) { mostrarErro('A dimensão padrão da bateria não pode ficar vazia.'); return; }
      const resultado = resolverResultado(novaBase, baseTrab, trabalho);
      const aoConfirmar = opcoes.onConfirmar;
      modal.remove();
      await aoConfirmar(resultado);
    });
  }

  // Painéis que ainda valiam a dimensão padrão ANTIGA acompanham a nova; se
  // TODOS os painéis acabam com a mesma dimensão, ela vira a padrão.
  function resolverResultado(novaBase, baseAnterior, lados) {
    const efetivas = lados.map(l => ({
      direita: l.direita === baseAnterior ? novaBase : l.direita,
      esquerda: l.esquerda === baseAnterior ? novaBase : l.esquerda,
    }));
    const tudoIgual = efetivas.length && efetivas.every(l => l.direita === efetivas[0].direita && l.esquerda === efetivas[0].direita);
    const dimensao = tudoIgual ? efetivas[0].direita : novaBase;
    return { dimensao, bercosDimensoes: LW.compactarBercosDimensoes(efetivas, dimensao) };
  }

  window.LWDimensoes = { abrir };
})();
