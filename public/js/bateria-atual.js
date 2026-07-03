// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  bateria-atual.js — "Bateria Atual" (card sempre visível em
//  Registrar Operação, logo abaixo de Traços de Injeção)
//
//  Antes era um popover no topbar (clique pra abrir, funcionava em
//  qualquer página) — agora vive fixo nesta tela, sempre visível, sem
//  precisar clicar em nada. Por isso se auto-atualiza sozinho num
//  intervalo (ver INTERVALO_ATUALIZACAO_MS, abaixo), em vez de só
//  buscar dados quando alguém abre um popover.
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

  // A cada quantos ms atualiza sozinho — a operação em andamento muda o
  // tempo todo (id da bateria, tipo de montagem, berços reais...) e este
  // card não tem mais um "abrir" que dispare uma busca nova; sem isso, a
  // pessoa só veria o estado de quando a página carregou.
  const INTERVALO_ATUALIZACAO_MS = 5000;

  // Estado local dos lados marcados (ver GET /bercos-andamento) — mapa
  // esparso em 2 níveis: { 'B1': { esquerda: 'baixou' } }. Lado ausente
  // (ou berço ausente por inteiro) = 'okay'. Recarregado a cada
  // atualização periódica e mantido em memória entre elas, pra alternar
  // (toggle) sem precisar buscar de novo a cada clique.
  let _bercosMarcados = {};

  // Cor por tipo de montagem — mesma função usada na grade de Montagem
  // Personalizada (ver operacao.js). Berço sem tipo definido (null) não
  // chama isso — fica com a cor neutra padrão da célula (ver _renderGrid).
  function _baCorPorTipo(tipo) {
    return tipo ? LW.corPorTipoSimples(tipo) : null;
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

  function _tituloDot(marcado, lado) {
    const nome = lado === 'direita' ? 'direito' : 'esquerdo';
    return marcado
      ? `Indicador ${nome} — marcado como baixou/vazou. Clique pra desfazer.`
      : `Clique pra marcar o indicador ${nome} como baixou/vazou.`;
  }

  function _renderBateriaAtual(dados) {
    const el = $('bateria-atual-content');
    if (!el) return;

    if (!dados || dados.status === 'idle') {
      el.innerHTML = '<span class="ba-vazio">Nenhuma operação em andamento agora.</span>';
      return;
    }

    const capacidade = _baCapacidade(dados);
    const tipos = _baTiposPorBerco(dados, capacidade);

    const resumo = `
      <div class="ba-resumo">
        <strong>Bateria ${dados.id_bateria || '—'}</strong> — ${dados.tipo_montagem || '—'}
        ${dados.bercos_reais ? ` — ${dados.bercos_reais} berços` : ''}
      </div>`;
    const dica = `<div class="ba-dica">🖱️ Clique num indicador (● ou •) para marcar que aquele lado do berço baixou ou vazou. Clique de novo para desfazer — os 2 lados são independentes.</div>`;

    // Fileira única: 1 2 3 4 5 6 7 8 ... (ver .ba-grid no CSS — flex row
    // com scroll horizontal, não mais grid de 2 colunas). A célula em si
    // NÃO é clicável — só os 2 indicadores dentro dela (ver abaixo).
    const grid = `<div class="ba-grid">${tipos.map((tipo, i) => {
      const cor = _baCorPorTipo(tipo);
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
            data-tooltip="${_tituloDot(esqMarcado, 'esquerda')}">●</span>
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
      _atualizarConteudo(); // reconstrói a grade inteira já no estado real
      if (typeof LW !== 'undefined' && LW.mostrarAlerta) {
        LW.mostrarAlerta(e.message || 'Não consegui marcar o berço agora.', { tipo: 'erro' });
      }
    }
  }

  async function _atualizarConteudo() {
    const el = $('bateria-atual-content');
    if (!el) return; // card só existe na tela Registrar Operação
    try {
      const [dados, bercosMarcados] = await Promise.all([
        LW.getOperacaoAndamento(),
        fetch('/bercos-andamento').then(r => r.ok ? r.json() : {}).catch(() => ({})),
      ]);
      _bercosMarcados = bercosMarcados || {};
      _renderBateriaAtual(dados);
    } catch (_) {
      el.innerHTML = '<span class="ba-vazio">Não foi possível carregar a bateria atual.</span>';
    }
  }

  // ---- API pública ----
  window.LWBateriaAtual = {
    atualizar: _atualizarConteudo,
  };

  // Auto-inicia: card sempre visível, sem clique pra abrir — busca os
  // dados assim que a página carrega e depois de tempos em tempos (ver
  // INTERVALO_ATUALIZACAO_MS, acima). O elemento só existe na tela
  // Registrar Operação, então isso é inofensivo/silencioso nas demais
  // (_atualizarConteudo retorna cedo se não achar #bateria-atual-content).
  document.addEventListener('DOMContentLoaded', () => {
    _atualizarConteudo();
    setInterval(_atualizarConteudo, INTERVALO_ATUALIZACAO_MS);
  });

})();