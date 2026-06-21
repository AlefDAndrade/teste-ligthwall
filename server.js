const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const vm     = require('vm');
const JSZip  = require('jszip');

const PORT = 3000;
const ROOT_DIR = __dirname; // raiz do projeto — usado pelo backup geral
const DIR = path.join(__dirname, 'public');
const DB_DIR = path.join(DIR, 'db'); // arquivos-de-dados (JSON usados como "banco")

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

// Lê o contador de traços do dia, resetando automaticamente se a data mudou
// (Brasília). NÃO incrementa — apenas garante que o objeto retornado é válido
// para o dia de hoje. Quem chama decide se quer ler ou incrementar.
function lerContadorTracosHoje() {
  const hoje = todayBrasiliaServer();
  const contadorPath = path.join(DB_DIR, 'contador_tracos.json');
  let contador = { data: hoje, total: 0 };
  try {
    contador = JSON.parse(fs.readFileSync(contadorPath, 'utf8'));
  } catch (_) { /* arquivo ainda não existe — usa o default acima */ }
  if (contador.data !== hoje) {
    contador = { data: hoje, total: 0 }; // novo dia: reinicia a contagem
  }
  return contador;
}

function salvarContadorTracos(contador) {
  const contadorPath = path.join(DB_DIR, 'contador_tracos.json');
  fs.writeFileSync(contadorPath, JSON.stringify(contador, null, 2), 'utf8');
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
  'relatorio_injecao.json': v => Array.isArray(v),
  'security.json':           v => v && typeof v === 'object' && typeof v.passwordHash === 'string',
  'sobra.json':              v => v && typeof v === 'object',
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
  'relatorio_injecao.json': [],
  'sobra.json': {},
};

