// ─── perfis-customizados.js — "Criar Novo Tipo de Perfil" ──────────────────
// Configurações → Usuários → "+ Criar novo tipo de perfil": deixa o
// Administrador desenhar um perfil do zero, item por item (páginas,
// dashboards, sub-itens de Setor de Qualidade/Manutenção, "Outros",
// Configurações — ver GET /catalogo-permissoes, lib/itens-permissao.js),
// marcando cada um como Acesso Total / Apenas Visualizar / Ocultar.
//
// Perfis criados aqui somam-se aos 6 fixos do sistema (nunca os
// substituem) — ver lib/perfis-customizados.js no servidor. Todo o
// resto do app (menu lateral, abas de Configurações, checkbox "Pode
// iniciar operações") já sabe lidar com QUALQUER perfil que apareça em
// GET /perfis (paginasPorPerfil/areasEdicaoPorPerfil) — não precisou
// mudar nada além de passar a mesclar os customizados nessa resposta.
//
// Funções deste arquivo são globais (mesmo padrão do resto do projeto:
// scripts sem módulo, tudo no mesmo escopo da página) — chamadas via
// onclick="..." no HTML (modal-criar-perfil.html) e também de dentro de
// app-core.js (cfgRenderUsuarios chama _cfgPopularSelectPerfil e
// cfgRenderPerfisCustomizados definidas aqui).

let _cpCatalogoCache = null;      // array de itens (GET /catalogo-permissoes), carregado 1x
let _cpPerfisCustomizadosCache = []; // lista de perfis customizados já criados
let _cpEditandoId = null;         // null = criando um perfil novo; string = editando esse id

// Rótulos amigáveis pros grupos do catálogo (tipo -> título da seção) —
// a ORDEM aqui também decide a ordem de exibição no modal.
const _CP_GRUPOS = [
  { tipo: 'pagina', titulo: '📄 Páginas' },
  { tipo: 'dashboard', titulo: '📊 Dashboards' },
  { tipo: 'acao', titulo: '🗂️ Outros' },
  { tipo: 'config', titulo: '⚙️ Configurações' },
];

async function _cpCarregarCatalogo() {
  if (_cpCatalogoCache) return _cpCatalogoCache;
  try {
    const res = await fetch('/catalogo-permissoes');
    const data = await res.json();
    _cpCatalogoCache = (data.ok && data.catalogo) || [];
  } catch (e) {
    _cpCatalogoCache = [];
  }
  return _cpCatalogoCache;
}

async function _cpCarregarPerfisCustomizados() {
  try {
    const res = await fetch('/perfis-customizados');
    const data = await res.json();
    _cpPerfisCustomizadosCache = (data.ok && data.perfis) || [];
  } catch (e) {
    _cpPerfisCustomizadosCache = [];
  }
  return _cpPerfisCustomizadosCache;
}

// Preenche o <select id="cfg-usuario-perfil"> com TODOS os perfis
// (6 fixos + customizados), usando os rótulos já carregados em
// _perfisInfoCache (ver app-core.js, cfgAtualizarCampoPodeIniciarOperacao)
// — chamada de dentro de cfgRenderUsuarios(), depois desse cache estar
// pronto.
function _cfgPopularSelectPerfil() {
  const select = document.getElementById('cfg-usuario-perfil');
  if (!select || !_perfisInfoCache) return;
  const valorAtual = select.value;
  const ids = _perfisInfoCache.perfisCadastraveis || [];
  const rotulos = _perfisInfoCache.rotulosPorPerfil || {};
  select.innerHTML = ids.map(id => `<option value="${_escaparHtmlLocal(id)}">${_escaparHtmlLocal(rotulos[id] || id)}</option>`).join('');
  // Preserva a seleção anterior se ainda existir na lista nova (ex: depois
  // de criar um perfil customizado, a lista muda mas o usuário pode já
  // ter escolhido algo antes) — senão cai no primeiro item.
  if (ids.includes(valorAtual)) select.value = valorAtual;
}

