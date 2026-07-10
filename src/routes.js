import express from 'express';

// ---- Built modules (Passes 1-6 complete) ----
import authRouter from './modules/auth/routes.js';
import platformTenantsRouter from './modules/tenants/routes.js';
import platformUsersRouter from './modules/platform-users/routes.js';
import platformPlansRouter from './modules/plans/routes.js';
import platformAuditRouter from './modules/platform-audit/routes.js';
import platformRequestLogRouter from './modules/platform-requests/routes.js';
import platformLeadInspectorRouter from './modules/platform-lead-inspector/routes.js';
import platformTicketsRouter from './modules/platform-tickets/routes.js';
import impersonationRouter from './modules/impersonation/routes.js';
import customRolesRouter from './modules/custom-roles/routes.js';
import usersRouter from './modules/users/routes.js';
import teamsRouter from './modules/teams/routes.js';
import dropdownsRouter from './modules/dropdowns/routes.js';
import programsRouter from './modules/programs/routes.js';
import uploadsRouter from './modules/uploads/routes.js';
import notificationsRouter from './modules/notifications/routes.js';
import notificationPreferencesRouter from './modules/notification-preferences/routes.js';
import calendarRouter from './modules/calendar/routes.js';
import searchRouter from './modules/search/routes.js';
import templateVariablesRouter from './modules/template-variables/routes.js';
import leadsRouter from './modules/leads/routes.js';
import leadPoolRouter from './modules/lead-pool/routes.js';
import leadRecordingsRouter from './modules/lead-recordings/routes.js';
import leadAssignmentsRouter from './modules/lead-assignments/routes.js';
import leadDiscountsRouter from './modules/lead-discounts/routes.js';
import branchesRouter from './modules/branches/routes.js';
import tenantBrandingRouter from './modules/tenant-branding/routes.js';
import leadActivitiesRouter from './modules/lead-activities/routes.js';
import leadNotesRouter from './modules/lead-notes/routes.js';
import tagsRouter from './modules/tags/routes.js';
import customFieldsRouter from './modules/custom-fields/routes.js';
import fieldPermissionsRouter from './modules/field-permissions/routes.js';
import duplicatesRouter from './modules/duplicates/routes.js';
import savedFiltersRouter from './modules/saved-filters/routes.js';
import followUpsRouter from './modules/follow-ups/routes.js';
import quickAddRouter from './modules/quick-add/routes.js';
import bulkIngestionRouter from './modules/bulk-ingestion/routes.js';
import rawDataRouter from './modules/raw-data/routes.js';
import failedLeadsRouter from './modules/failed-leads/routes.js';
import emailRouter from './modules/communications/email-routes.js';
import smsRouter from './modules/communications/sms-routes.js';
import whatsappRouter from './modules/communications/whatsapp-routes.js';
import whatsappConnectionRouter from './modules/communications/whatsapp-connection-routes.js';
import waInternalRouter from './modules/internal/wa-routes.js';
import scheduledSendsRouter from './modules/scheduled-sends/routes.js';
import callsRouter from './modules/calls/routes.js';
import deviceRecordingsRouter from './modules/device-recordings/routes.js';
import paymentsRouter from './modules/payments/routes.js';
import subscriptionsRouter from './modules/subscriptions/routes.js';
import assignmentRulesRouter from './modules/assignment-rules/routes.js';
import leadScoreRouter from './modules/lead-score/routes.js';
import workflowsRouter from './modules/workflows/routes.js';
import campaignsBulkRouter from './modules/campaigns-bulk/routes.js';
import campaignsDripRouter from './modules/campaigns-drip/routes.js';
import slaRouter from './modules/sla/routes.js';
import referralsRouter from './modules/referrals/routes.js';
import attributionRouter from './modules/attribution/routes.js';
import integrationsRouter from './modules/integrations/routes.js';
import outboundWebhooksRouter from './modules/outbound-webhooks/routes.js';
import remarketingRouter from './modules/remarketing/routes.js';
import ticketsRouter from './modules/tickets/routes.js';
import auditLogRouter from './modules/audit-log/routes.js';
import analyticsRouter from './modules/analytics/routes.js';
import reportsRouter from './modules/reports/routes.js';
import workSessionsRouter from './modules/work-sessions/routes.js';
import admissionsRouter from './modules/admissions/routes.js';
import publicAdmissionsRouter from './modules/public-admissions/routes.js';
import publicReceiptsRouter from './modules/public-receipts/routes.js';
import publicBrandingRouter from './modules/public-branding/routes.js';
import studentAuthRouter from './modules/student-auth/routes.js';
import coursesRouter from './modules/courses/routes.js';
import classesRouter from './modules/classes/routes.js';
import communityRouter from './modules/community/routes.js';
import leadFeeOffersRouter from './modules/lead-fee-offers/routes.js';
import paymentAccountsRouter from './modules/payment-accounts/routes.js';

