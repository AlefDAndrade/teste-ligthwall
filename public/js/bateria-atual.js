// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  bateria-atual.js — "Bateria Atual" (card sempre visível em
//  Registrar Operação, logo abaixo de Traços de Injeção)
//
//  Antes era um popover no topbar (clique pra abrir, funcionava em
//  qualquer página) — agora vive fixo nesta tela, sempre visível, sem
//  precisar clicar em nada.
//
//  DUAS FONTES DE DADOS, propositalmente separadas:
//   1) O RESUMO (bateria, tipo de montagem, berços reais) vem do estado
//      LOCAL de operacao.js — via window.LWBateriaAtual.atualizarComEstado
//      (chamada em cada mudança de formulário, ver operacao.js: persist()
//      e renderAll()). Assim o card aparece assim que a pessoa escolhe
//      Tipo de Bateria + Tipo de Montagem, SEM esperar apertar "▶ Iniciar
//      Injeção" — antes disso a operação ainda nem existe no servidor,
//      então buscar de lá não adiantaria.
//   2) As MARCAÇÕES dos berços (baixou/vazou) continuam vindo do servidor
//      (GET /bercos-andamento) — é uma marcação de observação, feita por
//      QUALQUER dispositivo olhando essa tela (ver POST
//      /marcar-berco-andamento), então precisa de sincronização entre
//      telas. Isso é buscado num intervalo (ver INTERVALO_SYNC_MARCACOES_MS)
//      mas SÓ redesenha o card se algo realmente mudou desde a última
//      vez (ver _renderSeMudou) — sem isso o card inteiro era reconstruído
//      a cada 5s mesmo sem nenhuma mudança real, dando a impressão de
//      ficar "recarregando" o tempo todo.
//
//  Mostra os berços da operação em andamento agora, no formato visual
//  reaproveitado da grade de Montagem Personalizada (ver operacao.js,
//  _renderGradeMontagem): célula colorida por tipo de montagem,
//  numerada por berço, em FILEIRA ÚNICA (1 2 3 4 5 6 7 8 ...), cada
//  célula "em pé" (indicador em cima, número no meio, indicador embaixo).
//
//  QUEM É CLICÁVEL: só os 2 indicadores (• no topo = direita, ● na base
//  = esquerda) — NÃO a célula inteira. Cada um marca/desmarca "baixou
//  ou vazou" de FORMA INDEPENDENTE (ver _baCliqueDot) — o berço 1 pode
//  ter só o lado direito marcado, só o esquerdo, os dois, ou nenhum.
//  Clique de novo no mesmo indicador reverte só aquele lado pra 'okay'.
//  Ver GET/POST /bercos-andamento (server.js) — snapshot separado do
//  resto da operação em andamento, transferido pra bercos_visuais (SQL,
//  2 linhas por berço — uma por lado) só quando a operação é registrada
//  de verdade.
// ============================================================

'use strict';

