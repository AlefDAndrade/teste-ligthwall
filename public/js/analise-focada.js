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

    const podeAbrirDetalhes = typeof LWFocada !== 'undefined';

    el.innerHTML = `<div class="ba-grid">${ordenados.map(b => {
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
  function _renderReceita(tracos, bercosVisuais) {
    const el = document.getElementById('af-receita');
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

  function _renderParadas(paradas) {
    const el = document.getElementById('af-paradas');
    if (!el) return;
    // Contador ao lado do título — visível mesmo com o <details> fechado,
    // pra dar uma pista do que tem lá dentro sem precisar expandir.
    const contagem = document.getElementById('af-paradas-contagem');
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

  function _renderAvaliacao(avaliacao) {
    const el = document.getElementById('af-avaliacao');
    if (!el) return;
    if (!avaliacao) {
      el.innerHTML = `<div class="sq-empty-af"><i class="fas fa-inbox"></i> Bateria sem avaliação.</div>`;
      return;
    }
    const montagem = avaliacao.montagem || {};
    const paineis = avaliacao.paineis || [];

    let html = '<div class="af-paineis-grid">';
    // Ordem visual pedida: Pallet 2/Pallet 1 na 1ª linha, Pallet 3/Pallet 4
    // na 2ª (layout 2x2) — só a ORDEM DE EXIBIÇÃO muda; os dados de cada
    // pallet continuam vindo do mesmo número de sempre (avaliacao.paineis,
    // montagem['palletN']), sem nenhuma outra mudança.
    [2, 1, 3, 4].forEach(p => {
      // Tipo de montagem daquele pallet — "no cantinho", cabeçalho do
      // próprio card do pallet, não em cada painel individual.
      const tipoMontPallet = montagem['pallet' + p] || '—';
      const totalPorPallet = _totalPorPallet(paineis, p); // cada palete com a contagem DELE, não uma média/fixo compartilhado
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
    });
    html += '</div>';
    el.innerHTML = html;
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
  // teclado, ver keyboard-shortcuts.js) — pergunta ao usuário qual das 2
  // exportações ele quer e delega pra _exportarSimples/_exportarDoDia,
  // abaixo. Mantido com este mesmo nome pra não quebrar quem já chama
  // LWFocada.exportarInterativo() de fora.
  async function exportarInterativo() {
    // Antes saía de cara se não houvesse operação carregada (_idAtual),
    // deixando o botão parecendo morto mesmo pra quem só queria "Do Dia"
    // (que nem depende de operação selecionada — roda em cima de uma data
    // escolhida no calendário). Agora o botão sempre abre o menu de
    // escolha; só a opção "Simples" (que exporta A operação atual) exige
    // _idAtual, e avisa em vez de falhar em silêncio.
    const escolha = await LW.mostrarEscolha(
      'Como você quer exportar esta Análise Focada?',
      {
        titulo: '🌐 Exportar Interativo',
        icon: '🌐',
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
      await _exportarSimples();
      return;
    }
    if (escolha === 'personalizada') {
      // Mesma data sugerida de "Do Dia" (a da operação aberta), usada
      // como ponto de partida pros DOIS campos (De/Até) — quem só quer 1
      // dia específico não precisa mexer em nada além de trocar o "Até".
      const dataSugerida = _ultimoDetalhe?.operacao?.data || '';
      const periodo = await _escolherRangeDatas(dataSugerida);
      if (!periodo) return;
      await _exportarPersonalizado(periodo.inicio, periodo.fim);
      return;
    }
    // "Do Dia" pede a data ANTES de exportar — sugere a data da operação
    // atualmente aberta (_ultimoDetalhe, preenchido por render()), mas o
    // usuário pode trocar livremente pelo calendário do <input type="date">.
    const dataSugerida = _ultimoDetalhe?.operacao?.data || '';
    const dataEscolhida = await _escolherDataDoDia(dataSugerida);
    if (!dataEscolhida) return;
    await _exportarDoDia(dataEscolhida);
  }

  // ── Exportação Simples — comportamento original: só a operação atual. ──
  async function _exportarSimples() {
    const btn = document.getElementById('btn-af-exportar');
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando…'; }
    try {
      const [detalhe] = await Promise.all([LW.getDetalheOperacao(_idAtual), _carregarCaches()]);
      if (!detalhe) { if (LW.mostrarAlerta) LW.mostrarAlerta('Não consegui carregar os dados desta operação.', { tipo: 'erro' }); return; }
      _anotarOrigemEReaproveitamento(detalhe.tracos, _idAtual);
      const paradasDaJanela = _paradasNaJanela(_cacheParadas, detalhe.operacao?.inicio, detalhe.operacao?.fim);
      const html = _gerarHtmlAfStandalone(detalhe, paradasDaJanela);
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

  // ── Modal de escolha de data pra Exportação "Do Dia" — um <input
  // type="date"> nativo (mesmo padrão de campo de data já usado no resto
  // do app — ver page-registro.html, page-oee.html etc.), que abre o
  // calendário do próprio navegador/SO. Pré-preenchido com `dataSugerida`
  // (a data da operação que estava aberta), mas 100% editável.
  // @param {string} dataSugerida - 'YYYY-MM-DD' ou '' se não houver uma óbvia.
  // @returns {Promise<string|null>} 'YYYY-MM-DD' escolhida, ou null se cancelado (Cancelar, Esc ou clique fora).
  function _escolherDataDoDia(dataSugerida) {
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
            style="width:100%;margin-bottom:24px;text-align:center;font-size:1rem;padding:10px">
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

      const fechar = (resultado) => {
        modal.remove();
        document.removeEventListener('keydown', onKeydown);
        resolve(resultado);
      };
      const onKeydown = (e) => {
        if (e.key === 'Escape') fechar(null);
        if (e.key === 'Enter') fechar(input.value || null);
      };

      document.getElementById('af-data-dia-confirmar').addEventListener('click', () => fechar(input.value || null));
      document.getElementById('af-data-dia-cancelar').addEventListener('click', () => fechar(null));
      modal.addEventListener('click', (e) => { if (e.target === modal) fechar(null); });
      document.addEventListener('keydown', onKeydown);
      input.focus();
    });
  }

  // ── Modal de escolha de PERÍODO (De/Até) pra Exportação "Personalizada"
  // — mesmo padrão visual de _escolherDataDoDia (acima), só com 2 <input
  // type="date"> lado a lado em vez de 1. Os dois vêm pré-preenchidos com
  // `dataSugerida` (a data da operação que estava aberta) — quem só quer
  // 1 dia específico só troca o "Até" (ou nem mexe, se já for hoje).
  // @param {string} dataSugerida - 'YYYY-MM-DD' ou '' se não houver uma óbvia.
  // @returns {Promise<{inicio:string,fim:string}|null>} - null se cancelado (Cancelar, Esc ou clique fora).
  function _escolherRangeDatas(dataSugerida) {
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

      document.getElementById('af-range-confirmar').addEventListener('click', confirmar);
      document.getElementById('af-range-cancelar').addEventListener('click', () => fechar(null));
      modal.addEventListener('click', (e) => { if (e.target === modal) fechar(null); });
      document.addEventListener('keydown', onKeydown);
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
  async function _exportarDoDia(dataAlvo) {
    const btn = document.getElementById('btn-af-exportar');
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando…'; }
    try {
      await _carregarCaches();

      const opsDoDia = _cacheHistorico
        .filter(op => op.data === dataAlvo)
        .sort((a, b) => (a.inicio || '').localeCompare(b.inicio || ''));

      if (!opsDoDia.length) { if (LW.mostrarAlerta) LW.mostrarAlerta(`Não encontrei nenhuma operação em ${_fmtData(dataAlvo)}.`, { tipo: 'erro' }); return; }

      const detalhesDetalhados = await Promise.all(opsDoDia.map(async op => {
        const detalhe = await LW.getDetalheOperacao(op.id);
        return { op, detalhe };
      }));

      const itens = detalhesDetalhados
        .filter(({ detalhe }) => !!detalhe)
        .map(({ op, detalhe }) => {
          _anotarOrigemEReaproveitamento(detalhe.tracos, op.id);
          const paradasDaJanela = _paradasNaJanela(_cacheParadas, detalhe.operacao?.inicio, detalhe.operacao?.fim);
          return {
            id: detalhe.operacao?.id || op.id,
            label: `${detalhe.operacao?.id_bateria || '—'} · ${_fmtHora(detalhe.operacao?.inicio)} — ${_fmtHora(detalhe.operacao?.fim)} · ${detalhe.operacao?.turno || '—'}`,
            html: _gerarHtmlAfStandalone(detalhe, paradasDaJanela),
          };
        });

      if (!itens.length) { if (LW.mostrarAlerta) LW.mostrarAlerta('Não consegui carregar os dados das operações deste dia.', { tipo: 'erro' }); return; }

      const html = _gerarHtmlAfDoDia(dataAlvo, itens);
      LW.baixarArquivoTexto(
        `analise_focada_dia_${String(dataAlvo || 'data').replace(/[^a-zA-Z0-9_-]/g, '_')}.html`,
        html
      );
    } catch (err) {
      console.error('Falha ao exportar Análise Focada do Dia:', err);
      if (LW.mostrarAlerta) LW.mostrarAlerta('Não consegui gerar o arquivo agora.', { tipo: 'erro' });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🌐 Exportar Interativo'; }
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
  async function _exportarPersonalizado(dataInicio, dataFim) {
    const btn = document.getElementById('btn-af-exportar');
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando…'; }
    try {
      await _carregarCaches();

      const opsDoPeriodo = _cacheHistorico
        .filter(op => op.data >= dataInicio && op.data <= dataFim)
        .sort((a, b) => (a.data === b.data) ? (a.inicio || '').localeCompare(b.inicio || '') : a.data.localeCompare(b.data));

      if (!opsDoPeriodo.length) { if (LW.mostrarAlerta) LW.mostrarAlerta(`Não encontrei nenhuma operação entre ${_fmtData(dataInicio)} e ${_fmtData(dataFim)}.`, { tipo: 'erro' }); return; }

      const detalhesDetalhados = await Promise.all(opsDoPeriodo.map(async op => {
        const detalhe = await LW.getDetalheOperacao(op.id);
        return { op, detalhe };
      }));

      const itens = detalhesDetalhados
        .filter(({ detalhe }) => !!detalhe)
        .map(({ op, detalhe }) => {
          _anotarOrigemEReaproveitamento(detalhe.tracos, op.id);
          const paradasDaJanela = _paradasNaJanela(_cacheParadas, detalhe.operacao?.inicio, detalhe.operacao?.fim);
          return {
            id: detalhe.operacao?.id || op.id,
            label: `${_fmtData(detalhe.operacao?.data)} · ${detalhe.operacao?.id_bateria || '—'} · ${_fmtHora(detalhe.operacao?.inicio)} — ${_fmtHora(detalhe.operacao?.fim)} · ${detalhe.operacao?.turno || '—'}`,
            html: _gerarHtmlAfStandalone(detalhe, paradasDaJanela),
          };
        });

      if (!itens.length) { if (LW.mostrarAlerta) LW.mostrarAlerta('Não consegui carregar os dados das operações deste período.', { tipo: 'erro' }); return; }

      const html = _gerarHtmlAfPersonalizado(dataInicio, dataFim, itens);
      LW.baixarArquivoTexto(
        `analise_focada_${String(dataInicio).replace(/[^a-zA-Z0-9_-]/g, '_')}_a_${String(dataFim).replace(/[^a-zA-Z0-9_-]/g, '_')}.html`,
        html
      );
    } catch (err) {
      console.error('Falha ao exportar Análise Focada Personalizada:', err);
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

  function _gerarHtmlAfStandalone(detalhe, paradasDaJanela = []) {
    const detalheJson = JSON.stringify(detalhe).replace(/<\/script/gi, '<\\/script');
    const paradasJson = JSON.stringify(paradasDaJanela).replace(/<\/script/gi, '<\\/script');

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
  .af-traco-origem-linha { margin-top:10px; font-size:.8rem; color:var(--text-2); display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
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
</style>
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
  ${_badgeOperacao}
  ${_bercosEnchidosDoTraco}
  ${_calcularResumoTracos}
  ${_renderResumoTracos}
  ${_fmtLeitura}
  ${_renderReceita}
  ${_renderParadas}
  ${_labelPainel}
  ${_corPainel}
  ${_renderAvaliacao}

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

  window.LWFocada = { abrir, abrirBusca, buscar, voltar, init, render, exportarInterativo, abrirDetalhesBerco, fmtHora: _fmtHora, totalPorPallet: _totalPorPallet };
})();