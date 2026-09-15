# Insumos de Receitas dinâmicos no formulário de traço

**Status: ✅ concluído.** Todas as 6 fases entregues e commitadas na
branch `feat/insumos-dinamicos-formulario`.

## O que foi pedido (recapitulando)

Hoje "Configurações → Insumos de Receitas" (`config-insumos`) só cadastra um
catálogo (`LW.INSUMO_RECEITA_OPTS`) — adicionar/remover um insumo ali **não**
reflete no formulário de Registrar Operação, que continua com 5 campos fixos
hardcoded (Cimento, Água, EPS, Superplastificante, Incorporador de Ar).

Pedido: adicionar/mover um insumo no catálogo deve refletir de verdade no
formulário de traço.

## Decisões tomadas

1. **Categoria "Padrão" vs "Custom".** Os 5 insumos que já existiam viram
   categoria `padrao`; qualquer insumo novo cadastrado nasce `custom`.
2. **Padrão é sempre fixo no traço** — sempre visível, sempre obrigatório,
   exatamente como o formulário se comporta hoje. **Não pode ser removido
   nem renomeado** em Configurações (fica travado, com badge "Padrão").
3. **Custom começa escondido no formulário.** Um botão **"+"** abre a lista
   dos Custom ainda não adicionados a ESSE traço específico; ao escolher um,
   ele vira campo obrigatório só pra esse traço (não afeta outros traços).
4. **Custom pode ser removido do formulário antes de salvar** — um "x" ao
   lado do campo desfaz a adição.
5. ~~Uma vez que o traço é salvo com um Custom, ele passa a valer pra TODO
   ajuste/reaproveitamento futuro desse mesmo traço (obrigatório de
   novo em cada ajuste)~~ — **revisto depois da Fase 6, em uso real**: no
   modal "Ajustar Receita", um insumo Custom do traço é **opcional**,
   igual os 5 Padrão ali — preenche só se estiver sendo ajustado agora,
   não precisa repetir todo ajuste. (A obrigatoriedade continua valendo
   só na PRIMEIRA vez, no formulário principal — ver decisão 3.)
6. **Remover um Custom do catálogo não apaga histórico.** Traços antigos que
   já usaram esse insumo continuam com o dado gravado normalmente; ele só
   some da lista do "+" pra traços NOVOS.
7. **Dado bruto não distingue Padrão/Custom.** `traco_insumos`/`ajuste_insumos`
   (Fase 1) guardam o valor de qualquer insumo do mesmo jeito — a distinção
   Padrão/Custom mora só no catálogo (`config.json`), não na tabela de
   valores. O formulário decide quais campos exigir combinando "é Padrão"
   OU "já foi adicionado a este traço".

## Fases

### Fase 1 — Schema dinâmico + migração — ✅ concluída (`main`, commit `173a173`)

- Tabelas `traco_insumos` (id_traco, insumo, valor) e `ajuste_insumos`
  (id_ajuste, insumo, valor) — substituem as 5 colunas fixas.
- `db.migrarInsumosFixosParaDinamico()`: migração idempotente no boot
  (logo após `migrarRelatorioInjecaoSeNecessario`), copia dado das colunas
  fixas pras tabelas novas sem apagar nada.
- **Nenhum comportamento existente mudou** — leitura/escrita continuam nas
  colunas fixas; as tabelas novas só ficam populadas em paralelo.
- Teste: `test/insumos-dinamicos-migracao.test.js`.

### Fase 2 — `lib/db/tracos.js` lendo/escrevendo insumos Custom — ✅ concluída (branch `feat/insumos-dinamicos-formulario`)

**Escopo re-definido** (ver decisão na conversa que motivou isto): como os 5
Padrão são fixos pra sempre, eles continuam só nas colunas fixas de sempre
(`cimento_real`/`agua_real`/etc) — **nenhuma mudança** nelas, nem nas rotas
que já escrevem lá. Só os insumos **Custom** passaram a usar
`traco_insumos`/`ajuste_insumos` (as tabelas da Fase 1):

