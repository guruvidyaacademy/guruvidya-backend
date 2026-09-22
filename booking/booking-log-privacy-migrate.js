// Opt-in, one-off historical data cleanup. Dry run unless --apply is explicitly passed.
// Run on a DB backup first. Requires DATABASE_URL; does not log raw detail or phone numbers.
import pg from 'pg';
import { sanitizeBookingDetail } from './booking-log-privacy.js';
const apply=process.argv.includes('--apply');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exitCode=1; }
else {
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const rows=await db.query('SELECT id,detail FROM booking_delivery_logs WHERE detail IS NOT NULL FOR UPDATE');
    let candidates=0,unparseable=0;
    for (const row of rows.rows) {
      const result=sanitizeBookingDetail(row.detail);
      if(!result.parseable)unparseable++;
      if(!result.changed)continue;
      candidates++;
      if(apply) await db.query('UPDATE booking_delivery_logs SET detail=$1 WHERE id=$2',[result.value,row.id]);
    }
    if(apply) await db.query('COMMIT'); else await db.query('ROLLBACK');
    console.log(JSON.stringify({mode:apply?'applied':'dry_run',scanned:rows.rowCount,updated_or_candidate:candidates,unparseable_skipped:unparseable}));
  }catch(error){await db.query('ROLLBACK');console.error('Migration failed:',error.message);process.exitCode=1;}
  finally{db.release();await pool.end();}
}
