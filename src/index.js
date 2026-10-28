#!/usr/bin/env node
const fs = require('fs');
const http = require('http');
const path = require('path');
// Must stay free of ./config/settings: the environment file has to exist (and be loaded) before settings is required.
const bootstrap = require('./utils/bootstrap');

// An uncaught throw inside a socket handler must not take the whole classroom session down without a log line.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// A double-clicked executable runs in a console window that vanishes the moment the process exits, so a startup error
// would look like "it just doesn't open". Write it next to the app and keep the window up until a key is pressed.
const fatal = (message, err) => {
  console.error(message, err || '');
  try {
    const { baseDir } = bootstrap.resolvePaths();
    fs.appendFileSync(path.join(baseDir, 'error.log'), `${new Date().toISOString()} ${message} ${err && err.stack ? err.stack : err || ''}\n`);
  } catch { /* read-only location: the console message above is all there is */ }
  const finish = () => process.exit(1);
  if (bootstrap.isPackaged() && process.stdin.isTTY) {
    console.error('\nThe error was also saved to error.log next to the app. Press Enter to close this window.');
    process.stdin.once('data', finish);
    process.stdin.resume();
  } else finish();
};
process.on('uncaughtException', (err) => fatal('Uncaught exception, shutting down:', err));

const listenOnce = (server, port) => new Promise((resolve, reject) => {
  const onError = (err) => { server.off('listening', onListening); reject(err); };
  const onListening = () => { server.off('error', onError); resolve(port); };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port);
});

// With zero-config on (the default outside Docker) a busy port moves the server to the next free one instead of failing.
const listenWithFallback = async (server, firstPort, { fallback }) => {
  for (let port = firstPort; port < firstPort + (fallback ? 20 : 1); port += 1) {
    try {
      return await listenOnce(server, port);
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || !fallback) throw err;
    }
  }
  throw new Error(`Ports ${firstPort}-${firstPort + 19} are all in use`);
};

/** Creates / completes .env (random secrets, free port, data/) without overwriting real values, then loads it. */
const prepareEnvironment = async (paths) => {
  try {
    const result = await bootstrap.ensureEnv({ paths });
    if (result.created) console.log(`Created ${result.envFile} with fresh random secrets.`);
    else if (result.updated.length) console.log(`Completed ${result.envFile}: added ${result.updated.join(', ')}.`);
  } catch (err) {
    console.warn(`Could not prepare ${paths.envFile}: ${err.message}`);
  }
  require('dotenv').config({ path: paths.envFile });
};

/**
 * One server per data directory (the JSON store assumes a single owner). Checked BEFORE the heavy modules load, so a
 * second double-click does not spend seconds loading the app only to open the browser at a server that is not listening yet.
 * If another instance is running and answers, this opens it in the browser and exits the process; a lock left by a crashed
 * server is taken over. Resolves to the held lock.
 */
const acquireServerLock = async (paths) => {
  const dataDir = bootstrap.resolveDataDir(paths);
  const lockFile = path.join(dataDir, '.server.lock');
  const tryAcquire = () => bootstrap.acquireInstanceLock({ lockFile, port: Number(process.env.PORT) || 3000 });

  let lock = await tryAcquire();
  if (lock.acquired) return lock;

  console.log(`Attentix is already running (process ${lock.existing.pid}). Opening it in your browser...`);
  const port = await bootstrap.waitForRunningServer({
    lockFile, existing: lock.existing, onWait: () => console.log('Waiting for it to finish starting (this can take a while the first time)...')
  });
  if (port) {
    const url = bootstrap.startUrl({ port, hasEducator: bootstrap.hasEducatorOnDisk(dataDir) });
    console.log(`  ${url}`);
    await bootstrap.openBrowserAndWait(url);
    process.exit(0);
  }

  // Nothing answered: the lock belongs to a server that crashed or was killed. Take over.
  console.log('The previous run did not shut down cleanly. Starting fresh.');
  try { fs.unlinkSync(lockFile); } catch { /* already gone */ }
  lock = await tryAcquire();
  if (!lock.acquired) throw new Error('Could not take the server lock');
  return lock;
};