- `rowParaTraco`/`todosOsTracos`/`todosOsAjustesTracosJSON`: ganharam a
  chave opcional `insumos_custom` no JSON de saída (mesmo formato
  original/ajustes de sempre) — só aparece quando o traço/ajuste tem
  algum Custom. Um traço sem Custom nenhum não ganha a chave (não polui
  quem não usa a feature).
- `salvarInsumosCustomDoTraco(idTraco, insumosCustom)` e
  `salvarInsumosCustomDoAjuste(idAjuste, insumosCustom)` (novas, exportadas)
  — gravam em `traco_insumos`/`ajuste_insumos`; ignoram nomes que colidem
  com um dos 5 Padrão (defesa contra payload malformado) e valores vazios.
- `substituirTracosEAjustes` (Restaurar Backup de Dados) e
  `mesclarTracosEAjustes` (Mesclar Backup de Dados): round-trip completo
  do `insumos_custom` de cada traço/ajuste, usando as funções acima.
- `NOMES_INSUMOS_PADRAO` exportado — os 5 nomes canônicos, pra Fase 3
  usar na validação das rotas.

**Nenhum comportamento existente mudou** — os 5 Padrão continuam vindo
exatamente como sempre vieram, em todos os testes já existentes.

Teste: `test/insumos-dinamicos-fase2.test.js` (round-trip via restaurar e
mesclar backup, traço sem custom não ganha a chave, nome colidindo com
Padrão é ignorado). Suíte relevante ampliada (149 testes: migração,
backup, importação, registro/edição de traço, PDF, auth) sem regressão.


### Fase 3 — Rotas — ✅ concluída (branch `feat/insumos-dinamicos-formulario`)

- `lib/rotas/registro-operacao.js` (`POST /registrar-relatorio-injecao`) e
  `lib/rotas/operacao-offline.js` (sincronização da fila offline): gravam
  `novoTraco.insumos_custom` via `db.salvarInsumosCustomDoTraco`, só
  quando o traço é NOVO (mesma regra dos 5 Padrão — reaproveitar um traço
  existente nunca reescreve a receita, custom incluso).
- `lib/rotas/leitura-e-ajustes.js` (`POST /registrar-ajuste-traco`): grava
  `ajuste.insumos_custom` via `db.salvarInsumosCustomDoAjuste`, usando o
  `lastInsertRowid` do INSERT do ajuste.
- `lib/rotas/edicao.js` (`POST /editar-traco-relatorio`): substitui TUDO
  (mesmo padrão dos 5 Padrão/ajustes — apaga + regrava) tanto os custom
  "originais" (`novosValores.originais.insumos_custom`) quanto os de cada
  ajuste (`ajustes[i].insumos_custom`) — inclusive **remover** um insumo
  custom que existia antes (se o payload editado não trouxer mais aquele
  nome). `ajuste_insumos` é limpa ANTES de `ajustes` (depende do
  `id_ajuste` que está prestes a sumir).

**Nenhum comportamento existente mudou** — os 5 Padrão continuam vindo
exatamente como sempre vieram em todas as 4 rotas.

Teste: `test/insumos-dinamicos-fase3.test.js` (registro, ajuste ao vivo,
reaproveitamento não reescreve, edição substitui/remove). Suíte relevante
ampliada (207 testes: as 3 fases desta feature + backup, importação,
registro/edição/offline de traço, permissões por área, PDF, auth) sem
regressão.


### Fase 4 — Catálogo com categoria Padrão/Custom — ✅ concluída (branch `feat/insumos-dinamicos-formulario`)

- `LW.INSUMO_RECEITA_OPTS` (`public/js/data.js`) deixou de ser array de
  strings — agora é `{ nome, categoria: 'padrao' | 'custom' }[]`.
  `_normalizarInsumosReceita()` (nova) aceita tanto o formato NOVO quanto
  o ANTIGO (config.json salvo antes desta fase, array de strings) —
  strings viram objeto, categoria decidida por `NOMES_INSUMOS_PADRAO`
  (também novo, os 5 nomes canônicos, espelhando o lado servidor). Os 5
  Padrão sempre entram no resultado, mesmo que o config.json salvo não os
  liste (instalação bem antiga) — nunca somem, nunca viram "custom".
