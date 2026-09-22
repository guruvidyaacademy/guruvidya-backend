// Shared, side-effect-free checks for public and admin booking lifecycle requests.
// These checks run before a database connection is acquired; slot availability
// and ownership must still be verified transactionally by the caller.
export function validateLifecycleSlot(value, currentSlot) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return 'Invalid new slot';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Invalid new slot';
  const [year, month, day] = value.slice(0,10).split('-').map(Number);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth()+1 !== month || parsed.getUTCDate() !== day) return 'Invalid new slot';
  if (currentSlot !== undefined && currentSlot !== null && timestamp === new Date(currentSlot).getTime()) return 'Choose a different slot';
  return null;
}
export function validateLifecycleAction(action, allowed) {
  return typeof action === 'string' && allowed.includes(action);
}

// A reassignment must actually change the counsellor or the appointment time.
// Reject no-op requests before writing an event or creating a misleading audit trail.
export function validateReassignmentChange(currentCounsellorId, currentSlot, targetCounsellorId, targetSlot) {
  if (Number(currentCounsellorId) === Number(targetCounsellorId) &&
      new Date(currentSlot).getTime() === new Date(targetSlot).getTime()) {
    return 'Choose a different counsellor or slot';
  }
  return null;
}
