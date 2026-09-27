'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const express = require('express');
const { sendJson } = require('./http-util');

const COOKIE = 'ghlp_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const HOSTNAME = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cache-Control': 'no-store',
};

const STATIC_DIR = path.join(__dirname, 'admin');
const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

// Read-only probes that show which parts of GHL the token can reach. Diagnostics only:
// the proxy itself stays a generic passthrough.
const PERMISSION_PROBES = [
  { id: 'contacts', label: 'Contactos', version: '2021-07-28', path: (loc) => `/contacts/?locationId=${loc}&limit=1` },
  { id: 'conversations', label: 'Conversaciones', version: '2021-04-15', path: (loc) => `/conversations/search?locationId=${loc}&limit=1` },
  { id: 'opportunities', label: 'Oportunidades', version: '2021-07-28', path: (loc) => `/opportunities/search?location_id=${loc}&limit=1` },
  { id: 'calendars', label: 'Calendarios', version: '2021-04-15', path: (loc) => `/calendars/?locationId=${loc}` },
  { id: 'users', label: 'Usuarios', version: '2021-07-28', path: (loc) => `/users/?locationId=${loc}` },
  { id: 'workflows', label: 'Workflows', version: '2021-07-28', path: (loc) => `/workflows/?locationId=${loc}` },
];

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

/**
 * Brute-force protection for the PIN. Global (not per IP) so rotating addresses does not
 * help: after `freeAttempts` failures every further failure locks the login, doubling
 * from `baseLockMs` up to `maxLockMs`. A correct PIN resets it.
 */
function createLockout({ freeAttempts = 5, baseLockMs = 30_000, maxLockMs = 60 * 60 * 1000, now = () => Date.now() } = {}) {
  let failures = 0;
  let lockedUntil = 0;
  return {
    lockedForMs: () => Math.max(0, lockedUntil - now()),
    fail() {
      failures += 1;
      if (failures >= freeAttempts) {
        lockedUntil = now() + Math.min(maxLockMs, baseLockMs * 2 ** (failures - freeAttempts));
      }
      return Math.max(0, freeAttempts - failures);
    },
    succeed() {
      failures = 0;
      lockedUntil = 0;
    },
  };
}

