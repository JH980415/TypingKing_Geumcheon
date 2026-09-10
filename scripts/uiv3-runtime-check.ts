import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {assessControlPresentation,assessLogoGeometry,assessProcessAbsence,compareStableBoxes,observedRuntimeFailures,ReadOnlyRecordOracle,runtimeVerdicts,utf8PowerShellJson,waitForCaptureLayout} from '../tests/utils/uiv3RuntimeAssertions';
import https from 'node:https';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {chromium, type Browser, type Page} from 'playwright-core';
import {buildNasApp} from '../services/nas-record-api/src/app';
import {GEUMCHEON_NAS_EVENT_ID} from '../shared/nas/protocol';
import {parseStageTextCatalog} from '../shared/events/stageTextCatalog';
import {DEFAULT_CONFIG} from '../shared/constants/defaults';
import {buildRecordRow} from '../shared/csv/fileStore';
import {buildPackagedSmokeChildEnvironment, buildPackagedSmokeCredentialPlan} from './e2e-geumcheon-packaged-smoke-check';
import {captureRendererSaveInputs,copyCapturedSyntheticInput,assessCapturedCanonicalInput,hashVisibleMappedImages,processTree} from './r5-standalone-review-check';

type Mode='review'|'nas';
type Role='game'|'leaderboard';
type Running={mode:Mode;role:Role;exe:string;pid:number;browser:Browser;page:Page;state:any;caseRoot:string;env:NodeJS.ProcessEnv};
const opts=new Map<string,string>();for(let i=2;i<process.argv.length;i+=2)opts.set(process.argv[i],process.argv[i+1]);
const output=path.resolve(opts.get('--output')??`Codex/Evidence/UIV3_20260910/after/run-${Date.now()}`);
const report:any={startedAt:new Date().toISOString(),releaseCandidate:'UI-v3-20260910',status:'NOT_RUN',method:'actual portable EXEs; CDP automated UI; isolated directories; real source NAS service behind synthetic loopback HTTPS',checks:[],captures:[],apps:[],limitations:['Human IME NOT_RUN','Physical five PCs NOT_RUN','Offline VM NOT_RUN','Real NAS NOT_RUN','Native window versus renderer viewport recorded individually'],actualUiRecords:[],seededRecords:[]};
let runClaimed=false;
const owned=new Set<Running>();const pendingRoots=new Map<number,any>();
const hash=(s:Buffer|string)=>crypto.createHash('sha256').update(s).digest('hex');
const sha=(p:string)=>hash(fs.readFileSync(p));
function json(p:string,v:any){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n');}
function flush(){if(runClaimed)json(path.join(output,'index.json'),report);}
function overallStatus(value:any){return runtimeVerdicts(value).overall;}
function certificateFailure(value:any){return ['UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(value.code);}
function check(name:string,passed:boolean,actual?:any){report.checks.push({name,passed,actual});flush();return passed;}
async function until(name:string,fn:()=>Promise<boolean>|boolean,ms=20000){const end=Date.now()+ms;let last:any;do{try{if(await fn())return;}catch(e){last=e;}await new Promise(r=>setTimeout(r,100));}while(Date.now()<end);throw Error(name+' timed out '+String(last??''));}
async function step(name:string,fn:()=>Promise<void>){const start=report.checks.length;try{await fn();const subset=report.checks.slice(start);if(subset.some((c:any)=>c.passed===false))check(name,false);else if(subset.some((c:any)=>['HOLD','PARTIAL','NOT_RUN'].includes(c.status))){report.checks.push({name,status:'PARTIAL',reason:'Child observations include unresolved coverage; no aggregate PASS'});flush();}else check(name,true);}catch(e){check(name,false,String(e));for(const a of owned)await a.page.screenshot({path:path.join(output,`${a.mode}-${a.role}-failure-${Date.now()}.png`)}).catch(()=>{});}}
function files(root:string):Record<string,string>{const out:Record<string,string>={};if(!fs.existsSync(root))return out;for(const e of fs.readdirSync(root,{withFileTypes:true})){const p=path.join(root,e.name);if(e.isDirectory())for(const [k,v]of Object.entries(files(p)))out[e.name+'/'+k]=v;else out[e.name]=sha(p);}return out;}
const admin='r7-synthetic-admin-only';
const APPROVED_TITLE={fileName:'title_logo_062843.png',sha256:'EEA89947C6EA42FC0DC6045C6398301D8E480DCB510DE7A83F1DB9766F0E22EE',bytes:1920919,canvas:[2048,682],alpha8:[21,66,2027,607]};
const APPROVED_MAIN={fileName:'geumnarae_main_052455_alpha.png',sha256:'5D1367E6FB3D0C781959232E3FBA4966CB4280B18DA90D9464456C2AF501B65C',bytes:1701622};
const APPROVED_STAGE1_ALPHA={fileName:'geumnarae_stage1_defeat_054108_alpha.png',sha256:'EE0406AC4ED72C9358022B485FDCA942C0345008006C4EA1E93BD059634AD306',bytes:1399604,zero:791815,partial:9443,opaque:771258};
const BEFORE_GEOMETRY=path.resolve('Codex/Evidence/UIV3_20260910/BEFORE_FIXED_GEOMETRY.json');
const BEFORE_INDEX=path.resolve('Codex/Evidence/UIV3_20260910/before/review-01/index.json');
let nas:any;
const recordOracles={review:new ReadOnlyRecordOracle<any[]>(),nas:new ReadOnlyRecordOracle<any[]>()};
const lastHarnessRequest=new Map<Mode,number>();
async function pacedRequest<T>(mode:Mode,label:string,action:()=>Promise<T>):Promise<T>{
 const waitMs=Math.max(0,2000-(Date.now()-(lastHarnessRequest.get(mode)??0)));if(waitMs)await new Promise(r=>setTimeout(r,waitMs));
 const started=Date.now(),requestIndex=mode==='nas'?nas?.requests.length??0:0;lastHarnessRequest.set(mode,started);
 const entry:any={mode,label,startedAt:new Date(started).toISOString(),waitMs,minHarnessIntervalMs:2000,rendererAutoRefresh:'UNCHANGED',status:'RUNNING'};report.requestPacing??=[];report.requestPacing.push(entry);
 try{const result=await action();entry.observedHttp=mode==='nas'?(nas?.requests.slice(requestIndex)??[]).map((r:any)=>({time:r.time,method:r.method,url:r.url,status:r.status})):[];assert.ok(!entry.observedHttp.some((r:any)=>r.status>=400),'Unexpected HTTP error during '+label+': '+JSON.stringify(entry.observedHttp));entry.status='COMPLETED';return result;}
 catch(e){entry.status='FAIL';entry.error=String(e);entry.observedHttp=mode==='nas'?(nas?.requests.slice(requestIndex)??[]).map((r:any)=>({time:r.time,method:r.method,url:r.url,status:r.status})):[];throw e;}
 finally{entry.completedAt=new Date().toISOString();flush();}
}
async function stageCatalogStartupEvidence(a:Running){
 const data=a.state.bootstrap?.data;assert.equal(a.state.bootstrap?.ok,true,'Normal launch bootstrap failed');
 await a.page.locator(a.role==='game'?'.entry-panel':'.leaderboard-app').waitFor();
 const notices=data?.notices??null,visibleStartupText=await a.page.locator('body').innerText();
 const source=path.resolve('events/geumcheon-2026/stage_texts.csv');
 const exposed=Object.fromEntries(['stageTextSource','stageTextCatalogPath','stageTextsPath'].filter(key=>data?.[key]!==undefined).map(key=>[key,data[key]]));
 const evidence:any={notices,visibleStartupText,sourceCatalogPath:source,sourceCatalogSha256:sha(source),exposedCatalogMetadata:exposed,catalogMetadataStatus:Object.keys(exposed).length?'EXPOSED':'NOT_EXPOSED',assetBaseUrl:data?.assetBaseUrl??null};
 a.state.stageCatalogStartup=evidence;
 check(a.mode+' '+a.role+' no default stage-text fallback notice',Array.isArray(notices)&&!JSON.stringify(notices).includes('기본 문구')&&!visibleStartupText.includes('기본 문구'),evidence);
 for(const key of ['stageTextCatalogPath','stageTextsPath'])if(typeof exposed[key]==='string'){
  const exposedPath=exposed[key].startsWith('file:')?fileURLToPath(exposed[key]):path.isAbsolute(exposed[key])?exposed[key]:null;
  const actualHash=exposedPath&&fs.existsSync(exposedPath)?sha(exposedPath):null;
  check(a.mode+' '+a.role+' exposed runtime stage catalog '+key+' matches authorized CSV',actualHash===sha(source),{exposedPath,actualHash,authorizedPath:source,authorizedSha256:sha(source)});
 }
}

async function setupNas(){
 const tokens={PC01:crypto.randomBytes(32).toString('hex'),LEADERBOARD01:crypto.randomBytes(32).toString('hex'),LEADERBOARD01_OPERATOR:crypto.randomBytes(32).toString('hex')};
 const catalog=path.resolve('events/geumcheon-2026/stage_texts.csv');
 const config:any={schemaVersion:1,eventId:GEUMCHEON_NAS_EVENT_ID,dataRoot:path.join(output,'nas-server-data'),recordBaseFolderName:'기록저장',stageTextCatalogPath:catalog,stageTextCatalog:parseStageTextCatalog(fs.readFileSync(catalog,'utf8')),participantHmacKey:crypto.randomBytes(32),allowedSessions:{official:[{sessionId:'r7-synthetic-official',dayNo:1,roundNo:1},{sessionId:'r7-synthetic-other-official',dayNo:1,roundNo:2}]},aiRanges:{official:[[100,125],[125,150],[150,200]],practice:[[100,125],[125,150],[150,200]]},tokenManifest:{manifestVersion:1,eventId:GEUMCHEON_NAS_EVENT_ID,tokens:Object.entries(tokens).map(([id,t])=>({tokenId:id,tokenHash:hash(t),deviceId:id.startsWith('LEADERBOARD')?'LEADERBOARD01':'PC01',role:id==='PC01'?'writer':id.endsWith('OPERATOR')?'operator':'leaderboard',allowedSessions:['official','practice'],expiresAt:new Date(Date.now()+86400000).toISOString(),revokedAt:null}))}};
 json(path.join(output,'synthetic-server-config.json'),{...config,participantHmacKey:'OMITTED_SYNTHETIC_KEY',stageTextCatalogSha256:sha(catalog),tokenManifest:{...config.tokenManifest,tokens:config.tokenManifest.tokens.map((t:any)=>({...t,tokenHash:'OMITTED_SYNTHETIC_TOKEN_HASH'}))}});const app=buildNasApp({config});await app.ready();
 const cert=createLocalHttpsCertificate(path.join(output,'synthetic-certificates'));const requests:any[]=[];
 const server=https.createServer({pfx:fs.readFileSync(cert.pfxPath),passphrase:cert.passphrase,minVersion:'TLSv1.2'},async(req,res)=>{
  const chunks:Buffer[]=[];for await(const c of req)chunks.push(c);const payload=Buffer.concat(chunks);const r=await app.inject({method:req.method as any,url:req.url!,headers:req.headers as any,...(payload.length?{payload}:{})});
  requests.push({classification:'SYNTHETIC TEST ONLY',time:new Date().toISOString(),method:req.method,url:req.url,device:req.headers['x-device-id'],status:r.statusCode,...(req.method==='POST'?{requestBody:payload.toString('utf8'),responseBody:r.body}:r.statusCode>=400?{responseBody:r.body}:{})});json(path.join(output,'nas-requests.json'),requests);res.writeHead(r.statusCode,r.headers as any);res.end(r.rawPayload);
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 return {server,app,tokens,cert,config,requests,baseUrl:`https://127.0.0.1:${(server.address() as any).port}`};
}
function prepare(mode:Mode,role:Role,source:string,negative?:'missing-credentials'|'untrusted-ca'){
 const caseRoot=negative?path.join(output,'nas-negative',negative,role):path.join(output,mode,role),dir=path.join(caseRoot,'executable'),exe=path.join(dir,path.basename(source));fs.mkdirSync(dir,{recursive:true});if(!fs.existsSync(exe))fs.copyFileSync(source,exe,fs.constants.COPYFILE_EXCL);assert.equal(sha(exe),sha(source),'STAGED_EXE_SOURCE_HASH_MISMATCH');
 const local=negative?path.join(caseRoot,'LocalAppData'):path.join(output,mode,'LocalAppData');
 const env=buildPackagedSmokeChildEnvironment({LOCALAPPDATA:local,APPDATA:path.join(caseRoot,'AppData'),TEMP:path.join(caseRoot,'Temp'),TMP:path.join(caseRoot,'Temp')});
 for(const k of ['LOCALAPPDATA','APPDATA','TEMP'])fs.mkdirSync(env[k]!,{recursive:true});
 for(const k of ['APP_VARIANT','EVENT_PROFILE','TYPINGKING_RUNTIME_ROOT','VITE_DEV_SERVER_URL','ELECTRON_RUN_AS_NODE','NODE_TLS_REJECT_UNAUTHORIZED','NODE_EXTRA_CA_CERTS','TYPINGKING_E2E_HIDE_WINDOW'])delete env[k];
 if(mode==='nas'){
  const deviceId=role==='game'?'PC01':'LEADERBOARD01';
  json(path.join(dir,'device-profile.json'),{schemaVersion:1,eventProfileId:'geumcheon-2026',eventId:GEUMCHEON_NAS_EVENT_ID,deviceId,role:role==='game'?'player':'leaderboard',apiBaseUrl:nas.baseUrl,sessions:{official:{sessionId:'r7-synthetic-official',dayNo:1,roundNo:1}},requestTimeoutMs:5000,retry:{initialDelayMs:1000,maxDelayMs:2000}});
  const runtime=path.join(local,'ThePMD','TypingKing2026','geumcheon-2026',deviceId);
  for(const c of buildPackagedSmokeCredentialPlan(role==='game'?'player':'leaderboard',nas.tokens))if(negative!=='missing-credentials'&&!fs.existsSync(path.join(runtime,'nas',c.encryptedFileName)))json(path.join(dir,c.bootstrapFileName),{schemaVersion:1,eventId:GEUMCHEON_NAS_EVENT_ID,deviceId,apiBaseUrl:nas.baseUrl,token:c.token});
  for(const p of [dir,runtime])json(path.join(p,'config','config.json'),{...DEFAULT_CONFIG,adminPassword:admin});
  for(const relative of ['events/geumcheon-2026/stage_texts.csv','events/geumcheon-2026/event.config.json']){const dest=path.join(dir,relative);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.resolve(relative),dest);}
  if(negative!=='untrusted-ca')env.NODE_EXTRA_CA_CERTS=nas.cert.caPemPath;env.NO_PROXY='127.0.0.1,localhost';
 }
 return {caseRoot,exe,env};
}
async function launch(mode:Mode,role:Role,source:string,negative?:'missing-credentials'|'untrusted-ca'):Promise<Running>{
 const {caseRoot,exe,env}=prepare(mode,role,source,negative);const port=19400+Math.floor(Math.random()*1000);
 const args=[`--remote-debugging-port=${port}`,`--user-data-dir=${path.join(caseRoot,'UserData')}`];
 const proc=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$p=Start-Process -FilePath $env:TK_EXE -WorkingDirectory $env:TK_DIR -ArgumentList @('--remote-debugging-port='+$env:TK_PORT,'--user-data-dir='+$env:TK_USER) -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)"],{env:{...env,TK_EXE:exe,TK_DIR:path.dirname(exe),TK_PORT:String(port),TK_USER:path.join(caseRoot,'UserData')},windowsHide:true,encoding:'utf8'});
 const pid=Number(proc.stdout.trim());assert.ok(pid>0,proc.stderr);const state:any={mode,role,negative,exe,sha256:sha(exe),pid,args,launchedAt:new Date().toISOString()};report.apps.push(state);pendingRoots.set(pid,state);watchNativeExit(pid,state);flush();
 let endpoint='';await until('portable CDP',async()=>{try{endpoint=(await(await fetch(`http://127.0.0.1:${port}/json/version`)).json() as any).webSocketDebuggerUrl;return Boolean(endpoint);}catch{return false;}},negative?20000:90000);
 const browser=await chromium.connectOverCDP(endpoint);let page:Page|undefined;await until('renderer page',()=>Boolean(page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('file:'))));
 const a={mode,role,exe,pid,browser,page:page!,state,caseRoot,env};owned.add(a);pendingRoots.delete(pid);state.lifecycle=[];const note=(kind:string,detail?:string)=>{let processes:any;try{processes=processTree(pid);}catch(e){processes={error:String(e)};}state.lifecycle.push({at:new Date().toISOString(),kind,detail,intentionalClose:state.intentionalClose===true,processes});flush();};page!.on('close',()=>note('page-close'));page!.on('crash',()=>note('page-crash'));page!.on('pageerror',e=>note('page-error',String(e)));browser.on('disconnected',()=>note('browser-disconnected'));await page!.waitForFunction(()=>Boolean((window as any).typingKing));state.bootstrap=await page!.evaluate(async()=> (window as any).typingKing.getBootstrap());recordOracles[mode].invalidate();if(!negative)await stageCatalogStartupEvidence(a);flush();return a;
}
async function close(a:Running){
 a.state.intentionalClose=true;await a.page.close().catch(()=>{});await a.browser.close().catch(()=>{});let snapshot:any;let errors:string[]=[];
 await until('owned process exit',()=>{try{snapshot=processTree(a.pid);return snapshot.length===0;}catch(e){errors.push(String(e));return false;}},10000).catch(()=>{});
 a.state.cleanup={errors,remaining:snapshot??null};if(snapshot?.length){const observed=snapshot.find((p:any)=>p.ProcessId===a.pid);if(observed&&path.resolve(observed.ExecutablePath)===path.resolve(a.exe)){spawnSync('taskkill.exe',['/PID',String(a.pid),'/T','/F'],{windowsHide:true});a.state.cleanup.forced=true;}}
 a.state.cleanup.postExit=await postExit(a.pid,[...(a.state.observedProcessIds??[]),...(snapshot??[]).map((p:any)=>p.ProcessId)]);owned.delete(a);flush();
}
async function adminOpen(a:Running){const p=a.page;await p.getByRole('button',{name:a.role==='game'?'관리자 모드':'관리자',exact:true}).click();const inputs=p.locator('.admin-modal input');await inputs.nth(0).fill('synthetic-r7-admin');await inputs.nth(1).fill(a.mode==='review'?'0208':admin);await pacedRequest(a.mode,'admin authenticate',async()=>{await p.getByRole('button',{name:a.role==='game'?'비밀번호 확인':'진입',exact:true}).click();await p.locator(a.role==='game'?'.admin-modal.wide':'.admin-toolbar').waitFor();});}
async function adminClose(a:Running){await a.page.locator('.admin-modal').getByRole('button',{name:'닫기',exact:true}).click();await a.page.locator('.admin-modal').waitFor({state:'hidden'});}
async function validate(a:Running){await adminOpen(a);if(a.mode==='review'){await a.page.getByRole('button',{name:'로컬 저장소 검증'}).click();await until('review validation',()=>a.page.locator('.geumcheon-nas-status-panel .notice-text').innerText().then(t=>t.includes('정상')));}else{await a.page.getByRole('button',{name:'연결·장치 역할·세션 검증',exact:true}).click();await until('NAS validated UI',()=>a.page.locator('.geumcheon-nas-status-panel .setup-state.ready').count().then(n=>n===1));const r=await a.page.evaluate(async()=> (window as any).typingKing.checkGameStartReadiness('ai_challenge'));assert.equal(r?.data?.ready,true,JSON.stringify(r));}await capture(a,'admin-validated');await adminClose(a);}

async function capture(a:Running,name:string){
 for(const [width,height]of [[1280,720],[1920,1080]]){
  const p=a.page;let nativeWindow:any;const session=await p.context().newCDPSession(p);try{const info=await session.send('Browser.getWindowForTarget');await session.send('Browser.setWindowBounds',{windowId:info.windowId,bounds:{windowState:'normal'}});await session.send('Browser.setWindowBounds',{windowId:info.windowId,bounds:{width,height}});nativeWindow=await session.send('Browser.getWindowBounds',{windowId:info.windowId});}catch(e){nativeWindow={error:String(e)};}finally{await session.detach();}a.state.nativeWindow=nativeWindow;await p.setViewportSize({width,height});
  const layoutReady=await waitForCaptureLayout({
   foreground:()=>p.bringToFront(),
   ready:async()=>{await p.waitForFunction(({width,height})=>innerWidth===width&&innerHeight===height,{width,height});await p.evaluate(async()=>{await document.fonts.ready;});},
   frame:()=>p.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()))),
   sample:()=>p.evaluate(()=>({viewport:[innerWidth,innerHeight],boxes:Array.from(document.querySelectorAll('main,header,section,form,.entry-event-copy,.entry-form-group,.duel-panel,.duel-metrics,.challenge-guide,.challenge-modal-message,.ranking-table,.ranking-body,.ranking-head,.leader-actions')).map(e=>{const r=e.getBoundingClientRect();return [r.x,r.y,r.width,r.height];})}))
  });
  const geometry=await p.evaluate(()=>{
   const selectors=['.hero-panel','.geumcheon-main-title-image','.hero-copy','.geumcheon-main-robot','.hero-guide-card','.hero-guide-list','.entry-event-copy','.entry-event-copy strong','.entry-event-copy span','.entry-panel','.entry-form-group','.entry-form-group .field','.entry-panel .entry-actions','.entry-panel .button-row','.entry-panel .primary-button','.entry-panel .secondary-button','.entry-form-group .field > span','.phone-row','.birth-row','.check-line','.entry-form-group .error-text','.entry-form-group .notice-text','.privacy-text','.challenge-layout','.duel-panel:first-child','.duel-panel:last-child','.duel-panel:first-child .duel-panel-header','.duel-panel:first-child .duel-target','.duel-panel:first-child .duel-input-layer','.duel-panel:first-child .duel-progress','.duel-panel:first-child .duel-metrics','.duel-panel:first-child .duel-metrics > :nth-child(1)','.duel-panel:first-child .duel-metrics > :nth-child(2)','.duel-panel:first-child .duel-metrics > :nth-child(3)','.challenge-guide','.challenge-modal','.challenge-modal-message','.challenge-modal-art','.challenge-modal .primary-button','.challenge-modal-message .compact-badges','.challenge-result-panel','.challenge-result-title','.challenge-stage-summary','.leaderboard-header','.leader-actions','.leaderboard-board','.ranking-table','.ranking-head','.session-counter','.leaderboard-session','.ranking-body','.uiv3-search-controls','.uiv3-search-primary','.uiv3-search-secondary'];
   const rects=Object.fromEntries(selectors.map(s=>{const e=document.querySelector(s);const style=e?getComputedStyle(e):null;return[s,e?{...e.getBoundingClientRect().toJSON(),text:(e as HTMLElement).innerText,align:style!.textAlign,fontSize:style!.fontSize,fontFamily:style!.fontFamily,fontWeight:style!.fontWeight,color:style!.color,lineHeight:style!.lineHeight,letterSpacing:style!.letterSpacing,borderTopWidth:style!.borderTopWidth,borderBottomWidth:style!.borderBottomWidth,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,offsetWidth:(e as HTMLElement).offsetWidth,clientWidth:e.clientWidth,scrollbarWidth:(e as HTMLElement).offsetWidth-e.clientWidth,scrollTop:e.scrollTop}:null];}));
   return {innerWidth,innerHeight,outerWidth,outerHeight,screenX,screenY,devicePixelRatio,screen:{width:screen.width,height:screen.height},rects,images:Array.from(document.images).filter(i=>i.getBoundingClientRect().width>0).map(i=>({src:i.src,alt:i.alt,loaded:i.complete&&i.naturalWidth>0,width:i.naturalWidth,height:i.naturalHeight,rect:i.getBoundingClientRect().toJSON()})),text:document.body.innerText,selected:Array.from(document.querySelectorAll('.ranking-row.selected')).map(e=>({class:e.className,background:getComputedStyle(e).backgroundColor,border:getComputedStyle(e).borderColor}))};
  });
  const screenshot=path.join(output,`${a.mode}-${a.role}-${name}-${width}x${height}.png`);await p.screenshot({path:screenshot});const assetHashes={...Object.fromEntries(['금나래 승리.png','금나래패배_스테이지1.png','금나래패배_스테이지2.png','금나래패배_스테이지3.png'].map(n=>[n,sha(path.join('C:/Users/Public/Documents/ESTsoft/CreatorTemp/TypingKing_R6_v2/events/geumcheon-2026/assets',n)).toUpperCase()])),[APPROVED_STAGE1_ALPHA.fileName]:APPROVED_STAGE1_ALPHA.sha256,[APPROVED_TITLE.fileName]:APPROVED_TITLE.sha256,[APPROVED_MAIN.fileName]:APPROVED_MAIN.sha256};const assetObservation=hashVisibleMappedImages(geometry.images.map(i=>({...i,naturalWidth:i.width,naturalHeight:i.height})),assetHashes);report.captures.push({sourceCommit:report.sourceCommit,buildCandidate:report.buildCandidate,mode:a.mode,role:a.role,name,exeSha256:a.state.sha256,buildId:a.state.bootstrap?.data?.reviewContext?.buildId??null,releaseCandidate:report.releaseCandidate,screenshot,geometry,layoutReadiness:{frameCount:layoutReady.frameCount,stableSamples:layoutReady.stableSamples,method:'Foreground and viewport/fonts ready, two animation frames, then three equal generic layout samples; no target coordinates'},assetObservation});check(a.mode+' '+name+' '+width+' visible mapped assets match approved hashes',assetObservation.violations.length===0,assetObservation.violations);flush();
  if(name==='main'){
   const r=geometry.rects as any;check(`${a.mode} main ${width} guide 5 lines`,await p.locator('.hero-guide-list > li').count()===5);check(`${a.mode} main ${width} guide contained`,r['.hero-guide-card'].bottom<=r['.hero-panel'].bottom+1&&r['.hero-guide-card'].bottom<=height);
   check(`${a.mode} main ${width} two-line copy`,r['.hero-copy'].text==='3개의 스테이지에서 금나래보다\n먼저 정확하게 입력하세요.');
   report.captures.at(-1).mainGaps={logoCopy:r['.hero-copy'].top-r['.geumcheon-main-title-image'].bottom,copyRobot:r['.geumcheon-main-robot'].top-r['.hero-copy'].bottom,robotGuide:r['.hero-guide-card'].top-r['.geumcheon-main-robot'].bottom};
  }
  if(name.startsWith('win-stage')||name.startsWith('loss-stage')){const text=await p.locator('.challenge-modal').innerText();check(`${a.mode} ${name} ${width} separate Stage label absent`,!/^Stage\s*[123]$/m.test(text));if(name.startsWith('win'))check(`${a.mode} ${name} ${width} victory lines`,text.includes('승리했습니다.\n금나래보다 빠르게 입력했습니다.'));}
  await v3FixedPresentation(a,name,width,height,geometry);
  await presentationChecks(a,name,width,height);
  if(name.startsWith('gameplay-stage')&&opts.get('--continuous-caret')==='true')await continuousCaretFrames(a,name,width,height);
  if(name==='final-victory'){const r=(geometry.rects as any)['.challenge-result-panel'];check(`${a.mode} final ${width} no internal scrolling`,r.scrollHeight<=r.clientHeight+1&&r.bottom<=height+1);check(`${a.mode} final ${width} victory lines`,geometry.text.includes('도전자 승리.\nAI 금나래보다 빠르고 정확하게 완성했습니다.'));check(`${a.mode} final ${width} participant wording`,!geometry.text.includes('사용자'));report.captures.at(-1).stageCards=await p.locator('.r7-stage-result-card').allInnerTexts();check(`${a.mode} final ${width} three cards only`,await p.locator('.r7-stage-result-card').count()===3&&await p.locator('.challenge-result-art,.challenge-result-title,.highlight-result').count()===0);}
 }
}

