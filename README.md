# Attentix

Attentix helps a teacher see, in real time, how engaged students are during an online class on **Google Meet**
or the **Zoom web client**. It is **consent-based** and **self-hosted**: you run the app on your own computer, create a
class, and students join with a Chrome extension. Students need no account and no password.

> **Signals, not proof.** The indicators show *possible* disengagement. Use them to start a friendly check-in, never to
> grade or punish a student.

## What you get

* A clean, PUP-inspired interface with three tabs: **Home** (an overview: totals, quick actions, recently opened classes and recent activity), **Classes** (every class as a card or a list, with search, sort and Create Class; each class opens on its own page with the live dashboard and its tools) and **Settings** (Appearance, Accessibility and General preferences, plus the server address and account).
* A live dashboard for the teacher: each student shows as **Focused**, **Passive**, **Distracted** or **Offline**.
* A Chrome extension for students that shares a simple attention score from their meeting tab.
* A student page where each student can see exactly what their teacher sees about them.

## Privacy and consent

* **Nothing is monitored until the student agrees.** Joining requires ticking a consent box. If the privacy text changes,
  everyone is asked again.
* **What is shared:** an attention score and state, based on whether the meeting tab is in front, how often the student
  switches tabs, how recently they were active, scrolling, and whether media is playing.
* **What is never collected:** typed text, which keys are pressed, chat messages, page content, camera, microphone,
  screenshots or browsing history.
* **Students stay in control.** They can withdraw consent, leave a class or delete all their data at any time.
  Monitoring stops immediately. Teachers can delete their account, which also removes their classes.
* **Live data is not saved.** It is kept in memory and forgotten about an hour after a student disconnects. Only accounts,
  classes, enrolments and consent records are stored on disk, in the `data/` folder.

## Start the app (teachers)

Pick **one** option. You do not need to use a terminal for either.

