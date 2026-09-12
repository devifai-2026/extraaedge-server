// The 24-hour class completion rule, plus payroll's disbursement reminders.
//
// Two jobs on one timer because both are "check the clock, notify once":
//
//   1. Classes. A trainer has 24 hours after a class ends to confirm it. With
//      6 hours left they get a reminder; past the deadline the system records
//      the class as NOT conducted, which stops it paying. A branch manager can
//      still override either verdict — the sweep never touches an overridden
//      row (see repo.autoMarkNotConducted).
//
//   2. Payroll. Salary-due reminders fire on their configured offsets, and
//      whoever must release the money is told. UNIQUE (run_id, offset_days,
//      kind) makes each one fire exactly once however often this ticks.
import { sysQuery } from '../db/system.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { pushNotification } from '../modules/notifications/service.js';
import * as classesRepo from '../modules/classes/repo.js';
import * as payrollRepo from '../modules/payroll/repo.js';
import { logger } from '../lib/logger.js';

const GRACE_HOURS = 24;
const REMIND_WITHIN_HOURS = 6;

const notify = async (tenant, userId, type, message, link, metadata) => {
  if (!userId) return;
  try {
    await pushNotification(tenant, {
      user_id: userId, type, message, link, metadata_json: metadata ? JSON.stringify(metadata) : null,
    });
  } catch (err) {
    logger.warn({ err: err.message, type }, 'class-completion-sweeper: notify failed');
  }
};

const sweepClasses = async (tenant) => {
  // (a) Remind trainers whose window is closing.
  const due = await classesRepo.remindableClasses(tenant, { withinHours: REMIND_WITHIN_HOURS });
  for (const c of due) {
    // eslint-disable-next-line no-await-in-loop
    await notify(
      tenant, c.trainer_id, 'class_completion_due',
      `Confirm "${c.title}" — mark it complete before the window closes, or it will be recorded as not conducted.`,
      '/trainer/classes', { class_id: c.id, due_at: c.completion_due_at },
    );
  }
  if (due.length) await classesRepo.markReminded(tenant, due.map((c) => c.id));

  // (b) Close out anything still unconfirmed past the deadline.
  const overdue = await classesRepo.overdueCompletions(tenant, { graceHours: GRACE_HOURS });
  if (!overdue.length) return { reminded: due.length, autoMarked: 0 };

  const marked = await classesRepo.autoMarkNotConducted(tenant, overdue.map((c) => c.id));
  for (const c of marked) {
    // eslint-disable-next-line no-await-in-loop
    await notify(
      tenant, c.trainer_id, 'class_auto_not_conducted',
      `"${c.title}" was recorded as not conducted — it was not confirmed within ${GRACE_HOURS} hours. Ask your branch manager if this is wrong.`,
      '/trainer/classes', { class_id: c.id },
    );
  }

  // Tell the managers too: a silently-dropped class is their problem to chase.
  if (marked.length) {
    const { rows: managers } = await tenantQuery(
      tenant,
      `SELECT id FROM users
        WHERE deleted_at IS NULL AND is_active
          AND role IN ('super_admin','branch_manager','head_trainer')`,
    );
    for (const m of managers) {
      // eslint-disable-next-line no-await-in-loop
      await notify(
        tenant, m.id, 'classes_auto_not_conducted',
        `${marked.length} class(es) were auto-marked as not conducted — nobody confirmed them in time. You can override this.`,
        '/lms/classes', { count: marked.length },
      );
    }
  }
  return { reminded: due.length, autoMarked: marked.length };
};

const sweepPayroll = async (tenant) => {
  const rows = await payrollRepo.dueReminders(tenant);
  if (!rows.length) return 0;

  const { rows: payers } = await tenantQuery(
    tenant,
    `SELECT id, role FROM users
      WHERE deleted_at IS NULL AND is_active
        AND role IN ('super_admin','branch_manager','hr_team_lead')`,
  );

  for (const r of rows) {
    const when = r.offset_days > 0
      ? `in ${r.offset_days} day(s)`
      : 'today';
    const period = `${String(r.period_month).padStart(2, '0')}/${r.period_year}`;
    for (const p of payers) {
      // eslint-disable-next-line no-await-in-loop
      await notify(
        tenant, p.id, 'payroll_due',
        `Salary for ${period} is due ${when} — ${r.employee_count} employee(s), net ${Number(r.total_net).toLocaleString('en-IN')}.`,
        '/payroll/runs', { run_id: r.run_id, pay_date: r.pay_date },
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await payrollRepo.markReminderSent(tenant, r.id, payers.map((p) => p.id));
  }
  return rows.length;
};

const tick = async () => {
  try {
    const { rows: tenants } = await sysQuery(
      `SELECT id FROM tenants WHERE status = 'active' AND deleted_at IS NULL`,
    );
    for (const { id } of tenants) {
      // eslint-disable-next-line no-await-in-loop
      const tenant = await resolveTenantById(id);
      if (!tenant) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const c = await sweepClasses(tenant);
        // eslint-disable-next-line no-await-in-loop
        const p = await sweepPayroll(tenant);
        if (c.autoMarked || p) {
          logger.info({ tenant: tenant.slug, ...c, payrollReminders: p }, 'class-completion-sweeper');
        }
      } catch (err) {
        // One bad tenant must never stop the sweep for the rest.
        logger.error({ err: err.message, tenant: tenant.slug }, 'class-completion-sweeper: tenant failed');
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'class-completion-sweeper tick failed');
  }
};

// Every 15 minutes. The deadline is measured in hours, so minute-level
// precision buys nothing and costs a query per tenant per minute.
setInterval(tick, 15 * 60_000);
setTimeout(tick, 20_000);

export default tick;
