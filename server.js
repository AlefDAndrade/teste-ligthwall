const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT = 3000;
const DIR = path.join(__dirname, 'public');

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
  const contadorPath = path.join(DIR, 'contador_tracos.json');
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
  const contadorPath = path.join(DIR, 'contador_tracos.json');
  fs.writeFileSync(contadorPath, JSON.stringify(contador, null, 2), 'utf8');
}

// ─── Utilitário: hash SHA-256 no servidor (Node.js crypto nativo) ──────────
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ─── Lê security.json do disco ────────────────────────────────────────────
const HASH_FALLBACK = 'c415e920e0281339d3633ab0c19d3b11c5a70a52ad2e17e405ef66723c51294c';

function lerSecurity() {
  const securityPath = path.join(DIR, 'security.json');
  try {
    return JSON.parse(fs.readFileSync(securityPath, 'utf8'));
  } catch (_) {
    return { passwordHash: HASH_FALLBACK, recoveryKeyHash: null };
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
        fs.writeFileSync(path.join(DIR, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
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
        const securityPath = path.join(DIR, 'security.json');
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
        const historicoPath = path.join(DIR, 'historico.json');
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
        const relatorioPath = path.join(DIR, 'relatorio_injecao.json');

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
            registroExistente.ultilizado.operacao.push(...novoTraco.ultilizado.operacao);
            if (novoTraco.obs) {
              registroExistente.obs = registroExistente.obs
                ? registroExistente.obs + " | " + novoTraco.obs
                : novoTraco.obs;
            }
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
        const relatorioPath = path.join(DIR, 'relatorio_injecao.json');
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
        const historicoPath = path.join(DIR, 'historico.json');
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
        const sobraPath = path.join(DIR, 'sobra.json');
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