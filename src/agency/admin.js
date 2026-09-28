'use strict';

const { sendJson } = require('../http-util');

// Read-only probes, one per agency permission Muse is likely to use. Diagnostics only: the
// agency API itself passes every route through.
// agencyOnly: GHL answers these only to agency tokens (sub-account tokens can also search
// locations and users), so they tell an agency token from a sub-account one.
const PROBES = [
  { id: 'locations', label: 'Subcuentas', scope: 'locations.readonly', path: (c) => `/locations/search?companyId=${c}&limit=1` },
  { id: 'users', label: 'Usuarios', scope: 'users.readonly', path: (c) => `/users/search?companyId=${c}&limit=1` },
  { id: 'snapshots', label: 'Snapshots', scope: 'snapshots.readonly', agencyOnly: true, path: (c) => `/snapshots/?companyId=${c}` },
  { id: 'saas', label: 'SaaS (planes)', scope: 'saas/company.read', agencyOnly: true, version: '2021-04-15', path: (c) => `/saas/agency-plans/${c}` },
  { id: 'menus', label: 'Menús personalizados', scope: 'custom-menu-link.readonly', agencyOnly: true, path: () => '/custom-menus/?limit=1' },
];

// Every scope GHL offers an agency Private Integration (as of 2026). Ticking all of them lets
// Muse do everything GHL allows at agency level.
const SCOPES = [
  'companies.readonly',
  'locations.readonly',
  'locations.write',
  'users.readonly',
  'users.write',
  'snapshots.readonly',
  'snapshots.write',
  'saas/company.read',
  'saas/company.write',
  'saas/location.read',
  'saas/location.write',
  'custom-menu-link.readonly',
  'custom-menu-link.write',
  'marketplace-installer-details.readonly',
  'twilioaccount.read',
  'phonenumbers.read',
  'numberpools.read',
  'documents_contracts/list.readonly',
  'documents_contracts/sendLink.write',
  'documents_contracts_template/list.readonly',
  'documents_contracts_template/sendLink.write',
];

const round1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : null);
const ok2xx = (res) => res.status >= 200 && res.status < 300;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** GHL's error text, whatever the service's shape ({statusCode,message}, {status,message}, {error:{message}}). */
function ghlText(res) {
  const body = parseJson(res.text);
  if (!body || typeof body !== 'object') return '';
  const raw = (body.error && typeof body.error === 'object' && body.error.message) || body.message || body.error || body.msg || '';
  return (Array.isArray(raw) ? raw.join(', ') : String(raw)).slice(0, 160);
}

function ghlMessage(res) {
  if (res.status === 0) return `sin conexión (${res.error})`;
  const text = ghlText(res);
  return `HTTP ${res.status}${text ? ` · ${text}` : ''}`;
}

/** Why GHL refused, in plain words, for the panel. */
function refusal(res, scope) {
  const text = ghlText(res);
  if (res.status === 0) return `No se pudo llamar a GoHighLevel (${res.error}).`;
  if (/invalid private integration token|invalid jwt/i.test(text)) return 'GoHighLevel no reconoce el token. Cópialo de nuevo en GHL_AGENCY_TOKEN y haz Redeploy.';
  if (/not authorized for this scope|scope/i.test(text)) return `Falta el permiso ${scope} en la Private Integration de la agencia.`;
  return `GoHighLevel respondió ${ghlMessage(res)}.`;
}

function connectionInfo(config, ghlConfig, host, companyId) {
  const h = host ?? 'PENDIENTE';
  return {
    agency_host: h,
    auth_placement: 'header:X-Proxy-Key',
    rest_base_path: '/agency',
    health_url: `https://${h}/health`,
    company_id: companyId || 'PENDIENTE (Muse lo lee en el paso 3b)',
    eximia_location_id: ghlConfig.ghlLocationId,
    delete_sub_accounts: config.allowDelete ? 'allowed' : 'blocked',
    version: ghlConfig.version,
  };
}

