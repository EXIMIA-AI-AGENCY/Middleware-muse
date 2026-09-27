'use strict';

const http = require('node:http');
const https = require('node:https');
const { sendJson } = require('./http-util');
const { loggablePath } = require('./logger');
const { createTiming } = require('./metrics');

// RFC 9110 §7.6.1 connection-specific headers: never forwarded in either direction.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Request headers that are replaced by the proxy or must never reach GHL.
const DROP_REQUEST = new Set([
  'host', // set from the upstream URL
  'x-proxy-key', // the proxy's own secret
  'authorization', // replaced by the GHL token
  'user-agent', // replaced by a browser signature
  'x-admin-check', // marks the dashboard's own test calls; internal only
  'content-length', // re-added below when the client sent a fixed-length body
  'expect', // 100-continue is answered by this server, not relayed
  // Added by the hosting platform's edge, not by Muse. Relaying them to GHL's
  // Cloudflare edge leaks infrastructure details and can trip loop detection.
  'forwarded',
  'via',
  'x-real-ip',
  'true-client-ip',
  'cdn-loop',
  'x-matched-path', // Vercel routing metadata
]);
const DROP_REQUEST_PREFIXES = ['x-forwarded-', 'cf-', 'fly-', 'x-railway-', 'rndr-', 'x-render-', 'x-vercel-', 'x-middleware-'];

// Request methods that can be retried when a pooled keep-alive socket turns out to be dead.
const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Characters Node accepts in a status reason phrase (same rule as for header values).
const VALID_REASON = /^[\t\x20-\x7e\x80-\xff]*$/;

const upstreamError = (code, message) => Object.assign(new Error(message), { code });

function connectionTokens(headers) {
  const value = headers.connection;
  if (!value) return new Set();
  return new Set(String(value).toLowerCase().split(',').map((token) => token.trim()).filter(Boolean));
}

function isDroppedRequestHeader(name, connectionListed) {
  return (
    HOP_BY_HOP.has(name) ||
    DROP_REQUEST.has(name) ||
    connectionListed.has(name) ||
    DROP_REQUEST_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function wantsBoth(accept) {
  return /application\/json/i.test(accept) && /text\/event-stream/i.test(accept);
}

/**
 * Builds the upstream request headers: the client's headers minus hop-by-hop and
 * infrastructure headers, plus the injected GHL credentials.
 */
function buildUpstreamHeaders(req, config, kind) {
  const incoming = req.headers;
  const connectionListed = connectionTokens(incoming);
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (!isDroppedRequestHeader(name, connectionListed)) headers[name] = value;
  }

  // Body framing: keep a fixed length as-is, otherwise re-chunk the streamed body.
  if (incoming['content-length'] !== undefined) {
    headers['content-length'] = incoming['content-length'];
  } else if (incoming['transfer-encoding'] !== undefined) {
    headers['transfer-encoding'] = 'chunked';
  }

  headers.authorization = `Bearer ${config.ghlToken}`;
  headers['user-agent'] = config.userAgent;
  // Some GHL endpoint families need a different Version; the client may override it.
  if (!headers.version) headers.version = config.ghlVersion;

  if (kind === 'mcp') {
    // MCP streamable HTTP: the client must accept both JSON and SSE responses.
    if (!wantsBoth(headers.accept ?? '')) headers.accept = 'application/json, text/event-stream';
    // JSON-RPC bodies are always JSON (Python's urllib defaults to form-urlencoded).
    if (req.method === 'POST' && !/json/i.test(headers['content-type'] ?? '')) {
      headers['content-type'] = 'application/json';
    }
    if (!headers.locationid && config.ghlLocationId) headers.locationId = config.ghlLocationId;
  } else if (!headers.accept || headers.accept.trim() === '*/*') {
    headers.accept = 'application/json';
  }
  return headers;
}

/** Copies upstream response headers except hop-by-hop ones, keeping duplicates (e.g. Set-Cookie). */
function copyResponseHeaders(upstreamRes, res) {
  const connectionListed = connectionTokens(upstreamRes.headers);
  const raw = upstreamRes.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i];
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || connectionListed.has(lower)) continue;
    try {
      res.appendHeader(name, raw[i + 1]);
    } catch {
      // Skip a header Node refuses to emit rather than failing the whole response.
    }
  }
}

function createAgents() {
  // `timeout` here applies to idle pooled sockets; active requests use their own timeout.
  const options = { keepAlive: true, maxSockets: 64, maxFreeSockets: 16, timeout: 30_000, scheduling: 'lifo' };
  return { 'http:': new http.Agent(options), 'https:': new https.Agent(options) };
}

/**
 * Express middleware that forwards the request to `<upstreamBase><pathPrefix><req.url>`.
 * Mounted with app.use(mountPath, ...), so `req.url` has the mount path already removed
 * and still carries the raw, undecoded query string.
 */
