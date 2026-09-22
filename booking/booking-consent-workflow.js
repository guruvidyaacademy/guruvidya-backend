// Build 44: consent collection workflow primitives. This module never sends WhatsApp messages.
// Caller must authenticate staff/customer and independently verify recipient ownership.
import {validateConsentRecord, recordVerifiedConsent, revokeConsent, consentMatchesBooking} from './booking-consent.js';
const KINDS=new Set(['student','parent']);
const CHANNELS=new Set(['customer_verified','staff_documented']);
export function validateConsentSubmission(input={}) {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw new Error('invalid_submission');
  const {bookingId,kind,mobile,channel,verified,optedIn,evidenceRef}=input;
  if (!CHANNELS.has(channel)) throw new Error('invalid_verification_channel');
  if (typeof evidenceRef!=='string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(evidenceRef)) throw new Error('verification_evidence_required');
  const record=validateConsentRecord({bookingId,kind,mobile,verified,optedIn,source:channel==='customer_verified'?'verified_customer_action':'verified_staff_record'});
  return {...record,evidenceRef};
}
export function recipientConsentStatus(booking, consents=[]) {
  if (!booking || !Number.isSafeInteger(Number(booking.id)) || Number(booking.id) < 1 ||
      !['student','parent','both'].includes(booking.recipient)) throw new Error('invalid_booking_recipient');
  if (!Array.isArray(consents)) throw new Error('invalid_consent_records');
  const selected=booking.recipient==='both'?['student','parent']:[booking.recipient];
  // Fail closed if a database join returns duplicate, cross-booking, or malformed records.
  // Never let the first matching row hide a later revocation or conflicting record.
  const eligible=[]; const blocked=[];
  for (const kind of selected) {
    const matches=consents.filter(c=>c?.kind===kind);
    if (matches.length===1 && Number.isSafeInteger(Number(matches[0].booking_id)) &&
        Number(matches[0].booking_id)===Number(booking.id) &&
        consentMatchesBooking(booking,matches[0],kind)) eligible.push(kind);
    else blocked.push(kind);
  }
  return {eligible,blocked};
}
export async function submitVerifiedRecipientConsent(db,booking,input) {
  const v=validateConsentSubmission(input);
  if (!KINDS.has(v.kind) || Number(booking?.id)!==v.bookingId || booking?.[v.kind+'_mobile']!==v.mobile ||
      !['both',v.kind].includes(booking?.recipient)) throw new Error('booking_recipient_mismatch');
  // evidenceRef must be independently validated and retained by the calling authenticated workflow.
  return recordVerifiedConsent(db,{...v,verified:true,optedIn:true});
}
export async function withdrawRecipientConsent(db,booking,{bookingId,kind}={}) {
  if (!KINDS.has(kind) || !Number.isSafeInteger(Number(bookingId)) || Number(bookingId)<1 || Number(booking?.id)!==Number(bookingId)) throw new Error('booking_recipient_mismatch');
  await revokeConsent(db,{bookingId,kind});
  return {bookingId:Number(bookingId),kind,revoked:true};
}
