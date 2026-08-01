// ─── lib/dispositivo-cookie.js — Cookie de Identidade do Dispositivo ───────
// Complementa (não substitui) o deviceId que já existia — ver
// dispositivoAutorizado()/podeControlarOperacao() em server.js e
// getDeviceId() em public/js/data.js. Motivação: o deviceId antigo é
// gerado e guardado pelo PRÓPRIO NAVEGADOR (localStorage), o que tem duas
// fraquezas: (1) some se os dados do navegador forem limpos, (2) — a mais
// séria — é só uma string em JS comum, então qualquer pessoa consegue
// abrir o DevTools em QUALQUER computador e rodar
// `localStorage.setItem('lw_device_id', '<id de um dispositivo já
// autorizado>')` pra "virar" um computador autorizado sem realmente estar
// nele.
//
// Este módulo resolve o ponto (2): o servidor passa a emitir, na primeira
// visita de cada navegador, um cookie HttpOnly com um ID aleatório. Cookie
// HttpOnly não pode ser lido NEM escrito por JavaScript do navegador — só
// o próprio servidor o define (Set-Cookie) e o lê (cabeçalho Cookie), então
// não tem como forjar via DevTools. A partir do momento em que esse cookie
// existe, server.js passa a usar o VALOR DO COOKIE como identidade real do
// dispositivo pra fins de autorização — o deviceId antigo (localStorage,
// mandado por query string) só continua valendo como fallback para
// requisições que ainda não têm o cookie (primeira visita, ou clientes que
// não guardam cookies — ex: os testes automatizados, que testam a
// autorização diretamente por deviceId de propósito).
//
// Não resolve sozinho o ponto (1) — limpar cookies também apaga este; ver
// a combinação com IP em server.js (dispositivoAutorizado) pra isso, e ver
// README ("Ideias futuras") pra mTLS, que resolveria os dois pontos de
// vez.

const crypto = require('crypto');

const NOME_COOKIE = 'lw_device_id';
// ~10 anos — não é uma sessão, é uma identidade de máquina de chão de
// fábrica; não faz sentido "expirar" sozinha.
const DURACAO_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** Lê o valor do cookie de identidade no request, ou `null` se não houver. */
function deviceIdDoCookie(req) {
  const cabecalho = req.headers.cookie || '';
  const partes = cabecalho.split(';');
  for (const parte of partes) {
    const [chave, ...resto] = parte.trim().split('=');
    if (chave === NOME_COOKIE) {
      const valor = decodeURIComponent(resto.join('=') || '');
      return valor || null;
    }
  }
  return null;
}

/** Gera um novo ID aleatório — usa o mesmo prefixo "dev_" do formato antigo
 *  só por familiaridade (ver DEVICE_ID_TESTE_PADRAO nos testes), embora a
 *  origem agora seja crypto.randomBytes (imprevisível) em vez de
 *  Date.now()+Math.random() (previsível o bastante pra, em teoria, ser
 *  adivinhado). */
function gerarDeviceId() {
  return 'dev_' + crypto.randomBytes(16).toString('hex');
}

/** Monta o cabeçalho Set-Cookie pra um novo ID — HttpOnly (JS não lê/
 *  escreve), SameSite=Strict, sem `Secure` pelo mesmo motivo já documentado
 *  em lib/sessao.js (instalações HTTP simples continuam suportadas). */
function criarCookieDeviceId(id) {
  return `${NOME_COOKIE}=${encodeURIComponent(id)}; HttpOnly; Path=/; Max-Age=${Math.floor(DURACAO_MS / 1000)}; SameSite=Strict`;
}

/**
 * Resolve a identidade "segura" do dispositivo pra este request: usa o
 * cookie se já existir; senão gera um novo. Sempre devolve um `deviceId`;
 * `novoCookie` só vem preenchido quando um cookie novo precisa ser gravado
 * na resposta (primeira visita deste navegador).
 */
function resolverDeviceIdSeguro(req) {
  const existente = deviceIdDoCookie(req);
  if (existente) return { deviceId: existente, novoCookie: null };
  const novo = gerarDeviceId();
  return { deviceId: novo, novoCookie: criarCookieDeviceId(novo) };
}

module.exports = {
  NOME_COOKIE,
  deviceIdDoCookie,
  gerarDeviceId,
  criarCookieDeviceId,
  resolverDeviceIdSeguro,
};
