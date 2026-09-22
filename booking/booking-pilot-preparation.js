// Build 58: offline controlled-pilot preparation. No live verification or dispatch authorization.
import {assessBookingStagingSecurity} from './booking-staging-security-gate.js';
const REQUIRED = Object.freeze(['staging_database_backup','staging_restore_test','migration_rollback_script','pilot_owner','incident_contact','pilot_stop_procedure','picktime_fallback','dispatch_disabled_confirmation']);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
export const requiredBookingPilotPreparation = REQUIRED;
export function assessBookingPilotPreparation({stagingEvidence={},preparation={},dispatchEnabled=false}={}) {
  if (!plain(preparation)) throw Error('invalid_pilot_preparation');
  if (typeof dispatchEnabled !== 'boolean') throw Error('invalid_dispatch_setting');
  if (Object.keys(preparation).some(key=>!REQUIRED.includes(key))) throw Error('unknown_pilot_preparation');
  const staging=assessBookingStagingSecurity(stagingEvidence);
  const checks=REQUIRED.map(name=>{
    const value=Object.hasOwn(preparation,name)?preparation[name]:undefined;
    if(value!==undefined && typeof value!=='boolean') throw Error('invalid_pilot_preparation_check');
    return Object.freeze({name,status:value===true?'reported_pass':value===false?'reported_fail':'missing'});
  });
  const pending=Object.freeze([...staging.checks.filter(x=>x.status!=='reported_pass').map(x=>`staging:${x.name}`),...checks.filter(x=>x.status!=='reported_pass').map(x=>`pilot:${x.name}`),...(dispatchEnabled?['dispatch_must_remain_disabled']:[])]);
  return Object.freeze({checks:Object.freeze(checks),pending,reportedPreparationComplete:pending.length===0,liveVerified:false,pilotAuthorized:false,productionAuthorized:false,dispatchEnabled:false,picktimeReplacementAuthorized:false});
}
