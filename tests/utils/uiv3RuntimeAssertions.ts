type Rect=Record<string,any>;
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
