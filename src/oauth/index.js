'use strict';

/**
 * OAuth 2.1 for /mcp/, so the proxy can be added as a custom connector in Claude (which
 * cannot send X-Proxy-Key). The owner authorizes a connector with MCP_OAUTH_PASSWORD or, when
 * that is not set, the dashboard ADMIN_PIN. Optional and isolated, like Kraken: with neither,
 * or with a bad password, this module is off and /mcp/ keeps accepting only X-Proxy-Key.
 *
 * Stateless on purpose (Vercel functions keep nothing between calls): client ids, codes and
 * tokens are signed with a key derived from PROXY_KEY and MCP_OAUTH_PASSWORD. Changing either
 * one revokes every client and token at once.
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server       RFC 8414
 *   POST /oauth/register                               RFC 7591 (dynamic client registration)
 *   GET  /oauth/authorize                              consent page (owner password)
 *   POST /oauth/authorize                              owner answer -> code (PKCE S256 only)
 *   POST /oauth/token                                  authorization_code / refresh_token
 *
 * A token only opens /mcp/. REST (/ghl) still needs X-Proxy-Key.
 */

const crypto = require('node:crypto');
const express = require('express');
const { canonicalPath } = require('../canonical-path');
const { sendJson } = require('../http-util');
const { createRateLimiter } = require('../rate-limit');

const MIN_PASSWORD_LENGTH = 16;
const CODE_TTL_S = 300;
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const SCOPE = 'mcp';
// Claude's connector callbacks, plus loopback for local clients (Claude Code, MCP Inspector).
const DEFAULT_REDIRECT_ORIGINS = ['https://claude.ai', 'https://claude.com'];
const PRINTABLE = /^[\x20-\x7e]+$/;

class OAuthConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OAuthConfigError';
  }
}

function loadOAuthConfig(env, ghlConfig) {
  const own = (env.MCP_OAUTH_PASSWORD ?? '').trim();
  // Without its own password, the dashboard PIN (already validated by loadConfig) authorizes
  // connectors, so the owner can connect Claude without setting up anything new.
  if (!own) {
    if (!ghlConfig.adminPin) return { enabled: false };
    return { ...finish(env, ghlConfig, ghlConfig.adminPin), source: 'admin_pin' };
  }
  const password = own;
  // Messages name the variable, never its value.
  if (!PRINTABLE.test(password)) throw new OAuthConfigError('MCP_OAUTH_PASSWORD contains non-printable characters');
  if (password.length < MIN_PASSWORD_LENGTH || password.length > 256) {
    throw new OAuthConfigError(`MCP_OAUTH_PASSWORD must be between ${MIN_PASSWORD_LENGTH} and 256 characters`);
  }
  if ([ghlConfig.proxyKey, ghlConfig.ghlToken].includes(password)) {
    throw new OAuthConfigError('MCP_OAUTH_PASSWORD must be different from PROXY_KEY and GHL_TOKEN');
  }
  return { ...finish(env, ghlConfig, password), source: 'mcp_oauth_password' };
}

function finish(env, ghlConfig, password) {
  const extra = (env.MCP_OAUTH_REDIRECT_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((value) => {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new OAuthConfigError('MCP_OAUTH_REDIRECT_ORIGINS has an invalid URL');
      }
      if (url.protocol !== 'https:') throw new OAuthConfigError('MCP_OAUTH_REDIRECT_ORIGINS must be https:// origins');
      return url.origin;
    });
  const signingKey = crypto.createHmac('sha256', ghlConfig.proxyKey).update(`ghl-proxy mcp-oauth v1\0${password}`).digest();
  return { enabled: true, password, signingKey, redirectOrigins: [...DEFAULT_REDIRECT_ORIGINS, ...extra] };
}

// --- signed blobs -------------------------------------------------------------------------

const b64 = (buf) => Buffer.from(buf).toString('base64url');

