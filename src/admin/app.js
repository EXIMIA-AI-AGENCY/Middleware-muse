'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const ICON = { ok: 'i-check', warn: 'i-warn', fail: 'i-x', pending: 'i-check', offline: 'i-x' };
  const STATE_WORD = { ok: 'Correcto', warn: 'Aviso', fail: 'Error' };
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
    const node = $('proxy-key');
    node.textContent = MASK;
    node.classList.remove('is-revealed');
    $('reveal-key').textContent = 'Mostrar';
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
    // Safari only allows clipboard writes started inside the tap, so hand it a pending item.
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write && window.isSecureContext) {
      let fetched = null;
      const blob = fetchKey().then((key) => {
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
        if (fetched) return manualCopy(fetched);
      }
    }
    try {
      const key = await fetchKey();
      if (await copyText(key)) toast('Llave copiada');
      else manualCopy(key);
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
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) hideKey();
      else if (!$('app').hidden) refresh();
    });
  }

  function startApp() {
    $('login').hidden = true;
    $('app').hidden = false;
    refresh();
    runChecks();
    stopRefresh();
    refreshTimer = setInterval(refresh, REFRESH_MS);
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
