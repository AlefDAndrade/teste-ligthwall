# Plano — PDF continua gerando em segundo plano, com fila de 1 por usuário

## Objetivo

Hoje, exportar um PDF grande (ex.: "Do Dia"/"Personalizada" com 50-60
avaliações) trava o usuário na tela de progresso. O pedido:

1. A pessoa pode fechar o site — o PDF continua sendo gerado no servidor.
2. Quando ela voltar, aparece um aviso "PDF gerado" com **Baixar** / **Descartar**.
3. Enquanto esse PDF não for baixado ou descartado, ela **não pode iniciar outro**.

## O que já funciona hoje (sem mudar nada)

`_processarJob` (`lib/rotas/exportar-pdf.js`) roda sem `await` e não depende
da conexão SSE aberta pelo navegador — fechar a aba **não mata o job**. O
Chromium do servidor segue gerando o PDF normalmente. Este ponto do pedido já
está coberto pela arquitetura atual.

## Bug que preciso corrigir de qualquer forma

A limpeza de jobs órfãos usa um único TTL de 10 minutos
(`JOB_TTL_MS = 10 * 60 * 1000`, linha ~115) contado a partir de
`job.concluidoEm || job.criadoEm` — ou seja, um job que ainda está
`processando` e tem mais de 10 minutos de vida **é encerrado à força**
(`job.page.close()`), mesmo gerando ativamente. Um export de 50-60
avaliações pode facilmente passar de 10 minutos. Isso precisa ser corrigido
antes/junto do resto, senão o recurso não funciona de verdade para os casos
grandes que motivaram o pedido.

## Desenho da solução

### 1. Job passa a ter dono (`usuarioId`)

- `lib/rotas/exportar-pdf.js` passa a receber `sessaoUsuario` como
  dependência (`server.js`, mesmo padrão já usado por outras rotas —
  ex.: `rotasOperacaoAndamento`, `rotasImportacao`).
- Em `POST /exportar-pdf/iniciar`, lê `sessaoUsuario.dadosDaSessao(req)` e
  grava `job.usuarioId`. Sem sessão válida → `401`, mesma resposta padrão
  usada em outras rotas autenticadas do projeto (essa rota hoje é aberta;
  passa a exigir sessão só porque o recurso de "um job por usuário" não
  faz sentido sem saber quem é o usuário).

### 2. Um job pendente bloqueia os próximos

- Mapa novo em memória: `_jobAtualPorUsuario` (`usuarioId → jobId`).
- Em `POST /exportar-pdf/iniciar`: se já existe uma entrada para esse
  `usuarioId` e o job correspondente está em `processando` ou `concluido`
  (aguardando decisão), responde `409` com uma mensagem clara — ex.:
  *"Você já tem um PDF em andamento/pronto. Baixe ou descarte antes de
  gerar outro."* — e devolve o `jobId` existente, para o front já poder
  abrir o aviso certo em vez de só mostrar um erro genérico.
- `erro` e `cancelado` **não bloqueiam** — liberam a entrada
  automaticamente (não faz sentido travar o usuário por um job que já
  falhou).

### 3. Duas rotas novas + ajuste numa existente

| Rota | O que faz |
|---|---|
| `GET /exportar-pdf/meu-job` *(nova)* | Lê a sessão, devolve o job atual do usuário (`{jobId, status, fase, feito, total, nomeArquivo}` ou `{ job: null }`). Chamada pelo front ao carregar a página, pra saber se tem algo pendente mesmo depois de fechar/reabrir o site. |
| `POST /exportar-pdf/descartar/:jobId` *(nova)* | Confere que o job pertence ao usuário da sessão, libera `_jobAtualPorUsuario`, apaga o `pdfBuffer` da memória e remove o job. |
| `GET /exportar-pdf/arquivo/:jobId` *(ajustar)* | Ao servir o download, além de já limpar o job (comportamento atual), também libera `_jobAtualPorUsuario` para esse usuário. |

### 4. TTL corrigido, com dois tempos diferentes

- Job `processando` → **nunca** expira por TTL (só termina por sucesso,
  erro ou cancelamento explícito do usuário). Corrige o bug acima.
- Job `concluido` sem download → TTL bem mais longo que os 10 min atuais
  (proposta: **24h** — dá tempo da pessoa voltar num outro turno/dia sem
  perder o PDF, sem segurar memória pra sempre se ela simplesmente
  esquecer).
- Job `erro`/`cancelado` → mantém os 10 minutos atuais (só até o front
  conseguir mostrar a mensagem de erro uma vez).

### 5. Front-end

- **Badge na topbar** (`nav-topbar.html`), no mesmo estilo do já existente
  `📡 N pendente(s)` de operações offline — ex.: `📄 PDF pronto` — que abre
  um popover com nome do arquivo e os botões **Baixar** / **Descartar**.
  *(Não existe uma página "Perfil" hoje no sistema — este é o padrão mais
  parecido já usado no projeto para avisos persistentes; se você tinha
  outro lugar em mente, me fala antes de eu implementar o CSS/HTML.)*
- Ao carregar a página (`app-core.js` ou onde já roda a inicialização da
  sessão), chama `GET /exportar-pdf/meu-job`:
  - `processando` → mostra a barra de progresso de novo, reconectando no
    SSE (`GET /exportar-pdf/eventos/:jobId`) do job existente — a pessoa
    não perde o acompanhamento visual, só o job nunca parou de rodar.
  - `concluido` → mostra o badge/popover direto com Baixar/Descartar.
  - `erro`/`nulo` → não mostra nada.
- Botão "Exportar PDF" (onde quer que ele apareça hoje) passa a checar
  primeiro se já existe job pendente do usuário — se sim, abre o
  popover/aviso em vez de tentar iniciar outro (evita até bater no `409`
  do servidor à toa).

## Fora de escopo (a menos que você peça)

- Persistir jobs em disco/SQLite pra sobreviver a um **restart do
  servidor** — mesma filosofia já documentada no arquivo (jobs só em
  memória, igual ao rate limiting de `lib/auth.js`). Se cair o processo no
  meio de um job grande, a pessoa perde o progresso e precisa gerar de
  novo — do jeito que já é hoje.
- Notificação push quando o PDF fica pronto (existe infraestrutura de push
  no projeto, `lib/notificacoes-push.js` — dá pra plugar depois, mas é
  outro pedaço de trabalho).

## Testes que pretendo escrever

- Novo arquivo `test/exportar-pdf-fila-por-usuario.test.js`:
  - segundo `iniciar` do mesmo usuário com job `processando` → `409`.
  - segundo `iniciar` do mesmo usuário com job `concluido` não baixado →
    `409`.
  - depois de baixar (`GET /arquivo/:jobId`) ou descartar
    (`POST /descartar/:jobId`), o mesmo usuário consegue iniciar outro.
  - usuários diferentes nunca se bloqueiam entre si.
  - job `processando` não é removido pela limpeza de TTL mesmo passando o
    tempo antigo de 10 min (regressão do bug encontrado).
  - job `erro`/`cancelado` libera a entrada em `_jobAtualPorUsuario`
    automaticamente.

## Ordem de implementação sugerida (cada passo com `npm test` passando)

1. Corrigir o bug de TTL matando job `processando` (isolado, testável
   sozinho, sem mexer em mais nada).
2. Amarrar `usuarioId` ao job + exigir sessão na rota `iniciar`.
3. Bloqueio de "um job por usuário" + rota `descartar` + ajuste no
   `arquivo`.
4. Rota `meu-job`.
5. Front: badge/popover + reconexão de SSE ao carregar a página.