/** Ready-to-paste instructions for Muse. No secrets: the key goes through Muse's secure card. */
function museMessage(info, config, ghlConfig) {
  const host = info.agency_host;
  const base = `https://${host}${info.rest_base_path}`;
  const loc = info.eximia_location_id;
  const company = /^PENDIENTE/.test(info.company_id) ? '<companyId>' : info.company_id;
  const deleteRule = config.allowDelete
    ? '- Borrar subcuentas (`DELETE /locations/{id}`) está PERMITIDO en el proxy, pero no se puede deshacer: hazlo solo si te lo pido por escrito, nombrando la subcuenta, y después de repetirme cuál vas a borrar.'
    : '- Borrar subcuentas (`DELETE /locations/{id}`) está BLOQUEADO en el proxy: responde 403 `blocked_by_proxy` y no llega a GoHighLevel. No intentes otra vía; dime que se hace a mano en GoHighLevel.';
  return `# Conectar GoHighLevel AGENCIA a través del proxy

Hola Muse. Esta es una API NUEVA y SEPARADA para administrar toda mi agencia de GoHighLevel (no solo la subcuenta Eximia). Usa el token de la agencia, que vive en el servidor. Este mensaje no contiene secretos: la llave te la daré por tu tarjeta segura de credenciales, nunca por el chat.

Importante: es una llave DISTINTA de la de GoHighLevel Eximia y de la de Kraken, y va en otro conector. No toques esos dos conectores: siguen igual.

## Datos de conexión

\`\`\`yaml
${Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('\n')}
\`\`\`

## Qué hacer

1. Registra el conector \`custom.gohighlevel-agency\` con \`api_hosts=["${host}"]\` usando tu flujo seguro de credenciales. Pídeme la llave de la AGENCIA en la tarjeta segura. Guárdala como secreto y envíala SIEMPRE en el header \`X-Proxy-Key\`. Nunca la muestres ni la escribas en el chat, en logs ni en archivos.
2. Añade a tu skill de GoHighLevel un cliente \`bin/ghl-agency\`: \`${base}/<ruta>\`, donde <ruta> es exactamente la del API v2 de GHL (lo que iría después de https://services.leadconnectorhq.com), con la misma query y el mismo cuerpo. No envíes el token de GoHighLevel ni el header Authorization: el proxy los pone.
3. Verifica, en este orden:
   a. \`GET ${info.health_url}\` → \`{"ok": true, ...}\`
   b. \`GET ${base}/locations/${loc}\` con \`X-Proxy-Key\` → 200. Guarda \`location.companyId\`: es el ID de la agencia${company === '<companyId>' ? '' : ` (${company})`}.
   c. \`GET ${base}/locations/search?companyId=${company}&limit=10\` → 200 con \`"locations"\` (las subcuentas de la agencia).
4. Confírmame en una línea que quedó conectado y cuántas subcuentas ves.

## Qué puedes hacer con esta API (nivel agencia)

- Subcuentas: buscar y listar (\`GET /locations/search?companyId=...&skip=0&limit=100\`), ver una (\`GET /locations/{id}\`), crear (\`POST /locations/\`) y modificar (\`PUT /locations/{id}\`).
- Usuarios de la agencia y de las subcuentas: buscar (\`GET /users/search?companyId=...\`), ver, crear, modificar y borrar.
- Snapshots: listar (\`GET /snapshots/?companyId=...\`), enlace para compartir y estado de envío a una subcuenta.
- SaaS: planes, suscripciones, activar o pausar el SaaS de una subcuenta, rebilling.
- Datos de la agencia (\`GET /companies/{companyId}\`), menús personalizados (\`/custom-menus/\`), contratos y documentos, y cualquier otra ruta que GoHighLevel permita con un token de agencia.

## Lo que NO puede hacer (límite de GoHighLevel, no del proxy)

GoHighLevel no deja que un token de agencia lea ni cambie datos DENTRO de las subcuentas: contactos, conversaciones, oportunidades, calendarios, workflows, pagos, etc. Si lo intentas, GHL responde 401/403.
- Para los datos de Eximia usa el conector de siempre (\`custom.gohighlevel-proxy\`), que sigue igual.
- Para datos dentro de OTRA subcuenta, dímelo: hace falta un token de esa subcuenta.
- Esta API no tiene MCP: usa REST.

## Reglas

- Antes de CUALQUIER cambio (crear o modificar subcuentas, usuarios, snapshots, SaaS o facturación, menús), dime exactamente qué vas a hacer y en qué subcuenta, y espera mi confirmación explícita en el chat. Uno por uno. Leer no necesita confirmación.
${deleteRule}
- Nunca envíes un snapshot con \`override: true\` a una subcuenta sin mi confirmación: sobrescribe lo que ya existe.
- \`companyId\`: casi todas las rutas de agencia lo piden (en la query o en el cuerpo).
- Header \`Version\`: si no lo envías, el proxy pone \`${ghlConfig.ghlVersion}\`, y \`2021-04-15\` en las rutas \`/saas/\` y \`/saas-api/\`. Para rutas v3 envía \`Version: v3\`.
- Límites: GHL permite 100 llamadas cada 10 s; el proxy, ${ghlConfig.rateLimitMax} cada ${ghlConfig.rateLimitWindowMs / 1000} s para esta API. Si recibes 429, espera lo que indique \`Retry-After\`.

## Si algo falla

- 401 \`{"error":"unauthorized"}\`: la llave del proxy falta o es incorrecta (¿usaste la de Eximia o la de Kraken?). Pídemela otra vez por la tarjeta segura.
- 401 de GHL «The token is not authorized for this scope»: al token de la agencia le falta ese permiso, o la ruta es de datos dentro de una subcuenta (ver arriba). Dime cuál ruta fue.
- 401 de GHL «This AuthClass is not yet supported» o «not yet supported by the IAM Service»: GoHighLevel no permite esa ruta con un token de agencia. No reintentes.
- 401 de GHL «Invalid Private Integration token»: avísame, hay que cambiar el token en el servidor.
- 403 \`blocked_by_proxy\`: el proxy lo bloquea a propósito. No insistas.
- 429: espera \`Retry-After\`. 502/504: GHL no respondió; reintenta en unos minutos (en cambios, primero comprueba si se hizo).
- 503 \`agency_not_configured\`: falta el token de la agencia en el servidor. Avísame.
`;
}

