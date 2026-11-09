#!/usr/bin/env bash
# Updates one Kainat instance to a new version and restarts it; rolls back if it does not come up.
# Installed on the server as /usr/local/bin/kainat-deploy.
#
#   kainat-deploy staging              newest commit on main
#   kainat-deploy production v1.0.0    a release tag
#
# GitHub Actions reaches this through a deploy key that can run nothing else (see deploy/README.md);
# the key's forced command passes what the workflow asked for in SSH_ORIGINAL_COMMAND.
set -euo pipefail

# Through a deploy key the instance is fixed by the key (command="/usr/local/bin/kainat-deploy staging"), and only
# the release tag is taken from what the workflow asked for, so the staging key can never touch production.
if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  read -r -a asked <<<"$SSH_ORIGINAL_COMMAND"
  [[ "${asked[0]:-}" == kainat-deploy ]] && asked=("${asked[@]:1}")
  [[ $# -ge 1 && "${asked[0]:-}" == "$1" ]] || { echo "This key can only deploy ${1:-nothing}"; exit 1; }
  set -- "$1" "${asked[1]:-}"
fi

INSTANCE="${1:?usage: kainat-deploy <staging|production> [tag]}"
REF="${2:-}"
[[ "$INSTANCE" =~ ^(staging|production)$ ]] || { echo "Unknown instance: $INSTANCE"; exit 1; }
[[ -z "$REF" || "$REF" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Only release tags like v1.2.3 can be deployed"; exit 1; }
if [[ "$INSTANCE" == production && -z "$REF" ]]; then echo "Production deploys need a release tag"; exit 1; fi

APP="/srv/kainat/$INSTANCE/app"
PORT=$(grep -E '^PORT=' "/etc/kainat/$INSTANCE.env" | cut -d= -f2)
exec 9>"/run/kainat-deploy-$INSTANCE.lock"; flock -n 9 || { echo "Another deploy is running"; exit 1; }

before=$(git -C "$APP" rev-parse HEAD)
git -C "$APP" fetch --quiet --tags --force origin
if [[ -n "$REF" ]]; then target=$(git -C "$APP" rev-parse "refs/tags/$REF^{commit}"); else target=$(git -C "$APP" rev-parse origin/main); fi
echo "$INSTANCE: ${before:0:7} -> ${target:0:7}"

# A copy of the database first, so a bad version can be undone together with its data changes.
systemctl start "kainat-backup@$INSTANCE.service" || echo "warning: backup before deploy failed"

git -C "$APP" -c advice.detachedHead=false checkout --quiet --force "$target"
# Service files can change with the code.
install -m 644 "$APP/deploy/systemd/kainat@.service" /etc/systemd/system/kainat@.service
install -m 644 "$APP/deploy/systemd/kainat-backup@.service" /etc/systemd/system/kainat-backup@.service
install -m 644 "$APP/deploy/systemd/kainat-backup@.timer" /etc/systemd/system/kainat-backup@.timer
systemctl daemon-reload
systemctl restart "kainat@$INSTANCE.service"

for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/config" >/dev/null 2>&1; then
    echo "$INSTANCE is up on ${target:0:7}"
    install -m 755 "$APP/deploy/deploy.sh" /usr/local/bin/kainat-deploy.next && mv /usr/local/bin/kainat-deploy.next /usr/local/bin/kainat-deploy
    exit 0
  fi
  sleep 1
done

echo "$INSTANCE did not come up on ${target:0:7}; rolling back to ${before:0:7}"
journalctl -u "kainat@$INSTANCE" -n 30 --no-pager || true
git -C "$APP" -c advice.detachedHead=false checkout --quiet --force "$before"
systemctl restart "kainat@$INSTANCE.service"
exit 1
