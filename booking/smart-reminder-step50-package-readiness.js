// Offline-only release inventory. No network, SQL, sender, scheduler or deletion actions.
import {existsSync, lstatSync, readFileSync, readdirSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import {createHash} from 'node:crypto';
const HOLD=Object.freeze({ready:false,zipAuthorized:false,activationAllowed:false});
export function inventoryTree(root, subdir){
 if(typeof subdir!=='string'||!['guruvidya-admin-main','guruvidya-backend-main'].includes(subdir))throw Error('invalid_subdir');
 const base=join(root,subdir);if(!existsSync(base))throw Error('missing_tree');
 const out=[];
 function visit(dir){for(const ent of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const full=join(dir,ent.name), rel=relative(base,full).split(sep).join('/');
  if(ent.isSymbolicLink())throw Error('symlink_not_allowed');
  if(['node_modules','.git','dist','.env'].includes(ent.name))throw Error('unsafe_entry:'+rel);
  if(ent.isDirectory())visit(full);
  else if(ent.isFile()){const stat=lstatSync(full);if(stat.size>20*1024*1024)throw Error('oversized_file:'+rel);
   out.push({path:rel,bytes:stat.size,sha256:createHash('sha256').update(readFileSync(full)).digest('hex')});}
  else throw Error('unsupported_entry');
 }}visit(base);return Object.freeze(out);
}
export function compareInventories(before=[],after=[]){
 const a=new Map(before.map(x=>[x.path,x.sha256])),b=new Map(after.map(x=>[x.path,x.sha256]));
 return Object.freeze({added:[...b.keys()].filter(x=>!a.has(x)).sort(),modified:[...b.keys()].filter(x=>a.has(x)&&a.get(x)!==b.get(x)).sort(),deleted:[...a.keys()].filter(x=>!b.has(x)).sort()});
}
export function finalPackagingHold({operatorApproved=false,buildPassed=false,stagingPassed=false}={}){
 return Object.freeze({...HOLD,reason:'explicit_final_zip_hold',operatorApproved,buildPassed,stagingPassed});
}
