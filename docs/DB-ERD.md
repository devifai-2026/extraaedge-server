# Database Design — ExtraaEdge Server

This is a **multi-tenant SaaS CRM** for admissions/lead management. The data is split across
**two physically separate PostgreSQL clusters** plus a MongoDB log store, all wired up via the
`.env` connection strings.

## Architecture (from `.env`)

```mermaid
flowchart LR
    subgraph App["Node/Express App (PORT 3000)"]
      sys[(System Pool<br/>db.system.js)]
      ten[(Per-Tenant Pool<br/>db.tenant.js)]
      mongo[(API Log Writer)]
    end

    sys -->|DATABASE_URL / DIRECT_URL| SUPA[("Supabase Postgres<br/>aws-1-ap-northeast-2<br/>SYSTEM / control-plane DB")]
    ten -->|db_host 34.100.214.128| GCP[("GCP Postgres<br/>one DB per tenant<br/>data-plane")]
    mongo -->|MONGO_URI| MDB[("MongoDB Atlas<br/>pre-release-grid<br/>API request logs")]

    App -->|GCS_*| GCS[["Google Cloud Storage<br/>bucket: pre-release-grid<br/>uploads / recordings / exports"]]
    App -->|MESSAGECENTRAL_*| OTP[["MessageCentral<br/>OTP / SMS"]]
    App -->|cloud_*| CLD[["Cloudinary<br/>image CDN"]]
```

The **System DB** holds tenants, platform users, plans, billing, and cross-tenant audit/logs.
Each tenant's `tenants.db_name` / `db_user` / `db_password_encrypted` row tells the app how to
connect to that tenant's **own database** on the GCP cluster. The two databases are linked only
by `tenant_id` / `tenant_user_id` references that are **not** SQL foreign keys (they cross DB
boundaries) — shown below as dashed relationships.

---

## System DB (control plane — Supabase)

```mermaid
erDiagram
    plans ||--o{ tenants : "billed on"
    tenants ||--o{ impersonation_sessions : "target of"
    tenants ||--o{ platform_audit_log : "scoped to"
    tenants ||--o{ platform_request_log : "scoped to"
    tenants ||--o{ support_tickets : "raised by"
    tenants ||--o{ public_admission_tokens : "for"

    platform_users ||--o{ platform_user_sessions : "has"
    platform_users ||--o{ impersonation_sessions : "performs"
    platform_users ||--o{ platform_audit_log : "acts in"
    platform_users ||--o{ support_tickets : "assigned"
    support_tickets ||--o{ support_ticket_comments : "has"

    plans {
        uuid id PK
        text name UK
        numeric price_monthly
        jsonb features_json
        int included_email_credits
        int included_sms_credits
        int included_whatsapp_credits
        int max_users
        int max_leads
        bool is_public
    }

    tenants {
        uuid id PK
        text name
        text slug UK
        text brand_name
        text logo_url
        citext email
        uuid plan_id FK
        text status "provisioning|active|suspended|cancelled"
        timestamptz trial_ends_at
        text timezone
        text currency
        text db_name UK "tenant DB on GCP"
        text db_user
        text db_password_encrypted "AES-256-GCM"
        text_arr ip_allowlist
        bool require_2fa
        uuid provisioned_by_platform_user_id
        timestamptz deleted_at
    }

    platform_users {
        uuid id PK
        text name
        citext email UK
        text password_hash
        text role "product_owner|support_admin"
        bool is_active
        text totp_secret
        timestamptz last_login_at
    }

    platform_user_sessions {
        uuid id PK
        uuid platform_user_id FK
        text refresh_token_hash UK
        timestamptz expires_at
        timestamptz revoked_at
        text ip
    }

    impersonation_sessions {
        uuid id PK
        uuid platform_user_id FK
        uuid tenant_id FK
        uuid tenant_user_id "ref tenant.users(id)"
        citext tenant_user_email
        text reason
        bool read_only
        timestamptz started_at
        timestamptz ended_at
    }

    platform_audit_log {
        uuid id PK
        uuid platform_user_id FK
        text action
        text entity_type
        uuid entity_id
        uuid tenant_id FK
        jsonb before_json
        jsonb after_json
    }

    platform_request_log {
        uuid id PK
        text request_id
        uuid actor_user_id "tenant or platform user"
        citext actor_email
        bool is_platform_actor
        uuid tenant_id FK
        text method
        text path
        int status_code
        int duration_ms
        jsonb request_body "redacted"
        jsonb response_body "redacted"
        text category
    }

    support_tickets {
        uuid id PK
        uuid tenant_id FK
        uuid tenant_ticket_id "mirrors tenant.tickets(id)"
        uuid raised_by_user_id
        text raised_by_email "snapshot"
        text subject
        text priority
        text status "open|in_progress|resolved|closed"
        uuid assigned_to_platform_user_id FK
        timestamptz resolved_at
    }

    support_ticket_comments {
        uuid id PK
        uuid support_ticket_id FK
        uuid platform_user_id FK
        uuid tenant_user_id
        text author_name
        text body
    }

    public_admission_tokens {
        uuid id PK
        text token UK
        uuid tenant_id FK
        uuid lead_id "ref tenant.leads(id)"
        uuid created_by_user_id
        timestamptz expires_at "24h"
        timestamptz used_at
    }
```

