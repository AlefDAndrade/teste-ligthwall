# Lightwall SC — Sistema de Injeção

Sistema interno de controle de operações de injeção de baterias (placas cimentícias / EPS), com registro de traços, relatórios, dashboards analíticos e administração de configurações.

## Stack

- **Backend**: Node.js puro (módulo `http`, sem framework), servindo arquivos estáticos e uma API simples em JSON. A lógica vinha toda num `server.js` só; está sendo fatiada por fases pra `lib/` (ver *Fatiamento de server.js*, abaixo).
- **Frontend**: HTML/CSS/JS sem framework — `index.html` é gerado a partir de pedaços (`public/partials/` + `public/index.template.html`) por um pequeno script (`build-index.js`), em vez de ser editado à mão como um arquivo só de 5 mil linhas (ver *Fatiamento de index.html*, abaixo). Fora isso, continua sem framework nem bundler — é só um passo extra antes de rodar/editar.
- **"Banco de dados"**: em migração, por fases, de arquivos JSON (`public/db/`) pra **SQLite** (`better-sqlite3`) — ver seção dedicada, abaixo. Os arquivos JSON que ainda não foram migrados continuam exatamente como sempre.
- **Dependências**: `xlsx` (exportação/importação de Excel), `jszip` (geração e leitura de backups `.zip`), `ws` (WebSocket da Operação em Andamento), `better-sqlite3` (banco de dados), `web-push` (notificações push de novo chamado de manutenção — ver *Notificações Push*, abaixo). `lib/sessao.js` usa só `crypto` nativo do Node, e os testes usam o test runner nativo (`node:test`).

## Como rodar

```bash
npm install
npm start
```

`npm start` (e `npm run dev`) já rodam `node build-index.js` automaticamente antes de subir o servidor (via `prestart`/`predev` no `package.json`) — então `public/index.html` está sempre atualizado com o que tiver em `public/partials/`, sem precisar lembrar de um passo manual. Pra gerar manualmente sem subir o servidor (ex: só pra conferir o resultado), `npm run build`.

O servidor sobe em `http://localhost:5000` (ou na porta da variável de ambiente `PORT`, se definida — útil pra rodar os testes numa porta separada sem conflitar com um servidor de desenvolvimento já aberto). Requer Node `>= 18`.

## Testes automatizados

```bash
npm test
```

Roda a suíte em `test/` usando o test runner nativo do Node (`node --test` — nenhuma dependência nova). `test/helpers/servidor-teste.js` sobe uma cópia ISOLADA do `server.js` de verdade (não um mock) numa porta própria, dentro de `.test-tmp/` (gitignored) — nunca toca nos dados da instalação de verdade. Cobertura atual: autenticação (hash de senha, migração do formato legado, rate limiting) e a sessão de administrador, permissões de controle de operação, registrar operação e traços (`/registrar-operacao`, `/registrar-relatorio-injecao`), editar operação/traço (`/editar-operacao`, `/editar-traco-relatorio` — ver `test/edicao-operacao-traco.test.js`), paradas (`/salvar-parada`, `/excluir-parada` — ver `test/paradas-crud.test.js`), sobra de material (`/salvar-sobra` — ver `test/sobra-crud.test.js`), mesclar backup de dados (`/mesclar-backup-dados` — ver `test/mesclar-backup-dados.test.js`), importação em massa, backup e restauração (Backup de Dados e Backup Geral, incluindo o fluxo de ponta a ponta), Setor de Qualidade, Setor de Manutenção, e várias outras telas/regras específicas (paletes, perfis customizados, atalhos, etc. — ver `test/`).

Em máquinas/CI com poucos núcleos, `node --test` sobe vários arquivos em paralelo e CADA UM que usa `servidor-teste.js` spawna seu próprio `node server.js` — sob contenção de CPU isso pode (raramente) estourar o tempo de espera do servidor subir, sem que nada esteja de fato quebrado. Se a suíte ficar "flaky" nesse tipo de ambiente, `npm run test:serial` roda tudo com `--test-concurrency=1` (mais lento, mas sem essa contenção).

## Estrutura de pastas

```
public/
├── index.html          # GERADO por build-index.js — não editar à mão (ver index.template.html)
├── index.template.html  # "casca" do index.html, com marcadores <!-- INCLUDE:nome.html -->
├── partials/             # cada página/modal do app principal, um arquivo por pedaço
├── login.html         # tela de login / escolha de perfil
├── css/
│   ├── styles.css     # tema e estilos do app principal
│   └── login.css      # estilos da tela de login
├── js/
│   ├── data.js                # camada de dados/config — fetch, calcPaineis, getStats etc.
│   ├── app-core.js              # navegação entre páginas, modais, tema (era um <script> inline)
│   ├── operacao.js             # tela "Registrar Operação"
│   ├── dashboard.js             # Registro de Baterias, Relatório de Injeção, Desempenho Turnos
│   ├── analise-operacional.js   # dashboard "Análise Operacional"
│   ├── qualidade-tracos.js      # dashboard "Qualidade dos Traços" (CEP)
│   ├── oee.js                  # dashboard "OEE"
│   ├── paradas.js               # tela "Registro de Paradas"
│   ├── debriefing.js            # popover "Debriefing do Dia" (global, na topbar)
│   ├── admin-auth.js            # autenticação do perfil Administrador
│   └── keyboard-shortcuts.js    # atalhos de teclado e modal de ajuda (F1)
└── db/
    ├── config.json             # baterias, tipos de montagem, volume por placa
    ├── historico.json           # histórico de operações (Registro de Baterias)
    ├── historico_edicoes.json   # log de auditoria de edições em historico.json
    ├── relatorio_injecao.json   # traços injetados (Relatório de Injeção)
    ├── relatorio_edicoes.json   # log de auditoria de edições em relatorio_injecao.json
    ├── ajustes_tracos.json      # ajustes de receita por traço (insumo + tempo de batida) — fonte de verdade após uma edição (ver "Editar Traço")
    ├── sobra.json                # traço com sobra ativa entre operações
    ├── paradas.json              # paradas registradas (planejadas/não planejadas)
    ├── operacoes_nao_avaliadas.json # fila de avaliação do Setor de Qualidade (IDs pendentes — fonte de verdade, ver "Fila de Avaliação")
    ├── operacao_andamento.json    # snapshot da operação em andamento agora (live), ou null
    └── contador_tracos.json      # contador diário de traços (reset automático)
private/
└── security.json         # hash da senha do admin + hash da chave de recuperação — FORA de public/ de propósito (ver Autenticação e Sessão, abaixo)
lib/
├── auth.js                # hash de senha (scrypt + compat. legado) e rate limiting de tentativas
└── sessao.js               # sessão de Administrador (cookie HttpOnly)
test/
├── auth.test.js            # ver "Testes automatizados", acima
└── helpers/servidor-teste.js
deploy/
├── instalar-https.sh     # HTTPS via Caddy + nip.io numa VM sem domínio próprio (ver "Notificações Push")
└── Caddyfile.exemplo     # modelo de referência do Caddyfile gerado pelo script acima
server.js               # servidor HTTP + rotas da API
build-index.js          # monta public/index.html a partir do template + partials
package.json
```

`backups-seguranca/`, `backups-automaticos/`, `logs/` e `private/` são criadas automaticamente pelo servidor e nunca devem ser versionadas — já estão no `.gitignore`. Todas ficam **fora** de `public/`, então nenhuma é servida como arquivo estático nem acessível por URL direta.

`public/db/teste/` é criada automaticamente na primeira vez que o **Modo de Teste** é usado (ver seção dedicada, abaixo) — mesmos arquivos de uma operação normal (`historico.json`, `relatorio_injecao.json`, `contador_tracos.json`, `ajustes_tracos.json`, `sobra.json`), só que isolados, pra nunca misturar com dados reais. Também não é versionada.

## Fatiamento de server.js

`server.js` era um arquivo único que cresceu bastante (3.607 linhas, ~60 rotas, tudo dentro de uma única função de callback do `http.createServer`); está sendo fatiado por fases pra `lib/`, extraindo um domínio autocontido por vez (sem mudar lógica nenhuma — só onde o código mora, com o comportamento validado de novo depois de cada fase, tanto pela suíte automatizada quanto por chamadas HTTP reais reproduzindo o fluxo de cada rota).

**Padrão seguido a partir da Fase 3** (`lib/rotas/`): cada módulo exporta uma *factory* que recebe só as dependências que aquele domínio usa (nunca um `ctx` genérico gigante) e devolve uma função `tentar(req, res, urlPath, queryParams)` — tenta casar as rotas daquele domínio e devolve `true` se já respondeu (o dispatcher em `server.js` para por ali) ou `false`/nada se a requisição não é dele (segue tentando o próximo módulo, e por fim as rotas ainda não extraídas). Helpers usados por MAIS de um domínio (ex.: `dispositivoAutorizado`, `lerOperacaoAndamento`, os helpers da fila de avaliação) continuam definidos em `server.js` e são injetados via `ctx` em quem precisar — evita duplicar lógica ou criar dependência de um módulo extraído de volta pra outro.

| Fase | O que saiu | Pra onde |
|---|---|---|
| 1 | Hash de senha (scrypt + compat. legado) e rate limiting de tentativas | `lib/auth.js` |
| 2 | Sessão de Administrador | `lib/sessao.js` |
| 3 | Identidade Leve de Operador (cadastro, verificação de PIN) — *removida depois, ver Autoria automática de registro* | `lib/rotas/operadores.js` (não existe mais) |
| 4 | Registro de Paradas | `lib/rotas/paradas.js` |
| 5 | Setor de Qualidade / Avaliações (fila, avaliação, marcação) | `lib/rotas/qualidade.js` |
| 6 | Dados SQL (Configurações → 🗄️ Dados SQL) | `lib/rotas/sql-admin.js` |
| 7 | Views somente-leitura derivadas do SQLite (historico, relatório de injeção, berços visuais, etc.) | `lib/rotas/consultas.js` |
| 8 | Sobra de material | `lib/rotas/sobra.js` |
| 9 | Contador de Traços do Dia | `lib/rotas/contador-tracos.js` |
| 10 | Log de Acesso | `lib/rotas/log-acesso.js` |
| 11 | Operação em Andamento (estado ao vivo + berços marcados, WebSocket) | `lib/rotas/operacao-andamento.js` |

**Nota (correção da documentação)**: as fases acima foram as únicas numeradas/documentadas na época, mas o fatiamento continuou depois disso sem a tabela ser atualizada — o texto antigo desta seção chegou a listar `registrar-operacao`, `editar-operacao`, `registrar-relatorio-injecao`, `editar-traco-relatorio`, `registrar-ajuste-traco`, `leitura-automatica` e as rotas de Autenticação/config como **pendentes**, o que não é mais verdade: todas elas já foram extraídas, em algum momento não documentado, pra `lib/rotas/registro-operacao.js`, `lib/rotas/edicao.js`, `lib/rotas/leitura-e-ajustes.js` e `lib/rotas/autenticacao.js` respectivamente — junto com Usuários (`usuarios.js`), Perfis Customizados (`perfis-customizados.js`), Importação (`importacao.js`), Backup (`backup.js`) e Dispositivos Autorizados (`dispositivos-autorizados.js`). `server.js` está hoje em **1.048 linhas** (não ~2.450) — bem mais fatiado do que a tabela acima, sozinha, sugere. Corrigido aqui pra não repetir o erro: a tabela documenta as fases numeradas originais; o restante do que já saiu está listado, sem número de fase (não dá pra reconstruir com segurança em que ordem cada um saiu a partir do histórico do git), na lista de módulos em `lib/rotas/` no início deste README.

### Plano de continuidade (Fase 12 em diante)

O que sobra hoje em `server.js` **não é mais rota de domínio** — é o núcleo compartilhado: helpers usados por MAIS de um módulo já extraído (injetados via `ctx`, ver *Padrão seguido a partir da Fase 3*, acima), mais o dispatcher HTTP em si (loop de `ROTAS_EXTRAIDAS`, servir estáticos, upgrade de WebSocket), que por definição não extrai — é a raiz de composição do processo inteiro.

Ordem pensada **pelo critério de contenção de risco entre PRs simultâneos** (o mais tocado por diferentes domínios primeiro — ver conversa que motivou esta mudança de critério, antes deste plano o projeto vinha usando "menor pro maior risco de regressão" isoladamente, o que empurrava justamente o código mais compartilhado, e portanto mais sujeito a conflito de merge, pro final):

| Fase | O que sai | Candidato a | Por que essa posição |
|---|---|---|---|
| 12 ✅ | Dispositivo Autorizado + `podeControlarOperacao`/`negarControleDeOperacao` (linhas ~658–770) | `lib/dispositivo-autorizado.js` | É o que teve a mudança mais recente (cookie HttpOnly + IP, ver seção *Identidade do dispositivo*) e é chamado por `registro-operacao.js`, `operacao-andamento.js` e `contador-tracos.js` ao mesmo tempo — hoje, qualquer PR que mexa em qualquer um desses três domínios esbarra no mesmo bloco de `server.js`. Prioridade 1 por ser o ponto de maior contenção agora. |
| 13 ✅ | WebSocket broadcast (`_enviarWsParaTodos`, `broadcastOperacaoAndamento`, `broadcastOperacaoFinalizada`, `broadcastLeituraAutomatica`, `broadcastDadosSqlExcluidos` — linhas ~975–1048) | `lib/websocket-broadcast.js` | Chamado por praticamente todo módulo que mexe em operação em andamento (`registro-operacao`, `leitura-e-ajustes`, `operacao-andamento`, `sql-admin`) — mesmo padrão de contenção do item 12, mas tecnicamente mais delicado (estado de conexões WebSocket ao vivo), por isso vem depois, não junto. |
| 14 ✅ | Operação em Andamento (estado em disco) + Berços Andamento (`lerOperacaoAndamento`, `salvarOperacaoAndamentoNoDisco`, `lerBercosAndamento`, `salvarBercosAndamentoNoDisco` — linhas ~493–507, 601–640) | `lib/operacao-andamento-estado.js` | Mesmos quatro consumidores do item 12 (é o estado que eles leem/escrevem). Extrair logo depois dos itens 12–13 evita que essa fase precise reabrir os mesmos call sites duas vezes. |
| 15 ✅ | Fila de Avaliação — "não avaliadas" (`lerOperacoesNaoAvaliadas`, `salvarOperacoesNaoAvaliadasNoDisco`, `adicionarNaFilaNaoAvaliadas`, `removerDaFilaNaoAvaliadas`, `recalcularFilaNaoAvaliadasApartirDoSql`, `migrarFilaNaoAvaliadasSeNecessario` — linhas ~508–600) | `lib/fila-avaliacao.js` | Compartilhado entre `qualidade.js` e `registro-operacao.js` — dois domínios, então já é ponto de conflito, mas menos concorrido que os itens 12–14 (só dois consumidores, não quatro). |
| 16 ✅ | Permissões de área/Manutenção (`podeEditarArea`, `negarEdicao`, `temPoderesDeAdmin`, `podeExcluirChamado`, `nomeDeQuemAceita`, `nomeParaVisualizacao`, `podeEditarAberturaChamado`, `podeAceitarChamado`, `podeAceitarPedidoPeca`, `podeRenotificarManutencao`, `podeConfirmarRecebimentoPeca` — linhas ~131–297) | `lib/permissoes-area.js` | Usado por `paradas.js` e `manutencao.js` — Manutenção é a área com mais commits recentes do projeto (chamados, filtros, top bar — ver histórico), então mesmo com só dois consumidores diretos, é código tocado com bastante frequência; sobe na fila por isso. |
| 17 ✅ | `security.json` (fora de `public/`, leitura/gravação) — linhas ~36–130 | `lib/security-json.js` | Consumido só por `autenticacao.js` hoje — único consumidor, então baixa urgência pela lente de conflito de PR; extrai mais por organização do que por necessidade. |
| 18 ✅ | Modo de Teste / Contador de Traços do Dia (estado) (`dirParaModoTeste`, `lerContadorTracosHoje`, `incrementarContadorTracosHoje` — linhas ~423–482) | `lib/contador-tracos-estado.js` | Cuidado pra não confundir com `lib/rotas/contador-tracos.js` (que já existe — é a ROTA HTTP; isso aqui é o estado que ela e `registro-operacao.js` compartilham). Dois consumidores, pouco tocado nos últimos meses — mais seguro deixar por último. |
| 19 ✅ | Horário de Brasília + utilitário genérico (`_agoraServer`, `todayBrasiliaServer`, `horaMinutoBrasiliaServer`, `numOuNulo` — linhas ~18–35, 395–422) | `lib/tempo.js` | Funções puras, usadas em quase tudo mas sem estado nenhum — risco de regressão praticamente zero, extrai a qualquer momento; deixado por último só porque não é urgente (não é ponto de conflito real, já que são funções puras sem I/O). |

**Nota sobre a Fase 17**: extraiu `PRIVATE_DIR`/`SECURITY_PATH`, o `fs.mkdirSync(PRIVATE_DIR, ...)` e a migração automática (`migrarSecurityJsonSeNecessario`, `public/db/security.json` antigo → `private/security.json`) — mesma lógica, só mudou onde o código mora. `USUARIOS_PATH` e `PERFIS_CUSTOMIZADOS_PATH` continuam em `server.js` (não são "segurança" propriamente — são arquivos-irmãos que só reaproveitam o mesmo `PRIVATE_DIR`, agora devolvido pelo módulo). `lib/security-json.js` tem 49 linhas; a suíte de testes inteira (470 testes verdes, incluindo os 3 de `security-json-fail-closed.test.js` e os de backup/restauração que leem `security.json`) continua passando — as ~10 falhas pré-existentes em testes de UI de Manutenção (jsdom) não têm relação com esta fase, confirmado rodando a mesma suíte antes da extração.

**Nota sobre a Fase 18**: extraiu `dirParaModoTeste`/`lerContadorTracosHoje`/`incrementarContadorTracosHoje` (e `DB_TESTE_DIR`) — mesma lógica, só mudou onde o código mora. A tabela original citava "dois consumidores", mas na prática hoje são cinco: `lib/rotas/sobra.js`, `lib/rotas/contador-tracos.js`, `lib/rotas/leitura-e-ajustes.js`, `lib/rotas/registro-operacao.js` e `lib/rotas/backup.js` — todos já recebiam essas funções injetadas de fora, então a extração não mudou nenhum call site, só a origem do `require`. A suíte de testes inteira (470 testes) continua passando; as ~9 falhas pré-existentes em UI de Manutenção (jsdom) seguem sem relação com esta fase.

**Nota sobre a Fase 19**: extraiu `_agoraServer`/`todayBrasiliaServer`/`horaMinutoBrasiliaServer`/`numOuNulo` — mesma lógica, sem mudança de comportamento (`LW_TEST_RELOGIO_ISO` continua funcionando igual). Diferente das Fases 12–18, `lib/tempo.js` não é uma factory — são funções puras sem I/O nem estado (a única "dependência" é `process.env`, lido direto), então é só um `require()` simples, mesmo padrão de `lib/perfis.js`. Com isso, **as Fases 12 a 19 do plano de continuidade estão todas concluídas** — `server.js` caiu de 1.048 para 567 linhas nessa série; o que sobra nele hoje é só o núcleo compartilhado descrito acima (dispatcher HTTP, servir estáticos, upgrade de WebSocket, `require`+composição das factories de `lib/rotas/`) mais a fiação de conexão entre todas as peças já extraídas — não é mais dívida técnica, é a raiz de composição do processo por definição. Suíte de testes inteira (470 testes) verde antes e depois de cada fase.

O que **não** entra nesse plano — fica em `server.js` por definição, não é dívida técnica: o loop `for (const modulo of ROTAS_EXTRAIDAS)`, o servir de arquivos estáticos (`fs.readFile`/`Cache-Control: no-store` sob `/db/`), o upgrade de conexão WebSocket, e o `require(...)` + composição de todas as factories de `lib/rotas/` — é a raiz de composição do processo (onde tudo é ligado), então continua sendo o "índice" do arquivo, só que cada vez mais enxuto.

Mesmo padrão de validação das fases 1–11 se aplica a cada uma destas: extrair um domínio por vez, sem mudar lógica nenhuma (só onde o código mora), suíte automatizada + bateria manual das rotas que dependem daquele helper rodando verde antes de seguir pra próxima fase.

**Fase 12 concluída**: `lerDispositivosAutorizados`, `salvarDispositivosAutorizados`, `dispositivoAutorizado`, `podeControlarOperacao` e `negarControleDeOperacao` saíram pra `lib/dispositivo-autorizado.js` — mesma lógica, só mudou onde o código mora. `server.js` caiu de 1.048 para **950 linhas**. Suíte completa (79 arquivos) rodada em 4 lotes: 100% verde, fora 2 falhas em `test/manutencao-pagina.test.js` que já existiam **antes** desta fase (confirmado rodando a mesma suíte no código anterior) — sem relação com esta extração, não investigadas aqui.

**Fase 13 concluída**: `_enviarWsParaTodos`, `broadcastOperacaoAndamento`, `broadcastOperacaoFinalizada`, `broadcastLeituraAutomatica` e `broadcastDadosSqlExcluidos` saíram pra `lib/websocket-broadcast.js`, junto com o Set de clientes conectados e o contador de revisão (que antes eram variáveis soltas em `server.js`, agora encapsuladas atrás de `adicionarCliente()`/`removerCliente()`/`getRevisaoAtual()` — `server.js` só chama essas três dentro de `wss.on('connection', ...)`, que continua lá por depender do `server` HTTP). `server.js` caiu de 950 para **898 linhas**. Suíte completa rodada em 4 lotes: 100% verde, fora falhas isoladas já conhecidas como flakiness de ambiente sob carga (`db-sem-cache`, `manutencao-renotificar`) — confirmadas passando 100% em isolamento. Um achado que **foi investigado a fundo** por envolver WebSocket de verdade (o teste mais sensível a esta fase): `test/operacao-andamento-revisao.test.js` falhou 1 vez rodando logo depois de outro lote pesado; rodado **23 vezes seguidas seguintes** (isolado e em conjunto com `test/relatorio-bercos-filtros.test.js`), 23/23 verde — e a mesma combinação não falhou em 3 rodadas no código anterior à Fase 13. Conclusão: mesmo padrão de flakiness sob carga do restante da suíte (ambiente, não regressão de código), mas fica registrado aqui por ser o teste mais diretamente ligado a esta extração.

## Fatiamento de index.html

`index.html` tinha ~5.200 linhas — quase metade era um único `<script>` inline sem nome, e o resto eram as 9 páginas + 11 modais do app, tudo num arquivo só. Diferente de `server.js` (módulos Node de verdade, com `require()`), o navegador não tem como "importar" pedaços de HTML — então a solução foi um **build step**: cada página/modal vive em `public/partials/`, a "casca" (head, topbar, sidebar, scripts) vive em `public/index.template.html` com marcadores `<!-- INCLUDE:nome.html -->`, e `build-index.js` monta o `index.html` final a partir dos dois. A reconstrução foi validada **byte a byte** (diff + checksum) contra o arquivo original antes de qualquer commit dessa mudança — zero risco de comportamento diferente no navegador.

O bloco `<script>` inline foi extraído primeiro, separadamente, pra `public/js/app-core.js` — um `<script src="...">` executa exatamente na mesma ordem que um inline (sem `defer`/`async` em nenhum dos dois), então essa parte não precisou de build step nenhum.

**Editar uma tela agora**: edite o partial correspondente em `public/partials/` (ou `app-core.js`, pro código compartilhado) — `npm start`/`npm run dev` já rodam o build de novo automaticamente. Pra ver o resultado sem reiniciar o servidor, `npm run build`. Nunca edite `public/index.html` direto, ele é sobrescrito no próximo build.



## Banco de Dados (SQLite)

Os arquivos JSON de `public/db/` crescem sem limite e são lidos/escritos **por inteiro** a cada operação (lê tudo, mexe em memória, escreve tudo de volta) — funciona bem em baixo volume, mas não tem transação de verdade (dois `POST` quase simultâneos podem se sobrescrever) nem índice (toda busca percorre o arquivo inteiro). Por isso, está em andamento uma migração **por fases** pra SQLite (`better-sqlite3`) — cada fase migra um grupo de arquivos por vez, totalmente testada antes da próxima.

