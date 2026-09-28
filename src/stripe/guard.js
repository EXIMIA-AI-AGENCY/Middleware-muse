'use strict';

/**
 * What the Stripe API refuses before anything reaches Stripe.
 *
 * Paths are compared the way Stripe routes them: each segment percent-decoded once, lower
 * case, no trailing slash. A path that could be read two ways (an encoded "/" or "\",
 * ";", "." or ".." segments, empty segments, control characters) is refused outright, so a
 * rule can never be dodged by spelling the path differently.
 *
 * Rules come from Stripe's OpenAPI specs (GA and preview, 2026-09) and docs; every rule is
 * anchored and matched against method + path.
 */

const SEG = '[^/]+';
const R = (s) => new RegExp(`^${s}$`);

// Tier "money out": money leaves the Stripe balance, or where payouts go changes. None of it
// can be undone. Allowed only with STRIPE_ALLOW_MONEY_OUT=true.
const MONEY_OUT = [
  { methods: ['POST'], re: R('/v1/payouts'), what: 'crear un payout (sacar dinero del saldo de Stripe al banco)' },
  { methods: ['POST'], re: R(`/v1/payouts/${SEG}/reverse`), what: 'revertir un payout (cobrar al banco de una cuenta conectada)' },
  { methods: ['POST'], re: R('/v1/transfers'), what: 'enviar dinero a una cuenta conectada' },
  { methods: ['POST'], re: R(`/v1/transfers/${SEG}/reversals`), what: 'revertir una transferencia de una cuenta conectada' },
  { methods: ['POST'], re: R(`/v1/application_fees/${SEG}/refunds?`), what: 'devolver una comisión de aplicación' },
  { methods: ['POST'], re: R('/v1/balance_transfers'), what: 'mover dinero entre saldos' },
  { methods: ['POST', 'DELETE'], re: R(`/v1/accounts/${SEG}/(external_accounts|bank_accounts)(/${SEG})?`), what: 'cambiar la cuenta bancaria a la que van los payouts' },
  { methods: ['POST', 'DELETE'], re: R(`/v1/external_accounts(/${SEG})?`), what: 'cambiar la cuenta bancaria a la que van los payouts' },
  { methods: ['POST', 'DELETE'], re: R('/v1/account(/.*)?'), what: 'cambiar la cuenta de Stripe' },
  { methods: ['DELETE'], re: R(`/v1/accounts/${SEG}`), what: 'borrar una cuenta conectada' },
  { methods: ['POST'], re: R(`/v1/accounts/${SEG}/reject`), what: 'rechazar una cuenta conectada' },
  { methods: ['POST'], re: R('/v1/balance_settings'), what: 'cambiar el calendario o el destino de los payouts' },
  { methods: ['POST'], re: R('/v1/treasury/(outbound_payments|outbound_transfers)'), what: 'enviar dinero desde Treasury' },
  { methods: ['POST'], re: R(`/v1/treasury/financial_accounts/${SEG}/(close|features)`), what: 'cerrar o cambiar una cuenta de Treasury' },
  { methods: ['POST'], re: R(`/v1/issuing/cards(/${SEG})?`), what: 'crear o cambiar una tarjeta que gasta del saldo' },
  { methods: ['POST'], re: R(`/v1/issuing/authorizations/${SEG}/approve`), what: 'aprobar un gasto de tarjeta' },
  { methods: ['POST'], re: R('/v1/climate/orders'), what: 'comprar Stripe Climate con el saldo' },
  { methods: ['POST'], re: R('/v2/money_management/(outbound_payments|outbound_transfers|outbound_payment_quotes)'), what: 'enviar dinero fuera (v2)' },
  { methods: ['POST'], re: R(`/v2/money_management/outbound_setup_intents(/${SEG}(/cancel)?)?`), what: 'preparar un destino de pagos (v2)' },
  { methods: ['POST'], re: R(`/v2/money_management/payout_methods/${SEG}/(archive|disable|unarchive)`), what: 'cambiar un destino de payouts (v2)' },
  { methods: ['POST'], re: R(`/v2/money_management/financial_accounts(/${SEG}(/close)?)?`), what: 'crear, cambiar o cerrar una cuenta financiera (v2)' },
  { methods: ['POST', 'DELETE'], re: R('/v2/core/vault/.+'), what: 'cambiar cuentas bancarias de destino (v2)' },
  { methods: ['POST'], re: R(`/v2/core/accounts/${SEG}/close`), what: 'cerrar una cuenta (v2)' },
];

