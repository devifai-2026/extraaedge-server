// The one list of workers to run inside the web process.
//
// This module exists because there were previously TWO copies of this list —
// one in index.js, one in app.js — and they silently diverged. Hostinger's
// Passenger is configured with `PassengerStartupFile src/app.js`, so in
// production index.js never executes at all; only app.js's copy is real.
// bulk-admission-import-worker.js had been added to index.js alone, so the
// Accounts admission importer had no consumer on the live box: /bulk/admissions
// /preview happily returned 202, publish() dropped the job, and the upload
// dialog polled a row nobody would ever update and reported "Checked 0 rows"
// — indistinguishable from an empty spreadsheet. Eleven other workers had the
// mirror-image problem (present in app.js, absent from index.js), so local runs
// via `npm start` were quietly missing the whole marketing engine.
//
// Any new worker goes in MODULES below and is picked up by both entry points.
import { usingBull } from '../lib/queue.js';
import { logger } from '../lib/logger.js';

// Union of what the two lists used to hold. Order is load order; nothing here
// depends on another entry, so it is grouped for reading rather than sequencing.
const MODULES = [
  // Lead + admission pipeline.
  './rule-processor.js',
  './bulk-import-worker.js',
  // The Accounts historical-admission importer. Its own queue, so it needs its
  // own entry — sharing BULK_IMPORT would hand every lead job to it too.
  './bulk-admission-import-worker.js',
  './bulk-export-worker.js',

  // Follow-ups + notifications. notification-worker turns queued events into
  // notifications rows and websocket pushes; the two scanners publish the
  // follow_up_due / follow_up_missed events it reacts to. Without all three the
  // notifications popover stays empty even though /follow-ups/* CRUD works.
  './notification-worker.js',
  './followup-reminder-scheduler.js',
  './missed-followup-scanner.js',
  './lms-class-reminder.js',

  // Attendance + housekeeping. work-session-midnight-closer force-closes
  // sessions left open past the tenant's local midnight.
  './work-session-midnight-closer.js',
  './sla-scanner.js',
  './security-digest-mailer.js',

  // Outbound messaging + the marketing engine. On a BullMQ deployment these
  // would each be their own process; on Hostinger there is no second process,
  // so they run here.
  './email-sender.js',
  './sms-sender.js',
  './campaign-runner.js',
  './drip-scheduler.js',
  './scheduled-send-runner.js',
  './workflow-executor.js',
  './outbound-webhook-dispatcher.js',
  './attribution-snapshotter.js',
  './touch-recorder.js',
  './remarketing-sync.js',
];

// Importing a worker module runs its registerWorker side effect, so doing it
// twice would register every handler twice and run each job twice. index.js
// imports app.js, so on a direct `node src/index.js` both entry points can
// reach this — hence the latch.
let started = false;

export const loadInprocessWorkers = async () => {
  // Gate on whether BullMQ is REALLY carrying jobs, not on the driver string.
  // QUEUE_DRIVER defaults to 'bullmq' while useBull() also demands REDIS_URL,
  // so a box with no Redis configured (which is every Hostinger deployment —
  // there is no .env there at all) fell through to publish()'s in-process
  // branch while this loader, gated on the string alone, skipped every worker.
  if (usingBull()) return;
  if (started) return;
  started = true;

  const failed = [];
  for (const m of MODULES) {
    // Per-module try/catch, not one around the loop: a single broken worker
    // used to abort the whole list at whatever position it sat in, silently
    // taking out every worker after it.
    try {
      await import(m);
    } catch (err) {
      failed.push(m);
      logger.error({ err: err.message, stack: err.stack, module: m }, 'in-process worker failed to load');
    }
  }
  logger.info(
    { loaded: MODULES.length - failed.length, total: MODULES.length, failed },
    'in-process workers loaded',
  );
};
