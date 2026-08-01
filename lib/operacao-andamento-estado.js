// ─── lib/operacao-andamento-estado.js — Operação em Andamento (estado em disco) ──
// Fase 14 do fatiamento de server.js (ver README, "Fatiamento de server.js"
// → "Plano de continuidade") — mesmos quatro consumidores do item 12
// (lib/rotas/registro-operacao.js, lib/rotas/operacao-andamento.js,
// lib/rotas/contador-tracos.js, e o próprio server.js no snapshot inicial de
// wss.on('connection', ...)): é o estado que eles leem/escrevem. Extraído
// logo depois dos itens 12–13 pra evitar reabrir os mesmos call sites duas
// vezes.
//
// Duas coisas guardadas aqui, cada uma no seu próprio arquivo — só isso, sem
// lógica de negócio nenhuma (quem decide QUANDO ler/gravar continua em
// lib/rotas/operacao-andamento.js e lib/rotas/registro-operacao.js):
//
//   1) Operação em andamento (operacao_andamento.json) — só existe UMA
//      operação em andamento por vez, pra fábrica inteira, então o arquivo
//      guarda sempre um único objeto (ou null, sem nenhuma operação
//      rodando agora). A tela "Registrar Operação" manda pra cá a cada
//      mudança (ver POST /salvar-operacao-andamento) e o servidor propaga
//      na hora pra qualquer outra aba/computador com essa mesma tela aberta
//      (ver wss.on('connection', ...) e broadcastOperacaoAndamento, em
//      lib/websocket-broadcast.js) — é assim que outras pessoas acompanham
//      a operação ao vivo.
//
//   2) Berços da operação em andamento (bercos_andamento.json) — "baixou/
//      vazou" marcado ao vivo. Snapshot SEPARADO do arquivo acima de
//      propósito: aquele é sobrescrito por INTEIRO a cada mudança que a
//      tela Registrar Operação manda — se os estados de berço vivessem
//      dentro dele, o próximo campo que o operador editasse sobrescreveria
//      as marcações feitas por quem estiver olhando "Bateria Atual"
//      (potencialmente em outro computador, sem relação com "o dono" da
//      operação). Aqui é um arquivo à parte, só mexido pelas 2 rotas de
//      berço (GET /bercos-andamento, POST /marcar-berco-andamento) —
//      ninguém mais escreve nele.
//
//      Mapa ESPARSO em 2 níveis: { 'B1': { esquerda: 'baixou' } } — só
//      guarda berço/lado que NÃO estão 'okay'; lado ausente (ou berço
//      ausente por inteiro) é 'okay' implicitamente. Os 2 lados de um
//      mesmo berço são independentes — marcar um não mexe no outro.
//      Reversível por natureza (marcar de novo remove a entrada daquele
//      lado — ver POST /marcar-berco-andamento).
//
//      Resetado (vira {} de novo) em 2 pontos: quando a operação em
//      andamento é limpa (POST /salvar-operacao-andamento com dados=null —
//      fim normal, ou "🗑️ Limpar Tudo") e quando a operação é registrada
//      de verdade (POST /registrar-operacao — nesse ponto, o conteúdo já
//      foi transferido pra bercos_visuais antes de resetar, ver essa
//      rota).

module.exports = function criarOperacaoAndamentoEstado({ fs, path, DB_DIR }) {

  const OPERACAO_ANDAMENTO_PATH = path.join(DB_DIR, 'operacao_andamento.json');
  const BERCOS_ANDAMENTO_PATH = path.join(DB_DIR, 'bercos_andamento.json');

  function lerOperacaoAndamento() {
    try {
      const texto = fs.readFileSync(OPERACAO_ANDAMENTO_PATH, 'utf8').trim();
      return texto ? JSON.parse(texto) : null;
    } catch (_) {
      return null; // arquivo ainda não existe / corrompido — trata como "nenhuma operação"
    }
  }

  function salvarOperacaoAndamentoNoDisco(dados) {
    const tmp = OPERACAO_ANDAMENTO_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(dados, null, 2), 'utf8');
    fs.renameSync(tmp, OPERACAO_ANDAMENTO_PATH);
  }

  function lerBercosAndamento() {
    try {
      const texto = fs.readFileSync(BERCOS_ANDAMENTO_PATH, 'utf8').trim();
      const obj = texto ? JSON.parse(texto) : {};
      return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    } catch (_) {
      return {}; // arquivo ainda não existe / corrompido — trata como "nenhum berço marcado"
    }
  }

  function salvarBercosAndamentoNoDisco(mapa) {
    const tmp = BERCOS_ANDAMENTO_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(mapa, null, 2), 'utf8');
    fs.renameSync(tmp, BERCOS_ANDAMENTO_PATH);
  }

  return {
    lerOperacaoAndamento,
    salvarOperacaoAndamentoNoDisco,
    lerBercosAndamento,
    salvarBercosAndamentoNoDisco,
  };
};
