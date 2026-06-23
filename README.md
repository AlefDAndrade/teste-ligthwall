# Lightwall SC — Sistema de Injeção

Sistema interno de controle de operações de injeção de baterias (placas cimentícias / EPS), com registro de traços, relatórios, dashboards analíticos e administração de configurações.

## Stack

- **Backend**: Node.js puro (módulo `http`, sem framework), servindo arquivos estáticos e uma API simples em JSON.
- **Frontend**: HTML/CSS/JS sem framework nem build step — tudo é `<script>` global.
- **"Banco de dados"**: arquivos JSON em `public/db/` (sem banco de dados real).
- **Dependências**: `xlsx` (exportação/importação de Excel) e `jszip` (geração e leitura de backups `.zip`).

## Como rodar

```bash
npm install
npm start
```

O servidor sobe em `http://localhost:3000`. Requer Node `>= 18`.

## Estrutura de pastas

```
public/
├── index.html        # app principal (todas as páginas, exceto login)
├── login.html         # tela de login / escolha de perfil
├── css/
│   ├── styles.css     # tema e estilos do app principal
│   └── login.css      # estilos da tela de login
├── js/
│   ├── data.js                # camada de dados/config — fetch, calcPaineis, getStats etc.
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
    ├── ajustes_tracos.json      # auditoria de ajustes de receita por traço (insumo + tempo de batida)
    ├── security.json            # hash da senha do admin + hash da chave de recuperação
    ├── sobra.json                # traço com sobra ativa entre operações
    ├── paradas.json              # paradas registradas (planejadas/não planejadas)
    └── contador_tracos.json      # contador diário de traços (reset automático)
server.js               # servidor HTTP + rotas da API
package.json
```

`backups-seguranca/` e `backups-automaticos/` são criadas automaticamente pelo servidor (ver seção *Backup e Restauração*) e nunca devem ser versionadas — já estão no `.gitignore`.

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

Esse arquivo é só um log de auditoria (qual ajuste veio com qual tempo de batida) — não substitui nem altera os campos `*_real`/`tempo_batida` de cada traço (em `historico.json`/`relatorio_injecao.json`), que continuam funcionando exatamente como antes.

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

## Backup e Restauração (Administrador)

Um único card no menu ("💾 Backup e Restauração") abre um painel com todas as opções:

| Opção | O que faz |
|---|---|
| **Backup de Dados** | Baixa um `.zip` com os 8 arquivos de `public/db/`. Gerado no navegador. |
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
| `/verificar-senha` | POST | Confirma senha do administrador |
| `/verificar-recovery` | POST | Confirma chave de recuperação de senha |
| `/gerar-hash` | POST | Gera hash SHA-256 de uma senha (uso interno/setup) |
| `/total-tracos-hoje` | GET | Contador diário de traços |
| `/confirmar-tracos-hoje` | POST | Incrementa o contador diário |
| `/salvar-config` | POST | Salva `config.json` |
| `/salvar-security` | POST | Salva `security.json` (troca de senha) |
| `/registrar-operacao` | POST | Grava um registro em `historico.json` |
| `/registrar-relatorio-injecao` | POST | Grava traços em `relatorio_injecao.json` |
| `/registrar-ajuste-traco` | POST | Grava um ajuste (insumo + tempo de batida) em `ajustes_tracos.json` |
| `/importar-relatorio-injecao` | POST | Importação em lote (Excel) de traços |
| `/importar-historico` | POST | Importação em lote (Excel) de histórico |
| `/salvar-sobra` | POST | Salva/atualiza `sobra.json` |
| `/backup-geral` | GET | Gera e baixa o `.zip` do projeto inteiro |
| `/backups-automaticos` | GET | Lista os backups diários automáticos disponíveis (até 3) |
| `/backups-automaticos/<nome>` | GET | Baixa um backup automático específico |
| `/restaurar-backup-dados` | POST | Restaura `public/db/` a partir de um backup |
| `/restaurar-backup-geral` | POST | Restaura o projeto inteiro a partir de um backup |
| `/*` (qualquer outro caminho) | GET | Serve arquivos estáticos de `public/` |

## Limitações conhecidas

- **Sem sessão real no servidor**: o controle de perfil é feito no navegador (`sessionStorage`); rotas administrativas sensíveis (config, backup, restauração) exigem senha re-verificada no servidor a cada chamada, mas não há um token de sessão — quem tiver a senha do admin pode chamar essas rotas diretamente.
- `public/db/*.json` continuam sendo servidos como arquivos estáticos (ex: `/db/security.json` é acessível por URL direta). O hash da senha ali não é reversível, mas a exposição do arquivo em si não foi endurecida.
- Backups de segurança (`backups-seguranca/`) não têm rotina de limpeza automática.
- "Volume por placa" (referência informativa na tela de Operação) não é atualizado automaticamente ao criar um novo tipo de montagem — precisa ser adicionado manualmente no `config.json`.