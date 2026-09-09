import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {chromium, type Browser, type Page} from 'playwright-core';
import {buildNasApp} from '../services/nas-record-api/src/app';
import {TokenBucketLimiter} from '../services/nas-record-api/src/auth';
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
const output=path.resolve(opts.get('--output')??`Codex/Evidence/R7/after/run-${Date.now()}`);
const report:any={startedAt:new Date().toISOString(),releaseCandidate:'R7-ppt-official-only-20260909',status:'NOT_RUN',method:'actual portable EXEs; CDP automated UI; isolated directories; real source NAS service behind synthetic loopback HTTPS',checks:[],captures:[],apps:[],limitations:['Human IME NOT_RUN','Physical five PCs NOT_RUN','Offline VM NOT_RUN','Real NAS NOT_RUN','Native window versus renderer viewport recorded individually'],actualUiRecords:[],seededRecords:[]};
let runClaimed=false;
const owned=new Set<Running>();const pendingRoots=new Map<number,any>();
const hash=(s:Buffer|string)=>crypto.createHash('sha256').update(s).digest('hex');
const sha=(p:string)=>hash(fs.readFileSync(p));
function json(p:string,v:any){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n');}
function flush(){if(runClaimed)json(path.join(output,'index.json'),report);}
function overallStatus(value:any){const exits=[...(value.apps??[]).map((a:any)=>a.cleanup?.postExit??a.pendingCleanup?.postExit),...(value.ordinaryNoArgument??[]).map((a:any)=>a.postExit)].filter(Boolean);return value.error||value.checks.some((c:any)=>c.passed===false)||exits.some((e:any)=>e.allObservedAbsent!==true)?'FAIL':value.limitations.length||value.checks.some((c:any)=>c.status==='PARTIAL'||c.status==='NOT_RUN'||c.status==='HOLD')?'PARTIAL':'PASS';}
function certificateFailure(value:any){return ['UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','CERT_HAS_EXPIRED','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(value.code);}
function check(name:string,passed:boolean,actual?:any){report.checks.push({name,passed,actual});flush();return passed;}
async function until(name:string,fn:()=>Promise<boolean>|boolean,ms=20000){const end=Date.now()+ms;let last:any;do{try{if(await fn())return;}catch(e){last=e;}await new Promise(r=>setTimeout(r,100));}while(Date.now()<end);throw Error(name+' timed out '+String(last??''));}
async function step(name:string,fn:()=>Promise<void>){const start=report.checks.length;try{await fn();const subset=report.checks.slice(start);if(subset.some((c:any)=>c.passed===false))check(name,false);else if(subset.some((c:any)=>['HOLD','PARTIAL','NOT_RUN'].includes(c.status))){report.checks.push({name,status:'PARTIAL',reason:'Child observations include unresolved coverage; no aggregate PASS'});flush();}else check(name,true);}catch(e){check(name,false,String(e));for(const a of owned)await a.page.screenshot({path:path.join(output,`${a.mode}-${a.role}-failure-${Date.now()}.png`)}).catch(()=>{});}}
function files(root:string):Record<string,string>{const out:Record<string,string>={};if(!fs.existsSync(root))return out;for(const e of fs.readdirSync(root,{withFileTypes:true})){const p=path.join(root,e.name);if(e.isDirectory())for(const [k,v]of Object.entries(files(p)))out[e.name+'/'+k]=v;else out[e.name]=sha(p);}return out;}
const admin='r7-synthetic-admin-only';
const APPROVED_STAGE1_ALPHA={fileName:'금나래패배_스테이지1_alpha_r7.png',sha256:'8E75458B86D792F5E39794913904DBCE0EC44BA737459D17239BABB4905634A9',bytes:2615115,zero:699361,partial:26686,opaque:846469};
let nas:any;

async function setupNas(){
 const tokens={PC01:crypto.randomBytes(32).toString('hex'),LEADERBOARD01:crypto.randomBytes(32).toString('hex'),LEADERBOARD01_OPERATOR:crypto.randomBytes(32).toString('hex')};
 const catalog=path.resolve('events/geumcheon-2026/stage_texts.csv');
 const config:any={schemaVersion:1,eventId:GEUMCHEON_NAS_EVENT_ID,dataRoot:path.join(output,'nas-server-data'),recordBaseFolderName:'기록저장',stageTextCatalogPath:catalog,stageTextCatalog:parseStageTextCatalog(fs.readFileSync(catalog,'utf8')),participantHmacKey:crypto.randomBytes(32),allowedSessions:{official:[{sessionId:'r7-synthetic-official',dayNo:1,roundNo:1},{sessionId:'r7-synthetic-other-official',dayNo:1,roundNo:2}]},aiRanges:{official:[[100,125],[125,150],[150,200]],practice:[[100,125],[125,150],[150,200]]},tokenManifest:{manifestVersion:1,eventId:GEUMCHEON_NAS_EVENT_ID,tokens:Object.entries(tokens).map(([id,t])=>({tokenId:id,tokenHash:hash(t),deviceId:id.startsWith('LEADERBOARD')?'LEADERBOARD01':'PC01',role:id==='PC01'?'writer':id.endsWith('OPERATOR')?'operator':'leaderboard',allowedSessions:['official','practice'],expiresAt:new Date(Date.now()+86400000).toISOString(),revokedAt:null}))}};
 json(path.join(output,'synthetic-server-config.json'),{...config,participantHmacKey:'OMITTED_SYNTHETIC_KEY',stageTextCatalogSha256:sha(catalog),tokenManifest:{...config.tokenManifest,tokens:config.tokenManifest.tokens.map((t:any)=>({...t,tokenHash:'OMITTED_SYNTHETIC_TOKEN_HASH'}))}});const app=buildNasApp({config,tokenLimiter:new TokenBucketLimiter({capacity:10000,refillPerSecond:100}),readiness:async()=>true});await app.ready();
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
 const a={mode,role,exe,pid,browser,page:page!,state,caseRoot,env};owned.add(a);pendingRoots.delete(pid);state.lifecycle=[];const note=(kind:string,detail?:string)=>{let processes:any;try{processes=processTree(pid);}catch(e){processes={error:String(e)};}state.lifecycle.push({at:new Date().toISOString(),kind,detail,intentionalClose:state.intentionalClose===true,processes});flush();};page!.on('close',()=>note('page-close'));page!.on('crash',()=>note('page-crash'));page!.on('pageerror',e=>note('page-error',String(e)));browser.on('disconnected',()=>note('browser-disconnected'));await page!.waitForFunction(()=>Boolean((window as any).typingKing));state.bootstrap=await page!.evaluate(async()=> (window as any).typingKing.getBootstrap());flush();return a;
}
async function close(a:Running){
 a.state.intentionalClose=true;await a.page.close().catch(()=>{});await a.browser.close().catch(()=>{});let snapshot:any;let errors:string[]=[];
 await until('owned process exit',()=>{try{snapshot=processTree(a.pid);return snapshot.length===0;}catch(e){errors.push(String(e));return false;}},10000).catch(()=>{});
 a.state.cleanup={errors,remaining:snapshot??null};if(snapshot?.length){const observed=snapshot.find((p:any)=>p.ProcessId===a.pid);if(observed&&path.resolve(observed.ExecutablePath)===path.resolve(a.exe)){spawnSync('taskkill.exe',['/PID',String(a.pid),'/T','/F'],{windowsHide:true});a.state.cleanup.forced=true;}}
 a.state.cleanup.postExit=await postExit(a.pid,[...(a.state.observedProcessIds??[]),...(snapshot??[]).map((p:any)=>p.ProcessId)]);owned.delete(a);flush();
}
async function adminOpen(a:Running){const p=a.page;await p.getByRole('button',{name:a.role==='game'?'관리자 모드':'관리자',exact:true}).click();const inputs=p.locator('.admin-modal input');await inputs.nth(0).fill('synthetic-r7-admin');await inputs.nth(1).fill(a.mode==='review'?'0208':admin);await p.getByRole('button',{name:a.role==='game'?'비밀번호 확인':'진입',exact:true}).click();await p.locator(a.role==='game'?'.admin-modal.wide':'.admin-toolbar').waitFor();}
async function adminClose(a:Running){await a.page.locator('.admin-modal').getByRole('button',{name:'닫기',exact:true}).click();await a.page.locator('.admin-modal').waitFor({state:'hidden'});}
async function validate(a:Running){await adminOpen(a);if(a.mode==='review'){await a.page.getByRole('button',{name:'로컬 저장소 검증'}).click();await until('review validation',()=>a.page.locator('.geumcheon-nas-status-panel .notice-text').innerText().then(t=>t.includes('정상')));}else{await a.page.getByRole('button',{name:'연결·장치 역할·세션 검증',exact:true}).click();await until('NAS validated UI',()=>a.page.locator('.geumcheon-nas-status-panel .setup-state.ready').count().then(n=>n===1));const r=await a.page.evaluate(async()=> (window as any).typingKing.checkGameStartReadiness('ai_challenge'));assert.equal(r?.data?.ready,true,JSON.stringify(r));}await capture(a,'admin-validated');await adminClose(a);}

async function capture(a:Running,name:string){
 for(const [width,height]of [[1280,720],[1920,1080]]){
  const p=a.page;let nativeWindow:any;const session=await p.context().newCDPSession(p);try{const info=await session.send('Browser.getWindowForTarget');await session.send('Browser.setWindowBounds',{windowId:info.windowId,bounds:{windowState:'normal'}});await session.send('Browser.setWindowBounds',{windowId:info.windowId,bounds:{width,height}});nativeWindow=await session.send('Browser.getWindowBounds',{windowId:info.windowId});}catch(e){nativeWindow={error:String(e)};}finally{await session.detach();}a.state.nativeWindow=nativeWindow;await p.setViewportSize({width,height});await p.waitForFunction(({width,height})=>innerWidth===width&&innerHeight===height,{width,height});
  const geometry=await p.evaluate(()=>{
   const selectors=['.hero-panel','.geumcheon-main-title-image','.hero-copy','.geumcheon-main-robot','.hero-guide-card','.hero-guide-list','.entry-event-copy','.challenge-modal','.challenge-modal-message','.challenge-result-panel','.challenge-result-title','.challenge-stage-summary','.leaderboard-header','.session-counter','.ranking-body'];
   const rects=Object.fromEntries(selectors.map(s=>{const e=document.querySelector(s);return[s,e?{...e.getBoundingClientRect().toJSON(),text:(e as HTMLElement).innerText,align:getComputedStyle(e).textAlign,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}:null];}));
   return {innerWidth,innerHeight,outerWidth,outerHeight,screenX,screenY,devicePixelRatio,screen:{width:screen.width,height:screen.height},rects,images:Array.from(document.images).filter(i=>i.getBoundingClientRect().width>0).map(i=>({src:i.src,alt:i.alt,loaded:i.complete&&i.naturalWidth>0,width:i.naturalWidth,height:i.naturalHeight,rect:i.getBoundingClientRect().toJSON()})),text:document.body.innerText,selected:Array.from(document.querySelectorAll('.ranking-row.selected')).map(e=>({class:e.className,background:getComputedStyle(e).backgroundColor,border:getComputedStyle(e).borderColor}))};
  });
  const screenshot=path.join(output,`${a.mode}-${a.role}-${name}-${width}x${height}.png`);await p.screenshot({path:screenshot});const assetHashes={...Object.fromEntries(['금나래 승리.png','금나래패배_스테이지1.png','금나래패배_스테이지2.png','금나래패배_스테이지3.png'].map(n=>[n,sha(path.join('C:/Users/Public/Documents/ESTsoft/CreatorTemp/TypingKing_R6_v2/events/geumcheon-2026/assets',n)).toUpperCase()])),[APPROVED_STAGE1_ALPHA.fileName]:APPROVED_STAGE1_ALPHA.sha256};const assetObservation=hashVisibleMappedImages(geometry.images.map(i=>({...i,naturalWidth:i.width,naturalHeight:i.height})),assetHashes);report.captures.push({sourceCommit:report.sourceCommit,buildCandidate:report.buildCandidate,mode:a.mode,role:a.role,name,exeSha256:a.state.sha256,buildId:a.state.bootstrap?.data?.reviewContext?.buildId??null,releaseCandidate:report.releaseCandidate,screenshot,geometry,assetObservation});check(a.mode+' '+name+' '+width+' visible mapped assets match approved hashes',assetObservation.violations.length===0,assetObservation.violations);flush();
  if(name==='main'){
   const r=geometry.rects as any;check(`${a.mode} main ${width} guide 5 lines`,await p.locator('.hero-guide-list > li').count()===5);check(`${a.mode} main ${width} guide contained`,r['.hero-guide-card'].bottom<=r['.hero-panel'].bottom+1&&r['.hero-guide-card'].bottom<=height);
   check(`${a.mode} main ${width} two-line copy`,r['.hero-copy'].text==='3개의 스테이지에서 금나래보다\n먼저 정확하게 입력하세요.');
   report.captures.at(-1).mainGaps={logoCopy:r['.hero-copy'].top-r['.geumcheon-main-title-image'].bottom,copyRobot:r['.geumcheon-main-robot'].top-r['.hero-copy'].bottom,robotGuide:r['.hero-guide-card'].top-r['.geumcheon-main-robot'].bottom};
  }
  if(name.startsWith('win-stage')||name.startsWith('loss-stage')){const text=await p.locator('.challenge-modal').innerText();check(`${a.mode} ${name} ${width} separate Stage label absent`,!/^Stage\s*[123]$/m.test(text));if(name.startsWith('win'))check(`${a.mode} ${name} ${width} victory lines`,text.includes('승리했습니다.\n금나래보다 빠르게 입력했습니다.'));}
  await presentationChecks(a,name,width,height);
  if(name==='final-victory'){const r=(geometry.rects as any)['.challenge-result-panel'];check(`${a.mode} final ${width} no internal scrolling`,r.scrollHeight<=r.clientHeight+1&&r.bottom<=height+1);check(`${a.mode} final ${width} victory lines`,geometry.text.includes('참여자 승리.\n금나래보다 빠르고 정확하게 완주했습니다.'));check(`${a.mode} final ${width} participant wording`,!geometry.text.includes('사용자'));report.captures.at(-1).stageCards=await p.locator('.r7-stage-result-card').allInnerTexts();check(`${a.mode} final ${width} three cards only`,await p.locator('.r7-stage-result-card').count()===3&&await p.locator('.challenge-result-art,.challenge-result-title,.highlight-result').count()===0);}
 }
}

async function play(a:Running,reader:Running){
 const p=a.page;await capture(a,'main');const watcher=await captureRendererSaveInputs(p);
 let knownIds=new Set((await listSaved(reader)).map((r:any)=>r.record_id));let observedSaves=0;
 const observeAttempt=async(label:string,result:string,reached:number,participant='합성실제도전')=>{
  await until(label+' actual save argument',()=>watcher.inputs.length>observedSaves);const inputs=watcher.inputs.slice(observedSaves);assert.equal(inputs.length,1,'Exactly one UI save for '+label);observedSaves=watcher.inputs.length;const input=inputs[0].input;report.observedSaveInputs??=[];report.observedSaveInputs.push({mode:a.mode,label,input});flush();assert.equal(input.canonicalAttempt?.result,result);assert.equal(input.canonicalAttempt?.stageReached,reached);
  let rows:any[]=[];const deadline=Date.now()+5000;for(;;){const rejection=a.mode==='nas'?nas.requests.find((r:any)=>r.method==='POST'&&r.status>=400&&r.time>=inputs[0].observedAt):null;if(rejection)throw Error(label+' actual POST rejected: '+rejection.status+' '+rejection.responseBody);rows=await listSaved(reader);const count=rows.filter(r=>!knownIds.has(r.record_id)).length;if(count===1)break;assert.equal(count,0,'More than one uncorrelated new record');if(Date.now()>=deadline)throw Error(label+' actual stored row not observed');await new Promise(r=>setTimeout(r,100));}
  const delta=rows.filter(r=>!knownIds.has(r.record_id));assert.equal(delta.length,1);const row=delta[0];assert.equal(row.participant_name,participant);assert.equal(String(row.result_stage),String(reached));assert.equal(row.ai_challenge_status,result==='PARTICIPANT_WIN'?'SUCCESS':'FAILED');assert.equal(row.final_vs_ai_result,result==='PARTICIPANT_WIN'?'USER_WIN':'AI_WIN');
  if(result==='INTERRUPTED'){assert.equal(input.interruption?.action,'home');assert.equal(input.canonicalAttempt?.interruptionReason,'HOME');assert.equal(row.memo,'사용자 중단:메인화면');}
  for(let stage=1;stage<=3;stage++){assert.equal(Number(row['stage'+stage+'_time_ms']),Math.round(input.stageTimesMs[stage-1]));if(stage>reached){assert.equal(row['stage'+stage+'_vs_ai_result'],'');assert.equal(Number(row['stage'+stage+'_time_ms']),0);assert.equal(input.canonicalAttempt?.stages[stage-1].entered,false);}else assert.equal(row['stage'+stage+'_vs_ai_result'],result==='PARTICIPANT_WIN'||stage<reached?'USER_WIN':'AI_WIN');}
  const chain=a.mode==='nas'?verifyNasEvidenceChain(input,row,inputs[0].observedAt):undefined;
  knownIds=new Set(rows.map(r=>r.record_id));report.actualUiRecords.push({mode:a.mode,label,recordId:row.record_id,method:'one observed actual UI save argument correlated to exactly one new ID from authenticated leaderboard listRecords before next attempt or any seed',inputSha256:inputs[0].inputSha256,input,row,chain});check(a.mode+' persisted actual UI '+label,true,{recordId:row.record_id,reached,result});
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
  const win=actual.find(x=>x.canonicalAttempt?.result==='PARTICIPANT_WIN');assert.ok(win);assert.deepEqual(assessCapturedCanonicalInput(win),[]);for(const shot of report.captures.filter((c:any)=>c.mode===a.mode&&c.name==='final-victory')){const cards=shot.stageCards??[];check(a.mode+' final cards show actual saved stage times '+shot.geometry.innerWidth,cards.length===3&&cards.every((t:string,i:number)=>t.includes('참여자 : '+(win.stageTimesMs[i]/1000).toFixed(2)+'초')),cards);}
  const saved=await listSaved(reader);const linked=report.actualUiRecords.find((r:any)=>r.mode===a.mode&&r.label==='win');const row=saved.find((r:any)=>r.record_id===linked.recordId);check(a.mode+' actual saved row correlation',assessPublicStoredWin(win,row).length===0,assessPublicStoredWin(win,row));
  await pacedActualWins(a,reader,observeAttempt);await watcher.stop();assert.deepEqual(watcher.errors,[]);
  for(let i=0;i<10;i++){const input=copyCapturedSyntheticInput(win,i?{name:'합성추가'+String(i).padStart(2,'0'),phone2:String(i).padStart(4,'0'),phone3:String(2000+i)}:undefined);assert.ok(input.recordEvidence,'Nested raw evidence required for every clone');assert.deepEqual(input.recordEvidence.canonicalAttempt,input.canonicalAttempt);const result=await p.evaluate(async(input)=>(window as any).typingKing.saveRecord(input),input);assert.equal(result.ok,true,JSON.stringify(result));report.seededRecords.push({mode:a.mode,method:'protected saveRecord IPC full nested evidence clone; main process supplies fresh trusted identity',recordId:result.data?.record_id});}
 }finally{await watcher.stop().catch(()=>{});flush();}
}
async function listSaved(reader:Running):Promise<any[]>{const response=await reader.page.evaluate(async()=> (window as any).typingKing.listRecords());assert.equal(response?.ok,true,'Authenticated listRecords failed: '+JSON.stringify(response));assert.ok(Array.isArray(response.data),'listRecords did not return an array');return response.data;}
async function selection(a:Running){
 const p=a.page,rows=p.locator('.ai-ranking .ranking-row'),selected=p.locator('.ai-ranking .ranking-row.selected');
 await rows.first().click();assert.equal(await selected.count(),1);await capture(a,'row-selected');
 await rows.first().click();assert.equal(await selected.count(),0);await capture(a,'same-row-cleared');
 await rows.first().click();await rows.nth(1).click();assert.equal(await selected.count(),1);assert.ok((await rows.nth(1).getAttribute('class'))?.includes('selected'));
 const targets=[['cell',()=>rows.nth(1).locator('span').first().click()],['header',()=>p.locator('.ranking-head').click()],['search',()=>p.getByPlaceholder('기록 검색').click()],['background',()=>p.locator('.leaderboard-header').click({position:{x:2,y:2}})]] as const;
 for(const[name,click]of targets){if(await selected.count()===0)await rows.nth(1).click();await click();check(a.mode+' deselect '+name,await selected.count()===0);await capture(a,'outside-'+name);}
 const search=p.getByPlaceholder('기록 검색');await search.fill('1234');await until('masked suffix search',()=>rows.count().then(n=>n>=1&&n<15));check(a.mode+' phone masked search',!(await p.locator('.ai-ranking').innerText()).includes('010-0000-1234'));await capture(a,'search-masked');await search.fill('');
 await adminOpen(a);const picker=p.locator('.admin-record-picker button').first();const recordId=await picker.getAttribute('data-leaderboard-record');await picker.click();const field=p.locator('.edit-grid input').first();await field.fill('합성미저장초안');await p.locator('.admin-modal h2').click();assert.equal(await field.inputValue(),'합성미저장초안');check(a.mode+' admin background preserves draft',await field.inputValue()==='합성미저장초안');await picker.click();assert.equal(await field.inputValue(),'합성미저장초안');await picker.click();assert.equal(await field.inputValue(),'합성미저장초안');check(a.mode+' admin reselect and same-row clear preserves draft',await field.inputValue()==='합성미저장초안'&&!(await picker.getAttribute('class'))?.includes('selected'));await field.focus();await p.keyboard.press('Tab');await capture(a,'admin-draft-focus');await p.getByRole('button',{name:'수정 저장',exact:true}).click();await p.locator('.edit-grid').waitFor({state:'hidden'});await p.locator('.admin-record-picker button[data-leaderboard-record="'+recordId+'"]').click();await p.locator('.edit-grid').waitFor();check(a.mode+' saved record same-row editor reopens',await p.locator('.edit-grid input').first().inputValue()==='합성미저장초안');await capture(a,'admin-saved-record-reopened');await adminClose(a);
 const body=p.locator('.ai-ranking .ranking-body');await p.setViewportSize({width:1280,height:720});await body.evaluate(e=>e.scrollTop=e.scrollHeight);const scroll=await body.evaluate(e=>({top:e.scrollTop,height:e.scrollHeight,client:e.clientHeight}));check(a.mode+' leaderboard actual scroll',scroll.top>0,scroll);await capture(a,'leaderboard-scrolled');await body.evaluate(e=>e.scrollTop=0);
}
async function displayRestart(a:Running,source:string):Promise<Running>{
 for(const enabled of [true,false]){
  await adminOpen(a);const cb=a.page.getByLabel('일차·회차 표시',{exact:true});await cb.setChecked(enabled);await a.page.getByRole('button',{name:'표시 설정 저장',exact:true}).click();await adminClose(a);await capture(a,'day-round-'+(enabled?'on':'off'));await close(a);a=await launch(a.mode,a.role,source);
  await a.page.locator('.leaderboard-app').waitFor();const badges=a.page.locator('.ai-ranking .session-badges');check(a.mode+' persisted day-round '+enabled,await badges.count()===(enabled?1:0));await capture(a,'restart-day-round-'+(enabled?'on':'off'));
 }
 return a;
}
async function reset(a:Running){
 const root=a.mode==='review'?path.join(output,'review','LocalAppData','ThePMD','TypingKing','Geumcheon2026','Review'):nas.config.dataRoot;
 const other=a.mode==='nas'?await seedSecondSession():null;const before=files(root);await adminOpen(a);a.page.once('dialog',d=>d.accept());await a.page.getByRole('button',{name:'현재 회차 표시 초기화',exact:true}).click();await adminClose(a);await until('reset visible rows',()=>a.page.locator('.ai-ranking .ranking-row').count().then(n=>n===0));await capture(a,'reset-visible-empty');
 const after=files(root);const raw=Object.keys(before).filter(k=>k.endsWith('.json')&&(k.includes('/records/')||k.includes('gsc26-pc')));check(a.mode+' reset preserves raw records',raw.length>0&&raw.every(k=>before[k]===after[k]),{count:raw.length});if(other){const reread=await nasHttp('GET','/api/v1/records?session_kind=official&session_id=r7-synthetic-other-official&day_no=1&round_no=2','leaderboard');check('NAS other official session query preserved after reset',reread.status===200&&reread.data.rows.length===other.count,reread.data);check('NAS other official raw SHA preserved',Object.entries(other.raw).every(([k,v])=>after[k]===v),other.raw);}else report.checks.push({name:'review other-session reset preservation',status:'NOT_RUN',reason:'Fixed review session; no fabricated noncurrent session proof'});flush();
}
async function security(){
 const request=(headers:any,ca=true)=>new Promise<any>(resolve=>{const r=https.get(nas.baseUrl+'/api/v1/ready?session_kind=official&session_id=r7-synthetic-official&day_no=1&round_no=1',{headers,...(ca?{ca:fs.readFileSync(nas.cert.caPemPath)}:{})},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode}));});r.on('error',(e:any)=>resolve({error:e.message,code:e.code}));});
 for(const[name,headers]of [['missing token',{'x-device-id':'PC01'}],['wrong token',{'x-device-id':'PC01',authorization:'Bearer synthetic-invalid'}],['wrong device',{'x-device-id':'PC99',authorization:'Bearer '+nas.tokens.PC01}]] as const){const r=await request(headers);check('Node HTTPS '+name+' rejected',r.status===401||r.status===403,r);}
 const tls=await request({'x-device-id':'PC01',authorization:'Bearer '+nas.tokens.PC01},false);check('Node HTTPS untrusted CA certificate rejection',certificateFailure(tls),tls);const health=await nasHttp('GET','/health','writer');check('Node HTTPS trusted health succeeds',health.status===200,health);report.securityScope='Node HTTPS requests to real source service; not proof that packaged EXE fails closed';
}
async function main(){
 if(fs.existsSync(output))throw Error('OUTPUT_ALREADY_EXISTS:'+output);fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(output);runClaimed=true;report.sourceCommit=spawnSync('git',['rev-parse',opts.get('--source-commit')??'HEAD'],{encoding:'utf8'}).stdout.trim();report.buildCandidate=opts.get('--label')??report.releaseCandidate;flush();
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
    await step(mode+' game F11 native toggle',()=>fullscreenKeys(game!));await step(mode+' leaderboard F11 native toggle',()=>fullscreenKeys(lb!));
    await step(mode+' game admin validation',()=>validate(game!));await step(mode+' leaderboard admin validation',()=>validate(lb!));
    check(mode+' day-round default OFF',await lb.page.locator('.ai-ranking .session-badges').count()===0);
    await step(mode+' gameplay scenarios',()=>play(game!,lb!));if(opts.get('--one-win')==='true'){await capture(lb,'one-win-leaderboard');continue;}
    await step(mode+' share in two refreshes',async()=>{let count=0;for(let refresh=0;refresh<=2;refresh++){count=await lb!.page.locator('.ai-ranking .ranking-row').count();if(count>=10){check(mode+' shared count',true,{count,refresh});return;}if(refresh<2)await lb!.page.getByRole('button',{name:'새로고침',exact:true}).click();await new Promise(r=>setTimeout(r,150));}throw Error('Less than ten records after two refreshes: '+count);});
    await step(mode+' leaderboard layout capture',()=>capture(lb!,'leaderboard'));await step(mode+' selection/search/admin draft/scroll',()=>selection(lb!));
    await step(mode+' day-round restart persistence',async()=>{lb=await displayRestart(lb!,lbSource);});
    await step(mode+' reset raw preservation',()=>reset(lb!));if(mode==='nas'){await step('synthetic HTTPS negative auth/TLS',security);if(game&&owned.has(game))await close(game);if(lb&&owned.has(lb))await close(lb);for(const negative of ['missing-credentials','untrusted-ca'] as const)await packagedNegative(gameSource,negative);}
   }finally{if(game&&owned.has(game))await close(game);if(lb&&owned.has(lb))await close(lb);if(nas){json(path.join(output,'nas-requests.json'),nas.requests);await new Promise<void>(r=>nas.server.close(()=>r()));await nas.app.close();nas=undefined;}}
  }
 }finally{for(const a of [...owned])await close(a);await cleanupPending();report.completedAt=new Date().toISOString();report.status='PARTIAL';flush();}
 if(modes.includes('review'))for(const role of ['game','leaderboard'] as Role[])await ordinaryLifecycle(role,opts.get('--review-'+role)!);
 const profileRoot=path.resolve('deployment/nas-production/device-profiles');const profiles=fs.readdirSync(profileRoot).filter(n=>n.endsWith('.device-profile.json')).map(n=>({file:n,sha256:sha(path.join(profileRoot,n)),profile:JSON.parse(fs.readFileSync(path.join(profileRoot,n),'utf8'))}));report.profileMapping={method:'source profile configuration check, not five physical PCs',profiles};check('five unique official-only device profiles',profiles.length===5&&new Set(profiles.map(p=>p.profile.deviceId)).size===5&&profiles.every(p=>p.profile.sessions.official&&!p.profile.sessions.practice));
 report.status=overallStatus(report);report.automatedSubset=report.checks.some((c:any)=>c.passed===false)?'FAIL':'PASS';report.completedAt=new Date().toISOString();flush();
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
 return new Promise(resolve=>{const request=https.request(nas.baseUrl+route,{method,ca:fs.readFileSync(nas.cert.caPemPath),headers:{'x-device-id':device,authorization:'Bearer '+token,...(body?{'content-type':'application/json','idempotency-key':body.row?.record_id??''}:{})}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{let data:any;try{data=JSON.parse(text);}catch{data=text;}resolve({status:res.statusCode,data});});});request.on('error',e=>resolve({error:String(e)}));request.end(body?JSON.stringify(body):undefined);});
}
async function seedSecondSession(){
 const actual=report.actualUiRecords.find((r:any)=>r.mode==='nas'&&r.label==='win');assert.ok(actual?.chain?.rawPath,'Verified actual NAS nested evidence chain required');
 const row=structuredClone(JSON.parse(fs.readFileSync(actual.chain.rawPath,'utf8')));assert.ok(row.recordEvidence?.canonicalAttempt,'Protected nested winning evidence required');assert.equal(row.canonicalAttempt,undefined,'Do not add flat canonical ranking fields');
 const uuid=crypto.randomUUID();row.record_id='gsc26-pc01-'+uuid;row.recordEvidence.canonicalAttempt.recordId=row.record_id;row.recordEvidence.canonicalAttempt.attemptId='gsc26-attempt-'+uuid;assert.deepEqual(row.recordEvidence.battles,actual.input.recordEvidence.battles);
 const envelope={schema_version:1,event_id:GEUMCHEON_NAS_EVENT_ID,session:{kind:'official',session_id:'r7-synthetic-other-official',day_no:1,round_no:2},row};
 const posted=await nasHttp('POST','/api/v1/records','writer',envelope);assert.ok(posted.status===201||posted.status===200,JSON.stringify(posted));
 const listed=await nasHttp('GET','/api/v1/records?session_kind=official&session_id=r7-synthetic-other-official&day_no=1&round_no=2','leaderboard');assert.equal(listed.status,200);assert.equal(listed.data.rows.length,1);
 const raw=Object.fromEntries(Object.entries(files(nas.config.dataRoot)).filter(([k])=>k.endsWith(row.record_id+'.json')));assert.equal(Object.keys(raw).length,1);
 report.seededRecords.push({mode:'nas',method:'actual HTTPS POST, real validator, cloned genuine UI win with fresh paired IDs, second official session',recordId:row.record_id,response:posted,raw});flush();return {count:1,raw};
}