// Tier "access": things that give lasting access to data or money from outside (webhooks
// to any URL, public file links, login links, raw card data). They could also break the
// integrations already connected to Stripe. Allowed only with STRIPE_ALLOW_ACCESS_GRANTS=true.
const ACCESS = [
  { methods: ['POST', 'DELETE'], re: R(`/v1/webhook_endpoints(/${SEG})?`), what: 'crear, cambiar o borrar un webhook (podría romper integraciones conectadas o enviar datos fuera)' },
  { methods: ['POST', 'DELETE'], re: R('/v2/core/event_destinations(/.*)?'), what: 'crear, cambiar o borrar un destino de eventos' },
  { methods: ['GET', 'POST', 'DELETE'], re: R('/v2/iam/api_keys(/.*)?'), what: 'gestionar claves del API' },
  { methods: ['POST', 'DELETE'], re: R('/v1/apps/.+'), what: 'gestionar apps o sus secretos' },
  { methods: ['GET'], re: R('/v1/apps/secrets/find'), what: 'leer un secreto guardado' },
  { methods: ['POST'], re: R(`/v1/file_links(/${SEG})?`), what: 'crear un enlace público a un archivo' },
  { methods: ['POST'], re: R('/v1/forwarding/requests'), what: 'reenviar datos de tarjeta fuera de Stripe' },
  { methods: ['POST'], re: R('/v1/ephemeral_keys'), what: 'crear una clave temporal de cliente' },
  { methods: ['POST'], re: R('/v1/account_links'), what: 'crear un enlace de alta o cambio de datos de una cuenta' },
  { methods: ['POST'], re: R('/v2/core/account_links'), what: 'crear un enlace de alta o cambio de datos de una cuenta (v2)' },
  { methods: ['POST'], re: R(`/v1/accounts/${SEG}/login_links`), what: 'crear un enlace de acceso al panel de una cuenta' },
  { methods: ['POST'], re: R('/v1/account_sessions'), what: 'crear una sesión de componentes de cuenta' },
  { methods: ['POST'], re: R('/v2/core/batch_jobs(/.*)?'), what: 'lanzar operaciones masivas' },
  { methods: ['POST'], re: R(`/v2/extend/workflows/${SEG}/invoke`), what: 'lanzar un workflow de Stripe' },
];

// Connected-account create/update: blocked only when the body sets where payouts go.
const ACCOUNT_ROUTES = [R('/v1/accounts'), R(`/v1/accounts/${SEG}`), R('/v2/core/accounts'), R(`/v2/core/accounts/${SEG}`)];
const V1_ACCOUNT_KEYS = /^(external_account|bank_account|settings\[payouts\]|settings\[treasury\]|capabilities\[(transfers|treasury|card_issuing)\])/;
const V2_ACCOUNT_KEYS = /(^|\.)(payout_methods|default_outbound_destination|outbound_payments|outbound_transfers)(\.|$)/;

const INVALID_SEGMENT = /[/\\;\x00-\x1f\x7f]/;

/**
 * The path as Stripe routes it, or null when it is ambiguous or not an API path at all.
 * Only /v1/... and /v2/... exist on api.stripe.com.
 */
function stripePath(url) {
  const raw = String(url).split('?', 1)[0];
  if (raw.includes('#') || raw.includes('\\') || !raw.startsWith('/')) return null;
  const parts = raw.slice(1).split('/');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop(); // one trailing slash
  const decoded = [];
  for (const part of parts) {
    if (part === '') return null;
    let segment;
    try {
      segment = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (segment === '.' || segment === '..' || INVALID_SEGMENT.test(segment)) return null;
    decoded.push(segment.toLowerCase());
  }
  if (decoded[0] !== 'v1' && decoded[0] !== 'v2') return null;
  return `/${decoded.join('/')}`;
}

/** Flattened keys of a JSON value, dotted ("a.b.0.c"). */
function jsonKeys(value, prefix = '', out = []) {
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key;
      out.push(name);
      jsonKeys(inner, name, out);
    }
  }
  return out;
}

/**
 * The rule this request breaks, if any: { tier: 'money_out' | 'access', what }.
 * `fields` are the request's parameter names (form keys, or dotted JSON keys for v2), from
 * both the query string and the body.
 */
function blockedBy(method, path, fields, { allowMoneyOut, allowAccessGrants }) {
  if (!allowMoneyOut) {
    const rule = MONEY_OUT.find((r) => r.methods.includes(method) && r.re.test(path));
    if (rule) return { tier: 'money_out', what: rule.what };
    if (method === 'POST' && ACCOUNT_ROUTES.some((re) => re.test(path))) {
      const keys = path.startsWith('/v2/') ? V2_ACCOUNT_KEYS : V1_ACCOUNT_KEYS;
      if (fields.some((f) => keys.test(f))) return { tier: 'money_out', what: 'cambiar a dónde van los payouts de una cuenta conectada' };
    }
  }
  if (!allowAccessGrants) {
    const rule = ACCESS.find((r) => r.methods.includes(method) && r.re.test(path));
    if (rule) return { tier: 'access', what: rule.what };
  }
  return null;
}

/** Whether this route's body must be read to decide (connected-account create/update). */
const needsFields = (method, path) => method === 'POST' && ACCOUNT_ROUTES.some((re) => re.test(path));

/**
 * JSON -> Stripe form encoding, the way Stripe's own libraries send it:
 * {metadata: {a: 1}, items: [{price: "p"}], expand: ["x"]} ->
 * metadata[a]=1&items[0][price]=p&expand[0]=x. null unsets a field (empty string).
 */
function toForm(value) {
  const params = new URLSearchParams();
  const walk = (inner, name) => {
    if (inner === null || inner === undefined) params.append(name, '');
    else if (Array.isArray(inner)) {
      if (inner.length === 0) params.append(name, '');
      inner.forEach((item, i) => walk(item, `${name}[${i}]`));
    } else if (typeof inner === 'object') {
      const entries = Object.entries(inner);
      if (entries.length === 0) params.append(name, '');
      for (const [key, item] of entries) walk(item, `${name}[${key}]`);
    } else params.append(name, String(inner));
  };
  for (const [key, item] of Object.entries(value)) walk(item, key);
  return params.toString();
}

module.exports = { stripePath, blockedBy, needsFields, toForm, jsonKeys, MONEY_OUT, ACCESS };
