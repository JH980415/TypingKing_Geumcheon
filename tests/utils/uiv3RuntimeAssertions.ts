import {isDeepStrictEqual} from 'node:util';
type Rect=Record<string,any>;
export class ReadOnlyRecordOracle<T>{
 private generation=0;
 private cached:{generation:number;value:T}|undefined;
 async read(fetchFresh:()=>Promise<T>):Promise<T>{
  if(this.cached?.generation===this.generation)return structuredClone(this.cached.value);
  const generation=this.generation,value=await fetchFresh();
  if(generation===this.generation)this.cached={generation,value:structuredClone(value)};
  return value;
 }
 invalidate(){this.generation++;this.cached=undefined;}
}
export function assessProcessAbsence(expectedIds:number[],observations:{pid:number;exists:boolean|null;error?:string}[],probeError?:string){
 const remainingIds=observations.filter(p=>p.exists===true).map(p=>p.pid);
 const complete=expectedIds.length>0&&expectedIds.every(id=>observations.filter(p=>p.pid===id).length===1)&&observations.every(p=>expectedIds.includes(p.pid));
 const errors=[...(probeError?[probeError]:[]),...observations.flatMap(p=>p.error?[p.error]:[])];
 return {checkedIds:expectedIds,remainingIds,allObservedAbsent:complete&&errors.length===0&&observations.every(p=>p.exists===false),error:errors.length?errors.join('; '):complete?undefined:'INCOMPLETE_PROCESS_PROBE'};
}
export type CaptureLayoutDriver={foreground:()=>Promise<void>;ready:()=>Promise<void>;frame:()=>Promise<void>;sample:()=>Promise<unknown>};
export async function waitForCaptureLayout(driver:CaptureLayoutDriver,maxFrames=120){
 await driver.foreground();
 await driver.ready();
 await driver.frame();await driver.frame();
 let frameCount=2,stableSamples=1,layout=await driver.sample();
 while(frameCount<maxFrames){
  await driver.frame();frameCount++;
  const next=await driver.sample();stableSamples=isDeepStrictEqual(layout,next)?stableSamples+1:1;layout=next;
  if(stableSamples>=3)return {frameCount,stableSamples,layout};
 }
 throw Error('CAPTURE_LAYOUT_DID_NOT_SETTLE:'+frameCount);
}
export function assessControlPresentation(controls:Rect[],width:number):string[]{
 // Independent measured baselines: uiv3LeaderboardLayout.browser.ts control observations, 720 and 1080.
 const baseline=width===1280?{fieldHeight:44,buttonHeight:46,fieldFont:'16px',buttonFont:'14px'}:width===1920?{fieldHeight:58,buttonHeight:56,fieldFont:'16px',buttonFont:'16px'}:null;
 if(!baseline)return ['CONTROL_VIEWPORT_UNMEASURED'];
 const failures:string[]=[];
 if(controls.map(c=>c.tag==='BUTTON'?c.text:c.tag).join('|')!=='SELECT|INPUT|검색|새로고침|관리자')failures.push('CONTROL_ORDER');
 for(const control of controls){
  const button=control.tag==='BUTTON',name=button?control.text:control.tag;
  const minimum=control.tag==='SELECT'?80:control.tag==='INPUT'?160:control.text==='검색'?56:0;
  if(!Number.isFinite(control.width)||control.width<minimum)failures.push('CONTROL_WIDTH:'+name);
  if(control.height!==(button?baseline.buttonHeight:baseline.fieldHeight))failures.push('CONTROL_HEIGHT:'+name);
  if(control.fontSize!==(button?baseline.buttonFont:baseline.fieldFont))failures.push('CONTROL_FONT:'+name);
 }
 return failures;
}
export function runtimeVerdicts(value:any):{overall:'FAIL'|'PARTIAL'|'PASS';automatedSubset:'FAIL'|'PASS'}{
 const exits=[...(value.apps??[]).flatMap((a:any)=>[a.cleanup?.postExit,a.pendingCleanup?.postExit]),...(value.ordinaryNoArgument??[]).map((a:any)=>a.postExit)].filter(Boolean);
 const failed=Boolean(value.error)||observedRuntimeFailures(value).length>0||value.checks.some((c:any)=>c.passed===false)||exits.some((e:any)=>e.allObservedAbsent!==true);
 return {overall:failed?'FAIL':value.limitations.length||value.checks.some((c:any)=>c.status==='PARTIAL'||c.status==='NOT_RUN'||c.status==='HOLD')?'PARTIAL':'PASS',automatedSubset:failed?'FAIL':'PASS'};
}
export function assessLogoGeometry(canvas:Rect,painted:Rect,board:Rect):string[]{
 const failures:string[]=[];
 if(!canvas||!painted||!board||[canvas,painted,board].some(r=>['x','y','width','height'].some(k=>!Number.isFinite(r[k]))||r.width<=0||r.height<=0))return ['LOGO_GEOMETRY_MISSING'];
 if(Math.abs((canvas.width/canvas.height)/(2048/682)-1)>.005)failures.push('LOGO_ASPECT_RATIO');
 if(Math.abs(painted.x+painted.width/2-board.x-board.width/2)>2)failures.push('LOGO_CENTER_X');
 if(Math.abs(painted.y+painted.height/2-board.y)>2)failures.push('LOGO_CENTER_Y');
 if(canvas.y<8)failures.push('LOGO_TOP_CLEARANCE');
 return failures;
}
export function compareStableBoxes(before:Record<string,Rect>,after:Record<string,Rect>,selectors:string[]):{selector:string;key:string;before:any;after:any}[]{
 const differences:{selector:string;key:string;before:any;after:any}[]=[];
 for(const selector of selectors)for(const key of ['x','y','width','height']){
  let prior=before[selector]?.[key],next=after[selector]?.[key];
  if(key==='width'&&['.ranking-head','.ai-head'].includes(selector)){
   prior+=before['.ranking-body']?.scrollbarWidth??0;
   next+=after['.ranking-body']?.scrollbarWidth??0;
  }
  if(!Number.isFinite(prior)||!Number.isFinite(next)||Math.abs(prior-next)>2)differences.push({selector,key,before:prior,after:next});
 }
 return differences;
}
export function observedRuntimeFailures(value:any):string[]{
 return (value.apps??[]).flatMap((app:any)=>[
  ...(app.rendererErrors??[]).map(String),
  ...(app.lifecycle??[]).filter((event:any)=>event.kind==='page-error'||event.kind==='page-crash'||(['page-close','browser-disconnected'].includes(event.kind)&&!event.intentionalClose)).map((event:any)=>event.detail??event.kind)
 ]);
}
