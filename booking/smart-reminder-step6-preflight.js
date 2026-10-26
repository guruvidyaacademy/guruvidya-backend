// Read-only preflight for Guruvidya Phase 3 scheduler. No provider sends or writes.
export async function runSmartReminderStep6Preflight(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool required');
  const required = {
    booking_smart_reminder_jobs: ['id','booking_id','appointment_revision','recipient','channel','stage','mode','starts_at','due_at','status','created_at','updated_at'],
    student_bookings: ['id','appointment_revision','starts_at','status','mode','trashed_at','cancelled_at','student_mobile','parent_mobile','student_email','parent_email'],
    booking_settings: ['id','settings'],
  };
  const names=Object.keys(required);
  const res=await pool.query(`SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=ANY($1::text[])`,[names]);
  const present=new Map(names.map(name=>[name,new Set()]));
  for(const row of res.rows||[]) if(present.has(row.table_name)) present.get(row.table_name).add(row.column_name);
  const missing=Object.fromEntries(names.map(name=>[name,required[name].filter(c=>!present.get(name).has(c))]));
  const unique=await pool.query(`SELECT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname='booking_smart_reminder_jobs'
      AND c.contype='u' AND (
        SELECT array_agg(a.attname ORDER BY k.ordinality)
        FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum,ordinality)
        JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
      )=ARRAY['booking_id','appointment_revision','recipient','channel','stage']::name[]
  ) AS ok`);
  const queueUnique=unique.rows?.[0]?.ok===true;
  const ready=Object.values(missing).every(a=>a.length===0)&&queueUnique;
  return {ready,missing,queueUnique,dispatchEnabled:false,reason:ready?'schema_preflight_passed_dispatch_still_disabled':'schema_preflight_failed'};
}
