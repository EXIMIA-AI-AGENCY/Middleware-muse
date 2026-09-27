'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, ConfigError } = require('../src/config');
const { TOKEN, KEY } = require('./helpers');

const base = { GHL_TOKEN: TOKEN, PROXY_KEY: KEY };

test('requires GHL_TOKEN and PROXY_KEY', () => {
  assert.throws(() => loadConfig({ PROXY_KEY: KEY }), { name: 'ConfigError', message: /GHL_TOKEN/ });
  assert.throws(() => loadConfig({ GHL_TOKEN: TOKEN }), { name: 'ConfigError', message: /PROXY_KEY/ });
  assert.throws(() => loadConfig({ GHL_TOKEN: '   ', PROXY_KEY: KEY }), /GHL_TOKEN/);
  assert.throws(() => loadConfig({}), ConfigError);
});

test('error messages never contain the secret values', () => {
  const badToken = 'pit-with space-secret';
  const shortKey = 'short-secret-key';
  for (const env of [{ GHL_TOKEN: badToken, PROXY_KEY: KEY }, { GHL_TOKEN: TOKEN, PROXY_KEY: shortKey }]) {
    assert.throws(() => loadConfig(env), (err) => {
      assert.ok(!err.message.includes('secret'), err.message);
      assert.ok(!err.message.includes(TOKEN) && !err.message.includes(KEY));
      return true;
    });
  }
});

test('rejects weak or reused proxy keys', () => {
  assert.throws(() => loadConfig({ GHL_TOKEN: TOKEN, PROXY_KEY: 'x'.repeat(31) }), /at least 32/);
  assert.throws(() => loadConfig({ GHL_TOKEN: KEY, PROXY_KEY: KEY }), /different/);
});

test('trims pasted whitespace and rejects inner control characters', () => {
  const config = loadConfig({ GHL_TOKEN: `  ${TOKEN}\n`, PROXY_KEY: `${KEY}\r\n` });
  assert.equal(config.ghlToken, TOKEN);
  assert.equal(config.proxyKey, KEY);
  assert.throws(() => loadConfig({ GHL_TOKEN: 'pit-abc\ndef', PROXY_KEY: KEY }), /non-printable/);
});

test('defaults', () => {
  const config = loadConfig(base);
  assert.equal(config.port, 8080);
  assert.equal(config.version, '1.0.0');
  assert.equal(config.upstreamBase.origin, 'https://services.leadconnectorhq.com');
  assert.equal(config.ghlVersion, '2021-07-28');
  assert.equal(config.ghlLocationId, 'L3bLLVwvhdJ7A9WqkPxM');
  assert.equal(config.rateLimitMax, 120);
  assert.equal(config.rateLimitWindowMs, 10_000);
  assert.match(config.userAgent, /^Mozilla\/5\.0 .*Chrome\//);
  assert.ok(Object.isFrozen(config));
});

test('PORT and numeric settings are validated', () => {
  assert.equal(loadConfig({ ...base, PORT: '3000' }).port, 3000);
  assert.throws(() => loadConfig({ ...base, PORT: 'abc' }), /PORT/);
  assert.throws(() => loadConfig({ ...base, PORT: '70000' }), /PORT/);
  assert.throws(() => loadConfig({ ...base, RATE_LIMIT_MAX: '0' }), /RATE_LIMIT_MAX/);
});

test('UPSTREAM_USER_AGENT can replace the default browser signature', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
  assert.equal(loadConfig({ ...base, UPSTREAM_USER_AGENT: ` ${ua}\n` }).userAgent, ua);
  assert.throws(() => loadConfig({ ...base, UPSTREAM_USER_AGENT: 'Mozilla/5.0\u0000x' }), /UPSTREAM_USER_AGENT/);
});

test('GHL_BASE_URL must be a bare http(s) origin', () => {
  assert.equal(loadConfig({ ...base, GHL_BASE_URL: 'http://127.0.0.1:9999' }).upstreamBase.port, '9999');
  assert.throws(() => loadConfig({ ...base, GHL_BASE_URL: 'ftp://x' }), /https/);
  assert.throws(() => loadConfig({ ...base, GHL_BASE_URL: 'https://x/api' }), /origin only/);
  assert.throws(() => loadConfig({ ...base, GHL_BASE_URL: 'not a url' }), /valid URL/);
});
