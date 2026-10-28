/** educator-dashboard.html: server address card, "Shut down server", and the per-class pre-configured extension download. */
const { boot, cleanup, stubChart } = require('./domHarness');

afterEach(cleanup);

const CLASS = { id: '11111111-1111-4111-8111-111111111111', classId: '11111111-1111-4111-8111-111111111111', name: 'Math 101', section: 'A', classCode: 'ABC234', educatorName: 'Prof Reyes', studentCount: 4, activeCount: 3 };
const INFO = {
  port: 3000, localUrl: 'http://localhost:3000', lanUrl: 'http://192.168.1.20:3000', lanUrls: ['http://192.168.1.20:3000', 'http://10.0.0.5:3000'],
  hasLan: true, publicUrl: null, preferredUrl: 'http://192.168.1.20:3000', version: '2.1.0', packaged: false, canShutdown: false
};

const baseOpen = async ({ info = INFO, infoStatus = 200, downloadResponse, extraRoutes = {}, confirm = true } = {}) => {
  const writeText = jest.fn().mockResolvedValue();
  const clicks = [];
  const downloads = [];
  const t = boot({
    page: 'educator-dashboard.html', url: 'http://localhost/educator-dashboard.html',
    routes: {
      'GET /api/me': { status: 200, body: { user: { id: 'e', role: 'educator', name: 'Prof Reyes' } } },
      'GET /api/educator/classes': { status: 200, body: { classes: [CLASS] } },
      'GET /api/server-info': { status: infoStatus, body: infoStatus === 200 ? info : { error: 'nope' } },
      ...extraRoutes
    },
    setup: (w) => {
      stubChart(w, []);
      Object.defineProperty(w.navigator, 'clipboard', { value: { writeText }, configurable: true });
      w.io = () => ({ on() {}, emit: (n, p, ack) => { if (typeof ack === 'function') ack({ ok: true }); }, close: jest.fn() });
      const base = w.fetch;
      w.fetch = async (u, init) => {
        if (String(u).startsWith('/api/extension/preconfigured')) { downloads.push({ url: u, init }); return downloadResponse ? downloadResponse() : { ok: true, status: 200, headers: { get: () => 'http://192.168.1.20:3000' }, blob: async () => ({ size: 1 }) }; }
        return base(u, init);
      };
      w.URL.createObjectURL = () => 'blob:fake-url';
      w.URL.revokeObjectURL = jest.fn();
      w.HTMLAnchorElement.prototype.click = function click() { clicks.push({ href: this.getAttribute('href'), download: this.getAttribute('download') }); };
      w.AM.confirmDialog = jest.fn().mockResolvedValue(confirm); // educator.js captures it when it loads
    },
    scripts: ['chartMatrix.js', 'educator.js']
  });
  await t.tick(60);
  return { ...t, writeText, clicks, downloads };
};

const open = baseOpen;