---

## Tenant DB — Identity, Access & Work Tracking

```mermaid
erDiagram
    custom_roles ||--o{ users : "assigned"
    custom_roles ||--o{ field_permissions : "restricts"
    teams ||--o{ users : "belongs to"
    teams ||--o{ teams : "parent of"
    users ||--o{ teams : "manages"
    users ||--o{ team_members : "member"
    teams ||--o{ team_members : "has"
    users ||--o{ users : "manager of"
    users ||--o{ user_managers : "primary"
    users ||--o{ user_managers : "secondary mgr"
    users ||--o{ user_sessions : "has"
    user_sessions ||--o{ user_refresh_tokens : "rotates"
    users ||--o{ user_refresh_tokens : "owns"
    users ||--o{ work_sessions : "tracks"
    users ||--o{ work_activity_minutes : "buckets"
    users ||--o{ user_login_events : "logs"

    custom_roles {
        uuid id PK
        text name UK
        text scope "super_admin|sales_manager|counsellor"
        bool is_system
        jsonb tab_permissions
        jsonb feature_permissions
    }
    teams {
        uuid id PK
        text name
        uuid manager_id FK
        uuid parent_team_id FK
    }
    users {
        uuid id PK
        citext email UK
        text name
        text password_hash
        text role
        uuid role_id FK
        uuid manager_id FK
        uuid team_id FK
        bool is_active
        jsonb permissions_json
        int session_timeout_minutes
        bool track_work_time
        text totp_secret
    }
    team_members {
        uuid team_id PK,FK
        uuid user_id PK,FK
        timestamptz joined_at
    }
    user_managers {
        uuid user_id PK,FK
        uuid manager_id PK,FK
    }
    user_sessions {
        uuid id PK
        uuid user_id FK
        text ip
        timestamptz expires_at
        timestamptz revoked_at
        bool idle_logout
    }
    user_refresh_tokens {
        uuid id PK
        uuid user_id FK
        uuid session_id FK
        text token_hash UK
        uuid rotated_from
        timestamptz expires_at
    }
    work_sessions {
        uuid id PK
        uuid user_id FK
        timestamptz started_at
        timestamptz ended_at
        int active_minutes
        text status "active|paused|stopped"
        int paused_seconds
        timestamptz last_heartbeat_at
    }
    work_activity_minutes {
        uuid user_id PK,FK
        timestamptz minute_bucket PK
    }
    user_login_events {
        uuid id PK
        uuid user_id FK
        text kind "login|logout|expired"
        uuid session_id
        text ip
    }
    field_permissions {
        uuid id PK
        uuid role_id FK
        text entity "lead|user|program"
        text field
        text permission "hidden|readonly|readwrite"
    }
```

---

## Tenant DB — Dictionaries, Programs & Custom Fields

