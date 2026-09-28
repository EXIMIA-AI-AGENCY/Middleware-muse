'use strict';

const { sendJson } = require('../http-util');
const { DEFAULT_API_VERSION } = require('./client');

// Read-only probes, one per resource family Muse is likely to use (GET, ?limit=1, no side
// effects). `perm` is the name of the permission in Stripe's restricted-key editor.
const PROBES = [
  { id: 'customers', label: 'Clientes', perm: 'Customers', path: '/v1/customers?limit=1' },
  { id: 'charges', label: 'Cobros y reembolsos', perm: 'Charges and Refunds', path: '/v1/charges?limit=1' },
  { id: 'payment_intents', label: 'Pagos', perm: 'PaymentIntents', path: '/v1/payment_intents?limit=1' },
  { id: 'invoices', label: 'Facturas', perm: 'Invoices', path: '/v1/invoices?limit=1' },
  { id: 'subscriptions', label: 'Suscripciones', perm: 'Subscriptions', path: '/v1/subscriptions?limit=1' },
  { id: 'products', label: 'Productos', perm: 'Products', path: '/v1/products?limit=1' },
  { id: 'prices', label: 'Precios', perm: 'Prices', path: '/v1/prices?limit=1' },
  { id: 'coupons', label: 'Cupones', perm: 'Coupons', path: '/v1/coupons?limit=1' },
  { id: 'checkout', label: 'Checkout', perm: 'Checkout Sessions', path: '/v1/checkout/sessions?limit=1' },
  { id: 'payment_links', label: 'Payment Links', perm: 'Payment Links', path: '/v1/payment_links?limit=1' },
  { id: 'disputes', label: 'Disputas', perm: 'Disputes', path: '/v1/disputes?limit=1' },
  { id: 'balance_transactions', label: 'Movimientos del saldo', perm: 'Balance', path: '/v1/balance_transactions?limit=1' },
  { id: 'payouts', label: 'Payouts (leer)', perm: 'Payouts', path: '/v1/payouts?limit=1' },
  { id: 'events', label: 'Eventos', perm: 'Events', path: '/v1/events?limit=1' },
];
const PROBE_CONCURRENCY = 4;
const PROBE_TIMEOUT_MS = 5000;
const PROBES_DEADLINE_MS = 15_000;

const round1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : null);
const ok2xx = (res) => res.status >= 200 && res.status < 300;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stripeMessage(res) {
  if (res.status === 0) return `sin conexión (${res.error})`;
  const body = parseJson(res.text);
  const e = body && body.error && typeof body.error === 'object' ? body.error : null;
  const text = e && typeof e.message === 'string' ? e.message.slice(0, 200) : '';
  return `HTTP ${res.status}${text ? ` · ${text}` : ''}`;
}

/** What a failed read means, in words the owner can act on. */
function readRefusal(res, perm) {
  const body = parseJson(res.text);
  const code = body && body.error && body.error.code;
  if (res.status === 0) return `No se pudo llamar a Stripe ahora (${res.error}). Vuelve a verificar en un momento.`;
  if (res.status === 429 || res.status >= 500) return `Stripe no pudo responder ahora (${stripeMessage(res)}). No es un problema de la clave: vuelve a verificar en un momento.`;
  if (res.status === 401) return 'Stripe no acepta la clave: cópiala de nuevo en STRIPE_SECRET_KEY y haz Redeploy.';
  if (res.status === 403) return `Falta el permiso «${perm}» (Read) en la clave restringida.`;
  if (res.status === 400 && /inactive|not_active|platform_account_required/.test(code || '')) return 'Ese producto de Stripe no está activado en la cuenta (normal si no lo usas).';
  return `Stripe respondió ${stripeMessage(res)}.`;
}

const keyHint = (key) => `${key.slice(0, key.indexOf('_', 3) + 1)}…${key.slice(-4)}`;