function createForwarder(config, logger, { kind, pathPrefix }) {
  const upstream = config.upstreamBase;
  const transport = upstream.protocol === 'https:' ? https : http;
  const agent = createAgents()[upstream.protocol];
  const hostname = upstream.hostname.replace(/^\[|\]$/g, '');

  return function forward(req, res) {
    // Origin-form only ("/path?query"). The upstream host is fixed either way.
    if (!req.url.startsWith('/')) return sendJson(res, 400, { error: 'bad_request' });
    // TRACE echoes the request headers back, which would include the injected GHL token.
    if (req.method === 'TRACE') {
      return sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS' });
    }

    const path = `${pathPrefix}${req.url}`;
    const headers = buildUpstreamHeaders(req, config, kind);
    const hasBody =
      (headers['content-length'] !== undefined && headers['content-length'] !== '0') ||
      headers['transfer-encoding'] !== undefined;

    let upstreamReq = null;
    let gotResponse = false;
    let finished = false;
    const timing = createTiming(res.locals.startedAt);
    res.locals.timing = timing;

    // When the upstream exchange ends before the client finished uploading (early
    // response or error), discard the rest of the body so the client can read our answer.
    const drainRequest = () => {
      if (!req.complete) {
        req.unpipe();
        req.resume();
      }
    };

    const fail = (err) => {
      if (finished) return;
      finished = true;
      res.locals.upstreamError = true;
      drainRequest();
      const timedOut = err && err.code === 'UPSTREAM_TIMEOUT';
      logger.error({
        msg: timedOut ? 'upstream_timeout' : 'upstream_error',
        code: (err && err.code) || 'UNKNOWN',
        method: req.method,
        path: loggablePath(req.originalUrl),
      });
      if (!res.headersSent) {
        // Drop any upstream headers already copied (e.g. Content-Encoding) before answering ourselves.
        for (const name of res.getHeaderNames()) res.removeHeader(name);
        sendJson(res, timedOut ? 504 : 502, { error: timedOut ? 'upstream_timeout' : 'bad_gateway' });
      } else {
        res.destroy();
      }
    };

    const relay = (upstreamRes, outgoing) => {
      const { statusCode, statusMessage } = upstreamRes;
      if (!(statusCode >= 200 && statusCode <= 599)) {
        throw upstreamError('UPSTREAM_BAD_STATUS', 'invalid upstream status code');
      }
      copyResponseHeaders(upstreamRes, res);
      const isStream = /text\/event-stream/i.test(upstreamRes.headers['content-type'] ?? '');
      // Keep reverse proxies such as nginx from buffering SSE (MCP streamable HTTP).
      if (isStream) res.setHeader('X-Accel-Buffering', 'no');
      if (typeof statusMessage === 'string' && VALID_REASON.test(statusMessage)) {
        res.writeHead(statusCode, statusMessage);
      } else {
        res.writeHead(statusCode);
      }
      if (isStream) res.flushHeaders();
      timing.relayed();

      upstreamRes.on('error', (err) => fail(err));
      upstreamRes.on('end', () => {
        finished = true;
        // GHL answered before the upload finished (e.g. 401/413): the exchange is over,
        // so stop forwarding the body and discard the rest (RFC 9112 §9.3).
        if (!req.complete) {
          outgoing.destroy();
          drainRequest();
        }
      });
      upstreamRes.pipe(res);
    };

    const send = (attempt) => {
      const outgoing = transport.request({
        protocol: upstream.protocol,
        hostname,
        port: upstream.port || undefined,
        method: req.method,
        path,
        headers,
        agent,
        timeout: config.upstreamTimeoutMs,
      });
      upstreamReq = outgoing;
      timing.sent();

      outgoing.on('timeout', () => {
        outgoing.destroy(upstreamError('UPSTREAM_TIMEOUT', 'upstream timeout'));
      });

      outgoing.on('error', (err) => {
        if (upstreamReq !== outgoing) return;
        // A pooled keep-alive socket may have been closed by the peer; retry once on a fresh one.
        if (
          attempt === 0 &&
          outgoing.reusedSocket &&
          err.code === 'ECONNRESET' &&
          !hasBody &&
          RETRYABLE_METHODS.has(req.method) &&
          !res.headersSent &&
          !res.destroyed
        ) {
          send(1);
          return;
        }
        fail(err);
      });

      outgoing.on('response', (upstreamRes) => {
        if (upstreamReq !== outgoing) return;
        gotResponse = true;
        timing.upstreamHeaders();
        try {
          relay(upstreamRes, outgoing);
        } catch (err) {
          // A malformed upstream response must fail this request, not crash the process.
          upstreamRes.destroy();
          fail(err);
        }
      });

      // Covers the socket closing with neither a response nor an error (e.g. an unexpected 101).
      outgoing.on('close', () => {
        if (upstreamReq !== outgoing) return;
        if (!gotResponse) fail(upstreamError('UPSTREAM_CLOSED', 'upstream closed without a response'));
        drainRequest();
      });

      if (attempt === 0 && hasBody) {
        req.pipe(outgoing);
      } else {
        outgoing.end();
      }
    };

    // If the client goes away first, stop the upstream work too.
    res.once('close', () => {
      if (!res.writableFinished && upstreamReq && !upstreamReq.destroyed) {
        finished = true;
        upstreamReq.destroy();
      }
    });

    send(0);
  };
}

module.exports = { createForwarder, buildUpstreamHeaders };