async function play(a:Running,reader:Running){
 const p=a.page;await capture(a,'main');
 await step(a.mode+' main input error and privacy consent',async()=>{
  assert.equal(await p.locator('.entry-panel .primary-button').isDisabled(),true);
  assert.ok((await p.locator('.entry-form-group .error-text').innerText()).trim());await capture(a,'main-error');
  await p.getByRole('button',{name:'동의 내용 보기',exact:true}).click();await p.locator('.privacy-text').waitFor();
  const actual=await p.locator('.privacy-text').innerText();const original=a.state.bootstrap?.data?.config?.privacyConsentText??DEFAULT_CONFIG.privacyConsentText;
  check(a.mode+' U05 only specified consent phrase removed',actual===original.replace(', 경품 지급 및 본인 확인','')&&!actual.includes(', 경품 지급 및 본인 확인'),{actual,expected:original.replace(', 경품 지급 및 본인 확인','')});
  await capture(a,'main-consent');await p.locator('.modal').filter({has:p.locator('.privacy-text')}).getByRole('button',{name:'확인',exact:true}).click();
  assert.equal(await p.locator('.entry-form-group input[type="checkbox"]').isChecked(),false);
 });
 const watcher=await captureRendererSaveInputs(p);
 let knownIds=new Set((await listSaved(reader)).map((r:any)=>r.record_id));let observedSaves=0;
 const observeAttempt=async(label:string,result:string,reached:number,participant='합성실제도전')=>{
  await until(label+' actual save argument',()=>watcher.inputs.length>observedSaves);const inputs=watcher.inputs.slice(observedSaves);assert.equal(inputs.length,1,'Exactly one UI save for '+label);observedSaves=watcher.inputs.length;const input=inputs[0].input;report.observedSaveInputs??=[];report.observedSaveInputs.push({mode:a.mode,label,input});flush();assert.equal(input.canonicalAttempt?.result,result);assert.equal(input.canonicalAttempt?.stageReached,reached);
  let rows:any[]=[];const deadline=Date.now()+5000;for(;;){const rejection=a.mode==='nas'?nas.requests.find((r:any)=>r.method==='POST'&&r.status>=400&&r.time>=inputs[0].observedAt):null;if(rejection)throw Error(label+' actual POST rejected: '+rejection.status+' '+rejection.responseBody);rows=await listSaved(reader);const count=rows.filter(r=>!knownIds.has(r.record_id)).length;if(count===1)break;assert.equal(count,0,'More than one uncorrelated new record');if(Date.now()>=deadline)throw Error(label+' actual stored row not observed');await new Promise(r=>setTimeout(r,100));}
  const delta=rows.filter(r=>!knownIds.has(r.record_id));assert.equal(delta.length,1);const row=delta[0];assert.equal(row.participant_name,participant);assert.equal(String(row.result_stage),String(reached));assert.equal(row.ai_challenge_status,result==='PARTICIPANT_WIN'?'SUCCESS':'FAILED');assert.equal(row.final_vs_ai_result,result==='PARTICIPANT_WIN'?'USER_WIN':'AI_WIN');
  if(result==='INTERRUPTED'){assert.equal(input.interruption?.action,'home');assert.equal(input.canonicalAttempt?.interruptionReason,'HOME');assert.equal(row.memo,'사용자 중단:메인화면');}
  for(let stage=1;stage<=3;stage++){assert.equal(Number(row['stage'+stage+'_time_ms']),Math.round(input.stageTimesMs[stage-1]));if(stage>reached){assert.equal(row['stage'+stage+'_vs_ai_result'],'');assert.equal(Number(row['stage'+stage+'_time_ms']),0);assert.equal(input.canonicalAttempt?.stages[stage-1].entered,false);}else assert.equal(row['stage'+stage+'_vs_ai_result'],result==='PARTICIPANT_WIN'||stage<reached?'USER_WIN':'AI_WIN');}
  const chain=a.mode==='nas'?verifyNasEvidenceChain(input,row,inputs[0].observedAt):undefined;
  recordOracles[a.mode].invalidate();knownIds=new Set(rows.map(r=>r.record_id));report.actualUiRecords.push({mode:a.mode,label,recordId:row.record_id,method:'one observed actual UI save argument correlated to exactly one new ID from authenticated leaderboard listRecords before next attempt or any seed',inputSha256:inputs[0].inputSha256,input,row,chain});check(a.mode+' persisted actual UI '+label,true,{recordId:row.record_id,reached,result});
 };
 try{
  await p.locator('.entry-form-group input').first().fill('합성실제도전');
  await p.locator('.phone-row input').nth(0).fill('0000');await p.locator('.phone-row input').nth(1).fill('1234');
  for(const[n,v]of ['2012','1','2'].entries())await p.locator('.birth-row select').nth(n).selectOption(v);
  await p.locator('.entry-form-group input[type="checkbox"]').check();await p.locator('.entry-panel .button-row .primary-button').click();
  for(let loss=0;loss<=3;loss++){
   for(let stage=1;stage<=3;stage++){
    const input=p.locator('textarea.typing-input');await until('stage input enabled',()=>input.isEnabled());
    if(loss===0)await capture(a,'gameplay-stage-'+stage);
    if(stage===loss){await p.locator('.challenge-modal').waitFor({state:'visible',timeout:150000});await capture(a,'loss-stage-'+stage);await step(a.mode+' loss-stage-'+stage+' persistence',()=>observeAttempt('loss-stage-'+stage,'GEUMNARAE_WIN',stage));await p.locator('.challenge-modal .primary-button').click();break;}
    await input.fill((await p.locator('.duel-target').first().innerText()).replace(/\u00a0/g,' ').trim());
    await p.locator('.challenge-modal').waitFor();if(loss===0)await capture(a,'win-stage-'+stage);await p.locator('.challenge-modal .primary-button').click();
   }
   if(loss===0){await p.locator('.challenge-result-panel').waitFor();await capture(a,'final-victory');await step(a.mode+' win persistence',()=>observeAttempt('win','PARTICIPANT_WIN',3));if(opts.get('--one-win')==='true')return;await p.getByRole('button',{name:'다시 도전하기',exact:true}).click();}
  }
  await until('interruption input ready',()=>p.locator('textarea.typing-input').isEnabled());
  await p.getByRole('button',{name:'메인으로 가기',exact:true}).click();
  await capture(a,'interruption-confirm');
  await p.locator('.game-confirm-modal').getByRole('button',{name:'확인',exact:true}).click();await p.locator('.entry-panel').waitFor();await capture(a,'interruption-return-main');await step(a.mode+' interruption persistence',()=>observeAttempt('interruption','INTERRUPTED',1));
  assert.deepEqual(watcher.errors,[]);
  const actual=watcher.inputs.map(x=>x.input);assert.equal(actual.length,5,'Win, losses at stages1/2/3, interruption must each save once');check(a.mode+' all five actual UI attempts persisted',report.actualUiRecords.filter((r:any)=>r.mode===a.mode).length===5);
  const win=actual.find(x=>x.canonicalAttempt?.result==='PARTICIPANT_WIN');assert.ok(win);assert.deepEqual(assessCapturedCanonicalInput(win),[]);for(const shot of report.captures.filter((c:any)=>c.mode===a.mode&&c.name==='final-victory')){const cards=shot.stageCards??[];check(a.mode+' final cards show actual saved stage times '+shot.geometry.innerWidth,cards.length===3&&cards.every((t:string,i:number)=>t.includes('도전자 : '+(win.stageTimesMs[i]/1000).toFixed(2)+'초')),cards);}
  const saved=await listSaved(reader);const linked=report.actualUiRecords.find((r:any)=>r.mode===a.mode&&r.label==='win');const row=saved.find((r:any)=>r.record_id===linked.recordId);check(a.mode+' actual saved row correlation',assessPublicStoredWin(win,row).length===0,assessPublicStoredWin(win,row));
  await pacedActualWins(a,reader,observeAttempt);await watcher.stop();assert.deepEqual(watcher.errors,[]);
  for(let i=0;i<10;i++){const input=copyCapturedSyntheticInput(win,i?{name:'합성추가'+String(i).padStart(2,'0'),phone2:String(i).padStart(4,'0'),phone3:String(2000+i)}:undefined);assert.ok(input.recordEvidence,'Nested raw evidence required for every clone');assert.deepEqual(input.recordEvidence.canonicalAttempt,input.canonicalAttempt);const result=await pacedRequest(a.mode,'protected synthetic clone save '+i,async()=>{const response=await p.evaluate(async(input)=>(window as any).typingKing.saveRecord(input),input);assert.equal(response.ok,true,JSON.stringify(response));return response;});recordOracles[a.mode].invalidate();report.seededRecords.push({mode:a.mode,method:'protected saveRecord IPC full nested evidence clone; main process supplies fresh trusted identity',recordId:result.data?.record_id});}
 }finally{await watcher.stop().catch(()=>{});flush();}
}
async function listSaved(reader:Running):Promise<any[]>{return pacedRequest(reader.mode,'fresh protected no-argument listRecords',async()=>{const response=await reader.page.evaluate(async()=> (window as any).typingKing.listRecords());assert.equal(response?.ok,true,'Authenticated listRecords failed: '+JSON.stringify(response));assert.ok(Array.isArray(response.data),'listRecords did not return an array');return response.data;});}
async function searchSequence(a:Running){
 const p=a.page,input=p.locator('.uiv3-search-controls input'),field=p.locator('.uiv3-search-controls select'),submit=p.getByRole('button',{name:'검색',exact:true}),rows=p.locator('.ai-ranking .ranking-row');
 const saved=await listSaved(a),byId=new Map(saved.map((r:any)=>[r.record_id,r]));
 const snapshot=()=>rows.evaluateAll(nodes=>nodes.map(e=>({id:e.getAttribute('data-leaderboard-record')!,rank:e.querySelector('.rank-number')?.textContent,text:(e as HTMLElement).innerText})));
 const settle=async()=>{await p.waitForFunction(()=>document.querySelector('.ai-ranking')?.getAttribute('aria-busy')==='false');await p.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));};
 const request=async(action:()=>Promise<unknown>,expectedTransportFailure=false)=>pacedRequest(a.mode,expectedTransportFailure?'expected actual UI transport failure':'valid actual UI search or refresh',async()=>{
  await settle();await p.evaluate(()=>{const w=window as any;w.__uiv3BusyProof={seenBusy:false,mutations:[]};const observer=new MutationObserver(events=>{for(const event of events){const target=event.target as Element;if(!target.matches('.ai-ranking'))continue;const current=target.getAttribute('aria-busy');w.__uiv3BusyProof.mutations.push({at:performance.now(),old:event.oldValue,current});if(current==='true'||event.oldValue==='true')w.__uiv3BusyProof.seenBusy=true;}});observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['aria-busy'],attributeOldValue:true});w.__uiv3BusyObserver=observer;});
  try{await action();await p.waitForFunction(()=>{const w=window as any;return w.__uiv3BusyProof?.seenBusy===true&&document.querySelector('.ai-ranking')?.getAttribute('aria-busy')==='false';});const proof=await p.evaluate(()=>(window as any).__uiv3BusyProof);const alerts=await p.locator('.leaderboard-alert').allTextContents();report.searchRefreshTransitions??=[];report.searchRefreshTransitions.push({mode:a.mode,expectedTransportFailure,alerts,...proof});if(expectedTransportFailure){assert.ok(alerts.length===1&&alerts[0].trim(),'Actual transport failure must show an error');assert.ok(!/429|RATE_LIMIT|요청.*많|요청.*초과/i.test(alerts[0]),'Rate limit is not the planned transport error');}else assert.deepEqual(alerts,[],'Valid UI request must finish without an alert');}
  finally{await p.evaluate(()=>{const w=window as any;w.__uiv3BusyObserver?.disconnect();delete w.__uiv3BusyObserver;delete w.__uiv3BusyProof;});}
 });
 const root=path.join(output,'continuous-search',a.mode);fs.mkdirSync(root,{recursive:true});const cdp=await p.context().newCDPSession(p);
 const timeline:any={scope:'Actual EXE renderer search interactions; synthetic records; CDP frames are not native OS video or human IME',startedAt:new Date().toISOString(),frames:[],steps:[]};report.searchTimeline??=[];report.searchTimeline.push(timeline);
 const onFrame=(event:any)=>{void cdp.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});if(timeline.frames.length>=240)return;const file=path.join(root,String(timeline.frames.length).padStart(4,'0')+'.jpg');fs.writeFileSync(file,Buffer.from(event.data,'base64'));timeline.frames.push({file,sha256:sha(file),receivedAt:new Date().toISOString(),metadata:event.metadata});};
 cdp.on('Page.screencastFrame',onFrame);
 const mark=async(label:string)=>{const current=await snapshot();timeline.steps.push({at:new Date().toISOString(),label,field:await field.inputValue(),draftLength:(await input.inputValue()).length,latestFrame:timeline.frames.length-1,rows:current});await capture(a,'search-'+label);json(path.join(root,'index.json'),timeline);return current;};
 const assertRows=async(expected:any[],label:string)=>{await settle();const actual=await snapshot();assert.deepEqual(actual,expected,label+' preserves original IDs, ranks, masked cells, score strings and order');check(a.mode+' U11 '+label,true,{expectedIds:expected.map(r=>r.id),actualIds:actual.map(r=>r.id),ranks:actual.map(r=>r.rank)});};
 const matches=(baseline:any[],kind:'name'|'contact',term:string)=>baseline.filter(v=>{const record:any=byId.get(v.id);return kind==='name'?String(record?.participant_name??'').toLocaleLowerCase().includes(term.trim().toLocaleLowerCase()):String(record?.phone_full??'').replace(/[^0-9]/g,'').includes(term.replace(/[\s-]/g,''));});
 const apply=async(term:string)=>{await input.fill(term);await request(()=>submit.click());await settle();};
 const view=async(mode:'best'|'all')=>{await adminOpen(a);const button=p.getByRole('button',{name:mode==='best'?'최고기록만 보기':'전체기록 보기',exact:true});if(await button.getAttribute('aria-pressed')!=='true')await pacedRequest(a.mode,'actual admin view selection '+mode,()=>button.click());assert.equal(await button.getAttribute('aria-pressed'),'true');await adminClose(a);await settle();};
 const chooseField=async(value:'name'|'contact')=>{if(await field.inputValue()!==value)await request(()=>field.selectOption(value));};
 try{
  await cdp.send('Page.startScreencast',{format:'jpeg',quality:65,maxWidth:1280,maxHeight:720,everyNthFrame:1});
  assert.deepEqual(await field.locator('option').allTextContents(),['성명','연락처']);
  await view('best');await chooseField('name');await apply('');const baseline=await mark('baseline-best');assert.ok(baseline.length>=10,'At least ten actual/synthetic protected stored rows required');
  const exposed=baseline.filter((v:any)=>{const r:any=byId.get(v.id);return r&&(v.text.includes(r.participant_name)||v.text.includes(r.phone_full));});const html=await p.locator('.ai-ranking').evaluate(e=>e.outerHTML);const attributeExposure=saved.filter((r:any)=>html.includes(r.participant_name)||html.includes(r.phone_full));check(a.mode+' U11 public results and attributes retain original masking',exposed.length===0&&attributeExposure.length===0,{exposedIds:exposed.map((r:any)=>r.id),attributeExposureIds:attributeExposure.map((r:any)=>r.record_id)});
  await input.fill('속도');await assertRows(baseline,'draft does not apply');await mark('name-draft-unapplied');
  const expectedName=matches(baseline,'name','속도');assert.ok(expectedName.length>=2&&expectedName.length<baseline.length);
  await request(()=>submit.click());await assertRows(expectedName,'partial name submit');await mark('partial-name');
  await input.fill('없는새초안');await request(()=>p.getByRole('button',{name:'새로고침',exact:true}).click());await assertRows(expectedName,'refresh retains applied name not new draft');await mark('refresh-retains-applied');
  const atomic=await pacedRequest(a.mode,'fresh protected atomic search',async()=>{const response=await p.evaluate(async()=> (window as any).typingKing.listRecords({search:{field:'name',term:'속도'}}));assert.equal(response.ok,true);return response;});assert.ok(Array.isArray(atomic.data)&&Array.isArray(atomic.matchingRecordIds));
  const rawExpected=atomic.data.filter((r:any)=>r.participant_name.toLocaleLowerCase().includes('속도')).map((r:any)=>r.record_id).sort();assert.deepEqual([...atomic.matchingRecordIds].sort(),rawExpected);assert.ok(atomic.data.length>=baseline.length,'Atomic search must retain complete eligible snapshot before best/rank selection');check(a.mode+' U11 atomic protected full snapshot and matching IDs',true,{snapshotRows:atomic.data.length,matchingIds:atomic.matchingRecordIds});
  await chooseField('contact');await assertRows(baseline,'field change clears draft and applied filter');assert.equal(await input.inputValue(),'');await mark('field-reset');
  const expectedContact=matches(baseline,'contact','010-009');assert.ok(expectedContact.length>=2&&expectedContact.length<baseline.length);
  await input.fill('010-009');await request(()=>input.press('Enter'));await assertRows(expectedContact,'partial original contact Enter');await mark('partial-contact');
  for(const invalid of ['abc','010x']){await input.fill(invalid);await submit.click();await p.getByRole('alert').waitFor();assert.match(await p.getByRole('alert').innerText(),/연락처/);await assertRows(expectedContact,'invalid contact preserves prior results');await mark('invalid-contact-'+invalid.length);}
  await apply('   ');await assertRows(baseline,'blank query clears filter only');await mark('blank-reset');
  await chooseField('name');await settle();await apply('존재하지않는합성성명');await assertRows([],'zero results');assert.equal(await p.locator('.ranking-empty').innerText(),'검색 결과가 없습니다.');await mark('zero-results');
  await apply('긴합성검색어'.repeat(80));await assertRows([],'long query remains inside fixed controls');await mark('long-query');
  await apply('');await assertRows(baseline,'restore base before view change');
  await view('all');const all=await mark('baseline-all');assert.ok(all.length>baseline.length,'Full-record mode must expose stored duplicate attempts independently of best mode');
  await apply('속도');await assertRows(matches(all,'name','속도'),'all-record view search retains original ranks');await mark('all-view-name');
  await input.fill('아직미제출');await request(()=>p.getByRole('button',{name:'새로고침',exact:true}).click());await assertRows(matches(all,'name','속도'),'refresh preserves all-record view and applied query');await mark('all-view-refresh');
  await input.fill('   ');await request(()=>submit.click());await assertRows(all,'blank keeps all-record mode');await mark('all-view-blank');
  await input.fill('속도');await input.dispatchEvent('compositionstart',{data:'속도'});await input.press('Enter');await assertRows(all,'synthetic composition Enter does not submit');await input.dispatchEvent('compositionend',{data:'속도'});await request(()=>input.press('Enter'));await assertRows(matches(all,'name','속도'),'post-composition Enter submits');await mark('synthetic-composition-guard');
  report.checks.push({name:a.mode+' U11 actual human Korean IME',status:'NOT_RUN',reason:'Synthetic DOM composition events verify handler only, not human IME or OS keyboard'});
  if(a.mode==='nas'){
   const server=nas.server,address=server.address();assert.ok(address&&typeof address!=='string'&&server.listening,'Existing owned HTTPS listener required');
   const prior=await snapshot(),priorField=await field.inputValue(),priorDraft=await input.inputValue();await recordOracles[a.mode].read(()=>listSaved(a));await mark('transport-before');
   const outage:any={mode:a.mode,classification:'EXPECTED_CONTROLLED_TRANSPORT_OUTAGE',startedAt:new Date().toISOString(),address,method:'Close and restore only the existing synthetic loopback HTTPS listener; same app, TLS, tokens, records, limiter and renderer auto-refresh',beforeRows:prior,field:priorField,draft:priorDraft};report.searchTransportOutages??=[];report.searchTransportOutages.push(outage);
   try{
    await new Promise<void>((resolve,reject)=>{server.close((error?:Error)=>error?reject(error):resolve());server.closeIdleConnections?.();});assert.equal(server.listening,false);outage.listenerClosedAt=new Date().toISOString();
    await request(()=>p.getByRole('button',{name:'새로고침',exact:true}).click(),true);outage.visibleError=await p.locator('.leaderboard-alert').innerText();await assertRows(prior,'actual transport error retains preceding rows and original ranks');assert.equal(await field.inputValue(),priorField);assert.equal(await input.inputValue(),priorDraft);await mark('transport-error');
   }finally{
    if(!server.listening)await new Promise<void>((resolve,reject)=>{const failed=(error:Error)=>reject(error);server.once('error',failed);server.listen(address.port,address.address,()=>{server.off('error',failed);resolve();});});
    outage.restoredAt=new Date().toISOString();outage.restoredAddress=server.address();assert.deepEqual(outage.restoredAddress,address,'Restore exact listener address and port');assert.equal(nas.server,server);flush();
   }
   await request(()=>p.getByRole('button',{name:'새로고침',exact:true}).click());await assertRows(prior,'actual transport recovery retains applied condition');await mark('transport-recovery');outage.recoveredAt=new Date().toISOString();outage.recoveredRows=await snapshot();check(a.mode+' U11 actual search transport failure display and recovery',true,outage);
  }else report.checks.push({name:a.mode+' U11 actual search transport failure display',status:'NOT_RUN',reason:'Review-mode local storage has no owned NAS HTTPS listener; NAS-only controlled transport scenario is separate'});
  await apply('');await view('best');await assertRows(baseline,'search cleanup restores original best view');
  const after=await listSaved(a);assert.ok(isDeepStrictEqual(after,saved),'Search changed source record values');check(a.mode+' U11 search preserves exact original stored records',true,{recordCount:saved.length});
  check(a.mode+' U11 continuous renderer search frames',timeline.frames.length>=2&&timeline.steps.length>=12,{frames:timeline.frames.length,steps:timeline.steps.length});
 }finally{await cdp.send('Page.stopScreencast').catch(()=>{});cdp.off('Page.screencastFrame',onFrame);await cdp.detach();timeline.completedAt=new Date().toISOString();json(path.join(root,'index.json'),timeline);flush();}
}

