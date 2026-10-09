import { findMatchingBookingSlot } from './booking-slot-match.js';
import { getBookingMonitoringSummary } from './booking-monitoring-summary.js';
import { inspectBookingDatabase } from './booking-database-integration.js';
import { validateLifecycleSlot, validateLifecycleAction, validateReassignmentChange } from './booking-lifecycle-guards.js';
import { bookingSlotConflictQuery } from './booking-slot-conflict.js';
import { enqueueLifecycleBlockedIntents } from './booking-link-outbox.js';
import { randomUUID } from 'node:crypto';
import { bookingDispatchLockSql, bookingDispatchLockArgs } from './booking-dispatch-lock.js';
import { bookingDeliveryState } from './booking-delivery-state.js';
import { classifyAttemptForReview } from './booking-attempt-review.js';
import { reminderEligibility } from './booking-reminder-eligibility.js';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const phone = v => String(v || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '');
const bookingPhone = v => { const d=String(v||'').replace(/\D/g,''); return d.length===12&&d.startsWith('91')?d.slice(2):d; };
const validBookingPhone = v => /^\d{10}$/.test(v) || /^\d{8,15}$/.test(v);
const hash = token => createHash('sha256').update(token).digest('hex');
const active = ['requested','approved','confirmed','rescheduled'];
const validTime = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const fail = (res, code, message) => res.status(code).json({ success:false, message });

