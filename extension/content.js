/* Attentix - content script for Google Meet and the Zoom web client.
 *
 * Runs in EVERY frame of the meeting page and does three things:
 *   1. Collects attentiveness SIGNALS and reports them every few seconds: page visible/focused, time since the last
 *      interaction, how steady mouse/keyboard/scroll activity was over the last minute (counts per 3-second bucket,
 *      nothing else), scrolling/reading, and whether audio or video is playing. Never which key, never what was typed.
 *   2. Reports that the user SENT a chat message. It never reads, stores or sends chat text; it only notices "Enter / Send
 *      pressed in a chat box that was not empty".
 *   3. Top frame only: shows an always-visible "monitoring is on" badge and any question the educator sends, with an answer box.
 */
(() => {
  if (window.__attentionMonitorLoaded) return;   // manifest injection + on-demand injection must not double up
  window.__attentionMonitorLoaded = true;

  const isTop = window.top === window;
  let alive = true;
  let badge = null;
  let label = null;
  let promptHost = null;
  let poll = null;
  let signalTimer = null;

  function shutdown() {
    alive = false;
    window.__attentionMonitorLoaded = false;
    clearInterval(poll);
    clearInterval(signalTimer);
    if (badge) badge.remove();
    if (promptHost) promptHost.remove();
  }

  const send = (message) => {
    if (!alive) return Promise.resolve(undefined);
    try {
      return chrome.runtime.sendMessage(message).catch(() => undefined);
    } catch {
      shutdown(); // "Extension context invalidated": the extension was reloaded or updated. Stop quietly.
      return Promise.resolve(undefined);
    }
  };

  const pathOf = (event) => (typeof event.composedPath === 'function' ? event.composedPath() : [event.target]);
  const isOurUi = (event) => pathOf(event).some((n) => n === badge || n === promptHost);

  // ---- 1. attentiveness signals ----
  // Privacy by construction: the handlers below never read event.key, event.code, event.target.value, coordinates or
  // any page text. Keyboard activity is only "a key went down at time T", folded into 3-second activity buckets.
  const BUCKET_MS = 3000;
  const WINDOW_BUCKETS = 20;               // 20 x 3 s = the last minute
  const SCROLL_WINDOW_MS = 45 * 1000;
  const SCROLL_BUCKETS_FOR_READING = 3;    // scrolled in 3 different 3-second slots within 45 s = steady reading/scrolling
  const REPORT_MS = 3000;
  const MOVE_THROTTLE_MS = 1000;

  let lastInteractionAt = Date.now();      // the page just loaded: idle time counts from now
  let everInteracted = false;
  let focusLosses = 0;
  let visibilityChanges = 0;
  const activeBuckets = new Set();         // bucket ids with any interaction
  const scrollBuckets = new Set();         // bucket ids with scrolling
  const bucketOf = (t) => Math.floor(t / BUCKET_MS);

  const prune = (set, now, windowMs) => {
    const oldest = bucketOf(now - windowMs);
    for (const id of set) if (id < oldest) set.delete(id);
  };

  const markInteraction = (now, isScroll) => {
    lastInteractionAt = now;
    everInteracted = true;
    activeBuckets.add(bucketOf(now));
    if (isScroll) scrollBuckets.add(bucketOf(now));
  };

  let lastMoveAt = 0;
  let lastScrollAt = 0;
  const onInteraction = (event) => {
    if (isOurUi(event)) return;
    const now = Date.now();
    if (event.type === 'mousemove' || event.type === 'pointermove') {
      if (now - lastMoveAt < MOVE_THROTTLE_MS) return;     // throttled: a moving mouse is one interaction per second
      lastMoveAt = now;
    }
    const isScroll = event.type === 'scroll' || event.type === 'wheel';
    if (isScroll) {
      if (now - lastScrollAt < 250) return;
      lastScrollAt = now;
    }
    markInteraction(now, isScroll);
  };
  ['mousemove', 'pointermove', 'mousedown', 'pointerdown', 'keydown', 'scroll', 'wheel', 'touchstart', 'click'].forEach((name) =>
    window.addEventListener(name, onInteraction, { passive: true, capture: true })
  );

  // A video/audio that is really playing. Muted background loops (decorative videos) do not count unless the video is
  // big enough to be the thing the user is watching.
  const isPlaying = (el) => {
    if (!el || el.paused || el.ended || el.readyState < 2) return false;
    if (!el.muted && el.volume > 0) return true;
    if (el.tagName !== 'VIDEO') return false;
    const box = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    return Boolean(box) && box.width >= 160 && box.height >= 90;
  };
  const mediaPlaying = () => Array.prototype.some.call(document.querySelectorAll('video, audio'), isPlaying);

  const visible = () => document.visibilityState !== 'hidden';
  const hasFocus = () => (typeof document.hasFocus === 'function' ? document.hasFocus() : true);

  const buildSignals = () => {
    const now = Date.now();
    prune(activeBuckets, now, WINDOW_BUCKETS * BUCKET_MS);
    prune(scrollBuckets, now, SCROLL_WINDOW_MS);
    return {
      type: 'signals',
      visible: visible(),
      hasFocus: hasFocus(),
      idleMs: now - lastInteractionAt,
      buckets: Math.min(WINDOW_BUCKETS, activeBuckets.size),
      scrolling: scrollBuckets.size >= SCROLL_BUCKETS_FOR_READING,
      media: mediaPlaying(),
      focusLosses,
      visibilityChanges
    };
  };

  // Subframes (ads, widgets) stay quiet unless they saw activity or are playing media; the top frame always reports.
  const report = () => {
    if (!alive) return;
    const signals = buildSignals();
    if (!isTop && !everInteracted && !signals.media) return;
    send(signals);
  };

  let reportSoon = null;
  const reportNow = () => {                // visibility / focus changes are reported at once, not at the next 3 s tick
    if (reportSoon) return;
    reportSoon = setTimeout(() => { reportSoon = null; report(); }, 100);
  };
  document.addEventListener('visibilitychange', () => { visibilityChanges += 1; reportNow(); });
  window.addEventListener('blur', () => { focusLosses += 1; reportNow(); });
  window.addEventListener('focus', reportNow);
  signalTimer = setInterval(report, REPORT_MS);
  report();

  // ---- 2. "the user sent a chat message" (no text is read) ----
  const CHAT_HINT = /chat|message/i;

  const isEditable = (el) => {
    if (!(el instanceof Element)) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') return /^(text|)$/i.test(el.getAttribute('type') || '');
    if (el.isContentEditable === true) return true;
    const attr = el.getAttribute('contenteditable');
    return attr !== null && /^(|true|plaintext-only)$/i.test(attr);
  };

  // Where the box says it is a chat/message box: its own labels plus a few ancestors' labels/ids/classes.
  const describe = (el) => {
    const parts = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), el.id,
      typeof el.className === 'string' ? el.className : ''];
    let parent = el.parentElement;
    for (let i = 0; i < 4 && parent; i += 1, parent = parent.parentElement) {
      parts.push(parent.getAttribute('aria-label'), parent.id, typeof parent.className === 'string' ? parent.className : '');
    }
    return parts.filter(Boolean).join(' ');
  };

  // Only checks whether there IS text; the text itself is never kept or sent.
  const hasText = (el) => String(el.value !== undefined ? el.value : el.textContent || '').trim().length > 0;

  const findFilledChatBox = (root) => {
    const boxes = root.querySelectorAll('textarea, input[type="text"], input:not([type]), [contenteditable]');
    return Array.prototype.find.call(boxes, (el) => isEditable(el) && CHAT_HINT.test(describe(el)) && hasText(el));
  };

  let lastChatSent = 0;
  const chatSent = () => {
    const now = Date.now();
    if (now - lastChatSent < 1000) return; // Enter + Send click for one message must count once
    lastChatSent = now;
    send({ type: 'chatSent' });
  };

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || isOurUi(event)) return;
    const el = pathOf(event)[0];
    if (isEditable(el) && CHAT_HINT.test(describe(el)) && hasText(el)) chatSent();
  }, true);

  window.addEventListener('click', (event) => {
    if (isOurUi(event)) return;
    const button = pathOf(event).find((n) => n instanceof Element && (n.tagName === 'BUTTON' || n.getAttribute('role') === 'button'));
    if (!button) return;
    const name = (button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent || '').trim();
    if (!/^send\b/i.test(name) || name.length > 40) return;
    const scope = button.closest('form, [class*="chat" i], [id*="chat" i], [role="complementary"], [role="region"]') || document;
    if (findFilledChatBox(scope)) chatSent();
  }, true);

  if (!isTop) return; // everything below is UI, which only the top frame shows

  // ---- 3a. "monitoring is on" badge ----
  function ensureBadge() {
    if (badge && badge.isConnected) return;
    badge = document.createElement('div');
    badge.style.cssText = 'all:initial;position:fixed;top:8px;left:8px;z-index:2147483647;pointer-events:none;';
    const root = badge.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .pill{font:600 12px/1.2 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;letter-spacing:.01em;color:#fff;background:rgba(128,0,0,.94);padding:6px 12px 6px 10px;border-radius:999px;display:flex;gap:8px;align-items:center;box-shadow:0 2px 10px rgba(40,0,0,.35),inset 0 0 0 1px rgba(227,185,60,.55)}
      .dot{width:8px;height:8px;border-radius:50%;background:#e3b93c;box-shadow:0 0 0 3px rgba(227,185,60,.28)}
      .dot.warn{background:#fff;opacity:.6;box-shadow:none}`;
    const pill = document.createElement('div');
    pill.className = 'pill';
    const dot = document.createElement('span');
    dot.className = 'dot';
    label = document.createElement('span');
    pill.append(dot, label);
    root.append(style, pill);
    badge.dot = dot;
    document.documentElement.appendChild(badge);
  }

  async function refresh() {
    const status = await send({ type: 'status' });
    if (!status || !status.monitoring) {
      if (badge) { badge.remove(); badge = null; }
      return;
    }
    ensureBadge();
    badge.dot.className = status.connected ? 'dot' : 'dot warn';
    // textContent only: the class name comes from the server and must never be parsed as HTML.
    // Same state and score the student's toolbar badge and the educator see.
    const reading = status.state && typeof status.score === 'number' ? ` · ${status.state} ${status.score}%` : '';
    label.textContent = status.connected
      ? `Attentix on · ${status.monitoring.className}${reading}`
      : 'Attentix reconnecting...';
  }

  // ---- 3b. educator question + answer box ----
  function showPrompt(text) {
    if (promptHost) promptHost.remove();
    promptHost = document.createElement('div');
    promptHost.style.cssText = 'all:initial;position:fixed;top:48px;left:50%;transform:translateX(-50%);z-index:2147483647;';
    const root = promptHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .card{font:13px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;width:min(420px,90vw);background:#fff;color:#211b1b;border:1px solid #e7e2e0;border-top:3px solid #c9a227;border-radius:14px;box-shadow:0 10px 34px rgba(40,0,0,.28);padding:14px 16px}
      .head{display:flex;justify-content:space-between;align-items:center;font-weight:700;color:#800000;margin-bottom:8px}
      .q{white-space:pre-wrap;word-break:break-word;margin-bottom:10px;font-size:14px}
      .row{display:flex;gap:8px}
      input{flex:1;padding:8px 10px;border:1px solid #8c8482;border-radius:8px;font:inherit;color:#211b1b;background:#fff}
      input:focus{outline:2px solid #800000;outline-offset:0;border-color:#800000}
      button{padding:8px 12px;border:1px solid #8c8482;border-radius:8px;background:#f5f3f2;color:#211b1b;font:inherit;font-weight:600;cursor:pointer}
      button:hover{background:#ebe6e4}
      button:focus-visible{outline:2px solid #800000;outline-offset:2px}
      button.go{background:#800000;border-color:#800000;color:#fff}
      button.go:hover{background:#650000}
      button.go:disabled{opacity:.6;cursor:progress}
      .hint{color:#605857;font-size:11px;margin-top:8px}`;
    const card = document.createElement('div');
    card.className = 'card';
    const head = document.createElement('div');
    head.className = 'head';
    const title = document.createElement('span');
    title.textContent = 'Question from your educator';
    const close = document.createElement('button');
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    head.append(title, close);
    const q = document.createElement('div');
    q.className = 'q';
    q.textContent = text; // never innerHTML: this text comes from another user
    const row = document.createElement('div');
    row.className = 'row';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = 'Type your answer';
    const go = document.createElement('button');
    go.className = 'go';
    go.textContent = 'Send';
    row.append(input, go);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'You can also answer in the meeting chat.';
    card.append(head, q, row, hint);
    root.append(style, card);

    // Keep keystrokes in the answer box away from Meet/Zoom keyboard shortcuts.
    ['keydown', 'keyup', 'keypress'].forEach((name) => card.addEventListener(name, (e) => e.stopPropagation()));

    const submit = async () => {
      const response = input.value.trim();
      if (!response) return;
      go.disabled = true;
      const result = await send({ type: 'promptReply', response });
      if (result && result.ok) {
        hint.textContent = 'Sent ✓';
        setTimeout(() => { if (promptHost) { promptHost.remove(); promptHost = null; } }, 1200);
      } else {
        hint.textContent = (result && result.error) || 'Could not send. Try again.';
        go.disabled = false;
      }
    };
    go.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    close.addEventListener('click', () => { promptHost.remove(); promptHost = null; });
    document.documentElement.appendChild(promptHost);
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === 'prompt' && typeof msg.text === 'string') showPrompt(msg.text.slice(0, 300));
    });
  } catch { /* extension context already gone */ }

  poll = setInterval(refresh, 4000);
  refresh();
})();
