/* Privacy & consent for passwordless students.
   1. window.AMPrivacy: the consent API shared with the student dashboard (js/student.js).
   2. The privacy.html page itself (runs only when that page's markup is present).

   A student is identified either by the bearer token (extension / join page) or, with no token, by the email and class
   code they joined with. The credentials live in memory for this page view only and are never written to storage. */
(function () {
  'use strict';
  const { byId, setText, show, api, session, withBusy, toast, navigate, validateFields, clearFieldErrors, fieldError, parseFieldError } = window.AM;

  // creds = { name?, email, classCode } when there is no token; omitted when a token is present.
  const identity = (creds) => (session.has() || !creds ? {} : creds);

  // -> { student, class, consent: { accepted, version, timestamp }, status, timestamp }
  const lookup = (creds) => api('/api/student/lookup', 'POST', identity(creds));

  // decision: 'accept' | 'decline'. Declining (withdrawing) stops monitoring at once and deletes the live data.
  const setConsent = (decision, creds) => api('/api/student/consent', 'POST', { ...identity(creds), decision });

  const describeConsent = (consent) => {
    if (!consent || !consent.accepted) return 'Consent not given. Nothing is being monitored.';
    const when = consent.timestamp ? ` on ${new Date(consent.timestamp).toLocaleString()}` : '';
    return `Consent given${when}. You can withdraw it at any time.`;
  };

  window.AMPrivacy = { lookup, setConsent, describeConsent };

  // ---- the privacy.html page -----------------------------------------------------------------------------------
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
      setText('identifyFormError', err.status === 404 || err.status === 401 ? 'No student found for that email and class code. Check them, or join the class first.' : err.message);
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
    creds = { email: byId('identifyEmail').value.trim(), classCode: codeInput.value.trim().toUpperCase() };
    return withBusy(byId('identifyBtn'), async () => {
      try { showState((await lookup(creds)).consent); } catch (err) {
        creds = null;
        const { field, text } = parseFieldError(err.message, ['email', 'classCode']);
        if (field) { fieldError(field === 'email' ? 'identifyEmail' : 'identifyClassCode', text); return; }
        setText('identifyFormError', err.status === 404 ? 'No student found for that email and class code. Check them, or join the class first.' : err.message);
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
