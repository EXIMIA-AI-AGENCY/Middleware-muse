#!/usr/bin/env bash
# Genera CONNECTION.md (handoff para Muse) a partir del hostname público del deploy.
#
# Uso:
#   ./scripts/write-connection.sh ghl-proxy.midominio.com
#   ./scripts/write-connection.sh ghl-proxy.midominio.com --no-check   # sin verificar /health
#
# CONNECTION.md nunca contiene secretos: ni el token de GHL ni la llave del proxy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RAW="${1:?uso: write-connection.sh <hostname-publico> [--no-check]}"
CHECK=1
[[ "${2:-}" == "--no-check" ]] && CHECK=0

# Accept a pasted URL, but keep only the bare hostname.
HOST="${RAW#https://}"
HOST="${HOST#http://}"
HOST="${HOST%%/*}"
HOST="${HOST%%\?*}"
HOST="$(printf '%s' "$HOST" | tr '[:upper:]' '[:lower:]')"
if ! [[ "$HOST" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+(xn--[a-z0-9-]+|[a-z]{2,})$ ]]; then
  echo "Hostname inválido: '$HOST' (se espera algo como ghl-proxy.midominio.com, sin esquema, puerto ni path)." >&2
  exit 1
fi

LOCATION_ID="${GHL_LOCATION_ID:-L3bLLVwvhdJ7A9WqkPxM}"
VERSION="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)"
HEALTH_URL="https://$HOST/health"

if [[ "$CHECK" == 1 ]]; then
  BODY="$(curl -fsS --max-time 15 "$HEALTH_URL")" || { echo "No responde $HEALTH_URL (usa --no-check para omitir)." >&2; exit 1; }
  if ! grep -Eq '"ok": *true' <<<"$BODY"; then
    echo "Respuesta inesperada de $HEALTH_URL: $BODY" >&2
    exit 1
  fi
  if ! grep -q "\"version\": *\"$VERSION\"" <<<"$BODY"; then
    echo "AVISO: el deploy reporta otra versión ($BODY); se escribe version: $VERSION." >&2
  fi
fi

cat > "$ROOT/CONNECTION.md" <<EOF
# CONNECTION — ghl-proxy → Muse

Handoff para Muse. Sin secretos: la llave del proxy se entrega al operador por separado.

\`\`\`yaml
middleware_host: $HOST
auth_placement: header:X-Proxy-Key
rest_base_path: /ghl
mcp_path: /mcp/
health_url: $HEALTH_URL
ghl_location_id: $LOCATION_ID
version: $VERSION
\`\`\`
EOF

echo "CONNECTION.md escrito para $HOST"
cat "$ROOT/CONNECTION.md"
