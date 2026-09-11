import assert from "node:assert/strict";
import test from "node:test";
import { parseDeploymentProfile, originalProfileFileName } from "../../electron/deploymentProfile";
import {profileFixture} from "./rentalV4Fixture";
test("v4 keeps original profile names",()=>assert.equal(originalProfileFileName("PC01"),"player_01.device-profile.json"));
test("v4 accepts per-device writer and reader while preserving physical role",()=>{const p=parseDeploymentProfile(profileFixture());assert.equal(p.device.role,"player");assert.equal(p.credentials.leaderboard.role,"leaderboard");});
test("v4 rejects mismatched scope, credentials, originals and periods",()=>{for(const mutate of [(p:any)=>p.credentials.leaderboard.deviceId="PC02",(p:any)=>p.credentials.writer.token=p.credentials.leaderboard.token,(p:any)=>p.credentials.operator=p.credentials.writer,(p:any)=>p.allowedSessions=[],(p:any)=>p.notBefore="2098-01-01T00:00:00.000Z"]){const p=profileFixture();mutate(p);assert.throws(()=>parseDeploymentProfile(p));}assert.throws(()=>parseDeploymentProfile(profileFixture(),{fileName:"device-profile.json"}));});
test("v4 issuance permits future activation but runtime does not",()=>{const p=profileFixture();p.notBefore="2098-01-01T00:00:00.000Z";assert.doesNotThrow(()=>parseDeploymentProfile(p,{allowInactive:true}));});

test("v4 rejects nonprimitive environment and unregistered practice",()=>{const p:any=profileFixture();p.environment=["test"];assert.throws(()=>parseDeploymentProfile(p));const q:any=profileFixture();q.device.sessions.practice={sessionId:"unapproved-practice"};assert.throws(()=>parseDeploymentProfile(q));});
