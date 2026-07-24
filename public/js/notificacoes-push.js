// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  notificacoes-push.js — Notificações Push (PC e celular)
// ============================================================
// Ativa/desativa notificações push no ESTE dispositivo/navegador —
// "toda vez que um chamado for aberto, quem tem a permissão 'Notificar
// Abertura de Chamado' marcada no perfil é notificado" (ver
// lib/notificacoes-push.js, lib/itens-permissao.js, no servidor).
//
// Fluxo: usuário clica no sino da topbar -> pede permissão ao navegador
// (Notification.requestPermission) -> inscreve o Service Worker já
// registrado (pwa-register.js) num PushManager, usando a chave pública
// VAPID do servidor (GET /push/config) -> manda a inscrição pro servidor
// (POST /push/inscrever), amarrada ao usuário logado agora. O próprio
// SERVIDOR decide, na hora de cada chamado aberto, se o PERFIL de quem
// está logado tem a permissão marcada — este arquivo só cuida do
// "aceitar receber neste aparelho", nunca decide QUEM recebe.
//
// Em iPhone/iPad (Safari), Web Push só funciona com o app ADICIONADO À
// TELA DE INÍCIO (PWA instalado) — iOS 16.4+. Em Android/desktop
// funciona direto no navegador, sem precisar instalar nada.
'use strict';

const LWPush = (function () {

  const BOTAO_ID = 'btn-notificacoes-push';

  function _base64UrlParaUint8Array(base64Url) {
    const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
    const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
    const bruto = window.atob(base64);
    const saida = new Uint8Array(bruto.length);
    for (let i = 0; i < bruto.length; i++) saida[i] = bruto.charCodeAt(i);
    return saida;
  }

  function _suportado() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  async function _inscricaoAtual() {
    const registro = await navigator.serviceWorker.ready;
    return registro.pushManager.getSubscription();
  }

  // Atualiza a aparência do sino conforme o estado atual — chamado ao
  // carregar a página e depois de ativar/desativar. Fica ESCONDIDO se o
  // navegador não suportar push, ou se ninguém estiver logado (sem login
  // não há como o servidor saber de quem é a inscrição — ver
  // lib/rotas/notificacoes.js).
  async function atualizarBotao() {
    const btn = document.getElementById(BOTAO_ID);
    if (!btn) return;

    if (!_suportado() || !LW.nomeDeQuemEstaLogado()) {
      btn.style.display = 'none';
      return;
    }
    btn.style.display = 'inline-flex';

    if (Notification.permission === 'denied') {
      btn.textContent = '🔕 Notificações bloqueadas';
      btn.title = 'Você bloqueou notificações pro navegador — pra reativar, mude nas configurações de site do próprio navegador.';
      btn.disabled = true;
      return;
    }
    btn.disabled = false;

    const inscrito = !!(await _inscricaoAtual());
    if (inscrito) {
      btn.textContent = '🔔 Notificações ativadas';
      btn.title = 'Clique pra desativar notificações de novo chamado de manutenção neste dispositivo.';
      btn.classList.add('btn-push-ativo');
    } else {
      btn.textContent = '🔔 Ativar notificações';
      btn.title = 'Receba um aviso neste dispositivo (PC ou celular) sempre que um chamado de manutenção for aberto — se o seu perfil tiver essa permissão.';
      btn.classList.remove('btn-push-ativo');
    }
  }

  async function ativar() {
    try {
      const permissao = await Notification.requestPermission();
      if (permissao !== 'granted') {
        alert('Notificações não ativadas — permissão negada no navegador.');
        return;
      }

      const cfgRes = await fetch('/push/config');
      const cfg = await cfgRes.json();
      if (!cfg.ok || !cfg.chavePublica) throw new Error('Não consegui obter a configuração de notificações do servidor.');

      const registro = await navigator.serviceWorker.ready;
      let inscricao = await registro.pushManager.getSubscription();
      if (!inscricao) {
        inscricao = await registro.pushManager.subscribe({
          userVisibleOnly: true, // exigência do Chrome/Android: toda push precisa virar uma notificação visível
          applicationServerKey: _base64UrlParaUint8Array(cfg.chavePublica),
        });
      }

      const res = await fetch('/push/inscrever', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: inscricao.toJSON() }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.erro || 'Falha ao registrar a inscrição no servidor.');
    } catch (err) {
      console.warn('[push] Falha ao ativar:', err);
      alert('Não consegui ativar as notificações neste dispositivo: ' + err.message);
    } finally {
      atualizarBotao();
    }
  }

  async function desativar() {
    try {
      const inscricao = await _inscricaoAtual();
      if (!inscricao) return;
      const endpoint = inscricao.endpoint;
      await inscricao.unsubscribe();
      await fetch('/push/desinscrever', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      });
    } catch (err) {
      console.warn('[push] Falha ao desativar:', err);
    } finally {
      atualizarBotao();
    }
  }

  async function alternar() {
    const jaInscrito = !!(await _inscricaoAtual());
    if (jaInscrito) await desativar();
    else await ativar();
  }

  // Chamado 1x, depois do login já validado (ver DOMContentLoaded,
  // app-core.js) — só atualiza a aparência do sino; NUNCA pede permissão
  // sozinho (pedido de permissão sempre por gesto explícito do usuário,
  // clicando no sino — pedir sem clique é ignorado ou tratado como spam
  // pela maioria dos navegadores).
  function iniciar() {
    if (!_suportado()) return;
    const btn = document.getElementById(BOTAO_ID);
    if (btn && !btn.dataset.lwPushLigado) {
      btn.dataset.lwPushLigado = '1';
      btn.addEventListener('click', alternar);
    }
    atualizarBotao();
  }

  return { iniciar, ativar, desativar, alternar, atualizarBotao };
})();
