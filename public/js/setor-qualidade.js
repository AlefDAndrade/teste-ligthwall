// ============================================================
//  SETOR DE QUALIDADE — Avaliação de Baterias
//  Dados salvos em localStorage com prefixo "sq_" para não
//  colidir com o Lightwall.
// ============================================================
'use strict';

(function () {

  /* ── Escape de HTML local ──────────────────────────────
     Função própria em vez de LW.escaparHtml (que já existe no mesmo
     documento — este arquivo carrega depois de data.js, ver
     index.template.html) só por não depender da ordem de carregamento
     dos scripts: histórico daqui é que, quando esta tela rodava dentro
     de um <iframe> à parte (setor-qualidade-app.html), LW simplesmente
     não existia neste documento, e usar LW.escaparHtml quebrava com
     "ReferenceError: LW is not defined" assim que havia algo real pra
     escapar — o erro subia e interrompia toda a função que estava
     rodando. A função local sobrou porque não há motivo real pra trocar
     algo que já funciona só pra "usar a função companheira". */
  function _escaparHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }

  // Mesmo escape de _escaparHtml, + aspas duplas — necessário só quando o
  // texto vai DENTRO de um atributo HTML delimitado por "..." (ex:
  // data-tooltip="..." nos gráficos SVG abaixo). _escaparHtml sozinho
  // escapa <, >, & (o bastante pra texto solto), mas não aspas — um
  // rótulo com " quebraria o atributo e corromperia o SVG.
  function _escaparAtributo(str) {
    return _escaparHtml(str).replace(/"/g, '&quot;');
  }

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
  // Botão "I" (indicador de qualidade) — ver toggleIndicadorAtivo, mais
  // abaixo. ATIVADO por padrão: o gesto normal do operador (marcar a cor
  // de status — verde/azul/vermelho) já funciona sem precisar tocar em
  // nada além da paleta de sempre. Só precisa DESATIVAR o "I" pra um
  // gesto raro: adicionar/corrigir manualmente uma marca de IDENTIDADE
  // (tipo de montagem), sem que ela conte como avaliação de status.
  // Cada marca nasce com essa informação gravada nela mesma (`role`:
  // 'indicador' | 'identidade') — é isso que resolve a fragilidade
  // antiga de reconstruir por eliminação/comparação quem era quem (ver
  // conversa que motivou: classifyMarks/_combinarComMarcas mais abaixo
  // agora têm um caminho novo, por papel, e um fallback antigo só pra
  // avaliações registradas antes desta mudança).
  let indicadorAtivo = true;
  let slabState      = {};
  // Motivo do defeito (código, ver MOTIVOS_DEFEITO) por placa — só
  // preenchido quando a placa vira 2ª linha (azul) ou reprovada
  // (vermelho); sempre um objeto PARALELO a slabState (mesma chave —
  // "stack{pallet}-{posicao}" — nunca uma propriedade DENTRO de cada
  // marca), porque o motivo é do PAINEL como um todo, não de uma marca
  // específica (um painel 3T reprovado, por exemplo, tem um círculo
  // vermelho + um traço amarelo — o motivo se refere ao painel, não a
  // qual das duas marcas). Precisa ser resetado/restaurado em todo lugar
  // que mexe em slabState — ver clearForm, clearAllMarks, pushState/undo,
  // saveDraft/loadDraft, _carregarAvaliacaoNoFormulario.
  let slabMotivo     = {};
  // Descrição livre — só existe (não-undefined) quando slabMotivo[id] ===
  // 'OT' ("Outros"); todo o resto do ciclo de vida (undo, rascunho,
  // limpar, carregar avaliação existente) trata este objeto exatamente
  // igual a slabMotivo, sempre em paralelo, mesma chave.
  let slabMotivoDescricao = {};
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

  // ── Pallets extras (botão "+" ao lado do último pallet) ──────────────
  // Os 4 pallets originais sempre têm o MESMO nº de placas (sq-thickness,
  // "n") — extras são criados VAZIOS e só recebem placas por arrastar
  // (ver _moverPainel). extraStacks guarda os NÚMEROS dos pallets extras
  // criados nesta avaliação, na ordem de criação (ex: [5,6]); stackCounts
  // guarda quantas placas cada pallet (original OU extra) tem AGORA — os
  // originais nascem com "n" cada, mas também mudam ao arrastar placas
  // pra fora/dentro deles. Ver _stackIds()/_resetStacksParaPadrao(),
  // abaixo, e _sincronizarColunasExtras() pro espelho no DOM.
  let extraStacks  = [];
  let stackCounts  = { stack1: 0, stack2: 0, stack3: 0, stack4: 0 };
  // Só cresce — nunca é decidido a partir de extraStacks.length/max, senão
  // excluir o pallet 6 (ver _removerPalletExtra) faria o próximo "+"
  // reaproveitar o nº 6 de novo. Resetado em _resetStacksParaPadrao (nova
  // avaliação do zero) e realinhado em _carregarAvaliacaoNoFormulario/
  // _restaurarEstadoDoRascunho (reabrir uma avaliação/rascunho que já
  // tinha pallets extras — continua a numeração de onde parou, não some
  // 5 se a avaliação salva já tinha ido até o 7).
  let proximoNumeroPalletExtra = 5;

  // ── Fila de baterias não avaliadas (Registro de Baterias → Setor de
  // Qualidade) — ver carregarFilaNaoAvaliadas()/_iniciarForm(), abaixo.
  let filaOperacoes    = [];  // última lista carregada de GET /operacoes-nao-avaliadas
  let linkedOperacaoId = null; // id_operacao da fila vinculado à avaliação em edição, ou null (avulsa)

  // ── Edição de avaliação já registrada (só Administrador) — aberta a
  // partir do Espelho Visual (ver editarAvaliacaoDoEspelho). Diferente
  // de linkedOperacaoId (que é sobre uma avaliação NOVA, ainda ligada a
  // uma bateria da fila), estas 3 variáveis só existem enquanto o
  // formulário está corrigindo uma avaliação JÁ SALVA — não nula só
  // nesse caso; registerEvaluation() usa isso pra saber se deve
  // sobrescrever o registro original (mesmo id) em vez de criar um novo.
  // Resetadas em clearForm() e ao sair da aba "form" por qualquer
  // caminho (ver navigateTo) — nunca deve "vazar" pra uma avaliação nova
  // e acabar sobrescrevendo a antiga por engano.
  let _editandoAvaliacaoId      = null;
  let _editandoRegistradoEm     = null;
  let _editandoLinkedOperacaoId = null;
  let _editandoAvaliadorNome    = null;

  // ── Tipos de montagem — vem de config.json (tipos_montagem.opcoes),
  // NUNCA mais fixo/hardcoded aqui (ver _carregarOpcoesMontagem). Cache
  // usado tanto pra montar o <select> quanto pra mapear tipo_montagem de
  // uma operação real (que guarda o LABEL, ex: "S/P") de volta pro código
  // usado internamente aqui (ex: "SP") — ver _codigoMontagemPorLabel.
  let _montagemOpcoesCache = [];

  // ── Combinações de marcação → tipo simples (Referência de Marcadores) —
  // cada tipo SIMPLES carrega sua própria combinação (campo
  // `combinacaoAvaliacao` dentro do próprio item de
  // tipos_montagem.opcoes) — nasce vazia (null) quando o tipo é criado em
  // Configurações → Montagem (ver cfgAdicionarMontagemSimples, app-
  // core.js), e é preenchida em Configurações → Paletes → "Combinações
  // de Avaliação" (ver public/js/paletes-combinacoes.js). Este arquivo só
  // LÊ o campo (_combinacoesEfetivas, mais abaixo) pra usar na avaliação
  // de verdade. _configBrutoCache guarda o config.json inteiro (não só
  // tipos_montagem) porque a migração de formato antigo
  // (_migrarCombinacoesParaTiposMontagem, abaixo) pode precisar persistir
  // de volta via /salvar-config, que substitui o arquivo inteiro.
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
      const res = await fetch('/db/config.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('Falha ao buscar config.json');
      const cfg = await res.json();
      const migrou = _migrarCombinacoesParaTiposMontagem(cfg);
      _configBrutoCache = cfg;
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
      _renderTabelaCombinacoes();
      _renderBotoesTipoModal();

      // Migração é feita só uma vez por instalação: persiste de volta pro
      // config.json assim que detectada, pra outros dispositivos/abas já
      // carregarem o formato novo direto, sem precisar migrar de novo.
      if (migrou) {
        fetch('/salvar-config', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
        }).catch(err => console.error('Falha ao persistir migração de combinações de avaliação:', err));
      }
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
      // Sem tipos_montagem carregados, a tabela de combinações cai pro
      // fallback do próprio código em maiúsculas (_labelDoTipoMontagem) —
      // mesmo texto que sempre apareceu (2P/SP/3T/1T), só que agora
      // gerado, não mais hardcoded no HTML.
      _renderTabelaCombinacoes();
      _renderBotoesTipoModal();
    }
  }

  // Migração única — instalações de antes desta mudança têm as
  // combinações separadas em cfg.marcadores_qualidade.opcoes. Copia cada
  // uma pro campo combinacaoAvaliacao do tipo correspondente (por código
  // `tipo`) em cfg.tipos_montagem.opcoes, e remove a lista antiga (não é
  // mais lida por nada depois desta mudança). Idempotente: instalação já
  // migrada (sem marcadores_qualidade, ou já com combinacaoAvaliacao
  // preenchido) não sofre nenhuma alteração — devolve false nesse caso,
  // pra _carregarOpcoesMontagem saber que não precisa regravar o arquivo.
  function _migrarCombinacoesParaTiposMontagem(cfg) {
    const antigas = Array.isArray(cfg?.marcadores_qualidade?.opcoes) ? cfg.marcadores_qualidade.opcoes : [];
    if (!antigas.length) return false;
    const tipos = Array.isArray(cfg?.tipos_montagem?.opcoes) ? cfg.tipos_montagem.opcoes : [];
    let mudou = false;
    antigas.forEach(c => {
      const alvo = tipos.find(o => o && o.modo === 'simples' && o.tipo === c.tipo);
      // Grava no formato ANTIGO (forma/corModificadora) de propósito —
      // _normalizarCombinacao (ver _combinacoesEfetivas, mais abaixo)
      // converte pro formato novo (marcas[]/indicadorIndex) na leitura,
      // então não precisa reescrever isso aqui também.
      if (alvo && !alvo.combinacaoAvaliacao) {
        alvo.combinacaoAvaliacao = { forma: c.forma, corModificadora: c.corModificadora };
        mudou = true;
      }
    });
    delete cfg.marcadores_qualidade; // formato antigo, não é mais lido por nada depois de migrado
    return mudou;
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

  // (Sem mais "charts"/Chart.js — os gráficos do dashboard agora são SVG
  // puro, gerado em _renderGraficosDashboard() logo antes de
  // renderDashboard(). Sem canvas, sem estado de instância pra
  // destruir entre re-renders.)

  /* ── Combinações de marcação → tipo simples ────────────────
     Modelo novo (ver conversa que motivou — painel visual em
     Configurações → Paletes → "Combinações de Avaliação",
     paletes-combinacoes.js): cada combinação é uma LISTA de marcas
     (`marcas`: [{shape, color}, ...], até MAX_MARCAS_POR_PLACA), com UM
     índice (`indicadorIndex`) marcando qual delas é o INDICADOR DE
     QUALIDADE — a posição onde a cor real (verde/azul/vermelho,
     aprovado 1ª linha / 2ª linha / reprovado) entra na hora da
     avaliação de verdade. Todo o RESTO das marcas (a "identidade") tem
     cor FIXA e nasce sozinho, automático (ver _marcasDeIdentificacao) —
     o indicador nunca é pré-preenchido, é sempre o operador quem marca.
     O indicador pode ser QUALQUER shape (círculo OU traço — não é mais
     sempre o círculo como antes desta mudança).
     
     Vem do campo combinacaoAvaliacao de cada item em config.json
     (tipos_montagem.opcoes) — qualquer tipo simples novo cadastrado
     nasce com combinacaoAvaliacao vazio (null), e só ganha uma
     combinação quando alguém definir uma em Configurações → Paletes.
     Até lá, ou enquanto config.json ainda não carregou, usa exatamente
     o comportamento de sempre (COMBINACOES_PADRAO) — ninguém que já usa
     2P/SP/3T/1T é afetado por esta mudança. */
  const COMBINACOES_PADRAO = [
    { tipo: '2p', marcas: [{ shape: 'circle', color: null }], indicadorIndex: 0 },
    { tipo: 'sp', marcas: [{ shape: 'dash', color: null }], indicadorIndex: 0 },
    { tipo: '3t', marcas: [{ shape: 'circle', color: null }, { shape: 'dash', color: 'amarelo' }], indicadorIndex: 0 },
    { tipo: '1t', marcas: [{ shape: 'circle', color: null }, { shape: 'dash', color: 'laranja' }], indicadorIndex: 0 },
  ];
  // Vermelho NUNCA entra numa marca de IDENTIDADE (regra fixa, não
  // configurável) — é sempre a cor de "reprovado" no INDICADOR, em
  // QUALQUER combinação. Verde/azul também são sempre o par "aprovado
  // 1ª/2ª linha" no indicador — a única coisa que realmente varia de
  // tipo pra tipo é QUANTAS marcas tem, QUAIS formas/cores são a
  // identidade fixa, e qual posição é o indicador.
  //
  // IMPORTANTE — a cor de uma marca de IDENTIDADE é livre: qualquer uma
  // das 5 cores serve pra identificar um tipo (não só amarelo/laranja),
  // incluindo verde/azul/vermelho — um traço verde usado como identidade
  // FIXA (não como indicador) não significa "aprovado", só identifica o
  // tipo; quem dita aprovado/reprovado é sempre a cor da marca no slot do
  // INDICADOR (ver _combinarComMarcas(), logo abaixo).

  // ── Marcador "X" — Painel não preenchido ──────────────────────────
  // Forma extra, fora do sistema círculo/traço de COMBINACOES_PADRAO:
  // não representa nenhum tipo de montagem, não é combinável com outra
  // marca (sempre sozinha, ver toggleMark/applyMarksToPallet) e nunca
  // muda de cor — é sempre cinza fixo (COR_NAO_PREENCHIDO), diferente de
  // verde/vermelho/azul/amarelo/laranja (que o usuário escolhe). Existe
  // pra distinguir, na hora de marcar, um painel que o avaliador olhou e
  // decidiu conscientemente "não deu pra preencher" de um painel apenas
  // esquecido (que fica "Sem marcação", ver classifyMarks). Entra numa
  // categoria própria nos relatórios/KPIs — nunca conta como aprovado
  // nem reprovado (ver getClassifiedInfo: resultado vira
  // "não_preenchido", que nenhum filtro `resultado==='aprovado'/
  // 'reprovado'` do dashboard/relatórios reconhece).
  const COR_NAO_PREENCHIDO = 'cinza';

  // Limite de marcas repetidas numa mesma placa — decidido na conversa
  // que motivou essa mudança (ver toggleMark/toggleMarkErase, abaixo):
  // antes só existia NO MÁXIMO 1 marca por combinação cor+forma (a lógica
  // de apagar era clicar de novo na mesma combinação); agora a mesma
  // combinação pode se repetir na placa, mas até este teto — evita uma
  // placa pequena (30px de altura) virando uma bagunça visual ilegível.
  const MAX_MARCAS_POR_PLACA = 6;

  // Motivo do defeito — obrigatório sempre que uma placa vira 2ª linha
  // (azul) ou reprovada (vermelho): ver _corExigeMotivo/_abrirSeletorMotivo,
  // mais abaixo. Lista fixa (não configurável em Configurações — diferente
  // dos tipos de montagem), porque é terminologia de qualidade já em uso
  // na fábrica, não algo que varia por instalação.
  const MOTIVOS_DEFEITO = [
    { codigo: 'BC', nome: 'Borra de Cimento' },
    { codigo: 'CD', nome: 'Cimentícia Descamando' },
    { codigo: 'CC', nome: 'Cimentícia Não Colada' },
    { codigo: 'CF', nome: 'Cimentícia Fora de Posição' },
    { codigo: 'EM', nome: 'Espessura Maior' },
    { codigo: 'EP', nome: 'Engoliu Placa' },
    { codigo: 'FD', nome: 'Falha Desmoldante' },
    { codigo: 'FE', nome: 'Falha Enchimento' },
    { codigo: 'FT', nome: 'Falha Traço' },
    { codigo: 'PA', nome: 'Painel Amassado' },
    { codigo: 'QE', nome: 'Quebra por Empilhadeira' },
    { codigo: 'PQ', nome: 'Painel Quebrado' },
    { codigo: 'PT', nome: 'Perfil Torto' },
    { codigo: 'TR', nome: 'Trincada' },
    // "Outros" é diferente de todo o resto da lista: não tem uma
    // descrição fixa — quem marca digita a descrição na hora (ver
    // _abrirSeletorMotivo, showPrompt). O hover no badge "OT" mostra essa
    // descrição digitada, não um nome fixo (diferente dos outros 14
    // códigos, cujo hover é sempre o mesmo texto pra todo mundo).
    { codigo: 'OT', nome: 'Outros' },
  ];
  const _MOTIVO_POR_CODIGO = Object.fromEntries(MOTIVOS_DEFEITO.map(m => [m.codigo, m.nome]));

  // Cor da MARCA que dispara a exigência de motivo — 2ª linha (azul) e
  // reprovado (vermelho), nas duas formas (círculo sozinho, ou traço
  // sozinho quando o tipo é "traço só" — ver COMBINACOES_PADRAO). Verde
  // (1ª linha aprovada) e amarelo/laranja (modificador de tipo, não de
  // status) NUNCA exigem motivo — só fazem sentido junto de um círculo,
  // que é quem já decide aprovado/reprovado.
  function _corExigeMotivo(cor) {
    return cor === 'azul' || cor === 'vermelho';
  }

  // Marca que de fato exige motivo de defeito: precisa ser azul/vermelho
  // E precisa ser a marca de STATUS (role === 'indicador') — uma marca de
  // IDENTIDADE (role === 'identidade') com cor azul/vermelho "por acaso"
  // (ex: cor fixa de identificação automática, ou marca manual de
  // identidade) NUNCA exige motivo, nunca mostra o "?"/código no painel,
  // e nunca deve abrir o seletor (ver toggleMark/applyMarksToPallet, que
  // já filtravam certo por role — este helper centraliza o MESMO
  // critério pros demais pontos que só olhavam a cor, ver conversa que
  // motivou: marca vermelha de identidade estava sendo tratada como se
  // fosse indicador de qualidade).
  function _marcaExigeMotivo(m) {
    return !!m && m.role === 'indicador' && _corExigeMotivo(m.color);
  }

  // CORRIGIDO (ver conversa que motivou): antes, bastava UM tipo simples
  // ganhar combinacaoAvaliacao própria em Configurações → Paletes →
  // "Combinações de Avaliação" pra TODOS os outros tipos (ainda sem
  // combinação própria) perderem COMBINACOES_PADRAO de uma vez — o
  // antigo `doConfig.length ? doConfig : COMBINACOES_PADRAO` era
  // tudo-ou-nada pro array inteiro, não por tipo. Na prática: definir a
  // combinação de 1 tipo (ex.: 3T) fazia os painéis de outro tipo nunca
  // configurado (ex.: 2P, S/P) pararem de bater com qualquer combinação
  // — caíam em "Outros" e o painel ficava vermelho (inválido) mesmo
  // marcado do jeito de sempre.
  //
  // Agora a resolução é POR TIPO: cada tipo simples cadastrado usa a
  // própria combinacaoAvaliacao se ela existir (a nova é a única válida
  // pra ele — a antiga, seja o padrão fixo ou uma combinação anterior,
  // deixa de valer só PRA ESSE TIPO); na ausência dela, cai no padrão
  // fixo (COMBINACOES_PADRAO) só se esse tipo for um dos 4 códigos
  // legados (2p/sp/3t/1t) — sem afetar os demais tipos.
  function _combinacoesEfetivas() {
    const simples = (_montagemOpcoesCache || []).filter(o => o && o.modo === 'simples' && o.tipo);
    // Cache ainda vazio (config.json não carregou, ou nenhum tipo simples
    // cadastrado) — mantém o comportamento de sempre pra não quebrar
    // instalação nova/testes que não simulam config.json real.
    if (!simples.length) return COMBINACOES_PADRAO;
    return simples
      .map(o => {
        if (o.combinacaoAvaliacao) {
          const normalizada = _normalizarCombinacao(o.tipo, o.combinacaoAvaliacao);
          if (normalizada) return normalizada;
        }
        return COMBINACOES_PADRAO.find(c => c.tipo === o.tipo) || null;
      })
      .filter(Boolean);
  }

  // Aceita tanto o formato NOVO (marcas[]/indicadorIndex) quanto formatos
  // antigos, salvos por versões anteriores desta funcionalidade — migração
  // silenciosa só em memória (não regrava o config.json sozinha; a próxima
  // vez que alguém salvar uma combinação de verdade em Configurações, já
  // grava no formato novo). Formatos antigos:
  //   - { forma: 'circle'|'dash', corModificadora } — marca única.
  //   - { forma: 'circle+dash', corModificadora, posicaoIndicador } —
  //     círculo sempre indicador, traço sempre identidade fixa.
  function _normalizarCombinacao(tipo, c) {
    if (!c) return null;
    if (Array.isArray(c.marcas) && c.marcas.length && Number.isInteger(c.indicadorIndex)) {
      return { tipo, marcas: c.marcas, indicadorIndex: c.indicadorIndex };
    }
    if (c.forma === 'circle' || c.forma === 'dash') {
      return { tipo, marcas: [{ shape: c.forma, color: null }], indicadorIndex: 0 };
    }
    if (c.forma === 'circle+dash') {
      // No formato antigo, o círculo sempre era o indicador — só a
      // ORDEM visual variava (posicaoIndicador). 'antes' (ou ausente,
      // formato bem antigo de antes dessa posição existir) = círculo
      // primeiro; 'depois' = traço primeiro.
      const antes = c.posicaoIndicador !== 'depois';
      return antes
        ? { tipo, marcas: [{ shape: 'circle', color: null }, { shape: 'dash', color: c.corModificadora }], indicadorIndex: 0 }
        : { tipo, marcas: [{ shape: 'dash', color: c.corModificadora }, { shape: 'circle', color: null }], indicadorIndex: 1 };
    }
    return null;
  }

  // ── Marcas de IDENTIDADE automáticas (ver conversa que motivou:
  // "as placas já vão chegar marcadas conforme os tipos de montagem" —
  // adianta a identidade sozinha, mas a PALETA CONTINUA COMPLETA (cor +
  // forma manuais, como sempre foi) — o operador pode marcar, apagar ou
  // corrigir qualquer combinação normalmente, inclusive as marcas
  // automáticas; isso aqui só poupa cliques no caso comum).
  //
  // Toda marca da combinação EXCETO a do índice `indicadorIndex` nasce
  // automática, com a cor FIXA definida na configuração — o indicador
  // nunca é pré-preenchido (não tem cor fixa: é onde a cor de STATUS do
  // operador entra, ver conversa que motivou o painel visual em
  // Configurações → Paletes → "Combinações de Avaliação"). Tipos de
  // marca ÚNICA (indicadorIndex é a única marca que existe) não recebem
  // nada automático — uma marca só já identifica tipo E status ao mesmo
  // tempo, então não tem o que pré-preencher.
  //
  // `auto: true` marca a origem — usado só por
  // _preencherMarcasDeIdentificacao (abaixo) pra saber quais marcas
  // regenerar a cada reset da grade, nunca lido por classifyMarks/
  // renderMarks (tratadas como qualquer outra marca pra tudo o mais,
  // inclusive apagável pelo gesto de apagar — de propósito, ainda em
  // fase de teste, ver conversa).
  function _marcasDeIdentificacao(id) {
    const tipo = (getExpectedType(id) || '').toLowerCase();
    if (!tipo) return [];
    const combo = _combinacoesEfetivas().find(c => c.tipo === tipo);
    if (!combo) return [];
    return combo.marcas
      .filter((_, i) => i !== combo.indicadorIndex)
      .map(m => ({ color: m.color, shape: m.shape, auto: true, role: 'identidade' }));
  }

  // Regenera as marcas automáticas de TODAS as placas em escopo agora —
  // chamada ao final de _resetStacksParaPadrao (troca de Tipo de
  // Montagem, Espessura, pré-preenchimento a partir de uma operação
  // real...), mesmo ponto que já reconstrói a grade do zero. Preserva
  // qualquer marca que o operador já tenha adicionado (filtra só as
  // antigas `auto`, mantém o resto) — troca de tipo só atualiza a
  // identificação, nunca mexe na validação que já foi dada. "X" (painel
  // não preenchido) é sempre sozinho — nunca emenda identificação nele.
  function _preencherMarcasDeIdentificacao() {
    _stackIds().forEach(sid => {
      const n = stackCounts[sid] || 0;
      for (let i = 1; i <= n; i++) {
        const id = `${sid}-${i}`;
        const atuais = slabState[id] || [];
        if (atuais.some(m => m.shape === 'x')) continue;
        const semAuto = atuais.filter(m => !m.auto);
        const novasAuto = _marcasDeIdentificacao(id);
        const combinado = [...semAuto, ...novasAuto];
        if (combinado.length) slabState[id] = combinado; else delete slabState[id];
      }
    });
  }

  /* ── Classificação de marcas ──────────────────────────── */
  // CAMINHO NOVO (ver conversa que motivou o botão "I"/toggleIndicadorAtivo):
  // cada marca já nasce sabendo o próprio papel (`role`: 'indicador' ou
  // 'identidade') — não precisa mais RECONSTRUIR por eliminação quem é
  // quem comparando o conjunto inteiro contra a combinação cadastrada
  // (isso que deixava a classificação frágil: qualquer marca a mais/a
  // menos, ou duas marcas parecidas, e nada batia — o painel ficava
  // vermelho sem pista do motivo). Agora:
  //   1. Separa as marcas por `role` (indicador vs identidade) — direto,
  //      sem ambiguidade.
  //   2. As marcas de indicador precisam ser todas da MESMA forma e
  //      MESMA cor entre si (repetir a mesma marca de status é permitido;
  //      cores diferentes = o operador clicou 2 status diferentes na
  //      mesma placa, aí é "Múltiplas" mesmo).
  //   3. Procura a combinação cadastrada cujo indicador tenha essa forma
  //      E cujas marcas de identidade batam EXATAMENTE com as marcas que
  //      o operador (ou o preenchimento automático) marcou como
  //      'identidade' — nem faltando, nem sobrando.
  // Devolve a combinação encontrada + a cor real do indicador, 'ambiguo'
  // se houver mais de 1 cor de indicador na mesma placa, ou null se não
  // bater com nenhuma combinação cadastrada.
  function _combinarPorPapel(marks) {
    const indicadores = marks.filter(m => m.role === 'indicador');
    if (!indicadores.length) return null; // ainda não tem marca de status nessa placa
    const formaIndicador = indicadores[0].shape;
    const coresIndicador = new Set(indicadores.map(m => m.color));
    if (coresIndicador.size > 1 || indicadores.some(m => m.shape !== formaIndicador)) return 'ambiguo';
    const corIndicador = indicadores[0].color;

    const marcasIdentidade = marks.filter(m => m.role === 'identidade');
    const combinacoes = _combinacoesEfetivas();
    for (const combo of combinacoes) {
      const marcasCombo = combo.marcas || [];
      const indicadorDef = marcasCombo[combo.indicadorIndex];
      if (!indicadorDef || indicadorDef.shape !== formaIndicador) continue;
      const identidadeDef = marcasCombo.filter((_, i) => i !== combo.indicadorIndex);
      const restantes = [...marcasIdentidade];
      let bateu = true;
      for (const idm of identidadeDef) {
        const idx = restantes.findIndex(m => m.shape === idm.shape && m.color === idm.color);
        if (idx === -1) { bateu = false; break; }
        restantes.splice(idx, 1);
      }
      // Não pode faltar NEM sobrar marca de identidade — diferente do
      // modelo antigo, aqui não tem ambiguidade nenhuma pra tolerar
      // (cada marca já diz o que é), então exigir o conjunto exato ajuda
      // a pegar erro de configuração/operador na hora, em vez de deixar
      // passar silenciosamente.
      if (bateu && !restantes.length) return { combo, corIndicador };
    }
    return null;
  }

  // FALLBACK ANTIGO — só usado quando alguma marca da placa não tem
  // `role` (avaliação registrada ANTES desta mudança, sem o campo
  // salvo). Tenta casar as marcas de UMA placa com alguma combinação
  // cadastrada: separa a marca do "slot indicador" (a que carrega a cor
  // de status) das marcas de "identidade" (cor+forma fixas, que
  // precisam bater exatamente) por eliminação — devolve a combinação
  // encontrada + a cor real que caiu no slot indicador, ou null se as
  // marcas não baterem com nenhuma combinação cadastrada.
  function _combinarComMarcas(marks) {
    const combinacoes = _combinacoesEfetivas();
    for (const combo of combinacoes) {
      const marcasCombo = combo.marcas || [];
      const indicadorDef = marcasCombo[combo.indicadorIndex];
      if (!indicadorDef) continue;
      const identidade = marcasCombo.filter((_, i) => i !== combo.indicadorIndex);
      const restantes = [...marks];
      let bateu = true;
      for (const idm of identidade) {
        const idx = restantes.findIndex(m => m.shape === idm.shape && m.color === idm.color);
        if (idx === -1) { bateu = false; break; }
        restantes.splice(idx, 1);
      }
      // Precisa sobrar pelo menos 1 marca (a do operador, no slot
      // indicador) e TUDO que sobrou precisa ser da MESMA FORMA do
      // indicador (repetições da mesma marca são permitidas — decide
      // pela 1ª, mesmo raciocínio de sempre: a 1ª marca de cada forma
      // dita a classificação).
      if (!bateu || !restantes.length) continue;
      if (!restantes.every(m => m.shape === indicadorDef.shape)) continue;
      return { combo, corIndicador: restantes[0].color };
    }
    return null;
  }

  // CORRIGIDO (ver conversa que motivou): combinações com mais de 1 marca
  // têm um componente de IDENTIDADE que nasce sozinho, automático, assim
  // que o Tipo de Montagem é escolhido — ANTES de o operador marcar o
  // indicador de verdade em qualquer placa (ver _preencherMarcasDeIdentificacao/
  // _marcasDeIdentificacao, mais acima). Sem este helper, uma placa com
  // SÓ as marcas automáticas (nenhuma marca do operador ainda) não batia
  // com NENHUMA combinação cadastrada (falta o indicador) e virava
  // "Outros"/"Múltiplas" — TODAS as placas do tipo escolhido, ainda nem
  // tocadas pelo operador, ficavam vermelhas (.invalid, ver
  // validateAllSlabs) na hora, só de selecionar o Tipo de Montagem. Uma
  // placa só conta como "com marcação de verdade" quando tem pelo menos
  // 1 marca que NÃO é `auto` (ou seja, o operador já clicou nela).
  function _somenteMarcasAuto(marks) {
    return marks.length > 0 && marks.every(m => m.auto);
  }

  function classifyMarks(marks) {
    // "X" é sempre sozinho (garantido em toggleMark/applyMarksToPallet —
    // adicionar um X limpa qualquer outra marca da placa, e vice-versa),
    // então basta checar a presença dele antes de qualquer outra coisa.
    if (marks.some(m => m.shape === 'x')) return 'Não preenchido';
    if (!marks.length || _somenteMarcasAuto(marks)) return 'Sem marcação';
    const ok = c => c === 'verde' || c === 'azul';

    // Modelo novo (todas as marcas já têm `role`) vs fallback antigo
    // (avaliação registrada antes do botão "I" existir — ver
    // _combinarPorPapel/_combinarComMarcas, mais acima).
    const temRole = marks.every(m => m.role);
    const achado = temRole ? _combinarPorPapel(marks) : _combinarComMarcas(marks);
    if (achado === 'ambiguo') return 'Múltiplas'; // >1 cor de indicador na mesma placa
    if (achado) {
      if (ok(achado.corIndicador)) return `${achado.combo.tipo.toUpperCase()} aprovado`;
      if (achado.corIndicador === 'vermelho') return `${achado.combo.tipo.toUpperCase()} reprovado`;
      return 'Outros'; // combinação bateu, mas a cor no slot indicador não é uma cor de status válida
    }
    // Nenhuma combinação bateu: mais de 1 marca sem bater = "Múltiplas"
    // (mistura estranha); 1 marca só sem bater com nenhum tipo = "Outros"
    // (forma reconhecida, mas sem combinação cadastrada pra ela).
    return marks.length > 1 ? 'Múltiplas' : 'Outros';
  }
  function getClassifiedInfo(marks) {
    const s = classifyMarks(marks);
    if (['Sem marcação', 'Múltiplas', 'Outros', 'Não preenchido'].includes(s))
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
  // em classifyMarks() (a do slot INDICADOR — ver _combinarComMarcas,
  // acima — pode ser círculo ou traço, depende da combinação).
  function _linhaDoAprovado(marks) {
    const temRole = marks.every(m => m.role);
    const achado = temRole ? _combinarPorPapel(marks) : _combinarComMarcas(marks);
    const cor = (achado && achado !== 'ambiguo') ? achado.corIndicador : null;
    if (cor === 'verde') return '1ª';
    if (cor === 'azul')  return '2ª';
    return null;
  }

  /* ── Referência de Marcadores: tipos sem combinação definida ──────
     Verifica os tipos simples cadastrados em Configurações → Montagem
     (tipos_montagem.opcoes) cujo campo combinacaoAvaliacao ainda está
     vazio (null — estado de quando o tipo foi criado) — qualquer tipo
     simples cadastrado que ainda não tenha uma combinação aparece aqui
     como aviso. Definir a combinação de verdade agora é só em
     Configurações → Paletes → "Combinações de Avaliação" (ver
     paletes-combinacoes.js — painel visual com marcas + indicador "i");
     o picker rápido que existia aqui (círculo sozinho/traço sozinho/
     círculo+traço com 1 cor) foi removido porque não dava pra
     representar o modelo novo (marcas em qualquer quantidade, indicador
     em qualquer uma delas) sem duplicar toda a lógica do painel visual
     numa 2ª tela — mais simples ter 1 lugar só pra definir. */
  function _tiposSimplesSemCombinacao() {
    const simples = (_montagemOpcoesCache || []).filter(o => o && o.modo === 'simples' && o.tipo && o.label);
    const combinacoes = _combinacoesEfetivas();
    return simples.filter(o => !combinacoes.some(c => c.tipo === o.tipo));
  }

  // Monta a seção dinâmica dentro do popover "📖 Referência" — chamada
  // sempre que config.json é recarregado (_carregarOpcoesMontagem).
  function _renderAvisoCombinacoesFaltando() {
    const el = document.getElementById('sq-ref-sem-combinacao');
    if (!el) return;
    const semCombinacao = _tiposSimplesSemCombinacao();
    if (!semCombinacao.length) { el.innerHTML = ''; return; }

    el.innerHTML = `
      <hr class="divider" style="margin:10px 0">
      <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);font-weight:700;margin-bottom:8px">
        ⚠️ Tipos sem marcação definida
      </div>
      <p style="font-size:.76rem;color:var(--text-3);margin-bottom:8px">
        Defina em Configurações → Paletes → "Combinações de Avaliação":
      </p>
      ${semCombinacao.map(o => `
        <div class="sq-ref-tipo-pendente" id="sq-ref-pendente-${o.tipo}">
          <span style="font-size:.82rem"><strong>${_escaparHtml(o.label)}</strong> (${String(o.tipo).toUpperCase()})</span>
        </div>`).join('')}
    `;
  }

  // Monta a tabela "Combinação → Classificação" dentro do popover "📖
  // Referência" — antes era texto fixo no HTML (sempre "2P"/"SP"/"3T"/
  // "1T", mesmo quando o tipo cadastrado em Configurações → Montagem
  // tinha outro código ou nem existia). Agora cada linha vem das
  // combinações efetivas (_combinacoesEfetivas — campo combinacaoAvaliacao
  // de cada tipo em tipos_montagem.opcoes, com COMBINACOES_PADRAO como
  // reserva) e o nome exibido é sempre o LABEL real do tipo simples correspondente
  // em tipos_montagem.opcoes (ex.: código "sp" cadastrado com label
  // "S/P" aparece como "S/P", não como "SP" — são a mesma coisa, só
  // "SP" é o código interno usado pra casar com a combinação, nunca o
  // texto mostrado pro usuário). Tipo sem cadastro correspondente (ex.:
  // "1t" de COMBINACOES_PADRAO antes de existir um tipo "1T" em
  // Configurações) cai no fallback do próprio código em maiúsculas, pra
  // nunca ficar com uma linha em branco.
  function _labelDoTipoMontagem(tipo) {
    const opcao = (_montagemOpcoesCache || []).find(o => o && o.modo === 'simples' && o.tipo === tipo);
    return opcao ? opcao.label : String(tipo).toUpperCase();
  }

  function _renderTabelaCombinacoes() {
    const tbody = document.getElementById('sq-ref-combinacoes-tbody');
    if (!tbody) return;

    const marca = (shape, cor, extraStyle) =>
      `<span class="sq-shape-${shape}" style="display:inline-block;background:var(--sq-cor-${cor});${extraStyle || ''}"></span>`;

    const linhas = [];
    _combinacoesEfetivas().forEach(combo => {
      const label = _escaparHtml(_labelDoTipoMontagem(combo.tipo));
      const marcasCombo = combo.marcas || [];
      const indicadorDef = marcasCombo[combo.indicadorIndex];
      if (!indicadorDef) return;

      // Monta a combinação visual na ORDEM de combo.marcas (a mesma
      // ordem escolhida no painel de Configurações → Paletes →
      // "Combinações de Avaliação") — cada marca de identidade usa sua
      // cor fixa; a marca do indicador mostra as 2 opções possíveis
      // (verde/azul juntas pra "aprovado", vermelho sozinho pra
      // "reprovado").
      const descricaoFormas = marcasCombo.map((m, i) =>
        i === combo.indicadorIndex ? `${m.shape === 'circle' ? 'círculo' : 'traço'} (indicador)` : `${m.shape === 'circle' ? 'círculo' : 'traço'} ${m.color}`
      ).join(' + ');

      linhas.push([
        `${marca(indicadorDef.shape, 'verde', 'margin-right:1px')}${marca(indicadorDef.shape, 'azul', 'margin-right:4px')}${marcasCombo.length > 1 ? '+' + marcasCombo.filter((_, i) => i !== combo.indicadorIndex).map(m => marca(m.shape, m.color, 'margin:0 2px')).join('+') : ''} ${descricaoFormas}`,
        `Painel <strong>${label}</strong> aprovado`,
      ]);
      linhas.push([
        `${marca(indicadorDef.shape, 'vermelho', 'margin-right:4px')}${marcasCombo.length > 1 ? '+' + marcasCombo.filter((_, i) => i !== combo.indicadorIndex).map(m => marca(m.shape, m.color, 'margin:0 2px')).join('+') : ''} ${descricaoFormas}`,
        `Painel <strong>${label}</strong> reprovado`,
      ]);
    });

    if (!linhas.length) {
      tbody.innerHTML = `<tr><td colspan="2" style="padding:8px 0;color:var(--text-3);font-size:.76rem">Nenhuma combinação definida ainda.</td></tr>`;
      return;
    }

    tbody.innerHTML = linhas.map(([combinacao, classificacao], i) => {
      const semBorda = i === linhas.length - 1;
      const borda = semBorda ? '' : 'border-bottom:1px solid var(--border)';
      return `
        <tr>
          <td style="padding:7px 6px 7px 0;${borda}">${combinacao}</td>
          <td style="padding:7px 0 7px 6px;${borda}">${classificacao}</td>
        </tr>`;
    }).join('');
  }

  // Popover "Motivos" no cabeçalho do Espelho Visual — o que cada código
  // (ex: "BC") significa. Renderizado 1 vez, no init (a lista é fixa,
  // MOTIVOS_DEFEITO, não muda em tempo de execução) — diferente de
  // _renderTabelaCombinacoes/_renderAvisoCombinacoesFaltando, que dependem
  // de config.json e por isso são re-renderizadas toda vez que ele recarrega.
  function _renderReferenciaMotivos() {
    const el = document.getElementById('popover-sq-motivos');
    if (!el) return;
    el.innerHTML = `
      <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);font-weight:700;margin-bottom:8px">
        Motivo do defeito (2ª linha / reprovado)
      </div>
      <div style="display:flex;flex-direction:column;gap:5px;font-size:.8rem">
        ${MOTIVOS_DEFEITO.map(m => `
          <div style="display:flex;gap:8px"><strong style="min-width:26px;color:var(--accent)">${m.codigo}</strong><span>${_escaparHtml(m.nome)}${m.codigo === 'OT' ? ' — descrição livre, veja no hover do código' : ''}</span></div>
        `).join('')}
      </div>`;
  }

  /* ── Pallets extras — infraestrutura ──────────────────── */
  // Lista de TODOS os pallets ativos agora, na ordem de exibição: os 4
  // originais primeiro, depois os extras na ordem em que foram criados.
  function _stackIds() {
    return ['stack1', 'stack2', 'stack3', 'stack4', ...extraStacks.map(n => 'stack' + n)];
  }

  // Remove qualquer entrada de slabState/slabMotivo/slabMotivoDescricao/
  // slabConfig fora do "escopo" atual (pallet que não existe mais, ou
  // posição além da contagem atual do pallet) — sem isso, encolher um
  // pallet (arrastar placa pra fora) ou resetar os extras deixaria
  // registros "fantasma" pra trás que registerEvaluation ainda enviaria
  // pro servidor (ele envia Object.entries(slabState) inteiro, ver
  // registerEvaluation), inflando o total de placas registradas.
  function _limparPlacasForaDoEscopo() {
    const validos = new Set();
    _stackIds().forEach(sid => {
      const n = stackCounts[sid] || 0;
      for (let i = 1; i <= n; i++) validos.add(`${sid}-${i}`);
    });
    [slabState, slabMotivo, slabMotivoDescricao, slabConfig].forEach(dict => {
      Object.keys(dict).forEach(id => {
        if (id.includes('-') && !validos.has(id)) delete dict[id];
      });
    });
  }

  // Volta os pallets pro estado padrão: só os 4 originais, cada um com
  // "n" placas (nº atual de sq-thickness) — chamado em todo lugar que já
  // reconstrói a grade do zero (troca de Tipo de Montagem, confirmação da
  // grade Personalizada, pré-preenchimento a partir de uma operação real,
  // autoSetThickness) — qualquer reorganização manual feita por arrastar
  // é descartada nesses casos, igual já acontecia com marcações antes
  // desta mudança não existir.
  function _resetStacksParaPadrao() {
    const n = parseInt(document.getElementById('sq-thickness').value) || 0;
    extraStacks = [];
    proximoNumeroPalletExtra = 5;
    stackCounts = { stack1: n, stack2: n, stack3: n, stack4: n };
    _limparPlacasForaDoEscopo();
    _sincronizarColunasExtras();
    // Reaplica por cima da contagem "cheia" que acabou de nascer — ver
    // _removerPaineisNaoEnchidosDaGrade/_definirPaineisNaoEnchidos: sem
    // isso, qualquer reset posterior (troca de Tipo de Montagem, de
    // Espessura) devolveria pra grade os painéis que o operador já
    // marcou como "não enchido" em Bateria Atual.
    _removerPaineisNaoEnchidosDaGrade();
    _preencherMarcasDeIdentificacao();
  }

  // Espelha extraStacks no DOM: cria a coluna do pallet (grade de placas
  // + cabeçalho com dropdown de cor) e a coluna de Medição correspondente
  // pra cada número em extraStacks que ainda não tem elemento na tela, e
  // remove as colunas de pallets extras que não estão mais em
  // extraStacks (ex: depois de _resetStacksParaPadrao). Chamada sempre
  // que extraStacks muda — não precisa ser chamada manualmente em outros
  // lugares além de _resetStacksParaPadrao/_adicionarPalletExtra/
  // _moverPainel(quando cria coluna nova)/_carregarAvaliacaoNoFormulario/
  // applyFormData, que são os únicos pontos que alteram extraStacks.
  function _sincronizarColunasExtras() {
    const stacksWrap = document.querySelector('.sq-stacks');
    const infoWrap    = document.querySelector('.sq-pallet-info-grid');
    if (!stacksWrap || !infoWrap) return;

    // Remove colunas de pallets extras que não existem mais.
    stacksWrap.querySelectorAll('.sq-pallet-col[data-extra="1"]').forEach(col => {
      const n = parseInt(col.dataset.pallet);
      if (!extraStacks.includes(n)) col.remove();
    });
    infoWrap.querySelectorAll('.sq-info-col[data-extra="1"]').forEach(col => {
      const n = parseInt(col.dataset.pallet);
      if (!extraStacks.includes(n)) col.remove();
    });

    // Cria as que faltam.
    extraStacks.forEach(n => {
      if (!document.getElementById(`stack${n}`)) stacksWrap.insertBefore(_criarColunaPallet(n), stacksWrap.querySelector('.sq-pallet-add'));
      if (!document.getElementById(`sq-p${n}-comprimento`)) infoWrap.appendChild(_criarColunaMedicao(n));
    });

    _atualizarBotaoAdicionarPallet();
  }

  // Aplica a posição visual configurada em Configurações → Paletes →
  // "Ordem dos Paletes" (ver LW.PALETES_ORDEM, data.js, e
  // public/js/paletes-ordem.js) aos 4 pallets FIXOS (stack1..stack4) —
  // as colunas já nascem com a ordem default do CSS
  // (.sq-pallet-col[data-pallet-id], setor-qualidade.css); isso só
  // sobrescreve via style inline quando o Administrador salvou uma
  // ordem diferente do default. Pallets extras (ver _criarColunaPallet,
  // abaixo) não entram aqui — eles sempre nascem depois dos 4 fixos,
  // não fazem parte desta configuração.
  //
  // RACE CONDITION corrigida aqui (ver conversa que motivou a mudança —
  // "preciso sair e entrar de novo pra ordem aparecer certa"): esta
  // função é chamada em init(), que roda assim que a página Setor de
  // Qualidade é aberta pela 1ª vez na sessão — SEM esperar loadConfig()
  // (data.js) terminar de buscar config.json (é assíncrono, um fetch de
  // verdade). Se a página abrisse rápido o bastante (ex: F5 que já
  // restaura direto nesta tela), esta função rodava ANTES de
  // LW.PALETES_ORDEM estar pronto, aplicava o default, e como só
  // executa 1x por sessão (ver window._sqInit, app-core.js), a ordem
  // errada ficava presa até a próxima sessão nova (logout+login —
  // começa no Menu, dá tempo do config carregar antes da pessoa clicar
  // em Setor de Qualidade). LW.waitConfig() (data.js) já existia pronto
  // pra isso, só nunca tinha sido usado.
  function _aplicarOrdemPaletes() {
    const aplicar = () => {
      const ordem = (typeof LW !== 'undefined' && LW.PALETES_ORDEM) ? LW.PALETES_ORDEM : { stack1: 2, stack2: 1, stack3: 3, stack4: 4 };
      Object.entries(ordem).forEach(([sid, posicao]) => {
        const col = document.querySelector(`.sq-pallet-col[data-pallet-id="${sid}"]`);
        if (col) col.style.order = String(posicao);
      });
    };
    // typeof LW.waitConfig — defensivo: harnesses de teste isolados (ver
    // test/helpers/setor-qualidade-dom.js) montam um LW mínimo, sem
    // waitConfig. Sem ele disponível, aplica direto (mesmo comportamento
    // de antes desta correção) — só o app de verdade (data.js) tem
    // waitConfig de verdade, e é lá que a corrida importa.
    if (typeof LW !== 'undefined' && typeof LW.waitConfig === 'function') {
      LW.waitConfig(aplicar);
    } else {
      aplicar();
    }
  }

  // Mesma estrutura das 4 colunas de pallet originais (ver
  // page-setor-qualidade.html) — só que montada por código, já que o
  // número de pallets agora é variável. draggable/ondrop ligam essa
  // coluna ao "segurar e arrastar" — ver _moverPainel.
  function _criarColunaPallet(n) {
    const sid = 'stack' + n;
    const col = document.createElement('div');
    col.className = 'sq-pallet-col';
    col.dataset.extra = '1';
    col.dataset.pallet = String(n);
    // Sempre depois dos 4 pallets fixos (order 1-4, ver
    // .sq-pallet-col[data-pallet-id] em setor-qualidade.css) — extras
    // continuam nascendo por último.
    col.style.order = String(100 + n);
    col.innerHTML = `
      <div class="sq-pallet-header">
        <span class="sq-pallet-label">PALLET ${n}</span>
        <div class="sq-pallet-actions">
          <button class="sq-btn-select-all" onclick="SQ.selectAllPallet('${sid}')">⚡ Todas</button>
          <button class="sq-btn-clear-pallet" onclick="SQ.clearPallet('${sid}')" title="Limpar marcações deste pallet"><i class="fas fa-trash-alt"></i></button>
          <button class="sq-btn-remove-pallet" onclick="SQ.removerPalletExtra(${n})" title="Excluir este pallet">✕</button>
        </div>
      </div>
      <div class="sq-slab-stack sq-slab-stack-extra" id="${sid}"></div>`;
    _ativarDropZone(col.querySelector('.sq-slab-stack'), sid);
    return col;
  }

  function _criarColunaMedicao(n) {
    const campos = [['comprimento','Comprimento'],['largura','Largura'],['linearidade','Linearidade'],['espessura','Espessura'],['esquadro','Esquadro']];
    const col = document.createElement('div');
    col.className = 'sq-info-col';
    col.dataset.extra = '1';
    col.dataset.pallet = String(n);
    col.innerHTML = `
      <div class="sq-info-col-header">Pallet ${n}</div>
      ${campos.map(([f, label]) => `
        <div class="sq-info-row">
          <span class="sq-info-key">${label}</span>
          <span class="sq-info-val" id="sq-p${n}-${f}">${defaultPalletInfo(f)}</span>
          <span class="sq-info-edit" data-pallet="${n}" data-field="${f}" onclick="SQ.editField(this)"><i class="fas fa-pen"></i></span>
        </div>`).join('')}`;
    return col;
  }

  // Habilita e desabilita o "+" — desligado no modo visualização
  // (viewMode) e enquanto os campos auto-preenchidos estiverem travados
  // mas sem NENHUMA operação vinculada (ou seja, avaliação avulsa —
  // nesse caso não tem nem placa nenhuma renderizada ainda pra arrastar).
  function _atualizarBotaoAdicionarPallet() {
    const btn = document.getElementById('sq-btn-add-pallet');
    if (!btn) return;
    btn.style.display = viewMode ? 'none' : '';
  }

  // Cria o próximo pallet extra (5º, 6º…) VAZIO — só ganha placas por
  // arrastar (ver _moverPainel). Número sempre o maior atual + 1, mesmo
  // que um do meio tenha sido esvaziado, pra nunca reaproveitar um
  // número já usado nesta avaliação (evita confundir numeração ao
  // corrigir/revisar depois).
  function _adicionarPalletExtra() {
    if (viewMode) return;
    const novo = proximoNumeroPalletExtra++;
    extraStacks.push(novo);
    stackCounts['stack' + novo] = 0;
    _sincronizarColunasExtras();
    renderStacks();
  }

  // Exclui um pallet extra (botão "✕" no cabeçalho, só existe nos extras
  // — ver _criarColunaPallet). Vazio: exclui direto. Com placas dentro:
  // confirma antes, avisando que elas serão descartadas — dá pra desfazer
  // com "Desfazer" logo em seguida, já que isto agora é uma ação
  // snapshotada (ver pushState/undoLastAction), igual mover uma placa.
  function _removerPalletExtra(n) {
    if (viewMode) return;
    const sid = 'stack' + n;
    if (!extraStacks.includes(n)) return;
    const qtd = stackCounts[sid] || 0;

    const excluir = () => {
      pushState();
      extraStacks = extraStacks.filter(x => x !== n);
      delete stackCounts[sid];
      _limparPlacasForaDoEscopo();
      _sincronizarColunasExtras();
      renderStacks();
      validateAllSlabs();
    };

    if (qtd === 0) { excluir(); return; }
    showConfirm(
      'Excluir Pallet',
      `O Pallet ${n} ainda tem ${qtd} placa${qtd > 1 ? 's' : ''} nele. Excluir o pallet descarta ${qtd > 1 ? 'essas placas' : 'essa placa'} — dá pra desfazer com "Desfazer" logo em seguida, se precisar. Continuar?`,
      excluir
    );
  }

  // Liga os eventos de "soltar" numa coluna de pallet (base ou extra) —
  // idempotente (dataset.dropzoneReady evita ligar 2x no mesmo elemento,
  // já que renderStacks/_criarColunaPallet podem chamar de novo pra
  // colunas que já existiam). Serve pra soltar na área "vazia" do pallet
  // (fora de qualquer placa específica — ex: pallet extra ainda vazio) —
  // soltar EM CIMA de uma placa específica é tratado por
  // _ativarDropZonePlaca, que intercepta antes (stopPropagation) e chama
  // _tratarSolturaPlaca no lugar deste handler.
  function _ativarDropZone(el, sid) {
    if (!el || el.dataset.dropzoneReady) return;
    el.dataset.dropzoneReady = '1';
    el.addEventListener('dragover', e => {
      if (viewMode) return;
      e.preventDefault(); // necessário pro navegador permitir o drop aqui
      el.classList.add('sq-slab-stack-dragover');
    });
    el.addEventListener('dragleave', () => el.classList.remove('sq-slab-stack-dragover'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('sq-slab-stack-dragover');
      if (viewMode) return;
      const origemId = e.dataTransfer.getData('text/plain');
      if (origemId) _moverPainel(origemId, sid);
    });
  }

  // Liga os eventos de "soltar" numa placa ESPECÍFICA (não mais na coluna
  // toda) — pra saber exatamente em qual posição a placa foi largada, e
  // então decidir (ver _tratarSolturaPlaca) entre TROCAR de posição (solto
  // dentro do MESMO pallet) ou MOVER pra outro pallet (comportamento de
  // sempre, ver _moverPainel). stopPropagation em dragover/drop é
  // essencial: sem isso o evento "vaza" pro handler da coluna inteira
  // (_ativarDropZone, acima), que trataria como um drop genérico na área
  // do pallet em vez de um drop preciso nesta placa.
  function _ativarDropZonePlaca(el, id) {
    if (!el || el.dataset.dropzonePlacaReady) return;
    el.dataset.dropzonePlacaReady = '1';
    el.addEventListener('dragover', e => {
      if (viewMode) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('sq-slab-dragover');
    });
    el.addEventListener('dragleave', () => el.classList.remove('sq-slab-dragover'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('sq-slab-dragover');
      if (viewMode) return;
      const origemId = e.dataTransfer.getData('text/plain');
      if (origemId) _tratarSolturaPlaca(origemId, id);
    });
  }

  // Decide o que fazer quando uma placa é solta EM CIMA de outra placa
  // específica (destId): mesmo pallet → troca de posição (_trocarPlacas,
  // pedido do usuário: "se eu colocar o painel 01 na posição 7, o 1 fica
  // no lugar do 7 e o 7 vai pro lugar do 1"); pallet diferente → mesmo
  // comportamento de sempre (_moverPainel — vai pro FIM do pallet de
  // destino, renumerando a origem), ignorando a posição exata onde foi
  // largada dentro do pallet de destino.
  function _tratarSolturaPlaca(origemId, destId) {
    if (viewMode || !origemId || origemId === destId) return;
    const origStack = origemId.split('-')[0];
    const destStack = destId.split('-')[0];
    if (origStack === destStack) _trocarPlacas(origemId, destId);
    else _moverPainel(origemId, destStack);
  }

  // Troca o CONTEÚDO de 2 posições do MESMO pallet entre si (marcas,
  // motivo, e o tipo fixado em slabConfig, se houver) — a placa 1 vira a
  // 7 e vice-versa, sem renumerar nada (diferente de _moverPainel, que é
  // entre pallets DIFERENTES e por isso precisa fechar buraco). Não muda
  // o tipo esperado exibido em nenhuma das 2 posições quando são do mesmo
  // pallet base (mesmo palletTypes[idx] pras duas) — só importa mesmo
  // quando uma delas tem um tipo fixado via slabConfig (ex: veio de outro
  // pallet antes), que também precisa trocar de lugar junto.
  function _trocarPlacas(idA, idB) {
    if (viewMode || idA === idB) return;
    pushState();
    [slabState, slabMotivo, slabMotivoDescricao, slabConfig].forEach(dict => {
      const a = dict[idA], b = dict[idB];
      if (b !== undefined) dict[idA] = b; else delete dict[idA];
      if (a !== undefined) dict[idB] = a; else delete dict[idB];
    });
    renderStacks();
    validateAllSlabs();
  }

  // Move uma placa de um pallet pra outro (segurar-e-arrastar, ver
  // renderStacks/_ativarDropZone) — pedido do usuário: (1) o pallet de
  // origem RENUMERA pra fechar o buraco deixado; (2) o tipo esperado
  // (SP/2P/3T) viaja COM a placa, não fica preso ao pallet de destino
  // (por isso captura tipoFixado ANTES de mexer em qualquer coisa, e
  // grava em slabConfig[novoId] — o mesmo mecanismo que "Personalizada"
  // já usa pra tipo por placa, ver getExpectedType); (3) pallets extras
  // aceitam qualquer nº de placas, sem limite.
  function _moverPainel(origemId, destStackId) {
    if (viewMode) return;
    const partes = origemId.split('-');
    const origStack = partes[0];
    const origPos    = parseInt(partes[1]);
    if (!origStack || !origPos || origStack === destStackId) return; // solto no próprio pallet — nada a fazer
    if (!_stackIds().includes(origStack) || !_stackIds().includes(destStackId)) return;

    pushState(); // vira uma ação desfazível, igual marcar/desmarcar uma placa

    const tipoFixado = getExpectedType(origemId);
    const registro = {
      marks:           slabState[origemId] ? [...slabState[origemId]] : null,
      motivo:          slabMotivo[origemId] || null,
      motivoDescricao: slabMotivoDescricao[origemId] || null,
    };

    // ── Remove da origem, deslocando quem ficou pra trás uma posição
    //    pra frente (fecha o buraco) ──────────────────────────────────
    const nOrigem = stackCounts[origStack] || 0;
    for (let i = origPos; i < nOrigem; i++) {
      const de = `${origStack}-${i + 1}`, para = `${origStack}-${i}`;
      if (slabState[de] !== undefined)  slabState[para]  = slabState[de];  else delete slabState[para];
      if (slabMotivo[de] !== undefined) slabMotivo[para] = slabMotivo[de]; else delete slabMotivo[para];
      if (slabMotivoDescricao[de] !== undefined) slabMotivoDescricao[para] = slabMotivoDescricao[de]; else delete slabMotivoDescricao[para];
      if (slabConfig[de] !== undefined) slabConfig[para] = slabConfig[de]; else delete slabConfig[para];
    }
    delete slabState[`${origStack}-${nOrigem}`];
    delete slabMotivo[`${origStack}-${nOrigem}`];
    delete slabMotivoDescricao[`${origStack}-${nOrigem}`];
    delete slabConfig[`${origStack}-${nOrigem}`];
    stackCounts[origStack] = nOrigem - 1;

    // ── Adiciona no fim do destino ───────────────────────────────────
    const novaPos = (stackCounts[destStackId] || 0) + 1;
    stackCounts[destStackId] = novaPos;
    const novoId = `${destStackId}-${novaPos}`;
    if (registro.marks)           slabState[novoId]  = registro.marks;
    if (registro.motivo)          slabMotivo[novoId] = registro.motivo;
    if (registro.motivoDescricao) slabMotivoDescricao[novoId] = registro.motivoDescricao;
    if (tipoFixado)                slabConfig[novoId] = tipoFixado;

    renderStacks();
    validateAllSlabs();
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
    _resetStacksParaPadrao();
    renderStacks();
    validateAllSlabs();
  }

  /* ── Validação de consistência ────────────────────────── */
  // Todas as placas do formulário atual (todo pallet ativo — base ou
  // extra, ver _stackIds/stackCounts) que ainda NÃO têm nenhuma marca DE
  // VERDADE (do operador) em slabState — nem uma marca real (círculo/
  // traço) nem o X de "painel não preenchido". Usada só na hora de
  // registrar (ver registerEvaluation) pra impedir de fato o registro
  // enquanto sobrar alguma — substitui o antigo checkbox de confirmação
  // manual ("confirmo que avaliei todos os painéis"), que dependia da
  // pessoa lembrar de marcar e não impedia nada por si só.
  //
  // CORRIGIDO (ver _somenteMarcasAuto/classifyMarks, mais acima): uma
  // placa com SÓ as marcas de identidade automáticas (auto:true — nasceram
  // sozinhas ao escolher o Tipo de Montagem, ver
  // _preencherMarcasDeIdentificacao) e nenhuma marca do operador ainda NÃO
  // conta como avaliada — `slabState[id].length` sozinho não distinguia
  // isso (auto conta como marca pra esse length), deixando passar pro
  // registro placas que o operador nunca chegou a olhar de verdade.
  function _paineisNaoMarcados() {
    const faltando = [];
    _stackIds().forEach(sid => {
      const n = stackCounts[sid] || 0;
      for (let i = 1; i <= n; i++) {
        const id = `${sid}-${i}`;
        const marcas = slabState[id];
        if (!marcas || !marcas.length || _somenteMarcasAuto(marcas)) faltando.push(id);
      }
    });
    return faltando;
  }

  function validateAllSlabs() {
    document.querySelectorAll('.sq-slab.invalid').forEach(el => el.classList.remove('invalid'));
    let hasError = false, msgs = [];
    _stackIds().forEach(sid => {
      const stack = document.getElementById(sid);
      if (!stack) return;
      stack.querySelectorAll('.sq-slab').forEach(slab => {
        const id  = slab.dataset.id;
        const exp = getExpectedType(id);
        if (!exp) return;
        const cls = classifyMarks(slabState[id] || []);
        if (cls === 'Sem marcação' || cls === 'Não preenchido') return;
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
    _sincronizarColunasExtras(); // garante que as colunas dos pallets extras existem no DOM antes de preenchê-las
    _atualizarSubtitulosPallets(); // faixa de berços de cada palete-base (ver função) — nunca muda a marcação em si, só o rótulo
    _stackIds().forEach((sid) => {
      const stack = document.getElementById(sid);
      if (!stack) return;
      _ativarDropZone(stack, sid); // liga o "soltar" — idempotente, ver função
      stack.innerHTML = '';
      const total = stackCounts[sid] || 0;
      const palleteBase = parseInt(sid.replace('stack', '')); // 1-4 nos originais; extras (5+) nunca têm berço de origem
      for (let i = 1; i <= total; i++) {
        const slab = document.createElement('div');
        slab.className = 'sq-slab';
        const id = `${sid}-${i}`;
        slab.dataset.id = id;

        const num = document.createElement('span');
        num.className = 'sq-slab-number';
        // Mostra o berço de ORIGEM (ver _bercoDoSlot) em vez de um índice
        // solto 1..N, sempre que a capacidade da operação for conhecida
        // — cai de volta pro índice simples de sempre quando não for
        // (avaliação avulsa legada, palete extra, ou rascunho reaberto
        // sem a operação recarregada — ver capacidadeOperacaoAtual).
        const berco = palleteBase <= 4 ? _bercoDoSlot(palleteBase, i, capacidadeOperacaoAtual, paineisNaoEnchidosAtual) : null;
        num.textContent = berco ? ('B' + berco) : i;
        slab.appendChild(num);

        const tp = document.createElement('span');
        tp.className = 'sq-slab-type';
        const exp = getExpectedType(id);
        if (exp) {
          tp.textContent = exp;
          const classMap = { SP:'sp','2P':'p2','3T':'t3','1T':'t1' };
          if (classMap[exp]) tp.classList.add(classMap[exp]);
        }

        const mc = document.createElement('div');
        mc.className = 'sq-slab-marks';
        slab.appendChild(mc);

        // Badge do código de motivo (ex: "BC") — DENTRO do desenho da
        // placa, AO LADO da identificação de tipo (nunca sobreposto),
        // mesma ideia visual do Espelho Visual (ver
        // .sq-mini-slab-motivo/renderMirror, que também mostra o código
        // logo antes do tipo, na mesma linha) — só aparece quando a
        // placa tem um motivo salvo/pendente (ver _renderBadgeMotivo).
        // Clique reabre o seletor pra trocar, SEM alternar a marca
        // (stopPropagation — o clique na placa em si continua
        // marcando/desmarcando normalmente).
        const mo = document.createElement('span');
        mo.className = 'sq-slab-motivo';
        mo.title = 'Clique para editar o motivo';
        mo.addEventListener('click', (e) => {
          e.stopPropagation();
          if (viewMode) return;
          if ((slabState[id] || []).some(_marcaExigeMotivo)) _abrirSeletorMotivo(id);
        });

        // Motivo + tipo agrupados num único canto (inferior direito),
        // lado a lado — mesma ordem visual do Espelho (motivo antes do
        // tipo). Nem "mo" nem "tp" têm posição própria (ver
        // .sq-slab-canto-info, setor-qualidade.css); é o WRAPPER quem
        // fica absolute no canto — assim o tipo nunca fica embaixo do
        // motivo, os dois simplesmente ocupam espaços diferentes lado a
        // lado, com o motivo empurrando o tipo pra esquerda quando
        // aparece (em vez de cobrir/sobrepor).
        const canto = document.createElement('span');
        canto.className = 'sq-slab-canto-info';
        canto.appendChild(mo);
        canto.appendChild(tp);
        slab.appendChild(canto);

        if (slabState[id]) renderMarks(slab, slabState[id]);
        slab.addEventListener('click', () => toggleMark(slab));
        _ligarGestoApagar(slab);

        // Segurar-e-arrastar pra mover a placa de pallet (ver
        // _ativarDropZone/_moverPainel) — desligado em modo visualização.
        slab.draggable = !viewMode;
        slab.addEventListener('dragstart', (e) => {
          if (viewMode) { e.preventDefault(); return; }
          e.dataTransfer.setData('text/plain', id);
          e.dataTransfer.effectAllowed = 'move';
          slab.classList.add('sq-slab-dragging');
        });
        slab.addEventListener('dragend', () => slab.classList.remove('sq-slab-dragging'));
        _ativarDropZonePlaca(slab, id); // solto EM CIMA desta placa — troca de posição (mesmo pallet) ou move (pallet diferente), ver _tratarSolturaPlaca

        stack.appendChild(slab);
        // SÓ AGORA (depois de slab/mo estarem de fato no documento) —
        // _renderBadgeMotivo procura o slab por querySelector no
        // document inteiro; chamado antes disso, com o slab ainda
        // "solto" (não anexado), não encontrava nada e saía sem aplicar
        // o display inicial (bug: badge ficava sem display definido).
        _renderBadgeMotivo(id);
      }
    });
    validateAllSlabs();
  }

  // Mostra/esconde o badge do código de motivo (ex: "BC") na placa —
  // "?" quando a placa tem marca que exige motivo mas ainda não foi
  // escolhido (chama atenção pra terminar); o código quando já escolhido;
  // escondido quando não se aplica. Chamada sempre que o motivo muda
  // (seletor, desmarcação) e ao (re)renderizar a placa do zero
  // (renderStacks, acima).
  function _renderBadgeMotivo(id) {
    const slab = document.querySelector(`.sq-slab[data-id="${id}"]`);
    // O badge é FILHO do slab (dentro de .sq-slab, ver renderStacks) —
    // fica DENTRO do desenho da placa, mesma ideia visual do Espelho
    // Visual (antes era irmão, num wrapper .sq-slab-linha, ao lado da
    // placa — pedido do usuário pra ficar dentro, como no espelho).
    const badge = slab?.querySelector('.sq-slab-motivo');
    if (!badge) return;
    const marcaQueExigeMotivo = (slabState[id] || []).find(_marcaExigeMotivo);
    const exigeMotivo = !!marcaQueExigeMotivo;
    const codigo = slabMotivo[id];
    // 2ª linha (azul, marca aprovada mesmo exigindo motivo — ver
    // _corExigeMotivo) tem fundo/cor de texto PRÓPRIOS, diferentes do
    // vermelho/branco padrão de reprovado — ver .sq-slab-motivo-2linha,
    // setor-qualidade.css. "?" pendente continua na cor de alerta de
    // sempre (--accent) independente disso, ver
    // .sq-slab-motivo-pendente, que tem prioridade no CSS.
    badge.classList.toggle('sq-slab-motivo-2linha', marcaQueExigeMotivo?.color === 'azul');
    badge.classList.toggle('sq-slab-motivo-pendente', exigeMotivo && !codigo);
    if (codigo) {
      badge.textContent = codigo;
      badge.title = codigo === 'OT'
        ? (slabMotivoDescricao[id] || 'Outros (sem descrição)') + ' (clique para editar)'
        : `${codigo} — ${_MOTIVO_POR_CODIGO[codigo] || ''} (clique para editar)`;
      badge.style.display = 'flex';
    } else if (exigeMotivo) {
      badge.textContent = '?';
      badge.title = 'Motivo do defeito pendente — clique para escolher';
      badge.style.display = 'flex';
    } else {
      badge.textContent = '';
      badge.style.display = 'none';
    }
  }

  function renderMarks(slabEl, marks) {
    const c = slabEl.querySelector('.sq-slab-marks');
    c.innerHTML = '';
    const root = getComputedStyle(document.documentElement);
    marks.forEach(m => {
      const el = document.createElement('span');
      if (m.shape === 'x') {
        // Sempre cinza fixo — nunca lê m.color (ver COR_NAO_PREENCHIDO):
        // diferente das outras formas, aqui a cor nunca varia.
        el.className = 'sq-mark-x';
        el.textContent = '×';
        c.appendChild(el);
        return;
      }
      el.className = m.shape === 'dash' ? 'sq-mark-dash' : 'sq-mark-circle';
      const varMap = { verde:'--sq-cor-verde', vermelho:'--sq-cor-vermelho', azul:'--sq-cor-azul', amarelo:'--sq-cor-amarelo', laranja:'--sq-cor-laranja', cinza:'--sq-cor-identificacao-auto' };
      el.style.backgroundColor = root.getPropertyValue(varMap[m.color] || '--sq-cor-verde').trim();
      c.appendChild(el);
    });
  }

  // Clique normal na placa — SEMPRE adiciona uma marca com a cor+forma
  // selecionada (modelo novo, ver conversa que motivou a mudança: antes,
  // clicar de novo na MESMA combinação apagava — isso impedia repetir a
  // mesma combinação na mesma placa, então separamos "adicionar" (aqui) de
  // "apagar" (toggleMarkErase, abaixo) em dois gestos diferentes). A
  // paleta continua completa (5 cores + 3 formas) — o operador escolhe
  // cor E forma manualmente, como sempre foi; a identificação automática
  // (ver _marcasDeIdentificacao) só faz o trabalho de PRÉ-preencher pra
  // adiantar, nunca tira a possibilidade de marcar/apagar manualmente
  // qualquer combinação.
  function toggleMark(el) {
    if (viewMode) return;
    const id = el.dataset.id;
    // Borracha selecionada — clique normal limpa a placa inteira, em vez
    // de adicionar marca (ver conversa que motivou: substitui o gesto de
    // toque longo no celular por uma ferramenta selecionável, igual
    // cor/forma já são — mesmo clique de sempre, só muda o que ele faz).
    if (selectedShape === 'eraser') { _limparPainel(id, el); return; }
    if (!slabState[id]) slabState[id] = [];
    const shape = selectedShape;
    // X nunca usa a cor escolhida na paleta — é sempre cinza fixo
    // (COR_NAO_PREENCHIDO), ver comentário na constante.
    const color = shape === 'x' ? COR_NAO_PREENCHIDO : selectedColor;

    // X é sempre sozinho: marcar X substitui qualquer marca real que já
    // existisse na placa (não conta pro limite de repetições — só faz
    // sentido existir 1 X por placa mesmo). Marcar uma marca REAL quando
    // já existia um X, remove o X (não faz sentido as duas coexistirem).
    if (shape === 'x') {
      pushState();
      slabState[id] = [{ color, shape }];
      renderMarks(el, slabState[id]);
      validateAllSlabs();
      _renderBadgeMotivo(id);
      return;
    }

    const jaTinhaX = slabState[id].some(m => m.shape === 'x');
    if (!jaTinhaX && slabState[id].length >= MAX_MARCAS_POR_PLACA) {
      toast(`Limite de ${MAX_MARCAS_POR_PLACA} marcas por placa atingido.`, 'error');
      return;
    }

    pushState();
    if (jaTinhaX) slabState[id] = []; // marca real substitui o X que estava lá

    // CADA MARCA JÁ NASCE COM O PAPEL DELA (`role`) — ver toggleIndicadorAtivo/
    // botão "I": 'indicador' (padrão, "I" ativado) é a marca de STATUS de
    // verdade; 'identidade' (com "I" desativado) é uma marca manual de
    // tipo/identidade, que nunca conta como avaliação pra motivo/1ª-2ª
    // linha. Isso substitui a lógica antiga de reconstruir por eliminação
    // quem era quem (ver classifyMarks/_combinarComMarcas, mais abaixo).
    const role = indicadorAtivo ? 'indicador' : 'identidade';
    const novaMarca = { color, shape, role };

    if (role === 'indicador') {
      // Onde a marca do operador entra (em qual posição, entre as marcas
      // de identidade automáticas) depende de `indicadorIndex` da
      // combinação do tipo esperado desta placa (ver Configurações →
      // Paletes → "Combinações de Avaliação", paletes-combinacoes.js) —
      // só efeito VISUAL (ordem no DOM bate com a ordem configurada);
      // classifyMarks não depende mais de posição, só de `role`. Só
      // relevante pra combinações com mais de 1 marca (marca única não
      // tem "posição", é a mesma marca que já identifica tipo E status ao
      // mesmo tempo). As marcas de identidade automáticas preservam a
      // ORDEM RELATIVA de combo.marcas (ver _marcasDeIdentificacao) — como
      // só o índice do indicador foi removido delas, o índice
      // `indicadorIndex` do combo já é exatamente a posição certa pra
      // inserir a marca do operador de volta nesse "buraco" (splice).
      const tipoEsperado = String((typeof getExpectedType === 'function' ? getExpectedType(id) : '') || '').toLowerCase();
      const comboAtual = tipoEsperado ? _combinacoesEfetivas().find(c => c.tipo === tipoEsperado) : null;
      const posicaoInsercao = (comboAtual && comboAtual.marcas && comboAtual.marcas.length > 1)
        ? Math.min(comboAtual.indicadorIndex, slabState[id].length)
        : 0;
      slabState[id].splice(posicaoInsercao, 0, novaMarca);
    } else {
      // Marca manual de identidade (gesto raro, "I" desativado de
      // propósito) — não tem "slot" fixo pra ocupar, só empilha.
      slabState[id].push(novaMarca);
    }

    renderMarks(el, slabState[id]);
    validateAllSlabs();
    _renderBadgeMotivo(id); // mostra o "?" pendente na hora, antes mesmo do popover abrir
    // Motivo obrigatório só quando é a marca de STATUS (indicador) —
    // marca de identidade nunca exige, mesmo se a cor escolhida "por
    // acaso" for azul/vermelho (ver _corExigeMotivo).
    if (_marcaExigeMotivo({ role, color })) _abrirSeletorMotivo(id);
  }

  // Borracha (ver toggleMark) — apaga TODAS as marcas de uma placa de
  // uma vez, diferente de toggleMarkErase (abaixo, clique direito no
  // computador) que remove só UMA marca da cor/forma selecionada. Também
  // limpa o motivo salvo, se houver (_atualizarMotivoAposDesmarcar já
  // decide isso). Não faz nada (nem entra no histórico de Desfazer) numa
  // placa que já está vazia.
  function _limparPainel(id, el) {
    if (!slabState[id] || !slabState[id].length) {
      toast('Essa placa já está vazia.', 'error');
      return;
    }
    pushState();
    slabState[id] = [];
    renderMarks(el, slabState[id]);
    validateAllSlabs();
    _atualizarMotivoAposDesmarcar(id);
  }

  // Apagar — clique direito (mouse) numa placa. Com a Borracha
  // selecionada (ver toggleMark/_limparPainel), tem o mesmo efeito do
  // clique normal: limpa a placa inteira. Com qualquer outra ferramenta
  // selecionada, remove UMA ocorrência da cor+forma ATUALMENTE
  // SELECIONADA na paleta (mesmo seletor de sempre — só muda o que o
  // gesto faz com ele). Como marcas idênticas são visualmente
  // indistinguíveis entre si, remove sempre a primeira que encontrar —
  // não importa qual das repetidas some, o resultado visual é o mesmo.
  // Apaga também marcas de IDENTIFICAÇÃO automáticas (auto: true) — a
  // paleta continua completa de propósito (ver conversa que motivou:
  // manter cor+forma manuais) exatamente pra permitir reconstruir a
  // combinação certa (ex: amarelo+traço) e apagar uma identificação
  // automática, se precisar. Ver _ligarGestoApagar, que liga isso no
  // elemento da placa (contextmenu).
  function toggleMarkErase(el) {
    if (viewMode) return;
    const id = el.dataset.id;
    if (selectedShape === 'eraser') { _limparPainel(id, el); return; }
    const shape = selectedShape;
    const color = shape === 'x' ? COR_NAO_PREENCHIDO : selectedColor;
    const marcas = slabState[id] || [];
    const idx = marcas.findIndex(m => m.color === color && m.shape === shape);
    if (idx === -1) {
      toast('Essa placa não tem uma marca dessa cor/forma pra apagar.', 'error');
      return;
    }
    pushState();
    marcas.splice(idx, 1);
    renderMarks(el, marcas);
    validateAllSlabs();
    _atualizarMotivoAposDesmarcar(id);
  }

  // Liga o gesto de apagar (clique direito) num elemento de placa —
  // chamada 1x por placa, na criação (ver renderStacks). Usa o evento
  // nativo 'contextmenu', suprime o menu de contexto do navegador.
  //
  // O gesto de toque longo (celular) que existia aqui foi removido — ver
  // conversa que motivou a mudança: a Borracha (ferramenta selecionável,
  // igual cor/forma) cobre o mesmo caso de uso, com clique/toque normal,
  // sem precisar segurar o dedo parado nem torcer pra não disparar um
  // scroll sem querer no meio do caminho.
  function _ligarGestoApagar(el) {
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      toggleMarkErase(el);
    });
  }

  // Desmarcar uma cor azul/vermelho pode deixar o painel sem NENHUMA marca
  // que ainda exija motivo (ex: era só um círculo vermelho, foi removido)
  // — nesse caso o motivo salvo não faz mais sentido e é limpo junto. Se
  // ainda sobrar outra marca azul/vermelho (raro, mas possível numa
  // combinação círculo+traço onde as duas contam status — não é o caso
  // hoje, mas não custa checar), mantém o motivo como estava.
  function _atualizarMotivoAposDesmarcar(id) {
    const aindaExigeMotivo = (slabState[id] || []).some(_marcaExigeMotivo);
    if (!aindaExigeMotivo) { delete slabMotivo[id]; delete slabMotivoDescricao[id]; }
    _renderBadgeMotivo(id);
  }

  // Seletor de motivo — popover flutuante com os 14 códigos (ver
  // MOTIVOS_DEFEITO). 2 modos, conforme os argumentos:
  //   - _abrirSeletorMotivo(id) — 1 placa só (clique direto na placa ou no
  //     badge "?"/código dela). Ancorado na placa.
  //   - _abrirSeletorMotivo(null, stackId) — pallet inteiro (depois de
  //     "Marcar Tudo"/cor no cabeçalho do pallet, ver applyMarksToPallet).
  //     Aplica o motivo escolhido em TODA placa do pallet que estiver
  //     exigindo motivo agora. Ancorado no cabeçalho do pallet.
  // OBRIGATÓRIO — de propósito, a pedido: sem "✕", sem clicar fora pra
  // fechar, e com um overlay escurecendo/bloqueando o resto da tela por
  // baixo (ver .sq-motivo-modal-overlay, CSS). A ÚNICA saída é escolher um
  // código (ou, no caso de "Outros", digitar uma descrição — cancelar ou
  // deixar em branco REABRE este mesmo seletor, não descarta). Antes disso
  // fechava sem escolher, deixando o badge "?" pendente pra resolver depois
  // — mudou de propósito: já não dá mais pra adiar.
  function _abrirSeletorMotivo(id, stackId) {
    document.querySelectorAll('.sq-motivo-popover, .sq-motivo-modal-overlay').forEach(el => el.remove());

    const ancora = id
      ? document.querySelector(`.sq-slab[data-id="${id}"]`)
      : document.querySelector(`#${stackId} .sq-pallet-header`) || document.getElementById(stackId);
    if (!ancora) return;

    const overlay = document.createElement('div');
    overlay.className = 'sq-motivo-modal-overlay';
    document.body.appendChild(overlay);

    const pop = document.createElement('div');
    pop.className = 'sq-motivo-popover';
    pop.innerHTML = `
      <div class="sq-motivo-popover-titulo">
        ${id ? 'Motivo do defeito' : 'Motivo do defeito — pallet inteiro'}
      </div>
      <div class="sq-motivo-popover-obrigatorio">Escolha um motivo pra continuar.</div>
      <div class="sq-motivo-popover-grid">
        ${MOTIVOS_DEFEITO.map(m => `
          <button type="button" class="sq-motivo-popover-item" data-codigo="${m.codigo}" title="${_escaparHtml(m.nome)}">
            <strong>${m.codigo}</strong><span>${_escaparHtml(m.nome)}</span>
          </button>`).join('')}
      </div>`;
    document.body.appendChild(pop);

    const rect = ancora.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - popRect.width - 8;
    if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 6;
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = Math.max(8, top) + 'px';

    function fechar() {
      pop.remove();
      overlay.remove();
    }
    // Aplica o motivo escolhido — na PLACA (id) ou em todo o PALLET
    // (stackId, quando id é null), sempre nas placas que ainda estiverem
    // exigindo motivo agora (mesmo critério dos 2 modos, ver comentário
    // da função). Único ponto que de fato grava slabMotivo/slabMotivoDescricao,
    // usado tanto pro clique direto num código quanto pelo fluxo de "OT"
    // (que só chama isto DEPOIS do showPrompt confirmado).
    function aplicar(codigo, descricao) {
      if (id) {
        slabMotivo[id] = codigo;
        if (codigo === 'OT') slabMotivoDescricao[id] = descricao; else delete slabMotivoDescricao[id];
        _renderBadgeMotivo(id);
      } else {
        document.getElementById(stackId).querySelectorAll('.sq-slab').forEach(slab => {
          const sid = slab.dataset.id;
          if ((slabState[sid] || []).some(_marcaExigeMotivo)) {
            slabMotivo[sid] = codigo;
            if (codigo === 'OT') slabMotivoDescricao[sid] = descricao; else delete slabMotivoDescricao[sid];
            _renderBadgeMotivo(sid);
          }
        });
      }
    }
    pop.querySelectorAll('.sq-motivo-popover-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const codigo = btn.dataset.codigo;
        if (codigo === 'OT') {
          // Descrição livre — fecha o popover de códigos e abre o prompt
          // de texto (showPrompt, mesmo modal de sempre). Cancelar ou
          // deixar em branco REABRE o seletor de códigos (não descarta —
          // ver comentário no topo da função: escolher é obrigatório).
          const descricaoAtual = id ? (slabMotivoDescricao[id] || '') : '';
          fechar();
          showPrompt('Descreva o motivo', 'Descrição curta do defeito — aparece no hover do código "OT".', descricaoAtual, (texto) => {
            if (texto && texto.trim()) aplicar('OT', texto.trim());
            else _abrirSeletorMotivo(id, stackId);
          });
          return;
        }
        aplicar(codigo, null);
        fechar();
      });
    });
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
    // X nunca usa cor (é sempre cinza fixo, ver COR_NAO_PREENCHIDO) e
    // Borracha não grava marca nenhuma — nos dois casos a paleta de cor
    // não tem efeito, então desabilita visualmente pra não sugerir que
    // a cor escolhida ali vai valer. Some outra forma é escolhida de
    // novo, a paleta volta a funcionar normalmente.
    document.querySelectorAll('.sq-btn-color').forEach(b => b.classList.toggle('sq-btn-color-disabled', shape === 'x' || shape === 'eraser'));
  }

  // Liga/desliga o botão "I" — decide o PAPEL (`role`) da próxima marca
  // que o operador clicar na placa: 'indicador' (ativado, padrão) é a
  // marca de STATUS de verdade, a que carrega a cor de aprovado/2ª
  // linha/reprovado e por isso é a única que exige motivo de defeito
  // (ver toggleMark, _corExigeMotivo); 'identidade' (desativado) é uma
  // marca manual de identidade/tipo — não conta como avaliação de
  // status pra nada (nem motivo, nem 1ª/2ª linha). Simples toggle: sem
  // "modo armado esperando 1 clique" como o "i" de Configurações →
  // Paletes (pcaAtivarModoIndicador) — aqui fica ligado/desligado até a
  // pessoa clicar de novo, porque normalmente o operador faz várias
  // marcas de status seguidas (uma placa por vez), não 1 marca isolada.
  function toggleIndicadorAtivo(btn) {
    if (viewMode) return;
    indicadorAtivo = !indicadorAtivo;
    const alvo = btn ? [btn] : Array.from(document.querySelectorAll('.sq-btn-indicador'));
    alvo.forEach(b => b.classList.toggle('active', indicadorAtivo));
  }

  // ── Atalhos de teclado: nº = cor, Ctrl+nº = forma ───────────────────
  // Numeração segue a ORDEM que os botões aparecem na tela (mesma ordem
  // do DOM — ver querySelectorAll abaixo), não uma lista fixa aqui: hoje
  // são 5 cores e 2 formas, mas adicionar uma 6ª cor ou uma 3ª forma no
  // HTML (public/partials/page-setor-qualidade.html) já funciona
  // sozinho, sem tocar neste código — a tecla "6" ou "Ctrl+3" simplesmente
  // passam a existir. Os badges numerados nos próprios botões (ver CSS,
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

  /* ── Ações em lote (pallet inteiro) ──────────────────── */
  function applyMarksToPallet(stackId, color, shape) {
    if (viewMode) return;
    pushState();
    // Mesma regra de toggleMark: X nunca usa a cor recebida (sempre
    // cinza fixo) e é sempre sozinho na placa.
    const corFinal = shape === 'x' ? COR_NAO_PREENCHIDO : color;
    // Mesmo papel (`role`) do botão "I" vale pra marcação em lote — ver
    // toggleMark/toggleIndicadorAtivo.
    const role = indicadorAtivo ? 'indicador' : 'identidade';
    document.getElementById(stackId).querySelectorAll('.sq-slab').forEach(slab => {
      const id = slab.dataset.id;
      if (!slabState[id]) slabState[id] = [];
      if (shape === 'x') {
        slabState[id] = [{ color: corFinal, shape: 'x' }];
      } else {
        slabState[id] = slabState[id].filter(m => m.shape !== 'x');
        // Mesmo raciocínio de toggleMark: a marca de validação entra na
        // posição do indicador da combinação do tipo esperado desta
        // placa — ver Configurações → Paletes → "Combinações de
        // Avaliação".
        if (!slabState[id].find(m => m.color === corFinal && m.shape === shape && m.role === role)) {
          if (role === 'indicador') {
            const tipoEsperado = String((typeof getExpectedType === 'function' ? getExpectedType(id) : '') || '').toLowerCase();
            const comboAtual = tipoEsperado ? _combinacoesEfetivas().find(c => c.tipo === tipoEsperado) : null;
            const posicaoInsercao = (comboAtual && comboAtual.marcas && comboAtual.marcas.length > 1)
              ? Math.min(comboAtual.indicadorIndex, slabState[id].length)
              : 0;
            slabState[id].splice(posicaoInsercao, 0, { color: corFinal, shape, role });
          } else {
            slabState[id].push({ color: corFinal, shape, role });
          }
        }
      }
      renderMarks(slab, slabState[id]);
      _renderBadgeMotivo(id);
    });
    validateAllSlabs();
    // 1 seletor só pro pallet inteiro (não 1 por placa) — quem marca em
    // lote normalmente está registrando o MESMO defeito pra todas
    // (ex: "esse pallet inteiro veio com falha de traço"). Aplica o
    // motivo escolhido em toda placa do pallet que ficou exigindo motivo
    // (sobrescreve qualquer motivo individual anterior — é uma ação em
    // lote deliberada). Só quando a marca em lote é de STATUS (indicador).
    if (_marcaExigeMotivo({ role, color: corFinal })) _abrirSeletorMotivo(null, stackId);
  }
  function selectAllPallet(sid) { applyMarksToPallet(sid, selectedColor, selectedShape); }

  // Botão "🧹 Limpar" no cabeçalho do pallet — substituiu o dropdown de
  // cores por pallet (🎨), que era redundante: a mesma cor já pode ser
  // aplicada em massa via "⚡ Todas" (escolhendo a cor na paleta principal
  // primeiro). Limpa SÓ as placas deste pallet — marcas e motivo — com a
  // mesma confirmação de "Limpar" geral (clearAllMarks), só que com
  // escopo menor.
  function clearPallet(sid) {
    if (viewMode) return;
    const col = document.getElementById(sid);
    if (!col) return;
    showConfirm('Limpar Pallet', `Apagar todas as marcações do ${sid.replace('stack', 'Pallet ')}?`, () => {
      pushState();
      col.querySelectorAll('.sq-slab').forEach(slab => {
        const id = slab.dataset.id;
        delete slabState[id];
        delete slabMotivo[id];
        delete slabMotivoDescricao[id];
        renderMarks(slab, []);
      });
      document.querySelectorAll(`#${sid} .sq-slab-motivo`).forEach(b => { b.textContent = ''; b.style.display = 'none'; });
      validateAllSlabs();
    });
  }

  // toggle/fechar-ao-clicar-fora usado por outros elementos flutuantes
  // desta tela. Só 1 aberto por vez (closeAllCollapsibles fecha o outro
  // antes de abrir o clicado).
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
    if (!wasActive) {
      el.classList.add('active');
      // O popover de Referência mostra "Tipos sem marcação definida",
      // calculado a partir de config.json (tipos_montagem.opcoes, campo
      // combinacaoAvaliacao) — SEM isto, quem cadastra um tipo novo em
      // Configurações enquanto esta página já está aberta (ou só sem dar
      // F5) não via o tipo novo aparecer aqui: o cache
      // (_montagemOpcoesCache) só era atualizado 1 vez, no carregamento
      // inicial da página. Recarregar toda vez que este popover específico abre é barato (só acontece
      // no clique da pessoa) e garante que a lista sempre reflete o
      // config.json mais recente.
      if (id === 'popover-sq-referencia') _carregarOpcoesMontagem();
    }
  }
  document.addEventListener('click', e => {
    if (!e.target.closest('.ao-popover') && !e.target.closest('.btn-sm')) {
      document.querySelectorAll('.ao-popover').forEach(p => p.classList.remove('active'));
    }
  });

  /* ── Histórico de ações (desfazer) ───────────────────── */
  function pushState() {
    // slabMotivo snapshotado JUNTO — desfazer uma marcação precisa
    // desfazer o motivo associado também, senão um "?"/código ficava
    // "grudado" numa placa que o undo já tinha desmarcado. stackCounts/
    // extraStacks/slabConfig entraram junto quando "arrastar placa pra
    // outro pallet" (ver _moverPainel) virou uma ação desfazível — sem
    // isso, desfazer um arraste voltava as marcas de lugar mas deixava o
    // pallet extra (ou a contagem renumerada) como estava DEPOIS do
    // arraste.
    actionHistory.push({
      slabState:  JSON.parse(JSON.stringify(slabState)),
      slabMotivo: JSON.parse(JSON.stringify(slabMotivo)),
      slabMotivoDescricao: JSON.parse(JSON.stringify(slabMotivoDescricao)),
      slabConfig: JSON.parse(JSON.stringify(slabConfig)),
      stackCounts: JSON.parse(JSON.stringify(stackCounts)),
      extraStacks: [...extraStacks],
      proximoNumeroPalletExtra,
    });
    if (actionHistory.length > 30) actionHistory.shift();
  }

  /* ── Modal de configuração personalizada de pallet ────── */
  // Botões de tipo do modal "Personalizada" — antes eram 4 <button>
  // hardcoded no HTML (SP/2P/3T/1T, ver page-setor-qualidade.html),
  // então qualquer tipo simples cadastrado além desses 4 (ex: "5T")
  // simplesmente não aparecia aqui pra ser escolhido (mesmo já
  // existindo em Configurações e no dropdown principal #sq-mountType).
  // Agora gera 1 botão por tipo simples de _montagemOpcoesCache, com a
  // cor de verdade do tipo (LW.corPorTipoSimples, mesma usada em
  // Registrar Operação) — funciona pra qualquer tipo, sem lista fixa.
  function _renderBotoesTipoModal() {
    const box = document.getElementById('sq-modal-tipos-botoes');
    if (!box) return;
    const simples = (_montagemOpcoesCache || []).filter(o => o && o.modo === 'simples' && o.tipo && o.label);
    box.innerHTML = simples.map(o => {
      const codigo = String(o.tipo).toUpperCase();
      const cor = (typeof LW !== 'undefined' && LW.corPorTipoSimples) ? LW.corPorTipoSimples(o.tipo) : null;
      const ativo = modalTipoSel === codigo;
      return `<button type="button" class="sq-btn-tipo${ativo ? ' active' : ''}" data-tipo="${codigo}" style="background:${cor ? cor.cor : '#5c6475'}" onclick="SQ.setModalTipo('${codigo}')">${codigo}</button>`;
    }).join('');
  }

  function openPalletModal() {
    tempSlabConfig = { ...slabConfig };
    _renderBotoesTipoModal(); // sempre atualizado, caso um tipo tenha sido cadastrado/removido desde a última abertura
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
        if (val) {
          tp.textContent = val;
          const cor = (typeof LW !== 'undefined' && LW.corPorTipoSimples) ? LW.corPorTipoSimples(val.toLowerCase()) : null;
          if (cor) tp.style.color = cor.cor;
        }
        slab.appendChild(tp);
        slab.addEventListener('click', function () {
          const key = this.dataset.id, tpEl = this.querySelector('.sq-m-tp');
          if (tempSlabConfig[key] === modalTipoSel) {
            delete tempSlabConfig[key]; tpEl.textContent = ''; tpEl.style.color = ''; this.classList.remove('sel');
          } else {
            tempSlabConfig[key] = modalTipoSel; tpEl.textContent = modalTipoSel;
            const cor = (typeof LW !== 'undefined' && LW.corPorTipoSimples) ? LW.corPorTipoSimples(modalTipoSel.toLowerCase()) : null;
            tpEl.style.color = cor ? cor.cor : '';
            this.classList.add('sel');
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
    document.querySelectorAll('#sq-modal-tipos-botoes .sq-btn-tipo').forEach(b => b.classList.toggle('active', b.dataset.tipo === type));
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
    _resetStacksParaPadrao();
    renderStacks();
    validateAllSlabs();
    closePalletModal();
  }

  /* ── Navegação interna ────────────────────────────────── */
  function navigateTo(section) {
    if (viewMode && section !== 'form') exitViewMode();
    if (_editandoAvaliacaoId && section !== 'form') {
      _editandoAvaliacaoId = null;
      _editandoRegistradoEm = null;
      _editandoLinkedOperacaoId = null;
      _editandoAvaliadorNome = null;
    }
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
  // branco, já COM a fila de baterias pendentes visível acima do
  // cabeçalho (ver carregarFilaNaoAvaliadas, abaixo). Clicar num item da
  // fila vincula e preenche o formulário.
  //
  // IMPORTANTE — avaliação AVULSA (registrar sem nunca ter clicado num
  // item da fila) NÃO é mais permitida (ver bloqueio em
  // registerEvaluation(), abaixo, e a trava definitiva em
  // POST /registrar-avaliacao-qualidade, server.js): dava pra registrar
  // uma avaliação livre, digitando só o ID da bateria, e esse era
  // exatamente o cenário que fazia a Análise Focada não encontrar o
  // resultado (a operação real nunca ficava vinculada). O formulário
  // continua abrindo em branco aqui (pra mostrar a fila e permitir
  // rascunho), mas "Registrar" fica desabilitado até a pessoa escolher
  // uma bateria da fila (ver _aplicarModoBotoesForm).
  function startNew() {
    _iniciarForm(null);
  }

  // Campos que vêm PRONTOS da operação real escolhida na fila (ver
  // _prefillFromOperacao) — quem preenche o valor de verdade é o
  // Registro de Operação, não a Qualidade. Ficam travados pra não deixar
  // o lançamento da Qualidade divergir do que realmente aconteceu na
  // operação; tudo que NÃO está preenchido automaticamente (temperatura,
  // data/hora de montagem e desmoldagem, observações, e a marcação
  // propriamente dita das placas) continua livre. A Espessura de cada
  // pallet (grade "Medição") é um caso à parte — não é um <select>/
  // <input> do formulário, é span com lápis (ver editField) — por isso
  // é tratada separadamente aqui, via classe .sq-info-edit-locked.
  const CAMPOS_AUTO_PREENCHIDOS = ['sq-batteryId', 'sq-mountType', 'sq-turno', 'sq-dtEnchimento'];

  // bloquear=true trava. SEMPRE travado enquanto a tela de avaliação está
  // aberta — mesmo em branco, antes de escolher a bateria: como avulsa não
  // é mais permitida (ver registerEvaluation), esses 5 campos só têm valor
  // de verdade depois de vir de uma operação real (fila/rascunho/correção,
  // ver _prefillFromOperacao/loadDraft/editarAvaliacaoDoEspelho) — não faz
  // sentido digitar neles antes disso, então ficam travados desde já.
  // Desabilitar o <select>/<input> não impede o JS de setar .value por
  // código (só bloqueia teclado/mouse do usuário), então prefill continua
  // funcionando normalmente com o campo já travado.
  function _bloquearCamposAutoPreenchidos(bloquear) {
    CAMPOS_AUTO_PREENCHIDOS.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = bloquear;
    });
    document.querySelectorAll('.sq-info-edit[data-field="espessura"]').forEach(btn => {
      btn.classList.toggle('sq-info-edit-locked', bloquear);
    });
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
    _bloquearCamposAutoPreenchidos(true); // sempre travado — ver comentário na função, acima
    _aplicarModoBotoesForm(); // reflete no botão "Registrar" se ficou sem operação vinculada (ver comentário lá)
  }

  // Seleciona no <select> de ID da Bateria (sq-batteryId) um valor que pode
  // não existir entre as <option>s fixas do HTML (só 13 baterias
  // hardcoded, ver page-setor-qualidade.html) — cadastro de baterias é
  // dinâmico (LW.BATERIA_IDS, configurável em Registro de Baterias), então
  // uma avaliação salva ou uma operação da fila podem referenciar uma
  // bateria fora dessa lista fixa (bateria nova, cadastrada depois, ou só
  // convenção de nome divergente: ex. "B5-7,5cm" em Registro de Baterias
  // vs "B5-7.5" aqui). Sem checar isso, sel.value = bid que não bate com
  // nenhuma <option> é ignorado silenciosamente pelo navegador — o select
  // fica na primeira opção (ou vazio) sem nenhum aviso, e some com o ID
  // que deveria estar lá. Usado tanto no prefill da fila
  // (_prefillFromOperacao) quanto ao reabrir uma avaliação já registrada
  // (_carregarAvaliacaoNoFormulario — Espelho/Histórico), que é onde esse
  // problema apareceu de fato: bateria salva já tinha saído das <option>s
  // fixas, editar pelo Espelho abria o campo vazio e a correção não dava
  // pra salvar (registerEvaluation exige o campo preenchido).
  function _selecionarBateriaNoForm(bid) {
    if (!bid) return;
    const sel = document.getElementById('sq-batteryId');
    if (!sel) return;
    const existe = Array.from(sel.options).some(o => o.value === bid);
    if (!existe) {
      const novaOpcao = document.createElement('option');
      novaOpcao.value = bid;
      novaOpcao.textContent = bid;
      sel.appendChild(novaOpcao);
    }
    sel.value = bid;
  }

  // Pré-preenche ID da Bateria, Turno, Tipo de Montagem e — se a operação
  // for Montagem Personalizada — a grade inteira, a partir dos dados reais
  // da operação escolhida na fila (ver GET /operacoes-nao-avaliadas,
  // server.js).
  function _prefillFromOperacao(op) {
    // ── ID da Bateria ──────────────────────────────────────────────────
    if (op.id_bateria) _selecionarBateriaNoForm(op.id_bateria);

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

    // ── Data/Hora de Enchimento ──────────────────────────────────────
    // Data = op.data (o dia em que a OPERAÇÃO começou — ver dataLocal em
    // operacao.js: state.inicio.split('T')[0] — sempre a data de
    // referência da operação, usada em todo o resto do sistema pra
    // agrupar/filtrar). Hora = extraída de op.fim (timestamp completo de
    // quando a operação foi finalizada — ver state.fim em operacao.js).
    // Não usa op.fim inteiro direto: um turno que passa da meia-noite
    // teria o "dia" de op.fim já no dia seguinte, e aqui queremos o dia
    // da operação, não o do relógio no instante exato do fim.
    // .toISOString() (não getHours/getMinutes locais) pelo mesmo motivo
    // de fmtDTL, acima — mesma convenção usada em todo o resto deste
    // arquivo pra ler/escrever os campos datetime-local daqui.
    if (op.data && op.fim) {
      const horaFim = new Date(op.fim);
      if (!isNaN(horaFim)) {
        document.getElementById('sq-dtEnchimento').value = `${op.data}T${horaFim.toISOString().slice(11, 16)}`;
        calculateCureTime();
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

    // ── Direcionamento de painéis por palete (ver _paleteDoBerco/
    // _bercoDoSlot, abaixo): SEMPRE a capacidade configurada da bateria,
    // NUNCA bercos_reais — diferente de capacidadeReal (acima), que
    // prioriza bercos_reais de propósito pra "nº de placas por pallet"
    // (uma operação parcial tem menos painéis de verdade pra avaliar).
    // O direcionamento é sobre ONDE FISICAMENTE cada berço empilha (a
    // grade do molde), que não muda numa operação parcial — só a
    // quantidade de painéis muda, não o layout. Sem capacidade
    // conhecida, fica null e a grade volta a numerar 1..N sem
    // referência a berço nenhum (mesmo comportamento de antes desta
    // mudança).
    capacidadeOperacaoAtual = parseInt(op.capacidade) || null;

    // ── Espessura: corrige o palpite por bateria (autoSetThickness →
    // refreshPalletInfos, acima) com a dimensão REAL gravada na operação
    // — pode ter sido ajustada manualmente em Registrar Operação, então
    // não necessariamente bate com o padrão cadastrado da bateria. ──────
    if (op.dimensao) _definirEspessuraReal(op.dimensao);

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
    _definirPaineisNaoEnchidos(op); // precisa vir ANTES do reset — é ele quem reaplica a remoção (ver _resetStacksParaPadrao)
    _resetStacksParaPadrao();
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

  // ── Direcionamento de painéis por palete ──────────────────────────────
  // Cada berço da bateria enche 2 painéis — um do lado ESQUERDO (DB:
  // estado_esquerda), um do lado DIREITO (DB: estado_direita) — mesmo
  // "Direito"/"Esquerdo" já usado nos pontinhos de Bateria Atual e
  // Análise Focada (ver data-lado="direita"/"esquerda", ba-dot-topo/
  // ba-dot-base, bateria-atual.js). A capacidade (nº de berços
  // configurado, nunca bercos_reais — ver capacidadeOperacaoAtual) é
  // dividida em duas metades; qual metade + qual lado determina o
  // palete de destino. CONFIGURÁVEL desde Configurações → Bateria e
  // Montagem → "Definir Paletes" (ver public/js/paletes-config.js,
  // LW.PALETES_CONFIG, data.js) — mapeamento DIRETO (config.direito* →
  // aqui `direito`, config.esquerdo* → aqui `esquerdo`), sem nenhuma
  // inversão escondida: a prévia visual da própria tela de configuração
  // mostra exatamente pra qual palete cada lado vai, então qualquer
  // ajuste necessário é feito ali mesmo, visualmente, pelo Administrador
  // — não decidido "no escuro" aqui no código.
  function _paletePorMetadeELado() {
    const cfg = LW.PALETES_CONFIG || LW.PALETES_CONFIG_DEFAULT;
    return {
      esquerdo: { primeira: cfg.esquerdoPrimeira, segunda: cfg.esquerdoSegunda },
      direito:  { primeira: cfg.direitoPrimeira,  segunda: cfg.direitoSegunda },
    };
  }

  // Berço + lado -> { pallet, posicao } (posição É o número mostrado
  // dentro daquele palete, sempre 1..metade).
  function _paleteDoBerco(bercoNum, lado, capacidade) {
    if (!capacidade || capacidade <= 0) return null;
    const metade = Math.ceil(capacidade / 2);
    const primeiraMetade = bercoNum <= metade;
    const pallet = _paletePorMetadeELado()[lado]?.[primeiraMetade ? 'primeira' : 'segunda'];
    if (!pallet) return null;
    const posicao = primeiraMetade ? bercoNum : bercoNum - metade;
    return { pallet, posicao };
  }

  // Dado um dos 4 paletes BASE, devolve de qual LADO ele é (esquerdo ou
  // direito) — usado por _bercoDoSlot pra saber quais berços "não
  // enchido" (que são marcados por lado, não pelo palete em si) valem
  // pra ele.
  function _ladoDoPallet(pallet) {
    const mapa = _paletePorMetadeELado();
    if (pallet === mapa.esquerdo.primeira || pallet === mapa.esquerdo.segunda) return 'esquerdo';
    if (pallet === mapa.direito.primeira || pallet === mapa.direito.segunda) return 'direito';
    return null;
  }

  // Conjunto (Set) dos números de berço marcados como "não enchido" NO
  // LADO indicado, a partir de uma lista bruta no formato de
  // paineisNaoEnchidosAtual (ver _definirPaineisNaoEnchidos). Recebe a
  // lista como parâmetro em vez de ler paineisNaoEnchidosAtual direto —
  // assim _bercoDoSlot também funciona pro espelho de uma avaliação já
  // salva (item.capacidadeOperacao), sem misturar com o estado da
  // avaliação que está sendo editada agora.
  function _bercosNaoEnchidosPorLado(lado, listaBruta) {
    const campo = lado === 'esquerdo' ? 'esquerda' : 'direita';
    const set = new Set();
    (Array.isArray(listaBruta) ? listaBruta : []).forEach(b => {
      if (b[`estado_${campo}`] !== 'nao_enchido') return;
      const bercoNum = parseInt(b.ordem) || parseInt(String(b.berco || '').replace(/^B/i, ''));
      if (bercoNum) set.add(bercoNum);
    });
    return set;
  }

  // "🚫 Marcar Não Enchido" (Bateria Atual, ver bateria-atual.js) — grava
  // o snapshot cru de op.bercos_visuais (ver bercosVisuaisPorOperacoes,
  // db.js, e GET /operacoes-nao-avaliadas) em paineisNaoEnchidosAtual, pra
  // _removerPaineisNaoEnchidosDaGrade (abaixo) reaplicar toda vez que a
  // grade for resetada — troca de Tipo de Montagem/Espessura depois do
  // prefill NÃO deve devolver os painéis "não enchidos" pra grade. Só
  // GRAVA aqui; quem de fato remove da grade é
  // _removerPaineisNaoEnchidosDaGrade, chamada dentro de
  // _resetStacksParaPadrao (sempre nessa ordem: reset "enche" a grade de
  // novo, remoção tira os "não enchidos" em cima do resultado).
  function _definirPaineisNaoEnchidos(op) {
    paineisNaoEnchidosAtual = Array.isArray(op?.bercos_visuais) ? op.bercos_visuais : [];
  }

  // Remove UMA posição de UM pallet BASE, deslocando quem ficou pra trás
  // uma posição pra frente (fecha o buraco) — mesma mecânica de
  // remoção usada em _moverPainel (linha de origem, ao mover uma placa
  // pra outro pallet), só que sem adicionar a placa em lugar nenhum:
  // aqui ela nem existe (painel "não enchido"), não é uma placa que
  // mudou de pallet. Reduz stackCounts[sid] em 1.
  function _removerPosicaoDoPallet(sid, posicao) {
    const n = stackCounts[sid] || 0;
    if (!posicao || posicao < 1 || posicao > n) return;
    for (let i = posicao; i < n; i++) {
      const de = `${sid}-${i + 1}`, para = `${sid}-${i}`;
      if (slabState[de] !== undefined)  slabState[para]  = slabState[de];  else delete slabState[para];
      if (slabMotivo[de] !== undefined) slabMotivo[para] = slabMotivo[de]; else delete slabMotivo[para];
      if (slabMotivoDescricao[de] !== undefined) slabMotivoDescricao[para] = slabMotivoDescricao[de]; else delete slabMotivoDescricao[para];
      if (slabConfig[de] !== undefined) slabConfig[para] = slabConfig[de]; else delete slabConfig[para];
    }
    delete slabState[`${sid}-${n}`];
    delete slabMotivo[`${sid}-${n}`];
    delete slabMotivoDescricao[`${sid}-${n}`];
    delete slabConfig[`${sid}-${n}`];
    stackCounts[sid] = n - 1;
  }

  // Aplica paineisNaoEnchidosAtual (ver _definirPaineisNaoEnchidos, acima)
  // EM CIMA do stackCounts atual — cada lado de berço marcado como
  // 'nao_enchido' vira 1 painel a menos no pallet correspondente (ver
  // _paleteDoBerco): o painel nunca chegou a existir de verdade, não faz
  // sentido pedir avaliação dele. Chamada SEMPRE dentro de
  // _resetStacksParaPadrao — nunca direto — pra sobreviver a qualquer
  // reset posterior da grade (troca de Tipo de Montagem, de Espessura),
  // não só ao prefill inicial.
  //
  // Formato de cada item: {berco:'B3', ordem:3, estado_esquerda,
  // estado_direita} — ver bercosVisuaisPorOperacoes (db.js). Lista vazia
  // (operação sem nenhum berço marcado, ou capacidadeOperacaoAtual ainda
  // não definida) não remove nada — mesmo comportamento de antes desta
  // funcionalidade existir.
  //
  // IMPORTANTE: processa do MAIOR berço pro MENOR (sort desc) — cada
  // remoção desloca as posições seguintes DAQUELE MESMO pallet uma casa
  // pra trás (ver _removerPosicaoDoPallet); remover em ordem crescente
  // bagunçaria o índice das remoções seguintes no mesmo pallet (a 2ª
  // remoção "acertaria" a posição errada, já deslocada pela 1ª).
  function _removerPaineisNaoEnchidosDaGrade() {
    if (!paineisNaoEnchidosAtual.length || !capacidadeOperacaoAtual) return;
    const remocoes = [];
    paineisNaoEnchidosAtual.forEach(b => {
      const bercoNum = parseInt(b.ordem) || parseInt(String(b.berco || '').replace(/^B/i, ''));
      if (!bercoNum) return;
      [['esquerda', 'esquerdo'], ['direita', 'direito']].forEach(([campo, lado]) => {
        if (b[`estado_${campo}`] !== 'nao_enchido') return;
        const destino = _paleteDoBerco(bercoNum, lado, capacidadeOperacaoAtual);
        if (destino) remocoes.push({ bercoNum, ...destino });
      });
    });
    remocoes.sort((a, b) => b.bercoNum - a.bercoNum);
    remocoes.forEach(r => _removerPosicaoDoPallet(`stack${r.pallet}`, r.posicao));
  }

  // Caminho inverso: dado um dos 4 paletes BASE (1-4) e uma posição
  // dentro dele, devolve o nº do berço de origem — usado por
  // renderStacks() pra rotular cada painel da grade com o berço real,
  // em vez de um índice solto 1..N sem relação com o berço físico.
  // Paletes extras (5+, ver adicionarPalletExtra) não têm berço de
  // origem definido — devolve null, a chamada volta a numerar 1..N.
  // Generalizado pra qualquer permutação configurada em "Definir
  // Paletes" (ver _paletePorMetadeELado, acima) — não assume mais que
  // paletes 3/4 são sempre a 1ª metade.
  //
  // bercosNaoEnchidos (opcional, mesmo formato de paineisNaoEnchidosAtual)
  // — ver conversa que motivou isso: encher só um lado do berço (ou
  // marcar "🚫 Não Enchido" em Bateria Atual) tira 1 painel da grade
  // (ver _removerPaineisNaoEnchidosDaGrade), mas o berço que falta
  // precisa DESAPARECER da numeração, não só empurrar todo mundo pra
  // trás uma casa — B6 continua sendo B6 mesmo se B5 não existir aqui,
  // nunca vira "B5" por engano. Por isso este cálculo agora PULA os
  // berços não enchidos ao contar posições, em vez de somar direto
  // (posição + deslocamento fixo).
  function _bercoDoSlot(pallet, posicao, capacidade, bercosNaoEnchidos) {
    if (!capacidade || capacidade <= 0) return null;
    const metade = Math.ceil(capacidade / 2);
    const mapa = _paletePorMetadeELado();
    let inicio, fim;
    if (pallet === mapa.esquerdo.primeira || pallet === mapa.direito.primeira) { inicio = 1; fim = metade; }
    else if (pallet === mapa.esquerdo.segunda || pallet === mapa.direito.segunda) { inicio = metade + 1; fim = capacidade; }
    else return null;

    if (!bercosNaoEnchidos || !bercosNaoEnchidos.length) return inicio + posicao - 1; // atalho de sempre, sem remoções

    const removidos = _bercosNaoEnchidosPorLado(_ladoDoPallet(pallet), bercosNaoEnchidos);
    if (!removidos.size) return inicio + posicao - 1;

    let contagem = 0;
    for (let b = inicio; b <= fim; b++) {
      if (removidos.has(b)) continue;
      contagem++;
      if (contagem === posicao) return b;
    }
    return null; // não deveria acontecer se posicao <= stackCounts[sid]
  }

  // Atualiza o subtítulo de cada palete-base (ex.: "Berços 1–10 · Esq.")
  // com a faixa de berços que ele recebe — só aparece quando a
  // capacidade da operação já é conhecida (ver capacidadeOperacaoAtual);
  // fica em branco (mesmo texto de sempre, sem subtítulo) enquanto não
  // for, pra não mostrar uma faixa errada antes da operação carregar.
  // Generalizado pra qualquer permutação configurada em "Definir
  // Paletes" (ver _paletePorMetadeELado, acima).
  function _atualizarSubtitulosPallets() {
    const cap = capacidadeOperacaoAtual;
    const metade = cap ? Math.ceil(cap / 2) : null;
    const mapa = _paletePorMetadeELado();
    const faixas = cap ? {
      [mapa.esquerdo.primeira]: `Berços 1–${metade} · Esq.`,
      [mapa.direito.primeira]:  `Berços 1–${metade} · Dir.`,
      [mapa.esquerdo.segunda]:  `Berços ${metade + 1}–${cap} · Esq.`,
      [mapa.direito.segunda]:   `Berços ${metade + 1}–${cap} · Dir.`,
    } : { 1: '', 2: '', 3: '', 4: '' };
    Object.entries(faixas).forEach(([n, texto]) => {
      const el = document.getElementById('sq-pallet-sub-' + n);
      if (el) el.textContent = texto;
    });
  }

  // Monta o slabConfig (mesmo formato usado pelo modal de Configuração
  // Personalizada — ver confirmPalletModal) a partir de
  // bercos_personalizados de uma operação real: 1 item por berço (tipo
  // curto — 'sp'/'2p'/'3t' — ou null). Cada berço enche 2 painéis — um
  // ESQUERDO, um DIREITO — que vão pra PALETES DIFERENTES (ver
  // _paleteDoBerco/_bercoDoSlot, e o pedido original de "direcionar os
  // painéis pros paletes certos"). Reaproveita a MESMA função que
  // decide os rótulos da grade (renderStacks) pra decidir onde o tipo
  // de cada berço cai — evita exatamente o bug que já aconteceu uma vez
  // aqui: rótulo (qual berço) e tipo (SP/2P/3T daquele berço) vinham de
  // duas contas DIFERENTES, e podiam apontar pra berços diferentes.
  function _montarSlabConfigDeBercos(bercosPersonalizados) {
    const bercos = Array.isArray(bercosPersonalizados) ? bercosPersonalizados : [];
    // Sempre a capacidade CONFIGURADA da bateria (nunca o tamanho do
    // array recebido) — mesma regra usada em todo o resto do
    // direcionamento; cai pro tamanho do array só se a operação ainda
    // não tiver sido carregada (capacidadeOperacaoAtual nulo).
    const capacidade = capacidadeOperacaoAtual || bercos.length;
    const novo = {};
    bercos.forEach((tipoBerco, idx) => {
      const cod = tipoBerco ? String(tipoBerco).toUpperCase() : ''; // 'sp' -> 'SP', '2p' -> '2P', '3t' -> '3T'
      if (!cod) return;
      const bercoNum = idx + 1;
      ['esquerdo', 'direito'].forEach(lado => {
        const destino = _paleteDoBerco(bercoNum, lado, capacidade);
        if (destino) novo[`stack${destino.pallet}-${destino.posicao}`] = cod;
      });
    });
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
  // IMPORTANTE: extrai dia/mês/hora via .toISOString() — NUNCA via
  // toLocaleDateString/toLocaleTimeString (o bug que isso corrige: essas
  // duas aplicam o fuso horário do NAVEGADOR por cima, e neste sistema as
  // datas (op.data/op.fim) já são a hora de parede (Brasília) "disfarçada"
  // de UTC — mesma convenção usada em fmtDTL e em toda leitura de
  // datetime-local deste arquivo, ver comentário em _prefillFromOperacao
  // logo acima de onde "Data/Hora de Enchimento" é preenchida. Usar
  // toLocaleDateString/toLocaleTimeString aqui deslocava o horário
  // exibido na fila pelo fuso configurado no navegador/dispositivo —
  // mesmo a hora certa já estando ali dentro do próprio valor.
  function _filaData(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    if (isNaN(d)) return '--';
    const [, mes, dia] = d.toISOString().slice(0, 10).split('-');
    return `${dia}/${mes}`;
  }
  function _filaHora(iso) {
    if (!iso) return '--';
    const d = new Date(iso);
    return isNaN(d) ? '--' : d.toISOString().slice(11, 16);
  }
  function _filaTipoLabel(tipoMontagem) {
    return tipoMontagem === 'PERSONALIZADA' ? 'Personalizada' : _escaparHtml(tipoMontagem || '--');
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
          <strong>${_escaparHtml(op.id_bateria || 'N/I')}</strong>
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
          <strong>${_escaparHtml(op.id_bateria || 'N/I')}</strong>
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
            return `<option value="${op.id}">${_filaOrdinal(posicao)} · ${_escaparHtml(op.id_bateria || 'N/I')} · ${_filaTipoLabel(op.tipo_montagem)} · ${dt}</option>`;
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
      extraStacks: [...extraStacks], stackCounts: { ...stackCounts },
      dailySeq:     document.getElementById('sq-dailySeq').value,
      turno:        document.getElementById('sq-turno').value,
      tempInput:    document.getElementById('sq-temp').value,
      dtMontagem:   document.getElementById('sq-dtMontagem').value,
      dtEnchimento: document.getElementById('sq-dtEnchimento').value,
      dtDesmoldagem:document.getElementById('sq-dtDesmoldagem').value,
      observations: document.getElementById('sq-obs').value,
      slabsPerPallet: parseInt(document.getElementById('sq-thickness').value),
      slabState,
      slabMotivo,
      slabMotivoDescricao,
      palletInfos: {}
    };
    [1, 2, 3, 4, ...extraStacks].forEach(p => {
      data.palletInfos[p] = {};
      ['comprimento','largura','linearidade','espessura','esquadro'].forEach(f => {
        const el = document.getElementById(`sq-p${p}-${f}`);
        data.palletInfos[p][f] = el ? el.innerText : '';
      });
    });
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
    applyFormData(d); // já seta linkedOperacaoId = d.linkedOperacaoId — ver applyFormData
    currentDraftId = d.id;
    navigateTo('form');
    autoSetThickness();
    _restaurarEstadoDoRascunho(d); // placas/marcas/pallets extras — sempre depois de autoSetThickness, ver comentário lá
    calculateCureTime();
    setEditable(true);
    // Sempre travado — ver comentário em _bloquearCamposAutoPreenchidos.
    _bloquearCamposAutoPreenchidos(true);
    validateAllSlabs();
    closeAllCollapsibles();
    _aplicarModoBotoesForm(); // reflete no botão "Registrar" se este rascunho não tem operação vinculada
  }

  function deleteDraft(id) {
    if (!confirm('Remover este rascunho?')) return;
    LS.del('draft_' + id);
    renderDrafts();
  }

  // Tipo(s) de montagem de CADA palete, pro registro salvo (coluna
  // Pallet 1..4 na tela "Registros" — ver renderHistory, mais abaixo).
  // Antes usava só palletTypes[idx] (preset uniforme do dropdown
  // principal) — ficava vazio (mostrando só um traço "—") sempre que o
  // modo "Personalizada" era usado, MESMO quando as placas tinham um
  // tipo de verdade (ver conversa que motivou isso). Agora calcula a
  // partir do `tipoEsperado` de CADA painel (já presente em
  // evalObj.paineis, ver registerEvaluation) — funciona pra qualquer
  // tipo cadastrado (não só os 4 antes hardcoded no modal Personalizada,
  // ver _renderBotoesTipoModal) e, se o mesmo palete tiver placas de
  // tipos DIFERENTES, junta todos com "/" (ex: "3T/5T") em vez de
  // mostrar só um ou nenhum.
  function _montagemDoRegistro(paineis) {
    const montagem = {};
    for (let n = 1; n <= 4; n++) {
      const tipos = [];
      paineis.filter(p => p.pallet === n).forEach(p => {
        const t = (p.tipoEsperado || '').toString().toUpperCase();
        if (t && !tipos.includes(t)) tipos.push(t);
      });
      montagem[`pallet${n}`] = tipos.join('/');
    }
    return montagem;
  }

  /* ── Registrar avaliação definitiva (ou salvar correção) ── */
  function registerEvaluation() {
    if (viewMode) return;
    if (!document.getElementById('sq-batteryId').value) { showAlert('Erro','Selecione o ID da Bateria.'); return; }
    const editando = !!_editandoAvaliacaoId;
    // Avaliação AVULSA não é mais permitida (ver bloqueio espelhado — e
    // definitivo — em POST /registrar-avaliacao-qualidade, server.js):
    // só dá pra registrar uma avaliação NOVA se ela veio de um clique na
    // fila (linkedOperacaoId setado por iniciarAvaliacaoDaFila/
    // iniciarAvaliacaoDoSelect). Uma CORREÇÃO (editando) nunca cai aqui —
    // ela já tem um id existente, então não é bloqueada mesmo que o
    // registro original (legado) não tenha vínculo.
    if (!editando && !linkedOperacaoId) {
      showAlert('Selecione uma bateria da fila', 'Avaliação avulsa não é mais permitida — abra "Ordem de Previsão de Desemplaque" acima e escolha a bateria que você está avaliando antes de registrar.');
      return;
    }
    // Antes dependia de um checkbox marcado à mão ("confirmo que avaliei
    // todos os painéis") — só um lembrete, não impedia registrar uma
    // bateria com placas de fato esquecidas. Agora verifica de verdade:
    // toda placa (stack1..stack4 × espessura) precisa ter pelo menos uma
    // marca — real (círculo/traço) ou X ("painel não preenchido", pra
    // quem conscientemente não deu pra avaliar). Destaca as que faltam
    // (mesmo visual de placa com tipo incompatível, ver validateAllSlabs)
    // e recusa registrar enquanto sobrar alguma.
    document.querySelectorAll('.sq-slab.invalid').forEach(el => el.classList.remove('invalid'));
    const faltando = _paineisNaoMarcados();
    if (faltando.length) {
      faltando.forEach(id => document.querySelector(`.sq-slab[data-id="${id}"]`)?.classList.add('invalid'));
      showAlert('Faltam painéis', `Ainda ${faltando.length === 1 ? 'há 1 painel' : `há ${faltando.length} painéis`} sem nenhuma marcação (destacado${faltando.length === 1 ? '' : 's'} em vermelho) — marque todos antes de registrar. Painéis que não puderam ser avaliados usam o X (Painel não preenchido).`);
      return;
    }
    showConfirm(
      editando ? 'Salvar Correção' : 'Registrar',
      editando
        ? 'Confirma salvar a correção desta avaliação? O registro original será substituído.'
        : 'Ao registrar, a avaliação vai para o histórico. Continuar?',
      () => {
      const evId = editando ? _editandoAvaliacaoId : ('ev_' + Date.now());
      const evalObj = {
        id: evId, schemaVersion: 2,
        batteryId: document.getElementById('sq-batteryId').value,
        linkedOperacaoId: editando ? _editandoLinkedOperacaoId : (linkedOperacaoId || null),
        // Preenchido logo abaixo, depois de montar evalObj.paineis — ver
        // _montagemDoRegistro (calcula a partir do tipo de CADA placa,
        // não de um valor fixo por pallet, ver conversa que motivou:
        // "Registros" só mostrava um traço "—" pra qualquer tipo além de
        // 2P/SP, porque usava só palletTypes[idx], que fica vazio no
        // modo Personalizada mesmo quando as placas TÊM um tipo).
        montagem: null,
        turno:    document.getElementById('sq-turno').value,
        tempInput: parseFloat(document.getElementById('sq-temp').value) || 0,
        dtMontagem:    toISO(document.getElementById('sq-dtMontagem').value),
        dtEnchimento:  toISO(document.getElementById('sq-dtEnchimento').value),
        dtDesmoldagem: toISO(document.getElementById('sq-dtDesmoldagem').value),
        // Numa correção, preserva a data em que a avaliação REALMENTE
        // aconteceu (registeredAt) — é o que ordena o Histórico/Dashboard;
        // sem isso, corrigir um erro de digitação faria o registro "pular"
        // pra hoje na lista, como se tivesse sido avaliado agora. A data
        // do conserto em si fica em editadoEm, só como rastro auditável.
        registeredAt: editando ? _editandoRegistradoEm : new Date().toISOString(),
        totalSlabs: _stackIds().reduce((soma, sid) => soma + (stackCounts[sid] || 0), 0),
        // Dimensão real da operação (ver _definirEspessuraReal, mais
        // acima) — gravada na própria avaliação pra sobreviver ao reabrir
        // uma já registrada (ver _carregarAvaliacaoNoFormulario), sem
        // depender da operação ainda estar na fila (ela já não está mais,
        // nesse ponto).
        dimensaoOperacao: dimensaoOperacaoAtual || null,
        capacidadeOperacao: capacidadeOperacaoAtual || null,
        observations: document.getElementById('sq-obs').value,
        // Autoria automática — quem está logado agora (ver
        // LW.nomeDeQuemEstaLogado(), data.js), preenchida só ao
        // REGISTRAR uma avaliação nova; numa correção, preserva o
        // avaliador original (_editandoAvaliadorNome, carregado junto
        // com o resto da avaliação em edição — ver
        // _carregarAvaliacaoNoFormulario) em vez de trocar pra quem só
        // corrigiu um detalhe depois (mesmo raciocínio de Paradas,
        // paradas.js).
        avaliadorNome: editando ? (_editandoAvaliadorNome || null) : LW.nomeDeQuemEstaLogado(),
        ...(editando ? { editadoEm: new Date().toISOString() } : {}),
      };
      // Painéis embutidos na própria avaliação — 1 linha no banco pra
      // avaliação inteira (ver db.salvarAvaliacaoQualidade, db.js),
      // "avaliacaoId" mantido em cada painel só por compatibilidade com
      // quem já filtra por ele (ver getData()/carregarAvaliacoesQualidade).
      // "motivo" (código, ver MOTIVOS_DEFEITO) só existe pra painéis 2ª
      // linha/reprovados — null nos demais (slabMotivo[id] nunca é
      // preenchido pra placa aprovada 1ª linha, ver _corExigeMotivo).
      // "motivoDescricao" só existe quando motivo === 'OT' — descrição
      // livre digitada na hora (ver showPrompt em _abrirSeletorMotivo).
      evalObj.paineis = Object.entries(slabState).map(([id, marks]) => {
        const parts = id.split('-');
        const info  = getClassifiedInfo(marks);
        return { avaliacaoId: evId, pallet: parseInt(parts[0].replace('stack','')), posicao: parseInt(parts[1]), tipoEsperado: getExpectedType(id), tipoObtido: info.tipoObtido, resultado: info.resultado, linha: info.linha, marcas: marks, motivo: slabMotivo[id] || null, motivoDescricao: slabMotivoDescricao[id] || null };
      });
      evalObj.montagem = _montagemDoRegistro(evalObj.paineis);

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
          const destino = editando ? 'dashboard' : 'form';
          clearForm();
          currentDraftId = null;
          showAlert('Concluído', editando ? 'Correção salva com sucesso!' : 'Avaliação registrada com sucesso!');
          navigateTo(destino);
          carregarAvaliacoesQualidade();
          // A operação vinculada (se houver) já foi marcada como avaliada
          // e removida da fila pelo PRÓPRIO /registrar-avaliacao-qualidade,
          // na mesma requisição acima (ver lib/rotas/qualidade.js) — não
          // precisa mais de uma 2ª chamada separada aqui. Antes, essa 2ª
          // chamada (POST /marcar-operacao-avaliada) podia falhar
          // silenciosamente (só .catch(console.error), sem avisar
          // ninguém) e deixar a operação presa na fila pra sempre, mesmo
          // com a avaliação já registrada com sucesso — bug real
          // encontrado e corrigido. Só recarrega a fila aqui, pra
          // refletir a mudança que o servidor já fez.
          carregarFilaNaoAvaliadas();
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
    _restaurarEstadoDoRascunho(d); // placas/marcas/pallets extras — sempre depois de autoSetThickness, ver comentário lá
    calculateCureTime();
    viewSource = 'form';
    setEditable(false);
    viewMode = true;
    navigateTo('form');
    closeAllCollapsibles();
  }

  // Preenche o formulário inteiro (cabeçalho + grade de painéis) a partir
  // de uma avaliação já salva — usado tanto por viewHistoryRecord (modo
  // só-leitura) quanto por editarAvaliacaoDoEspelho (modo editável).
  function _carregarAvaliacaoNoFormulario(item) {
    const d = getData();
    // Precisa vir ANTES de qualquer chamada a refreshPalletInfos/
    // autoSetThickness (mais abaixo) — são elas que de fato escrevem a
    // Espessura na tela, e dão preferência a dimensaoOperacaoAtual quando
    // ela já está definida (ver refreshPalletInfos). Avaliação legada
    // (registrada antes desta mudança) não tem este campo — cai de volta
    // no palpite por bateria, de propósito.
    dimensaoOperacaoAtual = item.dimensaoOperacao || null;
    // Avaliação legada (registrada antes desta mudança) não tem este
    // campo — cai de volta pra sem numeração por berço (mesma regra de
    // dimensaoOperacaoAtual, acima).
    capacidadeOperacaoAtual = item.capacidadeOperacao || null;
    // Este fluxo (reabrir avaliação já salva — Espelho/Histórico)
    // reconstrói a grade inteira a partir dos PAINÉIS JÁ PERSISTIDOS
    // (paineisDaAvaliacao, mais abaixo) — nunca deve reaplicar a remoção
    // de "não enchidos" de uma sessão anterior de _iniciarForm que
    // porventura ainda esteja em memória (autoSetThickness, logo abaixo,
    // chama _resetStacksParaPadrao internamente).
    paineisNaoEnchidosAtual = [];
    palletTypes = [item.montagem?.pallet1, item.montagem?.pallet2, item.montagem?.pallet3, item.montagem?.pallet4];
    slabConfig  = {};
    updateMountTypeDropdown();
    // bug: sq-batteryId é um <select> com só 13 <option>s fixas no HTML,
    // mas o cadastro de baterias é dinâmico — uma avaliação salva pode
    // referenciar uma bateria fora dessa lista. Atribuir .value direto
    // (como antes) falha em silêncio quando não existe <option>
    // correspondente: o campo fica vazio/errado e registerEvaluation
    // recusa salvar a correção por "faltar" o ID da bateria, mesmo a
    // avaliação já tendo uma. _selecionarBateriaNoForm injeta a <option>
    // que falta antes de selecionar (mesma correção já usada em
    // _prefillFromOperacao, acima).
    _selecionarBateriaNoForm(item.batteryId || 'B1');
    document.getElementById('sq-turno').value        = item.turno    || '';
    document.getElementById('sq-temp').value         = item.tempInput || '';
    document.getElementById('sq-dtMontagem').value   = fmtDTL(item.dtMontagem);
    document.getElementById('sq-dtEnchimento').value = fmtDTL(item.dtEnchimento);
    document.getElementById('sq-dtDesmoldagem').value= fmtDTL(item.dtDesmoldagem);
    document.getElementById('sq-obs').value          = item.observations || '';
    refreshPalletInfos();
    actionHistory = [];
    document.getElementById('sq-thickness').value = item.totalSlabs / 4;
    autoSetThickness(); // reseta pra base 4 — a reconstrução real (linha abaixo) vem por cima, com pallets extras inclusos

    // Reconstrói pallets extras (se houve algum) direto dos PAINÉIS já
    // persistidos — não precisa de nenhum campo novo salvo na avaliação
    // pra isso: cada painel já carrega seu "pallet" (nº, pode ser >4) e
    // "posicao" (ver evalObj.paineis, registerEvaluation), então dá pra
    // recompor extraStacks/stackCounts sem mudar o formato salvo no
    // banco. tipoEsperado de cada painel também é restaurado pra
    // slabConfig — sem isso, reabrir uma avaliação com placa arrastada
    // (tipo "fixado" na placa, não no pallet — ver _moverPainel) mostraria
    // o tipo errado até a pessoa mexer em algo que force um re-render.
    const paineisDaAvaliacao = d.paineis.filter(p => p.avaliacaoId === item.id);
    const ns = {}, nm = {}, nd = {}, novoSlabConfig = {}, novasContagens = { stack1: 0, stack2: 0, stack3: 0, stack4: 0 };
    paineisDaAvaliacao.forEach(p => {
      const sid = `stack${p.pallet}`;
      const id  = `${sid}-${p.posicao}`;
      ns[id] = p.marcas;
      if (p.motivo) nm[id] = p.motivo;
      if (p.motivo === 'OT' && p.motivoDescricao) nd[id] = p.motivoDescricao;
      if (p.tipoEsperado) novoSlabConfig[id] = p.tipoEsperado;
      novasContagens[sid] = Math.max(novasContagens[sid] || 0, p.posicao);
    });
    slabState     = ns;
    slabMotivo    = nm;
    slabMotivoDescricao = nd;
    slabConfig    = novoSlabConfig;
    stackCounts   = novasContagens;
    extraStacks   = Object.keys(novasContagens)
      .map(sid => parseInt(sid.replace('stack', '')))
      .filter(n => n > 4)
      .sort((a, b) => a - b);
    proximoNumeroPalletExtra = extraStacks.length ? Math.max(...extraStacks) + 1 : 5;
    actionHistory = [];
    _sincronizarColunasExtras();
    renderStacks();
    validateAllSlabs();
    calculateCureTime();
  }

  function viewHistoryRecord(evId) {
    const d    = getData();
    const item = d.avaliacoes.find(e => e.id === evId);
    if (!item) { showAlert('Erro','Não encontrado.'); return; }
    viewSource = 'history';
    _carregarAvaliacaoNoFormulario(item);
    setEditable(false);
    viewMode = true;
    navigateTo('form');
  }

  // Abre a mesma avaliação mostrada no Espelho Visual, EDITÁVEL, pra
  // corrigir algum erro de lançamento — só Administrador (mesma trava
  // usada em Editar Operação, app-core.js). Ao "Registrar" de novo,
  // registerEvaluation() detecta _editandoAvaliacaoId e SALVA POR CIMA
  // do mesmo registro (mesmo id), em vez de criar um novo — mantendo a
  // data original de registro (só a correção fica marcada em
  // "editadoEm", pro histórico continuar ordenado pela data real do
  // evento, não pela data do conserto).
  function editarAvaliacaoDoEspelho() {
    if (sessionStorage.getItem('lw_role') !== 'Administrador') return;
    const item = dashboardEvals[mirrorIndex];
    if (!item) return;
    showConfirm(
      'Editar Avaliação',
      `Isso abre a avaliação de "${item.batteryId || 'N/I'}" para correção. Ao salvar, o registro original é substituído. Continuar?`,
      () => {
        _carregarAvaliacaoNoFormulario(item);
        viewSource = 'dashboard';
        _editandoAvaliacaoId      = item.id;
        _editandoRegistradoEm     = item.registeredAt || null;
        _editandoLinkedOperacaoId = item.linkedOperacaoId || null;
        _editandoAvaliadorNome    = item.avaliadorNome || null;
        setEditable(true);
        // Mesma trava do lançamento novo: os dados vieram da operação
        // real na hora do registro original, corrigir aqui não deveria
        // divergir deles — só o que a Qualidade de fato controla
        // (temperatura, datas de montagem/desmoldagem, observações,
        // marcação das placas) fica editável na correção.
        _bloquearCamposAutoPreenchidos(true);
        _aplicarModoBotoesForm();
        navigateTo('form');
      }
    );
  }

  function exitViewMode()  { viewMode = false; setEditable(true); }

  function setEditable(editable) {
    // Perfis sem a área 'qualidade' de edição (ver lib/perfis.js — hoje,
    // Operador de Injetora e Manutenção) nunca ficam editáveis aqui, nem
    // que algum fluxo interno peça setEditable(true): o Setor de
    // Qualidade fica só como visualização pra eles. O servidor valida de
    // novo em POST /registrar-avaliacao-qualidade e
    // /marcar-operacao-avaliada, isso aqui é só a parte visual.
    const permiteEdicao = typeof _perfilPodeEditar === 'function' ? _perfilPodeEditar('qualidade') : true;
    if (!permiteEdicao) editable = false;
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
  // Data de referência de uma avaliação — voltou a ser a Data/Hora de
  // DESMOLDAGEM (ver conversa que motivou a mudança), não mais a de
  // registro no sistema (item.registeredAt, que é só "quando alguém
  // preencheu o formulário", pode ser bem depois da bateria já ter
  // saído da forma). Fallback pra registeredAt só quando dtDesmoldagem
  // não foi preenchida (campo não obrigatório, ver
  // page-setor-qualidade.html) — sem isso, registros antigos ou
  // incompletos sumiriam de listas ordenadas/filtradas por data em vez
  // de aparecer no fim/início. Usada por renderHistory() e
  // renderDashboard() (+ export), abaixo — a MESMA data em toda tela do
  // Setor de Qualidade que mostra/filtra "quando" uma avaliação
  // aconteceu.
  function _dataReferenciaAvaliacao(item) {
    return item.dtDesmoldagem || item.registeredAt;
  }

  function renderHistory() {
    const d       = getData();
    const search  = (document.getElementById('sq-hist-search').value || '').toLowerCase();
    const turno   = document.getElementById('sq-hist-turno').value;
    const sd      = document.getElementById('sq-hist-start')?.value || '';
    const ed      = document.getElementById('sq-hist-end')?.value || '';
    const filtered = d.avaliacoes.filter(item => {
      if (item.excluidaDaFila) return false;
      if (!(item.batteryId||'').toLowerCase().includes(search)) return false;
      if (turno && item.turno !== turno) return false;
      const dt = new Date(_dataReferenciaAvaliacao(item));
      if (sd && dt < new Date(sd)) return false;
      if (ed && dt > new Date(ed + 'T23:59:59')) return false;
      return true;
    }).sort((a, b) => new Date(_dataReferenciaAvaliacao(b)) - new Date(_dataReferenciaAvaliacao(a)));

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
        <td>${new Date(_dataReferenciaAvaliacao(item)).toLocaleString('pt-BR')}</td>
        <td><strong>${item.batteryId||'N/I'}</strong></td>
        <td style="color:#66bb6a;font-weight:700;">${item.montagem?.pallet1||'—'}</td>
        <td style="color:#42a5f5;font-weight:700;">${item.montagem?.pallet2||'—'}</td>
        <td style="color:#ab47bc;font-weight:700;">${item.montagem?.pallet3||'—'}</td>
        <td style="color:#ffa726;font-weight:700;">${item.montagem?.pallet4||'—'}</td>
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
  // Quantas placas o PALETE `pallet` teve de verdade nesta avaliação —
  // olha os painéis salvos de verdade (ver registerEvaluation:
  // evalObj.paineis tem 1 entrada por posição que existiu no momento do
  // registro, já refletindo qualquer remoção de painel "não enchido" ou
  // de lado só parcialmente cheio — ver conversa que motivou isso: "o
  // espelho e a análise focada não estão refletindo paletes com painéis
  // a menos"). Antes disso, getSlabCount(bid) era uma função MOCADA —
  // devolvia um número fixo (11/8/10) direto do ID da bateria, sem olhar
  // pra avaliação salva nenhuma — todo palete sempre aparecia com a
  // MESMA contagem, mesmo quando um deles tinha 1 painel a menos.
  function _totalPorPalletMirror(panels, pallet) {
    const posicoes = panels.filter(p => p.pallet === pallet).map(p => p.posicao);
    return posicoes.length ? Math.max(...posicoes) : 0;
  }

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
      // "Painel não preenchido" (marca X, ver COR_NAO_PREENCHIDO) — sempre
      // sozinha, sempre cinza fixo. Visualmente diferente do × de "Não
      // avaliado no sistema" (sq-mini-mark-nao-avaliado, acima: texto solto,
      // sem fundo) de propósito — são conceitos diferentes (aqui é uma
      // marcação real feita pelo avaliador, lá é a bateria inteira que
      // nunca chegou a ser avaliada) e o hover/title já deixa isso explícito.
      if (m.shape === 'x')
        return `<span class="sq-mini-mark sq-mini-mark-x" title="Painel não preenchido">×</span>`;
      const w = m.shape==='dash' ? '12px' : '6px', h = m.shape==='dash' ? '2px' : '6px';
      const r = m.shape==='circle' ? '50%' : '2px';
      const varMap = { verde:'--sq-cor-verde', vermelho:'--sq-cor-vermelho', azul:'--sq-cor-azul', amarelo:'--sq-cor-amarelo', laranja:'--sq-cor-laranja', cinza:'--sq-cor-identificacao-auto' };
      return `<span class="sq-mini-mark" style="background:var(${varMap[m.color]||'--sq-cor-verde'});width:${w};height:${h};border-radius:${r};margin:0 1px;display:inline-block;"></span>`;
    }).join('');
  }

  function renderMirror(index) {
    const container = document.getElementById('sq-mirror-container');
    const counter   = document.getElementById('sq-mirror-counter');
    const btnEditar = document.getElementById('sq-mirror-btn-editar');
    if (!dashboardEvals.length) {
      container.innerHTML = `<div class="sq-empty" style="padding:20px;"><i class="fas fa-inbox"></i>Nenhuma avaliação.</div>`;
      ['sq-mirror-battery','sq-mirror-turno','sq-mirror-desmoldagem'].forEach(id => { const el=document.getElementById(id); if(el) el.textContent='---'; });
      document.getElementById('sq-mirror-prev').disabled = true;
      document.getElementById('sq-mirror-next').disabled = true;
      counter.textContent = '0 / 0';
      if (btnEditar) btnEditar.style.display = 'none';
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
    if (btnEditar) btnEditar.style.display = sessionStorage.getItem('lw_role') === 'Administrador' ? 'inline-flex' : 'none';

    const cm = { SP:'sp','2P':'p2','3T':'t3','1T':'t1' };
    let html = '<div class="sq-mini-stacks">';
    // Ordem visual pedida: Pallet 2/Pallet 1 na 1ª linha, Pallet 3/Pallet 4
    // na 2ª (layout 2x2, mesma ordem da grade principal — ver
    // .sq-pallet-col[data-pallet-id] em setor-qualidade.css). Só a ORDEM
    // DE EXIBIÇÃO muda; os dados de cada pallet continuam vindo do mesmo
    // número de sempre.
    [2, 1, 3, 4].forEach(p => {
      const n = _totalPorPalletMirror(panels, p); // cada palete com a contagem DELE, não uma média/fixo compartilhado
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
        const tituloMotivo = panel?.motivo === 'OT'
          ? (panel.motivoDescricao || 'Outros (sem descrição)')
          : (_MOTIVO_POR_CODIGO[panel?.motivo] || panel?.motivo);
        const motivoHtml = panel?.motivo
          ? `<span class="sq-mini-slab-motivo${_linhaDoPainel(panel) === '2ª' ? ' sq-mini-slab-motivo-2linha' : ''}" title="${_escaparHtml(tituloMotivo)}">${_escaparHtml(panel.motivo)}</span>`
          : '';
        // Mesmo raciocínio de renderStacks (grade principal) — mostra o
        // berço de origem quando a avaliação salva tem
        // capacidadeOperacao gravado (ver registerEvaluation);
        // avaliação legada, sem esse campo, cai de volta no índice
        // simples de sempre.
        const berco = _bercoDoSlot(p, i, item.capacidadeOperacao);
        const rotulo = berco ? ('B' + berco) : i;
        // Motivo + tipo agrupados num wrapper só (.sq-mini-slab-canto-info,
        // mesma ideia da grade principal — ver .sq-slab-canto-info,
        // renderStacks) — sem isso, o motivo entrava como mais um item
        // solto no flex do mini-slab e ENCOLHIA o espaço reservado pra
        // .sq-mini-slab-marks (flex:1), fazendo as marcas ficarem
        // desalinhadas entre placas com e sem código de motivo. Com o
        // wrapper, a largura do canto direito muda, mas .sq-mini-slab-marks
        // continua centralizada no espaço restante do mesmo jeito nas duas
        // situações (marcas viram o único item central, sempre).
        const cantoInfo = `<span class="sq-mini-slab-canto-info">${motivoHtml}${tipo?`<span class="sq-mini-slab-type ${cm[tipo]||''}">${tipo}</span>`:''}</span>`;
        html += `<div class="sq-mini-slab"><span class="sq-mini-slab-number">${rotulo}</span><div class="sq-mini-slab-marks">${getMirrorMark(panel)}</div>${cantoInfo}</div>`;
      }
      html += '</div>';
    });
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

  /* ── Gráficos do dashboard em SVG puro — substitui Chart.js/<canvas> ──
     Antes cada gráfico era um <canvas> redesenhado via Chart.js — 2
     dependências externas (chart.js + chartjs-plugin-datalabels) e uma
     instância pra gerenciar/destruir a cada re-render (ver destroyChart,
     que existia só por causa disso). Na prática o canvas se mostrava
     pouco confiável aqui (textos sumindo, gráfico não redesenhando
     direito ao trocar o filtro, PDF exportado com pedaços em branco —
     html2canvas tem dificuldade justamente com <canvas> aninhado,
     melhor com SVG/HTML puro). Os gráficos abaixo são só string SVG/HTML
     montada aqui e jogada via innerHTML — sem canvas, sem instância pra
     destruir, sem dependência externa nenhuma. Tooltip vem de
     data-tooltip (mesmo balão estilizado do resto do sistema — ver
     tooltip.js — funciona em <circle>/<rect> normalmente, não só em
     elementos HTML) — ANTES usava <title> nativo do SVG, mas esse é o
     tooltip cinza sem estilo do próprio navegador, sem contraste
     garantido com o tema e sem funcionar em toque. */

  const SVG_W = 600, SVG_H = 220; // viewBox de referência — os containers são <div>, escalam via width="100%".

  // "2026-01-05" → "05/01" — só pro eixo X de datas, sem depender de LW.
  // Não é por causa do iframe (não roda mais num) — é porque esta função
  // também é embutida via toString() no HTML standalone exportado (ver
  // exportDashboardHTML/_gerarHtmlDashboardStandalone, mais abaixo), que
  // continua sendo um arquivo à parte, sem acesso a LW nenhum.
  function _fmtDataEixo(iso) {
    const p = String(iso).split('-');
    return p.length === 3 ? `${p[2]}/${p[1]}` : String(iso);
  }

  // Linha/área — "📈 Evolução da Produção".
  function _svgLineChart(labels, values) {
    const w = SVG_W, h = SVG_H, padL = 34, padR = 14, padT = 14, padB = 28;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const max = Math.max(1, ...values);
    const n = labels.length;
    const stepX = n > 1 ? plotW / (n - 1) : 0;
    const pts = values.map((v, i) => ({
      x: padL + (n > 1 ? i * stepX : plotW / 2),
      y: padT + plotH - (v / max) * plotH,
      v, label: labels[i],
    }));
    const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L${pts[pts.length - 1].x.toFixed(1)},${(padT + plotH).toFixed(1)} L${pts[0].x.toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
    // No máx. ~6 rótulos no eixo X (sempre com o 1º e o último) — pra
    // não empilhar texto ilegível quando há muitos dias no período.
    const passo = Math.max(1, Math.ceil(n / 6));
    const xLabels = pts.map((p, i) => (i === 0 || i === n - 1 || i % passo === 0)
      ? `<text x="${p.x.toFixed(1)}" y="${h - 8}" font-size="9" fill="var(--text-3)" text-anchor="middle">${_escaparHtml(_fmtDataEixo(p.label))}</text>` : '').join('');
    const gridLines = [0, 0.25, 0.5, 0.75, 1].map(f => {
      const y = padT + plotH * (1 - f);
      return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>` +
        `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" font-size="9" fill="var(--text-3)" text-anchor="end">${Math.round(max * f)}</text>`;
    }).join('');
    const dots = pts.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="var(--blue)" style="cursor:help" data-tooltip="${_escaparAtributo(_fmtDataEixo(p.label))}: ${p.v}"/>`).join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="280" preserveAspectRatio="xMidYMid meet">
      ${gridLines}
      <path d="${areaPath}" fill="rgba(59,130,246,0.12)" stroke="none"/>
      <path d="${linePath}" fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${xLabels}
    </svg>`;
  }

  // Rosca (donut) — "📊 Distribuição das Classificações". items:
  // [{label, value, color}]. Desenha com <circle>s empilhados via
  // stroke-dasharray/dashoffset (técnica clássica de donut em SVG puro,
  // sem calcular arco/path à mão) + legenda em HTML logo abaixo.
  function _svgDonutChart(items) {
    const total = items.reduce((s, it) => s + it.value, 0) || 1;
    const r = 78, cx = 120, cy = 120, strokeW = 40, circ = 2 * Math.PI * r;
    let acc = 0;
    const arcs = items.map(it => {
      const frac = it.value / total;
      const dash = frac * circ;
      const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${it.color}" stroke-width="${strokeW}"
        stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}" stroke-dashoffset="${(-acc * circ).toFixed(2)}"
        transform="rotate(-90 ${cx} ${cy})" style="cursor:help" data-tooltip="${_escaparAtributo(it.label)}: ${it.value} (${(frac * 100).toFixed(1)}%)"/>`;
      acc += frac;
      return el;
    }).join('');
    const legenda = items.map(it => `
      <div style="display:flex;align-items:center;gap:7px;font-size:.85rem;color:var(--text-2)">
        <span style="width:12px;height:12px;border-radius:50%;background:${it.color};display:inline-block;flex-shrink:0"></span>
        ${_escaparHtml(it.label)} <span style="color:var(--text-3)">(${it.value})</span>
      </div>`).join('');
    return `
      <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;justify-content:center">
        <svg viewBox="0 0 240 240" width="210" height="210">${arcs}</svg>
        <div style="display:flex;flex-direction:column;gap:7px;flex:1;min-width:140px">${legenda}</div>
      </div>`;
  }

  // Barras verticais — "🏷️ Painéis por Tipo".
  function _svgBarChart(labels, values, colors) {
    const w = SVG_W, h = SVG_H, padL = 30, padR = 14, padT = 14, padB = 26;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const max = Math.max(1, ...values);
    const n = labels.length || 1;
    const gap = (plotW / n) * 0.3;
    const barW = (plotW / n) - gap;
    const bars = labels.map((lb, i) => {
      const v = values[i] || 0;
      const bh = (v / max) * plotH;
      const x = padL + i * (plotW / n) + gap / 2;
      const y = padT + plotH - bh;
      const color = (colors && colors[i]) || 'var(--blue)';
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" fill="${color}" style="cursor:help" data-tooltip="${_escaparAtributo(String(lb))}: ${v}"/>
        <text x="${(x + barW / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="10" font-weight="700" fill="var(--text-2)" text-anchor="middle">${v}</text>
        <text x="${(x + barW / 2).toFixed(1)}" y="${h - 8}" font-size="9" fill="var(--text-3)" text-anchor="middle">${_escaparHtml(String(lb))}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="280" preserveAspectRatio="xMidYMid meet">
      <line x1="${padL}" y1="${(padT + plotH).toFixed(1)}" x2="${w - padR}" y2="${(padT + plotH).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
      ${bars}
    </svg>`;
  }

  // Barras horizontais — "🔴 Taxa de Refugo por Tipo" e "🏭 Baterias com
  // Mais Refugo". opts.max fixa a escala (ex: 100 pra percentual); sem
  // isso, usa o maior valor da própria lista. opts.suffix só decora o
  // rótulo (ex: '%'), não afeta a escala.
  function _svgHBarChart(labels, values, opts = {}) {
    const w = SVG_W, rowH = 34, padL = 100, padR = 50, padT = 8;
    const n = labels.length || 1;
    const h = padT * 2 + rowH * n;
    const plotW = w - padL - padR;
    const max = opts.max || Math.max(1, ...values);
    const color = opts.color || 'var(--red)';
    const suffix = opts.suffix || '';
    const rows = labels.map((lb, i) => {
      const v = values[i] || 0;
      const bw = Math.max(0, (v / max) * plotW);
      const y = padT + i * rowH;
      return `
        <text x="${padL - 8}" y="${(y + rowH / 2 + 4).toFixed(1)}" font-size="13" fill="var(--text-2)" text-anchor="end">${_escaparHtml(String(lb))}</text>
        <rect x="${padL}" y="${(y + 5).toFixed(1)}" width="${bw.toFixed(1)}" height="${rowH - 10}" rx="3" fill="${color}" style="cursor:help" data-tooltip="${_escaparAtributo(String(lb))}: ${v}${suffix}"/>
        <text x="${(padL + bw + 6).toFixed(1)}" y="${(y + rowH / 2 + 4).toFixed(1)}" font-size="13" font-weight="700" fill="var(--text-2)">${v}${suffix}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${Math.min(h, 320)}" preserveAspectRatio="xMidYMid meet">${rows}</svg>`;
  }

  // Ranking de "Principais Motivos" (🔷 Motivos — 2ª Linha / 🔴 Motivos —
  // Reprovação) — mesmo estilo visual (lista de cards, não barra) do
  // ranking "🎯 Defeitos por Posição" acima, só que agrupado por CÓDIGO DE
  // MOTIVO (slabMotivo/MOTIVOS_DEFEITO) em vez de posição no pallet.
  // Painéis SEM motivo (aprovado 1ª linha — nunca exige motivo, ver
  // _corExigeMotivo) não entram aqui: já são filtrados por quem chama
  // (paineisFiltrados, abaixo). corBarra é só a cor do número à direita —
  // azul pro ranking de 2ª linha, vermelho pro de reprovação — mesma
  // convenção de cor usada no resto do dashboard (donut de classificações,
  // KPIs).
  function _rankingMotivosHTML(paineisFiltrados, corBarra) {
    const porMotivo = {};
    paineisFiltrados.forEach(p => {
      const codigo = p.motivo || 'SM'; // "SM" = Sem Motivo — não deveria acontecer (motivo é obrigatório pra essas cores), mas evita sumir do ranking se algum registro legado não tiver
      if (!porMotivo[codigo]) porMotivo[codigo] = 0;
      porMotivo[codigo]++;
    });
    const total = paineisFiltrados.length;
    const rnk = Object.entries(porMotivo)
      .map(([codigo, n]) => ({
        codigo,
        nome: codigo === 'SM' ? 'Sem motivo registrado' : (_MOTIVO_POR_CODIGO[codigo] || codigo),
        n,
        pct: total ? (n / total) * 100 : 0,
      }))
      .sort((a, b) => b.n - a.n || a.nome.localeCompare(b.nome))
      .slice(0, 10);
    if (!rnk.length) {
      return '<div style="color:var(--text-3);text-align:center;padding:20px;font-size:.82rem;">Nenhum painel nesta classificação no período.</div>';
    }
    return '<div style="display:flex;flex-direction:column;gap:8px;">' + rnk.map(r => `
      <div style="background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius);padding:8px 12px;display:flex;justify-content:space-between;align-items:center;font-size:.8rem;" data-tooltip="${_escaparAtributo(r.nome)}">
        <span><strong>${_escaparHtml(r.codigo)}</strong> — ${_escaparHtml(r.nome)}</span>
        <span style="font-family:var(--font-mono);color:${corBarra};font-weight:700;">${r.n} <span style="color:var(--text-3);font-weight:400;">(${r.pct.toFixed(0)}%)</span></span>
      </div>`).join('') + '</div>';
  }

  // Dispersão (scatter) + linha de tendência opcional — "⏳ Tempo de
  // Pega × Refugo". points: [{x, y, label}]; trendPoints: [{x,y},{x,y}]
  // (reta) ou null.
  function _svgScatterChart(points, trendPoints) {
    if (!points.length) {
      return `<div style="color:var(--text-3);text-align:center;padding:40px 0;font-size:.82rem">Sem dados suficientes no período.</div>`;
    }
    const w = SVG_W, h = SVG_H, padL = 34, padR = 14, padT = 14, padB = 34;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const minX = Math.min(0, ...xs), maxX = Math.max(1, ...xs);
    const minY = 0, maxY = Math.max(1, ...ys);
    const sx = x => padL + ((x - minX) / ((maxX - minX) || 1)) * plotW;
    const sy = y => padT + plotH - ((y - minY) / ((maxY - minY) || 1)) * plotH;
    const gridY = [0, 0.5, 1].map(f => {
      const y = padT + plotH * (1 - f);
      return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
        <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" font-size="9" fill="var(--text-3)" text-anchor="end">${Math.round(minY + (maxY - minY) * f)}</text>`;
    }).join('');
    const dots = points.map(p => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="5" fill="var(--blue)" fill-opacity="0.8" style="cursor:help" data-tooltip="${_escaparAtributo(p.label || '')}"/>`).join('');
    const trend = (trendPoints && trendPoints.length === 2)
      ? `<line x1="${sx(trendPoints[0].x).toFixed(1)}" y1="${sy(trendPoints[0].y).toFixed(1)}" x2="${sx(trendPoints[1].x).toFixed(1)}" y2="${sy(trendPoints[1].y).toFixed(1)}" stroke="var(--red)" stroke-width="2" stroke-dasharray="5 4"/>`
      : '';
    const xTicks = [minX, (minX + maxX) / 2, maxX].map(x => `<text x="${sx(x).toFixed(1)}" y="${h - 18}" font-size="9" fill="var(--text-3)" text-anchor="middle">${x.toFixed(1)}h</text>`).join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="280" preserveAspectRatio="xMidYMid meet">
      ${gridY}
      <line x1="${padL}" y1="${(padT + plotH).toFixed(1)}" x2="${w - padR}" y2="${(padT + plotH).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
      ${trend}
      ${dots}
      ${xTicks}
      <text x="${(padL + plotW / 2).toFixed(1)}" y="${h - 4}" font-size="9" fill="var(--text-3)" text-anchor="middle">Tempo de Pega (h)</text>
    </svg>`;
  }

  // Barras agrupadas — "✅ Aprovação vs Reprovação por Bateria". series:
  // [{name, color, values}] (2 séries, 1 grupo de barras por bateria).
  function _svgGroupedBarChart(labels, series) {
    const w = SVG_W, h = SVG_H, padL = 30, padR = 14, padT = 14, padB = 26;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const max = Math.max(1, ...series.flatMap(s => s.values));
    const n = labels.length || 1;
    const groupW = plotW / n;
    const sideMargin = groupW * 0.15, barGap = 2;
    const barW = (groupW - sideMargin * 2 - barGap * (series.length - 1)) / series.length;
    const bars = labels.map((lb, i) => {
      const gx = padL + i * groupW + sideMargin;
      const barsHtml = series.map((s, si) => {
        const v = s.values[i] || 0;
        const bh = (v / max) * plotH;
        const x = gx + si * (barW + barGap);
        const y = padT + plotH - bh;
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${s.color}" style="cursor:help" data-tooltip="${_escaparAtributo(String(lb))} — ${_escaparAtributo(s.name)}: ${v}"/>`;
      }).join('');
      return `${barsHtml}<text x="${(gx + (groupW - sideMargin * 2) / 2).toFixed(1)}" y="${h - 8}" font-size="9" fill="var(--text-3)" text-anchor="middle">${_escaparHtml(String(lb))}</text>`;
    }).join('');
    const legenda = series.map(s => `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px"><span style="width:11px;height:11px;border-radius:2px;background:${s.color};display:inline-block"></span><span style="font-size:.85rem;color:var(--text-3)">${_escaparHtml(s.name)}</span></span>`).join('');
    return `
      <div style="text-align:center;margin-bottom:6px">${legenda}</div>
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="260" preserveAspectRatio="xMidYMid meet">
        <line x1="${padL}" y1="${(padT + plotH).toFixed(1)}" x2="${w - padR}" y2="${(padT + plotH).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>
        ${bars}
      </svg>`;
  }

  /* ── Dashboard ────────────────────────────────────────── */
  function renderDashboard() {
    const d    = getData();
    const sd   = document.getElementById('sq-dash-start').value;
    const ed   = document.getElementById('sq-dash-end').value;
    const bf   = document.getElementById('sq-dash-bat').value;

    // "Excluída da fila" (ver _excluirOperacaoDaFila) grava uma avaliação
    // de verdade só pra deixar rastro auditável no banco — TODOS os
    // painéis dela vêm com resultado 'nao_avaliado_no_sistema', nunca
    // aprovado/reprovado. O Dashboard é sobre o que FOI avaliado (KPIs,
    // produção, classificações) — por isso essas entram fora daqui desde
    // o filtro inicial (marcador `excluidaDaFila`, gravado só nesse
    // evento), como se não existissem no período: sem isso, "Painéis
    // Avaliados"/"Total Registros" ficavam inflados com painéis que a
    // própria avaliação diz que NUNCA foram avaliados, "Evolução Diária"
    // contava produção que não existiu, e "Distribuição das
    // Classificações" ganhava uma fatia solta "null nao_avaliado_no_
    // sistema" (tipoObtido é sempre null nesses painéis). Registros (aba
    // separada) usa o MESMO filtro (ver renderHistory) — esses itens não
    // são avaliações de verdade (não têm nem "montagem"), só um marcador
    // interno de que a bateria saiu da fila sem ser avaliada.
    const fe = d.avaliacoes.filter(item => {
      if (item.excluidaDaFila) return false;
      const dt = new Date(_dataReferenciaAvaliacao(item));
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
      <div class="kpi-card green"><div class="kpi-label">Painéis Aprovados</div><div class="kpi-value green" style="font-size:1.8rem;">${apr}</div></div>
      <div class="kpi-card red"><div class="kpi-label">Painéis Reprovados</div><div class="kpi-value red" style="font-size:1.8rem;">${rep}</div></div>
      <div class="kpi-card"><div class="kpi-label">Taxa de Aprovação</div><div class="kpi-value accent" style="font-size:1.8rem;">${ar}%</div></div>
      <div class="kpi-card red"><div class="kpi-label">Taxa de Reprovação</div><div class="kpi-value red" style="font-size:1.8rem;">${rr}%</div></div>`;

    /* Evolução diária */
    const dp = {};
    fe.forEach(e => { const dk = new Date(e.dtMontagem||e.registeredAt).toISOString().slice(0,10); dp[dk]=(dp[dk]||0)+d.paineis.filter(p=>p.avaliacaoId===e.id).length; });
    const pl = Object.keys(dp).sort(), pv = pl.map(k => dp[k]);
    document.getElementById('sq-chart-production').innerHTML = _svgLineChart(pl.length ? pl : ['Sem dados'], pl.length ? pv : [0]);

    /* Distribuição das classificações — "(2ª linha)" vira fatia própria
       quando p.linha==='2ª' (ver getClassifiedInfo/_linhaDoAprovado); não
       mexe no valor de p.resultado, só no rótulo usado aqui pra separar
       visualmente aprovados de 1ª dos de 2ª linha. */
    const cc = {}; fp.forEach(p => { const k = `${p.tipoObtido} ${p.resultado}${_linhaDoPainel(p) === '2ª' ? ' (2ª linha)' : ''}`; cc[k]=(cc[k]||0)+1; });
    const ql = Object.keys(cc), qv = Object.values(cc);
    const cmap = { 'SP aprovado':'#4d8dff','SP reprovado':'#ff6b6b','2P aprovado':'#a78bfa','2P reprovado':'#d45d79','3T aprovado':'#f1c40f','3T reprovado':'#f39c12','1T aprovado':'#2ed3a3','1T reprovado':'#d35400' };
    const corSegunda = 'var(--sq-cor-azul)';
    const donutItems = ql.length
      ? ql.map((l, i) => ({ label: l, value: qv[i], color: l.includes('2ª linha') ? corSegunda : (cmap[l] || 'var(--border-2)') }))
      : [{ label: 'Sem dados', value: 1, color: 'var(--border-2)' }];
    document.getElementById('sq-chart-quality').innerHTML = _svgDonutChart(donutItems);

    /* Taxa de refugo por tipo */
    const tt2={SP:0,'2P':0,'3T':0,'1T':0}, tr2={SP:0,'2P':0,'3T':0,'1T':0};
    fp.forEach(p => { if (p.tipoEsperado && tt2[p.tipoEsperado]!==undefined) { tt2[p.tipoEsperado]++; if(p.resultado==='reprovado') tr2[p.tipoEsperado]++; } });
    const vtl = Object.keys(tt2).filter(k=>tt2[k]>0);
    document.getElementById('sq-chart-rejections').innerHTML = _svgHBarChart(
      vtl.length ? vtl : ['Nenhum'],
      vtl.length ? vtl.map(k => Number(((tr2[k]/tt2[k])*100).toFixed(1))) : [0],
      { max: 100, suffix: '%', color: 'var(--red)' }
    );

    /* Total por tipo */
    const tc={SP:0,'2P':0,'3T':0,'1T':0}; fp.forEach(p=>{if(p.tipoEsperado&&tc[p.tipoEsperado]!==undefined)tc[p.tipoEsperado]++;});
    document.getElementById('sq-chart-tipo').innerHTML = _svgBarChart(
      Object.keys(tc), Object.values(tc), ['var(--blue)','var(--sq-purple)','var(--sq-yellow)','var(--sq-orange)']
    );

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

    /* Principais Motivos — 2ª Linha (azul) / Reprovação (vermelho) —
       mesmo filtro de período/exclusão já aplicado em fp (linha ~3006);
       aqui só separa por resultado+linha antes de passar pro ranking. */
    document.getElementById('sq-chart-motivos-azul').innerHTML =
      _rankingMotivosHTML(fp.filter(p => _linhaDoPainel(p) === '2ª'), 'var(--sq-cor-azul)');
    document.getElementById('sq-chart-motivos-vermelho').innerHTML =
      _rankingMotivosHTML(fp.filter(p => p.resultado === 'reprovado'), 'var(--red)');

    /* Baterias com mais refugo */
    const br={};fe.forEach(e=>{const n=d.paineis.filter(p=>p.avaliacaoId===e.id&&p.resultado==='reprovado').length;if(n)br[e.batteryId]=(br[e.batteryId]||0)+n;});
    const sb=Object.keys(br).sort((a,b)=>br[b]-br[a]).slice(0,10);
    document.getElementById('sq-chart-bat-refugo').innerHTML = _svgHBarChart(
      sb.length ? sb : ['Nenhuma'],
      sb.length ? sb.map(k => br[k]) : [0],
      { color: 'var(--sq-orange)' }
    );

    /* Scatter: tempo de pega × refugo */
    const sc=[];
    fe.forEach(e=>{if(e.dtEnchimento&&e.dtDesmoldagem){const diff=new Date(e.dtDesmoldagem)-new Date(e.dtEnchimento);if(diff>0){const h=diff/3600000,refs=d.paineis.filter(p=>p.avaliacaoId===e.id&&p.resultado==='reprovado').length;sc.push({x:h,y:refs,label:`Bat:${e.batteryId} | ${h.toFixed(1)}h | ${refs} refugos`});}}});
    let trd=[];
    if(sc.length>1){const n=sc.length,sx=sc.reduce((a,b)=>a+b.x,0),sy=sc.reduce((a,b)=>a+b.y,0),sxy=sc.reduce((a,b)=>a+b.x*b.y,0),sx2=sc.reduce((a,b)=>a+b.x*b.x,0),den=n*sx2-sx*sx,m=(n*sxy-sx*sy)/den,b=(sy-m*sx)/n,maxX=Math.max(...sc.map(pt=>pt.x)),minX=Math.min(...sc.map(pt=>pt.x));trd=[{x:minX,y:m*minX+b},{x:maxX,y:m*maxX+b}];}
    document.getElementById('sq-chart-tempo-pega').innerHTML = _svgScatterChart(sc, trd.length ? trd : null);

    /* Aprovação vs reprovação por bateria */
    const bd={};fe.forEach(e=>{if(!bd[e.batteryId])bd[e.batteryId]={a:0,r:0};d.paineis.filter(p=>p.avaliacaoId===e.id).forEach(p=>{if(p.resultado==='aprovado')bd[e.batteryId].a++;else if(p.resultado==='reprovado')bd[e.batteryId].r++;});});
    const bl=Object.keys(bd);
    document.getElementById('sq-chart-approval-bat').innerHTML = _svgGroupedBarChart(
      bl.length ? bl : ['Sem dados'],
      [
        { name: 'Aprovados', color: 'var(--green)', values: bl.length ? bl.map(k => bd[k].a) : [0] },
        { name: 'Reprovados', color: 'var(--red)', values: bl.length ? bl.map(k => bd[k].r) : [0] },
      ]
    );

    /* Resumo */
    let summ=`Avaliados <b>${fp.length}</b> painéis em <b>${fe.length}</b> registros. `;
    if(seg) summ+=`<b>${seg}</b> aprovado${seg>1?'s':''} de 2ª linha. `;
    if(rnk.length){const rx=rnk[0];summ+=`Maior recorrência: <b>${rx.batteryId} · Pallet ${rx.pallet} · Posição ${rx.posicao}</b> (${rx.d}/${rx.N}, ${rx.taxa.toFixed(0)}%).`;}
    else if(fe.length) summ+='Nenhum ponto de recorrência significativo detectado.';
    else summ='Nenhum dado disponível para o período.';
    document.getElementById('sq-dash-summary').innerHTML = summ;
  }

  // Descreve o período/filtro aplicado no momento — usado tanto no
  // cabeçalho impresso do PDF quanto no subtítulo do dashboard exportado
  // em HTML, pra o arquivo se explicar sozinho sem depender da tela.
  function _descricaoPeriodoAtual() {
    const sd = document.getElementById('sq-dash-start').value;
    const ed = document.getElementById('sq-dash-end').value;
    const bf = document.getElementById('sq-dash-bat').value;
    const periodo = (sd || ed)
      ? `${sd ? new Date(sd + 'T00:00:00').toLocaleDateString('pt-BR') : 'início'} até ${ed ? new Date(ed + 'T00:00:00').toLocaleDateString('pt-BR') : 'hoje'}`
      : 'Todos os registros';
    return `Período: ${periodo}${bf ? ' · Bateria: ' + bf : ''}`;
  }

  /* ── Exportar PDF ─────────────────────────────────────────
     Ajustado pra virar um relatório de verdade, não uma captura de tela
     crua: os controles interativos (filtros + os próprios botões de
     exportar) somem da captura — não fazem sentido dentro de um PDF
     estático, só poluíam a imagem — e ganha um cabeçalho impresso
     (título + período aplicado + data de geração) que só existe durante
     a captura, pro arquivo final se explicar sozinho. */
  async function exportDashboardPDF() {
    const btn     = document.getElementById('sq-btn-pdf');
    const acoes   = document.getElementById('sq-dash-acoes');
    const filtros = document.getElementById('sq-dash-filtros');
    const dash    = document.getElementById('sq-dashboard');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Gerando…'; btn.disabled = true;

    const cabecalho = document.createElement('div');
    cabecalho.style.cssText = 'padding:0 0 14px;margin-bottom:14px;border-bottom:2px solid var(--blue);';
    cabecalho.innerHTML = `
      <div style="font-size:1.3rem;font-weight:700;color:var(--text);">📋 Relatório de Qualidade — Avaliação de Baterias</div>
      <div style="font-size:.8rem;color:var(--text-3);margin-top:4px;">${_escaparHtml(_descricaoPeriodoAtual())} · Gerado em ${new Date().toLocaleString('pt-BR')}</div>`;

    if (acoes)   acoes.style.display   = 'none';
    if (filtros) filtros.style.display = 'none';
    dash.insertBefore(cabecalho, dash.firstChild);

    try {
      const canvas = await html2canvas(dash, { scale:2, backgroundColor:'#ffffff', useCORS:true, logging:false, scrollX:0, scrollY:-window.scrollY });
      const { jsPDF } = window.jspdf;
      const w = 297, h = Math.ceil((canvas.height * w) / canvas.width);
      const pdf = new jsPDF({ orientation:'landscape', unit:'mm', format:[w,h] });
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, w, h);
      pdf.save(`relatorio_qualidade_${new Date().toISOString().replace(/[-:T.]/g,'').slice(0,14)}.pdf`);
    } catch (err) {
      console.error(err); showAlert('Erro','Falha ao gerar PDF.');
    } finally {
      cabecalho.remove();
      if (acoes)   acoes.style.display   = '';
      if (filtros) filtros.style.display = '';
      btn.innerHTML = '<i class="fas fa-file-pdf"></i> Exportar PDF'; btn.disabled = false;
    }
  }

  /* ── Exportar Dashboard Interativo (HTML standalone) ───────
     Diferente do PDF (imagem estática), gera 1 arquivo .html AUTOSSU-
     FICIENTE: dados (avaliações + painéis já embutidos, cada avaliação
     com sua lista de painéis, mesmo formato de /avaliacoes-qualidade),
     as mesmas funções de gráfico SVG puro (cópia fiel de _svgLineChart/
     _svgDonutChart/_svgBarChart/_svgHBarChart/_svgScatterChart/
     _svgGroupedBarChart, sem nenhuma dependência externa) e os mesmos
     filtros (Data Inicial/Final, Bateria) — tudo recalculado no
     JavaScript do PRÓPRIO arquivo exportado, sem precisar do servidor.
     Quem abrir esse .html em qualquer navegador consegue trocar o
     período/bateria e ver os gráficos recalcularem na hora, exatamente
     como na tela ao vivo — só não leva "Espelho Visual" (é sobre revisar
     UMA avaliação específica, não faz sentido fora do contexto do
     formulário) nem os botões de exportar (um export não reexporta a
     si mesmo).

     Exclui avaliações "excluídaDaFila" (ver renderDashboard — mesmo
     critério: painéis marcados 'nao_avaliado_no_sistema' não contam
     como avaliados) ANTES de embutir, pra não precisar duplicar essa
     regra dentro do script exportado. */
  async function exportDashboardHTML() {
    const btn = document.getElementById('sq-btn-html');
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Gerando…'; btn.disabled = true;
    try {
      await carregarAvaliacoesQualidade(); // garante dataset atualizado antes de embutir
      // MESMO filtro que está valendo no dashboard na tela agora (ver
      // renderDashboard, acima) — período (sq-dash-start/end) e bateria
      // (sq-dash-bat) — não mais TODAS as avaliações. Exclui
      // "excluídaDaFila" pelo mesmo motivo de sempre (não são avaliações
      // de verdade).
      const sd = document.getElementById('sq-dash-start').value;
      const ed = document.getElementById('sq-dash-end').value;
      const bf = document.getElementById('sq-dash-bat').value;
      const avaliacoes = getData().avaliacoes.filter(item => {
        if (item.excluidaDaFila) return false;
        const dt = new Date(_dataReferenciaAvaliacao(item));
        return (!sd || dt >= new Date(sd)) &&
               (!ed || dt <= new Date(ed + 'T23:59:59')) &&
               (!bf || item.batteryId === bf);
      });
      const html = _gerarHtmlDashboardStandalone(avaliacoes, _descricaoPeriodoAtual());

      const blob = new Blob([html], { type: 'text/html' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = `dashboard_qualidade_${new Date().toISOString().replace(/[-:T.]/g,'').slice(0,14)}.html`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Falha ao exportar dashboard interativo:', err);
      showAlert('Erro', 'Não consegui gerar o dashboard interativo agora.');
    } finally {
      btn.innerHTML = '<i class="fas fa-file-code"></i> Exportar Interativo'; btn.disabled = false;
    }
  }

  // Cópia standalone da parte de "hover em elemento [data-tooltip]" de
  // tooltip.js (delegação no document, desktop + toque) — os gráficos SVG
  // deste dashboard (_svgLineChart/_svgDonutChart/etc.) marcam cada ponto/
  // fatia/barra com data-tooltip="texto", mas esse atributo sozinho não
  // mostra nada sem ALGUÉM ouvindo hover/toque em [data-tooltip] e
  // desenhando o balão — é o que tooltip.js faz na tela ao vivo. Sem
  // embutir isso aqui, o arquivo exportado tinha os atributos mas nenhum
  // tooltip aparecia de verdade ao passar o mouse. Só a parte de
  // [data-tooltip] (não a de canvas — ligarHoverCanvas — que esta tela
  // não usa, é só SVG).
  const _TOOLTIP_DATA_ATTR_JS = `
  (function () {
    let tooltipEl = null, alvoAtivo = null, ultimoToque = 0;
    function _el() {
      if (tooltipEl) return tooltipEl;
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'lw-tooltip';
      document.body.appendChild(tooltipEl);
      return tooltipEl;
    }
    function _posicionar(x, y) {
      const tt = _el();
      const margem = 12;
      let left = x + margem, top = y + margem;
      const w = tt.offsetWidth, h = tt.offsetHeight;
      if (left + w > window.innerWidth - 8) left = x - margem - w;
      if (top + h > window.innerHeight - 8) top = y - margem - h;
      if (left < 8) left = 8;
      if (top < 8) top = 8;
      tt.style.left = left + 'px';
      tt.style.top = top + 'px';
    }
    function mostrarTexto(texto, x, y) {
      if (!texto) { esconder(); return; }
      const tt = _el();
      tt.textContent = texto;
      tt.style.display = 'block';
      _posicionar(x, y);
    }
    function _mostrarDoElemento(alvo, x, y) {
      const texto = alvo.getAttribute('data-tooltip');
      if (!texto) return;
      mostrarTexto(texto, x, y);
      alvoAtivo = alvo;
    }
    function esconder() {
      if (tooltipEl) tooltipEl.style.display = 'none';
      alvoAtivo = null;
    }
    document.addEventListener('mouseover', (e) => {
      if (Date.now() - ultimoToque < 700) return;
      const alvo = e.target.closest('[data-tooltip]');
      if (alvo) _mostrarDoElemento(alvo, e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', (e) => {
      if (!alvoAtivo) return;
      if (e.target.closest('[data-tooltip]') === alvoAtivo) _posicionar(e.clientX, e.clientY);
    });
    document.addEventListener('mouseout', (e) => {
      if (alvoAtivo && e.target.closest('[data-tooltip]') === alvoAtivo) esconder();
    });
    document.addEventListener('touchstart', (e) => {
      ultimoToque = Date.now();
      const alvo = e.target.closest('[data-tooltip]');
      if (!alvo) { esconder(); return; }
      if (alvoAtivo === alvo) { esconder(); return; }
      const t = e.touches[0];
      _mostrarDoElemento(alvo, t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('[data-tooltip]')) esconder();
    });
    window.addEventListener('scroll', esconder, true);
    window.addEventListener('resize', esconder);
  })();
`;

  // Monta o HTML standalone inteiro (string) — ver comentário de
  // exportDashboardHTML, acima. `avaliacoes` já vem filtrado (mesmo
  // período/bateria da tela, sem excluídas da fila) — RETRATO fixo do que
  // estava na tela no momento da exportação, não tem mais campos de
  // filtro pra reaplicar depois (ver comentário abaixo, onde o antigo
  // bloco ".filtros" com inputs foi trocado por um chip só de leitura).
  // Cada item mantém sua própria lista `.paineis` (mesmo formato salvo em
  // avaliacoes_qualidade.dados, db.js), então não precisa embutir uma 2ª
  // lista de painéis separada — o script exportado usa flatMap nelas,
  // igual a este arquivo faz em carregarAvaliacoesQualidade().
  function _gerarHtmlDashboardStandalone(avaliacoes, descricaoPeriodo) {
    // "</script" dentro de uma string do JSON quebraria o parser de HTML
    // no meio do <script> — escapa a barra pra nunca fechar a tag sem
    // querer (a barra invertida é removida de novo pelo JSON.parse no
    // próprio navegador que abrir o arquivo, então o dado continua
    // idêntico ao original).
    const dadosJson = JSON.stringify(avaliacoes).replace(/<\/script/gi, '<\\/script');
    const geradoEm  = new Date().toISOString();

    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard de Qualidade — Exportado</title>
<style>${LW.gerarCssExportPadrao()}
  /* 3 cores específicas desta tela, sem equivalente no restante do app
     (ver mesma lista em css/setor-qualidade.css) — kpi-grid, chart-box,
     filtro-aplicado, .lw-tooltip etc. já vêm todos prontos do bloco
     acima (mesmo CSS-base compartilhado com os outros dashboards
     exportáveis, ver LW.gerarCssExportPadrao em data.js). */
  :root { --sq-orange:#f5821f; --sq-yellow:#f1c40f; --sq-purple:#8b5cf6;
    --sq-cor-verde:var(--green); --sq-cor-vermelho:var(--red); --sq-cor-azul:var(--blue); }
</style>
</head>
<body>
  <h1>📋 Relatório de Qualidade — Avaliação de Baterias</h1>
  <div class="sub" id="exp-sub">Gerado em ${new Date(geradoEm).toLocaleString('pt-BR')}</div>
  <div class="filtro-aplicado">📅 Filtro aplicado: <b>${_escaparHtml(descricaoPeriodo)}</b></div>

  <div class="kpi-grid" id="exp-kpi"></div>

  <div class="charts-grid">
    <div class="chart-box"><h4>🏷️ Painéis por Tipo</h4><div id="exp-chart-tipo"></div></div>
    <div class="chart-box"><h4>📈 Evolução da Produção</h4><div id="exp-chart-producao"></div></div>
    <div class="chart-box"><h4>📊 Distribuição das Classificações</h4><div id="exp-chart-qualidade"></div></div>
    <div class="chart-box"><h4>🎯 Defeitos por Posição</h4><div id="exp-chart-posicao"></div></div>
    <div class="chart-box"><h4>🏭 Baterias com Mais Refugo</h4><div id="exp-chart-refugo-bat"></div></div>
    <div class="chart-box"><h4>🔴 Taxa de Refugo por Tipo (%)</h4><div id="exp-chart-refugo-tipo"></div></div>
    <div class="chart-box"><h4>⏳ Tempo de Pega × Refugo</h4><div id="exp-chart-tempo-pega"></div></div>
    <div class="chart-box"><h4>✅ Aprovação vs Reprovação por Bateria</h4><div id="exp-chart-aprov-bat"></div></div>
  </div>

  <div class="summary-box"><strong>Resumo &amp; Insights</strong><p id="exp-summary" style="margin:8px 0 0"></p></div>
  <div class="rodape">Exportado do Setor de Qualidade — Lightwall SC · retrato do filtro aplicado no momento da exportação, dados embutidos neste arquivo, funciona offline.</div>

<script>${_TOOLTIP_DATA_ATTR_JS}</script>
<script>
(function () {
  'use strict';
  const DADOS      = ${dadosJson};

  function _escaparHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }
  function _fmtDataEixo(iso) {
    const p = String(iso).split('-');
    return p.length === 3 ? \`\${p[2]}/\${p[1]}\` : String(iso);
  }
  function _linhaDoAprovado(marks) {
    const circles = marks.filter(m => m.shape === 'circle');
    const dashes  = marks.filter(m => m.shape === 'dash');
    const corAprovacao = circles.length ? circles[0].color : (dashes.length ? dashes[0].color : null);
    if (corAprovacao === 'verde') return '1ª';
    if (corAprovacao === 'azul')  return '2ª';
    return null;
  }
  function _linhaDoPainel(p) {
    if (p.linha !== undefined) return p.linha;
    return p.marcas ? _linhaDoAprovado(p.marcas) : null;
  }

  const SVG_W = 600, SVG_H = 220;

  ${_escaparAtributo}
  ${_svgLineChart}
  ${_svgDonutChart}
  ${_svgBarChart}
  ${_svgHBarChart}
  ${_svgScatterChart}
  ${_svgGroupedBarChart}

  function atualizar() {
    const fe = DADOS;
    const fp = fe.flatMap(e => e.paineis || []);

    const apr = fp.filter(p => p.resultado==='aprovado').length;
    const rep = fp.filter(p => p.resultado==='reprovado').length;
    const seg = fp.filter(p => _linhaDoPainel(p)==='2ª').length;
    const tt  = apr + rep;
    const ar  = tt ? ((apr/tt)*100).toFixed(1) : 0;
    const rr  = tt ? ((rep/tt)*100).toFixed(1) : 0;

    document.getElementById('exp-kpi').innerHTML = \`
      <div class="kpi-card"><div class="kpi-label">Total Registros</div><div class="kpi-value">\${fe.length}</div></div>
      <div class="kpi-card"><div class="kpi-label">Painéis Avaliados</div><div class="kpi-value green">\${fp.length}</div></div>
      <div class="kpi-card"><div class="kpi-label">Painéis 2ª Linha</div><div class="kpi-value" style="color:var(--sq-cor-azul)">\${seg}</div></div>
      <div class="kpi-card"><div class="kpi-label">Painéis Aprovados</div><div class="kpi-value green">\${apr}</div></div>
      <div class="kpi-card"><div class="kpi-label">Painéis Reprovados</div><div class="kpi-value red">\${rep}</div></div>
      <div class="kpi-card"><div class="kpi-label">Taxa de Aprovação</div><div class="kpi-value accent">\${ar}%</div></div>
      <div class="kpi-card"><div class="kpi-label">Taxa de Reprovação</div><div class="kpi-value red">\${rr}%</div></div>\`;

    const dp = {};
    fe.forEach(e => { const dk = new Date(e.dtMontagem||e.registeredAt).toISOString().slice(0,10); dp[dk]=(dp[dk]||0)+(e.paineis||[]).length; });
    const pl = Object.keys(dp).sort(), pv = pl.map(k => dp[k]);
    document.getElementById('exp-chart-producao').innerHTML = _svgLineChart(pl.length ? pl : ['Sem dados'], pl.length ? pv : [0]);

    const cc = {}; fp.forEach(p => { const k = \`\${p.tipoObtido} \${p.resultado}\${_linhaDoPainel(p) === '2ª' ? ' (2ª linha)' : ''}\`; cc[k]=(cc[k]||0)+1; });
    const ql = Object.keys(cc), qv = Object.values(cc);
    const cmap = { 'SP aprovado':'#4d8dff','SP reprovado':'#ff6b6b','2P aprovado':'#a78bfa','2P reprovado':'#d45d79','3T aprovado':'#f1c40f','3T reprovado':'#f39c12','1T aprovado':'#2ed3a3','1T reprovado':'#d35400' };
    const corSegunda = 'var(--sq-cor-azul)';
    const donutItems = ql.length
      ? ql.map((l, i) => ({ label: l, value: qv[i], color: l.includes('2ª linha') ? corSegunda : (cmap[l] || 'var(--border-2)') }))
      : [{ label: 'Sem dados', value: 1, color: 'var(--border-2)' }];
    document.getElementById('exp-chart-qualidade').innerHTML = _svgDonutChart(donutItems);

    const tt2={SP:0,'2P':0,'3T':0,'1T':0}, tr2={SP:0,'2P':0,'3T':0,'1T':0};
    fp.forEach(p => { if (p.tipoEsperado && tt2[p.tipoEsperado]!==undefined) { tt2[p.tipoEsperado]++; if(p.resultado==='reprovado') tr2[p.tipoEsperado]++; } });
    const vtl = Object.keys(tt2).filter(k=>tt2[k]>0);
    document.getElementById('exp-chart-refugo-tipo').innerHTML = _svgHBarChart(
      vtl.length ? vtl : ['Nenhum'],
      vtl.length ? vtl.map(k => Number(((tr2[k]/tt2[k])*100).toFixed(1))) : [0],
      { max: 100, suffix: '%', color: 'var(--red)' }
    );

    const tc={SP:0,'2P':0,'3T':0,'1T':0}; fp.forEach(p=>{if(p.tipoEsperado&&tc[p.tipoEsperado]!==undefined)tc[p.tipoEsperado]++;});
    document.getElementById('exp-chart-tipo').innerHTML = _svgBarChart(
      Object.keys(tc), Object.values(tc), ['var(--blue)','var(--sq-purple)','var(--sq-yellow)','var(--sq-orange)']
    );

    const bec={};fe.forEach(e=>{bec[e.batteryId]=(bec[e.batteryId]||0)+1;});
    const dm={};
    fp.forEach(p=>{if(p.resultado==='reprovado'){const ev=fe.find(e=>(e.paineis||[]).includes(p));if(ev){const k=\`\${ev.batteryId}|P\${p.pallet}|Pos\${p.posicao}\`;if(!dm[k])dm[k]={batteryId:ev.batteryId,pallet:p.pallet,posicao:p.posicao,d:0};dm[k].d++;}}});
    const rnk=Object.values(dm).map(r=>({...r,N:bec[r.batteryId]||0,taxa:bec[r.batteryId]?(r.d/bec[r.batteryId])*100:0})).filter(r=>r.d>=3&&r.taxa>=30).sort((a,b)=>b.taxa-a.taxa||b.d-a.d).slice(0,10);
    const pc = document.getElementById('exp-chart-posicao');
    pc.innerHTML = rnk.length ? '<div style="display:flex;flex-direction:column;gap:8px;">' + rnk.map(r=>{
      const cor = r.taxa>=40?'var(--red)':r.taxa>=20?'var(--accent)':'var(--green)';
      return \`<div style="background:var(--bg-1);border:1px solid var(--border);border-radius:var(--radius);padding:8px 12px;display:flex;justify-content:space-between;align-items:center;font-size:.8rem;">
        <span><strong>\${r.batteryId}</strong> · P\${r.pallet} · Pos \${r.posicao}</span>
        <span style="font-family:var(--font-mono);color:\${cor};font-weight:700;">\${r.taxa.toFixed(0)}% <span style="color:var(--text-3);font-weight:400;">(\${r.d}/\${r.N})</span></span></div>\`;
    }).join('') + '</div>' : '<div style="color:var(--text-3);text-align:center;padding:20px;font-size:.82rem;">Nenhum ponto de recorrência significativo (D≥3 e taxa≥30%).</div>';

    const br={};fe.forEach(e=>{const n=(e.paineis||[]).filter(p=>p.resultado==='reprovado').length;if(n)br[e.batteryId]=(br[e.batteryId]||0)+n;});
    const sb=Object.keys(br).sort((a,b)=>br[b]-br[a]).slice(0,10);
    document.getElementById('exp-chart-refugo-bat').innerHTML = _svgHBarChart(
      sb.length ? sb : ['Nenhuma'],
      sb.length ? sb.map(k => br[k]) : [0],
      { color: 'var(--sq-orange)' }
    );

    const sc=[];
    fe.forEach(e=>{if(e.dtEnchimento&&e.dtDesmoldagem){const diff=new Date(e.dtDesmoldagem)-new Date(e.dtEnchimento);if(diff>0){const h=diff/3600000,refs=(e.paineis||[]).filter(p=>p.resultado==='reprovado').length;sc.push({x:h,y:refs,label:\`Bat:\${e.batteryId} | \${h.toFixed(1)}h | \${refs} refugos\`});}}});
    let trd=[];
    if(sc.length>1){const n=sc.length,sx=sc.reduce((a,b)=>a+b.x,0),sy=sc.reduce((a,b)=>a+b.y,0),sxy=sc.reduce((a,b)=>a+b.x*b.y,0),sx2=sc.reduce((a,b)=>a+b.x*b.x,0),den=n*sx2-sx*sx,m=(n*sxy-sx*sy)/den,b=(sy-m*sx)/n,maxX=Math.max(...sc.map(pt=>pt.x)),minX=Math.min(...sc.map(pt=>pt.x));trd=[{x:minX,y:m*minX+b},{x:maxX,y:m*maxX+b}];}
    document.getElementById('exp-chart-tempo-pega').innerHTML = _svgScatterChart(sc, trd.length ? trd : null);

    const bd={};fe.forEach(e=>{if(!bd[e.batteryId])bd[e.batteryId]={a:0,r:0};(e.paineis||[]).forEach(p=>{if(p.resultado==='aprovado')bd[e.batteryId].a++;else if(p.resultado==='reprovado')bd[e.batteryId].r++;});});
    const bl=Object.keys(bd);
    document.getElementById('exp-chart-aprov-bat').innerHTML = _svgGroupedBarChart(
      bl.length ? bl : ['Sem dados'],
      [
        { name: 'Aprovados', color: 'var(--green)', values: bl.length ? bl.map(k => bd[k].a) : [0] },
        { name: 'Reprovados', color: 'var(--red)', values: bl.length ? bl.map(k => bd[k].r) : [0] },
      ]
    );

    let summ=\`Avaliados <b>\${fp.length}</b> painéis em <b>\${fe.length}</b> registros. \`;
    if(seg) summ+=\`<b>\${seg}</b> aprovado\${seg>1?'s':''} de 2ª linha. \`;
    if(rnk.length){const rx=rnk[0];summ+=\`Maior recorrência: <b>\${rx.batteryId} · Pallet \${rx.pallet} · Posição \${rx.posicao}</b> (\${rx.d}/\${rx.N}, \${rx.taxa.toFixed(0)}%).\`;}
    else if(fe.length) summ+='Nenhum ponto de recorrência significativo detectado.';
    else summ='Nenhum dado disponível para o período.';
    document.getElementById('exp-summary').innerHTML = summ;
  }

  atualizar();
})();
</script>
</body>
</html>`;
  }

  /* ── Utilitários do formulário ────────────────────────── */
  function toISO(val) { return val ? new Date(val).toISOString() : null; }
  function fmtDTL(iso) { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toISOString().slice(0,16); }

  function applyFormData(d) {
    // Mesma correção de _carregarAvaliacaoNoFormulario (ver comentário lá):
    // rascunho salvo pode referenciar uma bateria fora das <option>s fixas
    // do HTML — sem isso, reabrir o rascunho perderia o ID da bateria em
    // silêncio.
    _selecionarBateriaNoForm(d.batteryId || 'B1');
    linkedOperacaoId = d.linkedOperacaoId || null;
    // Rascunhos não preservam capacidadeOperacaoAtual entre sessões (ver
    // comentário na declaração da variável) — sem operação real recarregada,
    // não faz sentido reaplicar remoção de painéis "não enchidos" de uma
    // sessão anterior que porventura ainda esteja em memória.
    paineisNaoEnchidosAtual = [];
    palletTypes = d.palletTypes  || ['','','',''];
    updateMountTypeDropdown();
    document.getElementById('sq-dailySeq').value     = d.dailySeq  || '1';
    document.getElementById('sq-turno').value        = d.turno     || '1° TURNO';
    document.getElementById('sq-temp').value         = d.tempInput || '';
    document.getElementById('sq-dtMontagem').value   = fmtDTL(d.dtMontagem);
    document.getElementById('sq-dtEnchimento').value = fmtDTL(d.dtEnchimento);
    document.getElementById('sq-dtDesmoldagem').value= fmtDTL(d.dtDesmoldagem);
    document.getElementById('sq-obs').value          = d.observations || '';
    document.getElementById('sq-thickness').value    = d.slabsPerPallet || 10;
    // Placas, marcas, medições e pallets extras NÃO são restaurados aqui
    // de propósito — quem chama applyFormData ainda vai chamar
    // autoSetThickness() (ver loadDraft/viewDraft), que reseta a grade
    // pro padrão de 4 pallets; restaurar esse estado ANTES disso faria
    // autoSetThickness apagar tudo de novo. Ver _restaurarEstadoDoRascunho,
    // chamada DEPOIS de autoSetThickness nos dois lugares.
  }

  // Restaura placas/marcas/medições/pallets extras de um rascunho — SEMPRE
  // chamada depois de autoSetThickness() (ver loadDraft/viewDraft), nunca
  // antes: autoSetThickness reseta a grade pro padrão de 4 pallets (ver
  // _resetStacksParaPadrao), o que apagaria qualquer pallet extra e as
  // placas nele se isto rodasse primeiro. Compatível com rascunhos
  // salvos ANTES desta funcionalidade existir (sem extraStacks/
  // stackCounts salvos) — cai de volta pro padrão de 4 pallets com "n"
  // (slabsPerPallet) cada, igual sempre funcionou.
  function _restaurarEstadoDoRascunho(d) {
    extraStacks = Array.isArray(d.extraStacks) ? [...d.extraStacks] : [];
    proximoNumeroPalletExtra = extraStacks.length ? Math.max(...extraStacks) + 1 : 5;
    const n = d.slabsPerPallet || parseInt(document.getElementById('sq-thickness').value) || 10;
    stackCounts = d.stackCounts || { stack1: n, stack2: n, stack3: n, stack4: n };
    _sincronizarColunasExtras(); // cria as colunas extras (com medição padrão) antes de sobrescrever com os valores salvos
    if (d.palletInfos) {
      [1, 2, 3, 4, ...extraStacks].forEach(p => {
        if (!d.palletInfos[p]) return;
        ['comprimento','largura','linearidade','espessura','esquadro'].forEach(f => {
          const el = document.getElementById(`sq-p${p}-${f}`);
          if (el) el.innerText = d.palletInfos[p][f] || defaultPalletInfo(f);
        });
      });
    }
    slabState     = d.slabState || {};
    slabMotivo    = d.slabMotivo || {};
    slabMotivoDescricao = d.slabMotivoDescricao || {};
    slabConfig    = d.slabConfig || {};
    actionHistory = [];
    renderStacks();
    validateAllSlabs();
  }

  function defaultPalletInfo(field) {
    const bid = document.getElementById('sq-batteryId')?.value || '';
    if (field === 'comprimento') return '3m';
    if (field === 'largura')     return '61cm';
    if (field === 'espessura')   return dimensaoOperacaoAtual || _espessuraDaBateria(bid);
    return 'ok';
  }

  // Ajusta os botões de ação do formulário conforme está ou não editando
  // uma avaliação já registrada (ver editarAvaliacaoDoEspelho): esconde
  // "Salvar" (rascunho — não faz sentido pra uma correção), troca o
  // texto de "Registrar" pra "Salvar Alteração", e mostra "Cancelar".
  //
  // Também desabilita "Registrar" (com título explicando o motivo)
  // quando NÃO está editando e não há operação vinculada — reforço
  // visual da trava de avaliação avulsa (a trava de verdade é no
  // servidor, ver POST /registrar-avaliacao-qualidade; isto aqui só
  // evita a pessoa preencher a bateria inteira pra só então descobrir,
  // no "Registrar", que precisava ter escolhido da fila).
  function _aplicarModoBotoesForm() {
    const editando  = !!_editandoAvaliacaoId;
    const btnSalvar = document.getElementById('sq-btn-save');
    const btnReg    = document.getElementById('sq-btn-register');
    const btnCancel = document.getElementById('sq-btn-cancelar-edicao');
    if (btnSalvar) btnSalvar.style.display = editando ? 'none' : '';
    if (btnReg)    btnReg.innerHTML = editando
      ? '<i class="fas fa-check-circle"></i> Salvar Alteração'
      : '<i class="fas fa-check-circle"></i> Registrar';
    if (btnCancel) btnCancel.style.display = editando ? '' : 'none';

    const semFila = !editando && !linkedOperacaoId;
    if (btnReg) {
      btnReg.disabled = semFila;
      btnReg.title = semFila
        ? 'Selecione uma bateria em "Ordem de Previsão de Desemplaque" antes de registrar — avaliação avulsa não é mais permitida.'
        : '';
    }
  }


  // Sai da edição SEM salvar nada — o registro original no banco nunca
  // chegou a ser tocado (só foi lido, pra preencher o formulário), então
  // não precisa desfazer nada no servidor: só descarta o que está na
  // tela e volta pra onde a edição foi aberta (Dashboard).
  function cancelarEdicaoAvaliacao() {
    if (!_editandoAvaliacaoId) { navigateTo(viewSource); return; }
    showConfirm(
      'Cancelar Edição',
      'Sair sem salvar? As alterações feitas nesta tela serão descartadas — o registro original continua exatamente como estava.',
      () => {
        const destino = viewSource;
        clearForm();
        navigateTo(destino);
      }
    );
  }

  function clearForm() {
    slabState = {}; slabMotivo = {}; slabMotivoDescricao = {}; actionHistory = []; palletTypes = ['','','','']; slabConfig = {};
    extraStacks = []; stackCounts = { stack1: 0, stack2: 0, stack3: 0, stack4: 0 }; proximoNumeroPalletExtra = 5;
    linkedOperacaoId = null;
    dimensaoOperacaoAtual = null;
    capacidadeOperacaoAtual = null;
    paineisNaoEnchidosAtual = [];
    _editandoAvaliacaoId = null;
    _editandoRegistradoEm = null;
    _editandoLinkedOperacaoId = null;
    _editandoAvaliadorNome = null;
    _aplicarModoBotoesForm();
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
    _bloquearCamposAutoPreenchidos(true); // sempre travado — ver comentário na função, acima
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

  // Espessura real da operação sendo avaliada — vem de op.dimensao (a
  // dimensão de verdade gravada na OPERAÇÃO, ver coluna operacoes.dimensao,
  // db.js — pode ter sido corrigida manualmente ali via "✏️ Definir uma
  // dimensão específica pra esta operação", em Registrar Operação, então
  // não necessariamente bate com o padrão cadastrado da bateria).
  // null enquanto nenhuma operação real foi carregada ainda (ex: avaliação
  // avulsa legada, ou form recém-limpo) — nesse caso quem preenche a
  // Espessura é só o palpite de _espessuraDaBateria (abaixo), até a
  // operação de verdade ser carregada e corrigir com o valor real (mesmo
  // padrão de "palpite, depois corrige com o real" já usado pro nº de
  // placas por pallet — ver _definirThicknessReal/_prefillFromOperacao).
  let dimensaoOperacaoAtual = null;

  // Capacidade (nº de berços CONFIGURADO da bateria, nunca bercos_reais)
  // usada só pra determinar em qual palete cada painel cai — ver
  // _paleteDoBerco/_bercoDoSlot, mais abaixo. Segue o MESMO padrão de
  // dimensaoOperacaoAtual, acima: null até uma operação real ser
  // carregada (_prefillFromOperacao) ou uma avaliação salva ser reaberta
  // (_carregarAvaliacaoNoFormulario, que restaura de
  // item.capacidadeOperacao — gravado no momento do registro, ver
  // registerEvaluation). Rascunhos (localStorage) NÃO preservam este
  // valor entre sessões — mesma limitação já existente pra
  // dimensaoOperacaoAtual (não é regressão desta mudança); a grade só
  // volta a numerar por berço quando a operação é recarregada.
  let capacidadeOperacaoAtual = null;

  // Berços marcados "🚫 Não Enchido" (Bateria Atual, ver bateria-atual.js)
  // da operação atualmente carregada — snapshot cru de op.bercos_visuais
  // (ver GET /operacoes-nao-avaliadas), guardado aqui (não só aplicado uma
  // vez no prefill) porque _resetStacksParaPadrao() é chamada de novo toda
  // vez que o Tipo de Montagem muda (ver changeMountType) ou a Espessura
  // muda (ver autoSetThickness) — sem guardar e REAPLICAR a cada reset, a
  // 1ª troca de Tipo de Montagem depois do prefill devolveria os painéis
  // "não enchidos" pra grade (bug real, pego por
  // test/setor-qualidade-paineis-nao-enchidos.test.js). Mesmo padrão de
  // "null até uma operação real ser carregada" de capacidadeOperacaoAtual,
  // acima — resetado em clearForm() junto com o resto.
  let paineisNaoEnchidosAtual = [];

  // Aceita tanto "15cm" (sem espaço — formato de bateria.label, ver
  // cfgAdicionarBateria, app-core.js) quanto "9,5 cm" (com espaço —
  // formato de dimensão manual da operação, ver _formatarDimensaoLive,
  // operacao.js) e sempre devolve normalizado como "X cm".
  function _normalizarEspessuraTexto(txt) {
    if (!txt) return null;
    const numero = String(txt).replace(/cm/i, '').trim();
    return numero ? `${numero} cm` : null;
  }

  // Grava a dimensão real da operação carregada e já atualiza a Espessura
  // dos 4 pallets com ela — chamada assim que a operação de verdade é
  // conhecida (ver _prefillFromOperacao) ou ao reabrir uma avaliação já
  // registrada (ver _carregarAvaliacaoNoFormulario, que usa o valor salvo
  // na própria avaliação, evalObj.dimensaoOperacao).
  function _definirEspessuraReal(dimensaoTexto) {
    const esp = _normalizarEspessuraTexto(dimensaoTexto);
    if (!esp) return;
    dimensaoOperacaoAtual = esp;
    for (let p = 1; p <= 4; p++) {
      const el = document.getElementById(`sq-p${p}-espessura`);
      if (el) el.innerText = esp;
    }
  }

  // Palpite de reserva, usado só ENQUANTO a operação real ainda não foi
  // carregada (ex: form recém-aberto, antes de escolher uma bateria da
  // fila) — nunca é a fonte de verdade quando dimensaoOperacaoAtual já
  // está definida (ver refreshPalletInfos/defaultPalletInfo, abaixo).
  function _espessuraDaBateria(bid) {
    const bateria = (LW.BATERIA_IDS || []).find(b => b.id === bid);
    if (bateria?.label) {
      const esp = _normalizarEspessuraTexto(bateria.label);
      if (esp) return esp;
    }
    // Sem cadastro encontrado (instalação antiga, ou ID ainda não
    // sincronizado) — reserva pros 2 IDs legados de dimensão fixa que
    // existiam antes de "Dimensão (em cm)" virar campo editável.
    return bid === 'B5-7.5' ? '7,5 cm' : bid === 'B6-12' ? '12 cm' : '9 cm';
  }

  function autoSetThickness() {
    const id  = document.getElementById('sq-batteryId').value;
    const sel = document.getElementById('sq-thickness');
    sel.value = id==='B5-7.5' ? '11' : id==='B6-12' ? '8' : '10';
    actionHistory = [];
    _resetStacksParaPadrao();
    renderStacks();
    refreshPalletInfos();
    validateAllSlabs();
  }

  // Só reseta as medições dos 4 pallets ORIGINAIS pros valores padrão —
  // pallets extras (ver _criarColunaMedicao) já nascem com o padrão na
  // hora de serem criados e não são recriados aqui, senão um arraste (que
  // não deveria mexer em medição nenhuma) acabaria apagando edições
  // manuais feitas na tela sempre que esta função for chamada de novo.
  function refreshPalletInfos() {
    const bid = document.getElementById('sq-batteryId').value;
    const esp = dimensaoOperacaoAtual || _espessuraDaBateria(bid);
    for (let p = 1; p <= 4; p++) {
      const set = (f, v) => { const el = document.getElementById(`sq-p${p}-${f}`); if (el) el.innerText = v; };
      set('comprimento','3m'); set('largura','61cm'); set('linearidade','ok');
      set('espessura', esp);   set('esquadro','ok');
    }
  }

  function editField(btn) {
    if (viewMode) return;
    if (btn.classList.contains('sq-info-edit-locked')) return; // Espessura travada — ver _bloquearCamposAutoPreenchidos
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
      slabMotivo = {};
      slabMotivoDescricao = {};
      document.querySelectorAll('.sq-slab-marks').forEach(c => { c.innerHTML = ''; });
      document.querySelectorAll('.sq-slab-motivo').forEach(b => { b.textContent = ''; b.style.display = 'none'; });
      validateAllSlabs();
    });
  }

  function undoLastAction() {
    if (viewMode) return;
    if (actionHistory.length) {
      const anterior = actionHistory.pop();
      slabState  = anterior.slabState;
      slabMotivo = anterior.slabMotivo;
      slabMotivoDescricao = anterior.slabMotivoDescricao || {};
      slabConfig   = anterior.slabConfig   || slabConfig;
      stackCounts  = anterior.stackCounts  || stackCounts;
      extraStacks  = anterior.extraStacks  || extraStacks;
      proximoNumeroPalletExtra = anterior.proximoNumeroPalletExtra || proximoNumeroPalletExtra;
      _sincronizarColunasExtras(); // remove/recria colunas de pallet extra pra bater com o extraStacks restaurado
      renderStacks(); validateAllSlabs();
    }
    else showAlert('Desfazer', 'Nada para desfazer.');
  }

  /* ── Modal genérico (usa o modal do Lightwall se disponível) */
  // Toast leve — avisos rápidos e não-bloqueantes (diferente de
  // showAlert, que é um modal e exige clicar OK). Usado por
  // engatilhamentos frequentes/esperados que não merecem interromper o
  // fluxo (ver toggleMark/toggleMarkErase: limite de marcas por placa,
  // nada pra apagar). Mesmo padrão de toast(), manutencao.js — arquivo
  // diferente, IIFE separada, sem colisão de nome.
  function toast(msg, tipo = 'success') {
    const container = document.getElementById('sq-toastContainer');
    if (!container) return; // container não existe (ex: tela ainda não montada) — silenciosamente ignora, não é crítico
    const t = document.createElement('div');
    t.className = `sq-toast ${tipo === 'error' ? 'error' : ''}`;
    t.innerHTML = `<span>${tipo === 'error' ? '<i class="fas fa-exclamation-circle"></i>' : '<i class="fas fa-check-circle"></i>'}</span><span>${_escaparHtml(msg)}</span>`;
    container.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

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
    editarAvaliacaoDoEspelho, cancelarEdicaoAvaliacao,
    iniciarAvaliacaoDaFila, iniciarAvaliacaoDoSelect,
    excluirDaFila, excluirDoSelect,
    carregarFilaNaoAvaliadas,
    saveDraft, loadDraft, deleteDraft, viewDraft,
    registerEvaluation, viewHistoryRecord,
    renderDashboard, renderHistory,
    prevMirror, nextMirror,
    exportDashboardPDF,
    exportDashboardHTML,
    selectColor, selectShape,
    toggleIndicadorAtivo,
    selectAllPallet, clearPallet,
    toggleCollapsible,
    togglePopover,
    undoLastAction, clearAllMarks,
    formatTemperature, calculateCureTime, autoSetThickness,
    editField,
    adicionarPalletExtra: _adicionarPalletExtra,
    removerPalletExtra: _removerPalletExtra,
    changeMountType,
    openPalletModal, closePalletModal, setModalTipo,
    clearModalPlates, confirmPalletModal,
    calcularMontagemDoRegistro: _montagemDoRegistro,
    getExpectedType,
    aplicarOrdemPaletes: _aplicarOrdemPaletes,
    init() {
      _carregarOpcoesMontagem();
      carregarAvaliacoesQualidade();
      _renderReferenciaMotivos();
      _aplicarOrdemPaletes();
      startNew();
    },
  };

})();