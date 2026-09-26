// ─── public/js/fetch-compartilhado.js ───────────────────────────────────────
// Evita baixar o MESMO arquivo de dados várias vezes seguidas.
//
// Motivo (medido com backup real, setembro/2026): ao abrir uma tela, o
// mesmo JSON era pedido 2–4 vezes — Relatório baixava relatorio_injecao
// 4x, Qualidade dos Traços 5 downloads pra 2 arquivos, Setor de Qualidade
// as avaliações (1,4 MB) 2x. Parte das chamadas sai ao mesmo tempo (duas
// funções de init em paralelo), parte logo em seguida (render → filtros →
// contagem, cada um com seu próprio fetch). Corrigir cada chamador um a um
// seria espalhado e frágil; este arquivo resolve num ponto só, embrulhando
// window.fetch.
//
// Regras:
//   • Só GET das rotas de leitura pesadas (ROTAS, abaixo), mesma origem.
//     Todo o resto passa direto, intocado.
//   • Pedidos iguais (mesma URL, incluindo a query) enquanto um está em
//     andamento compartilham a MESMA resposta; depois que ela chega, fica
//     reaproveitável por JANELA_MS (2 s) — tempo de uma tela terminar de
//     montar, curto demais pra "dado velho" ser perceptível.
//   • QUALQUER escrita (POST/PUT/PATCH/DELETE) feita por esta aba limpa
//     tudo — no início E no fim da escrita. Assim, salvar algo e recarregar
//     a tela sempre busca de novo no servidor.
//   • Respostas de erro (não-2xx) e falhas de rede não são reaproveitadas.
//   • Pedido com AbortSignal passa direto (cancelar um não pode cancelar
//     os outros que estariam compartilhando a mesma resposta).
// Cada chamador recebe um clone próprio da resposta, então .json()/.text()
// funcionam normalmente em todos.

(function (raiz) {
  'use strict';

  const JANELA_MS = 2000;
  const ROTAS = /^\/(db\/(historico|relatorio_injecao|ajustes_tracos|relatorio_bercos|correlacao_traco_berco|bercos_visuais|paradas)\.json|avaliacoes-qualidade|operacoes-nao-avaliadas)$/;

  function criarFetchCompartilhado(fetchOriginal, origem) {
    const cache = new Map(); // chave -> { promessa, expiraEm } (expiraEm 0 = ainda em andamento)
    let geracao = 0;

    function _invalidar() { cache.clear(); geracao++; }

    function _info(input, init) {
      const ehRequest = typeof Request !== 'undefined' && input instanceof Request;
      const metodo = String((init && init.method) || (ehRequest ? input.method : 'GET')).toUpperCase();
      const url = new URL(ehRequest ? input.url : String(input), origem);
      return { metodo, url };
    }

    function fetchCompartilhado(input, init) {
      let info;
      try { info = _info(input, init); } catch (_) { return fetchOriginal(input, init); }

      if (info.metodo !== 'GET' && info.metodo !== 'HEAD') {
        _invalidar();
        const p = fetchOriginal(input, init);
        p.then(_invalidar, _invalidar);
        return p;
      }

      const origemBase = new URL(origem).origin;
      if (info.metodo !== 'GET' || info.url.origin !== origemBase
          || !ROTAS.test(info.url.pathname) || (init && init.signal)) {
        return fetchOriginal(input, init);
      }

      const chave = info.url.pathname + info.url.search;
      const existente = cache.get(chave);
      if (existente && (existente.expiraEm === 0 || existente.expiraEm > Date.now())) {
        return existente.promessa.then(r => r.clone());
      }

      const geracaoNoInicio = geracao;
      const promessa = fetchOriginal(input, init);
      const entrada = { promessa, expiraEm: 0 };
      cache.set(chave, entrada);
      const _remover = () => { if (cache.get(chave) === entrada) cache.delete(chave); };

      promessa.then((resp) => {
        if (!resp.ok || geracaoNoInicio !== geracao) { _remover(); return; }
        entrada.expiraEm = Date.now() + JANELA_MS;
        setTimeout(_remover, JANELA_MS + 50); // não segura a resposta em memória depois da janela
      }, _remover);

      return promessa.then(r => r.clone());
    }

    return { fetchCompartilhado, _tamanhoCache: () => cache.size };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { criarFetchCompartilhado, JANELA_MS };
  }
  if (raiz && typeof raiz.fetch === 'function' && raiz.location && !raiz.__lwFetchCompartilhado) {
    raiz.__lwFetchCompartilhado = true;
    raiz.fetch = criarFetchCompartilhado(raiz.fetch.bind(raiz), raiz.location.href).fetchCompartilhado;
  }
})(typeof window !== 'undefined' ? window : null);
