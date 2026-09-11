import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DeploymentProfileStore, parseDeploymentProfile } from "../../electron/deploymentProfile";
import { profileFixture } from "./rentalV4Fixture";
const storage={isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from(s),decryptString:(b:Buffer)=>b.toString()};
test("v4 administrator explicit replacement recovers corrupt cache; automatic import preserves it",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"v4-profile-store-"));try{const p=path.join(dir,"profile.bin");fs.writeFileSync(p,"broken");const store=new DeploymentProfileStore(p,storage);assert.throws(()=>store.activate(parseDeploymentProfile(profileFixture())));assert.equal(fs.readFileSync(p,"utf8"),"broken");assert.doesNotThrow(()=>store.activate(parseDeploymentProfile(profileFixture()),true));}finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test("v4 rejects ambiguous times, nonexistent dates and invalid current time",()=>{
 for(const time of ["2026-09-01T00:00:00","2026-02-30T00:00:00.000Z"]){const p=profileFixture();p.notBefore=time;assert.throws(()=>parseDeploymentProfile(p));}
 assert.throws(()=>parseDeploymentProfile(profileFixture(),{now:new Date(NaN)}));
});
