// Step 6J: opt-in, read-only dispatch-readiness monitor.
// Intentionally does not claim jobs, contact providers, or alter booking state.
import { auditSmartReminderClaims } from './smart-reminder-step6i-claim-recovery.js';
import { runSmartReminderStep6Preflight } from './smart-reminder-step6-preflight.js';

export async function auditSmartReminderStep6J(pool, now = new Date()) {
  if (!pool || typeof pool.query !== 'function') throw Error('pool_required');
  const clock = new Date(now);
  if (!Number.isFinite(clock.getTime())) throw Error('invalid_clock');
  const preflight = await runSmartReminderStep6Preflight(pool);
  if (!preflight.ready) return { ready: false, reason: 'schema_not_ready', dispatchEnabled: false, sent: 0 };
  const settings = (await pool.query("SELECT settings->'smart_reminders' AS smart FROM booking_settings WHERE id=1")).rows?.[0]?.smart;
  if (!settings || typeof settings !== 'object') return { ready: false, reason: 'settings_missing', dispatchEnabled: false, sent: 0 };
  const summary = await pool.query(`SELECT
      COUNT(*) FILTER (WHERE j.status='pending' AND j.due_at <= $1)::int AS due_pending,
      COUNT(*) FILTER (WHERE j.status='claimed')::int AS claimed,
      COUNT(*) FILTER (WHERE j.status='pending' AND j.due_at > $1)::int AS future_pending,
      COUNT(*) FILTER (WHERE j.status='pending' AND (b.id IS NULL OR b.status NOT IN ('requested','approved','confirmed','rescheduled')
        OR b.trashed_at IS NOT NULL OR b.cancelled_at IS NOT NULL OR j.appointment_revision<>b.appointment_revision
        OR j.starts_at<>b.starts_at))::int AS stale_pending
    FROM public.booking_smart_reminder_jobs j
    LEFT JOIN public.student_bookings b ON b.id=j.booking_id`, [clock.toISOString()]);
  const staleClaims = await auditSmartReminderClaims(pool, { now: clock, limit: 50 });
  const counts = summary.rows?.[0] || {};
  return {
    ready: true,
    reason: settings.master_enabled === true ? 'master_on_dispatch_not_installed' : 'master_off',
    masterEnabled: settings.master_enabled === true,
    duePending: Number(counts.due_pending || 0),
    futurePending: Number(counts.future_pending || 0),
    claimed: Number(counts.claimed || 0),
    stalePending: Number(counts.stale_pending || 0),
    staleClaims: staleClaims.count,
    staleClaimsTruncated: staleClaims.count === 50,
    dispatchEnabled: false,
    sent: 0
  };
}

export function startSmartReminderStep6JReadinessMonitor(pool, { intervalMs = 60000 } = {}) {
  if (process.env.GV_SMART_REMINDER_STEP6J_AUDIT !== '1') {
    console.info('[Smart Reminders Step 6J] READINESS AUDIT disabled (safe default)');
    return () => {};
  }
  let running = false, closed = false;
  async function tick() {
    if (closed || running) return;
    running = true;
    try {
      const result = await auditSmartReminderStep6J(pool);
      console.info('[Smart Reminders Step 6J] READINESS', JSON.stringify(result));
    } catch (error) {
      console.error('[Smart Reminders Step 6J] READINESS ERROR', String(error?.message || error));
    } finally { running = false; }
  }
  const timer = setInterval(tick, Math.max(30000, intervalMs));
  timer.unref?.();
  void tick();
  return () => { closed = true; clearInterval(timer); };
}
