# Guia de commits — como aplicar essas mudanças em partes

Este pacote junta várias tarefas feitas em sequência numa mesma conversa.
Em vez de um commit gigante só, aqui está uma sugestão de 9 passos, cada um
autocontido e testável sozinho (`npm test` deve passar 40/40 em qualquer
ponto desta sequência).

**Limitação importante**: alguns arquivos (`server.js`, `public/js/app-core.js`,
`public/js/data.js`, `public/index.template.html`) foram tocados por VÁRIAS
tarefas em sequência — o Git rastreia mudanças por arquivo inteiro, não por
"pedaço de funcionalidade", então o diff completo desses arquivos só pode
entrar num commit de cada vez. Cada um deles está listado no passo onde a
maior parte do seu conteúdo novo se encaixa; se quiser separação cirúrgica
por trecho, use `git add -p <arquivo>` naquele passo (interativo, escolhe
hunk por hunk) em vez de `git add <arquivo>`.

Rode `npm test` depois de cada passo antes de seguir pro próximo.

---

## 1. Corrigir a suíte de testes

Um arquivo de apoio dos testes (`setor-qualidade-dom.js`) estava commitado
no lugar errado (`public/js/` em vez de `test/helpers/`) — por isso 4 dos
15 testes falhavam. Correção pura, sem mudança de comportamento.

```bash
git add test/helpers/setor-qualidade-dom.js
git commit -m "test: mover setor-qualidade-dom.js para test/helpers/ (corrige 4 testes quebrados)"
```

## 2. Escape de HTML central nos pontos de risco

Aplica a função de escape já existente (`LW.escaparHtml`) nos pontos onde
texto livre digitado pelo Administrador (ID de Bateria, Tipo de Montagem)
entrava em `innerHTML` sem passar por ela.

```bash
git add public/js/bateria-atual.js public/js/dashboard.js public/js/debriefing.js public/js/relatorio-bercos.js public/js/setor-qualidade.js
git commit -m "fix(seguranca): escapar HTML em pontos onde faltava (id_bateria/tipo_montagem)"
```

## 3. Modo TV (painel para telão da fábrica)

Página standalone, fora da SPA principal, sem exigir login.

```bash
git add public/tv.html public/css/tv.css public/js/tv.js public/partials/page-menu.html
git commit -m "feat: Modo TV — painel fullscreen para telão da fábrica"
```

## 4. Rastreabilidade (busca + cadeia de reaproveitamento de traço)

Estende a Análise Focada existente: busca por ID de Bateria/Operação/Traço,
origem e reaproveitamentos futuros de um traço, paradas na janela da
operação.

```bash
git add public/js/analise-focada.js public/partials/page-analise-focada.html public/partials/nav-sidebar.html
git commit -m "feat: Rastreabilidade — busca e cadeia de reaproveitamento de traço"
```

## 5. Página de Metas

Progresso do mês (traços/m²/OEE) contra metas definidas pelo Administrador.
Inclui as rotas de backend (`/salvar-metas`) e a entrada no Backup de Dados.

```bash
git add public/js/metas.js public/partials/page-metas.html public/db/metas.json public/js/keyboard-shortcuts.js
git commit -m "feat: Página de Metas — progresso de traços/m²/OEE do mês"
```

## 6. PWA (manifest + service worker)

Permite instalar o app como PWA num tablet. O service worker cobre só a
casca estática (HTML/CSS/JS/ícones) — nunca dado de produção.

```bash
git add public/manifest.json public/service-worker.js public/js/pwa-register.js public/icons/ public/login.html
git commit -m "feat: suporte a PWA (manifest + service worker da casca estática)"
```

## 7. Autenticação unificada + Identidade Leve de Operador

Duas peças que saíram juntas: (a) sessão de Administrador estendida pra
6 rotas que não tinham proteção nenhuma antes (`salvar-config`,
`backup-geral`, importação, etc.); (b) cadastro opcional de operador com
PIN, puramente pra rótulo de auditoria (`operador_nome`) em operações e
paradas.

```bash
git add db.js lib/auth.js public/js/operador.js public/js/operacao.js public/js/paradas.js public/partials/modal-config.html public/partials/nav-topbar.html
git commit -m "feat(seguranca): unificar sessão de admin + Identidade Leve de Operador"
```

## 8. Fatiamento de server.js (lib/rotas/)

O maior arquivo do backend (3.607 linhas, ~60 rotas, tudo numa função só)
começou a ser fatiado em módulos por domínio. 11 fases completas até agora
(9 delas nesta rodada) — ver `README.md` → "Fatiamento de server.js" pra
tabela completa. `server.js` caiu pra ~2.450 linhas.

Este passo é o que efetivamente aplica `server.js`, `public/js/app-core.js`,
`public/js/data.js` e `public/index.template.html` — o estado final deles já
inclui tudo dos passos 1–7 (rotas novas, sessão unificada, etc.), então esse
commit é grande por natureza. Se quiser separar o fatiamento em si das
mudanças de funcionalidade destes 4 arquivos, use `git add -p` nos 4.

```bash
git add server.js lib/rotas/ public/js/app-core.js public/js/data.js public/index.template.html public/index.html
git commit -m "refactor: fatiar server.js em lib/rotas/ (11 fases — ver README)"
```

## 9. Documentação

```bash
git add README.md
git commit -m "docs: atualizar README (fatiamento de server.js, sessão unificada, páginas novas)"
```

---

## Se preferir um commit só

```bash
git add -A
git commit -m "feat: Modo TV, Rastreabilidade, Metas, PWA, auth unificada, Identidade de Operador, fatiamento de server.js"
```

## Verificação antes de subir pra produção

```bash
npm install
npm run build   # gera public/index.html a partir dos partials
npm test        # espera 40/40
```

`data/`, `private/`, `logs/`, `backups-*/` e `node_modules/` não vêm neste
pacote (são gerados/gitignored) — o primeiro `npm start` recria o que for
preciso.
