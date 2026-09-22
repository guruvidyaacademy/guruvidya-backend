// Shared read-only eligibility checks. A queued intention is never proof of delivery.
export function reminderEligibility(row, allowedHours, now = Date.now()) {
  const reasons = [];
  const active = ['requested','approved','confirmed','rescheduled'];
  if (!active.includes(row.booking_status) || row.customer_response !== 'awaiting') reasons.push('booking_no_longer_eligible');
  const start = new Date(row.starts_at).getTime();
  if (!Number.isFinite(start) || start <= now) reasons.push('appointment_started_or_invalid');
  const match = /^reminder:(\d+):((?:\d+)(?:\.\d+)?)h$/.exec(String(row.event || ''));
  if (!match || !Number.isFinite(start) || Number(match?.[1]) !== start) reasons.push('outdated_or_invalid_slot_event');
  if (!match || !allowedHours.includes(Number(match[2]))) reasons.push('reminder_hour_removed');
  if (!['student','parent'].includes(row.recipient) || !['student','parent','both'].includes(row.recipient_preference) ||
      (row.recipient_preference !== 'both' && row.recipient_preference !== row.recipient)) reasons.push('recipient_not_selected');
  const raw = row.recipient === 'student' ? row.student_mobile : row.recipient === 'parent' ? row.parent_mobile : '';
  const normalized = String(raw || '').replace(/\D/g,'').replace(/^(?:91|0)(?=\d{10}$)/,'');
  if (!/^[6-9]\d{9}$/.test(normalized)) reasons.push('recipient_phone_missing_or_invalid');
  return {blocked_reasons:reasons, recipient_phone_last4:/^[6-9]\d{9}$/.test(normalized)?normalized.slice(-4):null};
}
