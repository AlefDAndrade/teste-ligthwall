// ─── lib/rotas/contador-tracos.js — Contador de Traços do Dia ──────────────
// Sétima fatia extraída de server.js (ver lib/rotas/operadores.js pro
// padrão completo). Rotas cobertas: GET /total-tracos-hoje,
// POST /confirmar-tracos-hoje, GET /db/contador_tracos.json.
//
// `lerContadorTracosHoje`/`incrementarContadorTracosHoje` são injetadas via
// ctx — o gerador do backup automático (ainda em server.js) também as usa,
// então a DEFINIÇÃO continua lá. Mesma lógica pra
// `dispositivoAutorizado`/`negarDispositivoNaoAutorizado` (compartilhadas
// com várias outras rotas operacionais ainda não extraídas).
//
// `modoTeste`/`deviceId` são derivados aqui dentro a partir de queryParams
// (mesma expressão usada em server.js) em vez de virarem mais argumentos
// posicionais — só estas rotas, neste módulo, precisam deles.

module.exports = function criarRotasContadorTracos({ lerContadorTracosHoje, incrementarContadorTracosHoje, dispositivoAutorizado, negarDispositivoNaoAutorizado }) {

  return function tentar(req, res, urlPath, queryParams) {

    // Total de traços já CONFIRMADOS hoje (Brasília) — apenas leitura, não incrementa.
    if (req.method === 'GET' && urlPath === '/total-tracos-hoje') {
      const modoTeste = queryParams.get('modoTeste') === 'true';
      try {
        const contador = lerContadorTracosHoje(modoTeste);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, total: contador.total, data: contador.data }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, erro: e.message }));
      }
      return true;
    }

    // Confirma N traços ao finalizar uma operação
    if (req.method === 'POST' && urlPath === '/confirmar-tracos-hoje') {
      const modoTeste = queryParams.get('modoTeste') === 'true';
      const deviceId = queryParams.get('deviceId') || '';
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
      return true;
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
      return true;
    }

    return false;
  };
};
