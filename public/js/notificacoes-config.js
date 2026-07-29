// ─── notificacoes-config.js — Configurações → Notificações ─────────────────
// "Gerenciar quem recebe cada notificação (por perfil)" — pedido do
// usuário. NÃO cria rota nova nenhuma no servidor: reaproveita os mesmos
// itens de notificação já existentes no catálogo de permissões
// (`manutencao-notificacao-abertura`/`manutencao-notificacao-pedido-peca`/
// `manutencao-notificacao-peca-recebida`/`manutencao-notificacao-programada`/
// `manutencao-notificacao-programada-lembrete`, ver lib/itens-permissao.js)
// e as mesmas rotas de leitura/escrita que já existem pra permissões de
// perfil (GET/POST /permissoes-perfil-fixo pros 6 fixos, POST
// /editar-perfil-customizado pros customizados) — a única coisa nova aqui
// é a TELA: uma lista focada só nesses toggles, em vez do catálogo
// inteiro (páginas, dashboards, Configurações etc.) que já existe em "+
// Criar novo tipo de perfil" (ver public/js/perfis-customizados.js).
//
// Funções globais (mesmo padrão do resto do projeto — scripts sem
// módulo, tudo no mesmo escopo da página), chamadas por
// cfgMostrarSecao('notificacoes') (app-core.js) e via onchange="..." nos
// toggles renderizados aqui.

const _NC_ITEM_ABERTURA = 'manutencao-notificacao-abertura';
const _NC_ITEM_PEDIDO_PECA = 'manutencao-notificacao-pedido-peca';
const _NC_ITEM_PECA_RECEBIDA = 'manutencao-notificacao-peca-recebida';
const _NC_ITEM_PROGRAMADA = 'manutencao-notificacao-programada';
const _NC_ITEM_PROGRAMADA_LEMBRETE = 'manutencao-notificacao-programada-lembrete';

let _ncCarregando = false;

// Chamada toda vez que a aba é mostrada (ver cfgMostrarSecao) — sempre
// busca dados frescos do servidor, nunca cacheado entre aberturas (mesmo
// raciocínio de cfgRenderAutomacao: nunca ficar dessincronizado se algo
// mudou noutra tela/dispositivo enquanto o modal estava fechado).
async function cfgRenderNotificacoes() {
  const container = document.getElementById('cfg-notificacoes-lista');
  if (!container || _ncCarregando) return;
  _ncCarregando = true;
  container.innerHTML = '<span style="color:var(--text-3);font-size:.82rem">Carregando…</span>';

  try {
    const linhas = await _ncMontarLinhas();
    container.innerHTML = linhas.map(_ncRenderLinha).join('');
  } catch (e) {
    container.innerHTML = `<span style="color:var(--red);font-size:.82rem">Erro ao carregar: ${_escaparHtmlLocal(e.message)}</span>`;
  } finally {
    _ncCarregando = false;
  }
}

// Monta {perfilId, rotulo, ehCustomizado, permissoes} pra TODOS os
// perfis CADASTRÁVEIS (6 fixos + customizados — "Administrador" master
// nunca entra aqui, de propósito: nem faz parte de perfisCadastraveis,
// ver PERFIS_CADASTRAVEIS em lib/perfis.js, comentário explica o
// porquê). Pros fixos, busca o mapa efetivo (override salvo ou padrão)
// via a mesma rota já usada pela engrenagem ⚙️ em Usuários; pros
// customizados, reaproveita o cache já carregado por
// perfis-customizados.js (mesmo mapa completo usado no editor de lá).
async function _ncMontarLinhas() {
  if (!_perfisInfoCache) {
    try {
      const res = await fetch('/perfis');
      _perfisInfoCache = await res.json();
    } catch (e) {
      _perfisInfoCache = { perfisCadastraveis: [], rotulosPorPerfil: {} };
    }
  }
  await _cpCarregarPerfisCustomizados();

  const idsCustomizados = new Set(_cpPerfisCustomizadosCache.map(p => p.id));
  const ids = _perfisInfoCache.perfisCadastraveis || [];
  const rotulos = _perfisInfoCache.rotulosPorPerfil || {};
  const idsFixos = ids.filter(id => !idsCustomizados.has(id));

  const linhasFixas = await Promise.all(idsFixos.map(async perfilId => {
    try {
      const res = await fetch(`/permissoes-perfil-fixo?perfil=${encodeURIComponent(perfilId)}`);
      const data = await res.json();
      return {
        perfilId,
        rotulo: (data.ok && data.rotulo) || rotulos[perfilId] || perfilId,
        ehCustomizado: false,
        permissoes: (data.ok && data.permissoes) || {},
      };
    } catch (e) {
      return { perfilId, rotulo: rotulos[perfilId] || perfilId, ehCustomizado: false, permissoes: {} };
    }
  }));

  const linhasCustomizadas = _cpPerfisCustomizadosCache.map(p => ({
    perfilId: p.id, rotulo: p.nome, ehCustomizado: true, permissoes: p.permissoes || {},
  }));

  return [...linhasFixas, ...linhasCustomizadas];
}

