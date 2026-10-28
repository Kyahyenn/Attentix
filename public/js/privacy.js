/* Privacy & consent for passwordless students.
   1. window.AMPrivacy: the consent API shared with the student dashboard (js/student.js).
   2. The privacy.html page itself (runs only when that page's markup is present).

   A student is identified either by the bearer token (extension / join page) or, with no token, by the email and class
   code they joined with. The credentials live in memory for this page view only and are never written to storage. */
(function () {
  'use strict';
  const { byId, setText, show, api, session, withBusy, toast, navigate, validateFields, clearFieldErrors, fieldError, parseFieldError } = window.AM;

  // ---- identity: ALWAYS both parts ----
  // Without a bearer token a student is identified by BOTH an email and a class code, never by one of them and never
  // by a name (the server ignores names too). Anything incomplete or malformed is refused here, before any request is
  // sent, and only { email, classCode } ever leaves the page: a `name` that a caller still passes is dropped.
  // These checks (and the cool-down below) are client-side courtesy only. They stop accidents and lazy scripts, not an
  // attacker who talks to the API directly: the real enforcement is server-side (middleware/identityGuard.js).
  const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const CLASS_CODE_SHAPE = /^[A-Z0-9]{6,8}$/;
  const EMAIL_MAX = 254;
  const NOT_FOUND_TEXT = 'No student found for that email and class code. Check them, or join the class first.';
  const INCOMPLETE_TEXT = 'Enter both your email and your class code.';

  const refusal = (message, status, code) => Object.assign(new Error(message), { status, code });

  const normalizeCreds = (creds) => {
    if (!creds || typeof creds !== 'object') return null;
    const email = String(creds.email || '').trim().toLowerCase();
    const classCode = String(creds.classCode || '').trim().toUpperCase();
    if (!email || email.length > EMAIL_MAX || !EMAIL_SHAPE.test(email) || !CLASS_CODE_SHAPE.test(classCode)) return null;
    return { email, classCode };
  };

  // The identity fields to send: nothing when a token vouches for the student, otherwise a complete normalised pair.
  const identity = (creds) => {
    if (session.has()) return {};
    const pair = normalizeCreds(creds);
    if (!pair) throw refusal(INCOMPLETE_TEXT, 400, 'IDENTITY_INCOMPLETE');
    return pair;
  };

  // ---- client-side cool-down ----
  // After a few misses in a row the page stops sending requests for a growing pause (5 s, 10 s, ... up to 5 min); a
  // 429 from the server always means at least a minute. A success resets it. It lives in memory only (a reload clears
  // it), which is why it is a courtesy and the server limiter is the control.
  const FREE_MISSES = 3;
  const BASE_PAUSE_MS = 5000;
  const MAX_PAUSE_MS = 5 * 60 * 1000;
  const RATE_LIMITED_PAUSE_MS = 60 * 1000;
  const cooldown = { misses: 0, until: 0 };

  const assertNotCoolingDown = () => {
    const remaining = cooldown.until - Date.now();
    if (remaining > 0) throw refusal(`Too many attempts. Wait ${Math.ceil(remaining / 1000)} seconds and try again.`, 429, 'CLIENT_COOLDOWN');
  };
  const noteMiss = (rateLimited) => {
    cooldown.misses += 1;
    const pause = cooldown.misses > FREE_MISSES ? Math.min(MAX_PAUSE_MS, BASE_PAUSE_MS * (2 ** (cooldown.misses - FREE_MISSES - 1))) : 0;
    const wait = rateLimited ? Math.max(pause, RATE_LIMITED_PAUSE_MS) : pause;
    if (wait) cooldown.until = Date.now() + wait;
  };
  const noteSuccess = () => { cooldown.misses = 0; cooldown.until = 0; };

  // Runs `send(identityFields)`. Token holders skip the identity and cool-down logic entirely.
  async function authorized(creds, send) {
    if (session.has()) return send({});
    const fields = identity(creds);
    assertNotCoolingDown();
    try {
      const data = await send(fields);
      noteSuccess();
      return data;
    } catch (err) {
      if (err && (err.status === 404 || err.status === 401 || err.status === 429)) noteMiss(err.status === 429);
      throw err;
    }
  }

  // creds = { email, classCode } when there is no token; omitted when a token is present.
  // -> { student, class, consent: { accepted, version, timestamp }, status, timestamp }
  const lookup = (creds) => authorized(creds, (fields) => api('/api/student/lookup', 'POST', fields));

  // decision: 'accept' | 'decline'. Declining (withdrawing) stops monitoring at once and deletes the live data.
  const setConsent = (decision, creds) => {
    if (decision !== 'accept' && decision !== 'decline') return Promise.reject(refusal('Unknown consent decision.', 400, 'BAD_DECISION'));
    return authorized(creds, (fields) => api('/api/student/consent', 'POST', { ...fields, decision }));
  };

  const describeConsent = (consent) => {
    if (!consent || !consent.accepted) return 'Consent not given. Nothing is being monitored.';
    const when = consent.timestamp ? ` on ${new Date(consent.timestamp).toLocaleString()}` : '';
    return `Consent given${when}. You can withdraw it at any time.`;
  };

  window.AMPrivacy = { lookup, setConsent, describeConsent, normalizeCreds };

  // ---- the privacy.html page ----
  if (!byId('decisionCard')) return;

  const params = new URLSearchParams(window.location.search);
  let creds = null;

  function showState(consent) {
    const accepted = Boolean(consent && consent.accepted);
    show('identifyCard', false);
    show('decisionCard', !accepted);
    show('withdrawCard', accepted);
    show('declinedCard', false);
    byId('statusNotice').classList.toggle('hidden', accepted);
    setText('acceptedAt', accepted ? describeConsent(consent) : '');
  }

  function showIdentify() {
    show('identifyCard', true); show('decisionCard', false); show('withdrawCard', false); show('declinedCard', false);
  }

  async function load() {
    try {
      const data = await lookup(creds);
      showState(data.consent);
    } catch (err) {
      if (err.status === 401) session.clear();
      showIdentify();
      setText('identifyFormError', err.status === 404 || err.status === 401 ? NOT_FOUND_TEXT : err.message);
    }
  }

  async function init() {
    // Anyone may read the notice before joining (?preview=1): transparency should not need an identity.
    if (params.get('preview')) { show('previewNote', true); show('statusNotice', false); return; }
    session.consumeUrlToken(); // e.g. opened from the extension popup
    if (session.has()) await load(); else showIdentify();
  }

  const codeInput = byId('identifyClassCode');
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

  byId('identifyForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(event.target);
    setText('identifyFormError', '');
    if (!validateFields([['identifyEmail', 'email'], ['identifyClassCode', 'classCode']])) return undefined;
    const pair = normalizeCreds({ email: byId('identifyEmail').value, classCode: codeInput.value });
    if (!pair) { setText('identifyFormError', INCOMPLETE_TEXT); return undefined; } // both parts, every time
    creds = pair;
    return withBusy(byId('identifyBtn'), async () => {
      try { showState((await lookup(creds)).consent); } catch (err) {
        creds = null;
        const { field, text } = parseFieldError(err.message, ['email', 'classCode']);
        if (field) { fieldError(field === 'email' ? 'identifyEmail' : 'identifyClassCode', text); return; }
        setText('identifyFormError', err.status === 404 ? NOT_FOUND_TEXT : err.message);
      }
    }, 'Looking up…');
  });

  const decide = (decision, button, after) => () => {
    setText('privacyMessage', '');
    return withBusy(byId(button), async () => {
      try { await setConsent(decision, creds); after(); } catch (err) {
        if (err.status === 401) { session.clear(); showIdentify(); setText('identifyFormError', 'Your session ended. Enter your email and class code again.'); return; }
        setText('privacyMessage', err.message);
        toast(err.message, true);
      }
    }, 'Saving…');
  };

  const showDeclined = () => { show('decisionCard', false); show('withdrawCard', false); show('declinedCard', true); byId('declinedTitle').focus(); };
  byId('acceptBtn').addEventListener('click', decide('accept', 'acceptBtn', () => { showState({ accepted: true, timestamp: new Date().toISOString() }); byId('withdrawTitle').focus(); }));
  byId('declineBtn').addEventListener('click', decide('decline', 'declineBtn', showDeclined));
  byId('withdrawBtn').addEventListener('click', decide('decline', 'withdrawBtn', showDeclined));
  byId('reviewBtn').addEventListener('click', () => { show('declinedCard', false); show('decisionCard', true); byId('decisionTitle').focus(); });
  byId('signOutBtn').addEventListener('click', () => { session.clear(); creds = null; navigate('/join.html'); });

  init();
})();
