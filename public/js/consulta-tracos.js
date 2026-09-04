// ─── public/js/consulta-tracos.js — Consulta de Insumos por Traço ──────────
// Tela AUXILIAR do Dashboard de Traço/CEP (public/js/qualidade-tracos.js) —
// pedido registrado numa conversa: sem alterar o dashboard existente, uma
// tela à parte pra consultar/exportar o consumo de insumos traço a traço.
//
// Fonte dos dados: db/relatorio_injecao.json (LW.getRelatorioInjecao(),
// data.js) — MESMA fonte do CEP e do Relatório de Injeção. Sem rota nova
// no backend: filtro por período e cálculo de totais são feitos 100% no
// cliente, igual getTracosComFiltros() já faz em qualidade-tracos.js
// (não reaproveitada diretamente de propósito — aquela função também
// filtra por bateria/turno/tipo de montagem, que esta tela não usa; só um
// filtro de data já cobre o pedido, sem acoplar nos internals do CEP).
//
// "Ordem no Dia" em vez de "Hora de Produção" — decisão tomada nesta
// conversa: não existe (nunca existiu) um horário gravado por TRAÇO
// individual, só o início/fim da OPERAÇÃO inteira (a bateria toda, ver
// coluna `inicio`/`fim` de "operacoes", db.js). Mostrar uma hora aqui
// seria inventar precisão que o sistema não tem. Em vez disso, cada
// traço recebe sua posição de produção dentro do dia (1º, 2º, 3º...),
// assumindo que a ordem de chegada em db/relatorio_injecao.json já
// reflete a ordem real de registro (a tabela "tracos" não tem ORDER BY
// na query que gera esse JSON — ver todosOsTracos(), lib/db/tracos.js —
// então volta na ordem de inserção do SQLite, que é a ordem de produção).

'use strict';

