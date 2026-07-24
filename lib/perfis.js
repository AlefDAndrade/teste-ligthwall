// ─── lib/perfis.js — Perfis de acesso e permissões (visualizar × editar) ───
// Fonte ÚNICA de verdade sobre "o que cada perfil pode ver e o que pode
// EDITAR" — usada tanto no backend (pra validar de verdade, não só confiar
// no front) quanto exposta ao front via GET /perfis (app-core.js usa isso
// pra montar o menu, travar Configurações e esconder controles de edição).
//
// MODELO NOVO (substituiu o antigo "lista de páginas por perfil"):
// — Quase todas as PÁGINAS são abertas pra VISUALIZAÇÃO por todos os
//   perfis (proteção não é mais "quem vê o quê", é "quem EDITA o quê").
// — O que varia por perfil são as ÁREAS DE EDIÇÃO (ver AREAS_DE_EDICAO,
//   abaixo): registrar/alterar dados de injetora, paradas, qualidade e
//   manutenção.
// — Configurações: todos os perfis continuam vendo só Atalhos de Teclado;
//   APENAS o perfil "Administrativo" (rótulo na tela: "Administrador") tem
//   acesso livre a tudo nas Configurações — igual ao Administrador Master.
//
// 7 perfis no total, 6 CADASTRÁVEIS (ver criarUsuario,
// lib/rotas/usuarios.js) — "Administrador" (AdminMaster) continua sendo a
// senha única mestra de sempre (botão "Administrador" na tela de login),
// nunca um usuário com nome+senha própria. Os 6 cadastráveis são
// atribuídos pelo Administrador ao cadastrar um usuário novo (ver POST
// /salvar-usuarios).
//
// NOTA sobre nomes internos: o id interno do perfil cadastrável
// "Administrador" é `Administrativo` — o id `Administrador` já é usado no
// sistema inteiro (sessionStorage.lw_role, lib/sessao.js) pra identificar o
// Administrador MASTER (senha mestra), então reaproveitar esse id pra um
// usuário cadastrado quebraria o boot (ver app-core.js, DOMContentLoaded).
// Na interface os dois aparecem como "Administrador"; internamente,
// `Administrativo` = cadastrado, `Administrador` = master.

const itensPermissao = require('./itens-permissao.js');

// ─── Áreas de edição ─────────────────────────────────────────────────────
// Cada área agrupa as rotas de ESCRITA de um domínio (a leitura é livre):
// - 'injetora'............ Registrar Operação (iniciar/registrar), sobra,
//                          relatório de injeção e EDIÇÃO do histórico
//                          (editar operação / editar traço já salvos).
// - 'paradas'............. Registrar/editar/excluir paradas.
// - 'qualidade'........... Avaliações do Setor de Qualidade.
// - 'manutencao'.......... Manutenção completa (chamados, programada,
//                          fechamento de chamado).
// - 'manutencao-chamado'.. Só ABRIR um chamado corretivo (subconjunto de
//                          'manutencao' — quem tem 'manutencao' completa
//                          automaticamente tem esta também).
const AREAS_DE_EDICAO = ['injetora', 'paradas', 'qualidade', 'manutencao', 'manutencao-chamado'];

// ─── Perfis cadastráveis ─────────────────────────────────────────────────
// `editar: '*'` = edita tudo, incluindo Configurações completas (igual ao
// Administrador Master). Pra qualquer outro perfil, o que não está na
// lista `editar` fica como VISUALIZAÇÃO (páginas abertas, sem poder de
// registro/edição — o servidor valida isso de verdade em cada rota de
// escrita, ver podeEditar(), abaixo).
const PERFIS = {
  // Edição total de Manutenção pro Operador de Injetora — pedido do
  // usuário (junto com Supervisão, Administrador e Encarregado, abaixo,
  // ver conversa que motivou isso). Antes só tinha 'manutencao-chamado'
  // por padrão (nem isso — nem tinha acesso a Manutenção nenhum).
  OperadorInjetora: {
    rotulo: 'Operador de Injetora',
    editar: ['injetora', 'paradas', 'manutencao'],
  },
  AssistenteQualidade: {
    rotulo: 'Assistente de Qualidade',
    editar: ['qualidade', 'paradas'],
  },
  // 'manutencao-chamado' (só abrir chamado) virou 'manutencao' completa
  // — pedido do usuário, mesmo motivo do comentário em OperadorInjetora,
  // acima.
  Encarregado: {
    rotulo: 'Encarregado',
    editar: ['injetora', 'qualidade', 'paradas', 'manutencao'],
  },
  Manutencao: {
    rotulo: 'Manutenção',
    editar: ['manutencao', 'paradas'],
  },
  Supervisao: {
    rotulo: 'Supervisão',
    editar: ['injetora', 'qualidade', 'paradas', 'manutencao'],
  },
  // Rótulo "Administrador" na tela — ver NOTA sobre nomes internos, acima.
  // Igual ao Administrador Master em tudo: edição total + Configurações
  // completas (Dados, Usuários, Automação, SQL, Backup/Restauração,
  // Importação) — as rotas que antes eram exclusivas da sessão mestra
  // também aceitam a sessão de um usuário com este perfil (ver
  // temPoderesDeAdmin em server.js).
  Administrativo: {
    rotulo: 'Administrador',
    editar: '*',
  },
};

