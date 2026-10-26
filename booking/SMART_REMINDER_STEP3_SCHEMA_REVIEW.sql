-- STEP 3 REVIEW ONLY: do not apply automatically.
-- Requires human verification of existing student_bookings fields and revision writer.
-- Does not create a cron job, activate sending, or alter any existing table.
CREATE TABLE IF NOT EXISTS public.booking_smart_reminder_jobs (
  id BIGSERIAL PRIMARY KEY,
  booking_id BIGINT NOT NULL,
  appointment_revision INTEGER NOT NULL CHECK (appointment_revision >= 1),
  recipient TEXT NOT NULL CHECK (recipient IN ('student','parent')),
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp','email')),
  stage TEXT NOT NULL CHECK (stage IN ('4h','2h','1h','5min')),
  mode TEXT NOT NULL CHECK (mode IN ('offline','online')),
  starts_at TIMESTAMPTZ NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','skipped','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT smart_reminder_job_mode_stage CHECK (stage <> '5min' OR mode='online'),
  CONSTRAINT smart_reminder_job_unique UNIQUE (booking_id,appointment_revision,recipient,channel,stage)
);
CREATE INDEX IF NOT EXISTS smart_reminder_job_due_idx
  ON public.booking_smart_reminder_jobs(due_at,id) WHERE status='pending';
-- Old revisions are invalidated at claim time by rechecking student_bookings.
-- Optional later reconciliation can mark them skipped, but must not send them.
