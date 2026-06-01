const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 3000;
const DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
};

http.createServer((req, res) => {

  // Salvar config.json via POST
  if (req.method === 'POST' && req.url === '/salvar-config') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body); // valida antes de salvar
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

  // Registrar operação — faz append no historico.json
  if (req.method === 'POST' && req.url === '/registrar-operacao') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const record = JSON.parse(body);
        const historicoPath = path.join(DIR, 'historico.json');
        let historico = [];
        try {
          historico = JSON.parse(fs.readFileSync(historicoPath, 'utf8'));
        } catch (_) { /* arquivo ainda não existe ou está vazio */ }
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

  // Importar lote de registros — merge no historico.json com deduplicação
  if (req.method === 'POST' && req.url === '/importar-historico') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const novos = JSON.parse(body);
        if (!Array.isArray(novos)) throw new Error('Payload deve ser um array');

        const historicoPath = path.join(DIR, 'historico.json');
        let historico = [];
        try { historico = JSON.parse(fs.readFileSync(historicoPath, 'utf8')); } catch(_) {}

        // Chave de deduplicação: data + id_bateria + turno
        const existentes = new Set(historico.map(r => r.data + '|' + r.id_bateria + '|' + r.turno));
        let inseridos = 0, duplicatas = 0;

        novos.forEach(r => {
          const chave = r.data + '|' + r.id_bateria + '|' + r.turno;
          if (existentes.has(chave)) { duplicatas++; }
          else { historico.push(r); existentes.add(chave); inseridos++; }
        });

        // Ordena por data
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

  // Servir arquivos estáticos normalmente
  let filePath = path.join(DIR, req.url === '/' ? 'login.html' : req.url);
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