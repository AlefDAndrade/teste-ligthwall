# Insumos de Receitas dinâmicos no formulário de traço

**Status: em andamento.** Fase 1 entregue e na `main`. Fases 2-5 ainda não
implementadas — este arquivo é o plano de referência enquanto elas rodam,
igual ao padrão de `PLANO-pdf-segundo-plano.md`.

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
5. **Uma vez que o traço é salvo com um Custom, ele passa a valer pra TODO
   ajuste/reaproveitamento futuro desse mesmo traço** (não varia ajuste a
   ajuste — é uma característica do traço, não da rodada).
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
  `_salvarAjusteReceita`): ganha uma seção **obrigatória** com 1 campo
  por Custom que o traço já tem (diferente dos 5 Padrão ali, que
  continuam opcionais) — decisão tomada na conversa ("vale pro traço
  inteiro, todo ajuste pede de novo"). Recusa salvar (com mensagem
  citando o nome do insumo) se algum ficar em branco.
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


### Fase 6 — Consumidores derivados — 🔲 não iniciada (escopo ainda a confirmar)

Telas/relatórios que hoje assumem só os 5 campos fixos e vão precisar
iterar uma lista variável de insumos por traço:

- `public/js/dashboard.js`, `public/js/oee.js`, `public/js/tv.js`,
  `public/js/bateria-atual.js`, `public/js/debriefing.js`,
  `public/js/qualidade-tracos.js`, `public/js/consulta-tracos.js`.
- PDF/Análise Focada (`test/analise-focada-*`, `test/exportar-pdf-*`) —
  como exibir N insumos Custom variáveis numa página de PDF já desenhada
  pros 5 fixos é uma decisão de layout que ainda não foi discutida.

*Proposta: para esses consumidores, os 5 Padrão continuam exibidos do jeito
que já são hoje (nenhuma mudança visual); os Custom aparecem numa seção
genérica à parte ("Insumos adicionais"), só quando o traço em questão tiver
algum. Isso evita redesenhar todo layout existente — mas precisa de sua
confirmação antes de eu implementar, já que mexe em telas que hoje não têm
esse conceito.*

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
