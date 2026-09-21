import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery, tenantTx } from '../../db/tenant.js';
import { EVENT_TYPES, QUEUE_NAMES, MANAGER_TIER_ROLES, SYSTEM_TENANT_ROLES, LEAD_OWNER_ROLES } from '../../config/constants.js';
import { notFound, forbidden, conflict } from '../../lib/errors.js';
import { findDuplicates } from '../leads/repo.js';
import { publish } from '../../lib/queue.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const checkSchema = z.object({
  phone: z.string().optional(),
  email: z.string().email().optional(),
  whatsapp_number: z.string().optional(),
});

const bulkSchema = z.object({
  rows: z.array(checkSchema).min(1).max(1000),
});

// Who may run a scan and merge.
//
//   super_admin / branch_manager — the whole tenant / their whole branch.
//   counsellor / telecaller      — ONLY duplicates where they own EVERY lead
//                                  in the group.
//
// That last rule is the important one. A front-line user cleaning up their own
// list is good; a front-line user merging someone else's lead into theirs is a
// silent reassignment that the owner never sees. So a group is offered to them
// only when every row in it is already theirs — then merging changes ownership
// of nothing.
//
// branch_manager is READ-ONLY across the CRM (middleware/branchManagerReadOnly)
// so the merge routes are allowlisted there too, or this guard never runs.
const DEDUPE_ROLES = [
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  ...LEAD_OWNER_ROLES,
];

// True when the caller only ever sees groups they own outright.
const isOwnerScoped = (role) => LEAD_OWNER_ROLES.includes(role);