function createSigner(key) {
  const mac = (typ, body) => crypto.createHmac('sha256', key).update(`${typ}.${body}`).digest();
  return {
    sign(typ, payload) {
      const body = b64(JSON.stringify({ ...payload, typ }));
      return `${body}.${b64(mac(typ, body))}`;
    },
    /** Returns the payload, or null if forged, of another type, or expired. */
    verify(typ, token, now = Date.now()) {
      if (typeof token !== 'string' || token.length > 4096) return null;
      const dot = token.indexOf('.');
      if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
      const body = token.slice(0, dot);
      const given = Buffer.from(token.slice(dot + 1), 'base64url');
      const expected = mac(typ, body);
      if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
      let payload;
      try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (!payload || payload.typ !== typ) return null;
      if (typeof payload.exp === 'number' && payload.exp * 1000 <= now) return null;
      return payload;
    },
    secretFor(clientId) {
      return b64(mac('client_secret', clientId));
    },
  };
}

const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

// --- helpers ------------------------------------------------------------------------------

function originOf(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const proto = forwarded === 'https' || forwarded === 'http' ? forwarded : req.socket.encrypted ? 'https' : 'http';
  return `${proto}://${req.headers.host}`;
}

const resourceOf = (origin) => `${origin}/mcp`;
const sameResource = (given, resource) => given === resource || given === `${resource}/`;

function clientIp(req) {
  const value = req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] ?? '').split(',')[0];
  return String(value || req.socket.remoteAddress || 'unknown').trim();
}

function isLoopback(url) {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function allowedRedirect(value, origins) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  return isLoopback(url) || origins.includes(url.origin);
}

/** Loopback redirects may use any port (RFC 8252 §7.3). */
function redirectMatches(given, registered) {
  if (registered.includes(given)) return true;
  let url;
  try {
    url = new URL(given);
  } catch {
    return false;
  }
  if (!isLoopback(url)) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return isLoopback(reg) && reg.hostname === url.hostname && reg.pathname === url.pathname && reg.search === url.search;
    } catch {
      return false;
    }
  });
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function oauthError(res, status, error, description, headers = {}) {
  const body = { error };
  if (description) body.error_description = description;
  return sendJson(res, status, body, { Pragma: 'no-cache', ...headers });
}

function sendHtml(res, status, html, formTarget) {
  const formAction = ["'self'", formTarget].filter(Boolean).join(' ');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}

const PAGE_STYLE = `body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;background:#fff;color:#111}
main{max-width:420px;margin:48px auto;padding:0 20px}h1{font-size:20px;margin:0 0 16px}p{line-height:1.5;color:#333}
.box{border:1px solid #ddd;border-radius:8px;padding:12px 14px;margin:16px 0;font-size:14px;color:#222}
label{display:block;font-size:14px;margin:16px 0 6px}input[type=password]{width:100%;box-sizing:border-box;padding:10px;border:1px solid #bbb;border-radius:6px;font-size:16px}
.row{display:flex;gap:10px;margin-top:18px}button{flex:1;padding:11px;border-radius:6px;font-size:15px;cursor:pointer;border:1px solid #111}
.go{background:#111;color:#fff}.no{background:#fff;color:#111}.err{color:#b00020;font-size:14px}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}p,.box{color:#ccc}.box{border-color:#333}input[type=password]{background:#1b1b1b;color:#eee;border-color:#444}.go{background:#eee;color:#111;border-color:#eee}.no{background:#111;color:#eee;border-color:#eee}}`;

