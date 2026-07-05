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

  // ── Desenho da bateria (berços visuais) ──────────────────────
  // Mesma grade visual usada no popover de hover do Relatório de Berços
  // e no card "Bateria Atual" (.ba-grid/.ba-celula/.ba-dot, ver
  // css/styles.css) — aqui só leitura, sem clique nenhum.
  function _renderBercos(bercosVisuais) {
    const el = document.getElementById('af-bercos');
    if (!el) return;
    if (!bercosVisuais || !bercosVisuais.length) {
      el.innerHTML = `<div class="sq-empty-af"><i class="fas fa-inbox"></i> Berços visuais ainda não registrados para esta operação.</div>`;
      return;
    }
    const ordenados = bercosVisuais.slice().sort((a, b) => a.ordem - b.ordem);
    el.innerHTML = `<div class="ba-grid">${ordenados.map(b => {
      const dirMarcado = b.estado_direita === 'baixou';
      const esqMarcado = b.estado_esquerda === 'baixou';
      const algumMarcado = dirMarcado || esqMarcado;
      const numero = String(b.ordem).padStart(2, '0');
      return `
        <div class="ba-celula" style="background:var(--bg-2);color:var(--text-2);border:1px solid var(--border)">
          <span class="ba-dot ba-dot-topo${dirMarcado ? ' ba-dot-marcado' : ''}" title="Direito">•</span>
          <span class="ba-numero">B${numero}${algumMarcado ? ' ⚠️' : ''}</span>
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
    return p.tipoObtido || '—'; // caso raro: 'Outros'/'Múltiplas' (ver classifyMarks, setor-qualidade.js)
  }
  function _corPainel(p) {
    if (!p) return 'var(--border-2)';
    if (p.resultado === 'aprovado') return p.linha === '2ª' ? 'var(--blue)' : 'var(--green)';
    if (p.resultado === 'reprovado') return 'var(--red)';
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
    _renderBercos(detalhe.bercosVisuais);
    _renderReceita(detalhe.tracos);
    _renderAvaliacao(detalhe.avaliacao);
  }

  function init() {
    render();
  }

  window.LWFocada = { abrir, voltar, init, render };
})();
