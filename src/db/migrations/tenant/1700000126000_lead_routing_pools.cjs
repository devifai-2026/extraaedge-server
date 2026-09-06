/* eslint-disable camelcase */
// Source-based lead distribution: route incoming leads to a named person or a
// named GROUP of people, per acquisition channel.
//
//   "WhatsApp                        -> Person X"
//   "WhatsApp + Facebook + Instagram -> Person Z + Person B"
//
// Why a new table rather than reusing `assignment_rules`: that table permits
// only ONE active rule per tenant (see modules/assignment-rules/routes.js,
// which deactivates every other rule on PUT) and refuses create/delete with a
// 405 — six fixed templates only. The two examples above must coexist, so they
// cannot both be assignment rules. Routing pools run BEFORE the
// assignment_rules engine and fall through to it when nothing matches, so the
// existing round-robin behaviour is untouched for tenants that configure no
// pools.
//
// `member_ids` is a bare uuid[] with no FK, deliberately mirroring
// `assignment_rules.target_users`: a member who is deactivated, or switched to
// a role that cannot own leads, must never require deleting a row here.
// Eligibility is re-checked at read time against LEAD_OWNER_ROLES instead.
//
// `origins` holds values from LEAD_ORIGINS (src/lib/leadOrigin.js) —
// whatsapp | instagram | facebook | justdial | website. Origin is derived from
// leads.first_touch_channel / first_touch_source, not stored on the lead.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE lead_routing_pools (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      -- Which acquisition channels this pool claims. Values from LEAD_ORIGINS.
      origins text[] NOT NULL DEFAULT '{}',
      -- The chosen names. Order is preserved so round-robin is deterministic.
      member_ids uuid[] NOT NULL DEFAULT '{}',
      -- load_balanced: fewest leads from this origin wins (the JustDial rule).
      -- round_robin:   next member after last_assigned_user_id.
      strategy text NOT NULL DEFAULT 'load_balanced',
      -- Lower number wins, matching assignment_rules.priority semantics.
      priority integer NOT NULL DEFAULT 100,
      is_active boolean NOT NULL DEFAULT true,
      -- Round-robin cursor + counter, kept on the row (no separate state
      -- table — there is exactly one cursor per pool).
      last_assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      last_assigned_at timestamptz,
      total_assignments integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT lead_routing_pools_strategy_chk
        CHECK (strategy IN ('load_balanced', 'round_robin'))
    );

    -- The resolver's hot path: active pools ordered by priority.
    CREATE INDEX lead_routing_pools_active_idx
      ON lead_routing_pools (priority, created_at)
      WHERE is_active AND deleted_at IS NULL;
    -- Membership lookup, for "which pools still reference this user?" on a
    -- role switch or deactivation.
    CREATE INDEX lead_routing_pools_members_idx
      ON lead_routing_pools USING gin (member_ids);
    CREATE INDEX lead_routing_pools_origins_idx
      ON lead_routing_pools USING gin (origins);

    CREATE TRIGGER trg_lead_routing_pools_updated_at
      BEFORE UPDATE ON lead_routing_pools
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS lead_routing_pools;`);
};
