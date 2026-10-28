const { createFirestoreStore, parseServiceAccount, diffRows } = require('../../src/config/firestoreStore');
const bootstrap = require('../../src/utils/bootstrap');

// A tiny in-memory stand-in for the parts of Firestore the store uses.
const fakeFirestore = () => {
  const data = new Map(); // "collection/id" -> fields
  const batches = [];
  return {
    data,
    batches,
    collection: (name) => ({
      doc: (id) => ({ path: `${name}/${id}` }),
      limit: () => ({ get: async () => ({ docs: [] }) }),
      get: async () => ({
        docs: [...data.entries()].filter(([k]) => k.startsWith(`${name}/`)).map(([k, v]) => ({ id: k.split('/')[1], data: () => { const { id, ...rest } = v; return rest; } }))
      })
    }),
    batch: () => {
      const ops = [];
      const b = {
        set: (ref, row) => { ops.push(['set', ref.path, row]); },
        delete: (ref) => { ops.push(['delete', ref.path]); },
        commit: async () => {
          batches.push(ops.length);
          ops.forEach(([type, path, row]) => (type === 'set' ? data.set(path, row) : data.delete(path)));
        }
      };
      return b;
    }
  };
};

describe('firestore store', () => {
  test('writes only changed rows and deletes removed ones', async () => {
    const fs = fakeFirestore();
    const store = createFirestoreStore({ firestore: fs });
    const a = { id: 'a', createdAt: 1, name: 'A' };
    const b = { id: 'b', createdAt: 2, name: 'B' };
    await store.write('classes', [], [a, b]);
    expect(fs.data.size).toBe(2);

    const a2 = { ...a, name: 'A2' };
    await store.write('classes', [a, b], [a2]);
    expect(fs.data.get('attentix_classes/a').name).toBe('A2');
    expect(fs.data.has('attentix_classes/b')).toBe(false);
    expect(fs.batches).toEqual([2, 2]); // 2 sets, then 1 set + 1 delete
  });

  test('reads rows back in creation order with their ids', async () => {
    const fs = fakeFirestore();
    const store = createFirestoreStore({ firestore: fs });
    await store.write('users', [], [{ id: 'z', createdAt: 5 }, { id: 'y', createdAt: 1 }]);
    expect((await store.read('users')).map((r) => r.id)).toEqual(['y', 'z']);
  });

  test('splits very large writes into several batches', async () => {
    const fs = fakeFirestore();
    const store = createFirestoreStore({ firestore: fs });
    const rows = Array.from({ length: 950 }, (_, i) => ({ id: `r${i}`, createdAt: i }));
    await store.write('consents', [], rows);
    expect(fs.batches).toEqual([400, 400, 150]);
  });

  test('diffRows rejects rows without an id', () => {
    expect(() => diffRows([], [{ name: 'x' }])).toThrow(/id/);
  });

  test('parseServiceAccount accepts JSON or base64 and rejects junk', () => {
    const json = JSON.stringify({ project_id: 'p', client_email: 'e', private_key: 'k' });
    expect(parseServiceAccount(json).project_id).toBe('p');
    expect(parseServiceAccount(Buffer.from(json).toString('base64')).project_id).toBe('p');
    expect(() => parseServiceAccount('not json')).toThrow(/FIREBASE_SERVICE_ACCOUNT/);
  });
});

describe('applyHostedDefaults', () => {
  test('fills the public address from Render without overriding the owner', () => {
    const env = { RENDER_EXTERNAL_URL: 'https://attentix.onrender.com' };
    expect(bootstrap.applyHostedDefaults(env).sort()).toEqual(['CORS_ORIGIN', 'PUBLIC_URL', 'TRUST_PROXY']);
    expect(env.PUBLIC_URL).toBe('https://attentix.onrender.com');
    expect(env.TRUST_PROXY).toBe('1');

    const own = { RENDER_EXTERNAL_URL: 'https://x.onrender.com', PUBLIC_URL: 'https://school.edu' };
    bootstrap.applyHostedDefaults(own);
    expect(own.PUBLIC_URL).toBe('https://school.edu');
  });

  test('does nothing outside Render', () => {
    const env = {};
    expect(bootstrap.applyHostedDefaults(env)).toEqual([]);
    expect(env).toEqual({});
  });
});
