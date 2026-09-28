'use strict';

const crypto = require('node:crypto');
const { plainNumber } = require('./client');

// Booleans whose default is TRUE: "false" must be sent to turn them off. Every other Kraken
// boolean defaults to false, so a false value is simply left out (see below).
const DEFAULT_TRUE = new Set(['consolidate_taker']);
// Decimal amounts inside AddOrderBatch orders: Kraken's spec types them as strings.
const DECIMAL_FIELDS = new Set(['volume', 'displayvol', 'price', 'price2']);
const EXPONENT = /^(\d+\.?\d*|\.\d+)[eE][+-]?\d+$/;
const LEADING_DOT = /^\.\d+$/;
const LONG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_UUID = /^[0-9a-f]{32}$/i;
const FREE_TEXT = /^[\x20-\x7e]{1,18}$/;
const INT32 = { min: -2147483648, max: 2147483647 };
const TRUE_WORDS = new Set([true, 1, 'true', '1', 'yes']);
const FALSE_WORDS = new Set([false, 0, 'false', '0', 'no', '']);

/** Plain decimal text for a number or a numeric string ("1e-7" -> "0.0000001", ".5" -> "0.5"). */
function decimalText(value) {
  if (typeof value === 'number') return plainNumber(value);
  if (typeof value === 'string' && EXPONENT.test(value)) return plainNumber(Number(value));
  if (typeof value === 'string' && LEADING_DOT.test(value)) return `0${value}`;
  return value;
}

function validClOrdId(value) {
  return typeof value === 'string' && (LONG_UUID.test(value) || SHORT_UUID.test(value) || FREE_TEXT.test(value));
}

function validUserref(value) {
  const n = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  // 0 is what Kraken reports for orders WITHOUT a userref, so it cannot identify one.
  return Number.isInteger(n) && n !== 0 && n >= INT32.min && n <= INT32.max;
}

/**
 * Makes sure an order can be found later: keeps Muse's cl_ord_id or userref (checking the
 * format Kraken accepts), otherwise adds a new UUID cl_ord_id. Returns an error text or null.
 */
function tagOrder(order, changes, label) {
  const hasId = order.cl_ord_id !== undefined;
  const hasRef = order.userref !== undefined;
  if (hasId && hasRef) return `EProxy:${label}cl_ord_id and userref cannot be used together (Kraken allows only one)`;
  if (hasId) {
    if (!validClOrdId(order.cl_ord_id)) return `EProxy:${label}cl_ord_id must be a UUID (36 characters with dashes, or 32 hex) or plain text of up to 18 characters`;
    return null;
  }
  if (hasRef) {
    if (!validUserref(order.userref)) return `EProxy:${label}userref must be a whole number other than 0, between -2147483648 and 2147483647`;
    return null;
  }
  order.cl_ord_id = crypto.randomUUID();
  changes.push(`${label}cl_ord_id ${order.cl_ord_id} añadido por el proxy para poder comprobar la orden si algo falla`);
  return null;
}

/**
 * How to find an order again: its cl_ord_id, or else its userref. A userref is not unique at
 * Kraken, so for those the order's side, type, volume and price are kept to tell it apart.
 */
function orderTarget(order) {
  if (order.cl_ord_id !== undefined) return { ref: { cl_ord_id: String(order.cl_ord_id) } };
  return {
    ref: { userref: Number(order.userref) },
    match: { type: order.type, ordertype: order.ordertype, volume: order.volume, price: order.price },
  };
}

/**
 * Normalizes Muse's params before signing, so Kraken reads them exactly as intended, and
 * lists every change in plain Spanish (`changes`) for Muse:
 *  - false booleans are left out: Kraken treats ANY value of `validate` as "validate only", so
 *    validate=false would silently not place the order; all others default to false anyway;
 *  - numbers go out as plain decimals ("0.0000001", never "1e-7"; ".5" becomes "0.5");
 *  - AddOrder / each AddOrderBatch order gets a cl_ord_id when Muse gave neither cl_ord_id nor
 *    userref, so the proxy can tell whether it was placed if the answer is lost.
 * Returns { params, changes, ids } (ids: one { ref: {cl_ord_id} | {userref}, match? } per order) or
 * { error } (a 400 message).
 */
function normalizeParams(method, input) {
  const changes = [];
  const params = {};
  for (const [key, value] of Object.entries(input)) {
    // Kraken treats ANY value of validate as "validate only": only a clear yes is sent.
    if (key === 'validate') {
      const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
      if (TRUE_WORDS.has(v)) params.validate = 'true';
      else if (FALSE_WORDS.has(v)) changes.push(`validate=${JSON.stringify(value)} no se envió: Kraken trata cualquier valor de validate como «solo validar» y la orden no se habría creado`);
      else return { error: 'EProxy:validate must be true (only validate, the order is NOT created) or left out' };
      continue;
    }
    if (typeof value === 'boolean') {
      if (value) params[key] = 'true';
      else if (DEFAULT_TRUE.has(key)) params[key] = 'false';
      else changes.push(`${key}=false no se envió (ya es el valor por defecto de Kraken)`);
      continue;
    }
    if (key === 'orders' && Array.isArray(value)) {
      params[key] = value;
      continue;
    }
    const text = decimalText(value);
    if (typeof value === 'string' && text !== value) changes.push(`${key}: "${value}" enviado como "${text}"`);
    params[key] = text;
  }

  const ids = [];
  if (method === 'AddOrder') {
    const error = tagOrder(params, changes, '');
    if (error) return { error };
    ids.push(orderTarget(params));
  }

  if (method === 'AddOrderBatch') {
    const orders = params.orders;
    if (!Array.isArray(orders) || orders.length < 2 || orders.length > 15) return { error: 'EProxy:AddOrderBatch needs orders: a list of 2 to 15 orders (use AddOrder for a single one)' };
    if (typeof params.pair !== 'string') return { error: 'EProxy:AddOrderBatch needs pair (all orders of a batch are for the same pair)' };
    const out = [];
    for (const [i, raw] of orders.entries()) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: `EProxy:orders[${i}] must be an object` };
      const order = {};
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === 'boolean') {
          if (value) order[key] = true;
          else changes.push(`orders[${i}].${key}=false no se envió (ya es el valor por defecto de Kraken)`);
          continue;
        }
        if (DECIMAL_FIELDS.has(key) && (typeof value === 'number' || typeof value === 'string')) {
          const text = typeof value === 'number' ? plainNumber(value) : decimalText(value);
          if (typeof value === 'string' && text !== value) changes.push(`orders[${i}].${key}: "${value}" enviado como "${text}"`);
          order[key] = text;
          continue;
        }
        if (key === 'userref' && typeof value === 'string' && /^-?\d+$/.test(value)) {
          order[key] = Number(value);
          continue;
        }
        order[key] = value;
      }
      const error = tagOrder(order, changes, `orders[${i}].`);
      if (error) return { error };
      ids.push(orderTarget(order));
      out.push(order);
    }
    // Each order must be findable on its own.
    const refs = ids.map((t) => JSON.stringify(t.ref));
    if (new Set(refs).size !== refs.length) return { error: 'EProxy:each order of a batch needs its own cl_ord_id or userref (two orders share one)' };
    params.orders = out;
    // JSON body: top-level booleans must be real booleans there.
    if (params.validate === 'true') params.validate = true;
  }

  return { params, changes, ids };
}

module.exports = { normalizeParams, decimalText, validClOrdId };
