'use strict';

const { lookupError, errorsOf, throttledWaitSeconds } = require('./errors');

/**
 * Runs one allowlisted Kraken call and works out exactly what happened, for Muse.
 *
 * Reads that succeed are returned byte for byte. Every failure, and every trading call,
 * gets a `proxy` object next to Kraken's own `error`/`result`:
 *   ok, method, summary (Spanish: what happened), executed ('yes' | 'no' | 'partial' |
 *   'unknown', trading only), where ('kraken' | 'network' | 'proxy'), krakenError, detail,
 *   retry {automaticRetries, safeToRetry, afterSeconds}, next (Spanish: what to do), changes,
 *   attempts, order/orders, verification, pair, krakenStatus, traceId.
 *
 * When an order's answer is lost or ambiguous, the proxy never resends it: it looks the order
 * up by its cl_ord_id (or userref) in OpenOrders and ClosedOrders and reports what it found.
 */

const CREATE = new Set(['AddOrder', 'AddOrderBatch', 'AmendOrder']);
const CANCEL = new Set(['CancelOrder', 'CancelAll', 'CancelOrderBatch', 'CancelAllOrdersAfter']);
const HISTORY = new Set(['Ledgers', 'TradesHistory', 'ClosedOrders']);
const NEVER_RECEIVED = new Set([521, 523, 525, 526]);
const TXID = /^[A-Z0-9]{6}-[A-Z0-9]{5}-[A-Z0-9]{6}$/;
// Errors where the pair's rules (minimums, decimals, trading mode) explain the rejection.
const PAIR_ERRORS = new Set([
  'EOrder:Order minimum not met',
  'EOrder:Cost minimum not met',
  'EOrder:Tick size check failed',
  'EOrder:Invalid price',
  'EGeneral:Invalid arguments:volume',
  'EGeneral:Invalid arguments:price',
  'EService:Market in cancel_only mode',
  'EService:Market in post_only mode',
  'EService:Market in limit_only mode',
  'EService:Market in',
]);
const VERIFY_DELAYS_MS = [2000, 3000];
const FOLLOW_UP_BUDGET_MS = 6000;
const STATUS_TEXT = {
  online: 'online (normal)',
  maintenance: 'en mantenimiento (no admite órdenes ni cancelaciones)',
  cancel_only: 'en modo «solo cancelar» (no admite órdenes nuevas)',
  post_only: 'en modo «solo post-only»',
  limit_only: 'en modo «solo órdenes limit»',
  reduce_only: 'en modo «solo reducir posiciones»',
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const okJson = (r) => Boolean(r && r.json && errorsOf(r.json).length === 0 && r.status >= 200 && r.status < 300);
const normId = (s) => String(s).toLowerCase().replace(/-/g, '');
const entries = (obj) => (obj && typeof obj === 'object' ? Object.entries(obj) : []);
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);

function policyFor(method, readOnly) {
  if (readOnly) return 'read';
  if (CREATE.has(method)) return 'create';
  if (CANCEL.has(method)) return 'cancel';
  return 'read'; // GetWebSocketsToken: repeatable
}

function compactOrder(txid, o) {
  return {
    txid,
    status: o.status ?? null,
    cl_ord_id: o.cl_ord_id ?? null,
    userref: o.userref ?? null,
    order: (o.descr && o.descr.order) || null,
    vol: o.vol ?? null,
    vol_exec: o.vol_exec ?? null,
    price: o.price ?? null,
    reason: o.reason ?? null,
  };
}

function orderText(o) {
  const done = `ejecutado ${o.vol_exec ?? '0'} de ${o.vol ?? '?'}`;
  switch (o.status) {
    case 'pending': return 'entrando al libro (pending)';
    case 'open': return `abierta (${done})`;
    case 'closed': return `ejecutada (${done}${o.price && Number(o.price) ? `, precio medio ${o.price}` : ''})`;
    case 'canceled': return `cancelada${o.reason ? ` (${o.reason})` : ''}; ${done}`;
    case 'expired': return `caducada; ${done}`;
    default: return `en estado ${o.status}`;
  }
}

function refText(ref) {
  if (!ref) return '';
  return ref.cl_ord_id !== undefined ? `cl_ord_id ${ref.cl_ord_id}` : `userref ${ref.userref}`;
}

