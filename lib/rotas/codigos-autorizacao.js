// ─── lib/rotas/codigos-autorizacao.js — Autorização de Dispositivo por Código ──
// Ver lib/codigos-autorizacao.js pro fluxo completo e o raciocínio de
// segurança. Este módulo só expõe as 4 rotas HTTP:
//
//   GET  /codigos-autorizacao            — lista (Administrador Master)
//   POST /gerar-codigo-autorizacao       — gera um novo código (Administrador Master)
//   POST /revogar-codigo-autorizacao     — revoga pelo nome (Administrador Master)
//   POST /autorizar-dispositivo-por-arquivo — SEM sessão, de propósito: é
//        chamada PELO PRÓPRIO dispositivo ainda não autorizado, que por
//        definição pode não ter ninguém com sessão de admin ali. A única
//        credencial aqui é o conteúdo do arquivo batendo com um código
//        pendente (ver validarConteudoEAutorizar) — por isso a proteção
//        contra abuso é rate limit por IP (`rateLimit`, injetado), não
//        sessão.

module.exports = function criarRotasCodigosAutorizacao({ sessao, codigosAutorizacao, rateLimit }) {
  const { ipRealDoRequest } = require('../ip-cliente.js');

  function semSessao(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
  }

  function erro(res, status, mensagem) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: mensagem }));
  }

  return function tentar(req, res, urlPath, queryParams) {

    // GET /codigos-autorizacao — lista completa (nome, status, datas) pra
    // tela de Configurações → Dispositivos Autorizados → "Por Código".
    if (req.method === 'GET' && urlPath === '/codigos-autorizacao') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, lista: codigosAutorizacao.listar() }));
      return true;
    }

    // POST /gerar-codigo-autorizacao  { nome }
    if (req.method === 'POST' && urlPath === '/gerar-codigo-autorizacao') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { nome } = JSON.parse(body || '{}');
          const entrada = codigosAutorizacao.gerarCodigo(nome);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, entrada, lista: codigosAutorizacao.listar() }));
        } catch (e) {
          erro(res, 400, e.message);
        }
      });
      return true;
    }

    // POST /revogar-codigo-autorizacao  { nome }
    if (req.method === 'POST' && urlPath === '/revogar-codigo-autorizacao') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { nome } = JSON.parse(body || '{}');
          codigosAutorizacao.revogar(nome);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, lista: codigosAutorizacao.listar() }));
        } catch (e) {
          erro(res, 400, e.message);
        }
      });
      return true;
    }

    // POST /autorizar-dispositivo-por-arquivo  { conteudo }
    // SEM checagem de sessão (ver comentário no topo do arquivo) — só rate
    // limit por IP. `deviceId` vem de `queryParams` (mesmo padrão de TODA
    // rota extraída que precisa dele — ver contador-tracos.js,
    // registro-operacao.js): o próprio server.js já resolve ali o cookie
    // HttpOnly de identidade (lib/dispositivo-cookie.js) ANTES de chamar
    // as rotas, sobrescrevendo o valor de queryString quando o cookie já
    // existir — impossível forjar via DevTools/corpo da requisição.
    if (req.method === 'POST' && urlPath === '/autorizar-dispositivo-por-arquivo') {
      if (rateLimit.estaBloqueado(req)) {
        const segundos = rateLimit.segundosRestantes(req);
        erro(res, 429, `Muitas tentativas. Tente de novo em ${Math.ceil(segundos / 60)} minuto(s).`);
        return true;
      }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        rateLimit.registrarEnvio(req);
        try {
          const { conteudo } = JSON.parse(body || '{}');
          const deviceId = queryParams.get('deviceId') || '';
          const ip = ipRealDoRequest(req);
          const entrada = codigosAutorizacao.validarConteudoEAutorizar(conteudo, deviceId, ip);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, nome: entrada.nome }));
        } catch (e) {
          erro(res, 400, e.message);
        }
      });
      return true;
    }

    return false;
  };
};