function page(title, inner) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head><body><main>${inner}</main></body></html>`;
}

function errorPage(res, message) {
  sendHtml(res, 400, page('No se puede autorizar', `<h1>No se puede autorizar</h1><p>${escapeHtml(message)}</p>`));
}

// --- module -------------------------------------------------------------------------------

function createOAuth({ env = process.env, ghlConfig, logger, now = () => Date.now() } = {}) {
  const config = loadOAuthConfig(env, ghlConfig);
  if (!config.enabled) return null;
  const signer = createSigner(config.signingKey);
  const seconds = () => Math.floor(now() / 1000);
  // Wrong passwords: per address, and overall (a long random password is the real defence).
  const perIp = createRateLimiter({ max: 10, windowMs: 15 * 60_000, now });
  const overall = createRateLimiter({ max: 50, windowMs: 15 * 60_000, now });
  const registrations = createRateLimiter({ max: 30, windowMs: 60 * 60_000, now });
  // Best effort single use for codes (per instance; PKCE is what really binds a code).
  const usedCodes = new Map();
  const markUsed = (jti, exp) => {
    const t = seconds();
    for (const [k, e] of usedCodes) if (e <= t) usedCodes.delete(k);
    if (usedCodes.has(jti)) return false;
    usedCodes.set(jti, exp);
    return true;
  };

  const router = express.Router({ caseSensitive: false, strict: false });
  const form = express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 50 });
  const json = express.json({ limit: '16kb' });

  const protectedResource = (req, res) => {
    const origin = originOf(req);
    sendJson(res, 200, {
      resource: resourceOf(origin),
      authorization_servers: [origin],
      bearer_methods_supported: ['header'],
      scopes_supported: [SCOPE],
      resource_name: 'GoHighLevel (subcuenta Eximia) via ghl-proxy',
    });
  };
  router.get('/.well-known/oauth-protected-resource', protectedResource);
  router.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

  const serverMetadata = (req, res) => {
    const origin = originOf(req);
    sendJson(res, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
    });
  };
  router.get('/.well-known/oauth-authorization-server', serverMetadata);
  router.get('/.well-known/oauth-authorization-server/mcp', serverMetadata);
  router.get('/.well-known/openid-configuration', serverMetadata);

  // Dynamic client registration. The client id itself carries the (signed) registration.
  router.post('/oauth/register', json, (req, res) => {
    if (!registrations.hit(clientIp(req)).allowed) return oauthError(res, 429, 'too_many_requests');
    const meta = req.body && typeof req.body === 'object' ? req.body : {};
    const uris = meta.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every((u) => typeof u === 'string' && u.length <= 512)) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris is required');
    }
    if (!uris.every((u) => allowedRedirect(u, config.redirectOrigins))) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uri not allowed by this server');
    }
    const name = typeof meta.client_name === 'string' ? meta.client_name.slice(0, 80) : 'Cliente MCP';
    const wanted = meta.token_endpoint_auth_method;
    const method = wanted === 'client_secret_post' || wanted === 'client_secret_basic' ? wanted : 'none';
    const issuedAt = seconds();
    const clientId = signer.sign('client', { ru: uris, n: name, m: method, iat: issuedAt });
    const answer = {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      client_name: name,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      scope: SCOPE,
    };
    if (method !== 'none') {
      answer.client_secret = signer.secretFor(clientId);
      answer.client_secret_expires_at = 0;
    }
    logger.info({ msg: 'oauth_client_registered', method });
    return sendJson(res, 201, answer, { Pragma: 'no-cache' });
  });

  /** Checks the authorization request. Returns { error } (shown, never redirected) or the parsed request. */
  function readAuthorizeRequest(q, origin) {
    const client = signer.verify('client', q.client_id);
    if (!client) return { error: 'Este cliente no está registrado aquí. Vuelve a añadir el conector.' };
    const redirectUri = typeof q.redirect_uri === 'string' ? q.redirect_uri : client.ru.length === 1 ? client.ru[0] : '';
    if (!redirectUri || !redirectMatches(redirectUri, client.ru) || !allowedRedirect(redirectUri, config.redirectOrigins)) {
      return { error: 'La dirección de regreso no coincide con la del cliente registrado.' };
    }
    const resource = resourceOf(origin);
    const base = { client, clientId: q.client_id, redirectUri, state: typeof q.state === 'string' ? q.state.slice(0, 1024) : undefined, resource };
    if (q.response_type !== 'code') return { ...base, redirectError: 'unsupported_response_type' };
    if (typeof q.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge) || q.code_challenge_method !== 'S256') {
      return { ...base, redirectError: 'invalid_request', redirectDescription: 'PKCE with S256 is required' };
    }
    if (q.resource !== undefined && !sameResource(q.resource, resource)) {
      return { ...base, redirectError: 'invalid_target' };
    }
    return { ...base, codeChallenge: q.code_challenge };
  }

  function redirectWith(res, redirectUri, params, origin) {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries({ ...params, iss: origin })) if (v !== undefined) url.searchParams.set(k, v);
    res.writeHead(302, { Location: url.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  }

  function consentPage(res, ar, problem) {
    const host = new URL(ar.redirectUri).host;
    const hidden = { client_id: ar.clientId, redirect_uri: ar.redirectUri, state: ar.state, code_challenge: ar.codeChallenge, code_challenge_method: 'S256', response_type: 'code', resource: ar.resource };
    const fields = Object.entries(hidden)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
      .join('');
    const inner = `<h1>Autorizar acceso a GoHighLevel</h1>