function transportText(res) {
  if (res.error === 'timeout') return res.notSent ? 'No se pudo conectar con Kraken a tiempo: la petición no llegó a salir del proxy.' : 'Kraken no respondió a tiempo.';
  if (res.error === 'network') return res.notSent ? 'No se pudo conectar con Kraken: la petición no llegó a salir del proxy.' : 'Se cortó la conexión con Kraken después de enviar la petición, sin respuesta.';
  if (res.error === 'busy') return 'Hay demasiadas llamadas a Kraken esperando turno en el proxy. No se envió esta.';
  if (res.error === 'locked') return `Kraken bloqueó temporalmente la API key por errores repetidos; el proxy pausa las llamadas hasta las ${hhmm(res.lockedUntil)} UTC para no alargar el bloqueo. No se envió esta.`;
  if (res.error === 'too_large') return 'La respuesta de Kraken era demasiado grande para procesarla.';
  return `Kraken (o Cloudflare, delante de Kraken) respondió HTTP ${res.status} sin datos válidos.`;
}

function pairText(pair) {
  if (!pair) return '';
  const name = pair.altname || pair.name;
  const parts = [];
  if (pair.status && pair.status !== 'online') parts.push(`El par ${name} está ${STATUS_TEXT[pair.status] || `en modo ${pair.status}`}.`);
  parts.push(`Reglas de ${name}: volumen mínimo ${pair.ordermin ?? '?'}, importe mínimo ${pair.costmin ?? '?'}, precio en saltos de ${pair.tick_size ?? '?'} (${pair.pair_decimals ?? '?'} decimales), volumen con ${pair.lot_decimals ?? '?'} decimales.`);
  return parts.join(' ');
}

function describeAttempt(a) {
  const what = a.krakenError || (a.error ? (a.notSent ? `${a.error} (no enviada)` : a.error) : `HTTP ${a.status}`);
  return a.retriedAfterMs != null ? `${what} → reintento tras ${(a.retriedAfterMs / 1000).toFixed(1)} s` : what;
}

/** Advice on repeating the call: yes | no | after-wait | check-first, plus seconds. */
function retryAdvice(kind, method, info, res, nowMs) {
  if (info) {
    switch (info.kind) {
      case 'lockout': return { safe: 'after-wait', afterSeconds: 900 };
      case 'rate':
        if (info.code === 'EGeneral:Too many requests') return { safe: 'after-wait', afterSeconds: 5 };
        if (info.code && info.code.startsWith('EAuth')) return { safe: 'after-wait', afterSeconds: 30 };
        return { safe: 'after-wait', afterSeconds: HISTORY.has(method) ? 15 : 5 };
      case 'throttled': {
        const s = throttledWaitSeconds(info.raw, nowMs);
        return { safe: 'after-wait', afterSeconds: s === null ? 5 : Math.ceil(s) + 1 };
      }
      case 'orderRate': return { safe: 'after-wait', afterSeconds: 5 };
      case 'nonce': return { safe: 'after-wait', afterSeconds: 2 };
      case 'transient': return kind === 'create' ? { safe: 'check-first' } : { safe: 'after-wait', afterSeconds: 10 };
      default:
        if (info.code === 'EOrder:Insufficient margin') return { safe: 'after-wait', afterSeconds: 60 };
        if (info.code === null) return kind === 'create' ? { safe: 'check-first' } : { safe: 'no' };
        return { safe: 'no' };
    }
  }
  if (res.error === 'busy') return { safe: 'after-wait', afterSeconds: 5 };
  if (res.error === 'locked') return { safe: 'after-wait', afterSeconds: Math.max(1, Math.ceil((res.lockedUntil - nowMs) / 1000)) };
  if (kind === 'create' && !res.notSent && !NEVER_RECEIVED.has(res.status)) return { safe: 'check-first' };
  return { safe: 'after-wait', afterSeconds: 10 };
}

function build(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  return out;
}

