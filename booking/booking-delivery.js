import { bookingDispatchLockSql, bookingDispatchUnlockSql, bookingDispatchLockArgs } from './booking-dispatch-lock.js';
// Opt-in delivery of queued booking reminders through the approved GuruVidya
// appointment-confirmation template. Delivery remains disabled unless the Render
// environment explicitly enables BOOKING_REMINDER_DELIVERY_ENABLED=true.
import { reminderEligibility } from './booking-reminder-eligibility.js';

const DEFAULT_BOOKING_TEMPLATE = 'booking_confirmation_fifteen_min';

function templateVariableKeys(template) {
  let map=template?.variable_map||{};
  if(typeof map==='string'){try{map=JSON.parse(map)}catch{map={}}}
  const raw=JSON.stringify(map||{});
  return [...new Set(raw.match(/templateVariable-[A-Za-z0-9_-]+-\d+/g)||[])]
    .sort((a,b)=>Number((a.match(/-(\d+)$/)||[])[1]||999)-Number((b.match(/-(\d+)$/)||[])[1]||999));
}

function bookingTemplateVariables(template,row) {
  const when=new Date(row.starts_at);
  const date=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',day:'numeric',month:'long',year:'numeric'}).format(when);
  const time=new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',hour:'numeric',minute:'2-digit',hour12:true}).format(when).replace(/am|pm/i,m=>m.toUpperCase());
  const values=[row.student_name||'Student',row.booking_ref||'',row.course||'',date,time];
  const keys=templateVariableKeys(template);
  const vars={};
  keys.slice(0,5).forEach((key,i)=>{vars[key]=values[i]});
  // BotSailor normally exposes generated keys in variable_map. If an imported
  // record does not, use the generated names corresponding to the five fields
  // created for this approved template.
  if(!keys.length){
    vars['templateVariable-StudentName-1']=values[0];
    vars['templateVariable-BookingReference-2']=values[1];
    vars['templateVariable-Course-3']=values[2];
    vars['templateVariable-AppointmentDate-4']=values[3];
    vars['templateVariable-AppointmentTime-5']=values[4];
  }
  return vars;
}

export async function dispatchBookingReminders(pool, sendTemplate, options = {}) {
  if (process.env.BOOKING_REMINDER_DELIVERY_ENABLED !== 'true') return {disabled:true};
  const configuredTemplateId=String(process.env.BOOKING_REMINDER_TEMPLATE_ID||'').trim();
  if (typeof sendTemplate !== 'function') throw Error('Template sender not configured');
  const db = await pool.connect();
  let attempted=0,accepted=0,blocked=0;
  try {
    const lock=await db.query('SELECT pg_try_advisory_lock(75201947) AS locked');
    if (!lock.rows[0].locked) return {skipped:true};
    const settings=await db.query('SELECT settings FROM booking_settings WHERE id=1');
    const raw=settings.rows[0]?.settings?.reminder_hours;
    const hours=Array.isArray(raw)?raw:[4,2,1];
    const template=configuredTemplateId
      ? await db.query(`SELECT botsailor_id,template_name,status,body_content,variable_map FROM whatsapp_templates WHERE botsailor_id=$1 LIMIT 1`,[configuredTemplateId])
      : await db.query(`SELECT botsailor_id,template_name,status,body_content,variable_map FROM whatsapp_templates
          WHERE LOWER(REPLACE(COALESCE(template_name,''),' ','_'))=$1
          ORDER BY imported_at DESC LIMIT 1`,[DEFAULT_BOOKING_TEMPLATE]);
    if (template.rowCount!==1 || !['approved','active'].includes(String(template.rows[0].status||'').toLowerCase()))
      return {disabled:true,reason:'approved_booking_confirmation_template_not_found'};
    const queued=await db.query(`SELECT l.id,l.booking_id,l.event,l.recipient,l.channel,l.status,
      b.status AS booking_status,b.customer_response,b.starts_at,b.recipient AS recipient_preference,
      b.student_mobile,b.parent_mobile,b.student_name,b.booking_ref,b.course FROM booking_delivery_logs l
      JOIN student_bookings b ON b.id=l.booking_id
      WHERE l.status='queued' AND l.channel='whatsapp' AND l.event LIKE 'reminder:%'
      ORDER BY l.created_at,l.id LIMIT 50`);
    for (const item of queued.rows) {
      const bookingLockArgs=bookingDispatchLockArgs(item.booking_id);
      await db.query(bookingDispatchLockSql(),bookingLockArgs);
      try {
      const claim=await db.query(`UPDATE booking_delivery_logs SET status='sending',sending_claimed_at=NOW(),detail='Delivery attempt claimed; provider result pending.'
        WHERE id=$1 AND status='queued' RETURNING id`,[item.id]);
      if (!claim.rowCount) continue;
      const current=await db.query(`SELECT l.id,l.event,l.recipient,b.status AS booking_status,b.customer_response,
        b.starts_at,b.recipient AS recipient_preference,b.student_mobile,b.parent_mobile,b.student_name,b.booking_ref,b.course
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
        const variables=bookingTemplateVariables(template.rows[0],row);
        const result=await sendTemplate({mobile},template.rows[0],variables);
        await db.query(`UPDATE booking_delivery_logs SET status=$2,detail=$3 WHERE id=$1`,
          [item.id,result?.success?'accepted':'failed',JSON.stringify({provider_status:result?.status||'unknown',
            http_status:result?.httpStatus||null,provider_accepted:result?.success===true,template:template.rows[0].template_name,
            note:'Provider acceptance is not recipient delivery. No automatic retry.'})]);
        if(result?.success)accepted++;
      } catch(e) {
        await db.query(`UPDATE booking_delivery_logs SET status='unknown',detail=$2 WHERE id=$1`,
          [item.id,JSON.stringify({reason:'provider_outcome_unknown',note:'Manual reconciliation required; no automatic retry.'})]);
      }
      } finally {
        const unlocked=await db.query(bookingDispatchUnlockSql(),bookingLockArgs);
        if(unlocked.rows[0]?.pg_advisory_unlock!==true) throw Error('Booking dispatch lock release failed');
      }
    }
    return {attempted,accepted,blocked,template:template.rows[0].template_name};
  } finally {
    try { await db.query('SELECT pg_advisory_unlock(75201947)'); } finally {db.release();}
  }
}