**Por que SQLite e não Postgres/MySQL**: continua sendo um arquivo só (`data/lightwall.sqlite`), sem processo de banco separado pra administrar — mesma simplicidade de operação que o projeto sempre teve (`node server.js`, sem Docker, sem serviço externo). Só valeria a pena trocar por um banco "de servidor" se um dia isso precisasse rodar em mais de uma máquina escrevendo no mesmo banco ao mesmo tempo.

**Status da migração:**

| Fase | Arquivo(s) JSON | Tabela(s) SQL | Status |
|---|---|---|---|
| 1 | — (infraestrutura) | — | ✅ Feita — `db.js` cria o banco/schema completo no boot; nenhuma rota usa ainda |
| 2 | `historico.json`, `historico_edicoes.json` | `operacoes`, `edicoes_operacao` | ✅ Feita |
| 3 | `paradas.json` | `paradas` | ✅ Feita |
| 4 | `sobra.json`, `contador_tracos.json` | `sobra`, `contador_tracos` | ✅ Feita |
| 5 | `relatorio_injecao.json`, `ajustes_tracos.json` | `tracos`, `traco_usos`, `ajustes`, `leituras_resultado`, `edicoes_traco` | ✅ Feita |

`config.json`, `security.json`, `operacao_andamento.json` e `logs/acessos.json` **não entram** nessa migração — são configuração, estado efêmero ou log de baixo volume, sem o mesmo problema de concorrência/crescimento. Continuam como JSON.

### Fase 2 — como funciona na prática

- **Migração automática, sem passo manual**: no boot, `db.migrarHistoricoSeNecessario()` confere se a tabela `operacoes` está vazia E `historico.json` ainda existe com esse nome — se sim, importa tudo (numa transação) e **renomeia** o arquivo pra `historico.json.migrado-<timestamp>` (nunca apaga). Isso também acontece com `historico_edicoes.json`. Reinicia o servidor sem ter migrado nada ainda? Roda sozinho, sem precisar lembrar de nenhum comando.
- **Zero mudança no navegador**: `historico.json` não existe mais como arquivo, mas o servidor intercepta `GET /db/historico.json` (e `historico_edicoes.json`) e devolve o mesmo formato de sempre, reconstruído a partir do SQL — toda tela que já fazia `fetch('db/historico.json')` direto (Registro de Baterias, OEE, Análise Operacional, Debriefing, a tela de Backup de Dados) continua funcionando **sem nenhuma alteração**.
- **Backup e Restauração também não mudam de comportamento**: "Backup de Dados" e o backup automático diário exportam o conteúdo atual da tabela como JSON (mesmo formato); "Restaurar Backup de Dados" substitui o conteúdo da tabela inteira (dentro de uma transação) em vez de escrever um arquivo. "Backup Geral" reaproveita a mesma exportação JSON (não inclui `data/lightwall.sqlite` diretamente) — com um detalhe importante: roda um `PRAGMA wal_checkpoint(TRUNCATE)` antes de exportar, senão escritas recentes podem estar só no arquivo `-wal` e não no `.sqlite` principal.
- **Modo de Teste não foi tocado**: continua escrevendo em `public/db/teste/historico.json`, exatamente como antes — só o caminho **real** (sem `?modoTeste=true`) passa a usar SQL.
- **Testado**: migração automática (comparando campo a campo com o arquivo original — reconstrução idêntica), `/registrar-operacao`, `/editar-operacao` (inclusive a checagem de campos protegidos), `/importar-historico` com deduplicação, 5 registros concorrentes via `Promise.all` (o problema original que motivou a migração), Modo de Teste continuando isolado, e a restauração completa de um Backup de Dados (com o backup de segurança pré-restauração capturando o estado anterior corretamente).
- **Achado de implementação**: tanto o `better-sqlite3` quanto o `node:sqlite` recusam um objeto de parâmetros nomeados com chaves que não aparecem na query (`UPDATE ... SET x = @x` não aceita um objeto que também tenha `@y` sem uso) — o `UPDATE` de `/editar-operacao` precisa receber só as colunas que de fato atualiza, não o objeto inteiro do registro.

### Fase 3 — como funciona na prática

Bem mais simples que a Fase 2: `paradas.json` é uma lista plana (`{id, inicio, fim, duracao_min, motivo, equipamento, classificacao, obs, registrado_em}`), sem nenhum campo calculado/serializado — então não precisou de tabela de auditoria nem de cuidado especial nenhum.

- Mesmo padrão de tudo: migração automática no boot (renomeia `paradas.json` pra `.migrado-<timestamp>` depois de importar), `GET /db/paradas.json` interceptado pra devolver o mesmo formato de sempre (cobre `paradas.js` e `oee.js`, que já faziam `fetch('db/paradas.json')` direto — zero mudança no navegador), e Backup de Dados/Restauração/Backup Geral tratando `paradas.json` como tabela, igual a `historico.json`.
- `/salvar-parada` (que fazia inserir-ou-atualizar por `id`) virou um `INSERT ... ON CONFLICT(id) DO UPDATE` — upsert de verdade, em 1 query, em vez de ler tudo, achar o índice, e escrever tudo de volta.
- **Testado**: migração automática (reconstrução idêntica), inserir, atualizar (upsert no mesmo id, sem duplicar), excluir, excluir inexistente (erro), 5 paradas concorrentes via `Promise.all`, e a restauração completa de um backup (com o backup de segurança capturando as paradas anteriores corretamente).

### Fase 4 — como funciona na prática

`sobra.json` é um objeto único (não lista) em **camelCase** (`tracoId`, `numTraco`, `operacaoOrigem`, `dataEncerramento`) — diferente da convenção `snake_case` do resto do projeto, preservada de propósito na reconstrução pra não quebrar nada no navegador. Continua sendo "1 registro só, sempre o mais recente" — a tabela usa `id = 1` fixo, com `INSERT ... ON CONFLICT(id) DO UPDATE` em todo salvamento (nunca um 2º registro).

`contador_tracos.json` já tinha tabela desde a Fase 1 (`data` como chave — 1 linha por dia). Aqui veio a melhoria mais concreta da migração até agora:

- **Incremento atômico de verdade**: antes, "confirmar N traços" era ler o total, somar em JS, escrever de volta — dois pedidos quase simultâneos podiam ler o mesmo valor e um incremento se perder. Agora é uma única query (`INSERT ... ON CONFLICT(data) DO UPDATE SET total = total + ?`), que soma **dentro do banco**. Testado com 10 confirmações de "+1" disparadas ao mesmo tempo via `Promise.all` — as 10 contaram, nenhuma se perdeu.
- **Bônus**: como a tabela aceita 1 linha por dia (e não só "o dia atual", como o arquivo fazia), o histórico de dias anteriores fica preservado — o arquivo antigo sobrescrevia o total assim que o dia virava; agora cada dia continua consultável depois. O formato **externo** (`GET /db/contador_tracos.json`, Backup de Dados) continua devolvendo só o dia de hoje, pra não mudar o contrato existente.
- A restauração de `contador_tracos.json` faz upsert só da linha mencionada no backup (geralmente "hoje" no momento em que o backup foi feito) — não apaga os outros dias que o banco tenha acumulado desde então; `sobra.json`/`historico.json`/`paradas.json` continuam substituindo a tabela inteira (são histórico completo, sempre estiveram assim).
- **Testado**: as duas migrações automáticas (reconstrução idêntica de `sobra.json`; `contador_tracos.json` corretamente "zerando" para o dia atual sem perder o dia antigo, que fica preservado como uma linha separada — mesmo comportamento que o arquivo já tinha, de resetar a cada novo dia), salvar/atualizar sobra sem duplicar linha, e a restauração de backup pros dois.

### Fase 5 — como funciona na prática

A mais complexa, e a única que muda a FORMA dos dados, não só o lugar onde moram. `ajustes` agora é uma tabela de verdade (1 linha por ajuste) — o total de cada insumo é `original + SUM(ajustes.<campo>)`, somado pelo banco, nunca mais montado à mão em JS. Isso elimina estruturalmente o problema de sincronia entre `relatorio_injecao.json` e `ajustes_tracos.json` que resolvíamos manualmente, caso a caso, na tela de Editar Traço.

- **Dois FKs de propósito ficaram de fora** (ver comentário no schema, em `db.js`): `ajustes.id_traco` e `traco_usos.id_operacao`. O "+ Ajuste de Receita" ao vivo grava um ajuste **antes** do traço existir na tabela `tracos` (só é criado ao finalizar/registrar a operação) — exigir o FK quebraria esse fluxo. E a importação de planilha gera um `id_operacao` sintético que nunca existe em `operacoes` — não há uma operação real por trás de uma linha de Excel.
- **Dados legados sem correlação confiável**: nos 6 traços reais que existiam antes desta migração, 3 tinham ajuste registrado em `relatorio_injecao.json` mas **nenhuma** entrada correspondente em `ajustes_tracos.json` (nunca foi usado de verdade até agora). Pra esses, a migração colapsa original+ajustes num único total — o **total fica correto**, mas o histórico de "qual ajuste foi cada um" não é reconstruível com confiança (é a mesma ambiguidade que já discutimos: não dá pra saber se um ajuste de cimento e um de tempo de batida aconteceram juntos ou em momentos diferentes). Isso é uma limitação dos dados de origem, não algo que esta migração piora.
- **Reconstrução (`GET /db/relatorio_injecao.json`, `GET /db/ajustes_tracos.json`)**: cobre `dashboard.js` (Relatório de Injeção), o modal de Editar Traço, `LW.getAjustesTracos()`, e a tela de Backup de Dados — todos já faziam `fetch` direto, zero mudança no navegador.
- **`/registrar-relatorio-injecao`**: pra um traço novo, confia no `.original` que o navegador manda SE a tabela `ajustes` já tiver linha(s) pra esse `id_traco` (population ao vivo, via `/registrar-ajuste-traco`, durante a própria operação); só colapsa se não tiver — mesma regra da migração. Pra um traço reaproveitado (já existe), só adiciona o novo uso — réplica fiel do comportamento de sempre, mesma limitação preexistente inclusive (densidade/flow remedidos numa reutilização não são persistidos; já era assim antes, não é uma regressão).
- **`/importar-relatorio-injecao`**: a planilha não tem `id_traco` nem `id_operacao` reais — gera um `id_traco` sintético por linha. A planilha também nunca teve coluna de EPS mapeada (lacuna pré-existente, preservada).
- **Achado do teste de concorrência**: a numeração sequencial de `ajustes.ordem` usa `SELECT MAX(ordem)` seguido de `INSERT` — não é uma única operação atômica como o incremento do contador (Fase 4). Testado com 10 ajustes simultâneos no mesmo traço e nenhum colidiu, porque o Node é single-threaded e o driver do SQLite é síncrono — não existe uma forma de duas requisições entrelaçarem o SELECT de uma com o INSERT de outra dentro do mesmo processo. Isso deixaria de ser verdade se este servidor um dia rodasse em modo cluster (múltiplos processos Node) — não é o caso hoje, mas vale lembrar se isso mudar.
- **Testado**: migração com dados reais (incluindo a checagem de colapso acima, comparando TOTAIS — não só estrutura — entre o arquivo original e o reconstruído), o fluxo completo ao vivo (ajuste antes do traço existir → registrar → confiar nos ajustes já gravados), reaproveitamento (só adiciona uso, não toca no resto), edição completa de traço (identificação, uso específico, ajustes substituídos por inteiro, densidade/flow), importação de planilha, restauração de backup substituindo as 4 tabelas de uma vez, e os dois cenários de concorrência acima.

### Migração concluída

As 5 fases estão feitas — `public/db/` só guarda mais `config.json` e `operacao_andamento.json` (`security.json` saiu de `public/db/` numa mudança separada — ver *Autenticação e Sessão*, abaixo). Tudo que crescia sem limite e tinha risco real de concorrência agora é SQLite. Ainda falta rodar isso de verdade no servidor de produção (`npm install` lá, já que o `better-sqlite3` não instala neste ambiente de desenvolvimento — ver "Limitação conhecida da instalação", acima) e confirmar a migração automática com os dados reais de produção.

**Atenção pra quem escrever as queries de total, na Fase 5**: `original + SUM(ajustes.campo)` só dá o valor certo com `COALESCE` dos **dois** lados — `COALESCE(original, 0) + COALESCE(SUM(ajustes.campo), 0)`. Sem o primeiro `COALESCE`, um traço cujo insumo nunca foi preenchido (`original` NULL) faz a soma inteira virar `NULL` (regra do SQL: `NULL + qualquer coisa = NULL`), mesmo tendo ajustes reais somados. Validado durante o desenvolvimento, com teste isolado, antes de chegar a valer pra alguma rota de verdade.

**Limitação conhecida da instalação**: `better-sqlite3` compila um módulo nativo na instalação (`npm install`) — normalmente automático, mas se o `npm install` falhar por falta de binário pré-compilado pra sua versão exata do Node, o fallback é compilar do código-fonte, o que exige ferramentas de build (`build-essential`/`python3` no Linux) e acesso de rede pra baixar os headers do Node. Em ambientes com rede restrita, isso pode falhar — use `npm install` (nunca `npm ci`) na primeira vez depois de puxar essa mudança, já que o `package-lock.json` ainda não tem a entrada de `better-sqlite3` resolvida de verdade.

## Fatiamento de db.js

`db.js` tinha 3.353 linhas — cresceu por fases (ver "Banco de Dados (SQLite)", acima) sem nunca ser reorganizado depois, então misturava schema, migrações de JSON legado e regras de negócio de domínios sem nenhuma relação entre si (traço, manutenção, sessão de usuário) num arquivo só. Isso foi **concluído** (Fases 2–9, ver Status ao final desta seção), seguindo o mesmo padrão já validado no fatiamento de `server.js`: um domínio por vez, sem mudar lógica nenhuma — só onde o código mora —, com a suíte de testes daquele domínio (e uma bateria manual das rotas que o usam) rodando verde antes de seguir pra próxima fase. Hoje `db.js` tem só schema/setup do banco (Fase 1) e a migração de histórico legado ainda não movida (Fase 10, ver Status).

**Diferença importante em relação ao fatiamento de `server.js`**: `db.js` não é só um conjunto de funções — o módulo inteiro **é** a conexão viva com o SQLite (`module.exports = db`, o objeto de conexão do `better-sqlite3`, com as funções de cada domínio "penduradas" nele). Cada módulo extraído vai precisar **receber** essa conexão já aberta (via factory, mesmo padrão de `lib/rotas/`) em vez de abrir a própria — só existe uma conexão com o banco no processo inteiro, isso não muda.

Só um lugar no projeto faz `require('./db.js')` hoje (`server.js`) — o que reduz bastante o risco de qualquer fase aqui: mudar a organização interna de `db.js` não exige tocar em `lib/rotas/*` nem em nenhum outro consumidor, só no que `server.js` importa de onde.

| Fase | Domínio | Funções (exemplos) | Linhas aprox. hoje | Risco |
|---|---|---|---|---|
| 1 | Schema + setup do banco (infraestrutura, sem lógica de domínio) | `CREATE TABLE`s, `_colunasDe` | 1–705 | — (fica em `db.js`, é a base de tudo) |
| 2 | Manutenção programada | `listarManutencaoProgramada`, `salvarManutencaoProgramada`, `marcarLembreteDiaEnviado` | 3042–3208 | Baixo — já bem isolada, boa cobertura de teste (`manutencao-programada-lembrete.test.js`) |
| 3 | Manutenção corretiva | `salvarManutencaoCorretiva`, `aceitarManutencaoCorretiva`, `solicitarRecusaManutencaoCorretiva`, `responderRecusaManutencaoCorretiva` | 2659–3041 | Baixo/Médio — isolada, mas com fluxo de estados (aceite/recusa) que merece atenção redobrada |
| 4 | Notificações push | `salvarPushSubscription`, `listarPushSubscriptionsDosUsuarios`, `removerPushSubscriptionMorta` | 3209–3284 | Baixo — pequena e isolada |
| 5 | Sessões (admin + usuário) | `criarSessaoAdmin`, `criarSessaoUsuario`, `limparSessoesExpiradas` | 3285–3353 | Baixo — pequena, mas sensível (autenticação); testar com atenção extra |
| 6 | Sobra de material + contador de traços do dia | `sobraParaRow`, `migrarSobraSeNecessario`, `migrarContadorTracosSeNecessario` | 1981–2107 | Baixo/Médio — migração de JSON legado embutida junto |
| 7 | Paradas | `paradaParaRow`, `rowParaParada`, `migrarParadasSeNecessario` | 1892–1980 | Baixo/Médio — migração de JSON legado embutida junto |
| 8 | Traços (ajustes, leituras, usos) | `todosOsTracos`, `substituirTracosEAjustes`, `mesclarTracosEAjustes`, `migrarRelatorioInjecaoSeNecessario` | 2108–2658 | Médio/Alto — é a maior fatia (~550 linhas), com a lógica de colapso original+ajustes citada na Fase 5 da migração SQLite; qualquer erro aqui afeta valor exibido pro usuário, não só onde o código mora |
| 9 | Operações / berços / avaliação de qualidade | `detalheOperacao`, `relatorioBercos`, `correlacaoTracoBerco`, `salvarAvaliacaoQualidade`, `marcarOperacaoAvaliada` | 1003–1798 | Alto — é o núcleo do sistema (tela mais usada do dia a dia), com bastante entrelaçamento entre operação e avaliação de qualidade; extrair por último, com o máximo de cobertura de teste já validada nas fases anteriores |
| 10 | Migrações de histórico legado (JSON → SQL, já concluídas) | `migrarHistoricoSeNecessario` | 1799–1889 | — (candidato a mover pra `lib/migracoes/` ou remover, se já não for mais necessário rodar em produção) |

Ordem pensada do **menor pro maior risco** (mesmo critério usado no fatiamento de `server.js`): começar pelos domínios pequenos e isolados (manutenção, push, sessão) pra validar o padrão de extração com `db.js`, e deixar Traços e Operações/Qualidade — os maiores e mais centrais — por último, quando o processo já estiver rodado (e testado) várias vezes.

**Status:** Fases 2 a 9 concluídas e mescladas — Manutenção Programada (`lib/db/manutencao-programada.js`), Manutenção Corretiva (`lib/db/manutencao-corretiva.js`), Notificações Push (`lib/db/notificacoes-push.js`), Sessões (`lib/db/sessoes.js`), Sobra + Contador de Traços (`lib/db/sobra-contador-tracos.js`), Paradas (`lib/db/paradas.js`), Traços (`lib/db/tracos.js`) e Operações/Berços/Qualidade (`lib/db/operacoes-qualidade.js`). Falta só a Fase 10 (migrações legadas já concluídas, candidata a mover/remover).

**Nota sobre a Fase 8**: extraiu `extrairOriginal`/`extrairAjustesNumericos`/`colapsarOriginalEAjustes`, `rowParaTraco`, `todosOsTracos`/`todosOsAjustesTracosJSON`, as 4 queries `SQL_INSERIR_*`, `migrarRelatorioInjecaoSeNecessario`, `substituirTracosEAjustes` e `mesclarTracosEAjustes` — mesma lógica, só mudou onde o código mora. `db.js` caiu de ~1.666 pra ~1.130 linhas. Os testes do domínio e os de backup/restauração/importação adjacentes (103 no total, ver bateria usada) continuam 100% verdes.

**Nota sobre a Fase 9**: além do range 1003–1798 citado na tabela acima, a extração levou junto duas migrações únicas que ficavam logo antes desse range (populam/corrigem `operacoes_avaliadas` e `avaliacoes_qualidade`, uma delas chamando `_vincularAvaliacaoAOperacao`) — mexiam nas mesmas tabelas e usavam uma função privada deste domínio, então iam junto por coesão, mesmo tecnicamente fora do range documentado. Fora isso, ordem inversa à tabela acima na prática (Fase 9 antes da 8) porque foi o que foi pedido; os testes do domínio (153) e os de backup/restauração/importação adjacentes (39) continuam 100% verdes.

## Perfis de usuário

Login em `login.html`: usuário + senha. O **perfil** de cada pessoa é definido no cadastro pelo Administrador (Configurações → Usuários) — quem loga não escolhe o próprio perfil, já entra direto com o que foi configurado.

O botão **"Entrar como Administrador"**, no topo da tela de login, continua separado: é a senha única mestra de sempre, sem cadastro, sem usuário — mesmo comportamento de antes.

**Modelo de permissões**: quase todas as ferramentas ficam abertas para **visualização** a qualquer perfil — o que muda por perfil é o poder de **editar/registrar**. Cada perfil só pode editar as áreas listadas abaixo; nas demais, a tela abre normalmente, mas em modo somente-leitura (formulários desabilitados, botões de salvar/excluir escondidos). O servidor valida de novo em cada rota de escrita — nunca confia só no que o navegador esconde.

| Perfil | Pode editar | O resto |
|---|---|---|
| **Operador de Injetora** | Ferramentas de registro de operação (Registrar Operação, histórico/traço), Registrar Paradas | Visualização |
| **Assistente de Qualidade** | Setor de Qualidade, Registrar Paradas | Visualização |
| **Encarregado** | Injetora + Qualidade + Paradas, e pode **abrir** um chamado de manutenção (não fechar) | Visualização |
| **Manutenção** | Manutenção completa (chamados, programada, almoxarifado, movimentações), Registrar Paradas | Visualização |
| **Supervisão** | Injetora + Qualidade + Paradas + Manutenção completa | Visualização |
| **Administrador** (perfil cadastrado) | Tudo — igual ao Administrador Master, inclusive Configurações completas | — |
| **Administrador** (senha mestra) | Acesso total, irrestrito | — |

O checkbox **"Pode iniciar/encerrar operações em Registrar Operação"** continua existindo por usuário (Configurações → Usuários) — só aparece pra quem tem a área de edição da Injetora sem já ser administrador (Operador de Injetora, Encarregado, Supervisão): mesmo tendo permissão de editar a ferramenta, ainda precisa dessa marcação específica pra efetivamente controlar uma operação em andamento (ver *Quem pode controlar operações*, abaixo).

**Configurações**: todo perfil vê só a aba **Atalhos de Teclado**. Só o perfil **Administrador** (cadastrado) tem acesso às demais abas (Dados, Usuários, Automação, Dados SQL, Backup/Restauração) — igual ao Administrador Master.

O mapa de permissões (páginas e áreas de edição) é definido num lugar só (`lib/perfis.js`) e validado tanto no front (esconde/desabilita controles de edição) quanto no back (cada rota de escrita confere de novo — nunca confia só no que o navegador mandou).

### Perfis customizados

Além dos 6 perfis fixos acima, o Administrador pode **criar novos tipos de perfil** em Configurações → Usuários → "+ Criar novo tipo de perfil" (ver `lib/itens-permissao.js`, `lib/perfis-customizados.js`, `lib/rotas/perfis-customizados.js`). Cada perfil customizado tem seu próprio mapa, item por item, sobre o catálogo inteiro (páginas, dashboards, sub-itens de Setor de Qualidade e Manutenção — inclusive as 4 seções do formulário de chamado corretivo — e "Outros"), marcando cada um como **Acesso Total**, **Apenas Visualizar** ou **Ocultar**. Item não marcado fica oculto por padrão (perfil novo é restritivo, ao contrário dos 6 fixos, que são "visualização aberta").

