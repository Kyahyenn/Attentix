/** educator-dashboard.html: Home overview, Classes (grid / list, search, sort, create) and one class on its own page. */
const { boot, cleanup, stubChart } = require('./domHarness');

afterEach(cleanup);

const NOW = Date.now();
const klass = (o) => ({
  id: o.id, classId: o.id, name: o.name, section: '', classCode: o.code, educatorName: 'Prof Reyes', studentCount: 0, activeCount: 0,
  createdAt: NOW - 86400000, scoredCount: 0, averageScore: null, belowThresholdCount: 0, lastActivityAt: null, ...o
});
const MATH = klass({ id: '11111111-1111-4111-8111-111111111111', name: 'Math 101', section: 'A', code: 'ABC234', studentCount: 4, activeCount: 3, scoredCount: 3, averageScore: 80, belowThresholdCount: 1, lastActivityAt: NOW - 120000, createdAt: NOW - 5 * 86400000 });
const PHYS = klass({ id: '22222222-2222-4222-8222-222222222222', name: 'Physics', code: 'XYZ789', studentCount: 6, activeCount: 1, scoredCount: 1, averageScore: 40, belowThresholdCount: 1, lastActivityAt: NOW - 3600000 * 3, createdAt: NOW - 2 * 86400000 });
const ART = klass({ id: '33333333-3333-4333-8333-333333333333', name: 'Art History', section: 'B', code: 'QRS567', studentCount: 9, createdAt: NOW - 1000 });
const ROW = { studentId: 's1', name: 'Ana', online: true, attentive: true, reasons: [], tabHidden: false, mouseIdleMs: 1000, tabSwitchCount: 0, chatResponses: 0, meetingChatMessages: 0, lastActivityAt: NOW, promptWaitingMs: null, focusScore: 90, attentionState: 'Focused', focusLossCount: 0, trend: [] };

