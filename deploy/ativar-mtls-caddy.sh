#!/usr/bin/env bash
# ─── deploy/ativar-mtls-caddy.sh ────────────────────────────────────────────
# Liga o reconhecimento automático de Certificado de Dispositivo (mTLS
# OPCIONAL) no Caddy que já está na frente do Node (ver
# deploy/instalar-https.sh). Complementa — NÃO substitui — a autorização
# por cookie/IP que já existia: quem tiver um certificado instalado
# (Configurações → Dispositivos Autorizados → "Gerar certificado", ver
# lib/certificado-dispositivo.js) passa a ser reconhecido mesmo depois de
# limpar os dados do navegador; quem não tiver continua acessando
# normalmente pelo HTTPS comum — client_auth em modo "request" (opcional),
# NUNCA "require": ninguém fica bloqueado por não ter certificado.
#
# O QUE ESTE SCRIPT FAZ:
#   1. Copia o certificado PÚBLICO da CA própria do sistema (gerada sozinha
#      pelo Node na primeira emissão de certificado — NUNCA a chave
#      privada, essa não sai de private/ca-dispositivos/) pra onde o Caddy
#      consegue ler.
#   2. Acrescenta ao Caddyfile existente um bloco `tls { client_auth {...} }`
#      (modo opcional) e um `header_up` dentro do reverse_proxy que repassa
#      o número de série do certificado apresentado pro Node via
#      X-Client-Cert-Serial — é esse header que
#      lib/dispositivo-autorizado.js lê pra reconhecer o dispositivo.
#   3. Valida e recarrega o Caddy.
#
# PRÉ-REQUISITOS:
#   - Já ter rodado deploy/instalar-https.sh antes (precisa existir um
#     Caddyfile com HTTPS configurado).
#   - Já ter gerado pelo menos um certificado em Configurações →
#     Dispositivos Autorizados → "Gerar certificado" (é isso que cria a CA
#     própria do sistema, em private/ca-dispositivos/ca-cert.pem — sem
#     isso o arquivo que este script precisa copiar ainda não existe).
#
# USO (na própria VM, via SSH, com sudo, RODANDO NA RAIZ DO PROJETO):
#   sudo bash deploy/ativar-mtls-caddy.sh [porta-do-node]
#   (porta-do-node é opcional, padrão 5000 — mesmo padrão de server.js e
#   de deploy/instalar-https.sh)
#
# REVERSÃO: se quiser desligar depois, edite /etc/caddy/Caddyfile
# removendo o bloco `tls { client_auth { ... } }` e o `header_up
# X-Client-Cert-Serial` que este script adicionou, e recarregue o Caddy
# (sudo systemctl reload caddy). O cookie/IP continuam funcionando
# normalmente o tempo todo, com ou sem isso ligado.

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "Rode como root/sudo: sudo bash deploy/ativar-mtls-caddy.sh" >&2
  exit 1
fi

PORTA_NODE="${1:-5000}"
DIR_PROJETO="$(cd "$(dirname "$0")/.." && pwd)"
CA_CERT_ORIGEM="${DIR_PROJETO}/private/ca-dispositivos/ca-cert.pem"
CA_CERT_DESTINO="/etc/caddy/lightwall-ca-dispositivos.pem"
CADDYFILE="/etc/caddy/Caddyfile"

if [ ! -f "$CA_CERT_ORIGEM" ]; then
  echo "⚠️  Ainda não existe nenhum certificado de dispositivo gerado." >&2
  echo "   Gere o primeiro em Configurações → Dispositivos Autorizados →" >&2
  echo "   'Gerar certificado' antes de rodar este script (é isso que cria" >&2
  echo "   a CA própria do sistema, em ${CA_CERT_ORIGEM})." >&2
  exit 1
fi

if [ ! -f "$CADDYFILE" ]; then
  echo "⚠️  ${CADDYFILE} não existe ainda — rode deploy/instalar-https.sh" >&2
  echo "   primeiro (precisa ter o HTTPS configurado antes de ligar mTLS)." >&2
  exit 1
fi

echo "→ Copiando o certificado público da CA para ${CA_CERT_DESTINO}..."
cp "$CA_CERT_ORIGEM" "$CA_CERT_DESTINO"
chmod 644 "$CA_CERT_DESTINO"

if grep -q "client_auth" "$CADDYFILE"; then
  echo "→ client_auth já está configurado no Caddyfile — nada a fazer aqui."
else
  echo "→ Adicionando client_auth (modo opcional) e header_up ao Caddyfile..."
  # Só sabe editar automaticamente o formato simples gerado por
  # instalar-https.sh (uma linha "reverse_proxy localhost:PORTA", sem bloco
  # próprio — ver deploy/Caddyfile.exemplo). Se o Caddyfile já foi editado à
  # mão de outro jeito, o awk abaixo não encontra o padrão e nada é
  # alterado — o script então cai no aviso mais abaixo com o texto pra
  # colar manualmente.
  awk -v ca="$CA_CERT_DESTINO" -v porta="$PORTA_NODE" '
    /^[[:space:]]*reverse_proxy[[:space:]]+localhost:[0-9]+[[:space:]]*$/ {
      print "    tls {"
      print "        client_auth {"
      print "            mode request"
      print "            trusted_ca_cert_file " ca
      print "        }"
      print "    }"
      print "    reverse_proxy localhost:" porta " {"
      print "        header_up X-Client-Cert-Serial {tls_client_serial}"
      print "    }"
      encontrou = 1
      next
    }
    { print }
    END { if (!encontrou) exit 1 }
  ' "$CADDYFILE" > "${CADDYFILE}.novo" && mv "${CADDYFILE}.novo" "$CADDYFILE" || {
    rm -f "${CADDYFILE}.novo"
    echo "⚠️  Não encontrei o padrão esperado (\"reverse_proxy localhost:PORTA\"" >&2
    echo "   sozinho numa linha) em ${CADDYFILE} — provavelmente foi editado à" >&2
    echo "   mão. Adicione isto dentro do bloco do seu domínio, substituindo" >&2
    echo "   a linha 'reverse_proxy localhost:${PORTA_NODE}' existente:" >&2
    echo >&2
    echo "    tls {" >&2
    echo "        client_auth {" >&2
    echo "            mode request" >&2
    echo "            trusted_ca_cert_file ${CA_CERT_DESTINO}" >&2
    echo "        }" >&2
    echo "    }" >&2
    echo "    reverse_proxy localhost:${PORTA_NODE} {" >&2
    echo "        header_up X-Client-Cert-Serial {tls_client_serial}" >&2
    echo "    }" >&2
    echo >&2
    echo "   Depois: sudo systemctl reload caddy" >&2
    exit 1
  }
fi

echo "→ Validando e recarregando o Caddy..."
caddy validate --config "$CADDYFILE" || { echo "⚠️  Caddyfile inválido — revise antes de recarregar." >&2; exit 1; }
systemctl reload caddy || systemctl restart caddy

echo
echo "✅ Pronto. A partir de agora:"
echo "   - Quem tiver um certificado (.p12) instalado é reconhecido"
echo "     automaticamente, mesmo limpando os dados do navegador."
echo "   - Quem não tiver continua acessando por HTTPS normal, sem exigir"
echo "     nada (modo opcional — client_auth 'request', não 'require')."
echo "   - Novos certificados gerados depois (Configurações → Dispositivos"
echo "     Autorizados) já funcionam na hora — não precisa rodar este"
echo "     script de novo (a CA é a mesma, só o cadastro do serial muda,"
echo "     e isso o Node já grava sozinho)."
