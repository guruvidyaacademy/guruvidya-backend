// Build 38: read-only, fail-closed dispatch readiness audit. NEVER sends or unblocks.
import {blockedIntentDecision} from './booking-link-outbox-reconcile.js';
import {bookingLinkDeliveryPreflight} from './booking-link-delivery.js';

export function validateDispatchAuditLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_audit_limit');
  return limit;
}

// Deliberately returns aggregate counts only. This snapshot is NOT authorization
// to dispatch: eligibility must be rechecked under booking lock at send time.
export async function auditBlockedLinkDispatch(pool,{limit=25,now=new Date(),config={}}={}) {
  validateDispatchAuditLimit(limit);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('invalid_audit_time');
  const preflight=bookingLinkDeliveryPreflight(config);
  const found=await pool.query("SELECT id, booking_id, kind, event, mobile_snapshot, slot_snapshot, status FROM booking_private_link_outbox WHERE status='blocked' ORDER BY id LIMIT $1",[limit]);
  // Fail closed on malformed DB adapter responses rather than publishing an incomplete audit.
  if (!Array.isArray(found?.rows) || found.rows.length > limit || found.rows.some(intent =>
    !intent || !Number.isSafeInteger(intent.id) || intent.id < 1 ||
    !Number.isSafeInteger(intent.booking_id) || intent.booking_id < 1 ||
    intent.status !== 'blocked'
  )) throw new Error('invalid_dispatch_audit_result');
  // The inventory query promises a strictly increasing id order. Duplicate or
  // out-of-order rows can distort sampled counts and pagination boundaries.
  for (let i=1;i<found.rows.length;i++) {
    if (found.rows[i].id <= found.rows[i-1].id) throw new Error('invalid_dispatch_audit_result');
  }
  const counts={eligibleButBlocked:0,invalidIntent:0,missingBooking:0,missingConsent:0};
  for(const intent of found.rows) {
    const bookingResult=await pool.query('SELECT * FROM student_bookings WHERE id=$1',[intent.booking_id]);
    if (!Array.isArray(bookingResult?.rows) || bookingResult.rows.length > 1) throw new Error('invalid_dispatch_audit_result');
    const booking=bookingResult.rows[0];
    if (booking && (!Number.isSafeInteger(booking.id) || booking.id !== intent.booking_id)) throw new Error('invalid_dispatch_audit_result');
    if(!booking){counts.missingBooking++;continue;}
    const consentResult=await pool.query('SELECT * FROM booking_recipient_consents WHERE booking_id=$1 AND kind=$2',[intent.booking_id,intent.kind]);
    if (!Array.isArray(consentResult?.rows) || consentResult.rows.length > 1) throw new Error('invalid_dispatch_audit_result');
    const consent=consentResult.rows[0];
    if (consent && (consent.booking_id != null && consent.booking_id !== intent.booking_id || consent.kind !== intent.kind)) throw new Error('invalid_dispatch_audit_result');
    if(!consent){counts.missingConsent++;continue;}
    const decision=blockedIntentDecision({booking,consent,intent,now});
    counts[decision.valid?'eligibleButBlocked':'invalidIntent']++;
  }
  return {sampled:found.rows.length,limitReached:found.rows.length===limit,counts,
    providerPreflightReady:preflight.ready,providerBlockers:preflight.reasons,
    dispatchEnabled:false,requiresFreshLockedEligibilityCheck:true};
}
