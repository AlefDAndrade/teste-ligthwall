// ─── lib/itens-permissao.js — Catálogo de itens permissionáveis ────────────
// Lista TODO item que um "Novo Tipo de Perfil" customizado (ver
// Configurações → Usuários → "+ Criar novo tipo de perfil") pode marcar
// como Acesso Total / Apenas Visualizar / Ocultar. Cobre páginas,
// dashboards, abas de Configurações, sub-itens (Setor de Qualidade,
// Manutenção) e ações transversais ("Outros").
//
// Cada item tem:
//   id ........ mesmo id usado em data-page/showPage quando aplicável
//               (pra reaproveitar a infraestrutura já existente de
//               mostrar/esconder telas); id novo e só nosso quando não
//               existe página própria (ex: ações de "Outros").
//   rotulo .... texto exibido no modal de criação de perfil e em badges.
//   tipo ...... 'pagina' | 'sub' | 'dashboard' | 'config' | 'acao' — só
//               organiza visualmente o catálogo em grupos, não muda a
//               lógica de permissão em si.
//   pai ....... id do item pai, se for um sub-item (Setor de Qualidade e
//               Manutenção têm sub-itens; Manutenção Corretiva por sua vez
//               tem 4 sub-seções do próprio formulário de chamado).
//   area ...... quando presente, é a área de edição (ver lib/perfis.js,
//               AREAS_DE_EDICAO) que este item CONCEDE quando marcado como
//               "Acesso Total" — é a ponte entre o nível granular
//               (total/visualizar/ocultar) escolhido no catálogo e a
//               validação de verdade já existente no servidor
//               (podeEditarArea, server.js). Itens sem "area" (a maioria
//               dos dashboards, "Outros", e páginas puramente informativas)
//               não têm um conceito de edição no backend — a distinção
//               "Total vs Visualizar" pra eles é só visual (mostra/some ou
//               habilita/desabilita o controle na tela), conforme decidido:
//               enforcement de verdade no servidor fica só nas 5 áreas já
//               existentes (injetora, paradas, qualidade, manutencao,
//               manutencao-chamado); o resto é validado apenas no front por
//               enquanto.
const CATALOGO = [
  // ── Páginas ──────────────────────────────────────────────────────────
  { id: 'operacao', rotulo: 'Registrar Operação', tipo: 'pagina', area: 'injetora' },
  { id: 'turnos', rotulo: 'Desempenho por Turno', tipo: 'pagina' },
  { id: 'registro', rotulo: 'Relatório de Bateria', tipo: 'pagina', area: 'injetora' },
  { id: 'relatorio', rotulo: 'Relatório de Injeção', tipo: 'pagina', area: 'injetora' },
  { id: 'relatorio-bercos', rotulo: 'Relatório de Berços', tipo: 'pagina' },
  { id: 'metas', rotulo: 'Metas', tipo: 'pagina' },
  { id: 'paradas', rotulo: 'Registro de Paradas', tipo: 'pagina', area: 'paradas' },

  { id: 'setor-qualidade', rotulo: 'Setor de Qualidade', tipo: 'pagina' },
  { id: 'qualidade-avaliacao', rotulo: 'Avaliação', tipo: 'sub', pai: 'setor-qualidade', area: 'qualidade' },
  { id: 'qualidade-dashboard', rotulo: 'Dashboard', tipo: 'sub', pai: 'setor-qualidade' },
  { id: 'qualidade-registro', rotulo: 'Registros', tipo: 'sub', pai: 'setor-qualidade' },

  { id: 'manutencao', rotulo: 'Manutenção', tipo: 'pagina' },
  { id: 'manutencao-corretiva', rotulo: 'Corretiva', tipo: 'sub', pai: 'manutencao' },
  { id: 'manutencao-abertura', rotulo: 'Abertura de Chamado', tipo: 'sub', pai: 'manutencao-corretiva', area: 'manutencao-chamado' },
  { id: 'manutencao-detalhes-problema', rotulo: 'Detalhes do Problema', tipo: 'sub', pai: 'manutencao-corretiva', area: 'manutencao-chamado' },
  { id: 'manutencao-execucao', rotulo: 'Execução da Manutenção', tipo: 'sub', pai: 'manutencao-corretiva', area: 'manutencao' },
  { id: 'manutencao-acompanhamento-supervisao', rotulo: 'Acompanhamento da Supervisão', tipo: 'sub', pai: 'manutencao-corretiva', area: 'manutencao' },
  { id: 'manutencao-programada', rotulo: 'Programada', tipo: 'sub', pai: 'manutencao', area: 'manutencao' },
  { id: 'manutencao-visao-executiva', rotulo: 'Visão Executiva', tipo: 'sub', pai: 'manutencao' },

  { id: 'tv', rotulo: 'Modo TV', tipo: 'pagina' },

  // ── Dashboards ───────────────────────────────────────────────────────
  { id: 'analise-operacional', rotulo: 'Análise Operacional', tipo: 'dashboard' },
  { id: 'qualidade-tracos', rotulo: 'CEP', tipo: 'dashboard' },
  { id: 'analise-focada', rotulo: 'Análise Focada / Rastreabilidade', tipo: 'dashboard' },
  { id: 'analise-bercos', rotulo: 'Análise de Berços', tipo: 'dashboard' },
  { id: 'oee', rotulo: 'OEE', tipo: 'dashboard' },

  // ── Outros ───────────────────────────────────────────────────────────
  { id: 'importar-documentos', rotulo: 'Importar Documentos', tipo: 'acao' },
  { id: 'export-interativo', rotulo: 'Exportações Interativas', tipo: 'acao' },
  { id: 'export-excel', rotulo: 'Exportações de Excel', tipo: 'acao' },
  { id: 'edicao-dados', rotulo: 'Edição dos Dados', tipo: 'acao' },
  { id: 'backup-restauracao', rotulo: 'Backup e Restauração', tipo: 'acao' },

  // ── Configurações ────────────────────────────────────────────────────
  { id: 'config-dados', rotulo: 'Bateria e Montagem', tipo: 'config' },
  { id: 'config-atalhos', rotulo: 'Atalho de Teclados', tipo: 'config' },
  { id: 'config-usuarios', rotulo: 'Usuários', tipo: 'config' },
  { id: 'config-autorizados', rotulo: 'Operação em Andamento', tipo: 'config' },
  // Reintroduzido (ver conversa que motivou a mudança): volta a existir
  // uma trava por DISPOSITIVO, além da trava por PESSOA já existente
  // (perfil/podeIniciarOperacao) — ver dispositivoAutorizado() em
  // server.js e cfgRenderDispositivos() em app-core.js. Sempre restrito
  // ao Administrador (ver ABAS_CONFIG_ADMIN, lib/perfis.js) — nenhum
  // perfil customizado pode liberar esta aba pra si mesmo.
  { id: 'config-dispositivos', rotulo: 'Dispositivos Autorizados', tipo: 'config' },
  { id: 'config-automacao', rotulo: 'Automação', tipo: 'config' },
  { id: 'config-sql', rotulo: 'Dados SQL', tipo: 'config' },
];

