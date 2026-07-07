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
    bercos_reais          INTEGER,
    -- Só não-nulo quando tipo_montagem = 'PERSONALIZADA' (ver Montagem
    -- Personalizada no README) — 1 array JSON, 1 item por berço. Não vale
    -- a pena normalizar isso numa tabela própria: não cresce com o tempo
    -- (tamanho fixo = capacidade da bateria) e nunca é consultado sozinho,
    -- só lido junto com a operação inteira.
    bercos_personalizados TEXT,
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
    registrado_em TEXT
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
    dados         TEXT NOT NULL  -- JSON: avaliação inteira, incluindo a lista de painéis
  );
  CREATE INDEX IF NOT EXISTS idx_avaliacoes_qualidade_operacao ON avaliacoes_qualidade(id_operacao);

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
//  Migração única: popula "operacoes_avaliadas" a partir da coluna
//  legada "operacoes.avaliado" — sem isso, toda operação que já tivesse
//  sido marcada avaliado=1 ANTES desta tabela existir voltaria a
//  aparecer na fila de "não avaliadas" (que passa a consultar só esta
//  tabela, nunca mais a coluna). INSERT OR IGNORE — idempotente, roda
//  toda subida do servidor sem duplicar nem sobrescrever o
//  "avaliado_em" de quem já foi migrado numa subida anterior.
// ------------------------------------------------------------
const _operacoesAvaliadoLegado = db.prepare(
  'SELECT id FROM operacoes WHERE avaliado = 1'
).all();
if (_operacoesAvaliadoLegado.length) {
  const _inserirLegado = db.prepare(
    'INSERT OR IGNORE INTO operacoes_avaliadas (id_operacao) VALUES (?)'
  );
  const _migrarLegado = db.transaction((linhas) => {
    for (const r of linhas) _inserirLegado.run(r.id);
  });
  _migrarLegado(_operacoesAvaliadoLegado);
  console.log(`[migração] ${_operacoesAvaliadoLegado.length} operação(ões) com "avaliado=1" (coluna legada) migrada(s) para "operacoes_avaliadas".`);
}

/**
 * Cria a linha inicial de bercos_visuais pra uma operação recém-
 * registrada — 1 linha pra bateria INTEIRA, com todos os berços
 * (B1..B<quantidade>) e seus 2 estados dentro da lista JSON da coluna
 * "bercos". Chamada por POST /registrar-operacao (server.js), logo
 * depois de inserir a operação em si.
 *
 * @param {string} idOperacao
 * @param {number} quantidade
 * @param {Object<string,{esquerda?:string,direita?:string}>} [estadosMarcados] -
 *   mapa esparso vindo do snapshot ao vivo de "Bateria Atual" (ver
 *   GET/POST /bercos-andamento, server.js) — lado ausente do mapa =
 *   'okay'. Se quem estava acompanhando a operação marcou algum lado de
 *   algum berço como 'baixou' ANTES do registro, esse estado entra aqui
 *   já na criação, em vez de nascer 'okay' e precisar de uma segunda
 *   chamada pra corrigir.
 *
 * INSERT OR IGNORE (via PRIMARY KEY id_operacao): se por algum motivo já
 * existir uma linha pra essa operação, não duplica nem sobrescreve
 * estados que porventura já tenham mudado — idempotente.
 */
const SQL_INSERIR_BERCOS_VISUAIS = `
  INSERT OR IGNORE INTO bercos_visuais (id_operacao, bercos, atualizado_em)
  VALUES (@id_operacao, @bercos, @atualizado_em)
`;
function criarBercosVisuaisIniciais(idOperacao, quantidade, estadosMarcados) {
  const mapa = (estadosMarcados && typeof estadosMarcados === 'object') ? estadosMarcados : {};
  const n = Math.max(0, parseInt(quantidade) || 0);
  const bercos = [];
  for (let i = 1; i <= n; i++) {
    const berco = 'B' + i;
    const marcadoBerco = mapa[berco] || {};
    bercos.push({
      berco, ordem: i,
      estado_esquerda: marcadoBerco.esquerda || 'okay',
      estado_direita: marcadoBerco.direita || 'okay',
    });
  }
  db.prepare(SQL_INSERIR_BERCOS_VISUAIS).run({
    id_operacao: idOperacao,
    bercos: JSON.stringify(bercos),
    atualizado_em: new Date().toISOString(),
  });
}

/**
 * Converte um registro no formato histórico (historico.json) pros
 * parâmetros nomeados do INSERT/UPDATE de "operacoes" — usado tanto pela
 * migração automática quanto pelas rotas /registrar-operacao e
 * /editar-operacao, pra nunca ter 2 versões da mesma conversão.
 */
function operacaoParaRow(r) {
  return {
    id: r.id,
    data: r.data,
    turno: r.turno ?? null,
    dimensao: r.dimensao ?? null,
    capacidade: r.capacidade ?? null,
    id_bateria: r.id_bateria ?? null,
    inicio: r.inicio ?? null,
    fim: r.fim ?? null,
    desemplaque: r.desemplaque ?? null,
    tempo_min: r.tempo_min ?? null,
    qtd_tracos: r.qtd_tracos ?? null,
    houve_atraso: r.houve_atraso ?? null,
    motivo_atraso: r.motivo_atraso ?? null,
    tipo_montagem: r.tipo_montagem ?? null,
    bercos_reais: r.bercos_reais ?? null,
    bercos_personalizados: r.bercos_personalizados ? JSON.stringify(r.bercos_personalizados) : null,
    total_paineis: r.total_paineis ?? null,
    m2_total: r.m2_total ?? null,
    placas_cimenticia: r.placas_cimenticia ?? null,
    paineis_por_tipo: r.paineis_por_tipo ? JSON.stringify(r.paineis_por_tipo) : null,
    m2_por_tipo: r.m2_por_tipo ? JSON.stringify(r.m2_por_tipo) : null,
    paineis_2p: r.paineis_2p ?? 0,
    paineis_sp: r.paineis_sp ?? 0,
    m2_2p: r.m2_2p ?? 0,
    m2_sp: r.m2_sp ?? 0,
    tracos_json: r.tracos ? JSON.stringify(r.tracos) : null,
    // !! só vira 1 quando explicitamente true (migração de registro já
    // avaliado, por ex.) — nunca por acidente de um campo truthy qualquer
    // vindo do JSON antigo.
    avaliado: r.avaliado === true || r.avaliado === 1 ? 1 : 0,
  };
}

/** Caminho inverso: 1 linha da tabela "operacoes" -> objeto no formato historico.json. */
function rowParaOperacao(row) {
  return {
    id: row.id,
    data: row.data,
    turno: row.turno,
    dimensao: row.dimensao,
    capacidade: row.capacidade,
    id_bateria: row.id_bateria,
    inicio: row.inicio,
    fim: row.fim,
    desemplaque: row.desemplaque,
    tempo_min: row.tempo_min,
    qtd_tracos: row.qtd_tracos,
    houve_atraso: row.houve_atraso,
    motivo_atraso: row.motivo_atraso,
    tipo_montagem: row.tipo_montagem,
    bercos_reais: row.bercos_reais,
    ...(row.bercos_personalizados ? { bercos_personalizados: JSON.parse(row.bercos_personalizados) } : {}),
    total_paineis: row.total_paineis,
    m2_total: row.m2_total,
    placas_cimenticia: row.placas_cimenticia,
    paineis_por_tipo: row.paineis_por_tipo ? JSON.parse(row.paineis_por_tipo) : {},
    m2_por_tipo: row.m2_por_tipo ? JSON.parse(row.m2_por_tipo) : {},
    paineis_2p: row.paineis_2p,
    paineis_sp: row.paineis_sp,
    m2_2p: row.m2_2p,
    m2_sp: row.m2_sp,
    tracos: row.tracos_json ? JSON.parse(row.tracos_json) : [],
    avaliado: !!row.avaliado,
  };
}

const SQL_INSERIR_OPERACAO = `
  INSERT INTO operacoes (
    id, data, turno, dimensao, capacidade, id_bateria, inicio, fim, desemplaque,
    tempo_min, qtd_tracos, houve_atraso, motivo_atraso, tipo_montagem, bercos_reais,
    bercos_personalizados, total_paineis, m2_total, placas_cimenticia,
    paineis_por_tipo, m2_por_tipo, paineis_2p, paineis_sp, m2_2p, m2_sp,
    tracos_json, avaliado, modo_teste, criado_em
  ) VALUES (
    @id, @data, @turno, @dimensao, @capacidade, @id_bateria, @inicio, @fim, @desemplaque,
    @tempo_min, @qtd_tracos, @houve_atraso, @motivo_atraso, @tipo_montagem, @bercos_reais,
    @bercos_personalizados, @total_paineis, @m2_total, @placas_cimenticia,
    @paineis_por_tipo, @m2_por_tipo, @paineis_2p, @paineis_sp, @m2_2p, @m2_sp,
    @tracos_json, @avaliado, @modo_teste, @criado_em
  )
`;

