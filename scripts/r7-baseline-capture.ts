import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {chromium, type Page} from 'playwright-core';
import {processTree} from './r5-standalone-review-check';

const root=path.resolve('Codex/Evidence/R7/before');
const run=path.join(root,`run-${Date.now()}`);
fs.mkdirSync(run,{recursive:true});
const index:any={sourceCommit:'260103b367a39ff0cd30f8a4cd4a6c73f265d348',method:'actual R6 portable EXE, isolated directories, CDP automated UI; no injected records',run,captures:[],results:[]};
const write=()=>fs.writeFileSync(path.join(run,'index.json'),JSON.stringify(index,null,2));
async function capture(page:Page,name:string,exe:string){
  for(const [width,height] of [[1280,720],[1920,1080]]){
    await page.setViewportSize({width,height});
    await page.waitForFunction(({width,height})=>innerWidth===width&&innerHeight===height,{width,height});
    const geometry=await page.evaluate(()=>{
      const selectors=['.hero-panel','.geumcheon-main-title-image','.hero-copy','.geumcheon-main-robot','.hero-guide-card','.hero-guide-list','.challenge-modal','.challenge-result-panel'];
      const rects=Object.fromEntries(selectors.map(s=>[s,document.querySelector(s)?.getBoundingClientRect().toJSON()??null]));
      const r=rects as any;
      return {innerWidth,innerHeight,outerWidth,outerHeight,screenX,screenY,devicePixelRatio,screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight},rects,gaps:{logoCopy:r['.hero-copy']&&r['.geumcheon-main-title-image']?r['.hero-copy'].top-r['.geumcheon-main-title-image'].bottom:null,copyRobot:r['.geumcheon-main-robot']&&r['.hero-copy']?r['.geumcheon-main-robot'].top-r['.hero-copy'].bottom:null,robotGuide:r['.hero-guide-card']&&r['.geumcheon-main-robot']?r['.hero-guide-card'].top-r['.geumcheon-main-robot'].bottom:null},text:document.body.innerText};
    });
    const screenshot=path.join(run,`${name}-${width}x${height}.png`);
    await page.screenshot({path:screenshot});
    index.captures.push({name,exe,screenshot,geometry});write();
    if(name==='main')console.log(JSON.stringify({name,width,height,geometry}));
  }
}
async function main(){
 for(const [role,file] of [['game','G-Science AI 타자왕_검토용.exe'],['leaderboard','G-Science AI 타자왕_리더보드_검토용.exe']]){
  if(process.argv.includes('--leaderboard-only')&&role==='game')continue;
  const exe=path.join(root,'executables',file),port=role==='game'?19371:19372;
  const env:any=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(TOKEN|SECRET|PASSWORD|CREDENTIAL|API.?KEY|PRIVATE.?KEY)/i.test(k)&&!['APP_VARIANT','TYPINGKING_EVENT_PROFILE','TYPINGKING_RUNTIME_ROOT','NODE_TLS_REJECT_UNAUTHORIZED','NODE_EXTRA_CA_CERTS'].includes(k)));
  for(const k of ['LOCALAPPDATA','APPDATA','TEMP','TMP']){env[k]=path.join(k==='LOCALAPPDATA'&&process.env.R7_BASELINE_DATA?process.env.R7_BASELINE_DATA:run,k);fs.mkdirSync(env[k],{recursive:true});}
  const userData=path.join(run,'UserData',role);fs.mkdirSync(userData,{recursive:true});
  const launch=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$p=Start-Process -FilePath $env:TK_EXE -ArgumentList @('--remote-debugging-port='+$env:TK_PORT, '--user-data-dir='+$env:TK_DATA) -WindowStyle Hidden -PassThru; [Console]::Out.Write($p.Id)"],{env:{...env,TK_EXE:exe,TK_PORT:String(port),TK_DATA:userData},windowsHide:true,encoding:'utf8'});
  const pid=Number(launch.stdout.trim());
  const result:any={role,exe,sha256:crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),pid};index.results.push(result);write();
  let browser:any,page:Page|undefined;
  try{
   let endpoint='';const until=Date.now()+90000;
   while(!endpoint&&Date.now()<until){try{endpoint=(await (await fetch(`http://127.0.0.1:${port}/json/version`)).json() as any).webSocketDebuggerUrl;}catch{} if(!endpoint)await new Promise(r=>setTimeout(r,500));}
   if(!endpoint)throw Error(`CDP unavailable ${launch.stderr}`);
   browser=await chromium.connectOverCDP(endpoint);page=browser.contexts()[0].pages()[0];
   await page!.waitForFunction(()=>Boolean((window as any).typingKing));
   result.bootstrap=await page!.evaluate(async()=> (window as any).typingKing.getBootstrap());
   await page!.getByRole('button',{name:role==='game'?'관리자 모드':'관리자',exact:true}).click();
   await page!.locator('.admin-modal input').nth(0).fill('synthetic-r7-baseline');
   await page!.locator('.admin-modal input').nth(1).fill('0208');
   await page!.getByRole('button',{name:role==='game'?'비밀번호 확인':'진입',exact:true}).click();
   await page!.getByRole('button',{name:'로컬 저장소 검증'}).click();
   await page!.waitForFunction(()=>document.querySelector('.geumcheon-nas-status-panel .notice-text')?.textContent?.includes('정상'));
   await capture(page!,`${role}-admin`,exe);
   await page!.getByRole('button',{name:'닫기',exact:true}).click();
   if(role==='leaderboard'){await capture(page!,'leaderboard',exe);result.records=await page!.evaluate(async()=> (window as any).typingKing.listRecords());continue;}
   await capture(page!,'main',exe);
   const start=async()=>{
    await page!.locator('.entry-form-group input').first().fill('합성기준검증');
    await page!.locator('.phone-row input').nth(0).fill('0000');await page!.locator('.phone-row input').nth(1).fill('1234');
    for(const [n,value] of ['2012','1','2'].entries())await page!.locator('.birth-row select').nth(n).selectOption(value);
    await page!.locator('.entry-form-group input[type="checkbox"]').check();
    await page!.locator('.entry-panel .button-row .primary-button').click();
   };
   await start();
   for(let lossStage=0;lossStage<=3;lossStage++){
    for(let stage=1;stage<=3;stage++){
     const input=page!.locator('textarea.typing-input');await input.waitFor({state:'visible'});
     await page!.waitForFunction(()=>!(document.querySelector('textarea.typing-input') as HTMLTextAreaElement)?.disabled);
     if(lossStage===0)await capture(page!,`gameplay-stage-${stage}`,exe);
     if(stage===lossStage){await page!.locator('.challenge-modal').waitFor({state:'visible',timeout:150000});await capture(page!,`loss-stage-${stage}`,exe);await page!.locator('.challenge-modal .primary-button').click();break;}
     await input.fill((await page!.locator('.duel-target').first().innerText()).replace(/\u00a0/g,' ').trim());
     await page!.locator('.challenge-modal').waitFor({state:'visible'});
     if(lossStage===0)await capture(page!,`win-stage-${stage}`,exe);
     await page!.locator('.challenge-modal .primary-button').click();
    }
    if(lossStage===0){await page!.locator('.challenge-result-panel').waitFor({state:'visible'});await capture(page!,'final-victory',exe);await page!.getByRole('button',{name:'다시 도전하기',exact:true}).click();}
   }
   result.records=await page!.evaluate(async()=> (window as any).typingKing.listRecords());
  }catch(e){result.error=String(e);if(page)await page.screenshot({path:path.join(run,`${role}-failure.png`)}).catch(()=>{});}
  finally{if(page)await page.close().catch(()=>{});if(browser)await browser.close().catch(()=>{});result.processesAfter=processTree(pid);if(result.processesAfter.length){spawnSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true});result.forcedCleanup=true;}write();}
 }
 console.log(JSON.stringify({run,results:index.results.map(({role,error}:any)=>({role,error})),captures:index.captures.length}));
}
main().catch(e=>{index.error=String(e);write();console.error(e);process.exitCode=1;});