// Renderiza a lista de perfis CUSTOMIZADOS (não os 6 fixos) em
// Configurações → Usuários, com botões Editar/Excluir.
async function cfgRenderPerfisCustomizados() {
  const el = document.getElementById('cfg-perfis-customizados-lista');
  if (!el) return;
  await _cpCarregarPerfisCustomizados();

  if (!_cpPerfisCustomizadosCache.length) {
    el.innerHTML = '<span style="color:var(--text-3);font-size:.82rem">Nenhum perfil customizado criado ainda.</span>';
    return;
  }

  el.innerHTML = _cpPerfisCustomizadosCache.map(p => `
    <div style="display:flex;align-items:center;gap:12px;background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius);padding:8px 12px;flex-wrap:wrap">
      <span style="font-size:.85rem;font-weight:600;color:var(--text)">${_escaparHtmlLocal(p.nome)}</span>
      <span class="badge badge-blue" title="Perfil customizado">Customizado</span>
      <div style="margin-left:auto;display:flex;gap:14px">
        <button onclick="abrirEditarPerfil('${_escaparHtmlLocal(p.id)}')" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:.82rem">✎ Editar</button>
        <button onclick="excluirPerfilCustomizado('${_escaparHtmlLocal(p.id)}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:.82rem">✕ Excluir</button>
      </div>
    </div>
  `).join('');
}

// ── Render do catálogo dentro do modal ──────────────────────────────────

// Itens cujo controle ainda é EXCLUSIVO do Administrador Master e do
// perfil fixo "Administrador" no backend (backup, SQL, importação,
// gerenciar usuários, salvar configurações — ver temPoderesDeAdmin,
// server.js): marcar "Acesso Total" pra um perfil CUSTOMIZADO nesses
// itens ainda não concede acesso de verdade (só os 5 grupos de
// lib/perfis.js AREAS_DE_EDICAO têm a ponte real pra perfis
// customizados, ver lib/perfis-customizados.js). Ficam travados em
// "Ocultar" no formulário de criação, com uma nota explicando o motivo,
// pra não prometer um controle que ainda não existe de verdade.
function _cpItemAindaExclusivoDoAdmin(item) {
  if (item.tipo === 'acao') return true;
  if (item.tipo === 'config' && item.id !== 'config-atalhos') return true;
  return false;
}

// Monta uma linha (item + seletor de 3 opções) — usada tanto pros itens
// de topo quanto pros sub-itens (indentados via `nivelIndentacao`).
function _cpLinhaItem(item, nivelAtual, nivelIndentacao) {
  const nome = `cp-item-${item.id}`;
  const travado = _cpItemAindaExclusivoDoAdmin(item);
  const opcoes = [
    { valor: 'total', rotulo: 'Acesso Total' },
    { valor: 'visualizar', rotulo: 'Apenas Visualizar' },
    { valor: 'ocultar', rotulo: 'Ocultar' },
  ];
  const botoes = opcoes.map(o => `
    <label style="display:flex;align-items:center;gap:4px;font-size:.76rem;color:${travado ? 'var(--text-3)' : 'var(--text-2)'};cursor:${travado ? 'not-allowed' : 'pointer'};white-space:nowrap">
      <input type="radio" name="${nome}" value="${o.valor}" ${(travado ? o.valor === 'ocultar' : nivelAtual === o.valor) ? 'checked' : ''} ${travado ? 'disabled' : ''} style="cursor:inherit">
      ${o.rotulo}
    </label>
  `).join('');
  const nota = travado
    ? `<div style="font-size:.72rem;color:var(--text-3);width:100%;margin-top:2px">🔒 Ainda exclusivo do perfil Administrador — este controle granular chega numa próxima etapa.</div>`
    : '';
  return `
    <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:6px 0;padding-left:${nivelIndentacao * 18}px;border-bottom:1px solid var(--border)">
      <span style="font-size:.85rem;color:var(--text);flex:1;min-width:160px">${nivelIndentacao > 0 ? '↳ ' : ''}${_escaparHtmlLocal(item.rotulo)}</span>
      <div style="display:flex;gap:12px;flex-wrap:wrap">${botoes}</div>
      ${nota}
    </div>
  `;
}

