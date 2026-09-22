import { bookingDispatchLockSql, bookingDispatchUnlockSql, bookingDispatchLockArgs } from './booking-dispatch-lock.js';
// Opt-in delivery of queued booking reminders using an explicitly selected APPROVED,
// STATIC BotSailor appointment template. Disabled unless all required env vars are set.
// Provider acceptance is not proof of handset delivery. No automatic retry on uncertainty.
import { reminderEligibility } from './booking-reminder-eligibility.js';
import { staticReminderTemplateCheck } from './booking-template-safety.js';

export async function dispatchBookingReminders(pool, sendTemplate, options = {}) {
  if (process.env.BOOKING_REMINDER_DELIVERY_ENABLED !== 'true') return {disabled:true};
  const templateId = process.env.BOOKING_REMINDER_TEMPLATE_ID;
  if (!templateId || !/^[\w-]{1,100}$/.test(templateId)) return {disabled:true,reason:'template_id_not_configured'};
  if (typeof sendTemplate !== 'function') throw Error('Template sender not configured');
  const db = await pool.connect();
  let attempted=0,accepted=0,blocked=0;
  try {
    // One dispatcher per DB, including across application instances.
    const lock=await db.query('SELECT pg_try_advisory_lock(75201947) AS locked');
    if (!lock.rows[0].locked) return {skipped:true};
    const settings=await db.query('SELECT settings FROM booking_settings WHERE id=1');
    const raw=settings.rows[0]?.settings?.reminder_hours;
    const hours=Array.isArray(raw)?raw:[4,2,1];
    const template=await db.query(`SELECT botsailor_id,template_name,status,body_content FROM whatsapp_templates
      WHERE botsailor_id=$1 LIMIT 1`,[templateId]);
    if (template.rowCount!==1 || !['approved','active'].includes(String(template.rows[0].status||'').toLowerCase()))
      return {disabled:true,reason:'approved_template_not_found'};
    const safety=staticReminderTemplateCheck(template.rows[0],process.env.BOOKING_REMINDER_STATIC_TEMPLATE_REVIEWED_ID);
    if (!safety.safe) return {disabled:true,reason:'static_template_review_required',checks:safety.reasons};
    const queued=await db.query(`SELECT l.id,l.booking_id,l.event,l.recipient,l.channel,l.status,
      b.status AS booking_status,b.customer_response,b.starts_at,b.recipient AS recipient_preference,
      b.student_mobile,b.parent_mobile FROM booking_delivery_logs l
      JOIN student_bookings b ON b.id=l.booking_id
      WHERE l.status='queued' AND l.channel='whatsapp' AND l.event LIKE 'reminder:%'
      ORDER BY l.created_at,l.id LIMIT 50`);
    for (const item of queued.rows) {
      // Lock the booking before claiming and retain the session lock through the
      // provider call. Customer/admin mutations acquire the matching xact lock.
      const bookingLockArgs=bookingDispatchLockArgs(item.booking_id);
      await db.query(bookingDispatchLockSql(),bookingLockArgs);
      try {
      // Claim atomically, and re-read the latest booking state before calling provider.
      const claim=await db.query(`UPDATE booking_delivery_logs SET status='sending',sending_claimed_at=NOW(),detail='Delivery attempt claimed; provider result pending.'
        WHERE id=$1 AND status='queued' RETURNING id`,[item.id]);
      if (!claim.rowCount) continue;
      const current=await db.query(`SELECT l.id,l.event,l.recipient,b.status AS booking_status,b.customer_response,
        b.starts_at,b.recipient AS recipient_preference,b.student_mobile,b.parent_mobile
        FROM booking_delivery_logs l JOIN student_bookings b ON b.id=l.booking_id WHERE l.id=$1`,[item.id]);
      const row=current.rows[0],check=reminderEligibility(row,hours);
      if (check.blocked_reasons.length) {
        await db.query(`UPDATE booking_delivery_logs SET status='superseded',detail=$2 WHERE id=$1`,
          [item.id,JSON.stringify({reason:'ineligible_at_send_time',blocked_reasons:check.blocked_reasons})]);
        blocked++;continue;
      }
      const mobile=row.recipient==='student'?row.student_mobile:row.parent_mobile;
      attempted++;
      try {
        // Static template only: any variable/button placeholders require a separate
        // verified configuration and must not silently be sent with missing values.
        const result=await sendTemplate({mobile},template.rows[0],{});
        await db.query(`UPDATE booking_delivery_logs SET status=$2,detail=$3 WHERE id=$1`,
          [item.id,result?.success?'accepted':'failed',JSON.stringify({provider_status:result?.status||'unknown',
            http_status:result?.httpStatus||null,provider_accepted:result?.success===true,
            note:'Provider acceptance is not recipient delivery. No automatic retry.'})]);
        if(result?.success)accepted++;
      } catch(e) {
        // Network timeouts can occur AFTER the provider accepted a message.
        // Do not auto-retry or duplicate a potentially delivered reminder.
        await db.query(`UPDATE booking_delivery_logs SET status='unknown',detail=$2 WHERE id=$1`,
          [item.id,JSON.stringify({reason:'provider_outcome_unknown',note:'Manual reconciliation required; no automatic retry.'})]);
      }
      } finally {
        const unlocked=await db.query(bookingDispatchUnlockSql(),bookingLockArgs);
        if(unlocked.rows[0]?.pg_advisory_unlock!==true) throw Error('Booking dispatch lock release failed');
      }
    }
    return {attempted,accepted,blocked};
  } finally {
    try { await db.query('SELECT pg_advisory_unlock(75201947)'); } finally {db.release();}
  }
}
