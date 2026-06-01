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