async function ordinaryLifecycle(role:Role,source:string){
 const base=path.join(output,'ordinary-noargs',role),dir=path.join(base,'empty-folder');fs.mkdirSync(dir,{recursive:true});const exe=path.join(dir,path.basename(source));fs.copyFileSync(source,exe,fs.constants.COPYFILE_EXCL);assert.equal(sha(exe),sha(source),'ORDINARY_EXE_SOURCE_HASH_MISMATCH');const env={...process.env,LOCALAPPDATA:path.join(base,'LocalAppData'),APPDATA:path.join(base,'AppData'),TEMP:path.join(base,'Temp'),TMP:path.join(base,'Temp')};for(const k of ['LOCALAPPDATA','APPDATA','TEMP'])fs.mkdirSync((env as any)[k],{recursive:true});for(const k of Object.keys(env))if(/TYPINGKING|APP_VARIANT|ELECTRON_RUN_AS_NODE|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED/.test(k))delete (env as any)[k];
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$p=Start-Process -FilePath $env:TK_EXE -WorkingDirectory $env:TK_DIR -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)"],{env:{...env,TK_EXE:exe,TK_DIR:dir},encoding:'utf8',windowsHide:true});const pid=Number(result.stdout.trim());assert.ok(pid>0,result.stderr);await new Promise(r=>setTimeout(r,5000));let processes:any[]=[],error:any;try{processes=processTree(pid);}catch(e){error=String(e);}const evidence:any={role,exe,sha256:sha(exe),arguments:[],initialFolderFiles:[path.basename(exe)],pid,processes,error,observedFiles:files(dir),networkIsolation:'NOT_RUN',visualStartup:'NOT_RUN',status:'PARTIAL'};report.ordinaryNoArgument??=[];report.ordinaryNoArgument.push(evidence);report.checks.push({name:'review no-argument '+role,status:'PARTIAL',visualStartup:'NOT_RUN',networkIsolation:'NOT_RUN'});const root=processes.find(p=>p.ProcessId===pid);if(root&&path.resolve(root.ExecutablePath)===path.resolve(exe)){spawnSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true});evidence.cleanup='owned process tree terminated after observation';}evidence.postExit=await postExit(pid,processes.map(p=>p.ProcessId));flush();
}


