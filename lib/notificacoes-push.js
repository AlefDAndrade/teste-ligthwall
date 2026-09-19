// ─── lib/notificacoes-push.js — Notificações Push (PC e celular) ──────────
// Infraestrutura genérica de Web Push (protocolo padrão do navegador, via
// VAPID) — funciona tanto em desktop (Chrome/Edge/Firefox) quanto em
// celular (Android: qualquer navegador; iOS: Safari 16.4+, mas só com o
// app ADICIONADO À TELA DE INÍCIO como PWA — o manifest.json/service-
// worker.js já existentes no projeto são exatamente o que habilita isso).
// Não depende de nenhum serviço de terceiro (Firebase, etc.) — o próprio
// navegador entrega a notificação através do endpoint push que ele mesmo
// escolhe.
//
// Chaves VAPID (identifica ESTE servidor pros serviços de push dos
// navegadores) são geradas na 1ª subida e guardadas em
// private/vapid-keys.json — fora do git (ver .gitignore, mesmo motivo de
// security.json/usuarios.json: dado de instalação, não código.
//
// Histórico: este arquivo já teve um sistema inteiro de notificação do
// Setor de Manutenção (abertura/aceite de chamado, pedido/recebimento de
// peça, manutenção programada e seu lembrete diário) — removido junto com
// a descontinuação do Setor de Manutenção (ver histórico do git se
// precisar resgatar). Sobrou só a infraestrutura VAPID genérica e a
// notificação de "PDF pronto" (não tem relação com manutenção).

const webpush = require('web-push');

const logger = require('./logger');

module.exports = function criarNotificacoesPush({ fs, path, PRIVATE_DIR, db }) {
  const VAPID_PATH = path.join(PRIVATE_DIR, 'vapid-keys.json');

  // Gera o par de chaves na 1ª vez que o servidor sobe depois desta
  // mudança, e reaproveita para sempre depois disso — trocar a chave
  // pública invalidaria TODAS as inscrições já feitas pelos navegadores
  // (cada pessoa precisaria ativar de novo), então nunca gerar de novo
  // se já existir.
  function _lerOuCriarChavesVapid() {
    try {
      const salvo = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
      if (salvo && salvo.publicKey && salvo.privateKey) return salvo;
    } catch (_) { /* ainda não existe — gera abaixo */ }
    const par = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_PATH, JSON.stringify(par, null, 2), 'utf8');
    return par;
  }

  const _chaves = _lerOuCriarChavesVapid();
  webpush.setVapidDetails('mailto:suporte@lightwall.local', _chaves.publicKey, _chaves.privateKey);

  function chavePublica() {
    return _chaves.publicKey;
  }

  async function _enviarParaSubscription(sub, payload) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
    } catch (err) {
      // 404/410 = o próprio serviço de push do navegador confirma que a
      // inscrição morreu (app desinstalado, permissão revogada no SO,
      // etc.) — remove daqui pra nunca mais tentar; qualquer outro erro
      // (rede instável, etc.) só avisa no console, não derruba o envio
      // pros demais.
      const status = err && (err.statusCode || err.status);
      if (status === 404 || status === 410) {
        db.removerPushSubscriptionMorta(sub.endpoint);
      } else {
        logger.warn('push', 'Falha ao enviar', { erro: err && err.message });
      }
    }
  }

  // ── Etapa 6 do plano "PDF sobrevive a fechar a aba" (ver README) ────────
  // "Notificação quando o PDF fica pronto" — o destinatário é sempre UM
  // usuário só, exatamente quem pediu a exportação (`job.usuarioNome`, ver
  // lib/rotas/exportar-pdf.js).
  //
  // Sem permissão nenhuma envolvida — qualquer usuário cadastrado que
  // tenha ativado notificações push no próprio dispositivo (ver
  // public/js/notificacoes-push.js) recebe o aviso do PDF que ELE MESMO
  // pediu, não é uma notificação de "equipe".
  //
  // Fire-and-forget — chamado de dentro de `_concluirJob` (lib/rotas/
  // exportar-pdf.js), que não pode esperar nem falhar por causa de um
  // serviço de push lento/fora do ar.
  function notificarPdfPronto(usuarioNome, nomeArquivo, jobId) {
    if (!usuarioNome || !jobId) return;
    const subs = db.listarPushSubscriptionsDoUsuario(usuarioNome);
    if (subs.length === 0) return;

    const payload = JSON.stringify({
      titulo: '📄 PDF pronto',
      corpo: `${nomeArquivo || 'Sua exportação'} terminou de ser gerado. Toque para baixar.`,
      // Mesmo mecanismo de deep-link de sempre — o front (app-core.js) lê
      // o parâmetro 'pdfPronto' no boot/no listener de 'message' do
      // service worker e abre o popover de Baixar/Descartar direto, sem
      // precisar a pessoa procurar o badge na topbar sozinha.
      url: `/index.html?pdfPronto=${encodeURIComponent(jobId)}`,
      tag: `exportar-pdf-${jobId}`,
    });

    for (const sub of subs) {
      _enviarParaSubscription(sub, payload);
    }
  }

  return {
    chavePublica,
    notificarPdfPronto,
  };
};
