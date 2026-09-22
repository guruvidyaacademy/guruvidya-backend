// Build 39: bounded, read-only keyset page for blocked dispatch audit.
// This is an inventory snapshot, NEVER an instruction or permission to send.
export function validateBlockedAuditPage({afterId=0,limit=25}={}) {
  if (!Number.isSafeInteger(afterId) || afterId < 0) throw new Error('invalid_audit_cursor');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_audit_limit');
  return {afterId,limit};
}

export async function blockedDispatchAuditPage(pool, options={}) {
  const {afterId,limit}=validateBlockedAuditPage(options);
  // Fetch one extra row to establish hasMore; never expose recipient or token data.
  const result=await pool.query(
    "SELECT id FROM booking_private_link_outbox WHERE status='blocked' AND id>$1 ORDER BY id ASC LIMIT $2",
    [afterId,limit+1]
  );
  const rows=result.rows;
  if (!Array.isArray(rows) || rows.length>limit+1 || rows.some((row,index)=>
    !Number.isSafeInteger(row?.id) || row.id<=afterId || (index>0 && row.id<=rows[index-1].id)
  )) {
    throw new Error('invalid_audit_page_result');
  }
  const page=rows.slice(0,limit);
  return {
    sampled:page.length,
    nextAfterId:page.length?page[page.length-1].id:afterId,
    hasMore:rows.length>limit,
    snapshotOnly:true,
    dispatchEnabled:false,
    requiresFreshLockedEligibilityCheck:true
  };
}
