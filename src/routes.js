import express from 'express';

// ---- Built modules (Passes 1-6 complete) ----
import authRouter from './modules/auth/routes.js';
import platformTenantsRouter from './modules/tenants/routes.js';
import platformUsersRouter from './modules/platform-users/routes.js';
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
import leadAssignmentsRouter from './modules/lead-assignments/routes.js';
import leadActivitiesRouter from './modules/lead-activities/routes.js';
import leadNotesRouter from './modules/lead-notes/routes.js';
import tagsRouter from './modules/tags/routes.js';
import customFieldsRouter from './modules/custom-fields/routes.js';
import fieldPermissionsRouter from './modules/field-permissions/routes.js';
import duplicatesRouter from './modules/duplicates/routes.js';
import savedFiltersRouter from './modules/saved-filters/routes.js';
import followUpsRouter from './modules/follow-ups/routes.js';
import userAvailabilityRouter from './modules/user-availability/routes.js';
import quickAddRouter from './modules/quick-add/routes.js';
import bulkIngestionRouter from './modules/bulk-ingestion/routes.js';
import rawDataRouter from './modules/raw-data/routes.js';
import failedLeadsRouter from './modules/failed-leads/routes.js';
import emailRouter from './modules/communications/email-routes.js';
import smsRouter from './modules/communications/sms-routes.js';
import whatsappRouter from './modules/communications/whatsapp-routes.js';
import scheduledSendsRouter from './modules/scheduled-sends/routes.js';
import callsRouter from './modules/calls/routes.js';
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

// ---- Pending modules (wired as these passes complete) ----
// Pass 7: follow-ups, user-availability, quick-add
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
  api.use('/platform/impersonate', impersonationRouter);

  // Tenant — identity & access
  api.use('/custom-roles', customRolesRouter);
  api.use('/users', usersRouter);
  api.use('/teams', teamsRouter);

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
  api.use('/lead-assignments', leadAssignmentsRouter);
  api.use('/lead-activities', leadActivitiesRouter);
  api.use('/lead-notes', leadNotesRouter);
  api.use('/tags', tagsRouter);
  api.use('/custom-fields', customFieldsRouter);
  api.use('/field-permissions', fieldPermissionsRouter);
  api.use('/duplicates', duplicatesRouter);
  api.use('/saved-filters', savedFiltersRouter);
  api.use('/follow-ups', followUpsRouter);
  api.use('/availability', userAvailabilityRouter);
  api.use('/quick-add', quickAddRouter);
  api.use('/bulk/leads', bulkIngestionRouter);
  api.use('/raw-data', rawDataRouter);
  api.use('/failed-leads', failedLeadsRouter);

  // Communications
  api.use('/email', emailRouter);
  api.use('/sms', smsRouter);
  api.use('/whatsapp', whatsappRouter);
  api.use('/scheduled-sends', scheduledSendsRouter);

  // Telephony + payments + subscription
  api.use('/calls', callsRouter);
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

  app.use('/api/v1', api);
};