(function () {

  const $ = id => document.getElementById(id);

  // A cada quantos ms busca as MARCAÇÕES de berço no servidor, pra
  // sincronizar com o que outro dispositivo possa ter marcado (ver nota
  // acima) — NÃO redesenha o card a cada vez, só quando algo muda de
  // verdade (ver _renderSeMudou).
  const INTERVALO_SYNC_MARCACOES_MS = 5000;

  // Último resumo local conhecido da operação (bateria, tipo de
  // montagem, berços reais...) — recebido de operacao.js via
  // atualizarComEstado(), nunca buscado direto daqui. Pode ter
  // status:'idle' e ainda assim já ter bateria/montagem definidos
  // (rascunho antes de "Iniciar Injeção").
  let _dadosAtuais = null;

  // Estado local dos lados marcados (ver GET /bercos-andamento) — mapa
  // esparso em 2 níveis: { 'B1': { esquerda: 'baixou' } }. Lado ausente
  // (ou berço ausente por inteiro) = 'okay'. Recarregado periodicamente
  // (ver _sincronizarMarcacoes) e mantido em memória entre buscas, pra
  // alternar (toggle) sem precisar buscar de novo a cada clique.
  let _bercosMarcados = {};

  // Assinatura do último conteúdo efetivamente desenhado — usada só pra
  // decidir se um redesenho é necessário (ver _renderSeMudou). Evita
  // reconstruir o card (e "piscar" a tela) quando nada mudou de verdade.
  let _ultimaAssinatura = null;

  // Modo "🚫 Marcar Não Enchido" — liga/desliga por um botão no card (ver
  // _renderBateriaAtual). Enquanto ATIVO, clicar num indicador (•/●) marca
  // aquele lado como 'nao_enchido' (vira "✕") em vez de 'baixou' (o
  // vazamento de sempre, "●" preenchido) — os dois nunca se misturam no
  // mesmo lado, é sempre um OU outro (ver POST /marcar-berco-andamento,
  // que já desmarca qualquer um dos dois num clique de novo, seja qual for
  // o modo atual do botão nesse segundo clique). Estado só LOCAL (não
  // precisa sincronizar entre dispositivos como _bercosMarcados —
  // cada computador decide o próprio modo de clique), por isso não é
  // resetado por _sincronizarMarcacoes nem entra em _renderSeMudou.
  let _modoMarcarNaoEnchido = false;

  // Modo "📋 Detalhes do Berço" — mesma ideia do modo "Não Enchido" acima
  // (liga/desliga por um botão, estado só LOCAL, não sincroniza entre
  // dispositivos), mas MUTUAMENTE EXCLUSIVO com ele: os dois mudam o que
  // um clique na grade faz (marcar lado x abrir modal), então nunca ficam
  // ligados ao mesmo tempo (ver os 2 listeners de botão, abaixo — cada um
  // desliga o outro modo ao ligar o próprio). Enquanto ATIVO, clicar em
  // QUALQUER PARTE da célula (não só nos indicadores) abre o modal de
  // detalhes daquele berço (ver _abrirDetalhesBerco) — os indicadores não
  // recebem listener próprio nesse modo, então o clique neles só borbulha
  // pro listener da célula, sem também alternar baixou/não enchido.
  let _modoDetalhesBerco = false;

  // Cor por tipo de montagem de UM berço. As duas situações guardam o
  // tipo de um jeito DIFERENTE, então precisam de funções diferentes pra
  // resolver a cor:
  //  - Montagem Personalizada: cada berço guarda o CÓDIGO do tipo (ex:
  //    'sp', '2p') — mesmo formato usado na grade de configuração (ver
  //    operacao.js, _renderGradeMontagem) — resolvido por
  //    LW.corPorTipoSimples.
  //  - Bateria uniforme (qualquer outro tipo, simples OU híbrido): todo
  //    berço usa o mesmo LABEL cadastrado em Configurações (ex: '2/P',
  //    'S/P', 'HÍBRIDA 2p/sp') — resolvido por LW.corMontagemPorLabel, que
  //    também sabe montar o gradiente 50/50 de tipos híbridos. Usar
  //    corPorTipoSimples aqui (como antes) nunca funcionava: ela procura
  //    pelo CÓDIGO do tipo, não pelo label, então toda bateria uniforme
  //    caía sempre na cor neutra cinza.
  function _baCorPorTipo(ehPersonalizada, tipo) {
    if (!tipo) return null;
    return ehPersonalizada ? LW.corPorTipoSimples(tipo) : LW.corMontagemPorLabel(tipo);
  }

  // ── Posição no Palete ───────────────────────────────────────────────
  // SEMPRE o nº de berços CADASTRADO pra bateria — não existe mais uma
  // capacidade "declarada" separada (bercos_reais foi removido; um berço
  // que não vai ser usado agora se marca individualmente como 🚫 Não
  // Enchido, logo abaixo, não muda o total da bateria). O direcionamento
  // é sobre ONDE FISICAMENTE cada berço empilha (a grade do molde), que
  // não muda numa operação parcial, só a quantidade de painéis muda.
  // Mesma distinção já documentada em _paleteDoBerco (setor-qualidade.js).
  function _baCapacidadeConfigurada(dados) {
    const bateria = (LW.BATERIA_IDS || []).find(b => b.id === dados.id_bateria);
    return bateria?.bercos || 0;
  }

  // Mesmas 4 cores já usadas em paletes-config.js/paletes-ordem.js/
  // setor-qualidade.js pra identificar pallet1..pallet4 — duplicado aqui
  // (mesmo padrão já usado nos outros 3 arquivos) só por consistência
  // visual, o mesmo palete sempre com a mesma cor em qualquer tela.
  const BA_CORES_PALETE = { 1: '#66bb6a', 2: '#42a5f5', 3: '#ab47bc', 4: '#ffa726' };

  // Mesmo mapeamento berço→palete de _paletePorMetadeELado/_paleteDoBerco
  // (setor-qualidade.js), duplicado aqui (não importado de lá, pra não
  // acoplar este card à tela de Qualidade) — fonte da verdade em ambos
  // os lugares é sempre LW.PALETES_CONFIG (Configurações → Bateria e
  // Montagem → "Definir Paletes"), nunca hardcoded.
  function _baPaletePorMetadeELado() {
    const cfg = LW.PALETES_CONFIG || LW.PALETES_CONFIG_DEFAULT;
    return {
      esquerdo: { primeira: cfg.esquerdoPrimeira, segunda: cfg.esquerdoSegunda },
      direito:  { primeira: cfg.direitoPrimeira,  segunda: cfg.direitoSegunda },
    };
  }

  // Berço + lado -> { pallet, posicao, metade } (posicao É o número
  // mostrado dentro daquele palete, sempre 1..metade; metade devolvida
  // junto pra desenhar a grade inteira do palete no modal de detalhes).
  // null se não houver capacidade configurada ainda (bateria não
  // encontrada/sem berços cadastrados).
  function _baPaleteDoBerco(bercoNum, lado, capacidade) {
    if (!capacidade || capacidade <= 0) return null;
    const metade = Math.ceil(capacidade / 2);
    const primeiraMetade = bercoNum <= metade;
    const pallet = _baPaletePorMetadeELado()[lado]?.[primeiraMetade ? 'primeira' : 'segunda'];
    if (!pallet) return null;
    const posicao = primeiraMetade ? bercoNum : bercoNum - metade;
    return { pallet, posicao, metade };
  }

  // Desenho em miniatura de UM palete (pilha 1..metade, só a posição do
  // berço atual acesa, o resto acinzentado) — mesmo espírito visual da
  // pilha de placas do Setor de Qualidade (.sq-slab-stack/.sq-slab, ver
  // setor-qualidade.css), só que compacto o bastante pra caber 2 lado a
  // lado (Direito/Esquerdo) dentro da caixa de detalhes. Posição 1 fica
  // na BASE da pilha (embaixo) e vai empilhando pra cima, igual ao
  // palete físico — por isso o container usa column-reverse (ver CSS).
  function _baDesenhoPaleteMini(pos) {
    if (!pos) return '<div class="ba-det-valor">—</div>';
    const cor = BA_CORES_PALETE[pos.pallet] || 'var(--accent)';
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

  /**
   * Lista de tipos por berço (1 posição por berço, 1-indexed na exibição):
   *  - Montagem Personalizada: usa bercos_personalizados direto (cada
   *    berço já tem seu próprio tipo, ou null se ainda não preenchido).
   *  - Qualquer outro tipo (simples ou híbrido): a bateria é uniforme —
   *    todo berço usa o mesmo tipo_montagem.
   */
  function _baTiposPorBerco(dados, capacidade) {
    if (dados.tipo_montagem === LW.TIPO_MONTAGEM_PERSONALIZADA) {
      const grade = Array.isArray(dados.bercos_personalizados) ? dados.bercos_personalizados : [];
      return Array.from({ length: capacidade }, (_, i) => grade[i] || null);
    }
    return Array.from({ length: capacidade }, () => dados.tipo_montagem || null);
  }

  // Tooltip: sempre indica o lado (Direito/Esquerdo); se marcado, também
  // diz COMO foi marcado — "baixou/vazou" (● preenchido, sempre existiu)
  // ou "não enchido" (✕, ver _modoMarcarNaoEnchido) — os dois têm
  // aparência bem diferente, mas o tooltip deixa explícito de qualquer
  // jeito, sem depender só da forma do indicador.
  //
  // `tipo` (opcional): o código de placa ('2p'/'sp'/...) que ESTE lado
  // representa na montagem atual (ver LW.tipoDoLadoMontagem) — mostrado
  // sempre que resolvido, pra deixar explícito qual tipo cada indicador
  // desconta ao marcar "🚫 Não Enchido". Antes disso os 2 indicadores eram
  // visualmente idênticos (• em cima / ● embaixo) em montagens Híbrida/
  // Personalizada, sem nenhuma pista de qual lado era qual tipo — motivo
  // do desconto "trocado" que o operador via nos cards de Registrar
  // Operação (ver conversa que motivou esta mudança).
  function _tituloDot(estado, lado, tipo) {
    const ladoTxt = lado === 'direita' ? 'Direito' : 'Esquerdo';
    const tipoTxt = tipo ? ` (${LW.escaparHtml(String(tipo).toUpperCase())})` : '';
    if (estado === 'nao_enchido') return `${ladoTxt}${tipoTxt} — Não enchido`;
    if (estado === 'baixou') return `${ladoTxt}${tipoTxt} — Baixou/Vazou`;
    return `${ladoTxt}${tipoTxt}`;
  }

  // Indica se ESTE dispositivo pode marcar os vazamentos agora — mesmo
  // critério de _bloqueadoPorAutorizacao/_aplicarTravaDeAutorizacao
  // (operacao.js): Modo de Teste nunca trava (sandbox local, sem conceito
  // de dono); fora dele, precisa estar Autorizado E (ninguém ser dono
  // ainda, OU o dono ser este dispositivo). A trava de verdade é sempre
  // no servidor (ver POST /marcar-berco-andamento) — isto aqui só evita
  // deixar os indicadores clicáveis (e o clique falhando toda vez) pra
  // quem já sabe, de cara, que não pode marcar nada agora.
  function _podeMarcarVazamento(dados) {
    if (dados.modo_teste) return true;
    if (!LW.dispositivoEstaAutorizado()) return false;
    const dono = dados.donoDeviceId || null;
    return !dono || dono === LW.getDeviceId();
  }

  function _renderBateriaAtual(dados) {
    const el = $('bateria-atual-content');
    if (!el) return;

    // Aparece assim que Tipo de Bateria + Tipo de Montagem estiverem
    // definidos — mesmo que a operação ainda não tenha sido "Iniciada"
    // (status ainda 'idle'). Antes disso não tem o que desenhar: não dá
    // pra saber quantos berços tem nem de que cor pintar cada um.
    if (!dados || !dados.id_bateria || !dados.tipo_montagem) {
      el.innerHTML = '<span class="ba-vazio">Defina a bateria e o tipo de montagem para ver a prévia aqui.</span>';
      return;
    }

    const capacidade = _baCapacidadeConfigurada(dados);
    const tipos = _baTiposPorBerco(dados, capacidade);
    const ehPersonalizada = dados.tipo_montagem === LW.TIPO_MONTAGEM_PERSONALIZADA;
    const podeMarcar = _podeMarcarVazamento(dados);

    const resumo = `
      <div class="ba-resumo">
        <strong>Bateria ${LW.escaparHtml(dados.id_bateria || '—')}</strong> — ${LW.escaparHtml(dados.tipo_montagem || '—')}
        ${capacidade ? ` — ${capacidade} berços` : ''}
      </div>`;
    // Botão "🚫 Marcar Não Enchido" — só aparece pra quem já pode marcar
    // (mesma trava dos indicadores, ver podeMarcar); alternar o modo é só
    // estado local (_modoMarcarNaoEnchido), não chama o servidor por si
    // só — só o CLIQUE NUM INDICADOR chama (ver _baCliqueDot).
    const botaoModo = podeMarcar
      ? `<button type="button" id="ba-btn-nao-enchido" class="btn btn-sm ${_modoMarcarNaoEnchido ? 'btn-danger' : 'btn-ghost'}">
          ${_modoMarcarNaoEnchido ? '✕ Marcando Não Enchido — clique p/ desligar' : '🚫 Marcar Não Enchido'}
        </button>`
      : '';
    // Botão "📋 Detalhes do Berço" — ao contrário do botão acima, aparece
    // pra TODO MUNDO (mesmo sem podeMarcar): só ABRIR o modal (visualizar)
    // não exige controle da operação — quem não tem controle só não vê os
    // campos editáveis dentro dele (ver _abrirDetalhesBerco).
    const botaoDetalhes = `<button type="button" id="ba-btn-detalhes-berco" class="btn btn-sm ${_modoDetalhesBerco ? 'btn-accent' : 'btn-ghost'}">
        ${_modoDetalhesBerco ? '📋 Detalhes — clique num berço' : '📋 Detalhes do Berço'}
      </button>`;
    const dica = _modoDetalhesBerco
      ? `<div class="ba-dica ba-dica-detalhes">📋 Clique em um berço (ex: B11) para ver e editar os detalhes dele.</div>`
      : !podeMarcar
        ? `<div class="ba-dica">🔒 Só o computador que está no controle desta operação pode marcar os vazamentos.</div>`
        : _modoMarcarNaoEnchido
          ? `<div class="ba-dica ba-dica-nao-enchido">✕ Clique num indicador para marcar aquele lado como <strong>não enchido</strong> — o painel correspondente sai da grade de avaliação da Qualidade.</div>`
          : `<div class="ba-dica">🖱️ Clique num indicador (•) para marcar que aquele lado do berço baixou ou vazou</div>`;
    // Fileira única: 1 2 3 4 5 6 7 8 ... (ver .ba-grid no CSS — flex row
    // que DIVIDE a largura disponível igualmente entre os berços, ficando
    // mais fina ou mais grossa conforme a quantidade, sem gerar scroll —
    // ver comentário em .ba-grid/.ba-celula no CSS). A célula em si NÃO é
    // clicável — só os 2 indicadores dentro dela (ver abaixo).
    const grid = `<div class="ba-grid${podeMarcar ? '' : ' ba-grid-bloqueada'}${_modoDetalhesBerco ? ' ba-grid-detalhes' : ''}">${tipos.map((tipo, i) => {
      const cor = _baCorPorTipo(ehPersonalizada, tipo);
      const numero = String(i + 1).padStart(2, '0');
      const berco = 'B' + (i + 1);
      const bercoNum = i + 1;
      const marcadoBerco = _bercosMarcados[berco] || {};
      const estadoDir = marcadoBerco.direita || null; // 'baixou' | 'nao_enchido' | null
      const estadoEsq = marcadoBerco.esquerda || null;
      // Tipo que CADA LADO representa nesta montagem — mesma resolução
      // usada pra descontar dos totais (ver LW.tipoDoLadoMontagem,
      // data.js), só pra exibir no tooltip (ver _tituloDot acima).
      const tipoDir = LW.tipoDoLadoMontagem(dados.tipo_montagem, dados.bercos_personalizados, bercoNum, 'direita');
      const tipoEsq = LW.tipoDoLadoMontagem(dados.tipo_montagem, dados.bercos_personalizados, bercoNum, 'esquerda');
      // "✕" (não enchido) tem prioridade visual sobre "●" (baixou) — na
      // prática nunca deveriam coexistir no mesmo lado (POST
      // /marcar-berco-andamento sempre limpa um antes de aplicar o
      // outro), mas se algum dado antigo tiver os dois por algum motivo,
      // não enchido é o mais "definitivo" dos dois (o painel nem existe
      // pra avaliar) — melhor não esconder essa informação.
      const dirNaoEnchido = estadoDir === 'nao_enchido';
      const esqNaoEnchido = estadoEsq === 'nao_enchido';
      const dirMarcado = estadoDir === 'baixou' || dirNaoEnchido;
      const esqMarcado = estadoEsq === 'baixou' || esqNaoEnchido;
      return `
        <div class="ba-celula" data-berco="${berco}"
          style="background:${cor ? cor.bg : 'var(--bg-2)'};color:${cor ? cor.cor : 'var(--text-3)'};border:1px solid ${cor ? cor.borda : 'var(--border)'}">
          <span class="ba-dot ba-dot-topo${dirMarcado ? ' ba-dot-marcado' : ''}${dirNaoEnchido ? ' ba-dot-nao-enchido' : ''}" data-berco="${berco}" data-lado="direita"
            data-tooltip="${_tituloDot(estadoDir, 'direita', tipoDir)}">${dirNaoEnchido ? '✕' : '•'}</span>
          <span class="ba-numero">B${numero}</span>
          <span class="ba-dot ba-dot-base${esqMarcado ? ' ba-dot-marcado' : ''}${esqNaoEnchido ? ' ba-dot-nao-enchido' : ''}" data-berco="${berco}" data-lado="esquerda"
            data-tooltip="${_tituloDot(estadoEsq, 'esquerda', tipoEsq)}">${esqNaoEnchido ? '✕' : '•'}</span>
        </div>`;
    }).join('')}</div>`;

    el.innerHTML = resumo + `<div class="ba-botoes">${botaoModo}${botaoDetalhes}</div>` + dica + grid;

    if (podeMarcar) {
      const btnModo = $('ba-btn-nao-enchido');
      if (btnModo) {
        btnModo.addEventListener('click', () => {
          _modoMarcarNaoEnchido = !_modoMarcarNaoEnchido;
          if (_modoMarcarNaoEnchido) _modoDetalhesBerco = false; // mutuamente exclusivo, ver comentário de _modoDetalhesBerco
          _renderBateriaAtual(_dadosAtuais); // redesenha na hora (botão, dica e cursor dos indicadores mudam com o modo) — não passa por _renderSeMudou de propósito, é só estado local, não precisa da checagem de assinatura
        });
      }
    }

    // Botão de Detalhes — wired incondicionalmente (funciona mesmo sem
    // podeMarcar, ver comentário acima de botaoDetalhes).
    const btnDetalhes = $('ba-btn-detalhes-berco');
    if (btnDetalhes) {
      btnDetalhes.addEventListener('click', () => {
        _modoDetalhesBerco = !_modoDetalhesBerco;
        if (_modoDetalhesBerco) _modoMarcarNaoEnchido = false; // mutuamente exclusivo
        _renderBateriaAtual(_dadosAtuais);
      });
    }

    // Clique na CÉLULA inteira (não só nos indicadores) abre o modal de
    // detalhes daquele berço — só ligado quando o modo está ativo, e
    // funciona mesmo sem podeMarcar (o modal só esconde os campos
    // editáveis nesse caso, ver _abrirDetalhesBerco). Como os indicadores
    // não recebem listener próprio neste modo (ver abaixo), um clique
    // neles só borbulha pra este listener, sem também alternar
    // baixou/não enchido — os dois nunca disparam juntos.
    if (_modoDetalhesBerco) {
      el.querySelectorAll('.ba-celula').forEach(cel => {
        cel.addEventListener('click', () => _abrirDetalhesBerco(cel.getAttribute('data-berco')));
      });
    }

    // Sem dono, os indicadores nem recebem listener de clique — trava já
    // na origem, não só no CSS (que só cuida da aparência/cursor).
    if (!podeMarcar) return;

    // No modo Detalhes, os indicadores ficam sem listener próprio de
    // propósito (ver comentário acima) — só a célula inteira reage.
    if (_modoDetalhesBerco) return;

    // Cada indicador marca/desmarca seu PRÓPRIO lado — independente do
    // outro indicador do mesmo berço (ver _baCliqueDot, abaixo). O modo
    // atual (_modoMarcarNaoEnchido) decide qual estado aplicar quando o
    // lado ainda estiver 'okay' — mesmo indicador, mesmo clique, resultado
    // diferente conforme o botão ligado no momento do clique.
    el.querySelectorAll('.ba-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        _baCliqueDot(dot.getAttribute('data-berco'), dot.getAttribute('data-lado'), dot, _modoMarcarNaoEnchido ? 'nao_enchido' : 'baixou');
      });
    });
  }

  // Alterna (toggle) o estado de UM lado de UM berço — otimista na UI
  // (reage na hora) e confirma com o servidor em seguida; desfaz
  // visualmente se a chamada falhar (ex: a operação foi encerrada por
  // outra pessoa bem nesse instante — ver POST /marcar-berco-andamento,
  // server.js). O outro lado do mesmo berço nunca é tocado aqui.
  //
  // estadoDesejado: 'baixou' (padrão, vazamento) ou 'nao_enchido' (modo
  // "🚫 Marcar Não Enchido" ligado, ver _modoMarcarNaoEnchido) — só é
  // usado se o lado ainda estiver 'okay'; se já tiver QUALQUER marcação
  // (baixou OU nao_enchido), o clique sempre desmarca (volta a 'okay'),
  // nunca troca uma marcação por outra — mesma regra do servidor (ver
  // POST /marcar-berco-andamento).
  // Cada lado marcado "🚫 Não Enchido" é 1 painel a menos nos totais
  // mostrados em Registrar Operação (Painéis Total/por tipo, m² Total/por
  // tipo — ver recalcPaineis, operacao.js, e aplicarNaoEnchidosNoCalc,
  // data.js). Chamada toda vez que _bercosMarcados muda (clique local
  // otimista, desfazer de clique com falha, ou sincronização periódica
  // com outro dispositivo) — sem isso os cards de total só atualizariam
  // na próxima mudança de OUTRO campo do formulário.
  function _notificarMudancaMarcacoes() {
    if (window.LWOp && typeof window.LWOp.recalcPaineis === 'function') {
      window.LWOp.recalcPaineis();
    }
  }

  async function _baCliqueDot(berco, lado, dotEl, estadoDesejado) {
    if (!berco || !lado) return;
    const marcadoBerco = _bercosMarcados[berco] || {};
    const estadoAtual = marcadoBerco[lado] || null; // 'baixou' | 'nao_enchido' | null
    const estavaMarcado = estadoAtual === 'baixou' || estadoAtual === 'nao_enchido';
    const novoEstado = estavaMarcado ? null : estadoDesejado;

    // Resolve e FIXA o tipo deste lado ('2p'/'sp'/...) na montagem/grade
    // de AGORA, no instante do clique — mandado junto pro servidor (só ao
    // marcar, nunca ao desmarcar) pra ficar gravado com a marcação. Sem
    // isso, reconfigurar a montagem/grade DEPOIS (trocar o tipo do berço
    // na Personalizada, reordenar os tipos da Híbrida em Configurações)
    // mudava retroativamente de qual tipo o desconto saía — ver
    // aplicarNaoEnchidosNoCalc, data.js, e conversa que motivou isto.
    const bercoNum = parseInt(String(berco).replace(/^B/i, ''), 10);
    const tipoFixado = (novoEstado === 'nao_enchido' && _dadosAtuais && bercoNum)
      ? LW.tipoDoLadoMontagem(_dadosAtuais.tipo_montagem, _dadosAtuais.bercos_personalizados, bercoNum, lado)
      : null;

    // Otimista: já atualiza o indicador antes da resposta do servidor.
    const novoBerco = { ...marcadoBerco };
    if (novoEstado) {
      novoBerco[lado] = novoEstado;
      if (tipoFixado) novoBerco.tipos = { ...(novoBerco.tipos || {}), [lado]: tipoFixado };
    } else {
      delete novoBerco[lado];
      if (novoBerco.tipos) {
        const { [lado]: _descartado, ...restoTipos } = novoBerco.tipos;
        if (Object.keys(restoTipos).length) novoBerco.tipos = restoTipos; else delete novoBerco.tipos;
      }
    }
    if (Object.keys(novoBerco).length) _bercosMarcados[berco] = novoBerco;
    else delete _bercosMarcados[berco];
    _notificarMudancaMarcacoes();

    const ehNaoEnchido = novoEstado === 'nao_enchido';
    dotEl.classList.toggle('ba-dot-marcado', !!novoEstado);
    dotEl.classList.toggle('ba-dot-nao-enchido', ehNaoEnchido);
    dotEl.textContent = ehNaoEnchido ? '✕' : '•';
    dotEl.setAttribute('data-tooltip', _tituloDot(novoEstado, lado, tipoFixado));

    try {
      // A rota exige sessão de usuário logado com permissão de controlar
      // operações + ser o dono da operação (ver podeControlarOperacao(),
      // server.js) — deviceId continua sendo mandado só pra identificar o
      // "dono" da operação em andamento (ver donoDeviceId,
      // lib/rotas/operacao-andamento.js), não é mais usado pra autorização.
      // `tipo` (opcional) é o tipo fixado acima — o servidor só grava
      // quando o lado está sendo MARCADO (nunca ao desmarcar).
      const res = await fetch('/marcar-berco-andamento?deviceId=' + encodeURIComponent(LW.getDeviceId()), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ berco, lado, estado: estadoDesejado, tipo: tipoFixado }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.erro || 'Falha ao marcar berço.');
    } catch (e) {
      // Desfaz o otimismo — volta pro estado (e tipo fixado) de antes do
      // clique, a partir do snapshot original (marcadoBerco), em vez de
      // reconstruir campo a campo — evita deixar `tipos` dessincronizado
      // do `estado` depois de desfazer.
      if (Object.keys(marcadoBerco).length) _bercosMarcados[berco] = marcadoBerco;
      else delete _bercosMarcados[berco];
      _notificarMudancaMarcacoes();
      _ultimaAssinatura = null; // força o redesenho mesmo se a assinatura "bater" por acaso
      _renderSeMudou(); // reconstrói a grade inteira já no estado real (desfeito o otimismo)
      if (typeof LW !== 'undefined' && LW.mostrarAlerta) {
        LW.mostrarAlerta(e.message || 'Não consegui marcar o berço agora.', { tipo: 'erro' });
      }
    }
  }

  // ============================================================
  //  📋 Detalhes do Berço — modal com o "raio-x" de UM berço específico
  //  (desenho + dados), aberto pelo modo "📋 Detalhes do Berço" (ver
  //  botaoDetalhes/_modoDetalhesBerco, acima). Mostra Tipo de Montagem,
  //  Tipo de Bateria, Dimensão, Data de Enchimento e Traço Usado — só a
  //  Dimensão pode ser editada aqui direto (ver aplicarDetalhesBerco,
  //  operacao.js); Tipo de Montagem, Tipo de Bateria, Data de Enchimento
  //  e Traço Usado são só informativos (Tipo de Montagem é definido lá
  //  em cima, na configuração da bateria/grade de montagem — não faz
  //  sentido reeditar berço a berço por aqui; bateria é escolhida lá em
  //  cima, data é automática, e o traço é resolvido a partir do que já
  //  foi lançado nos traços da operação, nunca digitado à mão).
  // ============================================================

  // Acha, dentre os traços já lançados nesta operação (dados.tracos), qual
  // deles cobre o berço informado — mesma técnica de correlação usada em
  // analise-focada.js (_bercosEnchidosDoTraco/db.correlacaoTracoBerco), só
  // que aqui em cima do estado AO VIVO (berco_ini/berco_fim, ainda em
  // memória) em vez dos campos já persistidos (berco_inicio/berco_finalizacao)
  // de uma operação já registrada. Math.min/max cobre um "De/Até" digitado
  // invertido. Devolve null se nenhum traço cobre esse berço ainda (ainda
  // não definido) ou se o range do traço não é numérico.
  function _tracoQueEncheuBerco(dados, numeroBerco) {
    const tracos = Array.isArray(dados?.tracos) ? dados.tracos : [];
    for (const t of tracos) {
      const ini = parseInt(t.berco_ini, 10);
      const fim = parseInt(t.berco_fim, 10);
      if (isNaN(ini) || isNaN(fim)) continue;
      if (numeroBerco >= Math.min(ini, fim) && numeroBerco <= Math.max(ini, fim)) return t;
    }
    return null;
  }

  // Formata o texto digitado em "Dimensão" pra já virar "9,5 cm" sem a
  // pessoa precisar escrever o "cm" — mesma lógica de _formatarDimensaoLive
  // (operacao.js, tela de Registrar Operação), duplicada aqui (não
  // importada de lá, mesmo padrão já usado nas outras funções
  // duplicadas deste arquivo, ver BA_CORES_PALETE/_baPaletePorMetadeELado
  // acima) pra não acoplar este modal à tela de Registro. Regras, na
  // ordem aplicada:
  //  1) descarta qualquer caractere que não seja número, vírgula ou ponto
  //     — o campo é só pra medida, não aceita texto livre;
  //  2) ponto vira vírgula (9.5 -> 9,5), separador decimal padrão do
  //     sistema;
  //  3) o que sobrar (só o número) recebe " cm" no final automaticamente.
  // `final`: true na formatação de fechamento (blur/Enter) — aí uma
  // vírgula sem nada depois (ex: "9,") é descartada e vira só "9 cm".
  function _baFormatarDimensaoLive(bruto, final) {
    let v = (bruto || '');
    v = v.replace(/\s*cm\s*$/i, '');
    v = v.replace(/[^\d,.]/g, '');
    v = v.replace(/\./g, ',');
    const partes = v.split(',');
    if (partes.length > 2) v = partes[0] + ',' + partes.slice(1).join('');
    if (final && /,$/.test(v)) v = v.replace(/,+$/, '');
    if (v === '') return '';
    return v + ' cm';
  }

  function _abrirDetalhesBerco(berco) {
    const dados = _dadosAtuais;
    if (!dados || !berco) return;
    document.getElementById('ba-modal-detalhes-berco')?.remove();

    const numeroBerco = parseInt(berco.replace(/\D/g, ''), 10);
    const capacidade = _baCapacidadeConfigurada(dados);
    const tipos = _baTiposPorBerco(dados, capacidade);
    const ehPersonalizada = dados.tipo_montagem === LW.TIPO_MONTAGEM_PERSONALIZADA;
    const podeEditar = _podeMarcarVazamento(dados); // mesma trava de "quem controla a operação"
    const tipoAtualCodigo = tipos[numeroBerco - 1] || null;
    const cor = _baCorPorTipo(ehPersonalizada, tipoAtualCodigo);
    const marcadoBerco = _bercosMarcados[berco] || {};
    const traco = _tracoQueEncheuBerco(dados, numeroBerco);

    // Rótulo amigável do tipo atual — se Personalizada, tipoAtualCodigo já
    // é o CÓDIGO ('sp','2p'...), resolvido pro label via MONTAGEM_OPCOES;
    // se não, tipoAtualCodigo já É o label (bateria uniforme).
    const labelTipoAtual = ehPersonalizada
      ? ((LW.MONTAGEM_OPCOES || []).find(o => o.tipo === tipoAtualCodigo)?.label || tipoAtualCodigo || '—')
      : (tipoAtualCodigo || '—');

    const dataEnchimento = dados.inicio ? LW.formatDateTime(dados.inicio) : LW.formatDateTime(new Date());

    // Tipo de Montagem: sempre somente-leitura por aqui (definido lá em
    // cima, na configuração da bateria/grade de montagem) — nunca editável
    // berço a berço neste modal, mesmo quando podeEditar é true (que só
    // controla a Dimensão, abaixo).
    const campoTipo = `<div class="ba-det-valor">${LW.escaparHtml(labelTipoAtual)}</div>`;

    // Dimensão DESTE berço específico — usa o override individual
    // (dados.bercos_dimensoes[numeroBerco-1]) se já existir; senão cai
    // pra dimensão geral da operação (dados.dimensao), igual a todo
    // berço que ainda não teve a dimensão editada por aqui. Salvar
    // NUNCA mais altera dados.dimensao — só a posição deste berço (ver
    // aplicarDetalhesBerco, operacao.js).
    const dimensaoBercoAtual = (Array.isArray(dados.bercos_dimensoes) && dados.bercos_dimensoes[numeroBerco - 1])
      || dados.dimensao || '';
    const campoDimensao = podeEditar
      ? `<input type="text" id="ba-det-dimensao" class="form-input" value="${LW.escaparHtml(dimensaoBercoAtual)}" placeholder="Ex: 9,5 cm">`
      : `<div class="ba-det-valor">${LW.escaparHtml(dimensaoBercoAtual || '—')}</div>`;

    const labelTraco = traco ? `Traço Nº ${LW.escaparHtml(String(traco.num))}` : 'Ainda não definido';

    // Posição no Palete — cada berço enche 2 painéis (Direito/Esquerdo),
    // e cada lado pode cair num palete diferente (ver LW.PALETES_CONFIG),
    // então mostra os dois separados.
    const capacidadePalete = _baCapacidadeConfigurada(dados);
    const posicaoDireito = _baPaleteDoBerco(numeroBerco, 'direito', capacidadePalete);
    const posicaoEsquerdo = _baPaleteDoBerco(numeroBerco, 'esquerdo', capacidadePalete);

    const overlay = document.createElement('div');
    overlay.id = 'ba-modal-detalhes-berco';
    overlay.className = 'ba-detalhes-overlay';
    overlay.innerHTML = `
      <div class="ba-detalhes-box">
        <button type="button" class="ba-detalhes-fechar" id="ba-det-fechar" aria-label="Fechar" title="Fechar">✕</button>
        <h3 class="ba-detalhes-titulo">Detalhes do Berço ${LW.escaparHtml(berco)}</h3>

        <div class="ba-detalhes-desenho">
          <div class="ba-detalhes-celula"
            style="background:${cor ? cor.bg : 'var(--bg-2)'};color:${cor ? cor.cor : 'var(--text-3)'};border:2px solid ${cor ? cor.borda : 'var(--border)'}">
            <span class="ba-detalhes-dot${marcadoBerco.direita === 'nao_enchido' ? ' ba-detalhes-dot-x' : marcadoBerco.direita === 'baixou' ? ' ba-detalhes-dot-vazou' : ''}" title="${marcadoBerco.direita === 'nao_enchido' ? 'Direito — Não enchido' : marcadoBerco.direita === 'baixou' ? 'Direito — Baixou/Vazou' : 'Direito'}">${marcadoBerco.direita === 'nao_enchido' ? '✕' : '•'}</span>
            <span class="ba-detalhes-label">${LW.escaparHtml(berco)}</span>
            <span class="ba-detalhes-dot${marcadoBerco.esquerda === 'nao_enchido' ? ' ba-detalhes-dot-x' : marcadoBerco.esquerda === 'baixou' ? ' ba-detalhes-dot-vazou' : ''}" title="${marcadoBerco.esquerda === 'nao_enchido' ? 'Esquerdo — Não enchido' : marcadoBerco.esquerda === 'baixou' ? 'Esquerdo — Baixou/Vazou' : 'Esquerdo'}">${marcadoBerco.esquerda === 'nao_enchido' ? '✕' : '•'}</span>
          </div>
        </div>

        <div class="ba-detalhes-campos">
          <div class="ba-detalhes-campo">
            <label class="form-label">Tipo de Montagem</label>
            ${campoTipo}
          </div>
          <div class="ba-detalhes-campo">
            <label class="form-label">Tipo de Bateria</label>
            <div class="ba-det-valor">${LW.escaparHtml(dados.id_bateria || '—')}</div>
          </div>
          <div class="ba-detalhes-campo">
            <label class="form-label">Dimensão</label>
            ${campoDimensao}
          </div>
          <div class="ba-detalhes-campo">
            <label class="form-label">Data de Enchimento</label>
            <div class="ba-det-valor">${LW.escaparHtml(dataEnchimento)}</div>
          </div>
          <div class="ba-detalhes-campo">
            <label class="form-label">Traço Usado</label>
            <div class="ba-det-valor">${labelTraco}</div>
          </div>
          <div class="ba-detalhes-campo">
            <label class="form-label">Posição no Palete</label>
            <div class="ba-detalhes-paletes">
              <div class="ba-detalhes-palete-lado">
                <span class="ba-detalhes-palete-lado-label">Direito</span>
                ${_baDesenhoPaleteMini(posicaoDireito)}
              </div>
              <div class="ba-detalhes-palete-lado">
                <span class="ba-detalhes-palete-lado-label">Esquerdo</span>
                ${_baDesenhoPaleteMini(posicaoEsquerdo)}
              </div>
            </div>
          </div>
        </div>

        <div class="ba-detalhes-acoes">
          <button type="button" class="btn btn-ghost" id="ba-det-cancelar">${podeEditar ? 'Cancelar' : 'Fechar'}</button>
          ${podeEditar ? `<button type="button" class="btn btn-primary" id="ba-det-salvar">Salvar</button>` : ''}
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const fechar = () => overlay.remove();
    $('ba-det-fechar').addEventListener('click', fechar);
    $('ba-det-cancelar').addEventListener('click', fechar);
    // Clicar fora da caixa (no fundo escurecido) também fecha — diferente
    // do seletor de motivo da Qualidade (que é obrigatório de propósito),
    // aqui não há nada obrigatório a escolher, então sair sem salvar é
    // sempre uma saída válida.
    overlay.addEventListener('click', (e) => { if (e.target === overlay) fechar(); });

    if (podeEditar) {
      // Mesmo formato em tempo real do campo "Dimensão" da tela de
      // Registrar Operação (ver op-dimensao/_formatarDimensaoLive,
      // operacao.js): só número e vírgula, " cm" adicionado sozinho no
      // final, sem precisar digitar. Mantém a posição do cursor pra não
      // "pular" pro fim do campo a cada tecla.
      $('ba-det-dimensao').addEventListener('input', e => {
        const input = e.target;
        const cursorPos = input.selectionStart;
        const antes = input.value;
        const formatado = _baFormatarDimensaoLive(antes);
        if (formatado !== antes) {
          input.value = formatado;
          const novaPos = Math.min(cursorPos, formatado.length);
          input.setSelectionRange(novaPos, novaPos);
        }
      });

      $('ba-det-salvar').addEventListener('click', () => {
        // Tipo de Montagem não é mais editável por aqui (ver campoTipo,
        // acima) — só a Dimensão. novoTipo fica null pra
        // aplicarDetalhesBerco (operacao.js) não alterar o tipo.
        const novaDimensao = $('ba-det-dimensao').value;
        if (window.LWOp && typeof window.LWOp.aplicarDetalhesBerco === 'function') {
          window.LWOp.aplicarDetalhesBerco(numeroBerco, null, novaDimensao);
        }
        fechar();
      });
    }
  }

  // Só redesenha o card se o resumo local + as marcações realmente
  // mudaram desde o último desenho — chamada tanto pela atualização
  // local (instantânea, a cada mudança de formulário) quanto pelo sync
  // periódico das marcações (rede). Sem essa checagem, o sync periódico
  // reconstruiria o card inteiro a cada rodada mesmo sem nada de novo,
  // dando a impressão de ficar "recarregando" o tempo todo.
  function _renderSeMudou() {
    const assinatura = JSON.stringify([_dadosAtuais, _bercosMarcados]);
    if (assinatura === _ultimaAssinatura) return;
    _ultimaAssinatura = assinatura;
    _renderBateriaAtual(_dadosAtuais);
  }

  // Busca só as MARCAÇÕES de berço no servidor (ver nota no topo do
  // arquivo) — nunca busca o resumo da operação em si, que já chega via
  // atualizarComEstado(). Silencioso em caso de falha de rede: mantém as
  // últimas marcações conhecidas em vez de apagar o card.
  async function _sincronizarMarcacoes() {
    if (!$('bateria-atual-content')) return; // card só existe na tela Registrar Operação
    try {
      const bercosMarcados = await fetch('/bercos-andamento').then(r => r.ok ? r.json() : {});
      _bercosMarcados = bercosMarcados || {};
      _notificarMudancaMarcacoes();
      _renderSeMudou();
    } catch (_) {
      // sem conexão agora — tenta de novo na próxima rodada, mantém o que já tem na tela
    }
  }

  // ---- API pública ----
  window.LWBateriaAtual = {
    // Chamada por operacao.js a cada mudança relevante do formulário
    // (local, sem rede) e também com o estado inicial/estado recebido
    // por WebSocket de outro dispositivo — é a ÚNICA fonte do resumo
    // (bateria, tipo de montagem, berços reais) mostrado aqui.
    atualizarComEstado(dados) {
      _dadosAtuais = dados || null;
      _renderSeMudou();
    },
    // Cópia atual das marcações "baixou"/"nao_enchido" (mesmo formato de
    // GET /bercos-andamento) — usada por operacao.js (recalcPaineis) pra
    // descontar painéis "🚫 Não Enchido" do preview ao vivo. É só o cache
    // LOCAL (sincronizado a cada INTERVALO_SYNC_MARCACOES_MS, acima) —
    // suficiente pro preview; os totais que de fato são REGISTRADOS
    // buscam uma cópia fresca do servidor na hora (ver
    // _registrarOperacaoInterna, operacao.js).
    obterMarcacoes() {
      return _bercosMarcados;
    },
  };

  // Auto-inicia: card sempre visível, sem clique pra abrir. Só sincroniza
  // as MARCAÇÕES periodicamente (ver INTERVALO_SYNC_MARCACOES_MS) — o
  // resumo em si chega de operacao.js assim que ele carregar, não daqui.
  document.addEventListener('DOMContentLoaded', () => {
    _sincronizarMarcacoes();
    setInterval(_sincronizarMarcacoes, INTERVALO_SYNC_MARCACOES_MS);
  });

})();