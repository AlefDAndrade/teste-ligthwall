// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  analise-bercos.js — Análise de Berços (vazamentos)
// ============================================================
// Fonte dos dados: LW.getRelatorioBercos() — mesma fonte da página
// "Relatório de Berços" (1 linha por bateria, cada uma com sua lista de
// berços e o estado de cada lado: 'okay'/'baixou'). Aqui os dados são
// "achatados" numa lista de POSIÇÕES avaliadas (1 por lado de berço, de
// TODA bateria — inclusive as que não vazaram, necessário pra calcular
// taxa, não só contagem bruta) e agrupados de várias formas.
'use strict';

(function () {

  const C = {
    red:    '#ef4444',
    green:  '#10b981',
    accent: '#f59e0b',
    blue:   '#3b82f6',
    purple: '#8b5cf6',
    border: '#353c4a',
    text:   '#e8eaf0',
    text2:  '#8b93a5',
    text3:  '#5c6475',
  };

  const MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

  let _cache = [];

  // ── Filtro por período ──────────────────────────────────────
  function _filtrar(linhas, ini, fim) {
    return linhas.filter(l => {
      if (!l.data) return true;
      if (ini && l.data < ini) return false;
      if (fim && l.data > fim) return false;
      return true;
    });
  }

  // ── Achata em "posições avaliadas": 1 item por LADO de berço, de toda
  // bateria (vazou ou não) — é o denominador certo pra calcular taxa. ──
  function _achatar(linhas) {
    const pos = [];
    linhas.forEach(l => {
      const mes = l.data ? l.data.slice(0, 7) : null;
      (l.bercos || []).forEach(b => {
        pos.push({
          mes, id_bateria: l.id_bateria, tipo_montagem: l.tipo_montagem,
          berco: b.berco, ordem: b.ordem, lado: 'esquerda',
          vazou: b.estado_esquerda === 'baixou',
        });
        pos.push({
          mes, id_bateria: l.id_bateria, tipo_montagem: l.tipo_montagem,
          berco: b.berco, ordem: b.ordem, lado: 'direita',
          vazou: b.estado_direita === 'baixou',
        });
      });
    });
    return pos;
  }

  // Agrupa posições por uma chave qualquer, contando total avaliado e
  // vazamentos — devolve também a taxa (%) de cada grupo.
  function _agrupar(pos, chaveFn, ordemFn) {
    const mapa = new Map();
    pos.forEach(p => {
      const chave = chaveFn(p);
      if (chave === null || chave === undefined || chave === '') return;
      if (!mapa.has(chave)) mapa.set(chave, { chave, total: 0, vazamentos: 0, ordem: ordemFn ? ordemFn(p) : 0 });
      const e = mapa.get(chave);
      e.total++;
      if (p.vazou) e.vazamentos++;
    });
    return Array.from(mapa.values()).map(e => ({ ...e, pct: e.total ? (e.vazamentos / e.total) * 100 : 0 }));
  }

  // "Pontos de atenção": mais de 3 vazamentos na MESMA bateria + MESMO
  // berço + MESMO mês (id_bateria é o equipamento — ver config.json,
  // "Baterias" — não muda a cada operação, então essa combinação aponta
  // pra um lugar físico específico, não só uma posição genérica "B7").
  const LIMIAR_HOTSPOT = 3; // "acima de 3" = 4 ou mais
  function _hotspots(pos) {
    const mapa = new Map();
    pos.filter(p => p.vazou && p.mes).forEach(p => {
      const chave = `${p.id_bateria}||${p.berco}||${p.mes}`;
      if (!mapa.has(chave)) mapa.set(chave, { id_bateria: p.id_bateria, berco: p.berco, ordem: p.ordem, mes: p.mes, count: 0 });
      mapa.get(chave).count++;
    });
    return Array.from(mapa.values())
      .filter(h => h.count > LIMIAR_HOTSPOT)
      .sort((a, b) => b.count - a.count || a.mes.localeCompare(b.mes));
  }

  function _mesLabel(mes) {
    if (!mes) return '—';
    const [ano, m] = mes.split('-');
    return `${MESES[parseInt(m, 10) - 1] || m}/${ano.slice(2)}`;
  }

  // ── Canvas helpers ──────────────────────────────────────────
  // Trava o tamanho VISÍVEL (canvas.style.width/height) ANTES de ler
  // offsetWidth — mesmo padrão seguro já usado em analise-operacional.js
  // (setupCanvas). Sem isso, o próprio atributo width/height (interno,
  // já multiplicado pelo devicePixelRatio) também vira o tamanho exibido
  // na página, e cada nova renderização lê esse valor já inflado como
  // base — o gráfico cresce sem parar a cada atualização (bug já visto e
  // corrigido em oee.js, _px — aqui nasce corrigido desde o início).
  function _setupCanvas(id, h) {
    const el = document.getElementById(id);
    if (!el) return null;
    const ctx = el.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    el.style.width = '100%';
    el.style.height = h + 'px';
    el.width = el.offsetWidth * ratio;
    el.height = h * ratio;
    ctx.scale(ratio, ratio);
    return { ctx, w: el.offsetWidth, h };
  }

  function _drawBar(id, labels, values, cor, h, formatarTooltip) {
    const c = _setupCanvas(id, h || 170);
    if (!c) return;
    const { ctx, w } = c;
    const canvasEl = document.getElementById(id);
    ctx.clearRect(0, 0, w, c.h);

    if (!labels.length) {
      ctx.fillStyle = C.text3;
      ctx.font = '.84rem sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Sem dados no período', w / 2, c.h / 2);
      return;
    }

    const pad = { top: 20, right: 10, bottom: 30, left: 34 };
    const cw = w - pad.left - pad.right;
    const ch = c.h - pad.top - pad.bottom;
    const max = Math.max(...values, 1);
    const areas = [];

    // Grade horizontal (4 linhas) + escala
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + ch * (1 - i / 4);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      ctx.fillStyle = C.text3;
      ctx.font = '9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(max * i / 4)), pad.left - 4, y + 3);
    }

    const bw = Math.max(5, cw / labels.length - 4);
    labels.forEach((lab, i) => {
      const x = pad.left + i * (cw / labels.length) + (cw / labels.length - bw) / 2;
      const v = values[i] || 0;
      const bh = (v / max) * ch;
      const y = pad.top + ch - bh;
      const corBarra = Array.isArray(cor) ? cor[i] : cor;

      ctx.fillStyle = corBarra;
      ctx.globalAlpha = v > 0 ? 0.9 : 0.25;
      ctx.fillRect(x, v > 0 ? y : pad.top + ch - 2, bw, v > 0 ? bh : 2);
      ctx.globalAlpha = 1;

      if (v > 0 && labels.length <= 24) {
        ctx.fillStyle = C.text2;
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(v), x + bw / 2, y - 4);
      }

      const step = Math.max(1, Math.floor(labels.length / 14));
      if (i % step === 0) {
        ctx.fillStyle = C.text3;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(lab, x + bw / 2, c.h - 10);
      }

      areas.push({
        x, w: bw, y: pad.top, yBase: pad.top + ch,
        texto: formatarTooltip ? formatarTooltip(v, lab, i) : `${lab}: ${v}`,
      });
    });

    if (canvasEl && window.LW && LW.tooltip) {
      LW.tooltip.ligarHoverCanvas(canvasEl, (mx, my) => {
        const hit = areas.find(a => mx >= a.x && mx <= a.x + a.w && my >= a.y && my <= a.yBase);
        return hit ? hit.texto : null;
      });
    }
  }

  // Gráfico de dispersão — cada ponto é 1 USO de traço (ver
  // db.correlacaoTracoBerco()): eixo X = nº de ajustes de receita
  // daquele traço (instabilidade), eixo Y = % de vazamento dos berços
  // que ele encheu. `pontos` é um array de {x, y, raio, texto}.
  function _drawScatter(id, pontos, cor, h) {
    const c = _setupCanvas(id, h || 220);
    if (!c) return;
    const { ctx, w } = c;
    const canvasEl = document.getElementById(id);
    ctx.clearRect(0, 0, w, c.h);

    if (!pontos.length) {
      ctx.fillStyle = C.text3;
      ctx.font = '.84rem sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Sem dados suficientes no período (precisa de traços com berço início/fim preenchidos)', w / 2, c.h / 2);
      return;
    }

    const pad = { top: 16, right: 16, bottom: 32, left: 38 };
    const cw = w - pad.left - pad.right;
    const ch = c.h - pad.top - pad.bottom;
    const maxX = Math.max(...pontos.map(p => p.x), 1);
    const maxY = 100; // eixo Y é sempre % (0-100), fixo pra facilitar comparar entre re-renders
    const areas = [];

    // Grade + escalas dos 2 eixos
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.font = '9px monospace';
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + ch * (1 - i / 4);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      ctx.fillStyle = C.text3; ctx.textAlign = 'right';
      ctx.fillText(Math.round(maxY * i / 4) + '%', pad.left - 4, y + 3);
    }
    const passoX = Math.max(1, Math.round(maxX / 6));
    for (let vx = 0; vx <= maxX; vx += passoX) {
      const x = pad.left + (vx / maxX) * cw;
      ctx.fillStyle = C.text3; ctx.textAlign = 'center';
      ctx.fillText(String(vx), x, c.h - 10);
    }
    ctx.fillStyle = C.text3;
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('nº de ajustes de receita do traço →', pad.left + cw / 2, c.h - 1);

    pontos.forEach(p => {
      const x = pad.left + (maxX ? (p.x / maxX) * cw : cw / 2);
      const y = pad.top + ch * (1 - Math.min(p.y, 100) / 100);
      const raio = p.raio || 4;

      ctx.beginPath();
      ctx.arc(x, y, raio, 0, Math.PI * 2);
      ctx.fillStyle = cor;
      ctx.globalAlpha = 0.7;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = cor;
      ctx.lineWidth = 1;
      ctx.stroke();

      areas.push({ x: x - raio - 2, w: raio * 2 + 4, y: y - raio - 2, yBase: y + raio + 2, texto: p.texto });
    });

    if (canvasEl && window.LW && LW.tooltip) {
      LW.tooltip.ligarHoverCanvas(canvasEl, (mx, my) => {
        const hit = areas.find(a => mx >= a.x && mx <= a.x + a.w && my >= a.y && my <= a.yBase);
        return hit ? hit.texto : null;
      });
    }
  }

  function _fmtNum(v, casas = 1) {
    if (v === null || v === undefined || v === '' || isNaN(v)) return '—';
    return Number(v).toFixed(casas);
  }

  // 1 linha da tabela Traço × Berço — reaproveitada tanto pra "Piores
  // Casos" quanto pra "Referência" (mesmo formato, filtros diferentes).
  function _linhaTracoBerco(c) {
    const dataLabel = c.data ? c.data.split('-').reverse().join('/') : '—';
    const cor = c.taxa_vazamento > 0 ? C.red : C.green;
    return `
      <tr>
        <td class="mono">${LW.escaparHtml(String(c.id_traco))}</td>
        <td class="mono" title="${LW.escaparHtml(c.turno || '')}">${dataLabel}</td>
        <td class="mono">${LW.escaparHtml(String(c.id_bateria ?? '—'))}</td>
        <td class="mono">B${c.berco_inicio}-B${c.berco_finalizacao}</td>
        <td style="text-align:right">${c.num_ajustes}</td>
        <td style="text-align:right;font-family:var(--font-mono)">${_fmtNum(c.densidade)}</td>
        <td style="text-align:right;font-family:var(--font-mono)">${_fmtNum(c.flow)}</td>
        <td style="text-align:right;font-weight:700;color:${cor}">${_fmtNum(c.taxa_vazamento, 0)}%</td>
      </tr>`;
  }

  // Duas listas lado a lado, pra comparar receita de quem vazou muito com
  // quem não vazou nada: "Piores Casos" (taxa > 0, pior primeiro — empate
  // desempata por nº de ajustes, já que mais ajuste = mais instável) e
  // "Referência" (taxa == 0, menos ajuste primeiro — os exemplos mais
  // "redondos" de traço estável e sem vazamento).
  function _renderTabelaTracoBerco(correlacoes) {
    const tbodyPiores = document.getElementById('ab-traco-piores-tbody');
    const tbodyMelhores = document.getElementById('ab-traco-melhores-tbody');
    if (!tbodyPiores || !tbodyMelhores) return;

    const semDados = `<tr><td colspan="8" style="text-align:center;color:${C.text3};padding:16px">Sem dados suficientes no período.</td></tr>`;

    const piores = correlacoes.filter(c => c.taxa_vazamento > 0)
      .sort((a, b) => b.taxa_vazamento - a.taxa_vazamento || b.num_ajustes - a.num_ajustes)
      .slice(0, 10);
    const melhores = correlacoes.filter(c => c.taxa_vazamento === 0)
      .sort((a, b) => a.num_ajustes - b.num_ajustes)
      .slice(0, 10);

    tbodyPiores.innerHTML = piores.length ? piores.map(_linhaTracoBerco).join('') : semDados;
    tbodyMelhores.innerHTML = melhores.length ? melhores.map(_linhaTracoBerco).join('') : semDados;
  }

  // Compara a taxa de vazamento do 1º traço de cada bateria (menor
  // berco_inicio) com a do ÚLTIMO (maior berco_finalizacao) — testa a
  // hipótese de fadiga/aquecimento: será que o molde/máquina piora ao
  // longo da bateria, ou o vazamento é uniforme do início ao fim? Só
  // entram baterias com 2+ usos de traço (senão "1º" e "último" seriam o
  // mesmo traço, sem nada pra comparar).
  function _compararPrimeiroUltimoTraco(correlacoes) {
    const porOperacao = new Map();
    correlacoes.forEach(c => {
      if (!porOperacao.has(c.id_operacao)) porOperacao.set(c.id_operacao, []);
      porOperacao.get(c.id_operacao).push(c);
    });

    let totalPrimeiro = 0, vazPrimeiro = 0, totalUltimo = 0, vazUltimo = 0, nBaterias = 0;
    porOperacao.forEach(usos => {
      if (usos.length < 2) return;
      const ordenados = usos.slice().sort((a, b) => a.berco_inicio - b.berco_inicio);
      const primeiro = ordenados[0];
      const ultimo = ordenados[ordenados.length - 1];
      totalPrimeiro += primeiro.total_lados; vazPrimeiro += primeiro.vazamentos;
      totalUltimo += ultimo.total_lados; vazUltimo += ultimo.vazamentos;
      nBaterias++;
    });

    return {
      nBaterias,
      taxaPrimeiro: totalPrimeiro ? (vazPrimeiro / totalPrimeiro) * 100 : null,
      taxaUltimo: totalUltimo ? (vazUltimo / totalUltimo) * 100 : null,
    };
  }

  function _renderComparativoPrimeiroUltimo(comp) {
    const el = document.getElementById('ab-comparativo-traco');
    if (!el) return;

    if (!comp.nBaterias || comp.taxaPrimeiro === null || comp.taxaUltimo === null) {
      el.innerHTML = `<div style="color:${C.text3};font-size:.84rem;text-align:center;padding:20px 0">Sem baterias suficientes no período com 2 ou mais traços pra comparar (precisa de pelo menos 1º e último traço distintos).</div>`;
      return;
    }

    const diff = comp.taxaUltimo - comp.taxaPrimeiro;
    const corDiff = Math.abs(diff) < 5 ? C.text3 : (diff > 0 ? C.red : C.green);
    const setaDiff = diff > 0 ? '▲' : diff < 0 ? '▼' : '—';

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:16px;align-items:center">
        <div style="text-align:center">
          <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:${C.text3};margin-bottom:6px">1º Traço da Bateria</div>
          <div style="font-size:1.8rem;font-weight:800;color:${C.blue}">${comp.taxaPrimeiro.toFixed(1)}%</div>
        </div>
        <div style="text-align:center;color:${corDiff};font-size:1.3rem;font-weight:700">
          ${setaDiff}<br><span style="font-size:.68rem;font-weight:400">${Math.abs(diff).toFixed(1)} p.p.</span>
        </div>
        <div style="text-align:center">
          <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:${C.text3};margin-bottom:6px">Último Traço da Bateria</div>
          <div style="font-size:1.8rem;font-weight:800;color:${C.purple}">${comp.taxaUltimo.toFixed(1)}%</div>
        </div>
      </div>
      <div style="text-align:center;font-size:.72rem;color:${C.text3};margin-top:12px">
        Baseado em ${comp.nBaterias} bateria${comp.nBaterias > 1 ? 's' : ''} com 2 ou mais traços no período
      </div>`;
  }

  // ── Insights automáticos ─────────────────────────────────────
  function _gerarInsights(ctx) {
    const { totalVazamentos, taxaGeral, porBerco, porBateria, porMontagem, porLado, porMes, hotspots, correlacoes, comparativoTraco } = ctx;
    const insights = [];

    if (!totalVazamentos) {
      insights.push({ tipo: 'success', icon: '✅', texto: 'Nenhum vazamento registrado no período selecionado.' });
      return insights;
    }

    // 1. Pontos de atenção (regra pedida: >3 no mesmo berço+bateria+mês)
    hotspots.slice(0, 5).forEach(h => {
      insights.push({
        tipo: 'danger', icon: '🚨',
        texto: `Bateria <strong>${LW.escaparHtml(String(h.id_bateria ?? '—'))}</strong> — berço <strong>${h.berco}</strong> vazou <strong>${h.count}×</strong> em ${_mesLabel(h.mes)} — recorrência no mesmo lugar, vale inspecionar.`,
      });
    });

    // 2. Berço com taxa de vazamento bem acima da média (só considera
    // berços com uso mínimo, pra não apontar ruído de amostra pequena)
    const bercosComUso = porBerco.filter(b => b.total >= 5);
    const mediaBerco = bercosComUso.length ? bercosComUso.reduce((a, b) => a + b.pct, 0) / bercosComUso.length : 0;
    const bercoTop = bercosComUso.slice().sort((a, b) => b.pct - a.pct)[0];
    if (bercoTop && mediaBerco > 0 && bercoTop.pct > mediaBerco * 1.5 && bercoTop.vazamentos >= 3) {
      insights.push({
        tipo: 'warning', icon: '📍',
        texto: `Berço <strong>${bercoTop.chave}</strong> vaza em <strong>${bercoTop.pct.toFixed(0)}%</strong> das vezes em que foi usado — bem acima da média geral (${mediaBerco.toFixed(0)}%).`,
      });
    }

    // 3. Bateria (equipamento) com taxa acima da média
    const bateriasComUso = porBateria.filter(b => b.total >= 5);
    const mediaBateria = bateriasComUso.length ? bateriasComUso.reduce((a, b) => a + b.pct, 0) / bateriasComUso.length : 0;
    const bateriaTop = bateriasComUso.slice().sort((a, b) => b.pct - a.pct)[0];
    if (bateriaTop && mediaBateria > 0 && bateriaTop.pct > mediaBateria * 1.5 && bateriaTop.vazamentos >= 3) {
      insights.push({
        tipo: 'warning', icon: '🔋',
        texto: `Bateria <strong>${LW.escaparHtml(String(bateriaTop.chave))}</strong> tem taxa de vazamento de <strong>${bateriaTop.pct.toFixed(0)}%</strong>, bem acima da média das demais (${mediaBateria.toFixed(0)}%) — pode valer inspecionar o equipamento.`,
      });
    }

    // 4. Tipo de montagem — pior vs melhor
    const montagensComUso = porMontagem.filter(m => m.total >= 5).sort((a, b) => b.pct - a.pct);
    if (montagensComUso.length >= 2) {
      const pior = montagensComUso[0], melhor = montagensComUso[montagensComUso.length - 1];
      if (pior.pct > melhor.pct + 10) {
        insights.push({
          tipo: 'info', icon: '🔩',
          texto: `Montagem <strong>${LW.escaparHtml(String(pior.chave))}</strong> tem ${pior.pct.toFixed(0)}% de vazamento, contra ${melhor.pct.toFixed(0)}% em <strong>${LW.escaparHtml(String(melhor.chave))}</strong> — diferença expressiva.`,
        });
      }
    }

    // 5. Lado mais afetado
    const esq = porLado.find(l => l.chave === 'esquerda');
    const dir = porLado.find(l => l.chave === 'direita');
    if (esq && dir) {
      const totalLados = esq.vazamentos + dir.vazamentos;
      if (totalLados >= 5) {
        const pctEsq = (esq.vazamentos / totalLados) * 100;
        if (Math.abs(pctEsq - 50) > 15) {
          const pior = pctEsq > 50 ? 'Esquerdo' : 'Direito';
          const pctPior = pctEsq > 50 ? pctEsq : 100 - pctEsq;
          insights.push({
            tipo: 'info', icon: '↔️',
            texto: `Lado <strong>${pior}</strong> concentra <strong>${pctPior.toFixed(0)}%</strong> de todos os vazamentos registrados.`,
          });
        }
      }
    }

    // 6. Tendência: último mês com dado vs anterior
    const mesesOrdenados = porMes.slice().sort((a, b) => String(a.chave).localeCompare(String(b.chave)));
    if (mesesOrdenados.length >= 2) {
      const ultimo = mesesOrdenados[mesesOrdenados.length - 1];
      const anterior = mesesOrdenados[mesesOrdenados.length - 2];
      if (anterior.vazamentos > 0) {
        const variacao = ((ultimo.vazamentos - anterior.vazamentos) / anterior.vazamentos) * 100;
        if (variacao > 30) {
          insights.push({
            tipo: 'danger', icon: '📈',
            texto: `Vazamentos em ${_mesLabel(ultimo.chave)} subiram <strong>${variacao.toFixed(0)}%</strong> em relação a ${_mesLabel(anterior.chave)}.`,
          });
        } else if (variacao < -30) {
          insights.push({
            tipo: 'success', icon: '📉',
            texto: `Vazamentos em ${_mesLabel(ultimo.chave)} caíram <strong>${Math.abs(variacao).toFixed(0)}%</strong> em relação a ${_mesLabel(anterior.chave)}.`,
          });
        }
      }
    }

    // 7. Traço instável × vazamento — compara a taxa média de vazamento
    // entre usos de traço SEM nenhum ajuste de receita e usos COM pelo
    // menos 1 ajuste (ver db.correlacaoTracoBerco — cada item é 1 uso de
    // traço, já com nº de ajustes e taxa de vazamento dos berços que ele
    // encheu). Exige amostra mínima dos dois lados pra não comparar 2
    // traços com 200.
    if (correlacoes && correlacoes.length >= 8) {
      const semAjuste = correlacoes.filter(c => c.num_ajustes === 0);
      const comAjuste = correlacoes.filter(c => c.num_ajustes > 0);
      if (semAjuste.length >= 3 && comAjuste.length >= 3) {
        const mediaSem = semAjuste.reduce((a, c) => a + c.taxa_vazamento, 0) / semAjuste.length;
        const mediaCom = comAjuste.reduce((a, c) => a + c.taxa_vazamento, 0) / comAjuste.length;
        if (mediaCom > mediaSem + 10) {
          insights.push({
            tipo: 'warning', icon: '🧪',
            texto: `Traços que precisaram de ajuste de receita vazam mais: <strong>${mediaCom.toFixed(0)}%</strong> dos berços que encheram, contra <strong>${mediaSem.toFixed(0)}%</strong> em traços sem nenhum ajuste — vale olhar o gráfico de dispersão abaixo.`,
          });
        } else if (mediaSem > mediaCom + 10) {
          insights.push({
            tipo: 'info', icon: '🧪',
            texto: `Traços sem ajuste de receita tiveram taxa de vazamento igual ou maior que os ajustados (${mediaSem.toFixed(0)}% vs ${mediaCom.toFixed(0)}%) — não há indício de que o ajuste em si esteja causando vazamento.`,
          });
        }
      }
    }

    // 8. 1º traço × último traço da bateria — testa a hipótese de fadiga/
    // aquecimento de molde ao longo da bateria (ver comparativoTraco,
    // calculado em _compararPrimeiroUltimoTraco).
    if (comparativoTraco && comparativoTraco.nBaterias >= 5 && comparativoTraco.taxaPrimeiro !== null && comparativoTraco.taxaUltimo !== null) {
      const diff = comparativoTraco.taxaUltimo - comparativoTraco.taxaPrimeiro;
      if (diff > 10) {
        insights.push({
          tipo: 'warning', icon: '🔄',
          texto: `O último traço de cada bateria vaza mais que o primeiro: <strong>${comparativoTraco.taxaUltimo.toFixed(0)}%</strong> contra <strong>${comparativoTraco.taxaPrimeiro.toFixed(0)}%</strong> — indício de fadiga/aquecimento do molde ao longo da bateria.`,
        });
      } else if (diff < -10) {
        insights.push({
          tipo: 'info', icon: '🔄',
          texto: `O primeiro traço de cada bateria vaza mais que o último (${comparativoTraco.taxaPrimeiro.toFixed(0)}% vs ${comparativoTraco.taxaUltimo.toFixed(0)}%) — pode valer revisar o início da montagem do molde.`,
        });
      }
    }

    if (!insights.length) {
      insights.push({
        tipo: 'info', icon: 'ℹ️',
        texto: `Taxa geral de vazamento no período: <strong>${taxaGeral.toFixed(1)}%</strong> — nenhum ponto fora do padrão detectado.`,
      });
    }

    return insights.slice(0, 10);
  }

  function _renderInsights(insights) {
    const el = document.getElementById('ab-insights');
    if (!el) return;
    const colorMap  = { danger: 'rgba(239,68,68,.1)', warning: 'rgba(245,158,11,.1)', success: 'rgba(16,185,129,.1)', info: 'rgba(59,130,246,.1)' };
    const borderMap = { danger: C.red, warning: C.accent, success: C.green, info: C.blue };
    el.innerHTML = insights.map(ins => `
      <div style="
        background:${colorMap[ins.tipo] || colorMap.info};
        border-left:3px solid ${borderMap[ins.tipo] || C.blue};
        border-radius:0 8px 8px 0;
        padding:10px 14px;
        margin-bottom:8px;
        font-size:.84rem;
        color:${C.text};
        line-height:1.5;
      ">
        <span style="margin-right:6px">${ins.icon}</span>${ins.texto}
      </div>`).join('');
  }

  // Mesmos termos de busca do normalizarMotivo() em analise-operacional.js
  // — não dá pra reaproveitar a função de lá (módulo isolado/privado),
  // então replica só o pedaço que importa aqui: reconhecer se um
  // motivo_atraso já registrado é sobre vazamento/reinjeção.
  function _ehMotivoVazamento(motivo) {
    if (!motivo) return false;
    const s = String(motivo).toLowerCase();
    return s.includes('vazamento') || s.includes('vasamento') || s.includes('reinjec');
  }

  // Mapa "bateria + mês que teve atraso classificado como vazamento" —
  // usado pra cruzar com os Pontos de Atenção (mesma bateria/berço/mês
  // com >3 vazamentos): confirma se o vazamento marcado no berço bate com
  // um atraso que já foi registrado por esse motivo, na mesma bateria e
  // mês (não necessariamente na mesma operação — um atraso é por
  // operação, um hotspot é por mês inteiro).
  function _mapaAtrasoVazamento(linhas) {
    const mapa = new Set();
    linhas.forEach(l => {
      if (l.houve_atraso === 'SIM' && _ehMotivoVazamento(l.motivo_atraso) && l.data) {
        mapa.add(`${l.id_bateria}||${l.data.slice(0, 7)}`);
      }
    });
    return mapa;
  }

  function _renderHotspots(hotspots, atrasoMapa) {
    const card  = document.getElementById('ab-hotspots-card');
    const tbody = document.getElementById('ab-hotspots-tbody');
    if (!card || !tbody) return;
    if (!hotspots.length) { card.style.display = 'none'; return; }
    card.style.display = '';
    tbody.innerHTML = hotspots.map(h => {
      const teveAtraso = atrasoMapa && atrasoMapa.has(`${h.id_bateria}||${h.mes}`);
      return `
      <tr>
        <td class="mono">${LW.escaparHtml(String(h.id_bateria ?? '—'))}</td>
        <td class="mono">${h.berco}</td>
        <td>${_mesLabel(h.mes)}</td>
        <td style="font-weight:700;color:${C.red}">${h.count}</td>
        <td style="text-align:center" title="${teveAtraso ? 'Essa bateria teve pelo menos 1 operação com atraso classificado como Vazamento/Reinjeção nesse mês' : 'Nenhum atraso classificado como Vazamento/Reinjeção registrado nessa bateria/mês'}">${teveAtraso ? '✅' : '—'}</td>
      </tr>`;
    }).join('');
  }

  function _renderKpis(ctx) {
    const { totalVazamentos, totalPosicoes, taxaGeral, totalBaterias, porBerco, porBateria, porMontagem, porLado } = ctx;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    set('ab-kpi-total', totalVazamentos);
    set('ab-kpi-baterias', totalBaterias);
    set('ab-kpi-taxa', totalPosicoes ? taxaGeral.toFixed(1) + '%' : '—');

    const bercoTop = porBerco.slice().sort((a, b) => b.vazamentos - a.vazamentos)[0];
    set('ab-kpi-berco-top', bercoTop && bercoTop.vazamentos ? `${bercoTop.chave} (${bercoTop.vazamentos}×)` : '—');

    const bateriaTop = porBateria.slice().sort((a, b) => b.vazamentos - a.vazamentos)[0];
    set('ab-kpi-bateria-top', bateriaTop && bateriaTop.vazamentos ? `${bateriaTop.chave} (${bateriaTop.vazamentos}×)` : '—');

    const montagemTop = porMontagem.slice().sort((a, b) => b.vazamentos - a.vazamentos)[0];
    set('ab-kpi-montagem-top', montagemTop && montagemTop.vazamentos ? `${montagemTop.chave} (${montagemTop.vazamentos}×)` : '—');

    const esq = porLado.find(l => l.chave === 'esquerda');
    const dir = porLado.find(l => l.chave === 'direita');
    const totalLados = (esq?.vazamentos || 0) + (dir?.vazamentos || 0);
    set('ab-kpi-lado', totalLados ? `Esq. ${esq?.vazamentos || 0} · Dir. ${dir?.vazamentos || 0}` : '—');
  }

  // ── Render principal ─────────────────────────────────────────
  async function render() {
    const loading = document.getElementById('ab-loading');
    const empty   = document.getElementById('ab-empty');
    const content = document.getElementById('ab-content');
    if (loading) loading.style.display = '';
    if (empty) empty.style.display = 'none';
    if (content) content.style.display = 'none';

    _cache = await LW.getRelatorioBercos();

    const ini = document.getElementById('ab-data-inicio')?.value || '';
    const fim = document.getElementById('ab-data-fim')?.value || '';
    const linhas = _filtrar(_cache, ini, fim);

    if (loading) loading.style.display = 'none';

    if (!linhas.length) {
      if (empty) empty.style.display = '';
      return;
    }
    if (content) content.style.display = '';

    const pos = _achatar(linhas);
    const totalPosicoes = pos.length;
    const totalVazamentos = pos.filter(p => p.vazou).length;
    const taxaGeral = totalPosicoes ? (totalVazamentos / totalPosicoes) * 100 : 0;

    const porBerco    = _agrupar(pos, p => p.berco, p => p.ordem).sort((a, b) => a.ordem - b.ordem);
    const porBateria  = _agrupar(pos, p => p.id_bateria);
    const porMontagem = _agrupar(pos, p => p.tipo_montagem);
    const porLado     = _agrupar(pos, p => p.lado);
    const porMes      = _agrupar(pos, p => p.mes).sort((a, b) => String(a.chave).localeCompare(String(b.chave)));
    const hotspots    = _hotspots(pos);

    // Traço × Berço: fonte própria (correlacao_traco_berco.json — 1 item
    // por USO de traço, não por bateria), então tem seu próprio filtro de
    // período em vez de reaproveitar "linhas" (que é por bateria).
    const correlacoes = _filtrar(await LW.getCorrelacaoTracoBerco(), ini, fim)
      .filter(c => c.taxa_vazamento !== null);

    // Bateria+mês que já teve atraso classificado como Vazamento/Reinjeção
    // — cruza com os Pontos de Atenção (coluna extra na tabela de
    // hotspots, ver _renderHotspots).
    const atrasoMapa = _mapaAtrasoVazamento(linhas);

    // 1º traço × último traço de cada bateria — testa fadiga/aquecimento
    // de molde ao longo da bateria (ver _compararPrimeiroUltimoTraco).
    const comparativoTraco = _compararPrimeiroUltimoTraco(correlacoes);

    const ctx = { totalVazamentos, totalPosicoes, taxaGeral, totalBaterias: linhas.length, porBerco, porBateria, porMontagem, porLado, porMes, hotspots, correlacoes, comparativoTraco };

    _renderKpis(ctx);
    _renderInsights(_gerarInsights(ctx));
    _renderHotspots(hotspots, atrasoMapa);
    _renderTabelaTracoBerco(correlacoes);
    _renderComparativoPrimeiroUltimo(comparativoTraco);

    // Canvas precisa do layout já aplicado (display do card mudou agora
    // mesmo, acima) — mesmo motivo de requestAnimationFrame já usado em
    // oee.js/analise-operacional.js antes de desenhar.
    requestAnimationFrame(() => {
      _drawBar('ab-chart-berco', porBerco.map(b => b.chave), porBerco.map(b => b.vazamentos), C.red, 180,
        (v, lab, i) => `${lab}: ${v} vazamento(s) de ${porBerco[i].total} avaliações (${porBerco[i].pct.toFixed(0)}%)`);

      const montagemOrdenada = porMontagem.slice().sort((a, b) => b.vazamentos - a.vazamentos);
      _drawBar('ab-chart-montagem', montagemOrdenada.map(m => m.chave), montagemOrdenada.map(m => m.vazamentos), C.accent, 170,
        (v, lab, i) => `${lab}: ${v} vazamento(s) (${montagemOrdenada[i].pct.toFixed(0)}%)`);

      const bateriaOrdenada = porBateria.slice().sort((a, b) => b.vazamentos - a.vazamentos).slice(0, 15);
      _drawBar('ab-chart-bateria', bateriaOrdenada.map(b => String(b.chave)), bateriaOrdenada.map(b => b.vazamentos), C.purple, 170,
        (v, lab, i) => `Bateria ${lab}: ${v} vazamento(s) (${bateriaOrdenada[i].pct.toFixed(0)}%)`);

      _drawBar('ab-chart-mes', porMes.map(m => _mesLabel(m.chave)), porMes.map(m => m.vazamentos), C.blue, 180,
        (v, lab) => `${lab}: ${v} vazamento(s)`);

      // Cada ponto = 1 uso de traço. Raio maior = mais berços avaliados
      // naquele uso (amostra maior, ponto mais "confiável").
      const pontosTraco = correlacoes.map(c => ({
        x: c.num_ajustes,
        y: c.taxa_vazamento,
        raio: Math.min(10, 3 + Math.sqrt(c.bercos_avaliados)),
        texto: `Traço ${c.id_traco} — Bateria ${LW.escaparHtml(String(c.id_bateria ?? '—'))} (${_mesLabel(c.data ? c.data.slice(0, 7) : null)}): `
          + `${c.num_ajustes} ajuste${c.num_ajustes === 1 ? '' : 's'} de receita, ${c.taxa_vazamento.toFixed(0)}% de vazamento em ${c.bercos_avaliados} berço(s) (B${c.berco_inicio}-B${c.berco_finalizacao})`,
      }));
      _drawScatter('ab-chart-traco-scatter', pontosTraco, C.purple, 220);
    });
  }

  function init() {
    document.getElementById('btn-ab-filtrar')?.addEventListener('click', render);
    render();
  }

  window.ABercos = { init, render };
})();