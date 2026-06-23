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
// Lista bruta de tipos_montagem.opcoes, tal como vem do config.json — cada
// item guarda { label, modo: 'simples'|'hibrida', tipo|tipos, paineis_*_por_berco,
// cimenticia? }. Usada pela tela de admin (cfgRenderTudo) pra editar com
// fidelidade total, e por CIMENTICIA_POR_TIPO abaixo.
let MONTAGEM_OPCOES = [];
// Cimentícia por tipo de placa simples — { '2p': { leva: true, quantidade: 2 }, ... }.
// Um tipo híbrido NÃO tem entrada própria aqui: ele herda automaticamente a
// cimentícia de cada tipo simples que o compõe (ver calcPaineis()).
let CIMENTICIA_POR_TIPO = {};
let BATERIA_IDS = [];
let VOLUME_POR_PLACA = []; // [{ label: 'S/P - 7,5 cm', volume: 0.1373 }, ...]

let _configReady = false;
const _configCallbacks = [];

// ---- Cor por tipo de montagem SIMPLES ----
// O programa sempre SUGERE uma cor nova automaticamente ("largest-gap hue
// allocation": olha os matizes já usados pelos tipos existentes e escolhe o
// ponto no meio do maior "vão" livre entre eles, pra ficar o mais distante
// possível das já existentes) — mas quem cadastra pode trocar por qualquer
// outra cor à mão. O que fica guardado de verdade é sempre a cor FINAL (hex,
// em `cor`), tenha sido aceita a sugestão ou escolhida manualmente — não
// diferenciamos uma coisa da outra depois de salvo.
//
// Faixa de matiz da sugestão limitada a 0–300° de propósito: evita cair na
// faixa de rosa/magenta (300–360°). Saturação/luminosidade fixas na
// sugestão, pra ela ter o mesmo "peso" visual das demais cores do app — mas
// isso só vale pra sugestão; uma cor escolhida manualmente é guardada como
// foi escolhida, sem forçar essa saturação/luminosidade.
const COR_HUE_MIN = 0;
const COR_HUE_MAX = 300;
const COR_SATURACAO_SUGESTAO = 60;
const COR_LUMINOSIDADE_SUGESTAO = 52;

function gerarProximaHueDisponivel(huesExistentes) {
  if (!huesExistentes || !huesExistentes.length) return 210; // primeira cor: azul, ponto de partida
  const pontos = [COR_HUE_MIN, ...[...huesExistentes].sort((a, b) => a - b), COR_HUE_MAX];
  let maiorGap = -1, hueEscolhido = COR_HUE_MIN;
  for (let i = 0; i < pontos.length - 1; i++) {
    const gap = pontos[i + 1] - pontos[i];
    if (gap > maiorGap) {
      maiorGap = gap;
      hueEscolhido = pontos[i] + gap / 2;
    }
  }
  return Math.round(hueEscolhido);
}

// ---- Conversões de cor (hue/hsl ↔ hex/rgb) — sem libs externas ----

function hslParaHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const paraHex = x => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${paraHex(f(0))}${paraHex(f(8))}${paraHex(f(4))}`;
}

function hexParaRgb(hex) {
  let h = String(hex || '').replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const num = parseInt(h, 16) || 0;
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

function hexParaHue(hex) {
  const { r, g, b } = hexParaRgb(hex);
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const max = Math.max(rN, gN, bN), min = Math.min(rN, gN, bN);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === rN) h = ((gN - bN) / d) % 6;
  else if (max === gN) h = (bN - rN) / d + 2;
  else h = (rN - gN) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function hexParaRgba(hex, alpha) {
  const { r, g, b } = hexParaRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Sugestão de cor pra um tipo simples novo — recebe as cores (hex) já usadas
// pelos outros tipos simples, e devolve uma cor hex nova, gerada pelo
// algoritmo de maior vão. É só uma SUGESTÃO pra pré-preencher o seletor de
// cor da tela de admin — quem estiver cadastrando pode aceitar ou trocar.
function gerarProximaCorDisponivel(coresExistentesHex) {
  const hues = (coresExistentesHex || []).filter(Boolean).map(hexParaHue);
  const hue = gerarProximaHueDisponivel(hues);
  return hslParaHex(hue, COR_SATURACAO_SUGESTAO, COR_LUMINOSIDADE_SUGESTAO);
}

// Monta as 3 variações (sólida, fundo sutil, borda) usadas nos badges/gráficos
// a partir de uma cor hex — usado tanto pra cor automática quanto manual.
function corCssDoHex(hex) {
  return {
    cor: hex,
    bg: hexParaRgba(hex, .15),
    borda: hexParaRgba(hex, .3),
  };
}

// Cor de um tipo de montagem pelo LABEL (ex: "2/P") — busca a cor de verdade
// vinculada ao tipo. Usa valores literais (não var(--xxx)) porque esses
// retornos também são usados em gráficos <canvas>, que não entendem
// variáveis CSS — só cor literal (hex/rgb/hsl).
//
// - Tipo SIMPLES: uma cor só, guardada como hex em `cor` (sugerida
//   automaticamente ou escolhida à mão na tela de admin — ver corCssDoHex).
// - Tipo HÍBRIDO: não tem cor própria — é sempre metade da cor de cada um
//   dos 2 tipos simples que o compõem (cor1/cor2), pra deixar visualmente
//   óbvio que é a combinação dos dois. `bg` já vem como um linear-gradient
//   CSS pronto (50%/50%, sem transição suave) pra uso direto em HTML; quem
//   desenha em <canvas> usa cor1/cor2 separadamente pra montar o próprio
//   gradiente (canvas não entende a string CSS linear-gradient()).
// - Sem cor disponível (tipo desconhecido, ou híbrido cujos componentes
//   ainda não têm cor): cinza neutro.
function corMontagemPorLabel(label) {
  const opcao = (MONTAGEM_OPCOES || []).find(o => o.label === label);
  if (!opcao) return _corMontagemNeutra();

  if (opcao.modo === 'simples') {
    // cor (hex) é o formato atual; corHue (número) é o formato antigo,
    // mantido só pra não perder a cor de registros salvos antes desta
    // mudança — convertido na hora, nunca migrado silenciosamente no disco.
    if (typeof opcao.cor === 'string' && opcao.cor) {
      return { ...corCssDoHex(opcao.cor), hibrida: false };
    }
    if (typeof opcao.corHue === 'number') {
      return { ...corCssDoHex(hslParaHex(opcao.corHue, COR_SATURACAO_SUGESTAO, COR_LUMINOSIDADE_SUGESTAO)), hibrida: false };
    }
  }

  if (opcao.modo === 'hibrida' && Array.isArray(opcao.tipos) && opcao.tipos.length === 2) {
    const [op1, op2] = opcao.tipos.map(t =>
      (MONTAGEM_OPCOES || []).find(o => o.modo === 'simples' && o.tipo === t));
    const corDoTipo = op => {
      if (!op) return null;
      if (typeof op.cor === 'string' && op.cor) return op.cor;
      if (typeof op.corHue === 'number') return hslParaHex(op.corHue, COR_SATURACAO_SUGESTAO, COR_LUMINOSIDADE_SUGESTAO);
      return null;
    };
    const hex1 = corDoTipo(op1);
    const hex2 = corDoTipo(op2);
    if (hex1 && hex2) {
      const c1 = corCssDoHex(hex1);
      const c2 = corCssDoHex(hex2);
      return {
        hibrida: true,
        cor1: c1.cor, cor2: c2.cor,
        cor: c1.cor, // fallback pra quem só aceita 1 cor (ex: cor de texto)
        bg: `linear-gradient(90deg, ${c1.bg} 50%, ${c2.bg} 50%)`,
        borda: c1.borda,
      };
    }
  }

  return _corMontagemNeutra();
}

function _corMontagemNeutra() {
  return { hibrida: false, cor: '#5c6475', bg: 'rgba(156, 163, 175, .1)', borda: '#2a2f3a' };
}

/**
 * Extrai os componentes de painéis de uma opção de tipo de montagem,
 * de forma genérica — suporta qualquer quantidade de tipos (2p, sp, 3p, ...).
 * Uma chave é considerada um componente se terminar em "_por_berco".
 * Retorna: { porBerco: { '2p': 2, 'sp': 0, ... } }
 * O tipo (ex: '2p') é extraído do nome da chave: paineis_2p_por_berco -> '2p'.
 */
function extrairComponentesMontagem(opcao) {
  const porBerco = {};
  Object.keys(opcao || {}).forEach(chave => {
    const m = chave.match(/^paineis_(.+)_por_berco$/);
    if (m) {
      const tipo = m[1]; // ex: '2p', 'sp', '3p'
      porBerco[tipo] = Number(opcao[chave]) || 0;
    }
  });
  return { porBerco };
}

/**
 * Constrói o mapa de cimentícia por tipo de placa SIMPLES, a partir da lista
 * bruta de tipos_montagem.opcoes. Tipos híbridos não entram aqui — eles
 * herdam automaticamente a cimentícia de cada tipo simples que os compõe,
 * na hora do cálculo (ver calcPaineis()).
 */
function _montarCimenticiaPorTipo(opcoes) {
  const mapa = {};
  (opcoes || []).forEach(o => {
    if (o.modo === 'simples' && o.tipo) {
      mapa[o.tipo] = (o.cimenticia && typeof o.cimenticia === 'object')
        ? { leva: !!o.cimenticia.leva, quantidade: Number(o.cimenticia.quantidade) || 0 }
        : { leva: false, quantidade: 0 };
    }
  });
  return mapa;
}

/**
 * Aplica uma lista de tipos_montagem.opcoes às variáveis em memória
 * (MONTAGEM_OPTS, MONTAGEM_MAP, MONTAGEM_OPCOES, CIMENTICIA_POR_TIPO).
 * Reaproveitada por loadConfig() e exposta como LW.aplicarTiposMontagemEmMemoria()
 * pra a tela de admin atualizar tudo na hora, sem precisar recarregar a página.
 */
function _aplicarTiposMontagem(opcoes) {
  MONTAGEM_OPCOES = opcoes;
  MONTAGEM_OPTS = opcoes.map(t => t.label);
  MONTAGEM_MAP = {};
  opcoes.forEach(t => { MONTAGEM_MAP[t.label] = extrairComponentesMontagem(t); });
  CIMENTICIA_POR_TIPO = _montarCimenticiaPorTipo(opcoes);
}

async function loadConfig() {
  if (_configReady) return;
  try {
    const res = await fetch('db/config.json');
    if (!res.ok) throw new Error('config.json não encontrado');
    const cfg = await res.json();

    // Se não houver chave 'dimensoes', extraímos das baterias (nova estrutura)
    if (Array.isArray(cfg.dimensoes?.opcoes)) {
      DIMENSAO_OPTS = cfg.dimensoes.opcoes.map(d => ({ label: d.label, bercos: d.bercos }));
    } else if (Array.isArray(cfg.baterias?.ids)) {
      const uniqueDims = new Map();
      cfg.baterias.ids.forEach(b => {
        if (b.label && b.bercos) {
          uniqueDims.set(b.label, b.bercos);
        }
      });
      DIMENSAO_OPTS = Array.from(uniqueDims.entries()).map(([label, bercos]) => ({ label, bercos }));
    } else if (!DIMENSAO_OPTS.length) {
      console.warn('[LW] config.json sem "dimensoes" nem "baterias.ids" válidos — usando fallback de dimensões.');
      DIMENSAO_OPTS = [
        { label: '7,5 cm', bercos: 22 },
        { label: '9 cm', bercos: 20 },
        { label: '12 cm', bercos: 18 },
      ];
    }

    // Cada bloco do config.json é lido de forma independente: se um bloco vier
    // ausente ou malformado (ex: um campo esquecido ao salvar configurações),
    // isso não deve impedir a leitura dos demais blocos válidos. Cada bloco que
    // falhar mantém o valor já carregado (ou o default, na primeira carga).
    if (Array.isArray(cfg.tipos_montagem?.opcoes)) {
      _aplicarTiposMontagem(cfg.tipos_montagem.opcoes);
    } else if (!MONTAGEM_OPTS.length) {
      console.warn('[LW] config.json sem "tipos_montagem.opcoes" válido — usando fallback de tipos de montagem.');
      _aplicarTiposMontagem([
        { label: '2/P', modo: 'simples', tipo: '2p', paineis_2p_por_berco: 2, cimenticia: { leva: true, quantidade: 2 } },
        { label: 'S/P', modo: 'simples', tipo: 'sp', paineis_sp_por_berco: 2, cimenticia: { leva: false, quantidade: 0 } },
        { label: 'HÍBRIDA 2p/sp', modo: 'hibrida', tipos: ['2p', 'sp'], paineis_2p_por_berco: 1, paineis_sp_por_berco: 1 },
      ]);
    } else {
      console.warn('[LW] config.json sem "tipos_montagem.opcoes" válido — mantendo tipos de montagem já carregados.');
    }

    if (Array.isArray(cfg.baterias?.ids)) {
      BATERIA_IDS = cfg.baterias.ids;
    } else if (!BATERIA_IDS.length) {
      console.warn('[LW] config.json sem "baterias.ids" válido — usando fallback de baterias.');
      BATERIA_IDS = ['B1', 'B2', 'B3', 'B4', 'B5-7,5cm', 'B6-12cm', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12'];
    } else {
      console.warn('[LW] config.json sem "baterias.ids" válido — mantendo baterias já carregadas.');
    }

    if (Array.isArray(cfg.volume_por_placa)) {
      VOLUME_POR_PLACA = cfg.volume_por_placa.map(v => ({ label: v.label, volume: v.volume }));
    } else if (!VOLUME_POR_PLACA.length) {
      console.warn('[LW] config.json sem "volume_por_placa" válido — usando fallback (apenas informativo).');
      VOLUME_POR_PLACA = [
        { label: 'S/P - 7,5 cm', volume: 0.1373 },
        { label: '2/P - 7,5 cm', volume: 0.1189 },
        { label: 'S/P - 9 cm', volume: 0.1647 },
        { label: '2/P - 9 cm', volume: 0.1427 },
        { label: 'S/P - 12 cm', volume: 0.2196 },
        { label: '2/P - 12 cm', volume: 0.1903 },
      ];
    } else {
      console.warn('[LW] config.json sem "volume_por_placa" válido — mantendo lista já carregada.');
    }

  } catch (err) {
    console.warn('[LW] Usando valores fallback — config.json indisponível:', err.message);
    DIMENSAO_OPTS = [
      { label: '7,5 cm', bercos: 22 },
      { label: '9 cm', bercos: 20 },
      { label: '12 cm', bercos: 18 },
    ];
    _aplicarTiposMontagem([
      { label: '2/P', modo: 'simples', tipo: '2p', paineis_2p_por_berco: 2, cimenticia: { leva: true, quantidade: 2 } },
      { label: 'S/P', modo: 'simples', tipo: 'sp', paineis_sp_por_berco: 2, cimenticia: { leva: false, quantidade: 0 } },
      { label: 'HÍBRIDA 2p/sp', modo: 'hibrida', tipos: ['2p', 'sp'], paineis_2p_por_berco: 1, paineis_sp_por_berco: 1 },
    ]);
    BATERIA_IDS = ['B1', 'B2', 'B3', 'B4', 'B5-7,5cm', 'B6-12cm', 'B7', 'B8', 'B9', 'B10', 'B11', 'B12'];
    VOLUME_POR_PLACA = [
      { label: 'S/P - 7,5 cm', volume: 0.1373 },
      { label: '2/P - 7,5 cm', volume: 0.1189 },
      { label: 'S/P - 9 cm', volume: 0.1647 },
      { label: '2/P - 9 cm', volume: 0.1427 },
      { label: 'S/P - 12 cm', volume: 0.2196 },
      { label: '2/P - 12 cm', volume: 0.1903 },
    ]
  }

  // Se o admin salvou uma config customizada, ela tem prioridade
  const override = localStorage.getItem('lw_config_override');
  if (override) {
    try {
      const cfg = JSON.parse(override);
      BATERIA_IDS = cfg.baterias.ids;
      DIMENSAO_OPTS = cfg.dimensoes.opcoes;
      _aplicarTiposMontagem(cfg.tipos_montagem.opcoes);
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

const DB_KEY_OP_CURRENT = 'lw_op_current';

// Nota: DB_KEY_BATERIAS e DB_KEY_INJECOES foram descontinuados em favor de persistência no servidor.
// loadDB e saveDB foram removidos por falta de uso.

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

/**
 * Calcula painéis e m² para um tipo de montagem e quantidade de berços.
 * Suporta qualquer número de "tipos de placa" (2p, sp, 3p, ...), definidos
 * dinamicamente em MONTAGEM_MAP[tipoMontagem].porBerco.
 *
 * Retorna sempre:
 *  - paineis_por_tipo / m2_por_tipo: objetos { '2p': N, 'sp': N, ... } — fonte da verdade
 *  - paineis_2p, paineis_sp, m2_2p, m2_sp: aliases de compatibilidade com código/
 *    registros antigos que esperam exatamente esses dois tipos (sempre presentes,
 *    mesmo que valham 0, mesmo se o tipo não existir na montagem atual).
 */
function calcPaineis(tipoMontagem, bercos) {
  const map = MONTAGEM_MAP[tipoMontagem];
  const porBerco = (map && map.porBerco) ? map.porBerco : { 'sp': 2 }; // fallback histórico: S/P puro

  const paineis_por_tipo = {};
  let paineis_total = 0;
  Object.keys(porBerco).forEach(tipo => {
    const qtd = bercos * (porBerco[tipo] || 0);
    paineis_por_tipo[tipo] = qtd;
    paineis_total += qtd;
  });

  const m2_por_tipo = {};
  Object.keys(paineis_por_tipo).forEach(tipo => {
    m2_por_tipo[tipo] = paineis_por_tipo[tipo] * M2_POR_PAINEL;
  });
  const m2_total = paineis_total * M2_POR_PAINEL;

  // Placas cimentícia: agora é uma propriedade de CADA TIPO DE PLACA SIMPLES
  // (configurável na tela de admin), não mais fixa no tipo '2p'. Um tipo
  // híbrido herda automaticamente — aqui somamos a contribuição de cada tipo
  // presente nesta montagem, simples ou híbrida.
  let placas_cimenticia = 0;
  Object.keys(paineis_por_tipo).forEach(tipo => {
    const c = CIMENTICIA_POR_TIPO[tipo];
    if (c && c.leva) {
      placas_cimenticia += paineis_por_tipo[tipo] * (c.quantidade || 0);
    }
  });

  return {
    total_paineis: paineis_total,
    m2_total,
    placas_cimenticia,
    paineis_por_tipo,
    m2_por_tipo,
    // Aliases de compatibilidade (sempre presentes):
    paineis_2p: paineis_por_tipo['2p'] || 0,
    paineis_sp: paineis_por_tipo['sp'] || 0,
    m2_2p: m2_por_tipo['2p'] || 0,
    m2_sp: m2_por_tipo['sp'] || 0,
  };
}

/**
 * Soma um campo do tipo { '2p': N, 'sp': N, ... } através de uma lista de registros.
 * Ex: somarPorTipo(baterias, 'paineis_por_tipo') -> { '2p': 120, 'sp': 40, '3p': 10 }
 */
function somarPorTipo(registros, campo) {
  const totais = {};
  registros.forEach(r => {
    const obj = r[campo];
    if (!obj) return;
    Object.keys(obj).forEach(tipo => {
      totais[tipo] = (totais[tipo] || 0) + (obj[tipo] || 0);
    });
  });
  return totais;
}

/**
 * Garante que um registro (do histórico, novo ou antigo) tenha paineis_por_tipo
 * e m2_por_tipo preenchidos, derivando-os dos campos legados paineis_2p/paineis_sp
 * quando necessário. Não sobrescreve dados já no formato novo.
 */
function normalizarPaineisRegistro(registro) {
  if (!registro) return registro;
  if (!registro.paineis_por_tipo) {
    registro.paineis_por_tipo = {
      '2p': registro.paineis_2p || 0,
      'sp': registro.paineis_sp || 0,
    };
  }
  if (!registro.m2_por_tipo) {
    registro.m2_por_tipo = {
      '2p': registro.m2_2p || 0,
      'sp': registro.m2_sp || 0,
    };
  }
  return registro;
}

// ---- Fuso horário padronizado: Brasília (America/Sao_Paulo) ----
// Use nowBrasilia() em vez de new Date() para capturar o momento atual.
// Retorna um Date cujo valor UTC é ajustado para representar "agora" em Brasília,
// garantindo que ISO strings e cálculos de duração sejam consistentes
// independentemente do fuso do computador do operador.
function nowBrasilia() {
  const now = new Date();
  // Obtém o offset real de Brasília no momento atual (considera horário de verão)
  const brFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const parts = brFormatter.formatToParts(now);
  const get = type => parts.find(p => p.type === type).value;
  const brStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
  // Cria Date como se fosse UTC, representando a hora local de Brasília
  return new Date(brStr + 'Z');
}

// Retorna a data de hoje em Brasília no formato YYYY-MM-DD
function todayBrasilia() {
  return nowBrasilia().toISOString().split('T')[0];
}

function formatTime(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleTimeString('pt-BR', { 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit',
    timeZone: 'UTC' 
  });
}

function diffMinutes(start, end) {
  const s = new Date(start), e = new Date(end);
  return (e - s) / 60000;
}

// Formata uma duração em minutos (o que continua guardado em tempo_min, sem
// mudar nenhum cálculo) como horas:minutos:segundos — H:MM:SS — pra ficar
// mais fácil de visualizar do que só minutos corridos (ex: "1:15:32" em vez
// de "75m 32s"). Usada tanto pelo cronômetro da tela de Operação quanto
// pela coluna "Duração" do Registro de Baterias (e os outros lugares que
// mostram duração — Desempenho Turnos, exportação Excel, tela de Editar
// Operação — todos ganham o mesmo formato automaticamente, por usarem esta
// mesma função).
function formatDuration(minutes) {
  if (!minutes || isNaN(minutes)) return '—';
  const totalSegundos = Math.round(minutes * 60);
  const h = Math.floor(totalSegundos / 3600);
  const m = Math.floor((totalSegundos % 3600) / 60);
  const s = totalSegundos % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ---- Seeder — import data from original spreadsheet ----
// Pre-load the historical records from the original xlsm into localStorage
// so dashboards show real data from day one.

// ---- Relatório de Injeção ----

async function registrarRelatorioInjecao(record) {
  const linhas = (record.tracos || []).map(t => ({
    id_traco: t.id || (record.id + '_t' + t.num),
    // Estrutura exata solicitada
    ultilizado: {
      operacao: [
        {
          id_operacao: record.id,
          id_bateria: record.id_bateria,
          berco_inicio: t.berco_ini || '',
          berco_finalizacao: t.berco_fim || '',
          obs: t.obs || ''
        }
      ]
    },
    data: record.data,
    turno: record.turno,
    num_traco: t.num,
    cimento_real: t.cimento_real || '',
    agua_real: t.agua_real || '',
    eps_real: t.eps_real || '',
    superplast_real: t.superplast_real || '',
    incorporador_real: t.incorporador_real || '',
    tempo_batida: t.tempo_batida || '',
    densidade: t.densidade_insumo || '',
    flow: t.flow_insumo || '',
    obs: t.obs || '', // legado: mantido só como fallback p/ registros antigos sem obs por operação — exibição deve preferir ultilizado.operacao[].obs
    silo: t.silo || '',
    expansao: t.expansao || '',
    densidade_eps: t.densidadeEPS || '',
  }));

  if (!linhas.length) return;

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
    const res = await fetch('db/relatorio_injecao.json');
    if (!res.ok) return [];
    return await res.json();
  } catch (_) { return []; }
}

/**
 * Obtém o total de traços já CONFIRMADOS hoje (Brasília) — apenas leitura,
 * não consome/incrementa nada. Usado para calcular a numeração de PRÉVIA
 * (total+1, total+2, ...) dos traços ainda em edição na operação atual.
 * O número só se torna definitivo quando a operação é finalizada — ver
 * confirmarTracosHoje().
 * @returns {Promise<number>} total de traços confirmados hoje
 */
async function getTotalTracosHoje() {
  const res = await fetch('/total-tracos-hoje?_=' + Date.now()); // evita cache
  const json = await res.json();
  if (!json.ok) throw new Error(json.erro || 'Erro ao obter total de traços do dia');
  return json.total;
}

/**
 * Confirma N traços ao finalizar uma operação — incrementa atomicamente o
 * total do dia no servidor. Deve ser chamada uma única vez por operação
 * finalizada, com a quantidade de traços que de fato sobraram (após exclusões).
 * Traços reaproveitados de sobra (mantêm Nº de uma operação anterior) NÃO
 * devem ser contados aqui — apenas traços novos desta operação.
 * @param {number} quantidade - quantos traços novos foram confirmados
 * @returns {Promise<number>} novo total acumulado do dia
 */
async function confirmarTracosHoje(quantidade) {
  const res = await fetch('/confirmar-tracos-hoje', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantidade }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.erro || 'Erro ao confirmar traços do dia');
  return json.total;
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

// ============================================================
//  FILA DE OPERAÇÕES PENDENTES (registro offline)
//
//  Se "Registrar Operação" for clicado sem internet (ou a tentativa de
//  envio falhar por erro de REDE — não por rejeição de verdade do
//  servidor), a operação não é perdida nem fica travando a tela esperando
//  a conexão voltar: ela é guardada aqui e o sistema segue livre pra
//  começar a próxima. Assim que a conexão volta (evento 'online' do
//  navegador, ou a checagem periódica de segurança), tenta enviar tudo que
//  está na fila, na ordem em que foi registrado.
// ============================================================

const DB_KEY_FILA_PENDENTES = 'lw_fila_operacoes_pendentes';

function _lerFilaPendentes() {
  try {
    const raw = localStorage.getItem(DB_KEY_FILA_PENDENTES);
    return raw ? JSON.parse(raw) : [];
  } catch (_) { return []; }
}

function _salvarFilaPendentes(fila) {
  try { localStorage.setItem(DB_KEY_FILA_PENDENTES, JSON.stringify(fila)); } catch (_) { /* localStorage indisponível */ }
}

/** Quantas operações estão esperando pra ser enviadas de verdade. */
function tamanhoFilaPendentes() {
  return _lerFilaPendentes().length;
}

/**
 * Guarda uma operação pra ser registrada de verdade quando a conexão
 * voltar. `historyRecord`/`fullRecord`/`qtdTracosNovos` são exatamente os
 * mesmos parâmetros que iriam pra registrarOperacao/registrarRelatorioInjecao
 * /confirmarTracosHoje numa tentativa normal — só ficam guardados pra tentar
 * de novo depois.
 */
function enfileirarOperacaoPendente(historyRecord, fullRecord, qtdTracosNovos) {
  const fila = _lerFilaPendentes();
  fila.push({ historyRecord, fullRecord, qtdTracosNovos, enfileiradoEm: new Date().toISOString() });
  _salvarFilaPendentes(fila);
  _notificarFilaMudou();
}

// Callbacks pra UI reagir a mudanças na fila (atualizar um indicador,
// mostrar um aviso) — ver aoMudarFilaPendentes / aoSincronizarPendentes.
let _onFilaPendentesMudou = null;
let _onOperacoesPendentesSincronizadas = null;

function aoMudarFilaPendentes(callback) { _onFilaPendentesMudou = callback; }
function aoSincronizarPendentes(callback) { _onOperacoesPendentesSincronizadas = callback; }

function _notificarFilaMudou() {
  if (_onFilaPendentesMudou) _onFilaPendentesMudou(tamanhoFilaPendentes());
}

let _sincronizandoFilaPendentes = false;

/**
 * Tenta enviar pro servidor, em ordem, tudo que estiver na fila pendente.
 * Para no primeiro item que falhar (preserva a ordem cronológica — não
 * faz sentido a operação 3 chegar no servidor antes da operação 2, que
 * ainda nem foi enviada). Os itens que falharem continuam na fila pra
 * tentar de novo na próxima chamada.
 * Segura contra chamadas concorrentes (evento 'online' + checagem
 * periódica disparando quase ao mesmo tempo, por exemplo).
 */
async function tentarSincronizarFilaPendentes() {
  if (_sincronizandoFilaPendentes) return;
  const fila = _lerFilaPendentes();
  if (!fila.length) return;

  _sincronizandoFilaPendentes = true;
  try {
    let processados = 0;
    for (const item of fila) {
      try {
        await registrarOperacao(item.historyRecord);
        await registrarRelatorioInjecao(item.fullRecord);
        if (item.qtdTracosNovos > 0) await confirmarTracosHoje(item.qtdTracosNovos);
        processados++;
      } catch (_) {
        break; // ainda sem conexão (ou outro problema) — tenta o resto depois
      }
    }
    if (processados > 0) {
      _salvarFilaPendentes(fila.slice(processados));
      _notificarFilaMudou();
      if (_onOperacoesPendentesSincronizadas) _onOperacoesPendentesSincronizadas(processados);
    }
  } finally {
    _sincronizandoFilaPendentes = false;
  }
}

if (typeof window !== 'undefined') {
  // Dispara assim que a conexão volta...
  window.addEventListener('online', () => tentarSincronizarFilaPendentes());
  // ...e também checa periodicamente, como rede de segurança — o evento
  // 'online' do navegador nem sempre é 100% confiável (pode disparar com
  // wifi conectado mas sem internet de verdade).
  setInterval(() => tentarSincronizarFilaPendentes(), 30000);
  // Tenta uma vez já ao carregar a página, pro caso de terem sobrado itens
  // de uma sessão anterior que nunca chegaram a sincronizar.
  setTimeout(() => tentarSincronizarFilaPendentes(), 3000);
}

async function getStats(filtros = {}) {
  const baterias = await fetch('db/historico.json').then(r => r.json());
  // Garante paineis_por_tipo/m2_por_tipo em todos os registros (antigos e novos)
  baterias.forEach(normalizarPaineisRegistro);
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
  const total_m2 = data.reduce((s, b) => s + (b.m2_total || 0), 0);
  // Agregação genérica por tipo de placa (suporta N tipos: 2p, sp, 3p, ...)
  const total_paineis_por_tipo = somarPorTipo(data, 'paineis_por_tipo');
  const total_m2_por_tipo = somarPorTipo(data, 'm2_por_tipo');
  // Aliases de compatibilidade (sempre presentes, mesmo que 0)
  const total_paineis_2p = total_paineis_por_tipo['2p'] || 0;
  const total_paineis_sp = total_paineis_por_tipo['sp'] || 0;
  const total_m2_2p = total_m2_por_tipo['2p'] || 0;
  const total_m2_sp = total_m2_por_tipo['sp'] || 0;
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
    const paineisPorTipoTurno = somarPorTipo(td, 'paineis_por_tipo');
    const m2PorTipoTurno = somarPorTipo(td, 'm2_por_tipo');
    por_turno[t] = {
      total: td.length,
      atraso: td.filter(b => b.houve_atraso === 'SIM').length,
      m2: td.reduce((s, b) => s + (b.m2_total || 0), 0),
      tempo_medio: td.length ? td.reduce((s, b) => s + (b.tempo_min || 0), 0) / td.length : 0,
      paineis: td.reduce((s, b) => s + (b.total_paineis || 0), 0),
      paineis_por_tipo: paineisPorTipoTurno,
      m2_por_tipo: m2PorTipoTurno,
      // Aliases de compatibilidade:
      paineis_2p: paineisPorTipoTurno['2p'] || 0,
      paineis_sp: paineisPorTipoTurno['sp'] || 0,
      m2_2p: m2PorTipoTurno['2p'] || 0,
      m2_sp: m2PorTipoTurno['sp'] || 0,
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

// ---- Sobra de Traço ----

/**
 * Carrega sobra.json do servidor.
 * Retorna o objeto de sobra, ou null se não existir / não estiver ativa.
 */
async function getSobra() {
  try {
    const res = await fetch('db/sobra.json?_=' + Date.now()); // evita cache
    if (!res.ok) return null;
    const sobra = await res.json();
    // Só retorna se estiver realmente ativa
    return (sobra && sobra.ativa === true) ? sobra : null;
  } catch (_) { return null; }
}

/**
 * Persiste o objeto de sobra no servidor (sobra.json).
 * @param {object} sobra – objeto conforme estrutura definida
 */
async function salvarSobra(sobra) {
  const res = await fetch('/salvar-sobra', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sobra),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.erro || 'Erro ao salvar sobra');
}

/**
 * Desativa a sobra atual, marcando-a como inativa e registrando motivo.
 * @param {'utilizada'|'descartada'} motivo
 */
async function desativarSobra(motivo) {
  const atual = await getSobra();
  if (!atual) return; // já não existe sobra ativa
  await salvarSobra({ ...atual, ativa: false, status: motivo, dataEncerramento: new Date().toISOString() });
}

// ---- Backup de Dados ----

// Todos os arquivos que vivem em public/db/ — se um novo arquivo de dados
// for adicionado lá no futuro, basta incluir o nome aqui também.
const ARQUIVOS_BACKUP_DB = [
  'config.json',
  'contador_tracos.json',
  'historico.json',
  'historico_edicoes.json',
  'paradas.json',
  'relatorio_injecao.json',
  'security.json',
  'sobra.json',
];

/**
 * Busca todos os arquivos de public/db/ (via fetch, igual ao resto do app) e
 * monta um .zip com eles no próprio navegador (usando JSZip, carregado via
 * CDN no index.html), disparando o download. Não depende de nenhuma rota
 * nova no servidor.
 */
async function gerarBackupDados() {
  if (typeof JSZip === 'undefined') {
    throw new Error('Biblioteca JSZip não carregada.');
  }

  const zip = new JSZip();
  let algumArquivoIncluido = false;

  for (const nome of ARQUIVOS_BACKUP_DB) {
    try {
      const res = await fetch('db/' + nome, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const texto = await res.text();
      zip.file(nome, texto);
      algumArquivoIncluido = true;
    } catch (err) {
      console.error(`[Backup] Falha ao incluir "${nome}" no backup:`, err);
    }
  }

  if (!algumArquivoIncluido) {
    throw new Error('Não foi possível ler nenhum arquivo de public/db/ — backup cancelado.');
  }

  const blob = await zip.generateAsync({ type: 'blob' });

  // Nome do arquivo final, ex: lightwall_backup_dados_2026-06-19_14h32.zip
  const agora = nowBrasilia();
  const hh = String(agora.getUTCHours()).padStart(2, '0');
  const mm = String(agora.getUTCMinutes()).padStart(2, '0');
  const nomeArquivo = `lightwall_backup_dados_${todayBrasilia()}_${hh}h${mm}.zip`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
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
  get MONTAGEM_OPCOES() { return MONTAGEM_OPCOES; },
  get CIMENTICIA_POR_TIPO() { return CIMENTICIA_POR_TIPO; },
  get BATERIA_IDS() { return BATERIA_IDS; },
  get VOLUME_POR_PLACA() { return VOLUME_POR_PLACA; },


  // Config loader
  loadConfig,
  waitConfig,
  aplicarTiposMontagemEmMemoria: _aplicarTiposMontagem,
  gerarProximaHueDisponivel,
  gerarProximaCorDisponivel,
  corCssDoHex,
  hslParaHex,
  hexParaHue,
  corMontagemPorLabel,

  // Storage
  getOperacaoAtual, saveOperacaoAtual, clearOperacaoAtual,
  enfileirarOperacaoPendente, tamanhoFilaPendentes,
  tentarSincronizarFilaPendentes, aoMudarFilaPendentes, aoSincronizarPendentes,

  // Cálculos
  calcPaineis,
  normalizarPaineisRegistro,
  somarPorTipo,
  extrairComponentesMontagem,

  // Formatação
  formatTime, diffMinutes, formatDuration,

  // Relatório de Injeção
  registrarRelatorioInjecao,
  getRelatorioInjecao,
  getTotalTracosHoje,
  confirmarTracosHoje,

  // Dados e analytics
  registrarOperacao, getStats,

  // Sobra de traço
  getSobra, salvarSobra, desativarSobra,

  // Backup de dados
  gerarBackupDados,
};