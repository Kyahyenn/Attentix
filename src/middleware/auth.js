const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
};

const requireEducator = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.session.user.role !== 'educator') {
    return res.status(403).json({ error: 'Educator privileges required' });
  }
  next();
};

const requireStudent = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (req.session.user.role !== 'student') {
    return res.status(403).json({ error: 'Student privileges required' });
  }
  next();
};

module.exports = {
  requireAuth,
  requireEducator,
  requireStudent
};
