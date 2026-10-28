const { issueToken, issueStudentToken, verifyToken, verifyTokenClaims, TOKEN_TTL_MS } = require('../../src/utils/extensionToken');

describe('extension bearer token', () => {
  test('round-trips a user id', () => {
    expect(verifyToken(issueToken('user-123'))).toBe('user-123');
  });

  test('expires after the TTL', () => {
    const now = 1_000_000;
    const token = issueToken('user-123', now);
    expect(verifyToken(token, now + TOKEN_TTL_MS - 1)).toBe('user-123');
    expect(verifyToken(token, now + TOKEN_TTL_MS)).toBeNull();
  });

  test('rejects tampered payloads, tampered signatures and garbage', () => {
    const [body, sig] = issueToken('user-123').split('.');
    const forgedBody = Buffer.from(JSON.stringify({ uid: 'admin', exp: Date.now() + 1e9 })).toString('base64url');
    expect(verifyToken(`${forgedBody}.${sig}`)).toBeNull();
    expect(verifyToken(`${body}.${sig.slice(0, -2)}AA`)).toBeNull();
    expect(verifyToken(`${body}.`)).toBeNull();
    expect(verifyToken(`${body}.${sig}.extra`)).toBeNull();
    expect(verifyToken('')).toBeNull();
    expect(verifyToken(undefined)).toBeNull();
    expect(verifyToken({ not: 'a string' })).toBeNull();
    expect(verifyToken('x'.repeat(2000))).toBeNull();
  });
});

describe('passwordless student token (issued by POST /api/extension/join)', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const student = { id, name: 'Ana Cruz', email: 'ana@pup.edu.ph', tokenVersion: 3 };
  const klass = { id: '22222222-2222-4222-8222-222222222222', classCode: 'ABC234' };

  test('carries the student and class claims, the user id and the token version', () => {
    expect(verifyTokenClaims(issueStudentToken(student, klass))).toEqual({
      uid: id, tv: 3, studentId: id, name: 'Ana Cruz', email: 'ana@pup.edu.ph', classId: klass.id, classCode: 'ABC234'
    });
  });

  test('lasts 12 hours from issue time', () => {
    expect(TOKEN_TTL_MS).toBe(12 * 60 * 60 * 1000);
    const now = 5_000_000;
    const token = issueStudentToken(student, klass, now);
    expect(verifyTokenClaims(token, now + TOKEN_TTL_MS - 1)).not.toBeNull();
    expect(verifyTokenClaims(token, now + TOKEN_TTL_MS)).toBeNull();
  });

  test('a token with no class claim (the old password-login kind) carries none, so the server can tell it apart', () => {
    expect(verifyTokenClaims(issueToken(id))).toEqual({ uid: id, tv: 0 });
  });

  test('claims cannot be changed without invalidating the signature, and extra claims cannot override uid/exp/tv', () => {
    const [body, sig] = issueStudentToken(student, klass).split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, classId: 'someone-elses-class' })).toString('base64url');
    expect(verifyTokenClaims(`${forged}.${sig}`)).toBeNull();

    const sneaky = verifyTokenClaims(issueToken(id, 1000, 2, { uid: 'admin', exp: '9', tv: 99, name: 'X', classId: 42 }), 1001);
    expect(sneaky).toEqual({ uid: id, tv: 2, name: 'X' }); // non-string claims dropped, reserved ones untouched
  });

  test('a student with a name or email missing falls back sensibly (legalName, no email)', () => {
    const t = verifyTokenClaims(issueStudentToken({ id, legalName: 'Legal Name' }, klass));
    expect(t).toMatchObject({ name: 'Legal Name', studentId: id });
    expect(t.email).toBeUndefined();
  });

  test('the longest possible student (100-char multi-byte name, 254-char email) still gets a usable token under the size cap', () => {
    const big = { id, name: 'é'.repeat(100), email: `${'a'.repeat(242)}@pup.edu.ph`, tokenVersion: 12345 };
    const token = issueStudentToken(big, klass);
    expect(token.length).toBeLessThanOrEqual(1024);
    expect(verifyTokenClaims(token)).toMatchObject({ name: big.name, email: big.email });
  });
});