// Renderiza recursivamente um item e seus filhos diretos (ver campo `pai`
// no catálogo — Setor de Qualidade/Manutenção têm 1 nível de sub-itens, e
// Manutenção Corretiva tem mais 1 nível dentro dele: as 4 seções do
// formulário de chamado).
function _cpRenderItemEFilhos(item, catalogo, permissoesAtuais, nivelIndentacao) {
  const nivelAtual = permissoesAtuais[item.id] || 'ocultar';
  let html = _cpLinhaItem(item, nivelAtual, nivelIndentacao);
  const filhos = catalogo.filter(i => i.pai === item.id);
  for (const filho of filhos) {
    html += _cpRenderItemEFilhos(filho, catalogo, permissoesAtuais, nivelIndentacao + 1);
  }
  return html;
}

async function _cpRenderCatalogo(permissoesAtuais) {
  const container = document.getElementById('cp-catalogo');
  const catalogo = await _cpCarregarCatalogo();
  if (!catalogo.length) {
    container.innerHTML = '<span style="color:var(--red);font-size:.82rem">Não foi possível carregar o catálogo de permissões.</span>';
    return;
  }

  container.innerHTML = _CP_GRUPOS.map(grupo => {
    // Só os itens de TOPO do grupo (sem "pai") — os filhos entram
    // recursivamente dentro de _cpRenderItemEFilhos.
    const itensDoGrupo = catalogo.filter(i => i.tipo === grupo.tipo && !i.pai);
    if (!itensDoGrupo.length) return '';
    const linhas = itensDoGrupo.map(item => _cpRenderItemEFilhos(item, catalogo, permissoesAtuais, 0)).join('');
    return `
      <div>
        <div style="font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:var(--text-3);margin-bottom:8px">${grupo.titulo}</div>
        <div>${linhas}</div>
      </div>
    `;
  }).join('');
}

// Lê o estado atual de TODOS os radios do catálogo — {itemId: nivel}.
function _cpColetarPermissoesDoFormulario() {
  const permissoes = {};
  document.querySelectorAll('#cp-catalogo input[type="radio"]:checked').forEach(input => {
    const itemId = input.name.replace(/^cp-item-/, '');
    permissoes[itemId] = input.value;
  });
  return permissoes;
}

// ── Abrir / fechar modal ─────────────────────────────────────────────────

async function abrirCriarPerfil() {
  _cpEditandoId = null;
  document.getElementById('cp-titulo').textContent = '➕ CRIAR NOVO TIPO DE PERFIL';
  document.getElementById('cp-nome').value = '';
  document.getElementById('cp-nome').disabled = false;
  document.getElementById('cp-erro').style.display = 'none';
  document.getElementById('cp-btn-salvar').textContent = 'Salvar Perfil';
  await _cpRenderCatalogo({}); // tudo começa oculto — admin decide o que liberar
  document.getElementById('criar-perfil-modal').style.display = 'flex';
}

async function abrirEditarPerfil(id) {
  await _cpCarregarPerfisCustomizados();
  const perfil = _cpPerfisCustomizadosCache.find(p => p.id === id);
  if (!perfil) { LW.mostrarAlerta('Perfil customizado não encontrado — a lista pode ter mudado, recarregue.', { tipo: 'erro' }); return; }

  _cpEditandoId = id;
  document.getElementById('cp-titulo').textContent = '✎ EDITAR TIPO DE PERFIL';
  document.getElementById('cp-nome').value = perfil.nome;
  document.getElementById('cp-nome').disabled = false;
  document.getElementById('cp-erro').style.display = 'none';
  document.getElementById('cp-btn-salvar').textContent = 'Salvar Alterações';
  await _cpRenderCatalogo(perfil.permissoes || {});
  document.getElementById('criar-perfil-modal').style.display = 'flex';
}

function fecharCriarPerfil() {
  document.getElementById('criar-perfil-modal').style.display = 'none';
}

