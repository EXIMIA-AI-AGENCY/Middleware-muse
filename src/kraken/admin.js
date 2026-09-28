'use strict';

const { sendJson } = require('../http-util');
const { READ_ONLY, TRADING, NEVER, allowedMethods } = require('./methods');
const { selfTest } = require('./sign');

// Kraken key permissions (ids from GetApiKeyInfo). `need` = what Muse's read-only methods use.
const PERMISSIONS = [
  { id: 'query-funds', label: 'Consultar fondos', need: 'Balance, TradeVolume, depósitos' },
  { id: 'query-open-trades', label: 'Consultar órdenes y operaciones abiertas', need: 'OpenOrders, TradeBalance, OpenPositions' },
  { id: 'query-closed-trades', label: 'Consultar órdenes y operaciones cerradas', need: 'ClosedOrders, TradesHistory, QueryTrades' },
  { id: 'query-ledger', label: 'Consultar movimientos (ledger)', need: 'Ledgers, QueryLedgers' },
  { id: 'withdraw-funds', label: 'Retirar fondos', danger: true },
  { id: 'add-withdraw-address', label: 'Añadir direcciones de retiro', danger: true },
  { id: 'update-withdraw-address', label: 'Cambiar direcciones de retiro', danger: true },
  { id: 'earn-funds', label: 'Earn (mover fondos a staking)', risky: true },
  { id: 'modify-trades', label: 'Crear y modificar órdenes', trading: true },
  { id: 'close-trades', label: 'Cancelar y cerrar órdenes', trading: true },
  { id: 'add-funds', label: 'Depositar', extra: 'Solo hace falta para DepositMethods.' },
  { id: 'export-data', label: 'Exportar datos', extra: 'No lo usa Muse.' },
  { id: 'create-ws-token', label: 'WebSockets', extra: 'Solo hace falta para GetWebSocketsToken.' },
];

const ADVICE = {
  'EAPI:Invalid key': 'Kraken no reconoce KRAKEN_API_KEY. Cópiala de nuevo en Vercel (sin espacios) y haz Redeploy.',
  'EAPI:Invalid signature': 'KRAKEN_API_SECRET no corresponde a esa API key. Copia la private key completa en Vercel y haz Redeploy.',
  'EAPI:Invalid nonce': 'Kraken rechazó el nonce. Si esta llave se usó en otra app o bot, crea una llave nueva solo para Muse (con nonce window 10000).',
  'EGeneral:Permission denied': 'A la llave de Kraken le falta el permiso para esta consulta.',
  'EGeneral:Temporary lockout': 'Kraken bloqueó la llave unos 15 minutos por errores repetidos. Espera y vuelve a verificar.',
  'EAPI:Rate limit exceeded': 'Se alcanzó el límite de llamadas de Kraken. Espera un minuto y vuelve a verificar.',
};

const advice = (error) => ADVICE[error] || `Kraken respondió: ${String(error).slice(0, 160)}`;
const firstError = (json) => (json && Array.isArray(json.error) && json.error.length ? String(json.error[0]) : null);
const round1 = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : null);

function connectionInfo(config, host, version) {
  const h = host ?? 'PENDIENTE';
  return {
    kraken_host: h,
    auth_placement: 'header:X-Proxy-Key',
    endpoint: `POST https://${h}/api/kraken`,
    body: '{"method": "<Metodo>", "params": {...}}',
    health_url: `https://${h}/api/kraken?health=1`,
    mode: config.trading ? 'trading-enabled' : 'read-only',
    version,
  };
}

/** Ready-to-paste instructions for Muse. No secrets: the key goes through Muse's secure card. */
function museMessage(info, config) {
  const host = info.kraken_host;
  const url = `https://${host}/api/kraken`;
  const trading = config.trading
    ? `\n### Trading (ACTIVADO en el servidor)\n\n${TRADING.map((m) => `- \`${m}\``).join('\n')}\n\nNunca crees, modifiques ni canceles órdenes sin mi confirmación explícita en el chat, orden por orden.\n`
    : '\nEl trading está DESACTIVADO: AddOrder, CancelOrder y demás devuelven 403. No lo intentes.\n';
  return `# Conectar Kraken a través del proxy (${config.trading ? 'con trading' : 'solo lectura'})

Hola Muse. Vamos a conectar mi cuenta de Kraken a través de nuestro proxy. El proxy guarda mis claves de Kraken y firma cada llamada; tú solo usas una llave del proxy. Este mensaje no contiene secretos: la llave te la daré por tu tarjeta segura de credenciales, nunca por el chat.