async function selection(a:Running){
 const p=a.page,rows=p.locator('.ai-ranking .ranking-row'),selected=p.locator('.ai-ranking .ranking-row.selected');
 await rows.first().click();assert.equal(await selected.count(),1);await capture(a,'row-selected');
 await rows.first().click();assert.equal(await selected.count(),0);await capture(a,'same-row-cleared');
 await rows.first().click();await rows.nth(1).click();assert.equal(await selected.count(),1);assert.ok((await rows.nth(1).getAttribute('class'))?.includes('selected'));
 const targets=[['cell',()=>rows.nth(1).locator('span').first().click()],['header',()=>p.locator('.ranking-head').click()],['search',()=>p.locator('.uiv3-search-controls input').click()],['background',()=>p.locator('.leaderboard-header').click({position:{x:2,y:2}})]] as const;
 for(const[name,click]of targets){if(await selected.count()===0)await rows.nth(1).click();await click();check(a.mode+' deselect '+name,await selected.count()===0);await capture(a,'outside-'+name);}
 await searchSequence(a);
 await adminOpen(a);const picker=p.locator('.admin-record-picker button').first();const recordId=await picker.getAttribute('data-leaderboard-record');await picker.click();const field=p.locator('.edit-grid input').first();await field.fill('합성미저장초안');await p.locator('.admin-modal h2').click();assert.equal(await field.inputValue(),'합성미저장초안');check(a.mode+' admin background preserves draft',await field.inputValue()==='합성미저장초안');await picker.click();assert.equal(await field.inputValue(),'합성미저장초안');await picker.click();assert.equal(await field.inputValue(),'합성미저장초안');check(a.mode+' admin reselect and same-row clear preserves draft',await field.inputValue()==='합성미저장초안'&&!(await picker.getAttribute('class'))?.includes('selected'));await field.focus();await p.keyboard.press('Tab');await capture(a,'admin-draft-focus');await pacedRequest(a.mode,'actual admin record edit',async()=>{await p.getByRole('button',{name:'수정 저장',exact:true}).click();await p.locator('.edit-grid').waitFor({state:'hidden'});});recordOracles[a.mode].invalidate();await p.locator('.admin-record-picker button[data-leaderboard-record="'+recordId+'"]').click();await p.locator('.edit-grid').waitFor();check(a.mode+' saved record same-row editor reopens',await p.locator('.edit-grid input').first().inputValue()==='합성미저장초안');await capture(a,'admin-saved-record-reopened');await adminClose(a);
 const body=p.locator('.ai-ranking .ranking-body');await p.setViewportSize({width:1280,height:720});await body.evaluate(e=>e.scrollTop=e.scrollHeight);const scroll=await body.evaluate(e=>({top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight}));check(a.mode+' leaderboard actual scroll',scroll.top>0,scroll);await capture(a,'leaderboard-scrolled');await body.evaluate(e=>e.scrollTop=0);
}
async function displayRestart(a:Running,source:string):Promise<Running>{
 for(const enabled of [true,false]){
  await adminOpen(a);const cb=a.page.getByLabel('일차·회차 표시',{exact:true});await cb.setChecked(enabled);await pacedRequest(a.mode,'actual display settings save',()=>a.page.getByRole('button',{name:'표시 설정 저장',exact:true}).click());recordOracles[a.mode].invalidate();await adminClose(a);await capture(a,'day-round-'+(enabled?'on':'off'));await close(a);a=await launch(a.mode,a.role,source);
  await a.page.locator('.leaderboard-app').waitFor();const badges=a.page.locator('.ai-ranking .session-badges');check(a.mode+' persisted day-round '+enabled,await badges.count()===(enabled?1:0));await capture(a,'restart-day-round-'+(enabled?'on':'off'));
 }
 return a;
}
async function acceptResetDialog(page:Page,timeoutMs=10000){
 let listener:(dialog:any)=>void=()=>{};let timer:ReturnType<typeof setTimeout>|undefined;
 const confirmation=new Promise<{type:string;message:string;accepted:true}>((resolve,reject)=>{
  timer=setTimeout(()=>reject(Error('RESET_CONFIRMATION_NOT_OBSERVED')),timeoutMs);
  listener=(dialog:any)=>{Promise.resolve().then(async()=>{const type=dialog.type();const message=dialog.message();assert.equal(type,'confirm','Unexpected reset dialog type');assert.equal(message,'현재 회차 기록을 리더보드 표시에서 초기화하시겠습니까? 원본 기록은 삭제되지 않습니다.','Unexpected reset confirmation');await dialog.accept();resolve({type,message,accepted:true});}).catch(reject);};
  page.once('dialog',listener);
 });
 try{const [accepted]=await Promise.all([confirmation,Promise.resolve().then(()=>page.getByRole('button',{name:'현재 회차 표시 초기화',exact:true}).click())]);return accepted;}
 finally{if(timer)clearTimeout(timer);page.off('dialog',listener);}
}
async function reset(a:Running){
 const root=a.mode==='review'?path.join(output,'review','LocalAppData','ThePMD','TypingKing','Geumcheon2026','Review','official','official','review-official-1','records'):nas.config.dataRoot;
 const other=a.mode==='nas'?await seedSecondSession():null;const envelopes=a.mode==='review'?reviewRecordSnapshot(root):undefined;const before=envelopes?undefined:files(root);if(envelopes)json(path.join(output,'reset-before-records.json'),reviewSnapshotSummary(envelopes));await adminOpen(a);const confirmation=await pacedRequest(a.mode,'actual current-session display reset',()=>acceptResetDialog(a.page));check(a.mode+' actual reset confirmation accepted',confirmation.accepted,confirmation);await adminClose(a);await until('reset visible rows',()=>a.page.locator('.ai-ranking .ranking-row').count().then(n=>n===0));recordOracles[a.mode].invalidate();await capture(a,'reset-visible-empty');
 if(envelopes){const after=reviewRecordSnapshot(root);json(path.join(output,'reset-after-records.json'),reviewSnapshotSummary(after));assert.deepEqual(Object.keys(after),Object.keys(envelopes),'Review record filename set changed');const changed:string[]=[];for(const [file,prior]of Object.entries(envelopes)){const next=after[file];assert.equal(next.envelope.hidden,true);assert.deepEqual({...next.envelope,hidden:prior.envelope.hidden},prior.envelope,'Only review hidden metadata may change: '+file);if(prior.sha256!==next.sha256)changed.push(file);}check('review reset preserves complete row evidence identity session; only hidden changes',Object.keys(after).length>0,{count:Object.keys(after).length,changedFileSha256:changed,method:'Full envelope deep equality excluding hidden; pre/post hashes deliberately differ for newly hidden records'});report.checks.push({name:'review other-session reset preservation',status:'NOT_RUN',reason:'Fixed review session; no fabricated noncurrent session proof'});}else{const after=files(root);const raw=Object.keys(before!).filter(k=>k.endsWith('.json')&&k.includes('/incoming/ai/'));check('nas reset preserves immutable incoming raw SHA',raw.length>0&&raw.every(k=>before![k]===after[k]),{count:raw.length});if(other){const reread=await nasHttp('GET','/api/v1/records?session_kind=official&session_id=r7-synthetic-other-official&day_no=1&round_no=2','leaderboard');check('NAS other official session query preserved after reset',reread.status===200&&reread.data.rows.length===other.count,reread.data);check('NAS other official raw SHA preserved',Object.entries(other.raw).every(([k,v])=>after[k]===v),other.raw);}}flush();
}
function reviewRecordSnapshot(root:string){const entries:Record<string,{sha256:string;envelope:any}>={};for(const name of fs.readdirSync(root).filter(n=>n.endsWith('.json')).sort()){const file=path.join(root,name);assert.ok(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink());const envelope=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(name,envelope.row.record_id+'.json');entries[name]={sha256:sha(file),envelope};}return entries;}
function reviewSnapshotSummary(value:ReturnType<typeof reviewRecordSnapshot>){return Object.fromEntries(Object.entries(value).map(([name,v])=>[name,{fileSha256:v.sha256,recordId:v.envelope.row.record_id,hidden:v.envelope.hidden,rowSha256:hash(JSON.stringify(v.envelope.row)),reviewIdentity:v.envelope.reviewIdentity,session:v.envelope.session,envelopeExceptHiddenSha256:hash(JSON.stringify({...v.envelope,hidden:false}))}]));}
async function security(){
 const request=(headers:any,ca=true)=>new Promise<any>(resolve=>{const r=https.get(nas.baseUrl+'/api/v1/ready?session_kind=official&session_id=r7-synthetic-official&day_no=1&round_no=1',{headers,...(ca?{ca:fs.readFileSync(nas.cert.caPemPath)}:{})},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode}));});r.on('error',(e:any)=>resolve({error:e.message,code:e.code}));});
 for(const[name,headers]of [['missing token',{'x-device-id':'PC01'}],['wrong token',{'x-device-id':'PC01',authorization:'Bearer synthetic-invalid'}],['wrong device',{'x-device-id':'PC99',authorization:'Bearer '+nas.tokens.PC01}]] as const){const r=await request(headers);check('Node HTTPS '+name+' rejected',r.status===401||r.status===403,r);}
 const tls=await request({'x-device-id':'PC01',authorization:'Bearer '+nas.tokens.PC01},false);check('Node HTTPS untrusted CA certificate rejection',certificateFailure(tls),tls);const health=await nasHttp('GET','/health','writer');check('Node HTTPS trusted health succeeds',health.status===200,health);report.securityScope='Node HTTPS requests to real source service; not proof that packaged EXE fails closed';
}
async function main(){
 if(fs.existsSync(output))throw Error('OUTPUT_ALREADY_EXISTS:'+output);fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(output);runClaimed=true;report.sourceCommit=spawnSync('git',['rev-parse',opts.get('--source-commit')??'HEAD'],{encoding:'utf8'}).stdout.trim();report.buildCandidate=opts.get('--label')??report.releaseCandidate;flush();
 report.requiredNativeEvidence={status:'NOT_RUN',reasonCode:'TOOL_BLOCKED',toolEvidence:'../native-f11-tool-status.json',requirements:['actual OS F11 twice for all four EXEs','game/input/record preservation across actual OS fullscreen transitions','window/fullscreen 1280x720 and1920x1080 native matrix','continuous native transition video'],notEquivalent:['CDP key dispatch','renderer viewport emulation','CDP screencast frames','DOM focus/caret configuration']};if(opts.get('--continuous-caret')!=='true')report.checks.push({name:'continuous renderer caret evidence',status:'NOT_RUN',reason:'Enable only for an authorized new runtime using --continuous-caret true'});flush();
 if(opts.has('--reset-review-from')){await resetReviewFocused(opts.get('--reset-review-from')!);return;}
 if(opts.get('--self-check')==='true'){assert.equal(overallStatus({checks:[{passed:false}],limitations:[]}), 'FAIL');assert.equal(overallStatus({error:'exception',checks:[],limitations:[]}), 'FAIL');assert.equal(overallStatus({checks:[{status:'PARTIAL'}],limitations:[]}), 'PARTIAL');assert.equal(certificateFailure({code:'ECONNREFUSED'}),false);assert.equal(certificateFailure({code:'UNABLE_TO_VERIFY_LEAF_SIGNATURE'}),true);check('harness verdict and TLS classifier regressions',true);nas=await setupNas();try{await security();const ready=await nasHttp('GET','/api/v1/ready?session_kind=official&session_id=r7-synthetic-official&day_no=1&round_no=1','writer');check('actual HTTPS official-only server readiness',ready.status===200,ready);}finally{await new Promise<void>(r=>nas.server.close(()=>r()));await nas.app.close();report.status=report.checks.some((c:any)=>c.passed===false)?'FAIL':'PASS';report.scope='Harness self-check only; zero EXE launches';flush();}return;}
 if(opts.get('--startup-only')==='true'){report.buildLabel=opts.get('--label')??'startup-only';report.method='Actual portable EXE isolated startup diagnostic only, not full UI or release verification';let app:Running|undefined;try{app=await launch('review','game',opts.get('--review-game')!);app.state.rendererErrors=[];app.page.on('pageerror',e=>app!.state.rendererErrors.push(String(e)));await app.page.locator('.entry-panel').waitFor({state:'visible',timeout:20000});await capture(app,'startup-diagnostic');check('isolated actual EXE startup entry panel visible',true);report.status='PARTIAL';}catch(e){check('isolated actual EXE startup entry panel visible',false,String(e));report.status='FAIL';}finally{for(const a of [...owned])await close(a);await cleanupPending();flush();}return;}
 const modes:Mode[]=opts.get('--mode')?[opts.get('--mode') as Mode]:['review','nas'];
 try{
  for(const mode of modes){
   if(mode==='nas')nas=await setupNas();
   const gameSource=opts.get('--'+mode+'-game'),lbSource=opts.get('--'+mode+'-leaderboard');assert.ok(gameSource&&lbSource,'Supply --review-game, --review-leaderboard, --nas-game, --nas-leaderboard');
   let game:Running|undefined,lb:Running|undefined;
   try{
    game=await launch(mode,'game',gameSource);lb=await launch(mode,'leaderboard',lbSource);check(mode+' official pair concurrent',owned.size===2);
    await step(mode+' game CDP F11 experiment',()=>fullscreenKeys(game!));await step(mode+' leaderboard CDP F11 experiment',()=>fullscreenKeys(lb!));
    await step(mode+' game admin validation',()=>validate(game!));await step(mode+' leaderboard admin validation',()=>validate(lb!));
    check(mode+' day-round default OFF',await lb.page.locator('.ai-ranking .session-badges').count()===0);
    await step(mode+' gameplay scenarios',()=>play(game!,lb!));if(opts.get('--one-win')==='true'){await capture(lb,'one-win-leaderboard');continue;}
    await step(mode+' share in two refreshes',async()=>{let count=0;for(let refresh=0;refresh<=2;refresh++){count=await lb!.page.locator('.ai-ranking .ranking-row').count();if(count>=10){check(mode+' shared count',true,{count,refresh});return;}if(refresh<2)await lb!.page.getByRole('button',{name:'새로고침',exact:true}).click();await new Promise(r=>setTimeout(r,150));}throw Error('Less than ten records after two refreshes: '+count);});
    await step(mode+' leaderboard layout capture',()=>capture(lb!,'leaderboard'));await step(mode+' selection/search/admin draft/scroll',()=>selection(lb!));
    await step(mode+' day-round restart persistence',async()=>{lb=await displayRestart(lb!,lbSource);});
    await step(mode+' reset raw preservation',()=>reset(lb!));if(mode==='nas'){await step('synthetic HTTPS negative auth/TLS',security);if(game&&owned.has(game))await close(game);if(lb&&owned.has(lb))await close(lb);for(const negative of ['missing-credentials','untrusted-ca'] as const)await packagedNegative(gameSource,negative);}
   }finally{if(game&&owned.has(game))await close(game);if(lb&&owned.has(lb))await close(lb);if(nas){const rateLimitRejections=nas.requests.filter((r:any)=>r.status===429);check('nas no observed HTTP 429 throughout unchanged-limiter run',rateLimitRejections.length===0,rateLimitRejections);json(path.join(output,'nas-requests.json'),nas.requests);await new Promise<void>(r=>nas.server.close(()=>r()));await nas.app.close();nas=undefined;}}
  }
 }finally{for(const a of [...owned])await close(a);await cleanupPending();report.completedAt=new Date().toISOString();report.status='PARTIAL';flush();}
 if(modes.includes('review'))for(const role of ['game','leaderboard'] as Role[])await ordinaryLifecycle(role,opts.get('--review-'+role)!);
 const profileRoot=path.resolve('deployment/nas-production/device-profiles');const profiles=fs.readdirSync(profileRoot).filter(n=>n.endsWith('.device-profile.json')).map(n=>({file:n,sha256:sha(path.join(profileRoot,n)),profile:JSON.parse(fs.readFileSync(path.join(profileRoot,n),'utf8'))}));report.profileMapping={method:'source profile configuration check, not five physical PCs',profiles};check('five unique official-only device profiles',profiles.length===5&&new Set(profiles.map(p=>p.profile.deviceId)).size===5&&profiles.every(p=>p.profile.sessions.official&&!p.profile.sessions.practice));
 const runtimeErrors=observedRuntimeFailures(report);check('no unhandled renderer errors or unintended runtime closure',runtimeErrors.length===0,runtimeErrors);const verdicts=runtimeVerdicts(report);report.status=verdicts.overall;report.automatedSubset=verdicts.automatedSubset;report.completedAt=new Date().toISOString();flush();
 console.log(JSON.stringify({output,status:report.status,captures:report.captures.length,failed:report.checks.filter((c:any)=>c.passed===false).map((c:any)=>c.name)}));
}

