const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const vm        = require('vm');
const JSZip     = require('jszip');
const WebSocket = require('ws');

// SQLite (better-sqlite3) — Fase 1 da migração JSON → SQL (ver README,
// seção "Banco de Dados (SQLite)"). Por enquanto só cria o banco/schema;
// nenhuma rota usa isto ainda — segue tudo lendo/escrevendo os JSONs de
// public/db/ exatamente como antes, até cada fase ser migrada de verdade.
const db = require('./db.js');

// Converte pra número, ou null se vazio/nulo/indefinido — usado ao montar
// parâmetros de colunas SQL a partir de valores de formulário (que chegam
// como string vazia '' quando o campo não foi preenchido).
function numOuNulo(v) {
  return (v === '' || v === null || v === undefined) ? null : Number(v);
}

const PORT = process.env.PORT || 5000; // env var facilita rodar testes numa porta separada
const ROOT_DIR = __dirname; // raiz do projeto — usado pelo backup geral
const DIR = path.join(__dirname, 'public');
const DB_DIR = path.join(DIR, 'db'); // arquivos-de-dados (JSON usados como "banco")

// ─── security.json mora FORA de public/ ────────────────────────────────────
// Antes, security.json vivia em public/db/ — e por isso era servido como
// arquivo estático comum (GET /db/security.json acessível por qualquer um,
// sem senha nenhuma; ver README, "Limitações conhecidas"). Agora mora em
// private/ (irmã de public/, nunca servida como estático — mesmo padrão já
// usado por backups-seguranca/ e logs/). O acesso por HTTP passa a exigir
// uma sessão de admin válida (ver GET /db/security.json e lib/sessao.js,
// mais abaixo) — a URL que o navegador usa não muda, só fica protegida.
const PRIVATE_DIR = path.join(ROOT_DIR, 'private');
const SECURITY_PATH = path.join(PRIVATE_DIR, 'security.json');
// Cadastro de Identidade Leve de Operador (ver "Identidade Leve de
// Operador", db.js) — mesmo motivo de SECURITY_PATH viver fora de
// public/: contém pinHash por operador, e um arquivo dentro de public/db/
// seria servido cru pela rota estática genérica pra qualquer um que
// soubesse a URL (foi exatamente o problema histórico de security.json —
// ver README, "Limitações conhecidas"). GET /operadores (abaixo) nunca
// devolve pinHash, só {id, nome}.
const OPERADORES_PATH = path.join(PRIVATE_DIR, 'operadores.json');
fs.mkdirSync(PRIVATE_DIR, { recursive: true });

// Migração automática, só na 1ª vez que sobe depois desta mudança: se o
// arquivo antigo (public/db/security.json) ainda existir e o novo ainda
// não, copia o conteúdo pro novo lugar e RENOMEIA o antigo (nunca apaga —
// mesmo padrão das migrações de db.js, que preferem deixar um rastro
// "<nome>.migrado-<timestamp>" a apagar dados).
(function migrarSecurityJsonSeNecessario() {
  const caminhoAntigo = path.join(DB_DIR, 'security.json');
  if (fs.existsSync(SECURITY_PATH)) return; // já migrado
  if (!fs.existsSync(caminhoAntigo)) return; // instalação nova — nada pra migrar
  fs.copyFileSync(caminhoAntigo, SECURITY_PATH);
  fs.renameSync(caminhoAntigo, caminhoAntigo + `.migrado-${Date.now()}`);
})();

// Autenticação do Administrador (hash de senha + rate limiting de
// tentativas) — extraído pra lib/auth.js (ver esse arquivo pros detalhes
// e comentários originais; aqui só instanciamos e usamos).
const auth = require('./lib/auth.js')(SECURITY_PATH);

// Sessão de Administrador (token em cookie HttpOnly) — extraído pra
// lib/sessao.js. Cobre as 2 rotas que não tinham proteção própria nenhuma
// antes desta mudança: GET /db/security.json e POST /salvar-security.
const sessao = require('./lib/sessao.js')();

// ── Fatias de rotas extraídas pra lib/rotas/ (ver esse arquivo pro padrão
// seguido) — cada uma é uma factory que recebe só as dependências que
// aquele domínio usa, e devolve uma função tentar(req,res,urlPath) que
// devolve true se já respondeu. Chamadas em sequência dentro do
// http.createServer, abaixo, antes das rotas que ainda não foram
// extraídas (ver o loop logo no início do callback).
const rotasOperadores = require('./lib/rotas/operadores.js')({ fs, path, PRIVATE_DIR, auth, sessao });
const rotasParadas = require('./lib/rotas/paradas.js')({ db });
const rotasQualidade = require('./lib/rotas/qualidade.js')({ db, lerOperacoesNaoAvaliadas, removerDaFilaNaoAvaliadas });
const rotasSqlAdmin = require('./lib/rotas/sql-admin.js')({ db, sessao, adicionarNaFilaNaoAvaliadas, broadcastDadosSqlExcluidos });
const rotasConsultas = require('./lib/rotas/consultas.js')({ db });
const rotasSobra = require('./lib/rotas/sobra.js')({ db, fs, path, dirParaModoTeste });
const rotasContadorTracos = require('./lib/rotas/contador-tracos.js')({ lerContadorTracosHoje, incrementarContadorTracosHoje, dispositivoAutorizado, negarDispositivoNaoAutorizado });
const rotasLogAcesso = require('./lib/rotas/log-acesso.js')({ fs, path, ROOT_DIR });
const rotasOperacaoAndamento = require('./lib/rotas/operacao-andamento.js')({
  sessao, lerOperacaoAndamento, salvarOperacaoAndamentoNoDisco, broadcastOperacaoAndamento,
  lerBercosAndamento, salvarBercosAndamentoNoDisco, dispositivoAutorizado, negarDispositivoNaoAutorizado,
});
const ROTAS_EXTRAIDAS = [rotasOperadores, rotasParadas, rotasQualidade, rotasSqlAdmin, rotasConsultas, rotasSobra, rotasContadorTracos, rotasLogAcesso, rotasOperacaoAndamento];

// Resolve o caminho real, no disco, de um arquivo de public/db/ — quase
// todos vivem em DB_DIR, mas security.json e operadores.json são exceção
// (ver PRIVATE_DIR/SECURITY_PATH/OPERADORES_PATH, acima). Centralizar
// essa decisão aqui evita ter que repetir o "if (nome === ...)" em cada
// rota de backup/restauração que itera a lista de arquivos genericamente.
function caminhoArquivoDb(nome) {
  if (nome === 'security.json') return SECURITY_PATH;
  if (nome === 'operadores.json') return OPERADORES_PATH;
  return path.join(DB_DIR, nome);
}

// Migração automática Fase 2 (ver db.js) — só faz algo na primeira vez
// que sobe com a tabela "operacoes" vazia E historico.json ainda existir
// com esse nome exato; depois disso é sempre um no-op rápido (1 SELECT
// COUNT(*) + 1 fs.existsSync).
db.migrarHistoricoSeNecessario(DB_DIR);
// Fase 3 — mesmo critério, pra paradas.json.
db.migrarParadasSeNecessario(DB_DIR);
// Fase 4 — mesmo critério, pra sobra.json e contador_tracos.json.
db.migrarSobraSeNecessario(DB_DIR);
db.migrarContadorTracosSeNecessario(DB_DIR);
// Fase 5 — mesmo critério, pra relatorio_injecao.json + ajustes_tracos.json
// (a mais complexa; depende da Fase 2 já ter rodado, pra "operacoes" já
// existir quando os usos forem conferidos — por isso vem por último).
db.migrarRelatorioInjecaoSeNecessario(DB_DIR);

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.key':  'text/plain',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  // Ícones do PWA (ver public/icons/, manifest.json) — sem isso, o
  // servidor devolvia qualquer .png como 'text/plain' (fallback,
  // abaixo), e o navegador não reconhece esses arquivos como ícone.
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// Retorna a data de hoje em Brasília no formato YYYY-MM-DD (consistente com
// todayBrasilia() do frontend), independente do fuso horário do servidor.
function todayBrasiliaServer() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date()); // en-CA já formata como YYYY-MM-DD
}

// Retorna { hora, minuto } de agora em Brasília — usado pelo backup
// automático diário, pra saber se já passou do horário de "fim de dia".
function horaMinutoBrasiliaServer() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const partes = fmt.formatToParts(new Date());
  const hora = parseInt(partes.find(p => p.type === 'hour').value, 10);
  const minuto = parseInt(partes.find(p => p.type === 'minute').value, 10);
  return { hora, minuto };
}

// ─── MODO DE TESTE (Registrar Operação) ────────────────────────────────────
// Toggle na tela "Registrar Operação" — quando ativo, a operação inteira
// (historico, relatório de injeção, contador de traços, ajustes, sobra) é
// salva em public/db/teste/ em vez de public/db/, pra treinar/testar o
// fluxo sem misturar com dados reais de produção. Nunca toca nos arquivos
// normais. Pasta criada na hora (mkdirSync) na primeira escrita.
const DB_TESTE_DIR = path.join(DB_DIR, 'teste');

function dirParaModoTeste(modoTesteFlag) {
  if (!modoTesteFlag) return DB_DIR;
  fs.mkdirSync(DB_TESTE_DIR, { recursive: true });
  return DB_TESTE_DIR;
}

// Lê o contador de traços do dia, resetando automaticamente se a data mudou
// (Brasília). NÃO incrementa — apenas garante que o objeto retornado é válido
// para o dia de hoje. Quem chama decide se quer ler ou incrementar.
// Lê o contador de traços do dia — Modo de Teste continua em JSON
// (arquivo isolado de sempre); o caminho real lê da tabela contador_tracos
// (uma query simples, sem o reset manual de "novo dia" — cada dia já é
// uma linha própria, então um dia novo simplesmente ainda não tem linha).
function lerContadorTracosHoje(modoTesteFlag = false) {
  const hoje = todayBrasiliaServer();
  if (modoTesteFlag) {
    const contadorPath = path.join(dirParaModoTeste(true), 'contador_tracos.json');
    let contador = { data: hoje, total: 0 };
    try {
      contador = JSON.parse(fs.readFileSync(contadorPath, 'utf8'));
    } catch (_) { /* arquivo ainda não existe — usa o default acima */ }
    if (contador.data !== hoje) {
      contador = { data: hoje, total: 0 }; // novo dia: reinicia a contagem
    }
    return contador;
  }
  const row = db.prepare('SELECT total FROM contador_tracos WHERE data = ?').get(hoje);
  return { data: hoje, total: row ? row.total : 0 };
}

// Incrementa o contador de traços do dia em "quantidade" — Modo de Teste
// continua fazendo ler-tudo-somar-escrever-tudo (arquivo isolado, sem
// concorrência real pra se preocupar); o caminho real faz a soma DENTRO
// do banco, numa query só — sem isso, dois "/confirmar-tracos-hoje" quase
// simultâneos podiam ler o mesmo total, somar separado, e um incremento
// se perder (o último a escrever "ganha", sem nunca somar os dois juntos).
function incrementarContadorTracosHoje(quantidade, modoTesteFlag = false) {
  const hoje = todayBrasiliaServer();
  if (modoTesteFlag) {
    const contador = lerContadorTracosHoje(true);
    contador.total += quantidade;
    const contadorPath = path.join(dirParaModoTeste(true), 'contador_tracos.json');
    fs.writeFileSync(contadorPath, JSON.stringify(contador, null, 2), 'utf8');
    return contador;
  }
  db.prepare(`
    INSERT INTO contador_tracos (data, total) VALUES (?, ?)
    ON CONFLICT(data) DO UPDATE SET total = total + ?
  `).run(hoje, quantidade, quantidade);
  return lerContadorTracosHoje(false);
}

