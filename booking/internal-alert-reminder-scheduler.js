// Internal staff 24-hour-window reminder scheduler. Independent of booking lifecycle alerts.
// An incoming WhatsApp message starts a new cycle; unique claims make dispatch restart-safe.
export async function initInternalAlertReminderScheduler(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS booking_internal_reminder_deliveries (
    id BIGSERIAL PRIMARY KEY, recipient_id BIGINT NOT NULL,
    incoming_at TIMESTAMPTZ NOT NULL, channel TEXT NOT NULL,
    offset_minutes INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    provider TEXT, detail TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(recipient_id,incoming_at,channel,offset_minutes)
  )`);
}

export async function runInternalAlertReminderScheduler(pool, {sendEmail,sendWhatsApp,loadConfig}) {
  // Only reminders saved and enabled by the administrator are considered.
  const saved=await pool.query("SELECT value FROM booking_internal_alert_settings WHERE key='schedule'");
  const schedule=Array.isArray(saved.rows[0]?.value)?saved.rows[0].value:[];
  const rulesResult=await pool.query("SELECT value FROM booking_internal_alert_settings WHERE key='rules'");
  const rules=rulesResult.rows[0]?.value;
  if(rules?.master===false)return;
  const steps=schedule.filter(x=>x?.on===true&&['Email','WhatsApp'].includes(x.channel)&&Number.isInteger(x.hour)&&x.hour>=0&&x.hour<=23&&Array.from({length:12},(_,i)=>i*5).includes(x.minute));
  if(!steps.length)return;
  const recipients=await pool.query(`SELECT r.id,r.name,r.phone,r.email FROM booking_internal_recipients r
    JOIN booking_internal_departments d ON d.id=r.department_id WHERE r.active=TRUE ORDER BY r.id`);
  const now=Date.now();
  const numberedSteps=[...steps].sort((a,b)=>(a.hour*60+a.minute)-(b.hour*60+b.minute));
  for(const r of recipients.rows){
    const mobile=String(r.phone||'').replace(/\D/g,'').replace(/^91(?=\d{10}$)/,'');
    if(!/^\d{10}$/.test(mobile))continue;
    const evidence=await pool.query(`SELECT GREATEST(
      COALESCE((SELECT MAX(received_at) FROM whatsapp_window_events WHERE mobile IN ($1,$2)),'epoch'::timestamptz),
      COALESCE((SELECT MAX(last_customer_message_at) FROM leads WHERE regexp_replace(COALESCE(mobile,''),'[^0-9]','','g') IN ($1,$2)),'epoch'::timestamptz)
    ) AS last_incoming`,['91'+mobile,mobile]);
    const incoming=evidence.rows[0]?.last_incoming;
    if(!incoming)continue;
    const started=new Date(incoming).getTime();
    if(!Number.isFinite(started)||started>now||now-started>=86400000)continue;
    for(const step of numberedSteps){
      const offset=step.hour*60+step.minute;
      const due=started+offset*60000;
      // Only deliver within five minutes of the configured time; never backfill stale reminders.
      if(due>now||now-due>5*60000)continue;
      const channel=step.channel.toLowerCase();
      const reminderNumber=numberedSteps.indexOf(step)+1;
      const reminderTotal=numberedSteps.length;
      if(channel==='email'&&(rules?.email===false||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(r.email||'')))){
        await pool.query(`INSERT INTO booking_internal_reminder_deliveries(recipient_id,incoming_at,channel,offset_minutes,status,detail)
          VALUES($1,$2,$3,$4,'skipped',$5) ON CONFLICT DO NOTHING`,[r.id,incoming,channel,offset,rules?.email===false?'Email notifications disabled':'Recipient email missing or invalid']);
        continue;
      }
      if(channel==='whatsapp'&&rules?.open?.every(x=>x===false)){
        await pool.query(`INSERT INTO booking_internal_reminder_deliveries(recipient_id,incoming_at,channel,offset_minutes,status,detail)
          VALUES($1,$2,$3,$4,'skipped',$5) ON CONFLICT DO NOTHING`,[r.id,incoming,channel,offset,'WhatsApp OPEN-window notifications disabled']);
        continue;
      }
      const claimed=await pool.query(`INSERT INTO booking_internal_reminder_deliveries
        (recipient_id,incoming_at,channel,offset_minutes) VALUES($1,$2,$3,$4)
        ON CONFLICT DO NOTHING RETURNING id`,[r.id,incoming,channel,offset]);
      if(!claimed.rowCount)continue;
      const id=claimed.rows[0].id;
      let status='failed',provider=null,detail='';
      try{
        const remaining=Math.max(0,Math.ceil((started+86400000-now)/60000));
        const message=`GuruVidya Internal Appointment Alert\nWhatsApp 24-Hour Window Reminder\nReminder ${reminderNumber} of ${reminderTotal}\nRecipient: ${r.name}\nChannel: ${step.channel}\nWindow remaining: approximately ${Math.floor(remaining/60)}h ${remaining%60}m\n\nPlease reply to the GuruVidya WhatsApp number to start a new 24-hour service window.\n\nGuruVidya Academy Pvt. Ltd.`;
        if(channel==='email'){
          const result=await sendEmail({to:r.email,subject:`GuruVidya Alert | Reminder ${reminderNumber} of ${reminderTotal} | WhatsApp Window`,text:message});
          status='sent';provider=result?.provider||'email';detail='Accepted by email provider';
        }else{
          // Check fresh real incoming evidence again immediately before sending.
          const fresh=await pool.query(`SELECT MAX(received_at) AS last_incoming FROM whatsapp_window_events WHERE mobile IN ($1,$2)`,['91'+mobile,mobile]);
          const freshTime=new Date(fresh.rows[0]?.last_incoming||0).getTime();
          if(freshTime>started){status='skipped_new_incoming';detail='Window restarted after scheduling';}
          else if(Date.now()-started>=86400000){status='skipped_closed';detail='Real window expired';}
          else{
            await loadConfig();
            const result=await sendWhatsApp({mobile,name:r.name,course:''},message,'internal_window_reminder');
            if(!result?.success)throw new Error(result?.message||result?.status||'BotSailor send failed');
            status='sent';provider='botsailor';detail='Accepted by BotSailor';
          }
        }
      }catch(err){detail=String(err?.message||err).slice(0,500);}
      await pool.query(`UPDATE booking_internal_reminder_deliveries SET status=$2,provider=$3,detail=$4,updated_at=NOW() WHERE id=$1`,[id,status,provider,detail]);
    }
  }
}
