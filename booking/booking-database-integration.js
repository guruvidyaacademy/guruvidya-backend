// Build 51: read-only PostgreSQL booking integration probe for staging.
// No migrations, personal data, provider calls, notification dispatch or settings changes.
const REQUIRED = Object.freeze({
  student_bookings:['id','status','starts_at'],
  booking_recipient_consents:['booking_id','kind','verified','opted_in','revoked_at'],
  booking_private_link_outbox:['id','booking_id','kind','status','event_key'],
});
const STATUSES=['blocked','ready','sending','accepted','unknown','failed','cancelled'];
function rowsOf(result) { if(!Array.isArray(result?.rows)) throw Error('invalid_booking_database_result'); return result.rows; }
export async function inspectBookingDatabase(pool) {
  if(!pool || typeof pool.connect!=='function') throw Error('invalid_booking_database_pool');
  const client=await pool.connect();
  if(!client || typeof client.query!=='function'||typeof client.release!=='function') throw Error('invalid_booking_database_client');
  let begun=false;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun=true;
    const missing=[];
    for(const [table,columns] of Object.entries(REQUIRED)) {
      const found=new Set(rowsOf(await client.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',[table]
      )).map(row=>row?.column_name));
      for(const column of columns) if(!found.has(column)) missing.push(`${table}.${column}`);
    }
    if(missing.length) {
      await client.query('COMMIT');begun=false;
      return Object.freeze({schemaReady:false,missingColumns:Object.freeze(missing),dispatchEnabled:false,liveTested:false});
    }
    const bookingRows=rowsOf(await client.query('SELECT status, COUNT(*)::text AS count FROM student_bookings GROUP BY status'));
    const outboxRows=rowsOf(await client.query('SELECT status, COUNT(*)::text AS count FROM booking_private_link_outbox GROUP BY status'));
    const consentRows=rowsOf(await client.query(`SELECT COUNT(*)::text AS count FROM booking_recipient_consents WHERE verified = TRUE AND opted_in = TRUE AND revoked_at IS NULL`));
    function counts(rows, allowed) {
      const result=Object.create(null);
      for(const row of rows) {
        if(typeof row?.status!=='string'||!allowed.includes(row.status)||Object.hasOwn(result,row.status)||!/^\d+$/.test(row.count)) throw Error('invalid_booking_database_result');
        result[row.status]=row.count;
      }
      return Object.freeze({...result});
    }
    if(consentRows.length!==1||!/^\d+$/.test(consentRows[0]?.count)) throw Error('invalid_booking_database_result');
    const bookings=counts(bookingRows,['requested','approved','confirmed','cancelled','completed','no_show','rejected','rescheduled']);
    const outbox=counts(outboxRows,STATUSES);
    await client.query('COMMIT');begun=false;
    return Object.freeze({schemaReady:true,missingColumns:Object.freeze([]),bookings,outbox,validConsentCount:consentRows[0].count,dispatchEnabled:false,liveTested:false});
  } catch(error) {if(begun) try {await client.query('ROLLBACK');}catch{} throw error;}
  finally {client.release();}
}
