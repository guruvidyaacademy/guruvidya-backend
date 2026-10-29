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
      // Cancel pending jobs whose booking was cancelled, trashed, or rescheduled.
      // This is queue housekeeping only: no provider calls or master unlock.
      const invalidated = await pool.query(`UPDATE booking_smart_reminder_jobs j
        SET status='cancelled', updated_at=NOW()
        FROM student_bookings b
        WHERE j.booking_id=b.id AND j.status='pending'
          AND (b.status NOT IN ('requested','approved','confirmed','rescheduled')
            OR b.trashed_at IS NOT NULL OR b.cancelled_at IS NOT NULL
            OR j.appointment_revision<>b.appointment_revision
            OR j.starts_at<>b.starts_at)`);
      console.info('[Smart Reminders Step 6F] QUEUE INVALIDATION',
        JSON.stringify({cancelledPending:invalidated.rowCount||0,dispatchEnabled:false}));
      // Housekeeping must run even while the master is OFF. It never sends messages.
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
          // Reject expired reminder stages so delayed ticks never enqueue stale sends.
          const result=await pool.query(`INSERT INTO booking_smart_reminder_jobs
            (booking_id,appointment_revision,recipient,channel,stage,mode,starts_at,due_at,status)
            SELECT b.id,b.appointment_revision,$3,$4,$5,$6,b.starts_at,$7::timestamptz,'pending'
            FROM student_bookings b WHERE b.id=$1 AND b.appointment_revision=$2
            AND b.starts_at=$8::timestamptz AND b.status IN ('requested','approved','confirmed','rescheduled')
            AND b.trashed_at IS NULL AND b.cancelled_at IS NULL AND b.starts_at>NOW()
            AND $7::timestamptz>NOW()
            AND NOT ( $3='student' AND EXISTS (
              SELECT 1 FROM booking_smart_4h_followup_choices f
              WHERE f.booking_id=b.id AND f.appointment_revision=b.appointment_revision::text
                AND f.choice='no'
            ))
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
