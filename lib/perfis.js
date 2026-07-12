// ─── lib/perfis.js — Perfis de acesso e permissões de página ───────────────
// Fonte ÚNICA de verdade sobre "o que cada perfil pode acessar" — usada
// tanto aqui no backend (pra validar de verdade, não só confiar no front)
// quanto exposta ao front via GET /perfis (app-core.js usa isso pra montar
// o menu lateral e travar Configurações). Qualquer mudança em quem pode
// ver o quê muda AQUI, num lugar só, nunca espalhada em checagens soltas.
//
// 6 perfis no total, mas só 5 são CADASTRÁVEIS (ver criarUsuario,
// lib/rotas/usuarios.js) — "AdminMaster" continua sendo a senha única
// mestra de sempre (botão "Administrador" na tela de login), nunca um
// usuário com nome+senha própria. Os outros 5 (Operador, Analista,
// Qualidade, Manutencao, Administrativo) são perfis que o Administrador
// Master atribui ao cadastrar um usuário novo (ver POST /salvar-usuarios).

// Cada chave é um "id de página" — mesmo valor usado em data-page="..."
// (nav-sidebar.html) e id="page-..." (showPage, app-core.js). "config-*"
// não são páginas de verdade (não tem showPage nenhum com esses nomes) —
// são as ABAS de dentro do modal de Configurações (ver cfgMostrarSecao,
// modal-config.html), listadas aqui pelo mesmo motivo: quem pode ver qual
// aba também precisa estar centralizado.
const PAGINAS_POR_PERFIL = {
  Operador: [
    'operacao', 'registro', 'relatorio', 'relatorio-bercos',
    'analise-focada', 'analise-bercos', 'analise-operacional',
    'turnos', 'manutencao',
    'config-atalhos',
  ],
  Analista: [
    'registro', 'relatorio', 'relatorio-bercos',
    'analise-focada', 'analise-bercos', 'analise-operacional',
    'turnos',
    'config-atalhos',
  ],
  Qualidade: [
    'setor-qualidade',
    'config-atalhos',
  ],
  Manutencao: [
    'manutencao',
    'config-atalhos',
  ],
  // Administrativo: "quase tudo" (ver conversa que definiu isso) — todas
  // as páginas de trabalho + a maior parte de Configurações, MENOS Dados
  // SQL e Backup/Restauração, exclusivos do AdminMaster.
  Administrativo: [
    'operacao', 'registro', 'relatorio', 'relatorio-bercos',
    'analise-focada', 'analise-bercos', 'analise-operacional',
    'turnos', 'manutencao', 'setor-qualidade',
    'oee', 'metas', 'paradas',
    'config-atalhos', 'config-dados', 'config-operadores', 'config-automacao',
  ],
  // AdminMaster: acesso total, sem exceção — nunca listado explicitamente
  // aqui porque paginaPermitida() (abaixo) trata esse perfil à parte
  // (sempre `true`, sem nem olhar a lista). Mantido como comentário, não
  // como entrada real do objeto, pra não sugerir que dá pra "esquecer" um
  // item da lista nele — é por definição irrestrito.
};

// Perfis que o Administrador Master pode atribuir a um usuário cadastrado
// (ver POST /salvar-usuarios). "AdminMaster" de propósito FORA desta
// lista — não é atribuível a ninguém, é sempre a senha mestra da tela de
// login, nunca um campo de cadastro.
const PERFIS_CADASTRAVEIS = ['Operador', 'Analista', 'Qualidade', 'Manutencao', 'Administrativo'];

// Perfis que podem, em tese, ganhar a permissão "pode iniciar operação"
// (ver campo podeIniciarOperacao no cadastro, lib/rotas/usuarios.js) — só
// faz sentido pra quem tem a página "operacao" liberada; os outros nem
// chegam perto do formulário de Registrar Operação, então a permissão
// não significaria nada pra eles.
const PERFIS_COM_PAGINA_OPERACAO = PERFIS_CADASTRAVEIS.filter(p => PAGINAS_POR_PERFIL[p].includes('operacao'));

// Confere se `perfil` pode acessar `pagina` — usado tanto pra montar a
// resposta de GET /perfis quanto (mais importante) pra VALIDAR DE
// VERDADE no servidor antes de responder rotas sensíveis (ver
// lib/sessao-usuario.js, usado pelas rotas que hoje checavam
// dispositivoAutorizado).
function paginaPermitida(perfil, pagina) {
  if (perfil === 'AdminMaster') return true; // irrestrito, sempre
  const lista = PAGINAS_POR_PERFIL[perfil];
  return Array.isArray(lista) && lista.includes(pagina);
}

module.exports = {
  PAGINAS_POR_PERFIL,
  PERFIS_CADASTRAVEIS,
  PERFIS_COM_PAGINA_OPERACAO,
  paginaPermitida,
};