- **Enforcement real no servidor**: só as 5 áreas já validadas de verdade (injetora, paradas, qualidade, manutenção, manutenção-chamado) — marcar "Acesso Total" num item ligado a uma dessas áreas (ex: "Registrar Operação" → área injetora) concede a permissão de escrita de verdade, com a mesma validação server-side que os 6 perfis fixos já têm.
- **Itens de "Outros" — acesso real implementado**: Importar Documentos e Backup/Restauração eram os únicos genuinamente exclusivos do Administrador Master/perfil fixo "Administrador" no backend (`sessaoOuAdmin`/`temPoderesDeAdmin`) — agora usam um portão granular próprio, `podeUsarItem(req, itemId)` (`lib/permissoes-area.js`): concede acesso só pelo item específico marcado "Acesso Total" (perfil customizado, ou perfil fixo com override), sem tocar em nenhuma outra permissão administrativa (SQL admin, gerenciar usuários, dispositivos autorizados continuam intocados). As rotas de RESTAURAR/MESCLAR backup (destrutivas) continuam exigindo a senha do Administrador Master reverificada — não mudaram. Exportações Interativas/Excel e Edição dos Dados na verdade **nunca dependeram** desse portão pra valer de verdade (exportação roda no cliente; edição de dados já era protegida por `podeEditarArea('injetora')`, igual Registrar Operação) — só o front escondia a opção sem necessidade. Os 5 itens saíram da trava incondicional no formulário de criação de perfil (`_cpItemAindaExclusivoDoAdmin`, `public/js/perfis-customizados.js`); os botões correspondentes (Importar/Backup/Edição de Dados) agora checam a permissão real por item (`_perfilTemAcao`, `public/js/app-core.js`, alimentado por `itensAcaoPorPerfil` em `GET /perfis`) em vez do antigo `lw_role !== 'Administrador'` fixo. Abas de Configurações (exceto Atalhos) continuam travadas em "Ocultar" pra perfis customizados — isso sim ainda não tem ponte real no backend (rotas de SQL admin, salvar configurações, gerenciar usuários continuam checando só a IDENTIDADE do perfil, não o catálogo granular). Coberto por `test/perfis-customizados-itens-acao.test.js`.
- Perfis customizados não podem usar um nome já reservado (os 6 fixos, ou "Administrador"), nem duplicar o nome de outro customizado.
- Excluir um perfil customizado é bloqueado enquanto algum usuário cadastrado ainda o estiver usando.

A sessão de usuário cadastrado e a sessão do Administrador Master (cookies HttpOnly, `lib/sessao-usuario.js` e `lib/sessao.js`) duram ~10 anos — na prática "nunca expiram" (a pedido; eram 12h/30min antes). Ressalva: navegadores modernos limitam sozinhos o `Max-Age` de um cookie a ~400 dias (RFC 6265bis), então o cookie em si ainda cai depois de ~13 meses sem reautenticar, independente do valor configurado aqui — não é algo que o servidor consiga contornar.

**Atalhos de teclado por usuário**: cada usuário cadastrado tem seus próprios atalhos personalizados (Configurações → Atalhos de Teclado), persistidos no servidor associados ao cadastro (`GET`/`POST /meus-atalhos`, `lib/rotas/usuarios.js`) — a personalização segue a pessoa entre computadores, não fica presa a um navegador. O Administrador Master (sem usuário próprio) continua com os atalhos salvos só em `localStorage` deste navegador, como sempre foi.

A lista de atalhos exibida (em Configurações → Atalhos de Teclado e no modal de ajuda, F1) mostra só os atalhos das páginas que o perfil logado realmente acessa — um perfil sem acesso ao Setor de Qualidade, por exemplo, não vê os atalhos de lá (ver `lib/perfis.js` / `lib/perfis-customizados.js`, campo `page` em `NAV_CONFIG`/`ACTION_CONFIG`/`REFERENCIA_CONFIG`, `public/js/keyboard-shortcuts.js`). Atalhos globais (Sair, abrir Configurações, Debriefing do Dia, filtro/atualizar/exportar) continuam aparecendo pra todo mundo, já que vivem na topbar, compartilhada por todas as telas.

## Páginas

- **Registrar Operação** — fluxo de injeção: seleção de bateria/tipo de montagem, traços, tempos, atrasos, sobra de traço entre operações.
- **Desempenho Turnos** — KPIs e gráficos por turno.
- **Registro de Baterias** — histórico de operações, filtros, exportação Excel, colunas ocultáveis.
- **Relatório de Injeção** — traços por operação (inclusive reaproveitamentos, exibidos como uma linha por uso).
- **Qualidade dos Traços (CEP)** — estabilidade de receitas, frequência de ajuste por insumo, alertas.
- **Análise Operacional** — produção, atrasos, ranking de baterias, correlações.
- **Rastreabilidade** — busca por ID de Bateria/Operação/Traço; mostra a cadeia completa de reaproveitamento de um traço (origem e reaproveitamentos futuros) e as paradas que caíram na janela daquela operação. Estende a Análise Focada existente.
- **Metas** — progresso do mês (traços, m², OEE) contra alvos definidos pelo Administrador.
- **OEE** — ver seção dedicada abaixo.
- **Modo TV** (`tv.html`, fora da SPA principal) — painel fullscreen pra telão da fábrica: operação ao vivo, traços do dia, OEE, últimas paradas. Não exige login.
- **Menu Principal** — atalhos rápidos + (admin) Backup, Restauração e Importação.
- **One Page Report** — resumo executivo mensal de página única (Segurança, Produção, Refugo, Expedição + Assuntos Gerais), pensado pra imprimir/exportar como PDF. Ver seção dedicada abaixo.

Atalho `F1` abre o modal de ajuda com todos os atalhos de teclado disponíveis.

O app também funciona como **PWA** (manifest + service worker, cobrindo só a casca estática — HTML/CSS/JS/ícones, nunca dado de produção): dá pra "Adicionar à tela inicial" num tablet e abrir sem barra de endereço, com alguma tolerância a queda rápida de rede.

## Setor de Manutenção

Chamados corretivos, manutenção programada (agendamentos), almoxarifado (estoque de peças) e histórico de movimentações — 4 domínios, cada um com backend real em SQLite (`manutencao_corretiva`, `manutencao_programada`, `manutencao_estoque`, `manutencao_movimentacoes`, ver `db.js` e `lib/rotas/manutencao.js`). Antes vivia inteiro em `localStorage` do navegador (protótipo inicial) — sem sincronizar entre computadores, sem entrar em backup; agora sincroniza normalmente e entra tanto no Backup de Dados quanto no Backup Geral.

Pontos específicos desse domínio:
- **`autor_nome`/`autorNome`** grava automaticamente quem registrou (mesmo mecanismo de *Autoria automática de registro*, acima).
- **Estoque nunca é ajustado diretamente** — toda mudança de quantidade passa por uma movimentação (Entrada/Saída), numa transação que ajusta o saldo e grava o histórico juntos. Cadastrar uma peça nova com quantidade inicial grava só o registro histórico (sem duplicar o saldo — a quantidade já nasce certa no cadastro).
- **Excluir uma peça** remove também todo o seu histórico de movimentações (cascata manual, já que `foreign_keys` está ativado no banco).
- **Upload de foto/PDF** é funcional: imagens são comprimidas no navegador (redimensionadas pra no máximo 800×600, JPEG 70%) e PDFs são anexados sem compressão — ambos convertidos pra base64 e salvos direto nas colunas `foto_operador`/`foto_tecnico` do chamado (`previewArquivo()`/`compressImage()`, `public/js/manutencao-front.js`).
- Só `GET`/`POST` (nunca `DELETE`/`PUT`) — mesmo padrão do resto do sistema; exclusão/edição usam rotas próprias com o verbo no path (`/manutencao/excluir-corretiva`, `/manutencao/editar-estoque`), pra ficarem cobertas pela mesma proteção de tamanho máximo de corpo que `server.js` só aplica a `POST`.

## Notificações Push (Manutenção)

O servidor dispara uma notificação Web Push pra todo mundo cujo perfil tem a permissão marcada em 3 momentos do fluxo de um chamado corretivo — funciona tanto em PC quanto em celular (Android: qualquer navegador; iOS: só com o app adicionado à Tela de Início, Safari 16.4+):

| Evento | Dispara quando | Item de permissão | Padrão de fábrica |
|---|---|---|---|
| **Abertura de chamado** | Chamado **NOVO** é aberto (`POST /manutencao/corretiva` sem `id` existente) | `manutencao-notificacao-abertura` | Quem edita a área `manutencao` (Manutenção, Supervisão, Encarregado, Administrador, Operador de Injetora) |
| **Pedido de peça** | Chamado **já em execução** (`situacao='Em Manutencao'`) é salvo com `aguardandoPecas` passando pra `'Sim'` | `manutencao-notificacao-pedido-peca` | Supervisão, Encarregado, Administrador |
| **Peça recebida** | Chamado é salvo com `statusCompra` passando pra `'Peça recebida'` | `manutencao-notificacao-peca-recebida` | Manutenção, Supervisão, Encarregado, Administrador |

Em todos os casos: só dispara na **transição** de estado (nunca de novo em saves subsequentes do mesmo chamado já naquele estado), e quem causou o evento (quem está logado no momento) nunca recebe a própria notificação.

- **Permissão** — cada evento acima tem seu próprio item no catálogo de permissões (`lib/itens-permissao.js`), dentro de Manutenção → Corretiva. Igual a qualquer outro item do catálogo, é configurável perfil a perfil (fixo ou customizado) em Configurações → Usuários → engrenagem ⚙️, ou de forma mais direta em **Configurações → Notificações** (tela dedicada só com esses 3 toggles, ver `public/js/notificacoes-config.js`). `Acesso Total` = recebe a notificação; `Apenas Visualizar`/`Ocultar` = não recebe — mas o Administrador pode mudar isso a qualquer momento, perfil a perfil.
- **Ativar no dispositivo** — botão 🔔 na barra superior (só aparece logado e com o navegador suportando Web Push); pede permissão de notificação do navegador e inscreve o dispositivo (`lib/notificacoes-push.js`, `public/js/notificacoes-push.js`). Cada pessoa pode ativar em vários dispositivos ao mesmo tempo (PC do chão de fábrica + celular pessoal, por exemplo).
- **Envio** — Web Push padrão (VAPID), sem depender de nenhum serviço de terceiro; chave gerada na 1ª subida e guardada em `private/vapid-keys.json` (fora do git). Disparo é *fire-and-forget*: uma falha ou demora no envio nunca atrasa nem quebra o salvamento do chamado em si; inscrições que o próprio serviço de push confirma como mortas (404/410) são removidas automaticamente.
- **Rotas**: `GET /push/config` (chave pública + se há sessão), `POST /push/inscrever`, `POST /push/desinscrever` (ver `lib/rotas/notificacoes.js`).
- **Exige HTTPS** (ou `localhost`) — exigência da própria Web Push API do navegador, não do código deste projeto: em HTTP simples o navegador nem expõe `navigator.serviceWorker`/`PushManager`, então o sino de notificações fica escondido (ver `_suportado()`, `public/js/notificacoes-push.js`). Se a instalação roda numa VM sem domínio/HTTPS (ex: acessada só pelo IP), veja a seção **HTTPS via Caddy + nip.io**, logo abaixo.
- **Diagnóstico** — `node scripts/diagnosticar-push.js [usuário]` confere de uma vez: chaves VAPID, permissão de notificação de cada usuário cadastrado e quais dispositivos têm inscrição salva.

### HTTPS via Caddy + nip.io (VM sem domínio próprio)

