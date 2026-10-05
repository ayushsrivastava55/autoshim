import {constants} from 'node:fs';
import {open,realpath,mkdir,writeFile,lstat} from 'node:fs/promises';
import {resolve,relative,dirname,basename,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {proposeSbom,SBOM_DEMO_SOURCE,compileOwnedSbomDemo,sbomHash,type SbomProposal} from '@autoshim/core';
export interface ProposalOptions {repo:string;file:string;out:string;downloadHost:string[]}
async function boundedRead(path:string,limit:number):Promise<string>{
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const stat=await file.stat();if(!stat.isFile()||stat.size>limit)throw new Error('Expected bounded regular file');const bytes=Buffer.alloc(limit+1);let size=0;while(size<bytes.length){const {bytesRead}=await file.read(bytes,size,bytes.length-size,null);if(!bytesRead)break;size+=bytesRead;}if(size>limit)throw new Error('Source size limit exceeded');return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size));}finally{await file.close();}
}
async function helperTemplate():Promise<string>{return boundedRead(fileURLToPath(new URL('../../core/src/sbom-runtime.ts',import.meta.url)),128*1024);}
async function persist(out:string,proposal:SbomProposal):Promise<void>{
 await mkdir(out,{mode:0o700});
 await writeFile(join(out,'proposal.json'),JSON.stringify(proposal.status==='proposed'?{...proposal,preview:undefined,helper:undefined,consumerPatch:undefined,patch:undefined}:proposal,null,2)+'\n',{mode:0o600,flag:'wx'});
 if(proposal.status==='unavailable')return;
 await writeFile(join(out,'proposal.patch'),proposal.patch,{mode:0o600,flag:'wx'});
 const preview=join(out,'preview');await mkdir(preview,{mode:0o700});
 for(const [file,source] of [[proposal.file,proposal.preview],[proposal.helperFile,proposal.helper]]){const path=join(preview,file!);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,source!,{mode:0o600,flag:'wx'});}
}
export async function createSbomProposal(options:ProposalOptions):Promise<SbomProposal>{
 if(! /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.ts$/.test(options.file)||options.file.split('/').some(part=>part==='..'||part==='.'))throw new Error('Unsafe source path');
 const root=await realpath(options.repo), path=join(root,options.file), out=join(await realpath(dirname(resolve(options.out))),basename(options.out));
 const outputRelative=relative(root,out);if(!outputRelative||(!outputRelative.startsWith('..'+sep)&&outputRelative!=='..'&&!outputRelative.startsWith(sep)))throw new Error('Proposal output must be outside consumer repository');
 const parent=await realpath(dirname(path)), parentRelative=relative(root,parent);if(parentRelative==='..'||parentRelative.startsWith('..'+sep))throw new Error('Source parent escapes repository');
 const helperPath=join(dirname(path),'autoshim-sbom.ts');
 try{await lstat(helperPath);throw new Error('Existing helper collision');}catch(error){if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;}
 const proposal=proposeSbom(await boundedRead(path,1024*1024),options.file,await helperTemplate(),options.downloadHost);
 await persist(out,proposal);return proposal;
}
const OWNED_TESTS = `import test from 'node:test';
import assert from 'node:assert/strict';
import {collectSbom} from './consumer.js';
import {fetchGithubSbom} from './autoshim-sbom.js';
const poll='https://api.github.com/repos/example/demo/dependency-graph/sbom/fetch-report/4bab1a7e-da63-4828-9488-44e0e01a7c1b';
const target='https://downloads.example.test/report.json?signature=fixture';
const spdx={SPDXID:'SPDXRef-DOCUMENT',spdxVersion:'SPDX-2.3',name:'example/demo',packages:[]};
const headers={'X-GitHub-Api-Version':'2026-03-10',authorization:'Bearer fixture-token'};
const config={approvedDownloadHosts:['downloads.example.test'],pollIntervalMs:0,maxPolls:2,timeoutMs:500};
const generated=()=>new Response(JSON.stringify({sbom_url:poll}),{status:201});
const ready=()=>new Response(null,{status:302,headers:{location:target}});
test('generated consumer: pending to ready, SPDX returned, auth isolated',async()=>{const original=globalThis.fetch,calls=[],responses=[generated(),new Response(null,{status:202}),ready(),new Response(JSON.stringify(spdx))];globalThis.fetch=async(url,options)=>{calls.push({url,options});const r=responses.shift();assert.ok(r);return r;};try{assert.deepEqual(await collectSbom('fixture-token'),spdx);assert.equal(calls.length,4);assert.equal(calls[0].url,'https://api.github.com/repos/example/demo/dependency-graph/sbom/generate-report');assert.equal(calls[0].options.headers.authorization,'Bearer fixture-token');assert.equal(calls[3].options.headers.authorization,undefined);assert.ok(calls.every(c=>c.options.credentials==='omit'&&c.options.redirect==='manual'));}finally{globalThis.fetch=original;}});
test('pending retries bounded',async()=>{let n=0;await assert.rejects(fetchGithubSbom('example','demo',headers,{...config,fetcher:async()=>++n===1?generated():new Response(null,{status:202})}),/poll limit/);assert.equal(n,3);});
test('unapproved download rejected without requesting it',async()=>{let n=0;await assert.rejects(fetchGithubSbom('example','demo',headers,{...config,fetcher:async()=>++n===1?generated():new Response(null,{status:302,headers:{location:'https://evil.example.test/a'}})}),/Unapproved/);assert.equal(n,2);});
test('deadline bounds hanging transport',async()=>{await assert.rejects(fetchGithubSbom('example','demo',headers,{...config,timeoutMs:20,fetcher:async()=>new Promise(()=>{})}),/deadline/);});
`;
export async function runSbomDemo(out:string):Promise<{status:'mock_validated'|'failed';exitCode:number}>{
 const helper=await helperTemplate();const proposal=proposeSbom(SBOM_DEMO_SOURCE,'consumer.ts',helper,['downloads.example.test']);
 if(proposal.status!=='proposed')throw new Error(proposal.reason);
 await persist(out,proposal);
 const compiled=compileOwnedSbomDemo(proposal), execution=join(out,'owned-validation');await mkdir(execution,{mode:0o700});
 for(const [file,text] of [['package.json','{"type":"module"}\n'],['consumer.js',compiled.consumer],['autoshim-sbom.js',compiled.helper],['validation.test.mjs',OWNED_TESTS]])await writeFile(join(execution,file!),text!,{mode:0o600,flag:'wx'});
 let stdout='',stderr='',exitCode=0;
 try{const result=await promisify(execFile)(process.execPath,['--test','--test-reporter=tap','validation.test.mjs'],{cwd:execution,env:{},timeout:10000,maxBuffer:128*1024});stdout=result.stdout;stderr=result.stderr;}
 catch(error){if(!(error instanceof Error))throw error;exitCode=1;stdout='stdout' in error?String(error.stdout):'';stderr='stderr' in error?String(error.stderr):error.message;}
 const status=exitCode===0?'mock_validated':'failed';
 await writeFile(join(out,'validation.json'),JSON.stringify({status,exitCode,scope:'owned fixture, mocked transport only; no real service integration',sourceSha256:proposal.sourceSha256,previewSha256:proposal.previewSha256,helperSha256:proposal.helperSha256,testSha256:sbomHash(OWNED_TESTS),stdout,stderr},null,2)+'\n',{flag:'wx',mode:0o600});
 return {status,exitCode};
}
