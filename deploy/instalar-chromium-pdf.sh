#!/usr/bin/env bash
# ─── deploy/instalar-chromium-pdf.sh ───────────────────────────────────────
# Instala o Chromium no sistema (via apt) pra viabilizar a "Exportação em
# PDF" (botão 📕 Exportar PDF, ao lado do 🌐 Exportar Interativo, nos
# dashboards) — ver lib/rotas/exportar-pdf.js. Essa rota usa `puppeteer-core`
# (pacote NPM sem Chromium embutido, de propósito: baixar o Chromium do
# Puppeteer completo custa ~300MB via storage.googleapis.com no `npm
# install`, o que é lento/instável em VMs enxutas ou com rede restrita) — em
# vez disso, o Chromium vem do PRÓPRIO sistema operacional, instalado por
# este script.
#
# USO (na própria VM, via SSH, com sudo):
#   sudo bash deploy/instalar-chromium-pdf.sh
#
# Depois de rodar, reinicie o processo do Node (systemctl restart <serviço>,
# ou pm2 restart, dependendo de como o Lightwall está rodando) pra rota
# passar a encontrar o executável.
#
# Se o Chromium for instalado em outro caminho (ex.: distro diferente,
# instalação manual), não precisa editar este script nem o código — só
# defina a variável de ambiente PUPPETEER_EXECUTABLE_PATH apontando pro
# executável, antes de iniciar o Node (ver lib/rotas/exportar-pdf.js,
# _encontrarExecutavelChromium — ela lê essa variável primeiro).

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Rode como root/sudo: sudo bash deploy/instalar-chromium-pdf.sh" >&2
  exit 1
fi

echo "→ Atualizando lista de pacotes..."
apt-get update -qq

echo "→ Instalando Chromium..."
# "chromium" é o nome do pacote nas distros Debian/Ubuntu recentes;
# "chromium-browser" era o nome em versões mais antigas do Ubuntu (mantido
# como alternativa — apt escolhe o que existir no repositório desta VM).
apt-get install -y -qq chromium || apt-get install -y -qq chromium-browser

echo
echo "✅ Chromium instalado. Confira o caminho com:"
echo "   which chromium || which chromium-browser"
echo
echo "→ Reinicie o processo do Node (systemctl restart <serviço> ou"
echo "   equivalente) pra Exportação em PDF passar a funcionar."