async function postExit(pid:number,known:number[]=[]){
 const ids=[...new Set([pid,...known])];let remaining:number[]|null=null;let error:string|undefined;
 await until('all observed owned process IDs absent',()=>{const probe=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ids=$env:TK_PIDS.Split(',');$left=@(foreach($item in $ids){$p=Get-Process -Id ([int]$item) -ErrorAction SilentlyContinue;if($p){$p.Id}});ConvertTo-Json -Compress -InputObject $left"],{env:{...process.env,TK_PIDS:ids.join(',')},encoding:'utf8',windowsHide:true,timeout:10000});if(probe.status!==0||probe.error){error=String(probe.error??probe.stderr);return false;}remaining=JSON.parse(probe.stdout||'[]');return remaining?.length===0;},8000).catch(e=>{error=String(e);});
 const remainingIds=remaining as number[]|null;return {checkedIds:ids,remainingIds,allObservedAbsent:remainingIds?.length===0,error};
}

async function cleanupPending(){
 for(const [pid,state]of pendingRoots){
  try{const snapshot=processTree(pid);state.pendingCleanup={snapshot};const errorWindow=snapshot.find(p=>p.MainWindowTitle==='Error');
   if(errorWindow){const observed=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;$p=Get-Process -Id $env:TK_ERROR_PID;$e=[Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle);$e.FindAll([Windows.Automation.TreeScope]::Subtree,[Windows.Automation.Condition]::TrueCondition)|ForEach-Object {$_.Current.Name}"],{env:{...process.env,TK_ERROR_PID:String(errorWindow.ProcessId)},encoding:'utf8',windowsHide:true,timeout:10000});state.nativeError={text:observed.stdout,error:observed.stderr};}
   const root=snapshot.find(p=>p.ProcessId===pid);if(root&&path.resolve(root.ExecutablePath)===path.resolve(state.exe)&&Date.parse(root.CreatedAtUtc)>=Date.parse(state.launchedAt)-5000){spawnSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true});state.pendingCleanup.forced=true;}else state.pendingCleanup.identityMatched=root===undefined;
  }catch(e){state.pendingCleanup={error:String(e),status:'HOLD'};}state.pendingCleanup.postExit=await postExit(pid,(state.pendingCleanup.snapshot??[]).map((p:any)=>p.ProcessId));pendingRoots.delete(pid);
 }
}

function rawNasRecord(recordId:string){
 const matches=Object.keys(files(nas.config.dataRoot)).filter(k=>k.endsWith('/incoming/ai/'+recordId+'.json'));assert.equal(matches.length,1,'Exactly one protected raw record required');const rawPath=path.join(nas.config.dataRoot,matches[0]);return {rawPath,rawSha256:sha(rawPath),row:JSON.parse(fs.readFileSync(rawPath,'utf8'))};
}
function assessPublicStoredWin(input:any,row:any){
 const failures=assessCapturedCanonicalInput(input);if(!row?.record_id)return [...failures,'CAPTURED_STORED_ROW_MISSING'];const expected:any=buildRecordRow(input);for(const key of Object.keys(expected)){if(['created_at','completed_at','recordEvidence'].includes(key))continue;if(JSON.stringify(row[key])!==JSON.stringify(expected[key]))failures.push('CAPTURED_PUBLIC_ROW_MISMATCH:'+key);}return failures;
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
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,encoding:'utf8'});try{const rows=JSON.parse(r.stdout.trim());const windows=(Array.isArray(rows)?rows:[rows]).filter(w=>w.rect.right-w.rect.left>500&&w.rect.bottom-w.rect.top>400);if(windows.length!==1)return {error:'NATIVE_WINDOW_NOT_UNIQUE',windows};const w=windows[0];return {...w,method:'Read-only Win32 owned visible window/monitor bounds and caption style; no renderer emulation',borderlessMonitorFill:!w.caption&&['left','top','right','bottom'].every(k=>Math.abs(w.rect[k]-w.monitor[k])<=1)};}catch{return {error:'NATIVE_WINDOW_READ_FAILED',stderr:r.stderr,stdout:r.stdout};}
}
async function fullscreenKeys(a:Running){
 const cdp=await a.page.context().newCDPSession(a.page);try{await cdp.send('Emulation.clearDeviceMetricsOverride');}finally{await cdp.detach();}
 const observations:any[]=[nativeWindowObservation(a)];
 // Actual keyboard input, never setFullScreen through IPC or viewport dimensions.
 for(let press=1;press<=2;press++){await a.page.keyboard.press('F11');let current:any;await until('F11 native transition',()=>{current=nativeWindowObservation(a);return !current.error&&!observations[0].error&&current.borderlessMonitorFill===(press===1?!observations[0].borderlessMonitorFill:observations[0].borderlessMonitorFill);},6000).catch(()=>{});observations.push(current);await a.page.screenshot({path:path.join(output,`${a.mode}-${a.role}-F11-${press}-native.png`)});}
 a.state.f11={input:'page.keyboard.press(F11) twice',observations,rendererEmulationUsed:false};
 if(observations.some(o=>!o||o.error)){report.checks.push({name:a.mode+' '+a.role+' actual F11 native fullscreen',status:'HOLD',reason:'Native window observation unavailable/ambiguous',observations});flush();return;}
 check(a.mode+' '+a.role+' F11 native monitor-fill toggle and restore',observations[1].borderlessMonitorFill!==observations[0].borderlessMonitorFill&&observations[2].borderlessMonitorFill===observations[0].borderlessMonitorFill&&['left','top','right','bottom'].every(k=>Math.abs(observations[2].rect[k]-observations[0].rect[k])<=2),observations);
}
async function stage1Alpha(a:Running,label:string){
 const observed=await a.page.locator('.challenge-modal-art').evaluate((node)=>{const image=node as HTMLImageElement;const style=getComputedStyle(image);const result:any={src:image.src,currentSrc:image.currentSrc,alt:image.alt,complete:image.complete,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,bounds:image.getBoundingClientRect().toJSON(),css:{opacity:style.opacity,filter:style.filter,mixBlendMode:style.mixBlendMode,maskImage:style.maskImage}};try{const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let zero=0,partial=0,opaque=0;for(let i=3;i<pixels.length;i+=4){if(pixels[i]===0)zero++;else if(pixels[i]===255)opaque++;else partial++;}result.alpha={zero,partial,opaque};}catch(e){result.alphaError=String(e);}return result;});
 const bytes=hashVisibleMappedImages([observed],{[APPROVED_STAGE1_ALPHA.fileName]:APPROVED_STAGE1_ALPHA.sha256});let size:number|undefined;try{size=fs.statSync(fileURLToPath(observed.currentSrc||observed.src)).size;}catch{}const actual=bytes.images[0];report.captures.at(-1).stage1Alpha={observed,bytes,size,approved:APPROVED_STAGE1_ALPHA,manualExeVisualJudgment:'NOT_RUN'};
 check(label+' approved stage1 alpha actually loaded',observed.complete&&observed.bounds.width>0&&observed.bounds.height>0&&actual?.fileName===APPROVED_STAGE1_ALPHA.fileName&&actual.approvedBytesMatch===true&&size===APPROVED_STAGE1_ALPHA.bytes&&observed.css.opacity==='1'&&observed.css.filter==='none'&&observed.css.mixBlendMode==='normal'&&observed.css.maskImage==='none',{observed,bytes,size});
 if(observed.alphaError){report.checks.push({name:label+' loaded image transparent pixels',status:'HOLD',reason:observed.alphaError});}else check(label+' loaded image approved transparent pixel counts',observed.alpha?.zero===APPROVED_STAGE1_ALPHA.zero&&observed.alpha?.partial===APPROVED_STAGE1_ALPHA.partial&&observed.alpha?.opaque===APPROVED_STAGE1_ALPHA.opaque,observed.alpha);
 report.checks.push({name:label+' actual EXE alpha edge and dark-detail visual judgment',status:'NOT_RUN',reason:'PNG captured from actual EXE; manual image judgment must be recorded separately. No CSS background masking applied.'});flush();
}
async function presentationChecks(a:Running,name:string,width:number,height:number){
 if(!name.startsWith('gameplay-stage')&&!name.startsWith('win-stage')&&!name.startsWith('loss-stage')&&a.role!=='leaderboard')return;
 const observation=await a.page.evaluate(({name})=>{
  if(name.startsWith('gameplay-stage')){const input=document.querySelector('textarea.typing-input') as HTMLTextAreaElement|null;const target=document.querySelector('.duel-target');return {kind:'caret',fakeCarets:document.querySelectorAll('.typing-cursor-anchor,.typing-cursor').length,input:(input?.getBoundingClientRect().toJSON()??null),target:(target?.getBoundingClientRect().toJSON()??null),active:document.activeElement===input,disabled:input?.disabled,caretColor:input?getComputedStyle(input).caretColor:null,selectionStart:input?.selectionStart,selectionEnd:input?.selectionEnd};}
  if(name.startsWith('win-stage')||name.startsWith('loss-stage')){const heading=document.querySelector('.challenge-modal-message h2') as HTMLElement|null;const badge=document.querySelector('.challenge-modal-message .compact-badges');const painted=Array.from(badge?.querySelectorAll('*')??[]).map(e=>({...e.getBoundingClientRect().toJSON()})).filter((r:any)=>r&&r.width>0&&r.height>0);const lineRects:any[]=[];if(heading){const walker=document.createTreeWalker(heading,NodeFilter.SHOW_TEXT);while(walker.nextNode()){if(!walker.currentNode.textContent?.trim())continue;const range=document.createRange();range.selectNodeContents(walker.currentNode);lineRects.push(...Array.from(range.getClientRects()).map(r=>({...r.toJSON()})));}}return {kind:'popup',text:heading?.innerText,align:heading?getComputedStyle(heading).textAlign:null,heading:(heading?.getBoundingClientRect().toJSON()??null),badge:(badge?.getBoundingClientRect().toJSON()??null),paintedBadge:painted,lineTops:[...new Set(lineRects.map(r=>Math.round(r.top)))],lineRects};}
  const logo=document.querySelector('.geumcheon-leaderboard-logo') as HTMLImageElement|null;const selectors=['.leaderboard-header','.leader-actions','.search-input','.leaderboard-board','.leaderboard-session','.ranking-body'];const geometry=Object.fromEntries(selectors.map(s=>{const e=document.querySelector(s);return [s,e?{...e.getBoundingClientRect().toJSON(),scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,overflowY:getComputedStyle(e).overflowY}:null];}));const buttons=Array.from(document.querySelectorAll('.leader-actions button')).map(e=>({text:(e as HTMLElement).innerText,...e.getBoundingClientRect().toJSON()}));return {kind:'leaderboard',logo:logo?{...logo.getBoundingClientRect().toJSON(),naturalWidth:logo.naturalWidth,naturalHeight:logo.naturalHeight,complete:logo.complete}:null,geometry,buttons,rowCount:document.querySelectorAll('.ai-ranking .ranking-row').length,documentScroll:{height:document.documentElement.scrollHeight,width:document.documentElement.scrollWidth}};
 },{name});
 report.captures.at(-1).presentation=observation;const o:any=observation;const label=`${a.mode} ${name} ${width}`;
 if(o.kind==='caret'){check(label+' bottom native caret only',o.fakeCarets===0&&o.active&&!o.disabled&&o.input&&o.target&&o.input.top>=o.target.bottom-1&&!['transparent','rgba(0, 0, 0, 0)'].includes(o.caretColor),{...o,scope:'DOM focus/native caret color and no simulated caret; blinking pixels/human IME not proved'});}
  if(o.kind==='popup'){const expected=name.startsWith('win')?'승리했습니다.\n금나래보다 빠르게 입력했습니다.':'아쉽습니다.\n금나래가 먼저 입력을 완료했습니다.';check(label+' exact two rendered lines left aligned',o.text===expected&&o.lineTops.length===2&&o.align==='left',o);const bottom=Math.max(o.badge?.bottom??Infinity,...o.paintedBadge.map((r:any)=>r.bottom));check(label+' full badge painted bbox gap',Boolean(o.heading)&&o.heading.top-bottom>=15.5,{badgeBottom:bottom,headingTop:o.heading?.top,gap:o.heading?.top-bottom,paintedBadge:o.paintedBadge});if(name==='win-stage-1')await stage1Alpha(a,label);}
 if(o.kind==='leaderboard'){const g=o.geometry;const search=g['.search-input'];const actions=g['.leader-actions'];check(label+' logo and controls do not collide',Boolean(o.logo&&search&&actions)&&o.logo.right<=actions.left+1&&search.left>=0&&search.right<=width+1&&search.top>=0&&search.bottom<=height+1,{logo:o.logo,actions,search});}
 if(o.kind==='leaderboard'){const logo=o.logo;const fit=(r:any)=>r&&r.width>0&&r.height>0&&r.left>=-1&&r.top>=-1&&r.right<=width+1&&r.bottom<=height+1;check(label+' enlarged original-ratio logo',logo?.complete&&logo.naturalWidth===1672&&logo.naturalHeight===941&&Math.abs(logo.width-Math.min(width*.38,760))<=1&&Math.abs(logo.width/logo.height-logo.naturalWidth/logo.naturalHeight)<.01,logo);const g=o.geometry;check(label+' header actions table fit viewport',fit(logo)&&fit(g['.leaderboard-header'])&&fit(g['.leader-actions'])&&fit(g['.leaderboard-board'])&&o.buttons.length>0&&o.buttons.every(fit)&&o.documentScroll.width<=width+1&&o.documentScroll.height<=height+1,o);if(o.rowCount>=10){const scrolled=await a.page.locator('.ai-ranking .ranking-body').evaluate(e=>{const old=e.scrollTop;e.scrollTop=e.scrollHeight;const v={scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight};e.scrollTop=old;return v;});check(label+' seeded rows scroll inside table',scrolled.clientHeight>0&&scrolled.scrollTop>0,scrolled);}else if(name==='leaderboard'){report.checks.push({name:label+' populated table scrolling',status:'NOT_RUN',reason:'Fewer than ten authenticated stored rows; no invented records to hide persistence failure'});flush();}}
}
async function packagedNegative(source:string,negative:'missing-credentials'|'untrusted-ca'){
 let a:Running|undefined;const before=nas.requests.filter((r:any)=>r.method==='POST'&&r.status<300).length;try{a=await launch('nas','game',source,negative);const response=await a.page.evaluate(async()=> (window as any).typingKing.checkGameStartReadiness('ai_challenge'));check('actual NAS EXE '+negative+' readiness blocked',response?.data?.ready===false,{scope:'actual EXE, fresh isolated profile/data, synthetic HTTPS only',response});await capture(a,'negative-'+negative);check('actual NAS EXE '+negative+' no accepted write',nas.requests.filter((r:any)=>r.method==='POST'&&r.status<300).length===before);}catch(e){report.checks.push({name:'actual NAS EXE '+negative,status:'HOLD',reason:String(e)});}finally{if(a&&owned.has(a))await close(a);await cleanupPending();flush();}
}
main().catch(async e=>{report.error=String(e);report.status='FAIL';await cleanupPending();report.completedAt=new Date().toISOString();flush();console.error(e);process.exitCode=1;});
