import { mkdir, open, rename, unlink, lstat, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { loadSpec, renderScan, visibleText, type ScanReport, type ScanFinding, type ScanIssue } from '@autoshim/core';
import { scanDirectory } from './scan-command.js';

const MAX_SPEC=15*1024*1024,MAX_STATE=8*1024*1024,HISTORY_LIMIT=200,CATALOG_LIMIT=5000;
export interface WatchSource {kind:'local'|'public';value:string}
interface WatchConfig {schemaVersion:1;repo:string;source:WatchSource;apiVersion:string;baselineHash:string;baselineLabel:string;createdAt:string}
export interface WatchRun {
 id:string;checkedAt:string;status:'checked'|'error';outcome:ScanReport['outcome']|'error';sourceHash:string|null;
 sourceVersion:string|null;upstreamChanged:boolean|null;newFindings:number;newIssues:number;resolvedFindings:number;apiVersion:string;error?:string;
}
interface Seen {active:boolean;firstSeen:string;lastSeen:string}
interface WatchState {schemaVersion:1;lastSourceHash:string|null;lastSourceVersion:string|null;history:WatchRun[];findings:Record<string,Seen>;issues:Record<string,Seen>;snapshots:string[]}
export interface WatchResult {schemaVersion:1;run:WatchRun;newFindings:ScanFinding[];newIssues:ScanIssue[];report?:ScanReport}
export interface InitWatchOptions {state:string;repo:string;baseline:string;source:string;apiVersion:string;baselineLabel?:string}
export interface CheckWatchOptions {state:string;apiVersion?:string}
export type SourceFetcher=(url:string,options:RequestInit)=>Promise<Response>;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const HASH=/^[a-f0-9]{64}$/;
function object(value:unknown,label:string):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`Invalid ${label}.`);return value as Record<string,unknown>;}
function text(value:unknown,label:string):string {if(typeof value!=='string'||!value||value.length>4096)throw new Error(`Invalid ${label}.`);return value;}
function apiVersion(value:unknown):string {
 const v=text(value,'API version');if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)throw new Error('Invalid API version; use verified YYYY-MM-DD.');return v;
}
function digest(value:unknown):string {const v=text(value,'snapshot hash');if(!HASH.test(v))throw new Error('Invalid snapshot hash.');return v;}
function timestamp(value:unknown):string {const v=text(value,'timestamp');if(!Number.isFinite(Date.parse(v)))throw new Error('Invalid timestamp.');return v;}
function count(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new Error('Invalid state count.');return value;}
export function validateSource(value:string):WatchSource {
 if(/^[a-zA-Z][\w+.-]*:/.test(value)) {
  let url:URL;try{url=new URL(value);}catch{throw new Error('Invalid public source URL.');}
  if(url.protocol!=='https:'||url.hostname!=='raw.githubusercontent.com'||url.username||url.password||url.port||url.search||url.hash||!/^\/github\/rest-api-description\/(main|[a-f0-9]{40})\/descriptions\/api\.github\.com\/api\.github\.com\.json$/.test(url.pathname))throw new Error('Source is not an allowed public GitHub REST snapshot URL (no credentials, private hosts or arbitrary paths).');
  return {kind:'public',value:url.href};
 }
 if(!value.trim())throw new Error('Source path is required.');return {kind:'local',value:resolve(value)};
}
async function readBounded(path:string,max:number):Promise<string> {
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const info=await file.stat();if(!info.isFile())throw new Error('Expected a regular file.');if(info.size>max)throw new Error('File size limit exceeded.');
  const parts:Buffer[]=[];let size=0;
  while(true){const buffer=Buffer.alloc(Math.min(65536,max-size+1));const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;size+=bytesRead;if(size>max)throw new Error('File size limit exceeded.');parts.push(buffer.subarray(0,bytesRead));}
  return Buffer.concat(parts).toString('utf8');
 }finally{await file.close();}
}
export async function fetchSnapshot(source:WatchSource,fetcher:SourceFetcher=globalThis.fetch,deadlineMs=20000):Promise<{text:string;hash:string;version:string;fetchedAt:string}> {
 const checked=validateSource(source.value);if(checked.kind!==source.kind)throw new Error('Invalid source kind.');
 if(checked.kind==='local') {const content=await readBounded(checked.value,MAX_SPEC);return {text:content,hash:sha(content),version:loadSpec(content).version,fetchedAt:new Date().toISOString()};}
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 const operation=async()=>{
  let response:Response;
  try{response=await fetcher(checked.value,{method:'GET',credentials:'omit',redirect:'error',signal:controller.signal,headers:{accept:'application/json'}});}catch{throw new Error('Public source fetch failed (network, redirect or abort).');}
  if(!response.ok)throw new Error(`Public source returned HTTP ${response.status}.`);
  if(response.redirected)throw new Error('Source redirect rejected.');
  const length=response.headers.get('content-length');if(length&&Number(length)>MAX_SPEC) {void response.body?.cancel();throw new Error('Source size limit exceeded.');}
  if(!response.body)throw new Error('Source response body is empty.');
  const reader=response.body.getReader();const parts:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_SPEC)throw new Error('Source streaming size limit exceeded.');parts.push(value);}}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
  const content=Buffer.concat(parts).toString('utf8');return {text:content,hash:sha(content),version:loadSpec(content).version,fetchedAt:new Date().toISOString()};
 };
 try{return await Promise.race([operation(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Source fetch deadline exceeded.'));},deadlineMs);})]);}
 finally{if(timer)clearTimeout(timer);controller.abort();}
}
async function regularDirectory(path:string):Promise<void>{const s=await lstat(path);if(s.isSymbolicLink())throw new Error('State symlink is not allowed.');if(!s.isDirectory())throw new Error('State path must be a directory.');}
async function rejectLink(path:string):Promise<void>{try{if((await lstat(path)).isSymbolicLink())throw new Error('State file symlink is not allowed.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
async function atomicJson(path:string,value:unknown):Promise<void>{await rejectLink(path);const tmp=`${path}.${randomUUID()}.tmp`;const file=await open(tmp,'wx',0o600);try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}try{await rename(tmp,path);}finally{try{await unlink(tmp);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}}
async function saveSnapshot(dir:string,hash:string,content:string):Promise<void>{const path=join(dir,'snapshots',`${digest(hash)}.json`);try{const file=await open(path,'wx',0o600);try{await file.writeFile(content);}finally{await file.close();}}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(sha(await readBounded(path,MAX_SPEC))!==hash)throw new Error('Snapshot integrity failure.');}}
function parseJson(content:string,label:string):unknown {try{return JSON.parse(content);}catch{throw new Error(`Invalid ${label} JSON.`);}}
function parseConfig(value:unknown):WatchConfig {
 const c=object(value,'watch config');if(c.schemaVersion!==1)throw new Error('Invalid watch config version.');
 const source=object(c.source,'source'),validated=validateSource(text(source.value,'source'));if(validated.kind!==source.kind)throw new Error('Invalid source kind.');
 const repo=text(c.repo,'consumer repo');if(!repo.startsWith('/'))throw new Error('Invalid consumer repo path.');
 return {schemaVersion:1,repo,source:validated,apiVersion:apiVersion(c.apiVersion),baselineHash:digest(c.baselineHash),baselineLabel:text(c.baselineLabel,'baseline label'),createdAt:timestamp(c.createdAt)};
}
function parseCatalog(value:unknown):Record<string,Seen>{const entries=Object.entries(object(value,'state catalog'));if(entries.length>CATALOG_LIMIT)throw new Error('Invalid state catalog limit.');return Object.fromEntries(entries.map(([key,value])=>{digest(key);const v=object(value,'state catalog entry');if(typeof v.active!=='boolean')throw new Error('Invalid state catalog active flag.');return [key,{active:v.active,firstSeen:timestamp(v.firstSeen),lastSeen:timestamp(v.lastSeen)}];}));}
function parseRun(value:unknown):WatchRun {
 const r=object(value,'state history entry');if(r.status!=='checked'&&r.status!=='error')throw new Error('Invalid state run status.');if(!['confirmed','possible','no_detected','incomplete','error'].includes(String(r.outcome)))throw new Error('Invalid state outcome.');if(r.upstreamChanged!==null&&typeof r.upstreamChanged!=='boolean')throw new Error('Invalid upstream change flag.');
 return {id:text(r.id,'run id'),checkedAt:timestamp(r.checkedAt),status:r.status,outcome:r.outcome as WatchRun['outcome'],sourceHash:r.sourceHash===null?null:digest(r.sourceHash),sourceVersion:r.sourceVersion===null?null:typeof r.sourceVersion==='string'?r.sourceVersion:(()=>{throw new Error('Invalid source version.');})(),upstreamChanged:r.upstreamChanged,newFindings:count(r.newFindings),newIssues:count(r.newIssues),resolvedFindings:count(r.resolvedFindings),apiVersion:apiVersion(r.apiVersion),...(r.error===undefined?{}:{error:text(r.error,'state error')})};
}
function parseState(value:unknown):WatchState {
 const s=object(value,'state');if(s.schemaVersion!==1||!Array.isArray(s.history)||s.history.length>HISTORY_LIMIT||!Array.isArray(s.snapshots)||s.snapshots.length>4)throw new Error('Invalid state structure.');
 return {schemaVersion:1,lastSourceHash:s.lastSourceHash===null?null:digest(s.lastSourceHash),lastSourceVersion:s.lastSourceVersion===null?null:typeof s.lastSourceVersion==='string'?s.lastSourceVersion:(()=>{throw new Error('Invalid state source version.');})(),history:s.history.map(parseRun),findings:parseCatalog(s.findings),issues:parseCatalog(s.issues),snapshots:s.snapshots.map(digest)};
}
async function readWatch(dir:string):Promise<{config:WatchConfig;state:WatchState}>{await regularDirectory(dir);await regularDirectory(join(dir,'snapshots'));return {config:parseConfig(parseJson(await readBounded(join(dir,'config.json'),65536),'config')),state:parseState(parseJson(await readBounded(join(dir,'state.json'),MAX_STATE),'state'))};}
export async function initWatch(options:InitWatchOptions):Promise<WatchConfig> {
 const dir=resolve(options.state),repo=resolve(options.repo),source=validateSource(options.source),version=apiVersion(options.apiVersion);
 if(!(await lstat(repo)).isDirectory())throw new Error('Consumer repo must be a directory.');
 const baseline=await readBounded(resolve(options.baseline),MAX_SPEC);loadSpec(baseline);const hash=sha(baseline);
 await mkdir(dirname(dir),{recursive:true});await mkdir(dir,{mode:0o700});await mkdir(join(dir,'snapshots'),{mode:0o700});
 const config:WatchConfig={schemaVersion:1,repo,source,apiVersion:version,baselineHash:hash,baselineLabel:options.baselineLabel||options.baseline,createdAt:new Date().toISOString()};
 await saveSnapshot(dir,hash,baseline);await atomicJson(join(dir,'config.json'),config);await atomicJson(join(dir,'state.json'),{schemaVersion:1,lastSourceHash:null,lastSourceVersion:null,history:[],findings:{},issues:{},snapshots:[hash]});return config;
}
function reconcile<T>(catalog:Record<string,Seen>,values:T[],key:(v:T)=>string,at:string,allowResolve=true):{newValues:T[];resolved:number} {
 const active=new Set<string>();const newValues:T[]=[];
 for(const value of values){const id=key(value);active.add(id);const previous=catalog[id];if(!previous||!previous.active)newValues.push(value);catalog[id]={active:true,firstSeen:previous?.firstSeen||at,lastSeen:at};}
 let resolved=0;for(const [id,value] of Object.entries(catalog))if(allowResolve&&value.active&&!active.has(id)){value.active=false;resolved++;}
 const keys=Object.keys(catalog).sort((a,b)=>catalog[b].lastSeen.localeCompare(catalog[a].lastSeen));for(const id of keys.slice(CATALOG_LIMIT))delete catalog[id];return {newValues,resolved};
}
const findingKey=(f:ScanFinding)=>sha(JSON.stringify({path:f.path,operation:f.operation,impact:f.impact,changes:[...f.changes].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))}));
const issueKey=(i:ScanIssue)=>sha(JSON.stringify({path:i.path||null,reason:i.reason}));
export async function checkWatch(options:CheckWatchOptions,fetcher?:SourceFetcher):Promise<WatchResult> {
 const dir=resolve(options.state);await regularDirectory(dir);try{await mkdir(join(dir,'.lock'),{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Watch is busy or has a stale lock; inspect .lock before removing it.');throw e;}
 try {
  const {config,state}=await readWatch(dir);if(options.apiVersion&&apiVersion(options.apiVersion)!==config.apiVersion)throw new Error('API version differs from saved watch; initialize a separate baseline/watch.');
  const run:WatchRun={id:randomUUID(),checkedAt:new Date().toISOString(),status:'error',outcome:'error',sourceHash:null,sourceVersion:null,upstreamChanged:null,newFindings:0,newIssues:0,resolvedFindings:0,apiVersion:config.apiVersion};
  let nextState=structuredClone(state);
  let targetTmp:string|undefined;
  let report:ScanReport|undefined,newFindings:ScanFinding[]=[],newIssues:ScanIssue[]=[];
  try {
   const baselinePath=join(dir,'snapshots',`${config.baselineHash}.json`);if(sha(await readBounded(baselinePath,MAX_SPEC))!==config.baselineHash)throw new Error('Baseline snapshot integrity failure.');
   const snapshot=await fetchSnapshot(config.source,fetcher);const declared=object(loadSpec(snapshot.text).raw,'source spec')['x-github-api-version'];if(declared!==undefined&&declared!==config.apiVersion)throw new Error('Declared source API version differs from saved consumer version.');
   targetTmp=join(dir,`${randomUUID()}.target.tmp`);const temp=await open(targetTmp,'wx',0o600);try{await temp.writeFile(snapshot.text);}finally{await temp.close();}
   report=await scanDirectory({repo:config.repo,baseline:baselinePath,target:targetTmp,baselineLabel:config.baselineLabel,targetLabel:config.source.value,apiVersion:config.apiVersion,format:'json'});
   const complete=report.outcome!=='incomplete';
   const found=reconcile(nextState.findings,report.findings,findingKey,run.checkedAt,complete),issues=reconcile(nextState.issues,report.issues,issueKey,run.checkedAt); newFindings=found.newValues;newIssues=issues.newValues;
   Object.assign(run,{status:'checked',outcome:report.outcome,sourceHash:snapshot.hash,sourceVersion:snapshot.version,upstreamChanged:state.lastSourceHash!==snapshot.hash,newFindings:newFindings.length,newIssues:newIssues.length,resolvedFindings:found.resolved});
   nextState.lastSourceHash=snapshot.hash;nextState.lastSourceVersion=snapshot.version;
   const prior=state.snapshots;nextState.snapshots=[config.baselineHash,...[...new Set([...prior.filter(h=>h!==config.baselineHash),snapshot.hash].filter(h=>h!==config.baselineHash))].slice(-3)];
   await saveSnapshot(dir,snapshot.hash,snapshot.text);
   await atomicJson(join(dir,'report.json'),report);
  }catch(error){nextState=state;run.status='error';run.outcome='error';run.newFindings=0;run.newIssues=0;run.resolvedFindings=0;run.error=error instanceof Error?error.message:'Watch check failed.';report=undefined;newFindings=[];newIssues=[];}finally{if(targetTmp)await unlink(targetTmp);}
  nextState.history=[...state.history,run].slice(-HISTORY_LIMIT);await atomicJson(join(dir,'state.json'),nextState);
  for(const old of state.snapshots)if(!nextState.snapshots.includes(old)){const path=join(dir,'snapshots',`${old}.json`);await rejectLink(path);await unlink(path);}
  return {schemaVersion:1,run,newFindings,newIssues,...(report?{report}:{})};
 }finally{await rmdir(join(dir,'.lock'));}
}
export async function watchHistory(stateDir:string,limit=20):Promise<WatchRun[]>{if(!Number.isSafeInteger(limit)||limit<1||limit>HISTORY_LIMIT)throw new Error('History limit must be 1–200.');const {state}=await readWatch(resolve(stateDir));return state.history.slice(-limit).reverse();}
export function renderWatch(result:WatchResult,format:'terminal'|'markdown'|'json'):string {
 if(format==='json')return JSON.stringify(result,null,2)+'\n';const run=result.run;
 const lines=[`${format==='markdown'?'# ':''}Autoshim watch: ${run.status} / ${run.outcome}`,`Checked: ${run.checkedAt}`,`Upstream: ${run.sourceHash||'unknown'}; asserted API version: ${run.apiVersion}; info.version: ${run.sourceVersion??'unknown'} (not an inferred API version)`,`Upstream changed: ${run.upstreamChanged??'unknown'}; new findings: ${run.newFindings}; new coverage issues: ${run.newIssues}; resolved findings: ${run.resolvedFindings}`];
 if(run.error)lines.push(`Error: ${run.error}`);return lines.map(visibleText).join('\n')+'\n'+(result.report?'\n'+renderScan(result.report,format):'');
}
export function renderHistory(runs:WatchRun[],format:'terminal'|'markdown'|'json'):string {
 if(format==='json')return JSON.stringify({schemaVersion:1,runs},null,2)+'\n';return [`${format==='markdown'?'# ':''}Autoshim watch history`,...runs.map(r=>`- ${r.checkedAt}: ${r.status}/${r.outcome}; new findings ${r.newFindings}; hash ${r.sourceHash||'unknown'}${r.error?`; ${r.error}`:''}`)].map(visibleText).join('\n')+'\n';
}
