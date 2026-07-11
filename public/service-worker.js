// ============================================================
//  LIGHTWALL SC — SISTEMA DE INJEÇÃO
//  service-worker.js — casca estática do PWA
// ============================================================
// Objetivo ÚNICO deste service worker: fazer o APP em si (HTML, CSS, JS,
// ícones, fontes) carregar rápido e sobreviver a uma queda rápida de rede
// no chão de fábrica — nada além disso.
//
// PROPOSITALMENTE não mexe em:
//   - Qualquer coisa em /db/*.json (dado de produção — precisa ser
//     sempre a versão mais nova, nunca uma cópia em cache)
//   - Qualquer requisição POST (registrar operação, salvar config etc.)
//   - O WebSocket de operação ao vivo (upgrade de conexão, nem passa
//     pelo evento 'fetch')
//   - Qualquer rota fora da lista de extensões estáticas abaixo
//
// O app JÁ TEM sua própria resiliência de rede pro que importa de
// verdade — a fila de operações pendentes em localStorage (ver
// "FILA DE OPERAÇÕES PENDENTES", data.js), que guarda um registro
// localmente se a rede cair e tenta de novo quando ela volta. Este
// service worker não duplica nem substitui aquilo: ele só garante que a
// TELA em si (o app shell) ainda abre durante essa queda, pra fila
// continuar visível e utilizável enquanto a rede não volta.
//
// Estratégia pros arquivos estáticos: network-first (tenta a rede
// primeiro, cai pro cache só se a rede falhar) — assim uma atualização
// de código chega pra quem estiver online, e quem cair de rede ainda
// consegue abrir a última versão que já tinha carregado.

'use strict';

const CACHE_VERSAO = 'lightwall-shell-v1';

// Extensões de arquivo ESTÁTICO que este service worker cuida — qualquer
// coisa fora desta lista (incluindo TUDO sob /db/) passa direto pra rede,
// sem nunca ser interceptada.
const EXTENSOES_ESTATICAS = ['.html', '.js', '.css', '.png', '.svg', '.ico', '.json'];
// ATENÇÃO: '.json' está na lista só por causa de manifest.json — a
// exclusão explícita de qualquer coisa sob '/db/' (ver _ehEstatico,
// abaixo) é o que realmente impede um db/*.json de cair no cache.

const PRECACHE_URLS = [
  '/',
  'login.html',
  'index.html',
  'manifest.json',
  'css/styles.css',
  'css/login.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSAO)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .catch((err) => {
        // Não deixa a instalação inteira falhar por causa de 1 arquivo
        // do precache que não carregou agora (ex: 1ª instalação sem
        // rede) — o cache vai sendo preenchido aos poucos pelo próprio
        // 'fetch' (ver abaixo) conforme as páginas forem visitadas.
        console.warn('[SW] Falha ao pré-cachear alguns arquivos:', err);
      })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nomes) =>
      Promise.all(
        nomes
          .filter((nome) => nome !== CACHE_VERSAO)
          .map((nome) => caches.delete(nome))
      )
    ).then(() => self.clients.claim())
  );
});

function _ehEstatico(url) {
  if (url.origin !== self.location.origin) return false; // fontes/CDN externos: deixa o navegador cuidar (têm seu próprio cache HTTP)
  if (url.pathname.startsWith('/db/')) return false;      // NUNCA cachear dado de produção — ver cabeçalho do arquivo
  if (url.pathname.startsWith('/ws/')) return false;       // WebSocket
  if (url.pathname.startsWith('/admin/')) return false;    // rotas administrativas
  return EXTENSOES_ESTATICAS.some((ext) => url.pathname.endsWith(ext)) || url.pathname === '/';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Só GET, só arquivo estático do próprio app — qualquer outra coisa
  // (POST de registro, GET de /db/*.json, WebSocket) passa direto pra
  // rede, sem o service worker nem olhar pra requisição.
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!_ehEstatico(url)) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Só guarda respostas válidas (200) — nunca uma página de erro.
        if (res && res.ok) {
          const copia = res.clone();
          caches.open(CACHE_VERSAO).then((cache) => cache.put(req, copia));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => {
          if (cached) return cached;
          // Sem rede E sem nada em cache pra esta URL — se for navegação
          // (o usuário abrindo o app do zero), tenta cair pro shell
          // principal em vez de mostrar o erro cru do navegador.
          if (req.mode === 'navigate') return caches.match('/');
          return new Response('Offline — este arquivo ainda não foi carregado antes.', { status: 503 });
        })
      )
  );
});
