(function () {
  'use strict';
  const { byId, setText, show, api, session, withBusy, invite, validateFields, clearFieldErrors, fieldError, parseFieldError } = window.AM;

  const FIELDS = { name: 'joinName', email: 'joinEmail', classCode: 'joinClassCode' };

  const codeInput = byId('joinClassCode');
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

  // Deep link /join?classCode=ABC234 pre-fills the form. The code is taken out of the address bar straight away
  // (history, screenshots, shoulder-surfing); a cached copy from an earlier visit is used only when the URL has none.
  function prefill() {
    const params = new URLSearchParams(window.location.search);
    const fromLink = invite.fromUrl();
    if (fromLink) invite.save(fromLink);
    if (params.has('deleted')) show('deletedNotice', true);
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
    const code = fromLink || invite.peek();
    if (code) codeInput.value = code;
  }

  // A student who is already holding a token (joined earlier in this tab, or opened from the extension) is offered a
  // shortcut instead of the form. A stale token is dropped silently.
  async function checkExisting() {
    if (!session.has()) return;
    try {
      const data = await api('/api/student/lookup', 'POST', {});
      setText('existingText', `You joined ${data.class.className} as ${data.student.name}.`);
      show('existingCard', true);
    } catch (err) {
      if (err.status === 401 || err.status === 404) session.clear();
    }
  }

  byId('existingForgetBtn').addEventListener('click', () => {
    session.clear();
    show('existingCard', false);
    byId('joinName').focus();
  });

  byId('joinForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(event.target);
    setText('joinFormError', '');

    const consentRule = () => (byId('joinConsent').checked ? '' : 'Please read and agree to the privacy notice to join.');
    if (!validateFields([['joinName', 'name'], ['joinEmail', 'email'], ['joinClassCode', 'classCode'], ['joinConsent', consentRule]])) return undefined;

    return withBusy(byId('joinBtn'), async () => {
      try {
        const data = await api('/api/extension/join', 'POST', {
          name: byId('joinName').value.trim(),
          email: byId('joinEmail').value.trim(),
          classCode: codeInput.value.trim().toUpperCase(),
          consent: true
        }, { bearer: false }); // a new join must never be sent with an older student's token
        session.set(data.token, { persist: byId('joinRemember').checked, expiresAt: data.expiresAt });
        invite.clear();
        setText('successText', `${data.message === 'Welcome back' ? 'Welcome back' : 'You joined'} ${data.className}, taught by ${data.educatorName}. Your consent was recorded.`);
        show('joinCard', false); show('existingCard', false); show('successCard', true);
        byId('successTitle').focus();
      } catch (err) {
        if (err.status === 404) { fieldError('joinClassCode', 'No class found for that code. Check it with your educator.'); codeInput.focus(); return; }
        const { field, text } = parseFieldError(err.message, Object.keys(FIELDS));
        if (field) { fieldError(FIELDS[field], text); byId(FIELDS[field]).focus(); } else setText('joinFormError', err.message);
      }
    }, 'Joining…');
  });

  prefill();
  checkExisting();
})();
