'use strict';

const crypto = require('node:crypto');

/**
 * Kraken Spot REST private-endpoint signature (API-Sign):
 *   base64( HMAC-SHA512( base64decode(secret), uriPath + SHA256(nonce + postData) ) )
 * `postData` is the exact request body that is sent (form-urlencoded, nonce first).
 */
function sign({ secret, uriPath, nonce, postData }) {
  const digest = crypto.createHash('sha256').update(String(nonce) + postData, 'utf8').digest();
  const key = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, 'base64');
  return crypto.createHmac('sha512', key).update(Buffer.concat([Buffer.from(uriPath, 'utf8'), digest])).digest('base64');
}

/**
 * Strictly increasing nonce in milliseconds: never repeats and never goes back within
 * this process, even if several requests land in the same millisecond or the clock
 * steps backwards. (Across serverless instances see README: Kraken's "nonce window".)
 */
function createNonceSource(now = () => Date.now()) {
  let last = 0;
  return () => {
    const candidate = Math.max(now(), last + 1);
    last = candidate;
    return String(candidate);
  };
}

/**
 * Signs Kraken's published documentation example and compares it with the published
 * signature (the same check as test-sign.js). The example key is Kraken's public sample,
 * not a credential. Used by the panel to show that signing is correct on the live server.
 */
function selfTest() {
  const expected = '4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==';
  const actual = sign({
    secret: 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==',
    uriPath: '/0/private/AddOrder',
    nonce: '1616492376594',
    postData: 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25',
  });
  return actual === expected;
}

module.exports = { sign, createNonceSource, selfTest };
