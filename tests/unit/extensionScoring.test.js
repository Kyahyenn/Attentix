const {
  isMeetingUrl, isToolUrl, isExtensionUrl, locate, computeAttentiveness, recencyCurve, mergeFrameSignals, smoothScore, summarizeSwitches,
  newSwitchTracker, stepSwitchTracker, AWAY_TICKS_TO_COUNT
} = require('../../extension/scoring');

describe('extension: meeting URL detection', () => {
  test.each([
    'https://meet.google.com/abc-defg-hij',
    'https://meet.google.com/abc-defg-hij?authuser=1',
    'https://app.zoom.us/wc/87654321098/join?pwd=x',
    'https://zoom.us/wc/87654321098/start',
    'https://zoom.us/wc/join/87654321098',
    'https://us02web.zoom.us/wc/123456789/join'
  ])('accepts %s', (url) => expect(isMeetingUrl(url)).toBe(true));

  test.each([
    'https://meet.google.com/landing',
    'https://meet.google.com/new',
    'https://meet.google.com/',
    'http://meet.google.com/abc-defg-hij',            // not https
    'https://meet.google.com.evil.com/abc-defg-hij',
    'https://evilzoom.us/wc/87654321098/join',
    'https://zoom.us/j/87654321098',                  // join page, not the web client
    'https://zoom.us/wc/123/join',                    // id too short
    undefined,
    null
  ])('rejects %s', (url) => expect(isMeetingUrl(url)).toBe(false));
});

const base = { isFocused: true, idleSeconds: 2, activeBuckets: 0, scrolling: false, mediaPlaying: false, onToolPage: false, tabSwitches: 0, rapidSwitches: 0 };
const score = (o) => computeAttentiveness({ ...base, ...o });

describe('extension: attentiveness score', () => {
  test('active in the class tab = 100 and Focused', () => {
    expect(score({ activeBuckets: 8 })).toMatchObject({ score: 100, state: 'Focused', isFocused: true, idleSeconds: 2, tabSwitches: 0 });
  });

  test('a student watching a lecture video is not penalised as idle, even after 10 minutes without touching anything', () => {
    const r = score({ idleSeconds: 600, mediaPlaying: true });
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.state).toBe('Passive');
  });

  test('steady reading/scrolling is rewarded and counts as active', () => {
    expect(score({ idleSeconds: 90, scrolling: true })).toMatchObject({ state: 'Focused' });
    expect(score({ idleSeconds: 90, scrolling: true }).score).toBeGreaterThanOrEqual(90);
  });

  test('idle-time decay: the score falls as quiet time grows, and 5+ quiet minutes with nothing playing is Idle', () => {
    const at = (idleSeconds) => score({ idleSeconds }).score;
    expect(at(10)).toBeGreaterThan(at(60));
    expect(at(60)).toBeGreaterThan(at(200));
    expect(at(200)).toBeGreaterThan(at(600));
    expect(at(86400)).toBeGreaterThanOrEqual(50);             // present but quiet is never zero
    expect(score({ idleSeconds: 120 }).state).toBe('Passive'); // listening to a lecture
    expect(score({ idleSeconds: 299 }).state).toBe('Passive');
    expect(score({ idleSeconds: 300 }).state).toBe('Idle');
    expect(score({ idleSeconds: 300, mediaPlaying: true }).state).toBe('Passive');
    expect(score({ idleSeconds: null, onToolPage: true }).state).toBe('Passive');
  });

  test('class tab not in front: Distracted with a low score, whatever the page claims', () => {
    const r = score({ isFocused: false, idleSeconds: 0, activeBuckets: 20, mediaPlaying: true });
    expect(r.state).toBe('Distracted');
    expect(r.score).toBeLessThanOrEqual(20);
    expect(r.isFocused).toBe(false);
  });

  test('rapid tab switching is penalised and is Distracted even while "active"', () => {
    const calm = score({ activeBuckets: 8, tabSwitches: 1, rapidSwitches: 1 });
    const rapid = score({ activeBuckets: 8, tabSwitches: 4, rapidSwitches: 4 });
    expect(calm).toMatchObject({ score: 95, state: 'Focused', tabSwitches: 1 });
    expect(rapid.score).toBeLessThan(calm.score - 25);
    expect(rapid.state).toBe('Distracted');
    expect(score({ activeBuckets: 8, tabSwitches: 99, rapidSwitches: 99 }).score).toBe(60);  // penalty is capped at 40
  });

  test('score is always an integer 0-100 and the state one of the four', () => {
    for (const idleSeconds of [null, 0, 15, 100, 1000, 1e9]) {
      for (const isFocused of [true, false]) {
        const r = score({ isFocused, idleSeconds, tabSwitches: 50, rapidSwitches: 9, activeBuckets: 99, mediaPlaying: true });
        expect(Number.isInteger(r.score) && r.score >= 0 && r.score <= 100).toBe(true);
        expect(['Focused', 'Passive', 'Distracted', 'Idle']).toContain(r.state);
      }
    }
    expect(computeAttentiveness({}).state).toBe('Distracted');   // no signals at all: not focused
  });

  test('recency curve is monotone', () => {
    let prev = 2;
    for (const s of [0, 15, 30, 120, 200, 300, 600, 900, 5000]) { const v = recencyCurve(s); expect(v).toBeLessThanOrEqual(prev); prev = v; }
  });
});

