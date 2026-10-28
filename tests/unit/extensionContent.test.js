/**
 * Runs the real extension/content.js inside jsdom and checks what it reports for realistic Meet/Zoom-style DOM.
 * The important negative checks: the text of a chat message is never sent, and unrelated typing is not "chat".
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const opened = [];
afterEach(() => { opened.splice(0).forEach((w) => w.close()); }); // stops the content script's polling timer

const SOURCE = fs.readFileSync(path.join(__dirname, '../../extension/content.js'), 'utf8');

function load(html = '<body></body>') {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://meet.google.com/abc-defg-hij', pretendToBeVisual: true });
  const { window } = dom;
  opened.push(window);
  const sent = [];
  const listeners = [];
  window.chrome = {
    runtime: {
      sendMessage: (m) => { sent.push(m); return Promise.resolve({ ok: true, monitoring: null }); },
      onMessage: { addListener: (fn) => listeners.push(fn) }
    }
  };
  window.eval(SOURCE);
  return { window, document: window.document, sent, listeners, types: () => sent.map((m) => m.type).filter((t) => t !== 'status' && t !== 'signals') };
}

const key = (window, target, init) => target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, composed: true, cancelable: true, ...init }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Forces a report (visibility changes are reported ~100 ms later) and returns the newest `signals` message.
async function latestSignals(env) {
  env.document.dispatchEvent(new env.window.Event('visibilitychange'));
  await sleep(160);
  return env.sent.filter((m) => m.type === 'signals').pop();
}

describe('content script: attentiveness signals', () => {
  test('reports visibility, idle time, cadence, scrolling and media - and never the legacy bare "input" message', async () => {
    const env = load();
    const first = env.sent.find((m) => m.type === 'signals');
    expect(first).toMatchObject({ visible: true, buckets: 0, scrolling: false, media: false });
    expect(env.types()).not.toContain('input');
    await sleep(30);
    env.document.dispatchEvent(new env.window.MouseEvent('mousedown', { bubbles: true }));
    const s = await latestSignals(env);
    expect(s.buckets).toBeGreaterThanOrEqual(1);
    expect(s.idleMs).toBeLessThan(400);
  });

  test('mouse movement is throttled to one interaction per second', async () => {
    const env = load();
    for (let i = 0; i < 20; i += 1) env.document.dispatchEvent(new env.window.MouseEvent('mousemove', { bubbles: true }));
    const s = await latestSignals(env);
    expect(s.buckets).toBe(1);
  });

  test('keyboard activity is cadence only: no key, code or value is ever in any message', async () => {
    const env = load('<body><textarea id="t"></textarea></body>');
    const t = env.document.getElementById('t');
    t.value = 'top secret';
    key(env.window, t, { key: 'p', code: 'KeyP' });
    await latestSignals(env);
    const wire = JSON.stringify(env.sent);
    expect(wire).not.toMatch(/secret|KeyP|"key"|"code"/);
    expect(Object.keys(env.sent.filter((m) => m.type === 'signals').pop()).sort()).toEqual(
      ['buckets', 'focusLosses', 'hasFocus', 'idleMs', 'media', 'scrolling', 'type', 'visible', 'visibilityChanges'].sort());
  });

  test('steady scrolling over several seconds counts as reading', async () => {
    const env = load();
    const real = env.window.Date.now;
    let now = real();
    env.window.Date.now = () => now;                 // the page's own clock, not the test's
    const base = now;
    for (let i = 0; i < 4; i += 1) { now = base - 12000 + i * 3100; env.window.dispatchEvent(new env.window.Event('scroll')); }
    now = base;
    env.window.Date.now = real;
    const s = await latestSignals(env);
    expect(s.scrolling).toBe(true);
  });

  test('an audible playing video counts as media; a paused one does not', async () => {
    const env = load('<body><video id="v"></video></body>');
    const v = env.document.getElementById('v');
    Object.defineProperty(v, 'paused', { value: false });
    Object.defineProperty(v, 'readyState', { value: 4 });
    Object.defineProperty(v, 'muted', { value: false, configurable: true });
    Object.defineProperty(v, 'volume', { value: 1 });
    expect((await latestSignals(env)).media).toBe(true);
    Object.defineProperty(v, 'muted', { value: true, configurable: true });
    expect((await latestSignals(env)).media).toBe(false);   // muted and tiny: decorative
  });

  test('hiding the tab and blurring the window are reported and counted', async () => {
    const env = load();
    Object.defineProperty(env.document, 'visibilityState', { value: 'hidden', configurable: true });
    env.window.dispatchEvent(new env.window.Event('blur'));
    const s = await latestSignals(env);
    expect(s).toMatchObject({ visible: false, focusLosses: 1 });
    expect(s.visibilityChanges).toBeGreaterThanOrEqual(1);
  });

  test('is injected twice safely (manifest + on-demand injection)', async () => {
    const env = load();
    env.window.eval(SOURCE);
    env.document.dispatchEvent(new env.window.MouseEvent('mousedown', { bubbles: true }));
    expect((await latestSignals(env)).buckets).toBe(1);
  });
});

describe('content script: meeting chat (sent-message detection, never the text)', () => {
  const MEET = '<body><div aria-label="In-call messages"><textarea aria-label="Send a message to everyone"></textarea><button aria-label="Send a message">Send</button></div></body>';

  test('Enter in a filled chat box counts one chat message and sends NO text', () => {
    const { window, document, sent, types } = load(MEET);
    const box = document.querySelector('textarea');
    box.value = 'my private answer 12345';
    key(window, box, { key: 'Enter' });
    expect(types().filter((t) => t === 'chatSent')).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toMatch(/private|12345/);
  });

  test('Enter in an EMPTY chat box, or Shift+Enter, is not a message', () => {
    const { window, document, types } = load(MEET);
    const box = document.querySelector('textarea');
    key(window, box, { key: 'Enter' });
    box.value = 'line one';
    key(window, box, { key: 'Enter', shiftKey: true });
    expect(types()).not.toContain('chatSent');
  });

  test('clicking Send with text in the chat box counts; Enter + click for one message counts once', () => {
    const { window, document, types } = load(MEET);
    const box = document.querySelector('textarea');
    box.value = 'hello';
    document.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }));
    key(window, box, { key: 'Enter' });
    expect(types().filter((t) => t === 'chatSent')).toHaveLength(1);
  });

  test('clicking Send with an empty box does nothing', () => {
    const { window, document, types } = load(MEET);
    document.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }));
    expect(types()).not.toContain('chatSent');
  });

  test('Zoom-style contenteditable chat editor is detected', () => {
    const { window, document, types } = load('<body><div class="chat-container"><div class="chat-rtf-box__editor" contenteditable="true">hi all</div></div></body>');
    key(window, document.querySelector('[contenteditable]'), { key: 'Enter' });
    expect(types()).toContain('chatSent');
  });

  test('typing Enter in a non-chat field (search, name, password) is not a chat message', () => {
    const { window, document, types } = load('<body><input id="s" type="text" placeholder="Search for people" value="alice"><input id="n" type="text" aria-label="Your name" value="Bob"></body>');
    key(window, document.getElementById('s'), { key: 'Enter' });
    key(window, document.getElementById('n'), { key: 'Enter' });
    expect(types()).not.toContain('chatSent');
  });
});

describe('content script: educator question box', () => {
  test('top frame shows the question; its text is rendered as text, never as HTML', () => {
    const { window, document, listeners } = load();
    listeners[0]({ type: 'prompt', text: '<img src=x onerror=alert(1)> Define RAM' });
    const host = [...document.documentElement.children].find((n) => n.style && n.style.cssText.includes('top: 48px'));
    expect(host).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(window.document.documentElement.innerHTML).not.toMatch(/onerror/);
  });

  test('a frame inside the page never shows UI', () => {
    const dom = new JSDOM('<body><iframe></iframe></body>', { runScripts: 'outside-only', url: 'https://app.zoom.us/wc/87654321098/join' });
    opened.push(dom.window);
    const frame = dom.window.document.querySelector('iframe').contentWindow;
    const sent = [];
    const listeners = [];
    frame.chrome = { runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve({}); }, onMessage: { addListener: (f) => listeners.push(f) } } };
    frame.eval(SOURCE);
    // a quiet subframe reports nothing; once the user is active inside it, it is reported (the meeting UI can live in an iframe)...
    expect(sent).toEqual([]);
    frame.document.dispatchEvent(new frame.MouseEvent('mousedown', { bubbles: true }));
    frame.document.dispatchEvent(new frame.Event('visibilitychange'));
    return new Promise((resolve) => setTimeout(() => {
      expect(sent.map((m) => m.type)).toEqual(['signals']);
      expect(listeners).toHaveLength(0);
      resolve();
    }, 160));
  });
});