/** A read straight to GoHighLevel with the agency token (diagnostics only). */
function directCall(call, config, ghlConfig) {
  return (p, version = ghlConfig.ghlVersion, timeoutMs = undefined) =>
    call(ghlConfig.upstreamBase, p, {
      headers: { Authorization: `Bearer ${config.token}`, Version: version, Accept: 'application/json', 'User-Agent': ghlConfig.userAgent },
      timeoutMs,
    });
}

/** location.companyId from GET /locations/{id}, which agency tokens are documented to read. */
function companyIdOf(res) {
  const body = parseJson(res.text);
  return ok2xx(res) && body && body.location && typeof body.location.companyId === 'string' ? body.location.companyId : null;
}

function createAgencyChecks({ config, ghlConfig, getSelfUrl, call, discovered, ghlCheckMarker }) {
  const loc = encodeURIComponent(ghlConfig.ghlLocationId);
  const mark = config.checkMarker ? { 'X-Agency-Check': config.checkMarker } : {};
  const direct = directCall(call, config, ghlConfig);

  async function run() {
    const checks = [];
    const add = (id, label, status, detail, ms) => checks.push({ id, label, status, detail, ms: round1(ms) });
    const permissions = [];
    let company = null;

    if (config.enabled) {
      add('config', 'Token de la agencia en el servidor', 'ok', config.accessKeySource === 'env' ? 'Puesto. La llave de Muse viene de GHL_AGENCY_PROXY_KEY.' : 'Puesto. La llave de Muse se genera a partir de él.');
    } else if (config.started) {
      add('config', 'Token de la agencia en el servidor', 'fail', config.problems.join(' '));
    } else {
      add('config', 'Token de la agencia en el servidor', 'warn', 'Aún no está puesto. Sigue la guía «Configurar la API de agencia».');
    }

    if (config.enabled) {
      // 1. The token, and the agency id through the Eximia sub-account (documented for agency tokens).
      const location = await direct(`/locations/${loc}`);
      const foundId = companyIdOf(location);
      // What GoHighLevel says wins over GHL_COMPANY_ID, which is only a fallback.
      const companyId = foundId || config.companyId;
      if (foundId) discovered.companyId = foundId;
      if (ok2xx(location)) {
        add('token', 'Token de la agencia', 'ok', `GoHighLevel lo acepta${companyId ? ` · ID de la agencia: ${companyId}` : ''}.`, location.ms);
      } else {
        add('token', 'Token de la agencia', 'fail', refusal(location, 'locations.readonly'), location.ms);
      }
      if (foundId && config.companyId && foundId !== config.companyId) {
        add('company_id', 'ID de la agencia', 'warn', `GHL_COMPANY_ID (${config.companyId}) no coincide con la agencia de Eximia según GoHighLevel (${foundId}). El panel usa ${foundId}: corrige o borra GHL_COMPANY_ID.`);
      }

      // 2. What the token can read, one family at a time.
      if (companyId) {
        const cid = encodeURIComponent(companyId);
        const comp = await direct(`/companies/${cid}`);
        const cbody = parseJson(comp.text);
        if (ok2xx(comp) && cbody && cbody.company) {
          company = {
            name: typeof cbody.company.name === 'string' ? cbody.company.name.slice(0, 80) : null,
            locationCount: typeof cbody.company.locationCount === 'number' ? cbody.company.locationCount : null,
          };
        }
        permissions.push({
          id: 'company',
          label: 'Datos de la agencia',
          scope: 'companies.readonly',
          agencyOnly: true,
          state: ok2xx(comp) ? 'ok' : 'warn',
          detail: ok2xx(comp) ? 'Acceso OK' : refusal(comp, 'companies.readonly'),
        });
        const results = await Promise.all(PROBES.map(async (p) => ({ p, res: await direct(p.path(cid), p.version) })));
        for (const { p, res } of results) {
          permissions.push({ id: p.id, label: p.label, scope: p.scope, agencyOnly: Boolean(p.agencyOnly), state: ok2xx(res) ? 'ok' : 'warn', detail: ok2xx(res) ? 'Acceso OK' : refusal(res, p.scope) });
        }
      }

      // 3. Data inside a sub-account: GHL does not allow it with an agency token (expected).
      const contacts = await direct(`/contacts/?locationId=${loc}&limit=1`);
      const inside = ok2xx(contacts);
      permissions.push({
        id: 'subaccount-data',
        label: 'Datos dentro de subcuentas',
        scope: null,
        state: inside ? 'ok' : 'info',
        detail: inside
          ? 'Este token también lee contactos de Eximia.'
          : 'No: GoHighLevel no lo permite con un token de agencia (normal). Para los datos de Eximia, Muse usa la API de Eximia.',
      });
      // Reads contacts but nothing only an agency token can read: a sub-account token.
      const agencyOnlyReads = permissions.filter((p) => p.agencyOnly && p.state === 'ok').length;
      if (inside && agencyOnlyReads === 0) {
        add('kind', 'Tipo de token', 'fail', 'Parece un token de SUBCUENTA, no de la agencia: lee contactos de Eximia pero nada que solo la agencia puede leer. Crea la Private Integration en la vista de Agencia (Agency Settings), no dentro de una subcuenta.');
      }
      for (const p of permissions) delete p.agencyOnly;

      const missing = permissions.filter((p) => p.scope && p.state !== 'ok');
      if (companyId) {
        add(
          'scopes',
          'Permisos del token',
          missing.length === 0 ? 'ok' : 'warn',
          missing.length === 0
            ? 'Puede leer agencia, subcuentas, usuarios, snapshots, SaaS y menús.'
            : `Sin acceso a: ${missing.map((p) => p.label.toLowerCase()).join(', ')}. Revisa «Permisos del token de agencia».`,
        );
      }

      // 4. The agency API as Muse uses it. Keys and panel markers only ever go to this
      // deployment's own address; a mistyped GHL_AGENCY_PUBLIC_HOST must not receive them.
      const self = getSelfUrl();
      if (!self) {
        const why = 'No se pudo probar: el servidor no conoce su propia dirección (VERCEL_PROJECT_PRODUCTION_URL).';
        add('proxy', 'Conexión de Muse', 'warn', why);
        add('separate', 'Llaves separadas', 'warn', why);
      } else {
        const get = (p, headers = {}) => call(self, p, { headers: { ...mark, ...headers } });
        const viaProxy = await get(`/agency/locations/${loc}`, { 'X-Proxy-Key': config.accessKey });
        if (ok2xx(viaProxy)) {
          add('proxy', 'Conexión de Muse', 'ok', 'Una llamada con la llave de la agencia responde bien a través del proxy.', viaProxy.ms);
        } else {
          add('proxy', 'Conexión de Muse', 'fail', `La llamada de prueba falló: ${ghlMessage(viaProxy)}`, viaProxy.ms);
        }

        const noKey = await get(`/agency/locations/${loc}`);
        add('auth', 'Sin llave no entra nadie', noKey.status === 401 ? 'ok' : 'fail', noKey.status === 401 ? 'Una llamada sin la llave fue rechazada y no llegó a GoHighLevel.' : `Una llamada sin la llave NO fue rechazada (HTTP ${noKey.status}).`, noKey.ms);

        const eximiaKey = await get(`/agency/locations/${loc}`, { 'X-Proxy-Key': ghlConfig.proxyKey });
        // Marked as the Eximia panel's own test, so it is not counted as a wrong key there.
        const eximiaMark = ghlCheckMarker ? { 'X-Admin-Check': ghlCheckMarker } : {};
        const agencyKeyOnEximia = await call(self, `/ghl/locations/${loc}`, { headers: { ...eximiaMark, 'X-Proxy-Key': config.accessKey } });
        const separate = eximiaKey.status === 401 && agencyKeyOnEximia.status === 401;
        add(
          'separate',
          'Llaves separadas',
          separate ? 'ok' : 'fail',
          separate ? 'La llave de Eximia no abre la API de agencia, y la de agencia no abre la de Eximia.' : `Las llaves NO están separadas (HTTP ${eximiaKey.status} / ${agencyKeyOnEximia.status}).`,
        );
      }

      // The address given to Muse: only a keyless health call goes there.
      if (config.publicHost) {
        const health = await call(`https://${config.publicHost}`, '/health');
        const body = parseJson(health.text);
        const same = health.status === 200 && body && body.ok === true && body.version === ghlConfig.version;
        add(
          'public',
          'Dirección para Muse',
          same ? 'ok' : 'fail',
          same
            ? `${config.publicHost} responde (versión ${ghlConfig.version}).`
            : `${config.publicHost} no responde como este proxy (${health.status ? `HTTP ${health.status}` : health.error}). Revisa que el dominio esté añadido al proyecto en Vercel y que GHL_AGENCY_PUBLIC_HOST esté bien escrito.`,
          health.ms,
        );
      }
    }

    add(
      'delete',
      'Borrar subcuentas',
      config.allowDelete ? 'warn' : 'ok',
      config.allowDelete
        ? 'PERMITIDO (GHL_AGENCY_ALLOW_DELETE=true): Muse puede borrar subcuentas, y eso no se puede deshacer.'
        : 'Bloqueado en el proxy: borrar una subcuenta no se puede deshacer. Todo lo demás está permitido.',
    );

    const statuses = checks.map((c) => c.status);
    const overall = !config.enabled ? (config.started ? 'fail' : 'setup') : statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'ok';
    return { ranAt: new Date().toISOString(), overall, checks, permissions, company };
  }

  let inflight = null;
  return () => {
    if (!inflight) inflight = run().finally(() => { inflight = null; });
    return inflight;
  };
}

