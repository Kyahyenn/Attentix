// Per-class, per-student engagement picture behind the dashboard's `class:update` event. Two sources feed the same row:
//   * the web student page -> activity events (mouse/keyboard, tab hidden/blur) and chat responses
//   * the Chrome extension -> a 0-100 score; v2 clients send heartbeats (score + state), smoothed here with a time-weighted EMA
const IDLE_LIMIT_MS = 60 * 1000;          // same thresholds the dashboard page uses for its summary tiles
const CHAT_RESPONSE_LIMIT_MS = 45 * 1000;
const TAB_SWITCH_LIMIT = 3;
const EXTENSION_ATTENTIVE_MIN = 60;       // focus score below this = not attentive
const EXTENSION_STALE_MS = 30 * 1000;     // extension score older than this is ignored
const FORGET_OFFLINE_AFTER_MS = 60 * 60 * 1000;

// ---- v2 heartbeats ----
const EMA_TAU_MS = 10 * 1000;             // smoothing time constant: a step change is ~63% reflected after 10 s
const MIN_DT_MS = 250;                    // dt is clamped so a burst of buffered beats can neither freeze nor jump the EMA
const MAX_DT_MS = 60 * 1000;
const MAX_BEAT_AGE_MS = 60 * 1000;        // buffered beats older than this are ignored
const DEDUPE_MS = 500;                    // a re-sent beat (lost ack) can land a few ms "later" than the first copy: still a duplicate
const HISTORY_MAX = 240;                  // rolling time-series per student: 240 points x >=5 s = last ~20 minutes
const HISTORY_MIN_INTERVAL_MS = 5 * 1000;
const TREND_POINTS = 20;                  // what a dashboard row carries (the full history stays on the server)
const REST_ONLINE_MS = 15 * 1000;         // a REST-only student (no socket) counts as online this long after a heartbeat
const ATTENTION_STATES = ['Focused', 'Passive', 'Distracted', 'Idle'];

const INPUT_EVENTS = new Set(['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click']);

class EngagementState {
  constructor() {
    this.classes = new Map(); // classId -> Map(studentId -> record)
  }

  // v2 (heartbeat) fields. attentionState === null means "this student has only ever used the legacy protocol".
  _freshV2() {
    return {
      attentionState: null, isFocused: null, idleSeconds: null, rawScore: null, smooth: null,
      distractionCount: 0, focusLossCount: 0, history: [], lastBeatAt: 0, lastHistoryAt: 0, restSeenAt: 0
    };
  }

  _isOnline(rec, now) {
    return rec.connections > 0 || (rec.restSeenAt > 0 && now - rec.restSeenAt < REST_ONLINE_MS);
  }

  _record(classId, user) {
    if (!this.classes.has(classId)) this.classes.set(classId, new Map());
    const classMap = this.classes.get(classId);
    let rec = classMap.get(user.id);
    if (!rec) {
      rec = {
        id: user.id, name: user.name || user.legalName || 'Student', connections: 0,
        lastActivityAt: null, lastInputAt: null, pageSeenAt: 0, tabHidden: false, tabSwitchCount: 0,
        chatResponses: 0, meetingChatMessages: 0, promptSentAt: null, promptAnsweredAt: null,
        focusScore: null, scoreAt: 0, extState: null,
        ...this._freshV2()
      };
      classMap.set(user.id, rec);
    }
    if (user.name || user.legalName) rec.name = user.name || user.legalName;
    return rec;
  }

  connect(classId, user, now = Date.now()) {
    const rec = this._record(classId, user);
    rec.connections += 1;
    rec.lastActivityAt = now;
    if (!rec.lastInputAt) rec.lastInputAt = now; // idle time counts from the moment they entered
  }

  disconnect(classId, userId) {
    const rec = this.classes.get(classId) && this.classes.get(classId).get(userId);
    if (rec) rec.connections = Math.max(0, rec.connections - 1);
  }

