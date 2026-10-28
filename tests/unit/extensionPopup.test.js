/** Runs the real popup.html + popup.js in jsdom with a fake chrome API and fetch. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DIR = path.join(__dirname, '../../extension');
const HTML = fs.readFileSync(path.join(DIR, 'popup.html'), 'utf8');
const JS = fs.readFileSync(path.join(DIR, 'popup.js'), 'utf8');
const CSS = fs.readFileSync(path.join(DIR, 'popup.css'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opened = [];
afterEach(() => opened.splice(0).forEach((w) => w.close()));

const SESSION = { serverUrl: 'http://localhost:3000', token: 'tok.en', expiresAt: Date.now() + 1e7, classId: 'c1', classCode: 'ABC234', className: 'Net Admin 101', educatorName: 'Prof', student: { name: 'Ana Cruz', email: 'ana@pup.edu.ph' } };
const connectedStatus = (o = {}) => ({ ok: true, joined: true, session: SESSION, health: 'connected', score: 88, state: 'Focused', meetingTabs: 1, buffered: 0, attempts: 0, lastSyncAt: Date.now(), reasons: [], notice: null, ...o });
const idleStatus = (o = {}) => ({ ok: true, joined: false, session: null, notice: null, ...o });

async function load({ status = idleStatus(), prefs, fetchImpl, permissions = { has: true, grant: true }, preconfig } = {}) {
  const dom = new JSDOM(HTML, { runScripts: 'outside-only', url: 'chrome-extension://abc/popup.html', pretendToBeVisual: true });
  const { window } = dom;
  opened.push(window);
  const calls = { ports: [], sent: [], tabs: [], storage: {}, fetches: [] };
  let current = status;
  const handlers = {};
  window.chrome = {
    runtime: { connect: (info) => { calls.ports.push(info); return { onDisconnect: { addListener() {} } }; }, sendMessage: async (m) => { calls.sent.push(m); if (handlers[m.type]) return handlers[m.type](m); return m.type === 'status' ? current : { ok: true }; } },
    storage: { local: { get: async (k) => (k === 'prefs' ? { prefs } : k === 'session' ? { session: SESSION } : {}), set: async (o) => Object.assign(calls.storage, o) } },
    permissions: { contains: async () => permissions.has, request: async () => permissions.grant },
    tabs: { create: (o) => calls.tabs.push(o) }
  };
  window.fetch = async (url, init) => { calls.fetches.push({ url, init }); return fetchImpl(url, init); };
  if (preconfig !== undefined) window.AMP_PRECONFIG = preconfig; // what extension/config.js sets before popup.js runs
  window.eval(JS);
  await sleep(30);
  const $ = (id) => window.document.getElementById(id);
  const type = (id, value) => { $(id).value = value; $(id).dispatchEvent(new window.Event('input', { bubbles: true })); };
  const submit = async () => { $('joinForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await sleep(60); };
  return { window, $, calls, handlers, type, submit, setStatus: (s) => { current = s; }, view: () => window.document.body.dataset.view };
}
const jsonRes = (status, body) => ({ ok: status < 400, status, json: async () => body });
const fill = (ui, o = {}) => {
  ui.type('serverUrl', o.server || 'http://localhost:3000'); ui.type('classCode', o.code || 'abc234');
  ui.type('fullName', o.name || 'Ana  Cruz'); ui.type('email', o.email || 'ana@pup.edu.ph');
  ui.$('consent').checked = o.consent !== false;
};

describe('popup: presence', () => {
  test('opening the popup tells the background worker (so the browser window losing focus is not a tab switch)', async () => {
    const ui = await load();
    expect(ui.calls.ports).toEqual([{ name: 'amp-popup' }]);
  });
});

describe('popup: idle (Join Class form)', () => {
  test('shows the join form with no password or token field, prefilled from the last join', async () => {
    const ui = await load({ prefs: { serverUrl: 'https://am.school.edu', name: 'Ana Cruz', email: 'ana@pup.edu.ph' } });
    expect(ui.view()).toBe('idle');
    expect(ui.$('viewJoin').hidden).toBe(false);
    expect(ui.window.document.querySelector('input[type="password"]')).toBeNull();
    expect(ui.$('serverUrl').value).toBe('https://am.school.edu');
    expect(ui.$('fullName').value).toBe('Ana Cruz');
    expect(ui.$('classCode').value).toBe('');
  });

  test('default server is http://localhost:3000; the privacy link follows the server field', async () => {
    const ui = await load();
    expect(ui.$('serverUrl').value).toBe('http://localhost:3000');
    expect(ui.$('privacyLink').getAttribute('href')).toBe('http://localhost:3000/privacy.html');
    ui.type('serverUrl', 'https://am.school.edu/some/path');
    expect(ui.$('privacyLink').getAttribute('href')).toBe('https://am.school.edu/privacy.html');
    ui.type('serverUrl', 'nonsense');
    expect(ui.$('privacyLink').hasAttribute('href')).toBe(false);
  });

  test('class code is forced to upper case, letters and digits only', async () => {
    const ui = await load();
    ui.type('classCode', 'ab-c 2x3');
    expect(ui.$('classCode').value).toBe('ABC2X3');
  });

  test('submitting an empty form shows an inline error per field, marks them invalid and focuses the first; nothing is sent', async () => {
    const ui = await load({ fetchImpl: () => { throw new Error('must not fetch'); } });
    ui.type('serverUrl', '');
    await ui.submit();
    for (const id of ['serverError', 'classCodeError', 'fullNameError', 'emailError', 'consentError']) expect(ui.$(id).hidden).toBe(false);
    expect(ui.$('serverUrl').getAttribute('aria-invalid')).toBe('true');
    expect(ui.window.document.activeElement.id).toBe('serverUrl');
    expect(ui.calls.fetches).toHaveLength(0);
    expect(ui.calls.sent.filter((m) => m.type === 'connect')).toHaveLength(0);
  });

  test('errors clear as soon as the field is fixed; bad email, short code and plain-http remote servers are caught', async () => {
    const ui = await load({ fetchImpl: () => { throw new Error('no'); } });
    fill(ui, { server: 'http://school.example.com', code: 'ab', email: 'nope' });
    await ui.submit();
    expect(ui.$('serverError').textContent).toMatch(/https/);
    expect(ui.$('classCodeError').textContent).toMatch(/6 to 8/);
    expect(ui.$('emailError').textContent).toMatch(/valid email/);
    ui.type('email', 'ana@pup.edu.ph');
    expect(ui.$('emailError').hidden).toBe(true);
    expect(ui.$('email').hasAttribute('aria-invalid')).toBe(false);
  });

  test('every control has a label; groups are fieldsets; the form has a real submit button', async () => {
    const ui = await load();
    const doc = ui.window.document;
    for (const el of doc.querySelectorAll('input')) expect(doc.querySelector(`label[for="${el.id}"]`)).not.toBeNull();
    expect(doc.querySelectorAll('form fieldset').length).toBeGreaterThanOrEqual(3);
    expect(doc.querySelectorAll('fieldset > legend').length).toBe(doc.querySelectorAll('fieldset').length);
    expect(ui.$('joinBtn').type).toBe('submit');
    expect(ui.$('privacyLink').getAttribute('rel')).toMatch(/noopener/);
  });
});

describe('popup: joining -> connected', () => {
  const joinResponse = { token: 'tok.en', expiresAt: Date.now() + 1e7, studentId: 's1', classId: 'c1', classCode: 'ABC234', className: 'Net Admin 101', educatorName: 'Prof', student: { id: 's1', name: 'Ana Cruz', email: 'ana@pup.edu.ph' } };

  test('loading state: fields and button are disabled with a spinner while the request is in flight, then the connected view appears', async () => {
    let release;
    const ui = await load({ fetchImpl: () => new Promise((r) => { release = () => r(jsonRes(201, joinResponse)); }) });
    ui.handlers.connect = async () => { ui.setStatus(connectedStatus()); return { ok: true }; };
    fill(ui);
    const pending = ui.submit();
    await sleep(40);
    expect(ui.view()).toBe('joining');
    expect(ui.$('joinBtn').disabled).toBe(true);
    expect(ui.$('joinBtn').querySelector('.spinner').hidden).toBe(false);
    expect(ui.$('fsClass').disabled).toBe(true);
    expect(ui.$('joinForm').getAttribute('aria-busy')).toBe('true');
    release();
    await pending; await sleep(80);
    expect(ui.view()).toBe('connected');
  });

  test('sends exactly name, email, upper-case class code and consent:true - and no password - then hands the token to the background worker', async () => {
    const ui = await load({ fetchImpl: async () => jsonRes(201, joinResponse), permissions: { has: false, grant: true } });
    ui.handlers.connect = async () => ({ ok: true });
    fill(ui);
    await ui.submit();
    const { url, init } = ui.calls.fetches[0];
    expect(url).toBe('http://localhost:3000/api/extension/join');
    expect(JSON.parse(init.body)).toEqual({ name: 'Ana Cruz', email: 'ana@pup.edu.ph', classCode: 'ABC234', consent: true });
    const connect = ui.calls.sent.find((m) => m.type === 'connect');
    expect(connect.session).toMatchObject({ serverUrl: 'http://localhost:3000', token: 'tok.en', classId: 'c1', className: 'Net Admin 101' });
    expect(ui.calls.storage.prefs).toEqual({ serverUrl: 'http://localhost:3000', name: 'Ana Cruz', email: 'ana@pup.edu.ph' });
    expect(ui.$('classCode').value).toBe('');
    expect(ui.$('consent').checked).toBe(false);
  });

  test('a refused permission request stops the join before anything is sent', async () => {
    const ui = await load({ fetchImpl: () => { throw new Error('no'); }, permissions: { has: false, grant: false } });
    fill(ui, { server: 'https://am.school.edu' });
    await ui.submit();
    expect(ui.calls.fetches).toHaveLength(0);
    expect(ui.$('banner').hidden).toBe(false);
    expect(ui.$('bannerText').textContent).toMatch(/permission/);
    expect(ui.view()).toBe('idle');
  });

  test('unknown class code -> inline error on the class code; network failure -> banner with Try again', async () => {
    let mode = 404;
    const ui = await load({ fetchImpl: async () => { if (mode === 'net') throw new TypeError('fail'); return jsonRes(404, { error: 'No class found' }); } });
    fill(ui);
    await ui.submit();
    expect(ui.$('classCodeError').textContent).toMatch(/No class found/);
    expect(ui.window.document.activeElement.id).toBe('classCode');
    mode = 'net';
    await ui.submit();
    expect(ui.$('bannerText').textContent).toMatch(/Can’t reach the server/);
    expect(ui.$('bannerAction').textContent).toBe('Try again');
    expect(ui.$('banner').getAttribute('role')).toBe('alert');
    expect(ui.view()).toBe('idle');
  });

  test('server-side validation messages land on the matching fields', async () => {
    const ui = await load({ fetchImpl: async () => jsonRes(400, { error: 'Validation failed', message: 'email: Enter a valid email address', details: [{ path: ['email'], message: 'Enter a valid email address' }] }) });
    fill(ui);
    await ui.submit();
    expect(ui.$('emailError').textContent).toBe('Enter a valid email address');
  });
});

describe('popup: connected / reconnecting / actions', () => {
  test('connected: class, code, student, live score ring, state badge and connection health', async () => {
    const ui = await load({ status: connectedStatus({ score: 72, state: 'Passive' }) });
    expect(ui.view()).toBe('connected');
    expect(ui.$('factClass').textContent).toBe('Net Admin 101');
    expect(ui.$('factCode').textContent).toBe('ABC234');
    expect(ui.$('factName').textContent).toBe('Ana Cruz');
    expect(ui.$('factEmail').textContent).toBe('ana@pup.edu.ph');
    expect(ui.$('scoreText').textContent).toBe('72');
    expect(ui.$('stateBadge').textContent).toBe('Passive');
    expect(ui.$('ring').getAttribute('aria-label')).toBe('Attentiveness score 72 out of 100, Passive');
    expect(ui.$('ring').style.getPropertyValue('--ring-offset')).toBe(String(Math.round(2 * Math.PI * 40 * 0.28 * 100) / 100));
    expect(ui.$('factHealth').textContent).toMatch(/^Connected/);
    expect(ui.$('banner').hidden).toBe(true);
  });

  test.each(['Focused', 'Passive', 'Distracted', 'Idle'])('state badge: %s', async (state) => {
    const ui = await load({ status: connectedStatus({ state, score: 50 }) });
    expect(ui.$('stateBadge').textContent).toBe(state);
    expect(ui.$('ring').dataset.state).toBe(state);
  });

  test('no class tab yet: placeholder score, Idle badge and a hint, not an invented number', async () => {
    const ui = await load({ status: connectedStatus({ score: null, state: null, meetingTabs: 0 }) });
    expect(ui.$('scoreText').textContent).toBe('--');
    expect(ui.$('stateBadge').textContent).toBe('Idle');
    expect(ui.$('stateHint').textContent).toMatch(/Meet or Zoom/);
  });

  test('flags the educator sees are shown to the student in the same words', async () => {
    const ui = await load({ status: connectedStatus({ reasons: ['Switching between tabs or apps rapidly.'] }) });
    expect(ui.$('reasons').hidden).toBe(false);
    expect(ui.$('reasons').textContent).toMatch(/Switching between tabs/);
  });

  test('reconnecting: warning banner explains it and Retry asks the background worker to reconnect', async () => {
    const ui = await load({ status: connectedStatus({ health: 'reconnecting', attempts: 3, buffered: 4 }) });
    expect(ui.view()).toBe('reconnecting');
    expect(ui.$('banner').hidden).toBe(false);
    expect(ui.$('banner').dataset.kind).toBe('warn');
    expect(ui.$('bannerText').textContent).toMatch(/Can’t reach the server/);
    expect(ui.$('factHealth').textContent).toMatch(/attempt 3/);
    expect(ui.$('factHealth').textContent).toMatch(/4 readings saved/);
    expect(ui.$('bannerAction').textContent).toBe('Retry');
    ui.$('bannerAction').click();
    await sleep(30);
    expect(ui.calls.sent.some((m) => m.type === 'retry')).toBe(true);
  });

  test('backup (REST) connection is explained too', async () => {
    const ui = await load({ status: connectedStatus({ health: 'fallback' }) });
    expect(ui.$('banner').dataset.kind).toBe('info');
    expect(ui.$('bannerText').textContent).toMatch(/backup connection/);
  });

  test('"Open Web Dashboard (Optional)" opens <server>/student.html?token=<token> in a new tab', async () => {
    const ui = await load({ status: connectedStatus() });
    expect(ui.$('openDashboard').textContent).toBe('Open Web Dashboard (Optional)');
    ui.$('openDashboard').click();
    await sleep(30);
    expect(ui.calls.tabs).toEqual([{ url: 'http://localhost:3000/student.html?token=tok.en' }]);
  });

  test('"Switch Class / Disconnect" stops monitoring and returns to the Join form with the class code empty', async () => {
    const ui = await load({ status: connectedStatus() });
    ui.handlers.disconnect = async () => { ui.setStatus(idleStatus()); return { ok: true }; };
    expect(ui.$('disconnectBtn').textContent).toBe('Switch Class / Disconnect');
    ui.$('disconnectBtn').click();
    await sleep(80);
    expect(ui.calls.sent.some((m) => m.type === 'disconnect')).toBe(true);
    expect(ui.view()).toBe('idle');
    expect(ui.$('classCode').value).toBe('');
    expect(ui.window.document.activeElement.id).toBe('classCode');
  });

  test('a session that ended (expired / revoked) shows its reason on the Join form with a Dismiss button', async () => {
    const ui = await load({ status: idleStatus({ notice: { kind: 'revoked', text: 'You withdrew your consent. Monitoring has stopped.' } }) });
    expect(ui.view()).toBe('idle');
    expect(ui.$('bannerText').textContent).toMatch(/withdrew your consent/);
    ui.$('bannerAction').click();
    await sleep(30);
    expect(ui.calls.sent.some((m) => m.type === 'dismissNotice')).toBe(true);
  });

  test('state changes are announced to screen readers once, not every second', async () => {
    const ui = await load({ status: connectedStatus({ state: 'Focused' }) });
    const live = ui.$('live');
    const first = live.textContent;
    expect(first).toMatch(/^Focused/);
    await sleep(1100);
    expect(live.textContent).toBe(first);
  });
});

describe('popup: WCAG AA contrast of the stylesheet colours', () => {
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  // Every text / background pair the Attentix popup stylesheet uses (maroon + gold on white and light gray).
  const pairs = [
    ['#211b1b', '#ffffff', 4.5], ['#605857', '#ffffff', 4.5], ['#605857', '#f5f3f2', 4.5], ['#ffffff', '#800000', 4.5], ['#a4161a', '#ffffff', 4.5],
    ['#800000', '#ffffff', 4.5], ['#800000', '#f7ebeb', 4.5],
    ['#14532d', '#e8f4ed', 4.5], ['#5c4400', '#fbf3d6', 4.5], ['#7a1013', '#fbe9e9', 4.5], ['#3a3232', '#eeeae8', 4.5],
    ['#4a0000', '#f7ebeb', 4.5],
    // ring arc colours are graphics against the white card: 3:1 is the bar (WCAG 1.4.11)
    ['#1b6b43', '#ffffff', 3], ['#7a5a00', '#ffffff', 3], ['#605857', '#ffffff', 3],
    // control edges and the keyboard focus ring
    ['#8c8482', '#ffffff', 3], ['#800000', '#ffffff', 3]
  ];
  test.each(pairs)('%s on %s >= %s:1', (fg, bg, min) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(min);
    for (const hex of [fg, bg]) if (hex !== '#ffffff') expect(CSS.toLowerCase()).toContain(hex);
  });

  // Toolbar badge: white text on each state colour (defined in background.js, not in the popup stylesheet).
  const BACKGROUND = fs.readFileSync(path.join(DIR, 'background.js'), 'utf8').toLowerCase();
  test.each(['#15803d', '#7a5a00', '#b91c1c', '#475569', '#b45309'])('toolbar badge: white on %s >= 4.5:1', (hex) => {
    expect(ratio('#ffffff', hex)).toBeGreaterThanOrEqual(4.5);
    expect(BACKGROUND).toContain(hex);
  });

  test('spacing uses the 4px / 8px scale', () => {
    for (const [, v] of CSS.matchAll(/--s-\d:\s*(\d+)px/g)) expect(Number(v) % 4).toBe(0);
  });
  test('keyboard focus is visible', () => { expect(CSS).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px/); });
});

describe('popup: pre-configured by the professor\'s server (config.js)', () => {
  const PRE = { serverUrl: 'http://192.168.1.20:3000', classCode: 'ABC234' };
  const joinResponse = { token: 'tok.en', expiresAt: Date.now() + 1e7, studentId: 's1', classId: 'c1', classCode: 'ABC234', className: 'Net Admin 101', educatorName: 'Prof', student: { id: 's1', name: 'Ana Cruz', email: 'ana@pup.edu.ph' } };

  test('Server address and Class code arrive pre-filled; the server field is tucked under Advanced settings but its address stays visible', async () => {
    const ui = await load({ preconfig: PRE });
    expect(ui.$('serverUrl').value).toBe('http://192.168.1.20:3000');
    expect(ui.$('classCode').value).toBe('ABC234');
    expect(ui.$('advanced').open).toBe(false);
    expect(ui.$('serverNotice').hidden).toBe(false);
    expect(ui.$('serverShown').textContent).toBe('http://192.168.1.20:3000');
    expect(ui.$('advanced').contains(ui.$('serverUrl'))).toBe(true);
    expect(ui.$('advanced').contains(ui.$('classCode'))).toBe(false);
    expect(ui.$('privacyLink').getAttribute('href')).toBe('http://192.168.1.20:3000/privacy.html');
  });

  test('the student only types name, email and ticks consent: the join goes to the pre-configured server and class', async () => {
    const ui = await load({ preconfig: PRE, fetchImpl: async () => jsonRes(201, joinResponse) });
    ui.type('fullName', 'Ana Cruz'); ui.type('email', 'ana@pup.edu.ph'); ui.$('consent').checked = true;
    await ui.submit();
    expect(ui.calls.fetches).toHaveLength(1);
    expect(ui.calls.fetches[0].url).toBe('http://192.168.1.20:3000/api/extension/join');
    expect(JSON.parse(ui.calls.fetches[0].init.body)).toEqual({ name: 'Ana Cruz', email: 'ana@pup.edu.ph', classCode: 'ABC234', consent: true });
    expect(ui.$('serverError').hidden).toBe(true);
  });

  test('a private-network http:// address is accepted (that is the whole point of a classroom server); a public one still needs https', async () => {
    for (const ok of ['http://192.168.1.20:3000', 'http://10.0.0.5:3000', 'http://172.16.4.4:3000', 'http://prof-laptop.local:3000', 'http://localhost:3000']) {
      const ui = await load({ fetchImpl: async () => jsonRes(201, joinResponse) });
      fill(ui, { server: ok });
      await ui.submit();
      expect(ui.$('serverError').hidden).toBe(true);
      expect(ui.calls.fetches).toHaveLength(1);
    }
    for (const bad of ['http://school.example.com', 'http://8.8.8.8', 'http://192.168.1.20.evil.com', 'http://172.32.0.1']) {
      const ui = await load({ fetchImpl: () => { throw new Error('must not be called'); } });
      fill(ui, { server: bad });
      await ui.submit();
      expect(ui.$('serverError').textContent).toMatch(/https/);
      expect(ui.calls.fetches).toHaveLength(0);
    }
  });

  test('an error on the tucked-away server field opens Advanced settings so it can be seen and fixed', async () => {
    const ui = await load({ preconfig: { serverUrl: 'https://am.school.edu', classCode: 'ABC234' }, fetchImpl: () => { throw new Error('no'); } });
    expect(ui.$('advanced').open).toBe(false);
    ui.type('serverUrl', 'http://school.example.com');
    ui.type('fullName', 'Ana Cruz'); ui.type('email', 'ana@pup.edu.ph'); ui.$('consent').checked = true;
    await ui.submit();
    expect(ui.$('advanced').open).toBe(true);
    expect(ui.$('serverError').hidden).toBe(false);
  });

  test('editing the server by hand hides the "Connecting to..." notice so it never claims a stale address', async () => {
    const ui = await load({ preconfig: PRE });
    ui.type('serverUrl', 'http://192.168.1.99:3000');
    expect(ui.$('serverNotice').hidden).toBe(true);
  });

  test('the educator\'s address beats an older remembered one; the remembered name and email still prefill', async () => {
    const ui = await load({ preconfig: PRE, prefs: { serverUrl: 'http://10.9.9.9:3000', name: 'Ana Cruz', email: 'ana@pup.edu.ph' } });
    expect(ui.$('serverUrl').value).toBe('http://192.168.1.20:3000');
    expect(ui.$('fullName').value).toBe('Ana Cruz');
    expect(ui.$('email').value).toBe('ana@pup.edu.ph');
  });

  test('without config.js values it behaves as before: Advanced is open, no notice, remembered / default address', async () => {
    for (const preconfig of [undefined, {}, { serverUrl: '', classCode: '' }]) {
      const ui = await load({ preconfig, prefs: { serverUrl: 'https://am.school.edu' } });
      expect(ui.$('advanced').open).toBe(true);
      expect(ui.$('serverNotice').hidden).toBe(true);
      expect(ui.$('serverUrl').value).toBe('https://am.school.edu');
      expect(ui.$('classCode').value).toBe('');
    }
    expect((await load()).$('serverUrl').value).toBe('http://localhost:3000');
  });

  test.each([
    ['a non-http address and a bad code', { serverUrl: 'javascript:alert(1)', classCode: '<b>' }],
    ['garbage', { serverUrl: 42, classCode: ['x'] }],
    ['a null config', null],
    ['a string config', 'http://evil.example']
  ])('invalid values are ignored, never trusted (%s)', async (_label, preconfig) => {
    const ui = await load({ preconfig });
    expect(ui.$('serverUrl').value).toBe('http://localhost:3000');
    expect(ui.$('advanced').open).toBe(true);
    expect(ui.$('serverNotice').hidden).toBe(true);
    expect(ui.$('classCode').value).toBe('');
  });

  test('a malformed class code in config.js is dropped but a valid server is kept; the code is upper-cased and trimmed', async () => {
    const a = await load({ preconfig: { serverUrl: PRE.serverUrl, classCode: 'x' } });
    expect(a.$('classCode').value).toBe('');
    expect(a.$('serverUrl').value).toBe(PRE.serverUrl);
    const b = await load({ preconfig: { serverUrl: PRE.serverUrl, classCode: '  abc234 ' } });
    expect(b.$('classCode').value).toBe('ABC234');
  });

  test('the shown server address is rendered as text, never as markup', async () => {
    const ui = await load({ preconfig: { serverUrl: 'http://192.168.1.20:3000/<img src=x onerror=alert(1)>', classCode: '' } });
    expect(ui.window.document.querySelector('#serverNotice img')).toBeNull();
    expect(ui.$('serverShown').textContent).toBe('http://192.168.1.20:3000'); // reduced to the origin
  });

  test('"Switch Class / Disconnect" returns to the form with the pre-configured class code, consent cleared', async () => {
    const ui = await load({ preconfig: PRE, status: connectedStatus() });
    ui.handlers.disconnect = async () => { ui.setStatus(idleStatus()); return { ok: true }; };
    ui.$('disconnectBtn').click();
    await sleep(60);
    expect(ui.view()).toBe('idle');
    expect(ui.$('classCode').value).toBe('ABC234');
    expect(ui.$('consent').checked).toBe(false);
  });
});
