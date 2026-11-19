'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseMcpBody } = require('../src/agency/mcp-tools');

const SSE = 'text/event-stream';

test('parseMcpBody: single SSE event', () => {
  const r = parseMcpBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n', SSE);
  assert.deepStrictEqual(r.result.tools, []);
});

test('parseMcpBody: JSON split across data lines', () => {
  const r = parseMcpBody('event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"tools":[{"name":"a"}]}}\n\n', SSE);
  assert.strictEqual(r.result.tools[0].name, 'a');
});

test('parseMcpBody: response followed by a notification event', () => {
  const body = 'data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\ndata: {"jsonrpc":"2.0","method":"notifications/x"}\n\n';
  assert.ok(Array.isArray(parseMcpBody(body, SSE).result.tools));
});

test('parseMcpBody: SSE body with JSON content type', () => {
  const r = parseMcpBody('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n', 'application/json');
  assert.ok(r.result);
});

test('parseMcpBody: plain JSON', () => {
  assert.strictEqual(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{}}', 'application/json').id, 1);
});
