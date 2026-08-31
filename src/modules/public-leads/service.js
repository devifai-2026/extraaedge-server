import { resolveTenantBySlug } from '../../db/tenant.js';
import { createLead } from '../leads/service.js';
import * as leadsRepo from '../leads/repo.js';
import { RESPONSE_CODES } from '../../config/constants.js';
import { notFound } from '../../lib/errors.js';

// This module exists for exactly one caller: the speedupinfotech.com
// marketing site's "Free Demo" form. There's no tenant subdomain or JWT on
// that request, so — unlike every other lead-creation path in the app — the
// tenant is fixed here rather than resolved from the request.
const TENANT_SLUG = 'speedup-infotech';

// The tenant's own catch-all program for leads that haven't picked a course
// yet ("Yet to decide") — also the fallback for any interest label below
// that isn't a clean 1:1 match to one tenant program.
const DEFAULT_PROGRAM_ID = 'b64e272f-821a-44a0-8313-9d54486edce2';

// Maps the FE's course dropdown (step 2) to this tenant's actual program
// rows. "Full Stack (Java/Python)" is deliberately NOT mapped — the tenant
// has separate Java and Python programs, so there's no single correct
// target; it falls through to DEFAULT_PROGRAM_ID with the raw label kept in
// remarks so a counsellor still sees exactly what the visitor picked.
const INTEREST_TO_PROGRAM_ID = {
  'Data Science & ML': '530cc216-1b3a-4c99-b5ac-018cd022655e',
  'Data Analytics with AI': 'f3b35f36-1779-4e9c-ad77-0ff5944402b2',
  'Cloud / DevOps Engineering': 'cfc6bf9f-719e-4868-ab01-ee596593b9c4',
  'Mern Stack + AI Automation': '2909f114-241d-4dfb-9f10-5a63f19c5f42',
  'Not Sure Yet': DEFAULT_PROGRAM_ID,
};

const buildRemarks = (interest) =>
  interest
    ? `Website lead — Free Demo Class request (speedupinfotech.com). Interested in: ${interest}`
    : 'Website lead — Free Demo Class request (speedupinfotech.com)';

export const submitFreeDemoLead = async ({ name, phone, interest }) => {
  const tenant = await resolveTenantBySlug(TENANT_SLUG);
  if (!tenant) throw notFound('Tenant not configured');

  const program_id = (interest && INTEREST_TO_PROGRAM_ID[interest]) || DEFAULT_PROGRAM_ID;
  const remarks = buildRemarks(interest);

  // Step 2 arrives as a SECOND POST with the same phone, once the visitor
  // has picked a course. Find the lead step 1 created and enrich it in
  // place, rather than creating a duplicate row or losing the interest to
  // the dedup guard below.
  const existing = await leadsRepo.findDuplicates(tenant, { phone, whatsapp_number: phone });
  if (existing.length) {
    if (interest) {
      await leadsRepo.updateLead(tenant, existing[0].id, { program_id, remarks }, null);
    }
    return { deduped: true };
  }

  try {
    return await createLead(
      tenant,
      null, // no actor — anonymous public submission
      {
        name,
        whatsapp_number: phone,
        phone,
        program_id,
        remarks,
        first_touch_channel: 'Website',
        first_touch_source: 'speedupinfotech.com',
        first_touch_medium: 'organic',
      },
      { on_duplicate: 'block' },
    );
  } catch (err) {
    // A concurrent step-1 submission with the same phone (race with the
    // findDuplicates check above) is normal, not an error — treat it as a
    // successful, idempotent enquiry rather than exposing "you're already
    // a lead" to an anonymous visitor.
    if (err?.code === RESPONSE_CODES.DUPLICATE_DETECTED) return { deduped: true };
    throw err;
  }
};