// ─── Páginas de trabalho ─────────────────────────────────────────────────
// Cada valor é um "id de página" — mesmo valor usado em data-page="..."
// (nav-sidebar.html) e id="page-..." (showPage, app-core.js). TODAS são
// visíveis a TODOS os perfis (modelo novo: visualização aberta).
const PAGINAS_DE_TRABALHO = [
  'menu', 'operacao', 'turnos', 'registro', 'relatorio', 'relatorio-bercos',
  'oee', 'metas', 'paradas',
  'analise-focada', 'analise-bercos', 'analise-operacional',
  'setor-qualidade', 'manutencao',
];

// Abas do modal de Configurações ("config-*" não são páginas de verdade —
// não tem showPage nenhum com esses nomes; são as ABAS de dentro do modal,
// ver cfgMostrarSecao/modal-config.html). Todo perfil vê só Atalhos;
// APENAS o perfil Administrativo ("Administrador" cadastrado) vê todas —
// igual ao Administrador Master.
const ABAS_CONFIG_TODOS = ['config-atalhos'];
const ABAS_CONFIG_ADMIN = [
  'config-atalhos', 'config-dados', 'config-paletes', 'config-usuarios',
  'config-automacao', 'config-sql', 'config-autorizados', 'config-dispositivos',
];

// PAGINAS_POR_PERFIL mantido com o mesmo formato de sempre (o front e as
// rotas continuam consumindo essa estrutura) — só que agora computado:
// todas as páginas de trabalho pra todo mundo + as abas de config de cada
// um. "Administrador" (master) nunca listado aqui — paginaPermitida()
// trata esse perfil à parte (sempre `true`).
const PAGINAS_POR_PERFIL = {};
for (const [id, def] of Object.entries(PERFIS)) {
  const abas = def.editar === '*' ? ABAS_CONFIG_ADMIN : ABAS_CONFIG_TODOS;
  PAGINAS_POR_PERFIL[id] = [...PAGINAS_DE_TRABALHO, ...abas];
}

// Áreas de edição por perfil, no formato exposto ao front (GET /perfis) —
// '*' vira a lista completa pra o front não precisar tratar o caso especial.
const AREAS_EDICAO_POR_PERFIL = {};
for (const [id, def] of Object.entries(PERFIS)) {
  AREAS_EDICAO_POR_PERFIL[id] = def.editar === '*' ? [...AREAS_DE_EDICAO] : [...def.editar];
}

// Rótulos exibidos na interface (badge do cadastro, topbar, <select> de
// perfil em Configurações → Usuários).
const ROTULO_POR_PERFIL = {};
for (const [id, def] of Object.entries(PERFIS)) ROTULO_POR_PERFIL[id] = def.rotulo;

// Perfis que o Administrador pode atribuir a um usuário cadastrado (ver
// POST /salvar-usuarios). "Administrador" (master) de propósito FORA desta
// lista — não é atribuível a ninguém, é sempre a senha mestra da tela de
// login, nunca um campo de cadastro.
const PERFIS_CADASTRAVEIS = Object.keys(PERFIS);

// Perfis onde o checkbox "pode iniciar/encerrar operações" faz sentido:
// quem tem a área 'injetora' de edição — pros outros, a marcação não
// significaria nada (o perfil nem consegue registrar). O perfil
// Administrativo fica fora da lista de propósito: ele SEMPRE pode
// (irrestrito, igual ao master), então o checkbox nem aparece pra ele.
const PERFIS_COM_CONTROLE_DE_OPERACAO = PERFIS_CADASTRAVEIS.filter(
  p => PERFIS[p].editar !== '*' && PERFIS[p].editar.includes('injetora')
);

// ─── Funções de checagem (usadas pra VALIDAR DE VERDADE no servidor) ────

