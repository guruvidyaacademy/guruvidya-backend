// Step 6G: provider-agnostic dispatch eligibility guard.
// No automatic dispatch is installed by this file. Fail closed.
const CHANNELS = new Set(['whatsapp','email']);
const RECIPIENTS = new Set(['student','parent']);
const STAGES = new Set(['4h','2h','1h','5min']);
const STATUSES = new Set(['requested','approved','confirmed','rescheduled']);
const isTrue = value => value === true;

export function checkSmartReminderDispatchEligibility({job,booking,settings,now=new Date(),consentVerified=false,providerReady=false}={}) {
  const fail = reason => ({eligible:false,reason});
  if (!job || !booking || !settings) return fail('missing_context');
  if (!isTrue(settings.master_enabled)) return fail('master_off');
  if (!CHANNELS.has(job.channel) || !RECIPIENTS.has(job.recipient) || !STAGES.has(job.stage)) return fail('invalid_job');
  if (!STATUSES.has(String(booking.status||'').toLowerCase()) || booking.trashed_at || booking.cancelled_at) return fail('booking_inactive');
  if (Number(job.booking_id)!==Number(booking.id) || Number(job.appointment_revision)!==Number(booking.appointment_revision)) return fail('booking_revision_mismatch');
  if (Date.parse(job.starts_at)!==Date.parse(booking.starts_at)) return fail('appointment_changed');
  if (String(job.mode)!==String(booking.mode)) return fail('mode_changed');
  if (job.stage==='5min' && job.mode!=='online') return fail('invalid_stage_mode');
  if (!isTrue(settings[job.mode]?.[job.stage]?.[job.channel])) return fail('channel_disabled');
  if (job.channel==='whatsapp' && !consentVerified) return fail('consent_unverified');
  if (!providerReady) return fail('provider_not_verified');
  if (job.status!=='claimed') return fail('job_not_claimed');
  const current=Date.parse(now), due=Date.parse(job.due_at), start=Date.parse(booking.starts_at);
  if (![current,due,start].every(Number.isFinite) || current<due || current>=start) return fail('outside_delivery_window');
  return {eligible:true,reason:'guard_passed_not_sent'};
}
