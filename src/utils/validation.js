const { z } = require('zod');

// A tiny deny-list of the passwords that are tried first in every guessing attack.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123',
  'iloveyou', 'admin123', 'letmein1', 'welcome1', 'abc12345', '11111111', 'passw0rd', 'student123', 'pupstudent'
]);

// bcrypt only uses the first 72 BYTES, so a long multi-byte password would be silently truncated.
const passwordRule = z.string().min(8).max(72)
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password is too long (72 bytes max)')
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'That password is too common. Choose something harder to guess.');

// ---- shared field rules ----
// Display names are rendered in the educator dashboard: strip control characters and angle brackets (defence in depth
// on top of the pages escaping their output), collapse whitespace, then require something to be left.
const cleanName = (value) => String(value)
  .normalize('NFKC')
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029<>]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const nameRule = z.string().max(200).transform(cleanName)
  .pipe(z.string().min(1, 'Name is required').max(100, 'Name is too long (100 characters max)'));

const emailRule = z.string().trim().toLowerCase().max(254).email('Enter a valid email address');

// 6-8 upper-case letters/digits. Generated codes are 6 (see utils/classes.js); the range leaves room to grow.
const classCodeRule = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6,8}$/, 'Class codes are 6 to 8 letters and numbers');

// Older pages still send { legalName, username }: map them onto { name, email }. Unknown fields (e.g. a leftover `inviteCode`) are stripped by zod.
const withLegacyAliases = (schema) => z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { legalName, username, ...rest } = raw;
  return {
    ...rest,
    name: rest.name !== undefined ? rest.name : legalName,
    email: rest.email !== undefined ? rest.email : username
  };
}, schema);

// ---- educator accounts ----
// Self-hosted: whoever runs the server registers as the educator. Nothing here can create a student; no invite code exists.
const EducatorRegisterSchema = withLegacyAliases(z.object({
  name: nameRule,
  email: emailRule,
  password: passwordRule
}));

// Sign-in accepts an email OR a legacy username (accounts made before emails were required). Only registration needs an email.
const LoginSchema = withLegacyAliases(z.object({
  email: z.string().trim().toLowerCase().min(3).max(254),
  password: z.string().min(1).max(72)
}));

// Password accounts confirm with the password; the email fallback is kept for accounts that have none.
const DeleteAccountSchema = z.object({
  password: z.string().min(1).max(72).optional(),
  confirmEmail: z.string().trim().toLowerCase().max(100).optional()
}).refine((d) => d.password || d.confirmEmail, { message: 'Confirm with your password (or your account email)' });

// ---- classes ----
const ClassCreationSchema = z.object({
  className: z.string().trim().min(3).max(100),
  schedule: z.string().trim().max(100).optional()
});

const ClassCreateSchema = z.object({
  name: z.string().trim().min(3).max(100),
  section: z.string().trim().max(50).optional()
});

const ClassIdParamSchema = z.object({ classId: z.string().uuid() });

// ---- passwordless students ----
// GET /api/extension/preconfigured?classCode=...
const ClassCodeQuerySchema = z.object({ classCode: classCodeRule });

// POST /api/extension/join. `consent` must be the boolean true (explicit opt-in). There is no password field; the route rejects one.
const StudentJoinSchema = z.object({
  name: nameRule,
  email: emailRule,
  classCode: classCodeRule,
  consent: z.literal(true, { errorMap: () => ({ message: 'You must agree to the privacy agreement to join' }) })
});

// POST /api/student/lookup. `name` is accepted because the form has the field, but it is never used to match.
const StudentLookupSchema = z.object({
  name: nameRule.optional(),
  email: emailRule,
  classCode: classCodeRule
});

// Same credentials as the lookup, plus the decision (used when the student has no bearer token).
const StudentConsentSchema = StudentLookupSchema.extend({
  decision: z.enum(['accept', 'decline'])
});

// Bearer-token holders (the extension) only choose a decision.
const ConsentSchema = z.object({
  decision: z.enum(['accept', 'decline'])
});

// `source` is 'body' (default) or 'params'. The parsed (trimmed/normalised) value replaces the raw one.
const validate = (schema, source = 'body') => (req, res, next) => {
  try {
    req[source] = schema.parse(req[source]);
    next();
  } catch (error) {
    const issues = Array.isArray(error.errors) ? error.errors : [];
    const first = issues[0];
    return res.status(400).json({
      error: 'Validation failed',
      // Human-readable summary so the UI can show something better than "Validation failed".
      message: first ? `${first.path.join('.') || 'request'}: ${first.message}` : 'Invalid request',
      details: issues
    });
  }
};

module.exports = {
  EducatorRegisterSchema,
  LoginSchema,
  ClassCreationSchema,
  ClassCreateSchema,
  StudentJoinSchema,
  ClassCodeQuerySchema,
  StudentLookupSchema,
  StudentConsentSchema,
  ConsentSchema,
  DeleteAccountSchema,
  ClassIdParamSchema,
  validate
};
