/** Attentix shell: three tabs (Home, Classes, Settings) on the educator dashboard and the student page. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { boot, cleanup, read, stubChart } = require('./domHarness');

afterEach(cleanup);

const PUBLIC = path.join(__dirname, '../../public');
const doc = (file) => new JSDOM(read(file)).window.document;

describe.each(['educator-dashboard.html', 'student.html'])('%s: tab markup', (page) => {
  const d = doc(page);
  const tabs = [...d.querySelectorAll('[role="tab"]')];

  test('has exactly three tabs, in order: Home, Classes, Settings', () => {
    expect(tabs.map((t) => t.textContent.trim())).toEqual(['Home', 'Classes', 'Settings']);
    expect(tabs.map((t) => t.dataset.tab)).toEqual(['home', 'classes', 'settings']);
  });

  test('every tab controls an existing tabpanel that points back at it', () => {
    for (const tab of tabs) {
      const panel = d.getElementById(tab.getAttribute('aria-controls'));
      expect(panel).not.toBeNull();
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    }
  });

  test('Home starts selected and visible; the other panels start hidden and their tabs are out of the tab order', () => {
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs.map((t) => d.getElementById(t.getAttribute('aria-controls')).hidden)).toEqual([false, true, true]);
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual([null, '-1', '-1']);
  });

  test('the tabs sit in a labelled navigation landmark; each panel has its own h1', () => {
    expect(d.querySelector('nav[aria-label="Main"] [role="tab"]')).not.toBeNull();
    for (const tab of tabs) expect(d.getElementById(tab.getAttribute('aria-controls')).querySelectorAll('h1')).toHaveLength(1);
  });

  test('the Settings panel hosts the generated Appearance / Accessibility / General sections and a section menu', () => {
    const panel = d.getElementById('panel-settings');
    expect(panel.contains(d.getElementById('settingsRoot'))).toBe(true);
    expect(panel.querySelector('nav[aria-label="Settings sections"]')).not.toBeNull();
    expect([...panel.querySelectorAll('.settings-nav a')].slice(0, 3).map((a) => a.getAttribute('href'))).toEqual(['#settings-appearance', '#settings-accessibility', '#settings-general']);
  });

  test('loads nav.js as a same-origin script', () => {
    expect([...d.querySelectorAll('script')].map((s) => s.getAttribute('src'))).toContain('/js/nav.js');
    expect(fs.existsSync(path.join(PUBLIC, 'js/nav.js'))).toBe(true);
  });
});

describe('nav.js behaviour', () => {
  const open = (page = 'educator-dashboard.html', url = `http://localhost/${page}`) => boot({ page, url, scripts: ['nav.js'] });
  const visiblePanels = (t) => [...t.window.document.querySelectorAll('[role="tabpanel"]')].filter((p) => !p.hidden).map((p) => p.id);
  const key = (t, el, k) => el.dispatchEvent(new t.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  test('clicking a tab shows only its panel, updates aria-selected and the URL hash', () => {
    const t = open();
    t.$('#tab-classes').click();
    expect(visiblePanels(t)).toEqual(['panel-classes']);
    expect(t.$('#tab-classes').getAttribute('aria-selected')).toBe('true');
    expect(t.$('#tab-home').getAttribute('aria-selected')).toBe('false');
    expect(t.window.location.hash).toBe('#classes');
    t.$('#tab-settings').click();
    expect(visiblePanels(t)).toEqual(['panel-settings']);
  });

  test('arrow keys, Home and End move between tabs and wrap around; focus follows', () => {
    const t = open();
    const [home, classes, settings] = ['tab-home', 'tab-classes', 'tab-settings'].map((id) => t.byId(id));
    key(t, home, 'ArrowRight');
    expect(visiblePanels(t)).toEqual(['panel-classes']);
    expect(t.window.document.activeElement).toBe(classes);
    key(t, classes, 'End');
    expect(t.window.document.activeElement).toBe(settings);
    key(t, settings, 'ArrowRight'); // wraps to Home
    expect(visiblePanels(t)).toEqual(['panel-home']);
    key(t, home, 'ArrowLeft'); // wraps to Settings
    expect(visiblePanels(t)).toEqual(['panel-settings']);
  });

  test('a link with data-goto switches tabs', () => {
    const t = open();
    const link = t.window.document.createElement('a');
    link.setAttribute('data-goto', 'classes');
    t.window.document.body.append(link);
    link.click();
    expect(visiblePanels(t)).toEqual(['panel-classes']);
  });

  test('opens on the tab named in the URL hash', () => {
    expect(visiblePanels(open('educator-dashboard.html', 'http://localhost/educator-dashboard.html#settings'))).toEqual(['panel-settings']);
  });

  test('a hash that points inside a panel (#privacyControls) opens that panel', () => {
    const t = open('student.html', 'http://localhost/student.html#privacyControls');
    expect(visiblePanels(t)).toEqual(['panel-settings']);
  });

  test('page scripts can switch with AMNav.show, and an unknown tab is refused', () => {
    const t = open();
    expect(t.window.AMNav.show('classes')).toBe(true);
    expect(t.window.AMNav.current()).toBe('classes');
    expect(t.window.AMNav.show('nope')).toBe(false);
    expect(t.window.AMNav.current()).toBe('classes');
  });
});

describe('a11y.js: display settings live in the Settings tab', () => {
  test('pages with the Settings page get no second toolbar; every other page keeps it after the skip link', async () => {
    const t = boot({ page: 'educator-dashboard.html', url: 'http://localhost/educator-dashboard.html', scripts: ['a11y.js'] });
    await t.tick(30); // the toolbar is built on DOMContentLoaded
    expect(t.$('.a11y-bar')).toBeNull();
    const login = boot({ page: 'login.html', url: 'http://localhost/login.html', scripts: ['a11y.js'] });
    await login.tick(30);
    expect(login.$('.skip-link').nextElementSibling).toBe(login.$('.a11y-bar'));
  });
});

describe('educator dashboard: Home + Classes wiring', () => {
  const CLASS = { id: '11111111-1111-4111-8111-111111111111', name: 'Math 101', section: 'A', classCode: 'ABC234', educatorName: 'Prof Reyes', studentCount: 4, activeCount: 3 };
  const OTHER = { ...CLASS, id: '22222222-2222-4222-8222-222222222222', name: 'Physics', classCode: 'XYZ789', studentCount: 6, activeCount: 0 };
  const open = async () => {
    const t = boot({
      page: 'educator-dashboard.html', url: 'http://localhost/educator-dashboard.html',
      routes: {
        'GET /api/me': { status: 200, body: { user: { id: 'e', role: 'educator', name: 'Prof Reyes' } } },
        'GET /api/educator/classes': { status: 200, body: { classes: [CLASS, OTHER] } },
        'GET /api/server-info': { status: 500, body: { error: 'nope' } }
      },
      setup: (w) => { stubChart(w, []); w.io = () => ({ on() {}, emit: (n, p, ack) => { if (typeof ack === 'function') ack({ ok: true }); }, close() {} }); },
      scripts: ['nav.js', 'chartMatrix.js', 'educator.js']
    });
    await t.tick(60);
    return t;
  };

  test('Home shows the overview totals taken from the class list', async () => {
    const t = await open();
    expect(t.byId('homeClasses').textContent).toBe('2');
    expect(t.byId('homeStudents').textContent).toBe('10');
    expect(t.byId('homeActive').textContent).toBe('3');
  });

  test('a class opens on its own page: the Classes tab stays highlighted and only that class is shown', async () => {
    const t = await open();
    t.$('#tab-classes').click();
    expect(t.byId('panel-classes').hidden).toBe(false);
    t.$('#classList .class-card a').click(); // Math 101 (A-Z first)
    await t.tick(60);
    expect(t.window.AMNav.current()).toBe('class');
    expect(t.window.AMNav.param()).toBe(CLASS.id);
    expect(t.byId('panel-class').hidden).toBe(false);
    expect(t.byId('panel-classes').hidden).toBe(true);
    expect(t.byId('panel-home').hidden).toBe(true);
    expect(t.$('#tab-classes').getAttribute('aria-selected')).toBe('true');
    expect(t.byId('dashboardSection').classList.contains('hidden')).toBe(false);
    expect(t.byId('dashboardClassTitle').textContent).toBe('Math 101 — A');
    expect(t.byId('dashClassCode').textContent).toBe('ABC234');
    expect(t.byId('panel-class').textContent).not.toMatch(/Physics|XYZ789/); // no other class on this page
  });
});

describe('branding', () => {
  const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html'));
  test.each(pages)('%s is titled for Attentix and no longer mentions the old name', (page) => {
    const html = read(page);
    expect(html).toMatch(/<title>[^<]* · Attentix<\/title>/);
    expect(html).not.toMatch(/Attention Monitor/i);
  });
  test('the extension popup, manifest and in-meeting HUD say Attentix', () => {
    const ext = path.join(__dirname, '../../extension');
    expect(fs.readFileSync(path.join(ext, 'popup.html'), 'utf8')).toMatch(/<h1 id="appTitle">Attentix<\/h1>/);
    expect(JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8')).name).toMatch(/^Attentix/);
    expect(fs.readFileSync(path.join(ext, 'content.js'), 'utf8')).toMatch(/Attentix on ·/);
  });
});

describe('after the server stops', () => {
  test('the tabs are retired along with the page content (there is nowhere left to navigate)', async () => {
    const t = boot({
      page: 'educator-dashboard.html', url: 'http://localhost/educator-dashboard.html',
      routes: {
        'GET /api/me': { status: 200, body: { user: { id: 'e', role: 'educator', name: 'Prof Reyes' } } },
        'GET /api/educator/classes': { status: 200, body: { classes: [] } },
        'GET /api/server-info': { status: 200, body: { port: 3000, localUrl: 'http://localhost:3000', lanUrls: [], hasLan: false, publicUrl: null, preferredUrl: 'http://localhost:3000', canShutdown: true } },
        'POST /api/server/shutdown': { status: 200, body: { ok: true } }
      },
      setup: (w) => { stubChart(w, []); w.io = () => ({ on() {}, emit() {}, close() {} }); w.AM.confirmDialog = async () => true; },
      scripts: ['nav.js', 'chartMatrix.js', 'educator.js']
    });
    await t.tick(60);
    t.byId('shutdownBtn').click();
    await t.tick(60);
    expect(t.byId('main').textContent).toMatch(/Server stopped/);
    expect(t.byId('appNav').hidden).toBe(true);
    expect(t.byId('liveBadge').textContent).toBe('Server stopped');
  });
});
