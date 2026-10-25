// Step 48 OFFLINE packaging audit. No imports from live routes, SQL, or transports.
import {readFileSync, existsSync, lstatSync} from 'node:fs';
import {resolve, relative, isAbsolute, sep} from 'node:path';
const HOLD=Object.freeze({activationAllowed:false,sent:0,deleted:0,schedulerStarted:false});
const forbidden=['node_modules','.env','.git','dist','build'];
export function inspectPackageTree(root,relativePaths=[]) {
  const issues=[]; const seen=new Set();
  for(const name of relativePaths){
    if(typeof name!=='string'||!name||isAbsolute(name)||name.includes('\\')||name.split('/').some(p=>p==='..'||!p||forbidden.includes(p))){issues.push('unsafe_path');continue;}
    const full=resolve(root,name); const rel=relative(resolve(root),full);
    if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel)){issues.push('outside_root');continue;}
    if(seen.has(rel)){issues.push('duplicate_path');continue;} seen.add(rel);
    if(!existsSync(full)){issues.push('missing_file');continue;}
    if(lstatSync(full).isSymbolicLink()||!lstatSync(full).isFile()){issues.push('not_regular_file');continue;}
  }
  return Object.freeze({...HOLD,ready:false,reason:'package_review_only',issues:Object.freeze([...new Set(issues)]),fileCount:seen.size});
}
export function reviewMigrationText(sql=''){
  if(typeof sql!=='string'||!sql.trim())return {...HOLD,ready:false,reason:'migration_missing',blockers:['missing_sql']};
  const blockers=[];
  if(!/provider_account_id/i.test(sql))blockers.push('provider_account_scope_missing');
  if(!/booking_smart_reminder_deliveries/i.test(sql))blockers.push('deliveries_missing');
  if(!/booking_smart_reminder_claims/i.test(sql))blockers.push('claims_missing');
  if(!/booking_smart_reminder_click_events/i.test(sql))blockers.push('click_events_missing');
  if(/CREATE\s+UNIQUE\s+INDEX[\s\S]{0,200}\(\s*channel\s*,\s*provider_message_id\s*\)/i.test(sql))blockers.push('legacy_global_provider_index');
  return {...HOLD,ready:false,reason:'migration_review_only',blockers};
}
export function inspectUnwiredModule(serverPath,moduleName){
  if(typeof moduleName!=='string'||!/^[\w.-]+\.js$/.test(moduleName))return {...HOLD,isolated:false,reason:'invalid_module'};
  const source=readFileSync(serverPath,'utf8');
  return {...HOLD,isolated:!source.includes(moduleName),reason:source.includes(moduleName)?'mounted_requires_review':'unmounted_review_only'};
}
export function reviewPackagingEvidence(evidence={}){
  const required=['adminBuildPassed','backendRuntimePassed','migrationUpgradeVerified','botSailorAuthVerified','stagingConcurrencyPassed','stagingEndToEndPassed'];
  return {...HOLD,ready:false,reason:'release_hold',blockers:required.filter(k=>evidence[k]!==true)};
}