Importante: es una llave DISTINTA de la de GoHighLevel y va en otro conector. No toques el conector de GoHighLevel.

## Datos de conexión

\`\`\`yaml
${Object.entries(info).map(([k, v]) => `${k}: ${v}`).join('\n')}
\`\`\`

## Qué hacer

1. Registra el conector \`custom.kraken-proxy\` con \`api_hosts=["${host}"]\` usando tu flujo seguro de credenciales. Pídeme la llave de Kraken en la tarjeta segura. Guárdala como secreto y envíala SIEMPRE en el header \`X-Proxy-Key\`. Nunca la muestres ni la escribas en el chat, en logs ni en archivos.
2. Crea la skill \`~/workspace/skills/kraken/\` con un cliente \`bin/kraken-proxy\`. Cada llamada es \`POST ${url}\` con \`Content-Type: application/json\` y el cuerpo \`{"method": "<Método>", "params": {...}}\`. No envíes API-Key, API-Sign ni nonce: el proxy los pone.
3. Verifica, en este orden:
   a. \`GET ${info.health_url}\` → \`{"ok": true}\`
   b. \`POST ${url}\` con \`{"method": "Balance"}\` → HTTP 200 y \`"error": []\`.
   c. \`POST ${url}\` con \`{"method": "Withdraw"}\` → HTTP 403. Así debe ser: los retiros están bloqueados siempre.
4. Confírmame en una línea que quedó conectado.

## Métodos disponibles

${READ_ONLY.map((m) => `- \`${m}\``).join('\n')}
${trading}
Nunca disponibles, en ninguna configuración: ${NEVER.map((m) => `\`${m}\``).join(', ')}.

## Reglas del API de Kraken

- La respuesta es el JSON de Kraken tal cual: \`{"error": [], "result": {...}}\`. Revisa SIEMPRE \`error\`: si no está vacío, la llamada falló aunque el HTTP sea 200.
- Los nombres de método son exactos, con mayúsculas (\`Balance\`, no \`balance\`).
- Envía los números como texto: \`"volume": "0.01"\`, \`"start": "1735689600"\`.
- Kraken usa sus propios códigos de activo: \`XXBT\` (bitcoin), \`XETH\`, \`ZUSD\`, \`ZEUR\`…
- ClosedOrders, TradesHistory y Ledgers devuelven hasta 50 resultados por llamada; usa \`ofs\` para pedir los siguientes.
- \`DepositAddresses\` solo lee direcciones existentes (\`new\` no está permitido).
- Límites: Kraken cuenta las llamadas por llave (unas 15 seguidas; Ledgers y TradesHistory cuentan más). Haz una llamada a la vez, con ~1 s entre llamadas. El proxy permite 60 por minuto.
- Precios y datos de mercado son públicos: usa \`https://api.kraken.com/0/public/Ticker?pair=XBTUSD\` directamente, sin el proxy ni la llave.

## Si algo falla

- 401 \`EProxy:Unauthorized\`: la llave falta o es incorrecta. Pídemela otra vez por la tarjeta segura.
- 403 \`EProxy:...\`: método no permitido. No insistas.
- 400 \`EProxy:...\`: el cuerpo no es válido; lee el mensaje.
- 429: espera lo que indique \`Retry-After\`.
- 502/504: Kraken no respondió; reintenta en un minuto.
- 503 \`EProxy:Kraken is not configured\`: faltan las claves en el servidor; avísame.
- \`EAPI:Invalid nonce\`: el proxy ya reintentó una vez. Espera 2 s y prueba una sola vez más; si se repite, avísame.
- \`EAPI:Rate limit exceeded\`: espera 60 s.
- \`EGeneral:Permission denied\`: a la llave de Kraken le falta ese permiso; avísame.
- \`EGeneral:Temporary lockout\`: espera 15 minutos antes de volver a llamar.
- \`EAPI:Invalid key\` o \`EAPI:Invalid signature\`: problema de claves en el servidor. Avísame y no reintentes.
`;
}

