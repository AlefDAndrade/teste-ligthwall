// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  bateria-atual.js — "Bateria Atual" (popover da topbar)
//
//  Botão ao lado do "Debriefing do Dia", mesmo comportamento (clica
//  pra abrir, clica de novo ou em outro popover pra recolher — ver
//  LWDebriefing.toggle, em debriefing.js, mesmo padrão).
//
//  Mostra os berços da operação em andamento AGORA (não importa em
//  qual tela a pessoa esteja — funciona a partir de qualquer página,
//  igual o Debriefing), no formato visual reaproveitado da grade de
//  Montagem Personalizada (ver operacao.js, _renderGradeMontagem):
//  célula colorida por tipo de montagem, numerada por berço.
//
//  Diferença chave: aqui os berços são SÓ VISUAIS — não dá pra clicar
//  neles pra mudar o tipo (isso só existe em Registrar Operação). O
//  que É clicável são os 2 indicadores dentro de cada célula (● à
//  esquerda, • à direita) — mas, por ora, de propósito, SEM nenhuma
//  ação associada (ver _baCliqueIndicador) — é só a estrutura visual,
//  pronta pra ganhar função numa próxima etapa.
// ============================================================

'use strict';

(function () {

  const $ = id => document.getElementById(id);

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

  // ── Indicadores ●/• de cada célula — INTENCIONALMENTE sem ação ainda.
  // Só existem pra já estarem clicáveis (e visualmente reagirem ao
  // hover — ver .ba-dot:hover no CSS), prontos pra receber uma função
  // de verdade depois, sem precisar redesenhar a grade.
  function _baCliqueIndicador(lado, idxBerco) {
    // (sem função definida por enquanto)
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

    const grid = `<div class="ba-grid">${tipos.map((tipo, i) => {
      const cor = _baCorPorTipo(tipo);
      const numero = String(i + 1).padStart(2, '0');
      return `
        <div class="ba-celula" style="background:${cor ? cor.bg : 'var(--bg-2)'};color:${cor ? cor.cor : 'var(--text-3)'};border:1px solid ${cor ? cor.borda : 'var(--border)'}">
          <span class="ba-dot ba-dot-esquerda" data-idx="${i}" title="Ainda sem função definida">●</span>
          <span class="ba-numero">B${numero}</span>
          <span class="ba-dot ba-dot-direita" data-idx="${i}" title="Ainda sem função definida">•</span>
        </div>`;
    }).join('')}</div>`;

    el.innerHTML = resumo + grid;

    // stopPropagation: clicar no indicador não deve fechar o popover
    // (que fecha em clique fora — ver lógica padrão de .ao-popover).
    el.querySelectorAll('.ba-dot-esquerda').forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        _baCliqueIndicador('esquerda', parseInt(dot.getAttribute('data-idx'), 10));
      });
    });
    el.querySelectorAll('.ba-dot-direita').forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.stopPropagation();
        _baCliqueIndicador('direita', parseInt(dot.getAttribute('data-idx'), 10));
      });
    });
  }

  async function _atualizarConteudo() {
    const el = $('bateria-atual-content');
    if (el) el.innerHTML = 'Carregando...';
    try {
      const dados = await LW.getOperacaoAndamento();
      _renderBateriaAtual(dados);
    } catch (_) {
      if (el) el.innerHTML = '<span class="ba-vazio">Não foi possível carregar a bateria atual.</span>';
    }
  }

  // ---- API pública ----
  window.LWBateriaAtual = {
    toggle(event) {
      if (event) event.stopPropagation();
      const el = $('popover-bateria-atual');
      if (!el) return;
      const wasActive = el.classList.contains('active');
      // Mesmo comportamento do Debriefing: só um popover aberto por vez.
      document.querySelectorAll('.ao-popover').forEach(p => p.classList.remove('active'));
      if (!wasActive) {
        el.classList.add('active');
        _atualizarConteudo(); // busca o snapshot mais recente a cada abertura
      }
    }
  };

})();