- Config UI (`app-core.js`): lista renderiza badge "Padrão" (sem botão de
  remover) pros 5; Custom continua com o fluxo de adicionar/remover de
  sempre. `cfgAdicionarInsumo` só cria `categoria: 'custom'`;
  `cfgRemoverInsumo` recusa (no-op) se o índice apontar pra um Padrão —
  defesa mesmo sem o botão estar visível pra ele.

**Nenhum dado de traço muda** — esta fase é só o catálogo/config; o
formulário de Registrar Operação ainda não lê essa lista (isso é a Fase 5).

Teste: `test/config-insumos-receita.test.js` atualizado pro formato novo
(fallback só-Padrão, round-trip com config antigo migrando corretamente,
UI com badge/sem-remover-Padrão/adicionar-remover-Custom). Suíte
relevante ampliada (135 testes: as 3 fases anteriores + catálogo de
permissões, perfis customizados/fixos, backup, importação, registro/edição
de traço) sem regressão.


### Fase 5 — Formulário de traço dinâmico (Registrar Operação) — ✅ concluída (branch `feat/insumos-dinamicos-formulario`)

- `_criarEstruturaTraco`/`_adicionarTracoDeSobra` (traço novo/reaproveitado
  de sobra): ganham `insumos_custom: {}`, mesmo formato `{nome:
  {original, ajustes}}` dos 5 Padrão. `migrarTraco` garante a chave em
  rascunhos salvos no localStorage antes desta fase.
- `renderCampoInsumoCustom`/`renderInsumosCustomSecao` (novas): renderizam
  os Custom já adicionados a ESTE traço + botão **"+"**, que abre um
  `<select>` inline só com os Custom do catálogo (`LW.INSUMO_RECEITA_OPTS`,
  categoria `custom`) que o traço ainda não tem. Traço reaproveitado
  (`_reaproveitado`) não mostra o "+" — receita inteira travada, mesmo
  raciocínio dos 5 Padrão.
- Cada campo Custom tem um **"x"** pra desfazer a adição — só aparece
  ANTES do primeiro ajuste registrado nele (depois, vira parte definitiva
  do histórico do traço, mesma trava "readonly" que os Padrão já têm).
- `tracoCompleto`/`_statusDoTraco`/`tracoTemAjusteSemTempoBatida`: todo
  insumo em `insumos_custom` entra na validação de obrigatório, igual os
  5 Padrão — é isso que faz o "+" virar de fato um campo obrigatório.
- Modal "Ajustar Receita" (`_mostrarModalAjusteReceita`/
  `_salvarAjusteReceita`): ganha uma seção com 1 campo por Custom que o
  traço já tem. **Correção pós-Fase-6** (uso real revelou que a decisão 5
  original — obrigatório em todo ajuste — atrapalhava): agora é
  **opcional**, igual os 5 Padrão ali — preenche só o que foi ajustado,
  não bloqueia salvar se ficar em branco.
- Payload final (`finalizarInjecao`): achata `insumos_custom` de
  `{nome: {original, ajustes}}` pra `{nome: valorOriginal}` antes de
  enviar — formato que `db.salvarInsumosCustomDoTraco` (Fase 2/3) espera
  (os ajustes já foram gravados um a um, ao vivo, via
  `/registrar-ajuste-traco`, igual os 5 Padrão).

**Nenhum comportamento existente muda** para traços sem nenhum Custom —
os 5 Padrão continuam exatamente como sempre foram.

Teste: `test/insumos-dinamicos-fase5.test.js` (traço novo sem Custom,
picker só lista Custom disponível, adicionar torna obrigatório, "x"
remove antes de ajuste, "x" some depois de 1 ajuste real via modal, modal
exige o valor do Custom). Suíte das 5 fases junto (21 testes) +
testes de operação pré-existentes (30 testes) sem regressão.


### Fase 6 — Consumidores derivados — ✅ concluída (branch `feat/insumos-dinamicos-formulario`, escopo ajustado)

Telas/relatórios atualizados pra também exibir insumos Custom, sempre
depois dos 5 Padrão (que continuam exatamente como sempre foram):

