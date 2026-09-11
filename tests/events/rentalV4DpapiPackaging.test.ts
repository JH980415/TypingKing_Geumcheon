import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import * as packaging from '../../scripts/rental-v4-package-release';

const compile=(root:string,out:string)=>(packaging as any).compileRentalProtectionBridge(root,out);
const verify=(root:string,resources:string,manifest:any)=>(packaging as any).verifyPackagedProtectionBridge(root,resources,manifest);
const sourceName='electron/security/TypingKingDpapiBridge.cs';
const bridgeName='security/TypingKingDpapiBridge.exe';
function fixture(response='TKDPAPI_OK_V1'){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'rental-dpapi-packaging-'));
  const root=path.join(base,'source'),support=path.join(base,'support'),resources=path.join(base,'resources');
  fs.mkdirSync(path.join(root,'electron','security'),{recursive:true});
  // Packaging-only fixture: verifies compiler/path/hash/probe wiring, not DPAPI.
  fs.writeFileSync(path.join(root,sourceName),
    'using System; public static class Bridge { public static int Main(string[] args) { if(args.Length == 1 && args[0] == "probe") { Console.Write("'+response+'"); return 0; } return 2; } }');
  return {base,root,support,resources};
}
test('both official EXEs explicitly contain the fixed protection helper resource',()=>{
  const yaml=createRequire(import.meta.url)('js-yaml');
  for(const variant of ['ai','ai-leaderboard']){
    const config=yaml.load(fs.readFileSync(path.resolve('electron-builder.geumcheon-'+variant+'.yml'),'utf8'));
    assert.ok(config.extraResources.some((r:any)=>r.from==='release-build/rental-v4/support/security/TypingKingDpapiBridge.exe'
      &&r.to===bridgeName));
  }
});
test('existing Windows compiler produces a hash-bound helper and exact packaged probe',()=>{
  const f=fixture();
  try{
    const result=compile(f.root,f.support);
    assert.equal(result.source.name,sourceName);
    assert.match(result.source.sha256,/^[a-f0-9]{64}$/);
    assert.match(result.compiler.path,/Microsoft\.NET[\\/]Framework(?:64)?[\\/]v4\.0\.30319[\\/]csc\.exe$/);
    assert.match(result.compiler.sha256,/^[a-f0-9]{64}$/);
    assert.equal(result.artifact.name,bridgeName);
    assert.ok(result.artifact.bytes>0);
    fs.mkdirSync(path.join(f.resources,'security'),{recursive:true});
    fs.copyFileSync(path.join(f.support,bridgeName),path.join(f.resources,bridgeName));
    const proof=verify(f.root,f.resources,result);
    assert.equal(proof.probe,'PASS');
    assert.equal(proof.sha256,result.artifact.sha256);
    assert.throws(()=>compile(f.root,f.support),/OUTPUT_EXISTS/);
  }finally{fs.rmSync(f.base,{recursive:true,force:true});}
});
test('helper gate refuses missing, swapped, linked and stale-source resources before acceptance',()=>{
  const f=fixture();
  try{
    const result=compile(f.root,f.support),built=path.join(f.support,bridgeName),packaged=path.join(f.resources,bridgeName);
    fs.mkdirSync(path.dirname(packaged),{recursive:true});
    assert.throws(()=>verify(f.root,f.resources,result),/PROTECTION_BRIDGE_MISSING/);
    fs.copyFileSync(built,packaged);
    const changed=fs.readFileSync(packaged);changed[changed.length-1]^=1;fs.writeFileSync(packaged,changed);
    assert.throws(()=>verify(f.root,f.resources,result),/PROTECTION_BRIDGE_HASH_MISMATCH/);
    fs.unlinkSync(packaged);fs.symlinkSync(f.support,path.join(f.resources,'linked'),'junction');
    assert.throws(()=>verify(f.root,path.join(f.resources,'linked'),result),/PROTECTION_BRIDGE_LINK/);
    fs.copyFileSync(built,packaged);
    fs.appendFileSync(path.join(f.root,sourceName),'\n// modified after helper build');
    assert.throws(()=>verify(f.root,f.resources,result),/PROTECTION_BRIDGE_SOURCE_CHANGED/);
  }finally{fs.rmSync(f.base,{recursive:true,force:true});}
});
test('a helper that starts but fails the exact capability response is rejected',()=>{
  const f=fixture('WRONG_PROTOCOL');
  try{assert.throws(()=>compile(f.root,f.support),/PROTECTION_BRIDGE_PROBE_FAILED/);}
  finally{fs.rmSync(f.base,{recursive:true,force:true});}
});
