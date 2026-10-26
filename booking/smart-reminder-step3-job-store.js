// Step 3: opt-in, transaction-safe persistence of planned reminder jobs.
// UNMOUNTED. Never dispatches, starts a scheduler or executes a migration.
// Default entrypoint is HOLD; an explicitly supplied DB client is required for review tests.
const ACTIVE = new Set(['requested', 'approved', 'confirmed', 'rescheduled']);
const STAGES = new Set(['4h', '2h', '1h', '5min']);
const RECIPIENTS = new Set(['student', 'parent']);
const CHANNELS = new Set(['whatsapp', 'email']);
const MODES = new Set(['offline', 'online']);
const HOLD = Object.freeze({ persisted: 0, sent: 0, reason: 'transport_hold' });

export function validatePlannedJob(job) {
  if (!job || !Number.isSafeInteger(Number(job.bookingId)) || Number(job.bookingId) < 1 || Number(job.bookingId) > 2147483647 ||
      !Number.isSafeInteger(job.appointmentRevision) || job.appointmentRevision < 1 ||
      !STAGES.has(job.stage) || !RECIPIENTS.has(job.recipient) || !CHANNELS.has(job.channel) || !MODES.has(job.mode) ||
      (job.stage === '5min' && job.mode !== 'online')) throw Error('invalid_job');
  const start = Date.parse(job.startsAt), due = Date.parse(job.dueAt);
  if (!Number.isFinite(start) || !Number.isFinite(due) || due >= start) throw Error('invalid_job_dates');
  const minutes = { '4h': 240, '2h': 120, '1h': 60, '5min': 5 }[job.stage];
  if (start - due !== minutes * 60000) throw Error('invalid_stage_offset');
  const key = [job.bookingId, job.appointmentRevision, job.recipient, job.channel, job.stage].join(':');
  if (job.idempotencyKey !== key) throw Error('invalid_idempotency_key');
  return true;
}

// Review-only persistence. Requires independently verified schema, explicit opt-in,
// and a transaction-capable client. It never calls any messaging provider.
export async function persistPlannedSmartReminderJobs(client, jobs, { masterEnabled = false, schemaVerified = false, allowPersistence = false, now = new Date() } = {}) {
  if (!masterEnabled || !schemaVerified || !allowPersistence) return HOLD;
  if (!client || typeof client.query !== 'function' || !Array.isArray(jobs) || jobs.length > 500) throw Error('invalid_input');
  const clock = new Date(now).getTime();
  if (!Number.isFinite(clock)) throw Error('invalid_clock');
  for (const job of jobs) validatePlannedJob(job);
  let persisted = 0;
  // Each job is independently serialized with booking changes using the same advisory lock.
  for (const job of jobs) {
    let inTransaction = false;
    try {
      await client.query('BEGIN'); inTransaction = true;
      await client.query('SELECT pg_advisory_xact_lock($1,$2)', [75201948, Number(job.bookingId)]);
      const result = await client.query(
        'SELECT id, appointment_revision, starts_at, status, mode, trashed_at, cancelled_at FROM student_bookings WHERE id=$1 FOR UPDATE',
        [job.bookingId]
      );
      const booking = result.rows?.[0];
      const valid = booking && ACTIVE.has(String(booking.status || '').toLowerCase()) &&
        booking.trashed_at == null && booking.cancelled_at == null &&
        Number(booking.appointment_revision) === job.appointmentRevision &&
        Date.parse(booking.starts_at) === Date.parse(job.startsAt) &&
        String(booking.mode).toLowerCase() === job.mode &&
        Date.parse(job.dueAt) > clock && Date.parse(booking.starts_at) > clock;
      if (valid) {
        const inserted = await client.query(`INSERT INTO booking_smart_reminder_jobs
          (booking_id, appointment_revision, recipient, channel, stage, mode, starts_at, due_at, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
          ON CONFLICT (booking_id,appointment_revision,recipient,channel,stage) DO NOTHING RETURNING id`,
          [job.bookingId, job.appointmentRevision, job.recipient, job.channel, job.stage, job.mode, job.startsAt, job.dueAt]);
        if (inserted.rowCount === 1) persisted++;
      }
      await client.query('COMMIT'); inTransaction = false;
    } catch (error) {
      if (inTransaction) { try { await client.query('ROLLBACK'); } catch (_) {} }
      throw error;
    }
  }
  return Object.freeze({ persisted, sent: 0, reason: 'persisted_delivery_disabled' });
}

// No automatic execution, even when this module is imported.
export async function runSmartReminderStep3Disabled() { return HOLD; }
