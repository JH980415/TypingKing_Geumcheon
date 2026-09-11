import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DeploymentProfileStore, parseDeploymentProfile, readDeploymentSelection, saveDeploymentSelection } from "../../electron/deploymentProfile";
import { profileFixture } from "./rentalV4Fixture";

const windows = process.platform === "win32";
const compiler = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const source = path.resolve("electron/security/TypingKingDpapiBridge.cs");
const MAGIC = Buffer.from([84,75,68,80,65,80,73,1]);
let resources: string | undefined;
async function api() {
  const module = await import("../../electron/security/windowsDpapiStorage").catch(() => null);
  assert.ok(module, "the shared CurrentUser DPAPI adapter must exist");
  return module;
}
function compileBridge(root: string, codePath = source): string {
  assert.ok(fs.existsSync(codePath), "the native shared DPAPI source must exist");
  assert.ok(fs.existsSync(compiler), "existing Windows .NET compiler must be present");
  const destination = path.join(root,"security","TypingKingDpapiBridge.exe");
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  const run=spawnSync(compiler,["/nologo","/optimize+","/target:exe","/platform:anycpu","/out:"+destination,codePath],{encoding:"utf8",windowsHide:true,shell:false,timeout:30000});
  assert.equal(run.status,0,run.stdout+run.stderr);
  return destination;
}
function sharedResources(): string {
  if(!resources){resources=fs.mkdtempSync(path.join(os.tmpdir(),"typingking-dpapi-test-"));compileBridge(resources);}
  return resources;
}
test.after(()=>{if(resources)fs.rmSync(resources,{recursive:true,force:true});});
function workspace(context: any): string {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"typingking-dpapi-state-"));
  context.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}
