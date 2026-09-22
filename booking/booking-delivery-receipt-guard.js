// Build 56: pure guard for an already authenticated, correlated BotSailor receipt.
// Caller must authenticate provider callback, bind its message reference to a
// stored attempt, and persist the returned state and event ID atomically.
// No HTTP endpoint, DB writes, or WhatsApp dispatch is enabled by this module.
import {applyVerifiedProviderReceipt,validateDeliveryAttempt} from './booking-notification-delivery-tracker.js';
const EVENT_ID=/^[A-Za-z0-9:_-]{1,128}$/;
const isPlain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&(Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);
export function guardBookingDeliveryReceipt({attempt,receipt,eventId,previousEventIds=[],authenticated=false,correlated=false}={}) {
  const current=validateDeliveryAttempt(attempt);
  if(authenticated!==true||correlated!==true) throw Error('unverified_provider_receipt');
  if(typeof eventId!=='string'||!EVENT_ID.test(eventId)) throw Error('invalid_receipt_event_id');
  if(!Array.isArray(previousEventIds)||previousEventIds.some(id=>typeof id!=='string'||!EVENT_ID.test(id))) throw Error('invalid_receipt_event_history');
  if(!isPlain(receipt)) throw Error('invalid_provider_receipt');
  // A replay must still match the current attempt's provider message reference.
  if(current.providerMessageRef && receipt.messageRef!==current.providerMessageRef) throw Error('provider_reference_mismatch');
  if(previousEventIds.includes(eventId)) return Object.freeze({attempt:current,duplicate:true,changed:false,eventId});
  const next=applyVerifiedProviderReceipt(current,receipt,{authenticated:true,correlated:true});
  return Object.freeze({attempt:next,duplicate:false,changed:next.changed,eventId});
}
