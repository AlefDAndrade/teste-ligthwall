const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
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

const PORT = 3000;
const ROOT_DIR = __dirname; // raiz do projeto — usado pelo backup geral
const DIR = path.join(__dirname, 'public');
const DB_DIR = path.join(DIR, 'db'); // arquivos-de-dados (JSON usados como "banco")

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

// ─── Utilitário: hash SHA-256 no servidor (Node.js crypto nativo) ──────────
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ─── Lê security.json do disco ────────────────────────────────────────────
const HASH_FALLBACK = 'c415e920e0281339d3633ab0c19d3b11c5a70a52ad2e17e405ef66723c51294c';

function lerSecurity() {
  const securityPath = path.join(DB_DIR, 'security.json');
  try {
    return JSON.parse(fs.readFileSync(securityPath, 'utf8'));
  } catch (_) {
    return { passwordHash: HASH_FALLBACK, recoveryKeyHash: null };
  }
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
  'sobra.json':              v => v && typeof v === 'object',
  'paradas.json':            v => Array.isArray(v),
  'ajustes_tracos.json':    v => Array.isArray(v),
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
      } else {
        zip.file(nome, fs.readFileSync(path.join(DB_DIR, nome)));
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

  // ── NOVO: Verificar senha admin no servidor ────────────────────────────────
  // POST /verificar-senha  { senha: "texto plano" }
  // Retorna { ok: true } se correta, { ok: false } se incorreta.
  // A senha nunca é logada — apenas comparada com o hash em security.json.
  if (req.method === 'POST' && urlPath === '/verificar-senha') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { senha } = JSON.parse(body);
        if (typeof senha !== 'string') throw new Error('Payload inválido.');
        const security = lerSecurity();
        const hashEnviado = sha256(senha);
        const hashEsperado = security.passwordHash || HASH_FALLBACK;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: hashEnviado === hashEsperado }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── NOVO: Verificar arquivo de recuperação no servidor ────────────────────
  // POST /verificar-recovery  { chave: "conteudo do .key" }
  // Retorna { ok: true } se válido.
  if (req.method === 'POST' && urlPath === '/verificar-recovery') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { chave } = JSON.parse(body);
        if (typeof chave !== 'string') throw new Error('Payload inválido.');
        const security = lerSecurity();
        if (!security.recoveryKeyHash) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        const hashEnviado = sha256(chave.trim());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: hashEnviado === security.recoveryKeyHash }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── NOVO: Gerar hash de uma senha no servidor ──────────────────────────────
  // POST /gerar-hash  { senha: "texto plano" }
  // Retorna { hash: "hex64" } — usado ao redefinir senha via recuperação.
  if (req.method === 'POST' && urlPath === '/gerar-hash') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { senha } = JSON.parse(body);
        if (typeof senha !== 'string') throw new Error('Payload inválido.');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hash: sha256(senha) }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // Total de traços já CONFIRMADOS hoje (Brasília) — apenas leitura, não incrementa.
  if (req.method === 'GET' && urlPath === '/total-tracos-hoje') {
    try {
      const contador = lerContadorTracosHoje(modoTeste);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, total: contador.total, data: contador.data }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: e.message }));
    }
    return;
  }

  // Confirma N traços ao finalizar uma operação
  if (req.method === 'POST' && urlPath === '/confirmar-tracos-hoje') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (!modoTeste && !dispositivoAutorizado(deviceId)) { negarDispositivoNaoAutorizado(res); return; }
      try {
        const payload = JSON.parse(body);
        const quantidade = Number(payload.quantidade);
        if (!Number.isInteger(quantidade) || quantidade < 0) {
          throw new Error('Quantidade inválida.');
        }
        const contador = incrementarContadorTracosHoje(quantidade, modoTeste);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, total: contador.total, data: contador.data }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // Salvar config.json via POST
  if (req.method === 'POST' && urlPath === '/salvar-config') {
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

  // Salvar security.json via POST
  if (req.method === 'POST' && urlPath === '/salvar-security') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const hexRE = /^[0-9a-f]{64}$/;
        if (
          typeof payload.passwordHash    !== 'string' || !hexRE.test(payload.passwordHash) ||
          typeof payload.recoveryKeyHash !== 'string' || !hexRE.test(payload.recoveryKeyHash)
        ) {
          throw new Error('Payload inválido: hashes SHA-256 esperados.');
        }
        const securityPath = path.join(DB_DIR, 'security.json');
        fs.writeFileSync(securityPath, JSON.stringify({
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

  // ── GET /db/historico_edicoes.json: mesma ideia da rota de historico.json
  // acima — usado pelo "Backup de Dados" gerado no navegador
  // (gerarBackupDados(), em data.js), que ainda faz fetch('db/' + nome)
  // genérico pra cada arquivo da lista.
  if (req.method === 'GET' && urlPath === '/db/historico_edicoes.json') {
    try {
      const rows = db.prepare('SELECT id_operacao, data_edicao, campos_alterados FROM edicoes_operacao ORDER BY id ASC').all();
      const edicoes = rows.map(r => ({ ...r, campos_alterados: JSON.parse(r.campos_alterados) }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(edicoes));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: e.message }));
    }
    return;
  }

  // ── GET /db/relatorio_injecao.json: mesma estratégia das outras — desde
  // a Fase 5, não existe mais como arquivo (caminho real); reconstrói o
  // mesmo formato de sempre a partir de tracos+traco_usos+ajustes+
  // leituras_resultado. Cobre LW.getRelatorioInjecao (dashboard.js), o
  // modal de Editar Traço, e a tela de Backup de Dados — todos já fazem
  // fetch direto, sem mudança nenhuma necessária.
  if (req.method === 'GET' && urlPath === '/db/relatorio_injecao.json') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(db.todosOsTracos()));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: e.message }));
    }
    return;
  }

  // ── GET /db/ajustes_tracos.json: idem — usado por LW.getAjustesTracos()
  // (o modal de Editar Traço carrega a lista de ajustes editável a partir
  // daqui) e pela tela de Backup de Dados.
  if (req.method === 'GET' && urlPath === '/db/ajustes_tracos.json') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(db.todosOsAjustesTracosJSON()));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: e.message }));
    }
    return;
  }

  // ── GET /db/historico.json: intercepta ANTES do fallback de arquivo
  // estático (mais abaixo) — desde a Fase 2, historico.json não existe
  // mais como arquivo de verdade; isso reconstrói o mesmo formato/conteúdo
  // a partir da tabela "operacoes", pra ZERO mudança no navegador (toda
  // tela que já fazia fetch('db/historico.json') continua funcionando
  // sem nenhuma alteração — LW.getStats, Análise Operacional, Debriefing,
  // a tela de Backup de Dados).
  if (req.method === 'GET' && urlPath === '/db/historico.json') {
    try {
      const rows = db.prepare('SELECT * FROM operacoes ORDER BY data ASC, criado_em ASC').all();
      const historico = rows.map(db.rowParaOperacao);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(historico));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: e.message }));
    }
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
        const CAMPOS_PROTEGIDOS = new Set(['id', 'data', 'inicio', 'fim', 'tempo_min', 'qtd_tracos', 'tracos', 'houve_atraso']);
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
  if (req.method === 'POST' && urlPath === '/importar-relatorio-injecao') {
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
  if (req.method === 'POST' && urlPath === '/importar-historico') {
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

  // ── SOBRA: salvar sobra (real -> tabela sobra; Modo de Teste -> JSON isolado) ──
  if (req.method === 'POST' && urlPath === '/salvar-sobra') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const sobra = JSON.parse(body);
        if (modoTeste) {
          const sobraPath = path.join(dirParaModoTeste(true), 'sobra.json');
          fs.writeFileSync(sobraPath, JSON.stringify(sobra, null, 2), 'utf8');
        } else {
          db.prepare(db.SQL_UPSERT_SOBRA).run(db.sobraParaRow(sobra));
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

  // ── OPERAÇÃO EM ANDAMENTO: recebe o rascunho atual da tela "Registrar
  // Operação" e propaga na hora pra quem mais estiver com essa mesma tela
  // aberta, via WebSocket (ver broadcastOperacaoAndamento, perto do final
  // do arquivo). "dados" é sempre o objeto inteiro do estado atual, ou
  // null — quando a operação termina, é cancelada/resetada, ou ainda não
  // foi iniciada (ver regra equivalente em persist(), no operacao.js).
  if (req.method === 'POST' && urlPath === '/salvar-operacao-andamento') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (!dispositivoAutorizado(deviceId)) { negarDispositivoNaoAutorizado(res); return; }
      try {
        const payload = JSON.parse(body);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new Error('Payload inválido.');
        }
        const dados = payload.dados;
        if (dados !== null && dados !== undefined && (typeof dados !== 'object' || Array.isArray(dados))) {
          throw new Error('Payload inválido: "dados" precisa ser um objeto ou null.');
        }
        const clientId = typeof payload.clientId === 'string' ? payload.clientId : null;
        const ehLimpeza = dados === null || dados === undefined;
        // "forcar" só existe pro botão "🗑️ Limpar Tudo" (ver resetarOperacao()
        // em operacao.js) — é o jeito de qualquer dispositivo autorizado
        // recuperar uma operação travada por outro computador que travou,
        // ficou offline, ou simplesmente esqueceu de encerrar.
        const forcar = payload.forcar === true && ehLimpeza;

        // ── Dono da operação ──────────────────────────────────────────────
        // Só existe UMA operação em andamento por vez (ver seção dedicada no
        // README), mas a lista de Autorizados pode ter mais de um
        // dispositivo. Quem inicia (primeiro push não-nulo depois de uma
        // operação vazia) se torna o "dono" — só ele pode mandar mais
        // mudanças, até a operação ser limpa (registrada, resetada, ou
        // "forçada" por outro autorizado). Isso evita dois computadores
        // autorizados brigando pela mesma operação ao mesmo tempo.
        const atual = lerOperacaoAndamento();
        const donoAtual = (atual && typeof atual === 'object') ? (atual.donoDeviceId || null) : null;
        const souODono = !donoAtual || donoAtual === deviceId;

        if (!souODono && !forcar) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            erro: 'Esta operação já está sendo controlada por outro computador autorizado. Espere ela terminar, ou use "🗑️ Limpar Tudo" pra assumir o controle.',
          }));
          return;
        }

        // Nunca confia no donoDeviceId que o cliente mandou (se mandou) —
        // sempre recalculado aqui: mantém o dono atual, ou assume este
        // deviceId como novo dono se a operação estava vazia.
        let dadosFinal;
        if (ehLimpeza) {
          dadosFinal = null; // limpa o dono junto
        } else {
          const { donoDeviceId: _ignorarDoCliente, ...resto } = dados;
          dadosFinal = { ...resto, donoDeviceId: donoAtual || deviceId };
        }

        salvarOperacaoAndamentoNoDisco(dadosFinal);
        broadcastOperacaoAndamento(dadosFinal, clientId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── LOG DE ACESSO: registra ip + user-agent (do próprio request,
  // confiáveis) + deviceId (mandado pelo navegador) toda vez que a rota
  // informada é acessada. "rota" é livre (ex: '/operacao'), mas por
  // enquanto só a tela "Registrar Operação" chama isso (ver showPage() em
  // index.html) — é o primeiro passo pra, no futuro, restringir essa tela
  // a um único computador.
  if (req.method === 'POST' && urlPath === '/registrar-acesso') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new Error('Payload inválido.');
        }
        const rota = typeof payload.rota === 'string' ? payload.rota : '';
        if (!rota) throw new Error('Payload inválido: "rota" obrigatória.');
        const deviceId = typeof payload.deviceId === 'string' ? payload.deviceId : '';

        // IPv4 mapeado em IPv6 (ex: "::ffff:192.168.1.10") vem assim por
        // padrão do Node — remove o prefixo pra guardar só o IP "puro".
        const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        const userAgent = req.headers['user-agent'] || '';

        const entrada = {
          ip,
          deviceId,
          data: new Date().toISOString(),
          rota,
          userAgent,
        };

        let acessos = [];
        try { acessos = JSON.parse(fs.readFileSync(ACESSOS_PATH, 'utf8') || '[]'); } catch (_) {}
        if (!Array.isArray(acessos)) acessos = [];
        acessos.push(entrada);

        fs.mkdirSync(DIR_LOGS, { recursive: true });
        const tmp = ACESSOS_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(acessos, null, 2), 'utf8');
        fs.renameSync(tmp, ACESSOS_PATH);

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

  // ── GET /db/paradas.json: mesma estratégia de historico.json — desde a
  // Fase 3, paradas.json não existe mais como arquivo; reconstrói o
  // mesmo formato a partir da tabela "paradas", pra paradas.js e oee.js
  // (que já fazem fetch('db/paradas.json') direto) continuarem sem
  // nenhuma mudança.
  if (req.method === 'GET' && urlPath === '/db/paradas.json') {
    try {
      const rows = db.prepare('SELECT * FROM paradas ORDER BY inicio ASC').all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows.map(db.rowParaParada)));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: e.message }));
    }
    return;
  }

  // ── GET /db/sobra.json: mesma estratégia das outras — desde a Fase 4,
  // sobra.json não existe mais como arquivo (caminho real); reconstrói o
  // mesmo objeto de sempre (camelCase) a partir da tabela "sobra". Modo de
  // Teste continua sendo arquivo estático de verdade (não intercepta aqui).
  if (req.method === 'GET' && urlPath === '/db/sobra.json') {
    try {
      const row = db.prepare('SELECT * FROM sobra WHERE id = 1').get();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(db.rowParaSobra(row)));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: e.message }));
    }
    return;
  }

  // ── GET /db/contador_tracos.json: idem — usado só pelo Backup de Dados
  // gerado no navegador (não tem leitura direta em nenhuma tela; a tela
  // usa /total-tracos-hoje). Devolve só o dia de HOJE, igual ao arquivo de
  // sempre (a tabela pode ter mais dias guardados, mas o formato externo
  // nunca mudou — sempre foi "o contador do dia atual", nunca histórico).
  if (req.method === 'GET' && urlPath === '/db/contador_tracos.json') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(lerContadorTracosHoje(false)));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, erro: e.message }));
    }
    return;
  }

  // ── PARADAS: salvar (inserir ou atualizar) uma parada ────────────────────
  if (req.method === 'POST' && urlPath === '/salvar-parada') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const parada = JSON.parse(body);
        if (!parada || typeof parada !== 'object' || !parada.id) {
          throw new Error('Payload inválido: "id" obrigatório.');
        }
        const atual = db.prepare('SELECT * FROM paradas WHERE id = ?').get(parada.id);
        const mesclado = atual ? { ...db.rowParaParada(atual), ...parada } : parada;

        db.prepare(`
          INSERT INTO paradas (id, inicio, fim, duracao_min, motivo, equipamento, classificacao, obs, registrado_em)
          VALUES (@id, @inicio, @fim, @duracao_min, @motivo, @equipamento, @classificacao, @obs, @registrado_em)
          ON CONFLICT(id) DO UPDATE SET
            inicio = @inicio, fim = @fim, duracao_min = @duracao_min, motivo = @motivo,
            equipamento = @equipamento, classificacao = @classificacao, obs = @obs,
            registrado_em = @registrado_em
        `).run(db.paradaParaRow(mesclado));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── PARADAS: excluir uma parada pelo id ───────────────────────────────────
  if (req.method === 'POST' && urlPath === '/excluir-parada') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        if (!id || typeof id !== 'string') throw new Error('ID inválido.');
        const resultado = db.prepare('DELETE FROM paradas WHERE id = ?').run(id);
        if (resultado.changes === 0) throw new Error('Parada não encontrada (id: ' + id + ').');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── BACKUP GERAL: zipa o projeto inteiro (código + dados) e envia pra
  // download — usado pelo card "Backup Geral" no menu (admin) ───────────────
  if (req.method === 'GET' && urlPath === '/backup-geral') {
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
  if (req.method === 'GET' && urlPath === '/backups-automaticos') {
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
        const security = lerSecurity();
        const hashEsperado = security.passwordHash || HASH_FALLBACK;
        if (sha256(senha) !== hashEsperado) {
          throw new Error('Senha incorreta.');
        }

        // 2) Valida a estrutura de cada arquivo — nunca confiamos só na
        // validação já feita no navegador.
        if (!arquivos || typeof arquivos !== 'object') {
          throw new Error('Payload inválido: "arquivos" ausente.');
        }
        const esperados = Object.keys(VALIDADORES_BACKUP_DADOS);
        const faltando = esperados.filter(nome => typeof arquivos[nome] !== 'string');
        if (faltando.length) {
          throw new Error('Backup incompleto — faltam: ' + faltando.join(', '));
        }
        const textosValidados = {};
        for (const nome of esperados) {
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
            } else {
              fs.copyFileSync(path.join(DB_DIR, nome), path.join(dirSeguranca, nome));
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
        const nomesArquivo = esperados.filter(n =>
          !['historico.json', 'historico_edicoes.json', 'paradas.json', 'sobra.json', 'contador_tracos.json',
            'relatorio_injecao.json', 'ajustes_tracos.json'].includes(n));
        const pendentes = nomesArquivo.map(nome => ({
          tmp: path.join(DB_DIR, nome + '.tmp'),
          destino: path.join(DB_DIR, nome),
          texto: textosValidados[nome],
        }));
        pendentes.forEach(p => fs.writeFileSync(p.tmp, p.texto, 'utf8'));
        pendentes.forEach(p => fs.renameSync(p.tmp, p.destino));

        if (esperados.includes('historico.json')) {
          const novoHistorico = JSON.parse(textosValidados['historico.json']);
          const inserirOperacao = db.prepare(db.SQL_INSERIR_OPERACAO);
          db.transaction(() => {
            db.prepare('DELETE FROM operacoes').run();
            for (const r of novoHistorico) {
              inserirOperacao.run({ ...db.operacaoParaRow(r), modo_teste: 0, criado_em: r.fim || r.inicio || new Date().toISOString() });
            }
          })();
        }
        if (esperados.includes('historico_edicoes.json')) {
          const novasEdicoes = JSON.parse(textosValidados['historico_edicoes.json']);
          const inserirEdicao = db.prepare('INSERT INTO edicoes_operacao (id_operacao, data_edicao, campos_alterados) VALUES (?, ?, ?)');
          db.transaction(() => {
            db.prepare('DELETE FROM edicoes_operacao').run();
            for (const e of novasEdicoes) {
              inserirEdicao.run(e.id_operacao, e.data_edicao, JSON.stringify(e.campos_alterados || []));
            }
          })();
        }
        if (esperados.includes('paradas.json')) {
          const novasParadas = JSON.parse(textosValidados['paradas.json']);
          const inserirParada = db.prepare(db.SQL_INSERIR_PARADA);
          db.transaction(() => {
            db.prepare('DELETE FROM paradas').run();
            for (const p of novasParadas) inserirParada.run(db.paradaParaRow(p));
          })();
        }
        if (esperados.includes('sobra.json')) {
          const novaSobra = JSON.parse(textosValidados['sobra.json']);
          if (novaSobra && Object.keys(novaSobra).length) {
            db.prepare(db.SQL_UPSERT_SOBRA).run(db.sobraParaRow(novaSobra));
          } else {
            db.prepare('DELETE FROM sobra').run();
          }
        }
        if (esperados.includes('contador_tracos.json')) {
          const novoContador = JSON.parse(textosValidados['contador_tracos.json']);
          if (novoContador && novoContador.data) {
            db.prepare(`
              INSERT INTO contador_tracos (data, total) VALUES (?, ?)
              ON CONFLICT(data) DO UPDATE SET total = ?
            `).run(novoContador.data, novoContador.total || 0, novoContador.total || 0);
          }
        }
        if (esperados.includes('relatorio_injecao.json')) {
          const novoRelatorio = JSON.parse(textosValidados['relatorio_injecao.json']);
          const novosAjustes = esperados.includes('ajustes_tracos.json')
            ? JSON.parse(textosValidados['ajustes_tracos.json'])
            : db.todosOsAjustesTracosJSON(); // não fazia parte deste backup — preserva os ajustes atuais
          db.transaction(() => db.substituirTracosEAjustes(novoRelatorio, novosAjustes))();
        } else if (esperados.includes('ajustes_tracos.json')) {
          // Raro (backup só com ajustes, sem o relatório) — ainda assim
          // substitui só os ajustes, preservando os traços como estão.
          const novoRelatorioAtual = db.todosOsTracos();
          const novosAjustes = JSON.parse(textosValidados['ajustes_tracos.json']);
          db.transaction(() => db.substituirTracosEAjustes(novoRelatorioAtual, novosAjustes))();
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
        const security = lerSecurity();
        if (sha256(senha) !== (security.passwordHash || HASH_FALLBACK)) {
          throw new Error('Senha incorreta.');
        }
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

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
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

function broadcastOperacaoAndamento(dados, origemClientId) {
  const msg = JSON.stringify({ tipo: 'estado', dados, origemClientId });
  for (const ws of clientesOperacaoAndamento) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch (_) { /* cliente pode ter caído nesse exato instante */ }
    }
  }
}

server.listen(PORT, () => {
  console.log(`Lightwall rodando em http://localhost:${PORT}`);

  // Checa a cada minuto se já é "fim de dia" e falta fazer o backup
  // automático de hoje. Roda também uma vez já no boot, pro caso do
  // servidor subir depois das 23:50 de algum dia.
  setInterval(executarBackupAutomaticoSeNecessario, 60 * 1000);
  executarBackupAutomaticoSeNecessario();
});