test("official V2 selects the shared provider while legacy and review retain their provider",{skip:!windows},async()=>{
  const {selectDeploymentStorage}=await api();
  const legacy={isEncryptionAvailable:()=>true,encryptString:()=>Buffer.from("legacy"),decryptString:()=>"legacy"};
  const options={resourcesPath:sharedResources(),legacy,eventProfileId:"geumcheon-2026",deploymentProfileVersion:2,hasReviewContext:false};
  assert.notEqual(selectDeploymentStorage(options),legacy);
  assert.equal(selectDeploymentStorage({...options,deploymentProfileVersion:undefined}),legacy);
  assert.equal(selectDeploymentStorage({...options,hasReviewContext:true}),legacy);
  assert.equal(selectDeploymentStorage({...options,eventProfileId:"skillup-2026"}),legacy);
});
test("independent Windows adapters share CurrentUser ciphertext and strict Korean UTF8",{skip:!windows},async()=>{
  const {createWindowsDpapiStorage}=await api(),a=createWindowsDpapiStorage(sharedResources()),b=createWindowsDpapiStorage(sharedResources());
  const value=JSON.stringify({recordId:"PC01-original-01",session:"day1-round1",name:"금나래",text:"😀 한글\u0000"});
  assert.equal(a.isEncryptionAvailable(),true);assert.equal(b.isEncryptionAvailable(),true);
  const cipher=a.encryptString(value);
  assert.deepEqual(cipher.subarray(0,MAGIC.length),MAGIC);
  assert.equal(cipher.includes(Buffer.from(value)),false);
  assert.equal(b.decryptString(cipher),value);
  assert.notDeepEqual(a.encryptString(value),cipher);
  assert.throws(()=>a.encryptString("\ud800"),/DPAPI_STORAGE_FAILED/);
  assert.throws(()=>a.encryptString("가".repeat(Math.floor(8*1024*1024/3)+1)),/DPAPI_STORAGE_FAILED/);
});
test("both providers read the same protected deployment and installation selection",{skip:!windows},async context=>{
  const {createWindowsDpapiStorage}=await api(),a=createWindowsDpapiStorage(sharedResources()),b=createWindowsDpapiStorage(sharedResources()),root=workspace(context);
  const raw=profileFixture(),profile=parseDeploymentProfile(raw),sourceFile=path.join(root,"player_01.device-profile.json"),file=path.join(root,"nas","deployment-profile.bin"),selection=path.join(root,"launch","selected-profile.bin");
  fs.writeFileSync(sourceFile,JSON.stringify(raw));
  const first=new DeploymentProfileStore(file,a);first.activate(profile);
  saveDeploymentSelection(selection,root,profile,sourceFile,a);
  const second=new DeploymentProfileStore(file,b);second.activate(profile);
  assert.equal(second.token("writer"),profile.credentials.writer!.token);
  assert.equal(readDeploymentSelection(selection,root,b)!.profile.device.deviceId,"PC01");
});
test("preflight rejects legacy, unknown and tampered shared files without writes or queue reclassification",{skip:!windows},async context=>{
  const {createWindowsDpapiStorage,assertSharedWindowsDpapiStateReadable}=await api(),storage=createWindowsDpapiStorage(sharedResources()),root=workspace(context),runtimeRoot=path.join(root,"PC01"),installationRoot=path.join(root,"launch");
  const files=[path.join(runtimeRoot,"nas","deployment-profile.bin"),path.join(runtimeRoot,"nas","device-token.bin"),path.join(runtimeRoot,"nas","leaderboard-token.bin"),path.join(runtimeRoot,"nas","active-attempt-official.bin"),path.join(runtimeRoot,"nas","outbox","official","pending","PC01-original-01.bin"),path.join(runtimeRoot,"nas","outbox","official","blocked","PC01-original-02.bin"),path.join(installationRoot,"selected-profile.bin"),path.join(installationRoot,"administrator-recovery.bin")];
  const valid=storage.encryptString(JSON.stringify({recordId:"PC01-original-01",sessionId:"day1-round1"}));
  for(const file of files){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,valid);}
  assert.doesNotThrow(()=>assertSharedWindowsDpapiStateReadable({runtimeRoot,installationRoot,storage}));
  for(const bad of [Buffer.from("v10old-owner-data"),Buffer.from("v11old-owner-data"),Buffer.from("unknown-owner-data"),Buffer.from(valid)]){
    if(bad.subarray(0,8).equals(MAGIC))bad[bad.length-1]^=1;
    for(const file of files){fs.writeFileSync(file,bad);const before=files.map(f=>fs.readFileSync(f).toString("hex"));
      assert.throws(()=>assertSharedWindowsDpapiStateReadable({runtimeRoot,installationRoot,storage}),/DPAPI_(LEGACY_STORAGE_UNSUPPORTED|STORAGE_FAILED)/);
      assert.deepEqual(files.map(f=>fs.readFileSync(f).toString("hex")),before);
      assert.deepEqual(fs.readdirSync(path.join(runtimeRoot,"nas","outbox","official","pending")),["PC01-original-01.bin"]);
      fs.writeFileSync(file,valid);
    }
  }
});
test("old deployment activation preserves original ciphertext and leaves no temporary file",{skip:!windows},async context=>{
  const {createWindowsDpapiStorage}=await api(),storage=createWindowsDpapiStorage(sharedResources()),root=workspace(context),file=path.join(root,"deployment-profile.bin"),old=Buffer.from("v10-unreadable-original");
  fs.writeFileSync(file,old);
  assert.throws(()=>new DeploymentProfileStore(file,storage).activate(parseDeploymentProfile(profileFixture())));
  assert.deepEqual(fs.readFileSync(file),old);assert.deepEqual(fs.readdirSync(root),["deployment-profile.bin"]);
});
test("preflight refuses a junction without traversing or modifying another PC",{skip:!windows},async context=>{
  const {createWindowsDpapiStorage,assertSharedWindowsDpapiStateReadable}=await api(),storage=createWindowsDpapiStorage(sharedResources()),root=workspace(context),runtimeRoot=path.join(root,"PC01"),other=path.join(root,"PC02"),installationRoot=path.join(root,"launch");
  fs.mkdirSync(runtimeRoot);fs.mkdirSync(other);const sentinel=path.join(other,"deployment-profile.bin");fs.writeFileSync(sentinel,"untouched");
  fs.symlinkSync(other,path.join(runtimeRoot,"nas"),"junction");
  assert.throws(()=>assertSharedWindowsDpapiStateReadable({runtimeRoot,installationRoot,storage}),/DPAPI_STORAGE_FAILED/);
  assert.equal(fs.readFileSync(sentinel,"utf8"),"untouched");
});
test("native helper rejects invalid UTF8, unknown format and oversized input with fixed errors",{skip:!windows},async()=>{
  const helper=path.join(sharedResources(),"security","TypingKingDpapiBridge.exe");
  for(const [operation,input] of [["protect",Buffer.from([0xc3,0x28])],["unprotect",Buffer.from("v10-secret-canary")],["protect",Buffer.alloc(8*1024*1024+1,65)],["wrong",Buffer.from("secret-canary")]] as const){
    const result=spawnSync(helper,[operation],{input,windowsHide:true,shell:false,timeout:10000,maxBuffer:9*1024*1024});
    assert.notEqual(result.status,0);assert.equal(result.stdout.length,0);assert.equal(result.stderr.toString("utf8").trim(),"DPAPI_BRIDGE_FAILED");
  }
});
test("missing, relative, bad-output and timeout helpers fail without exposing helper output",{skip:!windows},async context=>{
  const {createWindowsDpapiStorage}=await api(),root=workspace(context);
  assert.throws(()=>createWindowsDpapiStorage("relative/path"),/DPAPI_STORAGE_FAILED/);
  const missing=createWindowsDpapiStorage(root);assert.equal(missing.isEncryptionAvailable(),false);assert.throws(()=>missing.encryptString("secret-canary"),/DPAPI_STORAGE_FAILED/);
  for(const [name,body] of [["bad","System.Console.Write(\"secret-canary\");"],["timeout","System.Threading.Thread.Sleep(7000);"]] as const){
    const folder=path.join(root,name),fixture=path.join(root,name+".cs");fs.writeFileSync(fixture,"class Fixture { static void Main(){"+body+"} }");compileBridge(folder,fixture);
    const storage=createWindowsDpapiStorage(folder);assert.equal(storage.isEncryptionAvailable(),false);assert.throws(()=>storage.encryptString("secret-canary"),error=>error instanceof Error&&error.message==="DPAPI_STORAGE_FAILED");
  }
});
