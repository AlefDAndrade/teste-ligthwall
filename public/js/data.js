// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  data.js — Storage, constants, calculation logic
// ============================================================

'use strict';

// ---- Constants (fixas) ----

const TURNO_OPTS = ['1º TURNO', '2º TURNO', '3º TURNO'];
const M2_POR_PAINEL = 1.83;  // m² por painel (calculado da planilha original)
const LIMITE_INJECAO_MIN = 59;    // minutos limite antes de registrar atraso

// Sentinela do tipo de montagem "Personalizado" — diferente dos outros
// (simples/híbrida), não é um item de tipos_montagem.opcoes em config.json;
// é uma opção fixa, sempre disponível, na tela de Registrar Operação. Ver
// abrirGradeMontagemPersonalizada() em operacao.js e calcPaineisPersonalizado()
// abaixo.
const TIPO_MONTAGEM_PERSONALIZADA = 'PERSONALIZADA';

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

// Dispositivos autorizados a controlar operação (voltou — ver conversa que
// motivou a mudança) — [{ deviceId, nome, autorizadoEm }], espelho em
// memória do que está em config.json (dispositivosAutorizados), preenchido
// por loadConfig(). Só pra UI/UX (ver dispositivoEstaAutorizado(), abaixo)
// — a trava de verdade é sempre no servidor (dispositivoAutorizado(),
// server.js).
let DISPOSITIVOS_AUTORIZADOS = [];

// Direcionamento de painéis por palete — qual dos 4 paletes-base recebe
// cada QUADRANTE (metade da bateria × lado do berço). Configurável em
// Configurações → Bateria e Montagem → "Definir Paletes" (ver
// public/js/paletes-config.js, cfgSalvar em app-core.js — persistido em
// config.json, chave "paletes"). Default abaixo só entra em ação se
// config.json ainda não tiver essa chave (instalação existente, antes
// desta funcionalidade) — depois da 1ª vez que o Administrador salvar em
// Configurações, o valor real sempre vem do arquivo.
const PALETES_CONFIG_DEFAULT = { direitoPrimeira: 4, direitoSegunda: 2, esquerdoPrimeira: 3, esquerdoSegunda: 1 };
let PALETES_CONFIG = { ...PALETES_CONFIG_DEFAULT };

// Ordem VISUAL dos 4 paletes-base na tela do Setor de Qualidade (layout
// 2x2 — qual posição/quadrante cada palete ocupa: 1=superior-esquerdo,
// 2=superior-direito, 3=inferior-esquerdo, 4=inferior-direito).
// Configurável em Configurações → Paletes → "Ordem dos Paletes" (ver
// public/js/paletes-ordem.js, cfgSalvar em app-core.js — persistido em
// config.json, chave "paletesOrdem"). NÃO tem relação nenhuma com
// PALETES_CONFIG acima — aquele decide QUAL palete recebe cada
// quadrante da BATERIA; este decide só a POSIÇÃO NA TELA de cada
// palete, puramente visual (mesma separação de responsabilidade que já
// existia entre _trocarPosicaoVisualPallets e o mapeamento
// berço→palete, antes desta configuração virar persistente). Default
// abaixo == o valor que já estava fixo no CSS antes de virar
// configurável (.sq-pallet-col[data-pallet-id], setor-qualidade.css).
const PALETES_ORDEM_DEFAULT = { stack1: 2, stack2: 1, stack3: 3, stack4: 4 };
let PALETES_ORDEM = { ...PALETES_ORDEM_DEFAULT };

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
// Extrai a cor (hex) de uma opção de tipos_montagem.opcoes simples — aceita
// tanto o objeto da opção quanto o código do tipo (ex: 'sp'), nesse caso
// procurando em MONTAGEM_OPCOES. Reaproveitado por corMontagemPorLabel()
// (caso híbrido) e por corPorTipoSimples() (grade de Montagem Personalizada).
function _hexDoTipoSimples(tipoOuOpcao) {
  const op = typeof tipoOuOpcao === 'string'
    ? (MONTAGEM_OPCOES || []).find(o => o.modo === 'simples' && o.tipo === tipoOuOpcao)
    : tipoOuOpcao;
  if (!op) return null;
  if (typeof op.cor === 'string' && op.cor) return op.cor;
  if (typeof op.corHue === 'number') return hslParaHex(op.corHue, COR_SATURACAO_SUGESTAO, COR_LUMINOSIDADE_SUGESTAO);
  return null;
}

