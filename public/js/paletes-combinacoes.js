// ─── paletes-combinacoes.js — "Combinações de Avaliação" ────────────────────
// Configurações → Paletes → "Combinações de Avaliação" (ver conversa que
// motivou isso, incluindo a correção depois do 1º rascunho não ter batido
// com a ideia): pra cada tipo de montagem SIMPLES (nunca híbrida — ver
// _combinacoesEfetivas em setor-qualidade.js), mostra:
//
//   1. Uma lista de tipos "Sem combinação" — chips clicáveis.
//   2. Ao clicar num chip (ou no "editar" de uma combinação já definida),
//      abre um painel único de edição: escolhe COR + FORMA (círculo/traço)
//      e clica no painel pra ir empilhando marcas (igual ao gesto real de
//      avaliação, toggleMark em setor-qualidade.js — só que aqui é 1
//      painel isolado, não uma placa de verdade). Um botão "i" separado
//      arma o modo "marcar indicador": o próximo clique numa marca JÁ
//      colocada no painel marca ELA como o indicador de qualidade — o
//      elemento cujo cor real (verde/azul/vermelho) vem do resultado da
//      avaliação de verdade; TODAS as outras marcas viram identidade
//      fixa (sempre a mesma cor, preenchida sozinha na hora da
//      avaliação — ver _marcasDeIdentificacao, setor-qualidade.js).
//   3. Uma lista "Combinações definidas" — label + preview visual (mini
//      versão do painel, indicador sempre cinza aqui) + um botão de
//      editar que reabre o painel já preenchido.
//
// Formato salvo em combinacaoAvaliacao (dentro de cada tipo simples em
// tipos_montagem.opcoes): { marcas: [{shape, color}, ...], indicadorIndex }.
// `indicadorIndex` aponta pra qual posição em `marcas` é o indicador — as
// outras são identidade fixa. Suporta qualquer forma/cor no indicador
// (não é mais sempre o círculo) e mais de 2 marcas (limite MAX_MARCAS,
// mesmo espírito do limite por placa na avaliação de verdade).
//
// Mesmo padrão de rascunho de paletes-config.js/paletes-ordem.js — edita
// direto _cfgDados.montagens[i].combinacaoAvaliacao (definido em
// app-core.js), que já é o rascunho central desta aba inteira ("Baterias
// e Tipos de Montagem"). Só vira valor de verdade ao clicar "✓ Salvar
// Configurações" — cfgSalvar() já lê _cfgDados.montagens sem precisar de
// nenhuma função de coleta extra aqui.

const PCA_CORES = ['verde', 'vermelho', 'azul', 'amarelo', 'laranja'];
const PCA_LABEL_COR = { verde: 'Verde', vermelho: 'Vermelho', azul: 'Azul', amarelo: 'Amarelo', laranja: 'Laranja' };
// Mesmo limite de MAX_MARCAS_POR_PLACA em setor-qualidade.js — arquivo
// diferente (escopo próprio), por isso duplicado aqui como constante
// simples, não importado.
const PCA_MAX_MARCAS = 6;

// ── Estado do painel de edição (rascunho, só em memória até "Salvar
// Combinação") ──────────────────────────────────────────────────────────
let _pcaTipoEmEdicao = null;   // código do tipo sendo editado agora, ou null (painel fechado)
let _pcaMarcasRascunho = [];   // [{shape:'circle'|'dash', color}, ...]
let _pcaIndicadorIndex = null; // índice em _pcaMarcasRascunho que é o indicador de qualidade
let _pcaModoIndicador = false; // true = botão "i" armado, esperando clique numa marca
let _pcaCorSelecionada = 'verde';
let _pcaFormaSelecionada = 'circle';

function _pcaMontagensSimples() {
  return (typeof _cfgDados !== 'undefined' && _cfgDados && Array.isArray(_cfgDados.montagens))
    ? _cfgDados.montagens.filter(m => m && m.modo === 'simples' && m.tipo)
    : [];
}

function _pcaEncontrarMontagem(tipo) {
  return _pcaMontagensSimples().find(m => m.tipo === tipo) || null;
}