// ─── Validação de formato dos arquivos de public/db/ — usada ao restaurar
// um backup, pra recusar arquivo errado/corrompido antes de gravar no disco.
const VALIDADORES_BACKUP_DADOS = {
  'config.json':            v => v && typeof v === 'object' && !Array.isArray(v),
  'contador_tracos.json':   v => v && typeof v === 'object' && !Array.isArray(v),
  'historico.json':          v => Array.isArray(v),
  'historico_edicoes.json': v => Array.isArray(v),
  'relatorio_edicoes.json':  v => Array.isArray(v),
  'relatorio_injecao.json': v => Array.isArray(v),
  'security.json':           v => v && typeof v === 'object' && typeof v.passwordHash === 'string',
  // Identidade Leve de Operador (ver OPERADORES_PATH, acima) — mesmo
  // motivo de viver fora de public/db/ que security.json.
  'operadores.json':         v => Array.isArray(v),
  'sobra.json':              v => v && typeof v === 'object',
  'paradas.json':            v => Array.isArray(v),
  'ajustes_tracos.json':    v => Array.isArray(v),
  // Metas de produção (Página de Metas — ver public/js/metas.js). Objeto
  // simples, mesmo padrão de config.json; campos ausentes/null = meta
  // não definida pra aquele indicador (nunca um erro de validação).
  'metas.json':              v => v && typeof v === 'object' && !Array.isArray(v),
  // ─── Adicionados: Berços Visuais e Avaliações do Setor de Qualidade —
  // antes ficavam de fora do Backup de Dados/automático, só entravam no
  // Backup Geral (que zipa o .sqlite inteiro). Ambos são tabelas SQL (ver
  // GET /db/<nome> mais abaixo, que reconstrói o JSON a partir do banco).
  'bercos_visuais.json':       v => Array.isArray(v),
  'avaliacoes_qualidade.json': v => Array.isArray(v),
  // Adicionado: sem isso, "quem já foi avaliado" (ver CREATE TABLE
  // operacoes_avaliadas, db.js) nunca saía no Backup de Dados — restaurar
  // um backup fazia toda bateria já avaliada voltar a aparecer na fila
  // de "não avaliadas" do Setor de Qualidade, mesmo já tendo sido avaliada
  // de verdade antes do backup.
  'operacoes_avaliadas.json':  v => Array.isArray(v),
  // Adicionado: agora que "não avaliadas" é a fila DE VERDADE (não mais
  // calculada na hora — ver OPERACOES_NAO_AVALIADAS_PATH, mais abaixo),
  // sem isso, restaurar um backup deixaria esse arquivo desatualizado em
  // relação às tabelas SQL recém-substituídas (ver recalcularFilaNaoAvaliadasApartirDoSql,
  // chamada como rede de segurança logo depois da restauração quando este
  // arquivo específico não vier no backup enviado).
  'operacoes_nao_avaliadas.json': v => Array.isArray(v),
};

// Alguns desses arquivos legitimamente ficam vazios (0 bytes) até o app
// inicializá-los na primeira vez que precisa deles — ver lerContadorTracosHoje()
// acima, que já tolera exatamente isso. Aqui dizemos o que um arquivo vazio
// "significa" pra cada um, em vez de recusar como JSON inválido. config.json
// e security.json ficam de fora de propósito: vazio ali é sempre um problema
// real (perderíamos os tipos de bateria ou o hash da senha).
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
};

function parseArquivoBackupDados(nome, texto) {
  if (texto.trim() === '' && DEFAULT_SE_VAZIO_BACKUP_DADOS.hasOwnProperty(nome)) {
    return DEFAULT_SE_VAZIO_BACKUP_DADOS[nome];
  }
  return JSON.parse(texto);
}

// ─── Backup automático diário (dados) ──────────────────────────────────────
// Roda dentro do próprio servidor (não depende de ninguém com o navegador
// aberto). Todo fim de dia, gera um .zip com os arquivos de public/db/ e
// guarda em backups-automaticos/ (fora de public/, nunca servido como
// arquivo "comum" — só pelas duas rotas dedicadas abaixo). Mantém sempre os
// últimos 3 dias: ao criar um novo, remove os mais antigos que excederem
// esse limite.
const DIR_BACKUPS_AUTO = path.join(ROOT_DIR, 'backups-automaticos');
const PREFIXO_BACKUP_AUTO = 'backup-dados_';
const RETENCAO_DIAS_BACKUP_AUTO = 3;
// "Fim de dia" = a partir deste horário (Brasília). Checado a cada minuto,
// então qualquer hora futura nesse mesmo dia também serve de gatilho — não
// precisa ser exatamente nesse minuto.
const HORA_CORTE_BACKUP_AUTO = 23;
const MINUTO_CORTE_BACKUP_AUTO = 50;

