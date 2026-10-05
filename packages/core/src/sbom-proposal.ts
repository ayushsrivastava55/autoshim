import ts from 'typescript';
import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {createTwoFilesPatch} from 'diff';
export const SBOM_DEMO_SOURCE = 'export async function collectSbom(token: string) {\n  const response = await fetch("https://api.github.com/repos/example/demo/dependency-graph/sbom", {headers: {accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", authorization: `Bearer ${token}`}});\n  return (await response.json()).sbom;\n}\n';
export const sbomHash=(text:string)=>createHash('sha256').update(text).digest('hex');
export type SbomProposal = {status:'unavailable';reason:string;validation:'not_run'} | {status:'proposed';validation:'not_run';sourceSha256:string;previewSha256:string;helperSha256:string;file:string;helperFile:string;line:number;preview:string;helper:string;consumerPatch:string;patch:string;evidence:readonly string[]};
/** Parse-only recipe: a single exported async two-statement raw-fetch function. */
export function proposeSbom(source:string,file:string,helper:string,hosts:readonly string[]):SbomProposal {
 const unavailable=(reason:string):SbomProposal=>({status:'unavailable',reason,validation:'not_run'});
 if(source.length>1024*1024||! /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.ts$/.test(file)||file.split('/').some(part=>part==='..'||part==='.')||file.endsWith('autoshim-sbom.ts'))return unavailable('Unsafe or oversized source path/content');
 if(!hosts.length||hosts.some(host=>! /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)||/^[\d.]+$/.test(host)||/(?:^|\.)(?:localhost|local|internal)$/.test(host)))return unavailable('Explicit reviewed download hosts required');
 const parsed=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const diagnostics=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},reportDiagnostics:true}).diagnostics??[];
 if(diagnostics.some(d=>d.category===ts.DiagnosticCategory.Error))return unavailable('Invalid TypeScript syntax');
 let collision=false,shadow=false;
 const visit=(node:ts.Node):void=>{if(ts.isIdentifier(node)&&node.text==='autoshimGithubSbom')collision=true;if(ts.isIdentifier(node)&&node.text==='fetch'&&!(ts.isCallExpression(node.parent)&&node.parent.expression===node))shadow=true;ts.forEachChild(node,visit);};visit(parsed);
 if(collision||shadow)return unavailable('Helper collision or ambiguous global fetch');
 const functions=parsed.statements.filter(ts.isFunctionDeclaration);
 if(functions.length!==1)return unavailable('Exactly one simple top-level function required');
 const fn=functions[0]!;
 if(!fn.body||fn.type||fn.typeParameters||!fn.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)||fn.body.statements.length!==2)return unavailable('Unsupported function shape');
 const [declaration,returned]=fn.body.statements;
 if(!declaration||!ts.isVariableStatement(declaration)||!(declaration.declarationList.flags&ts.NodeFlags.Const)||declaration.declarationList.declarations.length!==1||!returned||!ts.isReturnStatement(returned)||!returned.expression)return unavailable('Unsupported response handling');
 const variable=declaration.declarationList.declarations[0]!;
 if(!ts.isIdentifier(variable.name)||!variable.initializer||!ts.isAwaitExpression(variable.initializer)||!ts.isCallExpression(variable.initializer.expression))return unavailable('Expected awaited raw fetch');
 const call=variable.initializer.expression;
 if(!ts.isIdentifier(call.expression)||call.expression.text!=='fetch'||call.arguments.length!==2||!ts.isStringLiteral(call.arguments[0]!)||!ts.isObjectLiteralExpression(call.arguments[1]!))return unavailable('Expected literal GitHub fetch');
 const match=/^https:\/\/api\.github\.com\/repos\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/dependency-graph\/sbom$/.exec(call.arguments[0]!.text);
 if(!match||match[1]==='..'||match[2]==='..')return unavailable('Unsupported SBOM URL');
 const properties=call.arguments[1]!.properties;
 if(properties.length!==1||!ts.isPropertyAssignment(properties[0]!)||properties[0]!.name.getText(parsed)!=='headers'||!ts.isObjectLiteralExpression(properties[0]!.initializer))return unavailable('Only inline headers supported');
 const headerObject=properties[0]!.initializer;
 const names=new Set<string>();let version=false;
 for(const property of headerObject.properties){
  if(!ts.isPropertyAssignment(property)||! (ts.isIdentifier(property.name)||ts.isStringLiteral(property.name)))return unavailable('Unsupported header property');
  const name=property.name.text.toLowerCase();
  if(names.has(name)||!['accept','authorization','x-github-api-version','user-agent'].includes(name))return unavailable('Unsupported/duplicate header');names.add(name);
  if(name==='x-github-api-version'){if(!ts.isStringLiteral(property.initializer)||property.initializer.text!=='2026-03-10')return unavailable('Explicit 2026-03-10 version required');version=true;}
  else if(!ts.isStringLiteral(property.initializer)&&!ts.isNoSubstitutionTemplateLiteral(property.initializer)&&!(ts.isTemplateExpression(property.initializer)&&property.initializer.templateSpans.every(span=>ts.isIdentifier(span.expression)&&fn.parameters.some(p=>ts.isIdentifier(p.name)&&p.name.text===(span.expression as ts.Identifier).text))))return unavailable('Unsupported header expression');
 }
 if(!version)return unavailable('Explicit API version required');
 const result=returned.expression;
 if(!ts.isPropertyAccessExpression(result)||result.name.text!=='sbom'||!ts.isParenthesizedExpression(result.expression)||!ts.isAwaitExpression(result.expression.expression)||!ts.isCallExpression(result.expression.expression.expression))return unavailable('Expected returned SPDX envelope');
 const jsonCall=result.expression.expression.expression;
 if(jsonCall.arguments.length||!ts.isPropertyAccessExpression(jsonCall.expression)||jsonCall.expression.name.text!=='json'||!ts.isIdentifier(jsonCall.expression.expression)||jsonCall.expression.expression.text!==variable.name.text)return unavailable('Expected response.json().sbom');
 const body=`{\n  return await autoshimGithubSbom(${JSON.stringify(match[1])}, ${JSON.stringify(match[2])}, ${headerObject.getText(parsed)}, {approvedDownloadHosts: ${JSON.stringify(hosts)}});\n}`;
 const preview=`import { fetchGithubSbom as autoshimGithubSbom } from './autoshim-sbom.js';\n`+source.slice(0,fn.body.getStart(parsed))+body+source.slice(fn.body.end);
 const helperFile=posix.join(posix.dirname(file),'autoshim-sbom.ts');
 const consumerPatch=createTwoFilesPatch('a/'+file,'b/'+file,source,preview);
 return {status:'proposed',validation:'not_run',sourceSha256:sbomHash(source),previewSha256:sbomHash(preview),helperSha256:sbomHash(helper),file,helperFile,line:parsed.getLineAndCharacterOfPosition(call.getStart(parsed)).line+1,preview,helper,consumerPatch,patch:consumerPatch+createTwoFilesPatch('/dev/null','b/'+helperFile,'',helper),evidence:['https://docs.github.com/en/rest/dependency-graph/sboms?apiVersion=2026-03-10','https://github.blog/changelog/2026-05-12-synchronous-sbom-api-deprecated/']};
}
/** Compiles only the known owned demonstration; never runs customer source. */
export function compileOwnedSbomDemo(proposal:Extract<SbomProposal,{status:'proposed'}>):{consumer:string;helper:string} {
 if(proposal.sourceSha256!==sbomHash(SBOM_DEMO_SOURCE)||proposal.previewSha256!==sbomHash(proposal.preview)||proposal.helperSha256!==sbomHash(proposal.helper))throw new Error('Owned demo integrity check failed');
 const compile=(source:string)=>{const result=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},reportDiagnostics:true});if(result.diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error))throw new Error('Owned demo compilation failed');return result.outputText;};
 return {consumer:compile(proposal.preview),helper:compile(proposal.helper)};
}
