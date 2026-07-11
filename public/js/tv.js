// ─── tv.js — Modo TV / Andon ────────────────────────────────────────────
// Página autocontida (mesmo espírito de login.html): não carrega data.js
// nem app-core.js de propósito — é pra ficar aberta sozinha, indefinidamente,
// num telão da fábrica, sem depender do resto da SPA (sidebar, tema,
// sessão de usuário etc.) nem quebrar se algo lá mudar.
//
// Duas fontes de dado, propositalmente separadas:
//   1) WebSocket (/ws/operacao-andamento) — a MESMA conexão que a tela
//      "Registrar Operação" usa (ver data.js/conectarOperacaoAndamento) —
//      pro card "Operação em Andamento" atualizar instantaneamente, sem
//      esperar o próximo ciclo de polling.
//   2) Polling REST a cada POLL_INTERVALO_MS — pros agregados do dia
//      (traços hoje, produção hoje, fila de qualidade, paradas, OEE), que
//      não têm um canal de push dedicado.
//
// Convenções de data/hora replicadas EXATAMENTE de data.js (ver
// nowBrasilia/dataBrasiliaDeISO lá) — o sistema usa duas convenções
// diferentes conforme o campo:
//   - historico.inicio/fim (e o "agora" do relógio): a hora de parede de
//     Brasília, só que guardada num ISO com "Z" no final (não é UTC de
//     verdade — ver comentário de nowBrasilia() em data.js) — formata-se
//     com { timeZone: 'UTC' } pra mostrar os números tal como foram
//     guardados, sem reconverter.
//   - paradas.inicio/fim: ISO em UTC de verdade (new Date().toISOString()
//     direto) — precisa de conversão real pra Brasília (Intl.DateTimeFormat
//     com timeZone: 'America/Sao_Paulo') pra saber a que dia pertencem.

'use strict';

