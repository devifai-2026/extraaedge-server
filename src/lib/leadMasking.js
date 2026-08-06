import { SYSTEM_TENANT_ROLES } from '../config/constants.js';

// Phone-like fields masked by default everywhere a lead row gets serialized
// to the browser. Deliberately NOT including `email` here yet — several
// email-compose surfaces likely prefill their "To" field from this same
// data, and masking it without first auditing those flows risks silently
// breaking outbound email. Flagged as a follow-up, not shipped blind.
const MASKED_FIELDS = ['phone', 'whatsapp_number', 'alternate_contact'];

export const maskPhoneValue = (value) => {
  if (!value) return value;
  const str = String(value);
  if (str.length <= 4) return '•'.repeat(str.length);
  return '•'.repeat(str.length - 4) + str.slice(-4);
};
const mask = maskPhoneValue;

const isSuperAdmin = (actor) => actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN;

// Masks lead rows for every role except super_admin. Applied ONLY at the
// controller/response boundary (leads/controller.js, lead-pool/controller.js)
// — NEVER inside leads/service.js itself, since other modules (click-to-call,
// messaging, duplicate matching) call that service layer to actually USE the
// real contact info and must keep getting it unmasked.
export const maskLeadRow = (row, actor) => {
  if (!row || actor?.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) return row;
  const masked = { ...row };
  for (const field of MASKED_FIELDS) {
    if (masked[field] != null) masked[field] = mask(masked[field]);
  }
  return masked;
};

export const maskLeadRows = (rows, actor) => {
  if (!Array.isArray(rows) || isSuperAdmin(actor)) return rows;
  return rows.map((r) => maskLeadRow(r, actor));
};

// FailedLeads (validation failures + duplicates) carries phone-like fields
// nested inside a raw_row_json blob — the raw uploaded spreadsheet row, keyed
// by whatever the tenant's import template calls its columns — rather than
// as fixed top-level lead columns. Masks the known contact keys in-place plus
// any top-level phone-ish columns the caller names (e.g. duplicates rows also
// carry matched_lead_phone, the EXISTING lead's number, for comparison).
const RAW_ROW_PHONE_KEYS = ['phone', 'whatsapp_number', 'alternate_contact'];

export const maskFailedLeadRow = (row, actor, extraTopLevelFields = []) => {
  if (!row || isSuperAdmin(actor)) return row;
  const masked = { ...row };
  if (masked.raw_row_json && typeof masked.raw_row_json === 'object') {
    const rawRow = { ...masked.raw_row_json };
    for (const key of RAW_ROW_PHONE_KEYS) {
      if (rawRow[key] != null) rawRow[key] = mask(rawRow[key]);
    }
    masked.raw_row_json = rawRow;
  }
  for (const field of extraTopLevelFields) {
    if (masked[field] != null) masked[field] = mask(masked[field]);
  }
  return masked;
};

export const maskFailedLeadRows = (rows, actor, extraTopLevelFields = []) => {
  if (!Array.isArray(rows) || isSuperAdmin(actor)) return rows;
  return rows.map((r) => maskFailedLeadRow(r, actor, extraTopLevelFields));
};
