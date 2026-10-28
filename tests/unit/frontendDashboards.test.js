/** Real educator-dashboard.html / student.html in jsdom: immutable class codes, live roster, passwordless student view. */
const fs = require('fs');
const path = require('path');
const { boot, cleanup, read, stubChart, FAKE_TOKEN } = require('./domHarness');

afterEach(cleanup);

const row = (o) => ({
  studentId: o.id, name: o.name, online: true, attentive: true, reasons: [], tabHidden: false, mouseIdleMs: 1000,
  tabSwitchCount: 0, chatResponses: 0, meetingChatMessages: 0, lastActivityAt: Date.now(), promptWaitingMs: null,
  focusScore: 80, attentionState: 'Focused', location: 'meeting', isFocused: true, idleSeconds: 1,
  distractionCount: 0, focusLossCount: 0, trend: [], ...o
});
const ANA = row({ id: 'a', name: 'Ana', focusScore: 90 });
const BEN = row({ id: 'b', name: 'Ben', focusScore: 35, attentive: false, attentionState: 'Distracted', focusLossCount: 4, reasons: ['Switching between tabs or apps rapidly.'] });
const CY = row({ id: 'c', name: 'Cy', focusScore: 55, attentive: false, attentionState: 'Passive', focusLossCount: 1 });
const DEE = row({ id: 'd', name: 'Dee', online: false, attentive: false, focusScore: 70 });

describe('engagement helpers (AM.engagement)', () => {
  const { engagement: E } = boot({ page: 'student.html', url: 'http://localhost/' }).window.AM;

  test('maps every row to one of Focused / Passive / Distracted / Offline', () => {
    expect([ANA, BEN, CY, DEE].map(E.stateOf)).toEqual(['Focused', 'Distracted', 'Passive', 'Offline']);
    expect(E.stateOf(row({ id: 'x', name: 'X', attentionState: 'Idle', attentive: false }))).toBe('Passive');
    // the client says Focused but the server raised a flag -> not Focused
    expect(E.stateOf(row({ id: 'x', name: 'X', attentive: false }))).toBe('Passive');
    // legacy web-page-only student
    expect(E.stateOf(row({ id: 'x', name: 'X', attentionState: null, attentive: true }))).toBe('Focused');
    expect(E.stateOf(row({ id: 'x', name: 'X', attentionState: null, attentive: false, tabHidden: true }))).toBe('Distracted');
    expect(E.stateOf(row({ id: 'x', name: 'X', attentionState: null, attentive: false }))).toBe('Passive');
    expect(E.stateOf(null)).toBe('Offline');
  });

  test('classStats: counts, average, median, lowest, buckets, focus losses (offline scores are ignored)', () => {
    const s = E.classStats([ANA, BEN, CY, DEE]);
    expect(s.counts).toEqual({ Focused: 1, Passive: 1, Distracted: 1, Offline: 1 });
    expect(s.average).toBe(60); // (90+35+55)/3
    expect(s.median).toBe(55);
    expect(s.lowest).toBe(35);
    expect(s.belowThreshold).toBe(2);
    expect(s.buckets).toEqual([1, 1, 0, 1]);
    expect(s.focusLosses).toBe(5);
    expect(E.classStats([]).average).toBeNull();
  });

  test('sortRoster: lowest score, highest score, focus losses, needs-check-in-first, name', () => {
    const rows = [ANA, DEE, CY, BEN];
    const names = (key) => E.sortRoster(rows, key).map((r) => r.name);
    expect(names('score-asc')).toEqual(['Ben', 'Cy', 'Ana', 'Dee']);   // offline never first
    expect(names('score-desc')).toEqual(['Ana', 'Cy', 'Ben', 'Dee']);
    expect(names('focus-loss')).toEqual(['Ben', 'Cy', 'Ana', 'Dee']);
    expect(names('state')).toEqual(['Ben', 'Cy', 'Ana', 'Dee']);
    expect(names('name')).toEqual(['Ana', 'Ben', 'Cy', 'Dee']);
    expect(rows.map((r) => r.name)).toEqual(['Ana', 'Dee', 'Cy', 'Ben']); // input untouched
    const unscored = row({ id: 'u', name: 'Uma', focusScore: null, attentionState: null });
    expect(E.sortRoster([DEE, unscored, ANA], 'score-asc').map((r) => r.name)).toEqual(['Ana', 'Uma', 'Dee']);
  });

  test('filterRoster: name search and state filters', () => {
    const rows = [ANA, BEN, CY, DEE];
    expect(E.filterRoster(rows, { query: ' AN ' }).map((r) => r.name)).toEqual(['Ana']);
    expect(E.filterRoster(rows, { state: 'check-in' }).map((r) => r.name)).toEqual(['Ben', 'Cy']);
    expect(E.filterRoster(rows, { state: 'Offline' }).map((r) => r.name)).toEqual(['Dee']);
    expect(E.filterRoster(rows, { state: 'Focused', query: 'ben' })).toEqual([]);
  });
});

