// ─── exportar-pdf-status.js — Etapa 6 do plano "PDF sobrevive a fechar a
// aba" (ver PLANO-pdf-segundo-plano.md / README) ───────────────────────────
//
// Até aqui (Etapas 1-5), o job de exportação já sobrevive a fechar a aba,
// tem dono, é persistido em SQLite/disco e não deixa a pessoa iniciar um
// segundo PDF enquanto o primeiro não é resolvido — mas nada disso
// aparecia NA TELA se a pessoa não estivesse mais olhando a barra de
// progresso (ex: fechou a aba, ou nem chegou a esperar). Este arquivo é
// o pedaço que fecha o ciclo do lado do usuário:
//
//   1. Ao carregar QUALQUER página do app (boot, ver app-core.js), chama
//      `GET /exportar-pdf/meu-status` pra saber se existe um job seu
//      pendente — mesmo que tenha sido iniciado numa aba/dispositivo
//      diferente, ou há dias atrás.
//   2. Se o job ainda está 'processando', reconecta no MESMO mecanismo de
//      Server-Sent Events que a tela de origem usava (`GET
//      /exportar-pdf/eventos/:jobId`, ver public/js/data.js/
//      baixarPdfApartirDeHtml) — só que aqui é read-only: não tenta gerar
//      nada de novo, só acompanha até um evento terminal.
//   3. Se o job está 'concluido', mostra o badge "📄 PDF pronto" na
//      topbar (mesmo padrão visual de #topbar-fila-pendentes, ver
//      nav-topbar.html) — clicando nele abre um popover com o nome do
//      arquivo e os botões Baixar/Descartar.
//   4. Baixar (Etapa 7 — ver lib/rotas/exportar-pdf.js) volta a liberar o
//      usuário pra gerar outro PDF sozinho, assim que o download termina
//      por completo — sem precisar descartar depois. `POST
//      /exportar-pdf/descartar/:jobId` continua existindo pra quem
//      decide não baixar (ex.: gerou por engano).
//
// Complementado pela notificação PUSH (`notificarPdfPronto`, ver
// lib/notificacoes-push.js, disparada por `_concluirJob` no servidor
// assim que o PDF fica pronto) — cobre o caso da pessoa ter fechado a
// aba de vez: a notificação chega mesmo sem ninguém olhando o app, e ao
// clicar nela a pessoa cai aqui de novo (ver `?pdfPronto=ID` abaixo, e o
// listener de 'message' do service worker em app-core.js, mesmo padrão
// já usado por chamado/programada de manutenção).
//
// Funções globais (mesmo padrão do resto do projeto — sem módulo/build
// step, tudo pendurado em `window.LWExportarPdfStatus`).

