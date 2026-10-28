/**
 * Runs the real public/ pages in jsdom with a scripted fetch to check the passwordless onboarding journeys:
 * educator sign-up / login (cookie session, no professor code), student sign-up redirect, and the Join page.
 */
const { JSDOM } = require('jsdom');
const { boot, cleanup, read, FAKE_TOKEN } = require('./domHarness');

afterEach(cleanup);

describe('class code cache (AM.invite)', () => {
  const { window } = new JSDOM('<body></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
  window.eval(read('js/common.js'));
  const { invite } = window.AM;

  test('reads classCode (and the legacy ?code=) and normalises/validates it', () => {
    expect(invite.fromUrl('?classCode=abc234')).toBe('ABC234');
    expect(invite.fromUrl('?code=xyz789')).toBe('XYZ789');
    expect(invite.fromUrl('?classCode=%3Cscript%3E')).toBeNull();
    expect(invite.fromUrl('?classCode=ab')).toBeNull();
    expect(invite.fromUrl('')).toBeNull();
  });

  test('save / peek / take, and an expired code is discarded', () => {
    invite.clear();
    expect(invite.save('abc234')).toBe('ABC234');
    expect(invite.peek()).toBe('ABC234');
    expect(invite.take()).toBe('ABC234');
    expect(invite.peek()).toBeNull();
    window.sessionStorage.setItem('am.pendingInvite', JSON.stringify({ code: 'ABC234', savedAt: Date.now() - 31 * 60 * 1000 }));
    expect(invite.peek()).toBeNull();
    window.sessionStorage.setItem('am.pendingInvite', '{not json');
    expect(invite.peek()).toBeNull();
  });
});

describe('student token store (AM.session)', () => {
  const fresh = (url = 'http://localhost/student.html') => boot({ page: 'student.html', url }).window;

  test('rejects anything that does not look like a token and stores a good one in sessionStorage only', () => {
    const w = fresh();
    expect(w.AM.session.set('not a token')).toBe(false);
    expect(w.AM.session.set(undefined)).toBe(false);
    expect(w.AM.session.has()).toBe(false);
    expect(w.AM.session.set(FAKE_TOKEN)).toBe(true);
    expect(w.sessionStorage.getItem('am.token')).toBe(FAKE_TOKEN);
    expect(w.localStorage.getItem('am.token.persist')).toBeNull();
  });

  test('"remember me" also writes localStorage, which survives a new tab until the token expires', () => {
    const w = fresh();
    w.AM.session.set(FAKE_TOKEN, { persist: true, expiresAt: Date.now() + 60000 });
    w.sessionStorage.clear(); // a new tab
    expect(w.AM.session.get()).toBe(FAKE_TOKEN);
    w.AM.session.set(FAKE_TOKEN, { persist: true, expiresAt: Date.now() - 1 });
    w.sessionStorage.clear();
    expect(w.AM.session.get()).toBeNull();
    expect(w.localStorage.getItem('am.token.persist')).toBeNull(); // expired entries are removed
  });

  test('consumeUrlToken stores the token and removes ONLY it from the address bar', () => {
    const w = fresh(`http://localhost/student.html?token=${FAKE_TOKEN}&keep=1#top`);
    expect(w.AM.session.consumeUrlToken()).toBe(true);
    expect(w.AM.session.get()).toBe(FAKE_TOKEN);
    expect(w.location.search).toBe('?keep=1');
    expect(w.location.hash).toBe('#top');
    expect(w.location.href).not.toContain(FAKE_TOKEN);
  });

  test('a malformed ?token= is ignored but still stripped from the URL', () => {
    const w = fresh('http://localhost/student.html?token=<script>alert(1)</script>');
    expect(w.AM.session.consumeUrlToken()).toBe(false);
    expect(w.AM.session.has()).toBe(false);
    expect(w.location.search).toBe('');
  });

  test('api() sends the student token unless a page opts out with bearer:false (educator pages)', async () => {
    const t = boot({ page: 'student.html', url: 'http://localhost/', routes: { 'GET /api/x': { status: 200, body: {} } } });
    t.window.AM.session.set(FAKE_TOKEN);
    await t.window.AM.api('/api/x');
    await t.window.AM.api('/api/x', 'GET', undefined, { bearer: false });
    expect(t.calls[0].headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(t.calls[1].headers.Authorization).toBeUndefined();
  });
});

describe('signup.html (student sign-up is gone)', () => {
  const run = (search) => boot({ page: 'signup.html', url: `http://localhost/signup.html${search}`, scripts: ['signup.js'] });

  test('students are sent to the passwordless Join page', () => {
    expect(run('').navigations).toEqual(['/join.html']);
  });

  test('an old invite link keeps its class code', () => {
    expect(run('?classCode=abc234').navigations).toEqual(['/join.html?classCode=ABC234']);
  });

  test('professors are sent to educator sign-up', () => {
    expect(run('?role=educator').navigations).toEqual(['/educator-signup.html']);
    expect(run('?role=professor').navigations).toEqual(['/educator-signup.html']);
  });

  test('has no form and no password field, and a no-JavaScript fallback', () => {
    const t = run('');
    expect(t.$('form')).toBeNull();
    expect(t.$('input[type=password]')).toBeNull();
    expect(read('signup.html')).toMatch(/<noscript><meta http-equiv="refresh"/);
  });
});

describe('educator-signup.html', () => {
  const page = () => boot({ page: 'educator-signup.html', url: 'http://localhost/educator-signup.html', scripts: ['educator-signup.js'],
    routes: { 'POST /api/auth/educator/register': (b) => ({ status: 201, body: { user: { role: 'educator', name: b.name } } }) } });

  test('has no professor / invite code field: the only inputs are Full name, Email and Password', () => {
    const t = page();
    expect(t.byId('eduInvite')).toBeNull();
    expect(t.window.document.body.textContent).not.toMatch(/invite code|professor code/i);
    expect([...t.window.document.querySelectorAll('#educatorForm input')].map((i) => i.id)).toEqual(['eduName', 'eduEmail', 'eduPassword']);
    const attrs = [...t.window.document.querySelectorAll('input')].map((i) => [i.id, i.name, i.placeholder, i.getAttribute('aria-label')].join(' ')).join(' ');
    expect(attrs).not.toMatch(/professor|invite/i);
  });

  test('sends exactly { name, email, password } with no student token, then opens the dashboard', async () => {
    const t = page();
    t.window.AM.session.set(FAKE_TOKEN); // left over from an earlier student visit in this tab
    t.type('eduName', 'Prof Reyes'); t.type('eduEmail', 'reyes@school.edu'); t.type('eduPassword', 'a-long-password');
    t.submit('educatorForm');
    await t.tick();
    const call = t.calls.find((c) => c.key === 'POST /api/auth/educator/register');
    expect(call.body).toEqual({ name: 'Prof Reyes', email: 'reyes@school.edu', password: 'a-long-password' });
    expect(call.headers.Authorization).toBeUndefined();
    expect(t.navigations).toEqual(['/educator-dashboard.html']);
  });

  test('invalid input is reported inline on the field, focuses it, and never calls the server', async () => {
    const t = page();
    t.type('eduName', 'P'); t.type('eduEmail', 'nope'); t.type('eduPassword', 'short');
    t.submit('educatorForm');
    await t.tick();
    expect(t.calls).toHaveLength(0);
    expect(t.byId('eduNameError').textContent).toMatch(/full name/);
    expect(t.byId('eduEmailError').textContent).toMatch(/valid email/);
    expect(t.byId('eduPasswordError').textContent).toMatch(/8 characters/);
    expect(t.byId('eduName').getAttribute('aria-invalid')).toBe('true');
    expect(t.window.document.activeElement.id).toBe('eduName');
  });

  test('a server-side field error (e.g. a too-common password) lands on that field', async () => {
    const t = boot({ page: 'educator-signup.html', url: 'http://localhost/educator-signup.html', scripts: ['educator-signup.js'],
      routes: { 'POST /api/auth/educator/register': { status: 400, body: { error: 'Validation failed', message: 'password: That password is too common. Choose something harder to guess.' } } } });
    t.type('eduName', 'Prof Reyes'); t.type('eduEmail', 'reyes@school.edu'); t.type('eduPassword', 'password123');
    t.submit('educatorForm');
    await t.tick();
    expect(t.byId('eduPasswordError').textContent).toMatch(/too common/);
    expect(t.navigations).toEqual([]);
  });
});

describe('login.html (educators only)', () => {
  const page = (routes = {}) => boot({ page: 'login.html', url: 'http://localhost/login.html', scripts: ['login.js'],
    routes: { 'GET /api/me': { status: 401, body: {} }, ...routes } });

  test('is an educator sign-in: no student registration form, a note for students linking to the Join page', () => {
    const t = page();
    expect(t.byId('registerForm')).toBeNull();
    expect(t.byId('registerName')).toBeNull();
    expect(t.$('h1').textContent).toMatch(/Attentix/);
    const note = t.byId('studentNote');
    expect(note.textContent).toContain('Students: No password needed!');
    expect(note.textContent).toContain('Join directly via the Attentix browser extension, or view your optional dashboard on the Join page.');
    expect(note.querySelector('a[href="/join.html"]')).not.toBeNull();
    expect(t.$('a[href="/educator-signup.html"]')).not.toBeNull();
    expect(t.$('[data-google-signin]')).toBeNull();
  });

  test('signs an educator in with email + password, without any student token, and opens the dashboard', async () => {
    const t = page({ 'POST /api/login': { status: 200, body: { user: { role: 'educator', name: 'Prof' } } } });
    t.window.AM.session.set(FAKE_TOKEN);
    t.type('loginEmail', 'reyes@school.edu'); t.type('loginPassword', 'secret-pass');
    t.submit('loginForm');
    await t.tick();
    const login = t.calls.find((c) => c.key === 'POST /api/login');
    expect(login.body).toEqual({ email: 'reyes@school.edu', password: 'secret-pass' });
    expect(login.headers.Authorization).toBeUndefined();
    expect(t.navigations).toEqual(['/educator-dashboard.html']);
  });

  test('a leftover student password gets a clear "no passwords for students" message, not a redirect loop', async () => {
    const t = page({ 'POST /api/login': { status: 410, body: { error: 'x', redirect: '/join.html' } } });
    t.type('loginEmail', 'ana@school.edu'); t.type('loginPassword', 'old-password');
    t.submit('loginForm');
    await t.tick();
    expect(t.byId('loginError').textContent).toMatch(/Students no longer sign in with a password/);
    expect(t.navigations).toEqual([]);
  });

  test('wrong credentials show the server message; empty fields are caught inline', async () => {
    const t = page({ 'POST /api/login': { status: 401, body: { error: 'Invalid credentials' } } });
    t.submit('loginForm');
    await t.tick();
    expect(t.calls.some((c) => c.key === 'POST /api/login')).toBe(false);
    expect(t.byId('loginEmailError').textContent).toMatch(/Enter your email/);
    t.type('loginEmail', 'a@b.co'); t.type('loginPassword', 'x');
    t.submit('loginForm');
    await t.tick();
    expect(t.byId('loginError').textContent).toBe('Invalid credentials');
  });

  test('an educator who is already signed in skips the form', async () => {
    const t = page({ 'GET /api/me': { status: 200, body: { user: { role: 'educator' } } } });
    await t.tick();
    expect(t.navigations).toEqual(['/educator-dashboard.html']);
  });

  test('a student token in this tab does not redirect or break the page', async () => {
    const t = boot({ page: 'login.html', url: 'http://localhost/login.html', scripts: ['login.js'], routes: { 'GET /api/me': { status: 200, body: { user: { role: 'student' } } } } });
    await t.tick();
    expect(t.navigations).toEqual([]);
  });
});

describe('join.html (passwordless)', () => {
  const JOINED = { status: 201, body: { message: 'Joined class', token: FAKE_TOKEN, expiresAt: Date.now() + 43200000, className: 'Math 101', educatorName: 'Prof Reyes', classCode: 'ABC234' } };
  const page = ({ search = '', routes = {}, setup } = {}) => boot({ page: 'join.html', url: `http://localhost/join.html${search}`, scripts: ['join.js'], setup, routes: { ...routes } });
  const fill = (t, over = {}) => {
    t.type('joinName', over.name ?? 'Ana Cruz'); t.type('joinEmail', over.email ?? 'ana@school.edu'); t.type('joinClassCode', over.code ?? 'abc234');
    t.byId('joinConsent').checked = over.consent ?? true;
  };

  test('asks only for Full name, Email and Class code (plus consent): no password anywhere', () => {
    const t = page();
    expect([...t.window.document.querySelectorAll('#joinForm input')].map((i) => i.id)).toEqual(['joinName', 'joinEmail', 'joinClassCode', 'joinConsent', 'joinRemember']);
    expect(t.$('input[type=password]')).toBeNull();
  });

  test('/join?classCode=ABC234 pre-fills the code and removes it from the address bar', () => {
    const t = page({ search: '?classCode=abc234' });
    expect(t.byId('joinClassCode').value).toBe('ABC234');
    expect(t.window.location.search).toBe('');
  });

  test('joining posts name, email, class code and consent:true (no password, no old token) and stores the token for this tab only', async () => {
    const t = page({ routes: { 'POST /api/extension/join': JOINED } });
    t.window.AM.session.set(`${'c'.repeat(40)}.${'d'.repeat(43)}`); // someone else's earlier token must not be sent
    fill(t);
    t.submit('joinForm');
    await t.tick();
    const call = t.calls.find((c) => c.key === 'POST /api/extension/join');
    expect(call.body).toEqual({ name: 'Ana Cruz', email: 'ana@school.edu', classCode: 'ABC234', consent: true });
    expect(call.headers.Authorization).toBeUndefined();
    expect(t.window.sessionStorage.getItem('am.token')).toBe(FAKE_TOKEN);
    expect(t.window.localStorage.getItem('am.token.persist')).toBeNull();
    expect(t.byId('successCard').classList.contains('hidden')).toBe(false);
    expect(t.byId('joinCard').classList.contains('hidden')).toBe(true);
    expect(t.byId('successText').textContent).toContain('Math 101');
    expect(t.window.document.activeElement.id).toBe('successTitle');
  });

  test('"keep me signed in" also persists the token on this device', async () => {
    const t = page({ routes: { 'POST /api/extension/join': JOINED } });
    fill(t); t.byId('joinRemember').checked = true;
    t.submit('joinForm');
    await t.tick();
    expect(JSON.parse(t.window.localStorage.getItem('am.token.persist')).token).toBe(FAKE_TOKEN);
  });

  test('consent is required: unticked shows an inline error and nothing is sent', async () => {
    const t = page({ routes: { 'POST /api/extension/join': JOINED } });
    fill(t, { consent: false });
    t.submit('joinForm');
    await t.tick();
    expect(t.calls.some((c) => c.key === 'POST /api/extension/join')).toBe(false);
    expect(t.byId('joinConsentError').textContent).toMatch(/privacy notice/);
    expect(t.window.document.activeElement.id).toBe('joinConsent');
  });

  test('bad fields are reported together, inline, and the first one is focused', async () => {
    const t = page();
    fill(t, { name: '', email: 'nope', code: 'ab' });
    t.submit('joinForm');
    await t.tick();
    expect(t.byId('joinNameError').textContent).toMatch(/full name/);
    expect(t.byId('joinEmailError').textContent).toMatch(/valid email/);
    expect(t.byId('joinClassCodeError').textContent).toMatch(/6 to 8/);
    expect(t.window.document.activeElement.id).toBe('joinName');
    expect(t.calls).toHaveLength(0);
  });

  test('an unknown class code is explained on the class-code field', async () => {
    const t = page({ routes: { 'POST /api/extension/join': { status: 404, body: { error: 'No class found for that class code.' } } } });
    fill(t, { code: 'zzzzzz' });
    t.submit('joinForm');
    await t.tick();
    expect(t.byId('joinClassCodeError').textContent).toMatch(/No class found/);
    expect(t.byId('joinClassCode').getAttribute('aria-invalid')).toBe('true');
    expect(t.window.sessionStorage.getItem('am.token')).toBeNull();
    expect(t.byId('successCard').classList.contains('hidden')).toBe(true);
  });

  test('rate-limit and server errors show in the form-level alert', async () => {
    const t = page({ routes: { 'POST /api/extension/join': { status: 429, body: { error: 'Too many wrong class codes. Please wait a few minutes and try again.' } } } });
    fill(t);
    t.submit('joinForm');
    await t.tick();
    expect(t.byId('joinFormError').textContent).toMatch(/Too many wrong class codes/);
  });

  test('a student who already holds a valid token is offered a shortcut; a stale token is dropped', async () => {
    const ok = page({ routes: { 'POST /api/student/lookup': { status: 200, body: { student: { name: 'Ana Cruz' }, class: { className: 'Math 101' } } } },
      setup: (w) => w.sessionStorage.setItem('am.token', FAKE_TOKEN) });
    await ok.tick();
    expect(ok.byId('existingCard').classList.contains('hidden')).toBe(false);
    expect(ok.byId('existingText').textContent).toBe('You joined Math 101 as Ana Cruz.');

    const stale = page({ routes: { 'POST /api/student/lookup': { status: 401, body: { error: 'Authentication required' } } },
      setup: (w) => w.sessionStorage.setItem('am.token', FAKE_TOKEN) });
    await stale.tick();
    expect(stale.byId('existingCard').classList.contains('hidden')).toBe(true);
    expect(stale.window.sessionStorage.getItem('am.token')).toBeNull();
  });

  test('?deleted=1 (after erasing data) shows a confirmation', () => {
    expect(page({ search: '?deleted=1' }).byId('deletedNotice').classList.contains('hidden')).toBe(false);
  });
});

test('logging out clears a cached class code and never sends a student token', async () => {
  const t = boot({ page: 'login.html', url: 'http://localhost/', routes: { 'POST /api/logout': { status: 200, body: {} } } });
  t.window.AM.invite.save('ABC234');
  t.window.AM.session.set(FAKE_TOKEN);
  await t.window.AM.logout();
  expect(t.window.AM.invite.peek()).toBeNull();
  expect(t.calls[0].headers.Authorization).toBeUndefined();
  expect(t.navigations).toEqual(['/login.html']);
});

describe('show / hide password buttons (login and educator sign-up)', () => {
  const pages = [
    ['login.html', 'login.js', 'loginPassword'],
    ['educator-signup.html', 'educator-signup.js', 'eduPassword']
  ];

  test.each(pages)('%s: the button reveals and re-hides the field and keeps its label and aria-pressed in step', async (page, script, inputId) => {
    const { byId, $, tick, window } = boot({ page, url: `http://localhost/${page}`, scripts: [script], routes: { 'GET /api/me': { status: 401, body: {} } } });
    await tick();
    const input = byId(inputId);
    const button = $('.show-password');
    expect(input.type).toBe('password');

    button.dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(input.type).toBe('text');
    expect(button.textContent).toBe('Hide');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Hide password');

    button.dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(input.type).toBe('password');
    expect(button.textContent).toBe('Show');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Show password');
  });
});