function corMontagemPorLabel(label) {
  const opcao = (MONTAGEM_OPCOES || []).find(o => o.label === label);
  if (!opcao) return _corMontagemNeutra();

  if (opcao.modo === 'simples') {
    const hex = _hexDoTipoSimples(opcao);
    if (hex) return { ...corCssDoHex(hex), hibrida: false };
  }

  if (opcao.modo === 'hibrida' && Array.isArray(opcao.tipos) && opcao.tipos.length === 2) {
    const [op1, op2] = opcao.tipos.map(t =>
      (MONTAGEM_OPCOES || []).find(o => o.modo === 'simples' && o.tipo === t));
    const hex1 = _hexDoTipoSimples(op1);
    const hex2 = _hexDoTipoSimples(op2);
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

/**
 * Cor (mesmo formato de corMontagemPorLabel) de um tipo SIMPLES, dado o
 * código do tipo (ex: 'sp', '2p', '3t') em vez do label — usado pela grade
 * de Montagem Personalizada, onde cada berço guarda o tipo, não o label.
 */
function corPorTipoSimples(tipo) {
  const hex = _hexDoTipoSimples(tipo);
  if (!hex) return _corMontagemNeutra();
  return { ...corCssDoHex(hex), hibrida: false };
}

function _corMontagemNeutra() {
  return { hibrida: false, cor: '#5c6475', bg: 'rgba(156, 163, 175, .1)', borda: '#2a2f3a' };
}

/**
 * Resumo legível da composição de uma Montagem Personalizada — ex: "3T: 4
 * berços · S/P: 5 berços · 2/P: 7 berços". Usado no tooltip (hover) do badge
 * "PERSONALIZADA" no Registro de Baterias, pra mostrar quais tipos foram
 * usados sem precisar abrir o registro completo (ver "Limitação conhecida"
 * no README — o detalhe berço a berço só ficava visível ali até agora).
 * @param {Array<string|null>} bercosPersonalizados - um item por berço, ex: ['sp','sp','3t',null,...]
 */
function resumoBercosPersonalizados(bercosPersonalizados) {
  if (!Array.isArray(bercosPersonalizados) || !bercosPersonalizados.length) {
    return 'Composição não disponível.';
  }

  const contagem = {};
  let semTipo = 0;
  bercosPersonalizados.forEach(tipo => {
    if (!tipo) { semTipo++; return; }
    contagem[tipo] = (contagem[tipo] || 0) + 1;
  });

  const partes = Object.keys(contagem).map(tipo => {
    const opcao = (MONTAGEM_OPCOES || []).find(o => o.modo === 'simples' && o.tipo === tipo);
    const label = opcao ? opcao.label : tipo.toUpperCase();
    const n = contagem[tipo];
    return `${label}: ${n} berço${n > 1 ? 's' : ''}`;
  });

  if (semTipo > 0) partes.push(`Sem tipo: ${semTipo} berço${semTipo > 1 ? 's' : ''}`);

  return partes.join(' · ') || 'Composição não disponível.';
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

// Confere se `cfg` é uma permutação válida dos 4 paletes-base sobre os 4
// quadrantes (direitoPrimeira/direitoSegunda/esquerdoPrimeira/
// esquerdoSegunda) — cada palete (1-4) usado exatamente 1 vez. Usada por
// loadConfig() (abaixo) e por cfgSalvarPaletes() (paletes-config.js)
// antes de persistir, pra nunca deixar 2 quadrantes apontando pro mesmo
// palete ou um palete de fora sem quadrante nenhum.
function _paletesConfigValida(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const CHAVES = ['direitoPrimeira', 'direitoSegunda', 'esquerdoPrimeira', 'esquerdoSegunda'];
  const valores = CHAVES.map(k => cfg[k]);
  if (valores.some(v => !Number.isInteger(v) || v < 1 || v > 4)) return false;
  return new Set(valores).size === 4; // os 4 valores precisam ser distintos (1,2,3,4 em alguma ordem)
}

// Confere se `cfg` é uma permutação válida das 4 POSIÇÕES na tela
// (1-4) sobre os 4 paletes-base (stack1..stack4) — cada posição usada
// exatamente 1 vez. Mesmo raciocínio de _paletesConfigValida acima, só
// que pra "Ordem dos Paletes" (ver PALETES_ORDEM, acima, e
// public/js/paletes-ordem.js) em vez de "Definir Paletes".
function _paletesOrdemValida(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  const CHAVES = ['stack1', 'stack2', 'stack3', 'stack4'];
  const valores = CHAVES.map(k => cfg[k]);
  if (valores.some(v => !Number.isInteger(v) || v < 1 || v > 4)) return false;
  return new Set(valores).size === 4;
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

    // "paletes": direcionamento de painéis por quadrante (ver
    // PALETES_CONFIG, acima) — configurável em Configurações → Bateria e
    // Montagem → "Definir Paletes". Só aceita se for de fato uma
    // PERMUTAÇÃO válida dos 4 paletes (cada um usado exatamente 1 vez);
    // qualquer outra coisa (ausente, chave faltando, valor repetido) cai
    // no default, pra nunca deixar 2 quadrantes apontando pro mesmo
    // palete ou um palete sem quadrante nenhum.
    if (_paletesConfigValida(cfg.paletes)) {
      PALETES_CONFIG = { ...cfg.paletes };
    } else if (cfg.paletes !== undefined) {
      console.warn('[LW] config.json com "paletes" inválido (não é uma permutação de 1-4) — usando default.');
      PALETES_CONFIG = { ...PALETES_CONFIG_DEFAULT };
    }
    // Se cfg.paletes for undefined (instalação antes desta funcionalidade
    // existir), mantém o default já atribuído na declaração — nem loga
    // aviso, é o caminho normal esperado.

    // "paletesOrdem": posição visual de cada palete na tela do Setor de
    // Qualidade (ver PALETES_ORDEM, acima) — Configurações → Paletes →
    // "Ordem dos Paletes". Mesmo raciocínio de validação/fallback de
    // "paletes", acima: só aceita permutação válida das 4 posições.
    if (_paletesOrdemValida(cfg.paletesOrdem)) {
      PALETES_ORDEM = { ...cfg.paletesOrdem };
    } else if (cfg.paletesOrdem !== undefined) {
      console.warn('[LW] config.json com "paletesOrdem" inválido (não é uma permutação de 1-4) — usando default.');
      PALETES_ORDEM = { ...PALETES_ORDEM_DEFAULT };
    }

    // "dispositivosAutorizados": voltou (ver conversa que motivou a
    // mudança) — lista de dispositivos que podem controlar operação,
    // além da permissão de perfil de usuário (ver
    // dispositivoEstaAutorizado(), abaixo). Ausente/inválido = trata como
    // lista vazia (nenhum dispositivo autorizado ainda), nunca quebra o
    // carregamento do resto do config.json.
    DISPOSITIVOS_AUTORIZADOS = Array.isArray(cfg.dispositivosAutorizados)
      ? cfg.dispositivosAutorizados.map(d => ({
          deviceId: d.deviceId, nome: d.nome || '', autorizadoEm: d.autorizadoEm || null,
        }))
      : [];

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
    DISPOSITIVOS_AUTORIZADOS = []; // config.json indisponível — nenhum dispositivo autorizado conhecido
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

// ============================================================
//  AUTORIA — "quem registrou isto"
// ============================================================
// Substitui a antiga "Identidade Leve de Operador" (perguntava PIN toda
// vez, separado do login — ver conversa que motivou a remoção): agora
// que o login exige usuário+senha (ver login.html), a pessoa já TEM um
// nome próprio no momento em que registra qualquer coisa — não precisa
// perguntar de novo. Usado em Registrar Operação, Paradas, e Avaliações
// do Setor de Qualidade (ver operacao.js, paradas.js, setor-qualidade.js).

/**
 * Nome de quem está logado agora, pra gravar como autoria num registro
 * novo (operação, parada, avaliação de qualidade). "ADM" pro
 * Administrador Master (senha mestra, sem usuário/nome próprio — ver
 * conversa que motivou esse valor fixo); o nome de cadastro pra qualquer
 * usuário logado (Operador/Analista/Qualidade/Manutencao/Administrativo
 * — ver sessionStorage.lw_nome_usuario, gravado no login).
 * @returns {string|null} nunca lança erro — null só se sessionStorage
 *   estiver indisponível (navegador sem storage), caso extremamente raro.
 */
function nomeDeQuemEstaLogado() {
  try {
    const role = sessionStorage.getItem('lw_role');
    if (role === 'Administrador') return 'ADM';
    return sessionStorage.getItem('lw_nome_usuario') || null;
  } catch (_) {
    return null;
  }
}

// ============================================================
//  LOG DE ACESSO
//
//  Registra no servidor cada acesso a rotas "sensíveis" do app — por
//  enquanto, só "Registrar Operação" (ver showPage() em index.html). Base
//  pra, no futuro, restringir quem pode registrar operação a um único
//  computador. ip + user-agent são capturados pelo SERVIDOR (fontes
//  confiáveis); deviceId é gerado aqui e persistido neste navegador — os
//  dois juntos identificam "qual computador é qual" sem exigir login real.
// ============================================================

const DB_KEY_DEVICE_ID = 'lw_device_id';

/**
 * ID estável deste navegador/computador — gerado uma única vez e
 * persistido em localStorage (sobrevive a reabrir o navegador; some se os
 * dados do navegador forem limpos).
 */
function getDeviceId() {
  try {
    let id = localStorage.getItem(DB_KEY_DEVICE_ID);
    if (!id) {
      id = 'dev_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      localStorage.setItem(DB_KEY_DEVICE_ID, id);
    }
    return id;
  } catch (_) {
    return 'dev_sem_localstorage'; // navegador sem localStorage disponível
  }
}

/**
 * Anexa "?deviceId=..." (ou "&deviceId=..." se já houver query string) na
 * URL — usado pelas rotas que controlam a operação em andamento (iniciar,
 * encerrar, registrar), pra o servidor saber qual computador é o "dono"
 * da operação (ver donoDeviceId em lib/rotas/operacao-andamento.js). A
 * AUTORIZAÇÃO pra controlar é decidida pela sessão de usuário logado
 * (ver podeControlarOperacao() em server.js), não mais pelo deviceId.
 */
function _comDeviceId(url) {
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'deviceId=' + encodeURIComponent(getDeviceId());
}

/**
 * Anexa "&modoTeste=true" (ou "?modoTeste=true") na URL quando `modoTeste`
 * é truthy — usado pelo Toggle de Teste em Registrar Operação pra desviar
 * a gravação pra public/db/teste/ em vez dos arquivos reais (ver
 * dirParaModoTeste() em server.js). Sem efeito (URL inalterada) quando
 * `modoTeste` é falso — combina com _comDeviceId(), em qualquer ordem.
 */
function _comModoTeste(url, modoTeste) {
  if (!modoTeste) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'modoTeste=true';
}

/**
 * Registra um acesso à rota informada — melhor esforço: nunca lança erro
 * pra quem chamou (sem conexão, simplesmente não loga; não é crítico a
 * ponto de travar a navegação por isso).
 * @param {string} rota - ex: '/operacao'
 */
async function registrarAcesso(rota) {
  try {
    await fetch('/registrar-acesso', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: getDeviceId(), rota }),
    });
  } catch (_) { /* sem conexão — ok, não é crítico */ }
}

/**
 * Indica se a PESSOA logada agora tem permissão de PERFIL pra controlar
 * operação — "Administrador" (senha mestra) e "Administrativo" sempre
 * podem; os demais perfis só se o usuário específico tiver sido marcado
 * com "pode iniciar operação" no cadastro (ver
 * sessionStorage.lw_pode_iniciar_operacao, gravado no login —
 * login.html/POST /login-usuario). Metade de dispositivoEstaAutorizado()
 * (abaixo) — sozinha, NÃO é suficiente pra controlar operação, também
 * precisa do dispositivo estar autorizado.
 */
function _perfilTemPermissaoDeOperacao() {
  const role = sessionStorage.getItem('lw_role');
  if (role === 'Administrador' || role === 'Administrativo') return true;
  return sessionStorage.getItem('lw_pode_iniciar_operacao') === 'true';
}

/**
 * Indica se ESTE dispositivo (navegador/computador) está na lista de
 * autorizados (voltou — ver conversa que motivou a mudança; ver
 * DISPOSITIVOS_AUTORIZADOS, preenchida por loadConfig()). Outra metade de
 * dispositivoEstaAutorizado() — sozinha, também NÃO é suficiente, precisa
 * também da permissão de perfil.
 */
function _esteDispositivoEstaNaLista() {
  return DISPOSITIVOS_AUTORIZADOS.some(d => d.deviceId === getDeviceId());
}

/**
 * Indica se é possível controlar a operação em andamento AGORA — as DUAS
 * condições juntas, sem exceção pra nenhum perfil (pedido explícito do
 * usuário): permissão de PERFIL (_perfilTemPermissaoDeOperacao) E
 * dispositivo autorizado (_esteDispositivoEstaNaLista). Usado pela tela
 * de Registrar Operação pra desabilitar campos/botões com feedback claro
 * — a trava de verdade é sempre no servidor (ver podeControlarOperacao()
 * em server.js), isto aqui é só pra UI/UX.
 */
function dispositivoEstaAutorizado() {
  return _perfilTemPermissaoDeOperacao() && _esteDispositivoEstaNaLista();
}

/**
 * Motivo pelo qual dispositivoEstaAutorizado() está false agora — usado
 * pra mostrar a mensagem certa (ver operacao.js, _aplicarTravaDeAutorizacao):
 * 'perfil' se a pessoa logada não tem permissão, 'dispositivo' se tem
 * permissão mas o computador não está autorizado, null se está tudo ok.
 * Prioriza 'perfil' quando as duas faltam — é a causa mais comum
 * (dispositivo autorizado tende a ser configuração única por
 * computador, feita uma vez pelo Administrador).
 */
function motivoBloqueioOperacao() {
  if (!_perfilTemPermissaoDeOperacao()) return 'perfil';
  if (!_esteDispositivoEstaNaLista()) return 'dispositivo';
  return null;
}

/**
 * Busca a lista completa de dispositivos autorizados no servidor (não a
 * cópia em memória de DISPOSITIVOS_AUTORIZADOS, que só é preenchida uma
 * vez por loadConfig()) — usado pela tela de Configurações →
 * Dispositivos Autorizados, que precisa estar sempre atualizada.
 * Requer sessão de admin válida (servidor responde 403 sem ela).
 */
async function listarDispositivosAutorizados() {
  const res = await fetch('/dispositivos-autorizados');
  const data = await res.json();
  if (!data.ok) throw new Error(data.erro || 'Não foi possível listar os dispositivos autorizados.');
  DISPOSITIVOS_AUTORIZADOS = data.lista;
  return data.lista;
}

/**
 * Autoriza um dispositivo (ou atualiza o nome de um já autorizado) —
 * Configurações → Dispositivos Autorizados. Sem `deviceId` informado,
 * autoriza ESTE dispositivo (botão "Autorizar este dispositivo").
 * Requer sessão de admin válida.
 */
async function autorizarDispositivo(nome, deviceId) {
  const res = await fetch('/autorizar-dispositivo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: deviceId || getDeviceId(), nome: nome || '' }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.erro || 'Não foi possível autorizar o dispositivo.');
  DISPOSITIVOS_AUTORIZADOS = data.lista;
  return data.lista;
}

/**
 * Remove um dispositivo da lista de autorizados — Configurações →
 * Dispositivos Autorizados. Requer sessão de admin válida.
 */
async function removerDispositivo(deviceId) {
  const res = await fetch('/remover-dispositivo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.erro || 'Não foi possível remover o dispositivo.');
  DISPOSITIVOS_AUTORIZADOS = data.lista;
  return data.lista;
}

// ============================================================
//  OPERAÇÃO EM ANDAMENTO — sincronização ao vivo (WebSocket)
//
//  Só existe UMA operação em andamento por vez, pra fábrica inteira. Toda
//  vez que a tela "Registrar Operação" muda algo no estado atual, manda
//  pro servidor (debounced — agrupa digitação rápida numa única chamada) e
//  o servidor propaga pra qualquer outra aba/computador com essa mesma
//  tela aberta, em tempo real. Quem só está OLHANDO (não é quem está de
//  fato operando) recebe essas atualizações e a tela se comporta como se a
//  operação estivesse rodando ali também — cronômetro incluso (calculado
//  localmente a partir do "inicio" recebido, não tick-a-tick pela rede).
// ============================================================

// ID único desta aba — usado só pra ela mesma ignorar o eco da própria
// mudança que acabou de mandar (evita reaplicar/perder o foco de um campo
// que a própria pessoa está digitando assim que ela termina de digitar).
const OP_ANDAMENTO_CLIENT_ID = 'cli_' + Date.now() + '_' + Math.random().toString(36).slice(2);

let _opAndamentoWs = null;
let _opAndamentoOnAtualizacao = null;
let _opAndamentoOnFinalizadaPorOutro = null;
let _opAndamentoReconectarTimeout = null;
let _opAndamentoEnviarTimeout = null;
let _opAndamentoUltimoEnviado; // string JSON do último payload mandado — evita reenviar o mesmo estado
// Última revisão (número atribuído pelo servidor, ver server.js) aceita
// desta aba — começa em -1 (nenhuma ainda) pra aceitar a 1ª mensagem que
// chegar, seja qual for o valor. Ver checagem em _abrirWsOperacaoAndamento
// (recusa mensagem 'estado' com revisão <= esta) e em _postOperacaoAndamento
// (atualiza com a revisão da PRÓPRIA mudança, já que o eco via WebSocket
// dela mesma é filtrado e nunca passaria por ali).
let _opAndamentoUltimaRevisaoConhecida = -1;

// Callback pra "uma linha foi excluída em Configurações → Dados SQL, em
// QUALQUER dispositivo" — ver broadcastDadosSqlExcluidos, server.js.
// Registrado à parte de conectarOperacaoAndamento (abaixo) de propósito:
// esse evento não tem nada a ver com a tela de Registrar Operação, é
// global ao app inteiro — só usa o MESMO canal WebSocket (já aberto uma
// vez só, no boot, independente de qual página está visível) porque criar
// uma 2ª conexão só pra isso seria desperdício. Ver
// LW.aoReceberDadosSqlExcluidos, registrado no boot em app-core.js.
let _opAndamentoOnDadosSqlExcluidos = null;

/**
 * Abre a conexão WebSocket com o servidor pra acompanhar, em tempo real,
 * qualquer mudança feita em OUTRA aba/computador na operação em andamento
 * (atualizações que esta própria aba mandou não disparam o callback — ver
 * OP_ANDAMENTO_CLIENT_ID acima). Reconecta automaticamente se a conexão
 * cair. `onAtualizacao(dados)` recebe o objeto inteiro do estado (ou null,
 * quando não há nenhuma operação em andamento).
 *
 * `onFinalizadaPorOutro(resumo)` (opcional) é chamado quando OUTRO
 * dispositivo registra/finaliza uma operação (dinâmica de dono) — pra todo
 * mundo "ligado" no sistema saber na hora, mesmo sem estar olhando a tela
 * de Registrar Operação. Nunca dispara na própria aba que registrou (ela
 * já mostra o resumo localmente, sem precisar do servidor avisar de volta).
 */
function conectarOperacaoAndamento(onAtualizacao, onFinalizadaPorOutro) {
  _opAndamentoOnAtualizacao = onAtualizacao;
  _opAndamentoOnFinalizadaPorOutro = onFinalizadaPorOutro || null;
  _abrirWsOperacaoAndamento();
}

/**
 * Registra o callback pra "uma linha do banco foi excluída em
 * Configurações → Dados SQL, em QUALQUER dispositivo" — ver
 * broadcastDadosSqlExcluidos, server.js. Chamado uma vez no boot do app
 * (app-core.js), sem depender de conectarOperacaoAndamento já ter sido
 * chamado antes ou depois — é só uma variável lida quando a mensagem
 * chegar (ver _abrirWsOperacaoAndamento, acima), então a ordem entre os
 * dois registros não importa. `callback(msg)` recebe `{ tabela, valor }`.
 */
function aoReceberDadosSqlExcluidos(callback) {
  _opAndamentoOnDadosSqlExcluidos = callback;
}

function _abrirWsOperacaoAndamento() {
  if (typeof window === 'undefined' || typeof WebSocket === 'undefined') return;
  try {
    const protocolo = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocolo}//${window.location.host}/ws/operacao-andamento`);
    _opAndamentoWs = ws;

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (!msg || msg.origemClientId === OP_ANDAMENTO_CLIENT_ID) return; // eco da própria aba — ignora, em todos os tipos de mensagem

      if (msg.tipo === 'estado') {
        // Recusa atualização ATRASADA/velha (ver conversa que motivou):
        // antes, QUALQUER mensagem 'estado' substituía o estado local
        // inteiro, sem checar se era mais recente — duas ABAS na mesma
        // operação (o mecanismo de "dono" em server.js usa deviceId, que
        // é compartilhado entre abas do MESMO navegador via localStorage,
        // então não protege contra isso) podiam se sobrescrever
        // silenciosamente, apagando um traço recém-preenchido sem aviso
        // nenhum. `msg.revisao` é atribuído pelo SERVIDOR (nunca pelo
        // cliente — evita relógios de dispositivos diferentes brigarem),
        // sempre crescente — só aceita se for mais nova que a última
        // aplicada aqui. Mensagem sem `revisao` (não deveria acontecer,
        // mas por segurança) cai no fail-open: aceita mesmo assim, pra
        // nunca travar a tela por causa só desta checagem.
        if (typeof msg.revisao === 'number' && msg.revisao <= _opAndamentoUltimaRevisaoConhecida) return;
        if (typeof msg.revisao === 'number') _opAndamentoUltimaRevisaoConhecida = msg.revisao;
        if (_opAndamentoOnAtualizacao) _opAndamentoOnAtualizacao(msg.dados);
      } else if (msg.tipo === 'operacao_finalizada') {
        if (_opAndamentoOnFinalizadaPorOutro) _opAndamentoOnFinalizadaPorOutro(msg.resumo);
      } else if (msg.tipo === 'dados_sql_excluidos') {
        if (_opAndamentoOnDadosSqlExcluidos) _opAndamentoOnDadosSqlExcluidos(msg);
      }
    });

    ws.addEventListener('close', _agendarReconexaoOperacaoAndamento);
    ws.addEventListener('error', () => { /* o 'close' que segue já cuida da reconexão */ });
  } catch (_) {
    _agendarReconexaoOperacaoAndamento();
  }
}

