export interface SbomOptions {
  approvedDownloadHosts: readonly string[];
  fetcher?: (url: string, options: RequestInit) => Promise<Response>;
  pollIntervalMs?: number; maxPolls?: number; timeoutMs?: number;
}
/** Explicit 2026-03-10 recipe. Download hosts require caller review. */
export async function fetchGithubSbom(owner: string, repo: string, headers: Record<string,string>, options: SbomOptions): Promise<Record<string,unknown>> {
  const hostOK = (host: string) => /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) && !/^[\d.]+$/.test(host) && !/(?:^|\.)(?:localhost|local|internal)$/.test(host);
  if (![owner,repo].every(value => /^[a-zA-Z0-9_.-]+$/.test(value) && value !== '..' && value !== '.')) throw new Error('Invalid repository');
  if (!options.approvedDownloadHosts.length || options.approvedDownloadHosts.some(host => !hostOK(host))) throw new Error('Reviewed download hosts required');
  const apiHeaders: Record<string,string> = {};
  for (const [key,value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (!['accept','authorization','x-github-api-version','user-agent'].includes(name) || name in apiHeaders) throw new Error('Unsupported API headers');
    apiHeaders[name] = value;
  }
  if (apiHeaders['x-github-api-version'] !== '2026-03-10') throw new Error('Explicit API version 2026-03-10 required');
  const maxPolls=options.maxPolls??10, interval=options.pollIntervalMs??1000, timeout=options.timeoutMs??60000;
  if (!Number.isInteger(maxPolls)||maxPolls<1||maxPolls>100||!Number.isFinite(interval)||interval<0||interval>60000||!Number.isFinite(timeout)||timeout<1||timeout>120000) throw new Error('Invalid request bounds');
  const controller=new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('SBOM deadline exceeded'));},timeout);});
  const fetcher=options.fetcher??((url:string,init:RequestInit)=>globalThis.fetch(url,init));
  const request=async(url:string,requestHeaders:Record<string,string>)=>{
    try {return await Promise.race([fetcher(url,{method:'GET',headers:requestHeaders,redirect:'manual',credentials:'omit',signal:controller.signal}),deadline]);}
    catch {throw new Error(controller.signal.aborted?'SBOM deadline exceeded':'SBOM transport failed');}
  };
  const json=async(response:Response,limit:number):Promise<unknown>=>{
    const length=response.headers.get('content-length');
    if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))throw new Error('SBOM body limit exceeded');
    if(!response.body)throw new Error('Missing SBOM body');
    const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
    try{while(true){const next=await Promise.race([reader.read(),deadline]);if(next.done)break;size+=next.value.byteLength;if(size>limit){await Promise.race([reader.cancel(),deadline]);throw new Error('SBOM body limit exceeded');}chunks.push(next.value);}}catch(error){if(controller.signal.aborted)throw new Error('SBOM deadline exceeded');if(error instanceof Error&&error.message==='SBOM body limit exceeded')throw error;throw new Error('SBOM body read failed');}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;}catch{throw new Error('Invalid SBOM JSON');}
  };
  const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
  const parse=(value:string)=>{let url:URL;try{url=new URL(value);}catch{throw new Error('Invalid report URL');}if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)throw new Error('Unsafe report URL');return url;};
  try{
    const path=`/repos/${owner}/${repo}/dependency-graph/sbom`, base='https://api.github.com'+path;
    const generation=await request(base+'/generate-report',apiHeaders);
    if(generation.status!==201)throw new Error('SBOM generation failed');
    const payload=await json(generation,65536);
    if(!object(payload)||typeof payload.sbom_url!=='string')throw new Error('Missing report URL');
    const poll=parse(payload.sbom_url), prefix=path+'/fetch-report/';
    if(poll.hostname!=='api.github.com'||poll.search||!poll.pathname.startsWith(prefix)||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(poll.pathname.slice(prefix.length)))throw new Error('Unexpected polling URL');
    for(let attempt=0;attempt<maxPolls;attempt++){
      const response=await request(poll.href,apiHeaders);
      if(response.status===202){if(attempt+1<maxPolls){let delay:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([new Promise<void>(resolve=>{delay=setTimeout(resolve,interval);}),deadline]);}finally{if(delay!==undefined)clearTimeout(delay);}}continue;}
      if(response.status!==302)throw new Error('SBOM polling failed');
      const location=response.headers.get('location');if(!location)throw new Error('Missing download URL');
      const download=parse(location);if(!hostOK(download.hostname)||!options.approvedDownloadHosts.includes(download.hostname))throw new Error('Unapproved download host');
      const artifact=await request(download.href,{accept:'application/json'});if(artifact.status!==200)throw new Error('SBOM download failed');
      const document=await json(artifact,15*1024*1024);
      if(!object(document)||document.SPDXID!=='SPDXRef-DOCUMENT'||typeof document.spdxVersion!=='string'||!/^SPDX-2\.\d+$/.test(document.spdxVersion)||typeof document.name!=='string'||!Array.isArray(document.packages))throw new Error('Invalid SPDX document');
      return document;
    }
    throw new Error('SBOM poll limit exceeded');
  }finally{if(timer!==undefined)clearTimeout(timer);controller.abort();}
}
