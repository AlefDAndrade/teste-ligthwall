// ─── lib/ip-cliente.js — IP Real do Cliente (atrás do proxy reverso) ───────
// Função PURA, sem estado (mesmo padrão de lib/tempo.js/lib/perfis.js) —
// require()ada direto, sem factory.
//
// PROBLEMA QUE ISTO RESOLVE: em produção, o Caddy fica na frente do Node
// como proxy reverso (deploy/instalar-https.sh — `reverse_proxy
// localhost:5000`). Isso significa que TODA conexão que o Node recebe vem,
// na verdade, do próprio Caddy (localhost) — `req.socket.remoteAddress`
// nunca é o dispositivo de verdade, é sempre 127.0.0.1/::1, não importa
// quem/onde esteja o navegador real.
//
// Consequência prática (o bug que motivou este arquivo): tudo que
// dependia desse IP pra alguma coisa — a "religa por IP" de
// dispositivoAutorizado() (lib/dispositivo-autorizado.js), rate limit por
// IP (lib/rate-limit-ip.js), log de acesso (lib/rotas/log-acesso.js),
// fila offline (lib/rotas/operacao-offline.js) e histórico de tentativa de
// senha (lib/auth.js) — via TODO dispositivo com o mesmo IP (o do Caddy).
// No caso de dispositivoAutorizado(), isso é ativamente PIOR que não ter a
// funcionalidade: quando um segundo dispositivo perdia o cookie/deviceId,
// `lista.findIndex(d => d.ip === ip)` encontrava a entrada de QUALQUER
// outro dispositivo já autorizado (todos com o mesmo ip=127.0.0.1
// registrado) e "religava" o deviceId dele por cima — roubando a
// autorização de quem já estava autorizado, silenciosamente. Isso batia
// exatamente com o sintoma relatado ("o deviceId muda, temos que ficar
// reautorizando de vez em quando"): não era o deviceId de um dispositivo
// específico mudando, era a entrada dele sendo sobrescrita pelo IP
// (idêntico pra todo mundo) de outro dispositivo que reconectou depois.
//
// SOLUÇÃO: Caddy, como QUALQUER `reverse_proxy`, já agrega o IP real do
// cliente no header `X-Forwarded-For` por padrão (nenhuma configuração
// extra no Caddyfile é necessária pra isso, diferente do
// X-Client-Cert-Serial do certificado — esse header já vem desde sempre).
// Formato: "cliente, proxy1, proxy2, ..." quando há múltiplos proxies
// encadeados — pegamos sempre o ÚLTIMO valor da lista, não o primeiro:
// um cliente malicioso pode mandar seu PRÓPRIO X-Forwarded-For forjado
// (com um IP falso na frente), mas não consegue impedir o Caddy de
// ACRESCENTAR o IP real dele no fim da lista — só o último salto (o mais
// próximo do proxy que confiamos, o próprio Caddy) é confiável. Com um só
// proxy na frente (nosso caso), isso equivale a "o IP que o Caddy viu na
// conexão TCP", que é sempre o real.
//
// Sem X-Forwarded-For nenhum (rodando sem Caddy na frente, direto na porta
// 5000, ex: ambiente de desenvolvimento local) cai no `socket.remoteAddress`
// de sempre, sem mudar nada pra quem não usa proxy.

function ipRealDoRequest(req) {
  const forwardedFor = req.headers && req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const partes = forwardedFor.split(',').map(s => s.trim()).filter(Boolean);
    if (partes.length) {
      return partes[partes.length - 1].replace(/^::ffff:/, '');
    }
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

module.exports = { ipRealDoRequest };
