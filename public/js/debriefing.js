// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  debriefing.js — "Debriefing do Dia"
//
//  Seção 100% somente-leitura. Gera um relatório operacional em
//  formato de bloco de notas a partir dos dados JÁ REGISTRADOS.
//  Não cria, não edita e não apaga nenhum dado.
// ============================================================

'use strict';

(function () {

  const $ = id => document.getElementById(id);

  // ---- Data selecionada (estado interno) ----
  let _dataSelecionada = null;

  function todayBrasiliaLocal() {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
    return fmt.format(new Date());
  }

  function horaBrasilia(isoString) {
    if (!isoString) return '—';
    try {
      return new Date(isoString).toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
      });
    } catch (_) { return '—'; }
  }

  function valorFinal(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'object') {
      if (v.total !== undefined && v.total !== '') return parseFloat(v.total);
      const ajustes = Array.isArray(v.ajustes) ? v.ajustes : [];
      const base = parseFloat(v.original);
      if (ajustes.length)
        return ajustes.reduce((s, a) => s + (parseFloat(a) || 0), isNaN(base) ? 0 : base);
      return isNaN(base) ? null : base;
    }
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  function fmtNum(n, casas) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return n.toLocaleString('pt-BR', {
      minimumFractionDigits: casas || 0,
      maximumFractionDigits: casas || 0
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function carregarDados() {
    const [historico, relatorio] = await Promise.all([
      fetch('db/historico.json').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('db/relatorio_injecao.json').then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    return {
      historico: Array.isArray(historico) ? historico : [],
      relatorio: Array.isArray(relatorio) ? relatorio : []
    };
  }

  function montarEstrutura(historico, relatorio, data) {
    const baterias = historico
      .filter(b => b.data === data)
      .sort((a, b) => (a.inicio || '').localeCompare(b.inicio || ''));

    return baterias.map(bateria => {
      const tracos = [];
      relatorio.forEach(traco => {
        const usos = traco.ultilizado?.operacao || [];
        usos.forEach((uso, usoIdx) => {
          if (uso.id_operacao === bateria.id) {
            // Apenas as reutilizações (a partir da 2ª ocorrência) são
            // "reaproveitadas". A primeira ocorrência é o traço original
            // e deve continuar sendo contabilizada no total.
            const reaproveitado = usoIdx > 0;
            tracos.push({
              num_traco:       traco.num_traco,
              flow:            valorFinal(traco.flow),
              densidade:       valorFinal(traco.densidade),
              densidade_eps:   valorFinal(traco.densidade_eps),
              berco_inicio:    uso.berco_inicio,
              berco_fim:       uso.berco_finalizacao,
              obs:             (uso.obs !== undefined ? uso.obs : (traco.obs || '')).trim(),
              reaproveitado,
              origem_bateria:  reaproveitado ? usos[0].id_bateria   : null,
              origem_operacao: reaproveitado ? usos[0].id_operacao  : null,
            });
          }
        });
      });
      tracos.sort((a, b) => (a.num_traco || 0) - (b.num_traco || 0));
      return { bateria, tracos };
    });
  }

  function calcularCabecalho(estrutura) {
    // Conta apenas traços NOVOS (não reaproveitados), usando num_traco como
    // chave de deduplicação. Traços reaproveitados são sobra de um traço já
    // contabilizado em outra bateria e NÃO devem ser somados novamente.
    const tracosUnicos = new Set();
    const temposInjecao = [];
    estrutura.forEach(({ bateria, tracos }) => {
      tracos.forEach(t => {
        if (!t.reaproveitado) {
          tracosUnicos.add(t.num_traco != null ? String(t.num_traco) : '_' + Math.random());
        }
      });
      const tempoMin = parseFloat(bateria?.tempo_min);
      if (!isNaN(tempoMin)) temposInjecao.push(tempoMin);
    });
    const qtdTracos = tracosUnicos.size;
    const qtdBaterias = estrutura.length;
    const mediaTracos = qtdBaterias ? qtdTracos / qtdBaterias : 0;
    const tempoMedioInjecao = temposInjecao.length
      ? temposInjecao.reduce((a, b) => a + b, 0) / temposInjecao.length
      : null;
    return { qtdBaterias, qtdTracos, mediaTracos, tempoMedioInjecao };
  }

  function renderRelatorio(estrutura, data) {
    const cab = calcularCabecalho(estrutura);
    const [y, m, d] = data.split('-');
    const dataFmt = `${d}/${m}/${y}`;
    const ocorrencias = [];
    const reaproveitados = [];

    let html = '';

    html += `<div class="dbf-stats">
      <div class="dbf-stat">
        <span class="dbf-stat-val">${cab.tempoMedioInjecao !== null ? (window.LW && LW.formatDuration ? LW.formatDuration(cab.tempoMedioInjecao) : fmtNum(cab.tempoMedioInjecao, 0)) : '—'}</span>
        <span class="dbf-stat-label">Tempo médio de injeção</span>
      </div>
      <div class="dbf-stat">
        <span class="dbf-stat-val">${cab.qtdBaterias}</span>
        <span class="dbf-stat-label">Baterias</span>
      </div>
      <div class="dbf-stat">
        <span class="dbf-stat-val">${cab.qtdTracos}</span>
        <span class="dbf-stat-label">Traços</span>
      </div>
      <div class="dbf-stat">
        <span class="dbf-stat-val">${cab.qtdBaterias ? fmtNum(cab.mediaTracos, 1) : '—'}</span>
        <span class="dbf-stat-label">Média/bateria</span>
      </div>
    </div>`;

    if (!estrutura.length) {
      html += `<div class="dbf-empty-state">🗒️ Nenhuma operação registrada para ${dataFmt}.</div>`;
      return html;
    }

    html += `<div class="dbf-baterias">`;
    estrutura.forEach(({ bateria, tracos }) => {
      html += `<div class="dbf-bateria-card">`;
      const corMont = LW.corMontagemPorLabel(bateria.tipo_montagem);
      const corTextoMont = corMont.hibrida ? 'var(--text)' : corMont.cor;
      html += `<div class="dbf-bateria-head">
        <span class="dbf-bateria-id"> Bateria ${escapeHtml(bateria.id_bateria || '—')}</span>
        <span class="dbf-badge dbf-badge-montagem" style="background:${corMont.bg};color:${corTextoMont};border:1px solid ${corMont.borda}">${escapeHtml(bateria.tipo_montagem || '—')}</span>
        <span class="dbf-bateria-horario">${horaBrasilia(bateria.inicio)} → ${horaBrasilia(bateria.fim)}</span>
      </div>`;
      html += `<div class="dbf-bateria-meta">Previsão desemplaque: <strong>${LW.formatDateTime(bateria.desemplaque || LW.calcularDesemplaque(bateria.fim))}</strong></div>`;

      if (!tracos.length) {
        html += `<div class="dbf-vazio-mini">Sem traços registrados.</div>`;
      } else {
        html += `<div class="dbf-tracos">`;
        tracos.forEach((t, idx) => {
          const num = escapeHtml(String(t.num_traco ?? (idx + 1)));
          html += `<div class="dbf-traco${t.reaproveitado ? ' is-reaproveitado' : ''}">`;
          html += `<div class="dbf-traco-head">
            <span class="dbf-traco-num">Traço ${num}</span>
            ${t.reaproveitado ? `<span class="dbf-badge dbf-badge-reap">♻ Reaproveitado</span>` : ''}
          </div>`;
          html += `<div class="dbf-traco-grid">
            <span><span class="dbf-traco-label">Flow</span>${t.flow !== null ? fmtNum(t.flow, 0) : '—'}</span>
            <span><span class="dbf-traco-label">Densidade</span>${t.densidade !== null ? fmtNum(t.densidade, 0) : '—'}</span>
            <span><span class="dbf-traco-label">Berços</span>${escapeHtml(t.berco_inicio || '—')} ao ${escapeHtml(t.berco_fim || '—')}</span>
          </div>`;
          if (t.reaproveitado) {
            html += `<div class="dbf-traco-origem">↳ Origem: Operação ${escapeHtml(t.origem_bateria || t.origem_operacao || '—')} · Traço ${num}</div>`;
            reaproveitados.push(t);
          }
          if (t.obs) {
            html += `<div class="dbf-obs">💬 ${escapeHtml(t.obs)}</div>`;
            ocorrencias.push(t.obs);
          }
          html += `</div>`;
        });
        html += `</div>`;
      }
      html += `</div>`;
    });
    html += `</div>`;

    html += `<div class="dbf-section">
      <div class="dbf-section-title">⚠️ Principais Ocorrências</div>`;
    html += ocorrencias.length
      ? `<ul class="dbf-ocorrencias">${ocorrencias.map(o => `<li>${escapeHtml(o)}</li>`).join('')}</ul>`
      : `<div class="dbf-vazio-mini">Nenhuma ocorrência registrada nesta data.</div>`;
    html += `</div>`;

    if (reaproveitados.length) {
      html += `<div class="dbf-section">
        <div class="dbf-section-title">♻ Traços Reaproveitados</div>
        <div class="dbf-reap-chips">${reaproveitados.map(t => {
          const num = escapeHtml(String(t.num_traco ?? '—'));
          return `<span class="dbf-chip">Traço ${num} <small>· Operação ${escapeHtml(t.origem_bateria || t.origem_operacao || '—')}</small></span>`;
        }).join('')}</div>
      </div>`;
    }

    return html;
  }

  async function atualizarConteudo(data) {
    const el = $('debriefing-content');
    if (!el) return;
    el.textContent = 'Carregando...';
    try {
      const { historico, relatorio } = await carregarDados();
      const estrutura = montarEstrutura(historico, relatorio, data);
      el.innerHTML = renderRelatorio(estrutura, data);
    } catch (_) {
      el.innerHTML = '<div class="dbf-empty-state">⚠️ Não foi possível carregar o debriefing.</div>';
    }
  }

  // ---- API pública ----
  window.LWDebriefing = {
    toggle(event) {
      if (event) event.stopPropagation();
      const el = $('popover-debriefing');
      if (!el) return;
      const wasActive = el.classList.contains('active');
      document.querySelectorAll('.ao-popover').forEach(p => p.classList.remove('active'));
      if (!wasActive) {
        el.classList.add('active');
        // Inicializa a data selecionada com hoje na primeira abertura
        if (!_dataSelecionada) _dataSelecionada = todayBrasiliaLocal();
        // Sincroniza o input de data
        const input = $('debriefing-data-input');
        if (input) input.value = _dataSelecionada;
        atualizarConteudo(_dataSelecionada);
      }
    },
    mudarData(valor) {
      if (!valor) return;
      _dataSelecionada = valor;
      atualizarConteudo(_dataSelecionada);
    }
  };

})();