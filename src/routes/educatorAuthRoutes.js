const express = require('express');
const { validate, EducatorRegisterSchema } = require('../utils/validation');
const { educatorSignupLimiter } = require('../middleware/limiter');
const { registerEducator } = require('../utils/accounts');
const { toSessionUser, establishSession } = require('../utils/session');

// Educator onboarding, mounted at /api/auth/educator. Self-hosted: the professor running the server registers with
// just a name, an email and a password. There is no invite code. This is the ONLY route that can create an educator,
// and an educator only ever sees the classes they created themselves.
const router = express.Router();

router.post('/register', educatorSignupLimiter, validate(EducatorRegisterSchema), async (req, res) => {
  try {
    const { name, email, password } = req.body;
    // The duplicate check and the insert happen inside one lock, so concurrent requests cannot both succeed.
    const newUser = await registerEducator({ name, email, password });
    const userResponse = toSessionUser(newUser);
    await establishSession(req, userResponse);
    res.status(201).json({ message: 'Educator account created', user: userResponse });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Educator register failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
