// Namespace separates booking dispatch coordination from counsellor slot locks.
// A session lock serializes provider dispatch with booking mutations across app instances.
export const BOOKING_DISPATCH_LOCK_NAMESPACE = 75201948;
export function bookingDispatchLockSql(transaction = false) {
  return transaction ? 'SELECT pg_advisory_xact_lock($1,$2)' : 'SELECT pg_advisory_lock($1,$2)';
}
export function bookingDispatchUnlockSql() { return 'SELECT pg_advisory_unlock($1,$2)'; }
export function bookingDispatchLockArgs(id) {
  if (!Number.isSafeInteger(Number(id)) || Number(id) < 1 || Number(id) > 2147483647)
    throw Error('Invalid booking dispatch lock ID');
  return [BOOKING_DISPATCH_LOCK_NAMESPACE, Number(id)];
}
