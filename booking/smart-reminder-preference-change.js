'use strict';
// Isolated, manual-test preference controls. Does not send scheduled reminders.
const normalizeChoice = value => {
  const s=String(value||'').replace(/^#button[ _-]*reply#/i,'').trim().toLowerCase();
  return s==='yes'?'yes':s==='no'?'no':null;
};
const decisionFromReply = value => {
  const s=String(value||'').replace(/^#button[ _-]*reply#/i,'').trim().toLowerCase();
  return {'yes, turn on':'confirm','yes, turn off':'confirm','keep off':'keep','keep on':'keep'}[s]||null;
};
async function ensureSchema(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS booking_smart_4h_preference_events (
    id BIGSERIAL PRIMARY KEY, manual_test_id BIGINT NOT NULL REFERENCES booking_smart_reminder_manual_tests(id) ON DELETE CASCADE,
    booking_id BIGINT NOT NULL, appointment_revision TEXT NOT NULL,
    recipient_type TEXT NOT NULL CHECK(recipient_type IN ('student','parent')),
    event_type TEXT NOT NULL CHECK(event_type IN ('initial','requested','confirmed','kept')),
    previous_choice TEXT CHECK(previous_choice IN ('yes','no')),
    requested_choice TEXT NOT NULL CHECK(requested_choice IN ('yes','no')),
    provider_event_id TEXT NOT NULL UNIQUE, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS booking_smart_4h_preference_confirmations (
    id BIGSERIAL PRIMARY KEY, manual_test_id BIGINT NOT NULL REFERENCES booking_smart_reminder_manual_tests(id) ON DELETE CASCADE,
    booking_id BIGINT NOT NULL, appointment_revision TEXT NOT NULL,
    recipient_type TEXT NOT NULL CHECK(recipient_type IN ('student','parent')),
    previous_choice TEXT NOT NULL CHECK(previous_choice IN ('yes','no')),
    requested_choice TEXT NOT NULL CHECK(requested_choice IN ('yes','no')),
    request_provider_event_id TEXT NOT NULL UNIQUE,
    prompt_provider_message_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'sending' CHECK(status IN ('sending','sent','failed','confirmed','kept','expired')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ,
    decision_provider_event_id TEXT UNIQUE
  )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS gv_4h_one_open_confirmation
    ON booking_smart_4h_preference_confirmations(manual_test_id)
    WHERE status IN ('sending','sent')`);
}
function formatTime(value){return new Date(value).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'numeric',minute:'2-digit',hour12:true});}
async function handlePreference({pool,mobile,contextId,eventId,raw,sendButtons,providerId}){
  if(!mobile||!contextId||!eventId||eventId===contextId)return false;
  const choice=normalizeChoice(raw),decision=decisionFromReply(raw);
  if(!choice&&!decision)return false;
  const lastTen=String(mobile).replace(/\D/g,'').slice(-10);
  if(!/^\d{10}$/.test(lastTen))return false;
  if(decision){
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const r=await client.query(`SELECT p.*,f.choice AS current_choice,b.starts_at,b.status AS booking_status
        FROM booking_smart_4h_preference_confirmations p
        JOIN booking_smart_4h_followup_choices f ON f.manual_test_id=p.manual_test_id
        JOIN student_bookings b ON b.id=p.booking_id
        WHERE p.prompt_provider_message_id=$1 AND p.status='sent'
          AND regexp_replace(COALESCE(CASE WHEN p.recipient_type='parent' THEN b.parent_mobile ELSE b.student_mobile END,''),'[^0-9]','','g') IN ($2,'91'||$2)
        FOR UPDATE OF p`,[contextId,lastTen]);
      if(!r.rowCount){await client.query('ROLLBACK');return false;}
      const p=r.rows[0];
      const valid=String(p.appointment_revision)===String((await client.query('SELECT appointment_revision FROM student_bookings WHERE id=$1',[p.booking_id])).rows[0]?.appointment_revision)
        && new Date(p.starts_at)>new Date()&&['approved','confirmed','rescheduled'].includes(p.booking_status)
        && p.current_choice===p.previous_choice;
      const action=valid?(decision==='confirm'?'confirmed':'kept'):'expired';
      const updated=await client.query(`UPDATE booking_smart_4h_preference_confirmations SET status=$2,decided_at=NOW(),decision_provider_event_id=$3
        WHERE id=$1 AND status='sent' RETURNING id`,[p.id,action,eventId]);
      if(updated.rowCount){
        if(action==='confirmed')await client.query(`UPDATE booking_smart_4h_followup_choices SET choice=$2,choice_clicked_at=NOW(),choice_provider_event_id=$3 WHERE manual_test_id=$1 AND choice=$4`,[p.manual_test_id,p.requested_choice,eventId,p.previous_choice]);
        if(action==='confirmed'&&p.requested_choice==='no')await client.query(`UPDATE booking_smart_reminder_jobs SET status='cancelled',updated_at=NOW()
          WHERE booking_id=$1 AND appointment_revision::text=$2 AND recipient=$3
            AND channel='whatsapp' AND stage IN ('2h','1h') AND status='pending'`,
          [p.booking_id,p.appointment_revision,p.recipient_type]);
        if(action!=='expired')await client.query(`INSERT INTO booking_smart_4h_preference_events
          (manual_test_id,booking_id,appointment_revision,recipient_type,event_type,previous_choice,requested_choice,provider_event_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(provider_event_id) DO NOTHING`,
          [p.manual_test_id,p.booking_id,p.appointment_revision,p.recipient_type,action,p.previous_choice,p.requested_choice,eventId]);
      }
      await client.query('COMMIT');return true;
    }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
  }
  const r=await pool.query(`SELECT f.manual_test_id,f.booking_id,f.appointment_revision,f.choice,t.recipient_type,b.starts_at,
    CASE WHEN t.recipient_type='parent' THEN b.parent_mobile ELSE b.student_mobile END AS destination
    FROM booking_smart_4h_followup_choices f
    JOIN booking_smart_reminder_manual_tests t ON t.id=f.manual_test_id
    JOIN student_bookings b ON b.id=f.booking_id
    WHERE f.prompt_provider_message_id=$1 AND f.prompt_status='sent'
      AND t.stage='4h' AND t.channel='whatsapp' AND t.status='accepted'
      AND b.appointment_revision::text=f.appointment_revision
      AND b.starts_at>NOW() AND b.status IN ('approved','confirmed','rescheduled')
      AND regexp_replace(COALESCE(CASE WHEN t.recipient_type='parent' THEN b.parent_mobile ELSE b.student_mobile END,''),'[^0-9]','','g') IN ($2,'91'||$2)
    ORDER BY f.manual_test_id DESC LIMIT 1`,[contextId,lastTen]);
  if(!r.rowCount)return false;
  const f=r.rows[0];
  if(f.choice===null){
    const saved=await pool.query(`UPDATE booking_smart_4h_followup_choices SET choice=$2,choice_provider_event_id=$3,choice_clicked_at=NOW()
      WHERE manual_test_id=$1 AND choice IS NULL RETURNING manual_test_id`,[f.manual_test_id,choice,eventId]);
    if(saved.rowCount&&choice==='no')await pool.query(`UPDATE booking_smart_reminder_jobs SET status='cancelled',updated_at=NOW()
      WHERE booking_id=$1 AND appointment_revision::text=$2 AND recipient=$3
        AND channel='whatsapp' AND stage IN ('2h','1h') AND status='pending'`,
      [f.booking_id,f.appointment_revision,f.recipient_type]);
    if(saved.rowCount){await pool.query(`INSERT INTO booking_smart_4h_preference_events
      (manual_test_id,booking_id,appointment_revision,recipient_type,event_type,previous_choice,requested_choice,provider_event_id)
      VALUES($1,$2,$3,$4,'initial',NULL,$5,$6) ON CONFLICT(provider_event_id) DO NOTHING`,
      [f.manual_test_id,f.booking_id,f.appointment_revision,f.recipient_type,choice,eventId]);}
    return true;
  }
  if(f.choice===choice)return true;
  // Only one pending change per test; an older button cannot create concurrent prompts.
  const pending=await pool.query(`INSERT INTO booking_smart_4h_preference_confirmations
    (manual_test_id,booking_id,appointment_revision,recipient_type,previous_choice,requested_choice,request_provider_event_id)
    VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT DO NOTHING RETURNING id`,[f.manual_test_id,f.booking_id,f.appointment_revision,f.recipient_type,f.choice,choice,eventId]);
  if(!pending.rowCount)return true;
  const id=pending.rows[0].id;
  const turningOn=choice==='yes';
  const message=turningOn
    ?`Update Your Reminder Preference\n\nYou previously turned off further reminders. Would you like to turn reminders back on for your appointment at ${formatTime(f.starts_at)}?`
    :`Update Your Reminder Preference\n\nYou previously turned on further reminders. Would you like to turn off the remaining reminders for your appointment at ${formatTime(f.starts_at)}?`;
  const buttons=turningOn?[{id:'gv_pref_turn_on',title:'Yes, Turn On'},{id:'gv_pref_keep_off',title:'Keep Off'}]
    :[{id:'gv_pref_turn_off',title:'Yes, Turn Off'},{id:'gv_pref_keep_on',title:'Keep On'}];
  let response;
  try{response=await sendButtons({mobile:f.destination},message,buttons,'smart_4h_preference_confirmation');}
  catch(e){await pool.query("UPDATE booking_smart_4h_preference_confirmations SET status='failed' WHERE id=$1",[id]);throw e;}
  const promptId=providerId(response);
  await pool.query(`UPDATE booking_smart_4h_preference_confirmations SET status=$2,prompt_provider_message_id=$3 WHERE id=$1`,
    [id,response?.success===true&&promptId?'sent':'failed',promptId||null]);
  await pool.query(`INSERT INTO booking_smart_4h_preference_events
    (manual_test_id,booking_id,appointment_revision,recipient_type,event_type,previous_choice,requested_choice,provider_event_id)
    VALUES($1,$2,$3,$4,'requested',$5,$6,$7) ON CONFLICT(provider_event_id) DO NOTHING`,
    [f.manual_test_id,f.booking_id,f.appointment_revision,f.recipient_type,f.choice,choice,eventId]);
  return true;
}
export {ensureSchema,handlePreference,normalizeChoice,decisionFromReply};