```mermaid
erDiagram
    lead_stages ||--o{ lead_sub_stages : "has"
    countries ||--o{ states : "has"
    countries ||--o{ universities : "located in"

    lead_stages {
        uuid id PK
        text name
        text code UK
        int order_index
        text color
        bool is_terminal
        int score
    }
    lead_sub_stages {
        uuid id PK
        uuid stage_id FK
        text name
        bool is_default
        int score
    }
    lead_channels { uuid id PK; text name UK }
    lead_sources_dict { uuid id PK; text name UK }
    lead_campaigns_dict { uuid id PK; text name UK }
    lead_mediums { uuid id PK; text name UK }
    countries { uuid id PK; text name UK; text iso }
    states { uuid id PK; uuid country_id FK; text name }
    genders { uuid id PK; text name UK }
    degrees { uuid id PK; text level; text name }
    specializations { uuid id PK; text name UK }
    universities { uuid id PK; text name UK; uuid country_id FK }
    programs {
        uuid id PK
        text name
        text code UK
        text category "abroad|domestic|coaching"
        text type "online|offline|hybrid"
        numeric price
        text intake_month
        bool is_featured
    }
    tags { uuid id PK; text name UK; text color; uuid created_by FK }
    custom_field_definitions {
        uuid id PK
        text entity "lead|user|program"
        text key
        text field_type
        jsonb options_json
        jsonb validation_json
        bool is_required
    }
```

---

## Tenant DB — Leads (the core entity)

```mermaid
erDiagram
    leads ||--o| lead_family : "has"
    leads ||--o{ lead_source_attributions : "attributed via"
    leads ||--o{ lead_assignments : "assigned through"
    leads ||--o{ lead_activities : "timeline"
    leads ||--o{ lead_notes : "annotated"
    leads ||--o{ lead_followups : "scheduled"
    leads ||--o{ lead_tags : "tagged"
    leads ||--o{ lead_custom_values : "custom data"
    leads ||--o{ lead_touches : "touchpoints"
    leads ||--o{ lead_duplicate_matches : "matched"
    leads ||--o{ lead_merge_log : "merged"
    leads ||--o{ leads : "referred by / merged into"

    users ||--o{ leads : "assigned_to / created_by / manager"
    lead_stages ||--o{ leads : "current stage"
    lead_sub_stages ||--o{ leads : "current sub-stage"
    programs ||--o{ leads : "interested in"
    tags ||--o{ lead_tags : "applied"
    custom_field_definitions ||--o{ lead_custom_values : "defines"

    leads {
        uuid id PK
        text name
        citext email
        text phone
        text whatsapp_number
        uuid ug_degree_id FK
        uuid ug_university_id FK
        uuid pg_degree_id FK
        uuid country_id FK
        uuid state_id FK
        uuid program_id FK
        uuid stage_id FK
        uuid sub_stage_id FK
        uuid assigned_to FK
        uuid team_id FK
        uuid manager_id FK
        uuid created_by FK
        numeric lead_score
        numeric engagement_score
        uuid referred_by_lead_id FK
        text first_touch_channel
        text last_touch_channel
        timestamptz converted_at
        uuid merged_into_id FK
        bool is_cold
        timestamptz last_activity_at
        timestamptz deleted_at
    }
    lead_family {
        uuid id PK
        uuid lead_id FK,UK
        text father_name
        text mother_name
        text guardian_name
    }
    lead_source_attributions {
        uuid id PK
        uuid lead_id FK
        uuid channel_id FK
        uuid source_id FK
        uuid campaign_id FK
        uuid medium_id FK
        bool is_primary
    }
    lead_assignments {
        uuid id PK
        uuid lead_id FK
        uuid from_user_id FK
        uuid assigned_to FK
        uuid assigned_by FK
        text assignment_type "assign|reassign|auto_assign|refer|unassign"
        bool is_active "one active per lead"
    }
    lead_activities {
        uuid id PK
        uuid lead_id FK
        uuid user_id FK
        text type
        text summary
        jsonb metadata_json
    }
    lead_notes {
        uuid id PK
        uuid lead_id FK
        uuid user_id FK
        text body
        text visibility
        jsonb attachments
    }
    lead_followups {
        uuid id PK
        uuid lead_id FK
        timestamptz next_action_datetime
        uuid stage_id FK
        text status "planned|done|missed|cancelled"
        uuid created_by FK
        text recurrence_rule "RRULE"
        uuid recurrence_parent_id FK
        timestamptz reminder_sent_at
    }
    lead_tags {
        uuid lead_id PK,FK
        uuid tag_id PK,FK
        uuid assigned_by FK
    }
    lead_custom_values {
        uuid lead_id PK,FK
        uuid field_id PK,FK
        jsonb value
    }
    lead_touches {
        uuid id PK
        uuid lead_id FK
        text touch_type
        uuid campaign_id
        text channel
        timestamptz occurred_at
    }
    lead_duplicate_matches {
        uuid id PK
        uuid lead_a_id FK
        uuid lead_b_id FK
        text match_on "phone|email|whatsapp|composite"
        numeric confidence
        text status "open|ignored|merged"
    }
    lead_merge_log {
        uuid id PK
        uuid surviving_lead_id FK
        uuid merged_lead_id FK
        uuid merged_by FK
        jsonb field_decisions_json
    }
    saved_filters {
        uuid id PK
        uuid user_id FK
        text name
        jsonb filter_json
        bool is_shared
    }
```

