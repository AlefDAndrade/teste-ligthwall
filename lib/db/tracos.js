// ─── lib/db/tracos.js — Traços (relatorio_injecao.json + ajustes_tracos.json
//     -> tracos + traco_usos + ajustes + leituras_resultado) ──────────────
// Fase 8 do fatiamento de db.js (ver README, "Fatiamento de db.js (plano)").
// Extraído sem mudar nenhuma lógica — só de onde o código mora. Era a
// maior fatia isolada que restava (deixada por último de propósito, por
// ser a que mais afeta valor exibido ao usuário se algo sair errado — ver
// nota de risco da Fase 8 na tabela do README).
//
// Mesmo padrão das extrações anteriores (paradas, sobra-contador-tracos,
// manutencao-corretiva, etc.): uma factory que recebe a conexão já aberta
// (`db`, o objeto do better-sqlite3) e devolve as funções do domínio,
// penduradas de volta em module.exports (= db, em db.js) via
// Object.assign — ninguém em lib/rotas/ ou server.js precisa mudar nada,
// continuam chamando db.todosOsTracos(), db.substituirTracosEAjustes(),
// etc., exatamente como antes.
//
// Contém: os dois conversores original/ajustes (extrairOriginal /
// extrairAjustesNumericos / colapsarOriginalEAjustes — a decisão de
// normalizar ajustes, "Opção B", ver "Banco de Dados (SQLite)" no
// README), a reconstrução de 1 traço (rowParaTraco) e de todos
// (todosOsTracos / todosOsAjustesTracosJSON), as 4 queries de INSERT, a
// migração automática de relatorio_injecao.json + ajustes_tracos.json
// (migrarRelatorioInjecaoSeNecessario) e as duas operações de backup
// (substituirTracosEAjustes — Restaurar Backup de Dados —, e
// mesclarTracosEAjustes — Mesclar Backup de Dados).

