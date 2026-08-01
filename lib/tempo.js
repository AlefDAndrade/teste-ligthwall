// ─── lib/tempo.js — Horário de Brasília + utilitário genérico ─────────────
// Fase 19 do fatiamento de server.js (ver README, "Fatiamento de server.js"
// → "Plano de continuidade") — a última fase do plano. Funções PURAS, sem
// estado nenhum e sem I/O (a única "dependência externa" é `process.env`,
// lido direto — não precisa de injeção): por isso, ao contrário das fases
// 12–18, este módulo não é uma factory — é só um objeto de funções,
// require()ado direto (mesmo padrão de lib/perfis.js).
//
// numOuNulo não tem relação nenhuma com horário — é só o outro utilitário
// "genérico" que sobrava solto em server.js, sem lar próprio; foi junto por
// ser pequeno demais pra merecer um arquivo só dele.

// "Agora" usado por todayBrasiliaServer/horaMinutoBrasiliaServer, abaixo —
// SEMPRE `new Date()` de verdade em produção. Só existe esta indireção pra
// permitir que a suíte de testes (ver test/manutencao-programada-lembrete.
// test.js) congele o relógio do servidor e teste deterministicamente o job
// do lembrete das 09h (ver executarLembreteManutencaoProgramadaSeNecessario,
// lib/notificacoes-push.js), sem precisar esperar a hora real do dia bater
// 09h. LW_TEST_RELOGIO_ISO só é lido se alguém setar a variável de ambiente
// explicitamente (nunca acontece numa instalação normal/`npm start`) —
// mesmo espírito do "Modo de Teste" já existente pra Registrar Operação
// (ver DB_TESTE_DIR, lib/contador-tracos-estado.js): nunca interfere com
// uso real.
function _agoraServer() {
  if (process.env.LW_TEST_RELOGIO_ISO) return new Date(process.env.LW_TEST_RELOGIO_ISO);
  return new Date();
}

// Retorna a data de hoje em Brasília no formato YYYY-MM-DD (consistente com
// todayBrasilia() do frontend), independente do fuso horário do servidor.
function todayBrasiliaServer() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(_agoraServer()); // en-CA já formata como YYYY-MM-DD
}

// Retorna { hora, minuto } de agora em Brasília — usado pelo backup
// automático diário, pra saber se já passou do horário de "fim de dia".
function horaMinutoBrasiliaServer() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const partes = fmt.formatToParts(_agoraServer());
  const hora = parseInt(partes.find(p => p.type === 'hour').value, 10);
  const minuto = parseInt(partes.find(p => p.type === 'minute').value, 10);
  return { hora, minuto };
}

// Converte pra número, ou null se vazio/nulo/indefinido — usado ao montar
// parâmetros de colunas SQL a partir de valores de formulário (que chegam
// como string vazia '' quando o campo não foi preenchido).
function numOuNulo(v) {
  return (v === '' || v === null || v === undefined) ? null : Number(v);
}

module.exports = {
  todayBrasiliaServer,
  horaMinutoBrasiliaServer,
  numOuNulo,
};
