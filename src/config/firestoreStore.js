'use strict';

/**
 * Optional persistent storage in Google Firestore (free Spark plan, no credit card).
 *
 * Why: free web hosts (Render, etc.) wipe the local disk on every restart, which would delete every account and class
 * kept in data/*.json. When FIREBASE_SERVICE_ACCOUNT is set, db.js keeps the same in-memory cache and the same API, but
 * persists to Firestore instead of files: one Firestore collection per data collection, one document per row (the
 * row's `id` is the document id). Only the rows that changed are written.
 */

const MAX_BATCH = 400; // Firestore allows 500 operations per batch; stay well under.

/** Accepts the service-account JSON as-is, or base64 of it (easier to paste into some dashboards). */
const parseServiceAccount = (raw) => {
  const text = String(raw || '').trim();
  if (!text) return null;
  const attempts = [text, () => Buffer.from(text, 'base64').toString('utf8')];
  for (const attempt of attempts) {
    try {
      const value = JSON.parse(typeof attempt === 'function' ? attempt() : attempt);
      if (value && typeof value === 'object') return value;
    } catch { /* try the next form */ }
  }
  throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON (paste the whole service-account file, or its base64).');
};

const rowId = (row) => {
  if (!row || typeof row.id !== 'string' || !row.id) throw new Error('Every stored row needs a string id');
  return row.id;
};

/** Which rows to write and which documents to delete to turn `previous` into `next`. Pure, so it is unit-tested. */
const diffRows = (previous, next) => {
  const before = new Map(previous.map((row) => [rowId(row), JSON.stringify(row)]));
  const seen = new Set();
  const upserts = [];
  for (const row of next) {
    const id = rowId(row);
    seen.add(id);
    if (before.get(id) !== JSON.stringify(row)) upserts.push(row);
  }
  const deletes = [...before.keys()].filter((id) => !seen.has(id));
  return { upserts, deletes };
};

const byCreation = (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id));

/**
 * `firestore` is injectable for tests; production builds it from the service account.
 * Returns { read(collection) -> rows, write(collection, previousRows, nextRows) }.
 */
const createFirestoreStore = ({ serviceAccount, prefix = 'attentix', firestore } = {}) => {
  let db = firestore;
  if (!db) {
    // Loaded lazily so the standalone app and the tests never pay for (or need) the Google client.
    const { Firestore } = require('@google-cloud/firestore');
    const credentials = parseServiceAccount(serviceAccount);
    db = new Firestore({
      projectId: credentials.project_id,
      credentials: { client_email: credentials.client_email, private_key: credentials.private_key },
      ignoreUndefinedProperties: true
    });
  }
  const name = (collection) => `${prefix}_${collection}`;

  return {
    kind: 'firestore',

    async read(collection) {
      const snapshot = await db.collection(name(collection)).get();
      return snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id })).sort(byCreation);
    },

    async write(collection, previous, next) {
      const { upserts, deletes } = diffRows(previous, next);
      const ref = db.collection(name(collection));
      const ops = [
        ...upserts.map((row) => ({ type: 'set', id: row.id, row })),
        ...deletes.map((id) => ({ type: 'delete', id }))
      ];
      for (let i = 0; i < ops.length; i += MAX_BATCH) {
        const batch = db.batch();
        for (const op of ops.slice(i, i + MAX_BATCH)) {
          if (op.type === 'set') batch.set(ref.doc(op.id), JSON.parse(JSON.stringify(op.row)));
          else batch.delete(ref.doc(op.id));
        }
        await batch.commit();
      }
    },

    /** Cheap round trip used at start-up so a wrong key fails with a clear message, not on the first login. */
    async ping() {
      await db.collection(name('users')).limit(1).get();
    }
  };
};

module.exports = { createFirestoreStore, parseServiceAccount, diffRows };
