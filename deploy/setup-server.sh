#!/usr/bin/env bash
# Sets up one Kainat instance (staging or production) on an Ubuntu server. Safe to run again.
#
#   sudo bash deploy/setup-server.sh staging 8090
#   sudo bash deploy/setup-server.sh production 8091
#
# What it does:
#   - installs Node.js (official build, checksum verified) into /opt/node
#   - creates the "kainat" system user and /srv/kainat/<instance>/{app,data,backups}
#   - clones the code from GitHub into app/ (data never lives in git)
#   - writes /etc/kainat/<instance>.env once (edit it afterwards; it is never overwritten)
#   - installs the systemd service and the nightly backup timer, and starts them
#   - installs the deploy command used by GitHub Actions
set -euo pipefail

INSTANCE="${1:?usage: setup-server.sh <staging|production> <port>}"
PORT="${2:?usage: setup-server.sh <staging|production> <port>}"
NODE_VERSION="${NODE_VERSION:-v24.22.2}"
REPO="${REPO:-https://github.com/AbdulWahab-ai/kainat.git}"
BRANCH="${BRANCH:-main}"
BASE="/srv/kainat/$INSTANCE"

[[ "$INSTANCE" =~ ^(staging|production)$ ]] || { echo "Instance must be staging or production"; exit 1; }
[[ $EUID -eq 0 ]] || { echo "Run as root"; exit 1; }

# ---- Node.js ----
if [[ "$(/opt/node/bin/node -v 2>/dev/null || true)" != "$NODE_VERSION" ]]; then
  echo "Installing Node.js $NODE_VERSION"
  tmp=$(mktemp -d)
  file="node-$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$file" -o "$tmp/$file"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf /opt/node.new && mkdir -p /opt/node.new
  tar -xJf "$tmp/$file" -C /opt/node.new --strip-components=1
  rm -rf /opt/node.old; [[ -d /opt/node ]] && mv /opt/node /opt/node.old
  mv /opt/node.new /opt/node
  ln -sf /opt/node/bin/node /usr/local/bin/node
  rm -rf "$tmp"
fi
node -v

# ---- user and folders ----
id kainat &>/dev/null || useradd --system --home /srv/kainat --shell /usr/sbin/nologin kainat
mkdir -p "$BASE/data" "$BASE/backups" /etc/kainat
chown -R kainat:kainat "$BASE/data" "$BASE/backups"
chmod 750 "$BASE/data" "$BASE/backups"

# ---- code ----
if [[ ! -d "$BASE/app/.git" ]]; then
  git clone --quiet --branch "$BRANCH" "$REPO" "$BASE/app"
fi
chown -R root:root "$BASE/app"   # the service can read the code but not change it

# ---- settings (written once; edit /etc/kainat/<instance>.env afterwards) ----
ENV_FILE="/etc/kainat/$INSTANCE.env"
if [[ ! -f "$ENV_FILE" ]]; then
  DEV=0; [[ "$INSTANCE" == staging ]] && DEV=1
  cat > "$ENV_FILE" <<EOF
# Kainat $INSTANCE settings. Keys and tokens live here only, never in git.
NODE_ENV=production
HOST=127.0.0.1
PORT=$PORT
DATA_DIR=$BASE/data
BACKUP_DIRS=$BASE/backups
# Behind the Cloudflare tunnel: trust its forwarded address and HTTPS header; cookies only over HTTPS.
TRUST_PROXY=1
COOKIE_SECURE=1
# Staging only, and only behind Cloudflare Access: shows sign-in codes on screen. Must be 0 in production.
DEV_CODES=$DEV
# SMS provider for real sign-in codes (milestone 3):
# SMS_GATEWAY_URL=
# SMS_GATEWAY_TOKEN=
EOF
fi
chown root:kainat "$ENV_FILE"; chmod 640 "$ENV_FILE"

# ---- systemd ----
install -m 644 "$BASE/app/deploy/systemd/kainat@.service" /etc/systemd/system/kainat@.service
install -m 644 "$BASE/app/deploy/systemd/kainat-backup@.service" /etc/systemd/system/kainat-backup@.service
install -m 644 "$BASE/app/deploy/systemd/kainat-backup@.timer" /etc/systemd/system/kainat-backup@.timer
install -m 755 "$BASE/app/deploy/deploy.sh" /usr/local/bin/kainat-deploy
systemctl daemon-reload
systemctl enable --now "kainat@$INSTANCE.service" "kainat-backup@$INSTANCE.timer"

# ---- check ----
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/config" >/dev/null; then echo "Kainat $INSTANCE is running on 127.0.0.1:$PORT"; exit 0; fi
  sleep 1
done
echo "Kainat $INSTANCE did not answer; see: journalctl -u kainat@$INSTANCE -n 50"; exit 1