describe('extension: merging what each frame reported', () => {
  const T = 100000;
  test('nothing fresh -> null; stale frames are ignored', () => {
    expect(mergeFrameSignals([], T)).toBeNull();
    expect(mergeFrameSignals([{ receivedAt: T - 20000, idleMs: 0 }], T)).toBeNull();
  });
  test('idle is the most recent interaction in ANY frame and keeps growing between reports', () => {
    const m = mergeFrameSignals([
      { receivedAt: T - 2000, idleMs: 30000, media: false, buckets: 1, visible: true },
      { receivedAt: T - 1000, idleMs: 4000, media: true, scrolling: true, buckets: 6, visible: true }
    ], T);
    expect(m).toMatchObject({ idleSeconds: 5, mediaPlaying: true, scrolling: true, activeBuckets: 6, visible: true });
  });
});

describe('extension: switch window + smoothing helpers', () => {
  test('summarizeSwitches separates the last minute from the last five', () => {
    const now = 1e6;
    expect(summarizeSwitches([now - 400000, now - 200000, now - 30000, now - 1000], now)).toMatchObject({ recent: 3, rapid: 2 });
  });
  test('smoothScore is a time-weighted EMA that matches the server', () => {
    expect(smoothScore(undefined, 80, 2000)).toBe(80);
    const v = smoothScore(100, 0, 10000);
    expect(v).toBeCloseTo(100 * Math.exp(-1), 5);
  });
});

describe('extension: where the student is', () => {
  test('pages of the app server count as "tool", nothing else does', () => {
    const origin = 'http://localhost:3000';
    expect(isToolUrl('http://localhost:3000/student.html', origin)).toBe(true);
    expect(isToolUrl('http://localhost:3000', origin)).toBe(true);
    expect(isToolUrl('http://localhost:30001/x', origin)).toBe(false);
    expect(isToolUrl('http://localhost:3000.evil.com/', origin)).toBe(false);
    expect(isToolUrl('https://youtube.com/', origin)).toBe(false);
    expect(isToolUrl(undefined, origin)).toBe(false);
    expect(isToolUrl('http://localhost:3000/x', null)).toBe(false);
  });

  // Runs a sequence of states and returns how many tab switches were counted.
  const run = (states) => states.reduce((acc, state) => {
    const { tracker, switched } = stepSwitchTracker(acc.tracker, state);
    return { tracker, count: acc.count + (switched ? 1 : 0) };
  }, { tracker: newSwitchTracker(), count: 0 }).count;

  test('a real trip away is counted once, however long it lasts', () => {
    expect(run(['meeting', 'away', 'away'])).toBe(1);
    expect(run(['meeting', 'away', 'away', 'away', 'away', 'away', 'away'])).toBe(1);
  });

  test('a one-sample flicker through another tab is not counted', () => {
    expect(AWAY_TICKS_TO_COUNT).toBe(2);
    expect(run(['meeting', 'away', 'meeting', 'away', 'meeting'])).toBe(0);
  });

  test('going between the meeting and the app page is never a switch', () => {
    expect(run(['meeting', 'tool', 'tool', 'meeting', 'tool', 'meeting', 'tool'])).toBe(0);
  });

  test('away -> back (meeting or tool) -> away counts twice', () => {
    expect(run(['meeting', 'away', 'away', 'meeting', 'away', 'away'])).toBe(2);
    expect(run(['meeting', 'away', 'away', 'tool', 'away', 'away'])).toBe(2);
  });

  test('starting while already on another tab is not a switch until the student has been in class', () => {
    expect(run(['away', 'away', 'away'])).toBe(0);
    expect(run(['away', 'away', 'meeting', 'away', 'away'])).toBe(1);
  });

  test('closing the meeting tab resets tracking (that is not a switch)', () => {
    expect(run(['meeting', 'none', 'away', 'away'])).toBe(0);
  });
});

