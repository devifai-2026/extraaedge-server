export const PLATFORM_ROLES = Object.freeze({
  PRODUCT_OWNER: 'product_owner',
  SUPPORT_ADMIN: 'support_admin',
});

export const SYSTEM_TENANT_ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  SALES_MANAGER: 'sales_manager',
  COUNSELLOR: 'counsellor',
  // Tenant-level role for staff who handle CONVERTED leads (post-enrollment
  // account management). No team beneath them, no reporting manager — they
  // report directly to the tenant's super_admin. Scoped lead visibility:
  // they only see leads where converted_at IS NOT NULL.
  ACCOUNT_MANAGER: 'account_manager',
});

export const TENANT_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  CANCELLED: 'cancelled',
  PROVISIONING: 'provisioning',
});

export const LEAD_STAGE_CODES = Object.freeze({
  NEW: '01-New',
  CONTACTED: '02-Contacted',
  FOLLOWUP: '03-Followup',
  QUALIFIED: '05-Qualified',
  REQUIREMENT_MATCH: '07-Requirement-Match',
  INTERESTED: '08-Interested',
  VISITED: '09-Visited',
  ENROLLED: '10-Enrolled',
  JUNK: '11-Junk',
  COLD: '12-Cold',
});

export const CALL_DISPOSITIONS = Object.freeze({
  CONNECTED: { code: 'Connected', label: 'Connected', category: 'positive', requires_callback: false },
  RNR: { code: 'RNR', label: 'Ringing – No Answer', category: 'neutral', requires_callback: true, auto_followup_hours: 4 },
  BUSY: { code: 'Busy', label: 'Line Busy', category: 'neutral', requires_callback: true, auto_followup_hours: 2 },
  WRONG_NUMBER: { code: 'Wrong_Number', label: 'Wrong Number', category: 'negative', requires_callback: false },
  LANGUAGE_BARRIER: { code: 'Language_Barrier', label: 'Language Barrier', category: 'neutral', requires_callback: false },
  NOT_INTERESTED: { code: 'Not_Interested', label: 'Not Interested', category: 'negative', requires_callback: false },
  CALLBACK_REQUESTED: { code: 'Callback_Requested', label: 'Callback Requested', category: 'positive', requires_callback: true, auto_followup_hours: 24 },
  DEMO_SCHEDULED: { code: 'Demo_Scheduled', label: 'Demo Scheduled', category: 'positive', requires_callback: false },
  ENROLLED: { code: 'Enrolled', label: 'Enrolled', category: 'positive', requires_callback: false },
});

export const SENSITIVE_HEADER_KEYS = Object.freeze([
  'authorization',
  'cookie',
  'x-api-key',
  'x-tenant-slug',
]);

export const RESPONSE_CODES = Object.freeze({
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  CONCURRENT_MODIFICATION: 'CONCURRENT_MODIFICATION',
  RATE_LIMITED: 'RATE_LIMITED',
  DUPLICATE_DETECTED: 'DUPLICATE_DETECTED',
  FIELD_READONLY: 'FIELD_READONLY',
  SESSION_IDLE: 'SESSION_IDLE',
  TENANT_SUSPENDED: 'TENANT_SUSPENDED',
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  INTERNAL: 'INTERNAL',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  NO_OPTIN: 'NO_OPTIN',
  SUPPRESSED: 'SUPPRESSED',
});

export const EVENT_TYPES = Object.freeze({
  LEAD_CREATED: 'lead.created',
  LEAD_UPDATED: 'lead.updated',
  LEAD_STAGE_CHANGED: 'lead.stage_changed',
  LEAD_ASSIGNED: 'lead.assigned',
  LEAD_MERGED: 'lead.merged',
  FOLLOWUP_SCHEDULED: 'follow_up.scheduled',
  FOLLOWUP_DUE: 'follow_up.due',
  FOLLOWUP_COMPLETED: 'follow_up.completed',
  FOLLOWUP_MISSED: 'follow_up.missed',
  MESSAGE_QUEUED: 'message.queued',
  MESSAGE_SENT: 'message.sent',
  MESSAGE_DELIVERED: 'message.delivered',
  MESSAGE_FAILED: 'message.failed',
  MESSAGE_REPLIED: 'message.replied',
  CALL_COMPLETED: 'call.completed',
  PAYMENT_CREATED: 'payment.created',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  CAMPAIGN_LAUNCHED: 'campaign.launched',
  CAMPAIGN_COMPLETED: 'campaign.completed',
  WORKFLOW_STARTED: 'workflow.started',
  WORKFLOW_COMPLETED: 'workflow.completed',
  BULK_IMPORT_COMPLETED: 'bulk_import.completed',
});

export const QUEUE_NAMES = Object.freeze({
  EVENTS: 'events',
  EMAIL: 'email-send',
  SMS: 'sms-send',
  WHATSAPP: 'whatsapp-send',
  BULK_IMPORT: 'bulk-import',
  BULK_EXPORT: 'bulk-export',
  CAMPAIGN: 'campaign-run',
  DRIP: 'drip-step',
  SCHEDULED_SEND: 'scheduled-send',
  WORKFLOW: 'workflow-step',
  NOTIFICATIONS: 'notifications',
  OUTBOUND_WEBHOOK: 'outbound-webhook',
  PDF: 'pdf-report',
});

export const DEFAULT_BUSINESS_HOURS = Object.freeze([
  { day_of_week: 0, is_open: false, open_time: null, close_time: null }, // Sunday
  { day_of_week: 1, is_open: true, open_time: '10:00', close_time: '19:00' },
  { day_of_week: 2, is_open: true, open_time: '10:00', close_time: '19:00' },
  { day_of_week: 3, is_open: true, open_time: '10:00', close_time: '19:00' },
  { day_of_week: 4, is_open: true, open_time: '10:00', close_time: '19:00' },
  { day_of_week: 5, is_open: true, open_time: '10:00', close_time: '19:00' },
  { day_of_week: 6, is_open: true, open_time: '10:00', close_time: '19:00' },
]);

export const DEFAULT_TAB_KEYS = Object.freeze([
  'dashboard',
  'leads',
  'raw_data',
  'failed_leads',
  'bulk_upload',
  'followups',
  'whatsapp',
  'bulk_marketing',
  'drip_marketing',
  'remarketing',
  'automation',
  'connected_accounts',
  'settings.email_templates',
  'settings.sms_templates',
  'settings.whatsapp_templates',
  'settings.lead_score',
  'settings.assignment_rules',
  'advanced.dropdowns',
  'advanced.users_roles',
  'advanced.communications',
  'advanced.subscription',
  'third_party_integration',
  'reports',
  'analytics',
  // Accounts module (account_manager role). These show up in the
  // super_admin's "tab permissions" matrix so the role assignments can
  // be tuned per tenant without a code deploy.
  'accounts.dashboard',
  'accounts.pending_admissions',
  'accounts.this_month_admissions',
  'accounts.total_admissions',
  'accounts.approvals',
  'accounts.attendings',
  'accounts.break',
  'accounts.report',
  'accounts.pay_schedule',
  'accounts.collection_receipt_wise',
]);