// Mesma lista de arquivos do Backup de Dados manual (VALIDADORES_BACKUP_DADOS),
// só que montada aqui no servidor — o backup automático não depende de
// ninguém estar com o navegador aberto.
async function gerarZipDadosServidor() {
  const zip = new JSZip();
  Object.keys(VALIDADORES_BACKUP_DADOS).forEach(nome => {
    try {
      if (nome === 'historico.json') {
        // Não existe mais como arquivo (Fase 2 — ver "Banco de Dados
        // (SQLite)" no README) — exporta o conteúdo atual da tabela, no
        // mesmo formato de sempre, pra continuar saindo no backup.
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
        // Faltava este caso — sem ele, cai no fallback `else` (ler arquivo
        // estático de DB_DIR), que não existe mais desde a migração pra
        // SQLite (ver edicoes_traco): o fs.readFileSync falhava, o catch
        // engolia o erro, e o arquivo simplesmente nunca entrava no zip,
        // sem avisar ninguém — exatamente o bug visto na hora de restaurar.
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

// Remove os backups automáticos mais antigos, mantendo só os N mais
// recentes (RETENCAO_DIAS_BACKUP_AUTO). O nome do arquivo já tem a data no
// formato YYYY-MM-DD, então ordenar por nome = ordenar cronologicamente.
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

// Checa se já passou do "fim de dia" de hoje e ainda não existe backup de
// hoje — se for o caso, gera um e rotaciona. Seguro de chamar repetidamente
// (cada dia só gera um único arquivo, então chamadas repetidas no mesmo dia
// não fazem nada depois da primeira).
// Verifica se ao menos uma operação foi registrada hoje em historico.json —
// usado pelo backup automático pra não gastar um dos 3 slots de rotação num
// dia em que o maquinário não operou (o conteúdo seria essencialmente igual
// ao do backup do dia anterior, então não agrega nada guardar de novo).
// Em caso de erro de leitura, assume que SIM (prefere gerar um backup a mais
// do que arriscar não ter um backup justamente quando algo está estranho).
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

    if (fs.existsSync(caminhoHoje)) return; // já fizemos o backup de hoje

    const { hora, minuto } = horaMinutoBrasiliaServer();
    const passouDoCorte = hora > HORA_CORTE_BACKUP_AUTO ||
      (hora === HORA_CORTE_BACKUP_AUTO && minuto >= MINUTO_CORTE_BACKUP_AUTO);
    if (!passouDoCorte) return; // ainda não é "fim de dia"

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

// ─── Backup Geral — zipa o projeto inteiro (código + dados), como está ────
// Diferente do "Backup de Dados" (feito no navegador, só com public/db/),
// este é montado no servidor porque precisa varrer TODO o projeto sem
// precisar saber de antemão o nome de cada arquivo/pasta existente.
const BACKUP_GERAL_IGNORAR = new Set(['node_modules', '.git']);

function adicionarPastaAoZip(zip, dirAbsoluto, prefixoZip) {
  for (const entry of fs.readdirSync(dirAbsoluto, { withFileTypes: true })) {
    if (BACKUP_GERAL_IGNORAR.has(entry.name)) continue;
    const caminhoAbsoluto = path.join(dirAbsoluto, entry.name);
    const caminhoZip = prefixoZip ? prefixoZip + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      adicionarPastaAoZip(zip, caminhoAbsoluto, caminhoZip);
    } else {
      zip.file(caminhoZip, fs.readFileSync(caminhoAbsoluto));
    }
  }
}

async function gerarBackupGeral() {
  // Checkpoint do WAL ANTES de zipar — sem isso, escritas recentes podem
  // estar só em data/lightwall.sqlite-wal (ainda não "promovidas" pro
  // arquivo principal), e o backup ficaria incompleto/inconsistente se
  // alguém restaurar só o .sqlite sem os arquivos -wal/-shm junto.
  // TRUNCATE = escreve tudo no arquivo principal E encolhe o -wal de volta
  // (o oposto de deixá-lo crescer pra sempre).
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { console.error('[backup] Falha no checkpoint do WAL:', e.message); }

  const zip = new JSZip();
  adicionarPastaAoZip(zip, ROOT_DIR, '');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ─── Segurança de caminho para a Restauração Geral ─────────────────────────
// Os nomes de arquivo vêm de dentro do .zip que o admin enviou — nunca
// confiamos neles sem checar antes de escrever no disco.
const RESTAURAR_GERAL_PROIBIDOS = new Set(['node_modules', '.git', 'backups-seguranca']);

function caminhoSeguroDentroDoProjeto(caminhoRelativo) {
  if (typeof caminhoRelativo !== 'string' || !caminhoRelativo) {
    throw new Error('Caminho de arquivo inválido no backup.');
  }
  // Recusa caminho absoluto ou com ".." (tentativa de escapar da raiz do projeto)
  const segmentos = caminhoRelativo.split(/[\\/]/);
  if (path.isAbsolute(caminhoRelativo) || segmentos.includes('..') || segmentos.includes('')) {
    throw new Error(`Caminho inválido no backup: "${caminhoRelativo}"`);
  }
  if (RESTAURAR_GERAL_PROIBIDOS.has(segmentos[0])) {
    throw new Error(`Caminho não permitido no backup: "${caminhoRelativo}"`);
  }
  const absoluto = path.resolve(ROOT_DIR, caminhoRelativo);
  if (absoluto !== ROOT_DIR && !absoluto.startsWith(ROOT_DIR + path.sep)) {
    throw new Error(`Caminho fora do projeto: "${caminhoRelativo}"`);
  }
  return absoluto;
}

// Confere que um trecho de código é JavaScript sintaticamente válido, sem
// executá-lo — usado pro server.js restaurado, pra nunca deixar um arquivo
// com erro de sintaxe no lugar do servidor (o que impediria até de reiniciar
// pra corrigir, exigindo acesso direto ao servidor).
function validarSintaxeJS(codigo, nomeArquivo) {
  try {
    new vm.Script(codigo, { filename: nomeArquivo });
  } catch (e) {
    throw new Error(`"${nomeArquivo}" tem erro de sintaxe JavaScript: ${e.message}`);
  }
}

// ─── OPERAÇÃO EM ANDAMENTO: transmissão em tempo real (WebSocket) ─────────
// Só existe UMA operação em andamento por vez, pra fábrica inteira — então
// o arquivo guarda sempre um único objeto (ou null, sem nenhuma operação
// rodando agora), nunca uma lista. A tela "Registrar Operação" manda pra cá
// a cada mudança (ver POST /salvar-operacao-andamento, mais abaixo) e o
// servidor propaga na hora pra qualquer outra aba/computador com essa
// mesma tela aberta (ver wss.on('connection', ...), perto do final do
// arquivo) — é assim que outras pessoas acompanham a operação ao vivo.
const OPERACAO_ANDAMENTO_PATH = path.join(DB_DIR, 'operacao_andamento.json');

function lerOperacaoAndamento() {
  try {
    const texto = fs.readFileSync(OPERACAO_ANDAMENTO_PATH, 'utf8').trim();
    return texto ? JSON.parse(texto) : null;
  } catch (_) {
    return null; // arquivo ainda não existe / corrompido — trata como "nenhuma operação"
  }
}

function salvarOperacaoAndamentoNoDisco(dados) {
  const tmp = OPERACAO_ANDAMENTO_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(dados, null, 2), 'utf8');
  fs.renameSync(tmp, OPERACAO_ANDAMENTO_PATH);
}

// ─── FILA DE AVALIAÇÃO (Setor de Qualidade): "não avaliadas" ──────────────
// Antes, GET /operacoes-nao-avaliadas CALCULAVA a fila toda vez (SELECT ...
// WHERE id NOT IN (SELECT id_operacao FROM operacoes_avaliadas)) — nunca
// existia como lista própria, só como diferença entre duas outras coisas.
// Agora é o CONTRÁRIO: um arquivo próprio (JSON simples — cresce a cada
// operação registrada, encolhe a cada avaliação, e nunca chega perto do
// tamanho de "operacoes"/"operacoes_avaliadas", que só crescem) é a fonte
// de verdade — guarda só os IDs pendentes, na ordem em que entraram. GET
// /operacoes-nao-avaliadas lê esta lista e busca os detalhes de cada
// operação no SQL só pra exibir (não pra decidir QUEM está na fila).
//
// Mantido em sincronia em 2 pontos (nunca em mais nenhum outro lugar):
//   - adicionarNaFilaNaoAvaliadas(id) — POST /registrar-operacao, depois do
//     INSERT em "operacoes" (nunca em Modo de Teste — mesma regra de
//     sempre, essas operações nunca entram na fila do Setor de Qualidade).
//   - removerDaFilaNaoAvaliadas(id) — sempre que uma operação é marcada
//     avaliada (POST /marcar-operacao-avaliada, e dentro de
//     db.marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada, pro caso de
//     avaliação avulsa — ver os 2 call sites, mais abaixo).
const OPERACOES_NAO_AVALIADAS_PATH = path.join(DB_DIR, 'operacoes_nao_avaliadas.json');

function lerOperacoesNaoAvaliadas() {
  try {
    const texto = fs.readFileSync(OPERACOES_NAO_AVALIADAS_PATH, 'utf8').trim();
    return texto ? JSON.parse(texto) : [];
  } catch (_) {
    return []; // arquivo ainda não existe/corrompido — ver migrarFilaNaoAvaliadasSeNecessario, que cobre a 1ª vez
  }
}

function salvarOperacoesNaoAvaliadasNoDisco(lista) {
  const tmp = OPERACOES_NAO_AVALIADAS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(lista, null, 2), 'utf8');
  fs.renameSync(tmp, OPERACOES_NAO_AVALIADAS_PATH);
}

function adicionarNaFilaNaoAvaliadas(idOperacao) {
  const lista = lerOperacoesNaoAvaliadas();
  if (!lista.includes(idOperacao)) {
    lista.push(idOperacao);
    salvarOperacoesNaoAvaliadasNoDisco(lista);
  }
}

function removerDaFilaNaoAvaliadas(idOperacao) {
  const lista = lerOperacoesNaoAvaliadas();
  const idx = lista.indexOf(idOperacao);
  if (idx !== -1) {
    lista.splice(idx, 1);
    salvarOperacoesNaoAvaliadasNoDisco(lista);
  }
}

// Recalcula a fila do ZERO a partir do SQL (mesmo critério de sempre: toda
// operação real, fora de Modo de Teste, que ainda não tem linha em
// "operacoes_avaliadas") — usada só em 2 situações, nunca no dia a dia:
//   1) 1ª vez que o servidor sobe com este arquivo ainda inexistente (ver
//      migrarFilaNaoAvaliadasSeNecessario, chamada no boot, abaixo) —
//      instalação já em uso antes desta mudança existir.
//   2) Depois de restaurar um backup que trouxe historico.json e/ou
//      operacoes_avaliadas.json mas NÃO trouxe operacoes_nao_avaliadas.json
//      (backup mais antigo, de antes deste arquivo existir) — sem isso, o
//      arquivo antigo (se já existisse aqui) ficaria fora de sincronia com
//      as tabelas SQL recém-substituídas (ver POST /restaurar-backup-dados).
function recalcularFilaNaoAvaliadasApartirDoSql() {
  const rows = db.prepare(`
    SELECT id FROM operacoes
    WHERE modo_teste = 0
      AND id NOT IN (SELECT id_operacao FROM operacoes_avaliadas)
    ORDER BY data ASC, fim ASC
  `).all();
  salvarOperacoesNaoAvaliadasNoDisco(rows.map(r => r.id));
  return rows.length;
}

function migrarFilaNaoAvaliadasSeNecessario() {
  if (fs.existsSync(OPERACOES_NAO_AVALIADAS_PATH)) return; // já existe — não é a 1ª vez, nada a fazer
  try {
    const qtd = recalcularFilaNaoAvaliadasApartirDoSql();
    console.log(`[migração] operacoes_nao_avaliadas.json criado com ${qtd} operação(ões) pendente(s) (calculado a partir do estado atual do banco).`);
  } catch (e) {
    console.error('[migração] Falha ao criar operacoes_nao_avaliadas.json — seguindo com fila vazia:', e.message);
    try { salvarOperacoesNaoAvaliadasNoDisco([]); } catch (_) { /* pior caso: arquivo continua ausente, lerOperacoesNaoAvaliadas() já trata isso como fila vazia */ }
  }
}
// Chamada AQUI mesmo (logo depois das funções/consts acima, não lá em cima
// junto das outras "Fase N" — ver caminhoArquivoDb, no topo do arquivo):
// depende de OPERACOES_NAO_AVALIADAS_PATH (const, sem hoisting de valor) e
// de "db" já com "operacoes"/"operacoes_avaliadas" prontas (migração de
// histórico já rodou lá em cima) — chamar antes desta linha do arquivo ser
// executada lançaria ReferenceError (TDZ) na const.
migrarFilaNaoAvaliadasSeNecessario();

// ─── BERÇOS DA OPERAÇÃO EM ANDAMENTO: "baixou/vazou" marcado ao vivo ──────
// Snapshot separado de operacao_andamento.json de propósito: aquele arquivo
// é sobrescrito por INTEIRO a cada mudança que a tela Registrar Operação
// manda (ver POST /salvar-operacao-andamento) — se os estados de berço
// vivessem dentro dele, o próximo campo que o operador editasse sobrescreveria
// as marcações feitas por quem estiver olhando "Bateria Atual" (potencialmente
// em outro computador, sem relação com "o dono" da operação). Aqui é um
// arquivo à parte, só mexido pelas 2 rotas de berço (GET /bercos-andamento,
// POST /marcar-berco-andamento) — ninguém mais escreve nele.
//
// Mapa ESPARSO em 2 níveis: { 'B1': { esquerda: 'baixou' } } — só guarda
// berço/lado que NÃO estão 'okay'; lado ausente (ou berço ausente por
// inteiro) é 'okay' implicitamente. Os 2 lados de um mesmo berço são
// independentes — marcar um não mexe no outro. Reversível por natureza
// (marcar de novo remove a entrada daquele lado — ver POST
// /marcar-berco-andamento).
//
// Resetado (vira {} de novo) em 2 pontos: quando a operação em andamento é
// limpa (POST /salvar-operacao-andamento com dados=null — fim normal, ou
// "🗑️ Limpar Tudo") e quando a operação é registrada de verdade (POST
// /registrar-operacao — nesse ponto, o conteúdo já foi transferido pra
// bercos_visuais antes de resetar, ver essa rota).
const BERCOS_ANDAMENTO_PATH = path.join(DB_DIR, 'bercos_andamento.json');

function lerBercosAndamento() {
  try {
    const texto = fs.readFileSync(BERCOS_ANDAMENTO_PATH, 'utf8').trim();
    const obj = texto ? JSON.parse(texto) : {};
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch (_) {
    return {}; // arquivo ainda não existe / corrompido — trata como "nenhum berço marcado"
  }
}

function salvarBercosAndamentoNoDisco(mapa) {
  const tmp = BERCOS_ANDAMENTO_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(mapa, null, 2), 'utf8');
  fs.renameSync(tmp, BERCOS_ANDAMENTO_PATH);
}

// ─── LOG DE ACESSO ──────────────────────────────────────────────────────────
// Registra cada acesso a rotas "sensíveis" do app (por enquanto, só
// "Registrar Operação" — ver POST /registrar-acesso, mais abaixo) com
// ip + user-agent (capturados aqui, de fontes confiáveis do próprio
// request) e deviceId (gerado e persistido no navegador de quem acessou).
// Base pra, no futuro, restringir quem pode registrar operação a um único
// computador. Cresce sem limite por enquanto — sem rotina de limpeza
// automática (mesma ressalva já documentada pra backups-seguranca/).
//
// Fica em logs/, FORA de public/ — diferente dos arquivos de public/db/
// (que são servidos como arquivo estático comum, ex: /db/security.json
// funciona por URL direta — ver "Limitações conhecidas" no README), aqui
// o IP de quem acessa não pode ficar visível pra qualquer um que souber a
// URL. Pasta criada na hora (mkdirSync) se ainda não existir.
const DIR_LOGS = path.join(ROOT_DIR, 'logs');
const ACESSOS_PATH = path.join(DIR_LOGS, 'acessos.json');

// ─── DISPOSITIVOS AUTORIZADOS A CONTROLAR A OPERAÇÃO ───────────────────────
// Lista opcional em config.json (dispositivosAutorizados: [{ deviceId, nome,
// autorizadoEm }]), editável em Configurações → Autorizados. Regra: lista
// VAZIA = sem restrição (qualquer computador pode iniciar/encerrar/registrar
// — comportamento padrão, igual a antes desta funcionalidade existir).
// Lista com pelo menos 1 item = só os deviceIds dela podem controlar; os
// demais continuam podendo ACOMPANHAR ao vivo (WebSocket), só não interagir.
function lerConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DB_DIR, 'config.json'), 'utf8'));
  } catch (_) {
    return {};
  }
}

function dispositivoAutorizado(deviceId) {
  const cfg = lerConfig();
  const lista = Array.isArray(cfg.dispositivosAutorizados) ? cfg.dispositivosAutorizados : [];
  if (!lista.length) return true; // sem restrição configurada ainda
  return lista.some(d => d && d.deviceId === deviceId);
}

function negarDispositivoNaoAutorizado(res) {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: false,
    erro: 'Este computador não está autorizado a controlar operações. Peça ao Administrador pra autorizá-lo em Configurações → Autorizados.',
  }));
}

