# Running Kainat on the server

Kainat runs on the Contabo server (Ubuntu 24.04) next to Soluxia, as its own `kainat` user, behind the existing
Cloudflare tunnel. No port is opened to the internet; Cloudflare provides HTTPS.

| Instance | Address | Local port | Folder | Updates |
|---|---|---|---|---|
| staging | kainat-staging.bitloomix.io (behind Cloudflare Access) | 8090 | /srv/kainat/staging | every merge to `main`, after CI passes |
| production | (final domain, milestone 3) | 8091 | /srv/kainat/production | a published release `v1.2.3`, after approval |

Each folder has `app/` (the code, from GitHub, read-only for the service), `data/` (database and uploads) and
`backups/` (nightly copies, newest 30 kept). Settings and keys are in `/etc/kainat/<instance>.env`, never in git.

## First setup

```bash
git clone https://github.com/AbdulWahab-ai/kainat.git /tmp/kainat
sudo bash /tmp/kainat/deploy/setup-server.sh staging 8090
```

Then add the address to the tunnel (`/etc/cloudflared/config.yml`, before the final 404 rule) and restart `cloudflared`:

```yaml
  - hostname: kainat-staging.bitloomix.io
    service: http://127.0.0.1:8090
```

In the Cloudflare dashboard, in this order:
1. **Zero Trust → Access → Applications:** add a self-hosted app for `kainat-staging.bitloomix.io` that allows only
   the team's email addresses. Staging shows sign-in codes on screen, so it must never be open to everyone.
2. **DNS:** a CNAME `kainat-staging` → `<tunnel id>.cfargotunnel.com`, proxied.

Use a single-level name like `kainat-staging.bitloomix.io`: Cloudflare's free certificate does not cover
`staging.kainat.bitloomix.io`.

## Updates

GitHub Actions (`.github/workflows/deploy.yml`) runs `kainat-deploy` on the server over SSH. That command:
backs up the database, checks out the new version, restarts the service and checks `/api/config`. If the app does
not answer within 20 seconds it goes back to the previous version.

Each deploy key in GitHub can run nothing but `kainat-deploy`, for its own instance only. In `/root/.ssh/authorized_keys`:

```
command="/usr/local/bin/kainat-deploy staging",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... kainat-deploy-staging
command="/usr/local/bin/kainat-deploy production",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... kainat-deploy-production
```

GitHub secrets: `STAGING_SSH_KEY` (in the `staging` environment), `PRODUCTION_SSH_KEY` (in the `production`
environment, with required reviewers), `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`.

By hand on the server: `kainat-deploy staging` or `kainat-deploy production v1.0.0`.

## Day to day

```bash
systemctl status kainat@staging              # running?
journalctl -u kainat@staging -f              # live log
systemctl start kainat-backup@staging        # backup now
ls /srv/kainat/staging/backups               # backups
nano /etc/kainat/staging.env && systemctl restart kainat@staging   # change a setting
```

To restore a backup: stop the service, copy `app.db` (and `uploads/`) from the backup folder into `data/`,
`chown -R kainat:kainat data`, start the service.
