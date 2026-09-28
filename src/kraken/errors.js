'use strict';

/**
 * Kraken's error strings, explained for Muse. Built from Kraken's error guide, its support
 * articles and the OpenAPI spec (research notes in the README).
 *
 *   kind      how the proxy may react (see client.js): nonce | rate | throttled | orderRate |
 *             transient | lockout | final
 *   executed  for a trading call that got this error: 'no' (Kraken rejected it before it could
 *             run) or 'maybe' (ambiguous: the proxy checks what really happened)
 *   es        what happened, in Spanish
 *   next      what to do, in Spanish
 */
const CATALOG = [
  // Authentication and limits: checked before anything runs.
  { code: 'EAPI:Invalid key', kind: 'final', executed: 'no', es: 'Kraken no reconoce la API key del servidor (mal copiada, borrada o caducada).', next: 'No reintentes. Avisa al operador: hay que revisar KRAKEN_API_KEY en Vercel.' },
  { code: 'EAPI:Invalid signature', kind: 'final', executed: 'no', es: 'La firma no coincide: la private key del servidor no corresponde a la API key.', next: 'No reintentes. Avisa al operador: hay que revisar KRAKEN_API_SECRET en Vercel.' },
  { code: 'EAPI:Invalid nonce', kind: 'nonce', executed: 'no', es: 'Kraken rechazó la llamada por el nonce (llegó desordenada respecto a otra). No se ejecutó nada.', next: 'Espera 2 s y reintenta una vez. Si se repite, avisa al operador (conviene una API key con nonce window).' },
  { code: 'EAPI:Bad request', kind: 'final', executed: 'no', es: 'Kraken no entendió la petición (cuerpo mal formado).', next: 'Revisa los parámetros; si parecen correctos, avisa al operador.' },
  { code: 'EAPI:Rate limit exceeded', kind: 'rate', executed: 'no', es: 'Se superó el límite de llamadas de Kraken para esta API key. No se ejecutó nada.', next: 'Espera el tiempo indicado en retryAfterSeconds y reintenta. Espacia las llamadas (una a la vez, ~1-2 s entre ellas).' },
  { code: 'EAPI:Feature disabled', kind: 'final', executed: 'no', es: 'Kraken tiene desactivada esa función o parámetro.', next: 'No reintentes. Prueba sin ese parámetro o avisa al operador.' },
  { code: 'EService:Throttled', kind: 'throttled', executed: 'no', es: 'Kraken frenó la llamada por demasiadas peticiones simultáneas. No se ejecutó nada.', next: 'Espera retryAfterSeconds y reintenta, sin llamadas en paralelo.' },
  { code: 'EGeneral:Too many requests', kind: 'rate', executed: 'no', es: 'Demasiadas peticiones seguidas a Kraken. No se ejecutó nada.', next: 'Espera unos 5 s y reintenta.' },
  { code: 'EAuth:Rate limit exceeded', kind: 'rate', executed: 'no', es: 'Demasiados intentos de autenticación seguidos.', next: 'Espera 30 s y reintenta.' },
  { code: 'EAuth:Too many requests', kind: 'rate', executed: 'no', es: 'Demasiados intentos de autenticación seguidos.', next: 'Espera 30 s y reintenta.' },
  { code: 'EGeneral:Permission denied', kind: 'final', executed: 'no', es: 'La API key de Kraken no tiene el permiso que necesita esta operación.', next: 'No reintentes. Avisa al operador para que active el permiso en Kraken → Settings → API (AddOrderBatch necesita también «Cancel & Close Orders»).' },
  { code: 'EGeneral:Temporary lockout', kind: 'lockout', executed: 'no', es: 'Kraken bloqueó temporalmente la API key (unos 15 minutos) por demasiados errores seguidos.', next: 'No llames a Kraken durante 15 minutos: cada intento reinicia el bloqueo. El proxy pausa las llamadas solo.' },
  { code: 'EGeneral:Unknown method', kind: 'final', executed: 'no', es: 'Kraken no conoce ese método.', next: 'Revisa el nombre del método (mayúsculas incluidas).' },
  { code: 'EAccount:Invalid permissions', kind: 'final', executed: 'no', es: 'La cuenta de Kraken no tiene permitida esta operación (nivel de verificación o país).', next: 'No reintentes. Avisa al operador.' },
  { code: 'EAuth:Account temporary disabled', kind: 'final', executed: 'no', es: 'La cuenta de Kraken está suspendida temporalmente.', next: 'No reintentes. Avisa al operador: debe contactar con Kraken.' },
  { code: 'EAuth:Account unconfirmed', kind: 'final', executed: 'no', es: 'La cuenta de Kraken no tiene el email verificado.', next: 'No reintentes. Avisa al operador.' },
  { code: 'ETrade:Locked', kind: 'final', executed: 'no', es: 'Kraken bloqueó la cuenta por seguridad.', next: 'No reintentes. Avisa al operador de inmediato: debe contactar con Kraken.' },
  { code: 'ETrade:User Locked', kind: 'final', executed: 'no', es: 'Kraken bloqueó la cuenta por seguridad.', next: 'No reintentes. Avisa al operador de inmediato: debe contactar con Kraken.' },
  { code: 'ETrade:Invalid request', kind: 'final', executed: 'no', es: 'La petición de trading está mal formada (faltan campos o tienen un tipo incorrecto).', next: 'Revisa los parámetros de la orden.' },

  // Validation of the request.
  { code: 'EGeneral:Invalid arguments:Index unavailable', kind: 'final', executed: 'no', es: 'Este par no tiene precio índice para disparar la orden.', next: 'Usa trigger=last.' },
  { code: 'EGeneral:Invalid arguments:volume', kind: 'final', executed: 'no', es: 'El volumen no es válido: demasiados decimales para el par o por debajo del mínimo.', next: 'Ajusta el volumen a los decimales y al mínimo del par (ver pair).' },
  { code: 'EGeneral:Invalid arguments:price', kind: 'final', executed: 'no', es: 'El precio no es válido (formato o decimales).', next: 'Ajusta el precio a los decimales del par (ver pair).' },
  { code: 'EGeneral:Invalid arguments', kind: 'final', executed: 'no', es: 'Faltan parámetros obligatorios o alguno tiene un valor no válido (el detalle tras los dos puntos dice cuál).', next: 'Corrige el parámetro indicado y vuelve a enviar.' },
  { code: 'EQuery:Unknown asset pair', kind: 'final', executed: 'no', es: 'Kraken no conoce ese par.', next: 'Usa el nombre del par de Kraken (p. ej. XBTUSD o XXBTZUSD).' },
  { code: 'EQuery:Invalid asset pair', kind: 'final', executed: 'no', es: 'Kraken no conoce ese par.', next: 'Usa el nombre del par de Kraken (p. ej. XBTUSD o XXBTZUSD).' },
  { code: 'EQuery:Unknown asset', kind: 'final', executed: 'no', es: 'Kraken no conoce ese activo.', next: 'Usa el código de Kraken (p. ej. XBT, XXBT, ZUSD).' },

  // Orders rejected by the trading engine.
  { code: 'EOrder:Insufficient funds', kind: 'final', executed: 'no', es: 'No hay saldo disponible suficiente (contando comisiones y lo retenido por otras órdenes). La orden NO se creó.', next: 'Consulta Balance y reduce el volumen, o cancela otras órdenes que retienen saldo.' },
  { code: 'EOrder:Order minimum not met', kind: 'final', executed: 'no', es: 'El volumen está por debajo del mínimo del par. La orden NO se creó.', next: 'Sube el volumen al mínimo del par (ver pair.ordermin).' },
  { code: 'EOrder:Cost minimum not met', kind: 'final', executed: 'no', es: 'El importe total (precio × volumen) está por debajo del mínimo del par. La orden NO se creó.', next: 'Sube el volumen o el importe (ver pair.costmin).' },
  { code: 'EOrder:Tick size check failed', kind: 'final', executed: 'no', es: 'El precio no es múltiplo del salto mínimo de precio del par. La orden NO se creó.', next: 'Redondea el precio al tick del par (ver pair.tick_size).' },
  { code: 'EOrder:Invalid price', kind: 'final', executed: 'no', es: 'El precio no es válido (cero, negativo o con demasiados decimales). La orden NO se creó.', next: 'Corrige el precio (las órdenes market no llevan precio).' },
  { code: 'EOrder:Rate limit exceeded', kind: 'orderRate', executed: 'no', es: 'Se superó el límite de órdenes por segundo en este par. La orden NO se creó.', next: 'Espera unos segundos y reenvía (mejor modificar con AmendOrder que cancelar y volver a crear).' },
  { code: 'EOrder:Domain rate limit exceeded', kind: 'orderRate', executed: 'no', es: 'Se superó el límite de órdenes de la cuenta (con subcuentas). La orden NO se creó.', next: 'Espera unos segundos y reenvía.' },
  { code: 'EOrder:Orders limit exceeded', kind: 'final', executed: 'no', es: 'Hay demasiadas órdenes abiertas en este par. La orden NO se creó.', next: 'Cancela alguna orden abierta antes de crear otra.' },
  { code: 'EOrder:Scheduled orders limit exceeded', kind: 'final', executed: 'no', es: 'Hay demasiadas órdenes programadas o de disparo abiertas. La orden NO se creó.', next: 'Cancela alguna orden stop/take-profit antes de crear otra.' },
  { code: 'EOrder:Positions limit exceeded', kind: 'final', executed: 'no', es: 'Se alcanzó el máximo de posiciones con margen. La orden NO se creó.', next: 'Cierra alguna posición antes.' },
  { code: 'EOrder:Unknown position', kind: 'final', executed: 'no', es: 'La posición indicada no existe.', next: 'Revisa OpenPositions.' },
  { code: 'EOrder:Reduce only:No position exists', kind: 'final', executed: 'no', es: 'Orden reduce-only sin posición que reducir. La orden NO se creó.', next: 'Quita reduce_only o revisa OpenPositions.' },
  { code: 'EOrder:Reduce only:Position is closed', kind: 'final', executed: 'maybe', es: 'La orden reduce-only habría invertido la posición: se ejecutó lo posible y el resto se canceló.', next: 'Consulta la orden (QueryOrders) para ver cuánto se ejecutó (vol_exec).' },
  { code: 'EOrder:Reduce only:Non-PC', kind: 'final', executed: 'no', es: 'Operación con margen no permitida para esta cuenta o par. La orden NO se creó.', next: 'No reintentes; avisa al operador.' },
  { code: 'EOrder:Reduce only:Non-ECP', kind: 'final', executed: 'no', es: 'Cuenta de EE. UU.: el apalancamiento requiere el par con sufijo :BTNL. La orden NO se creó.', next: 'Usa el par correcto o quita el apalancamiento.' },
  { code: 'EOrder:Cannot open opposing position', kind: 'final', executed: 'no', es: 'No se puede abrir una posición contraria a otra abierta en el mismo par. La orden NO se creó.', next: 'Cierra la posición existente antes.' },
  { code: 'EOrder:Cannot open position', kind: 'final', executed: 'no', es: 'No se puede abrir una posición con margen ahora mismo (cuenta, país o margen suspendido). La orden NO se creó.', next: 'Opera sin apalancamiento o avisa al operador.' },
  { code: 'EOrder:Margin allowance exceeded', kind: 'final', executed: 'no', es: 'Se superaría el margen permitido para la cuenta. La orden NO se creó.', next: 'Reduce el tamaño o el apalancamiento.' },
  { code: 'EOrder:Margin level too low', kind: 'final', executed: 'no', es: 'No hay colateral suficiente para esa posición. La orden NO se creó.', next: 'Reduce el tamaño o el apalancamiento.' },
  { code: 'EOrder:Margin position size exceeded', kind: 'final', executed: 'no', es: 'Se superaría el tamaño máximo de posición con margen del par. La orden NO se creó.', next: 'Reduce el tamaño.' },
  { code: 'EOrder:Insufficient initial margin', kind: 'final', executed: 'no', es: 'No hay margen libre suficiente. La orden NO se creó.', next: 'Reduce el tamaño o el apalancamiento.' },
  { code: 'EOrder:Insufficient margin', kind: 'final', executed: 'no', es: 'Kraken no tiene margen disponible para ese activo en este momento. La orden NO se creó.', next: 'Reintenta en unos minutos o sin apalancamiento.' },
  { code: 'EOrder:Order not editable', kind: 'final', executed: 'no', es: 'No se pudo modificar la orden; sigue como estaba.', next: 'Consulta la orden (QueryOrders) antes de decidir.' },
  { code: 'EOrder:Not enough leaves qty', kind: 'final', executed: 'no', es: 'El nuevo volumen es menor que lo ya ejecutado; no se modificó.', next: 'Usa un volumen mayor que lo ejecutado.' },
  { code: 'EOrder:Unknown order', kind: 'final', executed: 'no', es: 'Esa orden no está abierta: puede que ya se ejecutara, se cancelara, caducara o que el ID sea incorrecto.', next: 'Mira proxy.order: el proxy consultó su estado real cuando pudo.' },
  { code: 'EOrder:Cancel pending', kind: 'final', executed: 'maybe', es: 'Ya hay una cancelación en curso para esa orden.', next: 'Espera unos segundos y consulta la orden (QueryOrders).' },
  { code: 'EOrder:Invalid order', kind: 'final', executed: 'no', es: 'Kraken consideró la orden no válida. La orden NO se creó.', next: 'Revisa los parámetros de la orden.' },
  { code: 'EOrder:Trading agreement required', kind: 'final', executed: 'no', es: 'Kraken exige aceptar un acuerdo de trading para esta orden.', next: 'Avisa al operador.' },
  { code: 'EBM:limit exceeded:CAL', kind: 'final', executed: 'no', es: 'Se superó el límite de compra canadiense para esta cripto. La orden NO se creó.', next: 'Avisa al operador.' },
  { code: 'EService:Market in cancel_only mode', kind: 'final', executed: 'no', es: 'Este mercado está en modo «solo cancelar»: no admite órdenes nuevas. La orden NO se creó.', next: 'Espera a que el par vuelva a estar online (ver pair.status).' },
  { code: 'EService:Market in post_only mode', kind: 'final', executed: 'no', es: 'Este mercado solo admite órdenes limit post-only ahora. La orden NO se creó.', next: 'Espera, o usa una orden limit con oflags=post si encaja con lo que quieres.' },
  { code: 'EService:Market in limit_only mode', kind: 'final', executed: 'no', es: 'Este mercado solo admite órdenes limit ahora. La orden NO se creó.', next: 'Espera, o usa una orden limit si encaja con lo que quieres.' },
  { code: 'EService:Market in', prefix: true, kind: 'final', executed: 'no', es: 'Este mercado está en un modo restringido y no admite esta orden. La orden NO se creó.', next: 'Espera a que el par vuelva a estar online (ver pair.status).' },
  { code: 'EFunding:Too many addresses', kind: 'final', executed: 'no', es: 'Se alcanzó el máximo de direcciones de depósito.', next: 'Usa una dirección existente.' },
  { code: 'EFunding:', prefix: true, kind: 'final', executed: 'no', es: 'Kraken rechazó la consulta de fondos (método o activo no válido).', next: 'Revisa asset y method (DepositMethods muestra los válidos).' },

  // Kraken-side trouble: ambiguous for orders.
  { code: 'EService:Unavailable', kind: 'transient', executed: 'maybe', es: 'El motor de Kraken o su API no están disponibles (mantenimiento o caída).', next: 'Mira proxy.krakenStatus; reintenta más tarde.' },
  { code: 'EService:Busy', kind: 'transient', executed: 'maybe', es: 'Kraken está sobrecargado en este momento.', next: 'Reintenta en unos segundos.' },
  { code: 'EService:Deadline elapsed', kind: 'transient', executed: 'maybe', es: 'Kraken no procesó la petición a tiempo (carga alta).', next: 'Reintenta en unos segundos.' },
  { code: 'EGeneral:Internal error', kind: 'transient', executed: 'maybe', es: 'Error interno de Kraken.', next: 'Reintenta en unos segundos.' },
  { code: 'EDatabase:Internal error', kind: 'transient', executed: 'maybe', es: 'Error interno de la base de datos de Kraken.', next: 'Reintenta en unos segundos.' },
];

