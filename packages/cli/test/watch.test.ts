import { describe,it,expect } from 'vitest';
import { mkdtemp,writeFile,readFile,rm,mkdir,symlink,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWatch,checkWatch,watchHistory,validateSource,fetchSnapshot } from '../src/watch.js';
const spec=(removed:boolean)=>JSON.stringify({openapi:'3.0.0',info:{title:'GitHub fixture',version:'fixture'},paths:removed?{}:{'/user':{get:{responses:{'200':{description:'ok'}}}}}});
async function fixture(run:(root:string,state:string)=>Promise<void>) {
 const root=await mkdtemp(join(tmpdir(),'autoshim-watch-test-'));const state=join(root,'.autoshim','watch');
 try{await writeFile(join(root,'app.ts'),'fetch("https://api.github.com/user");');await writeFile(join(root,'baseline.json'),spec(false));await writeFile(join(root,'source.json'),spec(true));await run(root,state);}finally{await rm(root,{recursive:true,force:true});}
}
const opts=(root:string,state:string)=>({state,repo:root,baseline:join(root,'baseline.json'),source:join(root,'source.json'),apiVersion:'2022-11-28'});
describe('saved watch',()=>{
 it('persists a baseline and deduplicates repeated findings',async()=>fixture(async(root,state)=>{
  await initWatch(opts(root,state));const a=await checkWatch({state}),b=await checkWatch({state});
  expect(a.report?.outcome).toBe('confirmed');expect(a.run.newFindings).toBe(1);expect(b.run.newFindings).toBe(0);expect(b.report?.findings).toHaveLength(1);expect(b.run.upstreamChanged).toBe(false);expect((await watchHistory(state)).length).toBe(2);
 }));
 it('rescans consumer edits when upstream is unchanged',async()=>fixture(async(root,state)=>{
  await initWatch(opts(root,state));await checkWatch({state});await writeFile(join(root,'app.ts'),'const x=1;');const r=await checkWatch({state});expect(r.report?.outcome).toBe('no_detected');expect(r.run.resolvedFindings).toBe(1);
 }));
 it('retains incomplete status and deduplicates issues',async()=>fixture(async(root,state)=>{
  await writeFile(join(root,'app.ts'),'fetch(dynamicUrl);');await initWatch(opts(root,state));const a=await checkWatch({state}),b=await checkWatch({state});expect(a.report?.outcome).toBe('incomplete');expect(a.run.newIssues).toBeGreaterThan(0);expect(b.run.newIssues).toBe(0);expect(b.report?.outcome).toBe('incomplete');
 }));
 it('records failures without replacing last successful upstream hash',async()=>fixture(async(root,state)=>{
  await initWatch(opts(root,state));const a=await checkWatch({state});await writeFile(join(root,'source.json'),'broken');const b=await checkWatch({state});expect(b.run.status).toBe('error');expect(b.report).toBeUndefined();const data=JSON.parse(await readFile(join(state,'state.json'),'utf8'));expect(data.lastSourceHash).toBe(a.run.sourceHash);expect((await watchHistory(state))[0].status).toBe('error');
 }));
 it('rejects mismatch, corrupt state and existing watch initialization',async()=>fixture(async(root,state)=>{
  await initWatch(opts(root,state));await expect(initWatch(opts(root,state))).rejects.toThrow();await expect(checkWatch({state,apiVersion:'2099-01-01'})).rejects.toThrow('version');await writeFile(join(state,'state.json'),'{}');await expect(checkWatch({state})).rejects.toThrow('state');
 }));
 it('rejects a symlinked state directory',async()=>fixture(async(root,state)=>{
  await initWatch(opts(root,state));const link=join(root,'linked');await symlink(state,link);await expect(checkWatch({state:link})).rejects.toThrow('symlink');
 }));
 it('locks concurrent checks without corrupting history',async()=>fixture(async(root,state)=>{
  await initWatch(opts(root,state));const r=await Promise.allSettled([checkWatch({state}),checkWatch({state})]);expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect((await watchHistory(state)).length).toBe(1);
 }));
 it('does not resolve active findings when analysis becomes incomplete',async()=>fixture(async(root,state)=>{await initWatch(opts(root,state));await checkWatch({state});await writeFile(join(root,'app.ts'),'fetch(dynamicUrl);');const r=await checkWatch({state});expect(r.run.resolvedFindings).toBe(0);expect(r.report?.outcome).toBe('incomplete');}));
 it('rejects declared source API-version mismatches and unsafe tampered config',async()=>fixture(async(root,state)=>{await initWatch(opts(root,state));const source=JSON.parse(spec(true));source['x-github-api-version']='2099-01-01';await writeFile(join(root,'source.json'),JSON.stringify(source));expect((await checkWatch({state})).run.status).toBe('error');const c=JSON.parse(await readFile(join(state,'config.json'),'utf8'));c.source={kind:'public',value:'http://127.0.0.1/a'};await writeFile(join(state,'config.json'),JSON.stringify(c));await expect(checkWatch({state})).rejects.toThrow('allowed');}));
 it('reopens an issue after a proven complete resolution',async()=>fixture(async(root,state)=>{await initWatch(opts(root,state));await checkWatch({state});await writeFile(join(root,'app.ts'),'const x=1;');expect((await checkWatch({state})).run.resolvedFindings).toBe(1);await writeFile(join(root,'app.ts'),'fetch("https://api.github.com/user");');expect((await checkWatch({state})).run.newFindings).toBe(1);}));

 it('bounds history and retained snapshots',async()=>fixture(async(root,state)=>{await initWatch(opts(root,state));const first=await checkWatch({state});const saved=JSON.parse(await readFile(join(state,'state.json'),'utf8'));saved.history=Array.from({length:200},(_,i)=>({...first.run,id:String(i)}));await writeFile(join(state,'state.json'),JSON.stringify(saved));for(let i=0;i<4;i++){const source=JSON.parse(spec(true));source.info.version=String(i);await writeFile(join(root,'source.json'),JSON.stringify(source));await checkWatch({state});}expect((await watchHistory(state,200))).toHaveLength(200);expect((await readdir(join(state,'snapshots'))).length).toBeLessThanOrEqual(4);}));
 it('rejects symlinked state files and detects baseline tampering',async()=>fixture(async(root,state)=>{await initWatch(opts(root,state));const c=JSON.parse(await readFile(join(state,'config.json'),'utf8'));await writeFile(join(state,'snapshots',c.baselineHash+'.json'),spec(true));expect((await checkWatch({state})).run.error).toContain('integrity');await rm(join(state,'state.json'));await symlink(join(root,'baseline.json'),join(state,'state.json'));await expect(checkWatch({state})).rejects.toThrow();}));

});
describe('public source boundary',()=>{
 const good='https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json';
 it('accepts the exact public source and explicit local paths',()=>{expect(validateSource(good).kind).toBe('public');expect(validateSource('/tmp/fixture.json').kind).toBe('local');});
 it('rejects private networks, credentials, redirects, arbitrary hosts and paths before fetching',async()=>{
  for(const url of ['http://127.0.0.1/a','https://169.254.169.254/latest/meta-data','https://user:pass@raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json','https://raw.githubusercontent.com.evil.test/a','https://raw.githubusercontent.com/other/private/main/a','https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json?token=secret'])expect(()=>validateSource(url)).toThrow();
  await expect(fetchSnapshot(validateSource(good),async()=>new Response('',{status:302}))).rejects.toThrow();
 });
 it('reads bounded bodies and rejects invalid/oversized replies and timeout',async()=>{
  const source=validateSource(good);const goodReply=await fetchSnapshot(source,async()=>new Response(spec(false)));expect(goodReply.text).toBe(spec(false));
  await expect(fetchSnapshot(source,async()=>new Response('bad'))).rejects.toThrow();
  await expect(fetchSnapshot(source,async()=>new Response('x',{headers:{'content-length':'20000000'}}))).rejects.toThrow('limit');
  await expect(fetchSnapshot(source,async()=>new Promise(()=>{}),20)).rejects.toThrow('deadline');
 });
 it('rejects unsafe sources without calling injected fetch and never supplies credentials',async()=>{let called=0;await expect(fetchSnapshot({kind:'public',value:'http://127.0.0.1/a'},async()=>{called++;return new Response(spec(false));})).rejects.toThrow();expect(called).toBe(0);await fetchSnapshot(validateSource(good),async(_url,options)=>{expect(options.credentials).toBe('omit');expect(options.redirect).toBe('error');expect(options.headers).toEqual({accept:'application/json'});return new Response(spec(false));});});
 it('enforces the streaming byte limit even without Content-Length',async()=>{await expect(fetchSnapshot(validateSource(good),async()=>new Response(new Uint8Array(15*1024*1024+1)))).rejects.toThrow('streaming size limit');});

});
