import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {payloadSha256} from "../../shared/nas/protocol";
import {EncryptedNasOutbox} from "../../electron/nas/outbox";
import {createGeumcheonNasRuntime} from "../../electron/nas/runtime";
import {DeploymentProfileStore,assertSafeDeploymentApplication,parseDeploymentProfile,replaceDeploymentSelection,withDeploymentLocks} from "../../electron/deploymentProfile";
import {profileFixture} from "./rentalV4Fixture";
const storage={isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from("protected:"+s),decryptString:(b:Buffer)=>{const s=b.toString();if(!s.startsWith("protected:"))throw new Error("BAD_CIPHER");return s.slice(10);}};
async function fixture(context:any) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"typingking-v4-renewal-"));context.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const current=profileFixture();current.issuedAt="2026-01-01T00:00:00.000Z";current.notBefore=current.issuedAt;current.expiresAt="2026-02-01T00:00:00.000Z";
 const old={...current,expiresAt:"2099-01-01T00:00:00.000Z"},next=parseDeploymentProfile({...old,deploymentId:"renewed",credentials:{...old.credentials,writer:{...old.credentials.writer,token:"c".repeat(64)},leaderboard:{...old.credentials.leaderboard,token:"d".repeat(64)}}});
 const storePath=path.join(root,"nas","deployment-profile.bin");fs.mkdirSync(path.dirname(storePath),{recursive:true});fs.writeFileSync(storePath,storage.encryptString(JSON.stringify(current)));
 const outbox=new EncryptedNasOutbox({rootDir:path.join(root,"nas","outbox"),safeStorage:storage});
 const recordId="gsc26-pc01-123e4567-e89b-42d3-a456-426614174000";
 const envelope:any={schema_version:1,event_id:next.device.eventId,session:{kind:"official",session_id:"day1-round1",day_no:1,round_no:1},row:{record_id:recordId,participant_name:"합성갱신",game_mode:"ai_challenge"}};
 await outbox.enqueue("official",envelope);
 return {root,current,next,storePath,outbox,envelope,recordId,outboxPath:path.join(root,"nas","outbox","official","pending",recordId+".bin")};
}
test("expired profile pending record permits same-binding authentication renewal without altering bytes or original session",async context=>{
 const f=await fixture(context);assert.throws(()=>parseDeploymentProfile(f.current),/PROFILE_EXPIRED/);assert.throws(()=>parseDeploymentProfile(f.current,{recoveryInspection:true} as any),/PROFILE_EXPIRED/);const before=fs.readFileSync(f.outboxPath);
 await withDeploymentLocks([f.root],async()=>{
  assert.equal(await assertSafeDeploymentApplication({currentRuntimeRoot:f.root,targetRuntimeRoot:f.root,replacement:f.next,safeStorage:storage}),"credential-renewal");
  const dir=path.join(f.root,"client");fs.mkdirSync(dir);const profilePath=path.join(dir,"player_01.device-profile.json");fs.writeFileSync(profilePath,JSON.stringify(f.next));
  replaceDeploymentSelection(f.storePath,path.join(f.root,"selected.bin"),dir,f.next,profilePath,storage);
 });
 assert.deepEqual(fs.readFileSync(f.outboxPath),before);
 const store=new DeploymentProfileStore(f.storePath,storage);store.activate(f.next);let sent:any;
 const runtime=createGeumcheonNasRuntime({event:{profileId:"geumcheon-2026",nasEventId:f.next.device.eventId} as any,device:f.next.device,executionRole:"player",sessionKind:"official",runtimeRoot:f.root,safeStorage:storage,credentials:{getToken:role=>store.token(role),assertCurrent:()=>store.assertCurrent()},fetch:async(_url,init)=>{assert.equal(new Headers(init?.headers).get("authorization"),"Bearer "+"c".repeat(64));sent=JSON.parse(String(init?.body));const hash=payloadSha256(sent);return new Response(JSON.stringify({schema_version:1,disposition:"stored",record_id:f.recordId,payload_sha256:hash,stored_sha256:hash,received_at:"2026-09-12T00:00:00.000Z"}),{status:201,headers:{"content-type":"application/json"}});},local:{persist:async()=>{throw new Error("NO_REWRITE");},read:async()=>[],admin:{edit:async()=>{},hide:async()=>{},resetSession:async()=>{}}},sleep:async()=>{}});
 assert.equal((await runtime.flush()).sent,1);assert.deepEqual(sent,f.envelope);assert.equal(sent.session.session_id,"day1-round1");assert.equal(sent.row.record_id,f.recordId);
});
test("pending renewal rejects changed device, API, role, default session and registered session scope",async context=>{
 const f=await fixture(context),before=fs.readFileSync(f.outboxPath);
 for(const mutate of [
  (p:any)=>{p.device.deviceId="PC02";p.credentials.writer.deviceId="PC02";p.credentials.leaderboard.deviceId="PC02";},
  (p:any)=>{p.device.apiBaseUrl="https://typingking.thepmd.synology.me";p.credentials.writer.apiBaseUrl=p.device.apiBaseUrl;p.credentials.leaderboard.apiBaseUrl=p.device.apiBaseUrl;},
  (p:any)=>{p.device.deviceId="LEADERBOARD01";p.device.role="leaderboard";delete p.credentials.writer;p.credentials.leaderboard.deviceId="LEADERBOARD01";},
  (p:any)=>{p.device.sessions.official={sessionId:"round2",dayNo:1,roundNo:2};p.allowedSessions.push(p.device.sessions.official);},
  (p:any)=>p.allowedSessions.push({sessionId:"round2",dayNo:1,roundNo:2})
 ]){
  const next=structuredClone(f.next);mutate(next);assert.doesNotThrow(()=>parseDeploymentProfile(next));await assert.rejects(()=>assertSafeDeploymentApplication({currentRuntimeRoot:f.root,targetRuntimeRoot:f.root,replacement:next,safeStorage:storage}),/PROFILE_PENDING_SCOPE_CHANGE/);assert.deepEqual(fs.readFileSync(f.outboxPath),before);
 }
});
test("pending renewal still refuses active attempt and unregistered original outbox session",async context=>{
 const f=await fixture(context);const active=path.join(f.root,"nas","active-attempt-official.bin");fs.writeFileSync(active,"active");await assert.rejects(()=>assertSafeDeploymentApplication({currentRuntimeRoot:f.root,targetRuntimeRoot:f.root,replacement:f.next,safeStorage:storage}),/PROFILE_BUSY_RECORDS/);fs.unlinkSync(active);
 const unsafe={...f.envelope,session:{kind:"official",session_id:"other-round",day_no:2,round_no:1}};fs.writeFileSync(f.outboxPath,storage.encryptString(JSON.stringify(unsafe)));
 await assert.rejects(()=>assertSafeDeploymentApplication({currentRuntimeRoot:f.root,targetRuntimeRoot:f.root,replacement:f.next,safeStorage:storage}),/PROFILE_PENDING_SCOPE_CHANGE/);
});