- `oee.js`/`tv.js` — `_tracoTemAjuste` (usada na métrica "Qualidade" do
  OEE e no indicador "traço ajustado" da TV) passa a considerar ajustes
  em insumos Custom também, não só os 5 Padrão.
- `bateria-atual.js` — card de detalhe do berço mostra os Custom do
  traço junto com os 5 Padrão.
- `consulta-tracos.js` — total geral inclui Custom; modal de detalhe
  ganha linhas extras; os dois exports Excel (período e traço individual)
  ganham colunas de Custom (no export de período, união de todos os
  nomes usados no intervalo — célula em branco pra quem não usou aquele
  insumo naquele traço).
- `lib/db/operacoes-qualidade.js` (`detalheOperacao`, usado pela Análise
  Focada) — novo: `traco.insumos_custom` (originais, lido de
  `traco_insumos`) e `ajuste.insumos_custom` (por ajuste, lido de
  `ajuste_insumos`) — só entra a chave quando o traço/ajuste de fato tem
  algum (mesmo critério do resto da feature).
- `analise-focada.js` (PDF/tela de Análise Focada) — grade de receita
  (modal de berço + listagem de traços) e linha de cada ajuste mostram os
  Custom, sem alterar o layout dos 5 Padrão — decisão tomada no plano
  ("Proposta" abaixo, confirmada ao executar): aparecem só quando o
  traço realmente usa, junto no mesmo grid flexível (`.af-receita-grid`
  já é `auto-fit`, não precisou de seção separada).

**Fora do escopo, de propósito** (não é esquecimento — decisão explícita):
- `qualidade-tracos.js` (CEP — "insumo mais ajustado", desvio %, taxa de
  acerto): depende de uma referência "ideal" pros 5 Padrão que não existe
  pra insumos Custom; estender exigiria inventar essa baseline, que não
  foi pedido.
- `debriefing.js`: usa cimento/água só pra calcular Relação A/C — Custom
  não entra nessa conta.
- `dashboard.js` (tabela principal do Relatório de Injeção, colunas
  fixas): mantida como está — é exatamente por isso que a tela de
  Consulta de Insumos por Traço existe (motivo já registrado no próprio
  comentário de topo do arquivo, de antes desta feature).

**Nenhum comportamento existente muda** para traços sem nenhum Custom —
os 5 Padrão continuam vindo exatamente como sempre vieram em toda tela.

Teste: `test/insumos-dinamicos-fase6.test.js` (foco no SQL novo de
`detalheOperacao` — Padrão intocado, Custom original + por ajuste, traço
sem Custom não ganha a chave, 2 Custom diferentes em ajustes distintos).
Suíte relevante ampliada (≈80 testes: análise focada, exportação PDF/
interativa, consulta de traços, bateria atual) sem regressão. Suíte das
6 fases juntas (24 testes) sem regressão.

**Plano concluído — todas as 6 fases entregues.**

## Correções pós-lançamento (uso real)

1. **Insumo Custom vira opcional no modal "Ajustar Receita".** A decisão 5
   original (obrigatório em todo ajuste) atrapalhava o fluxo real — ver
   seção de decisões, acima (revista). Corrigido: opcional, igual os 5
   Padrão ali.
2. **Fórmula de ajustes (não só o total) no campo Custom.** Faltava a
   linha `9,50 + 0,50 = 10,00` (só tinha o badge de total) — corrigido em
   `renderCampoInsumoCustom` (reaproveita `formatAjustesDisplay`).
