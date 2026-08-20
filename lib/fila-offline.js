// ─── lib/fila-offline.js — Fila de Registro de Operação Offline (item 5) ────
// Ver README, "Registro de Operação Offline (PWA) — plano", itens 3, 5 e 6.
//
// Guarda os registros enviados por POST /operacao-offline/enviar
// (lib/rotas/operacao-offline.js) ANTES de virarem operação de verdade —
// mesmo espírito de lib/fila-avaliacao.js (arquivo JSON próprio como fonte
// de verdade, cresce/encolhe por eventos específicos), mas uma fila
// DIFERENTE e SEPARADA: nunca insere direto em "operacoes"/"tracos" (só a
// página do Master, item 6 do plano, ainda não implementada, faz isso, ao
// aprovar).
//
// Cada item da lista:
//   {
//     idTemp,                 // "OFF-<uuid>", gerado no cliente (offline-operacao.js)
//     formRecord, tracos, pausas,  // mesmo formato que iria pra
//                                   // /registrar-operacao e /registrar-relatorio-injecao
//     recebidoEm,             // timestamp do SERVIDOR no momento do envio (ISO) —
//                              // não confundir com os timestamps locais dentro de
//                              // formRecord, que vêm do relógio do dispositivo offline
//                              // (pode estar errado — ver README, item 8 do plano)
//     ip,                     // IP de quem enviou — só auditoria, não usado pra lógica
//   }
//
// Idempotência por idTemp (item 5 do plano): reenviar o mesmo idTemp (ex.:
// resposta HTTP perdida no meio do caminho, cliente tenta de novo) NUNCA
// duplica a entrada — quem decide isso é adicionarNaFilaOffline, abaixo.

module.exports = function criarFilaOffline({ fs, path, DB_DIR }) {

  const OPERACOES_OFFLINE_PENDENTES_PATH = path.join(DB_DIR, 'operacoes_offline_pendentes.json');

  function lerFilaOffline() {
    try {
      const texto = fs.readFileSync(OPERACOES_OFFLINE_PENDENTES_PATH, 'utf8').trim();
      return texto ? JSON.parse(texto) : [];
    } catch (_) {
      return []; // arquivo ainda não existe (nenhum registro offline enviado até agora) — fila vazia
    }
  }

  function salvarFilaOfflineNoDisco(lista) {
    const tmp = OPERACOES_OFFLINE_PENDENTES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(lista, null, 2), 'utf8');
    fs.renameSync(tmp, OPERACOES_OFFLINE_PENDENTES_PATH);
  }

  function buscarPorIdTemp(idTemp) {
    return lerFilaOffline().find(item => item.idTemp === idTemp) || null;
  }

  // Devolve { item, novo }: `novo: false` quando já existia (idempotência —
  // quem chamou não precisa tratar isso como erro, só como "já estava
  // enfileirado", e responder sucesso do mesmo jeito).
  function adicionarNaFilaOffline(registro) {
    const lista = lerFilaOffline();
    const existente = lista.find(item => item.idTemp === registro.idTemp);
    if (existente) {
      return { item: existente, novo: false };
    }
    lista.push(registro);
    salvarFilaOfflineNoDisco(lista);
    return { item: registro, novo: true };
  }

  // Remove um item da fila — usado depois de aprovar (a operação já virou
  // uma linha de verdade em `operacoes`, não faz sentido continuar
  // pendente) ou ao recusar (descarta sem nunca ter virado operação).
  function removerDaFilaOffline(idTemp) {
    const lista = lerFilaOffline();
    const restante = lista.filter(item => item.idTemp !== idTemp);
    if (restante.length === lista.length) return false; // não existia
    salvarFilaOfflineNoDisco(restante);
    return true;
  }

  // "Corrigir antes de aprovar" (item 6 do plano, ver README) — aplica um
  // PATCH em cima do item pendente (nunca substitui o registro inteiro:
  // só os campos informados em `patch` são sobrescritos), registra quem
  // corrigiu e quando. Usado tipicamente pra ajustar `inicio`/`fim`/
  // `qtd_tracos` de formRecord quando o relógio do dispositivo offline
  // parece estar errado (ver README, item 8) — mas aceita qualquer campo
  // de formRecord, não é uma lista fechada.
  function atualizarNaFilaOffline(idTemp, patch, corrigidoPor) {
    const lista = lerFilaOffline();
    const idx = lista.findIndex(item => item.idTemp === idTemp);
    if (idx === -1) return null;
    const item = lista[idx];
    if (patch.formRecord && typeof patch.formRecord === 'object') {
      item.formRecord = { ...item.formRecord, ...patch.formRecord };
    }
    if (Array.isArray(patch.tracos)) item.tracos = patch.tracos;
    if (Array.isArray(patch.pausas)) item.pausas = patch.pausas;
    item.corrigidoPor = corrigidoPor || null;
    item.corrigidoEm = new Date().toISOString();
    lista[idx] = item;
    salvarFilaOfflineNoDisco(lista);
    return item;
  }

  return {
    lerFilaOffline,
    salvarFilaOfflineNoDisco,
    buscarPorIdTemp,
    adicionarNaFilaOffline,
    removerDaFilaOffline,
    atualizarNaFilaOffline,
  };
};