function createSessions({ ttlMs = SESSION_TTL_MS, now = () => Date.now(), secret } = {}) {
  // Derived from the secrets when given, so every instance (serverless) accepts the same
  // cookie and changing ADMIN_PIN or PROXY_KEY signs everyone out. Random otherwise.
  const key = secret
    ? crypto.createHmac('sha256', secret).update('ghl-proxy admin session v1').digest()
    : crypto.randomBytes(32);
  const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');
  const revoked = new Map(); // payload -> expiry, so a copied cookie dies on "Salir"
  const pruneRevoked = () => {
    const t = now();
    for (const [payload, exp] of revoked) if (exp <= t) revoked.delete(payload);
  };
  const verify = (token) => {
    if (typeof token !== 'string') return null;
    const cut = token.lastIndexOf('.');
    if (cut <= 0) return null;
    const payload = token.slice(0, cut);
    const expected = sign(payload);
    const given = token.slice(cut + 1);
    if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;
    const exp = Number(payload.split('.', 1)[0]);
    return exp > now() ? { payload, exp } : null;
  };
  return {
    ttlMs,
    issue() {
      const payload = `${now() + ttlMs}.${crypto.randomBytes(16).toString('base64url')}`;
      return `${payload}.${sign(payload)}`;
    },
    valid(token) {
      const session = verify(token);
      return session !== null && !revoked.has(session.payload);
    },
    revoke(token) {
      const session = verify(token);
      if (!session) return;
      pruneRevoked();
      revoked.set(session.payload, session.exp);
    },
  };
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

const isHttps = (req) =>
  Boolean(req.socket.encrypted) || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';

function publicHost(req) {
  const raw = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim().toLowerCase();
  const host = raw.replace(/:\d+$/, '');
  return HOSTNAME.test(host) ? host : null;
}

function connectionInfo(config, host) {
  const middlewareHost = host ?? 'PENDIENTE';
  return {
    middleware_host: middlewareHost,
    auth_placement: 'header:X-Proxy-Key',
    rest_base_path: '/ghl',
    mcp_path: '/mcp/',
    health_url: `https://${middlewareHost}/health`,
    ghl_location_id: config.ghlLocationId,
    version: config.version,
  };
}

function connectionMarkdown(info) {
  const fields = Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('\n');
  return (
    '# CONNECTION — ghl-proxy → Muse\n\n' +
    'Handoff para Muse. Sin secretos; la llave del proxy se entrega al operador por separado.\n\n' +
    '```yaml\n' + fields + '\n```\n'
  );
}

/**
 * Ready-to-paste instructions for Muse: everything it needs to connect, and no secret.
 * The proxy key is requested through Muse's secure credential card, never in the chat.
 */
function museMessage(info, config) {
  const host = info.middleware_host;
  const base = `https://${host}`;
  const loc = info.ghl_location_id;
  return `# Conectar GoHighLevel (subcuenta Eximia) a través de ghl-proxy

Hola Muse. El conector directo de GoHighLevel no funciona, así que vamos a usar nuestro proxy propio. Aquí está todo lo que necesitas. Este mensaje no contiene secretos: la llave del proxy te la daré por tu tarjeta segura de credenciales, nunca por el chat.

## Datos de conexión (CONNECTION.md)

\`\`\`yaml
${Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('\n')}
\`\`\`

## Qué hacer

1. Registra el conector \`custom.gohighlevel-proxy\` con \`api_hosts=["${host}"]\` usando tu flujo seguro de credenciales. Pídeme la llave del proxy en la tarjeta segura. Guárdala como secreto y envíala SIEMPRE en el header \`X-Proxy-Key\`. Nunca la muestres ni la escribas en el chat, en logs ni en archivos.
2. Adapta tu skill de GoHighLevel (\`~/workspace/skills/gohighlevel/\`) con un cliente gemelo \`bin/ghl-proxy\`:
   - REST: \`${base}${info.rest_base_path}/<ruta>\`, donde <ruta> es exactamente la del API v2 de GHL (lo que iría después de https://services.leadconnectorhq.com), con la misma query.
   - MCP: \`POST ${base}${info.mcp_path}\`.
   - No envíes el token de GoHighLevel ni el header Authorization: el proxy los pone. Tampoco hace falta un User-Agent especial.
3. Verifica, en este orden:
   a. \`GET ${info.health_url}\` → \`{"ok": true, ...}\`
   b. \`GET ${base}${info.rest_base_path}/contacts/?locationId=${loc}&limit=1\` con \`X-Proxy-Key\` → 200 con \`"contacts"\`.
   c. MCP: \`initialize\` → \`tools/list\` (unas 36 herramientas) → \`tools/call\` de \`locations_get-location\` → \`result.isError\` debe ser false.
4. Si todo da 200, pasa tus automatizaciones (revisión diaria del CRM, greeter de leads, prospección) al proxy y déjalo como vía principal hasta que el conector directo vuelva a funcionar.
5. Confírmame en una línea que quedó conectado.

## Reglas del API de GoHighLevel

- Header \`Version\`: si no lo envías, el proxy pone \`${config.ghlVersion}\` (contacts, locations, opportunities, users, workflows, custom-fields…). Para calendars y conversations (incluido \`/conversations/search\`) envía \`Version: 2021-04-15\`.
- \`GET /contacts/\` está deprecado: para buscar usa \`POST ${info.rest_base_path}/contacts/search\` con \`{"locationId": "${loc}", ...}\`.
- Paginación: no sigas \`meta.nextPageUrl\` tal cual, porque apunta directo a GHL. Cambia \`https://services.leadconnectorhq.com\` por \`${base}${info.rest_base_path}\`, o usa \`startAfter\` / \`startAfterId\`.
- Límites: GHL permite 100 llamadas cada 10 s y 200 000 al día; el proxy, ${config.rateLimitMax} cada ${config.rateLimitWindowMs / 1000} s. Si recibes 429, espera lo que indique \`Retry-After\`.
- Reutiliza la conexión HTTPS (keep-alive o sesión persistente): cada llamada va más rápido.

## MCP (streamable HTTP)

- Envía \`Content-Type: application/json\` y \`Accept: application/json, text/event-stream\` (si faltan, el proxy los corrige).
- No guarda estado: no hay \`Mcp-Session-Id\` y \`initialize\` es opcional.
- Las respuestas llegan como SSE (\`event: message\` y \`data: {json-rpc}\`): lee la línea \`data:\`.
- Un error de GHL dentro de \`tools/call\` llega como HTTP 200 con \`result.isError = true\` y el detalle en \`content[0].text\`.
- Los argumentos de las herramientas usan los prefijos \`path_\`, \`query_\` y \`body_\` (p. ej. \`path_contactId\`). Usa los nombres exactos de \`tools/list\`.

## Si algo falla

- 401 \`{"error":"unauthorized"}\`: la llave del proxy falta o es incorrecta. Pídemela otra vez por la tarjeta segura.
- 401 de GHL (p. ej. "Invalid Private Integration token"): avísame, hay que actualizar el token en el proxy.
- 403 \`error code: 1010\`: no debería pasar a través del proxy. Si pasa, avísame.
- 429: espera \`Retry-After\`. 502/504: GHL no respondió; reintenta en unos minutos.
`;
}

/** Small HTTP client for the diagnostics (never used for proxied traffic). */
function createClient() {
  const agents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) };
  return function call(base, pathAndQuery, { method = 'GET', headers = {}, body, timeoutMs = 15_000 } = {}) {
    return new Promise((resolve) => {
      const url = new URL(pathAndQuery, base);
      const transport = url.protocol === 'https:' ? https : http;
      const started = process.hrtime.bigint();
      const req = transport.request(url, { method, headers, agent: agents[url.protocol], timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text, ms: Number(process.hrtime.bigint() - started) / 1e6 });
        });
        res.on('error', () => resolve({ status: 0, text: '', ms: 0 }));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => resolve({ status: 0, error: err.code || 'ERROR', text: '', ms: Number(process.hrtime.bigint() - started) / 1e6 }));
      if (body) req.write(body);
      req.end();
    });
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** First JSON-RPC message of an MCP response, whether plain JSON or SSE. */
function parseMcp(res) {
  if (/text\/event-stream/i.test(res.headers?.['content-type'] ?? '')) {
    const line = res.text.split('\n').find((l) => l.startsWith('data:'));
    return line ? parseJson(line.slice(5).trim()) : null;
  }
  return parseJson(res.text);
}

