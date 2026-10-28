const crypto = require('crypto');
const { promisify } = require('util');

// Per-student recovery PIN: the possession proof that email + class code cannot give. Issue one when a student first
// joins, show it once, store only the hash (users[].pinHash), and require it for any credential-less lookup, consent
// change or re-join of an existing student. Nothing here is wired into a route until you add the `pin` field.

const scrypt = promisify(crypto.scrypt);
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const PIN_LENGTH = 10;                              // 31^10 ~ 2^49.5
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;
const FORMAT = 's1';

const normalizePin = (pin) => String(pin == null ? '' : pin).trim().toUpperCase().replace(/[\s-]/g, '');

const generatePin = () => Array.from({ length: PIN_LENGTH }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join('');

const encode = (salt, hash) => `${FORMAT}$${salt.toString('base64url')}$${hash.toString('base64url')}`;

const hashPin = async (pin) => {
  const salt = crypto.randomBytes(16);
  return encode(salt, await scrypt(normalizePin(pin), salt, KEY_LENGTH, SCRYPT));
};

// A real record that no PIN is ever compared against successfully: verifying an unknown student costs the same scrypt
// run as verifying a known one, so response time does not reveal which identities exist.
const DUMMY_SALT = crypto.randomBytes(16);
const DUMMY_RECORD = encode(DUMMY_SALT, crypto.scryptSync(crypto.randomBytes(16), DUMMY_SALT, KEY_LENGTH, SCRYPT));

const parseRecord = (record) => {
  if (typeof record !== 'string') return null;
  const [format, salt, hash, extra] = record.split('$');
  if (format !== FORMAT || !salt || !hash || extra !== undefined) return null;
  const saltBuf = Buffer.from(salt, 'base64url');
  const hashBuf = Buffer.from(hash, 'base64url');
  return hashBuf.length === KEY_LENGTH && saltBuf.length > 0 ? { salt: saltBuf, hash: hashBuf } : null;
};

// Always runs one scrypt and one timingSafeEqual, whatever `stored` is (missing, malformed or genuine).
const verifyPin = async (stored, supplied) => {
  const parsed = parseRecord(stored);
  const record = parsed || parseRecord(DUMMY_RECORD);
  const actual = await scrypt(normalizePin(supplied), record.salt, KEY_LENGTH, SCRYPT);
  const equal = crypto.timingSafeEqual(actual, record.hash);
  return Boolean(parsed) && equal;
};

module.exports = { generatePin, hashPin, verifyPin, normalizePin, PIN_LENGTH };