const UNKNOWN = { code: null, kind: 'final', executed: 'maybe', es: 'Kraken devolvió un error que el proxy no tiene catalogado.', next: 'Lee el texto original de Kraken (krakenError). Si era una orden, mira proxy.executed.' };

// Longest codes first, so "EGeneral:Invalid arguments:volume" wins over "EGeneral:Invalid arguments".
const normalize = (s) => String(s).replace(/\s*:\s*/g, ':').trim().toLowerCase();
const INDEX = CATALOG.map((entry) => ({ entry, key: normalize(entry.code) })).sort((a, b) => b.key.length - a.key.length);

/**
 * Explains one entry of Kraken's `error` array. Spaces around ':' and case are ignored
 * ("EService: Throttled: 1741500000" and "EGeneral:Unknown Method" both match); whatever
 * follows the known code is kept as `detail`.
 */
function lookupError(raw) {
  const text = String(raw);
  const key = normalize(text);
  // Exact code, or the code followed by ":detail"; `prefix` entries match any continuation.
  const hit = INDEX.find((i) => key === i.key || key.startsWith(`${i.key}:`) || (i.entry.prefix && key.startsWith(i.key)));
  if (!hit) return { ...UNKNOWN, raw: text, detail: null };
  const rest = key.slice(hit.key.length).replace(/^:/, '');
  const original = text.replace(/\s*:\s*/g, ':').trim();
  const detail = rest ? original.slice(original.length - rest.length).trim() : null;
  const { prefix, ...entry } = hit.entry;
  return { ...entry, raw: text, detail };
}

/** Kraken puts warnings ("W...") in the same array: only "E..." entries are errors. */
function errorsOf(json) {
  const list = json && Array.isArray(json.error) ? json.error.map(String) : [];
  return list.filter((e) => /^E/.test(e.trim()));
}

/** Seconds until the timestamp in "EService:Throttled:<ts>" (seconds or ms), or null. */
function throttledWaitSeconds(raw, nowMs) {
  const m = /throttled\s*:\s*(\d{9,})/i.exec(String(raw));
  if (!m) return null;
  let ts = Number(m[1]);
  if (ts < 1e12) ts *= 1000;
  return Math.max(0, (ts - nowMs) / 1000);
}

module.exports = { CATALOG, lookupError, errorsOf, throttledWaitSeconds };
