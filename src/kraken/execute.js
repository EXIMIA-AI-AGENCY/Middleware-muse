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
 * up by its cl_ord_id (or userref + details) in OpenOrders and ClosedOrders and reports what it
 * found. "Not found" is reported as such, never as a certain "no": Kraken may still process an
 * order it received late.
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
// Whole request, from arrival (queue wait included) to answer. Orders keep time in reserve
// to look themselves up when their answer is lost.
const TOTAL_MS = { read: 25_000, cancel: 25_000, create: 30_000 };
const LOOKUP_RESERVE_MS = 9_000;
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
// Only object entries: a malformed map from Kraken must never throw.
const entries = (obj) => (obj && typeof obj === 'object' ? Object.entries(obj).filter(([, v]) => v && typeof v === 'object') : []);
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
const sameNumber = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null && Number(a) === Number(b);

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

const refText = (ref) => (ref.cl_ord_id !== undefined ? `cl_ord_id ${ref.cl_ord_id}` : `userref ${ref.userref}`);

function transportText(res) {
  if (res.error === 'timeout') return res.notSent ? 'No se pudo conectar con Kraken a tiempo: la petición no llegó a salir del proxy.' : 'Kraken no respondió a tiempo.';
  if (res.error === 'network') return res.notSent ? 'No se pudo conectar con Kraken: la petición no llegó a salir del proxy.' : 'Se cortó la conexión con Kraken después de enviar la petición, sin respuesta.';
  if (res.error === 'busy') return 'Hay demasiadas llamadas a Kraken esperando turno en el proxy. No se envió esta.';
  if (res.error === 'expired') return 'La llamada esperó demasiado su turno en el proxy y no se envió a Kraken.';
  if (res.error === 'locked') return `Kraken bloqueó temporalmente la API key por errores repetidos; este servidor no le llama hasta las ${hhmm(res.lockedUntil)} UTC para no alargar el bloqueo. No se envió esta.`;
  if (res.error === 'too_large') return 'La respuesta de Kraken era demasiado grande para procesarla.';
  return `Kraken (o Cloudflare, delante de Kraken) respondió HTTP ${res.status} sin datos válidos.`;
}

function pairText(pair) {
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

/** Could this attempt have run at Kraken even though its answer did not say so? */
function mayHaveRun(a) {
  if (a.krakenError) return lookupError(a.krakenError).executed === 'maybe';
  if (a.error) return (a.error === 'timeout' || a.error === 'network') && !a.notSent;
  return a.status >= 500 && !NEVER_RECEIVED.has(a.status);
}
const earlierMayHaveRun = (res) => (res.attempts || []).slice(0, -1).some(mayHaveRun);

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
  if (res.error === 'busy' || res.error === 'expired') return { safe: 'after-wait', afterSeconds: 5 };
  if (res.error === 'locked') return { safe: 'after-wait', afterSeconds: Math.max(1, Math.ceil((res.lockedUntil - nowMs) / 1000)) };
  if (kind === 'create' && !res.notSent && !NEVER_RECEIVED.has(res.status)) return { safe: 'check-first' };
  return { safe: 'after-wait', afterSeconds: 10 };
}

function build(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  return out;
}

/** The EProxy error line for answers that are not Kraken JSON. */
function transportError(res, method, executed) {
  let base;
  if (res.error === 'timeout') base = res.notSent ? 'EProxy:Could not connect to Kraken in time (request not sent)' : 'EProxy:Kraken did not answer in time';
  else if (res.error === 'network') base = res.notSent ? 'EProxy:Could not reach Kraken (request not sent)' : 'EProxy:Connection to Kraken lost after sending, no answer';
  else if (res.error === 'busy') base = 'EProxy:Too many Kraken calls waiting; retry in a few seconds';
  else if (res.error === 'expired') base = 'EProxy:Waited too long in the queue; not sent to Kraken';
  else if (res.error === 'locked') base = 'EProxy:Kraken temporarily locked the API key; calls are paused';
  else if (res.error === 'too_large') base = 'EProxy:Kraken response too large to read';
  else base = `EProxy:Kraken returned an unexpected response (HTTP ${res.status})`;
  if (!CREATE.has(method) && !CANCEL.has(method)) return base;
  if (executed === 'no') return `${base}; it was NOT executed (see proxy)`;
  if (method === 'AddOrder' || method === 'AddOrderBatch') {
    if (executed === 'yes') return `${base}; the order WAS placed (verified, see proxy)`;
    if (executed === 'partial') return `${base}; some orders were placed (verified, see proxy.orders)`;
    return `${base}; the order may or may not have been placed: check OpenOrders/ClosedOrders before retrying`;
  }
  if (executed === 'yes') return `${base}; it was applied (verified, see proxy)`;
  if (method === 'AmendOrder') return `${base}; the amendment may or may not have been applied: check the order (QueryOrders) before resending`;
  if (method === 'CancelAllOrdersAfter') return `${base}; the timer change may or may not have been applied`;
  return `${base}; the cancellation may or may not have been applied: check OpenOrders before retrying`;
}

