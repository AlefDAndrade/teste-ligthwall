// ─── lib/permissoes-area.js — Permissões de Área ───────────────────────────
// Fase 16 do fatiamento de server.js (ver README, "Fatiamento de server.js"
// → "Plano de continuidade") — usado por lib/rotas/paradas.js (além do
// próprio server.js e de VÁRIAS outras factories de lib/rotas/ que
// recebem `sessaoOuAdmin` no lugar de `sessao`: usuarios.js,
// perfis-customizados.js, qualidade.js, sql-admin.js, sobra.js,
// operacao-andamento.js, dispositivos-autorizados.js, importacao.js,
// edicao.js, backup.js).

module.exports = function criarPermissoesArea({ sessao, sessaoUsuario, perfis, perfisFixosOverrides, perfisCustomizados }) {

  // ─── PERMISSÕES DE EDIÇÃO POR ÁREA (modelo novo, ver lib/perfis.js) ──────
  // Todas as páginas são abertas pra VISUALIZAÇÃO; o que cada perfil pode
  // EDITAR/registrar é validado aqui, rota a rota, por área ('injetora',
  // 'paradas', 'qualidade', 'manutencao', 'manutencao-chamado').
  //
  // A sessão do Administrador Master (lib/sessao.js) edita qualquer área;
  // pros usuários cadastrados, decide o perfil — primeiro se há um OVERRIDE
  // salvo pra ele (ver lib/perfis-fixos-overrides.js — voltou, ver conversa
  // que motivou a mudança), senão os 6 fixos hardcoded (ver perfis.podeEditar),
  // e se não for nenhum deles, tenta um perfil CUSTOMIZADO (ver
  // perfisCustomizados.podeEditar, que faz a ponte entre o nível granular
  // "Acesso Total" escolhido no catálogo e esta mesma área — a MESMA ponte
  // que os overrides de perfil fixo reaproveitam, só passando o override no
  // lugar de um perfil customizado "de verdade").
  function podeEditarArea(req, area) {
    if (sessao.requestTemSessaoValida(req)) return true; // Admin Master
    const dados = sessaoUsuario.dadosDaSessao(req);
    if (!dados) return false;
    if (perfis.PERFIS_CADASTRAVEIS.includes(dados.perfil)) {
      const override = perfisFixosOverrides.obter(dados.perfil);
      if (override) return perfisCustomizados.podeEditar({ permissoes: override }, area);
      return perfis.podeEditar(dados.perfil, area);
    }
    const customizado = perfisCustomizados.obter(dados.perfil);
    return !!customizado && perfisCustomizados.podeEditar(customizado, area);
  }

  function negarEdicao(res, oQue) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      erro: `Seu perfil só pode VISUALIZAR ${oQue} — sem permissão pra registrar, editar ou excluir. Se precisar dessa permissão, fale com um Administrador (ou confira se sua sessão não expirou, fazendo login de novo).`,
    }));
  }

  // Poderes totais de administração: a sessão mestra de sempre (lib/sessao.js)
  // OU um usuário cadastrado com perfil Administrativo ("Administrador" na
  // tela — igual ao master por definição, ver lib/perfis.js). As rotas que
  // antes exigiam só a sessão mestra (backup, SQL, importação, gerenciar
  // usuários, salvar config, resetar operação) agora aceitam as duas — por
  // isso recebem `sessaoOuAdmin` (abaixo) no lugar de `sessao`.
  function temPoderesDeAdmin(req) {
    if (sessao.requestTemSessaoValida(req)) return true;
    const dados = sessaoUsuario.dadosDaSessao(req);
    return !!dados && dados.perfil === 'Administrativo';
  }

  // Mesmo contrato de lib/sessao.js (só o método que essas rotas usam) —
  // permite passar isto no lugar de `sessao` sem mudar nada dentro delas.
  const sessaoOuAdmin = { requestTemSessaoValida: temPoderesDeAdmin };

  // Confere se quem está fazendo a requisição pode excluir ESTE chamado
  // corretivo específico — pedido do usuário: só o Administrador (master
  // OU perfil Administrativo) OU quem abriu o chamado pode excluí-lo,
  // mesmo que o perfil dele tenha edição total de Manutenção (ver
  // podeEditarArea, acima — aquela checagem é só "pode editar a ÁREA",
  // não "pode excluir ESTE registro específico"; as duas rodam juntas na
  // rota de exclusão, ver lib/rotas/manutencao.js). "Quem abriu" é
  // comparado pelo NOME (campo "observador", texto livre desde sempre —
  // não tem outro jeito de saber quem abriu, já que não existia essa
  // trava antes) contra o nome de cadastro da sessão atual
  // (sessaoUsuario.dadosDaSessao) — comparação sem diferenciar
  // maiúsc./minúsc. nem espaços nas pontas, porque "observador" sempre
  // foi digitado à mão, sujeito a variações de digitação.
  // Nome de quem está fazendo a requisição — 'ADM' pro Administrador
  // Master, mesmo valor fixo usado em LW.nomeDeQuemEstaLogado() (data.js)
  // no front. Usada pela inscrição de notificações push (lib/rotas/
  // notificacoes.js) pra saber de quem é cada inscrição.
  function nomeDeQuemAceita(req) {
    const dados = sessaoUsuario.dadosDaSessao(req);
    if (dados && dados.nomeUsuario) return dados.nomeUsuario;
    if (sessao.requestTemSessaoValida(req)) return 'ADM';
    return null;
  }

  // ── Acesso a itens "Outros" fora do sistema de áreas (README, pendências
  // do projeto — "Perfis customizados: só front-end por enquanto"):
  // Importar Documentos e Backup/Restauração são as duas capacidades que
  // ainda exigiam poderes de Admin (temPoderesDeAdmin) mesmo pra um
  // perfil customizado que já marcou o item correspondente como "Acesso
  // Total" no catálogo (lib/itens-permissao.js) — porque essas rotas
  // (lib/rotas/importacao.js, parte de lib/rotas/backup.js) nunca tiveram
  // um portão POR ITEM, só o blanket sessaoOuAdmin/temPoderesDeAdmin que
  // TAMBÉM protege rotas bem mais sensíveis (gerenciar usuários, SQL
  // admin, dispositivos autorizados, salvar config) — por isso não dá
  // pra simplesmente abrir temPoderesDeAdmin pra perfis customizados:
  // quem marcasse só "Importar Documentos: Acesso Total" ganharia sem
  // querer acesso a tudo mais que aquele portão protege.
  //
  // `podeUsarItem`, abaixo, é o portão GRANULAR — Admin (master ou
  // "Administrador" fixo) continua irrestrito, igual sempre foi; um
  // perfil customizado (ou um perfil fixo COM override) só passa se o
  // ITEM específico (ex.: 'importar-documentos') estiver marcado "total"
  // — nunca concede nenhuma outra permissão. Perfis fixos SEM override
  // continuam sem acesso (os 6 perfis fixos nunca tiveram noção destes
  // itens — só "Administrador" tinha, via temPoderesDeAdmin), mesmo
  // comportamento de sempre pra quem não mexeu em nada.
  //
  // Onde NÃO se aplica de propósito: as rotas de RESTAURAR/MESCLAR backup
  // (POST /restaurar-backup-dados, /restaurar-backup-geral,
  // /mesclar-backup-dados, lib/rotas/backup.js) exigem a SENHA do
  // Administrador Master reverificada na hora — uma segunda camada
  // deliberadamente mais forte que sessão/perfil (são operações
  // destrutivas, sobrescrevem dados). `podeUsarItem` cobre só o que já
  // era protegido por sessão/perfil (baixar backups, importar
  // documentos) — nunca substitui nem enfraquece essa senha.
  function podeUsarItem(req, itemId) {
    if (temPoderesDeAdmin(req)) return true;
    const dados = sessaoUsuario.dadosDaSessao(req);
    if (!dados) return false;
    if (perfis.PERFIS_CADASTRAVEIS.includes(dados.perfil)) {
      const override = perfisFixosOverrides.obter(dados.perfil);
      if (!override) return false; // perfil fixo sem override nunca teve estes itens
      return perfisCustomizados.nivelDoItem({ permissoes: override }, itemId) === 'total';
    }
    const customizado = perfisCustomizados.obter(dados.perfil);
    return !!customizado && perfisCustomizados.nivelDoItem(customizado, itemId) === 'total';
  }

  function negarAcesso(res, oQue) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      erro: `Seu perfil não tem permissão pra ${oQue}. Se precisar, fale com um Administrador.`,
    }));
  }

  // ─── QUEM PODE CONTROLAR A OPERAÇÃO (iniciar/encerrar/registrar) ─────────
  // Usada por POST /registrar-operacao, /registrar-relatorio-injecao,
  // /salvar-operacao-andamento, /marcar-berco-andamento,
  // /confirmar-tracos-hoje.
  //
  // Só a trava por PESSOA (perfil) — a trava adicional por DISPOSITIVO
  // (allowlist de computadores em Configurações → Dispositivos Autorizados,
  // cookie HttpOnly de identidade, autocura por IP) foi removida de
  // propósito: abandonada em favor de manter só a lógica de perfis
  // autorizados (ver histórico do git — lib/dispositivo-autorizado.js,
  // lib/dispositivo-cookie.js, lib/rotas/dispositivos-autorizados.js — se
  // precisar resgatar).
  //
  // "Administrador" (senha mestra) e "Administrativo" sempre podem; os
  // demais perfis só se o usuário específico tiver sido marcado com
  // podeIniciarOperacao:true no cadastro (Configurações → Usuários — ver
  // lib/rotas/usuarios.js, lib/perfis.js) E o perfil tiver a área
  // 'injetora' de edição.
  function podeControlarOperacao(req) {
    if (sessao.requestTemSessaoValida(req)) return true; // Admin Master
    const dados = sessaoUsuario.dadosDaSessao(req);
    if (!dados) return false; // sem sessão de usuário válida, sem acesso
    if (perfis.ehPerfilDeAdmin(dados.perfil)) return true; // Administrativo = igual ao master
    return podeEditarArea(req, 'injetora') && !!dados.podeIniciarOperacao;
  }

  function negarControleDeOperacao(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      motivo: 'perfil',
      erro: 'Você não está autorizado a controlar operações. Peça ao Administrador pra habilitar isso no seu cadastro (Configurações → Usuários).',
    }));
  }

  return {
    podeEditarArea,
    negarEdicao,
    temPoderesDeAdmin,
    sessaoOuAdmin,
    podeUsarItem,
    negarAcesso,
    podeControlarOperacao,
    negarControleDeOperacao,
    nomeDeQuemAceita,
  };
};
