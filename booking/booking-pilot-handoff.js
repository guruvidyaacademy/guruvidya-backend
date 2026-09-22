// Build 70: offline handoff inventory only. Never authorizes live traffic or WhatsApp dispatch.
import {assessBookingPilotPreparation} from './booking-pilot-preparation.js';
const REQUIRED = Object.freeze(['postgresql_staging_test','botsailor_staging_test','consent_end_to_end_test','booking_lifecycle_test','admin_monitoring_test','rollback_drill','pilot_owner_approval']);
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
export const requiredBookingPilotHandoffChecks = REQUIRED;
export function assessBookingPilotHandoff({stagingEvidence={},preparation={},handoff={},dispatchEnabled=false}={}) {
  if (!isPlain(handoff) || Object.keys(handoff).some(k=>!REQUIRED.includes(k))) throw Error('invalid_pilot_handoff');
  if (typeof dispatchEnabled !== 'boolean') throw Error('invalid_dispatch_setting');
  const pilot = assessBookingPilotPreparation({stagingEvidence,preparation,dispatchEnabled});
  const checks = REQUIRED.map(name=>{
    const value = Object.hasOwn(handoff,name) ? handoff[name] : undefined;
    if (value !== undefined && typeof value !== 'boolean') throw Error('invalid_pilot_handoff_check');
    return Object.freeze({name,status:value===true?'reported_pass':value===false?'reported_fail':'missing'});
  });
  const pending = Object.freeze([...pilot.pending,...checks.filter(c=>c.status!=='reported_pass').map(c=>`handoff:${c.name}`)]);
  return Object.freeze({checks:Object.freeze(checks),pending,reportedHandoffComplete:pending.length===0,liveVerified:false,pilotAuthorized:false,productionAuthorized:false,dispatchAuthorized:false,picktimeReplacementAuthorized:false});
}