function connectionInfo(config, host, version) {
  const h = host ?? 'PENDIENTE';
  return {
    stripe_host: h,
    auth_placement: 'header:X-Proxy-Key',
    rest_base_path: '/stripe',
    health_url: `https://${h}/health`,
    mode: config.mode || 'PENDIENTE',
    stripe_version: config.apiVersion || DEFAULT_API_VERSION,
    money_out: config.allowMoneyOut ? 'allowed' : 'blocked',
    access_grants: config.allowAccessGrants ? 'allowed' : 'blocked',
    version,
  };
}

/** Ready-to-paste instructions for Muse. No secrets: the key goes through Muse's secure card. */
function museMessage(info, config) {
  const host = info.stripe_host;
  const base = `https://${host}${info.rest_base_path}`;
  const live = config.mode === 'live';
  const moneyOut = config.allowMoneyOut
    ? '- Payouts, transferencias y cambios de cuenta bancaria están PERMITIDOS en el proxy, pero mueven dinero fuera y no se pueden deshacer: hazlos solo si te lo pido por escrito, con el importe exacto, y después de repetirme qué vas a hacer.'
    : '- Payouts (sacar dinero al banco), transferencias a cuentas conectadas y cambios de cuenta bancaria o calendario de payouts están BLOQUEADOS en el proxy: responden 403 `blocked_by_proxy` y no llegan a Stripe. No busques otra vía; dime que lo haga yo en el Dashboard.';
  const access = config.allowAccessGrants
    ? '- Webhooks, enlaces públicos a archivos y enlaces de acceso están PERMITIDOS, pero pueden romper integraciones o sacar datos: pídeme confirmación antes de cada uno.'
    : '- Crear, cambiar o borrar webhooks, enlaces públicos a archivos, enlaces de acceso a cuentas y reenvío de datos de tarjeta están BLOQUEADOS (403 `blocked_by_proxy`): podrían romper lo que ya está conectado a Stripe o sacar datos. No insistas.';
  return `# Conectar Stripe a través del proxy (modo ${live ? 'LIVE: dinero real' : 'TEST: nada es real'})

Hola Muse. Vamos a conectar mi cuenta de Stripe a través de nuestro proxy. El proxy guarda la clave de Stripe; tú solo usas una llave del proxy. Este mensaje no contiene secretos: la llave te la daré por tu tarjeta segura de credenciales, nunca por el chat.

Importante: es una llave DISTINTA de las de GoHighLevel (Eximia y Agencia) y de la de Kraken, y va en otro conector. No toques esos conectores.

## Datos de conexión

\`\`\`yaml
${Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('\n')}
\`\`\`

## Qué hacer

1. Registra el conector \`custom.stripe-proxy\` con \`api_hosts=["${host}"]\` usando tu flujo seguro de credenciales. Pídeme la llave de STRIPE en la tarjeta segura. Guárdala como secreto y envíala SIEMPRE en el header \`X-Proxy-Key\`. Nunca la muestres ni la escribas en el chat, en logs ni en archivos.
2. Crea la skill \`~/workspace/skills/stripe/\` con un cliente \`bin/stripe-proxy\`: \`${base}/<ruta>\`, donde <ruta> es exactamente la del API de Stripe (lo que iría después de https://api.stripe.com), por ejemplo \`${base}/v1/customers?limit=10\`. No envíes la clave de Stripe ni el header Authorization: el proxy los pone.
3. Verifica, en este orden:
   a. \`GET ${info.health_url}\` → \`{"ok": true, ...}\`
   b. \`GET ${base}/v1/balance\` con \`X-Proxy-Key\` → 200 con \`"object": "balance"\` (\`livemode\` ${live ? 'true' : 'false'}). No hace falta que me digas el saldo.
   c. \`GET ${base}/v1/customers?limit=3\` → 200 con \`"data"\`.
4. Confírmame en una línea que quedó conectado y en qué modo (live o test).

## Cómo se habla con Stripe

- Métodos: GET para leer, POST para crear o cambiar, DELETE para borrar (no hay PUT ni PATCH).
- En GET, los parámetros van SIEMPRE en la query (\`?customer=cus_...&limit=10\`); un GET con cuerpo se rechaza.
- Cuerpo de /v1: \`application/x-www-form-urlencoded\` (\`metadata[pedido]=123\`, \`items[0][price]=price_...\`, \`expand[]=customer\`). También puedes mandar JSON: el proxy lo convierte al formato de Stripe (verás \`X-Proxy-Converted: json-to-form\`). Para /v2 usa JSON.
- Importes en la unidad más pequeña de la moneda y como entero: 10,50 USD = \`amount=1050\`, \`currency=usd\` (minúsculas). OJO: en monedas sin decimales (jpy, krw, clp, vnd, xof…) el importe va tal cual: 1000 JPY = \`amount=1000\`. Si dudas, pregúntame antes de cobrar.
- Listas: \`limit\` de 1 a 100 (por defecto 10) y \`has_more\`; para la página siguiente usa \`starting_after=<id del último>\`.
- Búsqueda: \`GET ${base}/v1/customers/search?query=email:"ana@ejemplo.com"\` (también charges, invoices, payment_intents, prices, products, subscriptions). Tarda hasta ~1 min en ver lo recién creado; para leer lo que acabas de crear usa su ID. Paginación con \`page=<next_page>\`.
- \`expand[]=...\` trae objetos relacionados (máximo 4 niveles).
- Versión del API: el proxy manda \`Stripe-Version: ${info.stripe_version}\` si tú no mandas otra. Usa esa documentación.
- Cuentas conectadas (Connect): header \`Stripe-Account: acct_...\`.
- Subir archivos (\`/v1/files\`) no pasa por aquí: va a otro servidor de Stripe.

## Reintentos seguros (Idempotency-Key) — OBLIGATORIO

- Cada POST (y cada DELETE de /v2) DEBE llevar tu propio header \`Idempotency-Key\`: genera un UUID v4 nuevo por cada acción distinta y guárdalo ANTES de enviar. Sin él, el proxy responde 400 \`idempotency_key_required\` y no envía nada.
- Con el mismo \`Idempotency-Key\` y el mismo cuerpo, Stripe NUNCA hace la acción dos veces: devuelve el primer resultado (\`Idempotent-Replayed: true\`). Vale 24 h.
- El proxy ya reintenta solo cuando es seguro. Si aun así no te llega respuesta (timeout, conexión cortada, 502/504), repite la petición con el MISMO cuerpo y el MISMO \`Idempotency-Key\`; nunca con uno nuevo.
- Si Stripe rechazó la petición (4xx) y la corriges, mándala con un \`Idempotency-Key\` NUEVO.
- Si Stripe responde \`idempotency_error\`, esa clave ya se usó con otros datos: la petición original YA se procesó. Comprueba qué se hizo antes de mandar nada más.

## Qué significa cada respuesta (campo \`proxy\`)

Cuando algo falla, la respuesta es el error de Stripe (\`{"error": {"type", "code", "message", "param"}}\`) más un objeto \`proxy\`:
- \`proxy.summary\`: qué pasó, en español. Si algo falló, díselo al usuario con estas palabras.
- \`proxy.executed\` (en POST y DELETE que fallan): \`"no"\` = no se hizo nada · \`"unknown"\` = no se sabe (sigue \`proxy.next\`: repite con el MISMO Idempotency-Key). Una respuesta 2xx significa que se hizo.
- \`proxy.safe_to_retry\`: \`"yes"\` · \`"no"\` · \`"after-wait"\` · \`"same-key"\` (repite solo con el mismo Idempotency-Key).
- \`proxy.next\`: qué hacer ahora.
Las respuestas del propio proxy tienen \`error.type = "proxy_error"\`.

## Reglas

- ${live ? 'Es la cuenta REAL: cada cobro, reembolso o factura afecta a clientes reales.' : 'Es modo TEST: nada es real, pero trátalo como si lo fuera.'}
- Leer no necesita confirmación. Antes de CUALQUIER acción que cobre, devuelva dinero o llegue a un cliente, dime exactamente qué vas a hacer (cliente, importe, moneda) y espera mi confirmación explícita en el chat, una por una. Incluye: crear o confirmar pagos, capturar o cancelar pagos, reembolsos, crear/finalizar/enviar/pagar/anular facturas, crear o cancelar suscripciones, notas de crédito, crear Payment Links o sesiones de Checkout para clientes, borrar clientes, separar métodos de pago, cerrar disputas.
${moneyOut}
${access}
- Si Stripe responde \`approval_required\`, la acción quedó pendiente de mi aprobación en Stripe: avísame y no la repitas.
- No pegues en el chat más datos personales de clientes de los necesarios.
- Límites: Stripe permite unas 100 llamadas por segundo (25 en test); el proxy, ${config.rateLimitMax} cada ${config.rateLimitWindowMs / 1000} s. Haz una llamada a la vez. Si recibes 429, espera y repite.

## Errores más comunes

- 401 \`proxy_error\` \`unauthorized\`: la llave del proxy falta o es incorrecta. Pídemela otra vez por la tarjeta segura.
- 401 de Stripe: la clave de Stripe del servidor no vale. Avísame y no reintentes.
- 403 de Stripe: a la clave restringida le falta un permiso (el mensaje dice cuál). Dímelo.
- 402 \`card_error\`: el pago fue rechazado; no se cobró nada. No lo repitas igual.
- 403 \`blocked_by_proxy\`: bloqueado a propósito. No insistas.
- 404: el ID no existe (o es de otro modo, live/test).
- 502/504: no llegó respuesta de Stripe; mira \`proxy.executed\` y \`proxy.next\` antes de hacer nada.
- 503 \`stripe_not_configured\`: falta la clave de Stripe en el servidor. Avísame.
`;
}

