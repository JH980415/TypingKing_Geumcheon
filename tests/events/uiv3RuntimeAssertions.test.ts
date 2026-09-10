import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assessLogoGeometry, compareStableBoxes, observedRuntimeFailures} from '../utils/uiv3RuntimeAssertions';

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
