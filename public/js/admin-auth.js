/**
 * admin-auth.js — Módulo de Autenticação para Área Administrador
 * Lightwall SC · Sistema de Injeção V1.0
 *
 * [v2.0] Verificação de senha e arquivo de recuperação movida para o back-end.
 *        O front-end envia a senha em texto plano via POST para /verificar-senha
 *        e o servidor compara com o hash SHA-256 armazenado em security.json.
 *        Isso resolve o bloqueio do crypto.subtle em contextos HTTP não seguros
 *        (ex.: VMs Google Cloud sem HTTPS).
 *
 * Chave localStorage: "lw_admin_authenticated"
 */

const AdminAuth = (() => {

  const LS_KEY = 'lw_admin_authenticated';

  // ─── Estado interno da recuperação (sem exposição externa) ─────────────────
  const _recuperacao = {
    tentativasInvalidas: 0,
    bloqueadoAte: null,
    MAX_TENTATIVAS: 5,
    BLOQUEIO_MS: 5 * 60 * 1000, // 5 minutos
  };

  // ─── Verifica a senha no back-end ──────────────────────────────────────────
  // Envia a senha em texto plano via HTTPS/HTTP para o servidor,
  // que compara com o hash SHA-256 armazenado em security.json.
  async function verificarSenha(senha) {
    try {
      const res = await fetch('/verificar-senha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senha }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data.ok === true;
    } catch (_) {
      return false;
    }
  }

  // ─── Verifica arquivo de recuperação no back-end ───────────────────────────
  async function _validarArquivoRecuperacao(conteudo) {
    try {
      const res = await fetch('/verificar-recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chave: conteudo.trim() }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data.ok === true;
    } catch (_) {
      return false;
    }
  }

  // ─── Gera hash de nova senha no back-end ───────────────────────────────────
  // Usado ao redefinir senha via recuperação.
  async function _gerarHashNoServidor(senha) {
    const res = await fetch('/gerar-hash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senha }),
    });
    if (!res.ok) throw new Error('Falha ao gerar hash no servidor.');
    const data = await res.json();
    return data.hash;
  }

  // ─── Verifica se há sessão autenticada no localStorage ─────────────────────
  function isAutenticado() {
    return localStorage.getItem(LS_KEY) === 'true';
  }

  // ─── Persiste autenticação no localStorage ─────────────────────────────────
  function _salvarSessao() {
    localStorage.setItem(LS_KEY, 'true');
  }

  // ─── Remove autenticação (logout) ──────────────────────────────────────────
  function logout() {
    localStorage.removeItem(LS_KEY);
    sessionStorage.clear();
    window.location.href = 'login.html';
  }

  // ─── Salva novo passwordHash no servidor via POST ──────────────────────────
  async function _salvarNovaSenha(novoHash) {
    // Lê recoveryKeyHash atual do servidor para não sobrescrever
    const resSec = await fetch('db/security.json', { cache: 'no-store' });
    const security = resSec.ok ? await resSec.json() : {};

    const payload = {
      passwordHash:    novoHash,
      recoveryKeyHash: security.recoveryKeyHash || '',
    };
    const res = await fetch('/salvar-security', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Falha ao salvar nova senha no servidor.');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BLOQUEIO DE RECUPERAÇÃO
  // ═══════════════════════════════════════════════════════════════════════════

  function _estaBloqueado() {
    if (!_recuperacao.bloqueadoAte) return false;
    if (Date.now() < _recuperacao.bloqueadoAte) return true;
    _recuperacao.bloqueadoAte = null;
    _recuperacao.tentativasInvalidas = 0;
    return false;
  }

  function _tempoRestanteBloqueio() {
    if (!_recuperacao.bloqueadoAte) return '';
    const ms = _recuperacao.bloqueadoAte - Date.now();
    if (ms <= 0) return '';
    const min = Math.floor(ms / 60000);
    const seg = Math.floor((ms % 60000) / 1000);
    return `${min}m ${seg.toString().padStart(2, '0')}s`;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODAL DE LOGIN — criação e eventos
  // ═══════════════════════════════════════════════════════════════════════════

  function _criarModal() {
    if (document.getElementById('admin-auth-modal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'admin-auth-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'admin-auth-title');
    overlay.style.cssText = `
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.78);
      z-index: 9999;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(4px);
    `;

    overlay.innerHTML = `
      <div id="admin-auth-box" style="
        background: #1a1a2e;
        border: 1px solid #2d2d4e;
        border-radius: 14px;
        padding: 36px 32px 28px;
        width: 380px;
        max-width: 94vw;
        box-shadow: 0 32px 96px rgba(0,0,0,.7);
        position: relative;
      ">
        <!-- Cabeçalho -->
        <div style="text-align:center;margin-bottom:28px">
          <div style="font-size:2rem;margin-bottom:10px">🔒</div>
          <h2 id="admin-auth-title" style="
            font-family: 'Barlow Condensed', 'Barlow', sans-serif;
            font-size: 1.35rem;
            font-weight: 700;
            letter-spacing: .1em;
            text-transform: uppercase;
            color: #f59e0b;
            margin: 0 0 6px;
          ">Área Restrita</h2>
          <p style="color:#9ca3af;font-size:.82rem;margin:0">
            Informe a senha de administrador para continuar.
          </p>
        </div>

        <!-- Campo de senha -->
        <div style="margin-bottom:16px">
          <label for="admin-auth-senha" style="
            display:block;
            font-size:.75rem;
            text-transform:uppercase;
            letter-spacing:.1em;
            color:#9ca3af;
            margin-bottom:7px;
          ">Senha</label>
          <input
            id="admin-auth-senha"
            type="password"
            autocomplete="current-password"
            placeholder="••••••••"
            style="
              width: 100%;
              box-sizing: border-box;
              background: #0f0f1a;
              border: 1px solid #2d2d4e;
              border-radius: 7px;
              color: #e5e7eb;
              font-size: 1rem;
              padding: 10px 14px;
              outline: none;
              transition: border-color .2s;
            "
          >
        </div>

        <!-- Mensagem de erro -->
        <div id="admin-auth-erro" style="
          display: none;
          background: rgba(239,68,68,.12);
          border: 1px solid rgba(239,68,68,.35);
          border-radius: 6px;
          color: #f87171;
          font-size: .82rem;
          padding: 9px 13px;
          margin-bottom: 16px;
        ">Senha incorreta.</div>

        <!-- Botões -->
        <div style="display:flex;gap:10px;margin-bottom:16px">
          <button id="admin-auth-btn-cancelar" style="
            flex: 1;
            background: transparent;
            border: 1px solid #2d2d4e;
            border-radius: 7px;
            color: #9ca3af;
            font-size: .9rem;
            padding: 10px;
            cursor: pointer;
            transition: border-color .2s, color .2s;
          ">Cancelar</button>
          <button id="admin-auth-btn-entrar" style="
            flex: 2;
            background: #f59e0b;
            border: none;
            border-radius: 7px;
            color: #0f0f1a;
            font-size: .9rem;
            font-weight: 700;
            padding: 10px;
            cursor: pointer;
            transition: background .2s, opacity .2s;
          ">Entrar</button>
        </div>

        <!-- Esqueci a senha -->
        <div style="text-align:center">
          <button id="admin-auth-btn-esqueceu" style="
            background: none;
            border: none;
            color: #6b7280;
            font-size: .78rem;
            cursor: pointer;
            text-decoration: underline;
            padding: 0;
          ">Esqueci minha senha</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    _bindEventos(overlay);
  }

  // ─── Vincula eventos do modal de login ─────────────────────────────────────
  function _bindEventos(overlay) {
    const senhaInput = document.getElementById('admin-auth-senha');
    const btnEntrar  = document.getElementById('admin-auth-btn-entrar');
    const btnCancel  = document.getElementById('admin-auth-btn-cancelar');
    const btnEsquec  = document.getElementById('admin-auth-btn-esqueceu');
    const erroEl     = document.getElementById('admin-auth-erro');

    btnEntrar.addEventListener('mouseenter', () => { btnEntrar.style.background = '#d97706'; });
    btnEntrar.addEventListener('mouseleave', () => { btnEntrar.style.background = '#f59e0b'; });
    btnCancel.addEventListener('mouseenter', () => { btnCancel.style.borderColor = '#6b7280'; btnCancel.style.color = '#e5e7eb'; });
    btnCancel.addEventListener('mouseleave', () => { btnCancel.style.borderColor = '#2d2d4e'; btnCancel.style.color = '#9ca3af'; });

    senhaInput.addEventListener('focus', () => { senhaInput.style.borderColor = '#f59e0b'; });
    senhaInput.addEventListener('blur',  () => { senhaInput.style.borderColor = '#2d2d4e'; });

    senhaInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') _tentarLogin();
    });

    btnEntrar.addEventListener('click', _tentarLogin);
    btnCancel.addEventListener('click', _cancelar);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) _cancelar();
    });

    btnEsquec.addEventListener('click', () => {
      fecharModal();
      abrirModalRecuperacao();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.style.display === 'flex') _cancelar();
    });

    // Fecha por cancelamento explícito (botão Cancelar, Esc, clique fora) —
    // diferente de um login bem-sucedido, que fecha direto via fecharModal()
    // dentro de _tentarLogin. Dispara onCancel (se foi passado pra
    // abrirModal), pra quem abriu saber que NÃO foi autenticado.
    function _cancelar() {
      fecharModal();
      if (typeof AdminAuth._onCancel === 'function') {
        const cb = AdminAuth._onCancel;
        AdminAuth._onCancel = null;
        cb();
      }
    }

    async function _tentarLogin() {
      const senha = senhaInput.value;
      erroEl.style.display = 'none';

      btnEntrar.textContent = '…';
      btnEntrar.disabled = true;

      const ok = await verificarSenha(senha);

      btnEntrar.textContent = 'Entrar';
      btnEntrar.disabled = false;

      if (ok) {
        _salvarSessao();
        fecharModal();
        AdminAuth._onCancel = null; // autenticou — não é mais uma "recusa" se o modal fechar de novo depois
        if (typeof AdminAuth._onSuccess === 'function') {
          AdminAuth._onSuccess();
        }
      } else {
        erroEl.style.display = 'block';
        senhaInput.value = '';
        senhaInput.focus();
      }
    }
  }

  // ─── Abre o modal de login ─────────────────────────────────────────────────
  // onCancel (opcional): chamado se a pessoa fechar sem entrar a senha
  // certa (botão Cancelar, Esc, clique fora) — diferente de simplesmente
  // não fazer nada, útil quando reabrir o modal foi uma EXIGÊNCIA (ex:
  // reautenticação ao voltar do cache do navegador — ver index.html) e
  // cancelar precisa ter uma consequência (tirar a pessoa da área admin).
  function abrirModal(onSuccess, onCancel) {
    _criarModal();
    AdminAuth._onSuccess = onSuccess || null;
    AdminAuth._onCancel = onCancel || null;

    const overlay = document.getElementById('admin-auth-modal');
    const erroEl  = document.getElementById('admin-auth-erro');
    const senhaEl = document.getElementById('admin-auth-senha');

    erroEl.style.display = 'none';
    senhaEl.value        = '';

    overlay.style.display = 'flex';
    setTimeout(() => senhaEl.focus(), 60);
  }

  // ─── Fecha o modal de login ────────────────────────────────────────────────
  function fecharModal() {
    const overlay = document.getElementById('admin-auth-modal');
    if (overlay) overlay.style.display = 'none';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODAL DE RECUPERAÇÃO DE SENHA
  // ═══════════════════════════════════════════════════════════════════════════

  function _criarModalRecuperacao() {
    if (document.getElementById('lw-recovery-modal')) return;

    const overlay = document.createElement('div');
    overlay.id = 'lw-recovery-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'lw-recovery-title');
    overlay.style.cssText = `
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.82);
      z-index: 10000;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(4px);
    `;

    overlay.innerHTML = `
      <div id="lw-recovery-box" style="
        background: #1a1a2e;
        border: 1px solid #2d2d4e;
        border-radius: 14px;
        padding: 36px 32px 28px;
        width: 400px;
        max-width: 94vw;
        box-shadow: 0 32px 96px rgba(0,0,0,.75);
        position: relative;
      ">
        <!-- Cabeçalho -->
        <div style="text-align:center;margin-bottom:24px">
          <div style="font-size:2rem;margin-bottom:10px">🔑</div>
          <h2 id="lw-recovery-title" style="
            font-family: 'Barlow Condensed','Barlow',sans-serif;
            font-size: 1.25rem;
            font-weight: 700;
            letter-spacing: .1em;
            text-transform: uppercase;
            color: #f59e0b;
            margin: 0 0 6px;
          ">Recuperação de Senha</h2>
          <p id="lw-recovery-subtitulo" style="color:#9ca3af;font-size:.82rem;margin:0">
            Selecione seu arquivo de recuperação.
          </p>
        </div>

        <!-- ETAPA 1: seleção do arquivo -->
        <div id="lw-recovery-etapa1">
          <div style="
            border: 2px dashed #2d2d4e;
            border-radius: 10px;
            padding: 24px 16px;
            text-align: center;
            margin-bottom: 16px;
            transition: border-color .2s;
          " id="lw-recovery-dropzone">
            <div style="font-size:1.6rem;margin-bottom:8px">📁</div>
            <p style="color:#6b7280;font-size:.82rem;margin:0 0 14px">
              Arquivo <code style="color:#f59e0b;background:rgba(245,158,11,.1);padding:2px 6px;border-radius:4px">.key</code> gerado na configuração inicial
            </p>
            <button id="lw-recovery-btn-arquivo" style="
              background: #f59e0b;
              border: none;
              border-radius: 7px;
              color: #0f0f1a;
              font-size: .88rem;
              font-weight: 700;
              padding: 9px 22px;
              cursor: pointer;
              transition: background .2s;
            ">Selecionar Arquivo</button>
            <input id="lw-recovery-input-file" type="file" accept=".key" style="display:none">
          </div>

          <div id="lw-recovery-erro-arquivo" style="
            display: none;
            background: rgba(239,68,68,.12);
            border: 1px solid rgba(239,68,68,.35);
            border-radius: 6px;
            color: #f87171;
            font-size: .82rem;
            padding: 9px 13px;
            margin-bottom: 14px;
          "></div>

          <div id="lw-recovery-bloqueio" style="
            display: none;
            background: rgba(239,68,68,.08);
            border: 1px solid rgba(239,68,68,.25);
            border-radius: 6px;
            color: #fca5a5;
            font-size: .82rem;
            padding: 10px 14px;
            margin-bottom: 14px;
            text-align: center;
          "></div>
        </div>

        <!-- ETAPA 2: formulário de nova senha -->
        <div id="lw-recovery-etapa2" style="display:none">
          <div style="margin-bottom:14px">
            <label for="lw-recovery-nova-senha" style="
              display:block;font-size:.75rem;text-transform:uppercase;
              letter-spacing:.1em;color:#9ca3af;margin-bottom:7px;
            ">Nova Senha</label>
            <input id="lw-recovery-nova-senha" type="password" autocomplete="new-password"
              placeholder="Mínimo 6 caracteres"
              style="
                width:100%;box-sizing:border-box;background:#0f0f1a;
                border:1px solid #2d2d4e;border-radius:7px;color:#e5e7eb;
                font-size:1rem;padding:10px 14px;outline:none;transition:border-color .2s;
              ">
          </div>

          <div style="margin-bottom:16px">
            <label for="lw-recovery-confirmar-senha" style="
              display:block;font-size:.75rem;text-transform:uppercase;
              letter-spacing:.1em;color:#9ca3af;margin-bottom:7px;
            ">Confirmar Nova Senha</label>
            <input id="lw-recovery-confirmar-senha" type="password" autocomplete="new-password"
              placeholder="Repita a nova senha"
              style="
                width:100%;box-sizing:border-box;background:#0f0f1a;
                border:1px solid #2d2d4e;border-radius:7px;color:#e5e7eb;
                font-size:1rem;padding:10px 14px;outline:none;transition:border-color .2s;
              ">
          </div>

          <div id="lw-recovery-erro-senha" style="
            display:none;
            background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);
            border-radius:6px;color:#f87171;font-size:.82rem;
            padding:9px 13px;margin-bottom:14px;
          "></div>

          <button id="lw-recovery-btn-salvar" style="
            width:100%;background:#f59e0b;border:none;border-radius:7px;
            color:#0f0f1a;font-size:.95rem;font-weight:700;
            padding:11px;cursor:pointer;transition:background .2s;
          ">Salvar Nova Senha</button>
        </div>

        <!-- Mensagem de sucesso -->
        <div id="lw-recovery-sucesso" style="
          display:none;
          background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);
          border-radius:8px;color:#4ade80;font-size:.88rem;
          padding:12px 16px;text-align:center;margin-bottom:14px;
        ">✓ Senha redefinida com sucesso.</div>

        <!-- Rodapé -->
        <div style="text-align:center;margin-top:18px">
          <button id="lw-recovery-btn-voltar" style="
            background:none;border:none;color:#6b7280;
            font-size:.78rem;cursor:pointer;text-decoration:underline;padding:0;
          ">← Voltar para o login</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    _bindEventosRecuperacao(overlay);
  }

  // ─── Vincula eventos do modal de recuperação ───────────────────────────────
  function _bindEventosRecuperacao(overlay) {
    const btnArquivo  = document.getElementById('lw-recovery-btn-arquivo');
    const inputFile   = document.getElementById('lw-recovery-input-file');
    const erroArquivo = document.getElementById('lw-recovery-erro-arquivo');
    const bloqueioEl  = document.getElementById('lw-recovery-bloqueio');
    const etapa1      = document.getElementById('lw-recovery-etapa1');
    const etapa2      = document.getElementById('lw-recovery-etapa2');
    const novaSenhaEl = document.getElementById('lw-recovery-nova-senha');
    const confSenhaEl = document.getElementById('lw-recovery-confirmar-senha');
    const erroSenha   = document.getElementById('lw-recovery-erro-senha');
    const btnSalvar   = document.getElementById('lw-recovery-btn-salvar');
    const sucessoEl   = document.getElementById('lw-recovery-sucesso');
    const btnVoltar   = document.getElementById('lw-recovery-btn-voltar');
    const subtitulo   = document.getElementById('lw-recovery-subtitulo');

    let _timerBloqueio = null;

    btnArquivo.addEventListener('mouseenter', () => { btnArquivo.style.background = '#d97706'; });
    btnArquivo.addEventListener('mouseleave', () => { btnArquivo.style.background = '#f59e0b'; });
    btnSalvar.addEventListener('mouseenter', () => { btnSalvar.style.background = '#d97706'; });
    btnSalvar.addEventListener('mouseleave', () => { btnSalvar.style.background = '#f59e0b'; });

    [novaSenhaEl, confSenhaEl].forEach(el => {
      el.addEventListener('focus', () => { el.style.borderColor = '#f59e0b'; });
      el.addEventListener('blur',  () => { el.style.borderColor = '#2d2d4e'; });
    });

    btnArquivo.addEventListener('click', () => {
      if (_estaBloqueado()) { _mostrarBloqueio(); return; }
      inputFile.value = '';
      inputFile.click();
    });

    inputFile.addEventListener('change', async () => {
      const arquivo = inputFile.files[0];
      if (!arquivo) return;
      await _processarArquivo(arquivo);
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) _fecharRecuperacao();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.style.display === 'flex') _fecharRecuperacao();
    });

    btnVoltar.addEventListener('click', () => {
      _fecharRecuperacao();
      abrirModal(AdminAuth._onSuccess);
    });

    btnSalvar.addEventListener('click', _salvarSenha);
    [novaSenhaEl, confSenhaEl].forEach(el => {
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') _salvarSenha(); });
    });

    // ── Processa arquivo .key — valida no back-end ────────────────────────────
    async function _processarArquivo(arquivo) {
      if (_estaBloqueado()) { _mostrarBloqueio(); return; }

      erroArquivo.style.display = 'none';
      bloqueioEl.style.display  = 'none';
      btnArquivo.textContent    = 'Validando…';
      btnArquivo.disabled       = true;

      try {
        const conteudo = await _lerArquivo(arquivo);
        const valido   = await _validarArquivoRecuperacao(conteudo);

        if (valido) {
          _recuperacao.tentativasInvalidas = 0;
          _recuperacao.bloqueadoAte        = null;

          etapa1.style.display  = 'none';
          etapa2.style.display  = 'block';
          subtitulo.textContent = 'Defina sua nova senha de administrador.';
          setTimeout(() => novaSenhaEl.focus(), 60);
        } else {
          _recuperacao.tentativasInvalidas++;

          if (_recuperacao.tentativasInvalidas >= _recuperacao.MAX_TENTATIVAS) {
            _recuperacao.bloqueadoAte = Date.now() + _recuperacao.BLOQUEIO_MS;
            _mostrarBloqueio();
          } else {
            const restantes = _recuperacao.MAX_TENTATIVAS - _recuperacao.tentativasInvalidas;
            _mostrarErroArquivo(
              `Arquivo de recuperação inválido. Tentativa ${_recuperacao.tentativasInvalidas}/${_recuperacao.MAX_TENTATIVAS} — ${restantes} restante(s) antes do bloqueio.`
            );
          }
        }
      } catch (_) {
        _mostrarErroArquivo('Erro ao ler o arquivo. Verifique se é um arquivo .key válido.');
      } finally {
        inputFile.value        = '';
        btnArquivo.textContent = 'Selecionar Arquivo';
        btnArquivo.disabled    = false;
      }
    }

    function _lerArquivo(arquivo) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Leitura falhou'));
        reader.readAsText(arquivo, 'UTF-8');
      });
    }

    function _mostrarErroArquivo(msg) {
      erroArquivo.textContent   = msg;
      erroArquivo.style.display = 'block';
    }

    function _mostrarBloqueio() {
      erroArquivo.style.display = 'none';
      btnArquivo.disabled       = true;

      if (_timerBloqueio) clearInterval(_timerBloqueio);

      function _atualizar() {
        if (!_estaBloqueado()) {
          bloqueioEl.style.display = 'none';
          btnArquivo.disabled      = false;
          clearInterval(_timerBloqueio);
          _recuperacao.tentativasInvalidas = 0;
          return;
        }
        bloqueioEl.style.display = 'block';
        bloqueioEl.textContent   =
          `🔒 Muitas tentativas inválidas. Aguarde ${_tempoRestanteBloqueio()} para tentar novamente.`;
      }

      _atualizar();
      _timerBloqueio = setInterval(_atualizar, 1000);
    }

    // ── Valida e salva nova senha — hash gerado no back-end ───────────────────
    async function _salvarSenha() {
      const nova     = novaSenhaEl.value;
      const confirma = confSenhaEl.value;

      erroSenha.style.display = 'none';

      if (!nova || !confirma) {
        erroSenha.textContent   = 'Preencha todos os campos.';
        erroSenha.style.display = 'block';
        return;
      }
      if (nova.length < 6) {
        erroSenha.textContent   = 'A senha deve ter no mínimo 6 caracteres.';
        erroSenha.style.display = 'block';
        return;
      }
      if (nova !== confirma) {
        erroSenha.textContent   = 'As senhas não coincidem.';
        erroSenha.style.display = 'block';
        confSenhaEl.value       = '';
        confSenhaEl.focus();
        return;
      }

      btnSalvar.textContent = 'Salvando…';
      btnSalvar.disabled    = true;

      try {
        // Hash gerado no servidor — sem crypto.subtle no front
        const novoHash = await _gerarHashNoServidor(nova);
        await _salvarNovaSenha(novoHash);

        novaSenhaEl.value = '';
        confSenhaEl.value = '';

        etapa2.style.display    = 'none';
        sucessoEl.style.display = 'block';
        subtitulo.textContent   = 'Senha redefinida com sucesso.';

        setTimeout(() => {
          _fecharRecuperacao();
          abrirModal(AdminAuth._onSuccess);
        }, 2000);

      } catch (err) {
        erroSenha.textContent   = 'Erro ao salvar: ' + err.message;
        erroSenha.style.display = 'block';
        btnSalvar.textContent   = 'Salvar Nova Senha';
        btnSalvar.disabled      = false;
      }
    }

    function _fecharRecuperacao() {
      overlay.style.display = 'none';

      etapa1.style.display    = 'block';
      etapa2.style.display    = 'none';
      sucessoEl.style.display = 'none';

      erroArquivo.style.display = 'none';
      bloqueioEl.style.display  = 'none';
      erroSenha.style.display   = 'none';

      novaSenhaEl.value = '';
      confSenhaEl.value = '';
      subtitulo.textContent = 'Selecione seu arquivo de recuperação.';

      btnSalvar.textContent  = 'Salvar Nova Senha';
      btnSalvar.disabled     = false;
      btnArquivo.textContent = 'Selecionar Arquivo';
      btnArquivo.disabled    = false;

      if (_timerBloqueio) { clearInterval(_timerBloqueio); _timerBloqueio = null; }
    }
  }

  // ─── Abre o modal de recuperação ──────────────────────────────────────────
  function abrirModalRecuperacao() {
    _criarModalRecuperacao();

    const overlay     = document.getElementById('lw-recovery-modal');
    const etapa1      = document.getElementById('lw-recovery-etapa1');
    const etapa2      = document.getElementById('lw-recovery-etapa2');
    const sucessoEl   = document.getElementById('lw-recovery-sucesso');
    const erroArquivo = document.getElementById('lw-recovery-erro-arquivo');
    const bloqueioEl  = document.getElementById('lw-recovery-bloqueio');
    const btnArquivo  = document.getElementById('lw-recovery-btn-arquivo');
    const subtitulo   = document.getElementById('lw-recovery-subtitulo');

    etapa1.style.display      = 'block';
    etapa2.style.display      = 'none';
    sucessoEl.style.display   = 'none';
    erroArquivo.style.display = 'none';
    bloqueioEl.style.display  = 'none';
    subtitulo.textContent     = 'Selecione seu arquivo de recuperação.';
    btnArquivo.disabled       = _estaBloqueado();

    overlay.style.display = 'flex';
  }

  // ─── API pública ───────────────────────────────────────────────────────────
  return {
    isAutenticado,
    abrirModal,
    fecharModal,
    logout,
    abrirModalRecuperacao,
    _onSuccess: null,
    _onCancel: null,
  };

})();