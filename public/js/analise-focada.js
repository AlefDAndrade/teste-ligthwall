// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  analise-focada.js — Análise Focada de uma Operação (Rastreabilidade)
// ============================================================
// Acessada de duas formas:
//   1) Clicando numa linha do Registro de Baterias com o "modo de foco"
//      ligado (ver LWDash.toggleModoFocoRegistro/onClickLinhaRegistro,
//      dashboard.js) — chega já com uma operação escolhida.
//   2) Pelo item "Rastreabilidade" da sidebar — chega sem operação
//      nenhuma, com uma busca por ID de Bateria/Operação/Traço (ver
//      abrirBusca/buscar, abaixo).
// Junta tudo que se liga por id_operacao — o elo comum entre histórico,
// relatório de injeção e berços visuais — numa página só: identificação
// da operação, o desenho da bateria (berços visuais), a receita usada
// (com ajustes, se algum), de ONDE cada traço veio e se sobrou pra ser
// reaproveitado depois (ver _anotarOrigemEReaproveitamento, abaixo — usa
// db.detalheOperacao() pro grosso dos dados, mas a cadeia de
// reaproveitamento não está lá: é resolvida aqui, cruzando com
// relatorio_injecao.json, mesma técnica já usada em debriefing.js), as
// paradas que caíram dentro da janela dela, e a avaliação de qualidade
// vinculada.
'use strict';