  recordActivity(classId, user, eventType, tabHidden, now = Date.now()) {
    const rec = this._record(classId, user);
    rec.pageSeenAt = now;
    rec.lastActivityAt = now;
    if (INPUT_EVENTS.has(eventType)) rec.lastInputAt = now;
    // While the extension is reporting, it decides tab switches; otherwise the student page would count every trip to the meeting tab.
    const extensionFresh = rec.scoreAt > 0 && now - rec.scoreAt < EXTENSION_STALE_MS;
    if (tabHidden && !rec.tabHidden && !extensionFresh) rec.tabSwitchCount += 1;
    rec.tabHidden = Boolean(tabHidden);
  }

  // extra: { inputIdleMs, state } from the extension. inputIdleMs = ms since the last mouse/keyboard use IN the meeting.
  recordScore(classId, user, focusScore, now = Date.now(), extra = {}) {
    const rec = this._record(classId, user);
    rec.focusScore = focusScore;
    rec.scoreAt = now;
    rec.lastActivityAt = now;
    rec.extState = extra.state || null;
    if (typeof extra.inputIdleMs === 'number') rec.lastInputAt = now - extra.inputIdleMs;
  }


  // v2 extension heartbeats: [{ score, state, location?, isFocused, idleSeconds?, ageMs? }], oldest first.
  // v2 heartbeats: [{ score, state, location?, isFocused, idleSeconds?, ageMs? }], oldest first. `ageMs` is used instead of a
  // client timestamp so a wrong clock cannot reorder or backdate anything. Returns how many beats were accepted.
  recordHeartbeats(classId, user, beats, now = Date.now(), opts = {}) {
    const rec = this._record(classId, user);
    if (opts.rest) rec.restSeenAt = now;
    const ordered = beats
      .map((beat) => ({ beat, t: now - Math.min(Math.max(Number(beat.ageMs) || 0, 0), MAX_BEAT_AGE_MS) }))
      .sort((a, b) => a.t - b.t);

    let accepted = 0;
    for (const { beat, t } of ordered) {
      if (t <= rec.lastBeatAt + DEDUPE_MS) continue;       // duplicate or out-of-order replay of a buffered beat
      if (!ATTENTION_STATES.includes(beat.state)) continue;
      const score = Math.min(100, Math.max(0, Number(beat.score)));
      if (!Number.isFinite(score)) continue;

      // Time-weighted EMA: the weight depends on the real gap between samples, so 5 beats flushed after an outage count the same as 5 live.
      if (!rec.lastBeatAt || rec.smooth === null) {
        rec.focusScore = Math.round(score);
        rec.smooth = score;
      } else {
        const dt = Math.min(Math.max(t - rec.lastBeatAt, MIN_DT_MS), MAX_DT_MS);
        const alpha = 1 - Math.exp(-dt / EMA_TAU_MS);
        rec.smooth += alpha * (score - rec.smooth);
        rec.focusScore = Math.round(rec.smooth);
      }

      if (rec.isFocused === true && beat.isFocused === false) rec.focusLossCount += 1;
      if (rec.attentionState !== 'Distracted' && beat.state === 'Distracted') rec.distractionCount += 1;

      rec.rawScore = Math.round(score);
      rec.attentionState = beat.state;
      rec.isFocused = Boolean(beat.isFocused);
      rec.idleSeconds = typeof beat.idleSeconds === 'number' ? Math.round(beat.idleSeconds) : null;
      rec.extState = beat.location || null;
      if (rec.idleSeconds !== null) rec.lastInputAt = t - rec.idleSeconds * 1000;
      rec.lastBeatAt = t;
      rec.scoreAt = Math.max(rec.scoreAt, t);
      rec.lastActivityAt = Math.max(rec.lastActivityAt || 0, t);

      if (t - rec.lastHistoryAt >= HISTORY_MIN_INTERVAL_MS) {
        rec.history.push({ t, score: rec.focusScore, state: rec.attentionState });
        if (rec.history.length > HISTORY_MAX) rec.history.splice(0, rec.history.length - HISTORY_MAX);
        rec.lastHistoryAt = t;
      }
      accepted += 1;
    }
    return accepted;
  }

  // Copy of one student's rolling time-series ([{ t, score, state }], oldest first).
  history(classId, userId) {
    const rec = this.classes.get(classId) && this.classes.get(classId).get(userId);
    return rec ? rec.history.map((point) => ({ ...point })) : [];
  }

