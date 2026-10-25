// Step 39: UNMOUNTED, provider-neutral review contract. No database access or sending.
// State transitions are proposals only; they must not be used for provider callbacks until
// BotSailor's actual authentication, message ID scope and event ordering are verified.
const STATES = new Set(['pending','claimed','sent','delivered','read','opened','clicked','failed','skipped']);
const CHANNELS = new Set(['whatsapp','email']);
const RECIPIENTS = new Set(['student','parent']);
const STAGES = new Set(['4h','2h','1h','5min']);
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const transitions = Object.freeze({
  pending: ['claimed','skipped'], claimed: ['sent','failed','skipped'],
  sent: ['delivered','read','opened','clicked','failed'],
  delivered: ['read','opened','clicked'], read: ['clicked'], opened: ['clicked'],
  clicked: ['clicked'], failed: [], skipped: []
});
export function validateProviderIdentity(x) {
  if (!x || !CHANNELS.has(x.channel) || !RECIPIENTS.has(x.recipientType) ||
      !STAGES.has(x.stage) || !Number.isSafeInteger(x.bookingId) || x.bookingId < 1 ||
      !Number.isSafeInteger(x.appointmentRevision) || x.appointmentRevision < 1 ||
      typeof x.providerAccountId !== 'string' || !ID.test(x.providerAccountId) ||
      typeof x.providerMessageId !== 'string' || !ID.test(x.providerMessageId)) {
    throw new Error('untrusted_provider_identity');
  }
  if (x.stage === '5min' && x.mode !== 'online') throw new Error('invalid_online_stage');
  return Object.freeze({channel:x.channel,providerAccountId:x.providerAccountId,providerMessageId:x.providerMessageId,
    bookingId:x.bookingId,appointmentRevision:x.appointmentRevision,recipientType:x.recipientType,stage:x.stage});
}
export function validateResolvedProviderEvent(expected, resolved) {
  const a=validateProviderIdentity(expected), b=validateProviderIdentity(resolved);
  if (Object.keys(a).some(k=>a[k]!==b[k]) || !Number.isSafeInteger(resolved.id) || resolved.id < 1) {
    throw new Error('provider_delivery_mismatch');
  }
  return Object.freeze({deliveryId:resolved.id,...b});
}
export function proposeDeliveryTransition({channel,from,to,eventAt,previousAt}={}) {
  if (!CHANNELS.has(channel) || !STATES.has(from) || !STATES.has(to) ||
      !transitions[from].includes(to) || (to==='read' && channel!=='whatsapp') ||
      (to==='opened' && channel!=='email')) throw new Error('invalid_delivery_transition');
  const time=Date.parse(eventAt);
  if (typeof eventAt!=='string' || !Number.isFinite(time)) throw new Error('invalid_event_timestamp');
  if (previousAt != null && (!Number.isFinite(Date.parse(previousAt)) || time < Date.parse(previousAt)))
    throw new Error('out_of_order_delivery_timestamp');
  return Object.freeze({channel,from,to,eventAt:new Date(time).toISOString(),dispatch:false});
}
export function disabledDeliveryTransition() {return Object.freeze({updated:false,sent:0,reason:'delivery_transition_hold'});}
