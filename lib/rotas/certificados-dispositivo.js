// ─── lib/rotas/certificados-dispositivo.js — Certificados de Dispositivo (mTLS) ──
// Administração da funcionalidade descrita em lib/certificado-dispositivo.js
// (CA própria + emissão de .p12) — este módulo é só a camada HTTP: quem
// pode gerar, listar e revogar. A checagem de verdade (se um serial
// apresentado autoriza um dispositivo) fica em
// lib/dispositivo-autorizado.js, igual ao par
// dispositivos-autorizados.js/dispositivo-autorizado.js já existente.
//
// Rotas: GET /certificados-dispositivo, POST /gerar-certificado-dispositivo,
// POST /revogar-certificado-dispositivo.
//
// Mesma exigência de sessão que /dispositivos-autorizados (sessaoOuAdmin —
// master OU perfil Administrativo, ver wiring em server.js): gerar/revogar
// certificado é uma ação administrativa tão sensível quanto autorizar um
// deviceId à mão.

module.exports = function criarRotasCertificadosDispositivo({ sessao, certificadoDispositivo }) {

  function semSessao(res) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, erro: 'Sessão de administrador necessária ou expirada.' }));
  }

  return function tentar(req, res, urlPath) {

    // GET /certificados-dispositivo — lista (serial, nome, emitidoEm) pra
    // Configurações → Dispositivos Autorizados. Nunca inclui senha nem
    // chave privada — nenhuma das duas fica guardada depois da emissão
    // (ver emitirCertificado(), lib/certificado-dispositivo.js).
    if (req.method === 'GET' && urlPath === '/certificados-dispositivo') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, lista: certificadoDispositivo.listarCertificados() }));
      return true;
    }

    // POST /gerar-certificado-dispositivo  { nome }
    // Gera um novo certificado (cria a CA própria sozinha, na primeira vez
    // — ver garantirCA()) e devolve o .p12 pronto pra download. A senha só
    // existe nesta resposta (cabeçalho X-Certificado-Senha) — se for
    // perdida antes de instalar, a saída é gerar um certificado novo e
    // revogar este.
    if (req.method === 'POST' && urlPath === '/gerar-certificado-dispositivo') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { nome } = JSON.parse(body || '{}');
          const { p12Buffer, senha, serial, emitidoEm } = certificadoDispositivo.emitirCertificado(nome);
          const nomeArquivo = `lightwall-dispositivo-${serial.slice(0, 8)}.p12`;
          res.writeHead(200, {
            'Content-Type': 'application/x-pkcs12',
            'Content-Disposition': `attachment; filename="${nomeArquivo}"`,
            'Content-Length': p12Buffer.length,
            // Cabeçalhos custom pro front ler antes de disparar o download
            // (ver LW.gerarCertificadoDispositivo, public/js/data.js) — só
            // dígitos/hex, sem risco de quebrar a codificação de header
            // HTTP (ISO-8859-1).
            'X-Certificado-Senha': senha,
            'X-Certificado-Serial': serial,
            'X-Certificado-Emitido-Em': emitidoEm,
            // Expõe os headers custom pro fetch() do navegador conseguir
            // ler via res.headers.get(...) — sem isso, alguns navegadores
            // escondem headers não-padrão de respostas cross-origin; aqui é
            // sempre same-origin, mas não custa deixar explícito.
            'Access-Control-Expose-Headers': 'X-Certificado-Senha, X-Certificado-Serial, X-Certificado-Emitido-Em',
          });
          res.end(p12Buffer);
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    // POST /revogar-certificado-dispositivo  { serial }
    // Remove da lista de seriais aceitos — a partir da resposta, aquele
    // certificado não autoriza mais nada em dispositivoAutorizado()
    // (lib/dispositivo-autorizado.js), mesmo continuando instalado na
    // máquina (sem infraestrutura de CRL/OCSP, ver comentário em
    // lib/certificado-dispositivo.js).
    if (req.method === 'POST' && urlPath === '/revogar-certificado-dispositivo') {
      if (!sessao.requestTemSessaoValida(req)) { semSessao(res); return true; }
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { serial } = JSON.parse(body || '{}');
          if (typeof serial !== 'string' || !serial.trim()) {
            throw new Error('serial é obrigatório.');
          }
          const lista = certificadoDispositivo.removerCertificado(serial.trim());
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, lista }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return true;
    }

    return false;
  };
};
