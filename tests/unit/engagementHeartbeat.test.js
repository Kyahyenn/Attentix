const { EngagementState, constants } = require('../../src/state/engagementState');
const { smoothScore } = require('../../extension/scoring');

const user = { id: 'u1', name: 'Ana' };
const T0 = 1_000_000;
const beat = (o = {}) => ({ score: 100, state: 'Focused', location: 'meeting', isFocused: true, idleSeconds: 3, ...o });

describe('engagement state: v2 heartbeats', () => {
  let state;
  beforeEach(() => { state = new EngagementState(); state.connect('c1', user, T0); });
  const row = (now) => state.snapshot('c1', now)[0];
  // A beat sampled `agoMs` before `now`
  const send = (now, beats) => state.recordHeartbeats('c1', user, beats, now);

  test('first beat sets the score; later beats are smoothed with a time-weighted EMA', () => {
    send(T0 + 1000, [beat({ score: 100 })]);
    expect(row(T0 + 1000).focusScore).toBe(100);
    send(T0 + 11000, [beat({ score: 0, state: 'Distracted', isFocused: false, location: 'away' })]);
    // 10 s gap, tau 10 s: 100 * e^-1
    expect(row(T0 + 11000).focusScore).toBe(Math.round(100 * Math.exp(-1)));
  });

  test('a burst of 5 buffered beats weighs the same as the same beats sent live', () => {
    const live = new EngagementState();
    const burst = new EngagementState();
    const scores = [100, 80, 60, 40, 20];
    scores.forEach((score, i) => live.recordHeartbeats('c1', user, [beat({ score })], T0 + i * 5000));
    burst.recordHeartbeats('c1', user, scores.map((score, i) => beat({ score, ageMs: (4 - i) * 5000 })), T0 + 4 * 5000);
    expect(burst.snapshot('c1', T0 + 20000)[0].focusScore).toBe(live.snapshot('c1', T0 + 20000)[0].focusScore);
  });

  test('replayed or out-of-order beats are ignored (lost acknowledgement, re-send)', () => {
    expect(send(T0 + 10000, [beat({ score: 90, ageMs: 0 })])).toBe(1);
    expect(send(T0 + 10040, [beat({ score: 10, ageMs: 40 })])).toBe(0);   // same sample, re-sent a moment later
    expect(send(T0 + 12000, [beat({ score: 10, ageMs: 5000 })])).toBe(0); // older than the last accepted one
    expect(row(T0 + 12000).focusScore).toBe(90);
  });

  test('client clock is irrelevant: only the relative age counts, and ancient beats are dropped', () => {
    expect(send(T0 + 100000, [beat({ ageMs: constants.MAX_BEAT_AGE_MS })])).toBe(1);
    expect(state.recordHeartbeats('c1', user, [beat({ ageMs: 0 }), beat({ ageMs: 999999 })], T0 + 200000)).toBe(2);
  });

  test('focus-loss and distraction counters count transitions, not samples', () => {
    send(T0 + 1000, [beat()]);
    send(T0 + 6000, [beat({ isFocused: false, state: 'Distracted', location: 'away' })]);
    send(T0 + 11000, [beat({ isFocused: false, state: 'Distracted', location: 'away' })]);   // still away: no new count
    send(T0 + 16000, [beat()]);
    send(T0 + 21000, [beat({ isFocused: false, state: 'Distracted', location: 'away' })]);
    expect(row(T0 + 21000)).toMatchObject({ focusLossCount: 2, distractionCount: 2 });
    send(T0 + 26000, [beat({ state: 'Distracted' })]);   // distracted while focused (rapid switching) after being away
    expect(row(T0 + 26000).distractionCount).toBe(2);
  });

  test('rolling history: at most one point per 5 s, capped, newest last, and the row carries a short trend', () => {
    for (let i = 0; i < constants.HISTORY_MAX + 30; i += 1) send(T0 + 1000 + i * 5000, [beat({ score: i % 100 })]);
    const h = state.history('c1', 'u1');
    expect(h).toHaveLength(constants.HISTORY_MAX);
    expect(h[h.length - 1].t).toBeGreaterThan(h[0].t);
    send(T0 + 1000 + (constants.HISTORY_MAX + 30) * 5000 + 1500, [beat()]);          // <5 s after the last point
    expect(state.history('c1', 'u1')).toHaveLength(constants.HISTORY_MAX);
    expect(row(T0 + 9e6).trend.length).toBeLessThanOrEqual(constants.TREND_POINTS);
  });

  test('row shape: state, location, idle, counters; "Passive" with no mouse for minutes is NOT flagged (the lecture-video case)', () => {
    send(T0 + 1000, [beat({ state: 'Passive', idleSeconds: 400 })]);
    expect(row(T0 + 1000)).toMatchObject({ attentionState: 'Passive', location: 'meeting', idleSeconds: 400, attentive: true, reasons: [] });
  });

  test('Idle and Distracted explain themselves; away means the meeting tab is not in focus', () => {
    send(T0 + 1000, [beat({ state: 'Idle', idleSeconds: 400 })]);
    expect(row(T0 + 1000)).toMatchObject({ attentive: false });
    expect(row(T0 + 1000).reasons.join(' ')).toMatch(/No activity in the meeting/);
    send(T0 + 6000, [beat({ state: 'Distracted' })]);
    expect(row(T0 + 6000).reasons.join(' ')).toMatch(/Switching between tabs/);
    send(T0 + 11000, [beat({ state: 'Distracted', isFocused: false, location: 'meeting' })]);   // page hidden although Chrome says "meeting"
    expect(row(T0 + 11000)).toMatchObject({ tabHidden: true });
  });

  test('a student who only talks over REST (no socket) is online for 15 s after each heartbeat', () => {
    const rest = new EngagementState();
    rest.recordHeartbeats('c1', user, [beat()], T0, { rest: true });
    expect(rest.snapshot('c1', T0 + 1000)[0].online).toBe(true);
    expect(rest.onlineCount('c1', T0 + 1000)).toBe(1);
    expect(rest.snapshot('c1', T0 + 16000)[0].online).toBe(false);
  });

  test('selfView hides identity; resetClass and forgetUser clear the v2 data', () => {
    send(T0 + 1000, [beat()]);
    const view = state.selfView('c1', 'u1', T0 + 1000);
    expect(view.studentId).toBeUndefined();
    expect(view.name).toBeUndefined();
    expect(view.attentionState).toBe('Focused');
    state.resetClass('c1', T0 + 2000);
    expect(row(T0 + 2000)).toMatchObject({ attentionState: null, focusScore: null, distractionCount: 0, trend: [] });
    send(T0 + 3000, [beat()]);
    state.forgetUser('u1');
    expect(state.history('c1', 'u1')).toEqual([]);
  });

  test('legacy { focusScore } clients are untouched by v2 rows', () => {
    state.recordScore('c1', user, 40, T0 + 1000, { state: 'away', inputIdleMs: 0 });
    expect(row(T0 + 1000)).toMatchObject({ attentionState: null, focusScore: 40, tabHidden: true });
  });

  test('the number in the extension popup equals the number on the educator row: both smooth the same raw scores the same way, step by step', () => {
    const raw = [92, 88, 35, 20, 64, 97, 55];
    const gaps = [0, 5000, 5000, 7000, 3000, 10000, 5000]; // ms between samples; the first sample sets the score
    let local; let t = T0 + 1000;
    raw.forEach((score, i) => {
      t += gaps[i];
      local = Math.round(smoothScore(local, score, gaps[i] || 5000));
      send(t, [beat({ score })]);
      // the server rounds once per beat as well, so compare after each step rather than only at the end
      expect(Math.abs(row(t).focusScore - local)).toBeLessThanOrEqual(1);
    });
  });

  test('who is flagged: the student\'s CURRENT state decides for heartbeat clients, the 60% cut-off only for score-only clients', () => {
    // heartbeat client, meeting tab in focus: a low smoothed score alone does not flag them (they are back in class)
    send(T0 + 1000, [beat({ score: 40, state: 'Passive', isFocused: true })]);
    expect(row(T0 + 1000)).toMatchObject({ focusScore: 40, attentive: true, reasons: [] });
    // heartbeat client, meeting tab NOT in focus: flagged, and the reason quotes the smoothed score
    send(T0 + 2000, [beat({ score: 40, state: 'Distracted', isFocused: false, location: 'away' })]);
    expect(row(T0 + 2000).attentive).toBe(false);
    expect(row(T0 + 2000).reasons.join(' ')).toMatch(/Meeting tab not in focus \(focus score 40%\)/);

    // score-only (legacy) client: below EXTENSION_ATTENTIVE_MIN (60) is "away", 60 and above is attentive
    const legacy = new EngagementState();
    const other = { id: 'u2', name: 'Ben' };
    legacy.connect('c1', other, T0);
    legacy.recordScore('c1', other, 59, T0 + 1000);
    expect(legacy.snapshot('c1', T0 + 1000)[0]).toMatchObject({ attentive: false, tabHidden: true });
    const third = { id: 'u3', name: 'Cy' }; // the first score sets the value exactly, so this one sits right on the line
    legacy.connect('c1', third, T0);
    legacy.recordScore('c1', third, 60, T0 + 2000);
    const cy = legacy.snapshot('c1', T0 + 2000).find((r) => r.name === 'Cy');
    expect(cy).toMatchObject({ focusScore: 60, attentive: true });
  });
});
