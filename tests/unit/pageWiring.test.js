/** Static wiring checks: every page loads only same-origin scripts that exist, and every element id its scripts look up exists. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PUBLIC = path.join(__dirname, '../../public');
const PAGES = {
  'login.html': ['login.js'], 'signup.html': ['signup.js'], 'educator-signup.html': ['educator-signup.js'],
  'join.html': ['join.js'], 'privacy.html': ['privacy.js'], 'student.html': ['student.js'],
  'educator-dashboard.html': ['educator.js', 'chartMatrix.js']
};

// ids passed to byId('x') / on('x', ...) / $('x') in the page's own scripts
const referencedIds = (source) => {
  const ids = new Set();
  for (const re of [/byId\('([A-Za-z0-9_-]+)'\)/g, /(?<![.\w])on\('([A-Za-z0-9_-]+)'/g]) for (const m of source.matchAll(re)) ids.add(m[1]);
  return ids;
};

describe.each(Object.entries(PAGES))('%s', (page, scripts) => {
  const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
  const doc = new JSDOM(html).window.document;

  test('has no inline scripts (the CSP is script-src \'self\') and every script exists locally', () => {
    const tags = [...doc.querySelectorAll('script')];
    expect(tags.every((s) => s.src === '' ? false : true)).toBe(true);
    for (const tag of tags) {
      const src = tag.getAttribute('src');
      expect(src.startsWith('/')).toBe(true);
      const file = src.startsWith('/socket.io/') ? null : path.join(PUBLIC, src);
      if (file) expect(fs.existsSync(file)).toBe(true);
    }
  });

  test('applies the saved theme before first paint (a11y.js is a blocking script in <head>)', () => {
    const tag = doc.head.querySelector('script[src="/js/a11y.js"]');
    expect(tag).not.toBeNull();
    expect(tag.hasAttribute('defer') || tag.hasAttribute('async')).toBe(false);
  });

  test('provides a skip link and a #main landmark', () => {
    expect(doc.querySelector('a.skip-link[href="#main"]')).not.toBeNull();
    expect(doc.getElementById('main')).not.toBeNull();
  });

  test('every element id its scripts look up exists in the page', () => {
    const ids = new Set();
    scripts.forEach((s) => referencedIds(fs.readFileSync(path.join(PUBLIC, 'js', s), 'utf8')).forEach((i) => ids.add(i)));
    const missing = [...ids].filter((id) => !doc.getElementById(id));
    expect(missing).toEqual([]);
  });

  test('every form field has a label', () => {
    const fields = [...doc.querySelectorAll('input:not([type=hidden]):not([type=checkbox]), select, textarea')];
    for (const f of fields) {
      const labelled = f.id && doc.querySelector(`label[for="${f.id}"]`);
      expect(labelled || f.getAttribute('aria-label')).toBeTruthy();
    }
  });
});

test('the educator dashboard loads Chart.js and the matrix wrapper before educator.js', () => {
  const doc = new JSDOM(fs.readFileSync(path.join(PUBLIC, 'educator-dashboard.html'), 'utf8')).window.document;
  const order = [...doc.querySelectorAll('script')].map((s) => s.getAttribute('src'));
  expect(order.indexOf('/vendor/chart.umd.js')).toBeLessThan(order.indexOf('/js/chartMatrix.js'));
  expect(order.indexOf('/js/chartMatrix.js')).toBeLessThan(order.indexOf('/js/educator.js'));
});

test('login.html is educator-only: no student sign-up fields, a note linking students to the Join page', () => {
  const doc = new JSDOM(fs.readFileSync(path.join(PUBLIC, 'login.html'), 'utf8')).window.document;
  expect(doc.getElementById('registerForm')).toBeNull();
  expect(doc.getElementById('registerRole')).toBeNull();
  expect(doc.querySelector('a[href="/educator-signup.html"]')).not.toBeNull();
  expect(doc.querySelector('#studentNote a[href="/join.html"]')).not.toBeNull();
});

test('educator-signup.html has no professor/invite code field', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'educator-signup.html'), 'utf8');
  expect(html).not.toMatch(/eduInvite|professor code|invite code/i);
  expect(fs.readFileSync(path.join(PUBLIC, 'js/educator-signup.js'), 'utf8')).not.toMatch(/inviteCode|eduInvite/);
});

test('no page or script calls an endpoint the server retired (student register/login, class join/lookup/enroll, rotate-code, Google)', () => {
  const files = [...fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html')), ...fs.readdirSync(path.join(PUBLIC, 'js')).map((f) => `js/${f}`)];
  const retired = /\/api\/register|\/api\/classes\/(join|lookup|enroll)\b|rotate-code|\/api\/auth\/google|\/api\/auth\/providers|\/api\/extension\/login/;
  for (const f of files) expect([f, retired.test(fs.readFileSync(path.join(PUBLIC, f), 'utf8'))]).toEqual([f, false]);
});

test('every dashboard form field that can be invalid has an error element wired through aria-describedby', () => {
  for (const page of ['join.html', 'educator-signup.html', 'login.html', 'student.html']) {
    const doc = new JSDOM(fs.readFileSync(path.join(PUBLIC, page), 'utf8')).window.document;
    for (const input of doc.querySelectorAll('input[required]')) {
      const err = doc.getElementById(`${input.id}Error`);
      expect([page, input.id, Boolean(err)]).toEqual([page, input.id, true]);
      expect(input.getAttribute('aria-describedby')).toContain(`${input.id}Error`);
    }
  }
});

test('stylesheet: one dark palette keyed on data-theme, and no px font sizes left that text zoom cannot reach', () => {
  const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
  expect(css).toMatch(/:root\[data-theme="dark"\]/);
  expect(css).toMatch(/html \{ font-size: calc\(100% \* var\(--text-scale, 1\)\); \}/);
  expect(css.match(/font-size:\s*\d+px/g)).toBeNull();
});

// ---- the forms of the extension-first model: who asks for what -----------------------------------------------------
// Educators sign in / sign up with a password. Students never type one: they join (page or popup) or look themselves up
// with name + email + class code.
const FORMS = {
  'login.html':           { script: 'login.js',           form: 'loginForm',    fields: ['loginEmail', 'loginPassword'], password: 'current-password' },
  'educator-signup.html': { script: 'educator-signup.js', form: 'educatorForm', fields: ['eduName', 'eduEmail', 'eduPassword'], password: 'new-password' },
  'join.html':            { script: 'join.js',            form: 'joinForm',     fields: ['joinName', 'joinEmail', 'joinClassCode', 'joinConsent', 'joinRemember'], password: null },
  'student.html':         { script: 'student.js',         form: 'lookupForm',   fields: ['lookupName', 'lookupEmail', 'lookupClassCode'], password: null }
};

describe.each(Object.entries(FORMS))('%s form', (page, spec) => {
  const doc = new JSDOM(fs.readFileSync(path.join(PUBLIC, page), 'utf8')).window.document;
  const script = fs.readFileSync(path.join(PUBLIC, 'js', spec.script), 'utf8');

  test(`is one <form id="${spec.form}"> with exactly the expected fields`, () => {
    const form = doc.getElementById(spec.form);
    expect(form && form.tagName).toBe('FORM');
    expect([...form.querySelectorAll('input')].map((i) => i.id)).toEqual(spec.fields);
  });

  test('its submit handler is wired by the page script', () => {
    expect(script).toMatch(new RegExp(`byId\\('${spec.form}'\\)\\.addEventListener\\('submit'`));
  });

  test(spec.password ? `has one password field (autocomplete="${spec.password}")` : 'has no password field at all (students never have one)', () => {
    const pw = [...doc.querySelectorAll('input[type=password]')];
    if (spec.password) {
      expect(pw).toHaveLength(1);
      expect(pw[0].getAttribute('autocomplete')).toBe(spec.password);
    } else {
      expect(pw).toHaveLength(0);
      expect(doc.querySelector('input[name*=pass i], input[id*=pass i]')).toBeNull();
    }
  });

  test('every required field points at an inline error element that exists', () => {
    for (const input of doc.querySelectorAll(`#${spec.form} input[required]`)) {
      const ref = input.getAttribute('aria-describedby');
      expect(ref).toBeTruthy();
      ref.split(/\s+/).forEach((id) => expect(doc.getElementById(id)).not.toBeNull());
    }
  });
});

describe('page-specific wiring', () => {
  const read = (f) => new JSDOM(fs.readFileSync(path.join(PUBLIC, f), 'utf8')).window.document;

  test('educator-signup.html has no professor / invite code input anywhere', () => {
    const html = fs.readFileSync(path.join(PUBLIC, 'educator-signup.html'), 'utf8');
    expect(html).not.toMatch(/professor|invite|eduInvite/i);
    expect(fs.readFileSync(path.join(PUBLIC, 'js', 'educator-signup.js'), 'utf8')).not.toMatch(/professorCode|inviteCode|eduInvite/);
  });

  test('join.html has a consent checkbox (enforced with an inline error by join.js), required text fields and a privacy link', () => {
    const doc = read('join.html');
    expect(doc.getElementById('joinConsent').type).toBe('checkbox');
    expect(doc.getElementById('joinForm').hasAttribute('novalidate')).toBe(true);
    ['joinName', 'joinEmail', 'joinClassCode'].forEach((id) => expect(doc.getElementById(id).required).toBe(true));
    expect(doc.querySelector('a[href^="/privacy"]')).not.toBeNull();
  });

  test('student.html offers the optional web view without a login: lookup form + the live dashboard, consent and erase controls', () => {
    const doc = read('student.html');
    ['lookupForm', 'consentToggleBtn', 'leaveClassBtn', 'deleteDataBtn', 'signOutBtn', 'signOutAllBtn'].forEach((id) => expect(doc.getElementById(id)).not.toBeNull());
    expect(doc.querySelector('a[href="/join.html"], a[href^="/join"]')).not.toBeNull(); // not joined yet? go to Join
  });

  test('login.html points students at the Join page instead of a student sign-in', () => {
    const doc = read('login.html');
    expect(doc.querySelector('a[href^="/join"]')).not.toBeNull();
    expect(doc.querySelector('a[href="/educator-signup.html"]')).not.toBeNull();
  });
});

describe('extension/popup.html', () => {
  const EXT = path.join(__dirname, '../../extension');
  const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
  const doc = new JSDOM(html).window.document;
  const js = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

  test('is the toolbar popup, and loads only its own local script (no inline script: MV3 CSP)', () => {
    expect(manifest.action.default_popup).toBe('popup.html');
    const tags = [...doc.querySelectorAll('script')];
    expect(tags.map((t) => t.getAttribute('src'))).toEqual(['config.js', 'popup.js']); // config.js: written by the professor's server
    ['popup.js', 'config.js'].forEach((f) => expect(fs.existsSync(path.join(EXT, f))).toBe(true));
    expect(tags.every((t) => !t.textContent.trim())).toBe(true);
  });

  test('every element id popup.js looks up exists in the popup', () => {
    const ids = new Set([...js.matchAll(/(?<![\w.])\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
    expect(ids.size).toBeGreaterThan(15);
    expect([...ids].filter((id) => !doc.getElementById(id))).toEqual([]);
  });

  test('the join form asks for Server URL, Class Code, Full name, Email and consent: and never a password', () => {
    const form = doc.getElementById('joinForm');
    expect([...form.querySelectorAll('input')].map((i) => i.id)).toEqual(['serverUrl', 'classCode', 'fullName', 'email', 'consent']);
    expect(doc.getElementById('consent').type).toBe('checkbox');
    expect(doc.querySelector('input[type=password]')).toBeNull();
    expect(js).toMatch(/\$\('joinForm'\)\.addEventListener\('submit'/);
    const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // the header comment says "never handles a password"
    expect(code).not.toMatch(/password/i);
  });

  test('every text field has a label', () => {
    for (const input of doc.querySelectorAll('#joinForm input')) {
      expect(doc.querySelector(`label[for="${input.id}"]`) || input.getAttribute('aria-label')).toBeTruthy();
    }
  });

  test('the server address sits in an "Advanced settings" section, with a visible notice that names the server', () => {
    const advanced = doc.getElementById('advanced');
    expect(advanced.tagName).toBe('DETAILS');
    expect(advanced.querySelector('summary').textContent).toBe('Advanced settings');
    expect(advanced.contains(doc.getElementById('serverUrl'))).toBe(true);
    expect(advanced.contains(doc.getElementById('classCode'))).toBe(false);
    expect(doc.getElementById('serverNotice').hidden).toBe(true); // shown by popup.js only when a server was pre-configured
    expect(doc.getElementById('serverNotice').contains(doc.getElementById('serverShown'))).toBe(true);
  });

  test('the connected view has the optional web dashboard button and a disconnect button', () => {
    expect(doc.getElementById('openDashboard')).not.toBeNull();
    expect(doc.getElementById('disconnectBtn')).not.toBeNull();
    expect(doc.getElementById('viewConnected')).not.toBeNull();
  });
});
