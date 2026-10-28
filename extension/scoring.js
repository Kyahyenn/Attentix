/* Pure scoring + URL helpers, shared by the service worker and the Node unit tests. No browser APIs in here. */
(function (root) {
  'use strict';

  // Match patterns for chrome.tabs.query({ url }) - a coarse pre-filter; isMeetingUrl() is the real check.
  const MEETING_URL_PATTERNS = [
    'https://meet.google.com/*',
    'https://zoom.us/wc/*',
    'https://*.zoom.us/wc/*'
  ];

  // Google Meet room codes look like abc-defg-hij, also reachable as /meet/abc-defg-hij. This excludes /landing, /new, /lookup/..., etc.
  const MEET_RE = /^https:\/\/meet\.google\.com\/(?:meet\/)?[a-z]{3}-[a-z]{4}-[a-z]{3}(?:[/?#]|$)/i;
  // Zoom web client: /wc/<9-11 digit id>/join|start, or the older /wc/join/<id>.
  const ZOOM_RE = /^https:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/wc\/(?:(?:join|start)\/)?\d{9,11}(?:[/?#]|$)/i;

  const isMeetingUrl = (url) => typeof url === 'string' && (MEET_RE.test(url) || ZOOM_RE.test(url));

  // Where is the student? (decided by the service worker from Chrome's own tab/window state)
  //   meeting : the Meet/Zoom tab is the active tab of the focused Chrome window
  //   tool    : the active tab is a page of the Attentix server itself (student dashboard...). Looking at the
  //             class tool is part of class, so it is neither "away" nor a tab switch.
  //   away    : any other tab, another window/app, or Chrome not focused
  const isToolUrl = (url, serverOrigin) =>
    typeof url === 'string' && typeof serverOrigin === 'string' && serverOrigin !== '' &&
    (url === serverOrigin || url.startsWith(`${serverOrigin}/`));

  // The extension's own pages (popup.html opened in a tab or a popup window, ...) are part of class too: using the
  // extension is not "leaving the meeting".
  const isExtensionUrl = (url, extensionOrigin) =>
    typeof url === 'string' && typeof extensionOrigin === 'string' && extensionOrigin !== '' &&
    (url === extensionOrigin || url.startsWith(`${extensionOrigin.replace(/\/$/, '')}/`));

  // Where is the student? Pure decision used by the service worker every tick.
  //   activeUrl       URL of the active tab of the last focused browser window (or null)
  //   windowFocused   Chrome says that window has focus
  //   popupOpen       the extension's toolbar popup is open (or closed a moment ago). Chrome reports the browser window as
  //                   NOT focused while the popup has focus, so without this the popup looked like "another app".
  const locate = ({ activeUrl, windowFocused, popupOpen, serverOrigin, extensionOrigin } = {}) => {
    if (!activeUrl || !(windowFocused || popupOpen)) return 'away';
    if (isMeetingUrl(activeUrl)) return 'meeting';
    if (isToolUrl(activeUrl, serverOrigin) || isExtensionUrl(activeUrl, extensionOrigin)) return 'tool';
    return 'away';
  };

  // ---- Attentiveness score (0-100) ----
  //
  //   score = 100 * ( W_FOCUS * focus  +  W_INTERACTION * interaction )  -  switchPenalty
  //
  //   focus        1 when the class tab is the active tab of the focused window, else 0.
  //   interaction  0..1, the best of these (so one steady signal is enough; they do not have to all be present):
  //                  recency curve   1.0 up to 15 s since the last meaningful interaction, then decays:
  //                                  0.6 at 2 min, 0.3 at 5 min, 0.1 at 15 min and beyond (idle-time decay)
  //                  cadence         share of the last 60 s (20 buckets of 3 s) with any mouse/keyboard/scroll activity
  //                  reading         steady scrolling                                      -> 0.90
  //                  media           a video/audio is playing (watching/listening)        -> 0.85
  //                  tool page       looking at the Attentix page itself          -> 0.80
  //                When the class tab is NOT in front the interaction credit is cut to 25%: audio playing in a
  //                background tab is not attention.
  //   switchPenalty  5 points per tab switch in the last 5 minutes (max 30), plus 15 when 3+ happened in the last
  //                  minute ("rapid switching"); never more than 40 in total.
  //
  // Examples: active in the meeting 100 | watching a lecture video, no mouse for 10 min 92 | focused but idle 10 min 56
  //           | another tab 14 or less | active but 4 tab switches in the last minute 65 (state Distracted).
  const W_FOCUS = 0.45;
  const W_INTERACTION = 0.55;
  const UNFOCUSED_INTERACTION_FACTOR = 0.25;
  const MEDIA_FLOOR = 0.85;
  const READING_FLOOR = 0.9;
  const TOOL_FLOOR = 0.8;
  const BUCKETS_PER_MINUTE = 20;
  const STEADY_BUCKETS = 10;            // half of the last minute active = fully "steady"
  const SWITCH_WINDOW_MS = 5 * 60 * 1000;
  const RAPID_WINDOW_MS = 60 * 1000;
  const RAPID_SWITCHES = 3;
  const SWITCH_POINTS = 5;
  const SWITCH_PENALTY_CAP = 30;
  const RAPID_PENALTY = 15;
  const PENALTY_CAP = 40;

  // ---- State thresholds ----
  const ACTIVE_SECONDS = 30;            // interacted within this long ago = actively engaged
  const IDLE_AFTER_SECONDS = 300;       // this long with no interaction AND nothing playing/scrolling = Idle
  const DISTRACTED_BELOW = 40;
  const STEADY_ACTIVE_BUCKETS = 3;      // 3+ active buckets in the last minute also counts as actively engaged

  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  const lerp = (a, b, t) => a + (b - a) * clamp01(t);

  // Idle-time decay curve: 1 -> 0.6 -> 0.3 -> 0.1 (never below 0.1: a student can be present without touching anything).
  const recencyCurve = (idleSeconds) => {
    if (typeof idleSeconds !== 'number' || Number.isNaN(idleSeconds)) return 0.5;
    if (idleSeconds <= 15) return 1;
    if (idleSeconds <= 120) return lerp(1, 0.6, (idleSeconds - 15) / 105);
    if (idleSeconds <= 300) return lerp(0.6, 0.3, (idleSeconds - 120) / 180);
    if (idleSeconds <= 900) return lerp(0.3, 0.1, (idleSeconds - 300) / 600);
    return 0.1;
  };

  const cadenceCurve = (activeBuckets) => {
    const share = clamp01((Number(activeBuckets) || 0) / STEADY_BUCKETS);
    return share === 0 ? 0 : 0.5 + 0.5 * share;
  };

  // signals: {
  //   isFocused: boolean, idleSeconds: number|null, activeBuckets: 0-20, scrolling: boolean, mediaPlaying: boolean,
  //   onToolPage: boolean, tabSwitches: switches in the last 5 min, rapidSwitches: switches in the last minute
  // }
  // -> { score, state, tabSwitches, idleSeconds, isFocused, components }
  const computeAttentiveness = (signals = {}) => {
    const isFocused = Boolean(signals.isFocused);
    const idleSeconds = typeof signals.idleSeconds === 'number' && signals.idleSeconds >= 0 ? Math.round(signals.idleSeconds) : null;
    const activeBuckets = Math.min(BUCKETS_PER_MINUTE, Math.max(0, Number(signals.activeBuckets) || 0));
    const scrolling = Boolean(signals.scrolling);
    const mediaPlaying = Boolean(signals.mediaPlaying);
    const onToolPage = Boolean(signals.onToolPage);
    const tabSwitches = Math.max(0, Math.floor(Number(signals.tabSwitches) || 0));
    const rapidSwitches = Math.max(0, Math.floor(Number(signals.rapidSwitches) || 0));

    let interaction = Math.max(
      recencyCurve(idleSeconds),
      cadenceCurve(activeBuckets),
      scrolling ? READING_FLOOR : 0,
      mediaPlaying ? MEDIA_FLOOR : 0,
      onToolPage ? TOOL_FLOOR : 0
    );
    if (!isFocused) interaction *= UNFOCUSED_INTERACTION_FACTOR;

    const rapid = rapidSwitches >= RAPID_SWITCHES;
    const penalty = Math.min(PENALTY_CAP, Math.min(SWITCH_PENALTY_CAP, tabSwitches * SWITCH_POINTS) + (rapid ? RAPID_PENALTY : 0));
    const raw = 100 * (W_FOCUS * (isFocused ? 1 : 0) + W_INTERACTION * interaction) - penalty;
    const score = Math.round(Math.min(100, Math.max(0, raw)));

    const passivelyEngaged = mediaPlaying || onToolPage;
    const active = (idleSeconds !== null && idleSeconds <= ACTIVE_SECONDS) || scrolling || activeBuckets >= STEADY_ACTIVE_BUCKETS;

    let state;
    if (!isFocused || rapid || score < DISTRACTED_BELOW) state = 'Distracted';
    else if (active) state = 'Focused';
    else if (passivelyEngaged || idleSeconds === null || idleSeconds < IDLE_AFTER_SECONDS) state = 'Passive';
    else state = 'Idle';

    return {
      score, state, tabSwitches, idleSeconds, isFocused,
      components: { focus: isFocused ? 1 : 0, interaction: Math.round(interaction * 100) / 100, penalty }
    };
  };

  // ---- Merging what the content scripts (one per frame) reported ----
  // frames: [{ receivedAt, idleMs, media, scrolling, buckets, visible }] for the ACTIVE class tab. A frame that stopped
  // reporting (closed, navigated, throttled) is ignored after STALE_MS; idle time keeps growing between reports.
  const STALE_MS = 8000;
  const mergeFrameSignals = (frames, now = Date.now(), staleMs = STALE_MS) => {
    const fresh = (frames || []).filter((f) => f && typeof f.receivedAt === 'number' && now - f.receivedAt <= staleMs);
    if (fresh.length === 0) return null;
    let idleMs = Infinity;
    let visible = false;
    for (const f of fresh) {
      if (typeof f.idleMs === 'number') idleMs = Math.min(idleMs, f.idleMs + (now - f.receivedAt));
      if (f.visible !== false) visible = true;
    }
    return {
      idleSeconds: Number.isFinite(idleMs) ? Math.round(idleMs / 1000) : null,
      mediaPlaying: fresh.some((f) => f.media),
      scrolling: fresh.some((f) => f.scrolling),
      activeBuckets: Math.max(0, ...fresh.map((f) => Number(f.buckets) || 0)),
      visible
    };
  };

  // ---- Tab-switch counting ----
  // A tab switch is: the student was in class (meeting/tool) and then stayed "away" for AWAY_TICKS_TO_COUNT samples
  // in a row (>= ~2 s, so a flicker through another tab does not count). One switch is counted per trip away; the
  // student has to come back to the meeting or the tool before another one can be counted.
  const AWAY_TICKS_TO_COUNT = 2;
  const newSwitchTracker = () => ({ sawClass: false, awayTicks: 0, counted: false });

  // state: 'meeting' | 'tool' | 'away' | 'none' (no meeting tab open at all). Returns { tracker, switched }.
  const stepSwitchTracker = (tracker, state) => {
    if (state === 'meeting' || state === 'tool') return { tracker: { sawClass: true, awayTicks: 0, counted: false }, switched: false };
    if (state === 'away') {
      const awayTicks = tracker.awayTicks + 1;
      const switched = tracker.sawClass && !tracker.counted && awayTicks >= AWAY_TICKS_TO_COUNT;
      return { tracker: { sawClass: tracker.sawClass, awayTicks, counted: tracker.counted || switched }, switched };
    }
    return { tracker: newSwitchTracker(), switched: false };
  };

  // Timestamps of counted switches, newest last. Returns { recent (5 min), rapid (1 min), times (pruned) }.
  const summarizeSwitches = (times, now = Date.now()) => {
    const kept = (times || []).filter((t) => now - t <= SWITCH_WINDOW_MS);
    return { times: kept, recent: kept.length, rapid: kept.filter((t) => now - t <= RAPID_WINDOW_MS).length };
  };

  // Same time-weighted EMA the server applies to heartbeats (src/state/engagementState.js), used only to show a score
  // while offline. tauMs must match the server's EMA_TAU_MS.
  const EMA_TAU_MS = 10 * 1000;
  const smoothScore = (previous, next, dtMs, tauMs = EMA_TAU_MS) => {
    if (typeof previous !== 'number') return next;
    const alpha = 1 - Math.exp(-Math.min(Math.max(dtMs, 250), 60000) / tauMs);
    return previous + alpha * (next - previous);
  };

  const api = {
    MEETING_URL_PATTERNS, isMeetingUrl, isToolUrl, isExtensionUrl, locate,
    computeAttentiveness, recencyCurve, cadenceCurve, mergeFrameSignals, STALE_MS,
    newSwitchTracker, stepSwitchTracker, AWAY_TICKS_TO_COUNT, summarizeSwitches,
    smoothScore, EMA_TAU_MS,
    WEIGHTS: { focus: W_FOCUS, interaction: W_INTERACTION },
    THRESHOLDS: { ACTIVE_SECONDS, IDLE_AFTER_SECONDS, DISTRACTED_BELOW, STEADY_ACTIVE_BUCKETS, RAPID_SWITCHES, SWITCH_WINDOW_MS, RAPID_WINDOW_MS }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AttentionScoring = api;
})(typeof self !== 'undefined' ? self : this);
