// Human review of uncertain provider outcomes. Never infer handset delivery or retry.
export function classifyAttemptForReview(row) {
  const status=String(row?.status||'');
  const claimed=row?.sending_claimed_at;
  if (status==='unknown') return {requires_manual_review:true,reason:'provider_outcome_unknown',automatic_retry_allowed:false};
  if (status==='sending' && !claimed) return {requires_manual_review:true,reason:'legacy_claim_missing_timestamp',automatic_retry_allowed:false};
  if (status==='sending') return {requires_manual_review:true,reason:'sending_in_progress_check_age',automatic_retry_allowed:false};
  return {requires_manual_review:false,reason:null,automatic_retry_allowed:false};
}
