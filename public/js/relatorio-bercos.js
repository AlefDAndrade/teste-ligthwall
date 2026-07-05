// ─── relatorio-bercos.js — Página "Relatório de Berços" ────────────────────
// Mostra, 1 linha por bateria já registrada, o resultado visual de cada
// lado de cada berço daquela bateria: 'okay' ou 'baixou' (exibido como
// "Vazou") — dados vêm de bercos_visuais, via db.relatorioBercos() (ver
// GET /db/relatorio_bercos.json, server.js).
//
// Colunas fixas B1..B22 (MAX_BERCOS): nem toda bateria usa as 22 posições
// — os berços que aquela bateria específica não teve ficam em branco ("—"),
// em vez de tentar adivinhar quantas colunas cada linha "deveria" ter.
// Cada Bx tem 2 sub-colunas: E (esquerda) e D (direita), na mesma célula
// visual do cabeçalho (colspan=2 no topo, 2 <th> "E"/"D" embaixo).
(function () {
  const MAX_BERCOS = 22;

  // Valores reais gravados no banco -> rótulo exibido (ver db.js,
  // CREATE TABLE bercos_visuais: "estado_esquerda"/"estado_direita" só
  // assumem 'okay'/'baixou' por enquanto).
  const ESTADO_LABEL = { okay: 'Okay', baixou: 'Vazou' };
  const ESTADO_COR   = { okay: 'var(--green)', baixou: 'var(--red)' };

  let _cache = [];

  // Monta o cabeçalho de 2 linhas (Bx em cima com colspan=2, E/D embaixo)
  // uma única vez — refazer isso em toda renderização não muda nada (o
  // número de berços é sempre MAX_BERCOS) e só re-cria DOM à toa.
  function _construirThead() {
    const topo = document.getElementById('relatorio-bercos-thead-topo');
    const sub  = document.getElementById('relatorio-bercos-thead-sub');
    if (!topo || !sub || topo.childElementCount) return; // já construído

    let topoHtml = '<th rowspan="2">Tipo de bateria</th><th rowspan="2">Montagem</th>';
    let subHtml  = '';
    for (let i = 1; i <= MAX_BERCOS; i++) {
      topoHtml += `<th colspan="2">B${i}</th>`;
      subHtml  += `<th class="rb-sub">E</th><th class="rb-sub">D</th>`;
    }
    topo.innerHTML = topoHtml;
    sub.innerHTML  = subHtml;
  }

  // 'estado' aqui já chega sempre preenchido ('okay' por padrão — ver
  // criarBercosVisuaisIniciais, db.js); o "—" só aparece quando o berço
  // nem existe nesta bateria (ver _linhaBercos, abaixo).
  function _celulaEstado(estado) {
    const label = ESTADO_LABEL[estado];
    if (!label) return '<td class="rb-vazio">—</td>';
    return `<td style="color:${ESTADO_COR[estado] || 'var(--text-2)'};font-weight:600">${label}</td>`;
  }

  // Monta as 44 (MAX_BERCOS × 2) células de berços de UMA linha/bateria.
  function _linhaBercos(linha) {
    const porOrdem = new Map((linha.bercos || []).map(b => [b.ordem, b]));
    let html = '';
    for (let i = 1; i <= MAX_BERCOS; i++) {
      const b = porOrdem.get(i);
      if (!b) {
        html += '<td class="rb-vazio">—</td><td class="rb-vazio">—</td>';
        continue;
      }
      html += _celulaEstado(b.estado_esquerda) + _celulaEstado(b.estado_direita);
    }
    return html;
  }

  function _dentroDoPeriodo(linha, ini, fim) {
    if (!linha.data) return true;
    if (ini && linha.data < ini) return false;
    if (fim && linha.data > fim) return false;
    return true;
  }

  async function render() {
    const tbody = document.getElementById('relatorio-bercos-tbody');
    if (!tbody) return;

    const colspanTotal = 2 + MAX_BERCOS * 2;
    tbody.innerHTML = `<tr><td colspan="${colspanTotal}" style="text-align:center;color:var(--text-3);padding:30px">Carregando...</td></tr>`;

    _construirThead();

    _cache = await LW.getRelatorioBercos();

    const ini = document.getElementById('rb-data-inicio')?.value || '';
    const fim = document.getElementById('rb-data-fim')?.value || '';
    const linhas = _cache.filter(l => _dentroDoPeriodo(l, ini, fim));

    const contagem = document.getElementById('rb-count');
    if (contagem) contagem.textContent = linhas.length ? `${linhas.length} bateria${linhas.length > 1 ? 's' : ''}` : '';

    if (!linhas.length) {
      tbody.innerHTML = `<tr><td colspan="${colspanTotal}" style="text-align:center;color:var(--text-3);padding:30px">Nenhum registro no período.</td></tr>`;
      return;
    }

    // Mais recente primeiro — mesmo critério visual do Relatório de Injeção.
    // data-id-operacao identifica a linha pro popover de hover/toque (ver
    // _ligarPopoverLinhas, mais abaixo) — sem isso não dá pra saber, a
    // partir do <tr>, qual item de _cache mostrar na grade completa.
    tbody.innerHTML = linhas.slice().reverse().map(l => `
      <tr data-id-operacao="${l.id_operacao}">
        <td class="mono" title="${l.data ? l.data.split('-').reverse().join('/') + (l.turno ? ' — ' + l.turno : '') : ''}">${l.id_bateria || '—'}</td>
        <td>${l.tipo_montagem || '—'}</td>
        ${_linhaBercos(l)}
      </tr>
    `).join('');
  }

  // ── Hover/toque: grade completa do berço, estilo "Bateria Atual" ────────
  // Reaproveita as MESMAS classes CSS de bateria-atual.js (.ba-resumo,
  // .ba-grid, .ba-celula, .ba-numero, .ba-dot, .ba-dot-marcado) pra ficar
  // visualmente idêntico ao card "Bateria Atual" (Registrar Operação) —
  // só que aqui é sempre leitura (dado já registrado, não dá pra marcar
  // nada), então os indicadores não têm onclick nenhum.
  //
  // Regra de ativação pedida: em mouse (ponteiro fino) só aparece com
  // Ctrl segurado enquanto passa o mouse na linha; em toque (celular/
  // tablet, ponteiro grosso) aparece com um toque na linha (e fecha com
  // outro toque na mesma linha, ou tocando fora).
  const PONTEIRO_FINO = !!(window.matchMedia && window.matchMedia('(pointer: fine)').matches);

  function _garantirPopover() {
    let el = document.getElementById('rb-popover');
    if (!el) {
      el = document.createElement('div');
      el.id = 'rb-popover';
      el.className = 'rb-popover';
      document.body.appendChild(el);
    }
    return el;
  }

  function _montarConteudoPopover(linha) {
    const bercosOrdenados = (linha.bercos || []).slice().sort((a, b) => a.ordem - b.ordem);
    const resumo = `
      <div class="ba-resumo">
        <strong>Bateria ${LW.escaparHtml(String(linha.id_bateria ?? '—'))}</strong> — ${LW.escaparHtml(String(linha.tipo_montagem || '—'))}
        ${bercosOrdenados.length ? ` — ${bercosOrdenados.length} berços` : ''}
      </div>`;
    const grid = `<div class="ba-grid">${bercosOrdenados.map(b => {
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
    const legenda = `<div class="ba-dica">🔴 Indicador vermelho = vazou · em cima = lado direito, embaixo = lado esquerdo</div>`;
    return resumo + grid + legenda;
  }

  function _posicionarPopover(el, x, y) {
    const margem = 14;
    // Mede depois de já estar visível (offsetWidth/Height dependem de
    // layout aplicado) — display:block já foi setado por quem chamou.
    const largura = el.offsetWidth;
    const altura = el.offsetHeight;
    let left = x + margem;
    let top = y + margem;
    if (left + largura > window.innerWidth - margem) left = x - largura - margem;
    if (top + altura > window.innerHeight - margem) top = y - altura - margem;
    el.style.left = Math.max(margem, left) + 'px';
    el.style.top = Math.max(margem, top) + 'px';
  }

  function _mostrarPopover(linha, x, y) {
    const el = _garantirPopover();
    el.innerHTML = _montarConteudoPopover(linha);
    el.style.display = 'block';
    _posicionarPopover(el, x, y);
  }

  function _esconderPopover() {
    const el = document.getElementById('rb-popover');
    if (el) el.style.display = 'none';
    _popoverAbertoId = null;
  }

  let _linhaSobMouse = null;   // <tr> atualmente sob o cursor (modo mouse)
  let _ctrlPressionado = false;
  let _popoverAbertoId = null; // id_operacao aberto no momento (modo toque)
  let _ultimoMouseX = 0, _ultimoMouseY = 0;

  function _achaLinhaCache(idOperacao) {
    return _cache.find(l => String(l.id_operacao) === String(idOperacao));
  }

  function _ligarPopoverLinhas() {
    const tbody = document.getElementById('relatorio-bercos-tbody');
    if (!tbody || tbody.dataset.popoverLigado) return; // só liga 1 vez
    tbody.dataset.popoverLigado = '1';

    if (PONTEIRO_FINO) {
      // ── Mouse: só mostra com Ctrl segurado ──
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Control') return;
        _ctrlPressionado = true;
        if (_linhaSobMouse) {
          const linha = _achaLinhaCache(_linhaSobMouse.getAttribute('data-id-operacao'));
          if (linha) _mostrarPopover(linha, _ultimoMouseX, _ultimoMouseY);
        }
      });
      document.addEventListener('keyup', (e) => {
        if (e.key !== 'Control') return;
        _ctrlPressionado = false;
        _esconderPopover();
      });
      // Solta o Ctrl fora da janela (ex: trocou de aba) sem soltar o
      // keyup aqui — sem isso o popover podia ficar "preso" aberto.
      window.addEventListener('blur', () => { _ctrlPressionado = false; _esconderPopover(); });

      tbody.addEventListener('mousemove', (e) => {
        _ultimoMouseX = e.clientX; _ultimoMouseY = e.clientY;
        const tr = e.target.closest('tr[data-id-operacao]');
        _linhaSobMouse = tr || null;
        if (!tr) { _esconderPopover(); return; }
        if (_ctrlPressionado) {
          const linha = _achaLinhaCache(tr.getAttribute('data-id-operacao'));
          if (linha) _mostrarPopover(linha, e.clientX, e.clientY);
        }
      });
      tbody.addEventListener('mouseleave', () => { _linhaSobMouse = null; _esconderPopover(); });
      // Rolar a tabela com o popover aberto deixaria ele "flutuando" longe
      // da linha original — mais simples e seguro é só fechar. Escopado a
      // #page-relatorio-bercos porque a SPA mantém TODAS as páginas no
      // DOM ao mesmo tempo (só escondidas) — um seletor solto (".table-wrap")
      // pegaria a primeira tabela de QUALQUER página, não necessariamente
      // esta.
      document.querySelector('#page-relatorio-bercos .table-wrap')?.addEventListener('scroll', _esconderPopover);
    } else {
      // ── Toque: 1 toque na linha abre, outro na mesma linha (ou fora) fecha ──
      tbody.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-id-operacao]');
        if (!tr) return;
        const idOp = tr.getAttribute('data-id-operacao');
        if (_popoverAbertoId === idOp) { _esconderPopover(); return; }
        const linha = _achaLinhaCache(idOp);
        if (!linha) return;
        const rect = tr.getBoundingClientRect();
        _mostrarPopover(linha, rect.left + rect.width / 2, rect.bottom);
        _popoverAbertoId = idOp;
      });
      document.addEventListener('click', (e) => {
        if (!_popoverAbertoId) return;
        if (e.target.closest('#rb-popover') || e.target.closest('tr[data-id-operacao]')) return;
        _esconderPopover();
      });
    }
  }

  function init() {
    _construirThead();

    document.getElementById('btn-rb-filtrar')?.addEventListener('click', render);
    document.getElementById('btn-rb-limpar')?.addEventListener('click', () => {
      const ini = document.getElementById('rb-data-inicio');
      const fim = document.getElementById('rb-data-fim');
      if (ini) ini.value = '';
      if (fim) fim.value = '';
      render();
    });

    render().then(_ligarPopoverLinhas);
  }

  window.LWBercos = { init, render };
})();