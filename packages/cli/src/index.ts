#!/usr/bin/env node
import {createSbomProposal,runSbomDemo,type ProposalOptions} from './proposal.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initWatch,checkWatch,watchHistory,renderWatch,renderHistory,type InitWatchOptions,type CheckWatchOptions } from './watch.js';
import { Command, Option } from 'commander';
import { scanOutput, type ScanOptions } from './scan-command.js';
const program=new Command().name('autoshim').description('Local, evidence-based GitHub REST compatibility scan').version('0.1.0');
program.command('scan')
  .description('Compare local OpenAPI snapshots with bounded TypeScript request usage; no network or code edits')
  .requiredOption('--repo <directory>','TypeScript consumer repository')
  .requiredOption('--baseline <file>','Local baseline GitHub REST OpenAPI snapshot')
  .requiredOption('--target <file>','Local target GitHub REST OpenAPI snapshot')
  .option('--baseline-label <label>','Verified baseline revision/date label (file hash is always recorded)')
  .option('--target-label <label>','Verified target revision/date label (file hash is always recorded)')
  .option('--api-version <YYYY-MM-DD>','Assert the consumer GitHub REST API version; omission marks coverage incomplete')
  .addOption(new Option('--format <format>','Report format').choices(['terminal','json','markdown']).default('terminal'))
  .action(async(options:ScanOptions)=>{
    try{const {report,output}=await scanOutput(options);process.stdout.write(output);process.exitCode=report.outcome==='incomplete'?2:report.findings.length?1:0;}
    catch(error){program.error(`Scan failed: ${error instanceof Error?error.message:'unknown failure'}`,{exitCode:2});}
  });
type Format='terminal'|'markdown'|'json';
const formatOption=()=>new Option('--format <format>','Output format').choices(['terminal','json','markdown']).default('terminal');
const watch=program.command('watch').description('Save a pinned local watch, check it on demand, and inspect history');
const fail=(error:unknown):never=>program.error(error instanceof Error?error.message:'Watch operation failed.',{exitCode:2});
watch.command('init').description('Create a new saved watch; existing state is never overwritten')
 .requiredOption('--state <directory>','New private watch-state directory')
 .requiredOption('--repo <directory>','TypeScript consumer repository')
 .requiredOption('--baseline <file>','Explicit local baseline snapshot')
 .requiredOption('--source <URL-or-file>','Allowlisted GitHub REST raw URL or explicit local fixture file')
 .requiredOption('--api-version <YYYY-MM-DD>','Verified consumer API version assertion')
 .option('--baseline-label <label>','Baseline source revision/date label')
 .addOption(formatOption()).action(async(options:InitWatchOptions&{format:Format})=>{
  try{const config=await initWatch(options);process.stdout.write(options.format==='json'?JSON.stringify(config,null,2)+'\n':`Saved watch in ${options.state}. Baseline stays pinned; checks do not run consumer code.\n`);}catch(error){fail(error);}
 });
watch.command('check').description('Fetch upstream, rescan consumer, deduplicate evidence, and record one run')
 .requiredOption('--state <directory>','Saved watch-state directory')
 .option('--api-version <YYYY-MM-DD>','Optional guard: must match saved assertion')
 .addOption(formatOption()).action(async(options:CheckWatchOptions&{format:Format})=>{
  try{const result=await checkWatch(options);process.stdout.write(renderWatch(result,options.format));process.exitCode=result.run.status==='error'||result.run.outcome==='incomplete'?2:result.report?.findings.length?1:0;}catch(error){fail(error);}
 });
watch.command('history').description('Read bounded recent run history')
 .requiredOption('--state <directory>','Saved watch-state directory')
 .option('--limit <number>','Recent runs, 1–200','20').addOption(formatOption())
 .action(async(options:{state:string;limit:string;format:Format})=>{try{process.stdout.write(renderHistory(await watchHistory(options.state,Number(options.limit)),options.format));}catch(error){fail(error);}});
watch.command('demo').description('Create an offline fixture watch and check twice to demonstrate deduplication')
 .requiredOption('--state <directory>','New demo state directory (never overwritten)')
 .addOption(formatOption()).action(async(options:{state:string;format:Format})=>{
  try{const fixtures=fileURLToPath(new URL('../../../fixtures/scan/',import.meta.url));await initWatch({state:options.state,repo:join(fixtures,'positive'),baseline:join(fixtures,'baseline.json'),source:join(fixtures,'target.json'),apiVersion:'2022-11-28',baselineLabel:'synthetic demo baseline'});const a=await checkWatch({state:options.state}),b=await checkWatch({state:options.state});process.stdout.write(options.format==='json'?JSON.stringify({schemaVersion:1,checks:[a,b]},null,2)+'\n':renderWatch(a,options.format)+'\n'+renderWatch(b,options.format));process.exitCode=b.run.status==='error'||b.run.outcome==='incomplete'?2:b.report?.findings.length?1:0;}catch(error){fail(error);}
 });
const proposal=program.command('proposal').description('Generate a separate reviewable SBOM migration patch; never execute customer code');
proposal.command('sbom').requiredOption('--repo <directory>','Consumer repository').requiredOption('--file <relative.ts>','Single supported TypeScript file').requiredOption('--out <directory>','New output directory outside consumer repository').requiredOption('--download-host <host...>','Explicit reviewed exact download host allowlist').action(async(options:ProposalOptions)=>{try{const result=await createSbomProposal(options);process.stdout.write(JSON.stringify({status:result.status,validation:result.validation,out:options.out,...(result.status==='unavailable'?{reason:result.reason}:{})},null,2)+'\n');process.exitCode=result.status==='unavailable'?2:0;}catch(error){fail(error);}});
proposal.command('demo').requiredOption('--out <directory>','New isolated owned demo directory').action(async(options:{out:string})=>{try{const result=await runSbomDemo(options.out);process.stdout.write(JSON.stringify({...result,out:options.out,scope:'mock transport only'},null,2)+'\n');process.exitCode=result.exitCode;}catch(error){fail(error);}});
await program.parseAsync();
