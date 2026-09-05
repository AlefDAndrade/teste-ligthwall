// ─── lib/rotas/status-dispositivo.js — Status de Autorização por Certificado ─
// Complementa a lacuna descrita em lib/dispositivo-autorizado.js
// (certificadoAutorizadoNesteRequest): antes desta rota, o único jeito de
// saber se um dispositivo estava autorizado por CERTIFICADO era o próprio
// servidor, dentro de podeControlarOperacao() — o navegador (public/js/
// data.js, _esteDispositivoEstaNaLista()) só enxergava a lista antiga por
// deviceId/cookie (dispositivosAutorizados em config.json), nunca o
// certificado. Resultado prático: um dispositivo reconhecido SÓ via
// certificado (o caso de uso central do mTLS — sobreviver a limpar todos os
// dados do navegador) continuava vendo a tela de operação travada, porque o
// JS decidia mostrar o aviso e desabilitar os campos ANTES de qualquer
// request de verdade sair pro servidor.
//
// Rota: GET /status-dispositivo — pública de propósito (sem exigir sessão):
// só revela um boolean sobre a conexão ATUAL de quem pergunta (se ela chegou
// com um certificado de cliente autorizado), o mesmo tipo de informação que
// já é implícita em qualquer outra rota que aceita o dispositivo por
// certificado. Não expõe a lista de certificados nem seriais de terceiros
// (isso continua exigindo sessão de admin — ver GET /certificados-dispositivo
// em lib/rotas/certificados-dispositivo.js).

module.exports = function criarRotaStatusDispositivo({ certificadoAutorizadoNesteRequest }) {
  return function tentar(req, res, urlPath) {
    if (req.method === 'GET' && urlPath === '/status-dispositivo') {
      const autorizadoPorCertificado = certificadoAutorizadoNesteRequest(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, autorizadoPorCertificado }));
      return true;
    }
    return false;
  };
};
