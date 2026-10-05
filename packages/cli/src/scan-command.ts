import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, relative, join, basename } from 'node:path';
import { scanGithub, renderScan, type ScanFile, type ScanIssue, type ScanReport } from '@autoshim/core';
const SKIP = new Set(['node_modules','.git','.next','.autoshim','.venv','venv','dist','build','vendor','coverage','__pycache__','.turbo']);
const MAX_FILES=2000, MAX_BYTES=1024*1024, MAX_TOTAL_BYTES=20*1024*1024, MAX_ENTRIES=20000;
export interface ScanOptions {repo:string;baseline:string;target:string;baselineLabel?:string;targetLabel?:string;apiVersion?:string;format:'terminal'|'markdown'|'json'}
export async function scanDirectory(options: ScanOptions): Promise<ScanReport> {
  const root=resolve(options.repo);
  if (!(await stat(root)).isDirectory()) throw new Error('Consumer repo must be a directory.');
  const readSnapshot=async(path:string)=>{if((await stat(path)).size>15*1024*1024)throw new Error('Spec snapshot exceeds 15 MiB limit.');return readFile(path,'utf8');};
  const baselinePath=resolve(options.baseline),targetPath=resolve(options.target);
  const [baseline,target]=await Promise.all([readSnapshot(baselinePath),readSnapshot(targetPath)]);
  if(options.apiVersion && (!/^\d{4}-\d{2}-\d{2}$/.test(options.apiVersion)||!Number.isFinite(Date.parse(options.apiVersion))||new Date(options.apiVersion).toISOString().slice(0,10)!==options.apiVersion)) throw new Error('API version must be an explicitly verified YYYY-MM-DD GitHub REST version.');
  const files: ScanFile[]=[], issues: ScanIssue[]=[], dependencies=new Set<string>();
  let totalBytes=0,entriesSeen=0, stopped=false;
  async function visit(dir:string,depth:number):Promise<void> {
    if(stopped)return;
    if(depth>30){issues.push({path:relative(root,dir),reason:'Directory depth limit reached.'});return;}
    let entries;
    try{entries=await readdir(dir,{withFileTypes:true});}catch{issues.push({path:relative(root,dir)||'.',reason:'Directory could not be read.'});return;}
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      if(++entriesSeen>MAX_ENTRIES){issues.push({reason:'Directory entry limit reached (20000).'});stopped=true;return;}
      const full=join(dir,entry.name),path=relative(root,full).split('\\').join('/');
      if(entry.isSymbolicLink()){issues.push({path,reason:'Symlink skipped; source outside traversal is not analyzed.'});continue;}
      if(entry.isDirectory()){if(!SKIP.has(entry.name)&&!entry.name.startsWith('.'))await visit(full,depth+1);if(stopped)return;continue;}
      if(!entry.isFile())continue;
      const source=/\.(ts|tsx|mts|cts)$/.test(entry.name)&&!entry.name.endsWith('.d.ts');
      const manifest=entry.name==='package.json';
      if(!source&&!manifest){if(/\.(js|jsx|mjs|cjs)$/.test(entry.name))issues.push({path,reason:'JavaScript source is outside TypeScript-only coverage.'});continue;}
      try {
        const size=(await stat(full)).size;
        if(size>MAX_BYTES){issues.push({path,reason:'File exceeds 1 MiB limit.'});continue;}
        if(totalBytes+size>MAX_TOTAL_BYTES||files.length>=MAX_FILES){issues.push({reason:'Source scan limit reached (2000 files / 20 MiB).'});stopped=true;return;}
        totalBytes+=size;
        const content=await readFile(full,'utf8');
        if(manifest){
          const parsed:unknown=JSON.parse(content);
          if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('invalid manifest');
          for(const section of ['dependencies','devDependencies','peerDependencies','optionalDependencies']) {
            const deps=(parsed as Record<string,unknown>)[section];
            if(deps&&typeof deps==='object'&&!Array.isArray(deps))for(const name of Object.keys(deps))if(name.startsWith('@octokit/')||name==='octokit')dependencies.add(name);
          }
        }else files.push({path,content});
      }catch{issues.push({path,reason:manifest?'Manifest could not be read/parsed.':'Source could not be read.'});}
    }
  }
  await visit(root,0);
  if(!files.length)issues.push({reason:'No TypeScript consumer source files were analyzed.'});
  return scanGithub({baseline,target,baselineLabel:options.baselineLabel||basename(baselinePath),targetLabel:options.targetLabel||basename(targetPath),apiVersion:options.apiVersion,files,dependencies:[...dependencies],issues});
}
export async function scanOutput(options: ScanOptions): Promise<{report:ScanReport;output:string}> {
  const report=await scanDirectory(options);return {report,output:renderScan(report,options.format)};
}
