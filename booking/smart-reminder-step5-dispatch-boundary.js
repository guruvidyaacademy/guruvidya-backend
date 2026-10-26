// Step 5: isolated dispatch boundary. Not mounted in server.js.
// Transport must be injected by a future audited worker. Safe default: HOLD.
const CHANNELS = new Set(['whatsapp', 'email']);
const RECIPIENTS = new Set(['student', 'parent']);
const STAGES = new Set(['4h', '2h', '1h', '5min']);
const HOLD = Object.freeze({ dispatched: false, reason: 'worker_not_connected' });

export function validateReminderDispatchJob(job) {
  if (!job || !Number.isSafeInteger(job.bookingId) || job.bookingId < 1 ||
      !Number.isSafeInteger(job.revision) || job.revision < 1 ||
      !CHANNELS.has(job.channel) || !RECIPIENTS.has(job.recipient) ||
      !STAGES.has(job.stage) || !['online', 'offline'].includes(job.mode) ||
      (job.stage === '5min' && job.mode !== 'online') ||
      !Number.isFinite(Date.parse(job.expectedStartsAt))) {
    throw new Error('invalid_smart_reminder_dispatch_job');
  }
  return true;
}

// This function never sends without every independent safety condition.
// A future worker must provide verified, transactional claim + opt-in checks,
// a current-booking recheck, and an approved provider-specific transport.
export async function dispatchSmartReminderJob(job, {
  workerEnabled = false,
  masterEnabled = false,
  migrationVerified = false,
  consentVerified = false,
  bookingRevisionVerified = false,
  uniqueClaimVerified = false,
  approvedTemplateVerified = false,
  sendApprovedMessage,
} = {}) {
  if (!workerEnabled) return { ...HOLD };
  validateReminderDispatchJob(job);
  if (!masterEnabled || !migrationVerified || !consentVerified ||
      !bookingRevisionVerified || !uniqueClaimVerified || !approvedTemplateVerified ||
      typeof sendApprovedMessage !== 'function') {
    return { dispatched: false, reason: 'dispatch_preconditions_unverified' };
  }
  // No catch/retry here: the future worker must persist provider responses
  // and use idempotency + uncertain-outcome handling before any retry.
  const receipt = await sendApprovedMessage(job);
  if (!receipt || typeof receipt !== 'object' || !receipt.providerMessageId) {
    return { dispatched: false, reason: 'provider_acceptance_unverified' };
  }
  return { dispatched: true, reason: 'provider_accepted', providerMessageId: String(receipt.providerMessageId) };
}
