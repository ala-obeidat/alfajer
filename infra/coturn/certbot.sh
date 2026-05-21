#!/bin/bash
set -euo pipefail

# Certbot renewal hook for CoTURN

DOMAIN="turn.alaobeidat.com"
EMAIL="admin@alaobeidat.com"

echo "Requesting initial certificate for ${DOMAIN}..."
certbot certonly --standalone -d ${DOMAIN} --non-interactive --agree-tos -m ${EMAIL}

echo "Setting permissions for CoTURN to read Let's Encrypt certificates..."
chown -R turnserver:turnserver /etc/letsencrypt/live/
chown -R turnserver:turnserver /etc/letsencrypt/archive/

echo "Restarting CoTURN..."
systemctl restart coturn