// ── Renderização geral (chips "sem combinação" + lista "definidas" +
// painel de edição, se estiver aberto) — chamada de dentro de
// cfgRenderTudo() (app-core.js) toda vez que a aba é (re)desenhada,
// inclusive depois de adicionar/remover um tipo de montagem.
function pcaRenderTudo() {
  const simples = _pcaMontagensSimples();
  const semCombo = simples.filter(m => !m.combinacaoAvaliacao);
  const comCombo = simples.filter(m => m.combinacaoAvaliacao);

  const elSem = document.getElementById('pca-sem-combinacao');
  if (elSem) {
    elSem.innerHTML = simples.length === 0
      ? '<span style="font-size:.8rem;color:var(--text-3)">Nenhum tipo de montagem simples cadastrado ainda.</span>'
      : (semCombo.length
        ? semCombo.map(m => `<button type="button" onclick="pcaAbrirEditor('${_pcaAttr(m.tipo)}')" style="padding:7px 16px;border-radius:20px;border:1px solid var(--border);background:var(--bg-3);color:var(--text);cursor:pointer;font-size:.84rem;font-weight:600">${LW.escaparHtml(m.label)}</button>`).join('')
        : '<span style="font-size:.8rem;color:var(--text-3)">Nenhum tipo pendente — todos já têm combinação definida.</span>');
  }

  const elDef = document.getElementById('pca-definidas-lista');
  if (elDef) {
    elDef.innerHTML = comCombo.length
      ? comCombo.map(_pcaLinhaDefinidaHTML).join('')
      : '<span style="font-size:.8rem;color:var(--text-3)">Nenhuma combinação definida ainda.</span>';
  }

  _pcaRenderEditor();
}

