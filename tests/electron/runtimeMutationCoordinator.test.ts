import assert from "node:assert/strict";
import test from "node:test";
import {RuntimeMutationCoordinator} from "../../electron/runtimeMutationCoordinator";

function deferred<T=void>() {
  let resolve!:(value:T|PromiseLike<T>)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}
const busy={message:"PROFILE_BUSY_RECORDS"};
const stale={message:"PROFILE_CONFIGURATION_CHANGED"};

test("registers an accepted write synchronously so a transition cannot overtake its first await",async()=>{
  const gate=new RuntimeMutationCoordinator(),release=deferred(),started=deferred();
  const epoch=gate.epoch,events:string[]=[];
  const write=gate.runMutation(epoch,async()=>{events.push("write");started.resolve();await release.promise;});
  assert.throws(()=>gate.runTransition(()=>{events.push("transition");}),busy);
  await started.promise;release.resolve();await write;
  assert.deepEqual(events,["write"]);assert.equal(gate.epoch,epoch);
});

test("queued writes remain transition blockers and execute in accepted order",async()=>{
  const gate=new RuntimeMutationCoordinator(),first=deferred(),second=deferred(),secondStarted=deferred();
  const epoch=gate.epoch,events:string[]=[];
  const one=gate.runMutation(epoch,async()=>{events.push("first");await first.promise;});
  const two=gate.runMutation(epoch,async()=>{events.push("second");secondStarted.resolve();await second.promise;});
  first.resolve();await one;await secondStarted.promise;
  assert.throws(()=>gate.runTransition(()=>undefined),busy);
  second.resolve();await two;assert.deepEqual(events,["first","second"]);
});

test("a transition rejects old-context work both while preparing and after successful commit",async()=>{
  const gate=new RuntimeMutationCoordinator(),release=deferred();
  const old=gate.epoch;let writes=0;
  const change=gate.runTransition(async()=>{await release.promise;return "committed";});
  assert.throws(()=>gate.runMutation(old,()=>{writes++;}),busy);
  assert.throws(()=>gate.runTransition(()=>undefined),busy);
  release.resolve();assert.equal(await change,"committed");
  assert.notEqual(gate.epoch,old);
  assert.throws(()=>gate.runMutation(old,()=>{writes++;}),stale);
  assert.equal(writes,0);
  await gate.runMutation(gate.epoch,()=>{writes++;});assert.equal(writes,1);
});

test("failed preparation leaves the original epoch usable",async()=>{
  const gate=new RuntimeMutationCoordinator(),epoch=gate.epoch;
  await assert.rejects(gate.runTransition(()=>{throw Error("PREPARE_FAILED");}),{message:"PREPARE_FAILED"});
  assert.equal(gate.epoch,epoch);
  let saved=false;await gate.runMutation(epoch,()=>{saved=true;});assert.equal(saved,true);
});

test("close lifecycle blocks transitions while allowing its final same-context checkpoint",async()=>{
  const gate=new RuntimeMutationCoordinator(),epoch=gate.epoch,ticket=gate.beginLifecycle(epoch);
  const events:string[]=[];
  assert.throws(()=>gate.runTransition(()=>undefined),busy);
  await gate.runMutation(ticket.epoch,()=>{events.push("final-checkpoint");});
  await gate.runMutation(ticket.epoch,()=>{events.push("recovery");});
  assert.throws(()=>gate.runTransition(()=>undefined),busy);
  ticket.release();ticket.release();
  await gate.runTransition(()=>{events.push("transition");});
  assert.deepEqual(events,["final-checkpoint","recovery","transition"]);assert.notEqual(gate.epoch,epoch);
});

test("a failed write releases its pending slot without losing later accepted work",async()=>{
  const gate=new RuntimeMutationCoordinator(),epoch=gate.epoch;
  const first=gate.runMutation(epoch,()=>{throw Error("WRITE_FAILED");});
  const second=gate.runMutation(epoch,()=>"later");
  await assert.rejects(first,{message:"WRITE_FAILED"});assert.equal(await second,"later");
  await gate.runTransition(()=>undefined);assert.notEqual(gate.epoch,epoch);
});

test("missing and stale contexts cannot write or begin a closing lifecycle",()=>{
  const gate=new RuntimeMutationCoordinator();
  for(const epoch of [undefined,null,"","unissued-context"]){
    assert.throws(()=>gate.runMutation(epoch,()=>undefined),stale);
    assert.throws(()=>gate.beginLifecycle(epoch),stale);
  }
});

test("a close beginning during transition is rejected rather than joining the new runtime",async()=>{
  const gate=new RuntimeMutationCoordinator(),epoch=gate.epoch,release=deferred();
  const change=gate.runTransition(()=>release.promise);
  assert.throws(()=>gate.beginLifecycle(epoch),busy);
  release.resolve();await change;
});
