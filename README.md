# ghl-proxy — middleware GoHighLevel para Muse

Proxy HTTPS pequeño entre **Muse** y el API de **GoHighLevel** (REST v2 + MCP).
El proxy guarda el token real de GHL. Muse solo conoce una llave propia del
proxy (`X-Proxy-Key`) y nunca ve el token de GHL.

```
Muse (skill gohighlevel) --(X-Proxy-Key)--> ghl-proxy --(Bearer <GHL token>)--> services.leadconnectorhq.com
```

- **Stack:** Node.js 24 LTS + Express 5. Única dependencia de runtime: `express`.
  El reenvío usa `node:https` directamente, así que hace streaming en los dos
  sentidos (sirve para el SSE del MCP) y el cuerpo del upstream pasa byte a byte,
  sin recomprimir ni reinterpretar.
- **Versión:** 1.0.0.

---

## Endpoints

| Ruta | Auth | Qué hace |
|---|---|---|
| `GET /health` | no | `{"ok": true, "version": "1.0.0"}` |
| `ALL /ghl/*` | `X-Proxy-Key` | Quita `/ghl` y reenvía método, path, query string (sin tocar su codificación), headers y body a `https://services.leadconnectorhq.com/<path>`. Devuelve status, headers y body del upstream tal cual. |
| `POST /mcp/` | `X-Proxy-Key` | Reenvía el JSON-RPC a `https://services.leadconnectorhq.com/mcp/` (MCP streamable HTTP) y devuelve la respuesta en streaming (SSE). `/mcp` sin barra final funciona igual. Otros métodos (`GET`, `DELETE`…) también se reenvían y GHL decide la respuesta (hoy `405`/`404`). |
| `TRACE /ghl/*`, `TRACE /mcp/` | `X-Proxy-Key` | `405 {"error": "method_not_allowed"}`. `TRACE` devuelve los headers recibidos, así que reenviarlo podría exponer el token de GHL inyectado. |
| cualquier otra | `X-Proxy-Key` | `404 {"error": "not_found"}` |

**Autenticación:** todo request, excepto `/health`, debe traer
`X-Proxy-Key: <PROXY_KEY>`. Si falta o no coincide, la respuesta es `401`
`{"error": "unauthorized"}` y no sale nada hacia GHL. La comparación es de
tiempo constante. Solo se acepta este header: `Authorization: Bearer <llave>`
**no** sirve (`auth_placement: header:X-Proxy-Key`).

### Headers hacia GHL

