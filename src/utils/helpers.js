/**
 * Sanitizes user input to prevent basic XSS or injection
 * (A placeholder for more advanced sanitization logic if HTML input is expected)
 */
const sanitizeString = (str) => {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim();
};

/**
 * Calculates a simplified engagement category based on the numeric focus score
 */
const getEngagementCategory = (score) => {
  if (score >= 80) return 'highly_engaged';
  if (score >= 50) return 'moderately_engaged';
  return 'distracted';
};

module.exports = {
  sanitizeString,
  getEngagementCategory
};
