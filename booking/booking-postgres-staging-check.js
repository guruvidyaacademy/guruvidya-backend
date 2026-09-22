// Build 65: opt-in, read-only PostgreSQL staging schema diagnostic.
// Never sends notifications, writes data, or claims a successful live test on its own.
const REQUIRED = Object.freeze({
  student_bookings: ['id','status','starts_at'],
  booking_recipient_consents: ['booking_id','kind','verified','opted_in','revoked_at'],
  booking_private_link_outbox: ['id','booking_id','kind','status','event_key'],
});
const safeIdentifier = name => /^[a-z_][a-z_0-9]*$/.test(name);
export async function checkBookingPostgresStaging(pool, { schema = 'public' } = {}) {
  if (!safeIdentifier(schema)) throw Error('invalid_staging_schema');
  if (!pool || typeof pool.connect !== 'function') throw Error('invalid_staging_pool');
  const client = await pool.connect();
  if (!client || typeof client.query !== 'function' || typeof client.release !== 'function') {
    if (typeof client?.release === 'function') client.release();
    throw Error('invalid_staging_client');
  }
  let active = false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    active = true;
    const missing = [];
    for (const [table, columns] of Object.entries(REQUIRED)) {
      const result = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [schema, table]
      );
      if (!Array.isArray(result?.rows) || result.rows.some(row => !row || typeof row.column_name !== 'string' || !safeIdentifier(row.column_name))) throw Error('invalid_staging_result');
      const found = new Set(result.rows.map(row => row.column_name));
      // Duplicate catalog rows indicate a malformed or inconsistent adapter response.
      // Never infer schema readiness from such a result.
      if (found.size !== result.rows.length) throw Error('invalid_staging_result');
      for (const column of columns) if (!found.has(column)) missing.push(`${table}.${column}`);
    }
    await client.query('COMMIT'); active = false;
    return Object.freeze({schemaReady: missing.length === 0, missingColumns: Object.freeze(missing), readOnly: true,
      liveVerified: false, dispatchAuthorized: false, nextStep: 'Run against an authorized staging database and record evidence separately.'});
  } catch (error) {
    if (active) try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}
