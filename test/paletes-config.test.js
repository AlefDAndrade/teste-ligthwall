// ─── test/paletes-config.test.js ────────────────────────────────────────────
// Testa "Definir Paletes" (Configurações → Bateria e Montagem — ver
// public/js/paletes-config.js, LW.PALETES_CONFIG em data.js,
// _paletePorMetadeELado em setor-qualidade.js): 4 selects, um por quadrante
// (metade da bateria × lado do berço), cada um escolhendo qual dos 4
// paletes-base recebe aquele quadrante — com prévia visual ao vivo e
// validação de permutação (cada palete usado exatamente 1 vez).
//
// Mesmo padrão de test/perfis-customizados-modal.test.js: servidor HTTP
// real + Admin Master autenticado de verdade (a escrita em /salvar-config
// exige sessão de admin) + AdminAuth.abrirModal() stubado pra não travar
// esperando senha digitada manualmente.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { iniciarServidorDeTeste } = require('./helpers/servidor-teste.js');

const SENHA_ADMIN = 'senha-admin-paletes-config-951';
const HASH_ADMIN = crypto.createHash('sha256').update(SENHA_ADMIN, 'utf8').digest('hex');

let servidor;
let dom;
let window;

before(async () => {
  servidor = await iniciarServidorDeTeste({
    seedSecurityJson: { passwordHash: HASH_ADMIN, recoveryKeyHash: null },
  });
  const respAdmin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  const cookieAdmin = (respAdmin.headers.get('set-cookie') || '').split(';')[0];

  dom = await JSDOM.fromURL(servidor.baseUrl + '/index.html', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.Element.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        const headers = { ...(opts && opts.headers), Cookie: cookieAdmin };
        return fetch(absoluta, { ...opts, headers });
      };
    },
  });
  window = dom.window;
  window.sessionStorage.setItem('lw_role', 'Administrador');
  await new Promise(r => setTimeout(r, 2500));
  window.eval('AdminAuth.abrirModal = function(onSuccess) { if (onSuccess) onSuccess(); };');
});

after(async () => {
  if (dom && dom.window) dom.window.close();
  await servidor.parar();
});

test('LW.PALETES_CONFIG nasce com o default (config.json ainda sem a chave "paletes")', () => {
  const cfg = window.eval('LW.PALETES_CONFIG');
  const def = window.eval('LW.PALETES_CONFIG_DEFAULT');
  assert.deepEqual(cfg, def, 'sem "paletes" em config.json, deveria estar usando o default');
  // Permutação válida: os 4 valores são 1,2,3,4 em alguma ordem.
  const valores = [cfg.direitoPrimeira, cfg.direitoSegunda, cfg.esquerdoPrimeira, cfg.esquerdoSegunda];
  assert.deepEqual([...valores].sort(), [1, 2, 3, 4]);
});

test('abrir Configurações renderiza os 4 selects já com o valor do default selecionado', async () => {
  window.abrirConfig();
  await new Promise(r => setTimeout(r, 200));

  const def = window.eval('LW.PALETES_CONFIG_DEFAULT');
  const idsQuadrantes = ['direitoPrimeira', 'direitoSegunda', 'esquerdoPrimeira', 'esquerdoSegunda'];
  idsQuadrantes.forEach(chave => {
    const sel = window.document.getElementById('pc-select-' + chave);
    assert.ok(sel, `select pc-select-${chave} deveria existir`);
    assert.equal(sel.options.length, 4, 'cada select deveria ter as 4 opções de palete');
    assert.equal(sel.value, String(def[chave]), `select ${chave} deveria começar no valor default`);
  });
});

test('prévia visual mostra a quantidade certa de berços e os rótulos P{n} certos por quadrante', async () => {
  const def = window.eval('LW.PALETES_CONFIG_DEFAULT');
  const capAtiva = window.eval('_pcAbaDimensaoAtiva');
  assert.ok(capAtiva, 'deveria ter uma dimensão ativa na prévia (pelo menos 1 bateria cadastrada)');

  const celulas = window.document.querySelectorAll('#pc-preview .ba-celula');
  assert.equal(celulas.length, capAtiva, `deveria ter ${capAtiva} células, uma por berço`);

  // 1ª célula do DOM = berço 1 (1ª metade) — ver _pcRenderPreviewAtual,
  // for (berco=1..cap) em ordem de inserção (o CSS .ba-grid é quem
  // inverte visualmente com row-reverse, não a ordem no DOM).
  const primeiraCelula = celulas[0];
  const spans = primeiraCelula.querySelectorAll('span');
  // spans[0] = palete do lado Direito, spans[1] = número do berço, spans[2] = palete do lado Esquerdo.
  assert.equal(spans[0].textContent, `P${def.direitoPrimeira}`);
  assert.equal(spans[2].textContent, `P${def.esquerdoPrimeira}`);
});

test('marcar dois quadrantes com o mesmo palete mostra erro e NÃO atualiza o rascunho', async () => {
  const def = window.eval('LW.PALETES_CONFIG_DEFAULT');
  const selDireitoPrimeira = window.document.getElementById('pc-select-direitoPrimeira');
  const selDireitoSegunda = window.document.getElementById('pc-select-direitoSegunda');

  // Força os dois pro MESMO palete (duplicado) — inválido.
  selDireitoSegunda.value = selDireitoPrimeira.value;
  window.pcAoMudarSelect();

  const erroEl = window.document.getElementById('pc-erro');
  assert.equal(erroEl.style.display, 'block', 'deveria mostrar o erro de permutação inválida');

  // Rascunho interno não deveria ter mudado (continua o default válido).
  const rascunho = window.eval('_pcRascunho');
  assert.deepEqual(rascunho, def, 'rascunho não deveria aceitar a mudança inválida');

  // Desfaz pra não vazar estado inválido pros próximos testes.
  selDireitoSegunda.value = String(def.direitoSegunda);
  window.pcAoMudarSelect();
});