// ── Salvar / excluir (exigem sessão de Administrador — mesmo modal de
// senha de sempre, AdminAuth.abrirModal, igual a _cfgSalvarUsuarios) ─────

async function salvarPerfilCustomizado() {
  const nome = document.getElementById('cp-nome').value.trim();
  const erroEl = document.getElementById('cp-erro');
  erroEl.style.display = 'none';

  if (!nome) {
    erroEl.textContent = 'Digite um nome pro perfil.';
    erroEl.style.display = 'block';
    return;
  }

  const permissoes = _cpColetarPermissoesDoFormulario();
  const payload = _cpEditandoId
    ? { id: _cpEditandoId, nome, permissoes }
    : { nome, permissoes };
  const rota = _cpEditandoId ? '/editar-perfil-customizado' : '/criar-perfil-customizado';

  const btn = document.getElementById('cp-btn-salvar');
  const textoOriginal = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Salvando...';

  const executar = () => new Promise((resolve, reject) => {
    if (typeof AdminAuth === 'undefined') {
      reject(new Error('Não foi possível confirmar a senha de administrador nesta tela.'));
      return;
    }
    AdminAuth.abrirModal(async function onSuccess() {
      try {
        const res = await fetch(rota, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.erro || 'Erro ao salvar perfil.');
        resolve();
      } catch (err) {
        reject(err);
      }
    }, function onCancel() {
      const err = new Error('Cancelado.');
      err.silencioso = true;
      reject(err);
    });
  });

  try {
    await executar();
    fecharCriarPerfil();
    // _perfisInfoCache (app-core.js) guarda a resposta de GET /perfis em
    // cache indefinidamente depois da 1ª carga — sem invalidar aqui, o
    // <select> de perfil e o checkbox "pode iniciar operação" continuariam
    // sem saber que este perfil novo/editado existe até um F5.
    _perfisInfoCache = null;
    await cfgAtualizarCampoPodeIniciarOperacao();
    await cfgRenderPerfisCustomizados();
    _cfgPopularSelectPerfil();
    LW.mostrarAlerta(_cpEditandoId ? 'Perfil atualizado com sucesso!' : 'Perfil criado com sucesso!', { tipo: 'sucesso' });
  } catch (e) {
    if (e.silencioso) { btn.disabled = false; btn.textContent = textoOriginal; return; }
    erroEl.textContent = e.message;
    erroEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
}

async function excluirPerfilCustomizado(id) {
  const perfil = _cpPerfisCustomizadosCache.find(p => p.id === id);
  const confirmou = await LW.mostrarConfirmacao(
    `Excluir o perfil "${perfil?.nome || id}"? Só é possível excluir se nenhum usuário cadastrado estiver usando esse perfil no momento.`,
    { titulo: 'Excluir perfil customizado', textoConfirmar: 'Excluir', tipo: 'perigo', icon: '🗑️' }
  );
  if (!confirmou) return;

  const executar = () => new Promise((resolve, reject) => {
    if (typeof AdminAuth === 'undefined') {
      reject(new Error('Não foi possível confirmar a senha de administrador nesta tela.'));
      return;
    }
    AdminAuth.abrirModal(async function onSuccess() {
      try {
        const res = await fetch('/excluir-perfil-customizado', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.erro || 'Erro ao excluir perfil.');
        resolve();
      } catch (err) {
        reject(err);
      }
    }, function onCancel() {
      const err = new Error('Cancelado.');
      err.silencioso = true;
      reject(err);
    });
  });

  try {
    await executar();
    _perfisInfoCache = null;
    await cfgAtualizarCampoPodeIniciarOperacao();
    await cfgRenderPerfisCustomizados();
    _cfgPopularSelectPerfil();
    LW.mostrarAlerta('Perfil excluído.', { tipo: 'sucesso' });
  } catch (e) {
    if (!e.silencioso) LW.mostrarAlerta('Erro ao excluir: ' + e.message, { tipo: 'erro' });
  }
}
