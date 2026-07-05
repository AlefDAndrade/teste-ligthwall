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

  // Capacidade real da bateria: berços reais informados na operação, ou
  // (se não informado ainda) o número de berços cadastrado pra essa
  // bateria em Configurações — mesma lógica de operacao.js.
  function _baCapacidade(dados) {
    const bateria = (LW.BATERIA_IDS || []).find(b => b.id === dados.id_bateria);
    return parseInt(dados.bercos_reais) || (bateria?.bercos || 0);
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

  // Tooltip simplificado: só indica de qual lado é o indicador (Direito
  // ou Esquerdo) — sem explicação de clique nem status de marcado, que
  // já é visível pelo próprio estilo do indicador (ver .ba-dot-marcado).
  function _tituloDot(marcado, lado) {
    return lado === 'direita' ? 'Direito' : 'Esquerdo';
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

    const capacidade = _baCapacidade(dados);
    const tipos = _baTiposPorBerco(dados, capacidade);
    const ehPersonalizada = dados.tipo_montagem === LW.TIPO_MONTAGEM_PERSONALIZADA;

    const resumo = `
      <div class="ba-resumo">
        <strong>Bateria ${dados.id_bateria || '—'}</strong> — ${dados.tipo_montagem || '—'}
        ${dados.bercos_reais ? ` — ${dados.bercos_reais} berços` : ''}
      </div>`;
    const dica = `<div class="ba-dica">🖱️ Clique num indicador (•) para marcar que aquele lado do berço baixou ou vazou</div>`;
    // Fileira única: 1 2 3 4 5 6 7 8 ... (ver .ba-grid no CSS — flex row
    // que DIVIDE a largura disponível igualmente entre os berços, ficando
    // mais fina ou mais grossa conforme a quantidade, sem gerar scroll —
    // ver comentário em .ba-grid/.ba-celula no CSS). A célula em si NÃO é
    // clicável — só os 2 indicadores dentro dela (ver abaixo).
    const grid = `<div class="ba-grid">${tipos.map((tipo, i) => {
      const cor = _baCorPorTipo(ehPersonalizada, tipo);
      const numero = String(i + 1).padStart(2, '0');
      const berco = 'B' + (i + 1);
      const marcadoBerco = _bercosMarcados[berco] || {};
      const dirMarcado = marcadoBerco.direita === 'baixou';
      const esqMarcado = marcadoBerco.esquerda === 'baixou';
      const algumMarcado = dirMarcado || esqMarcado;
      return `
        <div class="ba-celula" data-berco="${berco}"
          style="background:${cor ? cor.bg : 'var(--bg-2)'};color:${cor ? cor.cor : 'var(--text-3)'};border:1px solid ${cor ? cor.borda : 'var(--border)'}">
          <span class="ba-dot ba-dot-topo${dirMarcado ? ' ba-dot-marcado' : ''}" data-berco="${berco}" data-lado="direita"
            data-tooltip="${_tituloDot(dirMarcado, 'direita')}">•</span>
          <span class="ba-numero">B${numero}${algumMarcado ? ' ⚠️' : ''}</span>
          <span class="ba-dot ba-dot-base${esqMarcado ? ' ba-dot-marcado' : ''}" data-berco="${berco}" data-lado="esquerda"
            data-tooltip="${_tituloDot(esqMarcado, 'esquerda')}">•</span>
        </div>`;
    }).join('')}</div>`;

    el.innerHTML = resumo + dica + grid;

    // Cada indicador marca/desmarca seu PRÓPRIO lado — independente do
    // outro indicador do mesmo berço (ver _baCliqueDot, abaixo).
    el.querySelectorAll('.ba-dot').forEach(dot => {
      dot.addEventListener('click', () => {
        _baCliqueDot(dot.getAttribute('data-berco'), dot.getAttribute('data-lado'), dot);
      });
    });
  }

  // Alterna (toggle) o estado de UM lado de UM berço — otimista na UI
  // (reage na hora) e confirma com o servidor em seguida; desfaz
  // visualmente se a chamada falhar (ex: a operação foi encerrada por
  // outra pessoa bem nesse instante — ver POST /marcar-berco-andamento,
  // server.js). O outro lado do mesmo berço nunca é tocado aqui.
  async function _baCliqueDot(berco, lado, dotEl) {
    if (!berco || !lado) return;
    const marcadoBerco = _bercosMarcados[berco] || {};
    const estavaMarcado = marcadoBerco[lado] === 'baixou';
    const novoMarcado = !estavaMarcado;

    // Otimista: já atualiza o indicador antes da resposta do servidor.
    const novoBerco = { ...marcadoBerco };
    if (novoMarcado) novoBerco[lado] = 'baixou'; else delete novoBerco[lado];
    if (Object.keys(novoBerco).length) _bercosMarcados[berco] = novoBerco;
    else delete _bercosMarcados[berco];

    dotEl.classList.toggle('ba-dot-marcado', novoMarcado);
    dotEl.setAttribute('data-tooltip', _tituloDot(novoMarcado, lado));
    const celulaEl = dotEl.closest('.ba-celula');
    const numEl = celulaEl && celulaEl.querySelector('.ba-numero');
    if (numEl) {
      const algumMarcado = Object.keys(_bercosMarcados[berco] || {}).length > 0;
      numEl.textContent = numEl.textContent.replace(' ⚠️', '') + (algumMarcado ? ' ⚠️' : '');
    }

    try {
      const res = await fetch('/marcar-berco-andamento', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ berco, lado }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.erro || 'Falha ao marcar berço.');
    } catch (e) {
      // Desfaz o otimismo — volta pro estado de antes do clique.
      if (estavaMarcado) {
        const b = { ..._bercosMarcados[berco] };
        b[lado] = 'baixou';
        _bercosMarcados[berco] = b;
      } else if (_bercosMarcados[berco]) {
        delete _bercosMarcados[berco][lado];
        if (!Object.keys(_bercosMarcados[berco]).length) delete _bercosMarcados[berco];
      }
      _ultimaAssinatura = null; // força o redesenho mesmo se a assinatura "bater" por acaso
      _renderSeMudou(); // reconstrói a grade inteira já no estado real (desfeito o otimismo)
      if (typeof LW !== 'undefined' && LW.mostrarAlerta) {
        LW.mostrarAlerta(e.message || 'Não consegui marcar o berço agora.', { tipo: 'erro' });
      }
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
  };

  // Auto-inicia: card sempre visível, sem clique pra abrir. Só sincroniza
  // as MARCAÇÕES periodicamente (ver INTERVALO_SYNC_MARCACOES_MS) — o
  // resumo em si chega de operacao.js assim que ele carregar, não daqui.
  document.addEventListener('DOMContentLoaded', () => {
    _sincronizarMarcacoes();
    setInterval(_sincronizarMarcacoes, INTERVALO_SYNC_MARCACOES_MS);
  });

})();