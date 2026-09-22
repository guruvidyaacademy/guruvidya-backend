// Build 8: reconcile reminder intentions against the live booking state.
// This never sends a provider message or marks an intention as delivered.
export async function reconcileBookingQueue(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const lock = await db.query('SELECT pg_try_advisory_xact_lock(75201946) AS locked');
    if (!lock.rows[0].locked) { await db.query('ROLLBACK'); return {skipped:true}; }
    const result = await db.query(`
      UPDATE booking_delivery_logs l SET status='superseded',
        detail=COALESCE(l.detail,'') || ' | Superseded by booking action, changed slot or elapsed appointment; never sent.'
      FROM student_bookings b
      WHERE l.booking_id=b.id AND l.status='queued' AND l.event LIKE 'reminder:%'
        AND (
          b.status NOT IN ('requested','approved','confirmed','rescheduled')
          OR b.customer_response <> 'awaiting'
          OR b.starts_at <= NOW()
          OR split_part(l.event,':',2) <> ((EXTRACT(EPOCH FROM b.starts_at)*1000)::bigint)::text
        ) RETURNING l.id`);
    // A recipient preference can change after queueing. Never retain an intention
    // addressed to a person the booking no longer selects.
    const recipients = await db.query(`
      UPDATE booking_delivery_logs l SET status='superseded',
        detail=COALESCE(l.detail,'') || ' | Recipient no longer selected; never sent.'
      FROM student_bookings b
      WHERE l.booking_id=b.id AND l.status='queued' AND l.event LIKE 'reminder:%'
        AND l.recipient IN ('student','parent')
        AND b.recipient IN ('student','parent') AND l.recipient <> b.recipient
      RETURNING l.id`);
    // Settings may be edited while a reminder is queued. Do not leave old
    // reminder-hour intentions eligible after an administrator removes an hour.
    const changedHours = await db.query(`
      UPDATE booking_delivery_logs l SET status='superseded',
        detail=COALESCE(l.detail,'') || ' | Reminder hour removed from settings; never sent.'
      FROM booking_settings s
      WHERE s.id=1 AND l.status='queued' AND l.event LIKE 'reminder:%'
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(s.settings->'reminder_hours')='array'
              THEN s.settings->'reminder_hours' ELSE '[4,2,1]'::jsonb END
          ) AS h(value)
          WHERE l.event LIKE ('reminder:%:' || h.value || 'h')
        ) RETURNING l.id`);
    await db.query('COMMIT');
    return {superseded:result.rowCount+recipients.rowCount+changedHours.rowCount,
      booking_state:result.rowCount,recipient_changed:recipients.rowCount,reminder_hour_removed:changedHours.rowCount};
  } catch(e) { await db.query('ROLLBACK'); throw e; }
  finally { db.release(); }
}
