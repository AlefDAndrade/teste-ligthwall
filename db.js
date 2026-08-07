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

  -- ============================================================
  --  SETOR DE MANUTENÇÃO — Fase 2 (backend real)
  --
  --  Antes vivia inteiro em localStorage do navegador (Fase 1, ver
  --  public/js/manutencao.js) — sem sincronizar entre computadores, sem
  --  entrar em nenhum backup. Ver conversa que motivou esta migração.
  --  2 "tabelas" no protótipo original (arrays em localStorage), viram
  --  2 tabelas SQL de verdade:
  --    manutencoes (JS)     -> manutencao_corretiva
  --    agendamentos (JS)    -> manutencao_programada
  --  Nomes de tabela prefixados com "manutencao_" (diferente do resto do
  --  schema) só aqui, de propósito — evita colisão com nomes genéricos
  --  já em uso por outros domínios.
  -- ============================================================

  -- Chamados de manutenção corretiva — 1 linha por chamado. Campos
  -- fielmente replicados do protótipo original (ver salvarManutencao(),
  -- public/js/manutencao.js) — nomenclatura em português mantida de
  -- propósito, mesma convenção que o resto deste arquivo já quebra em
  -- alguns lugares (ex: colunas de paradas), por já ser assim desde a
  -- Fase 1 e não valer a pena renomear só por rigor.
  --
  -- foto_operador/foto_tecnico continuam TEXT com o conteúdo em
  -- base64/data-URI embutido direto na linha (mesmo formato de sempre —
  -- upload de foto/PDF de verdade ainda é uma pendência à parte, ver
  -- README). tipos é um array JSON (ex: ["Elétrica","Mecânica"]).
  CREATE TABLE IF NOT EXISTS manutencao_corretiva (
    id                TEXT PRIMARY KEY,
    data              TEXT,
    setor             TEXT NOT NULL,
    maquina           TEXT NOT NULL,
    turno             TEXT,
    observador        TEXT NOT NULL,
    prioridade        TEXT NOT NULL,
    anomalia          TEXT NOT NULL,
    local             TEXT,
    tipos             TEXT,  -- JSON: array de strings
    tipo_manutencao   TEXT NOT NULL,
    tipo_etiqueta     TEXT DEFAULT 'Azul',
    tipo_execucao     TEXT DEFAULT 'Interno',
    empresa_externa   TEXT,
    responsavel       TEXT,
    foto_operador     TEXT,
    foto_tecnico      TEXT,
    data_inicio       TEXT,
    hora_inicio       TEXT,
    data_fim          TEXT,
    hora_fim          TEXT,
    tempo_gasto       INTEGER DEFAULT 0,  -- minutos
    situacao          TEXT DEFAULT 'Aguardando',
    em_manutencao     TEXT DEFAULT 'Nao',
    aguardando_pecas  TEXT DEFAULT 'Nao',
    pecas_avariadas   TEXT,
    pecas_comprar     TEXT,
    rotina            TEXT,
    sup_data_inicio   TEXT,
    sup_hora_inicio   TEXT,
    sup_data_fim      TEXT,
    sup_hora_fim      TEXT,
    sup_tempo_gasto   INTEGER DEFAULT 0,  -- minutos
    status_compra     TEXT,
    previsao_chegada  TEXT,
    fornecedor        TEXT,
    resp_supervisor   TEXT,
    obs_supervisor    TEXT,
    custo_pecas       REAL DEFAULT 0,
    custo_mao_obra    REAL DEFAULT 0,
    etiqueta_fechada  INTEGER NOT NULL DEFAULT 0,
    -- Novo fluxo de aceite (ver conversa que motivou isso): "aceito"
    -- controla se os campos de Execução (Seção 3) aparecem — só depois
    -- que alguém do time de manutenção (Manutenção/Supervisão/
    -- Encarregado/Admin) clica "Aceitar Chamado" (ver POST
    -- /manutencao/aceitar-corretiva, lib/rotas/manutencao.js).
    -- "pedido_peca_aceito" é o mesmo princípio pro Acompanhamento da
    -- Supervisão (Seção 4): só aparece depois que Supervisão/
    -- Encarregado/Admin aceitarem o pedido de peça (POST
    -- /manutencao/aceitar-pedido-peca). Ambos só são alterados por essas
    -- 2 rotas dedicadas — o upsert geral (salvarManutencaoCorretiva)
    -- NUNCA aceita esses campos vindos do cliente, sempre preserva o
    -- que já estava salvo (ver comentário na função, mais abaixo).
    aceito                    TEXT NOT NULL DEFAULT 'Nao',
    aceito_por                TEXT,
    aceito_em                 TEXT,
    pedido_peca_aceito        TEXT NOT NULL DEFAULT 'Nao',
    pedido_peca_aceito_por    TEXT,
    pedido_peca_aceito_em     TEXT,
    -- Confirmação de RECEBIMENTO da peça (ver conversa que motivou isso):
    -- depois que a Supervisão marca "Status da Compra = Peça recebida",
    -- o formulário de Execução (Seção 3) NÃO reabre direto — antes disso,
    -- a Manutenção (mesmo grupo de podeAceitarChamado: Manutenção/
    -- Supervisão/Encarregado/Admin) precisa confirmar que recebeu a peça
    -- de verdade nas mãos (POST /manutencao/confirmar-recebimento-peca).
    -- Mesmo princípio de "aceito"/"pedido_peca_aceito": só a rota
    -- dedicada (confirmarRecebimentoPecaManutencaoCorretiva) muda isso;
    -- o upsert geral sempre preserva o valor já salvo. Reseta pra 'Nao'
    -- junto com pedido_peca_aceito sempre que "aguardando_pecas" deixar
    -- de ser 'Sim' (mesmo raciocínio: um NOVO pedido de peça, no futuro,
    -- não deveria nascer já "confirmado" por causa de um pedido antigo).
    recebimento_peca_confirmado      TEXT NOT NULL DEFAULT 'Nao',
    recebimento_peca_confirmado_por  TEXT,
    recebimento_peca_confirmado_em   TEXT,
    -- Fluxo de RECUSA do chamado (ver conversa que motivou isso): a
    -- Manutenção (ou Admin/Supervisão/Encarregado — mesmo grupo que pode
    -- aceitar) pode, em vez de aceitar, recusar o chamado com um motivo
    -- (recusa_pendente='Sim' + recusa_motivo). Aí vira uma pendência pra
    -- Admin/Supervisão/Encarregado revisarem: se ACEITAM a recusa, o
    -- chamado é encerrado (etiqueta_fechada=1, situacao='Recusado'); se
    -- NEGAM a recusa, ela é descartada (recusa_pendente volta pra 'Nao')
    -- e o chamado volta pro estado normal (ainda não aceito), esperando
    -- a Manutenção aceitar e dar prosseguimento de verdade.
    -- recusa_resultado guarda o resultado da ÚLTIMA revisão (NULL
    -- enquanto pendente ou se nunca houve recusa; 'Aceita'/'Negada'
    -- depois de revisada) — só histórico/auditoria, não controla nada
    -- sozinho (quem controla é recusa_pendente + etiqueta_fechada).
    recusa_pendente           TEXT NOT NULL DEFAULT 'Nao',
    recusa_motivo             TEXT,
    recusa_solicitado_por     TEXT,
    recusa_solicitado_em      TEXT,
    recusa_resultado          TEXT,
    recusa_revisado_por       TEXT,
    recusa_revisado_em        TEXT,
    -- Trajetória visual do chamado (ver conversa que motivou isso):
    -- "visualizado_por"/"visualizado_em" registram a 1ª vez que alguém
    -- abriu o chamado pra ver o relatório (ver abrirHistorico(),
    -- manutencao.js) — vira um ponto na linha do tempo visual. Guarda o
    -- NOME de quem viu, exceto se for Admin (master ou perfil
    -- Administrativo), caso em que grava só "Administrador" genérico —
    -- pedido do usuário, pra não expor qual admin especificamente.
    -- Só a 1ª visualização é registrada (idempotente, ver
    -- marcarVisualizadoManutencaoCorretiva).
    visualizado_por           TEXT,
    visualizado_em            TEXT,
    -- Nome de quem registrou/alterou (ver LW.nomeDeQuemEstaLogado(),
    -- data.js) — mesmo raciocínio de operacoes.operador_nome: puramente
    -- informativo, nunca controle de acesso.
    autor_nome        TEXT,
    data_criacao      TEXT NOT NULL DEFAULT (datetime('now')),
    data_modificacao  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_manutencao_corretiva_data ON manutencao_corretiva(data);
  CREATE INDEX IF NOT EXISTS idx_manutencao_corretiva_situacao ON manutencao_corretiva(situacao);

  -- Manutenção programada (agendamentos) — 1 linha por ocorrência (uma
  -- recorrência gera várias linhas, uma por data — mesmo comportamento
  -- do protótipo original, ver gerarOcorrenciasRecorrentes()).
  --
  -- execucao é um objeto JSON opcional (só existe depois que alguém
  -- preenche o formulário de execução, ver salvarExecucao()) — não vale
  -- a pena normalizar numa tabela própria: é sempre 1-pra-1 com o
  -- agendamento, nunca consultado separadamente, e tem uma estrutura
  -- própria fixa (dataInicio/horaInicio/dataFim/horaFim/tempoGasto/
  -- executado/motivoNaoExecutado/tecnicoResponsavel/observacoes/
  -- tipoExecucao/empresaExterna).
  --
  -- execucao_data_inicio/execucao_hora_inicio são DIFERENTES do que tem
  -- dentro de "execucao" (JSON) — mesma duplicação/inconsistência que já
  -- existia no protótipo original (Fase 1), mantida de propósito
  -- (replicar o comportamento exato, não redesenhar a lógica de
  -- negócio): confirmarInicio() (status "Pendente" -> "Em Execucao")
  -- grava só esses 2 campos soltos; só depois, ao FINALIZAR
  -- (salvarExecucao(), status "Em Execucao" -> "Concluido"/"Nao
  -- Executado"), o objeto "execucao" completo é preenchido (incluindo um
  -- "dataInicio"/"horaInicio" própria dele, que pode ou não bater com os
  -- 2 campos soltos, dependendo do que a pessoa digitou no formulário de
  -- finalização).
  CREATE TABLE IF NOT EXISTS manutencao_programada (
    id                    TEXT PRIMARY KEY,
    data                  TEXT NOT NULL,
    hora                  TEXT,
    turno                 TEXT,
    setor                 TEXT NOT NULL,
    maquina               TEXT NOT NULL,
    tipo                  TEXT,
    solicitante           TEXT NOT NULL,
    observacoes           TEXT,
    status                TEXT NOT NULL DEFAULT 'Pendente',
    justificativa         TEXT,
    -- Preenchidos só depois de Aprovado (ver confirmarAprovacao()).
    data_inicio_estimado  TEXT,
    hora_inicio_estimado  TEXT,
    data_fim_estimado     TEXT,
    hora_fim_estimado     TEXT,
    -- Preenchidos só depois de "Em Execução" (ver confirmarInicio()) —
    -- ver comentário acima sobre a duplicação com o JSON "execucao".
    execucao_data_inicio  TEXT,
    execucao_hora_inicio  TEXT,
    -- JSON opcional — ver comentário acima da tabela.
    execucao              TEXT,
    autor_nome            TEXT,
    data_criacao          TEXT NOT NULL DEFAULT (datetime('now')),
    -- Marca se o LEMBRETE do dia (às 09h da data agendada, ver
    -- executarLembreteManutencaoProgramadaSeNecessario,
    -- lib/notificacoes-push.js) já foi disparado pra este agendamento —
    -- evita reenviar a cada checagem do setInterval (roda a cada minuto).
    -- Um novo registro sempre nasce com o default 0. Reseta sozinho pra
    -- 0 se a "data" do agendamento mudar (ver CASE em
    -- SQL_UPSERT_MANUTENCAO_PROGRAMADA, abaixo) — reagendar pra outro
    -- dia e voltar pro mesmo dia de novo volta a ser elegível.
    lembrete_dia_enviado  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_manutencao_programada_data ON manutencao_programada(data);
  CREATE INDEX IF NOT EXISTS idx_manutencao_programada_status ON manutencao_programada(status);

  -- Almoxarifado / Estoque de peças (manutencao_estoque,
  -- manutencao_movimentacoes) foi removido do produto — recurso não fazia
  -- sentido para o projeto (decisão de negócio). DROP explícito (não só
  -- deixar de criar) porque instalações que já tinham rodado uma versão
  -- anterior podem ter essas tabelas no arquivo .db local; não havia
  -- dados reais em produção no momento da remoção.
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
// execucao_data_inicio/execucao_hora_inicio — ver comentário na
// CREATE TABLE manutencao_programada (acima) sobre a duplicação com o
// JSON "execucao". Adicionadas depois da primeira versão da tabela
// (criada só com a coluna "execucao"), daí a migração.
const _colunasManutencaoProgramada = db.prepare("PRAGMA table_info(manutencao_programada)").all().map(c => c.name);
if (!_colunasManutencaoProgramada.includes('execucao_data_inicio')) {
  db.exec('ALTER TABLE manutencao_programada ADD COLUMN execucao_data_inicio TEXT');
  db.exec('ALTER TABLE manutencao_programada ADD COLUMN execucao_hora_inicio TEXT');
  console.log('[migração] Colunas "execucao_data_inicio"/"execucao_hora_inicio" adicionadas à tabela manutencao_programada.');
}
// lembrete_dia_enviado — ver comentário na CREATE TABLE manutencao_programada
// (acima). Adicionada depois da primeira versão da tabela, daí a migração.
if (!_colunasManutencaoProgramada.includes('lembrete_dia_enviado')) {
  db.exec('ALTER TABLE manutencao_programada ADD COLUMN lembrete_dia_enviado INTEGER NOT NULL DEFAULT 0');
  console.log('[migração] Coluna "lembrete_dia_enviado" adicionada à tabela manutencao_programada.');
}
// Fluxo de aceite de chamado / aceite de pedido de peça (ver comentário
// na CREATE TABLE manutencao_corretiva, acima) — adicionadas depois da
// primeira versão da tabela, daí a migração leve, mesmo padrão das
// demais acima.
const _colunasManutencaoCorretiva = db.prepare("PRAGMA table_info(manutencao_corretiva)").all().map(c => c.name);
if (!_colunasManutencaoCorretiva.includes('aceito')) {
  db.exec("ALTER TABLE manutencao_corretiva ADD COLUMN aceito TEXT NOT NULL DEFAULT 'Nao'");
  db.exec('ALTER TABLE manutencao_corretiva ADD COLUMN aceito_por TEXT');
  db.exec('ALTER TABLE manutencao_corretiva ADD COLUMN aceito_em TEXT');
  db.exec("ALTER TABLE manutencao_corretiva ADD COLUMN pedido_peca_aceito TEXT NOT NULL DEFAULT 'Nao'");
  db.exec('ALTER TABLE manutencao_corretiva ADD COLUMN pedido_peca_aceito_por TEXT');
  db.exec('ALTER TABLE manutencao_corretiva ADD COLUMN pedido_peca_aceito_em TEXT');
  console.log('[migração] Colunas de aceite de chamado/pedido de peça adicionadas à tabela manutencao_corretiva.');
}
if (!_colunasManutencaoCorretiva.includes('recusa_pendente')) {
  db.exec("ALTER TABLE manutencao_corretiva ADD COLUMN recusa_pendente TEXT NOT NULL DEFAULT 'Nao'");
  db.exec('ALTER TABLE manutencao_corretiva ADD COLUMN recusa_motivo TEXT');
  db.exec('ALTER TABLE manutencao_corretiva ADD COLUMN recusa_solicitado_por TEXT');
  db.exec('ALTER TABLE manutencao_corretiva ADD COLUMN recusa_solicitado_em TEXT');
  db.exec('ALTER TABLE manutencao_corretiva ADD COLUMN recusa_resultado TEXT');
  db.exec('ALTER TABLE manutencao_corretiva ADD COLUMN recusa_revisado_por TEXT');
  db.exec('ALTER TABLE manutencao_corretiva ADD COLUMN recusa_revisado_em TEXT');
  console.log('[migração] Colunas do fluxo de recusa de chamado adicionadas à tabela manutencao_corretiva.');
}
if (!_colunasManutencaoCorretiva.includes('visualizado_por')) {
  db.exec('ALTER TABLE manutencao_corretiva ADD COLUMN visualizado_por TEXT');
  db.exec('ALTER TABLE manutencao_corretiva ADD COLUMN visualizado_em TEXT');
  console.log('[migração] Colunas de visualização (trajetória visual) adicionadas à tabela manutencao_corretiva.');
}
if (!_colunasManutencaoCorretiva.includes('recebimento_peca_confirmado')) {
  db.exec("ALTER TABLE manutencao_corretiva ADD COLUMN recebimento_peca_confirmado TEXT NOT NULL DEFAULT 'Nao'");
  db.exec('ALTER TABLE manutencao_corretiva ADD COLUMN recebimento_peca_confirmado_por TEXT');
  db.exec('ALTER TABLE manutencao_corretiva ADD COLUMN recebimento_peca_confirmado_em TEXT');
  console.log('[migração] Colunas de confirmação de recebimento de peça adicionadas à tabela manutencao_corretiva.');
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

// ════════════════════════════════════════════════════════════════════════
//  SETOR DE MANUTENÇÃO — Fase 2 (backend real)
// ════════════════════════════════════════════════════════════════════════

// ─── Manutenção Corretiva ──────────────────────────────────────────────
// Extraída para lib/db/manutencao-corretiva.js (Fase 3 do fatiamento de
// db.js — ver README, "Fatiamento de db.js (plano)"). Mesma lógica de
// sempre, só mudou onde o código mora: uma factory que recebe a conexão
// já aberta (mesmo padrão de lib/rotas/) e devolve as funções do domínio,
// penduradas aqui em module.exports (= db) pra ninguém mais precisar mudar.
const criarManutencaoCorretiva = require('./lib/db/manutencao-corretiva');
Object.assign(module.exports, criarManutencaoCorretiva(db));

// ─── Manutenção Programada (agendamentos) ──────────────────────────────
// Fase 2 do fatiamento de db.js (ver README) — extraído pra
// lib/db/manutencao-programada.js, sem mudar lógica nenhuma, só onde o
// código mora. O módulo recebe a conexão `db` já aberta (mesmo padrão de
// factory de lib/rotas/) e devolve as funções do domínio, que penduramos
// de volta aqui no objeto `db` (module.exports = db, acima) — todo
// consumidor existente (lib/rotas/manutencao.js, lib/rotas/backup.js,
// lib/notificacoes-push.js) continua chamando db.listarManutencaoProgramada()
// etc. sem precisar mudar nada.
Object.assign(module.exports, require('./lib/db/manutencao-programada.js')(db));

// module.exports.*Corretiva e module.exports.*Programada (listar/obter/
// salvar/aceitar/.../substituir de cada domínio): já vêm penduradas via
// Object.assign(module.exports, criarManutencaoCorretiva(db)) e
// Object.assign(module.exports, require('./lib/db/manutencao-programada.js')(db)),
// ambos acima (Fases 3 e 2 do fatiamento de db.js, ver README).

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
