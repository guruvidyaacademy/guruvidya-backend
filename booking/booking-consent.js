// Build 31: explicit, per-booking/per-recipient consent records. No inferred consent.
// This is a storage foundation only; no public consent-collection or sending endpoint.
const MOBILE=/^[6-9][0-9]{9}$/;
export function validateConsentRecord({bookingId,kind,mobile,verified,optedIn,source}={}) {
  if (!Number.isSafeInteger(Number(bookingId)) || Number(bookingId)<1) throw new Error('invalid_booking');
  if (!['student','parent'].includes(kind)) throw new Error('invalid_recipient');
  if (!MOBILE.test(String(mobile||''))) throw new Error('invalid_mobile');
  if (verified!==true || optedIn!==true) throw new Error('verification_and_explicit_opt_in_required');
  if (!['verified_customer_action','verified_staff_record'].includes(source)) throw new Error('invalid_consent_source');
  return {bookingId:Number(bookingId),kind,mobile,source};
}
export function consentMatchesBooking(booking,consent,kind) {
  return !!(booking && consent && ['student','parent'].includes(kind) && consent.kind===kind &&
    consent.mobile===booking[kind+'_mobile'] && consent.verified===true &&
    consent.opted_in===true && consent.revoked_at==null &&
    ['both',kind].includes(booking.recipient));
}
export async function recordVerifiedConsent(db,input) {
  const v=validateConsentRecord(input);
  // Call only after an independently verified customer action or documented staff verification.
  const r=await db.query(`INSERT INTO booking_recipient_consents
    (booking_id,kind,mobile,verified,opted_in,source,verified_at,consented_at,revoked_at)
    VALUES($1,$2,$3,TRUE,TRUE,$4,NOW(),NOW(),NULL)
    ON CONFLICT(booking_id,kind) DO UPDATE SET mobile=EXCLUDED.mobile,
      verified=TRUE,opted_in=TRUE,source=EXCLUDED.source,verified_at=NOW(),consented_at=NOW(),revoked_at=NULL
    RETURNING booking_id,kind,verified,opted_in,verified_at,consented_at`,
    [v.bookingId,v.kind,v.mobile,v.source]);
  return r.rows[0];
}
export async function revokeConsent(db,{bookingId,kind}) {
  if(!Number.isSafeInteger(Number(bookingId)) || Number(bookingId)<1 || !['student','parent'].includes(kind)) throw new Error('invalid_revoke');
  await db.query(`UPDATE booking_recipient_consents SET opted_in=FALSE,revoked_at=NOW()
    WHERE booking_id=$1 AND kind=$2`,[Number(bookingId),kind]);
}
