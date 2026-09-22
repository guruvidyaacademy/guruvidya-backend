// Build 34: fail-closed reconciliation of blocked notification intents.
// No network requests, token creation, or transition to ready/sending occurs here.
import { bookingLinkLifecycleDecision } from './booking-link-lifecycle.js';
import { consentMatchesBooking } from './booking-consent.js';

export function blockedIntentDecision({booking,consent,intent,now=new Date()}={}) {
  if (!intent || intent.status !== 'blocked') return {valid:false,reason:'not_blocked'};
  if (!booking || Number(booking.id)!==Number(intent.booking_id)) return {valid:false,reason:'booking_missing'};
  if (!consentMatchesBooking(booking,consent,intent.kind)) return {valid:false,reason:'consent_or_recipient_changed'};
  if (consent.mobile!==intent.mobile_snapshot) return {valid:false,reason:'recipient_changed'};
  if (new Date(booking.starts_at).getTime()!==new Date(intent.slot_snapshot).getTime()) return {valid:false,reason:'slot_changed'};
  const result=bookingLinkLifecycleDecision({booking,event:intent.event,recipient:{kind:intent.kind,mobile:consent.mobile,verified:true,optedIn:true},now});
  return result.eligible?{valid:true,reason:'still_blocked'}:{valid:false,reason:result.reasons[0]};
}

// Lock booking first, then intent/consent to match booking mutation lock ordering.
// Idempotent: only blocked rows may be cancelled. Never silently release an intent.
export async function reconcileBlockedBookingIntents(pool,bookingId,{now=new Date()}={}) {
  if(!Number.isSafeInteger(bookingId)||bookingId<1) throw new Error('invalid_booking_id');
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const br=await db.query('SELECT * FROM student_bookings WHERE id=$1 FOR UPDATE',[bookingId]);
    const booking=br.rows[0];
    const ir=await db.query("SELECT * FROM booking_private_link_outbox WHERE booking_id=$1 AND status='blocked' ORDER BY id FOR UPDATE",[bookingId]);
    const cr=await db.query("SELECT * FROM booking_recipient_consents WHERE booking_id=$1 ORDER BY kind FOR UPDATE",[bookingId]);
    const consents=new Map(cr.rows.map(row=>[row.kind,row]));
    let cancelled=0,retained=0;
    for(const intent of ir.rows){
      const decision=blockedIntentDecision({booking,consent:consents.get(intent.kind),intent,now});
      if(decision.valid){retained++;continue;}
      const changed=await db.query("UPDATE booking_private_link_outbox SET status='cancelled' WHERE id=$1 AND status='blocked' RETURNING id",[intent.id]);
      cancelled+=changed.rows.length;
    }
    await db.query('COMMIT');
    return {cancelled,retained};
  } catch(error){try{await db.query('ROLLBACK');}catch{}throw error;}
  finally{db.release();}
}
