'use strict';

(function () {

  // ============================================================
  // 0. FUNÇÕES DE COMPRESSÃO/DESCOMPRESSÃO DE PDF (Pako)
  // ============================================================
  // ALTERAÇÃO: A compressão GZIP foi removida para novos PDFs, pois é ineficaz 
  // (PDFs já são compactados internamente). Mantido o fallback para 
  // descompressão de dados antigos que porventura tenham sido comprimidos.
  function compressPDF(base64) {
      // Retorna o Base64 original sem tentar comprimir
      return base64;
  }

  function decompressPDF(compressedStr) {
    try {
        // Verifica se o dado antigo possui o prefixo de compressão (legado)
        if (compressedStr.startsWith('pdfgz:')) {
            const base64Data = compressedStr.replace('pdfgz:', '');
            const binaryString = atob(base64Data);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const decompressed = pako.ungzip(bytes);
            // Converte Uint8Array descomprimido de volta para base64
            let binary = '';
            const chunkSize = 1024;
            for (let i = 0; i < decompressed.length; i += chunkSize) {
                const chunk = decompressed.subarray(i, i + chunkSize);
                binary += String.fromCharCode.apply(null, chunk);
            }
            return 'data:application/pdf;base64,' + btoa(binary);
        } else {
            // Dados novos ou não comprimidos são retornados diretamente
            return compressedStr;
        }
    } catch (e) {
        console.error("Erro ao descomprimir PDF:", e);
        // Se falhar, retorna a string original (pode ser que o dado não esteja comprimido)
        return compressedStr;
    }
  }

  // ============================================================
  // 1. DADOS — Fase 2: backend real (SQLite via HTTP), não mais
  // localStorage (ver conversa que motivou a migração — Fase 1 salvava
  // tudo só neste navegador, sem sincronizar entre computadores nem
  // entrar em backup).
  //
  // As 4 listas continuam em memória, exatamente como na Fase 1 (o
  // resto do arquivo — render*, cálculos, etc. — usa esses arrays
  // diretamente) — só a ORIGEM dos dados mudou: em vez de
  // localStorage.getItem() síncrono no boot, agora é
  // carregarTudoDoServidor() assíncrono, chamado de dentro de init()
  // (ver final do arquivo). Cada ação de escrita (salvarManutencao(),
  // verificarEAgendiar(), etc.) manda a mudança pro servidor via fetch()
  // e, se aceita, RECARREGA a lista correspondente do servidor antes de
  // re-renderizar — nunca confia só no que já está em memória depois de
  // escrever, pra sempre refletir o que realmente foi persistido (e
  // pegar mudanças de outros computadores, se a pessoa atualizar a
  // página).
  let manutencoes = [];
  let agendamentos = [];

  async function carregarManutencoesDoServidor() {
    try {
      const res = await fetch('/manutencao/corretiva');
      const json = await res.json();
      manutencoes = (json.ok && json.chamados) || [];
    } catch (e) {
      console.error('[Manutenção] Falha ao carregar chamados corretivos:', e);
      manutencoes = [];
    }
  }

  async function carregarAgendamentosDoServidor() {
    try {
      const res = await fetch('/manutencao/programada');
      const json = await res.json();
      agendamentos = (json.ok && json.agendamentos) || [];
    } catch (e) {
      console.error('[Manutenção] Falha ao carregar agendamentos:', e);
      agendamentos = [];
    }
  }

  /** Carrega as listas do servidor em paralelo — chamada uma vez no boot (init()). */
  async function carregarTudoDoServidor() {
    await Promise.all([
      carregarManutencoesDoServidor(),
      carregarAgendamentosDoServidor(),
    ]);
  }

  let pageCorretiva = 0;
  let pageProgramada = 0;
  const ITEMS_PER_PAGE = 10;

  function toast(msg, tipo='success') {
    const container = document.getElementById('man-toastContainer');
    const t = document.createElement('div');
    t.className = `man-toast ${tipo === 'error' ? 'error' : ''}`;
    t.innerHTML = `<span>${tipo === 'error' ? '<i class="fas fa-exclamation-circle"></i>' : '<i class="fas fa-check-circle"></i>'}</span><span>${msg}</span>`;
    container.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  function gerarId(prefixo = 'MAN-') {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).substr(2, 4);
    return prefixo + ts + '-' + rand;
  }

  function esc(str) {
    if (!str) return '';
    return String(str).replace(/[&<>]/g, function(m) {
      if (m === '&') return '&amp;';
      if (m === '<') return '&lt;';
      if (m === '>') return '&gt;';
      return m;
    });
  }

  // ============================================================
  // 2. NAVEGAÇÃO
  // ============================================================
  function navegar(aba) {
    document.querySelectorAll('.man-nav-tabs .man-btn').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.man-page').forEach(el => el.classList.remove('active'));
    // "aba" chega sem prefixo (mesmos 3 nomes de sempre: manutencao,
    // programada, dashboard — ver onclick="navegar(...)" no HTML e a
    // chamada no boot, mais abaixo), mas o ID real do elemento na página
    // tem prefixo "man-" (ver page-manutencao.html) — prefixa aqui, uma
    // vez só, em vez de mudar todo mundo que chama navegar().
    const el = document.getElementById('man-' + aba);
    if(el) {
      el.classList.add('active');
      document.querySelectorAll('.man-nav-tabs .man-btn').forEach(b => {
        const btnText = b.textContent.toLowerCase();
        let shouldActive = false;
        if (aba === 'manutencao') shouldActive = btnText.includes('corretiva');
        else shouldActive = btnText.includes(aba);
        if (shouldActive) b.classList.add('active');
      });
      if(aba === 'dashboard') renderDashboard();
      if(aba === 'manutencao') { pageCorretiva = 0; renderCorretiva(); }
      if(aba === 'programada') { pageProgramada = 0; renderProgramada(); }
    }
  }

  // ============================================================
  // 3. LÓGICA DA MANUTENÇÃO CORRETIVA
  // ============================================================
  let prioridadeSelecionada = '';
  let tiposSelecionados = [];

  // ── Novo fluxo de aceite de chamado / pedido de peça (ver conversa que
  // motivou isso) ────────────────────────────────────────────────────────
  // Chamado atualmente aberto no formulário (ver editarManutencao) — null
  // quando é um chamado NOVO (novoChamado()), que ainda não existe no
  // servidor e portanto não tem nada pra aceitar ainda. Guardado num
  // módulo-level porque toggleSupervisorSection() e os botões "Aceitar…"
  // (chamados de fora de editarManutencao, via onclick inline) precisam
  // do estado atual sem re-buscar tudo de novo.
  let _chamadoEmEdicao = null;

  function _meuPerfilAtual() {
    try { return sessionStorage.getItem('lw_role'); } catch (_) { return null; }
  }
  function _souAdminAtual() {
    const p = _meuPerfilAtual();
    return p === 'Administrador' || p === 'Administrativo';
  }
  // Mesma regra de podeEditarAberturaChamado (server.js) — quem abriu OU
  // Admin OU Supervisão OU Encarregado. Só pra ESCONDER/DESABILITAR no
  // front; a validação que vale de verdade é sempre a do servidor.
  function _podeEditarAberturaChamadoAtual(m) {
    if (_souAdminAtual()) return true;
    const p = _meuPerfilAtual();
    if (p === 'Supervisao' || p === 'Encarregado') return true;
    const meuNome = (LW.nomeDeQuemEstaLogado() || '').trim().toLowerCase();
    return !!meuNome && meuNome === ((m && m.observador) || '').trim().toLowerCase();
  }
  // Mesma regra de podeAceitarChamado (server.js) — Manutenção, Admin,
  // Supervisão ou Encarregado, qualquer um dos 4.
  function _podeAceitarChamadoAtual() {
    if (_souAdminAtual()) return true;
    const p = _meuPerfilAtual();
    return p === 'Manutencao' || p === 'Supervisao' || p === 'Encarregado';
  }
  // Mesma regra de podeAceitarPedidoPeca (server.js) — só Supervisão,
  // Encarregado ou Admin (perfil Manutenção não aceita pedido de peça).
  function _podeAceitarPedidoPecaAtual() {
    if (_souAdminAtual()) return true;
    const p = _meuPerfilAtual();
    return p === 'Supervisao' || p === 'Encarregado';
  }

  function _idsSecaoAbertura() {
    return ['man-manSetor', 'man-manMaquina', 'man-manTurno', 'man-manData', 'man-manObservador'];
  }
  function _idsSecaoDetalhes() {
    return ['man-manAnomalia', 'man-manLocal', 'man-manTipoManutencao', 'man-manTipoEtiqueta'];
  }
  function _idsSecaoExecucao() {
    return ['man-manDataInicio', 'man-manHoraInicio', 'man-manDataFim', 'man-manHoraFim',
      'man-manTipoExecucao', 'man-manEmpresaExterna', 'man-manResponsavel', 'man-manSituacao',
      'man-manEmManutencao', 'man-manAguardandoPecas', 'man-manPecasAvariadas', 'man-manPecasComprar',
      'man-manRotina', 'man-manCustoMaoObra'];
  }
  function _idsSecaoAcompanhamento() {
    return ['man-supDataInicio', 'man-supHoraInicio', 'man-supDataFim', 'man-supHoraFim',
      'man-manStatusCompra', 'man-manPrevisaoChegada', 'man-manFornecedor', 'man-manCustoPecas',
      'man-manRespSupervisor', 'man-manObsSupervisor'];
  }
  function _setCamposEditaveis(ids, editavel) {
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.disabled = !editavel; });
  }
  // Abertura + Detalhes (Seções 1 e 2) — inclui os botões customizados de
  // Tipo de Anomalia e Prioridade, que não são <input>/<select> de verdade
  // (não têm "disabled" nativo), por isso o pointer-events à parte.
  function _setSecaoAberturaDetalhesEditavel(editavel) {
    _setCamposEditaveis(_idsSecaoAbertura(), editavel);
    _setCamposEditaveis(_idsSecaoDetalhes(), editavel);
    document.querySelectorAll('.man-tag-anomalia').forEach(el => {
      el.style.pointerEvents = editavel ? '' : 'none';
      el.style.opacity = editavel ? '' : '0.55';
    });
    document.querySelectorAll('.man-prioridade-btn').forEach(el => { el.disabled = !editavel; });
  }

  function _formatarDataHoraCurta(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch (_) { return ''; }
  }

  // Mostra/esconde a caixa "Aceitar Chamado" x os campos de Execução,
  // conforme _chamadoEmEdicao.aceito — com um 3º estado no meio, quando
  // há uma RECUSA pendente de revisão (ver conversa que motivou o fluxo
  // de recusa): nesse caso nem os botões normais (Aceitar/Recusar) nem os
  // campos de Execução aparecem, só o motivo da recusa + (pra quem pode
  // revisar) os botões "Aceitar Recusa"/"Negar Recusa". Chamada ao abrir
  // o formulário (ver editarManutencao) e de novo depois de
  // aceitar/recusar/revisar (aceitarChamado(), confirmarRecusaChamado(),
  // responderRecusaChamado()).
  function _atualizarGateExecucao() {
    const box = document.getElementById('man-aceitarChamadoBox');
    const campos = document.getElementById('man-techCampos');
    const normal = document.getElementById('man-aceitarChamadoNormal');
    const btnAceitar = document.getElementById('man-btnAceitarChamado');
    const btnRecusar = document.getElementById('man-btnRecusarChamado');
    const recusaBox = document.getElementById('man-recusaPendenteBox');
    const recusaBotoes = document.getElementById('man-recusaBotoesRevisor');
    const recusaSolicitante = document.getElementById('man-recusaInfoSolicitante');
    const recusaMotivo = document.getElementById('man-recusaInfoMotivo');
    if (!box || !campos || !normal || !btnAceitar || !btnRecusar || !recusaBox) return;
    const m = _chamadoEmEdicao;
    const aceito = m && m.aceito === 'Sim';
    const recusaPendente = m && m.recusaPendente === 'Sim';

    if (aceito) {
      box.style.display = 'none';
      campos.style.display = '';
      _setCamposEditaveis(_idsSecaoExecucao(), _podeAceitarChamadoAtual());
      return;
    }
    campos.style.display = 'none';
    box.style.display = m ? 'block' : 'none'; // chamado novo (m null): nada pra aceitar/recusar ainda

    if (recusaPendente) {
      normal.style.display = 'none';
      recusaBox.style.display = 'block';
      if (recusaSolicitante) recusaSolicitante.textContent = m.recusaSolicitadoPor || '—';
      if (recusaMotivo) recusaMotivo.textContent = m.recusaMotivo || '';
      const podeRevisar = _podeAceitarPedidoPecaAtual(); // mesmo grupo: Supervisão/Encarregado/Admin
      if (recusaBotoes) recusaBotoes.style.display = podeRevisar ? 'flex' : 'none';
    } else {
      recusaBox.style.display = 'none';
      normal.style.display = 'block';
      const podeAgir = _podeAceitarChamadoAtual(); // mesmo grupo: Manutenção/Supervisão/Encarregado/Admin
      btnAceitar.style.display = podeAgir ? 'inline-block' : 'none';
      btnRecusar.style.display = podeAgir ? 'inline-block' : 'none';
    }
  }

  // Mesma lógica de _atualizarGateExecucao(), pro pedido de peça (Seção
  // 4) — só relevante quando "Aguardando peças?" = Sim (ver
  // toggleSupervisorSection(), que controla a visibilidade da Seção 4
  // inteira; esta função só decide o que aparece DENTRO dela).
  function _atualizarGateAcompanhamento() {
    const box = document.getElementById('man-aceitarPedidoPecaBox');
    const campos = document.getElementById('man-supCampos');
    const btn = document.getElementById('man-btnAceitarPedidoPeca');
    if (!box || !campos || !btn) return;
    const m = _chamadoEmEdicao;
    const pedidoAceito = m && m.pedidoPecaAceito === 'Sim';
    if (pedidoAceito) {
      box.style.display = 'none';
      campos.style.display = '';
      _setCamposEditaveis(_idsSecaoAcompanhamento(), _podeAceitarPedidoPecaAtual());
    } else {
      campos.style.display = 'none';
      box.style.display = 'block';
      btn.style.display = _podeAceitarPedidoPecaAtual() ? 'inline-block' : 'none';
    }
  }

  // Aceitar o chamado atual (libera a Execução) — qualquer um dos 4
  // perfis (Manutenção/Admin/Supervisão/Encarregado); basta 1 aceitar.
  async function aceitarChamado() {
    const id = document.getElementById('man-manId')?.value;
    if (!id) return;
    const btn = document.getElementById('man-btnAceitarChamado');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/manutencao/aceitar-corretiva', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.erro || 'Erro ao aceitar chamado.');
      await carregarManutencoesDoServidor();
      toast('Chamado aceito! Os campos de Execução já estão liberados.');
      renderCorretiva();
      editarManutencao(id); // reabre o formulário já com o novo estado
    } catch (e) {
      toast('Erro ao aceitar: ' + e.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── Recusa de chamado ────────────────────────────────────────────────
  function abrirModalRecusaChamado() {
    const input = document.getElementById('man-recusaMotivoInput');
    if (input) input.value = '';
    const modal = document.getElementById('man-modalRecusaChamado');
    if (modal) modal.style.display = 'flex';
  }

  function fecharModalRecusaChamado() {
    const modal = document.getElementById('man-modalRecusaChamado');
    if (modal) modal.style.display = 'none';
  }

  // Confirma a recusa do chamado atual, com o motivo digitado no modal —
  // vira uma solicitação pendente pra Admin/Supervisão/Encarregado
  // revisarem (ver responderRecusaChamado(), abaixo).
  async function confirmarRecusaChamado() {
    const id = document.getElementById('man-manId')?.value;
    if (!id) return;
    const motivo = document.getElementById('man-recusaMotivoInput')?.value?.trim() || '';
    if (!motivo) { toast('Informe o motivo da recusa.', 'error'); return; }
    try {
      const res = await fetch('/manutencao/solicitar-recusa-corretiva', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, motivo }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.erro || 'Erro ao solicitar recusa.');
      await carregarManutencoesDoServidor();
      fecharModalRecusaChamado();
      toast('Recusa solicitada! Aguardando revisão de Supervisão, Encarregado ou Administrador.');
      renderCorretiva();
      editarManutencao(id);
    } catch (e) {
      toast('Erro ao solicitar recusa: ' + e.message, 'error');
    }
  }

  // Revisa uma recusa pendente do chamado atual — aceitaRecusa=true
  // ENCERRA o chamado; aceitaRecusa=false devolve pra Manutenção dar
  // prosseguimento (pedido do usuário). Só Supervisão/Encarregado/Admin
  // (mesmo grupo de aceitarPedidoPeca).
  async function responderRecusaChamado(aceitaRecusa) {
    const id = document.getElementById('man-manId')?.value;
    if (!id) return;
    if (aceitaRecusa && !confirm('Aceitar a recusa vai ENCERRAR este chamado. Confirma?')) return;
    try {
      const res = await fetch('/manutencao/responder-recusa-corretiva', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, aceitaRecusa }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.erro || 'Erro ao responder recusa.');
      await carregarManutencoesDoServidor();
      toast(aceitaRecusa
        ? 'Recusa aceita — chamado encerrado.'
        : 'Recusa negada — chamado devolvido pra Manutenção dar prosseguimento.');
      renderCorretiva();
      if (!aceitaRecusa) editarManutencao(id); // se encerrou, o form nem reabre (etiqueta fechada)
      else fecharFormulario();
    } catch (e) {
      toast('Erro ao responder recusa: ' + e.message, 'error');
    }
  }

  // Aceitar o PEDIDO DE PEÇA do chamado atual (libera o Acompanhamento da
  // Supervisão) — só Supervisão, Encarregado ou Admin.
  async function aceitarPedidoPeca() {
    const id = document.getElementById('man-manId')?.value;
    if (!id) return;
    const btn = document.getElementById('man-btnAceitarPedidoPeca');
    if (btn) btn.disabled = true;
    try {
      const res = await fetch('/manutencao/aceitar-pedido-peca', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.erro || 'Erro ao aceitar pedido de peça.');
      await carregarManutencoesDoServidor();
      toast('Pedido de peça aceito! Os campos de Acompanhamento já estão liberados.');
      renderCorretiva();
      editarManutencao(id);
    } catch (e) {
      toast('Erro ao aceitar pedido de peça: ' + e.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function previewArquivo(input, previewId, btnId) {
    const file = input.files[0];
    if (file) {
      const container = document.getElementById(previewId);
      container.style.display = 'block';
      document.getElementById(btnId).style.display = 'inline';
      if (file.type === 'application/pdf') {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = function(e) {
          const base64Data = e.target.result;
          // ALTERAÇÃO: Não comprime mais o PDF com GZIP
          container.innerHTML = `<div style="display:flex; align-items:center; gap:8px; padding:4px 12px; border:1px solid var(--accent); border-radius:4px;"><i class="fas fa-file-pdf" style="color:var(--red); font-size:24px;"></i><span style="font-size:12px;">${esc(file.name)}</span></div>`;
          container.dataset.filename = file.name;
          container.dataset.base64 = base64Data; // Armazena o dado sem compressão
        };
      } else {
        const compressed = await compressImage(file);
        container.innerHTML = `<img src="${compressed}" style="max-width:60px; max-height:60px; border-radius:4px; border:1px solid var(--border); object-fit:cover;">`;
      }
    }
  }

  function compressImage(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = (event) => {
        const img = new Image();
        img.src = event.target.result;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const MAX_WIDTH = 800, MAX_HEIGHT = 600;
          let width = img.width, height = img.height;
          if (width > height) {
            if (width > MAX_WIDTH) { height *= MAX_WIDTH / width; width = MAX_WIDTH; }
          } else {
            if (height > MAX_HEIGHT) { width *= MAX_HEIGHT / height; height = MAX_HEIGHT; }
          }
          canvas.width = width; canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.7));
        };
      };
    });
  }

  function removerArquivo(inputId, previewId, btnId) {
    document.getElementById(inputId).value = '';
    document.getElementById(previewId).style.display = 'none';
    document.getElementById(previewId).innerHTML = '';
    document.getElementById(previewId).dataset.filename = '';
    document.getElementById(previewId).dataset.base64 = '';
    document.getElementById(btnId).style.display = 'none';
  }

  function toggleEmpresaExterna() {
    const el = document.getElementById('man-manTipoExecucao');
    if (el) {
      const tipo = el.value;
      const row = document.getElementById('man-manEmpresaExternaRow');
      if (row) row.style.display = tipo === 'Externo' ? 'block' : 'none';
    }
  }
  
  function setPrioridade(valor) {
    prioridadeSelecionada = valor;
    document.getElementById('man-manPrioridade').value = valor;
    const classMap = { 'BAIXA': 'active-baixa', 'MÉDIA': 'active-media', 'ALTA': 'active-alta' };
    document.querySelectorAll('.man-prioridade-btn').forEach(el => {
      el.classList.remove('active-baixa', 'active-media', 'active-alta');
      if(el.dataset.value === valor) el.classList.add(classMap[valor]);
    });
  }

  function toggleTipo(tipo) {
    const index = tiposSelecionados.indexOf(tipo);
    if(index > -1) tiposSelecionados.splice(index, 1); else tiposSelecionados.push(tipo);
    document.getElementById('man-manTipos').value = JSON.stringify(tiposSelecionados);
    document.querySelectorAll('.man-tag-anomalia').forEach(el => el.classList.toggle('active', tiposSelecionados.includes(el.dataset.type)));
  }

  // Só reflete a mudança do dropdown "Aguardando peças?" na pílula "Peça"
  // do assistente (mostra/esconde/habilita) — não força navegação pra lá;
  // quem decide qual etapa fica visível agora é sempre
  // _manAplicarStepAtual() (chamado por dentro daqui).
  function toggleSupervisorSection() {
    const el = document.getElementById('man-manAguardandoPecas');
    if (!el) return;
    const aguardando = el.value === 'Sim';
    if (aguardando) _atualizarGateAcompanhamento();
    _manAplicarStepAtual();
  }

  function novoChamado() {
    _chamadoEmEdicao = null;
    const card = document.getElementById('man-formCard');
    if (card) card.style.display = 'block';
    const title = document.getElementById('man-formTitle');
    if (title) title.innerHTML = '<i class="fas fa-edit"></i> Novo Chamado (Operador)';
    const display = document.getElementById('man-formIdDisplay');
    if (display) display.textContent = '#' + gerarId();
    const aceiteInfo = document.getElementById('man-formAceiteInfo');
    if (aceiteInfo) aceiteInfo.textContent = '';
    document.getElementById('man-manId').value = '';
    document.getElementById('man-manEtiquetaFechada').value = 'false';
    _setSecaoAberturaDetalhesEditavel(true);
    document.getElementById('man-manForm').reset();
    const data = document.getElementById('man-manData');
    if (data) data.valueAsDate = new Date();
    document.getElementById('man-manPrioridade').value = '';
    document.getElementById('man-manTipos').value = '[]';
    document.getElementById('man-manTempoGasto').value = '';
    document.getElementById('man-supTempoGasto').value = '';
    document.getElementById('man-manEmpresaExternaRow').style.display = 'none';
    document.getElementById('man-manTipoEtiqueta').value = 'Azul';
    prioridadeSelecionada = ''; tiposSelecionados = [];
    document.querySelectorAll('.man-prioridade-btn').forEach(el => el.classList.remove('active-baixa', 'active-media', 'active-alta'));
    document.querySelectorAll('.man-tag-anomalia').forEach(el => el.classList.remove('active'));

    const turnoSelect = document.getElementById('man-manTurno');
    if (turnoSelect) {
        const hora = new Date().getHours();
        if (hora >= 6 && hora < 14) turnoSelect.value = '1º TURNO';
        else if (hora >= 14 && hora < 22) turnoSelect.value = '2º TURNO';
        else turnoSelect.value = '3º TURNO';
    }

    // Observador — preenche sozinho com quem está logado agora (mesma
    // fonte usada em outras telas do sistema, ver LW.nomeDeQuemEstaLogado).
    // Só um ponto de partida, continua editável — quem abriu o chamado
    // pode não ser a mesma pessoa que está relatando a anomalia (ex:
    // alguém abrindo em nome de outro operador).
    const observadorInput = document.getElementById('man-manObservador');
    if (observadorInput) {
        const meuNome = typeof LW !== 'undefined' && LW.nomeDeQuemEstaLogado ? LW.nomeDeQuemEstaLogado() : null;
        observadorInput.value = meuNome || '';
    }

    // Chamado novo (ainda sem ID salvo) — só a etapa "Abertura" faz
    // sentido; as outras (Execução/Peça/Fechamento) ficam desabilitadas
    // no assistente até o chamado existir de verdade (ver
    // _manAplicarStepAtual).
    _manStepAtual = 'abertura';
    _manAplicarStepAtual();

    if (card) card.scrollIntoView({ behavior: 'smooth' });
  }

  function fecharFormulario() { 
    const card = document.getElementById('man-formCard');
    if (card) card.style.display = 'none'; 
    fecharModal(); 
  }

  function formatarTempo(minutos) {
    if (minutos === null || minutos === undefined || isNaN(minutos)) return 'Não registrado';
    if (minutos === 0) return '0 minutos';
    const dias = Math.floor(minutos / (24 * 60));
    const horas = Math.floor((minutos % (24 * 60)) / 60);
    const minRest = minutos % 60;
    let str = '';
    if (dias > 0) str += dias + ' dia(s)';
    if (horas > 0) str += (str ? ' e ' : '') + horas + ' hora(s)';
    if (minRest > 0 && dias === 0 && horas === 0) str += minRest + ' minuto(s)';
    else if (minRest > 0 && (dias > 0 || horas > 0)) str += ' e ' + minRest + ' minuto(s)';
    return str || '0 minutos';
  }

  function calcularTempoGasto() {
    const dtI = document.getElementById('man-manDataInicio')?.value;
    const hrI = document.getElementById('man-manHoraInicio')?.value;
    const dtF = document.getElementById('man-manDataFim')?.value;
    const hrF = document.getElementById('man-manHoraFim')?.value;
    const display = document.getElementById('man-manTempoGasto');
    if (dtI && hrI && dtF && hrF && display) {
      let diffMin = Math.floor((new Date(`${dtF}T${hrF}`) - new Date(`${dtI}T${hrI}`)) / 1000 / 60);
      if (diffMin < 0) diffMin = 0;
      display.value = formatarTempo(diffMin);
    } else if (display) display.value = '';
  }

  function calcularTempoSupervisao() {
    const dtI = document.getElementById('man-supDataInicio')?.value;
    const hrI = document.getElementById('man-supHoraInicio')?.value;
    const dtF = document.getElementById('man-supDataFim')?.value;
    const hrF = document.getElementById('man-supHoraFim')?.value;
    const display = document.getElementById('man-supTempoGasto');
    if (dtI && hrI && dtF && hrF && display) {
      let diffMin = Math.floor((new Date(`${dtF}T${hrF}`) - new Date(`${dtI}T${hrI}`)) / 1000 / 60);
      if (diffMin < 0) diffMin = 0;
      display.value = formatarTempo(diffMin);
    } else if (display) display.value = '';
  }

  // Situação virou "Concluído"? Pré-preenche Fim (Data/Hora) se ainda
  // estiver vazio, igual sempre fez — só que agora, em vez de mostrar um
  // botão fixo, atualiza o conteúdo da etapa "Fechamento" do assistente
  // (ver _manRenderizarFechamento) pra refletir que já dá pra fechar.
  function aoMudarSituacao() {
    const situacao = document.getElementById('man-manSituacao')?.value;
    if (situacao === 'Concluido') {
      const dataFim = document.getElementById('man-manDataFim');
      const horaFim = document.getElementById('man-manHoraFim');
      if (dataFim && !dataFim.value) {
        const agora = new Date();
        dataFim.value = agora.toISOString().split('T')[0];
        if (horaFim) horaFim.value = agora.toLocaleTimeString('pt-BR', { hour12: false });
        calcularTempoGasto();
      }
    }
    // Reflete a mudança de situação no chamado em memória (usado por
    // _manRenderizarFechamento pra decidir o que mostrar) mesmo antes de
    // salvar — só localmente, o servidor só vê isso depois do "Salvar".
    if (_chamadoEmEdicao) _chamadoEmEdicao.situacao = situacao;
    _manAplicarStepAtual();
  }

  async function salvarManutencao() {
    try {
      if (document.getElementById('man-manEtiquetaFechada')?.value === 'true') {
        toast('Etiqueta fechada. Não pode ser alterada.', 'error');
        return;
      }

      const setor = document.getElementById('man-manSetor')?.value?.trim() || '';
      const maquina = document.getElementById('man-manMaquina')?.value?.trim() || '';
      const turno = document.getElementById('man-manTurno')?.value || '';
      const observador = document.getElementById('man-manObservador')?.value?.trim() || '';
      const prioridade = document.getElementById('man-manPrioridade')?.value || '';
      const tipoManutencao = document.getElementById('man-manTipoManutencao')?.value || '';
      const anomalia = document.getElementById('man-manAnomalia')?.value?.trim() || '';
      const responsavel = document.getElementById('man-manResponsavel')?.value?.trim() || '';
      const tipoEtiqueta = document.getElementById('man-manTipoEtiqueta')?.value || 'Azul';

      if (!setor || !maquina || !observador || !anomalia || !prioridade || !tipoManutencao) {
        toast('Preencha todos os campos obrigatórios.', 'error');
        return;
      }

      calcularTempoGasto(); calcularTempoSupervisao();

      const dtI = document.getElementById('man-manDataInicio')?.value || '';
      const hrI = document.getElementById('man-manHoraInicio')?.value || '';
      const dtF = document.getElementById('man-manDataFim')?.value || '';
      const hrF = document.getElementById('man-manHoraFim')?.value || '';
      let tempoGastoNumerico = 0;
      if (dtI && hrI && dtF && hrF) {
        let diffMs = new Date(`${dtF}T${hrF}`) - new Date(`${dtI}T${hrI}`);
        if (diffMs < 0) diffMs = 0;
        tempoGastoNumerico = Math.floor(diffMs / 1000 / 60);
      }

      const supDtI = document.getElementById('man-supDataInicio')?.value || '';
      const supHrI = document.getElementById('man-supHoraInicio')?.value || '';
      const supDtF = document.getElementById('man-supDataFim')?.value || '';
      const supHrF = document.getElementById('man-supHoraFim')?.value || '';
      let tempoSupervisaoNumerico = 0;
      if (supDtI && supHrI && supDtF && supHrF) {
        let diffMs = new Date(`${supDtF}T${supHrF}`) - new Date(`${supDtI}T${supHrI}`);
        if (diffMs < 0) diffMs = 0;
        tempoSupervisaoNumerico = Math.floor(diffMs / 1000 / 60);
      }

      const fotoOperadorPreview = document.getElementById('man-fotoOperadorPreview');
      let fotoOperador = '';
      if (fotoOperadorPreview.style.display !== 'none') {
        const img = fotoOperadorPreview.querySelector('img');
        if (img) fotoOperador = img.src;
        else if (fotoOperadorPreview.dataset.base64) fotoOperador = fotoOperadorPreview.dataset.base64;
        else if (fotoOperadorPreview.dataset.filename) fotoOperador = 'PDF: ' + fotoOperadorPreview.dataset.filename;
      }

      const fotoTecnicoPreview = document.getElementById('man-fotoTecnicoPreview');
      let fotoTecnico = '';
      if (fotoTecnicoPreview.style.display !== 'none') {
        const img = fotoTecnicoPreview.querySelector('img');
        if (img) fotoTecnico = img.src;
        else if (fotoTecnicoPreview.dataset.base64) fotoTecnico = fotoTecnicoPreview.dataset.base64;
        else if (fotoTecnicoPreview.dataset.filename) fotoTecnico = 'PDF: ' + fotoTecnicoPreview.dataset.filename;
      }

      const obj = {
        id: document.getElementById('man-manId')?.value || gerarId(),
        data: document.getElementById('man-manData')?.value || '',
        setor: setor, maquina: maquina, turno: turno,
        observador: observador, prioridade: prioridade, anomalia: anomalia,
        local: document.getElementById('man-manLocal')?.value?.trim() || '',
        tipos: JSON.parse(document.getElementById('man-manTipos')?.value || '[]'),
        tipoManutencao: tipoManutencao, tipoEtiqueta: tipoEtiqueta,
        tipoExecucao: document.getElementById('man-manTipoExecucao')?.value || 'Interno',
        empresaExterna: document.getElementById('man-manEmpresaExterna')?.value?.trim() || '',
        responsavel: responsavel, fotoOperador: fotoOperador, fotoTecnico: fotoTecnico,
        dataInicio: dtI, horaInicio: hrI, dataFim: dtF, horaFim: hrF,
        tempoGasto: tempoGastoNumerico, situacao: document.getElementById('man-manSituacao')?.value || 'Aguardando',
        emManutencao: document.getElementById('man-manEmManutencao')?.value || 'Nao',
        aguardandoPecas: document.getElementById('man-manAguardandoPecas')?.value || 'Nao',
        pecasAvariadas: document.getElementById('man-manPecasAvariadas')?.value?.trim() || '',
        pecasComprar: document.getElementById('man-manPecasComprar')?.value?.trim() || '',
        rotina: document.getElementById('man-manRotina')?.value?.trim() || '',
        supDataInicio: supDtI, supHoraInicio: supHrI, supDataFim: supDtF, supHoraFim: supHrF,
        supTempoGasto: tempoSupervisaoNumerico,
        statusCompra: document.getElementById('man-manStatusCompra')?.value || '',
        previsaoChegada: document.getElementById('man-manPrevisaoChegada')?.value || '',
        fornecedor: document.getElementById('man-manFornecedor')?.value?.trim() || '',
        respSupervisor: document.getElementById('man-manRespSupervisor')?.value?.trim() || '',
        obsSupervisor: document.getElementById('man-manObsSupervisor')?.value?.trim() || '',
        custoPecas: parseFloat(document.getElementById('man-manCustoPecas')?.value) || 0,
        custoMaoObra: parseFloat(document.getElementById('man-manCustoMaoObra')?.value) || 0,
        etiquetaFechada: false,
        autorNome: LW.nomeDeQuemEstaLogado(),
      };

      const btnSalvar = document.getElementById('man-btnSalvarManutencao');
      if (btnSalvar) btnSalvar.disabled = true;

      try {
        const res = await fetch('/manutencao/corretiva', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(obj),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.erro || 'Erro ao salvar chamado.');

        await carregarManutencoesDoServidor();
        toast('Chamado salvo com sucesso!');
        fecharFormulario();
        pageCorretiva = 0;
        renderCorretiva();
        renderDashboard();
      } catch (erroServidor) {
        toast('Erro ao salvar: ' + erroServidor.message, 'error');
      } finally {
        if (btnSalvar) btnSalvar.disabled = false;
      }

    } catch (error) {
      console.error("Erro fatal na função salvarManutencao:", error);
      toast('Erro interno ao salvar. Verifique o console.', 'error');
    }
  }

  function abrirModalFechamento() {
    // Segunda camada de proteção (o botão que chama isso já deveria estar
    // escondido pra quem não tem a área 'manutencao' completa — ver
    // data-manut-area="manutencao" no HTML, e a checagem em
    // aoMudarSituacao()/editarManutencao() — mas confere de novo aqui,
    // igual ao resto do app faz: nunca confia só no que já foi escondido
    // na tela). A validação de verdade continua sendo a do servidor, em
    // POST /manutencao/corretiva.
    if (typeof _perfilPodeEditar === 'function' && !_perfilPodeEditar('manutencao')) {
      toast('Seu perfil não pode fechar chamados de manutenção.', 'error');
      return;
    }
    const id = document.getElementById('man-manId')?.value;
    if(!id) { toast('Salve o chamado antes de fechá-lo.', 'error'); return; }
    const chamado = manutencoes.find(m => m.id === id);
    if(!chamado) { toast('Erro ao carregar dados.', 'error'); return; }
    
    const dtI = document.getElementById('man-manDataInicio')?.value;
    const hrI = document.getElementById('man-manHoraInicio')?.value;
    const dtF = document.getElementById('man-manDataFim')?.value;
    const hrF = document.getElementById('man-manHoraFim')?.value;
    let tempoExibido = chamado.tempoGasto;
    if (dtI && hrI && dtF && hrF) {
        let diffMin = Math.floor((new Date(`${dtF}T${hrF}`) - new Date(`${dtI}T${hrI}`)) / 1000 / 60);
        if (diffMin < 0) diffMin = 0;
        tempoExibido = diffMin;
    }
    const tempoFormatado = formatarTempo(tempoExibido);

    const body = document.getElementById('man-modalResumoBody');
    if (body) {
      body.innerHTML = `
        <div class="man-modal-resumo-item"><span class="label">Anomalia:</span><span class="value">${esc(chamado.anomalia)}</span></div>
        <div class="man-modal-resumo-item"><span class="label">Quem abriu:</span><span class="value">${esc(chamado.observador)}</span></div>
        <div class="man-modal-resumo-item"><span class="label">Quem resolveu:</span><span class="value">${esc(chamado.responsavel || 'Não informado')}</span></div>
        <div class="man-modal-resumo-item"><span class="label">Tempo de manutenção:</span><span class="value">${tempoFormatado}</span></div>
        <div class="man-modal-resumo-item"><span class="label">Peças avariadas:</span><span class="value">${esc(chamado.pecasAvariadas || '-')}</span></div>
        <div class="man-modal-resumo-item"><span class="label">Peças a comprar:</span><span class="value">${esc(chamado.pecasComprar || '-')}</span></div>
        <div class="man-modal-resumo-item"><span class="label">Custo Peças:</span><span class="value">R$ ${chamado.custoPecas ? chamado.custoPecas.toFixed(2) : '0,00'}</span></div>
        <div class="man-modal-resumo-item"><span class="label">Custo Mão de Obra:</span><span class="value">R$ ${chamado.custoMaoObra ? chamado.custoMaoObra.toFixed(2) : '0,00'}</span></div>
      `;
      document.getElementById('man-modalFechamento').style.display = 'flex';
    }
  }

  function fecharModal() { document.getElementById('man-modalFechamento').style.display = 'none'; }

  async function confirmarFechamento() {
    const id = document.getElementById('man-manId')?.value;
    const chamado = manutencoes.find(m => m.id === id);
    if(!chamado) return;
    chamado.etiquetaFechada = true;
    chamado.situacao = 'Concluido';
    if(!chamado.dataFim) {
      const agora = new Date();
      chamado.dataFim = agora.toISOString().split('T')[0];
      chamado.horaFim = agora.toLocaleTimeString('pt-BR', { hour12: false });
    }
    try {
      const res = await fetch('/manutencao/corretiva', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(chamado),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.erro || 'Erro ao fechar chamado.');
      await carregarManutencoesDoServidor();
      fecharModal();
      fecharFormulario();
      pageCorretiva = 0;
      renderCorretiva();
      renderDashboard();
      toast('Chamado fechado! Etiqueta bloqueada.');
    } catch (e) {
      toast('Erro ao fechar chamado: ' + e.message, 'error');
    }
  }

  function limparFiltrosCorretiva() {
    document.getElementById('man-filtroID').value = '';
    document.getElementById('man-filtroMaquina').value = '';
    document.getElementById('man-filtroSetor').value = '';
    document.getElementById('man-filtroTipo').value = '';
    document.getElementById('man-filtroPrioridade').value = '';
    document.getElementById('man-filtroStatus').value = '';
    pageCorretiva = 0;
    renderCorretiva();
  }

  function aplicarFiltrosCorretiva() { pageCorretiva = 0; renderCorretiva(); }

  // ── Trajetória visual do chamado (linha + pontos + chave de manutenção
  // "percorrendo" o progresso) — ver conversa que motivou isso. Cada
  // passo guarda se já foi "feito" (alcançado) — o passo ATUAL é o 1º
  // ainda não alcançado, seguindo a ordem; os textos só aparecem no
  // hover (title), nunca escritos nos pontos.
  function _construirPassosTrajetoria(m) {
    const fmtData = (iso) => iso ? _formatarDataHoraCurta(iso) : '';
    const passos = [];
    passos.push({
      label: 'Chamado aberto',
      feito: true,
      tooltip: `Chamado aberto por ${m.observador || '—'}` + (m.dataCriacao ? ` em ${fmtData(m.dataCriacao)}` : ''),
    });
    passos.push({
      label: 'Aguardando resposta da manutenção',
      feito: true,
      tooltip: 'Aguardando resposta da manutenção',
    });
    passos.push({
      label: 'Chamado visualizado',
      feito: !!m.visualizadoPor,
      tooltip: m.visualizadoPor ? `Visualizado por ${m.visualizadoPor} em ${fmtData(m.visualizadoEm)}` : 'Ainda não visualizado',
    });

    // Recusa aceita = fluxo encerrado ANTES do aceite — troca o resto da
    // trajetória (aceite/execução/etc.) por um único ponto vermelho
    // terminal, já que nada disso chegou a acontecer.
    if (m.recusaResultado === 'Aceita') {
      passos.push({
        label: 'Chamado recusado',
        feito: true,
        recusado: true,
        tooltip: `Recusa aceita por ${m.recusaRevisadoPor || '—'} em ${fmtData(m.recusaRevisadoEm)} — motivo: ${m.recusaMotivo || '—'}`,
      });
      return passos;
    }

    passos.push({
      label: 'Chamado aceito',
      feito: m.aceito === 'Sim',
      tooltip: m.aceito === 'Sim' ? `Aceito por ${m.aceitoPor || '—'} em ${fmtData(m.aceitoEm)}` : 'Ainda não aceito',
    });

    if (m.aguardandoPecas === 'Sim') {
      passos.push({
        label: 'Aguardando confirmação de pedido',
        feito: true, // só entra aqui se já foi marcado "Aguardando peças? = Sim"
        tooltip: 'Pedido de peça registrado pela Manutenção',
      });
      passos.push({
        label: 'Aguardando peça',
        feito: m.pedidoPecaAceito === 'Sim',
        tooltip: m.pedidoPecaAceito === 'Sim'
          ? `Pedido aceito por ${m.pedidoPecaAceitoPor || '—'} em ${fmtData(m.pedidoPecaAceitoEm)}`
          : 'Aguardando Supervisão/Encarregado/Admin aceitarem o pedido de peça',
      });
      passos.push({
        label: 'Peça chegou',
        feito: m.statusCompra === 'Peça recebida',
        tooltip: m.statusCompra ? `Status da compra: ${m.statusCompra}` : 'Peça ainda não chegou',
      });
    }

    passos.push({
      label: 'Manutenção em andamento',
      feito: m.situacao === 'Em Manutencao' || m.situacao === 'Concluido',
      tooltip: m.dataInicio ? `Execução iniciada em ${esc(m.dataInicio)}` : 'Execução ainda não iniciada',
    });
    passos.push({
      label: 'Finalizado',
      feito: m.situacao === 'Concluido' && !!m.etiquetaFechada,
      tooltip: (m.situacao === 'Concluido' && m.etiquetaFechada) ? `Chamado encerrado em ${esc(m.dataFim || '')}` : 'Chamado ainda em aberto',
    });
    return passos;
  }

  function _renderizarTrajetoria(passos) {
    let atualIndex = 0;
    while (atualIndex < passos.length && passos[atualIndex].feito) atualIndex++;
    if (atualIndex >= passos.length) atualIndex = passos.length - 1;
    // Trajetória CONCLUÍDA = o último passo (Finalizado) já foi
    // alcançado — vira verde em vez de amarelo (ver conversa que
    // motivou isso: "quero que esse stepper seja amarelo e quando
    // concluído seja verde"). Um chamado RECUSADO e encerrado NÃO
    // conta como concluído (mesmo "chegando ao fim") — continua
    // amarelo/vermelho, nunca verde, porque recusa não é uma conclusão
    // boa (bug real encontrado nos testes: sem o "&& !ultimo.recusado",
    // até os passos anteriores ao ponto de recusa ficavam verdes).
    const ultimo = passos[passos.length - 1];
    const concluido = !!ultimo && !!ultimo.feito && !ultimo.recusado;
    const itens = passos.map((p, i) => {
      let classe;
      if (p.recusado) classe = 'recusado';
      else if (i < atualIndex) classe = 'feito';
      else if (i === atualIndex) classe = 'atual';
      else classe = 'pendente';
      // Ícone por estado — pontos vazios (principalmente os "pendente",
      // ainda não alcançados) deixavam a trajetória toda apagada/sem
      // vida (ver conversa que motivou este ajuste visual); um check nos
      // já feitos e um X no recusado dão mais leitura à primeira vista,
      // sem precisar de texto nenhum nos pontos (isso continua só no
      // hover, como pedido).
      let icone = '';
      if (classe === 'atual') icone = '<i class="fas fa-wrench"></i>';
      else if (classe === 'recusado') icone = '<i class="fas fa-times"></i>';
      else if (classe === 'feito') icone = '<i class="fas fa-check"></i>';
      return `<li class="man-trajetoria-passo ${classe}" title="${esc(p.label)} — ${esc(p.tooltip || '')}">
        <div class="man-trajetoria-ponto">${icone}</div>
      </li>`;
    }).join('');
    return `<ul class="man-trajetoria-passos${concluido ? ' concluido' : ''}">${itens}</ul>`;
  }

  // ── Preview flutuante da trajetória, Ctrl + hover na linha da tabela
  // (ver conversa que motivou isso) — só desktop; no celular não existe
  // "segurar Ctrl" nem hover de verdade, então isso nunca ativa sozinho
  // (evt.ctrlKey nunca vem true em toque), o clique direto continua
  // abrindo a trajetória completa (ver abrirHistorico(), onclick da
  // linha). Não marca visualização — é só um espiada rápida, sem abrir
  // o modal; a marcação de "visualizado" continua só no clique de
  // verdade.
  function _mostrarPreviewTrajetoria(evt, id) {
    if (!evt.ctrlKey) { _esconderPreviewTrajetoria(); return; }
    let el = document.getElementById('man-trajetoriaPreview');
    if (!el) {
      el = document.createElement('div');
      el.id = 'man-trajetoriaPreview';
      el.className = 'man-trajetoria-preview-flutuante';
      document.body.appendChild(el);
    }
    if (el.dataset.chamadoId !== id) {
      const m = manutencoes.find(x => x.id === id);
      if (!m) return;
      el.innerHTML = _renderizarTrajetoria(_construirPassosTrajetoria(m));
      el.dataset.chamadoId = id;
    }
    el.style.display = 'block';
    _posicionarPreviewTrajetoria(evt, el);
  }

  function _posicionarPreviewTrajetoria(evt, el) {
    el = el || document.getElementById('man-trajetoriaPreview');
    if (!el || el.style.display === 'none') return;
    const offset = 18;
    const largura = el.offsetWidth || 240;
    const altura = el.offsetHeight || 60;
    let x = evt.clientX + offset;
    let y = evt.clientY + offset;
    if (x + largura > window.innerWidth) x = evt.clientX - largura - offset;
    if (y + altura > window.innerHeight) y = evt.clientY - altura - offset;
    el.style.left = Math.max(4, x) + 'px';
    el.style.top = Math.max(4, y) + 'px';
  }

  function _esconderPreviewTrajetoria() {
    const el = document.getElementById('man-trajetoriaPreview');
    if (el) { el.style.display = 'none'; el.dataset.chamadoId = ''; }
  }
  // Solta o Ctrl sem tirar o mouse de cima da linha (sem novo
  // mousemove) — esconde na hora mesmo assim, em vez de esperar o
  // próximo movimento do mouse.
  document.addEventListener('keyup', (evt) => { if (evt.key === 'Control') _esconderPreviewTrajetoria(); });

  async function abrirHistorico(id) {
    // Marca a 1ª visualização no servidor (idempotente — ver
    // db.marcarVisualizadoManutencaoCorretiva) ANTES de renderizar, pra
    // esse próprio clique já aparecer refletido no progresso (pedido do
    // usuário: "assim que clicarem pra ver o pedido já mostre no
    // progresso"). Falha de rede aqui não deveria impedir a visualização
    // do modal em si — só o ponto "visualizado" pode não atualizar.
    try {
      const res = await fetch('/manutencao/visualizar-corretiva', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (json.ok && json.chamado) {
        const idx = manutencoes.findIndex(x => x.id === id);
        if (idx > -1) manutencoes[idx] = json.chamado;
      }
    } catch (_) { /* segue mesmo sem conseguir marcar visualização */ }

    const chamado = manutencoes.find(m => m.id === id);
    if(!chamado) { toast('Chamado não encontrado.', 'error'); return; }

    const progressoEl = document.getElementById('man-progressoChamado');
    if (progressoEl) progressoEl.innerHTML = _renderizarTrajetoria(_construirPassosTrajetoria(chamado));

    function exibirImagem(src, titulo) {
      if (!src || src === '' || src === 'null' || src === 'undefined') {
        return `<div style="margin-top:4px; font-size:12px; color:var(--text-2); opacity:0.6;">Nenhum anexo.</div>`;
      }
      
      // Verifica se é um PDF comprimido (legado) ou normal
      if (src.startsWith('pdfgz:')) {
        const decompressedBase64 = decompressPDF(src);
        return `<div style="margin-top:4px; display:flex; align-items:center; gap:8px; font-size:12px; color:var(--text-2);">
          <i class="fas fa-file-pdf" style="color:var(--red); font-size:20px;"></i>
          <span>PDF anexado</span>
          <a href="${decompressedBase64}" target="_blank" style="color:var(--blue); text-decoration:underline; margin-left:8px;">Abrir PDF</a>
        </div>`;
      }
      // Verifica se é um PDF Base64 padrão
      if (src.startsWith('data:application/pdf;base64,')) {
        return `<div style="margin-top:4px; display:flex; align-items:center; gap:8px; font-size:12px; color:var(--text-2);">
          <i class="fas fa-file-pdf" style="color:var(--red); font-size:20px;"></i>
          <span>PDF anexado</span>
          <a href="${src}" target="_blank" style="color:var(--blue); text-decoration:underline; margin-left:8px;">Abrir PDF</a>
        </div>`;
      }
      if (src.startsWith('PDF:')) {
        return `<div style="margin-top:4px; display:flex; align-items:center; gap:8px; font-size:12px; color:var(--text-2);"><i class="fas fa-file-pdf" style="color:var(--red); font-size:20px;"></i> ${esc(src.replace('PDF: ', ''))}</div>`;
      }
      return `
        <div style="margin-top:8px; display:flex; flex-direction:column; gap:4px;">
          <span style="font-size:12px; color:var(--text-2);">${titulo}:</span>
          <img src="${src}" style="max-width:100%; max-height:150px; object-fit:cover; border-radius:6px; border:1px solid var(--border); cursor:pointer;" onclick="window.open(this.src, '_blank')">
        </div>
      `;
    }

    let html = `
      <div style="display:flex; flex-direction:column; gap:16px; padding:8px 0;">
        <div style="border-bottom:1px solid var(--border); padding-bottom:12px;">
          <h3 style="color:var(--accent); margin-bottom:4px;"><i class="fas fa-clipboard-list"></i> Chamado #${esc(chamado.id)}</h3>
          <div style="display:flex; justify-content:space-between; font-size:13px; color:var(--text-2);">
            <span><i class="fas fa-industry"></i> ${esc(chamado.maquina)}</span>
            <span><i class="fas fa-building"></i> ${esc(chamado.setor)}</span>
          </div>
        </div>

        <div style="background:var(--red-dim); border-left:4px solid var(--red); padding:12px; border-radius:6px;">
          <div style="display:flex; justify-content:space-between; color:var(--text-2); font-size:12px; margin-bottom:4px;">
            <span><i class="fas fa-user" style="color:var(--red);"></i> Abertura (Operador)</span>
            <span>${esc(chamado.data)}</span>
          </div>
          <div style="color:var(--text);"><strong>${esc(chamado.observador)}</strong> - ${esc(chamado.anomalia)}</div>
          <div style="font-size:12px; color:var(--text-2); margin-top:2px;">Prioridade: <span style="color:${chamado.prioridade === 'ALTA' ? 'var(--red)' : chamado.prioridade === 'MÉDIA' ? 'var(--accent)' : 'var(--green)'}; font-weight:600;">${esc(chamado.prioridade)}</span> | Etiqueta: ${esc(chamado.tipoEtiqueta)} | Turno: <strong>${esc(chamado.turno)}</strong></div>
          ${exibirImagem(chamado.fotoOperador, 'Anexo do problema')}
        </div>

        <div style="background:var(--accent-dim); border-left:4px solid var(--accent); padding:12px; border-radius:6px;">
          <div style="display:flex; justify-content:space-between; color:var(--text-2); font-size:12px; margin-bottom:4px;">
            <span><i class="fas fa-hard-hat" style="color:var(--accent);"></i> Execução (Manutenção)</span>
            <span>${chamado.dataInicio ? esc(chamado.dataInicio) : 'Não iniciado'}</span>
          </div>
          <div style="color:var(--text);"><strong>Responsável:</strong> ${esc(chamado.responsavel || 'Não atribuído')}</div>
          <div style="font-size:12px; color:var(--text-2); margin-top:2px;">
            <span><i class="fas fa-hourglass-half"></i> ${formatarTempo(chamado.tempoGasto)}</span>
            <span style="margin-left:12px;">Status: <span class="man-badge ${chamado.situacao === 'Concluido' ? 'man-badge-green' : chamado.situacao === 'Em Manutencao' ? 'man-badge-blue' : 'man-badge-gray'}">${esc(chamado.situacao)}</span></span>
          </div>
          <div style="font-size:12px; color:var(--text-2); margin-top:4px;">
            <i class="fas fa-tools"></i> ${esc(chamado.rotina || 'Nenhuma rotina registrada')}
          </div>
          <div style="font-size:12px; color:var(--text-2); margin-top:4px;">
            <strong>Custo Mão de Obra:</strong> R$ ${chamado.custoMaoObra ? chamado.custoMaoObra.toFixed(2) : '0,00'}<br>
            <strong style="color:var(--accent);">Custo Total:</strong> <span style="color:var(--accent); font-weight:600;">R$ ${(chamado.custoPecas + chamado.custoMaoObra).toFixed(2)}</span>
          </div>
          ${exibirImagem(chamado.fotoTecnico, 'Anexo do serviço')}
        </div>

        <div style="background:var(--blue-dim); border-left:4px solid var(--blue); padding:12px; border-radius:6px;">
          <div style="display:flex; justify-content:space-between; color:var(--text-2); font-size:12px; margin-bottom:4px;">
            <span><i class="fas fa-user-shield" style="color:var(--blue);"></i> Supervisão</span>
            <span>${chamado.supDataInicio ? esc(chamado.supDataInicio) : 'Não atuado'}</span>
          </div>
          <div style="font-size:12px; color:var(--text-2);">
            <strong>Status da Compra:</strong> <span class="man-badge ${chamado.statusCompra === 'Peça recebida' ? 'man-badge-green' : chamado.statusCompra ? 'man-badge-yellow' : 'man-badge-gray'}">${esc(chamado.statusCompra || 'N/A')}</span>
          </div>
          <div style="font-size:12px; color:var(--text-2); margin-top:4px;">
            <strong>Custo Peças:</strong> R$ ${chamado.custoPecas ? chamado.custoPecas.toFixed(2) : '0,00'}<br>
            <i class="fas fa-truck"></i> ${esc(chamado.fornecedor || 'Sem fornecedor')}
          </div>
          ${chamado.obsSupervisor ? `<div style="font-size:12px; color:var(--text-2); margin-top:4px;"><i class="fas fa-sticky-note"></i> ${esc(chamado.obsSupervisor)}</div>` : ''}
        </div>

        <div style="background:var(--green-dim); border-left:4px solid var(--green); padding:12px; border-radius:6px;">
          <div style="display:flex; justify-content:space-between; color:var(--text-2); font-size:12px; margin-bottom:4px;">
            <span><i class="fas fa-check-circle" style="color:var(--green);"></i> Fechamento</span>
            <span>${chamado.etiquetaFechada ? esc(chamado.dataFim) : 'Em aberto'}</span>
          </div>
          <div style="color:var(--text); font-weight:600;">
            ${chamado.etiquetaFechada ? '<i class="fas fa-lock" style="color:var(--green);"></i> Etiqueta Fechada' : '<i class="fas fa-unlock" style="color:var(--red);"></i> Etiqueta Aberta'}
          </div>
        </div>
      </div>
    `;

    document.getElementById('man-historicoBody').innerHTML = html;
    document.getElementById('man-modalHistorico').style.display = 'flex';
  }

  function fecharModalHistorico() { document.getElementById('man-modalHistorico').style.display = 'none'; }

  // ============================================================
  // BOARD KANBAN — Chamados Corretivos (ver conversa que motivou a troca
  // do modelo de tabela única: falta de clareza de quem precisa agir).
  // ============================================================

  // Em qual coluna do board este chamado cai — SEMPRE derivado do estado
  // atual (nunca um campo salvo à parte), mesma filosofia de
  // _construirPassosTrajetoria(). Ordem de checagem importa: um chamado
  // pode "tecnicamente" estar aguardando peça E já concluído ao mesmo
  // tempo (dados antigos) — fechado/concluído sempre vence.
  function _corretivaColuna(m) {
    if (m.recusaResultado === 'Aceita' || m.etiquetaFechada) return 'concluido';
    if (m.situacao === 'Concluido') return 'fechamento';
    if ((m.aguardandoPecas || '') === 'Sim' && m.statusCompra !== 'Peça recebida') return 'peca';
    if (m.aceito === 'Sim') return 'execucao';
    return 'aceite';
  }

  const MAN_COLUNAS_CORRETIVA = [
    { id: 'aceite', titulo: 'Aguardando Aceite', icone: 'fa-hand-paper' },
    { id: 'execucao', titulo: 'Em Execução', icone: 'fa-hard-hat' },
    { id: 'peca', titulo: 'Aguardando Peça', icone: 'fa-boxes' },
    { id: 'fechamento', titulo: 'Aguardando Fechamento', icone: 'fa-lock-open' },
    { id: 'concluido', titulo: 'Concluído', icone: 'fa-check-circle' },
  ];

  // "De quem é a vez" neste chamado, pro perfil ATUALMENTE logado — vira
  // o rótulo de destaque no cartão (Ideia 1 da conversa: fila "sua vez",
  // encaixada dentro do board em vez de uma aba separada). Retorna null
  // quando não há nada pendente de decisão (ex: já em execução normal,
  // sem pedido de peça, sem estar pronto pra fechar ainda).
  function _acaoPendenteCard(m) {
    if (m.etiquetaFechada || m.recusaResultado === 'Aceita') return null;
    if (m.recusaPendente === 'Sim') {
      return _podeAceitarPedidoPecaAtual()
        ? { texto: 'Sua vez: revisar recusa', urgente: true }
        : { texto: 'Aguardando revisão da recusa', urgente: false };
    }
    if (m.aceito !== 'Sim') {
      return _podeAceitarChamadoAtual()
        ? { texto: 'Sua vez: aceitar chamado', urgente: true }
        : { texto: 'Aguardando aceite da Manutenção', urgente: false };
    }
    if ((m.aguardandoPecas || '') === 'Sim' && m.pedidoPecaAceito !== 'Sim' && m.statusCompra !== 'Peça recebida') {
      return _podeAceitarPedidoPecaAtual()
        ? { texto: 'Sua vez: aceitar pedido de peça', urgente: true }
        : { texto: 'Aguardando aceite da Supervisão', urgente: false };
    }
    if (m.situacao === 'Concluido' && !m.etiquetaFechada) {
      const podeFechar = typeof _perfilPodeEditar === 'function' ? _perfilPodeEditar('manutencao') : true;
      return podeFechar
        ? { texto: 'Sua vez: fechar etiqueta', urgente: true }
        : { texto: 'Aguardando fechamento', urgente: false };
    }
    return null;
  }

  function _corPrioridade(p) {
    return p === 'ALTA' ? 'var(--red)' : p === 'MÉDIA' ? 'var(--accent)' : 'var(--green)';
  }

  function _renderizarCartaoCorretiva(m) {
    const acao = _acaoPendenteCard(m);
    const anomaliaTexto = esc(m.anomalia || 'Sem descrição.');
    const podeAberturaRow = _podeEditarAberturaChamadoAtual(m);
    const iconeAbrir = podeAberturaRow ? 'fa-edit' : 'fa-folder-open';
    const tituloAbrir = podeAberturaRow ? 'Editar' : 'Abrir chamado';
    const _podeEditarManut = typeof _perfilPodeEditar === 'function' ? _perfilPodeEditar('manutencao') : true;
    const deleteIcon = (!m.etiquetaFechada && _podeEditarManut)
      ? `<i class="fas fa-trash-alt" title="Excluir" onclick="event.stopPropagation(); excluirManutencao('${m.id}')"></i>` : '';
    const miniTrajetoria = _renderizarTrajetoria(_construirPassosTrajetoria(m));
    return `<div class="man-kanban-card" onclick="editarManutencao('${m.id}')"
        onmouseenter="_mostrarPreviewTrajetoria(event,'${m.id}')" onmousemove="_mostrarPreviewTrajetoria(event,'${m.id}')" onmouseleave="_esconderPreviewTrajetoria()"
        title="Segure Ctrl + passe o mouse pra pré-visualizar a trajetória">
      <div class="man-kanban-card-head">
        <span><i class="fas fa-hashtag"></i> ${esc(m.id)}</span>
        <span class="dot" style="background:${_corPrioridade(m.prioridade || 'BAIXA')}" title="Prioridade ${esc(m.prioridade || '-')}"></span>
      </div>
      <div class="man-kanban-card-maquina">${esc(m.maquina || '-')}</div>
      <div class="man-kanban-card-setor">${esc(m.setor || '-')} · ${esc(m.turno || '-')}</div>
      <div class="man-kanban-card-anomalia">${anomaliaTexto}</div>
      ${acao ? `<div class="man-kanban-card-cta ${acao.urgente ? 'urgente' : 'aguardando'}">${esc(acao.texto)}</div>` : ''}
      <div class="man-kanban-card-footer">
        ${miniTrajetoria}
        <span class="man-kanban-card-acoes" onclick="event.stopPropagation();">
          <i class="fas fa-eye" title="Ver trajetória completa" onclick="abrirHistorico('${m.id}')"></i>
          <i class="fas ${iconeAbrir}" title="${tituloAbrir}" onclick="editarManutencao('${m.id}')"></i>
          ${deleteIcon}
        </span>
      </div>
    </div>`;
  }

  // Só uma fase do acordeão aberta por vez (mesma sensação de um <select>
  // nativo — ver conversa). Guardado fora da função de render pra
  // sobreviver a um re-render (ex: depois de salvar um chamado, a fase
  // que a pessoa tinha aberto continua aberta).
  let _manFaseAberta = null;

  function _manToggleFase(faseId) {
    _manFaseAberta = (_manFaseAberta === faseId) ? null : faseId;
    renderCorretiva();
  }

  // Badge de Status/Supervisão da tabela de consulta — mesma lógica visual
  // que a tabela original sempre teve (ver histórico do arquivo).
  function _badgesLinhaCorretiva(m) {
    const situacao = m.situacao || 'Aguardando';
    const sc = situacao === 'Concluido' ? 'man-badge-green'
      : situacao === 'Em Manutencao' ? 'man-badge-blue'
      : situacao === 'Recusado' ? 'man-badge-red'
      : 'man-badge-gray';
    let supClass = 'man-badge-green', supText = '✅ OK';
    if ((m.aguardandoPecas || '') === 'Sim') {
      if (m.pedidoPecaAceito !== 'Sim') { supText = 'Pedido de peça (aguardando aceite)'; supClass = 'man-badge-yellow'; }
      else if (m.statusCompra) {
        supText = m.statusCompra;
        if (m.statusCompra === 'Em Análise') supClass = 'man-badge-yellow';
        else if (m.statusCompra === 'Cotação em andamento') supClass = 'man-badge-orange';
        else if (m.statusCompra === 'Pedido efetuado') supClass = 'man-badge-blue';
        else if (m.statusCompra === 'Peça em transporte') supClass = 'man-badge-purple';
        else if (m.statusCompra === 'Peça recebida') supClass = 'man-badge-green';
      } else { supText = 'Sob Supervisão'; supClass = 'man-badge-orange'; }
    }
    return { situacao, sc, supClass, supText };
  }

  function renderCorretiva() {
    try {
      const filtroID = document.getElementById('man-filtroID')?.value?.toLowerCase()?.trim() || '';
      const filtroMaquina = document.getElementById('man-filtroMaquina')?.value?.toLowerCase()?.trim() || '';
      const filtroSetor = document.getElementById('man-filtroSetor')?.value?.toLowerCase()?.trim() || '';
      const filtroTipo = document.getElementById('man-filtroTipo')?.value || '';
      const filtroPrioridade = document.getElementById('man-filtroPrioridade')?.value || '';
      const filtroStatus = document.getElementById('man-filtroStatus')?.value || '';
      const filtroEtiqueta = document.getElementById('man-filtroEtiqueta')?.value || '';

      let dados = manutencoes;
      if (filtroID) dados = dados.filter(m => (m.id || '').toLowerCase().includes(filtroID));
      if (filtroMaquina) dados = dados.filter(m => (m.maquina || '').toLowerCase().includes(filtroMaquina));
      if (filtroSetor) dados = dados.filter(m => (m.setor || '').toLowerCase().includes(filtroSetor));
      if (filtroTipo) dados = dados.filter(m => (m.tipoManutencao || '') === filtroTipo);
      if (filtroPrioridade) dados = dados.filter(m => (m.prioridade || '') === filtroPrioridade);
      if (filtroStatus) dados = dados.filter(m => (m.situacao || '') === filtroStatus);
      if (filtroEtiqueta) dados = dados.filter(m => (m.tipoEtiqueta || '') === filtroEtiqueta);

      // ── ACORDEÃO (topo) ──────────────────────────────────────────
      const acc = document.getElementById('man-corretivaAccordion');
      if (acc) {
        const porFase = {};
        MAN_COLUNAS_CORRETIVA.forEach(c => { porFase[c.id] = []; });
        dados.forEach(m => { const f = _corretivaColuna(m); (porFase[f] || porFase.aceite).push(m); });

        acc.innerHTML = MAN_COLUNAS_CORRETIVA.map(fase => {
          const itens = porFase[fase.id] || [];
          const pendentes = itens.filter(m => !!_acaoPendenteCard(m)?.urgente).length;
          const aberta = _manFaseAberta === fase.id;
          const corpo = itens.length
            ? itens.map(_renderizarCartaoCorretiva).join('')
            : `<div class="man-accordion-fase-vazia">Nenhum chamado nesta fase.</div>`;
          return `<div class="man-accordion-fase ${aberta ? 'aberta' : ''}" data-fase="${fase.id}">
            <button type="button" class="man-accordion-fase-head" aria-expanded="${aberta}" onclick="_manToggleFase('${fase.id}')">
              <i class="fas ${fase.icone}"></i> ${fase.titulo}
              <span class="count ${pendentes > 0 ? 'tem-pendencia' : ''}">${pendentes > 0 ? pendentes + ' pendente' + (pendentes > 1 ? 's' : '') + ' · ' : ''}${itens.length} no total</span>
              <i class="fas fa-chevron-down chevron"></i>
            </button>
            <div class="man-accordion-fase-corpo">${aberta ? corpo : ''}</div>
          </div>`;
        }).join('');
      }

      // ── TABELA DE CONSULTA (rodapé) — só visualização, sem editar.
      // Clique na linha abre a trajetória (abrirHistorico), não o
      // formulário/assistente — quem quer agir usa o acordeão acima.
      const tbody = document.getElementById('man-corretivaTableBody');
      if (tbody) {
        tbody.innerHTML = dados.length ? dados.map(m => {
          const { situacao, sc, supClass, supText } = _badgesLinhaCorretiva(m);
          const prioridade = m.prioridade || 'BAIXA';
          const tipo = m.tipoManutencao || '-';
          const tpc = tipo === 'Elétrica' ? 'var(--accent)' : 'var(--blue)';
          const etiqueta = m.tipoEtiqueta || 'Azul';
          const etiquetaCor = etiqueta === 'Azul' ? 'var(--blue)' : 'var(--red)';
          const etiquetaEmoji = etiqueta === 'Azul' ? '🔵' : '🔴';
          const fechadoIcon = m.etiquetaFechada ? '<i class="fas fa-lock" title="Etiqueta fechada"></i>' : '';
          return `<tr style="cursor:pointer;" onclick="abrirHistorico('${m.id}')" title="Ver trajetória do chamado">
            <td data-label="Nº"><strong>${esc(m.id)}</strong> ${fechadoIcon}</td>
            <td data-label="Máquina">${esc(m.maquina || '-')}</td>
            <td data-label="Setor">${esc(m.setor || '-')}</td>
            <td data-label="Turno"><strong>${esc(m.turno || '-')}</strong></td>
            <td data-label="Observador">${esc(m.observador || '-')}</td>
            <td data-label="Tipo"><span style="color:${tpc};">${esc(tipo)}</span></td>
            <td data-label="Prioridade"><span style="color:${_corPrioridade(prioridade)};">${esc(prioridade)}</span></td>
            <td data-label="Etiqueta"><span style="color:${etiquetaCor}; font-weight:600;">${etiquetaEmoji} ${esc(etiqueta)}</span></td>
            <td data-label="Status"><span class="man-badge ${sc}">${esc(situacao)}</span></td>
            <td data-label="Supervisão"><span class="man-badge ${supClass}">${esc(supText)}</span></td>
          </tr>`;
        }).join('') : `<tr><td colspan="10" style="text-align:center; padding:20px; color:var(--text-2);">Nenhum chamado encontrado.</td></tr>`;
      }
    } catch (error) {
      console.error("Erro ao renderizar a área de corretiva:", error);
      const acc = document.getElementById('man-corretivaAccordion');
      if (acc) acc.innerHTML = `<div style="color:var(--red); padding:20px;">Erro ao carregar os chamados.</div>`;
    }
  }

  // ============================================================
  // ASSISTENTE POR ETAPAS — formulário do chamado (ver conversa que
  // motivou a troca: formulário único com tudo visível ao mesmo tempo).
  // Cada etapa reaproveita o MESMO HTML/campos/lógica de sempre — só
  // muda qual zona fica visível (_manAplicarStepAtual) e a navegação
  // entre elas (_manIrParaStep). "Aceite" não é uma etapa própria: mora
  // dentro de "Execução", que já trazia embutida a caixa de Aceitar/
  // Recusar (ver _atualizarGateExecucao) — dividir isso em mais uma
  // etapa só adicionaria um clique sem separar responsabilidades de
  // verdade (quem aceita é o mesmo público que depois executa).
  // ============================================================
  let _manStepAtual = 'abertura';

  const MAN_ZONAS_ETAPA = {
    abertura: 'man-zonaAbertura',
    execucao: 'man-techSection',
    peca: 'man-supervisorSection',
    fechamento: 'man-zonaFechamento',
  };

  function _manIrParaStep(step) {
    if (!MAN_ZONAS_ETAPA[step]) return;
    const pill = document.querySelector(`.man-wizard-step[data-step="${step}"]`);
    if (pill && pill.disabled) return; // etapa ainda não disponível — ignora clique
    _manStepAtual = step;
    _manAplicarStepAtual();
  }

  // Decide em qual etapa o assistente deve ABRIR — sempre a etapa onde a
  // próxima ação relevante está (mesmo raciocínio de _acaoPendenteCard(),
  // agora aplicado dentro do próprio formulário). Chamado novo (m null)
  // sempre abre em "Abertura".
  function _manDefinirStepInicial(m) {
    if (!m) { _manStepAtual = 'abertura'; return; }
    if (m.recusaResultado === 'Aceita') { _manStepAtual = 'execucao'; return; } // mostra o desfecho da recusa
    if (m.recusaPendente === 'Sim') { _manStepAtual = 'execucao'; return; }
    if (m.aceito !== 'Sim') { _manStepAtual = 'execucao'; return; }
    if (m.situacao === 'Concluido' && !m.etiquetaFechada) { _manStepAtual = 'fechamento'; return; }
    if ((m.aguardandoPecas || '') === 'Sim' && m.pedidoPecaAceito !== 'Sim') { _manStepAtual = 'peca'; return; }
    _manStepAtual = 'execucao';
  }

  // Mostra só a zona da etapa atual, esconde as outras; habilita/desabilita
  // as pílulas de navegação conforme faz sentido pro chamado atual; marca
  // com check (.feito) as etapas já concluídas, pra dar noção de
  // progresso sem precisar abrir cada uma. Chamada sempre que o estado
  // muda (novoChamado, editarManutencao, aceitar/recusar, etc.) — única
  // fonte de verdade de "o que está visível agora".
  // "Salvar Chamado" só faz sentido — e só aparece — na etapa que a
  // pessoa está vendo AGORA, e só se ela tem o quê editar ali (ver
  // conversa: "os botões ficam aparecendo o tempo todo" — antes, a
  // visibilidade era calculada 1x ao abrir o chamado, usando "tem algo
  // editável em QUALQUER seção", e nunca era recalculada ao trocar de
  // etapa — então o botão continuava visível mesmo em etapas onde não
  // havia nada pra salvar ali). "Fechamento" nunca mostra Salvar: quem
  // fecha usa o botão próprio dessa etapa (abrirModalFechamento).
  function _manPodeSalvarNaEtapaAtual() {
    const m = _chamadoEmEdicao;
    if (!m) return _manStepAtual === 'abertura'; // chamado novo: só "Abertura" existe
    switch (_manStepAtual) {
      case 'abertura': return _podeEditarAberturaChamadoAtual(m);
      case 'execucao': return m.aceito === 'Sim' && _podeAceitarChamadoAtual();
      case 'peca': return m.pedidoPecaAceito === 'Sim' && _podeAceitarPedidoPecaAtual();
      default: return false; // 'fechamento'
    }
  }

  function _manAplicarStepAtual() {
    const m = _chamadoEmEdicao;
    Object.entries(MAN_ZONAS_ETAPA).forEach(([step, elId]) => {
      const el = document.getElementById(elId);
      if (el) el.style.display = (step === _manStepAtual) ? 'block' : 'none';
    });
    if (_manStepAtual === 'fechamento') _manRenderizarFechamento(m);

    const btnSalvar = document.getElementById('man-btnSalvarManutencao');
    if (btnSalvar) btnSalvar.style.display = _manPodeSalvarNaEtapaAtual() ? 'inline-block' : 'none';

    const temAguardandoPecas = document.getElementById('man-manAguardandoPecas')?.value === 'Sim';
    const pillPeca = document.getElementById('man-wizardStepPeca');
    if (pillPeca) pillPeca.style.display = (m && temAguardandoPecas) ? '' : 'none';

    document.querySelectorAll('.man-wizard-step').forEach(btn => {
      const step = btn.dataset.step;
      const disponivel = !!m || step === 'abertura'; // chamado novo: só "Abertura" navegável
      btn.disabled = !disponivel || (step === 'peca' && !temAguardandoPecas);
      btn.classList.toggle('active', step === _manStepAtual);
      const feito = m && (
        (step === 'abertura') ||
        (step === 'execucao' && m.aceito === 'Sim') ||
        (step === 'peca' && m.pedidoPecaAceito === 'Sim') ||
        (step === 'fechamento' && !!m.etiquetaFechada)
      );
      btn.classList.toggle('feito', !!feito);
    });
  }

  // Conteúdo da 4ª etapa (Fechamento) — 3 estados possíveis: ainda não dá
  // pra fechar (situação diferente de Concluído), pronto pra fechar
  // (resumo + botão, reaproveita o MESMO modal de confirmação de sempre —
  // abrirModalFechamento/confirmarFechamento — só mudou de onde o botão é
  // acionado), ou já fechado (confirmação final, read-only).
  function _manRenderizarFechamento(m) {
    const alvo = document.getElementById('man-fechamentoConteudo');
    if (!alvo) return;
    if (!m) {
      alvo.innerHTML = `<div class="man-fechamento-aviso"><i class="fas fa-info-circle"></i> Salve o chamado antes de fechá-lo.</div>`;
      return;
    }
    if (m.etiquetaFechada) {
      alvo.innerHTML = `<div class="man-fechamento-ok"><i class="fas fa-lock"></i> Etiqueta fechada em ${esc(m.dataFim || '')}. Este chamado não pode mais ser editado.</div>`;
      return;
    }
    if (m.situacao !== 'Concluido') {
      alvo.innerHTML = `<div class="man-fechamento-aviso"><i class="fas fa-info-circle"></i> Marque a Situação como "Concluído" na etapa <a href="#" onclick="_manIrParaStep('execucao'); return false;" style="color:var(--accent);">Execução</a> antes de poder fechar este chamado.</div>`;
      return;
    }
    const _podeFecharChamado = typeof _perfilPodeEditar === 'function' ? _perfilPodeEditar('manutencao') : true;
    alvo.innerHTML = `
      <div class="man-fechamento-resumo">
        <p style="color:var(--text-2); font-size:13px; margin-bottom:12px;"><i class="fas fa-check-circle" style="color:var(--green);"></i> Situação Concluído — pronto pra fechar a etiqueta. Confira o resumo antes de confirmar.</p>
        ${_podeFecharChamado
          ? `<button type="button" class="man-btn man-btn-warning" onclick="abrirModalFechamento()"><i class="fas fa-lock"></i> Fechar Chamado</button>`
          : `<div class="man-fechamento-aviso"><i class="fas fa-lock"></i> Seu perfil não pode fechar chamados de manutenção.</div>`}
      </div>`;
  }


  function editarManutencao(id) {
    try {
      const m = manutencoes.find(x => x.id === id);
      if(!m) return;
      if (m.etiquetaFechada) { toast('Etiqueta fechada.', 'error'); return; }
      _chamadoEmEdicao = m;
      const podeAbertura = _podeEditarAberturaChamadoAtual(m);
      const card = document.getElementById('man-formCard');
      if (card) card.style.display = 'block';
      const title = document.getElementById('man-formTitle');
      if (title) title.innerHTML = podeAbertura
        ? '<i class="fas fa-edit"></i> Editar Chamado (Manutenção)'
        : '<i class="fas fa-file-alt"></i> Chamado — Relatório';
      const display = document.getElementById('man-formIdDisplay');
      if (display) display.textContent = '#' + m.id;
      document.getElementById('man-manId').value = m.id;
      document.getElementById('man-manEtiquetaFechada').value = m.etiquetaFechada ? 'true' : 'false';
      document.getElementById('man-manSetor').value = m.setor;
      document.getElementById('man-manMaquina').value = m.maquina;
      document.getElementById('man-manTurno').value = m.turno;
      document.getElementById('man-manData').value = m.data;
      document.getElementById('man-manObservador').value = m.observador;
      setPrioridade(m.prioridade);
      document.getElementById('man-manTipoManutencao').value = m.tipoManutencao || ''; 
      document.getElementById('man-manTipoEtiqueta').value = m.tipoEtiqueta || 'Azul';
      const execEl = document.getElementById('man-manTipoExecucao');
      if (execEl) execEl.value = m.tipoExecucao || 'Interno';
      toggleEmpresaExterna();
      document.getElementById('man-manEmpresaExterna').value = m.empresaExterna || '';
      // Responsável Técnico — preenche sozinho com quem ACEITOU o chamado
      // (m.aceitoPor, gravado no servidor no momento do aceite — ver
      // nomeDeQuemAceita(), lib/rotas/manutencao.js — não dá pra
      // falsificar mandando outro nome pelo corpo da requisição). Só
      // como PONTO DE PARTIDA: se a pessoa já tiver digitado um nome
      // diferente aqui (ex: quem aceitou não foi quem executou de
      // verdade) e salvo, m.responsavel deixa de estar vazio e o campo
      // passa a carregar ESSE valor — nunca sobrescreve o que já foi
      // digitado e salvo.
      document.getElementById('man-manResponsavel').value = m.responsavel || (m.aceito === 'Sim' ? (m.aceitoPor || '') : '');
      
      if (m.fotoOperador) {
          const preview = document.getElementById('man-fotoOperadorPreview');
          preview.style.display = 'block';
          if (m.fotoOperador.startsWith('pdfgz:') || m.fotoOperador.startsWith('data:application/pdf')) {
              preview.innerHTML = `<div style="display:flex; align-items:center; gap:8px; padding:4px 12px; border:1px solid var(--accent); border-radius:4px;"><i class="fas fa-file-pdf" style="color:var(--red); font-size:24px;"></i><span style="font-size:12px;">PDF anexado</span></div>`;
              preview.dataset.base64 = m.fotoOperador;
          } else if (m.fotoOperador.startsWith('PDF:')) {
              preview.innerHTML = `<div style="display:flex; align-items:center; gap:8px; padding:4px 12px; border:1px solid var(--accent); border-radius:4px;"><i class="fas fa-file-pdf" style="color:var(--red); font-size:24px;"></i><span style="font-size:12px;">${esc(m.fotoOperador.replace('PDF: ', ''))}</span></div>`;
              preview.dataset.filename = m.fotoOperador.replace('PDF: ', '');
          } else {
              preview.innerHTML = `<img src="${m.fotoOperador}" style="max-width:60px; max-height:60px; border-radius:4px; border:1px solid var(--border); object-fit:cover;">`;
          }
          document.getElementById('man-btnRemoverFotoOp').style.display = 'inline';
      }
      
      if (m.fotoTecnico) {
          const preview = document.getElementById('man-fotoTecnicoPreview');
          preview.style.display = 'block';
          if (m.fotoTecnico.startsWith('pdfgz:') || m.fotoTecnico.startsWith('data:application/pdf')) {
              preview.innerHTML = `<div style="display:flex; align-items:center; gap:8px; padding:4px 12px; border:1px solid var(--accent); border-radius:4px;"><i class="fas fa-file-pdf" style="color:var(--red); font-size:24px;"></i><span style="font-size:12px;">PDF anexado</span></div>`;
              preview.dataset.base64 = m.fotoTecnico;
          } else if (m.fotoTecnico.startsWith('PDF:')) {
              preview.innerHTML = `<div style="display:flex; align-items:center; gap:8px; padding:4px 12px; border:1px solid var(--accent); border-radius:4px;"><i class="fas fa-file-pdf" style="color:var(--red); font-size:24px;"></i><span style="font-size:12px;">${esc(m.fotoTecnico.replace('PDF: ', ''))}</span></div>`;
              preview.dataset.filename = m.fotoTecnico.replace('PDF: ', '');
          } else {
              preview.innerHTML = `<img src="${m.fotoTecnico}" style="max-width:60px; max-height:60px; border-radius:4px; border:1px solid var(--border); object-fit:cover;">`;
          }
          document.getElementById('man-btnRemoverFotoTec').style.display = 'inline';
      }

      document.getElementById('man-manAnomalia').value = m.anomalia;
      document.getElementById('man-manLocal').value = m.local;
      tiposSelecionados = m.tipos || [];
      document.getElementById('man-manTipos').value = JSON.stringify(tiposSelecionados);
      document.querySelectorAll('.man-tag-anomalia').forEach(el => el.classList.toggle('active', tiposSelecionados.includes(el.dataset.type)));
      _setSecaoAberturaDetalhesEditavel(podeAbertura);

      // Seção 3 (Execução) — _atualizarGateExecucao() decide, com base em
      // m.aceito, se mostra a caixa "Aceitar Chamado" ou os campos de
      // verdade; a VISIBILIDADE da seção em si (esta etapa está na tela
      // agora ou não) é decidida por _manAplicarStepAtual(), mais abaixo.
      document.getElementById('man-manDataInicio').value = m.dataInicio || '';
      document.getElementById('man-manHoraInicio').value = m.horaInicio || '';
      document.getElementById('man-manDataFim').value = m.dataFim || '';
      document.getElementById('man-manHoraFim').value = m.horaFim || '';
      calcularTempoGasto();
      document.getElementById('man-manSituacao').value = m.situacao || 'Aguardando';
      document.getElementById('man-manEmManutencao').value = m.emManutencao || 'Nao';
      document.getElementById('man-manAguardandoPecas').value = m.aguardandoPecas || 'Nao';
      document.getElementById('man-manPecasAvariadas').value = m.pecasAvariadas || '';
      document.getElementById('man-manPecasComprar').value = m.pecasComprar || '';
      document.getElementById('man-manRotina').value = m.rotina || '';
      document.getElementById('man-manCustoMaoObra').value = m.custoMaoObra || '';
      _atualizarGateExecucao();

      // Seção 4 (Acompanhamento/"Peça") — carrega os dados se houver
      // pedido de peça (ou custo já lançado, pra não perder dado
      // histórico); a VISIBILIDADE de fato é decidida por
      // _manAplicarStepAtual(), mais abaixo (a pílula "Peça" só aparece
      // habilitada quando isso se aplica).
      if (m.aguardandoPecas === 'Sim' || (m.custoPecas && m.custoPecas > 0)) {
          document.getElementById('man-supDataInicio').value = m.supDataInicio || '';
          document.getElementById('man-supHoraInicio').value = m.supHoraInicio || '';
          document.getElementById('man-supDataFim').value = m.supDataFim || '';
          document.getElementById('man-supHoraFim').value = m.supHoraFim || '';
          document.getElementById('man-supTempoGasto').value = formatarTempo(m.supTempoGasto);
          document.getElementById('man-manStatusCompra').value = m.statusCompra || '';
          document.getElementById('man-manPrevisaoChegada').value = m.previsaoChegada || '';
          document.getElementById('man-manFornecedor').value = m.fornecedor || '';
          document.getElementById('man-manCustoPecas').value = m.custoPecas || '';
          // Responsável pela Análise — mesma lógica do Responsável
          // Técnico, acima: preenche sozinho com quem ACEITOU o pedido
          // de peça (m.pedidoPecaAceitoPor, gravado no servidor), só
          // como ponto de partida — se alguém já digitou e salvou outro
          // nome aqui, m.respSupervisor deixa de estar vazio e passa a
          // valer esse.
          document.getElementById('man-manRespSupervisor').value = m.respSupervisor || (m.pedidoPecaAceito === 'Sim' ? (m.pedidoPecaAceitoPor || '') : '');
          document.getElementById('man-manObsSupervisor').value = m.obsSupervisor || '';
          _atualizarGateAcompanhamento();
      }

      // Info de quem/quando aceitou (chamado e, se aplicável, pedido de
      // peça) e de recusa (pendente ou já revisada) — só texto
      // informativo, ao lado do ID no cabeçalho.
      const aceiteInfo = document.getElementById('man-formAceiteInfo');
      if (aceiteInfo) {
        const partes = [];
        if (m.aceito === 'Sim') partes.push(`Aceito por ${esc(m.aceitoPor || '—')} em ${_formatarDataHoraCurta(m.aceitoEm)}`);
        if (m.pedidoPecaAceito === 'Sim') partes.push(`Pedido de peça aceito por ${esc(m.pedidoPecaAceitoPor || '—')} em ${_formatarDataHoraCurta(m.pedidoPecaAceitoEm)}`);
        if (m.recusaPendente === 'Sim') partes.push(`Recusa solicitada por ${esc(m.recusaSolicitadoPor || '—')}, aguardando revisão`);
        else if (m.recusaResultado === 'Aceita') partes.push(`Recusa ACEITA por ${esc(m.recusaRevisadoPor || '—')} em ${_formatarDataHoraCurta(m.recusaRevisadoEm)} — chamado encerrado`);
        else if (m.recusaResultado === 'Negada') partes.push(`Recusa negada por ${esc(m.recusaRevisadoPor || '—')} em ${_formatarDataHoraCurta(m.recusaRevisadoEm)}`);
        aceiteInfo.textContent = partes.join(' · ');
      }

      _manDefinirStepInicial(m);
      _manAplicarStepAtual();
      if (card) card.scrollIntoView({ behavior: 'smooth' });
    } catch (error) {
      toast('Erro ao carregar dados.', 'error');
      console.error("Erro em editarManutencao:", error);
    }
  }

  async function excluirManutencao(id) { 
    const m = manutencoes.find(x => x.id === id); 
    if (m && (m.etiquetaFechada || m.situacao !== 'Aguardando')) { 
      toast('Este chamado não pode mais ser excluído (já foi processado).', 'error'); 
      return; 
    } 
    if(!confirm('Excluir este chamado permanentemente?')) return; 
    try {
      const res = await fetch('/manutencao/excluir-corretiva', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.erro || 'Erro ao excluir chamado.');
      await carregarManutencoesDoServidor();
      pageCorretiva = 0; 
      renderCorretiva(); 
      renderDashboard(); 
      toast('Chamado excluído.'); 
    } catch (e) {
      toast('Erro ao excluir: ' + e.message, 'error');
    }
  }

  // ============================================================
  // 4. MANUTENÇÃO PROGRAMADA (RECORRÊNCIA E TURNO)
  // ============================================================

  function calcularProximoHorarioDisponivel(data, horaInicioConflito, setor, maquina) {
    const conflito = agendamentos.find(a => 
      a.data === data && 
      a.maquina.toLowerCase() === maquina.toLowerCase() &&
      a.setor.toLowerCase() === setor.toLowerCase() &&
      a.hora === horaInicioConflito &&
      (a.status === 'Pendente' || a.status === 'Aprovado' || a.status === 'Em Execucao')
    );

    if (!conflito) return horaInicioConflito;

    let horaFimConflito = '';
    if (conflito.horaFimEstimado) {
      horaFimConflito = conflito.horaFimEstimado;
    } else {
      const [h, m] = conflito.hora.split(':').map(Number);
      let totalMin = (h * 60) + m + 120;
      let hFim = Math.floor(totalMin / 60);
      let mFim = totalMin % 60;
      horaFimConflito = `${String(hFim).padStart(2, '0')}:${String(mFim).padStart(2, '0')}`;
    }

    const [hFim, mFim] = horaFimConflito.split(':').map(Number);
    let totalMinMargem = (hFim * 60) + mFim + 30;
    let hProx = Math.floor(totalMinMargem / 60);
    let mProx = totalMinMargem % 60;
    if (hProx >= 24) hProx = 0;

    return `${String(hProx).padStart(2, '0')}:${String(mProx).padStart(2, '0')}`;
  }

  function verificarConflito() {
    const data = document.getElementById('man-progData')?.value || '';
    const hora = document.getElementById('man-progHora')?.value || '';
    const setor = document.getElementById('man-progSetor')?.value?.trim() || '';
    const maquina = document.getElementById('man-progMaquina')?.value?.trim() || '';
    const msg = document.getElementById('man-progMensagem');
    
    if(!data || !hora) { if (msg) msg.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Selecione a data e a hora.'; return false; }
    if(!setor || !maquina) {
      if (msg) msg.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Preencha o setor e a máquina.';
      return false;
    }

    const conflito = agendamentos.some(a => 
      a.data === data && 
      a.maquina.toLowerCase() === maquina.toLowerCase() && 
      (a.status === 'Pendente' || a.status === 'Aprovado')
    );

    if(conflito && msg) {
      const horarioSugerido = calcularProximoHorarioDisponivel(data, hora, setor, maquina);
      msg.innerHTML = `<i class="fas fa-times-circle" style="color:var(--red);"></i> <span style="color:var(--red);">Sugestão ocupada!</span> Próximo horário disponível: <strong>${data} às ${horarioSugerido}</strong>.`;
      return false;
    } else if (msg) { 
      msg.innerHTML = '<i class="fas fa-check-circle" style="color:var(--green);"></i> <span style="color:var(--green);">Sugestão disponível!</span>'; 
      return true; 
    }
    return true;
  }

  function gerarOcorrenciasRecorrentes(dataBase, recorrencia, quantidade = 5) {
    const ocorrencias = [];
    let dataAtual = new Date(dataBase + 'T00:00:00');
    for (let i = 0; i < quantidade; i++) {
        ocorrencias.push(dataAtual.toISOString().split('T')[0]);
        if (recorrencia === 'Diário') dataAtual.setDate(dataAtual.getDate() + 1);
        else if (recorrencia === 'Semanal') dataAtual.setDate(dataAtual.getDate() + 7);
        else if (recorrencia === 'Mensal') dataAtual.setMonth(dataAtual.getMonth() + 1);
    }
    return ocorrencias;
  }

  async function verificarEAgendiar() {
    if(!verificarConflito()) return;
    const data = document.getElementById('man-progData')?.value || '';
    const hora = document.getElementById('man-progHora')?.value || '';
    const setor = document.getElementById('man-progSetor')?.value?.trim() || '';
    const maquina = document.getElementById('man-progMaquina')?.value?.trim() || '';
    const tipo = document.getElementById('man-progTipo')?.value || '';
    const solicitante = document.getElementById('man-progSolicitante')?.value?.trim() || '';
    const recorrencia = document.getElementById('man-progRecorrencia')?.value || 'Nenhuma';
    const turno = document.getElementById('man-progTurno')?.value || '';
    const obs = document.getElementById('man-progObs')?.value?.trim() || '';
    
    if(!setor || !maquina || !solicitante) { toast('Preencha Setor, Máquina e Solicitante.', 'error'); return; }

    let datasParaAgendar = [data];
    if (recorrencia !== 'Nenhuma') {
        datasParaAgendar = gerarOcorrenciasRecorrentes(data, recorrencia, 10);
        toast(`Agendamento recorrente (${recorrencia}) criado para as próximas ${datasParaAgendar.length} ocorrências!`);
    }

    const novosAgendamentos = datasParaAgendar.map(d => ({
        id: gerarId('PRG-'),
        data: d,
        hora: hora,
        turno: turno,
        setor: setor,
        maquina: maquina,
        tipo: tipo,
        solicitante: solicitante,
        observacoes: obs,
        status: 'Pendente',
        justificativa: '',
        autorNome: LW.nomeDeQuemEstaLogado(),
        dataCriacao: new Date().toISOString().split('T')[0]
    }));

    try {
      // Recorrência gera várias ocorrências (até 10) — manda cada uma
      // em paralelo (Promise.all), já que são registros independentes,
      // sem nenhuma relação de dependência entre si no servidor.
      const resultados = await Promise.all(novosAgendamentos.map(a =>
        fetch('/manutencao/programada', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(a),
        }).then(r => r.json())
      ));
      const falhas = resultados.filter(r => !r.ok);
      if (falhas.length) throw new Error(falhas[0].erro || 'Erro ao agendar.');

      await carregarAgendamentosDoServidor();
      document.getElementById('man-progSolicitante').value = ''; document.getElementById('man-progObs').value = ''; 
      const msg = document.getElementById('man-progMensagem');
      if (msg) msg.innerHTML = '';
      pageProgramada = 0;
      renderProgramada(); renderDashboard();
    } catch (e) {
      toast('Erro ao agendar: ' + e.message, 'error');
    }
  }

  function abrirDetalhesProgramada(id) {
    const a = agendamentos.find(x => x.id === id);
    if(!a) { toast('Agendamento não encontrado.', 'error'); return; }
    
    const statusClass = a.status === 'Aprovado' ? 'man-badge-green' : a.status === 'Reprovado' ? 'man-badge-red' : a.status === 'Nao Executado' ? 'man-badge-purple' : a.status === 'Em Execucao' ? 'man-badge-orange' : 'man-badge-yellow';
    
    let htmlPlanejamento = '';
    if (a.status === 'Aprovado' && a.dataInicioEstimado) {
        htmlPlanejamento = `
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:13px; color:var(--text-2); margin-top:4px;">
                <span><strong>Início Previsto:</strong> ${esc(a.dataInicioEstimado)} ${esc(a.horaInicioEstimado)}</span>
                <span><strong>Fim Previsto:</strong> ${esc(a.dataFimEstimado)} ${esc(a.horaFimEstimado)}</span>
                <span><strong>Responsável pela Aprovação:</strong> ${esc(a.justificativa ? a.justificativa.split('Aprovado por ')[1]?.split('.')[0] || 'Não informado' : 'Não informado')}</span>
                <span><strong>Duração Estimada:</strong> ${esc(document.getElementById('man-aprTempoEstimado')?.value || 'Não calculada')}</span>
            </div>
        `;
    }

    let htmlExecucao = '';
    if (a.execucao || a.status === 'Em Execucao' || a.status === 'Concluido' || a.status === 'Nao Executado') {
        const exec = a.execucao || {};
        const tempoGasto = exec.tempoGasto ? formatarTempo(exec.tempoGasto) : 'Não registrado';
        const motivoNao = exec.motivoNaoExecutado ? `<div style="font-size:13px; color:var(--text-2); margin-top:4px;"><strong>Motivo da não execução:</strong> ${esc(exec.motivoNaoExecutado)}</div>` : '';
        const observacoesExec = exec.observacoes ? `<div style="font-size:13px; color:var(--text-2); margin-top:4px;"><strong>Observações da execução:</strong> ${esc(exec.observacoes)}</div>` : '';

        htmlExecucao = `
            <div style="font-size:13px; color:var(--text-2); margin-top:4px;">
                <strong>Status da Execução:</strong> <span class="man-badge ${statusClass}">${esc(a.status)}</span>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:13px; color:var(--text-2); margin-top:4px;">
                <span><strong>Início Real:</strong> ${a.execucaoDataInicio ? esc(a.execucaoDataInicio) + ' ' + esc(a.execucaoHoraInicio) : 'Não iniciado'}</span>
                <span><strong>Fim Real:</strong> ${exec.dataFim ? esc(exec.dataFim) + ' ' + esc(exec.horaFim) : 'Não finalizado'}</span>
                <span><strong>Tempo Gasto:</strong> ${tempoGasto}</span>
                <span><strong>Responsável pela Execução:</strong> ${esc(exec.tecnicoResponsavel || 'Não atribuído')}</span>
                <span><strong>Tipo de Execução:</strong> ${esc(exec.tipoExecucao || 'N/A')}</span>
            </div>
            ${exec.tipoExecucao === 'Externo' ? `<div style="font-size:13px; color:var(--text-2); margin-top:4px;"><strong>Empresa Externa:</strong> ${esc(exec.empresaExterna)}</div>` : ''}
            ${motivoNao}
            ${observacoesExec}
        `;
    }

    const body = document.getElementById('man-detalhesProgramadaBody');
    if (body) {
        body.innerHTML = `
            <div style="margin-bottom:16px; border-bottom:1px solid var(--border); padding-bottom:12px;">
                <h3 style="color:var(--accent); margin-bottom:6px;"><i class="fas fa-calendar-alt"></i> Solicitação #${esc(a.id)}</h3>
                <div style="display:flex; justify-content:space-between; font-size:13px; color:var(--text-2);">
                    <span><strong>Solicitante:</strong> ${esc(a.solicitante)}</span>
                    <span><strong>Data Programada:</strong> ${esc(a.data)}</span>
                </div>
            </div>

            <div style="margin-bottom:16px; border-bottom:1px solid var(--border); padding-bottom:12px;">
                <h4 style="color:var(--red); margin-bottom:4px;"><i class="fas fa-file-alt"></i> 1. Dados da Solicitação</h4>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px; font-size:13px; color:var(--text-2);">
                    <span><strong>Setor:</strong> ${esc(a.setor)}</span>
                    <span><strong>Máquina:</strong> ${esc(a.maquina)}</span>
                    <span><strong>Turno:</strong> <strong>${esc(a.turno)}</strong></span>
                    <span><strong>Tipo:</strong> ${esc(a.tipo)}</span>
                    <span><strong>Sugestão de Horário:</strong> ${esc(a.hora || '-')}</span>
                </div>
                <div style="font-size:13px; color:var(--text-2); margin-top:4px;">
                    <strong>Observações do Solicitante:</strong> ${esc(a.observacoes || '-')}
                </div>
            </div>

            <div style="margin-bottom:16px; border-bottom:1px solid var(--border); padding-bottom:12px;">
                <h4 style="color:var(--blue); margin-bottom:4px;"><i class="fas fa-calendar-check"></i> 2. Status e Planejamento</h4>
                <div style="font-size:13px; color:var(--text-2); margin-top:4px;">
                    <strong>Status Atual:</strong> <span class="man-badge ${statusClass}">${esc(a.status)}</span>
                </div>
                ${htmlPlanejamento}
                ${a.justificativa && a.status !== 'Aprovado' ? `<div style="font-size:13px; color:var(--text-2); margin-top:4px;"><strong>Justificativa:</strong> ${esc(a.justificativa)}</div>` : ''}
            </div>

            ${(a.status === 'Em Execucao' || a.status === 'Concluido' || a.status === 'Nao Executado') ? `
                <div style="margin-bottom:16px; border-bottom:1px solid var(--border); padding-bottom:12px;">
                    <h4 style="color:var(--green); margin-bottom:4px;"><i class="fas fa-tools"></i> 3. Execução</h4>
                    ${htmlExecucao}
                </div>
            ` : ''}
        `;
    }
    document.getElementById('man-modalDetalhesProgramada').style.display = 'flex';
  }

  function fecharModalDetalhesProgramada() { document.getElementById('man-modalDetalhesProgramada').style.display = 'none'; }

  function toggleExecEmpresaExterna() {
    const el = document.getElementById('man-execTipoExecucao');
    if (el) {
      const tipo = el.value;
      const row = document.getElementById('man-execEmpresaExternaRow');
      if (row) row.style.display = tipo === 'Externo' ? 'block' : 'none';
    }
  }

  function abrirModalInicio(id) {
    const a = agendamentos.find(x => x.id === id); if(!a) return;
    document.getElementById('man-inicioId').value = a.id;
    const agora = new Date(); const hoje = agora.toISOString().split('T')[0]; const horaAtual = agora.toLocaleTimeString('pt-BR', { hour12: false });
    document.getElementById('man-inicioData').value = hoje;
    document.getElementById('man-inicioHora').value = horaAtual;
    document.getElementById('man-modalInicioProgramada').style.display = 'flex';
  }
  function fecharModalInicio() { document.getElementById('man-modalInicioProgramada').style.display = 'none'; }

  /**
   * Envia um agendamento (já modificado em memória, ver `a` nos
   * chamadores) pro servidor via upsert — mesmo objeto que já está em
   * `agendamentos`, só reenviado inteiro (POST /manutencao/programada
   * sempre substitui a linha inteira, não faz PATCH parcial). Usada por
   * confirmarInicio/confirmarFinalizar/confirmarAprovacao/
   * confirmarReprovacao — todas seguem o mesmo padrão: editam campos do
   * objeto local, chamam isto, e só continuam (fechar modal, toast de
   * sucesso, re-renderizar) se a resposta confirmar sucesso.
   * @returns {Promise<boolean>} true se salvou com sucesso.
   */
  async function _salvarAgendamentoNoServidor(a) {
    try {
      const res = await fetch('/manutencao/programada', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(a),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.erro || 'Erro ao salvar agendamento.');
      await carregarAgendamentosDoServidor();
      return true;
    } catch (e) {
      toast('Erro ao salvar: ' + e.message, 'error');
      return false;
    }
  }

  async function confirmarInicio() {
    const id = document.getElementById('man-inicioId')?.value; const a = agendamentos.find(x => x.id === id); if(!a) return;
    const dtI = document.getElementById('man-inicioData')?.value, hrI = document.getElementById('man-inicioHora')?.value;
    if(!dtI || !hrI) { toast('Defina o horário de início.', 'error'); return; }
    a.execucaoDataInicio = dtI;
    a.execucaoHoraInicio = hrI;
    a.status = 'Em Execucao';
    a.justificativa = `Iniciado em ${dtI} às ${hrI}`;
    if (!(await _salvarAgendamentoNoServidor(a))) return;
    toast('Tarefa marcada como Em Execução!'); fecharModalInicio(); pageProgramada = 0; renderProgramada(); renderDashboard();
  }

  function abrirModalFinalizar(id) {
    const a = agendamentos.find(x => x.id === id); if(!a) return;
    document.getElementById('man-execId').value = a.id;
    document.getElementById('man-execTecnico').value = '';
    document.getElementById('man-execMotivo').value = '';
    document.getElementById('man-execObs').value = '';
    document.getElementById('man-execExecutado').value = 'Sim';
    document.getElementById('man-execMotivoGroup').style.display = 'none';
    document.getElementById('man-execTempoGasto').value = '';
    document.getElementById('man-execTipoExecucao').value = 'Interno';
    document.getElementById('man-execEmpresaExternaRow').style.display = 'none';
    document.getElementById('man-execEmpresaExterna').value = '';
    document.getElementById('man-execDataInicio').value = a.execucaoDataInicio || '';
    document.getElementById('man-execHoraInicio').value = a.execucaoHoraInicio || '';
    const agora = new Date(); const hoje = agora.toISOString().split('T')[0]; const horaAtual = agora.toLocaleTimeString('pt-BR', { hour12: false });
    document.getElementById('man-execDataFim').value = hoje;
    document.getElementById('man-execHoraFim').value = horaAtual;
    const aviso = document.getElementById('man-execucaoAvisoAtraso');
    if (hoje > a.data) { aviso.style.display = 'block'; } else { aviso.style.display = 'none'; }
    calcularTempoExecucao();
    document.getElementById('man-modalFinalizarProgramada').style.display = 'flex';
  }
  function fecharModalFinalizar() { document.getElementById('man-modalFinalizarProgramada').style.display = 'none'; }
  function calcularTempoExecucao() {
    const dtI = document.getElementById('man-execDataInicio')?.value, hrI = document.getElementById('man-execHoraInicio')?.value;
    const dtF = document.getElementById('man-execDataFim')?.value, hrF = document.getElementById('man-execHoraFim')?.value;
    const display = document.getElementById('man-execTempoGasto');
    if (dtI && hrI && dtF && hrF && display) {
      let diffMin = Math.floor((new Date(`${dtF}T${hrF}`) - new Date(`${dtI}T${hrI}`)) / 1000 / 60);
      if (diffMin < 0) diffMin = 0;
      display.value = formatarTempo(diffMin);
    } else if (display) display.value = '';
  }
  function toggleExecucaoCampos() {
    const executado = document.getElementById('man-execExecutado')?.value; const group = document.getElementById('man-execMotivoGroup');
    if (executado === 'Nao' && group) { group.style.display = 'block'; } else if (group) { group.style.display = 'none'; }
  }
  async function salvarExecucao() {
    const id = document.getElementById('man-execId')?.value; const a = agendamentos.find(x => x.id === id); if(!a) return;
    const executado = document.getElementById('man-execExecutado')?.value, tecnico = document.getElementById('man-execTecnico')?.value?.trim() || '';
    const motivo = document.getElementById('man-execMotivo')?.value?.trim() || '', obs = document.getElementById('man-execObs')?.value?.trim() || '';
    const tipoExecucao = document.getElementById('man-execTipoExecucao')?.value || 'Interno';
    const empresaExterna = document.getElementById('man-execEmpresaExterna')?.value?.trim() || '';
    const dtI = document.getElementById('man-execDataInicio')?.value, hrI = document.getElementById('man-execHoraInicio')?.value;
    const dtF = document.getElementById('man-execDataFim')?.value, hrF = document.getElementById('man-execHoraFim')?.value;
    if(!tecnico) { toast('Informe o nome do Técnico.', 'error'); return; }
    if(executado === 'Nao' && !motivo) { toast('Informe o motivo da não execução.', 'error'); return; }
    if(!dtI || !hrI || !dtF || !hrF) { toast('Preencha o período de execução.', 'error'); return; }
    if(tipoExecucao === 'Externo' && !empresaExterna) { toast('Informe o nome da Empresa Externa.', 'error'); return; }
    calcularTempoExecucao(); const tempoGastoStr = document.getElementById('man-execTempoGasto')?.value || '0 minutos';
    const tempoGasto = parseInt(document.getElementById('man-execTempoGasto')?.value?.replace(' min', '')) || 0;
    a.execucao = { dataInicio: dtI, horaInicio: hrI, dataFim: dtF, horaFim: hrF, tempoGasto: tempoGasto, executado: executado, motivoNaoExecutado: motivo, tecnicoResponsavel: tecnico, observacoes: obs, tipoExecucao: tipoExecucao, empresaExterna: empresaExterna };
    if(executado === 'Sim') { a.status = 'Concluido'; a.justificativa = `Executado por ${tipoExecucao === 'Externo' ? 'Empresa: ' + empresaExterna : tecnico} em ${dtF} às ${hrF}. Tempo: ${tempoGastoStr}.`; } 
    else { a.status = 'Nao Executado'; a.justificativa = `Não executado. Motivo: ${motivo}. Registrado por ${tecnico}.`; }
    if (!(await _salvarAgendamentoNoServidor(a))) return;
    fecharModalFinalizar(); pageProgramada = 0; renderProgramada(); renderDashboard(); toast('Execução finalizada!');
  }

  function aprovarAgendamento(id) { abrirModalAprovacao(id); }
  
  // ============================================================
  // NOVO: LÓGICA DE REPROVAÇÃO VIA MODAL
  // ============================================================
  function abrirModalReprovacao(id) {
    document.getElementById('man-reprovacaoId').value = id;
    document.getElementById('man-reprovacaoJustificativa').value = '';
    document.getElementById('man-modalReprovacaoProgramada').style.display = 'flex';
  }

  function fecharModalReprovacao() {
    document.getElementById('man-modalReprovacaoProgramada').style.display = 'none';
  }

  async function confirmarReprovacao() {
    const id = document.getElementById('man-reprovacaoId').value;
    const justificativa = document.getElementById('man-reprovacaoJustificativa').value.trim();
    const a = agendamentos.find(x => x.id === id);
    if(!a) return;
    if(!justificativa) {
      toast('Por favor, informe o motivo da reprovação.', 'error');
      return;
    }
    a.status = 'Reprovado';
    a.justificativa = justificativa;
    if (!(await _salvarAgendamentoNoServidor(a))) return;
    fecharModalReprovacao();
    pageProgramada = 0;
    renderProgramada();
    renderDashboard();
    toast('Agendamento reprovado com justificativa registrada.');
  }

  async function excluirAgendamento(id) { 
    const a = agendamentos.find(x => x.id === id); 
    if (a && a.status !== 'Pendente') { 
      toast('Este agendamento não pode mais ser excluído (já foi processado).', 'error'); 
      return; 
    } 
    if(!confirm('Excluir este agendamento?')) return; 
    try {
      const res = await fetch('/manutencao/excluir-programada', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.erro || 'Erro ao excluir agendamento.');
      await carregarAgendamentosDoServidor();
      pageProgramada = 0; 
      renderProgramada(); 
      renderDashboard(); 
      toast('Agendamento excluído.'); 
    } catch (e) {
      toast('Erro ao excluir: ' + e.message, 'error');
    }
  }

  function abrirModalAprovacao(id) {
    const a = agendamentos.find(x => x.id === id); if(!a) return;
    document.getElementById('man-aprId').value = a.id;
    document.getElementById('man-aprSugestaoDisplay').textContent = a.hora || 'Não definida';
    const horaBase = a.hora || '08:00';
    document.getElementById('man-aprDataInicio').value = a.data;
    document.getElementById('man-aprHoraInicio').value = horaBase;
    document.getElementById('man-aprDataFim').value = a.data;
    let [h, m] = horaBase.split(':').map(Number); h += 1; let hFim = String(h).padStart(2,'0'); let mFim = String(m).padStart(2,'0');
    document.getElementById('man-aprHoraFim').value = `${hFim}:${mFim}`;
    document.getElementById('man-aprResponsavel').value = ''; 
    calcularTempoEstimado();
    document.getElementById('man-modalAprovacaoProgramada').style.display = 'flex';
  }
  function fecharModalAprovacao() { document.getElementById('man-modalAprovacaoProgramada').style.display = 'none'; }
  function calcularTempoEstimado() {
    const dtI = document.getElementById('man-aprDataInicio')?.value, hrI = document.getElementById('man-aprHoraInicio')?.value;
    const dtF = document.getElementById('man-aprDataFim')?.value, hrF = document.getElementById('man-aprHoraFim')?.value;
    const display = document.getElementById('man-aprTempoEstimado');
    if (dtI && hrI && dtF && hrF && display) {
      let diffMin = Math.floor((new Date(`${dtF}T${hrF}`) - new Date(`${dtI}T${hrI}`)) / 1000 / 60);
      if (diffMin < 0) diffMin = 0;
      display.value = formatarTempo(diffMin);
    } else if (display) display.value = '';
  }
  async function confirmarAprovacao() {
    const id = document.getElementById('man-aprId')?.value; const a = agendamentos.find(x => x.id === id); if(!a) return;
    const dtI = document.getElementById('man-aprDataInicio')?.value, hrI = document.getElementById('man-aprHoraInicio')?.value;
    const dtF = document.getElementById('man-aprDataFim')?.value, hrF = document.getElementById('man-aprHoraFim')?.value;
    const responsavel = document.getElementById('man-aprResponsavel')?.value?.trim() || '';
    if(!dtI || !hrI || !dtF || !hrF) { toast('Defina o período estimado.', 'error'); return; }
    if(!responsavel) { toast('Informe o Responsável pela Aprovação.', 'error'); return; }
    a.dataInicioEstimado = dtI; a.horaInicioEstimado = hrI; a.dataFimEstimado = dtF; a.horaFimEstimado = hrF;
    a.status = 'Aprovado'; a.justificativa = `Aprovado por ${responsavel}. Previsto: ${dtI} ${hrI} a ${dtF} ${hrF}`;
    if (!(await _salvarAgendamentoNoServidor(a))) return;
    toast('Aprovada!'); fecharModalAprovacao(); pageProgramada = 0; renderProgramada(); renderDashboard();
  }

  function renderProgramada() {
    document.getElementById('man-progTotal').textContent = agendamentos.length;
    document.getElementById('man-progPendentes').textContent = agendamentos.filter(a => a.status === 'Pendente').length;
    document.getElementById('man-progAprovados').textContent = agendamentos.filter(a => a.status === 'Aprovado').length;
    document.getElementById('man-progReprovados').textContent = agendamentos.filter(a => a.status === 'Reprovado').length;

    const total = agendamentos.length;
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE) || 1;
    if (pageProgramada >= totalPages) pageProgramada = totalPages - 1;
    if (pageProgramada < 0) pageProgramada = 0;
    const start = pageProgramada * ITEMS_PER_PAGE;
    const pageData = agendamentos.slice(start, start + ITEMS_PER_PAGE);

    const tbody = document.getElementById('man-programadaTableBody');
    if(pageData.length === 0) { tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:20px; color:var(--text-2);">Nenhuma manutenção programada.</td></tr>`; } 
    else {
      tbody.innerHTML = pageData.map(a => {
        const sc = a.status === 'Aprovado' ? 'man-badge-green' : a.status === 'Reprovado' ? 'man-badge-red' : a.status === 'Nao Executado' ? 'man-badge-purple' : a.status === 'Em Execucao' ? 'man-badge-orange' : 'man-badge-yellow';
        const _podeEditarManutProg = typeof _perfilPodeEditar === 'function' ? _perfilPodeEditar('manutencao') : true;
        let acoes = `<button class="man-btn man-btn-primary" style="padding:2px 8px; font-size:11px; margin-right:4px;" onclick="abrirDetalhesProgramada('${a.id}')"><i class="fas fa-eye"></i></button> `;
        if (!_podeEditarManutProg) {
          // Visualização — sem ações de aprovar/reprovar/iniciar/finalizar,
          // que exigem a área 'manutencao' completa (ver lib/perfis.js).
        } else if(a.status === 'Aprovado' || a.status === 'Pendente') {
          acoes += `<button class="man-btn man-btn-success" style="padding:2px 8px; font-size:11px; margin-right:4px;" onclick="aprovarAgendamento('${a.id}')"><i class="fas fa-check"></i></button><button class="man-btn man-btn-danger" style="padding:2px 8px; font-size:11px;" onclick="abrirModalReprovacao('${a.id}')"><i class="fas fa-times"></i></button>`;
        } else if(a.status === 'Em Execucao') {
          acoes += `<button class="man-btn man-btn-warning" style="padding:2px 8px; font-size:11px; margin-right:4px;" onclick="abrirModalFinalizar('${a.id}')"><i class="fas fa-flag-checkered"></i></button>`;
        } else {
          acoes += `<span style="font-size:12px; color:var(--text-2);">${esc(a.justificativa || '-')}</span>`;
        }
        if(_podeEditarManutProg && (a.status === 'Aprovado' || a.status === 'Pendente')) {
          acoes += `<button class="man-btn man-btn-primary" style="padding:2px 8px; font-size:11px; margin-right:4px; background:var(--blue);" onclick="abrirModalInicio('${a.id}')"><i class="fas fa-play"></i></button>`;
        }

        const deleteIcon = (_podeEditarManutProg && a.status === 'Pendente')
          ? `<span style="color:var(--red); cursor:pointer; margin-left:8px;" onclick="excluirAgendamento('${a.id}')"><i class="fas fa-trash-alt"></i></span>` 
          : '';

        let estimadoDisplay = '-';
        if(a.dataInicioEstimado) { estimadoDisplay = `${a.dataInicioEstimado} ${a.horaInicioEstimado} → ${a.dataFimEstimado} ${a.horaFimEstimado}`; }
        return `<tr>
          <td data-label="Nº"><strong>${esc(a.id)}</strong></td>
          <td data-label="Máquina">${esc(a.maquina || '-')} (${esc(a.setor || '-')})</td>
          <td data-label="Solicitante">${esc(a.solicitante || '-')}</td>
          <td data-label="Turno"><strong>${esc(a.turno || '-')}</strong></td>
          <td data-label="Data">${esc(a.data || '-')}</td>
          <td data-label="Sugestão">${esc(a.hora) || '-'}</td>
          <td data-label="Estimado" style="font-size:11px;">${estimadoDisplay}</td>
          <td data-label="Status"><span class="man-badge ${sc}">${esc(a.status)}</span></td>
          <td data-label="Ações" style="justify-content:flex-end;"><div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center;">${acoes}${deleteIcon}</div></td>
        </tr>`;
      }).join('');
    }

    const pagDiv = document.getElementById('man-pagProgramada');
    pagDiv.innerHTML = `
      <button onclick="changePageProgramada(-1)" ${pageProgramada === 0 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button>
      <span>${pageProgramada + 1} / ${totalPages}</span>
      <button onclick="changePageProgramada(1)" ${pageProgramada === totalPages - 1 ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>
    `;
  }

  function changePageProgramada(delta) {
    pageProgramada += delta;
    renderProgramada();
  }

  // ============================================================
  // 5. DASHBOARD (Visão Executiva)
  // ============================================================
  let chartInstance = null;

  // Canvas (Chart.js) não entende var(--xxx) — só aceita cor já resolvida
  // (hex/rgb literal). Lê o valor ATUAL da variável global do tema (mesma
  // que o resto da SPA usa — ver styles.css), pra o gráfico acompanhar o
  // tema escolhido (claro/escuro/lightwall) em vez de uma cor fixa
  // exclusiva desta página. Mesmo padrão já usado em setor-qualidade.js.
  function _corTema(nomeVar, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(nomeVar).trim();
    return v || fallback;
  }

  function renderDashboard() {
    const totalAbertos = manutencoes.filter(m => !m.etiquetaFechada).length;
    const totalFechados = manutencoes.filter(m => m.etiquetaFechada).length;
    document.getElementById('man-kpiTotalAbertos').textContent = totalAbertos;
    document.getElementById('man-kpiTotalFechados').textContent = totalFechados;
    
    const hoje = new Date().toISOString().split('T')[0];
    document.getElementById('man-kpiProgHoje').textContent = agendamentos.filter(a => a.data === hoje && a.status === 'Aprovado').length;
    document.getElementById('man-kpiProgPend').textContent = agendamentos.filter(a => a.status === 'Pendente').length;
    document.getElementById('man-kpiProgMes').textContent = agendamentos.filter(a => a.data.slice(0, 7) === hoje.slice(0, 7) && a.status === 'Aprovado').length;
    
    const custosMes = manutencoes.filter(m => m.data.slice(0, 7) === hoje.slice(0, 7));
    const totalPecas = custosMes.reduce((acc, m) => acc + (m.custoPecas || 0), 0);
    const totalMaoObra = custosMes.reduce((acc, m) => acc + (m.custoMaoObra || 0), 0);
    document.getElementById('man-kpiCustoPecas').textContent = `R$ ${totalPecas.toFixed(2)}`;
    document.getElementById('man-kpiCustoMaoObra').textContent = `R$ ${totalMaoObra.toFixed(2)}`;
    document.getElementById('man-kpiCustoTotal').textContent = `R$ ${(totalPecas + totalMaoObra).toFixed(2)}`;
    
    const ultimosAbertos = [...manutencoes].filter(m => !m.etiquetaFechada).slice(0, 3);
    document.getElementById('man-dashboardAbertos').innerHTML = ultimosAbertos.length ? ultimosAbertos.map(m => `<div><i class="fas fa-wrench"></i> ${esc(m.data)} - ${esc(m.maquina)} (${esc(m.situacao)})</div>`).join('') : 'Nenhum chamado aberto recente.';
    const ultimosFechados = [...manutencoes].filter(m => m.etiquetaFechada).slice(0, 3);
    document.getElementById('man-dashboardFechados').innerHTML = ultimosFechados.length ? ultimosFechados.map(m => `<div><i class="fas fa-check"></i> ${esc(m.data)} - ${esc(m.maquina)} (${esc(m.observador)})</div>`).join('') : 'Nenhum chamado fechado recente.';

    // MTTR
    const mttrMap = {};
    manutencoes
      .filter(m => m.etiquetaFechada && Number(m.tempoGasto) > 0)
      .forEach(m => {
        const maq = m.maquina || 'Desconhecida';
        if (!mttrMap[maq]) mttrMap[maq] = { total: 0, count: 0 };
        mttrMap[maq].total += Number(m.tempoGasto);
        mttrMap[maq].count++;
      });

    let mttrHtml = '';
    for (const [maq, data] of Object.entries(mttrMap)) {
      if (data.count > 0) {
        const mediaMin = data.total / data.count;
        const mediaHoras = mediaMin / 60;
        const horasFormatadas = mediaHoras.toFixed(1);
        mttrHtml += `<div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid var(--border); font-size:14px; color:var(--text-2);"><span>${esc(maq)}</span><span style="color:var(--accent); font-weight:600;">${horasFormatadas} h</span></div>`;
      }
    }
    document.getElementById('man-mttrContainer').innerHTML = mttrHtml || 'Nenhum dado de MTTR disponível.';

    const labels = [], abertos = [], fechados = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.toISOString().slice(0, 7);
      labels.push(d.toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }));
      abertos.push(manutencoes.filter(m => m.data.slice(0, 7) === key && !m.etiquetaFechada).length);
      fechados.push(manutencoes.filter(m => m.data.slice(0, 7) === key && m.etiquetaFechada).length);
    }

    if (chartInstance) chartInstance.destroy();
    const ctx = document.getElementById('man-chartManutencao').getContext('2d');
    const corVermelho = _corTema('--red', '#ef4444');
    const corVerde = _corTema('--green', '#10b981');
    const corTextoEixo = _corTema('--text-2', '#9aa3b2');
    chartInstance = new Chart(ctx, {
      type: 'bar', data: { labels: labels, datasets: [
          { label: 'Abertos', data: abertos, backgroundColor: corVermelho + 'b3', borderColor: corVermelho, borderWidth: 1 },
          { label: 'Fechados', data: fechados, backgroundColor: corVerde + 'b3', borderColor: corVerde, borderWidth: 1 }
        ]
      },
      options: { responsive: true, maintainAspectRatio: true, plugins: { legend: { labels: { color: corTextoEixo } } }, scales: { x: { ticks: { color: corTextoEixo }, grid: { color: 'rgba(255,255,255,0.05)' } }, y: { ticks: { color: corTextoEixo }, grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true } } }
    });
  }

  // ============================================================
  // 6. EXPORTAÇÃO (COM ESCAPE DE CSV ROBUSTO)
  // ============================================================
  function escapeCSV(text) {
    if (!text) return '';
    let t = String(text);
    // Se contiver ponto e vírgula, aspas ou quebras de linha, escapa e envolve em aspas duplas
    if (t.includes(';') || t.includes('"') || t.includes('\n') || t.includes('\r')) {
        t = t.replace(/"/g, '""');
        t = `"${t}"`;
    }
    return t;
  }

  function exportarCSV() {
    if(manutencoes.length === 0) { toast('Nenhum dado para exportar.', 'error'); return; }
    const headers = 'ID;Máquina;Setor;Turno;Observador;Prioridade;Situação;Anomalia;Custo Peças;Custo Mão Obra\n';
    const rows = manutencoes.map(m => 
      `${esc(m.id)};${escapeCSV(m.maquina)};${escapeCSV(m.setor)};${escapeCSV(m.turno)};${escapeCSV(m.observador)};${escapeCSV(m.prioridade)};${escapeCSV(m.situacao)};${escapeCSV(m.anomalia)};${m.custoPecas || 0};${m.custoMaoObra || 0}`
    ).join('\n');
    const blob = new Blob([headers + rows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `lightwall_${new Date().toISOString().split('T')[0]}.csv`;
    a.click(); URL.revokeObjectURL(url); toast('Exportação CSV concluída!');
  }

  // ============================================================
  // 7. INICIALIZAÇÃO
  // ============================================================
  // Antes rodava sozinho em DOMContentLoaded (protótipo standalone, único
  // conteúdo da página). Agora que é mais uma página da SPA, só inicializa
  // quando o usuário navega até ela pela 1ª vez — mesmo padrão de
  // MAN.init(), chamado de dentro de showPage() (ver app-core.js e
  // SQ.init() do Setor de Qualidade, que segue a mesma lógica).
  //
  // async desde a Fase 2 (backend real) — antes os dados já estavam
  // disponíveis de forma síncrona (localStorage); agora tem que esperar
  // as listas chegarem do servidor (ver carregarTudoDoServidor(), início
  // do arquivo) ANTES de renderizar qualquer coisa, senão a primeira
  // renderização mostraria tudo vazio por um instante.
  async function init() {
    const progData = document.getElementById('man-progData');
    if (progData) progData.valueAsDate = new Date();
    navegar('manutencao');
    await carregarTudoDoServidor();
    renderDashboard(); renderCorretiva(); renderProgramada();
    _aplicarVisibilidadeDeEdicao();
  }

  // Esconde os botões estáticos marcados com [data-manut-area] que o
  // perfil atual não pode usar (modelo novo, ver lib/perfis.js): "Novo
  // Chamado"/"Salvar Chamado" exigem 'manutencao-chamado' (todo perfil com
  // acesso a Manutenção tem isso, exceto quem não tem nenhuma área de
  // manutenção); o resto (Fechar Chamado, Programada) exige 'manutencao'
  // completa. Mesmo padrão de _aplicarVisibilidadeDoMenu() (app-core.js)
  // — só a parte visual, o servidor valida de novo em cada rota de
  // escrita.
  function _aplicarVisibilidadeDeEdicao() {
    if (typeof _perfilPodeEditar !== 'function') return;
    document.querySelectorAll('[data-manut-area]').forEach(el => {
      const area = el.getAttribute('data-manut-area');
      el.style.display = _perfilPodeEditar(area) ? '' : 'none';
    });
  }

  /* ── API pública ──────────────────────────────────────────
     Todo o código acima ficou fechado numa IIFE (o protótipo original
     declarava essas ~74 funções soltas, direto no <script> — qualquer uma
     delas (esc, toast, gerarId, ...) vazava pro window global e podia
     colidir com qualquer coisa que o resto do sistema definisse no
     futuro; nomes como "toast" e "esc" são genéricos demais pra ficar
     soltos). Só as funções REALMENTE chamadas de fora da IIFE (pelos
     onclick="..." do HTML — tanto os estáticos em page-manutencao.html
     quanto os gerados dinamicamente pelas próprias template strings do
     JS, ex: onclick="excluirManutencao('${m.id}')" dentro de
     renderCorretiva) são expostas aqui — os outros ~20 helpers internos
     (esc, gerarId, toast, formatarTempo, compressImage, etc.) continuam
     privados dentro da IIFE, só acessíveis de dentro dela mesma.

     window.MAN.init() é chamado por showPage('manutencao', ...) — ver
     app-core.js — na 1ª vez que o usuário abre a página (mesmo padrão
     de SQ.init(), Setor de Qualidade). Cada window.nomeFuncao = MAN.nomeFuncao
     abaixo existe só por compatibilidade com os onclick="..." inline
     (que chamam a função pelo nome direto, sem "MAN." na frente) — sem
     isso, precisaríamos reescrever todo onclick="excluirManutencao(...)"
     do HTML (estático E gerado dinamicamente) para
     onclick="MAN.excluirManutencao(...)". */
  window.MAN = {
    abrirDetalhesProgramada,
    abrirHistorico,
    _construirPassosTrajetoria,
    _renderizarTrajetoria,
    abrirModalFechamento,
    abrirModalFinalizar,
    abrirModalInicio,
    abrirModalReprovacao,
    abrirModalRecusaChamado,
    fecharModalRecusaChamado,
    confirmarRecusaChamado,
    responderRecusaChamado,
    aceitarChamado,
    aceitarPedidoPeca,
    aoMudarSituacao,
    aplicarFiltrosCorretiva,
    aprovarAgendamento,
    calcularTempoEstimado,
    calcularTempoExecucao,
    calcularTempoGasto,
    calcularTempoSupervisao,
    changePageProgramada,
    confirmarAprovacao,
    confirmarFechamento,
    confirmarInicio,
    confirmarReprovacao,
    editarManutencao,
    excluirAgendamento,
    excluirManutencao,
    exportarCSV,
    fecharFormulario,
    fecharModal,
    fecharModalAprovacao,
    fecharModalDetalhesProgramada,
    fecharModalFinalizar,
    fecharModalHistorico,
    fecharModalInicio,
    fecharModalReprovacao,
    limparFiltrosCorretiva,
    navegar,
    novoChamado,
    previewArquivo,
    removerArquivo,
    salvarExecucao,
    salvarManutencao,
    setPrioridade,
    toggleEmpresaExterna,
    toggleExecEmpresaExterna,
    toggleExecucaoCampos,
    toggleSupervisorSection,
    toggleTipo,
    verificarEAgendiar,
    init,
  };
  window.abrirDetalhesProgramada = MAN.abrirDetalhesProgramada;
  window.abrirHistorico = MAN.abrirHistorico;
  // Funções internas (prefixo "_"), mas chamadas direto de atributos
  // inline (onmouseenter/onmousemove/onmouseleave) na linha da tabela —
  // ver renderCorretiva() — por isso precisam estar no escopo global,
  // mesmo não fazendo parte da API pública em MAN.
  window._mostrarPreviewTrajetoria = _mostrarPreviewTrajetoria;
  window._esconderPreviewTrajetoria = _esconderPreviewTrajetoria;
  window._manIrParaStep = _manIrParaStep;
  window._manToggleFase = _manToggleFase;
  window.abrirModalFechamento = MAN.abrirModalFechamento;
  window.abrirModalFinalizar = MAN.abrirModalFinalizar;
  window.abrirModalInicio = MAN.abrirModalInicio;
  window.abrirModalReprovacao = MAN.abrirModalReprovacao;
  window.abrirModalRecusaChamado = MAN.abrirModalRecusaChamado;
  window.fecharModalRecusaChamado = MAN.fecharModalRecusaChamado;
  window.confirmarRecusaChamado = MAN.confirmarRecusaChamado;
  window.responderRecusaChamado = MAN.responderRecusaChamado;
  window.aceitarChamado = MAN.aceitarChamado;
  window.aceitarPedidoPeca = MAN.aceitarPedidoPeca;
  window.aoMudarSituacao = MAN.aoMudarSituacao;
  window.aplicarFiltrosCorretiva = MAN.aplicarFiltrosCorretiva;
  window.aprovarAgendamento = MAN.aprovarAgendamento;
  window.calcularTempoEstimado = MAN.calcularTempoEstimado;
  window.calcularTempoExecucao = MAN.calcularTempoExecucao;
  window.calcularTempoGasto = MAN.calcularTempoGasto;
  window.calcularTempoSupervisao = MAN.calcularTempoSupervisao;
  window.changePageProgramada = MAN.changePageProgramada;
  window.confirmarAprovacao = MAN.confirmarAprovacao;
  window.confirmarFechamento = MAN.confirmarFechamento;
  window.confirmarInicio = MAN.confirmarInicio;
  window.confirmarReprovacao = MAN.confirmarReprovacao;
  window.editarManutencao = MAN.editarManutencao;
  window.excluirAgendamento = MAN.excluirAgendamento;
  window.excluirManutencao = MAN.excluirManutencao;
  window.exportarCSV = MAN.exportarCSV;
  window.fecharFormulario = MAN.fecharFormulario;
  window.fecharModal = MAN.fecharModal;
  window.fecharModalAprovacao = MAN.fecharModalAprovacao;
  window.fecharModalDetalhesProgramada = MAN.fecharModalDetalhesProgramada;
  window.fecharModalFinalizar = MAN.fecharModalFinalizar;
  window.fecharModalHistorico = MAN.fecharModalHistorico;
  window.fecharModalInicio = MAN.fecharModalInicio;
  window.fecharModalReprovacao = MAN.fecharModalReprovacao;
  window.limparFiltrosCorretiva = MAN.limparFiltrosCorretiva;
  window.navegar = MAN.navegar;
  window.novoChamado = MAN.novoChamado;
  window.previewArquivo = MAN.previewArquivo;
  window.removerArquivo = MAN.removerArquivo;
  window.salvarExecucao = MAN.salvarExecucao;
  window.salvarManutencao = MAN.salvarManutencao;
  window.setPrioridade = MAN.setPrioridade;
  window.toggleEmpresaExterna = MAN.toggleEmpresaExterna;
  window.toggleExecEmpresaExterna = MAN.toggleExecEmpresaExterna;
  window.toggleExecucaoCampos = MAN.toggleExecucaoCampos;
  window.toggleSupervisorSection = MAN.toggleSupervisorSection;
  window.toggleTipo = MAN.toggleTipo;
  window.verificarEAgendiar = MAN.verificarEAgendiar;

})();
