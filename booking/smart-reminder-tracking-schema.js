// Additive, idempotent Smart Reminder tracking foundation.
// Runs only during existing initBooking(); does NOT mount a scheduler or send messages.
// booking_id is deliberately not a foreign key: legacy student_bookings may lack a
// database-enforced UNIQUE/PRIMARY KEY on id. This avoids modifying that working table.
export async function initSmartReminderTrackingSchema(pool) {
  const sql = String.raw`-- Guruvidya Smart Appointment Reminders — Step 1 (review before applying)
-- ADDITIVE ONLY. Not executed by the application or this package.
-- Does not enable scheduler, dispatch, callbacks, retention deletion, or revision writes.


ALTER TABLE public.student_bookings
  ADD COLUMN IF NOT EXISTS appointment_revision INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS public.booking_smart_reminder_claims (
  id BIGSERIAL PRIMARY KEY,
  booking_id BIGINT NOT NULL,
  appointment_revision INTEGER NOT NULL CHECK (appointment_revision >= 1),
  recipient TEXT NOT NULL CHECK (recipient IN ('student','parent')),
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp','email')),
  stage TEXT NOT NULL CHECK (stage IN ('4h','2h','1h','5min')),
  mode TEXT NOT NULL CHECK (mode IN ('offline','online')),
  status TEXT NOT NULL DEFAULT 'claimed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT smart_claim_mode_stage CHECK (stage <> '5min' OR mode='online'),
  CONSTRAINT smart_claim_unique UNIQUE (booking_id,appointment_revision,recipient,channel,stage)
);

CREATE TABLE IF NOT EXISTS public.booking_smart_reminder_deliveries (
  id BIGSERIAL PRIMARY KEY,
  booking_id BIGINT NOT NULL,
  appointment_revision INTEGER NOT NULL CHECK (appointment_revision >= 1),
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('student','parent')),
  stage TEXT NOT NULL CHECK (stage IN ('4h','2h','1h','5min')),
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp','email')),
  status TEXT NOT NULL DEFAULT 'claimed',
  provider_account_id TEXT,
  provider_message_id TEXT,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  first_clicked_at TIMESTAMPTZ,
  last_clicked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT smart_delivery_unique UNIQUE (booking_id,appointment_revision,recipient_type,stage,channel),
  CONSTRAINT smart_provider_identity_pair CHECK ((provider_account_id IS NULL) = (provider_message_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS smart_delivery_provider_identity_uidx
  ON public.booking_smart_reminder_deliveries(channel,provider_account_id,provider_message_id)
  WHERE provider_account_id IS NOT NULL AND provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS smart_delivery_recent_idx
  ON public.booking_smart_reminder_deliveries(created_at DESC,booking_id);
CREATE INDEX IF NOT EXISTS smart_delivery_booking_idx
  ON public.booking_smart_reminder_deliveries(booking_id,recipient_type,stage,channel);

CREATE TABLE IF NOT EXISTS public.booking_smart_reminder_click_events (
  id BIGSERIAL PRIMARY KEY,
  delivery_id BIGINT NOT NULL REFERENCES public.booking_smart_reminder_deliveries(id) ON DELETE RESTRICT,
  button_key TEXT NOT NULL,
  provider_event_id TEXT,
  clicked_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS smart_click_provider_event_uidx
  ON public.booking_smart_reminder_click_events(delivery_id,provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS smart_click_delivery_time_idx
  ON public.booking_smart_reminder_click_events(delivery_id,clicked_at DESC,id DESC);

CREATE TABLE IF NOT EXISTS public.booking_smart_reminder_window_events (
  id BIGSERIAL PRIMARY KEY,
  booking_id BIGINT NOT NULL,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('student','parent')),
  event_type TEXT NOT NULL CHECK (event_type IN ('inbound_verified','window_opened','extension_requested','extension_replied','window_expired','window_closed')),
  event_at TIMESTAMPTZ NOT NULL,
  window_expires_at TIMESTAMPTZ,
  provider_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS smart_window_provider_event_uidx
  ON public.booking_smart_reminder_window_events(booking_id,recipient_type,provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS smart_window_booking_time_idx
  ON public.booking_smart_reminder_window_events(booking_id,recipient_type,event_at DESC);


`;
  // The SQL is static; it never interpolates request input.
  await pool.query(sql);
}