const ghlMessage = (res) => {
  if (res.status === 0) return `sin conexión (${res.error})`;
  const body = parseJson(res.text);
  const msg = body && (body.message || body.error || body.msg);
  return `HTTP ${res.status}${msg ? ` · ${Array.isArray(msg) ? msg.join(', ') : String(msg).slice(0, 160)}` : ''}`;
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

function createChecks(config, getSelfUrl, checkMarker) {
  const call = createClient();
  const loc = encodeURIComponent(config.ghlLocationId);
  const direct = (p, version = config.ghlVersion) =>
    call(config.upstreamBase, p, {
      headers: { Authorization: `Bearer ${config.ghlToken}`, Version: version, Accept: 'application/json', 'User-Agent': config.userAgent },
    });
  const mark = checkMarker ? { 'X-Admin-Check': checkMarker } : {};
  const viaProxy = (p, opts = {}) => call(getSelfUrl(), p, { ...opts, headers: { ...mark, 'X-Proxy-Key': config.proxyKey, ...(opts.headers ?? {}) } });
  const mcp = (message) =>
    viaProxy('/mcp/', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(message) });

  async function run({ https: secure }) {
    const checks = [];
    const add = (id, label, status, detail, ms) => checks.push({ id, label, status, detail, ms: ms === undefined ? null : round1(ms) });

    add('https', 'Conexión cifrada (HTTPS)', secure ? 'ok' : 'warn', secure ? 'El panel y el proxy se usan por HTTPS.' : 'Esta visita no llegó cifrada (HTTPS). En producción abre siempre la dirección con https://');

    const location = await direct(`/locations/${loc}`);
    const locBody = parseJson(location.text);
    if (location.status === 200) {
      const name = locBody && locBody.location && locBody.location.name;
      add('ghl_token', 'Token de GoHighLevel', 'ok', `Válido. Subcuenta: ${name || config.ghlLocationId}`, location.ms);
    } else {
      add('ghl_token', 'Token de GoHighLevel', 'fail', `GHL respondió ${ghlMessage(location)}. Revisa GHL_TOKEN.`, location.ms);
    }

    const selfUrl = getSelfUrl();
    if (!selfUrl) {
      add('proxy_rest', 'Conexión de Muse (API)', 'warn', 'El servidor aún no está escuchando.');
    } else {
      const rest = await viaProxy(`/ghl/contacts/?locationId=${loc}&limit=1`);
      const body = parseJson(rest.text);
      const total = body && body.meta && typeof body.meta.total === 'number' ? body.meta.total : null;
      if (rest.status === 200) {
        add('proxy_rest', 'Conexión de Muse (API)', 'ok', `Responde bien${total !== null ? ` · ${total.toLocaleString('es')} contactos en GHL` : ''}`, rest.ms);
      } else {
        add('proxy_rest', 'Conexión de Muse (API)', 'fail', `La llamada de prueba falló: ${ghlMessage(rest)}`, rest.ms);
      }

      const noKey = await call(selfUrl, `/ghl/contacts/?locationId=${loc}&limit=1`, { headers: mark });
      add(
        'auth',
        'Sin llave no entra nadie',
        noKey.status === 401 ? 'ok' : 'fail',
        noKey.status === 401 ? 'Una llamada sin la llave fue rechazada, como debe ser.' : `Una llamada sin la llave NO fue rechazada (HTTP ${noKey.status}).`,
        noKey.ms,
      );

      const list = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const tools = parseMcp(list);
      const toolCount = tools && tools.result && Array.isArray(tools.result.tools) ? tools.result.tools.length : null;
      const call1 = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'locations_get-location', arguments: {} } });
      const callMsg = parseMcp(call1);
      const callOk = Boolean(callMsg && callMsg.result && !callMsg.result.isError);
      if (list.status === 200 && toolCount !== null && callOk) {
        add('proxy_mcp', 'Conexión de Muse (MCP)', 'ok', `${toolCount} herramientas disponibles y responden con datos reales`, list.ms + call1.ms);
      } else if (list.status === 200 && toolCount !== null) {
        add('proxy_mcp', 'Conexión de Muse (MCP)', 'warn', `${toolCount} herramientas, pero al usarlas GHL devolvió un error (¿token o permisos?).`, list.ms + call1.ms);
      } else {
        add('proxy_mcp', 'Conexión de Muse (MCP)', 'fail', `La llamada de prueba falló: ${ghlMessage(list)}`, list.ms);
      }
    }

    const permissions = await Promise.all(
      PERMISSION_PROBES.map(async (probe) => {
        const res = await direct(probe.path(loc), probe.version);
        return { id: probe.id, label: probe.label, ok: res.status >= 200 && res.status < 300, detail: res.status >= 200 && res.status < 300 ? 'Acceso OK' : ghlMessage(res) };
      }),
    );

    // Speed: the same request straight to GHL and through the proxy, interleaved.
    let speed = null;
    if (selfUrl) {
      const directMs = [];
      const proxyMs = [];
      const ownMs = [];
      for (let i = 0; i < 5; i += 1) {
        const d = await direct(`/contacts/?locationId=${loc}&limit=1`);
        const p = await viaProxy(`/ghl/contacts/?locationId=${loc}&limit=1`);
        if (d.status === 200) directMs.push(d.ms);
        if (p.status === 200) proxyMs.push(p.ms);
        const own = Number(p.headers?.['x-proxy-overhead-ms']);
        if (p.status === 200 && Number.isFinite(own)) ownMs.push(own);
      }
      if (directMs.length && proxyMs.length) {
        const dm = median(directMs);
        const pm = median(proxyMs);
        // GHL's own variation between calls: a smaller difference is just noise.
        const spread = Math.max(...directMs) - Math.min(...directMs);
        speed = {
          proxyOwnMs: ownMs.length ? Math.round(median(ownMs) * 100) / 100 : null,
          directMs: round1(dm),
          proxyMs: round1(pm),
          differenceMs: round1(pm - dm),
          ghlSpreadMs: round1(spread),
          samples: directMs.length,
        };
      }
    }

    const statuses = checks.map((c) => c.status);
    const overall = statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'ok';
    return { ranAt: new Date().toISOString(), overall, checks, permissions, speed };
  }

  // Concurrent clicks share one run instead of hammering GHL.
  let inflight = null;
  return (opts) => {
    if (!inflight) inflight = run(opts).finally(() => { inflight = null; });
    return inflight;
  };
}

