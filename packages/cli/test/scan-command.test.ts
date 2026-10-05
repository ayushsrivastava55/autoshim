import { describe,it,expect } from 'vitest';
import { mkdtemp,writeFile,mkdir,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDirectory } from '../src/scan-command.js';
async function fixture(code:string|undefined,run:(root:string)=>Promise<void>) {
 const root=await mkdtemp(join(tmpdir(),'autoshim-test-'));
 try {
  const spec={openapi:'3.0.0',paths:{'/user':{get:{responses:{'200':{description:'ok'}}}}}};
  await writeFile(join(root,'before.json'),JSON.stringify(spec));await writeFile(join(root,'after.json'),JSON.stringify(spec));
  if(code!==undefined)await writeFile(join(root,'app.ts'),code);
  await run(root);
 } finally {await rm(root,{recursive:true,force:true});}
}
const options=(root:string)=>({repo:root,baseline:join(root,'before.json'),target:join(root,'after.json'),apiVersion:'2022-11-28',format:'json' as const});
describe('bounded repo scan',()=>{
 it('reads source and dependency evidence while skipping node_modules',async()=>fixture('fetch("https://api.github.com/user")',async root=>{
  await writeFile(join(root,'package.json'),JSON.stringify({dependencies:{'@octokit/request':'1'}}));
  await mkdir(join(root,'node_modules'));await writeFile(join(root,'node_modules','hidden.ts'),'fetch(dynamicUrl)');
  const r=await scanDirectory(options(root));expect(r.outcome).toBe('no_detected');expect(r.dependencies).toEqual(['@octokit/request']);expect(r.filesScanned).toBe(1);
 }));
 it('does not treat empty repos as clean',async()=>fixture(undefined,async root=>expect((await scanDirectory(options(root))).outcome).toBe('incomplete')));
 it('reports malformed manifests and skipped symlinks',async()=>fixture('const x=1',async root=>{
  await writeFile(join(root,'package.json'),'{');await symlink(join(root,'app.ts'),join(root,'linked.ts'));
  const r=await scanDirectory(options(root));expect(r.outcome).toBe('incomplete');expect(r.issues.some(i=>i.reason.includes('Symlink'))).toBe(true);
 }));
 it('reports oversized sources and JavaScript coverage',async()=>fixture('const x=1',async root=>{
  await writeFile(join(root,'huge.ts'),' '.repeat(1024*1024+1));await writeFile(join(root,'app.js'),'fetch(url)');
  const r=await scanDirectory(options(root));expect(r.outcome).toBe('incomplete');expect(r.issues).toHaveLength(2);
 }));
 it('rejects missing snapshots and invalid API version arguments',async()=>fixture('const x=1',async root=>{
  await expect(scanDirectory({...options(root),baseline:join(root,'absent.json')})).rejects.toThrow();
  await expect(scanDirectory({...options(root),apiVersion:'2022-02-31'})).rejects.toThrow('YYYY-MM-DD');
 }));
});
