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

  return {
    extrairOriginal,
    extrairAjustesNumericos,
    colapsarOriginalEAjustes,
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
