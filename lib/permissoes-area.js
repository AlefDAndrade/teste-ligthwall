// ─── lib/permissoes-area.js — Permissões de Área / Manutenção ─────────────
// Fase 16 do fatiamento de server.js (ver README, "Fatiamento de server.js"
// → "Plano de continuidade") — usado por lib/rotas/paradas.js e
// lib/rotas/manutencao.js (Manutenção é a área com mais commits recentes do
// projeto — chamados, filtros, top bar), além do próprio server.js
// (dispositivo-autorizado.js recebe podeEditarArea injetado) e de VÁRIAS
// outras factories de lib/rotas/ que recebem `sessaoOuAdmin` no lugar de
// `sessao` (usuarios.js, perfis-customizados.js, qualidade.js, sql-admin.js,
// sobra.js, operacao-andamento.js, dispositivos-autorizados.js,
// importacao.js, edicao.js, backup.js).

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
  function podeExcluirChamado(req, chamado) {
    if (temPoderesDeAdmin(req)) return true;
    const dados = sessaoUsuario.dadosDaSessao(req);
    if (!dados || !dados.nomeUsuario) return false;
    return (chamado.observador || '').trim().toLowerCase() === dados.nomeUsuario.trim().toLowerCase();
  }

  // ── Fluxo de aceite de chamado / pedido de peça ──────────────────────────
  // Nome de quem está fazendo a requisição, pra gravar como autoria do
  // aceite (aceito_por / pedido_peca_aceito_por, ver db.js) — 'ADM' pro
  // Administrador Master, mesmo valor fixo usado em
  // LW.nomeDeQuemEstaLogado() (data.js) no front.
  function nomeDeQuemAceita(req) {
    const dados = sessaoUsuario.dadosDaSessao(req);
    if (dados && dados.nomeUsuario) return dados.nomeUsuario;
    if (sessao.requestTemSessaoValida(req)) return 'ADM';
    return null;
  }

  // Nome pra registrar quem VISUALIZOU um chamado (ver
  // marcarVisualizadoManutencaoCorretiva, db.js — vira um ponto na
  // trajetória visual) — igual a nomeDeQuemAceita(), acima, EXCETO que
  // quando quem visualizou tem poderes de Admin (master OU perfil
  // Administrativo), grava só "Administrador" genérico em vez do nome de
  // cadastro — pedido do usuário: não expor QUAL administrador
  // especificamente visualizou, só que foi um admin.
  function nomeParaVisualizacao(req) {
    if (temPoderesDeAdmin(req)) return 'Administrador';
    return nomeDeQuemAceita(req);
  }

  // Confere se quem está fazendo a requisição pode editar a ABERTURA/
  // DETALHES de UM chamado já existente (Seções 1 e 2 do formulário) —
  // pedido do usuário: só quem abriu (mesma comparação por nome de
  // podeExcluirChamado, acima) OU Administrador (master/Administrativo)
  // OU Supervisão OU Encarregado. Diferente de podeEditarArea('manutencao'),
  // que é só "o perfil tem a área liberada" — isso aqui é "pode editar
  // ESTE registro específico", igual ao raciocínio de podeExcluirChamado.
  function podeEditarAberturaChamado(req, chamado) {
    if (temPoderesDeAdmin(req)) return true;
    const dados = sessaoUsuario.dadosDaSessao(req);
    if (!dados) return false;
    if (dados.perfil === 'Supervisao' || dados.perfil === 'Encarregado') return true;
    if (!dados.nomeUsuario) return false;
    return (chamado.observador || '').trim().toLowerCase() === dados.nomeUsuario.trim().toLowerCase();
  }

  // Confere se quem está fazendo a requisição pode ACEITAR um chamado
  // (libera a Seção 3 — Execução) — qualquer um dos 4: Manutenção,
  // Administrador, Supervisão ou Encarregado (pedido do usuário: basta 1
  // aceitar). Some ao aceite, não à edição da abertura — por isso é uma
  // checagem separada de podeEditarAberturaChamado, acima (perfil
  // Manutenção NÃO edita abertura/detalhes, mas PODE aceitar o chamado).
  function podeAceitarChamado(req) {
    if (temPoderesDeAdmin(req)) return true;
    const dados = sessaoUsuario.dadosDaSessao(req);
    if (!dados) return false;
    return dados.perfil === 'Manutencao' || dados.perfil === 'Supervisao' || dados.perfil === 'Encarregado';
  }

  // Confere se quem está fazendo a requisição pode ACEITAR um PEDIDO DE
  // PEÇA (libera a Seção 4 — Acompanhamento da Supervisão) — só Supervisão,
  // Encarregado ou Administrador (pedido do usuário: "vai ser mandado para
  // os perfis de supervisor encarregado e adm"); perfil Manutenção NÃO
  // pode aceitar pedido de peça, só abrir o pedido (marcar "Aguardando
  // peças? = Sim" na Execução).
  function podeAceitarPedidoPeca(req) {
    if (temPoderesDeAdmin(req)) return true;
    const dados = sessaoUsuario.dadosDaSessao(req);
    if (!dados) return false;
    return dados.perfil === 'Supervisao' || dados.perfil === 'Encarregado';
  }

  // Confere se quem está fazendo a requisição pode RENOTIFICAR (reenviar a
  // notificação push de um aceite que está pendente — chamado aberto
  // aguardando aceite da Manutenção, ou pedido de peça aguardando aceite da
  // Supervisão) — pedido do usuário: só Encarregado, Administrativo, Admin
  // Master ou Supervisão (mesmo grupo de podeAceitarPedidoPeca, mas checagem
  // própria/nomeada por intenção: quem RENOTIFICA não precisa ser o mesmo
  // grupo de quem ACEITA — coincide hoje, mas são conceitos diferentes,
  // assim como podeAceitarChamado/podeAceitarPedidoPeca já são checagens
  // separadas mesmo quando os grupos se sobrepõem). Perfil Manutenção
  // propositalmente FICA DE FORA: quem cobra o aceite não é quem executa.
  function podeRenotificarManutencao(req) {
    if (temPoderesDeAdmin(req)) return true;
    const dados = sessaoUsuario.dadosDaSessao(req);
    if (!dados) return false;
    return dados.perfil === 'Supervisao' || dados.perfil === 'Encarregado';
  }

  // Confere se quem está fazendo a requisição pode CONFIRMAR RECEBIMENTO de
  // uma peça (ver conversa que motivou isso: 3º portão do fluxo de peça —
  // depois de "Status da Compra = Peça recebida", a Manutenção precisa
  // confirmar que recebeu a peça de verdade nas mãos, ANTES de o
  // formulário de Execução reabrir). Mesmo grupo de podeAceitarChamado
  // (Manutenção/Supervisão/Encarregado/Admin) — quem confirma é o mesmo
  // público que executa a manutenção, não um portão à parte com regras
  // próprias de quem pode agir.
  function podeConfirmarRecebimentoPeca(req) {
    if (temPoderesDeAdmin(req)) return true;
    const dados = sessaoUsuario.dadosDaSessao(req);
    if (!dados) return false;
    return dados.perfil === 'Manutencao' || dados.perfil === 'Supervisao' || dados.perfil === 'Encarregado';
  }

  return {
    podeEditarArea,
    negarEdicao,
    temPoderesDeAdmin,
    sessaoOuAdmin,
    podeExcluirChamado,
    nomeDeQuemAceita,
    nomeParaVisualizacao,
    podeEditarAberturaChamado,
    podeAceitarChamado,
    podeAceitarPedidoPeca,
    podeRenotificarManutencao,
    podeConfirmarRecebimentoPeca,
  };
};