---

## Tenant DB — Communications & Credits

```mermaid
erDiagram
    leads ||--o{ message_log : "sent to"
    leads ||--o{ message_reply : "replied"
    leads ||--o{ optin_log : "consent"
    users ||--o{ message_log : "sent by"
    users ||--o{ scheduled_sends : "scheduled by"
    whatsapp_numbers ||--o{ whatsapp_quota : "limited by"
    subscription_credits ||--o{ credit_transactions : "ledger"
    email_templates ||--o{ message_log : "rendered"
    sms_templates ||--o{ message_log : "rendered"
    whatsapp_templates ||--o{ message_log : "rendered"

    email_templates {
        uuid id PK
        text name
        text subject
        text body_html
        text status "Published|Draft|Archived"
        uuid created_by FK
    }
    sms_templates {
        uuid id PK
        text name
        text body
        text dlt_template_id
        uuid created_by FK
    }
    whatsapp_templates {
        uuid id PK
        text wabridge_template_name
        text category "MARKETING|UTILITY|AUTHENTICATION"
        text status "APPROVED|PENDING|REJECTED"
    }
    template_variables {
        uuid id PK
        text key UK
        text resolver_function
        text_arr scope
    }
    message_log {
        uuid id PK
        uuid lead_id FK
        uuid user_id FK
        text channel "email|sms|whatsapp"
        uuid template_id
        text recipient
        text provider
        text status "queued|sent|delivered|failed|seen|..."
        uuid campaign_id
        uuid workflow_run_id
        timestamptz sent_at
    }
    message_reply {
        uuid id PK
        uuid lead_id FK
        text channel
        text body
        uuid routed_to_user_id FK
        bool is_read
    }
    suppression_list {
        uuid id PK
        text channel
        text address
        text reason "unsubscribe|hard_bounce|stop_keyword|..."
    }
    optin_log {
        uuid id PK
        uuid lead_id FK
        text channel
        timestamptz opted_in_at
        timestamptz opted_out_at
    }
    whatsapp_numbers {
        uuid id PK
        text phone UK
        text wabridge_phone_number_id
        bool is_default
    }
    whatsapp_quota {
        uuid id PK
        uuid whatsapp_number_id FK
        int monthly_business_limit
        int daily_business_used
    }
    subscription_credits {
        uuid id PK
        text credit_type UK "email|sms|whatsapp_business|whatsapp_session"
        numeric balance
        numeric monthly_allocation
    }
    credit_transactions {
        uuid id PK
        text credit_type
        numeric amount
        text reason
        uuid ref_id
    }
    scheduled_sends {
        uuid id PK
        uuid user_id FK
        text channel
        uuid template_id
        uuid_arr lead_ids
        timestamptz scheduled_for
        text status "scheduled|running|completed|cancelled|failed"
    }
```

