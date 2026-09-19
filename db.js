// ============================================================
//  db.js — camada de acesso ao SQLite (better-sqlite3)
//
//  Substitui, por fases, os arquivos JSON de public/db/ que crescem sem
//  limite e são lidos/escritos por inteiro a cada operação (ver discussão
//  na seção "Banco de Dados (SQLite)" do README). Cria o banco e TODAS as
//  tabelas já na primeira vez que o servidor sobe (CREATE TABLE IF NOT
//  EXISTS — idempotente, não recria nem apaga nada se já existir), mesmo
//  que algumas só passem a ser usadas de verdade numa fase futura.
//
//  Fica em data/lightwall.sqlite — FORA de public/ (mesmo motivo de
//  logs/ e backups-seguranca/: nada aqui deve ser servido como arquivo
//  estático) — e fora do git (.gitignore): é dado real do servidor, não
//  código. Pra recriar do zero numa cópia nova do projeto, ver
//  migrar-json-para-sql.js.
// ============================================================

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DIR_DADOS = path.join(__dirname, 'data');
fs.mkdirSync(DIR_DADOS, { recursive: true });

const DB_PATH = path.join(DIR_DADOS, 'lightwall.sqlite');
const db = new Database(DB_PATH);

// WAL = leituras não bloqueiam escritas (nem vice-versa) — melhor pra um
// servidor com várias abas/dispositivos lendo enquanto alguém registra.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- ============================================================
  --  FASE 2 — Operações (substitui historico.json)
  -- ============================================================
  CREATE TABLE IF NOT EXISTS operacoes (
    id                    TEXT PRIMARY KEY,
    data                  TEXT NOT NULL,
    turno                 TEXT,
    dimensao              TEXT,
    capacidade            INTEGER,
    id_bateria            TEXT,
    inicio                TEXT,
    fim                   TEXT,
    desemplaque           TEXT,
    tempo_min             REAL,
    qtd_tracos            INTEGER,
    houve_atraso          TEXT,
    motivo_atraso         TEXT,
    tipo_montagem         TEXT,
    -- Legado — não gravado nem lido por nenhum código a partir desta
    -- versão (era "Berços Injetados (Real)": permitia declarar uma
    -- capacidade REDUZIDA na hora de registrar, pra injeção parcial).
    -- Substituído pela marcação individual "🚫 Não Enchido" por berço em
    -- Bateria Atual (ver bateria-atual.js/setor-qualidade.js,
    -- _definirPaineisNaoEnchidos) — mais granular (marca QUAL berço, não
    -- só um total) e feita DEPOIS do registro, não na hora. Coluna mantida
    -- (não removida) só por segurança de dados: apagar uma coluna via
    -- migração é destrutivo e sem volta; linhas antigas continuam com o
    -- valor histórico aqui, mas nada no sistema mais lê isso.
    bercos_reais          INTEGER,
    -- Só não-nulo quando tipo_montagem = 'PERSONALIZADA' (ver Montagem
    -- Personalizada no README) — 1 array JSON, 1 item por berço. Não vale
    -- a pena normalizar isso numa tabela própria: não cresce com o tempo
    -- (tamanho fixo = capacidade da bateria) e nunca é consultado sozinho,
    -- só lido junto com a operação inteira.
    bercos_personalizados TEXT,
    -- Override de Dimensão por berço específico (ver "📋 Detalhes do
    -- Berço", bateria-atual.js) — 1 array JSON, 1 item por berço
    -- (null = usa a coluna "dimensao" acima, a dimensão geral da
    -- operação, pra aquele berço). Normalmente toda bateria tem berços
    -- fisicamente idênticos, mas isso permite corrigir/registrar a
    -- dimensão de UM berço específico sem afetar os demais. Mesmo
    -- padrão de bercos_personalizados, acima (tamanho fixo = capacidade
    -- da bateria, nunca consultado sozinho).
    bercos_dimensoes      TEXT,
    total_paineis         INTEGER,
    m2_total              REAL,
    placas_cimenticia     INTEGER,
    -- {tipo: quantidade} / {tipo: m2} serializado — o nº de tipos varia
    -- (Simples/Híbrida = 1-2, Personalizada = quantos tipos a grade usar),
    -- então um dicionário aberto continua sendo a representação certa
    -- (mesma razão de já ser assim no JSON hoje).
    paineis_por_tipo      TEXT,
    m2_por_tipo           TEXT,
    paineis_2p            INTEGER DEFAULT 0,
    paineis_sp            INTEGER DEFAULT 0,
    m2_2p                 REAL DEFAULT 0,
    m2_sp                 REAL DEFAULT 0,
    -- Lista de {id} dos traços desta operação — serializada (mesmo
    -- formato de historico.json hoje). Redundante com traco_usos (Fase 5),
    -- que vai responder a mesma pergunta via JOIN; até lá, mantido aqui
    -- pra não depender de uma fase que ainda não existe.
    tracos_json           TEXT,
    -- LEGADO — não é mais escrita por rota nenhuma a partir da criação da
    -- tabela "operacoes_avaliadas" (ver mais abaixo). Mantida só pra não
    -- quebrar instalações antigas (e pra migração única que preenche
    -- operacoes_avaliadas a partir daqui); "esta operação já foi avaliada?"
    -- passa a ser respondido por "existe uma linha em operacoes_avaliadas
    -- com este id_operacao?", nunca mais por esta coluna.
    avaliado              INTEGER NOT NULL DEFAULT 0,
    modo_teste            INTEGER DEFAULT 0,
    -- Nome de quem registrou (ver LW.nomeDeQuemEstaLogado(), data.js) —
    -- puramente informativo, NUNCA usado como controle de acesso: quem
    -- controla o que a pessoa pode fazer é o perfil dela (ver
    -- lib/perfis.js), não este campo. Preenchido automaticamente com o
    -- nome de quem está logado no momento do registro (antes: perguntava
    -- via PIN à parte do login — "Identidade Leve de Operador", removida).
    -- Guardado como o NOME já resolvido (não um id/FK) de propósito —
    -- sobrevive sozinho mesmo se aquele usuário for removido do cadastro
    -- depois; é rótulo de auditoria, não uma referência viva.
    operador_nome         TEXT,
    -- ─── Auditoria de Registro Offline (item 6/7 do plano — ver README,
    -- "Registro de Operação Offline (PWA)") ────────────────────────────
    -- origem_offline: 1 quando esta operação nasceu de um envio de
    -- POST /operacao-offline/enviar, aprovado depois por um Administrador
    -- em Configurações → Operações a Validar; 0 (padrão) pra toda operação
    -- registrada ao vivo, do jeito de sempre. Puramente informativo — não
    -- afeta NENHUMA regra de negócio existente (cálculo de painéis, fila
    -- de avaliação, contador de traços, etc. tratam esta operação
    -- exatamente igual a qualquer outra a partir do momento em que existe).
    -- validado_por/validado_em: quem aprovou e quando — só preenchido
    -- quando origem_offline = 1.
    origem_offline        INTEGER NOT NULL DEFAULT 0,
    validado_por          TEXT,
    validado_em           TEXT,
    criado_em             TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_operacoes_data ON operacoes(data);
  CREATE INDEX IF NOT EXISTS idx_operacoes_bateria ON operacoes(id_bateria);

  -- Auditoria de edições em operações (substitui historico_edicoes.json)
  CREATE TABLE IF NOT EXISTS edicoes_operacao (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    id_operacao       TEXT NOT NULL,
    data_edicao       TEXT NOT NULL,
    campos_alterados  TEXT NOT NULL  -- JSON: [{campo, de, para}, ...]
  );
  CREATE INDEX IF NOT EXISTS idx_edicoes_operacao_id ON edicoes_operacao(id_operacao);

  -- Motivos de Pausa — justificativa pedida ao operador ao pausar uma
  -- injeção em andamento (ver togglePausaOperacao/mostrarPrompt,
  -- operacao.js). 1 linha por pausa (uma mesma operação pode pausar e
  -- retomar mais de uma vez). id_operacao NÃO tem FK pra operacoes(id) de
  -- propósito, mesmo raciocínio de traco_usos.id_operacao (acima): a pausa
  -- acontece ENQUANTO a operação ainda está rodando — o id real (opId) só
  -- é gerado no fim, ao registrar (ver operacao.js) — exigir o FK aqui
  -- quebraria o fluxo ao vivo. Gravada junto com o resto da operação, no
  -- mesmo POST /registrar-operacao (nunca em tempo real, no instante em
  -- que a pausa acontece).
  CREATE TABLE IF NOT EXISTS pausas_operacao (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    id_operacao   TEXT NOT NULL,
    pausado_em    TEXT NOT NULL,
    retomado_em   TEXT,
    motivo        TEXT NOT NULL,
    registrado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_pausas_operacao_id ON pausas_operacao(id_operacao);

  -- ============================================================
  --  FASE 5 — Traços (substitui relatorio_injecao.json)
  --
  --  Diferente do JSON de hoje, cimento_real/agua_real/.../tempo_batida
  --  NÃO guardam mais um blob {original, ajustes:[...]} — "original" é
  --  coluna própria aqui, e os ajustes ficam na tabela "ajustes", abaixo.
  --  O TOTAL de cada campo = original + SUM(ajustes.<campo>) — uma soma
  --  feita pelo banco, nunca mais montada à mão em JS (era exatamente
  --  esse o ponto fraco que resolvemos manualmente no "Editar Traço";
  --  aqui deixa de existir, estruturalmente).
  -- ============================================================
  CREATE TABLE IF NOT EXISTS tracos (
    id_traco              TEXT PRIMARY KEY,
    data                  TEXT NOT NULL,
    turno                 TEXT,
    num_traco             INTEGER,
    cimento_original      REAL,
    agua_original         REAL,
    eps_original          REAL,
    superplast_original   REAL,
    incorporador_original REAL,
    tempo_batida_original REAL,  -- segundos (mesma unidade de sempre)
    densidade_original    REAL,
    flow_original         REAL,
    obs                   TEXT,  -- legado/fallback — ver traco_usos.obs pro valor por uso
    silo                  TEXT,
    expansao              TEXT,
    densidade_eps         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tracos_data ON tracos(data);
  CREATE INDEX IF NOT EXISTS idx_tracos_data_num ON tracos(data, num_traco);

  -- Usos de um traço (substitui ultilizado.operacao[] de cada traço) — uma
  -- linha por reaproveitamento numa bateria/operação. Mesma relação que
  -- hoje fica duplicada em 2 lugares (aqui E em historico.json.tracos[]);
  -- numa tabela só, consultável dos dois lados (por traço ou por operação).
  -- id_operacao NÃO tem FK pra operacoes(id) de propósito: a importação em
  -- lote de relatorio_injecao.json gera um id_operacao sintético que nunca
  -- existe em operacoes (não há operação real por trás de uma planilha
  -- importada) — exigir o FK quebraria a importação.
  CREATE TABLE IF NOT EXISTS traco_usos (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    id_traco          TEXT NOT NULL REFERENCES tracos(id_traco),
    id_operacao       TEXT NOT NULL,
    id_bateria        TEXT,
    berco_inicio      TEXT,
    berco_finalizacao TEXT,
    obs               TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_traco_usos_traco ON traco_usos(id_traco);
  CREATE INDEX IF NOT EXISTS idx_traco_usos_operacao ON traco_usos(id_operacao);

  -- Ajustes de receita normalizados (substitui ajustes_tracos.json) — 1
  -- linha por ajuste (era 1 chave "ajuste_N" por ajuste, dentro de 1 JSON
  -- por traço). "ordem" substitui o N — sequencial por id_traco.
  -- id_traco NÃO tem FK pra tracos(id_traco) de propósito: o "+ Ajuste de
  -- Receita" ao vivo, em Registrar Operação, grava aqui ENQUANTO o traço
  -- ainda só existe na memória do navegador — o registro em "tracos" só
  -- acontece depois, ao finalizar/registrar a operação. Exigir o FK
  -- quebraria o fluxo ao vivo (o ajuste chega sempre antes do traço).
  CREATE TABLE IF NOT EXISTS ajustes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    id_traco      TEXT NOT NULL,
    ordem         INTEGER NOT NULL,
    tempo_batida  REAL NOT NULL,  -- minutos (mesma unidade de ajustes_tracos.json hoje)
    cimento       REAL,
    agua          REAL,
    eps           REAL,
    superplast    REAL,
    incorporador  REAL,
    registrado_em TEXT NOT NULL,
    UNIQUE(id_traco, ordem)
  );
  CREATE INDEX IF NOT EXISTS idx_ajustes_traco ON ajustes(id_traco, ordem);

  -- Insumos de Receitas dinâmicos (Configurações → Insumos de Receitas) —
  -- substitui as colunas fixas cimento_original/agua_original/etc de
  -- "tracos" (valor "original" de cada insumo, 1 linha por insumo por
  -- traço) e cimento/agua/etc de "ajustes" (valor de cada insumo POR
  -- ajuste/reaproveitamento, 1 linha por insumo por ajuste — FK pro id
  -- autoincrement de "ajustes", não pro par id_traco+ordem, propósito:
  -- sobrevive a qualquer reordenação futura de ajustes). As colunas
  -- fixas continuam existindo nas duas tabelas acima só pra migração
  -- (ver migrarInsumosFixosParaDinamico em lib/db/tracos.js) — nenhum
  -- código novo deve lê-las/escrevê-las depois da Fase 2.
  CREATE TABLE IF NOT EXISTS traco_insumos (
    id_traco TEXT NOT NULL,
    insumo   TEXT NOT NULL,
    valor    REAL,
    PRIMARY KEY (id_traco, insumo)
  );
  CREATE INDEX IF NOT EXISTS idx_traco_insumos_traco ON traco_insumos(id_traco);

  CREATE TABLE IF NOT EXISTS ajuste_insumos (
    id_ajuste INTEGER NOT NULL,
    insumo    TEXT NOT NULL,
    valor     REAL,
    PRIMARY KEY (id_ajuste, insumo)
  );
  CREATE INDEX IF NOT EXISTS idx_ajuste_insumos_ajuste ON ajuste_insumos(id_ajuste);

  -- Leituras de Densidade/Flow (remedições — NÃO entram em "ajustes": não
  -- têm tempo de batida associado, são só uma releitura que substitui a
  -- anterior, não uma adição). 1 linha por leitura. Diferente de "ajustes"
  -- (acima), essas só são gravadas no registro final do traço — a tabela
  -- "tracos" já existe nesse momento, então o FK aqui é seguro.
  CREATE TABLE IF NOT EXISTS leituras_resultado (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    id_traco TEXT NOT NULL REFERENCES tracos(id_traco),
    campo    TEXT NOT NULL CHECK(campo IN ('densidade', 'flow')),
    valor    REAL NOT NULL,
    ordem    INTEGER NOT NULL,
    UNIQUE(id_traco, campo, ordem)
  );
  CREATE INDEX IF NOT EXISTS idx_leituras_traco ON leituras_resultado(id_traco, campo);

  -- Auditoria de edições em traços (substitui relatorio_edicoes.json)
  CREATE TABLE IF NOT EXISTS edicoes_traco (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    id_traco         TEXT NOT NULL,
    id_operacao      TEXT,
    data_edicao      TEXT NOT NULL,
    campos_alterados TEXT NOT NULL  -- JSON: [{campo, de, para}, ...]
  );
  CREATE INDEX IF NOT EXISTS idx_edicoes_traco_id ON edicoes_traco(id_traco);

  -- ⚠️ Nota pra quando escrever as queries de total (Fase 5): "original +
  -- SUM(ajustes)" só funciona com COALESCE dos DOIS lados — SUM(coluna)
  -- de uma tabela vazia/sem ajuste já vem 0 com COALESCE(SUM(...),0), mas
  -- se "original" também estiver NULL (campo nunca preenchido), NULL + 0
  -- ainda dá NULL em SQL (propaga). Validado e confirmado durante o
  -- desenvolvimento: a forma certa é
  -- "COALESCE(original,0) + COALESCE(SUM(ajustes.campo),0)", sempre.

  -- ============================================================
  --  FASE 4 — Contador de traços do dia (substitui contador_tracos.json)
  -- ============================================================
  CREATE TABLE IF NOT EXISTS contador_tracos (
    data  TEXT PRIMARY KEY,
    total INTEGER NOT NULL DEFAULT 0
  );

  -- ============================================================
  --  FASE 3 — Paradas (substitui paradas.json)
  --
  --  Estrutura simples e plana — diferente de operacoes/tracos, nenhum
  --  campo aqui é calculado nem serializado como JSON.
  -- ============================================================
  CREATE TABLE IF NOT EXISTS paradas (
    id            TEXT PRIMARY KEY,
    inicio        TEXT NOT NULL,
    fim           TEXT NOT NULL,
    duracao_min   REAL,
    motivo        TEXT,
    equipamento   TEXT,
    classificacao TEXT,
    obs           TEXT,
    registrado_em TEXT,
    -- Mesmo campo/mesmo raciocínio de operacoes.operador_nome, acima.
    operador_nome TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_paradas_inicio ON paradas(inicio);

  -- ============================================================
  --  FASE 4 — Sobra (substitui sobra.json)
  --
  --  Continua sendo "1 linha só, sempre a mais recente" — mesmo
  --  comportamento de hoje (sobra.json é sempre sobrescrito por inteiro,
  --  nunca houve histórico de sobras antigas). id sempre = 1, de propósito
  --  (upsert via ON CONFLICT(id), nunca um 2º registro).
  -- ============================================================
  CREATE TABLE IF NOT EXISTS sobra (
    id                INTEGER PRIMARY KEY,
    ativa             INTEGER NOT NULL DEFAULT 0,
    traco_id          TEXT,
    num_traco         INTEGER,
    operacao_origem   TEXT,
    flow              REAL,
    densidade         REAL,
    -- Cópia da receita do traço no momento em que sobrou — mesma forma
    -- {original, ajustes} de sempre, sem relação com a normalização da
    -- Fase 5 (é só um snapshot, não algo recalculado/consultado).
    receita           TEXT,
    data              TEXT,
    status            TEXT,
    data_encerramento TEXT
  );

  -- ============================================================
  --  Traços Descartados (perda) — ver README, "Registro de Traço
  --  Descartado (Perda) — plano".
  --
  --  De PROPÓSITO sem nenhuma relação com tracos/traco_usos/ajustes/
  --  leituras_resultado: um traço aqui nunca chegou a encher berço
  --  nenhum, então não faz sentido nenhum dos conceitos de "uso"
  --  daquelas tabelas (id_operacao, berco_inicio/fim, ajustes ao vivo,
  --  remedição de densidade/flow). É esse isolamento físico — nenhuma
  --  tabela em comum, nenhuma FK, nenhuma tela hoje faz SELECT nela —
  --  que garante que este dado NUNCA contamina o painel de CEP do Setor
  --  de Qualidade (public/js/qualidade-tracos.js) nem qualquer outro
  --  cálculo que hoje assume "todo traço em tracos = produção real"
  --  (ver justificativa completa no README).
  --
  --  Insumos gravados como número simples (sem a forma {original,
  --  ajustes} das Fases 5/8) — não faz sentido ajustar/remedir um traço
  --  que já foi descartado.
  -- ============================================================
  CREATE TABLE IF NOT EXISTS tracos_descartados (
    id            TEXT PRIMARY KEY,
    data          TEXT,
    turno         TEXT,
    cimento       REAL,
    agua          REAL,
    eps           REAL,
    superplast    REAL,
    incorporador  REAL,
    tempo_batida  REAL,
    motivo        TEXT NOT NULL,
    -- Mesmo raciocínio de operacoes.operador_nome (ver README, "Autoria
    -- automática de registro") — puramente um rótulo de auditoria, não
    -- controle de acesso.
    operador_nome TEXT,
    registrado_em TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tracos_descartados_data ON tracos_descartados(data);

  -- ============================================================
  --  Ocorrências de Segurança — ver README, "Nova página: One Page
  --  Report (planejamento)", Fase 1. Domínio novo (nunca existiu como
  --  arquivo) — mesmo padrão de isolamento físico de tracos_descartados,
  --  acima: sem FK com nenhuma outra tabela, é um registro fechado por
  --  ocorrência.
  --
  --  "gravidade" é um enum fechado (ver GRAVIDADES_VALIDAS,
  --  lib/db/seguranca-ocorrencias.js) — não texto livre como
  --  tracos_descartados.motivo — porque o One Page Report (Fase 5) vai
  --  agrupar/colorir por gravidade; um valor solto digitado errado
  --  quebraria esse agrupamento silenciosamente.
  --
  --  "Dias sem acidentes" (ver diasSemAcidentes, lib/db/seguranca-
  --  ocorrencias.js) É CALCULADO — nunca gravado como coluna — a partir
  --  de MAX(data) desta tabela: sempre a data de HOJE menos a ocorrência
  --  mais recente, do jeito que o README descreve. Evita o mesmo tipo de
  --  bug de "campo calculado que desincroniza do dado real" que motivou
  --  todo o desenho de "original + SUM(ajustes)" em tracos/traco_usos.
  -- ============================================================
  CREATE TABLE IF NOT EXISTS seguranca_ocorrencias (
    id            TEXT PRIMARY KEY,
    data          TEXT NOT NULL,
    descricao     TEXT,
    gravidade     TEXT NOT NULL,
    -- Mesmo raciocínio de operacoes.operador_nome (ver README, "Autoria
    -- automática de registro") — rótulo de auditoria, não controle de
    -- acesso.
    operador_nome TEXT,
    registrado_em TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_seguranca_ocorrencias_data ON seguranca_ocorrencias(data);

  -- ============================================================
  --  Cargas de Expedição — ver README, "Nova página: One Page Report
  --  (planejamento)", Fase 2. Domínio novo (nunca existiu como arquivo) —
  --  mesmo padrão de isolamento físico de seguranca_ocorrencias/
  --  tracos_descartados: sem FK com nenhuma outra tabela, é um registro
  --  fechado por carga expedida.
  --
  --  "m2" fica solto (REAL), não amarrado a M2_POR_PAINEL (public/js/
  --  data.js) — expedição é medida/pesada na doca no momento da carga,
  --  não recalculada a partir de contagem de painéis como o resto do
  --  sistema faz pra produção.
  --
  --  Agregação semanal (S1-S4) e forecast (ver agregacaoSemanalExpedicao,
  --  lib/db/expedicao.js) são CALCULADOS em cima de "data" — nunca
  --  gravados como coluna — mesmo raciocínio de "dias sem acidentes"
  --  (seguranca_ocorrencias, acima).
  -- ============================================================
  CREATE TABLE IF NOT EXISTS expedicao_cargas (
    id             TEXT PRIMARY KEY,
    data           TEXT NOT NULL,
    cliente        TEXT NOT NULL,
    m2             REAL NOT NULL,
    numero_carga   TEXT,
    -- Mesmo raciocínio de operacoes.operador_nome (ver README, "Autoria
    -- automática de registro") — rótulo de auditoria, não controle de
    -- acesso.
    operador_nome  TEXT,
    registrado_em  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_expedicao_cargas_data ON expedicao_cargas(data);

  -- ============================================================
  --  Berços Visuais — snapshot de estado dos 2 LADOS de cada berço
  --  físico de uma operação (representação visual já existente hoje em
  --  "Bateria Atual", ver bateria-atual.js — só que sem persistência
  --  até esta mudança).
  --
  --  1 linha por OPERAÇÃO (não por berço) — todos os berços da bateria
  --  inteira, com os 2 estados de cada um (esquerda/direita), vivem
  --  juntos na coluna "bercos", como uma lista em JSON:
  --    [ {"berco":"B1","ordem":1,"estado_esquerda":"okay","estado_direita":"baixou"},
  --      {"berco":"B2","ordem":2,"estado_esquerda":"okay","estado_direita":"okay"},
  --      ... ]
  --  A quantidade de berços varia de bateria pra bateria (8 a 22+), então
  --  não dá pra ter 1 coluna fixa por berço — uma lista dentro de 1 coluna
  --  só é o jeito de manter "1 bateria = 1 linha" sem SQLite reclamar de
  --  esquema variável. Quem precisar ler/filtrar um berço específico faz
  --  isso em JS depois do SELECT (json_extract também funciona direto no
  --  SQLite, se precisar filtrar/agregar via SQL no futuro).
  --
  --  id_traco NÃO é guardado aqui — os traços de uma operação já vivem em
  --  traco_usos(id_operacao), então é sempre um JOIN dali, nunca duplicado
  --  (mesmo princípio de "original + SUM(ajustes)" explicado acima: nunca
  --  guardar de novo o que já existe em outra tabela).
  --
  --  "estado_esquerda"/"estado_direita" (dentro do JSON) só assumem
  --  'okay'/'baixou' por enquanto — outros estados chegam numa fase
  --  futura (ver README, "Berços Visuais").
  -- ============================================================
  CREATE TABLE IF NOT EXISTS bercos_visuais (
    id_operacao   TEXT PRIMARY KEY REFERENCES operacoes(id),
    bercos        TEXT NOT NULL,  -- JSON: [{berco, ordem, estado_esquerda, estado_direita}, ...]
    atualizado_em TEXT NOT NULL
  );

  -- ============================================================
  --  Avaliações de Qualidade — resultado final de cada avaliação feita
  --  no Setor de Qualidade (public/setor-qualidade-app.html). Antes
  --  disso, tanto a avaliação quanto os painéis (~40 por avaliação, 4
  --  pallets × 10 placas) viviam só no localStorage do navegador — sem
  --  backup, sem sincronizar entre dispositivos, e sumindo se alguém
  --  limpasse os dados do navegador.
  --
  --  1 linha por avaliação (mesmo espírito de bercos_visuais, acima):
  --  os campos usados pra filtrar/ordenar (bateria, turno, data do
  --  registro, operação vinculada) viram coluna própria; o resto —
  --  inclusive a lista inteira de painéis — vai dentro da coluna "dados"
  --  em JSON. Rascunhos (avaliações ainda não registradas) CONTINUAM só
  --  no localStorage — só a avaliação já registrada (definitiva) entra
  --  aqui, mesmo princípio de "operação em andamento" (local, efêmero)
  --  vs. "operações" (SQL, definitivo) já usado no resto do sistema.
  --
  --  id_operacao é a bateria de Registro de Operação vinculada (pode ser
  --  NULL — avaliação avulsa, sem vínculo).
  -- ============================================================
  CREATE TABLE IF NOT EXISTS avaliacoes_qualidade (
    id            TEXT PRIMARY KEY,
    id_operacao   TEXT REFERENCES operacoes(id),
    id_bateria    TEXT,
    turno         TEXT,
    registrado_em TEXT NOT NULL,
    -- Nome de quem avaliou (ver LW.nomeDeQuemEstaLogado(), data.js) —
    -- mesmo raciocínio de operacoes.operador_nome (acima): puramente
    -- informativo, preenchido automaticamente com quem está logado no
    -- momento do registro, nunca usado como controle de acesso.
    avaliador_nome TEXT,
    dados         TEXT NOT NULL  -- JSON: avaliação inteira, incluindo a lista de painéis
  );
  CREATE INDEX IF NOT EXISTS idx_avaliacoes_qualidade_operacao ON avaliacoes_qualidade(id_operacao);
  -- Usado por _totalAvaliacoesNoDia (lib/db/operacoes-qualidade.js) pra
  -- calcular a Sequência do Dia automática (conta quantas avaliações já
  -- foram registradas no dia, via range de registrado_em) sem varrer a
  -- tabela inteira a cada registro novo.
  CREATE INDEX IF NOT EXISTS idx_avaliacoes_qualidade_registrado_em ON avaliacoes_qualidade(registrado_em);

  -- ============================================================
  --  Painéis da Avaliação de Qualidade — MESMOS dados que já vivem
  --  dentro de avaliacoes_qualidade.dados (JSON), só que extraídos numa
  --  tabela própria pra dar pra fazer JOIN/consulta em SQL direto (ver
  --  db.relatorioBercos()/correlacaoTracoBerco(), que fazem o mesmo com
  --  bercos_visuais/tracos) — sem essa tabela, qualquer cruzamento
  --  precisaria carregar TODAS as avaliações inteiras (dados completo,
  --  JSON) pra dentro do JS só pra olhar os painéis de uma vez.
  --
  --  1 linha por avaliação (mesmo espírito de bercos_visuais, acima): os
  --  painéis daquela avaliação inteira vão dentro de 1 coluna JSON —
  --  NÃO 1 coluna por painel (ex: painel1..painel44). Isso foi decisão
  --  deliberada, não só preguiça: painel não é uma sequência plana de
  --  1 a 44 — é (pallet 1-4) × (posição 1 a 8/10/11, conforme a dimensão
  --  da bateria — ver getSlabCount(), setor-qualidade.js), e a imensa
  --  maioria fica SEM marca nenhuma (só quem tem defeito, ou aprovação
  --  explícita, é marcado — ver classifyMarks()). Um esquema de 44
  --  colunas fixas teria quase tudo NULL quase sempre, não converteria
  --  painel<->coluna de um jeito natural (pallet+posição não é um índice
  --  1-44 direto), e travaria o sistema em 44 pra sempre (mudar a
  --  quantidade de painéis por bateria exigiria ALTER TABLE). O array
  --  JSON não tem esse teto.
  --
  --  linha (dentro do JSON de cada painel): '1ª'/'2ª'/null — Verde
  --  marca 1ª linha, Azul marca 2ª linha (ambos "aprovado" pra
  --  resultado, mas linhas diferentes — ver getClassifiedInfo/
  --  _linhaDoAprovado, setor-qualidade.js).
  -- ============================================================
  CREATE TABLE IF NOT EXISTS avaliacao_paineis (
    id_avaliacao  TEXT PRIMARY KEY REFERENCES avaliacoes_qualidade(id),
    id_operacao   TEXT REFERENCES operacoes(id),
    id_bateria    TEXT,
    registrado_em TEXT NOT NULL,
    paineis       TEXT NOT NULL  -- JSON: [{pallet, posicao, tipoEsperado, tipoObtido, resultado, linha, marcas}, ...]
  );
  CREATE INDEX IF NOT EXISTS idx_avaliacao_paineis_operacao ON avaliacao_paineis(id_operacao);

  -- ============================================================
  --  Operações Avaliadas (Setor de Qualidade) — só a LISTA de IDs de
  --  operação que já foram avaliadas, nada mais. Existe pra não precisar
  --  gravar esse status DENTRO da própria linha de "operacoes" (que o
  --  resto do sistema trata como praticamente imutável — ver
  --  CAMPOS_PROTEGIDOS em /editar-operacao, server.js): marcar uma
  --  operação como avaliada vira um INSERT aqui, nunca mais um UPDATE em
  --  "operacoes".
  --
  --  Fonte de verdade de "esta operação já foi avaliada?" a partir de
  --  agora: GET /operacoes-nao-avaliadas (a fila do Setor de Qualidade)
  --  exclui pelo NOT IN nesta tabela. A coluna "operacoes.avaliado"
  --  (acima) fica só como legado, não é mais escrita por rota nenhuma.
  --
  --  Não guarda mais nada além do id — quem quiser os DADOS da avaliação
  --  em si (painéis, observações, datas etc.) continua buscando em
  --  avaliacoes_qualidade (via id_operacao); esta tabela responde só
  --  "avaliada ou não", não "o que foi avaliado".
  -- ============================================================
  CREATE TABLE IF NOT EXISTS operacoes_avaliadas (
    id_operacao TEXT PRIMARY KEY REFERENCES operacoes(id),
    avaliado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Setor de Manutenção (chamados corretivos, manutenção programada,
  -- almoxarifado) foi descontinuado — recurso removido do produto por
  -- decisão de negócio (ver conversa que motivou isso). DROP explícito
  -- (não só deixar de criar) porque instalações que já rodaram uma
  -- versão anterior têm essas tabelas no arquivo .db local; dados
  -- descartados junto por pedido explícito na mesma conversa.
  DROP TABLE IF EXISTS manutencao_corretiva;
  DROP TABLE IF EXISTS manutencao_programada;
  DROP TABLE IF EXISTS manutencao_movimentacoes;
  DROP TABLE IF EXISTS manutencao_estoque;

  -- ============================================================
  --  NOTIFICAÇÕES PUSH — Web Push (PC e celular via PWA)
  --
  --  Guarda a "inscrição" (PushSubscription) que o navegador devolve
  --  depois que o usuário aceita receber notificações (ver
  --  public/js/notificacoes-push.js) — endpoint + chaves públicas do
  --  navegador (p256dh/auth), nunca uma senha nem nada sensível. 1
  --  usuário pode ter VÁRIAS inscrições ao mesmo tempo (PC do chão de
  --  fábrica + celular pessoal, por exemplo) — por isso "endpoint" é a
  --  chave única (1 por dispositivo/navegador), não "usuario_nome".
  --  "usuario_nome" é o texto livre do cadastro (mesmo campo usado como
  --  autoria em outras tabelas, ex: manutencao_corretiva.observador) —
  --  é contra ele que se decide, na hora de notificar, se o PERFIL
  --  daquele nome tem a permissão "Notificar Abertura de Chamado" (ver
  --  lib/itens-permissao.js e lib/notificacoes-push.js).
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint      TEXT PRIMARY KEY,
    usuario_nome  TEXT NOT NULL,
    p256dh        TEXT NOT NULL,
    auth          TEXT NOT NULL,
    user_agent    TEXT,
    criado_em     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_push_subscriptions_usuario ON push_subscriptions(usuario_nome);

  -- ============================================================
  --  SESSÕES — Admin Master e Usuário Cadastrado
  --
  --  Antes viviam só num Map em memória (lib/sessao.js e
  --  lib/sessao-usuario.js) — todo mundo era deslogado a cada restart/
  --  deploy do servidor (no caso do usuário cadastrado, isso podia
  --  acontecer NO MEIO DE UM TURNO de 12h). Persistir aqui (mesmo banco
  --  que já existe pros dados de produção, sem dependência nova) resolve
  --  isso: um restart do processo não derruba mais ninguém, só expira no
  --  horário normal de cada uma. "expira_em" é epoch ms (Date.now()),
  --  não TEXT, pra comparar direto com Date.now() nas queries sem
  --  conversão.
  CREATE TABLE IF NOT EXISTS sessoes_admin (
    token      TEXT PRIMARY KEY,
    expira_em  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessoes_admin_expira ON sessoes_admin(expira_em);

  -- "dados_json" guarda {usuarioId, nomeUsuario, perfil,
  -- podeIniciarOperacao} serializado — mesmo raciocínio de outras colunas
  -- *_json deste arquivo (ex: bercos_personalizados): um dicionário
  -- pequeno e fechado, nunca consultado por campo individual (só lido
  -- inteiro, ver lib/sessao-usuario.js), então não vale a pena virar
  -- colunas próprias.
  CREATE TABLE IF NOT EXISTS sessoes_usuario (
    token      TEXT PRIMARY KEY,
    dados_json TEXT NOT NULL,
    expira_em  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessoes_usuario_expira ON sessoes_usuario(expira_em);

  -- Rate limit de tentativas de senha/chave de recuperação por IP (ver
  -- lib/auth.js) — protege /verificar-senha, /verificar-recovery e as 3
  -- rotas mais destrutivas do sistema (/mesclar-backup-dados,
  -- /restaurar-backup-dados, /restaurar-backup-geral), todas usando a
  -- MESMA senha compartilhada do Administrador. Antes vivia só num Map em
  -- memória — um restart do processo (deploy, reboot, crash) zerava o
  -- contador de qualquer IP, dando a quem estivesse tentando força bruta
  -- uma folga completa de novo a cada restart. Persistir aqui (mesmo banco
  -- que já existe, sem dependência nova) fecha essa brecha: só expira pelo
  -- tempo normal (RATE_LIMIT_JANELA_MS/RATE_LIMIT_BLOQUEIO_MS), nunca por
  -- reiniciar o servidor — mesmo raciocínio de sessoes_admin/
  -- sessoes_usuario, acima. "ip" como chave (não por usuário — não há
  -- login de usuário nessas rotas, só a senha compartilhada).
  CREATE TABLE IF NOT EXISTS tentativas_senha_ip (
    ip            TEXT PRIMARY KEY,
    tentativas    INTEGER NOT NULL,
    primeira_em   INTEGER NOT NULL, -- epoch ms — início da janela atual
    bloqueado_ate INTEGER           -- epoch ms, ou NULL se ainda não bloqueado
  );

  -- ============================================================
  --  EXPORTAÇÕES DE PDF — Etapa 3 do plano "PDF sobrevive a fechar a aba"
  --  (ver README)
  --
  --  Espelha, em disco/SQLite, o que lib/rotas/exportar-pdf.js mantém em
  --  memória (o Map "_jobs") enquanto o job está "vivo" pro acompanhamento
  --  via Server-Sent Events — mas ISTO aqui sobrevive a um restart do
  --  processo E ao TTL de limpeza da memória (JOB_TTL_MS, 10 min): o
  --  arquivo do PDF pronto (ver caminho_arquivo, guardado em
  --  private/pdfs-pendentes/, nunca dentro de public/ — mesmo motivo de
  --  security.json, ver lib/security-json.js) continua disponível pra
  --  download mesmo que a aba/processo que pediu o export tenha caído no
  --  meio do caminho, ou que o usuário só volte a acessar minutos/horas
  --  depois.
  --
  --  "status": 'processando' | 'concluido' | 'erro' | 'cancelado'.
  --
  --  "usuario_id" (Etapa 1 do plano, ver README) — quem pediu o export,
  --  via lib/sessao-usuario.js (POST /exportar-pdf/iniciar exige sessão
  --  de usuário cadastrado a partir desta etapa). Continua NULLABLE só
  --  por segurança de schema (linhas antigas, criadas ANTES desta etapa
  --  existir, já têm usuario_id = NULL) — toda linha NOVA sempre vem
  --  preenchida.
  CREATE TABLE IF NOT EXISTS exportacoes_pdf (
    job_id          TEXT PRIMARY KEY,
    usuario_id      TEXT,
    nome_arquivo    TEXT NOT NULL,
    status          TEXT NOT NULL,
    caminho_arquivo TEXT,             -- só preenchido quando status = 'concluido'
    tamanho_bytes   INTEGER,
    erro            TEXT,             -- só preenchido quando status = 'erro'
    criado_em       INTEGER NOT NULL, -- epoch ms
    concluido_em    INTEGER           -- epoch ms
  );
  CREATE INDEX IF NOT EXISTS idx_exportacoes_pdf_status ON exportacoes_pdf(status);
  CREATE INDEX IF NOT EXISTS idx_exportacoes_pdf_usuario ON exportacoes_pdf(usuario_id);
`);


// ------------------------------------------------------------
//  Migração: bercos_visuais -> 1 LINHA POR OPERAÇÃO (berços em JSON)
//
//  Já existiram 3 formatos anteriores pra essa tabela, do mais antigo
//  pro mais recente:
//   a) 1 linha por berço, 1 coluna "estado" só (sem diferenciar lado);
//   b) 2 linhas por berço (uma "lado esquerda", outra "lado direita");
//   c) 1 linha por berço, com "estado_esquerda"/"estado_direita" em
//      colunas separadas.
//  O formato atual junta TODOS os berços de uma operação numa lista
//  JSON dentro de 1 linha só (coluna "bercos") — ver comentário acima da
//  CREATE TABLE.
//
//  2 migrações em cadeia, cada uma cuidando de 1 salto:
//   1ª) formato (a) ou (b) -> formato (c) — já existia antes desta
//       mudança, mantida como está.
//   2ª) formato (c) -> formato atual (nova, abaixo) — agrupa as linhas
//       (1 por berço) de cada operação numa lista JSON só.
//  SQLite não deixa trocar chave primária/colunas existentes via ALTER
//  TABLE — só recriando a tabela — por isso o recria-e-migra em cada
//  passo, igual às outras migrações estruturais deste arquivo. Cada
//  migração detecta se já é necessária pelas colunas presentes (PRAGMA
//  table_info) e não faz nada se a tabela já estiver adiantada o
//  suficiente.
// ------------------------------------------------------------
function _colunasDe(tabela) {
  return db.prepare(`PRAGMA table_info(${tabela})`).all().map(c => c.name);
}

// 1ª migração (pré-existente): (a)/(b) -> (c) — "1 linha por berço, com
// estado_esquerda/estado_direita em colunas". Não roda mais se a tabela
// já pulou direto pro formato atual (coluna "bercos" já presente).
if (!_colunasDe('bercos_visuais').includes('bercos') && !_colunasDe('bercos_visuais').includes('estado_esquerda')) {
  const temColunaLado = _colunasDe('bercos_visuais').includes('lado');

  let linhasMigradas;
  if (temColunaLado) {
    const linhasAntigas = db.prepare(
      "SELECT id_operacao, berco, ordem, lado, estado, atualizado_em FROM bercos_visuais"
    ).all();
    const porBerco = new Map(); // chave: id_operacao + '\u0000' + berco
    for (const l of linhasAntigas) {
      const chave = l.id_operacao + '\u0000' + l.berco;
      const atual = porBerco.get(chave) || {
        id_operacao: l.id_operacao, berco: l.berco, ordem: l.ordem,
        estado_esquerda: 'okay', estado_direita: 'okay', atualizado_em: l.atualizado_em,
      };
      if (l.lado === 'esquerda') atual.estado_esquerda = l.estado; else atual.estado_direita = l.estado;
      if (l.atualizado_em > atual.atualizado_em) atual.atualizado_em = l.atualizado_em;
      porBerco.set(chave, atual);
    }
    linhasMigradas = Array.from(porBerco.values());
  } else {
    const linhasAntigas = db.prepare(
      "SELECT id_operacao, berco, ordem, estado, atualizado_em FROM bercos_visuais"
    ).all();
    linhasMigradas = linhasAntigas.map(l => ({
      id_operacao: l.id_operacao, berco: l.berco, ordem: l.ordem,
      estado_esquerda: l.estado, estado_direita: l.estado, atualizado_em: l.atualizado_em,
    }));
  }

  db.exec(`
    ALTER TABLE bercos_visuais RENAME TO bercos_visuais_old;
    CREATE TABLE bercos_visuais (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      id_operacao     TEXT NOT NULL REFERENCES operacoes(id),
      berco           TEXT NOT NULL,
      ordem           INTEGER NOT NULL,
      estado_esquerda TEXT NOT NULL DEFAULT 'okay',
      estado_direita  TEXT NOT NULL DEFAULT 'okay',
      atualizado_em   TEXT NOT NULL,
      UNIQUE(id_operacao, berco)
    );
    DROP TABLE bercos_visuais_old;
  `);

  if (linhasMigradas.length) {
    const inserirMigrado = db.prepare(`
      INSERT INTO bercos_visuais (id_operacao, berco, ordem, estado_esquerda, estado_direita, atualizado_em)
      VALUES (@id_operacao, @berco, @ordem, @estado_esquerda, @estado_direita, @atualizado_em)
    `);
    const transacaoMigracao = db.transaction((linhas) => {
      for (const l of linhas) inserirMigrado.run(l);
    });
    transacaoMigracao(linhasMigradas);
  }
  console.log(`[migração] Tabela "bercos_visuais" consolidada em 1 linha por berço (${linhasMigradas.length} berço(s) migrado(s)).`);
}

// 2ª migração (nova): (c) -> formato atual — "1 linha por OPERAÇÃO",
// todos os berços daquela operação juntos numa lista JSON. Reconsulta as
// colunas (a 1ª migração, acima, pode ter acabado de recriar a tabela).
if (!_colunasDe('bercos_visuais').includes('bercos')) {
  const linhasAntigas = db.prepare(
    "SELECT id_operacao, berco, ordem, estado_esquerda, estado_direita, atualizado_em FROM bercos_visuais ORDER BY id_operacao, ordem"
  ).all();

  const porOperacao = new Map();
  for (const l of linhasAntigas) {
    const atual = porOperacao.get(l.id_operacao) || { id_operacao: l.id_operacao, bercos: [], atualizado_em: l.atualizado_em };
    atual.bercos.push({ berco: l.berco, ordem: l.ordem, estado_esquerda: l.estado_esquerda, estado_direita: l.estado_direita });
    if (l.atualizado_em > atual.atualizado_em) atual.atualizado_em = l.atualizado_em;
    porOperacao.set(l.id_operacao, atual);
  }
  const linhasMigradas = Array.from(porOperacao.values());

  db.exec(`
    ALTER TABLE bercos_visuais RENAME TO bercos_visuais_old;
    CREATE TABLE bercos_visuais (
      id_operacao   TEXT PRIMARY KEY REFERENCES operacoes(id),
      bercos        TEXT NOT NULL,
      atualizado_em TEXT NOT NULL
    );
    DROP TABLE bercos_visuais_old;
  `);

  if (linhasMigradas.length) {
    const inserirMigrado = db.prepare(`
      INSERT INTO bercos_visuais (id_operacao, bercos, atualizado_em)
      VALUES (@id_operacao, @bercos, @atualizado_em)
    `);
    const transacaoMigracao = db.transaction((linhas) => {
      for (const l of linhas) inserirMigrado.run({ ...l, bercos: JSON.stringify(l.bercos) });
    });
    transacaoMigracao(linhasMigradas);
  }
  console.log(`[migração] Tabela "bercos_visuais" consolidada em 1 linha por operação (${linhasMigradas.length} operação(ões) migrada(s)).`);
}

// ------------------------------------------------------------
//  Migração leve: coluna "avaliado" em operacoes
//
//  CREATE TABLE IF NOT EXISTS (acima) só cria a tabela do zero — em
//  instalações que já tinham "operacoes" antes desta mudança, a coluna
//  nova nunca apareceria sozinha. Checa via PRAGMA table_info (idempotente,
//  roda toda vez que o servidor sobe) e só faz ALTER TABLE na primeira
//  vez. SQLite não tem "ADD COLUMN IF NOT EXISTS" nativo — por isso o
//  check manual, em vez de tentar/capturar erro.
// ------------------------------------------------------------
const _colunasOperacoes = db.prepare("PRAGMA table_info(operacoes)").all().map(c => c.name);
if (!_colunasOperacoes.includes('avaliado')) {
  db.exec('ALTER TABLE operacoes ADD COLUMN avaliado INTEGER NOT NULL DEFAULT 0');
  console.log('[migração] Coluna "avaliado" adicionada à tabela operacoes (default: não avaliado).');
}

// ------------------------------------------------------------
//  Migração leve: coluna "operador_nome" em operacoes E em paradas —
//  ver comentário em operacoes.operador_nome, acima, pro raciocínio
//  completo. Mesmo padrão da migração de "avaliado".
// ------------------------------------------------------------
if (!_colunasOperacoes.includes('operador_nome')) {
  db.exec('ALTER TABLE operacoes ADD COLUMN operador_nome TEXT');
  console.log('[migração] Coluna "operador_nome" adicionada à tabela operacoes.');
}
// bercos_dimensoes — ver comentário na CREATE TABLE operacoes, acima.
// Adicionada depois da primeira versão da tabela, daí a migração leve,
// mesmo padrão das demais.
if (!_colunasOperacoes.includes('bercos_dimensoes')) {
  db.exec('ALTER TABLE operacoes ADD COLUMN bercos_dimensoes TEXT');
  console.log('[migração] Coluna "bercos_dimensoes" adicionada à tabela operacoes.');
}
// origem_offline/validado_por/validado_em — Registro de Operação Offline,
// item 6/7 do plano (ver README). Mesmo padrão de migração leve das
// demais colunas acima; default 0/NULL não muda o comportamento de
// nenhuma operação já existente (todas nasceram ao vivo, nunca offline).
if (!_colunasOperacoes.includes('origem_offline')) {
  db.exec('ALTER TABLE operacoes ADD COLUMN origem_offline INTEGER NOT NULL DEFAULT 0');
  console.log('[migração] Coluna "origem_offline" adicionada à tabela operacoes.');
}
if (!_colunasOperacoes.includes('validado_por')) {
  db.exec('ALTER TABLE operacoes ADD COLUMN validado_por TEXT');
  console.log('[migração] Coluna "validado_por" adicionada à tabela operacoes.');
}
if (!_colunasOperacoes.includes('validado_em')) {
  db.exec('ALTER TABLE operacoes ADD COLUMN validado_em TEXT');
  console.log('[migração] Coluna "validado_em" adicionada à tabela operacoes.');
}
const _colunasParadas = db.prepare("PRAGMA table_info(paradas)").all().map(c => c.name);
if (!_colunasParadas.includes('operador_nome')) {
  db.exec('ALTER TABLE paradas ADD COLUMN operador_nome TEXT');
  console.log('[migração] Coluna "operador_nome" adicionada à tabela paradas.');
}
const _colunasAvaliacoesQualidade = db.prepare("PRAGMA table_info(avaliacoes_qualidade)").all().map(c => c.name);
if (!_colunasAvaliacoesQualidade.includes('avaliador_nome')) {
  db.exec('ALTER TABLE avaliacoes_qualidade ADD COLUMN avaliador_nome TEXT');
  console.log('[migração] Coluna "avaliador_nome" adicionada à tabela avaliacoes_qualidade.');
}

// ------------------------------------------------------------
//  Migração de DADOS (não de schema): "data" da operação passa a ser a
//  data do FIM, não a do início — ver registro-operacao.js/operacao.js
//  (_registrarOperacaoInterna), operacao-offline.js (_aprovar) e
//  edicao.js (/editar-operacao-avancado), que já gravam assim pra
//  operações NOVAS a partir de agora.
//
//  Só isso não corrige as operações que já estavam gravadas ANTES desta
//  mudança — a coluna "data" delas ficou "congelada" com o valor antigo
//  (data do início). Esta migração corrige o passado: para toda operação
//  que atravessou a meia-noite (fim é de um dia diferente de data),
//  recalcula "data" = dia do "fim".
//
//  Idempotente e roda toda vez no boot (SEM check de "já rodei" — não
//  precisa: o WHERE só pega, cada vez, as linhas que ainda estiverem
//  divergentes; depois da 1ª vez não sobra nenhuma, então roda "no-op"
//  para sempre). date(fim) usa o mesmo raciocínio de horaBrasilia()/
//  dataLocal no resto do sistema: inicio/fim são gravados "disfarçados"
//  de UTC (dígitos = hora de parede de Brasília, sem conversão real —
//  ver comentário grande em debriefing.js, dataDoISO), então o SQLite
//  date() aqui já extrai o dia "de parede" certo, sem precisar de
//  timezone nenhum.
const _opsComDataDivergente = db.prepare(`
  UPDATE operacoes SET data = date(fim)
  WHERE fim IS NOT NULL AND date(fim) IS NOT NULL AND data != date(fim)
`).run();
if (_opsComDataDivergente.changes > 0) {
  console.log(`[migração] "data" recalculada (dia do FIM, não do início) em ${_opsComDataDivergente.changes} operação(ões) que atravessaram a meia-noite.`);
}

// ─── Operações / Berços / Avaliação de Qualidade ───────────────────────
// Fase 9 do fatiamento de db.js (ver README, "Fatiamento de db.js
// (plano)") — extraída pra lib/db/operacoes-qualidade.js, sem mudar
// lógica nenhuma, só onde o código mora. O módulo recebe a conexão `db`
// já aberta (mesmo padrão de factory de lib/rotas/ e das fases
// anteriores) e devolve as funções do domínio, que penduramos de volta
// aqui no objeto `db` (module.exports = db, logo abaixo) — todo
// consumidor existente (lib/rotas/consultas.js, lib/rotas/qualidade.js,
// lib/rotas/registro-operacao.js, lib/rotas/backup.js, lib/rotas/
// sql-admin.js) continua chamando db.detalheOperacao(),
// db.salvarAvaliacaoQualidade() etc. sem precisar mudar nada. O schema
// (CREATE TABLE operacoes/bercos_visuais/avaliacoes_qualidade/
// avaliacao_paineis/operacoes_avaliadas) continua acima, em db.js.
//
// module.exports = db precisa continuar aqui (é a 1ª atribuição de
// module.exports no arquivo inteiro — ver README, "Diferença importante
// em relação ao fatiamento de server.js"): tudo que db.js exporta depois
// disso (inclusive as fases já fatiadas mais abaixo — paradas, sobra/
// contador de traços, manutenção, push, sessões) é pendurado neste mesmo
// objeto via Object.assign.
module.exports = db;
Object.assign(module.exports, require('./lib/db/operacoes-qualidade.js')(db));

// ============================================================
//  Migração automática (Fase 2): historico.json -> tabela operacoes
//
//  Roda 1x, no boot do servidor — só faz alguma coisa se a tabela
//  "operacoes" estiver vazia E o arquivo public/db/historico.json ainda
//  existir com esse nome. Depois de migrar, renomeia o arquivo pra
//  "historico.json.migrado-<timestamp>" (nunca apaga) — é assim que um
//  boot futuro sabe "já migrei, não tem o que reimportar", mesmo se a
//  tabela ficar vazia de novo por algum outro motivo (não confunde "já
//  migrei" com "nunca migrei").
// ============================================================
function migrarHistoricoSeNecessario(dbDir) {
  const path = require('path');
  const fs = require('fs');

  const jaTemDados = db.prepare('SELECT COUNT(*) AS n FROM operacoes').get().n > 0;
  if (jaTemDados) return; // já migrado (ou já tem operações registradas direto no SQL)

  const historicoPath = path.join(dbDir, 'historico.json');
  if (!fs.existsSync(historicoPath)) return; // nada pra migrar (instalação nova, ou já migrado antes)

  let historico = [];
  try {
    const texto = fs.readFileSync(historicoPath, 'utf8').trim();
    historico = texto ? JSON.parse(texto) : [];
  } catch (e) {
    console.error('[migração] Não consegui ler historico.json — abortando migração:', e.message);
    return;
  }
  if (!Array.isArray(historico) || !historico.length) {
    // Arquivo existe mas está vazio — nada pra migrar, mas ainda renomeia
    // (evita ficar checando um arquivo vazio em todo boot futuro).
    // Se o rename falhar (ex.: sem permissão de escrita), não é crítico —
    // não havia nada a migrar mesmo; só volta a tentar no próximo boot.
    try { fs.renameSync(historicoPath, historicoPath + '.migrado-' + Date.now()); } catch (_) {}
    return;
  }

  const inserirOperacao = db.prepare(db.SQL_INSERIR_OPERACAO);

  const migrarTudo = db.transaction((registros) => {
    for (const r of registros) {
      inserirOperacao.run({
        ...db.operacaoParaRow(r),
        modo_teste: 0,
        // criado_em "real" não existe no JSON de origem — usa fim/inicio
        // da própria operação como melhor aproximação disponível.
        criado_em: r.fim || r.inicio || new Date().toISOString(),
      });
    }
  });

  migrarTudo(historico);
  console.log(`[migração] ${historico.length} operação(ões) migrada(s) de historico.json pra SQLite.`);

  try {
    fs.renameSync(historicoPath, historicoPath + '.migrado-' + Date.now());
  } catch (e) {
    console.error('[migração] Migrei os dados, mas não consegui renomear historico.json:', e.message);
  }

  // historico_edicoes.json (auditoria) — migra junto, mesmo critério.
  const edicoesPath = path.join(dbDir, 'historico_edicoes.json');
  if (fs.existsSync(edicoesPath)) {
    try {
      const texto = fs.readFileSync(edicoesPath, 'utf8').trim();
      const edicoes = texto ? JSON.parse(texto) : [];
      if (Array.isArray(edicoes) && edicoes.length) {
        const inserirEdicao = db.prepare(`
          INSERT INTO edicoes_operacao (id_operacao, data_edicao, campos_alterados)
          VALUES (@id_operacao, @data_edicao, @campos_alterados)
        `);
        const migrarEdicoes = db.transaction((lista) => {
          for (const e of lista) {
            inserirEdicao.run({
              id_operacao: e.id_operacao,
              data_edicao: e.data_edicao,
              campos_alterados: JSON.stringify(e.campos_alterados || []),
            });
          }
        });
        migrarEdicoes(edicoes);
        console.log(`[migração] ${edicoes.length} edição(ões) migrada(s) de historico_edicoes.json pra SQLite.`);
      }
      fs.renameSync(edicoesPath, edicoesPath + '.migrado-' + Date.now());
    } catch (e) {
      console.error('[migração] Falha ao migrar historico_edicoes.json:', e.message);
    }
  }
}

module.exports.migrarHistoricoSeNecessario = migrarHistoricoSeNecessario;

// ============================================================
//  FASE 3 — paradas.json -> tabela paradas
// ============================================================
// Fase 7 do fatiamento de db.js (ver README) — os conversores de formato
// e a migração deste domínio moram agora em lib/db/paradas.js, sem
// mudar lógica nenhuma. Continuam pendurados aqui no objeto `db`
// (module.exports = db, acima) — lib/rotas/paradas.js e
// lib/rotas/backup.js continuam usando db.paradaParaRow/db.rowParaParada/
// db.SQL_INSERIR_PARADA sem precisar mudar nada, e server.js continua
// chamando db.migrarParadasSeNecessario(DB_DIR) no boot, como sempre.
Object.assign(module.exports, require('./lib/db/paradas.js')(db));

// ============================================================
//  FASE 4 — sobra.json -> tabela sobra; contador_tracos.json -> tabela
//  contador_tracos (essa última já tinha schema desde a Fase 1)
// ============================================================
// Extraída para lib/db/sobra-contador-tracos.js (Fase 6 do fatiamento de
// db.js — ver README, "Fatiamento de db.js (plano)"). Mesma lógica de
// sempre, só mudou onde o código mora.
const criarSobraContadorTracos = require('./lib/db/sobra-contador-tracos');
Object.assign(module.exports, criarSobraContadorTracos(db));

// ============================================================
//  FASE 5 — relatorio_injecao.json + ajustes_tracos.json ->
//  tracos + traco_usos + ajustes + leituras_resultado
//
//  Extraída para lib/db/tracos.js (Fase 8 do fatiamento de db.js — ver
//  README, "Fatiamento de db.js (plano)"). Era a maior fatia isolada que
//  restava, deixada por último de propósito por afetar valor exibido pro
//  usuário. Mesma lógica de sempre, só mudou onde o código mora — quem
//  chamava db.todosOsTracos(), db.substituirTracosEAjustes(),
//  db.migrarRelatorioInjecaoSeNecessario(dbDir), etc. continua chamando
//  exatamente igual.
// ============================================================
const criarDbTracos = require('./lib/db/tracos.js');
Object.assign(module.exports, criarDbTracos(db));

// ============================================================
//  Traços Descartados (perda) — ver README, "Registro de Traço
//  Descartado (Perda) — plano", passo 1.
//
//  Domínio novo (não é fatiamento de nada que já existia em db.js) —
//  segue o mesmo padrão factory do resto de lib/db/ desde o início, sem
//  nenhuma migração de JSON legado (nunca existiu como arquivo).
// ============================================================
const criarDbTracosDescartados = require('./lib/db/tracos-descartados.js');
Object.assign(module.exports, criarDbTracosDescartados(db));

// ============================================================
//  Ocorrências de Segurança — ver README, "Nova página: One Page Report
//  (planejamento)", Fase 1.
//
//  Domínio novo (não é fatiamento de nada que já existia em db.js) — segue
//  o mesmo padrão factory do resto de lib/db/ desde o início, sem nenhuma
//  migração de JSON legado (nunca existiu como arquivo).
// ============================================================
const criarDbSegurancaOcorrencias = require('./lib/db/seguranca-ocorrencias.js');
Object.assign(module.exports, criarDbSegurancaOcorrencias(db));
module.exports.GRAVIDADES_VALIDAS_SEGURANCA = criarDbSegurancaOcorrencias.GRAVIDADES_VALIDAS;

// Fase 2 do plano do One Page Report (ver README) — mesmo padrão de wiring
// da Fase 1, acima.
const criarDbExpedicao = require('./lib/db/expedicao.js');
Object.assign(module.exports, criarDbExpedicao(db));


// ============================================================
//  NOTIFICAÇÕES PUSH — ver CREATE TABLE push_subscriptions, acima.
//  Extraído pra lib/db/notificacoes-push.js (Fase 4 do fatiamento de
//  db.js — ver README.md). O schema (CREATE TABLE) continua aqui.
// ============================================================

const {
  salvarPushSubscription,
  removerPushSubscription,
  removerPushSubscriptionMorta,
  obterPushSubscriptionPorEndpoint,
  listarPushSubscriptionsDoUsuario,
  listarPushSubscriptionsDosUsuarios,
} = require('./lib/db/notificacoes-push.js')(db);

module.exports.salvarPushSubscription = salvarPushSubscription;
module.exports.removerPushSubscription = removerPushSubscription;
module.exports.removerPushSubscriptionMorta = removerPushSubscriptionMorta;
module.exports.obterPushSubscriptionPorEndpoint = obterPushSubscriptionPorEndpoint;
module.exports.listarPushSubscriptionsDoUsuario = listarPushSubscriptionsDoUsuario;
module.exports.listarPushSubscriptionsDosUsuarios = listarPushSubscriptionsDosUsuarios;

// ============================================================
//  SESSÕES — ver CREATE TABLE sessoes_admin/sessoes_usuario, acima.
//  Extraído pra lib/db/sessoes.js (Fase 5 do fatiamento de db.js — ver
//  README.md). O schema (CREATE TABLE) continua aqui.
// ============================================================

const {
  criarSessaoAdmin,
  sessaoAdminValida,
  destruirSessaoAdmin,
  limparSessoesAdminExpiradas,
  criarSessaoUsuario,
  dadosSessaoUsuario,
  destruirSessaoUsuario,
  limparSessoesUsuarioExpiradas,
} = require('./lib/db/sessoes.js')(db);

module.exports.criarSessaoAdmin = criarSessaoAdmin;
module.exports.sessaoAdminValida = sessaoAdminValida;
module.exports.destruirSessaoAdmin = destruirSessaoAdmin;
module.exports.limparSessoesAdminExpiradas = limparSessoesAdminExpiradas;
module.exports.criarSessaoUsuario = criarSessaoUsuario;
module.exports.dadosSessaoUsuario = dadosSessaoUsuario;
module.exports.destruirSessaoUsuario = destruirSessaoUsuario;
module.exports.limparSessoesUsuarioExpiradas = limparSessoesUsuarioExpiradas;

// ============================================================
//  EXPORTAÇÕES DE PDF — ver CREATE TABLE exportacoes_pdf, acima.
//  Etapa 3 do plano "PDF sobrevive a fechar a aba" (ver README) —
//  extraído pra lib/db/exportacoes-pdf.js, mesmo padrão de
//  lib/db/sessoes.js, logo acima.
// ============================================================

const {
  criarRegistroExportacaoPdf,
  marcarExportacaoPdfConcluida,
  marcarExportacaoPdfErro,
  marcarExportacaoPdfCancelada,
  obterExportacaoPdf,
  obterExportacaoPdfAtivaDoUsuario,
  apagarExportacaoPdf,
  listarExportacoesPdfExpiradas,
  corrigirExportacoesPdfOrfasNaSubida,
} = require('./lib/db/exportacoes-pdf.js')(db);

module.exports.criarRegistroExportacaoPdf = criarRegistroExportacaoPdf;
module.exports.marcarExportacaoPdfConcluida = marcarExportacaoPdfConcluida;
module.exports.marcarExportacaoPdfErro = marcarExportacaoPdfErro;
module.exports.marcarExportacaoPdfCancelada = marcarExportacaoPdfCancelada;
module.exports.obterExportacaoPdf = obterExportacaoPdf;
module.exports.obterExportacaoPdfAtivaDoUsuario = obterExportacaoPdfAtivaDoUsuario;
module.exports.apagarExportacaoPdf = apagarExportacaoPdf;
module.exports.listarExportacoesPdfExpiradas = listarExportacoesPdfExpiradas;
module.exports.corrigirExportacoesPdfOrfasNaSubida = corrigirExportacoesPdfOrfasNaSubida;
