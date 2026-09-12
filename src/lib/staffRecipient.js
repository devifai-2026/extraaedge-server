// Where an HR email should be sent for a given staff member.
//
// Two addresses exist on `users` and they are not interchangeable:
//   email          the OFFICIAL / login address (citext NOT NULL UNIQUE)
//   personal_email the Gmail-style personal address (nullable, not unique)
//
// The rule turns on ONE question: does the work account exist and work yet?
//
//   PERSONAL — onboarding credentials, the offer letter. These arrive BEFORE
//   the person can sign in, so sending them to the official address delivers
//   the login to an inbox they cannot open. A classic chicken-and-egg that
//   looks like "the email never arrived".
//
//   OFFICIAL — leave decisions, payslips, portal notifications, regularisation
//   outcomes. The person is an employee by then, and payroll/leave records
//   belong in the company mailbox, not a personal one.
//
// Every HR send goes through here rather than reaching for user.email, so the
// rule lives in one place and a new notification cannot quietly get it wrong.

// Purposes that must reach the person before (or regardless of) their work
// account working.
const PERSONAL_FIRST = new Set([
  'onboarding_credentials',
  'offer_letter',
  'onboarding_document',
  'pre_joining',
]);

/**
 * @param {{email?: string|null, personal_email?: string|null}} user
 * @param {string} purpose  e.g. 'payslip' | 'leave_decision' | 'onboarding_credentials'
 * @returns {{to: string|null, kind: 'personal'|'official'|null, fellBack: boolean}}
 */
export const recipientFor = (user, purpose) => {
  const official = user?.email || null;
  const personal = user?.personal_email || null;

  if (PERSONAL_FIRST.has(purpose)) {
    // Fall back to official rather than dropping the mail — a joiner with no
    // personal address on file still needs their credentials.
    if (personal) return { to: personal, kind: 'personal', fellBack: false };
    return { to: official, kind: 'official', fellBack: true };
  }

  if (official) return { to: official, kind: 'official', fellBack: false };
  return { to: personal, kind: 'personal', fellBack: true };
};

// Both addresses, de-duplicated — for the rare send that should reach the
// person wherever they are (e.g. an offboarding notice on their last day).
export const allRecipientsFor = (user) => {
  const out = [];
  if (user?.email) out.push(user.email);
  if (user?.personal_email && user.personal_email !== user.email) out.push(user.personal_email);
  return out;
};

export default recipientFor;

// NOTE for payroll/attendance consumers: `date` columns (joining_date, dob,
// work_date, holiday_date) come back from node-postgres as a JS Date at UTC
// midnight, so a 2026-09-01 joining date renders as 2026-08-31T18:30Z in IST.
// The STORED value is correct — only the JS rendering shifts. Always compare
// and group these in SQL (`::date`, date_trunc) rather than converting through
// a JS Date, or the joining month flips at the boundary.
