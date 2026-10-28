const { EngagementState } = require('../../src/state/engagementState');

const user = { id: 'u1', name: 'Ana' };
const T0 = 1_000_000;

describe('engagement state', () => {
  let state;
  beforeEach(() => { state = new EngagementState(); state.connect('c1', user, T0); });
  const row = (now) => state.snapshot('c1', now)[0];

  test('student page: leaving the page counts a tab switch', () => {
    state.recordActivity('c1', user, 'visibility-hidden', true, T0 + 1000);
    state.recordActivity('c1', user, 'visibility-visible', false, T0 + 2000);
    state.recordActivity('c1', user, 'blur', true, T0 + 3000);
    expect(row(T0 + 3000).tabSwitchCount).toBe(2);
  });

  test('while the extension is reporting, the student page does NOT add tab switches (app page <-> meeting is not leaving class)', () => {
    state.recordScore('c1', user, 100, T0 + 1000, { state: 'meeting', inputIdleMs: 0 });
    state.recordActivity('c1', user, 'visibility-hidden', true, T0 + 2000);   // went from the app page to the meeting tab
    state.recordActivity('c1', user, 'visibility-visible', false, T0 + 3000);
    state.recordActivity('c1', user, 'blur', true, T0 + 4000);
    expect(row(T0 + 4000).tabSwitchCount).toBe(0);
    expect(row(T0 + 4000).attentive).toBe(true);
  });

  test('extension: mouse/keyboard idle in the meeting is reported and flagged after a minute', () => {
    state.recordScore('c1', user, 100, T0 + 1000, { state: 'meeting', inputIdleMs: 5000 });
    expect(row(T0 + 1000).mouseIdleMs).toBe(5000);
    state.recordScore('c1', user, 100, T0 + 70_000, { state: 'meeting', inputIdleMs: 75_000 });
    expect(row(T0 + 70_000)).toMatchObject({ attentive: false, mouseIdleMs: 75_000 });
    expect(row(T0 + 70_000).reasons.join(' ')).toMatch(/No mouse or keyboard activity in the meeting for 75s/);
  });

  test('extension: sitting on the app page is not "idle" and not "away"', () => {
    state.recordScore('c1', user, 85, T0 + 90_000, { state: 'tool', inputIdleMs: 90_000 });
    expect(row(T0 + 90_000)).toMatchObject({ attentive: true, tabHidden: false });
  });

  test('extension: state is immediate - back in the meeting is attentive at once, even if the smoothed score is still low', () => {
    state.recordScore('c1', user, 30, T0 + 1000, { state: 'away', inputIdleMs: 0 });
    expect(row(T0 + 1000)).toMatchObject({ attentive: false, tabHidden: true });
    state.recordScore('c1', user, 35, T0 + 3000, { state: 'meeting', inputIdleMs: 0 });
    expect(row(T0 + 3000)).toMatchObject({ attentive: true, tabHidden: false });
  });

  test('extension tab switches and the "left the meeting N times" reason', () => {
    state.recordScore('c1', user, 100, T0 + 1000, { state: 'meeting', inputIdleMs: 0 });
    [2000, 3000, 4000].forEach((dt) => state.recordTabSwitch('c1', user, T0 + dt));
    expect(row(T0 + 4000).tabSwitchCount).toBe(3);
    expect(row(T0 + 4000).reasons.join(' ')).toMatch(/Left the meeting 3 times/);
  });

  test('meeting chat: every sent message is counted, but only counts as an ANSWER while a question is waiting', () => {
    state.recordMeetingChat('c1', user, T0 + 1000);
    expect(row(T0 + 1000)).toMatchObject({ meetingChatMessages: 1, chatResponses: 0 });

    state.recordPrompt('c1', T0 + 2000);
    expect(row(T0 + 50_000).reasons.join(' ')).toMatch(/No response to the educator's question/);
    state.recordMeetingChat('c1', user, T0 + 51_000);
    expect(row(T0 + 51_000)).toMatchObject({ meetingChatMessages: 2, chatResponses: 1, promptWaitingMs: null });

    state.recordMeetingChat('c1', user, T0 + 52_000);     // chatting again, no question pending
    expect(row(T0 + 52_000).chatResponses).toBe(1);
  });

  test('a student with a stale extension score and no page data shows as having no meeting tab', () => {
    state.recordScore('c1', user, 100, T0 + 1000, { state: 'meeting', inputIdleMs: 0 });
    expect(row(T0 + 40_000).reasons).toEqual(['No Meet/Zoom meeting tab detected.']);
  });
});
