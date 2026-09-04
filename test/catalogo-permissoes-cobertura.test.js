// ─── test/catalogo-permissoes-cobertura.test.js ─────────────────────────────
// Auditoria pedida numa conversa: "nesse 'criar um novo tipo de perfil'
// tem todo o sistema e acessos para cada página, mas existem novas pages e
// funcionalidades que ainda não estão lá".
//
// O sistema de permissão tem TRÊS listas que precisam andar juntas, e nada
// as obrigava a isso — por isso elas dessincronizaram silenciosamente:
//
//   1. CATALOGO (lib/itens-permissao.js) — o que aparece no formulário de
//      "+ Criar novo tipo de perfil". É a ÚNICA fonte de páginas de um
//      perfil CUSTOMIZADO (ver paginasPermitidas, lib/perfis-customizados.js).
//   2. PAGINAS_DE_TRABALHO / ABAS_CONFIG_ADMIN (lib/perfis.js) — o que os
//      6 perfis FIXOS enxergam (lista hardcoded, à parte do catálogo).
//   3. Os `data-page` de verdade nos partials — o que o front esconde/
//      mostra (_aplicarVisibilidadeDoMenu, public/js/app-core.js).
//
// Bugs que esta auditoria encontrou (todos corrigidos, travados abaixo):
//   - 'tracos-descartados', 'one-page-report', 'config-paletes' e
//     'config-notificacoes' existiam em (2) e (3) mas NÃO em (1) — um
//     perfil customizado nunca conseguia ver essas telas, e não havia como
//     liberar (não apareciam no formulário pra serem marcadas).
//   - 'qualidade-tracos' (CEP), 'consulta-tracos' e 'tv' existiam em (1) e
//     (3) mas NÃO em (2) — TODO perfil fixo cadastrado (inclusive
//     "Administrativo") tinha essas telas escondidas do menu e showPage()
//     recusava navegar até elas; só o Administrador MASTER enxergava.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const itensPermissao = require('../lib/itens-permissao.js');
const perfis = require('../lib/perfis.js');

const RAIZ = path.join(__dirname, '..');
const IDS_CATALOGO = new Set(itensPermissao.CATALOGO.map(i => i.id));

/** Todo `data-page="..."` usado nos partials — o que o front de fato
 * esconde/mostra por permissão. 'menu' fica de fora: é sempre visível a
 * todo mundo, incondicional (ver _paginaPermitida, app-core.js). */
function dataPagesDosPartials() {
  const dir = path.join(RAIZ, 'public/partials');
  const paginas = new Set();
  for (const arquivo of fs.readdirSync(dir)) {
    if (!arquivo.endsWith('.html')) continue;
    const html = fs.readFileSync(path.join(dir, arquivo), 'utf8');
    for (const m of html.matchAll(/data-page="([a-z-]+)"/g)) paginas.add(m[1]);
  }
  paginas.delete('menu');
  return paginas;
}

function abasConfigDoAdministrativo() {
  return perfis.PAGINAS_POR_PERFIL.Administrativo.filter(p => p.startsWith('config-'));
}

test('toda página/aba que os perfis FIXOS enxergam também existe no CATALOGO (senão perfil customizado nunca consegue liberar)', () => {
  const dosFixos = [...perfis.PAGINAS_DE_TRABALHO, ...abasConfigDoAdministrativo()]
    .filter(p => p !== 'menu');
  const ausentes = dosFixos.filter(p => !IDS_CATALOGO.has(p));
  assert.deepEqual(ausentes, [], `estes itens existem pros perfis fixos mas faltam no catálogo — um perfil customizado nunca poderia vê-los: ${ausentes.join(', ')}`);
});

test('toda tela com data-page nos partials é enxergável por algum perfil FIXO (senão fica escondida de todo usuário cadastrado)', () => {
  const doFront = dataPagesDosPartials();
  const dosFixos = new Set(perfis.PAGINAS_DE_TRABALHO);
  const invisiveis = [...doFront].filter(p => !dosFixos.has(p));
  assert.deepEqual(invisiveis, [], `estas telas têm data-page mas nenhum perfil fixo as enxerga (menu esconde + showPage recusa): ${invisiveis.join(', ')}`);
});

test('toda tela com data-page nos partials também está no CATALOGO (perfil customizado consegue liberar)', () => {
  const doFront = dataPagesDosPartials();
  const ausentes = [...doFront].filter(p => !IDS_CATALOGO.has(p));
  assert.deepEqual(ausentes, [], `estas telas têm data-page mas não estão no catálogo de permissões: ${ausentes.join(', ')}`);
});

test('as 4 páginas/abas que faltavam no catálogo (achado da auditoria) agora estão lá', () => {
  for (const id of ['tracos-descartados', 'one-page-report', 'config-paletes', 'config-notificacoes']) {
    assert.ok(IDS_CATALOGO.has(id), `esperava "${id}" no catálogo`);
  }
});

