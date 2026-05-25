#!/bin/bash
# Server-side TURN secret rotator. Invoked by update-secret.bat (or directly).
#
# Reads a 64-char hex secret from stdin, applies it to both
# /etc/turnserver.conf and /root/alfajer/apps/signaling/.env, and
# restarts both services. Backs up the previous values so a manual
# rollback is possible.
#
# Usage (from your PC):
#   echo "<new-hex>" | ssh -i <ssh-key-path> root@<server-ip> \
#       "bash /root/update-secret.sh"

set -euo pipefail

TURN_CONF=/etc/turnserver.conf
SIGNALING_ENV=/root/alfajer/apps/signaling/.env
BACKUP_DIR=/root/alfajer-secret-backups

read -r NEW_SECRET || true

if ! [[ "$NEW_SECRET" =~ ^[a-fA-F0-9]{64}$ ]]; then
  echo "ERROR: stdin must contain exactly 64 hex characters" >&2
  exit 1
fi

if [[ ! -f "$TURN_CONF" ]]; then
  echo "ERROR: $TURN_CONF missing" >&2
  exit 1
fi
if [[ ! -f "$SIGNALING_ENV" ]]; then
  echo "ERROR: $SIGNALING_ENV missing" >&2
  exit 1
fi

# Backup the previous values (last 5 rotations kept)
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
cp "$TURN_CONF" "$BACKUP_DIR/turnserver.conf.$TS"
cp "$SIGNALING_ENV" "$BACKUP_DIR/signaling.env.$TS"
# Keep only the 5 most recent backups
ls -1t "$BACKUP_DIR"/turnserver.conf.* 2>/dev/null | tail -n +6 | xargs -r rm -f
ls -1t "$BACKUP_DIR"/signaling.env.* 2>/dev/null | tail -n +6 | xargs -r rm -f

echo "==> Updating /etc/turnserver.conf..."
sed -i "s|^static-auth-secret=.*|static-auth-secret=${NEW_SECRET}|" "$TURN_CONF"
if ! grep -q "^static-auth-secret=${NEW_SECRET}$" "$TURN_CONF"; then
  echo "ERROR: sed did not apply to $TURN_CONF" >&2
  exit 1
fi

echo "==> Updating $SIGNALING_ENV..."
sed -i "s|^TURN_STATIC_AUTH_SECRET=.*|TURN_STATIC_AUTH_SECRET=${NEW_SECRET}|" "$SIGNALING_ENV"
if ! grep -q "^TURN_STATIC_AUTH_SECRET=${NEW_SECRET}$" "$SIGNALING_ENV"; then
  echo "ERROR: sed did not apply to $SIGNALING_ENV" >&2
  exit 1
fi

echo "==> Restarting coturn..."
systemctl restart coturn
sleep 2
if ! systemctl is-active --quiet coturn; then
  echo "ERROR: coturn failed to restart. Recent logs:" >&2
  journalctl -u coturn -n 30 --no-pager >&2
  exit 1
fi

echo "==> Restarting alfajer-signaling..."
systemctl restart alfajer-signaling
sleep 2
if ! systemctl is-active --quiet alfajer-signaling; then
  echo "ERROR: alfajer-signaling failed to restart. Recent logs:" >&2
  journalctl -u alfajer-signaling -n 30 --no-pager >&2
  exit 1
fi

echo
echo "✓ TURN secret rotated successfully at $TS"
echo "  coturn:            $(systemctl is-active coturn)"
echo "  alfajer-signaling: $(systemctl is-active alfajer-signaling)"
echo "  backups:           $BACKUP_DIR"
