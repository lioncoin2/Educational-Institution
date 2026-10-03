#!/usr/bin/env bash
# Install the P7.3 staging nginx config onto this host (idempotent).
#
#   - symlinks infra/nginx/staging.http.conf   -> /etc/nginx/sites-enabled/
#   - symlinks infra/nginx/staging.stream.conf -> /etc/nginx/stream-enabled/
#   - ensures nginx.conf has a top-level `stream { include stream-enabled/*; }`
#   - removes the distro default site and the temporary ACME bootstrap
#   - `nginx -t` then reload
#
# Requires the TLS cert to exist already (certbot certonly, see README). Run as
# root from the repository root. Changes no firewall and starts no container.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NGINX_DIR=/etc/nginx

[ -f /etc/letsencrypt/live/staging-adlink4/fullchain.pem ] || {
  echo "ERROR: TLS cert /etc/letsencrypt/live/staging-adlink4/ not found; issue it first." >&2
  exit 1
}

mkdir -p "$NGINX_DIR/stream-enabled" /var/www/certbot

# Top-level stream{} include — added once, after the http block is closed.
if ! grep -q 'stream-enabled' "$NGINX_DIR/nginx.conf"; then
  cat >> "$NGINX_DIR/nginx.conf" <<'EOF'

# P7.3: L4 stream configs (SNI demux on 443, TURN/TLS terminator).
stream {
    include /etc/nginx/stream-enabled/*.conf;
}
EOF
  echo "Added stream{} include to nginx.conf"
fi

ln -sf "$REPO/infra/nginx/staging.http.conf"   "$NGINX_DIR/sites-enabled/staging.http.conf"
ln -sf "$REPO/infra/nginx/staging.stream.conf" "$NGINX_DIR/stream-enabled/staging.stream.conf"
rm -f "$NGINX_DIR/sites-enabled/default" "$NGINX_DIR/sites-enabled/acme-bootstrap.conf"

nginx -t
systemctl reload nginx
echo "nginx staging config installed and reloaded."
