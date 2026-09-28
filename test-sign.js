'use strict';

// Acceptance test: the proxy's Kraken signature must match Kraken's official example
// (docs.kraken.com → Spot REST Authentication) byte for byte. Run: node test-sign.js
// The key below is Kraken's published sample, not a real credential.
const { sign } = require('./src/kraken/sign');
const { encodeBody } = require('./src/kraken/client');

const EXAMPLE = {
  secret: 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==',
  nonce: '1616492376594',
  postData: 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25',
  uriPath: '/0/private/AddOrder',
  expected: '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==',
};

// 1. The signature of the official postdata.
const got = sign(EXAMPLE);
// 2. The body the proxy itself builds from {method, params} must be that same postdata.
const { body } = encodeBody({ ordertype: 'limit', pair: 'XBTUSD', price: '37500', type: 'buy', volume: '1.25' }, EXAMPLE.nonce);

if (got === EXAMPLE.expected && body === EXAMPLE.postData) {
  console.log('PASS');
} else {
  console.log('FAIL');
  if (got !== EXAMPLE.expected) console.log(`  signature expected: ${EXAMPLE.expected}\n  signature got:      ${got}`);
  if (body !== EXAMPLE.postData) console.log(`  postdata expected: ${EXAMPLE.postData}\n  postdata got:      ${body}`);
  process.exitCode = 1;
}
