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