function createExecutor({ client, sleep = defaultSleep, now = () => Date.now() }) {
  const followUp = (method, params) => client.privateCall(method, params, { policy: 'read', budgetMs: FOLLOW_UP_BUDGET_MS });

  async function queryOrders(txids) {
    if (!txids.length) return {};
    const r = await followUp('QueryOrders', { txid: txids.join(',') });
    if (!okJson(r)) return null;
    return Object.fromEntries(entries(r.json.result).map(([txid, o]) => [txid, compactOrder(txid, o)]));
  }

  /** The current state of the order named in params (txid or cl_ord_id), or null. */
  async function currentOrder(params) {
    if (typeof params.txid === 'string' && TXID.test(params.txid)) {
      const map = await queryOrders([params.txid]);
      return map ? map[params.txid] || null : null;
    }
    if (typeof params.cl_ord_id === 'string') {
      const want = normId(params.cl_ord_id);
      for (const [method, key] of [['OpenOrders', 'open'], ['ClosedOrders', 'closed']]) {
        const r = await followUp(method, method === 'ClosedOrders' ? { cl_ord_id: params.cl_ord_id, without_count: 'true' } : { cl_ord_id: params.cl_ord_id });
        if (!okJson(r)) return null;
        const hit = entries(r.json.result && r.json.result[key]).find(([, o]) => o.cl_ord_id && normId(o.cl_ord_id) === want);
        if (hit) return compactOrder(hit[0], hit[1]);
      }
    }
    return null;
  }

  /**
   * Looks the orders up after an ambiguous answer: OpenOrders + ClosedOrders (opened since
   * just before the call), 2 s and again 5 s after it. 'no' only when the last lookup worked
   * and the order was in neither list.
   */
  async function verify(ids, submittedAt) {
    const startSec = Math.floor(submittedAt / 1000) - 60;
    const since = submittedAt / 1000 - 5;
    const found = new Map();
    let lastOk = false;
    let rounds = 0;
    for (const delay of VERIFY_DELAYS_MS) {
      await sleep(delay);
      rounds += 1;
      const open = await followUp('OpenOrders', {});
      const closed = await followUp('ClosedOrders', { start: String(startSec), without_count: 'true' });
      lastOk = okJson(open) && okJson(closed);
      const all = [...entries(open.json && open.json.result && open.json.result.open), ...entries(closed.json && closed.json.result && closed.json.result.closed)];
      ids.forEach((ref, i) => {
        if (found.has(i)) return;
        const hit = all.find(([, o]) => Number(o.opentm) >= since && (ref.cl_ord_id !== undefined ? o.cl_ord_id && normId(o.cl_ord_id) === normId(ref.cl_ord_id) : ref.userref !== undefined && Number(o.userref) === ref.userref));
        if (hit) found.set(i, compactOrder(hit[0], hit[1]));
      });
      if (found.size === ids.length) break;
    }
    const orders = ids.map((ref, i) => build({ ...ref, placed: found.has(i) ? 'yes' : lastOk ? 'no' : 'unknown', ...(found.get(i) || {}) }));
    const executed = found.size === ids.length ? 'yes' : found.size > 0 ? 'partial' : lastOk ? 'no' : 'unknown';
    const seconds = VERIFY_DELAYS_MS.slice(0, rounds).reduce((a, b) => a + b, 0) / 1000;
    return { executed, orders, verification: { checked: 'OpenOrders + ClosedOrders', rounds, secondsAfter: seconds, conclusive: lastOk || found.size === ids.length } };
  }

  function verifiedSentence(v, ids) {
    if (v.executed === 'yes') {
      const list = v.orders.map((o) => `${o.txid} (${orderText(o)})`).join('; ');
      return `El proxy lo comprobó en Kraken ${v.verification.secondsAfter} s después: la orden SÍ se creó: ${list}.`;
    }
    if (v.executed === 'partial') return `El proxy lo comprobó en Kraken: solo algunas órdenes se crearon (ver proxy.orders).`;
    if (v.executed === 'no') return `El proxy lo comprobó en Kraken ${v.verification.secondsAfter} s después: la orden NO aparece ni en órdenes abiertas ni en cerradas, así que NO se creó (${ids.map(refText).join(', ')}).`;
    return 'El proxy intentó comprobar en Kraken si la orden se creó, pero no pudo: NO se sabe.';
  }

  function verifiedNext(v, ids) {
    const ref = ids.map(refText).join(', ');
    if (v.executed === 'yes') return 'NO la reenvíes: ya existe. Síguela con QueryOrders (txid).';
    if (v.executed === 'partial') return 'Reenvía solo las que tienen placed = "no" (con su mismo cl_ord_id). NO reenvíes las que tienen placed = "yes".';
    if (v.executed === 'no') return `Puedes reenviarla. Usa el mismo ${ref}: si la primera apareciera abierta, Kraken rechazaría la copia.`;
    return `NO la reenvíes todavía. En unos segundos consulta OpenOrders y ClosedOrders buscando ${ref}. Si no aparece, reenvíala con ese mismo identificador.`;
  }

  async function describeSuccess({ method, params, ids, changes, res }) {
    const result = res.json.result || {};
    const common = { ok: true, method, where: 'kraken', changes, attempts: res.attempts.length > 1 ? res.attempts.map(describeAttempt) : undefined, traceId: res.traceId || undefined };
    const validateOnly = params.validate === 'true' || params.validate === true;

    if (method === 'AddOrder') {
      const txids = Array.isArray(result.txid) ? result.txid : [];
      if (validateOnly) return build({ ...common, executed: 'no', summary: `Solo se validó (validate=true): Kraken aceptó los datos, pero la orden NO se creó. ${result.descr && result.descr.order ? `Orden validada: ${result.descr.order}.` : ''}`.trim(), next: 'Para crearla de verdad, envíala sin validate.' });
      if (!txids.length) return null; // no txid: treated as ambiguous by the caller
      const map = await queryOrders(txids);
      const o = map && map[txids[0]];
      return build({
        ...common,
        executed: 'yes',
        summary: `Orden creada en Kraken: txid ${txids.join(', ')} (${refText(ids[0])}). ${o ? `Ahora está ${orderText(o)}.` : 'No se pudo consultar su estado justo después.'}`,
        next: o && (o.status === 'canceled' || o.status === 'expired') ? 'Kraken la creó pero ya no está activa: mira order.reason.' : 'Hecho. Para seguirla usa QueryOrders con el txid.',
        order: o || { txid: txids[0], ...ids[0] },
      });
    }

    if (method === 'AddOrderBatch') {
      const items = Array.isArray(result.orders) ? result.orders : [];
      if (validateOnly) return build({ ...common, executed: 'no', summary: 'Solo se validó (validate=true): ninguna orden se creó.', next: 'Para crearlas de verdad, envía el lote sin validate.' });
      const placed = items.map((it) => (it && it.txid ? String(it.txid) : null));
      const map = (await queryOrders(placed.filter(Boolean))) || {};
      const orders = ids.map((ref, i) => {
        const it = items[i] || {};
        if (it.txid) return build({ index: i, ...ref, placed: 'yes', ...(map[it.txid] || { txid: it.txid }) });
        const info = it.error ? lookupError(it.error) : null;
        return build({ index: i, ...ref, placed: it.error ? 'no' : 'unknown', krakenError: it.error || undefined, explanation: info ? info.es : undefined });
      });
      const yes = orders.filter((o) => o.placed === 'yes').length;
      const no = orders.filter((o) => o.placed === 'no').length;
      const executed = yes === orders.length ? 'yes' : yes === 0 && no === orders.length ? 'no' : yes === 0 ? 'unknown' : 'partial';
      return build({
        ...common,
        executed,
        summary: `${yes} de ${orders.length} órdenes creadas${no ? `; ${no} rechazadas por Kraken (motivo en proxy.orders)` : ''}.`,
        next: no ? 'Revisa las rechazadas; reenvía solo esas si quieres. NO reenvíes las creadas.' : 'Hecho. Para seguirlas usa QueryOrders con los txid.',
        orders,
      });
    }

    if (method === 'AmendOrder') {
      const current = await currentOrder(params);
      return build({ ...common, executed: 'yes', summary: `Cambio aceptado por Kraken (amend_id ${result.amend_id ?? '?'}).${current ? ` La orden ahora está ${orderText(current)}.` : ''}`, next: 'Hecho.', order: current || undefined });
    }

    if (method === 'CancelAllOrdersAfter') {
      const off = String(params.timeout) === '0';
      return build({ ...common, executed: 'yes', summary: off ? 'Temporizador de cancelación desactivado.' : `Temporizador activo: si no se renueva antes de ${result.triggerTime ?? '?'}, Kraken cancelará todas las órdenes abiertas.`, next: off ? 'Hecho.' : 'Renueva la llamada antes de esa hora si quieres mantener las órdenes.' });
    }

    // CancelOrder, CancelAll, CancelOrderBatch
    const count = Number(result.count ?? 0);
    if (result.pending === true || result.pending === 'true') {
      return build({ ...common, executed: 'yes', summary: `Cancelación aceptada, pendiente de confirmar (${count}).`, next: 'Comprueba en unos segundos con QueryOrders u OpenOrders que ya no está abierta.' });
    }
    if (count === 0) {
      const current = method === 'CancelOrder' ? await currentOrder(params) : null;
      return build({ ...common, executed: 'no', summary: `Kraken no canceló ninguna orden.${current ? ` La orden está ${orderText(current)}.` : ''}`, next: 'Revisa el identificador y el estado de la orden (OpenOrders).', order: current || undefined });
    }
    return build({ ...common, executed: 'yes', summary: `${count} orden${count === 1 ? '' : 'es'} cancelada${count === 1 ? '' : 's'}.`, next: 'Hecho.' });
  }

  async function describeFailure({ kind, method, params, ids, changes, res, submittedAt, reason }) {
    const errs = errorsOf(res.json);
    const info = errs.length ? lookupError(errs[0]) : null;
    const where = info || reason === 'no-txid' ? 'kraken' : res.error === 'busy' || res.error === 'locked' ? 'proxy' : 'network';
    let executed;
    if (kind !== 'read') {
      if (reason === 'no-txid') executed = 'unknown';
      else if (info) executed = info.executed === 'no' ? 'no' : 'unknown';
      else executed = res.notSent || NEVER_RECEIVED.has(res.status) || res.error === 'busy' || res.error === 'locked' ? 'no' : 'unknown';
    }

    const summary = [];
    if (reason === 'no-txid') summary.push('Kraken respondió sin error pero sin el txid de la orden.');
    else summary.push(info ? `${info.es}${info.detail ? ` Detalle de Kraken: «${info.detail}».` : ''}` : transportText(res));
    if (res.attempts && res.attempts.length > 1) summary.push(`El proxy lo intentó ${res.attempts.length} veces.`);

    let next = info ? info.next : kind === 'read' ? 'Reintenta en unos segundos.' : undefined;
    let retry = retryAdvice(kind, method, info, res, now());
    let verification;
    let orders;
    let order;

    // An order whose outcome is unclear: look it up instead of guessing.
    if ((method === 'AddOrder' || method === 'AddOrderBatch') && executed === 'unknown' && ids.length) {
      const v = await verify(ids, submittedAt);
      executed = v.executed;
      verification = v.verification;
      if (method === 'AddOrder') order = v.orders[0];
      else orders = v.orders;
      summary.push(verifiedSentence(v, ids));
      next = verifiedNext(v, ids);
      retry = v.executed === 'no' ? { safe: 'yes' } : v.executed === 'unknown' ? { safe: 'check-first' } : { safe: 'no' };
    } else if (method === 'AmendOrder' && executed === 'unknown') {
      order = await currentOrder(params);
      summary.push(order ? `No se sabe si el cambio se aplicó. La orden ahora está ${orderText(order)}: compárala con lo que pediste.` : 'No se sabe si el cambio se aplicó y no se pudo consultar la orden.');
      next = 'Si la orden no tiene los valores nuevos, reenvía el mismo AmendOrder (es seguro: fija valores absolutos).';
    } else if (kind === 'cancel' && executed === 'unknown') {
      summary.push('No se sabe si la cancelación se aplicó.');
      next = 'Consulta OpenOrders: si la orden sigue abierta, repite la cancelación (es seguro).';
    } else if ((method === 'CancelOrder' || method === 'AmendOrder') && info && info.code === 'EOrder:Unknown order') {
      order = await currentOrder(params);
      if (order) summary.push(`El proxy consultó la orden: está ${orderText(order)}.`);
      next = order ? (order.status === 'closed' ? 'Ya se ejecutó: no hay nada que cancelar o modificar.' : 'No hay nada más que hacer con esta orden.') : 'Revisa el txid o cl_ord_id (OpenOrders / ClosedOrders).';
    } else if (kind === 'create' && executed === 'no' && info) {
      if (!/NO se creó|no se modificó/.test(info.es)) summary.push(method === 'AmendOrder' ? 'La orden no se modificó.' : 'La orden NO se creó.');
    }

    let krakenStatus = res.krakenStatus;
    if (!krakenStatus && info && info.code && info.code.startsWith('EService:') && info.kind === 'transient') krakenStatus = await client.systemStatus();
    if (krakenStatus && krakenStatus !== 'online') summary.push(`Estado de Kraken: ${STATUS_TEXT[krakenStatus] || krakenStatus}.`);

    let pair;
    if (info && PAIR_ERRORS.has(info.code) && typeof params.pair === 'string') {
      pair = await client.pairInfo(params.pair);
      if (pair) summary.push(pairText(pair));
    }

    return build({
      ok: false,
      method,
      summary: summary.join(' '),
      executed,
      where,
      krakenError: info ? info.raw : undefined,
      httpStatus: res.status || undefined,
      retry: build({ automaticRetries: Math.max(0, (res.attempts || []).length - 1), safeToRetry: retry.safe, afterSeconds: retry.afterSeconds }),
      next,
      changes,
      attempts: res.attempts && res.attempts.length > 1 ? res.attempts.map(describeAttempt) : undefined,
      order,
      orders,
      verification,
      krakenStatus: krakenStatus || undefined,
      pair,
      traceId: res.traceId || undefined,
    });
  }

  /** The EProxy error line for answers that are not Kraken JSON. */
  function transportError(res, method, executed) {
    const base = res.error === 'timeout' ? 'EProxy:Kraken did not answer in time'
      : res.error === 'busy' ? 'EProxy:Too many Kraken calls waiting; retry in a few seconds'
        : res.error === 'locked' ? 'EProxy:Kraken temporarily locked the API key; calls are paused'
          : res.status ? `EProxy:Kraken returned an unexpected response (HTTP ${res.status})`
            : 'EProxy:Could not reach Kraken';
    if (!CREATE.has(method) && !CANCEL.has(method)) return base;
    if (executed === 'yes') return `${base}; the order WAS placed (verified, see proxy)`;
    if (executed === 'partial') return `${base}; some orders were placed (verified, see proxy.orders)`;
    if (executed === 'no') return `${base}; it was NOT executed (see proxy)`;
    return `${base}; the order may or may not have been placed: check OpenOrders/ClosedOrders before retrying`;
  }

  /**
   * Runs the call. Returns { status, text } (raw passthrough), { status, body, proxy }, or
   * { cancelled: true } when Muse hung up before it was sent.
   */
  async function run({ method, readOnly, params, changes = [], ids = [], isCancelled }) {
    const kind = policyFor(method, readOnly);
    const submittedAt = now();
    const res = await client.privateCall(method, params, { policy: kind, isCancelled });
    if (res.error === 'cancelled') return { cancelled: true, res };
    const success = okJson(res);
    if (success && kind === 'read') return { status: res.status, text: res.text, res };

    let proxy = success ? await describeSuccess({ method, params, ids, changes, res }) : null;
    if (!proxy) proxy = await describeFailure({ kind, method, params, ids, changes, res, submittedAt, reason: success ? 'no-txid' : undefined });
    if (res.json) return { status: res.status, body: { ...res.json, proxy }, res, proxy };
    const status = res.error === 'timeout' ? 504 : res.error === 'busy' || res.error === 'locked' ? 503 : 502;
    return { status, body: { error: [transportError(res, method, proxy.executed)], proxy }, res, proxy };
  }

  return { run };
}

