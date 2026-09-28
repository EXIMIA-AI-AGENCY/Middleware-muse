'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const ICON = { ok: 'i-check', warn: 'i-warn', fail: 'i-x', pending: 'i-check', offline: 'i-x', info: 'i-info' };
  const STATE_WORD = { ok: 'Correcto', warn: 'Aviso', fail: 'Error', info: 'Información' };
  const REFRESH_MS = 15000;
  const KEY_VISIBLE_MS = 60000;
  const MASK = '••••••••••••••••••••••••••••••••';

  let refreshTimer = null;
  let keyTimer = null;
  let lockTimer = null;
  let lastChecks = null; // last successful checks result
  let lastOverviewOk = null; // Date of the last successful overview
  let offlineSince = null;
  let submitting = false;
  const VIEWS = ['ghl', 'agency', 'kraken', 'stripe'];
  let view = 'ghl'; // one of VIEWS
  let lastKrakenChecks = null;
  let krakenStarted = false; // first visit to the Kraken tab loads it
  let krakenTimer = null;
  let lastAgencyChecks = null;
  let agencyStarted = false; // first visit to the agency tab loads it
  let agencyTimer = null;
  let lastStripeChecks = null;
  let stripeStarted = false; // first visit to the Stripe tab loads it
  let stripeTimer = null;

  // ---------- helpers ----------

  /** Builds DOM nodes; text is always set via textContent (never innerHTML). */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${name}`);
    svg.append(use);
    return svg;
  }

  /** Icon plus the state spelled out for screen readers. */
  function stateIcon(state) {
    return el('span', { class: 'check-icon' }, icon(ICON[state]), el('span', { class: 'sr-only', text: STATE_WORD[state] || '' }));
  }

  class NetworkError extends Error {}

  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(`/admin/api${path}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
        body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
      });
    } catch {
      throw new NetworkError('network');
    }
    let data = null;
    if (res.status !== 204) {
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    }
    if (res.status === 401 && path !== '/login') {
      showLogin('Tu sesión expiró. Ingresa el PIN de nuevo.', true);
      throw new Error('unauthorized');
    }
    return { status: res.status, data };
  }

  let toastTimer = null;
  function toast(message, { error = false } = {}) {
    const node = $('toast');
    node.textContent = message;
    node.classList.toggle('is-error', error);
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.hidden = true;
    }, error ? 6000 : 2500);
  }

  async function copyText(text) {
    if (!navigator.clipboard || !window.isSecureContext) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  function selectNode(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  const fmtMs = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
  const fmtSmallMs = (v) => (v === null || v === undefined ? '—' : v < 1 ? '< 1 ms' : `${Math.round(v)} ms`);
  const fmtNum = (v) => Number(v || 0).toLocaleString('es');
  const fmtTime = (value) => new Date(value).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function ago(date) {
    const s = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (s < 10) return 'ahora mismo';
    if (s < 60) return `hace ${s} s`;
    const m = Math.round(s / 60);
    if (m < 60) return `hace ${m} min`;
    return `hace ${Math.round(m / 60)} h`;
  }

  function uptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d) return `${d} d ${h} h`;
    if (h) return `${h} h ${m} min`;
    return `${m} min`;
  }

  // ---------- login ----------

  function setLoginEnabled(enabled) {
    $('pin').disabled = !enabled;
    document.querySelectorAll('#login-form button').forEach((b) => (b.disabled = !enabled));
  }

  function showLogin(message = '', isInfo = false) {
    stopRefresh();
    hideKey();
    $('app').hidden = true;
    $('login').hidden = false;
    const msg = $('login-msg');
    msg.textContent = message;
    msg.classList.toggle('is-info', isInfo);
    $('lock-timer').textContent = '';
    const pin = $('pin');
    pin.value = '';
    if (!pin.disabled) pin.focus();
  }

  function lockCountdown(seconds) {
    const until = Date.now() + seconds * 1000;
    const msg = $('login-msg');
    const timer = $('lock-timer');
    msg.classList.remove('is-info');
    msg.textContent = 'Demasiados intentos. El acceso está bloqueado un momento.';
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        clearInterval(lockTimer);
        lockTimer = null;
        setLoginEnabled(true);
        msg.textContent = '';
        timer.textContent = '';
        $('pin').focus();
        return;
      }
      timer.textContent = `Podrás intentarlo de nuevo en ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    };
    clearInterval(lockTimer);
    setLoginEnabled(false);
    tick();
    lockTimer = setInterval(tick, 1000);
  }

  async function submitPin(event) {
    if (event) event.preventDefault();
    const pin = $('pin');
    if (submitting || !pin.value || pin.disabled) return;
    const value = pin.value;
    pin.value = ''; // cleared right away: a retry never appends to an old attempt
    submitting = true;
    setLoginEnabled(false);
    const msg = $('login-msg');
    msg.classList.add('is-info');
    msg.textContent = 'Comprobando…';
    let result = null;
    try {
      result = await api('/login', { method: 'POST', body: { pin: value } });
    } catch {
      result = null;
    } finally {
      submitting = false;
      setLoginEnabled(true);
    }
    msg.classList.remove('is-info');
    if (!result) {
      msg.textContent = 'No se pudo conectar con el proxy. Revisa tu conexión e intenta de nuevo.';
      pin.focus();
      return;
    }
    const { status, data } = result;
    if (status === 204) {
      msg.textContent = '';
      startApp();
    } else if (status === 429) {
      lockCountdown((data && data.retryAfterSeconds) || 30);
    } else if (status === 401) {
      const left = data && typeof data.attemptsLeft === 'number' ? data.attemptsLeft : null;
      msg.textContent =
        left !== null && left <= 3
          ? `PIN incorrecto. Antes del bloqueo te ${left === 1 ? 'queda 1 intento' : `quedan ${left} intentos`}.`
          : 'PIN incorrecto.';
      pin.focus();
    } else if (status === 403) {
      msg.textContent = 'El servidor rechazó el origen de la petición. Si usas un reverse proxy propio, debe reenviar el header Host.';
    } else {
      msg.textContent = 'No se pudo iniciar sesión. Intenta de nuevo.';
    }
  }

  function wireLogin() {
    // On touch screens the on-screen keypad replaces the system keyboard.
    if (window.matchMedia('(hover: none), (pointer: coarse)').matches) $('pin').setAttribute('inputmode', 'none');
    $('login-form').addEventListener('submit', submitPin);
    document.querySelectorAll('.keypad button[data-key]').forEach((button) => {
      button.addEventListener('click', () => {
        const pin = $('pin');
        if (pin.disabled) return;
        const key = button.dataset.key;
        if (key === 'back') pin.value = pin.value.slice(0, -1);
        else if (pin.value.length < 64) pin.value += key;
      });
    });
  }

  // ---------- status ----------

  const TITLES = { ok: 'Todo funciona', warn: 'Funciona, con avisos', fail: 'Hay un problema', offline: 'Sin conexión con el proxy' };
  const SUBS = {
    ok: 'GoHighLevel, el proxy y el MCP responden bien. Muse puede usarlo.',
    warn: 'Lo esencial funciona. Revisa los avisos de abajo.',
    fail: 'Revisa el punto en rojo. Muse no podrá usar el proxy hasta corregirlo.',
  };

  function renderStatus() {
    const badge = $('status-badge');
    if (offlineSince) {
      badge.dataset.state = 'fail';
      badge.replaceChildren(icon(ICON.offline));
      $('status-title').textContent = TITLES.offline;
      $('status-sub').textContent = `No responde desde las ${fmtTime(offlineSince)}. Si acabas de desplegar, espera un minuto.`;
      return;
    }
    if (!lastChecks) return;
    $('tab-ghl').querySelector('.switch-dot').dataset.state = lastChecks.overall;
    badge.dataset.state = lastChecks.overall;
    badge.replaceChildren(icon(ICON[lastChecks.overall]));
    $('status-title').textContent = TITLES[lastChecks.overall];
    $('status-sub').textContent = `${SUBS[lastChecks.overall]} Verificado ${ago(new Date(lastChecks.ranAt))}.`;
  }

  function renderChecks(result) {
    lastChecks = result;
    renderStatus();

    $('checks').replaceChildren(
      ...result.checks.map((c) =>
        el(
          'li',
          { class: 'check', 'data-state': c.status },
          stateIcon(c.status),
          el('div', {}, el('div', { class: 'check-label', text: c.label }), el('div', { class: 'check-detail', text: c.detail })),
          el('span', { class: 'check-ms', text: c.ms === null ? '' : fmtMs(c.ms) }),
        ),
      ),
    );

    $('permissions').replaceChildren(
      ...(result.permissions.length
        ? result.permissions.map((p) =>
            el(
              'li',
              { class: 'perm', 'data-ok': String(p.ok) },
              stateIcon(p.ok ? 'ok' : 'fail'),
              el('div', {}, el('div', { class: 'perm-name', text: p.label }), el('div', { class: 'perm-detail', text: p.detail })),
            ),
          )
        : [el('li', { class: 'perm-empty muted', text: 'Sin datos.' })]),
    );

    if (result.speed) {
      const s = result.speed;
      $('speed-own').textContent = s.proxyOwnMs === null ? '—' : fmtSmallMs(s.proxyOwnMs);
      $('speed-direct').textContent = fmtMs(s.directMs);
      $('speed-proxy').textContent = fmtMs(s.proxyMs);
      const diff = s.differenceMs;
      const within = Math.abs(diff) <= s.ghlSpreadMs;
      $('speed-note').textContent = within
        ? `Directo y por el proxy tardan lo mismo: la diferencia (${Math.round(diff)} ms) cabe en la variación normal de GoHighLevel (±${Math.round(s.ghlSpreadMs / 2)} ms).`
        : `Por el proxy tarda ${Math.round(diff)} ms más que directo. Casi todo es el viaje de red hasta el servidor del proxy, no el proxy en sí.`;
    }
  }

  async function runChecks() {
    const button = $('run-checks');
    button.disabled = true;
    button.textContent = 'Verificando…';
    $('status-badge').dataset.state = 'pending';
    try {
      const { status, data } = await api('/checks', { method: 'POST' });
      if (status === 200 && data) {
        offlineSince = null;
        renderChecks(data);
      } else {
        toast('No se pudo verificar. Intenta de nuevo.', { error: true });
      }
    } catch (err) {
      if (err instanceof NetworkError) {
        offlineSince = offlineSince || new Date();
        toast('No se pudo conectar con el proxy.', { error: true });
      }
    } finally {
      button.disabled = false;
      button.textContent = 'Verificar ahora';
      renderStatus();
      if (!lastChecks && !offlineSince) $('status-badge').dataset.state = 'pending';
      refresh();
    }
  }

  // ---------- overview ----------

  function renderOverview(o) {
    $('host-label').textContent = o.connection.middleware_host;
    $('connection').textContent = o.connectionMarkdown.replace(/^[\s\S]*?```yaml\n|```\s*$/g, '').trim();
    $('connection').dataset.markdown = o.connectionMarkdown;
    $('muse-message').textContent = o.museMessage;
    $('health-url').textContent = o.connection.health_url;

    const m = o.metrics;
    const real = m.last15m.count > 0;
    const w = real ? m.last15m : m.checks;
    $('traffic-title').textContent = real ? 'Llamadas reales de Muse (últimos 15 min)' : 'Según las pruebas del panel (aún no hay llamadas de Muse)';
    $('traffic').replaceChildren(
      el('dt', { text: 'Llamadas' }),
      el('dd', { text: fmtNum(w.count) }),
      el('dt', { text: 'Tiempo de respuesta de GoHighLevel' }),
      el('dd', { text: fmtMs(w.ghlMs.p50) }),
      el('dt', { text: 'Tiempo que añade el proxy' }),
      el('dd', { text: fmtSmallMs(w.overheadMs.p50) }),
      el('dt', { text: 'Tiempo que añade el proxy (peor 5 %)' }),
      el('dd', { text: fmtSmallMs(w.overheadMs.p95) }),
    );

    const c = o.config;
    $('security').replaceChildren(
      el('dt', { text: 'Conexión cifrada (HTTPS)' }),
      el('dd', { class: o.https ? 'ok' : 'warn', text: o.https ? 'Activa' : 'No (solo válido en local)' }),
      el('dt', { text: 'Acceso al panel' }),
      el('dd', { text: 'PIN, con bloqueo tras 5 intentos' }),
      el('dt', { text: 'Llave del proxy' }),
      el('dd', { text: `${c.proxyKeyLength} caracteres` }),
      el('dt', { text: 'Token de GoHighLevel' }),
      el('dd', { text: `${c.ghlTokenHint} (nunca sale del servidor)` }),
      el('dt', { text: 'Subcuenta de GHL' }),
      el('dd', { text: c.locationId }),
      el('dt', { text: 'Límite de llamadas' }),
      el('dd', { text: `${c.rateLimit.max} cada ${c.rateLimit.windowSeconds} s` }),
    );

    const chips = [
      ['Llamadas de Muse', m.calls, ''],
      ['Llave incorrecta', m.rejectedKey, m.rejectedKey ? 'warn' : ''],
      ['PIN incorrecto', m.rejectedPin, m.rejectedPin ? 'warn' : ''],
      ['Frenadas por el límite', m.rateLimited, m.rateLimited ? 'warn' : ''],
      ['GHL negó permiso', m.ghlDenied, m.ghlDenied ? 'warn' : ''],
      ['Sin respuesta de GHL', m.upstreamErrors, m.upstreamErrors ? 'fail' : ''],
      ['Canceladas por Muse', m.cancelled, m.cancelled ? 'warn' : ''],
    ];
    $('counters').replaceChildren(...chips.map(([label, value, tone]) => el('span', { class: `chip ${tone}` }, el('strong', { text: fmtNum(value) }), label)));

    $('activity').replaceChildren(
      ...(m.recent.length
        ? m.recent.map((r) =>
            el(
              'tr',
              {},
              el('td', { class: 'time', text: fmtTime(r.at) }),
              el('td', { class: 'path', text: `${r.method} ${r.path}` }),
              el('td', { class: 'num' }, el('span', { class: `status-pill s${String(r.status)[0]}`, text: String(r.status) })),
              el('td', { class: 'num', text: fmtMs(r.ghlMs) }),
              el('td', { class: 'num col-total', text: fmtMs(r.totalMs) }),
            ),
          )
        : [el('tr', {}, el('td', { class: 'empty', colspan: 5, text: 'Todavía no hay llamadas de Muse.' }))]),
    );
    $('footer').textContent = `ghl-proxy v${o.version} · encendido hace ${uptime(o.uptimeSeconds)}`;
  }

  async function refresh() {
    try {
      const { status, data } = await api('/overview');
      if (status === 200 && data) {
        renderOverview(data);
        lastOverviewOk = new Date();
        offlineSince = null;
      }
    } catch (err) {
      if (err instanceof NetworkError) offlineSince = offlineSince || new Date();
    }
    renderStatus();
    $('activity-updated').textContent = lastOverviewOk ? `Actualizado ${fmtTime(lastOverviewOk)}` : '';
  }

  function stopRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  // ---------- key ----------

  function hideKey() {
    clearTimeout(keyTimer);
    clearTimeout(krakenTimer);
    clearTimeout(agencyTimer);
    clearTimeout(stripeTimer);
    for (const [nodeId, buttonId] of [['proxy-key', 'reveal-key'], ['k-access-key', 'k-reveal-key'], ['a-access-key', 'a-reveal-key'], ['s-access-key', 's-reveal-key']]) {
      $(nodeId).textContent = MASK;
      $(nodeId).classList.remove('is-revealed');
      $(buttonId).textContent = 'Mostrar';
    }
    $('new-key').hidden = true;
    $('new-key').textContent = '';
    $('copy-new-key').hidden = true;
  }

  function showKey(key) {
    const node = $('proxy-key');
    node.textContent = key;
    node.classList.add('is-revealed');
    $('reveal-key').textContent = 'Ocultar';
    clearTimeout(keyTimer);
    keyTimer = setTimeout(hideKey, KEY_VISIBLE_MS);
  }

  async function fetchKey() {
    const { status, data } = await api('/key', { method: 'POST' });
    if (status !== 200 || !data || !data.proxyKey) throw new Error('key');
    return data.proxyKey;
  }

  async function copyKey() {
    return copySecret(fetchKey, (key) => manualCopy(key));
  }

  /** Copies a secret fetched from the server; `fallback(key)` shows it selected if copying is blocked. */
  async function copySecret(fetchSecret, fallback) {
    // Safari only allows clipboard writes started inside the tap, so hand it a pending item.
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write && window.isSecureContext) {
      let fetched = null;
      const blob = fetchSecret().then((key) => {
        fetched = key;
        return new Blob([key], { type: 'text/plain' });
      });
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
        toast('Llave copiada');
        return;
      } catch (err) {
        if (err && err.message === 'unauthorized') return;
        if (fetched === null) {
          try {
            fetched = await blob.then(() => fetched);
          } catch (e) {
            if (e && e.message === 'unauthorized') return;
          }
        }
        if (fetched && (await copyText(fetched))) {
          toast('Llave copiada');
          return;
        }
        if (fetched) return fallback(fetched);
      }
    }
    try {
      const key = await fetchSecret();
      if (await copyText(key)) toast('Llave copiada');
      else fallback(key);
    } catch (err) {
      if (err instanceof NetworkError) toast('No se pudo conectar con el proxy.', { error: true });
      else if (err.message !== 'unauthorized') toast('No se pudo obtener la llave.', { error: true });
    }
  }

  function manualCopy(key) {
    showKey(key);
    selectNode($('proxy-key'));
    toast('Tu navegador no dejó copiar. La llave está seleccionada: mantén pulsado para copiarla.', { error: true });
  }

  async function download() {
    try {
      const res = await fetch('/admin/api/connection.md', { credentials: 'same-origin', cache: 'no-store' });
      if (res.status === 401) return showLogin('Tu sesión expiró. Ingresa el PIN de nuevo.', true);
      if (!res.ok) throw new Error('download');
      const url = URL.createObjectURL(await res.blob());
      const a = el('a', { href: url, download: 'CONNECTION.md' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast('No se pudo descargar. Usa «Copiar».', { error: true });
    }
  }


  // ---------- switch ----------

  function savedView() {
    const fromHash = location.hash.slice(1);
    if (VIEWS.includes(fromHash)) return fromHash;
    try {
      const stored = localStorage.getItem('panel-view');
      return VIEWS.includes(stored) ? stored : 'ghl';
    } catch {
      return 'ghl';
    }
  }

  function setView(next) {
    view = VIEWS.includes(next) ? next : 'ghl';
    for (const name of VIEWS) {
      const active = name === view;
      $(`view-${name}`).hidden = !active;
      $(`tab-${name}`).setAttribute('aria-selected', String(active));
      $(`tab-${name}`).tabIndex = active ? 0 : -1;
    }
    try {
      localStorage.setItem('panel-view', view);
    } catch {
      // private mode: the choice just is not remembered
    }
    if (view === 'kraken') {
      if (!krakenStarted) {
        krakenStarted = true;
        runKrakenChecks();
      }
      refreshKraken();
    } else if (view === 'agency') {
      if (!agencyStarted) {
        agencyStarted = true;
        runAgencyChecks();
      }
      refreshAgency();
    } else if (view === 'stripe') {
      if (!stripeStarted) {
        stripeStarted = true;
        runStripeChecks();
      }
      refreshStripe();
    } else {
      refresh();
    }
  }

  // ---------- Kraken ----------

  const K_TITLES = {
    ok: 'Kraken funciona',
    warn: 'Kraken funciona, con avisos',
    fail: 'Kraken tiene un problema',
    setup: 'Falta configurar Kraken',
    missing: 'Kraken no está disponible',
    error: 'No se pudo verificar',
  };
  const K_SUBS = {
    ok: 'Las claves, la firma y el proxy responden bien. Muse puede usarlo.',
    warn: 'Lo esencial funciona. Revisa los avisos de abajo.',
    fail: 'Revisa el punto en rojo. Muse no podrá usar Kraken hasta corregirlo.',
    setup: 'Sigue los 3 pasos de abajo (unos 5 minutos). GoHighLevel sigue funcionando igual.',
    missing: 'Este servidor todavía no tiene la parte de Kraken.',
    error: 'La verificación no respondió. Pulsa «Verificar ahora» para intentarlo de nuevo.',
  };

  function renderKrakenStatus(state, when) {
    const badge = $('k-status-badge');
    const iconState = state === 'setup' || state === 'missing' || state === 'error' ? 'warn' : state;
    badge.dataset.state = iconState;
    badge.replaceChildren(icon(ICON[iconState] || ICON.warn));
    $('tab-kraken').querySelector('.switch-dot').dataset.state = state === 'missing' ? '' : state === 'error' ? 'warn' : state;
    $('k-status-title').textContent = K_TITLES[state];
    $('k-status-sub').textContent = `${K_SUBS[state]}${when ? ` Verificado ${ago(when)}.` : ''}`;
  }

  function permItem(p) {
    return el(
      'li',
      { class: 'perm', 'data-state': p.state },
      stateIcon(p.state),
      el('div', {}, el('div', { class: 'perm-name', text: p.label }), p.detail ? el('div', { class: 'perm-detail', text: p.detail }) : null),
    );
  }

  function renderKrakenChecks(result) {
    lastKrakenChecks = result;
    renderKrakenStatus(result.overall, new Date(result.ranAt));
    $('k-checks').replaceChildren(
      ...result.checks.map((c) =>
        el(
          'li',
          { class: 'check', 'data-state': c.status },
          stateIcon(c.status),
          el('div', {}, el('div', { class: 'check-label', text: c.label }), el('div', { class: 'check-detail', text: c.detail })),
          el('span', { class: 'check-ms', text: c.ms === null ? '' : fmtMs(c.ms) }),
        ),
      ),
    );
    if (result.key) {
      $('k-perms').replaceChildren(...result.key.permissions.map(permItem));
      $('k-notes').replaceChildren(...result.key.notes.map(permItem));
    } else {
      $('k-perms').replaceChildren(el('li', { class: 'perm-empty muted small', text: 'Aparecerán cuando las claves estén puestas y verificadas.' }));
      $('k-notes').replaceChildren();
    }
  }

  async function runKrakenChecks() {
    const button = $('k-run-checks');
    button.disabled = true;
    button.textContent = 'Verificando…';
    $('k-status-badge').dataset.state = 'pending';
    try {
      const { status, data } = await api('/kraken/checks', { method: 'POST' });
      if (status === 200 && data) renderKrakenChecks(data);
      else if (status === 404) renderKrakenStatus('missing');
      else toast('No se pudo verificar Kraken. Intenta de nuevo.', { error: true });
    } catch (err) {
      if (err instanceof NetworkError) toast('No se pudo conectar con el proxy.', { error: true });
    } finally {
      button.disabled = false;
      button.textContent = 'Verificar ahora';
      if (lastKrakenChecks) renderKrakenStatus(lastKrakenChecks.overall, new Date(lastKrakenChecks.ranAt));
      else if ($('k-status-badge').dataset.state === 'pending') renderKrakenStatus('error');
      refreshKraken();
    }
  }

  function renderKrakenOverview(o) {
    $('k-setup').hidden = o.configured;
    $('k-connect').hidden = !o.configured;
    $('k-problems').hidden = !(o.started && o.problems.length);
    $('k-problems').replaceChildren(...o.problems.map((p) => el('li', { text: p })));
    if (o.configured) {
      $('k-muse-message').textContent = o.museMessage;
      $('k-health-url').textContent = o.connection.health_url;
    }

    const mode = $('k-mode');
    mode.dataset.mode = o.trading ? 'trading' : 'read';
    mode.textContent = o.trading ? 'Trading ACTIVADO' : 'Solo lectura';
    const trading = new Set(o.methods.trading);
    $('k-methods').replaceChildren(...o.methods.allowed.map((m) => el('li', { class: trading.has(m) ? 'trading' : null, text: m })));
    $('k-never').replaceChildren(...o.methods.never.map((m) => el('li', { text: m })));
    $('k-security').replaceChildren(
      el('dt', { text: 'Llave de Muse' }),
      el('dd', { text: o.key ? `${o.key.length} caracteres (${o.key.source === 'env' ? 'KRAKEN_PROXY_KEY' : 'hecha con tus 2 claves'})` : '—' }),
      el('dt', { text: 'API key de Kraken' }),
      el('dd', { text: o.key ? `${o.key.apiKeyHint} (nunca sale del servidor)` : 'Sin poner' }),
      el('dt', { text: 'Límite de llamadas' }),
      el('dd', { text: `${o.rateLimit.max} por minuto` }),
      el('dt', { text: 'Dirección' }),
      el('dd', { text: o.connection.kraken_host }),
    );

    const m = o.metrics;
    const chips = [
      ['Llamadas de Muse', m.calls, ''],
      ['Correctas', m.ok, ''],
      ['Error de Kraken', m.krakenErrors, m.krakenErrors ? 'warn' : ''],
      ['Método bloqueado', m.rejectedMethod, m.rejectedMethod ? 'warn' : ''],
      ['Llave incorrecta', m.rejectedKey, m.rejectedKey ? 'warn' : ''],
      ['Frenadas por el límite', m.rateLimited, m.rateLimited ? 'warn' : ''],
      ['Sin respuesta de Kraken', m.upstreamErrors, m.upstreamErrors ? 'fail' : ''],
    ];
    $('k-counters').replaceChildren(...chips.map(([label, value, tone]) => el('span', { class: `chip ${tone}` }, el('strong', { text: fmtNum(value) }), label)));
    $('k-activity').replaceChildren(
      ...(m.recent.length
        ? m.recent.map((r) =>
            el(
              'tr',
              {},
              el('td', { class: 'time', text: fmtTime(r.at) }),
              el('td', { class: 'kmethod', text: r.method || '—' }),
              el('td', { class: 'num' }, el('span', { class: `status-pill s${String(r.status)[0]}`, text: String(r.status) })),
              el('td', { class: `result${r.error ? ' is-error' : ''}`, title: r.error || undefined, text: r.explain || r.error || 'OK' }),
              el('td', { class: 'num col-total', text: fmtMs(r.krakenMs) }),
            ),
          )
        : [el('tr', {}, el('td', { class: 'empty', colspan: 5, text: 'Todavía no hay llamadas de Muse a Kraken.' }))]),
    );
    $('k-activity-updated').textContent = `Actualizado ${fmtTime(new Date())}`;
    if (!lastKrakenChecks && !o.configured) renderKrakenStatus('setup');
  }

  async function refreshKraken() {
    try {
      const { status, data } = await api('/kraken/overview');
      if (status === 200 && data) renderKrakenOverview(data);
      else if (status === 404) renderKrakenStatus('missing');
    } catch {
      // the GHL status already reports connection problems
    }
  }

  function showKrakenKey(key) {
    const node = $('k-access-key');
    node.textContent = key;
    node.classList.add('is-revealed');
    $('k-reveal-key').textContent = 'Ocultar';
    clearTimeout(krakenTimer);
    krakenTimer = setTimeout(hideKey, KEY_VISIBLE_MS);
  }

  async function fetchKrakenKey() {
    const { status, data } = await api('/kraken/key', { method: 'POST' });
    if (status !== 200 || !data || !data.accessKey) throw new Error('key');
    return data.accessKey;
  }

  function wireKraken() {
    for (const name of VIEWS) $(`tab-${name}`).addEventListener('click', () => setView(name));
    $('tab-ghl').parentElement.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const step = event.key === 'ArrowRight' ? 1 : VIEWS.length - 1;
      setView(VIEWS[(VIEWS.indexOf(view) + step) % VIEWS.length]);
      $(`tab-${view}`).focus();
    });
    $('k-run-checks').addEventListener('click', runKrakenChecks);
    $('k-copy-muse').addEventListener('click', async () => {
      const text = $('k-muse-message').textContent;
      if (!text || text === '—') return toast('Espera un segundo: el mensaje aún se está cargando.', { error: true });
      if (await copyText(text)) {
        toast('Mensaje copiado. Pégalo en Muse.');
      } else {
        $('k-muse-message').closest('details').open = true;
        selectNode($('k-muse-message'));
        toast('Tu navegador no dejó copiar. El mensaje está seleccionado: mantén pulsado para copiarlo.', { error: true });
      }
    });
    $('k-reveal-key').addEventListener('click', async () => {
      if ($('k-access-key').classList.contains('is-revealed')) return hideKey();
      try {
        showKrakenKey(await fetchKrakenKey());
      } catch (err) {
        if (err instanceof NetworkError) toast('No se pudo conectar con el proxy.', { error: true });
        else if (err.message !== 'unauthorized') toast('No se pudo obtener la llave.', { error: true });
      }
    });
    $('k-copy-key').addEventListener('click', () =>
      copySecret(fetchKrakenKey, (key) => {
        showKrakenKey(key);
        selectNode($('k-access-key'));
        toast('Tu navegador no dejó copiar. La llave está seleccionada: mantén pulsado para copiarla.', { error: true });
      }),
    );
  }

  // ---------- GHL Agencia ----------

  const A_TITLES = {
    ok: 'La API de agencia funciona',
    warn: 'La API de agencia funciona, con avisos',
    fail: 'La API de agencia tiene un problema',
    setup: 'Falta configurar la API de agencia',
    missing: 'La API de agencia no está disponible',
    error: 'No se pudo verificar',
  };
  const A_SUBS = {
    ok: 'El token de la agencia, sus permisos y el proxy responden bien. Muse puede usarla.',
    warn: 'Lo esencial funciona. Revisa los avisos de abajo.',
    fail: 'Revisa el punto en rojo. Muse no podrá usar la API de agencia hasta corregirlo.',
    setup: 'Sigue los 3 pasos de abajo (unos 5 minutos). GHL Eximia y Kraken siguen funcionando igual.',
    missing: 'Este servidor todavía no tiene la parte de agencia.',
    error: 'La verificación no respondió. Pulsa «Verificar ahora» para intentarlo de nuevo.',
  };

  function renderAgencyStatus(state, when) {
    const badge = $('a-status-badge');
    const iconState = state === 'setup' || state === 'missing' || state === 'error' ? 'warn' : state;
    badge.dataset.state = iconState;
    badge.replaceChildren(icon(ICON[iconState] || ICON.warn));
    $('tab-agency').querySelector('.switch-dot').dataset.state = state === 'missing' ? '' : state === 'error' ? 'warn' : state;
    $('a-status-title').textContent = A_TITLES[state];
    $('a-status-sub').textContent = `${A_SUBS[state]}${when ? ` Verificado ${ago(when)}.` : ''}`;
  }

  function renderAgencyChecks(result) {
    lastAgencyChecks = result;
    renderAgencyStatus(result.overall, new Date(result.ranAt));
    $('a-checks').replaceChildren(
      ...result.checks.map((c) =>
        el(
          'li',
          { class: 'check', 'data-state': c.status },
          stateIcon(c.status),
          el('div', {}, el('div', { class: 'check-label', text: c.label }), el('div', { class: 'check-detail', text: c.detail })),
          el('span', { class: 'check-ms', text: c.ms === null ? '' : fmtMs(c.ms) }),
        ),
      ),
    );
    $('a-perms').replaceChildren(
      ...(result.permissions.length
        ? result.permissions.map((p) => permItem({ ...p, detail: p.scope ? `${p.detail} · ${p.scope}` : p.detail }))
        : [el('li', { class: 'perm-empty muted small', text: 'Aparecerán cuando el token esté puesto y verificado.' })]),
    );
  }

  async function runAgencyChecks() {
    const button = $('a-run-checks');
    button.disabled = true;
    button.textContent = 'Verificando…';
    $('a-status-badge').dataset.state = 'pending';
    try {
      const { status, data } = await api('/agency/checks', { method: 'POST' });
      if (status === 200 && data) renderAgencyChecks(data);
      else if (status === 404) renderAgencyStatus('missing');
      else toast('No se pudo verificar la API de agencia. Intenta de nuevo.', { error: true });
    } catch (err) {
      if (err instanceof NetworkError) toast('No se pudo conectar con el proxy.', { error: true });
    } finally {
      button.disabled = false;
      button.textContent = 'Verificar ahora';
      // A failed repeat keeps showing the last result instead of a badge that pulses forever.
      if (lastAgencyChecks) renderAgencyStatus(lastAgencyChecks.overall, new Date(lastAgencyChecks.ranAt));
      else if ($('a-status-badge').dataset.state === 'pending') renderAgencyStatus('error');
      refreshAgency();
    }
  }

  function renderAgencyOverview(o) {
    $('a-setup').hidden = o.configured;
    $('a-connect').hidden = !o.configured;
    $('a-problems').hidden = !(o.started && o.problems.length);
    $('a-problems').replaceChildren(...o.problems.map((p) => el('li', { text: p })));
    $('a-scopes').replaceChildren(...o.scopes.map((scope) => el('li', { text: scope })));
    if (o.configured) $('a-muse-message').textContent = o.museMessage;

    const mode = $('a-mode');
    mode.dataset.mode = o.allowDelete ? 'allowed' : 'blocked';
    mode.textContent = o.allowDelete ? 'Todo, incluido borrar' : 'Todo, menos borrar subcuentas';
    const line = $('a-delete-line');
    line.className = o.allowDelete ? 'yes' : 'no';
    line.textContent = o.allowDelete ? 'Borrar subcuentas: PERMITIDO (no se puede deshacer)' : 'Borrar subcuentas: bloqueado en el proxy (no se puede deshacer)';

    const company = lastAgencyChecks && lastAgencyChecks.company;
    const agencyName = company && company.name ? `${company.name}${typeof company.locationCount === 'number' ? ` · ${fmtNum(company.locationCount)} subcuentas` : ''}` : null;
    $('a-security').replaceChildren(
      el('dt', { text: 'Agencia' }),
      el('dd', { text: agencyName || (/^PENDIENTE/.test(o.connection.company_id) ? '—' : o.connection.company_id) }),
      el('dt', { text: 'Llave de Muse' }),
      el('dd', { text: o.key ? `${o.key.length} caracteres (${o.key.source === 'env' ? 'GHL_AGENCY_PROXY_KEY' : 'hecha con el token de la agencia'})` : '—' }),
      el('dt', { text: 'Token de la agencia' }),
      el('dd', { text: o.key ? `${o.key.tokenHint} (nunca sale del servidor)` : 'Sin poner' }),
      el('dt', { text: 'Límite de llamadas' }),
      el('dd', { text: `${o.rateLimit.max} cada ${o.rateLimit.windowSeconds} s` }),
      el('dt', { text: 'Dirección' }),
      el('dd', { text: o.connection.agency_host }),
    );

    const m = o.metrics;
    const chips = [
      ['Llamadas de Muse', m.calls, ''],
      ['Bloqueadas por el proxy', m.blocked, m.blocked ? 'warn' : ''],
      ['Llave incorrecta', m.rejectedKey, m.rejectedKey ? 'warn' : ''],
      ['Frenadas por el límite', m.rateLimited, m.rateLimited ? 'warn' : ''],
      ['GHL negó permiso', m.ghlDenied, m.ghlDenied ? 'warn' : ''],
      ['Sin respuesta de GHL', m.upstreamErrors, m.upstreamErrors ? 'fail' : ''],
      ['Canceladas por Muse', m.cancelled, m.cancelled ? 'warn' : ''],
    ];
    $('a-counters').replaceChildren(...chips.map(([label, value, tone]) => el('span', { class: `chip ${tone}` }, el('strong', { text: fmtNum(value) }), label)));
    $('a-activity').replaceChildren(
      ...(m.recent.length
        ? m.recent.map((r) =>
            el(
              'tr',
              {},
              el('td', { class: 'time', text: fmtTime(r.at) }),
              el('td', { class: 'path', text: `${r.method} ${r.path}` }),
              el('td', { class: 'num' }, el('span', { class: `status-pill s${String(r.status)[0]}`, text: String(r.status) })),
              el('td', { class: 'num', text: fmtMs(r.ghlMs) }),
              el('td', { class: 'num col-total', text: fmtMs(r.totalMs) }),
            ),
          )
        : [el('tr', {}, el('td', { class: 'empty', colspan: 5, text: 'Todavía no hay llamadas de Muse a la agencia.' }))]),
    );
    $('a-activity-updated').textContent = `Actualizado ${fmtTime(new Date())}`;
    if (!lastAgencyChecks && !o.configured) renderAgencyStatus('setup');
  }

  async function refreshAgency() {
    try {
      const { status, data } = await api('/agency/overview');
      if (status === 200 && data) renderAgencyOverview(data);
      else if (status === 404) renderAgencyStatus('missing');
    } catch {
      // the GHL status already reports connection problems
    }
  }

  function showAgencyKey(key) {
    const node = $('a-access-key');
    node.textContent = key;
    node.classList.add('is-revealed');
    $('a-reveal-key').textContent = 'Ocultar';
    clearTimeout(agencyTimer);
    agencyTimer = setTimeout(hideKey, KEY_VISIBLE_MS);
  }

  async function fetchAgencyKey() {
    const { status, data } = await api('/agency/key', { method: 'POST' });
    if (status !== 200 || !data || !data.accessKey) throw new Error('key');
    return data.accessKey;
  }

  function wireAgency() {
    $('a-run-checks').addEventListener('click', runAgencyChecks);
    $('a-copy-muse').addEventListener('click', async () => {
      const text = $('a-muse-message').textContent;
      if (!text || text === '—') return toast('Espera un segundo: el mensaje aún se está cargando.', { error: true });
      if (await copyText(text)) {
        toast('Mensaje copiado. Pégalo en Muse.');
      } else {
        $('a-muse-message').closest('details').open = true;
        selectNode($('a-muse-message'));
        toast('Tu navegador no dejó copiar. El mensaje está seleccionado: mantén pulsado para copiarlo.', { error: true });
      }
    });
    $('a-reveal-key').addEventListener('click', async () => {
      if ($('a-access-key').classList.contains('is-revealed')) return hideKey();
      try {
        showAgencyKey(await fetchAgencyKey());
      } catch (err) {
        if (err instanceof NetworkError) toast('No se pudo conectar con el proxy.', { error: true });
        else if (err.message !== 'unauthorized') toast('No se pudo obtener la llave.', { error: true });
      }
    });
    $('a-copy-key').addEventListener('click', () =>
      copySecret(fetchAgencyKey, (key) => {
        showAgencyKey(key);
        selectNode($('a-access-key'));
        toast('Tu navegador no dejó copiar. La llave está seleccionada: mantén pulsado para copiarla.', { error: true });
      }),
    );
  }

  // ---------- Stripe ----------

  const S_TITLES = {
    ok: 'Stripe funciona',
    warn: 'Stripe funciona, con avisos',
    fail: 'Stripe tiene un problema',
    setup: 'Falta configurar Stripe',
    missing: 'Stripe no está disponible',
    error: 'No se pudo verificar',
  };
  const S_SUBS = {
    ok: 'La clave, sus permisos y el proxy responden bien. Muse puede usarlo.',
    warn: 'Lo esencial funciona. Revisa los avisos de abajo.',
    fail: 'Revisa el punto en rojo. Muse no podrá usar Stripe hasta corregirlo.',
    setup: 'Sigue los 3 pasos de abajo (unos 5 minutos). GHL y Kraken siguen funcionando igual.',
    missing: 'Este servidor todavía no tiene la parte de Stripe.',
    error: 'La verificación no respondió. Pulsa «Verificar ahora» para intentarlo de nuevo.',
  };

  function renderStripeStatus(state, when) {
    const badge = $('s-status-badge');
    const iconState = state === 'setup' || state === 'missing' || state === 'error' ? 'warn' : state;
    badge.dataset.state = iconState;
    badge.replaceChildren(icon(ICON[iconState] || ICON.warn));
    $('tab-stripe').querySelector('.switch-dot').dataset.state = state === 'missing' ? '' : state === 'error' ? 'warn' : state;
    $('s-status-title').textContent = S_TITLES[state];
    $('s-status-sub').textContent = `${S_SUBS[state]}${when ? ` Verificado ${ago(when)}.` : ''}`;
  }

  function renderStripeChecks(result) {
    lastStripeChecks = result;
    renderStripeStatus(result.overall, new Date(result.ranAt));
    $('s-checks').replaceChildren(
      ...result.checks.map((c) =>
        el(
          'li',
          { class: 'check', 'data-state': c.status },
          stateIcon(c.status),
          el('div', {}, el('div', { class: 'check-label', text: c.label }), el('div', { class: 'check-detail', text: c.detail })),
          el('span', { class: 'check-ms', text: c.ms === null ? '' : fmtMs(c.ms) }),
        ),
      ),
    );
    $('s-perms').replaceChildren(
      ...(result.permissions.length
        ? result.permissions.map((p) => permItem({ ...p, detail: p.perm ? `${p.detail} · ${p.perm}` : p.detail }))
        : [el('li', { class: 'perm-empty muted small', text: 'Aparecerán cuando la clave esté puesta y verificada.' })]),
    );
  }

  async function runStripeChecks() {
    const button = $('s-run-checks');
    button.disabled = true;
    button.textContent = 'Verificando…';
    $('s-status-badge').dataset.state = 'pending';
    try {
      const { status, data } = await api('/stripe/checks', { method: 'POST' });
      if (status === 200 && data) renderStripeChecks(data);
      else if (status === 404) renderStripeStatus('missing');
      else toast('No se pudo verificar Stripe. Intenta de nuevo.', { error: true });
    } catch (err) {
      if (err instanceof NetworkError) toast('No se pudo conectar con el proxy.', { error: true });
    } finally {
      button.disabled = false;
      button.textContent = 'Verificar ahora';
      if (lastStripeChecks) renderStripeStatus(lastStripeChecks.overall, new Date(lastStripeChecks.ranAt));
      else if ($('s-status-badge').dataset.state === 'pending') renderStripeStatus('error');
      refreshStripe();
    }
  }

  function renderStripeOverview(o) {
    $('s-setup').hidden = o.configured;
    $('s-connect').hidden = !o.configured;
    $('s-problems').hidden = !(o.started && o.problems.length);
    $('s-problems').replaceChildren(...o.problems.map((p) => el('li', { text: p })));
    if (o.configured) $('s-muse-message').textContent = o.museMessage;

    const mode = $('s-mode');
    mode.dataset.mode = o.mode || 'test';
    mode.textContent = o.mode === 'live' ? 'LIVE: dinero real' : o.mode === 'test' ? 'TEST: nada es real' : 'Sin clave';
    const money = $('s-money-line');
    money.className = o.allowMoneyOut ? 'yes' : 'no';
    money.textContent = o.allowMoneyOut ? 'Payouts, transferencias y cambios de cuenta bancaria: PERMITIDOS (no se pueden deshacer)' : 'Payouts, transferencias y cambios de cuenta bancaria: bloqueados en el proxy';
    const access = $('s-access-line');
    access.className = o.allowAccessGrants ? 'yes' : 'no';
    access.textContent = o.allowAccessGrants ? 'Webhooks, enlaces públicos y enlaces de acceso: PERMITIDOS' : 'Webhooks, enlaces públicos y enlaces de acceso: bloqueados (protegen lo que ya está conectado a Stripe)';

    const account = lastStripeChecks && lastStripeChecks.account;
    $('s-security').replaceChildren(
      el('dt', { text: 'Cuenta' }),
      el('dd', { text: account ? `${account.name || account.id}${account.country ? ` · ${account.country}` : ''}` : '—' }),
      el('dt', { text: 'Llave de Muse' }),
      el('dd', { text: o.key ? `${o.key.length} caracteres (${o.key.source === 'env' ? 'STRIPE_PROXY_KEY' : 'hecha con la clave de Stripe'})` : '—' }),
      el('dt', { text: 'Clave de Stripe' }),
      el('dd', { text: o.key ? `${o.key.secretHint} (${o.keyKind === 'restricted' ? 'restringida' : 'secreta'}; nunca sale del servidor)` : 'Sin poner' }),
      el('dt', { text: 'Versión del API' }),
      el('dd', { text: o.connection.stripe_version }),
      el('dt', { text: 'Límite de llamadas' }),
      el('dd', { text: `${o.rateLimit.max} cada ${o.rateLimit.windowSeconds} s` }),
      el('dt', { text: 'Dirección' }),
      el('dd', { text: o.connection.stripe_host }),
    );

    const m = o.metrics;
    const chips = [
      ['Llamadas de Muse', m.calls, ''],
      ['Bloqueadas por el proxy', m.blocked, m.blocked ? 'warn' : ''],
      ['Llave incorrecta', m.rejectedKey, m.rejectedKey ? 'warn' : ''],
      ['Frenadas por el límite', m.rateLimited, m.rateLimited ? 'warn' : ''],
      ['Stripe negó permiso', m.ghlDenied, m.ghlDenied ? 'warn' : ''],
      ['Sin respuesta de Stripe', m.upstreamErrors, m.upstreamErrors ? 'fail' : ''],
      ['Canceladas por Muse', m.cancelled, m.cancelled ? 'warn' : ''],
    ];
    $('s-counters').replaceChildren(...chips.map(([label, value, tone]) => el('span', { class: `chip ${tone}` }, el('strong', { text: fmtNum(value) }), label)));
    $('s-activity').replaceChildren(
      ...(m.recent.length
        ? m.recent.map((r) =>
            el(
              'tr',
              {},
              el('td', { class: 'time', text: fmtTime(r.at) }),
              el('td', { class: 'path', text: `${r.method} ${r.path}` }),
              el('td', { class: 'num' }, el('span', { class: `status-pill s${String(r.status)[0]}`, text: String(r.status) })),
              el('td', { class: 'num', text: fmtMs(r.ghlMs) }),
              el('td', { class: 'num col-total', text: fmtMs(r.totalMs) }),
            ),
          )
        : [el('tr', {}, el('td', { class: 'empty', colspan: 5, text: 'Todavía no hay llamadas de Muse a Stripe.' }))]),
    );
    $('s-activity-updated').textContent = `Actualizado ${fmtTime(new Date())}`;
    if (!lastStripeChecks && !o.configured) renderStripeStatus('setup');
  }

  async function refreshStripe() {
    try {
      const { status, data } = await api('/stripe/overview');
      if (status === 200 && data) renderStripeOverview(data);
      else if (status === 404) renderStripeStatus('missing');
    } catch {
      // the GHL status already reports connection problems
    }
  }

  function showStripeKey(key) {
    const node = $('s-access-key');
    node.textContent = key;
    node.classList.add('is-revealed');
    $('s-reveal-key').textContent = 'Ocultar';
    clearTimeout(stripeTimer);
    stripeTimer = setTimeout(hideKey, KEY_VISIBLE_MS);
  }

  async function fetchStripeKey() {
    const { status, data } = await api('/stripe/key', { method: 'POST' });
    if (status !== 200 || !data || !data.accessKey) throw new Error('key');
    return data.accessKey;
  }

  function wireStripe() {
    $('s-run-checks').addEventListener('click', runStripeChecks);
    $('s-copy-muse').addEventListener('click', async () => {
      const text = $('s-muse-message').textContent;
      if (!text || text === '—') return toast('Espera un segundo: el mensaje aún se está cargando.', { error: true });
      if (await copyText(text)) {
        toast('Mensaje copiado. Pégalo en Muse.');
      } else {
        $('s-muse-message').closest('details').open = true;
        selectNode($('s-muse-message'));
        toast('Tu navegador no dejó copiar. El mensaje está seleccionado: mantén pulsado para copiarlo.', { error: true });
      }
    });
    $('s-reveal-key').addEventListener('click', async () => {
      if ($('s-access-key').classList.contains('is-revealed')) return hideKey();
      try {
        showStripeKey(await fetchStripeKey());
      } catch (err) {
        if (err instanceof NetworkError) toast('No se pudo conectar con el proxy.', { error: true });
        else if (err.message !== 'unauthorized') toast('No se pudo obtener la llave.', { error: true });
      }
    });
    $('s-copy-key').addEventListener('click', () =>
      copySecret(fetchStripeKey, (key) => {
        showStripeKey(key);
        selectNode($('s-access-key'));
        toast('Tu navegador no dejó copiar. La llave está seleccionada: mantén pulsado para copiarla.', { error: true });
      }),
    );
  }

  // ---------- wiring ----------

  function wireApp() {
    $('run-checks').addEventListener('click', runChecks);
    $('logout').addEventListener('click', async () => {
      let status = 0;
      try {
        ({ status } = await api('/logout', { method: 'POST' }));
      } catch {
        status = 0;
      }
      if (status === 204) showLogin('Sesión cerrada.', true);
      else toast('No se pudo cerrar la sesión. Revisa tu conexión e intenta de nuevo.', { error: true });
    });
    $('copy-connection').addEventListener('click', async () => {
      const text = $('connection').dataset.markdown || $('connection').textContent;
      if (await copyText(text)) toast('CONNECTION.md copiado');
      else {
        selectNode($('connection'));
        toast('Tu navegador no dejó copiar. El texto está seleccionado: mantén pulsado para copiarlo.', { error: true });
      }
    });
    $('download-connection').addEventListener('click', download);
    $('copy-muse').addEventListener('click', async () => {
      const text = $('muse-message').textContent;
      if (!text || text === '—') return toast('Espera un segundo: el mensaje aún se está cargando.', { error: true });
      if (await copyText(text)) {
        toast('Mensaje copiado. Pégalo en Muse.');
      } else {
        $('muse-message').closest('details').open = true;
        selectNode($('muse-message'));
        toast('Tu navegador no dejó copiar. El mensaje está seleccionado: mantén pulsado para copiarlo.', { error: true });
      }
    });
    $('reveal-key').addEventListener('click', async () => {
      if ($('proxy-key').classList.contains('is-revealed')) return hideKey();
      try {
        showKey(await fetchKey());
      } catch (err) {
        if (err instanceof NetworkError) toast('No se pudo conectar con el proxy.', { error: true });
        else if (err.message !== 'unauthorized') toast('No se pudo obtener la llave.', { error: true });
      }
    });
    $('copy-key').addEventListener('click', copyKey);
    $('generate-key').addEventListener('click', () => {
      // Generated locally with the browser's CSPRNG; never sent to the server.
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      $('new-key').textContent = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      $('new-key').hidden = false;
      $('copy-new-key').hidden = false;
      $('generate-key').textContent = 'Generar otra';
    });
    $('copy-new-key').addEventListener('click', async () => {
      if (await copyText($('new-key').textContent)) toast('Llave nueva copiada');
      else {
        selectNode($('new-key'));
        toast('Tu navegador no dejó copiar. La llave está seleccionada: mantén pulsado para copiarla.', { error: true });
      }
    });
    wireKraken();
    wireAgency();
    wireStripe();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hideKey();
      else if (!$('app').hidden) refreshActive();
    });
  }

  function startApp() {
    $('login').hidden = true;
    $('app').hidden = false;
    refresh();
    runChecks();
    setView(savedView());
    stopRefresh();
    refreshTimer = setInterval(refreshActive, REFRESH_MS);
  }

  function refreshActive() {
    if (view === 'kraken') refreshKraken();
    else if (view === 'agency') refreshAgency();
    else if (view === 'stripe') refreshStripe();
    else refresh();
  }

  async function boot() {
    wireLogin();
    wireApp();
    try {
      const { data } = await api('/session');
      if (data && data.authenticated) startApp();
      else showLogin();
    } catch {
      showLogin('No se pudo conectar con el proxy. Recarga la página en un momento.');
    }
  }

  boot();
})();