describe('educator dashboard', () => {
  const CLASS = { id: '11111111-1111-4111-8111-111111111111', classId: '11111111-1111-4111-8111-111111111111', name: 'Math 101', section: 'A', classCode: 'ABC234', educatorName: 'Prof Reyes', studentCount: 4, activeCount: 3 };

  const open = async () => {
    const charts = [];
    const sockets = { handlers: {}, emitted: [] };
    const writeText = jest.fn().mockResolvedValue();
    const t = boot({
      page: 'educator-dashboard.html', url: 'http://localhost/educator-dashboard.html',
      routes: {
        'GET /api/me': { status: 200, body: { user: { id: 'e', role: 'educator', name: 'Prof Reyes' } } },
        'GET /api/educator/classes': { status: 200, body: { classes: [CLASS] } }
      },
      setup: (w) => {
        stubChart(w, charts);
        Object.defineProperty(w.navigator, 'clipboard', { value: { writeText }, configurable: true });
        w.io = () => ({
          on: (name, fn) => { sockets.handlers[name] = fn; },
          emit: (name, payload, ack) => { sockets.emitted.push([name, payload]); if (typeof ack === 'function') ack({ ok: true }); }
        });
      },
      scripts: ['chartMatrix.js', 'educator.js']
    });
    await t.tick(60);
    return { ...t, charts, sockets, writeText };
  };

  const openClass = async (t, students = [ANA, BEN, CY, DEE]) => {
    t.window.location.hash = `#class/${CLASS.id}`; // a class opens on its own page
    await t.tick(60);
    t.sockets.handlers['class:update']({ classId: CLASS.id, students, timestamp: Date.now() });
    await t.tick(60);
  };
  const names = (t) => [...t.byId('studentTable').querySelectorAll('td.col-name')].map((td) => td.textContent);

  test('shows each class\'s permanent code prominently with a Copy Class Code button, and no way to change it', async () => {
    const t = await open();
    const card = t.$('.class-card');
    expect(card.textContent).toContain('ABC234');
    expect(card.querySelector('.class-code').textContent).toBe('ABC234');
    expect(card.querySelector('.visually-hidden').textContent).toBe('Class code: A B C 2 3 4');
    const buttons = [...card.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Copy Class Code');
    expect(buttons.join(' ')).not.toMatch(/new code|regenerate|rotate|change code/i);
    expect(read('educator-dashboard.html')).toMatch(/Class code \(permanent\)/);
    expect(read('js/educator.js')).not.toMatch(/rotate-code/);
    expect(read('educator-dashboard.html')).not.toMatch(/rotate|new code/i);
  });

  test('Copy Class Code copies the code and confirms inline, on the button and in a toast', async () => {
    const t = await open();
    const btn = t.$('.class-card button.btn-primary');
    btn.click();
    await t.tick();
    expect(t.writeText).toHaveBeenCalledWith('ABC234');
    expect(btn.textContent).toBe('Copied ✓');
    expect(t.$('.class-card .copy-status').textContent).toBe('Class code copied.');
    expect(t.byId('toast').textContent).toBe('Class code copied.');
    expect(t.$('.class-card .copy-status').getAttribute('role')).toBe('status');
  });

  test('the class dashboard header repeats the code with its own Copy Class Code button', async () => {
    const t = await open();
    await openClass(t);
    expect(t.byId('dashClassCode').textContent).toBe('ABC234');
    t.byId('dashCopyCodeBtn').click();
    await t.tick();
    expect(t.writeText).toHaveBeenLastCalledWith('ABC234');
    expect(t.byId('dashCopyStatus').textContent).toBe('Class code copied.');
    expect(t.sockets.emitted).toContainEqual(['educator:enterClass', { classId: CLASS.id }]);
  });

  test('never sends a student token to the API (cookie session only)', async () => {
    const t = await open();
    expect(t.calls.length).toBeGreaterThan(0);
    expect(t.calls.every((c) => c.headers.Authorization === undefined)).toBe(true);
  });

  test('live state cells, distribution metrics and the three charts update from class:update', async () => {
    const t = await open();
    await openClass(t);
    expect(['Focused', 'Passive', 'Distracted', 'Offline'].map((s) => t.byId(`cell${s}`).textContent)).toEqual(['1', '1', '1', '1']);
    expect(t.byId('cellFocusedPct').textContent).toBe('25%');
    expect(t.byId('metricAverage').textContent).toBe('60%');
    expect(t.byId('metricMedian').textContent).toBe('55%');
    expect(t.byId('metricLowest').textContent).toBe('35%');
    expect(t.byId('metricBelow').textContent).toBe('2');
    expect(t.byId('metricFocusLoss').textContent).toBe('5');

    const byTitle = (label) => t.charts.find((c) => c.config.data.datasets[0].label === label);
    expect(byTitle('Students') && t.charts.filter((c) => c.config.data.datasets[0].label === 'Students')).toHaveLength(2);
    const states = t.charts.find((c) => c.config.data.labels.includes('Offline'));
    expect(states.config.data.labels).toEqual(['Focused', 'Passive', 'Distracted', 'Offline']);
    expect(states.config.data.datasets[0].data).toEqual([1, 1, 1, 1]);
    const trend = byTitle('Class average');
    expect(trend.config.data.datasets[0].data).toEqual([60]);
    expect(trend.config.data.datasets[1].data).toEqual([60]); // dashed check-in threshold
    expect(trend.config.options.scales.y.max).toBe(100);
    const dist = t.charts.find((c) => c.config.data.labels.includes('80–100'));
    expect(dist.config.data.datasets[0].data).toEqual([1, 1, 0, 1]);
  });

  test('roster defaults to "needs a check-in first", shows state + score + focus losses per student', async () => {
    const t = await open();
    await openClass(t);
    expect(names(t)).toEqual(['Ben', 'Cy', 'Ana', 'Dee']);
    const ben = t.byId('studentTable').querySelector('tr');
    expect(ben.querySelector('.chip').textContent).toBe('Distracted');
    expect(ben.querySelector('.col-score .score-num').textContent).toBe('35%');
    expect(ben.querySelector('.col-focusLoss').textContent).toBe('4');
    expect(ben.querySelector('button').getAttribute('aria-label')).toBe('Remove Ben from this class');
    expect(t.byId('rosterCount').textContent).toBe('Showing 4 of 4 students.');
  });

  test('sort by lowest score / most focus losses and filter by state or name', async () => {
    const t = await open();
    await openClass(t, [ANA, DEE, CY, BEN]);
    const change = async (id, value) => { t.byId(id).value = value; t.byId(id).dispatchEvent(new t.window.Event('input', { bubbles: true })); await t.tick(60); };
    await change('sortSelect', 'score-asc');
    expect(names(t)).toEqual(['Ben', 'Cy', 'Ana', 'Dee']);
    await change('sortSelect', 'focus-loss');
    expect(names(t)).toEqual(['Ben', 'Cy', 'Ana', 'Dee']);
    await change('sortSelect', 'name');
    expect(names(t)).toEqual(['Ana', 'Ben', 'Cy', 'Dee']);
    await change('stateFilter', 'check-in');
    expect(names(t)).toEqual(['Ben', 'Cy']);
    expect(t.byId('rosterCount').textContent).toBe('Showing 2 of 4 students.');
    await change('stateFilter', 'Offline');
    expect(names(t)).toEqual(['Dee']);
    await change('stateFilter', 'all');
    await change('searchInput', 'zzz');
    expect(t.byId('studentTable').textContent).toMatch(/No students match the filter/);
  });

  test('keyboard + a11y: scrollable table region is focusable and labelled; every control has a label; a11y bar is present', async () => {
    const t = await open();
    const region = t.$('.table-wrap');
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('aria-labelledby')).toBe('rosterTitle');
    for (const id of ['searchInput', 'stateFilter', 'sortSelect']) expect(t.window.document.querySelector(`label[for="${id}"]`)).not.toBeNull();
    expect(t.byId('rosterCount').getAttribute('role')).toBe('status');
    expect(t.$('script[src="/js/a11y.js"]')).not.toBeNull();
    expect(t.byId('statusChartType').getAttribute('role')).toBe('radiogroup');
    expect(t.byId('averageChartType')).toBeNull(); // the trendline has no type switcher
  });

  test('rows stay put while the pointer or focus is inside the table, even if the sort order changes underneath', async () => {
    const t = await open();
    await openClass(t, [ANA, BEN, CY]);
    t.byId('sortSelect').value = 'score-asc'; t.byId('sortSelect').dispatchEvent(new t.window.Event('input', { bubbles: true }));
    await t.tick(60);
    expect(names(t)).toEqual(['Ben', 'Cy', 'Ana']);
    t.byId('studentTable').querySelector('button').focus(); // keyboard focus inside the table
    t.sockets.handlers['class:update']({ classId: CLASS.id, students: [{ ...ANA, focusScore: 10 }, BEN, CY], timestamp: Date.now() });
    await t.tick(60);
    expect(names(t)).toEqual(['Ben', 'Cy', 'Ana']); // Ana is now lowest but did not jump
    expect(t.byId('studentTable').querySelector('tr:last-child .score-num').textContent).toBe('10%');
  });
});