(function () {
  let _job = null; // { jobId, status, nomeArquivo, fase, feito, total, segundosRestantes }
  let _eventos = null; // EventSource ativo (só existe enquanto status === 'processando')

  function $(id) { return document.getElementById(id); }

  function _limparSse() {
    if (_eventos) {
      try { _eventos.close(); } catch (_) { /* já pode ter caído sozinha */ }
      _eventos = null;
    }
  }

  // Rótulo curto pro badge — cada fase usa o mesmo vocabulário que a
  // barra de progresso original (ver public/js/analise-focada.js), só
  // resumido pra caber num badge pequeno da topbar.
  function _rotuloBadge() {
    if (!_job) return '';
    if (_job.status === 'concluido') return 'PDF pronto';
    if (_job.status === 'processando') {
      if (_job.fase === 'carregando') return 'Gerando PDF…';
      if (_job.fase === 'ajustando') return 'Gerando PDF…';
      if (_job.fase === 'imprimindo' && _job.total > 0) {
        return `Gerando PDF (${_job.feito}/${_job.total})…`;
      }
      return 'Gerando PDF…';
    }
    return '';
  }

  function _atualizarBadge() {
    const btn = $('btn-exportar-pdf-status');
    const label = $('exportar-pdf-status-label');
    if (!btn || !label) return;
    if (!_job || (_job.status !== 'processando' && _job.status !== 'concluido')) {
      btn.style.display = 'none';
      return;
    }
    label.textContent = _rotuloBadge();
    btn.style.display = 'inline-flex';
  }

  // Baixa o arquivo já pronto — mesmo mecanismo de download (Blob + <a>
  // temporário) usado por baixarPdfApartirDeHtml/baixarArquivoTexto
  // (public/js/data.js), só que aqui o job JÁ EXISTE (não inicia nada
  // novo) — é só o passo final de "GET /arquivo/:jobId + salvar".
  async function _baixarArquivo(jobId, nomeArquivo) {
    const resp = await fetch(`/exportar-pdf/arquivo/${jobId}`);
    if (!resp.ok) {
      let mensagem = 'Não consegui baixar o PDF agora.';
      try {
        const erro = await resp.json();
        if (erro && erro.erro) mensagem = erro.erro;
      } catch (_) { /* usa a mensagem padrão */ }
      throw new Error(mensagem);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nomeArquivo || 'exportacao.pdf';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function _renderPopover() {
    const conteudo = $('exportar-pdf-status-conteudo');
    if (!conteudo || !_job) return;

    if (_job.status === 'processando') {
      const progresso = (_job.total > 0) ? Math.round((_job.feito / _job.total) * 100) : null;
      conteudo.innerHTML = `
        <div style="font-size:.85rem;font-weight:600;color:var(--text);margin-bottom:6px">📄 Gerando seu PDF…</div>
        <div style="font-size:.78rem;color:var(--text-2);margin-bottom:10px">
          ${_escaparHtml(_job.nomeArquivo || 'exportacao.pdf')}${progresso !== null ? ` — ${progresso}%` : ''}
        </div>
        <div style="font-size:.72rem;color:var(--text-3)">Pode fechar esta aba — o PDF continua sendo gerado no servidor. Você recebe um aviso assim que terminar.</div>
      `;
      return;
    }

    // 'concluido'
    conteudo.innerHTML = `
      <div style="font-size:.85rem;font-weight:600;color:var(--text);margin-bottom:6px">📄 PDF pronto</div>
      <div style="font-size:.78rem;color:var(--text-2);margin-bottom:12px;word-break:break-word">
        ${_escaparHtml(_job.nomeArquivo || 'exportacao.pdf')}
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" onclick="LWExportarPdfStatus.baixar(event)" style="flex:1">⬇ Baixar</button>
        <button class="btn btn-ghost btn-sm" onclick="LWExportarPdfStatus.descartar(event)" style="flex:1">🗑 Descartar</button>
      </div>
      <div id="exportar-pdf-status-erro" style="font-size:.72rem;color:var(--red);margin-top:8px;display:none"></div>
    `;
  }

  function _mostrarErroNoPopover(mensagem) {
    const el = $('exportar-pdf-status-erro');
    if (!el) return;
    el.textContent = mensagem;
    el.style.display = 'block';
  }

  // Acompanha o job por SSE — mesmo endpoint que a tela de origem usa
  // (ver baixarPdfApartirDeHtml, data.js), mas SÓ LEITURA: nunca manda
  // 'cancelar', nunca inicia nada. Se a conexão cair (rede, servidor
  // reiniciado), não tenta reconectar sozinho — na pior das hipóteses o
  // badge fica com o último progresso conhecido até a pessoa recarregar
  // a página, o que já dispara `iniciar()` de novo.
  function _conectarSse(jobId) {
    _limparSse();
    _eventos = new EventSource(`/exportar-pdf/eventos/${jobId}`);

    _eventos.addEventListener('progresso', (ev) => {
      if (!_job || _job.jobId !== jobId) return;
      try {
        const dados = JSON.parse(ev.data);
        _job.fase = dados.fase;
        _job.feito = dados.feito;
        _job.total = dados.total;
        _job.segundosRestantes = dados.segundosRestantes;
      } catch (_) { /* evento mal formado — ignora, próximo evento corrige */ }
      _atualizarBadge();
      _renderPopover();
    });

    _eventos.addEventListener('concluido', () => {
      if (!_job || _job.jobId !== jobId) return;
      _limparSse();
      _job.status = 'concluido';
      _atualizarBadge();
      _renderPopover();
      // Chegou pronto enquanto a pessoa olhava outra tela — abre o
      // popover sozinho pra chamar atenção, em vez de deixar o badge
      // mudar silenciosamente na topbar sem ninguém perceber.
      _abrirPopover();
    });

    _eventos.addEventListener('erro', () => {
      if (!_job || _job.jobId !== jobId) return;
      _limparSse();
      _job = null;
      _atualizarBadge();
      document.querySelectorAll('.ao-popover').forEach(p => p.classList.remove('active'));
    });

    _eventos.addEventListener('cancelado', () => {
      if (!_job || _job.jobId !== jobId) return;
      _limparSse();
      _job = null;
      _atualizarBadge();
      document.querySelectorAll('.ao-popover').forEach(p => p.classList.remove('active'));
    });

    _eventos.onerror = () => {
      // Conexão caiu por um motivo que não é nenhum evento terminal
      // (proxy, instabilidade) — não derruba `_job`: o badge continua
      // mostrando o último estado conhecido, só para de atualizar ao
      // vivo até a próxima vez que a página carregar.
      _limparSse();
    };
  }

  function _abrirPopover() {
    const el = $('popover-exportar-pdf-status');
    if (!el) return;
    document.querySelectorAll('.ao-popover').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
    _renderPopover();
  }

  // Extrai o `jobId` de "?pdfPronto=ID" — mesmo padrão de
  // _extrairChamadoIdDaUrl/_extrairProgramadaIdDaUrl (app-core.js), pro
  // deep-link da notificação push (ver notificarPdfPronto,
  // lib/notificacoes-push.js) abrir o popover certo direto, sem a pessoa
  // precisar procurar o badge sozinha.
  function _extrairJobIdDaNotificacao(urlStr) {
    try {
      return new URL(urlStr, window.location.origin).searchParams.get('pdfPronto');
    } catch (e) {
      return null;
    }
  }

  // Chamada no boot (ver app-core.js) — busca o job ativo do usuário
  // logado (se houver) e prepara o badge/SSE. Silenciosa de propósito:
  // sem sessão de usuário cadastrado (ex: Administrador Master, que usa
  // outra sessão — ver lib/sessao.js) a rota responde 403, tratado aqui
  // simplesmente como "nada pendente", sem erro visível nenhum.
  async function iniciar() {
    let dados;
    try {
      const resp = await fetch('/exportar-pdf/meu-status');
      if (!resp.ok) return; // sem sessão de usuário cadastrado, ou servidor sem suporte — nada a mostrar
      dados = await resp.json();
    } catch (_) {
      return; // sem rede no boot — não é crítico, a pessoa recarrega mais tarde
    }
    if (!dados || !dados.ok || !dados.job) return;

    _job = {
      jobId: dados.job.jobId,
      status: dados.job.status,
      nomeArquivo: dados.job.nomeArquivo,
      fase: dados.job.fase,
      feito: dados.job.feito,
      total: dados.job.total,
      segundosRestantes: dados.job.segundosRestantes,
    };
    _atualizarBadge();

    if (_job.status === 'processando') {
      _conectarSse(_job.jobId);
    }

    // Veio de um clique na notificação push "PDF pronto"? Abre o
    // popover direto, com o mesmo cuidado de limpar o parâmetro da URL
    // (ver _chamadoIdDaNotificacao, app-core.js) pra um F5 nesta aba não
    // reabrir o popover sozinho pra sempre.
    const idDaNotificacao = _extrairJobIdDaNotificacao(window.location.href);
    if (idDaNotificacao) {
      window.history.replaceState(null, '', window.location.pathname);
      if (idDaNotificacao === _job.jobId) _abrirPopover();
    }
  }

  window.LWExportarPdfStatus = {
    iniciar,

    toggle(event) {
      if (event) event.stopPropagation();
      if (!_job) return;
      const el = $('popover-exportar-pdf-status');
      if (!el) return;
      const jaAberto = el.classList.contains('active');
      document.querySelectorAll('.ao-popover').forEach(p => p.classList.remove('active'));
      if (!jaAberto) {
        el.classList.add('active');
        _renderPopover();
      }
    },

    // Recebido do listener de 'message' do service worker (mesmo padrão
    // de _abrirChamadoDeNotificacao/_abrirProgramadaDeNotificacao,
    // app-core.js) — clique na notificação com uma aba já aberta: o
    // service worker só FOCA a aba, sem recarregar, então quem abre o
    // popover aqui é este código, não o boot (que já rodou antes).
    abrirDeNotificacao(jobId) {
      if (!_job || _job.jobId !== jobId) return;
      _abrirPopover();
    },

    // Etapa 7 (ver lib/rotas/exportar-pdf.js): baixar volta a "resolver"
    // o job no servidor (apaga arquivo/registro assim que o download
    // termina por completo) — então aqui do lado do cliente o popover
    // fecha igual acontece em `descartar`, em vez de continuar
    // oferecendo "baixar de novo" (o job já não existe mais lá).
    async baixar(event) {
      if (event) event.stopPropagation();
      if (!_job) return;
      const el = $('exportar-pdf-status-erro');
      if (el) el.style.display = 'none';
      const jobId = _job.jobId;
      try {
        await _baixarArquivo(jobId, _job.nomeArquivo);
        _limparSse();
        _job = null;
        _atualizarBadge();
        document.querySelectorAll('.ao-popover').forEach(p => p.classList.remove('active'));
      } catch (e) {
        _mostrarErroNoPopover(e.message || 'Não consegui baixar o PDF agora.');
      }
    },

    async descartar(event) {
      if (event) event.stopPropagation();
      if (!_job) return;
      const jobId = _job.jobId;
      try {
        const resp = await fetch(`/exportar-pdf/descartar/${jobId}`, { method: 'POST' });
        if (!resp.ok) {
          let mensagem = 'Não consegui descartar o PDF agora.';
          try {
            const erro = await resp.json();
            if (erro && erro.erro) mensagem = erro.erro;
          } catch (_) { /* usa a mensagem padrão */ }
          throw new Error(mensagem);
        }
        _limparSse();
        _job = null;
        _atualizarBadge();
        document.querySelectorAll('.ao-popover').forEach(p => p.classList.remove('active'));
      } catch (e) {
        _mostrarErroNoPopover(e.message || 'Não consegui descartar o PDF agora.');
      }
    },
  };
})();
