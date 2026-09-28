'use strict';

const crypto = require('node:crypto');

const MIN_ACCESS_KEY_LENGTH = 32;
const HEADER_SAFE = /^[\x21-\x7e]+$/;
const HOSTNAME = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// Secret (sk_) or restricted (rk_) key, live or test mode.
const STRIPE_KEY = /^(sk|rk)_(live|test)_[A-Za-z0-9_]{10,}$/;
const API_VERSION = /^\d{4}-\d{2}-\d{2}(\.[a-z]+)?$/;
const DEFAULT_BASE = 'https://api.stripe.com';

/**
 * Muse's key for the Stripe API, derived from the Stripe key (one-way: knowing it reveals
 * nothing about the Stripe key). Rolling the Stripe key rolls it; STRIPE_PROXY_KEY overrides
 * it for independent rotation.
 */
function deriveAccessKey(secretKey) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secretKey, 'utf8'), Buffer.from('stripe', 'utf8'), 'muse-proxy stripe access key v1', 32)).toString('hex');
}

/** Marker for the panel's own test calls (skip the rate limit, not Muse's activity). */
function panelCheckMarker(secretKey) {
  return crypto.createHmac('sha256', secretKey).update('muse-proxy stripe panel check v1').digest('hex');
}

/** Why a value is not a usable Stripe secret key, in words the owner can act on. */
function keyProblem(key) {
  if (!HEADER_SAFE.test(key)) return 'STRIPE_SECRET_KEY tiene espacios o caracteres no válidos. Cópiala de nuevo.';
  if (/^pk_/.test(key)) return 'STRIPE_SECRET_KEY es la clave PUBLICABLE (pk_…). Hace falta la secreta (sk_…) o una restringida (rk_…).';
  if (/^whsec_/.test(key)) return 'STRIPE_SECRET_KEY es un secreto de webhook (whsec_…). Hace falta la clave secreta (sk_…) o una restringida (rk_…).';
  if (/^pit-/.test(key)) return 'STRIPE_SECRET_KEY es un token de GoHighLevel (pit-…), no de Stripe. Hace falta la clave de Stripe (sk_… o rk_…).';
  if (!STRIPE_KEY.test(key)) return 'STRIPE_SECRET_KEY no parece una clave de Stripe (debe empezar por sk_live_, rk_live_, sk_test_ o rk_test_).';
  return null;
}

function readBase(env, problems) {
  const raw = (env.STRIPE_BASE_URL ?? '').trim() || DEFAULT_BASE;
  let url;
  try {
    url = new URL(raw);
  } catch {
    problems.push('STRIPE_BASE_URL no es una URL válida.');
    return new URL(DEFAULT_BASE);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    problems.push('STRIPE_BASE_URL debe ser solo un origen, p. ej. https://api.stripe.com');
    return new URL(DEFAULT_BASE);
  }
  return url;
}

/**
 * Reads the Stripe settings. Never throws: a missing or broken setting only disables the
 * Stripe API (with the reason shown in the panel) and never affects GHL or Kraken.
 * Messages name variables, never their values.
 */
function loadStripeConfig(env = process.env, { ghl, others = [] } = {}) {
  const problems = [];
  const secretKey = (env.STRIPE_SECRET_KEY ?? '').trim();
  const explicitKey = (env.STRIPE_PROXY_KEY ?? '').trim();

  if (!secretKey) problems.push('Falta STRIPE_SECRET_KEY (la clave secreta o restringida de Stripe).');
  else {
    const problem = keyProblem(secretKey);
    if (problem) problems.push(problem);
  }

  const taken = [ghl && ghl.proxyKey, ghl && ghl.ghlToken, ghl && ghl.adminPin, secretKey, ...others].filter(Boolean);
  let accessKey = null;
  let accessKeySource = null;
  if (explicitKey) {
    if (!HEADER_SAFE.test(explicitKey)) problems.push('STRIPE_PROXY_KEY tiene espacios o caracteres no válidos.');
    else if (explicitKey.length < MIN_ACCESS_KEY_LENGTH) problems.push(`STRIPE_PROXY_KEY debe tener al menos ${MIN_ACCESS_KEY_LENGTH} caracteres.`);
    else if (taken.includes(explicitKey)) problems.push('STRIPE_PROXY_KEY debe ser distinta de las demás llaves, tokens y del PIN.');
    else {
      accessKey = explicitKey;
      accessKeySource = 'env';
    }
  } else if (secretKey && !keyProblem(secretKey)) {
    accessKey = deriveAccessKey(secretKey);
    accessKeySource = 'derived';
    if (taken.includes(accessKey)) problems.push('La llave derivada coincide con otra llave: pon STRIPE_PROXY_KEY.');
  }

  let publicHost = (env.STRIPE_PUBLIC_HOST ?? '').trim().toLowerCase() || null;
  if (publicHost && !HOSTNAME.test(publicHost)) {
    problems.push('STRIPE_PUBLIC_HOST debe ser solo un nombre de dominio, p. ej. stripe-proxy-muse.vercel.app');
    publicHost = null;
  }
  let apiVersion = (env.STRIPE_API_VERSION ?? '').trim() || null;
  if (apiVersion && !API_VERSION.test(apiVersion)) {
    problems.push('STRIPE_API_VERSION no parece una versión de Stripe (p. ej. 2025-09-30.clover).');
    apiVersion = null;
  }
  const baseUrl = readBase(env, problems);

  const enabled = problems.length === 0 && Boolean(secretKey && accessKey);
  const match = enabled ? /^(sk|rk)_(live|test)_/.exec(secretKey) : null;
  return Object.freeze({
    enabled,
    started: Boolean(secretKey || explicitKey),
    problems: Object.freeze(problems),
    secretKey: enabled ? secretKey : null,
    // 'live' | 'test', and 'secret' (full access) | 'restricted' (only what the key allows).
    mode: match ? match[2] : null,
    keyKind: match ? (match[1] === 'rk' ? 'restricted' : 'secret') : null,
    accessKey: enabled ? accessKey : null,
    accessKeySource: enabled ? accessKeySource : null,
    checkMarker: enabled ? panelCheckMarker(secretKey) : null,
    publicHost,
    apiVersion,
    baseUrl,
    // Payouts, transfers and payout-destination changes cannot be undone: off unless the
    // owner turns them on explicitly.
    allowMoneyOut: (env.STRIPE_ALLOW_MONEY_OUT ?? '').trim() === 'true',
    // Webhooks, public file links, login links, card-data forwarding: lasting access from
    // outside, and they could break what is already connected to Stripe. Off unless turned on.
    allowAccessGrants: (env.STRIPE_ALLOW_ACCESS_GRANTS ?? '').trim() === 'true',
  });
}

module.exports = { loadStripeConfig, deriveAccessKey, keyProblem, MIN_ACCESS_KEY_LENGTH };
