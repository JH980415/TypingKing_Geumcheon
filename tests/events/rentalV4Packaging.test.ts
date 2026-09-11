import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeZip } from '../../scripts/r7-package-release';
import { validateCommonEntries, verifyZipAgainstManifest, buildArtifactManifest, verifyBuildArtifacts } from '../../scripts/rental-v4-package-release';

test('common package rejects profile, operating config, server tools and duplicate or unsafe names',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'rental-v4-public-'));
  const file=path.join(base,'public.bin');fs.writeFileSync(file,'public-resource');
  try {
    for(const name of ['player_01.device-profile.json','server/config.json','scripts/issuer.ts','tokens.json','../outside','assets/../secret','ASSETS/ai_challenge/x.png']) {
      assert.throws(()=>validateCommonEntries([{name,source:file}]),/COMMON_|ZIP_/);
    }
    assert.throws(()=>validateCommonEntries([{name:'G-Science AI 타자왕.exe',source:file},{name:'G-Science AI 타자왕.exe',source:file}]),/DUPLICATE/);
  } finally {fs.rmSync(base,{recursive:true,force:true});}
});
test('ZIP verifier independently checks entries, sha256, CRC, missing/unexpected entries and corrupted bytes',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'rental-v4-zip-'));
  try{
    const a=path.join(base,'a.txt'); fs.writeFileSync(a,'synthetic archive evidence '.repeat(100));
    const zip=path.join(base,'archive.zip');
    const expected=await writeZip(zip,[{name:'한글/a.txt',source:a}]);
    const proof=await verifyZipAgainstManifest(zip,expected);
    assert.equal(proof.entries,1);assert.equal(proof.crc,'PASS');assert.equal(proof.sha256,'PASS');
    await assert.rejects(()=>verifyZipAgainstManifest(zip,[{...expected[0],sha256:'0'.repeat(64)}]),/HASH/);
    await assert.rejects(()=>verifyZipAgainstManifest(zip,[]),/ENTRY_COUNT/);
    const data=fs.readFileSync(zip);
    const localNameLength=data.readUInt16LE(26),extra=data.readUInt16LE(28);
    data[30+localNameLength+extra+2]^=0x7f;
    fs.writeFileSync(zip,data);
    await assert.rejects(()=>verifyZipAgainstManifest(zip,expected),/CRC|ZIP|HASH|invalid|distance|block|code|stored|data/i);
  }finally{fs.rmSync(base,{recursive:true,force:true});}
});

test('ZIP verifier rejects forged local CRC and sizes even when central hashes remain valid',async()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'rental-v4-local-header-'));
  try{
    const source=path.join(base,'a.txt');fs.writeFileSync(source,'synthetic '.repeat(40));
    const zip=path.join(base,'archive.zip'),manifest=await writeZip(zip,[{name:'a.txt',source}]);
    const original=fs.readFileSync(zip);
    assert.equal(original.readUInt16LE(6)&8,0,'writer uses seekable output without descriptor');
    for(const offset of [14,18,22]){
      const damaged=Buffer.from(original);damaged.writeUInt32LE((damaged.readUInt32LE(offset)+1)>>>0,offset);fs.writeFileSync(zip,damaged);
      await assert.rejects(()=>verifyZipAgainstManifest(zip,manifest),/ZIP_LOCAL_/);
    }
  }finally{fs.rmSync(base,{recursive:true,force:true});}
});
test('build provenance binds both executable bytes and detects a same-size replacement',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'rental-v4-build-evidence-'));
  try{
    for(const [variant,name] of [['ai','G-Science AI 타자왕.exe'],['ai-leaderboard','G-Science AI 타자왕 리더보드.exe']]){
      const dir=path.join(base,'geumcheon',variant!);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name!),'synthetic EXE bytes');
    }
    const manifest=buildArtifactManifest(base);
    verifyBuildArtifacts(base,manifest);
    fs.writeFileSync(path.join(base,'geumcheon','ai','G-Science AI 타자왕.exe'),'synthetic BAD bytes');
    assert.throws(()=>verifyBuildArtifacts(base,manifest),/BUILD_ARTIFACT_MISMATCH/);
  }finally{fs.rmSync(base,{recursive:true,force:true});}
});
