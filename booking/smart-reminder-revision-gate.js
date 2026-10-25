// Migration-gated; disabled by default. No SQL is run here.
export function revisionSetClause(booking, action) {
  if (!['reschedule', 'cancel', 'reassign', 'approve', 'confirm', 'complete', 'no_show'].includes(action)) return '';
  if (process.env.GV_SMART_REMINDER_REVISION_WRITES !== 'enabled') return '';
  if (!Number.isSafeInteger(booking?.appointment_revision) || booking.appointment_revision < 1) {
    const error = new Error('Smart Reminder revision schema is not verified');
    error.code = 'GV_REVISION_SCHEMA_MISSING';
    throw error;
  }
  return ',appointment_revision=appointment_revision+1';
}
