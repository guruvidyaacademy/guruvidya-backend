// Phase 3 Step 6H: atomic due-job reservation. Not wired to live dispatch.
// Import explicitly only after provider/consent/revision audit is completed.
const VALID = new Set(['pending']);
export async function reserveDueSmartReminderJobs(pool, { limit = 10, now = new Date(), enabled = false } = {}) {
  if (!enabled) return { claimed: [], reason: 'disabled' };
  if (!pool || typeof pool.connect !== 'function') throw Error('pool_required');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw Error('invalid_limit');
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw Error('invalid_clock');
  const client = await pool.connect();
  let begun = false;
  try {
    await client.query('BEGIN'); begun = true;
    // SKIP LOCKED prevents two workers claiming the same pending job.
    // Does not send messages; a separate audited sender must check booking revision,
    // recipient consent and provider acceptance before marking delivery.
    const result = await client.query(`WITH selected AS (
      SELECT id FROM public.booking_smart_reminder_jobs
      WHERE status='pending' AND due_at <= $1
      ORDER BY due_at,id
      LIMIT $2 FOR UPDATE SKIP LOCKED
    )
    UPDATE public.booking_smart_reminder_jobs AS j
    SET status='claimed',updated_at=NOW()
    FROM selected WHERE j.id=selected.id AND j.status='pending'
    RETURNING j.id,j.booking_id,j.appointment_revision,j.recipient,j.channel,
      j.stage,j.mode,j.starts_at,j.due_at`, [date.toISOString(), limit]);
    await client.query('COMMIT'); begun = false;
    return { claimed: result.rows || [], reason: 'reserved_dispatch_not_connected' };
  } catch (error) {
    if (begun) { try { await client.query('ROLLBACK'); } catch {} }
    throw error;
  } finally { client.release(); }
}
