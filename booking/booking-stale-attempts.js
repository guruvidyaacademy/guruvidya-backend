// Recover abandoned in-flight delivery claims without risking duplicate WhatsApp sends.
// A process may crash after BotSailor accepts a message but before the DB status is saved.
// Therefore stale attempts become UNKNOWN, never QUEUED. An operator must reconcile them.
export function staleAttemptMinutes(value = process.env.BOOKING_STALE_SENDING_MINUTES) {
  if (value === undefined || value === '') return 15;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
    throw new Error('BOOKING_STALE_SENDING_MINUTES must be an integer between 5 and 1440');
  }
  return minutes;
}

export async function reconcileStaleBookingAttempts(pool, options = {}) {
  const minutes = staleAttemptMinutes(options.minutes);
  // created_at is the queue creation time, NOT the sending-claim time. Only use
  // the claim timestamp added in Build 21; older claims have no reliable clock.
  const result = await pool.query(`UPDATE booking_delivery_logs
    SET status='unknown', detail=$1
    WHERE status='sending' AND sending_claimed_at IS NOT NULL
      AND sending_claimed_at < NOW() - ($2::integer * INTERVAL '1 minute')
    RETURNING id`, [JSON.stringify({reason:'stale_sending_claim',
      note:'Provider may have accepted this message. Do not automatically retry; reconcile manually.'}), minutes]);
  return {marked_unknown: result.rowCount};
}
