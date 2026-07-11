// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  operador.js — Identidade Leve de Operador
// ============================================================
// "Leve" de propósito: NÃO é um sistema de login paralelo, NÃO cria
// sessão no servidor, NÃO bloqueia nenhum registro por falta de
// identidade. É só uma pergunta simples — "quem está operando agora?" —
// feita UMA VEZ por sessão de navegador (sessionStorage, some ao fechar
// a aba), guardada como texto puro (nome), e anexada nos registros que
// já existiam antes (registrar-operacao, salvar-parada) puramente como
// rótulo de auditoria: "quem registrou isto".
//
// O PIN só serve pra confirmar identidade NA HORA de escolher quem é —
// depois disso, o nome vira só um dado guardado no navegador (igual
// sessionStorage.lw_role já funciona pro perfil Administrador/Analista),
// sem token, sem cookie, sem re-checagem em cada chamada. Ver
// POST /verificar-operador (server.js) — não emite sessão nenhuma.
//
// Se ninguém foi cadastrado ainda (GET /operadores vazio), exigir()
// resolve com null direto, sem mostrar nada — o recurso é totalmente
// opt-in: instalações que não quiserem usar não veem nada diferente.
'use strict';

(function () {
  const CHAVE_SESSAO = 'lw_operador_atual'; // { id, nome }

  function getAtual() {
    try {
      const raw = sessionStorage.getItem(CHAVE_SESSAO);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function _salvarAtual(operador) {
    try { sessionStorage.setItem(CHAVE_SESSAO, JSON.stringify(operador)); } catch (_) { /* sem storage — segue sem lembrar */ }
    _atualizarBadge();
  }

  function limpar() {
    try { sessionStorage.removeItem(CHAVE_SESSAO); } catch (_) {}
    _atualizarBadge();
  }

  async function _carregarLista() {
    try {
      const res = await fetch('operadores');
      const json = await res.json();
      return json.ok ? json.operadores : [];
    } catch (_) {
      return [];
    }
  }

  // ── Garante uma identidade pra esta sessão de navegador ───────────────
  // Resolve com { id, nome } se confirmado, ou `null` se: já não houver
  // ninguém cadastrado, ou o usuário pular. NUNCA rejeita — quem chama
  // não precisa de try/catch só por causa disto.
  function exigir() {
    return new Promise((resolve) => {
      const atual = getAtual();
      if (atual) { resolve(atual); return; }

      _carregarLista().then((lista) => {
        if (!lista.length) { resolve(null); return; }
        _mostrarModal(lista, resolve);
      });
    });
  }

  // Reabre o seletor mesmo já havendo alguém selecionado — usado pelo
  // badge "trocar operador" (ex.: troca de turno, sem fechar o navegador).
  function trocar() {
    return new Promise((resolve) => {
      _carregarLista().then((lista) => {
        if (!lista.length) { resolve(null); return; }
        _mostrarModal(lista, (op) => { resolve(op); });
      });
    });
  }

  // ── Modal (mesmo estilo visual de admin-auth.js — caixa escura,
  // título âmbar — construído na hora, sem depender de partial no HTML) ──
  function _mostrarModal(lista, resolve) {
    let overlay = document.getElementById('lw-operador-modal');
    if (overlay) overlay.remove();

    overlay = document.createElement('div');
    overlay.id = 'lw-operador-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = `
      display: flex; position: fixed; inset: 0;
      background: rgba(0,0,0,.78); z-index: 9999;
      align-items: center; justify-content: center;
      backdrop-filter: blur(4px);
    `;

    const opcoes = lista.map(o => `<option value="${o.id}">${_esc(o.nome)}</option>`).join('');

    overlay.innerHTML = `
      <div style="background:#1a1a2e;border:1px solid #2d2d4e;border-radius:14px;padding:32px 30px 26px;width:360px;max-width:94vw;box-shadow:0 32px 96px rgba(0,0,0,.7)">
        <div style="text-align:center;margin-bottom:24px">
          <div style="font-size:1.8rem;margin-bottom:8px">👤</div>
          <h2 style="font-family:'Barlow Condensed','Barlow',sans-serif;font-size:1.2rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#f59e0b;margin:0 0 6px">Quem está operando?</h2>
          <p style="color:#9ca3af;font-size:.8rem;margin:0">Fica só nesta aba — ajuda a saber quem registrou o quê.</p>
        </div>
        <div style="margin-bottom:14px">
          <label style="display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:6px">Nome</label>
          <select id="lw-operador-select" style="width:100%;padding:10px 12px;background:#12121f;border:1px solid #2d2d4e;border-radius:8px;color:#eef2f7;font-size:.92rem">
            ${opcoes}
          </select>
        </div>
        <div style="margin-bottom:8px">
          <label style="display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:#9ca3af;margin-bottom:6px">PIN</label>
          <input id="lw-operador-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="8"
            style="width:100%;padding:10px 12px;background:#12121f;border:1px solid #2d2d4e;border-radius:8px;color:#eef2f7;font-size:.92rem;letter-spacing:.2em">
        </div>
        <div id="lw-operador-erro" style="display:none;color:#ef4444;font-size:.78rem;margin-bottom:10px"></div>
        <button id="lw-operador-confirmar" style="width:100%;padding:11px;background:#2968ff;border:none;border-radius:8px;color:#fff;font-weight:700;font-size:.88rem;cursor:pointer;margin-bottom:8px">Confirmar</button>
        <button id="lw-operador-pular" style="width:100%;padding:9px;background:transparent;border:none;color:#9ca3af;font-size:.78rem;cursor:pointer;text-decoration:underline">Continuar sem identificar</button>
      </div>
    `;

    document.body.appendChild(overlay);

    const pinEl = document.getElementById('lw-operador-pin');
    const erroEl = document.getElementById('lw-operador-erro');
    const btnConfirmar = document.getElementById('lw-operador-confirmar');

    function fechar() { overlay.remove(); }

    async function confirmar() {
      const operadorId = document.getElementById('lw-operador-select').value;
      const pin = pinEl.value.trim();
      erroEl.style.display = 'none';
      if (!pin) { erroEl.textContent = 'Digite o PIN.'; erroEl.style.display = ''; return; }

      btnConfirmar.disabled = true;
      btnConfirmar.textContent = 'Confirmando…';
      try {
        const res = await fetch('verificar-operador', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operadorId, pin }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.erro || 'PIN incorreto.');
        const operador = { id: json.id, nome: json.nome };
        _salvarAtual(operador);
        fechar();
        resolve(operador);
      } catch (err) {
        erroEl.textContent = err.message;
        erroEl.style.display = '';
      } finally {
        btnConfirmar.disabled = false;
        btnConfirmar.textContent = 'Confirmar';
      }
    }

    btnConfirmar.addEventListener('click', confirmar);
    pinEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirmar(); });
    document.getElementById('lw-operador-pular').addEventListener('click', () => { fechar(); resolve(null); });

    setTimeout(() => pinEl.focus(), 60);
  }

  function _esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s ?? '');
    return d.innerHTML;
  }

  // ── Badge no topo — mostra quem está identificado nesta aba, com opção
  // de trocar. Só aparece se o recurso estiver em uso (há alguém
  // cadastrado E alguém já selecionado nesta sessão) — instalações que
  // não usam Identidade Leve de Operador não veem nada a mais na tela.
  function _atualizarBadge() {
    const el = document.getElementById('topbar-operador-atual');
    if (!el) return;
    const atual = getAtual();
    if (!atual) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.textContent = '👤 ' + atual.nome;
  }

  document.addEventListener('DOMContentLoaded', _atualizarBadge);

  window.LWOperador = { getAtual, exigir, trocar, limpar };

})();
