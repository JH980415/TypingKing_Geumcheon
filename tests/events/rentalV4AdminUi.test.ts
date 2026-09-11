import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {OneDriveSettingsPanel} from "../../apps/shell/src/OneDriveSettingsPanel";
import {parseDeploymentProfile} from "../../electron/deploymentProfile";
import {profileFixture} from "./rentalV4Fixture";
test("v4 player profile admin reader exposes recovery and registered-session controls",()=>{const p=parseDeploymentProfile(profileFixture());const html=renderToStaticMarkup(createElement(OneDriveSettingsPanel,{role:"leaderboard",eventProfileId:"geumcheon-2026",deviceProfile:p.device,sessionKind:"official"}));for(const label of ["관리자 프로필 선택","일차 직접 입력","회차 직접 입력","현재 회차 적용","마지막 저장 성공","마지막 조회 성공"])assert.ok(html.includes(label),label);assert.ok(html.includes("행사 전용 장치 프로필 적용"));});

test("v4 provisioned verifier starts fresh without local password and never authenticates blank", async()=>{
 const {AdminAccessSessions}=await import("../../electron/adminAccessSession"); const {scryptSync}=await import("node:crypto"); const salt="a".repeat(32);const verifier={algorithm:"scrypt" as const,salt,hash:scryptSync("synthetic-strong-admin",Buffer.from(salt,"hex"),64).toString("hex")};
 const sessions=new AdminAccessSessions({password:"CHANGE_ME_BEFORE_EVENT",verifier,ttlMs:60000});const sender={id:14,once:()=>{}};
 assert.equal(sessions.authenticate(sender,"synthetic-strong-admin").ok,true);assert.equal(sessions.authenticate(sender,"").ok,false);
});
