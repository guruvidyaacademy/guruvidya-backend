// Build 94: executable, opt-in staging smoke check. No database writes or WhatsApp sends.
import { pathToFileURL } from 'node:url';
import { runBookingStagingIntegration } from './booking-staging-integration-runner.js';
import { createBookingBotSailorStagingProbe } from './booking-botsailor-staging-probe.js';

export function validateBookingStagingCliConfig(env = {}) {
  if (env.BOOKING_STAGING_CONFIRM !== 'I_CONFIRM_STAGING_ONLY' || env.BOOKING_ENV !== 'staging' || env.BOOKING_DISPATCH_ENABLED !== 'false')
    throw Error('Staging-only confirmation and disabled dispatch are required');
  const databaseUrl = env.BOOKING_STAGING_DATABASE_URL;
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) throw Error('Staging database URL required');
  let db;
  try { db = new URL(databaseUrl); } catch { throw Error('Invalid staging database URL'); }
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || !db.hostname || !db.pathname || db.pathname === '/') throw Error('Invalid staging database URL');
  if (typeof env.BOOKING_BOTSAILOR_READONLY_ENDPOINT !== 'string' || !env.BOOKING_BOTSAILOR_READONLY_ENDPOINT.trim() ||
      typeof env.BOOKING_BOTSAILOR_API_TOKEN !== 'string' || !env.BOOKING_BOTSAILOR_API_TOKEN.trim())
    throw Error('Read-only BotSailor probe configuration required');
  const schema = env.BOOKING_STAGING_SCHEMA ?? 'public';
  if (typeof schema !== 'string' || !/^[a-z_][a-z_0-9]*$/.test(schema)) throw Error('Invalid staging schema');
  // Validate the read-only endpoint before loading the DB driver or opening a connection.
  createBookingBotSailorStagingProbe({endpoint: env.BOOKING_BOTSAILOR_READONLY_ENDPOINT, apiToken: env.BOOKING_BOTSAILOR_API_TOKEN});
  return Object.freeze({databaseUrl, schema, endpoint: env.BOOKING_BOTSAILOR_READONLY_ENDPOINT, apiToken: env.BOOKING_BOTSAILOR_API_TOKEN});
}

export async function runBookingStagingCli({env = process.env, loadPg = () => import('pg'), output = console.log, errorOutput = console.error} = {}) {
  let pool;
  try {
    const config = validateBookingStagingCliConfig(env);
    const {Pool} = await loadPg();
    if (typeof Pool !== 'function') throw Error('PostgreSQL driver unavailable');
    pool = new Pool({connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 8000,
      statement_timeout: 8000, query_timeout: 10000, application_name: 'guruvidya_booking_staging_readonly'});
    const report = await runBookingStagingIntegration({environment:'staging',stagingConfirmed:true,dispatchEnabled:false,
      pool,schema:config.schema,botSailorEndpoint:config.endpoint,botSailorApiToken:config.apiToken});
    output(JSON.stringify(report));
    return report.readyForManualReview === true ? 0 : 2;
  } catch {
    // Database driver and provider errors can contain secrets. Never print exception messages.
    errorOutput('Staging inspection failed or prerequisites missing. Dispatch remains disabled.');
    return 1;
  } finally {
    if (pool) { try { await pool.end(); } catch { /* no secret-bearing errors */ } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runBookingStagingCli();
}
