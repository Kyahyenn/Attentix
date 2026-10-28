const { sanitizeString, getEngagementCategory } = require('../../src/utils/helpers');

describe('Utility Helpers', () => {
  test('sanitizeString removes dangerous HTML characters', () => {
    const input = '<script>alert("test")</script>  ';
    const expected = 'scriptalert("test")/script';
    expect(sanitizeString(input)).toBe(expected);
  });

  test('getEngagementCategory returns correct classification based on score thresholds', () => {
    expect(getEngagementCategory(90)).toBe('highly_engaged');
    expect(getEngagementCategory(80)).toBe('highly_engaged');
    expect(getEngagementCategory(79)).toBe('moderately_engaged');
    expect(getEngagementCategory(50)).toBe('moderately_engaged');
    expect(getEngagementCategory(49)).toBe('distracted');
    expect(getEngagementCategory(0)).toBe('distracted');
  });
});