<p><b>${escapeHtml(ar.client.n)}</b> quiere usar las herramientas MCP de GoHighLevel (subcuenta Eximia) a través de este proxy.</p>
<div class="box">Al autorizar, regresas a <b>${escapeHtml(host)}</b>. El acceso es solo al MCP, no al REST, y dura hasta que cambies ${config.source === 'admin_pin' ? 'el PIN del panel' : 'la contraseña del dueño'}.</div>
<form method="post" action="/oauth/authorize">${fields}
<label for="pw">${config.source === 'admin_pin' ? 'PIN del panel /admin' : 'Contraseña del dueño'}</label><input id="pw" name="password" type="password" autocomplete="current-password" autofocus>
${problem ? `<p class="err">${escapeHtml(problem)}</p>` : ''}
<div class="row"><button class="no" name="decision" value="deny" type="submit">Cancelar</button><button class="go" name="decision" value="allow" type="submit">Autorizar</button></div></form>`;
    sendHtml(res, problem ? 401 : 200, page('Autorizar acceso', inner), new URL(ar.redirectUri).origin);
  }

  router.get('/oauth/authorize', (req, res) => {
    const origin = originOf(req);
    const ar = readAuthorizeRequest(req.query, origin);
    if (ar.error) return errorPage(res, ar.error);
    if (ar.redirectError) return redirectWith(res, ar.redirectUri, { error: ar.redirectError, error_description: ar.redirectDescription, state: ar.state }, origin);
    return consentPage(res, ar);
  });

  router.post('/oauth/authorize', form, (req, res) => {
    const origin = originOf(req);
    const body = req.body || {};
    const ar = readAuthorizeRequest(body, origin);
    if (ar.error) return errorPage(res, ar.error);
    if (ar.redirectError) return redirectWith(res, ar.redirectUri, { error: ar.redirectError, error_description: ar.redirectDescription, state: ar.state }, origin);
    if (body.decision !== 'allow') return redirectWith(res, ar.redirectUri, { error: 'access_denied', state: ar.state }, origin);

    const ip = clientIp(req);
    const ipGate = perIp.hit(`ip:${ip}`);
    const allGate = overall.hit('all');
    if (!ipGate.allowed || !allGate.allowed) {
      logger.warn({ msg: 'oauth_consent_throttled' });
      return consentPage(res, ar, 'Demasiados intentos. Espera 15 minutos y vuelve a intentar.');
    }
    if (typeof body.password !== 'string' || !safeEqual(body.password, config.password)) {
      logger.warn({ msg: 'oauth_consent_rejected' });
      return consentPage(res, ar, 'Contraseña incorrecta.');
    }
    const exp = seconds() + CODE_TTL_S;
    const code = signer.sign('code', {
      cid: ar.clientId,
      ru: ar.redirectUri,
      cc: ar.codeChallenge,
      aud: ar.resource,
      exp,
      jti: b64(crypto.randomBytes(12)),
    });
    logger.info({ msg: 'oauth_consent_granted' });
    return redirectWith(res, ar.redirectUri, { code, state: ar.state }, origin);
  });

  /** Client authentication at the token endpoint. Returns the client id or null. */
  function authenticateClient(req, body) {
    let id = body.client_id;
    let secret = body.client_secret;
    const header = req.headers.authorization;
    if (typeof header === 'string' && /^basic /i.test(header)) {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep < 0) return null;
      id = decodeURIComponent(decoded.slice(0, sep));
      secret = decodeURIComponent(decoded.slice(sep + 1));
    }
    const client = signer.verify('client', id);
    if (!client) return null;
    if (client.m !== 'none') {
      if (typeof secret !== 'string' || !safeEqual(secret, signer.secretFor(id))) return null;
    }
    return id;
  }

  function issueTokens(res, clientId, aud) {
    const t = seconds();
    const accessToken = signer.sign('access', { cid: clientId, aud, exp: t + ACCESS_TTL_S });
    const refreshToken = signer.sign('refresh', { cid: clientId, aud, exp: t + REFRESH_TTL_S, jti: b64(crypto.randomBytes(9)) });
    return sendJson(
      res,
      200,
      { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refreshToken, scope: SCOPE },
      { Pragma: 'no-cache' },
    );
  }

  router.post('/oauth/token', form, json, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const clientId = authenticateClient(req, body);
    if (!clientId) return oauthError(res, 401, 'invalid_client', undefined, { 'WWW-Authenticate': 'Basic realm="ghl-proxy"' });
    const resource = resourceOf(originOf(req));
    if (body.resource !== undefined && !sameResource(body.resource, resource)) return oauthError(res, 400, 'invalid_target');

    if (body.grant_type === 'authorization_code') {
      const code = signer.verify('code', body.code, now());
      if (!code || code.cid !== clientId || code.aud !== resource) return oauthError(res, 400, 'invalid_grant');
      if (body.redirect_uri !== undefined && body.redirect_uri !== code.ru) return oauthError(res, 400, 'invalid_grant');
      if (typeof body.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier)) {
        return oauthError(res, 400, 'invalid_grant', 'code_verifier is required');
      }
      const challenge = crypto.createHash('sha256').update(body.code_verifier).digest('base64url');
      if (!safeEqual(challenge, code.cc)) return oauthError(res, 400, 'invalid_grant');
      if (!markUsed(code.jti, code.exp)) return oauthError(res, 400, 'invalid_grant');
      logger.info({ msg: 'oauth_token_issued', grant: 'authorization_code' });
      return issueTokens(res, clientId, resource);
    }
    if (body.grant_type === 'refresh_token') {
      const refresh = signer.verify('refresh', body.refresh_token, now());
      if (!refresh || refresh.cid !== clientId || refresh.aud !== resource) return oauthError(res, 400, 'invalid_grant');
      return issueTokens(res, clientId, resource);
    }
    return oauthError(res, 400, 'unsupported_grant_type');
  });

  /** For /mcp/: returns 'valid', 'invalid' or 'absent' for the request's Bearer token. */
  function checkBearer(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !/^bearer /i.test(header)) return 'absent';
    const token = signer.verify('access', header.slice(7).trim(), now());
    if (!token || token.aud !== resourceOf(originOf(req))) return 'invalid';
    return 'valid';
  }

  function challenge(req, error) {
    const origin = originOf(req);
    const parts = [`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`, `scope="${SCOPE}"`];
    if (error) parts.unshift(`error="${error}"`);
    return `Bearer ${parts.join(', ')}`;
  }

  return { config: { enabled: true, source: config.source }, router, checkBearer, challenge };
}

/** True when the request goes to the MCP forwarder (and nowhere else once paths are resolved). */
function isMcpRequest(req) {
  const raw = String(req.path || '').toLowerCase();
  if (raw !== '/mcp' && !raw.startsWith('/mcp/')) return false;
  const canon = canonicalPath(req.url);
  return canon === '/mcp' || (canon !== null && canon.startsWith('/mcp/'));
}

/** For the entrypoints: never throws, so an OAuth problem can never take the proxy down. */
function tryCreateOAuth(options) {
  try {
    const oauth = createOAuth(options);
    options.logger.info({ msg: 'mcp_oauth', enabled: Boolean(oauth), source: oauth ? oauth.config.source : undefined });
    return oauth;
  } catch (err) {
    options.logger.error({ msg: 'mcp_oauth_disabled', name: err && err.name, reason: err instanceof OAuthConfigError ? err.message : undefined });
    return null;
  }
}

module.exports = { createOAuth, tryCreateOAuth, isMcpRequest, loadOAuthConfig, OAuthConfigError, MIN_PASSWORD_LENGTH };
