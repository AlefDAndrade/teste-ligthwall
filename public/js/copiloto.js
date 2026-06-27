// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  copiloto.js — Widget de chat do Copiloto IA (Fase 1: só leitura)
//
//  Mantém o histórico da conversa em memória (não persiste — recarregar a
//  página começa uma conversa nova, de propósito, pra não acumular custo
//  de API por engano). Cada envio manda o histórico de TEXTO pro servidor
//  (POST /copiloto-chat), que roda lá o loop de tool-use inteiro (consulta
//  o banco, chama a API da Anthropic) e devolve só a resposta final —
//  a chave da API nunca passa por aqui.
// ============================================================
'use strict';

(function () {
  let _historico = []; // [{role:'user'|'assistant', content:'texto'}]
  let _enviando = false;

  function toggle() {
    const el = document.getElementById('copiloto-panel');
    if (!el) return;
    const abrindo = !el.classList.contains('active');
    el.classList.toggle('active', abrindo);
    if (abrindo) {
      if (!_historico.length) {
        _renderMensagem('bot', 'Oi! Pergunte sobre produção, baterias, traços ou paradas — eu só leio os dados, nada aqui altera o sistema. Ex: "quanto produzimos hoje?"');
      }
      document.getElementById('copiloto-input')?.focus();
    }
  }

  function _renderMensagem(tipo, texto) {
    const cont = document.getElementById('copiloto-mensagens');
    if (!cont) return;
    const bolha = document.createElement('div');
    bolha.className = 'copiloto-msg ' + (tipo === 'user' ? 'copiloto-msg-user' : 'copiloto-msg-bot');
    bolha.textContent = texto;
    cont.appendChild(bolha);
    cont.scrollTop = cont.scrollHeight;
  }

  function _renderCarregando() {
    const cont = document.getElementById('copiloto-mensagens');
    if (!cont) return;
    const bolha = document.createElement('div');
    bolha.id = 'copiloto-carregando';
    bolha.className = 'copiloto-msg-carregando';
    bolha.textContent = 'Consultando...';
    cont.appendChild(bolha);
    cont.scrollTop = cont.scrollHeight;
  }

  function _removerCarregando() {
    document.getElementById('copiloto-carregando')?.remove();
  }

  async function enviar() {
    if (_enviando) return;
    const input = document.getElementById('copiloto-input');
    const texto = input.value.trim();
    if (!texto) return;

    input.value = '';
    _renderMensagem('user', texto);
    _historico.push({ role: 'user', content: texto });
    _renderCarregando();
    _enviando = true;
    const btn = document.getElementById('copiloto-btn-enviar');
    if (btn) btn.disabled = true;

    try {
      const res = await fetch('/copiloto-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mensagens: _historico }),
      });
      const json = await res.json();
      _removerCarregando();
      if (!json.ok) throw new Error(json.erro || 'Erro ao consultar o copiloto.');
      _renderMensagem('bot', json.resposta);
      _historico.push({ role: 'assistant', content: json.resposta });
    } catch (e) {
      _removerCarregando();
      _renderMensagem('bot', '⚠ ' + e.message);
    } finally {
      _enviando = false;
      if (btn) btn.disabled = false;
      input.focus();
    }
  }

  window.LWCopiloto = { toggle, enviar };
})();
