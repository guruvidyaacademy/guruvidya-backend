// Step 6E: guarded durable queue planner. Enqueue only; NEVER claim, dispatch, or send.
import { auditSmartReminderQueueReadiness } from './smart-reminder-step6c-queue-audit.js';
import { planSmartReminderStages } from './smart-reminder-stage-planner.js';

export function startSmartReminderStep6EQueueWorker(pool, {intervalMs=60000}={}) {
  if (process.env.GV_SMART_REMINDER_STEP6E_QUEUE !== '1') {
    console.info('[Smart Reminders Step 6E] QUEUE WORKER disabled (safe default)');
    return () => {};
  }
  let running=false, closed=false;
  async function tick() {
    if (closed || running) return;
    running=true;
    try {
      const audit=await auditSmartReminderQueueReadiness(pool);
      if (!audit.ready) {
        console.warn('[Smart Reminders Step 6E] QUEUE SKIPPED',JSON.stringify({reason:audit.reason}));
        return;
      }
      const settingsRow=await pool.query("SELECT settings->'smart_reminders' AS smart FROM booking_settings WHERE id=1");
      const settings=settingsRow.rows[0]?.smart;
      // Master OFF means no jobs are enqueued; it never enables dispatch.
      if (settings?.master_enabled!==true) {
        console.info('[Smart Reminders Step 6E] QUEUE HOLD',JSON.stringify({reason:'master_off',inserted:0,dispatchEnabled:false}));
        return;
      }
      const now=new Date();
      const bookings=await pool.query(`SELECT id,status,mode,starts_at,appointment_revision,trashed_at,cancelled_at,
        student_mobile,parent_mobile,student_email,parent_email FROM student_bookings
        WHERE starts_at>$1 AND starts_at<$1::timestamptz + interval '8 days'
        AND status IN ('requested','approved','confirmed','rescheduled')
        AND trashed_at IS NULL AND cancelled_at IS NULL ORDER BY starts_at,id LIMIT 100`,[now]);
      let planned=0,inserted=0;
      for (const booking of bookings.rows) {
        const revision=Number(booking.appointment_revision);
        if (!Number.isSafeInteger(revision)||revision<1) continue;
        const recipients=['student','parent'].filter(r=>booking[`${r}_mobile`]||booking[`${r}_email`]);
        const plan=planSmartReminderStages({booking,now,masterEnabled:true,settings,recipients,
          expectedRevision:revision,expectedStartsAt:booking.starts_at,
          stageEnabled:({mode,stage,recipient,channel})=>settings[mode]?.[stage]?.[channel]===true &&
            Boolean(booking[`${recipient}_${channel==='whatsapp'?'mobile':'email'}`])});
        for (const item of plan.items) {
          planned++;
          // Atomic booking recheck prevents queuing after cancellation/reschedule.
          const result=await pool.query(`INSERT INTO booking_smart_reminder_jobs
            (booking_id,appointment_revision,recipient,channel,stage,mode,starts_at,due_at,status)
            SELECT b.id,b.appointment_revision,$3,$4,$5,$6,b.starts_at,$7::timestamptz,'pending'
            FROM student_bookings b WHERE b.id=$1 AND b.appointment_revision=$2
            AND b.starts_at=$8::timestamptz AND b.status IN ('requested','approved','confirmed','rescheduled')
            AND b.trashed_at IS NULL AND b.cancelled_at IS NULL AND b.starts_at>NOW()
            ON CONFLICT (booking_id,appointment_revision,recipient,channel,stage) DO NOTHING
            RETURNING id`,[item.bookingId,item.appointmentRevision,item.recipient,item.channel,item.stage,item.mode,item.dueAt,item.startsAt]);
          inserted+=result.rowCount||0;
        }
      }
      console.info('[Smart Reminders Step 6E] QUEUE TICK',JSON.stringify({bookingsChecked:bookings.rowCount,planned,inserted,dispatchEnabled:false,sent:0}));
    } catch(error) {
      console.error('[Smart Reminders Step 6E] QUEUE ERROR',String(error?.message||error));
    } finally {running=false;}
  }
  // Start only after app bootstrap. Unref does not keep the server process alive.
  const timer=setInterval(tick,Math.max(30000,intervalMs));
  timer.unref?.();
  void tick();
  return ()=>{closed=true;clearInterval(timer);};
}
