import {describe,it,expect} from 'vitest';
import {applyPatch} from 'diff';
import ts from 'typescript';
import {proposeSbom,SBOM_DEMO_SOURCE} from '../src/sbom-proposal.js';
describe('bounded SBOM proposal',()=>{
 it('emits a separate patch and preserves headers and source evidence',()=>{const p=proposeSbom(SBOM_DEMO_SOURCE,'consumer.ts','export const helper = true;',['downloads.example.test']);expect(p.status).toBe('proposed');if(p.status!=='proposed')throw new Error(p.reason);expect(p.validation).toBe('not_run');expect(p.preview).toContain('autoshimGithubSbom');expect(p.preview).toContain('Bearer ${token}');expect(p.patch).toContain('/dev/null');expect(p.sourceSha256).toHaveLength(64);expect(applyPatch(SBOM_DEMO_SOURCE,p.consumerPatch)).toBe(p.preview);});
 it('rejects unsupported versions, dynamic URLs, response shapes and side effects',()=>{for(const source of [SBOM_DEMO_SOURCE.replace('2026-03-10','2022-11-28'),SBOM_DEMO_SOURCE.replace('"https://api.github.com/repos/example/demo/dependency-graph/sbom"','url'),SBOM_DEMO_SOURCE.replace('.sbom;',';'),SBOM_DEMO_SOURCE.replace('return (','console.log(response); return (')])expect(proposeSbom(source,'consumer.ts','helper',['downloads.example.test']).status).toBe('unavailable');});
 it('rejects fetch shadows, helper collisions, missing host approval and unsafe filenames',()=>{for(const [source,file,hosts] of [[`const fetch=custom;\n${SBOM_DEMO_SOURCE}`,'consumer.ts',['downloads.example.test']],[`const autoshimGithubSbom=1;\n${SBOM_DEMO_SOURCE}`,'consumer.ts',['downloads.example.test']],[SBOM_DEMO_SOURCE,'../consumer.ts',['downloads.example.test']],[SBOM_DEMO_SOURCE,'consumer.ts',[]]] as const)expect(proposeSbom(source,file,'helper',hosts).status).toBe('unavailable');});
 it('rejects SDK calls, complex functions and malformed source',()=>{for(const source of ['export const result=await octokit.request("GET /repos/{owner}/{repo}/dependency-graph/sbom");',SBOM_DEMO_SOURCE.replace('const response','const other=1; const response'),SBOM_DEMO_SOURCE+'\n{'])expect(proposeSbom(source,'consumer.ts','helper',['downloads.example.test']).status).toBe('unavailable');});
 it.each([
  ['LF', '\n', false], ['CRLF', '\r\n', false], ['CR', '\r', false],
  ['LF with blank line', '\n', true], ['CRLF with blank line', '\r\n', true], ['CR with blank line', '\r', true],
 ] as const)('preserves a leading shebang (%s) and emits a parseable patch',(_label,newline,blank)=>{
  const prefix='#!/usr/bin/env node'+newline;
  const source=prefix+(blank?newline:'')+SBOM_DEMO_SOURCE.replaceAll('\n',newline);
  const proposal=proposeSbom(source,'consumer.ts','export async function fetchGithubSbom() {}',['downloads.example.test']);
  expect(proposal.status).toBe('proposed');if(proposal.status!=='proposed')throw new Error(proposal.reason);
  expect(proposal.preview.startsWith(prefix+"import { fetchGithubSbom as autoshimGithubSbom } from './autoshim-sbom.js';\n")).toBe(true);
  expect(applyPatch(source,proposal.consumerPatch)).toBe(proposal.preview);
  const compiled=ts.transpileModule(proposal.preview,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},reportDiagnostics:true});
  expect(compiled.diagnostics?.filter(d=>d.category===ts.DiagnosticCategory.Error)).toEqual([]);
  expect(compiled.outputText.startsWith('#!/usr/bin/env node')).toBe(true);
 });
 it('leaves the import at the start when no shebang is present',()=>{
  const proposal=proposeSbom(SBOM_DEMO_SOURCE,'consumer.ts','helper',['downloads.example.test']);
  expect(proposal.status).toBe('proposed');if(proposal.status!=='proposed')throw new Error(proposal.reason);
  expect(proposal.preview.startsWith('import { fetchGithubSbom as autoshimGithubSbom }')).toBe(true);
 });

});