/**
 * Lista todas as linhas de bercos_visuais (1 por operação), com "bercos"
 * já desserializado — usado pelo Backup de Dados (manual/automático), que
 * antes desta mudança não cobria esta tabela (berços visuais e avaliações
 * de qualidade ficavam de fora dos dois backups baseados em public/db/,
 * só entravam no Backup Geral por este zipar o .sqlite inteiro).
 */
function todosOsBercosVisuais() {
  const rows = db.prepare('SELECT id_operacao, bercos, atualizado_em FROM bercos_visuais ORDER BY id_operacao ASC').all();
  return rows.map(r => ({ id_operacao: r.id_operacao, bercos: JSON.parse(r.bercos), atualizado_em: r.atualizado_em }));
}

/**
 * Substitui TODO o conteúdo de bercos_visuais pelo array informado (mesmo
 * formato de todosOsBercosVisuais) — usado por /restaurar-backup-dados,
 * mesmo padrão "apaga tudo e reinsere dentro de 1 transação" já usado por
 * operações/paradas. Quem chama é responsável por envolver numa
 * db.transaction(), igual às outras rotas de restore.
 */
const SQL_INSERIR_BERCO_VISUAL_BACKUP = `
  INSERT INTO bercos_visuais (id_operacao, bercos, atualizado_em)
  VALUES (@id_operacao, @bercos, @atualizado_em)
`;
function substituirBercosVisuais(lista) {
  db.prepare('DELETE FROM bercos_visuais').run();
  const inserir = db.prepare(SQL_INSERIR_BERCO_VISUAL_BACKUP);
  for (const item of (lista || [])) {
    inserir.run({
      id_operacao: item.id_operacao,
      bercos: JSON.stringify(item.bercos || []),
      atualizado_em: item.atualizado_em || new Date().toISOString(),
    });
  }
}

module.exports = db;
module.exports.operacaoParaRow = operacaoParaRow;
module.exports.rowParaOperacao = rowParaOperacao;
module.exports.SQL_INSERIR_OPERACAO = SQL_INSERIR_OPERACAO;
/**
 * Relatório de Berços — 1 linha por operação, juntando bercos_visuais com
 * os dados da bateria (operacoes) que a tela precisa pra identificar cada
 * linha (ID da bateria, tipo de montagem) — usado pela página "Relatório
 * de Berços" (ver public/js/relatorio-bercos.js). Cada berço mantém seu
 * "ordem" (1-based); a página usa isso pra montar as colunas B1..B22,
 * deixando em branco os berços que aquela bateria específica não teve
 * (nem toda bateria usa as 22 posições).
 */
function relatorioBercos() {
  const rows = db.prepare(`
    SELECT o.id AS id_operacao, o.data, o.turno, o.id_bateria, o.tipo_montagem,
           o.capacidade, o.bercos_reais, o.houve_atraso, o.motivo_atraso,
           o.bercos_personalizados, bv.bercos
    FROM bercos_visuais bv
    JOIN operacoes o ON o.id = bv.id_operacao
    ORDER BY o.data ASC, o.turno ASC, o.criado_em ASC
  `).all();
  return rows.map(r => ({
    id_operacao: r.id_operacao,
    data: r.data,
    turno: r.turno,
    id_bateria: r.id_bateria,
    tipo_montagem: r.tipo_montagem,
    capacidade: r.capacidade,
    bercos_reais: r.bercos_reais,
    // Só preenchido quando tipo_montagem === 'PERSONALIZADA' (ver
    // coluna operacoes.bercos_personalizados) — usado pelo Modo Visual do
    // Relatório de Berços (relatorio-bercos.js) pra colorir CADA berço
    // pelo seu próprio tipo, em vez de um tipo único pra bateria inteira.
    bercos_personalizados: r.bercos_personalizados ? JSON.parse(r.bercos_personalizados) : null,
    // Adicionados pra cruzar com a tabela de Pontos de Atenção (Análise
    // de Berços): confirma se o vazamento marcado no berço bate com um
    // atraso já registrado com esse motivo (ver _mapaAtrasoVazamento, em
    // analise-bercos.js, e normalizarMotivo em analise-operacional.js —
    // mesmos termos de busca, "vazamento/vasamento/reinjeção").
    houve_atraso: r.houve_atraso,
    motivo_atraso: r.motivo_atraso,
    bercos: JSON.parse(r.bercos), // [{berco, ordem, estado_esquerda, estado_direita}, ...]
  }));
}

module.exports.criarBercosVisuaisIniciais = criarBercosVisuaisIniciais;
module.exports.todosOsBercosVisuais = todosOsBercosVisuais;
module.exports.substituirBercosVisuais = substituirBercosVisuais;
/**
 * Correlação Traço × Berço — para cada USO de traço com berço_inicio/fim
 * preenchidos (ver traco_usos: berco_inicio/berco_finalizacao — o range
 * de berços que aquele traço específico encheu), calcula a taxa de
 * vazamento (bercos_visuais) SÓ dos berços daquele range, e junta com o
 * nº de ajustes de receita daquele traço (indicador de instabilidade) e
 * a densidade/flow FINAIS dele (mesma regra de "original + última
 * remedição" usada em rowParaTraco/todosOsTracos — ver acima). Usado
 * pelo gráfico de dispersão e pela tabela "Traço × Berço" (piores casos
 * + receita, pra comparar com os traços sem vazamento) na Análise de
 * Berços (ver public/js/analise-bercos.js).
 *
 * Cada linha devolvida é 1 USO (traço + operação específicos), não 1
 * traço só — o mesmo traço pode ser reaproveitado em baterias diferentes
 * (ver traco_usos), e cada reaproveitamento encheu berços diferentes,
 * com resultado de vazamento diferente. INNER JOIN com operacoes e
 * bercos_visuais already exclui usos de traços importados em lote (id_
 * operacao sintético, sem operação/berços visuais reais por trás — ver
 * comentário em CREATE TABLE traco_usos, acima).
 */
function correlacaoTracoBerco() {
  const rows = db.prepare(`
    SELECT tu.id_traco, tu.id_operacao, tu.berco_inicio, tu.berco_finalizacao,
           o.data, o.turno, o.id_bateria, o.tipo_montagem, bv.bercos,
           t.densidade_original, t.flow_original,
           (SELECT COUNT(*) FROM ajustes a WHERE a.id_traco = tu.id_traco) AS num_ajustes,
           (SELECT valor FROM leituras_resultado lr WHERE lr.id_traco = tu.id_traco
              AND lr.campo = 'densidade' ORDER BY lr.ordem DESC LIMIT 1) AS densidade_remedida,
           (SELECT valor FROM leituras_resultado lr WHERE lr.id_traco = tu.id_traco
              AND lr.campo = 'flow' ORDER BY lr.ordem DESC LIMIT 1) AS flow_remedido
    FROM traco_usos tu
    JOIN operacoes o ON o.id = tu.id_operacao
    JOIN bercos_visuais bv ON bv.id_operacao = tu.id_operacao
    JOIN tracos t ON t.id_traco = tu.id_traco
    WHERE tu.berco_inicio IS NOT NULL AND tu.berco_inicio != ''
      AND tu.berco_finalizacao IS NOT NULL AND tu.berco_finalizacao != ''
    ORDER BY o.data ASC
  `).all();

  return rows.map(r => {
    // Math.min/max: cobre o caso raro de alguém digitar início > fim.
    const ini = Math.min(parseInt(r.berco_inicio, 10), parseInt(r.berco_finalizacao, 10));
    const fim = Math.max(parseInt(r.berco_inicio, 10), parseInt(r.berco_finalizacao, 10));
    const todos = JSON.parse(r.bercos);
    // ini/fim viram NaN se berco_inicio/fim não for numérico (digitação
    // inválida) — b.ordem >= NaN é sempre false, então "doTraco" fica
    // vazio e a linha é descartada no .filter() abaixo, sem lançar erro.
    const doTraco = todos.filter(b => b.ordem >= ini && b.ordem <= fim);
    let total = 0, vazamentos = 0;
    doTraco.forEach(b => {
      total += 2; // 2 lados por berço (esquerda + direita)
      if (b.estado_esquerda === 'baixou') vazamentos++;
      if (b.estado_direita === 'baixou') vazamentos++;
    });
    return {
      id_traco: r.id_traco, id_operacao: r.id_operacao,
      data: r.data, turno: r.turno, id_bateria: r.id_bateria, tipo_montagem: r.tipo_montagem,
      berco_inicio: ini, berco_finalizacao: fim,
      num_ajustes: r.num_ajustes,
      // Final = última remedição (leituras_resultado), se houve alguma;
      // senão o valor original do traço. Mesma regra de "original +
      // ajustes/leituras" usada no resto do sistema (ver rowParaTraco).
      densidade: r.densidade_remedida ?? r.densidade_original ?? null,
      flow: r.flow_remedido ?? r.flow_original ?? null,
      bercos_avaliados: doTraco.length,
      total_lados: total, vazamentos,
      taxa_vazamento: total ? (vazamentos / total) * 100 : null,
    };
  }).filter(r => r.bercos_avaliados > 0);
}