describe('student dashboard (passwordless)', () => {
  const lookup = (over = {}) => ({
    status: 200,
    body: {
      student: { id: 's', name: 'Ana Cruz', email: 'ana@school.edu' },
      class: { id: 'c', className: 'Math 101', section: 'A', classCode: 'ABC234', educatorName: 'Prof Reyes' },
      consent: { accepted: true, version: '2026-10', timestamp: '2026-10-19T01:00:00.000Z' },
      status: { ...row({ id: 's', name: 'Ana', focusScore: 72, lastActivityAt: 1000000 }), studentId: undefined, name: undefined, focusLossCount: 2 },
      timestamp: 1005000,
      ...over
    }
  });
  const page = ({ search = '', routes = {}, token = false, charts = [] } = {}) => boot({
    page: 'student.html', url: `http://localhost/student.html${search}`, routes,
    setup: (w) => {
      stubChart(w, charts);
      if (token) w.sessionStorage.setItem('am.token', FAKE_TOKEN);
      w.AM.confirmDialog = async () => true;
    },
    scripts: ['chartMatrix.js', 'privacy.js', 'student.js']
  });

  test('?token= signs the student in automatically, is stored in sessionStorage and removed from the URL', async () => {
    const t = page({ search: `?token=${FAKE_TOKEN}`, routes: { 'POST /api/student/lookup': lookup() } });
    await t.tick(60);
    expect(t.window.location.search).toBe('');
    expect(t.window.location.href).not.toContain(FAKE_TOKEN);
    expect(t.window.sessionStorage.getItem('am.token')).toBe(FAKE_TOKEN);
    const call = t.calls.find((c) => c.key === 'POST /api/student/lookup');
    expect(call.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(t.byId('lookupSection').classList.contains('hidden')).toBe(true);
    expect(t.byId('dashboard').classList.contains('hidden')).toBe(false);
    expect(t.byId('userName').textContent).toBe('Ana Cruz · Math 101 — A');
    expect(t.byId('signOutBtn').classList.contains('hidden')).toBe(false);
  });

  test('shows the live score, state badge, details and the streaming indicator', async () => {
    const t = page({ search: `?token=${FAKE_TOKEN}`, routes: { 'POST /api/student/lookup': lookup() } });
    await t.tick(60);
    expect(t.byId('scoreValue').textContent).toBe('72');
    expect(t.byId('scoreMeter').getAttribute('aria-valuenow')).toBe('72');
    expect(t.byId('stateBadge').textContent).toBe('Focused');
    expect(t.byId('stateBadge').className).toContain('state-focused');
    expect(t.byId('extStatusText').textContent).toBe('Active & Streaming');
    expect(t.byId('extStatus').className).toContain('ext-live');
    expect(t.byId('selfFocusLoss').textContent).toBe('2');
    expect(t.byId('classCodeText').textContent).toBe('ABC234');
  });

  test('personal time series: one point per new heartbeat, line chart with the check-in threshold', async () => {
    const charts = [];
    const t = page({ search: `?token=${FAKE_TOKEN}`, routes: { 'POST /api/student/lookup': lookup() }, charts });
    await t.tick(60);
    expect(charts).toHaveLength(1);
    expect(charts[0].config.type).toBe('line');
    expect(charts[0].config.data.datasets[0].data).toEqual([72]);
    expect(charts[0].config.data.datasets[1].data).toEqual([60]);
    expect(t.byId('selfChartEmpty').classList.contains('hidden')).toBe(true);
  });

  test('no recent heartbeat -> "Extension Offline — Open the browser extension to stream attentiveness", no live score', async () => {
    const stale = lookup({ timestamp: 1000000 + 60000 });
    const t = page({ search: `?token=${FAKE_TOKEN}`, routes: { 'POST /api/student/lookup': stale } });
    await t.tick(60);
    expect(t.byId('extStatusText').textContent).toBe('Extension Offline — Open the browser extension to stream attentiveness');
    expect(t.byId('extStatus').className).toContain('ext-offline');

    const none = page({ search: `?token=${FAKE_TOKEN}`, routes: { 'POST /api/student/lookup': lookup({ status: null }) } });
    await none.tick(60);
    expect(none.byId('extStatusText').textContent).toBe('Extension Offline — Open the browser extension to stream attentiveness');
    expect(none.byId('scoreValue').textContent).toBe('–');
    expect(none.byId('stateBadge').textContent).toBe('Offline');
    expect(none.byId('selfChartEmpty').classList.contains('hidden')).toBe(false);
  });

  test('without a token it asks for Full name, Email and Class code only, and shows the dashboard after a lookup', async () => {
    const t = page({ routes: { 'POST /api/student/lookup': lookup() } });
    await t.tick();
    expect(t.byId('lookupSection').classList.contains('hidden')).toBe(false);
    expect([...t.window.document.querySelectorAll('#lookupForm input')].map((i) => i.id)).toEqual(['lookupName', 'lookupEmail', 'lookupClassCode']);
    expect(t.$('input[type=password]')).toBeNull();
    expect(t.calls).toHaveLength(0);

    t.type('lookupName', 'Ana Cruz'); t.type('lookupEmail', 'ana@school.edu'); t.type('lookupClassCode', 'abc234');
    t.submit('lookupForm');
    await t.tick(60);
    const call = t.calls.find((c) => c.key === 'POST /api/student/lookup');
    expect(call.body).toEqual({ name: 'Ana Cruz', email: 'ana@school.edu', classCode: 'ABC234' });
    expect(call.headers.Authorization).toBeUndefined();
    expect(t.byId('dashboard').classList.contains('hidden')).toBe(false);
    expect(t.window.sessionStorage.getItem('am.token')).toBeNull(); // nothing identifying is stored
    expect(t.byId('signOutBtn').classList.contains('hidden')).toBe(true);
    expect([...t.window.document.querySelectorAll('.token-only')].every((n) => n.hidden)).toBe(true);
    expect(t.byId('tokenOnlyHint').classList.contains('hidden')).toBe(false);
  });

  test('lookup form: inline validation, and an unknown student is pointed to the Join page with the code', async () => {
    const t = page({ routes: { 'POST /api/student/lookup': { status: 404, body: { error: 'No student found' } } } });
    await t.tick();
    t.submit('lookupForm');
    await t.tick();
    expect(t.byId('lookupNameError').textContent).toMatch(/full name/);
    expect(t.calls).toHaveLength(0);
    t.type('lookupName', 'Ana Cruz'); t.type('lookupEmail', 'ana@school.edu'); t.type('lookupClassCode', 'zzzzzz');
    t.submit('lookupForm');
    await t.tick(60);
    expect(t.byId('lookupFormError').textContent).toMatch(/No student found/);
    expect(t.byId('joinInsteadLink').getAttribute('href')).toBe('/join.html?classCode=ZZZZZZ');
    expect(t.byId('dashboard').classList.contains('hidden')).toBe(true);
  });

  test('an expired or revoked token ends the session politely and offers the lookup form', async () => {
    const t = page({ token: true, routes: { 'POST /api/student/lookup': { status: 401, body: { error: 'Authentication required' } } } });
    await t.tick(60);
    expect(t.window.sessionStorage.getItem('am.token')).toBeNull();
    expect(t.byId('lookupSection').classList.contains('hidden')).toBe(false);
    expect(t.byId('sessionNotice').textContent).toMatch(/session ended/);
  });

  test('consent management: withdraw and give consent use /api/student/consent and refresh the view', async () => {
    let accepted = true;
    const t = page({ search: `?token=${FAKE_TOKEN}`, routes: {
      'POST /api/student/lookup': () => lookup({ consent: { accepted, version: '2026-10', timestamp: '2026-10-19T01:00:00.000Z' }, status: accepted ? lookup().body.status : null }),
      'POST /api/student/consent': (b) => { accepted = b.decision === 'accept'; return { status: 200, body: { accepted } }; }
    } });
    await t.tick(60);
    expect(t.byId('consentStatus').textContent).toMatch(/^Consent given on/);
    expect(t.byId('consentToggleBtn').textContent).toBe('Withdraw my consent');

    t.byId('consentToggleBtn').click();
    await t.tick(80);
    expect(t.calls.find((c) => c.key === 'POST /api/student/consent').body).toEqual({ decision: 'decline' });
    expect(t.byId('consentStatus').textContent).toBe('Consent not given. Nothing is being monitored.');
    expect(t.byId('consentToggleBtn').textContent).toBe('Give my consent');
    expect(t.byId('extStatusText').textContent).toBe('Monitoring paused — consent not given.');
    expect(t.byId('scoreValue').textContent).toBe('–');

    t.byId('consentToggleBtn').click();
    await t.tick(80);
    expect(t.calls.filter((c) => c.key === 'POST /api/student/consent').pop().body).toEqual({ decision: 'accept' });
    expect(t.byId('consentToggleBtn').textContent).toBe('Withdraw my consent');
  });

  test('delete my data and leave class use the token, clear it, and go back to the Join page', async () => {
    const t = page({ search: `?token=${FAKE_TOKEN}`, routes: { 'POST /api/student/lookup': lookup(), 'DELETE /api/student/me': { status: 200, body: {} }, 'POST /api/classes/leave': { status: 200, body: {} } } });
    await t.tick(60);
    t.byId('leaveClassBtn').click();
    await t.tick(60);
    expect(t.calls.find((c) => c.key === 'POST /api/classes/leave').body).toEqual({ classId: 'c' });
    expect(t.navigations).toEqual(['/join.html']);
    t.byId('deleteDataBtn').click();
    await t.tick(60);
    expect(t.calls.some((c) => c.key === 'DELETE /api/student/me')).toBe(true);
    expect(t.navigations.pop()).toBe('/join.html?deleted=1');
    expect(t.window.sessionStorage.getItem('am.token')).toBeNull();
  });

  test('"Sign out of this browser" only forgets the token locally (no server call that would sign out the extension)', async () => {
    const t = page({ search: `?token=${FAKE_TOKEN}`, routes: { 'POST /api/student/lookup': lookup() } });
    await t.tick(60);
    const before = t.calls.length;
    t.byId('signOutBtn').click();
    expect(t.calls.length).toBe(before);
    expect(t.window.sessionStorage.getItem('am.token')).toBeNull();
    expect(t.navigations).toEqual(['/join.html']);
  });

  test('is a read-only viewer: it never opens a socket (that would show the student as online without the extension)', () => {
    const source = read('js/student.js');
    expect(source).not.toMatch(/\bio\(/);
    expect(source).not.toMatch(/student:activity|enterClass/);
    expect(fs.readFileSync(path.join(__dirname, '../../public/student.html'), 'utf8')).not.toMatch(/socket\.io/);
  });
});

describe('privacy page (passwordless)', () => {
  const page = (search, routes = {}) => boot({ page: 'privacy.html', url: `http://localhost/privacy.html${search}`, routes, scripts: ['privacy.js'] });

  test('?preview=1 is read-only: no identification and no decision buttons', () => {
    const t = page('?preview=1');
    expect(t.byId('previewNote').classList.contains('hidden')).toBe(false);
    expect(t.byId('identifyCard').classList.contains('hidden')).toBe(true);
    expect(t.byId('decisionCard').classList.contains('hidden')).toBe(true);
    expect(t.calls).toHaveLength(0);
  });

  test('without a token it asks for email + class code, then offers Withdraw for an accepted student', async () => {
    const t = page('', { 'POST /api/student/lookup': { status: 200, body: { consent: { accepted: true, timestamp: '2026-10-19T01:00:00.000Z' } } },
      'POST /api/student/consent': { status: 200, body: { accepted: false } } });
    await t.tick();
    expect(t.byId('identifyCard').classList.contains('hidden')).toBe(false);
    t.type('identifyEmail', 'ana@school.edu'); t.type('identifyClassCode', 'abc234');
    t.submit('identifyForm');
    await t.tick(60);
    expect(t.calls[0].body).toEqual({ email: 'ana@school.edu', classCode: 'ABC234' });
    expect(t.byId('withdrawCard').classList.contains('hidden')).toBe(false);
    t.byId('withdrawBtn').click();
    await t.tick(60);
    expect(t.calls.find((c) => c.key === 'POST /api/student/consent').body).toEqual({ email: 'ana@school.edu', classCode: 'ABC234', decision: 'decline' });
    expect(t.byId('declinedCard').classList.contains('hidden')).toBe(false);
  });

  test('a token (from the extension) identifies the student with no form', async () => {
    const t = page(`?token=${FAKE_TOKEN}`, { 'POST /api/student/lookup': { status: 200, body: { consent: { accepted: false } } } });
    await t.tick(60);
    expect(t.window.location.search).toBe('');
    expect(t.byId('identifyCard').classList.contains('hidden')).toBe(true);
    expect(t.byId('decisionCard').classList.contains('hidden')).toBe(false);
  });

  test('the notice no longer mentions passwords hashes or Google sign-in', () => {
    const html = read('privacy.html');
    expect(html).not.toMatch(/password hash|Continue with Google/i);
  });
});
