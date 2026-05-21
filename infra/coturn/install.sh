#!/bin/bash
set -euo pipefail

# Ubuntu 24.04 LTS arm64 - CoTURN + Caddy + Certbot Installation Script

echo "Updating packages and installing dependencies..."
apt-get update
apt-get upgrade -y
apt-get install -y coturn caddy certbot cron

echo "Configuring CoTURN daemon..."
# Enable CoTURN to run as daemon (required on Ubuntu)
sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/g' /etc/default/coturn
# If it wasn't there, append it
grep -q "TURNSERVER_ENABLED=1" /etc/default/coturn || echo "TURNSERVER_ENABLED=1" >> /etc/default/coturn

echo "Deploying CoTURN configuration..."
cp ./turnserver.conf /etc/turnserver.conf

echo "Restarting services..."
systemctl restart coturn
systemctl enable coturn
systemctl enable caddy

echo "Installation complete. Ensure you run certbot to provision the TLS certificates."
