// ─── paletes-config.js — "Definir Paletes" ──────────────────────────────────
// Configurações → Bateria e Montagem → "Definir Paletes": 4 selects, um por
// quadrante (metade da bateria × lado do berço — Direito/Esquerdo, mesma
// convenção já usada nos pontinhos de Bateria Atual e Análise Focada, ver
// data-lado="direita"/"esquerda" em bateria-atual.js), cada um escolhendo
// qual dos 4 paletes-base recebe aquele quadrante. Uma prévia visual (grade
// de berços, mesmo estilo .ba-grid/.ba-celula de Bateria Atual) mostra o
// resultado ao vivo, pra cada dimensão de bateria já cadastrada (18/20/22
// berços etc — ver LW.DIMENSAO_OPTS/_derivarDimensoesDeBaterias), antes de
// salvar de verdade.
//
// Persistido em config.json (chave "paletes" — ver LW.PALETES_CONFIG,
// data.js) junto com o resto de Baterias/Montagem: pcColetarValores() é
// chamada por cfgSalvar() (app-core.js) na hora de montar o payload de
// POST /salvar-config — um único botão "✓ Salvar Configurações" salva tudo
// junto, mesma UX de sempre desta aba.
//
// Funções globais (mesmo padrão do resto do projeto: scripts sem módulo,
// tudo no mesmo escopo da página) — chamadas via onclick="..." no HTML
// (modal-config.html) e de dentro de app-core.js (cfgRenderTudo/cfgSalvar).

let _pcRascunho = null;         // {direitoPrimeira, direitoSegunda, esquerdoPrimeira, esquerdoSegunda} — null até a 1ª renderização depois de abrir Configurações
let _pcAbaDimensaoAtiva = null; // nº de berços (18/20/22...) atualmente exibido na prévia

const PC_QUADRANTES = [
  { chave: 'direitoPrimeira', selectId: 'pc-select-direitoPrimeira' },
  { chave: 'direitoSegunda', selectId: 'pc-select-direitoSegunda' },
  { chave: 'esquerdoPrimeira', selectId: 'pc-select-esquerdoPrimeira' },
  { chave: 'esquerdoSegunda', selectId: 'pc-select-esquerdoSegunda' },
];

// Mesmas 4 cores já usadas pra identificar pallet1..pallet4 na tabela de
// histórico do Setor de Qualidade (ver setor-qualidade.js, linhas com
// item.montagem?.pallet1..4) — reaproveitadas aqui só por consistência
// visual, o mesmo palete sempre com a mesma cor em qualquer tela do app.
const PC_CORES_PALETE = { 1: '#66bb6a', 2: '#42a5f5', 3: '#ab47bc', 4: '#ffa726' };

// Chamada de dentro de cfgRenderTudo() (app-core.js) toda vez que a aba
// Bateria e Montagem é (re)desenhada — inclusive depois de adicionar/
// remover uma bateria, não só na 1ª abertura do modal. `primeiraVez` (ver
// abrirConfig(), que zera _pcRascunho ao (re)abrir Configurações) decide
// se os SELECTS voltam a refletir o que está salvo (1ª vez) ou mantêm o
// que o Administrador já escolheu nesta sessão do modal, mesmo sem ter
// salvo ainda (evita perder uma edição em andamento só por ter cadastrado
// uma bateria nova no meio do caminho).
function pcRenderTudo() {
  const primeiraVez = !_pcRascunho;
  if (primeiraVez) {
    _pcRascunho = { ...(LW.PALETES_CONFIG || LW.PALETES_CONFIG_DEFAULT) };
  }
  _pcRenderSelects(primeiraVez);
  _pcRenderAbasDimensao();
  _pcRenderPreviewAtual();
}

function _pcRenderSelects(primeiraVez) {
  PC_QUADRANTES.forEach(({ chave, selectId }) => {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    if (primeiraVez || !sel.options.length) {
      sel.innerHTML = [1, 2, 3, 4].map(n => `<option value="${n}">Palete 0${n}</option>`).join('');
    }
    sel.value = String(_pcRascunho[chave]);
  });
}

