// Build 62: share the same overlap predicate between slot listing and lifecycle changes.
// An existing booking may be excluded ONLY while its own row is locked in a transaction.
export function bookingSlotConflictQuery({excludeBookingId=null}={}) {
  if(excludeBookingId!==null && (!Number.isSafeInteger(excludeBookingId)||excludeBookingId<1)) throw new Error('Invalid excluded booking ID');
  return {
    sql:`SELECT 1 FROM student_bookings WHERE counsellor_id=$1 AND status=ANY($2::text[]) AND starts_at < $3 AND ends_at > $4 AND ($5::bigint IS NULL OR id <> $5) LIMIT 1`,
    excludedId:excludeBookingId
  };
}
