// Build 48: read-only integration preflight. Never sends messages or mutates database.
// Run with a staging PostgreSQL pool; provider checks are configuration-only.
const SAFE_NAME=/^[a-z_][a-z0-9_]*$/;
const REQUIRED=Object.freeze({
  booking_private_link_outbox:['id','status'],
});
export function validateBookingProviderConfig(config={}) {
  const errors=[];
  if(!config||typeof config!=='object'||Array.isArray(config)) return Object.freeze({ready:false,errors:Object.freeze(['invalid_provider_config'])});
  if(config.enabled!==false) errors.push('delivery_must_remain_disabled_during_preflight');
  if(config.stagingVerified!==true) errors.push('staging_template_not_verified');
  if(config.callbackAuthenticated!==true) errors.push('provider_callback_authentication_not_verified');
  if(config.consentWorkflowVerified!==true) errors.push('recipient_consent_workflow_not_verified');
  return Object.freeze({ready:errors.length===0,errors:Object.freeze(errors)});
}
export async function bookingIntegrationPreflight(pool,{providerConfig={}}={}) {
  if(!pool||typeof pool.query!=='function') throw Error('invalid_preflight_database');
  const provider=validateBookingProviderConfig(providerConfig);
  const errors=[];
  const tables={};
  for(const [table,columns] of Object.entries(REQUIRED)) {
    if(!SAFE_NAME.test(table)||columns.some(c=>!SAFE_NAME.test(c))) throw Error('invalid_preflight_schema');
    // Fixed SQL and identifiers; only column names and existence are retrieved.
    const result=await pool.query('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',[table]);
    if(!Array.isArray(result?.rows)) throw Error('invalid_preflight_result');
    const found=new Set();
    for(const row of result.rows) {
      if(!row||typeof row.column_name!=='string') throw Error('invalid_preflight_result');
      found.add(row.column_name);
    }
    const missing=columns.filter(c=>!found.has(c));
    tables[table]=Object.freeze({present:missing.length===0,missingColumns:Object.freeze(missing)});
    if(missing.length) errors.push('missing_required_schema:'+table);
  }
  // Never return credentials, SQL row data, phone numbers or URLs.
  return Object.freeze({databaseSchemaReady:errors.length===0,providerConfigReady:provider.ready,productionReady:false,liveDeliveryTested:false,dispatchEnabled:false,tables:Object.freeze(tables),checksRequired:Object.freeze([...errors,...provider.errors,'authenticated_admin_routes_not_verified','live_end_to_end_staging_test_not_run'])});
}
