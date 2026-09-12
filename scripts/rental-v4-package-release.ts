/** Secret-free, official-only rental v4 client packaging; no server or issuer in client ZIP. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInflateRaw } from 'node:zlib';
import { publicResources, writeZip } from './r7-package-release';

export const RENTAL_V4_CANDIDATE='Rental-v4-20260912';
export const COMMON_ZIP_NAME='UIV3_OFFICIAL_NAS_CLIENT_RELEASE.zip';
const MARKER='.typingking-geumcheon-client-release.json';
const EXES=['G-Science AI 타자왕.exe','G-Science AI 타자왕 리더보드.exe'] as const;
type Entry={name:string;source:string};
type ManifestEntry={name:string;bytes:number;sha256:string};
const sha=(data:Buffer|string)=>crypto.createHash('sha256').update(data).digest('hex');
function safeEntryName(name:string){
  if(!name||/[\\:\x00-\x1f]/.test(name)||name.startsWith('/')||name.split('/').some(p=>!p||p==='..'||p==='.')||
    name.normalize('NFC')!==name)throw new Error('ZIP_NAME_UNSAFE');
}
export function validateCommonEntries(entries:Entry[]){
  const names=new Set<string>();
  for(const e of entries){
    safeEntryName(e.name);
    const key=e.name.toLowerCase();
    if(names.has(key))throw new Error('COMMON_DUPLICATE_ENTRY');names.add(key);
    if(!EXES.includes(e.name as typeof EXES[number])&&e.name!==MARKER&&
      !/^(assets\/ai_challenge\/[^/]+\.png|events\/geumcheon-2026\/(event\.config\.json|stage_texts\.csv|assets\/(?:ai_challenge\/)?[^/]+\.png))$/.test(e.name))throw new Error('COMMON_ENTRY_FORBIDDEN');
    if(/device-profile|token-manifest|credential|private[-_.]?key|operator|server|\.pem$/i.test(e.name))throw new Error('COMMON_SECRET_FILE_FORBIDDEN');
  }
  for(const required of [...EXES,MARKER,'events/geumcheon-2026/event.config.json','events/geumcheon-2026/stage_texts.csv']){
    if(!names.has(required.toLowerCase()))throw new Error('COMMON_REQUIRED_FILE_MISSING');
  }
  return entries;
}
const crcTable=Uint32Array.from({length:256},(_,n)=>{
  let c=n;for(let j=0;j<8;j++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;
});
function updateCrc(crc:number,bytes:Buffer){
  for(let i=0;i<bytes.length;i++)crc=crcTable[(crc^bytes[i]!)&0xff]!^(crc>>>8);
  return crc>>>0;
}
async function hashFile(file:string){
  const digest=crypto.createHash('sha256');
  for await(const chunk of fs.createReadStream(file))digest.update(chunk);
  return digest.digest('hex');
}
/** Independent ZIP read-back: central/local names, count, paths, duplicates, sizes, CRC and SHA. */
export async function verifyZipAgainstManifest(zipPath:string,expected:ManifestEntry[]){
  const zip=fs.openSync(zipPath,'r');
  const size=fs.fstatSync(zip).size;
  let entries:Array<{name:string;flags:number;compression:number;crc:number;compressed:number;bytes:number;offset:number}>=[];
  try{
    const tailSize=Math.min(size,65557),tail=Buffer.alloc(tailSize);
    fs.readSync(zip,tail,0,tailSize,size-tailSize);
    let end=-1;
    for(let i=tail.length-22;i>=0;i--){
      if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
    }
    if(end<0)throw new Error('ZIP_END_INVALID');
    const count=tail.readUInt16LE(end+10),centralSize=tail.readUInt32LE(end+12),centralOffset=tail.readUInt32LE(end+16);
    if(tail.readUInt16LE(end+4)!==0||tail.readUInt16LE(end+6)!==0||tail.readUInt16LE(end+8)!==count||
      count===0xffff||centralSize===0xffffffff||centralOffset===0xffffffff||centralOffset+centralSize!==size-tailSize+end)throw new Error('ZIP_LAYOUT_INVALID');
    if(count!==expected.length)throw new Error('ZIP_ENTRY_COUNT_MISMATCH');
    const central=Buffer.alloc(centralSize);fs.readSync(zip,central,0,centralSize,centralOffset);
    const names=new Set<string>();let pos=0;
    for(let i=0;i<count;i++){
      if(pos+46>central.length||central.readUInt32LE(pos)!==0x02014b50)throw new Error('ZIP_CENTRAL_INVALID');
      const flags=central.readUInt16LE(pos+8),compression=central.readUInt16LE(pos+10),crc=central.readUInt32LE(pos+16);
      const compressed=central.readUInt32LE(pos+20),bytes=central.readUInt32LE(pos+24),nameLength=central.readUInt16LE(pos+28),
        extraLength=central.readUInt16LE(pos+30),commentLength=central.readUInt16LE(pos+32),offset=central.readUInt32LE(pos+42);
      if(pos+46+nameLength+extraLength+commentLength>central.length||(flags & ~0x800)!==0||![0,8].includes(compression)||
        [compressed,bytes,offset].includes(0xffffffff))throw new Error('ZIP_UNSUPPORTED_ENTRY');
      const name=central.subarray(pos+46,pos+46+nameLength).toString('utf8');
      safeEntryName(name);
      if(names.has(name.toLowerCase()))throw new Error('ZIP_DUPLICATE_ENTRY');names.add(name.toLowerCase());
      const expectedEntry=expected.find(e=>e.name===name);
      if(!expectedEntry||expectedEntry.bytes!==bytes)throw new Error('ZIP_ENTRY_MISMATCH');
      const header=Buffer.alloc(30);fs.readSync(zip,header,0,30,offset);
      if(header.readUInt32LE(0)!==0x04034b50||header.readUInt16LE(6)!==flags||header.readUInt16LE(8)!==compression)throw new Error('ZIP_LOCAL_INVALID');
      if(header.readUInt32LE(14)!==crc||header.readUInt32LE(18)!==compressed||header.readUInt32LE(22)!==bytes)throw new Error('ZIP_LOCAL_SIZE_OR_CRC_MISMATCH');
      const localName=Buffer.alloc(header.readUInt16LE(26));fs.readSync(zip,localName,0,localName.length,offset+30);
      if(localName.toString('utf8')!==name)throw new Error('ZIP_LOCAL_NAME_MISMATCH');
      const dataOffset=offset+30+localName.length+header.readUInt16LE(28);
      if(dataOffset+compressed>centralOffset)throw new Error('ZIP_ENTRY_BOUNDS');
      entries.push({name,flags,compression,crc,compressed,bytes,offset:dataOffset});
      pos+=46+nameLength+extraLength+commentLength;
    }
    if(pos!==central.length)throw new Error('ZIP_CENTRAL_SIZE');
  }finally{fs.closeSync(zip);}
  for(const entry of entries){
    const digest=crypto.createHash('sha256');let crc=0xffffffff,bytes=0;
    if(entry.compressed){
      const fileStream=fs.createReadStream(zipPath,{start:entry.offset,end:entry.offset+entry.compressed-1});
      const stream=entry.compression===8?fileStream.pipe(createInflateRaw()):fileStream;
      for await(const part of stream){
        const chunk=Buffer.isBuffer(part)?part:Buffer.from(part);
        bytes+=chunk.length;if(bytes>entry.bytes)throw new Error('ZIP_EXPANDED_SIZE');
        crc=updateCrc(crc,chunk);digest.update(chunk);
      }
    }
    if(bytes!==entry.bytes||(crc^0xffffffff)>>>0!==entry.crc)throw new Error('ZIP_CRC_MISMATCH');
    if(digest.digest('hex')!==expected.find(e=>e.name===entry.name)!.sha256)throw new Error('ZIP_SHA256_HASH_MISMATCH');
  }
  return {entries:entries.length,paths:'PASS',duplicates:'PASS',crc:'PASS',sha256:'PASS'};
}
function executableLocations(buildRoot:string){
  return EXES.map((name,index)=>({name:'geumcheon/'+(index?'ai-leaderboard':'ai')+'/'+name,
    source:path.join(buildRoot,'geumcheon',index?'ai-leaderboard':'ai',name)}));
}
export function buildArtifactManifest(buildRoot:string):ManifestEntry[]{
  return executableLocations(buildRoot).map(({name,source})=>{
    for(let current=path.resolve(source);;current=path.dirname(current)){
      if(fs.lstatSync(current).isSymbolicLink())throw new Error('BUILD_ARTIFACT_LINK_UNSAFE');
      if(current===path.dirname(current))break;
    }
    const stat=fs.statSync(source);
    if(!stat.isFile()||!stat.size)throw new Error('BUILD_ARTIFACT_MISSING');
    return {name,bytes:stat.size,sha256:sha(fs.readFileSync(source))};
  });
}
export function verifyBuildArtifacts(buildRoot:string,expected:ManifestEntry[]):void{
  const actual=buildArtifactManifest(buildRoot);
  if(!Array.isArray(expected)||JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('BUILD_ARTIFACT_MISMATCH');
}

function command(root:string,program:string,args:string[]){
  const r=spawnSync(program,args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
  if(r.status!==0)throw new Error('BUILD_COMMAND_FAILED: '+(r.error?.message??r.stderr.slice(-4000)));
  return r.stdout.trim();
}
const sourceScopes=['apps','electron','shared','events','assets','package.json','package-lock.json','tsconfig.json','tsconfig.node.json',
  'vite.config.ts','electron-builder.geumcheon-ai.yml','electron-builder.geumcheon-ai-leaderboard.yml','scripts/rental-v4-package-release.ts','scripts/r7-package-release.ts','scripts/r7-write-zip.ps1'];
function sourceEvidence(projectRoot:string){
  const commit=command(projectRoot,'git',['rev-parse','HEAD']);
  assert.match(commit,/^[0-9a-f]{40}$/);
  const dirty=command(projectRoot,'git',['status','--porcelain','--untracked-files=normal','--',...sourceScopes]);
  if(dirty)throw new Error('SOURCE_NOT_FROZEN');
  const files=command(projectRoot,'git',['-c','core.quotePath=false','ls-files','--',...sourceScopes]).split(/\r?\n/).filter(Boolean).sort();
  return {sourceCommit:commit,sourceFiles:files.map(name=>({name,sha256:sha(fs.readFileSync(path.join(projectRoot,name)))}))};
}
function assertNewDirectory(output:string){
  for(let current=path.resolve(output);;current=path.dirname(current)){
    if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw new Error('OUTPUT_LINK_UNSAFE');
    if(current===path.dirname(current))break;
  }
  if(fs.existsSync(output))throw new Error('OUTPUT_EXISTS');
}
type RuntimePackage={name:string;directory:string;metadata:any;files:string[]};
function rentalRuntimePackages(projectRoot:string):RuntimePackage[]{
  const manifest=JSON.parse(fs.readFileSync(path.join(projectRoot,'package.json'),'utf8'));
  const lock=JSON.parse(fs.readFileSync(path.join(projectRoot,'package-lock.json'),'utf8'));
  assert.equal(lock.lockfileVersion,3,'RUNTIME_LOCK_VERSION');
  assert.deepEqual(manifest.dependencies??{},lock.packages['']?.dependencies??{},'RUNTIME_LOCK_DEPENDENCIES');
  const modulesRoot=fs.realpathSync(path.join(projectRoot,'node_modules'));
  const files=(directory:string):string[]=>fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const file=path.join(directory,entry.name);
    if(entry.isSymbolicLink())throw new Error('RUNTIME_SOURCE_LINK_UNSAFE');
    if(entry.isDirectory())return entry.name==='node_modules'?[]:files(file);
    if(!entry.isFile())throw new Error('RUNTIME_SOURCE_NOT_FILE');
    return [file];
  });
  const packages=Object.entries(lock.packages).flatMap(([name,metadata]:[string,any])=>{
    if(!name||metadata.dev)return [];
    if(!/^(?:node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:\/node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)*$/.test(name)||
      metadata.link||metadata.os||metadata.cpu||metadata.hasInstallScript)throw new Error('RUNTIME_LOCK_PACKAGE_UNSUPPORTED');
    const directory=path.join(modulesRoot,name.slice('node_modules/'.length));
    for(let current=directory;current!==modulesRoot;current=path.dirname(current)){
      if(current===path.dirname(current)||!fs.existsSync(current))throw new Error('RUNTIME_PACKAGE_MISSING');
      if(fs.lstatSync(current).isSymbolicLink())throw new Error('RUNTIME_SOURCE_LINK_UNSAFE');
    }
    const installed=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));
    assert.equal(installed.version,metadata.version,'RUNTIME_VERSION_MISMATCH');
    assert.deepEqual(installed.dependencies??{},metadata.dependencies??{},'RUNTIME_DEPENDENCY_MISMATCH');
    assert.deepEqual(installed.optionalDependencies??{},metadata.optionalDependencies??{},'RUNTIME_DEPENDENCY_MISMATCH');
    return [{name,directory,metadata:installed,files:files(directory)}];
  });
  const selected=new Set(packages.flatMap(p=>p.files));
  const owners=[{file:path.join(projectRoot,'package.json'),metadata:manifest},...packages.map(p=>({file:path.join(p.directory,'package.json'),metadata:p.metadata}))];
  for(const owner of owners)for(const dependency of Object.keys(owner.metadata.dependencies??{})){
    if(!selected.has(createRequire(owner.file).resolve(dependency)))throw new Error('RUNTIME_DEPENDENCY_OUTSIDE_LOCK');
  }
  return packages;
}
/** A physical, locked app tree avoids npm's missing transitive dependencies through a node_modules junction. */
export function stageRentalApplication(projectRoot:string,appRoot:string){
  assertNewDirectory(appRoot);
  const packages=rentalRuntimePackages(projectRoot);
  fs.mkdirSync(appRoot,{recursive:true});
  for(const name of ['package.json','package-lock.json','dist-electron','dist-renderer']){
    fs.cpSync(path.join(projectRoot,name),path.join(appRoot,name),{recursive:true,errorOnExist:true,force:false,
      filter:source=>{if(fs.lstatSync(source).isSymbolicLink())throw new Error('RUNTIME_SOURCE_LINK_UNSAFE');return true;}});
  }
  for(const pkg of packages)for(const source of pkg.files){
    const target=path.join(appRoot,pkg.name,path.relative(pkg.directory,source));
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
  }
}
/** Read the actual archive, then load its production modules with all host/global resolution denied. */
export function verifyRentalRuntimeArchive(projectRoot:string,archive:string){
  const packages=rentalRuntimePackages(projectRoot),asar=createRequire(import.meta.url)('@electron/asar');
  const names=asar.listPackage(archive).map((name:string)=>name.slice(1).replaceAll('\\','/'));
  for(const name of names){
    safeEntryName(name);
    if(asar.statFile(archive,path.normalize(name)).link)throw new Error('RUNTIME_ARCHIVE_LINK_UNSAFE');
  }
  for(const pkg of packages){
    const name=pkg.name+'/package.json';
    if(!names.includes(name))throw new Error('RUNTIME_PACKAGE_MISSING: '+pkg.name);
    const metadata=JSON.parse(asar.extractFile(archive,path.normalize(name)).toString('utf8'));
    assert.equal(metadata.version,pkg.metadata.version,'RUNTIME_ARCHIVE_VERSION_MISMATCH');
    assert.deepEqual(metadata.dependencies??{},pkg.metadata.dependencies??{},'RUNTIME_ARCHIVE_DEPENDENCY_MISMATCH');
  }
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'typingking-runtime-check-'));
  try{
    asar.extractAll(archive,temporary);
    const probe=[
      "const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');",
      "const root=fs.realpathSync(process.argv[1]),original=Module._resolveFilename;",
      "Module._resolveFilename=function(...args){const file=original.apply(this,args);if(!Module.isBuiltin(file)&&!fs.realpathSync(file).startsWith(root+path.sep))throw Error('RUNTIME_RESOLUTION_ESCAPED');return file;};",
      "const owners=JSON.parse(process.argv[2]);for(const owner of owners){const file=path.join(root,owner,'package.json'),meta=JSON.parse(fs.readFileSync(file,'utf8')),req=Module.createRequire(file);for(const name of Object.keys(meta.dependencies||{}))req(name);}",
    ].join('');
    const result=spawnSync(process.execPath,['--no-global-search-paths','-e',probe,temporary,JSON.stringify(['',...packages.map(p=>p.name)])],
      {cwd:temporary,encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,NODE_PATH:'',NODE_OPTIONS:''}});
    if(result.status!==0)throw new Error('RUNTIME_REQUIRE_FAILED: '+(result.error?.message??result.stderr.slice(-2000)));
    return {packages:packages.length,hostModuleResolution:'BLOCKED',isolatedRequire:'PASS'};
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
export const PROTECTION_BRIDGE_SOURCE='electron/security/TypingKingDpapiBridge.cs';
export const PROTECTION_BRIDGE_RESOURCE='security/TypingKingDpapiBridge.exe';
export type ProtectionBridgeManifest={
  source:{name:string;sha256:string};
  compiler:{path:string;sha256:string};
  artifact:ManifestEntry;
  mode:'CurrentUserDPAPI';
  probe:'PASS';
};
function protectedBridgeFile(file:string){
  if(!fs.existsSync(file))throw new Error('PROTECTION_BRIDGE_MISSING');
  for(let current=path.resolve(file);;current=path.dirname(current)){
    if(fs.lstatSync(current).isSymbolicLink())throw new Error('PROTECTION_BRIDGE_LINK');
    if(current===path.dirname(current))break;
  }
  const stat=fs.statSync(file);
  if(!stat.isFile()||!stat.size)throw new Error('PROTECTION_BRIDGE_MISSING');
  return {bytes:stat.size,sha256:sha(fs.readFileSync(file))};
}
function probeProtectionBridge(file:string):void{
  const probe=spawnSync(file,['probe'],{input:Buffer.alloc(0),encoding:'utf8',windowsHide:true,shell:false,timeout:5000,maxBuffer:65536});
  if(probe.status!==0||probe.stdout!=='TKDPAPI_OK_V1'||probe.stderr!=='')throw new Error('PROTECTION_BRIDGE_PROBE_FAILED');
}
/** Compile only with an existing Windows Framework compiler; no downloaded runtime or field installation. */
export function compileRentalProtectionBridge(projectRoot:string,supportRoot:string):ProtectionBridgeManifest{
  if(process.platform!=='win32')throw new Error('PROTECTION_BRIDGE_WINDOWS_REQUIRED');
  assertNewDirectory(supportRoot);
  const source=path.join(projectRoot,PROTECTION_BRIDGE_SOURCE);
  const sourceFile=protectedBridgeFile(source);
  const compiler=[
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ].find(file=>fs.existsSync(file));
  if(!compiler)throw new Error('PROTECTION_BRIDGE_COMPILER_MISSING');
  const compilerFile=protectedBridgeFile(compiler);
  const output=path.join(supportRoot,PROTECTION_BRIDGE_RESOURCE);
  fs.mkdirSync(path.dirname(output),{recursive:true});
  command(projectRoot,compiler,['/nologo','/optimize+','/target:exe','/platform:anycpu','/out:'+output,source]);
  const artifact={name:PROTECTION_BRIDGE_RESOURCE,...protectedBridgeFile(output)};
  probeProtectionBridge(output);
  if(protectedBridgeFile(source).sha256!==sourceFile.sha256)throw new Error('PROTECTION_BRIDGE_SOURCE_CHANGED');
  return {source:{name:PROTECTION_BRIDGE_SOURCE,sha256:sourceFile.sha256},compiler:{path:compiler,sha256:compilerFile.sha256},
    artifact,mode:'CurrentUserDPAPI',probe:'PASS'};
}
/** Fixed resource path and compiled-source/hash binding are checked before executing the harmless probe. */
export function verifyPackagedProtectionBridge(projectRoot:string,resourcesRoot:string,expected:ProtectionBridgeManifest){
  if(expected?.source?.name!==PROTECTION_BRIDGE_SOURCE||expected?.artifact?.name!==PROTECTION_BRIDGE_RESOURCE
    ||expected?.mode!=='CurrentUserDPAPI'||expected?.probe!=='PASS')throw new Error('PROTECTION_BRIDGE_MANIFEST_INVALID');
  if(protectedBridgeFile(path.join(projectRoot,PROTECTION_BRIDGE_SOURCE)).sha256!==expected.source.sha256)throw new Error('PROTECTION_BRIDGE_SOURCE_CHANGED');
  const file=path.join(resourcesRoot,PROTECTION_BRIDGE_RESOURCE),actual=protectedBridgeFile(file);
  if(actual.bytes!==expected.artifact.bytes||actual.sha256!==expected.artifact.sha256)throw new Error('PROTECTION_BRIDGE_HASH_MISMATCH');
  probeProtectionBridge(file);
  return {resourcePath:PROTECTION_BRIDGE_RESOURCE,...actual,mode:'CurrentUserDPAPI',probe:'PASS'};
}