function createExecutor({ client, sleep = defaultSleep, now = () => Date.now(), verifyDelaysMs = VERIFY_DELAYS_MS, totalMs = TOTAL_MS, lookupReserveMs = LOOKUP_RESERVE_MS }) {
  /** A read after the main call, bounded by what is left of the request's time. */
  function followUp(method, params, deadline) {
    const left = deadline - now() - 300;
    if (left < 1000) return Promise.resolve({ status: 0, error: 'expired', notSent: true, attempts: [] });
    return client.privateCall(method, params, { policy: 'read', budgetMs: Math.min(FOLLOW_UP_BUDGET_MS, left) });
  }

  async function queryOrders(txids, deadline) {
    if (!txids.length) return {};
    const r = await followUp('QueryOrders', { txid: txids.join(',') }, deadline);
    if (!okJson(r)) return null;
    return Object.fromEntries(entries(r.json.result).map(([txid, o]) => [txid, compactOrder(txid, o)]));
  }

  /** The current state of the order named in params (txid or cl_ord_id), or null. */
  async function currentOrder(params, deadline) {
    if (typeof params.txid === 'string' && TXID.test(params.txid)) {
      const map = await queryOrders([params.txid], deadline);
      return map ? map[params.txid] || null : null;
    }
    if (typeof params.cl_ord_id === 'string') {
      const want = normId(params.cl_ord_id);
      for (const [method, key] of [['OpenOrders', 'open'], ['ClosedOrders', 'closed']]) {
        const r = await followUp(method, { cl_ord_id: params.cl_ord_id }, deadline);
        if (!okJson(r)) return null;
        const hit = entries(r.json.result && r.json.result[key]).find(([, o]) => o.cl_ord_id && normId(o.cl_ord_id) === want);
        if (hit) return compactOrder(hit[0], hit[1]);
      }
    }
    return null;
  }

  function matches(target, o) {
    if (target.ref.cl_ord_id !== undefined) return Boolean(o.cl_ord_id) && normId(o.cl_ord_id) === normId(target.ref.cl_ord_id);
    // A userref is shared by design: the order's details must match too.
    if (o.userref === null || o.userref === undefined || Number(o.userref) !== target.ref.userref) return false;
    const d = o.descr || {};
    const m = target.match || {};
    if (m.type && d.type !== m.type) return false;
    if (m.ordertype && d.ordertype !== m.ordertype) return false;
    if (m.volume !== undefined && !sameNumber(o.vol, m.volume)) return false;
    // A price Muse sent must be confirmed by Kraken's description; otherwise it is not a match.
    if (m.price !== undefined && !sameNumber(d.price, m.price)) return false;
    return true;
  }

  /**
   * Looks orders up after an ambiguous answer, 2 s and 5 s later, within the request's time.
   * One order: OpenOrders + ClosedOrders filtered by its id (no pagination problem). A batch:
   * both lists since just before the call, and a result cut at 50 orders is inconclusive.
   * Per order: 'yes' (found, exactly one match), or 'unknown' (not found, or ambiguous).
   */
  async function verify(targets, submittedAt, deadline) {
    const startSec = Math.floor(submittedAt / 1000) - 60;
    const since = submittedAt / 1000 - 5;
    const single = targets.length === 1;
    const found = new Map();
    const ambiguous = new Map();
    let conclusive = false;
    let rounds = 0;
    for (const delay of verifyDelaysMs) {
      if (deadline - now() < delay + 2500) break;
      await sleep(delay);
      rounds += 1;
      const filter = single ? { ...targets[0].ref } : {};
      const open = await followUp('OpenOrders', filter, deadline);
      const closed = await followUp('ClosedOrders', { ...filter, start: String(startSec) }, deadline);
      const closedList = entries(closed.json && closed.json.result && closed.json.result.closed);
      const count = Number(closed.json && closed.json.result && closed.json.result.count);
      const cut = Number.isFinite(count) ? count > closedList.length : closedList.length >= 50;
      conclusive = okJson(open) && okJson(closed) && !cut;
      const all = [...entries(open.json && open.json.result && open.json.result.open), ...closedList].filter(([, o]) => Number(o.opentm) >= since);
      const used = new Set([...found.values()].map((o) => o.txid));
      targets.forEach((t, i) => {
        if (found.has(i)) return;
        const hits = all.filter(([txid, o]) => !used.has(txid) && matches(t, o));
        if (hits.length === 1) {
          found.set(i, compactOrder(hits[0][0], hits[0][1]));
          used.add(hits[0][0]);
          ambiguous.delete(i);
        } else if (hits.length > 1) {
          ambiguous.set(i, hits.map(([txid]) => txid));
        }
      });
      if (found.size === targets.length) break;
    }
    const orders = targets.map((t, i) => {
      if (found.has(i)) return build({ ...t.ref, placed: 'yes', ...found.get(i) });
      if (ambiguous.has(i)) return build({ ...t.ref, placed: 'unknown', candidates: ambiguous.get(i) });
      return build({ ...t.ref, placed: 'unknown', seen: conclusive ? false : undefined });
    });
    const executed = found.size === targets.length ? 'yes' : found.size > 0 ? 'partial' : 'unknown';
    const notFound = conclusive && found.size === 0 && ambiguous.size === 0;
    return {
      executed,
      notFound,
      orders,
      verification: { checked: 'OpenOrders + ClosedOrders', rounds, secondsAfterSending: Math.round((now() - submittedAt) / 1000), conclusive: conclusive || found.size === targets.length },
    };
  }

  function verifiedSentence(v) {
    const s = v.verification.secondsAfterSending;
    if (v.executed === 'yes') return `El proxy lo comprobó en Kraken ${s} s después de enviarla: SÍ se creó: ${v.orders.map((o) => `${o.txid} (${orderText(o)})`).join('; ')}.`;
    if (v.executed === 'partial') return `El proxy lo comprobó en Kraken ${s} s después: solo algunas órdenes aparecen (ver proxy.orders).`;
    if (v.orders.some((o) => o.candidates)) return 'El proxy encontró varias órdenes que encajan (mismo userref y datos), así que no puede saber cuál es: mira proxy.orders[].candidates.';
    if (v.notFound) return `El proxy la buscó en Kraken (órdenes abiertas y cerradas) ${s} s después de enviarla y NO aparece: lo más probable es que no se creara, pero Kraken aún podría procesarla si iba con retraso.`;
    return 'El proxy intentó comprobar en Kraken si se creó, pero no pudo: NO se sabe.';
  }

  function verifiedNext(v, targets) {
    const refs = targets.map((t) => refText(t.ref)).join(', ');
    const lookup = targets.some((t) => t.ref.cl_ord_id !== undefined) ? 'OpenOrders y ClosedOrders con cl_ord_id' : 'OpenOrders y ClosedOrders (mira userref, lado y volumen)';
    if (v.executed === 'yes') return 'NO la reenvíes: ya existe. Síguela con QueryOrders (txid).';
    if (v.executed === 'partial') return 'NO reenvíes las que tienen placed = "yes". Para las demás, espera ~60 s y búscalas antes de reenviarlas.';
    if (v.notFound) {
      const same = targets.every((t) => t.ref.cl_ord_id !== undefined) ? ' con el mismo cl_ord_id (así Kraken rechaza la copia si la primera sigue abierta; no protege si la primera ya se ejecutó)' : ' (con userref Kraken no evita duplicados)';
      return `Espera ~60 s y vuelve a buscarla (${lookup}: ${refs}). Si sigue sin aparecer, reenvíala${same}.`;
    }
    return `NO la reenvíes todavía. En unos segundos busca ${refs} en ${lookup}. Solo si no aparece, reenvíala.`;
  }

  async function describeSuccess({ method, params, ids, changes, res, submittedAt, deadline, validateOnly }) {
    const result = res.json.result && typeof res.json.result === 'object' ? res.json.result : {};
    const common = { ok: true, method, where: 'kraken', changes, attempts: res.attempts.length > 1 ? res.attempts.map(describeAttempt) : undefined, traceId: res.traceId || undefined };

    if (method === 'AddOrder') {
      const txids = Array.isArray(result.txid) ? result.txid.map(String) : [];
      if (!txids.length) {
        if (validateOnly) return build({ ...common, executed: 'no', summary: `Solo se validó (validate=true): Kraken aceptó los datos, pero la orden NO se creó.${result.descr && result.descr.order ? ` Orden validada: ${result.descr.order}.` : ''}`, next: 'Para crearla de verdad, envíala sin validate.' });
        return null; // no txid: handled as ambiguous by the caller
      }
      const map = await queryOrders(txids, deadline);
      const o = map && map[txids[0]];
      const warning = validateOnly ? ' ATENCIÓN: Kraken la creó aunque se envió validate.' : '';
      return build({
        ...common,
        executed: 'yes',
        summary: `Orden creada en Kraken: txid ${txids.join(', ')} (${refText(ids[0].ref)}).${warning} ${o ? `Ahora está ${orderText(o)}.` : 'No se pudo consultar su estado justo después.'}`,
        next: o && (o.status === 'canceled' || o.status === 'expired') ? 'Kraken la creó pero ya no está activa: mira order.reason.' : 'Hecho. Para seguirla usa QueryOrders con el txid.',
        order: o || { txid: txids[0], ...ids[0].ref },
      });
    }

    if (method === 'AddOrderBatch') {
      const items = Array.isArray(result.orders) ? result.orders : [];
      const hasTxid = items.some((it) => it && it.txid);
      if (validateOnly && !hasTxid) return build({ ...common, executed: 'no', summary: 'Solo se validó (validate=true): ninguna orden se creó.', next: 'Para crearlas de verdad, envía el lote sin validate.' });
      const txids = items.map((it) => (it && it.txid ? String(it.txid) : null));
      const map = (await queryOrders(txids.filter(Boolean), deadline)) || {};
      const orders = ids.map((t, i) => {
        const it = items[i] && typeof items[i] === 'object' ? items[i] : {};
        if (it.txid) return build({ index: i, ...t.ref, placed: 'yes', ...(map[it.txid] || { txid: String(it.txid) }) });
        if (it.error) {
          const info = lookupError(it.error);
          return build({ index: i, ...t.ref, placed: 'no', krakenError: String(it.error), explanation: info.es });
        }
        return build({ index: i, ...t.ref, placed: 'unknown' });
      });
      // Orders Kraken said nothing about: look them up like a lost answer.
      const unknown = orders.map((o, i) => (o.placed === 'unknown' ? i : -1)).filter((i) => i >= 0);
      let verification;
      if (unknown.length && !validateOnly) {
        const v = await verify(unknown.map((i) => ids[i]), submittedAt, deadline);
        verification = v.verification;
        unknown.forEach((i, k) => {
          orders[i] = build({ index: i, ...v.orders[k] });
        });
      }
      const yes = orders.filter((o) => o.placed === 'yes').length;
      const no = orders.filter((o) => o.placed === 'no').length;
      const unsure = orders.length - yes - no;
      const executed = yes === orders.length ? 'yes' : no === orders.length ? 'no' : yes === 0 && no === 0 ? 'unknown' : 'partial';
      const summary = [`${yes} de ${orders.length} órdenes creadas${no ? `; ${no} rechazadas por Kraken (motivo en proxy.orders)` : ''}${unsure ? `; de ${unsure} no se sabe` : ''}.`];
      if (validateOnly) summary.push('ATENCIÓN: Kraken creó órdenes aunque se envió validate.');
      return build({
        ...common,
        executed,
        summary: summary.join(' '),
        next: unsure ? 'NO reenvíes las que tienen placed = "yes", ni las "unknown" sin buscarlas antes (OpenOrders/ClosedOrders con su cl_ord_id).' : no ? 'Revisa las rechazadas; reenvía solo esas si quieres. NO reenvíes las creadas.' : 'Hecho. Para seguirlas usa QueryOrders con los txid.',
        retry: unsure ? { automaticRetries: 0, safeToRetry: 'check-first' } : undefined,
        orders,
        verification,
      });
    }

    if (method === 'AmendOrder') {
      const current = await currentOrder(params, deadline);
      return build({ ...common, executed: 'yes', summary: `Cambio aceptado por Kraken (amend_id ${result.amend_id ?? '?'}).${current ? ` La orden ahora está ${orderText(current)}.` : ''}`, next: 'Hecho.', order: current || undefined });
    }

    if (method === 'CancelAllOrdersAfter') {
      const off = String(params.timeout) === '0';
      return build({ ...common, executed: 'yes', summary: off ? 'Temporizador de cancelación desactivado.' : `Temporizador activo: si no se renueva antes de ${result.triggerTime ?? '?'}, Kraken cancelará todas las órdenes abiertas.`, next: off ? 'Hecho.' : 'Renueva la llamada antes de esa hora si quieres mantener las órdenes.' });
    }

    // CancelOrder, CancelAll, CancelOrderBatch
    const count = Number(result.count ?? 0);
    const earlier = earlierMayHaveRun(res);
    if (result.pending === true || result.pending === 'true') {
      return build({ ...common, executed: 'yes', summary: `Cancelación aceptada, pendiente de confirmar (${count}).`, next: 'Comprueba en unos segundos con QueryOrders u OpenOrders que ya no está abierta.' });
    }
    if (count === 0) {
      const current = method === 'CancelOrder' ? await currentOrder(params, deadline) : null;
      if (earlier) {
        // The proxy repeated the cancel after an answer that got lost: that first try may have done it.
        if (current && current.status === 'canceled') {
          return build({ ...common, executed: 'yes', summary: `Un intento anterior canceló la orden (su respuesta se perdió); el reintento ya no la encontró abierta. Está ${orderText(current)}.`, next: 'Hecho.', order: current });
        }
        if (current && current.status === 'closed') {
          return build({ ...common, executed: 'no', summary: `No se canceló: la orden se ejecutó antes (${orderText(current)}).`, next: 'Ya se ejecutó: no hay nada que cancelar.', order: current });
        }
        return build({ ...common, ok: false, executed: 'unknown', summary: 'Un intento anterior quedó sin respuesta y pudo cancelar; el reintento ya no encontró nada abierto que cancelar.', next: 'Consulta OpenOrders: lo que ya no aparece está cancelado o ejecutado (ClosedOrders lo dice). Repetir la cancelación es seguro.', retry: { automaticRetries: res.attempts.length - 1, safeToRetry: 'yes' }, order: current || undefined });
      }
      return build({ ...common, executed: 'no', summary: `Kraken no canceló ninguna orden.${current ? ` La orden está ${orderText(current)}.` : ''}`, next: 'Revisa el identificador y el estado de la orden (OpenOrders).', order: current || undefined });
    }
    const n = earlier ? `Al menos ${count}` : `${count}`;
    return build({ ...common, executed: 'yes', summary: `${n} orden${count === 1 ? '' : 'es'} cancelada${count === 1 ? '' : 's'}.`, next: 'Hecho.' });
  }

  async function describeFailure({ kind, method, params, ids, changes, res, submittedAt, deadline, reason, validateOnly }) {
    const errs = errorsOf(res.json);
    const info = errs.length ? lookupError(errs[0]) : null;
    const where = info || reason === 'no-txid' ? 'kraken' : ['busy', 'locked', 'expired'].includes(res.error) ? 'proxy' : 'network';
    let executed;
    if (kind !== 'read') {
      if (reason === 'no-txid') executed = 'unknown';
      else if (info) executed = info.executed === 'no' ? 'no' : 'unknown';
      else executed = res.notSent || NEVER_RECEIVED.has(res.status) || ['busy', 'locked', 'expired'].includes(res.error) ? 'no' : 'unknown';
      // Maintenance: Kraken's engine is off, so nothing can have run.
      if (executed === 'unknown' && info && info.code === 'EService:Unavailable' && res.krakenStatus === 'maintenance') executed = 'no';
      // A validate-only order can never be placed.
      if (executed === 'unknown' && validateOnly) executed = 'no';
    }

    // Catalog texts talk about new orders; for an amend the order exists and stays as it was.
    let es = info ? info.es : null;
    if (info && method === 'AmendOrder') es = es.replace(/\s*La orden NO se creó\./, ' El cambio NO se aplicó; la orden sigue como estaba.');
    const summary = [];
    if (reason === 'no-txid') summary.push('Kraken respondió sin error pero sin el txid de la orden.');
    else summary.push(info ? `${es}${info.detail ? ` Detalle de Kraken: «${info.detail}».` : ''}` : transportText(res));
    if (res.attempts && res.attempts.length > 1) summary.push(`El proxy lo intentó ${res.attempts.length} veces.`);
    if (res.callerGone) summary.push('Muse ya había colgado, así que el proxy no reintentó.');

    let next = info ? info.next : undefined;
    if (info && method === 'AmendOrder' && info.kind === 'orderRate') next = 'Espera unos segundos y reenvía el mismo AmendOrder.';
    let retry = retryAdvice(kind, method, info, res, now());
    let verification;
    let orders;
    let order;

    if ((method === 'AddOrder' || method === 'AddOrderBatch') && executed === 'unknown' && ids.length) {
      // An order whose outcome is unclear: look it up instead of guessing.
      const v = await verify(ids, submittedAt, deadline);
      executed = v.executed;
      verification = v.verification;
      if (method === 'AddOrder') order = v.orders[0];
      else orders = v.orders.map((o, i) => ({ index: i, ...o }));
      summary.push(verifiedSentence(v));
      next = verifiedNext(v, ids);
      retry = v.executed === 'yes' ? { safe: 'no' } : v.notFound ? { safe: 'check-first', afterSeconds: 60 } : { safe: 'check-first' };
    } else if (method === 'AmendOrder' && executed === 'unknown') {
      order = await currentOrder(params, deadline);
      summary.push(order ? `No se sabe si el cambio se aplicó. La orden ahora está ${orderText(order)}: compárala con lo que pediste.` : 'No se sabe si el cambio se aplicó y no se pudo consultar la orden.');
      next = 'Si la orden no tiene los valores nuevos, reenvía el mismo AmendOrder (es seguro: fija valores absolutos).';
      retry = { safe: 'check-first' };
    } else if ((method === 'CancelOrder' || method === 'AmendOrder') && info && info.code === 'EOrder:Unknown order') {
      order = await currentOrder(params, deadline);
      if (order) summary.push(`El proxy consultó la orden: está ${orderText(order)}.`);
      const live = order && (order.status === 'open' || order.status === 'pending');
      if (method === 'CancelOrder' && order && order.status === 'canceled' && earlierMayHaveRun(res)) {
        executed = 'yes';
        summary.push('La canceló un intento anterior del proxy cuya respuesta se perdió.');
        next = 'Hecho: ya está cancelada.';
        retry = { safe: 'no' };
      } else if (live) {
        next = method === 'CancelOrder' ? 'La orden sigue activa (Kraken aún no la tenía en el libro): repite la misma cancelación en 1-2 s (es seguro).' : 'La orden sigue activa sin el cambio: repite el mismo AmendOrder en 1-2 s (es seguro: fija valores absolutos).';
        retry = { safe: 'after-wait', afterSeconds: 2 };
      } else {
        next = order ? (order.status === 'closed' ? 'Ya se ejecutó: no hay nada que cancelar o modificar.' : 'No hay nada más que hacer con esta orden.') : 'Revisa el txid o cl_ord_id (OpenOrders / ClosedOrders).';
      }
    } else if (kind === 'cancel' && executed === 'unknown') {
      summary.push('No se sabe si la cancelación se aplicó.');
      next = 'Consulta OpenOrders: si la orden sigue abierta, repite la cancelación (es seguro).';
      retry = { safe: 'check-first' };
    } else if (kind === 'create' && executed === 'no' && !/NO se creó|NO se aplicó/.test(summary.join(' '))) {
      summary.push(validateOnly ? 'Era solo validación: no se creó nada.' : method === 'AmendOrder' ? 'El cambio NO se aplicó.' : 'NO se ejecutó.');
    }

    let krakenStatus = res.krakenStatus;
    if (krakenStatus === undefined && info && info.code && info.code.startsWith('EService:') && info.kind === 'transient' && deadline - now() > 5000) krakenStatus = await client.systemStatus();
    if (krakenStatus && krakenStatus !== 'online') summary.push(`Estado de Kraken: ${STATUS_TEXT[krakenStatus] || krakenStatus}.`);

    let pair;
    if (info && PAIR_ERRORS.has(info.code) && typeof params.pair === 'string' && deadline - now() > 5000) {
      pair = await client.pairInfo(params.pair);
      if (pair) summary.push(pairText(pair));
    }

    // Always tell Muse which id its order carries, so it can look it up.
    if (method === 'AddOrder' && !order && ids.length) order = { ...ids[0].ref, placed: executed === 'no' ? 'no' : 'unknown' };
    if (method === 'AddOrderBatch' && !orders && ids.length) orders = ids.map((t, i) => ({ index: i, ...t.ref, placed: executed === 'no' ? 'no' : 'unknown' }));

    if (!next) {
      const refs = ids.length && kind === 'create' ? ` con el mismo ${ids.map((t) => refText(t.ref)).join(', ')}` : '';
      if (retry.safe === 'after-wait') next = `${kind === 'read' ? 'Reintenta' : 'No se ejecutó nada: reintenta'} dentro de ${retry.afterSeconds} s${refs}.`;
      else if (retry.safe === 'check-first') next = 'Comprueba el estado en Kraken antes de repetir.';
      else next = 'Reintenta en unos segundos.';
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
      pair: pair || undefined,
      traceId: res.traceId || undefined,
    });
  }

  /** When the explaining itself fails, Muse still gets Kraken's answer and a safe reading of it. */
  function fallbackProxy({ kind, method, ids, changes, res }) {
    const result = res.json && res.json.result;
    const txids = [];
    if (result && Array.isArray(result.txid)) txids.push(...result.txid.map(String));
    if (result && Array.isArray(result.orders)) for (const it of result.orders) if (it && it.txid) txids.push(String(it.txid));
    const placed = txids.length > 0;
    return build({
      ok: false,
      method,
      summary: placed ? `Kraken creó la orden (${txids.join(', ')}), pero el proxy no pudo preparar el resto del informe.` : 'El proxy no pudo interpretar la respuesta de Kraken.',
      executed: kind === 'read' ? undefined : placed ? 'yes' : 'unknown',
      where: 'proxy',
      retry: { automaticRetries: Math.max(0, (res.attempts || []).length - 1), safeToRetry: kind === 'read' ? 'yes' : placed ? 'no' : 'check-first' },
      next: kind === 'read' ? 'Reintenta en unos segundos.' : placed ? 'NO la reenvíes: síguela con QueryOrders (txid).' : 'Comprueba en Kraken (OpenOrders / ClosedOrders) antes de repetir nada.',
      changes,
      orders: ids.length ? ids.map((t) => t.ref) : undefined,
    });
  }

  /**
   * Runs the call. Returns { status, text } (raw passthrough), { status, body, proxy }, or
   * { cancelled: true } when Muse hung up before it was sent.
   */
  async function run({ method, readOnly, params, changes = [], ids = [], isCancelled }) {
    const kind = policyFor(method, readOnly);
    const submittedAt = now();
    const deadline = submittedAt + totalMs[kind];
    const validateOnly = (method === 'AddOrder' || method === 'AddOrderBatch') && params.validate !== undefined;
    const res = await client.privateCall(method, params, { policy: kind, isCancelled, deadlineAt: kind === 'create' ? deadline - lookupReserveMs : deadline });
    if (res.error === 'cancelled') return { cancelled: true, res };
    const success = okJson(res);
    if (success && kind === 'read') return { status: res.status, text: res.text, res };

    let proxy;
    try {
      const ctx = { kind, method, params, ids, changes, res, submittedAt, deadline, validateOnly };
      proxy = success ? await describeSuccess(ctx) : null;
      if (!proxy) proxy = await describeFailure({ ...ctx, reason: success ? 'no-txid' : undefined });
    } catch {
      proxy = fallbackProxy({ kind, method, ids, changes, res });
    }
    if (res.json) return { status: res.status, body: { ...res.json, proxy }, res, proxy };
    const status = res.error === 'timeout' ? 504 : ['busy', 'locked', 'expired'].includes(res.error) ? 503 : 502;
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
