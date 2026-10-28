# Self-hosting guide

This guide is for running Attentix for other people over a network, for example on a school server or in
Docker. If you only want to run it on your own computer for one class, the [main README](../README.md) is enough.

You run the server and your students connect to it. There is no central service.

**You need:** [Node.js](https://nodejs.org) 20 or newer, **or** Docker, and an address your students can reach.

## 1. Network and HTTPS

* Students must be able to reach your server over the network. On a classroom Wi-Fi the address looks like
  `http://192.168.1.20:3000`. The dashboard shows it for you.
* **Plain `http://` is not encrypted.** Educator passwords, session cookies, student names and emails, and attention
  data can be read by others on the same network. This is acceptable inside one classroom network, but not beyond it.
* The extension therefore accepts plain `http://` **only** for `localhost`, private addresses (`192.168.x.x`, `10.x.x.x`,
  `172.16-31.x.x`, `169.254.x.x`) and `.local` names. Every other server address must start with `https://`.
* For a public or school-wide server, put an HTTPS reverse proxy (Caddy, nginx or Traefik) in front of the app.

### Example: Caddy

Caddy gets and renews the certificate for you. This is the whole configuration:

```
attention.your-school.edu {
  reverse_proxy 127.0.0.1:3000
}
```

Then, in `.env`:

```
CORS_ORIGIN=https://attention.your-school.edu
PUBLIC_URL=https://attention.your-school.edu
COOKIE_SECURE=true
TRUST_PROXY=1
```

Make the app listen on the local machine only, so nobody can bypass the proxy. With Docker, change the port line in
`docker-compose.yml` to `"127.0.0.1:3000:3000"`.

## 2. Configuration (`.env`)

Settings live in a `.env` file next to the app.

* **Starting the app normally** (`npm start`, the launchers or the standalone app) creates `.env` for you, with fresh
  random secrets. It never overwrites values you already set, so you can edit it later.
* **Docker** does not create it. Copy the template yourself: `cp .env.example .env`.
* **Never share or commit `.env`.** It holds the secrets that sign logins and student tokens.

| Variable | What it does |
| --- | --- |
| `NODE_ENV` | `production` turns on the strict checks below. Docker sets it for you. |
| `SESSION_SECRET` | **Required in production**, at least 32 characters. The server refuses to start without it. Create one with `openssl rand -hex 32`. |
| `EXTENSION_TOKEN_SECRET` | Optional, at least 32 characters in production. Signs the students' extension tokens separately, so changing `SESSION_SECRET` does not sign students out. Created automatically on first start. If unset, `SESSION_SECRET` is used. |
| `CORS_ORIGIN` | The public address of the app. Several addresses can be separated by commas. Also used to check WebSocket origins. |
| `PUBLIC_URL` | Optional. The address students should use when you serve through a domain. The pre-configured extension and the dashboard show it instead of the detected network address. |
| `COOKIE_SECURE` | `true` on https (the default in production). Set `false` only for plain-http testing or a trusted LAN. |
| `TRUST_PROXY` | How many reverse proxies are in front of the app (for example `1` behind Caddy). Leave unset if none. |
| `SESSION_IDLE_HOURS` | Hours of inactivity before an educator is signed out. Default `8`. |
| `PORT` | The port to listen on. If you do not set it, the app picks the first free port from 3000. A value you set is always used. |
| `DATA_DIR` | Where the data files are kept. Default `./data`, relative to the app (or executable) folder. |
| `AUTO_ENV` | `false` turns off the automatic `.env` creation and the free-port search. Docker sets it for you. |
| `NO_AUTO_OPEN` | `true` stops the app from opening your browser at start. It never opens one while tests run. |

**Changing a secret:** a new `SESSION_SECRET` signs every educator out. A new `EXTENSION_TOKEN_SECRET` signs every
student's extension out, and they must join again.

## 3. Run with Node.js

```bash
unzip attentix.zip && cd attentix
npm ci --omit=dev
NO_AUTO_OPEN=true npm start
```

On the first start the app writes `.env`. Edit it as described above (`NODE_ENV=production`, `COOKIE_SECURE=true`,
`CORS_ORIGIN`, `PUBLIC_URL`) and restart. Use a process manager such as systemd or pm2 to keep it running.

## 4. Run with Docker

```bash
cp .env.example .env                          # then set SESSION_SECRET, CORS_ORIGIN and PUBLIC_URL
mkdir -p data && sudo chown -R 1000:1000 data # the container runs as user 1000 and writes only here
docker compose up -d --build
docker compose ps                             # STATUS becomes "healthy" once the app answers /healthz
docker compose logs -f                        # watch the logs
```

* The container runs as a non-root user with a read-only filesystem, no Linux capabilities and `no-new-privileges`.
  Only `data/` is writable.
* Docker sets `NODE_ENV=production`, so the app refuses to start until `.env` has a strong `SESSION_SECRET`.
* `.env` is not copied into the image (see `.dockerignore`). It is read when the container starts.
* The example `.env.example` ships with `COOKIE_SECURE=false`. Keep that only for plain `http://` on a trusted LAN.
  Behind HTTPS, set it to `true`.

## 5. Your data, backups and updates

* Everything that must survive is in the **`data/`** folder: `users.json`, `classes.json`, `enrollments.json` and
  `consents.json`. The files are readable only by their owner (`0600`). **Back this folder up.**
* **Live attention data is never written to disk.** It is kept in memory and forgotten about an hour after a student
  disconnects.
* Educator logins are also kept in memory, so after the server restarts educators sign in again. Students stay joined,
  because their extension tokens last 12 hours and survive a restart.
* To update: replace the code, keep `data/` and `.env`, then run `docker compose up -d --build` (or restart `npm start`).

## 6. Security notes

* **Educator sign-up is open.** Anyone who can reach your server can create an educator account. An educator only ever
  sees the classes they created. If you do not want strangers to register, keep the server on your school network or
  VPN, or block `/educator-signup.html` in your reverse proxy.
* **There is no password reset or email verification.** Keep educator passwords safe.
* **The "Shut down server" button** only works for a request coming from the same computer, with no proxy in between.
  It is therefore never offered in Docker or behind a reverse proxy.
* **One process only.** The data files and live state live in a single Node process. To run several copies, first move to
  a real database and a shared session store.
* Run `npm run audit:prod` now and then to check the production dependencies for known problems.