/**
 * The operator dashboard under /admin, protected by ADMIN_PIN.
 * Mounted before the X-Proxy-Key middleware; only exists when ADMIN_PIN is set.
 */
function createAdminRouter({
  config,
  logger,
  metrics,
  getSelfUrl,
  checkMarker,
  lockout = createLockout(),
  sessions = createSessions({ secret: `${config.proxyKey}\u0000${config.adminPin}` }),
}) {
  const router = express.Router();
  const staticFiles = Object.fromEntries(
    Object.entries(STATIC_FILES).map(([route, { file, type }]) => [route, { type, body: fs.readFileSync(path.join(STATIC_DIR, file)) }]),
  );
  const runChecks = createChecks(config, getSelfUrl, checkMarker);

  router.use((req, res, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  for (const [route, file] of Object.entries(staticFiles)) {
    router.get(route, (req, res) => {
      res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.body.length });
      res.end(req.method === 'HEAD' ? undefined : file.body);
    });
  }

  const authed = (req) => sessions.valid(readCookie(req, COOKIE));
  const setCookie = (req, res, value, maxAgeSeconds) => {
    const attrs = [`${COOKIE}=${value}`, 'Path=/admin', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (isHttps(req)) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
  };

  // State-changing calls must be same-origin JSON: browsers cannot send that cross-site
  // without a CORS preflight, and the session cookie is SameSite=Strict on top.
  const sameOriginJson = (req, res, next) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, { error: 'json_required' });
    }
    // Sec-Fetch-Site is set by the browser and cannot be forged by a page; it keeps
    // working behind reverse proxies that rewrite Host.
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite) {
      return fetchSite === 'same-origin' ? next() : sendJson(res, 403, { error: 'forbidden_origin' });
    }
    const origin = req.headers.origin;
    if (origin) {
      let originHost = null;
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        // fall through with null
      }
      const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim().toLowerCase();
      if (originHost !== host) return sendJson(res, 403, { error: 'forbidden_origin' });
    }
    return next();
  };
  const requireSession = (req, res, next) => (authed(req) ? next() : sendJson(res, 401, { error: 'unauthorized' }));
  const parseJsonBody = express.json({ limit: '2kb' });
  const json = (req, res, next) => parseJsonBody(req, res, (err) => (err ? sendJson(res, 400, { error: 'bad_json' }) : next()));

  router.get('/api/session', (req, res) => sendJson(res, 200, { authenticated: authed(req) }));

  router.post('/api/login', sameOriginJson, json, (req, res) => {
    const lockedMs = lockout.lockedForMs();
    if (lockedMs > 0) {
      const retryAfter = Math.ceil(lockedMs / 1000);
      return sendJson(res, 429, { error: 'locked', retryAfterSeconds: retryAfter }, { 'Retry-After': String(retryAfter) });
    }
    const pin = req.body && typeof req.body.pin === 'string' ? req.body.pin : '';
    if (pin && safeEqual(pin, config.adminPin)) {
      lockout.succeed();
      setCookie(req, res, sessions.issue(), Math.floor(sessions.ttlMs / 1000));
      logger.info({ msg: 'admin_login' });
      res.writeHead(204);
      return res.end();
    }
    res.locals.rejectedPin = true;
    const attemptsLeft = lockout.fail();
    const lockedFor = lockout.lockedForMs();
    logger.warn({ msg: 'admin_login_failed', locked: lockedFor > 0 });
    if (lockedFor > 0) {
      const retryAfter = Math.ceil(lockedFor / 1000);
      return sendJson(res, 429, { error: 'locked', retryAfterSeconds: retryAfter }, { 'Retry-After': String(retryAfter) });
    }
    return sendJson(res, 401, { error: 'invalid_pin', attemptsLeft });
  });

  router.post('/api/logout', sameOriginJson, (req, res) => {
    sessions.revoke(readCookie(req, COOKIE));
    setCookie(req, res, '', 0);
    res.writeHead(204);
    res.end();
  });

  router.get('/api/overview', requireSession, (req, res) => {
    const info = connectionInfo(config, publicHost(req));
    sendJson(res, 200, {
      version: config.version,
      startedAt: new Date(metrics.startedAt).toISOString(),
      uptimeSeconds: Math.round((Date.now() - metrics.startedAt) / 1000),
      https: isHttps(req),
      connection: info,
      connectionMarkdown: connectionMarkdown(info),
      museMessage: museMessage(info, config),
      config: {
        ghlTokenHint: `${config.ghlToken.startsWith('pit-') ? 'pit-' : ''}…${config.ghlToken.slice(-4)}`,
        proxyKeyLength: config.proxyKey.length,
        locationId: config.ghlLocationId,
        rateLimit: { max: config.rateLimitMax, windowSeconds: config.rateLimitWindowMs / 1000 },
        upstream: config.upstreamBase.origin,
      },
      metrics: metrics.snapshot(),
    });
  });

  router.post('/api/checks', sameOriginJson, requireSession, async (req, res, next) => {
    try {
      sendJson(res, 200, await runChecks({ https: isHttps(req) }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/key', sameOriginJson, requireSession, (req, res) => {
    logger.info({ msg: 'admin_key_revealed' });
    sendJson(res, 200, { proxyKey: config.proxyKey });
  });

  router.get('/api/connection.md', requireSession, (req, res) => {
    const body = connectionMarkdown(connectionInfo(config, publicHost(req)));
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="CONNECTION.md"',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  });

  router.use('/api', (req, res) => sendJson(res, 404, { error: 'not_found' }));
  router.use((req, res) => sendJson(res, 404, { error: 'not_found' }));
  return router;
}

module.exports = { createAdminRouter, createLockout, createSessions, connectionInfo, connectionMarkdown, museMessage, publicHost };
