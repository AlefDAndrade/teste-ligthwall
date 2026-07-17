// ─── lib/perfis-fixos-overrides.js — Overrides de permissão dos perfis FIXOS ─
// Voltou (ver conversa que motivou a mudança): engrenagem ⚙️ ao lado do
// campo "Perfil" em Configurações → Usuários → Adicionar Usuário. Abre a
// MESMA tela de "Acesso Total / Apenas Visualizar / Ocultar" item-a-item
// que já existia pra perfis customizados (ver lib/perfis-customizados.js),
// só que agora também pros 6 perfis FIXOS do sistema (lib/perfis.js) —
// antes só dava pra CRIAR um perfil do zero, não editar um dos embutidos.
//
// Guardado em private/perfis-fixos-overrides.json:
//   { [perfilId]: {itemId: 'total'|'visualizar'|'ocultar', ...} }
// Sem override pra um perfil = comportamento HARDCODED de sempre (ver
// lib/perfis.js, PERFIS) — este arquivo só ADICIONA uma camada opcional
// por cima, nunca é obrigatório existir. Assim que o Administrador salva
// uma alteração pela primeira vez pra um perfil, o mapa completo (ver
// lib/perfis.js, permissoesPadraoDoPerfilFixo — usado como ponto de
// partida) vira a fonte de verdade PRA AQUELE PERFIL a partir daí; os
// outros 5 continuam hardcoded normalmente.
//
// A ponte com a validação de verdade no servidor (podeEditarArea,
// podeControlarOperacao — server.js) e com o que o front mostra
// (paginasPorPerfilMescladas, lib/rotas/usuarios.js) reaproveita a mesma
// lógica item→área/página já existente em perfis-customizados.js
// (areasDeEdicao/paginasPermitidas aceitam qualquer objeto com
// `.permissoes`, não só um perfil customizado "de verdade") — nenhuma
// lógica nova precisou ser duplicada ali.

module.exports = function criarPerfisFixosOverrides({ fs, path, PRIVATE_DIR, itensPermissao }) {
  const OVERRIDES_PATH = path.join(PRIVATE_DIR, 'perfis-fixos-overrides.json');

  function lerTodos() {
    try {
      const mapa = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
      return (mapa && typeof mapa === 'object' && !Array.isArray(mapa)) ? mapa : {};
    } catch (_) {
      return {};
    }
  }

  function salvarTodos(mapa) {
    fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(mapa, null, 2), 'utf8');
  }

  // Devolve o mapa {itemId: nivel} salvo pra este perfil, ou `null` se
  // ele nunca foi customizado (usar o comportamento hardcoded padrão).
  function obter(perfilId) {
    const todos = lerTodos();
    return todos[perfilId] || null;
  }

  function listarPerfisComOverride() {
    return Object.keys(lerTodos());
  }

  // Salva/atualiza o override de um perfil fixo — `permissoes` precisa
  // cobrir o catálogo inteiro (itens ausentes viram 'ocultar', ver
  // itensPermissao.validarMapaDePermissoes). Validação de que `perfilId`
  // é de fato um dos 6 fixos fica por conta de quem chama (ver
  // POST /salvar-permissoes-perfil-fixo, server.js) — este módulo só
  // guarda o mapa, não sabe quais ids são "fixos" (evita depender de
  // lib/perfis.js, que por sua vez depende deste módulo indiretamente
  // via server.js — ver injeção de fonte de overrides, lib/perfis.js).
  function salvar(perfilId, permissoes) {
    const permissoesValidadas = itensPermissao.validarMapaDePermissoes(permissoes);
    const todos = lerTodos();
    todos[perfilId] = permissoesValidadas;
    salvarTodos(todos);
    return permissoesValidadas;
  }

  // Remove o override — o perfil volta a usar o comportamento hardcoded
  // padrão de lib/perfis.js. Botão "Restaurar padrão" na tela de edição.
  function remover(perfilId) {
    const todos = lerTodos();
    if (!(perfilId in todos)) return false;
    delete todos[perfilId];
    salvarTodos(todos);
    return true;
  }

  return { OVERRIDES_PATH, obter, listarPerfisComOverride, salvar, remover };
};
