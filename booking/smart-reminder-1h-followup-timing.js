// Pure timing contract for the 1h reminder. No provider calls or queue mutations.
// The follow-up is always five minutes after the admin-configured email fallback,
// NOT fifteen minutes after the initial WhatsApp reminder.
export function planOneHourFollowup({startsAt, mode, settings = {}} = {}) {
  if (!['online', 'offline'].includes(mode)) throw new Error('invalid_mode');
  const appointment = Date.parse(startsAt);
  if (!Number.isFinite(appointment)) throw new Error('invalid_starts_at');
  const stageMinutes = settings?.stage_minutes?.[mode]?.['1h'] ?? 60;
  const fallbackMinutes = settings?.fallback_minutes?.['1h'] ?? 10;
  if (!Number.isSafeInteger(stageMinutes) || stageMinutes < 1 || stageMinutes > 10080) throw new Error('invalid_stage_minutes');
  if (!Number.isSafeInteger(fallbackMinutes) || fallbackMinutes < 0 || fallbackMinutes > 10080) throw new Error('invalid_fallback_minutes');
  const whatsappAt = appointment - stageMinutes * 60000;
  const emailAt = whatsappAt + fallbackMinutes * 60000;
  const needToChangeAt = emailAt + 5 * 60000;
  return Object.freeze({
    primaryButton: mode === 'offline' ? 'On My Way' : "I'm Ready",
    whatsappAt: new Date(whatsappAt).toISOString(),
    emailFallbackAt: new Date(emailAt).toISOString(),
    needToChangeAt: new Date(needToChangeAt).toISOString(),
    followupDelayAfterEmailMinutes: 5,
  });
}
