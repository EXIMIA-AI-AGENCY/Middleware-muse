'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { TOKEN, KEY, startUpstream, request, authed, listen, close } = require('./helpers');
const { createApp } = require('../src/create-app');
const { loadConfig } = require('../src/config');
const { tryCreateOAuth, createOAuth } = require('../src/oauth');

const PASSWORD = 'dueno-de-eximia-correct-horse-battery';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

function silentLogger() {
  const lines = [];
  return {
    lines,
    info: (f) => lines.push({ level: 'info', ...f }),
    warn: (f) => lines.push({ level: 'warn', ...f }),
    error: (f) => lines.push({ level: 'error', ...f }),
  };
}

async function setup(t, { env = { MCP_OAUTH_PASSWORD: PASSWORD }, handler } = {}) {
  const upstream = await startUpstream(
    handler ||
      ((req, res, record) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: record.url }));
      }),
  );
  const logger = silentLogger();
  const config = loadConfig({ GHL_TOKEN: TOKEN, PROXY_KEY: KEY, GHL_BASE_URL: upstream.url });
  const oauth = tryCreateOAuth({ env, ghlConfig: config, logger });
  const app = createApp(config, logger, { oauth });
  const server = http.createServer(app);
  const url = await listen(server);
  t.after(async () => {
    app.locals.limiter.stop();
    await close(server);
    await upstream.close();
  });
  return { url, upstream, logger, oauth };
}

const form = (obj) => new URLSearchParams(obj).toString();
const json = (r) => JSON.parse(r.text);

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function register(url, body = { redirect_uris: [REDIRECT], client_name: 'Claude' }) {
  return request(`${url}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** Runs register -> consent -> token, returning the token response and the pieces. */
async function fullFlow(url, { registerBody, password = PASSWORD } = {}) {
  const reg = json(await register(url, registerBody));
  const { verifier, challenge } = pkce();
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-123', resource: `${url}/mcp/` };
  const consent = await request(`${url}/oauth/authorize?${form(params)}`);
  assert.equal(consent.status, 200);
  const answer = await request(`${url}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ ...params, password, decision: 'allow' }),
  });
  if (answer.status !== 302) return { reg, answer };
  const location = new URL(answer.headers.location);
  const code = location.searchParams.get('code');
  const tokenBody = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: `${url}/mcp/` };
  if (reg.client_secret) tokenBody.client_secret = reg.client_secret;
  const token = await request(`${url}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(tokenBody) });
  return { reg, answer, location, code, verifier, tokenBody, token };
}

test('without MCP_OAUTH_PASSWORD the module is off and /mcp/ behaves as before', async (t) => {
  const { url } = await setup(t, { env: {} });
  const meta = await request(`${url}/.well-known/oauth-protected-resource`);
  assert.equal(meta.status, 401);
  const mcp = await request(`${url}/mcp/`, { method: 'POST', body: '{}' });
  assert.equal(mcp.status, 401);
  assert.equal(mcp.headers['www-authenticate'], undefined);
  assert.deepEqual(json(mcp), { error: 'unauthorized' });
});

test('a bad MCP_OAUTH_PASSWORD only disables OAuth and is never logged', async (t) => {
  const { url, logger, oauth } = await setup(t, { env: { MCP_OAUTH_PASSWORD: 'short' } });
  assert.equal(oauth, null);
  assert.ok(logger.lines.some((l) => l.msg === 'mcp_oauth_disabled'));
  assert.ok(!JSON.stringify(logger.lines).includes('short"'));
  const ok = await request(`${url}/ghl/contacts/`, { headers: authed() });
  assert.equal(ok.status, 200);
  assert.throws(() => createOAuth({ env: { MCP_OAUTH_PASSWORD: KEY }, ghlConfig: loadConfig({ GHL_TOKEN: TOKEN, PROXY_KEY: KEY }), logger }));
});

test('metadata and the 401 challenge point clients to the authorization server', async (t) => {
  const { url } = await setup(t);
  const unauth = await request(`${url}/mcp/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);
  assert.deepEqual(json(unauth), { error: 'unauthorized' });
  assert.match(unauth.headers['www-authenticate'], new RegExp(`^Bearer resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"`));
  // REST stays key-only and does not advertise OAuth.
  const rest = await request(`${url}/ghl/contacts/`);
  assert.equal(rest.status, 401);
  assert.equal(rest.headers['www-authenticate'], undefined);

  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const pr = json(await request(`${url}${path}`));
    assert.equal(pr.resource, `${url}/mcp`);
    assert.deepEqual(pr.authorization_servers, [url]);
  }
  const as = json(await request(`${url}/.well-known/oauth-authorization-server`));
  assert.equal(as.issuer, url);
  assert.equal(as.token_endpoint, `${url}/oauth/token`);
  assert.equal(as.registration_endpoint, `${url}/oauth/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
});

test('full flow: register, consent, token, MCP call with Bearer, refresh', async (t) => {
  const { url, upstream } = await setup(t);
  const flow = await fullFlow(url);
  assert.equal(flow.answer.status, 302);
  assert.equal(flow.location.origin + flow.location.pathname, REDIRECT);
  assert.equal(flow.location.searchParams.get('state'), 'st-123');
  assert.equal(flow.location.searchParams.get('iss'), url);
  assert.equal(flow.token.status, 200);
  const tokens = json(flow.token);
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal(flow.token.headers['cache-control'], 'no-store');

  const call = await request(`${url}/mcp/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(call.status, 200);
  const seen = upstream.requests.at(-1);
  assert.equal(seen.url, '/mcp/');
  // GHL gets its own token, never the OAuth one.
  assert.equal(seen.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!JSON.stringify(seen.headers).includes(tokens.access_token));

  // The code works once.
  const again = await request(`${url}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(flow.tokenBody) });
  assert.equal(again.status, 400);
  assert.equal(json(again).error, 'invalid_grant');

  const refreshed = await request(`${url}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: flow.reg.client_id }),
  });
  assert.equal(refreshed.status, 200);
  const next = json(refreshed);
  const call2 = await request(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${next.access_token}` }, body: '{}' });
  assert.equal(call2.status, 200);
  // A refresh token is not an access token.
  const wrongType = await request(`${url}/mcp/`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.refresh_token}` }, body: '{}' });
  assert.equal(wrongType.status, 401);
});

