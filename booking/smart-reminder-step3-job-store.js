// Smart Reminders Step 3: safe, explicitly invoked PostgreSQL queue writer.
// No timer, HTTP route, provider dispatch, or Master Automation activation.
const ACTIVE = new Set(['requested', 'approved', 'confirmed', 'rescheduled']);
const STAGES = new Set(['4h','2h','1h','5min']);
const RECIPIENTS = new Set(['student','parent']);
const CHANNELS = new Set(['whatsapp','email']);
const MODES = new Set(['offline','online']);
const HOLD = Object.freeze({persisted:0, skipped:0, sent:0, reason:'scheduler_not_connected'});

export function validatePlannedJob(job) {
  if (!job || !Number.isSafeInteger(Number(job.bookingId)) || Number(job.bookingId) < 1 ||
    !Number.isSafeInteger(job.appointmentRevision) || job.appointmentRevision < 1 ||
    !STAGES.has(job.stage) || !RECIPIENTS.has(job.recipient) ||
    !CHANNELS.has(job.channel) || !MODES.has(job.mode) ||
    (job.stage === '5min' && job.mode !== 'online')) throw Error('invalid_job');
  const start = Date.parse(job.startsAt), due = Date.parse(job.dueAt);
  if (!Number.isFinite(start) || !Number.isFinite(due) || due >= start ||
    !Number.isSafeInteger(job.stageMinutes) || job.stageMinutes < 1 || job.stageMinutes > 10080 ||
    start - due !== job.stageMinutes * 60000) throw Error('invalid_job_dates');
  if (job.idempotencyKey !== [job.bookingId,job.appointmentRevision,job.recipient,job.channel,job.stage].join(':')) throw Error('invalid_idempotency_key');
  return true;
}

// Requires a dedicated pool with connect() so BEGIN/COMMIT stay on ONE connection.
// Caller must verify migrations and revision writes before explicitly enabling persistence.
export async function persistPlannedSmartReminderJobs(pool, jobs, {
  schemaVerified=false, revisionWritesVerified=false, allowPersistence=false, now=new Date()
}={}) {
  if (!schemaVerified || !revisionWritesVerified || !allowPersistence) return HOLD;
  if (!pool || typeof pool.connect !== 'function' || !Array.isArray(jobs) || jobs.length > 500) throw Error('invalid_input');
  const clock = new Date(now).getTime();
  if (!Number.isFinite(clock)) throw Error('invalid_clock');
  for (const job of jobs) validatePlannedJob(job);
  let persisted=0, skipped=0;
  const client=await pool.connect();
  try {
    for (const job of jobs) {
      let transaction=false;
      try {
        await client.query('BEGIN'); transaction=true;
        await client.query('SELECT pg_advisory_xact_lock($1,$2)',[75201948,Number(job.bookingId)]);
        const result=await client.query(`SELECT id,appointment_revision,starts_at,status,mode,trashed_at,cancelled_at
          FROM student_bookings WHERE id=$1 FOR UPDATE`,[job.bookingId]);
        const booking=result.rows?.[0];
        const valid=booking && ACTIVE.has(String(booking.status||'').toLowerCase()) &&
          booking.trashed_at == null && booking.cancelled_at == null &&
          Number(booking.appointment_revision)===job.appointmentRevision &&
          Date.parse(booking.starts_at)===Date.parse(job.startsAt) &&
          String(booking.mode).toLowerCase()===job.mode &&
          Date.parse(job.dueAt)>clock && Date.parse(booking.starts_at)>clock;
        if (valid) {
          const inserted=await client.query(`INSERT INTO booking_smart_reminder_jobs
            (booking_id,appointment_revision,recipient,channel,stage,mode,starts_at,due_at,status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
            ON CONFLICT (booking_id,appointment_revision,recipient,channel,stage) DO NOTHING RETURNING id`,
            [job.bookingId,job.appointmentRevision,job.recipient,job.channel,job.stage,job.mode,job.startsAt,job.dueAt]);
          persisted+=Number(inserted.rowCount===1);
        } else skipped++;
        await client.query('COMMIT'); transaction=false;
      } catch (error) {
        if (transaction) { try { await client.query('ROLLBACK'); } catch (_) {} }
        throw error;
      }
    }
  } finally { client.release(); }
  return Object.freeze({persisted,skipped,sent:0,reason:'queued_dispatch_disabled'});
}

export async function runSmartReminderStep3Disabled() { return HOLD; }
