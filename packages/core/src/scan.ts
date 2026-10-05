import ts from 'typescript';
import { createHash } from 'node:crypto';
import { loadSpec, type NormalizedSpec } from './spec/load.js';
import { diffSpecs } from './spec/diff.js';
import { isBreakingRule } from './spec/classify.js';
import type { OperationChange } from './types.js';

export type ScanOutcome = 'confirmed' | 'possible' | 'no_detected' | 'incomplete';
export interface ScanFile { path: string; content: string }
export interface ScanIssue { path?: string; line?: number; reason: string }
export interface ScanFinding {
  path: string; line: number; column: number; operation: string;
  impact: 'confirmed' | 'possible'; changes: OperationChange[]; reason: string;
}
export interface ScanInput {
  baseline: string; target: string; baselineLabel: string; targetLabel: string;
  apiVersion?: string; files: ScanFile[]; dependencies: string[]; issues?: ScanIssue[];
}
export interface ScanReport {
  schemaVersion: 1; provider: 'github-rest'; outcome: ScanOutcome;
  baseline: { label: string; sha256: string }; target: { label: string; sha256: string };
  apiVersion: { value: string | null; provenance: 'user_asserted' | 'unknown' };
  dependencies: string[]; filesScanned: number; requestsRecognized: number;
  findings: ScanFinding[]; issues: ScanIssue[]; limitations: string[];
}
const LIMITATIONS = [
  'Results compare supplied snapshots, not a live API; labels and API version are user assertions.',
  'Confirmed means a directly matched operation is removed in these snapshots, conditional on execution and version applicability.',
  'Endpoint matches do not prove changed request/response fields are used; these findings are possible only.',
  'Only direct imported request/Octokit.request literal routes and global fetch absolute api.github.com literal URLs are supported.',
  'No wrapper tracing, SDK rest-method mapping, variable URL resolution, generated clients, JavaScript, or cross-file data flow.',
  'No detected means no impact found in supported patterns; it is not a guarantee of compatibility.'
];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const METHODS = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE) (\/[^\s]*)$/;
const literal = (n: ts.Node | undefined): string | undefined => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;
function walk(node: ts.Node, cb: (n: ts.Node) => void): void { cb(node); ts.forEachChild(node, child => { walk(child, cb); }); }
function member(n: ts.Expression): string[] | undefined {
  if (ts.isIdentifier(n)) return [n.text];
  if(n.kind===ts.SyntaxKind.ThisKeyword)return ['this'];
  if (ts.isPropertyAccessExpression(n)) { const root=member(n.expression); return root ? [...root,n.name.text] : undefined; }
  return undefined;
}
function property(n: ts.Expression | undefined, key: string): ts.Expression | undefined {
  if (!n || !ts.isObjectLiteralExpression(n)) return undefined;
  for (const p of n.properties) if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) ? p.name.text : literal(p.name)) === key) return p.initializer;
  return undefined;
}
function plainOptions(n: ts.Expression): boolean {
  if(!ts.isObjectLiteralExpression(n))return false;
  const names=new Set<string>();
  for(const p of n.properties) {
    if(!ts.isPropertyAssignment(p))return false;
    const key=ts.isIdentifier(p.name)?p.name.text:literal(p.name);
    if(key===undefined||names.has(key))return false;
    names.add(key);
  }
  return true;
}
function record(value: unknown): Record<string,unknown> {
  return value && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:{};
}
function specCoverage(spec: NormalizedSpec, label: string, issues: ScanIssue[]): void {
  const unsupported = new Set<string>();
  function visit(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key,v] of Object.entries(value)) {
      if (key === '$ref' && typeof v === 'string') {
        if (!v.startsWith('#/') || /~[01]/.test(v)) unsupported.add('external or escaped references');
        else {
          let current: unknown=spec.raw;
          for (const token of v.slice(2).split('/')) current=current && typeof current==='object' ? (current as Record<string,unknown>)[token] : undefined;
          if (current === undefined) unsupported.add('unresolved references');
        }
      }
      if (['oneOf','anyOf','not','if','then','else','unevaluatedProperties','minimum','maximum','exclusiveMinimum','exclusiveMaximum','minLength','maxLength','pattern','minItems','maxItems','uniqueItems','additionalProperties'].includes(key)) unsupported.add(`schema keyword ${key}`);
      if(key==='parameters' && Array.isArray(v) && v.some(p=>'$ref' in record(p)))unsupported.add('referenced parameters');
      if(key==='requestBody' && '$ref' in record(v))unsupported.add('referenced request body');
      if(key==='responses' && Object.values(record(v)).some(r=>'$ref' in record(r)))unsupported.add('referenced responses');
      visit(v);
    }
  }
  visit(spec.raw);
  if(Object.values(record(record(spec.raw).paths)).some(path=>'parameters' in record(path)))unsupported.add('path-level parameters');
  for (const reason of unsupported) issues.push({reason:`${label}: incomplete spec coverage (${reason}).`});
}
function errorResponses(op: unknown): string {
  if (!op || typeof op !== 'object') return '{}';
  const responses=(op as Record<string,unknown>).responses;
  if (!responses || typeof responses !== 'object') return '{}';
  return JSON.stringify(Object.fromEntries(Object.entries(responses).filter(([status]) => !/^2\d\d$/.test(status))));
}

