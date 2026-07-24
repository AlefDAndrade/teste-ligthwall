#!/usr/bin/env bash
# ─── deploy/instalar-https.sh ──────────────────────────────────────────────
# Coloca HTTPS de verdade na frente do Lightwall SC quando a VM não tem
# domínio próprio — só o IP externo do Google Cloud. Necessário pra
# Notificações Push funcionarem (a Web Push API do navegador exige HTTPS
# ou localhost; em HTTP simples o navegador nem expõe a API, é por isso
# que o sino de notificações não aparecia — ver README.md, seção
# "Notificações Push").
#
# Usa nip.io: um serviço de DNS público que resolve QUALQUER endereço no
# formato "A-B-C-D.nip.io" pro IP "A.B.C.D" automaticamente — sem cadastro,
# sem custo. Isso é o bastante pro Let's Encrypt (via Caddy) emitir um
# certificado HTTPS válido de verdade, porque tecnicamente é um domínio.
#
# O QUE ESTE SCRIPT FAZ:
#   1. Instala o Caddy (servidor com HTTPS automático embutido).
#   2. Gera /etc/caddy/Caddyfile apontando "SEU-IP.nip.io" -> localhost:PORTA.
#   3. Recarrega o Caddy (ele emite/renova o certificado sozinho, contanto
#      que as portas 80 e 443 estejam liberadas no firewall da VM — ver
#      README.md, seção "Notificações Push", passo do firewall).
#
# USO (na própria VM, via SSH, com sudo):
#   sudo bash deploy/instalar-https.sh [porta-do-node]
#   (porta-do-node é opcional, padrão 5000 — mesmo padrão de server.js)
#
# Depois de rodar, o sistema passa a ser acessado em:
#   https://SEU-IP-COM-HIFENS.nip.io
# em vez de:
#   http://SEU-IP:5000

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Rode como root/sudo: sudo bash deploy/instalar-https.sh" >&2
  exit 1
fi

PORTA_NODE="${1:-5000}"

echo "→ Descobrindo o IP externo desta VM (metadata do Google Cloud)..."
IP_EXTERNO="$(curl -s -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' \
  || true)"

if [ -z "$IP_EXTERNO" ]; then
  echo "⚠️  Não consegui descobrir o IP automaticamente (isso só funciona DENTRO"
  echo "   de uma VM do Google Cloud). Informe manualmente:"
  read -rp "   IP externo desta VM (ex: 34.123.45.67): " IP_EXTERNO
fi

IP_COM_HIFENS="$(echo "$IP_EXTERNO" | tr '.' '-')"
DOMINIO_NIP="${IP_COM_HIFENS}.nip.io"

echo "→ IP externo: $IP_EXTERNO"
echo "→ Domínio que será usado (via nip.io): $DOMINIO_NIP"
echo "→ Porta do Node (Lightwall): $PORTA_NODE"
echo

echo "→ Instalando o Caddy..."
apt-get update -qq
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
apt-get update -qq
apt-get install -y -qq caddy

echo "→ Gerando /etc/caddy/Caddyfile..."
cat > /etc/caddy/Caddyfile <<EOF
${DOMINIO_NIP} {
    reverse_proxy localhost:${PORTA_NODE}
}
EOF

echo "→ Recarregando o Caddy (ele emite o certificado HTTPS sozinho)..."
systemctl reload caddy || systemctl restart caddy

echo
echo "✅ Pronto. Confira:"
echo "   1. As portas 80 e 443 precisam estar liberadas no firewall da VM"
echo "      (Console do Google Cloud → VPC network → Firewall)."
echo "   2. Acesse https://${DOMINIO_NIP} — deve aparecer o cadeado."
echo "   3. No app, o sino de notificações (🔔) deve aparecer na topbar agora."
echo "      Cada pessoa precisa clicar em 'Ativar notificações' de novo —"
echo "      tentativas antigas sob HTTP simples nunca existiram de verdade"
echo "      pro navegador."
