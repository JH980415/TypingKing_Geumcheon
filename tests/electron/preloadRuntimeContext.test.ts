import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function loadPreload(bootstraps:any[]) {
  let api:any;
  const calls:{channel:string;args:any[]}[]=[];
  const electron={
    contextBridge:{exposeInMainWorld(_name:string,value:any){api=value;}},
    ipcRenderer:{
      async invoke(channel:string,...args:any[]){calls.push({channel,args});return channel==="app:getBootstrap"?bootstraps.shift():{ok:true,data:true};},
      on(){},removeListener(){},send(){}
    }
  };
  const file=path.resolve(__dirname,"../../electron/preload.ts");
  const code=ts.transpileModule(fs.readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code,{exports:{},require:(name:string)=>{assert.equal(name,"electron");return electron;}},{filename:file});
  return {api,calls};
}
function success(epoch?:string){return {ok:true,data:epoch===undefined?{}:{runtimeContextEpoch:epoch}};}

test("the first document bootstrap epoch accompanies checkpoint, save and clear without changing record payloads",async()=>{
  const {api,calls}=loadPreload([success("first-context")]),input={participant_name:"synthetic"};
  await api.getBootstrap();
  await api.checkpointActiveAttempt(input,"close-id");await api.saveRecord(input);await api.clearRecords("admin");
  const writes=calls.filter(call=>call.channel!=="app:getBootstrap");
  assert.equal(writes[0].channel,"records:checkpointActiveAttempt");
  assert.equal(writes[0].args[0],input);assert.equal(writes[0].args[1],"close-id");assert.equal(writes[0].args[2],"first-context");
  assert.equal(writes[1].channel,"records:save");assert.equal(writes[1].args[0],input);assert.equal(writes[1].args[1],"first-context");
  assert.equal(writes[2].channel,"records:clear");assert.equal(writes[2].args[0],"admin");assert.equal(writes[2].args[1],"first-context");
  assert.deepEqual(input,{participant_name:"synthetic"});
});

test("requerying bootstrap in the old document cannot launder its epoch after a transition",async()=>{
  const {api,calls}=loadPreload([success("old-context"),success("new-context")]);
  await api.getBootstrap();const refreshed=await api.getBootstrap();await api.saveRecord({});
  assert.equal(refreshed.data.runtimeContextEpoch,"old-context");
  assert.equal(calls.at(-1)?.args[1],"old-context");
});

test("a failed bootstrap does not prevent the first later successful context capture",async()=>{
  const {api,calls}=loadPreload([{ok:false,error:"startup-not-ready"},success("ready-context")]);
  await api.getBootstrap();await api.getBootstrap();await api.saveRecord({});
  assert.equal(calls.at(-1)?.args[1],"ready-context");
});

test("a document whose first successful bootstrap is legacy cannot later adopt a production epoch",async()=>{
  const {api,calls}=loadPreload([success(),success("later-production")]);
  await api.getBootstrap();const second=await api.getBootstrap();await api.saveRecord({});
  assert.equal(second.data.runtimeContextEpoch,undefined);assert.equal(calls.at(-1)?.args[1],undefined);
});
