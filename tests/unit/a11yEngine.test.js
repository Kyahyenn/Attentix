/** Runs the real public/js/a11y.js in jsdom: theme caching, text-size steps, toolbar, cross-tab sync. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../public/js/a11y.js'), 'utf8');
const windows = [];
afterEach(() => windows.splice(0).forEach((w) => w.close()));

// `store` pre-seeds localStorage before the script runs (as if from an earlier visit). `systemDark` fakes the OS setting.
const load = async ({ store = {}, systemDark = false, blockStorage = false } = {}) => {
  const dom = new JSDOM('<!doctype html><html><body><a class="skip-link" href="#main">Skip</a><main id="main"></main></body></html>', {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
    beforeParse(window) {
      Object.entries(store).forEach(([k, v]) => window.localStorage.setItem(k, v));
      let listener = null;
      // `matches` is a live getter, like a real MediaQueryList.
      window.matchMedia = (query) => ({
        get matches() { return query.includes('dark') && systemDark; }, media: query,
        addEventListener: (_t, cb) => { listener = cb; }, removeEventListener() {}
      });
      window.__flipSystem = (dark) => { systemDark = dark; if (listener) listener(); };
      if (blockStorage) {
        Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
      }
    }
  });
  windows.push(dom.window);
  dom.window.eval(SOURCE);
  await new Promise((resolve) => dom.window.addEventListener('load', resolve)); // DOMContentLoaded builds the toolbar
  const events = [];
  dom.window.document.addEventListener('am:themechange', (e) => events.push(['theme', e.detail]));
  dom.window.document.addEventListener('am:scalechange', (e) => events.push(['scale', e.detail]));
  const root = dom.window.document.documentElement;
  const $ = (sel) => dom.window.document.querySelector(sel);
  const click = (label) => [...dom.window.document.querySelectorAll('.a11y-bar button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label).click();
  return { window: dom.window, root, events, $, click, get ls() { return dom.window.localStorage; } };
};

describe('theme', () => {
  test('first visit follows the OS and is applied immediately (no flash)', async () => {
    expect((await load({ systemDark: false })).root.getAttribute('data-theme')).toBe('light');
    expect((await load({ systemDark: true })).root.getAttribute('data-theme')).toBe('dark');
  });

  test('the toggle flips, persists to localStorage and announces the change', async () => {
    const t = await load({ systemDark: false });
    const toggle = t.$('.a11y-bar button');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    toggle.click();
    expect(t.root.getAttribute('data-theme')).toBe('dark');
    expect(t.ls.getItem('am.theme')).toBe('dark');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(t.events).toContainEqual(['theme', { theme: 'dark', saved: true }]);
    toggle.click();
    expect(t.ls.getItem('am.theme')).toBe('light');
  });

  test('a saved choice beats the OS setting on the next visit', async () => {
    const t = await load({ store: { 'am.theme': 'light' }, systemDark: true });
    expect(t.root.getAttribute('data-theme')).toBe('light');
  });

  test('OS changes are followed only while the user has not chosen a theme', async () => {
    const auto = await load({ systemDark: false });
    auto.window.__flipSystem(true);
    expect(auto.root.getAttribute('data-theme')).toBe('dark');

    const chosen = await load({ store: { 'am.theme': 'light' }, systemDark: false });
    chosen.window.__flipSystem(true);
    expect(chosen.root.getAttribute('data-theme')).toBe('light');
  });

  test('a junk stored value is ignored', async () => {
    expect((await load({ store: { 'am.theme': 'purple' }, systemDark: false })).root.getAttribute('data-theme')).toBe('light');
  });
});

describe('text size', () => {
  test('starts at 100% and steps by 10% with A+ / A-', async () => {
    const t = await load();
    expect(t.root.style.getPropertyValue('--text-scale')).toBe('1');
    expect(t.$('output').textContent).toBe('100%');
    t.click('Increase text size'); t.click('Increase text size');
    expect(t.root.style.getPropertyValue('--text-scale')).toBe('1.2');
    expect(t.$('output').textContent).toBe('120%');
    expect(t.ls.getItem('am.textScale')).toBe('120');
    t.click('Decrease text size');
    expect(t.$('output').textContent).toBe('110%');
  });

  test('is clamped to 80%..200% and the buttons say when they are at a limit', async () => {
    const t = await load();
    for (let i = 0; i < 30; i += 1) t.click('Increase text size');
    expect(t.window.AMA11y.scale()).toBe(200);
    expect(t.$('[aria-label="Increase text size"]').getAttribute('aria-disabled')).toBe('true');
    for (let i = 0; i < 40; i += 1) t.click('Decrease text size');
    expect(t.window.AMA11y.scale()).toBe(80);
    expect(t.$('[aria-label="Decrease text size"]').getAttribute('aria-disabled')).toBe('true');
  });

  test('a saved size is applied on load; garbage and out-of-range values are sanitised', async () => {
    expect((await load({ store: { 'am.textScale': '150' } })).root.style.getPropertyValue('--text-scale')).toBe('1.5');
    expect((await load({ store: { 'am.textScale': '9999' } })).window.AMA11y.scale()).toBe(200);
    expect((await load({ store: { 'am.textScale': '-5' } })).window.AMA11y.scale()).toBe(80);
    expect((await load({ store: { 'am.textScale': 'abc' } })).window.AMA11y.scale()).toBe(100);
  });
});

describe('toolbar, reset, sync and resilience', () => {
  test('the toolbar is a labelled group placed right after the skip link', async () => {
    const t = await load();
    const bar = t.$('.a11y-bar');
    expect(bar.getAttribute('role')).toBe('group');
    expect(bar.getAttribute('aria-label')).toBe('Display settings');
    expect(t.$('.skip-link').nextElementSibling).toBe(bar);
    expect([...bar.querySelectorAll('button')].every((b) => b.type === 'button')).toBe(true);
  });

  test('Reset clears both preferences and returns to the OS theme at 100%', async () => {
    const t = await load({ store: { 'am.theme': 'dark', 'am.textScale': '150' }, systemDark: false });
    t.click('Reset display settings');
    expect(t.ls.getItem('am.theme')).toBeNull();
    expect(t.ls.getItem('am.textScale')).toBeNull();
    expect(t.root.getAttribute('data-theme')).toBe('light');
    expect(t.$('output').textContent).toBe('100%');
  });

  test('a change made in another tab (storage event) is picked up', async () => {
    const t = await load();
    t.ls.setItem('am.theme', 'dark');
    t.window.dispatchEvent(new t.window.StorageEvent('storage', { key: 'am.theme', newValue: 'dark' }));
    expect(t.root.getAttribute('data-theme')).toBe('dark');
  });

  test('blocked localStorage never throws; settings just are not remembered', async () => {
    const t = await load({ blockStorage: true, systemDark: true });
    expect(t.root.getAttribute('data-theme')).toBe('dark');
    expect(() => { t.click('Increase text size'); t.$('.a11y-bar button').click(); }).not.toThrow();
  });
});

describe('colour theme, contrast, motion and focus', () => {
  test('palette: saved choice is applied, unknown values fall back to maroon, maroon is stored as "no choice"', async () => {
    const t = await load({ store: { 'am.palette': 'ocean' } });
    expect(t.root.getAttribute('data-palette')).toBe('ocean');
    expect((await load({ store: { 'am.palette': 'neon' } })).root.getAttribute('data-palette')).toBe('maroon');
    t.window.AMA11y.setPalette('forest');
    expect(t.ls.getItem('am.palette')).toBe('forest');
    t.window.AMA11y.setPalette('maroon');
    expect(t.ls.getItem('am.palette')).toBeNull();
  });

  test('palette and contrast changes announce am:themechange so charts rebuild', async () => {
    const t = await load();
    t.window.AMA11y.setPalette('graphite');
    t.window.AMA11y.setContrast(true);
    expect(t.events.filter(([kind]) => kind === 'theme')).toHaveLength(2);
  });

  test('contrast and motion follow the device until chosen; null goes back to following it', async () => {
    const t = await load();
    const a = t.window.AMA11y;
    expect([a.contrast(), a.motion(), a.followsSystem('contrast'), a.followsSystem('motion')]).toEqual([false, 'full', true, true]);
    a.setContrast(true); a.setMotion('reduce');
    expect(t.root.getAttribute('data-contrast')).toBe('high');
    expect(t.root.getAttribute('data-motion')).toBe('reduce');
    expect([t.ls.getItem('am.contrast'), t.ls.getItem('am.motion')]).toEqual(['on', 'reduce']);
    a.setContrast(null); a.setMotion(null);
    expect([t.ls.getItem('am.contrast'), t.ls.getItem('am.motion')]).toEqual([null, null]);
    expect(t.root.getAttribute('data-contrast')).toBe('normal');
  });

  test('focus ring and shortcuts are stored only while on', async () => {
    const t = await load();
    t.window.AMA11y.setFocusRing(true); t.window.AMA11y.setShortcuts(true);
    expect(t.root.getAttribute('data-focus')).toBe('strong');
    expect([t.ls.getItem('am.focus'), t.ls.getItem('am.shortcuts')]).toEqual(['strong', 'on']);
    t.window.AMA11y.setFocusRing(false); t.window.AMA11y.setShortcuts(false);
    expect([t.ls.getItem('am.focus'), t.ls.getItem('am.shortcuts')]).toEqual([null, null]);
  });

  test('the toolbar has a High contrast toggle, and Reset clears every accessibility choice', async () => {
    const t = await load({ store: { 'am.palette': 'ocean', 'am.contrast': 'on', 'am.motion': 'reduce', 'am.focus': 'strong', 'am.shortcuts': 'on' } });
    expect([...t.window.document.querySelectorAll('.a11y-bar button')].some((b) => b.textContent === 'High contrast')).toBe(true);
    t.click('Reset display settings');
    ['am.palette', 'am.contrast', 'am.motion', 'am.focus', 'am.shortcuts'].forEach((key) => expect(t.ls.getItem(key)).toBeNull());
    expect(t.root.getAttribute('data-palette')).toBe('maroon');
  });
});