function _agendarReconexaoOperacaoAndamento() {
  clearTimeout(_opAndamentoReconectarTimeout);
  _opAndamentoReconectarTimeout = setTimeout(_abrirWsOperacaoAndamento, 3000);
}

/**
 * Manda o estado atual da operação pro servidor — debounced por padrão
 * (espera ~250ms de silêncio antes de mandar, pra digitação rápida virar
 * uma única chamada de rede), exceto com `{ imediato: true }` (usado ao
 * encerrar/zerar a operação, onde não tem o que agrupar com mais nada).
 * `{ forcar: true }` é só pro "🗑️ Limpar Tudo" — único jeito de uma
 * pessoa autorizada limpar uma operação que outra pessoa autorizada
 * começou (ver dono da operação, em server.js).
 * @param {object|null} dados - estado atual, ou null (sem operação em andamento)
 */
function enviarOperacaoAndamento(dados, { imediato = false, forcar = false } = {}) {
  clearTimeout(_opAndamentoEnviarTimeout);
  if (imediato) {
    _postOperacaoAndamento(dados, forcar);
  } else {
    _opAndamentoEnviarTimeout = setTimeout(() => _postOperacaoAndamento(dados, forcar), 250);
  }
}

async function _postOperacaoAndamento(dados, forcar = false) {
  const corpo = JSON.stringify(dados);
  if (corpo === _opAndamentoUltimoEnviado) return; // nada mudou de verdade — evita tráfego à toa
  _opAndamentoUltimoEnviado = corpo;
  try {
    const res = await fetch(_comDeviceId('/salvar-operacao-andamento'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dados, clientId: OP_ANDAMENTO_CLIENT_ID, forcar }),
    });
    if (!res.ok) {
      // Diferente de falha de rede (catch abaixo): o servidor respondeu e
      // recusou — "sem permissão pra controlar operações" ou "operação já
      // tem dono" (ver Configurações → Usuários / podeControlarOperacao()
      // em server.js). Mostra na hora, senão a pessoa fica digitando sem
      // nenhum feedback de que nada está sendo transmitido.
      _opAndamentoUltimoEnviado = undefined; // não foi aceito — não conta como "já enviado"
      const json = await res.json().catch(() => null);
      mostrarAlerta(json?.erro || 'Você não está autorizado a controlar a operação.', { tipo: 'erro' });
      return;
    }
    // Registra a revisão da PRÓPRIA mudança — o eco desta mesma mudança
    // via WebSocket é filtrado (origemClientId bate com o desta aba, ver
    // _abrirWsOperacaoAndamento), então é só por aqui que esta aba fica
    // sabendo sua revisão mais recente, pra comparar corretamente com a
    // PRÓXIMA atualização que chegar de outra aba/dispositivo.
    const json = await res.json().catch(() => null);
    if (json && typeof json.revisao === 'number' && json.revisao > _opAndamentoUltimaRevisaoConhecida) {
      _opAndamentoUltimaRevisaoConhecida = json.revisao;
    }
  } catch (_) {
    _opAndamentoUltimoEnviado = undefined;
    // Sem conexão — a tela segue funcionando normalmente em modo local
    // (mesmo comportamento de antes desta sincronização existir); a
    // próxima mudança tenta de novo.
  }
}

