# PDF continua gerando em segundo plano, com fila de 1 por usuário

**Status: concluído.** Este arquivo documentava um plano; a implementação já
foi entregue por completo (e em alguns pontos foi além do que estava aqui
escrito). Mantido só como registro histórico — para o comportamento atual
de verdade, ver `lib/rotas/exportar-pdf.js`.

## O que foi pedido (recapitulando)

1. A pessoa pode fechar o site — o PDF continua sendo gerado no servidor.
2. Quando ela voltar, aparece um aviso "PDF gerado" com **Baixar** / **Descartar**.
3. Enquanto esse PDF não for baixado ou descartado, ela **não pode iniciar outro**.

## O que foi entregue

- **Job com dono**: `POST /exportar-pdf/iniciar` exige sessão de usuário
  cadastrado (ou Admin Master) e grava `job.usuarioId` (`_dadosSessaoParaPdf`).
- **Fila de 1 por usuário**: um segundo `iniciar` enquanto já existe um job
  `processando` ou `concluido` (aguardando decisão) do mesmo usuário devolve
  `409`. Jobs `erro`/`cancelado` **não bloqueiam** — liberam sozinhos.
  Admin Master tem sua própria fila, separada da dos usuários cadastrados
  (um não bloqueia o outro) — refinamento que não estava no plano original.
- **Rotas**: `GET /exportar-pdf/meu-status` (equivalente ao `meu-job`
  proposto), `POST /exportar-pdf/descartar/:jobId`, e
  `GET /exportar-pdf/arquivo/:jobId` já libera a fila do usuário ao terminar
  o download.
- **TTL corrigido**: job `processando` nunca expira por timeout (só termina
  por sucesso, erro ou cancelamento explícito) — o bug que mataria exports
  grandes (>10min) foi corrigido.
- **Persistência**: foi além do que o plano previa como "fora de escopo" —
  os jobs são persistidos de verdade em SQLite (`lib/db/exportacoes-pdf.js`),
  não só em memória.
- **Front-end**: `public/js/exportar-pdf-status.js` — badge "📄 PDF pronto"
  na topbar (`nav-topbar.html`) com popover de Baixar/Descartar, reconexão
  automática ao SSE se o job ainda estiver `processando` ao recarregar a
  página, **e integração com notificação push** (avisa quando o PDF fica
  pronto mesmo com o site fechado) — também além do que o plano original
  previa como "fora de escopo, a menos que peçam".

## Testes

`test/exportar-pdf-etapa2.test.js` cobre a fila por usuário (bloqueio,
liberação, isolamento entre usuários, TTL do job ativo, descarte).
`test/exportar-pdf-sessao.test.js` e
`test/exportar-pdf-cancelamento-entre-paginas.test.js` cobrem sessão e
cancelamento entre blocos de páginas.