module.exports.relatorioBercos = relatorioBercos;
module.exports.correlacaoTracoBerco = correlacaoTracoBerco;

/**
 * Detalhe completo de UMA operação — junta tudo que se liga por
 * id_operacao (o elo comum entre histórico, relatório de injeção e
 * berços visuais): a operação em si, os berços visuais (se já tiverem
 * sido registrados), a receita de cada traço usado (com os ajustes que
 * teve, se algum) e a avaliação de qualidade vinculada (se já tiver
 * sido feita). Usado pela "Análise Focada" (ver public/js/
 * analise-focada.js), acessada clicando numa linha do Registro de
 * Baterias com o modo de foco ligado.
 *
 * Devolve null se a operação não existir.
 */
function detalheOperacao(idOperacao) {
  const operacao = db.prepare('SELECT * FROM operacoes WHERE id = ?').get(idOperacao);
  if (!operacao) return null;

  const bvRow = db.prepare('SELECT bercos FROM bercos_visuais WHERE id_operacao = ?').get(idOperacao);
  const bercosVisuais = bvRow ? JSON.parse(bvRow.bercos) : null;

  // Traços usados nesta operação, cada um com a receita ORIGINAL, os
  // ajustes (se algum) e a densidade/flow FINAIS (última remedição, ou
  // o original se nunca foi remedido — mesma regra usada em
  // rowParaTraco/correlacaoTracoBerco). Ordenado pelo berço inicial —
  // mesma ordem em que os traços foram usados na bateria.
  const usos = db.prepare(`
    SELECT tu.id_traco, tu.berco_inicio, tu.berco_finalizacao, tu.obs,
           t.num_traco, t.cimento_original, t.agua_original, t.eps_original,
           t.superplast_original, t.incorporador_original, t.tempo_batida_original,
           t.densidade_original, t.flow_original, t.silo, t.expansao, t.densidade_eps
    FROM traco_usos tu
    JOIN tracos t ON t.id_traco = tu.id_traco
    WHERE tu.id_operacao = ?
  `).all(idOperacao).sort((a, b) => parseInt(a.berco_inicio, 10) - parseInt(b.berco_inicio, 10));

  const tracos = usos.map(u => {
    const ajustes = db.prepare(
      'SELECT ordem, tempo_batida, cimento, agua, eps, superplast, incorporador, registrado_em FROM ajustes WHERE id_traco = ? ORDER BY ordem ASC'
    ).all(u.id_traco);
    const densidadeRemedida = db.prepare(
      "SELECT valor FROM leituras_resultado WHERE id_traco=? AND campo='densidade' ORDER BY ordem DESC LIMIT 1"
    ).get(u.id_traco);
    const flowRemedido = db.prepare(
      "SELECT valor FROM leituras_resultado WHERE id_traco=? AND campo='flow' ORDER BY ordem DESC LIMIT 1"
    ).get(u.id_traco);
    return {
      id_traco: u.id_traco,
      num_traco: u.num_traco,
      berco_inicio: u.berco_inicio,
      berco_finalizacao: u.berco_finalizacao,
      obs: u.obs,
      original: {
        cimento: u.cimento_original, agua: u.agua_original, eps: u.eps_original,
        superplast: u.superplast_original, incorporador: u.incorporador_original,
        tempo_batida: u.tempo_batida_original,
      },
      densidade: densidadeRemedida ? densidadeRemedida.valor : u.densidade_original,
      flow: flowRemedido ? flowRemedido.valor : u.flow_original,
      silo: u.silo, expansao: u.expansao, densidade_eps: u.densidade_eps,
      ajustes,
      num_ajustes: ajustes.length,
    };
  });

  // Avaliação de qualidade vinculada — se uma bateria (raro, mas
  // possível) tiver mais de uma avaliação registrada pra mesma operação,
  // pega a mais recente. "dados" já traz os painéis embutidos.
  const avRow = db.prepare(
    'SELECT dados FROM avaliacoes_qualidade WHERE id_operacao = ? ORDER BY registrado_em DESC LIMIT 1'
  ).get(idOperacao);
  const avaliacao = avRow ? JSON.parse(avRow.dados) : null;

  return { operacao, bercosVisuais, tracos, avaliacao };
}
module.exports.detalheOperacao = detalheOperacao;

/**
 * Grava uma avaliação de qualidade JÁ REGISTRADA (definitiva, não
 * rascunho) — 1 linha, com a avaliação inteira (painéis inclusos) em
 * JSON na coluna "dados". Chamada por POST /registrar-avaliacao-qualidade
 * (server.js). INSERT OR REPLACE: se o id já existir (reenvio depois de
 * uma falha de rede, por exemplo), sobrescreve em vez de duplicar ou
 * rejeitar — idempotente, mesmo espírito das outras rotas de baixa
 * fricção do sistema.
 *
 * Grava TAMBÉM em avaliacao_paineis, na mesma transação — mesmos dados,
 * só que extraídos numa tabela própria pra dar pra consultar em SQL
 * direto (ver comentário na CREATE TABLE, acima). "dados" continua
 * sendo a fonte de verdade (é o que o front lê de volta); avaliacao_
 * paineis é só uma cópia derivada, pra consulta — se um dia os dois
 * ficarem inconsistentes por qualquer motivo, dados é quem manda.
 * @param {object} avaliacao - objeto inteiro vindo do front (evalObj + paineis)
 */
const SQL_SALVAR_AVALIACAO_QUALIDADE = `
  INSERT OR REPLACE INTO avaliacoes_qualidade (id, id_operacao, id_bateria, turno, registrado_em, dados)
  VALUES (@id, @id_operacao, @id_bateria, @turno, @registrado_em, @dados)
`;
const SQL_SALVAR_PAINEIS_AVALIACAO = `
  INSERT OR REPLACE INTO avaliacao_paineis (id_avaliacao, id_operacao, id_bateria, registrado_em, paineis)
  VALUES (@id_avaliacao, @id_operacao, @id_bateria, @registrado_em, @paineis)
`;
// Deixa cada painel só com os campos que interessam pra consulta — evita
// carregar "avaliacaoId" repetido em cada item (já é a chave da linha
// toda, ver id_avaliacao) e qualquer campo extra que apareça no futuro
// sem que aqui saiba o que fazer com ele.
function _normalizarPaineisParaSql(paineis) {
  return (paineis || []).map(p => ({
    pallet: p.pallet, posicao: p.posicao,
    tipoEsperado: p.tipoEsperado || null, tipoObtido: p.tipoObtido || null,
    resultado: p.resultado || null, linha: p.linha || null,
    marcas: p.marcas || [],
  }));
}
function salvarAvaliacaoQualidade(avaliacao) {
  const params = {
    id: avaliacao.id,
    id_operacao: avaliacao.linkedOperacaoId || null,
    id_bateria: avaliacao.batteryId || null,
    turno: avaliacao.turno || null,
    registrado_em: avaliacao.registeredAt || new Date().toISOString(),
    dados: JSON.stringify(avaliacao),
  };
  const gravarTudo = db.transaction(() => {
    db.prepare(SQL_SALVAR_AVALIACAO_QUALIDADE).run(params);
    db.prepare(SQL_SALVAR_PAINEIS_AVALIACAO).run({
      id_avaliacao: params.id,
      id_operacao: params.id_operacao,
      id_bateria: params.id_bateria,
      registrado_em: params.registrado_em,
      paineis: JSON.stringify(_normalizarPaineisParaSql(avaliacao.paineis)),
    });
  });
  gravarTudo();
}

/**
 * Lista os painéis já normalizados (avaliacao_paineis), 1 item por
 * avaliação — usado por futuras telas de análise/cruzamento (mesmo
 * padrão de relatorioBercos()/correlacaoTracoBerco()), sem precisar
 * carregar avaliacoes_qualidade.dados inteiro (que tem também
 * observações, datas de montagem/enchimento/desmoldagem etc. — dados
 * que quem só quer os painéis não precisa processar).
 */
function listarPaineisAvaliacao() {
  const rows = db.prepare(
    'SELECT id_avaliacao, id_operacao, id_bateria, registrado_em, paineis FROM avaliacao_paineis ORDER BY registrado_em DESC'
  ).all();
  return rows.map(r => ({
    id_avaliacao: r.id_avaliacao,
    id_operacao: r.id_operacao,
    id_bateria: r.id_bateria,
    registrado_em: r.registrado_em,
    paineis: JSON.parse(r.paineis),
  }));
}

/**
 * Migração única: preenche avaliacao_paineis a partir de avaliações que
 * já estavam em avaliacoes_qualidade ANTES desta tabela existir — sem
 * isso, só avaliações registradas DAQUI PRA FRENTE apareceriam nela; as
 * já registradas ficariam de fora até alguém reabrir/regravar cada uma
 * manualmente. Roda 1 vez (INSERT OR IGNORE — não sobrescreve linhas que
 * já existirem, então rodar de novo em outra subida do servidor não faz
 * nada além de reconferir).
 */
