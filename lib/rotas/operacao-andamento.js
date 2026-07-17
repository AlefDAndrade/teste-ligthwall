// ─── lib/rotas/operacao-andamento.js — Operação em Andamento ───────────────
// Nona fatia extraída de server.js (ver lib/rotas/operadores.js pro padrão
// completo). Rotas cobertas: POST /admin/resetar-operacao,
// POST /salvar-operacao-andamento, GET /bercos-andamento,
// POST /marcar-berco-andamento.
//
// Todas as dependências abaixo são injetadas via ctx porque são
// compartilhadas com código que fica em server.js: `lerOperacaoAndamento`
// também é chamada pelo handler de conexão do WebSocket (manda o snapshot
// assim que alguém conecta); `podeControlarOperacao`/
// `negarControleDeOperacao`/`lerBercosAndamento`/
// `salvarBercosAndamentoNoDisco` são usadas por /registrar-operacao (ainda
// não extraída). `broadcastOperacaoAndamento` fica perto do WebSocket.
//
// `podeControlarOperacao`/`negarControleDeOperacao` checam a sessão de
// USUÁRIO logado (ver lib/sessao-usuario.js, lib/perfis.js) — substituíram
// o antigo sistema de "dispositivo autorizado" (deviceId numa lista em
// config.json). `deviceId` (extraído aqui embaixo) CONTINUA existindo,
// mas agora serve só pra identificar o "dono" da operação em andamento
// (evita dois computadores autorizados brigando pela mesma operação ao
// mesmo tempo) — um conceito totalmente separado de "está autorizado a
// controlar", que é decidido pela sessão de usuário, não mais pelo
// computador.

