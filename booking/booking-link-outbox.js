// Build 32: transactional, fail-closed booking notification intent recording.
// This module NEVER dispatches messages or changes an intent to 'ready'.
import { bookingLinkLifecycleDecision } from './booking-link-lifecycle.js';
import { consentMatchesBooking } from './booking-consent.js';

const EVENTS=new Set(['created','approved','confirmed','rescheduled']);
const KINDS=new Set(['student','parent']);
export function validateOutboxIntent({bookingId,kind,event,eventKey}={}) {
  if(!Number.isSafeInteger(bookingId)||bookingId<1) throw new Error('invalid_booking_id');
  if(!KINDS.has(kind)||!EVENTS.has(event)) throw new Error('invalid_notification');
  if(typeof eventKey!=='string'||! /^[a-zA-Z0-9:_-]{1,120}$/.test(eventKey)) throw new Error('invalid_event_key');
  return {bookingId,kind,event,eventKey};
}
export async function enqueueBlockedLinkIntent(pool,input,{now=new Date()}={}) {
  const {bookingId,kind,event,eventKey}=validateOutboxIntent(input);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize with booking mutations that acquire this same booking row lock.
    const br=await client.query('SELECT * FROM student_bookings WHERE id=$1 FOR UPDATE',[bookingId]);
    const booking=br.rows[0];
    if(!booking) { await client.query('ROLLBACK'); return {queued:false,reason:'booking_not_found'}; }
    const cr=await client.query('SELECT * FROM booking_recipient_consents WHERE booking_id=$1 AND kind=$2 FOR UPDATE',[bookingId,kind]);
    const consent=cr.rows[0];
    if(!consentMatchesBooking(booking,consent,kind)) {await client.query('ROLLBACK');return {queued:false,reason:'consent_not_valid'};}
    const decision=bookingLinkLifecycleDecision({booking,event,recipient:{kind,mobile:consent.mobile,verified:true,optedIn:true},now});
    if(!decision.eligible) {await client.query('ROLLBACK');return {queued:false,reason:decision.reasons[0]};}
    const inserted=await client.query(`INSERT INTO booking_private_link_outbox
      (booking_id,kind,event,event_key,mobile_snapshot,slot_snapshot,status)
      VALUES($1,$2,$3,$4,$5,$6,'blocked') ON CONFLICT(booking_id,kind,event_key) DO NOTHING RETURNING id`,
      [bookingId,kind,event,eventKey,consent.mobile,booking.starts_at]);
    await client.query('COMMIT');
    return {queued:inserted.rows.length===1,reason:inserted.rows.length?'blocked_pending_verified_delivery':'duplicate'};
  } catch(err) {try{await client.query('ROLLBACK');}catch{} throw err;}
  finally {client.release();}
}

// Build 33: call INSIDE the booking mutation transaction, after updating the booking.
// Only records BLOCKED intents. Never issues or sends a private management link.
export async function enqueueLifecycleBlockedIntents(db,{bookingId,event,eventKey,now=new Date()}) {
  validateOutboxIntent({bookingId,kind:'student',event,eventKey});
  const result=await db.query('SELECT * FROM student_bookings WHERE id=$1 FOR UPDATE',[bookingId]);
  if(!result.rows.length) throw new Error('booking_not_found');
  const booking=result.rows[0];
  const consentRows=await db.query(`SELECT * FROM booking_recipient_consents
    WHERE booking_id=$1 AND kind IN ('student','parent') ORDER BY kind FOR UPDATE`,[bookingId]);
  const consents=new Map(consentRows.rows.map(c=>[c.kind,c]));
  let queued=0;
  for(const kind of ['student','parent']) {
    const consent=consents.get(kind);
    if(!consentMatchesBooking(booking,consent,kind)) continue;
    const decision=bookingLinkLifecycleDecision({booking,event,recipient:{kind,mobile:consent.mobile,verified:true,optedIn:true},now});
    if(!decision.eligible) continue;
    const inserted=await db.query(`INSERT INTO booking_private_link_outbox
      (booking_id,kind,event,event_key,mobile_snapshot,slot_snapshot,status)
      VALUES($1,$2,$3,$4,$5,$6,'blocked')
      ON CONFLICT(booking_id,kind,event_key) DO NOTHING RETURNING id`,
      [bookingId,kind,event,eventKey,consent.mobile,booking.starts_at]);
    queued+=inserted.rows.length;
  }
  return {queued,status:'blocked'};
}
