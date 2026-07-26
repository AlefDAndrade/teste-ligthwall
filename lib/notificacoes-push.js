// ─── lib/notificacoes-push.js — Notificações Push (PC e celular) ──────────
// Sistema de notificação pedido pelo usuário: "toda vez que um chamado for
// aberto, quem tem perfil de manutenção vai ser notificado" — refinado
// depois pra usar a MESMA infraestrutura de permissão item-a-item que já
// existe (ver lib/itens-permissao.js, ITEM_NOTIFICACAO_ABERTURA_CHAMADO):
// em vez de hardcoded "perfil Manutenção", cada perfil (fixo ou
// customizado) tem uma permissão própria "Notificar Abertura de Chamado"
// (Acesso Total = recebe / Ocultar = não recebe), configurável na mesma
// tela de permissões de sempre (Configurações → Usuários → engrenagem ao
// lado do perfil, ou "+ Criar novo tipo de perfil").
//
// Usa Web Push (protocolo padrão do navegador, via VAPID) — funciona tanto
// em desktop (Chrome/Edge/Firefox) quanto em celular (Android: qualquer
// navegador; iOS: Safari 16.4+, mas só com o app ADICIONADO À TELA DE
// INÍCIO como PWA — o manifest.json/service-worker.js já existentes no
// projeto são exatamente o que habilita isso). Não depende de nenhum
// serviço de terceiro (Firebase, etc.) — o próprio navegador entrega a
// notificação através do endpoint push que ele mesmo escolhe.
//
// Chaves VAPID (identifica ESTE servidor pros serviços de push dos
// navegadores) são geradas na 1ª subida e guardadas em
// private/vapid-keys.json — fora do git (ver .gitignore, mesmo motivo de
// security.json/usuarios.json: dado de instalação, não código.

const webpush = require('web-push');