3. **BUG: insumo Custom adicionado depois que o traço já existe (2º+ uso)
   nunca era salvo.** Sintoma relatado: na Análise Focada, os AJUSTES do
   insumo novo apareciam, mas o campo da receita (valor original) não.
   Causa raiz: `salvarInsumosCustomDoTraco` só era chamada dentro do
   `if (!tracoExiste)` (registro-operacao.js/operacao-offline.js) — a
   MESMA guarda que protege os 5 Padrão contra reescrita. Pros Padrão
   isso nunca foi problema (sempre preenchidos desde o início do
   formulário); pro Custom, o botão "+" permite adicionar um insumo
   NOVO a um traço que JÁ foi submetido uma vez (ex: mesmo traço usado em
   2+ baterias da mesma operação) — nesse caso a função inteira era
   pulada, então o valor original nunca ia pro banco (só os ajustes ao
   vivo via `/registrar-ajuste-traco`, que não tem essa guarda).
   Corrigido: `salvarInsumosCustomDoTraco` agora usa `INSERT OR IGNORE`
   (chave primária id_traco+insumo) e é chamada em TODA submissão, não só
   na primeira — quem já tem linha gravada continua protegido (nunca
   reescreve), mas um insumo genuinamente novo agora consegue entrar.
   Teste: `test/insumos-dinamicos-fase3.test.js` ("BUG CORRIGIDO: insumo
   Custom adicionado... depois que o traço já existe").
4. **Relatório de Injeção (dashboard.js) — painel de detalhe ganha
   Custom.** Pedido explícito numa conversa, revendo a decisão original
   de deixar `dashboard.js` inteiramente de fora do escopo (Fase 6). A
   TABELA principal (colunas fixas do `<tr>`) continua só com os 5
   Padrão — decisão mantida NESTA rodada, ainda é papel da Consulta de
   Insumos por Traço mostrar Custom em tabela *(revisto no item 5, logo
   abaixo, na MESMA conversa)*. O que mudou foi o **painel expansível
   de detalhe** de cada linha (`colspan`, sem colunas fixas):
   - `_construirTabelaAjustesPorEvento`: coluna dinâmica por nome de
     Custom usado em qualquer ajuste do traço (união, mesmo critério já
     usado pros 5 Padrão ali — "só mostra coluna com valor").
   - `_tracoTemAjuste` (filtro "Apenas com reajustes"): passa a
     considerar ajustes em Custom também.
   - `_construirDetalheRelatorio` (fallback pra dado anterior à migração
     de eventos): itera `l.insumos_custom` igual aos 5 Padrão.
5. **Relatório de Injeção — a TABELA principal também ganha coluna de
   Custom.** Pedido de seguida, na mesma conversa, revendo o item 4:
   agora a tabela de colunas fixas também mostra 1 coluna por insumo
   Custom usado por QUALQUER traço atualmente visível (já filtrado).
   - `_garantirColunasCustomRelatorio` (nova): injeta/remove os `<th
     data-custom-col>` no `<thead>` a cada render (union recalculada do
     zero — ao contrário de `_garantirColunasDinamicasTipo`, do Registro
     de Baterias, que só CRESCE, aqui a lista pode diminuir se um filtro
     escender os traços que usavam aquele Custom). Posição: logo antes
     de "Tempo de Batida".
   - `renderRelatorio`: monta `nomesCustomTabela` (união pós-filtro),
     chama a função acima, gera 1 `<td>` por nome (reaproveitando
     `_valRel`, igual os 5 Padrão) e ajusta o `colspan` do painel de
     detalhe (`17 + nomesCustomTabela.length`).
   - Sem ordenação por clique nessas colunas (de propósito, por ora —
     `data-custom-col` é um atributo DIFERENTE de `data-col`, que é o
     que o sistema de ordenação por clique já existente procura).
   Teste: `test/insumos-dinamicos-relatorio-injecao.test.js` (estrutural,
   mesmo padrão de `atalho-ctrl-clique-consulta-tracos.test.js` pra este
   arquivo — a lógica de dado já está coberta pelas Fases 2/3/6, o risco
   novo é só a integração no render).
6. **BUG DE FUSO HORÁRIO: "Quando" dos ajustes vinha adiantado em 3h.**
   Mesma classe de bug já vista antes no projeto (ver
   `test/analise-focada-fuso-horario.test.js`, um caso relacionado mas
   inverso — lá era conversão em DOBRO, aqui era NENHUMA conversão).
   Causa: `registrado_em` (o "quando" de um ajuste) era gravado com
   `new Date().toISOString()` — UTC de verdade — mas o front
   (`LW.formatDateTime`) assume a convenção "fake-UTC-como-Brasília"
   (mesma de `nowBrasilia()`) e exibe os componentes numéricos direto,
   sem reconverter. Brasília é UTC-3 (sem horário de verão desde 2019),
   então UTC de verdade aparecia 3h adiantado. Corrigido com
   `agoraBrasiliaISOServer()` (nova, `lib/tempo.js`) — mesma técnica de
   `nowBrasilia()` (front) só que calculada no servidor, e injetada via
   ctx nos 3 lugares que geravam `registrado_em`: registro ao vivo do
   ajuste (`/registrar-ajuste-traco`), edição de traço
   (`/editar-traco-relatorio`) e os fallbacks de restaurar/mesclar
   backup + migração do JSON legado (`lib/db/tracos.js`).
   **Escopo:** corrigido só pra `registrado_em` de ajustes (o que foi
   relatado) — o projeto tem MUITOS outros usos de
   `new Date().toISOString()` espalhados (`criado_em`, `atualizado_em`,
   `validado_em` etc. em outras dezenas de arquivos) que podem ter o
   MESMO bug se algum dia forem exibidos via `formatDateTime`/
   `formatTime` sem já passar por essa conversão — não auditados nesta
   correção, fora do escopo do que foi pedido.
   Teste: `test/ajustes-traco-fuso-horario.test.js` (relógio do servidor
   congelado via `LW_TEST_RELOGIO_ISO`, confirma que o horário salvo é o
   de Brasília, não o UTC real).
7. **Dashboard de CEP (qualidade-tracos.js) também ganha os insumos
   Custom.** Pedido numa conversa, revendo a decisão original da Fase 6
   de deixar este arquivo de fora (o motivo dado então — depender de uma
   referência "ideal" que não existiria pra Custom — estava ERRADO:
   investigando o código, "Desvio Planejado×Real" é ORIGINAL×TOTAL
   DENTRO do mesmo traço, não uma referência externa fixa; generaliza
   pra Custom sem inventar nenhuma baseline nova). Mudança: o loop
   principal de `calcularIndicadores` ganhou `acumularInsumo` (helper
   extraído, reaproveitado pros 5 Padrão E pra `t.insumos_custom`) — daí
   pra frente, `ajustesPorInsumo` (ranking "insumo mais ajustado"),
   `consumoPorInsumo`/`maiorDesvioLabel` (planejado×real), `cepPorInsumo`
   (Média/Mediana/Desvio/CV) e `ajustesPorInsumoMes` (tendência mensal)
   passam a iterar a UNIÃO Padrão+Custom em vez de só `INSUMOS_LABELS`
   fixo — os `render*` já iteravam esses objetos genericamente
   (`Object.entries`), não precisaram mudar. O export standalone
   (HTML offline) reaproveita as MESMAS funções via `${calcularIndicadores}`/
   `${renderCEP}` (stringificadas), então ganha o mesmo suporte de
   graça. `calcularIndicadores` exposta em `window.LWQualidade` só pra
   viabilizar teste direto (era 100% interna antes).
   Teste: `test/insumos-dinamicos-cep.test.js` (6 testes, chama
   `calcularIndicadores` direto com fixtures — Custom aparece em CEP,
   consumo planejado×real, ranking de ajustes, tendência mensal e pode
   até ganhar o card de "maior desvio").
8. **BUG CORRIGIDO: insumo Custom com valor só via AJUSTE não aparecia
   na Receita Utilizada da Análise Focada.** Relatado: "aparece nos
   ajustes, mas não na receita". Causa: diferente de `rowParaTraco`
   (`lib/db/tracos.js`, usado por Consulta de Traços/Relatório de
   Injeção), que já unia nomes de `traco_insumos` E `ajuste_insumos` pra
   decidir quais insumos Custom mostrar (ver `montarInsumosCustom`),
   `detalheOperacao` (`lib/db/operacoes-qualidade.js`, usado só pela
   Análise Focada) olhava SÓ `traco_insumos` — um insumo Custom cujo
   campo "original" nunca foi preenchido no formulário principal (só
   ganhou valor via "Ajustar Receita") nunca teria linha em
   `traco_insumos`, então a chave `insumos_custom` do traço nem existia,
   mesmo com o ajuste visível do lado. Corrigido: `detalheOperacao`
   agora une os nomes das duas tabelas, igual `rowParaTraco` já fazia —
   um Custom só-por-ajuste aparece com `original: null`.
   Teste: `test/insumos-dinamicos-fase6.test.js` ("BUG CORRIGIDO: insumo
   Custom com valor só via AJUSTE...").
9. **BUG CRÍTICO CORRIGIDO: original de insumo Custom nunca ia pro
   servidor — dashboards/tabela/CEP mostravam só o ajuste, nunca
   original+ajuste.** Relatado com prints de tela (2 insumos Custom,
   original 1 em cada, 1 ajuste somando +3 em cada — total devia ser 4,
   aparecia 3). Causa raiz, achada só depois de simular o clique real em
   "Registrar Operação" ponta a ponta (todo teste anterior testava só a
   lógica de achatamento em `operacao.js` OU a rota do servidor,
   isoladas — nunca as duas juntas): `LW.registrarRelatorioInjecao`
   (`public/js/data.js`) reconstrói cada linha do payload campo por
   campo, na mão, e **nunca incluía `insumos_custom`** nessa lista — a
   Fase 5 achatava `insumos_custom` certinho dentro de
   `fullRecord.tracos[i]` (`operacao.js`), mas essa função descartava o
   campo silenciosamente antes do POST sair. Os ajustes ao vivo (rota
   separada, `/registrar-ajuste-traco`) sempre chegavam certos, dando a
   falsa impressão de que só a soma estava errada, quando na verdade o
   original nunca tinha ido junto (virava 0 implícito no cálculo do
   total). Fix: uma linha (`...(t.insumos_custom ? {insumos_custom:
   t.insumos_custom} : {})`) na construção de `linhas`.
   Teste: `test/insumos-dinamicos-payload-registro.test.js` — o único
   teste desta feature inteira que sobe a SPA de verdade e clica no
   botão "Registrar Operação" de ponta a ponta (login real, deviceId
   autorizado, bateria/montagem/timer, "+", "Ajustar Receita", clique no
   botão) e confere tanto o payload capturado quanto o dado final salvo
   no servidor.
10. **Análise Focada — "Receita Utilizada" não somava o ajuste do
    Custom.** Relatado com print de tela: Traço com ajuste em "Fibra" e
    "Cerragem" (+3,00kg em cada), mas a grade principal continuava
    mostrando só o original — dando a impressão de que o ajuste "não
    tinha efeito" ali (mesmo aparecendo certo na lista de ajustes, logo
    abaixo). Mesma classe de bug já corrigida antes pra Relação A/C (ver
    item de teste `analise-focada-relacao-ac.test.js`, década anterior
    desta feature) — a Análise Focada usava `traco.insumos_custom[nome]`
    direto (só o original, nunca somado com
    `traco.ajustes[i].insumos_custom[nome]`). **Decisão tomada nesta
    correção:** diferente dos 5 Padrão (grade mostra só o ORIGINAL, de
    propósito, com ajustes listados à parte) — pro Custom, a grade passa
    a mostrar o TOTAL (original+ajustes), pra bater com o que
    dashboards/tabela/CEP já mostram desde a correção anterior (item 9).
    Corrigido com `_afTotalInsumoCustom` (nova, mesmo padrão de
    `_afTotalInsumo` já existente pros 5 Padrão), usada nos 2 lugares que
    montam a grade "Receita Utilizada" (modal de berço e listagem de
    traços).
    Teste: `test/insumos-dinamicos-analise-focada-total.test.js` (4
    testes: soma exata do cenário relatado, múltiplos ajustes, original
    null tratado como 0, ajuste que não mexeu no insumo não soma à toa).

## Testes (visão geral, cresce por fase)

- `test/insumos-dinamicos-migracao.test.js` — Fase 1, concluído.
- `test/config-insumos-receita.test.js` — já existente (catálogo antes desta
  feature); vai precisar de testes novos pra categoria Padrão/Custom (Fase 4).
- Cada fase seguinte roda a suíte relevante (traços/backup/PDF/dashboard)
  antes de mergear, mesmo padrão da Fase 1.

## O que falta decidir antes da Fase 6

- Como o PDF/Análise Focada exibe um número variável de insumos Custom por
  traço (layout).
- Se Padrão e Custom aparecem juntos ou em blocos separados no dashboard/TV.