function _pcaAttr(tipo) { return String(tipo).replace(/'/g, "\\'"); }

function _pcaLinhaDefinidaHTML(m) {
  return `
    <div style="display:flex;align-items:center;gap:14px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;margin-bottom:10px;flex-wrap:wrap">
      <span style="font-family:var(--font-display);font-weight:700;min-width:70px">${LW.escaparHtml(m.label)}</span>
      <div style="display:flex;align-items:center;gap:2px;padding:6px 10px;background:var(--bg-3);border-radius:6px">${_pcaPreviewCombo(m.combinacaoAvaliacao)}</div>
      <button type="button" onclick="pcaAbrirEditor('${_pcaAttr(m.tipo)}')" title="Editar combinação" style="margin-left:auto;background:none;border:1px solid var(--border);border-radius:6px;padding:5px 10px;cursor:pointer;color:var(--text-3);font-size:.8rem">✎ Editar</button>
    </div>
  `;
}

// Preview visual compacto — o indicador é sempre desenhado CINZA aqui
// (--sq-cor-identificacao-auto), nunca uma cor de status: aqui é só
// configuração, não existe avaliação real acontecendo.
function _pcaPreviewCombo(combo) {
  if (!combo || !Array.isArray(combo.marcas) || !combo.marcas.length) {
    return '<span style="font-size:.76rem;color:var(--text-3)">Sem combinação</span>';
  }
  return combo.marcas.map((mk, i) => {
    const isIndicador = i === combo.indicadorIndex;
    const classe = mk.shape === 'dash' ? 'sq-shape-dash' : 'sq-shape-circle';
    const cor = isIndicador ? 'identificacao-auto' : (mk.color || 'identificacao-auto');
    const titulo = isIndicador
      ? 'Indicador de qualidade — cinza aqui; na avaliação real vira verde/azul (aprovado) ou vermelho (reprovado)'
      : `Identidade fixa (${PCA_LABEL_COR[mk.color] || '—'})`;
    return `<span class="${classe}" style="background:var(--sq-cor-${cor});display:inline-block;margin:0 2px;${isIndicador ? 'outline:2px solid var(--accent);outline-offset:2px' : ''}" title="${titulo}"></span>`;
  }).join('');
}

// ── Painel de edição ─────────────────────────────────────────────────
function pcaAbrirEditor(tipo) {
  const m = _pcaEncontrarMontagem(tipo);
  if (!m) return;
  _pcaTipoEmEdicao = tipo;
  if (m.combinacaoAvaliacao && Array.isArray(m.combinacaoAvaliacao.marcas) && m.combinacaoAvaliacao.marcas.length) {
    _pcaMarcasRascunho = m.combinacaoAvaliacao.marcas.map(x => ({ shape: x.shape, color: x.color }));
    _pcaIndicadorIndex = Number.isInteger(m.combinacaoAvaliacao.indicadorIndex) ? m.combinacaoAvaliacao.indicadorIndex : 0;
  } else {
    _pcaMarcasRascunho = [];
    _pcaIndicadorIndex = null;
  }
  _pcaModoIndicador = false;
  _pcaCorSelecionada = 'verde';
  _pcaFormaSelecionada = 'circle';
  pcaRenderTudo();
  const wrap = document.getElementById('pca-editor');
  if (wrap && wrap.scrollIntoView) wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function pcaFecharEditor() {
  _pcaTipoEmEdicao = null;
  _pcaMarcasRascunho = [];
  _pcaIndicadorIndex = null;
  _pcaModoIndicador = false;
  pcaRenderTudo();
}

function pcaSelecionarCor(cor) {
  _pcaCorSelecionada = cor;
  _pcaRenderEditor();
}

function pcaSelecionarForma(forma) {
  _pcaFormaSelecionada = forma;
  _pcaRenderEditor();
}

// Arma/desarma o modo "marcar indicador" — o botão "i". Clicar de novo
// nele desarma sem escolher nada (desiste do gesto).
function pcaAtivarModoIndicador() {
  _pcaModoIndicador = !_pcaModoIndicador;
  _pcaRenderEditor();
}

// Clique no painel (fundo, fora de uma marca já existente) — adiciona
// uma nova marca com a cor+forma selecionadas agora, igual ao gesto de
// avaliação de verdade (toggleMark, setor-qualidade.js): escolhe cor,
// escolhe forma, clica na placa/painel. Repetir empilha mais uma marca
// (até PCA_MAX_MARCAS) — não substitui a existente, mesmo comportamento
// de repetição que a avaliação real permite.
function pcaCliqueNoPainel() {
  if (!_pcaTipoEmEdicao) return;
  if (_pcaModoIndicador) {
    // Clicou fora de uma marca enquanto o "i" estava armado — cancela o
    // gesto (não teria como marcar "o fundo" como indicador).
    _pcaModoIndicador = false;
    _pcaRenderEditor();
    return;
  }
  if (_pcaMarcasRascunho.length >= PCA_MAX_MARCAS) {
    if (typeof LW !== 'undefined' && LW.mostrarAlerta) LW.mostrarAlerta(`Limite de ${PCA_MAX_MARCAS} marcas por combinação atingido.`, { tipo: 'aviso' });
    return;
  }
  const marcasAntes = _pcaMarcasRascunho.length;
  _pcaMarcasRascunho.push({ shape: _pcaFormaSelecionada, color: _pcaCorSelecionada });
  if (_pcaMarcasRascunho.length === 1) {
    _pcaIndicadorIndex = 0; // única marca = indicador implícito, sem precisar do "i"
  } else if (marcasAntes === 1) {
    // Virou de 1 pra 2+ marcas: o índice implícito (0) não vale mais
    // sozinho — precisa de "i" explícito pra escolher qual das marcas é
    // o indicador agora que existe ambiguidade.
    _pcaIndicadorIndex = null;
  }
  _pcaRenderEditor();
}

// Clique numa marca JÁ colocada no painel — 2 comportamentos possíveis:
//  - modo "i" armado: marca essa posição como o indicador de qualidade
//    (clicar na que já é o indicador desmarca, volta a "nenhum
//    indicador escolhido ainda").
//  - modo normal: remove essa marca (gesto de apagar, já que clicar no
//    painel geral ADICIONA — ver pcaCliqueNoPainel).
function pcaCliqueNaMarca(index) {
  if (_pcaModoIndicador) {
    _pcaIndicadorIndex = (_pcaIndicadorIndex === index) ? null : index;
    _pcaModoIndicador = false;
  } else {
    _pcaMarcasRascunho.splice(index, 1);
    if (_pcaIndicadorIndex === index) _pcaIndicadorIndex = null;
    else if (_pcaIndicadorIndex !== null && _pcaIndicadorIndex > index) _pcaIndicadorIndex -= 1;
    if (_pcaMarcasRascunho.length === 1) _pcaIndicadorIndex = 0; // só sobrou 1 -> só pode ser ela o indicador
  }
  _pcaRenderEditor();
}

function pcaLimparPainel() {
  _pcaMarcasRascunho = [];
  _pcaIndicadorIndex = null;
  _pcaModoIndicador = false;
  _pcaRenderEditor();
}

// Grava em _cfgDados.montagens[i].combinacaoAvaliacao — só vira valor de
// verdade quando o Administrador clicar "✓ Salvar Configurações" (mesmo
// rascunho central da aba, ver app-core.js).
function pcaSalvarCombinacao() {
  if (!_pcaTipoEmEdicao) return;
  if (!_pcaMarcasRascunho.length) {
    if (typeof LW !== 'undefined' && LW.mostrarAlerta) LW.mostrarAlerta('Adicione ao menos 1 marca no painel antes de salvar.', { tipo: 'aviso' });
    return;
  }
  if (_pcaIndicadorIndex === null || !_pcaMarcasRascunho[_pcaIndicadorIndex]) {
    if (typeof LW !== 'undefined' && LW.mostrarAlerta) LW.mostrarAlerta('Marque qual marca é o indicador de qualidade — clique no botão "i" e depois na marca desejada.', { tipo: 'aviso' });
    return;
  }
  const m = _pcaEncontrarMontagem(_pcaTipoEmEdicao);
  if (!m) return;
  m.combinacaoAvaliacao = {
    marcas: _pcaMarcasRascunho.map(x => ({ shape: x.shape, color: x.color })),
    indicadorIndex: _pcaIndicadorIndex,
  };
  pcaFecharEditor();
}

function _pcaRenderEditor() {
  const wrap = document.getElementById('pca-editor');
  if (!wrap) return;
  if (!_pcaTipoEmEdicao) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';

  const m = _pcaEncontrarMontagem(_pcaTipoEmEdicao);
  const titulo = document.getElementById('pca-editor-titulo');
  if (titulo) titulo.textContent = `Combinação de ${m ? m.label : String(_pcaTipoEmEdicao).toUpperCase()}`;

  const coresEl = document.getElementById('pca-editor-cores');
  if (coresEl) {
    coresEl.innerHTML = PCA_CORES.map(c => {
      const ativo = c === _pcaCorSelecionada;
      return `<button type="button" onclick="pcaSelecionarCor('${c}')" title="${PCA_LABEL_COR[c]}" style="width:28px;height:28px;border-radius:50%;cursor:pointer;background:var(--sq-cor-${c});border:3px solid ${ativo ? 'var(--accent)' : 'transparent'}"></button>`;
    }).join('');
  }

  const formasEl = document.getElementById('pca-editor-formas');
  if (formasEl) {
    const btnForma = (forma, texto) => {
      const ativo = _pcaFormaSelecionada === forma;
      return `<button type="button" onclick="pcaSelecionarForma('${forma}')" style="padding:6px 14px;border-radius:6px;cursor:pointer;font-size:.84rem;font-weight:600;border:1px solid ${ativo ? 'var(--accent)' : 'var(--border)'};background:${ativo ? 'var(--accent)' : 'var(--bg-3)'};color:${ativo ? '#fff' : 'var(--text)'}">${texto}</button>`;
    };
    formasEl.innerHTML = btnForma('circle', '● Círculo') + btnForma('dash', '▬ Traço') +
      `<button type="button" onclick="pcaAtivarModoIndicador()" title="Clique aqui e depois numa marca do painel abaixo pra marcar ela como o indicador de qualidade" style="width:32px;height:32px;border-radius:50%;cursor:pointer;font-weight:800;font-size:.9rem;border:1px solid ${_pcaModoIndicador ? 'var(--accent)' : 'var(--border)'};background:${_pcaModoIndicador ? 'var(--accent)' : 'var(--bg-3)'};color:${_pcaModoIndicador ? '#fff' : 'var(--text)'}">i</button>`;
  }

  const painelEl = document.getElementById('pca-painel');
  if (painelEl) {
    painelEl.innerHTML = _pcaMarcasRascunho.length
      ? _pcaMarcasRascunho.map((mk, i) => {
          const isIndicador = i === _pcaIndicadorIndex;
          const classe = mk.shape === 'dash' ? 'sq-shape-dash' : 'sq-shape-circle';
          const cor = isIndicador ? 'identificacao-auto' : mk.color;
          const titulo = isIndicador
            ? 'Indicador de qualidade — clique pra remover'
            : `${PCA_LABEL_COR[mk.color] || mk.color} — clique pra remover; use o botão "i" pra marcar como indicador`;
          return `<span onclick="event.stopPropagation(); pcaCliqueNaMarca(${i})" title="${titulo}" style="position:relative;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:6px">
            <span class="${classe}" style="background:var(--sq-cor-${cor});display:inline-block"></span>
            ${isIndicador ? '<span style="position:absolute;top:0;right:0;background:var(--accent);color:#fff;font-size:9px;font-weight:800;width:14px;height:14px;border-radius:50%;display:flex;align-items:center;justify-content:center;line-height:1">i</span>' : ''}
          </span>`;
        }).join('')
      : '<span style="font-size:.78rem;color:var(--text-3);pointer-events:none">Escolha cor + forma acima e clique aqui pra adicionar uma marca</span>';
  }

  const dica = document.getElementById('pca-editor-dica');
  if (dica) {
    dica.textContent = _pcaModoIndicador
      ? 'Clique em cima de uma das marcas do painel pra marcar ela como o indicador de qualidade.'
      : 'Escolha uma cor e uma forma acima, depois clique no painel pra adicionar a marca. Clique numa marca já colocada pra removê-la.';
  }
}
