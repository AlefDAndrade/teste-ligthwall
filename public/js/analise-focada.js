// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  analise-focada.js — Análise Focada de uma Operação
// ============================================================
// Acessada clicando numa linha do Registro de Baterias com o "modo de
// foco" ligado (ver LWDash.toggleModoFocoRegistro/onClickLinhaRegistro,
// dashboard.js). Junta tudo que se liga por id_operacao — o elo comum
// entre histórico, relatório de injeção e berços visuais — numa página
// só: identificação da operação, o desenho da bateria (berços visuais),
// a receita usada (com ajustes, se algum) e a avaliação de qualidade
// vinculada (ver db.detalheOperacao(), server.js/db.js).
'use strict';

(function () {
  let _idAtual = null;

  // ── Abre a página focada numa operação específica — chamado de fora
  // (dashboard.js) quando o usuário clica numa linha com o modo de foco
  // ligado. showPage() é global (app-core.js). ──
  function abrir(idOperacao) {
    _idAtual = idOperacao;
    showPage('analise-focada');
  }

  function voltar() {
    showPage('registro');
  }

  // ── Formatação ────────────────────────────────────────────
  function _fmtData(iso) {
    if (!iso) return '—';
    return iso.split('-').reverse().join('/');
  }
  function _fmtHora(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  // tempo_batida ORIGINAL do traço é gravado em SEGUNDOS (ver CREATE
  // TABLE tracos, db.js) — os ajustes ("Tempo de Batida Adicionado" em
  // Registrar Operação) são em MINUTOS. Unidades diferentes de
  // propósito no schema original — só formato cada um do jeito certo,
  // não tento converter um pro outro.
  function _fmtTempoBatidaOriginal(segundos) {
    if (segundos === null || segundos === undefined || segundos === '') return '—';
    const s = Math.round(Number(segundos));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s` : `${m}m${String(sec).padStart(2, '0')}s`;
  }
  function _fmtKg(v, casas = 2) {
    return (v === null || v === undefined || v === '') ? null : Number(v).toFixed(casas);
  }

  // ── Cabeçalho: identificação da operação ─────────────────────
  function _renderCabecalho(op) {
    const el = document.getElementById('af-cabecalho');
    if (!el) return;
    const atrasoHtml = op.houve_atraso === 'SIM'
      ? `<span style="color:var(--red)">⚠ Sim${op.motivo_atraso ? ' — ' + LW.escaparHtml(op.motivo_atraso) : ''}</span>`
      : 'Não';
    el.innerHTML = `
      <div class="af-campo"><div class="af-label">ID da Operação</div><div class="af-valor mono">${LW.escaparHtml(op.id)}</div></div>
      <div class="af-campo"><div class="af-label">Tipo de Bateria</div><div class="af-valor">${LW.escaparHtml(op.id_bateria || '—')}</div></div>
      <div class="af-campo"><div class="af-label">Tipo de Montagem</div><div class="af-valor">${LW.escaparHtml(op.tipo_montagem || '—')}</div></div>
      <div class="af-campo"><div class="af-label">Data da Operação</div><div class="af-valor">${_fmtData(op.data)}</div></div>
      <div class="af-campo"><div class="af-label">Início — Fim</div><div class="af-valor mono">${_fmtHora(op.inicio)} — ${_fmtHora(op.fim)}</div></div>
      <div class="af-campo"><div class="af-label">Turno</div><div class="af-valor">${LW.escaparHtml(op.turno || '—')}</div></div>
      <div class="af-campo"><div class="af-label">Dimensão</div><div class="af-valor">${LW.escaparHtml(op.dimensao || '—')}</div></div>
      <div class="af-campo"><div class="af-label">Berços Reais</div><div class="af-valor">${op.bercos_reais ?? '—'}</div></div>
      <div class="af-campo"><div class="af-label">Atraso</div><div class="af-valor">${atrasoHtml}</div></div>
    `;
  }

  // Cor por tipo de montagem de UM berço — mesma regra de bateria-atual.js
  // (_baCorPorTipo): Montagem Personalizada guarda o CÓDIGO do tipo por
  // berço (resolvido por corPorTipoSimples); qualquer outro tipo (simples
  // ou híbrido) é uniforme — todo berço usa o mesmo LABEL da operação
  // (resolvido por corMontagemPorLabel, que também monta o gradiente 50/50
  // de tipos híbridos).
  function _corPorTipoBerco(ehPersonalizada, tipo) {
    if (!tipo) return null;
    return ehPersonalizada ? LW.corPorTipoSimples(tipo) : LW.corMontagemPorLabel(tipo);
  }

  // ── Desenho da bateria (berços visuais) ──────────────────────
  // Mesma grade visual usada no popover de hover do Relatório de Berços
  // e no card "Bateria Atual" (.ba-grid/.ba-celula/.ba-dot, ver
  // css/styles.css) — aqui só leitura, sem clique nenhum.
  function _renderBercos(bercosVisuais, op) {
    const el = document.getElementById('af-bercos');
    if (!el) return;
    if (!bercosVisuais || !bercosVisuais.length) {
      el.innerHTML = `<div class="sq-empty-af"><i class="fas fa-inbox"></i> Berços visuais ainda não registrados para esta operação.</div>`;
      return;
    }
    const ordenados = bercosVisuais.slice().sort((a, b) => a.ordem - b.ordem);

    const ehPersonalizada = !!op && op.tipo_montagem === LW.TIPO_MONTAGEM_PERSONALIZADA;
    // O endpoint de detalhe da operação devolve a linha crua da tabela —
    // bercos_personalizados chega como STRING JSON, não como array (ao
    // contrário de outras telas, que já usam a linha pré-formatada com o
    // JSON.parse feito). Precisa normalizar aqui antes de indexar por berço.
    let gradePersonalizada = [];
    if (ehPersonalizada && op.bercos_personalizados) {
      gradePersonalizada = typeof op.bercos_personalizados === 'string'
        ? (() => { try { return JSON.parse(op.bercos_personalizados); } catch (_) { return []; } })()
        : op.bercos_personalizados;
    }

    el.innerHTML = `<div class="ba-grid">${ordenados.map(b => {
      const dirMarcado = b.estado_direita === 'baixou';
      const esqMarcado = b.estado_esquerda === 'baixou';
      const numero = String(b.ordem).padStart(2, '0');
      const tipoBerco = ehPersonalizada ? (gradePersonalizada[b.ordem - 1] || null) : (op ? op.tipo_montagem : null);
      const cor = _corPorTipoBerco(ehPersonalizada, tipoBerco);
      return `
        <div class="ba-celula" style="background:${cor ? cor.bg : 'var(--bg-2)'};color:${cor ? cor.cor : 'var(--text-2)'};border:1px solid ${cor ? cor.borda : 'var(--border)'}">
          <span class="ba-dot ba-dot-topo${dirMarcado ? ' ba-dot-marcado' : ''}" title="Direito">•</span>
          <span class="ba-numero">B${numero}</span>
          <span class="ba-dot ba-dot-base${esqMarcado ? ' ba-dot-marcado' : ''}" title="Esquerdo">•</span>
        </div>`;
    }).join('')}</div>`;
  }

  // ── Receita utilizada (traços + ajustes) ─────────────────────
  function _renderReceita(tracos) {
    const el = document.getElementById('af-receita');
    if (!el) return;
    if (!tracos || !tracos.length) {
      el.innerHTML = `<div class="sq-empty-af"><i class="fas fa-inbox"></i> Nenhum traço vinculado a esta operação.</div>`;
      return;
    }
    el.innerHTML = tracos.map(t => {
      const semAjuste = !t.ajustes.length;
      const camposReceita = [
        ['Cimento', _fmtKg(t.original.cimento), 'kg'],
        ['Água', _fmtKg(t.original.agua), 'kg'],
        ['EPS', _fmtKg(t.original.eps), 'kg'],
        ['Superplast.', _fmtKg(t.original.superplast, 3), 'kg'],
        ['Incorp. de Ar', _fmtKg(t.original.incorporador, 3), 'kg'],
        ['Tempo de Batida', _fmtTempoBatidaOriginal(t.original.tempo_batida), ''],
        ['Densidade', t.densidade ?? null, 'kg/m³'],
        ['Flow', t.flow ?? null, ''],
      ];
      const receitaHtml = camposReceita.map(([label, valor, unidade]) =>
        `<div>${label}: <strong>${valor === null || valor === undefined ? '—' : valor + (unidade ? ' ' + unidade : '')}</strong></div>`
      ).join('');

      const ajustesHtml = semAjuste
        ? `<div class="af-sem-ajuste">Receita sem ajuste.</div>`
        : `<div class="af-ajustes-wrap">
             <div class="af-ajustes-titulo">${t.ajustes.length} ajuste${t.ajustes.length > 1 ? 's' : ''} de receita</div>
             ${t.ajustes.map(a => `
               <div class="af-ajuste-linha">
                 <strong>Ajuste ${a.ordem}</strong>
                 <span>⏱ +${a.tempo_batida}min</span>
                 ${a.cimento ? `<span>Cimento +${_fmtKg(a.cimento)}kg</span>` : ''}
                 ${a.agua ? `<span>Água +${_fmtKg(a.agua)}kg</span>` : ''}
                 ${a.eps ? `<span>EPS +${_fmtKg(a.eps)}kg</span>` : ''}
                 ${a.superplast ? `<span>Superplast. +${_fmtKg(a.superplast, 3)}kg</span>` : ''}
                 ${a.incorporador ? `<span>Incorp. +${_fmtKg(a.incorporador, 3)}kg</span>` : ''}
               </div>`).join('')}
           </div>`;

      return `
        <div class="af-traco-card">
          <div class="af-traco-header">
            <strong>Traço ${LW.escaparHtml(String(t.num_traco ?? t.id_traco))}</strong>
            <span class="af-traco-bercos">Berços B${t.berco_inicio}–B${t.berco_finalizacao}</span>
          </div>
          <div class="af-receita-grid">${receitaHtml}</div>
          ${t.obs ? `<div class="af-traco-obs">📝 ${LW.escaparHtml(t.obs)}</div>` : ''}
          ${ajustesHtml}
        </div>`;
    }).join('');
  }

  // ── Avaliação de qualidade (painéis em texto, não em marca) ──────
  function _labelPainel(p) {
    if (!p) return '— Sem marcação';
    if (p.resultado === 'aprovado') return p.linha === '2ª' ? 'Aprovado / 2ª linha' : 'Aprovado / 1ª linha';
    if (p.resultado === 'reprovado') return 'Reprovado';
    // Bateria excluída da fila do Setor de Qualidade antes de ser avaliada
    // de verdade (ver SQ.excluirDaFila, setor-qualidade.js) — TODOS os
    // painéis dela nascem com este resultado, tipoObtido sempre null.
    // Sem este caso, caía no "— Sem marcação"/"—" abaixo, indistinguível
    // de uma placa que nunca teve marca nenhuma numa avaliação normal.
    if (p.resultado === 'nao_avaliado_no_sistema') return 'Não avaliado no sistema';
    return p.tipoObtido || '—'; // caso raro: 'Outros'/'Múltiplas' (ver classifyMarks, setor-qualidade.js)
  }
  function _corPainel(p) {
    if (!p) return 'var(--border-2)';
    if (p.resultado === 'aprovado') return p.linha === '2ª' ? 'var(--blue)' : 'var(--green)';
    if (p.resultado === 'reprovado') return 'var(--red)';
    if (p.resultado === 'nao_avaliado_no_sistema') return 'var(--text-3)';
    return 'var(--text-3)';
  }

  function _renderAvaliacao(avaliacao) {
    const el = document.getElementById('af-avaliacao');
    if (!el) return;
    if (!avaliacao) {
      el.innerHTML = `<div class="sq-empty-af"><i class="fas fa-inbox"></i> Bateria sem avaliação.</div>`;
      return;
    }
    const totalPorPallet = Math.round((avaliacao.totalSlabs || 40) / 4);
    const montagem = avaliacao.montagem || {};
    const paineis = avaliacao.paineis || [];

    let html = '<div class="af-paineis-grid">';
    for (let p = 1; p <= 4; p++) {
      // Tipo de montagem daquele pallet — "no cantinho", cabeçalho do
      // próprio card do pallet, não em cada painel individual.
      const tipoMontPallet = montagem['pallet' + p] || '—';
      html += `<div class="af-pallet"><div class="af-pallet-header"><span>Pallet ${p}</span><span class="af-pallet-tipo">${LW.escaparHtml(tipoMontPallet)}</span></div><div class="af-pallet-slabs">`;
      for (let i = 1; i <= totalPorPallet; i++) {
        const painel = paineis.find(pp => pp.pallet === p && pp.posicao === i);
        const cor = _corPainel(painel);
        html += `<div class="af-slab" style="border-left-color:${cor}">
          <span class="af-slab-num">${i}</span>
          <span class="af-slab-resultado" style="color:${cor}">${_labelPainel(painel)}</span>
        </div>`;
      }
      html += '</div></div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  // ── Render principal ─────────────────────────────────────────
  async function render() {
    const loading = document.getElementById('af-loading');
    const erro = document.getElementById('af-erro');
    const content = document.getElementById('af-content');

    if (!_idAtual) {
      if (loading) loading.style.display = 'none';
      if (content) content.style.display = 'none';
      if (erro) { erro.style.display = ''; erro.textContent = 'Nenhuma operação selecionada — volte pro Registro de Baterias e clique numa linha com o modo de foco ligado.'; }
      return;
    }

    if (loading) loading.style.display = '';
    if (content) content.style.display = 'none';
    if (erro) erro.style.display = 'none';

    const detalhe = await LW.getDetalheOperacao(_idAtual);

    if (loading) loading.style.display = 'none';

    if (!detalhe) {
      if (erro) { erro.style.display = ''; erro.textContent = 'Não foi possível carregar os dados desta operação — ela pode ter sido excluída.'; }
      return;
    }

    if (content) content.style.display = '';
    _renderCabecalho(detalhe.operacao);
    _renderBercos(detalhe.bercosVisuais, detalhe.operacao);
    _renderReceita(detalhe.tracos);
    _renderAvaliacao(detalhe.avaliacao);
  }

  // ── Exportar Dashboard Interativo (HTML standalone) ───────────────────────
  // Diferente dos outros dashboards (sem período/filtro aqui — é sobre UMA
  // operação só): embute o detalhe já carregado (LW.getDetalheOperacao) e
  // as mesmas funções de render via toString(), virando um retrato
  // autossuficiente dessa operação específica — sem filtro pra aplicar,
  // "interativo" aqui significa só "abre em qualquer navegador, offline,
  // com a mesma formatação".
  async function exportarInterativo() {
    if (!_idAtual) return;
    const btn = document.getElementById('btn-af-exportar');
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando…'; }
    try {
      const detalhe = await LW.getDetalheOperacao(_idAtual);
      if (!detalhe) { if (LW.mostrarAlerta) LW.mostrarAlerta('Não consegui carregar os dados desta operação.', { tipo: 'erro' }); return; }
      const html = _gerarHtmlAfStandalone(detalhe);
      LW.baixarArquivoTexto(
        `analise_focada_${LW.escaparHtml(String(detalhe.operacao?.id || _idAtual)).replace(/[^a-zA-Z0-9_-]/g, '_')}.html`,
        html
      );
    } catch (err) {
      console.error('Falha ao exportar Análise Focada:', err);
      if (LW.mostrarAlerta) LW.mostrarAlerta('Não consegui gerar o arquivo agora.', { tipo: 'erro' });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🌐 Exportar Interativo'; }
    }
  }

  // Cor determinística (hash simples) por tipo de montagem — simplificação
  // assumida aqui: sem a cor REAL configurada em Configurações → Montagem
  // embutida (exigiria embutir MONTAGEM_OPCOES inteiro), cada tipo distinto
  // ganha uma cor fixa e consistente dentro do próprio arquivo exportado
  // (mesmo tipo = mesma cor sempre, só não é a mesma cor da tela ao vivo).
  const _PALETA_TIPO = ['#4d8dff', '#2ecc71', '#8b5cf6', '#f5821f', '#06b6d4', '#e5484d', '#f1c40f'];
  function _corPorTipoSimplificada(tipo) {
    if (!tipo) return null;
    let hash = 0;
    for (let i = 0; i < tipo.length; i++) hash = (hash * 31 + tipo.charCodeAt(i)) >>> 0;
    const cor = _PALETA_TIPO[hash % _PALETA_TIPO.length];
    return { cor: '#fff', bg: cor, borda: cor };
  }

  function _gerarHtmlAfStandalone(detalhe) {
    const detalheJson = JSON.stringify(detalhe).replace(/<\/script/gi, '<\\/script');

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Análise Focada — ${LW.escaparHtml(String(detalhe.operacao?.id || ''))} — Exportado</title>
<style>${LW.gerarCssExportPadrao()}
  .af-cabecalho-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:14px; }
  .af-label { font-size:.68rem; text-transform:uppercase; letter-spacing:.06em; color:var(--text-3); margin-bottom:4px; }
  .af-valor { font-size:.95rem; color:var(--text); font-weight:600; }
  .sq-empty-af { text-align:center; padding:30px 10px; color:var(--text-3); font-size:.85rem; }
  .af-traco-card { background:var(--bg-1); border:1px solid var(--border); border-radius:var(--radius-lg); padding:14px 16px; margin-bottom:12px; }
  .af-traco-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
  .af-traco-bercos { font-size:.78rem; color:var(--text-3); }
  .af-receita-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:8px; font-size:.82rem; }
  .af-traco-obs { margin-top:10px; font-size:.8rem; color:var(--text-2); }
  .af-sem-ajuste { margin-top:10px; font-size:.8rem; color:var(--text-3); font-style:italic; }
  .af-ajustes-wrap { margin-top:12px; }
  .af-ajustes-titulo { font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; color:var(--text-3); margin-bottom:6px; }
  .af-ajuste-linha { display:flex; flex-wrap:wrap; gap:12px; font-size:.8rem; padding:6px 10px; background:var(--bg-card); border-radius:var(--radius); margin-bottom:4px; }
  .af-paineis-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; }
  .af-pallet { border:1px solid var(--border); border-radius:var(--radius-lg); padding:10px 12px; background:var(--bg-1); }
  .af-pallet-header { display:flex; justify-content:space-between; align-items:center; font-weight:700; font-size:.85rem; margin-bottom:8px; }
  .af-pallet-tipo { font-size:.66rem; font-weight:600; background:var(--border); color:var(--text-3); padding:2px 8px; border-radius:999px; }
  .af-pallet-slabs { display:flex; flex-direction:column; gap:4px; }
  .af-slab { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:5px 8px; border:1px solid var(--border); border-left-width:3px; border-radius:4px; font-size:.78rem; background:var(--bg-card); }
  .af-slab-num { color:var(--text-3); font-family:var(--font-mono); }
  .af-slab-resultado { font-weight:700; text-align:right; }
  .ba-grid { display:flex; flex-direction:row-reverse; flex-wrap:nowrap; justify-content:center; gap:4px; }
  .ba-celula { display:flex; flex-direction:column; align-items:center; justify-content:space-between; flex:1 1 0; min-width:0; padding:6px 2px; border-radius:var(--radius); }
  .ba-numero { text-align:center; white-space:nowrap; font-size:.72rem; }
  .ba-dot { font-size:.95rem; line-height:1; padding:3px 5px; opacity:.55; border-radius:50%; }
  .ba-dot.ba-dot-marcado { opacity:1; color:var(--red); background:rgba(229,72,77,.15); }
  .mono { font-family:var(--font-mono); }
</style>
</head>
<body>
  <h1>🔎 Análise Focada — Operação ${LW.escaparHtml(String(detalhe.operacao?.id || ''))}</h1>
  <div class="sub" id="exp-sub">Gerado em ${new Date().toLocaleString('pt-BR')}</div>

  <div class="chart-box" style="margin-bottom:14px"><h4>Identificação</h4><div id="af-cabecalho" class="af-cabecalho-grid"></div></div>
  <div class="chart-box" style="margin-bottom:14px"><h4>📍 Berços</h4><div id="af-bercos"></div></div>
  <div class="chart-box" style="margin-bottom:14px"><h4>🧪 Receita Utilizada</h4><div id="af-receita"></div></div>
  <div class="chart-box"><h4>✅ Avaliação de Qualidade</h4><div id="af-avaliacao"></div></div>

  <div class="rodape">Exportado da Análise Focada — Lightwall SC · dados embutidos neste arquivo, funciona offline. Cores de tipo de montagem são aproximadas (não refletem necessariamente a cor configurada na tela ao vivo).</div>

<script>
(function () {
  'use strict';
  const DETALHE = ${detalheJson};
  const LW = {
    escaparHtml: s => { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; },
    TIPO_MONTAGEM_PERSONALIZADA: 'PERSONALIZADA',
    corPorTipoSimples: ${_corPorTipoSimplificada},
    corMontagemPorLabel: ${_corPorTipoSimplificada},
  };
  const _PALETA_TIPO = ${JSON.stringify(_PALETA_TIPO)};

  ${_fmtData}
  ${_fmtHora}
  ${_fmtTempoBatidaOriginal}
  ${_fmtKg}
  ${_renderCabecalho}
  ${_corPorTipoBerco}
  ${_renderBercos}
  ${_renderReceita}
  ${_labelPainel}
  ${_corPainel}
  ${_renderAvaliacao}

  _renderCabecalho(DETALHE.operacao || {});
  _renderBercos(DETALHE.bercosVisuais, DETALHE.operacao);
  _renderReceita(DETALHE.tracos);
  _renderAvaliacao(DETALHE.avaliacao);
})();
</script>
</body>
</html>`;
  }

  function init() {
    render();
  }

  window.LWFocada = { abrir, voltar, init, render, exportarInterativo };
})();