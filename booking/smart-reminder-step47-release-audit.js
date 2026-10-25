// Step 47 offline audit only. Never mounts routes, executes SQL, or enables transport.
import {createRequire} from 'node:module';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const HOLD=Object.freeze({activationAllowed:false,sent:0,deleted:0,schedulerStarted:false});
const requiredEvidence=Object.freeze([
  'adminBuildPassed','backendDependenciesInstalled','backendRuntimeVerified',
  'populatedSchemaInventoried','versionedMigrationReviewed','rollbackReviewed',
  'postgresConcurrencyPassed','providerSignatureVerified','providerAccountScopeVerified',
  'recipientPolicyVerified','stagingEndToEndPassed','operatorApproved'
]);
export function reviewReleaseEvidence(evidence={}) {
  const blockers=requiredEvidence.filter(k=>evidence[k]!==true);
  return Object.freeze({...HOLD,ready:false,reason:'release_hold',blockers:Object.freeze(blockers)});
}
export function inspectLocalPackage(projectPath, names=[]) {
  const manifestPath=resolve(projectPath,'package.json');
  if(!existsSync(manifestPath))return {ok:false,reason:'manifest_missing',missing:names};
  let manifest;
  try{manifest=JSON.parse(readFileSync(manifestPath,'utf8'));}
  catch{return {ok:false,reason:'manifest_invalid',missing:names};}
  const declared={...manifest.dependencies,...manifest.devDependencies};
  const requireFromProject=createRequire(manifestPath);
  const missing=names.filter(name=>{
    if(!Object.hasOwn(declared,name))return true;
    try{requireFromProject.resolve(`${name}/package.json`);return false;}
    catch{try{requireFromProject.resolve(name);return false;}catch{return true;}}
  });
  return {ok:missing.length===0,reason:missing.length?'dependencies_unavailable':'locally_resolvable',missing,declared:names.filter(n=>Object.hasOwn(declared,n))};
}
export function reviewWebhookContract(evidence={}) {
  const required=['rawBodyVerified','signatureAlgorithmConfirmed','signatureHeaderConfirmed','secretSourceVerified','replayPolicyVerified','providerAccountScopeVerified','providerEventMappingVerified'];
  return Object.freeze({...HOLD,authenticated:false,reason:'webhook_unverified',blockers:Object.freeze(required.filter(k=>evidence[k]!==true))});
}
