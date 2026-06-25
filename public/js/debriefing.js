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
    const densidadesEps = [];
    estrutura.forEach(({ tracos }) => {
      tracos.forEach(t => {
        if (!t.reaproveitado) {
          tracosUnicos.add(t.num_traco != null ? String(t.num_traco) : '_' + Math.random());
        }
        if (t.densidade_eps !== null) densidadesEps.push(t.densidade_eps);
      });
    });
    const qtdTracos = tracosUnicos.size;
    const qtdBaterias = estrutura.length;
    const mediaTracos = qtdBaterias ? qtdTracos / qtdBaterias : 0;
    let epsPredominante = null;
    if (densidadesEps.length) {
      const cnt = {};
      densidadesEps.forEach(v => { cnt[v] = (cnt[v] || 0) + 1; });
      const maxF = Math.max(...Object.values(cnt));
      const tops = Object.keys(cnt).filter(k => cnt[k] === maxF).map(Number);
      epsPredominante = tops.length === 1 ? tops[0] : tops.reduce((a, b) => a + b, 0) / tops.length;
    }
    return { qtdBaterias, qtdTracos, mediaTracos, epsPredominante };
  }

  function renderRelatorio(estrutura, data) {
    const cab = calcularCabecalho(estrutura);
    const [y, m, d] = data.split('-');
    const dataFmt = `${d}/${m}/${y}`;
    const linhas = [];
    const sep = () => linhas.push(`<span class="dbf-sep">────────────────────────────</span>`);
    const ocorrencias = [];
    const reaproveitados = [];

    linhas.push(`<span class="dbf-titulo">RELATÓRIO DE PRODUÇÃO - ${dataFmt}</span>`);
    linhas.push('');
    linhas.push(`EPS: ${cab.epsPredominante !== null ? fmtNum(cab.epsPredominante, 0) + ' kg/m³' : '—'}`);
    linhas.push(`Baterias injetadas: ${cab.qtdBaterias}`);
    linhas.push(`Total de traços: ${cab.qtdTracos}`);
    linhas.push(`Média de traços por bateria: ${cab.qtdBaterias ? fmtNum(cab.mediaTracos, 1) : '—'}`);

    if (!estrutura.length) {
      sep();
      linhas.push('<span class="dbf-vazio">Nenhuma operação registrada para esta data.</span>');
    }

    estrutura.forEach(({ bateria, tracos }) => {
      sep();
      linhas.push(`<span class="dbf-secao">BATERIA ${escapeHtml(bateria.id_bateria || '—')}</span>`);
      linhas.push(`Início: ${horaBrasilia(bateria.inicio)}`);
      linhas.push(`Fim: ${horaBrasilia(bateria.fim)}`);
      linhas.push(`Desemplaque: ${LW.formatDateTime(bateria.desemplaque || LW.calcularDesemplaque(bateria.fim))}`);

      if (!tracos.length) {
        linhas.push('<span class="dbf-vazio">Sem traços registrados.</span>');
      }

      tracos.forEach((t, idx) => {
        const num = t.num_traco ?? (idx + 1);
        linhas.push('');
        linhas.push(`Traço ${num}`);
        linhas.push(`Flow/Densidade: ${t.flow !== null ? fmtNum(t.flow, 0) : '—'} / ${t.densidade !== null ? fmtNum(t.densidade, 0) : '—'}`);
        linhas.push(`Berços: ${escapeHtml(t.berco_inicio || '—')} ao ${escapeHtml(t.berco_fim || '—')}`);
        if (t.obs) {
          linhas.push(`Observações:`);
          linhas.push(`• ${escapeHtml(t.obs)}`);
          ocorrencias.push(t.obs);
        }
        if (t.reaproveitado) {
          linhas.push(`♻ Traço reaproveitado`);
          linhas.push(`Origem: Operação ${escapeHtml(t.origem_bateria || t.origem_operacao || '—')} Traço ${num}`);
          reaproveitados.push(t);
        }
      });
    });

    sep();
    linhas.push(`<span class="dbf-secao">PRINCIPAIS OCORRÊNCIAS</span>`);
    if (ocorrencias.length) {
      ocorrencias.forEach(o => linhas.push(`• ${escapeHtml(o)}`));
    } else {
      linhas.push('<span class="dbf-vazio">Nenhuma ocorrência registrada nesta data.</span>');
    }

    if (reaproveitados.length) {
      sep();
      linhas.push(`<span class="dbf-secao">TRAÇOS REAPROVEITADOS</span>`);
      reaproveitados.forEach(t => {
        const num = t.num_traco ?? '—';
        linhas.push(`♻ Traço ${num} — Origem: Operação ${escapeHtml(t.origem_bateria || t.origem_operacao || '—')}`);
      });
    }

    return linhas.join('\n');
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
      el.innerHTML = '<span class="dbf-vazio">Não foi possível carregar o debriefing.</span>';
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