export function buildRentalClient(projectRoot:string){
  const root=path.resolve(projectRoot),evidence=sourceEvidence(root),buildRoot=path.join(root,'release-build','rental-v4');
  assertNewDirectory(buildRoot);
  command(root,process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'build']);
  command(root,process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'-p','tsconfig.node.json']);
  const protectionBridge=compileRentalProtectionBridge(root,path.join(buildRoot,'support'));
  const appRoot=path.join(buildRoot,'application');stageRentalApplication(root,appRoot);
  for(const [index,variant] of ['ai','ai-leaderboard'].entries()){
    command(root,process.execPath,[path.join(root,'node_modules/electron-builder/cli.js'),'--config','electron-builder.geumcheon-'+variant+'.yml','--publish=never',
      '--config.extraMetadata.typingKingReleaseCandidate='+RENTAL_V4_CANDIDATE,'--config.extraMetadata.typingKingDeploymentProfileVersion=2','--config.portable.unpackDirName=true',
      '--config.directories.app='+appRoot,'--config.directories.output='+path.join('release-build','rental-v4','geumcheon',variant)]);
    if(!fs.existsSync(path.join(buildRoot,'geumcheon',variant,EXES[index]!)))throw new Error('BUILT_EXE_MISSING');
    verifyRentalRuntimeArchive(root,path.join(buildRoot,'geumcheon',variant,'win-unpacked','resources','app.asar'));
    verifyPackagedProtectionBridge(root,path.join(buildRoot,'geumcheon',variant,'win-unpacked','resources'),protectionBridge);
  }
  const after=sourceEvidence(root);
  assert.deepEqual(after,evidence,'Build source changed during generation');
  fs.writeFileSync(path.join(buildRoot,'BUILD_PROVENANCE.json'),JSON.stringify({...evidence,releaseCandidate:RENTAL_V4_CANDIDATE,
    builtAt:new Date().toISOString(),node:process.version,deploymentProfileVersion:2,protectionBridge,artifacts:buildArtifactManifest(buildRoot),productionRelease:'HOLD'},null,2)+'\n',{flag:'wx'});
  return buildRoot;
}
export async function packageRentalClient({projectRoot,deliveryRoot}:{projectRoot:string;deliveryRoot:string}){
  const root=path.resolve(projectRoot),output=path.resolve(deliveryRoot);
  if(output===root||output.startsWith(root+path.sep))throw new Error('DELIVERY_MUST_BE_OUTSIDE_SOURCE');
  assertNewDirectory(output);
  const evidence=sourceEvidence(root);
  const buildRoot=path.join(root,'release-build','rental-v4');
  const provenance=JSON.parse(fs.readFileSync(path.join(buildRoot,'BUILD_PROVENANCE.json'),'utf8'));
  assert.equal(provenance.releaseCandidate,RENTAL_V4_CANDIDATE);
  assert.equal(provenance.deploymentProfileVersion,2);
  verifyBuildArtifacts(buildRoot,provenance.artifacts);
  for(const variant of ['ai','ai-leaderboard']){
    verifyRentalRuntimeArchive(root,path.join(buildRoot,'geumcheon',variant,'win-unpacked','resources','app.asar'));
    verifyPackagedProtectionBridge(root,path.join(buildRoot,'geumcheon',variant,'win-unpacked','resources'),provenance.protectionBridge);
  }
  assert.equal(provenance.sourceCommit,evidence.sourceCommit);
  assert.deepEqual(provenance.sourceFiles,evidence.sourceFiles,'Package source differs from build source');
  const files:Entry[]=EXES.map((name,index)=>({name,source:path.join(buildRoot,'geumcheon',index?'ai-leaderboard':'ai',name)}));
  files.push(...publicResources(root).map(name=>({name,source:path.join(root,name)})));
  fs.mkdirSync(output,{recursive:true});
  const client=path.join(output,'TypingKing_Client');fs.mkdirSync(client);
  const marker=path.join(client,MARKER);
  fs.writeFileSync(marker,JSON.stringify({schemaVersion:1,kind:'typingking-geumcheon-client-release'})+'\n',{flag:'wx'});
  files.push({name:MARKER,source:marker});
  validateCommonEntries(files);
  for(const entry of files){
    for(let current=path.resolve(entry.source);;current=path.dirname(current)){
      if(fs.lstatSync(current).isSymbolicLink())throw new Error('COMMON_SOURCE_LINK_UNSAFE');
      if(current===path.dirname(current))break;
    }
    if(!fs.statSync(entry.source).isFile())throw new Error('COMMON_SOURCE_NOT_FILE');

    const target=path.join(client,entry.name);
    if(path.resolve(entry.source)===path.resolve(target))continue;
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(entry.source,target,fs.constants.COPYFILE_EXCL);
  }
  for(const [index,name] of EXES.entries()){
    const file=path.join(client,name),expected=provenance.artifacts[index];
    if(fs.statSync(file).size!==expected.bytes||sha(fs.readFileSync(file))!==expected.sha256)throw new Error('BUILD_ARTIFACT_MISMATCH');
  }
  const staged=files.map(e=>({name:e.name,source:path.join(client,e.name)}));
  const archive=path.join(output,COMMON_ZIP_NAME);
  const manifest=await writeZip(archive,staged);
  const verification=await verifyZipAgainstManifest(archive,manifest);
  const result={schemaVersion:1,releaseCandidate:RENTAL_V4_CANDIDATE,sourceCommit:evidence.sourceCommit,
    createdAt:new Date().toISOString(),productionRelease:'HOLD',actualNas:'NOT_RUN',
    secretProfilesIncluded:false,serverToolsIncluded:false,package:{name:COMMON_ZIP_NAME,
      bytes:fs.statSync(archive).size,sha256:await hashFile(archive),files:manifest,verification},buildProvenance:provenance};
  fs.writeFileSync(path.join(output,'UIV3_PACKAGE_MANIFEST.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  fs.writeFileSync(path.join(output,'MANIFEST_SHA256.txt'),manifest.map(e=>e.sha256+'  TypingKing_Client/'+e.name).join('\n')+'\n'+result.package.sha256+'  '+COMMON_ZIP_NAME+'\n',{flag:'wx'});
  return {deliveryRoot:output,archive,manifest:result};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const action=process.argv[2];
  if(action==='build'){buildRentalClient(root);process.stdout.write('CLIENT_BUILD_READY\n');}
  else if(action==='package'&&process.argv[3])packageRentalClient({projectRoot:root,deliveryRoot:process.argv[3]}).then(r=>process.stdout.write(r.archive+'\n')).catch(error=>{console.error(error);process.exitCode=1;});
  else{process.stderr.write('Use build or package <new-versioned-delivery-directory>\n');process.exitCode=1;}
}