---

## Tenant DB — Campaigns & Workflows

```mermaid
erDiagram
    email_templates ||--o{ campaigns_bulk : "uses"
    sms_templates ||--o{ campaigns_bulk : "uses"
    whatsapp_templates ||--o{ campaigns_bulk : "uses"
    campaigns_bulk ||--|| campaigns_bulk_stats : "summarized by"
    campaigns_drip ||--o{ campaigns_drip_rules : "has steps"
    campaigns_drip ||--o{ campaigns_drip_runs : "executes"
    campaigns_drip_rules ||--o{ campaigns_drip_runs : "via step"
    leads ||--o{ campaigns_drip_runs : "enrolled"
    message_log ||--o{ campaigns_drip_runs : "produces"

    workflow_categories ||--o{ workflows : "groups"
    workflows ||--o{ workflow_nodes : "has"
    workflows ||--o{ workflow_edges : "has"
    workflow_nodes ||--o{ workflow_edges : "from/to"
    workflows ||--o{ workflow_runs : "executes"
    workflow_runs ||--o{ workflow_run_events : "logs"
    leads ||--o{ workflow_runs : "for lead"

    campaigns_bulk {
        uuid id PK
        text name
        text stage "DRAFT|IN_PROGRESS|COMPLETED|STOPPED"
        text channel "email|sms|whatsapp|multi"
        jsonb audience_filter_json
        uuid email_template_id FK
        uuid sms_template_id FK
        uuid whatsapp_template_id FK
        timestamptz scheduled_at
        uuid created_by FK
    }
    campaigns_bulk_stats {
        uuid campaign_id PK,FK
        int leads_count
        int email_delivered
        int sms_delivered
        int wa_delivered
    }
    campaigns_drip {
        uuid id PK
        text name
        bool active
        uuid created_by FK
    }
    campaigns_drip_rules {
        uuid id PK
        uuid drip_id FK
        int step_order
        int day_offset
        text channel
        uuid template_id
        jsonb condition_json
    }
    campaigns_drip_runs {
        uuid id PK
        uuid drip_id FK
        uuid lead_id FK
        uuid step_id FK
        text status "queued|sent|failed|skipped"
        uuid message_log_id FK
    }
    workflow_categories { uuid id PK; text name UK }
    workflows {
        uuid id PK
        text name
        uuid category_id FK
        text_arr trigger_event_types
        bool is_active
        uuid created_by FK
    }
    workflow_nodes {
        uuid id PK
        uuid workflow_id FK
        text type "trigger|action|condition|wait"
        jsonb config_json
    }
    workflow_edges {
        uuid id PK
        uuid workflow_id FK
        uuid from_node_id FK
        uuid to_node_id FK
        text label
    }
    workflow_runs {
        uuid id PK
        uuid workflow_id FK
        uuid lead_id FK
        text status "running|succeeded|failed|cancelled"
        uuid current_node_id FK
        jsonb context_json
    }
    workflow_run_events {
        uuid id PK
        uuid run_id FK
        uuid node_id FK
        text event_type
        jsonb payload_json
    }
```

---

## Tenant DB — Rules, SLA, Assignment, Calls

