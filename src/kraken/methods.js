'use strict';

/**
 * Which Kraken private methods Muse may call. Default-deny: only the exact names below are
 * ever signed. Method names are case-sensitive at Kraken and are matched exactly here; the
 * URL path is always built from these constants, never from the caller's text.
 */

// Read-only, always available.
const READ_ONLY = Object.freeze([
  'Balance',
  'TradeBalance',
  'OpenOrders',
  'ClosedOrders',
  'QueryOrders',
  'TradesHistory',
  'QueryTrades',
  'OpenPositions',
  'Ledgers',
  'QueryLedgers',
  'TradeVolume',
  'DepositMethods',
  'DepositAddresses',
  'DepositStatus',
  'WithdrawStatus',
  'WithdrawInfo',
  'GetWebSocketsToken',
]);

// Only when ENABLE_TRADING is exactly "true".
const TRADING = Object.freeze([
  'AddOrder',
  'AmendOrder',
  'CancelOrder',
  'CancelAll',
  'CancelAllOrdersAfter',
  'AddOrderBatch',
  'CancelOrderBatch',
]);

// Never exposed under any configuration: they move money out of the spot wallet, even with a
// key that only has "Query Funds" (WalletTransfer). Listed so the answer says so plainly.
const NEVER = Object.freeze([
  'Withdraw',
  'WithdrawCancel',
  'WalletTransfer',
  'AccountTransfer',
  'CreateSubaccount',
  'Earn/Allocate',
  'Earn/Deallocate',
]);

const READ_ONLY_SET = new Set(READ_ONLY);
const TRADING_SET = new Set(TRADING);
const NEVER_SET = new Set(NEVER);

/**
 * Returns { ok: true, method } with the canonical name, or { ok: false, status, error }.
 * `method` is the caller's value, already known to be a string.
 */
function checkMethod(method, { trading }) {
  // Any other withdrawal/transfer-looking name is refused as "never" too, whatever its case.
  if (NEVER_SET.has(method) || (/withdraw|transfer|allocate/i.test(method) && !READ_ONLY_SET.has(method))) {
    return { ok: false, status: 403, error: `EProxy:Method ${printable(method)} is never allowed through this proxy` };
  }
  if (READ_ONLY_SET.has(method)) return { ok: true, method, readOnly: true };
  if (TRADING_SET.has(method)) {
    if (trading) return { ok: true, method, readOnly: false };
    return { ok: false, status: 403, error: `EProxy:Trading is disabled (method ${method}); set ENABLE_TRADING=true on the server to allow it` };
  }
  return { ok: false, status: 403, error: `EProxy:Method ${printable(method)} is not in the allowlist` };
}

/** Echo of the caller's method name, safe to put in an error message. */
function printable(method) {
  return method.replace(/[^A-Za-z0-9/_-]/g, '?').slice(0, 40);
}

function allowedMethods({ trading }) {
  return trading ? [...READ_ONLY, ...TRADING] : [...READ_ONLY];
}

module.exports = { READ_ONLY, TRADING, NEVER, checkMethod, allowedMethods };
