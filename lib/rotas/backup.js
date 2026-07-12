// ─── lib/rotas/backup.js — Backup e Restauração ─────────────────────────────
// Décima sétima e ÚLTIMA fatia extraída de server.js (ver
// lib/rotas/operadores.js pro padrão completo) — e de propósito a última:
// é o domínio de MAIOR risco do sistema, já que POST /restaurar-backup-geral
// pode sobrescrever o próprio código do servidor. Só foi fatiado depois do
// padrão já estar validado em 16 domínios mais simples antes dele.
//
// Rotas cobertas: POST /mesclar-backup-dados, GET /backup-geral,
// GET /backups-automaticos, GET /backups-automaticos/:nome,
// POST /restaurar-backup-dados, POST /restaurar-backup-geral.
//
// DIFERENTE de todos os módulos anteriores desta série: este também expõe
// `executarBackupAutomaticoSeNecessario` — o job do backup automático
// diário, chamado por um setInterval em server.js, NUNCA por uma rota HTTP.
// Por isso a factory devolve um OBJETO { tentar, executarBackupAutomaticoSeNecessario },
// não só a função tentar() como os módulos anteriores.
//
// Todos os helpers deste domínio (parseArquivoBackupDados,
// gerarZipDadosServidor, gerarBackupGeral, adicionarPastaAoZip,
// caminhoSeguroDentroDoProjeto, validarSintaxeJS, caminhoArquivoDb, etc.)
// são EXCLUSIVOS daqui — nenhum outro domínio os usa — então moveram
// junto, ao contrário de outras fatias que precisaram deixar helpers
// compartilhados em server.js. As únicas dependências injetadas de fora
// são: `db`, `auth`, `sessao` (login/senha), `todayBrasiliaServer`/
// `horaMinutoBrasiliaServer` (relógio), `lerContadorTracosHoje` (contador
// do dia) e `recalcularFilaNaoAvaliadasApartirDoSql` (também chamada na
// migração de boot, em server.js).

