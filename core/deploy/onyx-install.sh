#!/usr/bin/env bash
# Runs on the shared server (sent by the noveniqe repo's onyx-accounts-deploy.yml). Installs Onyx's OWN accounts site,
# accounts.amaete.com, for everything the studio makes that is not a game (the 3D sites, SavvyMe, Isoteh, Prebuild, Remodel,
# Jisste...). Same code as the games' accounts site (accounts.noveniqe.com, deploy/install.sh), but its own database, its
# own settings and its own address, so the two never share people:
#   - its own PocketBase in /opt/onyx-pb with data in /var/lib/onyx-pb, service onyx-pb on 127.0.0.1:8220
#   - the accounts service from /opt/onyx/accounts, service onyx-accounts on 127.0.0.1:8210, brand "Amaete"
#   - settings and secrets in /etc/onyx (made once here; never in the repo or in chat)
#   - sign-in keys (Google, the mailbox, Stripe) copied from the games' accounts settings on this same server
#   - addresses: accounts.amaete.com and onyx.amaete.com (it sends people to the console) once they point here, and always
#     the spare onyx.<server-ip>.sslip.io
# Safe to run again.
set -euo pipefail
APP=/opt/onyx/accounts NODE_DIR=/opt/novenique-node ETC=/etc/onyx ENVF=/etc/onyx/accounts.env PORT=8210
PB_DIR=/opt/onyx-pb PB_DATA=/var/lib/onyx-pb PB_PORT=8220 PB_V=0.40.5 NODE_V=v22.11.0
GAMES_ENV=/etc/novenique/core.env
HOST_IP=${HOST_IP:?}
SPARE="onyx.${HOST_IP//./-}.sslip.io" MAIN_DNS=accounts.amaete.com CONSOLE_DNS=onyx.amaete.com

# ---- system user, Node, code ----
id onyx >/dev/null 2>&1 || sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin onyx
case "$(uname -m)" in aarch64|arm64) NARCH=arm64 PARCH=arm64 ;; *) NARCH=x64 PARCH=amd64 ;; esac
if [ "$("$NODE_DIR/bin/node" --version 2>/dev/null)" != "$NODE_V" ]; then
  curl -fsSL "https://nodejs.org/dist/$NODE_V/node-$NODE_V-linux-$NARCH.tar.xz" -o /tmp/nv-node.tar.xz
  sudo rm -rf "$NODE_DIR" && sudo mkdir -p "$NODE_DIR" && sudo tar -xJf /tmp/nv-node.tar.xz -C "$NODE_DIR" --strip-components=1 && rm -f /tmp/nv-node.tar.xz
fi
sudo mkdir -p /opt/onyx
sudo rm -rf "$APP.new" && sudo mkdir -p "$APP.new" && sudo tar -xzf /tmp/onyx-accounts.tgz -C "$APP.new" && rm -f /tmp/onyx-accounts.tgz
sudo rm -rf "$APP.old"; [ -d "$APP" ] && sudo mv "$APP" "$APP.old"; sudo mv "$APP.new" "$APP"; sudo rm -rf "$APP.old"
sudo chown -R root:root "$APP" && sudo chmod -R go-w "$APP"

# ---- its own PocketBase ----
if [ "$("$PB_DIR/pocketbase" --version 2>/dev/null | awk '{print $3}')" != "$PB_V" ]; then
  curl -fsSL -o /tmp/onyx-pb.zip "https://github.com/pocketbase/pocketbase/releases/download/v$PB_V/pocketbase_${PB_V}_linux_$PARCH.zip"
  sudo mkdir -p "$PB_DIR" && sudo unzip -oq /tmp/onyx-pb.zip pocketbase -d "$PB_DIR" && sudo chmod 755 "$PB_DIR/pocketbase" && rm -f /tmp/onyx-pb.zip
fi
sudo install -d -m 750 -o onyx -g onyx "$PB_DATA"

# ---- settings: secrets are made once; addresses and keys follow every deploy ----
sudo install -d -m 750 -o root -g onyx "$ETC" "$ETC/clients"
r() { openssl rand -hex 24; }
if ! sudo test -f "$ENVF"; then
  sudo install -m 640 -o root -g onyx /dev/null "$ENVF"
  sudo tee "$ENVF" >/dev/null <<ENV
