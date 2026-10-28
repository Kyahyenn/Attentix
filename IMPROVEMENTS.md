# Review & improvements (v2.1.0)

> A snapshot of the v2.1.0 review. The test counts and results below describe that moment; run `npm test` for the current
> state. For setup and usage, see the [README](README.md).

Scope: performance ("sluggish"), UI/UX, privacy & ethics, and security. Every item below was verified by running the
code: 470 automated tests, a real-Chromium end-to-end run (educator + student sessions, light/dark), ESLint, and
`npm audit --omit=dev` (0 vulnerabilities).

## 1. Security fixes

| # | Finding | Fix |
|---|---|---|
| S1 | **Join-code bypass:** `POST /api/classes/enroll` enrolled anyone who knew a class UUID (it appeared in `student.html?classId=…` URLs), so rotating/locking a class meant nothing. | Fixed in 2.1 by requiring the code; now superseded: `/enroll`, `/join` and `/lookup` are retired (`410`) and the only way in is `POST /api/extension/join` with a Class Code (same 404 for any wrong code). |
| S2 | **Logout didn't stop monitoring:** destroying the cookie session left already-open sockets streaming. | Logout, account deletion, removal and consent withdrawal call into the socket layer and disconnect immediately; a 60 s revalidation loop re-checks every live socket against the DB. |
| S3 | **Cross-Site WebSocket Hijacking:** CORS only protects long-polling; WebSocket handshakes weren't origin-checked. | `allowRequest` origin check (own origin, configured origins, extension). |
| S4 | **CSP allowed `'unsafe-inline'` scripts and a third-party CDN.** Any HTML injection ⇒ script execution; the CDN also saw every educator's IP. | All scripts externalised to `/js/*.js`; Chart.js vendored; CSP is `script-src 'self'`, `frame-ancestors 'none'`, `form-action 'self'`, ws `connect-src`. |
| S5 | Per-IP-only login throttling (useless against IP-rotating guessing of one account). | Added per-account limiter; separate limiter on class-code lookup/join (code guessing). |
| S6 | Session store was the default `MemoryStore` (unbounded leak), 24 h fixed cookie. | `memorystore` with TTL pruning; 8 h **idle** timeout (rolling); cookie renamed; fails to start in production with a weak/short `SESSION_SECRET`. |
| S7 | Extension bearer tokens were irrevocable for 12 h. | `tokenVersion` claim; `POST /api/extension/logout` revokes all tokens and cuts extension sockets; extension calls it on sign-out. |
| S8 | Extension only *warned* about plain `http://` to non-localhost (token + password in clear text). | Blocked outright. |
| S9 | Socket abuse surface: 1 MB message buffer, free-text `eventType`, no per-event limits, unlimited sockets per user. | 16 KB cap, enum allow-list, per-socket token buckets, max 5 sockets/user, 10 s connect timeout. |
| S10 | `db.insert` let a caller-supplied object override `id`/`createdAt`; data files world-readable. | Server fields win; files `0600`, directory `0700`. |
| S11 | Weak password rules (72-*character* cap while bcrypt truncates at 72 *bytes*). | Byte-length check + common-password deny-list. |
| S12 | Educator invite code compared with `!==` (timing). | Constant-time compare. Superseded: the professor / invite code no longer exists; educators register with name, email and password only. |
| S13 | CSRF defence relied on SameSite only. | Origin guard for cookie-authenticated state-changing requests; `Cache-Control: no-store` on all `/api` responses. |
| S14 | `my-classes` returned join codes/`educatorId` to students. | Students get only what they need. |
| S15 | Docker: deprecated flags, no healthcheck, writable root fs. | `--omit=dev`, HEALTHCHECK + `/healthz`, read-only fs, `cap_drop: ALL`, `no-new-privileges`. |

## 2. Privacy & ethics

* **Consent was one-way.** A student who accepted could never see the notice again or withdraw, and a withdrawal wouldn't
  have stopped a live socket. Now: `?review=1` page with **Withdraw**, enforced instantly; consent is **versioned**.
* **The privacy notice was incomplete** (no mention of the extension, who sees data, CSV export or retention). Rewritten
  to match the real behaviour; readable *before* signing up (`/privacy.html?preview=1`).
* **No transparency to the monitored person.** Students now see their own live row ("What your educator sees about you").
* **No erasure.** Added `DELETE /api/me` (password-confirmed), *Leave class*, and educator *Remove student*.
* **Data minimisation:** educator "Clear live data" button; the typed reply text is never stored; join code removed from the
  address bar after use.
* **Fairness:** "Not Attentive" → "Check-in suggested", persistent "signals, not proof" banner, confirmation before CSV
  export of names.
* Declining consent no longer bounces the student straight back to the same page.

## 3. Performance ("sluggish")

* **DB:** every request re-read and re-parsed whole JSON files (a class join read three). Now cached in memory,
  write-through with atomic temp-file+rename; a failed write can't leave memory ahead of disk.
* **Dashboard:** the table was rebuilt via `innerHTML` and both charts re-animated about once a second. Now rows are
  patched in place, renders are coalesced into one animation frame and skipped while the tab is hidden, charts redraw
  only when numbers change (`animation:false`).