Notificações Push só funcionam sob HTTPS (ou `localhost`) — se o sistema é acessado só pelo IP da VM (`http://34.123.45.67:5000`, por exemplo), o navegador esconde o sino 🔔 porque a API nem fica disponível. `deploy/instalar-https.sh` resolve isso colocando o [Caddy](https://caddyserver.com/) (servidor com emissão automática de certificado Let's Encrypt) na frente do Node, usando o [nip.io](https://nip.io) — um serviço de DNS público e gratuito que resolve `A-B-C-D.nip.io` pro IP `A.B.C.D` automaticamente, sem precisar cadastrar nem comprar domínio nenhum.

**Pré-requisitos**
- VM com o Lightwall já rodando (`npm start`, ver *Como rodar*) — o script assume que o Node está escutando em `localhost` numa porta (padrão `5000`).
- Portas **80** e **443** liberadas na VM (necessário pro Let's Encrypt validar o domínio e emitir o certificado):
  - **Locaweb Cloud**: painel → Rede → sua VM → **Port Forwarding** (não "NAT Estático" — esse libera a VM inteira, todas as portas, por padrão) → adicione regras pras portas 22 (SSH), 80 e 443 apontando pra VM. A Locaweb Cloud é construída sobre Apache CloudStack: o IP público não fica direto na VM, ele é alocado à parte e você decide quais portas encaminhar.
  - **Magalu Cloud**: Console → Virtual Machine → sua instância → Segurança/Security Group → adicionar regra de entrada (ingress) TCP 80 e 443, origem `0.0.0.0/0`. Por padrão a Magalu Cloud bloqueia todo tráfego de entrada — sem essa regra o Caddy nem consegue validar o domínio.
  - **Google Cloud**: Console → VPC network → Firewall → criar/editar regra permitindo `tcp:80,443` de `0.0.0.0/0`.
- Acesso root/sudo na VM.

**Passo a passo**
1. Acesse a VM via SSH.
2. Dentro da pasta do projeto, rode:
   ```bash
   sudo bash deploy/instalar-https.sh [porta-do-node]
   ```
   `[porta-do-node]` é opcional — padrão `5000` (mesma porta padrão de `server.js`). Só informe se o `PORT` estiver configurado com outro valor.
3. O script faz tudo sozinho:
   - Descobre o IP externo da VM (tenta Magalu Cloud, depois Google Cloud, depois um serviço externo genérico — esse último é o que funciona na Locaweb Cloud, já que lá o IP público não fica direto na VM; ver `deploy/instalar-https.sh`). Se nada responder, pergunta manualmente.
   - Instala o Caddy (repositório oficial via `apt`).
   - Gera `/etc/caddy/Caddyfile` apontando `SEU-IP-COM-HIFENS.nip.io` → `localhost:PORTA` (ver `deploy/Caddyfile.exemplo` pra um modelo de referência, caso prefira editar manualmente).
   - Recarrega o Caddy — ele mesmo emite e renova o certificado HTTPS automaticamente, sem passo manual nenhum.
4. Ao final, acesse `https://SEU-IP-COM-HIFENS.nip.io` (ex: IP `34.123.45.67` → `https://34-123-45-67.nip.io`) — deve aparecer o cadeado do navegador. A URL antiga (`http://SEU-IP:5000`) para de ser usada.
5. Peça pra cada pessoa clicar em "Ativar notificações" (🔔) de novo — inscrições feitas sob HTTP simples nunca existiram de verdade pro navegador, então não migram sozinhas.

**Depois de instalado**
- Pra reaplicar mudanças manuais no `/etc/caddy/Caddyfile`: `sudo systemctl reload caddy`.
- Pra ver status/logs do Caddy: `sudo systemctl status caddy` / `sudo journalctl -u caddy -f`.
- O certificado renova sozinho (Caddy cuida disso) — nenhuma tarefa cron extra é necessária.
- Rodar o script de novo é seguro (idempotente): ele reinstala o Caddy se preciso e regrava o `Caddyfile` do zero com o IP atual.

## Autoria automática de registro

Registrar Operação, Registro de Paradas e Avaliações do Setor de Qualidade gravam automaticamente **quem registrou** (`operador_nome`/`avaliadorNome`) — não é login nem controle de acesso, é só um rótulo de auditoria (`LW.nomeDeQuemEstaLogado()`, `data.js`). O nome vem de quem já está logado no sistema (usuário cadastrado — ver *Perfis de usuário*) ou `"ADM"` para o Administrador Master (senha mestra, sem usuário próprio). Ninguém precisa escolher/confirmar identidade separadamente — substituiu a antiga "Identidade Leve de Operador" (perguntava PIN à parte do login, toda vez que algo era registrado).

Numa correção/edição de um registro já existente (parada, avaliação de qualidade), o autor **original** é preservado — corrigir um detalhe não troca a autoria pra quem só corrigiu.

## Ajuste de Receita (Registrar Operação)

Sempre que um insumo (cimento, água, EPS, superplastificante ou incorporador de ar) precisa ser **adicionado** a um traço já em andamento, o tempo de batida extra necessário pra misturar esse adicional tem que ser informado **junto**, na mesma ação — caso contrário a tela de Registrar Operação acusa pendência e bloqueia o registro da operação.

Por isso, insumo e tempo de batida não têm mais painéis de ajuste separados: o botão "+" de qualquer um dos 5 insumos, e o botão "+ Ajuste de Receita" do tempo de batida, abrem a mesma tela:

- **Tempo de Batida Adicionado (minutos)** — sempre obrigatório.
- **Foi adicionado algum insumo neste ajuste?** — se marcado, abre os campos dos 5 insumos (preenche-se só os que de fato foram adicionados); se desmarcado, é um ajuste só de tempo de batida (ex: "só precisa bater mais um pouco", sem ter colocado nada a mais).

Campos de **resultado medido** (Densidade do traço, Flow) continuam com o painel simples de sempre — ali é uma remedição, não uma adição, então não exige tempo de batida.

Cada ajuste salvo também é registrado em `ajustes_tracos.json`, indexado pelo `id_traco`, com uma chave `ajuste_N` por ajuste (numeração sequencial e contínua por traço, decidida pelo servidor — inclusive entre reaproveitamentos do mesmo traço em operações diferentes):

```json
[
  {
    "id_traco": "traco_1781888111000_0",
    "ajuste_1": { "tempo_batida": 2, "cimento": 50, "registrado_em": "2026-06-23T18:34:08.445Z" },
    "ajuste_2": { "tempo_batida": 1.5, "registrado_em": "2026-06-23T18:34:08.457Z" }
  }
]
```

Esse arquivo é só um log de auditoria (qual ajuste veio com qual tempo de batida) — **durante a operação em si**, não substitui nem altera os campos `*_real`/`tempo_batida` de cada traço (em `historico.json`/`relatorio_injecao.json`), que continuam funcionando exatamente como antes. Isso muda ao **editar** um traço já registrado — ver seção dedicada, abaixo.

**Um campo preenchido só via ajuste conta como preenchido.** Bug relatado: Flow/Densidade preenchidos exclusivamente pelo painel de Remedição (sem nunca ter um valor original) apareciam certinho na tela, mas a checagem de pendência só olhava o valor original — o traço ficava marcado como pendente mesmo com o dado visivelmente lá, bloqueando "Registrar". Corrigido: `tracoCompleto()`/`_statusDoTraco()` (`operacao.js`) agora consideram um insumo preenchido se tiver valor original **ou** pelo menos 1 ajuste — mesmo critério que `totalInsumo()` já usava pra decidir o que mostrar na tela.

## Faixa de Berços (Registrar Operação)

Berço Início e Berço Fim de cada traço são validados (`_erroBercos()`, `operacao.js`), com borda vermelha + mensagem inline no campo, em tempo real (a cada tecla, não só no próximo re-render):

- Início e fim precisam ser **maiores que zero** — não aceita 0 nem negativo.
- Fim não pode ser **menor** que início (pode ser igual — um traço cobrindo 1 berço só).
- O início de um traço não pode ser **menor** que o fim do traço **anterior** — mas pode ser **igual**, de propósito: um berço pode ter ficado pela metade, dividido entre os dois traços.

Reforçado em 2 lugares: um item dedicado no painel de pendências ("Faixa de berços válida em todos os traços", bloqueia "Registrar") e dentro de `tracoCompleto()` (um traço com berços inválidos nunca conta como completo, mesmo com o resto preenchido).

## Montagem Personalizada (Registrar Operação)

Além de **Simples** (todos os berços do mesmo tipo) e **Híbrida** (cada berço produz painéis de 2 tipos ao mesmo tempo, numa proporção fixa), existe **🔧 Personalizado**: cada berço da bateria tem seu próprio tipo, escolhido individualmente — pra baterias que misturam tipos em quantidades quaisquer (ex: 4 berços de 3T, 5 de S/P, 7 de 2/P e o resto de 1T).

Ao escolher "Personalizado" em Tipo de Montagem, abre a grade de berços:

- Abas no topo com cada tipo **simples** já cadastrado em Configurações → Baterias e Montagem (cores reaproveitadas das que cada tipo já tem).
- Selecione um tipo, depois clique nos berços (pinta na hora) ou use **"De [ ] até [ ] — Aplicar"** pra um intervalo inteiro de uma vez.
- Berço sem tipo definido = vazio/não usado — não entra em nenhum cálculo.
- O botão **"🔧 Configurar Berços"** (abaixo do select) reabre a grade a qualquer momento, preservando o que já foi preenchido.

**Reconciliação ao Registrar**: o número de berços com tipo definido na grade precisa bater com "Berços Reais". Se não bater:
- **Mais berços com tipo do que "Berços Reais"** diz → pergunta se houve berço não usado nesta operação. Se sim, reabre a grade só pra marcar quais (sem abas — qualquer clique ali só limpa o berço). Se não, "Berços Reais" sobe pra bater com o que está preenchido.
- **Menos berços com tipo do que "Berços Reais"** diz → faltam berços sem tipo — reabre a grade completa (com abas) pra terminar de preencher; não dá pra registrar até completar.

**Compatibilidade**: `tipo_montagem` é gravado como `"PERSONALIZADA"` (um valor fixo, pra continuar agrupando junto nos filtros/gráficos que já existem — OEE, Análise Operacional, Registro de Baterias), com o detalhe berço a berço guardado à parte em `bercos_personalizados` (um array, um item por berço, ex: `["3t","3t","sp",null,...]`). Os totais (`paineis_por_tipo`, `m2_por_tipo`, `placas_cimenticia`) são somados a partir dessa grade e ficam no mesmo formato que Simples/Híbrida já produzem — então nada no resto do sistema precisou de nenhuma mudança pra exibir/somar baterias Personalizadas corretamente (inclusive tipos novos tipo "1T", "3T": as colunas da tabela de Registro de Baterias e os gráficos por tipo já são dinâmicos).

**Limitação conhecida**: o badge de "Tipo de Montagem" pra uma bateria Personalizada usa a mesma cor neutra (cinza) de um tipo desconhecido — diferente de Simples/Híbrida, que têm cor própria. O detalhe da composição (quais berços, quais tipos) só fica visível olhando o registro completo (`bercos_personalizados`), sem uma visualização dedicada ainda.

## Consulta de Insumos por Traço

Tela **auxiliar** do Dashboard de Traço/CEP (`public/js/qualidade-tracos.js`) — pedido registrado numa conversa: sem alterar o dashboard existente, uma tela à parte pra consultar/comparar/exportar o consumo de insumos traço a traço (`public/partials/page-consulta-tracos.html`, `public/js/consulta-tracos.js`). Acessível pelo menu "Traços" da barra de navegação ou pelo botão "🔍 Consultar Insumos por Traço" dentro do próprio Dashboard de Traço (que já leva o período atualmente filtrado, sem precisar escolher tudo de novo).

**Fluxo**: escolher período → lista de traços daquele intervalo → clicar num traço → ver os insumos → exportar (o traço, ou o período inteiro) em Excel.

**Sem rota nova no backend** — reaproveita `db/relatorio_injecao.json` (mesma fonte do CEP e do Relatório de Injeção); filtro por data, cálculo de "ordem no dia" e totais são feitos 100% no cliente.

**"Ordem no Dia" em vez de "Horário de produção"** — decisão tomada na mesma conversa: o sistema nunca gravou (e ainda não grava) um horário por TRAÇO individual, só o horário de início/fim da OPERAÇÃO inteira (a bateria toda — colunas `inicio`/`fim` de `operacoes`). Mostrar uma hora ali seria inventar precisão que não existe; em vez disso, cada traço recebe sua posição de produção dentro do dia (1º, 2º, 3º...), assumindo que a ordem de chegada em `db/relatorio_injecao.json` reflete a ordem real de registro (a query que gera esse JSON, `todosOsTracos()` em `lib/db/tracos.js`, não tem `ORDER BY` — volta na ordem de inserção do SQLite). Essa premissa é testada diretamente (`test/consulta-tracos-ordem-insercao.test.js`: registra traços em sequência conhecida e confere que voltam na mesma ordem).

**Detalhe de 1 traço** (modal, versão bem mais simples que a Análise Focada, de propósito — só os insumos, sem berços nem movimentação): Cimento, Água, EPS, Superplastificante, Incorporador de Ar, e o total somado.

**Exportação Excel** (SheetJS/`window.XLSX`, mesma lib já usada em `setor-qualidade.js`):
- **Período inteiro**: 1 linha por traço (Data, Ordem no Dia, Turno, Nº do Traço, os 5 insumos, Total) — cronológico, mais antigo primeiro (facilita somar/analisar na planilha).
- **1 traço só**: formato "ficha" (Campo/Valor), não a mesma tabela — é um registro individual, não uma lista pra somar.

**Permissão**: item próprio no catálogo (`consulta-tracos`, tipo `dashboard`) — não amarrado ao item do CEP (`qualidade-tracos`); um Administrador pode liberar um sem o outro, se fizer sentido pro perfil.

Cobertura de testes em `test/consulta-tracos-logica.test.js` (cálculos/ordenação/formato de exportação, funções puras) e `test/consulta-tracos-ordem-insercao.test.js` (premissa de ordem de inserção, ponta a ponta via API).

## Editar Traço (Relatório de Injeção)

Em **Menu → Relatório de Injeção → ✏️ Editar** (Administrador): liga um modo de edição — clicar numa linha abre a edição completa daquele traço, em vez do painel de detalhe de ajustes. Mesmo padrão visual do "✏️ Editar" do Registro de Baterias.

Dá pra editar **tudo**:
- Identificação do traço (Nº, Densidade EPS, Silo, Expansão).
- Dados **deste uso específico** (qual bateria, berço início/fim, observações) — só a entrada clicada dentro de `ultilizado.operacao[]`; outros usos/reaproveitamentos do mesmo traço não são afetados.
- O valor **original** (planejado) de cada um dos 5 insumos e do tempo de batida.
- Cada **ajuste individual** já aplicado — pode editar, remover ou adicionar, exatamente como a tela de detalhe (▾) já mostra.
- Densidade e Flow — valor original + cada leitura/remedição.

**A virada importante**: a partir de uma edição por aqui, `ajustes_tracos.json` passa a ser a **fonte de verdade** dos ajustes daquele traço — os campos `*_real`/`tempo_batida` de `relatorio_injecao.json` (a parte `.ajustes[]` de cada um) são **sempre recalculados no servidor** a partir da lista de ajustes editada, nunca aceitos prontos do navegador. Isso resolve o problema de hoje (os arrays de cada campo crescem cada um por conta própria, sem nenhuma correlação entre eles, então não dá pra saber com certeza "qual ajuste de cimento aconteceu junto com qual ajuste de tempo de batida") — a partir da primeira edição de um traço, os dois arquivos passam a ficar garantidamente consistentes entre si. Densidade e Flow não entram nessa derivação (não fazem parte de `ajustes_tracos.json` — são remedições simples, com sua própria lista de leituras).

Unidade: o formulário sempre usa **minutos** pro tempo de batida (igual a `ajustes_tracos.json`); o servidor converte pra **segundos** ao gravar em `relatorio_injecao.json` (igual ao fluxo ao vivo do Ajuste de Receita).

Se a lista de ajustes de um campo ficar vazia depois da edição, ele volta a ser um número simples em vez de `{original, ajustes}` — mesmo formato que um traço nunca ajustado.

Auditoria em `relatorio_edicoes.json` (mesmo padrão de `historico_edicoes.json`, indexado por `id_traco` + `id_operacao`) — por bloco de dados alterado (identificação, uso, originais, ajustes, densidade, flow), não campo a campo.

**Limitação conhecida**: igual à Edição de Operação, não há checagem de senha no servidor pra essa rota — a trava de "só Administrador" é só na tela (mesmo modelo de confiança já usado ali).

## Registro de Traço Descartado (Perda) — plano

**Objetivo**: hoje, quando um traço dá errado no meio da batelada (erro de dosagem, falha de equipamento, contaminação etc.) e precisa ser descartado, ele simplesmente não é registrado em lugar nenhum — os insumos foram consumidos de verdade, mas o sistema não sabe disso. A ideia é dar um jeito de registrar essa perda (o que foi gasto + o motivo), sem que esse traço vire uma operação, um traço "de verdade" no Relatório de Injeção, ou entre em qualquer cálculo que hoje assume que todo traço em `tracos` representa produção real.

**Por que não é só mais uma linha na tabela `tracos`**: um traço sem nenhum uso vinculado (`ultilizado.operacao` vazio) já é um caso previsto pelo schema — não aparece no Registro de Baterias, na Análise Focada nem na exportação do Relatório de Injeção (todos esses são "por uso"; zero usos = zero linhas). **Mas** o painel de CEP do Setor de Qualidade (`public/js/qualidade-tracos.js`, `getTracosComFiltros`) busca **todos** os traços de `db/relatorio_injecao.json` (via `db.todosOsTracos()`) sem filtrar por uso, e soma isso em `totalTracos`, na Taxa de Acerto, no desvio por insumo e no ranking de receita mais instável. Inserir o traço perdido ali contaminaria esses indicadores — o processo não "errou" nesse caso, o traço nem chegou a ser usado numa bateria. Por isso este plano usa uma tabela e um endpoint **isolados**, isentos por construção (nenhuma tela hoje lê essa tabela), em vez de depender de lembrar de filtrar em todo lugar que lê `todosOsTracos()`.

### 1. Estrutura de dados — tabela `tracos_descartados`

Tabela nova, sem nenhuma relação com `tracos`/`traco_usos`/`ajustes`/`leituras_resultado`:

| Campo | Descrição |
|---|---|
| `id` | gerado, ex: `descarte_<timestamp>` |
| `data`, `turno` | mesmo padrão dos traços normais |
| `cimento`, `agua`, `eps`, `superplast`, `incorporador` | insumos efetivamente usados nesse traço perdido — números simples, sem a complexidade `{original, ajustes}` (não faz sentido remedir/ajustar um traço que foi descartado) |
| `tempo_batida` | opcional |
| `motivo` | texto livre, **obrigatório** (decisão tomada — ver "Perguntas respondidas", abaixo) |
| `registrado_por`, `device_id` | autoria, mesmo padrão de auditoria já usado no resto do sistema (ver *Autoria automática de registro*) |
| `registrado_em` | timestamp automático no servidor |

Sem `id_operacao` e sem equivalente a `ultilizado.operacao` — por definição esse traço nunca virou produto, não há elo com operação nenhuma.

### 2. Backend

- `lib/db/tracos-descartados.js` (novo, mesmo padrão factory de `lib/db/tracos.js`): cria a tabela (migração leve, mesmo estilo das outras tabelas novas), `inserirTracoDescartado`, `todosOsTracosDescartados`.
- `lib/rotas/tracos-descartados.js` (novo, mesmo padrão factory + `tentar(req, res, urlPath, queryParams)` do resto de `lib/rotas/`):
  - `POST /registrar-traco-descartado` — exige permissão de área `injetora` (mesma checagem de `/salvar-sobra`, ver `podeEditarArea`/`negarEdicao`); valida `motivo` não vazio (400 se vazio); grava e responde `{ ok: true }`.
  - `GET /db/tracos_descartados.json` — mesma estratégia de reconstrução a partir da tabela usada por `GET /db/sobra.json`.
- **Backup**: entra no ciclo de Restaurar/Mesclar Backup de Dados (ver *Backup e Restauração*) do mesmo jeito que `sobra` — senão um restore apaga esse histórico silenciosamente. Precisa de `substituirTracosDescartados`/`mesclarTracosDescartados` (mesmo padrão de `substituirTracosEAjustes`/`mesclarTracosEAjustes`, sem a complexidade de usos/ajustes por não existirem aqui) e um novo campo no payload de backup (`db.js`, junto de `tracos`/`ajustes`/`sobra`).
- **Não** entra em `todosOsTracos()`, `detalheOperacao()`, nem em nenhuma consulta hoje lida pelo CEP ou pela Análise Focada — isolamento por construção, não por filtro.

### 3. Frontend

- **Ponto de entrada** (decisão tomada — ver "Perguntas respondidas", abaixo): na tela de Registro de Traço/Relatório de Injeção (`public/js/operacao.js`), perto de onde o operador lança os insumos de cada traço, um link discreto **"⚠️ Descartar este traço"**.
- Ao clicar, abre um **formulário simples dedicado** (modal, não a tela cheia de Registrar Operação): os campos de insumo já preenchidos pelo operador para aquele traço vêm pré-carregados (evita digitar tudo de novo), turno/data preenchidos automaticamente, e um campo de texto livre obrigatório para o motivo.
- Ao salvar (`POST /registrar-traco-descartado`): o traço desaparece da lista de traços pendentes da operação atual — não vira uma linha "pendente" nem exige berço início/fim (não tem berço, não encheu nada).
- Fetch correspondente em `public/js/data.js`, seguindo o mesmo padrão dos demais.

### 4. Tela de histórico ("Traços Descartados") — implementada

Estava listada como "fora de escopo" na versão original deste plano — decisão deliberada de não vazar o dado pra dentro de um dashboard já existente antes de decidir **onde** ele deveria aparecer. Decisão tomada depois: **tela nova e dedicada**, só leitura (sem editar/excluir — um traço descartado nasce e morre no ato do registro).

- **Menu Principal** (`public/partials/page-menu.html`) e **tabbar** (`public/partials/nav-tabbar.html`): novo item "Traços Descartados", logo depois de "Registro de Paradas".
- **Página** (`public/partials/page-tracos-descartados.html` + `public/js/tracos-descartados-lista.js`, novo módulo, mesmo padrão de `paradas.js`): KPIs simples (total de descartes + soma de cimento/água/EPS perdidos no período filtrado — de propósito SEM desvio-padrão, taxa de acerto ou ranking, pra não virar um "CEP" disfarçado), filtro por data e por busca livre (motivo/operador), tabela com todos os campos.
- **Permissão**: página liberada pra visualização de todos os perfis (`PAGINAS_DE_TRABALHO`, `lib/perfis.js`) — mesmo modelo do resto do sistema ("quase todas as páginas são abertas pra visualização por todos"; a escrita já é protegida por área `injetora`, ver passo 2).
- **Isolamento continua intacto**: esta tela lê só `GET /db/tracos_descartados.json` — nenhuma linha de código dela toca `todosOsTracos()`, `qualidade-tracos.js`, `analise-focada.js` ou `dashboard.js`.

### 5. Fora de escopo (o que ainda fica pra depois)

- Qualquer tentativa de vincular um traço descartado a um "motivo padronizado" ou transformá-lo em indicador de qualidade automático (ver item 6, abaixo, sobre a decisão de motivo em texto livre — **decisão reavaliada nesta tarefa e mantida como está**: ainda não existe uso real suficiente pra saber quais opções fechadas fariam sentido; fechar uma lista agora seria chute, não dado. Continua em aberto pra quando houver histórico de verdade pra analisar).

### 6. Perguntas respondidas (registradas aqui para não se perderem)

- **Onde registrar**: atalho na tela atual de Registro de Traço, que abre um formulário dedicado simples (não uma tela cheia nova, nem só embutido inline na tela atual).
- **Formato do motivo**: texto livre (não lista padronizada) — decisão tomada para não travar o operador numa lista fixa nesta primeira versão; pode virar lista padronizada depois, se o texto livre gerado no uso real mostrar poucos padrões repetidos que valham a pena fechar em opções.

**Status**: passos 1 (estrutura de dados), 2 (backend), 3 (frontend de registro) e 4 (tela de histórico) concluídos. Passo 3: link discreto "⚠️ Descartar este traço" no card de cada traço (`public/js/operacao.js`, próximo à seção "Receita Real Pesada"), abrindo um modal dedicado com Data/Turno preenchidos automaticamente e os insumos já pesados pré-carregados; motivo em texto livre obrigatório; ao salvar, chama `LW.registrarTracoDescartado` (`public/js/data.js`) e remove o traço da lista de pendentes da operação atual (sem virar linha "pendente" nem exigir berço). Indisponível em Modo de Teste — a rota grava direto na tabela real, sem a distinção real/teste que outras rotas de registro têm; o link fica visualmente desabilitado nesse modo, com tooltip explicando o motivo. Passo 4: tela "Traços Descartados" (menu + tabbar), com KPIs de insumo perdido e filtro por data/busca — ver item 4, acima.

**Editar/excluir** (revisão desta decisão original — corrigir um valor digitado errado ou apagar um descarte lançado por engano é um caso real que apareceu depois): `POST /editar-traco-descartado` e `POST /excluir-traco-descartado` (`lib/rotas/tracos-descartados.js`, `lib/db/tracos-descartados.js`), mesma área de permissão do registro (`injetora`). `id`/`registrado_em` nunca mudam numa edição — só os campos de dado (insumos/motivo/turno/data/operador). Botões ✏/✕ na tabela do histórico, só pra quem tem a área liberada (`_perfilPodeEditar`, mesmo padrão de `paradas.js`).

**Exportação (CSV/PDF)**: dois botões na tela de histórico, respeitando o filtro atual (não sempre o histórico inteiro) — CSV mesmo padrão de `manutencao.js` (`;` como delimitador, aspas escapadas), PDF via o mesmo pipeline Chromium dos outros dashboards (`LW.baixarPdfApartirDeHtml`, `public/js/data.js`), sem o truque de "página única" do One Page Report (uma lista paginando normalmente não precisa forçar 1 folha só).

Cobertura de testes em `test/tracos-descartados-crud.test.js` (backend, criação + edição + exclusão) e `test/operacao-descarte-traco.test.js` (UI de registro, jsdom).

## Configuração (Administrador)

Em **Menu → Configurações**:

- **Baterias**: ID, dimensão e nº de berços.
- **Tipos de Montagem**, cadastrados de duas formas:
  - **Simples**: um tipo de placa (label + código + painéis/berço, máx. 2 — limite físico da operação) e se leva placas cimentícias (e quantas por painel). Recebe automaticamente uma cor própria (ver *Cor automática dos tipos de montagem*, abaixo), vinculada a ele pra sempre.
  - **Híbrida**: combina dois tipos *simples* já cadastrados, sempre 1 painel de cada (2/berço). A cimentícia é herdada automaticamente dos tipos simples que a compõem — não é perguntada de novo. Não tem cor própria: é sempre metade da cor de cada um dos 2 tipos que a compõem (ver abaixo).

Um tipo simples em uso por um híbrido não pode ser removido (a tela bloqueia e avisa quais híbridos dependem dele).

### Cor automática dos tipos de montagem

Cada tipo **simples** novo recebe uma cor gerada automaticamente — algoritmo *largest-gap hue allocation*: olha os matizes (hue) já usados pelos tipos existentes e escolhe o ponto no meio do maior "vão" livre entre eles, então cada cor nova fica o mais distante possível das já existentes, sem precisar redistribuir as anteriores. A cor é gerada uma única vez (na criação) e fica guardada como `corHue` na opção, em `config.json` — não é recalculada depois.

- Faixa de matiz limitada a 0°–300°, evitando de propósito a faixa de rosa/magenta (300°–360°).
- Saturação (60%) e luminosidade (52%) fixas, pra todas as cores terem o mesmo "peso" visual.
- Tipos **híbridos** não geram cor própria: aparecem sempre com a tela dividida 50/50 entre a cor de cada um dos 2 tipos simples que os compõem (gradiente CSS no HTML; gradiente real desenhado no `<canvas>`, que não entende a sintaxe `linear-gradient()` do CSS).
- Aparece em: badge de "Tipo de Montagem" no Registro de Baterias, gráfico "Montagem × Atrasos" da Análise Operacional, e uma bolinha de pré-visualização na própria tela de admin.

### Definir Paletes

Cada berço da bateria enche 2 painéis — um do lado **Direito**, um do lado **Esquerdo** — que vão pra paletes diferentes no Setor de Qualidade (Palete 01–04). Configurações → Bateria e Montagem → "Definir Paletes" deixa o Administrador escolher, com 4 selects, qual palete recebe cada **quadrante** (1ª/2ª metade da bateria × lado Direito/Esquerdo):

- Uma **prévia visual** (mesma grade de berços do card "Bateria Atual") mostra o resultado ao vivo, com abas pra cada dimensão de bateria cadastrada (18/20/22 berços etc.) — o rótulo `P{n}` no topo de cada célula é o lado Direito, embaixo é o Esquerdo.
- Validado como uma **permutação**: os 4 paletes (01–04) precisam ser usados exatamente 1 vez cada — não dá para dois quadrantes apontarem pro mesmo palete, nem deixar um de fora. Um erro inline aparece e bloqueia o salvamento até corrigir.
- Persistido em `config.json` (chave `paletes`) junto com o resto desta aba, mesmo botão "✓ Salvar Configurações" — sem essa chave (instalação anterior a esta funcionalidade), o sistema usa um valor padrão de fábrica.
- `_paletePorMetadeELado()` (`setor-qualidade.js`) lê esse mapeamento em tempo real — o direcionamento de painéis (`_paleteDoBerco`) se ajusta automaticamente a qualquer configuração escolhida. (Cada painel exibido na grade é rotulado com um índice simples 1..N, sempre recomeçando do 1 em cada palete — não mostra mais o nº do berço de origem; ver `renderStacks`/`renderMirror`, `setor-qualidade.js`.)

### Layout 2x2 dos pallets e arrastar-pra-trocar (Setor de Qualidade → Avaliação)

Os 4 pallets são exibidos em 2x2 (Pallet 2/Pallet 1 na 1ª linha, Pallet 3/Pallet 4 na 2ª), em vez de uma linha só — mesma ordem de exibição em Análise Focada e no Espelho Visual (histórico). Implementado via CSS `order` (`.sq-pallet-col[data-pallet-id]`, `setor-qualidade.css`) — o número/id de cada pallet (`stack1`...`stack4`) nunca muda de lugar no DOM, só a posição visual; o mapeamento berço→pallet ("Definir Paletes", Configurações) não é afetado.

**Arrastar-pra-trocar**: só no Setor de Qualidade (tela ativa) — Análise Focada e Espelho são histórico só-leitura, sem onde persistir uma troca de posição. Segurar o rótulo "PALLET N" e soltar em cima de outro pallet troca a posição visual dos dois (nunca as placas/dados — isso já existe à parte, arrastando uma placa individual). Usa um tipo de `dataTransfer` próprio (`application/x-lw-pallet`), nunca `text/plain` (já usado pelo drag de placa individual) — evita qualquer ambiguidade entre os dois gestos.

### Marcação de placas (Setor de Qualidade → Avaliação)

- **Adicionar**: clique normal numa placa sempre adiciona uma marca com a cor+forma selecionada na paleta — inclusive repetida (até **6 marcas por placa**; a 7ª tentativa mostra um aviso e não adiciona).
- **Apagar**: clique com o botão direito (mouse) ou toque e segure por ~500ms (touch) remove uma ocorrência da cor+forma *atualmente selecionada* — não precisa ser a última marcada, já que marcas idênticas são visualmente indistinguíveis entre si. Toque longo cancela se o dedo mover (evita conflito com scroll) ou soltar antes da hora.
- **"×" (painel não preenchido)** continua exclusivo: marcá-lo substitui qualquer marca real que já existisse na placa (inclusive a de identificação automática, abaixo), e marcar qualquer marca real remove o "×" que estivesse lá.
- **"🧹 Limpar" por pallet**: no cabeçalho de cada pallet, ao lado de "⚡ Todas" — apaga só as marcações daquele pallet (com confirmação). Substituiu o dropdown de seleção rápida de cor por pallet (🎨), que era redundante com "⚡ Todas" combinado com a paleta principal.
- O Desfazer geral (Ctrl+Z / botão "Desfazer") continua cobrindo a última ação em qualquer lugar da tela, sem mudança — o gesto de apagar acima é para remover uma marca específica, não necessariamente a mais recente.

**Identificação automática por tipo de montagem** (em teste): o sistema já sabe o tipo de cada placa (mesma fonte que mostra o texto "SP"/"2P"/etc. no canto dela, `getExpectedType`) — a marca que identifica esse tipo (mesma "combinação" de sempre, `combinacaoAvaliacao`/`COMBINACOES_PADRAO`) nasce sozinha, sem o operador precisar escolher nada, adiantando o trabalho. **A paleta continua completa** (5 cores + 3 formas, exatamente como sempre foi) — o preenchimento automático só poupa cliques no caso comum; o operador pode marcar, corrigir ou apagar qualquer combinação normalmente a qualquer momento, inclusive as marcas automáticas. Regenerada a cada reset da grade (troca de Tipo de Montagem, Espessura, pré-preenchimento — `_marcasDeIdentificacao`/`_preencherMarcasDeIdentificacao`, `setor-qualidade.js`), preservando qualquer validação que o operador já tenha dado.

- **Tipos de forma COMBINADA** (círculo+traço, ex: 3T/1T): só o **traço** (identificação, cor modificadora — amarelo/laranja) nasce automático; o **círculo** é sempre a marca de validação do operador, e entra **na frente** do traço (`unshift`, não `push`).
- **Tipos de forma ÚNICA** (círculo só = 2P, traço só = SP): **não recebem nada automático** — uma marca só já identifica tipo e status ao mesmo tempo, então não tem o que pré-preencher. O operador marca normalmente, na única forma daquele tipo.
- Avaliações antigas continuam lidas com a lógica de classificação de sempre, sem migração.

### Quem pode controlar operações

Antes, isso era controlado por uma lista de dispositivos autorizados (`deviceId`) em Configurações → Autorizados. Agora é decidido pela **sessão de usuário logado**: o Administrador Master e o perfil cadastrado "Administrador" sempre podem controlar; os demais perfis com a área de edição da Injetora (Operador de Injetora, Encarregado, Supervisão) só podem se o usuário específico tiver a permissão **"Pode iniciar/encerrar operações"** marcada no cadastro (Configurações → Usuários — só aparece pra perfis que já têm essa área liberada, ver *Perfis de usuário*). Perfis sem a área da Injetora (Assistente de Qualidade, Manutenção) nunca controlam operações, independente da marcação.

- Reforçado no **servidor**, não só escondido na tela: as rotas `/salvar-operacao-andamento`, `/registrar-operacao`, `/registrar-relatorio-injecao`, `/marcar-berco-andamento` e `/confirmar-tracos-hoje` recusam (HTTP 403) quem não tem essa permissão (`podeControlarOperacao()`, `server.js`).
- **Na tela** (Registrar Operação): quem não tem permissão vê um banner "🔒 Você está só acompanhando" e todos os campos/botões ficam desabilitados (`<fieldset disabled>` envolvendo a tela inteira, inclusive os traços renderizados dinamicamente). Reaplicado sempre que a aba é aberta — não precisa de F5 se o Administrador acabou de habilitar isso no cadastro.
- Atalhos de teclado (Iniciar/Encerrar/Registrar/Resetar) não dependem só do `<fieldset>` — cada uma dessas 4 ações também checa a permissão no próprio código, então um atalho não contorna a trava.

**Dono da operação** (quando há 2+ pessoas autorizadas a controlar): ter permissão não basta — a **primeira** pessoa autorizada a dar "Iniciar Injeção" numa operação vazia se torna a **dona** dela (`donoDeviceId`, identifica o computador dela; gravado em `operacao_andamento.json`, recalculado sempre no servidor — nunca confia no que o cliente manda). Enquanto a operação estiver rodando:
- Só a dona pode editar campos, encerrar ou registrar — outra pessoa autorizada tentando qualquer uma dessas ações recebe HTTP 409 ("já está sendo controlada por outra pessoa") e vê o banner "👀 Outra pessoa autorizada está controlando esta operação agora".
- **Escape hatch**: "🗑️ Limpar Tudo" funciona pra **qualquer** pessoa autorizada, mesmo sem ser a dona — é assim que se recupera uma operação travada por alguém que ficou offline, travou, ou esqueceu de encerrar. Limpar também libera a "dona" — o próximo a iniciar assume. O Administrador Master também pode cancelar de Configurações → Operação em Andamento, sem precisar estar com a tela de Registrar Operação aberta.
- O dono é zerado junto com a operação (registrar, resetar, ou forçar) — sempre há, no máximo, um dono por vez, nunca persiste entre operações.

**Revisão anti-atualização-atrasada**: o mecanismo de "dono" acima (baseado em `deviceId`, salvo no `localStorage`) não distingue **abas diferentes do mesmo navegador** — duas abas na mesma operação compartilham o mesmo `deviceId`, então nenhuma das duas é bloqueada pela outra. Pra evitar que uma atualização mais VELHA sobrescreva silenciosamente uma mais nova quando chega fora de ordem (ex: uma aba esquecida aberta mandando sua cópia desatualizada), cada broadcast leva um número de **revisão** atribuído pelo servidor (`_revisaoOperacaoAndamento`, `server.js` — só em memória, sempre crescente, nunca pelo cliente, pra relógios de dispositivos diferentes não brigarem). O cliente só aplica uma atualização recebida por WebSocket se a revisão for maior que a última aplicada (`_abrirWsOperacaoAndamento`, `data.js`) — a resposta HTTP de `POST /salvar-operacao-andamento` também devolve a revisão, já que o autor de uma mudança nunca vê o próprio eco via WebSocket. **Escopo**: isso resolve entrega fora de ordem (mensagem enviada antes chegando depois); não é uma solução completa de concorrência — se uma segunda aba tiver uma cópia desatualizada em memória e fizer uma edição própria baseada nela, o servidor ainda atribui uma revisão nova a essa escrita (aconteceu depois no tempo), mesmo que o conteúdo seja antigo.

**Limitação conhecida**: a sessão de usuário (cookie HttpOnly, dura ~10 anos na prática) identifica a pessoa, mas quem tiver acesso à sessão ativa dela (ex: navegador destravado) controla em nome dela — mesmo princípio de qualquer sistema de login por sessão. Isso fica mais relevante agora que a sessão praticamente não expira sozinha (era 12h) — o logout manual e o bloqueio de tela do dispositivo passam a ser a defesa principal contra isso, não mais o timeout automático.

### Identidade do dispositivo (deviceId)

O `deviceId` (usado em `dispositivosAutorizados`, Configurações → Dispositivos Autorizados, e como `donoDeviceId` de uma operação em andamento) tinha uma fraqueza: era gerado e guardado só em `localStorage`, então (1) sumia se os dados do navegador fossem limpos, e (2) — mais sério — qualquer pessoa conseguia abrir o DevTools em qualquer computador e rodar `localStorage.setItem('lw_device_id', '<id de um dispositivo já autorizado>')` pra se passar por um dispositivo autorizado sem estar nele de verdade.

Isso foi reforçado com um **cookie `HttpOnly`** (`lw_device_id`, ver `lib/dispositivo-cookie.js`): o servidor emite esse cookie na primeira visita de cada navegador. Por ser `HttpOnly`, JavaScript do navegador não consegue lê-lo nem escrevê-lo — só o próprio servidor. A partir daí, o servidor usa o **valor do cookie** (não mais o que o cliente manda por query string) como identidade real do dispositivo em `dispositivoAutorizado()`/`podeControlarOperacao()` (`server.js`) — o `deviceId` antigo baseado em `localStorage` continua existindo só como exibição (Configurações mostra o valor pra o Administrador copiar/autorizar; ver `GET /meu-device-id`, que expõe o valor do cookie em JSON já que HttpOnly impede o front de ler o cookie diretamente) e como fallback para clientes que não guardam cookie (ex: os testes automatizados, de propósito, pra isolar o que cada teste quer verificar).

Isso fecha o ponto (2) (não dá mais pra forjar via DevTools), mas não sozinho o ponto (1): limpar cookies também apaga o `lw_device_id`. Pra reduzir esse atrito sem reautorização manual, cada dispositivo autorizado também guarda o **IP** de quando foi autorizado (`ip`, em `config.json`); se um request chegar com um `deviceId` desconhecido mas do **mesmo IP** de um dispositivo já autorizado antes, o servidor religa automaticamente o cadastro ao novo `deviceId` (`religadoEm` fica registrado, pra auditoria) — cobre o caso comum de rede interna com IP fixo por máquina (chão de fábrica). Não é uma trava adicional, só um atalho de reconhecimento; um IP nunca visto antes continua exigindo autorização manual normalmente.

**Resolvido de vez** pelo Certificado de Dispositivo (mTLS), a seguir — sobrevive inclusive a limpar todos os dados do navegador, sem depender de IP nem de o Administrador reautorizar manualmente. Ativar (`deploy/ativar-mtls-caddy.sh`) é opcional — sem ativar, cookie + IP continuam sendo a única checagem, exatamente como hoje.

### Certificado de Dispositivo (mTLS)

Uma terceira via de reconhecimento, em paralelo às duas acima (nunca substitui, sempre reforça) — resolve os dois pontos de vez, inclusive sobreviver a limpar TODOS os dados do navegador: cada máquina recebe um **certificado de cliente TLS**, instalado uma vez no navegador/SO, que vive na camada de rede em vez de cookie/localStorage. Não é apagado limpando dados do navegador e não dá pra forjar via DevTools.

**Como gerar (Administrador Master ou perfil Administrativo)**: Configurações → Dispositivos Autorizados → seção "🔏 Certificado de Autorização" → dá um nome à máquina (ex: "PC Injetora 1") → "Gerar certificado". O servidor:

1. Gera (na primeira vez que isso acontece nesta instalação) uma **CA própria** — um par de chaves que assina os certificados de dispositivo — guardada em `private/ca-dispositivos/` (fora de `public/`, nunca servida pela web, mesmo tratamento de `security.json`/`usuarios.json`). A chave privada da CA nunca sai da VM.
2. Emite um certificado assinado por essa CA, empacota num arquivo `.p12` protegido por senha aleatória, e devolve o download — a senha só aparece nesta hora (não fica guardada em lugar nenhum depois; se for perdida, gere um certificado novo e revogue o antigo).
3. Registra o **serial** do certificado (informação pública por natureza — já vai em todo handshake TLS) numa lista em `config.json` (`certificadosAutorizados`), ao lado de `dispositivosAutorizados`.

**Instalar na máquina**: duplo-clique no `.p12` (Windows) → assistente de importação de certificado → Chrome/Edge já reconhece. Isso é o único passo manual por máquina — feito uma vez, nunca mais precisa reautorizar aquele computador, mesmo limpando cookies/localStorage.

**Ativar o reconhecimento no servidor** (só precisa rodar uma vez por instalação, depois do primeiro certificado gerado): `sudo bash deploy/ativar-mtls-caddy.sh` — copia o certificado PÚBLICO da CA pro Caddy confiar nele, e configura `client_auth` em modo **opcional** (`mode request` — nunca bloqueia quem não tem certificado instalado; é reforço, não substituição). O Caddy passa a repassar o serial do certificado apresentado pro Node via header `X-Client-Cert-Serial`, que `dispositivoAutorizado()` (`lib/dispositivo-autorizado.js`) passa a checar **antes** de deviceId/IP — se o serial bate com um certificado autorizado, o dispositivo é reconhecido direto, sem precisar de cookie nem de religar por IP.

**Revogar**: mesma UX de "Remover" que `dispositivosAutorizados` já tinha — botão "✕ Revogar" na lista de certificados emitidos. Sem infraestrutura de CRL/OCSP: o certificado continua tecnicamente válido/instalado na máquina, só para de autorizar a partir do momento em que sai da lista.

**Custo**: só vale a pena ativar (`ativar-mtls-caddy.sh`) se o atrito de reautorizar depois de limpar dados do navegador for um problema real — sem ativar, gerar certificados não muda nada no comportamento atual (cookie + IP continuam sendo a única checagem).

Cobertura de testes em `test/certificados-dispositivo-mtls.test.js` (emissão/listagem/revogação, e o ponto central: um request com o header `X-Client-Cert-Serial` autoriza o dispositivo sozinho, sem deviceId nem IP conhecido — o handshake TLS em si, feito pelo Caddy, não é testável aqui).

## Backup e Restauração (Administrador)

Um único card no menu ("💾 Backup e Restauração") abre um painel com todas as opções:

| Opção | O que faz |
|---|---|
| **Backup de Dados** | Baixa um `.zip` só com dados de produção (histórico, traços, paradas, avaliações de qualidade, manutenção etc. — 17 arquivos, alguns reconstruídos a partir do SQLite). Gerado no servidor. |
| **Backup Geral** | Baixa um `.zip` com dados de produção + `config.json` (baterias, tipos de montagem, automação) + `security.json`/`usuarios.json`/`operadores.json` (identidade e acesso — senhas sempre em hash). Gerado no servidor. Sem código-fonte (esse tem controle de versão próprio — ver Git). |
| **Restaurar Dados** | Sobrescreve os dados de produção a partir de um backup de dados. |
| **Mesclar Backup de Dados** | Soma (nunca substitui) operações/traços/paradas/traços descartados de um backup de **outra instalação** aos dados atuais — dedup automática por id. Filtro de data opcional (`filtroDataInicio`/`filtroDataFim`): pra trazer só um período do backup (ex: "só o dia 04/09"), preenchendo os dois campos com a mesma data — o resto do arquivo é ignorado, mesmo que fosse tudo registro novo. Sem o filtro, mescla o backup inteiro (comportamento de sempre). Coberto por `test/mesclar-backup-dados.test.js`. |
| **Restaurar Geral** | Sobrescreve dados de produção + config a partir de um backup geral. `security.json`/`usuarios.json`/`operadores.json` são **opcionais** — se o backup não os incluir (ex: veio de uma instalação mais antiga, sem esses arquivos), o cadastro atual de usuários/senha de administrador é **preservado**, não apagado. |
| **Backups Automáticos** | Lista os backups de dados diários gerados pelo servidor (ver abaixo), com link de download pra cada um. |

Toda restauração: exige a senha do administrador (reverificada no servidor), valida o formato de cada arquivo antes de gravar qualquer coisa, e salva automaticamente uma cópia de segurança do estado atual em `backups-seguranca/` (fora de `public/`, nunca servida pela web) antes de sobrescrever. A restauração geral pede também uma frase de confirmação (`RESTAURAR TUDO`).

`backups-seguranca/` cresce a cada restauração feita — não há limpeza automática; remova as mais antigas manualmente quando quiser.

### Backup automático diário

O próprio `server.js` gera um backup de dados todo fim de dia, sem depender de ninguém com o navegador aberto:

- Roda a partir das **23:50** (horário de Brasília) — checado a cada minuto, e também uma vez no boot do servidor (cobre o caso dele subir depois desse horário).
- **Só gera se houve pelo menos uma operação registrada em `historico.json` com a data de hoje** — evita gastar um dia de retenção com um backup essencialmente igual ao anterior, em dias que o maquinário não operou.
- Mantém sempre os **últimos 3 dias**: ao criar um novo, remove automaticamente o mais antigo se já houver 3.
- Arquivos ficam em `backups-automaticos/` (fora de `public/`, nunca servida como arquivo estático comum), nomeados por data: `backup-dados_AAAA-MM-DD.zip`.
- Acessível só pelas rotas dedicadas (`/backups-automaticos` e `/backups-automaticos/<nome>`) — essa pasta cresce e diminui sozinha, sem precisar de limpeza manual (diferente de `backups-seguranca/`).
- **Sincronizar com um backup manual (conversa que motivou a mudança)**: até aqui, backup manual (Dados/Geral) e o job automático diário eram 100% independentes — baixar um backup manual nunca afetava `backups-automaticos/`. Agora, depois de qualquer backup manual bem-sucedido, o front pergunta (`LW.mostrarConfirmacao`) se a pessoa quer que ESSE backup também vire o automático de hoje — nunca acontece sozinho. Se ela confirmar, `POST /sincronizar-backup-automatico` (`lib/rotas/backup.js`, `{ tipo: 'dados'|'geral' }`) sobrescreve `backup-dados_<hoje>.zip` com o MESMO conteúdo do manual (mesmo nome de arquivo — não cria um segundo) e reinicia a contagem de retenção de 3 dias a partir de agora; como o job agendado já pula o dia se o arquivo existir, ele não roda de novo mais tarde sobrescrevendo um "Geral" escolhido de propósito com um "Dados" simples. Coberto por `test/backup-sincronizar-automatico.test.js`.

## Migrando para outra VM (ex: Google Cloud → Locaweb Cloud/Magalu Cloud)

Roteiro pra trocar a VM que hospeda o sistema sem perder dado nenhum — usa o próprio **Backup Geral** (ver seção acima) como ponte entre as duas máquinas, em vez de copiar arquivo por arquivo na mão. `git clone`/`git pull` só traz **código**; os dados de produção (histórico, traços, avaliações, manutenção, config, usuários) vivem fora do controle de versão (`.gitignore`: `data/`, `private/`, `public/db/security.json` etc. — ver *Estrutura de pastas*) e por isso não vêm junto de um clone.

**1. Provisionar a VM nova**
- Imagem **Ubuntu 24.04 LTS** (ou mais recente disponível), tipo de instância conforme a carga (a mesma configuração de vCPU/RAM da VM antiga é um bom ponto de partida). Acesso Linux é só por **chave SSH** (sem senha) — cadastre sua chave pública na criação.
- Marque a opção de **IP público** (necessário pra acessar o sistema de fora e pro Let's Encrypt emitir o certificado HTTPS).
- Libere as portas 22 (SSH), 80 e 443 — o procedimento muda por provedor:
  - **Locaweb Cloud**: painel → Rede → sua VM → aloque um **IP Público** e configure **Port Forwarding** (não "NAT Estático") pras portas 22, 80 e 443 apontando pra VM. A Locaweb Cloud é construída sobre Apache CloudStack: o IP público fica separado da VM, você decide o que encaminhar pra ela — "NAT Estático" libera a VM inteira (todas as portas), evite pra não expor mais do que o necessário.
  - **Magalu Cloud**: Console → Virtual Machine → sua instância → Segurança/Security Group → adicionar regra de entrada (ingress) TCP 22/80/443, origem `0.0.0.0/0` (ou seu IP, pra 22). Por padrão a Magalu Cloud bloqueia todo tráfego de entrada.
- A porta do Node (`5000`) **não** precisa ficar exposta publicamente em nenhum dos dois — o Caddy é quem fica na frente, fazendo proxy pra `localhost:5000`.

**2. Instalar Node e trazer o código**
```bash
# Node 20 LTS (qualquer >= 18 serve, ver package.json "engines")
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

git clone <url-do-seu-repositorio>
cd teste-ligthwall
npm install
```

**3. Rodar como serviço (recomendado)**
`deploy/lightwall.service` é um modelo de serviço systemd — mantém o Node no ar sozinho (reinicia em crash, sobe no boot), sem depender de uma sessão SSH aberta (`nohup`/`tmux`) pra continuar rodando. Ajuste `User`/`WorkingDirectory` no arquivo e siga as instruções no topo dele:
```bash
sudo cp deploy/lightwall.service /etc/systemd/system/lightwall.service
sudo systemctl daemon-reload
sudo systemctl enable --now lightwall
sudo systemctl status lightwall   # confere que subiu
```
Alternativa mais simples (sem systemd): `npm start` dentro de um `tmux`/`screen`.

**4. HTTPS**
```bash
sudo bash deploy/instalar-https.sh
```
Detecta o IP público da VM automaticamente (ver *HTTPS via Caddy + nip.io*, acima — já atualizado pra reconhecer Magalu Cloud, Google Cloud, e um fallback genérico que cobre a Locaweb Cloud e qualquer outro provedor).

**5. Migrar os dados (na VM ANTIGA → depois na NOVA)**
1. Na VM antiga, ainda no ar: **Configurações → Backup e Restauração → Backup Geral** — baixa um `.zip` com produção + config + usuários/senhas (hash).
2. Acesse o sistema já rodando na VM nova (ainda com dados "de fábrica", vazios) e faça login com a senha padrão/inicial.
3. **Configurações → Backup e Restauração → Restaurar Geral** → escolha o `.zip` baixado no passo 1 → confirme com a frase `RESTAURAR TUDO`.
4. Confira uma tela com dado real (ex: Relatório de Injeção) pra confirmar que a restauração trouxe tudo.

**6. Depois de confirmar que a VM nova está 100%**
- Repita "Ativar notificações" (🔔) em cada dispositivo — a inscrição de Web Push é atrelada ao domínio/origem (o `SEU-IP.nip.io` muda com a VM), então as inscrições antigas não migram sozinhas (mesmo aviso da seção *HTTPS via Caddy + nip.io*).
- Se a instalação tinha o Backup Automático no Google Drive configurado (ver seção abaixo, ainda em plano), reconecte a conta na VM nova.
- Só desligue/exclua a VM antiga depois de confirmar que a nova está estável por alguns dias — mantenha os backups automáticos gerados por ela (`backups-automaticos/`) até ter certeza de que não vai precisar deles.

## Backup Automático no Google Drive (plano)

**Objetivo**: hoje os 3 backups automáticos diários (`backup-dados_AAAA-MM-DD.zip`, ver seção acima) só existem no disco do próprio servidor — se a máquina falhar, são perdidos junto. Pedido: em **Configurações → Backup e Restauração**, o Administrador conecta uma conta do Google (fluxo de autorização, não login/senha próprio) e, a partir daí, cada backup automático gerado também é enviado sozinho pro Google Drive dessa conta, sem precisar de ninguém com o navegador aberto.

**Decisão de desenho** (ver conversa que motivou este plano): a ideia original era "e-mail + código de confirmação enviado pelo sistema" — descartada porque confirmar um e-mail por código não dá, por si só, permissão de escrever no Drive de ninguém. Em vez disso, o fluxo usa a autorização OAuth2 padrão do Google ("Autorizar acesso ao Google Drive"): a mesma tela do Google já confirma o e-mail e concede a permissão de gravar arquivos, num passo só, sem o projeto precisar mandar e-mail nenhum (evita adicionar uma dependência nova só pra isso, tipo nodemailer/SMTP).

**Escopo de credencial**: uma única conta Google conectada por instalação (não por usuário do sistema) — mesmo modelo de `security.json` (uma credencial de administração, não por perfil). Guardada em `private/` (fora de `public/`, nunca servida por URL), no mesmo espírito de `SECURITY_PATH`/`USUARIOS_PATH` já existentes.

### 1. Projeto no Google Cloud (fora do código, manual, uma vez) — PENDENTE

- Criar um projeto no Google Cloud Console, ativar a **Google Drive API** e configurar a tela de consentimento OAuth (modo "Externo", sem submeter pra verificação do Google — uso interno, então a pessoa vê o aviso "app não verificado" na 1ª autorização e segue por "Avançado", como já combinado).
- Gerar um **Client ID** e **Client Secret** OAuth2, com URI de redirecionamento apontando pra `/backup-drive/callback` do próprio servidor (ex.: `https://<domínio-do-caddy>/backup-drive/callback`, ver `deploy/Caddyfile.exemplo`).
- Client ID/Secret/Redirect URI entram como variáveis de ambiente (ver item 3, abaixo) — nunca hardcoded no repositório, mesmo padrão de segredo-fora-do-git já usado pelo projeto.
- **Sem isso feito**, tudo dos itens 2 a 8 abaixo já está implementado e funciona normalmente — só que `GET /backup-drive/status` sempre devolve `credenciaisConfiguradas: false`, e `POST /backup-drive/autorizar` recusa com **503** (mensagem explícita apontando de volta pra este passo) antes de chegar perto do Google.

### 2. Dependência nova — ~~cliente OAuth leve~~ nenhuma dependência nova (mudança de plano) — FEITO

- Cheguei a instalar `google-auth-library` e testar: ela sozinha trouxe **~270 pacotes transitivos** (gaxios, gtoken, gcp-metadata etc.) — pesado demais pra o que era necessário, e destoa do resto do projeto (hoje só 6 dependências, todas essenciais, nenhum cliente HTTP genérico). Revertido.
- Implementado em vez disso só com `fetch` nativo do Node (Node 18+, já o mínimo exigido — ver `engines` em `package.json`): a troca de código por token é um `POST` form-urlencoded, e o upload é um `POST` multipart — nenhuma lib adicional necessária. `package.json` continua com as mesmas 6 dependências de antes.

### 3. `lib/google-drive.js` — wrapper de autenticação e upload — FEITO

Módulo isolado, sem depender de nada de `lib/rotas/` — só concentra a conversa com o Google:

- `gerarUrlAutorizacao()` — monta a URL de consentimento do Google, escopo `drive.file` (acesso só aos arquivos que o próprio app cria — nunca ao Drive inteiro da pessoa; é o escopo mínimo necessário, mesmo raciocínio de permissão mínima já usado em `lib/permissoes-area.js`).
- `trocarCodigoPorTokens(code)` — troca o `code` do callback por `access_token` + `refresh_token`.
- `obterAccessTokenValido()` — usa o `refresh_token` guardado pra emitir um `access_token` novo sempre que precisar (eles expiram em ~1h; o `refresh_token` não expira sozinho, só se revogado).
- `enviarArquivoParaODrive(nomeArquivo, buffer)` — upload multipart pra uma pasta fixa (`"Lightwall — Backups Automáticos"`, criada automaticamente na 1ª vez, `id` guardado junto da credencial pra não precisar procurar de novo a cada upload).
- `revogarAcesso()` — chama o endpoint de revogação do Google e limpa a credencial local (usado por "Desconectar", item 6).

### 4. Onde a credencial fica guardada (novo arquivo, fora de `public/`) — FEITO

`private/backup-drive.json` (mesmo diretório de `security.json`/`usuarios.json`, mesma razão: nunca servido por URL):

```json
{
  "conectado": true,
  "email": "fabrica@gmail.com",
  "refreshToken": "...",
  "pastaId": "...",
  "ativo": true,
  "conectadoEm": "2026-08-26T12:00:00Z"
}
```

- `ativo` é o toggle liga/desliga (item 6) — permite desativar o envio sem precisar desconectar a conta de novo.
- `refreshToken` é o único dado realmente sensível aqui — entra na lista de arquivos que o Backup Geral **não** deve incluir (mesmo raciocínio que já vale pra `security.json`: um backup não deve virar um vetor de vazamento de credencial).

### 5. Rotas novas — `lib/rotas/backup-drive.js` (novo módulo, mesmo padrão factory + `tentar()` do resto de `lib/rotas/`) — FEITO

| Rota | O que faz |
|---|---|
| `GET /backup-drive/status` | Devolve `{ conectado, email, ativo, credenciaisConfiguradas }` pro front renderizar a seção (exige sessão de Administrador). Nunca inclui `refreshToken`/`pastaId`. |
| `POST /backup-drive/autorizar` | `{ senha }` — exige senha do Administrador reverificada (mesmo padrão de `/mesclar-backup-dados`), gera um `state` de uso único e devolve `{ url }`; **é POST, não GET** (diferente do desenho original do plano) — precisava do corpo com a senha antes de gerar a URL, então o front é quem redireciona (`window.location.href = url`), não o servidor. |
| `GET /backup-drive/callback` | Chamado pelo próprio Google. Confere o `state`, troca o `code` por tokens, descobre o e-mail da conta, grava `private/backup-drive.json`, redireciona de volta pra `/?config=backup-drive&ok=1|0&msg=...`. |
| `POST /backup-drive/toggle` | `{ ativo }` — liga/desliga sem desconectar a conta; recusa (400) se não há conta conectada. |
| `POST /backup-drive/desconectar` | `{ senha }` — exige senha do Administrador, chama `revogarToken` (best-effort — segue e limpa mesmo se o Google estiver inalcançável) e apaga a credencial de `private/backup-drive.json`. |

**Variáveis de ambiente necessárias** (só depois do Passo 1):

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://seu-dominio/backup-drive/callback
```

Sem elas, `credenciaisConfiguradas` vem `false` em `/status` e `/autorizar` recusa com 503 — nada quebra, só a conexão em si não avança.

### 6. Frontend — nova sub-seção em Configurações → Backup e Restauração — FEITO

- Card **"☁️ Backup na Nuvem (Google Drive)"** dentro do próprio painel "Backup e Restauração" (`backup-hub-modal`, junto dos cards de Backup de Dados/Geral/Automáticos já existentes) — fonte em `public/partials/modal-backup-hub.html`.
- **Sem credenciais do Google configuradas** (Passo 1 pendente): mostra um aviso neutro, nada clicável.
- **Desconectado** (credenciais ok): botão **"☁️ Conectar Google Drive"** → abre um modal de senha (reaproveitado também por "Desconectar") → `POST /backup-drive/autorizar` → `window.location.href` pra tela de consentimento do Google.
- **Conectado**: mostra o e-mail conectado, um toggle **Ativo/Pausado** (chama `POST /backup-drive/toggle` direto, sem pedir senha — reversível e de baixo risco) e botão **"Desconectar"** (pede senha, `POST /backup-drive/desconectar`).
- **Volta do Google** (`GET /backup-drive/callback` redireciona pra `/?config=backup-drive&ok=1|0&msg=...`): `public/js/app-core.js` captura esse parâmetro logo no início do boot (mesmo padrão de `_extrairChamadoIdDaUrl`, usado pra notificações push), limpa a URL, e depois do boot normal terminar abre o hub de backup automaticamente com a mensagem de sucesso/erro.
- **Nota de bug encontrado, não relacionado a este plano**: `build-index.js` reescreve `public/index.html` inteiro com quebra de linha LF, enquanto o arquivo committado usa CRLF — isso não muda nada pro navegador (HTML não liga pra isso), mas gera um diff gigante e irrelevante em qualquer ambiente sem `core.autocrlf=true` (típico de Linux/CI). Por isso as mudanças de HTML deste item foram aplicadas **diretamente em `public/index.html`** (mesmo conteúdo do partial, mesmo CRLF do arquivo), além do partial-fonte `modal-backup-hub.html` (pra quem rodar `build-index.js` no futuro já sair correto). Vale um `.gitattributes` fixando `public/index.html` como CRLF, ou ajustar `build-index.js` pra preservar a quebra de linha original — fora do escopo deste plano, só registrando aqui.

### 7. Envio automático — gancho em `executarBackupAutomaticoSeNecessario` — FEITO

Depois que o zip do dia é gravado em `backups-automaticos/` (`lib/rotas/backup.js`, ver seção acima), se `private/backup-drive.json` existir e `ativo === true`:

- Sobe o mesmo buffer já gerado pro Drive, na pasta dedicada (`enviarArquivoParaODrive`).
- **Fail-safe, igual ao resto deste job**: falha de upload (token revogado, sem internet, cota excedida) só loga erro (`logger.error('backup-drive', ...)`) — nunca impede nem desfaz o backup local, que já está seguro em disco de qualquer forma.
- Mantém a mesma retenção de **3 arquivos** também no Drive: ao subir um novo, apaga o mais antigo de lá (mirror da rotação que `_rotacionarBackupsAutomaticos` já faz localmente).

### 8. Testes — `test/backup-drive.test.js` — FEITO

Segue o padrão de `test/helpers/servidor-teste.js` (servidor real isolado, nunca mock de HTTP). Sem contato real com o Google (exigiria credenciais e conta de teste, fora do escopo de CI) — cobre tudo que dá pra testar sem isso: sessão obrigatória em todas as rotas, `/status` refletindo `private/backup-drive.json` sem nunca vazar `refreshToken`, `/autorizar` exigindo senha e recusando com 503 sem credenciais do Google configuradas, `/toggle` recusando sem conexão e persistindo corretamente, `/desconectar` exigindo senha e limpando a credencial, e Backup Geral **não** incluindo `backup-drive.json`. 10 testes, todos passando, junto com o restante da suíte de backup (39 no total entre os dois arquivos relacionados).

### 9. Coisas a decidir antes de implementar

- **Criptografar `refreshToken` em repouso?** Hoje `security.json`/`usuarios.json` guardam só hashes (nunca a senha em si) — já o `refreshToken` do Google precisa ser guardado em texto reversível (é assim que a API funciona). Vale considerar cifrar esse campo com uma chave derivada de algo já existente no servidor (ex.: mesmo mecanismo de `lib/security-json.js`), em vez de gravar em claro.
- **O que fazer se a conta for desconectada do lado do Google** (revogado direto na conta Google, não pelo botão "Desconectar" daqui)? O upload passaria a falhar sempre — o plano cobre isso como uma falha silenciosa (item 7), mas talvez valha um aviso visível em Configurações depois de N falhas seguidas, pra não passar despercebido por dias.
- **Nome/local da pasta no Drive** fixo (`"Lightwall — Backups Automáticos"`) — ok trocar por algo configurável, mas não parece necessário pro caso de uso.

**Status:** implementado (Passos 2–8) — falta só o **Passo 1** (criar o projeto no Google Cloud e gerar `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` de verdade). Sem isso, tudo já funciona normalmente — `credenciaisConfiguradas` vem `false` e o card mostra o aviso correspondente, em vez de quebrar ou esconder a seção.

## Operação em Andamento (tempo real)

Só existe **uma operação em andamento por vez**, na fábrica inteira. A partir do momento em que "Iniciar Injeção" é clicado em **Registrar Operação**, todo campo preenchido — turno, traços, ajustes, horário de encerramento — é transmitido em tempo real (WebSocket, rota `/ws/operacao-andamento`) pra qualquer outra aba ou computador que também tenha essa mesma tela aberta. Quem só está acompanhando vê a tela se comportar exatamente como se a operação estivesse sendo feita ali, cronômetro incluso.

- O estado atual fica espelhado em `public/db/operacao_andamento.json` — um único objeto (ou `null`, sem nenhuma operação rodando), nunca uma lista.
- Campos preenchidos **antes** de clicar em "Iniciar Injeção" não são transmitidos (ainda é só um rascunho local) — a transmissão começa no clique de "Iniciar" e termina quando a operação é registrada, resetada (🗑️ Limpar Tudo) ou enfileirada por falta de conexão.
- Sem necessidade de framework: o servidor (`server.js`) anexa um `WebSocket.Server` (lib `ws`) ao mesmo `http.Server` já existente.

**Limitação conhecida**: a trava de quem pode editar é por **permissão de perfil** (ver *Quem pode controlar operações*, abaixo), não por sessão exclusiva de edição — sempre vale "última mudança enviada sobrescreve a anterior" entre quem tem permissão, sem nenhuma trava adicional de concorrência dentro disso.

## Modo de Teste (Registrar Operação)

Toggle **🧪 Modo de Teste**, no topo da tela (só pode trocar com a operação parada — `status: 'idle'`). Existe pra treinar/testar o fluxo inteiro de uma operação sem misturar nada com dados reais de produção.

Com o toggle ativo, a operação funciona normalmente (turno, traços, Iniciar/Finalizar/Registrar, ajustes, sobra), mas:

- **Tudo é salvo em `public/db/teste/`** em vez de `public/db/` — `historico.json`, `relatorio_injecao.json`, `contador_tracos.json`, `ajustes_tracos.json` e `sobra.json` têm uma cópia isolada lá, criada na hora que o modo de teste é usado por aquela rota pela primeira vez. **Nunca** escreve nos arquivos reais.
- **Nunca é transmitida ao vivo** — não passa pelo WebSocket/`operacao_andamento.json` nem pela trava de permissão/dono (ver seções acima): é um sandbox local a este navegador, do início ao fim. Quem mais estiver acompanhando a tela nunca vê uma operação de teste.
- **Qualquer pessoa pode usar**, mesmo quem não tem permissão pra controlar operações reais — a trava de permissão é especificamente sobre a operação real e compartilhada; o teste é local e não compartilhado, então não tem com o que conflitar.
- **Nunca cai na fila de sincronização offline** — se a conexão cair no meio de um teste, ele simplesmente não salva (com aviso de erro), em vez de ficar pendente pra "sincronizar de verdade" depois (essa fila é só pra operações reais).
- **Sempre desliga ao limpar/zerar a tela** — de propósito, pra nunca ficar "esquecido" ligado numa operação real futura. Pra outro teste, é só ativar de novo.
- Visualmente reforçado em 3 lugares: o toggle fica roxo/aceso, um banner roxo no topo diz "MODO DE TESTE ATIVO", e o badge de status ao lado do cronômetro ganha um selo "🧪 TESTE".

O que fazer com os dados gerados em `public/db/teste/` (limpar, conferir, descartar) é decisão de uso — o sistema só garante que eles nunca se misturam com os reais.

## Modo Automático (Configurações → Automação)

Estrutura pronta pra integrar com a automação da fábrica (balança/CLP), mas **ainda sem a coleta de verdade conectada** — ver *Status da integração*, abaixo, pra saber exatamente o que falta.

Diferente do Modo de Teste (que é local a uma operação, num navegador), o Modo Automático é uma **configuração global** — liga/desliga pra fábrica inteira, não por operação:

- Fica em **Menu → Configurações → Automação**, não mais como toggle em Registrar Operação.
- Guardado em `config.json` (`modoAutomatico: true|false`), carregado uma vez por página (`LW.MODO_AUTOMATICO_ATIVO`) e atualizado em memória na hora que alguém muda (sem precisar recarregar — ver `atualizarModoAutomatico` em `data.js`).
- **Exige a senha de Administrador pra ligar E pra desligar** (`AdminAuth.abrirModal`, sempre pede de novo mesmo já autenticado) — tanto no front quanto reforçado no servidor: `POST /config/modo-automatico` exige sessão de admin válida (HTTP 403 sem ela), diferente de `/salvar-config` (que não exige).
- **Sem tema visual** de propósito (diferente do Modo de Teste, que pinta a tela inteira de roxo) — só um texto simples, "🤖 Autônomo ativo", ao lado do título de Registrar Operação quando ligado. Fica confuso ter 2 temas de cor concorrendo na mesma tela.

### Como os dados chegam (estrutura já pronta)

```
[Balança/CLP] → (coletor Modbus TCP — ainda não existe) → POST /leitura-automatica → WebSocket → Registrar Operação
```

- `POST /leitura-automatica`: rota genérica que recebe **uma leitura por vez**, valida e retransmite via WebSocket (mesmo canal de `/ws/operacao-andamento`) pra quem estiver com a tela de Registrar Operação aberta. Rejeita (HTTP 400) se o Modo Automático estiver desligado — confere `config.json` a cada chamada, não só na hora de ligar.
  - Insumo (balança): `{ tipo: 'insumo', campo: 'cimento_real', valor: 512.3, traco: 1 }` — `campo` é um dos 5 insumos reais do traço (`cimento_real`, `agua_real`, `eps_real`, `superplast_real`, `incorporador_real`); `traco` (número, opcional) indica qual traço — se omitido, aplica no traço selecionado no momento em Registrar Operação.
  - Berço (injetora): `{ tipo: 'berco', berco: 'B7' }` — chega e é logada, mas **ainda sem ação definida** do lado da tela (ver item 7 em *Status da integração*, abaixo).
- `operacao.js` (`_aplicarLeituraAutomatica`) recebe a leitura via WebSocket e, se o Modo Automático estiver ligado, aplica com `LWOp.updateInsumoOriginal` — o **mesmo caminho** que a digitação manual usa, então total calculado, indicador de traço completo/pendente e persistência funcionam automaticamente, sem lógica duplicada.
- Sem permissão de controlar operação nem sessão de admin nessa rota especificamente (`/leitura-automatica`) — é uma leitura de sensor, não um controle da operação; a proteção por senha é só pra **ligar/desligar** o modo, não pra cada leitura individual.

### Status da integração (CLP identificado, coleta ainda não conectada)

O CLP da linha é um **WAGO 750-8212**, linha **PFC200** — Linux embarcado com runtime CODESYS. Suporta nativamente **Modbus TCP** e **OPC-UA**; MQTT dá pra configurar (pode depender da versão do firmware). Tem uma interface de administração via navegador (WBM), acessível digitando o IP dele.

**O que falta pra sair da estrutura e virar integração de verdade:**

1. **Conexão física** — o computador que roda o Lightwall ainda não está na mesma rede do CLP (nem por cabo direto, nem por switch compartilhado).
2. **IP do CLP** na rede, depois de conectado.
3. **Confirmação do integrador**: liberar leitura Modbus TCP (ou MQTT) **só de leitura**, num IP/porta específico, pra consulta externa.
4. **Mapa de registradores/tags**: qual registrador Modbus (ou tag OPC-UA/tópico MQTT) corresponde a cada insumo (cimento, água, EPS, superplastificante, incorporador de ar) e a cada berço preenchido pela injetora.
5. **Confirmar o que o CLP atualiza**: se o registrador reflete o **valor pretendido/digitado** (na hora que a pessoa digita na máquina) ou o **peso real medido** (só muda conforme a balança pesa de verdade) — pro caso de uso deste sistema (preencher `*_real`), o peso real medido é o que faz sentido.
6. **O coletor em si**: um script Node.js (candidato: lib `modbus-serial`) que fica lendo o CLP periodicamente (polling, Modbus) ou assinando um tópico (MQTT) e chama `POST /leitura-automatica` a cada leitura nova — ainda não escrito, é o próximo passo assim que os itens 1–5 estiverem resolvidos.
7. **Decidir a ação de "berço preenchido"** — o que uma leitura `{tipo:'berco', berco}` deve mudar na tela: marcar em `bercos_visuais`? avançar `bercos_reais`? outra coisa? Ainda em aberto (ver `TODO` em `_aplicarLeituraAutomatica`, `operacao.js`).

## Log de Acesso

Toda vez que a tela **Registrar Operação** é acessada (`showPage('operacao', ...)`), o sistema registra em `logs/acessos.json`:

```json
{
  "ip": "177.x.x.x",
  "deviceId": "dev_1782345678901_ab12cd",
  "data": "2026-06-24T09:15:20.123Z",
  "rota": "/operacao",
  "userAgent": "Mozilla/5.0 (Linux; Android 13) ... Chrome/120 Mobile"
}
```

- `ip` e `userAgent` vêm do próprio request, capturados no servidor (fontes confiáveis).
- `deviceId` é gerado uma única vez por navegador/computador e persistido em `localStorage` (`lw_device_id`) — não é um login de verdade, mas é o que dá pra usar como identidade estável de "qual aparelho é qual" sem exigir cadastro.
- Fica em `logs/`, **fora** de `public/` — de propósito: arquivos em `public/db/` são servidos como arquivo estático comum (ver "Limitações conhecidas"), e isso exporia o IP de quem acessa pra qualquer um que soubesse a URL. Em `logs/`, não existe rota nenhuma que sirva esse arquivo — só o próprio servidor lê/escreve nele direto no disco.
- O IP é gravado em texto puro (não é hash nem está criptografado) — a defesa aqui é não expor o arquivo, não ofuscar o conteúdo dele.
- Cresce sem limite por enquanto (sem rotina de limpeza automática, igual a `backups-seguranca/`) e ainda não tem tela de visualização — é só a infraestrutura de registro.
- `deviceId` continua identificando o "dono" da operação em andamento (evita dois computadores autorizados brigando pela mesma operação, ver *Quem pode controlar operações*), mas quem PODE controlar é decidido pela sessão de usuário logado, não mais pelo `deviceId`.
- Por estar fora de `public/db/`, não faz parte de nenhum dos dois backups (Dados ou Geral — ambos são uma lista fixa de arquivos, ver *Backup e Restauração*) — fica de fora dos dois, precisando ser copiado manualmente se quiser preservar o histórico de acessos.

**Limitação conhecida**: `deviceId` é só o que o próprio navegador reporta — limpar os dados do navegador gera um device novo, e nada impede alguém de mandar um valor falso direto pra rota (não é uma defesa de segurança, só uma identidade de conveniência).

## OEE

Definições usadas, combinadas com o time de operação:

- **Disponibilidade** = tempo real produzindo (soma de `tempo_min` das operações) ÷ 420 min (7h), por turno. As 7h vêm de: turno de 9h − 1h de descanso − 1h de lavagem programada (2× 30 min).
- **Performance** = (59 min × nº de operações) ÷ tempo real produzindo, limitado a 100%. 59 min é o ciclo ideal por operação.
- **Qualidade** = % de traços que não precisaram de **nenhum** ajuste de insumo (cimento, água, EPS, superplastificante, incorporador de ar) — mesmo critério usado em "Qualidade dos Traços".
- **OEE** = Disponibilidade × Performance × Qualidade.

Quando não há traço registrado num turno, a Qualidade (e portanto o OEE) daquele turno aparece como "sem dado", não como 0% — falta de dado é diferente de falha real.

## Atalhos de teclado (resumo)

- `Alt+1` a `Alt+8` — navega entre as páginas.
- `Ctrl+Shift+D` — abre/fecha o Debriefing do Dia (funciona em qualquer página).
- `Ctrl+Shift+F/R/E/A` — ações da tela de Operação (filtro, atualizar, exportar, novo traço).
- `F1` ou `?` — modal de ajuda com a lista completa.

## API (server.js)

| Rota | Método | Descrição |
|---|---|---|
| `/verificar-senha` | POST | Confirma senha do administrador — emite sessão (cookie) se correta 🚦 |
| `/verificar-recovery` | POST | Confirma chave de recuperação de senha — emite sessão (cookie) se válida 🚦 |
| `/gerar-hash` | POST | Gera hash de uma senha no formato novo (scrypt — ver *Autenticação e Sessão*) |
| `/total-tracos-hoje` | GET | Contador diário de traços 🧪 |
| `/confirmar-tracos-hoje` | POST | Incrementa o contador diário 🔒🧪 |
| `/salvar-config` | POST | Salva `config.json` |
| `/config/modo-automatico` | POST | Liga/desliga o Modo Automático em `config.json` 🔐 (ver *Modo Automático*) |
| `/leitura-automatica` | POST | Recebe 1 leitura externa (balança/CLP) e retransmite via WebSocket — rejeita se o Modo Automático estiver desligado (ver *Modo Automático*) |
| `/salvar-security` | POST | Salva `security.json` (troca de senha) 🔐 |
| `/db/security.json` | GET | Lê `security.json` (ver *Autenticação e Sessão*) 🔐 |
| `/logout-admin` | POST | Destrói a sessão de administrador atual |
| `/registrar-operacao` | POST | Grava um registro em `historico.json` 🔒🧪 |
| `/editar-operacao` | POST | Corrige um registro existente em `historico.json` + audita em `historico_edicoes.json` |
| `/registrar-relatorio-injecao` | POST | Grava traços em `relatorio_injecao.json` 🔒🧪 |
| `/editar-traco-relatorio` | POST | Corrige um traço em `relatorio_injecao.json` + regrava `ajustes_tracos.json` pra ele + audita em `relatorio_edicoes.json` (ver *Editar Traço*) |
| `/registrar-ajuste-traco` | POST | Grava um ajuste (insumo + tempo de batida) em `ajustes_tracos.json` 🧪 |
| `/importar-relatorio-injecao` | POST | Importação em lote (Excel) de traços |
| `/importar-historico` | POST | Importação em lote (Excel) de histórico |
| `/salvar-sobra` | POST | Salva/atualiza `sobra.json` 🧪 |
| `/salvar-operacao-andamento` | POST | Salva `operacao_andamento.json` e propaga a mudança via WebSocket 🔒 (+ HTTP 409 se outra pessoa autorizada já é a dona — ver *Quem pode controlar operações*) |
| `/ws/operacao-andamento` | WS | Canal em tempo real da operação em andamento (ver seção dedicada acima) |
| `/registrar-acesso` | POST | Grava uma entrada em `logs/acessos.json` (log de acesso) |
| `/backup-dados` | GET | Gera e baixa o `.zip` só com dados de produção |
| `/backup-geral` | GET | Gera e baixa o `.zip` com dados de produção + config.json + identidade/acesso |
| `/backups-automaticos` | GET | Lista os backups de dados diários automáticos disponíveis (até 3) |
| `/backups-automaticos/<nome>` | GET | Baixa um backup automático específico |
| `/mesclar-backup-dados` | POST | Mescla traços/operações/paradas de um backup de OUTRA instalação (exige senha de admin, reverificada) |
| `/restaurar-backup-dados` | POST | Restaura dados de produção a partir de um backup (exige senha de admin, reverificada) |
| `/restaurar-backup-geral` | POST | Restaura dados de produção + config + identidade/acesso (esses últimos opcionais e preservados se ausentes) a partir de um backup (exige senha de admin, reverificada) |
| `/*` (qualquer outro caminho) | GET | Serve arquivos estáticos de `public/` |

- 🔒 = exige sessão de usuário logado com permissão de controlar operações (HTTP 403 caso contrário — ver *Quem pode controlar operações*). Ignorado quando `?modoTeste=true`.
- 🧪 = aceita `?modoTeste=true` — desvia a leitura/escrita pra `public/db/teste/` em vez de `public/db/` (ver *Modo de Teste*, acima).
- 🔐 = exige sessão de Administrador válida (cookie — ver *Autenticação e Sessão*, abaixo). HTTP 403 sem ela.
- 🚦 = protegido por rate limiting de tentativas (ver *Autenticação e Sessão*, abaixo). HTTP 429 se bloqueado.

## Autenticação e Sessão

A senha do Administrador é guardada com hash **scrypt** (nativo do Node — sem dependência nova), com salt aleatório por hash. Hashes antigos (SHA-256 puro, de antes desta mudança) continuam sendo aceitos na comparação e são promovidos automaticamente pro formato novo no primeiro acerto — sem exigir troca manual de senha.

`/verificar-senha`, `/verificar-recovery`, `/mesclar-backup-dados`, `/restaurar-backup-dados` e `/restaurar-backup-geral` compartilham um rate limiting por IP: 5 tentativas erradas bloqueiam por 5 minutos (HTTP 429, com cabeçalho `Retry-After`). Em memória — reinicia o servidor e zera, mas é o suficiente pra fechar a porta de um script tentando senha atrás de senha sem limite.

`security.json` (hash da senha + hash da chave de recuperação) mora em `private/`, **fora** de `public/` — antes desta mudança, vivia em `public/db/` e era servido como arquivo estático comum, sem proteção nenhuma (qualquer um que soubesse a URL acessava os hashes direto; e `/salvar-security` aceitava qualquer hash bem formatado, **sem verificar senha nenhuma** — bastava saber o formato pra assumir a conta). As duas brechas estão fechadas:

- O arquivo físico não existe mais em `public/db/` (migração automática no boot, se uma instalação antiga ainda tiver o arquivo no lugar velho — renomeia, nunca apaga).
- `GET /db/security.json` (mesma URL de sempre — o front continua usando ela) e `POST /salvar-security` agora exigem uma **sessão de Administrador** válida: um cookie `HttpOnly`, emitido depois de uma senha ou chave de recuperação confirmada com sucesso, válido por ~10 anos na prática (era 30 minutos — trocado a pedido, ver `lib/sessao.js`), destruído em `/logout-admin` (chamado automaticamente pelo botão de logout). Persistido em SQLite, sobrevive a um restart do servidor.

Essa sessão **não substitui** a re-verificação de senha das rotas mais destrutivas (`/restaurar-backup-dados`, `/restaurar-backup-geral`, `/mesclar-backup-dados`) — elas continuam pedindo a senha de novo a cada chamada, por design (defesa em profundidade: mesmo um cookie de sessão vazado/sequestrado de uma aba esquecida aberta não basta pra restaurar dados ou sobrescrever o servidor sozinho). Fora essas 3, a sessão hoje cobre a maior parte das rotas administrativas — `salvar-config`, `salvar-metas`, `config/modo-automatico`, `importar-relatorio-injecao`, `importar-historico`, `backup-dados`, `backup-geral`, `backups-automaticos` (listagem e download), toda a aba "🗄️ Dados SQL", `admin/resetar-operacao`, e o cadastro de usuários (`salvar-usuarios`) — além das 2 originais (`db/security.json`, `salvar-security`).

## Exportação em PDF (Análise Focada) — Contagem, Progresso e Cancelamento (plano)

Hoje a Exportação em PDF ("Do Dia"/"Personalizada", especialmente com um range grande tipo um mês) é uma caixa-preta pro usuário: clica em exportar, o botão vira "Gerando…" e não acontece mais nada visível até o download cair (ou estourar erro, ex.: `Navigation timeout of 30000 ms exceeded` — ver `lib/rotas/exportar-pdf.js`, `page.setContent(..., { timeout: 30000 })`) — sem noção de quantas análises entram no arquivo, quanto falta, nem como cancelar se demorar demais. Pedido: mostrar a contagem ANTES de exportar, uma barra de progresso DURANTE (com botão cancelar), e — como consequência de ter uma barra de verdade — poder tirar os timeouts fixos que hoje só servem pra evitar uma trava sem feedback nenhum.

Dividido em fases por **onde o progresso é medido**, não por tela — cada fase é visível e testável sozinha, sem depender da seguinte:

| Fase | O quê | Onde mora | Risco |
|---|---|---|---|
| 1 | Contagem de análises ANTES de exportar — "Simples" sempre 1 (texto fixo); "Do Dia" calcula em cima do cache já carregado (mesma lista que `_exportarDoDia` usa pra montar o arquivo); "Personalizada" calcula assim que o período (De/Até) é escolhido no modal, ANTES de confirmar — "Você vai exportar X análises" | `public/js/analise-focada.js` (`_escolherRangeDatas`, `_exportarDoDia`/`_exportarPersonalizado`) | Baixo — só leitura do cache já em memória, nenhuma mudança de arquitetura |
| 2 | Barra de progresso + botão cancelar (UI) — inserida entre os botões de exportação e a section de pesquisa; 3 fases visíveis: carregando dados de cada operação (progresso REAL, já que já é um `Promise.all` por operação — dá pra contar quantas resolveram), montando o HTML (rápido, quase instantâneo), enviando/aguardando o servidor (indeterminada/pulsante nesta fase — ver Fase 3). Cancelar aqui interrompe o acompanhamento do lado do cliente (`AbortController` no fetch) — o Chromium no servidor pode continuar rodando até terminar sozinho, só que o resultado é descartado | `public/js/analise-focada.js` (UI da barra), `public/js/data.js` (`baixarPdfApartirDeHtml`) | Baixo/Médio — é só UI + cancelamento client-side, não mexe na rota do servidor ainda |
| 3 | Progresso REAL do servidor + cancelamento de verdade — troca a rota síncrona (`POST /exportar-pdf` → espera → devolve o PDF pronto) por um fluxo assíncrono: inicia um job, acompanha por Server-Sent Events (`GET /exportar-pdf/eventos/:jobId`), baixa quando pronto (`GET /exportar-pdf/arquivo/:jobId`). O script de ajuste de escala (`_afScriptAjustePaginaUnica`) passa a reportar "operação X de Y ajustada" de volta pro Node via `page.exposeFunction`, virando progresso real na barra. Cancelar de verdade fecha a `page`/aborta o job no meio. É o que permite tirar os timeouts fixos de hoje (`page.setContent` 30s, `waitForFunction` 15s) — sem eles, "trava sem feedback nenhum" vira "acompanha o progresso real, e cancela se quiser" | `lib/rotas/exportar-pdf.js` (reescrita — vira stateful, com jobs em memória), `public/js/data.js`/`analise-focada.js` (troca fetch único por SSE + polling do arquivo) | Alto — muda a arquitetura da rota (de stateless pra job assíncrono com estado em memória), mexe no script injetado no PDF, e no timeout que hoje existe por segurança |
| 4 | Aviso de "processo pode demorar" quando a contagem (Fase 1) passar de um limiar (ex.: 15-20 análises) — mesmo modal/fluxo da Fase 1, só populando um aviso a mais | `public/js/analise-focada.js` (mesmo lugar da Fase 1) | Baixo — é texto condicional em cima de um número que a Fase 1 já calcula |

Ordem pensada do **menor pro maior risco**, igual ao critério já usado no fatiamento de `server.js`/`db.js`: a Fase 1 (contagem) e a Fase 4 (aviso) são baratas e já entregam valor sozinhas mesmo sem barra de progresso nenhuma; a Fase 2 dá o feedback visual usando só o que já é medível hoje (o carregamento client-side); a Fase 3 é a que de fato resolve o timeout, mas é a mais arriscada (rota vira stateful, com jobs guardados em memória — precisa de limpeza de jobs órfãos, tratamento de cancelamento no meio do Puppeteer, etc.) — por isso fica por último, com as fases anteriores já validadas e testadas.

**Status:** Fases 1, 2, 3 e 4 concluídas e aplicadas — plano completo.

**Nota sobre a Fase 3**: a rota `/exportar-pdf` deixou de ser um único `POST` síncrono (cliente manda o HTML, espera, recebe o PDF pronto ou um erro) e virou um fluxo de 3 rotas com job assíncrono em memória: `POST /exportar-pdf/iniciar` cria o job e devolve um `jobId` na hora, sem esperar nada; `GET /exportar-pdf/eventos/:jobId` acompanha o progresso por Server-Sent Events até um evento terminal (`concluido`/`erro`/`cancelado`); `GET /exportar-pdf/arquivo/:jobId` baixa o PDF só depois de "concluido" (e libera o Buffer da memória assim que é servido). O script de ajuste de escala injetado no PDF (`_afScriptAjustePaginaUnica`, `public/js/analise-focada.js`) agora chama `window.__afReportarProgresso(feito, total)` a cada operação ajustada — uma ponte Chromium → Node via `page.exposeFunction` (`lib/rotas/exportar-pdf.js`) — o que dá progresso REAL na barra também durante essa etapa (fase `'ajustando'`), não só um "enviando…" indeterminado como na Fase 2. `POST /exportar-pdf/cancelar/:jobId` cancela de verdade: fecha a `page` do Puppeteer no meio do processo (diferente da Fase 2, onde cancelar só abortava o fetch do lado do cliente e o Chromium continuava rodando sozinho no servidor). Os dois timeouts fixos que existiam antes por segurança (`page.setContent(..., { timeout: 30000 })`, `waitForFunction(..., { timeout: 15000 })`) saíram — não fazem mais falta, porque agora "trava sem feedback" virou "acompanha o progresso real, e cancela se quiser". Jobs órfãos (ninguém voltou a acompanhar, ou ninguém baixou o arquivo pronto) são varridos a cada 1 minuto e expiram depois de 10 minutos sem atividade, pra não vazar memória (nem páginas do Chromium) indefinidamente. `public/js/data.js` (`baixarPdfApartirDeHtml`, que passou a orquestrar iniciar → SSE → baixar em vez de um fetch só) e `public/js/analise-focada.js` (`_finalizarExportacao`, `_progressoServidor`) foram os pontos de client-side ajustados; as 3 exportações (Simples/Do Dia/Personalizada) e o formato HTML (que nunca fala com o servidor) não mudaram de comportamento nenhum.

**Nota sobre a Fase 4**: aviso de "processo pode demorar" quando a contagem calculada na Fase 1 passa de um limiar (`_LIMIAR_AVISO_DEMORA_PDF = 15`, dentro da faixa "15-20" sugerida acima) — mesmo modal/fluxo da Fase 1 (`_escolherDataDoDia`/`_escolherRangeDatas`, `public/js/analise-focada.js`), só populando um `<p>` a mais logo abaixo da contagem, recalculado junto com ela a cada troca de data. Só aparece no formato **PDF** — "Do Dia"/"Personalizada" em HTML não fazem round-trip com o servidor, então não têm o risco de timeout do Chromium que motiva o aviso; por isso os dois modais agora recebem `formato` como parâmetro (antes só usado depois, na hora de exportar) e o botão "🌐 Exportar Interativo" nunca mostra o aviso. Puramente informativo — não bloqueia nem pede confirmação extra, é só texto condicional em cima do número que a Fase 1 já calcula. `public/js/analise-focada.js`.

**Nota sobre a Fase 1**: contagem de análises ANTES de exportar, só pra "Do Dia" e "Personalizada" (que têm um modal de confirmação antes de exportar — "Simples" não tem, então continua sem esse texto, sempre 1 análise por definição). `_escolherDataDoDia`/`_escolherRangeDatas` (`public/js/analise-focada.js`) viraram `async`, garantindo `_carregarCaches()` antes de abrir o modal, e cada um ganhou um `<p>` com "Você vai exportar X análises" logo abaixo do(s) campo(s) de data, recalculado a cada troca via `input`/`change` — leitura pura de `_cacheHistorico` já carregado, nenhuma chamada extra ao servidor. Zero mudança de arquitetura, zero toque no servidor.

**Nota sobre a Fase 2**: barra de progresso + botão Cancelar, inserida entre os botões de exportação e a section de busca (`#af-progresso`, `public/partials/page-analise-focada.html`) — 3 fases visíveis nas 3 exportações (Simples/Do Dia/Personalizada, HTML ou PDF): (1) carregando dados de cada operação — progresso REAL, contando quantas resolveram dentro do `Promise.all` já existente; (2) montando o HTML — rápido/instantâneo, só avança a barra pra sinalizar a transição; (3) enviando/aguardando o servidor — só quando o formato é PDF (o único que faz round-trip com `/exportar-pdf`), indeterminada/pulsante (`.af-progresso-indeterminada`, `public/css/styles.css`), porque o cliente não tem como medir quanto falta pro Chromium terminar. Cancelar aborta o fetch em andamento via `AbortController` (`_finalizarExportacao`/`LW.baixarPdfApartirDeHtml`, que agora aceita um `signal` opcional) e faz as fases 1/2 pararem no próximo ponto de checagem (`_progressoCancelado`) sem mostrar erro nenhum — o Chromium no servidor pode continuar rodando até terminar sozinho, só que ninguém mais está esperando o resultado (a rota do servidor em si não mudou, ainda é síncrona — isso só fica resolvido de verdade na Fase 3). `public/js/analise-focada.js`, `public/js/data.js`, `public/partials/page-analise-focada.html`, `public/css/styles.css`.

### Fase 5 — Progresso REAL na fase `imprimindo`, sem estimativa

A Fase 3 deixou 2 das 3 sub-fases da barra (`carregando`, `ajustando`) com progresso genuinamente medido, mas a terceira — `imprimindo`, justamente a que mais demora num export grande — continua sendo uma ESTIMATIVA: `page.pdf()` do Puppeteer é uma chamada atômica, sem callback de progresso nenhum, então o servidor só projeta uma % (0-95) em cima de uma média móvel de quanto os ÚLTIMOS jobs levaram por operação (`_msPorOperacaoImpressao`, `_iniciarTickerImpressao`, `_registrarDuracaoImpressao`, `lib/rotas/exportar-pdf.js`). Funciona, mas "quanto falta" é sempre um chute (o texto já é honesto sobre isso — `~Xs restantes`, com til).

**Ideia central**: cada operação já é forçada a ocupar exatamente 1 página A4 inteira e só uma (`.af-op-pagina { height:287mm; overflow:hidden }` + `.af-op-pagina + .af-op-pagina { break-before:page }`, `_afCssImpressaoPdf`, `public/js/analise-focada.js`) — ou seja, o Chromium, ao paginar o documento carregado, SEMPRE produz exatamente 1 página física de PDF por operação, garantido pelo próprio CSS que já existe hoje. Isso abre uma rota simples pra progresso real: em vez de 1 chamada atômica `page.pdf()` sobre o documento inteiro, fazer N chamadas — uma por página — usando a opção nativa `pageRanges` do Puppeteer (`page.pdf({ pageRanges: String(n) })`), sobre a MESMA `page` já carregada (sem recarregar HTML, sem show/hide de DOM, sem re-rodar o script de ajuste de escala — só reaproveita a paginação que o Chromium já calculou uma vez). `N` é o mesmo número que a fase `ajustando` já reporta (`job.total`, vindo de `window.__afReportarProgresso`) — pra "Simples" (1 única `.af-op-pagina`), `N=1`, uma chamada só, comportamento idêntico ao de hoje.

| Passo | O quê | Onde mora | Risco |
|---|---|---|---|
| 5.1 | Adicionar `pdf-lib` como dependência nova (mesclar os N PDFs de 1 página cada, gerados um por vez, num único Buffer final — nenhuma das libs já usadas no projeto faz isso) | `package.json` | Baixo — só adiciona uma lib, não mexe em nada existente |
| 5.2 | Trocar a chamada única `page.pdf({...})` (`_processarJob`) por um loop de N chamadas `page.pdf({ ...mesmasOpções, pageRanges: String(i) })`, uma por página, coletando cada resultado (Buffer de 1 página) num array — depois de CADA chamada, `_atualizarProgresso(job, 'imprimindo', i, N)` — `feito`/`total` passam a ser contagem REAL de páginas já impressas, não mais % estimada | `lib/rotas/exportar-pdf.js` (`_processarJob`) | Médio — é o coração da mudança; precisa confirmar que `pageRanges` produz página idêntica à que sairia da impressão inteira (mesma resolução de fontes/cores/quebras), já visto/validado manualmente antes de aplicar em produção |
| 5.3 | Mesclar os N buffers de 1 página com `pdf-lib` (`PDFDocument.load` + `copyPages` + `save()`) no Buffer final — é ESSE que vira `job.pdfBuffer`, servido em `GET /exportar-pdf/arquivo/:jobId` | `lib/rotas/exportar-pdf.js` | Baixo/Médio — biblioteca nova, mas operação padrão (merge de PDFs) bem documentada nela |
| 5.4 | ~~Aposentar~~ Restringir a estimativa por média móvel entre jobs (`_msPorOperacaoImpressao`/`_iniciarTickerImpressao`/`_registrarDuracaoImpressao`) só ao caminho de FALLBACK (dashboards sem o mecanismo de página única, que não têm como saber o total de páginas de antemão — ver nota da 5.2/5.3) — continua existindo, só não é mais usada quando o total é conhecido. Nesse caso (Análise Focada), `segundosRestantes` passa a vir do tempo médio JÁ OBSERVADO nas páginas anteriores DESTE MESMO job (mais preciso: reflete a complexidade real da operação sendo impressa agora, não uma média de jobs antigos possivelmente bem diferentes) | `lib/rotas/exportar-pdf.js` | Baixo — é escopo mais estreito de um código que já existia, não remoção; um cálculo local a mais no branch que já tem o total conhecido |
| 5.5 | Cliente (`_progressoServidor`, `public/js/analise-focada.js`) passa a receber um campo novo no evento SSE, `progressoReal` (`true`/`false`) — necessário porque `feito`/`total` sozinhos são ambíguos: no caminho de página conhecida eles são CONTAGEM real de páginas (ex.: "3 de 12"), no fallback continuam sendo % estimada (0-95), e o cliente não tinha como distinguir os dois formatos com segurança sem esse flag explícito. Barra/texto passam a ramificar em cima dele: `progressoReal:true` mostra "Imprimindo o PDF (3 de 12 páginas)…"; `false` mantém o texto de estimativa de sempre | `lib/rotas/exportar-pdf.js` (`_atualizarProgresso`), `public/js/data.js` (`baixarPdfApartirDeHtml`, repassa o campo), `public/js/analise-focada.js` (`_progressoServidor`) | Baixo — muda a leitura de um campo a mais que já chega por SSE, layout da barra já existe |
| 5.6 | Cancelamento entre páginas — como agora são N chamadas sequenciais (não 1 atômica), `_cancelarJob` fecha a `page` entre uma impressão e outra, então cancelar fica ainda mais responsivo num export grande (não precisa esperar a impressão inteira terminar pra reagir, como hoje) | `lib/rotas/exportar-pdf.js` (`_processarJob`, checagem de `job.status` entre iterações do loop) | Baixo — é uma checagem a mais dentro de um loop que já existe pro resto do fluxo |

**Ordem de aplicação**: 5.1 → 5.2+5.3 juntos (a chamada em N partes só faz sentido já mesclando o resultado, senão o PDF final fica quebrado em pedaços soltos) → 5.4 (limpeza, só depois de confirmar que 5.2/5.3 funcionam de ponta a ponta) → 5.5 (client-side, só depois do servidor já mandar o formato novo) → 5.6 (refinamento em cima do loop já funcionando). 5.2/5.3 são o núcleo arriscado — validar manualmente com uma "Personalizada" de várias operações (múltiplas páginas, testa o merge e a ordem) E uma "Simples" (1 página só, garante que o caminho de N=1 não regride o comportamento de hoje) antes de considerar a fase concluída.

**Status:** 5.1, 5.2, 5.3, 5.4, 5.5 e 5.6 concluídas e aplicadas — plano completo. A checagem de `job.status` entre um bloco e outro do loop de impressão (5.6) já existia desde a 5.2; formalizada como passo próprio, coberta por `test/exportar-pdf-cancelamento-entre-paginas.test.js`.

## Registro de Operação Offline (PWA) — plano

**Objetivo**: hoje, sem internet, ninguém consegue nem logar (`/login-usuario`, `/minha-sessao` dependem do servidor) — então, numa queda de rede no chão de fábrica, a operação simplesmente não é registrada em tempo real, fica só de memória/papel pra lançar depois. A ideia é abrir uma porta lateral, só pra esse cenário: registrar a operação **sem login**, **sem servidor**, tudo local no navegador, e mandar pra uma fila de validação assim que a conexão voltar — um humano (perfil Master) confere e só então ela vira uma operação de verdade no sistema.

**Fora de escopo deste plano** (não reaproveita nem interfere): a fila `lw_fila_operacoes_pendentes` que já existe hoje (ver *FILA DE OPERAÇÕES PENDENTES*, `public/js/data.js`) — aquela é pra quando a rede cai NO MEIO de uma operação já sendo controlada por alguém LOGADO, com a tela normal de Registrar Operação aberta; reenvia automaticamente e sem revisão de ninguém, porque quem registrou já era uma pessoa autenticada e autorizada. Este plano é o oposto: ninguém está logado, a origem não é confiável até alguém confirmar — por isso passa por validação humana antes de virar uma operação real, e por isso precisa de armazenamento/rotas próprios, para não misturar as duas filas. Esse cenário (logado, rede cai no meio) ganha um reforço de UX pelo item 9, abaixo — sem alterar o mecanismo que já existe.

### 1. Ponto de entrada — tela de login

Abaixo do botão **Entrar** (`login.html`), um link discreto (fonte pequena, cor apagada, sem se misturar ao formulário principal): **"Registrar operação offline"**.

Ao clicar:
1. Confere conectividade de verdade — `navigator.onLine` sozinho não basta (fica `true` com Wi-Fi conectado mas sem internet de verdade; o próprio comentário de `_tentarAutoLogin`, acima, já lida com esse tipo de falha via `try/catch` de um `fetch` real). Faz um `fetch` curto (ex.: `HEAD /minha-sessao` ou uma rota nova e leve tipo `GET /ping`, com timeout de ~2-3s) pra confirmar.
2. **Servidor alcançável** → mensagem: *"Esse recurso é exclusivo para quando não há internet disponível — use o login normal."* Não navega pra lugar nenhum.
3. **Servidor inalcançável** → navega para a tela de registro offline (item 2, abaixo).

### 2. Tela de registro offline — standalone, fora da SPA

`public/js/operacao.js` (3041 linhas) é a tela "Registrar Operação" de verdade — mas ela está profundamente acoplada ao resto do sistema logado: WebSocket de operação ao vivo (`/ws/operacao-andamento`, singleton por fábrica — ver *Operação em Andamento*), checagens de sessão/perfil (`podeControlarOperacao`), conceito de "dono" da operação, sincronização entre abas. Nada disso faz sentido sem rede nem sem login. Por isso, em vez de tentar encaixar o modo offline dentro dela, a proposta é uma **página própria**, fora da SPA principal — mesmo padrão já usado por `tv.html` (README, *Páginas*: "fora da SPA principal... Não exige login"):

- `public/offline.html` + `public/js/offline-operacao.js` (novo).
- Reaproveita o **HTML/CSS do formulário** de Registrar Operação (tipos de montagem, berços, traços, tempos, pausas) — não a lógica de rede/sessão/WebSocket. Cronômetro roda 100% local (`Date.now()`, sem depender de nenhum broadcast).
- **Dado de configuração necessário pra montar o formulário** (baterias cadastradas, tipos de montagem, capacidades — hoje vem de `config.json`) é **pré-cacheado pelo Service Worker** (decisão tomada — ver item 8), então já está disponível offline desde a instalação do PWA, sem depender de o dispositivo já ter aberto o sistema online antes.
- Sem toggle de Modo de Teste (não faz sentido aqui) e sem indicação de "quem está logado" (ninguém está).

### 3. Armazenamento local — uma operação pendente por vez

Chave própria, separada da fila existente: `lw_operacao_offline_pendente` (objeto único, não array — igual ao padrão de `operacao_andamento.json` no servidor: no máximo uma coisa pendente por vez, nunca uma lista).

```
{
  idTemp: "OFF-<uuid>",         // prefixo OFF- deixa óbvio, em qualquer tela/log, que essa origem é offline
  iniciadoEm, atualizadoEm,     // timestamps locais (ver limitação de relógio, item 8)
  formRecord: {...},            // mesmo formato de "record" que iria pra /registrar-operacao
  tracos: [...],                // mesmo formato que iria pra /registrar-relatorio-injecao
  pausas: [...],
  status: "preenchendo" | "aguardando_conexao" | "sincronizado"
}
```

Enquanto esse objeto existir e não estiver `sincronizado`, a tela de login **não oferece "Registrar operação offline" de novo** nesse dispositivo (o link soma ao aviso do item 4, não substitui) — reforça a regra de "só uma por vez" pedida.

### 4. Conexão volta no meio do preenchimento

Detecta via `window.addEventListener('online', ...)` + mesma checagem ativa por `fetch` do item 1 (não só o evento do navegador, que não é 100% confiável — mesmo raciocínio já documentado em `tentarSincronizarFilaPendentes`, `data.js`).

- Mostra um **banner fixo, não bloqueante**: *"Conexão restabelecida. Termine este registro; depois disso, o modo offline ficará bloqueado até alguém entrar com um perfil."*
- A pessoa **continua** preenchendo/finalizando normalmente — não é interrompida no meio.
- Ao clicar em "Registrar" (fim do formulário offline): tenta sincronizar na hora, já que a rede está de volta (rota nova, item 5); se der certo, `status: 'sincronizado'`, remove o objeto pendente da chave local e mostra confirmação — *"Enviado para validação. Peça a alguém com perfil Administrador para revisar."*
- **Trava pós-uso**: com o objeto pendente vazio/sincronizado, o link "Registrar operação offline" continua existindo na tela de login (é sempre visível), mas o próprio fluxo de conectividade do item 1 vai barrar de novo se a rede já estiver de volta ("exclusivo para quando não há internet") — não precisa de uma trava adicional além da checagem que já existe: a MESMA regra do item 1 cobre naturalmente "já tem internet agora, então volta pro login normal".

### 5. Sincronização — rota nova, sem sessão, com fila própria no servidor ✅

Um endpoint que aceita o payload **sem exigir sessão de usuário** (não existe, é offline) nem `podeControlarOperacao` — mas não fica totalmente aberto:

- `POST /operacao-offline/enviar` — recebe `{ idTemp, formRecord, tracos, pausas }`. Grava numa fila própria, **separada** de `operacoes` — arquivo JSON (`public/db/operacoes_offline_pendentes.json`), reaproveitando o padrão de `lib/fila-avaliacao.js` (agora em `lib/fila-offline.js`) — nunca insere direto em `operacoes`/`tracos` (isso só vai acontecer na aprovação, item 6, ainda não implementado, reaproveitando `POST /registrar-operacao` + `/registrar-relatorio-injecao`, sem duplicar lógica).
- **Idempotência**: `idTemp` como chave única (`lib/fila-offline.js`, `adicionarNaFilaOffline`) — reenvio (ex.: a resposta HTTP se perdeu mas o POST chegou) não duplica a entrada na fila; responde 200 de novo, sem gravar nada a mais.
- **Validação estrutural mínima** (não regra de negócio — isso fica pro pipeline de aprovação, item 6): `idTemp` precisa ser string no formato `OFF-<uuid>`, `formRecord` precisa ser objeto, `tracos` precisa ser lista. Payload que não bate com isso é recusado com 400, sem tocar na fila.
- **Rate limiting por IP** (`lib/rate-limit-ip.js` — genérico, não amarrado a `lib/auth.js`/senha, mas com o mesmo raciocínio de persistência): 20 envios por IP a cada 15 minutos, persistido em `private/rate-limit-operacao-offline.json` (sobrevive a restart do processo). Passou do limite → 429 com `Retry-After`, sem gravar na fila.
- **Tamanho máximo de payload**: já vinha de graça — é aplicado globalmente a todo `POST`, antes de qualquer rota (`MAX_BODY_BYTES`, `server.js` — ver *Setor de Manutenção*).
- **Em aberto** (não implementado nesta fase): exigir que o `deviceId`/cookie `lw_device_id` (ver *Identidade do dispositivo*) já seja um dispositivo conhecido antes de aceitar a sincronização — não bloquearia o registro offline em si (que não tem como checar isso sem rede), mas poderia ser uma camada a mais de confiança antes de cair na fila do Master.

**Nota sobre o item 5**: implementado em `lib/fila-offline.js` (fila JSON, idempotente por `idTemp`), `lib/rate-limit-ip.js` (rate limit genérico por IP, persistido em JSON — não reaproveita a tabela SQL `tentativas_senha_ip` de `lib/auth.js` porque aquela é especificamente sobre validar o segredo do Administrador, com sua própria tabela; este é sobre volume de chamadas a uma rota sem segredo nenhum envolvido) e `lib/rotas/operacao-offline.js` (a rota em si, seguindo o mesmo padrão factory + `tentar(req,res,urlPath)` do resto de `lib/rotas/`). Coberto por `test/operacao-offline-enviar.test.js` (9 testes: envio válido, nunca aparece em `historico.json`, idempotência, validação estrutural — 3 casos —, JSON malformado, payload inválido não grava na fila, rate limit bloqueando na 21ª tentativa). Suíte adjacente (`registrar-operacao`, `auth`, `rate-limit-persistencia`, `backup-geral-fluxo-completo`, `boot-tela-carregamento` — 27 testes) rodada depois da mudança, 100% verde, sem relação quebrada. Itens 6 (página do Master "Operações a Validar") e 7 (comportamento do Contador de Traços na aprovação) também já estão implementados — ver abaixo.

### 6. Página do Master — "Operações a Validar" ✅

Nova aba em **Configurações → Operações a Validar** (perfil **Administrador**, cadastrado ou senha mestra, **e também Administrativo** — mesma regra de sempre, ver `ABAS_CONFIG_ADMIN`, `lib/perfis.js`) listando os itens em `operacoes_offline_pendentes.json` (`lib/fila-offline.js`), cada um com:

- Dados preenchidos offline (bateria, turno, horários, quantidade de traços), num card de revisão compacto — não a UI de detalhe completa de Registro de Baterias (ficaria grande demais pra uma lista de pendentes).
- **✏️ Corrigir antes de aprovar**: como o relógio do dispositivo offline pode estar errado (item 8), dá pra ajustar **início, fim e ID da bateria** direto no card, antes de validar (`POST /operacao-offline/corrigir`, PATCH parcial em cima do registro pendente — `lib/fila-offline.js`, `atualizarNaFilaOffline`). **Diferença em relação ao plano original**: não reaproveita a tela completa de Edições Avançadas (essa opera em cima de uma operação que já existe em `operacoes`, com sua própria UI grande e todo o histórico de ajustes — não fazia sentido reaplicar aqui, num registro que ainda nem existe de verdade). É um ajuste funcional mais simples, focado nos 3 campos mais prováveis de precisarem de correção.
- **✅ Validar** (`POST /operacao-offline/validar`): grava a operação de verdade (`origem_offline: true`, `validado_por`, `validado_em` — 3 colunas novas em `operacoes`, ver `db.js`/`lib/db/operacoes-qualidade.js`), cria os Berços Visuais (sempre no estado padrão — nunca lê/reseta o snapshot ao vivo de uma operação diferente que possa estar rolando naquele momento, ver comentário grande em `lib/rotas/operacao-offline.js`), entra na fila de avaliação do Setor de Qualidade normalmente (`adicionarNaFilaNaoAvaliadas`) e grava os traços em `relatorio_injecao.json` (mesma transformação que `LW.registrarRelatorioInjecao` faz no navegador, replicada no servidor). Depois de validada, é indistinguível de uma operação registrada ao vivo, exceto pelos 3 campos de auditoria acima. **Diferença em relação ao plano original**: não dispara `POST /registrar-operacao` por HTTP de verdade — faria o `podeControlarOperacao` (checagem de `deviceId` autorizado) entrar em cena de novo, o que não faz sentido pra esse fluxo (o dispositivo ORIGINAL nunca teve chance de ser autorizado — é justamente o cenário sem rede). Em vez disso, chama direto as mesmas funções de baixo nível que aquela rota chama por baixo dos panos (`db.SQL_INSERIR_OPERACAO`, `db.operacaoParaRow`, etc.) — resultado idêntico, sem essa checagem que não se aplica aqui.
- **❌ Recusar** (`POST /operacao-offline/recusar`): remove da fila, sem tocar em `operacoes`/`tracos`/contador — nunca chegou a existir de verdade.
- **Idempotência da aprovação**: validar o mesmo `idTemp` duas vezes seguidas (ex.: duplo clique) não duplica a operação — a 2ª chamada não encontra mais o item na fila (removido na 1ª) e responde erro claro, em vez de um 500 ou uma duplicata silenciosa.

**Nota sobre os itens 6/7**: implementado em `lib/rotas/operacao-offline.js` (4 rotas novas: `GET /operacao-offline/pendentes`, `POST /operacao-offline/corrigir`, `POST /operacao-offline/validar`, `POST /operacao-offline/recusar` — todas exigindo `sessaoOuAdmin`), `lib/fila-offline.js` (`removerDaFilaOffline`, `atualizarNaFilaOffline`), schema (`db.js` + `lib/db/operacoes-qualidade.js` — 3 colunas novas em `operacoes`, com migração leve pra bancos já existentes) e frontend (`public/partials/modal-config.html`, aba nova; `public/js/app-core.js`, `cfgRenderOperacoesOffline`/`cfgValidarOperacaoOffline`/`cfgRecusarOperacaoOffline`/`cfgAbrirCorrecaoOperacaoOffline`/`cfgSalvarCorrecaoOperacaoOffline`; `public/js/data.js`, os 4 fetches correspondentes; `lib/perfis.js`/`lib/itens-permissao.js`, item de permissão `config-operacoes-offline`). Coberto por `test/operacao-offline-validar.test.js` (9 testes: gating de sessão nas 4 rotas, aprovação completa com todas as 6 verificações — operação real/berços/fila de avaliação/traço gravado/contador incrementado/some da fila —, idempotência da aprovação, validação de campos obrigatórios, corrigir-então-validar, recusar) e `test/config-operacoes-offline-ui.test.js` (4 testes de UI via jsdom real, clicando nos botões de verdade: listagem, Validar, Corrigir com painel pré-preenchido, Recusar). Suíte de regressão ampla (registro ao vivo, auth, rate limit, backup/restauração/importação, setor de qualidade, permissões, usuários — 121 testes) rodada depois da mudança, 100% verde.

### 7. Contador de Traços do Dia — comportamento ✅

Ponto crítico, porque é um contador **global e compartilhado** (`contador_tracos`, uma linha por dia, incrementada por qualquer um que registre — ver *Modo de Teste* e `lib/contador-tracos-estado.js`), não algo isolado por operação:

- **Enquanto pendente de validação, NÃO incrementa** — um lançamento offline não confirmado não infla o número que todo mundo vê em tempo real (`GET /total-tracos-hoje`), especialmente porque pode ser recusado, ou corrigido pelo Master antes de aprovar.
- **Incrementa só na aprovação** (`incrementarContadorTracosHoje`, chamado dentro do mesmo handler de `POST /operacao-offline/validar` — ver item 6), com a quantidade de traços **já revisada**: se o Master corrigiu o registro antes de validar (`POST /operacao-offline/corrigir`), soma a versão corrigida, nunca a original digitada offline.
- Isso espelha o que já acontece no fluxo normal: o contador só sobe no fim de uma operação — nunca antecipado. A diferença é ONDE esse "fim" acontece: no fluxo normal é a própria pessoa que registrou; no offline, é o Master que valida.
- **Todo traço offline conta como novo** — a operação simplificada implementada não reaproveita o conceito de "sobra de outra operação" (isso dependeria de consultar o servidor em tempo real pra saber o que sobrou, o que não existe no fluxo offline, ver item 8) — soma sempre o total de traços que a operação tem no momento da aprovação.
- **Dia usado**: o contador soma no dia de HOJE (dia real do servidor, no momento da validação — mesma regra de `todayBrasiliaServer()` já usada por `lerContadorTracosHoje`), não no dia gravado dentro do registro da operação. Fica em aberto se esse descompasso merece um aviso visual na tela de validação quando a operação é de um dia diferente (não implementado nesta fase).

### 8. Coisas a decidir/ter em mente antes de implementar

- **Relógio do dispositivo offline**: `tempo_min`/`houve_atraso` de uma operação normal são conferidos no servidor a partir de horários que o PRÓPRIO servidor viu em tempo real (WebSocket). Offline não existe isso — os horários vêm 100% do relógio local do tablet/PC, que pode estar errado (fuso, hora dessincronizada). É exatamente pra cobrir esse risco que a revisão do Master (item 6, ✅ implementado) permite corrigir início/fim antes de aprovar, em vez de aceitar os horários cegamente — só que com um ajuste inline simples (3 campos), não a tela completa de Edições Avançadas (ver nota no item 6 sobre por quê).
- **Cache pro formulário funcionar 100% offline** (item 2) — **decidido**: abrir uma exceção pontual no Service Worker (`public/service-worker.js`) e incluir `config.json` em `PRECACHE_URLS`, junto com o resto da casca estática. Hoje esse arquivo é propositalmente excluído do cache (ver `_ehEstatico`, que barra tudo sob `/db/`) porque é dado de produção — a única exceção aberta por este plano é especificamente esse arquivo (baterias cadastradas, tipos de montagem, capacidades), que muda raramente e é justamente o que o formulário offline precisa pra existir sem rede. Consequência prática: o dispositivo só terá `config.json` em cache depois de uma instalação normal do PWA (ver `pwa-register.js`) — ou seja, é preciso "instalar" o app (Adicionar à Tela Inicial) e abri-lo pelo menos uma vez online antes de contar com o modo offline puro; simplesmente visitar `login.html` no navegador sem instalar não garante que o `install` do Service Worker rodou o precache completo. Isso deve ficar explícito no link "Registrar operação offline" da tela de login ou num aviso na 1ª configuração do dispositivo, pra não pegar ninguém de surpresa numa queda de rede sem o app previamente instalado. `config.json` continua sendo atualizado normalmente pelo Service Worker (estratégia network-first já existente) sempre que o dispositivo estiver online — o cache só é usado como fallback quando a rede cai, nunca substitui a leitura ao vivo.
- **Múltiplas abas/dispositivos offline ao mesmo tempo**: cada navegador tem seu próprio `localStorage` — nada impede 2 tablets diferentes registrando offline ao mesmo tempo, cada um com seu próprio pendente. Isso é esperado (não existe "dono" nem singleton no modo offline, diferente da operação ao vivo) — a fila do Master (`operacoes_offline_pendentes.json`, ✅ implementada) suporta mais de um item de uma vez sem problema, mesmo que cada DISPOSITIVO só tenha um pendente por vez (item 3).
- **IDs**: `idTemp` (prefixo `OFF-`) nunca é o `id` final da operação — ✅ implementado: na aprovação, o `id` real é derivado de forma determinística (`'op_off_' + idTemp.slice(4)`), evitando colisão com IDs de operações registradas ao vivo (que usam outro formato, `'op_' + timestamp`).
- **Reaproveitar sobra de outra operação no Contador de Traços**: não implementado (ver item 7) — todo traço offline conta como novo na aprovação, mesmo que na prática reaproveite sobra de uma bateria anterior. Dependeria de consultar o estado do servidor em tempo real no momento do registro, o que não existe (nem pode existir) no fluxo puramente offline.
- **Expiração**: um pendente que nunca sincroniza (dispositivo trocado, `localStorage` limpo) fica preso pra sempre nesse navegador — **decidido e implementado**: nunca apagar nada sozinho (um pendente é um registro real de operação; apagar à toa seria perder trabalho de verdade), só tornar **visível** quando algo está esperando envio há tempo demais (`LIMIAR_AVISO_HORAS = 24`, `public/js/offline-operacao.js`, `renderFila`) — item mais antigo aparece primeiro, destacado, com aviso pra checar a conexão ou avisar um Administrador. Descartar continua manual (botão "✕ Descartar", já existia). Coberto por `test/operacao-offline-fila-aviso-idade.test.js`.
- **Aviso visual de descompasso de dia** (ver item 7, "Dia usado"): quando a operação aprovada é de um dia diferente do dia real da aprovação, o contador soma no dia de hoje sem nenhum aviso na tela de validação — não implementado.

### 9. Conexão cai NO MEIO de uma operação normal (logada) — aviso ao vivo

Cenário diferente do resto deste plano (ver *Fora de escopo*, no topo): a pessoa está **logada**, controlando a operação normalmente pela tela de Registrar Operação de sempre (`public/js/operacao.js`), e a internet cai **durante** o preenchimento — não no clique de "Registrar", antes dele.

**O que já existe hoje, sem precisar de nada novo:**
- O estado da operação em andamento já é salvo continuamente em `localStorage` (`lw_op_current`, `LW.saveOperacaoAtual(state)` — chamado a cada persistência de estado, `operacao.js`), **independente de conexão**. Nada do que foi preenchido se perde, mesmo numa queda de internet, aba fechada à força ou navegador travando.
- Ao clicar em **"Registrar"**: se a conexão já caiu, a tentativa de envio falha com `TypeError` (é assim que o `fetch()` do navegador sinaliza "nem consegui chegar no servidor") e a operação cai automaticamente na fila `lw_fila_operacoes_pendentes` (`_enfileirarEContinuar`, `operacao.js`) — sincronizada sozinha assim que a conexão volta (evento `online` + checagem periódica, `tentarSincronizarFilaPendentes`, `data.js`). Se a conexão **já estiver de volta** no clique, segue o fluxo normal direto (registra na hora, sem passar pela fila). Nenhum dos dois comportamentos muda com este item — ele só adiciona visibilidade ao que já acontece.

**O que falta, e este item adiciona ao plano:** hoje o aviso de "sem conexão" só aparece **depois** de tentar registrar e falhar (`_mostrarAvisoConexao`, banner de 8 segundos) — quem está preenchendo uma operação longa não tem como saber, em tempo real, que já está sem internet enquanto ainda está digitando. Proposta:

- Monitorar `window.addEventListener('offline'/'online', ...)` (mesmo padrão do restante deste plano, reforçado por uma checagem ativa por `fetch`, já que o evento do navegador sozinho não é 100% confiável) **enquanto a tela de Registrar Operação estiver com uma operação em andamento** (`status !== 'idle'`).
- Ao detectar a queda: mostra o banner já existente (`_mostrarAvisoConexao`), mas de forma **persistente** enquanto durar a queda (não os 8s padrão que ele já tem) — *"📡 Sem conexão. Seus dados estão salvos neste computador; pode continuar preenchendo normalmente."*
- Ao detectar o retorno: troca pro aviso de sucesso já existente, com um texto confirmando que ao finalizar vai registrar direto (já que a conexão voltou ANTES do clique em Registrar, não depois) — *"🌐 Conexão restabelecida. Pode finalizar normalmente."*, some sozinho depois de alguns segundos (comportamento padrão do banner).

Reaproveita 100% da UI (`_mostrarAvisoConexao`) e da lógica de fila (`enfileirarOperacaoPendente`/`tentarSincronizarFilaPendentes`) que já existem — este item é só sobre **quando** o aviso aparece (ao vivo, assim que a rede cai) em vez de só no momento de registrar.

**Status:** plano implementado e aplicado (`_conexaoLive_marcarCaiu`/`_conexaoLive_marcarVoltou`, `public/js/operacao.js`) — evento `online`/`offline` do navegador + checagem ativa por `fetch` a cada 15s, banner persistente enquanto a queda durar. Coberto por `test/operacao-aviso-conexao-ao-vivo.test.js`.

### 10. Numeração inicial customizável + marcação de "sobra" (com nota e vínculo na validação) — IMPLEMENTADO

Dois pedidos distintos, ambos só na tela offline (`public/offline.html`/`public/js/offline-operacao.js`):

**a) Número inicial do contador de traços editável** — antes, todo rascunho novo sempre numerava os traços a partir do 1. Agora, ao entrar num rascunho **novo** (nunca ao retomar um em andamento), um modal pergunta *"Quantos traços já foram feitos hoje?"* — a pessoa digita um número e clica **Salvar** (os traços desta operação passam a contar a partir do seguinte), ou clica **"Não sei — começar do 1"**. Puramente uma ajuda visual/de memória pro operador: a numeração que efetivamente entra no sistema continua sendo decidida de novo pelo Administrador na validação (item 6, "renumeração manual do dia") — esse número nunca é gravado como `num_traco` final. Implementado em `criarStateVazio`/`numeroDoTraco`/`mostrarModalNumeroInicial` (`offline-operacao.js`) e persiste no rascunho salvo (`numero_inicial_traco`, sobrevive a um F5).

**b) Marcador "Este traço é uma sobra" + nota + vínculo na validação** — dentro de cada card de traço, um checkbox "♻️ Este traço é uma sobra" revela um campo de nota livre (`nota_sobra`) — **só uma ajuda de memória pro próprio operador**, já que offline não tem como consultar o sistema pra saber se existe sobra ativa de verdade (mesmo motivo do item 8 do plano original, acima, ter descartado o reaproveitamento automático). Na tela **Configurações → Operações a Validar**, o Administrador vê a nota de cada traço marcado e pode digitar uma referência ao traço/operação original num campo de texto + **"🔗 Salvar vínculo"** — reaproveita a rota `POST /operacao-offline/corrigir` já existente (aceita substituir o array `tracos` inteiro, não precisou de rota nova).

Como a tabela `tracos` tem uma lista fechada de colunas na hora de aprovar (`_tracosParaLinhasRelatorio`, sem espaço pra `eh_sobra`/`nota_sobra`/vínculo como colunas próprias — mudar o schema só pra isso não valeu a pena), a informação é **dobrada dentro do próprio campo `obs`** do traço no momento da validação (`_montarObsComSobra`, `lib/rotas/operacao-offline.js`), como um marcador `[♻️ SOBRA — nota do operador: ... — vinculado a: ... ]` prefixado ao `obs` original — inclusive avisando explicitamente quando ainda não foi vinculado, pra nunca ficar silencioso/ambíguo.

**Status:** implementado. Testes em `test/operacao-offline-sobra.test.js` (5 casos: marcação chega e persiste na fila, `/corrigir` grava o vínculo sem afetar outros campos/traços, validação dobra nota+vínculo no `obs` — nos dois campos `obs` que existem —, validação sem vínculo ainda avisa explicitamente, e um traço comum sem `eh_sobra` continua gravando `obs` exatamente como antes). Suíte completa de operação offline (38 testes) passando.


- **3 rotas continuam exigindo senha a cada chamada, por design**: `/mesclar-backup-dados`, `/restaurar-backup-dados` e `/restaurar-backup-geral` — as mais destrutivas do sistema (a última pode sobrescrever dados de produção, configurações e o cadastro de usuários) — não usam sessão, mesmo o resto das rotas administrativas já tendo migrado (ver *Autenticação e Sessão*, acima). É intencional (defesa em profundidade), não um esquecimento.
- Backups de segurança (`backups-seguranca/`) não têm rotina de limpeza automática.
- "Volume por placa" (referência informativa na tela de Operação) não é atualizado automaticamente ao criar um novo tipo de montagem — precisa ser adicionado manualmente no `config.json`.
- Testes automatizados (`test/`) cobrem autenticação/sessão, Setor de Qualidade, registrar operação (`test/registrar-operacao.test.js`), traços (`test/registrar-relatorio-injecao.test.js`), editar operação/traço (`test/edicao-operacao-traco.test.js`), paradas (`test/paradas-crud.test.js`), sobra (`test/sobra-crud.test.js`), mesclar backup de dados (`test/mesclar-backup-dados.test.js`), importação (`test/importacao.test.js`) e o fluxo de ponta a ponta do Backup Geral (`test/backup-geral-fluxo-completo.test.js`, além dos testes de regras isoladas já existentes em `test/backup-dados-vs-geral.test.js`, `test/backup-metas-opcional.test.js` e `test/restaurar-backup-checklist.test.js`).

## One Page Report — IMPLEMENTADO

Tela (`public/partials/page-one-page-report.html`) de dashboard de página única no modelo do relatório executivo mensal já usado pelo time (4 blocos — **Segurança**, **Produção**, **Refugo**, **Expedição** — mais um rodapé de **Assuntos Gerais**), pra dar uma visão rápida e imprimível do mês sem precisar abrir os dashboards analíticos um por um. Acesso pelo Menu Principal ou pela barra de navegação lateral (`showPage('one-page-report')`), disponível a todos os perfis (`lib/perfis.js`).

### Levantamento: o que já existia vs. o que foi criado

| Bloco do relatório | Dado | Situação | Fonte |
|---|---|---|---|
| Produção | Injeção de baterias por dia/linha, m² total | ✅ Já existia | tabela `operacoes` (SQLite) |
| Refugo | % refugo diário, traços por linha | ✅ Já existia | tabelas `avaliacao_paineis`/`traco_usos` (SQLite) |
| Segurança | Ocorrências, acumulado do mês, dias sem acidentes | ✅ Criado (Fase 1) | tabela `seguranca_ocorrencias` — `lib/db/seguranca-ocorrencias.js` |
| Expedição | Cargas expedidas, m² por semana (S1–S4), acumulado, forecast | ✅ Criado (Fase 2) | tabela `expedicao_cargas` — `lib/db/expedicao.js` |
| Todos os blocos | Comentários / Próximos passos + Assuntos Gerais (texto + fotos com tema) | ✅ Criado (Fase 3) | JSON simples por mês — `lib/db/one-page-comentarios.js` |

Regra combinada em todas as fases: **onde não há dado real, a tela mostra "Dado indisponível" no lugar do gráfico/número** (`opr-indisponivel`, `public/css/one-page-report.css`) — nunca zero disfarçado de dado real. Vale tanto pro histórico ainda curto de Segurança/Expedição quanto pra qualquer falha de rede no fetch do frontend.

### Estrutura final

| Camada | Arquivo | O que faz |
|---|---|---|
| Dados — Segurança | `lib/db/seguranca-ocorrencias.js` | CRUD de ocorrências + `diasSemAcidentes()` (calculado a partir de `MAX(data)`, nunca gravado como coluna) |
| Dados — Expedição | `lib/db/expedicao.js` | CRUD de cargas + agregação semanal (S1–S4), acumulado do mês, forecast |
| Dados — Comentários | `lib/db/one-page-comentarios.js` | Texto livre por bloco + Assuntos Gerais ({texto, fotos: [{id, imagem, tema}]}, fotos comprimidas no navegador antes de salvar, mesma técnica de `_comprimirFotoDefeito`/setor-qualidade.js), todos os meses num único `public/db/one-page-comentarios.json` |
| Rotas | `lib/rotas/seguranca.js` | `GET /db/seguranca_ocorrencias.json`, `GET /seguranca/dias-sem-acidentes`, `POST /registrar-ocorrencia-seguranca`, `POST /excluir-ocorrencia-seguranca` |
| Rotas | `lib/rotas/expedicao.js` | `GET /db/expedicao_cargas.json`, `GET /expedicao/agregacao-semanal`, `POST /registrar-carga-expedicao`, `POST /excluir-carga-expedicao` |
| Rotas | `lib/rotas/one-page-report.js` | `GET /db/one-page-comentarios.json`, `POST /salvar-comentarios-one-page-report`, e o endpoint de agregação `GET /db/one-page-report.json?mes=YYYY-MM` (junta os 5 blocos num payload só, já calculado por mês) |
| Frontend | `public/partials/page-one-page-report.html` + `public/css/one-page-report.css` + `public/js/one-page-report.js` | Tela em si — gráficos SVG próprios (barra/donut), consome `GET /db/one-page-report.json`, com fallback pra dados de exemplo só se a rede falhar |

Escrita (registrar/excluir ocorrência de Segurança e carga de Expedição, salvar Comentários) exige sessão de administrador (`sessaoOuAdmin`) — nenhuma dessas ainda é uma área cadastrada em `AREAS_DE_EDICAO` (`lib/perfis.js`); qual perfil pode editar cada bloco é uma decisão de produto em aberto, não técnica. Leitura (todos os `GET`) é livre, mesmo modelo do resto do sistema.

**Testes:** `test/seguranca-ocorrencias-crud.test.js` (10), `test/expedicao-crud.test.js` (13), `test/one-page-comentarios-crud.test.js` (15, incluindo fotos de Assuntos Gerais — tema, id gerado no servidor, limite de 12 fotos, imagem inválida recusada), `test/one-page-report.test.js` (8, cobrindo o endpoint de agregação — mês ausente/inválido, cada bloco isoladamente, conversão de comentários texto→array) — 46 casos no total.