test('trocar pra uma permutação NOVA e válida, salvar, e ver refletido em config.json de verdade', async () => {
  // Nova permutação: inverte tudo (direito<->esquerdo) em relação ao default.
  const def = window.eval('LW.PALETES_CONFIG_DEFAULT');
  const nova = {
    direitoPrimeira: def.esquerdoPrimeira,
    direitoSegunda: def.esquerdoSegunda,
    esquerdoPrimeira: def.direitoPrimeira,
    esquerdoSegunda: def.direitoSegunda,
  };

  Object.entries(nova).forEach(([chave, valor]) => {
    window.document.getElementById('pc-select-' + chave).value = String(valor);
  });
  window.pcAoMudarSelect();

  const erroEl = window.document.getElementById('pc-erro');
  assert.equal(erroEl.style.display, 'none', 'permutação nova deveria ser válida (só trocou os lados)');

  const promessaSalvar = window.cfgSalvar();
  // cfgSalvar() mostra um alerta de sucesso que espera um clique real
  // (LW.mostrarAlerta, data.js) antes de continuar pro reload — sem
  // ninguém clicando, a Promise nunca resolveria. Espera o modal
  // aparecer e clica no "OK" programaticamente, só DEPOIS aguarda a
  // Promise de cfgSalvar() terminar.
  await new Promise(r => setTimeout(r, 400));
  const btnOk = window.document.getElementById('btn-alerta-ok');
  if (btnOk) btnOk.click();
  await promessaSalvar;
  await new Promise(r => setTimeout(r, 300));

  const resp = await fetch(`${servidor.baseUrl}/db/config.json`);
  const cfgSalvo = await resp.json();
  assert.deepEqual(cfgSalvo.paletes, nova, 'config.json deveria ter persistido a nova permutação de paletes');

  // Nada de baterias/tipos_montagem deveria ter sumido (mesmo raciocínio
  // do `...cfgAtual` em cfgSalvar, app-core.js) — só "paletes" mudou.
  assert.ok(Array.isArray(cfgSalvo.baterias?.ids) && cfgSalvo.baterias.ids.length > 0, 'baterias não deveriam ter sido apagadas ao salvar paletes');
});

test('depois de recarregar a página, LW.PALETES_CONFIG reflete o que foi salvo (round-trip real)', async () => {
  const cfgEsperado = (await (await fetch(`${servidor.baseUrl}/db/config.json`)).json()).paletes;

  const cookieAdmin2 = window.document.cookie; // não usado diretamente — novo dom pega cookie via closure abaixo
  const respAdmin = await fetch(`${servidor.baseUrl}/verificar-senha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha: SENHA_ADMIN }),
  });
  const cookie = (respAdmin.headers.get('set-cookie') || '').split(';')[0];

  const dom2 = await JSDOM.fromURL(servidor.baseUrl + '/index.html', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.Chart = function () { this.destroy = () => {}; };
      win.Element.prototype.scrollIntoView = function () {};
      win.fetch = (url, opts) => {
        const absoluta = new URL(url, win.location.href).toString();
        const headers = { ...(opts && opts.headers), Cookie: cookie };
        return fetch(absoluta, { ...opts, headers });
      };
    },
  });
  dom2.window.sessionStorage.setItem('lw_role', 'Administrador');
  await new Promise(r => setTimeout(r, 2500));

  try {
    const cfgCarregado = dom2.window.eval('LW.PALETES_CONFIG');
    // JSON.stringify em vez de assert.deepEqual: os dois objetos vêm de
    // REALMS jsdom diferentes (dom vs dom2, cada um com seu próprio
    // Object.prototype) — estrutural e valorativamente idênticos, mas
    // assert.deepEqual pode acusar diferença só por isso; comparar como
    // string evita esse falso-negativo específico de cross-realm.
    assert.equal(JSON.stringify(cfgCarregado), JSON.stringify(cfgEsperado));
  } finally {
    dom2.window.close();
  }
});

test('LW.paletesConfigValida rejeita objetos que não são permutação válida', () => {
  const valida1 = window.eval("LW.paletesConfigValida({direitoPrimeira:1,direitoSegunda:2,esquerdoPrimeira:3,esquerdoSegunda:4})");
  assert.equal(valida1, true);

  const duplicado = window.eval("LW.paletesConfigValida({direitoPrimeira:1,direitoSegunda:1,esquerdoPrimeira:3,esquerdoSegunda:4})");
  assert.equal(duplicado, false, 'dois quadrantes com o mesmo palete deveria ser inválido');

  const foraDoRange = window.eval("LW.paletesConfigValida({direitoPrimeira:0,direitoSegunda:2,esquerdoPrimeira:3,esquerdoSegunda:4})");
  assert.equal(foraDoRange, false, 'palete fora de 1-4 deveria ser inválido');

  const incompleto = window.eval("LW.paletesConfigValida({direitoPrimeira:1,direitoSegunda:2,esquerdoPrimeira:3})");
  assert.equal(incompleto, false, 'faltando um quadrante deveria ser inválido');

  const nulo = window.eval("LW.paletesConfigValida(null)");
  assert.equal(nulo, false);
});
