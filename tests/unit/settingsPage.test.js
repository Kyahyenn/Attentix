/** js/settings.js on the real educator and student pages: sections, controls, preferences and import validation. */
const { boot, cleanup } = require('./domHarness');

afterEach(cleanup);

const open = (page) => {
  const t = boot({ page, url: `http://localhost/${page}`, scripts: ['a11y.js', 'settings.js', 'nav.js'] });
  const ids = (selector) => [...t.window.document.querySelectorAll(selector)].map((n) => n.id);
  const choose = (name, value) => { t.window.document.querySelector(`input[name="${name}"][value="${value}"]`).click(); };
  const toggle = (title) => {
    const label = [...t.window.document.querySelectorAll('.setting-title')].find((n) => n.textContent === title);
    const input = t.window.document.getElementById(label.htmlFor);
    input.click();
    return input;
  };
  return { ...t, ids, choose, toggle, ls: () => t.window.localStorage };
};

describe.each(['educator-dashboard.html', 'student.html'])('%s: sections', (page) => {
  test('Appearance, Accessibility and General are built, in that order', () => {
    expect(open(page).ids('#settingsRoot > section')).toEqual(['settings-appearance', 'settings-accessibility', 'settings-general']);
  });

  test('every section menu link points at a section on the page', () => {
    const t = open(page);
    t.window.document.querySelectorAll('.settings-nav a').forEach((a) => {
      expect(t.window.document.getElementById(a.getAttribute('href').slice(1))).not.toBeNull();
    });
  });

  test('switches are real checkboxes with the switch role and a label', () => {
    const t = open(page);
    const switches = [...t.window.document.querySelectorAll('input[role="switch"]')];
    expect(switches.length).toBeGreaterThanOrEqual(5);
    switches.forEach((input) => expect(t.window.document.querySelector(`label[for="${input.id}"]`)).not.toBeNull());
  });
});

describe('controls', () => {
  test('mode and colour theme drive the engine', () => {
    const t = open('educator-dashboard.html');
    const root = t.window.document.documentElement;
    t.choose('theme-mode', 'dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    t.choose('theme-mode', 'system');
    expect(t.ls().getItem('am.theme')).toBeNull();
    t.choose('palette', 'forest');
    expect(root.getAttribute('data-palette')).toBe('forest');
  });

  test('text size slider, high contrast, reduced motion and focus outline', () => {
    const t = open('educator-dashboard.html');
    const root = t.window.document.documentElement;
    const range = t.window.document.querySelector('input.range');
    range.value = '130';
    range.dispatchEvent(new t.window.Event('input', { bubbles: true }));
    expect(root.style.getPropertyValue('--text-scale')).toBe('1.3');
    t.toggle('High contrast');
    t.toggle('Reduce motion');
    t.toggle('Stronger focus outline');
    expect([root.getAttribute('data-contrast'), root.getAttribute('data-motion'), root.getAttribute('data-focus')]).toEqual(['high', 'reduce', 'strong']);
  });

  test('confirmation messages can be switched off; errors still show', () => {
    const t = open('educator-dashboard.html');
    t.toggle('Confirmation messages');
    expect(t.ls().getItem('am.pref.toasts')).toBe('false');
    t.window.AM.toast('Copied');
    expect(t.$('.toast-visible')).toBeNull();
    t.window.AM.toast('Broken', true);
    expect(t.$('.toast-visible.toast-error')).not.toBeNull();
  });

  test('class layout and sort use the keys the Classes tab already reads', () => {
    const t = open('educator-dashboard.html');
    t.choose('class-layout', 'list');
    expect(t.ls().getItem('am.classes.view')).toBe('list');
  });

  test('only the educator page has check-in alerts; only the student page can forget a device', () => {
    const edu = open('educator-dashboard.html');
    const stu = open('student.html');
    const titles = (t) => [...t.window.document.querySelectorAll('.setting-title')].map((n) => n.textContent);
    expect(titles(edu)).toContain('Check-in alerts');
    expect(titles(stu)).not.toContain('Check-in alerts');
    expect(titles(stu)).toContain('Signed in on this device');
  });
});

describe('import validation', () => {
  test('only known keys with valid values are accepted', () => {
    const { isPrefKey, isValidPref } = open('educator-dashboard.html').window.AMSettings;
    expect(isPrefKey('am.palette')).toBe(true);
    expect(isPrefKey('am.token')).toBe(false);
    expect(isPrefKey('am.token.persist')).toBe(false);
    expect(isPrefKey('am.recentClasses.e1')).toBe(false);
    expect(isValidPref('am.palette', 'ocean')).toBe(true);
    expect(isValidPref('am.palette', 'neon')).toBe(false);
    expect(isValidPref('am.textScale', '999')).toBe(false);
    expect(isValidPref('am.pref.start', '"classes"')).toBe(true);
    expect(isValidPref('am.pref.start', '<script>')).toBe(false);
  });
});
