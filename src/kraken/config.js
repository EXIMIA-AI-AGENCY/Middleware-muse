'use strict';

const crypto = require('node:crypto');

const DEFAULTS = Object.freeze({
  baseUrl: 'https://api.kraken.com',
  timeoutMs: 20_000,
  // Per client IP, as the Kraken prompt asks. Kraken's own limits are stricter still.
  rateLimitMax: 60,
  rateLimitWindowMs: 60_000,
});

const MIN_ACCESS_KEY_LENGTH = 32;
const HEADER_SAFE = /^[\x21-\x7e]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HOSTNAME = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * The one key Muse uses for Kraken, derived from the two Kraken keys ("the two become one").
 * HKDF is one-way: knowing this key reveals nothing about KRAKEN_API_SECRET. Rotating the
 * Kraken API key rotates it too; KRAKEN_PROXY_KEY overrides it for independent rotation.
 */
function deriveAccessKey(apiKey, secret) {
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from(apiKey, 'utf8'), 'muse-proxy kraken access key v1', 32)).toString('hex');
}

function readBaseUrl(raw, problems) {
  const value = (raw ?? '').trim() || DEFAULTS.baseUrl;
  let url;
  try {
    url = new URL(value);
  } catch {
    problems.push('KRAKEN_BASE_URL no es una URL válida.');
    return new URL(DEFAULTS.baseUrl);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    problems.push('KRAKEN_BASE_URL debe ser solo un origen, p. ej. https://api.kraken.com');
    return new URL(DEFAULTS.baseUrl);
  }
  return url;
}

/**
 * Reads the Kraken settings. Unlike the GHL config it never throws: a missing or broken
 * Kraken setting only disables /api/kraken (with the reason shown in the panel) and must
 * never stop the GoHighLevel proxy. Messages name variables, never their values.
 */
function loadKrakenConfig(env = process.env, { ghl } = {}) {
  const problems = [];
  const apiKey = (env.KRAKEN_API_KEY ?? '').trim();
  const secretText = (env.KRAKEN_API_SECRET ?? '').trim();
  const explicitKey = (env.KRAKEN_PROXY_KEY ?? '').trim();
  const baseUrl = readBaseUrl(env.KRAKEN_BASE_URL, problems);

  if (!apiKey) problems.push('Falta KRAKEN_API_KEY (la API key pública de Kraken).');
  else if (!HEADER_SAFE.test(apiKey)) problems.push('KRAKEN_API_KEY tiene espacios o caracteres no válidos. Cópiala de nuevo.');

  let secret = null;
  if (!secretText) {
    problems.push('Falta KRAKEN_API_SECRET (la private key de Kraken).');
  } else if (!BASE64.test(secretText)) {
    problems.push('KRAKEN_API_SECRET no es base64 válido. Cópiala entera, tal como la muestra Kraken.');
  } else {
    secret = Buffer.from(secretText, 'base64');
    if (secret.length < 32) {
      problems.push('KRAKEN_API_SECRET es demasiado corta: ¿copiaste la private key completa?');
      secret = null;
    }
  }
  if (apiKey && secretText && apiKey === secretText) problems.push('KRAKEN_API_KEY y KRAKEN_API_SECRET son iguales: revisa que no pegaste la misma dos veces.');

  const others = [ghl && ghl.proxyKey, ghl && ghl.ghlToken, ghl && ghl.adminPin, apiKey, secretText].filter(Boolean);
  let accessKey = null;
  let accessKeySource = null;
  if (explicitKey) {
    if (!HEADER_SAFE.test(explicitKey)) problems.push('KRAKEN_PROXY_KEY tiene espacios o caracteres no válidos.');
    else if (explicitKey.length < MIN_ACCESS_KEY_LENGTH) problems.push(`KRAKEN_PROXY_KEY debe tener al menos ${MIN_ACCESS_KEY_LENGTH} caracteres.`);
    else if (others.includes(explicitKey)) problems.push('KRAKEN_PROXY_KEY debe ser distinta de PROXY_KEY, del token de GHL, del PIN y de las claves de Kraken.');
    else {
      accessKey = explicitKey;
      accessKeySource = 'env';
    }
  } else if (apiKey && secret && HEADER_SAFE.test(apiKey)) {
    accessKey = deriveAccessKey(apiKey, secret);
    accessKeySource = 'derived';
  }

  let publicHost = (env.KRAKEN_PUBLIC_HOST ?? '').trim().toLowerCase() || null;
  if (publicHost && !HOSTNAME.test(publicHost)) {
    problems.push('KRAKEN_PUBLIC_HOST debe ser solo un nombre de dominio, p. ej. kraken-proxy-muse.vercel.app');
    publicHost = null;
  }

  const enabled = problems.length === 0 && Boolean(apiKey && secret && accessKey);
  return Object.freeze({
    enabled,
    // Anything present counts as "started": the panel then shows fixes instead of the setup guide.
    started: Boolean(apiKey || secretText || explicitKey),
    problems: Object.freeze(problems),
    apiKey: enabled ? apiKey : null,
    secret: enabled ? secret : null,
    accessKey: enabled ? accessKey : null,
    accessKeySource: enabled ? accessKeySource : null,
    // Exactly "true", as specified: "1", "TRUE" or " true" leave trading off.
    trading: env.ENABLE_TRADING === 'true',
    baseUrl,
    publicHost,
    // Vercel overwrites X-Forwarded-For with the real client IP, so it is only trusted there.
    trustForwardedFor: env.VERCEL === '1',
    timeoutMs: DEFAULTS.timeoutMs,
    rateLimitMax: DEFAULTS.rateLimitMax,
    rateLimitWindowMs: DEFAULTS.rateLimitWindowMs,
  });
}

module.exports = { loadKrakenConfig, deriveAccessKey, DEFAULTS, MIN_ACCESS_KEY_LENGTH };
