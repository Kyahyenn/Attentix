# Attentix

Attentix shows a teacher, live, how engaged students are during an online class on **Google Meet** or the **Zoom web
client**. You run it on your own computer, create a class, and students join with a Chrome extension. Students need no
account and no password.

> **Signals, not proof.** The scores only suggest that someone *might* be disengaged. Use them to start a friendly
> check-in, never to grade or punish.

## What you get

* **Teacher dashboard** with three tabs: **Home** (totals and recent activity), **Classes** (create, search and open
  classes) and **Settings** (appearance, accessibility, server address, account). Each student shows as **Focused**,
  **Passive**, **Distracted** or **Offline**.
* **Chrome extension** that sends a simple attention score from the student's meeting tab.
* **Student page** where each student sees exactly what their teacher sees about them.

## Privacy

* **Nothing is monitored until the student agrees.** Joining requires a consent box. If the privacy text changes,
  everyone is asked again.
* **Shared:** an attention score and state, based on whether the meeting tab is in front, tab switches, recent activity,
  scrolling and media playback.
* **Never collected:** typed text, pressed keys, chat messages, page content, camera, microphone, screenshots or
  browsing history.
* **Students stay in control.** They can withdraw consent, leave a class or delete their data at any time, and
  monitoring stops immediately. Teachers can delete their account, which also removes their classes.
* **Live data is not saved.** It stays in memory and is forgotten about an hour after a student disconnects. Only
  accounts, classes, enrolments and consent records are stored (in `data/`).

## Start the app (teacher)

Pick **one** option. No terminal needed.

