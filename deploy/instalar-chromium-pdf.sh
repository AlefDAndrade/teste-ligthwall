#!/usr/bin/env bash
# ─── deploy/instalar-chromium-pdf.sh ───────────────────────────────────────
# Instala um Chromium standalone pra viabilizar a "Exportação em PDF" (botão
# 📕 Exportar PDF, ao lado do 🌐 Exportar Interativo, nos dashboards) — ver
# lib/rotas/exportar-pdf.js. Essa rota usa `puppeteer-core` (pacote NPM sem
# Chromium embutido, de propósito: baixar o Chromium do Puppeteer completo
# custa ~300MB no `npm install`, o que é lento/instável em VMs enxutas) — em
# vez disso, o Chromium é baixado por ESTE script, sob demanda.
#
# POR QUE NÃO `apt-get install chromium`: em Ubuntu 22.04+/24.04 o pacote
# "chromium" do apt é só um STUB que delega pro snap. O binário resultante
# (`/usr/bin/chromium` ou `/usr/bin/chromium-browser`) recusa iniciar fora
# de um cgroup do snap — e se o Lightwall roda via PM2/systemd (o caso mais
# comum aqui), o processo Node não está nesse cgroup, e você cai no erro:
#   "cannot start document portal ... is not a snap cgroup for tag
#   snap.chromium.chromium"
# Isso NÃO é um problema de configuração — é assim que o pacote apt funciona
# nessas versões do Ubuntu. Por isso este script não usa apt: ele baixa um
# Chromium/Chrome "for Testing" standalone (o mesmo tipo de build que o
# Puppeteer usa e testa oficialmente), sem depender de snap nem de root.
#
# USO (na própria VM, via SSH, de DENTRO da pasta do projeto):
#   bash deploy/instalar-chromium-pdf.sh
#
# Baixa o Chromium pra ./.chromium-pdf (dentro do próprio projeto, fora do
# controle de versão — ver .gitignore) e imprime o caminho exato do
# executável no final. Depois de rodar, defina PUPPETEER_EXECUTABLE_PATH
# com esse caminho (no ecosystem.config.js do PM2, ou na env do systemd) e
# reinicie o processo do Node — ver instruções impressas no final.
#
# Se preferir apontar pra um Chrome/Chromium já instalado por outro meio,
# não precisa rodar este script: só defina PUPPETEER_EXECUTABLE_PATH
# apontando pro executável (ver lib/rotas/exportar-pdf.js,
# _encontrarExecutavelChromium — ela lê essa variável primeiro, antes de
# tentar os caminhos padrão do sistema).

set -euo pipefail

DIR_PROJETO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR_INSTALACAO="$DIR_PROJETO/.chromium-pdf"
CLI_BROWSERS="$DIR_PROJETO/node_modules/.bin/browsers"

if [ ! -x "$CLI_BROWSERS" ]; then
  echo "❌ Não encontrei $CLI_BROWSERS" >&2
  echo "   Rode 'npm install' na raiz do projeto primeiro (o instalador" >&2
  echo "   usa o pacote @puppeteer/browsers, que já vem como dependência" >&2
  echo "   transitiva do puppeteer-core)." >&2
  exit 1
fi

echo "→ Baixando Chrome for Testing (build estável) em $DIR_INSTALACAO ..."
echo "  (isso baixa ~150-200MB — pode demorar dependendo da rede da VM)"
echo

SAIDA="$("$CLI_BROWSERS" install chrome@stable --path "$DIR_INSTALACAO")"
echo "$SAIDA"

# A saída do comando é no formato "chrome@<buildId> <caminho-do-executavel>"
EXECUTAVEL="$(echo "$SAIDA" | awk '{print $2}' | tail -1)"

if [ -z "$EXECUTAVEL" ] || [ ! -x "$EXECUTAVEL" ]; then
  echo "❌ Não consegui identificar o executável instalado a partir da saída acima." >&2
  echo "   Confira manualmente dentro de: $DIR_INSTALACAO" >&2
  exit 1
fi

echo
echo "✅ Chrome instalado em:"
echo "   $EXECUTAVEL"
echo
echo "→ PRÓXIMO PASSO: defina PUPPETEER_EXECUTABLE_PATH com esse caminho."
echo
echo "  Se o Lightwall roda via PM2 a partir de um *.config.js (ver"
echo "  deploy/ecosystem.config.js), adicione dentro de 'env':"
echo
echo "    PUPPETEER_EXECUTABLE_PATH: '$EXECUTAVEL'"
echo
echo "  e recrie o processo (PM2 não atualiza env só com 'pm2 restart'):"
echo "    pm2 delete testes && pm2 start deploy/producao.config.js && pm2 save"
echo
echo "  Se o Lightwall roda via systemd direto (ex.: pm2-<usuario>.service"
echo "  gerado por 'pm2 startup'), edite a unit (systemctl edit --full"
echo "  <nome-do-servico>) e adicione uma linha, antes de ExecStart:"
echo "    Environment=PUPPETEER_EXECUTABLE_PATH=$EXECUTAVEL"
echo "  depois:"
echo "    systemctl daemon-reload && systemctl restart <nome-do-servico>"
echo
echo "→ Depois de reiniciar, confirme com:"
echo "    pm2 env testes | grep PUPPETEER   (se for PM2)"
echo "  e teste o botão 📕 Exportar PDF num dashboard."