// ---- Pending modules (wired as these passes complete) ----
// Pass 7: follow-ups, quick-add
// Pass 8: bulk-ingestion, raw-data, failed-leads
// Pass 9: communications (email/sms/whatsapp), scheduled-sends
// Pass 10: calls, payments, subscriptions
// Pass 11: assignment-rules, lead-score, workflows
// Pass 12: campaigns-bulk, campaigns-drip, sla, referrals, attribution
// Pass 13: integrations, outbound-webhooks, remarketing, tickets, audit-log,
//          analytics, reports, work-sessions

export const mountRoutes = (app) => {
  const api = express.Router();

  // Auth
  api.use('/auth', authRouter);

  // Platform (product_owner / support_admin)
  api.use('/platform/tenants', platformTenantsRouter);
  api.use('/platform/users', platformUsersRouter);
  api.use('/platform/plans', platformPlansRouter);
  api.use('/platform/audit-log', platformAuditRouter);
  // Danger Request Log — full cross-tenant API activity (product_owner only).
  api.use('/platform/request-log', platformRequestLogRouter);
  // Cross-tenant lead inspector — drill into any tenant's lead + bulk imports.
  api.use('/platform/inspect', platformLeadInspectorRouter);
  api.use('/platform/tickets', platformTicketsRouter);
  api.use('/platform/impersonate', impersonationRouter);

  // Tenant — identity & access
  api.use('/custom-roles', customRolesRouter);
  api.use('/users', usersRouter);
  api.use('/teams', teamsRouter);
  api.use('/branches', branchesRouter);
  api.use('/tenant-branding', tenantBrandingRouter);

  // Tenant — config
  api.use('/dropdowns', dropdownsRouter);
  api.use('/programs', programsRouter);
  api.use('/calendar', calendarRouter);
  api.use('/template-variables', templateVariablesRouter);

  // Tenant — ops
  api.use('/uploads', uploadsRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/notification-preferences', notificationPreferencesRouter);
  api.use('/search', searchRouter);

  // Tenant — leads + related
  api.use('/leads', leadsRouter);
  // Tenant-wide, READ-ONLY Lead Pool. Any counsellor (and up) can look up ANY
  // lead in the tenant by name or phone — bypasses the owner/team/branch scope
  // that guards /leads, but exposes only a read-only projection (details +
  // current owner, manager, previous owner). Gated by the `lead_pool` tab.
  api.use('/lead-pool', leadPoolRouter);
  // Per-lead manually-uploaded call recordings. Mounted with the
  // :lead_id path param the sub-router relies on.
  api.use('/leads/:lead_id/recordings', leadRecordingsRouter);
  api.use('/lead-assignments', leadAssignmentsRouter);
  api.use('/lead-discounts', leadDiscountsRouter);
  api.use('/lead-activities', leadActivitiesRouter);
  api.use('/lead-notes', leadNotesRouter);
  api.use('/tags', tagsRouter);
  api.use('/custom-fields', customFieldsRouter);
  api.use('/field-permissions', fieldPermissionsRouter);
  api.use('/duplicates', duplicatesRouter);
  api.use('/saved-filters', savedFiltersRouter);
  api.use('/follow-ups', followUpsRouter);
  api.use('/quick-add', quickAddRouter);
  api.use('/bulk/leads', bulkIngestionRouter);
  api.use('/raw-data', rawDataRouter);
  api.use('/failed-leads', failedLeadsRouter);

  // Communications
  api.use('/email', emailRouter);
  api.use('/sms', smsRouter);
  // Per-user personal-number WhatsApp (whatsapp-web.js gateway). Mounted BEFORE
  // the legacy /whatsapp router so /whatsapp/connection/* resolves here.
  api.use('/whatsapp/connection', whatsappConnectionRouter);
  api.use('/whatsapp', whatsappRouter);
  api.use('/scheduled-sends', scheduledSendsRouter);

  // Telephony + payments + subscription
  api.use('/calls', callsRouter);
  // Android call-recorder app uploads (device shared-secret auth on POST; CRM
  // JWT auth on the read/admin routes).
  api.use('/device-recordings', deviceRecordingsRouter);
  api.use('/payments', paymentsRouter);
  api.use('/subscription', subscriptionsRouter);

  // Rules, scoring, workflows
  api.use('/assignment-rules', assignmentRulesRouter);
  api.use('/lead-score', leadScoreRouter);
  api.use('/workflows', workflowsRouter);

  // Campaigns + SLA + referrals + attribution
  api.use('/campaigns/bulk', campaignsBulkRouter);
  api.use('/campaigns/drip', campaignsDripRouter);
  api.use('/sla-policies', slaRouter);
  api.use('/referrals', referralsRouter);
  api.use('/analytics/attribution', attributionRouter);

  // Integrations, tickets, audit, analytics, reports, work-sessions
  api.use('/integrations', integrationsRouter);
  api.use('/outbound-webhooks', outboundWebhooksRouter);
  api.use('/remarketing', remarketingRouter);
  api.use('/tickets', ticketsRouter);
  api.use('/audit-log', auditLogRouter);
  api.use('/analytics', analyticsRouter);
  api.use('/reports', reportsRouter);
  api.use('/work-sessions', workSessionsRouter);

  // Accounts / admissions module (account_manager + super_admin)
  api.use('/admissions', admissionsRouter);
  // LMS courses/modules/trainers/batches (trainers + head + admin) — the
  // router does its own auth chain (incl. a student /my-course sub-route).
  api.use('/courses', coursesRouter);
  // LMS classes + live-MCQ attendance (trainers + students; router self-gates).
  api.use('/classes', classesRouter);
  // LMS recordings + announcements (trainers + students; router self-gates).
  api.use('/community', communityRouter);
  // Per-lead customised fee offer — accounts team's tweak of the
  // program-level defaults for a specific converted lead.
  api.use('/lead-fee-offers', leadFeeOffersRouter);
  // Admin-managed payment destinations (bank accounts + UPI IDs) used to
  // collect the registration/admission amount. Exactly one is primary.
  api.use('/payment-accounts', paymentAccountsRouter);

  // Internal callback from the WhatsApp gateway (gateway → API). NOT behind
  // authRequired/tenantRequired — the shared secret in the header is the
  // credential (validated inside the router).
  api.use('/internal/wa', waInternalRouter);

  // Unauthenticated public surface for student-facing admission share-links.
  // Token in the URL is the credential; this router lives OUTSIDE the
  // authRequired/tenantRequired chain on purpose.
  api.use('/public/admissions', publicAdmissionsRouter);
  // Receipt share-links: same trust model as admissions (URL token IS
  // the credential). Lets accounts share a printable receipt URL with
  // the student / parent without forcing them to sign in.
  api.use('/public/receipts', publicReceiptsRouter);
  // Tenant logo proxy — streams the private GCS object so the navbar (all
  // roles) can render it as <img src> without a public bucket or a short-lived
  // signed URL. URL in the tenant's logo_url column points here.
  api.use('/public/branding', publicBrandingRouter);

  // Student authentication (LMS). Separate principal (type:'student' JWT),
  // tenant-scoped via the x-tenant-slug header. NOT behind the staff auth chain.
  api.use('/student-auth', studentAuthRouter);

  app.use('/api/v1', api);
};