test('as 3 telas que nenhum perfil fixo enxergava (CEP, Consulta de Traços, Modo TV) agora são visíveis', () => {
  for (const pagina of ['qualidade-tracos', 'consulta-tracos', 'tv']) {
    assert.ok(
      perfis.PAGINAS_DE_TRABALHO.includes(pagina),
      `esperava "${pagina}" em PAGINAS_DE_TRABALHO — sem isso fica escondida de TODO perfil cadastrado`
    );
  }
});

test('as abas de Configurações que o front consulta existem todas no catálogo (senão a aba some pra sempre do perfil customizado)', () => {
  // Lista de seções que _cfgAplicarVisibilidadeDeAbas (app-core.js)
  // consulta via _paginaPermitida('config-' + secao) — extraída do
  // próprio código, pra não virar uma segunda lista pra manter à mão.
  const appCore = fs.readFileSync(path.join(RAIZ, 'public/js/app-core.js'), 'utf8');
  const inicio = appCore.indexOf('const MAPA = { dados:');
  assert.ok(inicio >= 0, 'não encontrei o MAPA de abas em _cfgAplicarVisibilidadeDeAbas');
  const bloco = appCore.slice(inicio, appCore.indexOf('};', inicio));
  const secoes = [...bloco.matchAll(/'?([a-z-]+)'?:\s*'cfg-nav-/g)].map(m => m[1]);

  assert.ok(secoes.length >= 13, `esperava ao menos 13 abas mapeadas, achei ${secoes.length}`);
  const ausentes = secoes.filter(s => !IDS_CATALOGO.has('config-' + s));
  assert.deepEqual(ausentes, [], `abas consultadas pelo front sem item correspondente no catálogo: ${ausentes.map(s => 'config-' + s).join(', ')}`);
});

test('permissoesPadraoDoPerfilFixo cobre TODO item do catálogo, sem deixar nenhum indefinido', () => {
  for (const perfilId of perfis.PERFIS_CADASTRAVEIS) {
    const mapa = perfis.permissoesPadraoDoPerfilFixo(perfilId);
    for (const item of itensPermissao.CATALOGO) {
      assert.ok(
        itensPermissao.NIVEIS.includes(mapa[item.id]),
        `perfil "${perfilId}" ficou sem nível válido pro item "${item.id}" (veio: ${mapa[item.id]})`
      );
    }
  }
});

test('padrões dos itens novos batem com a área de edição de cada perfil fixo', () => {
  // Traços Descartados é 'injetora': quem edita essa área começa 'total',
  // o resto 'visualizar' (visualização aberta, nunca 'ocultar').
  assert.equal(perfis.permissoesPadraoDoPerfilFixo('OperadorInjetora')['tracos-descartados'], 'total');
  assert.equal(perfis.permissoesPadraoDoPerfilFixo('AssistenteQualidade')['tracos-descartados'], 'visualizar');

  // One Page Report não tem área de edição (escrita exige sessaoOuAdmin,
  // não uma das 5 áreas) — 'visualizar' pra todo perfil fixo.
  assert.equal(perfis.permissoesPadraoDoPerfilFixo('OperadorInjetora')['one-page-report'], 'visualizar');

  // Abas de Configurações: só "Administrativo" começa com acesso.
  assert.equal(perfis.permissoesPadraoDoPerfilFixo('Administrativo')['config-paletes'], 'total');
  assert.equal(perfis.permissoesPadraoDoPerfilFixo('Administrativo')['config-notificacoes'], 'total');
  assert.equal(perfis.permissoesPadraoDoPerfilFixo('OperadorInjetora')['config-paletes'], 'ocultar');
  assert.equal(perfis.permissoesPadraoDoPerfilFixo('OperadorInjetora')['config-notificacoes'], 'ocultar');
});

test('nenhum item do catálogo tem id duplicado nem rótulo vazio', () => {
  const vistos = new Set();
  for (const item of itensPermissao.CATALOGO) {
    assert.ok(!vistos.has(item.id), `id duplicado no catálogo: "${item.id}"`);
    vistos.add(item.id);
    assert.ok(item.rotulo && item.rotulo.trim(), `item "${item.id}" está sem rótulo`);
    assert.ok(['pagina', 'sub', 'dashboard', 'config', 'acao'].includes(item.tipo), `item "${item.id}" tem tipo inválido: ${item.tipo}`);
  }
});

test('todo item com "pai" aponta pra um item que existe de verdade no catálogo', () => {
  for (const item of itensPermissao.CATALOGO) {
    if (!item.pai) continue;
    assert.ok(IDS_CATALOGO.has(item.pai), `item "${item.id}" tem pai "${item.pai}", que não existe no catálogo`);
  }
});

test('todo item com "area" usa uma das áreas de edição reais do servidor', () => {
  for (const item of itensPermissao.CATALOGO) {
    if (!item.area) continue;
    assert.ok(
      perfis.AREAS_DE_EDICAO.includes(item.area),
      `item "${item.id}" declara area "${item.area}", que não existe em AREAS_DE_EDICAO`
    );
  }
});
