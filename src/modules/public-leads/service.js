import { resolveTenantBySlug } from '../../db/tenant.js';
import { createLead } from '../leads/service.js';
import { RESPONSE_CODES } from '../../config/constants.js';
import { notFound } from '../../lib/errors.js';

// This module exists for exactly one caller: the speedupinfotech.com
// marketing site's "Free Demo" form. There's no tenant subdomain or JWT on
// that request, so — unlike every other lead-creation path in the app — the
// tenant is fixed here rather than resolved from the request.
const TENANT_SLUG = 'speedup-infotech';

// The tenant's own catch-all program for leads that haven't picked a course
// yet ("Yet to decide") — the Free Demo form has no course selector, so
// every lead through it lands here for a counsellor to qualify by phone.
const DEFAULT_PROGRAM_ID = 'b64e272f-821a-44a0-8313-9d54486edce2';

export const submitFreeDemoLead = async ({ name, phone }) => {
  const tenant = await resolveTenantBySlug(TENANT_SLUG);
  if (!tenant) throw notFound('Tenant not configured');

  try {
    return await createLead(
      tenant,
      null, // no actor — anonymous public submission
      {
        name,
        whatsapp_number: phone,
        phone,
        program_id: DEFAULT_PROGRAM_ID,
        remarks: 'Website lead — Free Demo Class request (speedupinfotech.com)',
        first_touch_channel: 'Website',
        first_touch_source: 'speedupinfotech.com',
        first_touch_medium: 'organic',
      },
      { on_duplicate: 'block' },
    );
  } catch (err) {
    // A repeat visitor re-submitting the same phone number is normal, not an
    // error — treat it as a successful, idempotent enquiry rather than
    // exposing "you're already a lead" to an anonymous visitor or creating
    // a duplicate row.
    if (err?.code === RESPONSE_CODES.DUPLICATE_DETECTED) return { deduped: true };
    throw err;
  }
};
