'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const ICON = { ok: 'i-check', warn: 'i-warn', fail: 'i-x', pending: 'i-check' };
  const REFRESH_MS = 15000;
  const KEY_VISIBLE_MS = 60000;

  let refreshTimer = null;
  let keyTimer = null;
  let lockTimer = null;
  let lastChecksAt = null;

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

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`/admin/api${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
    });
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
  function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.hidden = true;
    }, 2200);
  }

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copiado`);
    } catch {
      toast('No se pudo copiar: selecciona el texto y cópialo a mano');
    }
  }

  const fmtMs = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
  const fmtNum = (v) => Number(v || 0).toLocaleString('es');
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

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

  function showLogin(message = '', isInfo = false) {
    stopRefresh();
    $('app').hidden = true;
    $('login').hidden = false;
    const msg = $('login-msg');
    msg.textContent = message;
    msg.classList.toggle('is-info', isInfo);
    const pin = $('pin');
    pin.value = '';
    pin.focus();
  }

  function lockCountdown(seconds) {
    const pin = $('pin');
    const msg = $('login-msg');
    const buttons = document.querySelectorAll('#login-form button');
    let left = seconds;
    const tick = () => {
      if (left <= 0) {
        clearInterval(lockTimer);
        pin.disabled = false;
        buttons.forEach((b) => (b.disabled = false));
        msg.textContent = '';
        pin.focus();
        return;
      }
      const m = Math.floor(left / 60);
      const s = String(left % 60).padStart(2, '0');
      msg.textContent = `Demasiados intentos. Espera ${m}:${s}.`;
      left -= 1;
    };
    clearInterval(lockTimer);
    pin.disabled = true;
    buttons.forEach((b) => (b.disabled = true));
    tick();
    lockTimer = setInterval(tick, 1000);
  }

  async function submitPin(event) {
    if (event) event.preventDefault();
    const pin = $('pin');
    if (!pin.value || pin.disabled) return;
    const msg = $('login-msg');
    msg.classList.add('is-info');
    msg.textContent = 'Comprobando…';
    const { status, data } = await api('/login', { method: 'POST', body: { pin: pin.value } });
    pin.value = '';
    msg.classList.remove('is-info');
    if (status === 204) {
      msg.textContent = '';
      startApp();
    } else if (status === 429) {
      lockCountdown((data && data.retryAfterSeconds) || 30);
    } else if (status === 401) {
      const left = data && typeof data.attemptsLeft === 'number' ? data.attemptsLeft : null;
      msg.textContent = left !== null && left <= 3 ? `PIN incorrecto. Antes del bloqueo te quedan ${left} intento${left === 1 ? '' : 's'}.` : 'PIN incorrecto.';
      pin.focus();
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
        const key = button.dataset.key;
        if (key === 'back') pin.value = pin.value.slice(0, -1);
        else if (pin.value.length < 64) pin.value += key;
      });
    });
  }

  // ---------- dashboard ----------

  function renderChecks(result) {
    const titles = { ok: 'Todo funciona', warn: 'Funciona, con avisos', fail: 'Hay un problema' };
    const subs = {
      ok: 'GoHighLevel, el proxy y el MCP responden bien. Muse puede usarlo.',
      warn: 'Lo esencial funciona. Revisa los avisos de abajo.',
      fail: 'Revisa el punto en rojo. Muse no podrá usar el proxy hasta corregirlo.',
    };
    $('status-badge').dataset.state = result.overall;
    $('status-badge').replaceChildren(icon(ICON[result.overall]));
    $('status-title').textContent = titles[result.overall];
    lastChecksAt = new Date(result.ranAt);
    $('status-sub').textContent = `${subs[result.overall]} · Verificado ${ago(lastChecksAt)}.`;

    $('checks').replaceChildren(
      ...result.checks.map((c) =>
        el(
          'li',
          { class: 'check', 'data-state': c.status },
          el('span', { class: 'check-icon' }, icon(ICON[c.status])),
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
              el('span', { class: 'check-icon' }, icon(p.ok ? 'i-check' : 'i-x')),
              el('div', {}, el('div', { class: 'perm-name', text: p.label }), el('div', { class: 'perm-detail', text: p.detail })),
            ),
          )
        : [el('li', { class: 'perm-empty muted', text: 'Sin datos.' })]),
    );

    if (result.speed) {
      $('speed-direct').textContent = fmtMs(result.speed.directMs);
      $('speed-proxy').textContent = fmtMs(result.speed.proxyMs);
      const diff = result.speed.differenceMs;
      $('speed-diff').textContent = Math.abs(diff) < 1 ? '≈ 0 ms' : `${diff > 0 ? '+' : '−'}${Math.round(Math.abs(diff))} ms`;
    }
  }

  async function runChecks() {
    const button = $('run-checks');
    button.disabled = true;
    button.textContent = 'Verificando…';
    $('status-badge').dataset.state = 'pending';
    try {
      const { status, data } = await api('/checks', { method: 'POST' });
      if (status === 200 && data) renderChecks(data);
      else toast('No se pudo verificar. Intenta de nuevo.');
      refresh();
    } catch (err) {
      if (err.message !== 'unauthorized') toast('No se pudo verificar. Revisa tu conexión.');
    } finally {
      button.disabled = false;
      button.textContent = 'Verificar ahora';
    }
  }

  function renderOverview(o) {
    $('host-label').textContent = o.connection.middleware_host;
    $('connection').textContent = o.connection ? o.connectionMarkdown.replace(/^[\s\S]*?```yaml\n|```\s*$/g, '').trim() : '—';
    $('connection').dataset.markdown = o.connectionMarkdown;
    $('health-url').textContent = o.connection.health_url;

    const m = o.metrics;
    const w = m.last15m;
    $('traffic').replaceChildren(
      el('dt', { text: 'Llamadas (últimos 15 min)' }),
      el('dd', { text: fmtNum(w.count) }),
      el('dt', { text: 'Tiempo de GoHighLevel (mediana)' }),
      el('dd', { text: fmtMs(w.ghlMs.p50) }),
      el('dt', { text: 'Tiempo que añade el proxy (mediana)' }),
      el('dd', { text: w.overheadMs.p50 === null ? '—' : `${w.overheadMs.p50 < 1 ? '< 1' : Math.round(w.overheadMs.p50)} ms` }),
      el('dt', { text: 'Tiempo que añade el proxy (p95)' }),
      el('dd', { text: w.overheadMs.p95 === null ? '—' : `${w.overheadMs.p95 < 1 ? '< 1' : Math.round(w.overheadMs.p95)} ms` }),
    );

    const c = o.config;
    $('security').replaceChildren(
      el('dt', { text: 'HTTPS' }),
      el('dd', { class: o.https ? 'ok' : 'warn', text: o.https ? 'Activo' : 'No (solo válido en local)' }),
      el('dt', { text: 'Acceso al panel' }),
      el('dd', { text: 'PIN + bloqueo tras 5 intentos' }),
      el('dt', { text: 'Llave del proxy' }),
      el('dd', { text: `${c.proxyKeyLength} caracteres` }),
      el('dt', { text: 'Token de GoHighLevel' }),
      el('dd', { text: `${c.ghlTokenHint} (solo en el servidor)` }),
      el('dt', { text: 'Sub-account (locationId)' }),
      el('dd', { text: c.locationId }),
      el('dt', { text: 'Límite por llave' }),
      el('dd', { text: `${c.rateLimit.max} llamadas / ${c.rateLimit.windowSeconds} s` }),
    );

    const chips = [
      ['Llamadas desde el arranque', m.total, ''],
      ['Rechazadas (llave o PIN)', m.unauthorized, m.unauthorized ? 'warn' : ''],
      ['Frenadas por límite', m.rateLimited, m.rateLimited ? 'warn' : ''],
      ['Errores hacia GHL', m.upstreamErrors, m.upstreamErrors ? 'fail' : ''],
    ];
    $('counters').replaceChildren(...chips.map(([label, value, tone]) => el('span', { class: `chip ${tone}` }, el('strong', { text: fmtNum(value) }), label)));

    $('activity').replaceChildren(
      ...(m.recent.length
        ? m.recent.map((r) =>
            el(
              'tr',
              {},
              el('td', { class: 'time', text: fmtTime(r.at) }),
              el('td', { class: 'path' }, `${r.method} ${r.path}`, r.check ? el('span', { class: 'tag', text: 'prueba del panel' }) : null),
              el('td', { class: 'num' }, el('span', { class: `status-pill s${String(r.status)[0]}`, text: String(r.status) })),
              el('td', { class: 'num', text: fmtMs(r.ghlMs) }),
              el('td', { class: 'num', text: fmtMs(r.totalMs) }),
            ),
          )
        : [el('tr', {}, el('td', { class: 'empty', colspan: 5, text: 'Todavía no hay llamadas.' }))]),
    );
    $('activity-updated').textContent = `Actualizado ${fmtTime(new Date().toISOString())}`;
    $('footer').textContent = `ghl-proxy v${o.version} · encendido hace ${uptime(o.uptimeSeconds)}`;
    if (lastChecksAt) {
      const sub = $('status-sub').textContent.replace(/ · Verificado .*$/, '');
      $('status-sub').textContent = `${sub} · Verificado ${ago(lastChecksAt)}.`;
    }
  }

  async function refresh() {
    try {
      const { status, data } = await api('/overview');
      if (status === 200 && data) renderOverview(data);
    } catch {
      // handled in api() for 401; network blips are retried on the next tick
    }
  }

  function stopRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function hideKey() {
    clearTimeout(keyTimer);
    const node = $('proxy-key');
    node.textContent = '••••••••••••••••••••••••••••••••';
    node.classList.remove('is-revealed');
    $('reveal-key').textContent = 'Mostrar';
  }

  async function fetchKey() {
    const { status, data } = await api('/key', { method: 'POST' });
    if (status !== 200 || !data || !data.proxyKey) throw new Error('key');
    return data.proxyKey;
  }

  function wireApp() {
    $('run-checks').addEventListener('click', runChecks);
    $('logout').addEventListener('click', async () => {
      await api('/logout', { method: 'POST' }).catch(() => {});
      hideKey();
      showLogin('Sesión cerrada.', true);
    });
    $('copy-connection').addEventListener('click', () => copy($('connection').dataset.markdown || $('connection').textContent, 'CONNECTION.md'));
    $('reveal-key').addEventListener('click', async () => {
      const node = $('proxy-key');
      if (node.classList.contains('is-revealed')) return hideKey();
      try {
        node.textContent = await fetchKey();
        node.classList.add('is-revealed');
        $('reveal-key').textContent = 'Ocultar';
        clearTimeout(keyTimer);
        keyTimer = setTimeout(hideKey, KEY_VISIBLE_MS);
      } catch (err) {
        if (err.message !== 'unauthorized') toast('No se pudo obtener la llave');
      }
    });
    $('copy-key').addEventListener('click', async () => {
      try {
        await copy(await fetchKey(), 'Llave');
      } catch (err) {
        if (err.message !== 'unauthorized') toast('No se pudo obtener la llave');
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
      showLogin('No se pudo conectar con el proxy.');
    }
  }

  boot();
})();