/**
 * Busca o snapshot atual da operação em andamento direto do servidor —
 * usado ao abrir a tela. Lança erro só em falha de REDE de verdade (sem
 * conexão); ausência de operação em andamento é null, não erro.
 */
async function getOperacaoAndamento() {
  const res = await fetch('db/operacao_andamento.json?_=' + Date.now());
  if (res.status === 404) return null; // arquivo ainda não existe = nenhuma operação ainda
  if (!res.ok) throw new Error('Erro ao consultar operação em andamento');
  const texto = await res.text();
  if (!texto.trim()) return null;
  try { return JSON.parse(texto) || null; } catch (_) { return null; }
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
 * Equivalente a calcPaineis(), mas pra Montagem Personalizada — em vez de
 * uma proporção fixa por berço (igual em todos os berços), cada berço tem
 * seu próprio tipo (ou null = vazio/não usado), vindo da grade montada em
 * Registrar Operação. Soma berço a berço e devolve EXATAMENTE o mesmo
 * formato de calcPaineis(), pra tudo que já consome paineis_por_tipo/
 * m2_por_tipo (OEE, Análise Operacional, exportações, Registro de
 * Baterias) funcionar sem nenhuma mudança.
 * @param {Array<string|null>} bercosPersonalizados - um item por berço, ex: ['sp','sp','3t',null,...]
 */
function calcPaineisPersonalizado(bercosPersonalizados) {
  const paineis_por_tipo = {};
  let paineis_total = 0;

  (bercosPersonalizados || []).forEach(tipo => {
    if (!tipo) return; // berço vazio/não usado — não soma em nenhum tipo
    const opcao = (MONTAGEM_OPCOES || []).find(o => o.modo === 'simples' && o.tipo === tipo);
    const porBerco = opcao ? (Number(opcao['paineis_' + tipo + '_por_berco']) || 0) : 0;
    paineis_por_tipo[tipo] = (paineis_por_tipo[tipo] || 0) + porBerco;
    paineis_total += porBerco;
  });

  const m2_por_tipo = {};
  Object.keys(paineis_por_tipo).forEach(tipo => {
    m2_por_tipo[tipo] = paineis_por_tipo[tipo] * M2_POR_PAINEL;
  });
  const m2_total = paineis_total * M2_POR_PAINEL;

  let placas_cimenticia = 0;
  Object.keys(paineis_por_tipo).forEach(tipo => {
    const c = CIMENTICIA_POR_TIPO[tipo];
    if (c && c.leva) placas_cimenticia += paineis_por_tipo[tipo] * (c.quantidade || 0);
  });

  return {
    total_paineis: paineis_total,
    m2_total,
    placas_cimenticia,
    paineis_por_tipo,
    m2_por_tipo,
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

// Converte um instante ISO (com hora, geralmente em UTC — ex: o
// inicio/fim de uma parada, salvos via new Date(...).toISOString() no
// navegador) pra data (YYYY-MM-DD) em Brasília. Diferente de
// historico/tracos, que já guardam um campo "data" próprio já em
// Brasília, "paradas" só guarda o instante ISO completo — pegar direto
// os 10 primeiros caracteres desse ISO (ex: p.inicio.slice(0,10)) dá a
// data em UTC, não em Brasília. Isso é inofensivo a maior parte do dia,
// mas entre ~21h e 23h59 em Brasília (UTC-3), o instante em UTC já virou
// o dia seguinte — uma parada registrada "hoje à noite" ganhava
// silenciosamente a data de amanhã pros filtros, e sumia do Registro de
// Paradas e do relatório de OEE sempre que o filtro não incluísse esse
// dia seguinte (ex: filtro só de "hoje" no fim do período, ou range que
// termina hoje). Usar esta função em vez de slice(0,10) em qualquer
// comparação de data com inicio/fim de parada.
function dataBrasiliaDeISO(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

// ---- Presets de período para filtros de dashboard (Todos / Hoje / Essa
// semana / Esse mês / Mês passado) — usado em Análise Operacional e CEP.
// Retorna { ini, fim } no formato YYYY-MM-DD; 'todos' retorna '' em ambos
// (sem restrição de data).
function calcularPeriodoPreset(preset) {
  const pad = n => String(n).padStart(2, '0');
  const toStr = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const hoje = nowBrasilia();
  const todayStr = todayBrasilia();
  const y = hoje.getUTCFullYear();
  const m = hoje.getUTCMonth();
  const d = hoje.getUTCDate();

  switch (preset) {
    case 'hoje':
      return { ini: todayStr, fim: todayStr };

    case 'semana': {
      // Semana começando na segunda-feira, até hoje.
      const diaSemana = hoje.getUTCDay(); // 0=domingo ... 6=sábado
      const offsetSegunda = diaSemana === 0 ? 6 : diaSemana - 1;
      const inicioSemana = new Date(hoje.getTime() - offsetSegunda * 86400000);
      return {
        ini: toStr(inicioSemana.getUTCFullYear(), inicioSemana.getUTCMonth(), inicioSemana.getUTCDate()),
        fim: todayStr,
      };
    }

    case 'mes':
      return { ini: toStr(y, m, 1), fim: todayStr };

    case 'mes_passado': {
      const mesAnterior = m === 0 ? 11 : m - 1;
      const anoAnterior = m === 0 ? y - 1 : y;
      const ultimoDia = new Date(Date.UTC(anoAnterior, mesAnterior + 1, 0)).getUTCDate();
      return {
        ini: toStr(anoAnterior, mesAnterior, 1),
        fim: toStr(anoAnterior, mesAnterior, ultimoDia),
      };
    }

    default: // 'todos'
      return { ini: '', fim: '' };
  }
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

// ---- Desemplaque (tempo de cura) ----
// Regra operacional: depois do FIM da injeção, a bateria precisa de
// TEMPO_CURA_HORAS horas de cura antes de poder ser desemplacada. O
// horário do desemplaque é sempre calculado a partir do FIM (nunca do
// início) da injeção.
const TEMPO_CURA_HORAS = 8;

/**
 * Calcula o horário de desemplaque (ISO string) a partir do horário de FIM
 * da injeção, somando TEMPO_CURA_HORAS horas de cura.
 * @param {string} fimISO - horário de fim da injeção (ISO string)
 * @returns {string|null}
 */
function calcularDesemplaque(fimISO) {
  if (!fimISO) return null;
  const fim = new Date(fimISO);
  if (isNaN(fim.getTime())) return null;
  return new Date(fim.getTime() + TEMPO_CURA_HORAS * 60 * 60 * 1000).toISOString();
}

// Formata uma data/hora como "DD/MM HH:MM" — usada pelo horário de
// desemplaque, que (por ser 8h depois do fim da injeção) pode cair num dia
// diferente do início/fim, então mostrar só a hora seria ambíguo.
function formatDateTime(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return '—';
  const data = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `${data} ${hora}`;
}

// ---- Seeder — import data from original spreadsheet ----
// Pre-load the historical records from the original xlsm into localStorage
// so dashboards show real data from day one.

// ---- Relatório de Injeção ----

async function registrarRelatorioInjecao(record, modoTeste = false) {
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

  const res = await fetch(_comModoTeste(_comDeviceId('/registrar-relatorio-injecao'), modoTeste), {
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
 * Relatório de Berços — 1 item por operação, cada um já com a lista de
 * berços (B1..Bn) e seus estados esquerda/direita ('okay'/'baixou').
 * Usado pela página "Relatório de Berços" (ver relatorio-bercos.js).
 */
async function getRelatorioBercos() {
  try {
    const res = await fetch('db/relatorio_bercos.json');
    if (!res.ok) return [];
    return await res.json();
  } catch (_) { return []; }
}

/**
 * Detalhe completo de uma operação — operação, berços visuais, receita
 * de cada traço (com ajustes) e avaliação de qualidade vinculada, tudo
 * ligado por id_operacao. Usado pela Análise Focada. Devolve null se a
 * operação não existir (404) ou em caso de falha de rede.
 */
async function getDetalheOperacao(idOperacao) {
  try {
    const res = await fetch('db/detalhe_operacao.json?id=' + encodeURIComponent(idOperacao));
    if (!res.ok) return null;
    return await res.json();
  } catch (_) { return null; }
}

/**
 * Correlação Traço × Berço — 1 item por uso de traço, com nº de ajustes
 * (instabilidade da receita) e taxa de vazamento dos berços que aquele
 * traço encheu. Usado pelo gráfico de dispersão "Traço Instável ×
 * Vazamento" na Análise de Berços.
 */
async function getCorrelacaoTracoBerco() {
  try {
    const res = await fetch('db/correlacao_traco_berco.json');
    if (!res.ok) return [];
    return await res.json();
  } catch (_) { return []; }
}

// ---- Ajustes de Traço (auditoria) ----
// Histórico de cada ajuste de receita (insumo + tempo de batida juntos)
// feito num traço, guardado por id_traco em ajustes_tracos.json. A
// numeração de "ajuste_N" é decidida no servidor (ver /registrar-ajuste-traco
// em server.js) — não interfere no traço em si, é só o log de auditoria.
async function registrarAjusteTraco(idTraco, ajuste, modoTeste = false) {
  const res = await fetch(_comModoTeste('/registrar-ajuste-traco', modoTeste), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id_traco: idTraco, ajuste }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.erro || 'Erro ao registrar ajuste do traço');
  return json;
}

async function getAjustesTracos() {
  try {
    const res = await fetch('db/ajustes_tracos.json');
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (_) { return []; }
}

/**
 * Corrige um traço já registrado em relatorio_injecao.json — TODOS os
 * dados (identificação, dados do uso/bateria específico clicado, insumos,
 * tempo de batida) e, junto, regrava ajustes_tracos.json a partir da
 * mesma lista de ajustes (fonte de verdade — ver rota no server.js).
 * @param {object} payload - { id_traco, id_operacao, novosValores, ajustes, diff }
 */
async function editarTracoRelatorio(payload) {
  const res = await fetch('/editar-traco-relatorio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.erro || 'Erro ao editar traço');
  return json;
}

/**
 * Obtém o total de traços já CONFIRMADOS hoje (Brasília) — apenas leitura,
 * não consome/incrementa nada. Usado para calcular a numeração de PRÉVIA
 * (total+1, total+2, ...) dos traços ainda em edição na operação atual.
 * O número só se torna definitivo quando a operação é finalizada — ver
 * confirmarTracosHoje().
 * @returns {Promise<number>} total de traços confirmados hoje
 */
async function getTotalTracosHoje(modoTeste = false) {
  const url = _comModoTeste('/total-tracos-hoje?_=' + Date.now(), modoTeste); // evita cache
  const res = await fetch(url);
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
async function confirmarTracosHoje(quantidade, modoTeste = false) {
  const res = await fetch(_comModoTeste(_comDeviceId('/confirmar-tracos-hoje'), modoTeste), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quantidade }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.erro || 'Erro ao confirmar traços do dia');
  return json.total;
}

// ---- Analytics ----

async function registrarOperacao(record, modoTeste = false) {
  // wsClientId vai por query string (não no corpo) — é só pro servidor
  // saber quem EXCLUIR do broadcast de "operação finalizada" (ver
  // OP_ANDAMENTO_CLIENT_ID/conectarOperacaoAndamento acima); não tem nada
  // a ver com o registro em si, então não deve poluir o `record` salvo.
  let url = _comModoTeste(_comDeviceId('/registrar-operacao'), modoTeste);
  url += (url.includes('?') ? '&' : '?') + 'wsClientId=' + encodeURIComponent(OP_ANDAMENTO_CLIENT_ID);

  const res = await fetch(url, {
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
  // Garante desemplaque em todos os registros — calculado na hora pros
  // registros antigos (de antes deste campo existir), que só têm "fim"
  // salvo. Registros novos já vêm com "desemplaque" salvo por operacao.js;
  // aqui só preenchemos quando estiver faltando.
  baterias.forEach(b => { if (!b.desemplaque) b.desemplaque = calcularDesemplaque(b.fim); });
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
async function getSobra(modoTeste = false) {
  try {
    const caminho = modoTeste ? 'db/teste/sobra.json' : 'db/sobra.json';
    const res = await fetch(caminho + '?_=' + Date.now()); // evita cache
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
async function salvarSobra(sobra, modoTeste = false) {
  const res = await fetch(_comModoTeste('/salvar-sobra', modoTeste), {
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
async function desativarSobra(motivo, modoTeste = false) {
  const atual = await getSobra(modoTeste);
  if (!atual) return; // já não existe sobra ativa
  await salvarSobra({ ...atual, ativa: false, status: motivo, dataEncerramento: new Date().toISOString() }, modoTeste);
}

// ---- Export ----

// ---- Alerta customizado (substitui o alert() nativo do navegador) ----
// Mesmo padrão visual usado nos modais de Sobra de Traço (operacao.js):
// overlay + card central, com ícone/título de acordo com o tipo. Diferente
// do alert() nativo, não bloqueia a thread (é baseado em Promise) — quem
// precisar esperar o usuário fechar antes de continuar (ex: antes de um
// reload) deve usar `await`.

const _ALERTA_ESTILOS = {
  sucesso: { icon: '✅', cor: 'var(--green)', titulo: 'Sucesso' },
  erro: { icon: '❌', cor: 'var(--red)', titulo: 'Erro' },
  aviso: { icon: '⚠️', cor: 'var(--red)', titulo: 'Atenção' },
  info: { icon: 'ℹ️', cor: 'var(--accent)', titulo: 'Aviso' },
};

function _escaparHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Exibe um modal de alerta customizado (substitui o alert() nativo).
 * @param {string} mensagem - Texto a exibir (quebras de linha \n são respeitadas).
 * @param {object} [opcoes]
 * @param {'sucesso'|'erro'|'aviso'|'info'} [opcoes.tipo='info']
 * @param {string} [opcoes.titulo] - Sobrescreve o título padrão do tipo.
 * @returns {Promise<void>} resolve quando o usuário fecha o modal (clique no OK, Enter ou Esc).
 */
function mostrarAlerta(mensagem, opcoes = {}) {
  const estilo = _ALERTA_ESTILOS[opcoes.tipo] || _ALERTA_ESTILOS.info;
  const titulo = opcoes.titulo || estilo.titulo;

  return new Promise(resolve => {
    const anterior = document.getElementById('modal-alerta-global');
    if (anterior) anterior.remove();

    const modal = document.createElement('div');
    modal.id = 'modal-alerta-global';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:10100;display:flex;align-items:center;justify-content:center;padding:20px';

    modal.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);
                  padding:32px;width:440px;max-width:92vw;box-shadow:0 24px 80px rgba(0,0,0,.6)">
        <div style="text-align:center;margin-bottom:16px">
          <div style="font-size:2.2rem;margin-bottom:8px">${estilo.icon}</div>
          <h2 style="font-family:var(--font-display);font-size:1.3rem;color:${estilo.cor};margin:0">
            ${_escaparHtml(titulo)}
          </h2>
        </div>
        <p style="color:var(--text-2);text-align:center;margin-bottom:24px;line-height:1.5;white-space:pre-line">${_escaparHtml(mensagem)}</p>
        <button id="btn-alerta-ok"
          style="width:100%;padding:12px;background:var(--accent);color:#000;border:none;border-radius:var(--radius);
                 font-weight:700;font-size:.9rem;cursor:pointer">
          OK
        </button>
      </div>`;

    document.body.appendChild(modal);

    const fechar = () => {
      modal.remove();
      document.removeEventListener('keydown', onKeydown);
      resolve();
    };
    const onKeydown = (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') fechar();
    };

    document.getElementById('btn-alerta-ok').addEventListener('click', fechar);
    document.addEventListener('keydown', onKeydown);
    document.getElementById('btn-alerta-ok').focus();
  });
}

/**
 * Exibe um modal de confirmação customizado (substitui o confirm() nativo
 * do navegador) — mesmo padrão visual usado nos modais de Sobra de Traço.
 * @param {string} mensagem
 * @param {object} [opcoes]
 * @param {string} [opcoes.titulo='Confirmar ação']
 * @param {string} [opcoes.textoConfirmar='Confirmar']
 * @param {string} [opcoes.textoCancelar='Cancelar']
 * @param {'padrao'|'perigo'} [opcoes.tipo='padrao'] - 'perigo' deixa o botão de confirmar vermelho.
 * @param {string} [opcoes.icon='❓']
 * @returns {Promise<boolean>} true se confirmado, false se cancelado (botão, Esc ou clique fora).
 */
function mostrarConfirmacao(mensagem, opcoes = {}) {
  const titulo = opcoes.titulo || 'Confirmar ação';
  const textoConfirmar = opcoes.textoConfirmar || 'Confirmar';
  const textoCancelar = opcoes.textoCancelar || 'Cancelar';
  const perigo = opcoes.tipo === 'perigo';
  const corConfirmar = perigo ? 'var(--red)' : 'var(--accent)';
  const corTextoConfirmar = perigo ? '#fff' : '#000';
  const icon = opcoes.icon || '❓';

  return new Promise(resolve => {
    const anterior = document.getElementById('modal-confirmacao-global');
    if (anterior) anterior.remove();

    const modal = document.createElement('div');
    modal.id = 'modal-confirmacao-global';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:10100;display:flex;align-items:center;justify-content:center;padding:20px';

    modal.innerHTML = `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);
                  padding:32px;width:440px;max-width:92vw;box-shadow:0 24px 80px rgba(0,0,0,.6)">
        <div style="text-align:center;margin-bottom:16px">
          <div style="font-size:2.2rem;margin-bottom:8px">${icon}</div>
          <h2 style="font-family:var(--font-display);font-size:1.3rem;color:var(--text);margin:0">
            ${_escaparHtml(titulo)}
          </h2>
        </div>
        <p style="color:var(--text-2);text-align:center;margin-bottom:24px;line-height:1.5;white-space:pre-line">${_escaparHtml(mensagem)}</p>
        <div style="display:flex;gap:12px">
          <button id="btn-confirmacao-confirmar"
            style="flex:1;padding:12px;background:${corConfirmar};color:${corTextoConfirmar};border:none;border-radius:var(--radius);
                   font-weight:700;font-size:.9rem;cursor:pointer">
            ${_escaparHtml(textoConfirmar)}
          </button>
          <button id="btn-confirmacao-cancelar"
            style="flex:1;padding:12px;background:var(--bg-2);color:var(--text);border:1px solid var(--border);
                   border-radius:var(--radius);font-size:.9rem;cursor:pointer">
            ${_escaparHtml(textoCancelar)}
          </button>
        </div>
      </div>`;

    document.body.appendChild(modal);

    const fechar = (resultado) => {
      modal.remove();
      document.removeEventListener('keydown', onKeydown);
      resolve(resultado);
    };
    const onKeydown = (e) => {
      if (e.key === 'Enter') fechar(true);
      if (e.key === 'Escape') fechar(false);
    };

    document.getElementById('btn-confirmacao-confirmar').addEventListener('click', () => fechar(true));
    document.getElementById('btn-confirmacao-cancelar').addEventListener('click', () => fechar(false));
    document.addEventListener('keydown', onKeydown);
    document.getElementById('btn-confirmacao-confirmar').focus();
  });
}

// ---- Export ----

/**
 * Baixa uma string como arquivo — mesmo mecanismo (Blob + <a> temporário)
 * já usado por fazerBackupDados()/fazerBackupGeral() (app-core.js), só
 * que genérico: qualquer tela pode chamar pra baixar texto/HTML/JSON sem
 * duplicar esse boilerplate.
 * Usado pelos botões "🌐 Exportar Interativo" dos dashboards (Setor de
 * Qualidade, OEE, Desempenho Turnos, Análise Operacional, Análise de
 * Berços, CEP, Análise Focada) — cada um monta seu próprio HTML
 * autossuficiente (dados + gráficos + filtros embutidos) e só chama isto
 * pra efetivamente baixar.
 * @param {string} nomeArquivo
 * @param {string} conteudo
 * @param {string} mimeType - default 'text/html'
 */
function baixarArquivoTexto(nomeArquivo, conteudo, mimeType = 'text/html') {
  const blob = new Blob([conteudo], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nomeArquivo;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// CSS compartilhado por TODOS os exports de "Dashboard Interativo" (Setor
// de Qualidade, OEE, Desempenho Turnos, Análise Operacional, Análise de
// Berços, CEP, Análise Focada) — cada um gera seu próprio HTML
// autossuficiente, mas todos reaproveitam esta mesma paleta/layout base
// (cabeçalho, filtros, grade de KPIs, chart-box, resumo), só some com o
// resto do CSS que cada tela cria em cima disso pra seus gráficos
// específicos.
//
// gerarCssExportPadrao() — antes era uma string FIXA (sempre a mesma
// paleta clara, nada a ver com o tema escolhido na tela) — agora é uma
// função que lê o tema ATUAL (data-theme no <html>, ver
// aplicarTema()/theme picker, app-core.js) e devolve a paleta
// correspondente, pra o arquivo exportado parecer visualmente com a tela
// de onde ele saiu, não um template genérico à parte. 3 paletas fixas
// (não getComputedStyle direto): as variáveis do app "cru" (--text-3,
// por exemplo, é branco puro ali — usado como destaque forte em outro
// contexto) não bateriam com o PAPEL que cada variável tem AQUI (ex:
// --text-3 aqui é o tom mais apagado, pra legendas/rodapé) — 3 paletas
// próprias, uma por tema, evita herdar semântica errada.
const _PALETAS_EXPORT_POR_TEMA = {
  dark: { // tema padrão do app (sem data-theme) — azul-marinho neutro
    bg1: '#0d0f12', bgCard: '#1e2229', border: '#2a2f3a', border2: '#353c4a',
    text: '#e8eaf0', text2: '#9aa3b2', text3: '#6b7688',
    blue: '#3b82f6', red: '#ef4444', green: '#10b981', accent: '#2968ff',
    shadow: '0 4px 24px rgba(0,0,0,.5)',
  },
  light: {
    bg1: '#f0f2f5', bgCard: '#ffffff', border: '#d1d5db', border2: '#b0b7c3',
    text: '#111827', text2: '#4b5563', text3: '#8492a6',
    blue: '#2563eb', red: '#dc2626', green: '#059669', accent: '#2968ff',
    shadow: '0 4px 24px rgba(0,0,0,.10)',
  },
  lightwall: { // azul-marinho + laranja, paleta institucional (ver styles.css)
    bg1: '#0a1626', bgCard: '#122236', border: '#1f3450', border2: '#2c4a6b',
    text: '#eef2f7', text2: '#9fb0c4', text3: '#6f8296',
    blue: '#3b82f6', red: '#ef4444', green: '#1fb88a', accent: '#2968ff',
    shadow: '0 4px 24px rgba(0,0,0,.55)',
  },
};
// Roxo/amarelo/laranja/ciano são só cores AUXILIARES de gráfico (scatter,
// séries extras) — não têm variável equivalente no app em si, então ficam
// fixas, iguais nos 3 temas (não precisam combinar com "fundo/texto").
const _CORES_AUXILIARES_EXPORT = { purple: '#8b5cf6', yellow: '#f1c40f', orange: '#f5821f', cyan: '#06b6d4' };

function gerarCssExportPadrao() {
  let nomeTema = 'dark';
  try { nomeTema = document.documentElement.getAttribute('data-theme') || 'dark'; } catch (e) { /* sem document (não deveria acontecer aqui, mas não quebra) */ }
  const p = _PALETAS_EXPORT_POR_TEMA[nomeTema] || _PALETAS_EXPORT_POR_TEMA.dark;
  const a = _CORES_AUXILIARES_EXPORT;
  return `
  :root {
    --blue:${p.blue}; --red:${p.red}; --green:${p.green}; --accent:${p.accent};
    --text:${p.text}; --text-2:${p.text2}; --text-3:${p.text3};
    --border:${p.border}; --border-2:${p.border2};
    --bg-1:${p.bg1}; --bg-card:${p.bgCard};
    --radius:8px; --radius-lg:12px;
    --purple:${a.purple}; --yellow:${a.yellow}; --orange:${a.orange}; --cyan:${a.cyan};
    --font-mono: 'SFMono-Regular', Consolas, monospace;
  }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif; background:var(--bg-1); color:var(--text-2); padding:28px; }
  h1 { font-size:1.3rem; color:var(--text); margin:0 0 4px; }
  .sub { font-size:.8rem; color:var(--text-3); margin-bottom:20px; }
  .filtros { display:flex; gap:14px; flex-wrap:wrap; align-items:flex-end; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-lg); padding:14px 16px; margin-bottom:20px; }
  .campo { display:flex; flex-direction:column; gap:4px; font-size:.75rem; color:var(--text-3); }
  .campo input, .campo select { font:inherit; padding:6px 8px; border:1px solid var(--border); border-radius:var(--radius); background:var(--bg-1); color:var(--text-2); }
  .botao { padding:7px 16px; border-radius:var(--radius); border:1px solid var(--accent); background:var(--accent); color:#fff; font-size:.8rem; cursor:pointer; }
  .botao:hover { opacity:.9; }
  /* Chip de "filtro aplicado" — export agora é um RETRATO fixo do que
     estava na tela (ver comentário em cada exportarInterativo), não tem
     mais inputs de filtro pra reaplicar; isto substitui visualmente o
     antigo bloco ".filtros" com inputs, mostrando só o que foi usado. */
  .filtro-aplicado { display:inline-flex; align-items:center; gap:8px; background:var(--bg-card); border:1px solid var(--border); border-radius:999px; padding:6px 14px; font-size:.78rem; color:var(--text-2); margin-bottom:20px; }
  .filtro-aplicado b { color:var(--text); }
  .kpi-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:20px; }
  .kpi-card { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-lg); padding:14px; }
  .kpi-label { font-size:.68rem; text-transform:uppercase; letter-spacing:.06em; color:var(--text-3); margin-bottom:6px; }
  .kpi-value { font-size:1.7rem; font-weight:700; color:var(--text); }
  .green{color:var(--green)} .red{color:var(--red)} .accent{color:var(--accent)}
  .charts-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:14px; margin-bottom:20px; }
  .chart-box { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-lg); padding:16px; }
  .chart-box h4 { margin:0 0 10px; font-size:.72rem; text-transform:uppercase; letter-spacing:.08em; color:var(--text-2); border-bottom:1px solid var(--border); padding-bottom:8px; font-weight:600; }
  .summary-box { background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-lg); padding:16px; font-size:.85rem; }
  .rodape { margin-top:22px; font-size:.7rem; color:var(--text-3); text-align:center; }
  table { width:100%; border-collapse:collapse; font-size:.8rem; }
  th, td { padding:6px 8px; text-align:left; border-bottom:1px solid var(--border); }
  th { font-size:.68rem; text-transform:uppercase; color:var(--text-3); }
  .lw-tooltip {
    display:none; position:fixed; z-index:99999; left:0; top:0;
    max-width:min(260px, calc(100vw - 24px)); padding:8px 12px;
    background:var(--bg-card); border:1px solid var(--border-2); border-radius:var(--radius);
    box-shadow:0 8px 24px rgba(0,0,0,.15); color:var(--text-2);
    font-size:.78rem; line-height:1.45; white-space:pre-line; pointer-events:none;
  }
`;
}

// Fonte de tooltip.js, embutida literalmente (não dá pra usar o truque de
// toString() por função — as funções de tooltip.js vivem dentro da PRÓPRIA
// IIFE dele, não são identificadores soltos que analise-operacional.js
// (ou qualquer outro dashboard) possa referenciar direto) — usada pelos
// exports de dashboard que têm gráfico em canvas com hover (Análise
// Operacional, Análise de Berços, CEP): cola isto num <script> do HTML
// exportado, ANTES do restante do script daquele dashboard, pra
// LW.tooltip.ligarHoverCanvas existir do mesmo jeito que existe na tela
// ao vivo (mesmo comentário de tooltip.js sobre ordem de carregamento:
// isto pisa em cima de um window.LW já existente, nunca zera ele).
const TOOLTIP_JS_FONTE = `
  (function () {
    let tooltipEl = null;
    let alvoAtivo = null;
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
    function esconder() {
      if (tooltipEl) tooltipEl.style.display = 'none';
      alvoAtivo = null;
    }
    function ligarHoverCanvas(canvas, acharTexto) {
      if (canvas._hoverLigado) return;
      canvas._hoverLigado = true;
      canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        const texto = acharTexto(e.clientX - rect.left, e.clientY - rect.top);
        if (texto) { canvas.style.cursor = 'pointer'; mostrarTexto(texto, e.clientX, e.clientY); }
        else { canvas.style.cursor = 'default'; esconder(); }
      });
      canvas.addEventListener('mouseleave', () => { esconder(); canvas.style.cursor = 'default'; });
      let _ultimoTexto = null;
      canvas.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        const rect = canvas.getBoundingClientRect();
        const texto = acharTexto(t.clientX - rect.left, t.clientY - rect.top);
        if (texto && texto === _ultimoTexto) { esconder(); _ultimoTexto = null; }
        else if (texto) { mostrarTexto(texto, t.clientX, t.clientY); _ultimoTexto = texto; }
        else { esconder(); _ultimoTexto = null; }
        e.stopPropagation();
      }, { passive: true });
    }
    window.LW = window.LW || {};
    window.LW.tooltip = { mostrarTexto, esconder, ligarHoverCanvas };
  })();
`;

window.LW = {
  // Constantes fixas
  TURNO_OPTS,
  M2_POR_PAINEL,
  LIMITE_INJECAO_MIN,

  // Getters dinâmicos — leem do estado após config.json carregar
  get DIMENSAO_OPTS() { return DIMENSAO_OPTS; },
  get PALETES_CONFIG() { return PALETES_CONFIG; },
  PALETES_CONFIG_DEFAULT,
  paletesConfigValida: _paletesConfigValida,
  get PALETES_ORDEM() { return PALETES_ORDEM; },
  PALETES_ORDEM_DEFAULT,
  paletesOrdemValida: _paletesOrdemValida,
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
  corPorTipoSimples,
  resumoBercosPersonalizados,

  // Storage
  getOperacaoAtual, saveOperacaoAtual, clearOperacaoAtual,
  enfileirarOperacaoPendente, tamanhoFilaPendentes,
  tentarSincronizarFilaPendentes, aoMudarFilaPendentes, aoSincronizarPendentes,

  // Operação em Andamento (sincronização ao vivo via WebSocket)
  conectarOperacaoAndamento, enviarOperacaoAndamento, getOperacaoAndamento,
  aoReceberDadosSqlExcluidos,
  get OP_ANDAMENTO_CLIENT_ID() { return OP_ANDAMENTO_CLIENT_ID; },

  // Log de Acesso
  getDeviceId, registrarAcesso,
  nomeDeQuemEstaLogado,
  dispositivoEstaAutorizado, motivoBloqueioOperacao,

  // Dispositivos Autorizados (Configurações → Dispositivos Autorizados)
  listarDispositivosAutorizados, autorizarDispositivo, removerDispositivo,
  get DISPOSITIVOS_AUTORIZADOS() { return DISPOSITIVOS_AUTORIZADOS; },

  // Cálculos
  calcPaineis,
  calcPaineisPersonalizado,
  TIPO_MONTAGEM_PERSONALIZADA,
  normalizarPaineisRegistro,
  somarPorTipo,
  extrairComponentesMontagem,

  // Formatação
  formatTime, diffMinutes, formatDuration, formatDateTime,

  // Períodos (presets de filtro de data — Hoje/Semana/Mês/etc.)
  calcularPeriodoPreset,

  // Desemplaque (tempo de cura)
  TEMPO_CURA_HORAS, calcularDesemplaque,

  // Relatório de Injeção
  registrarRelatorioInjecao,
  getRelatorioInjecao,
  getRelatorioBercos,
  getDetalheOperacao,
  getCorrelacaoTracoBerco,
  getTotalTracosHoje,
  confirmarTracosHoje,

  // Ajustes de Traço (auditoria de insumo + tempo de batida)
  registrarAjusteTraco,
  getAjustesTracos,
  editarTracoRelatorio,

  // Dados e analytics
  registrarOperacao, getStats,

  // Sobra de traço
  getSobra, salvarSobra, desativarSobra,

  // Alerta customizado (substitui alert() nativo)
  mostrarAlerta,

  // Confirmação customizada (substitui confirm() nativo)
  mostrarConfirmacao,

  // Escape de HTML — usar sempre que texto livre (digitado pelo usuário)
  // for inserido via innerHTML, pra evitar XSS armazenado.
  escaparHtml: _escaparHtml,
  baixarArquivoTexto,
  gerarCssExportPadrao,
  TOOLTIP_JS_FONTE,
};