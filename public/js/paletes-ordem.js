// ─── paletes-ordem.js — "Ordem dos Paletes" (Configurações → Paletes) ───────
// Define a posição VISUAL de cada um dos 4 paletes-base na tela do Setor
// de Qualidade (layout 2x2):
//
//   [ Palete 2 ] [ Palete 1 ]
//   [ Palete 3 ] [ Palete 4 ]
//
// Segurar o rótulo "PALETE N" aqui dentro e arrastar pra cima de outro
// troca a posição dos dois no rascunho desta tela — SEM efeito nenhum
// enquanto não clicar "✓ Salvar Configurações" (mesmo padrão de
// paletes-config.js/"Definir Paletes": um rascunho local, só vira valor
// de verdade no cfgSalvar()).
//
// Isso é DIFERENTE de "Definir Paletes" (paletes-config.js): aquela tela
// decide qual PALETE recebe cada quadrante da bateria (direito/esquerdo ×
// 1ª/2ª metade); esta decide só a POSIÇÃO NA TELA de cada palete — pura
// disposição visual, sem nenhum efeito sobre qual berço enche qual
// palete. As duas configurações vivem juntas na mesma aba "Paletes" só
// por afinidade de assunto pro usuário, não por dependência técnica.
//
// Persistido em config.json (chave "paletesOrdem" — ver LW.PALETES_ORDEM,
// data.js) junto com "paletes": poColetarValores() é chamada por
// cfgSalvar() (app-core.js), mesmo botão "✓ Salvar Configurações" de
// sempre.
//
// Funções globais (mesmo padrão do resto do projeto — scripts sem
// módulo, tudo no mesmo escopo da página), chamadas via onclick="..." no
// HTML gerado abaixo e de dentro de app-core.js (cfgRenderTudo/cfgSalvar).

let _poRascunho = null; // {stack1, stack2, stack3, stack4} -> posição (1-4) — null até a 1ª renderização depois de abrir Configurações

// Mesmas 4 cores de paletes-config.js (PC_CORES_PALETE) — reaproveitadas
// aqui só por consistência visual entre as duas seções da mesma aba.
const PO_CORES_PALETE = { 1: '#66bb6a', 2: '#42a5f5', 3: '#ab47bc', 4: '#ffa726' };

// Chamada de dentro de cfgRenderTudo() (app-core.js) toda vez que
// Configurações é (re)desenhada. `primeiraVez` (ver abrirConfig(), que
// zera _poRascunho ao reabrir Configurações) decide se a grade volta a
// refletir o que está salvo (LW.PALETES_ORDEM) ou mantém o que o
// Administrador já reorganizou nesta sessão do modal, mesmo sem ter
// salvo ainda.
function poRenderTudo() {
  const primeiraVez = !_poRascunho;
  if (primeiraVez) {
    _poRascunho = { ...(LW.PALETES_ORDEM || LW.PALETES_ORDEM_DEFAULT) };
  }
  _poRenderGrid();
}

// Grade 2x2 — mesmo mecanismo visual que existia na tela do Setor de
// Qualidade antes de virar configurável aqui (CSS `order` por posição),
// só que soltar um sobre o outro troca o RASCUNHO desta tela, não a
// tela de verdade.
function _poRenderGrid() {
  const el = document.getElementById('po-grid');
  if (!el || !_poRascunho) return;
  el.innerHTML = [1, 2, 3, 4].map(n => {
    const sid = 'stack' + n;
    const cor = PO_CORES_PALETE[n];
    return `
      <div class="po-pallet-col" data-pallet-id="${sid}" style="order:${_poRascunho[sid]}"
        ondragover="poPermitirDrop(event)"
        ondrop="poSoltar(event,'${sid}')"
        ondragenter="this.classList.add('po-pallet-col-dragover')"
        ondragleave="this.classList.remove('po-pallet-col-dragover')">
        <span class="po-pallet-label" draggable="true" title="Arraste para trocar de lugar com outro palete"
          ondragstart="poIniciarArrastar(event,'${sid}')" style="border-color:${cor};color:${cor}">PALETE ${n}</span>
      </div>`;
  }).join('');
}

// Usa um tipo de dataTransfer PRÓPRIO ('application/x-lw-pallet-ordem'),
// diferente do usado pelo drag de placa individual no Setor de
// Qualidade — não tem por que colidir (telas diferentes), mas mantém o
// mesmo cuidado de sempre com tipos próprios por drag.
function poIniciarArrastar(e, sid) {
  e.dataTransfer.setData('application/x-lw-pallet-ordem', sid);
  e.dataTransfer.effectAllowed = 'move';
}

function poPermitirDrop(e) {
  if (Array.from(e.dataTransfer.types || []).includes('application/x-lw-pallet-ordem')) {
    e.preventDefault(); // necessário pro navegador permitir soltar aqui
  }
}

// Troca a POSIÇÃO dos dois pallets envolvidos — direto no style.order dos
// elementos que JÁ EXISTEM no DOM (igual a _trocarPosicaoVisualPallets,
// que existia no Setor de Qualidade antes desta config existir — ver
// histórico). NUNCA reconstrói a grade inteira (innerHTML) aqui: fazer
// isso no meio de um 'drop' apaga o próprio elemento <span> que estava
// sendo arrastado ANTES do navegador disparar 'dragend' nele — o
// navegador nunca recebe esse aviso de "acabou o arrastar" e fica com o
// estado interno de drag-and-drop travado (é o bug real, visto na
// prática: depois de soltar, o clique parece "grudado"/travado até
// recarregar a página). Só o _poRenderGrid() inicial (poRenderTudo,
// fora de qualquer drag em andamento) pode reconstruir a grade inteira.
function poSoltar(e, destSid) {
  e.preventDefault();
  e.currentTarget?.classList.remove('po-pallet-col-dragover');
  const origemSid = e.dataTransfer.getData('application/x-lw-pallet-ordem');
  if (!origemSid || origemSid === destSid || !_poRascunho) return;

  const colOrigem = document.querySelector(`.po-pallet-col[data-pallet-id="${origemSid}"]`);
  const colDest = document.querySelector(`.po-pallet-col[data-pallet-id="${destSid}"]`);
  if (!colOrigem || !colDest) return;

  const posOrigem = _poRascunho[origemSid];
  const posDest = _poRascunho[destSid];
  _poRascunho[origemSid] = posDest;
  _poRascunho[destSid] = posOrigem;
  colOrigem.style.order = String(posDest);
  colDest.style.order = String(posOrigem);
}

// Chamada por cfgSalvar() (app-core.js) — devolve o rascunho validado
// pra entrar no payload de POST /salvar-config, ou lança erro
// (cfgSalvar mostra como alerta e CANCELA o salvamento inteiro) se as 4
// posições não formarem uma permutação válida.
function poColetarValores() {
  if (!_poRascunho) return null;
  if (!LW.paletesOrdemValida(_poRascunho)) {
    throw new Error('cada palete precisa ocupar exatamente 1 posição (confira se não sobrou nenhum arrastar pela metade).');
  }
  return { ..._poRascunho };
}