module.exports = function criarDbTracos(db) {
  // agoraBrasiliaISOServer: require direto, sem injeção — lib/tempo.js é
  // um módulo puro (sem estado/I/O), mesmo padrão de lib/perfis.js (ver
  // comentário no topo de lib/tempo.js). Usado nos fallbacks de
  // registrado_em (restaurar/mesclar backup, migração do JSON legado) —
  // NUNCA new Date().toISOString() puro ali: geraria UTC de verdade, mas
  // LW.formatDateTime (front) assume a convenção fake-UTC-como-Brasília
  // e não reconverte — o "Quando" do painel de ajustes ficaria adiantado
  // em 3h (bug recorrente, corrigido pela 1ª vez no registro AO VIVO do
  // ajuste, ver lib/rotas/leitura-e-ajustes.js).
  const { agoraBrasiliaISOServer } = require('../tempo.js');


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
  // "insumo" = nome canônico usado nas tabelas dinâmicas (traco_insumos/
  // ajuste_insumos) e em LW.INSUMO_RECEITA_OPTS (public/js/data.js) —
  // mesmos 5 nomes do fallback de instalação sem config.json customizado.
  const CAMPOS_SOMA = [
    { campoJson: 'cimento_real', colunaOriginal: 'cimento_original', nomeAjuste: 'cimento', insumo: 'Cimento' },
    { campoJson: 'agua_real', colunaOriginal: 'agua_original', nomeAjuste: 'agua', insumo: 'Água' },
    { campoJson: 'eps_real', colunaOriginal: 'eps_original', nomeAjuste: 'eps', insumo: 'EPS' },
    { campoJson: 'superplast_real', colunaOriginal: 'superplast_original', nomeAjuste: 'superplast', insumo: 'Superplastificante' },
    { campoJson: 'incorporador_real', colunaOriginal: 'incorporador_original', nomeAjuste: 'incorporador', insumo: 'Incorporador de Ar' },
  ];

  // ============================================================
  //  FASE 1 — Insumos de Receitas dinâmicos no formulário de traço
  //  (ver PLANO-insumos-dinamicos-receitas.md).
  //
  //  Migração ÚNICA (idempotente — checa se já rodou via COUNT em
  //  traco_insumos, mesmo raciocínio das migrações leves de coluna em
  //  db.js) das 5 colunas fixas de insumo em "tracos"/"ajustes" pras
  //  tabelas dinâmicas traco_insumos/ajuste_insumos (criadas em db.js,
  //  ver CREATE TABLE ali). Só COPIA — nunca apaga as colunas fixas.
  //
  //  Re-escopo decidido antes da Fase 2 (ver PLANO): os 5 insumos
  //  "Padrão" são fixos PRA SEMPRE (nunca mudam, não podem ser removidos
  //  nem renomeados em Configurações) — então continuam morando só nas
  //  colunas fixas de "tracos"/"ajustes" (nunca mais mexidas depois desta
  //  migração). As tabelas dinâmicas, a partir da Fase 2, servem só pros
  //  insumos CUSTOM (que variam por traço) — ver
  //  salvarInsumosCustomDoTraco/salvarInsumosCustomDoAjuste, abaixo. As 5
  //  linhas por traço que esta migração grava pros Padrão viram um
  //  registro histórico inerte (ninguém lê depois) — mantido só porque já
  //  rodou em produção (ver commit da Fase 1) e não vale a pena reverter.
  // ============================================================
  function migrarInsumosFixosParaDinamico() {
    const jaMigrado = db.prepare('SELECT COUNT(*) AS n FROM traco_insumos').get().n > 0;
    if (jaMigrado) return;

    const tracoRows = db.prepare('SELECT * FROM tracos').all();
    if (!tracoRows.length) return; // banco novo/vazio — nada a migrar

    const inserirTracoInsumo = db.prepare(
      'INSERT INTO traco_insumos (id_traco, insumo, valor) VALUES (@id_traco, @insumo, @valor)'
    );
    const inserirAjusteInsumo = db.prepare(
      'INSERT INTO ajuste_insumos (id_ajuste, insumo, valor) VALUES (@id_ajuste, @insumo, @valor)'
    );
    const ajusteRows = db.prepare('SELECT * FROM ajustes').all();

    const migrar = db.transaction(() => {
      tracoRows.forEach(row => {
        CAMPOS_SOMA.forEach(({ colunaOriginal, insumo }) => {
          const valor = row[colunaOriginal];
          if (valor !== null && valor !== undefined) {
            inserirTracoInsumo.run({ id_traco: row.id_traco, insumo, valor });
          }
        });
      });
      ajusteRows.forEach(row => {
        CAMPOS_SOMA.forEach(({ nomeAjuste, insumo }) => {
          const valor = row[nomeAjuste];
          if (valor !== null && valor !== undefined) {
            inserirAjusteInsumo.run({ id_ajuste: row.id, insumo, valor });
          }
        });
      });
    });
    migrar();

    console.log(`[migração] Insumos de receita migrados das colunas fixas pras tabelas dinâmicas (${tracoRows.length} traço(s), ${ajusteRows.length} ajuste(s)).`);
  }
  // NÃO chama migrarInsumosFixosParaDinamico() aqui (diferente do que o
  // comentário da função já deixa claro) — precisa rodar DEPOIS de
  // migrarRelatorioInjecaoSeNecessario ter preenchido "tracos"/"ajustes"
  // a partir do JSON legado, senão encontra as tabelas vazias e não migra
  // nada. Por isso é exportada e chamada explicitamente em server.js,
  // logo após db.migrarRelatorioInjecaoSeNecessario(DB_DIR) — mesmo
  // padrão de todas as outras migrações de fase (ver comentário ali).

  // ============================================================
  //  FASE 2 — Insumos CUSTOM dinâmicos (leitura/escrita)
  //  (ver PLANO-insumos-dinamicos-receitas.md).
  //
  //  Diferente da Fase 1 (migração passada, um evento único), isto aqui é
  //  o caminho de leitura/escrita usado dali pra frente. Só cuida de
  //  insumos CUSTOM — os 5 Padrão continuam exclusivamente nas colunas
  //  fixas (CAMPOS_SOMA, acima), sem nenhuma mudança de comportamento.
  // ============================================================

  // Nomes canônicos dos 5 Padrão — usado só pra FILTRAR fora qualquer
  // linha "fantasma" que a migração da Fase 1 tenha deixado gravada nas
  // tabelas dinâmicas pra esses 5 (ver comentário na migração, acima):
  // esta camada de leitura nunca deve devolver um Padrão dentro de
  // insumos_custom, mesmo que a linha exista fisicamente na tabela.
  const NOMES_INSUMOS_PADRAO = new Set(CAMPOS_SOMA.map(c => c.insumo));

  /** Agrupa linhas de traco_insumos/ajuste_insumos em {chave -> {insumo: valor}}, já excluindo os 5 Padrão. */
  function agruparInsumosCustomPorChave(rows, campoChave) {
    const mapa = new Map();
    rows.forEach(r => {
      if (NOMES_INSUMOS_PADRAO.has(r.insumo)) return; // Padrão não passa por aqui — ver comentário acima
      if (!mapa.has(r[campoChave])) mapa.set(r[campoChave], {});
      mapa.get(r[campoChave])[r.insumo] = r.valor;
    });
    return mapa;
  }

  /**
   * Monta o insumos_custom de 1 traço no mesmo formato original/ajustes de
   * sempre (colapsarOriginalEAjustes) — usado por rowParaTraco. `origem` é
   * o {insumo: valor} desse id_traco em traco_insumos (pode faltar = {}).
   * `porAjuste` é o Map inteiro id_ajuste -> {insumo: valor} (ajuste_insumos
   * já agrupado) — cada ajuste do traço pode ou não ter registrado aquele
   * insumo (mesma semântica de "pulei se não tem", igual CAMPOS_SOMA).
   */
  function montarInsumosCustom(origem, ajustesRows, porAjuste) {
    const nomes = new Set(Object.keys(origem || {}));
    ajustesRows.forEach(a => {
      const doAjuste = porAjuste.get(a.id);
      if (doAjuste) Object.keys(doAjuste).forEach(n => nomes.add(n));
    });
    if (!nomes.size) return undefined; // traço sem NENHUM custom — não polui o JSON com {}

    const resultado = {};
    nomes.forEach(nome => {
      const original = (origem || {})[nome];
      const lista = ajustesRows
        .filter(a => porAjuste.get(a.id) && porAjuste.get(a.id)[nome] !== undefined)
        .map(a => porAjuste.get(a.id)[nome]);
      resultado[nome] = colapsarOriginalEAjustes(original, lista);
    });
    return resultado;
  }

  /**
   * Grava os insumos CUSTOM "originais" de um traço (1ª receita, antes de
   * qualquer ajuste) — chamada pelas rotas de registro/edição/offline na
   * Fase 3. `insumosCustom` é {nome: valor}; nomes Padrão e valores vazios
   * (null/undefined/'') são ignorados (Padrão nunca passa por aqui — ver
   * NOMES_INSUMOS_PADRAO — e valor vazio não é "insumo usado", é "não
   * preenchido").
   */
  function salvarInsumosCustomDoTraco(idTraco, insumosCustom) {
    if (!insumosCustom || typeof insumosCustom !== 'object') return;
    // INSERT OR IGNORE (chave primária é id_traco+insumo, ver db.js) —
    // fundamental pro bug corrigido depois da Fase 6: um insumo Custom
    // pode ser adicionado ao traço (botão "+") DEPOIS que esse id_traco
    // já existe em "tracos" (ex: traço usado em 2+ baterias da mesma
    // operação — só a 1ª chamada a esta função rodava, pela guarda
    // `if (!tracoExiste)` nas rotas; as chamadas seguintes, que já
    // teriam o insumo novo no payload, nunca rodavam). Com OR IGNORE, a
    // rota passa a chamar esta função em TODA submissão (ver
    // registro-operacao.js/operacao-offline.js): quem já tem linha pra
    // aquele (id_traco, insumo) simplesmente é ignorado — preserva a
    // regra de "nunca reescreve a receita original" — mas um insumo
    // NOVO, que ainda não tinha linha nenhuma, agora consegue entrar.
    const inserir = db.prepare('INSERT OR IGNORE INTO traco_insumos (id_traco, insumo, valor) VALUES (@id_traco, @insumo, @valor)');
    Object.entries(insumosCustom).forEach(([nome, valor]) => {
      if (NOMES_INSUMOS_PADRAO.has(nome)) return;
      if (valor === null || valor === undefined || valor === '') return;
      inserir.run({ id_traco: idTraco, insumo: nome, valor: Number(valor) });
    });
  }

  /**
   * Mesma ideia de salvarInsumosCustomDoTraco, mas pra 1 ajuste específico
   * (reaproveitamento) — `idAjuste` é o `lastInsertRowid` devolvido por
   * `db.prepare(SQL_INSERIR_AJUSTE).run(...)`.
   */
  function salvarInsumosCustomDoAjuste(idAjuste, insumosCustom) {
    if (!insumosCustom || typeof insumosCustom !== 'object') return;
    const inserir = db.prepare('INSERT INTO ajuste_insumos (id_ajuste, insumo, valor) VALUES (@id_ajuste, @insumo, @valor)');
    Object.entries(insumosCustom).forEach(([nome, valor]) => {
      if (NOMES_INSUMOS_PADRAO.has(nome)) return;
      if (valor === null || valor === undefined || valor === '') return;
      inserir.run({ id_ajuste: idAjuste, insumo: nome, valor: Number(valor) });
    });
  }

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
   * edição (/editar-traco-relatorio). `insumosCustomOriginais` (opcional) é
   * o {insumo: valor} desse traço em traco_insumos; `insumosCustomPorAjuste`
   * (opcional) é o Map inteiro id_ajuste -> {insumo: valor} de
   * ajuste_insumos (ver montarInsumosCustom, Fase 2) — omitidos, o traço
   * simplesmente não ganha a chave insumos_custom no resultado.
   */
  function rowParaTraco(row, ajustesRows = [], leiturasRows = [], usosRows = [], insumosCustomOriginais = {}, insumosCustomPorAjuste = new Map()) {
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

    // Insumos CUSTOM (Fase 2, ver PLANO-insumos-dinamicos-receitas.md) —
    // mesmo raciocínio dos 5 CAMPOS_SOMA acima, mas em número variável;
    // só entra no resultado se o traço tiver pelo menos 1.
    const insumosCustom = montarInsumosCustom(insumosCustomOriginais, ajustesRows, insumosCustomPorAjuste);
    if (insumosCustom) resultado.insumos_custom = insumosCustom;

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
    // Insumos custom — ver comentário de NOMES_INSUMOS_PADRAO/
    // agruparInsumosCustomPorChave (Fase 2): já vem filtrado, sem os 5
    // Padrão (esses continuam só em tracoRows/ajustesRows, acima).
    const insumosOriginaisPorTraco = agruparInsumosCustomPorChave(db.prepare('SELECT * FROM traco_insumos').all(), 'id_traco');
    const insumosPorAjuste = agruparInsumosCustomPorChave(db.prepare('SELECT * FROM ajuste_insumos').all(), 'id_ajuste');

    const ajustesPorTraco = agruparPor(ajustesRows, 'id_traco');
    const leiturasPorTraco = agruparPor(leiturasRows, 'id_traco');
    const usosPorTraco = agruparPor(usosRows, 'id_traco');

    return tracoRows.map(row => rowParaTraco(
      row,
      ajustesPorTraco.get(row.id_traco) || [],
      leiturasPorTraco.get(row.id_traco) || [],
      usosPorTraco.get(row.id_traco) || [],
      insumosOriginaisPorTraco.get(row.id_traco) || {},
      insumosPorAjuste,
    ));
  }

  /** Todos os ajustes, no formato ajustes_tracos.json ({id_traco, ajuste_1, ajuste_2, ...}) — usado pela leitura (GET) e pelos backups. */
  function todosOsAjustesTracosJSON() {
    const ajustesRows = db.prepare('SELECT * FROM ajustes ORDER BY id_traco, ordem').all();
    const porTraco = agruparPor(ajustesRows, 'id_traco');
    // Insumos custom por ajuste (Fase 2) — mesmo raciocínio de
    // todosOsTracos, acima: já vem filtrado sem os 5 Padrão.
    const insumosCustomPorAjuste = agruparInsumosCustomPorChave(db.prepare('SELECT * FROM ajuste_insumos').all(), 'id_ajuste');
    const resultado = [];
    for (const [idTraco, lista] of porTraco) {
      const entrada = { id_traco: idTraco };
      lista.forEach(a => {
        const item = { tempo_batida: a.tempo_batida };
        ['cimento', 'agua', 'eps', 'superplast', 'incorporador'].forEach(campo => {
          if (a[campo] !== null && a[campo] !== undefined) item[campo] = a[campo];
        });
        // Insumos custom deste ajuste específico, se houver algum.
        const insumosCustom = insumosCustomPorAjuste.get(a.id);
        if (insumosCustom && Object.keys(insumosCustom).length) item.insumos_custom = insumosCustom;
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
      // Renomeia só pra não tentar reprocessar este arquivo no próximo boot.
      // Se falhar (ex.: sem permissão de escrita no diretório), não é
      // crítico — o array já estava vazio, então não havia nada a migrar.
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
                registrado_em: a.registrado_em || agoraBrasiliaISOServer(),
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
    // Insumos custom (Fase 2) — um Restaurar Backup de Dados substitui TUDO,
    // igual as 4 tabelas acima (inclui as linhas "fantasma" de Padrão que a
    // migração da Fase 1 deixou — não tem problema apagar, ninguém lê mais
    // dali, ver comentário em migrarInsumosFixosParaDinamico).
    db.prepare('DELETE FROM ajuste_insumos').run();
    db.prepare('DELETE FROM traco_insumos').run();

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
      // Insumos custom "originais" do traço (Fase 2) — não entram na soma
      // com ajustes como os CAMPOS_SOMA acima (regra própria: valem pro
      // traço inteiro, ver PLANO) — grava o valor tal como veio.
      salvarInsumosCustomDoTraco(r.id_traco, r.insumos_custom);

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
            const infoAjuste = inserirAjuste.run({
              id_traco: r.id_traco, ordem: i + 1, tempo_batida: a.tempo_batida,
              cimento: a.cimento ?? null, agua: a.agua ?? null, eps: a.eps ?? null,
              superplast: a.superplast ?? null, incorporador: a.incorporador ?? null,
              registrado_em: a.registrado_em || agoraBrasiliaISOServer(),
            });
            salvarInsumosCustomDoAjuste(infoAjuste.lastInsertRowid, a.insumos_custom);
          });
      }

      ['densidade', 'flow'].forEach(campo => {
        extrairAjustesNumericos(r[campo]).forEach((valor, i) => {
          inserirLeitura.run({ id_traco: r.id_traco, campo, valor, ordem: i + 1 });
        });
      });
    }
  }


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

    // Viraram Map (não só Set) — precisamos não só saber SE já existe,
    // mas também QUAL id_traco (do DESTINO) corresponde àquela chave, pra
    // montar mapaIdOrigemParaNovo (abaixo). Motivo de existir: esta
    // função sempre gerou um id_traco NOVO e sintético pro traço
    // mesclado (nunca reaproveita o id_traco do backup de origem — ver
    // idTracoNovo, abaixo) — então qualquer domínio SATÉLITE que
    // referencie um id_traco de origem (ex: relatorio_edicoes.json,
    // ver lib/rotas/backup.js) precisa desta tradução pra saber em qual
    // linha de "tracos" no destino aquela edição deveria cair, seja o
    // traço uma inserção NOVA nesta mesma mesclagem, seja ele já
    // existente de uma mesclagem anterior.
    const idTracoPorChaveUso = new Map(
      db.prepare(`
        SELECT tu.id_operacao || '|' || t.num_traco AS chave, t.id_traco
        FROM traco_usos tu JOIN tracos t ON t.id_traco = tu.id_traco
      `).all().map(r => [r.chave, r.id_traco])
    );
    const idTracoPorChaveDataNum = new Map(
      db.prepare(`SELECT data || '|' || num_traco AS chave, id_traco FROM tracos`).all().map(r => [r.chave, r.id_traco])
    );

    const inserirTraco = db.prepare(SQL_INSERIR_TRACO);
    const inserirUso = db.prepare(SQL_INSERIR_USO);
    const inserirAjuste = db.prepare(SQL_INSERIR_AJUSTE);
    const inserirLeitura = db.prepare(SQL_INSERIR_LEITURA);

    let tracosInseridos = 0, tracosDuplicados = 0;
    const mapaIdOrigemParaNovo = new Map();

    (relatorioArray || []).forEach((r, i) => {
      const usos = r.ultilizado?.operacao || [];
      const chaveDataNum = (r.data ?? '') + '|' + (r.num_traco ?? '');

      let idTracoExistente = null;
      if (usos.length) {
        for (const u of usos) {
          const chave = (u.id_operacao ?? '') + '|' + (r.num_traco ?? '');
          if (idTracoPorChaveUso.has(chave)) { idTracoExistente = idTracoPorChaveUso.get(chave); break; }
        }
      } else if (idTracoPorChaveDataNum.has(chaveDataNum)) { // traço sem uso (sobra nunca usada)
        idTracoExistente = idTracoPorChaveDataNum.get(chaveDataNum);
      }

      if (idTracoExistente) {
        tracosDuplicados++;
        if (r.id_traco) mapaIdOrigemParaNovo.set(r.id_traco, idTracoExistente);
        return;
      }

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
      // Insumos custom "originais" do traço mesclado (Fase 2) — mesmo
      // raciocínio de substituirTracosEAjustes, acima.
      salvarInsumosCustomDoTraco(idTracoNovo, r.insumos_custom);

      usos.forEach(uso => {
        inserirUso.run({
          id_traco: idTracoNovo, id_operacao: uso.id_operacao ?? '', id_bateria: uso.id_bateria ?? null,
          berco_inicio: uso.berco_inicio ?? null, berco_finalizacao: uso.berco_finalizacao ?? null, obs: uso.obs ?? null,
        });
        idTracoPorChaveUso.set((uso.id_operacao ?? '') + '|' + (r.num_traco ?? ''), idTracoNovo);
      });
      if (!usos.length) idTracoPorChaveDataNum.set(chaveDataNum, idTracoNovo);

      if (entradaAjustes) {
        Object.keys(entradaAjustes)
          .filter(k => /^ajuste_\d+$/.test(k))
          .sort((a, b) => parseInt(a.split('_')[1], 10) - parseInt(b.split('_')[1], 10))
          .forEach((k, idx) => {
            const a = entradaAjustes[k];
            const infoAjuste = inserirAjuste.run({
              id_traco: idTracoNovo, ordem: idx + 1, tempo_batida: a.tempo_batida,
              cimento: a.cimento ?? null, agua: a.agua ?? null, eps: a.eps ?? null,
              superplast: a.superplast ?? null, incorporador: a.incorporador ?? null,
              registrado_em: a.registrado_em || agoraBrasiliaISOServer(),
            });
            salvarInsumosCustomDoAjuste(infoAjuste.lastInsertRowid, a.insumos_custom);
          });
      }

      ['densidade', 'flow'].forEach(campo => {
        extrairAjustesNumericos(r[campo]).forEach((valor, idx) => {
          inserirLeitura.run({ id_traco: idTracoNovo, campo, valor, ordem: idx + 1 });
        });
      });

      if (r.id_traco) mapaIdOrigemParaNovo.set(r.id_traco, idTracoNovo);
      tracosInseridos++;
    });

    return { tracosInseridos, tracosDuplicados, mapaIdOrigemParaNovo };
  }

  return {
    extrairOriginal,
    extrairAjustesNumericos,
    colapsarOriginalEAjustes,
    // Fase 1 de "Insumos de Receitas dinâmicos" — expostos pra uso nas
    // próximas fases (leitura/escrita dinâmica) e pra teste direto da
    // migração (ver test/insumos-dinamicos-migracao.test.js).
    CAMPOS_SOMA,
    migrarInsumosFixosParaDinamico,
    // Fase 2 — insumos CUSTOM (ver PLANO-insumos-dinamicos-receitas.md).
    // Usadas pelas rotas de registro/edição/offline (Fase 3, ainda não
    // implementada) pra gravar o que vier além dos 5 Padrão.
    NOMES_INSUMOS_PADRAO,
    salvarInsumosCustomDoTraco,
    salvarInsumosCustomDoAjuste,
    rowParaTraco,
    todosOsTracos,
    todosOsAjustesTracosJSON,
    SQL_INSERIR_TRACO,
    SQL_INSERIR_USO,
    SQL_INSERIR_AJUSTE,
    SQL_INSERIR_LEITURA,
    migrarRelatorioInjecaoSeNecessario,
    substituirTracosEAjustes,
    mesclarTracosEAjustes,
  };
};