async function runLimited(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return out;
}

function createStripeChecks({ config, client, getSelfUrl, call, ghlConfig, ghlCheckMarker, version, now = () => Date.now() }) {
  const mark = config.checkMarker ? { 'X-Stripe-Check': config.checkMarker } : {};

  async function run() {
    const checks = [];
    const add = (id, label, status, detail, ms) => checks.push({ id, label, status, detail, ms: round1(ms) });
    const permissions = [];
    let account = null;

    if (config.enabled) {
      add('config', 'Clave de Stripe en el servidor', 'ok', `Puesta (${config.keyKind === 'restricted' ? 'clave restringida' : 'clave secreta'}, modo ${config.mode === 'live' ? 'LIVE' : 'TEST'}). ${config.accessKeySource === 'env' ? 'La llave de Muse viene de STRIPE_PROXY_KEY.' : 'La llave de Muse se genera a partir de ella.'}`);
    } else if (config.started) {
      add('config', 'Clave de Stripe en el servidor', 'fail', config.problems.join(' '));
    } else {
      add('config', 'Clave de Stripe en el servidor', 'warn', 'Aún no está puesta. Sigue la guía «Configurar Stripe».');
    }

    if (config.enabled) {
      // 1. The key itself, with the cheapest read there is.
      const balance = await client.get('/v1/balance');
      const bbody = parseJson(balance.text);
      let keyOk = false;
      if (ok2xx(balance) && bbody && bbody.object === 'balance') {
        keyOk = true;
        const currencies = Array.isArray(bbody.available) ? bbody.available.length : 0;
        const modeOk = Boolean(bbody.livemode) === (config.mode === 'live');
        add('key', 'Clave válida', modeOk ? 'ok' : 'warn', `Stripe la acepta · modo ${bbody.livemode ? 'LIVE' : 'TEST'} · saldo en ${currencies} moneda${currencies === 1 ? '' : 's'}.`, balance.ms);
      } else if (balance.status === 403) {
        keyOk = true;
        add('key', 'Clave válida', 'warn', 'Stripe la acepta, pero no puede leer el saldo: falta el permiso «Balance» (Read).', balance.ms);
      } else if (balance.status === 0 || balance.status === 429 || balance.status >= 500) {
        add('key', 'Clave válida', 'warn', readRefusal(balance, 'Balance'), balance.ms);
      } else {
        add('key', 'Clave válida', 'fail', readRefusal(balance, 'Balance'), balance.ms);
      }

      if (keyOk) {
        // 2. The account (display name and whether it can charge), only safe fields.
        const acct = await client.get('/v1/account');
        const abody = parseJson(acct.text);
        if (ok2xx(acct) && abody && abody.object === 'account') {
          const name = (abody.business_profile && abody.business_profile.name) || (abody.settings && abody.settings.dashboard && abody.settings.dashboard.display_name) || null;
          account = {
            id: typeof abody.id === 'string' ? abody.id : null,
            name: typeof name === 'string' ? name.slice(0, 80) : null,
            country: typeof abody.country === 'string' ? abody.country : null,
            currency: typeof abody.default_currency === 'string' ? abody.default_currency : null,
            chargesEnabled: abody.charges_enabled === true,
            payoutsEnabled: abody.payouts_enabled === true,
          };
          add(
            'account',
            'Cuenta de Stripe',
            account.chargesEnabled ? 'ok' : 'warn',
            `${account.name || account.id}${account.country ? ` · ${account.country}` : ''}${account.chargesEnabled ? ' · puede cobrar' : ' · TODAVÍA NO puede cobrar (revisa la cuenta en Stripe)'}.`,
            acct.ms,
          );
        } else if (acct.status === 403) {
          add('account', 'Cuenta de Stripe', 'ok', 'La clave no puede leer los datos de la cuenta (normal en claves restringidas). No hace falta para Muse.', acct.ms);
        } else {
          add('account', 'Cuenta de Stripe', 'warn', readRefusal(acct, 'Accounts'), acct.ms);
        }

        // 3. What the key can read, a few probes at a time, within a fixed time budget.
        const deadline = now() + PROBES_DEADLINE_MS;
        const results = await runLimited(PROBES, PROBE_CONCURRENCY, async (p) => (now() > deadline ? null : client.get(p.path, PROBE_TIMEOUT_MS)));
        PROBES.forEach((p, i) => {
          const res = results[i];
          if (!res) permissions.push({ id: p.id, label: p.label, perm: p.perm, state: 'info', detail: 'No se probó (tiempo agotado).' });
          else if (ok2xx(res)) permissions.push({ id: p.id, label: p.label, perm: p.perm, state: 'ok', detail: 'Acceso OK' });
          else if (res.status === 400 || res.status === 0 || res.status === 429 || res.status >= 500) permissions.push({ id: p.id, label: p.label, perm: p.perm, state: 'info', detail: readRefusal(res, p.perm) });
          else permissions.push({ id: p.id, label: p.label, perm: p.perm, state: 'warn', detail: readRefusal(res, p.perm) });
        });
        const missing = permissions.filter((p) => p.state === 'warn');
        add(
          'scopes',
          'Permisos de la clave',
          missing.length ? 'warn' : 'ok',
          missing.length ? `Sin acceso a: ${missing.map((p) => p.label.toLowerCase()).join(', ')}. Revisa «Permisos de la clave de Stripe».` : 'Puede leer clientes, pagos, facturas, suscripciones, productos, disputas, saldo y más.',
        );
      }

      if (config.keyKind === 'secret') {
        add('kind', 'Tipo de clave', 'warn', 'Es la clave secreta completa (sk_). Mejor una clave restringida (rk_) solo para Muse: se puede revocar sin afectar a lo demás que usa Stripe.');
      }

      // 4. The Stripe API as Muse uses it. Keys and panel markers only go to this deployment.
      const self = getSelfUrl();
      if (!self) {
        const why = 'No se pudo probar: el servidor no conoce su propia dirección (VERCEL_PROJECT_PRODUCTION_URL).';
        add('proxy', 'Conexión de Muse', 'warn', why);
        add('separate', 'Llaves separadas', 'warn', why);
      } else {
        const request = (method, p, headers = {}) => call(self, `/stripe${p}`, { method, headers: { ...mark, ...headers } });
        const viaProxy = await request('GET', '/v1/balance', { 'X-Proxy-Key': config.accessKey });
        const vbody = parseJson(viaProxy.text);
        const reachedStripe = viaProxy.status > 0 && !(vbody && vbody.error && vbody.error.type === 'proxy_error');
        if (ok2xx(viaProxy) || (reachedStripe && viaProxy.status === 403)) {
          add('proxy', 'Conexión de Muse', 'ok', 'Una llamada con la llave de Stripe llega a Stripe a través del proxy.', viaProxy.ms);
        } else {
          add('proxy', 'Conexión de Muse', 'fail', `La llamada de prueba falló: ${stripeMessage(viaProxy)}`, viaProxy.ms);
        }

        const noKey = await request('GET', '/v1/balance');
        add('auth', 'Sin llave no entra nadie', noKey.status === 401 ? 'ok' : 'fail', noKey.status === 401 ? 'Una llamada sin la llave fue rechazada y no llegó a Stripe.' : `Una llamada sin la llave NO fue rechazada (HTTP ${noKey.status}).`, noKey.ms);

        const ghlKey = await request('GET', '/v1/balance', { 'X-Proxy-Key': ghlConfig.proxyKey });
        const eximiaMark = ghlCheckMarker ? { 'X-Admin-Check': ghlCheckMarker } : {};
        const stripeKeyOnGhl = await call(self, `/ghl/locations/${encodeURIComponent(ghlConfig.ghlLocationId)}`, { headers: { ...eximiaMark, 'X-Proxy-Key': config.accessKey } });
        const separate = ghlKey.status === 401 && stripeKeyOnGhl.status === 401;
        add('separate', 'Llaves separadas', separate ? 'ok' : 'fail', separate ? 'La llave de GHL no abre Stripe, y la de Stripe no abre GHL.' : `Las llaves NO están separadas (HTTP ${ghlKey.status} / ${stripeKeyOnGhl.status}).`);

        // The guards, with routes that would change nothing even if they reached Stripe.
        const probesGuard = [];
        if (!config.allowMoneyOut) probesGuard.push(['POST', '/v1/account/proxy-guard-test']);
        if (!config.allowAccessGrants) probesGuard.push(['POST', '/v1/webhook_endpoints/we_proxyguardtest']);
        if (probesGuard.length) {
          const answers = await Promise.all(probesGuard.map(([m, p]) => request(m, p, { 'X-Proxy-Key': config.accessKey, 'Content-Type': 'application/x-www-form-urlencoded' })));
          const blocked = answers.every((a) => a.status === 403 && /blocked_by_proxy/.test(a.text || ''));
          const tested = probesGuard.map(([, p]) => (p.includes('webhook') ? 'webhook' : 'payout/cuenta bancaria')).join(' y ');
          add('guard', 'Bloqueos activos', blocked ? 'ok' : 'fail', blocked ? `Pruebas de ${tested} bloqueadas sin llegar a Stripe.` : `Un bloqueo NO respondió como debe (HTTP ${answers.map((a) => a.status).join(' / ')}).`);
        }
      }

      if (config.publicHost) {
        const health = await call(`https://${config.publicHost}`, '/health');
        const body = parseJson(health.text);
        const sameProxy = health.status === 200 && body && body.ok === true && body.version === version;
        add(
          'public',
          'Dirección para Muse',
          sameProxy ? 'ok' : 'fail',
          sameProxy ? `${config.publicHost} responde (versión ${version}).` : `${config.publicHost} no responde como este proxy (${health.status ? `HTTP ${health.status}` : health.error}). Revisa el dominio en Vercel y STRIPE_PUBLIC_HOST.`,
          health.ms,
        );
      }
    }

    add('money_out', 'Dinero hacia fuera', config.allowMoneyOut ? 'warn' : 'ok', config.allowMoneyOut ? 'PERMITIDO (STRIPE_ALLOW_MONEY_OUT=true): Muse puede hacer payouts, transferencias y cambiar cuentas bancarias.' : 'Bloqueado: payouts, transferencias y cambios de cuenta bancaria. Todo lo demás está permitido.');
    add('access_grants', 'Accesos permanentes', config.allowAccessGrants ? 'warn' : 'ok', config.allowAccessGrants ? 'PERMITIDO (STRIPE_ALLOW_ACCESS_GRANTS=true): Muse puede crear webhooks, enlaces públicos y enlaces de acceso.' : 'Bloqueado: webhooks, enlaces públicos a archivos, enlaces de acceso y reenvío de datos de tarjeta.');

    const statuses = checks.map((c) => c.status);
    const overall = !config.enabled ? (config.started ? 'fail' : 'setup') : statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'ok';
    return { ranAt: new Date(now()).toISOString(), overall, checks, permissions, account };
  }

  let inflight = null;
  return () => {
    if (!inflight) inflight = run().finally(() => { inflight = null; });
    return inflight;
  };
}

