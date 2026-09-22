// Compare UTC slot instants, not textual formatting (Z vs .000Z).
// Fail closed if a malformed/duplicated availability response would make a
// booking creation or reschedule choose an ambiguous appointment.
export function findMatchingBookingSlot(available, requestedStart) {
  if (!Array.isArray(available)) return undefined;
  const requested = new Date(requestedStart).getTime();
  if (!Number.isFinite(requested)) return undefined;
  let match;
  for (const slot of available) {
    if (!slot || typeof slot !== 'object') continue;
    const startsAt = new Date(slot.starts_at).getTime();
    const endsAt = new Date(slot.ends_at).getTime();
    if (!Number.isFinite(startsAt) || startsAt !== requested) continue;
    // An invalid row at the requested instant is not proof of availability.
    // Reject the entire match even if another row for that instant looks valid.
    if (!Number.isFinite(endsAt) || endsAt <= startsAt) return undefined;
    if (match) return undefined;
    match = slot;
  }
  return match;
}
