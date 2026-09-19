// ─── lib/itens-permissao.js — Catálogo de itens permissionáveis ────────────
// Lista TODO item que um "Novo Tipo de Perfil" customizado (ver
// Configurações → Usuários → "+ Criar novo tipo de perfil") pode marcar
// como Acesso Total / Apenas Visualizar / Ocultar. Cobre páginas,
// dashboards, abas de Configurações, sub-itens (Setor de Qualidade) e
// ações transversais ("Outros").
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
//   pai ....... id do item pai, se for um sub-item (ex: Setor de
//               Qualidade tem sub-itens).
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
//               enforcement de verdade no servidor fica só nas áreas já
//               existentes (injetora, paradas, qualidade); o resto é
//               validado apenas no front por enquanto.
const CATALOGO = [
  // ── Páginas ──────────────────────────────────────────────────────────
  { id: 'operacao', rotulo: 'Registrar Operação', tipo: 'pagina', area: 'injetora' },
  { id: 'registro', rotulo: 'Relatório de Bateria', tipo: 'pagina', area: 'injetora' },
  { id: 'relatorio', rotulo: 'Relatório de Injeção', tipo: 'pagina', area: 'injetora' },
  { id: 'relatorio-bercos', rotulo: 'Relatório de Berços', tipo: 'pagina' },
  { id: 'metas', rotulo: 'Metas', tipo: 'pagina' },
  { id: 'paradas', rotulo: 'Registro de Paradas', tipo: 'pagina', area: 'paradas' },
  // ─── Páginas que EXISTIAM no app e nos perfis FIXOS (ver
  // PAGINAS_DE_TRABALHO, lib/perfis.js) mas nunca tinham entrado neste
  // catálogo — achado numa auditoria ("existem novas pages e
  // funcionalidades que ainda não estão lá"). Consequência do bug: como
  // paginasPermitidas() (lib/perfis-customizados.js) deriva a lista de
  // páginas SÓ do catálogo, um perfil CUSTOMIZADO nunca conseguia ver
  // estas telas — não apareciam no formulário de criação de perfil, logo
  // não havia como marcá-las, logo ficavam invisíveis pra sempre. Perfis
  // FIXOS nunca foram afetados (a lista deles é hardcoded à parte).
  //
  // Traços Descartados: 'injetora' porque editar/excluir um descarte já
  // registrado exige essa área no servidor (ver
  // lib/rotas/tracos-descartados.js) — mesma área do registro original.
  { id: 'tracos-descartados', rotulo: 'Traços Descartados (Perda)', tipo: 'pagina', area: 'injetora' },
  // One Page Report: sem "area" de propósito — a escrita ali
  // (comentários/Assuntos Gerais) exige sessaoOuAdmin, não uma das 5
  // áreas de edição (ver lib/rotas/one-page-report.js), então a
  // distinção Total/Visualizar aqui é só visual, igual aos dashboards.
  { id: 'one-page-report', rotulo: 'One Page Report', tipo: 'pagina' },

  { id: 'setor-qualidade', rotulo: 'Setor de Qualidade', tipo: 'pagina' },
  { id: 'qualidade-avaliacao', rotulo: 'Avaliação', tipo: 'sub', pai: 'setor-qualidade', area: 'qualidade' },
  { id: 'qualidade-dashboard', rotulo: 'Dashboard', tipo: 'sub', pai: 'setor-qualidade' },
  { id: 'qualidade-registro', rotulo: 'Registros', tipo: 'sub', pai: 'setor-qualidade' },

  // ── Dashboards ───────────────────────────────────────────────────────
  { id: 'analise-operacional', rotulo: 'Análise Operacional', tipo: 'dashboard' },
  { id: 'qualidade-tracos', rotulo: 'CEP', tipo: 'dashboard' },
  // Tela auxiliar do CEP (README, pedido — "consulta detalhada dos
  // traços produzidos no período"): lista de traços + detalhe de
  // insumos por traço + exportação Excel. Item PRÓPRIO (não amarrado a
  // 'qualidade-tracos') — um Administrador pode querer liberar só o CEP
  // agregado sem abrir o detalhe de insumo por traço, ou vice-versa.
  { id: 'consulta-tracos', rotulo: 'Consulta de Traços (Insumos)', tipo: 'dashboard' },
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
  // Paletes (Configurações → Paletes) — mesma omissão de
  // 'tracos-descartados'/'one-page-report' acima: a aba existe no modal
  // (cfg-nav-paletes, modal-config.html), os perfis FIXOS já a conhecem
  // (ABAS_CONFIG_ADMIN, lib/perfis.js) e o front já pergunta por ela
  // (_cfgAplicarVisibilidadeDeAbas checa 'config-paletes',
  // public/js/app-core.js) — só o catálogo não tinha, então a aba ficava
  // permanentemente escondida de qualquer perfil customizado, sem forma
  // nenhuma de liberar.
  { id: 'config-paletes', rotulo: 'Paletes', tipo: 'config' },
  { id: 'config-atalhos', rotulo: 'Atalho de Teclados', tipo: 'config' },
  { id: 'config-usuarios', rotulo: 'Usuários', tipo: 'config' },
  { id: 'config-autorizados', rotulo: 'Operação em Andamento', tipo: 'config' },
  // Motivos de Parada (Configurações → Motivos de Parada) — mesmo
  // raciocínio de config-dados, acima: lista de motivos configurável em
  // vez de fixa no código (ver public/js/paradas.js, MOTIVO_PARADA_OPTS/
  // LW.MOTIVO_PARADA_OPTS, data.js). 'tipo: config' de propósito (não
  // 'pagina'): mesma convenção do resto deste bloco — controla o acesso
  // À ABA de configuração, não à página de Registro de Paradas em si
  // (essa é 'paradas', em PAGINAS_DE_TRABALHO, lib/perfis.js — sempre
  // visível a todo mundo, edição sempre liberada, ver AREAS_DE_EDICAO).
  { id: 'config-paradas', rotulo: 'Motivos de Parada', tipo: 'config' },
  // Insumos de Receitas (Configurações → Insumos de Receitas) — mesmo
  // raciocínio de config-paradas, acima: catálogo configurável em vez
  // de fixo no código (ver LW.INSUMO_RECEITA_OPTS, data.js).
  { id: 'config-insumos', rotulo: 'Insumos de Receitas', tipo: 'config' },
  { id: 'config-automacao', rotulo: 'Automação', tipo: 'config' },
  { id: 'config-sql', rotulo: 'Dados SQL', tipo: 'config' },
  // Registro de Operação Offline (PWA) — itens 6/7 do plano (ver README):
  // aprovar/corrigir/recusar o que foi enviado por
  // POST /operacao-offline/enviar. Sempre visível ao Administrador
  // (ABAS_CONFIG_ADMIN, lib/perfis.js); um perfil CUSTOMIZADO só ganha
  // acesso se o Administrador marcar "Acesso Total" pra este item aqui —
  // útil pra delegar a revisão sem dar Administrador completo (ex.: um
  // Supervisor de confiança que só cuida disso).
  { id: 'config-operacoes-offline', rotulo: 'Operações a Validar (Offline)', tipo: 'config' },
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

module.exports = {
  CATALOGO, NIVEIS, ITENS_POR_AREA, itemValido, validarMapaDePermissoes,
};