* **Network:** gzip (Chart.js 205 KB → 70 KB), cacheable static assets, scripts de-duplicated out of 4 pages into cached
  files, no third-party requests.

## 4. UI / UX / accessibility

* Real `<form>`s (Enter submits, password managers work), show/hide password, correct `autocomplete`.
* Native `<dialog>` modals (focus trap, Esc, screen-reader semantics), skip link, labelled inputs, `role="log"` chat,
  table caption/scope, visible keyboard focus, `prefers-reduced-motion`.
* Automatic **dark mode**, status chips carry text (not colour alone), search/filter/sort, sticky table header,
  responsive layout, 16 px inputs (no iOS zoom), clear connection badge.
* Server-supplied text is only ever inserted with `textContent` (no `innerHTML` with data).

## 5. Behaviour changes you should know about

1. Existing consent records have no version, so **students must accept the new notice once**.
2. `/api/classes/enroll` needed `{ classId, code }` in 2.1. It is now retired (`410`): students join with `POST /api/extension/join` `{ name, email, classCode, consent: true }`, with no password and no student account. Class codes are permanent (the rotate endpoint answers `410`).
3. Session cookie renamed (`attention.sid`): everyone logs in again after deploying; sessions are lost on restart.
4. Tests deliberately changed: CSP assertion, consent-status shape, enrolment via join code. 23 new tests added.
5. Test suite aligned to the extension-first architecture (phase 4): educator registration without a professor code, immutable class codes, the passwordless join and re-join (same student, same roster entry), bearer-token and `name + email + classCode` student views, heartbeat scoring and broadcast, and DOM wiring for `login`, `educator-signup`, `join`, `student` and the extension popup.
6. Zero-terminal packaging (phase 5): `src/utils/bootstrap.js` creates `.env` (random `SESSION_SECRET` / `EXTENSION_TOKEN_SECRET`, first free port, `data/`) without ever overwriting real values, resolves `.env` and `data/` next to a packaged executable, detects the LAN address (`GET /api/server-info`), opens the browser safely (never under test / `NO_AUTO_OPEN`) and keeps one server per data directory with a lock file. `npm run build:exe` builds `Attentix-{win.exe,macos,linux}` with `@yao-pkg/pkg`; `Launch-Silent.vbs`, `Launch-App.bat`, `Launch-App.command` are the no-terminal fallbacks. The dashboard shows the server address, has *Shut down server*, and offers *Download Pre-Configured Student Extension* (`GET /api/extension/preconfigured`), whose `config.js` the popup and background worker read. Docker is unchanged (`AUTO_ENV=false`).

7. Phase 6 (launcher, sign-out, popup):
   * **Second double-click:** `src/index.js` now takes the instance lock *before* loading the app. A second launch waits (up to 60 s) until the running server answers `/healthz`, follows its port, opens the browser and only then exits (`openBrowserAndWait`); before, it opened the page immediately, so during a slow start the browser showed "can't connect". A lock left by a crashed run is detected and replaced. Closing the console window (`SIGHUP`/`SIGBREAK`) now releases the lock.
   * **Start-up errors are visible:** they are printed, appended to `error.log` next to the app and the window waits for Enter (a double-clicked console used to vanish). A too-short `SESSION_SECRET` in a production `.env` (which made the app refuse to start) is regenerated.
   * **Shutdown** cuts lingering browser connections and exits within 2 s (it could take 10 s and exit with an error code).
   * **Build:** executables are no longer GZip-compressed by default (`PKG_COMPRESS=GZip` restores it).
   * **Log out stops the server:** `POST /api/server/sign-out` signs the educator out and, on the computer running the app only, stops the server. The dashboard button reads *Log out & stop server* there. Remote educators, Docker and proxies get a plain sign-out.
   * **Extension popup:** while the toolbar popup is open (a port plus its status polling), the browser window counts as focused, and the extension's own pages (`chrome-extension://<id>/...`) count as class ("tool"), so neither is a tab switch or focus loss. A student already away who opens the popup is not charged again.

## 6. Known limitations / recommended next steps

* **Run behind HTTPS** (see the [self-hosting guide](docs/self-hosting.md)). Nothing here replaces TLS.
* Flat-file JSON + in-memory sessions = single process. Move to SQLite/Postgres + a session store before scaling.
* `bcryptjs` is pure JS; switching to native `bcrypt`/`argon2` would cut login CPU time in big classes.
* No password reset / change flow, no email verification, no audit log of educator exports.
* **Plain `http://` on the classroom LAN:** the extension now accepts `http://` for private-network addresses (192.168.x.x, 10.x.x.x, 172.16-31.x.x, `.local`) because a LAN server has no certificate. Names, emails and tokens are therefore readable by others on that Wi-Fi; public addresses still require `https://`. Use `PUBLIC_URL` + a reverse proxy when that matters.
* **Shutdown button:** educator sign-up is open, so `POST /api/server/shutdown` additionally requires a loopback connection with no proxy headers and a localhost `Host`. A reverse proxy on the same machine that rewrites those headers would defeat that, which is why Docker (and any proxied setup) never reports `canShutdown`.
* The downloaded extension is a zip to *Load unpacked* (Chrome cannot install an unpacked zip by itself); the macOS binary is unsigned.
* `POST /api/logout` called with a *student bearer token* answers `500` (a bearer "session" has no `destroy()`; `src/routes/authRoutes.js`). No page calls it that way (students sign out with `POST /api/extension/logout`); tracked as a `test.todo` in `tests/integration/securityFlow.test.js`.
* Username enumeration is still possible via the register 409 (a common trade-off); add email verification to remove it.
* The 3 s dashboard refresh still pushes full rows; sending timestamps and ticking client-side would cut traffic further.
* The extension was not exercised in a real Chrome here (its logic is covered by the harness tests); smoke-test it manually
  after loading it unpacked.
