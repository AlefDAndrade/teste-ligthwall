// ─── lib/perfis-customizados.js — Perfis de acesso CRIADOS pelo Administrador ─
// Complementa os 6 perfis fixos de lib/perfis.js: aqui vivem os perfis que
// o Administrador cria na hora (Configurações → Usuários → "+ Criar novo
// tipo de perfil"), cada um com seu próprio mapa granular
// {itemId: 'total'|'visualizar'|'ocultar'} sobre o catálogo inteiro (ver
// lib/itens-permissao.js) — não só as 5 áreas fixas dos perfis embutidos.
//
// Guardados em private/perfis-customizados.json (mesmo motivo de
// usuarios.json/security.json ficarem fora de public/db/: nada aqui é
// segredo tipo senha, mas é dado de configuração administrativa, não
// dado operacional do dia a dia — mantido consistente com o resto).
//
// Perfis embutidos (lib/perfis.js) continuam funcionando exatamente como
// antes — este módulo só ADICIONA perfis novos ao catálogo, nunca
// substitui ou reinterpreta os 6 fixos.

module.exports = function criarPerfisCustomizados({ fs, path, PRIVATE_DIR, perfis, itensPermissao }) {
  const PERFIS_CUSTOMIZADOS_PATH = path.join(PRIVATE_DIR, 'perfis-customizados.json');

  function lerTodos() {
    try {
      const lista = JSON.parse(fs.readFileSync(PERFIS_CUSTOMIZADOS_PATH, 'utf8'));
      return Array.isArray(lista) ? lista : [];
    } catch (_) {
      return [];
    }
  }

  function salvarTodos(lista) {
    fs.writeFileSync(PERFIS_CUSTOMIZADOS_PATH, JSON.stringify(lista, null, 2), 'utf8');
  }

  // Gera um id estável a partir do nome (slug ASCII) — usado como "perfil"
  // no cadastro de usuário, igual aos ids fixos (OperadorInjetora, etc.),
  // só que gerado, não hardcoded. Prefixo "custom_" pra nunca colidir por
  // acidente com um id embutido futuro.
  function gerarId(nome) {
    const slug = nome
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-+|-+$)/g, '');
    return 'custom_' + (slug || 'perfil') + '_' + Date.now();
  }

  function validarPermissoes(permissoes) {
    if (!permissoes || typeof permissoes !== 'object' || Array.isArray(permissoes)) {
      throw new Error('Campo "permissoes" precisa ser um objeto {itemId: nivel}.');
    }
    const limpo = {};
    for (const [itemId, nivel] of Object.entries(permissoes)) {
      if (!itensPermissao.itemValido(itemId)) {
        throw new Error(`Item de permissão "${itemId}" não existe no catálogo.`);
      }
      if (!itensPermissao.NIVEIS.includes(nivel)) {
        throw new Error(`Item "${itemId}": nível "${nivel}" inválido. Precisa ser um de: ${itensPermissao.NIVEIS.join(', ')}.`);
      }
      limpo[itemId] = nivel;
    }
    // Itens não mencionados no payload ficam OCULTOS por padrão — perfil
    // customizado novo é "restritivo por padrão" (diferente dos perfis
    // embutidos, que são "visualização aberta" por definição): quem cria
    // o perfil do zero decide explicitamente o que liberar, em vez de
    // herdar acesso a algo que esqueceu de marcar.
    for (const item of itensPermissao.CATALOGO) {
      if (!(item.id in limpo)) limpo[item.id] = 'ocultar';
    }
    return limpo;
  }

  function listar() {
    return lerTodos();
  }

  function obter(id) {
    return lerTodos().find(p => p.id === id) || null;
  }

  function ehPerfilCustomizado(id) {
    return !!obter(id);
  }

  function criar({ nome, permissoes }) {
    if (typeof nome !== 'string' || !nome.trim()) {
      throw new Error('Nome do perfil é obrigatório.');
    }
    const nomeLimpo = nome.trim();
    const atuais = lerTodos();

    if (perfis.PERFIS_CADASTRAVEIS.includes(nomeLimpo) || nomeLimpo === 'Administrador') {
      throw new Error(`"${nomeLimpo}" já é um nome de perfil reservado do sistema.`);
    }
    if (atuais.some(p => p.nome.toLowerCase() === nomeLimpo.toLowerCase())) {
      throw new Error(`Já existe um perfil customizado chamado "${nomeLimpo}".`);
    }

    const permissoesValidadas = validarPermissoes(permissoes);
    const novo = { id: gerarId(nomeLimpo), nome: nomeLimpo, permissoes: permissoesValidadas, criadoEm: new Date().toISOString() };
    salvarTodos([...atuais, novo]);
    return novo;
  }

  function editar(id, { nome, permissoes }) {
    const atuais = lerTodos();
    const idx = atuais.findIndex(p => p.id === id);
    if (idx === -1) throw new Error('Perfil customizado não encontrado.');

    const atual = atuais[idx];
    const nomeLimpo = typeof nome === 'string' && nome.trim() ? nome.trim() : atual.nome;

    if (atuais.some((p, i) => i !== idx && p.nome.toLowerCase() === nomeLimpo.toLowerCase())) {
      throw new Error(`Já existe um perfil customizado chamado "${nomeLimpo}".`);
    }

    const permissoesValidadas = permissoes ? validarPermissoes(permissoes) : atual.permissoes;
    const atualizado = { ...atual, nome: nomeLimpo, permissoes: permissoesValidadas };
    atuais[idx] = atualizado;
    salvarTodos(atuais);
    return atualizado;
  }

  // exclusao bloqueada se algum usuário cadastrado ainda usa esse perfil —
  // `usuariosDoPerfil(id)` é injetada como função (não como dado fixo) pra
  // sempre ler o cadastro mais atual na hora da exclusão, não um snapshot.
  function excluir(id, usuariosDoPerfilFn) {
    const atuais = lerTodos();
    if (!atuais.some(p => p.id === id)) throw new Error('Perfil customizado não encontrado.');
    const emUso = usuariosDoPerfilFn ? usuariosDoPerfilFn(id) : 0;
    if (emUso > 0) {
      throw new Error(`Não é possível excluir: ${emUso} usuário(s) cadastrado(s) ainda usa(m) este perfil. Mude o perfil deles primeiro (Configurações → Usuários).`);
    }
    salvarTodos(atuais.filter(p => p.id !== id));
  }

  function nivelDoItem(perfilCustomizado, itemId) {
    return (perfilCustomizado.permissoes && perfilCustomizado.permissoes[itemId]) || 'ocultar';
  }

  // Deriva a lista de páginas/dashboards/config/sub-itens VISÍVEIS (nível
  // != 'ocultar') — mesmo formato de lib/perfis.js PAGINAS_POR_PERFIL, pra
  // reaproveitar toda a infraestrutura de front já existente
  // (_paginaPermitida, _aplicarVisibilidadeDoMenu, abas de Configurações).
  function paginasPermitidas(perfilCustomizado) {
    return itensPermissao.CATALOGO
      .filter(item => nivelDoItem(perfilCustomizado, item.id) !== 'ocultar')
      .map(item => item.id);
  }

  // Deriva as áreas de edição CONCEDIDAS (ver lib/perfis.js,
  // AREAS_DE_EDICAO) — concede a área se QUALQUER item ligado a ela (ver
  // itensPermissao.ITENS_POR_AREA) estiver marcado "total". É a ponte que
  // faz a permissão granular do perfil customizado valer de verdade nas
  // rotas de escrita já existentes (podeEditarArea, server.js).
  function areasDeEdicao(perfilCustomizado) {
    const areas = [];
    for (const [area, itensDaArea] of Object.entries(itensPermissao.ITENS_POR_AREA)) {
      if (itensDaArea.some(itemId => nivelDoItem(perfilCustomizado, itemId) === 'total')) {
        areas.push(area);
      }
    }
    return areas;
  }

  function podeEditar(perfilCustomizado, area) {
    return areasDeEdicao(perfilCustomizado).includes(area);
  }

  return {
    PERFIS_CUSTOMIZADOS_PATH,
    listar,
    obter,
    ehPerfilCustomizado,
    criar,
    editar,
    excluir,
    nivelDoItem,
    paginasPermitidas,
    areasDeEdicao,
    podeEditar,
  };
};
