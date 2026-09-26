// ─── lib/compressao-resposta.js ─────────────────────────────────────────────
// Compressão gzip das respostas HTTP, aplicada num ponto só (server.js, no
// topo do handler) em vez de em cada rota.
//
// Motivo: nenhuma resposta saía comprimida. Medido com um backup real
// (setembro/2026, ~3 meses de dados): a abertura do sistema baixava 3,2 MB
// (xlsx.full.min.js sozinho = 930 KB) e cada tela baixava de 0,4 a 1,4 MB
// de JSON — tudo cru. O servidor responde em <20 ms; o tempo ia na
// transferência pelo Wi-Fi da fábrica. JSON/JS/HTML comprimem 70–90%.
//
// Como funciona (mesmo padrão de monkey-patch do Cache-Control de /db/, em
// server.js): segura o writeHead() até saber como a resposta termina.
//   • res.end(corpo) com o corpo inteiro de uma vez (o caso de TODAS as
//     rotas JSON e do fallback de arquivo estático) → comprime (gzip
//     assíncrono, fora da thread principal) e envia com
//     Content-Encoding: gzip.
//   • res.write() antes do end (streaming, ex.: SSE de progresso do PDF em
//     lib/rotas/exportar-pdf.js) → libera os cabeçalhos como estavam e
//     segue SEM compressão, exatamente como antes.
// Só comprime tipos de texto, corpos a partir de 1 KB, e só se o cliente
// aceitar gzip. PDF, .zip de backup e imagens passam intocados.

module.exports = function criarCompressaoResposta({ zlib }) {
  const TAMANHO_MINIMO = 1024;
  const TIPOS_COMPRIMIVEIS = /^(text\/|application\/(json|javascript|manifest\+json|xml)|image\/svg\+xml)/i;

  function _acharCabecalho(headers, nome) {
    const alvo = nome.toLowerCase();
    for (const chave of Object.keys(headers)) {
      if (chave.toLowerCase() === alvo) return chave;
    }
    return null;
  }

  function aplicarCompressao(req, res) {
    const aceita = String(req.headers['accept-encoding'] || '');
    if (!/\bgzip\b/i.test(aceita) || req.method === 'HEAD') return;

    const writeHeadOriginal = res.writeHead.bind(res);
    const writeOriginal = res.write.bind(res);
    const endOriginal = res.end.bind(res);

    let pendente = null; // { statusCode, statusMessage, headers } ainda não enviados

    function _liberarPendente() {
      if (!pendente) return;
      const p = pendente;
      pendente = null;
      if (p.statusMessage !== undefined) writeHeadOriginal(p.statusCode, p.statusMessage, p.headers);
      else writeHeadOriginal(p.statusCode, p.headers);
    }

    res.writeHead = (statusCode, statusMessage, headers) => {
      if (typeof statusMessage !== 'string') { headers = statusMessage; statusMessage = undefined; }
      // Formato fora do comum (array de pares etc.) → não arrisca, envia já.
      if (headers != null && (typeof headers !== 'object' || Array.isArray(headers))) {
        if (statusMessage !== undefined) return writeHeadOriginal(statusCode, statusMessage, headers);
        return writeHeadOriginal(statusCode, headers);
      }
      pendente = { statusCode, statusMessage, headers: { ...(headers || {}) } };
      return res; // permite encadear, como o writeHead original
    };

    res.write = (...args) => {
      _liberarPendente();
      return writeOriginal(...args);
    };

    res.end = (corpo, encoding, callback) => {
      if (typeof corpo === 'function') { callback = corpo; corpo = undefined; encoding = undefined; }
      if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }

      if (!pendente || corpo == null) {
        _liberarPendente();
        return endOriginal(corpo, encoding, callback);
      }

      const { statusCode, headers } = pendente;
      const chaveTipo = _acharCabecalho(headers, 'content-type');
      const tipo = chaveTipo ? String(headers[chaveTipo]) : '';
      const buffer = Buffer.isBuffer(corpo) ? corpo : Buffer.from(String(corpo), encoding || 'utf8');

      const comprimir = statusCode !== 204 && statusCode !== 304
        && buffer.length >= TAMANHO_MINIMO
        && TIPOS_COMPRIMIVEIS.test(tipo)
        && !_acharCabecalho(headers, 'content-encoding');

      if (!comprimir) {
        _liberarPendente();
        return endOriginal(buffer, callback);
      }

      zlib.gzip(buffer, (erro, comprimido) => {
        if (erro) { // fallback: manda sem compressão, nunca derruba a resposta
          _liberarPendente();
          endOriginal(buffer, callback);
          return;
        }
        const chaveTamanho = _acharCabecalho(headers, 'content-length');
        if (chaveTamanho) delete headers[chaveTamanho];
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = comprimido.length;
        const chaveVary = _acharCabecalho(headers, 'vary');
        headers[chaveVary || 'Vary'] = chaveVary ? headers[chaveVary] + ', Accept-Encoding' : 'Accept-Encoding';
        _liberarPendente();
        endOriginal(comprimido, callback);
      });
      return res;
    };
  }

  return { aplicarCompressao };
};
