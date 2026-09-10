import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assessControlPresentation, assessLogoGeometry, assessProcessAbsence, compareStableBoxes, observedRuntimeFailures, ReadOnlyRecordOracle, runtimeVerdicts, waitForCaptureLayout} from '../utils/uiv3RuntimeAssertions';

// These literal fixtures are independent of the product's placement helpers.
const board={x:29,y:113.25,width:1224,height:592.89};
const canvas={x:333.8,y:5.57,width:614.4,height:204.6};
const painted={x:340.1,y:25.37,width:601.8,height:162.3};
test('rejects a stretched logo even when its visible center is correct',()=>{
  assert.ok(assessLogoGeometry({...canvas,y:8,width:614.4,height:130},{x:340.1,y:32.1,width:601.8,height:162.3},board).includes('LOGO_ASPECT_RATIO'));
});
test('rejects a logo centered on the inner header instead of the outer border',()=>{
  assert.ok(assessLogoGeometry({...canvas,y:12.32},{...painted,y:32.12+6},board).includes('LOGO_CENTER_Y'));
});
test('accepts the independently calculated proportional border-straddling logo',()=>{
  assert.deepEqual(assessLogoGeometry({...canvas,y:12.30},{...painted,y:32.10},board),[]);
});
test('rejects outer box shrink while accepting a native scrollbar header-width change',()=>{
  const before={'.leaderboard-board':board,'.ranking-body':{x:51,y:231.8,width:1180,height:451,scrollbarWidth:0},'.ranking-head':{x:51,y:231.8,width:1180,height:64}};
  const after={...before,'.ranking-body':{...before['.ranking-body'],scrollbarWidth:15},'.ranking-head':{...before['.ranking-head'],width:1165}};
  assert.deepEqual(compareStableBoxes(before,after,Object.keys(before)),[]);
  assert.ok(compareStableBoxes(before,{...after,'.leaderboard-board':{...board,width:1209}},Object.keys(before)).some(v=>v.selector==='.leaderboard-board'&&v.key==='width'));
});
test('fails unknown renderer errors and preserves their exact diagnostic text',()=>{
  assert.deepEqual(observedRuntimeFailures({apps:[{lifecycle:[{kind:'page-error',detail:'Unexpected new renderer failure 42'}]}]}),['Unexpected new renderer failure 42']);
  assert.deepEqual(observedRuntimeFailures({apps:[{lifecycle:[{kind:'page-close',intentionalClose:true}]}]}),[]);
});
const controls720=[
 {tag:'SELECT',text:'성명연락처',width:100,height:44,fontSize:'16px'},
 {tag:'INPUT',text:'',width:200,height:44,fontSize:'16px'},
 {tag:'BUTTON',text:'검색',width:56,height:46,fontSize:'14px'},
 {tag:'BUTTON',text:'새로고침',width:84,height:46,fontSize:'14px'},
 {tag:'BUTTON',text:'관리자',width:68,height:46,fontSize:'14px'}
];
const controls1080=[
 {tag:'SELECT',text:'성명연락처',width:100,height:58,fontSize:'16px'},
 {tag:'INPUT',text:'',width:276,height:58,fontSize:'16px'},
 {tag:'BUTTON',text:'검색',width:56,height:56,fontSize:'16px'},
 {tag:'BUTTON',text:'새로고침',width:98,height:56,fontSize:'16px'},
 {tag:'BUTTON',text:'관리자',width:80,height:56,fontSize:'16px'}
];
test('accepts preserved 720 control heights and per-control fonts',()=>{
 assert.deepEqual(assessControlPresentation(controls720,1280),[]);
});
test('accepts preserved 1080 control heights and fonts',()=>{
 assert.deepEqual(assessControlPresentation(controls1080,1920),[]);
});
test('rejects an altered 1080 button height even when it still exceeds the old minimum',()=>{
 assert.notDeepEqual(assessControlPresentation(controls1080.map((c,i)=>i===2?{...c,height:58}:c),1920),[]);
});
test('rejects narrowed search button while retaining field minimums and order',()=>{
 assert.notDeepEqual(assessControlPresentation(controls1080.map((c,i)=>i===2?{...c,width:55}:c),1920),[]);
});
for(const [name,details]of Object.entries({
 cleanup:{apps:[{cleanup:{postExit:{allObservedAbsent:false}}}]},
 pendingCleanup:{apps:[{pendingCleanup:{postExit:{allObservedAbsent:false}}}]},
 ordinaryNoArgument:{ordinaryNoArgument:[{postExit:{allObservedAbsent:false}}]},
 bothCleanupReceipts:{apps:[{cleanup:{postExit:{allObservedAbsent:true}},pendingCleanup:{postExit:{allObservedAbsent:false}}}]}
})){
 test('fails both verdicts for '+name+' process-cleanup failure',()=>{
  assert.deepEqual(runtimeVerdicts({checks:[],limitations:[],...details}),{overall:'FAIL',automatedSubset:'FAIL'});
 });
}
test('successful cleanup keeps unrun limitations partial without inventing an automated failure',()=>{
 assert.deepEqual(runtimeVerdicts({checks:[],limitations:['Native F11 NOT_RUN'],apps:[{cleanup:{postExit:{allObservedAbsent:true}}}]}),{overall:'PARTIAL',automatedSubset:'PASS'});
});
test('waits for foreground fonts and deferred ResizeObserver geometry before capture measurement',async()=>{
 const events:string[]=[];let frame=0;
 const result=await waitForCaptureLayout({
  foreground:async()=>{events.push('foreground');},
  ready:async()=>{events.push('fonts-ready');},
  frame:async()=>{frame++;events.push('frame');},
  sample:async()=>{events.push('sample');return {centerOffset:frame<2?80.59375:113.421875};}
 });
 assert.deepEqual(result.layout,{centerOffset:113.421875});
 assert.deepEqual(events.slice(0,4),['foreground','fonts-ready','frame','frame']);
 assert.ok(result.frameCount>=4&&result.stableSamples>=3);
});
test('stable-layout wait accepts stable wrong coordinates so geometry assertions can fail them independently',async()=>{
 const result=await waitForCaptureLayout({foreground:async()=>{},ready:async()=>{},frame:async()=>{},sample:async()=>({centerOffset:-27})});
 assert.deepEqual(result.layout,{centerOffset:-27});
});
test('unstable layout stops at its frame bound instead of producing a premature capture',async()=>{
 let frame=0;
 await assert.rejects(waitForCaptureLayout({foreground:async()=>{},ready:async()=>{},frame:async()=>{frame++;},sample:async()=>({x:frame})},6),/CAPTURE_LAYOUT_DID_NOT_SETTLE/);
});
test('a failed or incomplete process probe cannot claim absence from an empty list',()=>{
 assert.equal(assessProcessAbsence([69520],[],'probe failed').allObservedAbsent,false);
 assert.equal(assessProcessAbsence([69520],[]).allObservedAbsent,false);
 assert.equal(assessProcessAbsence([69520],[{pid:69520,exists:null,error:'Access denied'}]).allObservedAbsent,false);
});
test('explicit per-PID absence proves cleanup while an alive extracted child fails it',()=>{
 assert.equal(assessProcessAbsence([69520],[{pid:69520,exists:false}]).allObservedAbsent,true);
 assert.equal(assessProcessAbsence([69520,68764],[{pid:69520,exists:false},{pid:68764,exists:true}]).allObservedAbsent,false);
});
test('read-only label oracle reuses stored-row evidence until a write invalidates it',async()=>{
 const oracle=new ReadOnlyRecordOracle<string[]>();let reads=0;let current=['saved-before'];
 const fetch=async()=>{reads++;return [...current];};
 assert.deepEqual(await oracle.read(fetch),['saved-before']);
 assert.deepEqual(await oracle.read(fetch),['saved-before']);assert.equal(reads,1);
 current=['saved-after'];oracle.invalidate();
 assert.deepEqual(await oracle.read(fetch),['saved-after']);assert.equal(reads,2);
});
test('invalidation during a pending oracle read prevents the stale reply from becoming cached evidence',async()=>{
 const oracle=new ReadOnlyRecordOracle<string[]>();let release:(rows:string[])=>void=()=>{};
 const pending=oracle.read(()=>new Promise<string[]>(resolve=>{release=resolve;}));
 oracle.invalidate();release(['old']);await pending;
 assert.deepEqual(await oracle.read(async()=>['fresh']),['fresh']);
});
test('label oracle does not retain failed reads or let a caller change its stored evidence',async()=>{
 const oracle=new ReadOnlyRecordOracle<string[]>();
 await assert.rejects(oracle.read(async()=>{throw Error('429');}),/429/);
 const first=await oracle.read(async()=>['saved']);first.push('mutated');
 const second=await oracle.read(async()=>['wrong']);assert.deepEqual(second,['saved']);second.push('mutated-again');
 assert.deepEqual(await oracle.read(async()=>['wrong']),['saved']);
});