// Abas de dimensão (18/20/22 berços...) — uma por Qtd. de berços ÚNICA
// entre as baterias cadastradas nesta sessão do modal (_cfgDados.baterias,
// app-core.js; mesma fonte que _derivarDimensoesDeBaterias já usa pra
// montar dimensoes.opcoes ao salvar). Se a aba ativa deixou de existir
// (ex: a única bateria com aquele nº de berços foi removida), cai pra
// primeira disponível.
function _pcRenderAbasDimensao() {
  const el = document.getElementById('pc-abas-dimensao');
  if (!el) return;

  const baterias = (typeof _cfgDados !== 'undefined' && _cfgDados.baterias) ? _cfgDados.baterias : [];
  const dimensoes = typeof _derivarDimensoesDeBaterias === 'function'
    ? _derivarDimensoesDeBaterias(baterias)
    : (LW.DIMENSAO_OPTS || []);

  const vistos = new Set();
  const unicos = [];
  dimensoes.forEach(d => {
    if (d.bercos && !vistos.has(d.bercos)) { vistos.add(d.bercos); unicos.push(d.bercos); }
  });
  unicos.sort((a, b) => a - b);

  if (!unicos.length) {
    el.innerHTML = '';
    _pcAbaDimensaoAtiva = null;
    return;
  }
  if (!unicos.includes(_pcAbaDimensaoAtiva)) _pcAbaDimensaoAtiva = unicos[0];

  el.innerHTML = unicos.map(bercos => `
    <button type="button" class="btn btn-sm ${bercos === _pcAbaDimensaoAtiva ? 'btn-outline-accent' : 'btn-ghost'}"
      onclick="pcMudarAbaDimensao(${bercos})">${bercos} berços</button>
  `).join('');
}

function pcMudarAbaDimensao(bercos) {
  _pcAbaDimensaoAtiva = bercos;
  _pcRenderAbasDimensao();
  _pcRenderPreviewAtual();
}

// Grade de berços da prévia — MESMO estilo visual de Bateria Atual/Análise
// Focada (.ba-grid/.ba-celula/.ba-numero, ver css/styles.css), só trocando
// os pontinhos coloridos por rótulos "P1".."P4" (o rascunho AINDA NÃO
// salvo, _pcRascunho — reage a cada mudança nos selects, ver
// pcAoMudarSelect). Topo = lado Direito, base = lado Esquerdo — mesma
// convenção de _renderBercos (analise-focada.js).
function _pcRenderPreviewAtual() {
  const el = document.getElementById('pc-preview');
  if (!el) return;
  const cap = _pcAbaDimensaoAtiva;
  if (!cap || !_pcRascunho) {
    el.innerHTML = '<span style="color:var(--text-3);font-size:.82rem">Cadastre ao menos uma bateria (com nº de berços) pra ver a prévia.</span>';
    return;
  }

  const metade = Math.ceil(cap / 2);
  const celulas = [];
  for (let berco = 1; berco <= cap; berco++) {
    const primeira = berco <= metade;
    const paleteDireito = primeira ? _pcRascunho.direitoPrimeira : _pcRascunho.direitoSegunda;
    const paleteEsquerdo = primeira ? _pcRascunho.esquerdoPrimeira : _pcRascunho.esquerdoSegunda;
    celulas.push(`
      <div class="ba-celula" style="background:var(--bg-3);border:1px solid var(--border)">
        <span style="font-weight:700;font-size:.78rem;color:${PC_CORES_PALETE[paleteDireito] || 'var(--text-2)'}" title="Lado Direito">P${paleteDireito}</span>
        <span class="ba-numero">B${String(berco).padStart(2, '0')}</span>
        <span style="font-weight:700;font-size:.78rem;color:${PC_CORES_PALETE[paleteEsquerdo] || 'var(--text-2)'}" title="Lado Esquerdo">P${paleteEsquerdo}</span>
      </div>
    `);
  }
  el.innerHTML = `<div class="ba-grid">${celulas.join('')}</div>`;
}

// onchange dos 4 selects — valida ANTES de aceitar a mudança no rascunho:
// se dois quadrantes ficarem apontando pro mesmo palete, mostra o erro e
// NÃO atualiza a prévia (evita gente confirmar "Salvar Configurações"
// com uma config inconsistente sem perceber, já que a prévia sempre
// reflete o último estado VÁLIDO).
function pcAoMudarSelect() {
  const erroEl = document.getElementById('pc-erro');
  erroEl.style.display = 'none';

  const novo = {};
  PC_QUADRANTES.forEach(({ chave, selectId }) => {
    novo[chave] = parseInt(document.getElementById(selectId).value, 10);
  });

  if (!LW.paletesConfigValida(novo)) {
    erroEl.textContent = 'Cada palete (01 a 04) precisa ser usado em exatamente 1 quadrante — dois quadrantes não podem apontar pro mesmo palete.';
    erroEl.style.display = 'block';
    return;
  }

  _pcRascunho = novo;
  _pcRenderPreviewAtual();
}

// Chamada por cfgSalvar() (app-core.js) — devolve o valor validado pra
// entrar no payload de POST /salvar-config, ou lança erro (cfgSalvar
// mostra como alerta e CANCELA o salvamento inteiro, não só desta seção)
// se os 4 selects não formarem uma permutação válida dos paletes 1-4.
function pcColetarValores() {
  const novo = {};
  PC_QUADRANTES.forEach(({ chave, selectId }) => {
    const el = document.getElementById(selectId);
    novo[chave] = el ? parseInt(el.value, 10) : (_pcRascunho ? _pcRascunho[chave] : null);
  });
  if (!LW.paletesConfigValida(novo)) {
    throw new Error('cada palete (01 a 04) precisa estar em exatamente 1 quadrante — confira os 4 selects.');
  }
  return novo;
}
