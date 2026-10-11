#!/usr/bin/env bash
# Self-signed certificate for local HTTPS, covering the dev hostnames.
# Browsers will warn; that is expected and correct for a self-signed cert.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT/nginx/certs"
mkdir -p "$CERT_DIR"

if [ -f "$CERT_DIR/dev-fullchain.pem" ] && [ "${FORCE:-}" != "1" ]; then
  echo "Certificate already exists. Re-run with FORCE=1 to replace it."
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout "$CERT_DIR/dev-privkey.pem" \
  -out "$CERT_DIR/dev-fullchain.pem" \
  -subj "/CN=localhost/O=MT Link local development" \
  -addext "subjectAltName=DNS:localhost,DNS:*.localhost,DNS:go.localhost,DNS:app.localhost,IP:127.0.0.1" \
  2>/dev/null

chmod 600 "$CERT_DIR/dev-privkey.pem"
echo "Wrote $CERT_DIR/dev-fullchain.pem and dev-privkey.pem"
echo "Valid for: localhost, *.localhost, go.localhost, app.localhost, 127.0.0.1"