/**
 * Adds the panel's agency endpoints to the admin router (same PIN session and CSRF rules).
 *   GET  /api/agency/overview   state, Muse message, activity
 *   POST /api/agency/checks     live checks
 *   POST /api/agency/key        reveals the agency access key for Muse
 */
function mountAgencyAdmin(router, { config, ghlConfig, metrics, logger, requireSession, sameOriginJson, publicHost, getSelfUrl, call, ghlCheckMarker }) {
  // The agency id as GoHighLevel reports it, once read (per instance; GHL_COMPANY_ID is the fallback).
  const discovered = { companyId: null };
  const runChecks = createAgencyChecks({ config, ghlConfig, getSelfUrl, call, discovered, ghlCheckMarker });
  const hostFor = (req) => config.publicHost || publicHost(req);
  const direct = directCall(call, config, ghlConfig);

  // Every instance can build the full Muse message: one quick read, at most once a minute
  // while it keeps failing.
  let lookedUpAt = -Infinity;
  async function companyId() {
    if (!discovered.companyId && config.enabled && Date.now() - lookedUpAt > 60_000) {
      lookedUpAt = Date.now();
      const found = companyIdOf(await direct(`/locations/${encodeURIComponent(ghlConfig.ghlLocationId)}`, undefined, 5000));
      if (found) discovered.companyId = found;
    }
    return discovered.companyId || config.companyId;
  }

  router.get('/api/agency/overview', requireSession, async (req, res) => {
    const info = connectionInfo(config, ghlConfig, hostFor(req), await companyId());
    sendJson(res, 200, {
      configured: config.enabled,
      started: config.started,
      problems: config.problems,
      allowDelete: config.allowDelete,
      scopes: SCOPES,
      connection: info,
      museMessage: config.enabled ? museMessage(info, config, ghlConfig) : null,
      key: config.enabled
        ? { source: config.accessKeySource, length: config.accessKey.length, tokenHint: `${config.token.startsWith('pit-') ? 'pit-' : ''}…${config.token.slice(-4)}` }
        : null,
      rateLimit: { max: ghlConfig.rateLimitMax, windowSeconds: ghlConfig.rateLimitWindowMs / 1000 },
      metrics: metrics.snapshot(),
    });
  });

  router.post('/api/agency/checks', sameOriginJson, requireSession, async (req, res, next) => {
    try {
      sendJson(res, 200, await runChecks());
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/agency/key', sameOriginJson, requireSession, (req, res) => {
    if (!config.enabled) return sendJson(res, 409, { error: 'not_configured' });
    logger.info({ msg: 'admin_agency_key_revealed' });
    return sendJson(res, 200, { accessKey: config.accessKey });
  });
}

module.exports = { mountAgencyAdmin, museMessage, connectionInfo, createAgencyChecks, SCOPES };