const open = async ({ classes = [MATH, PHYS, ART], hash = '', extraRoutes = {}, storage = {} } = {}) => {
  const sockets = { handlers: {}, emitted: [] };
  const t = boot({
    page: 'educator-dashboard.html', url: `http://localhost/educator-dashboard.html${hash}`,
    routes: {
      'GET /api/me': { status: 200, body: { user: { id: 'e1', role: 'educator', name: 'Prof Reyes' } } },
      'GET /api/educator/classes': { status: 200, body: { classes } },
      'GET /api/server-info': { status: 500, body: { error: 'nope' } },
      ...extraRoutes
    },
    setup: (w) => {
      stubChart(w, []);
      Object.entries(storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.io = () => ({ on: (n, fn) => { sockets.handlers[n] = fn; }, emit: (n, p, ack) => { sockets.emitted.push([n, p]); if (typeof ack === 'function') ack({ ok: true }); }, close() {} });
    },
    scripts: ['nav.js', 'chartMatrix.js', 'educator.js']
  });
  await t.tick(80);
  return { ...t, sockets };
};
const cardNames = (t) => [...t.byId('classList').querySelectorAll('.class-card h3 a')].map((a) => a.textContent);
const go = async (t, hash) => { t.window.location.hash = hash; await t.tick(60); };

describe('Home: an overview, not a class', () => {
  test('summary cards: total classes, students, active now, average attentiveness (weighted) and who is below 60', async () => {
    const t = await open();
    expect(t.byId('homeClasses').textContent).toBe('3');
    expect(t.byId('homeStudents').textContent).toBe('19');
    expect(t.byId('homeActive').textContent).toBe('4');
    expect(t.byId('homeAverage').textContent).toBe('70%'); // (3*80 + 1*40) / 4
    expect(t.byId('homeBelow').textContent).toBe('2');
  });

  test('no live scores yet: the average is a dash, not 0%', async () => {
    const t = await open({ classes: [ART] });
    expect(t.byId('homeAverage').textContent).toBe('–');
    expect(t.byId('homeBelow').textContent).toBe('0');
  });

  test('Home never shows a class dashboard', async () => {
    const t = await open();
    expect(t.byId('panel-home').contains(t.byId('dashboardSection'))).toBe(false);
    expect(t.byId('panel-home').contains(t.byId('studentTable'))).toBe(false);
  });

  test('quick actions: Create Class opens the create dialog, View Classes goes to the Classes page', async () => {
    const t = await open();
    expect(t.byId('quickCreateBtn').textContent).toMatch(/Create Class/);
    expect(t.byId('createClassDialog').hasAttribute('open')).toBe(false);
    t.byId('quickCreateBtn').click();
    expect(t.byId('createClassDialog').hasAttribute('open')).toBe(true);
    expect(t.byId('quickViewBtn').getAttribute('href')).toBe('#classes');
    expect(t.byId('quickViewBtn').textContent).toMatch(/View Classes/);
    await go(t, '#classes');
    expect(t.byId('panel-classes').hidden).toBe(false);
  });

  test('recent activity lists the classes with student activity, newest first, linking to each class page', async () => {
    const t = await open();
    const items = [...t.byId('recentActivity').querySelectorAll('li')];
    expect(items.map((li) => li.querySelector('a').textContent)).toEqual(['Math 101 — A', 'Physics']);
    expect(items[0].querySelector('a').getAttribute('href')).toBe(`#class/${MATH.id}`);
    expect(items[0].textContent).toMatch(/3 active now/);
    expect(items[0].textContent).toMatch(/2 min ago/);
    expect(items[0].textContent).toMatch(/1 below 60/);
    expect(t.byId('activityEmpty').hidden).toBe(true);
  });

  test('with no activity at all it says so', async () => {
    const t = await open({ classes: [ART] });
    expect(t.byId('recentActivity').children).toHaveLength(0);
    expect(t.byId('activityEmpty').hidden).toBe(false);
    expect(t.byId('recentEmpty').hidden).toBe(false);
  });

  test('recently opened: remembered per educator, newest first, and a class that no longer exists is dropped', async () => {
    const saved = JSON.stringify([{ id: PHYS.id, at: NOW - 60000 }, { id: 'gone-class', at: NOW - 30000 }, { id: ART.id, at: NOW - 600000 }]);
    const t = await open({ storage: { 'am.recentClasses.e1': saved } });
    expect([...t.byId('recentClasses').querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Physics', 'Art History — B']);
    expect(t.byId('recentEmpty').hidden).toBe(true);
    await go(t, `#class/${MATH.id}`);
    expect([...t.byId('recentClasses').querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Math 101 — A', 'Physics', 'Art History — B']);
    const stored = JSON.parse(t.window.localStorage.getItem('am.recentClasses.e1'));
    expect(stored[0].id).toBe(MATH.id);
    expect(Object.keys(stored[0]).sort()).toEqual(['at', 'id']); // ids and times only
  });

  test('a corrupt remembered list is ignored', async () => {
    const t = await open({ storage: { 'am.recentClasses.e1': '{ nope' } });
    expect(t.byId('recentClasses').children).toHaveLength(0);
  });
});

describe('Classes page', () => {
  test('lists every class as its own card, A–Z, in a grid by default', async () => {
    const t = await open();
    expect(cardNames(t)).toEqual(['Art History', 'Math 101', 'Physics']);
    expect(t.byId('classList').classList.contains('view-grid')).toBe(true);
    expect(t.byId('viewGrid').getAttribute('aria-pressed')).toBe('true');
    expect(t.byId('classCount').textContent).toBe('Showing 3 of 3 classes.');
  });

  test('each card is a link to that class\'s page and still has Copy Class Code', async () => {
    const t = await open();
    const card = t.$(`.class-card[data-class-id="${MATH.id}"]`);
    expect(card.querySelector('h3 a').getAttribute('href')).toBe(`#class/${MATH.id}`);
    expect(card.querySelector('h3 a').getAttribute('aria-label')).toBe('Open Math 101 — A');
    expect(card.querySelector('.class-code').textContent).toBe('ABC234');
    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Copy Class Code']);
    expect(card.textContent).toMatch(/Students: 4 · Active now: 3/);
  });

  test('Grid / List toggle switches the layout, is announced with aria-pressed and is remembered', async () => {
    const t = await open();
    t.byId('viewList').click();
    expect(t.byId('classList').classList.contains('view-list')).toBe(true);
    expect(t.byId('classList').classList.contains('view-grid')).toBe(false);
    expect(t.byId('viewList').getAttribute('aria-pressed')).toBe('true');
    expect(t.byId('viewGrid').getAttribute('aria-pressed')).toBe('false');
    expect(cardNames(t)).toHaveLength(3);                    // same entries in both layouts
    expect(t.window.localStorage.getItem('am.classes.view')).toBe('list');
    cleanup();
    const again = await open({ storage: { 'am.classes.view': 'list' } });
    expect(again.byId('classList').classList.contains('view-list')).toBe(true);
    again.byId('viewGrid').click();
    expect(again.byId('classList').classList.contains('view-grid')).toBe(true);
  });

  test('search matches name, section or code, says how many are shown, and has a no-results message', async () => {
    const t = await open();
    const search = (q) => { t.type('classSearch', q); t.byId('classSearch').dispatchEvent(new t.window.Event('input', { bubbles: true })); };
    search('phys');
    expect(cardNames(t)).toEqual(['Physics']);
    expect(t.byId('classCount').textContent).toBe('Showing 1 of 3 classes.');
    search('qrs5');
    expect(cardNames(t)).toEqual(['Art History']);
    search('  HISTORY ');                                   // case and spaces do not matter
    expect(cardNames(t)).toEqual(['Art History']);
    search('zzz');
    expect(t.byId('classList').textContent).toMatch(/No classes match “zzz”/);
    search('');
    expect(cardNames(t)).toHaveLength(3);
  });

  test('sort: name, newest, most students, most active, recently opened', async () => {
    const t = await open({ storage: { 'am.recentClasses.e1': JSON.stringify([{ id: PHYS.id, at: NOW }, { id: MATH.id, at: NOW - 1000 }]) } });
    const sort = (value) => { t.byId('classSort').value = value; t.byId('classSort').dispatchEvent(new t.window.Event('change', { bubbles: true })); return cardNames(t); };
    expect(sort('name')).toEqual(['Art History', 'Math 101', 'Physics']);
    expect(sort('newest')).toEqual(['Art History', 'Physics', 'Math 101']);
    expect(sort('students')).toEqual(['Art History', 'Physics', 'Math 101']);
    expect(sort('active')).toEqual(['Math 101', 'Physics', 'Art History']);
    expect(sort('recent')).toEqual(['Physics', 'Math 101', 'Art History']);
    expect(t.window.localStorage.getItem('am.classes.sort')).toBe('recent');
  });

  test('Create Class button opens the dialog; creating posts the class, closes the dialog and refreshes the list', async () => {
    let created = false;
    const t = await open({
      classes: [MATH],
      extraRoutes: {
        'POST /api/classes': () => { created = true; return { status: 201, body: { class: {} } }; },
        'GET /api/educator/classes': () => ({ status: 200, body: { classes: created ? [MATH, ART] : [MATH] } })
      }
    });
    await go(t, '#classes');
    t.byId('createClassOpenBtn').click();
    expect(t.byId('createClassDialog').hasAttribute('open')).toBe(true);
    t.type('classNameInput', 'Art History'); t.type('classSectionInput', 'B');
    t.submit('createClassForm');
    await t.tick(80);
    expect(t.calls.find((c) => c.key === 'POST /api/classes').body).toEqual({ name: 'Art History', section: 'B' });
    expect(t.byId('createClassDialog').hasAttribute('open')).toBe(false);
    expect(cardNames(t)).toEqual(['Art History', 'Math 101']);
    expect(t.byId('classNameInput').value).toBe('');
  });

  test('a name that is too short is refused inline and nothing is sent', async () => {
    const t = await open();
    t.byId('createClassOpenBtn').click();
    t.type('classNameInput', 'ab');
    t.submit('createClassForm');
    await t.tick(30);
    expect(t.byId('classNameInputError').textContent).toMatch(/at least 3 characters/);
    expect(t.calls.some((c) => c.key === 'POST /api/classes')).toBe(false);
    expect(t.byId('createClassDialog').hasAttribute('open')).toBe(true);
  });

  test('Cancel closes the dialog', async () => {
    const t = await open();
    t.byId('createClassOpenBtn').click();
    t.byId('createCancelBtn').click();
    expect(t.byId('createClassDialog').hasAttribute('open')).toBe(false);
  });

  test('no classes yet: an empty state with a Create button', async () => {
    const t = await open({ classes: [] });
    expect(t.byId('classList').textContent).toMatch(/No classes yet/);
    t.byId('classList').querySelector('button').click();
    expect(t.byId('createClassDialog').hasAttribute('open')).toBe(true);
  });
});

describe('One class on its own page', () => {
  test('shows only the selected class: its information, monitoring and tools, and no other class', async () => {
    const t = await open();
    await go(t, `#class/${PHYS.id}`);
    const page = t.byId('panel-class');
    expect(page.hidden).toBe(false);
    expect(t.byId('dashboardClassTitle').textContent).toBe('Physics');
    expect(t.byId('dashClassCode').textContent).toBe('XYZ789');
    ['resetBtn', 'exportCsvBtn', 'printBtn', 'dashCopyCodeBtn', 'dashCopyLinkBtn', 'dashDownloadBtn', 'sendPromptBtn', 'studentTable', 'statusChart', 'averageChart', 'scoreChart']
      .forEach((id) => expect(page.contains(t.byId(id))).toBe(true));
    expect(page.textContent).not.toMatch(/Math 101|Art History|ABC234|QRS567/);
    expect(page.querySelector('.class-card')).toBeNull();
    expect(t.byId('classList').closest('#panel-class')).toBeNull();
    expect(t.sockets.emitted).toContainEqual(['educator:enterClass', { classId: PHYS.id }]);
  });

  test('Back to Classes is a clear link, and it returns to the list', async () => {
    const t = await open();
    await go(t, `#class/${MATH.id}`);
    const back = t.byId('backToClasses');
    expect(back.textContent.trim()).toBe('Back to Classes');
    expect(back.getAttribute('href')).toBe('#classes');
    back.click();
    await t.tick(60);
    expect(t.window.AMNav.current()).toBe('classes');
    expect(t.byId('panel-classes').hidden).toBe(false);
    expect(t.byId('panel-class').hidden).toBe(true);
    expect(cardNames(t)).toHaveLength(3);
  });

  test('opening the page address directly (refresh, bookmark) lands on that class', async () => {
    const t = await open({ hash: `#class/${ART.id}` });
    expect(t.window.AMNav.current()).toBe('class');
    expect(t.byId('dashboardClassTitle').textContent).toBe('Art History — B');
    expect(t.$('#tab-classes').getAttribute('aria-selected')).toBe('true');
  });

  test('live updates are for the open class only: another class\'s roster never appears', async () => {
    const t = await open();
    await go(t, `#class/${MATH.id}`);
    t.sockets.handlers['class:update']({ classId: PHYS.id, students: [{ ...ROW, name: 'Zed Other' }], timestamp: NOW });
    t.sockets.handlers['class:update']({ classId: MATH.id, students: [ROW], timestamp: NOW });
    await t.tick(60);
    expect(t.byId('studentTable').textContent).toContain('Ana');
    expect(t.byId('studentTable').textContent).not.toContain('Zed Other');
  });

  test('going back drops the roster; opening a different class starts clean', async () => {
    const t = await open();
    await go(t, `#class/${MATH.id}`);
    t.sockets.handlers['class:update']({ classId: MATH.id, students: [ROW], timestamp: NOW });
    await t.tick(60);
    expect(t.byId('studentTable').textContent).toContain('Ana');
    await go(t, '#classes');
    expect(t.byId('studentTable').children).toHaveLength(0);
    expect(t.byId('dashboardSection').classList.contains('hidden')).toBe(true);
    await go(t, `#class/${PHYS.id}`);
    expect(t.byId('studentTable').textContent).not.toContain('Ana');
    expect(t.byId('dashboardClassTitle').textContent).toBe('Physics');
  });

  test('an unknown class id says so, offers the way back and shows no dashboard', async () => {
    const t = await open({ hash: '#class/00000000-0000-4000-8000-000000000000' });
    expect(t.byId('classMissing').classList.contains('hidden')).toBe(false);
    expect(t.byId('dashboardSection').classList.contains('hidden')).toBe(true);
    expect(t.byId('backToClasses').getAttribute('href')).toBe('#classes');
    expect(t.sockets.emitted.some(([name]) => name === 'educator:enterClass')).toBe(false);
  });

  test('the class page keeps its tools: copy code, copy invite link, send a question', async () => {
    const writeText = jest.fn().mockResolvedValue();
    const t = await open();
    Object.defineProperty(t.window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    await go(t, `#class/${MATH.id}`);
    t.byId('dashCopyCodeBtn').click(); await t.tick();
    expect(writeText).toHaveBeenLastCalledWith('ABC234');
    t.byId('dashCopyLinkBtn').click(); await t.tick();
    expect(writeText).toHaveBeenLastCalledWith('http://localhost/join?classCode=ABC234');
    t.type('promptText', 'Are you with me?');
    t.byId('sendPromptBtn').click();
    await t.tick();
    expect(t.sockets.emitted).toContainEqual(['educator:sendPrompt', { classId: MATH.id, text: 'Are you with me?' }]);
  });
});
