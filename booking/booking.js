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
    INSERT INTO booking_settings(id,settings) VALUES(1,'{"duration_minutes":30,"buffer_minutes":0,"advance_hours":2,"booking_days":30,"approval_required":false,"reminder_hours":[4,2,1],"offline_address":"","timezone":"Asia/Kolkata"}') ON CONFLICT(id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS student_bookings (
      id BIGSERIAL PRIMARY KEY, booking_ref TEXT UNIQUE NOT NULL, token_hash TEXT NOT NULL,
      lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL, linking_status TEXT NOT NULL DEFAULT 'pending',
      student_name TEXT NOT NULL, student_mobile TEXT, parent_name TEXT, parent_mobile TEXT,
      recipient TEXT NOT NULL DEFAULT 'both', course TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('online','offline')),
      counsellor_id BIGINT REFERENCES booking_counsellors(id), starts_at TIMESTAMPTZ NOT NULL, ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested', customer_response TEXT NOT NULL DEFAULT 'awaiting',
      response_at TIMESTAMPTZ, admin_alert_sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS admin_alert_ack_at TIMESTAMPTZ;
    ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS admin_alert_ack_note TEXT;
    CREATE INDEX IF NOT EXISTS student_bookings_lead_idx ON student_bookings(lead_id,status);
    CREATE INDEX IF NOT EXISTS student_bookings_slot_idx ON student_bookings(counsellor_id,starts_at,ends_at);
    CREATE TABLE IF NOT EXISTS booking_events(id BIGSERIAL PRIMARY KEY, booking_id BIGINT REFERENCES student_bookings(id), actor TEXT NOT NULL, action TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS booking_delivery_logs(id BIGSERIAL PRIMARY KEY, booking_id BIGINT REFERENCES student_bookings(id), event TEXT NOT NULL, recipient TEXT NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(booking_id,event,recipient,channel));`);
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
  await pool.query('ALTER TABLE student_bookings ADD COLUMN IF NOT EXISTS trashed_at TIMESTAMPTZ');
}

export async function hasBookingSuppression(pool, leadId) {
  if (!leadId) return false;
  const r = await pool.query(`SELECT EXISTS(SELECT 1 FROM student_bookings WHERE lead_id=$1 AND linking_status='linked') AS blocked`,[leadId]);
  return r.rows[0].blocked;
}

export function installBookingRoutes(app,pool) {
  // Booking-only, server-verified short-lived bearer sessions. Never ship credentials in React.
  const sessions = new Map();
  const attempts = new Map();
  const equal = (a,b) => { const x=createHash('sha256').update(String(a)).digest(); const y=createHash('sha256').update(String(b)).digest(); return timingSafeEqual(x,y); };
  const sessionFor = req => {const raw=(req.get('authorization')||'').match(/^Bearer ([a-f0-9]{64})$/i)?.[1];if(!raw)return false;const key=hash(raw), expiry=sessions.get(key);if(!expiry)return false;if(expiry<Date.now()){sessions.delete(key);return false;}return true;};
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
  const slots = async (db,date,mode,counsellorId,{excludeBookingId=null}={}) => {
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
          if(!busy.rowCount) out.push({counsellor_id:person.id,counsellor_name:person.name,starts_at:new Date(start).toISOString(),ends_at:new Date(start+duration*60000).toISOString()});
        }
      }
    }
    return out;
  };
  app.get('/booking',async(req,res)=>{try{res.set({'Referrer-Policy':'no-referrer','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});res.type('html').send(await readFile(new URL('./booking-page.html',import.meta.url),'utf8'));}catch(e){fail(res,500,'Booking page unavailable');}});
  app.get('/api/public/booking/closed-dates',async(req,res)=>{
    try {const date=String(req.query.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date+'T00:00:00Z')))return fail(res,400,'Invalid date');
      const r=await pool.query(`SELECT title,counsellor_id FROM booking_closed_dates WHERE start_date<=$1::date AND end_date>=$1::date ORDER BY id`,[date]);
      res.set('Cache-Control','no-store').json({success:true,data:r.rows});
    }catch{fail(res,500,'Closed dates unavailable');}
  });
  // Public mode availability reflects active, non-archived counsellors only.
  app.get('/api/public/booking/modes',async(req,res)=>{
    try {
      const r=await pool.query(`SELECT
        EXISTS(SELECT 1 FROM booking_counsellors WHERE active AND archived_at IS NULL AND online AND NULLIF(BTRIM(COALESCE(meeting_link,'')),'') IS NOT NULL) AS online,
        EXISTS(SELECT 1 FROM booking_counsellors WHERE active AND archived_at IS NULL AND offline) AS offline`);
      res.set('Cache-Control','no-store').json({success:true,data:r.rows[0]});
    }catch(e){fail(res,503,'Booking modes unavailable');}
  });
  app.get('/api/public/booking/slots',async(req,res)=>{try{res.json({success:true,data:await slots(pool,req.query.date,req.query.mode,req.query.counsellor_id||null)});}catch(e){fail(res,400,e.message);}});
  app.post('/api/public/booking',async(req,res)=>{
    const {student_name,student_mobile,parent_name,parent_mobile,course,mode,starts_at,counsellor_id,recipient='both'}=req.body;
    const sm=phone(student_mobile),pm=phone(parent_mobile);
    if(!student_name?.trim()||!course?.trim()||!['online','offline'].includes(mode)||!validTime(starts_at)||!Number.isSafeInteger(Number(counsellor_id))||!['student','parent','both'].includes(recipient)||(!/^\d{10}$/.test(sm)&&!/^\d{10}$/.test(pm)))return fail(res,400,'Invalid booking details');
    // Never accept a notification preference that points to a missing or malformed recipient.
    // A valid parent-only booking may still await manual student-lead linking.
    if ((student_mobile && !/^\d{10}$/.test(sm)) || (parent_mobile && !/^\d{10}$/.test(pm)) ||
        (recipient==='student' && !/^\d{10}$/.test(sm)) ||
        (recipient==='parent' && !/^\d{10}$/.test(pm)) ||
        (recipient==='both' && (!/^\d{10}$/.test(sm) || !/^\d{10}$/.test(pm))))
      return fail(res,400,'Provide a valid 10-digit mobile for every selected notification recipient');
    const db=await pool.connect();
    try{
      await db.query('BEGIN');
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
      const result=await db.query(`INSERT INTO student_bookings(booking_ref,token_hash,lead_id,linking_status,student_name,student_mobile,parent_name,parent_mobile,recipient,course,mode,counsellor_id,starts_at,ends_at,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id,booking_ref,starts_at,ends_at,status,linking_status`,[ref,hash(token),leadId,leadId?'linked':'pending',student_name.trim(),sm,parent_name||'',pm,recipient,course.trim(),mode,Number(counsellor_id),slot.starts_at,slot.ends_at,approvalRequired?'requested':'confirmed']);
      if(!approvalRequired) await db.query("UPDATE student_bookings SET customer_response='confirmed',response_at=NOW() WHERE id=$1",[result.rows[0].id]);
      await log(db,result.rows[0].id,'customer','booked',{lead_id:leadId,mode});
      await enqueueLifecycleBlockedIntents(db,{bookingId:Number(result.rows[0].id),event:'created',eventKey:'created:'+randomUUID()});
      await db.query('COMMIT');
      res.status(201).json({success:true,data:{...result.rows[0],manage_token:token}});
    }catch(e){await db.query('ROLLBACK');fail(res,500,'Unable to create booking');}finally{db.release();}
  });
  app.get('/api/public/booking/manage/:ref',async(req,res)=>{
    // Legacy query-token URLs can leak via HTTP access logs and browser history.
    // Only enable temporarily for a controlled migration of old links.
    if(process.env.BOOKING_ALLOW_LEGACY_QUERY_TOKEN !== 'true') return fail(res,410,'Legacy booking link retired; request a new private link');
    if(!/^[a-f0-9]{64}$/i.test(String(req.query.token||''))) return fail(res,404,'Booking not found');
    const r=await pool.query(`SELECT b.booking_ref,b.student_name,b.course,b.mode,b.starts_at,b.ends_at,b.status,b.customer_response,c.name AS counsellor_name,c.mobile AS counsellor_mobile,c.meeting_link FROM student_bookings b LEFT JOIN booking_counsellors c ON c.id=b.counsellor_id WHERE b.booking_ref=$1 AND b.token_hash=$2`,[req.params.ref,hash(String(req.query.token||''))]);
    if(!r.rowCount)return fail(res,404,'Booking not found');res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}).json({success:true,data:r.rows[0]});
  });
  // Build 25: read management details via POST body; URL fragments never reach the server.
  // The legacy GET remains for compatibility but must not be used for newly issued links.
  app.post('/api/public/booking/manage/:ref/view',async(req,res)=>{
    const token=String(req.body?.token||'');
    if(!/^[a-f0-9]{64}$/i.test(token))return fail(res,404,'Booking not found');
    try {
      const r=await pool.query(`SELECT b.booking_ref,b.student_name,b.course,b.mode,b.starts_at,b.ends_at,b.status,b.customer_response,c.name AS counsellor_name,c.mobile AS counsellor_mobile,c.meeting_link FROM student_bookings b LEFT JOIN booking_counsellors c ON c.id=b.counsellor_id WHERE b.booking_ref=$1 AND b.token_hash=$2`,[req.params.ref,hash(token)]);
      if(!r.rowCount)return fail(res,404,'Booking not found');
      res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Pragma':'no-cache'}).json({success:true,data:r.rows[0]});
    }catch(e){fail(res,500,'Unable to load booking');}
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
      }else if(req.body.action==='cancel')await db.query(`UPDATE student_bookings SET status='cancelled',customer_response='cancelled',response_at=NOW(),updated_at=NOW() WHERE id=$1`,[b.id]);
      else await db.query(`UPDATE student_bookings SET customer_response='confirmed',response_at=NOW(),status='confirmed',updated_at=NOW() WHERE id=$1`,[b.id]);
      await log(db,b.id,'customer',req.body.action,{old_starts_at:b.starts_at,new_starts_at:req.body.starts_at||null});
      if(req.body.action!=='cancel') await enqueueLifecycleBlockedIntents(db,{bookingId:Number(b.id),event:req.body.action==='confirm'?'confirmed':'rescheduled',eventKey:req.body.action+':'+randomUUID()});
      await db.query('COMMIT');res.json({success:true});
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
  app.get('/api/admin/booking',admin,async(req,res)=>{const r=await pool.query(`SELECT b.id,b.booking_ref,b.lead_id,b.linking_status,b.student_name,b.student_mobile,b.parent_name,b.parent_mobile,b.recipient,b.course,b.mode,b.counsellor_id,b.starts_at,b.ends_at,b.status,b.customer_response,b.response_at,b.admin_alert_sent_at,b.created_at,b.updated_at,c.name AS counsellor_name,c.meeting_link FROM student_bookings b LEFT JOIN booking_counsellors c ON c.id=b.counsellor_id WHERE b.trashed_at IS NULL ORDER BY b.starts_at DESC LIMIT 500`);res.json({success:true,data:r.rows});});
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
    const allowed=['name','mobile','meeting_link','online','offline','active','working_hours'];
    const values=Object.entries(req.body||{}).filter(([key])=>allowed.includes(key));
    if(!values.length||Object.keys(req.body||{}).some(key=>!allowed.includes(key)))return fail(res,400,'Invalid counsellor changes');
    if(values.some(([key,val])=>['online','offline','active'].includes(key)&&typeof val!=='boolean'||key==='name'&&(!String(val||'').trim())||key==='working_hours'&&(!val||typeof val!=='object'||Array.isArray(val))))return fail(res,400,'Invalid counsellor details');
    try {const existing=await pool.query('SELECT meeting_link,online FROM booking_counsellors WHERE id=$1 AND archived_at IS NULL',[req.params.id]);if(!existing.rowCount)return fail(res,404,'Counsellor not found');const next=Object.fromEntries(values);if((next.online===undefined?existing.rows[0].online:next.online)&&!String(next.meeting_link===undefined?existing.rows[0].meeting_link:next.meeting_link||'').trim())return fail(res,400,'Meeting link is required for online bookings');const sql=values.map(([key],i)=>`${key}=$${i+2}`).join(',');const r=await pool.query(`UPDATE booking_counsellors SET ${sql} WHERE id=$1 AND archived_at IS NULL RETURNING *`,[req.params.id,...values.map(([key,value])=>key==='working_hours'?JSON.stringify(value):value)]);if(!r.rowCount)return fail(res,404,'Counsellor not found');res.json({success:true,data:r.rows[0]});}catch(e){fail(res,500,'Unable to update counsellor');}
  });
  app.get('/api/admin/booking/settings',admin,async(req,res)=>res.json({success:true,data:await settings()}));
  app.put('/api/admin/booking/settings',admin,async(req,res)=>{const {duration_minutes,buffer_minutes,advance_hours,booking_days,approval_required,reminder_hours,offline_address}=req.body;if(!Number.isInteger(duration_minutes)||duration_minutes<10||duration_minutes>240||!Number.isInteger(buffer_minutes)||buffer_minutes<0||buffer_minutes>120||!Number.isFinite(advance_hours)||advance_hours<0||!Number.isInteger(booking_days)||booking_days<1||booking_days>365||!Array.isArray(reminder_hours)||reminder_hours.some(x=>!Number.isFinite(x)||x<=0)||typeof approval_required!=='boolean'||typeof offline_address!=='string')return fail(res,400,'Invalid settings');const r=await pool.query(`UPDATE booking_settings SET settings=settings||$1::jsonb WHERE id=1 RETURNING settings`,[JSON.stringify(req.body)]);res.json({success:true,data:r.rows[0].settings});});
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
  app.post('/api/admin/booking/counsellors',admin,async(req,res)=>{const {name,mobile='',meeting_link='',online=false,offline=true,working_hours}=req.body;if(online&&!String(meeting_link||'').trim())return fail(res,400,'Meeting link is required for online bookings');if(!name?.trim()||typeof working_hours!=='object'||!working_hours||Array.isArray(working_hours))return fail(res,400,'Invalid counsellor');const r=await pool.query('INSERT INTO booking_counsellors(name,mobile,meeting_link,online,offline,working_hours) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[name.trim(),mobile,meeting_link,online,offline,JSON.stringify(working_hours)]);res.status(201).json({success:true,data:r.rows[0]});});
  app.post('/api/admin/booking/:id/link',admin,async(req,res)=>{const leadId=Number(req.body.lead_id);if(!Number.isSafeInteger(leadId))return fail(res,400,'Invalid lead');const lead=await pool.query('SELECT id,mobile FROM leads WHERE id=$1',[leadId]);if(!lead.rowCount)return fail(res,404,'Lead not found');const booking=await pool.query('SELECT student_mobile FROM student_bookings WHERE id=$1',[req.params.id]);if(!booking.rowCount)return fail(res,404,'Booking not found');if(!phone(booking.rows[0].student_mobile)||phone(booking.rows[0].student_mobile)!==phone(lead.rows[0].mobile))return fail(res,409,'Student mobile does not match lead mobile; manual identity verification workflow is required');const r=await pool.query(`UPDATE student_bookings SET lead_id=$2,linking_status='linked',updated_at=NOW() WHERE id=$1 RETURNING id`,[req.params.id,leadId]);if(!r.rowCount)return fail(res,404,'Booking not found');await log(pool,r.rows[0].id,'admin','linked',{lead_id:leadId});res.json({success:true});});
}