// Scan modes. Contact matching is the reliable one; name matching is a
// suggestion, because two real people genuinely share a name.
const scanSchema = z.object({
  mode: z.enum(['contact', 'name']).default('contact'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// Merge N leads into one survivor in a single transaction. The one-at-a-time
// route below still exists for the review queue; this is for "I searched, I
// ticked four rows, they are all the same person".
const mergeManySchema = z.object({
  survivor_id: z.string().uuid(),
  merge_ids: z.array(z.string().uuid()).min(1).max(20),
});

const mergeSchema = z.object({
  merge_into_lead_id: z.string().uuid(),
  field_decisions: z.record(z.string(), z.string().uuid()).optional(),
  resolve_duplicate_match_id: z.string().uuid().optional(),
});

router.post('/check', validate({ body: checkSchema }), async (req, res, next) => {
  try {
    const matches = await findDuplicates(req.tenant, req.body);
    res.json({ data: matches, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/check-bulk', requireRole(...MANAGER_TIER_ROLES), validate({ body: bulkSchema }), async (req, res, next) => {
  try {
    const out = [];
    for (const [i, row] of req.body.rows.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const matches = await findDuplicates(req.tenant, row);
      out.push({ row_index: i, input: row, matches });
    }
    res.json({ data: out, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/', requireRole(...MANAGER_TIER_ROLES), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT m.*,
              la.name AS lead_a_name, la.email AS lead_a_email, la.phone AS lead_a_phone,
              lb.name AS lead_b_name, lb.email AS lead_b_email, lb.phone AS lead_b_phone
         FROM lead_duplicate_matches m
         LEFT JOIN leads la ON la.id = m.lead_a_id
         LEFT JOIN leads lb ON lb.id = m.lead_b_id
        WHERE m.status = 'open'
        ORDER BY m.created_at DESC
        LIMIT 500`,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// On-demand scan. Groups live leads that look like the same person.
//
// CONTACT mode normalises phone AND whatsapp to their last 10 digits and keys
// on the union of both columns. That crossover matters: the unique index only
// covers `phone`, so a lead with the number in `whatsapp_number` and a NULL
// phone never collides with one holding it in `phone`. That is exactly how the
// Snehal Deshmukh pair got in — June row had whatsapp only, September row had
// phone only.
//
// NAME mode is case- and space-insensitive and is explicitly a SUGGESTION:
// two different people really can share a name, so these are never merged
// without someone looking.
router.get('/scan', requireRole(...DEDUPE_ROLES), validate({ query: scanSchema }), async (req, res, next) => {
  try {
    const { mode, limit } = req.query;
    // Last 10 digits of either column, as one key per lead per number. A lead
    // with the same number in both columns yields one key, not two.
    const CONTACT_SQL = `
      WITH keys AS (
        SELECT id, right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) AS k
          FROM leads
         WHERE deleted_at IS NULL AND phone IS NOT NULL
           AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10
        UNION
        SELECT id, right(regexp_replace(whatsapp_number, '[^0-9]', '', 'g'), 10)
          FROM leads
         WHERE deleted_at IS NULL AND whatsapp_number IS NOT NULL
           AND length(regexp_replace(whatsapp_number, '[^0-9]', '', 'g')) >= 10
      ),
      grouped AS (
        SELECT k, array_agg(DISTINCT id) AS ids
          FROM keys GROUP BY k HAVING count(DISTINCT id) > 1
      )
      SELECT k AS match_value, ids FROM grouped ORDER BY array_length(ids,1) DESC LIMIT $1`;

    // Name matching needs guarding hard. On live data "unknown" alone groups
    // 3,015 leads, "no name" another 122 — placeholders, not people, and
    // offering them as one mergeable group would be actively dangerous.
    //   • placeholders are excluded outright
    //   • a single-word name is excluded: "sakshi" matches 20 unrelated people
    //   • a group larger than 6 is excluded — at that size it is a common
    //     name, not a duplicate, and nobody can verify it by eye anyway
    const NAME_SQL = `
      SELECT lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) AS match_value,
             array_agg(id) AS ids
        FROM leads
       WHERE deleted_at IS NULL AND name IS NOT NULL AND btrim(name) <> ''
         AND lower(btrim(name)) NOT IN ('unknown','no name','test','n/a','na','-','--')
         AND position(' ' IN btrim(name)) > 0
       GROUP BY 1
      HAVING count(*) > 1 AND count(*) <= 6
       ORDER BY count(*) DESC LIMIT $1`;

    const { rows: groups } = await tenantQuery(
      req.tenant, mode === 'name' ? NAME_SQL : CONTACT_SQL, [limit],
    );
    if (!groups.length) return res.json({ data: [], meta: { mode, requestId: req.id } });

    // One follow-up query for every lead in every group, so the UI can show
    // enough to decide without a request per row.
    const allIds = [...new Set(groups.flatMap((g) => g.ids))];
    const { rows: leads } = await tenantQuery(
      req.tenant,
      `SELECT l.id, l.name, l.phone, l.whatsapp_number, l.email, l.created_at,
              l.updated_at, l.converted_at, l.assigned_to,
              s.name AS stage_name, u.name AS owner_name,
              (SELECT count(*)::int FROM lead_activities a WHERE a.lead_id = l.id) AS activity_count
         FROM leads l
         LEFT JOIN lead_stages s ON s.id = l.stage_id
         LEFT JOIN users u ON u.id = l.assigned_to
        WHERE l.id = ANY($1::uuid[])`,
      [allIds],
    );
    const byId = new Map(leads.map((l) => [l.id, l]));
    let data = groups.map((g) => ({
      match_value: g.match_value,
      leads: g.ids.map((id) => byId.get(id)).filter(Boolean)
        // Oldest first: the longest-worked record is usually the survivor, so
        // it should be the one pre-selected in the UI.
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    })).filter((g) => g.leads.length > 1);

    // Front line: drop any group containing a lead they do not own. Merging a
    // colleague's lead into your own is a silent reassignment — the other
    // owner would simply find the lead gone. Requiring the WHOLE group means
    // a merge here can never move a lead between people.
    if (isOwnerScoped(req.user.role)) {
      data = data.filter((g) => g.leads.every((l) => l.assigned_to === req.user.id));
    }

    res.json({ data, meta: { mode, groups: data.length, requestId: req.id } });
  } catch (err) { next(err); }
});

// Merge several leads into one survivor. Everything the single merge moves is
// moved here too — it simply runs once per losing lead, in one transaction, so
// a partial merge can never leave history split across both records.
router.post('/merge-many', requireRole(...DEDUPE_ROLES), validate({ body: mergeManySchema }), async (req, res, next) => {
  try {
    const { survivor_id, merge_ids } = req.body;
    const losers = merge_ids.filter((id) => id !== survivor_id);
    if (!losers.length) throw notFound('Nothing to merge into that lead');

    const result = await tenantTx(req.tenant, async (client) => {
      const { rows: live } = await client.query(
        `SELECT id, assigned_to FROM leads WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [[survivor_id, ...losers]],
      );
      // Enforce the ownership rule HERE, not just in the scan's filter: the
      // scan only decides what is shown, and a hand-made request could name
      // any two lead ids. A front-line user must own every lead involved,
      // survivor included, so a merge can never move a lead between people.
      if (isOwnerScoped(req.user.role)) {
        const foreign = live.filter((r) => r.assigned_to !== req.user.id);
        if (foreign.length) {
          throw forbidden('You can only merge leads you own. Ask a manager to merge across owners.');
        }
      }
      const liveIds = new Set(live.map((r) => r.id));
      if (!liveIds.has(survivor_id)) throw notFound('The lead to keep no longer exists');
      const actual = losers.filter((id) => liveIds.has(id));
      if (!actual.length) throw notFound('Those leads are already merged or deleted');

      // lead_assignments carries a partial unique index — one ACTIVE row per
      // lead (one_active_assignment_per_lead). Both leads have one, so simply
      // re-pointing the loser's row would put two active rows on the survivor
      // and violate it. Close the losers' rows first: the survivor keeps its
      // own current owner, and the loser's assignment becomes history, which
      // is what a merge means anyway.
      await client.query(
        `UPDATE lead_assignments SET is_active = false, status = 'closed'
          WHERE lead_id = ANY($1::uuid[]) AND is_active`,
        [actual],
      );

      const TRANSFERS = [
        'lead_activities', 'lead_notes', 'lead_followups', 'lead_assignments',
        'message_log', 'calls', 'lead_source_attributions', 'lead_touches',
        'payments', 'payment_links',
      ];
      for (const table of TRANSFERS) {
        await client.query(
          `UPDATE ${table} SET lead_id = $1 WHERE lead_id = ANY($2::uuid[])`,
          [survivor_id, actual],
        );
      }
      // Tags and custom values are keyed per lead, so they need conflict
      // handling rather than a blind re-point. Survivor wins on conflict.
      await client.query(
        `INSERT INTO lead_tags (lead_id, tag_id, assigned_by, assigned_at)
         SELECT $1, tag_id, assigned_by, assigned_at FROM lead_tags
          WHERE lead_id = ANY($2::uuid[]) ON CONFLICT DO NOTHING`,
        [survivor_id, actual],
      );
      await client.query(`DELETE FROM lead_tags WHERE lead_id = ANY($1::uuid[])`, [actual]);
      await client.query(
        `INSERT INTO lead_custom_values (lead_id, field_id, value, updated_at)
         SELECT $1, field_id, value, updated_at FROM lead_custom_values
          WHERE lead_id = ANY($2::uuid[]) ON CONFLICT (lead_id, field_id) DO NOTHING`,
        [survivor_id, actual],
      );
      await client.query(`DELETE FROM lead_custom_values WHERE lead_id = ANY($1::uuid[])`, [actual]);

      // Soft-delete the losers BEFORE copying their contact details up. The
      // unique indexes on phone / whatsapp / email are partial — scoped to
      // `deleted_at IS NULL` — so filling a blank on the survivor while the
      // loser still holds that value live collides with itself. Retiring the
      // loser first frees the value.
      await client.query(
        `UPDATE leads SET merged_into_id = $1, deleted_at = now() WHERE id = ANY($2::uuid[])`,
        [survivor_id, actual],
      );

      // Now fill blanks on the survivor rather than discarding contact
      // details: the whole reason these rows diverged is usually that one had
      // the number in phone and the other in whatsapp.
      await client.query(
        `UPDATE leads s SET
           phone            = COALESCE(s.phone, m.phone),
           whatsapp_number  = COALESCE(s.whatsapp_number, m.whatsapp_number),
           email            = COALESCE(s.email, m.email)
         FROM (SELECT * FROM leads WHERE id = ANY($2::uuid[]) ORDER BY created_at LIMIT 1) m
         WHERE s.id = $1`,
        [survivor_id, actual],
      );
      await client.query(
        `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json, created_at)
         VALUES ($1,$2,'merge',$3,$4::jsonb, now())`,
        [survivor_id, req.user.id, `Merged ${actual.length} duplicate lead(s) into this one`,
          JSON.stringify({ merged_ids: actual })],
      );
      return { survivor_id, merged: actual.length };
    });

    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) {
    // A unique-index collision here means the survivor cannot hold one of the
    // loser's values. Surface it as something actionable rather than a bare
    // 500 — the recruiter's next move is to pick the other lead as survivor.
    if (err?.code === '23505') {
      return next(conflict(
        'These leads cannot be merged in this direction — try keeping the other one instead.',
      ));
    }
    return next(err);
  }
});

router.post('/:matchId/ignore', requireRole(...MANAGER_TIER_ROLES), validate({ params: z.object({ matchId: z.string().uuid() }) }), async (req, res, next) => {
  try {
    await tenantQuery(
      req.tenant,
      `UPDATE lead_duplicate_matches SET status = 'ignored', reviewed_by = $2, reviewed_at = now() WHERE id = $1 AND status = 'open'`,
      [req.params.matchId, req.user.id],
    );
    res.status(204).end();
  } catch (err) { next(err); }
});

// Merge: move all associated records from merged → surviving, mark merged lead merged_into.
router.post('/lead/:leadId/merge', requireRole(...MANAGER_TIER_ROLES), validate({ params: z.object({ leadId: z.string().uuid() }), body: mergeSchema }), async (req, res, next) => {
  try {
    const merged_lead_id = req.params.leadId;
    const surviving_lead_id = req.body.merge_into_lead_id;
    if (merged_lead_id === surviving_lead_id) throw notFound('Cannot merge a lead into itself');

    const result = await tenantTx(req.tenant, async (client) => {
      const { rows: bothRows } = await client.query(
        `SELECT id FROM leads WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [[merged_lead_id, surviving_lead_id]],
      );
      if (bothRows.length !== 2) throw notFound('One or both leads not found');

      // Transfer lead_activities, lead_notes, lead_followups, lead_assignments, message_log, calls, lead_source_attributions, lead_tags, lead_custom_values, payments, payment_links
      const transfers = [
        'UPDATE lead_activities SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE lead_notes SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE lead_followups SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE lead_assignments SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE message_log SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE calls SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE lead_source_attributions SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE lead_touches SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE payments SET lead_id = $1 WHERE lead_id = $2',
        'UPDATE payment_links SET lead_id = $1 WHERE lead_id = $2',
      ];
      let activityCount = 0; let noteCount = 0; let messageCount = 0;
      for (const sql of transfers) {
        const r = await client.query(sql, [surviving_lead_id, merged_lead_id]);
        if (sql.includes('lead_activities')) activityCount = r.rowCount;
        if (sql.includes('lead_notes')) noteCount = r.rowCount;
        if (sql.includes('message_log')) messageCount = r.rowCount;
      }

      // Tag consolidation: insert distinct new tags.
      await client.query(
        `INSERT INTO lead_tags (lead_id, tag_id, assigned_by, assigned_at)
         SELECT $1, tag_id, assigned_by, assigned_at FROM lead_tags WHERE lead_id = $2
         ON CONFLICT DO NOTHING`,
        [surviving_lead_id, merged_lead_id],
      );
      await client.query(`DELETE FROM lead_tags WHERE lead_id = $1`, [merged_lead_id]);

      // Custom values — survivor wins on conflict.
      await client.query(
        `INSERT INTO lead_custom_values (lead_id, field_id, value, updated_at)
         SELECT $1, field_id, value, updated_at FROM lead_custom_values WHERE lead_id = $2
         ON CONFLICT (lead_id, field_id) DO NOTHING`,
        [surviving_lead_id, merged_lead_id],
      );
      await client.query(`DELETE FROM lead_custom_values WHERE lead_id = $1`, [merged_lead_id]);

      // Field decisions — copy specific fields from merged onto surviving.
      if (req.body.field_decisions) {
        for (const [field, winnerId] of Object.entries(req.body.field_decisions)) {
          if (winnerId === merged_lead_id) {
            await client.query(
              `UPDATE leads s SET ${field} = m.${field} FROM leads m WHERE s.id = $1 AND m.id = $2`,
              [surviving_lead_id, merged_lead_id],
            );
          }
        }
      }

      // Soft-delete merged lead and record merged_into.
      await client.query(
        `UPDATE leads SET merged_into_id = $1, deleted_at = now() WHERE id = $2`,
        [surviving_lead_id, merged_lead_id],
      );

      const { rows: mergeLogRows } = await client.query(
        `INSERT INTO lead_merge_log (surviving_lead_id, merged_lead_id, merged_by, field_decisions_json, activity_count_transferred, note_count_transferred, message_count_transferred)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7) RETURNING *`,
        [surviving_lead_id, merged_lead_id, req.user.id, JSON.stringify(req.body.field_decisions ?? {}), activityCount, noteCount, messageCount],
      );

      if (req.body.resolve_duplicate_match_id) {
        await client.query(
          `UPDATE lead_duplicate_matches SET status = 'merged', reviewed_by = $2, reviewed_at = now() WHERE id = $1`,
          [req.body.resolve_duplicate_match_id, req.user.id],
        );
      }

      await client.query(
        `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
         VALUES ($1,$2,'lead_merged',$3,$4::jsonb)`,
        [surviving_lead_id, req.user.id, 'Lead merged', JSON.stringify({ merged_from: merged_lead_id })],
      );
      return mergeLogRows[0];
    });

    await publish(QUEUE_NAMES.EVENTS, EVENT_TYPES.LEAD_MERGED, {
      type: EVENT_TYPES.LEAD_MERGED,
      tenantId: req.tenant.id,
      occurredAt: new Date().toISOString(),
      actorUserId: req.user.id,
      entityType: 'lead',
      entityId: result.surviving_lead_id,
      payload: { merged_from: result.merged_lead_id },
    });

    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
