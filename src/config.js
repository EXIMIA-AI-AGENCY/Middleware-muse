'use strict';

const { version } = require('../package.json');

const DEFAULTS = Object.freeze({
  port: 8080,
  upstreamBase: 'https://services.leadconnectorhq.com',
  // Sub-account "Eximia". Only used as the default `locationId` header on MCP calls.
  ghlLocationId: 'L3bLLVwvhdJ7A9WqkPxM',
  ghlVersion: '2021-07-28',
  // GHL's Cloudflare edge rejects non-browser signatures (e.g. Python-urllib) with error 1010.
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  rateLimitMax: 120,
  rateLimitWindowMs: 10_000,
  upstreamTimeoutMs: 120_000,
});

const MIN_PROXY_KEY_LENGTH = 32;
// Visible ASCII only: anything else would be rejected when written into an HTTP header.
const HEADER_SAFE = /^[\x21-\x7e]+$/;
// Same, but inner spaces allowed (User-Agent values contain them).
const HEADER_SAFE_WITH_SPACES = /^[\x21-\x7e][\x20-\x7e]*$/;

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readSecret(env, name) {
  const value = (env[name] ?? '').trim();
  if (!value) throw new ConfigError(`Missing required environment variable ${name}`);
  // Never include the value itself in the message: it would end up in the logs.
  if (!HEADER_SAFE.test(value)) {
    throw new ConfigError(`${name} contains whitespace or non-printable characters`);
  }
  return value;
}

function readInt(env, name, fallback, { min, max }) {
  const raw = (env[name] ?? '').trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return value;
}

function readUpstreamBase(env) {
  const raw = (env.GHL_BASE_URL ?? '').trim() || DEFAULTS.upstreamBase;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('GHL_BASE_URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError('GHL_BASE_URL must use https:// (or http:// for local tests)');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new ConfigError('GHL_BASE_URL must be an origin only, e.g. https://services.leadconnectorhq.com');
  }
  return url;
}

function loadConfig(env = process.env) {
  const ghlToken = readSecret(env, 'GHL_TOKEN');
  const proxyKey = readSecret(env, 'PROXY_KEY');
  if (proxyKey.length < MIN_PROXY_KEY_LENGTH) {
    throw new ConfigError(
      `PROXY_KEY must be at least ${MIN_PROXY_KEY_LENGTH} characters (generate one with: openssl rand -hex 32)`,
    );
  }
  if (proxyKey === ghlToken) {
    throw new ConfigError('PROXY_KEY must be different from GHL_TOKEN');
  }

  const ghlLocationId = (env.GHL_LOCATION_ID ?? '').trim() || DEFAULTS.ghlLocationId;
  if (!HEADER_SAFE.test(ghlLocationId)) {
    throw new ConfigError('GHL_LOCATION_ID contains whitespace or non-printable characters');
  }

  const userAgent = (env.UPSTREAM_USER_AGENT ?? '').trim() || DEFAULTS.userAgent;
  if (!HEADER_SAFE_WITH_SPACES.test(userAgent)) {
    throw new ConfigError('UPSTREAM_USER_AGENT contains non-printable characters');
  }

  return Object.freeze({
    version,
    ghlToken,
    proxyKey,
    ghlLocationId,
    port: readInt(env, 'PORT', DEFAULTS.port, { min: 1, max: 65535 }),
    upstreamBase: readUpstreamBase(env),
    ghlVersion: DEFAULTS.ghlVersion,
    userAgent,
    rateLimitMax: readInt(env, 'RATE_LIMIT_MAX', DEFAULTS.rateLimitMax, { min: 1, max: 1_000_000 }),
    rateLimitWindowMs: readInt(env, 'RATE_LIMIT_WINDOW_MS', DEFAULTS.rateLimitWindowMs, {
      min: 100,
      max: 3_600_000,
    }),
    upstreamTimeoutMs: readInt(env, 'UPSTREAM_TIMEOUT_MS', DEFAULTS.upstreamTimeoutMs, {
      min: 100,
      max: 3_600_000,
    }),
  });
}

module.exports = { loadConfig, ConfigError, DEFAULTS, MIN_PROXY_KEY_LENGTH };
