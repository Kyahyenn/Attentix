const bcrypt = require('bcryptjs');
const db = require('../config/db');
const { findClassByCode } = require('./classes');

const emailOf = (user) => String(user.email || user.username || '').toLowerCase();

// ---- educators --------------------------------------------------------------------------------------------------
// Hash + atomic duplicate-checked insert (throws 409). `username` mirrors `email` so records stay readable by the
// login code that predates the email field. The duplicate check only looks at educators: a student row that happens
// to carry the same email must never block (or be mistaken for) the professor's account.
const registerEducator = async ({ name, email, password }) => {
  const hashedPassword = await bcrypt.hash(password, 10);
  return db.insertUnique(
    'users',
    { email, username: email, name, legalName: name, password: hashedPassword, role: 'educator' },
    (u) => u.role === 'educator' && emailOf(u) === email,
    'An account with that email already exists'
  );
};

const findEducatorByEmail = async (email) =>
  (await db.readData('users')).find((u) => u.role === 'educator' && emailOf(u) === email);

// ---- students (passwordless) ------------------------------------------------------------------------------------
// A student is identified by (email, classId): the same person in two classes is two records, so history never leaks
// between classes, and the same person re-joining the same class gets the SAME studentId back (history is kept).
const isStudentOf = (email, classId) => (u) => u.role === 'student' && u.email === email && u.classId === classId;

const findStudent = async (email, classId) => (await db.readData('users')).find(isStudentOf(email, classId));

// Creates the student on first join; on a later join only the display name may change.
const upsertStudent = async ({ name, email, klass }) => {
  const { item, created } = await db.upsert('users', isStudentOf(email, klass.id), {
    update: (row) => {
      if (row.name !== name) { row.name = name; row.legalName = name; }
    },
    create: () => ({ role: 'student', email, name, legalName: name, classId: klass.id, tokenVersion: 0 })
  });
  return { student: item, created };
};

// Idempotent: joining twice is not an error.
const ensureEnrollment = async (classId, studentId) => {
  try {
    await db.insertUnique('enrollments', { classId, studentId },
      (e) => e.classId === classId && e.studentId === studentId, 'Already enrolled in this class');
  } catch (err) {
    if (err.status !== 409) throw err;
  }
};

// Who is asking? A bearer token (extension) wins; otherwise the caller proves identity with { email, classCode },
// which is all a passwordless student has. Returns { student, klass } or null. Wrong code and unknown email give the
// same null so the response cannot be used to learn which emails are enrolled where.
const resolveStudent = async (req, { email, classCode } = {}) => {
  const sessionUser = req.session && req.session.user;
  if (sessionUser && sessionUser.role === 'student' && sessionUser.classId) {
    const [student, klass] = await Promise.all([db.findById('users', sessionUser.id), db.findById('classes', sessionUser.classId)]);
    return student && klass ? { student, klass } : null;
  }
  if (!email || !classCode) return null;
  const klass = await findClassByCode(classCode);
  if (!klass) return null;
  const student = await findStudent(email, klass.id);
  return student ? { student, klass } : null;
};

// ---- erasure ----------------------------------------------------------------------------------------------------
// Right to erasure: removes a user and everything that hangs off them. Educators also take their classes (and those
// classes' enrolments, and the students who only existed for those classes) with them. Returns the ids of the
// classes that were deleted so live sockets can be closed.
const deleteAccountData = async (user) => {
  let removedClassIds = [];

  if (user.role === 'educator') {
    removedClassIds = await db.mutate('classes', (classes) => {
      const mine = classes.filter((c) => c.educatorId === user.id).map((c) => c.id);
      db.removeWhere(classes, (c) => c.educatorId === user.id);
      return mine;
    });
  }

  // Students belong to exactly one class, so when a class goes its student records (and consents) go too.
  const orphanedStudentIds = removedClassIds.length
    ? (await db.readData('users')).filter((u) => u.role === 'student' && removedClassIds.includes(u.classId)).map((u) => u.id)
    : [];
  const goneUserIds = new Set([user.id, ...orphanedStudentIds]);

  await db.mutate('enrollments', (rows) =>
    db.removeWhere(rows, (e) => goneUserIds.has(e.studentId) || removedClassIds.includes(e.classId)));
  await db.mutate('consents', (rows) => db.removeWhere(rows, (c) => goneUserIds.has(c.userId)));
  await db.mutate('users', (rows) => db.removeWhere(rows, (u) => goneUserIds.has(u.id)));

  return removedClassIds;
};

module.exports = {
  emailOf,
  registerEducator,
  findEducatorByEmail,
  upsertStudent,
  ensureEnrollment,
  resolveStudent,
  deleteAccountData
};
