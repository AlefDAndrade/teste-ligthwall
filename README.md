# Lightwall SC — Sistema de Injeção

Sistema interno de controle de operações de injeção de baterias (placas cimentícias / EPS), com registro de traços, relatórios, dashboards analíticos e administração de configurações.

## Stack

- **Backend**: Node.js puro (módulo `http`, sem framework), servindo arquivos estáticos e uma API simples em JSON. A lógica vinha toda num `server.js` só; está sendo fatiada por fases pra `lib/` (ver *Fatiamento de server.js*, abaixo).
- **Frontend**: HTML/CSS/JS sem framework — `index.html` é gerado a partir de pedaços (`public/partials/` + `public/index.template.html`) por um pequeno script (`build-index.js`), em vez de ser editado à mão como um arquivo só de 5 mil linhas (ver *Fatiamento de index.html*, abaixo). Fora isso, continua sem framework nem bundler — é só um passo extra antes de rodar/editar.
- **"Banco de dados"**: em migração, por fases, de arquivos JSON (`public/db/`) pra **SQLite** (`better-sqlite3`) — ver seção dedicada, abaixo. Os arquivos JSON que ainda não foram migrados continuam exatamente como sempre.
- **Dependências**: `xlsx` (exportação/importação de Excel), `jszip` (geração e leitura de backups `.zip`), `ws` (WebSocket da Operação em Andamento), `better-sqlite3` (banco de dados). Nenhuma dependência nova foi adicionada nas mudanças de segurança/testes abaixo — `lib/sessao.js` usa só `crypto` nativo do Node, e os testes usam o test runner nativo (`node:test`).

## Como rodar

```bash
npm install
npm start
```

`npm start` (e `npm run dev`) já rodam `node build-index.js` automaticamente antes de subir o servidor (via `prestart`/`predev` no `package.json`) — então `public/index.html` está sempre atualizado com o que tiver em `public/partials/`, sem precisar lembrar de um passo manual. Pra gerar manualmente sem subir o servidor (ex: só pra conferir o resultado), `npm run build`.

O servidor sobe em `http://localhost:3000` (ou na porta da variável de ambiente `PORT`, se definida — útil pra rodar os testes numa porta separada sem conflitar com um servidor de desenvolvimento já aberto). Requer Node `>= 18`.

## Testes automatizados

```bash
npm test
```