# Onyx accounts (accounts.amaete.com). Made by core/deploy/onyx-install.sh; secrets stay here (never in the repo or in chat).
CORE_ENV=production
CORE_BRAND=Amaete
CORE_SECRET=$(openssl rand -hex 32)
CORE_HOST=127.0.0.1
CORE_PORT=$PORT
CORE_REALM_SLUG=amaete
CORE_CLIENTS_FILE=$APP/deploy/onyx-clients.json
CORE_CLIENT_SECRETS_DIR=$ETC/clients
PB_URL=http://127.0.0.1:$PB_PORT
PB_CORE_EMAIL=core@onyx.internal
PB_CORE_PASSWORD=$(r)
MAIL_PROVIDER=off
STAFF_MFA_REQUIRED=true
ENV
fi
setkv() { sudo sed -i "/^$1=/d" "$ENVF"; printf '%s=%s\n' "$1" "$2" | sudo tee -a "$ENVF" >/dev/null; }
getkv() { sudo grep "^$1=" "$2" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r\n' || true; }
NAMES=("$SPARE")
[ "$(getent ahostsv4 "$MAIN_DNS" 2>/dev/null | awk 'NR==1{print $1}')" = "$HOST_IP" ] && NAMES=("$MAIN_DNS" "$SPARE")
setkv CORE_PUBLIC_URL "https://${NAMES[0]}"
# the same Google sign-in, mailbox and Stripe account as the games (one studio); people never see "Noveniqe" here
if sudo test -f "$GAMES_ENV"; then
  for k in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET RESEND_API_KEY BREVO_API_KEY SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS MAIL_PROVIDER STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET; do
    v=$(getkv "$k" "$GAMES_ENV"); [ -n "$v" ] && setkv "$k" "$v"
  done
  addr=$(getkv MAIL_FROM "$GAMES_ENV" | sed -E 's/.*<([^>]+)>.*/\1/'); [ -n "$addr" ] || addr=$(getkv SMTP_USER "$GAMES_ENV")
  [ -n "$addr" ] && setkv MAIL_FROM "Amaete <$addr>"
fi
# one secret per product hosted on this server (Vercel sites keep theirs in Vercel's settings: secret_sha256 in the file)
for id in $(python3 -c "import json;print(' '.join(c['id'] for c in json.load(open('$APP/deploy/onyx-clients.json'))['clients'] if not c.get('secret_sha256')))"); do
  f="$ETC/clients/$id.env"
  if ! sudo test -f "$f"; then sudo install -m 640 -o root -g onyx /dev/null "$f"; printf 'NOVENIQUE_CLIENT_SECRET=%s\n' "$(openssl rand -hex 32)" | sudo tee "$f" >/dev/null; fi
done

# ---- the database: schema, the service's own superuser, start ----
sudo rm -rf "$PB_DIR/pb_migrations" && sudo cp -r "$APP/store/pb_migrations" "$PB_DIR/pb_migrations"
PBARGS="--dir=$PB_DATA --migrationsDir=$PB_DIR/pb_migrations"
PBE=$(getkv PB_CORE_EMAIL "$ENVF") PBP=$(getkv PB_CORE_PASSWORD "$ENVF")
sudo -u onyx "$PB_DIR/pocketbase" migrate up $PBARGS >/dev/null
sudo -u onyx "$PB_DIR/pocketbase" superuser upsert "$PBE" "$PBP" --dir="$PB_DATA" >/dev/null
sudo tee /etc/systemd/system/onyx-pb.service >/dev/null <<UNIT
[Unit]
Description=Onyx accounts database (PocketBase, loopback only)
After=network-online.target
Wants=network-online.target
[Service]
User=onyx
Group=onyx
ExecStart=$PB_DIR/pocketbase serve $PBARGS --automigrate=false --http=127.0.0.1:$PB_PORT
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$PB_DATA
MemoryHigh=200M
MemoryMax=256M
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable onyx-pb >/dev/null
sudo systemctl restart onyx-pb
for i in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$PB_PORT/api/health" 2>/dev/null && break; sleep 1; done

# the "amaete" tenant, and the first owner: whoever is Super Administrator on the games' site (asked once)
OWN=$(sudo "$NODE_DIR/bin/node" "$APP/deploy/onyx-seed.mjs" "$ENVF" "$GAMES_ENV" /etc/palasora.env)   # stops here if the tenant cannot be made
if [ -n "$OWN" ] && ! sudo grep -q '^CORE_OWNER_EMAILS=.' "$ENVF"; then setkv CORE_OWNER_EMAILS "$OWN"; echo "First owner set from the games' Super Administrator."; fi

# ---- the accounts service ----
sudo tee /etc/systemd/system/onyx-accounts.service >/dev/null <<UNIT
[Unit]
Description=Onyx accounts (accounts.amaete.com: the studio's sites and products, loopback only)
After=network-online.target onyx-pb.service
Wants=network-online.target
[Service]
User=onyx
Group=onyx
EnvironmentFile=$ENVF
WorkingDirectory=$APP
ExecStart=$NODE_DIR/bin/node server.mjs
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
MemoryHigh=200M
MemoryMax=256M
CPUWeight=100
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable onyx-accounts >/dev/null
sudo systemctl restart onyx-accounts
for i in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null && break; sleep 1; done

# ---- web addresses in the shared Caddy ----
CONSOLE=""
[ "$(getent ahostsv4 "$CONSOLE_DNS" 2>/dev/null | awk 'NR==1{print $1}')" = "$HOST_IP" ] && CONSOLE="$CONSOLE_DNS {
	redir https://${NAMES[0]}/console 302
}"
sudo tee /etc/caddy/sites/onyx-accounts.caddy >/dev/null <<CADDY
$(IFS=,; echo "${NAMES[*]}" | sed 's/,/, /g') {
	encode zstd gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:$PORT
}
$CONSOLE
CADDY
sudo /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
sudo systemctl reload caddy

printf '%-16s %s\n' onyx-pb "$(systemctl is-active onyx-pb)" onyx-accounts "$(systemctl is-active onyx-accounts)"
curl -fsS "http://127.0.0.1:$PORT/health"; echo
echo "Addresses: ${NAMES[*]}${CONSOLE:+ $CONSOLE_DNS}"