module.exports = function criarRotasOperacaoAndamento({
  sessao,
  lerOperacaoAndamento,
  salvarOperacaoAndamentoNoDisco,
  broadcastOperacaoAndamento,
  lerBercosAndamento,
  salvarBercosAndamentoNoDisco,
  podeControlarOperacao,
  negarControleDeOperacao,
}) {

  return function tentar(req, res, urlPath, queryParams) {
    const deviceId = queryParams.get('deviceId') || '';

    // ── OPERAÇÃO EM ANDAMENTO: recebe o rascunho atual da tela "Registrar
    // Operação" e propaga na hora pra quem mais estiver com essa mesma tela
    // aberta, via WebSocket (ver broadcastOperacaoAndamento, perto do final
    // do arquivo). "dados" é sempre o objeto inteiro do estado atual, ou
    // null — quando a operação termina, é cancelada/resetada, ou ainda não
    // foi iniciada (ver regra equivalente em persist(), no operacao.js).
    if (req.method === 'POST' && urlPath === '/admin/resetar-operacao') {
      // Rota exclusiva para o Administrador cancelar/resetar a operação em
      // andamento pela tela de Configurações → Operação em Andamento, sem
      // depender de quem está clicando ter permissão pra controlar operações.
      // Diferença em relação a POST /salvar-operacao-andamento com forcar=true:
      // - Aquela rota exige que a sessão de usuário de quem está mandando
      //   tenha permissão pra controlar operações (ver podeControlarOperacao(),
      //   acima), então falha quando quem está logado não tem essa marcação.
      // - Esta rota ignora essa checagem e exige apenas uma SESSÃO
      //   válida do Administrador (lib/sessao.js), criada em /verificar-senha.
      // Produz exatamente o mesmo efeito: null no disco + broadcast para todos
      // os clientes WebSocket conectados, que atualizam a tela em tempo real.
      if (!sessao.requestTemSessaoValida(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Sessão de Administrador necessária. Faça login como Administrador antes de cancelar a operação.' }));
        return true;
      }
      try {
        salvarOperacaoAndamentoNoDisco(null);
        broadcastOperacaoAndamento(null, null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    if (req.method === 'POST' && urlPath === '/salvar-operacao-andamento') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error('Payload inválido.');
          }
          const dados = payload.dados;
          if (dados !== null && dados !== undefined && (typeof dados !== 'object' || Array.isArray(dados))) {
            throw new Error('Payload inválido: "dados" precisa ser um objeto ou null.');
          }
          const clientId = typeof payload.clientId === 'string' ? payload.clientId : null;
          const ehLimpeza = dados === null || dados === undefined;
          // "forcar" só existe pro botão "🗑️ Limpar Tudo" (ver resetarOperacao()
          // em operacao.js) — é o jeito de qualquer pessoa autorizada
          // recuperar uma operação travada por outro computador que travou,
          // ficou offline, ou simplesmente esqueceu de encerrar.
          const forcar = payload.forcar === true && ehLimpeza;

          const atual = lerOperacaoAndamento();

          // Não-operação: já não tinha nada em andamento e o pedido é só pra
          // "limpar" — não muda NADA no servidor. Acontece, por exemplo, ao
          // desativar o Modo de Teste com a tela ociosa: persist() manda
          // null pro servidor mesmo sem nunca ter existido uma operação real
          // pra esse dispositivo controlar (o Modo de Teste nunca chega a
          // avisar o servidor enquanto ligado — ver persist(), operacao.js).
          // Responde OK sem checar autorização nem gravar nada: não tem o
          // que proteger quando nada muda — checar autorização aqui só
          // produziria um "não autorizado" confuso por uma ação que nunca
          // tentou controlar operação real nenhuma.
          if (ehLimpeza && !atual) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          if (!podeControlarOperacao(req)) { negarControleDeOperacao(res); return; }

          // ── Dono da operação ──────────────────────────────────────────────
          // Só existe UMA operação em andamento por vez (ver seção dedicada no
          // README), mas mais de um usuário pode ter permissão pra controlar.
          // Quem inicia (primeiro push não-nulo depois de uma
          // operação vazia) se torna o "dono" — só ele pode mandar mais
          // mudanças, até a operação ser limpa (registrada, resetada, ou
          // "forçada" por outro autorizado). Isso evita dois computadores
          // autorizados brigando pela mesma operação ao mesmo tempo.
          const donoAtual = (atual && typeof atual === 'object') ? (atual.donoDeviceId || null) : null;
          const souODono = !donoAtual || donoAtual === deviceId;

          if (!souODono && !forcar) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              erro: 'Esta operação já está sendo controlada por outra pessoa autorizada. Espere ela terminar, ou use "🗑️ Limpar Tudo" pra assumir o controle.',
            }));
            return;
          }

          // Nunca confia no donoDeviceId que o cliente mandou (se mandou) —
          // sempre recalculado aqui: mantém o dono atual, ou assume este
          // deviceId como novo dono se a operação estava vazia.
          let dadosFinal;
          if (ehLimpeza) {
            dadosFinal = null; // limpa o dono junto
          } else {
            const { donoDeviceId: _ignorarDoCliente, ...resto } = dados;
            dadosFinal = { ...resto, donoDeviceId: donoAtual || deviceId };
          }

          salvarOperacaoAndamentoNoDisco(dadosFinal);
          // broadcastOperacaoAndamento devolve o novo número de revisão —
          // repassado na resposta HTTP porque o autor da mudança nunca vê
          // o próprio eco via WebSocket (filtrado por origemClientId, ver
          // data.js): é só por aqui que ele fica sabendo sua revisão mais
          // recente, pra comparar corretamente com a PRÓXIMA atualização
          // que chegar de outra aba/dispositivo (ver _aplicarEstadoExterno,
          // operacao.js).
          const revisao = broadcastOperacaoAndamento(dadosFinal, clientId);

          // Berços marcados (baixou/vazou) só fazem sentido enquanto ESSA
          // operação existe — ao limpar (fim normal, "🗑️ Limpar Tudo", ou
          // reset), reseta junto pra próxima operação começar sem marcação
          // nenhuma. Quando a limpeza é porque a operação foi REGISTRADA de
          // verdade, o conteúdo já foi transferido pra bercos_visuais antes
          // (ver POST /registrar-operacao, que já reseta por conta própria —
          // resetar de novo aqui é inofensivo, só redundante).
          if (ehLimpeza) salvarBercosAndamentoNoDisco({});

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, revisao }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── GET /bercos-andamento: mapa esparso aninhado por lado —
    // { 'B1': { esquerda: 'baixou' }, 'B7': { direita: 'baixou' } } — dos
    // berços marcados na operação em andamento agora (ver "Bateria Atual",
    // bateria-atual.js). Lado ausente do mapa = 'okay' implicitamente.
    if (req.method === 'GET' && urlPath === '/bercos-andamento') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(lerBercosAndamento()));
      return true;
    }

    // ── POST /marcar-berco-andamento: alterna (toggle) o estado de UM LADO
    // de UM berço da operação em andamento — 'okay' -> 'baixou' -> 'okay'
    // de novo a cada clique naquele indicador específico (● ou •, ver
    // "Bateria Atual", bateria-atual.js). Os 2 lados de um mesmo berço são
    // independentes — marcar um não afeta o outro.
    //
    // payload.estado (opcional, default 'baixou'): qual marcação aplicar
    // quando o lado ainda estiver 'okay' — 'baixou' (vazamento, sempre
    // existiu) ou 'nao_enchido' (💠 botão "Marcar Não Enchido" em Bateria
    // Atual — painel que nunca chegou a ser preenchido, ver
    // _paineisNaoEnchidosDaOperacao, setor-qualidade.js). Sempre que o
    // lado JÁ estiver marcado (com qualquer um dos dois), o clique
    // desmarca (volta a 'okay') independente de qual payload.estado foi
    // mandado — clicar de novo num "x" precisa sempre limpar, mesmo que
    // por algum motivo o modo do botão tenha mudado entre os dois
    // cliques, nunca "trocar" um estado marcado por outro num só clique.
    //
    // Exige permissão de controlar operações + ser o "dono" da operação
    // em andamento
    // (mesma dupla checagem de POST /salvar-operacao-andamento, acima) —
    // antes QUALQUER UM olhando essa tela podia marcar vazamento, de
    // propósito, por ser "só uma observação". Isso mudou: só quem está no
    // controle da operação (o dono) marca os vazamentos dela, mesma trava
    // do resto do formulário de Registrar Operação.
    if (req.method === 'POST' && urlPath === '/marcar-berco-andamento') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const berco = payload && payload.berco;
          const lado = payload && payload.lado;
          const estadoPedido = (payload && payload.estado) || 'baixou';
          if (!berco || typeof berco !== 'string' || !/^B\d+$/.test(berco)) {
            throw new Error('Berço inválido.');
          }
          if (lado !== 'esquerda' && lado !== 'direita') {
            throw new Error('Lado inválido — precisa ser "esquerda" ou "direita".');
          }
          if (estadoPedido !== 'baixou' && estadoPedido !== 'nao_enchido') {
            throw new Error('Estado inválido — precisa ser "baixou" ou "nao_enchido".');
          }

          const atual = lerOperacaoAndamento();
          if (!atual) {
            throw new Error('Nenhuma operação em andamento agora.');
          }

          if (!podeControlarOperacao(req)) { negarControleDeOperacao(res); return; }

          // Mesmo critério de "dono" de POST /salvar-operacao-andamento —
          // ver comentário lá. Sem operação vazia aqui pra "virar dono": a
          // essa altura ela já existe (checado acima), então só quem já é
          // o dono (ou nenhum dono foi definido ainda, caso raro) marca.
          const donoAtual = (typeof atual === 'object') ? (atual.donoDeviceId || null) : null;
          const souODono = !donoAtual || donoAtual === deviceId;
          if (!souODono) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              erro: 'Esta operação está sendo controlada por outra pessoa autorizada — só ela pode marcar os vazamentos.',
            }));
            return;
          }

          const mapa = lerBercosAndamento();
          const doBerco = mapa[berco] || {};
          if (doBerco[lado] === 'baixou' || doBerco[lado] === 'nao_enchido') {
            delete doBerco[lado]; // reversível: clicar de novo volta pra 'okay' (ausência do lado no mapa) — mesmo se o modo do botão mudou entre os cliques, ver comentário acima
          } else {
            doBerco[lado] = estadoPedido;
          }
          if (Object.keys(doBerco).length) mapa[berco] = doBerco;
          else delete mapa[berco]; // nenhum lado marcado -> nem precisa a chave do berço
          salvarBercosAndamentoNoDisco(mapa);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, estado: doBerco[lado] || 'okay' }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    return false;
  };
};