(function () {

  let _tracosFiltrados = [];   // já com _ordemDoDia calculada, no filtro atual
  let _tracoSelecionadoId = null;

  // Insumos mostrados no detalhe/exportação — mesmos 5 campos gravados
  // por traço (ver registrarRelatorioInjecao, data.js), rótulos iguais
  // aos usados no resto do app (Registrar Operação, Análise Focada).
  const CAMPOS_INSUMO = [
    { campo: 'cimento_real',       rotulo: 'Cimento' },
    { campo: 'agua_real',          rotulo: 'Água' },
    { campo: 'eps_real',           rotulo: 'EPS' },
    { campo: 'superplast_real',    rotulo: 'Superplastificante' },
    { campo: 'incorporador_real',  rotulo: 'Incorporador de Ar' },
  ];

  function _numOuZero(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Resolve o valor FINAL de um campo de insumo — corrige um bug real
   * (traço com Ajuste de Receita registrado mostrava insumo ZERADO):
   * `cimento_real`/`agua_real`/etc. (db/relatorio_injecao.json, ver
   * rowParaTraco/colapsarOriginalEAjustes, lib/db/tracos.js) vêm como um
   * NÚMERO puro só quando o traço nunca teve ajuste; assim que existe
   * pelo menos 1 ajuste registrado, o campo vira um OBJETO
   * `{ original, ajustes: [...] }` — `Number({...})` dá `NaN`, que toda
   * chamada anterior tratava como 0 silenciosamente. Pra insumo (nunca
   * pra densidade/flow, que são RESULTADO — o último ajuste sobrescreve,
   * não soma — ver _valRel, dashboard.js), o valor certo é
   * original + soma de todos os ajustes.
   */
  function _valorFinalInsumo(v) {
    if (v && typeof v === 'object' && Array.isArray(v.ajustes)) {
      return v.ajustes.reduce((soma, a) => soma + _numOuZero(a), _numOuZero(v.original));
    }
    return _numOuZero(v);
  }

  function _totalInsumos(t) {
    return CAMPOS_INSUMO.reduce((soma, c) => soma + _valorFinalInsumo(t[c.campo]), 0);
  }

  function _fmtKg(v) {
    return _valorFinalInsumo(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + ' kg';
  }

  function _lerFiltro() {
    return {
      dataInicio: document.getElementById('ct-data-inicio')?.value || '',
      dataFim: document.getElementById('ct-data-fim')?.value || '',
    };
  }

  /** Atribui `_ordemDoDia` (1, 2, 3...) a cada traço, contando na ordem
   * em que aparecem no array recebido — ver comentário de topo sobre por
   * que isto substitui um horário exato. Não muta os objetos originais. */
  function _comOrdemDoDia(tracos) {
    const contagem = {};
    return tracos.map(t => {
      contagem[t.data] = (contagem[t.data] || 0) + 1;
      return { ...t, _ordemDoDia: contagem[t.data] };
    });
  }

  /** Dia mais recente primeiro; dentro do mesmo dia, ordem de produção
   * crescente (1º, 2º, 3º...) — mesma convenção de "mais recente no
   * topo" usada no resto do app (Relatório de Injeção, histórico). */
  function _ordenarParaExibicao(tracos) {
    return [...tracos].sort((a, b) => {
      if (a.data !== b.data) return a.data < b.data ? 1 : -1;
      return a._ordemDoDia - b._ordemDoDia;
    });
  }

  async function _carregarTracosDoFiltro() {
    const { dataInicio, dataFim } = _lerFiltro();
    const todos = await LW.getRelatorioInjecao();
    const doPeriodo = todos.filter(t => {
      if (dataInicio && t.data < dataInicio) return false;
      if (dataFim && t.data > dataFim) return false;
      return true;
    });
    // _ordemDoDia é calculada sobre TODOS os traços daquele dia (não só
    // os do período filtrado) — senão, filtrar um único dia faria o
    // 1º traço do dia aparecer sempre como "1ª", mesmo que na prática
    // fosse o 3º do dia e o filtro só tivesse pego a partir dali. Pra
    // isso, primeiro busca os dias envolvidos, refiltra o dataset
    // completo por esses dias específicos (não pelo intervalo do
    // filtro, que pode ter buracos) e SÓ DEPOIS reaplica o filtro
    // original — assim a ordem reflete o dia inteiro, mas a lista final
    // mostra só o que foi pedido.
    const diasEnvolvidos = new Set(doPeriodo.map(t => t.data));
    const doDiaInteiro = todos.filter(t => diasEnvolvidos.has(t.data));
    const comOrdem = _comOrdemDoDia(doDiaInteiro);
    const mapaOrdemPorId = new Map(comOrdem.map(t => [t.id_traco, t._ordemDoDia]));
    return doPeriodo.map(t => ({ ...t, _ordemDoDia: mapaOrdemPorId.get(t.id_traco) || 1 }));
  }

  function renderizarTabela() {
    const tbody = document.getElementById('ct-tbody');
    if (!tbody) return;

    if (!_tracosFiltrados.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-3)">Nenhum traço no período selecionado.</td></tr>';
      return;
    }

    const ordenados = _ordenarParaExibicao(_tracosFiltrados);
    tbody.innerHTML = ordenados.map(t => `
      <tr style="border-top:1px solid var(--border);cursor:pointer" onclick="LWConsultaTracos.abrirDetalhe('${t.id_traco}')">
        <td style="padding:10px 14px">${LW.escaparHtml(t.data || '—')}</td>
        <td style="padding:10px 14px;text-align:center">${t._ordemDoDia}ª</td>
        <td style="padding:10px 14px">${LW.escaparHtml(t.turno || '—')}</td>
        <td style="padding:10px 14px">${LW.escaparHtml(String(t.num_traco ?? '—'))}</td>
        <td style="padding:10px 14px;text-align:right">${_fmtKg(_totalInsumos(t))}</td>
        <td style="padding:10px 14px;text-align:right;white-space:nowrap"><span style="color:var(--accent);font-size:.8rem">Ver insumos →</span></td>
      </tr>`).join('');
  }

  function _atualizarResumo() {
    const el = document.getElementById('ct-resumo');
    if (el) el.textContent = _tracosFiltrados.length + ' traço(s) no período';
  }

  async function render() {
    const tbody = document.getElementById('ct-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-3)">Carregando...</td></tr>';
    _tracosFiltrados = await _carregarTracosDoFiltro();
    renderizarTabela();
    _atualizarResumo();
  }

  // ── Detalhe de 1 traço (modal) ──────────────────────────────────────────

  function abrirDetalhe(idTraco) {
    const traco = _tracosFiltrados.find(t => t.id_traco === idTraco);
    if (!traco) return;
    _tracoSelecionadoId = idTraco;

    const contexto = document.getElementById('ct-detalhe-contexto');
    if (contexto) {
      contexto.textContent = `Traço nº ${traco.num_traco ?? '—'} · ${traco.data || '—'} · ${traco._ordemDoDia}º traço do dia` +
        (traco.turno ? ` · ${traco.turno}` : '');
    }

    const total = _totalInsumos(traco);
    const linhas = CAMPOS_INSUMO.map(c => `
      <div style="display:flex;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);font-size:.88rem">
        <span style="color:var(--text-2)">${c.rotulo}</span>
        <strong>${_fmtKg(traco[c.campo])}</strong>
      </div>`).join('');
    const linhaTotal = `
      <div style="display:flex;justify-content:space-between;padding:12px 14px;background:var(--bg-2)">
        <span style="color:var(--text);font-weight:600">Total de Insumos</span>
        <strong style="color:var(--accent)">${_fmtKg(total)}</strong>
      </div>`;

    const el = document.getElementById('ct-detalhe-insumos');
    if (el) el.innerHTML = linhas + linhaTotal;

    document.getElementById('ct-detalhe-modal').style.display = 'flex';
  }

  function fecharDetalhe() {
    document.getElementById('ct-detalhe-modal').style.display = 'none';
    _tracoSelecionadoId = null;
  }

  // ── Exportação Excel (SheetJS/window.XLSX — mesma lib já usada em
  // setor-qualidade.js, carregada globalmente, ver index.template.html) ──

  /** Uma linha por traço — mesmo layout de colunas pedido: Data | Ordem
   * no Dia (no lugar de "Hora", ver comentário de topo) | Nº do Traço |
   * Cimento | Água | EPS | Plastificante | Incorporador | Total. */
  function _linhaExportPeriodo(t) {
    const linha = { 'Data': t.data || '', 'Ordem no Dia': t._ordemDoDia, 'Turno': t.turno || '', 'Nº do Traço': t.num_traco ?? '' };
    CAMPOS_INSUMO.forEach(c => { linha[c.rotulo + ' (kg)'] = _valorFinalInsumo(t[c.campo]); });
    linha['Total de Insumos (kg)'] = _totalInsumos(t);
    return linha;
  }

  function _gerarPlanilha(linhas, nomeAba) {
    const ws = XLSX.utils.json_to_sheet(linhas);
    ws['!cols'] = Object.keys(linhas[0]).map(chave => {
      const maxLen = linhas.reduce((max, row) => Math.max(max, String(row[chave] ?? '').length), chave.length);
      return { wch: maxLen + 4 };
    });
    ws['!views'] = [{ state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft' }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, nomeAba);
    return wb;
  }

  function exportarPeriodo() {
    if (typeof XLSX === 'undefined') {
      LW.mostrarAlerta('Biblioteca de exportação (XLSX) não carregou. Recarregue a página e tente de novo.', { tipo: 'erro' });
      return;
    }
    if (!_tracosFiltrados.length) {
      LW.mostrarAlerta('Nenhum traço no período selecionado para exportar.', { tipo: 'aviso' });
      return;
    }
    const ordenados = _ordenarParaExibicao(_tracosFiltrados).slice().reverse(); // cronológico (mais antigo primeiro) fica melhor pra somar/analisar no Excel
    const linhas = ordenados.map(_linhaExportPeriodo);
    const wb = _gerarPlanilha(linhas, 'Traços');
    const { dataInicio, dataFim } = _lerFiltro();
    const sufixo = (dataInicio || dataFim) ? `${dataInicio || 'inicio'}_a_${dataFim || 'hoje'}` : 'todos';
    XLSX.writeFile(wb, `lightwall_insumos_por_traco_${sufixo}.xlsx`);
  }

  function exportarTracoSelecionado() {
    if (typeof XLSX === 'undefined') {
      LW.mostrarAlerta('Biblioteca de exportação (XLSX) não carregou. Recarregue a página e tente de novo.', { tipo: 'erro' });
      return;
    }
    const traco = _tracosFiltrados.find(t => t.id_traco === _tracoSelecionadoId);
    if (!traco) return;

    // Formato "ficha" (Campo/Valor), não a mesma tabela do período — é
    // um registro só, lido/impresso como referência individual, não
    // uma lista pra somar no Excel (isso é o export de período, acima).
    const linhas = [
      { Campo: 'Data', Valor: traco.data || '' },
      { Campo: 'Turno', Valor: traco.turno || '' },
      { Campo: 'Nº do Traço', Valor: traco.num_traco ?? '' },
      { Campo: 'Ordem no Dia', Valor: traco._ordemDoDia },
      ...CAMPOS_INSUMO.map(c => ({ Campo: c.rotulo + ' (kg)', Valor: _valorFinalInsumo(traco[c.campo]) })),
      { Campo: 'Total de Insumos (kg)', Valor: _totalInsumos(traco) },
    ];
    const wb = _gerarPlanilha(linhas, 'Traço');
    XLSX.writeFile(wb, `lightwall_traco_${traco.num_traco ?? traco.id_traco}_${traco.data || ''}.xlsx`);
  }

  // ── Ponto de entrada a partir do Dashboard de Traço (botão "🔍
  // Consultar Insumos por Traço", page-qualidade-tracos.html) — carrega
  // o MESMO período que já estava filtrado lá, pra não obrigar a pessoa
  // a escolher tudo de novo. ──
  function abrirComPeriodoAtual() {
    const iniOrigem = document.getElementById('qt-data-inicio');
    const fimOrigem = document.getElementById('qt-data-fim');
    const periodoOrigem = document.getElementById('qt-periodo');
    const iniDestino = document.getElementById('ct-data-inicio');
    const fimDestino = document.getElementById('ct-data-fim');
    const periodoDestino = document.getElementById('ct-periodo');
    if (iniOrigem && iniDestino) iniDestino.value = iniOrigem.value || '';
    if (fimOrigem && fimDestino) fimDestino.value = fimOrigem.value || '';
    if (periodoOrigem && periodoDestino && periodoOrigem.value !== 'personalizado') {
      periodoDestino.value = periodoOrigem.value;
    }
    showPage('consulta-tracos');
  }

  // ── Ponto de entrada a partir de qualquer lugar que já sabe o
  // id_traco exato (README, pedido — "atalho no Ctrl pra jogar pra essa
  // consulta, assim como a operação joga pra Análise Focada"): mesmo
  // padrão de Ctrl/⌘+clique já usado em onClickLinhaRegistro
  // (dashboard.js) — chamado por onClickLinhaRelatorio (Relatório de
  // Injeção, mesmo arquivo). Ajusta o filtro pro DIA do traço (não
  // depende do filtro que já estava selecionado na tela) e já abre o
  // modal de detalhe direto, sem precisar procurar na lista. ──
  async function abrirTracoEspecifico(idTraco) {
    showPage('consulta-tracos');
    const todos = await LW.getRelatorioInjecao();
    const traco = todos.find(t => t.id_traco === idTraco);
    if (!traco) {
      LW.mostrarAlerta('Não encontrei esse traço no Relatório de Injeção.', { tipo: 'erro' });
      return;
    }
    const periodoEl = document.getElementById('ct-periodo');
    const iniEl = document.getElementById('ct-data-inicio');
    const fimEl = document.getElementById('ct-data-fim');
    if (periodoEl) periodoEl.value = 'personalizado';
    if (iniEl) iniEl.value = traco.data;
    if (fimEl) fimEl.value = traco.data;
    await render();
    abrirDetalhe(idTraco);
  }

  function init() {
    const periodo = document.getElementById('ct-periodo');
    if (periodo) {
      periodo.addEventListener('change', () => {
        if (periodo.value === 'personalizado') return; // deixa as datas como a pessoa preencher na mão
        const { ini, fim } = calcularPeriodoPreset(periodo.value);
        const iniEl = document.getElementById('ct-data-inicio');
        const fimEl = document.getElementById('ct-data-fim');
        if (iniEl) iniEl.value = ini;
        if (fimEl) fimEl.value = fim;
        render();
      });
    }
  }

  window.LWConsultaTracos = {
    init, render,
    abrirDetalhe, fecharDetalhe,
    exportarPeriodo, exportarTracoSelecionado,
    abrirComPeriodoAtual, abrirTracoEspecifico,
  };

})();