function _ncRenderLinha({ perfilId, rotulo, ehCustomizado, permissoes }) {
  const badge = ehCustomizado
    ? '<span class="badge badge-blue" title="Perfil customizado">Customizado</span>'
    : '';
  return `
    <div style="display:flex;align-items:center;gap:16px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;flex-wrap:wrap">
      <div style="flex:1;min-width:150px;display:flex;align-items:center;gap:8px">
        <span style="font-size:.85rem;font-weight:600;color:var(--text)">${_escaparHtmlLocal(rotulo)}</span>
        ${badge}
      </div>
      ${_ncToggle(perfilId, ehCustomizado, _NC_ITEM_ABERTURA, 'Abertura de Chamado', '🆕', permissoes[_NC_ITEM_ABERTURA] === 'total')}
      ${_ncToggle(perfilId, ehCustomizado, _NC_ITEM_PEDIDO_PECA, 'Pedido de Peça', '🔧', permissoes[_NC_ITEM_PEDIDO_PECA] === 'total')}
      ${_ncToggle(perfilId, ehCustomizado, _NC_ITEM_PECA_RECEBIDA, 'Peça Recebida', '📦', permissoes[_NC_ITEM_PECA_RECEBIDA] === 'total')}
      ${_ncToggle(perfilId, ehCustomizado, _NC_ITEM_PROGRAMADA, 'Manutenção Programada', '📅', permissoes[_NC_ITEM_PROGRAMADA] === 'total')}
      ${_ncToggle(perfilId, ehCustomizado, _NC_ITEM_PROGRAMADA_LEMBRETE, 'Lembrete no Dia (09h)', '⏰', permissoes[_NC_ITEM_PROGRAMADA_LEMBRETE] === 'total')}
    </div>
  `;
}

function _ncToggle(perfilId, ehCustomizado, itemId, rotuloItem, icone, ativo) {
  return `
    <label style="display:flex;align-items:center;gap:8px;font-size:.78rem;color:var(--text-2);cursor:pointer;min-width:190px">
      <span class="switch">
        <input type="checkbox" ${ativo ? 'checked' : ''}
          onchange="_ncToggleNotificacao('${_escaparHtmlLocal(perfilId)}', ${ehCustomizado}, '${itemId}', '${_escaparHtmlLocal(rotuloItem)}', this)">
        <span class="switch-slider"></span>
      </span>
      ${icone} ${_escaparHtmlLocal(rotuloItem)}
    </label>
  `;
}

// Salva 1 toggle — exige senha de Administrador (mesmo padrão de
// cfgToggleModoAutomatico, app-core.js: desfaz o clique NA HORA e só
// aplica de verdade depois da senha confirmada + servidor responder OK).
async function _ncToggleNotificacao(perfilId, ehCustomizado, itemId, rotuloItem, checkboxEl) {
  const novoValor = checkboxEl.checked;
  checkboxEl.checked = !novoValor; // desfaz na hora — só aplica após a senha

  if (typeof AdminAuth === 'undefined') {
    LW.mostrarAlerta('Não foi possível confirmar a senha de administrador nesta tela.', { tipo: 'erro' });
    return;
  }

  AdminAuth.abrirModal(async function onSuccess() {
    try {
      const nivel = novoValor ? 'total' : 'ocultar';
      let permissoesFinais;

      if (ehCustomizado) {
        const perfil = _cpPerfisCustomizadosCache.find(p => p.id === perfilId);
        if (!perfil) {
          LW.mostrarAlerta('Perfil customizado não encontrado — a lista pode ter mudado, recarregue a aba.', { tipo: 'erro' });
          return;
        }
        permissoesFinais = { ...(perfil.permissoes || {}), [itemId]: nivel };
        const res = await fetch('/editar-perfil-customizado', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: perfilId, permissoes: permissoesFinais }),
        });
        const json = await res.json();
        if (!json.ok) {
          LW.mostrarAlerta(json.erro || 'Erro ao salvar esta notificação.', { tipo: 'erro' });
          return;
        }
        perfil.permissoes = json.perfil.permissoes; // mantém o cache local em dia
      } else {
        // Nunca manda um payload parcial — busca o mapa ATUAL completo
        // primeiro, senão os outros itens deste perfil fixo (páginas,
        // áreas de edição etc.) voltariam pro padrão "ocultar" (ver
        // validarMapaDePermissoes, lib/itens-permissao.js).
        const resAtual = await fetch(`/permissoes-perfil-fixo?perfil=${encodeURIComponent(perfilId)}`);
        const dataAtual = await resAtual.json();
        if (!dataAtual.ok) {
          LW.mostrarAlerta(dataAtual.erro || 'Não foi possível carregar as permissões atuais deste perfil.', { tipo: 'erro' });
          return;
        }
        permissoesFinais = { ...(dataAtual.permissoes || {}), [itemId]: nivel };
        const res = await fetch('/salvar-permissoes-perfil-fixo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ perfil: perfilId, permissoes: permissoesFinais }),
        });
        const json = await res.json();
        if (!json.ok) {
          LW.mostrarAlerta(json.erro || 'Erro ao salvar esta notificação.', { tipo: 'erro' });
          return;
        }
      }

      checkboxEl.checked = novoValor;
      LW.mostrarAlerta(
        `Notificação de "${rotuloItem}" ${novoValor ? 'ativada' : 'desativada'} pra este perfil.`,
        { tipo: 'sucesso' }
      );
    } catch (_) {
      LW.mostrarAlerta('Erro de conexão ao salvar. Verifique a rede e tente novamente.', { tipo: 'erro' });
    }
  });
  // Se cancelar o modal de senha, o checkbox já foi revertido acima —
  // nada mais precisa acontecer.
}
