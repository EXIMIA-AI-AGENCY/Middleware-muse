'use strict';

/**
 * The `proxy` object added to every Stripe error and to every answer of the proxy itself:
 * what happened, whether anything was done, and what Muse should do next, in plain Spanish.
 *
 *   summary        what happened (tell the user in these words when something failed)
 *   executed       "yes" | "no" | "unknown" for writes; absent for reads
 *   safe_to_retry  "yes" | "no" | "after-wait" | "same-key" (repeat with the same Idempotency-Key)
 *   next           what to do now
 */

const WRITE = new Set(['POST', 'DELETE']);

function stripeError(body) {
  const error = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : {};
  const text = (value) => (typeof value === 'string' ? value.slice(0, 300) : null);
  return { type: text(error.type), code: text(error.code), message: text(error.message), param: text(error.param), decline: text(error.decline_code) };
}

/**
 * For an error answered by Stripe (status >= 400). `maybeRan`: an earlier attempt of this
 * same call (retried by the proxy) may already have acted, so a later error is not proof
 * that nothing happened.
 */
function explainStripeError({ method, status, headers, body, idempotencyKey, attempts, maybeRan = false }) {
  const e = stripeError(body);
  const write = WRITE.has(method);
  const detail = e.message ? `: ${e.message}` : '.';
  const base = { http_status: status, stripe_code: e.code || undefined, attempts, idempotency_key: idempotencyKey || undefined };
  if (headers['idempotent-replayed'] === 'true') base.replayed = true;
  const out = (summary, executed, safe, next) => ({ ...base, summary, ...(write ? { executed } : {}), safe_to_retry: safe, next });

  // Without an Idempotency-Key (v1 DELETE) a retried call answers for itself only: the lost
  // first attempt may be the one that acted (e.g. deleted, so the retry gets 404).
  if (write && maybeRan && !idempotencyKey && status < 500) {
    return out(
      `Un intento anterior no recibió respuesta y pudo haberse hecho; el siguiente respondió${detail}`,
      'unknown',
      'no',
      status === 404 ? 'Lo más probable es que ya esté hecho (Stripe dice que ya no existe). Compruébalo leyendo el objeto antes de hacer nada más.' : 'Comprueba en Stripe si ya se hizo antes de repetir.',
    );
  }

  if (e.code === 'approval_required') {
    return out(`Stripe dejó esta acción pendiente de aprobación por el dueño${detail}`, 'no', 'no', 'Dile al usuario que la apruebe en el Dashboard de Stripe (caduca en 14 días). No la repitas: al aprobarse se hace sola.');
  }
  if (e.code === 'action_blocked') {
    return out(`Una regla de aprobación de Stripe bloquea esta acción${detail}`, 'no', 'no', 'No la repitas. Solo el dueño puede cambiar esa regla en Stripe.');
  }
  if (status === 401) {
    return out(`Stripe no acepta la clave del servidor${detail}`, 'no', 'no', 'No reintentes. Avisa al usuario: hay que poner una clave de Stripe válida en el servidor.');
  }
  if (status === 403) {
    return out(`A la clave de Stripe le falta un permiso para esto${detail}`, 'no', 'no', 'No reintentes. Dile al usuario qué permiso añadir a la clave restringida en Stripe (el mensaje lo nombra).');
  }
  if (status === 402 || e.type === 'card_error') {
    const why = e.decline ? ` (${e.decline})` : '';
    return out(`El pago fue rechazado${why}${detail} No se cobró nada.`, 'no', 'no', 'No repitas el mismo cobro. Pide al cliente otro método de pago o que contacte a su banco.');
  }
  if (status === 404) {
    return out(`No existe en Stripe${detail} Revisa el ID y el modo (live o test).`, 'no', 'no', 'Corrige el ID antes de volver a intentarlo.');
  }
  if (e.type === 'idempotency_error') {
    return out(
      `Ese Idempotency-Key ya se usó con otros parámetros o en otra ruta${detail} La petición original con esa clave ya se procesó.`,
      'unknown',
      'no',
      'Comprueba en Stripe qué hizo la petición original antes de mandar nada. Solo si de verdad es una acción NUEVA, mándala con un Idempotency-Key nuevo.',
    );
  }
  if (status === 409) {
    return out(
      `Otra petición con el mismo Idempotency-Key sigue en curso en Stripe${detail}`,
      'unknown',
      'same-key',
      `Espera unos segundos y repite exactamente la misma petición con el MISMO Idempotency-Key (${idempotencyKey}): Stripe devolverá su resultado sin hacerla dos veces.`,
    );
  }
  if (status === 429) {
    const reason = headers['stripe-rate-limited-reason'];
    return out(`Stripe está limitando las llamadas${reason ? ` (${reason})` : ''}${detail}`, 'no', 'after-wait', 'Espera unos segundos y repite, más despacio (una llamada a la vez).');
  }
  if (status >= 500) {
    if (write && !idempotencyKey) {
      return out(`Stripe tuvo un error interno${detail} No se sabe si se hizo.`, 'unknown', 'yes', 'Repite la misma petición: borrar dos veces no hace nada más (si ya se hizo, Stripe dirá que no existe).');
    }
    return write
      ? out(`Stripe tuvo un error interno${detail} No se sabe si la acción se hizo.`, 'unknown', 'same-key', `Antes de repetir, comprueba en Stripe si se hizo (por ejemplo, lista los objetos recientes). Si repites, usa exactamente el mismo cuerpo y el mismo Idempotency-Key (${idempotencyKey}): Stripe no la hará dos veces.`)
      : out(`Stripe tuvo un error interno${detail}`, undefined, 'after-wait', 'Espera un momento y vuelve a pedirlo.');
  }
  const param = e.param ? ` (parámetro «${e.param}»)` : '';
  return out(`Stripe rechazó la petición${param}${detail}`, 'no', 'no', 'Corrige la petición y reenvíala con un Idempotency-Key NUEVO: Stripe recuerda el resultado de cada Idempotency-Key 24 h.');
}

/** For a request that got no answer from Stripe at all. */
function explainNoAnswer({ method, sent, timedOut, idempotencyKey, attempts }) {
  const write = WRITE.has(method);
  const what = timedOut ? 'Stripe no respondió a tiempo' : 'No hubo respuesta de Stripe (fallo de red)';
  if (!write) {
    return { summary: `${what}.`, safe_to_retry: 'yes', attempts, next: 'Vuelve a pedirlo en unos segundos.' };
  }
  if (sent && !idempotencyKey) {
    return { summary: `${what}. No se sabe si Stripe la hizo.`, executed: 'unknown', safe_to_retry: 'yes', attempts, next: 'Repite la misma petición: borrar dos veces no hace nada más (si ya se hizo, Stripe dirá que no existe).' };
  }
  if (!sent) {
    return { summary: `${what}. La petición no llegó a Stripe: no se hizo nada.`, executed: 'no', safe_to_retry: 'yes', attempts, idempotency_key: idempotencyKey, next: 'Puedes repetirla.' };
  }
  return {
    summary: `${what}. No se sabe si Stripe la hizo.`,
    executed: 'unknown',
    safe_to_retry: 'same-key',
    attempts,
    idempotency_key: idempotencyKey,
    next: `Repite exactamente la misma petición con el header Idempotency-Key: ${idempotencyKey}. Si Stripe ya la hizo, devolverá el mismo resultado sin repetirla (header Idempotent-Replayed: true).`,
  };
}

module.exports = { explainStripeError, explainNoAnswer };
