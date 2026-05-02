import pkg from 'rrule';
const { RRule, rrulestr } = pkg;

// RFC 5545 helpers. Recurrence for lead_followups.
export const parseRRule = (rruleString, dtstart) => {
  if (!rruleString) return null;
  return rrulestr(rruleString, { dtstart: dtstart ? new Date(dtstart) : undefined });
};

export const nextOccurrences = (rruleString, { dtstart, after, limit = 10 }) => {
  const rule = parseRRule(rruleString, dtstart);
  if (!rule) return [];
  const afterDate = after ? new Date(after) : new Date();
  const all = rule.between(afterDate, new Date(afterDate.getTime() + 365 * 24 * 60 * 60 * 1000), true);
  return all.slice(0, limit);
};

export const isValidRRule = (rruleString) => {
  try {
    parseRRule(rruleString);
    return true;
  } catch {
    return false;
  }
};

export { RRule };
