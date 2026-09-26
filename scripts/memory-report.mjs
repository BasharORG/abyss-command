import {createServer} from "node:http";
import {readFile,stat,mkdir,writeFile} from "node:fs/promises";
import {extname,join,normalize} from "node:path";
import {spawn} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";

const root=process.cwd(),dist=join(root,"dist"),duration=Number(process.env.MEMORY_DURATION_SECONDS??180),interval=Number(process.env.MEMORY_SAMPLE_SECONDS??15),warmup=Number(process.env.MEMORY_WARMUP_SECONDS??30),simulationSecondsPerSample=Number(process.env.MEMORY_SIM_SECONDS_PER_SAMPLE??30);
const reportPath=join(root,"reports","memory-long-run.json");
const chrome=process.env.CHROME_PATH??"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const mime={".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml",".json":"application/json"};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,"http://localhost"),relative=url.pathname==="/"?"index.html":url.pathname.slice(1),path=normalize(join(dist,relative));if(!path.startsWith(dist)){res.writeHead(403).end();return;}const info=await stat(path);const file=info.isDirectory()?join(path,"index.html"):path;res.setHeader("content-type",mime[extname(file)]??"application/octet-stream");res.end(await readFile(file));}catch{res.writeHead(404).end("Not found");}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const port=server.address().port,debugPort=port+1,profile=await mkdtemp(join(tmpdir(),"abyss-memory-"));
const child=spawn(chrome,["--headless=new",`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,"--no-first-run","--no-default-browser-check","--disable-background-timer-throttling","--disable-renderer-backgrounding","--enable-precise-memory-info","--enable-unsafe-swiftshader","--use-angle=swiftshader",`http://127.0.0.1:${port}/?auto=MEMORY-LONG-RUN:easy:balanced&speed=2&cam=tactical&memoryAudit=1`],{stdio:["ignore","ignore","pipe"]});
let chromeErrors="";child.stderr.on("data",chunk=>chromeErrors+=chunk);
let wsUrl;
for(let attempt=0;attempt<80&&!wsUrl;attempt++){try{const targets=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());wsUrl=targets.find(target=>target.type==="page")?.webSocketDebuggerUrl;}catch{}if(!wsUrl)await sleep(250);}
if(!wsUrl)throw new Error(`Chrome DevTools target unavailable. ${chromeErrors.slice(-500)}`);
const ws=new WebSocket(wsUrl);await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
let id=0;const pending=new Map();ws.addEventListener("message",event=>{const message=JSON.parse(event.data);if(message.id&&pending.has(message.id)){const {resolve,reject}=pending.get(message.id);pending.delete(message.id);message.error?reject(new Error(message.error.message)):resolve(message.result);}});
const command=(method,params={})=>new Promise((resolve,reject)=>{const commandId=++id;pending.set(commandId,{resolve,reject});ws.send(JSON.stringify({id:commandId,method,params}));});
await command("Runtime.enable");await command("Performance.enable");
for(let attempt=0;attempt<120;attempt++){const ready=await command("Runtime.evaluate",{expression:"typeof window.__abyssMemoryDiagnostics === 'function'",returnByValue:true});if(ready.result.value)break;if(attempt===119)throw new Error("Game diagnostics did not become ready");await sleep(250);}
const samples=[],started=Date.now();
while((Date.now()-started)/1000<=duration){await command("Runtime.evaluate",{expression:`window.__abyssMemoryAdvance(${simulationSecondsPerSample})`,returnByValue:true,awaitPromise:true});await command("HeapProfiler.collectGarbage");const metrics=await command("Performance.getMetrics");const values=Object.fromEntries(metrics.metrics.map(metric=>[metric.name,metric.value]));const evaluated=await command("Runtime.evaluate",{expression:"window.__abyssMemoryDiagnostics()",returnByValue:true});samples.push({wallSeconds:Number(((Date.now()-started)/1000).toFixed(1)),heapBytes:values.JSHeapUsedSize,documents:values.Documents,nodes:values.Nodes,listeners:values.JSEventListeners,...evaluated.result.value});if((Date.now()-started)/1000+interval>duration)break;await sleep(interval*1000);}
const measured=samples.filter(sample=>sample.wallSeconds>=warmup),first=measured[0],last=measured.at(-1);
const slope=(rows,key)=>{const meanX=rows.reduce((sum,row)=>sum+row.wallSeconds,0)/rows.length,meanY=rows.reduce((sum,row)=>sum+row[key],0)/rows.length;const denominator=rows.reduce((sum,row)=>sum+(row.wallSeconds-meanX)**2,0);return denominator?rows.reduce((sum,row)=>sum+(row.wallSeconds-meanX)*(row[key]-meanY),0)/denominator:0;};
const heapSlopeBytesPerMinute=slope(measured,"heapBytes")*60,heapGrowthBytes=last.heapBytes-first.heapBytes;
const resourceGrowth={domNodes:last.domNodes-first.domNodes,documents:last.documents-first.documents,listeners:last.listeners-first.listeners,geometries:last.renderer.geometries-first.renderer.geometries,textures:last.renderer.textures-first.renderer.textures,programs:last.renderer.programs-first.renderer.programs};
const thresholds={warmupSeconds:warmup,maxHeapSlopeBytesPerMinute:1024*1024,maxHeapGrowthBytes:12*1024*1024,maxDomNodeGrowth:25,maxRendererResourceGrowth:2};
const checks={heapSlope:heapSlopeBytesPerMinute<=thresholds.maxHeapSlopeBytesPerMinute,heapGrowth:heapGrowthBytes<=thresholds.maxHeapGrowthBytes,domNodes:resourceGrowth.domNodes<=thresholds.maxDomNodeGrowth,rendererResources:Math.max(resourceGrowth.geometries,resourceGrowth.textures,resourceGrowth.programs)<=thresholds.maxRendererResourceGrowth,boundedHistories:last.events<=80&&last.decisions<=40&&last.commandLog<=60&&last.networkMessages<=120&&last.logisticsEvents<=80};
const report={schemaVersion:1,generatedAt:new Date().toISOString(),scenario:"MEMORY-LONG-RUN / easy / balanced / tactical / accelerated simulation",browser:"Google Chrome headless (SwiftShader)",durationSeconds:Number(((Date.now()-started)/1000).toFixed(1)),sampleIntervalSeconds:interval,simulationSecondsPerSample,support:{forcedGarbageCollection:true,heapMetric:"Chrome DevTools Performance.JSHeapUsedSize"},thresholds,summary:{passed:Object.values(checks).every(Boolean),checks,heapStartBytes:first.heapBytes,heapEndBytes:last.heapBytes,heapGrowthBytes,heapSlopeBytesPerMinute,simulationSeconds:last.simulationSeconds,resourceGrowth},samples};
await mkdir(join(root,"reports"),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({report:reportPath,...report.summary},null,2));
ws.close();child.kill("SIGTERM");server.close();await rm(profile,{recursive:true,force:true});
if(!report.summary.passed)process.exitCode=1;
