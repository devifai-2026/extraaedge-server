/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.sql(`
    -- Custom per-tenant roles with tab-level permissions
    CREATE TABLE custom_roles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      description text,
      scope text NOT NULL,            -- super_admin | sales_manager | counsellor (for hierarchy logic)
      is_system boolean NOT NULL DEFAULT false,
      tab_permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
      feature_permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      UNIQUE (name)
    );
    CREATE TRIGGER trg_custom_roles_updated_at BEFORE UPDATE ON custom_roles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE teams (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      description text,
      manager_id uuid,
      parent_team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON teams (parent_team_id);
    CREATE TRIGGER trg_teams_updated_at BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email citext NOT NULL UNIQUE,
      phone text,
      name text NOT NULL,
      avatar_r2_key text,
      password_hash text NOT NULL,
      role text NOT NULL,                   -- scope hint: super_admin | sales_manager | counsellor
      role_id uuid REFERENCES custom_roles(id) ON DELETE RESTRICT,
      manager_id uuid REFERENCES users(id) ON DELETE SET NULL,
      team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
      is_active boolean NOT NULL DEFAULT true,
      last_login_at timestamptz,
      permissions_json jsonb,               -- overrides on top of role defaults
      session_timeout_minutes integer NOT NULL DEFAULT 15,
      track_work_time boolean NOT NULL DEFAULT true,
      totp_secret text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON users (role_id);
    CREATE INDEX ON users (manager_id);
    CREATE INDEX ON users (team_id);
    CREATE INDEX ON users (deleted_at) WHERE deleted_at IS NOT NULL;
    CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    ALTER TABLE teams ADD CONSTRAINT fk_teams_manager FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL;

    CREATE TABLE team_members (
      team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (team_id, user_id)
    );

    -- Sessions + refresh tokens
    CREATE TABLE user_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ip text,
      user_agent text,
      issued_at timestamptz NOT NULL DEFAULT now(),
      last_activity_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      idle_logout boolean NOT NULL DEFAULT false
    );
    CREATE INDEX ON user_sessions (user_id, last_activity_at DESC);

    CREATE TABLE user_refresh_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id uuid NOT NULL REFERENCES user_sessions(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      rotated_from uuid,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- Work-time tracking
    CREATE TABLE work_activity_minutes (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      minute_bucket timestamptz NOT NULL,
      PRIMARY KEY (user_id, minute_bucket)
    );
    CREATE INDEX ON work_activity_minutes (minute_bucket);

    CREATE TABLE work_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      started_at timestamptz NOT NULL,
      ended_at timestamptz NOT NULL,
      active_minutes integer NOT NULL,
      idle_logout boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON work_sessions (user_id, started_at DESC);

    -- Field-level permissions (role + entity + field -> hidden/readonly/readwrite)
    CREATE TABLE field_permissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      role_id uuid REFERENCES custom_roles(id) ON DELETE CASCADE,
      role text,                     -- fallback scope label when role_id is null
      entity text NOT NULL,          -- lead | user | program
      field text NOT NULL,           -- column name OR custom field key
      permission text NOT NULL,      -- hidden | readonly | readwrite
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX field_permissions_unique ON field_permissions (COALESCE(role_id::text, ''), role, entity, field);
    CREATE TRIGGER trg_field_permissions_updated_at BEFORE UPDATE ON field_permissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS field_permissions;
    DROP TABLE IF EXISTS work_sessions;
    DROP TABLE IF EXISTS work_activity_minutes;
    DROP TABLE IF EXISTS user_refresh_tokens;
    DROP TABLE IF EXISTS user_sessions;
    DROP TABLE IF EXISTS team_members;
    ALTER TABLE teams DROP CONSTRAINT IF EXISTS fk_teams_manager;
    DROP TABLE IF EXISTS users CASCADE;
    DROP TABLE IF EXISTS teams;
    DROP TABLE IF EXISTS custom_roles;
  `);
};
