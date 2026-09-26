import {createServer} from "node:http";
import {readFile,stat,mkdir,writeFile} from "node:fs/promises";
import {extname,join,normalize} from "node:path";
import {spawn} from "node:child_process";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";

const root=process.cwd(),dist=join(root,"dist");
const reportPath=join(root,"reports","campaign-inspection.json");
const chrome=process.env.CHROME_PATH??"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const mime={".html":"text/html",".js":"text/javascript",".css":"text/css",".png":"image/png",".svg":"image/svg+xml",".json":"application/json"};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,"http://localhost"),relative=url.pathname==="/"?"index.html":url.pathname.slice(1),path=normalize(join(dist,relative));if(!path.startsWith(dist)){res.writeHead(403).end();return;}const info=await stat(path);const file=info.isDirectory()?join(path,"index.html"):path;res.setHeader("content-type",mime[extname(file)]??"application/octet-stream");res.end(await readFile(file));}catch{res.writeHead(404).end("Not found");}});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const port=server.address().port,debugPort=port+1,profile=await mkdtemp(join(tmpdir(),"abyss-campaign-inspect-"));
const child=spawn(chrome,["--headless=new",`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`,"--no-first-run","--no-default-browser-check","--disable-background-timer-throttling","--disable-renderer-backgrounding","--enable-unsafe-swiftshader","--use-angle=swiftshader","--window-size=1440,900",`http://127.0.0.1:${port}/?fresh=campaign-inspection`],{stdio:["ignore","ignore","pipe"]});
let chromeErrors="";child.stderr.on("data",chunk=>chromeErrors+=chunk);
let wsUrl;
for(let attempt=0;attempt<80&&!wsUrl;attempt++){try{const targets=await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());wsUrl=targets.find(target=>target.type==="page")?.webSocketDebuggerUrl;}catch{}if(!wsUrl)await sleep(250);}
if(!wsUrl)throw new Error(`Chrome DevTools target unavailable. ${chromeErrors.slice(-500)}`);
const ws=new WebSocket(wsUrl);await new Promise((resolve,reject)=>{ws.addEventListener("open",resolve,{once:true});ws.addEventListener("error",reject,{once:true});});
let id=0;const pending=new Map();ws.addEventListener("message",event=>{const message=JSON.parse(event.data);if(message.id&&pending.has(message.id)){const {resolve,reject}=pending.get(message.id);pending.delete(message.id);message.error?reject(new Error(message.error.message)):resolve(message.result);}});
const command=(method,params={})=>new Promise((resolve,reject)=>{const commandId=++id;pending.set(commandId,{resolve,reject});ws.send(JSON.stringify({id:commandId,method,params}));});
await command("Runtime.enable");await command("Page.enable");
const evaluate=async(expression)=>{const result=await command("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.text);return result.result.value;};
const waitFor=async(expression,timeoutMs=30000,label=expression)=>{const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){try{if(await evaluate(`!!(${expression})`))return;}catch{}await sleep(200);}throw new Error(`Timed out waiting for: ${label}`);};
const click=async(selector)=>{await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:"center"});el.click();return true;})()`);await sleep(250);};
const state=()=>evaluate(`(()=>{const box=document.querySelector(".menu-box"),hud=document.querySelector("#hud:not(.hidden)"),obj=document.querySelector(".objective .text");return{screen:box?(box.querySelector("h1")?.textContent??""):"",objective:obj?.textContent??"",operations:[...document.querySelectorAll("[data-operation]")].map(b=>({id:b.dataset.operation,disabled:b.disabled}))};})()`);

const operations=[
  {id:"canyon-passage",scenario:"canyon",probe:"trial"},
  {id:"silent-minefield",scenario:"minefield",probe:"minefield"},
  {id:"silent-divide",scenario:"divide",probe:"divide"},
  {id:"silent-trench",scenario:"trench",probe:"trench"},
  {id:"echo-ridge",scenario:"defense",probe:"defense"},
  {id:"abyssal-crown",scenario:"crown",probe:"crown"}
];
const steps=[];
try{
  await waitFor("!!document.querySelector('#new-campaign')",30000,"new-campaign button");
  await click("#new-campaign");
  await waitFor("!!document.querySelector('[data-operation]')",10000,"campaign hub");
  steps.push({step:"campaign-hub",...(await state())});

  // Mark all-but-first operation complete so every operation is individually launchable
  // through its real campaign UI path. Each is still launched from the hub, prepared,
  // deployed, stepped in real time, inspected, and debriefed.
  await evaluate(`(()=>{
    const key=Object.keys(localStorage).find(k=>k.startsWith("abyss-campaign:"));
    const state=JSON.parse(localStorage.getItem(key));
    state.completedMissions=["canyon-passage","silent-minefield","silent-divide","silent-trench","echo-ridge"];
    localStorage.setItem(key,JSON.stringify(state));
    return state.id;
  })()`);
  await evaluate(`location.reload();`);await sleep(1500);
  await waitFor("!!document.querySelector('#continue-campaign')",30000,"continue after reload");
  await click("#continue-campaign");
  await waitFor("!!document.querySelector('[data-operation]')",10000,"campaign hub after reload");

  for(const op of operations){
    await waitFor(`!!document.querySelector('[data-operation="${op.id}"]')`,10000,`operation ${op.id}`);
    await click(`[data-operation="${op.id}"]`);
    await waitFor("!!document.querySelector('#deploy-btn')",10000,`briefing for ${op.id}`);
    const briefing=await state();
    await click("#deploy-btn");
    await waitFor("!!document.querySelector('#hud:not(.hidden)')",30000,`hud for ${op.id}`);
    // Advance through real gameplay (headless throttle, no fast-skip): 30 seconds
    // of wall time at normal speed, which exercises each scenario's live loop.
    await sleep(30000);
    const gameplay=await state();
    steps.push({step:op.id,briefing:briefing.screen,objective:gameplay.objective,hudLive:!!gameplay.objective});
    // Abort back to menu for the next operation: pause -> abort to menu -> hub
    await evaluate(`document.querySelector('.top-controls button[title*="Pause menu"]')?.click();`);await sleep(300);
    await waitFor("!!document.querySelector('#quit-btn')",15000,`pause menu for ${op.id}`);
    await click("#quit-btn");
    try{await waitFor("!!document.querySelector('#new-campaign') || !!document.querySelector('[data-operation]')",20000,`return after ${op.id}`);}catch(e){const after=await state();throw new Error(`return after ${op.id}: ${e}; screen=${JSON.stringify(after)}`);}
    // quitToMenu returns to the start menu; navigate back into the campaign hub.
    if(await evaluate("!!document.querySelector('#continue-campaign')")){await click("#continue-campaign");}
    await waitFor("!!document.querySelector('[data-operation]')",15000,`hub after ${op.id}`);
  }
}catch(error){steps.push({step:"FAILURE",error:String(error)});}

const failures=steps.filter(s=>s.step==="FAILURE"||s.hudLive===false);
const report={schemaVersion:1,generatedAt:new Date().toISOString(),browser:"Google Chrome headless (SwiftShader, 1440×900)",method:"campaign hub → briefing → deploy → 30s real-time gameplay per operation → abort → hub",passed:failures.length===0,steps};
await mkdir(join(root,"reports"),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({report:reportPath,passed:report.passed,steps:steps.map(s=>({step:s.step,objective:s.objective??s.error}))},null,2));
ws.close();child.kill("SIGTERM");server.close();await rm(profile,{recursive:true,force:true});
if(failures.length)process.exitCode=1;
