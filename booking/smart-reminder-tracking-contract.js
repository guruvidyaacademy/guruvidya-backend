// Step 36: provider-neutral, unmounted contract. No DB queries, HTTP handlers or dispatch.
const CHANNELS = new Set(['whatsapp', 'email']);
const RECIPIENTS = new Set(['student', 'parent']);
const STAGES = new Set(['4h', '2h', '1h', '5min']);
const ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
export function validateTrustedDelivery({ providerMessageId, channel, resolvedDelivery } = {}) {
  if (typeof providerMessageId !== 'string' || !ID_RE.test(providerMessageId) || !CHANNELS.has(channel)) throw new Error('Invalid provider lookup key');
  if (!resolvedDelivery || resolvedDelivery.providerMessageId !== providerMessageId || resolvedDelivery.channel !== channel ||
      !Number.isSafeInteger(resolvedDelivery.id) || resolvedDelivery.id < 1 ||
      !RECIPIENTS.has(resolvedDelivery.recipientType) || !STAGES.has(resolvedDelivery.stage) ||
      !Number.isSafeInteger(resolvedDelivery.appointmentRevision) || resolvedDelivery.appointmentRevision < 1) throw new Error('Untrusted or ambiguous delivery');
  if (resolvedDelivery.stage === '5min' && resolvedDelivery.mode !== 'online') throw new Error('5min requires online appointment');
  return Object.freeze({ id: resolvedDelivery.id, channel, recipientType: resolvedDelivery.recipientType, stage: resolvedDelivery.stage, appointmentRevision: resolvedDelivery.appointmentRevision });
}
export function retentionReadWindowDays() { return 15; }