module.exports = function criarNotificacoesPush({
  fs, path, PRIVATE_DIR, db, perfis, perfisCustomizados, perfisFixosOverrides, itensPermissao,
}) {
  const VAPID_PATH = path.join(PRIVATE_DIR, 'vapid-keys.json');
  const USUARIOS_PATH = path.join(PRIVATE_DIR, 'usuarios.json');

  // Gera o par de chaves na 1ª vez que o servidor sobe depois desta
  // mudança, e reaproveita para sempre depois disso — trocar a chave
  // pública invalidaria TODAS as inscrições já feitas pelos navegadores
  // (cada pessoa precisaria ativar de novo), então nunca gerar de novo
  // se já existir.
  function _lerOuCriarChavesVapid() {
    try {
      const salvo = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
      if (salvo && salvo.publicKey && salvo.privateKey) return salvo;
    } catch (_) { /* ainda não existe — gera abaixo */ }
    const par = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_PATH, JSON.stringify(par, null, 2), 'utf8');
    return par;
  }

  const _chaves = _lerOuCriarChavesVapid();
  webpush.setVapidDetails('mailto:suporte@lightwall.local', _chaves.publicKey, _chaves.privateKey);

  function chavePublica() {
    return _chaves.publicKey;
  }

  // Mesmo cadastro usado por lib/rotas/usuarios.js — leitura direta e
  // independente (só leitura, nunca escreve este arquivo), mesmo padrão
  // de lib/perfis-customizados.js/lib/perfis-fixos-overrides.js lendo
  // cada um o seu próprio JSON em private/.
  function _lerUsuarios() {
    try {
      const lista = JSON.parse(fs.readFileSync(USUARIOS_PATH, 'utf8'));
      return Array.isArray(lista) ? lista : [];
    } catch (_) {
      return [];
    }
  }

  // Resolve o nível ('total'/'visualizar'/'ocultar') de UM item de
  // notificação (recebe o id — reaproveitado tanto pro item "Notificar
  // Abertura de Chamado" quanto pro item "Notificar Pedido de Peça",
  // abaixo) pra um perfil — MESMA cascata de resolução de podeEditarArea
  // (server.js): override salvo do perfil fixo, senão o padrão
  // hardcoded (ver permissoesPadraoDoPerfilFixo, lib/perfis.js), senão
  // perfil CUSTOMIZADO.
  function _nivelDoItemDeNotificacao(perfilId, itemId) {
    if (perfis.PERFIS_CADASTRAVEIS.includes(perfilId)) {
      const override = perfisFixosOverrides.obter(perfilId);
      if (override) return perfisCustomizados.nivelDoItem({ permissoes: override }, itemId);
      const padrao = perfis.permissoesPadraoDoPerfilFixo(perfilId);
      return padrao ? padrao[itemId] : 'ocultar';
    }
    const customizado = perfisCustomizados.obter(perfilId);
    return customizado ? perfisCustomizados.nivelDoItem(customizado, itemId) : 'ocultar';
  }

  // 'total' = recebe; 'visualizar'/'ocultar'/perfil desconhecido = não
  // recebe (não existe meio-termo pra notificação, diferente de
  // páginas — ver comentário no catálogo, lib/itens-permissao.js).
  function perfilRecebeNotificacaoAberturaChamado(perfilId) {
    return _nivelDoItemDeNotificacao(perfilId, itensPermissao.ITEM_NOTIFICACAO_ABERTURA_CHAMADO) === 'total';
  }

  // Mesma ideia, pro item "Notificar Pedido de Peça" (ver catálogo,
  // lib/itens-permissao.js, e notificarPedidoPeca, abaixo).
  function perfilRecebeNotificacaoPedidoPeca(perfilId) {
    return _nivelDoItemDeNotificacao(perfilId, itensPermissao.ITEM_NOTIFICACAO_PEDIDO_PECA) === 'total';
  }

  // Mesma ideia, pro item "Notificar Peça Recebida" (ver catálogo,
  // lib/itens-permissao.js, e notificarPecaRecebida, abaixo).
  function perfilRecebeNotificacaoPecaRecebida(perfilId) {
    return _nivelDoItemDeNotificacao(perfilId, itensPermissao.ITEM_NOTIFICACAO_PECA_RECEBIDA) === 'total';
  }

  // Nomes de cadastro (nomeUsuario) de todo mundo cujo PERFIL ATUAL tem
  // a permissão marcada — recalculado a cada chamado aberto (nunca
  // guardado em cache), então uma mudança de permissão feita agora já
  // vale pro próximo chamado, sem precisar reiniciar nada.
  function usuariosParaNotificarAberturaChamado() {
    return _lerUsuarios()
      .filter(u => perfilRecebeNotificacaoAberturaChamado(u.perfil))
      .map(u => u.nomeUsuario);
  }

  // Mesma ideia, pro item "Notificar Pedido de Peça" — recalculado a
  // cada pedido aberto, mesmo motivo do comentário acima.
  function usuariosParaNotificarPedidoPeca() {
    return _lerUsuarios()
      .filter(u => perfilRecebeNotificacaoPedidoPeca(u.perfil))
      .map(u => u.nomeUsuario);
  }

  // Mesma ideia, pro item "Notificar Peça Recebida" — recalculado a cada
  // chamado salvo com statusCompra = 'Peça recebida', mesmo motivo do
  // comentário acima.
  function usuariosParaNotificarPecaRecebida() {
    return _lerUsuarios()
      .filter(u => perfilRecebeNotificacaoPecaRecebida(u.perfil))
      .map(u => u.nomeUsuario);
  }

  async function _enviarParaSubscription(sub, payload) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
    } catch (err) {
      // 404/410 = o próprio serviço de push do navegador confirma que a
      // inscrição morreu (app desinstalado, permissão revogada no SO,
      // etc.) — remove daqui pra nunca mais tentar; qualquer outro erro
      // (rede instável, etc.) só avisa no console, não derruba o envio
      // pros demais.
      const status = err && (err.statusCode || err.status);
      if (status === 404 || status === 410) {
        db.removerPushSubscriptionMorta(sub.endpoint);
      } else {
        console.warn('[notificacoes-push] Falha ao enviar:', err && err.message);
      }
    }
  }

  // Dispara a notificação de "chamado novo aberto" pra todo mundo com a
  // permissão marcada — EXCETO quem abriu (`nomeAutor`, o logado no
  // momento; ver lib/rotas/manutencao.js). Comparação sem diferenciar
  // maiúsculas/espaços, mesmo padrão usado em outras comparações de nome
  // de usuário no projeto (ver public/js/manutencao-front.js). Fire-and-
  // forget de propósito (ver chamada em lib/rotas/manutencao.js: roda
  // DEPOIS de já ter respondido OK pro front que abriu o chamado; um
  // serviço de push lento/fora do ar não pode atrasar nem falhar a
  // abertura do chamado em si).
  // Monta o payload e dispara pra uma lista de nomes de usuário — comum
  // aos dois eventos (abertura de chamado / pedido de peça), só muda o
  // título/resumo/tag. Sempre exclui `nomeAutor` (quem está logado
  // fazendo a ação que disparou o evento) da lista, mesmo raciocínio de
  // sempre: quem causou o evento não precisa ser avisado dele mesmo.
  function _dispararParaUsuarios(usuarios, nomeAutor, { titulo, resumo, tag, chamadoId }) {
    const autorNormalizado = (nomeAutor || '').trim().toLowerCase();
    const destinatarios = usuarios.filter(nome => (nome || '').trim().toLowerCase() !== autorNormalizado);
    if (destinatarios.length === 0) return;
    const subs = db.listarPushSubscriptionsDosUsuarios(destinatarios);
    if (subs.length === 0) return;

    const payload = JSON.stringify({
      titulo,
      corpo: resumo.length > 180 ? resumo.slice(0, 177) + '…' : resumo,
      // "chamado" na query string — o front (app-core.js, boot e listener
      // de 'message' do service worker) lê esse id e abre a Manutenção já
      // direto na tela deste chamado específico, em vez de só cair no
      // Menu (ver MAN.abrirChamado, manutencao.js).
      url: `/index.html?chamado=${encodeURIComponent(chamadoId)}`,
      tag,
    });

    for (const sub of subs) {
      _enviarParaSubscription(sub, payload);
    }
  }

  // Dispara a notificação de "chamado novo aberto" pra todo mundo com a
  // permissão marcada — EXCETO quem abriu (`nomeAutor`, o logado no
  // momento; ver lib/rotas/manutencao.js). Fire-and-forget de propósito
  // (ver chamada em lib/rotas/manutencao.js: roda DEPOIS de já ter
  // respondido OK pro front que abriu o chamado; um serviço de push
  // lento/fora do ar não pode atrasar nem falhar a abertura do chamado
  // em si).
  function notificarAberturaChamado(chamado, nomeAutor) {
    const resumo = `${chamado.setor || 'Setor'} / ${chamado.maquina || 'Máquina'} — ${chamado.anomalia || 'sem descrição'}`;
    _dispararParaUsuarios(usuariosParaNotificarAberturaChamado(), nomeAutor, {
      titulo: 'Novo chamado de manutenção',
      resumo,
      tag: `manutencao-chamado-${chamado.id}`,
      chamadoId: chamado.id,
    });
  }

  // Dispara a notificação de "pedido de peça aberto" — pra todo mundo
  // com a permissão "Notificar Pedido de Peça" marcada (padrão:
  // Supervisão, Encarregado, Administrador — mesmo grupo que pode
  // aceitar o pedido, ver podeAceitarPedidoPeca, server.js), EXCETO
  // quem marcou "Aguardando peças? = Sim" agora (`nomeAutor`). Chamado
  // SÓ quando o chamado já está em execução (situacao='Em Manutencao')
  // E o pedido acabou de nascer (aguardandoPecas passou de != 'Sim' pra
  // 'Sim') — ver lib/rotas/manutencao.js, que faz essa checagem antes
  // de chamar esta função; aqui dispara sem reavaliar a condição, pra
  // manter a mesma separação de responsabilidades de
  // notificarAberturaChamado (rota decide QUANDO, este módulo decide
  // PRA QUEM e O QUÊ). Fire-and-forget, mesmo motivo de cima.
  function notificarPedidoPeca(chamado, nomeAutor) {
    const pecas = chamado.pecasComprar ? ` (${chamado.pecasComprar})` : '';
    const resumo = `${chamado.setor || 'Setor'} / ${chamado.maquina || 'Máquina'} — aguardando peça${pecas}`;
    _dispararParaUsuarios(usuariosParaNotificarPedidoPeca(), nomeAutor, {
      titulo: 'Pedido de peça em chamado de manutenção',
      resumo,
      tag: `manutencao-pedido-peca-${chamado.id}`,
      chamadoId: chamado.id,
    });
  }

  // Dispara a notificação de "peça recebida" — pra todo mundo com a
  // permissão "Notificar Peça Recebida" marcada (padrão: Manutenção,
  // Supervisão, Encarregado ou Administrador — pedido do usuário),
  // EXCETO quem marcou "Status da Compra = Peça recebida" agora
  // (`nomeAutor`). Chamado SÓ na TRANSIÇÃO pra 'Peça recebida' (ver
  // lib/rotas/manutencao.js, que faz essa checagem antes de chamar esta
  // função; aqui dispara sem reavaliar a condição, mesma separação de
  // responsabilidades de notificarPedidoPeca: rota decide QUANDO, este
  // módulo decide PRA QUEM e O QUÊ). Fire-and-forget, mesmo motivo de
  // cima.
  function notificarPecaRecebida(chamado, nomeAutor) {
    const pecas = chamado.pecasComprar ? ` (${chamado.pecasComprar})` : '';
    const resumo = `${chamado.setor || 'Setor'} / ${chamado.maquina || 'Máquina'} — peça recebida${pecas}`;
    _dispararParaUsuarios(usuariosParaNotificarPecaRecebida(), nomeAutor, {
      titulo: 'Peça recebida em chamado de manutenção',
      resumo,
      tag: `manutencao-peca-recebida-${chamado.id}`,
      chamadoId: chamado.id,
    });
  }

  return {
    chavePublica,
    perfilRecebeNotificacaoAberturaChamado,
    usuariosParaNotificarAberturaChamado,
    notificarAberturaChamado,
    perfilRecebeNotificacaoPedidoPeca,
    usuariosParaNotificarPedidoPeca,
    notificarPedidoPeca,
    perfilRecebeNotificacaoPecaRecebida,
    usuariosParaNotificarPecaRecebida,
    notificarPecaRecebida,
  };
};