const server = http.createServer((req, res) => {

  // Extrai o caminho (pathname) da URL e os parâmetros de query (ex:
  // ?deviceId=... — usado pra checar autorização de dispositivo em rotas
  // que controlam a operação em andamento, ver dispositivoAutorizado();
  // ?modoTeste=true — usado pelo Toggle de Teste em Registrar Operação,
  // ver dirParaModoTeste(), mais abaixo).
  const [urlPath, queryString] = req.url.split('?');
  const queryParams = new URLSearchParams(queryString || '');
  const deviceId = queryParams.get('deviceId') || '';
  const modoTeste = queryParams.get('modoTeste') === 'true';

  // ─── Limite de tamanho de corpo (POST) ─────────────────────────────────
  // Nenhuma rota abaixo tinha limite nenhum — cada uma só acumula
  // `req.on('data', chunk => body += chunk)` até o 'end', sem nenhum teto.
  // Um POST com um corpo gigante (intencional ou não) ficaria inteiro em
  // memória, sem nenhuma defesa. 50MB é generoso o bastante pro Backup
  // Geral/Restaurar Geral (a rota que de longe manda o maior payload —
  // projeto inteiro em JSON), mas ainda assim finito. Não substitui a
  // leitura de cada rota — só corta a conexão mais cedo se ela passar do
  // limite, antes de o corpo inteiro acumular em memória.
  const MAX_BODY_BYTES = 50 * 1024 * 1024;
  if (req.method === 'POST') {
    let _bytesRecebidos = 0;
    let _corpoAbortado = false;
    req.on('data', (chunk) => {
      _bytesRecebidos += chunk.length;
      if (!_corpoAbortado && _bytesRecebidos > MAX_BODY_BYTES) {
        _corpoAbortado = true;
        try {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: 'Corpo da requisição excede o limite permitido (50MB).' }));
        } catch (_) { /* resposta pode já ter sido enviada por outra checagem — ignora */ }
        req.destroy();
      }
    });
  }

  // ─── Rotas extraídas pra lib/rotas/ (ver ROTAS_EXTRAIDAS, acima) ───────
  // Tentadas ANTES das rotas ainda inline abaixo — cada módulo devolve
  // `true` se já respondeu (encerra aqui) ou `false` se essa requisição
  // não é dele (segue tentando o próximo módulo, e por fim as rotas
  // ainda-não-extraídas mais abaixo). Corpo grande já foi validado acima
  // (o teto de 50MB vale pra QUALQUER rota, extraída ou não). queryParams
  // é passado a todos (mesmo os módulos que não usam — um argumento a
  // mais que a função não declara é só ignorado pelo JS).
  for (const modulo of ROTAS_EXTRAIDAS) {
    if (modulo(req, res, urlPath, queryParams)) return;
  }

  // ── NOVO: Verificar senha admin no servidor ────────────────────────────────
  // POST /verificar-senha  { senha: "texto plano" }
  // Retorna { ok: true } se correta, { ok: false } se incorreta.
  // A senha nunca é logada — apenas comparada com o hash em security.json.
  // Protegida por rate limiting (ver validarSegredo/rateLimit*, acima):
  // depois de muitas tentativas erradas do mesmo IP, responde 429 em vez
  // de continuar testando a senha enviada.
  if (req.method === 'POST' && urlPath === '/verificar-senha') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        if (auth.rateLimitEstaBloqueado(req)) {
          const segundos = auth.rateLimitSegundosRestantes(req);
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(segundos) });
          res.end(JSON.stringify({ ok: false, erro: `Muitas tentativas erradas. Tente de novo em ${Math.ceil(segundos / 60)} min.` }));
          return;
        }
        const { senha } = JSON.parse(body);
        if (typeof senha !== 'string') throw new Error('Payload inválido.');
        const security = auth.lerSecurity();
        const hashEsperado = security.passwordHash || auth.HASH_FALLBACK;
        const ok = auth.validarSegredo(senha, hashEsperado, 'passwordHash');
        const headers = { 'Content-Type': 'application/json' };
        if (ok) {
          auth.rateLimitRegistrarSucesso(req);
          // Emite sessão (ver lib/sessao.js) — usada por GET /db/security.json
          // e POST /salvar-security, que não tinham proteção própria nenhuma
          // antes desta mudança.
          headers['Set-Cookie'] = sessao.criarCookieSessao();
        } else {
          auth.rateLimitRegistrarFalha(req);
        }
        res.writeHead(200, headers);
        res.end(JSON.stringify({ ok }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── NOVO: Verificar arquivo de recuperação no servidor ────────────────────
  // POST /verificar-recovery  { chave: "conteudo do .key" }
  // Retorna { ok: true } se válido. Mesmo rate limiting de /verificar-senha
  // (contador compartilhado por IP — ver rateLimit*, acima).
  if (req.method === 'POST' && urlPath === '/verificar-recovery') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        if (auth.rateLimitEstaBloqueado(req)) {
          const segundos = auth.rateLimitSegundosRestantes(req);
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(segundos) });
          res.end(JSON.stringify({ ok: false, erro: `Muitas tentativas erradas. Tente de novo em ${Math.ceil(segundos / 60)} min.` }));
          return;
        }
        const { chave } = JSON.parse(body);
        if (typeof chave !== 'string') throw new Error('Payload inválido.');
        const security = auth.lerSecurity();
        if (!security.recoveryKeyHash) {
          auth.rateLimitRegistrarFalha(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        const ok = auth.validarSegredo(chave.trim(), security.recoveryKeyHash, 'recoveryKeyHash');
        const headers = { 'Content-Type': 'application/json' };
        if (ok) {
          auth.rateLimitRegistrarSucesso(req);
          // Mesma sessão de /verificar-senha — é o que permite o fluxo de
          // recuperação chamar POST /salvar-security depois (ver
          // admin-auth.js, _salvarNovaSenha) sem precisar reenviar a chave.
          headers['Set-Cookie'] = sessao.criarCookieSessao();
        } else {
          auth.rateLimitRegistrarFalha(req);
        }
        res.writeHead(200, headers);
        res.end(JSON.stringify({ ok }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── NOVO: Gerar hash de uma senha no servidor ──────────────────────────────
  // POST /gerar-hash  { senha: "texto plano" }
  // Retorna { hash: "scrypt:salt:hash" } — usado ao redefinir senha via
  // recuperação ou troca normal de senha (ver admin-auth.js). Antes gerava
  // SHA-256 puro; agora sempre gera no formato novo (scrypt com salt).
  if (req.method === 'POST' && urlPath === '/gerar-hash') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { senha } = JSON.parse(body);
        if (typeof senha !== 'string') throw new Error('Payload inválido.');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hash: auth.gerarHashSenha(senha) }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // Salvar config.json via POST
  // ── Antes desta mudança, esta rota não exigia NADA — nem senha, nem
  // sessão (README, "Limitações conhecidas") — apesar de controlar
  // baterias, tipos de montagem e dispositivos autorizados. Agora exige
  // a mesma sessão de Administrador das demais rotas administrativas
  // (ver lib/sessao.js) — o front (app-core.js, cfgSalvar) já chama
  // AdminAuth.abrirModal antes de mandar pra cá.
  if (req.method === 'POST' && urlPath === '/salvar-config') {
    if (!sessao.requestTemSessaoValida(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        fs.writeFileSync(path.join(DB_DIR, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── POST /salvar-metas: metas de produção do mês (traços/m²/OEE) —
  // Página de Metas (ver public/js/metas.js). Arquivo PRÓPRIO
  // (metas.json), separado de config.json de propósito: /salvar-config
  // (acima) sobrescreve o arquivo INTEIRO — reaproveitar essa rota pra
  // metas exigiria montar o config.json completo no front toda vez que
  // salvasse uma meta, com risco real de apagar baterias/tipos de
  // montagem/dispositivos autorizados se o front esquecesse de incluir
  // algum bloco (já aconteceu antes com outros campos, ver comentário em
  // _configAtualBaseParaSalvar, app-core.js). Um arquivo pequeno e
  // isolado não tem esse risco.
  // Exige sessão de admin (ver lib/sessao.js), mesma exigência de
  // /salvar-config, acima — unificado junto com ele.
  if (req.method === 'POST' && urlPath === '/salvar-metas') {
    if (!sessao.requestTemSessaoValida(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const metas = JSON.parse(body);
        if (!metas || typeof metas !== 'object' || Array.isArray(metas)) {
          throw new Error('Payload inválido.');
        }
        const CAMPOS_METAS = ['tracosMes', 'm2Mes', 'oeePercentMes'];
        const metasLimpas = {};
        CAMPOS_METAS.forEach(campo => {
          const v = metas[campo];
          if (v === null || v === undefined || v === '') { metasLimpas[campo] = null; return; }
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0) throw new Error(`Campo "${campo}" precisa ser um número positivo ou vazio.`);
          metasLimpas[campo] = n;
        });
        fs.writeFileSync(path.join(DB_DIR, 'metas.json'), JSON.stringify(metasLimpas, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, metas: metasLimpas }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── POST /config/modo-automatico: liga/desliga "🤖 Modo Automático"
  // (Configurações → Automação). DIFERENTE de /salvar-config (acima, que
  // não exige sessão): esta rota exige sessão de admin válida — a senha
  // é pedida de novo no front (ver app-core.js, cfgToggleModoAutomatico,
  // que sempre chama AdminAuth.abrirModal antes, tanto pra ligar quanto
  // pra desligar), e o servidor confirma que essa sessão existe de
  // verdade antes de aceitar a troca — proteção de verdade, não só de UI.
  if (req.method === 'POST' && urlPath === '/config/modo-automatico') {
    if (!sessao.requestTemSessaoValida(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { ativo } = JSON.parse(body);
        if (typeof ativo !== 'boolean') throw new Error('Campo "ativo" precisa ser true ou false.');

        const configPath = path.join(DB_DIR, 'config.json');
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        cfg.modoAutomatico = ativo;
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ativo }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // Salvar security.json via POST
  // ── IMPORTANTE: antes desta mudança, esta rota não exigia senha NEM
  // sessão — bastava mandar um hash no formato certo pra sobrescrever a
  // senha do Administrador sem precisar saber a senha atual. Agora exige
  // uma sessão válida (ver lib/sessao.js), criada em /verificar-senha ou
  // /verificar-recovery — as duas formas de chegar até aqui legitimamente
  // (troca de senha via recuperação é o único fluxo que usa esta rota
  // hoje, ver admin-auth.js, _salvarNovaSenha).
  if (req.method === 'POST' && urlPath === '/salvar-security') {
    if (!sessao.requestTemSessaoValida(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        // Aceita tanto o formato novo ("scrypt:salt:hash", gerado por
        // /gerar-hash a partir desta mudança) quanto o formato legado
        // (SHA-256 puro, 64 hex) — necessário porque, ao trocar só a
        // senha, o front reenvia o recoveryKeyHash ATUAL sem alterar (ver
        // admin-auth.js, _salvarNovaSenha), que pode ainda estar no
        // formato antigo se a chave de recuperação nunca foi regerada.
        // Validação centralizada em lib/auth.js (auth.formatoDeHashValido).
        if (!auth.formatoDeHashValido(payload.passwordHash) || !auth.formatoDeHashValido(payload.recoveryKeyHash)) {
          throw new Error('Payload inválido: hash de senha em formato inesperado.');
        }
        fs.writeFileSync(SECURITY_PATH, JSON.stringify({
          passwordHash:    payload.passwordHash,
          recoveryKeyHash: payload.recoveryKeyHash,
        }, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── GET /db/security.json: ANTES desta mudança, era servido como arquivo
  // estático comum (qualquer um podia acessar /db/security.json direto,
  // sem senha — ver README, "Limitações conhecidas"). O arquivo de verdade
  // já não vive mais em public/ (ver SECURITY_PATH) — então essa URL só
  // funciona se vier com sessão válida (ver lib/sessao.js). É a mesma URL
  // de sempre porque dois lugares no front ainda fazem fetch('db/security.json')
  // direto: admin-auth.js (pra preservar o recoveryKeyHash atual ao trocar
  // de senha) e data.js (LW.gerarBackupDados(), pro "Backup de Dados").
  // Os dois só rodam depois de uma senha/chave de recuperação confirmada,
  // então a sessão já existe nesse ponto — nenhuma mudança no front foi
  // necessária além disso.
  if (req.method === 'GET' && urlPath === '/db/security.json') {
    if (!sessao.requestTemSessaoValida(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
      return;
    }
    try {
      const conteudo = fs.readFileSync(SECURITY_PATH, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(conteudo);
    } catch (_) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ passwordHash: auth.HASH_FALLBACK, recoveryKeyHash: null }));
    }
    return;
  }

  // ── POST /logout-admin: destrói a sessão (ver lib/sessao.js) e expira o
  // cookie no navegador. Chamado por AdminAuth.logout() (admin-auth.js)
  // antes de limpar o localStorage e voltar pro login — sem isso, a sessão
  // no servidor continuaria válida até o tempo expirar por conta própria.
  if (req.method === 'POST' && urlPath === '/logout-admin') {
    sessao.logout(req);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': sessao.cookieDeLogout() });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Registrar operação — grava na tabela operacoes (SQL); em Modo de
  // Teste, continua indo pro JSON isolado de sempre (ver dirParaModoTeste).
  if (req.method === 'POST' && urlPath === '/registrar-operacao') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (!modoTeste && !dispositivoAutorizado(deviceId)) { negarDispositivoNaoAutorizado(res); return; }
      try {
        const record = JSON.parse(body);
        // Campo LEGADO (coluna "operacoes.avaliado" — ver db.js): mantido
        // só como default seguro (sempre 0/false na criação), mas quem
        // decide "esta operação já foi avaliada?" a partir de agora é a
        // tabela "operacoes_avaliadas" (ver db.marcarOperacaoAvaliada /
        // marcarOperacaoMaisAntigaNaoAvaliadaComoAvaliada). Ignora
        // qualquer valor vindo do front pra este campo. Vale pros dois
        // caminhos abaixo (Modo de Teste em JSON e SQLite).
        record.avaliado = false;

        if (modoTeste) {
          const historicoPath = path.join(dirParaModoTeste(modoTeste), 'historico.json');
          let historico = [];
          try { historico = JSON.parse(fs.readFileSync(historicoPath, 'utf8')); } catch (_) {}
          historico.push(record);
          fs.writeFileSync(historicoPath, JSON.stringify(historico, null, 2), 'utf8');
        } else {
          db.prepare(db.SQL_INSERIR_OPERACAO).run({
            ...db.operacaoParaRow(record),
            modo_teste: 0,
            criado_em: new Date().toISOString(),
          });

          // Berços Visuais — 1 linha por berço desta operação. Usa berços
          // REAIS se informado (pode ser menor que a capacidade nominal da
          // bateria — operação parcial), senão a capacidade nominal mesmo
          // (mesma prioridade já usada pelo popover "Bateria Atual" — ver
          // bateria-atual.js, _baCapacidade). Estados: parte do que já foi
          // marcado ao vivo (baixou/vazou — ver GET/POST /bercos-andamento)
          // em vez de nascer tudo 'okay' à toa; e reseta o snapshot ao vivo
          // logo em seguida — essa operação virou histórico agora, o
          // snapshot é só pra enquanto ela está em andamento.
          const qtdBercos = parseInt(record.bercos_reais) || parseInt(record.capacidade) || 0;
          db.criarBercosVisuaisIniciais(record.id, qtdBercos, lerBercosAndamento());
          salvarBercosAndamentoNoDisco({});

          // Entra na fila de avaliação do Setor de Qualidade — ver
          // comentário em OPERACOES_NAO_AVALIADAS_PATH, acima. Nunca em
          // Modo de Teste (esse ramo nem chega aqui — ver `if (modoTeste)`
          // logo acima; mesma regra de sempre pra essa fila).
          adicionarNaFilaNaoAvaliadas(record.id);

          // Avisa todo mundo conectado agora (exceto quem registrou) —
          // dinâmica de "dono" da operação chegou ao fim. Nunca em modo de
          // teste (esse ramo nem chega aqui — ver `if (modoTeste)` acima).
          broadcastOperacaoFinalizada({
            id_bateria: record.id_bateria,
            tempo_min: record.tempo_min,
            total_paineis: record.total_paineis,
            m2_total: record.m2_total,
            desemplaque: record.desemplaque,
            houve_atraso: record.houve_atraso,
          }, queryParams.get('wsClientId') || '');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── EDITAR OPERAÇÃO: corrige um registro da tabela operacoes já existente
  // (UPDATE em cima dele, não cria um novo) e grava um log de auditoria em
  // edicoes_operacao — base pra futuro controle de eficiência de
  // preenchimento das operações ───────────────────────────────────────────
  if (req.method === 'POST' && urlPath === '/editar-operacao') {
    // Antes, a trava de "só Administrador" era só visual (tela) — qualquer
    // um que soubesse a URL podia editar uma operação sem senha nenhuma
    // (ver README, "Limitações conhecidas"). Agora exige a MESMA sessão
    // emitida por POST /verificar-senha (ver lib/sessao.js) — como o
    // perfil Administrador sempre pede senha no login (README, "Perfis de
    // usuário"), a sessão já existe nesse ponto pra quem entrou como
    // Administrador; não é fricção nova pro fluxo normal.
    if (!sessao.requestTemSessaoValida(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada. Volte ao login e entre novamente como Administrador.' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { id, novosValores, diff } = payload;

        if (!id || typeof id !== 'string') throw new Error('ID da operação ausente.');
        if (!novosValores || typeof novosValores !== 'object' || Array.isArray(novosValores)) {
          throw new Error('Payload inválido: "novosValores" ausente.');
        }
        if (!Array.isArray(diff) || !diff.length) {
          throw new Error('Nenhuma alteração informada.');
        }

        // Campos que NUNCA podem ser alterados por aqui — são capturados
        // automaticamente pelo sistema ou são a própria identidade do
        // registro. Checagem no servidor, não só na tela — nunca confiamos
        // só na validação do navegador.
        // houve_atraso é calculado (tempo_min > limite de injeção), não uma
        // escolha manual do operador — nunca editável diretamente.
        // avaliado é controlado pelo Setor de Qualidade, não pelo
        // formulário de edição de operação — mesma lógica.
        const CAMPOS_PROTEGIDOS = new Set(['id', 'data', 'inicio', 'fim', 'tempo_min', 'qtd_tracos', 'tracos', 'houve_atraso', 'avaliado']);
        const tentouAlterarProtegido = Object.keys(novosValores).filter(c => CAMPOS_PROTEGIDOS.has(c));
        if (tentouAlterarProtegido.length) {
          throw new Error('Campo(s) não editável(eis): ' + tentouAlterarProtegido.join(', '));
        }

        const atual = db.prepare('SELECT * FROM operacoes WHERE id = ?').get(id);
        if (!atual) throw new Error('Operação não encontrada (id: ' + id + ').');

        // Mescla em cima do que já está no banco — igual ao spread
        // {...historico[idx], ...novosValores} de antes, só que primeiro
        // convertendo a linha SQL pro formato historico.json (onde
        // novosValores já está, vindo do navegador), e na volta convertendo
        // o resultado mesclado de volta pra parâmetros de coluna.
        const mesclado = { ...db.rowParaOperacao(atual), ...novosValores };

        db.prepare(`
          UPDATE operacoes SET
            dimensao = @dimensao, capacidade = @capacidade, id_bateria = @id_bateria,
            bercos_reais = @bercos_reais, tipo_montagem = @tipo_montagem, turno = @turno,
            motivo_atraso = @motivo_atraso, bercos_personalizados = @bercos_personalizados,
            total_paineis = @total_paineis, m2_total = @m2_total, placas_cimenticia = @placas_cimenticia,
            paineis_por_tipo = @paineis_por_tipo, m2_por_tipo = @m2_por_tipo,
            paineis_2p = @paineis_2p, paineis_sp = @paineis_sp, m2_2p = @m2_2p, m2_sp = @m2_sp
          WHERE id = @id
        `).run(db.operacaoParaRow(mesclado));

        // Log de auditoria — append-only, nunca apaga/sobrescreve entradas
        // antigas. Cada edição (mesmo que no mesmo id) gera uma entrada nova.
        db.prepare(`
          INSERT INTO edicoes_operacao (id_operacao, data_edicao, campos_alterados)
          VALUES (?, ?, ?)
        `).run(id, new Date().toISOString(), JSON.stringify(diff));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── EDITAR TRAÇO (Relatório de Injeção): corrige um traço já registrado
  // em relatorio_injecao.json (id_bateria/berços/obs do USO específico
  // clicado, dados de identificação do traço, e os 5 insumos + tempo de
  // batida) e, ao mesmo tempo, REGRAVA ajustes_tracos.json pra esse
  // id_traco a partir da mesma lista de ajustes editada — esse arquivo é
  // a fonte de verdade dos ajustes a partir de agora; os campos
  // "*_real"/tempo_batida de relatorio_injecao.json (.ajustes[]) são
  // sempre DERIVADOS dele aqui, nunca editados soltos, pra nunca mais
  // ficarem fora de sincronia. Densidade/Flow não passam por
  // ajustes_tracos.json (são remedições, não ajustes de receita — ver
  // README), então continuam com sua própria lista de leituras.
  // Auditoria em relatorio_edicoes.json (mesmo padrão de
  // historico_edicoes.json, indexado por id_traco).
  if (req.method === 'POST' && urlPath === '/editar-traco-relatorio') {
    // Mesma checagem aplicada a /editar-operacao, acima — ver comentário lá.
    if (!sessao.requestTemSessaoValida(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada. Volte ao login e entre novamente como Administrador.' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { id_traco, id_operacao, novosValores, ajustes, diff } = payload;

        if (!id_traco || typeof id_traco !== 'string') throw new Error('ID do traço ausente.');
        if (!id_operacao || typeof id_operacao !== 'string') throw new Error('ID da operação (uso) ausente.');
        if (!novosValores || typeof novosValores !== 'object' || Array.isArray(novosValores)) {
          throw new Error('Payload inválido: "novosValores" ausente.');
        }
        if (!Array.isArray(ajustes)) throw new Error('Payload inválido: "ajustes" precisa ser uma lista.');
        if (!Array.isArray(diff) || !diff.length) throw new Error('Nenhuma alteração informada.');

        // Cada ajuste precisa de tempo_batida (minutos, > 0) — mesma regra
        // do Ajuste de Receita ao vivo, em Registrar Operação.
        ajustes.forEach((a, i) => {
          if (!a || typeof a !== 'object' || typeof a.tempo_batida !== 'number' || a.tempo_batida <= 0) {
            throw new Error(`Ajuste #${i + 1}: "tempo_batida" obrigatório (minutos, > 0).`);
          }
        });

        const traco = db.prepare('SELECT * FROM tracos WHERE id_traco = ?').get(id_traco);
        if (!traco) throw new Error('Traço não encontrado (id_traco: ' + id_traco + ').');

        const uso = db.prepare('SELECT * FROM traco_usos WHERE id_traco = ? AND id_operacao = ?').get(id_traco, id_operacao);
        if (!uso) throw new Error('Uso/operação não encontrado pra esse traço (id_operacao: ' + id_operacao + ').');

        db.transaction(() => {
          // Dados do USO específico clicado (id_bateria/berços/obs) — só
          // essa linha de traco_usos, nunca as outras (mesmo traço pode
          // ter sido reaproveitado em mais de uma bateria).
          if (novosValores.uso) {
            db.prepare(`
              UPDATE traco_usos SET id_bateria = @id_bateria, berco_inicio = @berco_inicio,
                berco_finalizacao = @berco_finalizacao, obs = @obs
              WHERE id_traco = @id_traco AND id_operacao = @id_operacao
            `).run({
              id_traco, id_operacao,
              id_bateria: novosValores.uso.id_bateria ?? uso.id_bateria,
              berco_inicio: novosValores.uso.berco_inicio ?? uso.berco_inicio,
              berco_finalizacao: novosValores.uso.berco_finalizacao ?? uso.berco_finalizacao,
              obs: novosValores.uso.obs ?? uso.obs,
            });
          }

          // Identificação do traço (compartilhada entre todos os usos) +
          // os "originais" dos insumos/tempo de batida, que vêm prontos do
          // formulário (sem colapso — diferente da migração/registro ao
          // vivo, aqui o original já é exatamente o que a pessoa digitou).
          const originais = novosValores.originais || {};
          db.prepare(`
            UPDATE tracos SET
              num_traco = @num_traco, densidade_eps = @densidade_eps, silo = @silo, expansao = @expansao,
              cimento_original = @cimento_original, agua_original = @agua_original, eps_original = @eps_original,
              superplast_original = @superplast_original, incorporador_original = @incorporador_original,
              tempo_batida_original = @tempo_batida_original,
              densidade_original = @densidade_original, flow_original = @flow_original
            WHERE id_traco = @id_traco
          `).run({
            id_traco,
            num_traco: ('num_traco' in novosValores) ? novosValores.num_traco : traco.num_traco,
            densidade_eps: ('densidade_eps' in novosValores) ? novosValores.densidade_eps : traco.densidade_eps,
            silo: ('silo' in novosValores) ? novosValores.silo : traco.silo,
            expansao: ('expansao' in novosValores) ? novosValores.expansao : traco.expansao,
            cimento_original: numOuNulo(originais.cimento_real),
            agua_original: numOuNulo(originais.agua_real),
            eps_original: numOuNulo(originais.eps_real),
            superplast_original: numOuNulo(originais.superplast_real),
            incorporador_original: numOuNulo(originais.incorporador_real),
            // tempo_batida_min (formulário, minutos) -> segundos (mesma unidade de sempre em "tracos")
            tempo_batida_original: (originais.tempo_batida_min !== '' && originais.tempo_batida_min != null)
              ? Number(originais.tempo_batida_min) * 60 : null,
            densidade_original: novosValores.densidade ? numOuNulo(novosValores.densidade.original) : traco.densidade_original,
            flow_original: novosValores.flow ? numOuNulo(novosValores.flow.original) : traco.flow_original,
          });

          // Ajustes: substitui TODOS de uma vez (apaga + reinsere
          // renumerado 1..N) — mais simples e seguro que tentar calcular um
          // diff linha a linha, e o volume por traço é sempre pequeno.
          db.prepare('DELETE FROM ajustes WHERE id_traco = ?').run(id_traco);
          const inserirAjuste = db.prepare(db.SQL_INSERIR_AJUSTE);
          ajustes.forEach((a, i) => {
            inserirAjuste.run({
              id_traco, ordem: i + 1, tempo_batida: a.tempo_batida,
              cimento: numOuNulo(a.cimento), agua: numOuNulo(a.agua), eps: numOuNulo(a.eps),
              superplast: numOuNulo(a.superplast), incorporador: numOuNulo(a.incorporador),
              registrado_em: a.registrado_em || new Date().toISOString(),
            });
          });

          // Densidade/Flow: mesma ideia — substitui as leituras inteiras.
          const inserirLeitura = db.prepare(db.SQL_INSERIR_LEITURA);
          ['densidade', 'flow'].forEach(campo => {
            if (!novosValores[campo]) return;
            db.prepare('DELETE FROM leituras_resultado WHERE id_traco = ? AND campo = ?').run(id_traco, campo);
            const leituras = Array.isArray(novosValores[campo].leituras) ? novosValores[campo].leituras : [];
            leituras.forEach((valor, i) => {
              inserirLeitura.run({ id_traco, campo, valor: Number(valor), ordem: i + 1 });
            });
          });

          // Log de auditoria — append-only, mesmo padrão de edicoes_operacao.
          db.prepare(`
            INSERT INTO edicoes_traco (id_traco, id_operacao, data_edicao, campos_alterados)
            VALUES (?, ?, ?, ?)
          `).run(id_traco, id_operacao, new Date().toISOString(), JSON.stringify(diff));
        })();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // Registrar linhas do relatório de injeção — grava nas tabelas tracos/
  // traco_usos/leituras_resultado (SQL); em Modo de Teste, continua indo
  // pro JSON isolado de sempre.
  if (req.method === 'POST' && urlPath === '/registrar-relatorio-injecao') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (!modoTeste && !dispositivoAutorizado(deviceId)) { negarDispositivoNaoAutorizado(res); return; }
      try {
        const dadosRecebidos = JSON.parse(body);

        if (modoTeste) {
          const relatorioPath = path.join(dirParaModoTeste(true), 'relatorio_injecao.json');
          let relatorio = [];
          try { relatorio = JSON.parse(fs.readFileSync(relatorioPath, 'utf8')); } catch (_) { relatorio = []; }
          dadosRecebidos.forEach(novoTraco => {
            const registroExistente = relatorio.find(r => r.id_traco === novoTraco.id_traco);
            if (registroExistente) {
              if (!registroExistente.ultilizado) registroExistente.ultilizado = { operacao: [] };
              registroExistente.ultilizado.operacao.push(...novoTraco.ultilizado.operacao);
            } else {
              relatorio.push(novoTraco);
            }
          });
          fs.writeFileSync(relatorioPath, JSON.stringify(relatorio, null, 2), 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // Caminho real (SQL):
        const inserirTraco = db.prepare(db.SQL_INSERIR_TRACO);
        const inserirUso = db.prepare(db.SQL_INSERIR_USO);
        const inserirLeitura = db.prepare(db.SQL_INSERIR_LEITURA);

        db.transaction(() => {
          dadosRecebidos.forEach(novoTraco => {
            const tracoExiste = db.prepare('SELECT 1 FROM tracos WHERE id_traco = ?').get(novoTraco.id_traco);

            if (!tracoExiste) {
              // Traço novo: os 5 insumos + tempo de batida confiam no
              // .original do payload SE já existir ajuste pra esse traço
              // na tabela "ajustes" (gravado ao vivo, durante a operação,
              // via /registrar-ajuste-traco) — senão colapsa original+
              // ajustes num único total (mesma regra da migração; ver
              // README, "Banco de Dados (SQLite)" -> Fase 5).
              const jaTemAjustes = !!db.prepare('SELECT 1 FROM ajustes WHERE id_traco = ? LIMIT 1').get(novoTraco.id_traco);

              const paramsTraco = {
                id_traco: novoTraco.id_traco, data: novoTraco.data, turno: novoTraco.turno ?? null,
                num_traco: novoTraco.num_traco ?? null,
              };
              const CAMPOS_SOMA_LOCAIS = [
                ['cimento_real', 'cimento_original'], ['agua_real', 'agua_original'], ['eps_real', 'eps_original'],
                ['superplast_real', 'superplast_original'], ['incorporador_real', 'incorporador_original'],
              ];
              CAMPOS_SOMA_LOCAIS.forEach(([campoJson, coluna]) => {
                const original = db.extrairOriginal(novoTraco[campoJson]);
                const ajustesDoCampo = db.extrairAjustesNumericos(novoTraco[campoJson]);
                paramsTraco[coluna] = (jaTemAjustes || !ajustesDoCampo.length)
                  ? original
                  : (original || 0) + ajustesDoCampo.reduce((s, v) => s + v, 0);
              });
              {
                const original = db.extrairOriginal(novoTraco.tempo_batida);
                const ajustesDoCampo = db.extrairAjustesNumericos(novoTraco.tempo_batida);
                paramsTraco.tempo_batida_original = (jaTemAjustes || !ajustesDoCampo.length)
                  ? original
                  : (original || 0) + ajustesDoCampo.reduce((s, v) => s + v, 0);
              }
              paramsTraco.densidade_original = db.extrairOriginal(novoTraco.densidade);
              paramsTraco.flow_original = db.extrairOriginal(novoTraco.flow);
              paramsTraco.obs = novoTraco.obs ?? null;
              paramsTraco.silo = novoTraco.silo ?? null;
              paramsTraco.expansao = novoTraco.expansao ?? null;
              paramsTraco.densidade_eps = novoTraco.densidade_eps ?? null;

              inserirTraco.run(paramsTraco);

              // Leituras de densidade/flow — traço é novo, nunca teve
              // nenhuma leitura registrada ainda.
              ['densidade', 'flow'].forEach(campo => {
                db.extrairAjustesNumericos(novoTraco[campo]).forEach((valor, i) => {
                  inserirLeitura.run({ id_traco: novoTraco.id_traco, campo, valor, ordem: i + 1 });
                });
              });
            }

            // Em qualquer caso (novo ou reaproveitado): adiciona o(s) uso(s)
            // — mesmo comportamento de sempre, nunca toca em outro campo do
            // traço quando ele já existe (nem densidade/flow, se mudou
            // nesse reaproveitamento — limitação que já existia antes
            // desta migração, replicada de propósito, não introduzida agora).
            (novoTraco.ultilizado?.operacao || []).forEach(uso => {
              inserirUso.run({
                id_traco: novoTraco.id_traco,
                id_operacao: uso.id_operacao ?? '',
                id_bateria: uso.id_bateria ?? null,
                berco_inicio: uso.berco_inicio ?? null,
                berco_finalizacao: uso.berco_finalizacao ?? null,
                obs: uso.obs ?? null,
              });
            });
          });
        })();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // Importar lote de relatório de injeção — cada linha da planilha não tem
  // id_traco nem id_operacao reais (não vem de uma operação de verdade),
  // então gera um id_traco sintético por linha e cria um traco_usos com o
  // id_operacao sintético que o navegador já mandou (sem FK pra
  // "operacoes" de propósito — ver schema em db.js).
  // Antes desta mudança, importar dados em massa não exigia NADA (nem
  // senha, nem sessão) — só a UI escondia o botão pra quem não fosse
  // Administrador. Agora exige a mesma sessão das demais rotas
  // administrativas (ver lib/sessao.js).
  if (req.method === 'POST' && urlPath === '/importar-relatorio-injecao') {
    if (!sessao.requestTemSessaoValida(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const novos = JSON.parse(body);
        if (!Array.isArray(novos)) throw new Error('Payload deve ser um array');

        // Mesma checagem de duplicata de sempre (id_operacao+num_traco) —
        // na prática quase nunca encontra nada, já que id_operacao é
        // gerado novo a cada importação (era assim também antes desta
        // migração; não é uma regressão introduzida agora).
        const existentes = new Set(
          db.prepare(`
            SELECT tu.id_operacao || '|' || t.num_traco AS chave
            FROM traco_usos tu JOIN tracos t ON t.id_traco = tu.id_traco
          `).all().map(r => r.chave)
        );

        const inserirTraco = db.prepare(db.SQL_INSERIR_TRACO);
        const inserirUso = db.prepare(db.SQL_INSERIR_USO);
        let inseridos = 0, duplicatas = 0;

        const importarTudo = db.transaction((lista) => {
          lista.forEach((r, i) => {
            const chave = r.id_operacao + '|' + r.num_traco;
            if (existentes.has(chave)) { duplicatas++; return; }

            const idTraco = 'imp_traco_' + Date.now() + '_' + i;
            inserirTraco.run({
              id_traco: idTraco, data: r.data, turno: r.turno ?? null, num_traco: r.num_traco ?? null,
              cimento_original: numOuNulo(r.cimento), agua_original: numOuNulo(r.agua),
              eps_original: null, // planilha de importação nunca teve coluna de EPS — lacuna pré-existente
              superplast_original: numOuNulo(r.superplast), incorporador_original: numOuNulo(r.incorporador),
              tempo_batida_original: numOuNulo(r.tempo_batida), // já em segundos, igual ao registro ao vivo
              densidade_original: numOuNulo(r.densidade), flow_original: numOuNulo(r.flow),
              obs: r.obs ?? null, silo: r.silo ?? null, expansao: r.expansao ?? null,
              densidade_eps: r.densidade_eps ?? null,
            });
            inserirUso.run({
              id_traco: idTraco, id_operacao: r.id_operacao ?? '', id_bateria: r.id_bateria ?? null,
              berco_inicio: r.berco_ini ?? null, berco_finalizacao: r.berco_fim ?? null, obs: r.obs ?? null,
            });
            existentes.add(chave);
            inseridos++;
          });
        });
        importarTudo(novos);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, inseridos, duplicatas }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // Importar lote de registros — insere na tabela operacoes, com a mesma
  // deduplicação de sempre (por id, ou por data+bateria+turno pra
  // registros antigos sem id).
  // Mesma exigência de /importar-relatorio-injecao, acima.
  if (req.method === 'POST' && urlPath === '/importar-historico') {
    if (!sessao.requestTemSessaoValida(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const novos = JSON.parse(body);
        if (!Array.isArray(novos)) throw new Error('Payload deve ser um array');

        const existentesRows = db.prepare('SELECT id, data, id_bateria, turno FROM operacoes').all();
        const existentes = new Set(existentesRows.map(r => r.id || (r.data + '|' + r.id_bateria + '|' + r.turno)));

        const inserirOperacao = db.prepare(db.SQL_INSERIR_OPERACAO);
        let inseridos = 0, duplicatas = 0;

        const importarTudo = db.transaction((lista) => {
          for (const r of lista) {
            const chave = r.id || (r.data + '|' + r.id_bateria + '|' + r.turno);
            if (existentes.has(chave)) { duplicatas++; continue; }
            inserirOperacao.run({
              ...db.operacaoParaRow(r),
              modo_teste: 0,
              criado_em: new Date().toISOString(),
            });
            existentes.add(chave);
            inseridos++;
          }
        });
        importarTudo(novos);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, inseridos, duplicatas }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── MESCLAR BACKUP DE DADOS: soma os registros de um "Backup de Dados"
  // de OUTRA instalação do mesmo sistema ao banco ATUAL — diferente de
  // /restaurar-backup-dados (que SUBSTITUI tudo), aqui nada existente é
  // apagado ou alterado, só linhas novas são adicionadas (com a mesma
  // deduplicação de sempre, pra rodar de novo com o mesmo arquivo não
  // duplicar nada). Usa a MESMA validação de formato/senha do restore.
  // De propósito, NUNCA mescla: config.json, security.json, sobra.json,
  // contador_tracos.json — são estado/config DESTA instalação, não dados
  // de produção pra trazer de outra fábrica/linha.
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

        // Mesma validação de formato de sempre — nunca confia só no que o
        // navegador já checou antes de mandar pra cá.
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
          // Operações (historico.json) — mesma chave de dedup de /importar-historico.
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

          // Auditoria de edição (historico_edicoes.json) — só entra a edição
          // de uma operação que TAMBÉM veio nesta mesma mescla (edição de
          // uma operação que já existia aqui antes não agrega nada de novo).
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

          // Traços + ajustes + leituras (relatorio_injecao.json + ajustes_tracos.json)
          if (conteudo['relatorio_injecao.json']) {
            const ajustes = conteudo['ajustes_tracos.json'] || [];
            const r = db.mesclarTracosEAjustes(conteudo['relatorio_injecao.json'], ajustes);
            resultado.tracos.inseridos = r.tracosInseridos;
            resultado.tracos.duplicatas = r.tracosDuplicados;
          }

          // Paradas — id próprio já globalmente único, dedup direto por ele.
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
    return;
  }

  // ── POST /leitura-automatica: recebe UMA leitura vinda de fora (hoje só
  // via teste manual — a fonte real seria um coletor Modbus TCP lendo o
  // CLP da linha de produção, que ainda não está conectado, ver README,
  // "Modo Automático") e transmite via WebSocket pra quem estiver com
  // "🤖 Modo Automático" ativo em Registrar Operação (ver operacao.js,
  // _aplicarLeituraAutomatica) — essa tela decide o que fazer com a
  // leitura; esta rota só valida o formato mínimo e repassa.
  //
  // 2 formatos aceitos:
  //   Insumo (balança):  { tipo:'insumo', campo:'cimento_real', valor:512.3, traco:1 }
  //     - campo: um dos 5 insumos reais do traço (ver CAMPOS_INSUMO_VALIDOS)
  //     - traco: número do traço (t.num) a que se refere — opcional, se
  //       omitido a tela aplica no traço selecionado no momento
  //   Berço (injetora):  { tipo:'berco', berco:'B7' }
  //     - ainda SEM AÇÃO definida do lado da tela (só chega e é logada) —
  //       falta decidir o que uma leitura de berço da injetora deve mudar
  //       (ver operacao.js)
  //
  // Sem exigir dispositivo autorizado nem sessão de admin de propósito:
  // mesmo espírito de baixa fricção de /marcar-berco-andamento — é uma
  // leitura de sensor, não um controle da operação em si.
  const CAMPOS_INSUMO_VALIDOS = new Set(['cimento_real', 'agua_real', 'eps_real', 'superplast_real', 'incorporador_real']);
  if (req.method === 'POST' && urlPath === '/leitura-automatica') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const leitura = JSON.parse(body);
        if (!leitura || (leitura.tipo !== 'insumo' && leitura.tipo !== 'berco')) {
          throw new Error('Campo "tipo" precisa ser "insumo" ou "berco".');
        }

        // Confere o flag GLOBAL (Configurações → Automação), não mais um
        // estado por operação — rejeita cedo se ninguém ligou o Modo
        // Automático, pra um coletor mal configurado não ficar mandando
        // leituras que nunca serão aplicadas (e pra deixar claro pra quem
        // está testando a integração que precisa ligar o modo primeiro).
        const cfgAtual = JSON.parse(fs.readFileSync(path.join(DB_DIR, 'config.json'), 'utf8'));
        if (cfgAtual.modoAutomatico !== true) {
          throw new Error('Modo Automático está desligado (Configurações → Automação).');
        }
        if (leitura.tipo === 'insumo') {
          if (!CAMPOS_INSUMO_VALIDOS.has(leitura.campo)) {
            throw new Error('Campo de insumo inválido: ' + leitura.campo);
          }
          if (typeof leitura.valor !== 'number' || !isFinite(leitura.valor)) {
            throw new Error('"valor" precisa ser um número.');
          }
        } else if (leitura.tipo === 'berco') {
          if (!leitura.berco || typeof leitura.berco !== 'string' || !/^B\d+$/.test(leitura.berco)) {
            throw new Error('Berço inválido.');
          }
        }

        broadcastLeituraAutomatica(leitura);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── AJUSTES DE TRAÇO: registra um ajuste (insumo + tempo de batida juntos)
  // no histórico de auditoria — não interfere no traço em si (que já foi
  // salvo no historico.json/relatorio_injecao.json); isso é só o "log" de
  // qual ajuste veio com qual tempo de batida, organizado por traço.
  // Numeração de "ajuste_N" é decidida AQUI no servidor (não no navegador)
  // pra evitar duas abas/operações gerando o mesmo número pro mesmo traço.
  if (req.method === 'POST' && urlPath === '/registrar-ajuste-traco') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { id_traco, ajuste } = JSON.parse(body);
        if (!id_traco || typeof id_traco !== 'string') {
          throw new Error('Payload inválido: "id_traco" obrigatório.');
        }
        if (!ajuste || typeof ajuste !== 'object' || Array.isArray(ajuste)) {
          throw new Error('Payload inválido: "ajuste" obrigatório.');
        }
        if (typeof ajuste.tempo_batida !== 'number' || ajuste.tempo_batida <= 0) {
          throw new Error('"ajuste.tempo_batida" obrigatório (minutos, > 0).');
        }

        if (modoTeste) {
          const ajustesPath = path.join(dirParaModoTeste(true), 'ajustes_tracos.json');
          let ajustesTracos = [];
          try { ajustesTracos = JSON.parse(fs.readFileSync(ajustesPath, 'utf8') || '[]'); } catch (_) {}
          if (!Array.isArray(ajustesTracos)) ajustesTracos = [];

          let entrada = ajustesTracos.find(e => e.id_traco === id_traco);
          if (!entrada) { entrada = { id_traco }; ajustesTracos.push(entrada); }

          const numerosExistentes = Object.keys(entrada)
            .map(k => /^ajuste_(\d+)$/.exec(k)).filter(Boolean).map(m => parseInt(m[1], 10));
          const proximoNumero = (numerosExistentes.length ? Math.max(...numerosExistentes) : 0) + 1;
          entrada['ajuste_' + proximoNumero] = { ...ajuste, registrado_em: new Date().toISOString() };

          const tmp = ajustesPath + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(ajustesTracos, null, 2), 'utf8');
          fs.renameSync(tmp, ajustesPath);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ajusteNumero: proximoNumero }));
          return;
        }

        // Caminho real (SQL): "ordem" = próximo número sequencial pra esse
        // id_traco — não tem FK pra "tracos" de propósito (ver schema em
        // db.js): este ajuste ao vivo acontece ANTES do traço existir lá,
        // já que só é registrado de verdade ao finalizar a operação.
        const ultimaOrdem = db.prepare('SELECT MAX(ordem) AS m FROM ajustes WHERE id_traco = ?').get(id_traco).m || 0;
        const proximaOrdem = ultimaOrdem + 1;

        db.prepare(db.SQL_INSERIR_AJUSTE).run({
          id_traco,
          ordem: proximaOrdem,
          tempo_batida: ajuste.tempo_batida,
          cimento: ajuste.cimento ?? null,
          agua: ajuste.agua ?? null,
          eps: ajuste.eps ?? null,
          superplast: ajuste.superplast ?? null,
          incorporador: ajuste.incorporador ?? null,
          registrado_em: new Date().toISOString(),
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ajusteNumero: proximaOrdem }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── BACKUP GERAL: zipa o projeto inteiro (código + dados) e envia pra
  // download — usado pelo card "Backup Geral" no menu (admin) ───────────────
  // Antes desta mudança, esta rota não exigia NADA — e ela baixa o
  // PROJETO INTEIRO (código + todos os dados), incluindo security.json
  // (os hashes de senha) — o maior vazamento possível de credenciais do
  // sistema, se alguém soubesse a URL. Agora exige a mesma sessão de
  // Administrador das demais rotas administrativas.
  if (req.method === 'GET' && urlPath === '/backup-geral') {
    if (!sessao.requestTemSessaoValida(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
      return;
    }
    gerarBackupGeral().then(buffer => {
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
    return;
  }

  // ── BACKUPS AUTOMÁTICOS: lista os backups diários disponíveis (até 3) ──────
  // Mesma exigência de sessão — a listagem e o download individual (logo
  // abaixo) incluem security.json (ver ARQUIVOS_BACKUP_DB, data.js), então
  // merecem a mesma proteção do Backup Geral, acima.
  if (req.method === 'GET' && urlPath === '/backups-automaticos') {
    if (!sessao.requestTemSessaoValida(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
      return;
    }
    try {
      fs.mkdirSync(DIR_BACKUPS_AUTO, { recursive: true });
      const backups = fs.readdirSync(DIR_BACKUPS_AUTO)
        .filter(f => f.startsWith(PREFIXO_BACKUP_AUTO) && f.endsWith('.zip'))
        .sort()
        .reverse() // mais recente primeiro
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
    return;
  }

  // ── BACKUPS AUTOMÁTICOS: baixa um arquivo específico ────────────────────
  if (req.method === 'GET' && urlPath.startsWith('/backups-automaticos/')) {
    if (!sessao.requestTemSessaoValida(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
      return;
    }
    const nome = decodeURIComponent(urlPath.slice('/backups-automaticos/'.length));
    // Nome tem que bater exatamente com o padrão esperado — nada de path
    // traversal ou nome arbitrário chegando ao path.join().
    if (!/^backup-dados_\d{4}-\d{2}-\d{2}\.zip$/.test(nome)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: 'Nome de arquivo inválido.' }));
      return;
    }
    fs.readFile(path.join(DIR_BACKUPS_AUTO, nome), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${nome}"`,
      });
      res.end(data);
    });
    return;
  }

  // ── RESTAURAR BACKUP DE DADOS: substitui os arquivos de public/db/ a
  // partir de um backup, com várias camadas de segurança ─────────────────────
  if (req.method === 'POST' && urlPath === '/restaurar-backup-dados') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { senha, arquivos } = payload;

        // 1) Senha de administrador é re-verificada AQUI, no servidor — não
        // basta o front achar que o usuário está logado como admin.
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

        // 2) Valida a estrutura de cada arquivo — nunca confiamos só na
        // validação já feita no navegador.
        if (!arquivos || typeof arquivos !== 'object') {
          throw new Error('Payload inválido: "arquivos" ausente.');
        }
        const esperados = Object.keys(VALIDADORES_BACKUP_DADOS);
        // Arquivos adicionados DEPOIS do lançamento (bercos_visuais.json,
        // avaliacoes_qualidade.json, operacoes_avaliadas.json — tabelas
        // que só passaram a existir/ser exportadas em versões mais novas;
        // operacoes_nao_avaliadas.json — arquivo literal, mas pelo mesmo
        // motivo: só passou a existir depois) são OPCIONAIS aqui: um
        // backup ANTIGO, gerado antes de existirem, nunca vai ter esses
        // arquivos dentro do .zip — e isso é normal, não motivo pra
        // recusar a restauração inteira. Sem essa lista, TODO backup feito
        // antes de qualquer um desses recursos existir ficava impossível
        // de restaurar (sempre "Backup incompleto — faltam: ..."), mesmo
        // sendo, fora isso, um backup perfeitamente válido. Se o arquivo
        // VIER no backup, continua sendo validado normalmente (nem
        // opcional nem obrigatório muda a validação em si) — só não trava
        // tudo se estiver faltando. Pra operacoes_nao_avaliadas.json
        // especificamente, faltando + (historico.json OU
        // operacoes_avaliadas.json presentes) dispara o recálculo
        // automático a partir do SQL — ver recalcularFilaNaoAvaliadasApartirDoSql,
        // chamada mais abaixo, depois de todas as tabelas restauradas.
        const OPCIONAIS_BACKUP_DADOS = ['bercos_visuais.json', 'avaliacoes_qualidade.json', 'operacoes_avaliadas.json', 'operacoes_nao_avaliadas.json'];
        const obrigatorios = esperados.filter(n => !OPCIONAIS_BACKUP_DADOS.includes(n));
        const faltando = obrigatorios.filter(nome => typeof arquivos[nome] !== 'string');
        if (faltando.length) {
          throw new Error('Backup incompleto — faltam: ' + faltando.join(', '));
        }
        // Só os arquivos que REALMENTE vieram no payload — um opcional
        // ausente simplesmente não entra aqui, e as tabelas dele (ver
        // "presentes.includes(...)" mais abaixo) ficam como estão, sem
        // apagar nem perder o que já existia antes da restauração.
        const presentes = esperados.filter(nome => typeof arquivos[nome] === 'string');
        const textosValidados = {};
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
          textosValidados[nome] = arquivos[nome];
        }

        // 3) Backup de segurança do estado ATUAL antes de sobrescrever
        // qualquer coisa. Fica fora de public/ — nunca é servido pela web.
        // historico.json/historico_edicoes.json não existem mais como
        // arquivo (Fase 2 — ver "Banco de Dados (SQLite)" no README):
        // o backup de segurança deles é um DUMP do conteúdo atual da
        // tabela, no mesmo formato de sempre.
        const carimbo = todayBrasiliaServer() + '_' + Date.now();
        const dirSeguranca = path.join(ROOT_DIR, 'backups-seguranca', 'pre-restore_' + carimbo);
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

        // 4) Escreve tudo em arquivos .tmp primeiro; só promove (rename) pro
        // nome final depois que TODOS os .tmp foram gravados com sucesso —
        // minimiza o risco de deixar a pasta db/ num estado inconsistente.
        // historico.json/historico_edicoes.json/paradas.json/sobra.json/
        // contador_tracos.json/relatorio_injecao.json/ajustes_tracos.json
        // não entram nessa escrita em arquivo — substituem o conteúdo das
        // tabelas SQL direto (também só depois que TODOS os outros
        // arquivos .tmp já foram validados e gravados, pra manter a mesma
        // garantia de "tudo ou nada").
        //
        // BUG CORRIGIDO: filtra também por "presentes" — antes, um arquivo
        // LITERAL (não-SQL) que fosse OPCIONAL (ver OPCIONAIS_BACKUP_DADOS,
        // acima) e estivesse ausente deste backup específico ainda assim
        // entrava aqui (só não estava na lista de exclusão SQL), e
        // `textosValidados[nome]` vinha `undefined` — fs.writeFileSync
        // quebrava com "Received undefined" e a restauração INTEIRA
        // falhava, mesmo com todo o resto do backup válido. Não dava pra
        // notar antes porque todo arquivo literal, até aqui, também era
        // sempre obrigatório — operacoes_nao_avaliadas.json é o 1º caso de
        // "literal E opcional" ao mesmo tempo.
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

        // ATENÇÃO — ordem crítica: várias tabelas têm FK pra "operacoes(id)"
        // com PRAGMA foreign_keys=ON sempre ligado (bercos_visuais,
        // avaliacoes_qualidade, avaliacao_paineis, operacoes_avaliadas —
        // ver CREATE TABLE de cada uma, db.js). Sem limpar essas ANTES,
        // o "DELETE FROM operacoes" do bloco historico.json, logo abaixo,
        // falha com "FOREIGN KEY constraint failed" sempre que alguma
        // delas tiver QUALQUER linha apontando pra uma operação existente
        // — ou seja, em qualquer instalação já usada de verdade (todo
        // registro de operação já cria uma linha em bercos_visuais na
        // hora). Isso derrubava a restauração inteira (nada era escrito,
        // o catch mais abaixo só devolvia o erro), silenciosamente exceto
        // pela mensagem de erro — nenhum dado chegava a ser perdido, mas
        // "Restaurar Dados" simplesmente nunca funcionava.
        // avaliacao_paineis primeiro (referencia avaliacoes_qualidade
        // TAMBÉM, mesmo problema em cascata — ver substituirAvaliacoes
        // Qualidade, db.js, que já tinha essa ordem certa só pra ELA
        // mesma). Os dados novos de cada uma são reinseridos mais abaixo
        // (bercos_visuais.json/avaliacoes_qualidade.json/operacoes_
        // avaliadas.json) — limpar aqui não perde nada, só resolve a ordem.
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
          // Faltava completamente — o arquivo já era validado (formato
          // certo), mas nunca era de fato usado pra repor nada: restaurar
          // um backup sempre deixava o histórico de edição de traço como
          // estava antes (perdido se o restore também limpou os traços).
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
            : db.todosOsAjustesTracosJSON(); // não fazia parte deste backup — preserva os ajustes atuais
          db.transaction(() => db.substituirTracosEAjustes(novoRelatorio, novosAjustes))();
        } else if (presentes.includes('ajustes_tracos.json')) {
          // Raro (backup só com ajustes, sem o relatório) — ainda assim
          // substitui só os ajustes, preservando os traços como estão.
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
        // Rede de segurança: operacoes_nao_avaliadas.json já foi escrito
        // (arquivo literal, ver "nomesArquivo" acima) SE ele veio no
        // backup enviado. Mas se veio um backup ANTIGO (de antes deste
        // arquivo existir) que trouxe historico.json e/ou
        // operacoes_avaliadas.json — SEM trazer este —, o que já estava
        // em disco ficaria fora de sincronia com as tabelas SQL recém-
        // substituídas. Recalcula do zero nesse caso específico (ver
        // recalcularFilaNaoAvaliadasApartirDoSql, acima).
        if (!presentes.includes('operacoes_nao_avaliadas.json')
          && (presentes.includes('historico.json') || presentes.includes('operacoes_avaliadas.json'))) {
          try { recalcularFilaNaoAvaliadasApartirDoSql(); }
          catch (e) { console.error('Falha ao recalcular a fila de avaliação depois da restauração:', e.message); }
        }

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
    return;
  }

  // ── RESTAURAR BACKUP GERAL: sobrescreve o projeto inteiro (código +
  // dados) a partir de um Backup Geral — operação de alto risco, com
  // camadas extras de segurança em relação à restauração de dados ──────────
  if (req.method === 'POST' && urlPath === '/restaurar-backup-geral') {
    let body = '';
    let tamanho = 0;
    let abortado = false;
    const LIMITE_BYTES = 80 * 1024 * 1024; // bem acima do tamanho real do projeto

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

    req.on('end', async () => {
      if (abortado) return;
      try {
        const payload = JSON.parse(body);
        const { senha, confirmacao, arquivos } = payload;

        // 1) Senha de administrador + frase de confirmação — duas barreiras
        // antes de tocar em qualquer arquivo, dado o tamanho do estrago
        // possível aqui (isso sobrescreve o código do próprio servidor).
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

        // 2) Estrutura básica do payload.
        if (!arquivos || typeof arquivos !== 'object' || Array.isArray(arquivos)) {
          throw new Error('Payload inválido: "arquivos" ausente.');
        }
        const nomes = Object.keys(arquivos);
        if (!nomes.length) throw new Error('Backup vazio.');
        if (nomes.length > 500) {
          throw new Error('Backup com número de arquivos suspeito (>500) — recusado por segurança.');
        }

        // 3) Marcadores mínimos de que isso É um Backup Geral (e não, por
        // exemplo, um Backup de Dados enviado pro endpoint errado).
        const ESSENCIAIS = ['server.js', 'package.json', 'public/index.html'];
        const essenciaisFaltando = ESSENCIAIS.filter(n => typeof arquivos[n] !== 'string');
        if (essenciaisFaltando.length) {
          throw new Error('Isso não parece ser um Backup Geral — faltam: ' + essenciaisFaltando.join(', '));
        }

        // 4) Valida CADA caminho (sem ".." / fora da raiz / pastas proibidas)
        // e o conteúdo dos arquivos mais críticos — tudo isso antes de
        // escrever qualquer byte no disco.
        const escritas = [];
        for (const nome of nomes) {
          const conteudo = arquivos[nome];
          if (typeof conteudo !== 'string') {
            throw new Error(`Conteúdo inválido para "${nome}".`);
          }
          const destino = caminhoSeguroDentroDoProjeto(nome);

          if (nome === 'server.js') {
            validarSintaxeJS(conteudo, nome);
          }
          if (nome === 'package.json') {
            try { JSON.parse(conteudo); } catch (_) { throw new Error('"package.json" não é um JSON válido.'); }
          }
          if (nome.startsWith('public/db/')) {
            const chave = nome.slice('public/db/'.length);
            if (VALIDADORES_BACKUP_DADOS[chave]) {
              let valor;
              try { valor = parseArquivoBackupDados(chave, conteudo); } catch (_) { throw new Error(`"${nome}" não é um JSON válido.`); }
              if (!VALIDADORES_BACKUP_DADOS[chave](valor)) {
                throw new Error(`"${nome}" não tem o formato esperado.`);
              }
            }
          }

          escritas.push({ destino, conteudo });
        }

        // 5) Backup de segurança do projeto INTEIRO, como está agora, antes
        // de sobrescrever qualquer coisa — reaproveita a mesma rotina do
        // Backup Geral normal, salvo como .zip em backups-seguranca/.
        fs.mkdirSync(path.join(ROOT_DIR, 'backups-seguranca'), { recursive: true });
        const carimbo = todayBrasiliaServer() + '_' + Date.now();
        const zipSeguranca = await gerarBackupGeral();
        const caminhoZipSeguranca = path.join(ROOT_DIR, 'backups-seguranca', `pre-restore-geral_${carimbo}.zip`);
        fs.writeFileSync(caminhoZipSeguranca, zipSeguranca);

        // 6) Escreve tudo em arquivos .tmp-restore primeiro; só promove
        // (rename) pro nome final depois que TODOS os .tmp foram gravados
        // com sucesso — minimiza o risco de deixar o projeto pela metade.
        const pendentes = escritas.map(({ destino, conteudo }) => {
          fs.mkdirSync(path.dirname(destino), { recursive: true });
          const tmp = destino + '.tmp-restore';
          fs.writeFileSync(tmp, conteudo, 'utf8');
          return { tmp, destino };
        });
        pendentes.forEach(p => fs.renameSync(p.tmp, p.destino));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          arquivosRestaurados: nomes.length,
          backupSeguranca: path.relative(ROOT_DIR, caminhoZipSeguranca),
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // Servir arquivos estáticos normalmente
  let filePath = path.join(DIR, urlPath === '/' ? 'login.html' : urlPath);
  const ext = path.extname(filePath);
  if (!MIME[ext] && !ext) filePath += '.html';

  // ─── Path traversal ─────────────────────────────────────────────────────
  // path.join() acima NÃO impede que urlPath contenha "..", "%2e%2e" (já
  // decodificado), ou um caminho absoluto — ex: GET /../server.js ou
  // GET /../../private/security.json escapariam de DIR (public/) e
  // exporiam qualquer arquivo do disco que o processo Node consiga ler.
  // Resolve o caminho final e recusa qualquer um que não fique estritamente
  // dentro de DIR (mesma técnica já usada em caminhoSeguroDentroDoProjeto(),
  // acima, pra Restauração Geral).
  const caminhoResolvido = path.resolve(filePath);
  if (caminhoResolvido !== DIR && !caminhoResolvido.startsWith(DIR + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(caminhoResolvido, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(caminhoResolvido)] || 'text/plain' });
    res.end(data);
  });

});

// ── WEBSOCKET: transmite em tempo real qualquer mudança da operação em
// andamento (tela "Registrar Operação") pra quem mais estiver com a tela
// aberta. Quem dispara o broadcast é a rota POST /salvar-operacao-andamento,
// acima; aqui só ficam a conexão e a lista de clientes conectados.
const wss = new WebSocket.Server({ server, path: '/ws/operacao-andamento' });
const clientesOperacaoAndamento = new Set();

wss.on('connection', (ws) => {
  clientesOperacaoAndamento.add(ws);

  // Ao conectar, manda na hora o snapshot atual — é assim que a tela
  // carrega já mostrando uma operação que outra pessoa tenha deixado
  // rodando (ou null, se não houver nenhuma).
  try {
    ws.send(JSON.stringify({ tipo: 'estado', dados: lerOperacaoAndamento() }));
  } catch (_) { /* conexão pode ter caído nesse exato instante — ignora */ }

  ws.on('close', () => clientesOperacaoAndamento.delete(ws));
  ws.on('error', () => clientesOperacaoAndamento.delete(ws));
});

function _enviarWsParaTodos(msg) {
  const texto = JSON.stringify(msg);
  for (const ws of clientesOperacaoAndamento) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(texto); } catch (_) { /* cliente pode ter caído nesse exato instante */ }
    }
  }
}

function broadcastOperacaoAndamento(dados, origemClientId) {
  _enviarWsParaTodos({ tipo: 'estado', dados, origemClientId });
}

// Avisa todo mundo "ligado" no sistema (exceto quem registrou — esse já
// vê o resumo localmente) que uma operação foi finalizada/registrada —
// fim da dinâmica de dono. Disparado por POST /registrar-operacao, nunca
// em modo de teste. `resumo` é o mesmo formato que showSuccessModal()
// (operacao.js) já usa pra exibir o modal de sucesso.
function broadcastOperacaoFinalizada(resumo, origemClientId) {
  _enviarWsParaTodos({ tipo: 'operacao_finalizada', resumo, origemClientId });
}

// Avisa quem estiver com "Modo Automático" ativo (ver operacao.js,
// _aplicarLeituraAutomatica) que uma leitura chegou de fora — hoje
// disparado só por POST /leitura-automatica (ver mais acima), que por
// enquanto é chamado manualmente/por teste; a fonte real (coletor Modbus
// TCP lendo o CLP WAGO) ainda não existe — ver README, "Modo Automático".
function broadcastLeituraAutomatica(leitura) {
  _enviarWsParaTodos({ tipo: 'leitura_automatica', leitura });
}

// Avisa TODO MUNDO conectado (qualquer página, não só quem tem "Registrar
// Operação" aberta — ver conectarOperacaoAndamento() em data.js, chamada
// uma vez só no boot do app, independente da tela visível) que uma linha
// foi excluída em Configurações → Dados SQL. Quem originou a exclusão já
// recarrega a própria página sozinho (ver cfgSqlExcluirLinha, app-core.js)
// — por isso `origemClientId` (mesmo padrão de broadcastOperacaoFinalizada,
// via wsClientId na query string) evita mandar essa mesma pessoa recarregar
// 2 vezes.
function broadcastDadosSqlExcluidos(info, origemClientId) {
  _enviarWsParaTodos({ tipo: 'dados_sql_excluidos', ...info, origemClientId });
}

server.listen(PORT, () => {
  console.log(`Lightwall rodando em http://localhost:${PORT}`);

  // Checa a cada minuto se já é "fim de dia" e falta fazer o backup
  // automático de hoje. Roda também uma vez já no boot, pro caso do
  // servidor subir depois das 23:50 de algum dia.
  setInterval(executarBackupAutomaticoSeNecessario, 60 * 1000);
  executarBackupAutomaticoSeNecessario();
});