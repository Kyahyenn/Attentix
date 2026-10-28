# Review notes

A summary of the security, privacy, performance and usability work behind this version. It is background reading for
developers. For setup and daily use, see the [README](README.md). Run `npm test` for the current test status.

## 1. Security

| Problem found | What was done |
| --- | --- |
| Anyone who knew a class ID could enrol without its code. | Students now join only with `POST /api/extension/join` and a Class Code. Old enrol, join and lookup routes answer `410`. A wrong code and an unknown class give the same `404`. |
| Logging out did not stop live monitoring. | Logout, account deletion, student removal and consent withdrawal disconnect live sockets at once. A 60-second check re-validates every live socket. |
| WebSocket handshakes were not origin-checked (cross-site hijacking). | Origin check on every handshake: own origin, configured origins and the extension. |
| The CSP allowed inline scripts and a third-party CDN. | All scripts are external files, Chart.js is bundled, and the CSP uses `script-src 'self'`. |
| Login throttling was per IP only. | Added a per-account login limiter and a separate limiter for class-code guessing. |
| Sessions used an unbounded in-memory store and a fixed 24 h cookie. | `memorystore` with pruning, an 8 h rolling idle timeout, and production refuses a weak `SESSION_SECRET`. |
| Extension tokens could not be revoked for 12 h. | A `tokenVersion` claim. `POST /api/extension/logout` revokes all of a student's tokens and cuts their sockets. |
| The extension only warned about plain `http://` to public servers. | Blocked. Plain `http://` is allowed only for localhost, private addresses and `.local` names. |
| Socket abuse: 1 MB messages, free-text event types, no per-event limits. | 16 KB cap, fixed list of event types, per-socket rate limits, max 5 sockets per user, 10 s connect timeout. |
| Callers could override `id` and `createdAt`; data files were world-readable. | Server-set fields always win. Files are `0600`, the folder `0700`. |
| Weak password rules (character count vs bcrypt's 72-byte limit). | Byte-length check plus a common-password deny-list. |
| CSRF defence relied on `SameSite` only. | Origin check on cookie-authenticated changes. `Cache-Control: no-store` on all `/api` responses. |
| Students could see join codes and educator IDs. | Students receive only what they need. |
| Docker image: old flags, no health check, writable filesystem. | `--omit=dev`, `HEALTHCHECK` on `/healthz`, read-only filesystem, no capabilities, `no-new-privileges`. |

## 2. Privacy and fairness

* Consent can be withdrawn at any time and takes effect immediately. It is versioned: when the notice changes, everyone
  is asked again.
* The privacy notice matches real behaviour and can be read before signing up (`/privacy.html?preview=1`).
* Students see the same live row their teacher sees about them.
* Erasure: students can delete their data and leave a class; teachers can remove a student or delete their account.
* Minimal data: **Clear live data** button, typed reply text is never stored, class codes are removed from the address bar
  after use.
* Wording: "Check-in suggested" instead of "Not attentive", a standing "signals, not proof" notice, and a confirmation
  before exporting names to CSV.

## 3. Performance

* The database is cached in memory and written through with atomic temp-file-then-rename saves. A failed write never
  leaves memory ahead of disk.
* The dashboard updates rows in place, draws at most once per animation frame, skips drawing while the tab is hidden and
  redraws charts only when numbers change.
* gzip (Chart.js 205 KB to about 70 KB), cacheable static files, no third-party requests.

## 4. Usability and accessibility

* Real forms (Enter submits, password managers work), correct `autocomplete`, show/hide password.
* Native `<dialog>` modals, skip link, labelled inputs, visible keyboard focus, `prefers-reduced-motion`.
* Light and dark themes. Status is always shown with text, not colour alone.
* Server text is inserted with `textContent` only, never `innerHTML`.
* Three tabs (Home, Classes, Settings) with keyboard support and a bottom bar on phones. Each class has its own page at
  `#class/<id>`, so refresh, bookmarks and Back work.

## 5. Behaviour you should know about

1. Existing consent records have no version, so students accept the notice once more.
2. Class codes are permanent. The rotate endpoint answers `410`.
3. The session cookie is named `attention.sid`. After a deploy or restart, teachers sign in again.
4. `src/utils/bootstrap.js` creates `.env`, resolves `.env` and `data/` next to a packaged app, detects the network
   address and keeps one server per data folder with a lock file. Docker is unaffected (`AUTO_ENV=false`).
5. A second double-click waits for the running server and opens its page. Start-up errors go to `error.log`.
6. **Log out & stop server** stops the server only on the computer that runs it. Remote teachers, Docker and proxies get
   a normal sign-out.
7. While the extension popup is open, or on the extension's own pages, the student is not counted as switching tabs.
8. Not renamed on purpose, so nothing stored stops working: the `attention.sid` cookie, the token signing label,
   `localStorage` keys (`am.*`), `window.AM*` globals, Docker service names and the `data/` files.

## 6. Known limitations and next steps

* Run behind HTTPS (see the [self-hosting guide](docs/self-hosting.md)). Nothing replaces TLS.
* JSON files plus in-memory sessions mean a single process. Move to a real database and a session store before scaling.
* No password reset or email verification. The register `409` still reveals whether an email exists.
* `bcryptjs` is pure JavaScript. Native `bcrypt` or `argon2` would cut login CPU time in big classes.
* On a classroom LAN, plain `http://` exposes names, emails and tokens to others on that Wi-Fi. Use `PUBLIC_URL` and a
  reverse proxy when that matters.
* "Shut down server" requires a loopback connection with no proxy headers. A proxy on the same machine that rewrites
  headers would defeat this, so Docker and proxied setups never offer it.
* `POST /api/logout` with a student token answers `500`. No page calls it that way; it is tracked as a `test.todo` in
  `tests/integration/securityFlow.test.js`.
* The dashboard refresh sends full rows every 3 s. Sending timestamps and counting client-side would cut traffic.
* The pages and the extension were tested with jsdom and test harnesses, not a real browser. After loading the extension
  unpacked, click through every tab in Chrome (light, dark, phone width) and test the extension on a real Meet call.
