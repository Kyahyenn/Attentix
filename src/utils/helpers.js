/** Strips < and > from a string and trims it. Returns '' for non-strings. */
const sanitizeString = (str) => {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim();
};

/** Maps a 0-100 focus score to highly_engaged (80+), moderately_engaged (50+) or distracted. */
const getEngagementCategory = (score) => {
  if (score >= 80) return 'highly_engaged';
  if (score >= 50) return 'moderately_engaged';
  return 'distracted';
};

module.exports = {
  sanitizeString,
  getEngagementCategory
};