Roda a suíte em `test/` usando o test runner nativo do Node (`node --test` — nenhuma dependência nova). `test/helpers/servidor-teste.js` sobe uma cópia ISOLADA do `server.js` de verdade (não um mock) numa porta própria, dentro de `.test-tmp/` (gitignored) — nunca toca nos dados da instalação de verdade. Cobertura atual: autenticação (hash de senha, migração do formato legado, rate limiting) e a sessão de administrador que protege `GET /db/security.json` e `POST /salvar-security`. Ainda não cobre o resto das rotas (registrar operação, traços, backup geral etc.) — é um começo, não a suíte completa.

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
server.js               # servidor HTTP + rotas da API
build-index.js          # monta public/index.html a partir do template + partials
package.json
```

`backups-seguranca/`, `backups-automaticos/`, `logs/` e `private/` são criadas automaticamente pelo servidor e nunca devem ser versionadas — já estão no `.gitignore`. Todas ficam **fora** de `public/`, então nenhuma é servida como arquivo estático nem acessível por URL direta.

`public/db/teste/` é criada automaticamente na primeira vez que o **Modo de Teste** é usado (ver seção dedicada, abaixo) — mesmos arquivos de uma operação normal (`historico.json`, `relatorio_injecao.json`, `contador_tracos.json`, `ajustes_tracos.json`, `sobra.json`), só que isolados, pra nunca misturar com dados reais. Também não é versionada.

## Fatiamento de server.js

`server.js` era um arquivo único que cresceu bastante; está sendo fatiado por fases pra `lib/`, extraindo um pedaço autocontido por vez (sem mudar lógica nenhuma — só onde o código mora):

| Fase | O que saiu | Pra onde |
|---|---|---|
| 1 | Hash de senha (scrypt + compat. legado) e rate limiting de tentativas | `lib/auth.js` |
| 2 | Sessão de Administrador | `lib/sessao.js` |

Ainda por fazer: validação de path/restauração de backup, geração/restauração dos `.zip` de Backup de Dados, e o canal WebSocket da Operação em Andamento — são os próximos candidatos, mas ainda vivem em `server.js`.

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
- **Backup e Restauração também não mudam de comportamento**: "Backup de Dados" e o backup automático diário exportam o conteúdo atual da tabela como JSON (mesmo formato); "Restaurar Backup de Dados" substitui o conteúdo da tabela inteira (dentro de uma transação) em vez de escrever um arquivo. "Backup Geral" inclui `data/lightwall.sqlite` automaticamente (já varre o projeto inteiro) — com um detalhe importante: roda um `PRAGMA wal_checkpoint(TRUNCATE)` antes de zipar, senão escritas recentes podem estar só no arquivo `-wal` e não no `.sqlite` principal.
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

## Perfis de usuário

Escolhidos na tela de login (`login.html`), sem necessidade de cadastro prévio:

| Perfil | Acesso |
|---|---|
| **Operador** | Registrar Operação + todos os dashboards e relatórios. Sem senha. |
| **Analista** | Todos os dashboards e relatórios. **Sem** acesso a Registrar Operação. Sem senha. |
| **Administrador** | Acesso total — inclui Configurações, Backup/Restauração e Importação. **Sempre** pede senha na tela de login, mesmo que já tenha sido usado antes neste navegador. |

A sessão (`sessionStorage`) dura enquanto a aba estiver aberta. Um F5 dentro do sistema não exige login de novo; fechar a aba ou voltar à tela de login, sim.

## Páginas

- **Registrar Operação** — fluxo de injeção: seleção de bateria/tipo de montagem, traços, tempos, atrasos, sobra de traço entre operações.
- **Desempenho Turnos** — KPIs e gráficos por turno.
- **Registro de Baterias** — histórico de operações, filtros, exportação Excel, colunas ocultáveis.
- **Relatório de Injeção** — traços por operação (inclusive reaproveitamentos, exibidos como uma linha por uso).
- **Qualidade dos Traços (CEP)** — estabilidade de receitas, frequência de ajuste por insumo, alertas.
- **Análise Operacional** — produção, atrasos, ranking de baterias, correlações.
- **OEE** — ver seção dedicada abaixo.
- **Menu Principal** — atalhos rápidos + (admin) Backup, Restauração e Importação.

Atalho `F1` abre o modal de ajuda com todos os atalhos de teclado disponíveis.

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

### Autorizados

Em **Menu → Configurações → Autorizados**: controla quais computadores podem iniciar, encerrar e registrar operações em **Registrar Operação** (ver *Operação em Andamento*, abaixo). Cada item é `{ deviceId, nome, autorizadoEm }`, guardado em `config.json` (`dispositivosAutorizados`).

- **Lista vazia (padrão)**: sem restrição — qualquer computador pode controlar, igual ao comportamento antes desta funcionalidade existir.
- **Lista com 1+ item**: só os `deviceId`s dela podem controlar. Os demais continuam podendo **acompanhar a operação ao vivo** (WebSocket), só não conseguem interagir.
- A própria tela mostra o `deviceId` do computador que está olhando (gerado e persistido em `localStorage`, `lw_device_id` — ver *Log de Acesso*), já pré-preenchido no campo de autorizar — é assim que se autoriza "este computador aqui".
- Cada autorizar/remover salva na hora (sem precisar do botão "✓ Salvar Configurações", que é só da aba Baterias e Montagem).
- Reforçado no **servidor**, não só escondido na tela: as rotas `/salvar-operacao-andamento`, `/registrar-operacao`, `/registrar-relatorio-injecao` e `/confirmar-tracos-hoje` recusam (HTTP 403) qualquer `deviceId` fora da lista, quando ela não está vazia.
- **Na tela** (Registrar Operação): quem não está autorizado vê um banner "🔒 Você está só acompanhando" e todos os campos/botões ficam desabilitados (`<fieldset disabled>` envolvendo a tela inteira, inclusive os traços renderizados dinamicamente). Reaplicado sempre que a aba é aberta — não precisa de F5 se o Administrador acabou de autorizar este computador.
- Atalhos de teclado (Iniciar/Encerrar/Registrar/Resetar) não dependem só do `<fieldset>` — cada uma dessas 4 ações também checa a autorização no próprio código, então um atalho não contorna a trava.

**Dono da operação** (quando há 2+ dispositivos autorizados): só estar na lista não basta — o **primeiro** dispositivo autorizado a dar "Iniciar Injeção" numa operação vazia se torna o **dono** dela (`donoDeviceId`, gravado em `operacao_andamento.json`, recalculado sempre no servidor — nunca confia no que o cliente manda). Enquanto a operação estiver rodando:
- Só o dono pode editar campos, encerrar ou registrar — outro dispositivo autorizado tentando qualquer uma dessas ações recebe HTTP 409 ("já está sendo controlada por outro computador") e vê o banner "👀 Outro computador autorizado está controlando esta operação agora".
- **Escape hatch**: "🗑️ Limpar Tudo" funciona pra **qualquer** dispositivo autorizado, mesmo sem ser o dono — é assim que se recupera uma operação travada por um computador que ficou offline, travou, ou esqueceu de encerrar. Limpar também libera o "dono" — o próximo a iniciar assume.
- O dono é zerado junto com a operação (registrar, resetar, ou forçar) — sempre há, no máximo, um dono por vez, nunca persiste entre operações.

**Limitação conhecida**: `deviceId` não é uma credencial de segurança de verdade (ver *Log de Acesso*) — é só uma identidade de conveniência. Quem tiver acesso físico ao computador autorizado controla a operação; isso restringe *qual máquina*, não *quem* a está usando.

## Backup e Restauração (Administrador)

Um único card no menu ("💾 Backup e Restauração") abre um painel com todas as opções:

| Opção | O que faz |
|---|---|
| **Backup de Dados** | Baixa um `.zip` com os arquivos de dados de `public/db/` (histórico, traços, paradas, avaliações de qualidade etc. — 13 no total, alguns reconstruídos a partir do SQLite). Gerado no navegador. |
| **Backup Geral** | Baixa um `.zip` com o projeto inteiro (código + dados, exceto `node_modules`/`.git`). Gerado no servidor. |
| **Restaurar Dados** | Sobrescreve `public/db/` a partir de um backup de dados. |
| **Restaurar Geral** | Sobrescreve o projeto inteiro a partir de um backup geral. **Exige reiniciar o servidor manualmente depois**, pra mudanças em `server.js` valerem. |
| **Backups Automáticos** | Lista os backups diários gerados pelo servidor (ver abaixo), com link de download pra cada um. |

Toda restauração: exige a senha do administrador (reverificada no servidor), valida o formato de cada arquivo antes de gravar qualquer coisa, e salva automaticamente uma cópia de segurança do estado atual em `backups-seguranca/` (fora de `public/`, nunca servida pela web) antes de sobrescrever. A restauração geral pede também uma frase de confirmação (`RESTAURAR TUDO`) e bloqueia caminhos suspeitos (`../`, `node_modules/`, `.git/`).

`backups-seguranca/` cresce a cada restauração feita — não há limpeza automática; remova as mais antigas manualmente quando quiser.

### Backup automático diário

O próprio `server.js` gera um backup de dados todo fim de dia, sem depender de ninguém com o navegador aberto:

- Roda a partir das **23:50** (horário de Brasília) — checado a cada minuto, e também uma vez no boot do servidor (cobre o caso dele subir depois desse horário).
- **Só gera se houve pelo menos uma operação registrada em `historico.json` com a data de hoje** — evita gastar um dia de retenção com um backup essencialmente igual ao anterior, em dias que o maquinário não operou.
- Mantém sempre os **últimos 3 dias**: ao criar um novo, remove automaticamente o mais antigo se já houver 3.
- Arquivos ficam em `backups-automaticos/` (fora de `public/`, nunca servida como arquivo estático comum), nomeados por data: `backup-dados_AAAA-MM-DD.zip`.
- Acessível só pelas rotas dedicadas (`/backups-automaticos` e `/backups-automaticos/<nome>`) — essa pasta cresce e diminui sozinha, sem precisar de limpeza manual (diferente de `backups-seguranca/`).

## Operação em Andamento (tempo real)

Só existe **uma operação em andamento por vez**, na fábrica inteira. A partir do momento em que "Iniciar Injeção" é clicado em **Registrar Operação**, todo campo preenchido — turno, traços, ajustes, horário de encerramento — é transmitido em tempo real (WebSocket, rota `/ws/operacao-andamento`) pra qualquer outra aba ou computador que também tenha essa mesma tela aberta. Quem só está acompanhando vê a tela se comportar exatamente como se a operação estivesse sendo feita ali, cronômetro incluso.

- O estado atual fica espelhado em `public/db/operacao_andamento.json` — um único objeto (ou `null`, sem nenhuma operação rodando), nunca uma lista.
- Campos preenchidos **antes** de clicar em "Iniciar Injeção" não são transmitidos (ainda é só um rascunho local) — a transmissão começa no clique de "Iniciar" e termina quando a operação é registrada, resetada (🗑️ Limpar Tudo) ou enfileirada por falta de conexão.
- Sem necessidade de framework: o servidor (`server.js`) anexa um `WebSocket.Server` (lib `ws`) ao mesmo `http.Server` já existente.

**Limitação conhecida**: a trava de quem pode editar é por **dispositivo** (ver *Configurações → Autorizados*, abaixo), não por sessão — se a lista de autorizados estiver vazia (padrão), continua valendo "última mudança enviada sobrescreve a anterior", sem nenhuma trava.

## Modo de Teste (Registrar Operação)

Toggle **🧪 Modo de Teste**, no topo da tela (só pode trocar com a operação parada — `status: 'idle'`). Existe pra treinar/testar o fluxo inteiro de uma operação sem misturar nada com dados reais de produção.

Com o toggle ativo, a operação funciona normalmente (turno, traços, Iniciar/Finalizar/Registrar, ajustes, sobra), mas:

- **Tudo é salvo em `public/db/teste/`** em vez de `public/db/` — `historico.json`, `relatorio_injecao.json`, `contador_tracos.json`, `ajustes_tracos.json` e `sobra.json` têm uma cópia isolada lá, criada na hora que o modo de teste é usado por aquela rota pela primeira vez. **Nunca** escreve nos arquivos reais.
- **Nunca é transmitida ao vivo** — não passa pelo WebSocket/`operacao_andamento.json` nem pela trava de Autorizados/dono (ver seções acima): é um sandbox local a este navegador, do início ao fim. Quem mais estiver acompanhando a tela nunca vê uma operação de teste.
- **Qualquer computador pode usar**, mesmo um que não esteja autorizado a controlar operações reais — a trava de Autorizados é especificamente sobre a operação real e compartilhada; o teste é local e não compartilhado, então não tem com o que conflitar.
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
- Sem dispositivo autorizado nem sessão de admin nessa rota especificamente (`/leitura-automatica`) — é uma leitura de sensor, não um controle da operação; a proteção por senha é só pra **ligar/desligar** o modo, não pra cada leitura individual.

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
- Pensado como base pra restringir o registro de operação a um único computador — já implementado em **Configurações → Autorizados** (ver seção dedicada), usando esse mesmo `deviceId`.
- Por estar fora de `public/db/`, não faz parte do "Backup de Dados" (que só cobre `public/db/`) — fica incluído automaticamente no "Backup Geral" (que varre o projeto inteiro), do mesmo jeito que `backups-seguranca/` e `backups-automaticos/` já ficam.

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
| `/salvar-operacao-andamento` | POST | Salva `operacao_andamento.json` e propaga a mudança via WebSocket 🔒 (+ HTTP 409 se outro dispositivo autorizado já é o dono — ver *Autorizados*) |
| `/ws/operacao-andamento` | WS | Canal em tempo real da operação em andamento (ver seção dedicada acima) |
| `/registrar-acesso` | POST | Grava uma entrada em `logs/acessos.json` (log de acesso) |
| `/backup-geral` | GET | Gera e baixa o `.zip` do projeto inteiro |
| `/backups-automaticos` | GET | Lista os backups diários automáticos disponíveis (até 3) |
| `/backups-automaticos/<nome>` | GET | Baixa um backup automático específico |
| `/mesclar-backup-dados` | POST | Mescla traços/operações/paradas de um backup de OUTRA instalação (exige senha de admin, reverificada) |
| `/restaurar-backup-dados` | POST | Restaura `public/db/` a partir de um backup (exige senha de admin, reverificada) |
| `/restaurar-backup-geral` | POST | Restaura o projeto inteiro a partir de um backup (exige senha de admin, reverificada) |
| `/*` (qualquer outro caminho) | GET | Serve arquivos estáticos de `public/` |

- 🔒 = exige `?deviceId=...` autorizado quando a lista em **Configurações → Autorizados** não está vazia (HTTP 403 caso contrário — ver seção dedicada). Ignorado quando `?modoTeste=true`.
- 🧪 = aceita `?modoTeste=true` — desvia a leitura/escrita pra `public/db/teste/` em vez de `public/db/` (ver *Modo de Teste*, acima).
- 🔐 = exige sessão de Administrador válida (cookie — ver *Autenticação e Sessão*, abaixo). HTTP 403 sem ela.
- 🚦 = protegido por rate limiting de tentativas (ver *Autenticação e Sessão*, abaixo). HTTP 429 se bloqueado.

## Autenticação e Sessão

A senha do Administrador é guardada com hash **scrypt** (nativo do Node — sem dependência nova), com salt aleatório por hash. Hashes antigos (SHA-256 puro, de antes desta mudança) continuam sendo aceitos na comparação e são promovidos automaticamente pro formato novo no primeiro acerto — sem exigir troca manual de senha.

`/verificar-senha`, `/verificar-recovery`, `/mesclar-backup-dados`, `/restaurar-backup-dados` e `/restaurar-backup-geral` compartilham um rate limiting por IP: 5 tentativas erradas bloqueiam por 5 minutos (HTTP 429, com cabeçalho `Retry-After`). Em memória — reinicia o servidor e zera, mas é o suficiente pra fechar a porta de um script tentando senha atrás de senha sem limite.

`security.json` (hash da senha + hash da chave de recuperação) mora em `private/`, **fora** de `public/` — antes desta mudança, vivia em `public/db/` e era servido como arquivo estático comum, sem proteção nenhuma (qualquer um que soubesse a URL acessava os hashes direto; e `/salvar-security` aceitava qualquer hash bem formatado, **sem verificar senha nenhuma** — bastava saber o formato pra assumir a conta). As duas brechas estão fechadas:

- O arquivo físico não existe mais em `public/db/` (migração automática no boot, se uma instalação antiga ainda tiver o arquivo no lugar velho — renomeia, nunca apaga).
- `GET /db/security.json` (mesma URL de sempre — o front continua usando ela) e `POST /salvar-security` agora exigem uma **sessão de Administrador** válida: um cookie `HttpOnly`, emitido depois de uma senha ou chave de recuperação confirmada com sucesso, válido por 30 minutos, destruído em `/logout-admin` (chamado automaticamente pelo botão de logout). Em memória, igual ao rate limiting.

Essa sessão **não substitui** a re-verificação de senha das rotas de restauração/mesclagem (`/restaurar-backup-dados`, `/restaurar-backup-geral`, `/mesclar-backup-dados`) — elas continuam pedindo a senha de novo a cada chamada, por design (defesa em profundidade pra ações destrutivas). A sessão cobre especificamente as 2 rotas que não tinham proteção própria nenhuma antes.

**Limitação conhecida**: ainda não há um conceito de sessão pra rotas administrativas em geral (config, backup) — continuam pedindo senha a cada chamada sensível, e a sessão acima é deliberadamente restrita a 2 rotas. Extender pra mais rotas é possível, mas não foi feito ainda.

## Limitações conhecidas

- **Sessão real só pra 2 rotas**: `GET /db/security.json` e `POST /salvar-security` agora exigem sessão de Administrador (ver *Autenticação e Sessão*, acima) — mas o resto das rotas administrativas sensíveis (config, backup, restauração) continua exigindo senha re-verificada a cada chamada, sem token de sessão. Quem tiver a senha do admin ainda pode chamar essas outras rotas diretamente.
- Backups de segurança (`backups-seguranca/`) não têm rotina de limpeza automática.
- "Volume por placa" (referência informativa na tela de Operação) não é atualizado automaticamente ao criar um novo tipo de montagem — precisa ser adicionado manualmente no `config.json`.
- Testes automatizados (`test/`) cobrem só autenticação/sessão por enquanto — o resto das rotas (registrar operação, traços, backup geral, importação) ainda não tem teste nenhum.