/** What GetApiKeyInfo says about the key, without its name-independent secrets (no IBAN, no key). */
function describeKey(info, config, nowMs) {
  const granted = new Set(Array.isArray(info.permissions) ? info.permissions : []);
  const permissions = [];
  for (const p of PERMISSIONS) {
    const has = granted.has(p.id);
    if (p.need) {
      permissions.push({ id: p.id, label: p.label, state: has ? 'ok' : 'warn', detail: has ? `Muse lo usa para ${p.need}.` : `Falta: Muse no podrá usar ${p.need}.` });
    } else if (has && p.danger) {
      permissions.push({ id: p.id, label: p.label, state: 'fail', detail: 'Quítalo en Kraken. El proxy nunca lo usa, pero la llave no debería tenerlo.' });
    } else if (has && p.risky) {
      permissions.push({ id: p.id, label: p.label, state: 'warn', detail: 'Mueve fondos entre billeteras. Muse no lo necesita: mejor quítalo.' });
    } else if (has && p.trading) {
      permissions.push(
        config.trading
          ? { id: p.id, label: p.label, state: 'ok', detail: 'Necesario porque el trading está activado.' }
          : { id: p.id, label: p.label, state: 'warn', detail: 'El proxy bloquea el trading, pero la llave podría operar. Mejor quítalo.' },
      );
    } else if (has) {
      permissions.push({ id: p.id, label: p.label, state: 'ok', detail: p.extra });
    }
  }
  const nonceWindow = Number(info.nonceWindow) || 0;
  const validUntil = Number(info.validUntil) || 0;
  const ipCount = Array.isArray(info.ipAllowlist) ? info.ipAllowlist.length : 0;
  const notes = [];
  notes.push(
    nonceWindow > 0
      ? { state: 'ok', label: 'Nonce window', detail: `${nonceWindow.toLocaleString('es')} (tolera llamadas que llegan en desorden).` }
      : { state: 'warn', label: 'Nonce window', detail: 'Sin nonce window (0). Si Muse hace llamadas seguidas alguna puede fallar con «Invalid nonce». Al crear la llave, pon 10000.' },
  );
  if (validUntil > 0) {
    const days = Math.floor((validUntil * 1000 - nowMs) / 86_400_000);
    notes.push({ state: days < 7 ? 'warn' : 'ok', label: 'Caduca', detail: `${new Date(validUntil * 1000).toISOString().slice(0, 10)} (${days} días).` });
  }
  if (ipCount > 0) {
    notes.push({ state: 'warn', label: 'Lista de IPs', detail: `La llave solo acepta ${ipCount} IP(s). Vercel no tiene IP fija, así que algunas llamadas podrían fallar.` });
  }
  return { name: typeof info.apiKeyName === 'string' ? info.apiKeyName.slice(0, 80) : null, permissions, notes };
}