```mermaid
erDiagram
    assignment_rules ||--|| assignment_rule_state : "round-robin state"
    teams ||--o{ assignment_rules : "targets"
    users ||--o{ assignment_rules : "fallback"
    sla_policies ||--o{ sla_alerts : "raises"
    leads ||--o{ sla_alerts : "flagged"
    users ||--o{ sla_alerts : "assigned"
    leads ||--o{ calls : "called"
    users ||--o{ calls : "by agent"
    call_dispositions ||--o{ calls : "categorizes"

    assignment_rules {
        uuid id PK
        text name
        int priority
        jsonb condition_json
        text strategy "round_robin|load_balanced|by_geography|..."
        uuid_arr target_users
        uuid target_team_id FK
        uuid fallback_user_id FK
        bool is_active
    }
    assignment_rule_state {
        uuid rule_id PK,FK
        uuid last_assigned_user_id FK
        int total_assignments
    }
    lead_score_config {
        uuid id PK
        text name
        text criterion
        jsonb condition_json
        int points
    }
    rules {
        uuid id PK
        text name
        text_arr event_types
        jsonb condition_json
        jsonb action_json
        int priority
    }
    sla_policies {
        uuid id PK
        text name
        int no_activity_hours
        int escalate_after_hours
        jsonb action_json
    }
    sla_alerts {
        uuid id PK
        uuid policy_id FK
        uuid lead_id FK
        uuid assigned_to FK
        timestamptz flagged_at
        timestamptz escalated_at
        timestamptz resolved_at
    }
    call_dispositions {
        uuid id PK
        text code UK
        text category "positive|neutral|negative"
        bool requires_callback
        int auto_create_followup_hours
    }
    calls {
        uuid id PK
        uuid lead_id FK
        uuid user_id FK
        text direction "outbound|inbound"
        text status "queued|...|completed|missed|failed"
        int duration_seconds
        text recording_r2_key
        text provider "exotel"
        text disposition_code FK
        timestamptz started_at
    }
```

---

## Tenant DB — Payments, Referrals, Attribution

```mermaid
erDiagram
    leads ||--o{ payment_links : "billed"
    leads ||--o{ payments : "pays"
    payment_links ||--o{ payments : "fulfilled by"
    payments ||--|| payment_attributions : "attributed"
    leads ||--o{ lead_referral_codes : "owns code"
    referral_policies ||--o{ referral_credits : "governs"
    leads ||--o{ referral_credits : "referrer"
    leads ||--o{ referral_credits : "referred"

    payment_links {
        uuid id PK
        uuid lead_id FK
        numeric amount
        text provider "razorpay"
        text provider_link_id
        text status "created|paid|expired|cancelled"
        uuid created_by FK
    }
    payments {
        uuid id PK
        uuid lead_id FK
        uuid payment_link_id FK
        numeric amount
        text provider_payment_id UK
        text status "captured|failed|refunded|pending"
        text method "card|upi|netbanking"
        timestamptz paid_at
        jsonb raw_webhook_json
    }
    payment_webhook_log {
        uuid id PK
        text provider
        text event_type
        jsonb body_json
        timestamptz processed_at
    }
    payment_attributions {
        uuid payment_id PK,FK
        uuid lead_id FK
        uuid first_touch_campaign_id
        uuid last_touch_campaign_id
        numeric amount_attributed_first
        numeric amount_attributed_last
        text attribution_model "50_50"
    }
    lead_referral_codes {
        uuid id PK
        uuid lead_id FK
        text code UK
        int uses_count
        int max_uses
        bool is_active
    }
    referral_policies {
        uuid id PK
        text name
        text trigger "lead_created|payment_succeeded|enrolled"
        text credit_type "points|cash|discount|custom"
        numeric credit_amount
    }
    referral_credits {
        uuid id PK
        uuid referrer_lead_id FK
        uuid referred_lead_id FK
        uuid policy_id FK
        text status "pending|credited|revoked"
        timestamptz triggered_at
    }
```

---

## Tenant DB — Integrations, Webhooks, OTP & Ops

