#!/usr/bin/env bash
# ─── deploy/instalar-https.sh ──────────────────────────────────────────────
# Coloca HTTPS de verdade na frente do Lightwall SC quando a VM não tem
# domínio próprio — só o IP externo (Magalu Cloud, Google Cloud, ou
# qualquer outro provedor — ver detecção de IP, abaixo). Necessário pra
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
#   1. Descobre o IP externo da VM (tenta Magalu Cloud, depois Google
#      Cloud, depois um serviço externo genérico — ver DETECÇÃO DE IP,
#      abaixo; pergunta manualmente se nada funcionar).
#   2. Instala o Caddy (servidor com HTTPS automático embutido).
#   3. Gera /etc/caddy/Caddyfile apontando "SEU-IP.nip.io" -> localhost:PORTA.
#   4. Recarrega o Caddy (ele emite/renova o certificado sozinho, contanto
#      que as portas 80 e 443 estejam liberadas no firewall/security group
#      da VM — ver README.md, seção "HTTPS via Caddy + nip.io").
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

# ── DETECÇÃO DE IP: tenta cada provedor em ordem, fica no primeiro que
# responder. `|| true` em cada tentativa pra `set -e` não matar o script
# se aquele provedor específico não for o certo (ex: rodando na Magalu
# Cloud, a tentativa do Google Cloud simplesmente não responde e passa
# pra próxima, sem erro).
echo "→ Descobrindo o IP externo desta VM..."

IP_EXTERNO=""

# 1) Magalu Cloud — serviço de metadata interno (só responde de DENTRO de
# uma VM da Magalu Cloud; ver docs.magalu.cloud, "Como consultar o IP da
# VM"). Timeout curto (1s) pra não travar em provedores onde esse IP nem
# existe/não responde.
IP_EXTERNO="$(curl -s -m 1 'http://169.254.169.254/latest/meta-data/public-ipv4' || true)"

# 2) Google Cloud — metadata com header próprio do GCP.
if [ -z "$IP_EXTERNO" ]; then
  IP_EXTERNO="$(curl -s -m 1 -H 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' \
    || true)"
fi

# 3) Fallback genérico — funciona em QUALQUER provedor (a própria VM
# pergunta "qual IP o mundo vê quando eu saio pra internet"), útil pra
# VPS/provedores sem serviço de metadata (Oracle Cloud, servidor próprio,
# etc.) — mas exige saída de rede liberada pro serviço externo.
if [ -z "$IP_EXTERNO" ]; then
  IP_EXTERNO="$(curl -s -m 3 'https://ifconfig.me' || true)"
fi
if [ -z "$IP_EXTERNO" ]; then
  IP_EXTERNO="$(curl -s -m 3 'https://icanhazip.com' | tr -d '[:space:]' || true)"
fi

if [ -z "$IP_EXTERNO" ]; then
  echo "⚠️  Não consegui descobrir o IP automaticamente (nenhum dos serviços"
  echo "   de metadata/consulta de IP respondeu). Informe manualmente:"
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
echo "   1. As portas 80 e 443 precisam estar liberadas na VM:"
echo "      - Magalu Cloud: Console → Virtual Machine → sua instância →"
echo "        Segurança/Security Group → adicionar regra de entrada (ingress)"
echo "        TCP 80 e 443, origem 0.0.0.0/0."
echo "      - Google Cloud: Console → VPC network → Firewall → criar/editar"
echo "        regra permitindo tcp:80,443 de 0.0.0.0/0."
echo "   2. Acesse https://${DOMINIO_NIP} — deve aparecer o cadeado."
echo "   3. No app, o sino de notificações (🔔) deve aparecer na topbar agora."
echo "      Cada pessoa precisa clicar em 'Ativar notificações' de novo —"
echo "      tentativas antigas sob HTTP simples nunca existiram de verdade"
echo "      pro navegador."
