# Run Attentix on the internet for free

Teacher and students can be on **different networks**. Everything is done in a web browser. Nothing is installed on your
computer. Total time: about 15 minutes.

| Piece | Free service | What it does |
| --- | --- | --- |
| Code | GitHub | Holds your copy of the project |
| Server | Render (free web service) | Runs Attentix at an `https://...onrender.com` address |
| Storage | Firebase Firestore (Spark plan, no card) | Keeps accounts and classes (Render's free disk is wiped on restart) |

> Firebase alone cannot run Attentix: its free plan only hosts static pages, and Attentix needs a live server. So
> Firebase stores the data and Render runs the server.

## 1. Put the project on GitHub

1. Sign up at [github.com](https://github.com) and press **New repository**. Name it `attentix` (Public or Private).
2. Unzip the Attentix zip on your computer.
3. In the new repository press **Add file**, then **Upload files**, and drag in everything **except** `tests/` and
   `node_modules/`.
4. Press **Commit changes**. If GitHub limits the upload to about 100 files, upload in two batches and commit after each.

## 2. Create the database (Firebase)

1. Open [console.firebase.google.com](https://console.firebase.google.com) and press **Add project**. Turn Google
   Analytics off.
2. In the left menu choose **Build**, then **Firestore Database**, then **Create database**. Pick a region near you and
   choose **Production mode**.
3. Press the gear icon, then **Project settings**, then **Service accounts**, then **Generate new private key**. A
   `.json` file downloads.
4. Open that file in a text editor, select all and copy.

> Never share this file or put it on GitHub. It gives full access to your database.

## 3. Deploy on Render

1. Sign up at [render.com](https://render.com) with your GitHub account.
2. Press **New**, then **Blueprint**, choose your `attentix` repository and press **Apply**. (It reads `render.yaml`.)
3. When asked for `FIREBASE_SERVICE_ACCOUNT`, paste the whole JSON you copied, then deploy.
4. Wait until the log says `Storage: Firestore` and the service shows **Live**.
5. Open your `https://attentix-xxxx.onrender.com` address, create your teacher account and a class, then press
   **Download Pre-Configured Student Extension**. It already contains your internet address and class code.

## 4. Students

Send students the downloaded zip. They install it as described in the [extension guide](../extension/README.md). They can
be on any network.

## Good to know

* **Sleeping:** the free server sleeps after 15 minutes without traffic and takes up to a minute to wake. Open the site
  a minute before class, or set a free uptime pinger (such as UptimeRobot) on `https://YOUR-URL/healthz`.
* **After a sleep or restart:** teachers must sign in again. Accounts, classes and consent records stay in Firestore.
  Live scores start empty.
* **Free limits:** Render gives 750 free hours a month (enough for one always-on service). Firestore Spark allows 50,000
  reads and 20,000 writes a day, which is plenty here.
* **Security:** anyone with your link can create a teacher account. See [Security notes](self-hosting.md#6-security-notes).
