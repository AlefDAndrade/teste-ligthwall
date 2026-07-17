// ─── relatorio-bercos.js — Página "Relatório de Berços" ────────────────────
// Mostra, 1 linha por bateria já registrada, o resultado visual de cada
// lado de cada berço daquela bateria: 'okay', 'baixou' (exibido como
// "Vazou") ou 'nao_enchido' (exibido como "Não enchido") — dados vêm de
// bercos_visuais, via db.relatorioBercos() (ver GET /db/relatorio_bercos.json,
// server.js).
//
// Colunas fixas B1..B22 (MAX_BERCOS): nem toda bateria usa as 22 posições
// — os berços que aquela bateria específica não teve ficam em branco ("—"),
// em vez de tentar adivinhar quantas colunas cada linha "deveria" ter.
// Cada Bx tem 2 sub-colunas: E (esquerda) e D (direita), na mesma célula
// visual do cabeçalho (colspan=2 no topo, 2 <th> "E"/"D" embaixo).
(function () {
  const MAX_BERCOS = 22;

  // Valores reais gravados no banco -> rótulo exibido (ver db.js,
  // CREATE TABLE bercos_visuais: "estado_esquerda"/"estado_direita"
  // assumem 'okay' | 'baixou' | 'nao_enchido'). "Não enchido" tem cor
  // PRÓPRIA (azul, mesma usada pra 2ª linha no Setor de Qualidade e pro
  // "✕" em bateria-atual.js) — de propósito diferente do vermelho de
  // "baixou": são conceitos diferentes (vazamento observado vs painel
  // que nunca existiu pra avaliar).
  const ESTADO_LABEL = { okay: 'Okay', baixou: 'Vazou', nao_enchido: 'Não enchido' };
  const ESTADO_COR   = { okay: 'var(--green)', baixou: 'var(--red)', nao_enchido: 'var(--sq-cor-azul, var(--blue))' };

  // Total de VAZAMENTOS de UMA bateria/linha — soma os 2 lados (esquerdo +
  // direito) de todo berço marcado como 'baixou'. De propósito, NÃO conta
  // 'nao_enchido' aqui — são conceitos diferentes (o painel nem existiu
  // pra vazar) e essa contagem é especificamente de vazamentos, usada
  // tanto na coluna da tabela quanto no resumo do Modo Visual e do
  // popover — 1 lugar só pra não recontar diferente em cada visualização.
  function _contarVazamentos(linha) {
    return (linha.bercos || []).reduce((soma, b) => {
      if (b.estado_esquerda === 'baixou') soma++;
      if (b.estado_direita  === 'baixou') soma++;
      return soma;
    }, 0);
  }

  let _cache = [];
  let _modoVisual = false; // false = tabela (padrão), true = grade colorida por bateria

  // Alterna 2 classes por Bx (B1/B3/B5... vs B2/B4/B6...) — cada berço
  // ocupa 2 colunas (E/D) inteiras nesta cor, pra ficar fácil ver de
  // relance onde um berço termina e o próximo começa (ver .rb-grupo-a/
  // .rb-grupo-b em styles.css). Uma função só, usada tanto no cabeçalho
  // (_construirThead) quanto no corpo (_linhaBercos), pra garantir que as
  // duas linhas do cabeçalho E o corpo sempre concordem em qual berço é
  // "A" e qual é "B".
  function _grupoBerco(i) {
    return i % 2 === 1 ? 'rb-grupo-a' : 'rb-grupo-b';
  }

  // Monta o cabeçalho de 2 linhas (Bx em cima com colspan=2, E/D embaixo)
  // uma única vez — refazer isso em toda renderização não muda nada (o
  // número de berços é sempre MAX_BERCOS) e só re-cria DOM à toa.
  function _construirThead() {
    const topo = document.getElementById('relatorio-bercos-thead-topo');
    const sub  = document.getElementById('relatorio-bercos-thead-sub');
    if (!topo || !sub || topo.childElementCount) return; // já construído

    let topoHtml = '<th rowspan="2">Data</th><th rowspan="2">Montagem</th><th rowspan="2">Vazamentos</th>';
    let subHtml  = '';
    for (let i = 1; i <= MAX_BERCOS; i++) {
      const grupo = _grupoBerco(i);
      topoHtml += `<th colspan="2" class="${grupo}">B${i}</th>`;
      subHtml  += `<th class="rb-sub ${grupo}">E</th><th class="rb-sub ${grupo}">D</th>`;
    }
    topo.innerHTML = topoHtml;
    sub.innerHTML  = subHtml;
  }

  // 'estado' aqui já chega sempre preenchido ('okay' por padrão — ver
  // criarBercosVisuaisIniciais, db.js); o "—" só aparece quando o berço
  // nem existe nesta bateria (ver _linhaBercos, abaixo).
  function _celulaEstado(estado, grupo) {
    const label = ESTADO_LABEL[estado];
    if (!label) return `<td class="rb-vazio ${grupo}">—</td>`;
    return `<td class="${grupo}" style="color:${ESTADO_COR[estado] || 'var(--text-2)'};font-weight:600">${label}</td>`;
  }

  // Monta as 44 (MAX_BERCOS × 2) células de berços de UMA linha/bateria.
  function _linhaBercos(linha) {
    const porOrdem = new Map((linha.bercos || []).map(b => [b.ordem, b]));
    let html = '';
    for (let i = 1; i <= MAX_BERCOS; i++) {
      const grupo = _grupoBerco(i);
      const b = porOrdem.get(i);
      if (!b) {
        html += `<td class="rb-vazio ${grupo}">—</td><td class="rb-vazio ${grupo}">—</td>`;
        continue;
      }
      html += _celulaEstado(b.estado_esquerda, grupo) + _celulaEstado(b.estado_direita, grupo);
    }
    return html;
  }

  function _dentroDoPeriodo(linha, ini, fim) {
    if (!linha.data) return true;
    if (ini && linha.data < ini) return false;
    if (fim && linha.data > fim) return false;
    return true;
  }

  // ── Filtros novos (voltou — ver conversa que motivou a mudança) ─────────
  // Tipo de Montagem e Tipo de Bateria: dropdowns populados com os valores
  // que REALMENTE aparecem em _cache (não a lista cadastrada em
  // Configurações inteira) — evita opção vazia sem nenhum registro por
  // trás, e não depende de entender a forma exata de tipos_montagem.opcoes
  // (a linha já vem com tipo_montagem como string simples, pronta pra usar).
  function _valoresUnicos(campo) {
    return [...new Set(_cache.map(l => l[campo]).filter(Boolean))].sort();
  }

  // Preenche um <select> com os valores atuais de _cache, preservando a
  // opção selecionada (se ainda existir) — chamado toda vez que _cache é
  // recarregado (ver carregar(), abaixo), não só na 1ª vez, porque um
  // registro novo pode trazer um tipo de montagem/bateria que ainda não
  // existia na lista.
  function _popularSelect(id, campo, rotuloTodos) {
    const sel = document.getElementById(id);
    if (!sel) return;
    const atual = sel.value;
    const valores = _valoresUnicos(campo);
    sel.innerHTML = `<option value="">${rotuloTodos}</option>` + valores.map(v => `<option value="${LW.escaparHtml(v)}">${LW.escaparHtml(v)}</option>`).join('');
    if (valores.includes(atual)) sel.value = atual;
  }

  function _passaNosFiltros(linha, filtros) {
    if (!_dentroDoPeriodo(linha, filtros.ini, filtros.fim)) return false;
    if (filtros.montagem && linha.tipo_montagem !== filtros.montagem) return false;
    if (filtros.bateria && String(linha.id_bateria) !== filtros.bateria) return false;
    if (filtros.vazamento === 'com' && _contarVazamentos(linha) === 0) return false;
    if (filtros.vazamento === 'sem' && _contarVazamentos(linha) > 0) return false;
    if (filtros.idOperacao && !String(linha.id_operacao).toLowerCase().includes(filtros.idOperacao)) return false;
    return true;
  }

  function _lerFiltros() {
    return {
      ini: document.getElementById('rb-data-inicio')?.value || '',
      fim: document.getElementById('rb-data-fim')?.value || '',
      montagem: document.getElementById('rb-tipo-montagem')?.value || '',
      bateria: document.getElementById('rb-tipo-bateria')?.value || '',
      vazamento: document.getElementById('rb-vazamento')?.value || '',
      idOperacao: (document.getElementById('rb-id-operacao')?.value || '').trim().toLowerCase(),
    };
  }

  // Busca os dados no servidor 1 vez (ou quando explicitamente pedido) e
  // guarda em _cache — separado de aplicarFiltros() (abaixo) de propósito:
  // o campo "ID da Operação" filtra ENQUANTO a pessoa digita (ver init()),
  // e refazer a requisição a cada tecla seria lento e piscaria
  // "Carregando..." toda hora à toa — os outros filtros (Montagem,
  // Bateria, Vazamento, datas) são só um recorte do que já está em
  // memória também.
  async function carregar() {
    const tbody = document.getElementById('relatorio-bercos-tbody');
    if (tbody) {
      const colspanTotal = 3 + MAX_BERCOS * 2;
      tbody.innerHTML = `<tr><td colspan="${colspanTotal}" style="text-align:center;color:var(--text-3);padding:30px">Carregando...</td></tr>`;
    }
    _construirThead();
    _cache = await LW.getRelatorioBercos();
    _popularSelect('rb-tipo-montagem', 'tipo_montagem', 'Todas as montagens');
    _popularSelect('rb-tipo-bateria', 'id_bateria', 'Todas as baterias');
    aplicarFiltros();
  }

  // Filtra e redesenha a partir de _cache já carregado — sem tocar a rede.
  function aplicarFiltros() {
    const tbody = document.getElementById('relatorio-bercos-tbody');
    if (!tbody) return;

    const colspanTotal = 3 + MAX_BERCOS * 2; // Data + Montagem + Vazamentos + (E/D de cada berço)
    const filtros = _lerFiltros();
    const linhas = _cache.filter(l => _passaNosFiltros(l, filtros));

    const contagem = document.getElementById('rb-count');
    if (contagem) contagem.textContent = linhas.length ? `${linhas.length} bateria${linhas.length > 1 ? 's' : ''}` : '';

    if (!linhas.length) {
      tbody.innerHTML = `<tr><td colspan="${colspanTotal}" style="text-align:center;color:var(--text-3);padding:30px">Nenhum registro encontrado com estes filtros.</td></tr>`;
      _renderVisual(linhas);
      return;
    }

    // Mais recente primeiro — mesmo critério visual do Relatório de Injeção.
    // data-id-operacao identifica a linha pro popover de hover/toque (ver
    // _ligarPopoverLinhas, mais abaixo) — sem isso não dá pra saber, a
    // partir do <tr>, qual item de _cache mostrar na grade completa.
    tbody.innerHTML = linhas.slice().reverse().map(l => {
      const vaz = _contarVazamentos(l);
      return `
      <tr data-id-operacao="${l.id_operacao}">
        <td class="mono" title="${l.turno || ''}">${l.data ? l.data.split('-').reverse().join('/') : '—'}</td>
        <td>${LW.escaparHtml(l.tipo_montagem || '—')}</td>
        <td class="mono" style="text-align:center;font-weight:700;color:${vaz > 0 ? 'var(--red)' : 'var(--text-3)'}">${vaz}</td>
        ${_linhaBercos(l)}
      </tr>
    `;
    }).join('');

    // Modo Visual é montado JUNTO (mesmo dado, mesma ordem) mesmo se não
    // estiver visível agora — assim, alternar o botão "🎨 Modo Visual" só
    // troca um display:none/'', instantâneo, sem precisar buscar os dados
    // de novo nem esperar nada.
    _renderVisual(linhas);
  }

  // Monta 1 card por bateria — resumo (mesmo formato do popover) + grade
  // colorida (_montarGradeBercos) — pro Modo Visual. Mesma ordem "mais
  // recente primeiro" da tabela.
  function _renderVisual(linhas) {
    const container = document.getElementById('relatorio-bercos-visual');
    if (!container) return;

    if (!linhas.length) {
      container.innerHTML = `<div class="card" style="padding:30px;text-align:center;color:var(--text-3)">Nenhum registro no período.</div>`;
      return;
    }

    container.innerHTML = linhas.slice().reverse().map(l => {
      const vaz = _contarVazamentos(l);
      return `
      <div class="card mb-3" style="padding:14px 18px">
        <div class="ba-resumo">
          <strong>Bateria ${LW.escaparHtml(String(l.id_bateria ?? '—'))}</strong> — ${LW.escaparHtml(String(l.tipo_montagem || '—'))}
          ${l.data ? ` — ${l.data.split('-').reverse().join('/')}${l.turno ? ' · ' + LW.escaparHtml(String(l.turno)) : ''}` : ''}
          — <span style="color:${vaz > 0 ? 'var(--red)' : 'var(--text-3)'};font-weight:700">${vaz} vazamento${vaz === 1 ? '' : 's'}</span>
        </div>
        ${_montarGradeBercos(l)}
      </div>
    `;
    }).join('');
  }

  // Só alterna o que já está montado (ver render()/_renderVisual, acima) —
  // nenhuma busca nova, nenhum re-render, troca instantânea.
  function _aplicarModoVisual() {
    const tableWrap = document.querySelector('#page-relatorio-bercos .table-wrap');
    const visual    = document.getElementById('relatorio-bercos-visual');
    if (tableWrap) tableWrap.style.display = _modoVisual ? 'none' : '';
    if (visual)    visual.style.display    = _modoVisual ? '' : 'none';
    const btn = document.getElementById('btn-rb-modo-visual');
    if (btn) btn.classList.toggle('btn-primary', _modoVisual);
  }

  // ── Cor por tipo de montagem de um berço ────────────────────────────────
  // Mesmo critério de "Bateria Atual" (ver bateria-atual.js, _baCorPorTipo/
  // _baTiposPorBerco): Montagem Personalizada guarda o CÓDIGO do tipo por
  // berço (bercos_personalizados, 1 posição por berço — ver db.
  // relatorioBercos()), resolvido por LW.corPorTipoSimples; qualquer outro
  // tipo (simples ou híbrido) é uniforme pra bateria inteira — todo berço
  // usa o mesmo LABEL (linha.tipo_montagem), resolvido por
  // LW.corMontagemPorLabel (que já sabe montar o gradiente 50/50 de
  // híbridos). Sem tipo definido (personalizada com berço ainda vazio, ou
  // tipo_montagem ausente) -> null, célula cai no cinza neutro de sempre.
  function _tipoDoBerco(linha, ordem) {
    if (linha.tipo_montagem === LW.TIPO_MONTAGEM_PERSONALIZADA) {
      const grade = Array.isArray(linha.bercos_personalizados) ? linha.bercos_personalizados : [];
      return grade[ordem - 1] || null;
    }
    return linha.tipo_montagem || null;
  }

  function _corDoBerco(linha, ordem) {
    const tipo = _tipoDoBerco(linha, ordem);
    if (!tipo) return null;
    return linha.tipo_montagem === LW.TIPO_MONTAGEM_PERSONALIZADA
      ? LW.corPorTipoSimples(tipo)
      : LW.corMontagemPorLabel(tipo);
  }

  // Monta a grade (.ba-grid) de UMA bateria/linha — reaproveitada tanto
  // pelo popover de hover/toque (tabela) quanto pelo Modo Visual (grade
  // completa sempre visível, ver _renderVisual). Colorida por tipo de
  // montagem (_corDoBerco, acima); célula sem cor cai no cinza neutro de
  // sempre — nenhuma das duas visualizações perde a marcação de vazamento
  // (.ba-dot-marcado), que continua sendo SEMPRE no indicador, não na
  // célula (2 lados independentes por berço).
  function _montarGradeBercos(linha) {
    const bercosOrdenados = (linha.bercos || []).slice().sort((a, b) => a.ordem - b.ordem);
    return `<div class="ba-grid">${bercosOrdenados.map(b => {
      // "✕" (não enchido) é um estado À PARTE de "baixou" (vazamento) —
      // mesma distinção de bateria-atual.js/ESTADO_LABEL acima: o painel
      // nunca existiu pra avaliar, diferente de um vazamento observado.
      const dirNaoEnchido = b.estado_direita === 'nao_enchido';
      const esqNaoEnchido = b.estado_esquerda === 'nao_enchido';
      const dirMarcado = b.estado_direita === 'baixou' || dirNaoEnchido;
      const esqMarcado = b.estado_esquerda === 'baixou' || esqNaoEnchido;
      const numero = String(b.ordem).padStart(2, '0');
      const cor = _corDoBerco(linha, b.ordem);
      return `
        <div class="ba-celula" style="background:${cor ? cor.bg : 'var(--bg-2)'};color:${cor ? cor.cor : 'var(--text-2)'};border:1px solid ${cor ? cor.borda : 'var(--border)'}">
          <span class="ba-dot ba-dot-topo${dirMarcado ? ' ba-dot-marcado' : ''}${dirNaoEnchido ? ' ba-dot-nao-enchido' : ''}" title="${dirNaoEnchido ? 'Direito — Não enchido' : 'Direito'}">${dirNaoEnchido ? '✕' : '•'}</span>
          <span class="ba-numero">B${numero}</span>
          <span class="ba-dot ba-dot-base${esqMarcado ? ' ba-dot-marcado' : ''}${esqNaoEnchido ? ' ba-dot-nao-enchido' : ''}" title="${esqNaoEnchido ? 'Esquerdo — Não enchido' : 'Esquerdo'}">${esqNaoEnchido ? '✕' : '•'}</span>
        </div>`;
    }).join('')}</div>`;
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
    const totalBercos = (linha.bercos || []).length;
    const vaz = _contarVazamentos(linha);
    const resumo = `
      <div class="ba-resumo">
        <strong>Bateria ${LW.escaparHtml(String(linha.id_bateria ?? '—'))}</strong> — ${LW.escaparHtml(String(linha.tipo_montagem || '—'))}
        ${totalBercos ? ` — ${totalBercos} berços` : ''}
        — <span style="color:${vaz > 0 ? 'var(--red)' : 'var(--text-3)'};font-weight:700">${vaz} vazamento${vaz === 1 ? '' : 's'}</span>
      </div>`;
    const grid = _montarGradeBercos(linha);
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

    document.getElementById('btn-rb-filtrar')?.addEventListener('click', aplicarFiltros);
    document.getElementById('btn-rb-limpar')?.addEventListener('click', () => {
      const ini = document.getElementById('rb-data-inicio');
      const fim = document.getElementById('rb-data-fim');
      const montagem = document.getElementById('rb-tipo-montagem');
      const bateria = document.getElementById('rb-tipo-bateria');
      const vazamento = document.getElementById('rb-vazamento');
      const idOperacao = document.getElementById('rb-id-operacao');
      if (ini) ini.value = '';
      if (fim) fim.value = '';
      if (montagem) montagem.value = '';
      if (bateria) bateria.value = '';
      if (vazamento) vazamento.value = '';
      if (idOperacao) idOperacao.value = '';
      aplicarFiltros();
    });
    document.getElementById('btn-rb-modo-visual')?.addEventListener('click', () => {
      _modoVisual = !_modoVisual;
      _aplicarModoVisual();
    });
    // Montagem/Bateria/Vazamento: dropdown, aplica na hora ao escolher.
    // ID da Operação: busca ENQUANTO digita (ver comentário em carregar(),
    // acima) — mesmo padrão de "busca" usado em outras telas (ex:
    // sq-hist-search, Setor de Qualidade → Registros).
    document.getElementById('rb-tipo-montagem')?.addEventListener('change', aplicarFiltros);
    document.getElementById('rb-tipo-bateria')?.addEventListener('change', aplicarFiltros);
    document.getElementById('rb-vazamento')?.addEventListener('change', aplicarFiltros);
    document.getElementById('rb-id-operacao')?.addEventListener('input', aplicarFiltros);

    carregar().then(_ligarPopoverLinhas);
  }

  window.LWBercos = { init, render: carregar };
})();