export function scanGithub(input: ScanInput): ScanReport {
  const before=loadSpec(input.baseline), after=loadSpec(input.target);
  const issues: ScanIssue[]=[...(input.issues || [])];
  const findings: ScanFinding[]=[];
  if (!input.files.length) issues.push({reason:'No TypeScript source files were analyzed.'});
  if (!input.apiVersion) issues.push({reason:'API version applicability is unknown; pass --api-version only when verified for this consumer.'});
  specCoverage(before,'baseline',issues); specCoverage(after,'target',issues);
  const diff=diffSpecs(before,after);
  if (diff.securityChanged) issues.push({reason:'Security scheme changes cannot be mapped to consumer authentication usage.'});
  const changes=new Map<string,OperationChange[]>();
  for (const op of diff.specDiff.changedOperations) {
    const relevant=op.changes.filter(c => isBreakingRule(c.rule) || c.rule==='operation-deprecated');
    if (relevant.length) changes.set(`${op.method.toUpperCase()} ${op.path}`,relevant);
  }
  const operationBuckets=new Map<string,{key:string;pattern:RegExp;specificity:number}[]>();
  for (const [path,methods] of Object.entries(before.paths)) for (const method of Object.keys(methods)) {
    const pattern=path.split('/').map(part => /^\{[^{}]+\}$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('/');
    const segments=path.split('/').filter(Boolean);
    const bucketKey=`${method.toUpperCase()} ${segments.length}`;
    const bucket=operationBuckets.get(bucketKey)||[];
    bucket.push({key:`${method.toUpperCase()} ${path}`,pattern:new RegExp(`^${pattern}/?$`),specificity:segments.filter(p=>!/^\{[^{}]+\}$/.test(p)).length});
    operationBuckets.set(bucketKey,bucket);
    const oldOp=record(methods[method]),newOp=record(after.paths[path]?.[method]);
    if(Object.keys(newOp).length) {
      const oldBody=record(oldOp.requestBody),newBody=record(newOp.requestBody);
      if((oldOp.requestBody===undefined)!==(newOp.requestBody===undefined)||oldBody.required!==newBody.required)issues.push({reason:`${method.toUpperCase()} ${path}: request-body presence/requiredness changes are not analyzed.`});
      if(JSON.stringify(oldOp.security)!==JSON.stringify(newOp.security))issues.push({reason:`${method.toUpperCase()} ${path}: operation security changes are not analyzed.`});
      const oldParams=new Map((Array.isArray(oldOp.parameters)?oldOp.parameters:[]).map(p=>{const r=record(p);return [`${String(r.name)} ${String(r.in)}`,r] as const;}));
      for(const p of Array.isArray(newOp.parameters)?newOp.parameters:[]) {
        const next=record(p),prev=oldParams.get(`${String(next.name)} ${String(next.in)}`);
        if(prev&&next.required===true&&prev.required!==true)issues.push({reason:`${method.toUpperCase()} ${path}: existing parameter requiredness change is not analyzed.`});
      }
    }
    if (after.paths[path]?.[method] && errorResponses(methods[method])!==errorResponses(after.paths[path][method])) issues.push({reason:`${method.toUpperCase()} ${path}: non-2xx response changes are not analyzed.`});
  }
  let requestsRecognized=0;
  for (const file of [...input.files].sort((a,b)=>a.path.localeCompare(b.path))) {
    const handledUrls=new Set<number>();
    const source=ts.createSourceFile(file.path,file.content,ts.ScriptTarget.Latest,true,file.path.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
    const diagnostics=ts.transpileModule(file.content,{fileName:file.path,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).diagnostics || [];
    if (diagnostics.some(d=>d.category===ts.DiagnosticCategory.Error)) { issues.push({path:file.path,reason:'TypeScript syntax could not be analyzed.'}); continue; }
    const requestNames=new Set<string>(), constructors=new Set<string>(), instances=new Set<string>();
    const sdkModules=new Set(['@octokit/request','@octokit/rest','@octokit/core','octokit']);
    let hasSdkImport=false;
    walk(source,n=>{
      if (ts.isImportDeclaration(n) && sdkModules.has(literal(n.moduleSpecifier)||'')) {
        hasSdkImport=true;
        const bindings=n.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) for (const e of bindings.elements) {
          const imported=(e.propertyName || e.name).text;
          if (imported==='request'&&!n.importClause?.isTypeOnly&&!e.isTypeOnly) requestNames.add(e.name.text);
          if (imported==='Octokit'&&!n.importClause?.isTypeOnly&&!e.isTypeOnly) constructors.add(e.name.text);
        }
      }
    });
    const factories=new Map<string,ts.NewExpression>();
    function directNew(n:ts.Expression|undefined):ts.NewExpression|undefined {
      if(!n||!ts.isNewExpression(n)||!ts.isIdentifier(n.expression)||!constructors.has(n.expression.text)||(n.arguments?.length||0)>1)return undefined;
      const options=n.arguments?.[0];return !options||(plainOptions(options)&&!property(options,'baseUrl')&&!property(options,'request'))?n:undefined;
    }
    walk(source,n=>{
      if(ts.isFunctionDeclaration(n)&&n.parent===source&&n.name&&n.parameters.length===0&&n.body?.statements.length===1) {
        const statement=n.body.statements[0];if(ts.isReturnStatement(statement)) {const created=directNew(statement.expression);if(created)factories.set(n.name.text,created);}
      }
    });
    const creation=(n:ts.Expression|undefined)=>directNew(n)||(n&&ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&n.arguments.length===0?factories.get(n.expression.text):undefined);
    const classBindings=new Map<ts.ClassLikeDeclaration,Set<string>>(),badClassBindings=new Map<ts.ClassLikeDeclaration,Set<string>>();
    function enclosingClass(n:ts.Node):ts.ClassLikeDeclaration|undefined {
      for(let parent=n.parent;parent;parent=parent.parent) {
        if(ts.isFunctionDeclaration(parent)||ts.isFunctionExpression(parent))return undefined;
        if(ts.isMethodDeclaration(parent)&&(ts.getModifiers(parent)?.some(m=>m.kind===ts.SyntaxKind.StaticKeyword)||!ts.isClassLike(parent.parent)))return undefined;
        if(ts.isClassLike(parent))return parent;
      }return undefined;
    }
    function bindClass(klass:ts.ClassLikeDeclaration,name:string,valid:boolean):void {
      const map=valid?classBindings:badClassBindings;const names=map.get(klass)||new Set<string>();names.add(name);map.set(klass,names);
    }
    walk(source,n=>{
      if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&creation(n.initializer))instances.add(n.name.text);
      if(ts.isPropertyDeclaration(n)&&ts.isClassLike(n.parent)&&n.initializer&&!ts.getModifiers(n)?.some(m=>m.kind===ts.SyntaxKind.StaticKeyword)) {
        const name=ts.isIdentifier(n.name)?n.name.text:literal(n.name);if(name)bindClass(n.parent,name,!!creation(n.initializer));
      }
      if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(n.left)&&n.left.expression.kind===ts.SyntaxKind.ThisKeyword) {
        const klass=enclosingClass(n);if(!klass)return;let parent=n.parent;while(parent&&!ts.isConstructorDeclaration(parent)&&parent!==klass)parent=parent.parent;
        bindClass(klass,n.left.name.text,ts.isConstructorDeclaration(parent)&&!!creation(n.right));
      }
    });
    walk(source,n=>{
      if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(n.left)) {
        const chain=member(n.left),klass=enclosingClass(n);if(klass&&chain?.[0]==='this'&&chain.length>2)bindClass(klass,chain[1],false);
      }
    });
    for(const [klass,names] of badClassBindings)for(const name of names)classBindings.get(klass)?.delete(name);
    const pos=(n: ts.Node) => { const {line,character}=source.getLineAndCharacterOfPosition(n.getStart(source));return {path:file.path,line:line+1,column:character+1}; };
    // Reject shadowed bindings rather than attributing another function's calls to GitHub.
    const unsafe=new Set<string>();
    walk(source,n=>{
      if (ts.isImportDeclaration(n) && n.importClause) {
        if (n.importClause.name?.text==='fetch') unsafe.add('fetch');
        const b=n.importClause.namedBindings;
        if (b && ts.isNamedImports(b) && b.elements.some(e=>e.name.text==='fetch')) unsafe.add('fetch');
      }
    });
    walk(source,n=>{
      if ((ts.isParameter(n)||ts.isFunctionDeclaration(n)||ts.isVariableDeclaration(n)||ts.isBindingElement(n)||ts.isClassDeclaration(n)) && n.name && ts.isIdentifier(n.name)) {
        const name=n.name.text;
        const instanceDeclaration=ts.isVariableDeclaration(n)&&n.initializer&&ts.isNewExpression(n.initializer)&&ts.isIdentifier(n.initializer.expression)&&constructors.has(n.initializer.expression.text);
        if (requestNames.has(name)||constructors.has(name)||name==='fetch'||(factories.has(name)&&!ts.isFunctionDeclaration(n))||(instances.has(name)&&!instanceDeclaration&&!((ts.isVariableDeclaration(n))&&creation(n.initializer)))) unsafe.add(name);
      }
      if (ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.EqualsToken) {
        const root=ts.isIdentifier(n.left)?n.left.text:ts.isPropertyAccessExpression(n.left)?member(n.left)?.[0]:undefined;
        if(root&&(root==='fetch'||instances.has(root)||requestNames.has(root)))unsafe.add(root);
      }
    });
    for (const name of unsafe) issues.push({path:file.path,reason:`Shadowed or reassigned binding ${name} is unsupported.`});
    function checkVersion(options: ts.Expression | undefined, node: ts.Node): void {
      const headers=property(options,'headers');
      if(!headers)return;
      if(!plainOptions(headers)) {issues.push({...pos(node),reason:'Dynamic headers prevent API-version verification.'});return;}
      for(const p of (headers as ts.ObjectLiteralExpression).properties) if(ts.isPropertyAssignment(p)) {
        const key=ts.isIdentifier(p.name)?p.name.text:literal(p.name);
        if(key?.toLowerCase()==='x-github-api-version') {
          const value=literal(p.initializer);
          if(!value||!input.apiVersion||value!==input.apiVersion) issues.push({...pos(node),reason:'Explicit request API version is dynamic or differs from the asserted --api-version.'});
        }
      }
    }
    // Constructor defaults can override version behavior for every instance request.
    walk(source,n=>{if(ts.isNewExpression(n)&&ts.isIdentifier(n.expression)&&constructors.has(n.expression.text)) {
      const options=n.arguments?.[0];
      if(options&&(!plainOptions(options)||property(options,'baseUrl')||property(options,'request'))) {
        issues.push({...pos(n),reason:'Dynamic/custom Octokit transport defaults are unsupported.'});
        if(ts.isVariableDeclaration(n.parent)&&ts.isIdentifier(n.parent.name))unsafe.add(n.parent.name.text);
      }
      else checkVersion(options,n);
    }});
    let sdkCalls=0;
    walk(source,n=>{
      if (!ts.isCallExpression(n)) return;
      const chain=member(n.expression);
      const unresolvedRequest=ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='request'&&METHODS.test(literal(n.arguments[0])||'');
      if (!chain) {
        if(unresolvedRequest)issues.push({...pos(n),reason:'Unbound request receiver (class/factory/wrapper) cannot be traced to a supported GitHub transport.'});
        return;
      }
      const klass=enclosingClass(n);
      const classReceiver=chain[0]==='this'&&chain.length>=2&&klass!==undefined&&!!classBindings.get(klass)?.has(chain[1])&&!([...constructors,...factories.keys()].some(name=>unsafe.has(name)));
      const safeConstructor=[...constructors,...factories.keys()].every(name=>!unsafe.has(name));
      const sdk=(requestNames.has(chain[0]) && chain.length===1)||(instances.has(chain[0])&&safeConstructor)||classReceiver;
      const raw=chain.length===1&&chain[0]==='fetch'&&!unsafe.has('fetch');
      if (!sdk&&!raw) {
        if(unresolvedRequest)issues.push({...pos(n),reason:'Unbound request receiver (class/factory/wrapper) cannot be traced to a supported GitHub transport.'});
        return;
      }
      if(unsafe.has(chain[0]))return;
      if (sdk) sdkCalls++;
      let route: string | undefined;
      if (sdk) {
        if (!(chain.length===1&&requestNames.has(chain[0]))&&!(chain.length===2&&instances.has(chain[0])&&chain[1]==='request')&&!(classReceiver&&chain.length===3&&chain[2]==='request')) {issues.push({...pos(n),reason:'Octokit SDK method/wrapper is unsupported; use a direct literal request route.'});return;}
        const options=n.arguments[1];
        if(options&&(!plainOptions(options)||property(options,'url')||property(options,'method'))) {issues.push({...pos(n),reason:'SDK route overrides or dynamic options are unsupported.'});return;}
        checkVersion(options,n);
        route=literal(n.arguments[0]);
        if (!route || !METHODS.test(route)) {issues.push({...pos(n),reason:'Dynamic or non-METHOD Octokit request route is unsupported.'});return;}
      } else {
        const url=literal(n.arguments[0]);
        if (!url) {issues.push({...pos(n),reason:'Dynamic fetch URL cannot be assigned to a provider.'});return;}
        let parsed: URL;
        try {parsed=new URL(url);} catch {issues.push({...pos(n),reason:'Relative fetch URL/base URL cannot be resolved.'});return;}
        if (parsed.hostname!=='api.github.com') return;
        handledUrls.add(n.arguments[0].getStart(source));
        const options=n.arguments[1];
        if (options && (!plainOptions(options))) {issues.push({...pos(n),reason:'Dynamic fetch options/method are unsupported.'});return;}
        checkVersion(options,n);
        const methodNode=property(options,'method');
        const method=methodNode?literal(methodNode):'GET';
        if (!method) {issues.push({...pos(n),reason:'Dynamic fetch method is unsupported.'});return;}
        route=`${method.toUpperCase()} ${parsed.pathname}`;
      }
      const match=route.match(METHODS);
      if (!match) {issues.push({...pos(n),reason:'Unsupported request method/path.'});return;}
      requestsRecognized++;
      const path=match[2].length>1?match[2].replace(/\/$/,''):match[2];
      const bucket=operationBuckets.get(`${match[1]} ${path.split('/').filter(Boolean).length}`)||[];
      const matching=bucket.filter(op=>op.pattern.test(path));
      const exact=matching.filter(op=>op.key===`${match[1]} ${path}`);
      const best=Math.max(...matching.map(op=>op.specificity));
      const candidates=exact.length?exact:matching.filter(op=>op.specificity===best);
      if (candidates.length!==1) {issues.push({...pos(n),reason:candidates.length?'Ambiguous baseline operation match.':'Request is absent from supplied baseline; coverage is incomplete.'});return;}
      const key=candidates[0].key, relevant=changes.get(key);
      if (!relevant) return;
      const removed=relevant.some(c=>c.rule==='operation-removed');
      findings.push({...pos(n),operation:key,impact:removed?'confirmed':'possible',changes:relevant,reason:removed?'Direct call matches an operation removed between supplied snapshots; runtime execution/version applicability remain conditional.':'Call matches a changed operation; affected fields/values and runtime use are not proven.'});
    });
    walk(source,n=>{
      const value=literal(n);if(!value||handledUrls.has(n.getStart(source)))return;
      let github=false;try{github=new URL(value).hostname==='api.github.com';}catch{return;}
      if(github)issues.push({...pos(n),reason:'GitHub URL outside a supported direct call; wrapper/variable usage is not traced.'});
    });
    if (hasSdkImport && sdkCalls===0) issues.push({path:file.path,reason:'SDK import found without supported direct calls; aliases, wrappers or re-exports may hide usage.'});
  }
  if(input.dependencies.length && !requestsRecognized) issues.push({reason:'GitHub SDK dependency detected without recognized direct requests; hidden/generated usage is not analyzed.'});
  return {
    schemaVersion:1,provider:'github-rest',outcome:issues.length?'incomplete':findings.some(f=>f.impact==='confirmed')?'confirmed':findings.length?'possible':'no_detected',
    baseline:{label:input.baselineLabel,sha256:hash(input.baseline)},target:{label:input.targetLabel,sha256:hash(input.target)},
    apiVersion:{value:input.apiVersion || null,provenance:input.apiVersion?'user_asserted':'unknown'},
    dependencies:[...new Set(input.dependencies)].sort(),filesScanned:input.files.length,requestsRecognized,findings,issues,limitations:LIMITATIONS
  };
}
export function visibleText(value:string):string {return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));}
export function renderScan(report: ScanReport, format: 'terminal'|'markdown'|'json'): string {
  if (format==='json') return JSON.stringify(report,null,2)+'\n';
  const lines=[`${format==='markdown'?'# ':''}Autoshim GitHub REST scan: ${report.outcome}`,
    `Baseline: ${report.baseline.label} (sha256 ${report.baseline.sha256})`,
    `Target: ${report.target.label} (sha256 ${report.target.sha256})`,
    `API version: ${report.apiVersion.value || 'unknown'} (${report.apiVersion.provenance})`,
    `Files: ${report.filesScanned}; recognized requests: ${report.requestsRecognized}`,
    `Dependencies: ${report.dependencies.join(', ') || 'none detected'}`,''];
  for (const f of report.findings) lines.push(`- ${f.impact}: ${f.path}:${f.line}:${f.column} → ${f.operation}`,`  ${f.reason}`,`  Changes: ${f.changes.map(c=>`${c.rule || c.kind}${c.field?` (${c.field})`:''}`).join('; ')}`);
  if (!report.findings.length) lines.push('No impact detected in supported patterns.');
  if (report.issues.length) {lines.push('','Coverage issues:');for(const i of report.issues)lines.push(`- ${i.path?`${i.path}${i.line?`:${i.line}`:''}: `:''}${i.reason}`);}
  lines.push('','Limits:');for(const limit of report.limitations)lines.push(`- ${limit}`);
  return lines.map(visibleText).join('\n')+'\n';
}
