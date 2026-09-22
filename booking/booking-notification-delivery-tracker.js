// Build 46: offline, privacy-preserving provider receipt state machine.
// No transport, HTTP endpoint, scheduler, or database mutation is enabled here.
// Provider callbacks must be authenticated and correlated to an existing attempt
// by the calling integration BEFORE passing normalized status into this module.
const STATES=new Set(['blocked','ready','sending','accepted','delivered','read','failed','unknown']);
const TRANSITIONS=Object.freeze({
  blocked:new Set([]),ready:new Set(['sending']),sending:new Set(['accepted','failed','unknown']),
  accepted:new Set(['delivered','read','failed','unknown']),delivered:new Set(['read']),
  read:new Set([]),failed:new Set([]),unknown:new Set(['accepted','delivered','read','failed'])
});
const PROVIDER_STATUSES=Object.freeze({accepted:'accepted',sent:'accepted',delivered:'delivered',read:'read',failed:'failed'});
const SAFE_REF=/^[A-Za-z0-9:_-]{1,128}$/;
const isPlain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&(Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);
export function validateDeliveryAttempt({attemptId,state,providerMessageRef=null}={}) {
  if(!Number.isSafeInteger(attemptId)||attemptId<1||!STATES.has(state)) throw Error('invalid_delivery_attempt');
  if(providerMessageRef!==null&&(typeof providerMessageRef!=='string'||!SAFE_REF.test(providerMessageRef))) throw Error('invalid_provider_reference');
  return Object.freeze({attemptId,state,providerMessageRef});
}
export function transitionDeliveryAttempt(current,next,{providerMessageRef=null}={}) {
  const attempt=validateDeliveryAttempt(current);
  if(!STATES.has(next)) throw Error('invalid_delivery_status');
  if(next===attempt.state) return Object.freeze({...attempt,changed:false});
  if(!TRANSITIONS[attempt.state].has(next)) throw Error('invalid_delivery_transition');
  if(providerMessageRef!==null&&(typeof providerMessageRef!=='string'||!SAFE_REF.test(providerMessageRef))) throw Error('invalid_provider_reference');
  if(attempt.providerMessageRef&&providerMessageRef&&attempt.providerMessageRef!==providerMessageRef) throw Error('provider_reference_mismatch');
  if(['accepted','delivered','read'].includes(next)&&!(attempt.providerMessageRef||providerMessageRef)) throw Error('provider_reference_required');
  return Object.freeze({attemptId:attempt.attemptId,state:next,providerMessageRef:attempt.providerMessageRef||providerMessageRef,changed:true});
}
export function applyVerifiedProviderReceipt(current,receipt,{authenticated=false,correlated=false}={}) {
  if(authenticated!==true||correlated!==true) throw Error('unverified_provider_receipt');
  if(!isPlain(receipt)||typeof receipt.status!=='string'||!Object.hasOwn(PROVIDER_STATUSES,receipt.status)) throw Error('invalid_provider_receipt');
  if(typeof receipt.messageRef!=='string'||!SAFE_REF.test(receipt.messageRef)) throw Error('invalid_provider_reference');
  // Never persist or return the raw receipt: it may contain phone numbers or private URLs.
  return transitionDeliveryAttempt(current,PROVIDER_STATUSES[receipt.status],{providerMessageRef:receipt.messageRef});
}
export function deliveryRetryDecision(current,{explicitProviderNonDelivery=false,recipientConsentValid=false,dispatchAuthorized=false}={}) {
  const attempt=validateDeliveryAttempt(current);
  // Unknown / accepted may already have reached the handset: do not retry automatically.
  const allowed=attempt.state==='failed'&&explicitProviderNonDelivery===true&&recipientConsentValid===true&&dispatchAuthorized===true;
  return Object.freeze({allowed,reason:allowed?'manual_review_required':'retry_blocked'});
}
