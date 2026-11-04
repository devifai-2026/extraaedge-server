import { resolveTenantBySlug, tenantQuery } from '../../db/tenant.js';
import { createLead } from '../leads/service.js';
import * as leadsRepo from '../leads/repo.js';
import { RESPONSE_CODES } from '../../config/constants.js';
import { notFound } from '../../lib/errors.js';
import { resolveDictId } from '../integrations/facebook-leads.js';

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

  return createWebsiteLead(tenant, {
    name,
    phone,
    program_id,
    remarks,
    first_touch_source: 'speedupinfotech.com',
  });
};

// speedupinfotech.com/hr — the HR program's lead form. Its leads belong to
// the separate SI HR tenant and must never land in speedup-infotech, so the
// tenant is fixed here exactly like TENANT_SLUG above.
const HR_TENANT_SLUG = 'si-hr';
const HR_REMARKS = 'Website lead — HR program enquiry (speedupinfotech.com/hr)';

// The SI HR tenant runs a single program, so there's no dropdown to map
// from. Link the lead to it when exactly one active program exists; with
// none (or several, where the right one is ambiguous) the lead is still
// saved, program-less, rather than rejecting a real enquiry.
const resolveHrProgramId = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM programs WHERE deleted_at IS NULL AND is_active = true LIMIT 2`,
  );
  return rows.length === 1 ? rows[0].id : null;
};

export const submitHrLead = async ({ name, phone }) => {
  const tenant = await resolveTenantBySlug(HR_TENANT_SLUG);
  if (!tenant) throw notFound('Tenant not configured');

  // A repeat enquiry from the same phone is already in the pipeline.
  const existing = await leadsRepo.findDuplicates(tenant, { phone, whatsapp_number: phone });
  if (existing.length) return { deduped: true };

  return createWebsiteLead(tenant, {
    name,
    phone,
    program_id: await resolveHrProgramId(tenant),
    remarks: HR_REMARKS,
    first_touch_source: 'speedupinfotech.com/hr',
  });
};

// ── SI HR Meta Lead Ads sheet ────────────────────────────────────────────
// Meta's "export leads to Google Sheets" rows, pushed one at a time by the
// sheet's Apps Script. Returns { status: 'created' | 'duplicate', lead_id }
// synchronously so the script can stamp the row and never resend it.

// Meta prefixes ids/phones in the export: "l:123", "p:+9190...", "ag:...".
const stripMetaPrefix = (v) => String(v ?? '').trim().replace(/^[a-z]{1,3}:/i, '');
const normKey = (k) => String(k).trim().toLowerCase().replace(/[\s-]+/g, '_');

// Meta's fixed export columns — everything else is a custom form question.
const META_COLUMNS = new Set([
  'id', 'created_time', 'ad_id', 'ad_name', 'adset_id', 'adset_name',
  'campaign_id', 'campaign_name', 'form_id', 'form_name', 'is_organic',
  'platform', 'full_name', 'phone_number', 'phone', 'email', 'city',
  'lead_status', 'whatsapp_number', 'synced',
]);

const titleCase = (s) => s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());

export const submitHrSheetLead = async (rawRow) => {
  const tenant = await resolveTenantBySlug(HR_TENANT_SLUG);
  if (!tenant) throw notFound('Tenant not configured');

  const row = {};
  for (const [k, v] of Object.entries(rawRow)) row[normKey(k)] = v == null ? '' : String(v).trim();

  const digits = stripMetaPrefix(row.phone_number || row.phone).replace(/\D/g, '');
  const email = row.email && /\S+@\S+\.\S+/.test(row.email) ? row.email.toLowerCase() : undefined;
  if (digits.length < 10 && !email) {
    return { status: 'invalid', reason: 'no usable phone or email' };
  }
  const phone = digits.length >= 10 ? digits : undefined;
  const whatsapp = phone ? (phone.length === 10 ? `91${phone}` : phone) : undefined;

  // Duplicate = same phone (last 10 digits, any of phone/whatsapp) or email.
  // The leads table's unique indexes back this up if two rows race.
  const existing = await leadsRepo.findDuplicates(tenant, { phone, whatsapp_number: whatsapp, email });
  if (existing.length) return { status: 'duplicate', lead_id: existing[0].id };

  // Attribution mirrors the native FB leadgen handler (facebook-leads.js) so
  // these leads land in the same Facebook/Instagram routing pools.
  const isInstagram = ['ig', 'instagram'].includes(row.platform?.toLowerCase());
  const channelName = isInstagram ? 'Instagram' : 'Facebook';
  const sourceName = isInstagram ? 'Instagram Lead Ads' : 'Facebook Lead Ads';
  const channelId = await resolveDictId(tenant, 'lead_channels', channelName);
  const sourceId = await resolveDictId(tenant, 'lead_sources_dict', sourceName);
  const campaignId = row.campaign_name
    ? await resolveDictId(tenant, 'lead_campaigns_dict', row.campaign_name)
    : null;

  // Custom form answers ("currently_studying", ...) → remarks, so the
  // counsellor sees what the lead actually told us.
  const answers = Object.entries(row)
    .filter(([k, v]) => v && !META_COLUMNS.has(k))
    // Meta often repeats the phone in a second column — don't echo it.
    .filter(([, v]) => !(phone && v.replace(/\D/g, '').endsWith(phone.slice(-10))))
    .map(([k, v]) => `${k.replace(/_/g, ' ').replace(/\?$/, '')}: ${v.replace(/_/g, ' ')}`);
  const remarks = [
    `Meta lead ad${row.form_name ? ` — form "${row.form_name}"` : ''}${row.ad_name ? `, ad "${row.ad_name}"` : ''}${row.id ? ` (lead ${stripMetaPrefix(row.id)})` : ''}`,
    ...answers,
  ].join('\n').slice(0, 2000);

  const rawName = (row.full_name || '').replace(/\s+/g, ' ').trim();
  try {
    const lead = await createLead(
      tenant,
      null,
      {
        name: rawName ? titleCase(rawName) : `Meta Lead ${phone || email}`,
        phone,
        whatsapp_number: whatsapp,
        email,
        city: row.city ? titleCase(row.city) : undefined,
        program_id: (await resolveHrProgramId(tenant)) ?? undefined,
        remarks,
        first_touch_channel: channelName,
        first_touch_source: sourceName,
        first_touch_medium: 'paid',
        ...(campaignId ? { first_touch_campaign_id: campaignId } : {}),
        sources: [{ channel_id: channelId, source_id: sourceId, campaign_id: campaignId, is_primary: true }],
      },
      { on_duplicate: 'block' },
    );
    return { status: 'created', lead_id: lead?.id ?? null };
  } catch (err) {
    if (err?.code === RESPONSE_CODES.DUPLICATE_DETECTED) {
      const again = await leadsRepo.findDuplicates(tenant, { phone, whatsapp_number: whatsapp, email });
      return { status: 'duplicate', lead_id: again[0]?.id ?? null };
    }
    throw err;
  }
};

const createWebsiteLead = async (tenant, { name, phone, program_id, remarks, first_touch_source }) => {
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
        first_touch_source,
        first_touch_medium: 'organic',
      },
      { on_duplicate: 'block' },
    );
  } catch (err) {
    // A concurrent submission with the same phone (race with the callers'
    // findDuplicates check) is normal, not an error — treat it as a
    // successful, idempotent enquiry rather than exposing "you're already
    // a lead" to an anonymous visitor.
    if (err?.code === RESPONSE_CODES.DUPLICATE_DETECTED) return { deduped: true };
    throw err;
  }
};