function createLocalHttpsCertificate(certRoot: string): {
  pfxPath: string;
  caPemPath: string;
  passphrase: string;
} {
  fs.mkdirSync(certRoot, { recursive: true });
  const pfxPath = path.join(certRoot, "localhost.pfx");
  const caPemPath = path.join(certRoot, "ca.pem");
  const passphrase = `typingking-packaged-smoke-${process.pid}`;
  const script = String.raw`
$ErrorActionPreference = "Stop"
$pfxPath = [Environment]::GetEnvironmentVariable("TK_SMOKE_PFX_PATH")
$caPemPath = [Environment]::GetEnvironmentVariable("TK_SMOKE_CA_PEM_PATH")
$password = [Environment]::GetEnvironmentVariable("TK_SMOKE_PFX_PASSWORD")
$notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
$notAfter = [DateTimeOffset]::UtcNow.AddDays(1)

$caKey = [Security.Cryptography.RSA]::Create(2048)
$caRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
  "CN=TypingKing Packaged Smoke Root",
  $caKey,
  [Security.Cryptography.HashAlgorithmName]::SHA256,
  [Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$caRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true)
)
$caUsage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
$caRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($caUsage, $true)
)
$caRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($caRequest.PublicKey, $false)
)
$caCertificate = $caRequest.CreateSelfSigned($notBefore, $notAfter)

$serverKey = [Security.Cryptography.RSA]::Create(2048)
$serverRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
  "CN=localhost",
  $serverKey,
  [Security.Cryptography.HashAlgorithmName]::SHA256,
  [Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$serverRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
)
$serverUsage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
$serverRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($serverUsage, $true)
)
$ekuOids = [Security.Cryptography.OidCollection]::new()
[void]$ekuOids.Add([Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1"))
$serverRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($ekuOids, $true)
)
$san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName("localhost")
$san.AddIpAddress([Net.IPAddress]::Parse("127.0.0.1"))
$serverRequest.CertificateExtensions.Add($san.Build())
$serverRequest.CertificateExtensions.Add(
  [Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($serverRequest.PublicKey, $false)
)
$serial = [byte[]]::new(16)
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($serial)
$rng.Dispose()
$serial[0] = $serial[0] -band 0x7f
$serial[15] = $serial[15] -bor 1
$issued = $serverRequest.Create($caCertificate, $notBefore, $notAfter, $serial)
$serverCertificate = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($issued, $serverKey)

[IO.File]::WriteAllBytes(
  $pfxPath,
  $serverCertificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password)
)
$base64 = [Convert]::ToBase64String(
  $caCertificate.RawData,
  [Base64FormattingOptions]::InsertLineBreaks
)
$pem = "-----BEGIN CERTIFICATE-----" + [Environment]::NewLine + $base64 + [Environment]::NewLine + "-----END CERTIFICATE-----" + [Environment]::NewLine
[IO.File]::WriteAllText($caPemPath, $pem, [Text.Encoding]::ASCII)

$serverCertificate.Dispose()
$issued.Dispose()
$serverKey.Dispose()
$caCertificate.Dispose()
$caKey.Dispose()
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: buildPackagedSmokeChildEnvironment({
      TK_SMOKE_PFX_PATH: pfxPath,
      TK_SMOKE_CA_PEM_PATH: caPemPath,
      TK_SMOKE_PFX_PASSWORD: passphrase
    })
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || !fs.existsSync(pfxPath) || !fs.existsSync(caPemPath)) {
    throw new Error(`Local HTTPS certificate generation failed: ${result.stderr || result.stdout || result.status}`);
  }
  return { pfxPath, caPemPath, passphrase };
}



function nasHttp(method:string,route:string,role:'writer'|'leaderboard'|'operator',body?:any):Promise<any>{
 const device=role==='writer'?'PC01':'LEADERBOARD01',token=role==='writer'?nas.tokens.PC01:role==='operator'?nas.tokens.LEADERBOARD01_OPERATOR:nas.tokens.LEADERBOARD01;
 return pacedRequest('nas','actual HTTPS '+method+' '+route,()=>new Promise<any>(resolve=>{const request=https.request(nas.baseUrl+route,{method,ca:fs.readFileSync(nas.cert.caPemPath),headers:{'x-device-id':device,authorization:'Bearer '+token,...(body?{'content-type':'application/json','idempotency-key':body.row?.record_id??''}:{})}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{let data:any;try{data=JSON.parse(text);}catch{data=text;}resolve({status:res.statusCode,data});});});request.on('error',e=>resolve({error:String(e)}));request.end(body?JSON.stringify(body):undefined);}));
}
async function seedSecondSession(){
 const actual=report.actualUiRecords.find((r:any)=>r.mode==='nas'&&r.label==='win');assert.ok(actual?.chain?.rawPath,'Verified actual NAS nested evidence chain required');
 const row=structuredClone(JSON.parse(fs.readFileSync(actual.chain.rawPath,'utf8')));assert.ok(row.recordEvidence?.canonicalAttempt,'Protected nested winning evidence required');assert.equal(row.canonicalAttempt,undefined,'Do not add flat canonical ranking fields');
 const uuid=crypto.randomUUID();row.record_id='gsc26-pc01-'+uuid;row.recordEvidence.canonicalAttempt.recordId=row.record_id;row.recordEvidence.canonicalAttempt.attemptId='gsc26-attempt-'+uuid;assert.deepEqual(row.recordEvidence.battles,actual.input.recordEvidence.battles);
 const envelope={schema_version:1,event_id:GEUMCHEON_NAS_EVENT_ID,session:{kind:'official',session_id:'r7-synthetic-other-official',day_no:1,round_no:2},row};
 const posted=await nasHttp('POST','/api/v1/records','writer',envelope);assert.ok(posted.status===201||posted.status===200,JSON.stringify(posted));recordOracles.nas.invalidate();
 const listed=await nasHttp('GET','/api/v1/records?session_kind=official&session_id=r7-synthetic-other-official&day_no=1&round_no=2','leaderboard');assert.equal(listed.status,200);assert.equal(listed.data.rows.length,1);
 const raw=Object.fromEntries(Object.entries(files(nas.config.dataRoot)).filter(([k])=>k.endsWith(row.record_id+'.json')));assert.equal(Object.keys(raw).length,1);
 report.seededRecords.push({mode:'nas',method:'actual HTTPS POST, real validator, cloned genuine UI win with fresh paired IDs, second official session',recordId:row.record_id,response:posted,raw});flush();return {count:1,raw};
}

function scopedProcessSnapshot(scope:string){
 const root=path.resolve(scope);assert.ok(root.startsWith(path.resolve(output)+path.sep),'PROCESS_SCOPE_OUTSIDE_NEW_RUN');
 const command="$ErrorActionPreference='Stop';$scope=[IO.Path]::GetFullPath($env:TK_RUN_ROOT).TrimEnd('\\')+'\\';$rows=@(Get-Process -ErrorAction Stop|ForEach-Object{$p=$_;$file=$null;try{$file=$p.Path;if($file -and $file.StartsWith($scope,[StringComparison]::OrdinalIgnoreCase)){[pscustomobject]@{ProcessId=$p.Id;Name=$p.ProcessName;ExecutablePath=$file;CreatedAtUtc=$p.StartTime.ToUniversalTime().ToString('o')}}}catch{if($file -and $file.StartsWith($scope,[StringComparison]::OrdinalIgnoreCase)){throw}}});ConvertTo-Json -InputObject $rows -Depth 5 -Compress";
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',utf8PowerShellJson(command)],{env:{...process.env,TK_RUN_ROOT:root},encoding:'utf8',windowsHide:true,timeout:10000});
 if(result.error||result.status!==0||result.stderr.trim())throw Error('SCOPED_PROCESS_PROBE_FAILED:'+String(result.error??result.stderr));
 const rows=JSON.parse(result.stdout);assert.ok(Array.isArray(rows),'Scoped process probe requires an array');return rows;
}
function stopScopedObservedProcesses(scope:string,processes:any[]){
 const command="$ErrorActionPreference='Stop';$scope=[IO.Path]::GetFullPath($env:TK_RUN_ROOT).TrimEnd('\\')+'\\';$rows=@(foreach($item in @($env:TK_OWNED_JSON|ConvertFrom-Json)){try{$p=Get-Process -Id $item.ProcessId -ErrorAction Stop;$file=$p.Path;$start=$p.StartTime.ToUniversalTime().ToString('o');if($file -and $file.StartsWith($scope,[StringComparison]::OrdinalIgnoreCase) -and $file -eq $item.ExecutablePath -and $start -eq $item.CreatedAtUtc){Stop-Process -Id $p.Id -Force -ErrorAction Stop;[pscustomobject]@{pid=$item.ProcessId;status='stop-requested';path=$file;startedAt=$start}}else{[pscustomobject]@{pid=$item.ProcessId;status='identity-mismatch';path=$file;startedAt=$start}}}catch{[pscustomobject]@{pid=$item.ProcessId;status='stop-error-or-exited-during-stop';error=$_.Exception.Message}}});ConvertTo-Json -InputObject $rows -Depth 5 -Compress";
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',utf8PowerShellJson(command)],{env:{...process.env,TK_RUN_ROOT:path.resolve(scope),TK_OWNED_JSON:JSON.stringify(processes)},encoding:'utf8',windowsHide:true,timeout:10000});
 let observations:any;try{observations=JSON.parse(result.stdout);}catch{observations=null;}
 return {exitCode:result.status,error:result.error?String(result.error):undefined,stdout:result.stdout,stderr:result.stderr,observations,method:'Stop-Process only after exact case-directory path and start-time match; final absence checked separately'};
}
async function ordinaryLifecycle(role:Role,source:string){
 const base=path.join(output,'ordinary-noargs',role),dir=path.join(base,'empty-folder');fs.mkdirSync(dir,{recursive:true});const exe=path.join(dir,path.basename(source));fs.copyFileSync(source,exe,fs.constants.COPYFILE_EXCL);assert.equal(sha(exe),sha(source),'ORDINARY_EXE_SOURCE_HASH_MISMATCH');const env={...process.env,LOCALAPPDATA:path.join(base,'LocalAppData'),APPDATA:path.join(base,'AppData'),TEMP:path.join(base,'Temp'),TMP:path.join(base,'Temp')};for(const k of ['LOCALAPPDATA','APPDATA','TEMP'])fs.mkdirSync((env as any)[k],{recursive:true});for(const k of Object.keys(env))if(/TYPINGKING|APP_VARIANT|ELECTRON_RUN_AS_NODE|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED/.test(k))delete (env as any)[k];
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$p=Start-Process -FilePath $env:TK_EXE -WorkingDirectory $env:TK_DIR -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)"],{env:{...env,TK_EXE:exe,TK_DIR:dir},encoding:'utf8',windowsHide:true});const pid=Number(result.stdout.trim());assert.ok(pid>0,result.stderr);await new Promise(r=>setTimeout(r,5000));
 const evidence:any={role,exe,sha256:sha(exe),arguments:[],initialFolderFiles:[path.basename(exe)],pid,observedFiles:files(dir),networkIsolation:'NOT_RUN',visualStartup:'NOT_RUN',status:'PARTIAL',processProbeMethod:'Get-Process .NET Path/StartTime filtered to exact ordinary case; includes extracted Temp children',cleanupAttempts:[]};report.ordinaryNoArgument??=[];report.ordinaryNoArgument.push(evidence);report.checks.push({name:'review no-argument '+role,status:'PARTIAL',visualStartup:'NOT_RUN',networkIsolation:'NOT_RUN'});
 const known=new Set<number>([pid]);
 try{evidence.processes=scopedProcessSnapshot(base);for(let pass=0;pass<2;pass++){const processes=pass===0?evidence.processes:scopedProcessSnapshot(base);for(const p of processes)known.add(p.ProcessId);if(!processes.length)break;evidence.cleanupAttempts.push({at:new Date().toISOString(),processes,result:stopScopedObservedProcesses(base,processes)});await new Promise(r=>setTimeout(r,250));}}
 catch(e){evidence.cleanupProbeError=String(e);}
 evidence.postExit=await postExit(pid,[...known]);
 try{evidence.postExit.pathRemaining=scopedProcessSnapshot(base);evidence.postExit.allObservedAbsent=evidence.postExit.allObservedAbsent&&evidence.postExit.pathRemaining.length===0&&!evidence.cleanupProbeError;}catch(e){evidence.postExit.pathProbeError=String(e);evidence.postExit.allObservedAbsent=false;}
 flush();
}
async function postExit(pid:number,known:number[]=[]){
 const ids=[...new Set([pid,...known])];const attempts:any[]=[];let last=assessProcessAbsence(ids,[],'PROCESS_PROBE_NOT_RUN');
 const command="$ErrorActionPreference='Stop';$rows=@(foreach($item in $env:TK_PIDS.Split(',')){$id=[int]$item;try{$p=[Diagnostics.Process]::GetProcessById($id);$p.Refresh();[pscustomobject]@{pid=$id;exists=$true;name=$p.ProcessName}}catch{if($_.Exception -is [ArgumentException] -or $_.Exception.InnerException -is [ArgumentException]){[pscustomobject]@{pid=$id;exists=$false}}else{[pscustomobject]@{pid=$id;exists=$null;error=$_.Exception.Message}}}});ConvertTo-Json -InputObject $rows -Depth 4 -Compress";
 await until('all observed owned process IDs absent',()=>{const probe=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',utf8PowerShellJson(command)],{env:{...process.env,TK_PIDS:ids.join(',')},encoding:'utf8',windowsHide:true,timeout:10000});let observations:any[]=[];let error=probe.error||probe.status!==0||probe.stderr.trim()?String(probe.error??probe.stderr??probe.status):undefined;
  if(!error)try{observations=JSON.parse(probe.stdout);assert.ok(Array.isArray(observations));}catch(e){error='PROCESS_PROBE_INVALID_JSON:'+String(e);}
  last=assessProcessAbsence(ids,observations,error);attempts.push({at:new Date().toISOString(),exitCode:probe.status,observations,error});return last.allObservedAbsent;
 },8000).catch(e=>{last={...last,error:last.error??String(e)};});
 return {...last,method:'.NET Process.GetProcessById; explicit per-PID absence only, probe errors never imply absence',attempts};
}

async function cleanupPending(){
 for(const [pid,state]of pendingRoots){
  try{const snapshot=processTree(pid);state.pendingCleanup={snapshot};const errorWindow=snapshot.find(p=>p.MainWindowTitle==='Error');
   if(errorWindow){const observed=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;$p=Get-Process -Id $env:TK_ERROR_PID;$e=[Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle);$e.FindAll([Windows.Automation.TreeScope]::Subtree,[Windows.Automation.Condition]::TrueCondition)|ForEach-Object {$_.Current.Name}"],{env:{...process.env,TK_ERROR_PID:String(errorWindow.ProcessId)},encoding:'utf8',windowsHide:true,timeout:10000});state.nativeError={text:observed.stdout,error:observed.stderr};}
   const root=snapshot.find(p=>p.ProcessId===pid);if(root&&path.resolve(root.ExecutablePath)===path.resolve(state.exe)&&Date.parse(root.CreatedAtUtc)>=Date.parse(state.launchedAt)-5000){spawnSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true});state.pendingCleanup.forced=true;}else state.pendingCleanup.identityMatched=root===undefined;
  }catch(e){state.pendingCleanup={error:String(e),status:'HOLD'};}state.pendingCleanup.postExit=await postExit(pid,(state.pendingCleanup.snapshot??[]).map((p:any)=>p.ProcessId));pendingRoots.delete(pid);
 }
}

async function resetReviewFocused(source:string){
 const approved=path.resolve('Codex/Evidence/R7/after/runtime-review-d97e038-07/review/LocalAppData/ThePMD/TypingKing/Geumcheon2026/Review/official');const sourceRoot=path.resolve(source);assert.equal(sourceRoot,approved,'Only the approved completed run07 synthetic store may seed this focused test');assert.equal(fs.realpathSync.native(sourceRoot).toLowerCase(),sourceRoot.toLowerCase(),'Source root reparse/substitution rejected');const recordRelative=path.join('official','review-official-1','records');const original=reviewRecordSnapshot(path.join(sourceRoot,recordRelative));assert.equal(Object.keys(original).length,17);assert.ok(Object.values(original).every(v=>v.envelope.hidden===false));const relatives=[path.join('config','config.json'),...Object.keys(original).map(n=>path.join(recordRelative,n))];const sourceHashes=Object.fromEntries(relatives.map(relative=>{const file=path.join(sourceRoot,relative);assert.ok(fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink());assert.equal(fs.realpathSync.native(file).toLowerCase(),file.toLowerCase());return [relative,sha(file)];}));
 const dest=path.join(output,'review','LocalAppData','ThePMD','TypingKing','Geumcheon2026','Review','official');for(const relative of relatives){const target=path.join(dest,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(sourceRoot,relative),target,fs.constants.COPYFILE_EXCL);assert.equal(sha(target),sourceHashes[relative]);}report.method='Actual audited review leaderboard EXE; focused reset on exclusive copy of 17 prior genuine/explicit seeded synthetic records plus config; original read-only; no copied userData, no NAS';report.resetFocused={sourceRoot,destinationRoot:dest,sourceManifest:sourceHashes,copiedFiles:relatives.length,sourceRun:'runtime-review-d97e038-07',originalResetFailure:'EBUSY during broad Review-root hash before reset; exact file was not recorded and is not retrospectively inferred'};flush();
 let a:Running|undefined;try{const exe=opts.get('--review-leaderboard');assert.ok(exe);a=await launch('review','leaderboard',exe);await a.page.locator('.leaderboard-app').waitFor();await until('focused copied rows visible',()=>a!.page.locator('.ai-ranking .ranking-row').count().then(n=>n===17));const before=await listSaved(a);assert.equal(before.length,17);check('focused copied actual record IDs preserved',before.every((r:any)=>Object.values(original).some(v=>v.envelope.row.record_id===r.record_id)));await capture(a,'focused-reset-before');await step('focused review reset contents preservation',()=>reset(a!));assert.equal(await a.page.locator('.ai-ranking .ranking-row').count(),0);await close(a);a=await launch('review','leaderboard',exe);await a.page.locator('.leaderboard-app').waitFor();assert.equal((await listSaved(a)).length,0);assert.equal(await a.page.locator('.ai-ranking .ranking-row').count(),0);await capture(a,'focused-reset-restart-empty');check('focused review reset persists after actual EXE restart',true);}catch(e){check('focused review reset execution',false,String(e));}finally{if(a&&owned.has(a))await close(a);await cleanupPending();check('focused original run07 source file hashes unchanged',relatives.every(relative=>sha(path.join(sourceRoot,relative))===sourceHashes[relative]),{count:relatives.length});report.status=overallStatus(report);report.completedAt=new Date().toISOString();flush();}console.log(JSON.stringify({output,status:report.status,captures:report.captures.length}));
}
function rawNasRecord(recordId:string){
 const matches=Object.keys(files(nas.config.dataRoot)).filter(k=>k.endsWith('/incoming/ai/'+recordId+'.json'));assert.equal(matches.length,1,'Exactly one protected raw record required');const rawPath=path.join(nas.config.dataRoot,matches[0]);return {rawPath,rawSha256:sha(rawPath),row:JSON.parse(fs.readFileSync(rawPath,'utf8'))};
}
function assessPublicStoredWin(input:any,row:any){
 const failures=assessCapturedCanonicalInput(input);if(!row?.record_id)return [...failures,'CAPTURED_STORED_ROW_MISSING'];const expected:any=buildRecordRow(input);for(const key of Object.keys(expected)){if(['created_at','completed_at','recordEvidence'].includes(key))continue;if(!isDeepStrictEqual(row[key],expected[key]))failures.push('CAPTURED_PUBLIC_ROW_MISMATCH:'+key);}return failures;
}
function verifyNasEvidenceChain(input:any,publicRow:any,observedAt:string){
 assert.ok(input.recordEvidence?.schemaVersion===1,'Actual renderer nested raw evidence missing');assert.deepEqual(input.recordEvidence.canonicalAttempt,input.canonicalAttempt);
 const requests=nas.requests.filter((r:any)=>r.method==='POST'&&r.time>=observedAt).map((r:any)=>({...r,envelope:JSON.parse(r.requestBody)})).filter((r:any)=>r.envelope.row?.record_id===publicRow.record_id);assert.ok(requests.length>0,'Actual EXE POST with correlated ID missing');assert.ok(requests.every((r:any)=>r.status===200||r.status===201),'Actual POST rejected');const posted=requests[0].envelope.row;assert.ok(posted.recordEvidence);assert.equal(posted.canonicalAttempt,undefined,'Protected evidence must not introduce flat canonical ranking fields');assert.deepEqual(posted.recordEvidence.battles,input.recordEvidence.battles,'Raw float battle evidence changed across renderer/main/POST');
 const withoutIdentity=(value:any)=>{const clone=structuredClone(value);for(const k of ['recordId','attemptId','deviceId','recordedAt','contradictionCodes'])delete clone[k];return clone;};assert.deepEqual(withoutIdentity(posted.recordEvidence.canonicalAttempt),withoutIdentity(input.recordEvidence.canonicalAttempt),'Canonical score/fairness evidence changed beyond trusted identity');const canonical=posted.recordEvidence.canonicalAttempt;assert.equal(canonical.recordId,publicRow.record_id);assert.equal(canonical.attemptId,'gsc26-attempt-'+publicRow.record_id.slice('gsc26-pc01-'.length));assert.equal(canonical.deviceId,'PC01');assert.deepEqual(canonical.contradictionCodes,[]);assert.ok(Number.isFinite(Date.parse(canonical.recordedAt)));
 const raw=rawNasRecord(publicRow.record_id);assert.deepEqual(raw.row,posted,'Service protected raw JSON differs from actual POST');assert.equal(publicRow.recordEvidence,undefined,'Protected raw evidence leaked into authenticated public list');assert.equal(publicRow.canonicalAttempt,undefined,'Flat canonical ranking field unexpectedly added');const publicScores=Object.keys(posted).filter(k=>/cpm|accuracy|time_ms|char_count|vs_ai_result|result_stage/.test(k));for(const key of publicScores)assert.equal(publicRow[key],posted[key],'Public legacy score changed: '+key);
 return {status:'PASS',method:'Actual renderer nested input -> trusted identity-only POST -> protected raw exact deep equality -> authenticated public row same ID and legacy scores, no evidence leakage',rawPath:raw.rawPath,rawSha256:raw.rawSha256,postTimes:requests.map((r:any)=>r.time),postStatuses:requests.map((r:any)=>r.status),postedEvidenceSha256:hash(JSON.stringify(posted.recordEvidence)),publicScoreKeys:publicScores};
}
async function pacedActualWins(a:Running,reader:Running,observe:(label:string,result:string,reached:number,participant?:string)=>Promise<void>){
 const p=a.page;for(const [index,latency]of [1200,2700].entries()){const name='합성속도검증'+(index+1);await p.locator('.entry-panel').waitFor();await p.locator('.entry-form-group input').first().fill(name);await p.locator('.phone-row input').nth(0).fill('009'+index);await p.locator('.phone-row input').nth(1).fill('223'+index);for(const[n,v]of ['2012','1','2'].entries())await p.locator('.birth-row select').nth(n).selectOption(v);await p.locator('.entry-form-group input[type="checkbox"]').check();await p.locator('.entry-panel .button-row .primary-button').click();for(let stage=1;stage<=3;stage++){const input=p.locator('textarea.typing-input');await until('paced actual stage enabled',()=>input.isEnabled());await new Promise(r=>setTimeout(r,latency));await input.fill((await p.locator('.duel-target').first().innerText()).replace(/\u00a0/g,' ').trim());await p.locator('.challenge-modal').waitFor();assert.equal(await p.locator('.challenge-modal-message h2').innerText(),'승리했습니다.\n금나래보다 빠르게 입력했습니다.');await p.locator('.challenge-modal .primary-button').click();}await p.locator('.challenge-result-panel').waitFor();await capture(a,'paced-win-'+(index+1));await observe('paced-win-'+(index+1),'PARTICIPANT_WIN',3,name);await p.getByRole('button',{name:'메인화면으로 가기',exact:true}).click();}
 await reader.page.getByRole('button',{name:'새로고침',exact:true}).click();const wins=report.actualUiRecords.filter((r:any)=>r.mode===a.mode&&['win','paced-win-1','paced-win-2'].includes(r.label));assert.equal(wins.length,3);await until('three genuine different-speed winners in actual leaderboard',async()=>{const ids=await reader.page.locator('.ai-ranking .ranking-row').evaluateAll(rows=>rows.map(r=>r.getAttribute('data-leaderboard-record')));return wins.every((w:any)=>ids.includes(w.recordId));});const ids=await reader.page.locator('.ai-ranking .ranking-row').evaluateAll(rows=>rows.map(r=>r.getAttribute('data-leaderboard-record')));const sorted=[...wins].sort((x:any,y:any)=>Number(y.row.final_cpm)-Number(x.row.final_cpm));check(a.mode+' three genuine different-CPM wins ordered',new Set(wins.map((w:any)=>w.row.final_cpm)).size===3&&sorted.every((w:any,i:number)=>i===0||ids.indexOf(sorted[i-1].recordId)<ids.indexOf(w.recordId)),{method:'Three actual UI wins with intentional participant input latency; no fabricated score columns',wins:wins.map((w:any)=>({recordId:w.recordId,totalTimeMs:w.row.total_time_ms,finalCpm:w.row.final_cpm})),displayOrder:ids});await capture(reader,'genuine-different-speed-ranking');
}
function watchNativeExit(pid:number,state:any){
 // Read-only wait on this exact owned root. Exit code is an observation, not a claimed shutdown cause.
 const observer=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',`try {$p=Get-Process -Id ${pid} -ErrorAction Stop;$started=$p.StartTime.ToUniversalTime().ToString('o');$p.WaitForExit();[pscustomobject]@{pid=${pid};startedAt=$started;exitedAt=[DateTime]::UtcNow.ToString('o');exitCode=$p.ExitCode}|ConvertTo-Json -Compress} catch {[pscustomobject]@{pid=${pid};error=$_.Exception.Message}|ConvertTo-Json -Compress}`],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';observer.stdout.on('data',b=>stdout+=b);observer.stderr.on('data',b=>stderr+=b);observer.on('error',e=>{state.nativeExitObservation={error:String(e)};flush();});observer.on('close',code=>{try{state.nativeExitObservation=JSON.parse(stdout.trim());}catch{state.nativeExitObservation={observerExitCode:code,stdout,stderr};}flush();});
}
function nativeWindowObservation(a:Running):any{
 const ids=processTree(a.pid).map((p:any)=>Number(p.ProcessId));a.state.observedProcessIds=[...new Set([...(a.state.observedProcessIds??[]),...ids])];if(!ids.length)return {error:'OWNED_PROCESS_TREE_EMPTY'};
 const cs=`using System;using System.Runtime.InteropServices;public class R7WindowRead{public delegate bool CB(IntPtr h,IntPtr p);[StructLayout(LayoutKind.Sequential)]public struct R{public int left,top,right,bottom;}[StructLayout(LayoutKind.Sequential)]public struct M{public int size;public R monitor,work;public uint flags;}[DllImport("user32.dll")]public static extern bool EnumWindows(CB c,IntPtr p);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);[DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr h,int n);[DllImport("user32.dll")]public static extern IntPtr MonitorFromWindow(IntPtr h,uint f);[DllImport("user32.dll")]public static extern bool GetMonitorInfo(IntPtr h,ref M m);}`;
 const command=`Add-Type -TypeDefinition '${cs}';$ids=@(${ids.join(',')});$rows=[Collections.Generic.List[object]]::new();[R7WindowRead]::EnumWindows({param($h,$unused) $wp=0;[void][R7WindowRead]::GetWindowThreadProcessId($h,[ref]$wp);if(($ids -contains $wp) -and [R7WindowRead]::IsWindowVisible($h)){$r=[R7WindowRead+R]::new();[void][R7WindowRead]::GetWindowRect($h,[ref]$r);$m=[R7WindowRead+M]::new();$m.size=[Runtime.InteropServices.Marshal]::SizeOf($m);[void][R7WindowRead]::GetMonitorInfo([R7WindowRead]::MonitorFromWindow($h,2),[ref]$m);$style=[R7WindowRead]::GetWindowLong($h,-16);$rows.Add([pscustomobject]@{pid=$wp;handle=$h.ToInt64();rect=$r;monitor=$m.monitor;style=$style;caption=(($style -band 12582912) -ne 0)})};return $true},[IntPtr]::Zero)|Out-Null;ConvertTo-Json -InputObject @($rows.ToArray()) -Depth 5 -Compress`;
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',utf8PowerShellJson(command)],{windowsHide:true,encoding:'utf8'});try{const rows=JSON.parse(r.stdout.trim());const windows=(Array.isArray(rows)?rows:[rows]).filter(w=>w.rect.right-w.rect.left>500&&w.rect.bottom-w.rect.top>400);if(windows.length!==1)return {error:'NATIVE_WINDOW_NOT_UNIQUE',windows};const w=windows[0];return {...w,method:'Read-only Win32 owned visible window/monitor bounds and caption style; no renderer emulation',borderlessMonitorFill:!w.caption&&['left','top','right','bottom'].every(k=>Math.abs(w.rect[k]-w.monitor[k])<=1)};}catch{return {error:'NATIVE_WINDOW_READ_FAILED',stderr:r.stderr,stdout:r.stdout};}
}
async function fullscreenKeys(a:Running){await a.page.bringToFront();
 const cdp=await a.page.context().newCDPSession(a.page);try{await cdp.send('Emulation.clearDeviceMetricsOverride');}finally{await cdp.detach();}
 const observations:any[]=[nativeWindowObservation(a)];
 // CDP keyboard experiment only; not native OS input. No setFullScreen IPC or viewport emulation.
 for(let press=1;press<=2;press++){await a.page.keyboard.press('F11');let current:any;await until('CDP F11 experiment transition',()=>{current=nativeWindowObservation(a);return !current.error&&!observations[0].error&&current.borderlessMonitorFill===(press===1?!observations[0].borderlessMonitorFill:observations[0].borderlessMonitorFill);},6000).catch(()=>{});observations.push(current);await a.page.screenshot({path:path.join(output,`${a.mode}-${a.role}-F11-${press}-cdp-experiment.png`)});}
 a.state.f11={input:'page.keyboard.press(F11) twice',method:'CDP F11 experiment; not native OS keyboard proof',observations,rendererEmulationUsed:false,nativeF11Status:'NOT_RUN'};
 if(observations.some(o=>!o||o.error)){report.checks.push({name:a.mode+' '+a.role+' CDP F11 experiment window observation',status:'HOLD',reason:'Native window observation unavailable/ambiguous',observations});flush();return;}
 check(a.mode+' '+a.role+' CDP F11 experiment monitor-fill toggle and restore',observations[1].borderlessMonitorFill!==observations[0].borderlessMonitorFill&&observations[2].borderlessMonitorFill===observations[0].borderlessMonitorFill&&['left','top','right','bottom'].every(k=>Math.abs(observations[2].rect[k]-observations[0].rect[k])<=2),observations);
}
function approvedEventCaretColor(){
 const configPath=path.resolve('events/geumcheon-2026/event.config.json');const configSha256=sha(configPath);const hex=JSON.parse(fs.readFileSync(configPath,'utf8')).theme?.accentColor;
 assert.equal(hex,'#C40080','Preserved approved accent changed; v3 asset mappings may legitimately change config SHA');assert.ok(typeof hex==='string'&&/^#[0-9a-f]{6}$/i.test(hex),'Approved event accent must be RGB hex');
 return {configPath,configSha256,hex,cssRgb:'rgb('+[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).join(', ')+')'};
}
async function continuousCaretFrames(a:Running,name:string,width:number,height:number){await a.page.bringToFront();
 const root=path.join(output,'continuous-renderer',`${a.mode}-${name}-${width}x${height}`);fs.mkdirSync(root,{recursive:true});const cdp=await a.page.context().newCDPSession(a.page);const clip:any={method:'CDP Page.startScreencast event-driven frames plus DOM timeline; not OS video/native F11/human IME',mode:a.mode,stage:name,width,height,startedAt:new Date().toISOString(),status:'NOT_RUN',frames:[],timeline:[],inputMethod:'Playwright fill of correct synthetic prefix; no score/date manipulation',limits:{maxFrames:80,maxDurationMs:8000},nativeFullscreen:'NOT_RUN',statusScope:'Automated renderer timeline observations only; PASS does not prove visible blinking caret pixels',manualContinuousFrameReview:{status:'NOT_RUN',scope:'Inspect continuous frames for bottom-only native caret blinking pixels and absence of target-text caret'}};report.continuousRenderer??=[];report.continuousRenderer.push(clip);const started=Date.now();
 const onFrame=(event:any)=>{if(clip.frames.length<80&&Date.now()-started<8000){const bytes=Buffer.from(event.data,'base64');const file=path.join(root,`frame-${String(clip.frames.length).padStart(4,'0')}.png`);fs.writeFileSync(file,bytes,{flag:'wx'});clip.frames.push({file,sha256:hash(bytes),receivedAt:new Date().toISOString(),metadata:event.metadata});}void cdp.send('Page.screencastFrameAck',{sessionId:event.sessionId}).catch(()=>{});};cdp.on('Page.screencastFrame',onFrame);
 try{await cdp.send('Page.startScreencast',{format:'png',maxWidth:width,maxHeight:height,everyNthFrame:1});for(let sample=0;sample<7;sample++){if(sample===2){const target=(await a.page.locator('.duel-target').first().innerText()).replace(/\u00a0/g,' ').trim();const prefix=Array.from(target).slice(0,width===1280?1:2).join('');await a.page.locator('textarea.typing-input').fill(prefix);}const state=await a.page.evaluate(()=>{const input=document.querySelector('textarea.typing-input') as HTMLTextAreaElement|null;const target=document.querySelector('.duel-target');return {at:performance.now(),innerWidth,innerHeight,focused:document.activeElement===input,disabled:input?.disabled,value:input?.value,selectionStart:input?.selectionStart,selectionEnd:input?.selectionEnd,caretColor:input?getComputedStyle(input).caretColor:null,expectedCaretColor:input?getComputedStyle(input).getPropertyValue('--accent').trim():null,fakeCaretCount:document.querySelectorAll('.typing-cursor-anchor,.typing-cursor').length,inputRect:input?.getBoundingClientRect().toJSON(),targetRect:target?.getBoundingClientRect().toJSON()};});clip.timeline.push({receivedAt:new Date().toISOString(),phase:sample<2?'before-prefix':'after-prefix',latestFrame:clip.frames.length-1,...state});await new Promise(r=>setTimeout(r,150));}const expected=approvedEventCaretColor();clip.independentExpectedCaret=expected;const caretColors=clip.timeline.map((s:any)=>({actual:s.caretColor,expectedAccent:s.expectedCaretColor}));check(a.mode+' '+name+' '+width+' continuous renderer caret color',caretColors.every((s:any)=>s.actual===expected.cssRgb),{samples:caretColors,independentExpected:expected,scope:'Computed CSS color compared to SHA-pinned event config, not sampled CSS variable; not visible pixel proof'});report.checks.push({name:a.mode+' '+name+' '+width+' continuous caret blinking pixels manual review',status:'NOT_RUN',reason:'Continuous renderer frames require separate manual review; timeline PASS is not blinking-pixel PASS'});clip.status=clip.frames.length>=2&&clip.timeline.length===7&&clip.timeline.every((s:any)=>s.fakeCaretCount===0&&s.focused&&!s.disabled&&s.inputRect?.top>=s.targetRect?.bottom-1&&s.innerWidth===width&&s.innerHeight===height)?'PASS':'FAIL';check(`${a.mode} ${name} ${width} continuous renderer caret timeline`,clip.status==='PASS',{frames:clip.frames.length,samples:clip.timeline.length,scope:clip.method});}catch(e){clip.status='HOLD';clip.error=String(e);report.checks.push({name:`${a.mode} ${name} ${width} continuous renderer frames`,status:'HOLD',reason:String(e)});}finally{await cdp.send('Page.stopScreencast').catch(()=>{});cdp.off('Page.screencastFrame',onFrame);await cdp.detach();clip.completedAt=new Date().toISOString();json(path.join(root,'index.json'),clip);flush();}
}
function observeLeaderboardMatrix(a:Running,name:string,width:number,height:number,o:any){
 const geometry=o.geometry;const state=o.rowCount===0?'empty':o.rowCount>=10?(geometry['.ranking-body']?.scrollTop>0?'many-scrolled':'many'):'few';
 report.leaderboardMatrix??=[];const item={mode:a.mode,name,width,height,state,rowCount:o.rowCount,measurementMode:'renderer viewport only; native window/fullscreen matrix NOT_RUN',geometry};
 const first=report.leaderboardMatrix.find((v:any)=>v.mode===a.mode&&v.width===width&&v.height===height);report.leaderboardMatrix.push(item);
 const selectors=['.leaderboard-board','.ranking-table','.leaderboard-session','.ranking-body','.ai-head','@painted-logo'];
 if(first){const differences=compareStableBoxes(first.geometry,geometry,selectors);check(a.mode+' '+name+' '+width+' table geometry stable across records and scroll',differences.length===0,{baselineState:first.state,currentState:state,tolerancePx:2,headerWidthPolicy:'Add observed native body scrollbar width to header width on both snapshots only',differences});}
 const frozen=beforeCapture('leaderboard','leaderboard',width)??beforeCapture('leaderboard','admin-validated',width);assert.ok(frozen?.presentation?.geometry,'Frozen actual before leaderboard geometry required');const expected=frozen.presentation.geometry;
 const differences=compareStableBoxes(expected,geometry,['.leaderboard-board','.ranking-table','.leaderboard-session','.ranking-body','.ai-head']);
 check(a.mode+' '+name+' '+width+' U10 original outer inner body header boxes preserved',differences.length===0,{sourceScreenshot:frozen.screenshot,sourceIndexSha256:sha(BEFORE_INDEX),tolerancePx:2,differences,headerWidthPolicy:'Native scrollbar width measured independently per snapshot, not relaxed tolerance'});
 if(opts.has('--lb-geometry-reference')){
  const referencePath=path.resolve(opts.get('--lb-geometry-reference')!);const reference=JSON.parse(fs.readFileSync(referencePath,'utf8'));const measuredPath=path.resolve(reference.sourceData.path);assert.equal(sha(measuredPath),reference.sourceData.sha256.toLowerCase(),'Legacy measured table data SHA mismatch');
  const measured=JSON.parse(fs.readFileSync(measuredPath,'utf8'));const viewport=width+'x'+height;const expected=reference.viewports?.[viewport];assert.ok(expected,'Legacy table reference viewport missing');
  for(const [selector,element]of Object.entries({'.leaderboard-board':'rankOuter','.ranking-table':'rankInner'})){for(const key of ['x','y','width','height'])assert.equal(expected[selector][key],measured.elements[element].targets[viewport][key],'Legacy table reference differs from measured source');const differences=compareStableBoxes(expected,geometry,[selector]);check(a.mode+' '+name+' '+width+' retained measured table '+selector,differences.length===0,{referencePath,differences});}
  report.supersededLegacyReference={logo:'Old stretched paintedLogo and clipped header policy superseded by U10 alpha>=8 proportional boundary alignment',controls:'U11 permits controls-only two-row rearrangement; current minimum sizes and clearance checked separately'};
 }
 flush();
}
let frozenBefore:any;
function beforeCapture(role:Role,name:string,width:number){
 if(!frozenBefore){const fixed=JSON.parse(fs.readFileSync(BEFORE_GEOMETRY,'utf8'));assert.equal(sha(BEFORE_INDEX),fixed.sourceIndexSha256,'Frozen before index SHA mismatch');const receipt=JSON.parse(fs.readFileSync(path.join(path.dirname(BEFORE_GEOMETRY),'BEFORE_REVIEW_EXECUTION_RECEIPT.json'),'utf8'));assert.equal(sha(path.join(path.dirname(BEFORE_INDEX),'..','uiv3-runtime-check.before.ts')),receipt.harnessSha256,'Frozen before harness SHA mismatch');frozenBefore=JSON.parse(fs.readFileSync(BEFORE_INDEX,'utf8'));report.beforeReference={geometryPath:BEFORE_GEOMETRY,geometrySha256:sha(BEFORE_GEOMETRY),indexPath:BEFORE_INDEX,indexSha256:sha(BEFORE_INDEX),harnessSha256:receipt.harnessSha256};}
 return frozenBefore.captures.find((c:any)=>c.role===role&&c.name===name&&c.geometry.innerWidth===width);
}
async function diagnosticOverlay(a:Running,name:string,width:number,height:number,marks:{label:string;rect:any;color:string}[]){
 const valid=marks.filter(m=>m.rect&&Number.isFinite(m.rect.x)&&Number.isFinite(m.rect.y));
 const selector='[data-uiv3-diagnostic-overlay]';assert.equal(await a.page.locator(selector).count(),0,'Diagnostic overlay already exists');
 try{await a.page.evaluate(marks=>{const layer=document.createElement('div');layer.dataset.uiv3DiagnosticOverlay='true';Object.assign(layer.style,{position:'fixed',inset:'0',pointerEvents:'none',zIndex:'2147483647'});for(const m of marks){const box=document.createElement('div');Object.assign(box.style,{position:'absolute',left:m.rect.x+'px',top:m.rect.y+'px',width:m.rect.width+'px',height:m.rect.height+'px',outline:'1px solid '+m.color,color:m.color,font:'12px monospace',background:'transparent'});box.textContent=m.label;layer.append(box);}document.body.append(layer);},valid);const file=path.join(output,'diagnostic',a.mode+'-'+a.role+'-'+name+'-'+width+'x'+height+'.png');fs.mkdirSync(path.dirname(file),{recursive:true});await a.page.screenshot({path:file});report.captures.at(-1).diagnostic={file,sha256:sha(file),scope:'Overlay over captured actual renderer; clean screenshot saved before overlay',marks:valid};}finally{await a.page.locator(selector).evaluateAll(nodes=>nodes.forEach(node=>node.remove()));}
}
async function v3FixedPresentation(a:Running,name:string,width:number,height:number,geometry:any){
 const r=geometry.rects,label=a.mode+' '+name+' '+width;const main=name==='main'||name==='main-error'||name==='main-consent';
 const baseline=beforeCapture(a.role,main?'main':name,width);const prior=baseline?.geometry.rects;
 if(main){
  assert.ok(prior,'Frozen main baseline required');
  const fixed=['.hero-panel','.geumcheon-main-title-image','.hero-copy','.geumcheon-main-robot','.hero-guide-card','.hero-guide-list','.entry-panel','.entry-form-group','.entry-form-group .field'];
  const differences=compareStableBoxes(prior,r,fixed);check(label+' U02 U03 U04 fixed title character guide panel and form slots',differences.length===0,{differences});
  const panel=r['.entry-panel'],group=r['.entry-event-copy'],nameLabel=r['.entry-form-group .field > span'];const A=panel?.top+parseFloat(panel?.borderTopWidth??'0'),B=nameLabel?.top;
  const typography=['.entry-event-copy strong','.entry-event-copy span'].map(selector=>{const before=prior[selector],after=r[selector];const expectedFont=parseFloat(before.fontSize)*1.30;const oldSpacing=before.letterSpacing==='normal'?0:parseFloat(before.letterSpacing);return {selector,before,after,expectedFont,expectedLetterSpacing:oldSpacing+.02*expectedFont,fontError:Math.abs(parseFloat(after?.fontSize)-expectedFont),lineHeightError:Math.abs(parseFloat(after?.lineHeight)/parseFloat(after?.fontSize)-parseFloat(before.lineHeight)/parseFloat(before.fontSize)),spacingError:Math.abs(parseFloat(after?.letterSpacing)-(oldSpacing+.02*expectedFont)),centerError:Math.abs((after?.left+after?.right)/2-(panel.left+panel.right)/2)};});
  check(label+' U04 fonts 1.30 spacing +0.02em and preserved line-height ratio',typography.every(t=>t.fontError<=.05&&t.lineHeightError<=.005&&t.spacingError<=.05&&t.after.align==='center'&&t.centerError<=2),typography);
  check(label+' U04 group centered between inner border and name label',Boolean(group&&nameLabel)&&Math.abs((group.top+group.bottom)/2-(A+B)/2)<=2&&Math.abs((group.left+group.right)/2-(panel.left+panel.right)/2)<=2&&(height!==720||(group.top-A>=12&&B-group.bottom>=12)),{A,B,group,nameLabel,horizontalCenter:(panel.left+panel.right)/2});
  const images=geometry.images;const title=images.find((i:any)=>i.src.endsWith(APPROVED_TITLE.fileName)),character=images.find((i:any)=>i.src.endsWith(APPROVED_MAIN.fileName));check(label+' U02 U03 exact mapped images are loaded',Boolean(title?.loaded&&character?.loaded&&title.width===2048&&title.height===682&&character.width===1254&&character.height===1254),{title,character});
  const styles=await a.page.locator('.geumcheon-main-title-image,.geumcheon-main-robot').evaluateAll(nodes=>nodes.map(e=>({objectFit:getComputedStyle(e).objectFit,opacity:getComputedStyle(e).opacity,filter:getComputedStyle(e).filter,transform:getComputedStyle(e).transform})));check(label+' U02 U03 contain original image without distortion',styles.length===2&&styles.every(s=>s.objectFit==='contain'&&s.opacity==='1'&&s.filter==='none'&&s.transform==='none'),styles);
  const buttons=['.entry-panel .primary-button','.entry-panel .secondary-button'].map(s=>r[s]);check(label+' start and administrator controls fully in content',buttons.every(b=>b&&b.width>0&&b.height>0&&b.left>=0&&b.right<=width&&b.top>=0&&b.bottom<=height),buttons);
  if(name==='main')report.checks.push({name:label+' individual before buttons position',status:'NOT_RUN',reason:'Frozen before capture queried .entry-actions but real selector is .button-row; aggregate panel/form positions checked, before individual button rectangles unavailable'});
  if(name!=='main-consent')await diagnosticOverlay(a,name,width,height,[{label:'fixed form',rect:r['.entry-form-group'],color:'#00ffcc'},{label:'A-B centered slogan',rect:group,color:'#ff00ff'}]);
 }
 if(name.startsWith('gameplay-stage')){
  assert.ok(prior,'Frozen stage baseline required');const left=r['.duel-panel:first-child'],right=r['.duel-panel:last-child'],guide=r['.challenge-guide'];const cards=[1,2,3].map(i=>r['.duel-panel:first-child .duel-metrics > :nth-child('+i+')']);
  const fixed=['.duel-panel:last-child','.duel-panel:first-child .duel-panel-header','.duel-panel:first-child .duel-target','.duel-panel:first-child .duel-input-layer','.duel-panel:first-child .duel-progress','.duel-panel:first-child .duel-metrics',...[1,2,3].map(i=>'.duel-panel:first-child .duel-metrics > :nth-child('+i+')')];const differences=compareStableBoxes(prior,r,fixed);
  const leftFixed=['x','y','width'].every(k=>Math.abs(left[k]-prior['.duel-panel:first-child'][k])<=2);
  const cardBottom=Math.max(...cards.map(c=>c?.bottom??Infinity)),innerBottom=left.bottom-parseFloat(left.borderBottomWidth);
  check(label+' U06 only left background bottom changes',leftFixed&&differences.length===0&&fixed.every(s=>r[s]?.fontSize===prior[s]?.fontSize)&&cards.every(Boolean)&&innerBottom-cardBottom>=12,{differences,left,cardBottom,innerBottom,clearance:innerBottom-cardBottom});
  const guideBefore=prior['.challenge-guide'];check(label+' U07 guide capsule separated and text retained',Boolean(guide)&&guide.top-Math.max(left.bottom,right.bottom)>=12&&height-guide.bottom>=12&&guide.text===guideBefore.text&&guide.align==='center'&&Math.abs(guide.x-guideBefore.x)<=2&&Math.abs(guide.width-guideBefore.width)<=2&&Math.abs(guide.height-guideBefore.height)<=2&&guide.fontSize===guideBefore.fontSize,{guide,guideBefore,panelBottom:Math.max(left.bottom,right.bottom),contentBottom:height});
  await diagnosticOverlay(a,name,width,height,[{label:'left background >=12px',rect:left,color:'#00ffcc'},{label:'card clearance',rect:r['.duel-panel:first-child .duel-metrics'],color:'#ffff00'},{label:'guide capsule',rect:guide,color:'#ff00ff'}]);
 }
 if(name.startsWith('win-stage')||name.startsWith('loss-stage')){
  assert.ok(prior,'Frozen result popup required');const differences=compareStableBoxes(prior,r,['.challenge-modal','.challenge-modal-message']);check(label+' U08 popup and message unchanged',differences.length===0,{differences});
  const oldArt=baseline.geometry.images.find((i:any)=>i.alt===(name.startsWith('win')?'패배한 AI':'승리한 AI'));const art=r['.challenge-modal-art'];check(label+' U08 existing image slot unchanged',Boolean(oldArt&&art)&&compareStableBoxes({art:oldArt.rect},{art},['art']).length===0,{before:oldArt?.rect,after:art});
  const mapped=geometry.images.filter((i:any)=>i.src.endsWith(APPROVED_STAGE1_ALPHA.fileName));check(label+' U08 new image only stage1 challenger victory',name==='win-stage-1'?mapped.length===1:mapped.length===0,{mapped:mapped.map((i:any)=>i.src)});
 }
 if(a.role==='game'&&(main||name.startsWith('gameplay-stage')||name==='final-victory')){const uiText=main?[r['.entry-form-group']?.text,await a.page.locator('.entry-form-group input').first().getAttribute('placeholder')].join('\n'):geometry.text;check(label+' U01 challenger UI terminology',!/(참여자|사용자(?:명| 이름| 기록| 타수| 승리))/.test(uiText),{text:uiText});}
 if(a.role==='game'&&name==='final-victory')check(label+' U09 final exact description only',geometry.text.includes('AI 금나래보다 빠르고 정확하게 완성했습니다.')&&!geometry.text.includes('합성실제도전 승리'),{text:geometry.text});
 flush();
}

async function stage1Alpha(a:Running,label:string){
 const observed=await a.page.locator('.challenge-modal-art').evaluate((node)=>{const image=node as HTMLImageElement;const style=getComputedStyle(image);const result:any={src:image.src,currentSrc:image.currentSrc,alt:image.alt,complete:image.complete,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,bounds:image.getBoundingClientRect().toJSON(),css:{opacity:style.opacity,filter:style.filter,mixBlendMode:style.mixBlendMode,maskImage:style.maskImage}};try{const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let zero=0,partial=0,opaque=0;for(let i=3;i<pixels.length;i+=4){if(pixels[i]===0)zero++;else if(pixels[i]===255)opaque++;else partial++;}result.alpha={zero,partial,opaque};}catch(e){result.alphaError=String(e);}return result;});
 const bytes=hashVisibleMappedImages([observed],{[APPROVED_STAGE1_ALPHA.fileName]:APPROVED_STAGE1_ALPHA.sha256,[APPROVED_TITLE.fileName]:APPROVED_TITLE.sha256,[APPROVED_MAIN.fileName]:APPROVED_MAIN.sha256});let size:number|undefined;try{size=fs.statSync(fileURLToPath(observed.currentSrc||observed.src)).size;}catch{}const actual=bytes.images[0];report.captures.at(-1).stage1Alpha={observed,bytes,size,approved:APPROVED_STAGE1_ALPHA,manualExeVisualJudgment:'NOT_RUN'};
 check(label+' approved stage1 alpha actually loaded',observed.complete&&observed.bounds.width>0&&observed.bounds.height>0&&actual?.fileName===APPROVED_STAGE1_ALPHA.fileName&&actual.approvedBytesMatch===true&&size===APPROVED_STAGE1_ALPHA.bytes&&observed.css.opacity==='1'&&observed.css.filter==='none'&&observed.css.mixBlendMode==='normal'&&observed.css.maskImage==='none',{observed,bytes,size});
 if(observed.alphaError){report.checks.push({name:label+' loaded image transparent pixels',status:'HOLD',reason:observed.alphaError});}else check(label+' loaded image approved transparent pixel counts',observed.alpha?.zero===APPROVED_STAGE1_ALPHA.zero&&observed.alpha?.partial===APPROVED_STAGE1_ALPHA.partial&&observed.alpha?.opaque===APPROVED_STAGE1_ALPHA.opaque,observed.alpha);
 report.checks.push({name:label+' actual EXE alpha edge and dark-detail visual judgment',status:'NOT_RUN',reason:'PNG captured from actual EXE; manual image judgment must be recorded separately. No CSS background masking applied.'});flush();
}
async function presentationChecks(a:Running,name:string,width:number,height:number){
 if(!name.startsWith('gameplay-stage')&&!name.startsWith('win-stage')&&!name.startsWith('loss-stage')&&a.role!=='leaderboard')return;
 const observation=await a.page.evaluate(({name})=>{
  if(name.startsWith('gameplay-stage')){const input=document.querySelector('textarea.typing-input') as HTMLTextAreaElement|null;const target=document.querySelector('.duel-target');return {kind:'caret',fakeCarets:document.querySelectorAll('.typing-cursor-anchor,.typing-cursor').length,input:(input?.getBoundingClientRect().toJSON()??null),target:(target?.getBoundingClientRect().toJSON()??null),active:document.activeElement===input,disabled:input?.disabled,caretColor:input?getComputedStyle(input).caretColor:null,selectionStart:input?.selectionStart,selectionEnd:input?.selectionEnd};}
  if(name.startsWith('win-stage')||name.startsWith('loss-stage')){const heading=document.querySelector('.challenge-modal-message h2') as HTMLElement|null;const badge=document.querySelector('.challenge-modal-message .compact-badges');const painted=Array.from(badge?.querySelectorAll('*')??[]).map(e=>({...e.getBoundingClientRect().toJSON()})).filter((r:any)=>r&&r.width>0&&r.height>0);const lineRects:any[]=[];if(heading){const walker=document.createTreeWalker(heading,NodeFilter.SHOW_TEXT);while(walker.nextNode()){if(!walker.currentNode.textContent?.trim())continue;const range=document.createRange();range.selectNodeContents(walker.currentNode);lineRects.push(...Array.from(range.getClientRects()).map(r=>({...r.toJSON()})));}}return {kind:'popup',text:heading?.innerText,align:heading?getComputedStyle(heading).textAlign:null,heading:(heading?.getBoundingClientRect().toJSON()??null),badge:(badge?.getBoundingClientRect().toJSON()??null),paintedBadge:painted,lineTops:[...new Set(lineRects.map(r=>Math.round(r.top)))],lineRects};}
  const logo=document.querySelector('.geumcheon-leaderboard-logo') as HTMLImageElement|null;
  const selectors=['.app.leaderboard-app','.ranking-table','.leaderboard-header','.leader-actions','.search-input','.leaderboard-board','.leaderboard-session','.ranking-body','.ai-head','.session-counter','.session-count','.uiv3-search-controls','.uiv3-search-primary','.uiv3-search-secondary'];
  const geometry=Object.fromEntries(selectors.map(s=>{const e=document.querySelector(s);const css=e?getComputedStyle(e):null;return [s,e?{...e.getBoundingClientRect().toJSON(),scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,offsetWidth:(e as HTMLElement).offsetWidth,clientWidth:e.clientWidth,scrollbarWidth:(e as HTMLElement).offsetWidth-e.clientWidth,scrollTop:e.scrollTop,fontSize:css!.fontSize,lineHeight:css!.lineHeight,fontFamily:css!.fontFamily,padding:css!.padding,overflowY:css!.overflowY}:null];}));
  let paintedLogo:any=null,canvasLogo:any=null;let paintedError:string|undefined;const clipping:any[]=[];
  if(logo?.complete&&logo.naturalWidth){try{
   const canvas=document.createElement('canvas');canvas.width=logo.naturalWidth;canvas.height=logo.naturalHeight;const ctx=canvas.getContext('2d')!;ctx.drawImage(logo,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
   let minX=canvas.width,minY=canvas.height,maxX=-1,maxY=-1;for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++)if(pixels[(y*canvas.width+x)*4+3]>=8){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
   const r=logo.getBoundingClientRect(),css=getComputedStyle(logo);let sx=r.width/canvas.width,sy=r.height/canvas.height,left=r.left,top=r.top;
   if(css.objectFit==='contain'){const s=Math.min(sx,sy);sx=s;sy=s;const position=css.objectPosition.split(/\s+/).map(v=>parseFloat(v)/100);left+=(r.width-canvas.width*s)*(position[0]??.5);top+=(r.height-canvas.height*s)*(position[1]??.5);}
   const fullWidth=canvas.width*sx,fullHeight=canvas.height*sy;canvasLogo={x:left,y:top,left,top,width:fullWidth,height:fullHeight,right:left+fullWidth,bottom:top+fullHeight};
   if(maxX>=minX){const x=left+minX*sx,y=top+minY*sy,width=(maxX-minX+1)*sx,height=(maxY-minY+1)*sy;paintedLogo={x,y,left:x,top:y,width,height,right:x+width,bottom:y+height,alphaThreshold:8,sourceBounds:[minX,minY,maxX+1,maxY+1],mapping:'Independently scanned alpha>=8 exclusive right/bottom bounds mapped through actual object-fit and object-position'};}
   for(let e=logo.parentElement;e;e=e.parentElement){const css=getComputedStyle(e),rect=e.getBoundingClientRect();const clipX=['hidden','clip','scroll','auto'].includes(css.overflowX),clipY=['hidden','clip','scroll','auto'].includes(css.overflowY);if(clipX||clipY)clipping.push({tag:e.tagName,className:e.className,overflowX:css.overflowX,overflowY:css.overflowY,rect:rect.toJSON(),clipsCanvas:(clipX&&(left<rect.left-.01||left+fullWidth>rect.right+.01))||(clipY&&(top<rect.top-.01||top+fullHeight>rect.bottom+.01))});}
  }catch(e){paintedError=String(e);}}
  (geometry as any)['@painted-logo']=paintedLogo;(geometry as any)['@canvas-logo']=canvasLogo;
  const buttons=Array.from(document.querySelectorAll('.leader-actions button')).map(e=>({text:(e as HTMLElement).innerText,...e.getBoundingClientRect().toJSON()}));
  const controls=Array.from(document.querySelectorAll('.uiv3-search-controls select,.uiv3-search-controls input,.uiv3-search-controls button')).map(e=>({tag:e.tagName,text:(e as HTMLElement).innerText,...e.getBoundingClientRect().toJSON(),fontSize:getComputedStyle(e).fontSize}));
  return {kind:'leaderboard',logo:logo?{...logo.getBoundingClientRect().toJSON(),src:logo.src,currentSrc:logo.currentSrc,naturalWidth:logo.naturalWidth,naturalHeight:logo.naturalHeight,complete:logo.complete}:null,logoCount:document.querySelectorAll('.geumcheon-leaderboard-logo').length,geometry,legacyRows:Array.from(document.querySelectorAll('.ai-ranking .ai-row')).map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,minHeight:getComputedStyle(e).minHeight,cellFontSizes:Array.from(e.querySelectorAll(':scope > span')).map(cell=>getComputedStyle(cell).fontSize)})),paintedError,clipping,logoCss:logo?{objectFit:getComputedStyle(logo).objectFit,objectPosition:getComputedStyle(logo).objectPosition,opacity:getComputedStyle(logo).opacity,filter:getComputedStyle(logo).filter,maskImage:getComputedStyle(logo).maskImage,pointerEvents:getComputedStyle(logo).pointerEvents,transform:getComputedStyle(logo).transform}:null,buttons,controls,rowCount:document.querySelectorAll('.ai-ranking .ranking-row').length,documentScroll:{height:document.documentElement.scrollHeight,width:document.documentElement.scrollWidth}};
 },{name});
 report.captures.at(-1).presentation=observation;const o:any=observation;const label=`${a.mode} ${name} ${width}`;
 if(o.kind==='caret'){check(label+' bottom native caret only',o.fakeCarets===0&&o.active&&!o.disabled&&o.input&&o.target&&o.input.top>=o.target.bottom-1&&!['transparent','rgba(0, 0, 0, 0)'].includes(o.caretColor),{...o,scope:'DOM focus/native caret color and no simulated caret; blinking pixels/human IME not proved'});}
  if(o.kind==='popup'){const expected=name.startsWith('win')?'승리했습니다.\n금나래보다 빠르게 입력했습니다.':'아쉽습니다.\n금나래가 먼저 입력을 완료했습니다.';check(label+' exact two rendered lines left aligned',o.text===expected&&o.lineTops.length===2&&o.align==='left',o);const bottom=Math.max(o.badge?.bottom??Infinity,...o.paintedBadge.map((r:any)=>r.bottom));check(label+' full badge painted bbox gap',Boolean(o.heading)&&o.heading.top-bottom>=15.5,{badgeBottom:bottom,headingTop:o.heading?.top,gap:o.heading?.top-bottom,paintedBadge:o.paintedBadge});if(name==='win-stage-1')await stage1Alpha(a,label);}
 if(o.kind==='leaderboard'){
  const g=o.geometry,painted=g['@painted-logo'],canvas=g['@canvas-logo'],board=g['.leaderboard-board'];
  const geometryFailures=assessLogoGeometry(canvas,painted,board);check(label+' U10 alpha8 original ratio centered half above outer border',geometryFailures.length===0,{failures:geometryFailures,canvas,painted,board,approvedAlpha8:APPROVED_TITLE.alpha8});
  check(label+' U10 actual alpha8 bounds and single unchanged-opacity logo',!o.paintedError&&o.logoCount===1&&isDeepStrictEqual(painted?.sourceBounds,APPROVED_TITLE.alpha8)&&o.logoCss?.objectFit==='contain'&&o.logoCss?.opacity==='1'&&o.logoCss?.filter==='none'&&o.logoCss?.maskImage==='none'&&o.logoCss?.pointerEvents==='none'&&o.clipping.every((c:any)=>!c.clipsCanvas),{logoCount:o.logoCount,paintedError:o.paintedError,logoCss:o.logoCss,clipping:o.clipping,painted});
  const fit=(r:any)=>r&&r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=width+.01&&r.bottom<=height+.01;
  check(label+' U10 full canvas and controls fit content without page scroll',fit(canvas)&&fit(board)&&o.controls.length===5&&o.controls.every(fit)&&o.documentScroll.width<=width&&o.documentScroll.height<=height,{canvas,board,controls:o.controls,documentScroll:o.documentScroll});
  const clearance=(r:any)=>!painted||!r?-Infinity:Math.max(r.left-painted.right,painted.left-r.right,r.top-painted.bottom,painted.top-r.bottom);
  const targets=[g['.ai-head'],g['.session-count'],...o.controls].filter(Boolean);check(label+' U10 logo has 12px header count control clearance',targets.length>=7&&targets.every(r=>clearance(r)>=12),targets.map(r=>({rect:r,clearance:clearance(r)})));
  const controlFailures=assessControlPresentation(o.controls,width);check(label+' U11 original style minimum control sizes and order',controlFailures.length===0,{controls:o.controls,failures:controlFailures,viewportWidth:width});
  if(o.legacyRows.length){check(label+' legacy row height and cell font preserved',o.legacyRows.every((r:any)=>Math.abs(r.height-76)<=1&&r.minHeight==='76px'&&r.cellFontSizes.length===8&&r.cellFontSizes.every((v:string)=>v==='14px')),o.legacyRows);}else report.checks.push({name:label+' legacy row height and cell font preserved',status:'NOT_RUN',reason:'Empty table; populated row geometry observed separately'});
  observeLeaderboardMatrix(a,name,width,height,o);
  const loaded=hashVisibleMappedImages(o.logo?[o.logo]:[],{[APPROVED_TITLE.fileName]:APPROVED_TITLE.sha256});check(label+' U02 exact v3 title bytes and dimensions',o.logo?.complete&&o.logo.naturalWidth===2048&&o.logo.naturalHeight===682&&loaded.images[0]?.approvedBytesMatch===true,{logo:o.logo,loaded,approved:APPROVED_TITLE});
  const resultLabels=await a.page.locator('.ai-ranking .ranking-row').evaluateAll(rows=>rows.map(r=>({id:r.getAttribute('data-leaderboard-record'),text:(r as HTMLElement).innerText})));
  const actualRows=await recordOracles[a.mode].read(()=>listSaved(a));const byId=new Map(actualRows.map((r:any)=>[r.record_id,r]));const wrongLabels=resultLabels.filter((r:any)=>{const record:any=byId.get(r.id);if(!record)return true;if(String(record.challenge_result_label??'').includes('중단')||String(record.memo??'').startsWith('사용자 중단:'))return !r.text.includes('중단');return record.final_vs_ai_result==='USER_WIN'?!r.text.includes('도전자 승리'):record.final_vs_ai_result==='AI_WIN'&&!r.text.includes('AI 금나래 승리');});check(label+' U01 U12 display-only result labels',wrongLabels.length===0&&!resultLabels.some((r:any)=>r.text.includes('참여자 승리')),{wrongLabels});
  if(o.rowCount>=10){const scrolled=await a.page.locator('.ai-ranking .ranking-body').evaluate(e=>{const old=e.scrollTop;e.scrollTop=e.scrollHeight;const v={scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight};e.scrollTop=old;return v;});check(label+' seeded rows scroll inside table',scrolled.clientHeight>0&&scrolled.scrollTop>0,scrolled);}else if(name==='leaderboard')report.checks.push({name:label+' populated table scrolling',status:'NOT_RUN',reason:'Fewer than ten authenticated stored rows; no invented records to hide persistence failure'});
  if(!await a.page.locator('.admin-modal').count())await diagnosticOverlay(a,name,width,height,[{label:'full canvas',rect:canvas,color:'#ffff00'},{label:'alpha8 visible',rect:painted,color:'#ff00ff'},{label:'outer board / logo center Y',rect:board,color:'#00ffcc'}]);
 }

}
async function packagedNegative(source:string,negative:'missing-credentials'|'untrusted-ca'){
 let a:Running|undefined;const before=nas.requests.filter((r:any)=>r.method==='POST'&&r.status<300).length;try{a=await launch('nas','game',source,negative);const response=await a.page.evaluate(async()=> (window as any).typingKing.checkGameStartReadiness('ai_challenge'));check('actual NAS EXE '+negative+' readiness blocked',response?.data?.ready===false,{scope:'actual EXE, fresh isolated profile/data, synthetic HTTPS only',response});await capture(a,'negative-'+negative);check('actual NAS EXE '+negative+' no accepted write',nas.requests.filter((r:any)=>r.method==='POST'&&r.status<300).length===before);}catch(e){report.checks.push({name:'actual NAS EXE '+negative,status:'HOLD',reason:String(e)});}finally{if(a&&owned.has(a))await close(a);await cleanupPending();flush();}
}
main().catch(async e=>{report.error=String(e);report.status='FAIL';await cleanupPending();report.completedAt=new Date().toISOString();flush();console.error(e);process.exitCode=1;});
