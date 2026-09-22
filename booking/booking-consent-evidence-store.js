// Build 73: PostgreSQL one-time consent evidence consumer for trusted integrations.
// Evidence must be independently issued after recipient ownership verification.
// No OTP issuance, public endpoint, or WhatsApp dispatch is implemented here.
export async function consumeBookingConsentEvidence(client, {actor,bookingId,kind,mobile,channel,evidenceRef}={}) {
  if (!client || typeof client.query !== 'function') throw Error('database_client_required');
  if (!actor || actor.authenticated !== true || typeof actor.id !== 'string' || !actor.id) throw Error('authentication_required');
  if (!Number.isSafeInteger(bookingId) || bookingId < 1 || !['student','parent'].includes(kind) ||
      !/^[0-9]{10}$/.test(mobile || '') || !['customer_verified','staff_documented'].includes(channel) ||
      typeof evidenceRef !== 'string' || !/^[A-Za-z0-9:_-]{8,128}$/.test(evidenceRef)) throw Error('invalid_evidence_request');
  // Atomic UPDATE returns exactly one row only when the proof is unexpired, unused,
  // bound to this actor and recipient, and previously verified by the trusted issuer.
  const result = await client.query(`UPDATE booking_consent_evidence SET consumed_at = NOW()
    WHERE evidence_ref = $1 AND booking_id = $2 AND kind = $3 AND mobile = $4
      AND channel = $5 AND actor_id = $6 AND verified_at IS NOT NULL
      AND consumed_at IS NULL AND expires_at > NOW()
    RETURNING evidence_ref`,[evidenceRef,bookingId,kind,mobile,channel,actor.id]);
  // A duplicate reference is a data-integrity failure, not an ordinary missing proof.
  // The caller owns the transaction and must roll it back on this error.
  if (!Array.isArray(result?.rows)) throw Error('invalid_evidence_database_result');
  if (result.rows.length > 1) throw Error('duplicate_evidence_reference');
  // Verify the returned row actually identifies the consumed proof; a malformed
  // adapter result must not authorize a recipient's WhatsApp consent.
  if (result.rows.length === 1 && (result.rows[0]?.evidence_ref !== evidenceRef))
    throw Error('evidence_reference_result_mismatch');
  return result.rows.length === 1;
}
