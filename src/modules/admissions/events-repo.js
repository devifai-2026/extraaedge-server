// Append-only event log for admissions. See migration
// 1700000040000_admission_events for the schema rationale.
//
// Every write is wrapped at the call-site in try/catch so an audit
// failure NEVER blocks the underlying admission mutation — the row
// of truth is the admissions table; this log is a best-effort timeline.
import { tenantQuery } from '../../db/tenant.js';
import { logger } from '../../lib/logger.js';

export const EVENT_TYPES = Object.freeze({
  CREATED: 'created',
  STATUS_CHANGED: 'status_changed',
  RECEIPT_ADDED: 'receipt_added',
  RECEIPT_DELETED: 'receipt_deleted',
  FIELD_EDITED: 'field_edited',
  PHOTO_UPLOADED: 'photo_uploaded',
  NOTE_ADDED: 'note_added',
});

export const ACTOR_KINDS = Object.freeze({
  USER: 'user',
  STUDENT: 'student', // public link submission
  SYSTEM: 'system',
});

// Best-effort log emitter. Swallows errors so admission writes can't
// be blocked by a flaky audit insert. Returns the inserted row or null.
export const log = async (tenant, {
  admission_id, lead_id = null,
  event_type, prev_status = null, next_status = null,
  actor_user_id = null, actor_kind = ACTOR_KINDS.SYSTEM,
  summary = null, metadata = null,
}) => {
  try {
    const { rows } = await tenantQuery(
      tenant,
      `INSERT INTO admission_events
         (admission_id, lead_id, event_type, prev_status, next_status,
          actor_user_id, actor_kind, summary, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       RETURNING id, occurred_at`,
      [
        admission_id, lead_id, event_type, prev_status, next_status,
        actor_user_id, actor_kind, summary,
        metadata != null ? JSON.stringify(metadata) : null,
      ],
    );
    return rows[0];
  } catch (err) {
    logger.warn({ err: err.message, admission_id, event_type }, 'admission_events.log failed');
    return null;
  }
};

// Fetch all events for one admission, newest first. Joined to users so
// the FE can render the actor name without a second roundtrip.
export const listByAdmission = async (tenant, admission_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT e.id, e.event_type, e.prev_status, e.next_status,
            e.actor_user_id, e.actor_kind, e.summary, e.metadata, e.occurred_at,
            u.name AS actor_name, u.email AS actor_email
       FROM admission_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.admission_id = $1
      ORDER BY e.occurred_at DESC, e.id DESC`,
    [admission_id],
  );
  return rows;
};
