// Step 6I: read-only stuck-claim audit + guarded recovery. Not connected to dispatch.
// Recovery is deliberately OFF by default. Run only after an operator confirms
// no provider send can be in flight, otherwise duplicate sends are possible.
export async function auditSmartReminderClaims(pool, { olderThanMinutes = 30, limit = 50, now = new Date() } = {}) {
  if (!pool || typeof pool.query !== 'function') throw Error('pool_required');
  if (!Number.isSafeInteger(olderThanMinutes) || olderThanMinutes < 5 || olderThanMinutes > 1440) throw Error('invalid_age');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('invalid_limit');
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw Error('invalid_clock');
  const cutoff = new Date(date.getTime() - olderThanMinutes * 60000).toISOString();
  const result = await pool.query(`SELECT id,booking_id,appointment_revision,recipient,channel,stage,mode,starts_at,due_at,updated_at
    FROM public.booking_smart_reminder_jobs WHERE status='claimed' AND updated_at < $1
    ORDER BY updated_at,id LIMIT $2`, [cutoff, limit]);
  return { staleClaims: result.rows || [], count: (result.rows || []).length, recoveryEnabled: false };
}

// Does NOT return claims to 'pending': their provider-send status is unknown.
// Safe terminal quarantine only, and requires a specific allowlist of IDs.
export async function quarantineSmartReminderClaims(pool, { ids = [], confirmedNoSendInFlight = false } = {}) {
  if (!confirmedNoSendInFlight) return { changed: 0, reason: 'operator_confirmation_required' };
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || !ids.every(id => Number.isSafeInteger(id) && id > 0)) throw Error('invalid_ids');
  if (!pool || typeof pool.query !== 'function') throw Error('pool_required');
  const result = await pool.query(`UPDATE public.booking_smart_reminder_jobs
    SET status='skipped', updated_at=NOW()
    WHERE id=ANY($1::bigint[]) AND status='claimed' RETURNING id`, [ids]);
  return { changed: (result.rows || []).length, quarantinedIds: (result.rows || []).map(r => r.id), reason: 'quarantined_no_auto_retry' };
}
