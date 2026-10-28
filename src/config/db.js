const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const settings = require('./settings');
const { createFirestoreStore } = require('./firestoreStore');

const collections = ['users', 'classes', 'enrollments', 'consents'];

// Student names, password hashes and consent records live in these files: owner-only permissions.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const filePathFor = (collection) => path.join(settings.dataDir, `${collection}.json`);

// ---- in-memory cache ----
// Each collection loads from disk once, is served from memory and is saved on every change. readData()/findById()
// return immutable snapshots. mutate() edits a private copy and swaps it in only after the write succeeds, so memory
// never gets ahead of disk. Assumes ONE server process owns the data.
const cache = new Map();

// null = JSON files in settings.dataDir; otherwise a remote store (see firestoreStore.js).
let remote = null;

const initDb = async () => {
  try {
    await fs.mkdir(settings.dataDir, { recursive: true, mode: DIR_MODE });
    cache.clear();
    remote = null;

    if (settings.firebaseServiceAccount) {
      remote = createFirestoreStore({ serviceAccount: settings.firebaseServiceAccount });
      await remote.ping();
      console.log('Storage: Firestore (data survives restarts).');
    } else {
      console.log(`Storage: local files in ${settings.dataDir}. On hosts with a temporary disk, set FIREBASE_SERVICE_ACCOUNT to keep data.`);
    }

    for (const collection of collections) {
      if (!remote) {
        const filePath = filePathFor(collection);
        try {
          await fs.access(filePath);
        } catch {
          await fs.writeFile(filePath, JSON.stringify([]), { mode: FILE_MODE });
        }
      }
      // Fail at startup (not on the first request) if a file is corrupt or the remote store is unreachable.
      cache.set(collection, await readFromDisk(collection));
    }
  } catch (err) {
    console.error('Database initialization failed:', err);
    process.exit(1);
  }
};

// Serialises every operation on a collection so read-modify-write cycles cannot interleave.
const queues = new Map();
const withLock = (collection, task) => {
  const previous = queues.get(collection) || Promise.resolve();
  const run = previous.then(task);
  queues.set(collection, run.catch(() => {})); // a failed task must not poison the queue
  return run;
};

async function readFromDisk(collection) {
  if (remote) return remote.read(collection);
  let raw;
  try {
    raw = await fs.readFile(filePathFor(collection), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Never fall back to [] here: the next write would silently destroy the corrupt-but-recoverable file.
    throw new Error(`Collection "${collection}" contains invalid JSON: ${err.message}`);
  }
}

// Write to a temp file, then rename: readers never see a half-written file and a crash cannot truncate data.
const writeFileAtomic = async (collection, data, previous) => {
  if (remote) return remote.write(collection, previous || [], data);
  const target = filePathFor(collection);
  const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: FILE_MODE });
  await fs.rename(tmp, target);
};

// ---- write invariants ----
// A class's `id` and `classCode` are permanent (students bookmark links, extensions store the code). Enforced here, not
// only in the routes, so no code path can change them. A class created before codes existed may be given one once.
const invariantError = (message, status = 409) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

const assertClassIdentityImmutable = (previous, next) => {
  const nextById = new Map(next.map((c) => [c.id, c]));
  const nextCodes = new Set(next.map((c) => c.classCode).filter(Boolean));
  const seen = new Set();

  for (const klass of next) {
    if (!klass.classCode) continue;
    if (seen.has(klass.classCode)) throw invariantError('Class code collision');
    seen.add(klass.classCode);
  }

  for (const before of previous) {
    const after = nextById.get(before.id);
    if (!after) {
      // Gone is fine (class deleted). Gone while its code lives on under another id means the id was rewritten.
      if (before.classCode && nextCodes.has(before.classCode)) throw invariantError('A class id is permanent and cannot be changed');
      continue;
    }
    if (before.classCode && after.classCode !== before.classCode) {
      throw invariantError('A class code is permanent and cannot be changed');
    }
  }
};

const invariants = { classes: assertClassIdentityImmutable };
const checkInvariants = (collection, previous, next) => {
  if (invariants[collection]) invariants[collection](previous, next);
};

const load = async (collection) => {
  if (!cache.has(collection)) cache.set(collection, await readFromDisk(collection));
  return cache.get(collection);
};

const readData = (collection) => withLock(collection, () => load(collection));

// Replaces a whole collection. Prefer mutate()/insertUnique() for anything that reads then writes.
const writeData = (collection, data) =>
  withLock(collection, async () => {
    const next = JSON.parse(JSON.stringify(data));
    checkInvariants(collection, await load(collection), next);
    await writeFileAtomic(collection, next, await load(collection));
    cache.set(collection, next);
  });

// Atomic read-modify-write. `fn` receives a private copy of the array, mutates it in place and may return a value.
// If `fn` throws (or the write fails), nothing changes - on disk or in memory.
const mutate = (collection, fn) =>
  withLock(collection, async () => {
    const current = await load(collection);
    const draft = JSON.parse(JSON.stringify(current));
    const result = await fn(draft);
    checkInvariants(collection, current, draft);
    await writeFileAtomic(collection, draft, current);
    cache.set(collection, draft);
    return result;
  });

/** Removes, in place, every row matching `predicate` from a draft array handed out by mutate(). Returns how many went. */
const removeWhere = (rows, predicate) => {
  let removed = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (predicate(rows[i])) { rows.splice(i, 1); removed += 1; }
  }
  return removed;
};

const findById = async (collection, id) => {
  const data = await readData(collection);
  return data.find((item) => item.id === id);
};

// Server-generated fields come LAST so a caller-supplied object can never override `id` or `createdAt`.
const stamp = (item) => ({ ...item, id: crypto.randomUUID(), createdAt: Date.now() });

const insert = (collection, item) =>
  mutate(collection, (data) => {
    const newItem = stamp(item);
    data.push(newItem);
    return newItem;
  });

// Insert only if no existing row matches `isDuplicate`; otherwise throws an Error with status 409.
const insertUnique = (collection, item, isDuplicate, conflictMessage) =>
  mutate(collection, (data) => {
    if (data.some(isDuplicate)) throw invariantError(conflictMessage);
    const newItem = stamp(item);
    data.push(newItem);
    return newItem;
  });

// Atomic find-or-create. `update(row)` mutates the matching row in place; `create()` returns the fields of a new row.
// Resolves to { item, created } where `item` is a copy (the cached row itself is never handed out).
const upsert = (collection, isMatch, { update, create }) =>
  mutate(collection, (data) => {
    const existing = data.find(isMatch);
    if (existing) {
      if (update) update(existing);
      return { item: { ...existing }, created: false };
    }
    const item = stamp(create());
    data.push(item);
    return { item: { ...item }, created: true };
  });

module.exports = {
  initDb,
  readData,
  writeData,
  mutate,
  removeWhere,
  findById,
  insert,
  insertUnique,
  upsert
};