## Phase 7: Attentix redesign (interface only)

* **Renamed to Attentix** everywhere a person sees the name: page titles, headers, the extension popup / manifest / in-meeting badge, console and launcher messages, docs, and the packaged file names (`Attentix-win.exe`, `Attentix-macos`, `Attentix-linux`, `Attentix-Extension-<CODE>.zip`; npm package and bin are `attentix`). Deliberately **not** renamed, so nothing stored or signed stops working: the session cookie (`attention.sid`), the extension-token signing label, `localStorage` keys (`am.*`), `window.AM*` globals, the Docker service / container names, and the `data/` files.
* **Design system** (`public/styles.css`): PUP-inspired maroon and gold on white and light gray; one restrained green / gold / red / gray set kept only for attentiveness states (always paired with a text label). rem-based spacing, one radius scale, subtle shadows, a dark theme in the same palette. Contrast of every token pair was computed: text and controls meet WCAG AA in both themes.
* **Three tabs on the educator dashboard and the student page** (`public/js/nav.js`, ARIA tabs pattern, arrow keys, `#home` / `#classes` / `#settings` links, bottom tab bar on phones). Educator: **Home** = overview tiles + live dashboard, **Classes** = create + list + extension download, **Settings** = server address / shut down, display options, delete account. Student: **Home** = live score, **Classes** = class details, **Settings** = privacy & consent, display options. The Display (theme + text size) controls now live in Settings (`#displaySettings`); other pages keep them at the top.
* **Extension HUD:** the on-meeting badge and the educator question box, and the popup, use the same palette. The toolbar badge for *Passive* moved from blue to dark gold.
* Backend routes, socket events, data files and every element id the scripts use are unchanged. Tests that pinned the old name, file names or popup colours were updated; `tests/unit/navTabs.test.js` is new.
* Not done here: the pages were verified with jsdom and the full test suite, not in a real browser (no browser could be installed in the build environment). Please click through every tab once in Chrome, in light and dark, and on a phone-width window.

## Phase 8: Home overview, Classes list and one page per class

* **Home** is an overview now, not a class: summary cards (total classes, students enrolled, active now, average attentiveness, students below 60), **Quick actions** (Create Class, View Classes), **Recently opened** classes and **Recent activity** (classes with student activity, newest first, with how many are active and below 60). Averages are weighted by how many students have a score, and show a dash when nobody does.
* **Classes** lists every class as its own card, with a **Grid / List** toggle (`aria-pressed`, remembered), **search** (name, section or code), **sort** (name, newest, most students, most active, recently opened; remembered) and a **Create Class** button. Create Class opens a dialog (it is also reachable from Home); a too-short name is refused inline.
* **One class, one page:** a card is a real link to `#class/<id>`, so refresh, bookmarks and the browser's Back button work. The page shows only that class: its code (Copy Class Code, Copy invite link, Download Pre-Configured Student Extension), Ask your class, live attentiveness, charts and roster, Clear live data, Export CSV and Print. It never lists other classes. **Back to Classes** is a plain link at the top. Leaving the page drops its roster and charts from memory; an unknown id shows "Class not found" with the way back.
* `src/utils/classes.js` adds `createdAt`, `scoredCount`, `averageScore`, `belowThresholdCount` and `lastActivityAt` to `GET /api/educator/classes`, computed from the in-memory engagement state with the dashboard's own definitions. No names or ids of students are included and nothing is stored.
* "Recently opened" keeps only class ids and times in this browser (`localStorage`, one list per educator account); classes that no longer exist are ignored.
* `nav.js` learned **views**: a panel with `data-parent` (here `panel-class`, parent `classes`) keeps its parent tab highlighted; `AMNav.show(name, param)` and `AMNav.param()` open and read them.
* Found by running the page in real Chromium: a wide roster table made the whole class page scroll sideways (page 1462 px wide on a 1280 px screen, 1402 px on a phone), and the roster's "Show" select overflowed a 390 px phone. Both fixed in `styles.css`.
* The per-class **Open dashboard**, **Copy invite link** and **Download** buttons moved from the list card to the class page; the card keeps **Copy Class Code**. Tests were updated for that, and `tests/unit/classPages.test.js` and `tests/integration/classLiveStats.test.js` are new.
