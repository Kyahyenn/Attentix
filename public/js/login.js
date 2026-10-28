(function () {
  'use strict';
  const { byId, setText, api, withBusy, redirectAfterAuth, validateFields, clearFieldErrors, wirePasswordToggles } = window.AM;

  if (new URLSearchParams(location.search).get('deleted')) byId('deletedNotice').classList.remove('hidden');

  wirePasswordToggles();

  // Educators only. `bearer: false` everywhere: this page uses the cookie session, never a student's token.
  // Already signed in as an educator? Skip the form. (A student token in this tab is none of this page's business.)
  api('/api/me', 'GET', undefined, { bearer: false })
    .then((data) => { if (data.user && data.user.role === 'educator') redirectAfterAuth(data.user); })
    .catch(() => { /* not signed in: stay here */ });

  byId('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(event.target);
    setText('loginError', '');
    const nonEmpty = (label) => (v) => (String(v || '').trim() ? '' : label);
    if (!validateFields([['loginEmail', nonEmpty('Enter your email address.')], ['loginPassword', nonEmpty('Enter your password.')]])) return undefined;

    return withBusy(byId('loginBtn'), async () => {
      try {
        const data = await api('/api/login', 'POST', { email: byId('loginEmail').value.trim(), password: byId('loginPassword').value }, { bearer: false });
        redirectAfterAuth(data.user);
      } catch (err) {
        // 410: the password belongs to a retired student account. Tell them where students go now.
        if (err.status === 410) {
          setText('loginError', 'Students no longer sign in with a password. Use the Join page or the browser extension instead.');
          return;
        }
        setText('loginError', err.message);
      }
    }, 'Signing in…');
  });
})();
