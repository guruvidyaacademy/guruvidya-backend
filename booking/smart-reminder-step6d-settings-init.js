// Step 6D: explicit, one-time, non-destructive Reminder Settings initialization.
// Never overwrites an existing smart_reminders configuration. Never enables sending.
const DEFAULTS = Object.freeze({
  master_enabled:false,
  offline:{'4h':{whatsapp:true,email:true},'2h':{whatsapp:true,email:true},'1h':{whatsapp:true,email:true}},
  online:{'4h':{whatsapp:true,email:true},'2h':{whatsapp:true,email:true},'1h':{whatsapp:true,email:true},'5min':{whatsapp:true,email:true}},
  fallback_minutes:{'4h':60,'2h':30,'1h':10,'5min':0},
  stage_minutes:{offline:{'4h':240,'2h':120,'1h':60},online:{'4h':240,'2h':120,'1h':60,'5min':5}}
});
export async function ensureSmartReminderSettings(pool) {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize with concurrent startup; preserve all existing booking settings.
    await client.query("INSERT INTO booking_settings(id,settings) VALUES(1,'{}'::jsonb) ON CONFLICT (id) DO NOTHING");
    const current=await client.query('SELECT settings FROM booking_settings WHERE id=1 FOR UPDATE');
    const root=current.rows[0]?.settings;
    if (!root || typeof root!=='object' || Array.isArray(root)) throw Error('invalid_booking_settings_root');
    if (Object.prototype.hasOwnProperty.call(root,'smart_reminders')) {
      if (!root.smart_reminders || typeof root.smart_reminders!=='object' || Array.isArray(root.smart_reminders)) throw Error('existing_smart_reminders_invalid_manual_review');
      await client.query('COMMIT');
      return {ok:true,action:'already_exists_preserved',masterChanged:false,dispatchEnabled:false};
    }
    await client.query("UPDATE booking_settings SET settings=jsonb_set(settings,'{smart_reminders}',$1::jsonb,true) WHERE id=1",[JSON.stringify(DEFAULTS)]);
    await client.query('COMMIT');
    return {ok:true,action:'defaults_initialized',masterEnabled:false,dispatchEnabled:false};
  } catch(e) {await client.query('ROLLBACK').catch(()=>{});throw e;}
  finally {client.release();}
}