/**
 * Adds the panel's Stripe endpoints to the admin router (same PIN session and CSRF rules).
 *   GET  /api/stripe/overview   state, Muse message, activity
 *   POST /api/stripe/checks     live checks
 *   POST /api/stripe/key        reveals the Stripe access key for Muse
 */
function mountStripeAdmin(router, { config, client, ghlConfig, metrics, logger, requireSession, sameOriginJson, publicHost, getSelfUrl, call, ghlCheckMarker }) {
  const version = ghlConfig.version;
  const runChecks = createStripeChecks({ config, client, getSelfUrl, call, ghlConfig, ghlCheckMarker, version });
  const hostFor = (req) => config.publicHost || publicHost(req);

  router.get('/api/stripe/overview', requireSession, (req, res) => {
    const info = connectionInfo(config, hostFor(req), version);
    sendJson(res, 200, {
      configured: config.enabled,
      started: config.started,
      problems: config.problems,
      mode: config.mode,
      keyKind: config.keyKind,
      allowMoneyOut: config.allowMoneyOut,
      allowAccessGrants: config.allowAccessGrants,
      connection: info,
      museMessage: config.enabled ? museMessage(info, { ...config, rateLimitMax: ghlConfig.rateLimitMax, rateLimitWindowMs: ghlConfig.rateLimitWindowMs }) : null,
      key: config.enabled ? { source: config.accessKeySource, length: config.accessKey.length, secretHint: keyHint(config.secretKey) } : null,
      rateLimit: { max: ghlConfig.rateLimitMax, windowSeconds: ghlConfig.rateLimitWindowMs / 1000 },
      metrics: metrics.snapshot(),
    });
  });

  router.post('/api/stripe/checks', sameOriginJson, requireSession, async (req, res, next) => {
    try {
      sendJson(res, 200, await runChecks());
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/stripe/key', sameOriginJson, requireSession, (req, res) => {
    if (!config.enabled) return sendJson(res, 409, { error: 'not_configured' });
    logger.info({ msg: 'admin_stripe_key_revealed' });
    return sendJson(res, 200, { accessKey: config.accessKey });
  });
}

module.exports = { mountStripeAdmin, museMessage, connectionInfo, createStripeChecks, PROBES, keyHint };
