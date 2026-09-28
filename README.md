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
- **Panel del operador** en `https://<host>/admin` (con PIN): estado en vivo,
  velocidad, permisos del token y los datos para conectar Muse, listos para
  copiar. Ver [Panel del operador](#panel-del-operador).
- **Velocidad:** el proxy añade menos de 1 ms. Ver [Velocidad](#velocidad).
- **Kraken (opcional):** el mismo servicio firma llamadas de solo lectura a la
  API privada de Kraken para Muse, con su propia llave. Si no se configura, no
  cambia nada de GoHighLevel. Ver [Kraken](#kraken).
- **GoHighLevel Agencia (opcional):** una API aparte, con el token de la
  **agencia** y su propia llave, para que Muse administre toda la agencia
  (subcuentas, usuarios, snapshots, SaaS…). Ver [GoHighLevel Agencia](#gohighlevel-agencia).
- **Stripe (opcional):** otra API aparte, con su propia llave, para que Muse
  trabaje con la cuenta de Stripe; bloquea por defecto lo que saca dinero o da
  accesos permanentes. Ver [Stripe](#stripe).

---

## Endpoints

| Ruta | Auth | Qué hace |
|---|---|---|
| `GET /health` | no | `{"ok": true, "version": "1.0.0"}` |
| `ALL /ghl/*` | `X-Proxy-Key` | Quita `/ghl` y reenvía método, path, query string (sin tocar su codificación), headers y body a `https://services.leadconnectorhq.com/<path>`. Devuelve status, headers y body del upstream tal cual. |
| `POST /mcp/` | `X-Proxy-Key` | Reenvía el JSON-RPC a `https://services.leadconnectorhq.com/mcp/` (MCP streamable HTTP) y devuelve la respuesta en streaming (SSE). `/mcp` sin barra final funciona igual. Otros métodos (`GET`, `DELETE`…) también se reenvían y GHL decide la respuesta (hoy `405`/`404`). |
| `TRACE /ghl/*`, `TRACE /mcp/` | `X-Proxy-Key` | `405 {"error": "method_not_allowed"}`. `TRACE` devuelve los headers recibidos, así que reenviarlo podría exponer el token de GHL inyectado. |
| `POST /api/kraken`, `GET /api/kraken?health=1` | llave de Kraken | Ver [Kraken](#kraken). Independiente de todo lo de GHL. |
| `ALL /agency/*` | llave de agencia | Como `/ghl/*`, pero con el token de la **agencia**. Ver [GoHighLevel Agencia](#gohighlevel-agencia). |
| `GET/POST/DELETE /stripe/v1/*`, `/stripe/v2/*` | llave de Stripe | Stripe con la clave del servidor. Ver [Stripe](#stripe). |
| `/admin`, `GET /` | PIN (sesión) | Panel del operador. Solo existe si `ADMIN_PIN` está definido; `GET /` redirige a `/admin`. Sin `ADMIN_PIN`, estas rutas responden `401` como cualquier otra. |
| cualquier otra | `X-Proxy-Key` | `404 {"error": "not_found"}` |

**Autenticación:** todo request, excepto `/health` (y el panel `/admin`, que
usa su propio PIN), debe traer
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
| `ADMIN_PIN` | no | — | Activa el panel `/admin`. Entre 6 y 64 caracteres; se recomiendan **8 dígitos**. Sin él, el panel no existe. |
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

Son 48 tests con `node:test`, sin dependencias extra, contra un GHL simulado.
Cubren arranque sin variables, `/health`, 401 en todas sus variantes, que la
llave nunca llegue a GHL, inyección y sobrescritura de headers, headers de
plataforma eliminados, path y query intactos, bodies (incluido chunked),
status/headers/body del upstream sin cambios (`Set-Cookie` múltiple, gzip),
HEAD/204, handshake MCP completo, SSE en streaming real, rate limit con
`Retry-After`, 502/504, `TRACE` rechazado, respuestas de upstream malformadas
sin tumbar el proceso, respuesta temprana de GHL durante un upload grande,
cancelación al desconectarse el cliente, reintento en socket keep-alive caído,
apagado limpio con conexiones keep-alive y logs sin query, headers, bodies ni
secretos. Además, el panel: PIN, bloqueo progresivo, cookies de sesión
(falsificadas, alteradas o vencidas), CSRF/origen, cabeceras de seguridad,
llave solo con sesión, `CONNECTION.md` exacto sin secretos, verificaciones en
vivo contra un GHL simulado y PIN fuera de los logs.

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
   Añade también `ADMIN_PIN` (sealed) para el panel. Opcional:
   `GHL_LOCATION_ID=L3bLLVwvhdJ7A9WqkPxM`. No definas `PORT`:
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

### Opción E — Vercel (serverless)

Proyecto actual: **`ghl-proxy-muse`** (equipo EXIMIA) →
`https://ghl-proxy-muse.vercel.app`, región `iad1` (US East), Node 24.
Vercel ejecuta el `app.js` de la raíz (exporta la app Express). `src/server.js`
no se usa ahí.

1. *Settings → Environment Variables* (entorno **Production**, tipo
   **Sensitive**): `GHL_TOKEN`, `PROXY_KEY`, `ADMIN_PIN` y, opcional,
   `GHL_LOCATION_ID`.
2. *Deployments → … → Redeploy*. Los cambios de variables solo se aplican
   al redesplegar.
3. Abre `https://ghl-proxy-muse.vercel.app/admin` y pulsa **Verificar ahora**.

Diferencias con un servidor siempre encendido (Railway, VPS):

- **Arranque en frío:** tras un rato sin tráfico, la primera llamada tarda
  algo más mientras Vercel levanta la función. Las siguientes van a la
  velocidad normal. Si Muse necesita latencia mínima constante, usa
  Railway o un VPS.
- El rate limit, el bloqueo del PIN y las métricas del panel son **por
  instancia**. Vercel puede tener varias a la vez, así que las cifras del
  panel son parciales y los límites, aproximados. Con un PIN de 8 dígitos
  al azar la fuerza bruta sigue siendo inviable.
- La sesión del panel se firma con una clave derivada de `PROXY_KEY` +
  `ADMIN_PIN`, así que vale en cualquier instancia. **Salir** borra la
  cookie en tu navegador; la invalidación en servidor es por instancia.
  Cambiar el PIN o la llave cierra todas las sesiones.
- Los headers internos de Vercel (`x-vercel-*`, `x-matched-path`…) nunca se
  reenvían a GHL.

### Nginx u otro reverse proxy propio

Si pones nginx delante en lugar de Caddy, desactiva el buffering para el MCP.
El proxy ya envía `X-Accel-Buffering: no` en las respuestas SSE, pero conviene
dejarlo explícito:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;                 # CONNECTION.md y el panel usan el host real
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;  # cookie Secure y HSTS del panel
    proxy_buffering off;
    proxy_read_timeout 300s;
}
```

---

## Panel del operador

`https://<host>/admin`: un panel pensado para el celular, protegido con PIN.
No hay usuario ni contraseña. Se activa definiendo `ADMIN_PIN` en la
plataforma (por ejemplo, 8 dígitos que solo tú conozcas).

Arriba hay un selector con cuatro pestañas: **GHL Eximia** (esta sección),
**GHL Agencia** (ver [GoHighLevel Agencia](#gohighlevel-agencia)),
**Kraken** (ver [Kraken](#kraken)) y **Stripe** (ver [Stripe](#stripe)).

Qué muestra:

- **Estado:** verifica en vivo el token de GHL (y el nombre del sub-account),
  una llamada REST y otra MCP hechas igual que las hará Muse, y que sin llave
  se rechace. Resultado: *Todo funciona* / *Con avisos* / *Hay un problema*.
- **Velocidad:** la misma llamada directa a GHL y por el proxy, intercaladas,
  más lo que añade el proxy medido sobre el tráfico real (mediana y p95).
- **Conectar Muse:** `CONNECTION.md` generado con el host real (copiar o
  descargar), la llave del proxy (oculta; *Mostrar* / *Copiar*, se vuelve a
  ocultar sola) y qué verificará Muse.
- **Permisos del token:** qué familias de GHL puede leer (contactos,
  conversaciones, oportunidades, calendarios, usuarios, workflows). Solo hace
  lecturas.
- **Seguridad** y **Actividad reciente:** método, ruta, estado y tiempos de
  las últimas llamadas, más contadores de rechazos y errores. Nunca muestra
  headers, bodies ni la query.

Cómo se protege:

- El PIN se compara en tiempo constante y nunca se registra en logs.
- **Bloqueo progresivo global:** tras 5 PIN incorrectos, cada fallo bloquea
  el acceso 30 s, luego 1, 2, 4… minutos, hasta 1 h, incluso con el PIN
  correcto. Con 8 dígitos, adivinarlo por fuerza bruta llevaría siglos. Es
  global (no por IP), así que cambiar de IP no ayuda. Si alguien lo está
  bloqueando a propósito, el proxy de Muse sigue funcionando igual. Un
  redeploy desbloquea el panel.
- **Sesión** en cookie `HttpOnly`, `Secure`, `SameSite=Strict`, firmada con
  una clave aleatoria por proceso. Dura 12 h. **Salir** la invalida en el
  servidor (una copia de la cookie deja de servir). Reiniciar el servicio
  (por ejemplo, al cambiar el PIN) cierra todas las sesiones.
- **PIN débiles rechazados al arrancar:** dígitos repetidos (`000000`),
  secuencias (`123456`, `98765432`), patrones repetidos (`121212`, `123123`)
  y PIN comunes. Usa 8 dígitos al azar.
- Las acciones solo se aceptan con JSON del mismo origen (anti-CSRF). La CSP
  es estricta (sin scripts inline ni recursos externos), el panel no se puede
  embeber en otra página (anti-clickjacking) y va con `no-store` y HSTS.
- El token de GHL nunca sale del servidor. El panel muestra solo sus últimos
  4 caracteres. La llave del proxy solo se entrega a una sesión válida.
- Las pruebas del panel se marcan con un header interno que nunca se reenvía
  a GHL y no cuentan como intentos rechazados.

Cambiar el PIN: actualiza `ADMIN_PIN` en la plataforma y redepliega.

## Velocidad

El proxy no añade latencia apreciable:

- Reenvía en streaming (no espera el body completo) y reutiliza conexiones
  TLS con GHL (keep-alive).
- Mide su propio tiempo en cada llamada; el panel lo muestra.

Medición real (2026-09-27, token real, `GET /contacts/?limit=1`, 25 rondas
intercaladas, tiempo hasta el body completo):

| Modo | p50 | p90 |
|---|---|---|
| Directo a GHL, conexión nueva por llamada (como `urllib`) | 137 ms | 188 ms |
| Directo a GHL, reutilizando conexión | 103 ms | 238 ms |
| **Por el proxy**, conexión nueva por llamada (como `urllib`) | **102 ms** | **121 ms** |
| **Por el proxy**, reutilizando conexión | **101 ms** | 341 ms |

Tiempo propio del proxy medido en tráfico real: **< 1 ms de mediana, 2 ms en
p95**. Para un cliente tipo `urllib`, que abre una conexión nueva en cada
llamada, el proxy resulta incluso más rápido que ir directo, porque la
conexión con GHL ya está abierta. Los picos de p90 vienen de GHL: aparecen
igual yendo directo.

En producción se suma un salto de red Muse → proxy. Para que sea mínimo,
despliega el proxy en una región de **EE. UU. (p. ej. US East)**, cerca de
Muse y del edge de GHL.

### Medición en producción (Vercel, `iad1`, 2026-09-27, token real)

| Medición | Resultado |
|---|---|
| Tiempo propio del proxy por llamada (panel, 3 corridas) | **0,47–0,63 ms** |
| Desde dentro de Vercel: GHL directo vs. por la URL pública del proxy | 90 ms vs. 108 ms (**+14 a 18 ms**, dentro de la variación de GHL: 19–39 ms) |
| Arranque en frío: primera llamada tras 10,5 min sin tráfico | ~+30 ms respecto a una llamada normal |
| Desde un cliente lejano (entra por el edge de Vercel en `sfo1`, función en `iad1`) | 142 ms directo vs. 310 ms por el proxy (conexión nueva por llamada) |

Conclusión: el código del proxy añade menos de 1 ms. Lo que puede sumarse
es **la distancia de red** entre Muse y la región del proxy:

- Si Muse corre en EE. UU. Este, `iad1` es la región correcta (unos +15 ms).
- Si corre en otro lugar, elige la región de Vercel más cercana a Muse
  (*Settings → Functions → Region*).
- Si Muse reutiliza conexiones (`requests.Session` o `http.client`
  persistente en lugar de `urllib` sin más), se ahorra el TLS en cada
  llamada: ~90 ms menos desde lejos.

## Handoff a Muse

0. Lo más fácil: abre `https://<host>/admin`, entra con el PIN y usa la
   sección **Conectar Muse** (copiar `CONNECTION.md` y la llave). Los pasos 1–3
   son la alternativa por terminal.
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

## Kraken

Muse también puede leer la cuenta de **Kraken** a través de este mismo
servicio. La API privada de Kraken no acepta una llave simple: cada llamada
debe ir **firmada** con la *Private key*. El proxy guarda tus dos claves de
Kraken, firma cada llamada y le da a Muse **una sola llave** para usarlo.

```
Muse --(X-Proxy-Key: llave de Kraken)--> /api/kraken --(API-Key + API-Sign)--> api.kraken.com
```

Es una parte aparte de GoHighLevel: otra llave, otro límite, otros errores.
Si las claves de Kraken faltan o están mal, `/api/kraken` responde `503` y
GoHighLevel sigue exactamente igual.

### Configurarlo (unos 5 minutos, sin tocar código)

El panel (`/admin` → pestaña **Kraken**) muestra estos mismos pasos.

1. **Crea una API key en Kraken, solo para Muse.** Kraken → tu perfil →
   **Settings → API** → **Create API key**. Nombre: `Muse`. Permisos:
   - ✓ **Query Funds**
   - ✓ **Query Open Orders & Trades**
   - ✓ **Query Closed Orders & Trades**
   - ✓ **Query Ledger Entries**
   - ✕ Todo lo demás **desmarcado**: sobre todo **Withdraw Funds**, y también
     Deposit, Earn, Create & Modify Orders y Cancel/Close Orders.
   - En **Advanced**: **Nonce Window = `10000`** (ver [Nonce](#nonce)).
   - **Lista de IPs:** déjala vacía en Vercel. Vercel no tiene una IP de salida
     fija, así que una lista de IPs haría fallar llamadas al azar. Si lo
     despliegas en un VPS propio (IP fija), sí puedes y conviene restringirla
     a esa IP.
   - Kraken muestra la **Private key** una sola vez: tenla a mano para el
     paso 2. Usa esta llave solo para Muse (no la compartas con otra app o
     bot).
2. **Pégalas en Vercel, nunca en un chat.** Vercel → proyecto
   `ghl-proxy-muse` → **Settings → Environment Variables** → añade, en
   **Production** y marcadas como **Sensitive**:

   | Variable | Valor |
   |---|---|
   | `KRAKEN_API_KEY` | la **API key** de Kraken |
   | `KRAKEN_API_SECRET` | la **Private key** de Kraken (tal cual, en base64) |

3. **Redeploy:** Vercel → **Deployments** → el último → **⋯ → Redeploy**.
4. Abre el panel → **Kraken** → **Verificar ahora**. Todo debe salir en verde:
   claves válidas, firma PASS, sin llave no entra nadie, retiros bloqueados y
   un `Balance` de prueba a través de la dirección pública.
5. **Conectar Muse:** pulsa **Copiar mensaje para Muse**, pégalo en Muse y,
   cuando te pida la llave, cópiala con **Copiar llave** y pégala en su
   tarjeta segura.

### Variables de entorno de Kraken

| Variable | Obligatoria | Qué es |
|---|---|---|
| `KRAKEN_API_KEY` | sí | API key pública de Kraken. |
| `KRAKEN_API_SECRET` | sí | Private key de Kraken, en base64. |
| `ENABLE_TRADING` | no | Solo si vale exactamente `true` se permiten los métodos de trading. Cualquier otro valor (o vacío) = solo lectura. |
| `KRAKEN_PROXY_KEY` | no | Llave de Muse para Kraken (32+ caracteres). Si no la pones, se genera sola a partir de tus dos claves. Úsala solo si quieres cambiar la llave de Muse sin cambiar las claves de Kraken. Debe ser distinta de `PROXY_KEY`. |
| `KRAKEN_PUBLIC_HOST` | no | Dirección que el panel da a Muse para Kraken (p. ej. `kraken-proxy-muse.vercel.app`). Vacía = la del panel. |

**Sobre el nombre de la llave:** la especificación original de Kraken la llama
`PROXY_KEY`, pero ese nombre ya es la llave de GoHighLevel. Para que una llave
nunca abra el otro servicio, la de Kraken es independiente: por defecto se
**deriva** de tus dos claves de Kraken (HKDF-SHA256, de un solo sentido:
conocerla no revela la Private key) o se toma de `KRAKEN_PROXY_KEY`. Cambiar
las claves de Kraken cambia la llave de Muse; el panel siempre muestra la
vigente.

### La API para Muse

- `GET /api/kraken?health=1` → `{"ok": true}` (sin llave; `503` si faltan las claves).
- `POST /api/kraken` con `X-Proxy-Key: <llave de Kraken>` y
  `{"method": "Balance", "params": {}}` → el JSON de Kraken tal cual
  (`{"error": [...], "result": {...}}`), con el mismo status HTTP.

```bash
HOST=https://ghl-proxy-muse.vercel.app
read -rs -p "Llave de Kraken: " KKEY; echo

# Salud (sin llave)
curl -s "$HOST/api/kraken?health=1"

# Saldo
curl -s -X POST "$HOST/api/kraken" \
  -H "X-Proxy-Key: $KKEY" -H "Content-Type: application/json" \
  -d '{"method":"Balance"}'

# Movimientos de bitcoin (con parámetros; los números van como texto)
curl -s -X POST "$HOST/api/kraken" \
  -H "X-Proxy-Key: $KKEY" -H "Content-Type: application/json" \
  -d '{"method":"Ledgers","params":{"asset":"XXBT","start":"1735689600"}}'

# Debe dar 403: los retiros están bloqueados siempre
curl -s -X POST "$HOST/api/kraken" \
  -H "X-Proxy-Key: $KKEY" -H "Content-Type: application/json" \
  -d '{"method":"Withdraw","params":{}}'
```

**Métodos permitidos (solo lectura, siempre):** `Balance`, `TradeBalance`,
`OpenOrders`, `ClosedOrders`, `QueryOrders`, `TradesHistory`, `QueryTrades`,
`OpenPositions`, `Ledgers`, `QueryLedgers`, `TradeVolume`, `DepositMethods`,
`DepositAddresses` (solo direcciones existentes: con `new` o `amount` da
`403`, porque crean una dirección o una factura Lightning), `DepositStatus`,
`WithdrawStatus`, `WithdrawInfo`.

**Trading (solo con `ENABLE_TRADING=true`):** `AddOrder`, `AmendOrder`,
`CancelOrder`, `CancelAll`, `CancelAllOrdersAfter`, `AddOrderBatch`,
`CancelOrderBatch` y `GetWebSocketsToken`.

> **Cambio respecto a la especificación original:** `GetWebSocketsToken`
> estaba en la lista de solo lectura. No opera por sí mismo, pero el token que
> devuelve lleva los permisos de la API key: si la llave pudiera operar, Muse
> podría crear órdenes por WebSockets, saltándose esta lista y
> `ENABLE_TRADING`. Por eso solo se permite con el trading activado. Muse no
> lo necesita para leer (todo está en REST).
>
> Si activas el trading: un `502`/`504` en una orden **no** significa que no
> se creó (Kraken pudo recibirla). El proxy nunca reenvía una orden con
> resultado dudoso: la busca en Kraken y dice en `proxy.executed` si se creó
> (ver [Fiabilidad](#fiabilidad-reintentos-seguros-y-qué-pasó-exactamente)).

**Nunca, en ninguna configuración:** `Withdraw`, `WithdrawCancel`,
`WalletTransfer`, `AccountTransfer`, `CreateSubaccount`, `Earn/Allocate`,
`Earn/Deallocate` y cualquier otro nombre con *withdraw*, *transfer* o
*allocate* que no esté en la lista de lectura. Cualquier método que no esté en
las listas de arriba también se rechaza (`403`). Los nombres se comparan
exactos (mayúsculas incluidas) y la ruta hacia Kraken se construye siempre
desde la lista, nunca desde el texto recibido.

Los precios y datos de mercado (`Ticker`, `OHLC`…) son públicos: Muse los pide
directo a `https://api.kraken.com/0/public/...`, sin el proxy.

### Errores propios (formato de Kraken)

Para que Muse trate igual los errores del proxy y los de Kraken, el proxy
responde con `{"error": ["EProxy:..."], "proxy": {...}}` (con la explicación en
`proxy.summary`) y nunca llama a Kraken en estos casos:

| Status | Cuándo |
|---|---|
| `400` | El cuerpo no es un objeto JSON, `method` no es texto, `params` no es un objeto, un parámetro no es texto/número/booleano, o incluye `nonce` (lo pone el proxy). |
| `401` | Falta la llave o no coincide (comparación en tiempo constante). |
| `403` | Método fuera de la lista, trading desactivado, retiros/transferencias, o `DepositAddresses` con `new=true`. |
| `405` | `GET` sin `?health=1` u otro verbo. |
| `413` | Cuerpo de más de 64 KB. |
| `429` | Más de 60 llamadas por minuto desde la misma IP (`Retry-After`). Las llamadas con llave correcta y las que no la traen se cuentan por separado, así los intentos fallidos nunca gastan el cupo de Muse. |
| `502` / `504` | Kraken no respondió o respondió algo que no es JSON. En órdenes, `proxy.executed` dice lo que el proxy comprobó. |
| `503` | Faltan o están mal las claves de Kraken en el servidor. |

Todas las respuestas llevan `Cache-Control: no-store`.

El límite de 60/min vive en la memoria de cada instancia: en Vercel, con
varias instancias a la vez, el total puede ser algo mayor (el límite real lo
pone Kraken, que es más estricto). En Vercel la IP es la del cliente real;
fuera de Vercel (Docker detrás de otro proxy) todas las llamadas pueden
compartir la IP del proxy de delante, y el límite pasa a ser global.

Si Muse cuelga (o su plataforma corta) mientras su llamada espera turno, esa
llamada ya no se firma ni se envía a Kraken.

### Fiabilidad: reintentos seguros y «qué pasó exactamente»

**Reintentos automáticos (solo cuando es seguro).** El proxy repite una llamada sin que Muse
tenga que hacer nada en estos casos:

| Situación | Lecturas y cancelaciones | Órdenes (AddOrder, AddOrderBatch, AmendOrder) |
|---|---|---|
| `EAPI:Invalid nonce` (Kraken no ejecutó nada) | hasta 2 veces | hasta 2 veces, con el mismo `cl_ord_id` |
| `EAPI:Rate limit exceeded`, `EService:Throttled`, `EGeneral:Too many requests` | 1 vez tras 4–13 s | 1 vez tras 4 s |
| `EOrder:Rate limit exceeded` (por par) | — | hasta 2 veces (2 s y 4 s) |
| La conexión no llegó a abrirse (la petición no salió) o Cloudflare 521/523/525/526 | hasta 2 veces | hasta 2 veces |
| `EService:Unavailable/Busy/Deadline elapsed`, `EGeneral:Internal error`, 5xx, timeout o corte después de enviar | hasta 2 veces (no si Kraken está en mantenimiento) | **nunca**: se comprueba (abajo) |

Todo dentro de un tiempo máximo por llamada, contando la espera en la cola del proxy: 25 s
lecturas y cancelaciones; 30 s órdenes, de los que se reservan 9 s para comprobar qué pasó
si la respuesta se pierde. Cada orden viaja por una conexión nueva, así un fallo al conectar
demuestra que no se envió. Si Muse cuelga, el proxy no envía más reintentos.

**Órdenes con resultado dudoso.** Cada orden lleva un `cl_ord_id` (el de Muse, o un UUID que
añade el proxy). Si la respuesta se pierde o es ambigua, el proxy **no la reenvía**: la busca
en `OpenOrders` y `ClosedOrders` unos 2 s y 5 s después (una orden sola, filtrando por su
`cl_ord_id`) y responde:
- encontrada → `executed: "yes"`, con txid y estado;
- no encontrada → `executed: "unknown"` y el resumen lo dice («no aparece N s después, lo más
  probable es que no se creara»). No se da como un «no» seguro porque Kraken aún podría procesar
  una orden que le llegó con retraso; `next` le dice a Muse que espere ~60 s, la busque otra vez
  y solo entonces la reenvíe con el mismo `cl_ord_id` (que evita la copia mientras la primera
  siga abierta, no si ya se ejecutó);
- no se pudo comprobar → `"unknown"`, no reenviar sin buscarla.

Con `userref` (Kraken no lo trata como único) el proxy exige además el mismo lado, tipo,
volumen y precio, y una sola coincidencia; si hay varias, responde `"unknown"` con las
candidatas. Se rechazan `userref` 0 y los lotes con identificadores repetidos.

**Cancelaciones repetidas.** Si el primer intento de una cancelación se quedó sin respuesta y
el reintento ya no encuentra nada que cancelar, el proxy no dice «no se canceló»: consulta la
orden (CancelOrder) o responde `"unknown"` (CancelAll y lotes).

**El campo `proxy`.** Toda respuesta con error, y toda llamada de trading, lleva junto a
`error`/`result` de Kraken un objeto `proxy` con: `summary` (qué pasó, en español), `executed`,
`next` (qué hacer), `retry.safeToRetry` y `afterSeconds`, `order`/`orders` (txid, estado,
`vol_exec`, `reason`), `changes` (lo que el proxy ajustó), `krakenError` (texto original),
`attempts`, `pair` (reglas del par cuando explican el rechazo) y `krakenStatus`. Las lecturas
que salen bien se devuelven tal cual, sin `proxy`.

**Ajustes antes de enviar** (siempre listados en `proxy.changes`):
- `validate` solo se envía si es claramente sí (`true`, `"true"`, `1`): Kraken trata *cualquier*
  valor como «solo validar», así que `false`, `"false"`, `0`, `"no"` no se envían (la orden se
  crea) y un valor dudoso da 400. Los demás `false` se omiten porque ya son el valor por
  defecto (salvo `consolidate_taker`, cuyo defecto es `true`).
- Los números salen en decimal (`0.0000001`, nunca `1e-7`; `.5` → `0.5`); en lotes, `volume` y
  `price` van como texto.
- `cl_ord_id` y `userref` se validan (formato de Kraken; no se pueden usar juntos).

**Otros casos.** Una cancelación que da `EOrder:Unknown order` se explica consultando la orden
(p. ej. «ya se había ejecutado», o «sigue abierta: repítela»). Tras `EGeneral:Temporary lockout`,
el proxy deja de llamar a Kraken 15 minutos, porque cada intento reinicia el bloqueo (por
instancia: en Vercel otra instancia podría hacer alguna llamada más, por eso a Muse también se
le dice que espere). Con los errores de mínimos,
decimales o modo del par, el proxy añade las reglas del par (`AssetPairs`); con
`EService:*`, el estado de Kraken (`SystemStatus`).

**Panel.** Con el trading activado, «Verificar ahora» envía por la dirección pública una orden
de prueba con `validate=true` (Kraken la valida y no la crea; precio muy por debajo del
mercado y, si Kraken devolviera un txid, se cancela al momento). También muestra el estado de
Kraken y si el proxy está en pausa por un bloqueo.

### Firma

`API-Sign = base64(HMAC-SHA512(base64decode(private key), ruta + SHA256(nonce + cuerpo)))`,
con la ruta desde `/0/private/...` y el `nonce` como primer parámetro del
cuerpo `application/x-www-form-urlencoded` (exactamente como el ejemplo
oficial). Para `AddOrderBatch` y `CancelOrderBatch`, que llevan una lista de
órdenes, el cuerpo va en JSON y se firma ese mismo texto.

`node test-sign.js` comprueba la firma contra el ejemplo oficial de Kraken y
que el cuerpo que arma el proxy es idéntico al del ejemplo. Debe imprimir
`PASS`. El panel repite esa comprobación en el servidor en vivo.

### Nonce

Kraken exige que el `nonce` de cada llamada con una misma API key sea mayor
que el anterior, y no se puede reiniciar. El proxy usa milisegundos
(`Date.now()`), nunca repite ni retrocede, y dentro de cada instancia envía
las llamadas a Kraken de una en una y en orden. En Vercel puede haber varias
instancias a la vez, y dos llamadas casi simultáneas podrían llegar a Kraken
en desorden. Por eso:

- la API key se crea con **Nonce Window = 10000** (tolera 10 s de desorden);
- si Kraken responde `EAPI:Invalid nonce`, el proxy reintenta hasta 2 veces
  con un nonce nuevo. Es seguro también en órdenes: Kraken rechaza la llamada
  antes de ejecutar nada (ver [Fiabilidad](#fiabilidad-reintentos-seguros-y-qué-pasó-exactamente));
- la llave es **solo para Muse**: si otra app o bot la usa con otro tipo de
  nonce, deja de funcionar aquí (hay que crear otra).

### Seguridad de Kraken

- Las claves de Kraken solo viven en variables de entorno del servidor. No
  están en el código, no se escriben en archivos y no se registran en los
  logs. Tampoco la llave de Muse ni las firmas: los logs de Kraken guardan
  solo el nombre del método, el código de error de Kraken y el tiempo.
- El panel nunca muestra saldos ni el IBAN que devuelve Kraken; de
  `GetApiKeyInfo` solo usa los permisos, el nonce window, la caducidad y si
  hay lista de IPs.
- El panel marca en rojo (y el estado general deja de estar en verde) si la
  API key tiene permisos de retiro, y en amarillo si puede operar mientras el
  trading está desactivado.
- Las pruebas del panel contra `/api/kraken` llevan una marca derivada de la
  Private key (solo el servidor puede calcularla): ni la llave de GHL ni la de
  Kraken permiten saltarse el límite ni esconder llamadas de la actividad.
- La llave de GoHighLevel no abre Kraken y la de Kraken no abre GoHighLevel.
- Si la llave de Muse para Kraken se filtra: crea una API key nueva en
  Kraken, borra la anterior, cambia `KRAKEN_API_KEY` y `KRAKEN_API_SECRET` en
  Vercel y haz Redeploy. La llave de Muse cambia sola.

### Despliegue desde cero (otra cuenta de Vercel)

Es el mismo proyecto que GoHighLevel (ver [Opción E — Vercel](#opción-e--vercel-serverless)):
no hay nada extra que desplegar. Basta con añadir las variables de Kraken y
hacer Redeploy. Sin Vercel (Docker/VPS), igual: las mismas variables en el
`.env`.

## GoHighLevel Agencia

Una **segunda API de GoHighLevel**, separada de la de Eximia, para que Muse
administre **toda la agencia**. Usa el token de una Private Integration creada
en la **agencia** (no en una subcuenta) y le da a Muse **otra llave**.

```
Muse --(X-Proxy-Key: llave de agencia)--> /agency/* --(Bearer <token de agencia>)--> services.leadconnectorhq.com/*
```

- `/agency/<ruta>` funciona igual que `/ghl/<ruta>`: método, query, headers y
  cuerpo pasan tal cual, y la respuesta de GHL vuelve tal cual.
- Otra llave, otro límite y otra actividad en el panel. La llave de Eximia no
  abre `/agency`, y la de agencia no abre `/ghl`, `/mcp` ni Kraken.
- Sin el token de agencia, `/agency` responde `503 agency_not_configured` y
  todo lo demás sigue exactamente igual.
- No hay MCP en esta API (el MCP de GHL es por subcuenta): solo REST.

### Qué puede y qué no puede hacer

**Puede** todo lo que GoHighLevel permite a un token de agencia: buscar,
ver, crear y modificar subcuentas (`/locations/…`), usuarios (`/users/…`),
snapshots, SaaS (planes, suscripciones, pausar, rebilling), datos de la
agencia (`/companies/{companyId}`), menús personalizados, contratos y
documentos.

**No puede** leer ni cambiar datos **dentro** de las subcuentas (contactos,
conversaciones, oportunidades, calendarios, workflows…). Es un límite de
GoHighLevel, no del proxy: esas rutas solo aceptan un token de subcuenta, y
GHL responde `401 The token is not authorized for this scope` al de agencia.
Para Eximia, Muse sigue usando `/ghl` y `/mcp`. Para datos dentro de otra
subcuenta hace falta un token de esa subcuenta.

**Borrar subcuentas** (`DELETE /locations/{id}`) está **bloqueado** en el
proxy porque no se puede deshacer: responde `403 blocked_by_proxy` y no llega
a GHL. El bloqueo compara la ruta ya normalizada (mayúsculas, `%xx`, `//`,
`.`/`..`), así que no se salta escribiéndola de otra forma. Solo se permite si
`GHL_AGENCY_ALLOW_DELETE=true`. Todo lo demás pasa; el mensaje para Muse le
pide confirmar contigo cada cambio antes de hacerlo.

**Version:** si Muse no envía `Version`, el proxy pone `2021-07-28`, y
`2021-04-15` en `/saas/*` y `/saas-api/*` (lo que exige GHL). Muse puede
enviar `Version: v3` para las rutas v3.

### Configurarlo (unos 5 minutos, sin tocar código)

El panel (`/admin` → pestaña **GHL Agencia**) muestra estos mismos pasos.

1. **Crea una Private Integration en la agencia.** En GoHighLevel cambia a
   la vista de **Agencia** → **Settings → Private Integrations** → **Create
   new Integration**. Nombre: `Muse Agencia`. Marca **todos** los permisos
   que aparezcan (`companies.readonly`, `locations.readonly/write`,
   `users.readonly/write`, `snapshots.readonly/write`, `saas/*`,
   `custom-menu-link.*`, …). Hace falta el plan **Agency Pro**. GHL muestra el
   token (`pit-…`) una sola vez.
2. **Pégalo en Vercel, nunca en un chat.** Proyecto `ghl-proxy-muse` →
   **Settings → Environment Variables** → `GHL_AGENCY_TOKEN`, en
   **Production** y marcada como **Sensitive**.
3. **Redeploy** y, en el panel → **GHL Agencia** → **Verificar ahora**. El
   panel lee el ID de la agencia a través de la subcuenta Eximia
   (`GET /locations/{Eximia}` → `location.companyId`), prueba cada permiso
   con una lectura, comprueba que las llaves están separadas y, si pusiste
   `GHL_AGENCY_PUBLIC_HOST`, que esa dirección responde (solo con `/health`:
   la llave y las marcas internas del panel nunca salen hacia esa dirección).
4. **Conectar Muse:** **Copiar mensaje para Muse** → pégalo en Muse; cuando
   pida la llave de la agencia, **Copiar llave** → su tarjeta segura.

### Variables de entorno de la agencia

| Variable | Obligatoria | Qué es |
|---|---|---|
| `GHL_AGENCY_TOKEN` | sí | Token de la Private Integration de la **agencia**. Debe ser distinto de `GHL_TOKEN`. |
| `GHL_AGENCY_PROXY_KEY` | no | Llave de Muse para la agencia (32+ caracteres). Vacía = se deriva del token (HKDF-SHA256, de un solo sentido). Debe ser distinta de las demás llaves, tokens y del PIN. |
| `GHL_AGENCY_PUBLIC_HOST` | no | Dirección que el panel da a Muse para la agencia (p. ej. `ghl-agency-muse.vercel.app`). Vacía = la del panel. |
| `GHL_COMPANY_ID` | no | ID de la agencia. Vacío = el panel lo lee solo. |
| `GHL_AGENCY_ALLOW_DELETE` | no | Solo `true` permite borrar subcuentas. Vacío = bloqueado. |

El límite de llamadas es el mismo número que el de Eximia (`RATE_LIMIT_MAX`
cada `RATE_LIMIT_WINDOW_MS`), pero con su propio contador.

## Stripe

Una API aparte para que Muse trabaje con la cuenta de **Stripe**. El proxy
guarda la clave de Stripe y le da a Muse **otra llave**.

```
Muse --(X-Proxy-Key: llave de Stripe)--> /stripe/v1/* --(Bearer <clave de Stripe>)--> api.stripe.com/v1/*
```

- `/stripe/<ruta>` va a `https://api.stripe.com/<ruta>` (solo `/v1/...` y
  `/v2/...`; métodos GET, POST y DELETE). La respuesta de Stripe vuelve tal cual.
- Otra llave, otro límite y otra actividad en el panel. Las llaves de GHL y
  Kraken no abren Stripe, y la de Stripe no abre nada más.
- Sin la clave, `/stripe` responde `503 stripe_not_configured` y lo demás
  sigue igual.

### Fiabilidad

- **Idempotency-Key obligatorio en cada escritura.** Cada POST (y los DELETE
  de /v2) debe traer el `Idempotency-Key` de Muse (un UUID por acción, el mismo
  en cada reintento); sin él el proxy responde `400 idempotency_key_required` y
  no envía nada. Así, aunque se pierda una respuesta, Muse puede repetir con la
  misma clave y Stripe nunca hace la acción dos veces (`Idempotent-Replayed: true`).
  El proxy lo devuelve en `X-Proxy-Idempotency-Key`.
- **Reintentos seguros, con las reglas de Stripe:** conexión perdida,
  `Stripe-Should-Retry: true`, 409, 429 sin `Stripe-Rate-Limited-Reason`
  (bloqueo interno) y 5xx (salvo `Stripe-Should-Retry: false`), hasta 2
  reintentos con espera de 0,5 s a 5 s, dentro de 25 s. Los límites de
  velocidad reales (429 con motivo) vuelven a Muse. `X-Proxy-Attempts` dice
  cuántos intentos hubo.
- **Qué pasó exactamente:** cada error de Stripe vuelve tal cual más un objeto
  `proxy` en español (`summary`, `executed` yes/no/unknown, `safe_to_retry`,
  `next`, `idempotency_key`). Si un intento anterior pudo hacerse (respuesta
  perdida, 409, `idempotency_error`), `executed` es `unknown`, nunca `no`. Las
  respuestas propias del proxy usan el mismo formato con
  `error.type = "proxy_error"`; un error de Stripe que no sea JSON también llega
  envuelto con la explicación.
- **JSON aceptado en /v1:** Stripe espera `x-www-form-urlencoded`; si Muse
  manda JSON, el proxy lo convierte como las librerías oficiales
  (`items[0][price]=…`) y lo indica en `X-Proxy-Converted`.
- **Versión fija:** si Muse no manda `Stripe-Version`, el proxy manda
  `2026-08-26.dahlia` (o `STRIPE_API_VERSION`).

### Qué está bloqueado por defecto

Se comparan método y ruta tal como Stripe la enruta (cada segmento
decodificado una vez, en minúsculas). Una ruta ambigua (`%2F`, `//`, `.`/`..`,
`;`, `\`, `#`) se rechaza con 400.

- **Dinero hacia fuera** (se permite con `STRIPE_ALLOW_MONEY_OUT=true`):
  payouts, reversiones de payouts, transferencias y sus reversiones,
  devoluciones de comisiones de aplicación, cuentas bancarias de destino
  (`external_accounts`, `bank_accounts`, `/v2/core/vault`), `balance_settings`,
  borrar o rechazar cuentas conectadas, Treasury saliente, tarjetas de Issuing,
  Climate, crear o cambiar cuentas y titulares de Treasury e Issuing,
  reactivar tokens de wallet, `credit_reversals`, movimientos de dinero de
  `/v2/money_management`, y crear o cambiar cuentas conectadas con
  `external_account`, `bank_account`, `settings[payouts]` o sus nombres antiguos
  (`payout_schedule`…), también en la query o en JSON. En esas rutas los
  parámetros deben tener la forma normal de Stripe (`a[b]`, sin `;`).
- **Accesos permanentes** (se permite con `STRIPE_ALLOW_ACCESS_GRANTS=true`):
  webhooks y destinos de eventos (crearlos, cambiarlos o borrarlos podría
  romper integraciones ya conectadas o sacar datos), leer el número completo o
  el CVC de tarjetas de Issuing (`expand[]=number|cvc`), enlaces públicos a
  archivos, enlaces de alta y de acceso a cuentas, sesiones de cuenta, claves
  efímeras, reenvío de datos de tarjeta, secretos de apps, gestión de claves y
  operaciones masivas.

Todo lo demás pasa: clientes, pagos, cobros, reembolsos, facturas,
suscripciones, productos, precios, cupones, Checkout, Payment Links, disputas,
lecturas de saldo, payouts y eventos… El mensaje para Muse le pide confirmar
contigo cada acción que cobre, devuelva dinero o llegue a un cliente.

### Configurarlo (unos 5 minutos)

1. **Crea una clave restringida solo para Muse:** Stripe → **Developers → API
   keys → Create restricted key**, nombre «Muse», recursos en **Write** (o Read
   donde Muse solo deba leer). Si Stripe ofrece «Authorizing agent access to
   your account», elígelo: añade aprobaciones de Stripe. Una clave aparte se
   revoca sin afectar a lo que ya usa la clave principal. Sin restricción por
   IP (Vercel no tiene IP fija).
2. **Vercel:** `STRIPE_SECRET_KEY` en **Production**, marcada como
   **Sensitive**, y **Redeploy**.
3. **Panel → Stripe → Verificar ahora:** clave válida y modo (live/test),
   cuenta, permisos de lectura (14 familias), conexión de Muse, llaves
   separadas y que los bloqueos respondan (con rutas que no cambian nada).
4. **Conectar Muse:** **Copiar mensaje para Muse** y, cuando pida la llave de
   Stripe, **Copiar llave** → su tarjeta segura.

### Variables de entorno de Stripe

| Variable | Obligatoria | Qué es |
|---|---|---|
| `STRIPE_SECRET_KEY` | sí | Clave restringida (`rk_live_…`/`rk_test_…`) o secreta (`sk_…`). El panel avisa si es la secreta completa. |
| `STRIPE_PROXY_KEY` | no | Llave de Muse para Stripe (32+ caracteres). Vacía = se deriva de la clave (HKDF-SHA256, de un solo sentido). |
| `STRIPE_PUBLIC_HOST` | no | Dirección que el panel da a Muse (p. ej. `stripe-proxy-muse.vercel.app`). |
| `STRIPE_API_VERSION` | no | Versión de Stripe por defecto. Vacía = `2026-08-26.dahlia`. |
| `STRIPE_ALLOW_MONEY_OUT` | no | Solo `true` permite payouts, transferencias y cambios de cuenta bancaria. |
| `STRIPE_ALLOW_ACCESS_GRANTS` | no | Solo `true` permite webhooks, enlaces públicos y enlaces de acceso. |

Límites no cubiertos: la subida de archivos (`/v1/files`) y los PDF de
presupuestos van a `files.stripe.com`, que esta API no toca.

## Estructura

```
src/
  server.js      arranque, timeouts, apagado limpio (SIGTERM)
  create-app.js  rutas: /health, auth, rate limit, /ghl, /mcp
  proxy.js       reenvío en streaming (headers, body, errores, reintento keep-alive)
  config.js      variables de entorno y validación
  auth.js        X-Proxy-Key en tiempo constante
  http-util.js   respuestas JSON propias del proxy (sendJson)
  rate-limit.js  ventana deslizante en memoria
  metrics.js     tiempos por llamada (GHL vs proxy) para el panel
  admin.js       panel /admin: PIN, sesión, verificaciones en vivo
  admin/         frontend del panel (HTML/CSS/JS sin dependencias)
  kraken/        Kraken: config, lista de métodos, firma, cliente, /api/kraken, panel
  agency/        GHL Agencia: config, /agency (token de agencia, bloqueo de borrado), panel
  stripe/        Stripe: config, bloqueos, reintentos seguros, /stripe, panel
  canonical-path.js  ruta normalizada para los bloqueos de /agency
  logger.js      logs JSON: method, path, status, ms
test/            node:test + GHL (subcuenta y agencia), Kraken y Stripe simulados
test-sign.js     prueba de la firma de Kraken contra el ejemplo oficial (PASS/FAIL)
scripts/
  smoke-test.sh        aceptación contra el deploy
  write-connection.sh  genera CONNECTION.md
deploy/vps/      docker-compose + Caddy (TLS automático) para un VPS
Dockerfile       imagen node:24-alpine, usuario sin privilegios, HEALTHCHECK
```