describe('extension: where is the student? (popup and extension pages are part of class)', () => {
  const MEET = 'https://meet.google.com/abc-defg-hij';
  const ctx = { serverOrigin: 'http://192.168.1.20:3000', extensionOrigin: 'chrome-extension://abcdef/' };

  test('extension pages count, lookalikes do not', () => {
    expect(isExtensionUrl('chrome-extension://abcdef/popup.html', 'chrome-extension://abcdef/')).toBe(true);
    expect(isExtensionUrl('chrome-extension://abcdef/', 'chrome-extension://abcdef/')).toBe(true);
    expect(isExtensionUrl('chrome-extension://abcdefg/popup.html', 'chrome-extension://abcdef/')).toBe(false);
    expect(isExtensionUrl('https://evil.example/chrome-extension://abcdef/', 'chrome-extension://abcdef/')).toBe(false);
    expect(isExtensionUrl(undefined, 'chrome-extension://abcdef/')).toBe(false);
    expect(isExtensionUrl('chrome-extension://abcdef/popup.html', '')).toBe(false);
  });

  test('the meeting tab in a focused window is the meeting; another tab is away', () => {
    expect(locate({ ...ctx, activeUrl: MEET, windowFocused: true })).toBe('meeting');
    expect(locate({ ...ctx, activeUrl: 'https://www.youtube.com/', windowFocused: true })).toBe('away');
    expect(locate({ ...ctx, activeUrl: null, windowFocused: true })).toBe('away');
  });

  test('another application (window not focused, no popup) is away', () => {
    expect(locate({ ...ctx, activeUrl: MEET, windowFocused: false, popupOpen: false })).toBe('away');
  });

  test('an open toolbar popup keeps the window counted as in front: meeting stays meeting, other tabs stay away', () => {
    expect(locate({ ...ctx, activeUrl: MEET, windowFocused: false, popupOpen: true })).toBe('meeting');
    expect(locate({ ...ctx, activeUrl: 'https://www.youtube.com/', windowFocused: false, popupOpen: true })).toBe('away');
  });

  test('the Attention Monitor site and the extension\'s own pages are "tool", never away', () => {
    expect(locate({ ...ctx, activeUrl: 'http://192.168.1.20:3000/student.html', windowFocused: true })).toBe('tool');
    expect(locate({ ...ctx, activeUrl: 'chrome-extension://abcdef/popup.html', windowFocused: true })).toBe('tool');
    expect(locate({ ...ctx, activeUrl: 'chrome-extension://abcdef/popup.html', windowFocused: false, popupOpen: true })).toBe('tool');
  });

  test('a student who opens the popup while already away is not charged a second switch', () => {
    let tracker = newSwitchTracker(); let switches = 0;
    const step = (state) => { const r = stepSwitchTracker(tracker, state); tracker = r.tracker; if (r.switched) switches += 1; };
    step('meeting');
    step(locate({ ...ctx, activeUrl: 'https://www.youtube.com/', windowFocused: true })); step('away'); // one trip away counted
    for (let i = 0; i < 5; i += 1) step(locate({ ...ctx, activeUrl: 'https://www.youtube.com/', windowFocused: false, popupOpen: true }));
    expect(switches).toBe(1);
  });
});