function parseArquivoBackupDados(nome, texto) {
  if (texto.trim() === '' && DEFAULT_SE_VAZIO_BACKUP_DADOS.hasOwnProperty(nome)) {
    return DEFAULT_SE_VAZIO_BACKUP_DADOS[nome];
  }
  return JSON.parse(texto);
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

http.createServer((req, res) => {

  // Extrai apenas o caminho (pathname) da URL, ignorando parâmetros como ?_=...
  const [urlPath] = req.url.split('?');

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
      const contador = lerContadorTracosHoje();
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
      try {
        const payload = JSON.parse(body);
        const quantidade = Number(payload.quantidade);
        if (!Number.isInteger(quantidade) || quantidade < 0) {
          throw new Error('Quantidade inválida.');
        }
        const contador = lerContadorTracosHoje();
        contador.total += quantidade;
        salvarContadorTracos(contador);
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

  // Registrar operação — faz append no historico.json
  if (req.method === 'POST' && urlPath === '/registrar-operacao') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const record = JSON.parse(body);
        const historicoPath = path.join(DB_DIR, 'historico.json');
        let historico = [];
        try {
          historico = JSON.parse(fs.readFileSync(historicoPath, 'utf8'));
        } catch (_) {}
        historico.push(record);
        fs.writeFileSync(historicoPath, JSON.stringify(historico, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // Registrar linhas do relatório de injeção — append em relatorio_injecao.json
  if (req.method === 'POST' && urlPath === '/registrar-relatorio-injecao') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const dadosRecebidos = JSON.parse(body);
        const relatorioPath = path.join(DB_DIR, 'relatorio_injecao.json');

        let relatorio = [];
        try {
          relatorio = JSON.parse(fs.readFileSync(relatorioPath, 'utf8'));
        } catch(_) {
          relatorio = [];
        }

        dadosRecebidos.forEach(novoTraco => {
          console.log('recebido:', novoTraco.id_traco);
          const registroExistente = relatorio.find(r => r.id_traco === novoTraco.id_traco);

          if (registroExistente) {
            if (!registroExistente.ultilizado) registroExistente.ultilizado = { operacao: [] };
            // Cada uso/reaproveitamento já carrega sua própria obs dentro do
            // próprio item de operação (novoTraco.ultilizado.operacao[].obs),
            // então não há mais necessidade de concatenar obs no nível do
            // traço — isso evitava perder a observação de reaproveitamentos,
            // mas misturava observações de baterias diferentes num só texto.
            registroExistente.ultilizado.operacao.push(...novoTraco.ultilizado.operacao);
          } else {
            relatorio.push(novoTraco);
          }
        });

        fs.writeFileSync(relatorioPath, JSON.stringify(relatorio, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // Importar lote de relatório de injeção — merge com deduplicação
  if (req.method === 'POST' && urlPath === '/importar-relatorio-injecao') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const novos = JSON.parse(body);
        if (!Array.isArray(novos)) throw new Error('Payload deve ser um array');
        const relatorioPath = path.join(DB_DIR, 'relatorio_injecao.json');
        let relatorio = [];
        try { relatorio = JSON.parse(fs.readFileSync(relatorioPath, 'utf8')); } catch(_) {}
        const existentes = new Set(relatorio.map(r => r.id_operacao + '|' + r.num_traco));
        let inseridos = 0, duplicatas = 0;
        novos.forEach(r => {
          const chave = r.id_operacao + '|' + r.num_traco;
          if (existentes.has(chave)) { duplicatas++; }
          else { relatorio.push(r); existentes.add(chave); inseridos++; }
        });
        relatorio.sort((a, b) => (a.data > b.data ? 1 : -1));
        fs.writeFileSync(relatorioPath, JSON.stringify(relatorio, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, inseridos, duplicatas }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // Importar lote de registros — merge no historico.json com deduplicação
  if (req.method === 'POST' && urlPath === '/importar-historico') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const novos = JSON.parse(body);
        if (!Array.isArray(novos)) throw new Error('Payload deve ser um array');
        const historicoPath = path.join(DB_DIR, 'historico.json');
        let historico = [];
        try { historico = JSON.parse(fs.readFileSync(historicoPath, 'utf8')); } catch(_) {}
        const existentes = new Set(historico.map(r => r.id || (r.data + '|' + r.id_bateria + '|' + r.turno)));
        let inseridos = 0, duplicatas = 0;
        novos.forEach(r => {
          const chave = r.id || (r.data + '|' + r.id_bateria + '|' + r.turno);
          if (existentes.has(chave)) { duplicatas++; }
          else { historico.push(r); existentes.add(chave); inseridos++; }
        });
        historico.sort((a, b) => (a.data > b.data ? 1 : -1));
        fs.writeFileSync(historicoPath, JSON.stringify(historico, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, inseridos, duplicatas }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
    });
    return;
  }

  // ── SOBRA: Salvar sobra.json ──────────────────────────────────────────────
  if (req.method === 'POST' && urlPath === '/salvar-sobra') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const sobra = JSON.parse(body);
        const sobraPath = path.join(DB_DIR, 'sobra.json');
        fs.writeFileSync(sobraPath, JSON.stringify(sobra, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
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
        const carimbo = todayBrasiliaServer() + '_' + Date.now();
        const dirSeguranca = path.join(ROOT_DIR, 'backups-seguranca', 'pre-restore_' + carimbo);
        fs.mkdirSync(dirSeguranca, { recursive: true });
        for (const nome of esperados) {
          try {
            fs.copyFileSync(path.join(DB_DIR, nome), path.join(dirSeguranca, nome));
          } catch (_) {
            // Arquivo pode não existir ainda (ex.: primeira execução) — ok.
          }
        }

        // 4) Escreve tudo em arquivos .tmp primeiro; só promove (rename) pro
        // nome final depois que TODOS os .tmp foram gravados com sucesso —
        // minimiza o risco de deixar a pasta db/ num estado inconsistente.
        const pendentes = esperados.map(nome => ({
          tmp: path.join(DB_DIR, nome + '.tmp'),
          destino: path.join(DB_DIR, nome),
          texto: textosValidados[nome],
        }));
        pendentes.forEach(p => fs.writeFileSync(p.tmp, p.texto, 'utf8'));
        pendentes.forEach(p => fs.renameSync(p.tmp, p.destino));

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

}).listen(PORT, () => {
  console.log(`Lightwall rodando em http://localhost:${PORT}`);
});