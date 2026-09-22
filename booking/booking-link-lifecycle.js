// Build 30: fail-closed lifecycle decision for a future durable booking-link outbox.
// This module does not send messages or store bearer management tokens.
const ACTIVE = new Set(['requested','approved','confirmed','rescheduled']);
const EVENTS = new Set(['created','approved','confirmed','rescheduled']);
const MOBILE = /^[6-9][0-9]{9}$/;

export function bookingLinkLifecycleDecision({booking,event,recipient,now=new Date()}={}) {
  const reasons=[];
  if (!booking || !Number.isSafeInteger(Number(booking.id)) || Number(booking.id)<1) reasons.push('invalid_booking');
  if (!EVENTS.has(event)) reasons.push('unsupported_event');
  if (!ACTIVE.has(booking?.status)) reasons.push('inactive_booking');
  if (booking?.customer_response==='cancelled') reasons.push('customer_cancelled');
  const start=new Date(booking?.starts_at);
  if (!Number.isFinite(start.getTime()) || start<=new Date(now)) reasons.push('slot_expired');
  if (!['student','parent'].includes(recipient?.kind)) reasons.push('invalid_recipient');
  if (!MOBILE.test(String(recipient?.mobile||''))) reasons.push('invalid_mobile');
  if (recipient?.verified!==true) reasons.push('identity_unverified');
  if (recipient?.optedIn!==true) reasons.push('whatsapp_consent_missing');
  if (booking && recipient?.kind && !['both',recipient.kind].includes(booking.recipient)) reasons.push('recipient_not_selected');
  if (booking && recipient?.kind && MOBILE.test(String(recipient.mobile||'')) && booking[recipient.kind+'_mobile']!==recipient.mobile) reasons.push('recipient_changed');
  return {eligible:reasons.length===0,reasons};
}