  // The row exactly as the student themself sees it (no id, no name): used as the heartbeat acknowledgement.
  selfView(classId, userId, now = Date.now()) {
    const rec = this.classes.get(classId) && this.classes.get(classId).get(userId);
    if (!rec) return null;
    const { studentId, name, ...view } = this._row(rec, now);
    return view;
  }

  // The extension reports that the student left the meeting for another tab/app (debounced on the client).
  recordTabSwitch(classId, user, now = Date.now()) {
    const rec = this._record(classId, user);
    rec.tabSwitchCount += 1;
    rec.lastActivityAt = now;
  }

  // The extension reports that the student SENT a chat message (only the fact, never the text). It counts as the answer to a waiting question.
  recordMeetingChat(classId, user, now = Date.now()) {
    const rec = this._record(classId, user);
    rec.meetingChatMessages += 1;
    rec.lastActivityAt = now;
    if (rec.promptSentAt && !rec.promptAnsweredAt) {
      rec.chatResponses += 1;
      rec.promptAnsweredAt = now;
    }
  }

  recordChatResponse(classId, user, now = Date.now()) {
    const rec = this._record(classId, user);
    rec.chatResponses += 1;
    rec.promptAnsweredAt = now;
    rec.lastActivityAt = now;
  }

  recordPrompt(classId, now = Date.now()) {
    const classMap = this.classes.get(classId);
    if (!classMap) return;
    for (const rec of classMap.values()) {
      if (rec.connections > 0) { rec.promptSentAt = now; rec.promptAnsweredAt = null; }
    }
  }

  onlineCount(classId, now = Date.now()) {
    const classMap = this.classes.get(classId);
    if (!classMap) return 0;
    let n = 0;
    for (const rec of classMap.values()) if (this._isOnline(rec, now)) n += 1;
    return n;
  }

  snapshot(classId, now = Date.now()) {
    const classMap = this.classes.get(classId);
    if (!classMap) return [];
    return [...classMap.values()].map((rec) => this._row(rec, now));
  }

  /**
   * The row's view of a student whose extension is reporting: { tabHidden, reasons }. The extension wins while reporting.
   * The CURRENT state decides, so the row flips back as soon as they return; the smoothed score lags ~10-20 s and is only
   * used when the client sent neither a location nor a focus flag.
   */
  _extensionView(rec, mouseIdleMs) {
    const v2 = rec.attentionState !== null;
    const reasons = [];
    let away;
    if (v2) away = rec.isFocused === false || rec.extState === 'away';
    else if (rec.extState) away = rec.extState === 'away';
    else away = rec.focusScore < EXTENSION_ATTENTIVE_MIN;

    if (away) reasons.push(`Meeting tab not in focus (focus score ${rec.focusScore}%).`);
    else if (v2) {
      // v2 clients already weigh media, reading and typing, so "no mouse for a minute" is NOT a flag; only their own Idle / Distracted verdicts are.
      if (rec.attentionState === 'Idle') reasons.push(`No activity in the meeting for ${Math.round((mouseIdleMs || 0) / 1000)}s and nothing playing.`);
      else if (rec.attentionState === 'Distracted') reasons.push('Switching between tabs or apps rapidly.');
    } else if (rec.extState !== 'tool' && mouseIdleMs !== null && mouseIdleMs >= IDLE_LIMIT_MS) {
      // Looking at the Attentix page itself ('tool') is part of class, so idle time there is not held against them.
      reasons.push(`No mouse or keyboard activity in the meeting for ${Math.round(mouseIdleMs / 1000)}s.`);
    }
    if (rec.tabSwitchCount >= TAB_SWITCH_LIMIT) reasons.push(`Left the meeting ${rec.tabSwitchCount} times.`);
    return { tabHidden: away, reasons };
  }

  /** Flags raised from the web page alone (no fresh extension score). */
  _webPageReasons(rec, mouseIdleMs) {
    const reasons = [];
    if (rec.tabHidden) reasons.push('Class tab is hidden or unfocused.');
    if (mouseIdleMs !== null && mouseIdleMs >= IDLE_LIMIT_MS) reasons.push(`No mouse or keyboard activity for ${Math.round(mouseIdleMs / 1000)}s.`);
    if (rec.tabSwitchCount >= TAB_SWITCH_LIMIT) reasons.push(`Switched tabs ${rec.tabSwitchCount} times.`);
    return reasons;
  }