function createKrakenChecks({ config, client, getSelfUrl, checkMarker, call, now = () => Date.now() }) {
  const mark = checkMarker ? { 'X-Admin-Check': checkMarker } : {};

  async function run() {
    const checks = [];
    const add = (id, label, status, detail, ms) => checks.push({ id, label, status, detail, ms: round1(ms) });
    let key = null;

    if (config.enabled) {
      add('config', 'Claves de Kraken en el servidor', 'ok', config.accessKeySource === 'env' ? 'Puestas. La llave de Muse viene de KRAKEN_PROXY_KEY.' : 'Puestas. La llave de Muse se genera a partir de ellas.');
    } else if (config.started) {
      add('config', 'Claves de Kraken en el servidor', 'fail', config.problems.join(' '));
    } else {
      add('config', 'Claves de Kraken en el servidor', 'warn', 'Aún no están puestas. Sigue la guía «Configurar Kraken».');
    }

    const signOk = selfTest();
    add('signature', 'Firma (ejemplo oficial de Kraken)', signOk ? 'ok' : 'fail', signOk ? 'PASS: la firma coincide exactamente con el ejemplo oficial.' : 'FAIL: la firma no coincide con el ejemplo oficial.');

    const time = await client.publicCall('Time');
    const timeOk = time.status === 200 && time.json && Array.isArray(time.json.error) && time.json.error.length === 0;
    add('reachable', 'Kraken responde', timeOk ? 'ok' : 'fail', timeOk ? 'api.kraken.com contesta desde el servidor.' : `Sin respuesta válida de Kraken (${time.status ? `HTTP ${time.status}` : time.error}).`, time.ms);

    if (config.enabled && timeOk) {
      const info = await client.privateCall('GetApiKeyInfo', {}, { retryInvalidNonce: true });
      const err = firstError(info.json);
      if (info.status === 200 && info.json && !err && info.json.result) {
        key = describeKey(info.json.result, config, now());
        add('keys', 'Claves válidas', 'ok', `Kraken las acepta${key.name ? ` · llave «${key.name}»` : ''}.`, info.ms);
      } else {
        add('keys', 'Claves válidas', 'fail', info.status ? advice(err || `HTTP ${info.status}`) : `No se pudo llamar a Kraken (${info.error}).`, info.ms);
      }

      const base = config.publicHost ? `https://${config.publicHost}` : getSelfUrl();
      if (!base) {
        add('proxy', 'Conexión de Muse', 'warn', 'El servidor aún no está escuchando.');
      } else {
        const post = (body, headers = {}) =>
          call(base, '/api/kraken', { method: 'POST', headers: { ...mark, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        const withKey = { 'X-Proxy-Key': config.accessKey };

        const noKey = await post({ method: 'Balance' });
        add('auth', 'Sin llave no entra nadie', noKey.status === 401 ? 'ok' : 'fail', noKey.status === 401 ? 'Una llamada sin la llave fue rechazada y no llegó a Kraken.' : `Una llamada sin la llave NO fue rechazada (HTTP ${noKey.status}).`, noKey.ms);

        const withdraw = await post({ method: 'Withdraw', params: {} }, withKey);
        add('withdraw', 'Retiros bloqueados', withdraw.status === 403 ? 'ok' : 'fail', withdraw.status === 403 ? 'Withdraw fue rechazado aun con la llave correcta.' : `Withdraw NO fue rechazado (HTTP ${withdraw.status}).`, withdraw.ms);

        const balance = await post({ method: 'Balance' }, withKey);
        let body = null;
        try {
          body = JSON.parse(balance.text);
        } catch {
          body = null;
        }
        const berr = firstError(body);
        if (balance.status === 200 && body && !berr) {
          const assets = body.result && typeof body.result === 'object' ? Object.keys(body.result).length : 0;
          add('proxy', 'Conexión de Muse (Balance)', 'ok', `Muse puede leer el saldo · ${assets} activo${assets === 1 ? '' : 's'} en la cuenta.`, balance.ms);
        } else if (berr === 'EGeneral:Permission denied') {
          add('proxy', 'Conexión de Muse (Balance)', 'warn', 'El proxy funciona, pero la llave no tiene el permiso «Consultar fondos».', balance.ms);
        } else {
          add('proxy', 'Conexión de Muse (Balance)', 'fail', berr ? advice(berr) : `La llamada de prueba falló (HTTP ${balance.status}).`, balance.ms);
        }
      }
    }

    add(
      'trading',
      'Modo',
      config.trading ? 'warn' : 'ok',
      config.trading ? 'Trading ACTIVADO (ENABLE_TRADING=true): Muse puede crear y cancelar órdenes.' : 'Solo lectura: Muse no puede comprar, vender ni retirar.',
    );

    const statuses = checks.map((c) => c.status);
    const overall = !config.enabled ? (config.started ? 'fail' : 'setup') : statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'ok';
    return { ranAt: new Date(now()).toISOString(), overall, checks, key };
  }

  let inflight = null;
  return () => {
    if (!inflight) inflight = run().finally(() => { inflight = null; });
    return inflight;
  };
}

/**
 * Adds the panel's Kraken endpoints to the admin router (same PIN session and CSRF rules).
 *   GET  /api/kraken/overview   state, allowed methods, Muse message, activity
 *   POST /api/kraken/checks     live checks
 *   POST /api/kraken/key        reveals the Kraken access key for Muse
 */
function mountKrakenAdmin(router, { config, client, metrics, logger, version, requireSession, sameOriginJson, publicHost, getSelfUrl, checkMarker, call }) {
  const runChecks = createKrakenChecks({ config, client, getSelfUrl, checkMarker, call });
  const hostFor = (req) => config.publicHost || publicHost(req);

  router.get('/api/kraken/overview', requireSession, (req, res) => {
    const info = connectionInfo(config, hostFor(req), version);
    sendJson(res, 200, {
      configured: config.enabled,
      started: config.started,
      problems: config.problems,
      trading: config.trading,
      methods: { readOnly: READ_ONLY, trading: TRADING, never: NEVER, allowed: allowedMethods(config) },
      connection: info,
      museMessage: config.enabled ? museMessage(info, config) : null,
      key: config.enabled ? { source: config.accessKeySource, length: config.accessKey.length, apiKeyHint: `…${config.apiKey.slice(-4)}` } : null,
      rateLimit: { max: config.rateLimitMax, windowSeconds: config.rateLimitWindowMs / 1000 },
      metrics: metrics.snapshot(),
    });
  });

  router.post('/api/kraken/checks', sameOriginJson, requireSession, async (req, res, next) => {
    try {
      sendJson(res, 200, await runChecks());
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/kraken/key', sameOriginJson, requireSession, (req, res) => {
    if (!config.enabled) return sendJson(res, 409, { error: 'not_configured' });
    logger.info({ msg: 'admin_kraken_key_revealed' });
    return sendJson(res, 200, { accessKey: config.accessKey });
  });
}

module.exports = { mountKrakenAdmin, museMessage, connectionInfo, describeKey, createKrakenChecks };