```mermaid
erDiagram
    integrations ||--o{ inbound_webhooks : "exposes"
    integrations ||--o{ webhook_events : "receives"
    outbound_webhooks ||--o{ outbound_webhook_deliveries : "delivers"
    fb_ad_accounts ||--o{ fb_audiences : "owns"
    leads ||--o{ otp_verifications : "verifies"
    users ||--o{ otp_verifications : "verifies"
    users ||--o{ uploaded_files : "uploads"
    users ||--o{ bulk_imports : "runs"
    bulk_import_previews ||--o{ bulk_imports : "previewed"
    bulk_imports ||--o{ bulk_import_failures : "rejected rows"
    users ||--o{ bulk_exports : "exports"
    users ||--o{ tickets : "raises"
    tickets ||--o{ ticket_comments : "discussed"
    users ||--o{ notifications : "notified"
    users ||--|| notification_preferences : "configures"

    integrations {
        uuid id PK
        text type "facebook_ads|google_ads|zapier|..."
        text name
        jsonb credentials_encrypted
        text status "published|unpublished|error"
    }
    inbound_webhooks {
        uuid id PK
        uuid integration_id FK
        text secret_token UK
        jsonb field_mapping_json
        int hit_count
    }
    webhook_events {
        uuid id PK
        uuid integration_id FK
        jsonb payload_json
        text status "pending|processed|failed"
    }
    outbound_webhooks {
        uuid id PK
        text name
        text target_url
        text_arr event_types
        jsonb retry_config_json
    }
    outbound_webhook_deliveries {
        uuid id PK
        uuid webhook_id FK
        text event_type
        int attempt
        text status "pending|delivered|failed|dead"
        timestamptz next_retry_at
    }
    fb_ad_accounts {
        uuid id PK
        text ad_account_id UK
        text access_token_encrypted
    }
    fb_audiences {
        uuid id PK
        uuid fb_ad_account_id FK
        jsonb audience_filter_json
        text sync_status "pending|synced|failed"
    }
    otp_verifications {
        uuid id PK
        uuid lead_id FK
        uuid user_id FK
        text purpose "mobile_verify|email_verify|2fa"
        text channel "sms|email"
        text otp_hash
        timestamptz expires_at
    }
    business_hours {
        uuid id PK
        int day_of_week "0-6"
        bool is_open
        time open_time
        time close_time
    }
    holidays { uuid id PK; date date UK; text name }
    uploaded_files {
        uuid id PK
        uuid user_id FK
        text r2_key UK
        text purpose "avatar|brochure|recording|..."
        text ref_entity_type
        uuid ref_entity_id
    }
    bulk_import_previews {
        uuid id PK
        uuid user_id FK
        jsonb field_mapping_json
        int total_rows
        int valid_rows
        int duplicate_rows
    }
    bulk_imports {
        uuid id PK
        uuid user_id FK
        uuid preview_id FK
        text source "csv|webhook|api"
        text status "queued|processing|completed|failed"
        text duplicate_handling "skip|update_existing|create_new"
    }
    bulk_import_failures {
        uuid id PK
        uuid import_id FK
        int row_number
        jsonb raw_row_json
        text error_message
    }
    bulk_exports {
        uuid id PK
        uuid user_id FK
        jsonb filter_json
        text status "queued|processing|completed|failed"
        text file_r2_key
    }
    audit_log {
        uuid id PK
        uuid user_id FK
        text actor_type "tenant_user|platform_owner|system"
        text action
        text entity_type
        uuid entity_id
    }
    tickets {
        uuid id PK
        uuid user_id FK
        text subject
        text priority "low|normal|high|urgent"
        text status "open|in_progress|resolved|closed"
        uuid assigned_to_platform_user_id
    }
    ticket_comments {
        uuid id PK
        uuid ticket_id FK
        uuid user_id FK
        uuid platform_user_id
        text body
    }
    notifications {
        uuid id PK
        uuid user_id FK
        text type
        text message
        bool is_read
    }
    notification_preferences {
        uuid user_id PK,FK
        bool in_app
        bool email
        bool sms
        text digest_frequency "immediate|hourly|daily"
    }
```

---

## Cross-database links (not SQL FKs)

These references span the System and Tenant databases, so they are application-enforced only:

| From (System DB) | Field | To (Tenant DB) |
|---|---|---|
| `tenants` | `db_name` / `db_user` / `db_password_encrypted` | the tenant's entire database on GCP |
| `impersonation_sessions` | `tenant_user_id`, `tenant_user_email` | `users.id` / `users.email` |
| `support_tickets` | `tenant_ticket_id`, `raised_by_user_id` | `tickets.id` / `users.id` |
| `public_admission_tokens` | `lead_id` | `leads.id` |
| `platform_request_log` | `actor_user_id` | `users.id` (tenant) or `platform_users.id` |
| `tickets` (tenant) | `assigned_to_platform_user_id` | `platform_users.id` (system) |
