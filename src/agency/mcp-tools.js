'use strict';

/**
 * Extra tools on the same /mcp/ endpoint (so one Claude connector sees everything):
 * Eximia invoice tools (always, with GHL_TOKEN) and agency tools (only with GHL_AGENCY_TOKEN).
 *
 * GHL's hosted MCP only knows the Eximia sub-account. When the agency API is configured
 * (GHL_AGENCY_TOKEN), this middleware sits in front of the /mcp forwarder and:
 *   - tools/list: forwards to GHL, then appends the agency tools below (first page only);
 *   - tools/call for one of the agency tools: answers here, with the agency token;
 *   - anything else: forwards to GHL exactly as before.
 * Without the agency token the middleware is not mounted and /mcp/ is untouched.
 *
 * Same guard as /agency: deleting a sub-account stays blocked unless GHL_AGENCY_ALLOW_DELETE=true.
 */

const http = require('node:http');
const https = require('node:https');
const { canonicalPath } = require('../canonical-path');
const { buildUpstreamHeaders } = require('../proxy');
const { sendJson } = require('../http-util');

const MAX_BODY = 2 * 1024 * 1024;
const MAX_RESULT_CHARS = 200_000;
const SAAS_VERSION = '2021-04-15';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });

const TOOLS = [
  {
    name: 'agency_get-company',
    title: 'Agencia: ver la agencia',
    description: 'Datos de la agencia de GoHighLevel (nivel agencia, no una subcuenta).',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'agency_list-sub-accounts',
    title: 'Agencia: listar subcuentas',
    description: 'Lista las subcuentas (locations) de la agencia. Usa query para buscar por nombre o email, y skip/limit para paginar.',
    inputSchema: obj({ query: str('Texto a buscar (opcional)'), limit: int('Máximo a devolver (1-100, por defecto 50)'), skip: int('Cuántas saltar (paginación)') }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'agency_get-sub-account',
    title: 'Agencia: ver una subcuenta',
    description: 'Detalle de una subcuenta por su locationId.',
    inputSchema: obj({ locationId: str('ID de la subcuenta') }, ['locationId']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'agency_list-users',
    title: 'Agencia: listar usuarios',
    description: 'Usuarios de la agencia, o de una subcuenta si das locationId.',
    inputSchema: obj({ locationId: str('ID de la subcuenta (opcional)'), query: str('Texto a buscar (opcional)'), limit: int('Máximo a devolver'), skip: int('Cuántos saltar') }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'agency_api-request',
    title: 'Agencia: llamada al API v2',
    description:
      'Llama cualquier ruta del API v2 de GoHighLevel con el token de la AGENCIA (subcuentas, usuarios, snapshots, SaaS, company, custom menus...). path es lo que va después de https://services.leadconnectorhq.com, p. ej. /locations/search. {companyId} en path o query se rellena solo con el ID de la agencia. Confirma con el usuario antes de crear, cambiar o borrar algo. Borrar subcuentas está bloqueado.',
    inputSchema: obj(
      {
        method: { type: 'string', enum: METHODS, description: 'Método HTTP' },
        path: str('Ruta v2, empieza con /'),
        query: { type: 'object', description: 'Parámetros de query (opcional)', additionalProperties: true },
        body: { type: 'object', description: 'Cuerpo JSON (opcional)', additionalProperties: true },
        version: str('Header Version (opcional; por defecto 2021-07-28, 2021-04-15 en /saas)'),
      },
      ['method', 'path'],
    ),
    annotations: { destructiveHint: true, openWorldHint: true },
  },
  {
    name: 'agency_sub-account-request',
    title: 'Agencia: llamada dentro de otra subcuenta',
    description:
      'Llama una ruta del API v2 DENTRO de cualquier subcuenta (contactos, conversaciones, oportunidades, calendarios...) con un token de esa subcuenta que el proxy saca del token de la agencia. Si GoHighLevel no permite sacar ese token, devuelve el error. Para la subcuenta Eximia usa las otras herramientas. Confirma con el usuario antes de crear, cambiar o borrar algo.',
    inputSchema: obj(
      {
        locationId: str('ID de la subcuenta'),
        method: { type: 'string', enum: METHODS, description: 'Método HTTP' },
        path: str('Ruta v2, empieza con /; {locationId} y {companyId} se rellenan solos (también en query)'),
        query: { type: 'object', description: 'Parámetros de query (opcional)', additionalProperties: true },
        body: { type: 'object', description: 'Cuerpo JSON (opcional)', additionalProperties: true },
        version: str('Header Version (opcional)'),
      },
      ['locationId', 'method', 'path'],
    ),
    annotations: { destructiveHint: true, openWorldHint: true },
  },
];
// Eximia sub-account tools that GHL's MCP lacks (invoices). They use GHL_TOKEN and GHL_LOCATION_ID,
// like /ghl, so they work with or without the agency token.
// Verified against GHL (README, Notas para Muse): invoices answer to the proxy default.
const INVOICES_VERSION = '2021-07-28';
const EXIMIA_TOOLS = [
  {
    name: 'eximia_list-invoices',
    title: 'Eximia: listar facturas',
    description: 'Lista las facturas de la subcuenta Eximia. Filtros opcionales: status, search (ID, nombre, email o teléfono), contactId, startAt/endAt (YYYY-MM-DD). Paginación con limit/offset.',
    inputSchema: obj({ status: str('Estado (opcional)'), search: str('Buscar (opcional)'), contactId: str('Contacto (opcional)'), startAt: str('Desde YYYY-MM-DD (opcional)'), endAt: str('Hasta YYYY-MM-DD (opcional)'), limit: int('Máximo (1-100, por defecto 50)'), offset: int('Cuántas saltar') }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'eximia_list-invoice-schedules',
    title: 'Eximia: listar facturas recurrentes',
    description: 'Lista los schedules de facturas recurrentes de la subcuenta Eximia. Filtros opcionales: status, search. Paginación con limit/offset.',
    inputSchema: obj({ status: str('Estado (opcional)'), search: str('Buscar (opcional)'), limit: int('Máximo (1-100, por defecto 50)'), offset: int('Cuántos saltar') }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'eximia_get-invoice-schedule',
    title: 'Eximia: ver una factura recurrente',
    description: 'Detalle de un schedule de factura recurrente de la subcuenta Eximia por su scheduleId.',
    inputSchema: obj({ scheduleId: str('ID del schedule') }, ['scheduleId']),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'eximia_cancel-invoice-schedule',
    title: 'Eximia: cancelar una factura recurrente',
    description:
      'Cancela un schedule de factura recurrente de la subcuenta Eximia: deja de facturarle al cliente. NUNCA lo uses por tu cuenta: antes enséñale al usuario cuál es (cliente, monto, frecuencia, scheduleId) con eximia_get-invoice-schedule y espera su sí explícito para ESE schedule. Solo entonces llama con confirmedByUser true.',
    inputSchema: obj({ scheduleId: str('ID del schedule'), confirmedByUser: { type: 'boolean', description: 'true solo si el usuario dijo que sí a cancelar este schedule' } }, ['scheduleId', 'confirmedByUser']),
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
];
const AGENCY_NAMES = new Set(TOOLS.map((t) => t.name));
const EXIMIA_NAMES = new Set(EXIMIA_TOOLS.map((t) => t.name));

const ID = /^[A-Za-z0-9_-]{4,64}$/;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parses a JSON or SSE MCP response into its JSON-RPC message (the last data: line). */
function parseMcpBody(text, contentType) {
  if (/text\/event-stream/i.test(contentType || '')) {
    let last = null;
    for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) last = line.slice(5).trim();
    return last ? JSON.parse(last) : null;
  }
  return text ? JSON.parse(text) : null;
}

function sendRpc(res, message, { sse = true, headers = {} } = {}) {
  const json = JSON.stringify(message);
  const body = sse ? `event: message\ndata: ${json}\n\n` : json;
  res.writeHead(200, {
    'Content-Type': sse ? 'text/event-stream' : 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function toolResult(id, payload, isError = false) {
  let text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1);
  if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n... (cortado: usa limit/skip para pedir menos)`;
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } };
}

function createAgencyMcp({ agencyConfig = null, ghlConfig, logger }) {
  const base = ghlConfig.upstreamBase;
  const transport = base.protocol === 'https:' ? https : http;
  const agencyOn = Boolean(agencyConfig && agencyConfig.enabled);
  const extraTools = [...(agencyOn ? TOOLS : []), ...EXIMIA_TOOLS];
  const handles = (name) => EXIMIA_NAMES.has(name) || (agencyOn && AGENCY_NAMES.has(name));
  let companyId = (agencyConfig && agencyConfig.companyId) || null;
  const locationTokens = new Map(); // locationId -> { token, exp }

  /** One buffered call to GHL. Never logs tokens or bodies. */
  function call({ token, method, path, query, body, version, form }) {
    return new Promise((resolve) => {
      const url = new URL(base.origin);
      const [p, qs] = path.split('?', 2);
      url.pathname = p;
      if (qs) url.search = qs;
      if (query && typeof query === 'object') {
        for (const [k, v] of Object.entries(query)) {
          if (v === undefined || v === null) continue;
          if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
          else url.searchParams.set(k, String(v));
        }
      }
      let payload = null;
      const headers = {
        authorization: `Bearer ${token}`,
        'user-agent': ghlConfig.userAgent,
        accept: 'application/json',
        version: version || (/^\/saas(-api)?\//i.test(p) ? SAAS_VERSION : ghlConfig.ghlVersion),
      };
      if (form) {
        payload = Buffer.from(new URLSearchParams(form).toString());
        headers['content-type'] = 'application/x-www-form-urlencoded';
      } else if (body !== undefined && body !== null && method !== 'GET') {
        payload = Buffer.from(JSON.stringify(body));
        headers['content-type'] = 'application/json';
      }
      if (payload) headers['content-length'] = payload.length;
      const reqOut = transport.request(
        { protocol: base.protocol, hostname: base.hostname.replace(/^\[|\]$/g, ''), port: base.port || undefined, method, path: `${url.pathname}${url.search}`, headers, timeout: ghlConfig.upstreamTimeoutMs },
        (upRes) => {
          const chunks = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed = text;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              /* keep text */
            }
            resolve({ status: upRes.statusCode, body: parsed });
          });
          upRes.on('error', () => resolve({ status: 502, body: { error: 'bad_gateway' } }));
        },
      );
      reqOut.on('timeout', () => reqOut.destroy(Object.assign(new Error('timeout'), { code: 'UPSTREAM_TIMEOUT' })));
      reqOut.on('error', (err) => {
        logger.error({ msg: 'agency_mcp_upstream_error', code: err && err.code });
        resolve({ status: err && err.code === 'UPSTREAM_TIMEOUT' ? 504 : 502, body: { error: err && err.code === 'UPSTREAM_TIMEOUT' ? 'upstream_timeout' : 'bad_gateway' } });
      });
      reqOut.end(payload || undefined);
    });
  }

  async function getCompanyId() {
    if (companyId) return companyId;
    // The agency token can read the Eximia sub-account; its companyId is the agency's id.
    const r = await call({ token: agencyConfig.token, method: 'GET', path: `/locations/${encodeURIComponent(ghlConfig.ghlLocationId)}` });
    const found = r.status === 200 && r.body && r.body.location && r.body.location.companyId;
    if (typeof found === 'string' && ID.test(found)) companyId = found;
    return companyId;
  }

  /** Validates a model-supplied path. Returns { path } or { error }. */
  function checkPath(raw, fill) {
    if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.length > 1024) return { error: 'path debe empezar con / (p. ej. /locations/search)' };
    if (/[#\s]/.test(raw)) return { error: 'path no puede tener espacios ni #' };
    let path = raw;
    for (const [k, v] of Object.entries(fill)) if (v) path = path.split(`{${k}}`).join(encodeURIComponent(v));
    const canon = canonicalPath(path);
    if (canon === null) return { error: 'path tiene codificación inválida' };
    if (/\/\.\.?(\/|$)/.test(path.split('?')[0]) || /%2e/i.test(path)) return { error: 'path no puede tener . ni ..' };
    return { path, canon };
  }

  async function locationToken(locationId) {
    const cached = locationTokens.get(locationId);
    if (cached && cached.exp > Date.now() + 60_000) return { token: cached.token };
    const cid = await getCompanyId();
    if (!cid) return { error: { status: 500, body: { error: 'company_id_unknown', message: 'No pude leer el ID de la agencia. Pon GHL_COMPANY_ID en Vercel.' } } };
    const r = await call({ token: agencyConfig.token, method: 'POST', path: '/oauth/locationToken', form: { companyId: cid, locationId } });
    if (r.status >= 200 && r.status < 300 && r.body && typeof r.body.access_token === 'string') {
      const ttl = Number(r.body.expires_in) > 0 ? Number(r.body.expires_in) * 1000 : 3_600_000;
      locationTokens.set(locationId, { token: r.body.access_token, exp: Date.now() + ttl });
      if (locationTokens.size > 500) locationTokens.delete(locationTokens.keys().next().value);
      return { token: r.body.access_token };
    }
    logger.warn({ msg: 'agency_location_token_refused', status: r.status });
    return {
      error: {
        status: r.status,
        body: {
          error: 'location_token_refused',
          message: 'GoHighLevel no dio un token de esta subcuenta a partir del token de la agencia. Para trabajar dentro de esa subcuenta hace falta su propio token (Private Integration de la subcuenta) o una app OAuth de GoHighLevel.',
          ghl: r.body,
        },
      },
    };
  }

  const out = (r) => ({ status: r.status, body: r.body });

  const clampInt = (v, def, min, max) => Math.min(Math.max(Number.parseInt(v, 10) || def, min), max);
  const loc = () => ({ altId: ghlConfig.ghlLocationId, altType: 'location' });
  const optStr = (v) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined);

  async function runEximiaTool(name, a) {
    const token = ghlConfig.ghlToken;
    const version = INVOICES_VERSION;
    switch (name) {
      case 'eximia_list-invoices': {
        const query = { ...loc(), limit: clampInt(a.limit, 50, 1, 100), offset: clampInt(a.offset, 0, 0, 1_000_000), status: optStr(a.status), search: optStr(a.search), contactId: optStr(a.contactId), startAt: optStr(a.startAt), endAt: optStr(a.endAt) };
        const r = await call({ token, method: 'GET', path: '/invoices/', query, version });
        return [out(r), r.status >= 400];
      }
      case 'eximia_list-invoice-schedules': {
        const query = { ...loc(), limit: clampInt(a.limit, 50, 1, 100), offset: clampInt(a.offset, 0, 0, 1_000_000), status: optStr(a.status), search: optStr(a.search) };
        const r = await call({ token, method: 'GET', path: '/invoices/schedule', query, version });
        return [out(r), r.status >= 400];
      }
      case 'eximia_get-invoice-schedule': {
        if (typeof a.scheduleId !== 'string' || !ID.test(a.scheduleId)) return [{ error: 'scheduleId inválido' }, true];
        const r = await call({ token, method: 'GET', path: `/invoices/schedule/${encodeURIComponent(a.scheduleId)}`, query: loc(), version });
        return [out(r), r.status >= 400];
      }
      case 'eximia_cancel-invoice-schedule': {
        if (typeof a.scheduleId !== 'string' || !ID.test(a.scheduleId)) return [{ error: 'scheduleId inválido' }, true];
        if (a.confirmedByUser !== true) {
          return [{ error: 'not_confirmed', message: 'No se canceló nada. Enséñale al usuario el schedule y espera su sí explícito antes de cancelarlo.' }, true];
        }
        logger.warn({ msg: 'eximia_invoice_schedule_cancel' });
        const r = await call({ token, method: 'POST', path: `/invoices/schedule/${encodeURIComponent(a.scheduleId)}/cancel`, body: loc(), version });
        return [out(r), r.status >= 400];
      }
      default:
        return [{ error: 'unknown tool' }, true];
    }
  }

  async function runTool(name, args) {
    const a = args && typeof args === 'object' ? args : {};
    if (EXIMIA_NAMES.has(name)) return runEximiaTool(name, a);
    const agencyToken = agencyConfig.token;
    switch (name) {
      case 'agency_get-company': {
        const cid = await getCompanyId();
        if (!cid) return [{ error: 'company_id_unknown' }, true];
        const r = await call({ token: agencyToken, method: 'GET', path: `/companies/${encodeURIComponent(cid)}` });
        return [out(r), r.status >= 400];
      }
      case 'agency_list-sub-accounts': {
        const cid = await getCompanyId();
        if (!cid) return [{ error: 'company_id_unknown' }, true];
        const limit = Math.min(Math.max(Number.parseInt(a.limit, 10) || 50, 1), 100);
        const skip = Math.max(Number.parseInt(a.skip, 10) || 0, 0);
        const query = { companyId: cid, limit, skip };
        if (typeof a.query === 'string' && a.query) query.query = a.query;
        const r = await call({ token: agencyToken, method: 'GET', path: '/locations/search', query });
        if (r.status === 200 && r.body && Array.isArray(r.body.locations)) {
          const slim = r.body.locations.map((l) => ({ id: l.id, name: l.name, email: l.email, phone: l.phone, city: l.city, state: l.state, country: l.country, timezone: l.timezone, website: l.website }));
          return [{ status: 200, count: slim.length, skip, limit, locations: slim }, false];
        }
        return [out(r), r.status >= 400];
      }
      case 'agency_get-sub-account': {
        if (typeof a.locationId !== 'string' || !ID.test(a.locationId)) return [{ error: 'locationId inválido' }, true];
        const r = await call({ token: agencyToken, method: 'GET', path: `/locations/${encodeURIComponent(a.locationId)}` });
        return [out(r), r.status >= 400];
      }
      case 'agency_list-users': {
        const cid = await getCompanyId();
        if (!cid) return [{ error: 'company_id_unknown' }, true];
        if (a.locationId !== undefined && (typeof a.locationId !== 'string' || !ID.test(a.locationId))) return [{ error: 'locationId inválido' }, true];
        const query = { companyId: cid, query: a.query, limit: a.limit, skip: a.skip, locationId: a.locationId };
        const r = await call({ token: agencyToken, method: 'GET', path: '/users/search', query });
        return [out(r), r.status >= 400];
      }
      case 'agency_api-request':
      case 'agency_sub-account-request': {
        const method = String(a.method || '').toUpperCase();
        if (!METHODS.includes(method)) return [{ error: `method debe ser uno de ${METHODS.join(', ')}` }, true];
        const sub = name === 'agency_sub-account-request';
        if (sub && (typeof a.locationId !== 'string' || !ID.test(a.locationId))) return [{ error: 'locationId inválido' }, true];
        const cid = await getCompanyId();
        const checked = checkPath(a.path, { companyId: cid, locationId: sub ? a.locationId : undefined });
        if (checked.error) return [{ error: checked.error }, true];
        if (method === 'DELETE' && /^\/locations\/[^/]+$/.test(checked.canon) && !agencyConfig.allowDelete) {
          logger.warn({ msg: 'agency_delete_blocked', via: 'mcp' });
          return [{ error: 'blocked_by_proxy', message: 'Borrar una subcuenta no se puede deshacer, así que el proxy no lo permite. No se envió nada a GoHighLevel.' }, true];
        }
        if (/^\/oauth\//.test(checked.canon)) return [{ error: 'Las rutas /oauth no están disponibles por aquí.' }, true];
        if (a.version !== undefined && (typeof a.version !== 'string' || !/^[A-Za-z0-9.-]{1,20}$/.test(a.version))) return [{ error: 'version inválida' }, true];
        let token = agencyToken;
        if (sub) {
          const lt = await locationToken(a.locationId);
          if (lt.error) return [lt.error, true];
          token = lt.token;
        }
        const fills = { companyId: cid, locationId: sub ? a.locationId : undefined };
        const fill = (v) => (typeof v === 'string' ? v.replace(/\{(companyId|locationId)\}/g, (m, k) => fills[k] || m) : v);
        const query = a.query && typeof a.query === 'object' ? Object.fromEntries(Object.entries(a.query).map(([k, v]) => [k, Array.isArray(v) ? v.map(fill) : fill(v)])) : undefined;
        const r = await call({ token, method, path: checked.path, query, body: a.body, version: a.version });
        return [out(r), r.status >= 400];
      }
      default:
        return [{ error: 'unknown tool' }, true];
    }
  }

  /** Express middleware for /mcp (mounted path). `forward` is the existing GHL forwarder. */
  return function agencyMcp(req, res, next) {
    if (req.method !== 'POST') return next();
    readBody(req).then(
      async (raw) => {
        req.bufferedBody = raw;
        let msg = null;
        try {
          msg = raw.length ? JSON.parse(raw.toString('utf8')) : null;
        } catch {
          return next(); // not ours: GHL answers the parse error as before
        }
        if (!msg || Array.isArray(msg) || typeof msg !== 'object') return next();
        const accept = String(req.headers.accept || '');
        const sse = /text\/event-stream/i.test(accept) || !/application\/json/i.test(accept);

        if (msg.method === 'tools/call' && msg.params && handles(msg.params.name)) {
          try {
            const [payload, isError] = await runTool(msg.params.name, msg.params.arguments);
            logger.info({ msg: 'agency_mcp_tool', tool: msg.params.name, error: Boolean(isError) });
            return sendRpc(res, toolResult(msg.id, payload, isError), { sse });
          } catch (err) {
            logger.error({ msg: 'agency_mcp_tool_failed', tool: msg.params.name, name: err && err.name });
            return sendRpc(res, toolResult(msg.id, { error: 'internal_error' }, true), { sse });
          }
        }

        if (msg.method === 'tools/list' && !(msg.params && msg.params.cursor)) {
          const headers = buildUpstreamHeaders(req, ghlConfig, 'mcp');
          delete headers['transfer-encoding'];
          headers['content-length'] = raw.length;
          const up = await new Promise((resolve) => {
            const r = transport.request(
              { protocol: base.protocol, hostname: base.hostname.replace(/^\[|\]$/g, ''), port: base.port || undefined, method: 'POST', path: `/mcp${req.url}`, headers, timeout: ghlConfig.upstreamTimeoutMs },
              (upRes) => {
                const chunks = [];
                upRes.on('data', (c) => chunks.push(c));
                upRes.on('end', () => resolve({ status: upRes.statusCode, type: upRes.headers['content-type'], session: upRes.headers['mcp-session-id'], text: Buffer.concat(chunks).toString('utf8') }));
                upRes.on('error', () => resolve(null));
              },
            );
            r.on('timeout', () => r.destroy(new Error('timeout')));
            r.on('error', () => resolve(null));
            r.end(raw);
          });
          let parsed = null;
          try {
            parsed = up && up.status === 200 ? parseMcpBody(up.text, up.type) : null;
          } catch {
            parsed = null;
          }
          if (parsed && parsed.result && Array.isArray(parsed.result.tools)) {
            parsed.result.tools = [...parsed.result.tools, ...extraTools];
            const keep = up.session ? { 'Mcp-Session-Id': up.session } : {};
            logger.info({ msg: 'mcp_tools_list', added: extraTools.length });
            return sendRpc(res, parsed, { sse: /text\/event-stream/i.test(up.type || ''), headers: keep });
          }
          if (up) {
            logger.warn({ msg: 'mcp_tools_list_passthrough', status: up.status });
            // GHL error or unexpected shape: relay what it said, unchanged.
            res.writeHead(up.status, { 'Content-Type': up.type || 'application/json', 'Cache-Control': 'no-store' });
            return res.end(up.text);
          }
          return sendJson(res, 502, { error: 'bad_gateway' });
        }
        return next();
      },
      (err) => {
        if (err && err.code === 'TOO_LARGE') return sendJson(res, 413, { error: 'payload_too_large' });
        return sendJson(res, 400, { error: 'bad_request' });
      },
    );
  };
}

module.exports = { createAgencyMcp, AGENCY_TOOLS: TOOLS, EXIMIA_TOOLS, parseMcpBody };
