// ============================================================
//  ONE PAGE REPORT LW SC
//  Fase 5 do plano (ver README, "Nova página: One Page Report
//  (planejamento)") — só a parte VISUAL desta tela.
//
//  MOCK_DADOS abaixo é o único lugar que vai mudar quando as Fases
//  1-4 existirem: no lugar de retornar o objeto fixo, `carregarDados()`
//  passa a fazer `fetch('/db/one-page-report.json?mes=...')` (endpoint
//  agregador da Fase 4, que por sua vez junta lib/db/seguranca-
//  ocorrencias.js, lib/db/expedicao.js e lib/db/one-page-comentarios.js
//  com os dados de produção/refugo/traços que já existem hoje). O
//  resto do arquivo (render, gráficos SVG) não muda nada.
//
//  Onde não há dado real ainda (hoje: TUDO, já que as Fases 1-4 não
//  existem), a tela mostra um aviso "dados de exemplo" — nunca finge
//  que um número inventado é um dado real (mesma regra combinada em
//  todas as fases do plano, ver README).
// ============================================================
'use strict';

(function () {

  function _escaparHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }

  function _escaparAtributo(str) {
    return _escaparHtml(str).replace(/"/g, '&quot;');
  }

  function _fmtNum(v, casas = 0) {
    return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
  }

  /* ── Gráficos SVG próprios ────────────────────────────────
     Mesma técnica de public/js/setor-qualidade.js
     (_svgBarChart/_svgHBarChart/_svgDonutChart) — reimplementados
     aqui (não importados) porque lá são funções privadas da IIFE
     daquele arquivo, e porque esta tela usa a paleta --opr-* (fixa,
     branca) em vez de var(--blue)/var(--red) do tema do app (ver
     comentário no topo de one-page-report.css). */

  const SVG_W = 460, SVG_H = 150;

  function _oprBarChart(labels, values, opts = {}) {
    const w = SVG_W, h = SVG_H, padL = 22, padR = 8, padT = 10, padB = 22;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const max = opts.max || Math.max(1, ...values);
    const n = labels.length || 1;
    const gap = (plotW / n) * 0.35;
    const barW = (plotW / n) - gap;
    const color = opts.color || 'var(--opr-blue)';
    const suffix = opts.suffix || '';
    const bars = labels.map((lb, i) => {
      const v = values[i] || 0;
      const bh = max ? (v / max) * plotH : 0;
      const x = padL + i * (plotW / n) + gap / 2;
      const y = padT + plotH - bh;
      const corBarra = (opts.colors && opts.colors[i]) || color;
      const mostrarLabel = n <= 12 || i === 0 || i === n - 1 || i % Math.ceil(n / 10) === 0;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(barW, 1).toFixed(1)}" height="${Math.max(bh, 0).toFixed(1)}" rx="1.5" fill="${corBarra}" data-tooltip="${_escaparAtributo(String(lb))}: ${v}${suffix}"/>` +
        (mostrarLabel ? `<text x="${(x + barW / 2).toFixed(1)}" y="${h - 6}" font-size="7" fill="var(--opr-text-3)" text-anchor="middle">${_escaparHtml(String(lb))}</text>` : '');
    }).join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${opts.height || 110}" preserveAspectRatio="xMidYMid meet">
      <line x1="${padL}" y1="${(padT + plotH).toFixed(1)}" x2="${w - padR}" y2="${(padT + plotH).toFixed(1)}" stroke="var(--opr-border)" stroke-width="1"/>
      ${bars}
    </svg>`;
  }

  function _oprDonut(items, opts = {}) {
    const total = items.reduce((s, it) => s + it.value, 0) || 1;
    const r = 46, cx = 60, cy = 60, strokeW = 20, circ = 2 * Math.PI * r;
    let acc = 0;
    const arcs = items.map(it => {
      const frac = it.value / total;
      const dash = frac * circ;
      const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${it.color}" stroke-width="${strokeW}"
        stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-dashoffset="${(-acc * circ).toFixed(2)}"
        transform="rotate(-90 ${cx} ${cy})" data-tooltip="${_escaparAtributo(it.label)}: ${_fmtNum(it.value, opts.casas || 0)}${opts.suffix || ''} (${(frac * 100).toFixed(1)}%)"/>`;
      acc += frac;
      return el;
    }).join('');
    const centroLabel = opts.centro || '';
    return `<svg viewBox="0 0 120 120" width="108" height="108">
      ${arcs}
      ${centroLabel ? `<text x="60" y="56" font-size="12" font-weight="700" fill="var(--opr-navy)" text-anchor="middle">${_escaparHtml(centroLabel.valor)}</text>
      <text x="60" y="68" font-size="6.5" fill="var(--opr-text-3)" text-anchor="middle">${_escaparHtml(centroLabel.legenda || '')}</text>` : ''}
    </svg>`;
  }

  function _oprDonutLegenda(items) {
    return items.map(it => `
      <div class="opr-donut-legend-item">
        <span class="opr-donut-dot" style="background:${it.color}"></span>
        ${_escaparHtml(it.label)} <span style="color:var(--opr-text-3)">(${_fmtNum(it.value)})</span>
      </div>`).join('');
  }

  function _oprIndisponivel(msg) {
    return `<div class="opr-indisponivel">
      <span class="opr-indisponivel-icon">📭</span>
      <span>${_escaparHtml(msg || 'Dado indisponível')}</span>
    </div>`;
  }

  function _oprComentarios(comentarios, proximosPassos) {
    const li = (arr) => (arr && arr.length)
      ? `<ul>${arr.map(c => `<li>${_escaparHtml(c)}</li>`).join('')}</ul>`
      : `<div style="color:var(--opr-text-3)">—</div>`;
    return `
      <div class="opr-comments-heading">Comentários</div>
      ${li(comentarios)}
      <div class="opr-comments-heading" style="margin-top:2px">Próximos passos</div>
      ${li(proximosPassos)}
    `;
  }

  /* ── MOCK_DADOS ────────────────────────────────────────────
     Números de exemplo (mesma ordem de grandeza do modelo de
     referência), só para validar o layout. Trocar por fetch real
     assim que a Fase 4 (endpoint agregador) existir — ver
     carregarDados() logo abaixo. */
  function _diasUteis(n) {
    return Array.from({ length: n }, (_, i) => String(i + 1));
  }

  function MOCK_DADOS() {
    const dias = _diasUteis(22);
    const ocorrencias = dias.map(() => 0);
    ocorrencias[6] = 1; // um único dia com ocorrência, igual ao modelo de referência

    const bateriasL1 = [4, 5, 6, 5, 4, 5, 6, 5, 4, 5, 6, 6, 5, 4, 5, 6, 5, 4, 5, 6, 6, 5];
    const refugoPct = [0, 2, 49.4, 42.5, 29, 1.3, 4, 3, 1.2, 3.4, 0, 0, 2.5, 2.6, 3.3, 2.7, 1, 4.4, 0, 1.8, 2.1, 0.9];
    const expedicaoM2 = [0, 7.32, 527.04, 230.58, 109.8, 0, 0, 1257.21, 966.24, 603.9, 878.4, 0, 0, 340.1, 512.6, 0, 690.2, 0, 0, 210.5, 0, 0];

    return {
      mes: '2026-08',
      mesReferencia: 'Agosto/2026',
      seguranca: {
        disponivel: true,
        acumuladoMes: 1,
        diasSemAcidentes: 13,
        ocorrenciasPorDia: { labels: dias, values: ocorrencias },
        comentarios: [],
        proximosPassos: [],
      },
      producao: {
        disponivel: true,
        bateriasPorDia: { labels: dias, values: bateriasL1 },
        distribuicaoLinha: [
          { label: 'L1', value: 6237, color: 'var(--opr-blue)' },
          { label: 'L2', value: 0, color: 'var(--opr-border)' },
        ],
        totalM2: 6237,
        comentarios: [],
        proximosPassos: [],
      },
      refugo: {
        disponivel: true,
        refugoDiarioPct: { labels: dias, values: refugoPct },
        totalPct: 9.3,
        tracosPorLinha: [{ linha: 'L1', valor: 2.27 }],
        comentarios: [],
        proximosPassos: [],
      },
      expedicao: {
        disponivel: true,
        expedicaoPorDia: { labels: dias, values: expedicaoM2 },
        cargasPorSemana: { labels: ['S1', 'S2', 'S3', 'S4'], values: [0, 1, 3, 11] },
        acumuladoM2: 4580.49,
        acumuladoCargas: 15,
        comentarios: ['878,40m² cliente MAKAI', 'Total expedidos: 878,40m²', 'Forecast: 7.015m²'],
        proximosPassos: ['Carga confirmada para o cliente MAKAI'],
      },
      assuntosGerais: { texto: '', fotos: [] },
    };
  }

  // `periodo` é opcional — `{tipo:'mes', mes}`, `{tipo:'todos'}` ou
  // `{tipo:'range', inicio, fim}` (mesmo shape que o endpoint devolve em
  // `dados.periodo`, ver lib/rotas/one-page-report.js). Sem ele (ou com
  // `tipo:'mes'` sem `mes`), o endpoint já cai sozinho no mês corrente do
  // servidor — é o que faz o primeiro carregamento da tela continuar
  // funcionando sem nenhum parâmetro, igual sempre foi.
  function _urlDoPeriodo(periodo) {
    if (!periodo) return '/db/one-page-report.json';
    if (periodo.tipo === 'todos') return '/db/one-page-report.json?periodo=todos';
    if (periodo.tipo === 'range' && periodo.inicio && periodo.fim) {
      return `/db/one-page-report.json?periodo=range&inicio=${encodeURIComponent(periodo.inicio)}&fim=${encodeURIComponent(periodo.fim)}`;
    }
    if (periodo.tipo === 'mes' && periodo.mes) {
      return `/db/one-page-report.json?mes=${encodeURIComponent(periodo.mes)}`;
    }
    return '/db/one-page-report.json';
  }

  async function carregarDados(periodo) {
    // Fase 4 concluída — endpoint agregador real (lib/rotas/one-page-
    // report.js). MOCK_DADOS (acima) fica só como referência/fallback se
    // o fetch falhar (rede fora do ar etc.), pra tela nunca quebrar em
    // branco — mesmo espírito de "nunca mostrar erro cru pro usuário" do
    // resto do app.
    try {
      const r = await fetch(_urlDoPeriodo(periodo));
      if (r.ok) return await r.json();
    } catch (_) { /* cai no mock abaixo */ }
    return MOCK_DADOS();
  }

  /* ── Render de cada bloco ─────────────────────────────────── */

  function _renderSeguranca(d) {
    if (!d || !d.disponivel) {
      document.getElementById('opr-seg-chart').innerHTML = _oprIndisponivel('Ocorrências ainda não registradas — Fase 1 do plano.');
      document.getElementById('opr-seg-comentarios').innerHTML = _oprComentarios([], []);
      return;
    }
    document.getElementById('opr-seg-acumulado').textContent = d.acumuladoMes;
    document.getElementById('opr-seg-dias').textContent = d.diasSemAcidentes;
    document.getElementById('opr-seg-chart').innerHTML = _oprBarChart(
      d.ocorrenciasPorDia.labels, d.ocorrenciasPorDia.values, { color: 'var(--opr-blue-2)' }
    );
    document.getElementById('opr-seg-comentarios').innerHTML = _oprComentarios(d.comentarios, d.proximosPassos);
  }

  function _renderProducao(d) {
    if (!d || !d.disponivel) {
      document.getElementById('opr-prod-chart').innerHTML = _oprIndisponivel('Sem produção lançada no período.');
      document.getElementById('opr-prod-donut').innerHTML = '';
      document.getElementById('opr-prod-comentarios').innerHTML = _oprComentarios([], []);
      return;
    }
    document.getElementById('opr-prod-chart').innerHTML = _oprBarChart(
      d.bateriasPorDia.labels, d.bateriasPorDia.values, { color: 'var(--opr-blue)' }
    );
    document.getElementById('opr-prod-donut').innerHTML =
      _oprDonut(d.distribuicaoLinha, { centro: { valor: _fmtNum(d.totalM2), legenda: 'TOTAL' } }) +
      `<div class="opr-donut-legend">${_oprDonutLegenda(d.distribuicaoLinha)}</div>`;
    document.getElementById('opr-prod-comentarios').innerHTML = _oprComentarios(d.comentarios, d.proximosPassos);
  }

  function _renderRefugo(d) {
    if (!d || !d.disponivel) {
      document.getElementById('opr-ref-chart').innerHTML = _oprIndisponivel('Sem avaliações de refugo no período.');
      document.getElementById('opr-ref-donut').innerHTML = '';
      document.getElementById('opr-ref-tracos').innerHTML = '';
      document.getElementById('opr-ref-comentarios').innerHTML = _oprComentarios([], []);
      return;
    }
    document.getElementById('opr-ref-chart').innerHTML = _oprBarChart(
      d.refugoDiarioPct.labels, d.refugoDiarioPct.values, { color: 'var(--opr-orange)', suffix: '%' }
    );
    const donutItems = [
      { label: 'Refugo', value: d.totalPct, color: 'var(--opr-orange)' },
      { label: 'Aprovado', value: Math.max(0, 100 - d.totalPct), color: 'var(--opr-blue)' },
    ];
    document.getElementById('opr-ref-donut').innerHTML =
      _oprDonut(donutItems, { centro: { valor: d.totalPct.toFixed(1).replace('.', ',') + '%', legenda: 'TOTAL' } }) +
      `<div class="opr-donut-legend">${_oprDonutLegenda(donutItems)}</div>`;
    document.getElementById('opr-ref-tracos').innerHTML = d.tracosPorLinha.map(t => `
      <div class="opr-kv-row">
        <div class="opr-kv-key">${_escaparHtml(t.linha)}</div>
        <div class="opr-kv-val">${t.valor.toFixed(2).replace('.', ',')}</div>
      </div>`).join('');
    document.getElementById('opr-ref-comentarios').innerHTML = _oprComentarios(d.comentarios, d.proximosPassos);
  }

  function _renderExpedicao(d) {
    if (!d || !d.disponivel) {
      document.getElementById('opr-exp-chart').innerHTML = _oprIndisponivel('Nenhuma carga expedida registrada — Fase 2 do plano.');
      document.getElementById('opr-exp-cargas').innerHTML = '';
      document.getElementById('opr-exp-m2').textContent = '—';
      document.getElementById('opr-exp-cargas-total').textContent = '—';
      document.getElementById('opr-exp-comentarios').innerHTML = _oprComentarios([], []);
      return;
    }
    document.getElementById('opr-exp-chart').innerHTML = _oprBarChart(
      d.expedicaoPorDia.labels, d.expedicaoPorDia.values, { color: 'var(--opr-blue)' }
    );
    document.getElementById('opr-exp-cargas').innerHTML = _oprBarChart(
      d.cargasPorSemana.labels, d.cargasPorSemana.values, { color: 'var(--opr-navy)', height: 76 }
    );
    document.getElementById('opr-exp-m2').textContent = _fmtNum(d.acumuladoM2, 2);
    document.getElementById('opr-exp-cargas-total').textContent = d.acumuladoCargas;
    document.getElementById('opr-exp-comentarios').innerHTML = _oprComentarios(d.comentarios, d.proximosPassos);
  }

  // ── Assuntos Gerais: texto + fotos com tema ────────────────────────
  // Único bloco da tela que é EDITÁVEL diretamente aqui (os outros 4
  // dependem de Registrar Operação/Setor de Qualidade/Segurança/
  // Expedição) — por isso tem seu próprio pedaço de estado (_agState,
  // cópia local editável, só vai pro servidor quando "Salvar" é clicado)
  // em vez de só refletir `_dadosAtuais` como o resto da tela.

  // Mesmo critério de admin de _souAdminAtual (public/js/manutencao.js)
  // — só controla o que aparece na TELA; quem decide de verdade é o
  // servidor (POST /salvar-comentarios-one-page-report exige
  // sessaoOuAdmin, ver lib/rotas/one-page-report.js).
  function _oprSouAdmin() {
    try {
      const p = sessionStorage.getItem('lw_role');
      return p === 'Administrador' || p === 'Administrativo';
    } catch (_) { return false; }
  }

  // Redimensiona/comprime uma foto antes de guardar — MESMA técnica de
  // _comprimirFotoDefeito (public/js/setor-qualidade.js): canvas limitado
  // a 1000x1000 (preservando proporção), reexportado como JPEG .75.
  // Nunca guarda o arquivo bruto da câmera.
  function _oprComprimirFoto(file) {
    return new Promise((resolve, reject) => {
      const leitor = new FileReader();
      leitor.onerror = () => reject(new Error('Não consegui ler o arquivo da foto.'));
      leitor.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Arquivo selecionado não é uma imagem válida.'));
        img.onload = () => {
          const MAX = 1000;
          let { width, height } = img;
          if (width > MAX || height > MAX) {
            if (width > height) { height = Math.round(height * (MAX / width)); width = MAX; }
            else { width = Math.round(width * (MAX / height)); height = MAX; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', .75));
        };
        img.src = leitor.result;
      };
      leitor.readAsDataURL(file);
    });
  }

  // Estado local editável de Assuntos Gerais — carregado de
  // dados.assuntosGerais em _renderAssuntosGerais, só vai pro servidor
  // em _agSalvar(). `mes` vem de dados.mes (Fase 4 sempre manda; MOCK_DADOS
  // também, ver acima) — precisa saber PRA QUAL mês salvar.
  let _agState = { mes: null, texto: '', fotos: [] };
  let _agSalvando = false;
  let _agStatusMsg = '';
  let _agStatusTipo = ''; // 'ok' | 'erro' | ''

  // <input type=file> escondido, reaproveitado (mesmo padrão de "criado
  // uma vez, lazy" de setor-qualidade.js) — múltiplas fotos de uma vez.
  let _agFileInputEl = null;
  function _agFileInput() {
    if (_agFileInputEl) return _agFileInputEl;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const arquivos = Array.from(input.files || []);
      input.value = ''; // permite escolher o mesmo arquivo de novo depois
      if (arquivos.length) _agArquivosEscolhidos(arquivos);
    });
    document.body.appendChild(input);
    _agFileInputEl = input;
    return input;
  }

  function _agAbrirSeletorFoto() {
    _agFileInput().click();
  }

  async function _agArquivosEscolhidos(arquivos) {
    for (const file of arquivos) {
      try {
        const imagem = await _oprComprimirFoto(file);
        _agState.fotos.push({
          id: 'novo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
          imagem,
          tema: '',
        });
      } catch (e) {
        _agStatusMsg = e.message || 'Não consegui processar uma das fotos.';
        _agStatusTipo = 'erro';
      }
    }
    _agRenderDOM();
  }

  function _agRemoverFoto(id) {
    _agState.fotos = _agState.fotos.filter(f => f.id !== id);
    _agRenderDOM();
  }

  function _agAtualizarTexto(valor) {
    _agState.texto = valor;
  }

  function _agAtualizarTema(id, valor) {
    const foto = _agState.fotos.find(f => f.id === id);
    if (foto) foto.tema = valor;
  }

  async function _agSalvar() {
    if (_agSalvando || !_agState.mes) return;
    _agSalvando = true;
    _agStatusMsg = 'Salvando…';
    _agStatusTipo = '';
    _agRenderDOM();
    try {
      const r = await fetch('/salvar-comentarios-one-page-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mes: _agState.mes,
          assuntosGerais: { texto: _agState.texto, fotos: _agState.fotos },
        }),
      });
      const corpo = await r.json().catch(() => null);
      if (!r.ok || !corpo || corpo.ok === false) {
        throw new Error((corpo && corpo.erro) || `Falha ao salvar (HTTP ${r.status}).`);
      }
      // Servidor devolve os ids definitivos (fotos novas ganham id lá,
      // ver validarFotosAssuntosGerais em lib/rotas/one-page-report.js)
      // — sincroniza pra próxima edição/remoção usar o id certo.
      _agState.texto = corpo.assuntosGerais.texto;
      _agState.fotos = corpo.assuntosGerais.fotos;
      _agStatusMsg = 'Salvo ✓';
      _agStatusTipo = 'ok';
    } catch (e) {
      _agStatusMsg = e.message || 'Falha ao salvar Assuntos Gerais.';
      _agStatusTipo = 'erro';
    } finally {
      _agSalvando = false;
      _agRenderDOM();
    }
  }

  function _agRenderDOM() {
    const container = document.getElementById('opr-assuntos-gerais-container');
    if (!container) return;
    // Assuntos Gerais é salvo POR MÊS (ver comentário de FASE 4, lib/rotas/
    // one-page-report.js) — nos modos "Todos os períodos"/"Personalizado"
    // não existe UM mês pra amarrar a edição, então a tela vira só leitura
    // ali (mesmo raciocínio de _agState.mes ficar null nesses modos, ver
    // _renderAssuntosGerais) mesmo pra quem é admin.
    const podeEditar = _oprSouAdmin() && _periodo.tipo === 'mes';

    const fotosHtml = _agState.fotos.map(f => `
      <div class="opr-ag-foto">
        ${podeEditar ? `<button type="button" class="opr-ag-foto-remover" title="Remover foto" onclick="LWOnePageReport._agRemoverFoto('${_escaparAtributo(f.id)}')">×</button>` : ''}
        <img src="${_escaparAtributo(f.imagem)}" alt="${_escaparAtributo(f.tema || 'Foto de Assuntos Gerais')}">
        ${podeEditar
          ? `<input class="opr-ag-foto-tema-input" type="text" maxlength="200" placeholder="Tema da foto…" value="${_escaparAtributo(f.tema || '')}" oninput="LWOnePageReport._agAtualizarTema('${_escaparAtributo(f.id)}', this.value)">`
          : `<div class="opr-ag-foto-tema">${_escaparHtml(f.tema || '')}</div>`
        }
      </div>`).join('');

    const addTileHtml = podeEditar ? `
      <button type="button" class="opr-ag-add" onclick="LWOnePageReport._agAbrirSeletorFoto()">
        <span class="opr-ag-add-icon">＋</span>
        <span>Adicionar foto</span>
      </button>` : '';

    const textoHtml = podeEditar
      ? `<textarea class="opr-footer-textarea" placeholder="Assuntos gerais do mês…" oninput="LWOnePageReport._agAtualizarTexto(this.value)">${_escaparHtml(_agState.texto)}</textarea>`
      : `<div class="opr-footer-texto-leitura">${_escaparHtml(_agState.texto)}</div>`;

    const avisoModoHtml = (_oprSouAdmin() && _periodo.tipo !== 'mes')
      ? `<div class="opr-ag-aviso-modo">Edição disponível só no modo "Mês".</div>` : '';

    const toolbarHtml = podeEditar ? `
      <div class="opr-ag-toolbar">
        <button type="button" class="btn btn-sm btn-primary" ${_agSalvando ? 'disabled' : ''} onclick="LWOnePageReport._agSalvar()">
          ${_agSalvando ? 'Salvando…' : '💾 Salvar Assuntos Gerais'}
        </button>
        ${_agStatusMsg ? `<span class="opr-ag-status ${_agStatusTipo ? 'opr-ag-status-' + _agStatusTipo : ''}">${_escaparHtml(_agStatusMsg)}</span>` : ''}
      </div>` : '';

    container.innerHTML = `
      ${textoHtml}
      <div class="opr-ag-grid">${fotosHtml}${addTileHtml}</div>
      ${avisoModoHtml}
      ${toolbarHtml}
    `;
  }

  function _renderAssuntosGerais(assuntosGerais, mes) {
    const ag = assuntosGerais || { texto: '', fotos: [] };
    _agState = {
      mes: mes || null,
      texto: ag.texto || '',
      // clona as fotos (nunca edita o objeto de _dadosAtuais direto —
      // só o "Salvar" confirma a mudança pro servidor; até lá é só
      // rascunho local).
      fotos: (ag.fotos || []).map(f => ({ ...f })),
    };
    _agStatusMsg = '';
    _agStatusTipo = '';
    _agRenderDOM();
  }

  let _dadosAtuais = null;

  // Período atualmente exibido na tela — `{tipo:'mes', mes}`,
  // `{tipo:'todos'}` ou `{tipo:'range', inicio, fim}`. Sincronizado com o
  // que o SERVIDOR devolveu (dados.periodo), não com o que foi pedido: se
  // o front pedir algo inválido/incompleto, quem decide o padrão é o
  // endpoint, e a tela reflete o que voltou, não o que foi enviado.
  let _periodo = { tipo: 'mes', mes: null };

  async function render(periodo) {
    const dados = await carregarDados(periodo || _periodo);
    _dadosAtuais = dados;
    _periodo = dados.periodo || { tipo: 'mes', mes: dados.mes };
    _sincronizarControlesPeriodo();
    const tituloMes = document.getElementById('opr-mes-atual');
    if (tituloMes) tituloMes.textContent = dados.mesReferencia;
    _renderSeguranca(dados.seguranca);
    _renderProducao(dados.producao);
    _renderRefugo(dados.refugo);
    _renderExpedicao(dados.expedicao);
    _renderAssuntosGerais(dados.assuntosGerais, dados.mes);
  }

  /** Atualiza os controles da toolbar (select de tipo + os campos do tipo
   * ativo) pra refletir `_periodo` — chamado sempre depois de um render()
   * bem-sucedido, nunca direto por quem dispara a troca (evita os
   * controles mostrarem algo que o servidor ainda não confirmou). */
  function _sincronizarControlesPeriodo() {
    const selectTipo = document.getElementById('opr-periodo-tipo');
    const blocoMes = document.getElementById('opr-mes-seletor');
    const blocoRange = document.getElementById('opr-range-seletor');
    if (selectTipo) selectTipo.value = _periodo.tipo;
    if (blocoMes) blocoMes.classList.toggle('opr-oculto', _periodo.tipo !== 'mes');
    if (blocoRange) blocoRange.classList.toggle('opr-oculto', _periodo.tipo !== 'range');
    if (_periodo.tipo === 'mes') {
      const inputMes = document.getElementById('opr-mes-input');
      if (inputMes && _periodo.mes) inputMes.value = _periodo.mes;
    } else if (_periodo.tipo === 'range') {
      const inputIni = document.getElementById('opr-range-inicio');
      const inputFim = document.getElementById('opr-range-fim');
      if (inputIni && _periodo.inicio) inputIni.value = _periodo.inicio;
      if (inputFim && _periodo.fim) inputFim.value = _periodo.fim;
    }
  }

  /** "YYYY-MM" do dia local — mesmo critério de fallback usado no resto
   * do front quando ainda não existe nenhum mês carregado (não deveria
   * acontecer na prática, já que init() sempre roda render() primeiro,
   * mas evita quebrar se mudarMesRelativo for chamado cedo demais). */
  function _mesLocalAtual() {
    const hoje = new Date();
    return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
  }

  /** Soma/subtrai `delta` meses de um "YYYY-MM", virando ano quando passa
   * de Janeiro/Dezembro (Date.UTC já normaliza mês fora de 0-11 sozinho). */
  function _deslocarMes(mesISO, delta) {
    const [ano, mes] = mesISO.split('-').map(Number);
    const d = new Date(Date.UTC(ano, (mes - 1) + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /** Chamado pelo <input type="month"> da toolbar (onchange). Ignora
   * valor vazio/mal formado (ex: usuário limpou o campo) — mantém o mês
   * atual em vez de disparar um fetch inválido. */
  function mudarMes(valor) {
    if (!valor || !/^\d{4}-\d{2}$/.test(valor)) return;
    if (_periodo.tipo === 'mes' && valor === _periodo.mes) return;
    render({ tipo: 'mes', mes: valor });
  }

  /** Botões ‹ › da toolbar — mesmo padrão de navegação relativa (‹/›)
   * já usado no resto do app (setor-qualidade.js/analise-focada.js). Só
   * faz sentido no modo "Mês" (nos outros dois o select nem mostra esses
   * botões — ver _sincronizarControlesPeriodo), mas usa o mês atual (ou
   * o mês local, se ainda nenhum foi carregado) como base de qualquer forma. */
  function mudarMesRelativo(delta) {
    const base = (_periodo.tipo === 'mes' && _periodo.mes) || _mesLocalAtual();
    mudarMes(_deslocarMes(base, delta));
  }

  /** Chamado pelo <select> "Mês"/"Todos os períodos"/"Personalizado" da
   * toolbar. "Todos" dispara na hora (não precisa de mais nenhum dado).
   * "Personalizado" só dispara fetch se já houver início/fim escolhidos
   * (ex.: usuário volta pro modo range depois de já ter preenchido as
   * datas antes) — senão só troca os controles visíveis e espera
   * mudarRange() ser chamado quando as duas datas estiverem prontas. */
  function mudarTipoPeriodo(tipo) {
    if (tipo === 'todos') {
      render({ tipo: 'todos' });
      return;
    }
    if (tipo === 'range') {
      const inputIni = document.getElementById('opr-range-inicio');
      const inputFim = document.getElementById('opr-range-fim');
      if (inputIni && inputFim && inputIni.value && inputFim.value && inputIni.value <= inputFim.value) {
        render({ tipo: 'range', inicio: inputIni.value, fim: inputFim.value });
      } else {
        _periodo = { tipo: 'range', inicio: (inputIni && inputIni.value) || null, fim: (inputFim && inputFim.value) || null };
        _sincronizarControlesPeriodo();
      }
      return;
    }
    render({ tipo: 'mes', mes: (_periodo.tipo === 'mes' && _periodo.mes) || _mesLocalAtual() });
  }

  /** Chamado pelo onchange dos dois <input type="date"> do modo
   * Personalizado. Só dispara fetch quando as DUAS datas já foram
   * escolhidas e início ≤ fim — senão fica quieto (o backend recusaria
   * mesmo, ver contextoDoPeriodo, lib/rotas/one-page-report.js; melhor
   * nem chegar a pedir). */
  function mudarRange() {
    const inputIni = document.getElementById('opr-range-inicio');
    const inputFim = document.getElementById('opr-range-fim');
    if (!inputIni || !inputFim || !inputIni.value || !inputFim.value) return;
    if (inputIni.value > inputFim.value) return;
    render({ tipo: 'range', inicio: inputIni.value, fim: inputFim.value });
  }

  function imprimir() {
    window.print();
  }

  let _init = false;
  function init() {
    if (_init) { render(); return; }
    _init = true;
    render();
  }

  window.LWOnePageReport = {
    init, render, imprimir,
    mudarMes, mudarMesRelativo, mudarTipoPeriodo, mudarRange,
    // Assuntos Gerais — chamados via onclick/oninput inline no HTML
    // gerado por _agRenderDOM (mesmo padrão de onclick="showPage(...)"/
    // "LWFocada.abrirDetalhesBerco(...)" já usado no resto do app).
    _agAbrirSeletorFoto, _agRemoverFoto, _agAtualizarTexto, _agAtualizarTema, _agSalvar,
  };

})();