// Perfis com poderes totais de administração — o master (senha mestra) e o
// perfil cadastrável Administrativo ("Administrador" na tela). Usado pelas
// rotas que antes eram exclusivas do master (backup, SQL, importação,
// gerenciar usuários, salvar config — ver temPoderesDeAdmin, server.js).
function ehPerfilDeAdmin(perfil) {
  return perfil === 'Administrador' || perfil === 'Administrativo';
}

// Confere se `perfil` pode VER `pagina` — no modelo novo isso quase sempre
// é true (visualização aberta); o que continua restrito são as abas de
// Configurações. Mantida com a mesma assinatura de sempre porque tanto o
// front (menu) quanto as rotas já consomem essa função.
function paginaPermitida(perfil, pagina) {
  if (perfil === 'Administrador') return true; // master: irrestrito, sempre
  const lista = PAGINAS_POR_PERFIL[perfil];
  return Array.isArray(lista) && lista.includes(pagina);
}

// Confere se `perfil` pode EDITAR a `area` (ver AREAS_DE_EDICAO) — é a
// checagem central do modelo novo, chamada pelas rotas de ESCRITA de cada
// domínio (paradas, qualidade, manutenção, injetora/edição de histórico).
// 'manutencao' completa implica 'manutencao-chamado'.
function podeEditar(perfil, area) {
  if (ehPerfilDeAdmin(perfil)) return true; // master e Administrativo: tudo
  const def = PERFIS[perfil];
  if (!def) return false;
  if (def.editar === '*') return true;
  if (area === 'manutencao-chamado' && def.editar.includes('manutencao')) return true;
  return def.editar.includes(area);
}

// ─── Ponte pro catálogo item-a-item (voltou — ver conversa que motivou a
// mudança: engrenagem ao lado do campo "Perfil" em Configurações →
// Usuários) ─────────────────────────────────────────────────────────────
// Traduz a lógica HARDCODED acima (área/aba) pro mesmo formato item-a-item
// {itemId: 'total'|'visualizar'|'ocultar'} usado pelos perfis
// CUSTOMIZADOS (ver lib/itens-permissao.js, lib/perfis-customizados.js) —
// é o que a tela de "editar permissões" mostra PRÉ-MARCADO na primeira vez
// que se abre um perfil FIXO que ainda não tem override salvo (ver
// lib/perfis-fixos-overrides.js). Depois de salvo um override, o mapa
// salvo manda, este cálculo não é mais consultado pra aquele perfil — só
// serve de ponto de partida.
function permissoesPadraoDoPerfilFixo(perfilId) {
  const def = PERFIS[perfilId];
  if (!def) return null;
  const abasConfig = def.editar === '*' ? ABAS_CONFIG_ADMIN : ABAS_CONFIG_TODOS;
  const mapa = {};
  for (const item of itensPermissao.CATALOGO) {
    if (item.id === itensPermissao.ITEM_NOTIFICACAO_ABERTURA_CHAMADO) {
      // Caso especial (ver comentário no catálogo, lib/itens-permissao.js):
      // não é "área de edição" nenhuma — o padrão de cada perfil FIXO é
      // simplesmente "esse perfil mexe com Manutenção?" (mesma checagem
      // usada pra 'manutencao-chamado'/'manutencao-execucao', abaixo, só
      // que aqui decide quem é NOTIFICADO, não quem EDITA).
      mapa[item.id] = podeEditar(perfilId, 'manutencao') ? 'total' : 'ocultar';
    } else if (item.tipo === 'config') {
      mapa[item.id] = abasConfig.includes(item.id) ? 'total' : 'ocultar';
    } else if (item.area) {
      // Páginas/sub-itens ligados a uma área de edição: todo perfil fixo
      // VÊ (visualização aberta, ver comentário no topo do arquivo);
      // "total" só se o perfil de fato edita aquela área.
      mapa[item.id] = podeEditar(perfilId, item.area) ? 'total' : 'visualizar';
    } else {
      // Dashboards, páginas informativas — sem conceito de edição,
      // sempre visíveis (não há "total" pra eles no modelo fixo).
      mapa[item.id] = 'visualizar';
    }
  }
  return mapa;
}

module.exports = {
  AREAS_DE_EDICAO,
  PAGINAS_DE_TRABALHO,
  PAGINAS_POR_PERFIL,
  AREAS_EDICAO_POR_PERFIL,
  ROTULO_POR_PERFIL,
  PERFIS_CADASTRAVEIS,
  PERFIS_COM_CONTROLE_DE_OPERACAO,
  ehPerfilDeAdmin,
  paginaPermitida,
  podeEditar,
  permissoesPadraoDoPerfilFixo,
};