**Option 1: the standalone app (nothing to install).** Double-click the file for your computer. If you do not have it, see
[Build the standalone app](#build-the-standalone-app).

| Your computer | Double-click |
| --- | --- |
| Windows | `Attentix-win.exe` |
| macOS | `Attentix-macos` (first time: right-click, then *Open*, because the app is not signed) |
| Linux | `Attentix-linux` (run `chmod +x` on it once) |

**Option 2: the launcher scripts.** These need [Node.js](https://nodejs.org) 20 or newer, installed once.

* **Windows:** double-click `Launch-Silent.vbs` (no window) or `Launch-App.bat` (shows a window).
* **macOS or Linux:** double-click `Launch-App.command`.

The first launch downloads what the app needs, so it needs internet and takes about a minute.

**What happens on every start:**

1. The app creates its own settings (a `.env` file with random secrets) and a `data/` folder next to itself. It never
   overwrites settings you already have. If port 3000 is busy it uses the next free one.
2. Your browser opens by itself: the *create account* page the first time, your dashboard after that.
3. **Settings** shows the address your students need, such as `http://192.168.1.20:3000`, with a **Copy address** button.

**To stop the app:** on the computer that runs it, use **Log out & stop server** (top right) or **Shut down server** (under
**Settings**), or close the app window. Starting the app a second time while it is running just opens the running one.

> **Keep the `data/` and `.env` files.** They hold your classes. Back the `data/` folder up.

## Set up your first class (teachers)

1. **Create your account** on the page that opens: name, email and password. There is no password reset yet, so keep
   your password safe.
2. Press **Create Class** on **Home** or on the **Classes** tab and enter a name (and optionally a section). The app creates a permanent **6-character Class
   Code**. It never changes, so links and extensions that already use it keep working.
3. **Open the class** (click its card) and **give your students the extension.** On the class page press **Download
   Pre-Configured Student Extension** and send them the zip. It already contains your server address and the code. Or press **Copy Class Code** and share the code
   and the server address: students type both into the extension (the address is under *Advanced settings*). A link such as
   `http://192.168.1.20:3000/join?classCode=ABC234` opens the browser join page with the code filled in.
4. **Watch the roster** on the class page; **Back to Classes** returns to the list. **Remove** takes a student out of the class and stops their monitoring at once. **Clear live
   data** wipes the live picture between lessons.

Students must be on the **same network** as your computer, such as the school Wi-Fi. To let students join from **any network, free and with nothing to install**, follow [Run it on the internet for free](docs/deploy-free.md) (Render + Firebase). For other setups see the [self-hosting guide](docs/self-hosting.md).

## Join a class (students)

1. Unzip the file your teacher sent you.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, press **Load unpacked** and choose the unzipped
   folder.
3. Click the extension, type your **full name** and **email**, tick the consent box and press **Join class**.
4. Open your meeting on `meet.google.com` or the Zoom web client. The extension icon shows your live score.

Joining again with the same email and Class Code gives you back the same place in the class. To see what your teacher
sees, or to withdraw consent, press **Open Web Dashboard** in the extension. More help is in the
[extension guide](extension/README.md).

## For developers

You need Node.js 20 or newer.

```bash
npm install
npm start        # creates .env on first run and opens your browser
```

| Command | What it does |
| --- | --- |
| `npm start` | Starts the server. `NO_AUTO_OPEN=true npm start` keeps the browser closed. |
| `npm run dev` | Starts the server and restarts it when you change a file. |
| `npm test` | Runs all tests. They use real HTTP and WebSockets, and never open a browser. |
| `npm run test:unit` | Runs only the unit tests. |
| `npm run test:integration` | Runs only the integration tests. |
| `npm run lint` | Checks `src/`, `public/js/`, `extension/*.js` and `tests/` with ESLint. |
| `npm run audit:prod` | Checks the production dependencies for known problems. |
| `npm run build:exe` | Builds the standalone apps into `dist/`. |

### Project map

```
src/index.js       Starts everything: .env setup, single-instance lock, server, timers, browser
src/app.js         The Express app: security headers, sessions, routes
src/routes/        Educator login, classes, roster, consent, extension join and heartbeat, downloads
src/socket/        Real-time updates (Socket.IO)
src/state/         Live engagement data, kept in memory only
src/config/        Settings and the JSON file store (data/)
src/utils/         Helpers: first-run setup, class codes, validation, extension zip builder
public/            Web pages and their scripts
extension/         The Chrome extension
scripts/           build-exe.js, which builds the standalone apps
tests/             Unit and integration tests
```

### Settings

The **Settings** tab (educators and students) has three sections, all remembered in this browser only:

* **Appearance:** light, dark or match the device, and four colour themes.
* **Accessibility:** text size (80% to 200%), high contrast, reduced motion (both follow the device until you choose), a stronger focus outline and optional keyboard shortcuts (`g` then `h`, `c` or `s`; `/` focuses a search box).
* **General:** confirmation messages, check-in alerts for educators (in the page, or as a desktop notification on https or localhost), the tab to open first, class layout and sort, and data tools: export or import preferences, clear recently opened classes, forget a remembered student sign-in, reset everything.

`public/js/a11y.js` owns the display and accessibility choices (applied before first paint); `public/js/settings.js` builds the page; `AM.prefs` in `common.js` stores the rest. Pages without a Settings tab (sign in, join, privacy) keep a small display toolbar.

### Web pages

| Page | Who | Purpose |
| --- | --- | --- |
| `/login.html` (and `/`) | Teachers | Sign in. |
| `/educator-signup.html` | Teachers | Create an account. |
| `/educator-dashboard.html` | Teachers | Classes, live roster and charts. |
| `/join.html` (and `/join`) | Students | Join a class from the browser. Only the extension shares attention data. |
| `/student.html` | Students | See your own live status, withdraw consent, delete your data. |
| `/privacy.html` | Everyone | Privacy notice, with accept and withdraw choices. |

`/signup.html` is retired and redirects to the pages above.

### Run the tests

```bash
npm test
npm run lint
```

### Build the standalone app

```bash
npm run build:exe              # Windows, macOS and Linux apps in dist/
npm run build:exe -- win       # only one (win, macos or linux; several can be listed)
```

The build bundles Node.js, the server, `public/` and `extension/` into one file per system, using
[`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg). It downloads Node base binaries the first time, so it needs internet. It
can build for all three systems from any one of them.

* The apps are 64-bit (x64) builds, and the macOS app is not code-signed.
* An app keeps `.env` and `data/` **next to itself**, never inside the bundle.
* `PKG_NODE` picks a different Node major version for the base binary (the default is `node22`). `PKG_COMPRESS=GZip` makes a
  smaller file that starts a little slower.

## Troubleshooting

| Problem | What to try |
| --- | --- |
| "Node.js is needed" when using a launcher | Install Node.js 20 or newer from [nodejs.org](https://nodejs.org), or use the standalone app. |
| The first launch fails while installing | Check your internet connection and start it again. `Launch-Silent.vbs` saves details in `install.log`. |
| The browser did not open | Open the address shown in the app window yourself (`http://localhost:3000`). Silent launches write messages to `server.log`. |
| The app will not start | The reason is shown in its window and saved to `error.log` next to the app. |
| Students cannot connect | They must be on the same network. Check the address on the dashboard. Allow the app on *private networks* if your firewall asks. If the dashboard says no network was detected, connect to Wi-Fi and restart the app. |
| The address uses another port | Port 3000 was busy, so the app used the next free one. The dashboard shows the right address. |
| "No class found for that code" | Check the code with your teacher. |
| "Agree to the privacy notice to join" | Tick the consent box. |
| "Chrome needs your permission to contact that server" | Press **Join class** again and choose **Allow**. |
| Forgot your teacher password | There is no reset yet. You can create a new account, but classes belong to the account that created them. |

## Known limitations

* **Chrome 116 or newer only.** Meet and the Zoom **web client** are supported. The Zoom desktop app is not.
* The extension is loaded as an unpacked extension (Developer mode). It is not in the Chrome Web Store.
* Plain `http://` on a classroom network is not encrypted. Use HTTPS for anything beyond one network.
* Teacher sign-up is open to anyone who can reach the server, and there is no password reset or email verification.
* One server process only. Data is stored in JSON files, not a database.
* Scores are a rough signal of engagement, not proof of attention.

## More documentation

* [Self-hosting guide](docs/self-hosting.md): HTTPS, settings (`.env`), Docker, backups and security notes.
* [Extension guide](extension/README.md): installing, permissions, how the score works.
* [Review notes](IMPROVEMENTS.md): the security, privacy and performance review behind this version.
