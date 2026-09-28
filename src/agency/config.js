'use strict';

const crypto = require('node:crypto');

const MIN_ACCESS_KEY_LENGTH = 32;
const HEADER_SAFE = /^[\x21-\x7e]+$/;
const HOSTNAME = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const ID = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Muse's key for the agency API, derived from the agency token (one-way: knowing it reveals
 * nothing about the token). Rotating the agency token rotates it; GHL_AGENCY_PROXY_KEY
 * overrides it for independent rotation.
 */
function deriveAccessKey(token) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.from('ghl-agency', 'utf8'), 'muse-proxy ghl agency access key v1', 32)).toString('hex');
}

/** Marker for the panel's own test calls (skip the rate limit, not Muse's activity). */
function panelCheckMarker(token) {
  return crypto.createHmac('sha256', token).update('muse-proxy ghl agency panel check v1').digest('hex');
}

/**
 * Reads the agency settings. Never throws: a missing or broken setting only disables the
 * agency API (with the reason shown in the panel) and never affects the Eximia sub-account
 * proxy or Kraken. Messages name variables, never their values.
 */
function loadAgencyConfig(env = process.env, { ghl, others = [] } = {}) {
  const problems = [];
  const token = (env.GHL_AGENCY_TOKEN ?? '').trim();
  const explicitKey = (env.GHL_AGENCY_PROXY_KEY ?? '').trim();

  if (!token) problems.push('Falta GHL_AGENCY_TOKEN (el token de la Private Integration de la agencia).');
  else if (!HEADER_SAFE.test(token)) problems.push('GHL_AGENCY_TOKEN tiene espacios o caracteres no válidos. Cópialo de nuevo.');
  else if (ghl && token === ghl.ghlToken) problems.push('GHL_AGENCY_TOKEN es el mismo token que GHL_TOKEN (el de Eximia): pon el token de la agencia.');

  const taken = [ghl && ghl.proxyKey, ghl && ghl.ghlToken, ghl && ghl.adminPin, token, ...others].filter(Boolean);
  let accessKey = null;
  let accessKeySource = null;
  if (explicitKey) {
    if (!HEADER_SAFE.test(explicitKey)) problems.push('GHL_AGENCY_PROXY_KEY tiene espacios o caracteres no válidos.');
    else if (explicitKey.length < MIN_ACCESS_KEY_LENGTH) problems.push(`GHL_AGENCY_PROXY_KEY debe tener al menos ${MIN_ACCESS_KEY_LENGTH} caracteres.`);
    else if (taken.includes(explicitKey)) problems.push('GHL_AGENCY_PROXY_KEY debe ser distinta de las demás llaves, tokens y del PIN.');
    else {
      accessKey = explicitKey;
      accessKeySource = 'env';
    }
  } else if (token && HEADER_SAFE.test(token)) {
    accessKey = deriveAccessKey(token);
    accessKeySource = 'derived';
    if (taken.includes(accessKey)) problems.push('La llave derivada coincide con otra llave: pon GHL_AGENCY_PROXY_KEY.');
  }

  let publicHost = (env.GHL_AGENCY_PUBLIC_HOST ?? '').trim().toLowerCase() || null;
  if (publicHost && !HOSTNAME.test(publicHost)) {
    problems.push('GHL_AGENCY_PUBLIC_HOST debe ser solo un nombre de dominio, p. ej. ghl-agency-muse.vercel.app');
    publicHost = null;
  }
  let companyId = (env.GHL_COMPANY_ID ?? '').trim() || null;
  if (companyId && !ID.test(companyId)) {
    problems.push('GHL_COMPANY_ID no parece un ID de agencia válido.');
    companyId = null;
  }

  const enabled = problems.length === 0 && Boolean(token && accessKey);
  return Object.freeze({
    enabled,
    started: Boolean(token || explicitKey),
    problems: Object.freeze(problems),
    token: enabled ? token : null,
    accessKey: enabled ? accessKey : null,
    accessKeySource: enabled ? accessKeySource : null,
    checkMarker: enabled ? panelCheckMarker(token) : null,
    publicHost,
    companyId,
  });
}

module.exports = { loadAgencyConfig, deriveAccessKey, MIN_ACCESS_KEY_LENGTH };