(function () {
  let _idAtual = null;
  // Último `detalhe` carregado por render() (operacao/bercosVisuais/tracos)
  // — cache simples pra "📋 Detalhes do Berço" (ver abrirDetalhesBerco,
  // abaixo) não precisar buscar tudo de novo num clique que é só um
  // recorte visual do que a página já tem na tela.
  let _ultimoDetalhe = null;

  // ── Cache dos dados usados pela BUSCA e pela cadeia de reaproveitamento
  // — carregados uma vez só (lazy, na 1ª busca ou no 1º render de uma
  // operação) e reaproveitados nas chamadas seguintes dentro da mesma
  // sessão de página. Não há invalidação automática de propósito: é
  // dado histórico que não muda com o tempo que alguém passa olhando
  // esta tela, e um F5 já recarrega tudo do zero se precisar.
  let _cacheHistorico = null;   // db/historico.json — pra achar por ID de Bateria/Operação e resolver nomes na cadeia
  let _cacheTracos = null;      // db/relatorio_injecao.json — pra achar por ID de Traço e resolver a cadeia de reaproveitamento
  let _cacheParadas = null;     // db/paradas.json

  async function _carregarCaches() {
    const precisa = !_cacheHistorico || !_cacheTracos || !_cacheParadas;
    if (!precisa) return;
    const [historico, tracos, paradas] = await Promise.all([
      fetch('db/historico.json').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('db/relatorio_injecao.json').then(r => r.ok ? r.json() : []).catch(() => []),
      fetch('db/paradas.json').then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    _cacheHistorico = Array.isArray(historico) ? historico : [];
    _cacheTracos = Array.isArray(tracos) ? tracos : [];
    _cacheParadas = Array.isArray(paradas) ? paradas : [];
  }

  // ── Abre a página focada numa operação específica — chamado de fora
  // (dashboard.js) quando o usuário clica numa linha com o modo de foco
  // ligado. showPage() é global (app-core.js). ──
  function abrir(idOperacao) {
    _idAtual = idOperacao;
    showPage('analise-focada');
  }

  // ── Entrada pela sidebar ("Rastreabilidade") — sem operação
  // pré-escolhida: limpa a seleção atual pra render() mostrar a busca em
  // vez de reabrir a última operação vista. Chamado ANTES de showPage()
  // no onclick do nav-item (ver nav-sidebar.html) — showPage() já chama
  // LWFocada.init()/render() em seguida, então só precisa zerar aqui.
  function abrirBusca() {
    _idAtual = null;
  }

  function voltar() {
    showPage('registro');
  }

  // ============================================================
  //  BUSCA — ID de Bateria, Operação ou Traço
  // ============================================================

  // Acha operações candidatas pra uma query de texto — 3 formas de bater,
  // checadas nesta ordem (a mais específica primeiro, pra não ambiguar
  // um ID de operação/traço com um pedaço solto de texto):
  //   1) ID de Operação exato — sempre 1 resultado só.
  //   2) ID de Traço (id_traco OU num_traco) — resolve pra a operação
  //      ONDE ELE FOI USADO PELA PRIMEIRA VEZ (usos[0] — ver
  //      _anotarOrigemEReaproveitamento, mais abaixo, pro raciocínio
  //      completo da cadeia); se o traço foi reaproveitado depois, dá
  //      pra navegar pras operações seguintes a partir de lá.
  //   3) ID de Bateria (parcial, sem diferenciar maiúsc./minúsc.) — pode
  //      bater em VÁRIAS operações (a mesma bateria física roda muitas
  //      vezes ao longo do tempo) — mais recente primeiro.
  function _buscarCandidatos(query) {
    const q = String(query || '').trim();
    if (!q) return [];
    const qLower = q.toLocaleLowerCase();

    const porId = _cacheHistorico.find(op => op.id === q);
    if (porId) return [porId];

    const tracoAchado = _cacheTracos.find(t => t.id_traco === q || String(t.num_traco) === q);
    if (tracoAchado) {
      const usos = tracoAchado.ultilizado?.operacao || [];
      if (usos.length) {
        const opOrigem = _cacheHistorico.find(op => op.id === usos[0].id_operacao);
        if (opOrigem) return [opOrigem];
      }
    }

    return _cacheHistorico
      .filter(op => (op.id_bateria || '').toLocaleLowerCase().includes(qLower))
      .sort((a, b) => (b.data + (b.fim || '')).localeCompare(a.data + (a.fim || '')))
      .slice(0, 15);
  }

  // Entrada pública (botão "Buscar"/Enter no campo, ver
  // page-analise-focada.html). 1 resultado → abre direto; vários → lista
  // pra escolher; nenhum → avisa.
  async function buscar(query) {
    const q = String(query || '').trim();
    const resultadosEl = document.getElementById('af-busca-resultados');
    if (!q) { if (resultadosEl) resultadosEl.style.display = 'none'; return; }

    if (resultadosEl) {
      resultadosEl.style.display = '';
      resultadosEl.innerHTML = `<div style="color:var(--text-3);font-size:.85rem">Buscando…</div>`;
    }

    await _carregarCaches();
    const candidatos = _buscarCandidatos(q);

    if (candidatos.length === 1) {
      if (resultadosEl) resultadosEl.style.display = 'none';
      abrir(candidatos[0].id);
      return;
    }
    if (!candidatos.length) {
      if (resultadosEl) {
        resultadosEl.innerHTML = `<div style="color:var(--text-3);font-size:.85rem">Nenhuma operação encontrada para "${LW.escaparHtml(q)}".</div>`;
      }
      return;
    }
    _renderResultadosBusca(candidatos);
  }

  function _renderResultadosBusca(candidatos) {
    const el = document.getElementById('af-busca-resultados');
    if (!el) return;
    el.innerHTML = `
      <div style="font-size:.8rem;color:var(--text-2);margin-bottom:6px">${candidatos.length} operações encontradas — escolha uma:</div>
      <div style="display:flex;flex-direction:column;gap:4px;max-height:260px;overflow-y:auto">
        ${candidatos.map(op => `
          <button class="btn btn-ghost btn-sm" style="justify-content:flex-start;text-align:left"
            onclick="LWFocada.abrir('${op.id}')">
            <strong style="margin-right:8px">${LW.escaparHtml(op.id_bateria || '—')}</strong>
            <span style="color:var(--text-3)">${_fmtData(op.data)} · ${LW.escaparHtml(op.turno || '—')} · ${LW.escaparHtml(op.tipo_montagem || '—')}</span>
          </button>
        `).join('')}
      </div>
    `;
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
    // timeZone:'UTC' de propósito — op.inicio/op.fim (de uma Operação, ver
    // Registrar Operação) são gravados via nowBrasilia().toISOString()
    // (data.js), que guarda o valor UTC do Date já AJUSTADO pra
    // representar o horário de Brasília (ver comentário de nowBrasilia())
    // — não é um instante UTC de verdade. Sem timeZone:'UTC' aqui, o
    // navegador aplicava a conversão de fuso REAL em cima desse valor já
    // ajustado, deslocando o horário mostrado (bug real relatado pelo
    // usuário: bateria feita às 14h aparecia como feita às 11h — exatos
    // os 3h do fuso de Brasília, um deslocamento em dobro). Mesma
    // correção já aplicada em dashboard.js ("Hora Início"/"Hora Fim") e
    // em qualquer outro lugar que formate esses mesmos campos.
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
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
  // @param {HTMLElement} [elOverride] - quando informado, renderiza AQUI em
  // vez de buscar '#af-cabecalho' no documento ao vivo. Usado pelo export
  // estático de PDF (ver _gerarSecoesEstaticasAf, mais abaixo), que precisa
  // do MESMO markup produzido aqui mas capturado num elemento solto (fora da
  // tela), sem tocar no DOM real da página.
  function _renderCabecalho(op, elOverride) {
    const el = elOverride || document.getElementById('af-cabecalho');
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

  // ============================================================
  //  📋 Detalhes do Berço — SÓ LEITURA
  //
  //  Mesmo modal do card "Bateria Atual" (ver _abrirDetalhesBerco,
  //  bateria-atual.js) — aqui reaproveita as mesmas classes CSS
  //  (.ba-detalhes-*, styles.css), mas SEM o campo de Dimensão editável
  //  nem o botão Salvar: esta é uma operação já REGISTRADA, não faz
  //  sentido editar berço a berço por aqui (quem precisa corrigir usa
  //  "Editar Operação"). O helper abaixo (_afCapacidadeConfigurada/
  //  _afPaleteDoBerco/_afDesenhoPaleteMini/AF_CORES_PALETE) é cópia
  //  das equivalentes em bateria-atual.js — duplicada de propósito,
  //  mesmo padrão já usado no resto deste arquivo (_corPorTipoBerco,
  //  acima), pra não acoplar esta tela à de Registro.
  // ============================================================

  // SEMPRE o nº de berços CADASTRADO pra bateria — não existe mais uma
  // capacidade "declarada" separada (bercos_reais foi removido; um berço
  // que não vai ser usado agora se marca individualmente como 🚫 Não
  // Enchido, não muda o total da bateria).
  function _afCapacidadeConfigurada(op) {
    const bateria = (LW.BATERIA_IDS || []).find(b => b.id === op.id_bateria);
    return bateria?.bercos || 0;
  }

  // Cópia local de LW.formatDateTime (data.js) — mesmo padrão de
  // duplicação já usado neste arquivo (ver comentário no topo desta
  // seção): o HTML exportado standalone não tem acesso a data.js, então
  // o modal de Detalhes do Berço embutido no export (ver
  // _gerarHtmlAfStandalone, mais abaixo) precisa da própria cópia.
  function _afFormatDateTime(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '—';
    const data = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    return `${data} ${hora}`;
  }

  const AF_CORES_PALETE = { 1: '#66bb6a', 2: '#42a5f5', 3: '#ab47bc', 4: '#ffa726' };

  function _afPaletePorMetadeELado() {
    const cfg = LW.PALETES_CONFIG || LW.PALETES_CONFIG_DEFAULT;
    return {
      esquerdo: { primeira: cfg.esquerdoPrimeira, segunda: cfg.esquerdoSegunda },
      direito:  { primeira: cfg.direitoPrimeira,  segunda: cfg.direitoSegunda },
    };
  }

  function _afPaleteDoBerco(bercoNum, lado, capacidade) {
    if (!capacidade || capacidade <= 0) return null;
    const metade = Math.ceil(capacidade / 2);
    const primeiraMetade = bercoNum <= metade;
    const pallet = _afPaletePorMetadeELado()[lado]?.[primeiraMetade ? 'primeira' : 'segunda'];
    if (!pallet) return null;
    const posicao = primeiraMetade ? bercoNum : bercoNum - metade;
    return { pallet, posicao, metade };
  }

  function _afDesenhoPaleteMini(pos) {
    if (!pos) return '<div class="ba-det-valor">—</div>';
    const cor = AF_CORES_PALETE[pos.pallet] || 'var(--accent)';
    const slots = [];
    for (let i = 1; i <= pos.metade; i++) {
      const ativo = i === pos.posicao;
      slots.push(
        `<span class="ba-palete-slot${ativo ? ' ba-palete-slot-ativo' : ''}"
          style="${ativo ? `background:${cor};border-color:${cor}` : ''}">${i}</span>`
      );
    }
    return `
      <div class="ba-palete-mini">
        <div class="ba-palete-mini-titulo" style="color:${cor}">Palete 0${pos.pallet}</div>
        <div class="ba-palete-mini-stack">${slots.join('')}</div>
      </div>`;
  }

  function _afTiposPorBerco(op, capacidade, gradePersonalizada, ehPersonalizada) {
    if (ehPersonalizada) {
      return Array.from({ length: capacidade }, (_, i) => gradePersonalizada[i] || null);
    }
    return Array.from({ length: capacidade }, () => op.tipo_montagem || null);
  }

  // Acha, dentre os traços já registrados desta operação, qual cobre o
  // berço informado — mesma técnica de _tracoQueEncheuBerco
  // (bateria-atual.js), só que aqui em cima dos campos já PERSISTIDOS
  // (berco_inicio/berco_finalizacao, ver detalheOperacao em db.js) em
  // vez do estado ao vivo (berco_ini/berco_fim, ainda em memória).
  function _afTracoDoBerco(tracos, numeroBerco) {
    for (const t of (tracos || [])) {
      const ini = parseInt(t.berco_inicio, 10);
      const fim = parseInt(t.berco_finalizacao, 10);
      if (isNaN(ini) || isNaN(fim)) continue;
      if (numeroBerco >= Math.min(ini, fim) && numeroBerco <= Math.max(ini, fim)) return t;
    }
    return null;
  }

  // Painel avaliado que caiu na posição (pallet+posicao) informada —
  // mesmo cruzamento que _afPaleteDoBerco já faz pra desenhar o mini
  // palete (acima), só que aqui contra avaliacao.paineis em vez de só
  // devolver a posição. Usa _labelPainel/_corPainel (mesmas funções da
  // seção "✅ Avaliação de Qualidade" da tela cheia, ver _renderAvaliacao)
  // pra manter o mesmo texto/cor em ambos os lugares.
  function _afPainelDoBerco(avaliacao, pos) {
    if (!avaliacao || !pos) return null;
    const paineis = avaliacao.paineis || [];
    return paineis.find(p => p.pallet === pos.pallet && p.posicao === pos.posicao) || null;
  }

  // Chamada pelo clique numa célula da grade (ver _renderBercos, abaixo)
  // — usa _ultimoDetalhe (preenchido por render()) em vez de receber os
  // dados por parâmetro, pra poder ser referenciada direto no onclick
  // inline da célula (mesmo padrão de _badgeOperacao, mais abaixo).
  function abrirDetalhesBerco(numeroBerco) {
    if (!_ultimoDetalhe || !_ultimoDetalhe.operacao) return;
    const op = _ultimoDetalhe.operacao;
    const bercosVisuais = _ultimoDetalhe.bercosVisuais || [];
    const tracos = _ultimoDetalhe.tracos || [];
    document.getElementById('af-modal-detalhes-berco')?.remove();

    const ehPersonalizada = op.tipo_montagem === LW.TIPO_MONTAGEM_PERSONALIZADA;
    // Linha crua da tabela — bercos_personalizados/bercos_dimensoes
    // chegam como STRING JSON (ver detalheOperacao, db.js), igual ao
    // que _renderBercos (abaixo) já normaliza pra desenhar a grade.
    let gradePersonalizada = [];
    if (ehPersonalizada && op.bercos_personalizados) {
      gradePersonalizada = typeof op.bercos_personalizados === 'string'
        ? (() => { try { return JSON.parse(op.bercos_personalizados); } catch (_) { return []; } })()
        : op.bercos_personalizados;
    }
    let bercosDimensoes = null;
    if (op.bercos_dimensoes) {
      bercosDimensoes = typeof op.bercos_dimensoes === 'string'
        ? (() => { try { return JSON.parse(op.bercos_dimensoes); } catch (_) { return null; } })()
        : op.bercos_dimensoes;
    }

    const capacidade = _afCapacidadeConfigurada(op);
    const tipos = _afTiposPorBerco(op, capacidade, gradePersonalizada, ehPersonalizada);
    const tipoAtualCodigo = tipos[numeroBerco - 1] || null;
    const cor = _corPorTipoBerco(ehPersonalizada, tipoAtualCodigo);
    const labelTipoAtual = ehPersonalizada
      ? ((LW.MONTAGEM_OPCOES || []).find(o => o.tipo === tipoAtualCodigo)?.label || tipoAtualCodigo || '—')
      : (tipoAtualCodigo || '—');

    const berco = bercosVisuais.find(b => b.ordem === numeroBerco) || {};
    const dirNaoEnchido = berco.estado_direita === 'nao_enchido';
    const esqNaoEnchido = berco.estado_esquerda === 'nao_enchido';
    const dirMarcado = berco.estado_direita === 'baixou' || dirNaoEnchido;
    const esqMarcado = berco.estado_esquerda === 'baixou' || esqNaoEnchido;

    // Dimensão DESTE berço específico — mesmo override individual usado
    // em bateria-atual.js (bercos_dimensoes), só que aqui SÓ pra
    // exibição (sem input, ver campos abaixo).
    const dimensaoBerco = (Array.isArray(bercosDimensoes) && bercosDimensoes[numeroBerco - 1]) || op.dimensao || '—';
    const dataEnchimento = op.inicio ? LW.formatDateTime(op.inicio) : '—';
    const traco = _afTracoDoBerco(tracos, numeroBerco);
    const labelTraco = traco ? `Traço Nº ${LW.escaparHtml(String(traco.num_traco ?? traco.id_traco))}` : 'Não identificado';

    const capacidadePalete = capacidade;
    const posicaoDireito = _afPaleteDoBerco(numeroBerco, 'direito', capacidadePalete);
    const posicaoEsquerdo = _afPaleteDoBerco(numeroBerco, 'esquerdo', capacidadePalete);

    // Avaliação de Qualidade DESTE berço — acha, pra cada lado, o painel
    // avaliado que caiu na mesma posição de palete calculada acima (ver
    // _afPainelDoBerco). Bateria sem avaliação nenhuma (avaliacao null,
    // ver _renderAvaliacao) some o campo inteiro em vez de mostrar
    // "— Sem marcação" nos dois lados, que sugeriria marcação zerada
    // quando na verdade é que a bateria nunca foi avaliada.
    const avaliacaoOp = _ultimoDetalhe.avaliacao || null;
    const painelDireito = _afPainelDoBerco(avaliacaoOp, posicaoDireito);
    const painelEsquerdo = _afPainelDoBerco(avaliacaoOp, posicaoEsquerdo);

    // Receita do traço que encheu este berço — mesmos campos e mesma
    // formatação de "Receita Utilizada" (_renderReceita, acima), só que
    // filtrados pra UM traço em vez da lista inteira da operação.
    // Reaproveita a classe .af-receita-grid (styles.css) pra manter a
    // mesma aparência.
    let receitaHtml = null;
    if (traco) {
      const camposReceita = [
        ['Cimento', _fmtKg(traco.original?.cimento), 'kg'],
        ['Água', _fmtKg(traco.original?.agua), 'kg'],
        ['EPS', _fmtKg(traco.original?.eps), 'kg'],
        ['Densidade EPS', traco.densidade_eps || null, 'kg/m³'],
        ['Silo EPS', traco.silo || null, ''],
        ['Expansão', traco.expansao || null, ''],
        ['Superplast.', _fmtKg(traco.original?.superplast), 'kg'],
        ['Incorp. de Ar', _fmtKg(traco.original?.incorporador), 'kg'],
        ['Tempo de Batida', _fmtTempoBatidaOriginal(traco.original?.tempo_batida), ''],
        ['Densidade', traco.densidade ?? null, 'kg/m³'],
        ['Flow', traco.flow ?? null, ''],
      ];
      receitaHtml = camposReceita.map(([label, valor, unidade]) =>
        `<div>${label}: <strong>${valor === null || valor === undefined ? '—' : valor + (unidade ? ' ' + unidade : '')}</strong></div>`
      ).join('');
    }

    const numeroFmt = String(numeroBerco).padStart(2, '0');
    const overlay = document.createElement('div');
    overlay.id = 'af-modal-detalhes-berco';
    overlay.className = 'ba-detalhes-overlay';
    overlay.innerHTML = `
      <div class="ba-detalhes-box">
        <button type="button" class="ba-detalhes-fechar" id="af-det-fechar" aria-label="Fechar" title="Fechar">✕</button>
        <h3 class="ba-detalhes-titulo">Detalhes do Berço B${numeroFmt}</h3>

        <div class="ba-detalhes-desenho">
          <div class="ba-detalhes-celula"
            style="background:${cor ? cor.bg : 'var(--bg-2)'};color:${cor ? cor.cor : 'var(--text-3)'};border:2px solid ${cor ? cor.borda : 'var(--border)'}">
            <span class="ba-detalhes-dot${dirNaoEnchido ? ' ba-detalhes-dot-x' : dirMarcado ? ' ba-detalhes-dot-vazou' : ''}" title="${dirNaoEnchido ? 'Direito — Não enchido' : dirMarcado ? 'Direito — Baixou/Vazou' : 'Direito'}">${dirNaoEnchido ? '✕' : '•'}</span>
            <span class="ba-detalhes-label">B${numeroFmt}</span>
            <span class="ba-detalhes-dot${esqNaoEnchido ? ' ba-detalhes-dot-x' : esqMarcado ? ' ba-detalhes-dot-vazou' : ''}" title="${esqNaoEnchido ? 'Esquerdo — Não enchido' : esqMarcado ? 'Esquerdo — Baixou/Vazou' : 'Esquerdo'}">${esqNaoEnchido ? '✕' : '•'}</span>
          </div>
        </div>

        <div class="ba-detalhes-campos">
          <div class="ba-detalhes-campo">
            <label class="form-label">Tipo de Montagem</label>
            <div class="ba-det-valor">${LW.escaparHtml(labelTipoAtual)}</div>
          </div>
          <div class="ba-detalhes-campo">
            <label class="form-label">Tipo de Bateria</label>
            <div class="ba-det-valor">${LW.escaparHtml(op.id_bateria || '—')}</div>
          </div>
          <div class="ba-detalhes-campo">
            <label class="form-label">Dimensão</label>
            <div class="ba-det-valor">${LW.escaparHtml(dimensaoBerco)}</div>
          </div>
          <div class="ba-detalhes-campo">
            <label class="form-label">Data de Enchimento</label>
            <div class="ba-det-valor">${LW.escaparHtml(dataEnchimento)}</div>
          </div>
          <div class="ba-detalhes-campo">
            <label class="form-label">Traço Usado</label>
            <div class="ba-det-valor">${labelTraco}</div>
          </div>
          ${receitaHtml ? `
          <div class="ba-detalhes-campo">
            <label class="form-label">Receita do Traço</label>
            <div class="af-receita-grid">${receitaHtml}</div>
          </div>` : ''}
          <div class="ba-detalhes-campo">
            <label class="form-label">Posição no Palete</label>
            <div class="ba-detalhes-paletes">
              <div class="ba-detalhes-palete-lado">
                <span class="ba-detalhes-palete-lado-label">Direito</span>
                ${_afDesenhoPaleteMini(posicaoDireito)}
              </div>
              <div class="ba-detalhes-palete-lado">
                <span class="ba-detalhes-palete-lado-label">Esquerdo</span>
                ${_afDesenhoPaleteMini(posicaoEsquerdo)}
              </div>
            </div>
          </div>
          ${avaliacaoOp ? `
          <div class="ba-detalhes-campo">
            <label class="form-label">Avaliação de Qualidade</label>
            <div class="ba-detalhes-paletes">
              <div class="ba-detalhes-palete-lado">
                <span class="ba-detalhes-palete-lado-label">Direito</span>
                <div class="af-slab" style="border-left-color:${_corPainel(painelDireito)}">
                  <span class="af-slab-resultado" style="color:${_corPainel(painelDireito)}">${LW.escaparHtml(_labelPainel(painelDireito))}</span>
                </div>
              </div>
              <div class="ba-detalhes-palete-lado">
                <span class="ba-detalhes-palete-lado-label">Esquerdo</span>
                <div class="af-slab" style="border-left-color:${_corPainel(painelEsquerdo)}">
                  <span class="af-slab-resultado" style="color:${_corPainel(painelEsquerdo)}">${LW.escaparHtml(_labelPainel(painelEsquerdo))}</span>
                </div>
              </div>
            </div>
          </div>` : ''}
        </div>

        <div class="ba-detalhes-acoes">
          <button type="button" class="btn btn-ghost" id="af-det-fechar-btn">Fechar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const fechar = () => overlay.remove();
    document.getElementById('af-det-fechar').addEventListener('click', fechar);
    document.getElementById('af-det-fechar-btn').addEventListener('click', fechar);
    // Clicar fora da caixa também fecha — nada é obrigatório de
    // preencher aqui (é tudo só leitura), então sair é sempre válido.
    overlay.addEventListener('click', (e) => { if (e.target === overlay) fechar(); });
  }

  // ── Desenho da bateria (berços visuais) ──────────────────────
  // Mesma grade visual usada no popover de hover do Relatório de Berços
  // e no card "Bateria Atual" (.ba-grid/.ba-celula/.ba-dot, ver
  // css/styles.css). Na tela ao vivo (LWFocada existe), cada célula abre
  // "📋 Detalhes do Berço" em modo SÓ LEITURA (ver abrirDetalhesBerco,
  // acima); no HTML exportado standalone (ver _gerarHtmlAfStandalone,
  // mais abaixo — LWFocada não existe lá) continua só visual, sem clique.
  // @param {HTMLElement} [elOverride] - ver comentário de _renderCabecalho.
  function _renderBercos(bercosVisuais, op, elOverride) {
    const el = elOverride || document.getElementById('af-bercos');
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

    const podeAbrirDetalhes = typeof LWFocada !== 'undefined';

    // Dica de clique — só faz sentido mostrar quando o clique realmente
    // funciona (podeAbrirDetalhes true tanto na tela ao vivo quanto no
    // HTML exportado standalone, ver window.LWFocada em
    // _gerarHtmlAfStandalone, mais abaixo).
    const dicaClique = podeAbrirDetalhes
      ? `<div style="text-align:center;font-size:.78rem;color:var(--text-3);margin-bottom:10px">💡 Clique em um berço para ver os detalhes.</div>`
      : '';

    el.innerHTML = `${dicaClique}<div class="ba-grid">${ordenados.map(b => {
      // "✕" (não enchido) é um estado À PARTE de "baixou" (vazamento) —
      // mesma distinção de bateria-atual.js: o painel nunca existiu pra
      // avaliar, diferente de um vazamento observado. Sem checar os dois
      // estados, um lado marcado como não enchido aparecia como se
      // estivesse tudo normal (bug relatado).
      const dirNaoEnchido = b.estado_direita === 'nao_enchido';
      const esqNaoEnchido = b.estado_esquerda === 'nao_enchido';
      const dirMarcado = b.estado_direita === 'baixou' || dirNaoEnchido;
      const esqMarcado = b.estado_esquerda === 'baixou' || esqNaoEnchido;
      const numero = String(b.ordem).padStart(2, '0');
      const tipoBerco = ehPersonalizada ? (gradePersonalizada[b.ordem - 1] || null) : (op ? op.tipo_montagem : null);
      const cor = _corPorTipoBerco(ehPersonalizada, tipoBerco);
      const estiloClique = podeAbrirDetalhes ? 'cursor:pointer;' : '';
      const clique = podeAbrirDetalhes ? ` onclick="LWFocada.abrirDetalhesBerco(${b.ordem})"` : '';
      return `
        <div class="ba-celula" style="${estiloClique}background:${cor ? cor.bg : 'var(--bg-2)'};color:${cor ? cor.cor : 'var(--text-2)'};border:1px solid ${cor ? cor.borda : 'var(--border)'}"${clique} title="${podeAbrirDetalhes ? 'Clique para ver detalhes do berço' : ''}">
          <span class="ba-dot ba-dot-topo${dirMarcado ? ' ba-dot-marcado' : ''}${dirNaoEnchido ? ' ba-dot-nao-enchido' : ''}" title="${dirNaoEnchido ? 'Direito — Não enchido' : 'Direito'}">${dirNaoEnchido ? '✕' : '•'}</span>
          <span class="ba-numero">B${numero}</span>
          <span class="ba-dot ba-dot-base${esqMarcado ? ' ba-dot-marcado' : ''}${esqNaoEnchido ? ' ba-dot-nao-enchido' : ''}" title="${esqNaoEnchido ? 'Esquerdo — Não enchido' : 'Esquerdo'}">${esqNaoEnchido ? '✕' : '•'}</span>
        </div>`;
    }).join('')}</div>`;
  }

  // ── Cadeia de reaproveitamento de cada traço ──────────────────
  // Mesma técnica de detecção de debriefing.js (usoIdx > 0 = reaproveitado
  // — ver _reaproveitado/origem_bateria/origem_operacao lá), só que olhando
  // pras DUAS direções: de onde este traço veio (se não foi a 1ª vez que
  // foi usado) E pra onde ele foi depois (se a sobra dele foi reaproveitada
  // em uma ou mais operações futuras). t.ultilizado.operacao é a lista
  // completa de usos de um traço, na ordem em que aconteceram — ver
  // rowParaTraco()/todosOsTracos() (db.js).
  //
  // Anota cada traço de `tracosDetalhe` (o array vindo de
  // db.detalheOperacao(), já escopado a ESTA operação) com `_origem` e
  // `_reaproveitadoDepois`, resolvidos a partir de _cacheTracos/
  // _cacheHistorico (ver _carregarCaches) — sem alterar nenhum campo que
  // já existia.
  function _anotarOrigemEReaproveitamento(tracosDetalhe, idOperacaoAtual) {
    const mapaOperacoes = new Map(_cacheHistorico.map(op => [op.id, op]));

    tracosDetalhe.forEach(t => {
      t._origem = null;
      t._reaproveitadoDepois = [];

      const tracoCompleto = _cacheTracos.find(tc => tc.id_traco === t.id_traco);
      const usos = tracoCompleto?.ultilizado?.operacao || [];
      if (usos.length < 2) return; // nunca reaproveitado — nada a anotar

      const idxAtual = usos.findIndex(u => u.id_operacao === idOperacaoAtual);
      if (idxAtual === -1) return; // não deveria acontecer, mas não quebra a tela se acontecer

      if (idxAtual > 0) {
        t._origem = mapaOperacoes.get(usos[0].id_operacao) || null;
      }
      if (idxAtual < usos.length - 1) {
        t._reaproveitadoDepois = usos.slice(idxAtual + 1)
          .map(u => mapaOperacoes.get(u.id_operacao))
          .filter(Boolean);
      }
    });
  }

  // Um badge levando pra outra operação — clicável na tela ao vivo
  // (chama LWFocada.abrir, definida neste mesmo módulo); no HTML
  // exportado standalone (ver _gerarHtmlAfStandalone, mais abaixo), esta
  // mesma função é reembutida via toString() num documento que NÃO tem
  // LWFocada (é um retrato estático, sem navegação) — por isso checa a
  // existência antes de gerar o onclick, e cai pra um badge só de texto
  // nesse caso, em vez de deixar um botão morto no arquivo exportado.
  // IDs de operação são gerados pelo próprio sistema ('op_' + timestamp
  // — ver operacao.js), nunca texto digitado por usuário, então entram
  // direto no onclick sem precisar escapar (mesmo padrão já usado em
  // setor-qualidade.js/dashboard.js pra este mesmo tipo de ID).
  function _badgeOperacao(op) {
    const rotulo = `${LW.escaparHtml(op.id_bateria || op.id)} · ${_fmtData(op.data)}`;
    if (typeof LWFocada === 'undefined') {
      return `<span class="af-pallet-tipo" style="padding:2px 10px">${rotulo}</span>`;
    }
    return `<button class="btn btn-ghost btn-sm" style="padding:2px 10px;font-size:.78rem"
      onclick="LWFocada.abrir('${op.id}')">${rotulo}</button>`;
  }

  // ── Berços enchidos de UM traço — mesma técnica de correlacaoTracoBerco
  // (db.js): olha só os berços dentro do range [berco_inicio,
  // berco_finalizacao] daquele traço (Math.min/max cobre início > fim
  // digitado errado) e conta quantos NÃO têm nenhum lado marcado
  // "nao_enchido" — esse é o estado que representa "painel nunca existiu
  // pra avaliar" (distinto de "baixou"/vazamento, ver _renderBercos,
  // acima). Devolve null se não dá pra calcular (sem berços visuais
  // registrados ainda, ou range inválido/não numérico).
  function _bercosEnchidosDoTraco(bercosVisuais, bercoInicio, bercoFim) {
    if (!bercosVisuais || !bercosVisuais.length) return null;
    const ini = Math.min(parseInt(bercoInicio, 10), parseInt(bercoFim, 10));
    const fim = Math.max(parseInt(bercoInicio, 10), parseInt(bercoFim, 10));
    if (isNaN(ini) || isNaN(fim)) return null;
    const doTraco = bercosVisuais.filter(b => b.ordem >= ini && b.ordem <= fim);
    if (!doTraco.length) return null;
    const enchidos = doTraco.filter(b => b.estado_esquerda !== 'nao_enchido' && b.estado_direita !== 'nao_enchido').length;
    return { enchidos, total: doTraco.length };
  }

  // ── Resumo da operação — médias de Flow, Densidade e Berços Enchidos
  // por traço, calculadas em cima da MESMA lista de traços mostrada
  // logo abaixo (t.flow/t.densidade já vêm com a regra "última remedição
  // OU original", ver db.detalheOperacao). Cada média ignora traços sem
  // aquele dado (null/undefined/vazio/não numérico) em vez de tratar
  // como zero — senão um traço sem Flow registrado puxaria a média pra
  // baixo artificialmente.
  function _calcularResumoTracos(tracos, bercosVisuais) {
    const flows = [], densidades = [], bercosEnchidos = [];
    tracos.forEach(t => {
      const flow = Number(t.flow);
      if (t.flow !== null && t.flow !== undefined && t.flow !== '' && !isNaN(flow)) flows.push(flow);

      const densidade = Number(t.densidade);
      if (t.densidade !== null && t.densidade !== undefined && t.densidade !== '' && !isNaN(densidade)) densidades.push(densidade);

      const info = _bercosEnchidosDoTraco(bercosVisuais, t.berco_inicio, t.berco_finalizacao);
      if (info) bercosEnchidos.push(info.enchidos);
    });
    const media = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
    return {
      mediaFlow: media(flows),
      mediaDensidade: media(densidades),
      mediaBercosEnchidos: media(bercosEnchidos),
      qtdTracos: tracos.length,
    };
  }

  function _renderResumoTracos(tracos, bercosVisuais) {
    const r = _calcularResumoTracos(tracos, bercosVisuais);
    const fmt1 = v => v === null ? '—' : v.toFixed(1);
    return `
      <div class="af-cabecalho-grid" style="margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border)">
        <div class="af-campo"><div class="af-label">Média de Flow</div><div class="af-valor">${fmt1(r.mediaFlow)}</div></div>
        <div class="af-campo"><div class="af-label">Média de Densidade</div><div class="af-valor">${r.mediaDensidade === null ? '—' : fmt1(r.mediaDensidade) + ' kg/m³'}</div></div>
        <div class="af-campo"><div class="af-label">Média de Berços Enchidos por Traço</div><div class="af-valor">${fmt1(r.mediaBercosEnchidos)}</div></div>
      </div>`;
  }

  // Formata um valor de leitura de Densidade/Flow pro texto exibido dentro
  // da linha de ajuste — sem casas decimais inúteis (densidade é sempre
  // inteiro na prática, flow tem 1 casa).
  function _fmtLeitura(v, casas) {
    return (v === null || v === undefined || v === '' || isNaN(Number(v))) ? '—' : Number(v).toFixed(casas);
  }

  // ── Receita utilizada (traços + ajustes) ─────────────────────
  // @param {HTMLElement} [elOverride] - ver comentário de _renderCabecalho.
  function _renderReceita(tracos, bercosVisuais, elOverride) {
    const el = elOverride || document.getElementById('af-receita');
    if (!el) return;
    if (!tracos || !tracos.length) {
      el.innerHTML = `<div class="sq-empty-af"><i class="fas fa-inbox"></i> Nenhum traço vinculado a esta operação.</div>`;
      return;
    }
    const resumoHtml = _renderResumoTracos(tracos, bercosVisuais);
    el.innerHTML = resumoHtml + tracos.map(t => {
      const densidadeLeituras = t.densidade_leituras || [];
      const flowLeituras = t.flow_leituras || [];
      // Nº de linhas da seção de ajustes = o maior entre ajustes de insumo
      // (ajustes_tracos.json, com evento/timestamp) e leituras de
      // densidade/flow (leituras_resultado, soltas — SEM evento/timestamp
      // associado). O alinhamento entre a linha N e a N-ésima leitura de
      // densidade/flow é posicional (por ordem), não uma correlação real
      // de "isso aconteceu junto com aquilo" — mesma ressalva de
      // _construirTabelaAjustesPorEvento, dashboard.js.
      const numLinhas = Math.max(t.ajustes.length, densidadeLeituras.length, flowLeituras.length);
      const semAjuste = numLinhas === 0;
      const camposReceita = [
        ['Cimento', _fmtKg(t.original.cimento), 'kg'],
        ['Água', _fmtKg(t.original.agua), 'kg'],
        ['EPS', _fmtKg(t.original.eps), 'kg'],
        ['Densidade EPS', t.densidade_eps || null, 'kg/m³'],
        ['Silo EPS', t.silo || null, ''],
        ['Expansão', t.expansao || null, ''],
        ['Superplast.', _fmtKg(t.original.superplast), 'kg'],
        ['Incorp. de Ar', _fmtKg(t.original.incorporador), 'kg'],
        ['Tempo de Batida', _fmtTempoBatidaOriginal(t.original.tempo_batida), ''],
        ['Densidade', t.densidade ?? null, 'kg/m³'],
        ['Flow', t.flow ?? null, ''],
      ];
      const infoBercos = _bercosEnchidosDoTraco(bercosVisuais, t.berco_inicio, t.berco_finalizacao);
      camposReceita.push(['Berços Enchidos', infoBercos ? `${infoBercos.enchidos}/${infoBercos.total}` : null, '']);
      const receitaHtml = camposReceita.map(([label, valor, unidade]) =>
        `<div>${label}: <strong>${valor === null || valor === undefined ? '—' : valor + (unidade ? ' ' + unidade : '')}</strong></div>`
      ).join('');

      const ajustesHtml = semAjuste
        ? `<div class="af-sem-ajuste">Receita sem ajuste.</div>`
        : `<div class="af-ajustes-wrap">
             <div class="af-ajustes-titulo">${numLinhas} ajuste${numLinhas > 1 ? 's' : ''} de receita</div>
             ${Array.from({ length: numLinhas }, (_, i) => {
               const a = t.ajustes[i];
               const dens = densidadeLeituras[i];
               const flow = flowLeituras[i];
               return `
                 <div class="af-ajuste-linha">
                   <strong>Ajuste ${a ? a.ordem : i + 1}</strong>
                   ${a ? `<span>⏱ +${a.tempo_batida}min</span>` : ''}
                   ${a?.cimento ? `<span>Cimento +${_fmtKg(a.cimento)}kg</span>` : ''}
                   ${a?.agua ? `<span>Água +${_fmtKg(a.agua)}kg</span>` : ''}
                   ${a?.eps ? `<span>EPS +${_fmtKg(a.eps)}kg</span>` : ''}
                   ${a?.superplast ? `<span>Superplast. +${_fmtKg(a.superplast)}kg</span>` : ''}
                   ${a?.incorporador ? `<span>Incorp. +${_fmtKg(a.incorporador)}kg</span>` : ''}
                   ${dens !== undefined ? `<span>Densidade ${_fmtLeitura(dens, 0)} kg/m³</span>` : ''}
                   ${flow !== undefined ? `<span>Flow ${_fmtLeitura(flow, 1)}</span>` : ''}
                 </div>`;
             }).join('')}
           </div>`;

      const origemHtml = t._origem
        ? `<div class="af-traco-origem-linha">🔗 Origem: ${_badgeOperacao(t._origem)}</div>`
        : '';
      const reaproveitadoHtml = (t._reaproveitadoDepois && t._reaproveitadoDepois.length)
        ? `<div class="af-traco-origem-linha">➡️ Reaproveitado depois em: ${t._reaproveitadoDepois.map(_badgeOperacao).join(' ')}</div>`
        : '';

      return `
        <div class="af-traco-card">
          <div class="af-traco-header">
            <strong>Traço ${LW.escaparHtml(String(t.num_traco ?? t.id_traco))}</strong>
            <span class="af-traco-bercos">Berços B${t.berco_inicio}–B${t.berco_finalizacao}</span>
          </div>
          <div class="af-receita-grid">${receitaHtml}</div>
          ${t.obs ? `<div class="af-traco-obs">📝 ${LW.escaparHtml(t.obs)}</div>` : ''}
          ${ajustesHtml}
          ${origemHtml}
          ${reaproveitadoHtml}
        </div>`;
    }).join('');
  }

  // ── Paradas que caíram dentro da janela [início,fim] da operação ──
  // Mesma técnica de sobreposição de _minutosParadaNaoPlanejadaNaJanela
  // (oee.js), mas devolvendo a LISTA inteira de paradas sobrepostas (não
  // só o total de minutos) e sem filtrar por classificação — aqui é pra
  // mostrar contexto ("o que aconteceu durante esta operação"), não pra
  // descontar tempo de Disponibilidade.
  function _paradasNaJanela(paradas, inicioISO, fimISO) {
    if (!inicioISO || !fimISO || !paradas || !paradas.length) return [];
    const ini = new Date(inicioISO).getTime();
    const fim = new Date(fimISO).getTime();
    if (isNaN(ini) || isNaN(fim) || fim <= ini) return [];

    return paradas.filter(p => {
      if (!p.inicio || !p.fim) return false;
      const pIni = new Date(p.inicio).getTime();
      const pFim = new Date(p.fim).getTime();
      if (isNaN(pIni) || isNaN(pFim)) return false;
      return pFim > ini && pIni < fim; // qualquer sobreposição, mesmo parcial
    }).sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
  }

  // @param {HTMLElement} [elOverride] - ver comentário de _renderCabecalho.
  // @param {HTMLElement} [elContagemOverride] - mesma ideia, pro contador ao lado do título.
  function _renderParadas(paradas, elOverride, elContagemOverride) {
    const el = elOverride || document.getElementById('af-paradas');
    if (!el) return;
    // Contador ao lado do título — visível mesmo com o <details> fechado,
    // pra dar uma pista do que tem lá dentro sem precisar expandir.
    const contagem = elContagemOverride || document.getElementById('af-paradas-contagem');
    if (contagem) contagem.textContent = paradas.length ? `(${paradas.length})` : '(nenhuma)';
    if (!paradas.length) {
      el.innerHTML = `<div class="sq-empty-af"><i class="fas fa-inbox"></i> Nenhuma parada registrada durante esta operação.</div>`;
      return;
    }
    el.innerHTML = paradas.map(p => {
      const planejada = p.classificacao === 'Planejada';
      const duracaoMin = p.duracao_min != null
        ? p.duracao_min
        : (p.inicio && p.fim ? (new Date(p.fim) - new Date(p.inicio)) / 60000 : null);
      return `
        <div class="af-traco-card" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          <span class="badge ${planejada ? 'badge-blue' : 'badge-red'}">${planejada ? 'Planejada' : 'Não Planejada'}</span>
          <strong>${LW.escaparHtml(p.equipamento || p.motivo || '—')}</strong>
          <span style="color:var(--text-3)">${duracaoMin != null ? Math.round(duracaoMin) + ' min' : '—'}</span>
          ${p.obs ? `<span style="color:var(--text-2);font-size:.82rem">📝 ${LW.escaparHtml(p.obs)}</span>` : ''}
        </div>`;
    }).join('');
  }

  // ── Avaliação de qualidade (painéis em texto, não em marca) ──────
  // Lista de motivos de defeito — mesma lista fixa de MOTIVOS_DEFEITO em
  // setor-qualidade.js (terminologia de qualidade da fábrica, não
  // configurável). Duplicada aqui porque cada página carrega seu próprio
  // script, sem módulo compartilhado — só o necessário pro tooltip do
  // código (nome completo do motivo), a exibição em si usa o código puro
  // já salvo em p.motivo.
  const _MOTIVO_POR_CODIGO = {
    BC: 'Borra de Cimento',
    CD: 'Cimentícia Descamando',
    CC: 'Cimentícia Não Colada',
    CF: 'Cimentícia Fora de Posição',
    EM: 'Espessura Maior',
    EP: 'Engoliu Placa',
    FD: 'Falha Desmoldante',
    FE: 'Falha Enchimento',
    FT: 'Falha Traço',
    PA: 'Painel Amassado',
    QE: 'Quebra por Empilhadeira',
    PQ: 'Painel Quebrado',
    PT: 'Perfil Torto',
    TR: 'Trincada',
    OT: 'Outros',
  };
  // Sufixo " — CÓDIGO" pra rótulo de painel com motivo de defeito
  // registrado (2ª linha ou reprovado — únicos resultados que exigem
  // motivo, ver _corExigeMotivo em setor-qualidade.js). Sem motivo salvo
  // (avaliação antiga, anterior à feature de motivos), fica em branco —
  // não força nada.
  function _sufixoMotivo(p) {
    if (!p || !p.motivo) return '';
    return ` — ${LW.escaparHtml(p.motivo)}`;
  }
  function _tituloMotivo(p) {
    if (!p || !p.motivo) return '';
    if (p.motivo === 'OT') return p.motivoDescricao ? LW.escaparHtml(p.motivoDescricao) : 'Outros (sem descrição)';
    return LW.escaparHtml(_MOTIVO_POR_CODIGO[p.motivo] || p.motivo);
  }
  function _labelPainel(p) {
    if (!p) return '— Sem marcação';
    if (p.resultado === 'aprovado') return (p.linha === '2ª' ? 'Aprovado / 2ª linha' : 'Aprovado / 1ª linha') + _sufixoMotivo(p);
    if (p.resultado === 'reprovado') return 'Reprovado' + _sufixoMotivo(p);
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

  // Quantas placas o PALETE `pallet` teve de verdade nesta avaliação —
  // olha os painéis salvos de verdade em vez de dividir o total igual
  // pra todo mundo (ver conversa que motivou: "o espelho e a análise
  // focada não estão refletindo paletes com painéis a menos" — antes,
  // totalPorPallet = totalSlabs/4 assumia os 4 paletes sempre do mesmo
  // tamanho, mas um berço "não enchido" ou um lado só parcialmente cheio
  // tira painel de UM palete só, não dos 4 igualmente — ver
  // _removerPaineisNaoEnchidosDaGrade, setor-qualidade.js).
  function _totalPorPallet(paineis, pallet) {
    const posicoes = paineis.filter(p => p.pallet === pallet).map(p => p.posicao);
    return posicoes.length ? Math.max(...posicoes) : 0;
  }

  // @param {HTMLElement} [elOverride] - ver comentário de _renderCabecalho.
  function _renderAvaliacao(avaliacao, elOverride) {
    const el = elOverride || document.getElementById('af-avaliacao');
    if (!el) return;
    if (!avaliacao) {
      el.innerHTML = `<div class="sq-empty-af"><i class="fas fa-inbox"></i> Bateria sem avaliação.</div>`;
      return;
    }
    const montagem = avaliacao.montagem || {};
    const paineis = avaliacao.paineis || [];

    let html = '<div class="af-paineis-grid">';
    // Ordem crescente (Pallet 1, 2, 3, 4) — ao contrário do Setor de
    // Qualidade (setor-qualidade.js), que usa a ordem espelhada [2,1,3,4]
    // de propósito pra bater com o layout FÍSICO da máquina naquela tela
    // (ver comentário em setor-qualidade.js e
    // test/setor-qualidade-layout-2x2-paletes.test.js). Aqui, na Análise
    // Focada, essa mesma ordem tinha sido copiada sem necessidade e só
    // dava a impressão de pallets trocados (ver conversa que motivou:
    // "os paletes estão trocados... quero ordem crescente começando do
    // 01"). Os DADOS de cada pallet continuam vindo do mesmo número de
    // sempre (avaliacao.paineis, montagem['palletN']) — só a ordem de
    // exibição mudou.
    [1, 2, 3, 4].forEach(p => {
      // Tipo de montagem daquele pallet — "no cantinho", cabeçalho do
      // próprio card do pallet, não em cada painel individual.
      const tipoMontPallet = montagem['pallet' + p] || '—';
      const totalPorPallet = _totalPorPallet(paineis, p); // cada palete com a contagem DELE, não uma média/fixo compartilhado
      const sidFoco = `stack${p}`;
      // Fotos do defeito deste pallet, já salvas junto da avaliação no
      // Setor de Qualidade (ver evalObj.palletFotos, setor-qualidade.js)
      // — botão SEMPRE visível no cabeçalho do card, mesmo sem foto
      // nenhuma (mesmo padrão do Espelho, ver renderMirror em
      // setor-qualidade.js), só pra abrir o visualizador somente-leitura
      // (_abrirFotosPalletFocada, abaixo). Não oferece tirar/apagar foto
      // aqui — a Análise Focada é sempre consulta de um registro já
      // fechado, nunca edição.
      const fotosFoco = avaliacao.palletFotos?.[sidFoco] || [];
      // Ícone/contador entram via CSS (::before/::after, ver
      // .af-pallet-foto em styles.css), NUNCA como texto de verdade
      // dentro do <button> — mesmo cuidado tomado no Espelho (ver
      // _renderIconeFotoPallet/renderMirror, setor-qualidade.js), pra
      // não arriscar contaminar algum parse futuro de textContent do
      // cabeçalho.
      const cliqueFoto = typeof LWFocada !== 'undefined' ? ` onclick="LWFocada.abrirFotosPallet('${sidFoco}')"` : '';
      const btnFotoFoco = `<button type="button" class="af-pallet-foto${fotosFoco.length ? ' tem-foto' : ''}" data-contagem="${fotosFoco.length || ''}"${cliqueFoto} title="${fotosFoco.length ? `${fotosFoco.length} foto${fotosFoco.length > 1 ? 's' : ''} do defeito neste pallet` : 'Nenhuma foto do defeito neste pallet'}"></button>`;
      html += `<div class="af-pallet"><div class="af-pallet-header"><span>Pallet ${p}</span><span class="af-pallet-header-direita"><span class="af-pallet-tipo">${LW.escaparHtml(tipoMontPallet)}</span>${btnFotoFoco}</span></div><div class="af-pallet-slabs">`;
      for (let i = 1; i <= totalPorPallet; i++) {
        const painel = paineis.find(pp => pp.pallet === p && pp.posicao === i);
        const cor = _corPainel(painel);
        const tituloMotivo = _tituloMotivo(painel);
        html += `<div class="af-slab" style="border-left-color:${cor}">
          <span class="af-slab-num">${i}</span>
          <span class="af-slab-resultado" style="color:${cor}"${tituloMotivo ? ` title="${tituloMotivo}"` : ''}>${_labelPainel(painel)}</span>
        </div>`;
      }
      html += '</div></div>';
    });
    html += '</div>';
    el.innerHTML = html;
  }

  // Visualizador de fotos SOMENTE LEITURA do pallet, na Análise Focada —
  // MESMO espírito do visualizador do Espelho (ver _abrirFotosMirror,
  // setor-qualidade.js), mas lendo a avaliação do detalhe da OPERAÇÃO
  // atual (_ultimoDetalhe.avaliacao, preenchido por render()/pelo bloco
  // standalone do export — ver comentário de _ultimoDetalhe ali) em vez
  // do array de avaliações do dashboard. Nunca oferece Câmera/Galeria/
  // remover — a Análise Focada não tem fluxo de edição de avaliação,
  // só consulta.
  function _abrirFotosPalletFocada(sid) {
    document.querySelector('.af-foto-modal-overlay')?.remove(); // fecha um anterior, se sobrou aberto

    const fotos = _ultimoDetalhe?.avaliacao?.palletFotos?.[sid] || [];

    const overlay = document.createElement('div');
    overlay.className = 'af-foto-modal-overlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'af-foto-modal';
    overlay.appendChild(modal);

    const titulo = document.createElement('div');
    titulo.className = 'af-foto-modal-titulo';
    titulo.innerHTML = `<span>📷 Fotos do defeito — ${sid.replace('stack', 'Pallet ')}</span>`;
    const fechar = document.createElement('span');
    fechar.textContent = '✕';
    fechar.style.cursor = 'pointer';
    fechar.addEventListener('click', () => overlay.remove());
    titulo.appendChild(fechar);
    modal.appendChild(titulo);

    if (!fotos.length) {
      const vazio = document.createElement('div');
      vazio.className = 'af-foto-modal-vazio';
      vazio.textContent = 'Nenhuma foto ainda.';
      modal.appendChild(vazio);
    } else {
      // Visor em carrossel — clicar numa miniatura abre ESSA foto em tela
      // cheia, já com setas pra andar entre TODAS as fotos deste mesmo
      // pallet. Navegação é circular: da última foto, "próxima" volta pra
      // primeira, e de "anterior" na primeira volta pra última — nunca
      // trava numa ponta (pedido: "ao chegar na última volta para a
      // primeira"). Tudo dentro desta mesma função de propósito — ela é
      // reembutida via toString() no export interativo (ver
      // _gerarHtmlAfStandalone, mais abaixo), então uma função auxiliar
      // separada não viajaria junto pro arquivo exportado.
      const abrirVisor = (indiceInicial) => {
        document.querySelector('.af-foto-viewer-overlay')?.remove(); // fecha um anterior, se sobrou aberto

        let indice = indiceInicial;

        const visor = document.createElement('div');
        visor.className = 'af-foto-viewer-overlay';

        const fecharVisor = () => {
          document.removeEventListener('keydown', aoTeclar);
          visor.remove();
        };

        const img = document.createElement('img');
        visor.appendChild(img);

        const contador = document.createElement('div');
        contador.className = 'af-foto-viewer-contador';

        const atualizar = () => {
          img.src = fotos[indice];
          contador.textContent = `${indice + 1} / ${fotos.length}`;
        };

        // % dá resultado negativo pra índice negativo em JS (ex: -1 % 5 =
        // -1, não 4) — daí o "+ fotos.length" antes do módulo, garantindo
        // sempre voltar pro outro extremo em vez de "travar"/dar índice
        // inválido.
        const irPara = (delta) => { indice = (indice + delta + fotos.length) % fotos.length; atualizar(); };

        // Setas/contador só fazem sentido com mais de 1 foto — uma foto
        // sozinha não tem "próxima"/"anterior" pra ir. Ficam juntas numa
        // ÚNICA barra (.af-foto-viewer-controles, "pílula" abaixo da
        // foto — ver CSS) em vez de soltas nos cantos da tela: assim a
        // posição da barra nunca muda conforme o tamanho/proporção da
        // foto (o pedido original — fotos verticais/horizontais não
        // "empurram" as setas de lugar, elas ficam sempre no mesmo lugar,
        // fixas embaixo).
        if (fotos.length > 1) {
          const controles = document.createElement('div');
          controles.className = 'af-foto-viewer-controles';
          // Clique na pílula em si (o respiro entre os botões, por
          // exemplo) não deve fechar o visor — só o fundo escuro ao
          // redor conta como "clicar fora".
          controles.addEventListener('click', (e) => e.stopPropagation());

          const setaEsq = document.createElement('button');
          setaEsq.type = 'button';
          setaEsq.className = 'af-foto-viewer-seta';
          setaEsq.textContent = '‹';
          setaEsq.setAttribute('aria-label', 'Foto anterior');
          setaEsq.addEventListener('click', () => irPara(-1));

          const setaDir = document.createElement('button');
          setaDir.type = 'button';
          setaDir.className = 'af-foto-viewer-seta';
          setaDir.textContent = '›';
          setaDir.setAttribute('aria-label', 'Próxima foto');
          setaDir.addEventListener('click', () => irPara(1));

          controles.appendChild(setaEsq);
          controles.appendChild(contador);
          controles.appendChild(setaDir);
          visor.appendChild(controles);
        }

        // Setas do teclado navegam, Esc fecha — mesmo espírito de atalho
        // dos outros modais desta tela (ex: Esc fechando "Detalhes do
        // Berço"). Listener SEMPRE removido em fecharVisor (clique fora,
        // Esc, ou clique na própria imagem/fundo) — sem isso, ficaria
        // escutando pra sempre, mesmo depois do visor fechado.
        const aoTeclar = (e) => {
          if (e.key === 'Escape') fecharVisor();
          else if (fotos.length > 1 && e.key === 'ArrowLeft') irPara(-1);
          else if (fotos.length > 1 && e.key === 'ArrowRight') irPara(1);
        };
        document.addEventListener('keydown', aoTeclar);

        // Clique no fundo OU na própria imagem fecha (mesmo comportamento
        // de antes: "clicar em qualquer lugar fecha") — as setas, acima,
        // já dão stopPropagation, então um clique nelas nunca chega até
        // aqui.
        visor.addEventListener('click', fecharVisor);

        atualizar();
        document.body.appendChild(visor);
      };

      const grid = document.createElement('div');
      grid.className = 'af-foto-modal-grid';
      fotos.forEach((dataUri, i) => {
        const item = document.createElement('div');
        item.className = 'af-foto-modal-item';
        const img = document.createElement('img');
        img.src = dataUri;
        img.addEventListener('click', () => abrirVisor(i));
        item.appendChild(img);
        grid.appendChild(item);
      });
      modal.appendChild(grid);
    }

    document.body.appendChild(overlay);
  }

  // ── Render principal ─────────────────────────────────────────
  async function render() {
    const loading = document.getElementById('af-loading');
    const erro = document.getElementById('af-erro');
    const vazio = document.getElementById('af-vazio');
    const content = document.getElementById('af-content');

    if (!_idAtual) {
      if (loading) loading.style.display = 'none';
      if (content) content.style.display = 'none';
      if (erro) erro.style.display = 'none';
      if (vazio) vazio.style.display = '';
      return;
    }

    if (vazio) vazio.style.display = 'none';
    if (loading) loading.style.display = '';
    if (content) content.style.display = 'none';
    if (erro) erro.style.display = 'none';

    const [detalhe] = await Promise.all([
      LW.getDetalheOperacao(_idAtual),
      _carregarCaches(), // pra cadeia de reaproveitamento e paradas, abaixo
    ]);

    if (loading) loading.style.display = 'none';

    if (!detalhe) {
      if (erro) { erro.style.display = ''; erro.textContent = 'Não foi possível carregar os dados desta operação — ela pode ter sido excluída.'; }
      return;
    }

    if (content) content.style.display = '';
    _ultimoDetalhe = detalhe;
    _anotarOrigemEReaproveitamento(detalhe.tracos, _idAtual);
    const paradasDaJanela = _paradasNaJanela(_cacheParadas, detalhe.operacao?.inicio, detalhe.operacao?.fim);

    _renderCabecalho(detalhe.operacao);
    _renderBercos(detalhe.bercosVisuais, detalhe.operacao);
    _renderReceita(detalhe.tracos, detalhe.bercosVisuais);
    _renderParadas(paradasDaJanela);
    _renderAvaliacao(detalhe.avaliacao);
  }

  // ── Exportar Dashboard Interativo (HTML standalone) ───────────────────────
  // Diferente dos outros dashboards (sem período/filtro aqui — é sobre UMA
  // ou VÁRIAS operações específicas, nunca um período arbitrário): embute
  // o(s) detalhe(s) já carregado(s) (LW.getDetalheOperacao) e as mesmas
  // funções de render via toString(), virando um retrato autossuficiente
  // — "interativo" aqui significa só "abre em qualquer navegador, offline,
  // com a mesma formatação".
  //
  // Ponto de entrada público (botão "🌐 Exportar Interativo" e atalho de
  // teclado, ver keyboard-shortcuts.js) — pergunta ao usuário qual das 3
  // exportações ele quer e delega pra _exportarSimples/_exportarDoDia,
  // abaixo. Mantido com este mesmo nome pra não quebrar quem já chama
  // LWFocada.exportarInterativo() de fora.
  async function exportarInterativo() {
    await _perguntarTipoEExportar('html');
  }

  // Ponto de entrada público (botão "📕 Exportar PDF") — MESMO menu de
  // escolha (Simples/Do Dia/Personalizada) do Exportar Interativo, só que
  // termina em PDF em vez de HTML (ver _finalizarExportacao, abaixo: o
  // caminho é idêntico até gerar o HTML autossuficiente de sempre — a
  // única diferença é o que se faz com ele no fim: baixar direto, ou
  // mandar pro servidor converter em PDF via Chromium headless — ver
  // lib/rotas/exportar-pdf.js). Assim a Exportação em PDF nunca duplica
  // lógica nem "atrasa" em relação à Interativa: qualquer ajuste em como
  // os dados são montados (_gerarHtmlAfStandalone e afins) vale pros dois
  // formatos automaticamente.
  async function exportarPDF() {
    await _perguntarTipoEExportar('pdf');
  }

  // Menu de escolha (Simples/Do Dia/Personalizada) compartilhado pelos 2
  // pontos de entrada acima — `formato` é 'html' ou 'pdf' e só muda o
  // título do menu e é repassado adiante pras 3 funções de exportação
  // (_exportarSimples/_exportarDoDia/_exportarPersonalizado), que de fato
  // decidem, no final, se baixam o HTML puro ou mandam converter em PDF
  // (ver _finalizarExportacao).
  // @param {'html'|'pdf'} formato
  async function _perguntarTipoEExportar(formato) {
    const ehPdf = formato === 'pdf';
    // Antes saía de cara se não houvesse operação carregada (_idAtual),
    // deixando o botão parecendo morto mesmo pra quem só queria "Do Dia"
    // (que nem depende de operação selecionada — roda em cima de uma data
    // escolhida no calendário). Agora o botão sempre abre o menu de
    // escolha; só a opção "Simples" (que exporta A operação atual) exige
    // _idAtual, e avisa em vez de falhar em silêncio.
    const escolha = await LW.mostrarEscolha(
      'Como você quer exportar esta Análise Focada?',
      {
        titulo: ehPdf ? '📕 Exportar PDF' : '🌐 Exportar Interativo',
        icon: ehPdf ? '📕' : '🌐',
        itens: [
          { valor: 'simples', texto: '📄 Exportação Simples', desc: 'Só esta operação, do jeito que já era.' },
          { valor: 'dia', texto: '📅 Do Dia', desc: 'Escolha uma data — todas as operações feitas nela.' },
          { valor: 'personalizada', texto: '🗓️ Personalizada', desc: 'Escolha um período — todas as operações feitas nele, uma embaixo da outra.' },
        ],
        textoCancelar: 'Cancelar',
      }
    );
    if (!escolha) return;
    if (escolha === 'simples') {
      if (!_idAtual) {
        if (LW.mostrarAlerta) LW.mostrarAlerta('Selecione uma operação primeiro para usar a Exportação Simples.', { tipo: 'erro' });
        return;
      }
      await _exportarSimples(formato);
      return;
    }
    if (escolha === 'personalizada') {
      // Mesma data sugerida de "Do Dia" (a da operação aberta), usada
      // como ponto de partida pros DOIS campos (De/Até) — quem só quer 1
      // dia específico não precisa mexer em nada além de trocar o "Até".
      const dataSugerida = _ultimoDetalhe?.operacao?.data || '';
      const periodo = await _escolherRangeDatas(dataSugerida, formato);
      if (!periodo) return;
      await _exportarPersonalizado(periodo.inicio, periodo.fim, formato);
      return;
    }
    // "Do Dia" pede a data ANTES de exportar — sugere a data da operação
    // atualmente aberta (_ultimoDetalhe, preenchido por render()), mas o
    // usuário pode trocar livremente pelo calendário do <input type="date">.
    const dataSugerida = _ultimoDetalhe?.operacao?.data || '';
    const dataEscolhida = await _escolherDataDoDia(dataSugerida, formato);
    if (!dataEscolhida) return;
    await _exportarDoDia(dataEscolhida, formato);
  }

  // Último passo comum às 3 exportações — decide o que fazer com o HTML
  // autossuficiente já pronto: baixar direto (formato 'html', comportamento
  // de sempre) ou mandar pro servidor converter em PDF de verdade (formato
  // 'pdf' — ver lib/rotas/exportar-pdf.js e LW.baixarPdfApartirDeHtml,
  // data.js). `nomeBase` vem SEM extensão (cada chamador já monta o nome
  // sanitizado, sem ".html"/".pdf" — esta função completa a extensão certa).
  // `signal` (Fase 2/3 do plano de Exportação em PDF, ver README) é o
  // AbortSignal do botão Cancelar da barra de progresso — só importa pro
  // formato 'pdf' (é a única exportação que fala com o servidor); undefined
  // é seguro de passar adiante (equivale a "sem sinal"). A partir da Fase
  // 3, `onProgresso` (ver `_progressoServidor`, abaixo) recebe progresso
  // REAL do servidor via SSE — não é mais só um "enviando…" indeterminado.
  // @param {'html'|'pdf'} formato
  // @param {string} nomeBase - nome do arquivo, sem extensão.
  // @param {string} html - o documento autossuficiente já gerado.
  // @param {AbortSignal} [signal] - cancela a exportação em andamento.
  async function _finalizarExportacao(formato, nomeBase, html, signal) {
    if (formato === 'pdf') {
      await LW.baixarPdfApartirDeHtml(`${nomeBase}.pdf`, html, { signal, onProgresso: _progressoServidor });
      return;
    }
    LW.baixarArquivoTexto(`${nomeBase}.html`, html);
  }

  // Texto do botão em repouso, conforme o formato — usado pra restaurar o
  // botão certo (Interativo x PDF, cada um com seu id — ver
  // page-analise-focada.html) depois de qualquer exportação, sucesso ou erro.
  function _botaoDoFormato(formato) {
    return formato === 'pdf'
      ? { id: 'btn-af-exportar-pdf', textoRepouso: '📕 Exportar PDF' }
      : { id: 'btn-af-exportar', textoRepouso: '🌐 Exportar Interativo' };
  }

  // ── Barra de progresso + cancelar (Fase 2 do plano de Exportação em
  // PDF, ver README "Exportação em PDF (Análise Focada) — Contagem,
  // Progresso e Cancelamento") — controla o card #af-progresso inserido
  // entre os botões de exportação e a busca (ver
  // page-analise-focada.html). 3 fases visíveis, cada uma chamando a
  // função correspondente abaixo:
  //   1. Carregando dados de cada operação — progresso REAL (já é um
  //      Promise.all por operação, então dá pra contar quantas
  //      resolveram) — _progressoAtualizar(texto, feito, total).
  //   2. Montando o HTML — rápido/quase instantâneo, sem granularidade
  //      real pra medir — _progressoMontagem() só avança a barra.
  //   3. Enviando/aguardando o servidor (só formato 'pdf' — HTML não faz
  //      round-trip nenhum) — duração desconhecida do lado do cliente,
  //      então pulsa em vez de avançar — _progressoEnviando().
  // Cancelar aqui interrompe o ACOMPANHAMENTO do lado do cliente: aborta
  // o fetch em andamento (se já estiver na fase 3) via AbortController, e
  // faz as fases 1/2 pararem no próximo ponto de checagem
  // (_progressoCancelado) sem seguir pra próxima etapa nem mostrar erro.
  // O Chromium no servidor pode continuar rodando até terminar sozinho
  // mesmo depois do abort — só o resultado é descartado (ninguém baixa).
  let _progressoAbort = null;
  let _progressoCancelado = false;

  function _progressoEls() {
    return {
      card: document.getElementById('af-progresso'),
      texto: document.getElementById('af-progresso-texto'),
      barra: document.getElementById('af-progresso-barra'),
      cancelar: document.getElementById('af-progresso-cancelar'),
    };
  }

  // Chamado no início de CADA exportação (Simples/Do Dia/Personalizada,
  // HTML ou PDF) — zera a barra, mostra o card e liga o botão Cancelar.
  // @returns {AbortSignal} o signal desta exportação (repassado pro fetch
  //   do PDF em _finalizarExportacao — undefined não quebra o fetch, mas
  //   aqui sempre existe porque cada exportação cria seu próprio controller).
  function _progressoIniciar() {
    _progressoCancelado = false;
    _progressoAbort = new AbortController();
    const { card, texto, barra, cancelar } = _progressoEls();
    if (card) {
      card.style.display = '';
      barra.classList.remove('af-progresso-indeterminada');
      barra.style.width = '0%';
      texto.textContent = 'Preparando…';
      cancelar.disabled = false;
      cancelar.onclick = () => {
        _progressoCancelado = true;
        cancelar.disabled = true;
        texto.textContent = 'Cancelando…';
        if (_progressoAbort) _progressoAbort.abort();
      };
    }
    return _progressoAbort.signal;
  }

  // Fase 1 — progresso REAL: `feito`/`total` são contagens de operações
  // já carregadas, não porcentagem. Esta fase ocupa até 70% da barra
  // (o resto fica pras fases 2 e 3, que não têm como medir quanto falta).
  function _progressoAtualizar(textoBase, feito, total) {
    const { texto, barra } = _progressoEls();
    if (!texto || !barra) return;
    texto.textContent = total > 1 ? `${textoBase} (${feito} de ${total})` : textoBase;
    barra.style.width = `${total > 0 ? Math.round((feito / total) * 70) : 0}%`;
  }

  // Fase 2 — sem granularidade real (é síncrono e rápido), só sinaliza
  // visualmente que passou da fase 1.
  function _progressoMontagem() {
    const { texto, barra } = _progressoEls();
    if (!texto || !barra) return;
    texto.textContent = 'Montando o arquivo…';
    barra.style.width = '85%';
  }

  // Fase 3 — chamada uma vez, assim que o job é criado no servidor, antes
  // do primeiro evento de progresso chegar por SSE (`_progressoServidor`,
  // abaixo, assume a partir daí). Fica pulsando (indeterminada) só nesse
  // intervalo curtíssimo entre "mandei o HTML" e "o servidor confirmou que
  // começou a processar".
  function _progressoEnviando() {
    const { texto, barra } = _progressoEls();
    if (!texto || !barra) return;
    texto.textContent = 'Enviando para o servidor…';
    barra.classList.add('af-progresso-indeterminada');
  }

  // Fase 3 — progresso REAL vindo do SERVIDOR por Server-Sent Events (ver
  // lib/rotas/exportar-pdf.js, LW.baixarPdfApartirDeHtml em data.js).
  // Ocupa a faixa 85%-100% da barra (a faixa 0%-85% já foi usada pelas
  // fases 1/2, que rodam no CLIENTE antes de mandar o HTML pro servidor —
  // ver _progressoAtualizar/_progressoMontagem, acima). 3 sub-fases
  // possíveis, cada uma reportada pelo servidor com um `fase` diferente —
  // e cada uma some com a FATIA da barra que já usou antes de passar pra
  // próxima, então a barra sempre avança, nunca volta:
  //   'carregando'  — o Chromium terminou de montar o DOM do HTML
  //                   recebido (page.setContent) — feito/total sempre 0/1
  //                   ou 1/1, não tem granularidade real aqui. 85%-88%.
  //   'ajustando'   — só em "Do Dia"/Personalizada: o script de ajuste de
  //                   escala (_afScriptAjustePaginaUnica) está encolhendo
  //                   cada operação pra caber numa página — feito/total
  //                   AQUI é progresso real (quantas operações já foram
  //                   ajustadas de quantas no total). 88%-92%.
  //   'imprimindo'  — Chromium gerando o PDF de verdade (page.pdf()) — a
  //                   etapa que MAIS demora num export grande, e a única
  //                   sem NENHUM progresso real disponível (Puppeteer não
  //                   expõe callback nenhum aqui) — exceto na Análise
  //                   Focada (Simples/Do Dia/Personalizada), que GARANTE
  //                   via CSS que cada operação vira exatamente 1 página
  //                   (ver `_afCssImpressaoPdf`, acima), permitindo ao
  //                   servidor saber o total de páginas de antemão e
  //                   imprimir uma por uma — nesse caso `progressoReal`
  //                   vem `true` e `feito`/`total` são CONTAGEM real de
  //                   páginas já impressas (Fase 5, ver README). Nos
  //                   demais dashboards (sem esse mecanismo), o servidor
  //                   cai de volta pra ESTIMATIVA: `progressoReal` vem
  //                   `false`/ausente e `feito` é uma PORCENTAGEM (0-95,
  //                   nunca 100 — só o 'concluido' de verdade fecha em
  //                   100%) baseada no histórico (média móvel de
  //                   ms/operação nos últimos jobs — ver
  //                   `_iniciarTickerImpressao`, exportar-pdf.js), junto
  //                   com `segundosRestantes`. 92%-100% em ambos os
  //                   casos, só o texto/cálculo interno muda.
  function _progressoServidor(fase, feito, total, segundosRestantes, progressoReal) {
    const { texto, barra } = _progressoEls();
    if (!texto || !barra) return;
    if (fase === 'carregando') {
      barra.classList.remove('af-progresso-indeterminada');
      texto.textContent = 'Servidor carregando o conteúdo…';
      barra.style.width = `${total > 0 ? 85 + Math.round((feito / total) * 3) : 85}%`; // 85%-88%
      return;
    }
    if (fase === 'ajustando') {
      barra.classList.remove('af-progresso-indeterminada');
      texto.textContent = total > 0 ? `Ajustando o layout do PDF (${feito} de ${total})…` : 'Ajustando o layout do PDF…';
      barra.style.width = `${total > 0 ? 88 + Math.round((feito / total) * 4) : 88}%`; // 88%-92%
      return;
    }
    if (fase === 'imprimindo') {
      barra.classList.remove('af-progresso-indeterminada');
      const eta = (typeof segundosRestantes === 'number' && segundosRestantes > 0)
        ? ` (~${segundosRestantes}s restantes)`
        : '';
      if (progressoReal) {
        // Contagem REAL de páginas já impressas — `feito`/`total` são
        // números de página, não porcentagem (ver comentário acima e
        // `_processarJob` em exportar-pdf.js).
        const fracao = total > 0 ? feito / total : 0;
        barra.style.width = `${92 + Math.round(fracao * 8)}%`; // 92%-100%
        texto.textContent = total > 0
          ? `Imprimindo o PDF (${feito} de ${total} páginas)…${eta}`
          : `Imprimindo o PDF…${eta}`;
      } else {
        // Estimativa, não medição real — o texto deixa isso implícito
        // ("~Xs restantes", não "Xs restantes") pra não prometer uma
        // precisão que a barra não tem. `feito` aqui já vem em PORCENTAGEM
        // (0-95), não em contagem — ver comentário acima e
        // `_iniciarTickerImpressao` em exportar-pdf.js.
        const percentualImpressao = Math.max(0, Math.min(95, feito));
        barra.style.width = `${92 + Math.round((percentualImpressao / 95) * 8)}%`; // 92%-100%
        texto.textContent = `Imprimindo o PDF…${eta}`;
      }
      return;
    }
    if (fase === 'reconectando') {
      // EventSource caiu mas está tentando reconectar sozinho (ver
      // eventos.onerror em data.js) — o job continua rodando no servidor
      // normalmente, só a barra pisca avisando que a conexão está
      // instável, sem voltar nem travar em nenhuma porcentagem.
      barra.classList.add('af-progresso-indeterminada');
      texto.textContent = 'Conexão instável — tentando reconectar…';
      return;
    }
    // Fase futura desconhecida — sem granularidade, volta a pulsar (mesmo
    // fallback de segurança que existia desde a Fase 2).
    texto.textContent = 'Processando…';
    barra.classList.add('af-progresso-indeterminada');
  }

  // Fim — sucesso, erro OU cancelamento: sempre esconde o card, pra não
  // deixar uma barra travada em 40% se algo falhar no meio. Chamado no
  // `finally` de cada uma das 3 exportações.
  function _progressoFinalizar() {
    const { card, barra } = _progressoEls();
    if (barra) barra.classList.remove('af-progresso-indeterminada');
    if (card) card.style.display = 'none';
    _progressoAbort = null;
  }


  // ── Exportação Simples — comportamento original: só a operação atual. ──
  // @param {'html'|'pdf'} formato
  async function _exportarSimples(formato = 'html') {
    const { id: btnId, textoRepouso } = _botaoDoFormato(formato);
    const btn = document.getElementById(btnId);
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando…'; }
    const signal = _progressoIniciar();
    try {
      _progressoAtualizar('Carregando dados da operação…', 0, 1);
      const [detalhe] = await Promise.all([LW.getDetalheOperacao(_idAtual), _carregarCaches()]);
      _progressoAtualizar('Carregando dados da operação…', 1, 1);
      if (_progressoCancelado) return;
      if (!detalhe) { if (LW.mostrarAlerta) LW.mostrarAlerta('Não consegui carregar os dados desta operação.', { tipo: 'erro' }); return; }
      _anotarOrigemEReaproveitamento(detalhe.tracos, _idAtual);
      const paradasDaJanela = _paradasNaJanela(_cacheParadas, detalhe.operacao?.inicio, detalhe.operacao?.fim);
      // PDF: gerador ESTÁTICO (leve — ver _gerarHtmlAfEstaticoPdf, sem
      // <script>/JSON embutido, mais rápido pro Chromium do servidor
      // converter). HTML interativo: o standalone de sempre, com clique
      // nos berços e navegação entre operações.
      _progressoMontagem();
      const html = formato === 'pdf'
        ? _gerarHtmlAfEstaticoPdf(detalhe, paradasDaJanela)
        : _gerarHtmlAfStandalone(detalhe, paradasDaJanela);
      if (_progressoCancelado) return;
      if (formato === 'pdf') _progressoEnviando();
      await _finalizarExportacao(
        formato,
        `analise_focada_${LW.escaparHtml(String(detalhe.operacao?.id || _idAtual)).replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        html,
        signal
      );
    } catch (err) {
      if (err && err.name === 'AbortError') {
        // Cancelado pelo usuário — já visível pelo texto "Cancelando…" da
        // barra, sem precisar de mais um alerta de erro por cima.
      } else {
        console.error('Falha ao exportar Análise Focada:', err);
        if (LW.mostrarAlerta) LW.mostrarAlerta(err && err.message ? err.message : 'Não consegui gerar o arquivo agora.', { tipo: 'erro' });
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = textoRepouso; }
      _progressoFinalizar();
    }
  }

  // ── Contagem de análises ANTES de exportar (Fase 1 do plano — ver
  // README "Exportação em PDF (Análise Focada) — Contagem, Progresso e
  // Cancelamento"). Lê só o que já está em _cacheHistorico (nenhuma
  // chamada extra ao servidor) — por isso o chamador precisa garantir
  // que _carregarCaches() já rodou antes de usar estas funções.
  // "Simples" não passa por aqui: é sempre 1 análise (a operação atual),
  // texto fixo, sem cálculo.
  function _contarOperacoesDoDia(data) {
    if (!data || !_cacheHistorico) return 0;
    return _cacheHistorico.filter(op => op.data === data).length;
  }
  function _contarOperacoesDoPeriodo(dataInicio, dataFim) {
    if (!dataInicio || !dataFim || !_cacheHistorico) return 0;
    const [ini, fim] = dataInicio <= dataFim ? [dataInicio, dataFim] : [dataFim, dataInicio];
    return _cacheHistorico.filter(op => op.data >= ini && op.data <= fim).length;
  }
  // "Você vai exportar X análises" (singular "1 análise") — mesmo texto
  // pros 2 modais abaixo (Do Dia e Personalizada).
  function _textoContagemAnalises(n) {
    return n === 1 ? 'Você vai exportar 1 análise.' : `Você vai exportar ${n} análises.`;
  }

  // ── Aviso de "processo pode demorar" (Fase 4 do plano — mesmo
  // modal/fluxo da Fase 1, só populando um aviso a mais quando a
  // contagem passa de um limiar). 15 análises: número redondo dentro da
  // faixa "15-20" sugerida no README — folgado o bastante pra não
  // incomodar exportações do dia a dia (poucas operações), mas cedo o
  // bastante pra avisar ANTES de alguém escolher sem querer um período
  // de um mês inteiro e só descobrir que ia demorar depois de clicar em
  // Exportar. Puramente informativo — não bloqueia nem exige confirmação
  // extra, é só texto condicional em cima do número que a Fase 1 já
  // calcula (_contarOperacoesDoDia/_contarOperacoesDoPeriodo, acima).
  const _LIMIAR_AVISO_DEMORA_PDF = 15;
  function _textoAvisoDemora(n) {
    return n >= _LIMIAR_AVISO_DEMORA_PDF
      ? '⚠️ Processo pode demorar bastante com esse volume de análises.'
      : '';
  }

  // ── Modal de escolha de data pra Exportação "Do Dia" — um <input
  // type="date"> nativo (mesmo padrão de campo de data já usado no resto
  // do app — ver page-registro.html, page-oee.html etc.), que abre o
  // calendário do próprio navegador/SO. Pré-preenchido com `dataSugerida`
  // (a data da operação que estava aberta), mas 100% editável. Mostra,
  // logo abaixo do campo, quantas operações entram no arquivo pra data
  // selecionada — recalculado a cada troca de data (Fase 1 do plano de
  // Exportação em PDF, ver README) — e, se `formato` for 'pdf' e a
  // contagem passar do limiar, um aviso de que o processo pode demorar
  // (Fase 4). Formato 'html' nunca mostra o aviso: não faz round-trip com
  // o servidor, então não corre o risco do timeout do Chromium.
  // @param {string} dataSugerida - 'YYYY-MM-DD' ou '' se não houver uma óbvia.
  // @param {'html'|'pdf'} [formato='html']
  // @returns {Promise<string|null>} 'YYYY-MM-DD' escolhida, ou null se cancelado (Cancelar, Esc ou clique fora).
  async function _escolherDataDoDia(dataSugerida, formato = 'html') {
    await _carregarCaches();
    return new Promise(resolve => {
      const anterior = document.getElementById('modal-af-data-dia');
      if (anterior) anterior.remove();

      const modal = document.createElement('div');
      modal.id = 'modal-af-data-dia';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:10100;display:flex;align-items:center;justify-content:center;padding:20px';

      modal.innerHTML = `
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);
                    padding:32px;width:380px;max-width:92vw;box-shadow:0 24px 80px rgba(0,0,0,.6)">
          <div style="text-align:center;margin-bottom:16px">
            <div style="font-size:2.2rem;margin-bottom:8px">📅</div>
            <h2 style="font-family:var(--font-display);font-size:1.3rem;color:var(--text);margin:0">Exportar do Dia</h2>
          </div>
          <p style="color:var(--text-2);text-align:center;margin-bottom:16px;line-height:1.5">Escolha a data — todas as operações feitas nela entram no arquivo.</p>
          <input type="date" id="af-data-dia-input" class="form-input" value="${LW.escaparHtml(dataSugerida)}"
            style="width:100%;text-align:center;font-size:1rem;padding:10px">
          <p id="af-data-dia-contagem" style="color:var(--text-2);text-align:center;margin:10px 0 6px;font-size:.85rem">
            ${LW.escaparHtml(_textoContagemAnalises(_contarOperacoesDoDia(dataSugerida)))}
          </p>
          <p id="af-data-dia-aviso" style="color:#f59e0b;text-align:center;margin:0 0 24px;font-size:.8rem;display:${formato === 'pdf' && _textoAvisoDemora(_contarOperacoesDoDia(dataSugerida)) ? 'block' : 'none'}">
            ${LW.escaparHtml(_textoAvisoDemora(_contarOperacoesDoDia(dataSugerida)))}
          </p>
          <div style="display:flex;gap:12px">
            <button id="af-data-dia-confirmar"
              style="flex:1;padding:12px;background:var(--accent);color:#000;border:none;border-radius:var(--radius);
                     font-weight:700;font-size:.9rem;cursor:pointer">
              Exportar
            </button>
            <button id="af-data-dia-cancelar"
              style="flex:1;padding:12px;background:var(--bg-2);color:var(--text);border:1px solid var(--border);
                     border-radius:var(--radius);font-size:.9rem;cursor:pointer">
              Cancelar
            </button>
          </div>
        </div>`;

      document.body.appendChild(modal);
      const input = document.getElementById('af-data-dia-input');
      const contagemEl = document.getElementById('af-data-dia-contagem');
      const avisoEl = document.getElementById('af-data-dia-aviso');

      const fechar = (resultado) => {
        modal.remove();
        document.removeEventListener('keydown', onKeydown);
        resolve(resultado);
      };
      const onKeydown = (e) => {
        if (e.key === 'Escape') fechar(null);
        if (e.key === 'Enter') fechar(input.value || null);
      };
      const atualizarContagem = () => {
        const n = _contarOperacoesDoDia(input.value);
        contagemEl.textContent = _textoContagemAnalises(n);
        const aviso = formato === 'pdf' ? _textoAvisoDemora(n) : '';
        avisoEl.textContent = aviso;
        avisoEl.style.display = aviso ? 'block' : 'none';
      };

      document.getElementById('af-data-dia-confirmar').addEventListener('click', () => fechar(input.value || null));
      document.getElementById('af-data-dia-cancelar').addEventListener('click', () => fechar(null));
      modal.addEventListener('click', (e) => { if (e.target === modal) fechar(null); });
      document.addEventListener('keydown', onKeydown);
      input.addEventListener('input', atualizarContagem);
      input.addEventListener('change', atualizarContagem);
      input.focus();
    });
  }

  // ── Modal de escolha de PERÍODO (De/Até) pra Exportação "Personalizada"
  // — mesmo padrão visual de _escolherDataDoDia (acima), só com 2 <input
  // type="date"> lado a lado em vez de 1. Os dois vêm pré-preenchidos com
  // `dataSugerida` (a data da operação que estava aberta) — quem só quer
  // 1 dia específico só troca o "Até" (ou nem mexe, se já for hoje).
  // Mostra, logo abaixo dos campos, quantas operações entram no arquivo
  // pro período selecionado — recalculado a cada troca de De/Até (Fase 1
  // do plano de Exportação em PDF, ver README) — e, se `formato` for
  // 'pdf' e a contagem passar do limiar, um aviso de que o processo pode
  // demorar (Fase 4). Formato 'html' nunca mostra o aviso.
  // @param {string} dataSugerida - 'YYYY-MM-DD' ou '' se não houver uma óbvia.
  // @param {'html'|'pdf'} [formato='html']
  // @returns {Promise<{inicio:string,fim:string}|null>} - null se cancelado (Cancelar, Esc ou clique fora).
  async function _escolherRangeDatas(dataSugerida, formato = 'html') {
    await _carregarCaches();
    return new Promise(resolve => {
      const anterior = document.getElementById('modal-af-range-datas');
      if (anterior) anterior.remove();

      const modal = document.createElement('div');
      modal.id = 'modal-af-range-datas';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:10100;display:flex;align-items:center;justify-content:center;padding:20px';

      modal.innerHTML = `
        <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);
                    padding:32px;width:400px;max-width:92vw;box-shadow:0 24px 80px rgba(0,0,0,.6)">
          <div style="text-align:center;margin-bottom:16px">
            <div style="font-size:2.2rem;margin-bottom:8px">🗓️</div>
            <h2 style="font-family:var(--font-display);font-size:1.3rem;color:var(--text);margin:0">Exportar Personalizada</h2>
          </div>
          <p style="color:var(--text-2);text-align:center;margin-bottom:16px;line-height:1.5">Escolha o período — todas as operações feitas nele entram no arquivo, uma embaixo da outra.</p>
          <div style="display:flex;gap:10px;margin-bottom:24px">
            <div style="flex:1">
              <label class="form-label" style="display:block;margin-bottom:6px;text-align:center">De</label>
              <input type="date" id="af-range-inicio-input" class="form-input" value="${LW.escaparHtml(dataSugerida)}"
                style="width:100%;text-align:center;font-size:1rem;padding:10px">
            </div>
            <div style="flex:1">
              <label class="form-label" style="display:block;margin-bottom:6px;text-align:center">Até</label>
              <input type="date" id="af-range-fim-input" class="form-input" value="${LW.escaparHtml(dataSugerida)}"
                style="width:100%;text-align:center;font-size:1rem;padding:10px">
            </div>
          </div>
          <p id="af-range-contagem" style="color:var(--text-2);text-align:center;margin:-8px 0 6px;font-size:.85rem">
            ${LW.escaparHtml(_textoContagemAnalises(_contarOperacoesDoPeriodo(dataSugerida, dataSugerida)))}
          </p>
          <p id="af-range-aviso" style="color:#f59e0b;text-align:center;margin:0 0 24px;font-size:.8rem;display:${formato === 'pdf' && _textoAvisoDemora(_contarOperacoesDoPeriodo(dataSugerida, dataSugerida)) ? 'block' : 'none'}">
            ${LW.escaparHtml(_textoAvisoDemora(_contarOperacoesDoPeriodo(dataSugerida, dataSugerida)))}
          </p>
          <div style="display:flex;gap:12px">
            <button id="af-range-confirmar"
              style="flex:1;padding:12px;background:var(--accent);color:#000;border:none;border-radius:var(--radius);
                     font-weight:700;font-size:.9rem;cursor:pointer">
              Exportar
            </button>
            <button id="af-range-cancelar"
              style="flex:1;padding:12px;background:var(--bg-2);color:var(--text);border:1px solid var(--border);
                     border-radius:var(--radius);font-size:.9rem;cursor:pointer">
              Cancelar
            </button>
          </div>
        </div>`;

      document.body.appendChild(modal);
      const inputIni = document.getElementById('af-range-inicio-input');
      const inputFim = document.getElementById('af-range-fim-input');
      const contagemEl = document.getElementById('af-range-contagem');
      const avisoEl = document.getElementById('af-range-aviso');

      const fechar = (resultado) => {
        modal.remove();
        document.removeEventListener('keydown', onKeydown);
        resolve(resultado);
      };
      const confirmar = () => {
        const a = inputIni.value, b = inputFim.value;
        if (!a || !b) { fechar(null); return; }
        // Se a pessoa preencher invertido (Até antes de De), corrige
        // sozinho — strings 'YYYY-MM-DD' comparam cronologicamente
        // igual a números, então min/max direto já resolve, sem travar
        // pedindo pra reordenar.
        fechar(a <= b ? { inicio: a, fim: b } : { inicio: b, fim: a });
      };
      const onKeydown = (e) => {
        if (e.key === 'Escape') fechar(null);
        if (e.key === 'Enter') confirmar();
      };
      const atualizarContagem = () => {
        const n = _contarOperacoesDoPeriodo(inputIni.value, inputFim.value);
        contagemEl.textContent = _textoContagemAnalises(n);
        const aviso = formato === 'pdf' ? _textoAvisoDemora(n) : '';
        avisoEl.textContent = aviso;
        avisoEl.style.display = aviso ? 'block' : 'none';
      };

      document.getElementById('af-range-confirmar').addEventListener('click', confirmar);
      document.getElementById('af-range-cancelar').addEventListener('click', () => fechar(null));
      modal.addEventListener('click', (e) => { if (e.target === modal) fechar(null); });
      document.addEventListener('keydown', onKeydown);
      inputIni.addEventListener('input', atualizarContagem);
      inputIni.addEventListener('change', atualizarContagem);
      inputFim.addEventListener('input', atualizarContagem);
      inputFim.addEventListener('change', atualizarContagem);
      inputIni.focus();
    });
  }

  // ── Exportação "Do Dia" — uma Análise Focada completa para CADA
  // operação feita na `dataAlvo` escolhida (ver _escolherDataDoDia,
  // acima), empilhadas numa página só. Reaproveita _gerarHtmlAfStandalone
  // (a mesma peça usada pela Exportação Simples) pra montar cada bloco
  // individual — cada operação vira um <iframe srcdoc="..."> com o MESMO
  // documento autossuficiente que sairia se fosse exportada sozinha, só
  // embutido dentro de uma página "casca" que os empilha um embaixo do
  // outro. srcdoc é tratado como MESMA ORIGEM da página que o criou (spec
  // do HTML), então dá pra ler contentWindow.document de dentro pra fora
  // sem CORS, mesmo abrindo o arquivo exportado localmente (file://) —
  // é assim que cada iframe se auto-ajusta de altura (ver _gerarHtmlAfDoDia).
  // @param {string} dataAlvo - 'YYYY-MM-DD' escolhida no calendário.
  // @param {'html'|'pdf'} formato
  async function _exportarDoDia(dataAlvo, formato = 'html') {
    const { id: btnId, textoRepouso } = _botaoDoFormato(formato);
    const btn = document.getElementById(btnId);
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando…'; }
    const signal = _progressoIniciar();
    try {
      await _carregarCaches();
      if (_progressoCancelado) return;

      const opsDoDia = _cacheHistorico
        .filter(op => op.data === dataAlvo)
        .sort((a, b) => (a.inicio || '').localeCompare(b.inicio || ''));

      if (!opsDoDia.length) { if (LW.mostrarAlerta) LW.mostrarAlerta(`Não encontrei nenhuma operação em ${_fmtData(dataAlvo)}.`, { tipo: 'erro' }); return; }

      let _feitos = 0;
      _progressoAtualizar('Carregando dados das operações…', 0, opsDoDia.length);
      const detalhesDetalhados = await Promise.all(opsDoDia.map(async op => {
        const detalhe = await LW.getDetalheOperacao(op.id);
        _feitos++;
        _progressoAtualizar('Carregando dados das operações…', _feitos, opsDoDia.length);
        return { op, detalhe };
      }));
      if (_progressoCancelado) return;

      // pdf: cada item carrega as SEÇÕES já renderizadas (leve, sem
      // <iframe>/<script> — ver _gerarHtmlAfMultiplasEstaticoPdf); html:
      // cada item carrega o standalone interativo de sempre (vira um
      // <iframe srcdoc> na casca, ver _gerarHtmlAfMultiplas).
      const itens = detalhesDetalhados
        .filter(({ detalhe }) => !!detalhe)
        .map(({ op, detalhe }) => {
          _anotarOrigemEReaproveitamento(detalhe.tracos, op.id);
          const paradasDaJanela = _paradasNaJanela(_cacheParadas, detalhe.operacao?.inicio, detalhe.operacao?.fim);
          const base = {
            id: detalhe.operacao?.id || op.id,
            label: `${detalhe.operacao?.id_bateria || '—'} · ${_fmtHora(detalhe.operacao?.inicio)} — ${_fmtHora(detalhe.operacao?.fim)} · ${detalhe.operacao?.turno || '—'}`,
          };
          return formato === 'pdf'
            ? { ...base, secoes: _gerarSecoesEstaticasAf(detalhe, paradasDaJanela) }
            : { ...base, html: _gerarHtmlAfStandalone(detalhe, paradasDaJanela) };
        });

      if (!itens.length) { if (LW.mostrarAlerta) LW.mostrarAlerta('Não consegui carregar os dados das operações deste dia.', { tipo: 'erro' }); return; }

      _progressoMontagem();
      const dataFmt = _fmtData(dataAlvo);
      const html = formato === 'pdf'
        ? _gerarHtmlAfMultiplasEstaticoPdf(
            `Análise Focada — Dia ${dataFmt} — Exportado`,
            `🔎 Análise Focada — Todas as Operações do Dia ${LW.escaparHtml(dataFmt)}`,
            `${itens.length} operaç${itens.length === 1 ? 'ão' : 'ões'} neste dia`,
            itens
          )
        : _gerarHtmlAfDoDia(dataAlvo, itens);
      if (_progressoCancelado) return;
      if (formato === 'pdf') _progressoEnviando();
      await _finalizarExportacao(
        formato,
        `analise_focada_dia_${String(dataAlvo || 'data').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        html,
        signal
      );
    } catch (err) {
      if (err && err.name === 'AbortError') {
        // Cancelado pelo usuário — já visível pelo texto "Cancelando…" da
        // barra, sem precisar de mais um alerta de erro por cima.
      } else {
        console.error('Falha ao exportar Análise Focada do Dia:', err);
        if (LW.mostrarAlerta) LW.mostrarAlerta(err && err.message ? err.message : 'Não consegui gerar o arquivo agora.', { tipo: 'erro' });
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = textoRepouso; }
      _progressoFinalizar();
    }
  }

  // ── Exportação "Personalizada" — mesma ideia de "Do Dia" (acima), só
  // que num INTERVALO de datas em vez de 1 dia só (ver _escolherRangeDatas).
  // Reaproveita a mesma "casca" _gerarHtmlAfMultiplas que empilha os
  // <iframe srcdoc="..."> — só muda o título/rótulo do período e o
  // critério do filtro (>=/<= em vez de ===). Como pode abranger mais de
  // um dia, o label de cada bloco no índice ganha a DATA na frente (ver
  // itens.map abaixo) — em "Do Dia" isso é redundante (já é um dia só,
  // dito no título), mas aqui é essencial pra diferenciar operações de
  // dias diferentes.
  // @param {string} dataInicio - 'YYYY-MM-DD'.
  // @param {string} dataFim - 'YYYY-MM-DD'.
  // @param {'html'|'pdf'} formato
  async function _exportarPersonalizado(dataInicio, dataFim, formato = 'html') {
    const { id: btnId, textoRepouso } = _botaoDoFormato(formato);
    const btn = document.getElementById(btnId);
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando…'; }
    const signal = _progressoIniciar();
    try {
      await _carregarCaches();
      if (_progressoCancelado) return;

      const opsDoPeriodo = _cacheHistorico
        .filter(op => op.data >= dataInicio && op.data <= dataFim)
        .sort((a, b) => (a.data === b.data) ? (a.inicio || '').localeCompare(b.inicio || '') : a.data.localeCompare(b.data));

      if (!opsDoPeriodo.length) { if (LW.mostrarAlerta) LW.mostrarAlerta(`Não encontrei nenhuma operação entre ${_fmtData(dataInicio)} e ${_fmtData(dataFim)}.`, { tipo: 'erro' }); return; }

      let _feitos = 0;
      _progressoAtualizar('Carregando dados das operações…', 0, opsDoPeriodo.length);
      const detalhesDetalhados = await Promise.all(opsDoPeriodo.map(async op => {
        const detalhe = await LW.getDetalheOperacao(op.id);
        _feitos++;
        _progressoAtualizar('Carregando dados das operações…', _feitos, opsDoPeriodo.length);
        return { op, detalhe };
      }));
      if (_progressoCancelado) return;

      const itens = detalhesDetalhados
        .filter(({ detalhe }) => !!detalhe)
        .map(({ op, detalhe }) => {
          _anotarOrigemEReaproveitamento(detalhe.tracos, op.id);
          const paradasDaJanela = _paradasNaJanela(_cacheParadas, detalhe.operacao?.inicio, detalhe.operacao?.fim);
          const base = {
            id: detalhe.operacao?.id || op.id,
            label: `${_fmtData(detalhe.operacao?.data)} · ${detalhe.operacao?.id_bateria || '—'} · ${_fmtHora(detalhe.operacao?.inicio)} — ${_fmtHora(detalhe.operacao?.fim)} · ${detalhe.operacao?.turno || '—'}`,
          };
          return formato === 'pdf'
            ? { ...base, secoes: _gerarSecoesEstaticasAf(detalhe, paradasDaJanela) }
            : { ...base, html: _gerarHtmlAfStandalone(detalhe, paradasDaJanela) };
        });

      if (!itens.length) { if (LW.mostrarAlerta) LW.mostrarAlerta('Não consegui carregar os dados das operações deste período.', { tipo: 'erro' }); return; }

      _progressoMontagem();
      const fmtIni = _fmtData(dataInicio);
      const fmtFim = _fmtData(dataFim);
      const periodoLabel = dataInicio === dataFim ? fmtIni : `${fmtIni} a ${fmtFim}`;
      const html = formato === 'pdf'
        ? _gerarHtmlAfMultiplasEstaticoPdf(
            `Análise Focada — ${periodoLabel} — Exportado`,
            `🔎 Análise Focada — Operações de ${LW.escaparHtml(periodoLabel)}`,
            `${itens.length} operaç${itens.length === 1 ? 'ão' : 'ões'} neste período`,
            itens
          )
        : _gerarHtmlAfPersonalizado(dataInicio, dataFim, itens);
      if (_progressoCancelado) return;
      if (formato === 'pdf') _progressoEnviando();
      await _finalizarExportacao(
        formato,
        `analise_focada_${String(dataInicio).replace(/[^a-zA-Z0-9_-]/g, '_')}_a_${String(dataFim).replace(/[^a-zA-Z0-9_-]/g, '_')}`,
        html,
        signal
      );
    } catch (err) {
      if (err && err.name === 'AbortError') {
        // Cancelado pelo usuário — já visível pelo texto "Cancelando…" da
        // barra, sem precisar de mais um alerta de erro por cima.
      } else {
        console.error('Falha ao exportar Análise Focada Personalizada:', err);
        if (LW.mostrarAlerta) LW.mostrarAlerta(err && err.message ? err.message : 'Não consegui gerar o arquivo agora.', { tipo: 'erro' });
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = textoRepouso; }
      _progressoFinalizar();
    }
  }

  // Cor REAL de um tipo de montagem — mesma lógica de corPorTipoSimples/
  // corMontagemPorLabel (data.js: _hexDoTipoSimples/corCssDoHex/
  // hslParaHex/hexParaRgba), reimplementada aqui com o prefixo "_af" porque
  // o HTML exportado standalone não carrega data.js — ele só tem acesso ao
  // que for colado neste template (ver _gerarHtmlAfStandalone, abaixo).
  // Lê de LW.MONTAGEM_OPCOES, que é o retrato de configuração embutido no
  // export (ver "const LW = {...}", mais abaixo) — cada tipo de montagem
  // usa a MESMA cor configurada em Configurações → Montagem, igual à tela
  // ao vivo. Substitui _corPorTipoSimplificada/_PALETA_TIPO (hash
  // determinístico), que dava uma cor genérica e consistente mas
  // DIFERENTE da cor real (ver conversa que motivou: "os cards de berço no
  // export ficam todos com cores genéricas, quero a cor real que indica o
  // tipo de montagem").
  function _afHslParaHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const paraHex = x => Math.round(255 * x).toString(16).padStart(2, '0');
    return `#${paraHex(f(0))}${paraHex(f(8))}${paraHex(f(4))}`;
  }
  function _afHexParaRgb(hex) {
    let h = String(hex || '').replace('#', '').trim();
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const num = parseInt(h, 16) || 0;
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }
  function _afHexParaRgba(hex, alpha) {
    const { r, g, b } = _afHexParaRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  function _afCorCssDoHex(hex) {
    return { cor: hex, bg: _afHexParaRgba(hex, .15), borda: _afHexParaRgba(hex, .3) };
  }
  function _afCorMontagemNeutra() {
    return { hibrida: false, cor: '#5c6475', bg: 'rgba(156, 163, 175, .1)', borda: '#2a2f3a' };
  }
  // Extrai o hex de um tipo SIMPLES — aceita o objeto da opção ou o código
  // do tipo (ex: 'sp'), buscando em LW.MONTAGEM_OPCOES nesse 2º caso.
  function _afHexDoTipoSimples(tipoOuOpcao) {
    const op = typeof tipoOuOpcao === 'string'
      ? (LW.MONTAGEM_OPCOES || []).find(o => o.modo === 'simples' && o.tipo === tipoOuOpcao)
      : tipoOuOpcao;
    if (!op) return null;
    if (typeof op.cor === 'string' && op.cor) return op.cor;
    if (typeof op.corHue === 'number') return _afHslParaHex(op.corHue, 60, 52);
    return null;
  }
  function _afCorMontagemPorLabel(label) {
    const opcao = (LW.MONTAGEM_OPCOES || []).find(o => o.label === label);
    if (!opcao) return _afCorMontagemNeutra();
    if (opcao.modo === 'simples') {
      const hex = _afHexDoTipoSimples(opcao);
      if (hex) return { ..._afCorCssDoHex(hex), hibrida: false };
    }
    if (opcao.modo === 'hibrida' && Array.isArray(opcao.tipos) && opcao.tipos.length === 2) {
      const [op1, op2] = opcao.tipos.map(t =>
        (LW.MONTAGEM_OPCOES || []).find(o => o.modo === 'simples' && o.tipo === t));
      const hex1 = _afHexDoTipoSimples(op1);
      const hex2 = _afHexDoTipoSimples(op2);
      if (hex1 && hex2) {
        const c1 = _afCorCssDoHex(hex1);
        const c2 = _afCorCssDoHex(hex2);
        return {
          hibrida: true,
          cor1: c1.cor, cor2: c2.cor,
          cor: c1.cor,
          bg: `linear-gradient(90deg, ${c1.bg} 50%, ${c2.bg} 50%)`,
          borda: c1.borda,
        };
      }
    }
    return _afCorMontagemNeutra();
  }
  function _afCorPorTipoSimples(tipo) {
    const hex = _afHexDoTipoSimples(tipo);
    if (!hex) return _afCorMontagemNeutra();
    return { ..._afCorCssDoHex(hex), hibrida: false };
  }

  // CSS específico da Análise Focada, compartilhado por TODOS os exports
  // (interativo E o estático de PDF, ver _gerarHtmlAfEstaticoPdf mais
  // abaixo) — extraído pra função pra não duplicar ~90 linhas de CSS entre
  // os dois templates (e evitar que um ganhe um ajuste visual e o outro
  // fique pra trás). Sempre usado em cima de LW.gerarCssExportPadrao()
  // (data.js), que traz a paleta de cores/tema e o layout base
  // (.chart-box, h1, .sub etc.) compartilhado com os outros dashboards.
  function _afCssComum() {
    return `
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
  .af-traco-origem-linha { margin-top:10px; font-size:.8rem; color:var(--text-2); display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .af-paineis-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; }
  .af-pallet { border:1px solid var(--border); border-radius:var(--radius-lg); padding:10px 12px; background:var(--bg-1); }
  .af-pallet-header { display:flex; justify-content:space-between; align-items:center; font-weight:700; font-size:.85rem; margin-bottom:8px; position:relative; }
  .af-pallet-header-direita { display:flex; align-items:center; gap:6px; }
  .af-pallet-tipo { font-size:.66rem; font-weight:600; background:var(--border); color:var(--text-3); padding:2px 8px; border-radius:999px; }
  .af-pallet-foto { background:transparent; border:1px solid var(--border); color:var(--text-3); min-width:20px; height:18px; padding:0 4px; border-radius:9px; cursor:pointer; font-size:.58rem; display:flex; align-items:center; justify-content:center; gap:2px; opacity:.55; transition:border-color .15s, color .15s, opacity .15s; }
  .af-pallet-foto::before { content:'📷'; }
  .af-pallet-foto[data-contagem]:not([data-contagem=""])::after { content:attr(data-contagem); font-weight:700; }
  .af-pallet-foto:hover, .af-pallet-foto.tem-foto { opacity:1; border-color:var(--accent); color:var(--accent); }
  .af-pallet-slabs { display:flex; flex-direction:column; gap:4px; }
  .af-slab { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:5px 8px; border:1px solid var(--border); border-left-width:3px; border-radius:4px; font-size:.78rem; background:var(--bg-card); }
  .af-slab-num { color:var(--text-3); font-family:var(--font-mono); }
  .af-slab-resultado { font-weight:700; text-align:right; }
  .af-foto-modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.6); z-index:999; display:flex; align-items:center; justify-content:center; padding:16px; }
  .af-foto-modal { background:var(--bg-card); border:1px solid var(--border-2); border-radius:var(--radius-lg); padding:14px; width:380px; max-width:100%; max-height:85vh; overflow-y:auto; box-shadow:0 12px 40px rgba(0,0,0,.6); }
  .af-foto-modal-titulo { display:flex; align-items:center; justify-content:space-between; font-size:.82rem; font-weight:700; color:var(--text); margin-bottom:10px; }
  .af-foto-modal-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; }
  .af-foto-modal-item { position:relative; aspect-ratio:1; border-radius:var(--radius); overflow:hidden; border:1px solid var(--border); background:var(--bg-2); }
  .af-foto-modal-item img { width:100%; height:100%; object-fit:cover; cursor:zoom-in; }
  .af-foto-modal-vazio { font-size:.7rem; color:var(--text-3); font-style:italic; text-align:center; padding:10px 0 14px; }
  .af-foto-viewer-overlay { position:fixed; inset:0; background:rgba(0,0,0,.9); z-index:1001; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px; padding:20px; cursor:zoom-out; }
  .af-foto-viewer-overlay img { max-width:100%; max-height:75vh; border-radius:var(--radius); box-shadow:0 12px 50px rgba(0,0,0,.5); cursor:zoom-out; }
  /* Barra de controles — SEMPRE embaixo da foto, num lugar fixo (não
     "gruda" na borda da imagem nem se move conforme o tamanho dela, ver
     .af-foto-viewer-overlay img acima: max-height:75vh deixa uma faixa
     de respiro por baixo pra essa barra caber sem sobrepor nada, mesmo
     numa foto beeem vertical). Pílula com leve blur — bem mais discreta
     que 2 botões soltos boiando em cima da imagem (como era antes). */
  .af-foto-viewer-controles { display:flex; align-items:center; gap:16px; background:rgba(255,255,255,.08); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); border:1px solid rgba(255,255,255,.14); border-radius:999px; padding:8px 18px; box-shadow:0 6px 24px rgba(0,0,0,.35); }
  .af-foto-viewer-seta { background:rgba(255,255,255,.12); color:#fff; border:none; width:38px; height:38px; border-radius:50%; font-size:1.4rem; line-height:1; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:background .15s, transform .1s; }
  .af-foto-viewer-seta:hover { background:rgba(255,255,255,.28); }
  .af-foto-viewer-seta:active { transform:scale(.9); }
  .af-foto-viewer-contador { color:#fff; font-size:.8rem; font-weight:700; letter-spacing:.03em; min-width:42px; text-align:center; }
  .ba-grid { display:flex; flex-direction:row-reverse; flex-wrap:nowrap; justify-content:center; gap:4px; }
  .ba-celula { display:flex; flex-direction:column; align-items:center; justify-content:space-between; flex:1 1 0; min-width:0; padding:6px 2px; border-radius:var(--radius); }
  .ba-numero { text-align:center; white-space:nowrap; font-size:.72rem; }
  .ba-dot { font-size:.95rem; line-height:1; padding:3px 5px; opacity:.55; border-radius:50%; }
  .ba-dot.ba-dot-marcado { opacity:1; color:var(--red); background:rgba(229,72,77,.15); }
  .badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:.72rem; font-weight:700; }
  .badge-blue { background:rgba(59,130,246,.15); color:#93c5fd; }
  .badge-red { background:rgba(239,68,68,.15); color:#fecaca; }
  .mono { font-family:var(--font-mono); }
  /* Paradas Nesta Janela — retrátil, fechado por padrão (mesmo tratamento da tela ao vivo) */
  details.chart-box { padding:0; }
  details.chart-box > summary { padding:16px; margin:0; cursor:pointer; user-select:none; list-style:none; }
  details.chart-box > summary::-webkit-details-marker { display:none; }
  details.chart-box > summary::after { content:'▸'; float:right; color:var(--text-3); transition:transform .15s ease; }
  details.chart-box[open] > summary { border-bottom:1px solid var(--border); }
  details.chart-box[open] > summary::after { transform:rotate(90deg); }
  details.chart-box > div { padding:16px; }
  #af-paradas-contagem { text-transform:none; letter-spacing:normal; font-weight:400; }
  /* Modal "📋 Detalhes do Berço" (ver abrirDetalhesBerco, acima) — cópia
     das regras de .ba-detalhes-*, .ba-palete-*, .form-label, .btn de
     styles.css, local a este export (mesmo padrão já usado acima pra
     .af-*, .ba-grid, .ba-celula): o HTML exportado é autossuficiente, não
     carrega styles.css. var(--bg-2)/var(--bg-3)/var(--font-display) não
     existem nas paletas de LW.gerarCssExportPadrao (acima), por isso os
     fallbacks abaixo (2º valor de var()). */
  .ba-detalhes-overlay { position:fixed; inset:0; background:rgba(0,0,0,.75); z-index:1000; display:flex; align-items:center; justify-content:center; padding:20px; }
  .ba-detalhes-box { position:relative; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-lg); box-shadow:0 24px 80px rgba(0,0,0,.6); padding:28px; width:420px; max-width:94vw; max-height:90vh; overflow-y:auto; }
  .ba-detalhes-fechar { position:absolute; top:14px; right:14px; background:none; border:none; color:var(--text-3); font-size:1.1rem; cursor:pointer; line-height:1; padding:4px; }
  .ba-detalhes-fechar:hover { color:var(--text); }
  .ba-detalhes-titulo { font-family:var(--font-display, inherit); font-size:1.1rem; color:var(--accent); text-align:center; margin:0 0 18px; }
  .ba-detalhes-desenho { display:flex; justify-content:center; margin-bottom:22px; }
  .ba-detalhes-celula { display:flex; flex-direction:column; align-items:center; justify-content:space-between; width:110px; height:150px; border-radius:var(--radius-lg); padding:14px 0; font-weight:700; }
  .ba-detalhes-dot { font-size:1.3rem; opacity:.45; }
  .ba-detalhes-dot-x { opacity:1; color:var(--blue); text-shadow:0 0 6px var(--blue); }
  .ba-detalhes-dot-vazou { opacity:1; color:var(--red); text-shadow:0 0 6px var(--red); }
  .ba-detalhes-label { font-size:1.05rem; }
  .ba-detalhes-campos { display:flex; flex-direction:column; gap:14px; margin-bottom:22px; }
  .ba-det-valor { color:var(--text-2); font-size:.92rem; padding:8px 0; }
  .ba-detalhes-acoes { display:flex; justify-content:flex-end; gap:10px; }
  .ba-detalhes-paletes { display:flex; gap:18px; padding-top:4px; }
  .ba-detalhes-palete-lado { flex:1; display:flex; flex-direction:column; align-items:center; gap:6px; min-width:0; }
  .ba-detalhes-palete-lado-label { font-size:.74rem; text-transform:uppercase; letter-spacing:.04em; color:var(--text-3); }
  .ba-palete-mini { display:flex; flex-direction:column; align-items:center; gap:6px; }
  .ba-palete-mini-titulo { font-size:.8rem; font-weight:700; }
  .ba-palete-mini-stack { display:flex; flex-direction:column-reverse; gap:2px; width:70px; }
  .ba-palete-slot { display:flex; align-items:center; justify-content:center; width:100%; height:20px; border-radius:var(--radius); border:1px solid var(--border); background:var(--bg-2, var(--bg-1)); color:var(--text-3); font-size:.68rem; font-weight:600; }
  .ba-palete-slot-ativo { color:#fff; box-shadow:0 0 6px rgba(0,0,0,.35); }
  .form-label { font-size:.67rem; font-weight:600; letter-spacing:.07em; text-transform:uppercase; color:var(--text-3); }
  .btn { display:inline-flex; align-items:center; gap:7px; padding:9px 18px; border-radius:var(--radius); font-family:var(--font-display, inherit); font-size:.88rem; font-weight:600; letter-spacing:.05em; text-transform:uppercase; cursor:pointer; border:none; transition:all .15s; white-space:nowrap; }
  .btn-ghost { background:transparent; color:var(--text-2); border:1px solid var(--border-2); }
  .btn-ghost:hover { background:var(--bg-3, var(--bg-card)); color:var(--text); }`;
  }

  // ── CSS de paginação/A4 do export ESTÁTICO de PDF (ver
  // _gerarHtmlAfEstaticoPdf, mais abaixo) — NÃO usado pelo export
  // interativo (que é pra tela, sem preocupação de página impressa).
  // Duas responsabilidades:
  //  1) Largura de conteúdo ~= área útil de uma A4 (210mm - 2×margem do
  //     Chromium em lib/rotas/exportar-pdf.js, hoje 5mm cada lado = 200mm),
  //     pra grids "auto-fit" (.af-cabecalho-grid, .af-receita-grid,
  //     .af-paineis-grid, .ba-grid) quebrarem em colunas do MESMO jeito
  //     que vão sair no papel, em vez de se basearem numa viewport de tela
  //     bem mais larga.
  //  2) `break-inside:avoid` (+ prefixo `page-break-inside` pra engines
  //     mais antigas) em cada "unidade visual" (card de traço, card de
  //     pallet, célula de berço, linha de ajuste, bloco de parada) — sem
  //     isso, o Chromium corta o card no meio bem na borda da página
  //     sempre que ele não cabe inteiro no espaço que sobrou, deixando a
  //     metade de baixo pra próxima folha (pedido que motivou este ajuste:
  //     "sem ficar cortando section"). `break-inside:avoid` funciona
  //     independente de @media print/screen — é a paginação em si do
  //     `page.pdf()` que respeita, não a resolução de estilo — mas mantém
  //     também dentro de um bloco @media print pra este MESMO arquivo
  //     continuar se comportando bem se alguém abrir e imprimir direto
  //     pelo navegador (Ctrl+P), fora do Puppeteer.
  // Altura útil de UMA página A4 impressa pelo Chromium: 297mm de altura
  // total menos as margens top+bottom que lib/rotas/exportar-pdf.js pede
  // no `page.pdf({ margin: { top:'5mm', bottom:'5mm', ... } })` — ou
  // seja, 297 - 5 - 5 = 287mm de área realmente disponível pro
  // conteúdo. Margens reduzidas de 10mm pra 5mm (pedido: "consegue tirar
  // a margem que fica na a4, ainda fica uma margem branca [...] pode
  // diminuir um poquinho mais") — 5mm é o menor valor que ainda evita
  // qualquer risco de corte em impressoras/leitores de PDF mais
  // sensíveis nas bordas, mas já libera bastante espaço extra (10mm a
  // mais de altura e de largura úteis) pra reduzir a chance de a seção
  // de Avaliação de Qualidade ficar cortada embaixo quando o conteúdo é
  // grande. Se esse valor de margem mudar um dia em exportar-pdf.js,
  // precisa mudar aqui também (os dois lados dessa conta vivem em
  // arquivos diferentes por necessidade — um é CSS de cliente, o outro é
  // opção do Puppeteer no servidor — não dá pra compartilhar a constante
  // literalmente, mas o comentário nos dois lados aponta um pro outro).
  const _AF_PDF_ALTURA_PAGINA_MM = 287;

  function _afCssImpressaoPdf() {
    const regras = `
  html, body { background:var(--bg-1); }
  body { max-width:200mm; margin:0 auto; padding:0; }
  .chart-box, .af-traco-card, .af-pallet, .af-ajuste-linha, .ba-celula { break-inside:avoid; page-break-inside:avoid; }
  h1, h4, .af-op-titulo { break-after:avoid; page-break-after:avoid; }
  /* .af-op-pagina — usada em TODO export estático de PDF da Análise
     Focada: tanto Simples (1 operação só, ver _gerarHtmlAfEstaticoPdf)
     quanto "Do Dia"/"Personalizada" (várias operações, uma por
     .af-op-pagina, ver _gerarHtmlAfMultiplasEstaticoPdf). Cada bloco
     recebe a altura EXATA de uma página A4 útil (ver
     _AF_PDF_ALTURA_PAGINA_MM, acima) e "overflow:hidden" — junto com o
     "break-before:page" logo abaixo (só entra em jogo quando há mais de
     uma .af-op-pagina, isto é, no "Do Dia"/"Personalizada"), isso faz
     cada operação abrir numa folha nova E nunca vazar pra próxima, porque
     o conteúdo de dentro (.af-op-conteudo-escala) é encolhido via JS (ver
     _afScriptAjustePaginaUnica, chamado nos dois tipos de export) pra
     caber inteiro nessa altura antes do Puppeteer imprimir —
     overflow:hidden aqui é só uma rede de segurança caso aquele cálculo
     erre por alguma fração de pixel, não o mecanismo principal de
     ajuste. */
  .af-op-pagina { height:${_AF_PDF_ALTURA_PAGINA_MM}mm; overflow:hidden; position:relative; break-inside:avoid; page-break-inside:avoid; }
  .af-op-pagina + .af-op-pagina { break-before:page; page-break-before:always; margin-top:0; }
  /* transform-origin:top left é o que faz o scale() (aplicado via JS,
     ver comentário acima) encolher a partir do canto superior esquerdo
     — sem isso o navegador encolhe a partir do CENTRO por padrão, o que
     deixaria uma faixa de espaço vazio em cima do conteúdo em vez de
     ficar coladinho no topo da página. */
  .af-op-conteudo-escala { transform-origin:top left; }
  /* No PDF, "Paradas Nesta Janela" já sai sempre ABERTO (sem <details>
     retrátil — não faz sentido um "clique para expandir" num documento
     impresso, ver _gerarHtmlAfEstaticoPdf) — mas a regra de
     details.chart-box em _afCssComum() continua definida (ambos os
     templates compartilham o mesmo CSS base) sem efeito aqui. */`;
    return `
  @media print {${regras}
  }
${regras}`;
  }

  // ── Script que encolhe cada .af-op-conteudo-escala pra caber inteira
  // dentro da página A4 de .af-op-pagina (ver comentário em
  // _afCssImpressaoPdf, acima) — entra em TODO export estático de PDF da
  // Análise Focada: Simples (_gerarHtmlAfEstaticoPdf, 1 única
  // .af-op-pagina) e "Do Dia"/"Personalizada"
  // (_gerarHtmlAfMultiplasEstaticoPdf, uma .af-op-pagina por operação).
  //
  // POR QUE ISSO PRECISA DE JAVASCRIPT (e não dá pra fazer só com CSS):
  // não existe nenhuma propriedade CSS que diga "encolha isto até caber
  // na altura disponível" — só sabemos a altura REAL do conteúdo depois
  // de ele já estar renderizado (varia MUITO: uma operação com poucos
  // berços e nenhuma foto de defeito cabe fácil, outra com 20 paradas e
  // fotos de vários paletes pode passar de 2-3 páginas do jeito natural).
  // Então o fluxo é: 1) deixa o navegador renderizar tudo no tamanho
  // normal; 2) mede quanto "sobrou" (scrollHeight) contra quanto cabe
  // (a altura da página, ${_AF_PDF_ALTURA_PAGINA_MM}mm); 3) se não
  // coube, calcula a escala necessária e aplica um transform:scale() —
  // 2 passadas (a 2ª remede depois do transform, porque alargar a caixa
  // pra compensar a largura perdida no scale pode reorganizar grids e
  // mudar a altura de novo; ver comentário dentro da função).
  //
  // QUANDO RODA: só depois do evento `load` da janela (não
  // DOMContentLoaded) — garante que todo o conteúdo (grids, cards,
  // fontes) já tenha layout final calculado antes de medir scrollHeight,
  // senão a conta sai errada com o layout ainda "murcho".
  //
  // POR QUE É SEGURO rodar isto de forma síncrona dentro do próprio
  // Chromium do servidor (lib/rotas/exportar-pdf.js espera
  // `waitUntil:'networkidle0'` antes de chamar `page.pdf()`): o evento
  // `load` sempre dispara ANTES de a rede ficar "idle" (que exige mais
  // 500ms sem requisições depois do load) — como este script não faz
  // NENHUMA requisição de rede (só mede/mexe em elementos já no DOM) e
  // roda 100% síncrono (sem await/setTimeout), ele termina de executar
  // dentro do próprio ciclo do evento `load`, bem antes do Puppeteer
  // sequer considerar a rede ociosa e mandar imprimir.
  // `window.__afAjustePaginaConcluido` — sinalizador simples de
  // "terminei de encolher tudo que precisava" (ver função abaixo). O
  // servidor (lib/rotas/exportar-pdf.js) espera esse sinal virar `true`
  // ANTES de chamar `page.pdf()` (via `page.waitForFunction`), em vez de
  // confiar só no `waitUntil:'networkidle0'` do `page.setContent` —
  // networkidle0 só olha requisições de REDE, e este documento não faz
  // nenhuma, então "a rede está ociosa" pode virar verdade ANTES mesmo do evento
  // `load` disparar e o ajuste de escala rodar — sem esse sinal explícito
  // o Puppeteer poderia imprimir cedo demais, com o conteúdo ainda no
  // tamanho grande. Fica `false` desde o `<head>` (ver
  // _gerarHtmlAfMultiplasEstaticoPdf) até o `load` terminar de ajustar
  // todas as páginas.
  function _afScriptFlagInicial() {
    return `<script>window.__afAjustePaginaConcluido = false;</script>`;
  }

  function _afScriptAjustePaginaUnica() {
    return `<script>
(function () {
  // Fator de segurança aplicado em cima do espaço "realmente livre" (ver
  // \`disponivel\`, abaixo) — pedido: "o último painel da avaliação ainda
  // fica cortado" mesmo com a escala calculada pra caber exatamente no
  // espaço medido. O cálculo em si está correto, mas ele mede o layout
  // renderizado NA TELA (clientHeight/scrollHeight, antes do Puppeteer
  // imprimir) — a impressão em si pode arredondar frações de pixel de
  // forma um pouco diferente (fontes, subpixel, motor de paginação do
  // Chromium), então uma escala calculada pra caber "raspando" o limite
  // pode vazar alguns pixels na hora de imprimir de verdade. Encolher um
  // pouquinho A MAIS do que o estritamente necessário (3%) dá essa folga
  // sem ficar perceptível a olho nu.
  var FATOR_SEGURANCA = 0.97;

  // Teto de passadas de correção — ver comentário grande dentro do loop,
  // abaixo, sobre por que 2 passadas fixas (versão anterior) não bastavam
  // pra operações com MUITO conteúdo na Avaliação de Qualidade (vários
  // traços com ajustes + 4 pallets cheios de painéis): "o último painel
  // ainda fica cortado" evoluiu pra "cortando bem mais" justamente numa
  // operação assim — o conteúdo real não estava recebendo NENHUM
  // encolhimento (o texto saía em tamanho normal, só cortado seco pelo
  // overflow:hidden de .af-op-pagina), porque a 2ª passada nem sempre é
  // suficiente pra a grade (.af-paineis-grid, auto-fit) terminar de se
  // reorganizar e estabilizar numa altura definitiva.
  var MAX_PASSADAS = 6;

  function ajustarParaCaberNumaPagina(pagina) {
    var conteudo = pagina.querySelector('.af-op-conteudo-escala');
    if (!conteudo) return;
    conteudo.style.transform = 'none';
    conteudo.style.width = '100%';

    // Espaço realmente livre = altura total da página menos o quanto já
    // foi consumido ACIMA do conteúdo (o rótulo "Operação X de Y…", ver
    // .af-op-titulo) — offsetTop é relativo a .af-op-pagina porque ela
    // tem position:relative (ver _afCssImpressaoPdf). Aplica o
    // FATOR_SEGURANCA aqui (e não só no cálculo da escala) pra também
    // fazer o teste de "já cabe, não mexe em nada" logo abaixo respeitar
    // a mesma folga — senão um conteúdo bem no limite passaria batido
    // sem nenhum encolhimento e voltaria a correr risco de corte.
    var disponivel = (pagina.clientHeight - conteudo.offsetTop) * FATOR_SEGURANCA;
    if (disponivel <= 0) return;

    // LOOP CONVERGENTE (substitui as antigas "2 passadas fixas"): mede,
    // corrige, remede — cada passada RECALCULA a escala total a partir da
    // altura atual (disponivel / alturaAtual), como um "chute" novo pra
    // convergência de ponto fixo — NÃO multiplica em cima da escala da
    // passada anterior. (Nas primeiras versões deste loop, um bug bem
    // sutil compunha as correções — escalaAtual = escalaAtual *
    // fatorCorretivo — o que faz o encolhimento crescer
    // EXPONENCIALMENTE a cada passada, já que a altura remedida na
    // passada 2 já reflete a largura ajustada pela passada 1: compor de
    // novo em cima disso encolhe MUITO mais do que o necessário. Sintoma
    // visto na prática: conteúdo minúsculo, espremido lá no topo da
    // página, com a página quase toda vazia embaixo — bem diferente do
    // "sem nenhum encolhimento" que motivou trocar de 2 passadas fixas
    // pra este loop.) Alargar a caixa pra compensar um scale() pode
    // reorganizar grids (.af-cabecalho-grid, .af-paineis-grid etc.) em
    // mais colunas — às vezes isso estabiliza numa passada só, às vezes
    // leva 2-3 até o layout parar de mudar de verdade (ex.: operação com
    // muitos traços + 4 pallets cheios de painéis). Teto de MAX_PASSADAS
    // (6) passadas só pra garantir que isto NUNCA trave o Puppeteer
    // esperando um layout que nunca estabiliza — na prática, layouts
    // reais convergem bem antes disso.
    var escalaAtual = 1;
    for (var passada = 0; passada < MAX_PASSADAS; passada++) {
      var alturaAtual = conteudo.scrollHeight;
      if (alturaAtual <= disponivel) return; // convergiu (com folga) — não mexe mais em nada

      escalaAtual = disponivel / alturaAtual; // recalcula do zero, não compõe com a passada anterior
      conteudo.style.width = (100 / escalaAtual) + '%';
      conteudo.style.transform = 'scale(' + escalaAtual + ')';
    }
  }

  window.addEventListener('load', function () {
    // Nunca deixar UMA operação com layout problemático (exceção
    // inesperada dentro de ajustarParaCaberNumaPagina) impedir as OUTRAS
    // de serem ajustadas, nem travar a flag em \`false\` pra sempre — sem
    // este try/catch, uma exceção no meio do forEach interromperia o
    // loop inteiro e a linha que marca __afAjustePaginaConcluido nunca
    // seria alcançada, forçando o Puppeteer a esperar o timeout inteiro
    // e imprimir tudo SEM NENHUM ajuste (pior ainda que o bug original).
    var paginas = document.querySelectorAll('.af-op-pagina');
    paginas.forEach(function (pagina, indice) {
      try { ajustarParaCaberNumaPagina(pagina); } catch (e) { /* segue pras próximas páginas mesmo assim */ }
      // \`window.__afReportarProgresso\` (Fase 3 do plano de Exportação em
      // PDF, ver README) só existe quando este HTML está rodando dentro
      // do Chromium headless do servidor (ver page.exposeFunction em
      // lib/rotas/exportar-pdf.js) — vira progresso REAL na barra do
      // cliente. Quando este mesmo HTML é aberto direto no navegador
      // (ex.: alguém salvou o "Exportar Interativo" antes e abriu depois),
      // a função não existe e este \`if\` simplesmente não faz nada.
      if (typeof window.__afReportarProgresso === 'function') {
        window.__afReportarProgresso(indice + 1, paginas.length);
      }
    });
    window.__afAjustePaginaConcluido = true; // libera o Puppeteer pra imprimir (ver _afScriptFlagInicial)
  });
})();
</script>`;
  }

  function _gerarHtmlAfStandalone(detalhe, paradasDaJanela = []) {
    const detalheJson = JSON.stringify(detalhe).replace(/<\/script/gi, '<\\/script');
    const paradasJson = JSON.stringify(paradasDaJanela).replace(/<\/script/gi, '<\\/script');

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Análise Focada — ${LW.escaparHtml(String(detalhe.operacao?.id || ''))} — Exportado</title>
<style>${LW.gerarCssExportPadrao()}${_afCssComum()}</style>
</head>
<body>
  <h1>🔎 Análise Focada — Operação ${LW.escaparHtml(String(detalhe.operacao?.id || ''))}</h1>
  <div class="sub" id="exp-sub">Gerado em ${new Date().toLocaleString('pt-BR')}</div>

  <div class="chart-box" style="margin-bottom:14px"><h4>Identificação</h4><div id="af-cabecalho" class="af-cabecalho-grid"></div></div>
  <div class="chart-box" style="margin-bottom:14px"><h4>📍 Berços</h4><div id="af-bercos"></div></div>
  <div class="chart-box" style="margin-bottom:14px"><h4>🧪 Receita Utilizada</h4><div id="af-receita"></div></div>
  <details class="chart-box" style="margin-bottom:14px"><summary><h4 style="display:inline;border:none;padding:0">🛑 Paradas Nesta Janela</h4> <span id="af-paradas-contagem"></span></summary><div id="af-paradas"></div></details>
  <div class="chart-box"><h4>✅ Avaliação de Qualidade</h4><div id="af-avaliacao"></div></div>

  <div class="rodape">Exportado da Análise Focada — Lightwall SC · dados embutidos neste arquivo, funciona offline. Cores de tipo de montagem são aproximadas (não refletem necessariamente a cor configurada na tela ao vivo). Os badges de "Origem"/"Reaproveitado depois em" são só informativos aqui — abrir a outra operação exige a tela ao vivo.</div>

<script>
(function () {
  'use strict';
  const DETALHE = ${detalheJson};
  const PARADAS = ${paradasJson};
  // Só leitura: retrato dos dados de CONFIG que o modal de Detalhes do
  // Berço precisa (BATERIA_IDS/MONTAGEM_OPCOES/PALETES_CONFIG), tal como
  // estavam quando esta exportação foi gerada — o mesmo espírito de
  // DETALHE/PARADAS acima. Uma config alterada DEPOIS da exportação
  // (ex: nº de berços de uma bateria, opções de montagem) não reflete
  // aqui; é um retrato fixo, igual ao resto do arquivo.
  const LW = {
    escaparHtml: s => { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; },
    TIPO_MONTAGEM_PERSONALIZADA: 'PERSONALIZADA',
    corPorTipoSimples: ${_afCorPorTipoSimples},
    corMontagemPorLabel: ${_afCorMontagemPorLabel},
    formatDateTime: ${_afFormatDateTime},
    MONTAGEM_OPCOES: ${JSON.stringify(LW.MONTAGEM_OPCOES || [])},
    BATERIA_IDS: ${JSON.stringify(LW.BATERIA_IDS || [])},
    PALETES_CONFIG: ${JSON.stringify(LW.PALETES_CONFIG || LW.PALETES_CONFIG_DEFAULT || {})},
    PALETES_CONFIG_DEFAULT: ${JSON.stringify(LW.PALETES_CONFIG_DEFAULT || {})},
  };
  ${_afHslParaHex}
  ${_afHexParaRgb}
  ${_afHexParaRgba}
  ${_afCorCssDoHex}
  ${_afCorMontagemNeutra}
  ${_afHexDoTipoSimples}
  const AF_CORES_PALETE = ${JSON.stringify(AF_CORES_PALETE)};
  // abrirDetalhesBerco (embaixo) lê _ultimoDetalhe por closure, igual à
  // tela ao vivo (ver comentário original da função) — aqui é sempre
  // DETALHE, já que o export só tem 1 operação.
  const _ultimoDetalhe = DETALHE;

  ${_fmtData}
  ${_fmtHora}
  ${_fmtTempoBatidaOriginal}
  ${_fmtKg}
  ${_renderCabecalho}
  ${_corPorTipoBerco}
  ${_renderBercos}
  ${_badgeOperacao}
  ${_bercosEnchidosDoTraco}
  ${_calcularResumoTracos}
  ${_renderResumoTracos}
  ${_fmtLeitura}
  ${_renderReceita}
  ${_renderParadas}
  const _MOTIVO_POR_CODIGO = ${JSON.stringify(_MOTIVO_POR_CODIGO)};
  ${_sufixoMotivo}
  ${_tituloMotivo}
  ${_labelPainel}
  ${_corPainel}
  ${_totalPorPallet}
  ${_renderAvaliacao}
  ${_abrirFotosPalletFocada}
  ${_afCapacidadeConfigurada}
  ${_afPaletePorMetadeELado}
  ${_afPaleteDoBerco}
  ${_afDesenhoPaleteMini}
  ${_afTiposPorBerco}
  ${_afTracoDoBerco}
  ${_afPainelDoBerco}
  ${abrirDetalhesBerco}

  // Expõe abrirDetalhesBerco globalmente com o mesmo nome usado na tela
  // ao vivo (LWFocada.abrirDetalhesBerco) — é isso que faz _renderBercos
  // (acima) tratar as células como clicáveis (podeAbrirDetalhes = typeof
  // LWFocada !== 'undefined') e o onclick inline de cada célula resolver.
  window.LWFocada = { abrirDetalhesBerco, abrirFotosPallet: _abrirFotosPalletFocada };

  _renderCabecalho(DETALHE.operacao || {});
  _renderBercos(DETALHE.bercosVisuais, DETALHE.operacao);
  _renderReceita(DETALHE.tracos, DETALHE.bercosVisuais);
  _renderParadas(PARADAS);
  _renderAvaliacao(DETALHE.avaliacao);
})();
</script>
</body>
</html>`;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  Export ESTÁTICO — só para PDF (ver exportarPDF()/_finalizarExportacao)
  // ══════════════════════════════════════════════════════════════════════
  //
  // O QUE MUDA em relação a _gerarHtmlAfStandalone (acima): aquele gera um
  // HTML "vivo" — dados brutos em JSON + todas as funções de render
  // reembutidas via toString() + um <script> que roda tudo isso de novo
  // pra montar o DOM. Isso é o formato certo pro "🌐 Exportar Interativo"
  // (o arquivo precisa se virar sozinho, aberto direto no navegador de
  // alguém, com os cards de berço clicáveis). Mas pro PDF, o servidor
  // (lib/rotas/exportar-pdf.js) manda esse MESMO arquivo pesado pro
  // Chromium headless só pra ele reexecutar o script, montar o DOM e
  // imprimir — trabalho puro perdido, já que ninguém vai clicar em nada
  // num PDF. Os geradores abaixo fazem a MESMA renderização (reaproveitando
  // as mesmas funções _renderCabecalho/_renderBercos/etc., sem duplicar
  // lógica) só que AGORA, no navegador que já está com os dados carregados
  // — e mandam pro servidor só o resultado final: HTML puro, sem <script>,
  // sem JSON, só o markup + CSS. O Chromium do servidor não precisa
  // executar nada, só faz o "print" de um documento já pronto — bem mais
  // rápido, e mais leve na resposta enviada de volta.
  //
  // Interatividade (clique no berço, abrir fotos, badge de origem clicável
  // levando a outra operação): _renderBercos/_badgeOperacao/o botão de foto
  // já checam `typeof LWFocada !== 'undefined'` pra decidir se desenham a
  // versão clicável ou só o texto/visual equivalente (ver comentários
  // originais dessas funções) — como aqui rodamos DENTRO da própria tela
  // ao vivo, `LWFocada` SEMPRE existe (é este módulo). _gerarSecoesEstaticasAf,
  // abaixo, desliga `window.LWFocada` só durante a captura (repõe depois,
  // mesmo se algo lançar) pra essas funções caírem naturalmente na
  // variante não-clicável — sem precisar de nenhum parâmetro extra nelas.
  //
  // Seção "🖼️ Fotos Paletes" — REMOVIDA do export estático de PDF (pedido:
  // "não quero que as fotos sejam exportadas para o pdf [...] tanto nas
  // simples como na do dia e personalizada"). A avaliação de qualidade em
  // TEXTO continua saindo normalmente no PDF; só as imagens em si (base64,
  // pesadas) que não entram mais — quem quiser ver as fotos usa a tela ao
  // vivo ou o export interativo (botão 📷 de cada pallet, que abre
  // _abrirFotosPalletFocada em modal).

  // Renderiza as 4 seções da Análise Focada que entram no PDF
  // (Identificação/Berços/Receita/Avaliação) em elementos DESANEXADOS do
  // documento (nunca tocam a tela real) e devolve o innerHTML resultante
  // de cada uma, pronto pra colar num template estático. "Paradas" NÃO
  // entra mais no PDF (pedido: "quero um diff para tirar a section de
  // paradas nessa seção, isso também pode ficar de fora do pdf") — quem
  // quiser ver as paradas de uma operação usa a tela ao vivo ou o export
  // interativo, que continuam mostrando normalmente.
  // @returns {{cabecalho:string, bercos:string, receita:string, avaliacao:string, fotosPaletes:string}}
  function _gerarSecoesEstaticasAf(detalhe, paradasDaJanela) {
    const backupLWFocada = window.LWFocada;
    try {
      // Some com LWFocada só durante a captura — é o que faz _renderBercos/
      // _badgeOperacao/o botão de foto (ver comentário acima) desenharem a
      // versão SEM onclick, igual já fariam se este HTML fosse aberto fora
      // da tela ao vivo.
      delete window.LWFocada;

      const elCabecalho = document.createElement('div');
      const elBercos = document.createElement('div');
      const elReceita = document.createElement('div');
      const elAvaliacao = document.createElement('div');

      _renderCabecalho(detalhe.operacao || {}, elCabecalho);
      _renderBercos(detalhe.bercosVisuais, detalhe.operacao, elBercos);
      _renderReceita(detalhe.tracos, detalhe.bercosVisuais, elReceita);
      _renderAvaliacao(detalhe.avaliacao, elAvaliacao);

      return {
        cabecalho: elCabecalho.innerHTML,
        bercos: elBercos.innerHTML,
        receita: elReceita.innerHTML,
        avaliacao: elAvaliacao.innerHTML,
        // Fotos dos paletes NÃO entram no PDF (pedido: "não quero que as
        // fotos sejam exportadas para o pdf, [...] tanto nas simples como
        // na do dia e personalizada") — mantém o campo (sempre string
        // vazia) só pra não quebrar o formato do objeto que
        // _blocoOperacaoEstaticoPdf/os testes esperam.
        fotosPaletes: '',
      };
    } finally {
      // SEMPRE repõe, mesmo se alguma _render* acima lançar — nunca pode
      // sair desta função com a tela ao vivo sem LWFocada (quebraria todo
      // clique de berço/foto/navegação enquanto a pessoa continuar usando
      // a página).
      if (backupLWFocada !== undefined) window.LWFocada = backupLWFocada;
    }
  }

  // Bloco de UMA operação dentro do documento estático de PDF —
  // Identificação/Berços/Receita/Avaliação, já renderizadas em HTML puro.
  // @param {{cabecalho,bercos,receita,avaliacao,fotosPaletes}} secoes - ver _gerarSecoesEstaticasAf.
  function _blocoOperacaoEstaticoPdf(secoes) {
    // Seção "🖼️ Fotos Paletes" REMOVIDA do PDF (pedido: "não quero que as
    // fotos sejam exportadas para o pdf, pode deixar somente a avaliação
    // mesmo, sem colocar as fotos, tanto nas simples como na do dia e
    // personalizada") — a avaliação de qualidade em texto continua normal,
    // só as fotos em si (base64, pesadas) que somem do documento impresso.
    // Seção "🛑 Paradas Nesta Janela" TAMBÉM removida do PDF (mesmo
    // pedido, estendido às paradas) — segue disponível na tela ao vivo e
    // no export interativo.
    return `
      <div class="chart-box" style="margin-bottom:14px"><h4>Identificação</h4><div class="af-cabecalho-grid">${secoes.cabecalho}</div></div>
      <div class="chart-box" style="margin-bottom:14px"><h4>📍 Berços</h4><div>${secoes.bercos}</div></div>
      <div class="chart-box" style="margin-bottom:14px"><h4>🧪 Receita Utilizada</h4><div>${secoes.receita}</div></div>
      <div class="chart-box"><h4>✅ Avaliação de Qualidade</h4><div>${secoes.avaliacao}</div></div>`;
  }

  // ── Exportação Simples em PDF — documento estático de 1 operação só. ──
  // Mesmo cabeçalho/rodapé visual de _gerarHtmlAfStandalone, mas sem dados
  // embutidos (ver comentário no topo desta seção). Também precisa caber
  // inteira numa página só (mesmo pedido que já valia pro "Do Dia"/
  // "Personalizada": "eu quero que funcione para a simples também. A
  // simples também deve ficar apenas em uma página") — por isso reaproveita
  // o MESMO mecanismo de _gerarHtmlAfMultiplasEstaticoPdf
  // (.af-op-pagina/.af-op-conteudo-escala + _afScriptAjustePaginaUnica),
  // só que com o H1/sub (cabeçalho da própria página, não repetido por
  // operação) DENTRO de .af-op-pagina — e não fora, como no "Do Dia"/
  // "Personalizada" — pra tudo (cabeçalho + conteúdo) contar no cálculo
  // de espaço disponível e ficar garantidamente numa página física só, em
  // vez de o cabeçalho "empurrar" o conteúdo pra uma segunda folha.
  function _gerarHtmlAfEstaticoPdf(detalhe, paradasDaJanela = []) {
    const secoes = _gerarSecoesEstaticasAf(detalhe, paradasDaJanela);
    const idOperacao = LW.escaparHtml(String(detalhe.operacao?.id || ''));
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Análise Focada — ${idOperacao} — Exportado</title>
<style>${LW.gerarCssExportPadrao()}${_afCssComum()}${_afCssImpressaoPdf()}</style>
${_afScriptFlagInicial()}
</head>
<body>
  <div class="af-op-pagina">
    <h1>🔎 Análise Focada — Operação ${idOperacao}</h1>
    <div class="sub">Gerado em ${new Date().toLocaleString('pt-BR')}</div>
    <div class="af-op-conteudo-escala">
      ${_blocoOperacaoEstaticoPdf(secoes)}
    </div>
  </div>
  <div class="rodape">Exportado da Análise Focada — Lightwall SC · versão estática para impressão em PDF.</div>
${_afScriptAjustePaginaUnica()}
</body>
</html>`;
  }

  // ── Exportação "Do Dia"/"Personalizada" em PDF — MESMA ideia que
  // _gerarHtmlAfMultiplas (abaixo, usada pelo formato HTML interativo),
  // só que empilhando os blocos ESTÁTICOS de cada operação direto na
  // página (sem <iframe> — mas COM um <script> pequeno de auto-ajuste de
  // ESCALA, ver _afScriptAjustePaginaUnica: cada operação não só começa
  // numa página nova (`break-before:page`, ver _afCssImpressaoPdf), como
  // é ENCOLHIDA o quanto for preciso pra caber inteira nessa página só,
  // sem vazar pro início da próxima).
  // @param {string} tituloPagina - vai na <title>.
  // @param {string} tituloH1 - cabeçalho grande no topo.
  // @param {string} subLabel - linha pequena abaixo do H1.
  // @param {Array<{id, label, secoes}>} itens - uma entrada por operação, `secoes` já vinda de _gerarSecoesEstaticasAf.
  function _gerarHtmlAfMultiplasEstaticoPdf(tituloPagina, tituloH1, subLabel, itens) {
    // BUG CORRIGIDO: h1/.sub viviam soltos no <body>, ANTES da primeira
    // .af-op-pagina — fora do fluxo de paginação que o CSS controla (ver
    // `.af-op-pagina + .af-op-pagina { break-before:page }` em
    // _afCssImpressaoPdf: só entra em jogo entre DUAS .af-op-pagina
    // consecutivas, nunca antes da primeira). Resultado: o cabeçalho
    // dividia a página física 1 com a Operação 1 (que precisa dos 287mm
    // inteiros pra caber, ver _AF_PDF_ALTURA_PAGINA_MM), empurrando-a
    // inteira pra página física 2 — sobrando 1 página física a mais do
    // que `.af-op-pagina` elementos no DOM. Como o total de páginas
    // reportado ao servidor (`__afReportarProgresso`, ver
    // _afScriptAjustePaginaUnica) conta ELEMENTOS `.af-op-pagina` (não
    // páginas físicas), o `pageRanges` do Puppeteer (exportar-pdf.js)
    // imprimia só as N primeiras páginas físicas — cortando a ÚLTIMA
    // operação inteira do PDF final.
    // CORREÇÃO: embutir o cabeçalho DENTRO da primeira .af-op-pagina (só
    // nela), antes de .af-op-titulo. Assim ele passa a fazer parte da
    // MESMA página física da Operação 1, sem criar uma página física
    // extra fora da contagem — 1 .af-op-pagina continua sendo,
    // garantidamente, 1 página física, para todas as operações,
    // inclusive a primeira.
    // Efeito colateral desejável: como .af-op-pagina tem
    // position:relative e o cálculo de espaço disponível em
    // _afScriptAjustePaginaUnica é `pagina.clientHeight -
    // conteudo.offsetTop` (offsetTop relativo à própria .af-op-pagina),
    // a altura ocupada pelo cabeçalho na primeira página passa a ser
    // descontada automaticamente do espaço livre pro conteúdo da
    // Operação 1 — sem precisar tocar em nada daquele script.
    const cabecalhoGlobal = `
        <h1>${tituloH1}</h1>
        <div class="sub">Gerado em ${new Date().toLocaleString('pt-BR')} · ${LW.escaparHtml(subLabel)}</div>`;

    const blocos = itens.map((it, i) => `
      <div class="af-op-pagina">${i === 0 ? cabecalhoGlobal : ''}
        <div class="af-op-titulo" style="font-size:.78rem;color:var(--text-3);margin-bottom:8px">Operação ${i + 1} de ${itens.length} · ${LW.escaparHtml(it.label)}</div>
        <div class="af-op-conteudo-escala">
          ${_blocoOperacaoEstaticoPdf(it.secoes)}
        </div>
      </div>`).join('');

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${LW.escaparHtml(tituloPagina)}</title>
<style>${LW.gerarCssExportPadrao()}${_afCssComum()}${_afCssImpressaoPdf()}</style>
${_afScriptFlagInicial()}
</head>
<body>
  ${blocos}
  <div class="rodape">Exportado da Análise Focada — Lightwall SC · versão estática para impressão em PDF.</div>
${_afScriptAjustePaginaUnica()}
</body>
</html>`;
  }

  // ── Página "casca" que empilha um <iframe> por operação — motor comum
  // por trás de "Do Dia" e "Personalizada" (só muda o título/rótulo de
  // cada uma, ver _gerarHtmlAfDoDia/_gerarHtmlAfPersonalizado, abaixo).
  // Cada <iframe> recebe, via .srcdoc, o MESMO HTML autossuficiente que
  // _gerarHtmlAfStandalone gera pra Exportação Simples, com um índice no
  // topo pra pular direto pra qualquer operação. Cada iframe se
  // auto-ajusta de altura no load (mede o scrollHeight do documento de
  // dentro) — sem isso ficaria com scroll interno, quebrando a ideia de
  // "uma embaixo da outra" numa página só.
  // @param {string} tituloPagina - vai na <title> da aba do navegador.
  // @param {string} tituloH1 - cabeçalho grande no topo da página (já em HTML, não escapado de novo).
  // @param {string} subLabel - linha pequena abaixo do H1 (ex: "3 operações neste dia").
  // @param {Array<{id,label,html}>} itens - uma entrada por operação (ver chamadas abaixo).
  function _gerarHtmlAfMultiplas(tituloPagina, tituloH1, subLabel, itens) {
    // As strings de cada operação já têm <script> internos (ver
    // _gerarHtmlAfStandalone) — mesma proteção contra fechar o <script>
    // externo cedo demais já usada lá pros blobs de dados.
    const itensJson = JSON.stringify(itens.map(it => it.html)).replace(/<\/script/gi, '<\\/script');

    const indice = itens.map((it, i) => `
      <a href="#op-${i}" style="display:block;padding:8px 12px;border-radius:var(--radius);color:var(--text-2);text-decoration:none;font-size:.82rem;border:1px solid var(--border);margin-bottom:6px">
        <strong style="color:var(--text)">${String(i + 1).padStart(2, '0')}.</strong>
        ${LW.escaparHtml(it.label)}
      </a>`).join('');

    const secoes = itens.map((it, i) => `
      <div class="af-op-section" id="op-${i}" style="margin-bottom:32px;scroll-margin-top:16px">
        <div style="font-size:.78rem;color:var(--text-3);margin-bottom:8px">Operação ${i + 1} de ${itens.length} · ${LW.escaparHtml(it.label)}</div>
        <iframe id="af-frame-${i}" title="Análise Focada — ${LW.escaparHtml(it.label)}"
          style="width:100%;border:1px solid var(--border);border-radius:var(--radius-lg);display:block;background:transparent"
          scrolling="no"></iframe>
      </div>`).join(itens.length > 1 ? '<hr style="border:none;border-top:1px solid var(--border);margin:8px 0 32px">' : '');

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${LW.escaparHtml(tituloPagina)}</title>
<style>${LW.gerarCssExportPadrao()}
  .af-indice { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:0; margin-bottom:24px; }
</style>
</head>
<body>
  <h1>${tituloH1}</h1>
  <div class="sub">Gerado em ${new Date().toLocaleString('pt-BR')} · ${LW.escaparHtml(subLabel)}</div>

  <div class="chart-box" style="margin-bottom:24px">
    <h4>Índice</h4>
    <div class="af-indice">${indice}</div>
  </div>

  ${secoes}

  <div class="rodape">Exportado da Análise Focada — Lightwall SC · dados embutidos neste arquivo, funciona offline. Cada bloco acima é o mesmo arquivo que sairia pela Exportação Simples daquela operação.</div>

<script>
(function () {
  'use strict';
  const HTMLS = ${itensJson};
  HTMLS.forEach(function (html, i) {
    const frame = document.getElementById('af-frame-' + i);
    if (!frame) return;
    frame.addEventListener('load', function () {
      try {
        const doc = frame.contentWindow.document;
        const altura = Math.max(doc.documentElement.scrollHeight, doc.body ? doc.body.scrollHeight : 0);
        frame.style.height = (altura + 24) + 'px';
      } catch (e) { frame.style.height = '600px'; }
    });
    frame.srcdoc = html;
  });
})();
</script>
</body>
</html>`;
  }

  // ── Página "casca" da exportação "Do Dia" — 1 dia só. ──────────────
  function _gerarHtmlAfDoDia(dataISO, itens) {
    const dataFmt = _fmtData(dataISO);
    return _gerarHtmlAfMultiplas(
      `Análise Focada — Dia ${dataFmt} — Exportado`,
      `🔎 Análise Focada — Todas as Operações do Dia ${LW.escaparHtml(dataFmt)}`,
      `${itens.length} operaç${itens.length === 1 ? 'ão' : 'ões'} neste dia`,
      itens
    );
  }

  // ── Página "casca" da exportação "Personalizada" — intervalo de datas
  // (ver _escolherRangeDatas/_exportarPersonalizado, acima). Quando
  // dataInicio === dataFim (a pessoa escolheu só 1 dia mesmo na tela de
  // período), mostra só a data uma vez em vez de "X a X", que ficaria
  // estranho repetido.
  function _gerarHtmlAfPersonalizado(dataInicio, dataFim, itens) {
    const fmtIni = _fmtData(dataInicio);
    const fmtFim = _fmtData(dataFim);
    const periodoLabel = dataInicio === dataFim ? fmtIni : `${fmtIni} a ${fmtFim}`;
    return _gerarHtmlAfMultiplas(
      `Análise Focada — ${periodoLabel} — Exportado`,
      `🔎 Análise Focada — Operações de ${LW.escaparHtml(periodoLabel)}`,
      `${itens.length} operaç${itens.length === 1 ? 'ão' : 'ões'} neste período`,
      itens
    );
  }

  function init() {
    render();
  }

  window.LWFocada = {
    abrir, abrirBusca, buscar, voltar, init, render, exportarInterativo, exportarPDF,
    abrirDetalhesBerco, abrirFotosPallet: _abrirFotosPalletFocada,
    fmtHora: _fmtHora, totalPorPallet: _totalPorPallet,
    // Expostos só pra teste (ver test/analise-focada-pdf-pagina-unica.test.js)
    // — o mecanismo de "cada análise cabe em 1 página só" no PDF de
    // "Do Dia"/"Personalizada" (_gerarHtmlAfMultiplasEstaticoPdf,
    // _afScriptAjustePaginaUnica) não tem nenhuma outra forma de ser
    // verificado automaticamente sem um Chromium real rodando (ver
    // comentário no topo desses arquivos), então testamos a lógica de
    // escala e a estrutura do HTML gerado diretamente.
    gerarHtmlMultiplasPdf: _gerarHtmlAfMultiplasEstaticoPdf,
    scriptAjustePaginaUnica: _afScriptAjustePaginaUnica,
    scriptFlagInicial: _afScriptFlagInicial,
  };
})();