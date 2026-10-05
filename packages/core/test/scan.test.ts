import { describe, it, expect } from 'vitest';
import { scanGithub, renderScan } from '../src/scan.js';
const spec = (paths: object) => JSON.stringify({openapi:'3.0.0',info:{title:'GitHub fixture',version:'fixture'},paths});
const baseline=spec({'/repos/{owner}/{repo}':{get:{responses:{'200':{description:'ok'}}}},'/user':{get:{responses:{'200':{description:'ok'}}}}});
const target=spec({'/user':{get:{responses:{'200':{description:'ok'}}}}});
function run(code: string, apiVersion: string|null='2022-11-28', b=baseline,t=target) {
  return scanGithub({baseline:b,target:t,baselineLabel:'old-revision',targetLabel:'new-revision',apiVersion:apiVersion ?? undefined,files:[{path:'src/app.ts',content:code}],dependencies:['@octokit/request']});
}
const response=(properties:object)=>spec({'/user':{get:{responses:{'200':{content:{'application/json':{schema:{type:'object',properties}}}}}}}});
describe('local GitHub scan',()=>{
 it('confirms a removed operation with line evidence',()=>{
  const r=run('import {request as gh} from "@octokit/request";\ngh("GET /repos/{owner}/{repo}");');
  expect(r.outcome).toBe('confirmed');expect(r.findings[0]).toMatchObject({line:2,path:'src/app.ts',impact:'confirmed',operation:'GET /repos/{owner}/{repo}'});
 });
 it('reports no detected impact on an unchanged endpoint',()=>expect(run('fetch("https://api.github.com/user")').outcome).toBe('no_detected'));
 it('ignores comments and prose strings',()=>expect(run(`// fetch("https://api.github.com/repos/a/b")\nconst prose = 'gh("GET /repos/{owner}/{repo}")';`).findings).toHaveLength(0));
 it('matches concrete fetch URLs and rejects unrelated hosts',()=>{
  expect(run('fetch("https://api.github.com/repos/a/b?x=1")').findings).toHaveLength(1);
  expect(run('fetch("https://api.github.com.evil.test/repos/a/b")').findings).toHaveLength(0);
 });
 it('marks unknown API version incomplete',()=>expect(run('fetch("https://api.github.com/user")',null).outcome).toBe('incomplete'));
 it('marks dynamic SDK routes incomplete',()=>expect(run('import {request} from "@octokit/request";request(route);').outcome).toBe('incomplete'));
 it('marks syntax errors incomplete',()=>expect(run('const = ;').outcome).toBe('incomplete'));
 it('field changes are possible, never confirmed',()=>{
  const r=run('fetch("https://api.github.com/user")','2022-11-28',response({login:{type:'string'}}),response({}));
  expect(r.outcome).toBe('possible');expect(r.findings[0].impact).toBe('possible');
 });
 it('marks error-response changes incomplete',()=>{
  const b=spec({'/user':{get:{responses:{'404':{description:'old'}}}}});
  const t=spec({'/user':{get:{responses:{'404':{description:'new'}}}}});
  expect(run('fetch("https://api.github.com/user")','2022-11-28',b,t).outcome).toBe('incomplete');
 });
 it('supports aliased Octokit instance request and multiline calls',()=>expect(run('import {Octokit as Client} from "@octokit/rest";const client=new Client();\nclient.request(\n "GET /repos/{owner}/{repo}"\n);').findings).toHaveLength(1));
 it('marks SDK rest methods incomplete',()=>expect(run('import {Octokit} from "@octokit/rest";const gh=new Octokit();gh.rest.repos.get({owner:"a",repo:"b"});').outcome).toBe('incomplete'));
 it('rejects invalid specs',()=>expect(()=>run('','2022-11-28','not a spec')).toThrow());
 it('does not attribute shadowed imported names',()=>{
  const r=run('import {request} from "@octokit/request";function other(request:Function){request("GET /repos/{owner}/{repo}");}');
  expect(r.outcome).toBe('incomplete');expect(r.findings).toHaveLength(0);
 });
 it('marks empty, one and many files deterministically',()=>{
  const r=scanGithub({baseline,target,baselineLabel:'a',targetLabel:'b',apiVersion:'2022-11-28',files:[],dependencies:[]});
  expect(r.filesScanned).toBe(0);expect(r.findings).toHaveLength(0);
 });
 it('reports unknown baseline operations and dynamic fetch methods',()=>{
  expect(run('fetch("https://api.github.com/missing")').outcome).toBe('incomplete');
  expect(run('fetch("https://api.github.com/user", {method: verb})').outcome).toBe('incomplete');
 });
 it('marks unsupported spec references incomplete',()=>{
  const b=JSON.stringify({openapi:'3.0.0',paths:{'/user':{get:{responses:{'200':{$ref:'external.json#/Thing'}}}}}});
  expect(run('fetch("https://api.github.com/user")','2022-11-28',b,b).outcome).toBe('incomplete');
 });
 it('formats JSON and Markdown with evidence and scope',()=>{
  const r=run('fetch("https://api.github.com/repos/a/b")');
  expect(JSON.parse(renderScan(r,'json')).outcome).toBe('confirmed');
  expect(renderScan(r,'markdown')).toContain('src/app.ts:1:1');
  expect(renderScan(r,'terminal')).toContain('user_asserted');
 });
 it('marks explicit API header conflicts incomplete',()=>expect(run('fetch("https://api.github.com/user", {headers:{"X-GitHub-Api-Version":"2099-01-01"}})').outcome).toBe('incomplete'));
 it('does not confirm an overridable SDK route',()=>{const r=run('import {request} from "@octokit/request";request("GET /repos/{owner}/{repo}",{url:"/user"});');expect(r.outcome).toBe('incomplete');expect(r.findings).toHaveLength(0);});
 it('does not attribute imported fetch to the global transport',()=>{const r=run('import fetch from "./local";fetch("https://api.github.com/repos/a/b");');expect(r.outcome).toBe('incomplete');expect(r.findings).toHaveLength(0);});
 it('retains incomplete status for unrecognized API-bearing wrappers',()=>expect(run('const url="https://api.github.com/repos/a/b";myClient(url);').outcome).toBe('incomplete'));
 it('marks reassigned SDK methods incomplete',()=>{const r=run('import {request} from "@octokit/request";request=other;request("GET /repos/{owner}/{repo}");');expect(r.outcome).toBe('incomplete');expect(r.findings).toHaveLength(0);});

 it('detects destructured shadow bindings',()=>{const r=run('import {request} from "@octokit/request";function other({request}:{request:Function}){request("GET /repos/{owner}/{repo}");}');expect(r.outcome).toBe('incomplete');expect(r.findings).toHaveLength(0);});
 it('does not interpret type-only SDK imports as transports',()=>{const r=run('import type {request} from "@octokit/request";declare const request:Function;request("GET /repos/{owner}/{repo}");');expect(r.outcome).toBe('incomplete');expect(r.findings).toHaveLength(0);});

 it('recognizes the root operation',()=>{const b=spec({'/':{get:{responses:{'200':{description:'ok'}}}}});expect(run('fetch("https://api.github.com/")','2022-11-28',b,b).outcome).toBe('no_detected');});
 it('prefers exact static operations over overlapping template paths',()=>{const b=spec({'/repos/{owner}/{repo}':{get:{}},'/repos/example/demo':{get:{}}});const t=spec({'/repos/example/demo':{get:{}}});expect(run('fetch("https://api.github.com/repos/example/demo")','2022-11-28',b,t).findings).toHaveLength(0);});
 it('reports multiple unicode paths in deterministic order',()=>{const files=[{path:'z.ts',content:'fetch("https://api.github.com/repos/a/b")'},{path:'α.ts',content:'fetch("https://api.github.com/repos/c/d")'}];const r=scanGithub({baseline,target,baselineLabel:'a',targetLabel:'b',apiVersion:'2022-11-28',files,dependencies:[]});expect(r.findings).toHaveLength(2);expect(r.filesScanned).toBe(2);expect(r.findings.map(f=>f.path)).toEqual([...files].sort((a,b)=>a.path.localeCompare(b.path)).map(f=>f.path));});

 it('does not treat shorthand or computed fetch methods as GET',()=>{for(const opts of ['{method}','{["method"]:"POST"}','{method:"GET",method:"POST"}']){const r=run('fetch("https://api.github.com/repos/a/b",'+opts+')');expect(r.outcome).toBe('incomplete');expect(r.findings).toHaveLength(0);}});
 it('marks custom Octokit defaults incomplete without confirming transport',()=>{const r=run('import {Octokit} from "@octokit/rest";const gh=new Octokit({baseUrl:"https://example.com"});gh.request("GET /repos/{owner}/{repo}");');expect(r.outcome).toBe('incomplete');expect(r.findings).toHaveLength(0);});
 it('detects an unmodeled existing parameter requiredness change',()=>{const paths=(required:boolean)=>spec({'/user':{get:{parameters:[{name:'limit',in:'query',required,schema:{type:'integer'}}]}}});expect(run('fetch("https://api.github.com/user")','2022-11-28',paths(false),paths(true)).outcome).toBe('incomplete');});
 it('marks newly required request bodies incomplete',()=>{const paths=(required:boolean)=>spec({'/user':{post:{requestBody:{required,content:{'application/json':{schema:{type:'object',properties:{}}}}}}}});expect(run('fetch("https://api.github.com/user",{method:"POST"})','2022-11-28',paths(false),paths(true)).outcome).toBe('incomplete');});

 it('marks factory/class request receivers incomplete instead of clean',()=>{const r=scanGithub({baseline,target,baselineLabel:'a',targetLabel:'b',apiVersion:'2022-11-28',dependencies:[],files:[{path:'collector.ts',content:'class Collector { octokit=createOctokit(); collect(){return this.octokit.request("GET /repos/{owner}/{repo}/dependency-graph/sbom", {owner,repo});}}'}]});expect(r.outcome).toBe('incomplete');expect(r.issues.some(i=>i.reason.includes('Unbound request receiver'))).toBe(true);expect(r.findings).toHaveLength(0);});

 it('supports a same-file class field with imported constructor provenance',()=>{const r=run('import {Octokit} from "@octokit/rest";class Client { github=new Octokit(); run(){return this.github.request("GET /repos/{owner}/{repo}");}}');expect(r.findings).toHaveLength(1);expect(r.outcome).toBe('confirmed');});
 it('supports direct constructor assignment and a zero-argument local factory',()=>{for(const init of ['new Octokit()','makeClient()']){const r=run('import {Octokit} from "@octokit/rest";function makeClient(){return new Octokit();}class Client {github:Octokit;constructor(){this.github='+init+';}run(){return this.github.request("GET /repos/{owner}/{repo}");}}');expect(r.outcome).toBe('confirmed');}});
 it('does not trust reassigned class fields or external factories',()=>{const r=run('import {Octokit} from "@octokit/rest";class Client {github=new Octokit();swap(){this.github=other;}run(){return this.github.request("GET /repos/{owner}/{repo}");}}');expect(r.outcome).toBe('incomplete');expect(r.findings).toHaveLength(0);});

 it('rejects overridden class request methods',()=>{const r=run('import {Octokit} from "@octokit/rest";class Client {github=new Octokit();swap(){this.github.request=other;}run(){return this.github.request("GET /repos/{owner}/{repo}");}}');expect(r.outcome).toBe('incomplete');expect(r.findings).toHaveLength(0);});
 it('renders control characters visibly without changing JSON evidence',()=>{const r=scanGithub({baseline,target,baselineLabel:'a',targetLabel:'b',apiVersion:'2022-11-28',files:[{path:'evil\u001b[31m.ts',content:'fetch("https://api.github.com/repos/a/b")'}],dependencies:[]});expect(renderScan(r,'terminal')).not.toContain('\u001b');expect(JSON.parse(renderScan(r,'json')).findings[0].path).toContain('\u001b');});

});
