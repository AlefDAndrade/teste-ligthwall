// ============================================================
//  SETOR DE QUALIDADE — Avaliação de Baterias
//  Dados salvos em localStorage com prefixo "sq_" para não
//  colidir com o Lightwall.
// ============================================================
'use strict';

(function () {

  /* ── Prefixo localStorage ─────────────────────────────── */
  const LS = {
    get: k => { try { return JSON.parse(localStorage.getItem('sq_' + k)); } catch (e) { return null; } },
    set: (k, v) => localStorage.setItem('sq_' + k, JSON.stringify(v)),
    del: k => localStorage.removeItem('sq_' + k),
    keys: prefix => {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('sq_' + prefix)) out.push(k);
      }
      return out;
    },
  };

  /* ── Estado global ────────────────────────────────────── */
  let selectedColor  = 'verde';
  let selectedShape  = 'circle';
  let slabState      = {};
  let actionHistory  = [];
  let currentDraftId = null;
  let viewMode       = false;
  let viewSource     = 'form';
  let palletTypes    = ['', '', '', ''];
  let slabConfig     = {};
  let modalTipoSel   = 'SP';
  let tempSlabConfig = {};
  let dashboardEvals = [];
  let mirrorIndex    = 0;

  // ── Fila de baterias não avaliadas (Registro de Baterias → Setor de
  // Qualidade) — ver carregarFilaNaoAvaliadas()/_iniciarForm(), abaixo.
  let filaOperacoes    = [];  // última lista carregada de GET /operacoes-nao-avaliadas
  let linkedOperacaoId = null; // id_operacao da fila vinculado à avaliação em edição, ou null (avulsa)

  // ── Tipos de montagem — vem de config.json (tipos_montagem.opcoes),
  // NUNCA mais fixo/hardcoded aqui (ver _carregarOpcoesMontagem). Cache
  // usado tanto pra montar o <select> quanto pra mapear tipo_montagem de
  // uma operação real (que guarda o LABEL, ex: "S/P") de volta pro código
  // usado internamente aqui (ex: "SP") — ver _codigoMontagemPorLabel.
  let _montagemOpcoesCache = [];

  // ── Combinações cor+forma → tipo simples (Referência de Marcadores) —
  // também vem de config.json (marcadores_qualidade.opcoes), gravado lá
  // JUNTO com o resto da configuração de montagem (ver salvarCombinacao
  // Tipo, mais abaixo). _configBrutoCache guarda o config.json inteiro
  // (não só marcadores_qualidade) porque salvar de volta usa /salvar-
  // config, que substitui o arquivo inteiro — precisa reenviar tudo, não
  // só o pedaço que mudou.
  let _marcadoresQualidadeCache = null;
  let _configBrutoCache = null;

  /**
   * Popula #sq-mountType a partir de config.json — mesma fonte de verdade
   * que Registrar Operação usa (ver public/js/data.js, _aplicarTiposMontagem).
   * "SP+2P" continua como atalho fixo (2 pallets de cada), mas só aparece
   * se os tipos SP e 2P realmente existirem em config — não força nada
   * que não esteja cadastrado. "Personalizada" continua sempre disponível
   * por último (não é um item de tipos_montagem.opcoes — é um modo à
   * parte, igual em Registrar Operação).
   */
  async function _carregarOpcoesMontagem() {
    const sel = document.getElementById('sq-mountType');
    if (!sel) return;
    try {
      const res = await fetch('/db/config.json');
      if (!res.ok) throw new Error('Falha ao buscar config.json');
      const cfg = await res.json();
      _configBrutoCache = cfg;
      _marcadoresQualidadeCache = Array.isArray(cfg?.marcadores_qualidade?.opcoes) ? cfg.marcadores_qualidade.opcoes : null;
      const opcoes = Array.isArray(cfg?.tipos_montagem?.opcoes) ? cfg.tipos_montagem.opcoes : [];
      _montagemOpcoesCache = opcoes;
      const simples = opcoes.filter(o => o && o.modo === 'simples' && o.tipo && o.label);

      const temSP = simples.some(o => o.tipo === 'sp');
      const tem2P = simples.some(o => o.tipo === '2p');
      let html = '<option value="">Selecionar…</option>';
      if (temSP && tem2P) html += '<option value="SP+2P">SP + 2P</option>';
      simples.forEach(o => {
        html += `<option value="${String(o.tipo).toUpperCase()}">${o.label}</option>`;
      });
      html += '<option value="Personalizada">Personalizada</option>';
      sel.innerHTML = html;
      _renderAvisoCombinacoesFaltando();
    } catch (err) {
      console.error('Falha ao carregar tipos de montagem de config.json — usando lista fixa de reserva:', err);
      // Fallback só pra tela não ficar sem nenhuma opção se config.json
      // não puder ser lido (rede fora etc.) — não é mais a fonte de
      // verdade, é só uma rede de segurança.
      _montagemOpcoesCache = [];
      sel.innerHTML = `
        <option value="">Selecionar…</option>
        <option value="SP+2P">SP + 2P</option><option value="SP">SP</option>
        <option value="2P">2P</option><option value="3T">3T</option>
        <option value="Personalizada">Personalizada</option>`;
    }
  }

  // Converte o tipo_montagem de uma operação real (LABEL — ex: "S/P",
  // "2/P", "3T", vindo de config.json) pro código usado aqui dentro (ex:
  // "SP", "2P", "3T" — ver #sq-mountType). Tipos hibridos (ex: "HÍBRIDA
  // 2p/sp") não têm um preset correspondente aqui (não é a mesma coisa
  // que "SP+2P": híbrida é 1+1 POR BERÇO, "SP+2P" é 2 pallets inteiros de
  // cada) — devolve null de propósito, pra não mapear errado.
  function _codigoMontagemPorLabel(label) {
    if (!label) return null;
    const opcao = _montagemOpcoesCache.find(o => o.modo === 'simples' && o.label === label);
    return opcao ? String(opcao.tipo).toUpperCase() : null;
  }

  /* Referências Chart.js */
  let charts = {};

  /* ── Combinações cor+forma → tipo simples ─────────────────
     Antes 100% fixo no código (só reconhecia 2P/SP/3T/1T). Agora vem de
     config.json (marcadores_qualidade.opcoes) — qualquer tipo simples
     novo cadastrado em Configurações → Montagem só ganha uma combinação
     de marcação quando alguém definir uma explicitamente (ver "📖
     Referência" → "Tipos sem marcação definida", mais abaixo). Até lá,
     ou enquanto config.json ainda não carregou, usa exatamente o
     comportamento de sempre (COMBINACOES_PADRAO) — ninguém que já usa
     2P/SP/3T/1T é afetado por esta mudança. */
  const COMBINACOES_PADRAO = [
    { tipo: '2p', forma: 'circle',      corModificadora: null },
    { tipo: 'sp', forma: 'dash',        corModificadora: null },
    { tipo: '3t', forma: 'circle+dash', corModificadora: 'amarelo' },
    { tipo: '1t', forma: 'circle+dash', corModificadora: 'laranja' },
  ];
  // Vermelho NUNCA entra aqui — é sempre o círculo de "reprovado" em
  // QUALQUER combinação (regra fixa, não configurável). Verde/azul
  // também são sempre o par "aprovado 1ª/2ª linha" em toda combinação —
  // a única coisa que realmente varia de tipo pra tipo é a FORMA (círculo
  // sozinho / traço sozinho / círculo+traço) e, quando combinada, a COR
  // do traço modificador.
  const CORES_MARCACAO = ['verde', 'vermelho', 'azul', 'amarelo', 'laranja'];
  const CORES_RESERVADAS_APROVACAO = ['verde', 'azul', 'vermelho'];

  function _combinacoesEfetivas() {
    return (Array.isArray(_marcadoresQualidadeCache) && _marcadoresQualidadeCache.length)
      ? _marcadoresQualidadeCache
      : COMBINACOES_PADRAO;
  }

  /* ── Classificação de marcas ──────────────────────────── */
  function classifyMarks(marks) {
    const circles = marks.filter(m => m.shape === 'circle');
    const dashes  = marks.filter(m => m.shape === 'dash');
    const cor     = arr => arr.length ? arr[0].color : null;
    const ok      = c => c === 'verde' || c === 'azul';
    const combinacoes = _combinacoesEfetivas();

    if (circles.length && dashes.length) {
      const cc = cor(circles), dc = cor(dashes);
      const combo = combinacoes.find(c => c.forma === 'circle+dash' && c.corModificadora === dc);
      if (combo) {
        if (ok(cc)) return `${combo.tipo.toUpperCase()} aprovado`;
        if (cc === 'vermelho') return `${combo.tipo.toUpperCase()} reprovado`;
      }
      return 'Múltiplas';
    }
    if (circles.length) {
      const combo = combinacoes.find(c => c.forma === 'circle');
      const c = cor(circles);
      if (combo) {
        if (ok(c)) return `${combo.tipo.toUpperCase()} aprovado`;
        if (c === 'vermelho') return `${combo.tipo.toUpperCase()} reprovado`;
      }
      return 'Outros';
    }
    if (dashes.length) {
      const combo = combinacoes.find(c => c.forma === 'dash');
      const c = cor(dashes);
      if (combo) {
        if (ok(c)) return `${combo.tipo.toUpperCase()} aprovado`;
        if (c === 'vermelho') return `${combo.tipo.toUpperCase()} reprovado`;
      }
      return 'Outros';
    }
    return 'Sem marcação';
  }
  function getClassifiedInfo(marks) {
    const s = classifyMarks(marks);
    if (['Sem marcação', 'Múltiplas', 'Outros'].includes(s))
      return { tipoObtido: s, resultado: s.toLowerCase().replace(' ', '_'), linha: null };
    const [tipo, resultado] = s.split(' ');
    // "linha" é um dado A MAIS — nunca muda o valor de "resultado" (seguem
    // sendo só 'aprovado'/'reprovado', como sempre foram), porque o resto
    // do código já compara `p.resultado === 'aprovado'` em vários lugares
    // (KPIs, gráficos, resumo) pra decidir o que conta como aprovação —
    // um painel de 2ª linha PRECISA continuar contando como aprovado ali.
    const linha = resultado === 'aprovado' ? _linhaDoAprovado(marks) : null;
    return { tipoObtido: tipo, resultado, linha };
  }

  // Verde = 1ª linha, Azul = 2ª linha — mesma cor que decidiu "aprovado"
  // em classifyMarks() (a do círculo quando existe — cobre 2P sozinho e
  // 3T/1T combinado; a do próprio traço quando só há traço — cobre SP).
  function _linhaDoAprovado(marks) {
    const circles = marks.filter(m => m.shape === 'circle');
    const dashes  = marks.filter(m => m.shape === 'dash');
    const corAprovacao = circles.length ? circles[0].color : (dashes.length ? dashes[0].color : null);
    if (corAprovacao === 'verde') return '1ª';
    if (corAprovacao === 'azul')  return '2ª';
    return null;
  }

  /* ── Referência de Marcadores: tipos sem combinação definida ──────
     Compara os tipos simples cadastrados em Configurações → Montagem
     (tipos_montagem.opcoes) com as combinações já definidas
     (marcadores_qualidade.opcoes) — qualquer tipo simples cadastrado
     que ainda não tenha uma combinação aparece aqui, com a opção de
     definir uma (só entre as que ainda não estão em uso por outro
     tipo — nunca duas combinações pro mesmo par cor+forma). */
  function _tiposSimplesSemCombinacao() {
    const simples = (_montagemOpcoesCache || []).filter(o => o && o.modo === 'simples' && o.tipo && o.label);
    const combinacoes = _combinacoesEfetivas();
    return simples.filter(o => !combinacoes.some(c => c.tipo === o.tipo));
  }

  // Combinações "de slot" ainda livres — círculo sozinho, traço sozinho,
  // e círculo+traço com uma cor modificadora que ainda não está em uso.
  // Vermelho/verde/azul NUNCA aparecem aqui como cor modificadora (ver
  // CORES_RESERVADAS_APROVACAO, acima) — são sempre o par aprovado/
  // reprovado, em toda combinação, não um jeito de diferenciar tipos.
  function _combinacoesDisponiveis() {
    const combinacoes = _combinacoesEfetivas();
    const disponiveis = [];
    if (!combinacoes.some(c => c.forma === 'circle'))
      disponiveis.push({ forma: 'circle', corModificadora: null, label: 'Círculo sozinho' });
    if (!combinacoes.some(c => c.forma === 'dash'))
      disponiveis.push({ forma: 'dash', corModificadora: null, label: 'Traço sozinho' });
    CORES_MARCACAO.filter(c => !CORES_RESERVADAS_APROVACAO.includes(c)).forEach(corMod => {
      if (!combinacoes.some(c => c.forma === 'circle+dash' && c.corModificadora === corMod)) {
        disponiveis.push({ forma: 'circle+dash', corModificadora: corMod, label: `Círculo + traço ${corMod}` });
      }
    });
    return disponiveis;
  }

  // Monta a seção dinâmica dentro do popover "📖 Referência" — chamada
  // sempre que config.json é recarregado (_carregarOpcoesMontagem) e
  // depois de salvar uma combinação nova (ver salvarCombinacaoTipo).
  function _renderAvisoCombinacoesFaltando() {
    const el = document.getElementById('sq-ref-sem-combinacao');
    if (!el) return;
    const semCombinacao = _tiposSimplesSemCombinacao();
    if (!semCombinacao.length) { el.innerHTML = ''; return; }

    const disponiveis = _combinacoesDisponiveis();
    el.innerHTML = `
      <hr class="divider" style="margin:10px 0">
      <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);font-weight:700;margin-bottom:8px">
        ⚠️ Tipos sem marcação definida
      </div>
      ${semCombinacao.map(o => `
        <div class="sq-ref-tipo-pendente" id="sq-ref-pendente-${o.tipo}">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <span style="font-size:.82rem"><strong>${LW.escaparHtml(o.label)}</strong> (${String(o.tipo).toUpperCase()})</span>
            ${disponiveis.length
              ? `<button type="button" class="btn btn-ghost btn-sm" onclick="SQ.abrirDefinirCombinacao('${o.tipo}')">Definir combinação</button>`
              : `<span style="font-size:.72rem;color:var(--text-3)">Nenhuma combinação disponível</span>`}
          </div>
          <div id="sq-ref-picker-${o.tipo}" style="display:none;margin-top:8px"></div>
        </div>`).join('')}
    `;
  }

  // Abre o seletor de combinação disponível pra um tipo específico —
  // aparece embutido, logo abaixo do tipo, dentro do próprio popover.
  function abrirDefinirCombinacao(tipo) {
    const picker = document.getElementById(`sq-ref-picker-${tipo}`);
    if (!picker) return;
    const disponiveis = _combinacoesDisponiveis();
    if (!disponiveis.length) return; // botão nem deveria existir nesse caso
    const opcoesHtml = disponiveis.map((c, i) =>
      `<option value="${i}">${c.label}</option>`
    ).join('');
    picker.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center">
        <select class="form-input form-select" id="sq-ref-select-${tipo}" style="font-size:.78rem;flex:1">${opcoesHtml}</select>
        <button type="button" class="btn btn-primary btn-sm" onclick="SQ.salvarCombinacaoTipo('${tipo}')">Salvar</button>
      </div>`;
    picker.style.display = 'block';
    picker.dataset.disponiveis = JSON.stringify(disponiveis);
  }

  // Grava a combinação escolhida em config.json (marcadores_qualidade.
  // opcoes) via /salvar-config — mesma rota que Configurações usa pra
  // qualquer alteração (reenvia o config.json INTEIRO, não só o pedaço
  // que mudou, porque é assim que /salvar-config funciona: substitui o
  // arquivo por completo). Revalida contra o config.json mais recente
  // antes de gravar — se ALGUÉM MAIS já tiver usado essa combinação
  // enquanto o picker estava aberto aqui, recusa e avisa, em vez de
  // gravar 2 tipos na mesma combinação.
  async function salvarCombinacaoTipo(tipo) {
    const picker = document.getElementById(`sq-ref-picker-${tipo}`);
    const select = document.getElementById(`sq-ref-select-${tipo}`);
    if (!picker || !select) return;
    const disponiveis = JSON.parse(picker.dataset.disponiveis || '[]');
    const escolhida = disponiveis[parseInt(select.value, 10)];
    if (!escolhida) return;

    try {
      const res = await fetch('/db/config.json');
      if (!res.ok) throw new Error('Falha ao buscar config.json atualizado.');
      const cfg = await res.json();
      const atuais = Array.isArray(cfg?.marcadores_qualidade?.opcoes) ? cfg.marcadores_qualidade.opcoes : [];
      // Revalidação: já existe combinação pra este tipo, ou a combinação
      // escolhida já foi usada por outro tipo enquanto o picker estava
      // aberto? Nos 2 casos, recusa — só pode existir 1 combinação por
      // tipo, e 1 tipo por combinação.
      if (atuais.some(c => c.tipo === tipo)) {
        showAlert('Aviso', 'Este tipo já ganhou uma combinação (talvez em outra aba/dispositivo). Recarregando a referência...');
        _carregarOpcoesMontagem();
        return;
      }
      if (atuais.some(c => c.forma === escolhida.forma && c.corModificadora === escolhida.corModificadora)) {
        showAlert('Aviso', 'Essa combinação acabou de ser usada por outro tipo (talvez em outra aba/dispositivo). Escolha outra.');
        abrirDefinirCombinacao(tipo); // reabre com a lista de disponíveis já atualizada
        _carregarOpcoesMontagem();
        return;
      }

      const novaLista = [...atuais, { tipo, forma: escolhida.forma, corModificadora: escolhida.corModificadora }];
      cfg.marcadores_qualidade = { opcoes: novaLista };

      const salvar = await fetch('/salvar-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      if (!salvar.ok) throw new Error('O servidor recusou salvar.');

      _marcadoresQualidadeCache = novaLista;
      _configBrutoCache = cfg;
      _renderAvisoCombinacoesFaltando();
      showAlert('Salvo', `Combinação definida para ${tipo.toUpperCase()} — já pode marcar painéis desse tipo.`);
    } catch (err) {
      console.error('Falha ao salvar combinação de marcação:', err);
      showAlert('Erro', 'Não consegui salvar a combinação agora (' + err.message + '). Tente de novo.');
    }
  }

  /* ── Tipo esperado de uma placa ───────────────────────── */
  function getExpectedType(id) {
    if (slabConfig[id]) return slabConfig[id];
    const idx = ['stack1','stack2','stack3','stack4'].indexOf(id.split('-')[0]);
    return idx === -1 ? '' : palletTypes[idx] || '';
  }

  /* ── Tipo de montagem → dropdown ─────────────────────── */
  function updateMountTypeDropdown() {
    const s = document.getElementById('sq-mountType');
    if (Object.keys(slabConfig).length) { s.value = 'Personalizada'; return; }
    if (palletTypes[0]==='SP'&&palletTypes[1]==='SP'&&palletTypes[2]==='2P'&&palletTypes[3]==='2P') { s.value='SP+2P'; return; }
    const uniq = [...new Set(palletTypes.filter(Boolean))];
    s.value = uniq.length === 1 && !palletTypes.some(v => !v) ? uniq[0] : '';
  }

  function changeMountType() {
    const val = document.getElementById('sq-mountType').value;
    if (val === 'Personalizada') { openPalletModal(); return; }
    slabConfig = {};
    // Qualquer valor que não seja vazio nem "SP+2P" é um preset uniforme
    // (os 4 pallets do mesmo tipo) — o próprio <select> só oferece os
    // tipos que existem de verdade em config.json (ver
    // _carregarOpcoesMontagem), então não precisa mais checar contra uma
    // lista fixa aqui.
    palletTypes = val === 'SP+2P' ? ['SP','SP','2P','2P'] :
                  val ? [val,val,val,val] :
                  ['','','',''];
    renderStacks();
    validateAllSlabs();
  }

  /* ── Validação de consistência ────────────────────────── */
  function validateAllSlabs() {
    document.querySelectorAll('.sq-slab.invalid').forEach(el => el.classList.remove('invalid'));
    let hasError = false, msgs = [];
    ['stack1','stack2','stack3','stack4'].forEach(sid => {
      const stack = document.getElementById(sid);
      if (!stack) return;
      stack.querySelectorAll('.sq-slab').forEach(slab => {
        const id  = slab.dataset.id;
        const exp = getExpectedType(id);
        if (!exp) return;
        const cls = classifyMarks(slabState[id] || []);
        if (cls === 'Sem marcação') return;
        if (!cls.includes(exp)) {
          slab.classList.add('invalid');
          hasError = true;
          msgs.push(`Placa ${id} (esperado: ${exp})`);
        }
      });
    });
    return { hasError, msgs };
  }

  /* ── Render das pilhas de placas ──────────────────────── */
  function renderStacks() {
    const n = parseInt(document.getElementById('sq-thickness').value);
    ['stack1','stack2','stack3','stack4'].forEach((sid, idx) => {
      const stack = document.getElementById(sid);
      stack.innerHTML = '';
      for (let i = 1; i <= n; i++) {
        const slab = document.createElement('div');
        slab.className = 'sq-slab';
        const id = `${sid}-${i}`;
        slab.dataset.id = id;

        const num = document.createElement('span');
        num.className = 'sq-slab-number';
        num.textContent = i;
        slab.appendChild(num);

        const tp = document.createElement('span');
        tp.className = 'sq-slab-type';
        const exp = getExpectedType(id);
        if (exp) {
          tp.textContent = exp;
          const classMap = { SP:'sp','2P':'p2','3T':'t3','1T':'t1' };
          if (classMap[exp]) tp.classList.add(classMap[exp]);
        }
        slab.appendChild(tp);

        const mc = document.createElement('div');
        mc.className = 'sq-slab-marks';
        slab.appendChild(mc);

        if (slabState[id]) renderMarks(slab, slabState[id]);
        slab.addEventListener('click', () => toggleMark(slab));
        stack.appendChild(slab);
      }
    });
    validateAllSlabs();
  }

  function renderMarks(slabEl, marks) {
    const c = slabEl.querySelector('.sq-slab-marks');
    c.innerHTML = '';
    const root = getComputedStyle(document.documentElement);
    marks.forEach(m => {
      const el = document.createElement('span');
      el.className = m.shape === 'dash' ? 'sq-mark-dash' : 'sq-mark-circle';
      const varMap = { verde:'--sq-cor-verde', vermelho:'--sq-cor-vermelho', azul:'--sq-cor-azul', amarelo:'--sq-cor-amarelo', laranja:'--sq-cor-laranja' };
      el.style.backgroundColor = root.getPropertyValue(varMap[m.color] || '--sq-cor-verde').trim();
      c.appendChild(el);
    });
  }

  function toggleMark(el) {
    if (viewMode) return;
    pushState();
    const id = el.dataset.id;
    if (!slabState[id]) slabState[id] = [];
    const idx = slabState[id].findIndex(m => m.color === selectedColor && m.shape === selectedShape);
    if (idx !== -1) slabState[id].splice(idx, 1);
    else slabState[id].push({ color: selectedColor, shape: selectedShape });
    renderMarks(el, slabState[id]);
    validateAllSlabs();
  }

  /* ── Seleção de cor / forma ───────────────────────────── */
  function selectColor(btn, color) {
    if (viewMode) return;
    document.querySelectorAll('.sq-btn-color').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedColor = color;
  }
  function selectShape(btn, shape) {
    if (viewMode) return;
    document.querySelectorAll('.sq-btn-shape').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedShape = shape;
  }

  // ── Atalhos de teclado: nº = cor, Ctrl+nº = forma ───────────────────
  // Numeração segue a ORDEM que os botões aparecem na tela (mesma ordem
  // do DOM — ver querySelectorAll abaixo), não uma lista fixa aqui: hoje
  // são 5 cores e 2 formas, mas adicionar uma 6ª cor ou uma 3ª forma no
  // HTML (public/setor-qualidade-app.html) já funciona sozinho, sem
  // tocar neste código — a tecla "6" ou "Ctrl+3" simplesmente passam a
  // existir. Os badges numerados nos próprios botões (ver CSS,
  // counter-increment em .sq-btn-color/.sq-btn-shape) seguem a MESMA
  // ordem, então o que a pessoa vê no botão é sempre a tecla certa.
  // "Ctrl+nº" no Windows/Linux e "Cmd+nº" no Mac (metaKey) fazem a mesma
  // coisa — nenhum dos dois tem atalho de navegador conflitante na
  // maioria dos casos, mas se um dia conflitar, dá pra trocar aqui.
  function _sqAtalhoTeclado(e) {
    // Só dispara na tela de Avaliação (é onde os botões de cor/forma
    // existem) e nunca em modo só-leitura (visualizando um registro).
    if (viewMode) return;
    const secForm = document.getElementById('sq-form');
    if (!secForm || !secForm.classList.contains('active')) return;
    // Nunca captura enquanto a pessoa está digitando em algum campo
    // (data, temperatura, observações etc.) — "1", "2"... aí são só
    // números normais sendo digitados, não um atalho.
    const alvo = e.target;
    const tag = (alvo.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || alvo.isContentEditable) return;
    // Só dígitos 1-9 (nunca "0" — não existe "0ª cor/forma").
    if (!/^[1-9]$/.test(e.key)) return;

    const idx = parseInt(e.key, 10) - 1; // '1' -> índice 0 (1º botão na tela)
    const grupo = (e.ctrlKey || e.metaKey)
      ? document.querySelectorAll('.sq-btn-shape')
      : document.querySelectorAll('.sq-btn-color');
    const btn = grupo[idx];
    if (!btn) return; // nº maior do que a quantidade de cores/formas hoje — ignora
    e.preventDefault();
    btn.click(); // dispara o onclick já existente (SQ.selectColor/selectShape) — nenhuma lógica duplicada aqui
  }
  document.addEventListener('keydown', _sqAtalhoTeclado);

  // ── Repassa atalhos de NAVEGAÇÃO ENTRE PÁGINAS (Alt+dígito, Alt+P,
  //    Alt+Q, Alt+seta) pro documento PAI ─────────────────────────────
  // Setor de Qualidade roda dentro de um <iframe> (ver public/index.html,
  // #setor-qualidade-frame) — um documento à parte, com foco próprio.
  // Os atalhos de "viagem entre páginas" (Alt+1..0, Alt+P/Q, Alt+←/→)
  // são tratados só no documento PAI (ver keyboard-shortcuts.js, que só
  // é carregado no index.html, nunca aqui dentro) — e evento de teclado
  // NUNCA atravessa a fronteira de um iframe sozinho. Resultado: assim
  // que a pessoa clica em QUALQUER coisa aqui dentro (o que move o foco
  // do navegador pra dentro do iframe), o documento pai para de receber
  // esses eventos e os atalhos de navegação somem — exatamente o
  // comportamento reportado. Como o iframe é da MESMA origem (mesmo
  // servidor), dá pra repassar o evento manualmente pro `document` do
  // pai, onde o listener de verdade mora, e ele reage normalmente.
  // Só repassa combos com Alt — são os ÚNICOS usados pra navegação entre
  // páginas; nunca colide com os atalhos de cor/forma daqui em cima
  // (_sqAtalhoTeclado, dígito puro ou Ctrl+dígito, nunca Alt).
  document.addEventListener('keydown', function (e) {
    if (!e.altKey) return; // só o que é atalho de navegação
    if (window.parent === window) return; // aberto direto, fora de um iframe — nada a repassar
    // Mesma cautela do keyboard-shortcuts.js no pai: não repassa
    // enquanto a pessoa está digitando em algum campo AQUI dentro.
    const alvo = document.activeElement;
    const tag = (alvo?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || alvo?.isContentEditable) return;
    try {
      window.parent.document.dispatchEvent(new KeyboardEvent('keydown', {
        key: e.key, code: e.code, keyCode: e.keyCode, which: e.which,
        ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey,
        bubbles: true, cancelable: true,
      }));
    } catch (err) {
      // Mesma origem devia sempre permitir isto — se por algum motivo
      // falhar, só ignora; um atalho de navegação que não repassou não
      // pode quebrar o resto da página.
    }
  });

  /* ── Ações em lote (pallet inteiro) ──────────────────── */
  function applyMarksToPallet(stackId, color, shape) {
    if (viewMode) return;
    pushState();
    document.getElementById(stackId).querySelectorAll('.sq-slab').forEach(slab => {
      const id = slab.dataset.id;
      if (!slabState[id]) slabState[id] = [];
      if (!slabState[id].find(m => m.color === color && m.shape === shape))
        slabState[id].push({ color, shape });
      renderMarks(slab, slabState[id]);
    });
    validateAllSlabs();
  }
  function selectAllPallet(sid) { applyMarksToPallet(sid, selectedColor, selectedShape); }
  function applyColorToPallet(sid, color) { closeAllDropdowns(); applyMarksToPallet(sid, color, selectedShape); }

  /* ── Dropdowns de cor por pallet ──────────────────────── */
  function toggleDropdown(btn, sid) {
    if (viewMode) return;
    const menu = document.getElementById(`sq-dd-${sid}`);
    const open = menu.classList.contains('open');
    closeAllDropdowns();
    if (!open) menu.classList.add('open');
    event.stopPropagation();
  }
  function closeAllDropdowns() {
    document.querySelectorAll('.sq-color-dropdown').forEach(el => el.classList.remove('open'));
  }
  document.addEventListener('click', e => {
    if (!e.target.closest('.sq-pallet-header')) closeAllDropdowns();
  });

  // ── "Em Andamento" e "Fila" — retraídos por padrão, mesmo padrão de
  // toggle/fechar-ao-clicar-fora do toggleDropdown acima. Só 1 aberto por
  // vez (closeAllCollapsibles fecha o outro antes de abrir o clicado).
  // nome: 'andamento' ou 'fila' -> alvo #sq-andamento-wrap / #sq-fila-wrap.
  function toggleCollapsible(nome) {
    if (viewMode) return;
    const wrap = document.getElementById(`sq-${nome}-wrap`);
    if (!wrap) return;
    const open = wrap.classList.contains('open');
    closeAllCollapsibles();
    if (!open) wrap.classList.add('open');
    event.stopPropagation();
  }
  function closeAllCollapsibles() {
    document.querySelectorAll('.sq-collapsible').forEach(el => el.classList.remove('open'));
  }
  document.addEventListener('click', e => {
    if (!e.target.closest('.sq-collapsible')) closeAllCollapsibles();
  });

  // ── Popover de Referência dos Marcadores — mesmo padrão do botão
  // "📖 Referências" da página Registrar Operação (LWOp.togglePopover,
  // operacao.js): 1 classe .active por vez, fecha ao clicar fora.
  function togglePopover(id, ev) {
    if (ev) ev.stopPropagation();
    const el = document.getElementById(id);
    if (!el) return;
    const wasActive = el.classList.contains('active');
    document.querySelectorAll('.ao-popover').forEach(p => p.classList.remove('active'));
    if (!wasActive) el.classList.add('active');
  }
  document.addEventListener('click', e => {
    if (!e.target.closest('.ao-popover') && !e.target.closest('.btn-sm')) {
      document.querySelectorAll('.ao-popover').forEach(p => p.classList.remove('active'));
    }
  });

  /* ── Histórico de ações (desfazer) ───────────────────── */
  function pushState() {
    actionHistory.push(JSON.parse(JSON.stringify(slabState)));
    if (actionHistory.length > 30) actionHistory.shift();
  }

  /* ── Modal de configuração personalizada de pallet ────── */
  function openPalletModal() {
    tempSlabConfig = { ...slabConfig };
    const n   = parseInt(document.getElementById('sq-thickness').value);
    const box = document.getElementById('sq-modal-slabs-grid');
    box.innerHTML = '';
    ['stack1','stack2','stack3','stack4'].forEach((sid, idx) => {
      const col   = document.createElement('div');
      col.className = 'sq-modal-pallet-col';
      const lbl  = document.createElement('div');
      lbl.className = 'sq-modal-col-label';
      lbl.textContent = `PALLET ${idx + 1}`;
      col.appendChild(lbl);
      for (let i = 1; i <= n; i++) {
        const slab = document.createElement('div');
        slab.className = 'sq-modal-slab';
        const id = `${sid}-${i}`;
        slab.dataset.id = id;
        const num = document.createElement('span'); num.className = 'sq-m-num'; num.textContent = i; slab.appendChild(num);
        const tp  = document.createElement('span'); tp.className  = 'sq-m-tp';
        const val = tempSlabConfig[id] || '';
        if (val) { tp.textContent = val; const cm = { SP:'sp','2P':'p2','3T':'t3','1T':'t1' }; if (cm[val]) tp.classList.add(cm[val]); }
        slab.appendChild(tp);
        slab.addEventListener('click', function () {
          const key = this.dataset.id, tpEl = this.querySelector('.sq-m-tp');
          if (tempSlabConfig[key] === modalTipoSel) {
            delete tempSlabConfig[key]; tpEl.textContent = ''; tpEl.className = 'sq-m-tp'; this.classList.remove('sel');
          } else {
            tempSlabConfig[key] = modalTipoSel; tpEl.textContent = modalTipoSel;
            const cm = { SP:'sp','2P':'p2','3T':'t3','1T':'t1' };
            tpEl.className = `sq-m-tp ${cm[modalTipoSel] || ''}`; this.classList.add('sel');
          }
        });
        col.appendChild(slab);
      }
      box.appendChild(col);
    });
    document.getElementById('sq-modal-pallet').classList.add('open');
  }
  function closePalletModal() { document.getElementById('sq-modal-pallet').classList.remove('open'); }
  function setModalTipo(type) {
    modalTipoSel = type;
    const cm = { SP:'sp','2P':'p2','3T':'t3','1T':'t1' };
    document.querySelectorAll('.sq-btn-tipo').forEach(b => b.classList.remove('active'));
    document.querySelector(`.sq-btn-tipo.${cm[type]}`).classList.add('active');
  }
  function clearModalPlates() {
    tempSlabConfig = {};
    document.querySelectorAll('.sq-modal-slab .sq-m-tp').forEach(el => { el.textContent = ''; el.className = 'sq-m-tp'; });
    document.querySelectorAll('.sq-modal-slab').forEach(el => el.classList.remove('sel'));
  }
  function confirmPalletModal() {
    slabConfig = { ...tempSlabConfig };
    palletTypes = ['','','',''];
    updateMountTypeDropdown();
    renderStacks();
    validateAllSlabs();
    closePalletModal();
  }

  /* ── Navegação interna ────────────────────────────────── */
  function navigateTo(section) {
    if (viewMode && section !== 'form') exitViewMode();
    document.querySelectorAll('.sq-section').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.sq-nav-btn').forEach(el => el.classList.remove('active'));
    const sec = document.getElementById('sq-' + section);
    const nav = document.getElementById('sq-nav-' + section);
    if (sec) sec.classList.add('active');
    if (nav) nav.classList.add('active');
    // "Em Andamento" deixou de ser uma tela própria — agora é um dos 2
    // colapsáveis dentro da própria aba "Avaliação" (ver renderDrafts,
    // toggleCollapsible), junto com a Fila. Por isso os dois são
    // atualizados juntos, sempre que a aba "form" é aberta.
    if (section === 'form')      { carregarFilaNaoAvaliadas(); renderDrafts(); }
    if (section === 'history')   { renderHistory(); carregarAvaliacoesQualidade().then(renderHistory); }
    if (section === 'dashboard') { renderDashboard(); carregarAvaliacoesQualidade().then(renderDashboard); }
  }
  function goBack() { if (viewMode) exitViewMode(); navigateTo(viewSource); }

  // Aba "🧪 Avaliação" (topbar) chama isto direto — abre o formulário em
  // branco (avaliação avulsa, sem vincular a nenhuma operação ainda) já
  // COM a fila de baterias pendentes visível acima do cabeçalho do
  // formulário (ver carregarFilaNaoAvaliadas, abaixo). Clicar num item da
  // fila vincula e preenche; não precisa mais de um botão "Nova
  // Avaliação" separado nem de nenhum passo intermediário.
  function startNew() {
    _iniciarForm(null);
  }

  function _iniciarForm(operacaoVinculada) {
    if (viewMode) exitViewMode();
    clearForm();
    currentDraftId = null;
    linkedOperacaoId = operacaoVinculada ? operacaoVinculada.id : null;
    navigateTo('form');
    if (operacaoVinculada) {
      _prefillFromOperacao(operacaoVinculada);
    } else {
      autoSetThickness();
    }
    setEditable(true);
  }

  // Pré-preenche ID da Bateria, Turno, Tipo de Montagem e — se a operação
  // for Montagem Personalizada — a grade inteira, a partir dos dados reais
  // da operação escolhida na fila (ver GET /operacoes-nao-avaliadas,
  // server.js).
  function _prefillFromOperacao(op) {
    // ── ID da Bateria ──────────────────────────────────────────────────
    if (op.id_bateria) {
      const sel = document.getElementById('sq-batteryId');
      const existe = Array.from(sel.options).some(o => o.value === op.id_bateria);
      if (!existe) {
        // Convenção de nome pode divergir entre os dois módulos (ex:
        // "B5-7,5cm" em Registro de Baterias vs "B5-7.5" aqui) — em vez de
        // deixar o campo errado ou vazio, injeta a opção real na hora.
        const novaOpcao = document.createElement('option');
        novaOpcao.value = op.id_bateria;
        novaOpcao.textContent = op.id_bateria;
        sel.appendChild(novaOpcao);
      }
      sel.value = op.id_bateria;
    }

    // ── Turno ────────────────────────────────────────────────────────
    // Compara só o dígito inicial: Registro de Baterias usa "1º TURNO"
    // (U+00BA, ordinal masculino) e aqui é "1° TURNO" (U+00B0, grau) —
    // visualmente idênticos, mas caracteres diferentes; nunca batem
    // com === direto.
    if (op.turno) {
      const digito = String(op.turno).match(/\d/)?.[0];
      if (digito) {
        const turnoSel = document.getElementById('sq-turno');
        const opcaoTurno = Array.from(turnoSel.options).find(o => o.value.startsWith(digito));
        if (opcaoTurno) turnoSel.value = opcaoTurno.value;
      }
    }

    // ── Espessura/pallet (nº de placas por pallet) ──────────────────────
    // autoSetThickness() adivinha isso a partir do ID da Bateria (só 3
    // valores fixos: 11/10/8) — mas usa o MESMO id com risco de
    // divergência de nome do passo acima, e nem sempre bate exatamente
    // com o nº real de berços da operação (12cm, por ex., tem 18 berços
    // reais mas o palpite fixo assume 8/pallet = 32 painéis, não 36).
    // _definirThicknessReal (abaixo) corrige com o valor REAL depois.
    autoSetThickness();
    const capacidadeReal = parseInt(op.bercos_reais) || parseInt(op.capacidade) || 0;
    if (capacidadeReal > 0) _definirThicknessReal(capacidadeReal);

    // ── Tipo de Montagem (+ grade Personalizada) ────────────────────────
    if (op.tipo_montagem === 'PERSONALIZADA') {
      document.getElementById('sq-mountType').value = 'Personalizada';
      slabConfig = _montarSlabConfigDeBercos(op.bercos_personalizados);
      palletTypes = ['', '', '', ''];
    } else {
      const codigo = _codigoMontagemPorLabel(op.tipo_montagem);
      if (codigo) {
        document.getElementById('sq-mountType').value = codigo;
        palletTypes = [codigo, codigo, codigo, codigo];
        slabConfig = {};
      }
      // Não encontrado (ex: tipo híbrido — "HÍBRIDA 2p/sp" não tem preset
      // equivalente aqui, já que aqui é 2 pallets inteiros de cada tipo,
      // não 1+1 por berço; ou tipo desconhecido) — deixa em branco pra
      // pessoa escolher manualmente, não arrisca mapear errado.
    }
    updateMountTypeDropdown();
    renderStacks();
    validateAllSlabs();
  }

  // Corrige #sq-thickness pro nº real de berços da operação (cada berço =
  // 2 painéis — ver README/db.js, "Berços Visuais") em vez do palpite fixo
  // de autoSetThickness() por ID de bateria. Injeta uma option nova se o
  // valor calculado não for um dos 3 fixos (11/10/8) — mesmo raciocínio
  // de injetar o ID da Bateria, acima: nunca deixar o campo errado.
  function _definirThicknessReal(capacidadeReal) {
    const n = Math.round(capacidadeReal / 2);
    if (!n || n <= 0) return;
    const sel = document.getElementById('sq-thickness');
    const existe = Array.from(sel.options).some(o => o.value === String(n));
    if (!existe) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = `${capacidadeReal} berços (${n}/pallet)`;
      sel.appendChild(opt);
    }
    sel.value = String(n);
  }

  // Monta o slabConfig (mesmo formato usado pelo modal de Configuração
  // Personalizada — ver confirmPalletModal) a partir de
  // bercos_personalizados de uma operação real: 1 item por berço (tipo
  // curto — 'sp'/'2p'/'3t' — ou null). Cada berço = 2 painéis
  // CONSECUTIVOS (ver README/db.js, "Berços Visuais") — daí o
  // paineis.push(cod, cod) — e os painéis são distribuídos sequencialmente
  // pelos 4 pallets, #sq-thickness posições cada (a mesma conta que já
  // bate pra 9cm/7,5cm — ver _definirThicknessReal pra quando não bate).
  function _montarSlabConfigDeBercos(bercosPersonalizados) {
    const bercos = Array.isArray(bercosPersonalizados) ? bercosPersonalizados : [];
    const n = parseInt(document.getElementById('sq-thickness').value) || 10;
    const paineis = [];
    bercos.forEach(tipo => {
      const cod = tipo ? String(tipo).toUpperCase() : ''; // 'sp' -> 'SP', '2p' -> '2P', '3t' -> '3T'
      paineis.push(cod, cod);
    });
    const novo = {};
    for (let p = 0; p < 4; p++) {
      for (let i = 1; i <= n; i++) {
        const idx = p * n + (i - 1);
        const tipo = paineis[idx];
        if (tipo) novo[`stack${p + 1}-${i}`] = tipo;
      }
    }
    return novo;
  }

  // ── Painel da fila (dentro da aba "🧪 Avaliação", acima do
  //    "Cabeçalho do registro" — ver setor-qualidade-app.html) ────────
  // Ordem de PREVISÃO DE DESEMPLAQUE: como o desemplaque é sempre "fim da
  // injeção + tempo fixo de cura" (mesmo intervalo pra todas), a operação
  // com o "fim" mais antigo é sempre a que desemplaca (e por isso pode
  // ser avaliada) primeiro — /operacoes-nao-avaliadas já devolve a lista
  // nessa ordem (fim ASC, ver server.js), então a posição no array JÁ É
  // a posição na fila: 1º item = 1ª, 2º item = 2ª, etc. Não precisa
  // guardar essa posição em lugar nenhum — ao recarregar a fila (depois
  // de registrar uma avaliação, por exemplo), quem era 2ª vira 1ª
  // automaticamente, só por ter subido uma posição no array.
  //
  // Só as 3 primeiras posições viram cartão — da 4ª em diante fica num
  // <select> (ver sq-fila-outras-wrap no HTML), pra não lotar a tela
  // quando a fila for grande. Layout dos cartões, de cima pra baixo:
  //   3ª  2ª      (lado a lado, compactas)
  //      1ª       (linha própria, em destaque, com todos os detalhes)
  // Clicar em QUALQUER cartão (ou escolher no select + "Iniciar")
  // preenche o formulário inteiro (ver iniciarAvaliacaoDaFila /
  // iniciarAvaliacaoDoSelect, abaixo).
  function _filaOrdinal(posicao) { return posicao + 'ª'; }
  function _filaData(iso) {
    if (!iso) return '--';
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }
  function _filaHora(iso) {
    if (!iso) return '--';
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function _filaTipoLabel(tipoMontagem) {
    return tipoMontagem === 'PERSONALIZADA' ? 'Personalizada' : (tipoMontagem || '--');
  }
  // Destaca (classe .sq-fila-item-ativa) o item vinculado à avaliação
  // que está sendo preenchida NESTE momento (linkedOperacaoId) — assim
  // dá pra ver de relance qual bateria está em avaliação, mesmo com
  // várias pendentes na fila.
  function _filaClasseAtiva(op) {
    return op.id === linkedOperacaoId ? ' sq-fila-item-ativa' : '';
  }
  // Botão "X" de excluir — presente em TODO elemento da fila (cartão
  // compacto, cartão principal e também no <select> da 4ª posição em
  // diante, ver _filaOutrasExcluirBtn). event.stopPropagation() é
  // essencial aqui: o cartão inteiro também é clicável (inicia a
  // avaliação — ver iniciarAvaliacaoDaFila), sem isso o clique no "X"
  // "vazaria" pro cartão por baixo e abriria o formulário junto com a
  // exclusão.
  function _filaExcluirBtn(op) {
    return `<button type="button" class="sq-fila-item-excluir" onclick="event.stopPropagation(); SQ.excluirDaFila('${op.id}')" title="Excluir da fila (marca todos os painéis como &quot;Não avaliado no sistema&quot;)"><i class="fas fa-times"></i></button>`;
  }
  function _filaCartaoCompacto(op, posicao) {
    return `
      <div class="sq-fila-item${_filaClasseAtiva(op)}" role="button" tabindex="0" onclick="SQ.iniciarAvaliacaoDaFila('${op.id}')" onkeydown="if(event.key==='Enter')SQ.iniciarAvaliacaoDaFila('${op.id}')" title="Iniciar avaliação desta bateria">
        <span class="sq-fila-ordinal">${_filaOrdinal(posicao)}</span>
        <span class="sq-fila-item-info">
          <strong>${op.id_bateria || 'N/I'}</strong>
          <span>${_filaData(op.fim)} · ${_filaTipoLabel(op.tipo_montagem)}</span>
        </span>
        ${_filaExcluirBtn(op)}
      </div>`;
  }
  function _filaCartaoPrincipal(op, posicao) {
    return `
      <div class="sq-fila-item sq-fila-item-principal${_filaClasseAtiva(op)}" role="button" tabindex="0" onclick="SQ.iniciarAvaliacaoDaFila('${op.id}')" onkeydown="if(event.key==='Enter')SQ.iniciarAvaliacaoDaFila('${op.id}')" title="Iniciar avaliação desta bateria">
        <span class="sq-fila-ordinal">${_filaOrdinal(posicao)}</span>
        <span class="sq-fila-item-info">
          <strong>${op.id_bateria || 'N/I'}</strong>
          <span>${_filaData(op.fim)} · ${_filaHora(op.fim)} (fim da operação) · Montagem: ${_filaTipoLabel(op.tipo_montagem)}</span>
        </span>
        <i class="fas fa-play"></i>
        ${_filaExcluirBtn(op)}
      </div>`;
  }

  function carregarFilaNaoAvaliadas() {
    const listEl  = document.getElementById('sq-fila-list');
    if (!listEl) return; // painel só existe na aba "Avaliação"
    const outrasWrap = document.getElementById('sq-fila-outras-wrap');
    const sel         = document.getElementById('sq-fila-select');
    const badge       = document.getElementById('sq-fila-badge');

    fetch('/operacoes-nao-avaliadas')
      .then(r => r.json())
      .then(lista => {
        // Quem já tem RASCUNHO salvo (mesmo ainda não registrado) sai da
        // fila — já está "sendo avaliada", não faz sentido continuar
        // aparecendo como pendente pra outra pessoa escolher de novo.
        // Só a bateria vinculada à avaliação em edição AGORA (mesmo sem
        // rascunho salvo ainda) fica visível — e destacada (ver
        // _filaClasseAtiva) — pra quem a escolheu não perder a
        // referência dela na fila.
        const idsComRascunho = new Set(
          getDrafts().map(d => d.linkedOperacaoId).filter(Boolean)
        );
        filaOperacoes = (Array.isArray(lista) ? lista : [])
          .filter(op => op.id === linkedOperacaoId || !idsComRascunho.has(op.id));

        if (badge) {
          badge.textContent = String(filaOperacoes.length);
          badge.classList.toggle('sq-badge-ativo', filaOperacoes.length > 0);
        }

        if (!filaOperacoes.length) {
          outrasWrap.style.display = 'none';
          listEl.innerHTML = '<span class="sq-fila-pendentes-vazio"><i class="fas fa-check-circle"></i> Nenhuma bateria pendente de avaliação no momento.</span>';
          return;
        }

        const [terceira, segunda, primeira] = [filaOperacoes[2], filaOperacoes[1], filaOperacoes[0]];
        const outras = filaOperacoes.slice(3); // 4ª em diante

        // 4ª em diante — só o select, sem cartão.
        if (outras.length) {
          sel.innerHTML = outras.map((op, i) => {
            const posicao = i + 4;
            const dt = op.fim ? `${_filaData(op.fim)} ${_filaHora(op.fim)}` : '--';
            return `<option value="${op.id}">${_filaOrdinal(posicao)} · ${op.id_bateria || 'N/I'} · ${_filaTipoLabel(op.tipo_montagem)} · ${dt}</option>`;
          }).join('');
          outrasWrap.style.display = 'flex';
          // "X" aplicado ao item ATUALMENTE selecionado no <select> — não
          // dá pra ter um "X" por <option> (HTML não permite botão dentro
          // de option), então este único botão excluir sempre a escolha
          // corrente do dropdown (ver excluirDaFila/iniciarAvaliacaoDoSelect).
        } else {
          sel.innerHTML = '';
          outrasWrap.style.display = 'none';
        }

        // Cartões: 3ª e 2ª lado a lado em cima, 1ª embaixo em destaque.
        let html = '<div class="sq-fila-secundarias">';
        if (terceira) html += _filaCartaoCompacto(terceira, 3);
        if (segunda)  html += _filaCartaoCompacto(segunda, 2);
        html += '</div>';
        if (primeira) html += _filaCartaoPrincipal(primeira, 1);
        listEl.innerHTML = html;
      })
      .catch(err => {
        console.error('Falha ao carregar fila de baterias não avaliadas:', err);
        outrasWrap.style.display = 'none';
        listEl.innerHTML = '<span class="sq-fila-pendentes-vazio"><i class="fas fa-exclamation-triangle"></i> Não foi possível carregar a fila agora.</span>';
      });
  }

  function iniciarAvaliacaoDaFila(idOperacao) {
    const op = filaOperacoes.find(o => o.id === idOperacao);
    _iniciarForm(op || null);
    closeAllCollapsibles();
  }

  function iniciarAvaliacaoDoSelect() {
    const sel = document.getElementById('sq-fila-select');
    if (sel && sel.value) iniciarAvaliacaoDaFila(sel.value);
  }

  // ── Excluir bateria da fila (botão "X" em cada elemento — cartão
  //    compacto, cartão principal e select da 4ª posição em diante) ──────
  // Não é "avaliar" a bateria de verdade: é uma saída de emergência pra
  // quando ela nunca vai passar pelo Setor de Qualidade (perdida,
  // descartada, erro de registro, etc.) e por isso não pode continuar
  // ocupando posição na fila indefinidamente. Ainda assim precisa deixar
  // rastro — por isso grava uma avaliação "de verdade" (mesmo formato de
  // sempre, ver registerEvaluation), só que com TODOS os painéis com
  // resultado = 'nao_avaliado_no_sistema' em vez de aprovado/reprovado,
  // e reaproveita as MESMAS 2 rotas que o registro normal já usa:
  // /registrar-avaliacao-qualidade (grava a avaliação) e
  // /marcar-operacao-avaliada (tira a bateria da fila). Isso já garante
  // que ela sai do Dashboard/Histórico como "avaliada", só que sinalizada
  // como nunca avaliada de verdade (ver 'nao_avaliado_no_sistema' nos
  // painéis) em vez de aprovada/reprovada.
  const SQ_RESULTADO_NAO_AVALIADO = 'nao_avaliado_no_sistema';

  // Nº de painéis da operação — mesma conta usada em qualquer lugar do
  // sistema pra berços->painéis (1 berço = 2 painéis, ver
  // _definirThicknessReal/README/db.js): total_paineis se já veio pronto
  // da operação, senão bercos_reais/capacidade * 2 como aproximação.
  function _filaTotalPaineis(op) {
    const direto = parseInt(op.total_paineis);
    if (direto > 0) return direto;
    const bercos = parseInt(op.bercos_reais) || parseInt(op.capacidade) || 0;
    return bercos * 2;
  }

  function _excluirOperacaoDaFila(op) {
    const evId = 'ev_' + Date.now();
    const totalPaineis = _filaTotalPaineis(op);
    // IMPORTANTE: quem lê "paineis" depois (Análise Focada, Espelho
    // Visual, Dashboard) sempre procura por par (pallet 1-4, posicao
    // 1..totalSlabs/4) — NUNCA por um índice corrido — porque é assim
    // que uma avaliação normal é montada (ver registerEvaluation:
    // stack1-1, stack1-2... stack4-N). Gerar os painéis numa sequência
    // corrida (0,1,2...) sem respeitar essa grade faz a maioria das
    // combinações pallet/posicao não bater com nenhum painel gravado —
    // aí quem procura por ela não acha nada e mostra "Sem marcação" em
    // vez de "Não avaliado no sistema", mesmo a bateria inteira tendo
    // sido excluída. Por isso aqui SEMPRE preenche as 4 pilhas inteiras
    // (pallet 1 a 4, posição 1 a N), igual a uma avaliação de verdade.
    const porPallet = Math.max(1, Math.ceil(totalPaineis / 4));
    const paineis = [];
    for (let pallet = 1; pallet <= 4; pallet++) {
      for (let posicao = 1; posicao <= porPallet; posicao++) {
        paineis.push({
          avaliacaoId: evId,
          pallet,
          posicao,
          tipoEsperado: null,
          tipoObtido: null,
          resultado: SQ_RESULTADO_NAO_AVALIADO,
          linha: null,
          marcas: [],
        });
      }
    }
    const evalObj = {
      id: evId, schemaVersion: 2,
      batteryId: op.id_bateria || null,
      linkedOperacaoId: op.id,
      turno: op.turno || null,
      registeredAt: new Date().toISOString(),
      // totalSlabs é usado por quem monta a grade (ex: Análise Focada,
      // totalPorPallet = totalSlabs/4) pra saber até que posição
      // percorrer em cada pallet — tem que bater com porPallet*4 acima,
      // senão a mesma inconsistência do comentário anterior se repete.
      totalSlabs: porPallet * 4,
      excluidaDaFila: true,
      observations: 'Excluída da fila do Setor de Qualidade — todos os painéis marcados automaticamente como "Não avaliado no sistema".',
      paineis,
    };

    return fetch('/registrar-avaliacao-qualidade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(evalObj),
    })
      .then(res => {
        if (!res.ok) return res.json().catch(() => null).then(j => { throw new Error(j?.erro || 'O servidor recusou excluir esta bateria da fila.'); });
        return fetch('/marcar-operacao-avaliada', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: op.id }),
        });
      })
      .then(() => {
        // Se a bateria excluída era a que estava carregada no formulário
        // agora mesmo, limpa — ela não existe mais na fila pra continuar
        // vinculada a nada.
        if (linkedOperacaoId === op.id) {
          clearForm();
          currentDraftId = null;
          linkedOperacaoId = null;
          navigateTo('form');
        }
        carregarFilaNaoAvaliadas();
        carregarAvaliacoesQualidade();
        showAlert('Excluída', 'Bateria excluída da fila. Todos os painéis foram marcados como "Não avaliado no sistema".');
      })
      .catch(err => {
        console.error('Falha ao excluir bateria da fila:', err);
        showAlert('Erro', 'Não consegui excluir esta bateria da fila agora (' + err.message + ').');
      });
  }

  function excluirDaFila(idOperacao) {
    const op = filaOperacoes.find(o => o.id === idOperacao);
    if (!op) return;
    showConfirm(
      'Excluir da fila',
      `Excluir "${op.id_bateria || 'esta bateria'}" da fila de avaliação? Todos os painéis dela serão marcados como "Não avaliado no sistema" e ela não poderá mais ser avaliada normalmente. Esta ação não pode ser desfeita.`,
      () => _excluirOperacaoDaFila(op)
    );
  }

  function excluirDoSelect() {
    const sel = document.getElementById('sq-fila-select');
    if (sel && sel.value) excluirDaFila(sel.value);
  }

  /* ── Dados (avaliacoes / paineis) — vêm do servidor (SQL), não mais do
     localStorage. Rascunhos (getDrafts, abaixo) continuam locais — só a
     avaliação já REGISTRADA (definitiva) mora no banco (ver
     db.avaliacoes_qualidade / GET /avaliacoes-qualidade, server.js). ── */
  let avaliacoesCache = { avaliacoes: [], paineis: [] };

  // Busca todas as avaliações registradas no servidor e recompõe o
  // formato { avaliacoes, paineis } que o resto do módulo já espera —
  // "paineis" é achatado (flatMap) a partir da lista de painéis embutida
  // em cada avaliação (ver server.js), mantendo o campo "avaliacaoId" em
  // cada painel pra filtros tipo `paineis.filter(p => p.avaliacaoId === id)`
  // continuarem funcionando sem precisar tocar em quem já usa getData().
  function carregarAvaliacoesQualidade() {
    return fetch('/avaliacoes-qualidade')
      .then(r => r.json())
      .then(lista => {
        avaliacoesCache = {
          avaliacoes: Array.isArray(lista) ? lista : [],
          paineis: Array.isArray(lista) ? lista.flatMap(a => Array.isArray(a.paineis) ? a.paineis : []) : [],
        };
        return avaliacoesCache;
      })
      .catch(err => {
        console.error('Falha ao carregar avaliações de qualidade do servidor:', err);
        return avaliacoesCache; // mantém o que já tinha em cache
      });
  }

  function getData() {
    return avaliacoesCache;
  }
  function getDrafts() {
    return LS.keys('draft_').map(k => {
      try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; }
    }).filter(Boolean);
  }

  /* ── Render lista de rascunhos ────────────────────────── */
  // "Em Andamento" — agora um dos 2 colapsáveis dentro da aba "Avaliação"
  // (ver toggleCollapsible), não mais uma tela própria.
  function renderDrafts() {
    const el = document.getElementById('sq-draft-list');
    if (!el) return; // painel só existe na aba "Avaliação"
    const badge = document.getElementById('sq-andamento-badge');
    const drafts = getDrafts();
    if (badge) {
      badge.textContent = String(drafts.length);
      badge.classList.toggle('sq-badge-ativo', drafts.length > 0);
    }
    el.innerHTML = '';
    if (!drafts.length) {
      el.innerHTML = `<div class="sq-empty"><i class="fas fa-inbox"></i>Nenhuma avaliação em andamento.</div>`;
      return;
    }
    drafts.sort((a, b) => b.lastModified - a.lastModified).forEach(d => {
      const card = document.createElement('div');
      card.className = 'sq-list-card';
      const total = (d.slabsPerPallet || 10) * 4;
      const date  = new Date(d.lastModified).toLocaleString('pt-BR');
      card.innerHTML = `
        <div class="sq-list-card-info">
          <span class="sq-id">Bateria ${d.batteryId || 'N/I'}</span>
          <span class="sq-meta">${date} · ${total} painéis</span>
        </div>
        <div class="sq-list-card-actions">
          <button class="btn btn-ghost btn-sm" onclick="SQ.viewDraft('${d.id}')">👁️ Ver</button>
          <button class="btn btn-primary btn-sm" onclick="SQ.loadDraft('${d.id}')"><i class="fas fa-play"></i> Continuar</button>
          <button class="btn btn-danger btn-sm" onclick="SQ.deleteDraft('${d.id}')"><i class="fas fa-times"></i></button>
        </div>`;
      el.appendChild(card);
    });
  }

  /* ── Salvar rascunho ──────────────────────────────────── */
  function saveDraft() {
    if (viewMode) return;
    const id   = currentDraftId || Date.now().toString();
    const data = {
      id, lastModified: Date.now(),
      batteryId:    document.getElementById('sq-batteryId').value,
      linkedOperacaoId,
      palletTypes, slabConfig,
      dailySeq:     document.getElementById('sq-dailySeq').value,
      turno:        document.getElementById('sq-turno').value,
      tempInput:    document.getElementById('sq-temp').value,
      dtMontagem:   document.getElementById('sq-dtMontagem').value,
      dtEnchimento: document.getElementById('sq-dtEnchimento').value,
      dtDesmoldagem:document.getElementById('sq-dtDesmoldagem').value,
      observations: document.getElementById('sq-obs').value,
      slabsPerPallet: parseInt(document.getElementById('sq-thickness').value),
      slabState,
      palletInfos: {}
    };
    for (let p = 1; p <= 4; p++) {
      data.palletInfos[p] = {};
      ['comprimento','largura','linearidade','espessura','esquadro'].forEach(f => {
        const el = document.getElementById(`sq-p${p}-${f}`);
        data.palletInfos[p][f] = el ? el.innerText : '';
      });
    }
    localStorage.setItem(`sq_draft_${id}`, JSON.stringify(data));
    currentDraftId = id;
    showAlert('Salvo', 'Avaliação salva com sucesso!');
    // "Em Andamento" não é mais uma tela própria pra navegar até — só
    // atualiza a contagem/lista do colapsável e a fila (o rascunho salvo
    // agora sai da fila, ver carregarFilaNaoAvaliadas), e continua na
    // própria aba "Avaliação".
    renderDrafts();
    carregarFilaNaoAvaliadas();
  }

  /* ── Carregar rascunho ────────────────────────────────── */
  function loadDraft(id) {
    if (viewMode) exitViewMode();
    const raw = localStorage.getItem(`sq_draft_${id}`);
    if (!raw) { showAlert('Erro', 'Rascunho não encontrado.'); return; }
    const d = JSON.parse(raw);
    applyFormData(d);
    currentDraftId = d.id;
    navigateTo('form');
    autoSetThickness();
    calculateCureTime();
    setEditable(true);
    validateAllSlabs();
    closeAllCollapsibles();
  }

  function deleteDraft(id) {
    if (!confirm('Remover este rascunho?')) return;
    LS.del('draft_' + id);
    renderDrafts();
  }

  /* ── Registrar avaliação definitiva ───────────────────── */
  function registerEvaluation() {
    if (viewMode) return;
    if (!document.getElementById('sq-batteryId').value) { showAlert('Erro','Selecione o ID da Bateria.'); return; }
    showConfirm('Registrar','Ao registrar, a avaliação vai para o histórico. Continuar?', () => {
      const evId = 'ev_' + Date.now();
      const evalObj = {
        id: evId, schemaVersion: 2,
        batteryId: document.getElementById('sq-batteryId').value,
        linkedOperacaoId: linkedOperacaoId || null,
        montagem: { pallet1: palletTypes[0], pallet2: palletTypes[1], pallet3: palletTypes[2], pallet4: palletTypes[3] },
        turno:    document.getElementById('sq-turno').value,
        tempInput: parseFloat(document.getElementById('sq-temp').value) || 0,
        dtMontagem:    toISO(document.getElementById('sq-dtMontagem').value),
        dtEnchimento:  toISO(document.getElementById('sq-dtEnchimento').value),
        dtDesmoldagem: toISO(document.getElementById('sq-dtDesmoldagem').value),
        registeredAt: new Date().toISOString(),
        totalSlabs: parseInt(document.getElementById('sq-thickness').value) * 4,
        observations: document.getElementById('sq-obs').value,
      };
      // Painéis embutidos na própria avaliação — 1 linha no banco pra
      // avaliação inteira (ver db.salvarAvaliacaoQualidade, db.js),
      // "avaliacaoId" mantido em cada painel só por compatibilidade com
      // quem já filtra por ele (ver getData()/carregarAvaliacoesQualidade).
      evalObj.paineis = Object.entries(slabState).map(([id, marks]) => {
        const parts = id.split('-');
        const info  = getClassifiedInfo(marks);
        return { avaliacaoId: evId, pallet: parseInt(parts[0].replace('stack','')), posicao: parseInt(parts[1]), tipoEsperado: getExpectedType(id), tipoObtido: info.tipoObtido, resultado: info.resultado, linha: info.linha, marcas: marks };
      });

      const opIdParaMarcar = linkedOperacaoId;
      const btnRegistrar = document.getElementById('sq-btn-register');
      if (btnRegistrar) btnRegistrar.disabled = true;

      fetch('/registrar-avaliacao-qualidade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(evalObj),
      })
        .then(res => {
          if (!res.ok) return res.json().catch(() => null).then(j => { throw new Error(j?.erro || 'O servidor recusou salvar a avaliação.'); });
          return res.json();
        })
        .then(() => {
          // Só limpa o formulário e sai da tela DEPOIS de confirmado no
          // servidor — diferente do rascunho local antigo, não tem mais
          // "salvo local, sincroniza depois": se a rede cair antes daqui,
          // a pessoa continua na tela, com os dados intactos, e pode
          // tentar "Registrar" de novo.
          if (currentDraftId) LS.del('draft_' + currentDraftId);
          clearForm();
          currentDraftId = null;
          showAlert('Concluído', 'Avaliação registrada com sucesso!');
          navigateTo('form');
          carregarAvaliacoesQualidade();

          if (opIdParaMarcar) {
            fetch('/marcar-operacao-avaliada', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: opIdParaMarcar }),
            })
              .then(() => carregarFilaNaoAvaliadas()) // sai da fila -> os demais sobem de posição
              .catch(err => console.error('Não consegui marcar a operação como avaliada:', err));
          } else {
            carregarFilaNaoAvaliadas(); // avulsa: não muda a fila, mas mantém em dia mesmo assim
          }
        })
        .catch(err => {
          console.error('Falha ao registrar avaliação de qualidade:', err);
          showAlert('Erro', 'Não consegui salvar a avaliação agora (' + err.message + '). Nada foi perdido — tente "Registrar" de novo.');
        })
        .finally(() => {
          if (btnRegistrar) btnRegistrar.disabled = false;
        });
    });
  }

  /* ── Visualizar rascunho (modo somente leitura) ───────── */
  function viewDraft(id) {
    const raw = localStorage.getItem(`sq_draft_${id}`);
    if (!raw) { showAlert('Erro','Não encontrado.'); return; }
    const d = JSON.parse(raw);
    currentDraftId = d.id;
    applyFormData(d);
    autoSetThickness();
    calculateCureTime();
    viewSource = 'form';
    setEditable(false);
    viewMode = true;
    navigateTo('form');
    closeAllCollapsibles();
  }

  function viewHistoryRecord(evId) {
    const d    = getData();
    const item = d.avaliacoes.find(e => e.id === evId);
    if (!item) { showAlert('Erro','Não encontrado.'); return; }
    viewSource = 'history';
    palletTypes = [item.montagem.pallet1, item.montagem.pallet2, item.montagem.pallet3, item.montagem.pallet4];
    slabConfig  = {};
    updateMountTypeDropdown();
    document.getElementById('sq-batteryId').value   = item.batteryId || 'B1';
    document.getElementById('sq-turno').value        = item.turno    || '';
    document.getElementById('sq-temp').value         = item.tempInput || '';
    document.getElementById('sq-dtMontagem').value   = fmtDTL(item.dtMontagem);
    document.getElementById('sq-dtEnchimento').value = fmtDTL(item.dtEnchimento);
    document.getElementById('sq-dtDesmoldagem').value= fmtDTL(item.dtDesmoldagem);
    document.getElementById('sq-obs').value          = item.observations || '';
    refreshPalletInfos();
    const ns = {};
    d.paineis.filter(p => p.avaliacaoId === evId).forEach(p => { ns[`stack${p.pallet}-${p.posicao}`] = p.marcas; });
    slabState     = ns;
    actionHistory = [];
    document.getElementById('sq-thickness').value = item.totalSlabs / 4;
    autoSetThickness();
    calculateCureTime();
    setEditable(false);
    viewMode = true;
    navigateTo('form');
  }

  function exitViewMode()  { viewMode = false; setEditable(true); }

  function setEditable(editable) {
    document.getElementById('sq-view-overlay').style.display = editable ? 'none' : 'block';
    document.querySelectorAll('.sq-hide-view').forEach(el => el.classList.toggle('is-view', !editable));
    document.querySelectorAll('.sq-show-view').forEach(el => el.classList.toggle('is-view', !editable));
    document.querySelectorAll('#sq-form input, #sq-form select, #sq-form textarea').forEach(el => {
      if (el.id === 'sq-cure-time' || el.id === 'sq-thickness') return;
      el.disabled = !editable;
    });
    viewMode = !editable;
  }

  /* ── Render histórico ─────────────────────────────────── */
  function renderHistory() {
    const d       = getData();
    const search  = (document.getElementById('sq-hist-search').value || '').toLowerCase();
    const turno   = document.getElementById('sq-hist-turno').value;
    const filtered = d.avaliacoes.filter(item =>
      (item.batteryId||'').toLowerCase().includes(search) &&
      (!turno || item.turno === turno)
    ).sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt));

    document.getElementById('sq-hist-count').textContent = `${filtered.length} registros`;
    const wrap  = document.getElementById('sq-hist-table-wrap');
    const empty = document.getElementById('sq-hist-empty');
    const body  = document.getElementById('sq-hist-tbody');
    if (!filtered.length) { wrap.style.display='none'; empty.style.display='block'; return; }
    wrap.style.display='block'; empty.style.display='none'; body.innerHTML='';

    filtered.forEach(item => {
      const panels = d.paineis.filter(p => p.avaliacaoId === item.id);
      const counts = {};
      panels.forEach(p => { const k = `${p.tipoObtido} ${p.resultado}${_linhaDoPainel(p) === '2ª' ? ' (2ª linha)' : ''}`; counts[k] = (counts[k]||0) + 1; });
      const summary = Object.entries(counts).map(([k,n]) => `${k}: ${n}`).join(', ') || '—';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${new Date(item.registeredAt).toLocaleString('pt-BR')}</td>
        <td><strong>${item.batteryId||'N/I'}</strong></td>
        <td style="color:#66bb6a;font-weight:700;">${item.montagem.pallet1||'—'}</td>
        <td style="color:#42a5f5;font-weight:700;">${item.montagem.pallet2||'—'}</td>
        <td style="color:#ab47bc;font-weight:700;">${item.montagem.pallet3||'—'}</td>
        <td style="color:#ffa726;font-weight:700;">${item.montagem.pallet4||'—'}</td>
        <td>${item.turno||'—'}</td>
        <td>${item.tempInput?item.tempInput+'°C':'—'}</td>
        <td>${item.totalSlabs||'—'}</td>
        <td style="font-size:.72rem;max-width:150px;white-space:normal;word-break:break-word;">${summary}</td>
        <td style="text-align:center;">
          <button class="btn btn-ghost btn-sm" onclick="SQ.viewHistoryRecord('${item.id}')">👁️</button>
        </td>`;
      body.appendChild(tr);
    });
  }

  /* ── Espelho visual ───────────────────────────────────── */
  function getSlabCount(bid) { return bid==='B5-7.5'?11:bid==='B6-12'?8:10; }

  function getMirrorMark(panel) {
    // "Não avaliado no sistema" (ver excluirDaFila) — painel que nunca
    // passou pelo Setor de Qualidade de verdade; precisa ficar visualmente
    // diferente tanto de uma marca real quanto do "sem marcação" comum
    // (abaixo), senão vira exatamente a mesma confusão que motivou este
    // ajuste: um "x" cinza, sem forma de traço nem de círculo.
    if (panel?.resultado === SQ_RESULTADO_NAO_AVALIADO) {
      return `<span class="sq-mini-mark sq-mini-mark-nao-avaliado" title="Não avaliado no sistema">×</span>`;
    }
    // Sem marcação (a imensa maioria das placas — só quem tem defeito é
    // marcado, ver classifyMarks) — ANTES usava uma barrinha sólida do
    // MESMO tamanho/forma do traço de verdade (marca de SP), o que fazia
    // parecer que a placa tinha sido marcada quando na verdade não tinha
    // marcação nenhuma. Agora é um círculo vazado (sem preenchimento),
    // visualmente distinto de qualquer marca real (círculo ou traço,
    // sempre preenchidos), com tooltip explícito.
    if (!panel?.marcas?.length)
      return `<span class="sq-mini-mark sq-mini-mark-vazia" title="Sem marcação"></span>`;
    return panel.marcas.map(m => {
      const w = m.shape==='dash' ? '12px' : '6px', h = m.shape==='dash' ? '2px' : '6px';
      const r = m.shape==='circle' ? '50%' : '2px';
      const varMap = { verde:'--sq-cor-verde', vermelho:'--sq-cor-vermelho', azul:'--sq-cor-azul', amarelo:'--sq-cor-amarelo', laranja:'--sq-cor-laranja' };
      return `<span class="sq-mini-mark" style="background:var(${varMap[m.color]||'--sq-cor-verde'});width:${w};height:${h};border-radius:${r};margin:0 1px;display:inline-block;"></span>`;
    }).join('');
  }

  function renderMirror(index) {
    const container = document.getElementById('sq-mirror-container');
    const counter   = document.getElementById('sq-mirror-counter');
    if (!dashboardEvals.length) {
      container.innerHTML = `<div class="sq-empty" style="padding:20px;"><i class="fas fa-inbox"></i>Nenhuma avaliação.</div>`;
      ['sq-mirror-battery','sq-mirror-turno','sq-mirror-desmoldagem'].forEach(id => { const el=document.getElementById(id); if(el) el.textContent='---'; });
      document.getElementById('sq-mirror-prev').disabled = true;
      document.getElementById('sq-mirror-next').disabled = true;
      counter.textContent = '0 / 0';
      return;
    }
    const item   = dashboardEvals[index];
    const d      = getData();
    const panels = d.paineis.filter(p => p.avaliacaoId === item.id);
    document.getElementById('sq-mirror-battery').textContent     = item.batteryId||'N/I';
    document.getElementById('sq-mirror-turno').textContent       = item.turno||'—';
    document.getElementById('sq-mirror-desmoldagem').textContent = item.dtDesmoldagem ? new Date(item.dtDesmoldagem).toLocaleString('pt-BR') : '—';
    counter.textContent = `${index+1} / ${dashboardEvals.length}`;
    document.getElementById('sq-mirror-prev').disabled = index === 0;
    document.getElementById('sq-mirror-next').disabled = index === dashboardEvals.length - 1;

    const n = getSlabCount(item.batteryId);
    const cm = { SP:'sp','2P':'p2','3T':'t3','1T':'t1' };
    let html = '<div class="sq-mini-stacks">';
    for (let p = 1; p <= 4; p++) {
      html += `<div class="sq-mini-pallet"><div class="sq-mini-pallet-header">P${p}</div>`;
      for (let i = 1; i <= n; i++) {
        const panel = panels.find(pa => pa.pallet===p && pa.posicao===i);
        // Placa sem marca individual (a imensa maioria — só quem tem
        // defeito é marcado, ver classifyMarks/"Sem marcação") NÃO tinha
        // "panel" correspondente, e o tipo (SP/2P/3T/1T) só vinha de lá —
        // por isso o espelho inteiro aparecia sem cor nenhuma na prática
        // (só os poucos painéis marcados apareciam, o resto ficava em
        // branco). O tipo esperado da placa já é conhecido de qualquer
        // forma pelo tipo de montagem do PALLET (item.montagem), então
        // cai nisso quando não há painel — mantém a cor/identificação
        // mesmo em placas sem nenhuma marca.
        const tipo = panel?.tipoEsperado || item.montagem?.['pallet'+p] || '';
        html += `<div class="sq-mini-slab"><span class="sq-mini-slab-number">${i}</span><div class="sq-mini-slab-marks">${getMirrorMark(panel)}</div>${tipo?`<span class="sq-mini-slab-type ${cm[tipo]||''}">${tipo}</span>`:''}</div>`;
      }
      html += '</div>';
    }
    html += '</div>';
    container.innerHTML = html;
  }

  function prevMirror() { if (mirrorIndex > 0) { mirrorIndex--; renderMirror(mirrorIndex); } }
  function nextMirror() { if (mirrorIndex < dashboardEvals.length - 1) { mirrorIndex++; renderMirror(mirrorIndex); } }

  // Registros salvos ANTES desta distinção existir não têm "p.linha"
  // gravado — mas já tinham "p.marcas" (a marca bruta, cor+forma), então
  // dá pra recalcular na hora em vez de depender de reprocessar o banco.
  // Usado em qualquer lugar que precise saber a linha de um painel já
  // registrado (KPIs, gráfico de distribuição, resumo, tela Registros).
  function _linhaDoPainel(p) {
    if (p.linha !== undefined) return p.linha;
    return p.marcas ? _linhaDoAprovado(p.marcas) : null;
  }

  /* ── Dashboard ────────────────────────────────────────── */
  function renderDashboard() {
    const d    = getData();
    const sd   = document.getElementById('sq-dash-start').value;
    const ed   = document.getElementById('sq-dash-end').value;
    const bf   = document.getElementById('sq-dash-bat').value;

    const fe = d.avaliacoes.filter(item => {
      const dt = new Date(item.registeredAt);
      return (!sd || dt >= new Date(sd)) &&
             (!ed || dt <= new Date(ed + 'T23:59:59')) &&
             (!bf || item.batteryId === bf);
    });
    dashboardEvals = fe; mirrorIndex = 0; renderMirror(0);

    const ids = fe.map(e => e.id);
    const fp  = d.paineis.filter(p => ids.includes(p.avaliacaoId));
    const apr = fp.filter(p => p.resultado==='aprovado').length;
    const rep = fp.filter(p => p.resultado==='reprovado').length;
    const seg = fp.filter(p => _linhaDoPainel(p)==='2ª').length; // aprovado, mas 2ª linha (ver getClassifiedInfo/_linhaDoPainel)
    const tt  = apr + rep;
    const ar  = tt ? ((apr/tt)*100).toFixed(1) : 0;
    const rr  = tt ? ((rep/tt)*100).toFixed(1) : 0;

    document.getElementById('sq-kpi-grid').innerHTML = `
      <div class="kpi-card"><div class="kpi-label">Total Registros</div><div class="kpi-value" style="font-size:1.8rem;">${fe.length}</div></div>
      <div class="kpi-card green"><div class="kpi-label">Painéis Avaliados</div><div class="kpi-value green" style="font-size:1.8rem;">${fp.length}</div></div>
      <div class="kpi-card" data-tooltip="Aprovados de 2ª linha (marcados em azul) — já contam dentro da Taxa de Aprovação; aqui é só pra saber quantos desses aprovados são 2ª linha."><div class="kpi-label">Painéis 2ª Linha</div><div class="kpi-value" style="font-size:1.8rem;color:var(--sq-cor-azul)">${seg}</div></div>
      <div class="kpi-card"><div class="kpi-label">Taxa de Aprovação</div><div class="kpi-value accent" style="font-size:1.8rem;">${ar}%</div></div>
      <div class="kpi-card red"><div class="kpi-label">Taxa de Reprovação</div><div class="kpi-value red" style="font-size:1.8rem;">${rr}%</div></div>`;

    /* Evolução diária */
    const dp = {};
    fe.forEach(e => { const dk = new Date(e.dtMontagem||e.registeredAt).toISOString().slice(0,10); dp[dk]=(dp[dk]||0)+d.paineis.filter(p=>p.avaliacaoId===e.id).length; });
    const pl = Object.keys(dp).sort(), pv = pl.map(k => dp[k]);

    destroyChart('production');
    charts.production = new Chart(document.getElementById('sq-chart-production').getContext('2d'), {
      type: 'line',
      data: { labels: pl.length ? pl : ['Sem dados'], datasets: [{ label:'Painéis', data: pl.length?pv:[0], borderColor:'var(--blue)', backgroundColor:'rgba(59,130,246,0.1)', fill:true, tension:0.4, pointRadius:4 }] },
      options: baseChartOptions({ legend: false }),
    });

    /* Distribuição das classificações — "(2ª linha)" vira fatia própria
       quando p.linha==='2ª' (ver getClassifiedInfo/_linhaDoAprovado); não
       mexe no valor de p.resultado, só no rótulo usado aqui pra separar
       visualmente aprovados de 1ª dos de 2ª linha. */
    const cc = {}; fp.forEach(p => { const k = `${p.tipoObtido} ${p.resultado}${_linhaDoPainel(p) === '2ª' ? ' (2ª linha)' : ''}`; cc[k]=(cc[k]||0)+1; });
    const ql = Object.keys(cc), qv = Object.values(cc);
    const cmap = { 'SP aprovado':'#4d8dff','SP reprovado':'#ff6b6b','2P aprovado':'#a78bfa','2P reprovado':'#d45d79','3T aprovado':'#f1c40f','3T reprovado':'#f39c12','1T aprovado':'#2ed3a3','1T reprovado':'#d35400' };
    const corSegunda = 'var(--sq-cor-azul)';
    destroyChart('quality');
    charts.quality = new Chart(document.getElementById('sq-chart-quality').getContext('2d'), {
      type: 'doughnut',
      data: { labels: ql.length?ql:['Sem dados'], datasets: [{ data:ql.length?qv:[1], backgroundColor:ql.length?ql.map(l=>l.includes('2ª linha')?corSegunda:(cmap[l]||'var(--border-2)')):['var(--border-2)'], borderWidth:0 }] },
      options: { ...baseChartOptions(), plugins: { legend:{ position:'bottom', labels:{ color:'var(--text-3)', boxWidth:12, padding:8 } }, datalabels:{display:false} } },
    });

    /* Taxa de refugo por tipo */
    const tt2={SP:0,'2P':0,'3T':0,'1T':0}, tr2={SP:0,'2P':0,'3T':0,'1T':0};
    fp.forEach(p => { if (p.tipoEsperado && tt2[p.tipoEsperado]!==undefined) { tt2[p.tipoEsperado]++; if(p.resultado==='reprovado') tr2[p.tipoEsperado]++; } });
    const vtl = Object.keys(tt2).filter(k=>tt2[k]>0);
    destroyChart('rejections');
    charts.rejections = new Chart(document.getElementById('sq-chart-rejections').getContext('2d'), {
      type: 'bar', indexAxis: 'y',
      data: { labels: vtl.length?vtl:['Nenhum'], datasets: [{ label:'Refugo%', data:vtl.length?vtl.map(k=>((tr2[k]/tt2[k])*100).toFixed(1)):[0], backgroundColor:'var(--red)', borderRadius:4 }] },
      options: { ...baseChartOptions({ legend:false }), plugins:{ ...baseChartOptions({legend:false}).plugins, datalabels:{ color:'var(--text-2)', anchor:'end', align:'end', font:{weight:'bold'}, formatter:v=>v+'%' } }, scales:{ x:{ticks:{color:'var(--text-3)'},beginAtZero:true,max:100}, y:{ticks:{color:'var(--text-3)'}} } },
    });

    /* Total por tipo */
    const tc={SP:0,'2P':0,'3T':0,'1T':0}; fp.forEach(p=>{if(p.tipoEsperado&&tc[p.tipoEsperado]!==undefined)tc[p.tipoEsperado]++;});
    destroyChart('tipoPlacas');
    charts.tipoPlacas = new Chart(document.getElementById('sq-chart-tipo').getContext('2d'), {
      type: 'bar',
      data: { labels:Object.keys(tc), datasets:[{ data:Object.values(tc), backgroundColor:['var(--blue)','var(--sq-purple)','var(--sq-yellow)','var(--sq-orange)'], borderRadius:4 }] },
      options: baseChartOptions({ legend:false }),
    });

    /* Defeitos por posição */
    const bec={};fe.forEach(e=>{bec[e.batteryId]=(bec[e.batteryId]||0)+1;});
    const dm={};
    fp.forEach(p=>{if(p.resultado==='reprovado'){const ev=fe.find(e=>e.id===p.avaliacaoId);if(ev){const k=`${ev.batteryId}|P${p.pallet}|Pos${p.posicao}`;if(!dm[k])dm[k]={batteryId:ev.batteryId,pallet:p.pallet,posicao:p.posicao,d:0};dm[k].d++;}}});
    const rnk=Object.values(dm).map(r=>({...r,N:bec[r.batteryId]||0,taxa:bec[r.batteryId]?(r.d/bec[r.batteryId])*100:0})).filter(r=>r.d>=3&&r.taxa>=30).sort((a,b)=>b.taxa-a.taxa||b.d-a.d).slice(0,10);
    const pc = document.getElementById('sq-chart-posicao');
    pc.innerHTML = rnk.length ? '<div style="display:flex;flex-direction:column;gap:8px;">' + rnk.map(r=>{
      const cor = r.taxa>=40?'var(--red)':r.taxa>=20?'var(--accent)':'var(--green)';
      return `<div style="background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius);padding:8px 12px;display:flex;justify-content:space-between;align-items:center;font-size:.8rem;">
        <span><strong>${r.batteryId}</strong> · P${r.pallet} · Pos ${r.posicao}</span>
        <span style="font-family:var(--font-mono);color:${cor};font-weight:700;">${r.taxa.toFixed(0)}% <span style="color:var(--text-3);font-weight:400;">(${r.d}/${r.N})</span></span></div>`;
    }).join('') + '</div>' : '<div style="color:var(--text-3);text-align:center;padding:20px;font-size:.82rem;">Nenhum ponto de recorrência significativo (D≥3 e taxa≥30%).</div>';

    /* Baterias com mais refugo */
    const br={};fe.forEach(e=>{const n=d.paineis.filter(p=>p.avaliacaoId===e.id&&p.resultado==='reprovado').length;if(n)br[e.batteryId]=(br[e.batteryId]||0)+n;});
    const sb=Object.keys(br).sort((a,b)=>br[b]-br[a]).slice(0,10);
    destroyChart('batRefugo');
    charts.batRefugo = new Chart(document.getElementById('sq-chart-bat-refugo').getContext('2d'), {
      type:'bar', indexAxis:'y',
      data:{ labels:sb.length?sb:['Nenhuma'], datasets:[{ label:'Refugo', data:sb.length?sb.map(k=>br[k]):[0], backgroundColor:'var(--sq-orange)', borderRadius:4 }] },
      options: baseChartOptions({ legend:false }),
    });

    /* Scatter: tempo de pega × refugo */
    const sc=[],sl=[];
    fe.forEach(e=>{if(e.dtEnchimento&&e.dtDesmoldagem){const diff=new Date(e.dtDesmoldagem)-new Date(e.dtEnchimento);if(diff>0){const h=diff/3600000,refs=d.paineis.filter(p=>p.avaliacaoId===e.id&&p.resultado==='reprovado').length;sc.push({x:h,y:refs});sl.push(`Bat:${e.batteryId}|${h.toFixed(1)}h|${refs} refugos`);}}});
    let trd=[];
    if(sc.length>1){const n=sc.length,sx=sc.reduce((a,b)=>a+b.x,0),sy=sc.reduce((a,b)=>a+b.y,0),sxy=sc.reduce((a,b)=>a+b.x*b.y,0),sx2=sc.reduce((a,b)=>a+b.x*b.x,0),den=n*sx2-sx*sx,m=(n*sxy-sx*sy)/den,b=(sy-m*sx)/n,maxX=Math.max(...sc.map(d=>d.x)),minX=Math.min(...sc.map(d=>d.x));trd=[{x:minX,y:m*minX+b},{x:maxX,y:m*maxX+b}];}
    destroyChart('tempoPega');
    charts.tempoPega = new Chart(document.getElementById('sq-chart-tempo-pega').getContext('2d'), {
      type:'scatter',
      data:{datasets:[{label:'Avaliações',data:sc,backgroundColor:'var(--blue)',pointRadius:6},...(trd.length?[{label:'Tendência',data:trd,type:'line',borderColor:'var(--red)',borderWidth:2,pointRadius:0,fill:false}]:[])]},
      options:{...baseChartOptions(),plugins:{...baseChartOptions().plugins,tooltip:{callbacks:{label:ctx=>ctx.dataset.label==='Tendência'?'Tendência':sl[ctx.dataIndex]||''}},datalabels:{display:false}},scales:{x:{type:'linear',title:{display:true,text:'Tempo de Pega (h)',color:'var(--text-3)'},ticks:{color:'var(--text-3)'}},y:{title:{display:true,text:'Refugo',color:'var(--text-3)'},ticks:{color:'var(--text-3)'},beginAtZero:true}}},
    });

    /* Aprovação vs reprovação por bateria */
    const bd={};fe.forEach(e=>{if(!bd[e.batteryId])bd[e.batteryId]={a:0,r:0};d.paineis.filter(p=>p.avaliacaoId===e.id).forEach(p=>{if(p.resultado==='aprovado')bd[e.batteryId].a++;else if(p.resultado==='reprovado')bd[e.batteryId].r++;});});
    const bl=Object.keys(bd);
    destroyChart('approvalBat');
    charts.approvalBat = new Chart(document.getElementById('sq-chart-approval-bat').getContext('2d'), {
      type:'bar',
      data:{labels:bl.length?bl:['Sem dados'],datasets:[{label:'Aprovados',data:bl.length?bl.map(k=>bd[k].a):[0],backgroundColor:'var(--green)',borderRadius:2},{label:'Reprovados',data:bl.length?bl.map(k=>bd[k].r):[0],backgroundColor:'var(--red)',borderRadius:2}]},
      options: baseChartOptions(),
    });

    /* Resumo */
    let summ=`Avaliados <b>${fp.length}</b> painéis em <b>${fe.length}</b> registros. `;
    if(seg) summ+=`<b>${seg}</b> aprovado${seg>1?'s':''} de 2ª linha. `;
    if(rnk.length){const rx=rnk[0];summ+=`Maior recorrência: <b>${rx.batteryId} · Pallet ${rx.pallet} · Posição ${rx.posicao}</b> (${rx.d}/${rx.N}, ${rx.taxa.toFixed(0)}%).`;}
    else if(fe.length) summ+='Nenhum ponto de recorrência significativo detectado.';
    else summ='Nenhum dado disponível para o período.';
    document.getElementById('sq-dash-summary').innerHTML = summ;
  }

  function baseChartOptions(opts={}) {
    return {
      preserveDrawingBuffer: true,
      responsive: true,
      plugins: {
        legend: { labels: { color: 'var(--text-3)' }, ...( opts.legend === false ? { display: false } : {} ) },
        datalabels: { color: 'var(--text-3)', anchor:'end', align:'end', font:{ weight:'bold' } },
      },
      scales: {
        x: { ticks: { color: 'var(--text-3)' } },
        y: { ticks: { color: 'var(--text-3)' }, beginAtZero: true },
      },
    };
  }
  function destroyChart(key) { if (charts[key]) { charts[key].destroy(); delete charts[key]; } }

  /* ── Exportar PDF ─────────────────────────────────────── */
  async function exportDashboardPDF() {
    const btn = document.getElementById('sq-btn-pdf');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Gerando…'; btn.disabled = true;
    try {
      const canvas = await html2canvas(document.getElementById('sq-dashboard'), { scale:2, backgroundColor:'#ffffff', useCORS:true, logging:false, scrollX:0, scrollY:-window.scrollY });
      const { jsPDF } = window.jspdf;
      const w = 297, h = Math.ceil((canvas.height * w) / canvas.width);
      const pdf = new jsPDF({ orientation:'landscape', unit:'mm', format:[w,h] });
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, w, h);
      pdf.save(`avaliacao_baterias_${new Date().toISOString().replace(/[-:T.]/g,'').slice(0,14)}.pdf`);
    } catch (err) { console.error(err); showAlert('Erro','Falha ao gerar PDF.'); }
    finally { btn.innerHTML = '<i class="fas fa-file-pdf"></i> Exportar PDF'; btn.disabled = false; }
  }

  /* ── Utilitários do formulário ────────────────────────── */
  function toISO(val) { return val ? new Date(val).toISOString() : null; }
  function fmtDTL(iso) { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toISOString().slice(0,16); }

  function applyFormData(d) {
    document.getElementById('sq-batteryId').value    = d.batteryId || 'B1';
    linkedOperacaoId = d.linkedOperacaoId || null;
    palletTypes = d.palletTypes  || ['','','',''];
    slabConfig  = d.slabConfig   || {};
    updateMountTypeDropdown();
    document.getElementById('sq-dailySeq').value     = d.dailySeq  || '1';
    document.getElementById('sq-turno').value        = d.turno     || '1° TURNO';
    document.getElementById('sq-temp').value         = d.tempInput || '';
    document.getElementById('sq-dtMontagem').value   = fmtDTL(d.dtMontagem);
    document.getElementById('sq-dtEnchimento').value = fmtDTL(d.dtEnchimento);
    document.getElementById('sq-dtDesmoldagem').value= fmtDTL(d.dtDesmoldagem);
    document.getElementById('sq-obs').value          = d.observations || '';
    if (d.palletInfos) {
      for (let p = 1; p <= 4; p++) {
        if (!d.palletInfos[p]) continue;
        ['comprimento','largura','linearidade','espessura','esquadro'].forEach(f => {
          const el = document.getElementById(`sq-p${p}-${f}`);
          if (el) el.innerText = d.palletInfos[p][f] || defaultPalletInfo(f);
        });
      }
    }
    document.getElementById('sq-thickness').value = d.slabsPerPallet || 10;
    slabState     = d.slabState || {};
    actionHistory = [];
  }

  function defaultPalletInfo(field) {
    const bid = document.getElementById('sq-batteryId')?.value || '';
    if (field === 'comprimento') return '3m';
    if (field === 'largura')     return '61cm';
    if (field === 'espessura')   return bid==='B5-7.5'?'7,5 cm':bid==='B6-12'?'12 cm':'9 cm';
    return 'ok';
  }

  function clearForm() {
    slabState = {}; actionHistory = []; palletTypes = ['','','','']; slabConfig = {};
    linkedOperacaoId = null;
    document.querySelectorAll('.sq-slab-marks').forEach(c => { c.innerHTML = ''; });
    document.getElementById('sq-batteryId').value    = 'B1';
    document.getElementById('sq-dailySeq').value     = '1';
    document.getElementById('sq-turno').value        = '1° TURNO';
    document.getElementById('sq-temp').value         = '';
    document.getElementById('sq-dtMontagem').value   = '';
    document.getElementById('sq-dtEnchimento').value = '';
    document.getElementById('sq-dtDesmoldagem').value= '';
    document.getElementById('sq-obs').value          = '';
    updateMountTypeDropdown();
    refreshPalletInfos();
    autoSetThickness();
    calculateCureTime();
    setEditable(true);
    validateAllSlabs();
  }

  function formatTemperature(input) {
    const v = input.value.trim();
    if (!v || v.includes('°C')) return;
    const n = parseFloat(v);
    if (!isNaN(n)) input.value = n + '°C';
  }

  function calculateCureTime() {
    const s   = document.getElementById('sq-dtEnchimento').value;
    const e   = document.getElementById('sq-dtDesmoldagem').value;
    const out = document.getElementById('sq-cure-time');
    if (!s || !e) { out.value = ''; return; }
    const diff = new Date(e) - new Date(s);
    if (diff > 0) { const h = Math.floor(diff/3600000), m = Math.floor((diff%3600000)/60000); out.value = `${h}h ${m}min`; }
    else out.value = diff === 0 ? '0h 0min' : 'Data inválida';
  }

  function autoSetThickness() {
    const id  = document.getElementById('sq-batteryId').value;
    const sel = document.getElementById('sq-thickness');
    sel.value = id==='B5-7.5' ? '11' : id==='B6-12' ? '8' : '10';
    actionHistory = [];
    renderStacks();
    refreshPalletInfos();
    validateAllSlabs();
  }

  function refreshPalletInfos() {
    const bid = document.getElementById('sq-batteryId').value;
    const esp = bid==='B5-7.5'?'7,5 cm':bid==='B6-12'?'12 cm':'9 cm';
    for (let p = 1; p <= 4; p++) {
      const set = (f, v) => { const el = document.getElementById(`sq-p${p}-${f}`); if (el) el.innerText = v; };
      set('comprimento','3m'); set('largura','61cm'); set('linearidade','ok');
      set('espessura', esp);   set('esquadro','ok');
    }
  }

  function editField(btn) {
    if (viewMode) return;
    const pid = btn.dataset.pallet, fk = btn.dataset.field;
    const el  = document.getElementById(`sq-p${pid}-${fk}`);
    const labels = { comprimento:'Comprimento', largura:'Largura', linearidade:'Linearidade', espessura:'Espessura', esquadro:'Esquadro' };
    showPrompt(`Editar ${labels[fk]}`, `Novo valor para ${labels[fk]} do Pallet ${pid}:`, el.innerText, v => {
      if (v !== null && v.trim()) el.innerText = v;
    });
  }

  function clearAllMarks() {
    if (viewMode) return;
    showConfirm('Limpar', 'Apagar todas as marcações?', () => {
      pushState();
      slabState = {};
      document.querySelectorAll('.sq-slab-marks').forEach(c => { c.innerHTML = ''; });
      validateAllSlabs();
    });
  }

  function undoLastAction() {
    if (viewMode) return;
    if (actionHistory.length) { slabState = actionHistory.pop(); renderStacks(); validateAllSlabs(); }
    else showAlert('Desfazer', 'Nada para desfazer.');
  }

  /* ── Modal genérico (usa o modal do Lightwall se disponível) */
  function showAlert(title, msg) {
    if (typeof LW !== 'undefined' && LW.mostrarAlerta) { LW.mostrarAlerta(msg, { titulo: title }); return; }
    _modal(title, msg, 'alert');
  }
  function showConfirm(title, msg, cb) {
    if (typeof LW !== 'undefined' && LW.mostrarConfirmacao) {
      LW.mostrarConfirmacao(msg, { titulo: title, textoConfirmar: 'Confirmar' }).then(ok => { if (ok) cb(); });
      return;
    }
    _modal(title, msg, 'confirm', cb);
  }
  function showPrompt(title, msg, def, cb) { _modal(title, msg, 'prompt', cb, def); }

  function _modal(title, msg, type, cb, def) {
    const ov  = document.getElementById('sq-modal');
    const tEl = document.getElementById('sq-modal-title');
    const mEl = document.getElementById('sq-modal-msg');
    const iEl = document.getElementById('sq-modal-input');
    const okBtn  = document.getElementById('sq-modal-ok');
    const canBtn = document.getElementById('sq-modal-cancel');
    tEl.textContent = title; mEl.textContent = msg;
    iEl.style.display  = type === 'prompt'  ? 'block' : 'none';
    canBtn.style.display = type !== 'alert' ? 'inline-flex' : 'none';
    okBtn.textContent  = type === 'alert' ? 'OK' : 'Confirmar';
    if (type === 'prompt') { iEl.value = def || ''; setTimeout(() => iEl.focus(), 60); }
    const close = () => ov.classList.remove('open');
    okBtn.onclick = () => { close(); if (cb) cb(type === 'prompt' ? iEl.value : true); };
    canBtn.onclick = () => { close(); if (type === 'prompt') cb(null); };
    ov.classList.add('open');
  }

  /* ── API pública ──────────────────────────────────────── */
  window.SQ = {
    navigateTo, goBack, startNew,
    iniciarAvaliacaoDaFila, iniciarAvaliacaoDoSelect,
    excluirDaFila, excluirDoSelect,
    saveDraft, loadDraft, deleteDraft, viewDraft,
    registerEvaluation, viewHistoryRecord,
    renderDashboard, renderHistory,
    prevMirror, nextMirror,
    exportDashboardPDF,
    selectColor, selectShape,
    selectAllPallet, applyColorToPallet,
    toggleDropdown,
    toggleCollapsible,
    togglePopover,
    abrirDefinirCombinacao,
    salvarCombinacaoTipo,
    undoLastAction, clearAllMarks,
    formatTemperature, calculateCureTime, autoSetThickness,
    editField,
    changeMountType,
    openPalletModal, closePalletModal, setModalTipo,
    clearModalPlates, confirmPalletModal,
    init() {
      _carregarOpcoesMontagem();
      carregarAvaliacoesQualidade();
      startNew();
    },
  };

})();