module.exports = function criarRotasBackup({
  db, fs, path, JSZip,
  ROOT_DIR, DB_DIR, SECURITY_PATH, USUARIOS_PATH,
  auth, sessao,
  todayBrasiliaServer, horaMinutoBrasiliaServer,
  lerContadorTracosHoje, recalcularFilaNaoAvaliadasApartirDoSql,
}) {

  // Resolve o caminho real, no disco, de um arquivo de public/db/ — quase
  // todos vivem em DB_DIR, mas security.json e usuarios.json são exceção
  // (ver PRIVATE_DIR/SECURITY_PATH/USUARIOS_PATH). Centralizar essa
  // decisão aqui evita ter que repetir o "if (nome === ...)" em cada rota
  // de backup/restauração que itera a lista de arquivos genericamente.
  function caminhoArquivoDb(nome) {
    if (nome === 'security.json') return SECURITY_PATH;
    if (nome === 'usuarios.json') return USUARIOS_PATH;
    return path.join(DB_DIR, nome);
  }

  // ─── Validação de formato dos arquivos de public/db/ (e private/) — usada
  // ao restaurar um backup, pra recusar arquivo errado/corrompido antes de
  // gravar no disco.
  //
  // Separado em duas listas (ver conversa que motivou a reformulação de
  // Backup de Dados vs Backup Geral):
  //   - VALIDADORES_DADOS_PRODUCAO: só dados de produção da fábrica —
  //     operações, traços, paradas, avaliações de qualidade etc. "O que a
  //     fábrica produziu", sem nada sobre QUEM usa o sistema.
  //   - VALIDADORES_EXTRA_GERAL: config.json (baterias, tipos de
  //     montagem, automação) + identidade/acesso (security.json,
  //     usuarios.json) — some do Backup de Dados, mas ENTRA no Backup
  //     Geral, somado à lista acima (ver VALIDADORES_BACKUP_GERAL, mais
  //     abaixo).
  const VALIDADORES_DADOS_PRODUCAO = {
    'contador_tracos.json':   v => v && typeof v === 'object' && !Array.isArray(v),
    'historico.json':          v => Array.isArray(v),
    'historico_edicoes.json': v => Array.isArray(v),
    'relatorio_edicoes.json':  v => Array.isArray(v),
    'relatorio_injecao.json': v => Array.isArray(v),
    'sobra.json':              v => v && typeof v === 'object',
    'paradas.json':            v => Array.isArray(v),
    'ajustes_tracos.json':    v => Array.isArray(v),
    'metas.json':              v => v && typeof v === 'object' && !Array.isArray(v),
    'bercos_visuais.json':       v => Array.isArray(v),
    'avaliacoes_qualidade.json': v => Array.isArray(v),
    'operacoes_avaliadas.json':  v => Array.isArray(v),
    'operacoes_nao_avaliadas.json': v => Array.isArray(v),
  };
  const VALIDADORES_EXTRA_GERAL = {
    'config.json':     v => v && typeof v === 'object' && !Array.isArray(v),
    'security.json':   v => v && typeof v === 'object' && typeof v.passwordHash === 'string',
    'usuarios.json':   v => Array.isArray(v),
  };
  const VALIDADORES_BACKUP_GERAL = { ...VALIDADORES_DADOS_PRODUCAO, ...VALIDADORES_EXTRA_GERAL };

  // Nome mantido por compatibilidade com o resto do arquivo (usado em
  // vários pontos abaixo, ex: parseArquivoBackupDados, /mesclar-backup-dados)
  // — sempre foi (e continua sendo) a lista do Backup de DADOS.
  const VALIDADORES_BACKUP_DADOS = VALIDADORES_DADOS_PRODUCAO;

  // Alguns desses arquivos legitimamente ficam vazios (0 bytes) até o app
  // inicializá-los na primeira vez que precisa deles. Aqui dizemos o que um
  // arquivo vazio "significa" pra cada um, em vez de recusar como JSON
  // inválido. config.json e security.json ficam de fora de propósito:
  // vazio ali é sempre um problema real.
  const DEFAULT_SE_VAZIO_BACKUP_DADOS = {
    'contador_tracos.json': {},
    'historico.json': [],
    'historico_edicoes.json': [],
    'relatorio_edicoes.json': [],
    'relatorio_injecao.json': [],
    'sobra.json': {},
    'paradas.json': [],
    'ajustes_tracos.json': [],
    'bercos_visuais.json': [],
    'avaliacoes_qualidade.json': [],
    'operacoes_avaliadas.json': [],
    'operacoes_nao_avaliadas.json': [],
    'usuarios.json': [],
  };

  function parseArquivoBackupDados(nome, texto) {
    if (texto.trim() === '' && DEFAULT_SE_VAZIO_BACKUP_DADOS.hasOwnProperty(nome)) {
      return DEFAULT_SE_VAZIO_BACKUP_DADOS[nome];
    }
    return JSON.parse(texto);
  }

  // ─── Backup automático diário (dados) ──────────────────────────────────────
  const DIR_BACKUPS_AUTO = path.join(ROOT_DIR, 'backups-automaticos');
  const PREFIXO_BACKUP_AUTO = 'backup-dados_';
  const RETENCAO_DIAS_BACKUP_AUTO = 3;
  const HORA_CORTE_BACKUP_AUTO = 23;
  const MINUTO_CORTE_BACKUP_AUTO = 50;

  // Monta um zip com os arquivos de `listaDeArquivos` (chaves de
  // VALIDADORES_DADOS_PRODUCAO, ou VALIDADORES_BACKUP_GERAL) — tabelas SQL
  // são exportadas pro formato JSON de sempre (compatibilidade com
  // backups antigos, versão pré-SQLite); o resto é lido direto do disco
  // via caminhoArquivoDb. Função genérica usada tanto por
  // gerarZipDadosServidor() (Backup de Dados) quanto por
  // gerarZipBackupGeral() (Backup Geral) — mesma lógica de exportação,
  // só muda QUAIS arquivos entram.
  async function _gerarZipComArquivos(listaDeArquivos) {
    // Garante que tudo que está no WAL (write-ahead log — mudanças ainda
    // não "commitadas" fisicamente no arquivo .db principal) seja
    // escrito antes de ler as tabelas abaixo — sem isso, um backup tirado
    // logo depois de uma escrita recente poderia não refletir a mudança
    // mais nova.
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { console.error('[backup] Falha no checkpoint do WAL:', e.message); }

    const zip = new JSZip();
    listaDeArquivos.forEach(nome => {
      try {
        if (nome === 'historico.json') {
          const rows = db.prepare('SELECT * FROM operacoes ORDER BY data ASC, criado_em ASC').all();
          zip.file(nome, JSON.stringify(rows.map(db.rowParaOperacao), null, 2));
        } else if (nome === 'historico_edicoes.json') {
          const rows = db.prepare('SELECT id_operacao, data_edicao, campos_alterados FROM edicoes_operacao ORDER BY id ASC').all();
          zip.file(nome, JSON.stringify(rows.map(r => ({ ...r, campos_alterados: JSON.parse(r.campos_alterados) })), null, 2));
        } else if (nome === 'paradas.json') {
          const rows = db.prepare('SELECT * FROM paradas ORDER BY inicio ASC').all();
          zip.file(nome, JSON.stringify(rows.map(db.rowParaParada), null, 2));
        } else if (nome === 'sobra.json') {
          const row = db.prepare('SELECT * FROM sobra WHERE id = 1').get();
          zip.file(nome, JSON.stringify(db.rowParaSobra(row), null, 2));
        } else if (nome === 'contador_tracos.json') {
          zip.file(nome, JSON.stringify(lerContadorTracosHoje(false), null, 2));
        } else if (nome === 'relatorio_injecao.json') {
          zip.file(nome, JSON.stringify(db.todosOsTracos(), null, 2));
        } else if (nome === 'ajustes_tracos.json') {
          zip.file(nome, JSON.stringify(db.todosOsAjustesTracosJSON(), null, 2));
        } else if (nome === 'relatorio_edicoes.json') {
          const rows = db.prepare('SELECT id_traco, id_operacao, data_edicao, campos_alterados FROM edicoes_traco ORDER BY id ASC').all();
          zip.file(nome, JSON.stringify(rows.map(r => ({ ...r, campos_alterados: JSON.parse(r.campos_alterados) })), null, 2));
        } else if (nome === 'bercos_visuais.json') {
          zip.file(nome, JSON.stringify(db.todosOsBercosVisuais(), null, 2));
        } else if (nome === 'avaliacoes_qualidade.json') {
          zip.file(nome, JSON.stringify(db.listarAvaliacoesQualidade(), null, 2));
        } else if (nome === 'operacoes_avaliadas.json') {
          zip.file(nome, JSON.stringify(db.todosOsOperacoesAvaliadas(), null, 2));
        } else {
          zip.file(nome, fs.readFileSync(caminhoArquivoDb(nome)));
        }
      } catch (_) {
        // Arquivo/tabela pode não existir/estar vazia ainda — ok, só não entra no zip.
      }
    });
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  // Backup de DADOS — só produção da fábrica (operações, traços, paradas,
  // avaliações de qualidade etc). Sem nada sobre configuração do sistema
  // nem QUEM usa o sistema (ver Backup Geral, abaixo).
  function gerarZipDadosServidor() {
    return _gerarZipComArquivos(Object.keys(VALIDADORES_DADOS_PRODUCAO));
  }

  // Backup GERAL — dados de produção + config.json (baterias, tipos de
  // montagem, automação) + identidade/acesso (security.json — senha do
  // Administrador Master em hash; usuarios.json — usuários cadastrados,
  // senhas em hash, perfis, atalhos).
  // Reformulado (ver conversa que motivou a mudança): ANTES incluía o
  // PROJETO INTEIRO (código-fonte, node_modules exceto) — isso saiu, já
  // que código-fonte tem controle de versão próprio (Git) e não precisa
  // duplicar aqui; um backup não é (nem deveria ser) o mecanismo de
  // recuperar código.
  function gerarZipBackupGeral() {
    return _gerarZipComArquivos(Object.keys(VALIDADORES_BACKUP_GERAL));
  }

  function _rotacionarBackupsAutomaticos() {
    if (!fs.existsSync(DIR_BACKUPS_AUTO)) return;
    const arquivos = fs.readdirSync(DIR_BACKUPS_AUTO)
      .filter(f => f.startsWith(PREFIXO_BACKUP_AUTO) && f.endsWith('.zip'))
      .sort();

    const excedentes = arquivos.length - RETENCAO_DIAS_BACKUP_AUTO;
    if (excedentes > 0) {
      arquivos.slice(0, excedentes).forEach(nome => {
        try {
          fs.unlinkSync(path.join(DIR_BACKUPS_AUTO, nome));
          console.log(`[backup automático] removido (mantém só os últimos ${RETENCAO_DIAS_BACKUP_AUTO} dias): ${nome}`);
        } catch (_) { /* não trava o resto por causa de um arquivo */ }
      });
    }
  }

  function _houveOperacaoHoje(hoje) {
    try {
      const row = db.prepare('SELECT 1 FROM operacoes WHERE data = ? LIMIT 1').get(hoje);
      return !!row;
    } catch (_) {
      return true;
    }
  }

  async function executarBackupAutomaticoSeNecessario() {
    try {
      const hoje = todayBrasiliaServer();
      const nomeArquivoHoje = `${PREFIXO_BACKUP_AUTO}${hoje}.zip`;
      const caminhoHoje = path.join(DIR_BACKUPS_AUTO, nomeArquivoHoje);

      if (fs.existsSync(caminhoHoje)) return;

      const { hora, minuto } = horaMinutoBrasiliaServer();
      const passouDoCorte = hora > HORA_CORTE_BACKUP_AUTO ||
        (hora === HORA_CORTE_BACKUP_AUTO && minuto >= MINUTO_CORTE_BACKUP_AUTO);
      if (!passouDoCorte) return;

      if (!_houveOperacaoHoje(hoje)) {
        console.log(`[backup automático] nenhuma operação registrada em ${hoje} — backup não gerado.`);
        return;
      }

      fs.mkdirSync(DIR_BACKUPS_AUTO, { recursive: true });
      const buffer = await gerarZipDadosServidor();
      fs.writeFileSync(caminhoHoje, buffer);
      console.log(`[backup automático] criado: ${nomeArquivoHoje}`);

      _rotacionarBackupsAutomaticos();
    } catch (e) {
      console.error('[backup automático] falhou:', e.message);
    }
  }

  function tentar(req, res, urlPath, queryParams) {

    if (req.method === 'POST' && urlPath === '/mesclar-backup-dados') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const { senha, arquivos } = payload;

          if (typeof senha !== 'string' || !senha) {
            throw new Error('Senha de administrador obrigatória.');
          }
          if (auth.rateLimitEstaBloqueado(req)) {
            throw new Error(`Muitas tentativas erradas. Tente de novo em ${Math.ceil(auth.rateLimitSegundosRestantes(req) / 60)} min.`);
          }
          const security = auth.lerSecurity();
          if (!auth.validarSegredo(senha, security.passwordHash || auth.HASH_FALLBACK, 'passwordHash')) {
            auth.rateLimitRegistrarFalha(req);
            throw new Error('Senha incorreta.');
          }
          auth.rateLimitRegistrarSucesso(req);

          if (!arquivos || typeof arquivos !== 'object') {
            throw new Error('Payload inválido: "arquivos" ausente.');
          }

          const MESCLAVEIS = ['historico.json', 'historico_edicoes.json', 'relatorio_injecao.json', 'ajustes_tracos.json', 'paradas.json'];
          const presentes = MESCLAVEIS.filter(nome => typeof arquivos[nome] === 'string');
          if (!presentes.length) {
            throw new Error('Nenhum arquivo mesclável encontrado no backup (historico.json, relatorio_injecao.json, ajustes_tracos.json ou paradas.json).');
          }

          const conteudo = {};
          for (const nome of presentes) {
            let valor;
            try {
              valor = parseArquivoBackupDados(nome, arquivos[nome]);
            } catch (_) {
              throw new Error(`"${nome}" não é um JSON válido.`);
            }
            if (!VALIDADORES_BACKUP_DADOS[nome](valor)) {
              throw new Error(`"${nome}" não tem o formato esperado.`);
            }
            conteudo[nome] = valor;
          }

          const resultado = {
            operacoes: { inseridos: 0, duplicatas: 0 },
            edicoes_operacao: { inseridos: 0 },
            tracos: { inseridos: 0, duplicatas: 0 },
            paradas: { inseridos: 0, duplicatas: 0 },
          };
          const idsOperacoesImportadas = new Set();

          db.transaction(() => {
            if (conteudo['historico.json']) {
              const existentesRows = db.prepare('SELECT id, data, id_bateria, turno FROM operacoes').all();
              const existentes = new Set(existentesRows.map(r => r.id || (r.data + '|' + r.id_bateria + '|' + r.turno)));
              const inserirOperacao = db.prepare(db.SQL_INSERIR_OPERACAO);

              for (const r of conteudo['historico.json']) {
                const chave = r.id || (r.data + '|' + r.id_bateria + '|' + r.turno);
                if (existentes.has(chave)) { resultado.operacoes.duplicatas++; continue; }
                inserirOperacao.run({ ...db.operacaoParaRow(r), modo_teste: 0, criado_em: r.fim || r.inicio || new Date().toISOString() });
                existentes.add(chave);
                if (r.id) idsOperacoesImportadas.add(r.id);
                resultado.operacoes.inseridos++;
              }
            }

            if (conteudo['historico_edicoes.json']) {
              const existentesEdicoes = new Set(
                db.prepare(`SELECT id_operacao || '|' || data_edicao AS chave FROM edicoes_operacao`).all().map(r => r.chave)
              );
              const inserirEdicao = db.prepare('INSERT INTO edicoes_operacao (id_operacao, data_edicao, campos_alterados) VALUES (?, ?, ?)');

              for (const e of conteudo['historico_edicoes.json']) {
                if (!idsOperacoesImportadas.has(e.id_operacao)) continue;
                const chave = e.id_operacao + '|' + e.data_edicao;
                if (existentesEdicoes.has(chave)) continue;
                inserirEdicao.run(e.id_operacao, e.data_edicao, JSON.stringify(e.campos_alterados || []));
                existentesEdicoes.add(chave);
                resultado.edicoes_operacao.inseridos++;
              }
            }

            if (conteudo['relatorio_injecao.json']) {
              const ajustes = conteudo['ajustes_tracos.json'] || [];
              const r = db.mesclarTracosEAjustes(conteudo['relatorio_injecao.json'], ajustes);
              resultado.tracos.inseridos = r.tracosInseridos;
              resultado.tracos.duplicatas = r.tracosDuplicados;
            }

            if (conteudo['paradas.json']) {
              const existentesParadas = new Set(db.prepare('SELECT id FROM paradas').all().map(r => r.id));
              const inserirParada = db.prepare(db.SQL_INSERIR_PARADA);
              for (const p of conteudo['paradas.json']) {
                if (existentesParadas.has(p.id)) { resultado.paradas.duplicatas++; continue; }
                inserirParada.run(db.paradaParaRow(p));
                existentesParadas.add(p.id);
                resultado.paradas.inseridos++;
              }
            }
          })();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, resultado }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // ── GET /backup-dados: Backup de DADOS — gerado no SERVIDOR (ver
    // gerarZipDadosServidor, acima), diferente de antes (montado no
    // navegador via fetch de cada GET /db/*.json — ver LW.gerarBackupDados,
    // data.js, agora removida). Reaproveita a MESMA lista/lógica que o
    // backup automático diário já usava — sem duplicar a definição de
    // "quais arquivos são dados de produção" em dois lugares (servidor E
    // front), risco real de as duas listas ficarem dessincronizadas com
    // o tempo. Só dados de produção — sem config.json, security.json,
    // usuarios.json (esses 3 são exclusivos do Backup Geral, ver
    // GET /backup-geral, logo abaixo).
    if (req.method === 'GET' && urlPath === '/backup-dados') {
      if (!sessao.requestTemSessaoValida(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
        return true;
      }
      gerarZipDadosServidor().then(buffer => {
        const nomeArquivo = `lightwall_backup_dados_${todayBrasiliaServer()}.zip`;
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${nomeArquivo}"`,
          'Content-Length': buffer.length,
        });
        res.end(buffer);
      }).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      });
      return true;
    }

    if (req.method === 'GET' && urlPath === '/backup-geral') {
      if (!sessao.requestTemSessaoValida(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
        return true;
      }
      gerarZipBackupGeral().then(buffer => {
        const nomeArquivo = `lightwall_backup_geral_${todayBrasiliaServer()}.zip`;
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${nomeArquivo}"`,
          'Content-Length': buffer.length,
        });
        res.end(buffer);
      }).catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      });
      return true;
    }

    if (req.method === 'GET' && urlPath === '/backups-automaticos') {
      if (!sessao.requestTemSessaoValida(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
        return true;
      }
      try {
        fs.mkdirSync(DIR_BACKUPS_AUTO, { recursive: true });
        const backups = fs.readdirSync(DIR_BACKUPS_AUTO)
          .filter(f => f.startsWith(PREFIXO_BACKUP_AUTO) && f.endsWith('.zip'))
          .sort()
          .reverse()
          .map(nome => {
            const stat = fs.statSync(path.join(DIR_BACKUPS_AUTO, nome));
            return { nome, data: nome.slice(PREFIXO_BACKUP_AUTO.length, -4), tamanho: stat.size };
          });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, backups }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    if (req.method === 'GET' && urlPath.startsWith('/backups-automaticos/')) {
      if (!sessao.requestTemSessaoValida(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
        return true;
      }
      const nome = decodeURIComponent(urlPath.slice('/backups-automaticos/'.length));
      if (!/^backup-dados_\d{4}-\d{2}-\d{2}\.zip$/.test(nome)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: 'Nome de arquivo inválido.' }));
        return true;
      }
      fs.readFile(path.join(DIR_BACKUPS_AUTO, nome), (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${nome}"`,
        });
        res.end(data);
      });
      return true;
    }

    if (req.method === 'POST' && urlPath === '/restaurar-backup-dados') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const { senha, arquivos } = payload;

          if (typeof senha !== 'string' || !senha) {
            throw new Error('Senha de administrador obrigatória.');
          }
          if (auth.rateLimitEstaBloqueado(req)) {
            throw new Error(`Muitas tentativas erradas. Tente de novo em ${Math.ceil(auth.rateLimitSegundosRestantes(req) / 60)} min.`);
          }
          const security = auth.lerSecurity();
          const hashEsperado = security.passwordHash || auth.HASH_FALLBACK;
          if (!auth.validarSegredo(senha, hashEsperado, 'passwordHash')) {
            auth.rateLimitRegistrarFalha(req);
            throw new Error('Senha incorreta.');
          }
          auth.rateLimitRegistrarSucesso(req);

          if (!arquivos || typeof arquivos !== 'object') {
            throw new Error('Payload inválido: "arquivos" ausente.');
          }

          const { dirSeguranca } = _restaurarArquivosDeDados(arquivos, 'pre-restore');

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            backupSeguranca: path.relative(ROOT_DIR, dirSeguranca),
          }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

  // ─── Restauração dos arquivos de DADOS DE PRODUÇÃO (tabelas SQL) ─────────
  // Extraído pra função própria (ver conversa que motivou a reformulação
  // de Backup Geral): usada tanto por POST /restaurar-backup-dados quanto
  // por POST /restaurar-backup-geral — a segunda restaura os MESMOS dados
  // de produção que a primeira, só que além deles também trata
  // config.json/security.json/usuarios.json (ver
  // _restaurarArquivosExtraDoGeral, abaixo). Sem essa extração, a lógica
  // de "qual tabela recebe qual arquivo, com qual query" teria que ser
  // mantida em dois lugares idênticos — risco real de uma rota ficar
  // desatualizada em relação à outra depois de qualquer mudança futura
  // de esquema.
  //
  // `arquivos` é o objeto bruto do payload ({nome: textoJSON}); devolve
  // {presentes, dirSeguranca} — dirSeguranca é o backup de segurança
  // (pre-restore) gravado ANTES de qualquer escrita, útil pra quem chama
  // devolver na resposta.
  function _restaurarArquivosDeDados(arquivos, prefixoDirSeguranca) {
    const esperados = Object.keys(VALIDADORES_DADOS_PRODUCAO);
    const OPCIONAIS_BACKUP_DADOS = ['bercos_visuais.json', 'avaliacoes_qualidade.json', 'operacoes_avaliadas.json', 'operacoes_nao_avaliadas.json'];
    const obrigatorios = esperados.filter(n => !OPCIONAIS_BACKUP_DADOS.includes(n));
    const faltando = obrigatorios.filter(nome => typeof arquivos[nome] !== 'string');
    if (faltando.length) {
      throw new Error('Backup incompleto — faltam: ' + faltando.join(', '));
    }
    const presentes = esperados.filter(nome => typeof arquivos[nome] === 'string');
    const textosValidados = {};
    for (const nome of presentes) {
      let valor;
      try {
        valor = parseArquivoBackupDados(nome, arquivos[nome]);
      } catch (_) {
        throw new Error(`"${nome}" não é um JSON válido.`);
      }
      if (!VALIDADORES_DADOS_PRODUCAO[nome](valor)) {
        throw new Error(`"${nome}" não tem o formato esperado.`);
      }
      textosValidados[nome] = arquivos[nome];
    }

    const carimbo = todayBrasiliaServer() + '_' + Date.now();
    const dirSeguranca = path.join(ROOT_DIR, 'backups-seguranca', prefixoDirSeguranca + '_' + carimbo);
    fs.mkdirSync(dirSeguranca, { recursive: true });
    for (const nome of esperados) {
      try {
        if (nome === 'historico.json') {
          const rows = db.prepare('SELECT * FROM operacoes ORDER BY data ASC, criado_em ASC').all();
          fs.writeFileSync(path.join(dirSeguranca, nome), JSON.stringify(rows.map(db.rowParaOperacao), null, 2), 'utf8');
        } else if (nome === 'historico_edicoes.json') {
          const rows = db.prepare('SELECT id_operacao, data_edicao, campos_alterados FROM edicoes_operacao ORDER BY id ASC').all();
          fs.writeFileSync(path.join(dirSeguranca, nome), JSON.stringify(rows.map(r => ({ ...r, campos_alterados: JSON.parse(r.campos_alterados) })), null, 2), 'utf8');
        } else if (nome === 'paradas.json') {
          const rows = db.prepare('SELECT * FROM paradas ORDER BY inicio ASC').all();
          fs.writeFileSync(path.join(dirSeguranca, nome), JSON.stringify(rows.map(db.rowParaParada), null, 2), 'utf8');
        } else if (nome === 'sobra.json') {
          const row = db.prepare('SELECT * FROM sobra WHERE id = 1').get();
          fs.writeFileSync(path.join(dirSeguranca, nome), JSON.stringify(db.rowParaSobra(row), null, 2), 'utf8');
        } else if (nome === 'contador_tracos.json') {
          fs.writeFileSync(path.join(dirSeguranca, nome), JSON.stringify(lerContadorTracosHoje(false), null, 2), 'utf8');
        } else if (nome === 'relatorio_injecao.json') {
          fs.writeFileSync(path.join(dirSeguranca, nome), JSON.stringify(db.todosOsTracos(), null, 2), 'utf8');
        } else if (nome === 'ajustes_tracos.json') {
          fs.writeFileSync(path.join(dirSeguranca, nome), JSON.stringify(db.todosOsAjustesTracosJSON(), null, 2), 'utf8');
        } else if (nome === 'relatorio_edicoes.json') {
          const rows = db.prepare('SELECT id_traco, id_operacao, data_edicao, campos_alterados FROM edicoes_traco ORDER BY id ASC').all();
          fs.writeFileSync(path.join(dirSeguranca, nome), JSON.stringify(rows.map(r => ({ ...r, campos_alterados: JSON.parse(r.campos_alterados) })), null, 2), 'utf8');
        } else if (nome === 'bercos_visuais.json') {
          fs.writeFileSync(path.join(dirSeguranca, nome), JSON.stringify(db.todosOsBercosVisuais(), null, 2), 'utf8');
        } else if (nome === 'avaliacoes_qualidade.json') {
          fs.writeFileSync(path.join(dirSeguranca, nome), JSON.stringify(db.listarAvaliacoesQualidade(), null, 2), 'utf8');
        } else if (nome === 'operacoes_avaliadas.json') {
          fs.writeFileSync(path.join(dirSeguranca, nome), JSON.stringify(db.todosOsOperacoesAvaliadas(), null, 2), 'utf8');
        } else {
          fs.copyFileSync(caminhoArquivoDb(nome), path.join(dirSeguranca, nome));
        }
      } catch (_) {
        // Arquivo/tabela pode estar vazio ainda (ex.: primeira execução) — ok.
      }
    }

    const nomesArquivo = esperados.filter(n =>
      presentes.includes(n) &&
      !['historico.json', 'historico_edicoes.json', 'paradas.json', 'sobra.json', 'contador_tracos.json',
        'relatorio_injecao.json', 'ajustes_tracos.json', 'relatorio_edicoes.json',
        'bercos_visuais.json', 'avaliacoes_qualidade.json', 'operacoes_avaliadas.json'].includes(n));
    const pendentes = nomesArquivo.map(nome => ({
      tmp: caminhoArquivoDb(nome) + '.tmp',
      destino: caminhoArquivoDb(nome),
      texto: textosValidados[nome],
    }));
    pendentes.forEach(p => fs.writeFileSync(p.tmp, p.texto, 'utf8'));
    pendentes.forEach(p => fs.renameSync(p.tmp, p.destino));

    db.transaction(() => {
      db.prepare('DELETE FROM avaliacao_paineis').run();
      db.prepare('DELETE FROM avaliacoes_qualidade').run();
      db.prepare('DELETE FROM bercos_visuais').run();
      db.prepare('DELETE FROM operacoes_avaliadas').run();
    })();

    if (presentes.includes('historico.json')) {
      const novoHistorico = JSON.parse(textosValidados['historico.json']);
      const inserirOperacao = db.prepare(db.SQL_INSERIR_OPERACAO);
      db.transaction(() => {
        db.prepare('DELETE FROM operacoes').run();
        for (const r of novoHistorico) {
          inserirOperacao.run({ ...db.operacaoParaRow(r), modo_teste: 0, criado_em: r.fim || r.inicio || new Date().toISOString() });
        }
      })();
    }
    if (presentes.includes('historico_edicoes.json')) {
      const novasEdicoes = JSON.parse(textosValidados['historico_edicoes.json']);
      const inserirEdicao = db.prepare('INSERT INTO edicoes_operacao (id_operacao, data_edicao, campos_alterados) VALUES (?, ?, ?)');
      db.transaction(() => {
        db.prepare('DELETE FROM edicoes_operacao').run();
        for (const e of novasEdicoes) {
          inserirEdicao.run(e.id_operacao, e.data_edicao, JSON.stringify(e.campos_alterados || []));
        }
      })();
    }
    if (presentes.includes('relatorio_edicoes.json')) {
      const novasEdicoesTraco = JSON.parse(textosValidados['relatorio_edicoes.json']);
      const inserirEdicaoTraco = db.prepare('INSERT INTO edicoes_traco (id_traco, id_operacao, data_edicao, campos_alterados) VALUES (?, ?, ?, ?)');
      db.transaction(() => {
        db.prepare('DELETE FROM edicoes_traco').run();
        for (const e of novasEdicoesTraco) {
          inserirEdicaoTraco.run(e.id_traco, e.id_operacao || null, e.data_edicao, JSON.stringify(e.campos_alterados || []));
        }
      })();
    }
    if (presentes.includes('paradas.json')) {
      const novasParadas = JSON.parse(textosValidados['paradas.json']);
      const inserirParada = db.prepare(db.SQL_INSERIR_PARADA);
      db.transaction(() => {
        db.prepare('DELETE FROM paradas').run();
        for (const p of novasParadas) inserirParada.run(db.paradaParaRow(p));
      })();
    }
    if (presentes.includes('sobra.json')) {
      const novaSobra = JSON.parse(textosValidados['sobra.json']);
      if (novaSobra && Object.keys(novaSobra).length) {
        db.prepare(db.SQL_UPSERT_SOBRA).run(db.sobraParaRow(novaSobra));
      } else {
        db.prepare('DELETE FROM sobra').run();
      }
    }
    if (presentes.includes('contador_tracos.json')) {
      const novoContador = JSON.parse(textosValidados['contador_tracos.json']);
      if (novoContador && novoContador.data) {
        db.prepare(`
          INSERT INTO contador_tracos (data, total) VALUES (?, ?)
          ON CONFLICT(data) DO UPDATE SET total = ?
        `).run(novoContador.data, novoContador.total || 0, novoContador.total || 0);
      }
    }
    if (presentes.includes('relatorio_injecao.json')) {
      const novoRelatorio = JSON.parse(textosValidados['relatorio_injecao.json']);
      const novosAjustes = presentes.includes('ajustes_tracos.json')
        ? JSON.parse(textosValidados['ajustes_tracos.json'])
        : db.todosOsAjustesTracosJSON();
      db.transaction(() => db.substituirTracosEAjustes(novoRelatorio, novosAjustes))();
    } else if (presentes.includes('ajustes_tracos.json')) {
      const novoRelatorioAtual = db.todosOsTracos();
      const novosAjustes = JSON.parse(textosValidados['ajustes_tracos.json']);
      db.transaction(() => db.substituirTracosEAjustes(novoRelatorioAtual, novosAjustes))();
    }
    if (presentes.includes('bercos_visuais.json')) {
      const novosBercosVisuais = JSON.parse(textosValidados['bercos_visuais.json']);
      db.transaction(() => db.substituirBercosVisuais(novosBercosVisuais))();
    }
    if (presentes.includes('avaliacoes_qualidade.json')) {
      const novasAvaliacoes = JSON.parse(textosValidados['avaliacoes_qualidade.json']);
      db.transaction(() => db.substituirAvaliacoesQualidade(novasAvaliacoes))();
    }
    if (presentes.includes('operacoes_avaliadas.json')) {
      const novasOperacoesAvaliadas = JSON.parse(textosValidados['operacoes_avaliadas.json']);
      db.transaction(() => db.substituirOperacoesAvaliadas(novasOperacoesAvaliadas))();
    }
    if (!presentes.includes('operacoes_nao_avaliadas.json')
      && (presentes.includes('historico.json') || presentes.includes('operacoes_avaliadas.json'))) {
      try { recalcularFilaNaoAvaliadasApartirDoSql(); }
      catch (e) { console.error('Falha ao recalcular a fila de avaliação depois da restauração:', e.message); }
    }

    return { presentes, dirSeguranca };
  }

  // ─── Restauração dos arquivos EXTRA do Backup Geral (config/identidade) ──
  // Diferente de _restaurarArquivosDeDados (tabelas SQL, muita lógica por
  // arquivo): estes 3 são leitura/escrita direta de arquivo, sem SQL —
  // bem mais simples. security.json/usuarios.json são OPCIONAIS e
  // PRESERVADOS se ausentes do backup (ver conversa que motivou isso:
  // restaurar um backup do sistema ANTIGO, que nunca teve esses 2
  // arquivos, não pode apagar os usuários já cadastrados no sistema
  // atual — imagine um Admin restaurando um backup de dados antigos só
  // pra recuperar histórico de produção, sem querer mexer em quem tem
  // acesso ao sistema). config.json continua OBRIGATÓRIO (não existir de
  // jeito nenhum no sistema, nem antigo nem novo, indicaria um backup
  // malformado).
  function _restaurarArquivosExtraDoGeral(arquivos, dirSeguranca) {
    const OPCIONAIS_E_PRESERVADOS = ['security.json', 'usuarios.json'];
    const faltando = Object.keys(VALIDADORES_EXTRA_GERAL)
      .filter(n => !OPCIONAIS_E_PRESERVADOS.includes(n))
      .filter(n => typeof arquivos[n] !== 'string');
    if (faltando.length) {
      throw new Error('Backup incompleto — faltam: ' + faltando.join(', '));
    }

    const presentes = Object.keys(VALIDADORES_EXTRA_GERAL).filter(n => typeof arquivos[n] === 'string');
    const textosValidados = {};
    for (const nome of presentes) {
      let valor;
      try {
        valor = parseArquivoBackupDados(nome, arquivos[nome]);
      } catch (_) {
        throw new Error(`"${nome}" não é um JSON válido.`);
      }
      if (!VALIDADORES_EXTRA_GERAL[nome](valor)) {
        throw new Error(`"${nome}" não tem o formato esperado.`);
      }
      textosValidados[nome] = arquivos[nome];
    }

    // Backup de segurança dos 3 arquivos extra — mesmo dirSeguranca já
    // criado por _restaurarArquivosDeDados, só adiciona os arquivos que
    // faltavam nele.
    Object.keys(VALIDADORES_EXTRA_GERAL).forEach(nome => {
      try {
        fs.copyFileSync(caminhoArquivoDb(nome), path.join(dirSeguranca, nome));
      } catch (_) {
        // Arquivo pode não existir ainda no sistema atual (ex: nenhum
        // usuário cadastrado ainda) — ok, só não entra no backup de segurança.
      }
    });

    const pendentes = presentes.map(nome => ({
      tmp: caminhoArquivoDb(nome) + '.tmp',
      destino: caminhoArquivoDb(nome),
      texto: textosValidados[nome],
    }));
    pendentes.forEach(p => fs.writeFileSync(p.tmp, p.texto, 'utf8'));
    pendentes.forEach(p => fs.renameSync(p.tmp, p.destino));

    return { presentes };
  }



    if (req.method === 'POST' && urlPath === '/restaurar-backup-geral') {
      let body = '';
      let tamanho = 0;
      let abortado = false;
      const LIMITE_BYTES = 80 * 1024 * 1024;

      req.on('data', chunk => {
        if (abortado) return;
        tamanho += chunk.length;
        if (tamanho > LIMITE_BYTES) {
          abortado = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: 'Backup muito grande — recusado por segurança.' }));
          req.destroy();
          return;
        }
        body += chunk;
      });

      req.on('end', () => {
        if (abortado) return;
        try {
          const payload = JSON.parse(body);
          const { senha, confirmacao, arquivos } = payload;

          if (typeof senha !== 'string' || !senha) {
            throw new Error('Senha de administrador obrigatória.');
          }
          if (auth.rateLimitEstaBloqueado(req)) {
            throw new Error(`Muitas tentativas erradas. Tente de novo em ${Math.ceil(auth.rateLimitSegundosRestantes(req) / 60)} min.`);
          }
          const security = auth.lerSecurity();
          if (!auth.validarSegredo(senha, security.passwordHash || auth.HASH_FALLBACK, 'passwordHash')) {
            auth.rateLimitRegistrarFalha(req);
            throw new Error('Senha incorreta.');
          }
          auth.rateLimitRegistrarSucesso(req);
          if (confirmacao !== 'RESTAURAR TUDO') {
            throw new Error('Frase de confirmação incorreta.');
          }

          if (!arquivos || typeof arquivos !== 'object' || Array.isArray(arquivos)) {
            throw new Error('Payload inválido: "arquivos" ausente.');
          }

          // Reaproveita a mesma lógica de restauração de dados de
          // POST /restaurar-backup-dados (ver _restaurarArquivosDeDados,
          // acima) — o Backup Geral inclui TODOS os dados de produção que
          // o Backup de Dados tem, então não faz sentido duplicar essa
          // lógica aqui. O dirSeguranca criado por ela é reaproveitado
          // pelos 3 arquivos extra logo abaixo.
          const { presentes: presentesDados, dirSeguranca } = _restaurarArquivosDeDados(arquivos, 'pre-restore-geral');

          // Os 3 arquivos extra do Geral (config/identidade) — ver
          // _restaurarArquivosExtraDoGeral: security.json/usuarios.json
          // são OPCIONAIS e PRESERVADOS se ausentes (ex: restaurando um
          // backup do sistema ANTIGO, que nunca teve esses arquivos —
          // não pode apagar os usuários já cadastrados no sistema atual).
          const { presentes: presentesExtra } = _restaurarArquivosExtraDoGeral(arquivos, dirSeguranca);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            arquivosRestaurados: presentesDados.length + presentesExtra.length,
            backupSeguranca: path.relative(ROOT_DIR, dirSeguranca),
          }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    return false;
  }

  return { tentar, executarBackupAutomaticoSeNecessario };
};

