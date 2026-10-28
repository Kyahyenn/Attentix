# Run Attentix on the internet for free (no installs)

Teacher and students can be on **different networks**. Everything is done in a web browser: nothing to install on your computer.

| Piece | Free service | What it does |
| --- | --- | --- |
| Code | GitHub | Holds your copy of the project |
| Server | Render (free web service) | Runs Attentix 24/7 at an `https://...onrender.com` address |
| Storage | Firebase Firestore (Spark plan, no card) | Keeps accounts and classes, because Render's free disk is wiped on restart |

> Firebase alone can't run Attentix: its free plan hosts only static pages, and Attentix needs a live server (Socket.IO). So Firebase is used for storage and Render for the server.

## 1. Put the project on GitHub (about 3 minutes)
1. Sign up at github.com, then **New repository** (name it `attentix`, Public or Private).
2. Unzip `attentix.zip` on your computer. In the repo press **Add file -> Upload files** and drag in everything **except** the `tests/` and `node_modules/` folders (they are not needed). GitHub accepts about 100 files per upload, so do it in two batches if asked, pressing **Commit changes** after each.

## 2. Create the free database (Firebase, about 3 minutes)
1. console.firebase.google.com -> **Add project** (turn Google Analytics off).
2. Left menu **Build -> Firestore Database -> Create database**. Pick a region near you (e.g. Singapore), **Production mode**.
3. **Project settings (gear) -> Service accounts -> Generate new private key**. A `.json` file downloads. Open it in any text editor, select all, copy. (This one file is the only download. Don't share it or put it on GitHub.)

## 3. Deploy on Render (about 5 minutes)
1. Sign up at render.com with your GitHub account.
2. **New -> Blueprint**, choose your `attentix` repo, press **Apply**. (It reads `render.yaml`.)
3. When asked for `FIREBASE_SERVICE_ACCOUNT`, paste the whole JSON you copied. Deploy.
4. When the log says "Storage: Firestore" and the service is **Live**, open the `https://attentix-xxxx.onrender.com` address. Create your teacher account, create a class, and press **Download Pre-Configured Student Extension**. It already contains your internet address and class code.

## 4. Students
They need the Chrome extension (the only thing that can read their meeting tab): unzip, `chrome://extensions` -> Developer mode -> Load unpacked. They can be on any network.

## Good to know
* **Sleeping:** Render's free service sleeps after 15 minutes with no traffic and takes up to about a minute to wake. Active extensions keep it awake during class. To avoid a slow first load, open the site a minute before class, or add a free uptime pinger (e.g. UptimeRobot) on `https://YOUR-URL/healthz`.
* **After a sleep or restart** teachers sign in again (logins live in memory). Accounts, classes and consents stay in Firestore. Live scores restart empty.
* **Free limits:** Render gives 750 free hours/month (enough for one always-on service). Firestore Spark gives 50k reads / 20k writes per day, plenty here.
* Anyone with your link can create a teacher account (see the security notes in `self-hosting.md`).