describe('server address card', () => {
  test('shows the address students should use, and the other ways in', async () => {
    const t = await open();
    expect(t.byId('serverSection').hidden).toBe(false);
    expect(t.byId('serverAddress').textContent).toBe('http://192.168.1.20:3000');
    expect(t.byId('serverLocal').textContent).toBe('Also reachable at: http://localhost:3000 · http://10.0.0.5:3000');
    expect(t.byId('serverNoLan').hidden).toBe(true);
    expect(t.byId('serverHttpNote').hidden).toBe(false); // plain http on a LAN: say so
  });

  test('Copy address copies the preferred address and confirms inline (status region) and in a toast', async () => {
    const t = await open();
    t.byId('copyServerBtn').click();
    await t.tick();
    expect(t.writeText).toHaveBeenCalledWith('http://192.168.1.20:3000');
    expect(t.byId('serverCopyStatus').getAttribute('role')).toBe('status');
    expect(t.byId('serverCopyStatus').textContent).toBe('Server address copied.');
  });

  test('a public https address shows no http warning and no "other ways in" noise', async () => {
    const t = await open({ info: { ...INFO, publicUrl: 'https://am.school.edu', preferredUrl: 'https://am.school.edu', lanUrls: [], lanUrl: null, hasLan: false } });
    expect(t.byId('serverAddress').textContent).toBe('https://am.school.edu');
    expect(t.byId('serverHttpNote').hidden).toBe(true);
    expect(t.byId('serverNoLan').hidden).toBe(true);
  });

  test('with no network it warns that only this computer can reach the server, and does not nag about http for localhost', async () => {
    const t = await open({ info: { ...INFO, hasLan: false, lanUrl: null, lanUrls: [], preferredUrl: 'http://localhost:3000' } });
    expect(t.byId('serverAddress').textContent).toBe('http://localhost:3000');
    expect(t.byId('serverNoLan').hidden).toBe(false);
    expect(t.byId('serverHttpNote').hidden).toBe(true);
  });

  test('if the server-info call fails the card stays hidden and the rest of the dashboard still works', async () => {
    const t = await open({ infoStatus: 500 });
    expect(t.byId('serverSection').hidden).toBe(true);
    expect(t.$('.class-card .class-code').textContent).toBe('ABC234');
  });
});

describe('Shut down server', () => {
  test('hidden unless the server says this is the local computer (canShutdown)', async () => {
    expect((await open()).byId('shutdownRow').hidden).toBe(true);
    cleanup();
    expect((await open({ info: { ...INFO, canShutdown: true } })).byId('shutdownRow').hidden).toBe(false);
  });

  test('asks first; cancelling sends nothing', async () => {
    const t = await open({ info: { ...INFO, canShutdown: true }, confirm: false, extraRoutes: { 'POST /api/server/shutdown': { status: 200, body: { ok: true } } } });
    t.byId('shutdownBtn').click();
    await t.tick(60);
    expect(t.calls.some((c) => c.key === 'POST /api/server/shutdown')).toBe(false);
    expect(t.byId('main').textContent).not.toMatch(/Server stopped/);
  });

  test('confirming posts to the server and replaces the page with a "you can close this tab" message', async () => {
    const t = await open({ info: { ...INFO, canShutdown: true }, extraRoutes: { 'POST /api/server/shutdown': { status: 200, body: { ok: true } } } });
    t.byId('shutdownBtn').click();
    await t.tick(60);
    expect(t.calls.filter((c) => c.key === 'POST /api/server/shutdown')).toHaveLength(1);
    expect(t.byId('main').textContent).toMatch(/Server stopped/);
    expect(t.byId('main').textContent).toMatch(/close this tab/);
  });

  test('a refused shutdown shows the server\'s message and leaves the dashboard in place', async () => {
    const t = await open({ info: { ...INFO, canShutdown: true }, extraRoutes: { 'POST /api/server/shutdown': { status: 403, body: { error: 'The server can only be shut down from the computer it runs on.' } } } });
    t.byId('shutdownBtn').click();
    await t.tick(60);
    expect(t.byId('toast').textContent).toMatch(/only be shut down from the computer it runs on/);
    expect(t.byId('main').textContent).not.toMatch(/Server stopped/);
    expect(t.$('.class-card')).not.toBeNull();
  });
});

