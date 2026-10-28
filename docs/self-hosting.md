# Self-hosting guide

For running Attentix for other people over a network, such as a school server or Docker. To run it on your own computer
for one class, the [main README](../README.md) is enough.

**You need:** [Node.js](https://nodejs.org) 20 or newer **or** Docker, and an address your students can reach.

## 1. Network and HTTPS

* On a classroom Wi-Fi the address looks like `http://192.168.1.20:3000`. The dashboard shows it for you.
* **Plain `http://` is not encrypted.** Others on the same network can read passwords, cookies, names, emails and
  attention data. That is acceptable inside one classroom network, not beyond it.
* The extension therefore accepts plain `http://` **only** for `localhost`, private addresses (`192.168.x.x`, `10.x.x.x`,
  `172.16-31.x.x`, `169.254.x.x`) and `.local` names. Every other address must start with `https://`.
* For a public or school-wide server, put an HTTPS reverse proxy (Caddy, nginx or Traefik) in front of the app.

### Example: Caddy

Caddy gets and renews the certificate for you. The whole configuration:

```
attention.your-school.edu {
  reverse_proxy 127.0.0.1:3000
}
```

Then set these in `.env`:

```
CORS_ORIGIN=https://attention.your-school.edu
PUBLIC_URL=https://attention.your-school.edu
COOKIE_SECURE=true
TRUST_PROXY=1
```

Make the app listen on the local machine only, so nobody can bypass the proxy. With Docker, change the port line in
`docker-compose.yml` to `"127.0.0.1:3000:3000"`.

## 2. Settings (`.env`)

Settings live in a `.env` file next to the app.

* **Normal start** (`npm start`, launchers, standalone app) creates `.env` with fresh random secrets and never
  overwrites values you set.
* **Docker** does not create it. Run `cp .env.example .env` yourself.
* **Never share or commit `.env`.** It holds the secrets that sign logins and student tokens.

| Variable | What it does |
| --- | --- |
| `NODE_ENV` | `production` turns on strict checks. Docker sets it for you. |
| `SESSION_SECRET` | **Required in production**, 32+ characters. The server refuses to start without it. Create one with `openssl rand -hex 32`. |
| `EXTENSION_TOKEN_SECRET` | Optional, 32+ characters in production. Signs students' extension tokens separately, so changing `SESSION_SECRET` does not sign students out. Created automatically on first start. |
| `CORS_ORIGIN` | Public address of the app (several allowed, comma-separated). Also checks WebSocket origins. |
| `PUBLIC_URL` | Address students should use when you serve through a domain. Replaces the detected network address in the dashboard and pre-configured extension. |
| `COOKIE_SECURE` | `true` on https (default in production). Use `false` only for plain-http testing or a trusted LAN. |
| `TRUST_PROXY` | Number of reverse proxies in front of the app (for example `1` behind Caddy). Leave unset if none. |
| `SESSION_IDLE_HOURS` | Hours of inactivity before a teacher is signed out. Default `8`. |
| `PORT` | Port to listen on. If unset, the app picks the first free port from 3000. |
| `DATA_DIR` | Where data files are kept. Default `./data`. |
| `FIREBASE_SERVICE_ACCOUNT` | Store accounts and classes in Firestore instead of `data/`. See [deploy-free.md](deploy-free.md). |
| `AUTO_ENV` | `false` turns off automatic `.env` creation and the free-port search. Docker sets it. |
| `NO_AUTO_OPEN` | `true` stops the app from opening your browser. It never opens one during tests. |

**Changing a secret:** a new `SESSION_SECRET` signs every teacher out. A new `EXTENSION_TOKEN_SECRET` signs every
student's extension out, and they must join again.

## 3. Run with Node.js

```bash
unzip attentix.zip && cd attentix
npm ci --omit=dev
NO_AUTO_OPEN=true npm start
```

The first start writes `.env`. Edit it (`NODE_ENV=production`, `COOKIE_SECURE=true`, `CORS_ORIGIN`, `PUBLIC_URL`) and
restart. Use a process manager such as systemd or pm2 to keep it running.

## 4. Run with Docker

```bash
cp .env.example .env                           # then set SESSION_SECRET, CORS_ORIGIN and PUBLIC_URL
mkdir -p data && sudo chown -R 1000:1000 data  # the container runs as user 1000 and writes only here
docker compose up -d --build
docker compose ps                              # STATUS becomes "healthy" once the app answers
docker compose logs -f                         # watch the logs
```

* The container runs as a non-root user with a read-only filesystem, no Linux capabilities and `no-new-privileges`.
  Only `data/` is writable.
* Docker sets `NODE_ENV=production`, so the app will not start until `.env` has a strong `SESSION_SECRET`.
* `.env` is not copied into the image. It is read when the container starts.
* `.env.example` ships with `COOKIE_SECURE=false`. Keep that only for plain `http://` on a trusted LAN. Behind HTTPS,
  set it to `true`.

## 5. Data, backups and updates

* Everything that must survive is in **`data/`**: `users.json`, `classes.json`, `enrollments.json`, `consents.json`
  (owner-only permissions). **Back this folder up.**
* **Live attention data is never written to disk.** It stays in memory and is forgotten about an hour after a student
  disconnects.
* Teacher logins are kept in memory, so teachers sign in again after a restart. Students stay joined: their tokens last
  12 hours and survive a restart.
* **To update:** replace the code, keep `data/` and `.env`, then run `docker compose up -d --build` (or restart
  `npm start`).

## 6. Security notes

* **Teacher sign-up is open.** Anyone who can reach the server can create a teacher account, but a teacher only sees the
  classes they created. To keep strangers out, keep the server on your school network or VPN, or block
  `/educator-signup.html` in your reverse proxy.
* **No password reset or email verification.** Keep teacher passwords safe.
* **"Shut down server"** only works for a request from the same computer with no proxy in between, so it is never
  offered in Docker or behind a proxy.
* **One process only.** Data files and live state belong to a single Node process. To run several copies, first move to a
  real database and a shared session store.
* Run `npm run audit:prod` now and then to check production dependencies.
