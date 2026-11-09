#!/usr/bin/env bash
# Lets GitHub Actions update one Kainat instance on the server. Run it yourself, once per instance, from the project
# folder in Git Bash:
#
#   bash deploy/connect-github.sh staging
#   bash deploy/connect-github.sh production     (later, at launch)
#
# It makes a new SSH key that can only run "kainat-deploy <instance>" (no shell, no port forwarding), adds it to the
# server, stores it as a GitHub secret in the matching environment, and deletes the local copy of the private key.
# To withdraw it: delete the "kainat-deploy-<instance>" line from /root/.ssh/authorized_keys on the server.
set -euo pipefail

INSTANCE="${1:?usage: bash deploy/connect-github.sh <staging|production>}"
[[ "$INSTANCE" =~ ^(staging|production)$ ]] || { echo "Instance must be staging or production"; exit 1; }
HOST="${DEPLOY_HOST:-185.174.253.63}"
ADMIN_KEY="${ADMIN_KEY:-/d/DevEnv/ssh/soluxia_contabo}"
REPO="${REPO:-AbdulWahab-ai/kainat}"
NAME="kainat-deploy-$INSTANCE"
SECRET="$(echo "$INSTANCE" | tr a-z A-Z)_SSH_KEY"

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
ssh-keygen -q -t ed25519 -N "" -C "$NAME" -f "$work/key"

echo "1/4 Adding the key to the server (it can only run: kainat-deploy $INSTANCE)"
line="command=\"/usr/local/bin/kainat-deploy $INSTANCE\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $(cat "$work/key.pub")"
ssh -i "$ADMIN_KEY" root@"$HOST" "sed -i '/ $NAME\$/d' /root/.ssh/authorized_keys && echo '$line' >> /root/.ssh/authorized_keys"

echo "2/4 Checking the key cannot do anything else"
ssh-keyscan -t ed25519 "$HOST" 2>/dev/null > "$work/known"
out=$(ssh -i "$work/key" -o BatchMode=yes -o IdentitiesOnly=yes -o UserKnownHostsFile="$work/known" root@"$HOST" "id" 2>&1 || true)
if [[ "$out" != *"can only deploy"* ]]; then echo "Unexpected answer, stopping: $out"; exit 1; fi
echo "   refused a shell command, as it should"

echo "3/4 Creating the \"$INSTANCE\" environment on GitHub"
gh api -X PUT "repos/$REPO/environments/$INSTANCE" --silent

echo "4/4 Storing the secrets on GitHub"
gh secret set "$SECRET" --repo "$REPO" --env "$INSTANCE" < "$work/key"
gh secret set DEPLOY_HOST --repo "$REPO" --body "$HOST"
gh secret set DEPLOY_KNOWN_HOSTS --repo "$REPO" < "$work/known"

echo "Done. GitHub can now update $INSTANCE. The private key exists only in GitHub; the local copy is deleted."
if [[ "$INSTANCE" == production ]]; then
  echo "Next: on GitHub, Settings -> Environments -> production -> Required reviewers -> add yourself."
fi
