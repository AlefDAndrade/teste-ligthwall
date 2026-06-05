// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  data.js — Storage, constants, calculation logic
// ============================================================

'use strict';

// ---- Constants (fixas) ----

const TURNO_OPTS = ['1º TURNO', '2º TURNO', '3º TURNO'];
const M2_POR_PAINEL = 1.83;  // m² por painel (calculado da planilha original)
const LIMITE_INJECAO_MIN = 59;    // minutos limite antes de registrar atraso

// ---- Config dinâmica — carregada de config.json ----
// Defaults vazios; preenchidos por loadConfig()
let DIMENSAO_OPTS = [];
let MONTAGEM_OPTS = [];   // ['2/P', 'S/P', 'HÍBRIDA', ...]
let MONTAGEM_MAP = {};   // { label: { paineis_2p_por_berco, paineis_sp_por_berco } }
let BATERIA_IDS = [];

let _configReady = false;
const _configCallbacks = [];

async function loadConfig() {
  if (_configReady) return;
  try {
    const res = await fetch('config.json');
    if (!res.ok) throw new Error('config.json não encontrado');
    const cfg = await res.json();

    // Se não houver chave 'dimensoes', extraímos das baterias (nova estrutura)
    if (cfg.dimensoes?.opcoes) {
      DIMENSAO_OPTS = cfg.dimensoes.opcoes.map(d => ({ label: d.label, bercos: d.bercos }));
    } else if (cfg.baterias?.ids) {
      const uniqueDims = new Map();
      cfg.baterias.ids.forEach(b => {
        if (b.label && b.bercos) {
          uniqueDims.set(b.label, b.bercos);
        }
      });
      DIMENSAO_OPTS = Array.from(uniqueDims.entries()).map(([label, bercos]) => ({ label, bercos }));
    }

    MONTAGEM_OPTS = cfg.tipos_montagem.opcoes.map(t => t.label);
    MONTAGEM_MAP = {};
    cfg.tipos_montagem.opcoes.forEach(t => {
      MONTAGEM_MAP[t.label] = {
        paineis_2p_por_berco: t.paineis_2p_por_berco,
        paineis_sp_por_berco: t.paineis_sp_por_berco,
      };
    });

    BATERIA_IDS = cfg.baterias.ids;

  } catch (err) {
    console.warn('[LW] Usando valores fallback — config.json indisponível:', err.message);
    DIMENSAO_OPTS = [
      { label: '7,5 cm', bercos: 22 },
      { label: '9 cm', bercos: 20 },
      { label: '12 cm', bercos: 18 },
    ];
    MONTAGEM_OPTS = ['2/P', 'S/P', 'HÍBRIDA'];
    MONTAGEM_MAP = {
      '2/P': { paineis_2p_por_berco: 2, paineis_sp_por_berco: 0 },
      'S/P': { paineis_2p_por_berco: 0, paineis_sp_por_berco: 2 },
      'HÍBRIDA': { paineis_2p_por_berco: 1, paineis_sp_por_berco: 1 },
    };
    BATERIA_IDS = ['B1', 'B2', 'B3', 'B4', 'B5-7,5cm', 'B6-12cm', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12'];
  }

  // Se o admin salvou uma config customizada, ela tem prioridade
  const override = localStorage.getItem('lw_config_override');
  if (override) {
    try {
      const cfg = JSON.parse(override);
      BATERIA_IDS = cfg.baterias.ids;
      DIMENSAO_OPTS = cfg.dimensoes.opcoes;
      MONTAGEM_OPTS = cfg.tipos_montagem.opcoes.map(t => t.label);
      MONTAGEM_MAP = {};
      cfg.tipos_montagem.opcoes.forEach(t => {
        MONTAGEM_MAP[t.label] = {
          paineis_2p_por_berco: t.paineis_2p_por_berco,
          paineis_sp_por_berco: t.paineis_sp_por_berco
        };
      });
    } catch (e) { console.warn('Config override inválida', e); }
  }

  _configReady = true;
  _configCallbacks.forEach(fn => fn());
  _configCallbacks.length = 0;
}

/** Executa fn imediatamente se config já carregou, senão aguarda. */
function waitConfig(fn) {
  if (_configReady) { fn(); return; }
  _configCallbacks.push(fn);
}

// ---- LocalStorage helpers ----

const DB_KEY_BATERIAS = 'lw_baterias';
const DB_KEY_INJECOES = 'lw_injecoes';
const DB_KEY_OP_CURRENT = 'lw_op_current';

function loadDB(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveDB(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}

function getOperacaoAtual() {
  try {
    const raw = localStorage.getItem(DB_KEY_OP_CURRENT);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveOperacaoAtual(op) {
  localStorage.setItem(DB_KEY_OP_CURRENT, JSON.stringify(op));
}

function clearOperacaoAtual() {
  localStorage.removeItem(DB_KEY_OP_CURRENT);
}

// ---- Calculation helpers ----

function getBercosByDimensao(dim) {
  const found = DIMENSAO_OPTS.find(d => d.label === dim);
  return found ? found.bercos : 20;
}

function calcPaineis(tipoMontagem, bercos) {
  const map = MONTAGEM_MAP[tipoMontagem];
  let paineis_2p, paineis_sp;
  if (map) {
    paineis_2p = bercos * map.paineis_2p_por_berco;
    paineis_sp = bercos * map.paineis_sp_por_berco;
  } else {
    paineis_2p = 0;
    paineis_sp = bercos * 2;
  }
  const paineis_total = paineis_2p + paineis_sp;
  const m2_total = paineis_total * M2_POR_PAINEL;
  const m2_2p = paineis_2p * M2_POR_PAINEL;
  const m2_sp = paineis_sp * M2_POR_PAINEL;
  const placas_cimenticia = paineis_2p * 2;
  return { total_paineis: paineis_total, paineis_2p, paineis_sp, m2_total, m2_2p, m2_sp, placas_cimenticia };
}

function formatTime(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleDateString('pt-BR');
}

function diffMinutes(start, end) {
  const s = new Date(start), e = new Date(end);
  return (e - s) / 60000;
}

function formatDuration(minutes) {
  if (!minutes || isNaN(minutes)) return '—';
  const m = Math.floor(minutes);
  const s = Math.round((minutes - m) * 60);
  return `${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

function formatM2(v) {
  return typeof v === 'number' ? v.toFixed(2) + ' m²' : '—';
}

// ---- Seeder — import data from original spreadsheet ----
// Pre-load the historical records from the original xlsm into localStorage
// so dashboards show real data from day one.

// ---- Relatório de Injeção ----

async function registrarRelatorioInjecao(record) {
  // Expande os traços do registro em linhas individuais para o relatorio_injecao.json
  const linhas = (record.tracos || []).map(t => ({
    id_traco: t.id || (record.id + '_t' + t.num),
    id_operacao: record.id,
    data: record.data,
    turno: record.turno,
    id_bateria: record.id_bateria,
    dimensao: record.dimensao,
    tipo_montagem: record.tipo_montagem,
    num_traco: t.num,
    berco_ini: t.berco_ini || '',
    berco_fim: t.berco_fim || '',
    densidade: t.densidade || '',
    flow: t.flow || '',
    obs: t.obs || '',
    silo: t.silo || '',
    expansao: t.expansao || '',
    densidade_eps: t.densidadeEPS || '',
  }));

  if (!linhas.length) return; // sem traços, nada a salvar

  const res = await fetch('/registrar-relatorio-injecao', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(linhas),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.erro || 'Erro ao registrar relatório de injeção');
}

async function getRelatorioInjecao() {
  try {
    const res = await fetch('relatorio_injecao.json');
    if (!res.ok) return [];
    return await res.json();
  } catch (_) { return []; }
}

// ---- Analytics ----

async function registrarOperacao(record) {
  const res = await fetch('/registrar-operacao', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.erro || 'Erro ao registrar operação');
}

async function getStats(filtros = {}) {
  const baterias = await fetch('historico.json').then(r => r.json());
  let data = baterias;

  if (filtros.dataInicio) {
    data = data.filter(b => b.data >= filtros.dataInicio);
  }
  if (filtros.dataFim) {
    data = data.filter(b => b.data <= filtros.dataFim);
  }
  if (filtros.turno) {
    data = data.filter(b => b.turno === filtros.turno);
  }

  const total_baterias = data.length;
  const total_paineis = data.reduce((s, b) => s + (b.total_paineis || 0), 0);
  const total_paineis_2p = data.reduce((s, b) => s + (b.paineis_2p || 0), 0);
  const total_paineis_sp = data.reduce((s, b) => s + (b.paineis_sp || 0), 0);
  const total_m2 = data.reduce((s, b) => s + (b.m2_total || 0), 0);
  const total_m2_2p = data.reduce((s, b) => s + (b.m2_2p || 0), 0);
  const total_m2_sp = data.reduce((s, b) => s + (b.m2_sp || 0), 0);
  const baterias_atraso = data.filter(b => b.houve_atraso === 'SIM').length;
  const pct_atraso = total_baterias ? Math.round(baterias_atraso / total_baterias * 100) : 0;
  const media_tempo = total_baterias
    ? data.reduce((s, b) => s + (b.tempo_min || 0), 0) / total_baterias
    : 0;
  const media_tracos = total_baterias
    ? data.reduce((s, b) => s + (b.qtd_tracos || 0), 0) / total_baterias
    : 0;

  const dias_set = new Set(data.map(b => b.data));
  const dias_producao = dias_set.size;

  // By date
  const por_data = {};
  data.forEach(b => {
    if (!por_data[b.data]) por_data[b.data] = { qtd: 0, atraso: 0, m2: 0 };
    por_data[b.data].qtd++;
    if (b.houve_atraso === 'SIM') por_data[b.data].atraso++;
    por_data[b.data].m2 += (b.m2_total || 0);
  });

  // By turno
  const por_turno = {};
  ['1º TURNO', '2º TURNO', '3º TURNO'].forEach(t => {
    const td = data.filter(b => b.turno === t);
    por_turno[t] = {
      total: td.length,
      atraso: td.filter(b => b.houve_atraso === 'SIM').length,
      m2: td.reduce((s, b) => s + (b.m2_total || 0), 0),
      tempo_medio: td.length ? td.reduce((s, b) => s + (b.tempo_min || 0), 0) / td.length : 0,
      paineis: td.reduce((s, b) => s + (b.total_paineis || 0), 0),
      paineis_2p: td.reduce((s, b) => s + (b.paineis_2p || 0), 0),
      paineis_sp: td.reduce((s, b) => s + (b.paineis_sp || 0), 0),
      m2_2p: td.reduce((s, b) => s + (b.m2_2p || 0), 0),
      m2_sp: td.reduce((s, b) => s + (b.m2_sp || 0), 0),
    };
  });

  // Motivos de atraso
  const motivos = {};
  data.filter(b => b.houve_atraso === 'SIM' && b.motivo_atraso)
    .forEach(b => {
      const m = b.motivo_atraso.toLowerCase().trim();
      motivos[m] = (motivos[m] || 0) + 1;
    });

  return {
    total_baterias, total_paineis, total_paineis_2p, total_paineis_sp,
    total_m2, total_m2_2p, total_m2_sp,
    baterias_atraso, pct_atraso, media_tempo, media_tracos,
    dias_producao, por_data, por_turno, motivos, data
  };
}

// ---- Export ----

window.LW = {
  // Constantes fixas
  TURNO_OPTS,
  M2_POR_PAINEL,
  LIMITE_INJECAO_MIN,

  // Getters dinâmicos — leem do estado após config.json carregar
  get DIMENSAO_OPTS() { return DIMENSAO_OPTS; },
  get MONTAGEM_OPTS() { return MONTAGEM_OPTS; },
  get MONTAGEM_MAP() { return MONTAGEM_MAP; },
  get BATERIA_IDS() { return BATERIA_IDS; },

  // Config loader
  loadConfig,
  waitConfig,

  // Storage (operação em andamento permanece em localStorage)
  loadDB, saveDB, DB_KEY_INJECOES,
  getOperacaoAtual, saveOperacaoAtual, clearOperacaoAtual,

  // Cálculos
  getBercosByDimensao, calcPaineis,

  // Formatação
  formatTime, formatDate, diffMinutes, formatDuration, formatM2,

  // Relatório de Injeção
  registrarRelatorioInjecao,
  getRelatorioInjecao,

  // Dados e analytics
  registrarOperacao, getStats,
};