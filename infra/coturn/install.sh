#!/bin/bash
set -euo pipefail

# Ubuntu LTS arm64 — CoTURN + Certbot installation script.
# Reads required values from the environment so the same script can be
# re-run safely.
#
# Required environment:
#   TURN_DOMAIN              e.g. turn.alaobeidat.com
#   TURN_REALM               e.g. alfajer.alaobeidat.com
#   LETSENCRYPT_EMAIL        admin email for ACME registration
#   TURN_STATIC_AUTH_SECRET  shared with the signaling server's .env

: "${TURN_DOMAIN:?TURN_DOMAIN must be set}"
: "${TURN_REALM:?TURN_REALM must be set}"
: "${LETSENCRYPT_EMAIL:?LETSENCRYPT_EMAIL must be set}"
: "${TURN_STATIC_AUTH_SECRET:?TURN_STATIC_AUTH_SECRET must be set}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/turnserver.conf"

if [[ ! -f "${TEMPLATE}" ]]; then
  echo "ERROR: template not found at ${TEMPLATE}"
  exit 1
fi

echo "==> Updating apt and installing coturn + certbot..."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y coturn certbot cron

echo "==> Enabling CoTURN daemon flag in /etc/default/coturn..."
sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/g' /etc/default/coturn
grep -q "^TURNSERVER_ENABLED=1" /etc/default/coturn || echo "TURNSERVER_ENABLED=1" >> /etc/default/coturn

echo "==> Stopping coturn temporarily so certbot can bind :80..."
systemctl stop coturn 2>/dev/null || true

echo "==> Rendering /etc/turnserver.conf from template..."
# Use a literal-safe delimiter (|) because the secret is hex; substitute
# placeholder domain, realm line, and ${TURN_STATIC_AUTH_SECRET} token.
sed \
  -e "s|turn\.alfajer\.example|${TURN_DOMAIN}|g" \
  -e "s|^realm=.*|realm=${TURN_REALM}|" \
  -e "s|^server-name=.*|server-name=${TURN_DOMAIN}|" \
  -e "s|\${TURN_STATIC_AUTH_SECRET}|${TURN_STATIC_AUTH_SECRET}|g" \
  "${TEMPLATE}" > /etc/turnserver.conf
chmod 640 /etc/turnserver.conf
chgrp turnserver /etc/turnserver.conf

echo "==> Provisioning Let's Encrypt cert for ${TURN_DOMAIN}..."
certbot certonly --standalone \
  --non-interactive --agree-tos \
  --email "${LETSENCRYPT_EMAIL}" \
  -d "${TURN_DOMAIN}" \
  --preferred-challenges http \
  --http-01-port 80

echo "==> Granting CoTURN read access to Let's Encrypt cert tree..."
chgrp -R turnserver /etc/letsencrypt/live /etc/letsencrypt/archive
chmod -R g+rX /etc/letsencrypt/live /etc/letsencrypt/archive

echo "==> Installing renewal hook at /etc/letsencrypt/renewal-hooks/deploy/coturn.sh..."
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/coturn.sh <<'HOOK'
#!/bin/bash
set -euo pipefail
chgrp -R turnserver /etc/letsencrypt/live /etc/letsencrypt/archive
chmod -R g+rX /etc/letsencrypt/live /etc/letsencrypt/archive
systemctl restart coturn
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/coturn.sh

echo "==> Starting CoTURN..."
systemctl enable coturn
systemctl restart coturn

sleep 2
if systemctl is-active --quiet coturn; then
  echo
  echo "✓ CoTURN is installed and running"
  echo "  domain : ${TURN_DOMAIN}"
  echo "  realm  : ${TURN_REALM}"
else
  echo "✗ CoTURN failed to start. Recent logs:"
  journalctl -u coturn -n 50 --no-pager
  exit 1
fi
