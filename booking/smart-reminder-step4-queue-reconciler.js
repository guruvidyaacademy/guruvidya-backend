// Step 4: opt-in queue planning ONLY. Never sends WhatsApp or email.
import { planSmartReminderStages } from './smart-reminder-stage-planner.js';
import { persistPlannedSmartReminderJobs } from './smart-reminder-step3-job-store.js';

export async function reconcileSmartReminderQueue(pool, {now=new Date(),limit=100}={}) {
  if (!Number.isInteger(limit) || limit<1 || limit>500) throw Error('invalid_limit');
  // No work unless revision writes are enabled and the operator has opted into queue planning.
  if (process.env.GV_SMART_REMINDER_QUEUE_PLANNING !== 'enabled' ||
      process.env.GV_SMART_REMINDER_REVISION_WRITES !== 'enabled')
    return {status:'disabled',persisted:0,sent:0};
  const schema=await pool.query(`SELECT
    to_regclass('public.booking_smart_reminder_jobs') IS NOT NULL AS jobs,
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='student_bookings' AND column_name='appointment_revision') AS revision`);
  if (!schema.rows[0]?.jobs || !schema.rows[0]?.revision) throw Error('smart_reminder_schema_not_ready');
  const settingsRow=await pool.query("SELECT settings->'smart_reminders' AS settings FROM booking_settings WHERE id=1");
  const settings=settingsRow.rows[0]?.settings;
  if (!settings || typeof settings!=='object') return {status:'settings_missing',persisted:0,sent:0};
  // Stage plans are allowed while master is OFF, but no dispatch is permitted.
  const bookings=await pool.query(`SELECT id,status,mode,starts_at,appointment_revision,trashed_at,cancelled_at,
      student_mobile,parent_mobile,student_email,parent_email
    FROM student_bookings WHERE starts_at>$1 AND starts_at<$1::timestamptz + interval '8 days'
      AND status IN ('requested','approved','confirmed','rescheduled') AND trashed_at IS NULL AND cancelled_at IS NULL
      AND appointment_revision >= 1 ORDER BY starts_at,id LIMIT $2`,[now,limit]);
  let persisted=0,skipped=0,planned=0;
  for(const booking of bookings.rows) {
    const recipients=[];
    if (booking.student_mobile || booking.student_email) recipients.push('student');
    if (booking.parent_mobile || booking.parent_email) recipients.push('parent');
    const plan=planSmartReminderStages({booking,now,masterEnabled:true,
      expectedRevision:Number(booking.appointment_revision),expectedStartsAt:booking.starts_at,
      settings,recipients,stageEnabled:({mode,stage,recipient,channel})=>
        settings[mode]?.[stage]?.[channel]===true && Boolean(booking[`${recipient}_${channel==='whatsapp'?'mobile':'email'}`])});
    if(!plan.items.length) continue;
    planned+=plan.items.length;
    const result=await persistPlannedSmartReminderJobs(pool,plan.items,{
      schemaVerified:true,revisionWritesVerified:true,allowPersistence:true,now});
    persisted+=result.persisted;skipped+=result.skipped;
  }
  // Invalidate pending jobs when appointment was cancelled, rescheduled or moved to trash.
  // Old revision rows remain as audit evidence, never sent.
  const invalidated=await pool.query(`UPDATE booking_smart_reminder_jobs j SET status='cancelled',updated_at=NOW()
    FROM student_bookings b WHERE j.booking_id=b.id AND j.status='pending'
      AND (b.status NOT IN ('requested','approved','confirmed','rescheduled')
        OR b.trashed_at IS NOT NULL OR b.cancelled_at IS NOT NULL
        OR j.appointment_revision<>b.appointment_revision OR j.starts_at<>b.starts_at)`);
  return {status:'queued_only',bookings:bookings.rowCount,planned,persisted,skipped,invalidated:invalidated.rowCount,sent:0};
}

export function startSmartReminderQueuePlanner(pool,{intervalMs=60000}={}) {
  if(process.env.GV_SMART_REMINDER_QUEUE_PLANNING!=='enabled') {
    console.log('[Smart Reminders Step 4] Queue planner disabled (safe default)');
    return null;
  }
  let busy=false;
  const tick=async()=>{
    if(busy)return;
    busy=true;
    try { const result=await reconcileSmartReminderQueue(pool);console.log('[Smart Reminders Step 4]',JSON.stringify(result)); }
    catch(e){console.error('[Smart Reminders Step 4] Queue planning error:',e.message);}
    finally{busy=false;}
  };
  const timer=setInterval(tick,intervalMs);
  timer.unref?.();
  void tick();
  return timer;
}
