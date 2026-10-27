// Step 6C: read-only queue planner compatibility audit. Does not enqueue or send.
import { runSmartReminderStep6Preflight } from './smart-reminder-step6-preflight.js';
import { resolveSmartReminderStageMinutes, planSmartReminderStages } from './smart-reminder-stage-planner.js';

export async function auditSmartReminderQueueReadiness(pool, now=new Date()) {
  const schema=await runSmartReminderStep6Preflight(pool);
  if (!schema.ready) return {ready:false,reason:'schema_not_ready',schema,sent:0};
  const settingsResult=await pool.query("SELECT settings->'smart_reminders' AS smart FROM booking_settings WHERE id=1");
  const settings=settingsResult.rows?.[0]?.smart;
  if (!settings || typeof settings!=='object') return {ready:false,reason:'settings_missing',sent:0};
  try { resolveSmartReminderStageMinutes(settings); }
  catch(e) { return {ready:false,reason:'invalid_timing',error:String(e.message),sent:0}; }
  const bookingResult=await pool.query(`SELECT id,status,mode,starts_at,appointment_revision,trashed_at,cancelled_at,
    student_mobile,parent_mobile,student_email,parent_email
    FROM student_bookings WHERE starts_at>$1 AND starts_at<$1::timestamptz + interval '8 days'
    AND status IN ('requested','approved','confirmed','rescheduled')
    AND trashed_at IS NULL AND cancelled_at IS NULL ORDER BY starts_at,id LIMIT 50`,[now]);
  let eligible=0,planned=0,unrevisioned=0;
  for(const booking of bookingResult.rows||[]) {
    if (!Number.isSafeInteger(Number(booking.appointment_revision)) || Number(booking.appointment_revision)<1) {unrevisioned++;continue;}
    const recipients=['student','parent'].filter(r=>booking[`${r}_mobile`]||booking[`${r}_email`]);
    const result=planSmartReminderStages({booking,now,masterEnabled:true,
      expectedRevision:Number(booking.appointment_revision),expectedStartsAt:booking.starts_at,
      settings,recipients,stageEnabled:({mode,stage,recipient,channel})=>
        settings[mode]?.[stage]?.[channel]===true && Boolean(booking[`${recipient}_${channel==='whatsapp'?'mobile':'email'}`])});
    if(result.items.length) eligible++;
    planned+=result.items.length;
  }
  return {ready:true,reason:'read_only_queue_audit_passed',bookingsChecked:bookingResult.rows?.length||0,
    eligibleBookings:eligible,plannedJobsPreview:planned,unrevisionedBookings:unrevisioned,
    queueWritesEnabled:false,dispatchEnabled:false,sent:0};
}