**Option 1: standalone app (nothing to install).** Double-click the file for your computer. To get these files, see
[Build the standalone app](#build-the-standalone-app).

| Computer | File |
| --- | --- |
| Windows | `Attentix-win.exe` |
| macOS | `Attentix-macos` (first time: right-click, then **Open**, because the app is not signed) |
| Linux | `Attentix-linux` (run `chmod +x Attentix-linux` once) |

**Option 2: launcher scripts.** Install [Node.js](https://nodejs.org) 20 or newer once, then:

* **Windows:** double-click `Launch-Silent.vbs` (no window) or `Launch-App.bat` (shows a window).
* **macOS / Linux:** double-click `Launch-App.command`.

The first launch downloads what the app needs. It needs internet and takes about a minute.

**What happens on every start**

1. The app creates a `.env` settings file (with random secrets) and a `data/` folder next to itself. It never overwrites
   settings you already have. If port 3000 is busy, it uses the next free port.
2. Your browser opens: the sign-up page the first time, your dashboard after that.
3. **Settings** shows the address students need (for example `http://192.168.1.20:3000`) with a **Copy address** button.

**To stop the app:** use **Log out & stop server** (top right) or **Shut down server** (in **Settings**) on the computer
that runs it. Starting the app again while it runs just opens the running one.

> **Keep `data/` and `.env`.** They hold your classes. Back up `data/`.

## Set up your first class (teacher)

1. **Create your account** (name, email, password). There is no password reset yet, so keep the password safe.
2. Press **Create Class** (on **Home** or **Classes**) and enter a name. The app creates a permanent 6-character
   **Class Code**. It never changes.
3. **Open the class** and give students the extension, either way:
   * Press **Download Pre-Configured Student Extension** and send them the zip. It already holds your address and code.
   * Or press **Copy Class Code** and share the code with the server address.
4. **Watch the roster.** **Remove** takes a student out and stops their monitoring. **Clear live data** wipes the live
   picture between lessons.

Students must be on the **same network** (for example the school Wi-Fi). To let them join from **any network**, follow
[Run it on the internet for free](docs/deploy-free.md). For school servers and Docker, see the
[self-hosting guide](docs/self-hosting.md).

## Join a class (student)

1. Unzip the file your teacher sent you.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and pick the unzipped
   folder.
3. Click the extension, enter your **full name** and **email**, tick the consent box and press **Join class**.
4. Open your meeting on `meet.google.com` or the Zoom web client. The extension icon shows your live score.

Joining again with the same email and Class Code puts you back in the same place. To see what your teacher sees, or to
withdraw consent, press **Open Web Dashboard** in the extension. More help: [extension guide](extension/README.md).

## Troubleshooting

| Problem | What to try |
| --- | --- |
| "Node.js is needed" | Install Node.js 20+ from [nodejs.org](https://nodejs.org), or use the standalone app. |
| First launch fails while installing | Check your internet and start again. `Launch-Silent.vbs` saves details in `install.log`. |
| Browser did not open | Open `http://localhost:3000` yourself. Silent launches write to `server.log`. |
| App will not start | The reason is shown in its window and saved to `error.log` next to the app. |
| Students cannot connect | They must be on the same network. Check the address in **Settings**. Allow the app on *private networks* if your firewall asks. No address shown? Connect to Wi-Fi and restart the app. |
| Address uses another port | Port 3000 was busy. **Settings** shows the right address. |
| "No class found for that code" | Check the code with your teacher. |
| "Agree to the privacy notice to join" | Tick the consent box. |
| "Chrome needs your permission to contact that server" | Press **Join class** again and choose **Allow**. |
| Forgot teacher password | There is no reset. Create a new account; classes stay with the account that made them. |

## Known limitations

* Chrome 116 or newer only. Meet and the Zoom **web client** work; the Zoom desktop app does not.
* The extension is loaded unpacked (Developer mode), not from the Chrome Web Store.
* Plain `http://` is not encrypted. Use HTTPS for anything beyond one classroom network.
* Teacher sign-up is open to anyone who can reach the server. There is no password reset or email verification.
* One server process. Data is stored in JSON files (or Firestore), not a full database.
* Scores are a rough signal, not proof of attention.

---

# For developers

Needs Node.js 20 or newer.

```bash
npm install
npm start
```

| Command | What it does |
| --- | --- |
| `npm start` | Starts the server (`NO_AUTO_OPEN=true npm start` keeps the browser closed). |
| `npm run dev` | Starts the server and restarts it when files change. |
| `npm test` | Runs all tests (real HTTP and WebSockets, no browser). |
| `npm run test:unit` / `npm run test:integration` | Runs one half of the tests. |
| `npm run lint` | Checks `src/`, `public/js/`, `extension/*.js` and `tests/`. |
| `npm run audit:prod` | Checks production dependencies for known problems. |
| `npm run build:exe` | Builds the standalone apps into `dist/`. |

### Project map

```
src/index.js     Starts everything: .env setup, single-instance lock, server, timers, browser
src/app.js       Express app: security headers, sessions, routes
src/routes/      Educator login, classes, roster, consent, extension join/heartbeat, downloads
src/socket/      Real-time updates (Socket.IO)
src/state/       Live engagement data (memory only)
src/config/      Settings and the data store (JSON files or Firestore)
src/utils/       First-run setup, class codes, validation, extension zip builder
public/          Web pages and their scripts
extension/       Chrome extension
scripts/         build-exe.js
tests/           Unit and integration tests
```

### Web pages

| Page | Who | Purpose |
| --- | --- | --- |
| `/login.html` (and `/`) | Teachers | Sign in |
| `/educator-signup.html` | Teachers | Create an account |
| `/educator-dashboard.html` | Teachers | Classes, live roster, charts |
| `/join.html` (and `/join`) | Students | Join from the browser (only the extension sends attention data) |
| `/student.html` | Students | Own live status, withdraw consent, delete data |
| `/privacy.html` | Everyone | Privacy notice |

`/signup.html` is retired and redirects.

### Settings page

Everything is remembered in this browser only: **Appearance** (light, dark or device; four colour themes),
**Accessibility** (text size 80-200%, high contrast, reduced motion, stronger focus outline, optional keyboard
shortcuts) and **General** (confirmations, check-in alerts, first tab, class layout and sort, export/import/reset of
preferences). Code: `public/js/a11y.js` (display choices, applied before first paint), `public/js/settings.js` (page),
`AM.prefs` in `public/js/common.js` (other preferences).

### Build the standalone app

```bash
npm run build:exe              # Windows, macOS and Linux apps in dist/
npm run build:exe -- win       # only one: win, macos or linux (several allowed)
```

The build bundles Node.js, the server, `public/` and `extension/` into one file per system using
[`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg). It needs internet the first time and can build all three systems from
any one of them.

* Apps are 64-bit. The macOS app is not code-signed.
* An app keeps `.env` and `data/` **next to itself**, not inside the bundle.
* `PKG_NODE` picks another Node version (default `node22`). `PKG_COMPRESS=GZip` makes a smaller, slower-starting file.

## More documentation

* [Run it on the internet for free](docs/deploy-free.md): Render + Firebase, no installs.
* [Self-hosting guide](docs/self-hosting.md): HTTPS, `.env` settings, Docker, backups, security.
* [Extension guide](extension/README.md): install, permissions, how the score works.
* [Review notes](IMPROVEMENTS.md): security, privacy and performance work behind this version.
