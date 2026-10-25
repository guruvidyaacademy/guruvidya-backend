// Phase 3 Step 10: fail-closed scheduler integration preflight.
// No provider dispatch and no writes. This bridge is intentionally disabled until
// the canonical revision schema and atomic-claim migration are reviewed/applied.
export const SMART_REMINDER_DELIVERY_ENABLED = false;

export function evaluateSmartReminderPreflight({ booking, expectedStartsAt, expectedRevision, recipient, channel, masterEnabled = false }) {
  if (!masterEnabled) return { allowed: false, reason: 'master_off' };
  if (!booking || booking.id == null) return { allowed: false, reason: 'missing_booking' };
  if (!['requested', 'approved', 'confirmed', 'rescheduled'].includes(booking.status)) return { allowed: false, reason: 'inactive_booking' };
  if (!['student', 'parent'].includes(recipient)) return { allowed: false, reason: 'invalid_recipient' };
  if (!['whatsapp', 'email'].includes(channel)) return { allowed: false, reason: 'invalid_channel' };
  const current = Date.parse(booking.starts_at);
  const expected = Date.parse(expectedStartsAt);
  if (!Number.isFinite(current) || !Number.isFinite(expected) || current !== expected || current <= Date.now()) return { allowed: false, reason: 'stale_appointment' };
  // updated_at is NOT a reliable appointment revision. Require explicit canonical revision.
  if (!Number.isSafeInteger(expectedRevision) || !Number.isSafeInteger(booking.appointment_revision) || expectedRevision !== booking.appointment_revision) return { allowed: false, reason: 'unverified_revision' };
  return { allowed: false, reason: 'transport_hold' };
}

export async function runSmartReminderDeliveryDisabledBridge() {
  return { skipped: true, reason: 'transport_hold', claimed: 0, sent: 0 };
}