test('client_secret_basic clients must authenticate at the token endpoint', async (t) => {
  const { url } = await setup(t);
  const flow = await fullFlow(url, { registerBody: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' } });
  assert.ok(flow.reg.client_secret);
  assert.equal(flow.token.status, 200);
  const flow2 = await fullFlow(url, { registerBody: { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' } });
  assert.equal(flow2.token.status, 200);
  const refresh = json(flow2.token).refresh_token;
  const bad = { grant_type: 'refresh_token', refresh_token: refresh, client_id: flow2.reg.client_id, client_secret: 'nope' };
  const r = await request(`${url}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(bad) });
  assert.equal(r.status, 401);
  const noSecret = await request(`${url}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: refresh, client_id: flow2.reg.client_id }) });
  assert.equal(noSecret.status, 401);
  const basic = Buffer.from(`${encodeURIComponent(flow2.reg.client_id)}:${encodeURIComponent(flow2.reg.client_secret)}`).toString('base64');
  const ok = await request(`${url}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` }, body: form({ grant_type: 'refresh_token', refresh_token: refresh }) });
  assert.equal(ok.status, 200);
});

test('wrong password, wrong verifier, foreign redirect and forged ids are refused', async (t) => {
  const { url } = await setup(t);
  const wrong = await fullFlow(url, { password: 'not-the-password-at-all' });
  assert.equal(wrong.answer.status, 401);
  assert.match(wrong.answer.text, /Contraseña incorrecta/);

  const flow = await fullFlow(url);
  // (a fresh code, with another verifier)
  const flowB = await fullFlow(url);
  void flow;
  const bad = await request(`${url}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ ...flowB.tokenBody, code: flowB.code, code_verifier: pkce().verifier }),
  });
  assert.equal(bad.status, 400);

  const evil = await register(url, { redirect_uris: ['https://evil.example/cb'] });
  assert.equal(evil.status, 400);
  const local = await register(url, { redirect_uris: ['http://localhost:33418/callback'] });
  assert.equal(local.status, 201);

  const forged = await request(`${url}/oauth/authorize?${form({ response_type: 'code', client_id: 'eyJ4IjoxfQ.AAAA', redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`);
  assert.equal(forged.status, 400);
  assert.equal(forged.headers.location, undefined);

  // A registered client cannot be sent to a redirect it did not register.
  const reg = json(await register(url));
  const other = await request(`${url}/oauth/authorize?${form({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/somewhere-else', code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`);
  assert.equal(other.status, 400);
  // Plain PKCE is refused (redirected with an error, since the redirect is valid).
  const plain = await request(`${url}/oauth/authorize?${form({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'plain' })}`);
  assert.equal(plain.status, 302);
  assert.equal(new URL(plain.headers.location).searchParams.get('error'), 'invalid_request');

  const deny = await request(`${url}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', decision: 'deny' }),
  });
  assert.equal(deny.status, 302);
  assert.equal(new URL(deny.headers.location).searchParams.get('error'), 'access_denied');

  const invalid = await request(`${url}/mcp/`, { method: 'POST', headers: { Authorization: 'Bearer garbage.token' }, body: '{}' });
  assert.equal(invalid.status, 401);
  assert.match(invalid.headers['www-authenticate'], /error="invalid_token"/);
});

test('an OAuth token opens /mcp/ only, never REST or path tricks', async (t) => {
  const { url, upstream } = await setup(t);
  const { token } = await fullFlow(url);
  const access = json(token).access_token;
  const before = upstream.requests.length;
  for (const path of ['/ghl/contacts/', '/mcp/../contacts/', '/mcp/%2e%2e/contacts/', '/MCP/../ghl/x']) {
    const r = await request(`${url}${path}`, { headers: { Authorization: `Bearer ${access}` }, path });
    assert.equal(r.status, 401, path);
  }
  assert.equal(upstream.requests.length, before);
});

test('X-Proxy-Key keeps working on /ghl and /mcp/ with OAuth on', async (t) => {
  const { url, upstream } = await setup(t);
  const rest = await request(`${url}/ghl/contacts/?locationId=L3bLLVwvhdJ7A9WqkPxM&limit=1`, { headers: authed() });
  assert.equal(rest.status, 200);
  const mcp = await request(`${url}/mcp/`, { method: 'POST', headers: authed({ 'Content-Type': 'application/json' }), body: '{}' });
  assert.equal(mcp.status, 200);
  assert.equal(upstream.requests.at(-1).headers.authorization, `Bearer ${TOKEN}`);
  const wrongKey = await request(`${url}/mcp/`, { method: 'POST', headers: { 'X-Proxy-Key': 'x'.repeat(40) }, body: '{}' });
  assert.equal(wrongKey.status, 401);
});

test('changing the owner password revokes every token', async (t) => {
  const { url } = await setup(t);
  const access = json((await fullFlow(url)).token).access_token;
  const { url: url2 } = await setup(t, { env: { MCP_OAUTH_PASSWORD: `${PASSWORD}-rotated` } });
  // Same audience check would fail anyway across ports, so verify the signature directly.
  const config = loadConfig({ GHL_TOKEN: TOKEN, PROXY_KEY: KEY });
  const rotated = createOAuth({ env: { MCP_OAUTH_PASSWORD: `${PASSWORD}-rotated` }, ghlConfig: config, logger: silentLogger() });
  const fakeReq = { headers: { authorization: `Bearer ${access}`, host: new URL(url).host }, socket: {} };
  assert.equal(rotated.checkBearer(fakeReq), 'invalid');
  const same = createOAuth({ env: { MCP_OAUTH_PASSWORD: PASSWORD }, ghlConfig: config, logger: silentLogger() });
  assert.equal(same.checkBearer(fakeReq), 'valid');
  void url2;
});

test('too many wrong passwords are throttled', async (t) => {
  const { url } = await setup(t);
  const reg = json(await register(url));
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256', decision: 'allow' };
  let last;
  for (let i = 0; i < 11; i++) {
    last = await request(`${url}/oauth/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ ...params, password: `wrong-${i}-xxxxxxxxxxxx` }) });
  }
  assert.match(last.text, /Demasiados intentos/);
  const right = await request(`${url}/oauth/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ ...params, password: PASSWORD }) });
  assert.equal(right.status, 401);
});
