// ─── lib/db/one-page-comentarios.js — Comentários do One Page Report ──────
// Fase 3 do plano do One Page Report (ver README, "Nova página: One Page
// Report (planejamento)"). Diferente das Fases 1-2 (seguranca_ocorrencias/
// expedicao_cargas, tabelas SQLite em db.js) — este domínio é "texto livre
// editável manualmente na própria tela", sem CRUD de itens avulsos, sem
// necessidade de histórico por linha: por isso o README já descreve como
// "persistido em JSON simples", mesmo padrão de lib/backup-drive-json.js
// (factory recebendo `fs`/`path`/o diretório-alvo, não a conexão SQLite de
// db.js) em vez do padrão factory(db) de lib/db/seguranca-ocorrencias.js.
//
// Fica em DB_DIR (public/db/), não PRIVATE_DIR — mesmo lugar de metas.json/
// config.json (ver lib/rotas/autenticacao.js, /salvar-metas): conteúdo
// editorial do relatório, não credencial nem dado sensível, então pode ser
// lido como estático (GET /db/one-page-comentarios.json) do mesmo jeito que
// o resto de public/db/. A ESCRITA (POST /salvar-comentarios-one-page-
// report, lib/rotas/one-page-report.js) exige sessão, mesma exigência de
// /salvar-metas/PERMISSÃO DE ESCRITA das Fases 1-2.
//
// Formato do arquivo (chaveado por mês, YYYY-MM — o One Page Report inteiro
// é pensado por mês, ver Fase 2/forecast em lib/db/expedicao.js):
//   {
//     "2026-08": {
//       "seguranca":  { "comentarios": "...", "proximosPassos": "..." },
//       "producao":   { "comentarios": "...", "proximosPassos": "..." },
//       "refugo":     { "comentarios": "...", "proximosPassos": "..." },
//       "expedicao":  { "comentarios": "...", "proximosPassos": "..." },
//       "assuntosGerais": "...",
//       "atualizadoEm": "2026-08-31T12:00:00.000Z"
//     },
//     "2026-07": { ... }
//   }
//
// Cada bloco (Segurança/Produção/Refugo/Expedição) guarda só "comentarios"
// + "proximosPassos" (ver README) — "Assuntos Gerais" é o rodapé, 1 campo
// de texto solto, sem os dois subcampos (não é um "bloco" no sentido dos
// outros 4).
//
// NÃO tem noção de "Dado indisponível" (diferente de diasSemAcidentes/
// agregacaoSemanalExpedicao, Fases 1-2): comentário vazio é um estado
// normal e esperado (ninguém escreveu ainda), não um erro de cálculo — o
// endpoint de agregação (Fase 4) e o frontend (Fase 5) tratam string vazia
// como string vazia, não como aviso.

const BLOCOS_VALIDOS = ['seguranca', 'producao', 'refugo', 'expedicao'];

module.exports = function criarDbOnePageComentarios({ fs, path, DB_DIR }) {

  const CAMINHO_ARQUIVO = path.join(DB_DIR, 'one-page-comentarios.json');

  /**
   * Lê o arquivo inteiro (todos os meses). `{}` se o arquivo ainda não
   * existir (instalação nova) ou vier corrompido — nunca lança, mesmo
   * espírito de `ler()` em lib/backup-drive-json.js: um JSON malformado
   * não deveria derrubar a tela, só mostrar tudo vazio.
   */
  function lerTudo() {
    try {
      const bruto = fs.readFileSync(CAMINHO_ARQUIVO, 'utf8');
      const dados = JSON.parse(bruto);
      return (dados && typeof dados === 'object' && !Array.isArray(dados)) ? dados : {};
    } catch (_) {
      return {};
    }
  }

  function salvarTudo(dados) {
    fs.mkdirSync(DB_DIR, { recursive: true });
    fs.writeFileSync(CAMINHO_ARQUIVO, JSON.stringify(dados, null, 2), 'utf8');
  }

  /**
   * Comentários de 1 mês (YYYY-MM). `null` se esse mês nunca foi salvo
   * ainda — o chamador (lib/rotas/one-page-report.js) decide se devolve
   * `null` puro ou um esqueleto com campos vazios pro frontend preencher.
   */
  function lerComentariosDoMes(mesISO) {
    const tudo = lerTudo();
    return tudo[mesISO] || null;
  }

  /**
   * Grava (substitui por completo) os comentários de 1 mês — mesmo
   * contrato de "sobrescreve o objeto inteiro" de /salvar-config
   * (lib/rotas/autenticacao.js), mas por MÊS, não pro arquivo inteiro:
   * salvar agosto não apaga julho (ver lerTudo/salvarTudo, acima, que
   * sempre leem e regravam o objeto completo).
   *
   * `dados` já deve chegar validado/normalizado (ver POST
   * /salvar-comentarios-one-page-report, lib/rotas/one-page-report.js) —
   * este módulo só persiste, não valida formato de bloco.
   */
  function salvarComentariosDoMes(mesISO, dados) {
    const tudo = lerTudo();
    const registro = {
      seguranca: dados.seguranca || { comentarios: '', proximosPassos: '' },
      producao: dados.producao || { comentarios: '', proximosPassos: '' },
      refugo: dados.refugo || { comentarios: '', proximosPassos: '' },
      expedicao: dados.expedicao || { comentarios: '', proximosPassos: '' },
      assuntosGerais: dados.assuntosGerais || '',
      atualizadoEm: new Date().toISOString(),
    };
    tudo[mesISO] = registro;
    salvarTudo(tudo);
    return registro;
  }

  return {
    CAMINHO_ARQUIVO,
    lerTudo,
    lerComentariosDoMes,
    salvarComentariosDoMes,
  };
};

module.exports.BLOCOS_VALIDOS = BLOCOS_VALIDOS;