export async function initBooking(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS booking_counsellors (
    id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, mobile TEXT, meeting_link TEXT, active BOOLEAN NOT NULL DEFAULT TRUE,
    online BOOLEAN NOT NULL DEFAULT TRUE, offline BOOLEAN NOT NULL DEFAULT TRUE,
    working_hours JSONB NOT NULL DEFAULT '{"1":[["09:00","18:00"]],"2":[["09:00","18:00"]],"3":[["09:00","18:00"]],"4":[["09:00","18:00"]],"5":[["09:00","18:00"]],"6":[["09:00","18:00"]]}'::jsonb);
    CREATE TABLE IF NOT EXISTS booking_settings (id INTEGER PRIMARY KEY DEFAULT 1 CHECK(id=1), settings JSONB NOT NULL DEFAULT '{}'::jsonb);
    INSERT INTO booking_settings(id,settings) VALUES(1,'{"duration_minutes":30,"buffer_minutes":0,"advance_hours":2,"booking_days":30,"approval_required":false,"reminder_hours":[4,2,1],"offline_address":"","timezone":"Asia/Kolkata","student_address_visible":true,"student_address_required":true,"student_address_style":"detailed","whatsapp_verification_enabled":true,"email_notifications_enabled":true,"email_recipient_mode":"both"}') ON CONFLICT(id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS student_bookings (
      id BIGSERIAL PRIMARY KEY, booking_ref TEXT UNIQUE NOT NULL, token_hash TEXT NOT NULL,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL, linking_status TEXT NOT NULL DEFAULT 'pending',
      student_name TEXT NOT NULL, student_mobile TEXT, parent_name TEXT, parent_mobile TEXT, parent_relation TEXT,
      recipient TEXT NOT NULL DEFAULT 'both', course TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('online','offline')),
      counsellor_id BIGINT REFERENCES booking_counsellors(id), starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested', customer_response TEXT NOT NULL DEFAULT 'awaiting',
      response_at TIMESTAMPTZ, admin_alert_sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS cancellation_note TEXT;
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS cancelled_via TEXT;
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS admin_alert_ack_at TIMESTAMPTZ;
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS parent_relation TEXT;
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS student_email TEXT;
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS parent_email TEXT;
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS address_country TEXT;
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS address_state TEXT;
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS address_city TEXT;
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS address_postal_code TEXT;
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS address_line1 TEXT;
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS address_line2 TEXT;
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS admin_alert_ack_note TEXT;
    CREATE INDEX IF NOT EXISTS student_bookings_lead_idx ON student_bookings(lead_id,status);
    CREATE INDEX IF NOT EXISTS student_bookings_slot_idx ON student_bookings(counsellor_id,starts_at,ends_at);
    CREATE TABLE IF NOT EXISTS booking_events(id BIGSERIAL PRIMARY KEY, booking_id BIGINT REFERENCES student_bookings(id), actor TEXT NOT NULL, action TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS booking_delivery_logs(id BIGSERIAL PRIMARY KEY, booking_id BIGINT REFERENCES student_bookings(id), event TEXT NOT NULL, recipient TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(booking_id,event,recipient,channel));`);
  // One outbound rebooking invitation per cancelled booking and WhatsApp recipient.
  await pool.query(`CREATE TABLE IF NOT EXISTS booking_rebook_link_deliveries (
    booking_id BIGINT NOT NULL REFERENCES student_bookings(id) ON DELETE CASCADE,
    mobile TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(booking_id,mobile)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS booking_closed_dates (
    id BIGSERIAL PRIMARY KEY, start_date DATE NOT NULL, end_date DATE NOT NULL,
    title TEXT NOT NULL, counsellor_id BIGINT REFERENCES booking_counsellors(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK (end_date >= start_date)
  );
  CREATE INDEX IF NOT EXISTS booking_closed_dates_range_idx ON booking_closed_dates(start_date,end_date,counsellor_id);`);
  // Build 31: durable consent and a disabled-by-default private-link outbox foundation.
  // No bearer token or full management URL is stored in these tables.
  await pool.query(`CREATE TABLE IF NOT EXISTS booking_recipient_consents (
    booking_id BIGINT NOT NULL REFERENCES student_bookings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('student','parent')),
    mobile TEXT NOT NULL, verified BOOLEAN NOT NULL DEFAULT FALSE,
    opted_in BOOLEAN NOT NULL DEFAULT FALSE,
    source TEXT NOT NULL, verified_at TIMESTAMPTZ, consented_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ, PRIMARY KEY(booking_id,kind)
  );
  CREATE TABLE IF NOT EXISTS booking_private_link_outbox (
    id BIGSERIAL PRIMARY KEY, booking_id BIGINT NOT NULL REFERENCES student_bookings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('student','parent')),
    event TEXT NOT NULL, event_key TEXT NOT NULL,
    mobile_snapshot TEXT NOT NULL, slot_snapshot TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'blocked' CHECK(status IN ('blocked','ready','sending','accepted','unknown','failed','cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(booking_id,kind,event_key)
  );`);
  await pool.query(`ALTER TABLE booking_delivery_logs ADD COLUMN IF NOT EXISTS sending_claimed_at TIMESTAMPTZ`);
  await pool.query('ALTER TABLE booking_counsellors ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ');
  // Booking locations are persisted separately so branch/address/map settings survive deploys and restarts.
  await pool.query(`CREATE TABLE IF NOT EXISTS booking_locations (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    map_url TEXT NOT NULL DEFAULT '',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS booking_locations_single_default_idx ON booking_locations ((is_default)) WHERE is_default=TRUE;`);
  await pool.query('ALTER TABLE booking_counsellors ADD COLUMN IF NOT EXISTS location_id BIGINT REFERENCES booking_locations(id) ON DELETE SET NULL');
  await pool.query('ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ');
  await pool.query("ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS booked_by TEXT; ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS student_whatsapp_verified BOOLEAN NOT NULL DEFAULT FALSE; ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS parent_whatsapp_verified BOOLEAN NOT NULL DEFAULT FALSE;");
  await pool.query(`CREATE TABLE IF NOT EXISTS booking_whatsapp_verifications (
    id UUID PRIMARY KEY, request_token_hash TEXT NOT NULL, mobile TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('student','parent')),
    verification_code TEXT UNIQUE NOT NULL, verified_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS booking_whatsapp_verifications_mobile_idx ON booking_whatsapp_verifications(mobile,expires_at);
  ALTER TABLE whatsapp_window_events ADD COLUMN IF NOT EXISTS message_text TEXT;
  CREATE TABLE IF NOT EXISTS booking_whatsapp_window_test_overrides (
    mobile TEXT PRIMARY KEY, forced_open BOOLEAN NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS booking_whatsapp_window_test_slots (
    slot SMALLINT PRIMARY KEY CHECK(slot IN (1,2)), mobile TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);

}

export async function hasBookingSuppression(pool, leadId) {
  if (!leadId) return false;
  const r = await pool.query(`SELECT EXISTS(SELECT 1 FROM student_bookings WHERE lead_id=$1 AND linking_status='linked') AS blocked`,[leadId]);
  return r.rows[0].blocked;
}

export function installBookingRoutes(app,pool,hooks={}) {
  // Booking-only, server-verified short-lived bearer sessions. Never ship credentials in React.
  const sessions = new Map();
  const attempts = new Map();
  const equal = (a,b) => { const x=createHash('sha256').update(String(a)).digest(); const y=createHash('sha256').update(String(b)).digest(); return timingSafeEqual(x,y); };
  const sessionFor = req => {const raw=(req.get('authorization')||'').match(/^Bearer ([a-f0-9]{64})$/i)?.[1];if(!raw)return false;const key=hash(raw), expiry=sessions.get(key);if(!expiry)return false;if(expiry<Date.now()){sessions.delete(key);return false;}return true;};
  const whatsappWindowState = async mobileRaw => {
    const mobile=bookingPhone(mobileRaw);
    if(!/^\d{10}$/.test(mobile)) throw new Error('Enter a valid 10-digit mobile number');
    const canonical='91'+mobile;
    const real=await pool.query(`SELECT GREATEST(
      COALESCE((SELECT MAX(received_at) FROM whatsapp_window_events WHERE mobile IN ($1,$2)),'epoch'::timestamptz),
      COALESCE((SELECT MAX(last_customer_message_at) FROM leads WHERE regexp_replace(COALESCE(mobile,''),'[^0-9]','','g') IN ($1,$2)),'epoch'::timestamptz)
    ) AS last_incoming`,[canonical,mobile]);
    const last=real.rows[0]?.last_incoming;
    const realOpen=Boolean(last && new Date(last).getTime()>Date.now()-86400000);
    const override=await pool.query('SELECT forced_open,updated_at FROM booking_whatsapp_window_test_overrides WHERE mobile=$1',[mobile]);
    const forced=override.rowCount?Boolean(override.rows[0].forced_open):null;
    return {mobile,real_open:realOpen,last_incoming_at:last&&new Date(last).getTime()>0?last:null,test_override:forced===null?'real':forced?'open':'closed',effective_open:forced===null?realOpen:forced,override_updated_at:override.rows[0]?.updated_at||null};
  };

  app.post('/api/admin/booking/session',(req,res)=>{
    const ip=req.ip||'unknown', now=Date.now(), prior=attempts.get(ip)||{count:0,until:0};
    if(prior.until>now)return fail(res,429,'Too many attempts; try again later');
    const email=process.env.BOOKING_ADMIN_EMAIL, password=process.env.BOOKING_ADMIN_PASSWORD;
    if(!email||!password)return fail(res,503,'Booking admin credentials are not configured on the server');
    if(!equal(req.body?.email||'',email)||!equal(req.body?.password||'',password)){
      const count=prior.count+1;attempts.set(ip,{count:count>=5?0:count,until:count>=5?now+15*60*1000:0});return fail(res,401,'Invalid booking admin credentials');
    }
    attempts.delete(ip);const token=randomBytes(32).toString('hex');sessions.set(hash(token),now+8*60*60*1000);
    res.set('Cache-Control','no-store').json({success:true,data:{token,expires_in_seconds:28800}});
  });
  app.delete('/api/admin/booking/session',(req,res)=>{const raw=(req.get('authorization')||'').match(/^Bearer ([a-f0-9]{64})$/i)?.[1];if(raw)sessions.delete(hash(raw));res.json({success:true});});
  const admin = (req,res,next) => {
    if(!sessionFor(req)) return fail(res,401,'Booking admin session expired or unauthorized');
    next();
  };
  // Build 59: authenticated, read-only PostgreSQL staging inspection. No dispatch or migrations.
  app.get('/api/admin/booking/database-inspection',admin,async(req,res)=>{
    try {
      const result=await inspectBookingDatabase(pool);
      res.set('Cache-Control','no-store').json({success:true,data:result});
    } catch(error) {
      // Do not leak database credentials, SQL or connection details to the client.
      res.set('Cache-Control','no-store');
      fail(res,503,'Booking database inspection unavailable');
    }
  });
  const settings = async () => (await pool.query('SELECT settings FROM booking_settings WHERE id=1')).rows[0].settings;
  const log = (db,id,actor,action,details={}) => db.query('INSERT INTO booking_events(booking_id,actor,action,details) VALUES($1,$2,$3,$4)',[id,actor,action,JSON.stringify(details)]);
  const slots = async (db,date,mode,counsellorId,{excludeBookingId=null,includeBooked=false}={}) => {
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['online','offline'].includes(mode)) throw Error('Invalid date or mode');
    const cfg=await settings(), duration=Number(cfg.duration_minutes), buffer=Number(cfg.buffer_minutes||0);
    if(!(duration>=10 && duration<=240 && buffer>=0 && buffer<=120)) throw Error('Invalid booking settings');
    const people=await db.query(`SELECT * FROM booking_counsellors WHERE active AND archived_at IS NULL AND ${mode==='online'?"online AND NULLIF(BTRIM(COALESCE(meeting_link,'')),'') IS NOT NULL":'offline'} AND ($1::bigint IS NULL OR id=$1) ORDER BY id`,[counsellorId||null]);
    const closed=await db.query(`SELECT counsellor_id FROM booking_closed_dates WHERE start_date<=$1::date AND end_date>=$1::date`,[date]);
    const allClosed=closed.rows.some(x=>x.counsellor_id===null);
    const closedIds=new Set(closed.rows.filter(x=>x.counsellor_id!==null).map(x=>String(x.counsellor_id)));
    const out=[];
    for(const person of people.rows) {
      if(allClosed||closedIds.has(String(person.id)))continue;
      const day=new Date(`${date}T12:00:00+05:30`).getUTCDay();
      for(const range of person.working_hours?.[String(day)]||[]) {
        if(!Array.isArray(range)||range.length!==2) continue;
        const parse = t => { if(!/^\d\d:\d\d$/.test(t)) return NaN; return Date.parse(`${date}T${t}:00+05:30`); };
        const from=parse(range[0]),to=parse(range[1]);
        for(let start=from;start+duration*60000<=to;start+=(duration+buffer)*60000) {
          if(start<Date.now()+Number(cfg.advance_hours||0)*3600000 || start>Date.now()+Number(cfg.booking_days||30)*86400000) continue;
          const conflict=bookingSlotConflictQuery({excludeBookingId});
          const busy=await db.query(conflict.sql,[person.id,active,new Date(start+(duration+buffer)*60000),new Date(start-buffer*60000),conflict.excludedId]);
          if(!busy.rowCount) out.push({counsellor_id:person.id,counsellor_name:person.name,starts_at:new Date(start).toISOString(),ends_at:new Date(start+duration*60000).toISOString(),available:true});
          else if(includeBooked) out.push({counsellor_id:null,counsellor_name:null,starts_at:new Date(start).toISOString(),ends_at:new Date(start+duration*60000).toISOString(),available:false});
        }
      }
    }
    if(!includeBooked) return out;
    // Public slot picker is time-based: merge counsellors that share the same time.
    // A time remains available when at least one eligible counsellor is free.
    const byTime=new Map();
    for(const slot of out){
      const key=slot.starts_at;
      const current=byTime.get(key);
      if(!current || (!current.available && slot.available)) byTime.set(key,slot);
    }
    return [...byTime.values()].sort((a,b)=>Date.parse(a.starts_at)-Date.parse(b.starts_at));
  };
  app.get('/booking',async(req,res)=>{try{res.set({'Referrer-Policy':'no-referrer','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});res.type('html').send(await readFile(new URL('./booking-page.html',import.meta.url),'utf8'));}catch(e){fail(res,500,'Booking page unavailable');}});
  app.get('/api/public/booking/closed-dates',async(req,res)=>{
    try {const date=String(req.query.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+'T00:00:00Z')))return fail(res,400,'Invalid date');
      const r=await pool.query(`SELECT title,counsellor_id FROM booking_closed_dates WHERE start_date<=$1::date AND end_date>=$1::date ORDER BY id`,[date]);
      res.set('Cache-Control','no-store').json({success:true,data:r.rows});
    }catch{fail(res,500,'Closed dates unavailable');}
  });
  // Public mode availability reflects active, non-archived counsellors only.
  app.get('/api/public/booking/calendar-status',async(req,res)=>{
    try{
      const start=String(req.query.start||''),end=String(req.query.end||''),mode=String(req.query.mode||'offline');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||!['online','offline'].includes(mode)||start>end)return fail(res,400,'Invalid calendar range');
      const people=(await pool.query(`SELECT id,working_hours FROM booking_counsellors WHERE active AND archived_at IS NULL AND ${mode==='online'?"online AND NULLIF(BTRIM(COALESCE(meeting_link,'')),'') IS NOT NULL":'offline'} ORDER BY id`)).rows;
      const closed=(await pool.query(`SELECT title,counsellor_id,start_date::text,end_date::text FROM booking_closed_dates WHERE start_date<=$2::date AND end_date>=$1::date ORDER BY id`,[start,end])).rows;
      const result={};
      for(let cur=new Date(start+'T12:00:00+05:30'),stop=new Date(end+'T12:00:00+05:30');cur<=stop;cur=new Date(cur.getTime()+86400000)){
        const iso=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(cur),day=cur.getUTCDay();
        const applicable=closed.filter(x=>x.start_date<=iso&&x.end_date>=iso),whole=applicable.filter(x=>x.counsellor_id===null),closedIds=new Set(applicable.filter(x=>x.counsellor_id!==null).map(x=>String(x.counsellor_id)));
        const hasWorking=people.some(p=>!closedIds.has(String(p.id))&&Array.isArray(p.working_hours?.[String(day)])&&p.working_hours[String(day)].length>0);
        const holiday=whole.length>0;result[iso]={closed:holiday||!hasWorking,holiday,day_off:!holiday&&!hasWorking,title:whole.map(x=>x.title).filter(Boolean).join(', ')};
      }
      res.set('Cache-Control','no-store').json({success:true,data:result});
    }catch(e){fail(res,500,'Calendar availability unavailable');}
  });
  app.get('/api/admin/booking/whatsapp-window-test/saved',admin,async(req,res)=>{
    try{
      const r=await pool.query('SELECT slot,mobile FROM booking_whatsapp_window_test_slots ORDER BY slot');
      const saved={1:'',2:''}; for(const row of r.rows)saved[row.slot]=row.mobile||'';
      res.set('Cache-Control','no-store').json({success:true,data:saved});
    }catch(e){fail(res,500,'Unable to load saved WhatsApp test numbers');}
  });
  app.get('/api/admin/booking/whatsapp-window-test',admin,async(req,res)=>{
    try{
      const mobile=bookingPhone(req.query.mobile),slot=Number(req.query.slot||0);
      if(!/^\d{10}$/.test(mobile))return fail(res,400,'Enter a valid 10-digit mobile number');
      if(slot===1||slot===2){
        const prior=await pool.query('SELECT mobile FROM booking_whatsapp_window_test_slots WHERE slot=$1',[slot]);
        const oldMobile=bookingPhone(prior.rows[0]?.mobile||'');
        if(/^\d{10}$/.test(oldMobile)&&oldMobile!==mobile)await pool.query('DELETE FROM booking_whatsapp_window_test_overrides WHERE mobile=$1',[oldMobile]);
        await pool.query(`INSERT INTO booking_whatsapp_window_test_slots(slot,mobile,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(slot) DO UPDATE SET mobile=EXCLUDED.mobile,updated_at=NOW()`,[slot,mobile]);
      }
      res.set('Cache-Control','no-store').json({success:true,data:await whatsappWindowState(mobile)});
    }catch(e){fail(res,400,e.message||'Unable to check WhatsApp window');}
  });
  app.post('/api/admin/booking/whatsapp-window-test',admin,async(req,res)=>{
    try{
      const mobile=bookingPhone(req.body?.mobile),mode=String(req.body?.mode||''),slot=Number(req.body?.slot||0);
      if(!/^\d{10}$/.test(mobile)||!['open','closed','real'].includes(mode))return fail(res,400,'Enter a valid 10-digit mobile number and test mode');
      if(slot===1||slot===2){
        const prior=await pool.query('SELECT mobile FROM booking_whatsapp_window_test_slots WHERE slot=$1',[slot]);
        const oldMobile=bookingPhone(prior.rows[0]?.mobile||'');
        if(/^\d{10}$/.test(oldMobile)&&oldMobile!==mobile){
          await pool.query('DELETE FROM booking_whatsapp_window_test_overrides WHERE mobile=$1',[oldMobile]);
        }
        await pool.query(`INSERT INTO booking_whatsapp_window_test_slots(slot,mobile,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(slot) DO UPDATE SET mobile=EXCLUDED.mobile,updated_at=NOW()`,[slot,mobile]);
      }
      if(mode==='real')await pool.query('DELETE FROM booking_whatsapp_window_test_overrides WHERE mobile=$1',[mobile]);
      else await pool.query(`INSERT INTO booking_whatsapp_window_test_overrides(mobile,forced_open,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(mobile) DO UPDATE SET forced_open=EXCLUDED.forced_open,updated_at=NOW()`,[mobile,mode==='open']);
      res.set('Cache-Control','no-store').json({success:true,data:await whatsappWindowState(mobile)});
    }catch(e){fail(res,500,e.message||'Unable to update WhatsApp window test');}
  });

  app.post('/api/public/booking/whatsapp-verification/start',async(req,res)=>{
    try{
      const mobile=bookingPhone(req.body?.mobile),kind=String(req.body?.kind||'');
      if(!validBookingPhone(mobile)||!['student','parent'].includes(kind))return fail(res,400,'Enter a valid WhatsApp number');
      const id=randomUUID(),token=randomBytes(24).toString('hex'),code='GV-WA-'+randomBytes(3).toString('hex').toUpperCase();
      // First check the real customer-service window. Any genuine incoming message in
      // the last 24 hours means this number is already verified for booking purposes.
      const canonical=/^\d{10}$/.test(mobile)?'91'+mobile:mobile;
      const windowState=await whatsappWindowState(mobile);
      const alreadyOpen=Boolean(windowState.effective_open);
      await pool.query(`INSERT INTO booking_whatsapp_verifications(id,request_token_hash,mobile,kind,verification_code,verified_at,expires_at) VALUES($1,$2,$3,$4,$5,CASE WHEN $6 THEN NOW() ELSE NULL END,NOW()+INTERVAL '10 minutes')`,[id,hash(token),mobile,kind,code,alreadyOpen]);
      const message=`Verify my WhatsApp number for GuruVidya appointment • ${code}`;
      res.set('Cache-Control','no-store').json({success:true,data:{id,token,verified:alreadyOpen,window_open:alreadyOpen,expires_in_seconds:600,whatsapp_url:alreadyOpen?'':'https://wa.me/919821627725?text='+encodeURIComponent(message)}});
    }catch(e){console.error('BOOKING WHATSAPP VERIFICATION START',e?.message||e);fail(res,500,'Unable to start WhatsApp verification');}
  });
  app.get('/api/public/booking/whatsapp-verification/status',async(req,res)=>{
    try{
      const id=String(req.query.id||''),token=String(req.query.token||'');
      if(!id||!token)return fail(res,400,'Invalid verification request');
      const r=await pool.query(`SELECT id,mobile,verification_code,verified_at,expires_at,created_at FROM booking_whatsapp_verifications WHERE id=$1 AND request_token_hash=$2`,[id,hash(token)]);
      if(!r.rowCount)return fail(res,404,'Verification request not found');
      let row=r.rows[0];
      // Recovery path: if the incoming webhook recorded the exact verification text but
      // the direct session UPDATE was missed, bind that genuine message to this session.
      if(!row.verified_at && new Date(row.expires_at).getTime()>Date.now()){
        const canonical=/^\d{10}$/.test(row.mobile)?'91'+row.mobile:row.mobile;
        // Recovery path remains strict: only the exact session code or the explicit
        // VERIFY trigger can complete a session. A random WhatsApp message must never
        // verify a booking merely because it arrived after the popup opened.
        const evidence=await pool.query(`SELECT received_at FROM whatsapp_window_events
          WHERE mobile IN ($1,$2) AND received_at >= $3
            AND (UPPER(COALESCE(message_text,'')) LIKE '%'||UPPER($4)||'%'
                 OR UPPER(BTRIM(COALESCE(message_text,'')))='VERIFY')
          ORDER BY received_at DESC LIMIT 1`,[canonical,row.mobile,row.created_at,row.verification_code]);
        if(evidence.rowCount){
          const marked=await pool.query(`UPDATE booking_whatsapp_verifications SET verified_at=COALESCE(verified_at,$2) WHERE id=$1 RETURNING verified_at`,[row.id,evidence.rows[0].received_at]);
          row.verified_at=marked.rows[0]?.verified_at||evidence.rows[0].received_at;
          // A successful booking verification represents a fresh genuine inbound message.
          // Clear any forced CLOSED test state so the next form/admin check is OPEN.
          await pool.query('DELETE FROM booking_whatsapp_window_test_overrides WHERE mobile=$1',[row.mobile]);
        }
      }
      const expired=!row.verified_at&&new Date(row.expires_at).getTime()<=Date.now();
      res.set('Cache-Control','no-store').json({success:true,data:{verified:Boolean(row.verified_at),expired}});
    }catch(e){fail(res,500,'Unable to check WhatsApp verification');}
  });
  app.get('/api/public/booking/form-settings',async(req,res)=>{try{const cfg=await settings();res.set('Cache-Control','no-store').json({success:true,data:{student_address_visible:cfg.student_address_visible!==false,student_address_required:cfg.student_address_required!==false,student_address_style:cfg.student_address_style==='single'?'single':'detailed',whatsapp_verification_enabled:cfg.whatsapp_verification_enabled!==false,email_notifications_enabled:cfg.email_notifications_enabled!==false,email_recipient_mode:['student','parent'].includes(cfg.email_recipient_mode)?cfg.email_recipient_mode:'both'}});}catch(e){fail(res,503,'Booking form settings unavailable');}});
  app.get('/api/public/booking/modes',async(req,res)=>{
    try {
      const r=await pool.query(`SELECT
        EXISTS(SELECT 1 FROM booking_counsellors WHERE active AND archived_at IS NULL AND online AND NULLIF(BTRIM(COALESCE(meeting_link,'')),'') IS NOT NULL) AS online,
        EXISTS(SELECT 1 FROM booking_counsellors WHERE active AND archived_at IS NULL AND offline) AS offline`);
      res.set('Cache-Control','no-store').json({success:true,data:r.rows[0]});
    }catch(e){fail(res,503,'Booking modes unavailable');}
  });
  app.get('/api/public/booking/slots',async(req,res)=>{try{res.json({success:true,data:await slots(pool,req.query.date,req.query.mode,req.query.counsellor_id||null,{includeBooked:true})});}catch(e){fail(res,400,e.message);}});
  app.post('/api/public/booking',async(req,res)=>{
    const {student_name,student_mobile,parent_name,parent_mobile,parent_relation,student_email='',parent_email='',address_country='',address_state='',address_city='',address_postal_code='',address_line1='',address_line2='',course,mode,starts_at,counsellor_id,recipient='both',booked_by,primary_verification_id,primary_verification_token,secondary_verification_id,secondary_verification_token}=req.body;
    const sm=bookingPhone(student_mobile),pm=bookingPhone(parent_mobile);
    const normalizedStudentEmail=String(student_email||'').trim().toLowerCase(),normalizedParentEmail=String(parent_email||'').trim().toLowerCase();
    if(sm===pm)return fail(res,400,'Student and Parent/Guardian WhatsApp numbers must be different');
    if(normalizedStudentEmail&&normalizedParentEmail&&normalizedStudentEmail===normalizedParentEmail)return fail(res,400,'Student and Parent/Guardian email addresses must be different');
    if(!student_name?.trim()||!parent_name?.trim()||!validBookingPhone(sm)||!validBookingPhone(pm)||!['student','parent'].includes(booked_by)||!course?.trim()||!['online','offline'].includes(mode)||!validTime(starts_at)||!Number.isSafeInteger(Number(counsellor_id))||recipient!=='both')return fail(res,400,'Invalid booking details'); const emailOk=v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v||'').trim()); const formCfg=await settings(); const emailEnabled=formCfg.email_notifications_enabled!==false; const emailMode=['student','parent'].includes(formCfg.email_recipient_mode)?formCfg.email_recipient_mode:'both'; if(emailEnabled){const studentNeeded=emailMode==='student'||(emailMode==='both'&&booked_by==='student');const parentNeeded=emailMode==='parent'||(emailMode==='both'&&booked_by==='parent');if((studentNeeded&&!emailOk(student_email))||(parentNeeded&&!emailOk(parent_email))||(student_email&&!emailOk(student_email))||(parent_email&&!emailOk(parent_email)))return fail(res,400,'Provide a valid required email address');} const addressRequired=formCfg.student_address_visible!==false&&formCfg.student_address_required!==false; const addressStyle=formCfg.student_address_style==='single'?'single':'detailed'; if(addressRequired&&(addressStyle==='single'?!String(address_line1).trim():(!String(address_country).trim()||!String(address_state).trim()||!String(address_city).trim()||!String(address_postal_code).trim()||!String(address_line1).trim()||!String(address_line2).trim())))return fail(res,400,'Complete the student address');
    // Never accept a notification preference that points to a missing or malformed recipient.
    // A valid parent-only booking may still await manual student-lead linking.
    if ((student_mobile && !validBookingPhone(sm)) || (parent_mobile && !validBookingPhone(pm)) ||
        (recipient==='student' && !validBookingPhone(sm)) ||
        (recipient==='parent' && !validBookingPhone(pm)) ||
        (recipient==='both' && (!validBookingPhone(sm) || !validBookingPhone(pm))))
      return fail(res,400,'Provide a valid mobile for every selected notification recipient');
    const db=await pool.connect();
    try{
      await db.query('BEGIN');
      const primaryMobile=booked_by==='student'?sm:pm;
      const verificationRequired=formCfg.whatsapp_verification_enabled!==false;
      let primaryVerified=false;
      if(primary_verification_id&&primary_verification_token){
        const verification=await db.query(`SELECT id FROM booking_whatsapp_verifications WHERE id=$1 AND request_token_hash=$2 AND mobile=$3 AND kind=$4 AND verified_at IS NOT NULL AND expires_at>NOW() FOR UPDATE`,[String(primary_verification_id),hash(String(primary_verification_token)),primaryMobile,booked_by]);
        primaryVerified=verification.rowCount>0;
      }
      if(verificationRequired&&!primaryVerified){await db.query('ROLLBACK');return fail(res,409,'Please verify the WhatsApp number being used to make this booking');}
      const secondaryKind=booked_by==='student'?'parent':'student',secondaryMobile=secondaryKind==='student'?sm:pm;
      let secondaryVerified=false;
      if(secondary_verification_id&&secondary_verification_token){
        const secondary=await db.query(`SELECT id FROM booking_whatsapp_verifications WHERE id=$1 AND request_token_hash=$2 AND mobile=$3 AND kind=$4 AND verified_at IS NOT NULL AND expires_at>NOW()`,[String(secondary_verification_id),hash(String(secondary_verification_token)),secondaryMobile,secondaryKind]);
        secondaryVerified=secondary.rowCount>0;
      }
      const studentVerified=(booked_by==='student'&&primaryVerified)||(secondaryKind==='student'&&secondaryVerified),parentVerified=(booked_by==='parent'&&primaryVerified)||(secondaryKind==='parent'&&secondaryVerified);
      await db.query('SELECT pg_advisory_xact_lock($1)',[Number(counsellor_id)]);
      const date=new Date(new Date(starts_at).getTime()+330*60000).toISOString().slice(0,10);
      const available=await slots(db,date,mode,Number(counsellor_id));
      const slot=findMatchingBookingSlot(available,starts_at);
      if(!slot){await db.query('ROLLBACK');return fail(res,409,'Slot no longer available');}
      let leadId=null;
      if(/^\d{10}$/.test(sm)){
        const leads=await db.query(`SELECT id FROM leads WHERE regexp_replace(COALESCE(mobile,''),'[^0-9]','','g') IN ($1,$2,$3) ORDER BY id DESC LIMIT 2`,[sm,'91'+sm,'0'+sm]);
        if(leads.rowCount===1)leadId=leads.rows[0].id;
      }
      // Read the persisted approval switch within this booking transaction.
      const cfgRow=await db.query('SELECT settings FROM booking_settings WHERE id=1');
      const cfg=cfgRow.rows[0]?.settings||{};
      const approvalRequired=cfg.approval_required===true || cfg.approval_required==='true';
      const token=randomBytes(32).toString('hex'), ref='GV-'+randomBytes(6).toString('hex').toUpperCase();
      const result=await db.query(`INSERT INTO student_bookings(booking_ref,token_hash,lead_id,linking_status,student_name,student_mobile,parent_name,parent_mobile,parent_relation,student_email,parent_email,address_country,address_state,address_city,address_postal_code,address_line1,address_line2,recipient,course,mode,counsellor_id,starts_at,ends_at,status,booked_by,student_whatsapp_verified,parent_whatsapp_verified)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27) RETURNING id,booking_ref,starts_at,ends_at,status,linking_status`,[ref,hash(token),leadId,leadId?'linked':'pending',student_name.trim(),sm,parent_name.trim(),pm,String(parent_relation||'').trim(),String(student_email||'').trim(),String(parent_email||'').trim(),String(address_country||'').trim(),String(address_state||'').trim(),String(address_city||'').trim(),String(address_postal_code||'').trim(),String(address_line1||'').trim(),String(address_line2||'').trim(),recipient,course.trim(),mode,Number(counsellor_id),slot.starts_at,slot.ends_at,approvalRequired?'requested':'confirmed',booked_by,studentVerified,parentVerified]);
      if(!approvalRequired) await db.query("UPDATE student_bookings SET customer_response='confirmed',response_at=NOW() WHERE id=$1",[result.rows[0].id]);
      await log(db,result.rows[0].id,'customer','booked',{lead_id:leadId,mode});
      await enqueueLifecycleBlockedIntents(db,{bookingId:Number(result.rows[0].id),event:'created',eventKey:'created:'+randomUUID()});
      await db.query('COMMIT');
      const created={...result.rows[0],manage_token:token,student_name:student_name.trim(),student_mobile:sm,parent_name:parent_name.trim(),parent_mobile:pm,parent_relation:String(parent_relation||'').trim(),student_email:String(student_email||'').trim(),parent_email:String(parent_email||'').trim(),recipient,booked_by,student_whatsapp_verified:studentVerified,parent_whatsapp_verified:parentVerified,course:course.trim(),mode,counsellor_id:Number(counsellor_id)};
      // Booking is already committed. Return success to the browser immediately;
      // WhatsApp delivery can include media + staged action cards and must never keep
      // the booking request open long enough for the UI to show a false timeout.
      res.status(201).json({success:true,data:created});
      if(typeof hooks.onBookingCreated==='function'){
        Promise.resolve()
          .then(()=>hooks.onBookingCreated(created))
          .catch(err=>console.error('BOOKING WHATSAPP CREATE HOOK',err?.message||err));
      }
    }catch(e){await db.query('ROLLBACK');fail(res,500,'Unable to create booking');}finally{db.release();}
  });
  app.get('/api/public/booking/manage/:ref',async(req,res)=>{
    // Legacy query-token URLs can leak via HTTP access logs and browser history.
    // Only enable temporarily for a controlled migration of old links.
    if(process.env.BOOKING_ALLOW_LEGACY_QUERY_TOKEN !== 'true') return fail(res,410,'Legacy booking link retired; request a new private link');
    if(!/^[a-f0-9]{64}$/i.test(String(req.query.token||''))) return fail(res,404,'Booking not found');
    const r=await pool.query(`SELECT b.booking_ref,b.student_name,b.course,b.mode,b.starts_at,b.ends_at,b.status,b.customer_response,c.name AS counsellor_name,c.mobile AS counsellor_mobile,c.meeting_link,l.name AS offline_location_name,l.address AS offline_address,l.map_url AS offline_map_url FROM student_bookings b LEFT JOIN booking_counsellors c ON c.id=b.counsellor_id LEFT JOIN booking_locations l ON l.id=c.location_id WHERE b.booking_ref=$1 AND b.token_hash=$2`,[req.params.ref,hash(String(req.query.token||''))]);
    if(!r.rowCount)return fail(res,404,'Booking not found');res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}).json({success:true,data:r.rows[0]});
  });
  // Build 25: read management details via POST body; URL fragments never reach the server.
  // The legacy GET remains for compatibility but must not be used for newly issued links.
  app.post('/api/public/booking/manage/:ref/view',async(req,res)=>{
    const token=String(req.body?.token||'');
    if(!/^[a-f0-9]{64}$/i.test(token))return fail(res,404,'Booking not found');
    try {
      const r=await pool.query(`SELECT b.booking_ref,b.student_name,b.student_mobile,b.parent_name,b.parent_mobile,b.parent_relation,b.student_email,b.parent_email,b.address_country,b.address_state,b.address_city,b.address_postal_code,b.address_line1,b.address_line2,b.course,b.mode,b.starts_at,b.ends_at,b.status,b.customer_response,b.recipient,c.name AS counsellor_name,c.mobile AS counsellor_mobile,c.meeting_link,l.name AS offline_location_name,l.address AS offline_address,l.map_url AS offline_map_url FROM student_bookings b LEFT JOIN booking_counsellors c ON c.id=b.counsellor_id LEFT JOIN booking_locations l ON l.id=c.location_id WHERE b.booking_ref=$1 AND b.token_hash=$2`,[req.params.ref,hash(token)]);
      if(!r.rowCount)return fail(res,404,'Booking not found');
      const cfg=await settings();
      res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Pragma':'no-cache'}).json({success:true,data:{...r.rows[0],offline_address:String(cfg.offline_address||'')}});
    }catch(e){fail(res,500,'Unable to load booking');}
  });
  // Authenticated booking owner: use effective window for the existing Admin test controls.
  app.post('/api/public/booking/manage/:ref/rebook-whatsapp',async(req,res)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});
    const token=String(req.body?.token||'');
    if(!/^[a-f0-9]{64}$/i.test(token))return fail(res,404,'Booking not found');
    try{
      const found=await pool.query(`SELECT id,booking_ref,status,student_mobile,parent_mobile,recipient
        FROM student_bookings WHERE booking_ref=$1 AND token_hash=$2`,[req.params.ref,hash(token)]);
      if(!found.rowCount)return fail(res,404,'Booking not found');
      const b=found.rows[0];
      if(b.status!=='cancelled')return fail(res,409,'Appointment is not cancelled');
      // The booked-by contact is the primary recipient. The existing student number
      // is used for student-booked appointments, parent for parent-booked ones.
      const target=String(b.recipient||'').toLowerCase()==='parent'&&validBookingPhone(bookingPhone(b.parent_mobile))?b.parent_mobile:b.student_mobile;
      const mobile=bookingPhone(target);
      if(!/^\d{10}$/.test(mobile))return fail(res,400,'Booking WhatsApp number unavailable');
      const window=await whatsappWindowState(mobile);
      const effectiveOpen=Boolean(window.effective_open);
      const prior=await pool.query('SELECT status,updated_at FROM booking_rebook_link_deliveries WHERE booking_id=$1 AND mobile=$2',[b.id,mobile]);
      const current=prior.rows[0];
      const sent=current?.status==='sent';
      const stalePending=current?.status==='pending'&&Date.now()-new Date(current.updated_at).getTime()>120000;
      // Retry failed/stale sends at most once per 60 seconds. Atomic claim prevents duplicate polling sends.
      if(effectiveOpen&&!sent&&typeof hooks.onRebookLinkRequested==='function'){
        const claimed=await pool.query(`INSERT INTO booking_rebook_link_deliveries(booking_id,mobile,status,updated_at)
          VALUES($1,$2,'pending',NOW()) ON CONFLICT(booking_id,mobile) DO UPDATE SET
          status='pending',updated_at=NOW() WHERE
          (booking_rebook_link_deliveries.status='failed' OR
           (booking_rebook_link_deliveries.status='pending' AND booking_rebook_link_deliveries.updated_at<NOW()-INTERVAL '2 minutes'))
          AND booking_rebook_link_deliveries.updated_at<NOW()-INTERVAL '60 seconds'
          RETURNING booking_id`,[b.id,mobile]);
        if(claimed.rowCount){
          Promise.resolve().then(()=>hooks.onRebookLinkRequested({booking_ref:b.booking_ref,mobile:target}))
            .then(async result=>pool.query(`UPDATE booking_rebook_link_deliveries SET status=$3,updated_at=NOW()
              WHERE booking_id=$1 AND mobile=$2`,[b.id,mobile,result?.success?'sent':'failed']))
            .catch(async e=>{console.error('Rebooking WhatsApp failed',e?.message||e);await pool.query(`UPDATE booking_rebook_link_deliveries SET status='failed',updated_at=NOW() WHERE booking_id=$1 AND mobile=$2`,[b.id,mobile]).catch(()=>{});});
        }
      }
      res.json({success:true,data:{window_open:effectiveOpen,status:sent?'sent':current?.status||'pending',mobile,whatsapp_url:'https://wa.me/919821627725?text='+encodeURIComponent('VERIFY GV-BOOK-LINK '+b.booking_ref)}});
    }catch(e){console.error('Rebooking window status error',e?.message||e);fail(res,500,'Unable to check WhatsApp status');}
  });
  app.post('/api/public/booking/manage/:ref/action',async(req,res)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Pragma':'no-cache'});
    if(!/^[a-f0-9]{64}$/i.test(String(req.body?.token||'')))return fail(res,404,'Booking not found');
    if(!validateLifecycleAction(req.body.action,['confirm','cancel','reschedule']))return fail(res,400,'Invalid action');
    const db=await pool.connect();try{
      await db.query('BEGIN');
      const identity=await db.query('SELECT id FROM student_bookings WHERE booking_ref=$1 AND token_hash=$2',[req.params.ref,hash(String(req.body.token||''))]);
      if(!identity.rowCount){await db.query('ROLLBACK');return fail(res,404,'Booking not found');}
      await db.query(bookingDispatchLockSql(true),bookingDispatchLockArgs(identity.rows[0].id));
      const r=await db.query('SELECT * FROM student_bookings WHERE id=$1 FOR UPDATE',[identity.rows[0].id]);
      if(!r.rowCount){await db.query('ROLLBACK');return fail(res,404,'Booking not found');}
      const b=r.rows[0];if(!active.includes(b.status)){await db.query('ROLLBACK');return fail(res,409,'Booking is no longer active');}
      if(req.body.action==='confirm'){await db.query('ROLLBACK');return fail(res,409,'Student confirmation is not required');}
      if(req.body.action==='reschedule'){
        const slotError=validateLifecycleSlot(req.body.starts_at,b.starts_at);
        if(slotError){await db.query('ROLLBACK');return fail(res,400,slotError);}
        await db.query('SELECT pg_advisory_xact_lock($1)',[Number(b.counsellor_id)]);
        const date=new Date(new Date(req.body.starts_at).getTime()+330*60000).toISOString().slice(0,10);
        // Temporarily ignore own slot by excluding current booking in availability query is not needed for a different slot.
        const available=await slots(db,date,b.mode,b.counsellor_id,{excludeBookingId:Number(b.id)});
        const slot=findMatchingBookingSlot(available,req.body.starts_at);
        if(!slot){await db.query('ROLLBACK');return fail(res,409,'New slot unavailable');}
        const cfg=await settings();
        await db.query(`UPDATE student_bookings SET starts_at=$2,ends_at=$3,status=$4,customer_response=$5,response_at=NOW(),admin_alert_sent_at=NULL,admin_alert_ack_at=NULL,admin_alert_ack_note=NULL,updated_at=NOW() WHERE id=$1`,[b.id,slot.starts_at,slot.ends_at,cfg.approval_required?'requested':'confirmed',cfg.approval_required?'awaiting':'confirmed']);
      }else if(req.body.action==='cancel'){
        const reason=String(req.body.cancellation_reason||'').trim();
        const allowed=['Schedule Conflict','Personal Reasons','Date Not Suitable','Need Different Time','Prefer Online','Prefer Offline','Admission Plan Changed','Not Interested','Booked by Mistake','Duplicate Booking','Other Reason'];
        const note=String(req.body.cancellation_note||'').trim();
        if(!allowed.includes(reason)||(reason==='Other Reason'&&(!note||note.length>500))){await db.query('ROLLBACK');return fail(res,400,'Please select a valid cancellation reason');}
        await db.query(`UPDATE student_bookings SET status='cancelled',customer_response='cancelled',response_at=NOW(),updated_at=NOW(),cancellation_reason=$2,cancellation_note=$3,cancelled_via='Browser',cancelled_at=NOW() WHERE id=$1`,[b.id,reason,reason==='Other Reason'?note:null]);
      }
      else await db.query(`UPDATE student_bookings SET customer_response='confirmed',response_at=NOW(),status='confirmed',updated_at=NOW() WHERE id=$1`,[b.id]);
      await log(db,b.id,'customer',req.body.action,{old_starts_at:b.starts_at,new_starts_at:req.body.starts_at||null});
      if(req.body.action!=='cancel') await enqueueLifecycleBlockedIntents(db,{bookingId:Number(b.id),event:req.body.action==='confirm'?'confirmed':'rescheduled',eventKey:req.body.action+':'+randomUUID()});
      await db.query('COMMIT');
      // The reschedule is already committed. Confirm it to the browser immediately.
      // WhatsApp delivery continues after the HTTP response so its media/action-card
      // delays cannot trigger a false browser timeout or a second-slot retry.
      res.json({success:true});
      if(req.body.action==='cancel' && typeof hooks.onBookingCancelled==='function'){
        Promise.resolve().then(()=>hooks.onBookingCancelled({booking_ref:req.params.ref,manage_token:String(req.body.token||'')}))
          .catch(e=>console.error('Rebooking invitation check failed',e?.message||e));
      }
      if(req.body.action==='reschedule' && req.body.notify_whatsapp===true && typeof hooks.onBookingRescheduled==='function'){
        Promise.resolve()
          .then(()=>hooks.onBookingRescheduled({booking_ref:req.params.ref,manage_token:String(req.body.token||''),rescheduled:true}))
          .catch(e=>console.error('Booking reschedule WhatsApp confirmation failed:',e?.message||e));
      }
    }catch(e){await db.query('ROLLBACK');fail(res,500,'Unable to update booking');}finally{db.release();}
  });
  // Database-wide aggregate; unlike the 300-row notification list this is not a sample.
  app.get('/api/admin/booking/monitoring-summary',admin,async(req,res)=>{
    try { const data=await getBookingMonitoringSummary(pool);res.set('Cache-Control','no-store').json({success:true,data}); }
    catch(e){fail(res,500,'Unable to load booking monitoring summary');}
  });
  // Read-only operational queues. Status `queued` means NOT SENT; provider acceptance is not delivery.
  app.get('/api/admin/booking/notifications',admin,async(req,res)=>{
    try { const r=await pool.query(`SELECT l.id,l.booking_id,b.booking_ref,l.event,l.recipient,l.channel,l.status,l.detail,l.created_at
      FROM booking_delivery_logs l JOIN student_bookings b ON b.id=l.booking_id
      ORDER BY l.created_at DESC,l.id DESC LIMIT 300`);res.set('Cache-Control','no-store').json({success:true,data:r.rows}); }
    catch(e){fail(res,500,'Unable to load notification queue');}
  });
  // Human reconciliation queue: read-only, no phone numbers, no automatic retry.
  // Unknown provider outcomes must be checked against BotSailor records by staff.
  app.get('/api/admin/booking/attempts-needing-review',admin,async(req,res)=>{
    try {
      const r=await pool.query(`SELECT l.id,l.booking_id,b.booking_ref,l.event,l.recipient,
        l.channel,l.status,l.detail,l.created_at,l.sending_claimed_at
        FROM booking_delivery_logs l JOIN student_bookings b ON b.id=l.booking_id
        WHERE l.channel='whatsapp' AND l.status IN ('unknown','sending')
        ORDER BY l.created_at DESC,l.id DESC LIMIT 200`);
      res.set('Cache-Control','no-store').json({success:true,data:r.rows.map(row=>({
        ...row,...classifyAttemptForReview(row)
      })),note:'Check provider records before any manual action. Unknown is not proof of failure or delivery. This endpoint never retries or sends messages.'});
    }catch(e){fail(res,500,'Unable to load uncertain delivery attempts');}
  });
  // Operational readiness is distinct from provider acceptance and handset delivery.
  app.get('/api/admin/booking/delivery-readiness',admin,async(req,res)=>{
    try {
      const counts=await pool.query(`SELECT status,channel,COUNT(*)::int AS count
        FROM booking_delivery_logs GROUP BY status,channel ORDER BY channel,status`);
      const pending=await pool.query(`SELECT COUNT(*)::int AS count FROM student_bookings
        WHERE linking_status='pending' AND status=ANY($1::text[])`,[active]);
      res.set('Cache-Control','no-store').json({success:true,data:{
        ...bookingDeliveryState(),
        queue_status_counts:counts.rows, active_lead_linking_pending:pending.rows[0].count,
        note:'Queued reminders are NOT sent. Accepted means provider accepted the request, not handset delivery. Verify approved template and provider receipts.'
      }});
    } catch(e){fail(res,500,'Unable to load delivery readiness');}
  });
  // Build 11: read-only suppression audit; never expose unrelated lead details.
  // Suppression is persistent after cancellation until a separate, explicitly authorized
  // release workflow exists. This endpoint does not change lead or booking state.
  app.get('/api/admin/booking/lead-suppression/:leadId',admin,async(req,res)=>{
    const leadId=Number(req.params.leadId);
    if(!Number.isSafeInteger(leadId)||leadId<1)return fail(res,400,'Invalid lead ID');
    try {
      const lead=await pool.query('SELECT id FROM leads WHERE id=$1',[leadId]);
      if(!lead.rowCount)return fail(res,404,'Lead not found');
      const bookings=await pool.query(`SELECT id,booking_ref,status,linking_status,created_at
        FROM student_bookings WHERE lead_id=$1 AND linking_status='linked'
        ORDER BY created_at DESC LIMIT 100`,[leadId]);
      res.set('Cache-Control','no-store').json({success:true,data:{lead_id:leadId,
        ordinary_followups_suppressed:bookings.rowCount>0,
        suppression_policy:'Linked bookings retain suppression after cancellation; no automatic restart.',
        linked_bookings:bookings.rows}});
    }catch(e){fail(res,500,'Unable to check lead suppression');}
  });
  // Build 9: read-only per-recipient delivery preflight. No outbound calls or state changes.
  // A booking's student inbound window must never be reused for the parent's phone (or vice versa).
  app.get('/api/admin/booking/delivery-preflight',admin,async(req,res)=>{
    try {
      const r=await pool.query(`SELECT l.id,l.booking_id,b.booking_ref,l.event,l.recipient,l.channel,l.status,
        b.status AS booking_status,b.customer_response,b.starts_at,b.recipient AS recipient_preference,
        b.student_mobile,b.parent_mobile,l.created_at
        FROM booking_delivery_logs l JOIN student_bookings b ON b.id=l.booking_id
        WHERE l.status='queued' ORDER BY l.created_at DESC LIMIT 200`);
      const setting = await pool.query('SELECT settings FROM booking_settings WHERE id=1');
      const rawHours = setting.rows[0]?.settings?.reminder_hours;
      const allowedHours = Array.isArray(rawHours) ? rawHours : [4,2,1];
      const data=r.rows.map(row=>{
        const check=reminderEligibility(row,allowedHours);
        return {id:row.id,booking_id:row.booking_id,booking_ref:row.booking_ref,event:row.event,
          recipient:row.recipient,channel:row.channel,queue_status:row.status,starts_at:row.starts_at,
          booking_status:row.booking_status,customer_response:row.customer_response,
          recipient_phone_last4:check.recipient_phone_last4,eligible_for_delivery:false,
          blocked_reasons:[...check.blocked_reasons,...(bookingDeliveryState().whatsapp_dispatch_configured?[]:['whatsapp_dispatch_not_configured']),'approved_template_metadata_and_consent_not_verified_by_preflight']};
      });
      res.set('Cache-Control','no-store').json({success:true,data,delivery_state:bookingDeliveryState(),
        note:'Preflight is read-only; no message is sent by this endpoint. See individual queue statuses for dispatcher attempts.'});
    }catch(e){fail(res,500,'Unable to load delivery preflight');}
  });
  app.get('/api/admin/booking/pending-alerts',admin,async(req,res)=>{
    try {const r=await pool.query(`SELECT b.id,b.booking_ref,b.student_name,b.student_mobile,b.parent_name,b.parent_mobile,b.course,b.mode,b.starts_at,b.admin_alert_sent_at,b.admin_alert_ack_at,b.admin_alert_ack_note,c.name AS counsellor_name,c.mobile AS counsellor_mobile
      FROM student_bookings b LEFT JOIN booking_counsellors c ON c.id=b.counsellor_id
      WHERE b.admin_alert_sent_at IS NOT NULL AND b.admin_alert_ack_at IS NULL AND b.customer_response='awaiting' AND b.status=ANY($1::text[])
      ORDER BY b.starts_at DESC LIMIT 200`,[active]);res.json({success:true,data:r.rows});}
    catch(e){fail(res,500,'Unable to load pending alerts');}
  });
  // Staff acknowledgement records manual follow-up only; it is NOT customer confirmation.
  app.post('/api/admin/booking/:id/acknowledge-alert',admin,async(req,res)=>{
    const id=Number(req.params.id),note=req.body?.note;
    if(!Number.isSafeInteger(id)||id<1||typeof note!=='string'||note.trim().length<3||note.trim().length>500)
      return fail(res,400,'Provide a follow-up note (3–500 characters)');
    const db=await pool.connect();
    try {
      await db.query('BEGIN');
      const r=await db.query(`UPDATE student_bookings SET admin_alert_ack_at=NOW(),admin_alert_ack_note=$2,updated_at=NOW()
        WHERE id=$1 AND admin_alert_sent_at IS NOT NULL AND admin_alert_ack_at IS NULL
        AND customer_response='awaiting' AND status=ANY($3::text[])
        RETURNING id,booking_ref,admin_alert_ack_at`,[id,note.trim(),active]);
      if(!r.rowCount){await db.query('ROLLBACK');return fail(res,409,'Alert already acknowledged or booking no longer awaiting response');}
      await db.query(`INSERT INTO booking_events(booking_id,actor,action,details)
        VALUES($1,'booking_admin','confirmation_pending_alert_acknowledged',$2::jsonb)`,
        [id,JSON.stringify({note:note.trim()})]);
      await db.query('COMMIT');res.json({success:true,data:r.rows[0]});
    }catch(e){await db.query('ROLLBACK');fail(res,500,'Unable to acknowledge alert');}
    finally{db.release();}
  });
  app.get('/api/admin/booking',admin,async(req,res)=>{const r=await pool.query(`SELECT b.id,b.booking_ref,b.lead_id,b.linking_status,b.student_name,b.student_mobile,b.parent_name,b.parent_mobile,b.recipient,b.booked_by,b.student_whatsapp_verified,b.parent_whatsapp_verified,b.course,b.mode,b.counsellor_id,b.starts_at,b.ends_at,b.status,b.customer_response,b.response_at,b.cancellation_reason,b.cancellation_note,b.cancelled_via,b.cancelled_at,b.admin_alert_sent_at,b.created_at,b.updated_at,c.name AS counsellor_name,c.meeting_link,c.location_id,l.name AS location_name FROM student_bookings b LEFT JOIN booking_counsellors c ON c.id=b.counsellor_id LEFT JOIN booking_locations l ON l.id=c.location_id WHERE b.trashed_at IS NULL ORDER BY b.starts_at DESC LIMIT 500`);res.json({success:true,data:r.rows});});
  // Booking trash: reversible soft-delete; active appointments must be cancelled first.
  app.get('/api/admin/booking/trash',admin,async(req,res)=>{
    try {const r=await pool.query(`SELECT id,booking_ref,student_name,course,mode,starts_at,status,trashed_at FROM student_bookings WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC LIMIT 500`);res.json({success:true,data:r.rows});}
    catch {fail(res,500,'Unable to load booking trash');}
  });
  app.post('/api/admin/booking/trash',admin,async(req,res)=>{
    const rawIds=req.body?.ids;
    // PostgreSQL BIGSERIAL ids are serialized as strings by node-postgres. Accept decimal strings safely.
    if(!Array.isArray(rawIds)||!rawIds.length||rawIds.length>500||rawIds.some(id=>!((typeof id==='string'&&/^[1-9]\d*$/.test(id)&&BigInt(id)<=9223372036854775807n)||(typeof id==='number'&&Number.isSafeInteger(id)&&id>0))))return fail(res,400,'Select 1–500 valid bookings');
    const ids=rawIds.map(String);
    if(new Set(ids).size!==ids.length)return fail(res,400,'Duplicate booking selection');
    const db=await pool.connect();
    try {await db.query('BEGIN');const r=await db.query('SELECT id,status,starts_at FROM student_bookings WHERE id=ANY($1::bigint[]) AND trashed_at IS NULL FOR UPDATE',[ids]);
      if(r.rowCount!==ids.length){await db.query('ROLLBACK');return fail(res,409,'Some bookings are missing or already in Trash. Refresh and retry.');}
      if(r.rows.some(b=>!['cancelled','completed','no_show'].includes(b.status))){await db.query('ROLLBACK');return fail(res,409,'Cancel active appointments before moving them to Trash.');}
      await db.query('UPDATE student_bookings SET trashed_at=NOW(),updated_at=NOW() WHERE id=ANY($1::bigint[])',[ids]);
      for(const row of r.rows)await db.query("INSERT INTO booking_events(booking_id,actor,action) VALUES($1,'booking_admin','moved_to_trash')",[row.id]);
      await db.query('COMMIT');res.json({success:true,data:{count:ids.length}});
    }catch {await db.query('ROLLBACK');fail(res,500,'Unable to move bookings to Trash');}finally{db.release();}
  });
  app.post('/api/admin/booking/trash/restore',admin,async(req,res)=>{
    const rawIds=req.body?.ids;
    if(!Array.isArray(rawIds)||!rawIds.length||rawIds.length>500||rawIds.some(id=>!((typeof id==='string'&&/^[1-9]\d*$/.test(id)&&BigInt(id)<=9223372036854775807n)||(typeof id==='number'&&Number.isSafeInteger(id)&&id>0))))return fail(res,400,'Select valid bookings');
    const ids=rawIds.map(String);
    if(new Set(ids).size!==ids.length)return fail(res,400,'Duplicate booking selection');
    try {const r=await pool.query('UPDATE student_bookings SET trashed_at=NULL,updated_at=NOW() WHERE id=ANY($1::bigint[]) AND trashed_at IS NOT NULL RETURNING id',[ids]);if(r.rowCount!==ids.length)return fail(res,409,'Some bookings could not be restored. Refresh and retry.');res.json({success:true,data:{count:r.rowCount}});}
    catch {fail(res,500,'Unable to restore bookings');}
  });
  // Admin operations use the existing server-side secret guard; do not expose it in a frontend bundle.
  app.get('/api/admin/booking/:id/events',admin,async(req,res)=>{
    try {const r=await pool.query('SELECT actor,action,details,created_at FROM booking_events WHERE booking_id=$1 ORDER BY created_at DESC LIMIT 200',[req.params.id]);res.json({success:true,data:r.rows});}
    catch(e){fail(res,500,'Unable to load booking history');}
  });
  app.patch('/api/admin/booking/:id',admin,async(req,res)=>{
    const {action,counsellor_id,starts_at}=req.body||{};
    if(!validateLifecycleAction(action,['approve','cancel','complete','no_show','reassign','reschedule']))return fail(res,400,'Invalid action');
    const db=await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query(bookingDispatchLockSql(true),bookingDispatchLockArgs(Number(req.params.id)));
      const found=await db.query('SELECT * FROM student_bookings WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!found.rowCount){await db.query('ROLLBACK');return fail(res,404,'Booking not found');}
      const b=found.rows[0];
      if(!active.includes(b.status)){await db.query('ROLLBACK');return fail(res,409,'Booking is not active');}
      let nextStatus=b.status,nextCounsellor=b.counsellor_id,nextStart=b.starts_at,nextEnd=b.ends_at;
      if(action==='approve') {if(b.status!=='requested'){await db.query('ROLLBACK');return fail(res,409,'Booking does not need approval');}nextStatus='confirmed';}
      if(action==='cancel')nextStatus='cancelled';
      if(action==='complete'||action==='no_show'){
        if(new Date(b.starts_at).getTime()>Date.now()){await db.query('ROLLBACK');return fail(res,409,'Appointment has not started');}
        nextStatus=action==='complete'?'completed':'no_show';
      }
      if(action==='reassign'||action==='reschedule'){
        nextCounsellor=counsellor_id===undefined?Number(b.counsellor_id):Number(counsellor_id);
        if(!Number.isSafeInteger(nextCounsellor)||nextCounsellor<1){await db.query('ROLLBACK');return fail(res,400,'Invalid counsellor');}
        const target=await db.query('SELECT id FROM booking_counsellors WHERE id=$1 AND active',[nextCounsellor]);
        if(!target.rowCount){await db.query('ROLLBACK');return fail(res,404,'Counsellor unavailable');}
        nextStart=starts_at===undefined?new Date(b.starts_at).toISOString():starts_at;
        const slotError=validateLifecycleSlot(nextStart,action==='reschedule'?b.starts_at:undefined);
        if(slotError){await db.query('ROLLBACK');return fail(res,400,slotError);}
        if(action==='reschedule'&&starts_at===undefined){await db.query('ROLLBACK');return fail(res,400,'New slot required');}
        if(action==='reassign'){const changeError=validateReassignmentChange(b.counsellor_id,b.starts_at,nextCounsellor,nextStart);if(changeError){await db.query('ROLLBACK');return fail(res,400,changeError);}}
        // Lock both counsellors in deterministic order to avoid cross-reassignment races.
        for(const id of [...new Set([Number(b.counsellor_id),nextCounsellor])].sort((a,b)=>a-b))await db.query('SELECT pg_advisory_xact_lock($1)',[id]);
        const date=new Date(new Date(nextStart).getTime()+330*60000).toISOString().slice(0,10);
        const choices=await slots(db,date,b.mode,nextCounsellor,{excludeBookingId:Number(b.id)});
        const choice=findMatchingBookingSlot(choices,nextStart);
        if(!choice){await db.query('ROLLBACK');return fail(res,409,'Requested counsellor or slot is unavailable');}
        nextStart=choice.starts_at;nextEnd=choice.ends_at;
        nextStatus=action==='reschedule'?'rescheduled':b.status;
      }
      await db.query(`UPDATE student_bookings SET status=$2,counsellor_id=$3,starts_at=$4,ends_at=$5,updated_at=NOW(),customer_response=CASE WHEN $6='approve' THEN 'confirmed' WHEN $6='reschedule' THEN 'awaiting' ELSE customer_response END,response_at=CASE WHEN $6='reschedule' THEN NOW() ELSE response_at END,admin_alert_sent_at=CASE WHEN $6='reschedule' THEN NULL ELSE admin_alert_sent_at END,admin_alert_ack_at=CASE WHEN $6='reschedule' THEN NULL ELSE admin_alert_ack_at END,admin_alert_ack_note=CASE WHEN $6='reschedule' THEN NULL ELSE admin_alert_ack_note END WHERE id=$1`,[b.id,nextStatus,nextCounsellor,nextStart,nextEnd,action]);
      await log(db,b.id,'admin',action,{previous_status:b.status,previous_counsellor_id:b.counsellor_id,previous_starts_at:b.starts_at,new_status:nextStatus,new_counsellor_id:nextCounsellor,new_starts_at:nextStart});
      if(['approve','reschedule'].includes(action)) await enqueueLifecycleBlockedIntents(db,{bookingId:Number(b.id),event:action==='approve'?'approved':'rescheduled',eventKey:action+':'+randomUUID()});
      await db.query('COMMIT');res.json({success:true,data:{id:b.id,status:nextStatus,counsellor_id:nextCounsellor,starts_at:nextStart}});
    }catch(e){await db.query('ROLLBACK');fail(res,500,'Unable to update booking');}finally{db.release();}
  });
  app.patch('/api/admin/booking/counsellors/:id',admin,async(req,res)=>{
    const allowed=['name','mobile','meeting_link','online','offline','active','working_hours','location_id'];
    const values=Object.entries(req.body||{}).filter(([key])=>allowed.includes(key));
    if(!values.length||Object.keys(req.body||{}).some(key=>!allowed.includes(key)))return fail(res,400,'Invalid counsellor changes');
    if(values.some(([key,val])=>['online','offline','active'].includes(key)&&typeof val!=='boolean'||key==='name'&&(!String(val||'').trim())||key==='working_hours'&&(!val||typeof val!=='object'||Array.isArray(val))||key==='location_id'&&val!==null&&(!Number.isSafeInteger(Number(val))||Number(val)<1)))return fail(res,400,'Invalid counsellor details');
    try {const existing=await pool.query('SELECT meeting_link,online FROM booking_counsellors WHERE id=$1 AND archived_at IS NULL',[req.params.id]);if(!existing.rowCount)return fail(res,404,'Counsellor not found');const next=Object.fromEntries(values);if((next.online===undefined?existing.rows[0].online:next.online)&&!String(next.meeting_link===undefined?existing.rows[0].meeting_link:next.meeting_link||'').trim())return fail(res,400,'Meeting link is required for online bookings');const sql=values.map(([key],i)=>`${key}=$${i+2}`).join(',');const r=await pool.query(`UPDATE booking_counsellors SET ${sql} WHERE id=$1 AND archived_at IS NULL RETURNING *`,[req.params.id,...values.map(([key,value])=>key==='working_hours'?JSON.stringify(value):value)]);if(!r.rowCount)return fail(res,404,'Counsellor not found');res.json({success:true,data:r.rows[0]});}catch(e){fail(res,500,'Unable to update counsellor');}
  });
  app.get('/api/admin/booking/settings',admin,async(req,res)=>res.json({success:true,data:await settings()}));
  app.put('/api/admin/booking/settings',admin,async(req,res)=>{const {duration_minutes,buffer_minutes,advance_hours,booking_days,approval_required,reminder_hours,offline_address,student_address_visible=true,student_address_required=true,student_address_style='detailed',whatsapp_verification_enabled=true,email_notifications_enabled=true,email_recipient_mode='both'}=req.body;if(!Number.isInteger(duration_minutes)||duration_minutes<10||duration_minutes>240||!Number.isInteger(buffer_minutes)||buffer_minutes<0||buffer_minutes>120||!Number.isFinite(advance_hours)||advance_hours<0||!Number.isInteger(booking_days)||booking_days<1||booking_days>365||!Array.isArray(reminder_hours)||reminder_hours.some(x=>!Number.isFinite(x)||x<=0)||typeof approval_required!=='boolean'||typeof offline_address!=='string'||typeof student_address_visible!=='boolean'||typeof student_address_required!=='boolean'||!['detailed','single'].includes(student_address_style)||typeof whatsapp_verification_enabled!=='boolean'||typeof email_notifications_enabled!=='boolean'||!['both','student','parent'].includes(email_recipient_mode))return fail(res,400,'Invalid settings');const r=await pool.query(`UPDATE booking_settings SET settings=settings||$1::jsonb WHERE id=1 RETURNING settings`,[JSON.stringify(req.body)]);res.json({success:true,data:r.rows[0].settings});});
  app.get('/api/admin/booking/locations',admin,async(req,res)=>{
    try {const r=await pool.query('SELECT id,name,address,map_url,is_default,created_at,updated_at FROM booking_locations ORDER BY is_default DESC,name ASC,id ASC');res.json({success:true,data:r.rows});}
    catch{fail(res,500,'Unable to load locations');}
  });
  app.post('/api/admin/booking/locations',admin,async(req,res)=>{
    const {name,address='',map_url='',is_default=false}=req.body||{};
    if(typeof name!=='string'||!name.trim()||name.trim().length>120||typeof address!=='string'||address.length>1000||typeof map_url!=='string'||map_url.length>2000||typeof is_default!=='boolean')return fail(res,400,'Invalid location details');
    const db=await pool.connect();try{await db.query('BEGIN');
      const count=await db.query('SELECT COUNT(*)::int AS total FROM booking_locations');const makeDefault=is_default||count.rows[0].total===0;
      if(makeDefault)await db.query('UPDATE booking_locations SET is_default=FALSE,updated_at=NOW() WHERE is_default=TRUE');
      const r=await db.query('INSERT INTO booking_locations(name,address,map_url,is_default) VALUES($1,$2,$3,$4) RETURNING *',[name.trim(),address.trim(),map_url.trim(),makeDefault]);
      await db.query('COMMIT');res.status(201).json({success:true,data:r.rows[0]});
    }catch(e){await db.query('ROLLBACK').catch(()=>{});fail(res,500,'Unable to save location');}finally{db.release();}
  });
  app.patch('/api/admin/booking/locations/:id',admin,async(req,res)=>{
    if(!/^\d+$/.test(req.params.id))return fail(res,400,'Invalid location ID');
    const {name,address='',map_url='',is_default=false}=req.body||{};
    if(typeof name!=='string'||!name.trim()||name.trim().length>120||typeof address!=='string'||address.length>1000||typeof map_url!=='string'||map_url.length>2000||typeof is_default!=='boolean')return fail(res,400,'Invalid location details');
    const db=await pool.connect();try{await db.query('BEGIN');
      const current=await db.query('SELECT id,is_default FROM booking_locations WHERE id=$1 FOR UPDATE',[req.params.id]);if(!current.rowCount){await db.query('ROLLBACK');return fail(res,404,'Location not found');}
      if(is_default)await db.query('UPDATE booking_locations SET is_default=FALSE,updated_at=NOW() WHERE is_default=TRUE AND id<>$1',[req.params.id]);
      const r=await db.query('UPDATE booking_locations SET name=$2,address=$3,map_url=$4,is_default=$5,updated_at=NOW() WHERE id=$1 RETURNING *',[req.params.id,name.trim(),address.trim(),map_url.trim(),is_default]);
      await db.query('COMMIT');res.json({success:true,data:r.rows[0]});
    }catch(e){await db.query('ROLLBACK').catch(()=>{});fail(res,500,'Unable to update location');}finally{db.release();}
  });
  app.delete('/api/admin/booking/locations/:id',admin,async(req,res)=>{
    if(!/^\d+$/.test(req.params.id))return fail(res,400,'Invalid location ID');
    try{const used=await pool.query('SELECT EXISTS(SELECT 1 FROM booking_counsellors WHERE location_id=$1 AND archived_at IS NULL) AS used',[req.params.id]);if(used.rows[0].used)return fail(res,409,'Location is assigned to a counsellor. Reassign the counsellor before deleting it.');
      const r=await pool.query('DELETE FROM booking_locations WHERE id=$1 AND is_default=FALSE RETURNING id',[req.params.id]);if(!r.rowCount){const exists=await pool.query('SELECT is_default FROM booking_locations WHERE id=$1',[req.params.id]);if(!exists.rowCount)return fail(res,404,'Location not found');return fail(res,409,'Default location cannot be deleted. Set another location as default first.');}res.json({success:true});
    }catch(e){if(!res.headersSent)fail(res,500,'Unable to delete location');}
  });
  app.get('/api/admin/booking/closed-dates',admin,async(req,res)=>{
    try {const r=await pool.query(`SELECT h.id,to_char(h.start_date,'YYYY-MM-DD') AS start_date,to_char(h.end_date,'YYYY-MM-DD') AS end_date,h.title,h.counsellor_id,c.name AS counsellor_name FROM booking_closed_dates h LEFT JOIN booking_counsellors c ON c.id=h.counsellor_id ORDER BY h.start_date DESC,h.id DESC LIMIT 500`);res.json({success:true,data:r.rows});}
    catch{fail(res,500,'Unable to load closed dates');}
  });
  app.post('/api/admin/booking/closed-dates',admin,async(req,res)=>{
    const {start_date,end_date,title,counsellor_id=null}=req.body||{};
    const validDate=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
    if(!validDate(start_date)||!validDate(end_date)||end_date<start_date||typeof title!=='string'||!title.trim()||title.trim().length>120||counsellor_id!==null&&(!Number.isSafeInteger(Number(counsellor_id))||Number(counsellor_id)<1))return fail(res,400,'Invalid closed date details');
    try {const db=await pool.connect();try {await db.query('BEGIN');
      const existing=await db.query(`SELECT COUNT(*)::int AS total FROM student_bookings WHERE status=ANY($3::text[]) AND (starts_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date AND ($4::bigint IS NULL OR counsellor_id=$4)`,[start_date,end_date,active,counsellor_id]);
      if(existing.rows[0].total){await db.query('ROLLBACK');return fail(res,409,`${existing.rows[0].total} existing active booking(s) in this date range. Reschedule or cancel them before closing these dates.`);}
      const r=await db.query('INSERT INTO booking_closed_dates(start_date,end_date,title,counsellor_id) VALUES($1,$2,$3,$4) RETURNING id',[start_date,end_date,title.trim(),counsellor_id]);await db.query('COMMIT');res.status(201).json({success:true,data:r.rows[0]});
    }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}}
    catch{fail(res,500,'Unable to save closed date');}
  });
  app.patch('/api/admin/booking/closed-dates/:id',admin,async(req,res)=>{
    const {start_date,end_date,title,counsellor_id=null}=req.body||{};
    const validDate=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
    if(!/^\d+$/.test(req.params.id)||!validDate(start_date)||!validDate(end_date)||end_date<start_date||typeof title!=='string'||!title.trim()||title.trim().length>120||counsellor_id!==null&&(!Number.isSafeInteger(Number(counsellor_id))||Number(counsellor_id)<1))return fail(res,400,'Invalid closed date details');
    const db=await pool.connect();
    try{
      await db.query('BEGIN');
      const current=await db.query('SELECT id FROM booking_closed_dates WHERE id=$1 FOR UPDATE',[req.params.id]);
      if(!current.rowCount){await db.query('ROLLBACK');return fail(res,404,'Closed date not found');}
      const existing=await db.query(`SELECT COUNT(*)::int AS total FROM student_bookings WHERE status=ANY($3::text[]) AND (starts_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date AND ($4::bigint IS NULL OR counsellor_id=$4)`,[start_date,end_date,active,counsellor_id]);
      if(existing.rows[0].total){await db.query('ROLLBACK');return fail(res,409,`${existing.rows[0].total} existing active booking(s) in this date range. Reschedule or cancel them before changing these dates.`);}
      const r=await db.query('UPDATE booking_closed_dates SET start_date=$2,end_date=$3,title=$4,counsellor_id=$5 WHERE id=$1 RETURNING id',[req.params.id,start_date,end_date,title.trim(),counsellor_id]);
      await db.query('COMMIT');res.json({success:true,data:r.rows[0]});
    }catch(e){await db.query('ROLLBACK').catch(()=>{});fail(res,500,'Unable to update closed date');}finally{db.release();}
  });
  app.delete('/api/admin/booking/closed-dates/:id',admin,async(req,res)=>{
    if(!/^\d+$/.test(req.params.id))return fail(res,400,'Invalid closed date ID');
    try{const r=await pool.query('DELETE FROM booking_closed_dates WHERE id=$1 RETURNING id',[req.params.id]);if(!r.rowCount)return fail(res,404,'Closed date not found');res.json({success:true});}catch{fail(res,500,'Unable to remove closed date');}
  });
  app.delete('/api/admin/booking/counsellors/:id',admin,async(req,res)=>{
    if(!/^\d+$/.test(req.params.id))return fail(res,400,'Invalid counsellor ID');
    try {const r=await pool.query('UPDATE booking_counsellors SET active=FALSE,online=FALSE,offline=FALSE,archived_at=COALESCE(archived_at,NOW()) WHERE id=$1 RETURNING id',[req.params.id]);if(!r.rowCount)return fail(res,404,'Counsellor not found');res.json({success:true,data:{id:r.rows[0].id,archived:true,message:'Counsellor archived to preserve booking history'}});}
    catch{fail(res,500,'Unable to archive counsellor');}
  });
  app.get('/api/admin/booking/counsellors',admin,async(req,res)=>{const r=await pool.query('SELECT * FROM booking_counsellors WHERE archived_at IS NULL AND (active OR online OR offline) ORDER BY id');res.json({success:true,data:r.rows});});
  app.post('/api/admin/booking/counsellors',admin,async(req,res)=>{const {name,mobile='',meeting_link='',online=false,offline=true,working_hours,location_id=null}=req.body;if(online&&!String(meeting_link||'').trim())return fail(res,400,'Meeting link is required for online bookings');if(!name?.trim()||typeof working_hours!=='object'||!working_hours||Array.isArray(working_hours)||location_id!==null&&(!Number.isSafeInteger(Number(location_id))||Number(location_id)<1))return fail(res,400,'Invalid counsellor');const r=await pool.query('INSERT INTO booking_counsellors(name,mobile,meeting_link,online,offline,working_hours,location_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[name.trim(),mobile,meeting_link,online,offline,JSON.stringify(working_hours),location_id]);res.status(201).json({success:true,data:r.rows[0]});});
  app.post('/api/admin/booking/:id/link',admin,async(req,res)=>{const leadId=Number(req.body.lead_id);if(!Number.isSafeInteger(leadId))return fail(res,400,'Invalid lead');const lead=await pool.query('SELECT id,mobile FROM leads WHERE id=$1',[leadId]);if(!lead.rowCount)return fail(res,404,'Lead not found');const booking=await pool.query('SELECT student_mobile FROM student_bookings WHERE id=$1',[req.params.id]);if(!booking.rowCount)return fail(res,404,'Booking not found');if(!phone(booking.rows[0].student_mobile)||phone(booking.rows[0].student_mobile)!==phone(lead.rows[0].mobile))return fail(res,409,'Student mobile does not match lead mobile; manual identity verification workflow is required');const r=await pool.query(`UPDATE student_bookings SET lead_id=$2,linking_status='linked',updated_at=NOW() WHERE id=$1 RETURNING id`,[req.params.id,leadId]);if(!r.rowCount)return fail(res,404,'Booking not found');await log(pool,r.rows[0].id,'admin','linked',{lead_id:leadId});res.json({success:true});});
}