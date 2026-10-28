(function () {
  'use strict';
  const { byId, invite } = window.AM;

  // Student sign-up no longer exists. Professors who land here (?role=educator / ?role=professor) are sent to the
  // educator form; everyone else goes to the passwordless Join page, keeping a class code from an old invite link.
  const params = new URLSearchParams(window.location.search);
  const role = String(params.get('role') || '').toLowerCase();
  const isEducator = ['educator', 'professor', 'teacher'].includes(role) || params.has('educator') || params.has('professor');
  const code = invite.fromUrl();

  const target = isEducator ? '/educator-signup.html' : `/join.html${code ? `?classCode=${encodeURIComponent(code)}` : ''}`;
  byId('studentLink').href = `/join.html${code ? `?classCode=${encodeURIComponent(code)}` : ''}`;
  if (isEducator) byId('redirectStatus').textContent = 'Redirecting you to educator sign-up.';

  window.AM.navigate(target);
})();
