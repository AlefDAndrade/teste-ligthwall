// ─── lib/dispositivo-autorizado.js — Dispositivo Autorizado ────────────────
// Fase 12 do fatiamento de server.js (ver README, "Fatiamento de server.js"
// → "Plano de continuidade") — não é rota de domínio, é núcleo compartilhado:
// chamado por lib/rotas/registro-operacao.js, lib/rotas/operacao-andamento.js
// e lib/rotas/contador-tracos.js ao mesmo tempo (o ponto de maior
// concorrência de PR do que sobrava em server.js — era literalmente o bloco
// mexido na sessão anterior, cookie HttpOnly + IP).
//
// Existiu antes (lista de deviceIds em config.json, editável em
// Configurações → Autorizados), foi removido quando o sistema de perfis
// entrou (trava passou a ser só por PESSOA), e voltou como uma camada
// ADICIONAL: pra controlar operações, o usuário precisa das duas coisas ao
// mesmo tempo — permissão de perfil (ver podeControlarOperacao, abaixo) E o
// navegador/computador estar na lista de autorizados. Sem exceção: nem o
// Administrador Master, nem o perfil Administrativo escapam desta checagem
// (pedido explícito do usuário) — só uma sessão de admin válida permite
// GERENCIAR a lista (autorizar/remover um dispositivo, ver
// lib/rotas/dispositivos-autorizados.js), não CONTROLAR operações num
// dispositivo não autorizado.
//
// Guardada em config.json (dispositivosAutorizados: [{ deviceId, nome, ip,
// autorizadoEm }]). Lida do disco a cada checagem (sem cache em memória) de
// propósito: um dispositivo recém-autorizado/removido em Configurações
// precisa valer na hora, sem exigir restart do servidor.
//
// A lista VAZIA significa "nenhum dispositivo autorizado ainda" (nega por
// padrão), não "sem restrição" — é o comportamento mais seguro pra quem está
// LIGANDO esta funcionalidade de propósito. Assim que o Administrador
// autorizar o primeiro dispositivo, a operação volta a funcionar nele.

// Nome do header que o Caddy passa a mandar pro Node, depois de rodar
// deploy/ativar-mtls-caddy.sh, com o número de série do certificado de
// cliente apresentado no handshake TLS (se houver — client_auth em modo
// "request", opcional, nunca obrigatório). Ver lib/certificado-dispositivo.js
// pra como o certificado é emitido/registrado. Vem sempre em minúsculas em
// req.headers (Node normaliza nomes de header).
const HEADER_CERT_SERIAL = 'x-client-cert-serial';

/** Extrai o serial do certificado de cliente deste request, ou `null` se
 *  não houver (instalação sem mTLS ligado, ou dispositivo sem certificado
 *  instalado — ambos os casos completamente normais, não é erro). */
function certSerialDoRequest(req) {
  const valor = (req.headers && req.headers[HEADER_CERT_SERIAL]) || '';
  return valor.trim() || null;
}

