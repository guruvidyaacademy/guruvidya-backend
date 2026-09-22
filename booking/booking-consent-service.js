// Build 53: authenticated consent service adapter. No HTTP route or WhatsApp dispatch.
// Integrator supplies trusted authentication, booking lookup, and one-time evidence verifier.
import {submitVerifiedRecipientConsent,withdrawRecipientConsent,recipientConsentStatus,validateConsentSubmission} from './booking-consent-workflow.js';
const validActor = actor => actor && actor.authenticated === true && typeof actor.id === 'string' && actor.id.length > 0;
const validKind = kind => kind === 'student' || kind === 'parent';
function assertBooking(booking, bookingId, kind) {
  if (!booking || !Number.isSafeInteger(Number(bookingId)) || Number(bookingId) < 1 ||
      Number(booking.id) !== Number(bookingId) || !validKind(kind) ||
      !['both',kind].includes(booking.recipient)) throw Error('booking_recipient_mismatch');
}
export async function collectBookingConsent({db,actor,booking,input,verifyEvidence}={}) {
  if (!validActor(actor)) throw Error('authentication_required');
  if (!input || typeof input !== 'object') throw Error('invalid_submission');
  assertBooking(booking,input.bookingId,input.kind);
  // Validate all consent fields and recipient ownership BEFORE consuming one-time evidence.
  // Otherwise an invalid submission could burn a legitimate proof without recording consent.
  const validated = validateConsentSubmission(input);
  if (booking?.[validated.kind+'_mobile'] !== validated.mobile) throw Error('booking_recipient_mismatch');
  if (typeof verifyEvidence !== 'function') throw Error('evidence_verifier_required');
  // Verification must bind the authenticated actor, booking, recipient, mobile and evidence.
  // Verifier is responsible for one-time consumption and proof of recipient ownership.
  const accepted = await verifyEvidence({actor,bookingId:Number(input.bookingId),kind:input.kind,
    mobile:input.mobile,channel:input.channel,evidenceRef:input.evidenceRef});
  if (accepted !== true) throw Error('evidence_verification_failed');
  return submitVerifiedRecipientConsent(db,booking,input);
}
export async function revokeBookingConsent({db,actor,booking,bookingId,kind,authorizeRevocation}={}) {
  if (!validActor(actor)) throw Error('authentication_required');
  assertBooking(booking,bookingId,kind);
  if (typeof authorizeRevocation !== 'function' ||
      await authorizeRevocation({actor,bookingId:Number(bookingId),kind}) !== true)
    throw Error('revocation_not_authorized');
  return withdrawRecipientConsent(db,booking,{bookingId,kind});
}
export function getBookingConsentEligibility({actor,booking,consents}={}) {
  if (!validActor(actor)) throw Error('authentication_required');
  return recipientConsentStatus(booking,consents);
}