  _row(rec, now) {
    const online = this._isOnline(rec, now);
    const v2 = rec.attentionState !== null;
    const mouseIdleMs = rec.lastInputAt ? now - rec.lastInputAt : null;
    const promptWaitingMs = rec.promptSentAt && !rec.promptAnsweredAt ? now - rec.promptSentAt : null;
    let tabHidden = rec.tabHidden;

    let reasons = [];
    if (online) {
      const extensionFresh = rec.scoreAt > 0 && now - rec.scoreAt < EXTENSION_STALE_MS;
      if (extensionFresh) {
        ({ tabHidden, reasons } = this._extensionView(rec, mouseIdleMs));
      } else if (rec.pageSeenAt === 0 && rec.scoreAt > 0) {
        tabHidden = false;
        reasons.push('No Meet/Zoom meeting tab detected.');
      } else {
        reasons = this._webPageReasons(rec, mouseIdleMs);
      }
      if (promptWaitingMs !== null && promptWaitingMs >= CHAT_RESPONSE_LIMIT_MS) reasons.push("No response to the educator's question.");
    }

    return {
      studentId: rec.id,
      name: rec.name,
      online,
      attentive: online && reasons.length === 0,
      reasons,
      tabHidden: online && tabHidden,
      mouseIdleMs: online ? mouseIdleMs : null,
      tabSwitchCount: rec.tabSwitchCount,
      chatResponses: rec.chatResponses,
      meetingChatMessages: rec.meetingChatMessages,
      lastActivityAt: rec.lastActivityAt,
      promptWaitingMs: online ? promptWaitingMs : null,
      focusScore: rec.focusScore,
      // v2 (null / 0 / [] for a student who only uses the web page or a legacy extension)
      attentionState: v2 ? rec.attentionState : null,
      location: rec.extState || null,
      isFocused: v2 ? rec.isFocused : null,
      idleSeconds: v2 ? rec.idleSeconds : null,
      distractionCount: rec.distractionCount,
      focusLossCount: rec.focusLossCount,
      trend: rec.history.slice(-TREND_POINTS).map((point) => point.score)
    };
  }

  // Removes one user from every class (or just `onlyClassId`). Returns the class ids that changed.
  forgetUser(userId, onlyClassId = null) {
    const changed = [];
    for (const [classId, classMap] of this.classes.entries()) {
      if (onlyClassId && classId !== onlyClassId) continue;
      if (classMap.delete(userId)) changed.push(classId);
      if (classMap.size === 0) this.classes.delete(classId);
    }
    return changed;
  }

  // "Start fresh": zeroes counters and scores but keeps who is connected; offline students are dropped.
  resetClass(classId, now = Date.now()) {
    const classMap = this.classes.get(classId);
    if (!classMap) return;
    for (const [studentId, rec] of classMap.entries()) {
      if (!this._isOnline(rec, now)) { classMap.delete(studentId); continue; }
      Object.assign(rec, {
        lastActivityAt: now, lastInputAt: now, pageSeenAt: 0, tabHidden: false, tabSwitchCount: 0,
        chatResponses: 0, meetingChatMessages: 0, promptSentAt: null, promptAnsweredAt: null,
        focusScore: null, scoreAt: 0, extState: null,
        ...this._freshV2(), restSeenAt: rec.restSeenAt
      });
    }
    if (classMap.size === 0) this.classes.delete(classId);
  }

  prune(now = Date.now()) {
    for (const [classId, classMap] of this.classes.entries()) {
      for (const [studentId, rec] of classMap.entries()) {
        if (!this._isOnline(rec, now) && now - (rec.lastActivityAt || 0) > FORGET_OFFLINE_AFTER_MS) classMap.delete(studentId);
      }
      if (classMap.size === 0) this.classes.delete(classId);
    }
  }
}

module.exports = new EngagementState();
module.exports.EngagementState = EngagementState;
module.exports.constants = { EMA_TAU_MS, HISTORY_MAX, HISTORY_MIN_INTERVAL_MS, TREND_POINTS, REST_ONLINE_MS, MAX_BEAT_AGE_MS, ATTENTION_STATES };
