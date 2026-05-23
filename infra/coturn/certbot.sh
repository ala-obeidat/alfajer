#!/bin/bash
set -euo pipefail

# Certbot renewal hook for CoTURN

DOMAIN="turn.alfajer.example"
EMAIL="admin@alfajer.example"

echo "Requesting initial certificate for ${DOMAIN}..."
certbot certonly --standalone -d ${DOMAIN} --non-interactive --agree-tos -m ${EMAIL}

echo "Setting permissions for CoTURN to read Let's Encrypt certificates..."
chown -R turnserver:turnserver /etc/letsencrypt/live/
chown -R turnserver:turnserver /etc/letsencrypt/archive/

echo "Restarting CoTURN..."
systemctl restart coturn