function _migrarPaineisAvaliacaoExistentes() {
  const jaExistem = new Set(
    db.prepare('SELECT id_avaliacao FROM avaliacao_paineis').all().map(r => r.id_avaliacao)
  );
  const pendentes = db.prepare('SELECT id, id_operacao, id_bateria, registrado_em, dados FROM avaliacoes_qualidade').all()
    .filter(r => !jaExistem.has(r.id));
  if (!pendentes.length) return;

  const migrarTudo = db.transaction((linhas) => {
    const inserir = db.prepare(SQL_SALVAR_PAINEIS_AVALIACAO);
    for (const r of linhas) {
      let avaliacao;
      try { avaliacao = JSON.parse(r.dados); } catch (e) { continue; } // linha corrompida — pula, não trava a migração inteira
      inserir.run({
        id_avaliacao: r.id,
        id_operacao: r.id_operacao,
        id_bateria: r.id_bateria,
        registrado_em: r.registrado_em,
        paineis: JSON.stringify(_normalizarPaineisParaSql(avaliacao.paineis)),
      });
    }
  });
  migrarTudo(pendentes);
  console.log(`[avaliacao_paineis] Migração: ${pendentes.length} avaliação(ões) já registrada(s) antes desta tabela existir foram preenchidas agora.`);
}
_migrarPaineisAvaliacaoExistentes();

/**
 * Lista todas as avaliações de qualidade já registradas, mais recentes
 * primeiro — cada item já vem desserializado (JSON.parse de "dados"),
 * pronto pro front usar direto, painéis inclusos. Usado por GET
 * /avaliacoes-qualidade (Dashboard e Registros do Setor de Qualidade).
 */
function listarAvaliacoesQualidade() {
  const rows = db.prepare(
    'SELECT dados FROM avaliacoes_qualidade ORDER BY registrado_em DESC'
  ).all();
  return rows.map(r => JSON.parse(r.dados));
}
/**
 * Substitui TODO o conteúdo de avaliacoes_qualidade pelo array informado
 * (mesmo formato de listarAvaliacoesQualidade — cada item é a avaliação
 * inteira, painéis inclusos) — usado por /restaurar-backup-dados, mesmo
 * padrão "apaga tudo e reinsere" das outras tabelas. Quem chama é
 * responsável por envolver numa db.transaction().
 */
function substituirAvaliacoesQualidade(lista) {
  db.prepare('DELETE FROM avaliacoes_qualidade').run();
  // avaliacao_paineis não é apagada em cascata automaticamente (SQLite
  // só reforça FK se PRAGMA foreign_keys estiver ligado, e mesmo assim
  // isso é REFERENCES, não "ON DELETE CASCADE") — sem esta linha, uma
  // restauração com MENOS avaliações do que existia antes deixaria
  // painéis órfãos de avaliações que não voltaram no backup.
  db.prepare('DELETE FROM avaliacao_paineis').run();
  for (const avaliacao of (lista || [])) {
    salvarAvaliacaoQualidade(avaliacao); // já grava nas 2 tabelas, ver acima
  }
}

/**
 * Marca uma operação como avaliada — INSERT (idempotente) em
 * "operacoes_avaliadas", nunca mais um UPDATE na própria linha de
 * "operacoes" (ver comentário na CREATE TABLE, acima). Usada por
 * POST /marcar-operacao-avaliada (server.js) quando a avaliação vem
 * vinculada a uma operação da fila (linkedOperacaoId presente).
 *
 * FK (operacoes_avaliadas.id_operacao REFERENCES operacoes(id), com
 * PRAGMA foreign_keys=ON) faz o SQLite recusar silenciosamente um id que
 * não exista em "operacoes" — por isso quem chama (a rota) confere a
 * existência ANTES de chamar esta função, se precisar de um erro
 * explícito pro front (ver server.js).
 *
 * @param {string} idOperacao
 * @returns {boolean} true se inseriu (1ª vez); false se já estava
 *   marcada (chamada repetida, idempotente) ou se o id não existe.
 */
function marcarOperacaoAvaliada(idOperacao) {
  if (!idOperacao) return false;
  const info = db.prepare(
    'INSERT OR IGNORE INTO operacoes_avaliadas (id_operacao) VALUES (?)'
  ).run(idOperacao);
  return info.changes > 0;
}

/**
 * Marca como avaliada a operação PENDENTE mais antiga de uma bateria —
 * usada quando uma avaliação de qualidade é registrada SEM vir vinculada
 * a uma operação da fila (linkedOperacaoId ausente, ver
 * /registrar-avaliacao-qualidade, server.js).
 *
 * Por quê isso existe: uma avaliação AVULSA (o operador digita/seleciona
 * só o ID da bateria, sem escolher da fila) não tinha como marcar
 * nenhuma operação como avaliada — a operação real daquela bateria, se
 * houvesse alguma pendente, ficava "não avaliada" pra sempre, mesmo já
 * avaliada de verdade. Isso classificava a bateria errado (continuava
 * aparecendo na fila do Setor de Qualidade, sujeita a ser avaliada de
 * novo) e podia gerar avaliação duplicada pra mesma operação.
 *
 * Mesmo critério FIFO de GET /operacoes-nao-avaliadas (mais antiga
 * primeiro: "data ASC, fim ASC") — se a bateria tiver mais de uma
 * operação pendente, marca só a mais antiga (a que, na prática, é a
 * próxima da fila) e nunca mexe numa avaliação que já veio vinculada
 * (essa continua só pelo marcarOperacaoAvaliada explícito, acima,
 * chamado pelo front com o id_operacao exato).
 *
 * Nunca considera operações de Modo de Teste (modo_teste=0) — mesmo
 * motivo de /operacoes-nao-avaliadas: o Setor de Qualidade não tem
 * noção de Modo de Teste.
 *
 * @param {string} idBateria
 * @returns {boolean} true se alguma operação foi marcada (havia pendente)
 */
function marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada(idBateria) {
  if (!idBateria) return false;
  const pendente = db.prepare(`
    SELECT id FROM operacoes
    WHERE id_bateria = ? AND modo_teste = 0
      AND id NOT IN (SELECT id_operacao FROM operacoes_avaliadas)
    ORDER BY data ASC, fim ASC
    LIMIT 1
  `).get(idBateria);
  if (!pendente) return false;
  return marcarOperacaoAvaliada(pendente.id);
}

/**
 * Lista todo o conteúdo de "operacoes_avaliadas" — usado por GET
 * /db/operacoes_avaliadas.json (Backup de Dados) e pelo backup automático
 * do servidor (gerarZipDadosServidor, server.js). Formato simples:
 * [{ id_operacao, avaliado_em }, ...].
 */
function todosOsOperacoesAvaliadas() {
  return db.prepare('SELECT id_operacao, avaliado_em FROM operacoes_avaliadas ORDER BY avaliado_em ASC').all();
}

/**
 * Substitui TODO o conteúdo de "operacoes_avaliadas" pelo array informado
 * — usado por /restaurar-backup-dados, mesmo padrão "apaga tudo e
 * reinsere" das outras tabelas (ver substituirBercosVisuais/
 * substituirAvaliacoesQualidade). Quem chama é responsável por já ter
 * limpado esta tabela ANTES de mexer em "operacoes" (ver comentário em
 * /restaurar-backup-dados, server.js, sobre a ordem por causa da FK) —
 * aqui só limpa de novo (idempotente, não custa nada) e reinsere.
 */
function substituirOperacoesAvaliadas(lista) {
  const inserir = db.prepare('INSERT OR IGNORE INTO operacoes_avaliadas (id_operacao, avaliado_em) VALUES (?, ?)');
  db.prepare('DELETE FROM operacoes_avaliadas').run();
  for (const item of (lista || [])) {
    if (item && item.id_operacao) inserir.run(item.id_operacao, item.avaliado_em || new Date().toISOString());
  }
}

