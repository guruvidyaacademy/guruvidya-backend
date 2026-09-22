// Build 5: durable, delivery-disabled booking reminder queue and pending-response alerts.
// Queue rows are NOT proof of WhatsApp/email delivery. No provider is called here.
const eligible = ['requested','approved','confirmed','rescheduled'];
export async function runBookingReminderQueue(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // One worker per database; transaction lock also protects the unique event keys.
    const lock = await db.query('SELECT pg_try_advisory_xact_lock(75201945) AS locked');
    if (!lock.rows[0].locked) { await db.query('ROLLBACK'); return {skipped:true}; }
    const setting = await db.query('SELECT settings FROM booking_settings WHERE id=1');
    const raw = setting.rows[0]?.settings?.reminder_hours;
    const hours = [...new Set((Array.isArray(raw)?raw:[4,2,1]).filter(n=>Number.isFinite(n)&&n>0&&n<=168))].sort((a,b)=>b-a);
    const bookings = await db.query(`SELECT b.*, c.name AS counsellor_name, c.mobile AS counsellor_mobile
      FROM student_bookings b LEFT JOIN booking_counsellors c ON c.id=b.counsellor_id
      WHERE b.status=ANY($1::text[]) AND b.customer_response='awaiting'
      AND b.starts_at > NOW() - INTERVAL '2 days' AND b.starts_at < NOW() + INTERVAL '8 days'
      ORDER BY b.starts_at LIMIT 1000`,[eligible]);
    let queued=0, alerts=0;
    for (const b of bookings.rows) {
      const start = new Date(b.starts_at).getTime(), now=Date.now();
      if (start>now) {
        for (const h of hours) {
          // Send only in the window after the threshold, before the next threshold.
          // Never queue a past-due reminder or a reminder for an already-actioned booking.
          const threshold=start-h*3600000;
          const nextLower=hours.filter(x=>x<h).sort((a,b)=>b-a)[0];
          const windowEnd=nextLower===undefined?start:start-nextLower*3600000;
          if(now<threshold||now>=windowEnd)continue;
          const event=`reminder:${start}:${h}h`;
          const recipients = b.recipient==='student'?[['student',b.student_mobile]]:b.recipient==='parent'?[['parent',b.parent_mobile]]:[['student',b.student_mobile],['parent',b.parent_mobile]];
          for(const [who,mobile] of recipients) {
            if(!mobile)continue;
            const r=await db.query(`INSERT INTO booking_delivery_logs(booking_id,event,recipient,channel,status,detail)
              VALUES($1,$2,$3,'whatsapp','queued', $4) ON CONFLICT DO NOTHING RETURNING id`,
              [b.id,event,who,JSON.stringify({booking_ref:b.booking_ref,starts_at:b.starts_at,hours_before:h,delivery_disabled:true})]);
            queued+=r.rowCount;
          }
        }
      } else if (!b.admin_alert_sent_at) {
        const r=await db.query(`UPDATE student_bookings SET admin_alert_sent_at=NOW() WHERE id=$1 AND admin_alert_sent_at IS NULL
          AND customer_response='awaiting' AND status=ANY($2::text[]) RETURNING id`,[b.id,eligible]);
        if(r.rowCount){
          await db.query(`INSERT INTO booking_events(booking_id,actor,action,details) VALUES($1,'system','confirmation_pending_alert',$2)`,
            [b.id,JSON.stringify({message:'Appointment Confirmation Pending: The student/parent has not responded to the appointment confirmation reminders. Please contact them to confirm their availability.',booking_ref:b.booking_ref,starts_at:b.starts_at,counsellor_name:b.counsellor_name,student_name:b.student_name,parent_name:b.parent_name})]);
          alerts++;
        }
      }
    }
    await db.query('COMMIT');return {queued,alerts};
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
