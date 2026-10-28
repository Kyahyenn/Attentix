(function () {
  'use strict';
  const { byId, setText, api, withBusy, redirectAfterAuth, validateFields, clearFieldErrors, fieldError, parseFieldError, wirePasswordToggles } = window.AM;

  const FIELDS = { name: 'eduName', email: 'eduEmail', password: 'eduPassword' };

  wirePasswordToggles();

  byId('educatorForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(event.target);
    setText('eduFormError', '');

    if (!validateFields([['eduName', 'name'], ['eduEmail', 'email'], ['eduPassword', 'password']])) return undefined;

    return withBusy(byId('eduBtn'), async () => {
      try {
        // Educator accounts need nothing but a name, an email and a password: there is no professor/invite code.
        // `bearer: false`: an educator page must never send a student token that an earlier visit left in this tab.
        const data = await api('/api/auth/educator/register', 'POST', {
          name: byId('eduName').value.trim(),
          email: byId('eduEmail').value.trim(),
          password: byId('eduPassword').value
        }, { bearer: false });
        redirectAfterAuth(data.user);
      } catch (err) {
        const { field, text } = parseFieldError(err.message, Object.keys(FIELDS));
        if (field) { fieldError(FIELDS[field], text); byId(FIELDS[field]).focus(); } else setText('eduFormError', err.message);
      }
    }, 'Creating account…');
  });
})();