describe('Log out on the computer that runs the app', () => {
  test('the button says it also stops the server, but only when the server can stop', async () => {
    expect((await open()).byId('logoutBtn').textContent).toBe('Log out');
    cleanup();
    const t = await open({ info: { ...INFO, canShutdown: true } });
    expect(t.byId('logoutBtn').textContent).toBe('Log out & stop server');
    expect(t.byId('logoutBtn').title).toMatch(/stops Attentix/);
  });

  test('when the server stopped, the page says so instead of navigating to a login page nobody can serve', async () => {
    const t = await open({ info: { ...INFO, canShutdown: true }, extraRoutes: { 'POST /api/server/sign-out': { status: 200, body: { message: 'Logout successful', stopped: true } } } });
    t.byId('logoutBtn').click();
    await t.tick(60);
    expect(t.calls.filter((c) => c.key === 'POST /api/server/sign-out')).toHaveLength(1);
    expect(t.byId('main').textContent).toMatch(/Signed out. Server stopped/);
    expect(t.byId('main').textContent).toMatch(/close this tab/);
  });

  test('a plain sign-out (server keeps running) goes back to the login page', async () => {
    const t = await open({ extraRoutes: { 'POST /api/server/sign-out': { status: 200, body: { message: 'Logout successful', stopped: false } } } });
    t.byId('logoutBtn').click();
    await t.tick(60);
    expect(t.byId('main').textContent).not.toMatch(/Server stopped/);
  });
});

describe('Download Pre-Configured Student Extension', () => {
  // The tool lives on the class's own page (#class/<id>), next to its permanent code and invite link.
  const button = (t) => t.byId('dashDownloadBtn');
  const open = async (options) => {
    const t = await baseOpen(options);
    t.window.location.hash = `#class/${CLASS.id}`;
    await t.tick(60);
    return t;
  };

  test('the class page has the button next to its permanent code, and the class list does not repeat it', async () => {
    const t = await open();
    const btn = button(t);
    expect(btn.textContent).toBe('Download Pre-Configured Student Extension');
    expect(t.byId('dashClassCode').textContent).toBe('ABC234');
    expect(t.byId('classList').textContent).not.toMatch(/Pre-Configured/);
  });

  test('the how-to for students is on the page', async () => {
    const t = await open();
    expect(t.window.document.body.textContent).toMatch(/unzips it/);
    expect(t.window.document.body.textContent).toMatch(/Load unpacked/);
  });

  test('clicking requests exactly this class\'s code and saves Attentix-Extension-<CODE>.zip, then says which server it targets', async () => {
    const t = await open();
    button(t).click();
    await t.tick(60);
    expect(t.downloads).toHaveLength(1);
    expect(t.downloads[0].url).toBe('/api/extension/preconfigured?classCode=ABC234');
    expect(t.downloads[0].init).toEqual({ credentials: 'same-origin' });
    expect(t.clicks).toEqual([{ href: 'blob:fake-url', download: 'Attentix-Extension-ABC234.zip' }]);
    expect(t.byId('toast').textContent).toBe('Extension downloaded, set up for http://192.168.1.20:3000');
    expect(t.window.document.querySelector('body > a[download]')).toBeNull(); // the temporary link is removed
  });

  test('a server error is shown as a message; nothing is saved (no JSON error body in a .zip file)', async () => {
    const t = await open({ downloadResponse: () => ({ ok: false, status: 404, json: async () => ({ error: 'No class found for that class code' }) }) });
    button(t).click();
    await t.tick(60);
    expect(t.clicks).toEqual([]);
    expect(t.byId('toast').textContent).toBe('No class found for that class code');
  });

  test('an unreadable error body falls back to a plain message', async () => {
    const t = await open({ downloadResponse: () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }) });
    button(t).click();
    await t.tick(60);
    expect(t.clicks).toEqual([]);
    expect(t.byId('toast').textContent).toBe('Could not prepare the extension.');
  });

  test('the button is disabled while preparing, so a double click cannot start two downloads', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const t = await open({ downloadResponse: async () => { await gate; return { ok: true, status: 200, headers: { get: () => null }, blob: async () => ({}) }; } });
    const btn = button(t);
    btn.click();
    await t.tick();
    expect(btn.disabled).toBe(true);
    btn.click();
    release();
    await t.tick(60);
    expect(t.downloads).toHaveLength(1);
    expect(btn.disabled).toBe(false);
    expect(t.byId('toast').textContent).toBe('Extension downloaded');
  });
});
