#!/usr/bin/env bash
# Pruebas de aceptación contra un ghl-proxy desplegado (o local).
#
# Uso:
#   ./scripts/smoke-test.sh https://ghl-proxy.midominio.com [locationId]
#   ./scripts/smoke-test.sh ghl-proxy.midominio.com            # sin esquema = https
#
# La llave se toma de la variable PROXY_KEY; si no existe, se pide sin eco.
# Nunca se imprime ni se pasa como argumento de línea de comandos (no queda en `ps`).
set -euo pipefail

BASE="${1:?uso: smoke-test.sh https://<host> [locationId]}"
BASE="${BASE%/}"
LOCATION_ID="${2:-${GHL_LOCATION_ID:-L3bLLVwvhdJ7A9WqkPxM}}"

# A bare hostname (the CONNECTION.md format) means https.
[[ "$BASE" == *://* ]] || BASE="https://$BASE"
HOST="${BASE#*://}"
HOST="${HOST%%/*}"

# The key must never travel in cleartext: plain http is only allowed for local tests.
if [[ "$BASE" != https://* ]]; then
  case "$HOST" in
    localhost | localhost:* | 127.* | "[::1]" | "[::1]:"*) ;;
    *)
      echo "Rechazado: $BASE no es https://. La llave viajaría sin cifrar." >&2
      echo "Usa https://$HOST (http:// solo se permite contra localhost)." >&2
      exit 2
      ;;
  esac
fi

if [[ -z "${PROXY_KEY:-}" ]]; then
  if [[ -t 0 ]]; then
    read -rsp "PROXY_KEY: " PROXY_KEY
    echo
  else
    echo "Falta PROXY_KEY (exporta la variable o ejecuta en una terminal interactiva)." >&2
    exit 2
  fi
fi

command -v curl >/dev/null || { echo "Se necesita curl." >&2; exit 2; }
HAS_JQ=0
command -v jq >/dev/null && HAS_JQ=1

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Header file readable only by us: keeps the key out of argv.
KEY_HEADER="$TMP/key-header"
( umask 077; printf 'X-Proxy-Key: %s\n' "$PROXY_KEY" > "$KEY_HEADER" )
printf 'X-Proxy-Key: %s\n' "not-the-right-key-000000000000000000" > "$TMP/bad-key-header"

FAILURES=0
GREEN="" RED="" RESET=""
if [[ -t 1 ]]; then GREEN=$'\033[32m' RED=$'\033[31m' RESET=$'\033[0m'; fi
pass() { printf '  %sPASS%s %s\n' "$GREEN" "$RESET" "$1"; }
fail() { printf '  %sFAIL%s %s\n' "$RED" "$RESET" "$1"; FAILURES=$((FAILURES + 1)); }

# call <name> <method> <path> <key-header-file|-> [json-body] ; sets STATUS, BODY file, HEADERS file
call() {
  local name="$1" method="$2" path="$3" keyfile="$4" body="${5:-}"
  local args=(-sS -o "$TMP/$name.body" -D "$TMP/$name.headers" -w '%{http_code}' -X "$method" --max-time 30)
  [[ "$keyfile" != "-" ]] && args+=(-H "@$keyfile")
  if [[ -n "$body" ]]; then
    args+=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' --data-binary "$body")
  fi
  [[ -n "${SESSION_ID:-}" ]] && args+=(-H "Mcp-Session-Id: $SESSION_ID")
  [[ -n "${PROTOCOL_VERSION:-}" ]] && args+=(-H "MCP-Protocol-Version: $PROTOCOL_VERSION")
  STATUS="$(curl "${args[@]}" "$BASE$path" || true)"
  [[ "$STATUS" =~ ^[0-9]{3}$ ]] || STATUS=000
  BODY="$TMP/$name.body"
  HEADERS="$TMP/$name.headers"
}

# JSON payload of a response, whether it came as plain JSON or as SSE (MCP streamable HTTP).
json_of() {
  if grep -qi '^content-type: *text/event-stream' "$HEADERS"; then
    sed -n 's/^data: \{0,1\}//p' "$BODY" | head -n 1
  else
    cat "$BODY"
  fi
}

has_json() { # has_json <jq-filter> <grep-fallback-regex>
  if [[ "$HAS_JQ" == 1 ]]; then json_of | jq -e "$1" >/dev/null 2>&1; else json_of | grep -Eq "$2"; fi
}

echo "ghl-proxy smoke test -> $BASE (locationId=$LOCATION_ID)"
[[ "$BASE" == https://* ]] || echo "  AVISO: http:// sin TLS (solo válido en local)."

CONTACTS="/ghl/contacts/?locationId=$LOCATION_ID&limit=1"

call health GET /health -
if [[ "$STATUS" == 200 ]] && has_json '.ok == true and (.version | type == "string")' '"ok": *true'; then
  pass "GET /health -> 200 $(cat "$BODY")"
else
  fail "GET /health -> $STATUS (esperado 200 con {\"ok\": true, ...})"
fi

call contacts GET "$CONTACTS" "$KEY_HEADER"
if [[ "$STATUS" == 200 ]] && has_json '.contacts | type == "array"' '"contacts"'; then
  pass "GET $CONTACTS con llave -> 200 con contactos"
else
  fail "GET $CONTACTS con llave -> $STATUS (esperado 200). Respuesta: $(head -c 300 "$BODY")"
fi

call nokey GET "$CONTACTS" -
if [[ "$STATUS" == 401 ]] && has_json '.error == "unauthorized"' '"unauthorized"'; then
  pass "GET $CONTACTS sin llave -> 401"
else
  fail "GET $CONTACTS sin llave -> $STATUS (esperado 401)"
fi

call badkey GET "$CONTACTS" "$TMP/bad-key-header"
if [[ "$STATUS" == 401 ]]; then pass "GET con llave incorrecta -> 401"; else fail "GET con llave incorrecta -> $STATUS (esperado 401)"; fi

call mcpnokey POST /mcp/ - '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ghl-proxy-smoke","version":"1.0.0"}}}'
if [[ "$STATUS" == 401 ]]; then pass "POST /mcp/ sin llave -> 401"; else fail "POST /mcp/ sin llave -> $STATUS (esperado 401)"; fi

call init POST /mcp/ "$KEY_HEADER" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ghl-proxy-smoke","version":"1.0.0"}}}'
if [[ "$STATUS" == 200 ]] && has_json '.jsonrpc == "2.0" and .id == 1 and (.result.protocolVersion | type == "string")' '"jsonrpc": *"2.0"'; then
  pass "POST /mcp/ initialize -> JSON-RPC válido"
else
  fail "POST /mcp/ initialize -> $STATUS. Respuesta: $(head -c 300 "$BODY")"
fi
SESSION_ID="$(grep -i '^mcp-session-id:' "$HEADERS" | head -n 1 | cut -d: -f2- | tr -d ' \r' || true)"
if [[ "$HAS_JQ" == 1 ]]; then PROTOCOL_VERSION="$(json_of | jq -r '.result.protocolVersion // empty' 2>/dev/null || true)"; fi

call initialized POST /mcp/ "$KEY_HEADER" '{"jsonrpc":"2.0","method":"notifications/initialized"}'
if [[ "$STATUS" =~ ^20[0-4]$ ]]; then pass "POST /mcp/ notifications/initialized -> $STATUS"; else fail "notifications/initialized -> $STATUS (esperado 202)"; fi

call tools POST /mcp/ "$KEY_HEADER" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
if [[ "$STATUS" == 200 ]] && has_json '.result.tools | type == "array"' '"tools"'; then
  COUNT=""
  [[ "$HAS_JQ" == 1 ]] && COUNT=" ($(json_of | jq '.result.tools | length') tools)"
  pass "POST /mcp/ tools/list -> 200$COUNT"
else
  fail "POST /mcp/ tools/list -> $STATUS. Respuesta: $(head -c 300 "$BODY")"
fi

echo
if [[ "$FAILURES" == 0 ]]; then
  echo "Todo OK. Siguiente paso: ./scripts/write-connection.sh ${HOST%%:*}"
else
  echo "$FAILURES prueba(s) fallaron."
fi
exit "$FAILURES"