(function () {

  const POLL_INTERVALO_MS = 30 * 1000; // agregados do dia — não precisam ser instantâneos
  const FILA_QUALIDADE_ALERTA = 5; // a partir de quantas pendentes o card vira vermelho
  const MINUTOS_TURNO_PLANEJADO = 7 * 60; // mesmo parâmetro de oee.js — ver README "OEE"
  const CICLO_IDEAL_MIN = 59;             // idem
  const CAMPOS_INSUMO = ['cimento_real', 'agua_real', 'eps_real', 'superplast_real', 'incorporador_real'];

  const $ = id => document.getElementById(id);

  // ── Escape de HTML — mesma implementação de data.js (_escaparHtml),
  // duplicada aqui de propósito por esta página não carregar data.js (ver
  // cabeçalho do arquivo). ID da Bateria e Tipo de Montagem são texto
  // livre digitado pelo Administrador em Configurações — nunca inseridos
  // sem passar por aqui.
  function _esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Hora/data — réplica de nowBrasilia()/todayBrasilia() (data.js): usa
  // sempre o fuso de Brasília, independente de como o SO do telão estiver
  // configurado, pro relógio nunca discordar do resto do sistema.
  function _nowBrasilia() {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const partes = fmt.formatToParts(now);
    const get = t => partes.find(p => p.type === t).value;
    return new Date(`${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`);
  }

  // Réplica de dataBrasiliaDeISO (data.js) — pra campos que SÃO um UTC de
  // verdade (paradas.inicio/fim), diferente de historico/traços (que já
  // guardam "data" própria, sempre em Brasília).
  function _dataBrasiliaDeISO(iso) {
    if (!iso) return '';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso));
  }

  // Formata um ISO "disfarçado" (historico.inicio/fim) como HH:MM — usa
  // timeZone:'UTC' de propósito (ver cabeçalho do arquivo).
  function _fmtHora(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  }

  // H:MM:SS a partir de minutos — mesmo formato de formatDuration (data.js).
  function _fmtDuracaoMin(minutos) {
    if (!minutos || isNaN(minutos) || minutos < 0) return '0:00:00';
    const totalSeg = Math.round(minutos * 60);
    const h = Math.floor(totalSeg / 3600);
    const m = Math.floor((totalSeg % 3600) / 60);
    const s = totalSeg % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function _fmtPct(pct) {
    if (pct === null || pct === undefined || isNaN(pct)) return '—';
    return `${pct.toFixed(0)}%`;
  }

  // ============================================================
  //  RELÓGIO
  // ============================================================

  function _atualizarRelogio() {
    const agora = _nowBrasilia();
    $('tv-hora').textContent = agora.toLocaleTimeString('pt-BR', { timeZone: 'UTC' });
    $('tv-data').textContent = agora.toLocaleDateString('pt-BR', {
      timeZone: 'UTC', weekday: 'long', day: '2-digit', month: 'long',
    });
  }

  // ============================================================
  //  OPERAÇÃO EM ANDAMENTO — ao vivo via WebSocket
  // ============================================================

  let _wsReconectarTimeout = null;
  let _estadoAtual = null;       // último snapshot recebido do servidor
  let _cronometroInterval = null;

  function _setStatusConexao(ok) {
    const dot = $('tv-status-dot');
    const texto = $('tv-status-texto');
    dot.classList.remove('tv-status-ok', 'tv-status-erro');
    dot.classList.add(ok ? 'tv-status-ok' : 'tv-status-erro');
    texto.textContent = ok ? 'Ao vivo' : 'Reconectando…';
  }

  function _abrirWebSocket() {
    if (typeof WebSocket === 'undefined') return;
    let ws;
    try {
      const protocolo = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocolo}//${window.location.host}/ws/operacao-andamento`);
    } catch (_) {
      _agendarReconexao();
      return;
    }

    ws.addEventListener('open', () => _setStatusConexao(true));

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (!msg || msg.tipo !== 'estado') return; // Modo TV só se importa com o snapshot atual
      _aplicarEstado(msg.dados);
    });

    ws.addEventListener('close', () => { _setStatusConexao(false); _agendarReconexao(); });
    ws.addEventListener('error', () => { /* o 'close' que segue já cuida da reconexão */ });
  }

  function _agendarReconexao() {
    clearTimeout(_wsReconectarTimeout);
    _wsReconectarTimeout = setTimeout(_abrirWebSocket, 3000);
  }

  function _aplicarEstado(dados) {
    _estadoAtual = dados;
    clearInterval(_cronometroInterval);

    const corpo = $('tv-operacao-corpo');

    if (!dados || dados.status !== 'running' || !dados.id_bateria) {
      corpo.innerHTML = '<div class="tv-operacao-vazio">Nenhuma operação em andamento no momento.</div>';
      return;
    }

    corpo.innerHTML = `
      <div class="tv-operacao-ativa">
        <div class="tv-operacao-cronometro" id="tv-cronometro">0:00:00</div>
        <div class="tv-operacao-info">
          <div>
            <div class="tv-operacao-campo-label">Bateria</div>
            <div class="tv-operacao-campo-valor">${_esc(dados.id_bateria)}</div>
          </div>
          <div>
            <div class="tv-operacao-campo-label">Turno</div>
            <div class="tv-operacao-campo-valor">${_esc(dados.turno || '—')}</div>
          </div>
          <div>
            <div class="tv-operacao-campo-label">Tipo de Montagem</div>
            <div class="tv-operacao-campo-valor">${_esc(dados.tipo_montagem || '—')}</div>
          </div>
          <div>
            <div class="tv-operacao-campo-label">Início</div>
            <div class="tv-operacao-campo-valor">${_fmtHora(dados.inicio)}</div>
          </div>
        </div>
      </div>
    `;

    // Cronômetro calculado localmente a partir do "inicio" (mesmo padrão
    // de operacao.js) — não depende de nenhum tick vindo pela rede.
    const atualizarCronometro = () => {
      const el = $('tv-cronometro');
      if (!el || !dados.inicio) return;
      const inicio = new Date(dados.inicio).getTime();
      const agora = _nowBrasilia().getTime();
      const minutos = Math.max(0, (agora - inicio) / 60000);
      el.textContent = _fmtDuracaoMin(minutos);
    };
    atualizarCronometro();
    _cronometroInterval = setInterval(atualizarCronometro, 1000);
  }

  // ============================================================
  //  AGREGADOS DO DIA — polling REST
  // ============================================================

  async function _fetchJSON(url) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      return await r.json();
    } catch (_) {
      return null;
    }
  }

  // Mesma lógica de detecção de ajuste usada em oee.js/qualidade-tracos.js
  // — reproduzida aqui pra "Qualidade" bater com o resto do sistema.
  function _normalizarInsumo(val) {
    if (val === null || val === undefined || val === '') return { ajustes: [] };
    if (typeof val === 'object' && 'ajustes' in val) {
      return { ajustes: Array.isArray(val.ajustes) ? val.ajustes : [] };
    }
    return { ajustes: [] };
  }
  function _tracoTemAjuste(t) {
    return CAMPOS_INSUMO.some(campo => _normalizarInsumo(t[campo]).ajustes.length > 0);
  }
  function _tempoMin(rec) {
    if (rec.tempo_min && rec.tempo_min > 0) return rec.tempo_min;
    if (rec.inicio && rec.fim) {
      const diff = (new Date(rec.fim) - new Date(rec.inicio)) / 60000;
      if (diff > 0) return diff;
    }
    return 0;
  }

  // Réplica exata de _minutosParadaNaoPlanejadaNaJanela/_tempoProduzindoReal
  // (oee.js) — desconta, do tempo produzindo de cada operação, a parcela
  // de paradas NÃO PLANEJADAS que caiu dentro da janela [início,fim] dela
  // (o cronômetro da operação não pausa numa parada — ver README, "OEE").
  function _minutosParadaNaoPlanejadaNaJanela(inicioISO, fimISO, paradas) {
    if (!inicioISO || !fimISO || !paradas || !paradas.length) return 0;
    const ini = new Date(inicioISO).getTime();
    const fim = new Date(fimISO).getTime();
    if (isNaN(ini) || isNaN(fim) || fim <= ini) return 0;

    let totalMs = 0;
    paradas.forEach(p => {
      if (p.classificacao !== 'Não Planejada') return;
      if (!p.inicio || !p.fim) return;
      const pIni = new Date(p.inicio).getTime();
      const pFim = new Date(p.fim).getTime();
      if (isNaN(pIni) || isNaN(pFim)) return;
      const overlapIni = Math.max(ini, pIni);
      const overlapFim = Math.min(fim, pFim);
      if (overlapFim > overlapIni) totalMs += (overlapFim - overlapIni);
    });
    return totalMs / 60000;
  }
  function _tempoProduzindoReal(rec, paradas) {
    const bruto = _tempoMin(rec);
    const descontar = _minutosParadaNaoPlanejadaNaJanela(rec.inicio, rec.fim, paradas);
    return Math.max(0, bruto - descontar);
  }

  async function _atualizarAgregados() {
    const [contador, historico, paradas, tracos, filaQualidade] = await Promise.all([
      _fetchJSON('total-tracos-hoje'),
      _fetchJSON('db/historico.json'),
      _fetchJSON('db/paradas.json'),
      _fetchJSON('db/relatorio_injecao.json'),
      _fetchJSON('operacoes-nao-avaliadas'),
    ]);

    // "Hoje" vem do PRÓPRIO servidor (contador.data, calculado em Brasília
    // — ver todayBrasiliaServer(), server.js) em vez do relógio do
    // navegador do telão: garante que "hoje" bate com o resto do sistema
    // mesmo que o SO do telão esteja com fuso horário errado.
    const hoje = contador?.data || _dataBrasiliaDeISO(new Date().toISOString());

    $('tv-tracos-hoje').textContent = contador ? String(contador.total) : '—';

    // ── Produção hoje (m² + baterias finalizadas) ──────────────────────
    const historicoHoje = Array.isArray(historico) ? historico.filter(h => h.data === hoje) : [];
    const m2Hoje = historicoHoje.reduce((s, h) => s + (h.m2_total || 0), 0);
    $('tv-m2-hoje').textContent = `${m2Hoje.toLocaleString('pt-BR', { maximumFractionDigits: 0 })} m²`;
    $('tv-baterias-hoje').textContent = String(historicoHoje.length);

    // ── Fila de avaliação de qualidade ──────────────────────────────────
    const nFila = Array.isArray(filaQualidade) ? filaQualidade.length : 0;
    const elFila = $('tv-fila-qualidade');
    elFila.textContent = String(nFila);
    elFila.classList.toggle('tv-metrica-alerta', nFila >= FILA_QUALIDADE_ALERTA);

    // Paradas de hoje — filtradas UMA vez (dataBrasiliaDeISO, não o campo
    // "data" cru, ver cabeçalho do arquivo) e reaproveitadas tanto no
    // desconto de Disponibilidade quanto na lista "Últimas Paradas".
    const paradasHoje = (Array.isArray(paradas) ? paradas : [])
      .filter(p => _dataBrasiliaDeISO(p.inicio) === hoje);

    // ── OEE de hoje (Disponibilidade × Performance × Qualidade) ────────
    // Mesma fórmula/parâmetros de oee.js (calcularDisponibilidade/
    // Performance/Qualidade + _renderKPIs), escopados só ao dia de hoje —
    // ver cabeçalho do arquivo pro porquê de duplicar em vez de importar.
    const tracosHoje = Array.isArray(tracos) ? tracos.filter(t => t.data === hoje) : [];

    const tempoProduzindo = historicoHoje.reduce((s, r) => s + _tempoProduzindoReal(r, paradasHoje), 0);
    // Disponibilidade é por TURNO-INSTÂNCIA (420 min cada) — se já rodaram
    // 2 turnos diferentes hoje, o orçamento é 2×420, não 420 fixo (mesmo
    // agrupamento de _agruparPorTurnoInstancia em oee.js; como já filtramos
    // por "hoje", agrupar só por turno já basta).
    const nTurnosHoje = new Set(historicoHoje.map(r => r.turno)).size;
    const tempoPlanejadoHoje = Math.max(1, nTurnosHoje) * MINUTOS_TURNO_PLANEJADO;
    const dispPct = historicoHoje.length
      ? Math.min(100, (tempoProduzindo / tempoPlanejadoHoje) * 100)
      : 0;

    const tempoIdeal = historicoHoje.length * CICLO_IDEAL_MIN;
    const tempoRealBruto = historicoHoje.reduce((s, r) => s + _tempoMin(r), 0);
    const perfPct = (historicoHoje.length && tempoRealBruto > 0)
      ? Math.min(100, (tempoIdeal / tempoRealBruto) * 100)
      : 0;

    const comAjuste = tracosHoje.filter(_tracoTemAjuste).length;
    const qualPct = tracosHoje.length ? ((tracosHoje.length - comAjuste) / tracosHoje.length) * 100 : null;

    const oeePct = (historicoHoje.length && qualPct !== null)
      ? (dispPct / 100) * (perfPct / 100) * (qualPct / 100) * 100
      : null;

    $('tv-oee-turno').textContent = `${historicoHoje.length} operação${historicoHoje.length !== 1 ? 'ões' : ''} hoje`;
    $('tv-oee-disp').textContent = historicoHoje.length ? _fmtPct(dispPct) : '—';
    $('tv-oee-perf').textContent = historicoHoje.length ? _fmtPct(perfPct) : '—';
    $('tv-oee-qual').textContent = qualPct !== null ? _fmtPct(qualPct) : 'sem dado';
    $('tv-oee-final').textContent = oeePct !== null ? _fmtPct(oeePct) : '—';

    // ── Últimas paradas de hoje ─────────────────────────────────────────
    const paradasHojeOrdenadas = paradasHoje
      .slice()
      .sort((a, b) => new Date(b.inicio) - new Date(a.inicio))
      .slice(0, 6);

    const listaEl = $('tv-paradas-lista');
    if (!paradasHojeOrdenadas.length) {
      listaEl.innerHTML = '<div class="tv-paradas-vazio">Nenhuma parada registrada hoje.</div>';
    } else {
      listaEl.innerHTML = paradasHojeOrdenadas.map(p => {
        const planejada = p.classificacao === 'Planejada';
        const duracaoMin = p.duracao_min != null
          ? p.duracao_min
          : (p.inicio && p.fim ? (new Date(p.fim) - new Date(p.inicio)) / 60000 : null);
        const hora = new Date(p.inicio).toLocaleTimeString('pt-BR', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
        });
        return `
          <div class="tv-parada-item">
            <span class="tv-parada-badge ${planejada ? 'tv-parada-badge-planejada' : 'tv-parada-badge-nao-planejada'}">
              ${planejada ? 'Planejada' : 'Não Planejada'}
            </span>
            <span class="tv-parada-equipamento">${_esc(p.equipamento || p.motivo || '—')}</span>
            <span class="tv-parada-duracao">${duracaoMin != null ? _fmtDuracaoMin(duracaoMin) : '—'}</span>
            <span class="tv-parada-hora">${hora}</span>

          </div>
        `;
      }).join('');
    }
  }

  // ============================================================
  //  BOOT
  // ============================================================

  function init() {
    _atualizarRelogio();
    setInterval(_atualizarRelogio, 1000);

    _abrirWebSocket();

    _atualizarAgregados();
    setInterval(_atualizarAgregados, POLL_INTERVALO_MS);
  }

  document.addEventListener('DOMContentLoaded', init);

})();
