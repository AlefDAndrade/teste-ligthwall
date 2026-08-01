// ─── lib/fila-avaliacao.js — Fila de Avaliação (Setor de Qualidade): "não avaliadas" ──
// Fase 15 do fatiamento de server.js (ver README, "Fatiamento de server.js"
// → "Plano de continuidade") — compartilhado entre lib/rotas/qualidade.js
// (lerOperacoesNaoAvaliadas, removerDaFilaNaoAvaliadas) e
// lib/rotas/registro-operacao.js / lib/rotas/sql-admin.js
// (adicionarNaFilaNaoAvaliadas), além de lib/rotas/backup.js
// (recalcularFilaNaoAvaliadasApartirDoSql, usado na restauração de backup) —
// dois domínios de rota, então já era ponto de conflito de PR, mas menos
// concorrido que os itens 12–14 (só dois consumidores diretos das rotas,
// não quatro).
//
// Antes, GET /operacoes-nao-avaliadas CALCULAVA a fila toda vez (SELECT ...
// WHERE id NOT IN (SELECT id_operacao FROM operacoes_avaliadas)) — nunca
// existia como lista própria, só como diferença entre duas outras coisas.
// Agora é o CONTRÁRIO: um arquivo próprio (JSON simples — cresce a cada
// operação registrada, encolhe a cada avaliação, e nunca chega perto do
// tamanho de "operacoes"/"operacoes_avaliadas", que só crescem) é a fonte
// de verdade — guarda só os IDs pendentes, na ordem em que entraram. GET
// /operacoes-nao-avaliadas lê esta lista e busca os detalhes de cada
// operação no SQL só pra exibir (não pra decidir QUEM está na fila).
//
// Mantido em sincronia em 2 pontos (nunca em mais nenhum outro lugar):
//   - adicionarNaFilaNaoAvaliadas(id) — POST /registrar-operacao, depois do
//     INSERT em "operacoes" (nunca em Modo de Teste — mesma regra de
//     sempre, essas operações nunca entram na fila do Setor de Qualidade).
//   - removerDaFilaNaoAvaliadas(id) — sempre que uma operação é marcada
//     avaliada (POST /marcar-operacao-avaliada, e dentro de
//     db.marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada, pro caso de
//     avaliação avulsa).
//
// migrarFilaNaoAvaliadasSeNecessario() continua sendo CHAMADA em server.js
// (não aqui dentro) — precisa rodar depois das migrações do db.js (Fases
// 2–5, ver "Banco de Dados (SQLite)" no README), já que recalcula a partir
// das tabelas "operacoes"/"operacoes_avaliadas", que só existem depois
// delas. Aqui só a FUNÇÃO é definida; QUANDO ela roda é decisão do boot,
// que continua em server.js.

module.exports = function criarFilaAvaliacao({ fs, path, DB_DIR, db, logger }) {

  const OPERACOES_NAO_AVALIADAS_PATH = path.join(DB_DIR, 'operacoes_nao_avaliadas.json');

  function lerOperacoesNaoAvaliadas() {
    try {
      const texto = fs.readFileSync(OPERACOES_NAO_AVALIADAS_PATH, 'utf8').trim();
      return texto ? JSON.parse(texto) : [];
    } catch (_) {
      return []; // arquivo ainda não existe/corrompido — ver migrarFilaNaoAvaliadasSeNecessario, que cobre a 1ª vez
    }
  }

  function salvarOperacoesNaoAvaliadasNoDisco(lista) {
    const tmp = OPERACOES_NAO_AVALIADAS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(lista, null, 2), 'utf8');
    fs.renameSync(tmp, OPERACOES_NAO_AVALIADAS_PATH);
  }

  function adicionarNaFilaNaoAvaliadas(idOperacao) {
    const lista = lerOperacoesNaoAvaliadas();
    if (!lista.includes(idOperacao)) {
      lista.push(idOperacao);
      salvarOperacoesNaoAvaliadasNoDisco(lista);
    }
  }

  function removerDaFilaNaoAvaliadas(idOperacao) {
    const lista = lerOperacoesNaoAvaliadas();
    const idx = lista.indexOf(idOperacao);
    if (idx !== -1) {
      lista.splice(idx, 1);
      salvarOperacoesNaoAvaliadasNoDisco(lista);
    }
  }

  // Recalcula a fila do ZERO a partir do SQL (mesmo critério de sempre: toda
  // operação real, fora de Modo de Teste, que ainda não tem linha em
  // "operacoes_avaliadas") — usada só em 2 situações, nunca no dia a dia:
  //   1) 1ª vez que o servidor sobe com este arquivo ainda inexistente (ver
  //      migrarFilaNaoAvaliadasSeNecessario, chamada no boot pelo
  //      server.js) — instalação já em uso antes desta mudança existir.
  //   2) Depois de restaurar um backup que trouxe historico.json e/ou
  //      operacoes_avaliadas.json mas NÃO trouxe operacoes_nao_avaliadas.json
  //      (backup mais antigo, de antes deste arquivo existir) — sem isso, o
  //      arquivo antigo (se já existisse aqui) ficaria fora de sincronia com
  //      as tabelas SQL recém-substituídas (ver POST /restaurar-backup-dados,
  //      lib/rotas/backup.js).
  function recalcularFilaNaoAvaliadasApartirDoSql() {
    const rows = db.prepare(`
      SELECT id FROM operacoes
      WHERE modo_teste = 0
        AND id NOT IN (SELECT id_operacao FROM operacoes_avaliadas)
      ORDER BY data ASC, fim ASC
    `).all();
    salvarOperacoesNaoAvaliadasNoDisco(rows.map(r => r.id));
    return rows.length;
  }

  function migrarFilaNaoAvaliadasSeNecessario() {
    if (fs.existsSync(OPERACOES_NAO_AVALIADAS_PATH)) return; // já existe — não é a 1ª vez, nada a fazer
    try {
      const qtd = recalcularFilaNaoAvaliadasApartirDoSql();
      logger.info('migracao', `operacoes_nao_avaliadas.json criado com ${qtd} operação(ões) pendente(s) (calculado a partir do estado atual do banco)`);
    } catch (e) {
      logger.error('migracao', 'Falha ao criar operacoes_nao_avaliadas.json — seguindo com fila vazia', { erro: e.message });
      try { salvarOperacoesNaoAvaliadasNoDisco([]); } catch (_) { /* pior caso: arquivo continua ausente, lerOperacoesNaoAvaliadas() já trata isso como fila vazia */ }
    }
  }

  return {
    lerOperacoesNaoAvaliadas,
    salvarOperacoesNaoAvaliadasNoDisco,
    adicionarNaFilaNaoAvaliadas,
    removerDaFilaNaoAvaliadas,
    recalcularFilaNaoAvaliadasApartirDoSql,
    migrarFilaNaoAvaliadasSeNecessario,
  };
};