/** `proxy` object for the proxy's own rejections (nothing was sent to Kraken). */
function rejection(status, error, { method, trading, afterSeconds } = {}) {
  const texts = {
    400: ['El proxy rechazó la llamada antes de enviarla a Kraken: los datos no son válidos.', 'Corrige lo que dice el error y vuelve a enviar.'],
    401: ['Falta la llave del proxy o no es la correcta. No se envió nada a Kraken.', 'Pide la llave de Kraken al operador por la tarjeta segura y envíala en X-Proxy-Key.'],
    403: ['El proxy no permite esta operación. No se envió nada a Kraken.', 'No insistas: usa un método permitido.'],
    404: ['Esa ruta no existe en el proxy.', 'Usa POST /api/kraken.'],
    405: ['Método HTTP no admitido.', 'Usa POST /api/kraken con {"method": ..., "params": {...}}.'],
    413: ['El cuerpo de la petición es demasiado grande.', 'Envía menos datos.'],
    429: ['Demasiadas llamadas al proxy (máximo 60 por minuto). No se envió esta a Kraken.', 'Espera y reintenta.'],
    503: ['Kraken no está configurado en el servidor.', 'Avisa al operador.'],
  };
  const [summary, next] = texts[status] || ['El proxy rechazó la llamada.', 'Revisa el error.'];
  const tradingCall = trading || CREATE.has(method) || CANCEL.has(method);
  return build({
    ok: false,
    method: method || undefined,
    summary,
    executed: tradingCall ? 'no' : undefined,
    where: 'proxy',
    detail: error,
    retry: status === 429 ? build({ automaticRetries: 0, safeToRetry: 'after-wait', afterSeconds }) : { automaticRetries: 0, safeToRetry: 'no' },
    next,
  });
}

module.exports = { createExecutor, rejection, policyFor, orderText, CREATE, CANCEL, STATUS_TEXT };
