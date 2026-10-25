// Offline-only Step 49 evidence audit. No imports from live routes, database or transports.
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
const HOLD=Object.freeze({ready:false,activationAllowed:false,sent:0,deleted:0,schedulerStarted:false});
const REQUIRED=['adminBuildPassed','backendRuntimePassed','postgresSchemaInventoried','upgradeMigrationTested','rollbackTested','postgresConcurrencyPassed','botSailorSignatureVerified','providerAccountVerified','stagingEndToEndPassed','operatorApproved'];
export function reviewFinalEvidence(evidence={}){
 const missing=REQUIRED.filter(key=>evidence?.[key]!==true);
 return Object.freeze({...HOLD,reason:'final_zip_hold',missing:Object.freeze(missing)});
}
export function inspectMigrationUpgrade(sql=''){
 const blockers=[];
 if(typeof sql!=='string'||!sql.trim())return {...HOLD,blockers:['missing_migration']};
 if(!/provider_account_id/i.test(sql))blockers.push('provider_account_scope_missing');
 if(!/booking_smart_reminder_claims/i.test(sql))blockers.push('claims_missing');
 if(!/booking_smart_reminder_deliveries/i.test(sql))blockers.push('deliveries_missing');
 if(!/booking_smart_reminder_click_events/i.test(sql))blockers.push('click_events_missing');
 // CREATE TABLE IF NOT EXISTS is not a safe upgrade for already-populated tables.
 if(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(sql))blockers.push('fresh_install_not_populated_upgrade');
 if(/CREATE\s+UNIQUE\s+INDEX[\s\S]{0,160}\(\s*channel\s*,\s*provider_message_id\s*\)/i.test(sql))blockers.push('unscoped_provider_identity');
 return {...HOLD,reason:'review_only',blockers};
}
export function inspectBuildManifest(root){
 const result={...HOLD,admin:{},backend:{}};
 for(const [name,dir,required] of [['admin','guruvidya-admin-main',['vite','react','react-dom']],['backend','guruvidya-backend-main',['express','pg','axios','nodemailer']]]){
  const file=join(root,dir,'package.json');
  if(!existsSync(file)){result[name]={valid:false,missing:required,reason:'manifest_missing'};continue;}
  try{const manifest=JSON.parse(readFileSync(file,'utf8'));const declared={...manifest.dependencies,...manifest.devDependencies};const missing=required.filter(x=>!Object.hasOwn(declared,x));result[name]={valid:missing.length===0,missing,reason:missing.length?'dependency_not_declared':'declared_not_installed_or_built'};}
  catch{result[name]={valid:false,missing:required,reason:'invalid_manifest'};}
 }
 return result;
}
export function reviewIntegrationIsolation(serverSource='',bookingSource=''){
 const forbidden=['smart-reminder-receipt-writer','smart-reminder-claim-delivery-handoff','smart-reminder-step20-scheduler-adapter','smart-reminder-fasttrack-safety'];
 const mounted=forbidden.filter(s=>serverSource.includes(s)||bookingSource.includes(s));
 return {...HOLD,isolated:mounted.length===0,reason:mounted.length?'integration_requires_review':'unmounted',mounted};
}