| Header | Comportamiento |
|---|---|
| `Authorization` | Siempre `Bearer $GHL_TOKEN`. Lo que mande el cliente se descarta. |
| `User-Agent` | Siempre un User-Agent de Chrome de escritorio. El edge de Cloudflare de GHL responde `403 error code: 1010` a firmas como `Python-urllib/3.x`. |
| `Version` | `2021-07-28` si el cliente no manda uno. **El cliente puede sobrescribirlo**, porque algunas familias de endpoints de GHL exigen otro valor (ver [Notas para Muse](#notas-para-muse)). |
| `Accept` | REST: `application/json` si el cliente no manda nada o manda `*/*`. MCP: `application/json, text/event-stream` salvo que el cliente ya mande ambos (GHL responde `406` si falta alguno). |
| `Content-Type` (MCP) | `application/json` en `POST` si el cliente manda otra cosa (`urllib` usa `application/x-www-form-urlencoded` por defecto; GHL responde `415`). |
| `locationId` (MCP) | `$GHL_LOCATION_ID` si el cliente no lo manda. |
| `X-Proxy-Key` | **Nunca** se reenvía. |
| Hop-by-hop y de plataforma | No se reenvían: `Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`, `Upgrade`, `Proxy-*`, `Expect`, `Host`, `X-Forwarded-*`, `Forwarded`, `Via`, `X-Real-IP`, `True-Client-IP`, `CDN-Loop`, `CF-*`, `Fly-*`, `X-Railway-*`, `Rndr-*`. Los añade la plataforma de hosting, no Muse. Si se reenviaran al Cloudflare de GHL, expondrían la infraestructura y podrían disparar su detección de bucles. |
| Todo lo demás | Se reenvía tal cual (`Content-Type`, `Accept-Encoding`, `Mcp-Session-Id`, `MCP-Protocol-Version`, headers propios…). |

La respuesta de GHL vuelve sin cambios (status, headers como `Set-Cookie` o
`X-RateLimit-*`, y el body incluso comprimido). Solo se quitan los headers
hop-by-hop. En respuestas SSE se añade `X-Accel-Buffering: no` para que un
nginx intermedio no las acumule en buffer.

Si GHL responde antes de recibir todo el body de un upload (p. ej. `401` o
`413`), el proxy entrega esa respuesta y descarta el resto del body.
Limitación conocida: si además GHL cierra la conexión sin leer el body, en
uploads de más de ~1 MB el cliente HTTP de Node puede perder esa respuesta
temprana y el proxy devuelve `502`. Las llamadas JSON normales no se ven
afectadas.

### Errores propios del proxy

Todos en JSON y con `Cache-Control: no-store`. Cualquier otro status o body viene de GHL.

| Status | Body | Causa |
|---|---|---|
| 401 | `{"error":"unauthorized"}` | Falta `X-Proxy-Key` o es incorrecta. Un 401 **de GHL** trae otro body, p. ej. `{"statusCode":401,"message":"Invalid Private Integration token"}`, y significa que `GHL_TOKEN` es inválido o fue rotado. |
| 429 | `{"error":"rate_limited"}` + `Retry-After` | Se superó el rate limit del proxy. |
| 400 | `{"error":"bad_request"}` | Request-target que no empieza por `/`. |
| 405 | `{"error":"method_not_allowed"}` | Método `TRACE`. |
| 404 | `{"error":"not_found"}` | Ruta que no es `/health`, `/ghl/*` ni `/mcp/`. |
| 502 | `{"error":"bad_gateway"}` | No se pudo conectar con GHL, GHL cerró la conexión sin responder o envió una respuesta HTTP inválida. |
| 504 | `{"error":"upstream_timeout"}` | GHL no respondió en `UPSTREAM_TIMEOUT_MS`. |

---

## Configuración (solo variables de entorno)

| Variable | Obligatoria | Default | Descripción |
|---|---|---|---|
| `GHL_TOKEN` | **sí** | — | Private Integration token del sub-account Eximia. |
| `PROXY_KEY` | **sí** | — | Llave que Muse manda en `X-Proxy-Key`. Mínimo 32 caracteres y distinta de `GHL_TOKEN`. Genérala con `openssl rand -hex 32`. |
| `PORT` | no | `8080` | Puerto HTTP. Railway, Render y Fly lo inyectan solos. |
| `GHL_LOCATION_ID` | no | `L3bLLVwvhdJ7A9WqkPxM` | `locationId` que se manda por defecto al MCP. |
| `RATE_LIMIT_MAX` | no | `120` | Requests permitidos por ventana, por llave. |
| `RATE_LIMIT_WINDOW_MS` | no | `10000` | Tamaño de la ventana deslizante, en ms. |
| `UPSTREAM_TIMEOUT_MS` | no | `120000` | Inactividad máxima hacia GHL antes de responder 504. |
| `UPSTREAM_USER_AGENT` | no | Chrome 154 de escritorio | User-Agent de navegador que se envía a GHL. |
| `GHL_BASE_URL` | no | `https://services.leadconnectorhq.com` | Solo para pruebas locales contra un GHL simulado. No lo cambies en producción. |

Si falta `GHL_TOKEN` o `PROXY_KEY` (o si alguna es inválida), el proceso
**no arranca**: registra `startup_failed` con el nombre de la variable, nunca
su valor, y termina con código 1. Los espacios y saltos de línea al inicio o
al final (típicos al copiar y pegar) se recortan.

### De dónde sale el token de GHL

GoHighLevel → sub-account **Eximia** → *Settings* → *Private Integrations* → **"Muse"**.
Si el token aparece enmascarado, rótalo ahí y copia el nuevo en `GHL_TOKEN`.
**El token actual ya se expuso en un chat: rotarlo es obligatorio antes del deploy.**

Scopes mínimos de la integración para lo que usa Muse: `contacts.readonly` y
`contacts.write`, más los de las familias que use (`conversations.*`,
`opportunities.*`, `calendars.*`, `locations.readonly`…). Los scopes se pueden
editar después sin regenerar el token.

---

## Seguridad

- **HTTPS obligatorio en producción.** El proceso habla HTTP plano en `PORT` y
  siempre debe quedar detrás de TLS: el de la plataforma (Railway, Render, Fly)
  o un reverse proxy (Caddy en un VPS). Nunca expongas el puerto HTTP a internet.
- **Logs:** una línea JSON por request con `method`, `path` (sin query string,
  porque puede llevar emails o teléfonos), `status` y `ms`. Nunca se registran
  headers, bodies ni secretos. Los errores de upstream registran solo el código
  (`ECONNREFUSED`, `UPSTREAM_TIMEOUT`…).
- **Rate limit:** ventana deslizante en memoria, 120 requests / 10 s por llave
  (configurable), aplicada después de validar la llave. `/health` y los
  requests rechazados no consumen cupo. GHL tiene su propio límite: 100
  requests / 10 s y 200 000 / día por location. Sus `429` y headers
  `X-RateLimit-*` pasan intactos.
- **Host fijo:** el destino es siempre `services.leadconnectorhq.com`. Ningún
  path, query o header del cliente puede redirigir el token a otro host.
- **Contenedor:** usuario sin privilegios (`node`), `NODE_ENV=production`,
  solo dependencias de producción.
- **Rotar la llave del proxy** (o el token de GHL): genera la nueva y actualiza
  la variable. El cambio **no** se aplica solo en todas las plataformas:
  - Railway: los cambios de variables quedan *staged*; pulsa **Deploy**.
  - Render: guarda con *Save and deploy*.
  - Fly.io: `fly secrets import < .env` redepliega solo.
  - VPS: edita `.env` y ejecuta `docker compose up -d` desde `deploy/vps`
    (`docker compose restart` no relee el `env_file`).

  Comprueba con `./scripts/smoke-test.sh https://<host>` que la llave nueva da
  200 y la vieja 401. Solo entonces entrega la nueva llave a Muse por el canal
  seguro.

---

## Correr en local

Requiere Node.js ≥ 22 (en producción se usa la imagen `node:24-alpine`).

```bash
npm ci
cp .env.example .env          # rellena GHL_TOKEN y PROXY_KEY
npm run start:local           # node --env-file=.env src/server.js
curl http://localhost:8080/health
```

Con Docker:

```bash
docker build -t ghl-proxy .
docker run --rm -p 8080:8080 --env-file .env ghl-proxy
```

## Pruebas

```bash
npm test
```

Son 38 tests con `node:test`, sin dependencias extra, contra un GHL simulado.
Cubren arranque sin variables, `/health`, 401 en todas sus variantes, que la
llave nunca llegue a GHL, inyección y sobrescritura de headers, headers de
plataforma eliminados, path y query intactos, bodies (incluido chunked),
status/headers/body del upstream sin cambios (`Set-Cookie` múltiple, gzip),
HEAD/204, handshake MCP completo, SSE en streaming real, rate limit con
`Retry-After`, 502/504, `TRACE` rechazado, respuestas de upstream malformadas
sin tumbar el proceso, respuesta temprana de GHL durante un upload grande,
cancelación al desconectarse el cliente, reintento en socket keep-alive caído,
apagado limpio con conexiones keep-alive y logs sin query, headers, bodies ni
secretos.

### Prueba de aceptación contra el deploy

```bash
./scripts/smoke-test.sh https://<host>
# pide PROXY_KEY sin eco (o la toma de la variable de entorno PROXY_KEY)
```

Si pasas el host sin esquema, usa `https://`. Se niega a enviar la llave por
`http://` salvo contra `localhost`/`127.0.0.1`. Comprueba los criterios de
aceptación: `/health` → `{"ok": true, ...}`;
`GET /ghl/contacts/?locationId=L3bLLVwvhdJ7A9WqkPxM&limit=1` con llave → `200`
con contactos; sin llave y con llave incorrecta → `401`; `POST /mcp/` sin llave
→ `401`; `initialize` → JSON-RPC válido; `notifications/initialized` → `202`;
`tools/list` → lista de tools. La llave nunca se imprime ni pasa por argumentos
de línea de comandos. Termina con código 0 solo si todo pasa.

Equivalente manual:

```bash
curl -H "X-Proxy-Key: $KEY" "https://<host>/ghl/contacts/?locationId=L3bLLVwvhdJ7A9WqkPxM&limit=1"   # 200
curl "https://<host>/ghl/contacts/?locationId=L3bLLVwvhdJ7A9WqkPxM&limit=1"                          # 401
curl "https://<host>/health"                                                                          # {"ok":true,"version":"1.0.0"}
curl -H "X-Proxy-Key: $KEY" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' \
  "https://<host>/mcp/"                                                                               # event: message / data: {"result":{...},"jsonrpc":"2.0","id":1}
```

---

## Deploy 24/7

Tiene que quedar en una URL pública HTTPS siempre encendida: las
automatizaciones de Muse corren cada 10 minutos, cada hora, etc. **No** en una
laptop, y **no** en un plan que se duerma por inactividad.

Pasos comunes a cualquier plataforma:

1. Rota el token en GHL (ver arriba) y ten el nuevo a mano.
2. Genera la llave del proxy en tu máquina: `openssl rand -hex 32`. Guárdala en
   tu gestor de contraseñas. No la pegues en ningún chat ni en el repo.
3. Despliega (opciones abajo) con `GHL_TOKEN` y `PROXY_KEY` como variables
   **secretas** de la plataforma.
4. Corre `./scripts/smoke-test.sh https://<host>`: todo debe salir `PASS`.
5. Genera el handoff: `./scripts/write-connection.sh <host>` (ver [Handoff a Muse](#handoff-a-muse)).

### Opción A — Railway (recomendada)

Plan **Hobby** (USD 5/mes, incluye USD 5 de uso, suficiente para este servicio).
Los planes Free/Trial paran el servicio cuando se acaba el crédito.

1. *New Project* → *Deploy from GitHub repo* → este repositorio. Railway
   detecta el `Dockerfile` solo.
2. Servicio → **Variables**: añade `GHL_TOKEN` y `PROXY_KEY` y márcalas como
   **sealed** (no se pueden volver a leer desde la UI ni desde el API).
   Opcional: `GHL_LOCATION_ID=L3bLLVwvhdJ7A9WqkPxM`. No definas `PORT`:
   Railway lo inyecta. Despliega los cambios.
3. **Settings → Deploy**:
   - *Healthcheck Path*: `/health`.
   - *Restart Policy*: `Always`.
   - *Serverless*: **apagado** (es el default; si se enciende, el servicio
     se duerme y la primera llamada da 502).
   - Añade la variable `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15`. Por defecto
     Railway mata el deploy anterior 0 s después del SIGTERM y corta las
     llamadas en curso. Con 15 s, el apagado limpio del proxy (hasta 10 s)
     alcanza a terminarlas.
4. **Settings → Networking → Generate Domain** → `xxxx.up.railway.app`, con
   TLS automático. Para un dominio propio (p. ej. `ghl-proxy.eximia.agency`):
   *Custom Domain* y crea en tu DNS el `CNAME` y el `TXT` de verificación que
   te muestra Railway. Sin el `TXT`, el dominio responde 404.
5. Railway solo usa el healthcheck durante el deploy. Para vigilar 24/7,
   configura un monitor externo (UptimeRobot, Better Stack…) sobre
   `https://<host>/health`.

> `railway.json` / `railway.toml` (Config as Code) están deprecados: los
> servicios nuevos ya no pueden usarlos y dejan de leerse el 2026-12-01. Por
> eso este repo no los incluye y la configuración se hace en el dashboard.

Límites del edge de Railway: los requests se cortan tras 5 min sin datos
(máximo 15 min) y las conexiones HTTP/1.1 inactivas a los 60 s. El proxy
mantiene su keep-alive en 65 s para no provocar 502 intermitentes.

### Opción B — Render

1. *New* → *Web Service* → este repositorio → Language/Runtime **Docker**.
2. Plan **`0.5c-512mb`** (antes "Starter", USD 7/mes). **No uses Free**: se
   apaga tras 15 min sin tráfico y tarda ~1 min en despertar.
3. *Environment*: `GHL_TOKEN`, `PROXY_KEY` (y opcional `GHL_LOCATION_ID`).
   `PORT` lo pone Render (10000) y el proxy lo lee.
4. *Settings → Health Check Path*: `/health`.
5. Dominio: `<nombre>.onrender.com` con TLS automático. Para uno propio,
   usa *Custom Domains* con un `CNAME` al subdominio de onrender.com.

Render tiene Cloudflare delante y añade `CF-*`, `CDN-Loop`, `True-Client-IP`,
`Rndr-Id`, etc. El proxy los descarta para que no lleguen al Cloudflare de GHL.

### Opción C — Fly.io

```bash
fly launch --no-deploy --ha=false          # genera fly.toml, una sola máquina
```

Edita `fly.toml` para que nunca se apague:

```toml
[env]
  PORT = "8080"
  GHL_LOCATION_ID = "L3bLLVwvhdJ7A9WqkPxM"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    grace_period = "10s"
    interval = "30s"
    method = "GET"
    path = "/health"
    timeout = "5s"
```

```bash
cp .env.example .env && chmod 600 .env       # rellena GHL_TOKEN y PROXY_KEY
fly secrets import < .env                    # los secretos no quedan en el historial de la shell
fly deploy --ha=false
fly certs add ghl-proxy.midominio.com        # opcional, dominio propio
```

No uses `fly secrets set GHL_TOKEN=...`: el valor quedaría en el historial de
la shell y en la lista de procesos.

`fly launch` escribe por defecto `auto_stop_machines = "stop"` y
`min_machines_running = 0`, lo que apaga la máquina. Hay que cambiarlo como
arriba. Una máquina `shared-cpu-1x` de 512 MB cuesta unos USD 3/mes.

### Opción D — VPS propio (Docker + Caddy)

En `deploy/vps/` hay un `docker-compose.yml` con el proxy y **Caddy**, que
obtiene y renueva el certificado TLS solo (Let's Encrypt) y redirige
HTTP→HTTPS. Solo Caddy publica puertos (80/443); el proxy no queda expuesto
en HTTP plano.

```bash
# DNS: registro A/AAAA de ghl-proxy.midominio.com -> IP del VPS; puertos 80 y 443 abiertos.
git clone <repo> ghl-proxy && cd ghl-proxy
cp .env.example .env && chmod 600 .env        # rellena GHL_TOKEN y PROXY_KEY
cd deploy/vps
PROXY_DOMAIN=ghl-proxy.midominio.com docker compose up -d --build
```

Los contenedores se reinician solos (`restart: unless-stopped`), también
después de reiniciar el VPS si Docker arranca con el sistema
(`systemctl enable docker`).

### Nginx u otro reverse proxy propio

Si pones nginx delante en lugar de Caddy, desactiva el buffering para el MCP.
El proxy ya envía `X-Accel-Buffering: no` en las respuestas SSE, pero conviene
dejarlo explícito:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

---

## Handoff a Muse

1. `./scripts/write-connection.sh <host>` verifica `https://<host>/health` y
   escribe `CONNECTION.md` con exactamente estos campos: `middleware_host`,
   `auth_placement`, `rest_base_path`, `mcp_path`, `health_url`,
   `ghl_location_id` y `version`. No incluye ningún secreto.
2. Entrega `CONNECTION.md` a Muse.
3. Entrega la **llave del proxy** al operador humano **por separado**. Muse la
   pedirá en su tarjeta segura de credenciales. Nunca va en `CONNECTION.md`,
   nunca en un chat, nunca en el repo.

Del lado de Muse: registra el conector `custom.gohighlevel-proxy` con
`api_hosts=[middleware_host]`, adapta su skill con `bin/ghl-proxy`, verifica
`health_url` y una llamada real, y mueve sus automatizaciones al proxy.

## Notas para Muse

Comportamiento real de GHL, verificado contra `services.leadconnectorhq.com`:

- **`Version` por familia.** Contacts, locations, opportunities, payments,
  invoices, products, users, custom-fields, etc. usan `2021-07-28` (el default
  del proxy). Calendars, conversations (incluido `GET /conversations/search`),
  conversation-ai, knowledge-base, saas-api y voice-ai exigen
  `Version: 2021-04-15`, y el cliente debe mandarlo en esos casos. GHL también
  acepta `2023-02-21` y `v3`. Sin `Version`, GHL responde
  `401 version header was not found.`
- **`GET /contacts/` está deprecado** (sigue funcionando con `2021-07-28`). A
  largo plazo, usa `POST /contacts/search`.
- **Paginación:** no sigas `meta.nextPageUrl` tal cual. Apunta directo a
  `services.leadconnectorhq.com`, donde Muse no tiene token y `urllib` recibe
  el error 1010. Reconstruye la URL como
  `https://<middleware_host>/ghl/<path>?...&startAfter=...&startAfterId=...`,
  o cambia `https://services.leadconnectorhq.com` por
  `https://<middleware_host>/ghl`.
- **MCP de GHL:** no guarda estado (no emite `Mcp-Session-Id`; `initialize` es
  opcional). Toda respuesta exitosa llega como `text/event-stream`
  (`event: message` + `data: {json-rpc}`), así que siempre hay que parsear SSE.
  `GET /mcp/` → `405`, `DELETE` → `404`. Versiones de protocolo:
  `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`.
- **`initialize` y `tools/list` funcionan con cualquier token.** Para validar
  el token de verdad, usa un `tools/call` (p. ej. `locations_get-location`) o
  la llamada REST de contactos. Un token inválido en `tools/call` llega como
  HTTP 200 con `result.isError = true` y el detalle
  (`"status": 401, "Invalid Private Integration token"`) dentro de
  `content[0].text`.
- Los argumentos de las tools del MCP usan prefijos `path_`, `query_` y
  `body_` (p. ej. `path_contactId`). Usa los nombres de `tools/list`, no los de
  la documentación de ayuda.

## Estructura

```
src/
  server.js      arranque, timeouts, apagado limpio (SIGTERM)
  app.js         rutas: /health, auth, rate limit, /ghl, /mcp
  proxy.js       reenvío en streaming (headers, body, errores, reintento keep-alive)
  config.js      variables de entorno y validación
  auth.js        X-Proxy-Key en tiempo constante
  http-util.js   respuestas JSON propias del proxy (sendJson)
  rate-limit.js  ventana deslizante en memoria
  logger.js      logs JSON: method, path, status, ms
test/            node:test + GHL simulado
scripts/
  smoke-test.sh        aceptación contra el deploy
  write-connection.sh  genera CONNECTION.md
deploy/vps/      docker-compose + Caddy (TLS automático) para un VPS
Dockerfile       imagen node:24-alpine, usuario sin privilegios, HEALTHCHECK
```