module.exports.salvarAvaliacaoQualidade = salvarAvaliacaoQualidade;
module.exports.listarAvaliacoesQualidade = listarAvaliacoesQualidade;
module.exports.listarPaineisAvaliacao = listarPaineisAvaliacao;
module.exports.substituirAvaliacoesQualidade = substituirAvaliacoesQualidade;
module.exports.marcarOperacaoAvaliada = marcarOperacaoAvaliada;
module.exports.marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada = marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada;
module.exports.todosOsOperacoesAvaliadas = todosOsOperacoesAvaliadas;
module.exports.substituirOperacoesAvaliadas = substituirOperacoesAvaliadas;

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
    try { fs.renameSync(historicoPath, historicoPath + '.migrado-' + Date.now()); } catch (_) {}
    return;
  }

  const inserirOperacao = db.prepare(SQL_INSERIR_OPERACAO);

  const migrarTudo = db.transaction((registros) => {
    for (const r of registros) {
      inserirOperacao.run({
        ...operacaoParaRow(r),
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

/** Converte uma parada no formato paradas.json pros parâmetros nomeados do INSERT/UPDATE. */
function paradaParaRow(p) {
  return {
    id: p.id,
    inicio: p.inicio,
    fim: p.fim,
    duracao_min: p.duracao_min ?? null,
    motivo: p.motivo ?? null,
    equipamento: p.equipamento ?? null,
    classificacao: p.classificacao ?? null,
    obs: p.obs ?? null,
    registrado_em: p.registrado_em ?? null,
  };
}

/** Caminho inverso: 1 linha da tabela "paradas" -> objeto no formato paradas.json. */
function rowParaParada(row) {
  return {
    id: row.id,
    inicio: row.inicio,
    fim: row.fim,
    duracao_min: row.duracao_min,
    motivo: row.motivo,
    equipamento: row.equipamento,
    classificacao: row.classificacao,
    obs: row.obs,
    registrado_em: row.registrado_em,
  };
}

const SQL_INSERIR_PARADA = `
  INSERT INTO paradas (id, inicio, fim, duracao_min, motivo, equipamento, classificacao, obs, registrado_em)
  VALUES (@id, @inicio, @fim, @duracao_min, @motivo, @equipamento, @classificacao, @obs, @registrado_em)
`;

module.exports.paradaParaRow = paradaParaRow;
module.exports.rowParaParada = rowParaParada;
module.exports.SQL_INSERIR_PARADA = SQL_INSERIR_PARADA;

/**
 * Migração automática (Fase 3) — mesmo critério/padrão de
 * migrarHistoricoSeNecessario(): só faz algo se a tabela "paradas"
 * estiver vazia E paradas.json ainda existir com esse nome; renomeia
 * pra ".migrado-<timestamp>" depois (nunca apaga).
 */
function migrarParadasSeNecessario(dbDir) {
  const path = require('path');
  const fs = require('fs');

  const jaTemDados = db.prepare('SELECT COUNT(*) AS n FROM paradas').get().n > 0;
  if (jaTemDados) return;

  const paradasPath = path.join(dbDir, 'paradas.json');
  if (!fs.existsSync(paradasPath)) return;

  let paradas = [];
  try {
    const texto = fs.readFileSync(paradasPath, 'utf8').trim();
    paradas = texto ? JSON.parse(texto) : [];
  } catch (e) {
    console.error('[migração] Não consegui ler paradas.json — abortando migração:', e.message);
    return;
  }
  if (!Array.isArray(paradas) || !paradas.length) {
    try { fs.renameSync(paradasPath, paradasPath + '.migrado-' + Date.now()); } catch (_) {}
    return;
  }

  const inserirParada = db.prepare(SQL_INSERIR_PARADA);
  const migrarTudo = db.transaction((registros) => {
    for (const p of registros) inserirParada.run(paradaParaRow(p));
  });
  migrarTudo(paradas);
  console.log(`[migração] ${paradas.length} parada(s) migrada(s) de paradas.json pra SQLite.`);

  try {
    fs.renameSync(paradasPath, paradasPath + '.migrado-' + Date.now());
  } catch (e) {
    console.error('[migração] Migrei os dados, mas não consegui renomear paradas.json:', e.message);
  }
}

module.exports.migrarParadasSeNecessario = migrarParadasSeNecessario;

// ============================================================
//  FASE 4 — sobra.json -> tabela sobra; contador_tracos.json -> tabela
//  contador_tracos (essa última já tinha schema desde a Fase 1)
// ============================================================

/** Converte o objeto sobra.json (camelCase) pros parâmetros nomeados do upsert. */
function sobraParaRow(s) {
  return {
    ativa: s.ativa ? 1 : 0,
    traco_id: s.tracoId ?? null,
    num_traco: s.numTraco ?? null,
    operacao_origem: s.operacaoOrigem ?? null,
    flow: (s.flow === '' || s.flow === undefined) ? null : s.flow,
    densidade: (s.densidade === '' || s.densidade === undefined) ? null : s.densidade,
    receita: s.receita ? JSON.stringify(s.receita) : null,
    data: s.data ?? null,
    status: s.status ?? null,
    data_encerramento: s.dataEncerramento ?? null,
  };
}

/** Caminho inverso: a linha da tabela "sobra" -> objeto no formato sobra.json (camelCase). */
function rowParaSobra(row) {
  if (!row) return {}; // nunca houve nenhuma sobra ainda — mesmo default de DEFAULT_SE_VAZIO_BACKUP_DADOS
  return {
    ativa: !!row.ativa,
    tracoId: row.traco_id,
    numTraco: row.num_traco,
    operacaoOrigem: row.operacao_origem,
    flow: row.flow,
    densidade: row.densidade,
    receita: row.receita ? JSON.parse(row.receita) : {},
    data: row.data,
    status: row.status,
    dataEncerramento: row.data_encerramento,
  };
}

const SQL_UPSERT_SOBRA = `
  INSERT INTO sobra (id, ativa, traco_id, num_traco, operacao_origem, flow, densidade, receita, data, status, data_encerramento)
  VALUES (1, @ativa, @traco_id, @num_traco, @operacao_origem, @flow, @densidade, @receita, @data, @status, @data_encerramento)
  ON CONFLICT(id) DO UPDATE SET
    ativa = @ativa, traco_id = @traco_id, num_traco = @num_traco, operacao_origem = @operacao_origem,
    flow = @flow, densidade = @densidade, receita = @receita, data = @data, status = @status,
    data_encerramento = @data_encerramento
`;

module.exports.sobraParaRow = sobraParaRow;
module.exports.rowParaSobra = rowParaSobra;
module.exports.SQL_UPSERT_SOBRA = SQL_UPSERT_SOBRA;

function migrarSobraSeNecessario(dbDir) {
  const path = require('path');
  const fs = require('fs');

  const jaTemDados = db.prepare('SELECT COUNT(*) AS n FROM sobra').get().n > 0;
  if (jaTemDados) return;

  const sobraPath = path.join(dbDir, 'sobra.json');
  if (!fs.existsSync(sobraPath)) return;

  let sobra = null;
  try {
    const texto = fs.readFileSync(sobraPath, 'utf8').trim();
    sobra = texto ? JSON.parse(texto) : null;
  } catch (e) {
    console.error('[migração] Não consegui ler sobra.json — abortando migração:', e.message);
    return;
  }
  if (!sobra || typeof sobra !== 'object' || !Object.keys(sobra).length) {
    try { fs.renameSync(sobraPath, sobraPath + '.migrado-' + Date.now()); } catch (_) {}
    return;
  }

  db.prepare(SQL_UPSERT_SOBRA).run(sobraParaRow(sobra));
  console.log('[migração] sobra migrada de sobra.json pra SQLite.');

  try {
    fs.renameSync(sobraPath, sobraPath + '.migrado-' + Date.now());
  } catch (e) {
    console.error('[migração] Migrei a sobra, mas não consegui renomear sobra.json:', e.message);
  }
}

module.exports.migrarSobraSeNecessario = migrarSobraSeNecessario;

/**
 * Migração automática do contador_tracos.json -> tabela contador_tracos.
 * Diferente das outras, a tabela aceita várias linhas (1 por dia) — mas o
 * arquivo de origem só guardava o dia mais recente, então é só 1 linha pra
 * importar mesmo (ver "Banco de Dados (SQLite)" no README).
 */
function migrarContadorTracosSeNecessario(dbDir) {
  const path = require('path');
  const fs = require('fs');

  const jaTemDados = db.prepare('SELECT COUNT(*) AS n FROM contador_tracos').get().n > 0;
  if (jaTemDados) return;

  const contadorPath = path.join(dbDir, 'contador_tracos.json');
  if (!fs.existsSync(contadorPath)) return;

  let contador = null;
  try {
    const texto = fs.readFileSync(contadorPath, 'utf8').trim();
    contador = texto ? JSON.parse(texto) : null;
  } catch (e) {
    console.error('[migração] Não consegui ler contador_tracos.json — abortando migração:', e.message);
    return;
  }
  if (!contador || !contador.data) {
    try { fs.renameSync(contadorPath, contadorPath + '.migrado-' + Date.now()); } catch (_) {}
    return;
  }

  db.prepare('INSERT INTO contador_tracos (data, total) VALUES (?, ?)').run(contador.data, contador.total || 0);
  console.log('[migração] contador de traços migrado de contador_tracos.json pra SQLite.');

  try {
    fs.renameSync(contadorPath, contadorPath + '.migrado-' + Date.now());
  } catch (e) {
    console.error('[migração] Migrei o contador, mas não consegui renomear contador_tracos.json:', e.message);
  }
}

module.exports.migrarContadorTracosSeNecessario = migrarContadorTracosSeNecessario;

// ============================================================
//  FASE 5 — relatorio_injecao.json + ajustes_tracos.json ->
//  tracos + traco_usos + ajustes + leituras_resultado
//
//  A mais complexa: ver "Banco de Dados (SQLite)" no README pra entender
//  a decisão de normalizar os ajustes (Opção B) e o que acontece com
//  dados legados sem uma entrada correspondente em ajustes_tracos.json
//  (collapse no original — ver colapsarOriginalEAjustes/decidirOriginal).
// ============================================================

/** Extrai o valor "original" de um campo que pode ser número simples OU {original, ajustes}. */
function extrairOriginal(v) {
  if (v && typeof v === 'object' && 'original' in v) {
    const o = v.original;
    return (o === '' || o === null || o === undefined) ? null : Number(o);
  }
  return (v === undefined || v === null || v === '') ? null : Number(v);
}

/** Extrai a lista de ajustes (deltas/leituras) de um campo, ou [] se for número simples. */
function extrairAjustesNumericos(v) {
  return (v && typeof v === 'object' && Array.isArray(v.ajustes)) ? v.ajustes.map(Number) : [];
}

/**
 * Caminho inverso de extrairOriginal/extrairAjustesNumericos — junta de
 * volta num número simples (sem ajustes) ou em {original, ajustes}. Mesma
 * lógica usada pela rota /editar-traco-relatorio (ver server.js).
 */
function colapsarOriginalEAjustes(original, listaAjustes) {
  const temOriginal = original !== '' && original !== null && original !== undefined;
  if (!listaAjustes || !listaAjustes.length) return temOriginal ? Number(original) : '';
  return { original: temOriginal ? Number(original) : '', ajustes: listaAjustes };
}

// Campos "soma" (insumo) — cada um tem uma coluna *_original em "tracos" e
// um nome de coluna correspondente em "ajustes". tempo_batida é tratado
// separado (unidade diferente: minutos em ajustes, segundos em tracos).
const CAMPOS_SOMA = [
  { campoJson: 'cimento_real', colunaOriginal: 'cimento_original', nomeAjuste: 'cimento' },
  { campoJson: 'agua_real', colunaOriginal: 'agua_original', nomeAjuste: 'agua' },
  { campoJson: 'eps_real', colunaOriginal: 'eps_original', nomeAjuste: 'eps' },
  { campoJson: 'superplast_real', colunaOriginal: 'superplast_original', nomeAjuste: 'superplast' },
  { campoJson: 'incorporador_real', colunaOriginal: 'incorporador_original', nomeAjuste: 'incorporador' },
];

function agruparPor(linhas, campo) {
  const mapa = new Map();
  linhas.forEach(l => {
    if (!mapa.has(l[campo])) mapa.set(l[campo], []);
    mapa.get(l[campo]).push(l);
  });
  return mapa;
}

/**
 * Reconstrói 1 traço no formato relatorio_injecao.json a partir da linha
 * de "tracos" + suas linhas relacionadas (ajustes, leituras, usos) — usado
 * tanto pela leitura única (GET /db/relatorio_injecao.json) quanto pela
 * edição (/editar-traco-relatorio).
 */
function rowParaTraco(row, ajustesRows = [], leiturasRows = [], usosRows = []) {
  const resultado = {
    id_traco: row.id_traco,
    ultilizado: {
      operacao: usosRows.map(u => ({
        id_operacao: u.id_operacao,
        id_bateria: u.id_bateria,
        berco_inicio: u.berco_inicio,
        berco_finalizacao: u.berco_finalizacao,
        obs: u.obs,
      })),
    },
    data: row.data,
    turno: row.turno,
    num_traco: row.num_traco,
  };

  CAMPOS_SOMA.forEach(({ campoJson, colunaOriginal, nomeAjuste }) => {
    const lista = ajustesRows
      .filter(a => a[nomeAjuste] !== null && a[nomeAjuste] !== undefined)
      .map(a => a[nomeAjuste]);
    resultado[campoJson] = colapsarOriginalEAjustes(row[colunaOriginal], lista);
  });

  // tempo_batida: minutos (tabela ajustes) -> segundos (formato de sempre)
  const listaTempoSegundos = ajustesRows.map(a => a.tempo_batida * 60);
  resultado.tempo_batida = colapsarOriginalEAjustes(row.tempo_batida_original, listaTempoSegundos);

  // densidade/flow: leituras (remedições), não ajustes de receita
  const leiturasDensidade = leiturasRows.filter(l => l.campo === 'densidade').sort((a, b) => a.ordem - b.ordem).map(l => l.valor);
  const leiturasFlow = leiturasRows.filter(l => l.campo === 'flow').sort((a, b) => a.ordem - b.ordem).map(l => l.valor);
  resultado.densidade = colapsarOriginalEAjustes(row.densidade_original, leiturasDensidade);
  resultado.flow = colapsarOriginalEAjustes(row.flow_original, leiturasFlow);

  resultado.obs = row.obs;
  resultado.silo = row.silo;
  resultado.expansao = row.expansao;
  resultado.densidade_eps = row.densidade_eps;

  return resultado;
}

/** Todos os traços, no formato relatorio_injecao.json — usado pela leitura (GET) e pelos backups. */
function todosOsTracos() {
  const tracoRows = db.prepare('SELECT * FROM tracos').all();
  const ajustesRows = db.prepare('SELECT * FROM ajustes ORDER BY id_traco, ordem').all();
  const leiturasRows = db.prepare('SELECT * FROM leituras_resultado ORDER BY id_traco, campo, ordem').all();
  const usosRows = db.prepare('SELECT * FROM traco_usos ORDER BY id').all();

  const ajustesPorTraco = agruparPor(ajustesRows, 'id_traco');
  const leiturasPorTraco = agruparPor(leiturasRows, 'id_traco');
  const usosPorTraco = agruparPor(usosRows, 'id_traco');

  return tracoRows.map(row => rowParaTraco(
    row,
    ajustesPorTraco.get(row.id_traco) || [],
    leiturasPorTraco.get(row.id_traco) || [],
    usosPorTraco.get(row.id_traco) || [],
  ));
}

/** Todos os ajustes, no formato ajustes_tracos.json ({id_traco, ajuste_1, ajuste_2, ...}) — usado pela leitura (GET) e pelos backups. */
function todosOsAjustesTracosJSON() {
  const ajustesRows = db.prepare('SELECT * FROM ajustes ORDER BY id_traco, ordem').all();
  const porTraco = agruparPor(ajustesRows, 'id_traco');
  const resultado = [];
  for (const [idTraco, lista] of porTraco) {
    const entrada = { id_traco: idTraco };
    lista.forEach(a => {
      const item = { tempo_batida: a.tempo_batida };
      ['cimento', 'agua', 'eps', 'superplast', 'incorporador'].forEach(campo => {
        if (a[campo] !== null && a[campo] !== undefined) item[campo] = a[campo];
      });
      item.registrado_em = a.registrado_em;
      entrada['ajuste_' + a.ordem] = item;
    });
    resultado.push(entrada);
  }
  return resultado;
}

const SQL_INSERIR_TRACO = `
  INSERT INTO tracos (
    id_traco, data, turno, num_traco,
    cimento_original, agua_original, eps_original, superplast_original, incorporador_original,
    tempo_batida_original, densidade_original, flow_original,
    obs, silo, expansao, densidade_eps
  ) VALUES (
    @id_traco, @data, @turno, @num_traco,
    @cimento_original, @agua_original, @eps_original, @superplast_original, @incorporador_original,
    @tempo_batida_original, @densidade_original, @flow_original,
    @obs, @silo, @expansao, @densidade_eps
  )
`;
const SQL_INSERIR_USO = `
  INSERT INTO traco_usos (id_traco, id_operacao, id_bateria, berco_inicio, berco_finalizacao, obs)
  VALUES (@id_traco, @id_operacao, @id_bateria, @berco_inicio, @berco_finalizacao, @obs)
`;
const SQL_INSERIR_AJUSTE = `
  INSERT INTO ajustes (id_traco, ordem, tempo_batida, cimento, agua, eps, superplast, incorporador, registrado_em)
  VALUES (@id_traco, @ordem, @tempo_batida, @cimento, @agua, @eps, @superplast, @incorporador, @registrado_em)
`;
const SQL_INSERIR_LEITURA = `
  INSERT INTO leituras_resultado (id_traco, campo, valor, ordem)
  VALUES (@id_traco, @campo, @valor, @ordem)
`;

module.exports.extrairOriginal = extrairOriginal;
module.exports.extrairAjustesNumericos = extrairAjustesNumericos;
module.exports.colapsarOriginalEAjustes = colapsarOriginalEAjustes;
module.exports.rowParaTraco = rowParaTraco;
module.exports.todosOsTracos = todosOsTracos;
module.exports.todosOsAjustesTracosJSON = todosOsAjustesTracosJSON;
module.exports.SQL_INSERIR_TRACO = SQL_INSERIR_TRACO;
module.exports.SQL_INSERIR_USO = SQL_INSERIR_USO;
module.exports.SQL_INSERIR_AJUSTE = SQL_INSERIR_AJUSTE;
module.exports.SQL_INSERIR_LEITURA = SQL_INSERIR_LEITURA;

function migrarRelatorioInjecaoSeNecessario(dbDir) {
  const path = require('path');
  const fs = require('fs');

  const jaTemDados = db.prepare('SELECT COUNT(*) AS n FROM tracos').get().n > 0;
  if (jaTemDados) return;

  const relatorioPath = path.join(dbDir, 'relatorio_injecao.json');
  if (!fs.existsSync(relatorioPath)) return;

  let relatorio = [];
  try {
    const texto = fs.readFileSync(relatorioPath, 'utf8').trim();
    relatorio = texto ? JSON.parse(texto) : [];
  } catch (e) {
    console.error('[migração] Não consegui ler relatorio_injecao.json — abortando migração:', e.message);
    return;
  }
  if (!Array.isArray(relatorio) || !relatorio.length) {
    try { fs.renameSync(relatorioPath, relatorioPath + '.migrado-' + Date.now()); } catch (_) {}
    return;
  }

  // ajustes_tracos.json — fonte confiável de ajustes pra quem já tem
  // entrada; quem não tem, colapsa (ver CAMPOS_SOMA acima e a nota no README).
  const ajustesPath = path.join(dbDir, 'ajustes_tracos.json');
  let ajustesTracos = [];
  try {
    const texto = fs.readFileSync(ajustesPath, 'utf8').trim();
    ajustesTracos = texto ? JSON.parse(texto) : [];
  } catch (_) { /* arquivo pode não existir ainda — ok, trata como vazio */ }
  const ajustesPorTracoOrigem = new Map((ajustesTracos || []).map(a => [a.id_traco, a]));

  const idsOperacaoValidos = new Set(db.prepare('SELECT id FROM operacoes').all().map(r => r.id));

  const inserirTraco = db.prepare(SQL_INSERIR_TRACO);
  const inserirUso = db.prepare(SQL_INSERIR_USO);
  const inserirAjuste = db.prepare(SQL_INSERIR_AJUSTE);
  const inserirLeitura = db.prepare(SQL_INSERIR_LEITURA);

  let tracosColapsados = 0;
  let usosComOperacaoDesconhecida = 0;

  const migrarTudo = db.transaction((registros) => {
    for (const r of registros) {
      const entradaAjustes = ajustesPorTracoOrigem.get(r.id_traco);
      let precisouColapsar = false;

      const paramsTraco = { id_traco: r.id_traco, data: r.data, turno: r.turno ?? null, num_traco: r.num_traco ?? null };

      CAMPOS_SOMA.forEach(({ campoJson, colunaOriginal, nomeAjuste }) => {
        const original = extrairOriginal(r[campoJson]);
        const ajustesDoCampo = extrairAjustesNumericos(r[campoJson]);
        if (entradaAjustes || !ajustesDoCampo.length) {
          paramsTraco[colunaOriginal] = original;
        } else {
          paramsTraco[colunaOriginal] = (original || 0) + ajustesDoCampo.reduce((s, v) => s + v, 0);
          precisouColapsar = true;
        }
      });
      // tempo_batida: mesma regra, mas em segundos (ajustes do relatório já vêm em segundos)
      {
        const original = extrairOriginal(r.tempo_batida);
        const ajustesDoCampo = extrairAjustesNumericos(r.tempo_batida);
        if (entradaAjustes || !ajustesDoCampo.length) {
          paramsTraco.tempo_batida_original = original;
        } else {
          paramsTraco.tempo_batida_original = (original || 0) + ajustesDoCampo.reduce((s, v) => s + v, 0);
          precisouColapsar = true;
        }
      }
      paramsTraco.densidade_original = extrairOriginal(r.densidade);
      paramsTraco.flow_original = extrairOriginal(r.flow);
      paramsTraco.obs = r.obs ?? null;
      paramsTraco.silo = r.silo ?? null;
      paramsTraco.expansao = r.expansao ?? null;
      paramsTraco.densidade_eps = r.densidade_eps ?? null;

      if (precisouColapsar) tracosColapsados++;
      inserirTraco.run(paramsTraco);

      // Usos
      (r.ultilizado?.operacao || []).forEach(uso => {
        if (uso.id_operacao && !idsOperacaoValidos.has(uso.id_operacao)) {
          usosComOperacaoDesconhecida++;
        }
        inserirUso.run({
          id_traco: r.id_traco,
          id_operacao: uso.id_operacao ?? '',
          id_bateria: uso.id_bateria ?? null,
          berco_inicio: uso.berco_inicio ?? null,
          berco_finalizacao: uso.berco_finalizacao ?? null,
          obs: uso.obs ?? null,
        });
      });

      // Ajustes — só migra como linhas próprias quando há entrada confiável
      // em ajustes_tracos.json (ver decisão de colapso acima).
      if (entradaAjustes) {
        Object.keys(entradaAjustes)
          .filter(k => /^ajuste_\d+$/.test(k))
          .sort((a, b) => parseInt(a.split('_')[1], 10) - parseInt(b.split('_')[1], 10))
          .forEach((k, i) => {
            const a = entradaAjustes[k];
            inserirAjuste.run({
              id_traco: r.id_traco,
              ordem: i + 1,
              tempo_batida: a.tempo_batida,
              cimento: a.cimento ?? null,
              agua: a.agua ?? null,
              eps: a.eps ?? null,
              superplast: a.superplast ?? null,
              incorporador: a.incorporador ?? null,
              registrado_em: a.registrado_em || new Date().toISOString(),
            });
          });
      }

      // Leituras de densidade/flow — sempre migradas (nunca dependem de ajustes_tracos.json)
      ['densidade', 'flow'].forEach(campo => {
        extrairAjustesNumericos(r[campo]).forEach((valor, i) => {
          inserirLeitura.run({ id_traco: r.id_traco, campo, valor, ordem: i + 1 });
        });
      });
    }
  });

  migrarTudo(relatorio);

  let msg = `[migração] ${relatorio.length} traço(s) migrado(s) de relatorio_injecao.json pra SQLite.`;
  if (tracosColapsados) msg += ` ${tracosColapsados} tinha(m) ajuste(s) sem entrada correspondente em ajustes_tracos.json — total preservado, histórico do ajuste colapsado no valor original (ver README).`;
  if (usosComOperacaoDesconhecida) msg += ` ATENÇÃO: ${usosComOperacaoDesconhecida} uso(s) referenciam id_operacao que não existe em "operacoes" (provavelmente registros antigos ou importados) — migrados mesmo assim.`;
  console.log(msg);

  try {
    fs.renameSync(relatorioPath, relatorioPath + '.migrado-' + Date.now());
  } catch (e) {
    console.error('[migração] Migrei os traços, mas não consegui renomear relatorio_injecao.json:', e.message);
  }
  if (ajustesTracos.length) {
    try {
      fs.renameSync(ajustesPath, ajustesPath + '.migrado-' + Date.now());
    } catch (e) {
      console.error('[migração] Migrei os ajustes, mas não consegui renomear ajustes_tracos.json:', e.message);
    }
  }

  // relatorio_edicoes.json (auditoria) — migra junto, mesmo critério de sempre.
  const edicoesPath = path.join(dbDir, 'relatorio_edicoes.json');
  if (fs.existsSync(edicoesPath)) {
    try {
      const texto = fs.readFileSync(edicoesPath, 'utf8').trim();
      const edicoes = texto ? JSON.parse(texto) : [];
      if (Array.isArray(edicoes) && edicoes.length) {
        const inserirEdicao = db.prepare(`
          INSERT INTO edicoes_traco (id_traco, id_operacao, data_edicao, campos_alterados)
          VALUES (@id_traco, @id_operacao, @data_edicao, @campos_alterados)
        `);
        const migrarEdicoes = db.transaction((lista) => {
          for (const e of lista) {
            inserirEdicao.run({
              id_traco: e.id_traco,
              id_operacao: e.id_operacao ?? null,
              data_edicao: e.data_edicao,
              campos_alterados: JSON.stringify(e.campos_alterados || []),
            });
          }
        });
        migrarEdicoes(edicoes);
        console.log(`[migração] ${edicoes.length} edição(ões) de traço migrada(s) de relatorio_edicoes.json pra SQLite.`);
      }
      fs.renameSync(edicoesPath, edicoesPath + '.migrado-' + Date.now());
    } catch (e) {
      console.error('[migração] Falha ao migrar relatorio_edicoes.json:', e.message);
    }
  }
}

module.exports.migrarRelatorioInjecaoSeNecessario = migrarRelatorioInjecaoSeNecessario;

/**
 * Substitui TODO o conteúdo de tracos/traco_usos/ajustes/leituras_resultado
 * a partir de um relatorio_injecao.json + ajustes_tracos.json completos —
 * usado por "Restaurar Backup de Dados" (não pela migração automática, que
 * tem sua própria versão dessa mesma lógica, já que parte de tabelas
 * vazias e cuida também de renomear os arquivos de origem). Mesma decisão
 * de colapso de sempre: confia no .original quando já existe ajuste
 * confiável pra aquele traço; senão, soma tudo no original (ver "Banco de
 * Dados (SQLite)" no README).
 * @param {Array} relatorioArray - conteúdo de relatorio_injecao.json
 * @param {Array} ajustesArray - conteúdo de ajustes_tracos.json
 */
function substituirTracosEAjustes(relatorioArray, ajustesArray) {
  db.prepare('DELETE FROM leituras_resultado').run();
  db.prepare('DELETE FROM ajustes').run();
  db.prepare('DELETE FROM traco_usos').run();
  db.prepare('DELETE FROM tracos').run();

  const ajustesPorTracoOrigem = new Map((ajustesArray || []).map(a => [a.id_traco, a]));

  const inserirTraco = db.prepare(SQL_INSERIR_TRACO);
  const inserirUso = db.prepare(SQL_INSERIR_USO);
  const inserirAjuste = db.prepare(SQL_INSERIR_AJUSTE);
  const inserirLeitura = db.prepare(SQL_INSERIR_LEITURA);

  for (const r of (relatorioArray || [])) {
    const entradaAjustes = ajustesPorTracoOrigem.get(r.id_traco);
    const paramsTraco = { id_traco: r.id_traco, data: r.data, turno: r.turno ?? null, num_traco: r.num_traco ?? null };

    CAMPOS_SOMA.forEach(({ campoJson, colunaOriginal }) => {
      const original = extrairOriginal(r[campoJson]);
      const ajustesDoCampo = extrairAjustesNumericos(r[campoJson]);
      paramsTraco[colunaOriginal] = (entradaAjustes || !ajustesDoCampo.length)
        ? original
        : (original || 0) + ajustesDoCampo.reduce((s, v) => s + v, 0);
    });
    {
      const original = extrairOriginal(r.tempo_batida);
      const ajustesDoCampo = extrairAjustesNumericos(r.tempo_batida);
      paramsTraco.tempo_batida_original = (entradaAjustes || !ajustesDoCampo.length)
        ? original
        : (original || 0) + ajustesDoCampo.reduce((s, v) => s + v, 0);
    }
    paramsTraco.densidade_original = extrairOriginal(r.densidade);
    paramsTraco.flow_original = extrairOriginal(r.flow);
    paramsTraco.obs = r.obs ?? null;
    paramsTraco.silo = r.silo ?? null;
    paramsTraco.expansao = r.expansao ?? null;
    paramsTraco.densidade_eps = r.densidade_eps ?? null;
    inserirTraco.run(paramsTraco);

    (r.ultilizado?.operacao || []).forEach(uso => {
      inserirUso.run({
        id_traco: r.id_traco, id_operacao: uso.id_operacao ?? '', id_bateria: uso.id_bateria ?? null,
        berco_inicio: uso.berco_inicio ?? null, berco_finalizacao: uso.berco_finalizacao ?? null, obs: uso.obs ?? null,
      });
    });

    if (entradaAjustes) {
      Object.keys(entradaAjustes)
        .filter(k => /^ajuste_\d+$/.test(k))
        .sort((a, b) => parseInt(a.split('_')[1], 10) - parseInt(b.split('_')[1], 10))
        .forEach((k, i) => {
          const a = entradaAjustes[k];
          inserirAjuste.run({
            id_traco: r.id_traco, ordem: i + 1, tempo_batida: a.tempo_batida,
            cimento: a.cimento ?? null, agua: a.agua ?? null, eps: a.eps ?? null,
            superplast: a.superplast ?? null, incorporador: a.incorporador ?? null,
            registrado_em: a.registrado_em || new Date().toISOString(),
          });
        });
    }

    ['densidade', 'flow'].forEach(campo => {
      extrairAjustesNumericos(r[campo]).forEach((valor, i) => {
        inserirLeitura.run({ id_traco: r.id_traco, campo, valor, ordem: i + 1 });
      });
    });
  }
}

module.exports.substituirTracosEAjustes = substituirTracosEAjustes;

/**
 * Mescla um relatorio_injecao.json + ajustes_tracos.json de OUTRA
 * instalação do sistema pro banco ATUAL, sem apagar nada — usado por
 * "Mesclar Backup de Dados" (ver server.js POST /mesclar-backup-dados).
 * Diferente de substituirTracosEAjustes (que sobrescreve tudo):
 *   - nenhum DELETE — só INSERT;
 *   - cada id_traco é gerado de novo (o da origem pode colidir com o
 *     daqui — duas instalações nunca combinaram esse id entre si);
 *   - deduplica um traço pela MESMA chave (id_operacao + num_traco) já
 *     usada por /importar-relatorio-injecao — um traço só é pulado se
 *     algum dos seus usos já existir aqui com esse mesmo par. Traço sem
 *     nenhum uso (sobra nunca usada) cai num fallback por (data+num_traco).
 * @returns {{tracosInseridos:number, tracosDuplicados:number}}
 */
function mesclarTracosEAjustes(relatorioArray, ajustesArray) {
  const ajustesPorTracoOrigem = new Map((ajustesArray || []).map(a => [a.id_traco, a]));

  const existentesPorUso = new Set(
    db.prepare(`
      SELECT tu.id_operacao || '|' || t.num_traco AS chave
      FROM traco_usos tu JOIN tracos t ON t.id_traco = tu.id_traco
    `).all().map(r => r.chave)
  );
  const existentesPorDataNum = new Set(
    db.prepare(`SELECT data || '|' || num_traco AS chave FROM tracos`).all().map(r => r.chave)
  );

  const inserirTraco = db.prepare(SQL_INSERIR_TRACO);
  const inserirUso = db.prepare(SQL_INSERIR_USO);
  const inserirAjuste = db.prepare(SQL_INSERIR_AJUSTE);
  const inserirLeitura = db.prepare(SQL_INSERIR_LEITURA);

  let tracosInseridos = 0, tracosDuplicados = 0;

  (relatorioArray || []).forEach((r, i) => {
    const usos = r.ultilizado?.operacao || [];
    const chaveDataNum = (r.data ?? '') + '|' + (r.num_traco ?? '');

    const jaExiste = usos.length
      ? usos.some(u => existentesPorUso.has((u.id_operacao ?? '') + '|' + (r.num_traco ?? '')))
      : existentesPorDataNum.has(chaveDataNum); // traço sem uso (sobra nunca usada)

    if (jaExiste) { tracosDuplicados++; return; }

    const idTracoNovo = 'merge_traco_' + Date.now() + '_' + i;
    const entradaAjustes = ajustesPorTracoOrigem.get(r.id_traco);
    const paramsTraco = { id_traco: idTracoNovo, data: r.data, turno: r.turno ?? null, num_traco: r.num_traco ?? null };

    CAMPOS_SOMA.forEach(({ campoJson, colunaOriginal }) => {
      const original = extrairOriginal(r[campoJson]);
      const ajustesDoCampo = extrairAjustesNumericos(r[campoJson]);
      paramsTraco[colunaOriginal] = (entradaAjustes || !ajustesDoCampo.length)
        ? original
        : (original || 0) + ajustesDoCampo.reduce((s, v) => s + v, 0);
    });
    {
      const original = extrairOriginal(r.tempo_batida);
      const ajustesDoCampo = extrairAjustesNumericos(r.tempo_batida);
      paramsTraco.tempo_batida_original = (entradaAjustes || !ajustesDoCampo.length)
        ? original
        : (original || 0) + ajustesDoCampo.reduce((s, v) => s + v, 0);
    }
    paramsTraco.densidade_original = extrairOriginal(r.densidade);
    paramsTraco.flow_original = extrairOriginal(r.flow);
    paramsTraco.obs = r.obs ?? null;
    paramsTraco.silo = r.silo ?? null;
    paramsTraco.expansao = r.expansao ?? null;
    paramsTraco.densidade_eps = r.densidade_eps ?? null;
    inserirTraco.run(paramsTraco);

    usos.forEach(uso => {
      inserirUso.run({
        id_traco: idTracoNovo, id_operacao: uso.id_operacao ?? '', id_bateria: uso.id_bateria ?? null,
        berco_inicio: uso.berco_inicio ?? null, berco_finalizacao: uso.berco_finalizacao ?? null, obs: uso.obs ?? null,
      });
      existentesPorUso.add((uso.id_operacao ?? '') + '|' + (r.num_traco ?? ''));
    });
    if (!usos.length) existentesPorDataNum.add(chaveDataNum);

    if (entradaAjustes) {
      Object.keys(entradaAjustes)
        .filter(k => /^ajuste_\d+$/.test(k))
        .sort((a, b) => parseInt(a.split('_')[1], 10) - parseInt(b.split('_')[1], 10))
        .forEach((k, idx) => {
          const a = entradaAjustes[k];
          inserirAjuste.run({
            id_traco: idTracoNovo, ordem: idx + 1, tempo_batida: a.tempo_batida,
            cimento: a.cimento ?? null, agua: a.agua ?? null, eps: a.eps ?? null,
            superplast: a.superplast ?? null, incorporador: a.incorporador ?? null,
            registrado_em: a.registrado_em || new Date().toISOString(),
          });
        });
    }

    ['densidade', 'flow'].forEach(campo => {
      extrairAjustesNumericos(r[campo]).forEach((valor, idx) => {
        inserirLeitura.run({ id_traco: idTracoNovo, campo, valor, ordem: idx + 1 });
      });
    });

    tracosInseridos++;
  });

  return { tracosInseridos, tracosDuplicados };
}

module.exports.mesclarTracosEAjustes = mesclarTracosEAjustes;