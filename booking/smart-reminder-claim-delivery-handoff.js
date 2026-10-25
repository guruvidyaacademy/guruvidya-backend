// Step 38: isolated review-only handoff; NOT imported by server or scheduler.
// Database writes require an explicitly supplied transaction client and both gates.
// No provider dispatch is possible from this module.
const recipients = new Set(['student', 'parent']);
const channels = new Set(['whatsapp', 'email']);
const stages = new Set(['4h', '2h', '1h', '5min']);
const statuses = new Set(['requested', 'approved', 'confirmed', 'rescheduled']);
const HOLD = Object.freeze({ linked: false, sent: 0, reason: 'disabled_or_migration_unverified' });
export function validateHandoffIdentity(x) {
  if (!Number.isSafeInteger(x?.bookingId) || x.bookingId < 1 || x.bookingId > 2147483647 ||
      !Number.isSafeInteger(x?.revision) || x.revision < 1 ||
      !recipients.has(x.recipient) || !channels.has(x.channel) || !stages.has(x.stage) ||
      !['online', 'offline'].includes(x.mode) || (x.stage === '5min' && x.mode !== 'online') ||
      !Number.isFinite(Date.parse(x.expectedStartsAt))) throw new Error('invalid_handoff_identity');
}
export async function reviewHandoffWithClient(client, x, { enabled = false, migrationVerified = false, now = Date.now() } = {}) {
  if (!enabled || !migrationVerified) return { ...HOLD };
  validateHandoffIdentity(x);
  let active = false;
  try {
    await client.query('BEGIN'); active = true;
    await client.query('SELECT pg_advisory_xact_lock($1,$2)', [75201948, x.bookingId]);
    const booking = (await client.query('SELECT id, appointment_revision, starts_at, status, mode, trashed_at FROM student_bookings WHERE id=$1 FOR UPDATE', [x.bookingId])).rows?.[0];
    if (!booking || booking.trashed_at != null || Number(booking.appointment_revision) !== x.revision ||
        Date.parse(booking.starts_at) !== Date.parse(x.expectedStartsAt) ||
        Date.parse(booking.starts_at) <= now || !statuses.has(String(booking.status).toLowerCase()) || booking.mode !== x.mode) {
      await client.query('ROLLBACK'); active = false;
      return { linked: false, sent: 0, reason: 'stale_or_ineligible' };
    }
    const claim = (await client.query(`SELECT id, status FROM booking_smart_reminder_claims
      WHERE booking_id=$1 AND appointment_revision=$2 AND recipient=$3 AND channel=$4 AND stage=$5 AND mode=$6
      FOR UPDATE`, [x.bookingId, x.revision, x.recipient, x.channel, x.stage, x.mode])).rows?.[0];
    if (!claim || claim.status !== 'claimed') {
      await client.query('ROLLBACK'); active = false;
      return { linked: false, sent: 0, reason: 'claim_missing_or_invalid' };
    }
    const result = await client.query(`INSERT INTO booking_smart_reminder_deliveries
      (booking_id,appointment_revision,recipient_type,stage,channel,status)
      VALUES ($1,$2,$3,$4,$5,'claimed')
      ON CONFLICT (booking_id,appointment_revision,recipient_type,stage,channel)
      DO NOTHING RETURNING id`, [x.bookingId, x.revision, x.recipient, x.stage, x.channel]);
    await client.query('COMMIT'); active = false;
    return { linked: result.rowCount === 1, sent: 0, reason: result.rowCount === 1 ? 'linked_transport_hold' : 'already_linked' };
  } catch (error) {
    if (active) { try { await client.query('ROLLBACK'); } catch {} }
    throw error;
  }
}
export async function disabledClaimDeliveryHandoff() {
  return { ...HOLD };
}