const NIVEIS = ['total', 'visualizar', 'ocultar'];

const IDS_VALIDOS = new Set(CATALOGO.map(i => i.id));

// Itens que têm "area" — usados pra fazer a ponte entre o nível granular
// escolhido no catálogo e as 5 áreas de edição já validadas de verdade no
// servidor (ver lib/perfis.js, AREAS_DE_EDICAO).
const ITENS_POR_AREA = {};
for (const item of CATALOGO) {
  if (!item.area) continue;
  (ITENS_POR_AREA[item.area] = ITENS_POR_AREA[item.area] || []).push(item.id);
}

function itemValido(id) {
  return IDS_VALIDOS.has(id);
}

// Valida um mapa {itemId: nivel} contra o catálogo — usado tanto por
// perfis CUSTOMIZADOS (lib/perfis-customizados.js) quanto por
// OVERRIDES de perfis FIXOS (lib/perfis-fixos-overrides.js, ver
// conversa que motivou a mudança — engrenagem ao lado do campo "Perfil"
// em Configurações → Usuários). Itens não mencionados no payload viram
// 'ocultar' por padrão — quem salva decide explicitamente o que
// liberar, em vez de herdar acesso a algo que esqueceu de marcar.
function validarMapaDePermissoes(permissoes) {
  if (!permissoes || typeof permissoes !== 'object' || Array.isArray(permissoes)) {
    throw new Error('Campo "permissoes" precisa ser um objeto {itemId: nivel}.');
  }
  const limpo = {};
  for (const [itemId, nivel] of Object.entries(permissoes)) {
    if (!itemValido(itemId)) {
      throw new Error(`Item de permissão "${itemId}" não existe no catálogo.`);
    }
    if (!NIVEIS.includes(nivel)) {
      throw new Error(`Item "${itemId}": nível "${nivel}" inválido. Precisa ser um de: ${NIVEIS.join(', ')}.`);
    }
    limpo[itemId] = nivel;
  }
  for (const item of CATALOGO) {
    if (!(item.id in limpo)) limpo[item.id] = 'ocultar';
  }
  return limpo;
}

module.exports = { CATALOGO, NIVEIS, ITENS_POR_AREA, itemValido, validarMapaDePermissoes };