/** Starts the periodic jobs (none keeps the process alive). Returns a function that stops them. */
const startBackgroundJobs = ({ io, sockets, settings, memoryState, engagement }) => {
  const timers = [
    // socket.io is the source of truth for which sockets are alive.
    setInterval(() => memoryState.cleanupStaleConnections((socketId) => io.sockets.sockets.has(socketId)), settings.cleanupIntervalMs),
    setInterval(() => { sockets.refreshEducatorViews(); engagement.prune(); }, 3000),
    // Safety net: even if a route forgot to disconnect someone, a student whose consent / enrolment / account is gone
    // is dropped within a minute.
    setInterval(() => { sockets.revalidate(); }, settings.revalidateIntervalMs)
  ];
  timers.forEach((timer) => timer.unref());
  return () => timers.forEach(clearInterval);
};

/** Graceful shutdown on signals and from the dashboard's "Shut Down Server" button; always frees the instance lock. */
const installShutdown = ({ app, io, server, lock, stopJobs }) => {
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down gracefully`);
    stopJobs();
    lock.release();
    io.close(() => process.exit(0)); // also closes the HTTP server
    // Browsers keep idle connections open, which would hold the process up: cut them, and never linger more than 2 s.
    setTimeout(() => { if (server.closeAllConnections) server.closeAllConnections(); }, 300).unref();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  // POST /api/server/shutdown lands here. Only this file installs it, so tests (which never run index.js) cannot stop anything.
  app.locals.requestShutdown = (source) => shutdown(`Shutdown requested from the ${source}`);
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // Closing the console window of a double-clicked app (Windows: SIGHUP / SIGBREAK) must free the lock too.
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
};

const startServer = async () => {
  console.log('Starting Attentix... your browser opens by itself when it is ready.');

  // 1. Environment first, 2. then the single-instance lock.
  const paths = bootstrap.resolvePaths();
  const zeroConfig = process.env.AUTO_ENV !== 'false';
  await prepareEnvironment(paths);
  const lock = await acquireServerLock(paths);
  process.on('exit', lock.release);

  // 3. Now load the app (settings reads the environment when it is first required).
  const { app, sessionMiddleware } = require('./app');
  const settings = require('./config/settings');
  const db = require('./config/db');
  const createIo = require('./socket/createIo');
  const socketHandler = require('./socket/socketHandler');
  const memoryState = require('./state/memoryState');
  const engagement = require('./state/engagementState');

  await db.initDb();

  const server = http.createServer(app);
  // Slow-client protections (slowloris): bound how long a request may take to arrive.
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;

  const io = createIo(server);
  // Share the Express session with Socket.IO to authenticate real-time connections.
  io.engine.use(sessionMiddleware);
  const sockets = socketHandler(io);
  // Lets REST routes (logout, consent withdrawal, account deletion...) cut live sockets immediately.
  app.locals.realtime = sockets;

  const stopJobs = startBackgroundJobs({ io, sockets, settings, memoryState, engagement });
  installShutdown({ app, io, server, lock, stopJobs });

  const port = await listenWithFallback(server, Number(settings.port), { fallback: zeroConfig });
  if (port !== Number(settings.port)) console.log(`Port ${settings.port} was busy, using ${port} instead.`);
  settings.port = port;
  process.env.PORT = String(port);
  lock.update(port);

  const info = bootstrap.getServerInfo({ port });
  console.log(`Attentix server running in ${settings.nodeEnv} mode on port ${port}`);
  console.log(`  On this computer : ${info.localUrl}`);
  if (info.publicUrl) console.log(`  Public address   : ${info.publicUrl}`);
  info.lanUrls.forEach((url) => console.log(`  For students (LAN): ${url}`));
  if (!info.hasLan && !info.publicUrl) console.log('  No network connection detected: only this computer can reach the server.');

  // 4. Open the professor's browser: sign-up on the very first run, the dashboard afterwards.
  const hasEducator = (await db.readData('users')).some((u) => u.role === 'educator');
  bootstrap.openBrowser(bootstrap.startUrl({ port, hasEducator }));
};

startServer().catch((err) => fatal('Failed to start server:', err));