module.exports = function criarDispositivoAutorizado({ fs, path, DB_DIR, sessao, sessaoUsuario, perfis, podeEditarArea, certificadoDispositivo }) {

  const CONFIG_PATH_DISPOSITIVOS = path.join(DB_DIR, 'config.json');

  function lerDispositivosAutorizados() {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH_DISPOSITIVOS, 'utf8'));
      return Array.isArray(cfg.dispositivosAutorizados) ? cfg.dispositivosAutorizados : [];
    } catch (_) {
      return [];
    }
  }

  function salvarDispositivosAutorizados(lista) {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH_DISPOSITIVOS, 'utf8')); } catch (_) {}
    cfg.dispositivosAutorizados = lista;
    fs.writeFileSync(CONFIG_PATH_DISPOSITIVOS, JSON.stringify(cfg, null, 2), 'utf8');
  }

  // Certificado de cliente (mTLS, ver lib/certificado-dispositivo.js e
  // HEADER_CERT_SERIAL acima) — checado ANTES de deviceId/IP porque é a via
  // mais forte das três (não se perde limpando dados do navegador, não dá
  // pra forjar via DevTools). Só entra em jogo se `certificadoDispositivo`
  // foi injetado (sempre é, em produção — ver server.js) e um serial válido
  // veio no header; sem os dois, cai direto na checagem antiga, sem
  // nenhuma mudança de comportamento pra quem não usa certificado.
  //
  // deviceId bate direto com algum autorizado -> autorizado, sem mais nada.
  // Senão, e só se um IP foi informado: procura um cadastro autorizado cujo
  // `ip` guardado bate com o IP deste request — cobre o caso de o navegador
  // ter perdido o cookie/localStorage (limpou dados, trocou de navegador no
  // mesmo PC) mas continuar sendo fisicamente o MESMO computador (mesmo IP
  // de rede interna, tipicamente fixo em chão de fábrica). Quando isso
  // acontece, RELIGA o cadastro ao novo deviceId (autocura) em vez de negar
  // e obrigar o Administrador a reautorizar manualmente — mas só nesse caso
  // específico (IP já era de um dispositivo JÁ autorizado antes), nunca pra
  // um IP desconhecido. Fica registrado (religadoEm) pra auditoria.
  function dispositivoAutorizado(deviceId, ip, certSerial) {
    if (certSerial && certificadoDispositivo && certificadoDispositivo.certificadoAutorizado(certSerial)) {
      return true;
    }
    if (!deviceId) return false;
    const lista = lerDispositivosAutorizados();
    if (lista.some(d => d && d.deviceId === deviceId)) return true;
    if (!ip) return false;
    const idx = lista.findIndex(d => d && d.ip === ip);
    if (idx === -1) return false;
    lista[idx] = { ...lista[idx], deviceId, religadoEm: new Date().toISOString() };
    salvarDispositivosAutorizados(lista);
    return true;
  }

  // ─── QUEM PODE CONTROLAR A OPERAÇÃO (iniciar/encerrar/registrar) ─────────
  // Duas travas independentes, as DUAS precisam passar:
  //   1) dispositivoAutorizado(deviceId) — este computador está na lista
  //      de autorizados (ver acima). Sem exceção pra nenhum perfil.
  //   2) Permissão de PESSOA (sessão de usuário logado — ver
  //      lib/sessao-usuario.js): "Administrador" (senha mestra) e
  //      "Administrativo" sempre podem; os demais perfis só se o usuário
  //      específico tiver sido marcado com podeIniciarOperacao:true no
  //      cadastro (Configurações → Usuários — ver lib/rotas/usuarios.js,
  //      lib/perfis.js).
  function podeControlarOperacao(req, deviceId) {
    const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const certSerial = certSerialDoRequest(req);
    if (!dispositivoAutorizado(deviceId, ip, certSerial)) return false;
    if (sessao.requestTemSessaoValida(req)) return true; // Admin Master: irrestrito (mas ainda precisa do device acima)
    const dados = sessaoUsuario.dadosDaSessao(req);
    if (!dados) return false; // sem sessão de usuário válida, sem acesso
    if (perfis.ehPerfilDeAdmin(dados.perfil)) return true; // Administrativo = igual ao master
    // Pros demais perfis, duas condições juntas: o perfil precisa ter a área
    // 'injetora' de edição (Operador de Injetora, Encarregado, Supervisão,
    // um perfil FIXO com override pra isso — ver lib/perfis-fixos-overrides.js
    // — ou um perfil CUSTOMIZADO com o item "Registrar Operação" marcado
    // "Acesso Total") E o usuário específico precisa ter sido marcado com o
    // checkbox "pode iniciar/encerrar operações" no cadastro. Reaproveita
    // podeEditarArea() (injetado — ainda vive em server.js) pra não duplicar
    // a lógica de override/fixo/customizado aqui de novo.
    return podeEditarArea(req, 'injetora') && !!dados.podeIniciarOperacao;
  }

  // Mensagem diferente conforme a causa — reconfere dispositivoAutorizado()
  // aqui pra dizer exatamente qual das duas travas barrou (deviceId sempre
  // disponível em quem chama, ver assinatura de podeControlarOperacao
  // acima). Recebe `req` (não só `deviceId`) pra também considerar um
  // eventual certificado apresentado — sem isso, um dispositivo autorizado
  // SÓ por certificado (nunca autorizado por deviceId/IP) seria mostrado
  // erroneamente como "dispositivo não autorizado" quando na verdade o
  // motivo real de ter caído aqui é falta de permissão de perfil.
  function negarControleDeOperacao(res, req, deviceId) {
    const certSerial = certSerialDoRequest(req);
    if (!dispositivoAutorizado(deviceId, null, certSerial)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        motivo: 'dispositivo',
        deviceId: deviceId || null,
        erro: 'Este dispositivo não está autorizado a controlar operações. Peça ao Administrador pra autorizá-lo em Configurações → Dispositivos Autorizados.',
      }));
      return;
    }
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      motivo: 'perfil',
      erro: 'Você não está autorizado a controlar operações. Peça ao Administrador pra habilitar isso no seu cadastro (Configurações → Usuários).',
    }));
  }

  return {
    lerDispositivosAutorizados,
    salvarDispositivosAutorizados,
    dispositivoAutorizado,
    podeControlarOperacao,
    negarControleDeOperacao,
  };
};
